use crate::remote::*;
use alinery_core::repo_service::RepoOp;
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

fn live_session(args: &[String], id: &str) -> RemoteSession {
    let conn = HostConn::new(id, args).unwrap();
    conn.ensure_master(true).unwrap();
    let probe = conn.probe().unwrap();
    let bundle = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/remote");
    let manifest: RuntimeManifest = serde_json::from_str(&std::fs::read_to_string(bundle.join("manifest.json")).unwrap()).unwrap();
    let (_, target) = select_target(&probe, &manifest).unwrap();
    let root = remote_root(&probe.home);
    let runtime = runtime_dir(&root, &target.runtime_hash);
    if !conn.runtime_installed(&runtime).unwrap() {
        conn.install_runtime(&runtime, std::fs::File::open(bundle.join(&target.archive)).unwrap()).unwrap();
    }
    let config_dir = remote_config_dir(&root, "livetest");
    let channel = RepoChannel::open(&conn, &format!("{runtime}/alinery-mcp"), &format!("{config_dir}/app.toml")).unwrap();
    let launcher = choose_launcher(&probe).unwrap();
    RemoteSession {
        conn,
        channel,
        launcher,
        root,
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
    let listing = call(alinery_core::repo_service::RepoOp::ListDir {
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
    assert_eq!(call(alinery_core::repo_service::RepoOp::Classify { path: repo.clone().into() })["kind"], "absent");
    assert_eq!(call(alinery_core::repo_service::RepoOp::Init { path: repo.clone().into() })["kind"], "initialized");
    assert_eq!(call(alinery_core::repo_service::RepoOp::Classify { path: repo.clone().into() })["kind"], "checkout");

    // Claim it, write the settings, start the daemon through the forward.
    assert_eq!(call(alinery_core::repo_service::RepoOp::ClaimRepo { repo: repo.clone().into() })["claimed"], true);
    let local = crate::AppConfig {
        known_repos: vec![format!("alinery+ssh://{id}{repo}")],
        ..Default::default()
    };
    call(alinery_core::repo_service::RepoOp::WriteFile {
        path: format!("{}/app.toml", session.config_dir).into(),
        contents: render_remote_app_toml(&local, std::slice::from_ref(&repo), false).unwrap(),
    });
    let identity = alinery_core::app_config_identity(Path::new(&format!("{}/app.toml", session.config_dir)));
    let (client, compat, _) = ensure_remote_daemon(&session, &repo, &identity).unwrap();
    assert!(compat.usable());
    assert!(client.session_statuses_observed().unwrap().is_empty());

    // UI control over the forward: the secret this Mac gave the daemon opens it, nothing else does,
    // and the file that carried it is gone from the host.
    let secret = read_ui_secrets(&session.secrets_dir).remove(&repo).expect("the app kept the secret it gave the daemon");
    assert_eq!(secret.len(), 64);
    let leftover = session
        .conn
        .exec_ok(
            &format!("ls '{}/ui-secrets' | wc -l", session.config_dir),
            RemoteStdin::None,
            std::time::Duration::from_secs(20),
        )
        .unwrap();
    assert_eq!(leftover.trim(), "0", "the daemon deletes the secret file when it starts");
    assert!(
        alinery_core::daemon_client::UiControlConnection::connect(&client).is_err(),
        "the peer is sshd, which is not the UI host"
    );
    assert!(alinery_core::daemon_client::UiControlConnection::connect_with_secret(&client, &"x".repeat(64)).is_err());
    alinery_core::daemon_client::UiControlConnection::connect_with_secret(&client, &secret).unwrap();

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
    assert_ne!(rpc_local, repo_forward(&session.conn.host_id, &repo).unwrap().0);
    let wrong = tauri::async_runtime::block_on(crate::daemon_rpc::hello(&rpc_local, "x".repeat(64).as_str())).unwrap_err();
    assert!(wrong.contains("grpc-status 16"), "a wrong token is UNAUTHENTICATED, not a transport failure: {wrong}");

    // Dropping the channel and the master (a disconnect) leaves the daemon alone.
    session.conn.exit_master();
    drop(session);
    let again = live_session(&args, &id);
    assert_eq!(daemons(&again), before, "the daemon must be the same process after reconnecting");
    let (_, compat, _) = ensure_remote_daemon(&again, &repo, &identity).unwrap();
    assert!(compat.usable());
    assert_eq!(daemons(&again), before, "reconnecting must not start a second daemon");
    assert_eq!(
        hello_now(&again).epoch,
        first_hello.epoch,
        "Hello after the reconnect reaches the same daemon, not a new one"
    );
    // The claim died with the old channel, so a new channel can take it.
    assert_eq!(
        again
            .channel
            .call(alinery_core::repo_service::RepoOp::ClaimRepo { repo: repo.into() }, std::time::Duration::from_secs(30))
            .unwrap()["claimed"],
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
        assert!(!host_toml.contains("ghp_live_mac_only") && !host_toml.contains("live-install-id"), "{host_toml}");
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

    let config = crate::set_active_repo_sync(handle.clone(), handle.state(), key.clone(), Vec::new()).unwrap();
    assert_eq!(config.active_repo, key);
    assert!(state.daemon_for(Path::new(&key)).is_some());
    assert!(crate::active_repo().is_err(), "un-migrated local-path commands must refuse a remote active repo");
    assert!(state.daemon().is_some(), "the active remote repo's client is the one session commands use");

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
            RepoOp::WriteFile {
                path: format!("{repo}/.alinery/tasks/remote-task/task.md").into(),
                contents: toml::to_string(&task).unwrap(),
            },
            std::time::Duration::from_secs(30),
        )
        .unwrap();
    // A terminal on the host, streamed through the forwarded socket: create the auxiliary
    // session, open it, type a command, read the output come back.
    let client = repo_client(&state, &crate::RepoRef::parse(&key).unwrap()).unwrap();
    let created = client
        .create_execution_session(&alinery_core::task_creation::CreateExecutionSessionRequest {
            task_slug: String::new(),
            target: alinery_core::task_creation::ExecutionSessionTarget::Auxiliary {
                harness: alinery_core::NO_HARNESS_KEY.into(),
                model: None,
                prompt: None,
            },
            launch_override: None,
            prompt_extra: None,
            handoff_artifact: None,
            start: false,
        })
        .unwrap();
    let terminal = created.session.id.clone();
    // The shell starts over the forward. Its bytes travel on TerminalService, not on this socket
    // (vinculum-daemon/src/rpc/terminal.test.ts).
    client
        .resume_session(&alinery_core::daemon_client::OpenRequest {
            intent: alinery_core::daemon_client::ops::SPAWN,
            id: &terminal,
            cwd: &repo,
            task_slug: Some(""),
            phase: None,
            model: None,
            resume_token: None,
            cols: Some(80),
            rows: Some(24),
        })
        .unwrap();

    client.kill_session(&terminal).unwrap();

    // The GitHub import's token for a remote repo: the host's `config.toml` override over this machine's global one.
    let app_config = crate::app_config_path(&handle).unwrap();
    let (host_id, host_path) = match crate::RepoRef::parse(&key).unwrap() {
        crate::RepoRef::Remote { host_id, path } => (host_id, path),
        crate::RepoRef::Local(_) => unreachable!("the key is a remote key"),
    };
    let global_token = alinery_core::load_global_settings(&app_config).github.token;
    assert_eq!(crate::remote_github_token(&app_config, &state, &host_id, host_path.as_ref()).unwrap(), global_token);
    remote_call::<()>(
        &state,
        &id,
        RepoOp::WriteFile {
            path: format!("{repo}/.alinery/config.toml").into(),
            contents: "[github]\ntoken = \"host-token\"\n".into(),
        },
    )
    .unwrap();
    assert_eq!(crate::remote_github_token(&app_config, &state, &host_id, host_path.as_ref()).unwrap(), "host-token");

    // The community import registry's view of a remote repo's playbooks (S4.10 retires it): the library code runs on a scratch copy of
    // the host's files and only what changed goes back. The playbook library itself is the host daemon's PlaybookService since S4.6.
    {
        use alinery_core::playbook::{PlaybookRef, PlaybookScope};
        use alinery_core::playbook_library as library;
        let remote = Some(crate::RepoRef::parse(&key).unwrap());
        let reference = PlaybookRef {
            scope: PlaybookScope::Repo,
            key: "one-shot".into(),
        };
        let source = include_str!("../../playbooks/one-shot/playbook.md");
        let tree = || remote_call::<Vec<alinery_core::playbook_tree::TreeFile>>(&state, &id, RepoOp::ReadPlaybookTree { repo: repo.clone().into() }).unwrap();
        let catalog = |library_at: Option<crate::RepoRef>| crate::with_library_at(&app_config, &state, library_at, |lib| library::load_playbook_catalog(&lib.roots)).unwrap();
        let save = |overwrite: bool, text: &str| {
            crate::with_library_at(&app_config, &state, remote.clone(), |lib| {
                lib.require_owned(&state).unwrap();
                library::save_playbook(
                    &lib.roots,
                    library::SavePlaybookRequest {
                        target: reference.clone(),
                        source: text.into(),
                        overwrite,
                    },
                )
            })
        };

        assert!(tree().is_empty());
        let empty = catalog(remote.clone());
        assert!(empty.candidates.iter().any(|candidate| candidate.source.reference.scope == PlaybookScope::Bundled));
        assert!(!empty.candidates.iter().any(|candidate| candidate.source.reference.scope == PlaybookScope::Repo));

        save(false, source).unwrap().unwrap();
        let host_file = format!("{repo}/.alinery/playbooks/one-shot/playbook.md");
        assert_eq!(
            tree().iter().map(|file| file.path.as_str()).collect::<Vec<_>>(),
            [".alinery/playbooks/one-shot/playbook.md"]
        );
        assert!(
            matches!(save(false, source).unwrap(), Err(library::PlaybookSaveError::Conflict { .. })),
            "an existing playbook is not replaced silently"
        );

        let listed = catalog(remote.clone());
        let candidate = listed
            .candidates
            .iter()
            .find(|candidate| candidate.source.reference == reference)
            .expect("the repo playbook is listed");
        assert!(candidate.title.is_some() && candidate.modified_at_ms.is_some());
        let read = crate::with_library_at(&app_config, &state, remote.clone(), |lib| library::resolve_playbook(&lib.roots, &reference))
            .unwrap()
            .unwrap();
        assert_eq!(read.definition.key, "one-shot");

        // Picker preferences live beside the playbooks.
        let preferences = library::PickerPreferences {
            order: vec![reference.clone()],
            entries: Vec::new(),
        };
        crate::with_library_at(&app_config, &state, remote.clone(), |lib| library::save_picker_preferences(&lib.roots, &preferences))
            .unwrap()
            .unwrap();
        assert!(tree().iter().any(|file| file.path == ".alinery/playbooks/picker.toml"));
        assert_eq!(catalog(remote.clone()).picker_preferences, preferences);

        // A host file that moved while the copy was being edited is not overwritten.
        let edited = source.replacen("title = \"One-shot\"", "title = \"One-shot edited\"", 1);
        assert_ne!(edited, source);
        let stale = crate::with_library_at(&app_config, &state, remote.clone(), |lib| {
            session
                .channel
                .call(
                    RepoOp::WriteFile {
                        path: host_file.clone().into(),
                        contents: "edited on the host meanwhile".into(),
                    },
                    std::time::Duration::from_secs(30),
                )
                .unwrap();
            library::save_playbook(
                &lib.roots,
                library::SavePlaybookRequest {
                    target: reference.clone(),
                    source: edited.clone(),
                    overwrite: true,
                },
            )
        });
        let refused = stale.unwrap_err();
        assert!(refused.contains("changed on the host"), "{refused}");
        assert_eq!(
            String::from_utf8_lossy(&tree().iter().find(|file| file.path.ends_with("one-shot/playbook.md")).unwrap().data),
            "edited on the host meanwhile"
        );

        // Delete removes the file and the directory it leaves empty; the preferences stay.
        save(true, source).unwrap().unwrap();
        crate::with_library_at(&app_config, &state, remote.clone(), |lib| library::delete_playbook(&lib.roots, &reference))
            .unwrap()
            .unwrap();
        assert_eq!(tree().iter().map(|file| file.path.as_str()).collect::<Vec<_>>(), [".alinery/playbooks/picker.toml"]);
        assert!(!catalog(remote.clone()).candidates.iter().any(|candidate| candidate.source.reference == reference));
    }

    // Disconnect: the app forgets the daemon handle; the daemon itself is untouched.
    disconnect_host(&handle, &id);
    assert!(state.daemon_for(Path::new(&key)).is_none());
    assert_eq!(host_views(&handle, &state)[0].state, "idle");
    assert!(
        crate::set_active_repo_sync(handle.clone(), handle.state(), key.clone(), Vec::new()).is_err(),
        "a disconnected host cannot be activated"
    );

    // Reconnect re-attaches every known repo on the host to the daemon that was still running.
    connect_and_attach(&handle, &id, false).unwrap();
    assert!(state.daemon_for(Path::new(&key)).is_some());

    let after = remove_remote_repo(&handle, &key).unwrap();
    assert!(!after.known_repos.contains(&key));
    assert!(state.daemon_for(Path::new(&key)).is_none());
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
    crate::set_active_repo_sync(handle.clone(), handle.state(), key.clone(), Vec::new()).unwrap();
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
    assert!(state.daemon_for(Path::new(&key)).is_some_and(|client| client.version_checked().is_ok()));

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
    crate::set_active_repo_sync(handle.clone(), handle.state(), key.clone(), Vec::new()).unwrap();
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
    assert!(state.daemon_for(Path::new(&key)).is_none());

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
    crate::set_active_repo_sync(handle.clone(), handle.state(), key.clone(), Vec::new()).unwrap();
    // This repo's daemons only: the host runs the other live tests' daemons too.
    let daemons = || sh(&format!("pgrep -f '[a]linery-vinculum-daemon --repo {repo}' | sort"));

    // Replace the good daemon with one started under another settings file, which gives it another identity.
    let good = state.daemon_for(Path::new(&key)).expect("the app's own daemon is attached");
    good.call(&alinery_core::daemon_client::shutdown_request()).unwrap();
    session.channel.call(RepoOp::WaitDaemonGone { repo: repo.clone().into() }, Duration::from_secs(30)).unwrap();
    state.clear_daemon(Path::new(&key));
    assert!(daemons().trim().is_empty(), "no daemon is left to confuse the count");
    let (config_dir, runtime) = (session.config_dir.clone(), runtime_dir(&session.root, &session.runtime_hash));
    sh(&format!("cp '{config_dir}/app.toml' '{config_dir}/other.toml'"));
    session
        .channel
        .call(
            RepoOp::SpawnDaemon {
                repo: repo.clone().into(),
                app_config: format!("{config_dir}/other.toml").into(),
                binary: format!("{runtime}/alinery-vinculum-daemon").into(),
                build_id: session.runtime_hash.clone(),
                namespace: None,
                ownership_lib: Some(format!("{runtime}/libalinery_core.so").into()),
                log: format!("{config_dir}/logs/old-daemon.log").into(),
                // The test host has no systemd user manager; the daemon still detaches.
                launch: alinery_core::repo_service::Launch::Direct,
                unit: None,
                ui_secret_file: None,
                rpc_secret_file: None,
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

    // Opening the repo reports the conflict instead of failing, and replaces nothing.
    crate::activate_remote_repo(&handle, &state, &key).unwrap();
    assert!(state.daemon_for(Path::new(&key)).is_none());
    let conflict = state.daemon_conflict(Path::new(&key)).expect("the unusable daemon is recorded as a conflict");
    assert_eq!(conflict.repo, key);
    assert_eq!(conflict.owners.len(), 1);
    assert!(matches!(&conflict.owners[0].impact, crate::TakeoverImpact::Known { sessions } if sessions.is_empty()));
    assert!(conflict.issues[0].contains("other settings"), "{:?}", conflict.issues);
    assert!(repo_client(&state, &crate::RepoRef::parse(&key).unwrap()).unwrap_err().contains("restart it"));
    assert_eq!(daemons(), old, "attaching never replaces the daemon");

    // The confirmed stop ends it, waits for its socket to go, and starts this app's daemon.
    crate::stop_remote_daemon(&handle, &id, &repo, |_, _| Ok(())).unwrap();
    assert!(state.daemon_conflict(Path::new(&key)).is_none());
    let client = state.daemon_for(Path::new(&key)).expect("the new daemon is attached");
    let after = daemons();
    assert_eq!(after.lines().count(), 1, "one daemon serves the repo: {after}");
    assert_ne!(after, old, "the old daemon is gone and a new one runs");
    let version = client.version();
    let identity = alinery_core::app_config_identity(Path::new(&format!("{config_dir}/app.toml")));
    assert_eq!(version.app_config_identity.as_deref(), Some(identity.as_str()));
    assert!(client.session_statuses_observed().unwrap().is_empty());

    let _ = remove_remote_repo(&handle, &key);
    disconnect_host(&handle, &id);
    let _ = crate::set_active_repo_global(None);
    if let Ok(dir) = handle.path().app_config_dir() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Backups on the host: the host applies its own settings and writes the archive to its own disk, and a
/// confirmed restore replaces its data while its daemon is down, then starts the daemon again. A bad
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
    crate::set_active_repo_sync(handle.clone(), handle.state(), key.clone(), Vec::new()).unwrap();
    let write = |relative: &str, contents: &str| {
        session
            .channel
            .call(
                RepoOp::WriteFile {
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

    // The host checks the folder: one inside the repo's own `.alinery` can never hold backups.
    let checked: String = crate::remote_call(
        &state,
        &id,
        RepoOp::BackupCheckDestination {
            repo: repo.clone().into(),
            destination: dest.clone().into(),
        },
    )
    .unwrap();
    assert_eq!(checked, dest);
    let inside: Result<String, String> = crate::remote_call(
        &state,
        &id,
        RepoOp::BackupCheckDestination {
            repo: repo.clone().into(),
            destination: format!("{repo}/.alinery").into(),
        },
    );
    assert!(inside.is_err());

    // A manual backup runs the host's settings; the automatic ones follow its trigger flags.
    let manual: alinery_core::BackupMeta = crate::host_backup(&state, &id, &repo, |repo, app_config| RepoOp::BackupCreate {
        repo,
        app_config,
        trigger: alinery_core::BackupTrigger::Manual,
    })
    .unwrap();
    assert_eq!(manual.repo_path, repo, "the meta names the host's path");
    assert!(sh(&format!("ls '{dest}'")).contains(".zip"), "the archive is on the host's disk");
    assert!(crate::create_queued_remote_backup(&handle, &key, alinery_core::BackupTrigger::PreArchive)
        .unwrap()
        .is_some());
    assert!(
        crate::create_queued_remote_backup(&handle, &key, alinery_core::BackupTrigger::PostPushCommit)
            .unwrap()
            .is_none(),
        "that trigger's flag is off on the host"
    );
    let listed: Vec<alinery_core::BackupListItem> = crate::host_backup(&state, &id, &repo, |repo, app_config| RepoOp::BackupList { repo, app_config }).unwrap();
    assert_eq!(listed.len(), 2);

    // Work after the backup, which a restore must take away.
    write(".alinery/tasks/keep/notes.txt", "after");
    task("late");
    let running = daemons();
    assert!(!running.trim().is_empty(), "the repo's daemon is up");

    // An archive that is not there is refused with the daemon untouched.
    assert!(crate::restore_remote_backup(&handle, &id, &repo, &format!("{dest}/missing.zip")).is_err());
    assert_eq!(daemons(), running, "the daemon was not stopped for an archive that cannot be restored");
    assert_eq!(sh(&format!("cat '{repo}/.alinery/tasks/keep/notes.txt'")), "after");

    crate::restore_remote_backup(&handle, &id, &repo, &listed[0].path).unwrap();
    assert_eq!(sh(&format!("cat '{repo}/.alinery/tasks/keep/notes.txt'")), "before");
    assert_eq!(sh(&format!("ls '{repo}/.alinery/tasks'")).trim(), "keep", "what came after the backup is gone");
    assert!(state.daemon_for(Path::new(&key)).is_some(), "the daemon is attached again");
    let restarted = daemons();
    assert!(
        !restarted.trim().is_empty() && restarted != running,
        "a new daemon replaced the old one: {running} -> {restarted}"
    );
    session.conn.exit_master();
    let _ = std::fs::remove_dir_all(&session.secrets_dir);
}

/// Storage on the host: the numbers and the paths are the host's, and the purge removes only what is
/// archived, on the host's disk.
#[test]
fn live_storage_is_measured_and_purged_on_the_host() {
    let Some(args) = live_args() else {
        eprintln!("skipped: ALINERY_TEST_SSH_ARGS is not set");
        return;
    };
    let _turn = LIVE_HOST.lock().unwrap_or_else(|e| e.into_inner());
    let id = format!("storage-{}", std::process::id());
    let session = live_session(&args, &id);
    let home = session.root.trim_end_matches("/.local/share/alinery-remote").to_string();
    let repo = format!("{home}/work/storage-{}", std::process::id());
    let sh = |script: &str| session.conn.exec_ok(script, RemoteStdin::None, std::time::Duration::from_secs(60)).unwrap();
    sh(&format!("rm -rf '{repo}' && mkdir -p '{repo}' && git init -q '{repo}'"));
    let call = |op: RepoOp| session.channel.call(op, std::time::Duration::from_secs(60)).unwrap();
    for (slug, archived) in [("keep", false), ("old", true)] {
        let task = alinery_core::Task {
            name: slug.into(),
            slug: slug.into(),
            branch: slug.into(),
            archived,
            created: 1_700_000_000,
            ..Default::default()
        };
        call(RepoOp::WriteFile {
            path: format!("{repo}/.alinery/tasks/{slug}/task.md").into(),
            contents: toml::to_string(&task).unwrap(),
        });
        call(RepoOp::WriteFile {
            path: format!("{repo}/.alinery/tasks/{slug}/notes.txt").into(),
            contents: "x".repeat(4096),
        });
    }
    let app_config = format!("{}/app.toml", session.config_dir);
    let ops = || {
        (
            RepoOp::StorageInfo {
                repo: repo.clone().into(),
                app_config: app_config.clone().into(),
            },
            RepoOp::PurgeArchived {
                repo: repo.clone().into(),
                app_config: app_config.clone().into(),
            },
        )
    };
    let info: alinery_core::StorageInfo = serde_json::from_value(call(ops().0)).unwrap();
    assert_eq!(info.repo_path, repo, "paths are the host's");
    assert_eq!(info.app_config_path, app_config);
    assert_eq!(info.tasks_dir, format!("{repo}/.alinery/tasks"));
    assert_eq!((info.archived_task_count, info.archived_session_count), (1, 0));
    assert!(info.archived_bytes >= 4096 && info.active_bytes >= 4096, "{info:?}");

    let purged: alinery_core::PurgeArchivedResult = serde_json::from_value(call(ops().1)).unwrap();
    assert_eq!((purged.deleted_tasks, purged.errors.len()), (1, 0), "{purged:?}");
    assert_eq!(sh(&format!("ls '{repo}/.alinery/tasks'")).trim(), "keep", "only the live task is left on the host");
    let after: alinery_core::StorageInfo = serde_json::from_value(call(ops().0)).unwrap();
    assert_eq!(after.archived_task_count, 0);
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
            let script = "pkill -CONT -f '[a]linery-mcp --repo-service'; true";
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
    crate::set_active_repo_sync(handle.clone(), handle.state(), key.clone(), Vec::new()).unwrap();

    let resume = Resume(session.clone());
    sh("pkill -STOP -f '[a]linery-mcp --repo-service'");
    // The stall is real: a call made straight from a thread is still waiting.
    let direct = {
        let handle = handle.clone();
        let (id, repo) = (id.clone(), repo.clone());
        std::thread::spawn(move || {
            let state = handle.state::<crate::AppState>();
            remote_call::<alinery_core::StorageInfo>(
                &state,
                &id,
                RepoOp::StorageInfo {
                    repo: repo.into(),
                    app_config: crate::host_app_config(&state, &id)?,
                },
            )
        })
    };
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert!(!direct.is_finished(), "the stopped repo service must leave a call waiting");

    // The command is an async fn: its first poll runs up to the hand-off and returns.
    let mut storage = Box::pin(crate::storage_info(handle.clone(), key.clone()));
    let started = std::time::Instant::now();
    let first = storage.as_mut().poll(&mut Context::from_waker(Waker::noop()));
    let took = started.elapsed();
    assert!(matches!(first, Poll::Pending), "the command must wait for the host off this thread");
    assert!(took < std::time::Duration::from_millis(250), "the command held its caller for {took:?}");

    // Resumed, the host answers both, and the command finishes with the host's result.
    resume.now();
    let listed = tauri::async_runtime::block_on(storage).unwrap();
    let direct = direct.join().unwrap().unwrap();
    assert_eq!(
        (listed.repo_path, listed.tasks_dir),
        (direct.repo_path, direct.tasks_dir),
        "the command finishes with the host's answer"
    );
    drop(resume);
    disconnect_host(&handle, &id);
    let _ = std::fs::remove_dir_all(&session.secrets_dir);
}

/// The origin URL and the sub-task requests on the host, against a real repo with an origin. The git actions
/// themselves (commit, push, worktree removal, branch discovery) are the daemon's GitService since S4.7.
#[test]
fn live_origin_url_and_sub_task_requests_run_on_the_host() {
    let Some(args) = live_args() else {
        eprintln!("skipped: ALINERY_TEST_SSH_ARGS is not set");
        return;
    };
    let _turn = LIVE_HOST.lock().unwrap_or_else(|e| e.into_inner());
    let id = format!("git-{}", std::process::id());
    let session = live_session(&args, &id);
    let home = session.root.trim_end_matches("/.local/share/alinery-remote").to_string();
    let (repo, origin, worktree) = (
        format!("{home}/work/git-{}", std::process::id()),
        format!("{home}/origin-{}.git", std::process::id()),
        format!("{home}/work/git-{}/.alinery/worktrees/feat", std::process::id()),
    );
    let sh = |script: &str| session.conn.exec_ok(script, RemoteStdin::None, std::time::Duration::from_secs(60)).unwrap();
    // A repo with an initial commit, a bare origin it can push to, and a task with a worktree on `feat`.
    // The fetch URL looks like GitHub's so the compare URL can be built; pushes go to the bare repo.
    sh(&format!(
        "set -e; rm -rf '{repo}' '{origin}'; git init -q --bare '{origin}'; git init -q -b main '{repo}'; cd '{repo}'; echo hi > a.txt; git add a.txt; git commit -q -m init; \
         git remote add origin https://github.com/acme/widgets.git; git config remote.origin.pushurl '{origin}'; git push -q origin main; \
         mkdir -p .alinery/worktrees; git worktree add -q -b feat '{worktree}'"
    ));
    let task = alinery_core::Task {
        name: "Feature".into(),
        slug: "feat".into(),
        branch: "feat".into(),
        worktree: worktree.clone(),
        has_worktree: true,
        created: 1_700_000_000,
        ..Default::default()
    };
    let call = |op: RepoOp| session.channel.call(op, std::time::Duration::from_secs(60));
    call(RepoOp::WriteFile {
        path: format!("{repo}/.alinery/tasks/feat/task.md").into(),
        contents: toml::to_string(&task).unwrap(),
    })
    .unwrap();
    let repo_path = || std::path::PathBuf::from(&repo);

    // The origin URL is what a bare `#123` GitHub import resolves against.
    let origin_url: Option<String> = serde_json::from_value(call(RepoOp::GitOriginUrl { repo: repo_path() }).unwrap()).unwrap();
    assert_eq!(origin_url.as_deref(), Some("https://github.com/acme/widgets.git"));

    sh(&format!("rm -rf '{repo}' '{origin}'"));
    session.conn.exit_master();
}

#[test]
fn approval_secrets_are_kept_per_repo_in_an_owner_only_file() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("alinery-secrets-{}", uuid::Uuid::new_v4()));
    let app_config = dir.join("app.toml");
    let secrets = remote_secrets_dir(&app_config, "box-a1b2c3").unwrap();
    let secret_of = |repo: &str| read_ui_secrets(&remote_secrets_dir(&app_config, "box-a1b2c3").unwrap()).remove(repo);
    assert_eq!(secret_of("/srv/a"), None);
    store_ui_secret(&secrets, "/srv/a", "first").unwrap();
    store_ui_secret(&secrets, "/srv/b", "other").unwrap();
    store_ui_secret(&secrets, "/srv/a", "second").unwrap();
    assert_eq!(secret_of("/srv/a").as_deref(), Some("second"), "a restarted daemon replaces its secret");
    assert_eq!(secret_of("/srv/b").as_deref(), Some("other"));
    assert_eq!(
        read_ui_secrets(&remote_secrets_dir(&app_config, "another-host").unwrap()).remove("/srv/a"),
        None,
        "secrets do not cross hosts"
    );
    assert_eq!(std::fs::metadata(secrets.join("ui-secrets.json")).unwrap().permissions().mode() & 0o777, 0o600);
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

const PROBE_OK: &str = "Last login: Mon\nmotd noise\n__ALINERY_PROBE__\nuname=Linux x86_64\nhome=/home/me\nglibc=glibc 2.35\npagesize=4096\nhas_tar=1\nhas_gzip=1\nhas_sha256sum=1\nhas_git=1\nhas_setsid=1\nhas_systemd-run=1\nlinger=yes\nkilluser=b false\n";

fn manifest() -> RuntimeManifest {
    let target = |hash: &str| ManifestTarget {
        archive: format!("{hash}.tar.gz"),
        sha256: "00".into(),
        runtime_hash: hash.into(),
    };
    RuntimeManifest {
        glibc_floor: "2.28".into(),
        targets: BTreeMap::from([("x86_64-unknown-linux-gnu".into(), target("aaaa")), ("aarch64-unknown-linux-gnu".into(), target("bbbb"))]),
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
fn refuses_hosts_the_runtime_cannot_run_on() {
    let ok = parse_probe(PROBE_OK).unwrap();
    let cases: Vec<(Probe, &str)> = vec![
        (
            Probe {
                os: "Darwin".into(),
                ..ok.clone()
            },
            "Darwin",
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
    ];
    for (probe, expected) in cases {
        let error = select_target(&probe, &manifest()).unwrap_err();
        assert!(error.contains(expected), "{error}");
    }
    let empty = RuntimeManifest {
        glibc_floor: "2.28".into(),
        targets: BTreeMap::new(),
    };
    assert!(select_target(&ok, &empty).unwrap_err().contains("does not bundle"));
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
    assert!(choose_launcher(&killing).unwrap_err().contains("enable-linger"));
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
                RepoOp::WriteFile {
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
