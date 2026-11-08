//! Tests for git_ops.rs — worktrees, compare URLs, commits
//!
//! `use super::*` reaches the shared imports and fixtures in tests/mod.rs.
use super::*;

#[test]
fn git_top_level_rejects_non_git_dir() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("alinery-nongit-{n}"));
    fs::create_dir_all(&dir).unwrap();
    let err = git_top_level(&dir).unwrap_err();
    let _ = fs::remove_dir_all(&dir);
    assert!(err.contains("not a git repo"));
}

// Git refuses to create `fix/thing` when a ref named `fix` exists, and vice versa —
// refs are files, so `fix` and `fix/` cannot both live in refs/heads. create_task calls
// this before `git worktree add -b`, and without it task creation fails with a raw git
// error after the task directory has already been written.
#[test]
fn branch_ref_conflicts_detects_the_file_vs_directory_ref_collision() {
    let repo = init_git_test_repo("branch-ref-conflicts");
    git_cmd(&repo).args(["branch", "fix"]).output().unwrap();

    // Exact match.
    assert!(crate::branch_ref_conflicts(&repo, "fix"));
    // `fix` exists as a file, so `fix/anything` cannot be created.
    assert!(crate::branch_ref_conflicts(&repo, "fix/thing"));
    // Unrelated names are fine, including ones that merely share a prefix.
    assert!(!crate::branch_ref_conflicts(&repo, "fixture"));
    assert!(!crate::branch_ref_conflicts(&repo, "other"));
}

#[test]
fn branch_ref_conflicts_detects_the_collision_in_the_other_direction() {
    let repo = init_git_test_repo("branch-ref-conflicts-dir");
    git_cmd(&repo).args(["branch", "feat/one"]).output().unwrap();

    // `feat` is now a directory, so a plain `feat` branch cannot be created.
    assert!(crate::branch_ref_conflicts(&repo, "feat"));
    assert!(crate::branch_ref_conflicts(&repo, "feat/one"));
    assert!(!crate::branch_ref_conflicts(&repo, "feat-one"));
}

