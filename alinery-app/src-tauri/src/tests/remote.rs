use crate::host_wire::HostOp;
use crate::remote::*;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

fn args(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
}

#[test]
fn destination_accepts_an_ssh_command_a_bare_host_or_an_alias() {
    assert_eq!(parse_destination("ssh -p 2222 me@box").unwrap(), args(&["-p", "2222", "me@box"]));
    assert_eq!(parse_destination("devbox").unwrap(), args(&["devbox"]));
    assert_eq!(
        parse_destination("  -i ~/.ssh/k -J jump@gw -l me box.example.com ").unwrap(),
        args(&["-i", "~/.ssh/k", "-J", "jump@gw", "-l", "me", "box.example.com"])
    );
    assert_eq!(
        parse_destination("ssh -p2222 -o 'IdentitiesOnly yes' me@box").unwrap(),
        args(&["-p", "2222", "-o", "IdentitiesOnly=yes", "me@box"])
    );
    assert_eq!(parse_destination("-4 \"my host\"").unwrap_err(), "invalid host: my host");
    assert_eq!(parse_destination("[fe80::1]").unwrap(), args(&["[fe80::1]"]));
}

#[test]
fn destination_refuses_anything_that_could_run_a_command_or_open_a_forward() {
    for bad in [
        "ssh box ls",
        "ssh box 'rm -rf /'",
        "-L 80:localhost:80 box",
        "-R 80:localhost:80 box",
        "-D 1080 box",
        "-N box",
        "-o ProxyCommand=nc%20x%20y box",
        "-o LocalCommand=id box",
        "-o PermitLocalCommand=yes box",
        "-oProxyCommand=id box",
        "-p notaport box",
        "-p 0 box",
        "-p 70000 box",
        "-i -oProxyCommand=id box",
        "-- box",
        "-1 box",
        "box -p 22",
        "",
        "ssh",
        "-p",
        "'unterminated",
    ] {
        assert!(parse_destination(bad).is_err(), "{bad:?} must be refused");
    }
}

#[test]
fn a_host_may_not_look_like_an_option() {
    assert!(parse_destination("-oProxyCommand=x").is_err());
    assert!(parse_destination("me@-oProxyCommand=x").is_err());
    assert!(parse_destination("me@-host").is_err());
    assert!(parse_destination("me@").is_err());
    assert!(parse_destination("--help").is_err());
}

#[test]
fn host_id_is_stable_readable_and_depends_on_every_argument() {
    let plain = host_id(&args(&["me@Dev.Box.example.com"]));
    assert!(plain.starts_with("dev-box-example-com-"), "{plain}");
    assert_eq!(plain, host_id(&args(&["me@Dev.Box.example.com"])));
    assert_ne!(plain, host_id(&args(&["-p", "2222", "me@Dev.Box.example.com"])));
    assert_eq!(plain.len(), "dev-box-example-com-".len() + 6);
    assert!(host_id(&args(&["@@@"])).starts_with("host-"));
    let long = host_id(&args(&["a-very-long-host-name-that-keeps-going.example.com"]));
    assert!(long.len() <= 24 + 1 + 6, "{long}");
}

#[test]
fn control_and_forward_sockets_are_short_and_distinct() {
    let dir = control_dir(501);
    assert_eq!(dir, Path::new("/tmp/alinery-501"));
    let id = host_id(&args(&["me@box"]));
    let control = control_socket(&dir, &id).unwrap();
    let forward = forward_socket(&dir, &id, "/home/me/a/repo/.alinery/alineryd.sock").unwrap();
    assert_ne!(control, forward);
    assert_ne!(forward, forward_socket(&dir, &id, "/home/me/b/repo/.alinery/alineryd.sock").unwrap());
    assert!(control.as_os_str().len() + 17 <= 104, "ssh's temporary bind name must still fit sun_path");
    assert!(control_socket(Path::new(&"/x".repeat(60)), &id).is_err());
}

/// The live tests share one host and count its daemons, so they take turns.
static LIVE_HOST: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn live_args() -> Option<Vec<String>> {
    let raw = std::env::var("ALINERY_TEST_SSH_ARGS").ok()?;
    Some(raw.split_whitespace().map(str::to_string).collect())
}

/// `Hello` to the daemon behind `repo` on host `id`, over its forward, with the token this app kept for it.
fn remote_hello(state: &crate::AppState, id: &str, repo: &str) -> Result<crate::daemon_rpc::HelloResponse, String> {
    let session = state.remotes.session(id).ok_or("the host is not connected")?;
    let (local, _) = rpc_forward(id, repo)?;
    crate::daemon_rpc::hello_at(&local, &crate::daemon::rpc_secret_path(&session.secrets_dir, repo, ""), std::time::Duration::from_secs(5))
}

fn live_session(args: &[String], id: &str) -> RemoteSession {
    let conn = HostConn::new(id, args).unwrap();
    conn.ensure_master(true).unwrap();
    let probe = conn.probe().unwrap();
    let bundle = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/remote");
    let manifest: RuntimeManifest = serde_json::from_str(&std::fs::read_to_string(bundle.join("manifest.json")).unwrap()).unwrap();
    let (triple, target) = select_target(&probe, &manifest).unwrap();
    let root = remote_root(&probe.home);
    let runtime = runtime_dir(&root, &target.runtime_hash);
    if !conn.runtime_installed(&runtime).unwrap() {
        conn.install_runtime(&runtime, std::fs::File::open(bundle.join(&target.archive)).unwrap()).unwrap();
    }
    let config_dir = remote_config_dir(&root, "livetest");
    let channel = HostChannel::open(&conn, &format!("{runtime}/alinery-vinculum-daemon")).unwrap();
    let launcher = choose_launcher(&probe).unwrap();
    RemoteSession {
        conn,
        channel,
        launcher,
        root,
        triple: triple.to_string(),
        runtime_hash: target.runtime_hash.clone(),
        config_dir,
        secrets_dir: std::env::temp_dir().join(format!("alinery-live-secrets-{id}")),
    }
}

/// Needs a real sshd: set ALINERY_TEST_SSH_ARGS to the stored ssh arguments (flags then host),
/// for example `-p 2222 -i key -o UserKnownHostsFile=/tmp/kh dev@127.0.0.1`, and build the
/// bundle first with scripts/build-remote-runtimes.sh. Skipped otherwise.
#[test]
fn live_host_installs_browses_runs_a_daemon_and_survives_a_disconnect() {
    let Some(args) = live_args() else {
        eprintln!("skipped: ALINERY_TEST_SSH_ARGS is not set");
        return;
    };
    let _turn = LIVE_HOST.lock().unwrap_or_else(|e| e.into_inner());
    let id = format!("live-{}", std::process::id());
    let session = live_session(&args, &id);
    let call = |op| session.channel.call(op, std::time::Duration::from_secs(30)).unwrap();

    // Browse, classify and initialize a plain directory.
    let home = session.root.trim_end_matches("/.local/share/alinery-remote").to_string();
    let listing = call(HostOp::ListDir {
        path: home.clone().into(),
        show_hidden: false,
    });
    assert!(listing["entries"].as_array().unwrap().iter().any(|entry| entry["name"] == "work"), "{listing}");
    let repo = format!("{home}/work/proj");
    // Rerunnable: start from a plain directory even if a previous run initialized it.
    session
        .conn
        .exec_ok(&format!("rm -rf '{repo}/.git' '{repo}/.alinery'"), RemoteStdin::None, std::time::Duration::from_secs(20))
        .unwrap();
    assert_eq!(call(HostOp::Classify { path: repo.clone().into() })["kind"], "absent");
    assert_eq!(call(HostOp::Init { path: repo.clone().into() })["kind"], "initialized");
    assert_eq!(call(HostOp::Classify { path: repo.clone().into() })["kind"], "checkout");

    // Claim it, write the settings, start the daemon through the forward.
    assert_eq!(call(HostOp::ClaimRepo { repo: repo.clone().into() })["claimed"], true);
    // A second claimant, on its own channel, is told the repo is busy while the first channel lives.
    let rival = HostChannel::open(&session.conn, &format!("{}/alinery-vinculum-daemon", runtime_dir(&session.root, &session.runtime_hash))).unwrap();
    assert_eq!(
        rival.call(HostOp::ClaimRepo { repo: repo.clone().into() }, std::time::Duration::from_secs(30)).unwrap()["claimed"],
        false
    );
    drop(rival);
    let local = crate::AppConfig {
        known_repos: vec![format!("alinery+ssh://{id}{repo}")],
        ..Default::default()
    };
    call(HostOp::WriteFile {
        path: format!("{}/app.toml", session.config_dir).into(),
        contents: render_remote_app_toml(&local, std::slice::from_ref(&repo), false).unwrap(),
    });
    let identity = alinery_core::app_config_identity(Path::new(&format!("{}/app.toml", session.config_dir)));
    let (hello, compat) = ensure_remote_daemon(&session, &repo, &identity).unwrap();
    assert!(compat.usable());
    assert_eq!(hello.app_config_identity, identity);
    {
        let (rpc_local, _) = rpc_forward(&session.conn.host_id, &repo).unwrap();
        let secret = crate::daemon::rpc_secret_path(&session.secrets_dir, &repo, "");
        assert!(crate::daemon_rpc::live_sessions_at(&rpc_local, &secret).unwrap().is_empty());
    }

    // The token this Mac gave the daemon travelled in a file that the daemon deletes when it starts.
    let leftover = session
        .conn
        .exec_ok(
            &format!("ls '{}/rpc-secrets' | wc -l", session.config_dir),
            RemoteStdin::None,
            std::time::Duration::from_secs(20),
        )
        .unwrap();
    assert_eq!(leftover.trim(), "0", "the daemon deletes the secret file when it starts");
    assert!(
        session
            .conn
            .exec_ok(
                &format!("test -S '{repo}/.alinery/rpc.sock' && echo yes; true"),
                RemoteStdin::None,
                std::time::Duration::from_secs(20)
            )
            .unwrap()
            .trim()
            == "yes"
    );
    assert_eq!(
        session
            .conn
            .exec_ok(
                &format!("ls '{repo}/.alinery/' | grep -c '^alineryd.*sock$'; true"),
                RemoteStdin::None,
                std::time::Duration::from_secs(20)
            )
            .unwrap()
            .trim(),
        "0",
        "the daemon serves one socket, rpc.sock"
    );

    let daemons = |session: &RemoteSession| {
        session
            .conn
            .exec_ok("pgrep -f '[a]linery-vinculum-daemon --repo' | sort", RemoteStdin::None, std::time::Duration::from_secs(20))
            .unwrap()
    };
    let before = daemons(&session);
    assert!(!before.trim().is_empty());

    // The RPC socket rides its own forward: Hello through the bridge path, with the token this Mac kept.
    let hello_now = |session: &RemoteSession| {
        let (local, _) = rpc_forward(&session.conn.host_id, &repo).unwrap();
        let secret = crate::daemon::rpc_secret_path(&session.secrets_dir, &repo, "");
        tauri::async_runtime::block_on(async {
            let token = crate::daemon_rpc::rpc_token(&local, &secret).await.unwrap();
            crate::daemon_rpc::hello(&local, &token).await.unwrap()
        })
    };
    let first_hello = hello_now(&session);
    assert_eq!(first_hello.protocol, alinery_core::PROTOCOL_VERSION);
    assert!(!first_hello.epoch.is_empty() && !first_hello.build_id.is_empty(), "{first_hello:?}");
    let (rpc_local, _) = rpc_forward(&session.conn.host_id, &repo).unwrap();
    let wrong = tauri::async_runtime::block_on(crate::daemon_rpc::hello(&rpc_local, "x".repeat(64).as_str())).unwrap_err();
    assert!(wrong.contains("grpc-status 16"), "a wrong token is UNAUTHENTICATED, not a transport failure: {wrong}");

    // Dropping the channel and the master (a disconnect) leaves the daemon alone.
    session.conn.exit_master();
    drop(session);
    let again = live_session(&args, &id);
    assert_eq!(daemons(&again), before, "the daemon must be the same process after reconnecting");
    let (_, compat) = ensure_remote_daemon(&again, &repo, &identity).unwrap();
    assert!(compat.usable());
    assert_eq!(daemons(&again), before, "reconnecting must not start a second daemon");
    assert_eq!(
        hello_now(&again).epoch,
        first_hello.epoch,
        "Hello after the reconnect reaches the same daemon, not a new one"
    );
    // The claim died with the old channel, so a new channel can take it.
    assert_eq!(
        again.channel.call(HostOp::ClaimRepo { repo: repo.into() }, std::time::Duration::from_secs(30)).unwrap()["claimed"],
        true
    );
    again.conn.exit_master();
    let _ = std::fs::remove_dir_all(&again.secrets_dir);
}

