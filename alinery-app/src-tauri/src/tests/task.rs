//! Tests for task.rs — tasks, drafts, attachments, board projection, targeted (per-repo) helpers
//!
//! `use super::*` reaches the shared imports and fixtures in tests/mod.rs.
use super::*;
use crate::{chat_file_stat, read_chat_image_in, MAX_CHAT_IMAGE_BYTES};

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
