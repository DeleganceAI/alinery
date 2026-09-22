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

#[test]
fn compare_url_ssh_https_github_gitea() {
    // GitHub: both ssh and https resolve to the same compare URL, with ?expand=1.
    let gh = "https://github.com/owner/repo/compare/main...feat?expand=1";
    assert_eq!(compare_url("git@github.com:owner/repo.git", "main", "feat").as_deref(), Some(gh));
    assert_eq!(compare_url("https://github.com/owner/repo.git", "main", "feat").as_deref(), Some(gh));
    assert_eq!(compare_url("https://github.com/owner/repo", "main", "feat").as_deref(), Some(gh));
    assert_eq!(compare_url("ssh://git@github.com/owner/repo.git", "main", "feat").as_deref(), Some(gh));
    // Gitea (self-hosted host): NO ?expand=1.
    assert_eq!(
        compare_url("git@git.example.com:team/proj.git", "main", "wip").as_deref(),
        Some("https://git.example.com/team/proj/compare/main...wip")
    );
    assert_eq!(
        compare_url("https://gitea.example.com/team/proj", "trunk", "wip").as_deref(),
        Some("https://gitea.example.com/team/proj/compare/trunk...wip")
    );
    // Garbage / non-remote strings don't parse into a URL.
    assert_eq!(compare_url("not a url", "main", "x"), None);
    assert_eq!(compare_url("https://github.com/onlyowner", "main", "x"), None);
    // Embedded credentials in an https remote are STRIPPED (never leak into the URL).
    assert_eq!(
        compare_url("https://x-access-token:ghp_secret@github.com/owner/repo.git", "main", "feat").as_deref(),
        Some(gh)
    );
    // ssh:// with an explicit SSH port drops the port (unknowable web port → default https).
    assert_eq!(
        compare_url("ssh://git@gitea.example.com:2222/team/proj.git", "main", "wip").as_deref(),
        Some("https://gitea.example.com/team/proj/compare/main...wip")
    );
    // ...but an https remote's explicit web port is KEPT (it IS the web port).
    assert_eq!(
        compare_url("https://gitea.example.com:3000/team/proj", "main", "wip").as_deref(),
        Some("https://gitea.example.com:3000/team/proj/compare/main...wip")
    );
}

