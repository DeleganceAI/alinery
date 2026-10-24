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
        contents: render_remote_app_toml(&local, &[repo.clone()]).unwrap(),
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
    let mut control = alinery_core::daemon_client::UiControlConnection::connect_with_secret(&client, &secret).unwrap();
    let refused = control
        .allow_execution_completion(&alinery_core::task_creation::AllowExecutionCompletionRequest {
            task_slug: "t".into(),
            execution_id: "e".into(),
            session_id: "no-such-session".into(),
        })
        .unwrap_err();
    assert!(refused.contains("no engine execution"), "an authorized request reaches the handler: {refused}");

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

    // Attachments: bytes written from here land on the host, and previews read them back intact.
    let png: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x7f];
    let attach = |name: &str, data: &[u8]| -> Result<String, String> {
        remote_call(
            &state,
            &id,
            RepoOp::WriteAttachment {
                repo: repo.clone().into(),
                slug: slug(),
                file_name: name.into(),
                data: data.to_vec(),
            },
        )
    };
    assert_eq!(attach("shot.png", &png).unwrap(), "shot.png");
    let second = attach("shot.png", &png).unwrap();
    assert_ne!(second, "shot.png", "a name collision gets a unique name");
    assert!(attach("../escape.png", &png).is_err());
    let host_path: String = remote_call(
        &state,
        &id,
        RepoOp::AttachmentPath {
            repo: repo.clone().into(),
            slug: slug(),
            name: "shot.png".into(),
        },
    )
    .unwrap();
    assert!(host_path.ends_with("/.alinery/tasks/remote-task/artifacts/attachments/shot.png"), "{host_path}");
    assert!(remote_call::<String>(
        &state,
        &id,
        RepoOp::AttachmentPath {
            repo: repo.clone().into(),
            slug: slug(),
            name: "missing.png".into()
        }
    )
    .is_err());
    let image: crate::ChatImage = remote_call(
        &state,
        &id,
        RepoOp::ReadChatImage {
            repo: repo.clone().into(),
            slug: slug(),
            name: "shot.png".into(),
        },
    )
    .unwrap();
    assert_eq!(image.mime_type, "image/png");
    assert_eq!(alinery_core::rpc_chunk::decode_base64(&image.data).unwrap(), png);
    let wire: alinery_core::repo_service::WireBytes = remote_call(
        &state,
        &id,
        RepoOp::ReadAttachmentImage {
            repo: repo.clone().into(),
            slug: slug(),
            name: "shot.png".into(),
            node_id: None,
        },
    )
    .unwrap();
    assert_eq!(wire.data, png, "image bytes survive the wire, including bytes that are not UTF-8");
    attach("notes.txt", b"plain").unwrap();
    assert!(remote_call::<alinery_core::repo_service::WireBytes>(
        &state,
        &id,
        RepoOp::ReadAttachmentImage {
            repo: repo.clone().into(),
            slug: slug(),
            name: "notes.txt".into(),
            node_id: None
        }
    )
    .is_err());

    // The artifact tree lists attachments as nodes with a path of their own.
    let tree: Vec<alinery_core::ArtifactTreeNode> = remote_call(
        &state,
        &id,
        RepoOp::ListTaskArtifactTree {
            repo: repo.clone().into(),
            slug: slug(),
        },
    )
    .unwrap();
    let node = tree
        .iter()
        .flat_map(|node| std::iter::once(node).chain(node.children.iter()))
        .find(|node| node.kind == alinery_core::ArtifactTreeNodeKind::Attachment && node.label == "shot.png")
        .unwrap_or_else(|| panic!("{tree:?}"));
    let node_path: String = remote_call(
        &state,
        &id,
        RepoOp::ArtifactNodePath {
            repo: repo.clone().into(),
            slug: slug(),
            node_id: node.id.clone(),
        },
    )
    .unwrap();
    assert!(node_path.ends_with("/attachments/shot.png"), "{node_path}");
    let by_node: alinery_core::repo_service::WireBytes = remote_call(
        &state,
        &id,
        RepoOp::ReadAttachmentImage {
            repo: repo.clone().into(),
            slug: slug(),
            name: String::new(),
            node_id: Some(node.id.clone()),
        },
    )
    .unwrap();
    assert_eq!(by_node.data, png);

    // Copying files from this machine: each goes over on its own, bad ones are reported, URLs are skipped.
    let local = std::env::temp_dir().join(format!("local-note-{}.txt", std::process::id()));
    std::fs::write(&local, "from the Mac\n").unwrap();
    let copied = crate::copy_files_to_remote_attachments(
        &state,
        &id,
        &repo,
        "remote-task",
        &[local.display().to_string(), "/nonexistent/file.bin".into(), "https://example.com/x.png".into(), "  ".into()],
    )
    .unwrap();
    assert_eq!(copied.copied.len(), 1, "{:?}", copied.failures);
    assert!(copied.copied[0].starts_with("local-note-"));
    assert_eq!(copied.failures.len(), 1, "{:?}", copied.failures);
    assert!(copied.failures[0].contains("/nonexistent/file.bin"));
    let _ = std::fs::remove_file(local);

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

    // Restore flips the flag back on the host; an unknown task is refused.
    remote_call::<()>(
        &state,
        &id,
        RepoOp::RestoreTask {
            repo: repo.clone().into(),
            slug: slug(),
        },
    )
    .unwrap();
    let restored: Option<alinery_core::Task> = remote_call(
        &state,
        &id,
        RepoOp::GetTask {
            repo: repo.clone().into(),
            slug: slug(),
        },
    )
    .unwrap();
    assert!(!restored.unwrap().archived);
    assert!(remote_call::<()>(
        &state,
        &id,
        RepoOp::RestoreTask {
            repo: repo.clone().into(),
            slug: "missing".into()
        }
    )
    .is_err());

    // Chat threads: created beside the host's daemon, listed under the repo's key, pinned, given
    // attachments, archived. The terminal made above is a session but not a chat thread.
    let app_config = crate::host_app_config(&state, &id).unwrap();
    let new_thread = |create_worktree: bool| -> alinery_core::task_creation::CreateExecutionSessionReply {
        remote_call(
            &state,
            &id,
            RepoOp::CreateChatThread {
                repo: repo.clone().into(),
                app_config: app_config.clone(),
                model: String::new(),
                create_worktree,
            },
        )
        .unwrap()
    };
    let thread = new_thread(false).session.id;
    let chat_meta = |session_id: &str| {
        remote_call::<crate::SessionMeta>(
            &state,
            &id,
            RepoOp::ChatThreadMeta {
                repo: repo.clone().into(),
                session_id: session_id.into(),
            },
        )
    };
    assert_eq!(chat_meta(&thread).unwrap().id, thread);
    assert!(chat_meta(&terminal).is_err(), "a terminal session is not a chat thread");
    assert!(chat_meta("../x").is_err());
    assert_eq!(crate::open_chat_repos_in(std::slice::from_ref(&key), &state), [std::path::PathBuf::from(&key)]);
    let listed = crate::chat::chat_threads_across(&state, &[std::path::PathBuf::from(&key)], false).unwrap();
    assert_eq!(listed.len(), 1, "{}", listed.len());
    assert_eq!(listed[0].repo_path, key, "the rail addresses the repo by its key, not the host path");
    assert!(listed[0].checkout && !listed[0].session.pinned);
    remote_call::<()>(
        &state,
        &id,
        RepoOp::SetChatPinned {
            repo: repo.clone().into(),
            session_id: thread.clone(),
            pinned: true,
        },
    )
    .unwrap();
    assert!(chat_meta(&thread).unwrap().pinned);
    let branch: crate::ChatBranch = remote_call(
        &state,
        &id,
        RepoOp::ChatBranchLabel {
            repo: repo.clone().into(),
            session_id: thread.clone(),
        },
    )
    .unwrap();
    assert!(branch.checkout);
    assert_eq!(
        remote_call::<Option<String>>(
            &state,
            &id,
            RepoOp::ChatThreadName {
                repo: repo.clone().into(),
                session_id: thread.clone()
            }
        )
        .unwrap(),
        None
    );

    // The thread's attachments live beside its session on the host and come back byte for byte.
    let put = |name: &str, data: &[u8]| {
        remote_call::<String>(
            &state,
            &id,
            RepoOp::WriteChatThreadAttachment {
                repo: repo.clone().into(),
                session_id: thread.clone(),
                file_name: name.into(),
                data: data.to_vec(),
            },
        )
    };
    assert_eq!(put("shot.png", &png).unwrap(), "shot.png");
    assert!(put("../shot.png", &png).is_err());
    let back: crate::ChatImage = remote_call(
        &state,
        &id,
        RepoOp::ReadChatThreadImage {
            repo: repo.clone().into(),
            session_id: thread.clone(),
            name: "shot.png".into(),
        },
    )
    .unwrap();
    assert_eq!(alinery_core::rpc_chunk::decode_base64(&back.data).unwrap(), png);
    assert!(remote_call::<crate::ChatImage>(
        &state,
        &id,
        RepoOp::ReadChatThreadImage {
            repo: repo.clone().into(),
            session_id: thread.clone(),
            name: "missing.png".into()
        }
    )
    .is_err());
    let local = std::env::temp_dir().join(format!("chat-note-{}.txt", std::process::id()));
    std::fs::write(&local, "chat note\n").unwrap();
    let sent = crate::send_files_to_host(&[local.display().to_string()], |file_name, data| put(&file_name, &data));
    assert_eq!(sent.copied, ["chat-note-".to_string() + &std::process::id().to_string() + ".txt"], "{:?}", sent.failures);
    let _ = std::fs::remove_file(local);

    // A thread cannot be continued without a journal; archiving stops it and hides it from the rail.
    assert!(remote_call::<crate::SessionMeta>(
        &state,
        &id,
        RepoOp::ResumeChatThread {
            repo: repo.clone().into(),
            app_config: app_config.clone(),
            session_id: thread.clone()
        }
    )
    .is_err());
    remote_call::<()>(
        &state,
        &id,
        RepoOp::ArchiveChatThread {
            repo: repo.clone().into(),
            app_config: app_config.clone(),
            session_id: thread.clone(),
            remove_worktree: false,
        },
    )
    .unwrap();
    assert!(crate::chat::chat_threads_across(&state, &[std::path::PathBuf::from(&key)], false).unwrap().is_empty());
    let all = crate::chat::chat_threads_across(&state, &[std::path::PathBuf::from(&key)], true).unwrap();
    assert!(all.len() == 1 && all[0].session.archived);

    // The checkout is never deleted as if it were a thread's worktree.
    let other = new_thread(false).session.id;
    assert!(remote_call::<()>(
        &state,
        &id,
        RepoOp::ArchiveChatThread {
            repo: repo.clone().into(),
            app_config: app_config.clone(),
            session_id: other,
            remove_worktree: true
        }
    )
    .is_err());

    // Duplicating a task: the host builds the create request from its own files, identical to what a
    // local repo would build. A pre-v2 task cannot be copied.
    assert!(remote_call::<alinery_core::task_creation::CreateTaskRequest>(
        &state,
        &id,
        RepoOp::DuplicateTaskPackage {
            repo: repo.clone().into(),
            source_slug: slug()
        }
    )
    .is_err());
    let scratch = std::env::temp_dir().join(format!("remote-dup-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).unwrap();
    let source = super::task::retained_duplicate_fixture(&scratch);
    let source_dir = scratch.join(".alinery/tasks").join(&source.slug);
    let mut pending = vec![source_dir.clone()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            let relative = path.strip_prefix(&source_dir).unwrap().display().to_string();
            session
                .channel
                .call(
                    RepoOp::WriteFile {
                        path: format!("{repo}/.alinery/tasks/{}/{relative}", source.slug).into(),
                        contents: std::fs::read_to_string(&path).unwrap(),
                    },
                    std::time::Duration::from_secs(30),
                )
                .unwrap();
        }
    }
    let package: alinery_core::task_creation::CreateTaskRequest = remote_call(
        &state,
        &id,
        RepoOp::DuplicateTaskPackage {
            repo: repo.clone().into(),
            source_slug: source.slug.clone(),
        },
    )
    .unwrap();
    assert_eq!(package.name, "Original D+1");
    assert_eq!(package.original_ticket.as_deref(), Some("# Edited original\nKeep exact bytes.\n"));
    let local = crate::duplicate_task_package(&scratch, &source.slug).unwrap();
    assert_eq!(serde_json::to_value(&package).unwrap(), serde_json::to_value(&local).unwrap());
    let _ = std::fs::remove_dir_all(&scratch);

    // Repository settings: the override layer lives in the host's config.toml, the global layer here.
    let target = crate::RepoRef::parse(&key).unwrap();
    let app_config = crate::app_config_path(&handle).unwrap();
    assert_eq!(crate::read_overrides(&state, &target).unwrap(), alinery_core::RepoOverrides::default());
    let mut overrides = alinery_core::RepoOverrides::default();
    overrides.defaults.model = Some("host-model".into());
    overrides.defaults.harness = Some("omp".into());
    crate::write_overrides(&app_config, &state, &target, &overrides).unwrap();
    assert_eq!(crate::read_overrides(&state, &target).unwrap(), overrides);
    let scoped = crate::scoped_for(&app_config, &state, &target).unwrap();
    assert_eq!(scoped.overrides, overrides);
    alinery_core::clear_repo_override(&mut overrides, "defaults.model").unwrap();
    crate::write_overrides(&app_config, &state, &target, &overrides).unwrap();
    assert_eq!(crate::read_overrides(&state, &target).unwrap(), alinery_core::RepoOverrides::default());

    // The sessions list, list statuses, artifact readiness, notification clearing and task activity
    // all read the host's files; live states come through the forward.
    let rows = crate::list_session_items_with_repo_resolver(&state, false, true, Vec::new(), Some(&key), crate::RepoRef::parse).unwrap();
    let s1 = rows.iter().find(|row| row.session.meta.id == "s1").unwrap_or_else(|| panic!("{}", rows.len()));
    assert_eq!((s1.repo_path.as_str(), s1.task_slug.as_str()), (key.as_str(), "remote-task"));
    assert!(
        crate::list_session_items_with_repo_resolver(&state, false, false, Vec::new(), Some(&key), crate::RepoRef::parse)
            .unwrap()
            .iter()
            .all(|row| row.session.meta.id != "s1"),
        "archived sessions are left out unless asked for"
    );
    let status_ref = |id: &str| crate::SessionStatusRef {
        repo_path: key.clone(),
        task_slug: slug(),
        id: id.into(),
    };
    let statuses = crate::remote_session_statuses(&state, &[status_ref("s1"), status_ref("missing")]);
    assert_eq!(statuses.len(), 2);
    assert!(statuses.contains_key(&crate::session_list_status_key(&key, "remote-task", "s1")));

    let ready = |sid: &str| {
        remote_call::<bool>(
            &state,
            &id,
            RepoOp::SessionArtifactReady {
                repo: repo.clone().into(),
                slug: slug(),
                session_id: sid.into(),
            },
        )
        .unwrap()
    };
    session
        .channel
        .call(
            RepoOp::WriteFile {
                path: format!("{repo}/.alinery/tasks/remote-task/sessions/s-art.meta.json").into(),
                contents: serde_json::to_string(&crate::SessionMeta {
                    id: "s-art".into(),
                    artifact: "01-out.md".into(),
                    ..Default::default()
                })
                .unwrap(),
            },
            std::time::Duration::from_secs(30),
        )
        .unwrap();
    assert!(!ready("s-art"), "no artifact yet");
    session
        .channel
        .call(
            RepoOp::WriteFile {
                path: format!("{repo}/.alinery/tasks/remote-task/artifacts/01-out.md").into(),
                contents: "# Out\n".into(),
            },
            std::time::Duration::from_secs(30),
        )
        .unwrap();
    assert!(ready("s-art"));
    assert!(!ready("missing"));

    let clear = |sid: &str| {
        remote_call::<()>(
            &state,
            &id,
            RepoOp::ClearSessionNotifications {
                repo: repo.clone().into(),
                refs: vec![crate::SessionNotificationClearRef {
                    repo_path: key.clone(),
                    task_slug: slug(),
                    id: sid.into(),
                    notification_suppression: None,
                }],
            },
        )
    };
    clear("s-art").unwrap();
    assert!(clear("../s-art").is_err());

    let activity = crate::remote_task_activity(
        &state,
        &[crate::TaskActivityRef {
            repo_path: key.clone(),
            task_slug: slug(),
        }],
    );
    assert!(
        activity.contains_key(&crate::task_activity_key(&key, "remote-task")),
        "{:?}",
        activity.keys().collect::<Vec<_>>()
    );

    // Task drafts: saved, re-saved under the same slug, given attachments, and deleted on the host.
    let draft_op = |draft_slug: &str, name: &str, attachments: Option<crate::DraftAttachments>| RepoOp::WriteDraft {
        repo: repo.clone().into(),
        draft_slug: draft_slug.into(),
        task_slug: String::new(),
        name: name.into(),
        description: "Write the thing".into(),
        evidence: String::new(),
        linear_id: String::new(),
        github_issue: String::new(),
        playbook: alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Repo,
            key: "one-shot".into(),
        },
        harness: "omp".into(),
        model: "m".into(),
        auto_advance: None,
        step_models: None,
        max_live_sessions: 3,
        branch_name: "draft-branch".into(),
        worktree_name: "draft-tree".into(),
        draft_base_ref: None,
        draft_attachments: attachments,
    };
    let draft: alinery_core::Task = remote_call(&state, &id, draft_op("", "My draft", None)).unwrap();
    assert!(draft.draft && draft.name == "My draft", "{draft:?}");
    let again: alinery_core::Task = remote_call(&state, &id, draft_op(&draft.slug, "My draft", None)).unwrap();
    assert_eq!((again.slug.as_str(), again.created), (draft.slug.as_str(), draft.created), "autosave reuses the draft");
    let attachments = crate::DraftAttachments {
        entries: vec!["/tmp/spec.pdf".into()],
        images: vec![crate::DraftImage {
            name: "shot.png".into(),
            bytes: png.clone(),
            mime_type: "image/png".into(),
        }],
    };
    remote_call::<alinery_core::Task>(&state, &id, draft_op(&draft.slug, "My draft", Some(attachments.clone()))).unwrap();
    let read_back: crate::DraftAttachments = remote_call(
        &state,
        &id,
        RepoOp::ReadDraftAttachments {
            repo: repo.clone().into(),
            slug: draft.slug.clone(),
        },
    )
    .unwrap();
    assert_eq!(read_back, attachments, "non-UTF-8 image bytes survive");
    assert!(
        remote_call::<alinery_core::Task>(&state, &id, draft_op(&draft.slug, "", None)).is_err(),
        "an empty name is refused"
    );
    assert!(
        remote_call::<()>(
            &state,
            &id,
            RepoOp::DeleteDraft {
                repo: repo.clone().into(),
                slug: slug()
            }
        )
        .is_err(),
        "a real task is not a draft"
    );
    remote_call::<()>(
        &state,
        &id,
        RepoOp::DeleteDraft {
            repo: repo.clone().into(),
            slug: draft.slug.clone(),
        },
    )
    .unwrap();
    let gone: Option<alinery_core::Task> = remote_call(
        &state,
        &id,
        RepoOp::GetTask {
            repo: repo.clone().into(),
            slug: draft.slug.clone(),
        },
    )
    .unwrap();
    assert!(gone.is_none());

    // Repo-scope playbooks: the library code runs on a scratch copy of the host's files and only
    // what changed goes back, with host paths in what the UI sees.
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
        let catalog =
            |library_at: Option<crate::RepoRef>| crate::with_library_at(&app_config, &state, library_at, |lib| lib.rehome(library::load_playbook_catalog(&lib.roots))).unwrap();
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
                .map(|saved| lib.rehome(saved))
            })
        };

        assert!(tree().is_empty());
        let empty = catalog(remote.clone());
        assert!(empty.candidates.iter().any(|candidate| candidate.source.reference.scope == PlaybookScope::Bundled));
        assert!(!empty.candidates.iter().any(|candidate| candidate.source.reference.scope == PlaybookScope::Repo));

        let saved = save(false, source).unwrap().unwrap();
        let host_file = format!("{repo}/.alinery/playbooks/one-shot/playbook.md");
        assert_eq!(saved.source.path.as_deref(), Some(Path::new(&host_file)), "the scratch path is not shown");
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
        assert_eq!(candidate.source.path.as_deref(), Some(Path::new(&host_file)));
        assert!(candidate.title.is_some() && candidate.modified_at_ms.is_some());
        let read = crate::with_library_at(&app_config, &state, remote.clone(), |lib| lib.rehome(library::resolve_playbook(&lib.roots, &reference)))
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

    // The file operations that used to read this machine's disk now read the host's.
    {
        let op_slug = |slug: &str| slug.to_string();
        // `original` is the retained v2 task the duplicate block wrote to the host.
        let names: Vec<String> = remote_call(
            &state,
            &id,
            RepoOp::ListArtifacts {
                repo: repo.clone().into(),
                slug: slug(),
            },
        )
        .unwrap();
        assert!(names.contains(&"01-out.md".to_string()), "{names:?}");
        let comment_path: String = remote_call(
            &state,
            &id,
            RepoOp::ArtifactCommentMarkdownPath {
                repo: repo.clone().into(),
                slug: slug(),
                artifact: "01-out.md".into(),
            },
        )
        .unwrap();
        assert!(comment_path.starts_with(&repo) && comment_path.ends_with(".md"), "{comment_path}");

        // The notification text uses the task's current name on the host.
        let attention = |slug: &str, reason: &str| {
            remote_call::<String>(
                &state,
                &id,
                RepoOp::SessionAttentionBody {
                    repo: repo.clone().into(),
                    slug: Some(slug.into()),
                    reason: reason.into(),
                },
            )
        };
        assert_eq!(attention("remote-task", "waiting_for_input").unwrap(), "Renamed remote — waiting for your input");
        assert_eq!(attention("no-such-task", "idle").unwrap(), "no-such-task — idle, needs you");
        assert!(attention("remote-task", "on_fire").is_err());

        // Auto-approve is a flag in the task and its execution state, so it needs a v2 task.
        let auto = |slug: &str, enabled: bool| {
            remote_call::<alinery_core::Task>(
                &state,
                &id,
                RepoOp::SetAutoApproveAll {
                    repo: repo.clone().into(),
                    slug: op_slug(slug),
                    enabled,
                },
            )
        };
        assert!(auto("remote-task", true).unwrap_err().contains("pre-v2"));
        assert!(auto("original", true).unwrap().auto_approve_all);
        let stored: Option<alinery_core::Task> = remote_call(
            &state,
            &id,
            RepoOp::GetTask {
                repo: repo.clone().into(),
                slug: "original".into(),
            },
        )
        .unwrap();
        assert!(stored.unwrap().auto_approve_all);
        assert!(!auto("original", false).unwrap().auto_approve_all);

        // Related tasks are other tasks on the host: named from their own files, never a path from
        // another machine.
        let relate = |related: Vec<alinery_core::RelatedTaskRef>| {
            remote_call::<alinery_core::Task>(
                &state,
                &id,
                RepoOp::SetRelatedTasks {
                    repo: repo.clone().into(),
                    slug: slug(),
                    related,
                },
            )
        };
        let tag = |repo_path: &str, slug: &str| alinery_core::RelatedTaskRef {
            repo_path: repo_path.into(),
            slug: slug.into(),
            name: String::new(),
        };
        let related = relate(vec![tag(&repo, "original")]).unwrap();
        assert_eq!((related.related_tasks[0].slug.as_str(), related.related_tasks[0].name.as_str()), ("original", "Original"));
        for foreign in [format!("alinery+ssh://{id}{repo}"), "/Users/someone/on-a-mac".to_string()] {
            let refused = relate(vec![tag(&repo, "original"), tag(&foreign, "original")]).unwrap_err();
            assert!(refused.contains("same machine"), "{foreign}: {refused}");
        }
        assert!(relate(Vec::new()).unwrap().related_tasks.is_empty());

        // A review handoff copies an artifact between tasks on the host and starts the target session
        // through the host's own daemon (here not started: no agent is wanted in a test).
        let handoff = |start: bool| RepoOp::SendReviewHandoff {
            source_repo: repo.clone().into(),
            target_repo: repo.clone().into(),
            app_config: crate::host_app_config(&state, &id).unwrap(),
            request: alinery_core::ReviewHandoffRequest {
                source_slug: slug(),
                source_session: "s1".into(),
                source_artifact: "01-out.md".into(),
                target_slug: "original".into(),
                target_phase: "implementation".into(),
                harness: "omp".into(),
                model: String::new(),
                prompt_extra: String::new(),
                start,
            },
        };
        let sent: alinery_core::ReviewHandoffResult = remote_call(&state, &id, handoff(false)).unwrap();
        assert_eq!(sent.target_record.target_task, "original");
        assert_eq!(sent.target_session.phase, "implementation");
        let target_artifacts: Vec<String> = remote_call(
            &state,
            &id,
            RepoOp::ListArtifacts {
                repo: repo.clone().into(),
                slug: "original".into(),
            },
        )
        .unwrap();
        assert!(target_artifacts.contains(&sent.target_artifact), "{target_artifacts:?}");
        let mut same = handoff(false);
        if let RepoOp::SendReviewHandoff { request, .. } = &mut same {
            request.target_slug = slug();
        }
        assert!(
            remote_call::<alinery_core::ReviewHandoffResult>(&state, &id, same).is_err(),
            "a task cannot hand off to itself"
        );
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

/// Git on the host: commit, push with the host's credentials, the compare URL and PR link, worktree
/// removal, branch discovery, and the sub-task requests, all against a real repo with an origin.
#[test]
fn live_git_actions_run_on_the_host() {
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
    let slug = || "feat".to_string();
    let get_task = || -> alinery_core::Task { serde_json::from_value(call(RepoOp::GetTask { repo: repo_path(), slug: slug() }).unwrap()).unwrap() };

    let branches: crate::TaskSourceBranches = serde_json::from_value(
        call(RepoOp::TaskSourceBranches {
            repo: repo_path(),
            selected_base_ref: Some("refs/heads/feat".into()),
        })
        .unwrap(),
    )
    .unwrap();
    let names: Vec<_> = branches.branches.iter().map(|branch| branch.name.as_str()).collect();
    assert_eq!(names, ["feat", "main"]);
    assert!(branches.selected.is_some_and(|selected| selected.available));

    // Commit: the host stages and commits in the task's worktree.
    call(RepoOp::WriteFile {
        path: format!("{worktree}/hello.txt").into(),
        contents: "hello\n".into(),
    })
    .unwrap();
    assert!(
        call(RepoOp::CommitWorktree {
            repo: repo_path(),
            slug: slug(),
            message: "   ".into()
        })
        .is_err(),
        "an empty message is refused"
    );
    call(RepoOp::CommitWorktree {
        repo: repo_path(),
        slug: slug(),
        message: "add hello".into(),
    })
    .unwrap();
    assert!(sh(&format!("git -C '{worktree}' log --oneline -1")).contains("add hello"));
    assert!(
        call(RepoOp::CommitWorktree {
            repo: repo_path(),
            slug: slug(),
            message: "again".into()
        })
        .is_err(),
        "nothing left to commit"
    );

    // Push: lands in the origin, and the compare URL is stored on the task.
    let url: String = serde_json::from_value(call(RepoOp::PushAndCompareUrl { repo: repo_path(), slug: slug() }).unwrap()).unwrap();
    assert_eq!(url, "https://github.com/acme/widgets/compare/main...feat?expand=1");
    assert!(sh(&format!("git -C '{origin}' rev-parse --verify refs/heads/feat")).trim().len() >= 40);
    assert_eq!(get_task().pr_url, url);

    // PR link: a real link replaces the compare URL and survives the next push.
    let pr = "https://github.com/acme/widgets/pull/7";
    call(RepoOp::SetPrUrl {
        repo: repo_path(),
        slug: slug(),
        url: format!("  {pr}  "),
    })
    .unwrap();
    assert_eq!(get_task().pr_url, pr);
    call(RepoOp::PushAndCompareUrl { repo: repo_path(), slug: slug() }).unwrap();
    assert_eq!(get_task().pr_url, pr, "pushing must not replace a real PR link");
    let inputs: alinery_core::git_actions::PullRequestInputs = serde_json::from_value(call(RepoOp::TaskPullRequestInputs { repo: repo_path(), slug: slug() }).unwrap()).unwrap();
    assert_eq!(
        (inputs.pr_url.as_str(), inputs.branch.as_str(), inputs.origin_url.as_deref()),
        (pr, "feat", Some("https://github.com/acme/widgets.git"))
    );
    // The origin URL is what a bare `#123` GitHub import resolves against.
    let origin_url: Option<String> = serde_json::from_value(call(RepoOp::GitOriginUrl { repo: repo_path() }).unwrap()).unwrap();
    assert_eq!(origin_url.as_deref(), Some("https://github.com/acme/widgets.git"));
    assert!(call(RepoOp::TaskPullRequestInputs {
        repo: repo_path(),
        slug: "../feat".into()
    })
    .is_err());
    let record = |previous: &str, url: &str| {
        call(RepoOp::RecordDiscoveredPullRequest {
            repo: repo_path(),
            slug: slug(),
            branch: "feat".into(),
            previous_url: previous.into(),
            url: url.into(),
        })
    };
    assert!(
        record("https://github.com/acme/widgets/pull/1", "https://github.com/acme/widgets/pull/9").is_err(),
        "a changed link is refused"
    );
    assert!(record(pr, "https://example.com/not-a-pr").is_err());
    record(pr, "https://github.com/acme/widgets/pull/9").unwrap();
    assert_eq!(get_task().pr_url, "https://github.com/acme/widgets/pull/9");

    // Sub-tasks: the manager request is built from the host's files.
    let request: alinery_core::task_creation::CreateExecutionSessionRequest = serde_json::from_value(
        call(RepoOp::SubtaskManagerRequest {
            repo: repo_path(),
            slug: slug(),
            recover: false,
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(request.task_slug, "feat");
    assert!(
        call(RepoOp::SubtaskManagerRequest {
            repo: repo_path(),
            slug: slug(),
            recover: true
        })
        .is_err(),
        "nothing to recover without an active sub-task"
    );
    assert!(call(RepoOp::SubtaskDiscardSessions {
        repo: repo_path(),
        slug: slug(),
        manager_session_id: "nope".into()
    })
    .is_err());
    assert!(call(RepoOp::DiscardSubtask {
        repo: repo_path(),
        slug: slug(),
        manager_session_id: "nope".into()
    })
    .is_err());

    // Remove the worktree: the directory goes, the task forgets it, the branch stays.
    call(RepoOp::RemoveWorktree { repo: repo_path(), slug: slug() }).unwrap();
    assert!(sh(&format!("test -e '{worktree}' && echo present || echo gone")).contains("gone"));
    assert_eq!(get_task().worktree, "");
    assert!(sh(&format!("git -C '{repo}' rev-parse --verify refs/heads/feat")).trim().len() >= 40);
    assert!(call(RepoOp::RemoveWorktree { repo: repo_path(), slug: slug() }).is_err(), "already removed");
    assert!(
        call(RepoOp::PushAndCompareUrl { repo: repo_path(), slug: slug() }).is_err(),
        "nothing to push without a worktree"
    );
    sh(&format!("rm -rf '{repo}' '{origin}'"));
    session.conn.exit_master();
}

#[test]
fn approval_secrets_are_kept_per_repo_in_an_owner_only_file() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("alinery-secrets-{}", uuid::Uuid::new_v4()));
    let app_config = dir.join("app.toml");
    let secrets = remote_secrets_dir(&app_config, "box-a1b2c3").unwrap();
    assert!(remote_ui_secret(&app_config, "box-a1b2c3", "/srv/a").unwrap_err().contains("not started by this Mac"));
    store_ui_secret(&secrets, "/srv/a", "first").unwrap();
    store_ui_secret(&secrets, "/srv/b", "other").unwrap();
    store_ui_secret(&secrets, "/srv/a", "second").unwrap();
    assert_eq!(
        remote_ui_secret(&app_config, "box-a1b2c3", "/srv/a").unwrap(),
        "second",
        "a restarted daemon replaces its secret"
    );
    assert_eq!(remote_ui_secret(&app_config, "box-a1b2c3", "/srv/b").unwrap(), "other");
    assert!(remote_ui_secret(&app_config, "another-host", "/srv/a").is_err(), "secrets do not cross hosts");
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
    let rendered = render_remote_app_toml(&local, &["/srv/r".to_string()]).unwrap();
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
    let mut local = crate::AppConfig::default();
    local.settings_version = 7;
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

    let rendered = render_remote_app_toml(&local, &["/srv/r".to_string()]).unwrap();
    for private in [
        "ghp_mac_only_token",
        "install-id-mac",
        "telemetry.example",
        "/Users/me",
        "harness-secret",
        "CUSTOM_API_KEY",
        "alinery/favorite",
    ] {
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
    assert_eq!(host.experiments.grok_api_key, "xai-shared-key", "provider credentials ride with the others");
    assert!(host.github.token.is_empty());
    assert!(
        !host.telemetry.enabled && host.telemetry.install_id.is_empty(),
        "the host records nothing under this install"
    );
    assert!(!host.power.keep_awake);
    assert!(!host.harnesses.harness.iter().any(|row| row.key == "custom"), "harness rows name this Mac's paths");
    assert_eq!(toml::from_str::<crate::AppConfig>(&rendered).unwrap().settings_version, 7);
    let _ = std::fs::remove_dir_all(dir);
}
