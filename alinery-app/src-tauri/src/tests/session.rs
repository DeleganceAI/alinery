//! Tests for session.rs — session CRUD, status projection, history, the root drawer terminal
//!
//! `use super::*` reaches the shared imports and fixtures in tests/mod.rs.
use super::*;

#[test]
fn manual_rename_uses_owned_explicit_repo_without_daemon() {
    use tauri::Manager;
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo_a = init_git_test_repo("name-command-a");
    let repo_b = init_git_test_repo("name-command-b");
    for repo in [&repo_a, &repo_b] {
        write_activity_task(repo, "task", "implementation", true);
        fs::write(
            session_meta_path(repo, "task", "same"),
            serde_json::to_vec(&SessionMeta {
                id: "same".into(),
                archived: true,
                ..Default::default()
            })
            .unwrap(),
        )
        .unwrap();
        let mut task = read_task(repo, "task").unwrap();
        task.archived = true;
        write_task(repo, &task).unwrap();
    }
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!("test.alinery.names.{}", uuid::Uuid::new_v4());
    let app = tauri::test::mock_builder().manage(AppState::default()).build(context).unwrap();
    let config_path = crate::app_config_path(app.handle()).unwrap();
    crate::write_app_config_at(
        &config_path,
        &AppConfig {
            known_repos: vec![repo_a.display().to_string(), repo_b.display().to_string()],
            ..Default::default()
        },
    )
    .unwrap();
    set_active_repo_global(Some(repo_b.clone())).unwrap();
    let saved = crate::rename_session(
        app.handle().clone(),
        app.state(),
        repo_a.display().to_string(),
        "task".into(),
        "same".into(),
        "  Offline history  ".into(),
    )
    .unwrap();
    assert_eq!(saved.name, "Offline history");
    assert_eq!(
        crate::get_session_display(app.handle().clone(), repo_a.display().to_string(), "task".into(), "same".into())
            .unwrap()
            .session
            .name
            .as_deref(),
        Some("Offline history")
    );
    assert_eq!(alinery_core::read_session_name(&repo_b, "task", "same").unwrap(), None);
    assert!(crate::rename_session(app.handle().clone(), app.state(), "/unknown".into(), "task".into(), "same".into(), "No".into()).is_err());
    let owner = AppState::default();
    assert!(owner.claim_repo(&repo_b));
    assert!(crate::rename_session(app.handle().clone(), app.state(), repo_b.display().to_string(), "task".into(), "same".into(), "No".into()).is_err());
    assert!(!alinery_core::alineryd_socket_path(&repo_a, None).exists());
    assert!(!alinery_core::alineryd_socket_path(&repo_b, None).exists());
    set_active_repo_global(None).unwrap();
    drop(app);
    drop(owner);
    let _ = fs::remove_dir_all(config_path.parent().unwrap());
    let _ = fs::remove_dir_all(repo_a);
    let _ = fs::remove_dir_all(repo_b);
}

#[test]
fn display_lists_keep_missing_and_corrupt_names_visible() {
    let repo = activity_repo("session-display");
    write_task(
        &repo,
        &Task {
            slug: "task".into(),
            name: "Task".into(),
            ..Default::default()
        },
    )
    .unwrap();
    write_task(
        &repo,
        &Task {
            slug: "child".into(),
            name: "Child".into(),
            archived: true,
            ..Default::default()
        },
    )
    .unwrap();
    fs::create_dir_all(sessions_dir(&repo, "task")).unwrap();
    let mut child = read_task(&repo, "child").unwrap();
    child.name = "Current child name".into();
    write_task(&repo, &child).unwrap();
    for id in ["healthy", "missing", "corrupt", "unsafe"] {
        let meta = SessionMeta {
            id: id.into(),
            subtask_slug: "child".into(),
            ..Default::default()
        };
        fs::write(session_meta_path(&repo, "task", id), serde_json::to_vec(&meta).unwrap()).unwrap();
    }
    alinery_core::set_session_name(&repo, "task", "healthy", "Useful work", alinery_core::SessionNameSource::User).unwrap();
    fs::write(alinery_core::session_name_path(&repo, "task", "corrupt"), "{").unwrap();
    let sentinel = repo.join("sentinel");
    fs::write(&sentinel, "private").unwrap();
    std::os::unix::fs::symlink(&sentinel, alinery_core::session_name_path(&repo, "task", "unsafe")).unwrap();
    let rows = session_list_items_for_repo(&repo, &repo.display().to_string(), true).unwrap();
    assert_eq!(rows.len(), 4);
    for row in rows {
        let display = crate::session_display_context_for_repo(&repo, "task", &row.session.meta.id).unwrap();
        assert_eq!(display.subtask_name.as_deref(), Some("Current child name"));
        assert_eq!(row.subtask_name, display.subtask_name);
        assert_eq!(display.session.name, row.session.name);
        match row.session.meta.id.as_str() {
            "healthy" => assert_eq!(row.session.name.as_deref(), Some("Useful work")),
            "missing" => assert!(row.session.name.is_none() && row.session.name_error.is_none()),
            _ => assert!(row.session.name.is_none() && row.session.name_error.as_ref().is_some_and(|error| error.len() < 512)),
        }
    }
    fs::remove_dir_all(task_dir(&repo, "child")).unwrap();
    assert!(crate::session_display_context_for_repo(&repo, "task", "healthy").unwrap().subtask_name.is_none());
    assert_eq!(crate::list_sessions_for_repo(&repo, "task").unwrap().len(), 4);
    assert_eq!(alinery_core::all_session_meta_paths(&repo).len(), 4);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn durable_session_discovery_preserves_offline_history_without_live_state() {
    let repo = activity_repo("durable-sessions");
    let task = write_retained_discovery_task(&repo, "offline", "foreign", false);
    let meta = SessionMeta {
        id: "saved-session".into(),
        phase: "implementation".into(),
        execution_id: "execution-1".into(),
        daemon_namespace: "foreign".into(),
        started_at: Some(10),
        ..Default::default()
    };
    let meta_path = session_meta_path(&repo, &task.slug, &meta.id);
    let meta_bytes = serde_json::to_vec(&meta).unwrap();
    fs::write(&meta_path, &meta_bytes).unwrap();
    let history = b"saved output while the owner was running\r\n";
    fs::write(alinery_core::session_scrollback_path(&repo, &task.slug, &meta.id), history).unwrap();
    let state_path = alinery_core::execution::execution_state_path(&repo, &task.slug).unwrap();
    let state_before = fs::read(&state_path).unwrap();

    let items = session_list_items_for_repo(&repo, &repo.display().to_string(), false).unwrap();
    assert_eq!(items.iter().map(|item| item.session.id.as_str()).collect::<Vec<_>>(), ["saved-session"]);
    assert_eq!(items[0].playbook_title, "One-shot");
    assert_eq!(items[0].step_title, "Implement and Verify");
    assert!(items[0].is_playbook_step);
    assert_eq!(alinery_core::read_session_history(&repo, &task.slug, &meta.id, Some(0), Some(1024)).unwrap().data, history);

    let reference = crate::SessionStatusRef {
        repo_path: repo.display().to_string(),
        task_slug: task.slug.clone(),
        id: meta.id.clone(),
    };
    let observations = crate::session_list_statuses_with_repo_resolver(std::slice::from_ref(&reference), |_| Ok(repo.clone()));
    let key = crate::session_list_status_key(&reference.repo_path, &reference.task_slug, &reference.id);
    let observation = observations.get(&key).unwrap();
    assert_eq!(observation.lifecycle, crate::LifecycleState::Orphaned);
    assert!(observation.state.is_none());
    assert!(observation.transport.is_none());
    assert_eq!(items[0].session.ended_at, None);
    assert_eq!(items[0].session.exit_code, None);
    assert!(crate::task_daemon_for(&repo, &task.slug, &repo.join("app.toml")).is_err());
    assert_eq!(fs::read(&meta_path).unwrap(), meta_bytes);
    assert_eq!(fs::read(&state_path).unwrap(), state_before);
    assert!(!alinery_core::alineryd_socket_path(&repo, Some("foreign")).exists());
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn session_stream_coalesces_consecutive_reads() {
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;
    use std::thread;

    let (reader, mut writer) = UnixStream::pair().unwrap();
    let payload = vec![b'x'; SESSION_CHANNEL_BATCH_BYTES];
    let expected = payload.clone();
    let writer_thread = thread::spawn(move || {
        for chunk in payload.chunks(256) {
            writer.write_all(chunk).unwrap();
        }
        writer.shutdown(Shutdown::Write).unwrap();
    });

    let mut batches = Vec::new();
    pump_session_stream(reader, |batch| {
        batches.push(batch);
        true
    });
    writer_thread.join().unwrap();

    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0], expected);
}