#[test]
fn worktree_exists_flags_missing_dir() {
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo = init_git_test_repo("worktree-exists");
    set_active_repo_global(Some(repo.clone())).unwrap();

    let task = create_task_for_test(&repo, "Worktree Exists Task", true, "", "");
    assert!(worktree_exists(task.slug.clone()).expect("worktree_exists ok"));

    fs::remove_dir_all(&task.worktree).unwrap();
    assert!(!worktree_exists(task.slug.clone()).expect("worktree_exists ok after removal"));

    // A task whose `worktree` field is already "" (e.g. after remove_worktree) is never
    // reported as existing, regardless of what's on disk.
    let mut bare = task.clone();
    bare.worktree.clear();
    write_task(&repo, &bare).unwrap();
    assert!(!worktree_exists(bare.slug.clone()).expect("worktree_exists ok for empty path"));

    set_active_repo_global(None).unwrap();
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn post_git_updates_do_not_resurrect_a_purged_task() {
    let repo = init_git_test_repo("post-git-purge");
    let task = create_task_for_test(&repo, "Post Git Purge", true, "", "");
    let worktree = task.worktree.clone();
    let branch = task.branch.clone();
    alinery_core::mutate_task(&repo, &task.slug, "archive test task", |task| {
        task.archived = true;
        Ok(())
    })
    .unwrap();

    let result = alinery_core::purge_archived_storage(&repo, &|_, _| {}).unwrap();
    assert_eq!(result.deleted_tasks, 1);
    assert!(!task_dir(&repo, &task.slug).exists());

    let push_error = crate::record_pushed_url_in(&repo, &task.slug, &branch, "https://example.com/pr/1").unwrap_err();
    assert_eq!(push_error, format!("no such task: {}", task.slug));
    let removal_error = crate::record_removed_worktree_in(&repo, &task.slug, &worktree).unwrap_err();
    assert_eq!(removal_error, format!("no such task: {}", task.slug));
    assert!(!task_dir(&repo, &task.slug).exists());

    let _ = fs::remove_dir_all(repo);
}

#[test]
fn commit_worktree_stages_and_commits_then_reports_clean() {
    let repo = init_git_test_repo("commit-worktree");
    let task = create_task_for_test(&repo, "Commit Demo", true, "", "");

    fs::write(Path::new(&task.worktree).join("new-file.txt"), "hello\n").unwrap();
    commit_worktree_in(&repo, task.slug.clone(), "test commit".into()).expect("commit succeeds");

    let status = git_cmd(&task.worktree).args(["status", "--porcelain"]).output().unwrap();
    assert!(String::from_utf8_lossy(&status.stdout).trim().is_empty(), "worktree clean after commit");

    let log = git_cmd(&task.worktree).args(["log", "-1", "--format=%s"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&log.stdout).trim(), "test commit");

    // Nothing changed since -> git's own "nothing to commit" surfaces verbatim.
    let err = commit_worktree_in(&repo, task.slug.clone(), "again".into()).unwrap_err();
    assert!(err.contains("nothing to commit"), "unexpected error: {err}");

    let _ = fs::remove_dir_all(&repo);
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

#[test]
fn default_base_branch_falls_back_to_main_without_an_origin_head() {
    // A fresh local repo has no origin/HEAD. The PR compare URL still needs a base, and
    // guessing "main" is better than failing the whole flow.
    let repo = init_git_test_repo("default-base-branch");
    assert_eq!(crate::default_base_branch(&repo), "main");
}

#[test]
fn default_base_branch_reads_origin_head_when_it_is_set() {
    let repo = init_git_test_repo("default-base-branch-origin");
    // What `git remote set-head origin` leaves behind. symbolic-ref creates the file
    // itself; pre-creating an empty one at that path makes it refuse.
    let out = git_cmd(&repo)
        .args(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"])
        .output()
        .unwrap();
    assert!(out.status.success(), "symbolic-ref failed: {}", String::from_utf8_lossy(&out.stderr));

    assert_eq!(crate::default_base_branch(&repo), "trunk");
}

#[test]
fn pull_request_batch_bounds_concurrency_deduplicates_and_isolates_errors() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Condvar};

    let mut refs: Vec<_> = (0..12)
        .map(|index| crate::TaskActivityRef {
            repo_path: format!("/repo-{}", index % 2),
            task_slug: format!("task-{}", index / 2),
        })
        .collect();
    refs.push(crate::TaskActivityRef {
        repo_path: "/repo-0".into(),
        task_slug: "task-0".into(),
    });
    let active = AtomicUsize::new(0);
    let peak = AtomicUsize::new(0);
    let seen = Mutex::new(Vec::new());
    let release = (Mutex::new(false), Condvar::new());
    let (started_tx, started_rx) = mpsc::channel();
    let (started, snapshots) = std::thread::scope(|scope| {
        let worker = scope.spawn(|| {
            crate::task_pull_request_snapshots_with(refs, |reference| {
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(count, Ordering::SeqCst);
                seen.lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(crate::task_activity_key(&reference.repo_path, &reference.task_slug));
                started_tx.send(()).unwrap();
                let _released = release
                    .1
                    .wait_while(release.0.lock().unwrap_or_else(|e| e.into_inner()), |released| !*released)
                    .unwrap_or_else(|e| e.into_inner());
                active.fetch_sub(1, Ordering::SeqCst);
                if reference.task_slug == "task-0" {
                    if reference.repo_path == "/repo-0" {
                        return Err("lookup failed".into());
                    }
                    return Ok(Some(crate::PullRequest {
                        number: 42,
                        url: "https://github.com/team/project/pull/42".into(),
                        state: crate::PullRequestState::Open,
                    }));
                }
                Ok(None)
            })
        });
        // Hold lookups open until four start; release even on failure so a serial
        // regression fails an assertion instead of leaving the test deadlocked.
        let started = (0..4).all(|_| started_rx.recv_timeout(Duration::from_secs(10)).is_ok());
        *release.0.lock().unwrap_or_else(|e| e.into_inner()) = true;
        release.1.notify_all();
        (started, worker.join().unwrap())
    });
    assert!(started, "four independent lookups must start before any completes");
    assert_eq!(peak.load(Ordering::SeqCst), 4, "the batch must not exceed four concurrent lookups");
    let mut seen = seen.into_inner().unwrap();
    assert_eq!(seen.len(), 12, "duplicate references must not trigger another lookup");
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), 12);
    assert_eq!(snapshots.len(), 12);
    assert_eq!(snapshots["/repo-0:task-0"].error.as_deref(), Some("lookup failed"));
    assert!(snapshots["/repo-0:task-0"].pr.is_none());
    assert_eq!(snapshots["/repo-1:task-0"].pr.as_ref().unwrap().number, 42);
    for (key, snapshot) in &snapshots {
        if key != "/repo-0:task-0" {
            assert!(snapshot.error.is_none(), "one failure must not discard unrelated results");
        }
        if !key.ends_with(":task-0") {
            assert!(snapshot.pr.is_none());
        }
    }
    assert!(crate::task_pull_request_snapshots_with(vec![], |_| panic!("empty batch must not look up a task")).is_empty());
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
fn discovery_persists_real_link_and_queries_it_after_branch_removal() {
    let repo = init_git_test_repo("pr-discovery");
    let mut task = create_task_for_test(&repo, "PR discovery", false, "", "");
    task.pr_url = "https://github.com/team/project/compare/main...feature".into();
    write_task(&repo, &task).unwrap();
    let discovered = crate::task_pull_request_with(
        &repo,
        &task.slug,
        || Ok(Some(("team".into(), "project".into()))),
        |_, fields| {
            if fields.contains(&("state", "open")) {
                Ok(serde_json::json!([]))
            } else {
                Ok(serde_json::json!([github_pull_fixture(42, "team", &task.branch, "closed", true)]))
            }
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(discovered.state, crate::PullRequestState::Merged);
    assert_eq!(read_task(&repo, &task.slug).unwrap().pr_url, discovered.url);
    crate::record_pushed_url_in(&repo, &task.slug, &task.branch, "https://github.com/team/project/compare/main...feature").unwrap();
    assert_eq!(read_task(&repo, &task.slug).unwrap().pr_url, discovered.url);
    alinery_core::mutate_task(&repo, &task.slug, "remove task branch", |task| {
        task.branch.clear();
        task.worktree.clear();
        Ok(())
    })
    .unwrap();
    let retained = crate::task_pull_request_with(
        &repo,
        &task.slug,
        || panic!("stored PR must not depend on origin or branch"),
        |endpoint, _| {
            assert_eq!(endpoint, "repos/team/project/pulls/42");
            Ok(github_pull_fixture(42, "team", "deleted-branch", "closed", true))
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(retained, discovered);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn failed_discovery_does_not_look_like_no_pull_request_or_change_the_link() {
    let repo = init_git_test_repo("pr-lookup-error");
    let task = create_task_for_test(&repo, "PR lookup error", false, "", "");
    let error = crate::task_pull_request_with(
        &repo,
        &task.slug,
        || Ok(Some(("team".into(), "project".into()))),
        |_, _| Err("authentication failed".into()),
    )
    .unwrap_err();
    assert_eq!(error, "authentication failed");
    assert_eq!(read_task(&repo, &task.slug).unwrap().pr_url, task.pr_url);
    let no_pr = crate::task_pull_request_with(&repo, &task.slug, || Ok(Some(("team".into(), "project".into()))), |_, _| Ok(serde_json::json!([]))).unwrap();
    assert_eq!(no_pr, None);
    assert_eq!(read_task(&repo, &task.slug).unwrap().pr_url, task.pr_url);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn discovery_does_not_overwrite_concurrent_branch_or_link_edits() {
    let repo = init_git_test_repo("pr-discovery-race");
    let task = create_task_for_test(&repo, "PR discovery race", false, "", "");
    alinery_core::mutate_task(&repo, &task.slug, "replace branch", |task| {
        task.branch = "replacement".into();
        Ok(())
    })
    .unwrap();
    assert!(crate::record_discovered_pull_request_in(&repo, &task.slug, &task.branch, &task.pr_url, "https://github.com/team/project/pull/42").is_err());
    let changed = read_task(&repo, &task.slug).unwrap();
    assert_eq!(changed.branch, "replacement");
    assert_eq!(changed.pr_url, task.pr_url);
    crate::set_pr_url_in(&repo, task.slug.clone(), "https://github.com/team/project/pull/99".into()).unwrap();
    assert!(crate::record_discovered_pull_request_in(&repo, &task.slug, &changed.branch, &changed.pr_url, "https://github.com/team/project/pull/42").is_err());
    assert_eq!(read_task(&repo, &task.slug).unwrap().pr_url, "https://github.com/team/project/pull/99");
    fs::remove_dir_all(task_dir(&repo, &task.slug)).unwrap();
    assert!(crate::record_discovered_pull_request_in(&repo, &task.slug, &changed.branch, &changed.pr_url, "https://github.com/team/project/pull/42").is_err());
    assert!(!task_dir(&repo, &task.slug).exists());
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn malformed_pull_request_state_and_url_are_errors_not_missing_prs() {
    let mut pull = github_pull_fixture(42, "team", "feature", "unknown", false);
    assert!(crate::select_branch_pull_request(&serde_json::json!([pull.clone()]), "team", "project", "feature").is_err());
    pull["state"] = serde_json::json!("open");
    pull["html_url"] = serde_json::json!("https://example.com/team/project/pull/42");
    assert!(crate::select_branch_pull_request(&serde_json::json!([pull]), "team", "project", "feature").is_err());
}
