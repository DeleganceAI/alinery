//! Tests for task.rs — tasks, drafts, attachments, board projection, targeted (per-repo) helpers
//!
//! `use super::*` reaches the shared imports and fixtures in tests/mod.rs.
use super::*;
use crate::{artifacts_dir, chat_file_stat, read_chat_image_in, MAX_CHAT_IMAGE_BYTES};

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
            ..Default::default()
        },
    )
    .unwrap();

    let tasks = list_tasks_for_repo(&repo).unwrap();
    assert_eq!(tasks.len(), 1);
    assert!(tasks[0].draft);
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn old_draft_without_source_remains_readable() {
    let repo = init_git_test_repo("old-draft-source");
    let dir = task_dir(&repo, "old-draft");
    fs::create_dir_all(&dir).unwrap();
    let old = "name = \"Old Draft\"\nslug = \"old-draft\"\nbranch = \"destination\"\nworktree = \"\"\ncreated = 42\ndraft = true\n";
    fs::write(dir.join("task.md"), old).unwrap();
    let draft = read_task(&repo, "old-draft").unwrap();
    assert!(draft.draft);
    assert_eq!(draft.branch, "destination");
    assert_eq!(draft.draft_base_ref, None);
    assert_eq!(fs::read_to_string(dir.join("task.md")).unwrap(), old);
    let _ = fs::remove_dir_all(repo);
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
fn attachment_preview_preserves_bytes_above_chat_limit_and_enforces_attachment_limit() {
    let repo = unique_attachment_temp("image-preview-limit");
    let attach = attachments_of(&repo, "task");
    fs::create_dir_all(&attach).unwrap();
    let bytes = vec![42; MAX_CHAT_IMAGE_BYTES as usize + 1];
    fs::write(attach.join("large.PNG"), &bytes).unwrap();
    assert_eq!(crate::read_attachment_image_in(&repo, "task", "large.PNG", None).unwrap(), bytes);
    assert!(read_chat_image_in(&repo, "task", "large.PNG").is_err());
    fs::File::create(attach.join("oversized.png")).unwrap().set_len(MAX_ATTACHMENT_BYTES + 1).unwrap();
    assert!(crate::read_attachment_image_in(&repo, "task", "oversized.png", None).is_err());
    fs::write(attach.join("notes.txt"), "not an image").unwrap();
    assert!(crate::read_attachment_image_in(&repo, "task", "notes.txt", None).is_err());
    assert!(crate::read_attachment_image_in(&repo, "task", "../large.PNG", None).is_err());
    let _ = fs::remove_dir_all(repo);
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
fn targeted_helpers_do_not_depend_on_active_repo() {
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo_a = init_git_test_repo("targeted-helper-a");
    let repo_b = init_git_test_repo("targeted-helper-b");

    git_cmd(&repo_a).args(["remote", "add", "origin", "https://github.com/example/a.git"]).output().unwrap();
    git_cmd(&repo_b).args(["remote", "add", "origin", "https://github.com/example/b.git"]).output().unwrap();
    set_active_repo_global(Some(repo_a.clone())).unwrap();

    assert_eq!(parse_github_ref("#42", active_github_repo(&repo_b)).unwrap().label(), "example/b#42");
    assert_eq!(crate::active_repo().unwrap(), repo_a);

    set_active_repo_global(None).unwrap();
    let _ = fs::remove_dir_all(repo_a);
    let _ = fs::remove_dir_all(repo_b);
}

pub(super) fn retained_duplicate_fixture(repo: &Path) -> Task {
    let source = include_str!("../../playbooks/one-shot/playbook.md");
    let reference = alinery_core::playbook::PlaybookRef {
        scope: alinery_core::playbook::PlaybookScope::Repo,
        key: "one-shot".into(),
    };
    let task = Task {
        name: "Original".into(),
        slug: "original".into(),
        branch: "original".into(),
        worktree: repo.join(".alinery/worktrees/original").display().to_string(),
        engine_version: 2,
        playbook_ref: Some(reference.clone()),
        ..Default::default()
    };
    fs::create_dir_all(artifacts_dir(repo, &task.slug)).unwrap();
    fs::create_dir_all(sessions_dir(repo, &task.slug)).unwrap();
    fs::write(task_dir(repo, &task.slug).join("playbook.md"), source).unwrap();
    fs::write(artifacts_dir(repo, &task.slug).join("00-ticket.md"), "# Edited original\nKeep exact bytes.\n").unwrap();
    let mut execution = alinery_core::execution::new_execution_state(reference, source, String::new(), 10, Default::default(), Default::default(), Default::default()).unwrap();
    execution.creation = "ready".into();
    alinery_core::execution::write_execution_state_unlocked(repo, &task.slug, &mut execution).unwrap();
    write_task(repo, &task).unwrap();
    task
}

#[test]
fn provisioning_reserves_branches_before_git_and_retains_failed_intent() {
    let repo = init_git_test_repo("provisioning-branch-reservation");
    let mut request: alinery_core::CreateTaskRequest = serde_json::from_value(serde_json::json!({
        "name": "Reserved",
        "branch_name": "reserved",
        "playbook": {
            "reference": { "scope": "bundled", "key": "one-shot" },
            "source": include_str!("../../playbooks/one-shot/playbook.md")
        },
        "start": false
    }))
    .unwrap();
    assert!(git_cmd(&repo).args(["branch", "reserved-1"]).status().unwrap().success());
    let existing = git_cmd(&repo).args(["rev-parse", "reserved-1"]).output().unwrap().stdout;
    let mut reservations = Vec::new();
    for expected_branch in ["reserved", "reserved-2"] {
        let reply = alinery_core::provision_task_with_reservation(&repo, "", "fixture", &request, || Ok(()), |_| Err("stop before git".into())).unwrap();
        assert_eq!(reply.creation, "partial");
        assert!(reply.errors.iter().any(|error| error.stage == "relationships" && error.message == "stop before git"));
        let task = reply.task.unwrap();
        assert_eq!(task.branch, expected_branch);
        assert_eq!(
            git_cmd(&repo)
                .args(["show-ref", "--verify", "--quiet", &format!("refs/heads/{}", task.branch)])
                .status()
                .unwrap()
                .code(),
            Some(1)
        );
        assert!(!Path::new(&task.worktree).exists());
        assert_eq!(alinery_core::read_task(&repo, &task.slug).unwrap().branch, expected_branch);
        let state = alinery_core::execution::read_execution_state(&repo, &task.slug).unwrap();
        assert_eq!(state.creation, "partial");
        assert!(state.creation_error.as_deref().is_some_and(|error| error.contains("stop before git")));
        reservations.push(task);
    }
    assert_ne!(reservations[0].slug, reservations[1].slug);
    assert_ne!(reservations[0].worktree, reservations[1].worktree);
    assert_eq!(git_cmd(&repo).args(["rev-parse", "reserved-1"]).output().unwrap().stdout, existing);

    // Child identities are explicit: a durable branch reservation must reject,
    // rather than silently suffixing the requested branch.
    request.parent_task = "parent".into();
    request.requested_slug = Some("child".into());
    assert!(alinery_core::provision_task_with_reservation(&repo, "", "fixture", &request, || Ok(()), |_| Ok(())).is_err());
    assert!(!task_dir(&repo, "child").exists());
    fs::remove_dir_all(repo).unwrap();
}
