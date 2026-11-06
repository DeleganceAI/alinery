//! Tests for session.rs — session CRUD, status projection, history, the root drawer terminal
//!
//! `use super::*` reaches the shared imports and fixtures in tests/mod.rs.
use super::*;

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
    assert_eq!(listener.calls(), 1);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn hosted_refresh_needed_only_for_omp_hosted_spawn_and_resume() {
    assert!(hosted_refresh_needed("spawn", "omp", "alinery/Qwen3.6-35B-A3B"));
    assert!(hosted_refresh_needed("spawn", "vinculum", "alinery/Qwen3.6-35B-A3B"));
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
fn pi_durable_hosted_refresh_is_thirty_minutes() {
    assert_eq!(crate::PI_DURABLE_HOSTED_REFRESH, std::time::Duration::from_secs(30 * 60));
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

fn plant_chat(
    repo: &Path,
    id: &str,
    harness: &str,
    created: u64,
    pinned: bool,
    archived: bool,
    worktree: &str,
    token: &str,
    started: Option<u64>,
    ended: Option<u64>,
    resume_of: Option<&str>,
) {
    let path = session_meta_path(repo, "", id);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let meta = SessionMeta {
        id: id.into(),
        harness: harness.into(),
        generic: true,
        created,
        pinned,
        archived,
        worktree: worktree.into(),
        harness_resume_token: token.into(),
        started_at: started,
        ended_at: ended,
        resume_of: resume_of.map(str::to_string),
        ..Default::default()
    };
    fs::write(path, serde_json::to_vec(&meta).unwrap()).unwrap();
}

#[test]
fn open_chat_repos_need_ownership_a_daemon_and_no_close_in_flight() {
    let open = init_git_test_repo("chat-open");
    let no_daemon = init_git_test_repo("chat-no-daemon");
    let foreign = init_git_test_repo("chat-foreign");
    let closing = init_git_test_repo("chat-closing");
    let state = AppState::default();
    let client = || crate::DaemonClient::connect_path(std::path::PathBuf::from("/tmp/unused-chat-open.sock")).unwrap();
    for repo in [&open, &no_daemon, &closing] {
        assert!(state.claim_repo(repo));
    }
    for repo in [&open, &foreign, &closing] {
        state.set_daemon(repo, client(), alinery_core::DaemonCompat::Current, String::new(), false);
    }
    let _closing = state.mark_closing(&closing);
    let known: Vec<String> = [&open, &no_daemon, &foreign, &closing].iter().map(|repo| repo.to_string_lossy().into_owned()).collect();
    assert_eq!(open_chat_repos_in(&known, &state), [open]);
}

#[test]
fn require_explicit_daemon_does_not_call_active() {
    let mut calls = 0;
    let missing = require_explicit_daemon(None::<u8>, || {
        calls += 1;
        Some(1)
    });
    assert_eq!(missing.unwrap_err(), "daemon not connected");
    assert_eq!(calls, 0);
    let chosen = require_explicit_daemon(Some(2u8), || {
        calls += 1;
        Some(1)
    })
    .unwrap();
    assert_eq!(chosen, 2);
    assert_eq!(calls, 0);
}

// Stands in for the daemon during a resume: `create_execution_session` mints the successor row,
// `resume` is acked. Two connections, then it exits.
#[test]
fn read_chat_journal_uses_root_sessions_dir() {
    let repo = init_git_test_repo("chat-journal");
    plant_chat(&repo, "s-j", "omp", 1, false, false, &repo.to_string_lossy(), "", None, None, None);
    let root = alinery_core::session_omp_dir(&repo, "", "s-j");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("a.jsonl"), b"root-journal\n").unwrap();
    let task = alinery_core::session_omp_dir(&repo, "task", "s-j");
    fs::create_dir_all(&task).unwrap();
    fs::write(task.join("a.jsonl"), b"task-journal\n").unwrap();
    let window = alinery_core::read_omp_window(&repo, "", "s-j", None, Some(64)).unwrap();
    assert_eq!(window.data, b"root-journal\n");
    let _ = fs::remove_dir_all(repo);
}