#[test]
fn session_stream_frame_forces_binary_fetch_for_short_payloads() {
    let payload = b"visible terminal bytes".to_vec();
    let framed = frame_session_channel_bytes(payload.clone());

    assert_eq!(framed.len(), TAURI_RAW_FETCH_MIN_BYTES);
    assert_eq!(u32::from_le_bytes(framed[..4].try_into().unwrap()) as usize, payload.len());
    assert_eq!(&framed[4..4 + payload.len()], payload);
    assert!(framed[4 + payload.len()..].iter().all(|byte| *byte == 0));
}

#[test]
fn session_list_items_skip_archived_and_sort_newest_first() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-session-list-{n}"));
    fs::create_dir_all(repo.join(".alinery/tasks/alpha/sessions")).unwrap();
    fs::create_dir_all(repo.join(".alinery/tasks/archived/sessions")).unwrap();

    write_task(
        &repo,
        &Task {
            name: "Alpha".into(),
            slug: "alpha".into(),
            requested_slug: String::new(),
            branch: "alpha".into(),
            worktree: "/wt-alpha".into(),
            has_worktree: true,
            created: 1,
            archived: false,
            pr_url: String::new(),
            linear_id: String::new(),
            github_issue: String::new(),
            playbook: default_playbook_key(),
            auto_advance: vec![],
            draft: false,
            telemetry_id: String::new(),
            parent_task: String::new(),
            active_subtask: String::new(),
            subtask_outcome: String::new(),
            related_tasks: Vec::new(),
            ..Default::default()
        },
    )
    .unwrap();
    write_task(
        &repo,
        &Task {
            name: "Archived".into(),
            slug: "archived".into(),
            requested_slug: String::new(),
            branch: "archived".into(),
            worktree: "/wt-archived".into(),
            has_worktree: true,
            created: 2,
            archived: true,
            pr_url: String::new(),
            linear_id: String::new(),
            github_issue: String::new(),
            playbook: default_playbook_key(),
            auto_advance: vec![],
            draft: false,
            telemetry_id: String::new(),
            parent_task: String::new(),
            active_subtask: String::new(),
            subtask_outcome: String::new(),
            related_tasks: Vec::new(),
            ..Default::default()
        },
    )
    .unwrap();

    for (slug, meta) in [
        (
            "alpha",
            SessionMeta {
                id: "alpha-old".into(),
                worktree: "/wt-alpha".into(),
                created: 10,
                archived: false,
                phase: "research".into(),
                harness: "claude".into(),
                model: String::new(),
                playbook: default_playbook_key(),
                ..Default::default()
            },
        ),
        (
            "alpha",
            SessionMeta {
                id: "alpha-new".into(),
                worktree: "/wt-alpha".into(),
                created: 20,
                archived: false,
                phase: "design".into(),
                harness: "claude".into(),
                model: String::new(),
                playbook: default_playbook_key(),
                ..Default::default()
            },
        ),
        (
            "alpha",
            SessionMeta {
                id: "alpha-archived".into(),
                worktree: "/wt-alpha".into(),
                created: 30,
                archived: true,
                phase: "implement".into(),
                harness: "claude".into(),
                model: String::new(),
                playbook: default_playbook_key(),
                ..Default::default()
            },
        ),
        (
            "archived",
            SessionMeta {
                id: "archived-task-session".into(),
                worktree: "/wt-archived".into(),
                created: 40,
                archived: false,
                phase: "review".into(),
                harness: "claude".into(),
                model: String::new(),
                playbook: default_playbook_key(),
                ..Default::default()
            },
        ),
    ] {
        fs::write(session_meta_path(&repo, slug, &meta.id), serde_json::to_string(&meta).unwrap()).unwrap();
    }
    fs::create_dir_all(root_sessions_dir(&repo)).unwrap();
    let root_meta = SessionMeta {
        id: "root-session".into(),
        worktree: repo.to_string_lossy().to_string(),
        created: 25,
        archived: false,
        phase: String::new(),
        harness: "claude".into(),
        model: String::new(),
        playbook: default_playbook_key(),
        ..Default::default()
    };
    fs::write(root_sessions_dir(&repo).join("root-session.meta.json"), serde_json::to_string(&root_meta).unwrap()).unwrap();

    let items = session_list_items_for_repo(&repo, "/repo/a", false).unwrap();
    assert_eq!(items.iter().map(|i| i.session.id.as_str()).collect::<Vec<_>>(), ["alpha-new", "alpha-old"]);
    let archived_items = session_list_items_for_repo(&repo, "/repo/a", true).unwrap();
    assert_eq!(
        archived_items.iter().map(|i| i.session.id.as_str()).collect::<Vec<_>>(),
        ["alpha-archived", "alpha-new", "alpha-old"]
    );
    assert_eq!(items[0].task_slug, "alpha");
    assert_eq!(items[0].task_name, "Alpha");
    assert_eq!(items[0].task_worktree, "/wt-alpha");
    assert_eq!(items[0].repo_path, "/repo/a");
    assert_eq!(items[1].task_slug, "alpha");
    assert_eq!(items[1].task_name, "Alpha");
    assert_eq!(items[1].task_worktree, "/wt-alpha");
    assert_eq!(items[1].repo_path, "/repo/a");
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn missing_task_playbook_is_not_inferred() {
    let old = r#"name = "Old"
slug = "old"
branch = "old"
worktree = "/wt"
created = 1
"#;
    let task: Task = toml::from_str(old).unwrap();
    assert!(task.playbook.is_empty());
    assert!(task.auto_advance.is_empty());
}