/// The same sshd, driven through the app's own commands and state: connect, list a repo,
/// activate it, disconnect (the daemon keeps running), reconnect (it is picked back up), remove.
#[test]
fn live_commands_connect_activate_disconnect_reconnect_and_remove() {
    use tauri::Manager;
    let Some(args) = live_args() else {
        eprintln!("skipped: ALINERY_TEST_SSH_ARGS is not set");
        return;
    };
    let _turn = LIVE_HOST.lock().unwrap_or_else(|e| e.into_inner());
    let _active = super::ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!("test.alinery.remote.{}", uuid::Uuid::new_v4());
    let app = tauri::test::mock_builder().manage(crate::AppState::default()).build(context).unwrap();
    let handle = app.handle().clone();
    let state = handle.state::<crate::AppState>();
    let id = format!("cmd-{}", std::process::id());

    // The destination parser refuses UserKnownHostsFile, so the test stores the host directly.
    let mut config = crate::AppConfig::default();
    config.remote_hosts.insert(
        id.clone(),
        crate::RemoteHost {
            label: "live".into(),
            ssh_args: args.clone(),
            ..Default::default()
        },
    );
    config.global.github.token = "ghp_live_mac_only".into();
    config.global.telemetry.install_id = "live-install-id".into();
    config.global.experiments.grok_api_key = "xai-live-shared".into();
    crate::write_app_config(&handle, &config).unwrap();

    connect_and_attach(&handle, &id, true).unwrap();

    // The host's settings file carries what its processes read and none of this Mac's private settings.
    {
        let session = state.remotes.session(&id).expect("connected");
        let host_toml = session
            .conn
            .exec_ok(
                &format!("cat '{dir}/app.toml'; stat -c %a '{dir}/app.toml'", dir = session.config_dir),
                RemoteStdin::None,
                std::time::Duration::from_secs(20),
            )
            .unwrap();
        assert!(!host_toml.contains("ghp_live_mac_only"), "{host_toml}");
        assert!(
            host_toml.contains("live-install-id"),
            "the telemetry preferences travel whole, so the host's events carry this install (S4.1)"
        );
        assert!(host_toml.contains("xai-live-shared"), "the shared provider key reaches the daemon");
        assert_eq!(host_toml.trim().lines().last(), Some("600"), "owner-only");
    }
    let hosts = host_views(&handle, &state);
    assert_eq!(hosts[0].state, "connected", "{hosts:?}");
    assert!(hosts[0].home.as_deref().is_some_and(|home| home.starts_with('/')));

    let home = hosts[0].home.clone().unwrap();
    let repo = format!("{home}/work/cmd-{}", std::process::id());
    let session = state.remotes.session(&id).unwrap();
    session
        .conn
        .exec_ok(
            &format!("rm -rf '{repo}' && mkdir -p '{repo}' && git init -q '{repo}'"),
            RemoteStdin::None,
            std::time::Duration::from_secs(30),
        )
        .unwrap();
    let key = add_remote_repo(&handle, &id, &repo).unwrap();
    assert_eq!(key, format!("alinery+ssh://{id}{repo}"));
    // A path that is not a checkout root is refused.
    assert!(add_remote_repo(&handle, &id, &home).is_err());

    let config = crate::set_active_repo_sync(handle.clone(), handle.state(), key.clone()).unwrap();
    assert_eq!(config.active_repo, key);
    assert!(state.daemon_attached(Path::new(&key)));
    assert!(crate::active_repo().is_err(), "un-migrated local-path commands must refuse a remote active repo");
    assert!(remote_hello(&state, &id, &repo).is_ok(), "the attached daemon answers Hello over its forward");

    // A task written on the host shows up in the same board rows a local repo would give.
    let task = alinery_core::Task {
        name: "Remote task".into(),
        slug: "remote-task".into(),
        branch: "remote-task".into(),
        created: 1_700_000_000,
        ..Default::default()
    };
    session
        .channel
        .call(
            HostOp::WriteFile {
                path: format!("{repo}/.alinery/tasks/remote-task/task.md").into(),
                contents: toml::to_string(&task).unwrap(),
            },
            std::time::Duration::from_secs(30),
        )
        .unwrap();
    // Disconnect: the app forgets the daemon handle; the daemon itself is untouched.
    disconnect_host(&handle, &id);
    assert!(!state.daemon_attached(Path::new(&key)));
    assert_eq!(host_views(&handle, &state)[0].state, "idle");
    assert!(
        crate::set_active_repo_sync(handle.clone(), handle.state(), key.clone()).is_err(),
        "a disconnected host cannot be activated"
    );

    // Reconnect re-attaches every known repo on the host to the daemon that was still running.
    connect_and_attach(&handle, &id, false).unwrap();
    assert!(state.daemon_attached(Path::new(&key)));

    let after = remove_remote_repo(&handle, &key).unwrap();
    assert!(!after.known_repos.contains(&key));
    assert!(!state.daemon_attached(Path::new(&key)));
    disconnect_host(&handle, &id);
    let _ = crate::set_active_repo_global(None);
    if let Ok(dir) = handle.path().app_config_dir() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// The ssh master dies (a network change, sleep): the app notices, reconnects on its own with the
/// same daemon still serving, and leaves a host the user disconnected alone.
#[test]
fn live_a_dropped_host_comes_back_by_itself_and_a_disconnect_stays_down() {
    use std::time::{Duration, Instant};
    use tauri::Manager;
    let Some(args) = live_args() else {
        eprintln!("skipped: ALINERY_TEST_SSH_ARGS is not set");
        return;
    };
    let _turn = LIVE_HOST.lock().unwrap_or_else(|e| e.into_inner());
    let _active = super::ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!("test.alinery.remote.{}", uuid::Uuid::new_v4());
    let app = tauri::test::mock_builder().manage(crate::AppState::default()).build(context).unwrap();
    let handle = app.handle().clone();
    let state = handle.state::<crate::AppState>();
    let id = format!("sup-{}", std::process::id());

    let mut config = crate::AppConfig::default();
    config.remote_hosts.insert(
        id.clone(),
        crate::RemoteHost {
            label: "live".into(),
            ssh_args: args.clone(),
            ..Default::default()
        },
    );
    crate::write_app_config(&handle, &config).unwrap();
    connect_and_attach(&handle, &id, true).unwrap();

    let first = state.remotes.session(&id).unwrap();
    let home = host_views(&handle, &state)[0].home.clone().unwrap();
    let repo = format!("{home}/work/sup-{}", std::process::id());
    first
        .conn
        .exec_ok(
            &format!("rm -rf '{repo}' && mkdir -p '{repo}' && git init -q '{repo}'"),
            RemoteStdin::None,
            Duration::from_secs(30),
        )
        .unwrap();
    let key = add_remote_repo(&handle, &id, &repo).unwrap();
    crate::set_active_repo_sync(handle.clone(), handle.state(), key.clone()).unwrap();
    let daemons = || {
        first
            .conn
            .exec_ok("pgrep -f '[a]linery-vinculum-daemon --repo' | sort", RemoteStdin::None, Duration::from_secs(20))
            .unwrap()
    };
    let before = daemons();
    assert!(!before.trim().is_empty());

    spawn_remote_supervisor(handle.clone());
    let wait_for = |what: &str, done: &dyn Fn() -> bool| {
        let deadline = Instant::now() + Duration::from_secs(60);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}: {:?}", state.remotes.status(&id));
            std::thread::sleep(Duration::from_millis(250));
        }
    };

    // Kill the master. Everything that rode on it goes with it; nothing on the host is touched.
    first.conn.exit_master();
    wait_for("the drop to show", &|| state.remotes.status(&id).state != "connected");
    wait_for("the host to come back", &|| {
        state.remotes.status(&id).state == "connected" && state.remotes.session(&id).is_some_and(|session| !std::sync::Arc::ptr_eq(&session, &first))
    });
    let second = state.remotes.session(&id).unwrap();
    assert!(second.channel.is_alive());
    assert_eq!(
        second
            .conn
            .exec_ok("pgrep -f '[a]linery-vinculum-daemon --repo' | sort", RemoteStdin::None, Duration::from_secs(20))
            .unwrap(),
        before,
        "the daemon is the same process after the app reconnected on its own"
    );
    assert!(state.daemon_attached(Path::new(&key)) && remote_hello(&state, &id, &repo).is_ok());

    // The user disconnects: it stays down.
    disconnect_host(&handle, &id);
    std::thread::sleep(Duration::from_secs(8));
    assert_eq!(state.remotes.status(&id).state, "idle");
    assert!(state.remotes.session(&id).is_none());

    // Clean up through a fresh connection.
    connect_and_attach(&handle, &id, false).unwrap();
    let _ = remove_remote_repo(&handle, &key);
    disconnect_host(&handle, &id);
    let _ = crate::set_active_repo_global(None);
    if let Ok(dir) = handle.path().app_config_dir() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn close_all_lets_go_of_each_host_once() {
    let known: Vec<String> = ["/Users/me/a", "alinery+ssh://box-1/srv/a", "alinery+ssh://box-1/srv/b", "alinery+ssh://gpu-2/srv/c"]
        .map(String::from)
        .into();
    assert_eq!(remote_host_ids(&known), BTreeSet::from(["box-1".to_string(), "gpu-2".to_string()]));
    assert!(remote_host_ids(&known[..1]).is_empty());
}

