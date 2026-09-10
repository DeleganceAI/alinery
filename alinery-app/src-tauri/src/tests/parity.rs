//! Cross-crate parity for the types that exist twice.
//!
//! `SessionMeta` and `Task` are declared in BOTH the app crate (src/session.rs,
//! src/task.rs) and alinery-core (alinery-core/src/types.rs). The app, alineryd and alinery-mcp all
//! read and write the same `.meta.json` and `task.md` files, so the two declarations are
//! a wire contract with nothing enforcing it — add a field on one side only and the other
//! silently drops it on the next write. The filesystem is this app's database; a dropped
//! field is data loss, not a type error.
//!
//! These tests serialise through one declaration and read back through the other, in both
//! directions, so a field added, removed or renamed on either side fails here.
//!
//! Fixtures below MUST give every field a non-default value. Both tests compare *serialized
//! key sets*, and a `skip_serializing_if` field left at its default is omitted from both
//! sides — so the key never appears in either set and the comparison cannot see it. A rename
//! on one side of such a field would pass this whole file while alineryd silently drops it on
//! the next meta rewrite.

fn app_session_meta() -> crate::SessionMeta {
    crate::SessionMeta {
        id: "s-123".into(),
        worktree: "/w/task".into(),
        created: 1_700_000_000,
        archived: true,
        phase: "design".into(),
        harness: "claude".into(),
        model: "sonnet".into(),
        playbook: "superdevelop".into(),
        generic: true,
        subtask_manager: true,
        subtask_slug: "child-task".into(),
        artifact: "02-design.md".into(),
        handoff_artifact: "01-research.md".into(),
        prompt_extra: "extra".into(),
        prompt: Some("a prompt".into()),
        started_at: Some(1_700_000_001),
        status_changed_at: Some(1_700_000_004),
        status_revision: 9,
        ended_at: Some(1_700_000_002),
        exit_code: Some(3),
        harness_resume_token: "tok".into(),
        resume_of: Some("s-122".into()),
        daemon_namespace: "dev".into(),
        notification_read_at: Some(1_700_000_003),
        exit_notification_read_at: Some(1_700_000_002),
        notification_suppression: Some(alinery_core::NotificationSuppression {
            notice: alinery_core::NotificationSuppressionKind::Failure,
            occurrence: "1700000004".into(),
        }),
        semantic: Default::default(),
        telemetry_id: "9f1c7a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b".into(),
    }
}

#[test]
fn session_meta_survives_a_round_trip_through_the_alinery_core_declaration() {
    let app = app_session_meta();
    let json = serde_json::to_string(&app).expect("app SessionMeta serialises");

    // alineryd and alinery-mcp read the file through alinery-core's declaration.
    let core: alinery_core::SessionMeta = serde_json::from_str(&json).expect("alinery-core reads what the app wrote");
    let round_tripped = serde_json::to_string(&core).expect("alinery-core SessionMeta serialises");

    let a: serde_json::Value = serde_json::from_str(&json).unwrap();
    let b: serde_json::Value = serde_json::from_str(&round_tripped).unwrap();
    assert_eq!(a, b, "a field is present on one SessionMeta declaration and not the other");
}

#[test]
fn session_meta_written_by_alinery_core_is_read_back_identically_by_the_app() {
    // The other direction: alineryd stamps started_at/ended_at/exit_code/semantic on the
    // meta, and the app must read every one of them back.
    let app = app_session_meta();
    let core: alinery_core::SessionMeta = serde_json::from_str(&serde_json::to_string(&app).unwrap()).unwrap();
    let core_json = serde_json::to_string(&core).unwrap();

    let back: crate::SessionMeta = serde_json::from_str(&core_json).expect("the app reads what alinery-core wrote");
    assert_eq!(serde_json::to_value(&back).unwrap(), serde_json::to_value(&app).unwrap());
}

#[test]
fn session_meta_field_names_match_exactly() {
    // A rename on one side would still round-trip if the other side defaulted the missing
    // field, so compare the key sets directly rather than trusting the round trip alone.
    let app_json: serde_json::Value = serde_json::from_str(&serde_json::to_string(&app_session_meta()).unwrap()).unwrap();
    let core: alinery_core::SessionMeta = serde_json::from_value(app_json.clone()).unwrap();
    let core_json = serde_json::to_value(&core).unwrap();

    let keys = |v: &serde_json::Value| {
        let mut k: Vec<String> = v.as_object().expect("object").keys().cloned().collect();
        k.sort();
        k
    };
    assert_eq!(keys(&app_json), keys(&core_json));
}