#[test]
fn session_resume_state_leftover_is_not_capable() {
    let repo = std::env::temp_dir().join(format!(
        "alinery-resume-state-leftover-{}",
        SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_nanos()).unwrap_or(0)
    ));
    let source = SessionMeta {
        id: "source".into(),
        worktree: "/wt".into(),
        created: 2,
        harness: "claude".into(),
        harness_resume_token: "resume-token".into(),
        ..Default::default()
    };
    let capable = alinery_core::is_allowed_launch_harness(&source.harness)
        && alinery_core::resolve_harness_for(&repo.join("missing-app.toml"), &repo, &source.harness)
            .and_then(|h| h.resume)
            .map(|r| r.enabled && !r.resume_args.is_empty())
            .unwrap_or(false);
    assert!(!capable);
    assert!(!source.harness_resume_token.is_empty());
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn bounded_observation_timeout_returns_error() {
    let repo = activity_repo("bounded-observation-timeout");
    let socket = crate::current_alineryd_socket_path(&repo);
    let listener = status_list_socket(socket.clone(), None);

    let started = std::time::Instant::now();
    let result = crate::DaemonClient::connect_path(socket).unwrap().session_statuses_observed();

    assert!(result.is_err(), "silent daemon observation should fail");
    assert!(
        started.elapsed() < Duration::from_millis(900),
        "observation waited {:?}, expected bounded timeout",
        started.elapsed()
    );
    assert_eq!(listener.join().unwrap(), 1);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn session_list_statuses_groups_duplicate_refs_by_lane() {
    let repo = activity_repo("session-list-groups");
    write_status_session(&repo, "task", "a", "implement", "", Some(1), None, None, "");
    write_status_session(&repo, "task", "b", "implement", "", Some(1), None, None, "");
    let busy_json = "{\"sessions\":[{\"id\":\"a\",\"process\":{\"state\":\"alive\"},\"agent\":{\"state\":\"busy\"},\"playbook\":{\"state\":\"in_progress\"},\"adapter\":\"omp\",\"message_adapter\":\"omp_bracketed_paste\",\"transport\":\"pty\"},{\"id\":\"b\",\"process\":{\"state\":\"alive\"},\"agent\":{\"state\":\"idle\"},\"playbook\":{\"state\":\"in_progress\"},\"adapter\":\"omp\",\"message_adapter\":\"omp_bracketed_paste\",\"transport\":\"pty\"}]}\n";
    let socket = status_list_socket(crate::current_alineryd_socket_path(&repo), Some(busy_json));

    let statuses = crate::session_list_statuses_for_refs(&[status_ref(&repo, "task", "a"), status_ref(&repo, "task", "a"), status_ref(&repo, "task", "b")]);

    let a = crate::session_list_status_key(&repo.display().to_string(), "task", "a");
    let b = crate::session_list_status_key(&repo.display().to_string(), "task", "b");
    assert_eq!(statuses.len(), 2);
    // Session a: Busy agent → lifecycle is Live.
    assert_eq!(statuses.get(&a).map(|obs| &obs.lifecycle), Some(&crate::LifecycleState::Live),);
    assert_eq!(statuses.get(&a).and_then(|obs| obs.state.as_ref()).map(|s| &s.agent), Some(&alinery_core::AgentState::Busy),);
    // Session b: Idle agent → lifecycle is Live.
    assert_eq!(statuses.get(&b).map(|obs| &obs.lifecycle), Some(&crate::LifecycleState::Live),);
    assert_eq!(statuses.get(&b).and_then(|obs| obs.state.as_ref()).map(|s| &s.agent), Some(&alinery_core::AgentState::Idle),);
    assert_eq!(socket.join().unwrap(), 1);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn session_list_statuses_isolates_missing_malformed_and_timeout_lanes() {
    for failure in ["missing", "malformed", "timeout"] {
        let suffix = &failure[..1];
        let healthy = activity_repo(&format!("slh-{suffix}"));
        let failing = activity_repo(&format!("slf-{suffix}"));
        write_status_session(&healthy, "task", "ok", "implement", "", Some(1), None, None, "");
        write_status_session(&failing, "task", "bad", "implement", "", Some(1), None, None, "");
        let healthy_socket = status_list_socket(
            crate::current_alineryd_socket_path(&healthy),
            Some(
                "{\"sessions\":[{\"id\":\"ok\",\"process\":{\"state\":\"alive\"},\"agent\":{\"state\":\"busy\"},\"playbook\":{\"state\":\"in_progress\"},\"adapter\":\"omp\",\"message_adapter\":\"omp_bracketed_paste\",\"transport\":\"pty\"}]}\n",
            ),
        );
        let failing_socket = match failure {
            "missing" => None,
            "malformed" => Some(status_list_socket(crate::current_alineryd_socket_path(&failing), Some("{not json}\n"))),
            "timeout" => Some(status_list_socket(crate::current_alineryd_socket_path(&failing), None)),
            _ => unreachable!(),
        };

        let statuses = crate::session_list_statuses_for_refs(&[status_ref(&healthy, "task", "ok"), status_ref(&failing, "task", "bad")]);

        let ok = crate::session_list_status_key(&healthy.display().to_string(), "task", "ok");
        let bad = crate::session_list_status_key(&failing.display().to_string(), "task", "bad");
        // Healthy lane: Busy agent → lifecycle is Live.
        assert_eq!(statuses.get(&ok).map(|obs| &obs.lifecycle), Some(&crate::LifecycleState::Live), "{failure}");
        assert!(
            statuses.get(&ok).and_then(|obs| obs.state.as_ref()).is_some(),
            "healthy session should have daemon state, {failure}"
        );
        // Failing lane: observation falls back to meta timestamps → Orphaned (started, no ended).
        assert_eq!(statuses.get(&bad).map(|obs| &obs.lifecycle), Some(&crate::LifecycleState::Orphaned), "{failure}");
        assert!(
            statuses.get(&bad).and_then(|obs| obs.state.as_ref()).is_none(),
            "failed-lane session should have no daemon state, {failure}"
        );
        assert_eq!(healthy_socket.join().unwrap(), 1);
        if let Some(socket) = failing_socket {
            assert_eq!(socket.join().unwrap(), 1);
        }
        let _ = fs::remove_dir_all(healthy);
        let _ = fs::remove_dir_all(failing);
    }
}

#[test]
fn session_list_statuses_routes_by_daemon_namespace() {
    let repo = activity_repo("session-list-lanes");
    let own_ns = crate::alineryd_socket_namespace().unwrap_or_default();
    let lane_a = "session-list-lane-a";
    let lane_b = "session-list-lane-b";
    write_status_session(&repo, "task", "lane-a-session", "implement", lane_a, Some(1), None, None, "");
    write_status_session(&repo, "task", "lane-b-session", "implement", lane_b, Some(1), None, None, "");
    let socket_a = status_list_socket(
        crate::route_socket_path(&repo, &own_ns, lane_a).unwrap(),
        Some("{\"sessions\":[{\"id\":\"lane-a-session\",\"process\":{\"state\":\"alive\"},\"agent\":{\"state\":\"busy\"},\"playbook\":{\"state\":\"in_progress\"},\"adapter\":\"omp\",\"message_adapter\":\"omp_bracketed_paste\",\"transport\":\"pty\"}]}\n"),
    );
    let socket_b = status_list_socket(
        crate::route_socket_path(&repo, &own_ns, lane_b).unwrap(),
        Some("{\"sessions\":[{\"id\":\"lane-b-session\",\"process\":{\"state\":\"alive\"},\"agent\":{\"state\":\"idle\"},\"playbook\":{\"state\":\"in_progress\"},\"adapter\":\"omp\",\"message_adapter\":\"omp_bracketed_paste\",\"transport\":\"pty\"}]}\n"),
    );

    let statuses = crate::session_list_statuses_for_refs(&[status_ref(&repo, "task", "lane-a-session"), status_ref(&repo, "task", "lane-b-session")]);

    let a = crate::session_list_status_key(&repo.display().to_string(), "task", "lane-a-session");
    let b = crate::session_list_status_key(&repo.display().to_string(), "task", "lane-b-session");
    assert_eq!(statuses.get(&a).map(|obs| &obs.lifecycle), Some(&crate::LifecycleState::Live));
    assert_eq!(statuses.get(&a).and_then(|obs| obs.state.as_ref()).map(|s| &s.agent), Some(&alinery_core::AgentState::Busy));
    assert_eq!(statuses.get(&b).map(|obs| &obs.lifecycle), Some(&crate::LifecycleState::Live));
    assert_eq!(statuses.get(&b).and_then(|obs| obs.state.as_ref()).map(|s| &s.agent), Some(&alinery_core::AgentState::Idle));
    assert_eq!(socket_a.join().unwrap(), 1);
    assert_eq!(socket_b.join().unwrap(), 1);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn session_list_statuses_artifact_alone_does_not_override_observation() {
    // Plan TDD 3C: artifact presence must not override SessionObservation.
    // The lifecycle stays Live/Busy even with a non-empty expected artifact.
    let repo = activity_repo("sl-art-no-override");
    write_status_session(&repo, "task", "artifact-session", "implement", "", Some(1), None, None, "05-done.md");
    fs::write(crate::artifacts_dir(&repo, "task").join("05-done.md"), "# done\n").unwrap();
    let socket = status_list_socket(
        crate::current_alineryd_socket_path(&repo),
        Some("{\"sessions\":[{\"id\":\"artifact-session\",\"process\":{\"state\":\"alive\"},\"agent\":{\"state\":\"busy\"},\"playbook\":{\"state\":\"in_progress\"},\"adapter\":\"omp\",\"message_adapter\":\"omp_bracketed_paste\",\"transport\":\"pty\"}]}\n"),
    );

    let statuses = crate::session_list_statuses_for_refs(&[status_ref(&repo, "task", "artifact-session")]);

    let key = crate::session_list_status_key(&repo.display().to_string(), "task", "artifact-session");
    // Observation lifecycle must be Live (daemon owns it with Busy agent).
    assert_eq!(statuses.get(&key).map(|obs| &obs.lifecycle), Some(&crate::LifecycleState::Live));
    // Agent must be Busy — artifact presence must not change this.
    assert_eq!(
        statuses.get(&key).and_then(|obs| obs.state.as_ref()).map(|s| &s.agent),
        Some(&alinery_core::AgentState::Busy)
    );
    // Checkpoint is empty (no semantic completion recorded).
    assert!(
        statuses.get(&key).map(|obs| obs.checkpoint.phase_completed_at.is_none()).unwrap_or(false),
        "checkpoint should be empty without a completion event"
    );
    assert_eq!(socket.join().unwrap(), 1);
    let _ = fs::remove_dir_all(repo);
}

// ---- Terminal left-hand pane (root drawer) — TDD red tests (05-tdd.md) ----

#[test]
fn allow_root_session_open_meta_no_harness_allows() {
    assert!(allow_root_session_open(Some("no-harness")));
}

#[test]
fn allow_root_session_open_no_meta_allows_drawer() {
    // After the harness cut, the only root session is the drawer. Missing meta is
    // the defensive path; identity comes from the root meta when present.
    assert!(allow_root_session_open(None));
}

#[test]
fn allow_root_session_open_rejects_non_drawer() {
    assert!(!allow_root_session_open(Some("claude")));
    assert!(!allow_root_session_open(Some("")));
    assert!(!allow_root_session_open(Some("omp")));
}

#[test]
fn hosted_refresh_needed_only_for_omp_hosted_spawn_and_resume() {
    assert!(hosted_refresh_needed("spawn", "omp", "alinery/Qwen3.6-35B-A3B"));
    assert!(hosted_refresh_needed("resume", "omp", "alinery/Qwen3.6-35B-A3B"));
    assert!(hosted_refresh_needed("spawn", "omp", " alinery/Qwen3.6-35B-A3B "));
    assert!(hosted_refresh_needed("spawn", "omp", ""));
    assert!(hosted_refresh_needed("resume", "omp", "   "));
    assert!(!hosted_refresh_needed("spawn", "omp", "anthropic/claude"));
    assert!(!hosted_refresh_needed("resume", "omp", "xai/grok"));
    assert!(!hosted_refresh_needed("attach", "omp", "alinery/Qwen3.6-35B-A3B"));
    assert!(!hosted_refresh_needed("spawn", "no-harness", "alinery/Qwen3.6-35B-A3B"));
    assert!(!hosted_refresh_needed("resume", "no-harness", "alinery/Qwen3.6-35B-A3B"));
    assert!(!hosted_refresh_needed("spawn", "", "alinery/Qwen3.6-35B-A3B"));
    assert!(!hosted_refresh_needed("attach", "no-harness", "alinery/Qwen3.6-35B-A3B"));
}

#[test]

fn notification_read_stamps_only_requested_session() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-notification-read-{n}"));
    let dir = sessions_dir(&repo, "task");
    fs::create_dir_all(&dir).unwrap();
    let target = dir.join("target.meta.json");
    let neighbor = dir.join("neighbor.meta.json");
    let original = serde_json::json!({
        "id": "target",
        "worktree": "/wt",
        "created": 10,
        "phase": "design",
        "playbook": "superdevelop",
        "started_at": 11,
        "ended_at": 12,
        "exit_code": 0,
        "semantic": {
            "phase_completed_at": 13,
            "omp_session_id": "omp-session",
            "omp_turn_id": "omp-turn"
        },
        "unknown_sentinel": {"keep": true}
    });
    fs::write(&target, serde_json::to_vec_pretty(&original).unwrap()).unwrap();
    fs::write(&neighbor, br#"{"id":"neighbor","worktree":"/wt","created":20,"unknown_sentinel":"neighbor"}"#).unwrap();

    crate::mark_session_notification_read_in(&repo, "task", "target").unwrap();

    let stamped: serde_json::Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
    let mut expected = original;
    expected["notification_read_at"] = serde_json::json!(13);
    assert_eq!(stamped, expected);
    let neighbor_after: serde_json::Value = serde_json::from_slice(&fs::read(&neighbor).unwrap()).unwrap();
    assert_eq!(neighbor_after["unknown_sentinel"], "neighbor");
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn notification_read_without_completion_is_noop() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-notification-read-no-completion-{n}"));
    let path = session_meta_path(&repo, "task", "target");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let original = br#"{"id":"target","worktree":"/wt","created":10,"semantic":{},"unknown_sentinel":"keep"}"#;
    fs::write(&path, original).unwrap();

    crate::mark_session_notification_read_in(&repo, "task", "target").unwrap();

    assert_eq!(fs::read(&path).unwrap(), original);
    let mut completed: serde_json::Value = serde_json::from_slice(original).unwrap();
    completed["semantic"]["phase_completed_at"] = serde_json::json!(500);
    fs::write(&path, serde_json::to_vec(&completed).unwrap()).unwrap();
    let after_completion: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(after_completion["semantic"]["phase_completed_at"], 500);
    assert!(after_completion.get("notification_read_at").is_none());
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn notification_read_acknowledges_a_terminal_nonzero_exit() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-notification-read-exit-{n}"));
    let path = session_meta_path(&repo, "task", "target");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        br#"{"id":"target","worktree":"/wt","created":10,"started_at":11,"ended_at":500,"exit_code":143,"semantic":{},"unknown_sentinel":"keep"}"#,
    )
    .unwrap();

    crate::mark_session_notification_read_in(&repo, "task", "target").unwrap();

    let acknowledged: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert!(acknowledged.get("notification_read_at").is_none());
    assert_eq!(acknowledged["exit_notification_read_at"], 500);
    assert_eq!(acknowledged["exit_code"], 143);
    assert_eq!(acknowledged["unknown_sentinel"], "keep");
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn completion_acknowledgment_does_not_hide_a_later_same_second_exit() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-notification-read-same-second-{n}"));
    let path = session_meta_path(&repo, "task", "target");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        br#"{"id":"target","worktree":"/wt","created":10,"started_at":11,"semantic":{"phase_completed_at":500}}"#,
    )
    .unwrap();

    crate::mark_session_notification_read_in(&repo, "task", "target").unwrap();

    let mut exited: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    exited["ended_at"] = serde_json::json!(500);
    exited["exit_code"] = serde_json::json!(143);
    fs::write(&path, serde_json::to_vec(&exited).unwrap()).unwrap();

    let meta: SessionMeta = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(meta.notification_read_at, Some(500));
    assert_eq!(meta.exit_notification_read_at, None);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn quit_acknowledges_only_sessions_that_were_unended_when_chosen() {
    let repo = activity_repo("quit-notification-read");
    write_status_session(&repo, "live-task", "live", "implementation", "", Some(10), None, None, "");
    write_status_session(&repo, "old-task", "old", "implementation", "", Some(10), Some(20), Some(2), "");

    let candidates = crate::unended_task_session_refs_for_repo(&repo);
    assert_eq!(candidates, vec![("live-task".to_string(), "live".to_string())]);

    let live_path = session_meta_path(&repo, "live-task", "live");
    let mut stopped: SessionMeta = serde_json::from_str(&fs::read_to_string(&live_path).unwrap()).unwrap();
    stopped.ended_at = Some(30);
    stopped.exit_code = Some(143);
    fs::write(&live_path, serde_json::to_vec(&stopped).unwrap()).unwrap();

    crate::acknowledge_exited_session_refs(&repo, &candidates).unwrap();

    let live: SessionMeta = serde_json::from_str(&fs::read_to_string(&live_path).unwrap()).unwrap();
    let old: SessionMeta = serde_json::from_str(&fs::read_to_string(session_meta_path(&repo, "old-task", "old")).unwrap()).unwrap();
    assert_eq!(live.exit_notification_read_at, Some(30));
    assert_eq!(live.notification_read_at, None);
    assert_eq!(old.exit_notification_read_at, None);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn notification_read_preserves_later_acknowledgment() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-notification-read-later-{n}"));
    let path = session_meta_path(&repo, "task", "target");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let original = br#"{"id":"target","worktree":"/wt","created":10,"semantic":{"phase_completed_at":500},"notification_read_at":700}"#;
    fs::write(&path, original).unwrap();

    crate::mark_session_notification_read_in(&repo, "task", "target").unwrap();

    assert_eq!(fs::read(&path).unwrap(), original);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn notification_read_rejects_unsafe_or_missing_target() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-notification-read-invalid-{n}"));
    let dir = sessions_dir(&repo, "task");
    fs::create_dir_all(&dir).unwrap();
    let neighbor = dir.join("neighbor.meta.json");
    fs::write(&neighbor, br#"{"id":"neighbor","worktree":"/wt","created":20}"#).unwrap();
    let before = fs::read(&neighbor).unwrap();

    for (slug, id) in [
        ("../other", "neighbor"),
        ("task/other", "neighbor"),
        ("task", "../other"),
        ("task", "other/id"),
        ("task", "missing"),
    ] {
        assert!(crate::mark_session_notification_read_in(&repo, slug, id).is_err(), "{slug}/{id}");
    }
    assert_eq!(fs::read(&neighbor).unwrap(), before);
    assert!(!repo.join(".alinery/tasks/other/sessions/neighbor.meta.json").exists());
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn notification_suppression_defaults_absent() {
    let raw = br#"{"id":"target","worktree":"/wt","created":10,"started_at":11,"ended_at":12,"exit_code":2,"notification_read_at":20,"exit_notification_read_at":21}"#;
    let core: alinery_core::SessionMeta = serde_json::from_slice(raw).unwrap();
    let app: SessionMeta = serde_json::from_slice(raw).unwrap();

    assert_eq!(core.notification_suppression, None);
    assert_eq!(app.notification_suppression, None);
    assert_eq!(core.notification_read_at, Some(20));
    assert_eq!(core.exit_notification_read_at, Some(21));
    assert_eq!(app.notification_read_at, Some(20));
    assert_eq!(app.exit_notification_read_at, Some(21));
    assert!(serde_json::to_value(core).unwrap().get("notification_suppression").is_none());
    assert!(serde_json::to_value(app).unwrap().get("notification_suppression").is_none());
}

#[test]
fn notification_suppression_round_trips_each_kind() {
    for (notice, occurrence) in [
        ("waiting_for_input", "input-correlation-1"),
        ("waiting_for_approval", "approval-correlation-1"),
        ("failure", "1700000001"),
    ] {
        let raw = serde_json::json!({
            "id": "target",
            "worktree": "/wt",
            "created": 10,
            "notification_suppression": {
                "notice": notice,
                "occurrence": occurrence,
            },
        });
        let core: alinery_core::SessionMeta = serde_json::from_value(raw.clone()).unwrap();
        let app: SessionMeta = serde_json::from_value(raw).unwrap();
        assert_eq!(serde_json::to_value(&core).unwrap()["notification_suppression"]["notice"], notice);
        assert_eq!(serde_json::to_value(&app).unwrap()["notification_suppression"]["notice"], notice);
        assert_eq!(core.notification_suppression.unwrap().occurrence, occurrence);
        assert_eq!(app.notification_suppression.unwrap().occurrence, occurrence);
    }

    let unknown = serde_json::json!({
        "id": "target",
        "worktree": "/wt",
        "created": 10,
        "notification_suppression": {
            "notice": "idle",
            "occurrence": "1",
        },
    });
    assert!(serde_json::from_value::<alinery_core::SessionMeta>(unknown.clone()).is_err());
    assert!(serde_json::from_value::<SessionMeta>(unknown).is_err());
}

#[test]
fn notification_suppression_is_independent_of_durable_acknowledgments() {
    let raw = serde_json::json!({
        "id": "target",
        "worktree": "/wt",
        "created": 10,
        "notification_read_at": 20,
        "exit_notification_read_at": 21,
        "notification_suppression": {
            "notice": "failure",
            "occurrence": "22",
        },
        "unknown_sentinel": {"keep": true},
    });
    let core: alinery_core::SessionMeta = serde_json::from_value(raw.clone()).unwrap();
    let app: SessionMeta = serde_json::from_value(raw).unwrap();
    assert_eq!(core.notification_read_at, Some(20));
    assert_eq!(core.exit_notification_read_at, Some(21));
    assert_eq!(core.notification_suppression.as_ref().unwrap().occurrence, "22");
    assert_eq!(app.notification_read_at, Some(20));
    assert_eq!(app.exit_notification_read_at, Some(21));
    assert_eq!(app.notification_suppression.as_ref().unwrap().occurrence, "22");
}

fn notification_clear_ref(repo: &Path, id: &str, notification_suppression: Option<alinery_core::NotificationSuppression>) -> crate::SessionNotificationClearRef {
    crate::SessionNotificationClearRef {
        repo_path: repo.display().to_string(),
        task_slug: "task".into(),
        id: id.into(),
        notification_suppression,
    }
}

#[test]
fn clear_session_notifications_acknowledges_durable_rows() {
    let repo = activity_repo("clear-session-notifications-durable");
    let dir = sessions_dir(&repo, "task");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("completion.meta.json"),
        br#"{"id":"completion","worktree":"/wt","created":1,"started_at":2,"semantic":{"phase_completed_at":10},"unknown_sentinel":{"keep":true}}"#,
    )
    .unwrap();
    fs::write(
        dir.join("exit.meta.json"),
        br#"{"id":"exit","worktree":"/wt","created":1,"started_at":2,"ended_at":11,"exit_code":2,"semantic":{},"unknown_sentinel":{"keep":true}}"#,
    )
    .unwrap();

    crate::clear_session_notifications_in(&repo, &[notification_clear_ref(&repo, "completion", None), notification_clear_ref(&repo, "exit", None)]).unwrap();

    let completion: serde_json::Value = serde_json::from_slice(&fs::read(dir.join("completion.meta.json")).unwrap()).unwrap();
    assert_eq!(completion["notification_read_at"], 10);
    assert!(completion.get("exit_notification_read_at").is_none());
    assert_eq!(completion["unknown_sentinel"]["keep"], true);
    let exit: serde_json::Value = serde_json::from_slice(&fs::read(dir.join("exit.meta.json")).unwrap()).unwrap();
    assert_eq!(exit["exit_notification_read_at"], 11);
    assert!(exit.get("notification_read_at").is_none());
    assert_eq!(exit["unknown_sentinel"]["keep"], true);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn clear_session_notifications_stamps_requested_live_suppression() {
    let repo = activity_repo("clear-session-notifications-live");
    let path = session_meta_path(&repo, "task", "target");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, br#"{"id":"target","worktree":"/wt","created":1,"semantic":{},"unknown_sentinel":"keep"}"#).unwrap();

    for (notice, occurrence) in [
        (alinery_core::NotificationSuppressionKind::WaitingForInput, "input-7"),
        (alinery_core::NotificationSuppressionKind::WaitingForApproval, "approval-8"),
        (alinery_core::NotificationSuppressionKind::Failure, "9"),
    ] {
        let suppression = alinery_core::NotificationSuppression {
            notice,
            occurrence: occurrence.into(),
        };
        crate::clear_session_notifications_in(&repo, &[notification_clear_ref(&repo, "target", Some(suppression.clone()))]).unwrap();
        let meta: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            serde_json::from_value::<alinery_core::NotificationSuppression>(meta["notification_suppression"].clone()).unwrap(),
            suppression
        );
        assert!(meta.get("notification_read_at").is_none());
        assert!(meta.get("exit_notification_read_at").is_none());
        assert_eq!(meta["unknown_sentinel"], "keep");
    }
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn clear_session_notifications_without_suppression_keeps_prior_fingerprint_and_checkpoints() {
    let repo = activity_repo("clear-session-notifications-monotonic");
    let path = session_meta_path(&repo, "task", "target");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let original_suppression = serde_json::json!({"notice":"failure","occurrence":"700"});
    fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "id": "target",
            "worktree": "/wt",
            "created": 1,
            "ended_at": 10,
            "exit_code": 2,
            "notification_read_at": 800,
            "exit_notification_read_at": 900,
            "notification_suppression": original_suppression,
            "semantic": {"phase_completed_at": 20},
        }))
        .unwrap(),
    )
    .unwrap();

    crate::clear_session_notifications_in(&repo, &[notification_clear_ref(&repo, "target", None)]).unwrap();

    let meta: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(meta["notification_read_at"], 800);
    assert_eq!(meta["exit_notification_read_at"], 900);
    assert_eq!(meta["notification_suppression"], original_suppression);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn clear_session_notifications_rejects_unsafe_or_missing_targets() {
    let repo = activity_repo("clear-session-notifications-invalid");
    let neighbor = session_meta_path(&repo, "task", "neighbor");
    fs::create_dir_all(neighbor.parent().unwrap()).unwrap();
    fs::write(&neighbor, br#"{"id":"neighbor","worktree":"/wt","created":1}"#).unwrap();
    let before = fs::read(&neighbor).unwrap();

    for (slug, id) in [
        ("../other", "neighbor"),
        ("task/other", "neighbor"),
        ("task", "../session"),
        ("task", "session/child"),
        ("task", "missing"),
    ] {
        let mut reference = notification_clear_ref(&repo, id, None);
        reference.task_slug = slug.into();
        assert!(crate::clear_session_notifications_in(&repo, &[reference]).is_err(), "{slug}/{id}");
    }
    assert_eq!(fs::read(&neighbor).unwrap(), before);
    assert!(crate::validate_known_target_repo(&[repo.display().to_string()], "/unknown/repo").is_err());
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn clear_session_notifications_handles_multiple_repositories_by_ref() {
    let repo_a = activity_repo("clear-session-notifications-repo-a");
    let repo_b = activity_repo("clear-session-notifications-repo-b");
    for repo in [&repo_a, &repo_b] {
        let path = session_meta_path(repo, "task", "same");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, br#"{"id":"same","worktree":"/wt","created":1,"semantic":{"phase_completed_at":10}}"#).unwrap();
    }

    crate::clear_session_notifications_in(&repo_a, &[notification_clear_ref(&repo_a, "same", None)]).unwrap();
    let a: serde_json::Value = serde_json::from_slice(&fs::read(session_meta_path(&repo_a, "task", "same")).unwrap()).unwrap();
    let b: serde_json::Value = serde_json::from_slice(&fs::read(session_meta_path(&repo_b, "task", "same")).unwrap()).unwrap();
    assert_eq!(a["notification_read_at"], 10);
    assert!(b.get("notification_read_at").is_none());

    crate::clear_session_notifications_in(&repo_b, &[notification_clear_ref(&repo_b, "same", None)]).unwrap();
    let b: serde_json::Value = serde_json::from_slice(&fs::read(session_meta_path(&repo_b, "task", "same")).unwrap()).unwrap();
    assert_eq!(b["notification_read_at"], 10);
    let _ = fs::remove_dir_all(repo_a);
    let _ = fs::remove_dir_all(repo_b);
}

#[test]
fn unified_message_action_finalization_validates_all_before_mutation() {
    let repo = init_git_test_repo("message-actions");
    let task = create_task_for_test(&repo, "Message Actions", true, "", "");
    let session = SessionMeta {
        id: "s-actions".into(),
        worktree: task.worktree.clone(),
        created: 10,
        phase: "implementation".into(),
        harness: "claude".into(),
        playbook: default_playbook_key(),
        ..Default::default()
    };
    fs::create_dir_all(sessions_dir(&repo, &task.slug)).unwrap();
    fs::write(session_meta_path(&repo, &task.slug, &session.id), serde_json::to_string(&session).unwrap()).unwrap();
    fs::create_dir_all(artifacts_dir(&repo, &task.slug)).unwrap();
    fs::write(artifacts_dir(&repo, &task.slug).join("03-design.md"), "# Design\n").unwrap();
    fs::write(artifacts_dir(&repo, &task.slug).join("03-review-findings.md"), "# Findings\n\nNo blockers.\n").unwrap();
    let approval_action = prepare_review_approval_prompt_for(&repo, &task.slug, "03-review-findings.md").unwrap();
    let review_path = fs::canonicalize(artifacts_dir(&repo, &task.slug).join("03-review-findings.md")).unwrap();
    assert!(approval_action.text.contains(&format!("Review findings path: {}", review_path.display())));
    assert_eq!(
        approval_action.provenance,
        SessionMessageActionProvenance::ReviewApproval {
            review_artifact: "03-review-findings.md".into(),
        }
    );
    assert!(prepare_review_approval_prompt_for(&repo, &task.slug, "../outside.md").is_err());
    add_artifact_comment_for(
        &repo,
        &task.slug,
        "03-design.md",
        "comment-1".into(),
        "p".into(),
        "Design".into(),
        "Design".into(),
        1,
        1,
        "Clarify this.".into(),
    )
    .unwrap();
    let comment_action = prepare_artifact_comments_prompt_for(&repo, &task.slug, &["03-design.md".into()]).unwrap();
    let actions = vec![
        comment_action.provenance,
        SessionMessageActionProvenance::ReviewApproval {
            review_artifact: "03-review-findings.md".into(),
        },
    ];
    let mut invalid = actions.clone();
    invalid.push(SessionMessageActionProvenance::ReviewApproval {
        review_artifact: "../outside.md".into(),
    });
    assert!(finalize_session_message_actions_for(&repo, &session.id, &task.slug, &invalid).is_err());
    assert!(!artifact_review_pending_path(&repo, &task.slug, "03-design.md").unwrap().exists());

    finalize_session_message_actions_for(&repo, &session.id, &task.slug, &actions).unwrap();
    assert!(artifact_review_pending_path(&repo, &task.slug, "03-design.md").unwrap().exists());
    finalize_session_message_actions_for(&repo, &session.id, &task.slug, &actions).unwrap();
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn observation_omits_transport_when_daemon_does_not_own_id() {
    let observation = crate::SessionObservation {
        lifecycle: alinery_core::LifecycleState::NeverStarted,
        state: None,
        checkpoint: alinery_core::SemanticCheckpoint::default(),
        transport: None,
    };
    let value = serde_json::to_value(&observation).unwrap();
    let object = value.as_object().unwrap();
    assert!(!object.contains_key("transport"));
}

#[test]
fn observation_includes_rpc_when_live() {
    let observation = crate::SessionObservation {
        lifecycle: alinery_core::LifecycleState::Live,
        state: None,
        checkpoint: alinery_core::SemanticCheckpoint::default(),
        transport: Some(alinery_core::SessionTransport::Rpc),
    };
    let value = serde_json::to_value(&observation).unwrap();
    assert_eq!(value["transport"], "rpc");
}
