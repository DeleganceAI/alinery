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