#[test]
fn branch_ref_conflicts_is_false_outside_a_git_repo_rather_than_panicking() {
    // Called on a path git cannot read: the answer must be "no conflict", not a crash,
    // because this runs inside task creation.
    let dir = std::env::temp_dir().join(format!("alinery-not-a-repo-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    assert!(!crate::branch_ref_conflicts(&dir, "anything"));
}

fn github_pull_fixture(number: u64, owner: &str, branch: &str, state: &str, merged: bool) -> serde_json::Value {
    serde_json::json!({
        "number": number,
        "html_url": format!("https://github.com/team/project/pull/{number}"),
        "state": state,
        "merged_at": if merged { Some("2026-09-17T12:00:00Z") } else { None },
        "head": {
            "ref": branch,
            "user": { "login": owner },
            "repo": { "full_name": format!("{owner}/project") }
        }
    })
}

#[test]
fn pull_request_urls_reject_creation_forms_and_foreign_hosts() {
    let reference = crate::github_pull_request_ref("https://github.com/team/project/pull/42?notification_referrer_id=1#discussion").unwrap();
    assert_eq!(reference.label(), "team/project#42");
    for url in [
        "https://github.com/team/project/compare/main...feature",
        "https://github.com/team/project/issues/42",
        "https://github.com.evil.test/team/project/pull/42",
        "https://github.com@evil.test/team/project/pull/42",
        "https://github.com/team/project/pull/0",
        "https://github.com/team/project/pull/42/files",
        "https://github.com/team/../pull/42",
        "https://github.com/team%2Fevil/project/pull/42",
    ] {
        assert!(crate::github_pull_request_ref(url).is_none(), "{url}");
    }
}

#[test]
fn branch_pull_requests_require_exact_head_and_prefer_open_then_latest() {
    let pulls = serde_json::json!([
        github_pull_fixture(40, "fork", "feature/nested", "open", false),
        github_pull_fixture(39, "team", "feature/nested-more", "open", false),
        github_pull_fixture(38, "team", "feature/nested", "closed", true),
        github_pull_fixture(21, "team", "feature/nested", "open", false),
        github_pull_fixture(22, "team", "feature/nested", "open", false)
    ]);
    let selected = crate::select_branch_pull_request(&pulls, "team", "project", "feature/nested").unwrap().unwrap();
    assert_eq!(selected.number, 22);
    assert_eq!(selected.state, crate::PullRequestState::Open);
    let historical = serde_json::json!([
        github_pull_fixture(37, "team", "feature/nested", "closed", false),
        github_pull_fixture(38, "team", "feature/nested", "closed", true)
    ]);
    let merged = crate::select_branch_pull_request(&historical, "team", "project", "feature/nested").unwrap().unwrap();
    assert_eq!(merged.number, 38);
    assert_eq!(merged.state, crate::PullRequestState::Merged);
    let closed = crate::select_branch_pull_request(
        &serde_json::json!([github_pull_fixture(39, "team", "feature/nested", "closed", false)]),
        "team",
        "project",
        "feature/nested",
    )
    .unwrap()
    .unwrap();
    assert_eq!(closed.state, crate::PullRequestState::Closed);
}

#[test]
fn malformed_pull_request_state_and_url_are_errors_not_missing_prs() {
    let mut pull = github_pull_fixture(42, "team", "feature", "unknown", false);
    assert!(crate::select_branch_pull_request(&serde_json::json!([pull.clone()]), "team", "project", "feature").is_err());
    pull["state"] = serde_json::json!("open");
    pull["html_url"] = serde_json::json!("https://example.com/team/project/pull/42");
    assert!(crate::select_branch_pull_request(&serde_json::json!([pull]), "team", "project", "feature").is_err());
}

#[test]
fn a_stored_pull_request_link_is_looked_up_by_number_without_the_branch_or_origin() {
    let found = crate::find_task_pull_request(
        "https://github.com/team/project/pull/42",
        "",
        || panic!("a stored PR must not depend on the origin"),
        |endpoint, fields| {
            assert_eq!(endpoint, "repos/team/project/pulls/42");
            assert!(fields.is_empty());
            Ok(github_pull_fixture(42, "team", "deleted-branch", "closed", true))
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(found.number, 42);
    assert_eq!(found.state, crate::PullRequestState::Merged);
    // GitHub answering with another number is not the stored PR.
    let wrong = crate::find_task_pull_request(
        "https://github.com/team/project/pull/42",
        "",
        || Ok(None),
        |_, _| Ok(github_pull_fixture(43, "team", "x", "open", false)),
    );
    assert!(wrong.is_err());
}

#[test]
fn a_creation_form_link_falls_back_to_the_branch_and_asks_open_before_all() {
    let mut asked = Vec::new();
    let found = crate::find_task_pull_request(
        "https://github.com/team/project/compare/main...feature?expand=1",
        "feature",
        || Ok(Some(("team".into(), "project".into()))),
        |endpoint, fields| {
            assert_eq!(endpoint, "repos/team/project/pulls");
            let state = fields.iter().find(|(key, _)| *key == "state").unwrap().1.to_string();
            asked.push(state.clone());
            if state == "open" {
                Ok(serde_json::json!([]))
            } else {
                Ok(serde_json::json!([github_pull_fixture(42, "team", "feature", "closed", true)]))
            }
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(asked, ["open", "all"]);
    assert_eq!(found.state, crate::PullRequestState::Merged);
}

#[test]
fn a_failed_lookup_is_an_error_and_no_origin_or_no_branch_is_no_pull_request() {
    let origin = || Ok(Some(("team".to_string(), "project".to_string())));
    let error = crate::find_task_pull_request("", "feature", origin, |_, _| Err("authentication failed".into())).unwrap_err();
    assert_eq!(error, "authentication failed");
    assert_eq!(crate::find_task_pull_request("", "feature", origin, |_, _| Ok(serde_json::json!([]))).unwrap(), None);
    assert_eq!(
        crate::find_task_pull_request("", "feature", || Ok(None), |_, _| panic!("no origin, no request")).unwrap(),
        None
    );
    assert_eq!(crate::find_task_pull_request("", "", origin, |_, _| panic!("no branch, no request")).unwrap(), None);
}
