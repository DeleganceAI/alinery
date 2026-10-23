use crate::remote::*;
use alinery_core::repo_service::RepoOp;
use std::collections::BTreeMap;
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
        contents: render_remote_app_toml(&local, &[repo.clone()]).unwrap(),
    });
    let identity = alinery_core::app_config_identity(Path::new(&format!("{}/app.toml", session.config_dir)));
    let (client, compat, _) = ensure_remote_daemon(&session, &repo, &identity).unwrap();
    assert!(compat.usable());
    assert!(client.session_statuses_observed().unwrap().is_empty());
    let daemons = |session: &RemoteSession| {
        session
            .conn
            .exec_ok("pgrep -f '[a]linery-vinculum-daemon --repo' | sort", RemoteStdin::None, std::time::Duration::from_secs(20))
            .unwrap()
    };
    let before = daemons(&session);
    assert!(!before.trim().is_empty());

    // Dropping the channel and the master (a disconnect) leaves the daemon alone.
    session.conn.exit_master();
    drop(session);
    let again = live_session(&args, &id);
    assert_eq!(daemons(&again), before, "the daemon must be the same process after reconnecting");
    let (_, compat, _) = ensure_remote_daemon(&again, &repo, &identity).unwrap();
    assert!(compat.usable());
    assert_eq!(daemons(&again), before, "reconnecting must not start a second daemon");
    // The claim died with the old channel, so a new channel can take it.
    assert_eq!(
        again
            .channel
            .call(alinery_core::repo_service::RepoOp::ClaimRepo { repo: repo.into() }, std::time::Duration::from_secs(30))
            .unwrap()["claimed"],
        true
    );
    again.conn.exit_master();
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
    crate::write_app_config(&handle, &config).unwrap();

    connect_and_attach(&handle, &id, true).unwrap();
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
    let rows: Vec<crate::BoardTask> = remote_call(&state, &id, RepoOp::ListBoardTasks { repo: repo.clone().into() }).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (rows[0].task.slug.as_str(), rows[0].current_phase.as_str(), rows[0].latest_session_title.as_str()),
        ("remote-task", "", "No sessions")
    );
    let tasks: Vec<alinery_core::Task> = remote_call(&state, &id, RepoOp::ListTasks { repo: repo.clone().into() }).unwrap();
    assert_eq!(tasks, [task.clone()]);
    let found: Option<alinery_core::Task> = remote_call(
        &state,
        &id,
        RepoOp::GetTask {
            repo: repo.clone().into(),
            slug: "remote-task".into(),
        },
    )
    .unwrap();
    assert_eq!(found, Some(task));
    let missing: Option<alinery_core::Task> = remote_call(
        &state,
        &id,
        RepoOp::GetTask {
            repo: repo.clone().into(),
            slug: "nope".into(),
        },
    )
    .unwrap();
    assert_eq!(missing, None);
    assert!(remote_call::<Vec<crate::BoardTask>>(&state, "not-a-host", RepoOp::ListTasks { repo: repo.clone().into() }).is_err());

    // The task page's reads, answered by the host: a session meta written there is listed,
    // and the sub-task, artifact, worktree and launch-field reads agree with the task.
    let meta = alinery_core::SessionMeta {
        id: "s1".into(),
        phase: "build".into(),
        harness: alinery_core::NO_HARNESS_KEY.into(),
        created: 1_700_000_001,
        ..Default::default()
    };
    session
        .channel
        .call(
            RepoOp::WriteFile {
                path: format!("{repo}/.alinery/tasks/remote-task/sessions/s1.meta.json").into(),
                contents: serde_json::to_string(&meta).unwrap(),
            },
            std::time::Duration::from_secs(30),
        )
        .unwrap();
    let slug = || "remote-task".to_string();
    let sessions: Vec<crate::SessionDisplayMeta> = remote_call(
        &state,
        &id,
        RepoOp::ListSessions {
            repo: repo.clone().into(),
            slug: slug(),
        },
    )
    .unwrap();
    assert_eq!(sessions.iter().map(|session| session.meta.id.as_str()).collect::<Vec<_>>(), ["s1"]);
    let display: crate::SessionDisplayContext = remote_call(
        &state,
        &id,
        RepoOp::GetSessionDisplay {
            repo: repo.clone().into(),
            slug: slug(),
            session_id: "s1".into(),
        },
    )
    .unwrap();
    assert_eq!((display.task_name.as_str(), display.session.meta.phase.as_str()), ("Remote task", "build"));
    let subtask: alinery_core::SubtaskManagerState = remote_call(
        &state,
        &id,
        RepoOp::SubtaskState {
            repo: repo.clone().into(),
            slug: slug(),
        },
    )
    .unwrap();
    assert_eq!(subtask.disabled_reason, "Pre-v2 task data is read-only");
    let tree: Vec<alinery_core::ArtifactTreeNode> = remote_call(
        &state,
        &id,
        RepoOp::ListTaskArtifactTree {
            repo: repo.clone().into(),
            slug: slug(),
        },
    )
    .unwrap();
    assert!(tree.is_empty());
    let artifacts: Vec<alinery_core::ArtifactListItem> = remote_call(
        &state,
        &id,
        RepoOp::ListArtifactsWithMetadata {
            repo: repo.clone().into(),
            slug: slug(),
        },
    )
    .unwrap();
    assert!(artifacts.is_empty());
    let worktree: bool = remote_call(
        &state,
        &id,
        RepoOp::WorktreeExists {
            repo: repo.clone().into(),
            slug: slug(),
        },
    )
    .unwrap();
    assert!(!worktree);
    let launch: Option<alinery_core::LaunchFields> = remote_call(
        &state,
        &id,
        RepoOp::ReadLaunchFields {
            repo: repo.clone().into(),
            slug: slug(),
            session_id: "s1".into(),
        },
    )
    .unwrap();
    assert_eq!(launch.map(|launch| launch.harness), Some(alinery_core::NO_HARNESS_KEY.to_string()));

    // Artifacts and review comments: the viewer's reads and the whole comment round trip.
    let artifact = "01-plan.md";
    let call_ok = |op: RepoOp| session.channel.call(op, std::time::Duration::from_secs(30)).unwrap();
    call_ok(RepoOp::WriteFile {
        path: format!("{repo}/.alinery/tasks/remote-task/artifacts/{artifact}").into(),
        contents: "# Plan\nline two\n".into(),
    });
    let text: String = remote_call(
        &state,
        &id,
        RepoOp::ReadArtifact {
            repo: repo.clone().into(),
            slug: slug(),
            name: artifact.into(),
        },
    )
    .unwrap();
    assert_eq!(text, "# Plan\nline two\n");
    assert!(remote_call::<String>(
        &state,
        &id,
        RepoOp::ReadArtifact {
            repo: repo.clone().into(),
            slug: slug(),
            name: "../task.md".into()
        }
    )
    .is_err());

    let input = |body: &str| alinery_core::artifact_comments::CommentInput {
        anchor_id: "h1".into(),
        anchor_kind: "heading".into(),
        anchor_label: "Plan".into(),
        anchor_excerpt: "# Plan".into(),
        line_start: 1,
        line_end: 1,
        body: body.into(),
    };
    let added: Vec<crate::ArtifactComment> = remote_call(
        &state,
        &id,
        RepoOp::AddArtifactComment {
            repo: repo.clone().into(),
            slug: slug(),
            artifact: artifact.into(),
            comment: input("  Needs a rollback step  "),
        },
    )
    .unwrap();
    assert_eq!(added.len(), 1);
    assert_eq!(added[0].body, "Needs a rollback step", "the body is trimmed on the host");
    assert!(remote_call::<Vec<crate::ArtifactComment>>(
        &state,
        &id,
        RepoOp::AddArtifactComment {
            repo: repo.clone().into(),
            slug: slug(),
            artifact: artifact.into(),
            comment: input("   ")
        }
    )
    .is_err());
    let listed: Vec<crate::ArtifactComment> = remote_call(
        &state,
        &id,
        RepoOp::ListArtifactComments {
            repo: repo.clone().into(),
            slug: slug(),
            artifact: artifact.into(),
        },
    )
    .unwrap();
    assert_eq!(listed, added);

    // Drafts are saved, listed (not stale while the artifact is unchanged) and deleted.
    remote_call::<()>(
        &state,
        &id,
        RepoOp::SaveCommentDraft {
            repo: repo.clone().into(),
            slug: slug(),
            artifact: artifact.into(),
            comment: input("draft text"),
        },
    )
    .unwrap();
    let drafts: Vec<crate::ArtifactCommentDraft> = remote_call(
        &state,
        &id,
        RepoOp::ListCommentDrafts {
            repo: repo.clone().into(),
            slug: slug(),
        },
    )
    .unwrap();
    assert_eq!((drafts.len(), drafts[0].body.as_str()), (1, "draft text"));
    remote_call::<()>(
        &state,
        &id,
        RepoOp::DeleteCommentDraft {
            repo: repo.clone().into(),
            slug: slug(),
            artifact: artifact.into(),
            anchor_id: "h1".into(),
        },
    )
    .unwrap();
    let drafts: Vec<crate::ArtifactCommentDraft> = remote_call(
        &state,
        &id,
        RepoOp::ListCommentDrafts {
            repo: repo.clone().into(),
            slug: slug(),
        },
    )
    .unwrap();
    assert!(drafts.is_empty());

    // Prepare the prompt, "send" it (finalize), and the comments become a pending review.
    let prepared: crate::PreparedSessionMessageAction = remote_call(
        &state,
        &id,
        RepoOp::PrepareArtifactCommentsPrompt {
            repo: repo.clone().into(),
            slug: slug(),
            artifacts: vec![artifact.into()],
        },
    )
    .unwrap();
    assert!(
        prepared.text.contains(&format!("{repo}/.alinery/tasks/remote-task/artifacts/01-plan.review-001.md")),
        "the prompt names the host's path: {}",
        prepared.text
    );
    remote_call::<()>(
        &state,
        &id,
        RepoOp::FinalizeSessionMessageActions {
            repo: repo.clone().into(),
            slug: slug(),
            session_id: "s1".into(),
            actions: vec![prepared.provenance],
        },
    )
    .unwrap();
    let pending: Option<crate::ArtifactReviewPendingStatus> = remote_call(
        &state,
        &id,
        RepoOp::ArtifactReviewPendingStatus {
            repo: repo.clone().into(),
            slug: slug(),
            artifact: artifact.into(),
        },
    )
    .unwrap();
    assert_eq!(pending.map(|status| status.review), Some("01-plan.review-001.md".to_string()));
    let after: Vec<crate::ArtifactComment> = remote_call(
        &state,
        &id,
        RepoOp::ListArtifactComments {
            repo: repo.clone().into(),
            slug: slug(),
            artifact: artifact.into(),
        },
    )
    .unwrap();
    assert!(after.is_empty(), "sending the comments consumes them");
    remote_call::<()>(
        &state,
        &id,
        RepoOp::ClearArtifactReviewPending {
            repo: repo.clone().into(),
            slug: slug(),
            artifact: artifact.into(),
        },
    )
    .unwrap();
    let pending: Option<crate::ArtifactReviewPendingStatus> = remote_call(
        &state,
        &id,
        RepoOp::ArtifactReviewPendingStatus {
            repo: repo.clone().into(),
            slug: slug(),
            artifact: artifact.into(),
        },
    )
    .unwrap();
    assert!(pending.is_none());

    // The archive path numbers the next review file and reports the host's path to it.
    remote_call::<Vec<crate::ArtifactComment>>(
        &state,
        &id,
        RepoOp::AddArtifactComment {
            repo: repo.clone().into(),
            slug: slug(),
            artifact: artifact.into(),
            comment: input("second pass"),
        },
    )
    .unwrap();
    let review: String = remote_call(
        &state,
        &id,
        RepoOp::ArchiveArtifactComments {
            repo: repo.clone().into(),
            slug: slug(),
            artifact: artifact.into(),
        },
    )
    .unwrap();
    assert!(review.ends_with("01-plan.review-002.md"), "{review}");
    let approval: crate::PreparedSessionMessageAction = remote_call(
        &state,
        &id,
        RepoOp::PrepareReviewApprovalPrompt {
            repo: repo.clone().into(),
            slug: slug(),
            review_artifact: "01-plan.review-002.md".into(),
        },
    )
    .unwrap();
    assert!(approval.text.contains("Review playbook action"));

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
    let stream = client
        .send(&alinery_core::daemon_client::open_request(&alinery_core::daemon_client::OpenRequest {
            intent: alinery_core::daemon_client::ops::SPAWN,
            id: &terminal,
            cwd: &repo,
            task_slug: Some(""),
            phase: None,
            model: None,
            attach_id: 1,
            resume_token: None,
            cols: Some(80),
            rows: Some(24),
        }))
        .unwrap();
    stream.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
    let mut reader = std::io::BufReader::new(stream);
    let mut handshake = String::new();
    std::io::BufRead::read_line(&mut reader, &mut handshake).unwrap();
    assert!(handshake.contains("\"ok\":true"), "{handshake}");
    client.write_session(&terminal, "echo alinery-$((40+2))\n").unwrap();
    let mut seen = Vec::new();
    let mut buffer = [0u8; 4096];
    while !String::from_utf8_lossy(&seen).contains("alinery-42") {
        let read = std::io::Read::read(&mut reader, &mut buffer).expect("the terminal answered through the forward");
        assert!(read > 0, "the stream closed before the command ran: {}", String::from_utf8_lossy(&seen));
        seen.extend_from_slice(&buffer[..read]);
    }

    // Scrollback reads come back from the host as base64 and decode to the exact bytes, including
    // bytes that are not valid UTF-8. (Task sessions only: a taskless drawer has no history.)
    let scrollback: Vec<u8> = b"\x1b[1mhello alinery-42\r\n\xff\xfe tail".to_vec();
    session
        .channel
        .call(
            RepoOp::WriteFile {
                path: format!("{repo}/.alinery/tasks/remote-task/sessions/s1.scrollback").into(),
                // WriteFile carries text; the binary tail is appended by the host-side shell below.
                contents: "\u{1b}[1mhello alinery-42\r\n".into(),
            },
            std::time::Duration::from_secs(30),
        )
        .unwrap();
    session
        .conn
        .exec_ok(
            &format!("printf '\\377\\376 tail' >> '{repo}/.alinery/tasks/remote-task/sessions/s1.scrollback'"),
            RemoteStdin::None,
            std::time::Duration::from_secs(20),
        )
        .unwrap();
    let wire: alinery_core::repo_service::WireBytes = remote_call(
        &state,
        &id,
        RepoOp::ReadSessionHistory {
            repo: repo.clone().into(),
            slug: slug(),
            session_id: "s1".into(),
            offset: None,
            limit: None,
        },
    )
    .unwrap();
    // The default read is the terminal replayed (rendered), so only its text is stable.
    assert!(String::from_utf8_lossy(&wire.data).contains("hello alinery-42"));
    let raw: alinery_core::repo_service::WireBytes = remote_call(
        &state,
        &id,
        RepoOp::ReadSessionHistory {
            repo: repo.clone().into(),
            slug: slug(),
            session_id: "s1".into(),
            offset: Some(0),
            limit: Some(1000),
        },
    )
    .unwrap();
    assert_eq!(raw.data, scrollback, "raw windows are byte-exact, including bytes that are not UTF-8");
    let window: alinery_core::repo_service::WireBytes = remote_call(
        &state,
        &id,
        RepoOp::ReadSessionHistory {
            repo: repo.clone().into(),
            slug: slug(),
            session_id: "s1".into(),
            offset: Some(4),
            limit: Some(5),
        },
    )
    .unwrap();
    assert_eq!(window.data, &scrollback[4..9]);
    assert!(
        remote_call::<alinery_core::repo_service::WireBytes>(
            &state,
            &id,
            RepoOp::ReadSessionHistory {
                repo: repo.clone().into(),
                slug: slug(),
                session_id: "s1".into(),
                offset: Some(1),
                limit: None
            }
        )
        .is_err(),
        "offset and limit travel together"
    );

    client.kill_session(&terminal).unwrap();

    // Session and task actions run on the host.
    let named: alinery_core::SessionName = remote_call(
        &state,
        &id,
        RepoOp::RenameSession {
            repo: repo.clone().into(),
            slug: slug(),
            session_id: "s1".into(),
            name: "Fix the build".into(),
        },
    )
    .unwrap();
    assert_eq!(named.name, "Fix the build");
    let shown: crate::SessionDisplayContext = remote_call(
        &state,
        &id,
        RepoOp::GetSessionDisplay {
            repo: repo.clone().into(),
            slug: slug(),
            session_id: "s1".into(),
        },
    )
    .unwrap();
    assert_eq!(shown.session.name.as_deref(), Some("Fix the build"));
    remote_call::<()>(
        &state,
        &id,
        RepoOp::MarkSessionNotificationRead {
            repo: repo.clone().into(),
            slug: slug(),
            session_id: "s1".into(),
        },
    )
    .unwrap();
    assert!(remote_call::<()>(
        &state,
        &id,
        RepoOp::MarkSessionNotificationRead {
            repo: repo.clone().into(),
            slug: slug(),
            session_id: "../s1".into()
        }
    )
    .is_err());

    let renamed: alinery_core::Task = remote_call(
        &state,
        &id,
        RepoOp::RenameTask {
            repo: repo.clone().into(),
            slug: slug(),
            name: "Renamed remote".into(),
        },
    )
    .unwrap();
    assert_eq!(renamed.name, "Renamed remote");

    crate::archive_remote_session(&state, &id, repo.clone(), slug(), "s1".into()).unwrap();
    let after: Vec<crate::SessionDisplayMeta> = remote_call(
        &state,
        &id,
        RepoOp::ListSessions {
            repo: repo.clone().into(),
            slug: slug(),
        },
    )
    .unwrap();
    assert!(after[0].meta.archived);
    assert!(
        crate::archive_remote_session(&state, &id, repo.clone(), "  ".into(), "s1".into()).is_err(),
        "a taskless session cannot be archived"
    );

    remote_call::<()>(
        &state,
        &id,
        RepoOp::ArchiveTask {
            repo: repo.clone().into(),
            slug: slug(),
        },
    )
    .unwrap();
    let archived: Option<alinery_core::Task> = remote_call(
        &state,
        &id,
        RepoOp::GetTask {
            repo: repo.clone().into(),
            slug: slug(),
        },
    )
    .unwrap();
    assert!(archived.unwrap().archived);

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
    assert_eq!(probe.tools["systemd-run"], true);
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
    local.mcp_enabled = false;
    let rendered = render_remote_app_toml(&local, &["/srv/r".to_string()]).unwrap();
    let parsed: crate::AppConfig = toml::from_str(&rendered).unwrap();
    assert!(parsed.remote_hosts.is_empty());
    assert_eq!(parsed.known_repos, ["/srv/r"]);
    assert_eq!(parsed.active_repo, "");
    assert!(!parsed.mcp_enabled, "global settings carry over");
    assert!(!rendered.contains("alinery+ssh"));
}
