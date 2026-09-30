//! Tests for notify.rs — attention notifications
//!
//! `use super::*` reaches the shared imports and fixtures in tests/mod.rs.
use super::*;

#[test]
fn session_attention_uses_the_row_repository_for_colliding_slugs() {
    let repo_a = init_git_test_repo("attention-repo-a");
    let repo_b = init_git_test_repo("attention-repo-b");
    let mut task_a = create_task_for_test(&repo_a, "Shared Task", false, "", "");
    let mut task_b = create_task_for_test(&repo_b, "Shared Task", false, "", "");
    assert_eq!(task_a.slug, task_b.slug);
    task_a.name = "Repo A Task".into();
    task_b.name = "Repo B Task".into();
    write_task(&repo_a, &task_a).unwrap();
    write_task(&repo_b, &task_b).unwrap();

    assert_eq!(
        crate::session_attention_body(&repo_b, Some(task_b.slug.clone()), "waiting_for_input",).unwrap(),
        "Repo B Task — waiting for your input"
    );
    assert_eq!(crate::session_attention_body(&repo_a, Some(task_a.slug), "idle").unwrap(), "Repo A Task — idle, needs you");

    let _ = fs::remove_dir_all(repo_a);
    let _ = fs::remove_dir_all(repo_b);
}

// The reason string comes off the wire from alineryd, so an unknown value is a protocol
// mismatch and must be an error rather than a notification reading "session — ".
#[test]
fn session_attention_body_maps_each_supported_reason() {
    let repo = init_git_test_repo("attention-reasons");
    for (reason, expected) in [
        ("idle", "idle, needs you"),
        ("waiting_for_input", "waiting for your input"),
        ("waiting_for_approval", "waiting for your approval"),
        ("failure", "failed"),
        ("interrupted", "interrupted and needs recovery"),
        ("completed", "completed"),
    ] {
        let body = crate::session_attention_body(&repo, None, reason).expect("supported reason");
        assert_eq!(body, format!("session — {expected}"));
    }
}

#[test]
fn session_attention_body_rejects_an_unknown_reason() {
    let repo = init_git_test_repo("attention-unknown");
    let err = crate::session_attention_body(&repo, None, "on_fire").unwrap_err();
    assert!(err.contains("unsupported attention reason"), "{err}");
}

#[test]
fn session_attention_body_prefers_the_task_name_and_falls_back_to_the_slug() {
    let repo = init_git_test_repo("attention-label");
    let task = create_task_for_test(&repo, "Human Readable Name", true, "", "");

    // A known task is announced by its name, not its slug.
    let named = crate::session_attention_body(&repo, Some(task.slug.clone()), "idle").unwrap();
    assert_eq!(named, "Human Readable Name — idle, needs you");

    // An unknown slug still names something rather than saying "session".
    let unknown = crate::session_attention_body(&repo, Some("no-such-task".into()), "idle").unwrap();
    assert_eq!(unknown, "no-such-task — idle, needs you");
}

#[test]
fn dock_badge_value_uses_positive_counts_verbatim() {
    for count in [1, 2, 99, 100, i64::MAX] {
        assert_eq!(crate::dock_badge_value(count), Some(count));
    }
}

#[test]
fn dock_badge_value_removes_zero_and_negative_counts() {
    for count in [0, -1, i64::MIN] {
        assert_eq!(crate::dock_badge_value(count), None);
    }
}