/// "Quit & close all repos" with a remote repo open: it succeeds, ends the ssh connection, and
/// leaves the host's daemon running.
#[test]
fn live_close_all_repos_disconnects_a_host_and_leaves_its_daemon_running() {
    use std::time::Duration;
    use tauri::Manager;
    let Some(args) = live_args() else {
        eprintln!("skipped: ALINERY_TEST_SSH_ARGS is not set");
        return;
    };
    let _turn = LIVE_HOST.lock().unwrap_or_else(|e| e.into_inner());
    let _active = super::ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!("test.alinery.remote.{}", uuid::Uuid::new_v4());
    let app = tauri::test::mock_builder().manage(crate::AppState::default()).build(context).unwrap();
    let handle = app.handle().clone();
    let state = handle.state::<crate::AppState>();
    let id = format!("quit-{}", std::process::id());

    let mut config = crate::AppConfig::default();
    config.remote_hosts.insert(
        id.clone(),
        crate::RemoteHost {
            label: "live".into(),
            ssh_args: args.clone(),
            ..Default::default()
        },
    );
    crate::write_app_config(&handle, &config).unwrap();
    connect_and_attach(&handle, &id, true).unwrap();
    let home = host_views(&handle, &state)[0].home.clone().unwrap();
    let repo = format!("{home}/work/quit-{}", std::process::id());
    let session = state.remotes.session(&id).unwrap();
    session
        .conn
        .exec_ok(
            &format!("rm -rf '{repo}' && mkdir -p '{repo}' && git init -q '{repo}'"),
            RemoteStdin::None,
            Duration::from_secs(30),
        )
        .unwrap();
    let key = add_remote_repo(&handle, &id, &repo).unwrap();
    crate::set_active_repo_sync(handle.clone(), handle.state(), key.clone()).unwrap();
    let daemons = |session: &RemoteSession| {
        session
            .conn
            .exec_ok("pgrep -f '[a]linery-vinculum-daemon --repo' | sort", RemoteStdin::None, Duration::from_secs(20))
            .unwrap()
    };
    let before = daemons(&session);
    assert!(!before.trim().is_empty());

    state.begin_quit();
    assert_eq!(crate::close_all_repos_blocking(&handle).unwrap(), 0, "no local repo, and no failure for the remote one");
    assert_eq!(state.remotes.status(&id).state, "idle");
    assert!(!state.daemon_attached(Path::new(&key)));

    state.cancel_quit();
    connect_and_attach(&handle, &id, false).unwrap();
    assert_eq!(daemons(&state.remotes.session(&id).unwrap()), before, "the host's daemon was not stopped");
    let _ = remove_remote_repo(&handle, &key);
    disconnect_host(&handle, &id);
    let _ = crate::set_active_repo_global(None);
    if let Ok(dir) = handle.path().app_config_dir() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// A daemon this app cannot use (here: started with other settings, so another identity) is reported as
/// a conflict that leaves the repo usable for reads, and a confirmed stop replaces it with a daemon this
/// app's runtime serves. The old daemon is really gone, and nothing replaced it before the stop.
#[test]
fn live_an_unusable_daemon_is_reported_and_replaced_by_a_confirmed_stop() {
    use std::time::Duration;
    use tauri::Manager;
    let Some(args) = live_args() else {
        eprintln!("skipped: ALINERY_TEST_SSH_ARGS is not set");
        return;
    };
    let _turn = LIVE_HOST.lock().unwrap_or_else(|e| e.into_inner());
    let _active = super::ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!("test.alinery.remote.{}", uuid::Uuid::new_v4());
    let app = tauri::test::mock_builder().manage(crate::AppState::default()).build(context).unwrap();
    let handle = app.handle().clone();
    let state = handle.state::<crate::AppState>();
    let id = format!("stop-{}", std::process::id());

    let mut config = crate::AppConfig::default();
    config.remote_hosts.insert(
        id.clone(),
        crate::RemoteHost {
            label: "live".into(),
            ssh_args: args.clone(),
            ..Default::default()
        },
    );
    crate::write_app_config(&handle, &config).unwrap();
    connect_and_attach(&handle, &id, true).unwrap();
    let home = host_views(&handle, &state)[0].home.clone().unwrap();
    let repo = format!("{home}/work/stop-{}", std::process::id());
    let session = state.remotes.session(&id).unwrap();
    let sh = |script: &str| session.conn.exec_ok(script, RemoteStdin::None, Duration::from_secs(30)).unwrap();
    sh(&format!("rm -rf '{repo}' && mkdir -p '{repo}' && git init -q '{repo}'"));
    let key = add_remote_repo(&handle, &id, &repo).unwrap();
    crate::set_active_repo_sync(handle.clone(), handle.state(), key.clone()).unwrap();
    // This repo's daemons only: the host runs the other live tests' daemons too.
    let daemons = || sh(&format!("pgrep -f '[a]linery-vinculum-daemon --repo {repo}' | sort"));

    // Replace the good daemon with one started under another settings file, which gives it another identity.
    assert!(state.daemon_attached(Path::new(&key)), "the app's own daemon is attached");
    crate::daemon_rpc::shutdown_daemon(
        &key,
        &crate::app_config_path(&handle).unwrap(),
        None,
        crate::daemon_rpc::ShutdownOrigin::StopRemote,
        "",
        None,
        || Err("the daemon answers alinery.v1".into()),
    )
    .unwrap();
    session.channel.call(HostOp::WaitDaemonGone { repo: repo.clone().into() }, Duration::from_secs(30)).unwrap();
    state.clear_daemon(Path::new(&key));
    assert!(daemons().trim().is_empty(), "no daemon is left to confuse the count");
    let (config_dir, runtime) = (session.config_dir.clone(), runtime_dir(&session.root, &session.runtime_hash));
    sh(&format!("cp '{config_dir}/app.toml' '{config_dir}/other.toml'"));
    // An earlier daemon of this app has the token this app kept for the repo; the replacement is given the same one.
    let token = std::fs::read_to_string(crate::daemon::rpc_secret_path(&session.secrets_dir, &repo, "")).unwrap();
    let old_rpc_file = format!("{config_dir}/rpc-secrets/old.rpc");
    session
        .channel
        .call(
            HostOp::WriteFile {
                path: old_rpc_file.clone().into(),
                contents: token,
            },
            Duration::from_secs(30),
        )
        .unwrap();
    session
        .channel
        .call(
            HostOp::SpawnDaemon {
                repo: repo.clone().into(),
                app_config: format!("{config_dir}/other.toml").into(),
                binary: format!("{runtime}/alinery-vinculum-daemon").into(),
                build_id: session.runtime_hash.clone(),
                namespace: None,
                log: format!("{config_dir}/logs/old-daemon.log").into(),
                // The test host has no systemd user manager; the daemon still detaches.
                launch: crate::host_wire::Launch::Direct,
                unit: None,
                rpc_secret_file: Some(old_rpc_file.into()),
            },
            Duration::from_secs(30),
        )
        .unwrap();
    let mut old = String::new();
    for _ in 0..50 {
        old = daemons();
        if !old.trim().is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    assert!(!old.trim().is_empty(), "the old daemon started");
    // A started process is not a listening daemon: wait for its socket, or the app would find nothing there and start its own.
    for _ in 0..100 {
        if sh(&format!("test -S '{repo}/.alinery/rpc.sock' && echo yes; true")).trim() == "yes" {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    // Opening the repo reports the conflict instead of failing, and replaces nothing.
    crate::activate_remote_repo(&handle, &state, &key).unwrap();
    assert!(!state.daemon_attached(Path::new(&key)));
    let conflict = state.daemon_conflict(Path::new(&key)).expect("the unusable daemon is recorded as a conflict");
    assert_eq!(conflict.repo, key);
    assert_eq!(conflict.owners.len(), 1);
    assert!(matches!(&conflict.owners[0].impact, crate::TakeoverImpact::Known { sessions } if sessions.is_empty()));
    assert!(conflict.issues[0].contains("other settings"), "{:?}", conflict.issues);
    assert_eq!(daemons(), old, "attaching never replaces the daemon");

    // The confirmed stop ends it, waits for its socket to go, and starts this app's daemon.
    crate::stop_remote_daemon(&handle, &id, &repo, |_, _| Ok(())).unwrap();
    assert!(state.daemon_conflict(Path::new(&key)).is_none());
    assert!(state.daemon_attached(Path::new(&key)), "the new daemon is attached");
    let after = daemons();
    assert_eq!(after.lines().count(), 1, "one daemon serves the repo: {after}");
    assert_ne!(after, old, "the old daemon is gone and a new one runs");
    let identity = alinery_core::app_config_identity(Path::new(&format!("{config_dir}/app.toml")));
    assert_eq!(remote_hello(&state, &id, &repo).unwrap().app_config_identity, identity);

    let _ = remove_remote_repo(&handle, &key);
    disconnect_host(&handle, &id);
    let _ = crate::set_active_repo_global(None);
    if let Ok(dir) = handle.path().app_config_dir() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// A restore on the host: a confirmed restore replaces its data while its daemon is down, then starts the daemon again. A bad
/// archive is refused before the daemon is touched.
#[test]
fn live_backups_are_written_and_restored_on_the_host() {
    use std::time::Duration;
    use tauri::Manager;
    let Some(args) = live_args() else {
        eprintln!("skipped: ALINERY_TEST_SSH_ARGS is not set");
        return;
    };
    let _turn = LIVE_HOST.lock().unwrap_or_else(|e| e.into_inner());
    let _active = super::ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!("test.alinery.remote.{}", uuid::Uuid::new_v4());
    let app = tauri::test::mock_builder().manage(crate::AppState::default()).build(context).unwrap();
    let handle = app.handle().clone();
    let state = handle.state::<crate::AppState>();
    let id = format!("backup-{}", std::process::id());

    let mut config = crate::AppConfig::default();
    config.remote_hosts.insert(
        id.clone(),
        crate::RemoteHost {
            label: "live".into(),
            ssh_args: args.clone(),
            ..Default::default()
        },
    );
    crate::write_app_config(&handle, &config).unwrap();
    connect_and_attach(&handle, &id, true).unwrap();
    let home = host_views(&handle, &state)[0].home.clone().unwrap();
    let (repo, dest) = (format!("{home}/work/backup-{}", std::process::id()), format!("{home}/backups-{}", std::process::id()));
    let session = state.remotes.session(&id).unwrap();
    let sh = |script: &str| session.conn.exec_ok(script, RemoteStdin::None, Duration::from_secs(30)).unwrap();
    sh(&format!("rm -rf '{repo}' '{dest}' && mkdir -p '{repo}' '{dest}' && git init -q '{repo}'"));
    let key = add_remote_repo(&handle, &id, &repo).unwrap();
    crate::set_active_repo_sync(handle.clone(), handle.state(), key.clone()).unwrap();
    let write = |relative: &str, contents: &str| {
        session
            .channel
            .call(
                HostOp::WriteFile {
                    path: format!("{repo}/{relative}").into(),
                    contents: contents.into(),
                },
                Duration::from_secs(30),
            )
            .unwrap();
    };
    // A task directory the daemon can own: it refuses to start over one without a readable task.md.
    let task = |slug: &str| {
        let task = alinery_core::Task {
            name: slug.into(),
            slug: slug.into(),
            branch: slug.into(),
            created: 1_700_000_000,
            ..Default::default()
        };
        write(&format!(".alinery/tasks/{slug}/task.md"), &toml::to_string(&task).unwrap());
    };
    task("keep");
    write(".alinery/tasks/keep/notes.txt", "before");
    write(
        ".alinery/config.toml",
        &format!("[backup]\ndestination = {dest:?}\nenabled = true\ntrigger_pre_archive = true\n"),
    );
    // This repo's daemons only: the host runs the other live tests' daemons too.
    let daemons = || sh(&format!("pgrep -f '[a]linery-vinculum-daemon --repo {repo}' | sort"));

    // The daemon makes the archive in production (`BackupService`, over the forwarded socket); this test needs a valid
    // one on the host's disk, written with the host's own `zip` the way the daemon writes it.
    let meta = format!(
        r#"{{"repo_name":"backup","repo_path":"{repo}","created_at":1700000000,"schema_version":1,"alinery_version":"live","trigger":"manual","included_dirs":["tasks"]}}"#
    );
    let archive = format!("{dest}/backup-live-v1.zip");
    sh(&format!(
        "mkdir -p '{dest}/meta' && printf '%s' '{meta}' > '{dest}/meta/backup-meta.json' && zip -q -j -X '{archive}' '{dest}/meta/backup-meta.json' && cd '{repo}/.alinery' && zip -q -X -D '{archive}' tasks/keep/task.md tasks/keep/notes.txt"
    ));
    assert!(sh(&format!("ls '{dest}'")).contains(".zip"), "the archive is on the host's disk");

    // Work after the backup, which a restore must take away.
    write(".alinery/tasks/keep/notes.txt", "after");
    task("late");
    let running = daemons();
    assert!(!running.trim().is_empty(), "the repo's daemon is up");

    // An archive that is not there is refused with the daemon untouched.
    assert!(crate::restore_remote_backup(&handle, &id, &repo, &format!("{dest}/missing.zip")).is_err());
    assert_eq!(daemons(), running, "the daemon was not stopped for an archive that cannot be restored");
    assert_eq!(sh(&format!("cat '{repo}/.alinery/tasks/keep/notes.txt'")), "after");

    crate::restore_remote_backup(&handle, &id, &repo, &archive).unwrap();
    assert_eq!(sh(&format!("cat '{repo}/.alinery/tasks/keep/notes.txt'")), "before");
    assert_eq!(sh(&format!("ls '{repo}/.alinery/tasks'")).trim(), "keep", "what came after the backup is gone");
    assert!(state.daemon_attached(Path::new(&key)), "the daemon is attached again");
    let restarted = daemons();
    assert!(
        !restarted.trim().is_empty() && restarted != running,
        "a new daemon replaced the old one: {running} -> {restarted}"
    );
    session.conn.exit_master();
    let _ = std::fs::remove_dir_all(&session.secrets_dir);
}

/// A host that stops answering must not hold up the command that asked: it hands the wait to the blocking
/// pool and returns control at once, so the window keeps painting. The host's repo service is stopped
/// (SIGSTOP), so every call to it hangs until it is resumed.
#[test]
fn live_a_stalled_host_does_not_hold_up_the_command_that_asked() {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};
    use tauri::Manager;
    /// Resumes the host's processes on every exit, including a failed assertion.
    struct Resume(std::sync::Arc<RemoteSession>);
    impl Resume {
        fn now(&self) {
            let script = "pkill -CONT -f '[a]linery-vinculum-daemon --host-service'; true";
            let _ = self.0.conn.exec_ok(script, RemoteStdin::None, std::time::Duration::from_secs(20));
        }
    }
    impl Drop for Resume {
        fn drop(&mut self) {
            self.now();
        }
    }
    let Some(args) = live_args() else {
        eprintln!("skipped: ALINERY_TEST_SSH_ARGS is not set");
        return;
    };
    let _turn = LIVE_HOST.lock().unwrap_or_else(|e| e.into_inner());
    let _active = super::ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!("test.alinery.remote.{}", uuid::Uuid::new_v4());
    let app = tauri::test::mock_builder().manage(crate::AppState::default()).build(context).unwrap();
    let handle = app.handle().clone();
    let state = handle.state::<crate::AppState>();
    let id = format!("stall-{}", std::process::id());
    let mut config = crate::AppConfig::default();
    config.remote_hosts.insert(
        id.clone(),
        crate::RemoteHost {
            label: "live".into(),
            ssh_args: args.clone(),
            ..Default::default()
        },
    );
    crate::write_app_config(&handle, &config).unwrap();
    connect_and_attach(&handle, &id, true).unwrap();

    let session = state.remotes.session(&id).expect("connected");
    let home = host_views(&handle, &state)[0].home.clone().unwrap();
    let repo = format!("{home}/work/stall-{}", std::process::id());
    let sh = |script: &str| session.conn.exec_ok(script, RemoteStdin::None, std::time::Duration::from_secs(30)).unwrap();
    sh(&format!("rm -rf '{repo}' && mkdir -p '{repo}' && git init -q '{repo}'"));
    let key = add_remote_repo(&handle, &id, &repo).unwrap();
    crate::set_active_repo_sync(handle.clone(), handle.state(), key.clone()).unwrap();

    let resume = Resume(session.clone());
    sh("pkill -STOP -f '[a]linery-vinculum-daemon --host-service'");
    // The stall is real: a call made straight from a thread is still waiting.
    let direct = {
        let handle = handle.clone();
        let (id, repo) = (id.clone(), repo.clone());
        std::thread::spawn(move || {
            let state = handle.state::<crate::AppState>();
            remote_call::<serde_json::Value>(
                &state,
                &id,
                HostOp::ListDir {
                    path: repo.into(),
                    show_hidden: true,
                },
            )
        })
    };
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert!(!direct.is_finished(), "the stopped repo service must leave a call waiting");

    // The command is an async fn: its first poll runs up to the hand-off and returns.
    let mut listing = Box::pin(crate::remote_list_dir(handle.clone(), id.clone(), repo.clone(), true));
    let started = std::time::Instant::now();
    let first = listing.as_mut().poll(&mut Context::from_waker(Waker::noop()));
    let took = started.elapsed();
    assert!(matches!(first, Poll::Pending), "the command must wait for the host off this thread");
    assert!(took < std::time::Duration::from_millis(250), "the command held its caller for {took:?}");

    // Resumed, the host answers both, and the command finishes with the host's result.
    resume.now();
    let listed = tauri::async_runtime::block_on(listing).unwrap();
    let direct = direct.join().unwrap().unwrap();
    assert_eq!(listed, direct, "the command finishes with the host's answer");
    drop(resume);
    disconnect_host(&handle, &id);
    let _ = std::fs::remove_dir_all(&session.secrets_dir);
}

#[test]
fn a_remote_repos_rpc_token_is_kept_per_host_and_repo_in_an_owner_only_file() {
    use crate::daemon::{rpc_secret_path, store_rpc_secret};
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("alinery-secrets-{}", uuid::Uuid::new_v4()));
    let app_config = dir.join("app.toml");
    let (box_dir, other_dir) = (
        remote_secrets_dir(&app_config, "box-a1b2c3").unwrap(),
        remote_secrets_dir(&app_config, "another-host").unwrap(),
    );
    let kept = |dir: &Path, repo: &str| std::fs::read_to_string(rpc_secret_path(dir, repo, "")).ok();
    assert_eq!(kept(&box_dir, "/srv/a"), None);
    store_rpc_secret(&box_dir, "/srv/a", "", "first").unwrap();
    store_rpc_secret(&box_dir, "/srv/b", "", "other").unwrap();
    store_rpc_secret(&box_dir, "/srv/a", "", "second").unwrap();
    assert_eq!(kept(&box_dir, "/srv/a").as_deref(), Some("second"), "a restarted daemon replaces its token");
    assert_eq!(kept(&box_dir, "/srv/b").as_deref(), Some("other"));
    assert_eq!(kept(&other_dir, "/srv/a"), None, "tokens do not cross hosts");
    assert_eq!(std::fs::metadata(rpc_secret_path(&box_dir, "/srv/a", "")).unwrap().permissions().mode() & 0o777, 0o600);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn ssh_failures_become_actionable_messages() {
    assert_eq!(classify_ssh_failure("Host key verification failed.\n"), SshFailure::UnknownHostKey);
    // A changed key also prints "Host key verification failed"; it must never be offered for trust.
    let changed = "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nOffending ECDSA key in /Users/me/.ssh/known_hosts:3\nHost key verification failed.\n";
    assert!(matches!(classify_ssh_failure(changed), SshFailure::Other(message) if message.contains("changed")));
    assert!(matches!(classify_ssh_failure("me@box: Permission denied (publickey)."), SshFailure::Other(message) if message.contains("ssh-agent")));
    assert!(matches!(classify_ssh_failure("ssh: Could not resolve hostname nope: nodename nor servname provided"), SshFailure::Other(message) if message.contains("resolve")));
    assert_eq!(
        classify_ssh_failure("\n ssh: connect to host box port 22: Connection refused \n\n"),
        SshFailure::Other("ssh: connect to host box port 22: Connection refused".into())
    );
    assert_eq!(classify_ssh_failure(""), SshFailure::Other("ssh failed".into()));
    assert!(SshFailure::UnknownHostKey.to_string().starts_with("host-key-unknown:"));
}

const PROBE_OK: &str = "Last login: Mon\nmotd noise\n__ALINERY_PROBE__\nuname=Linux x86_64\nhome=/home/me\nglibc=glibc 2.35\npagesize=4096\nhas_tar=1\nhas_gzip=1\nhas_sha256sum=1\nhas_git=1\nhas_zip=1\nhas_unzip=1\nhas_setsid=1\nhas_systemd-run=1\nlinger=yes\nkilluser=b false\n";

fn manifest() -> RuntimeManifest {
    let target = |hash: &str| ManifestTarget {
        archive: format!("{hash}.tar.gz"),
        sha256: "00".into(),
        runtime_hash: hash.into(),
    };
    RuntimeManifest {
        glibc_floor: "2.28".into(),
        macos_floor: "13.0".into(),
        targets: BTreeMap::from([
            ("x86_64-unknown-linux-gnu".into(), target("aaaa")),
            ("aarch64-unknown-linux-gnu".into(), target("bbbb")),
            ("x86_64-apple-darwin".into(), target("cccc")),
            ("aarch64-apple-darwin".into(), target("dddd")),
        ]),
    }
}

#[test]
fn probe_parses_output_after_shell_noise() {
    let probe = parse_probe(PROBE_OK).unwrap();
    assert_eq!((probe.os.as_str(), probe.arch.as_str(), probe.home.as_str()), ("Linux", "x86_64", "/home/me"));
    assert_eq!(probe.glibc.as_deref(), Some("2.35"));
    assert_eq!(probe.pagesize, Some(4096));
    assert!(probe.tools["systemd-run"]);
    assert_eq!((probe.linger, probe.kill_user_processes), (Some(true), Some(false)));
}

#[test]
fn probe_rejects_a_host_that_never_printed_the_sentinel() {
    assert!(parse_probe("welcome to the box\n").is_err());
    assert!(parse_probe("__ALINERY_PROBE__\nuname=Linux x86_64\n").is_err(), "no home");
}

#[test]
fn selects_the_bundle_for_the_probed_architecture() {
    let probe = parse_probe(PROBE_OK).unwrap();
    let bundled = manifest();
    let (triple, target) = select_target(&probe, &bundled).unwrap();
    assert_eq!((triple, target.runtime_hash.as_str()), ("x86_64-unknown-linux-gnu", "aaaa"));
    let arm = Probe { arch: "aarch64".into(), ..probe };
    assert_eq!(select_target(&arm, &bundled).unwrap().1.runtime_hash, "bbbb");
}

#[test]
fn a_session_is_stale_when_the_bundle_now_carries_another_runtime() {
    let triple = "x86_64-unknown-linux-gnu";
    assert!(!runtime_is_stale(&manifest(), triple, "aaaa").unwrap());
    assert!(runtime_is_stale(&manifest(), triple, "old").unwrap());
    let empty = RuntimeManifest {
        glibc_floor: String::new(),
        macos_floor: String::new(),
        targets: BTreeMap::new(),
    };
    assert!(runtime_is_stale(&empty, triple, "aaaa").is_err(), "no bundled runtime for the host cannot be refreshed");
}

#[test]
fn the_runtime_panel_names_each_daemon_state_without_asking_the_daemon() {
    use crate::{state::RepoDaemon, DaemonCompat};
    let row = |daemon| repo_runtime("/r", daemon, None).state;
    assert_eq!(row(Some(RepoDaemon::Connected { compat: DaemonCompat::Current })), "current");
    assert_eq!(row(Some(RepoDaemon::Connected { compat: DaemonCompat::BuildDrift })), "build_drift");
    assert_eq!(
        row(Some(RepoDaemon::Connected {
            compat: DaemonCompat::AppConfigMismatch
        })),
        "joined"
    );
    assert_eq!(row(None), "not_attached");
}

#[test]
fn a_repo_row_names_its_host_and_daemon_version_and_traffic_is_counted_per_host() {
    use crate::daemon_rpc::{count_traffic, link_traffic};
    let origin = crate::state::DaemonOrigin {
        version: "0.600.0".into(),
        started_by: "jon on Strix".into(),
        os_user: "dev".into(),
    };
    let remote = repo_runtime("alinery+ssh://box-1/srv/r", None, Some(origin));
    assert_eq!((remote.host.as_str(), remote.version.as_deref()), ("box-1", Some("0.600.0")));
    assert_eq!((remote.started_by.as_str(), remote.os_user.as_str(), remote.mine), ("jon on Strix", "dev", false));
    assert_eq!(repo_runtime("/r", None, None).host, "local");
    let before = link_traffic("box-count-test");
    count_traffic("box-count-test", |t| {
        t.calls += 1;
        t.bytes_up += 10;
    });
    count_traffic("box-count-test", |t| t.bytes_down += 7);
    let after = link_traffic("box-count-test");
    assert_eq!(
        (after.calls - before.calls, after.bytes_up - before.bytes_up, after.bytes_down - before.bytes_down),
        (1, 10, 7)
    );
}

#[test]
fn refuses_hosts_the_runtime_cannot_run_on() {
    let ok = parse_probe(PROBE_OK).unwrap();
    let cases: Vec<(Probe, &str)> = vec![
        (
            Probe {
                os: "FreeBSD".into(),
                ..ok.clone()
            },
            "FreeBSD hosts are not supported",
        ),
        (
            Probe {
                arch: "riscv64".into(),
                ..ok.clone()
            },
            "riscv64",
        ),
        (Probe { glibc: None, ..ok.clone() }, "musl"),
        (
            Probe {
                glibc: Some("2.17".into()),
                ..ok.clone()
            },
            "older than",
        ),
        (
            Probe {
                glibc: Some("2.9".into()),
                ..ok.clone()
            },
            "older than",
        ),
        (
            Probe {
                arch: "aarch64".into(),
                pagesize: Some(65536),
                ..ok.clone()
            },
            "64 KiB",
        ),
        (
            Probe {
                tools: BTreeMap::from([("tar".into(), true)]),
                ..ok.clone()
            },
            "missing gzip",
        ),
        // The daemon's backups run the host's `zip` and `unzip` (O11 b); a Debian image has neither by default.
        (
            Probe {
                tools: BTreeMap::from([("tar".into(), true), ("gzip".into(), true), ("sha256sum".into(), true), ("git".into(), true)]),
                ..ok.clone()
            },
            "missing zip, unzip",
        ),
    ];
    for (probe, expected) in cases {
        let error = select_target(&probe, &manifest()).unwrap_err().message;
        assert!(error.contains(expected), "{error}");
    }
    let empty = RuntimeManifest {
        targets: BTreeMap::new(),
        ..manifest()
    };
    assert!(select_target(&ok, &empty).unwrap_err().message.contains("does not bundle"));
    // 2.10 must compare as newer than 2.9, not as a string.
    assert!(select_target(
        &Probe { glibc: Some("2.10".into()), ..ok },
        &RuntimeManifest {
            glibc_floor: "2.9".into(),
            ..manifest()
        }
    )
    .is_ok());
}

#[test]
fn a_host_with_no_git_and_no_tar_is_refused_naming_both_before_anything_is_installed() {
    let canned = PROBE_OK.replace("has_tar=1", "has_tar=0").replace("has_git=1", "has_git=0");
    let probe = parse_probe(&canned).unwrap();
    assert_eq!((probe.tools["git"], probe.tools["tar"]), (false, false));
    let error = select_target(&probe, &manifest()).unwrap_err();
    assert_eq!(
        (error.kind, error.missing_tools.as_slice()),
        (RefusalKind::MissingTools, ["tar".to_string(), "git".to_string()].as_slice())
    );
    assert_eq!(
        error.message,
        "the host is missing tar, git; install them on that host with its package manager, then run setup again"
    );
    // One tool reads in the singular.
    let one = parse_probe(&PROBE_OK.replace("has_git=1", "has_git=0")).unwrap();
    assert_eq!(
        select_target(&one, &manifest()).unwrap_err().message,
        "the host is missing git; install it on that host with its package manager, then run setup again"
    );
}

/// Needs the throwaway sshd of `scripts/tests/remote-sshd/run.sh` and Docker: the container's git is moved aside for the
/// probe, so the host is refused as missing exactly that tool, and put back afterwards. Skipped without either.
#[test]
fn live_test_destination_refuses_a_host_missing_git_and_accepts_it_again() {
    let Some(args) = live_args() else { return };
    let _turn = LIVE_HOST.lock().unwrap_or_else(|e| e.into_inner());
    let rename = |from: &str, to: &str| {
        std::process::Command::new("docker")
            .args(["exec", "alinery-test-sshd", "mv", from, to])
            .status()
            .is_ok_and(|status| status.success())
    };
    if !rename("/usr/bin/git", "/usr/bin/git.off") {
        eprintln!("skipped: no running container named alinery-test-sshd");
        return;
    }
    struct PutBack;
    impl Drop for PutBack {
        fn drop(&mut self) {
            let _ = std::process::Command::new("docker")
                .args(["exec", "alinery-test-sshd", "mv", "/usr/bin/git.off", "/usr/bin/git"])
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
    let _put_back = PutBack;
    let bundle = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/remote");
    let manifest: RuntimeManifest = serde_json::from_str(&std::fs::read_to_string(bundle.join("manifest.json")).unwrap()).unwrap();

    let error = test_ssh_args(&args, &manifest, true).unwrap_err();
    let refusal: serde_json::Value = serde_json::from_str(error.strip_prefix("host-refused: ").unwrap_or_else(|| panic!("not a refusal: {error}"))).unwrap();
    assert_eq!(refusal["kind"], "missing_tools");
    assert_eq!(refusal["missing_tools"], serde_json::json!(["git"]));

    assert!(rename("/usr/bin/git.off", "/usr/bin/git"));
    let report = test_ssh_args(&args, &manifest, true).unwrap();
    assert!(report.platform.starts_with("Linux"), "{}", report.platform);
}

#[test]
fn every_refusal_carries_its_kind_and_reaches_the_page_as_json() {
    let ok = parse_probe(PROBE_OK).unwrap();
    let kind = |probe: Probe| select_target(&probe, &manifest()).unwrap_err().kind;
    assert_eq!(
        kind(Probe {
            os: "FreeBSD".into(),
            ..ok.clone()
        }),
        RefusalKind::UnsupportedOs
    );
    assert_eq!(
        kind(Probe {
            arch: "riscv64".into(),
            ..ok.clone()
        }),
        RefusalKind::UnsupportedCpu
    );
    assert_eq!(kind(Probe { glibc: None, ..ok.clone() }), RefusalKind::NoGlibc);
    assert_eq!(
        kind(Probe {
            glibc: Some("2.17".into()),
            ..ok.clone()
        }),
        RefusalKind::OldGlibc
    );
    assert_eq!(
        kind(Probe {
            arch: "aarch64".into(),
            pagesize: Some(65536),
            ..ok.clone()
        }),
        RefusalKind::LargePages
    );
    let empty = RuntimeManifest {
        targets: BTreeMap::new(),
        ..manifest()
    };
    assert_eq!(select_target(&ok, &empty).unwrap_err().kind, RefusalKind::NoRuntime);

    // The probe reads the login, so the fix names it.
    let killing = parse_probe(
        &format!("{PROBE_OK}user=ada\n")
            .replace("linger=yes", "linger=no")
            .replace("killuser=b false", "killuser=b true"),
    )
    .unwrap();
    assert_eq!(killing.user.as_deref(), Some("ada"));
    let refusal = choose_launcher(&killing).unwrap_err();
    assert_eq!((refusal.kind, refusal.fix.as_deref()), (RefusalKind::StopsProcesses, Some("loginctl enable-linger ada")));
    let anonymous = Probe { user: None, ..killing };
    assert_eq!(choose_launcher(&anonymous).unwrap_err().fix.as_deref(), Some("loginctl enable-linger $(id -un)"));

    // What a failed connect hands the page: the marker, then the refusal as JSON with the tool list.
    let missing = select_target(
        &parse_probe(&PROBE_OK.replace("has_git=1", "has_git=0").replace("has_zip=1", "has_zip=0")).unwrap(),
        &manifest(),
    )
    .unwrap_err();
    let text: String = missing.into();
    let json: serde_json::Value = serde_json::from_str(text.strip_prefix("host-refused: ").unwrap()).unwrap();
    assert_eq!(json["kind"], "missing_tools");
    assert_eq!(json["missing_tools"], serde_json::json!(["git", "zip"]));
    assert!(json["fix"].is_null());
}

/// A Mac over ssh: no glibc, systemd or logind; `shasum` but no `sha256sum`; Homebrew's git from the login PATH.
const PROBE_MAC: &str = "__ALINERY_PROBE__\nuname=Darwin arm64\nhome=/Users/me\nuser=me\nglibc=\npagesize=16384\nmacos=15.1\ngit=/opt/homebrew/bin/git\nclt=0\nhas_tar=1\nhas_gzip=1\nhas_sha256sum=0\nhas_shasum=1\nhas_git=1\nhas_zip=1\nhas_unzip=1\nhas_setsid=0\nhas_systemd-run=0\nlinger=\nkilluser=\n";

#[test]
fn a_mac_host_gets_the_darwin_runtime_for_its_cpu_and_a_detached_daemon() {
    let mac = parse_probe(PROBE_MAC).unwrap();
    assert_eq!(
        (mac.os.as_str(), mac.macos.as_deref(), mac.git_path.as_deref(), mac.clt),
        ("Darwin", Some("15.1"), Some("/opt/homebrew/bin/git"), Some(false))
    );
    assert_eq!((mac.glibc.as_deref(), mac.linger, mac.kill_user_processes), (None, None, None));
    // 16 KiB pages are normal on Apple silicon and are not the 64 KiB Linux refusal.
    let bundled = manifest();
    let (triple, target) = select_target(&mac, &bundled).unwrap();
    assert_eq!((triple, target.runtime_hash.as_str()), ("aarch64-apple-darwin", "dddd"));
    let intel = Probe {
        arch: "x86_64".into(),
        ..mac.clone()
    };
    assert_eq!(select_target(&intel, &manifest()).unwrap().0, "x86_64-apple-darwin");
    assert_eq!(platform_label(&mac), "macOS 15.1 arm64");
    assert_eq!(platform_label(&parse_probe(PROBE_OK).unwrap()), "Linux x86_64");
    assert_eq!(choose_launcher(&mac), Ok(Launcher::Nohup));
}

#[test]
fn a_mac_host_is_refused_for_an_old_release_the_git_stub_or_no_checksum_tool() {
    let mac = parse_probe(PROBE_MAC).unwrap();
    let refuse = |probe: Probe| select_target(&probe, &manifest()).unwrap_err();

    let old = refuse(Probe {
        macos: Some("12.7.6".into()),
        ..mac.clone()
    });
    assert_eq!(
        (old.kind, old.message.as_str()),
        (RefusalKind::OldMacos, "the host's macOS 12.7.6 is older than the required 13.0")
    );
    assert_eq!(refuse(Probe { macos: None, ..mac.clone() }).kind, RefusalKind::OldMacos);
    // 13.10 is newer than 13.9 by number, not by string.
    assert!(select_target(
        &Probe {
            macos: Some("13.10".into()),
            ..mac.clone()
        },
        &RuntimeManifest {
            macos_floor: "13.9".into(),
            ..manifest()
        }
    )
    .is_ok());

    // /usr/bin/git without the Command Line Tools only offers to install them, so it counts as missing, with the fix.
    let stub = refuse(Probe {
        git_path: Some("/usr/bin/git".into()),
        ..mac.clone()
    });
    assert_eq!(
        (stub.kind, stub.missing_tools.as_slice(), stub.fix.as_deref()),
        (RefusalKind::MissingTools, ["git".to_string()].as_slice(), Some("xcode-select --install"))
    );
    assert!(stub.message.contains("xcode-select --install"), "{}", stub.message);
    assert!(select_target(
        &Probe {
            git_path: Some("/usr/bin/git".into()),
            clt: Some(true),
            ..mac.clone()
        },
        &manifest()
    )
    .is_ok());

    let mut tools = mac.tools.clone();
    tools.insert("shasum".into(), false);
    let no_sum = refuse(Probe { tools, ..mac.clone() });
    assert_eq!((no_sum.missing_tools.as_slice(), no_sum.fix.as_deref()), (["shasum".to_string()].as_slice(), None));

    // A Linux host is never judged by the Mac's git rule.
    let linux = Probe {
        git_path: Some("/usr/bin/git".into()),
        clt: Some(false),
        ..parse_probe(PROBE_OK).unwrap()
    };
    assert!(select_target(&linux, &manifest()).is_ok());
}

#[test]
fn launcher_only_uses_systemd_run_when_lingering_and_refuses_session_killing_hosts() {
    let ok = parse_probe(PROBE_OK).unwrap();
    assert_eq!(choose_launcher(&ok), Ok(Launcher::SystemdRun));
    let no_linger = Probe {
        linger: Some(false),
        ..ok.clone()
    };
    assert_eq!(choose_launcher(&no_linger), Ok(Launcher::Setsid));
    let killing = Probe {
        linger: Some(false),
        kill_user_processes: Some(true),
        ..ok.clone()
    };
    assert!(choose_launcher(&killing).unwrap_err().message.contains("enable-linger"));
    // Lingering rescues a host that would otherwise kill user processes.
    assert_eq!(
        choose_launcher(&Probe {
            kill_user_processes: Some(true),
            ..ok.clone()
        }),
        Ok(Launcher::SystemdRun)
    );
    let bare = Probe {
        linger: None,
        kill_user_processes: None,
        tools: BTreeMap::new(),
        ..ok
    };
    assert_eq!(choose_launcher(&bare), Ok(Launcher::Nohup));
}

#[test]
fn remote_layout_keys_runtime_by_hash_and_config_by_local_identity() {
    let root = remote_root("/home/me/");
    assert_eq!(root, "/home/me/.local/share/alinery-remote");
    assert_eq!(runtime_dir(&root, "c4dd"), "/home/me/.local/share/alinery-remote/runtime/c4dd");
    assert_eq!(remote_config_dir(&root, "ff00"), "/home/me/.local/share/alinery-remote/config/ff00");
}

#[test]
fn remote_app_toml_drops_hosts_and_other_machines_repos() {
    let mut local = crate::AppConfig {
        active_repo: "/Users/me/local".into(),
        known_repos: vec!["/Users/me/local".into(), "alinery+ssh://box-a1b2c3/srv/r".into()],
        ..Default::default()
    };
    local.remote_hosts.insert("box-a1b2c3".into(), crate::RemoteHost::default());
    let rendered = render_remote_app_toml(&local, &["/srv/r".to_string()], false).unwrap();
    let parsed: crate::AppConfig = toml::from_str(&rendered).unwrap();
    assert!(parsed.remote_hosts.is_empty());
    assert_eq!(parsed.known_repos, ["/srv/r"]);
    assert_eq!(parsed.active_repo, "");
    assert!(!rendered.contains("alinery+ssh"));
}

/// The host's settings file is an allowlist: what its processes read, and nothing this Mac keeps
/// private. Everything below is set on the Mac and must not reach the host.
#[test]
fn remote_app_toml_carries_only_what_the_host_reads() {
    let mut local = crate::AppConfig {
        settings_version: 7,
        ..Default::default()
    };
    local.global.defaults.model = "alinery/some-model".into();
    local.global.defaults.thinking = "high".into();
    local.global.experiments.grok_api_key = "xai-shared-key".into();
    local.global.github.token = "ghp_mac_only_token".into();
    local.global.telemetry = alinery_core::TelemetryPrefs {
        enabled: true,
        prompted: true,
        install_id: "install-id-mac".into(),
        endpoint: "https://telemetry.example/ingest".into(),
    };
    local.global.backup.destination = "/Users/me/Backups".into();
    local.global.harnesses.harness = vec![alinery_core::Harness {
        key: "custom".into(),
        binary: "/Users/me/bin/custom".into(),
        env: [("CUSTOM_API_KEY".to_string(), "harness-secret".to_string())].into(),
        ..Default::default()
    }];
    local.global.power.keep_awake = true;
    local.global.model_favorites.insert("omp".into(), vec!["alinery/favorite".into()]);

    let rendered = render_remote_app_toml(&local, &["/srv/r".to_string()], true).unwrap();
    assert!(
        !render_remote_app_toml(&local, &["/srv/r".to_string()], false).unwrap().contains("xai-shared-key"),
        "the Grok key goes only when the user chose to share it"
    );
    for private in ["ghp_mac_only_token", "/Users/me", "harness-secret", "CUSTOM_API_KEY", "alinery/favorite"] {
        assert!(!rendered.contains(private), "{private} reached the host's app.toml:\n{rendered}");
    }

    // What the host does read is there, as the host's own loader sees it.
    let dir = std::env::temp_dir().join(format!("alinery-remote-toml-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("app.toml");
    std::fs::write(&path, &rendered).unwrap();
    let host = alinery_core::load_global_settings(&path);
    assert_eq!(host.defaults.model, "alinery/some-model");
    assert_eq!(host.defaults.thinking, "high");
    assert_eq!(host.experiments.grok_api_key, "xai-shared-key");
    assert!(host.github.token.is_empty());
    assert_eq!(host.telemetry, local.global.telemetry, "the host's daemon sends under this install and this consent");
    assert!(!host.power.keep_awake);
    assert!(!host.harnesses.harness.iter().any(|row| row.key == "custom"), "harness rows name this Mac's paths");
    assert_eq!(toml::from_str::<crate::AppConfig>(&rendered).unwrap().settings_version, 7);
    let _ = std::fs::remove_dir_all(dir);
}

/// The host's daemon sends under this Mac's consent, so a Mac that declined, or was never asked, tells the host to send nothing.
#[test]
fn remote_app_toml_carries_a_refusal_of_telemetry_as_a_refusal() {
    for (enabled, prompted) in [(false, true), (true, false)] {
        let mut local = crate::AppConfig::default();
        local.global.telemetry = alinery_core::TelemetryPrefs {
            enabled,
            prompted,
            install_id: "install-id-mac".into(),
            endpoint: "https://telemetry.example/ingest".into(),
        };
        let rendered = render_remote_app_toml(&local, &[], false).unwrap();
        let host = toml::from_str::<crate::AppConfig>(&rendered).unwrap().global.telemetry;
        assert_eq!((host.enabled, host.prompted), (enabled, prompted), "{rendered}");
        assert!(!(host.enabled && host.prompted), "{rendered}");
    }
}

/// A Mac config directory with API keys, a browser sign-in, custom providers and a hosted token.
fn credential_fixture(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("alinery-share-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("provider-credentials.json"),
        serde_json::json!({
            "anthropic": {"type": "api_key", "key": "sk-ant-mac"},
            "openai": {"type": "api_key", "key": "sk-oai-mac"},
            "codex": {"type": "oauth", "refresh": "mac-refresh", "expires": 5}
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(dir.join("custom-providers.json"), r#"{"endpoints":[]}"#).unwrap();
    let catalog = alinery_core::HostedCatalog {
        provider: "alinery".into(),
        default_model: "alinery/m".into(),
        base_url: "https://inference.example/v1".into(),
        plans_url: "https://plans.example".into(),
        models: vec![alinery_core::HostedModel {
            id: "m".into(),
            name: "M".into(),
            context_window: 1000,
            max_tokens: 100,
            price: Some(1),
            thinking: None,
            input: None,
        }],
    };
    alinery_core::write_inference_file(&dir.join("inference.json"), "inf_mac", 4_000_000_000, "session", 1, &catalog).unwrap();
    let app_config = dir.join("app.toml");
    (dir, app_config)
}

fn host_with(sharing: Option<crate::RemoteSharing>) -> crate::AppConfig {
    let mut config = crate::AppConfig::default();
    config.global.experiments.grok_api_key = "xai-mac".into();
    config.remote_hosts.insert("box-a1b2c3".into(), crate::RemoteHost { sharing, ..Default::default() });
    config
}

#[test]
fn a_new_host_proposes_hosted_models_only_and_lists_what_the_mac_could_give() {
    let (dir, app_config) = credential_fixture("view");
    let view = sharing_view(&host_with(Some(crate::RemoteSharing::default())), "box-a1b2c3", &app_config).unwrap();
    assert!(!view.reviewed);
    assert_eq!(view.shared, ["hosted-models"], "no API key is ticked for the user");
    assert_eq!(view.keys, ["anthropic", "openai"]);
    assert_eq!(view.sign_ins, ["codex"], "sign-ins are listed so the step can say they are not copied");
    assert!(view.custom_providers && view.grok && view.hosted);
    assert_eq!(view.hosted_expires_at, Some(4_000_000_000));

    std::fs::remove_file(dir.join("inference.json")).unwrap();
    let view = sharing_view(&host_with(Some(crate::RemoteSharing::default())), "box-a1b2c3", &app_config).unwrap();
    assert!(!view.hosted && view.shared.is_empty(), "without a token there is nothing to propose");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_host_from_before_the_choice_keeps_its_keys_and_loses_only_sign_ins() {
    let (dir, app_config) = credential_fixture("inherit");
    let inherited = inherited_sharing(&dir.join("provider-credentials.json")).unwrap();
    assert!(inherited.reviewed);
    for item in ["hosted-models", "custom-providers", "grok", "key:anthropic", "key:openai"] {
        assert!(inherited.shared.iter().any(|shared| shared == item), "{item} was already on such a host");
    }
    assert!(!inherited.shared.iter().any(|shared| shared.contains("codex")), "a sign-in is never inherited");
    let view = sharing_view(&host_with(None), "box-a1b2c3", &app_config).unwrap();
    assert!(view.reviewed, "an existing host is not asked to start over");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn only_known_items_can_be_shared() {
    for ok in ["hosted-models", "custom-providers", "grok", "key:anthropic"] {
        assert!(valid_share_item(ok), "{ok}");
    }
    for bad in ["", "key:", "key:a\nb", "oauth:codex", "everything"] {
        assert!(!valid_share_item(bad), "{bad:?}");
    }
}

/// The real thing on the Docker sshd: a host set up under the old scheme loses its copied
/// sign-in once, a sign-in the host makes afterwards is never touched, and taking an item off the
/// list removes exactly what this app put there.
#[test]
fn live_credentials_follow_the_choice_and_a_host_sign_in_survives() {
    let Some(args) = live_args() else {
        eprintln!("skipped: ALINERY_TEST_SSH_ARGS is not set");
        return;
    };
    let _turn = LIVE_HOST.lock().unwrap_or_else(|e| e.into_inner());
    let id = format!("cred-{}", std::process::id());
    let session = live_session(&args, &id);
    let (dir, app_config) = credential_fixture("live");
    let store = format!("{}/provider-credentials.json", session.config_dir);
    let host_file = |name: &str| {
        session
            .conn
            .exec_ok(
                &format!("cat '{}/{name}' 2>/dev/null || echo MISSING", session.config_dir),
                RemoteStdin::None,
                std::time::Duration::from_secs(20),
            )
            .unwrap()
    };
    let host_store = || serde_json::from_str::<serde_json::Value>(&host_file("provider-credentials.json")).unwrap();
    let write_host_store = |value: serde_json::Value| {
        session
            .channel
            .call(
                HostOp::WriteFile {
                    path: store.clone().into(),
                    contents: value.to_string(),
                },
                std::time::Duration::from_secs(30),
            )
            .unwrap();
    };
    let sync = |config: &crate::AppConfig| sync_config(&session.channel, config, "box-a1b2c3", &session.config_dir, &app_config).unwrap();

    // An older connect copied the Mac's sign-in; a key this app never placed is the host's own.
    write_host_store(serde_json::json!({
        "codex": {"type": "oauth", "refresh": "copied"},
        "host-key": {"type": "api_key", "key": "host"}
    }));
    let sharing = sync(&host_with(None));
    assert_eq!(sharing.erased_sign_ins, ["codex"]);
    let on_host = host_store();
    assert!(on_host.get("codex").is_none(), "the copied sign-in is gone: {on_host}");
    assert_eq!(on_host["anthropic"]["key"], "sk-ant-mac");
    assert_eq!(on_host["openai"]["key"], "sk-oai-mac");
    assert_eq!(on_host["host-key"]["key"], "host", "something the host made for itself stays");
    assert!(host_file("inference.json").contains("inf_mac") && host_file("custom-providers.json").contains("endpoints"));
    assert!(host_file("app.toml").contains("xai-mac"));

    // The host signs in for itself. Then the user takes Anthropic, hosted models, custom providers
    // and the Grok key off the list, keeping OpenAI.
    let mut on_host = host_store();
    on_host["host-signin"] = serde_json::json!({"type": "oauth", "refresh": "host-refresh"});
    write_host_store(on_host);
    let mut chosen = sharing.clone();
    chosen.erased_sign_ins.clear();
    chosen.shared = vec!["key:openai".into()];
    let sharing = sync(&host_with(Some(chosen)));
    let on_host = host_store();
    assert!(on_host.get("anthropic").is_none(), "an unticked key is removed: {on_host}");
    assert_eq!(on_host["openai"]["key"], "sk-oai-mac");
    assert_eq!(on_host["host-signin"]["refresh"], "host-refresh", "the host's own sign-in is never touched");
    assert_eq!(on_host["host-key"]["key"], "host");
    assert_eq!(host_file("inference.json").trim(), "MISSING");
    assert_eq!(host_file("custom-providers.json").trim(), "MISSING");
    assert!(!host_file("app.toml").contains("xai-mac"), "the Grok key left with the choice");

    // A key the Mac rotates is copied again; a provider the Mac logs out of leaves the host too.
    std::fs::write(
        dir.join("provider-credentials.json"),
        r#"{"openai":{"type":"api_key","key":"sk-oai-rotated"},"codex":{"type":"oauth","refresh":"mac-refresh"}}"#,
    )
    .unwrap();
    let sharing = sync(&host_with(Some(sharing)));
    assert_eq!(host_store()["openai"]["key"], "sk-oai-rotated");
    std::fs::write(dir.join("provider-credentials.json"), "{}").unwrap();
    sync(&host_with(Some(sharing)));
    let on_host = host_store();
    assert!(on_host.get("openai").is_none(), "{on_host}");
    assert_eq!(on_host["host-signin"]["refresh"], "host-refresh");

    // A host nobody has reviewed yet gets settings but no credentials at all.
    write_host_store(serde_json::json!({}));
    let fresh = sync(&host_with(Some(crate::RemoteSharing::default())));
    assert!(!fresh.reviewed);
    assert_eq!(host_store(), serde_json::json!({}));

    session.conn.exit_master();
    let _ = std::fs::remove_dir_all(dir);
    let _ = std::fs::remove_dir_all(&session.secrets_dir);
}

#[test]
fn ssh_config_aliases_are_the_pickable_host_names_only() {
    let text = "\
# my hosts
Host dagent
    HostName dagent.example.com
    IdentityFile ~/.ssh/secret
Host work_box gpu-box *.internal !blocked
Host=eq-host # trailing comment
Host *
Match host db exec \"true\"
    User x
Host \"quoted one\" ok-two
Include extra.conf
";
    let includes = |pattern: &str| {
        assert_eq!(pattern, "extra.conf");
        vec!["Host from-include\n".to_string()]
    };
    let mut found = BTreeSet::new();
    collect_aliases(text, &includes, 0, &mut found);
    assert_eq!(
        found.into_iter().collect::<Vec<_>>(),
        ["dagent", "eq-host", "from-include", "gpu-box", "ok-two", "work_box"]
    );

    // An include loop stops at the depth limit instead of running forever.
    let looping = |_: &str| vec!["Include again\nHost deep\n".to_string()];
    let mut found = BTreeSet::new();
    collect_aliases("Include again\n", &looping, 0, &mut found);
    assert!(found.contains("deep"));
}

#[test]
fn include_patterns_resolve_against_the_ssh_dir_with_a_trailing_wildcard() {
    let home = std::env::temp_dir().join(format!("alinery-ssh-home-{}", uuid::Uuid::new_v4()));
    let ssh = home.join(".ssh");
    std::fs::create_dir_all(ssh.join("conf.d")).unwrap();
    std::fs::write(ssh.join("conf.d/b.conf"), "Host b-host\n").unwrap();
    std::fs::write(ssh.join("conf.d/a.conf"), "Host a-host\n").unwrap();
    std::fs::write(ssh.join("conf.d/notes.txt"), "Host skipped\n").unwrap();
    std::fs::write(ssh.join("extra"), "Host extra-host\n").unwrap();
    assert_eq!(include_bodies("conf.d/*.conf", &ssh, &home), ["Host a-host\n", "Host b-host\n"]);
    assert_eq!(include_bodies("~/.ssh/extra", &ssh, &home), ["Host extra-host\n"]);
    assert_eq!(include_bodies(&ssh.join("extra").display().to_string(), &ssh, &home), ["Host extra-host\n"]);
    assert!(include_bodies("missing/*", &ssh, &home).is_empty());
    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn ssh_g_output_becomes_a_target() {
    let target = parse_ssh_g("host dagent\nuser me\nhostname dagent.example.com\nport 2222\nproxyjump me@gw\nidentityfile ~/.ssh/id\n").unwrap();
    assert_eq!(
        target,
        SshTarget {
            hostname: "dagent.example.com".into(),
            user: Some("me".into()),
            port: 2222,
            jump: Some("me@gw".into()),
        }
    );
    let plain = parse_ssh_g("hostname box\nport 22\nproxyjump none\n").unwrap();
    assert_eq!((plain.user, plain.jump), (None, None));
    assert!(parse_ssh_g("user me\n").is_none());
}

#[test]
fn underscores_are_fine_in_user_names_and_aliases() {
    assert_eq!(parse_destination("svc_deploy@work_box").unwrap(), args(&["svc_deploy@work_box"]));
    assert_eq!(parse_destination("ssh -l ci_user work_box").unwrap(), args(&["-l", "ci_user", "work_box"]));
    assert!(parse_destination("-bad_host").is_err());
}

/// A failed first setup leaves nothing behind; a host that has connected or has repos stays.
#[test]
fn only_a_host_that_never_connected_is_discarded() {
    use tauri::Manager;
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!("test.alinery.discard.{}", uuid::Uuid::new_v4());
    let app = tauri::test::mock_builder().manage(crate::AppState::default()).build(context).unwrap();
    let handle = app.handle().clone();
    let mut config = crate::AppConfig::default();
    for id in ["fresh", "connected", "with-repo"] {
        config.remote_hosts.insert(id.into(), crate::RemoteHost::default());
    }
    config.remote_hosts.get_mut("connected").unwrap().home = Some("/home/me".into());
    config.known_repos.push("alinery+ssh://with-repo/srv/r".into());
    crate::write_app_config(&handle, &config).unwrap();

    for id in ["fresh", "connected", "with-repo", "unknown"] {
        discard_unconnected_host(&handle, id).unwrap();
    }
    let kept: Vec<String> = crate::load_app_config(&handle).remote_hosts.into_keys().collect();
    assert_eq!(kept, ["connected", "with-repo"]);
    if let Ok(dir) = handle.path().app_config_dir() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// `ssh -G` resolves an alias from a config file without connecting.
#[test]
fn describe_destination_reports_where_an_alias_resolves() {
    if std::process::Command::new("ssh").arg("-V").output().is_err() {
        eprintln!("skipped: no ssh on this machine");
        return;
    }
    let dir = std::env::temp_dir().join(format!("alinery-ssh-g-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = dir.join("config");
    std::fs::write(&config, "Host demo\n  HostName demo.example.com\n  User deploy\n  Port 2200\n").unwrap();
    let target = describe_destination(&format!("-F {} demo", config.display())).unwrap();
    assert_eq!(
        target,
        SshTarget {
            hostname: "demo.example.com".into(),
            user: Some("deploy".into()),
            port: 2200,
            jump: None,
        }
    );
    assert!(describe_destination("ssh box ls").is_err(), "a destination the parser refuses is not passed to ssh");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn reconnect_waits_5_10_30_then_60_seconds() {
    let waits: Vec<u64> = (0..6).map(|attempt| reconnect_delay(attempt).as_secs()).collect();
    assert_eq!(waits, [5, 10, 30, 60, 60, 60]);
}

#[test]
fn a_key_or_login_problem_is_not_retried() {
    assert!(worth_retrying("could not resolve the host name"));
    assert!(worth_retrying("ssh timed out"));
    assert!(!worth_retrying(&SshFailure::UnknownHostKey.to_string()));
    assert!(!worth_retrying(
        "the host's key changed since you last connected; check ~/.ssh/known_hosts before continuing"
    ));
    assert!(!worth_retrying("ssh authentication failed. Alinery connects without prompts"));
}

#[test]
fn a_failed_host_is_given_up_on_only_when_nothing_will_retry_it() {
    use std::time::{Duration, Instant};
    let remotes = RemoteManager::default();
    let gave_up = |id: &str| remotes.gave_up(id, &remotes.status(id));

    // Never connected, or disconnected on purpose: a failure stays failed.
    remotes.set("box", "failed", "", Some("ssh timed out".into()));
    assert!(gave_up("box"));

    // A wanted host whose channel just died reads `failed` (DISCONNECTED) until the supervisor
    // tick marks it `reconnecting`: that window is not giving up, and neither is the end of a
    // failed attempt before `reconnect_finished`.
    remotes.want("box");
    remotes.set("box", "connected", "", None);
    let status = remotes.status("box");
    assert_eq!((status.state.as_str(), status.error.as_deref()), ("failed", Some(DISCONNECTED)));
    assert!(!gave_up("box"));
    remotes.set("box", "failed", "", Some("ssh timed out".into()));
    assert!(!gave_up("box"));
    remotes.set("box", "reconnecting", "Retrying automatically", None);
    assert!(!gave_up("box"));

    // An error retrying cannot fix is given up on: reconnect_finished unwants the host.
    let t0 = Instant::now();
    remotes.due_reconnects(t0);
    remotes.reconnect_finished("box", &Err("host key changed".into()), t0 + Duration::from_secs(5));
    assert!(gave_up("box"));
}

#[test]
fn a_dropped_host_is_retried_with_backoff_and_a_user_disconnect_is_left_alone() {
    use std::time::{Duration, Instant};
    let remotes = RemoteManager::default();
    let t0 = Instant::now();
    let secs = |n: u64| t0 + Duration::from_secs(n);

    // Never connected, or disconnected on purpose: nothing to bring back.
    remotes.set("box", "failed", "", Some("boom".into()));
    assert!(remotes.due_reconnects(secs(100)).is_empty());

    // A host stored as connected whose channel is gone has dropped. The UI hears "reconnecting"
    // at once; the first attempt is 5 s away.
    remotes.want("box");
    remotes.set("box", "connected", "", None);
    assert!(remotes.due_reconnects(t0).is_empty());
    let status = remotes.status("box");
    assert_eq!((status.state.as_str(), status.error.as_deref()), ("reconnecting", Some(DISCONNECTED)));
    assert!(remotes.due_reconnects(secs(4)).is_empty());
    assert_eq!(remotes.due_reconnects(secs(5)), ["box"]);
    assert!(remotes.due_reconnects(secs(60)).is_empty(), "an attempt in flight is not started twice");

    // It fails: next try 10 s later, with the error kept.
    remotes.reconnect_finished("box", &Err("ssh timed out".into()), secs(8));
    assert_eq!(remotes.status("box").error.as_deref(), Some("ssh timed out"));
    assert!(remotes.due_reconnects(secs(17)).is_empty());
    assert_eq!(remotes.due_reconnects(secs(18)), ["box"]);

    // It works: the backoff starts over for the next drop.
    remotes.reconnect_finished("box", &Ok(()), secs(20));
    remotes.set("box", "connected", "", None);
    assert!(remotes.due_reconnects(secs(22)).is_empty());
    assert_eq!(remotes.due_reconnects(secs(27)), ["box"]);

    // A manual connect that fails in between is shown as retrying, not as failed.
    remotes.reconnect_finished("box", &Err("ssh timed out".into()), secs(28));
    remotes.set("box", "failed", "", Some("no route".into()));
    remotes.due_reconnects(secs(29));
    assert_eq!(remotes.status("box").state, "reconnecting");

    // The user disconnects while it is down: it stays down.
    remotes.unwant("box");
    remotes.set("box", "idle", "", None);
    assert!(remotes.due_reconnects(secs(1000)).is_empty());
}

#[test]
fn a_failure_retrying_cannot_fix_ends_the_retries() {
    use std::time::{Duration, Instant};
    let remotes = RemoteManager::default();
    let t0 = Instant::now();
    remotes.want("box");
    remotes.set("box", "failed", "", Some(DISCONNECTED.into()));
    remotes.due_reconnects(t0);
    assert_eq!(remotes.due_reconnects(t0 + Duration::from_secs(5)), ["box"]);
    remotes.reconnect_finished(
        "box",
        &Err("ssh authentication failed. Alinery connects without prompts".into()),
        t0 + Duration::from_secs(6),
    );
    assert_eq!(remotes.status("box").state, "failed");
    assert!(remotes.due_reconnects(t0 + Duration::from_secs(1000)).is_empty());
}

#[test]
fn a_host_that_is_mid_connect_is_not_started_again() {
    use std::time::{Duration, Instant};
    let remotes = RemoteManager::default();
    remotes.want("box");
    remotes.set("box", "connecting", "Probing", None);
    assert!(remotes.due_reconnects(Instant::now() + Duration::from_secs(1000)).is_empty());
}

#[test]
fn someone_elses_daemon_names_its_starter_and_is_joinable_only_on_this_protocol() {
    let record = |protocol, started_by: &str| crate::host_wire::HostDaemon {
        repo: "/srv/r".into(),
        os_user: "dev".into(),
        started_by: started_by.into(),
        protocol,
        ..Default::default()
    };
    let same = record(alinery_core::PROTOCOL_VERSION, "jon on Strix");
    let conflict = foreign_conflict("alinery+ssh://box/srv/r", Some(&same), "id");
    assert!(conflict.joinable && conflict.owners.is_empty());
    assert_eq!(conflict.issues, ["jon on Strix started this daemon. Anyone already using it can let you in."]);
    assert_eq!(conflict.starter.as_ref().map(|s| (s.os_user.as_str(), s.mine)), Some(("dev", false)));
    let older = record(alinery_core::PROTOCOL_VERSION - 1, "jon on Strix");
    let conflict = foreign_conflict("alinery+ssh://box/srv/r", Some(&older), "id");
    assert!(!conflict.joinable && conflict.issues[0].contains("Ask them to update or restart it"));
    let mine = record(alinery_core::PROTOCOL_VERSION, &alinery_core::started_by_label());
    assert!(foreign_conflict("k", Some(&mine), "id").issues[0].starts_with("Another Alinery on this computer"));
    assert!(foreign_conflict("k", None, "id").joinable, "with no record the members decide");
}
