//! Tests for task.rs — tasks, drafts, attachments, board projection, targeted (per-repo) helpers
//!
//! `use super::*` reaches the shared imports and fixtures in tests/mod.rs.
use super::*;
use crate::{
    artifacts_dir, chat_file_stat, copy_chat_attachments_in, duplicate_fail_key, duplicate_task_in, first_step_for_playbook, list_sessions_for_repo, read_chat_image_in,
    write_chat_attachment_bytes_in, CreateTaskResult, FAIL_DUPLICATE_AFTER_WORKTREE, MAX_CHAT_IMAGE_BYTES,
};

#[test]
fn board_task_counts_live_sessions_and_current_phase() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-board-{n}"));
    let slug = "demo";
    fs::create_dir_all(repo.join(".alinery/tasks").join(slug).join("sessions")).unwrap();
    for meta in [
        SessionMeta {
            id: "s1".into(),
            worktree: "/wt".into(),
            created: 1,
            archived: false,
            phase: "research".into(),
            harness: "claude".into(),
            model: String::new(),
            playbook: default_playbook_key(),
            ..Default::default()
        },
        SessionMeta {
            id: "s2".into(),
            worktree: "/wt".into(),
            created: 2,
            archived: true,
            phase: "design".into(),
            harness: "claude".into(),
            model: String::new(),
            playbook: default_playbook_key(),
            ..Default::default()
        },
        SessionMeta {
            id: "s3".into(),
            worktree: "/wt".into(),
            created: 3,
            archived: false,
            phase: "tdd".into(),
            harness: "claude".into(),
            model: String::new(),
            playbook: default_playbook_key(),
            ..Default::default()
        },
        SessionMeta {
            id: "s4".into(),
            worktree: "/wt".into(),
            created: 4,
            archived: false,
            phase: "removed-step".into(),
            harness: "claude".into(),
            model: String::new(),
            playbook: default_playbook_key(),
            ..Default::default()
        },
    ] {
        fs::write(session_meta_path(&repo, slug, &meta.id), serde_json::to_string(&meta).unwrap()).unwrap();
    }
    let task = Task {
        name: "Demo".into(),
        slug: slug.into(),
        requested_slug: String::new(),
        branch: slug.into(),
        worktree: "/wt".into(),
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
    };

    let row = board_task(&repo, "/repo/a", task);

    assert_eq!(row.repo_path, "/repo/a");
    assert_eq!(row.session_count, 3); // includes the stored session for the removed step
    assert_eq!(row.current_phase, "tdd"); // unknown playbook steps do not affect phase derivation
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn board_task_ignores_external_and_generic_colliding_phases() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-board-provenance-{n}"));
    let slug = "demo";
    alinery_core::ensure_playbooks(&repo).unwrap();
    fs::create_dir_all(repo.join(".alinery/tasks").join(slug).join("sessions")).unwrap();
    let task = Task {
        name: "Demo".into(),
        slug: slug.into(),
        requested_slug: String::new(),
        branch: slug.into(),
        worktree: "/wt".into(),
        has_worktree: true,
        created: 1,
        archived: false,
        pr_url: String::new(),
        linear_id: String::new(),
        github_issue: String::new(),
        playbook: "superdevelop".into(),
        auto_advance: vec![],
        draft: false,
        telemetry_id: String::new(),
        parent_task: String::new(),
        active_subtask: String::new(),
        subtask_outcome: String::new(),
        related_tasks: Vec::new(),
    };
    write_task(&repo, &task).unwrap();

    for meta in [
        serde_json::json!({
            "id": "primary-tdd",
            "worktree": "/wt",
            "created": 1,
            "phase": "tdd",
            "harness": "claude",
            "playbook": "superdevelop",
            "generic": false
        }),
        serde_json::json!({
            "id": "external-implementation",
            "worktree": "/wt",
            "created": 2,
            "phase": "implementation",
            "harness": "claude",
            "playbook": "one-shot",
            "generic": false
        }),
        serde_json::json!({
            "id": "generic-implementation",
            "worktree": "/wt",
            "created": 3,
            "phase": "implementation",
            "harness": "claude",
            "playbook": "superdevelop",
            "generic": true
        }),
    ] {
        let id = meta["id"].as_str().unwrap();
        fs::write(session_meta_path(&repo, slug, id), serde_json::to_string(&meta).unwrap()).unwrap();
    }

    let row = board_task(&repo, "/repo/a", task.clone());

    assert_eq!(row.session_count, 3);
    assert_eq!(row.current_phase, "tdd");
    assert_eq!(row.current_column_key, "planning");
    assert_eq!(row.playbook_title, "SuperDevelop");
    assert_eq!(row.current_step_title, "Define Tests");
    assert_eq!(row.latest_session_title, "Generic");
    assert_eq!(row.latest_session_column_key, "");

    let generic_path = session_meta_path(&repo, slug, "generic-implementation");
    let mut generic: SessionMeta = serde_json::from_str(&fs::read_to_string(&generic_path).unwrap()).unwrap();
    generic.archived = true;
    fs::write(&generic_path, serde_json::to_string(&generic).unwrap()).unwrap();

    let row = board_task(&repo, "/repo/a", task);
    assert_eq!(row.session_count, 2);
    assert_eq!(row.current_phase, "tdd");
    assert_eq!(row.current_column_key, "planning");
    assert_eq!(row.latest_session_title, "Implementation");
    assert_eq!(row.latest_session_column_key, "implementation");
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn board_task_ignores_unknown_phase_and_uses_first_column() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-board-other-{n}"));
    let slug = "demo";
    fs::create_dir_all(repo.join(".alinery/tasks").join(slug).join("sessions")).unwrap();
    let meta = SessionMeta {
        id: "s1".into(),
        worktree: "/wt".into(),
        created: 1,
        archived: false,
        phase: "mystery".into(),
        harness: "claude".into(),
        model: String::new(),
        playbook: default_playbook_key(),
        ..Default::default()
    };
    fs::write(session_meta_path(&repo, slug, &meta.id), serde_json::to_string(&meta).unwrap()).unwrap();
    let task = Task {
        name: "Demo".into(),
        slug: slug.into(),
        requested_slug: String::new(),
        branch: slug.into(),
        worktree: "/wt".into(),
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
    };
    let row = board_task(&repo, "/repo/a", task);
    assert_eq!(row.session_count, 1);
    assert_eq!(row.current_phase, "");
    assert_eq!(row.current_column_key, "research-design");
    assert_eq!(row.playbook_title, "SuperDevelop");
    assert_eq!(row.current_step_title, "Clarify");
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn create_task_worktree_toggle_and_name_dedupe() {
    let repo = init_git_test_repo("create-task-toggle");

    // Toggle ON, blank names: branch and worktree both default to the slug, and a real
    // worktree checkout exists on disk and in `git worktree list`.
    let t1 = create_task_for_test(&repo, "Demo Task", true, "", "");
    assert!(t1.has_worktree);
    assert_eq!(t1.branch, t1.slug);
    assert!(Path::new(&t1.worktree).exists());
    let list = git_cmd(&repo).args(["worktree", "list"]).output().unwrap();
    assert!(String::from_utf8_lossy(&list.stdout).contains(&t1.slug));

    // Toggle OFF: branch is created directly in the main repo (worktree == repo path,
    // no new dir under .alinery/worktrees/), and the repo's checked-out branch switches.
    let t2 = create_task_for_test(&repo, "Second Task", false, "", "");
    assert!(!t2.has_worktree);
    assert_eq!(t2.worktree, repo.to_string_lossy().to_string());
    assert!(!worktrees_dir(&repo).join(&t2.slug).exists());
    let head = git_cmd(&repo).args(["rev-parse", "--abbrev-ref", "HEAD"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), t2.branch);

    // Reusing an existing branch name: never checked out as-is, a random suffix is
    // appended instead.
    let t3 = create_task_for_test(&repo, "Third Task", true, &t1.branch, "");
    assert_ne!(t3.branch, t1.branch);
    assert!(t3.branch.starts_with(&format!("{}-", t1.branch)));

    // Reusing an existing worktree folder name: same treatment.
    let t4 = create_task_for_test(&repo, "Fourth Task", true, "", &t1.slug);
    let t4_leaf = Path::new(&t4.worktree).file_name().unwrap().to_string_lossy().to_string();
    assert_ne!(t4_leaf, t1.slug);
    assert!(t4_leaf.starts_with(&format!("{}-", t1.slug)));

    // A worktree name that would escape .alinery/worktrees/ is rejected outright.
    let result = create_task_in(
        &repo,
        "Bad Name Task".into(),
        "".into(),
        "".into(),
        vec![],
        "".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        "".into(),
        "../evil".into(),
    );
    let err = match result {
        Err(e) => e,
        Ok(_) => panic!("expected an error for an escaping worktree name"),
    };
    assert!(err.contains("invalid worktree name"), "unexpected error: {err}");

    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn task_without_draft_field_defaults_false() {
    let old = r#"name = "Old"
slug = "old"
branch = "old"
worktree = "/wt"
created = 1
"#;
    let task: Task = toml::from_str(old).unwrap();
    assert!(!task.draft);
}

#[test]
fn read_task_opt_returns_none_for_a_missing_task() {
    let repo = init_git_test_repo("read-task-opt-missing");
    assert_eq!(read_task_opt(&repo, "no-such-task"), Ok(None));
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn read_task_opt_returns_err_for_an_unparseable_task_md() {
    let repo = init_git_test_repo("read-task-opt-bad-toml");
    fs::create_dir_all(task_dir(&repo, "bad")).unwrap();
    fs::write(task_dir(&repo, "bad").join("task.md"), "not valid toml {{{").unwrap();
    let err = read_task_opt(&repo, "bad").expect_err("unparseable task.md must be Err, not None");
    assert!(err.contains("parse"), "unexpected error: {err}");
    assert!(err.contains("task.md"), "unexpected error: {err}");
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn read_task_opt_returns_some_for_a_real_task() {
    let repo = init_git_test_repo("read-task-opt-real");
    let task = create_task_for_test(&repo, "Real Task", true, "", "");
    assert_eq!(read_task_opt(&repo, &task.slug), Ok(Some(task)));
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn board_task_draft_uses_research_design_column() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-board-draft-{n}"));
    let slug = "my-draft";
    fs::create_dir_all(repo.join(".alinery/tasks").join(slug)).unwrap();
    let task = Task {
        name: "My Draft".into(),
        slug: slug.into(),
        requested_slug: String::new(),
        branch: String::new(),
        worktree: String::new(),
        has_worktree: false,
        created: 1,
        archived: false,
        pr_url: String::new(),
        linear_id: String::new(),
        github_issue: String::new(),
        playbook: default_playbook_key(),
        auto_advance: vec![],
        draft: true,
        telemetry_id: String::new(),
        parent_task: String::new(),
        active_subtask: String::new(),
        subtask_outcome: String::new(),
        related_tasks: Vec::new(),
    };
    write_task(&repo, &task).unwrap();

    let row = board_task(&repo, "/repo/a", task);

    assert!(row.task.draft);
    assert_eq!(row.current_column_key, "research-design");
    assert_eq!(row.current_column_title, "Research & Design");
    assert_eq!(row.session_count, 0);
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn board_task_draft_ignores_playbook_sessions_for_column() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-board-draft-sessions-{n}"));
    let slug = "draft-with-sessions";
    fs::create_dir_all(repo.join(".alinery/tasks").join(slug).join("sessions")).unwrap();
    let meta = SessionMeta {
        id: "s1".into(),
        worktree: "/wt".into(),
        created: 1,
        archived: false,
        phase: "tdd".into(),
        harness: "claude".into(),
        model: String::new(),
        playbook: default_playbook_key(),
        ..Default::default()
    };
    fs::write(session_meta_path(&repo, slug, &meta.id), serde_json::to_string(&meta).unwrap()).unwrap();
    let task = Task {
        name: "Draft".into(),
        slug: slug.into(),
        requested_slug: String::new(),
        branch: String::new(),
        worktree: String::new(),
        has_worktree: false,
        created: 1,
        archived: false,
        pr_url: String::new(),
        linear_id: String::new(),
        github_issue: String::new(),
        playbook: default_playbook_key(),
        auto_advance: vec![],
        draft: true,
        telemetry_id: String::new(),
        parent_task: String::new(),
        active_subtask: String::new(),
        subtask_outcome: String::new(),
        related_tasks: Vec::new(),
    };
    write_task(&repo, &task).unwrap();

    let row = board_task(&repo, "/repo/a", task);

    assert_eq!(row.current_phase, "tdd");
    assert_eq!(row.current_column_key, "research-design");
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn list_tasks_for_repo_returns_draft_flag() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-list-draft-{n}"));
    fs::create_dir_all(repo.join(".alinery/tasks/drafty")).unwrap();
    write_task(
        &repo,
        &Task {
            name: "Drafty".into(),
            slug: "drafty".into(),
            requested_slug: String::new(),
            branch: String::new(),
            worktree: String::new(),
            has_worktree: false,
            created: 42,
            archived: false,
            pr_url: String::new(),
            linear_id: String::new(),
            github_issue: String::new(),
            playbook: default_playbook_key(),
            auto_advance: vec![],
            draft: true,
            telemetry_id: String::new(),
            parent_task: String::new(),
            active_subtask: String::new(),
            subtask_outcome: String::new(),
            related_tasks: Vec::new(),
        },
    )
    .unwrap();

    let tasks = list_tasks_for_repo(&repo).unwrap();
    assert_eq!(tasks.len(), 1);
    assert!(tasks[0].draft);
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn write_draft_in_rejects_empty_name() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-write-draft-empty-{n}"));
    fs::create_dir_all(&repo).unwrap();

    let err = write_draft_in(
        &repo,
        "  ".into(),
        "desc".into(),
        "".into(),
        "".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        "".into(),
        "".into(),
    )
    .unwrap_err();
    assert!(err.contains("empty"), "unexpected error: {err}");
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn write_draft_in_writes_task_md_with_draft_true() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-write-draft-{n}"));
    fs::create_dir_all(&repo).unwrap();
    alinery_core::ensure_playbooks(&repo).unwrap();

    let task = write_draft_in(
        &repo,
        "Autosave Me".into(),
        "partial desc".into(),
        "".into(),
        "ENG-1".into(),
        "owner/repo#9".into(),
        default_playbook_key(),
        "claude".into(),
        "opus".into(),
        Some(vec!["tdd".into()]),
        false,
        "feat/x".into(),
        "wt-x".into(),
    )
    .expect("write draft");

    assert!(task.draft);
    assert_eq!(task.name, "Autosave Me");
    assert_eq!(task.slug, "autosave-me");
    assert_eq!(task.linear_id, "ENG-1");
    assert_eq!(task.github_issue, "owner/repo#9");
    assert!(!task.has_worktree);
    assert!(task.worktree.is_empty());

    let raw = fs::read_to_string(repo.join(".alinery/tasks/autosave-me/task.md")).unwrap();
    assert!(raw.contains("draft = true"), "task.md must contain draft = true");
    assert!(!repo.join(".alinery/tasks/autosave-me/sessions").exists());
    assert!(!repo.join(".alinery/worktrees").exists() || fs::read_dir(worktrees_dir(&repo)).map(|mut d| d.next().is_none()).unwrap_or(true));
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn write_draft_in_updates_same_slug() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-write-draft-update-{n}"));
    fs::create_dir_all(&repo).unwrap();
    alinery_core::ensure_playbooks(&repo).unwrap();

    let first = write_draft_in(
        &repo,
        "Same Name".into(),
        "v1".into(),
        "".into(),
        "".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        "".into(),
        "".into(),
    )
    .unwrap();
    let second = write_draft_in(
        &repo,
        "Same Name".into(),
        "v2".into(),
        "".into(),
        "".into(),
        "".into(),
        default_playbook_key(),
        "codex".into(),
        "gpt".into(),
        None,
        false,
        "".into(),
        "".into(),
    )
    .unwrap();

    assert_eq!(first.slug, second.slug);
    let tasks = list_tasks_for_repo(&repo).unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].slug, first.slug);
    assert!(tasks[0].draft);
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn archived_draft_is_not_reused_by_same_name_autosave() {
    let repo = init_git_test_repo("archived-draft-autosave");
    alinery_core::ensure_playbooks(&repo).unwrap();
    let archived = write_draft_in(
        &repo,
        "Archived Draft".into(),
        "keep this body".into(),
        "".into(),
        "ENG-1".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        false,
        "".into(),
        "".into(),
    )
    .unwrap();
    alinery_core::mutate_task(&repo, &archived.slug, "archive test draft", |task| {
        task.archived = true;
        Ok(())
    })
    .unwrap();

    let replacement = write_draft_in(
        &repo,
        "Archived Draft".into(),
        "new body".into(),
        "".into(),
        "ENG-2".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        false,
        "".into(),
        "".into(),
    )
    .unwrap();

    assert_ne!(replacement.slug, archived.slug);
    assert!(replacement.draft);
    assert!(!replacement.archived);
    let preserved = read_task(&repo, &archived.slug).unwrap();
    assert!(preserved.draft);
    assert!(preserved.archived);
    assert_eq!(preserved.linear_id, "ENG-1");
    let ticket = fs::read_to_string(artifacts_dir(&repo, &archived.slug).join("00-ticket.md")).unwrap();
    assert_eq!(ticket, "# Archived Draft\n\nkeep this body\n");
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn archived_draft_is_not_promoted_by_same_name_create() {
    let repo = init_git_test_repo("archived-draft-create");
    alinery_core::ensure_playbooks(&repo).unwrap();
    let archived = write_draft_in(
        &repo,
        "Archived Draft".into(),
        "keep this body".into(),
        "".into(),
        "ENG-1".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        "".into(),
        "".into(),
    )
    .unwrap();
    alinery_core::mutate_task(&repo, &archived.slug, "archive test draft", |task| {
        task.archived = true;
        Ok(())
    })
    .unwrap();

    let created = create_task_in_with_draft_slug(
        &repo,
        None,
        &archived.slug,
        "",
        "Archived Draft".into(),
        "new body".into(),
        "".into(),
        vec![],
        "ENG-2".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        "".into(),
        "".into(),
    )
    .unwrap();

    assert_ne!(created.task.slug, archived.slug);
    assert!(!created.task.draft);
    assert!(!created.task.archived);
    let preserved = read_task(&repo, &archived.slug).unwrap();
    assert!(preserved.draft);
    assert!(preserved.archived);
    assert_eq!(preserved.linear_id, "ENG-1");
    let ticket = fs::read_to_string(artifacts_dir(&repo, &archived.slug).join("00-ticket.md")).unwrap();
    assert_eq!(ticket, "# Archived Draft\n\nkeep this body\n");
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn draft_duplicate_regression_write_draft_reuses_suffixed_draft_when_base_slug_is_task() {
    let repo = init_git_test_repo("draft-duplicate-reuse");
    alinery_core::ensure_playbooks(&repo).unwrap();
    let real = create_task_for_test(&repo, "Duplicate Title", false, "", "");
    assert_eq!(real.slug, "duplicate-title");
    assert!(!real.draft);

    let first = write_draft_in(
        &repo,
        "Duplicate Title".into(),
        "first autosave".into(),
        "".into(),
        "ENG-1".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        false,
        "".into(),
        "".into(),
    )
    .unwrap();
    let second = write_draft_in(
        &repo,
        "Duplicate Title".into(),
        "second autosave".into(),
        "".into(),
        "ENG-2".into(),
        "".into(),
        default_playbook_key(),
        "codex".into(),
        "gpt".into(),
        None,
        false,
        "".into(),
        "".into(),
    )
    .unwrap();

    assert_eq!(first.slug, "duplicate-title-2");
    assert_eq!(second.slug, first.slug);
    let tasks = list_tasks_for_repo(&repo).unwrap();
    let drafts_for_title: Vec<_> = tasks.iter().filter(|task| task.name == "Duplicate Title" && task.draft).collect();
    assert_eq!(drafts_for_title.len(), 1, "{tasks:?}");
    assert_eq!(drafts_for_title[0].slug, first.slug);
    assert!(tasks.iter().any(|task| task.slug == real.slug && !task.draft));
    assert!(!task_dir(&repo, "duplicate-title-3").exists());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn draft_duplicate_regression_supplied_draft_slug_updates_in_place_when_base_slug_is_task() {
    let repo = init_git_test_repo("draft-duplicate-update-supplied");
    alinery_core::ensure_playbooks(&repo).unwrap();
    let real = create_task_for_test(&repo, "Supplied Draft", false, "", "");
    assert_eq!(real.slug, "supplied-draft");
    assert!(!real.draft);

    let draft = write_draft_in(
        &repo,
        "Supplied Draft".into(),
        "first body".into(),
        "".into(),
        "ENG-1".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        false,
        "".into(),
        "".into(),
    )
    .unwrap();
    assert_eq!(draft.slug, "supplied-draft-2");

    let updated = write_draft_in_with_slug(
        &repo,
        None,
        &draft.slug,
        "",
        "Supplied Draft".into(),
        "updated body".into(),
        "".into(),
        "ENG-2".into(),
        "owner/repo#42".into(),
        default_playbook_key(),
        "codex".into(),
        "gpt".into(),
        None,
        false,
        "updated-branch".into(),
        "".into(),
    )
    .unwrap();

    assert_eq!(updated.slug, draft.slug);
    assert!(updated.draft);
    assert_eq!(updated.linear_id, "ENG-2");
    assert_eq!(updated.github_issue, "owner/repo#42");
    let ticket = fs::read_to_string(repo.join(".alinery/tasks").join(&draft.slug).join("artifacts/00-ticket.md")).unwrap();
    assert_eq!(ticket, "# Supplied Draft\n\nupdated body\n");
    let tasks = list_tasks_for_repo(&repo).unwrap();
    assert_eq!(tasks.iter().filter(|task| task.name == "Supplied Draft" && task.draft).count(), 1, "{tasks:?}");
    assert!(!task_dir(&repo, "supplied-draft-3").exists());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn draft_duplicate_regression_create_task_promotes_supplied_draft_slug_when_base_slug_is_task() {
    let repo = init_git_test_repo("draft-duplicate-promote-supplied");
    alinery_core::ensure_playbooks(&repo).unwrap();
    let real = create_task_for_test(&repo, "Promote Occupied", false, "", "");
    assert_eq!(real.slug, "promote-occupied");
    assert!(!real.draft);

    let draft = write_draft_in(
        &repo,
        "Promote Occupied".into(),
        "draft body".into(),
        "".into(),
        "".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        false,
        "".into(),
        "".into(),
    )
    .unwrap();
    assert_eq!(draft.slug, "promote-occupied-2");
    assert!(draft.draft);

    let result = create_task_in_with_draft_slug(
        &repo,
        None,
        &draft.slug,
        "",
        "Promote Occupied".into(),
        "final body".into(),
        "".into(),
        vec![],
        "ENG-3".into(),
        "owner/repo#7".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        false,
        "promote-occupied-draft".into(),
        "".into(),
    )
    .expect("promote supplied draft slug");

    assert_eq!(result.task.slug, draft.slug);
    assert!(!result.task.draft);
    assert!(!result.session.id.is_empty());
    let on_disk = read_task(&repo, &draft.slug).unwrap();
    assert!(!on_disk.draft);

    let tasks = list_tasks_for_repo(&repo).unwrap();
    let tasks_for_title: Vec<_> = tasks.iter().filter(|task| task.name == "Promote Occupied").collect();
    assert_eq!(tasks_for_title.len(), 2, "{tasks:?}");
    assert_eq!(tasks_for_title.iter().filter(|task| task.draft).count(), 0);
    assert!(tasks_for_title.iter().any(|task| task.slug.as_str() == real.slug.as_str() && !task.draft));
    assert!(tasks_for_title.iter().any(|task| task.slug.as_str() == draft.slug.as_str() && !task.draft));
    assert!(!task_dir(&repo, "promote-occupied-3").exists());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn create_task_uses_visible_slug_avoids_ref_prefixes_and_preserves_draft_on_failure() {
    let repo = init_git_test_repo("visible-task-slug");
    alinery_core::ensure_playbooks(&repo).unwrap();
    let out = git_cmd(&repo).args(["branch", "fix/existing"]).output().unwrap();
    assert!(out.status.success());

    let draft = write_draft_in_with_slug(
        &repo,
        None,
        "",
        "fix",
        "Fix".into(),
        "".into(),
        "".into(),
        "".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        "".into(),
        "".into(),
    )
    .unwrap();
    assert_eq!(draft.slug, "fix");

    let draft = write_draft_in_with_slug(
        &repo,
        None,
        &draft.slug,
        "fix-sessions-performance",
        "Fix-sessions-performance".into(),
        "".into(),
        "".into(),
        "".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        "".into(),
        "".into(),
    )
    .unwrap();
    let old_draft_slug = draft.slug.clone();
    assert_eq!(draft.requested_slug, "fix-sessions-performance");

    let result = create_task_in_with_draft_slug(
        &repo,
        None,
        &old_draft_slug,
        "fix-sessions-performance",
        "Fix-sessions-performance".into(),
        "".into(),
        "".into(),
        vec![],
        "".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        "".into(),
        "".into(),
    )
    .unwrap();
    assert_eq!(result.task.slug, "fix-sessions-performance");
    assert_eq!(result.task.branch, "fix-sessions-performance");
    assert_eq!(Path::new(&result.task.worktree).file_name().unwrap().to_string_lossy(), "fix-sessions-performance");
    assert!(!task_dir(&repo, &old_draft_slug).exists());

    let collision = create_task_in_with_draft_slug(
        &repo,
        None,
        "",
        "fix",
        "Fix".into(),
        "".into(),
        "".into(),
        vec![],
        "".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        "".into(),
        "".into(),
    )
    .unwrap();
    assert_eq!(collision.task.slug, "fix-2");
    assert_eq!(collision.task.branch, "fix-2");

    let draft = write_draft_in_with_slug(
        &repo,
        None,
        "",
        "keep-me",
        "Keep me".into(),
        "".into(),
        "".into(),
        "".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        "".into(),
        "".into(),
    )
    .unwrap();
    let failed = create_task_in_with_draft_slug(
        &repo,
        None,
        &draft.slug,
        "renamed-keep-me",
        "Renamed keep me".into(),
        "".into(),
        "".into(),
        vec![],
        "".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        "bad..branch".into(),
        "".into(),
    );
    let err = match failed {
        Err(err) => err,
        Ok(_) => panic!("expected invalid branch creation to fail"),
    };
    assert!(err.contains("git worktree add failed"), "{err}");
    assert!(task_dir(&repo, &draft.slug).exists());
    assert!(!task_dir(&repo, "renamed-keep-me").exists());
    assert!(read_task(&repo, &draft.slug).unwrap().draft);

    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn unique_attachment_name_suffixes_before_the_extension() {
    let dir = unique_attachment_temp("attachment-unique");
    assert_eq!(unique_attachment_name(&dir, "trace.log").as_deref(), Some("trace.log"));
    fs::write(dir.join("trace.log"), "one").unwrap();
    assert_eq!(unique_attachment_name(&dir, "trace.log").as_deref(), Some("trace-2.log"));
    fs::write(dir.join("trace-2.log"), "two").unwrap();
    assert_eq!(unique_attachment_name(&dir, "trace.log").as_deref(), Some("trace-3.log"));
    // Extensionless names take a bare suffix.
    fs::write(dir.join("notes"), "n").unwrap();
    assert_eq!(unique_attachment_name(&dir, "notes").as_deref(), Some("notes-2"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn attachment_copy_splits_urls_from_files_and_reports_failures() {
    let repo = unique_attachment_temp("attachment-split");
    let src = repo.join("trace.log");
    fs::write(&src, "hello").unwrap();

    let (urls, copied, failures) = copy_task_attachments(
        &repo,
        "task",
        &[
            "https://example.com/build/42".into(),
            src.to_string_lossy().to_string(),
            "   ".into(),
            String::new(),
            "/definitely/not/here.log".into(),
        ],
    );

    // URLs are recorded verbatim and never fetched; blank entries vanish silently.
    assert_eq!(urls, vec!["https://example.com/build/42".to_string()]);
    assert_eq!(copied, vec!["trace.log".to_string()]);
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(failures[0].starts_with("/definitely/not/here.log — "), "{failures:?}");
    assert_eq!(fs::read_to_string(attachments_of(&repo, "task").join("trace.log")).unwrap(), "hello");
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn attachment_copy_rejects_a_directory_and_an_oversize_file() {
    let repo = unique_attachment_temp("attachment-reject");
    let dir = repo.join("a-directory");
    fs::create_dir_all(&dir).unwrap();
    let big = repo.join("huge.bin");
    fs::File::create(&big).unwrap().set_len(MAX_ATTACHMENT_BYTES + 1).unwrap();
    let exact = repo.join("exactly-max.bin");
    fs::File::create(&exact).unwrap().set_len(MAX_ATTACHMENT_BYTES).unwrap();

    let (urls, copied, failures) = copy_task_attachments(
        &repo,
        "task",
        &[dir.to_string_lossy().to_string(), big.to_string_lossy().to_string(), exact.to_string_lossy().to_string()],
    );

    assert!(urls.is_empty(), "{urls:?}");
    // The per-file check is strictly `>`, so exactly 25 MB is accepted.
    assert_eq!(copied, vec!["exactly-max.bin".to_string()], "{failures:?}");
    assert_eq!(failures.len(), 2, "{failures:?}");
    assert!(failures[0].ends_with(" — not a regular file"), "{failures:?}");
    assert!(failures[1].ends_with(" — larger than 25 MB"), "{failures:?}");
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn attachment_copy_stops_the_batch_at_the_set_cap() {
    let repo = unique_attachment_temp("attachment-batch-cap");
    // Each file sits exactly at the per-file cap, so only the 100 MB set cap can reject
    // one: four fit exactly, the fifth crosses. (Anything larger per file would trip the
    // 25 MB guard first and never reach the set check.)
    assert_eq!(
        MAX_ATTACHMENT_SET_BYTES / MAX_ATTACHMENT_BYTES,
        4,
        "fixture assumes four per-file-cap attachments fit inside the set cap"
    );
    let names = ["1.bin", "2.bin", "3.bin", "4.bin", "5.bin"];
    for name in names {
        fs::File::create(repo.join(name)).unwrap().set_len(MAX_ATTACHMENT_BYTES).unwrap();
    }

    let entries: Vec<String> = names.iter().map(|n| repo.join(n).to_string_lossy().to_string()).collect();
    let (_, copied, failures) = copy_task_attachments(&repo, "task", &entries);

    assert_eq!(copied, &names[..4], "{failures:?}");
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(failures[0].ends_with(" — attachment set would exceed 100 MB"), "{failures:?}");
    // Rejected before fs::copy runs, so batch_bytes only ever counted successful copies.
    assert!(!attachments_of(&repo, "task").join("5.bin").exists());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn attachment_copy_counts_existing_dir_bytes_toward_the_set_cap() {
    let repo = unique_attachment_temp("attachment-existing-set");
    let attach = attachments_of(&repo, "task");
    fs::create_dir_all(&attach).unwrap();
    // 90 MB already on the Attachments tab; a further 20 MB copy must not sneak past
    // a batch_bytes that starts at 0.
    fs::File::create(attach.join("already.bin"))
        .unwrap()
        .set_len(MAX_ATTACHMENT_SET_BYTES - 10 * 1024 * 1024)
        .unwrap();
    let extra = repo.join("extra.bin");
    fs::File::create(&extra).unwrap().set_len(20 * 1024 * 1024).unwrap();

    let (_, copied, failures) = copy_task_attachments(&repo, "task", &[extra.to_string_lossy().to_string()]);

    assert!(copied.is_empty(), "{copied:?}");
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(failures[0].ends_with(" — attachment set would exceed 100 MB"), "{failures:?}");
    assert!(!attach.join("extra.bin").exists());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn attachment_copy_suffixes_a_colliding_basename() {
    let repo = unique_attachment_temp("attachment-collide");
    for (sub, body) in [("a", "from a"), ("b", "from b")] {
        fs::create_dir_all(repo.join(sub)).unwrap();
        fs::write(repo.join(sub).join("trace.log"), body).unwrap();
    }

    let (_, copied, failures) = copy_task_attachments(
        &repo,
        "task",
        &[
            repo.join("a/trace.log").to_string_lossy().to_string(),
            repo.join("b/trace.log").to_string_lossy().to_string(),
        ],
    );

    assert!(failures.is_empty(), "{failures:?}");
    assert_eq!(copied, vec!["trace.log".to_string(), "trace-2.log".to_string()]);
    let attach = attachments_of(&repo, "task");
    assert_eq!(fs::read_to_string(attach.join("trace.log")).unwrap(), "from a");
    assert_eq!(fs::read_to_string(attach.join("trace-2.log")).unwrap(), "from b");
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn copied_attachment_is_byte_identical() {
    let repo = unique_attachment_temp("attachment-bytes");
    let src = repo.join("blob.bin");
    let bytes: Vec<u8> = (0u8..=255).cycle().take(64 * 1024 + 7).collect();
    fs::write(&src, &bytes).unwrap();

    let (_, copied, failures) = copy_task_attachments(&repo, "task", &[src.to_string_lossy().to_string()]);

    assert!(failures.is_empty(), "{failures:?}");
    assert_eq!(copied, vec!["blob.bin".to_string()]);
    assert_eq!(fs::read(attachments_of(&repo, "task").join("blob.bin")).unwrap(), bytes);
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn attachment_copy_creates_no_directory_when_there_is_nothing_local() {
    let repo = unique_attachment_temp("attachment-lazy");
    let (urls, copied, failures) = copy_task_attachments(&repo, "task", &["https://x/y".into(), "  ".into()]);
    assert_eq!(urls, vec!["https://x/y".to_string()]);
    assert!(copied.is_empty(), "{copied:?}");
    assert!(failures.is_empty(), "{failures:?}");
    assert!(!attachments_of(&repo, "task").exists());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn write_chat_attachment_bytes_unique_name() {
    let repo = unique_attachment_temp("chat-write-unique");
    let first = write_chat_attachment_bytes_in(&repo, "task", "note.png", b"one").unwrap();
    let second = write_chat_attachment_bytes_in(&repo, "task", "note.png", b"two").unwrap();
    assert_eq!(first, "note.png");
    assert_eq!(second, "note-2.png");
    let attach = attachments_of(&repo, "task");
    assert_eq!(fs::read(attach.join("note.png")).unwrap(), b"one");
    assert_eq!(fs::read(attach.join("note-2.png")).unwrap(), b"two");
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn write_chat_attachment_bytes_rejects_oversize_file() {
    let repo = unique_attachment_temp("chat-write-oversize");
    let too_big = vec![0u8; (MAX_ATTACHMENT_BYTES as usize) + 1];
    assert!(write_chat_attachment_bytes_in(&repo, "task", "huge.bin", &too_big).is_err());
    assert!(!attachments_of(&repo, "task").join("huge.bin").exists());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn write_chat_attachment_bytes_counts_existing_dir_bytes_toward_the_set_cap() {
    let repo = unique_attachment_temp("chat-write-existing-set");
    let attach = attachments_of(&repo, "task");
    fs::create_dir_all(&attach).unwrap();
    // 100 MB already on disk; a further write must not sneak past a batch_bytes that starts at 0.
    fs::File::create(attach.join("already.bin")).unwrap().set_len(MAX_ATTACHMENT_SET_BYTES).unwrap();
    assert!(write_chat_attachment_bytes_in(&repo, "task", "extra.bin", b"hello").is_err());
    assert!(!attach.join("extra.bin").exists());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn read_chat_image_rejects_oversize_png_before_encoding() {
    let repo = unique_attachment_temp("chat-read-oversize");
    let attach = attachments_of(&repo, "task");
    fs::create_dir_all(&attach).unwrap();
    fs::File::create(attach.join("big.png")).unwrap().set_len(MAX_CHAT_IMAGE_BYTES + 1).unwrap();
    assert!(read_chat_image_in(&repo, "task", "big.png").is_err());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn read_chat_image_rejects_pdf() {
    let repo = unique_attachment_temp("chat-read-pdf");
    let attach = attachments_of(&repo, "task");
    fs::create_dir_all(&attach).unwrap();
    fs::write(attach.join("notes.pdf"), b"%PDF").unwrap();
    assert!(read_chat_image_in(&repo, "task", "notes.pdf").is_err());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn chat_file_stat_regular_file_and_rejects_directory() {
    let repo = unique_attachment_temp("chat-file-stat");
    let file = repo.join("shot.png");
    fs::write(&file, b"hello").unwrap();
    let stat = chat_file_stat(file.to_string_lossy().to_string()).unwrap();
    assert_eq!(stat.name, "shot.png");
    assert_eq!(stat.bytes, 5);
    let dir = repo.join("folder");
    fs::create_dir_all(&dir).unwrap();
    let err = chat_file_stat(dir.to_string_lossy().to_string()).unwrap_err();
    assert!(err.ends_with(" — not a regular file"), "{err}");
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn copy_chat_attachments_copies_files_and_drops_urls() {
    let repo = unique_attachment_temp("chat-copy-drop-url");
    let src = repo.join("trace.log");
    fs::write(&src, "hello").unwrap();
    let result = copy_chat_attachments_in(&repo, "task", &[src.to_string_lossy().to_string(), "https://x/y".into()]).unwrap();
    assert_eq!(result.copied, vec!["trace.log".to_string()]);
    assert!(result.failures.is_empty(), "{:?}", result.failures);
    assert_eq!(fs::read_to_string(attachments_of(&repo, "task").join("trace.log")).unwrap(), "hello");
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn create_task_writes_evidence_and_attachment_lines_into_the_ticket() {
    let repo = init_git_test_repo("create-evidence-ticket");
    let src = repo.join("trace.log");
    fs::write(&src, "boom").unwrap();

    let result = create_task_in(
        &repo,
        "Evidence Task".into(),
        "the ask".into(),
        "stack trace attached".into(),
        vec!["https://ci.example/build/42".into(), src.to_string_lossy().to_string(), "/definitely/not/here.log".into()],
        String::new(),
        String::new(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        false,
        String::new(),
        String::new(),
    )
    .expect("create task with evidence");

    let ticket = fs::read_to_string(repo.join(".alinery/tasks").join(&result.task.slug).join("artifacts/00-ticket.md")).unwrap();
    assert!(ticket.starts_with("# Evidence Task\n\nthe ask\n\n## Evidence & Pointers\n"), "{ticket}");
    assert!(ticket.contains("\nstack trace attached\n"), "{ticket}");
    assert!(ticket.contains("\n- https://ci.example/build/42\n"), "{ticket}");
    assert!(ticket.contains("\n- attachments/trace.log\n"), "{ticket}");
    assert!(ticket.contains("\n- (not copied: /definitely/not/here.log — "), "{ticket}");
    assert_eq!(fs::read_to_string(attachments_of(&repo, &result.task.slug).join("trace.log")).unwrap(), "boom");
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn create_task_with_a_bad_attachment_keeps_the_worktree() {
    let repo = init_git_test_repo("create-bad-attachment");
    let result = create_task_in(
        &repo,
        "Kept Task".into(),
        "the ask".into(),
        String::new(),
        vec!["/definitely/not/here.log".into()],
        String::new(),
        String::new(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        String::new(),
        String::new(),
    )
    .expect("a bad attachment must never fail the create");

    assert_eq!(result.attachment_errors.len(), 1, "{:?}", result.attachment_errors);
    assert!(result.attachment_errors[0].starts_with("/definitely/not/here.log — "), "{:?}", result.attachment_errors);
    // Nothing was rolled back: task dir, task.md, branch and worktree all survive.
    assert!(task_dir(&repo, &result.task.slug).exists());
    assert!(task_dir(&repo, &result.task.slug).join("task.md").exists());
    assert!(!result.task.draft);
    assert!(!result.task.worktree.is_empty());
    assert!(Path::new(&result.task.worktree).is_dir());
    let branches = git_cmd(&repo).args(["branch", "--list", &result.task.branch]).output().unwrap();
    assert!(
        !String::from_utf8_lossy(&branches.stdout).trim().is_empty(),
        "branch {} was rolled back",
        result.task.branch
    );
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn create_task_with_no_evidence_writes_the_legacy_ticket() {
    let repo = init_git_test_repo("create-legacy-ticket");
    let result = create_task_in(
        &repo,
        "Legacy Task".into(),
        "  desc  ".into(),
        String::new(),
        vec![],
        String::new(),
        String::new(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        false,
        String::new(),
        String::new(),
    )
    .expect("create task");

    assert!(result.attachment_errors.is_empty(), "{:?}", result.attachment_errors);
    let ticket = fs::read_to_string(repo.join(".alinery/tasks").join(&result.task.slug).join("artifacts/00-ticket.md")).unwrap();
    assert_eq!(ticket, "# Legacy Task\n\ndesc\n");
    assert!(!attachments_of(&repo, &result.task.slug).exists());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn draft_ticket_carries_evidence_and_never_attachments() {
    let repo = unique_attachment_temp("draft-evidence");
    alinery_core::ensure_playbooks(&repo).unwrap();

    let draft = write_draft_in(
        &repo,
        "Draft Task".into(),
        "the ask".into(),
        "log line one".into(),
        String::new(),
        String::new(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        false,
        String::new(),
        String::new(),
    )
    .unwrap();

    let ticket = fs::read_to_string(repo.join(".alinery/tasks").join(&draft.slug).join("artifacts/00-ticket.md")).unwrap();
    assert_eq!(ticket, "# Draft Task\n\nthe ask\n\n## Evidence & Pointers\n\nlog line one\n");
    assert!(!attachments_of(&repo, &draft.slug).exists());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn delete_draft_in_removes_task_dir() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-delete-draft-{n}"));
    fs::create_dir_all(&repo).unwrap();
    alinery_core::ensure_playbooks(&repo).unwrap();

    let task = write_draft_in(
        &repo,
        "Gone".into(),
        "".into(),
        "".into(),
        "".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        "".into(),
        "".into(),
    )
    .unwrap();
    assert!(task_dir(&repo, &task.slug).exists());

    delete_draft_in(&repo, None, &task.slug).expect("delete draft");
    assert!(!task_dir(&repo, &task.slug).exists());
    assert!(list_tasks_for_repo(&repo).unwrap().is_empty());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn delete_draft_respects_the_task_mutation_lock() {
    let repo = init_git_test_repo("delete-draft-lock");
    let task = write_draft_in(
        &repo,
        "Locked Draft".into(),
        String::new(),
        String::new(),
        String::new(),
        String::new(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        false,
        String::new(),
        String::new(),
    )
    .unwrap();

    alinery_core::with_task_mutation_lock(&repo, "hold draft", || {
        let error = delete_draft_in(&repo, None, &task.slug).unwrap_err();
        assert_eq!(error, "task mutation busy during delete draft");
        assert!(task_dir(&repo, &task.slug).exists());
        Ok(())
    })
    .unwrap();

    let _ = fs::remove_dir_all(repo);
}

#[test]
fn create_task_in_promotes_existing_draft() {
    let repo = init_git_test_repo("promote-draft");
    alinery_core::ensure_playbooks(&repo).unwrap();

    let draft = write_draft_in(
        &repo,
        "Promote Me".into(),
        "ticket body".into(),
        "".into(),
        "".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        "".into(),
        "".into(),
    )
    .unwrap();
    assert!(draft.draft);

    let result = create_task_in(
        &repo,
        "Promote Me".into(),
        "ticket body".into(),
        "".into(),
        vec![],
        "".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        "".into(),
        "".into(),
    )
    .expect("promote draft to real task");

    assert_eq!(result.task.slug, draft.slug);
    assert!(!result.task.draft);
    assert!(result.task.has_worktree);
    assert!(Path::new(&result.task.worktree).exists());
    assert!(!result.session.id.is_empty());

    let on_disk = read_task(&repo, &draft.slug).unwrap();
    assert!(!on_disk.draft);
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn targeted_repo_validation_rejects_unknown_or_non_git_paths() {
    let repo_a = init_git_test_repo("targeted-validation-a");
    let repo_b = init_git_test_repo("targeted-validation-b");
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let outside = std::env::temp_dir().join(format!("alinery-targeted-outside-{nanos}"));
    fs::create_dir_all(&outside).unwrap();
    let known = vec![repo_a.display().to_string(), repo_b.display().to_string()];

    assert_eq!(validate_known_target_repo(&known, &repo_b.display().to_string()).unwrap(), git_top_level(&repo_b).unwrap());
    assert!(validate_known_target_repo(&known, &outside.display().to_string()).is_err());
    assert!(validate_known_target_repo(&known, "/definitely/not/a/repository").is_err());

    let _ = fs::remove_dir_all(repo_a);
    let _ = fs::remove_dir_all(repo_b);
    let _ = fs::remove_dir_all(outside);
}

#[test]
fn targeted_draft_writes_land_only_in_selected_repo() {
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo_a = init_git_test_repo("targeted-draft-a");
    let repo_b = init_git_test_repo("targeted-draft-b");
    alinery_core::ensure_playbooks(&repo_a).unwrap();
    alinery_core::ensure_playbooks(&repo_b).unwrap();
    set_active_repo_global(Some(repo_a.clone())).unwrap();
    let known = vec![repo_a.display().to_string(), repo_b.display().to_string()];
    let target = validate_known_target_repo(&known, &repo_b.display().to_string()).unwrap();

    let draft = write_draft_in(
        &target,
        "Only In B".into(),
        "draft body".into(),
        "".into(),
        "".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        "".into(),
        "".into(),
    )
    .unwrap();

    assert!(task_dir(&repo_b, &draft.slug).join("task.md").exists());
    assert!(!task_dir(&repo_a, &draft.slug).exists());
    assert!(!crate::sessions_dir(&repo_a, &draft.slug).exists());
    assert!(!crate::worktrees_dir(&repo_a).exists());
    assert_eq!(crate::active_repo().unwrap(), repo_a);

    set_active_repo_global(None).unwrap();
    let _ = fs::remove_dir_all(repo_a);
    let _ = fs::remove_dir_all(repo_b);
}

#[test]
fn targeted_create_promotes_only_the_target_draft() {
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo_a = init_git_test_repo("targeted-create-a");
    let repo_b = init_git_test_repo("targeted-create-b");
    alinery_core::ensure_playbooks(&repo_a).unwrap();
    alinery_core::ensure_playbooks(&repo_b).unwrap();
    set_active_repo_global(Some(repo_a.clone())).unwrap();
    let draft_args = |repo: &Path| {
        write_draft_in(
            repo,
            "Same Slug".into(),
            "".into(),
            "".into(),
            "".into(),
            "".into(),
            default_playbook_key(),
            "claude".into(),
            String::new(),
            None,
            true,
            "".into(),
            "".into(),
        )
        .unwrap()
    };
    let draft_a = draft_args(&repo_a);
    let draft_b = draft_args(&repo_b);

    let result = create_task_in(
        &repo_b,
        "Same Slug".into(),
        "".into(),
        "".into(),
        vec![],
        "".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        "".into(),
        "".into(),
    )
    .unwrap();

    assert_eq!(result.task.slug, draft_b.slug);
    assert!(!read_task(&repo_b, &draft_b.slug).unwrap().draft);
    assert!(crate::sessions_dir(&repo_b, &draft_b.slug).join(format!("{}.meta.json", result.session.id)).exists());
    assert!(read_task(&repo_a, &draft_a.slug).unwrap().draft);
    assert!(!crate::sessions_dir(&repo_a, &draft_a.slug).exists());
    assert_eq!(crate::active_repo().unwrap(), repo_a);

    set_active_repo_global(None).unwrap();
    let _ = fs::remove_dir_all(repo_a);
    let _ = fs::remove_dir_all(repo_b);
}

#[test]
fn targeted_draft_cleanup_deletes_only_still_drafts() {
    let repo = init_git_test_repo("targeted-cleanup");
    alinery_core::ensure_playbooks(&repo).unwrap();
    let draft = write_draft_in(
        &repo,
        "Draft Origin".into(),
        "".into(),
        "".into(),
        "".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        "".into(),
        "".into(),
    )
    .unwrap();
    let promoted = create_task_in(
        &repo,
        "Promoted Origin".into(),
        "".into(),
        "".into(),
        vec![],
        "".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        true,
        "".into(),
        "".into(),
    )
    .unwrap()
    .task;

    delete_draft_in(&repo, None, &draft.slug).unwrap();
    assert!(!task_dir(&repo, &draft.slug).exists());
    assert!(delete_draft_in(&repo, None, &promoted.slug).is_err());
    assert!(task_dir(&repo, &promoted.slug).exists());

    let _ = fs::remove_dir_all(repo);
}
#[test]
fn targeted_helpers_do_not_depend_on_active_repo() {
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo_a = init_git_test_repo("targeted-helper-a");
    let repo_b = init_git_test_repo("targeted-helper-b");
    alinery_core::ensure_playbooks(&repo_a).unwrap();
    alinery_core::ensure_playbooks(&repo_b).unwrap();
    git_cmd(&repo_a).args(["remote", "add", "origin", "https://github.com/example/a.git"]).output().unwrap();
    git_cmd(&repo_b).args(["remote", "add", "origin", "https://github.com/example/b.git"]).output().unwrap();
    set_active_repo_global(Some(repo_a.clone())).unwrap();

    assert!(!list_playbooks_in(&repo_b).is_empty());
    let app_config = repo_b.join("app.toml");
    alinery_core::write_global_settings(&app_config, &alinery_core::default_global_settings()).unwrap();
    assert!(!alinery_core::load_harnesses_for(&app_config, &repo_b).is_empty());
    assert_eq!(parse_github_ref("#42", active_github_repo(&repo_b)).unwrap().label(), "example/b#42");
    assert_eq!(crate::active_repo().unwrap(), repo_a);

    set_active_repo_global(None).unwrap();
    let _ = fs::remove_dir_all(repo_a);
    let _ = fs::remove_dir_all(repo_b);
}

fn write_activity_parent_child(repo: &Path) {
    write_activity_task(repo, "parent", "tdd", false);
    write_activity_task(repo, "child", "tdd", false);
    let mut parent = read_task(repo, "parent").unwrap();
    let mut child = read_task(repo, "child").unwrap();
    parent.active_subtask = "child".into();
    child.parent_task = "parent".into();
    write_task(repo, &parent).unwrap();
    write_task(repo, &child).unwrap();

    let manager = SessionMeta {
        id: "manager-session".into(),
        worktree: repo.display().to_string(),
        created: 2,
        archived: false,
        playbook: "superdevelop".into(),
        generic: true,
        subtask_manager: true,
        subtask_slug: "child".into(),
        ..Default::default()
    };
    fs::write(session_meta_path(repo, "parent", &manager.id), serde_json::to_string(&manager).unwrap()).unwrap();
}

fn write_activity_parent_child_grandchild(repo: &Path) {
    write_activity_parent_child(repo);
    write_activity_task(repo, "grandchild", "tdd", false);
    let mut child = read_task(repo, "child").unwrap();
    let mut grandchild = read_task(repo, "grandchild").unwrap();
    child.active_subtask = "grandchild".into();
    grandchild.parent_task = "child".into();
    write_task(repo, &child).unwrap();
    write_task(repo, &grandchild).unwrap();

    let manager = SessionMeta {
        id: "child-manager-session".into(),
        worktree: repo.display().to_string(),
        created: 2,
        archived: false,
        playbook: "superdevelop".into(),
        generic: true,
        subtask_manager: true,
        subtask_slug: "grandchild".into(),
        ..Default::default()
    };
    fs::write(session_meta_path(repo, "child", &manager.id), serde_json::to_string(&manager).unwrap()).unwrap();
}

#[test]
fn task_activity_parent_follows_active_descendants_recursively() {
    let repo = activity_repo("nested-descendant-activity");
    write_activity_parent_child_grandchild(&repo);
    let key = format!("{}:parent", repo.display());
    let parent_manager = activity_status_idle("manager-session");
    let child_manager = activity_status_idle("child-manager-session");

    let running = crate::resolve_task_activity_for_repo(
        &repo,
        &["parent".into()],
        &[parent_manager.clone(), child_manager.clone(), activity_status_busy("grandchild-session")],
    );
    assert_eq!(running.get(&key).unwrap().status, Some(crate::TaskActivityStatus::Running));
    assert_eq!(
        running.get(&key).unwrap().active_session.as_ref().map(|session| session.id.as_str()),
        Some("grandchild-session")
    );

    let mut grandchild_waiting = activity_status_busy("grandchild-session");
    grandchild_waiting.state.agent = alinery_core::AgentState::WaitingForInput {
        correlation_id: "nested-ask".into(),
    };
    let waiting = crate::resolve_task_activity_for_repo(&repo, &["parent".into()], &[parent_manager.clone(), child_manager, grandchild_waiting]);
    assert_eq!(waiting.get(&key).unwrap().status, Some(crate::TaskActivityStatus::WaitingForInput));
    assert_eq!(
        waiting.get(&key).unwrap().active_session.as_ref().map(|session| session.id.as_str()),
        Some("grandchild-session")
    );

    let manager_running = crate::resolve_task_activity_for_repo(
        &repo,
        &["parent".into()],
        &[
            parent_manager.clone(),
            activity_status_busy("child-manager-session"),
            activity_status_idle("grandchild-session"),
        ],
    );
    assert_eq!(manager_running.get(&key).unwrap().status, Some(crate::TaskActivityStatus::Running));
    assert_eq!(
        manager_running.get(&key).unwrap().active_session.as_ref().map(|session| session.id.as_str()),
        Some("child-manager-session")
    );

    let mut manager_waiting = activity_status_busy("child-manager-session");
    manager_waiting.state.agent = alinery_core::AgentState::WaitingForApproval {
        correlation_id: "nested-approval".into(),
    };
    let manager_attention = crate::resolve_task_activity_for_repo(&repo, &["parent".into()], &[parent_manager, manager_waiting, activity_status_idle("grandchild-session")]);
    assert_eq!(manager_attention.get(&key).unwrap().status, Some(crate::TaskActivityStatus::WaitingForApproval));
    assert_eq!(
        manager_attention.get(&key).unwrap().active_session.as_ref().map(|session| session.id.as_str()),
        Some("child-manager-session")
    );

    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_parent_follows_descendant_past_unknown_omp_managers() {
    let repo = activity_repo("nested-unknown-manager-activity");
    write_activity_parent_child_grandchild(&repo);
    let key = format!("{}:parent", repo.display());
    let mut parent_manager = activity_status_idle("manager-session");
    parent_manager.state.agent = alinery_core::AgentState::Unknown;
    let mut child_manager = activity_status_idle("child-manager-session");
    child_manager.state.agent = alinery_core::AgentState::Unknown;

    let activity = crate::resolve_task_activity_for_repo(&repo, &["parent".into()], &[parent_manager, child_manager, activity_status_busy("grandchild-session")]);

    let summary = activity.get(&key).unwrap();
    assert_eq!(summary.status, Some(crate::TaskActivityStatus::Running));
    assert_eq!(summary.active_session.as_ref().map(|session| session.id.as_str()), Some("grandchild-session"));
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_parent_follows_descendant_past_stale_busy_session() {
    let repo = activity_repo("nested-stale-parent-activity");
    write_activity_parent_child(&repo);
    let key = format!("{}:parent", repo.display());
    let mut stale_parent = activity_status_busy("parent-session");
    stale_parent.state.playbook = alinery_core::PlaybookState::Failed { reason: "StaleSource".into() };

    let activity = crate::resolve_task_activity_for_repo(
        &repo,
        &["parent".into()],
        &[stale_parent, activity_status_idle("manager-session"), activity_status_busy("child-session")],
    );

    let summary = activity.get(&key).unwrap();
    assert_eq!(summary.status, Some(crate::TaskActivityStatus::Running));
    assert_eq!(summary.active_session.as_ref().map(|session| session.id.as_str()), Some("child-session"));
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_parent_follows_descendant_past_unsupported_busy_session() {
    let repo = activity_repo("nested-unsupported-parent-activity");
    write_activity_parent_child(&repo);
    let key = format!("{}:parent", repo.display());
    let mut unsupported_parent = activity_status_busy("parent-session");
    unsupported_parent.state.adapter = alinery_core::HarnessAdapter::Unsupported;
    unsupported_parent.state.message_adapter = alinery_core::MessageAdapter::Unsupported;

    let activity = crate::resolve_task_activity_for_repo(
        &repo,
        &["parent".into()],
        &[unsupported_parent, activity_status_idle("manager-session"), activity_status_busy("child-session")],
    );

    let summary = activity.get(&key).unwrap();
    assert_eq!(summary.status, Some(crate::TaskActivityStatus::Running));
    assert_eq!(summary.active_session.as_ref().map(|session| session.id.as_str()), Some("child-session"));
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_failed_busy_session_is_not_active() {
    let repo = activity_repo("failed-busy-session");
    write_activity_task(&repo, "task", "tdd", false);
    let mut failed = activity_status_busy("task-session");
    failed.state.playbook = alinery_core::PlaybookState::Failed { reason: "rejected".into() };

    let activity = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &[failed]);

    let summary = activity_summary(&activity, &repo, "task");
    assert_eq!(summary.status, Some(crate::TaskActivityStatus::Failed));
    assert_eq!(summary.active_session, None);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_parent_runs_when_bound_manager_runs() {
    let repo = activity_repo("manager-running");
    write_activity_parent_child(&repo);
    let key = format!("{}:parent", repo.display());

    let activity = crate::resolve_task_activity_for_repo(&repo, &["parent".into()], &[activity_status_busy("manager-session"), activity_status_idle("child-session")]);

    assert_eq!(activity.get(&key).unwrap().status, Some(crate::TaskActivityStatus::Running));
    let _ = fs::remove_dir_all(repo);
}
#[test]
fn task_activity_bound_manager_attention_precedes_child_activity() {
    let repo = activity_repo("manager-attention");
    write_activity_parent_child(&repo);
    let key = format!("{}:parent", repo.display());
    let child = activity_status_busy("child-session");
    let mut manager = activity_status_busy("manager-session");
    manager.state.agent = alinery_core::AgentState::WaitingForInput {
        correlation_id: "proposal".into(),
    };

    let input = crate::resolve_task_activity_for_repo(&repo, &["parent".into()], &[manager.clone(), child.clone()]);
    assert_eq!(input.get(&key).unwrap().status, Some(crate::TaskActivityStatus::WaitingForInput));

    manager.state.agent = alinery_core::AgentState::WaitingForApproval {
        correlation_id: "approval".into(),
    };
    let approval = crate::resolve_task_activity_for_repo(&repo, &["parent".into()], &[manager, child]);
    assert_eq!(approval.get(&key).unwrap().status, Some(crate::TaskActivityStatus::WaitingForApproval));

    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_parent_uses_child_when_bound_manager_is_not_running() {
    let repo = activity_repo("manager-idle");
    write_activity_parent_child(&repo);
    let key = format!("{}:parent", repo.display());
    let manager = activity_status_idle("manager-session");

    let running = crate::resolve_task_activity_for_repo(&repo, &["parent".into()], &[manager.clone(), activity_status_busy("child-session")]);
    assert_eq!(running.get(&key).unwrap().status, Some(crate::TaskActivityStatus::Running));

    let mut child_waiting = activity_status_busy("child-session");
    child_waiting.state.agent = alinery_core::AgentState::WaitingForInput {
        correlation_id: "child-ask".into(),
    };
    let waiting = crate::resolve_task_activity_for_repo(&repo, &["parent".into()], &[manager, child_waiting]);
    assert_eq!(waiting.get(&key).unwrap().status, Some(crate::TaskActivityStatus::WaitingForInput));

    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_parent_session_precedes_failed_active_child() {
    let repo = activity_repo("parent-session-over-failed-child");
    write_activity_parent_child(&repo);
    let mut child = crate::list_sessions_for_repo(&repo, "child").unwrap().remove(0);
    child.exit_code = Some(1);
    write_activity_session(&repo, "child", child);
    let key = format!("{}:parent", repo.display());

    let activity = crate::resolve_task_activity_for_repo(
        &repo,
        &["parent".into()],
        &[activity_status_idle("manager-session"), activity_status_busy("parent-session")],
    );

    let summary = activity.get(&key).unwrap();
    assert_eq!(summary.status, Some(crate::TaskActivityStatus::Running));
    assert_eq!(summary.active_session.as_ref().map(|session| session.id.as_str()), Some("parent-session"));
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_unbound_manager_drives_parent_after_child_deletion() {
    let repo = activity_repo("unbound-manager");
    write_activity_task(&repo, "parent", "tdd", false);
    let manager = SessionMeta {
        id: "manager-session".into(),
        worktree: repo.display().to_string(),
        created: 2,
        archived: false,
        playbook: "superdevelop".into(),
        generic: true,
        subtask_manager: true,
        ..Default::default()
    };
    fs::write(session_meta_path(&repo, "parent", &manager.id), serde_json::to_string(&manager).unwrap()).unwrap();
    let key = format!("{}:parent", repo.display());

    let running = crate::resolve_task_activity_for_repo(
        &repo,
        &["parent".into()],
        &[activity_status_idle("parent-session"), activity_status_busy("manager-session")],
    );
    assert_eq!(running.get(&key).unwrap().status, Some(crate::TaskActivityStatus::Running));

    let mut manager_waiting = activity_status_busy("manager-session");
    manager_waiting.state.agent = alinery_core::AgentState::WaitingForInput {
        correlation_id: "proposal".into(),
    };
    let waiting = crate::resolve_task_activity_for_repo(&repo, &["parent".into()], &[activity_status_busy("parent-session"), manager_waiting]);
    assert_eq!(waiting.get(&key).unwrap().status, Some(crate::TaskActivityStatus::WaitingForInput));

    let _ = fs::remove_dir_all(repo);
}
fn write_activity_session(repo: &Path, slug: &str, meta: SessionMeta) {
    fs::write(session_meta_path(repo, slug, &meta.id), serde_json::to_string(&meta).unwrap()).unwrap();
}

fn activity_summary<'a>(activity: &'a std::collections::HashMap<String, crate::TaskActivitySummary>, repo: &Path, slug: &str) -> &'a crate::TaskActivitySummary {
    activity.get(&format!("{}:{slug}", repo.display())).unwrap()
}
#[test]
fn task_activity_running_requires_live_process() {
    let repo = activity_repo("running");
    write_activity_task(&repo, "task", "tdd", false);
    let live = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &[activity_status_busy("task-session")]);
    let summary = activity_summary(&live, &repo, "task");
    assert_eq!(summary.status, Some(crate::TaskActivityStatus::Running));
    assert_eq!(summary.active_session.as_ref().map(|session| session.id.as_str()), Some("task-session"));

    let mut exited_busy = activity_status_busy("task-session");
    exited_busy.state.process = alinery_core::ProcessState::Exited { code: Some(1) };
    let exited = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &[exited_busy]);
    assert_eq!(activity_summary(&exited, &repo, "task"), &crate::TaskActivitySummary::default());
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_selects_one_top_status_and_prefers_busy_active_session() {
    let repo = activity_repo("status-precedence");
    write_activity_task(&repo, "task", "tdd", false);
    write_activity_session(
        &repo,
        "task",
        SessionMeta {
            id: "newer-input".into(),
            worktree: repo.display().to_string(),
            created: 20,
            phase: "design".into(),
            playbook: "superdevelop".into(),
            ..Default::default()
        },
    );
    write_activity_session(
        &repo,
        "task",
        SessionMeta {
            id: "newest-approval".into(),
            worktree: repo.display().to_string(),
            created: 30,
            phase: "research".into(),
            playbook: "superdevelop".into(),
            ..Default::default()
        },
    );
    let mut input = activity_status_busy("newer-input");
    input.state.agent = alinery_core::AgentState::WaitingForInput { correlation_id: "ask".into() };
    let mut approval = activity_status_busy("newest-approval");
    approval.state.agent = alinery_core::AgentState::WaitingForApproval {
        correlation_id: "approval".into(),
    };
    approval.state.playbook = alinery_core::PlaybookState::Failed { reason: "boom".into() };

    let activity = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &[approval, activity_status_busy("task-session"), input]);
    let summary = activity_summary(&activity, &repo, "task");
    assert_eq!(summary.status, Some(crate::TaskActivityStatus::WaitingForInput));
    assert_eq!(serde_json::to_value(summary).unwrap()["status"], "waiting_for_input");
    assert_eq!(summary.active_session.as_ref().map(|session| session.id.as_str()), Some("task-session"));
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_unseen_completion_is_primary_and_strictly_newer_than_read() {
    let repo = activity_repo("unseen");
    write_activity_task(&repo, "task", "tdd", false);
    let path = session_meta_path(&repo, "task", "task-session");
    let mut primary: SessionMeta = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    primary.semantic.phase_completed_at = Some(100);
    write_activity_session(&repo, "task", primary.clone());

    let busy = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &[activity_status_busy("task-session")]);
    assert_eq!(activity_summary(&busy, &repo, "task").status, Some(crate::TaskActivityStatus::Running));
    let unread = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &[]);
    assert_eq!(activity_summary(&unread, &repo, "task").status, Some(crate::TaskActivityStatus::Completed));
    primary.notification_read_at = Some(99);
    write_activity_session(&repo, "task", primary.clone());
    let still_unread = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &[]);
    assert_eq!(activity_summary(&still_unread, &repo, "task").status, Some(crate::TaskActivityStatus::Completed));
    primary.notification_read_at = Some(100);
    write_activity_session(&repo, "task", primary);

    write_activity_session(
        &repo,
        "task",
        SessionMeta {
            id: "aux".into(),
            worktree: repo.display().to_string(),
            created: 20,
            generic: true,
            semantic: alinery_core::SemanticCheckpoint {
                phase_completed_at: Some(200),
                ..Default::default()
            },
            ..Default::default()
        },
    );
    let acknowledged_primary = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &[]);
    assert_eq!(activity_summary(&acknowledged_primary, &repo, "task").status, None);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_missing_observation_keeps_only_durable_facts() {
    let repo = activity_repo("durable");
    write_activity_task(&repo, "task", "tdd", false);
    let path = session_meta_path(&repo, "task", "task-session");
    let mut meta: SessionMeta = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    meta.started_at = Some(10);
    meta.exit_code = Some(2);
    meta.ended_at = Some(30);
    meta.semantic.phase_completed_at = Some(20);
    write_activity_session(&repo, "task", meta);

    let activity = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &[]);
    let summary = activity_summary(&activity, &repo, "task");
    assert_eq!(summary.status, Some(crate::TaskActivityStatus::Failed));
    assert!(summary.active_session.is_none());
    let mut acknowledged_exit: SessionMeta = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    acknowledged_exit.notification_read_at = Some(20);
    acknowledged_exit.exit_notification_read_at = Some(30);
    write_activity_session(&repo, "task", acknowledged_exit);
    let acknowledged = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &[]);
    assert_eq!(activity_summary(&acknowledged, &repo, "task"), &crate::TaskActivitySummary::default());
    let path = session_meta_path(&repo, "task", "task-session");
    let mut clean_exit: SessionMeta = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    clean_exit.exit_code = Some(0);
    clean_exit.semantic.phase_completed_at = None;
    write_activity_session(&repo, "task", clean_exit);
    let clean = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &[]);
    assert_eq!(activity_summary(&clean, &repo, "task"), &crate::TaskActivitySummary::default());
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_starting_process_is_running_without_agent_semantics() {
    let repo = activity_repo("starting");
    write_activity_task(&repo, "task", "tdd", false);
    let mut starting = activity_status_unknown("task-session");
    starting.state.process = alinery_core::ProcessState::Starting;
    let activity = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &[starting]);
    let summary = activity_summary(&activity, &repo, "task");
    assert_eq!(summary.status, Some(crate::TaskActivityStatus::Running));
    assert_eq!(summary.active_session.as_ref().map(|session| session.id.as_str()), Some("task-session"));
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_active_ties_use_created_then_descending_id() {
    let repo = activity_repo("active-tie");
    write_activity_task(&repo, "task", "tdd", true);
    for (id, created) in [("s-a", 10), ("s-b", 10), ("s-newer", 20)] {
        write_activity_session(
            &repo,
            "task",
            SessionMeta {
                id: id.into(),
                worktree: repo.display().to_string(),
                created,
                phase: "design".into(),
                playbook: "superdevelop".into(),
                ..Default::default()
            },
        );
    }
    let statuses = [activity_status_busy("s-b"), activity_status_busy("s-newer"), activity_status_busy("s-a")];
    let activity = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &statuses);
    assert_eq!(
        activity_summary(&activity, &repo, "task").active_session.as_ref().map(|session| session.id.as_str()),
        Some("s-newer")
    );
    let without_newer = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &statuses[..1].iter().chain(&statuses[2..]).cloned().collect::<Vec<_>>());
    assert_eq!(
        activity_summary(&without_newer, &repo, "task").active_session.as_ref().map(|session| session.id.as_str()),
        Some("s-b")
    );
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_artifact_alone_does_not_complete() {
    let repo = activity_repo("artifact-no-checkpoint");
    write_activity_task(&repo, "task", "tdd", false);
    fs::write(crate::artifacts_dir(&repo, "task").join("05-tdd.md"), "# TDD\n").unwrap();
    let activity = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &[activity_status_idle("task-session")]);
    assert_eq!(activity_summary(&activity, &repo, "task").status, None);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_archived_sessions_do_not_contribute() {
    let repo = activity_repo("archived");
    write_activity_task(&repo, "task", "tdd", true);
    for id in ["task-session", "archived-input", "archived-approval", "archived-failure", "archived-completion"] {
        let path = session_meta_path(&repo, "task", id);
        let mut meta = if path.exists() {
            serde_json::from_str::<SessionMeta>(&fs::read_to_string(&path).unwrap()).unwrap()
        } else {
            SessionMeta {
                id: id.into(),
                worktree: repo.display().to_string(),
                created: 10,
                ..Default::default()
            }
        };
        meta.archived = true;
        if id == "archived-completion" {
            meta.phase = "tdd".into();
            meta.playbook = "superdevelop".into();
            meta.semantic.phase_completed_at = Some(100);
        }
        write_activity_session(&repo, "task", meta);
    }
    write_activity_session(
        &repo,
        "task",
        SessionMeta {
            id: "inactive".into(),
            worktree: repo.display().to_string(),
            created: 20,
            ..Default::default()
        },
    );
    let mut input = activity_status_busy("archived-input");
    input.state.agent = alinery_core::AgentState::WaitingForInput { correlation_id: "ask".into() };
    let mut approval = activity_status_busy("archived-approval");
    approval.state.agent = alinery_core::AgentState::WaitingForApproval {
        correlation_id: "approval".into(),
    };
    let mut failure = activity_status_idle("archived-failure");
    failure.state.playbook = alinery_core::PlaybookState::Failed { reason: "boom".into() };
    let activity = crate::resolve_task_activity_for_repo(
        &repo,
        &["task".into()],
        &[activity_status_busy("task-session"), input, approval, failure, activity_status_idle("inactive")],
    );
    assert_eq!(activity_summary(&activity, &repo, "task"), &crate::TaskActivitySummary::default());
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_keys_are_repository_qualified_and_refs_deduplicated() {
    let repo_a = activity_repo("qualified-a");
    let repo_b = activity_repo("qualified-b");
    write_activity_task(&repo_a, "same-slug", "tdd", false);
    write_activity_task(&repo_b, "same-slug", "tdd", false);
    let socket_a = activity_list_socket(
        &repo_a,
        Some("{\"sessions\":[{\"id\":\"same-slug-session\",\"process\":{\"state\":\"alive\"},\"agent\":{\"state\":\"busy\"},\"playbook\":{\"state\":\"in_progress\"},\"adapter\":\"omp\",\"message_adapter\":\"omp_bracketed_paste\",\"transport\":\"pty\"}]}\n"),
    );
    let socket_b = activity_list_socket(
        &repo_b,
        Some("{\"sessions\":[{\"id\":\"same-slug-session\",\"process\":{\"state\":\"alive\"},\"agent\":{\"state\":\"idle\"},\"playbook\":{\"state\":\"in_progress\"},\"adapter\":\"omp\",\"message_adapter\":\"omp_bracketed_paste\",\"transport\":\"pty\"}]}\n"),
    );

    let activity = crate::list_task_activity_for_refs(
        &[
            crate::TaskActivityRef {
                repo_path: repo_a.display().to_string(),
                task_slug: "same-slug".into(),
            },
            crate::TaskActivityRef {
                repo_path: repo_a.display().to_string(),
                task_slug: "same-slug".into(),
            },
            crate::TaskActivityRef {
                repo_path: repo_b.display().to_string(),
                task_slug: "same-slug".into(),
            },
        ],
        Some("config"),
    );

    assert_eq!(activity.len(), 2);
    assert_eq!(activity_summary(&activity, &repo_a, "same-slug").status, Some(crate::TaskActivityStatus::Running));
    assert_eq!(activity_summary(&activity, &repo_b, "same-slug"), &crate::TaskActivitySummary::default());
    assert_eq!(socket_a.join().unwrap(), 2);
    assert_eq!(socket_b.join().unwrap(), 2);
    let _ = fs::remove_dir_all(repo_a);
    let _ = fs::remove_dir_all(repo_b);
}

#[test]
fn task_activity_refuses_a_different_app_config_identity() {
    let repo = activity_repo("config-mismatch");
    write_activity_task(&repo, "task", "tdd", false);
    let socket = activity_list_socket_with_identity(
        &repo,
        Some("{\"sessions\":[{\"id\":\"task-session\",\"process\":{\"state\":\"alive\"},\"agent\":{\"state\":\"busy\"},\"playbook\":{\"state\":\"in_progress\"},\"adapter\":\"omp\",\"message_adapter\":\"omp_bracketed_paste\",\"transport\":\"pty\"}]}\n"),
        "other-config",
    );

    let activity = crate::list_task_activity_for_refs(
        &[crate::TaskActivityRef {
            repo_path: repo.display().to_string(),
            task_slug: "task".into(),
        }],
        Some("config"),
    );

    assert_eq!(activity_summary(&activity, &repo, "task"), &crate::TaskActivitySummary::default());
    assert_eq!(socket.join().unwrap(), 2);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_repository_failure_isolated() {
    for failure in ["missing", "malformed", "timeout"] {
        let repo_a = activity_repo(&format!("failure-a-{failure}"));
        let repo_b = activity_repo(&format!("failure-b-{failure}"));
        write_activity_task(&repo_a, "task", "tdd", false);
        write_activity_task(&repo_b, "task", "tdd", false);
        let socket_a = activity_list_socket(
            &repo_a,
            Some("{\"sessions\":[{\"id\":\"task-session\",\"process\":{\"state\":\"alive\"},\"agent\":{\"state\":\"busy\"},\"playbook\":{\"state\":\"in_progress\"},\"adapter\":\"omp\",\"message_adapter\":\"omp_bracketed_paste\",\"transport\":\"pty\"}]}\n"),
        );
        let socket_b = match failure {
            "malformed" => activity_list_socket(&repo_b, Some("{not json}\n")),
            "timeout" => activity_list_socket(&repo_b, None),
            _ => activity_list_socket(&repo_b, Some("{\"sessions\":[]}\n")),
        };
        if failure == "missing" {
            let _ = fs::remove_file(crate::current_alineryd_socket_path(&repo_b));
        }

        let activity = crate::list_task_activity_for_refs(
            &[
                crate::TaskActivityRef {
                    repo_path: repo_a.display().to_string(),
                    task_slug: "task".into(),
                },
                crate::TaskActivityRef {
                    repo_path: repo_b.display().to_string(),
                    task_slug: "task".into(),
                },
            ],
            Some("config"),
        );

        assert_eq!(activity_summary(&activity, &repo_a, "task").status, Some(crate::TaskActivityStatus::Running), "{failure}");
        assert_eq!(activity_summary(&activity, &repo_b, "task"), &crate::TaskActivitySummary::default(), "{failure}");
        assert_eq!(socket_a.join().unwrap(), 2);
        assert_eq!(socket_b.join().unwrap(), if failure == "missing" { 0 } else { 2 });
        let _ = fs::remove_dir_all(repo_a);
        let _ = fs::remove_dir_all(repo_b);
    }
}

fn duplicate_source(repo: &Path, name: &str, harness: &str, model: &str) -> CreateTaskResult {
    create_task_in(
        repo,
        name.into(),
        "description".into(),
        String::new(),
        vec![],
        String::new(),
        String::new(),
        default_playbook_key(),
        harness.into(),
        model.into(),
        Some(vec!["implement".into()]),
        true,
        name.into(),
        name.into(),
    )
    .expect("create duplicate source")
}

fn git_output(repo: &Path, args: &[&str]) -> String {
    let output = git_cmd(repo).args(args).output().expect("run git");
    assert!(output.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[test]
fn duplicate_task_copies_only_original_inputs_and_freshens_identity() {
    let repo = init_git_test_repo("duplicate-inputs");
    let created = duplicate_source(&repo, "prototype", "claude", "model-a");
    let mut source = created.task;
    source.created = 1;
    source.archived = true;
    source.pr_url = "https://example.test/pr/1".into();
    source.linear_id = "LIN-42".into();
    source.github_issue = "owner/repo#7".into();
    source.auto_advance = vec!["implement".into(), "verify".into()];
    source.related_tasks = vec![alinery_core::RelatedTaskRef {
        repo_path: "/other".into(),
        slug: "related-task".into(),
        name: "Related task".into(),
    }];
    write_task(&repo, &source).unwrap();

    let raw_ticket = b"\n# prototype\n\n# repeated\n\0\xff\n";
    fs::write(artifacts_dir(&repo, &source.slug).join("00-ticket.md"), raw_ticket).unwrap();
    fs::create_dir_all(attachments_of(&repo, &source.slug)).unwrap();
    fs::write(attachments_of(&repo, &source.slug).join("trace.bin"), [0, 1, 2, 255]).unwrap();
    fs::write(attachments_of(&repo, &source.slug).join("notes.txt"), b"notes").unwrap();
    fs::write(artifacts_dir(&repo, &source.slug).join("01-research.md"), b"generated").unwrap();
    fs::write(artifacts_dir(&repo, &source.slug).join("03-design.review-001.md"), b"review").unwrap();
    fs::write(sessions_dir(&repo, &source.slug).join("old.scrollback"), b"history").unwrap();
    let mut source_session = created.session;
    source_session.created = 2;
    source_session.started_at = Some(3);
    source_session.ended_at = Some(4);
    source_session.exit_code = Some(0);
    source_session.harness = "claude".into();
    source_session.model = "model-a".into();
    source_session.harness_resume_token = "resume".into();
    fs::write(session_meta_path(&repo, &source.slug, &source_session.id), serde_json::to_string(&source_session).unwrap()).unwrap();

    let duplicate = duplicate_task_in(&repo, &source.slug).expect("duplicate task");
    assert!(duplicate.attachment_errors.is_empty());
    assert_eq!(duplicate.task.name, "prototype D+1");
    assert_eq!(duplicate.task.linear_id, "LIN-42");
    assert_eq!(duplicate.task.github_issue, "owner/repo#7");
    assert_eq!(duplicate.task.playbook, source.playbook);
    assert_eq!(duplicate.task.auto_advance, source.auto_advance);
    assert_eq!(duplicate.task.related_tasks, source.related_tasks);
    assert_eq!(duplicate.task.slug, "prototype-2");
    assert_ne!(duplicate.task.branch, source.branch);
    assert_ne!(duplicate.task.worktree, source.worktree);
    assert!(duplicate.task.has_worktree);
    assert!(!duplicate.task.archived);
    assert!(!duplicate.task.draft);
    assert!(duplicate.task.requested_slug.is_empty());
    assert!(duplicate.task.pr_url.is_empty());
    assert_ne!(duplicate.task.created, source.created);
    assert_eq!(fs::read(artifacts_dir(&repo, &duplicate.task.slug).join("00-ticket.md")).unwrap(), raw_ticket);
    assert_eq!(fs::read(attachments_of(&repo, &duplicate.task.slug).join("trace.bin")).unwrap(), [0, 1, 2, 255]);
    assert_eq!(fs::read(attachments_of(&repo, &duplicate.task.slug).join("notes.txt")).unwrap(), b"notes");
    assert!(!artifacts_dir(&repo, &duplicate.task.slug).join("01-research.md").exists());
    assert!(!artifacts_dir(&repo, &duplicate.task.slug).join("03-design.review-001.md").exists());
    assert!(!sessions_dir(&repo, &duplicate.task.slug).join("old.scrollback").exists());

    let sessions = list_sessions_for_repo(&repo, &duplicate.task.slug).unwrap();
    assert_eq!(sessions.len(), 1);
    let session = &sessions[0];
    assert_ne!(session.id, source_session.id);
    assert_ne!(session.created, source_session.created);
    assert_eq!(session.harness, "omp");
    assert_eq!(session.model, "");
    assert_eq!(session.worktree, duplicate.task.worktree);
    assert_eq!(session.phase, first_step_for_playbook(&repo, &source.playbook));
    assert_eq!(session.started_at, None);
    assert_eq!(session.ended_at, None);
    assert_eq!(session.exit_code, None);
    assert!(session.harness_resume_token.is_empty());
    let _ = git_cmd(&repo).args(["worktree", "remove", "--force", &duplicate.task.worktree]).output();
    let _ = git_cmd(&repo).args(["worktree", "remove", "--force", &source.worktree]).output();
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn archive_task_adapter_refuses_active_parent_and_child() {
    let repo = activity_repo("archive-subtask");
    write_activity_task(&repo, "parent", "tdd", false);
    write_activity_task(&repo, "child", "tdd", false);
    let mut parent = read_task(&repo, "parent").unwrap();
    let mut child = read_task(&repo, "child").unwrap();
    parent.active_subtask = "child".into();
    child.parent_task = "parent".into();
    write_task(&repo, &parent).unwrap();
    write_task(&repo, &child).unwrap();

    assert!(crate::archive_task_in(&repo, "parent").is_err());
    assert_eq!(
        crate::archive_task_in(&repo, "child").unwrap_err(),
        "This task is still active under “parent”. Open the parent task and use its sub-task manager to finish or kill this task."
    );
    assert!(!read_task(&repo, "parent").unwrap().archived);
    assert!(!read_task(&repo, "child").unwrap().archived);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn duplicate_task_streams_managed_attachment_larger_than_create_limit() {
    let repo = init_git_test_repo("duplicate-large-input");
    let source = duplicate_source(&repo, "large-input", "claude", "").task;
    let source_attachments = attachments_of(&repo, &source.slug);
    fs::create_dir_all(&source_attachments).unwrap();
    let source_file = source_attachments.join("manually-managed.bin");
    let large_len = MAX_ATTACHMENT_SET_BYTES + 1;
    fs::File::create(&source_file).unwrap().set_len(large_len).unwrap();

    let duplicate = duplicate_task_in(&repo, &source.slug).expect("duplicate large managed input");
    let copied_file = attachments_of(&repo, &duplicate.task.slug).join("manually-managed.bin");
    assert_eq!(fs::metadata(copied_file).unwrap().len(), large_len);

    let _ = git_cmd(&repo).args(["worktree", "remove", "--force", &duplicate.task.worktree]).output();
    let _ = git_cmd(&repo).args(["worktree", "remove", "--force", &source.worktree]).output();
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn duplicate_task_title_suffix_increments_when_cloning_a_clone() {
    let repo = init_git_test_repo("duplicate-title");
    let source = duplicate_source(&repo, "Prototype", "claude", "").task;

    let first = duplicate_task_in(&repo, &source.slug).unwrap();
    let second = duplicate_task_in(&repo, &first.task.slug).unwrap();
    let third = duplicate_task_in(&repo, &second.task.slug).unwrap();

    assert_eq!(
        (first.task.name.as_str(), first.task.slug.as_str(), first.task.branch.as_str()),
        ("Prototype D+1", "prototype-2", "Prototype-2")
    );
    assert_eq!(
        (second.task.name.as_str(), second.task.slug.as_str(), second.task.branch.as_str()),
        ("Prototype D+2", "prototype-3", "Prototype-3")
    );
    assert_eq!(
        (third.task.name.as_str(), third.task.slug.as_str(), third.task.branch.as_str()),
        ("Prototype D+3", "prototype-4", "Prototype-4")
    );
    assert_eq!(Path::new(&first.task.worktree).file_name().unwrap(), "Prototype-2");
    assert_eq!(Path::new(&second.task.worktree).file_name().unwrap(), "Prototype-3");
    assert_eq!(Path::new(&third.task.worktree).file_name().unwrap(), "Prototype-4");
    for task in [&third.task, &second.task, &first.task, &source] {
        let _ = git_cmd(&repo).args(["worktree", "remove", "--force", &task.worktree]).output();
    }
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn duplicate_task_uses_oldest_primary_creation_session() {
    let repo = init_git_test_repo("duplicate-session");
    let created = duplicate_source(&repo, "session-source", "claude", "old-model");
    fs::remove_file(session_meta_path(&repo, &created.task.slug, &created.session.id)).unwrap();
    let oldest = SessionMeta {
        id: "s-a-oldest".into(),
        created: 10,
        harness: "codex".into(),
        model: "original-model".into(),
        ..created.session.clone()
    };
    let later = SessionMeta {
        id: "s-z-later".into(),
        created: 10,
        harness: "opencode".into(),
        model: "later-model".into(),
        ..created.session.clone()
    };
    let generic = SessionMeta {
        id: "s-generic".into(),
        created: 5,
        generic: true,
        harness: "ds4".into(),
        ..created.session.clone()
    };
    // Write the later session first so provenance cannot depend on directory insertion order.
    for session in [&later, &oldest, &generic] {
        fs::write(session_meta_path(&repo, &created.task.slug, &session.id), serde_json::to_string(session).unwrap()).unwrap();
    }
    // The historical phase no longer exists and the current first step now overrides its harness.
    // Duplication must preserve the recorded launch pair while using the current first step.
    fs::write(
        repo.join(".alinery/playbooks.toml"),
        r#"
version = 1
default = "superdevelop"

[playbooks.superdevelop]
title = "SuperDevelop"
kind = "linear"
default_harness = "claude"
steps = ["replacement"]

[playbooks.superdevelop.step.replacement]
title = "Replacement"
prompt = ""
harness = "opencode"
"#,
    )
    .unwrap();

    let duplicate = duplicate_task_in(&repo, &created.task.slug).unwrap();
    assert_eq!(duplicate.session.harness, "omp");
    assert_eq!(duplicate.session.model, "");
    assert_eq!(duplicate.session.phase, "replacement");
    assert!(!duplicate.session.generic);
    assert!(!duplicate.session.archived);
    let _ = git_cmd(&repo).args(["worktree", "remove", "--force", &duplicate.task.worktree]).output();
    let _ = git_cmd(&repo).args(["worktree", "remove", "--force", &created.task.worktree]).output();
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn duplicate_task_always_creates_worktree_from_repository_head_for_archived_removed_source() {
    let repo = init_git_test_repo("duplicate-head");
    let created = duplicate_source(&repo, "head-source", "claude", "");
    let source_tip = git_output(&repo, &["rev-parse", &created.task.branch]);
    let remove = git_cmd(&repo).args(["worktree", "remove", "--force", &created.task.worktree]).output().unwrap();
    assert!(remove.status.success());
    let mut source = created.task;
    source.archived = true;
    source.worktree.clear();
    write_task(&repo, &source).unwrap();
    fs::write(repo.join("head-marker"), b"head").unwrap();
    git_output(&repo, &["add", "head-marker"]);
    git_output(&repo, &["commit", "-m", "advance main"]);
    let repository_head = git_output(&repo, &["rev-parse", "HEAD"]);
    assert_ne!(repository_head, source_tip);

    let duplicate = duplicate_task_in(&repo, &source.slug).unwrap();
    assert!(duplicate.task.has_worktree);
    assert!(Path::new(&duplicate.task.worktree).is_dir());
    assert!(!duplicate.task.archived);
    assert_eq!(git_output(&repo, &["rev-parse", &duplicate.task.branch]), repository_head);
    assert_ne!(git_output(&repo, &["rev-parse", &duplicate.task.branch]), source_tip);
    assert!(Path::new(&duplicate.task.worktree).file_name().unwrap().to_string_lossy().starts_with("head-source"));
    let _ = git_cmd(&repo).args(["worktree", "remove", "--force", &duplicate.task.worktree]).output();
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn duplicate_task_dedupes_slug_branch_and_worktree_independently() {
    let repo = init_git_test_repo("duplicate-dedupe");
    let mut source = duplicate_source(&repo, "dedupe", "claude", "").task;
    source.branch = "topic".into();
    write_task(&repo, &source).unwrap();
    git_output(&repo, &["branch", "topic/existing"]);
    let first = duplicate_task_in(&repo, &source.slug).unwrap();
    let second = duplicate_task_in(&repo, &source.slug).unwrap();
    assert_eq!(first.task.slug, "dedupe-2");
    assert_eq!(second.task.slug, "dedupe-3");
    assert_eq!(first.task.branch, "topic-2");
    assert_eq!(second.task.branch, "topic-3");
    assert_eq!(Path::new(&first.task.worktree).file_name().unwrap(), "dedupe-2");
    assert_eq!(Path::new(&second.task.worktree).file_name().unwrap(), "dedupe-3");
    for task in [&first.task, &second.task, &source] {
        let _ = git_cmd(&repo).args(["worktree", "remove", "--force", &task.worktree]).output();
    }
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn duplicate_task_rejects_invalid_draft_missing_session_and_managed_non_file_before_mutation() {
    let repo = init_git_test_repo("duplicate-reject");
    for invalid in ["../task", "/absolute", "nested/task"] {
        assert!(duplicate_task_in(&repo, invalid)
            .err()
            .expect("invalid source must fail")
            .contains("invalid duplicate source slug"));
    }

    let mut draft = duplicate_source(&repo, "draft-source", "claude", "").task;
    draft.draft = true;
    write_task(&repo, &draft).unwrap();
    assert!(duplicate_task_in(&repo, &draft.slug)
        .err()
        .expect("draft must fail")
        .contains("draft tasks cannot be duplicated"));
    assert!(!task_dir(&repo, "draft-source-2").exists());

    let no_session = duplicate_source(&repo, "no-session", "claude", "").task;
    fs::remove_dir_all(sessions_dir(&repo, &no_session.slug)).unwrap();
    assert!(duplicate_task_in(&repo, &no_session.slug)
        .err()
        .expect("missing source session must fail")
        .contains("no original primary playbook session"));
    assert!(!task_dir(&repo, "no-session-2").exists());

    let invalid_attachment = duplicate_source(&repo, "bad-attachment", "claude", "").task;
    fs::create_dir_all(attachments_of(&repo, &invalid_attachment.slug).join("directory")).unwrap();
    assert!(duplicate_task_in(&repo, &invalid_attachment.slug)
        .err()
        .expect("managed directory must fail")
        .contains("not a regular file"));
    assert!(!task_dir(&repo, "bad-attachment-2").exists());
    for task in [&draft, &no_session, &invalid_attachment] {
        let _ = git_cmd(&repo).args(["worktree", "remove", "--force", &task.worktree]).output();
    }
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn duplicate_task_rolls_back_post_worktree_failure() {
    let repo = init_git_test_repo("duplicate-rollback");
    let source = duplicate_source(&repo, "rollback-source", "claude", "").task;
    FAIL_DUPLICATE_AFTER_WORKTREE.store(duplicate_fail_key(&source.slug), std::sync::atomic::Ordering::SeqCst);
    let error = duplicate_task_in(&repo, &source.slug).err().expect("injected failure must fail");
    assert!(error.contains("injected duplicate failure after worktree creation"));
    assert!(!task_dir(&repo, "rollback-source-2").exists());
    assert!(!worktrees_dir(&repo).join("rollback-source-2").exists());
    let branch = git_cmd(&repo).args(["show-ref", "--verify", "--quiet", "refs/heads/rollback-source-2"]).status().unwrap();
    assert!(!branch.success());
    let worktrees = git_output(&repo, &["worktree", "list", "--porcelain"]);
    assert!(!worktrees.contains("rollback-source-2"));
    let _ = git_cmd(&repo).args(["worktree", "remove", "--force", &source.worktree]).output();
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_older_busy_survives_newer_settled() {
    let repo = activity_repo("older-busy-newer-settled");
    write_activity_task(&repo, "task", "tdd", false);
    let newer_path = session_meta_path(&repo, "task", "task-session");
    let mut newer: SessionMeta = serde_json::from_str(&fs::read_to_string(&newer_path).unwrap()).unwrap();
    newer.created = 20;
    newer.semantic.phase_completed_at = Some(20);
    newer.notification_read_at = Some(20);
    fs::write(&newer_path, serde_json::to_string(&newer).unwrap()).unwrap();
    let older = SessionMeta {
        id: "older-design".into(),
        worktree: repo.display().to_string(),
        created: 10,
        phase: "design".into(),
        playbook: "superdevelop".into(),
        ..Default::default()
    };
    fs::write(session_meta_path(&repo, "task", &older.id), serde_json::to_string(&older).unwrap()).unwrap();

    let activity = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &[activity_status_busy("older-design")]);
    let summary = activity.get(&format!("{}:task", repo.display())).unwrap();
    assert_eq!(summary.status, Some(crate::TaskActivityStatus::Running));
    assert_eq!(summary.active_session.as_ref().map(|session| session.id.as_str()), Some("older-design"));
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn board_tasks_reject_missing_and_cyclic_relationships() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-board-relationships-{n}"));
    let mut parent = Task {
        name: "Parent".into(),
        slug: "parent".into(),
        requested_slug: String::new(),
        branch: "parent".into(),
        worktree: repo.join("parent").display().to_string(),
        has_worktree: true,
        created: 1,
        archived: false,
        pr_url: String::new(),
        linear_id: String::new(),
        github_issue: String::new(),
        playbook: "superdevelop".into(),
        auto_advance: vec![],
        parent_task: "missing".into(),
        active_subtask: String::new(),
        subtask_outcome: String::new(),
        related_tasks: Vec::new(),
        draft: false,
        telemetry_id: String::new(),
    };
    write_task(&repo, &parent).unwrap();
    assert!(board_tasks_for_repo(&repo, "/repo").err().unwrap().contains("task 'parent' names missing parent 'missing'"));
    parent.parent_task.clear();

    let child = Task {
        name: "Child".into(),
        slug: "child".into(),
        requested_slug: String::new(),
        branch: "child".into(),
        worktree: repo.join("child").display().to_string(),
        has_worktree: true,
        created: 2,
        archived: false,
        pr_url: String::new(),
        linear_id: String::new(),
        github_issue: String::new(),
        playbook: "superdevelop".into(),
        auto_advance: vec![],
        parent_task: "parent".into(),
        active_subtask: "parent".into(),
        subtask_outcome: String::new(),
        related_tasks: Vec::new(),
        draft: false,
        telemetry_id: String::new(),
    };
    parent.parent_task = "child".into();
    parent.active_subtask = "child".into();
    write_task(&repo, &parent).unwrap();
    write_task(&repo, &child).unwrap();
    assert!(board_tasks_for_repo(&repo, "/repo").err().unwrap().contains("cycle reaches"));
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_stale_source_failure_is_ignored() {
    let repo = activity_repo("stale-failure");
    write_activity_task(&repo, "task", "tdd", false);
    let mut stale = activity_status_idle("task-session");
    stale.state.playbook = alinery_core::PlaybookState::Failed { reason: "StaleSource".into() };
    let activity = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &[stale]);
    assert_eq!(activity_summary(&activity, &repo, "task"), &crate::TaskActivitySummary::default());
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_active_session_uses_actual_playbook_metadata() {
    let repo = activity_repo("active-metadata");
    write_activity_task(&repo, "task", "tdd", false);
    write_activity_session(
        &repo,
        "task",
        SessionMeta {
            id: "external-review".into(),
            worktree: "/worktree/external".into(),
            created: 30,
            phase: "review-findings".into(),
            harness: "claude".into(),
            model: "opus".into(),
            playbook: "review".into(),
            ..Default::default()
        },
    );
    write_activity_session(
        &repo,
        "task",
        SessionMeta {
            id: "generic".into(),
            worktree: "/worktree/generic".into(),
            created: 40,
            phase: "ignored".into(),
            harness: "no-harness".into(),
            playbook: "free-form".into(),
            generic: true,
            ..Default::default()
        },
    );
    let external = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &[activity_status_busy("external-review")]);
    let session = activity_summary(&external, &repo, "task").active_session.as_ref().unwrap();
    assert_eq!(
        session,
        &crate::TaskActivitySession {
            id: "external-review".into(),
            worktree: "/worktree/external".into(),
            phase: "review-findings".into(),
            harness: "claude".into(),
            model: "opus".into(),
            playbook: "review".into(),
            generic: false,
            step_title: "Review Findings".into(),
        }
    );
    let generic = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &[activity_status_busy("generic")]);
    let session = activity_summary(&generic, &repo, "task").active_session.as_ref().unwrap();
    assert!(session.generic);
    assert_eq!(session.step_title, "Generic");
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn task_activity_status_matches_by_id_and_uses_session_list_precedence() {
    let repo = activity_repo("status-by-id");
    write_activity_task(&repo, "task", "tdd", false);
    for (id, created) in [("input", 10), ("busy", 20), ("approval", 30)] {
        write_activity_session(
            &repo,
            "task",
            SessionMeta {
                id: id.into(),
                worktree: repo.display().to_string(),
                created,
                phase: "design".into(),
                playbook: "superdevelop".into(),
                ..Default::default()
            },
        );
    }
    let mut input = activity_status_busy("input");
    input.state.agent = alinery_core::AgentState::WaitingForInput { correlation_id: "ask".into() };
    let mut approval = activity_status_busy("approval");
    approval.state.agent = alinery_core::AgentState::WaitingForApproval {
        correlation_id: "permission".into(),
    };
    let statuses = [activity_status_idle("other-task"), input, activity_status_busy("busy"), approval];
    let forward = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &statuses);
    let reversed = crate::resolve_task_activity_for_repo(&repo, &["task".into()], &statuses.iter().cloned().rev().collect::<Vec<_>>());
    assert_eq!(forward, reversed);
    let summary = activity_summary(&forward, &repo, "task");
    assert_eq!(summary.status, Some(crate::TaskActivityStatus::WaitingForApproval));
    assert_eq!(summary.active_session.as_ref().map(|session| session.id.as_str()), Some("busy"));
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn set_related_tasks_writes_tags_and_task_dir_symlinks() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-related-src-{n}"));
    let other = std::env::temp_dir().join(format!("alinery-related-dst-{n}"));
    fs::create_dir_all(crate::artifacts_dir(&repo, "here")).unwrap();
    fs::create_dir_all(crate::artifacts_dir(&other, "there")).unwrap();
    fs::write(crate::artifacts_dir(&other, "there").join("01.md"), "from-there").unwrap();
    write_task(
        &repo,
        &Task {
            name: "Here".into(),
            slug: "here".into(),
            requested_slug: String::new(),
            branch: "here".into(),
            worktree: "/wt".into(),
            has_worktree: true,
            created: 1,
            archived: false,
            pr_url: String::new(),
            linear_id: String::new(),
            github_issue: String::new(),
            playbook: "superdevelop".into(),
            auto_advance: vec![],
            draft: false,
            telemetry_id: String::new(),
            parent_task: String::new(),
            active_subtask: String::new(),
            subtask_outcome: String::new(),
            related_tasks: Vec::new(),
        },
    )
    .unwrap();

    let updated = crate::set_related_tasks_in(
        &repo,
        "here".into(),
        vec![alinery_core::RelatedTaskRef {
            repo_path: other.to_string_lossy().into_owned(),
            slug: "there".into(),
            name: "There".into(),
        }],
    )
    .unwrap();
    assert_eq!(updated.related_tasks.len(), 1);
    assert_eq!(updated.related_tasks[0].slug, "there");

    let link = alinery_core::related_links_dir(&repo, "here").join(alinery_core::related_link_name(&other.to_string_lossy(), "there"));
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert_eq!(fs::read_to_string(link.join("01.md")).unwrap(), "from-there");
    assert!(!crate::artifacts_dir(&repo, "here").join("related").exists());

    crate::set_related_tasks_in(&repo, "here".into(), vec![]).unwrap();
    assert!(!link.exists());
    let _ = fs::remove_dir_all(repo);
    let _ = fs::remove_dir_all(other);
}

#[test]
fn targeted_restore_changes_only_selected_repository() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo_a = std::env::temp_dir().join(format!("alinery-restore-a-{n}"));
    let repo_b = std::env::temp_dir().join(format!("alinery-restore-b-{n}"));
    let slug = "same-slug";
    for (repo, name) in [(&repo_a, "Repository A"), (&repo_b, "Repository B")] {
        write_task(
            repo,
            &Task {
                name: name.into(),
                slug: slug.into(),
                requested_slug: String::new(),
                branch: format!("{slug}-{name}"),
                worktree: repo.join(".alinery/worktrees").join(slug).to_string_lossy().into_owned(),
                has_worktree: true,
                created: 1,
                archived: true,
                pr_url: String::new(),
                linear_id: String::new(),
                github_issue: String::new(),
                playbook: default_playbook_key(),
                auto_advance: Vec::new(),
                parent_task: String::new(),
                active_subtask: String::new(),
                subtask_outcome: String::new(),
                draft: false,
                telemetry_id: String::new(),
                related_tasks: Vec::new(),
            },
        )
        .unwrap();
    }
    let repo_a_before = fs::read(crate::task_dir(&repo_a, slug).join("task.md")).unwrap();

    crate::restore_task_in(&repo_b, slug).unwrap();

    assert!(read_task(&repo_a, slug).unwrap().archived);
    assert_eq!(fs::read(crate::task_dir(&repo_a, slug).join("task.md")).unwrap(), repo_a_before);
    let restored = read_task(&repo_b, slug).unwrap();
    assert!(!restored.archived);
    assert_eq!(restored.name, "Repository B");
    let _ = fs::remove_dir_all(repo_a);
    let _ = fs::remove_dir_all(repo_b);
}