#[test]
fn task_survives_round_trips_with_exact_app_core_key_parity() {
    let app = crate::Task {
        name: "Parity Task".into(),
        slug: "parity-task".into(),
        requested_slug: "approved-slug".into(),
        branch: "parity-task".into(),
        worktree: "/w/parity-task".into(),
        has_worktree: true,
        created: 1_700_000_000,
        archived: false,
        pr_url: "https://example.test/pr/1".into(),
        linear_id: "SAG-1".into(),
        github_issue: "owner/repo#1".into(),
        playbook: "superdevelop".into(),
        auto_advance: vec!["design->implementation".into()],
        parent_task: "parent-task".into(),
        active_subtask: "child-task".into(),
        subtask_outcome: "merged".into(),
        draft: false,
        telemetry_id: "11111111-2222-4333-8444-555555555555".into(),
        related_tasks: vec![alinery_core::RelatedTaskRef {
            repo_path: "/other".into(),
            slug: "other-task".into(),
            name: "Other".into(),
        }],
    };
    let app_toml = toml::to_string(&app).unwrap();
    let core: alinery_core::Task = toml::from_str(&app_toml).expect("alinery-core reads app task");
    assert_eq!(core.requested_slug, "approved-slug");
    assert_eq!(core.parent_task, "parent-task");
    assert_eq!(core.active_subtask, "child-task");
    assert_eq!(core.subtask_outcome, "merged");

    let core_toml = toml::to_string(&core).unwrap();
    let back: crate::Task = toml::from_str(&core_toml).expect("app reads alinery-core task");
    let app_value: toml::Value = toml::from_str(&app_toml).unwrap();
    let core_value: toml::Value = toml::from_str(&core_toml).unwrap();
    assert_eq!(app_value, core_value, "task fields or serialized key sets differ");
    assert_eq!(back.requested_slug, app.requested_slug);
    assert_eq!(back.parent_task, app.parent_task);
    assert_eq!(back.active_subtask, app.active_subtask);
    assert_eq!(back.subtask_outcome, app.subtask_outcome);
}

#[test]
fn legacy_relationship_and_manager_fields_default_and_stay_omitted() {
    let task_toml = r#"
name = "Legacy"
slug = "legacy"
branch = "legacy"
worktree = "/w/legacy"
created = 1
"#;
    let app_task: crate::Task = toml::from_str(task_toml).unwrap();
    let core_task: alinery_core::Task = toml::from_str(task_toml).unwrap();
    for value in [
        &app_task.requested_slug,
        &app_task.parent_task,
        &app_task.active_subtask,
        &app_task.subtask_outcome,
        &core_task.requested_slug,
        &core_task.parent_task,
        &core_task.active_subtask,
        &core_task.subtask_outcome,
    ] {
        assert!(value.is_empty());
    }
    let app_task_value: toml::Value = toml::from_str(&toml::to_string(&app_task).unwrap()).unwrap();
    let core_task_value: toml::Value = toml::from_str(&toml::to_string(&core_task).unwrap()).unwrap();
    for key in ["requested_slug", "parent_task", "active_subtask", "subtask_outcome"] {
        assert!(app_task_value.get(key).is_none());
        assert!(core_task_value.get(key).is_none());
    }

    let session_json = r#"{"id":"legacy","worktree":"/w/legacy","created":1}"#;
    let app_session: crate::SessionMeta = serde_json::from_str(session_json).unwrap();
    let core_session: alinery_core::SessionMeta = serde_json::from_str(session_json).unwrap();
    assert!(!app_session.subtask_manager && app_session.subtask_slug.is_empty());
    assert!(!core_session.subtask_manager && core_session.subtask_slug.is_empty());
    let app_session_value = serde_json::to_value(app_session).unwrap();
    let core_session_value = serde_json::to_value(core_session).unwrap();
    for key in ["subtask_manager", "subtask_slug"] {
        assert!(app_session_value.get(key).is_none());
        assert!(core_session_value.get(key).is_none());
    }
}
