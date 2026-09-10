//! Tests for artifacts.rs — artifacts, comments, drafts, review handoff
//!
//! `use super::*` reaches the shared imports and fixtures in tests/mod.rs.
use super::*;

#[test]
fn artifact_file_path_stays_in_artifacts_dir() {
    let repo = Path::new("/repo");
    assert_eq!(
        artifact_file_path(repo, "task", "01-research.md").unwrap(),
        repo.join(".alinery/tasks/task/artifacts/01-research.md")
    );

    for name in ["", ".", "../x.md", "nested/x.md", "/tmp/x.md", "nested\\x.md"] {
        assert!(artifact_file_path(repo, "task", name).is_err(), "{name}");
    }
}

#[test]
fn artifact_comments_paths_stay_in_artifacts_dir() {
    let repo = Path::new("/repo");

    assert_eq!(
        artifact_comment_json_path(repo, "task", "03-design.md").unwrap(),
        repo.join(".alinery/tasks/task/artifacts/03-design.comments.json")
    );
    assert_eq!(
        artifact_comment_markdown_path(repo, "task", "03-design.md").unwrap(),
        repo.join(".alinery/tasks/task/artifacts/03-design.comments.md")
    );

    for name in ["", ".", "../x.md", "nested/x.md", "/tmp/x.md", "nested\\x.md"] {
        assert!(artifact_comment_json_path(repo, "task", name).is_err(), "json path should reject {name:?}");
        assert!(artifact_comment_markdown_path(repo, "task", name).is_err(), "markdown path should reject {name:?}");
    }
}

#[test]
fn artifact_comments_missing_file_returns_empty() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-artifact-comments-missing-{n}"));
    fs::create_dir_all(repo.join(".alinery/tasks/task/artifacts")).unwrap();
    fs::write(repo.join(".alinery/tasks/task/artifacts/03-design.md"), "# Design\n").unwrap();

    let comments = load_artifact_comments_for(&repo, "task", "03-design.md").unwrap();

    assert!(comments.is_empty());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn artifact_comment_drafts_roundtrip_mark_stale_and_delete_cleanly() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-artifact-comment-drafts-{n}"));
    let artifact = repo.join(".alinery/tasks/task/artifacts/03-design.md");
    fs::create_dir_all(artifact.parent().unwrap()).unwrap();
    fs::write(&artifact, "# Design\n").unwrap();

    save_artifact_comment_draft_for(
        &repo,
        "task",
        "03-design.md",
        "h3:12-12:6f3a91c2".into(),
        "h3".into(),
        "Summary of change request".into(),
        "Summary of change request".into(),
        12,
        12,
        "unfinished thought".into(),
    )
    .unwrap();

    let path = artifact_comment_drafts_path(&repo, "task");
    assert_eq!(path, repo.join(".alinery/tasks/task/artifact-comment-drafts.json"));
    let stored: ArtifactCommentDraftsFile = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(stored.version, 1);
    assert_eq!(stored.drafts.len(), 1);
    assert_eq!(stored.drafts[0].body, "unfinished thought");
    assert!(!list_artifact_comment_drafts_for(&repo, "task").unwrap()[0].stale);

    save_artifact_comment_draft_for(
        &repo,
        "task",
        "03-design.md",
        "h3:12-12:6f3a91c2".into(),
        "h3".into(),
        "Summary of change request".into(),
        "Summary of change request".into(),
        12,
        12,
        "revised thought".into(),
    )
    .unwrap();
    let drafts = load_artifact_comment_drafts_for(&repo, "task").unwrap();
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].body, "revised thought");

    fs::write(&artifact, "# Revised design\n").unwrap();
    assert!(list_artifact_comment_drafts_for(&repo, "task").unwrap()[0].stale);

    delete_artifact_comment_draft_for(&repo, "task", "03-design.md", "h3:12-12:6f3a91c2").unwrap();
    assert!(!path.exists());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn artifact_comments_roundtrip_json_and_markdown() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-artifact-comments-roundtrip-{n}"));
    fs::create_dir_all(repo.join(".alinery/tasks/task/artifacts")).unwrap();
    fs::write(repo.join(".alinery/tasks/task/artifacts/03-design.md"), "# Design\n").unwrap();

    let comments = add_artifact_comment_for(
        &repo,
        "task",
        "03-design.md",
        "h3:12-12:6f3a91c2".into(),
        "h3".into(),
        "Summary of change request".into(),
        "Summary of change request".into(),
        12,
        12,
        "Please make the migration path explicit.".into(),
    )
    .unwrap();

    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0].body, "Please make the migration path explicit.");

    let json_path = repo.join(".alinery/tasks/task/artifacts/03-design.comments.json");
    let json = fs::read_to_string(&json_path).unwrap();
    let stored: ArtifactCommentsFile = serde_json::from_str(&json).unwrap();
    assert_eq!(stored.version, 1);
    assert_eq!(stored.artifact, "03-design.md");
    assert_eq!(stored.comments, comments);

    let markdown = fs::read_to_string(repo.join(".alinery/tasks/task/artifacts/03-design.comments.md")).unwrap();
    assert!(markdown.contains("# Human comments for 03-design.md"));
    assert!(markdown.contains("Summary of change request"));
    assert!(markdown.contains("Lines: 12-12"));
    assert!(markdown.contains("<comment id="));
    assert!(markdown.contains("Please make the migration path explicit."));

    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn artifact_comments_list_artifacts_hides_comment_json_but_keeps_comment_markdown() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-artifact-comments-list-{n}"));
    let artifacts = repo.join(".alinery/tasks/task/artifacts");
    fs::create_dir_all(&artifacts).unwrap();
    fs::write(artifacts.join("03-design.md"), "# Design\n").unwrap();
    fs::write(artifacts.join("03-design.comments.json"), "{}\n").unwrap();
    fs::write(artifacts.join("03-design.comments.md"), "# Human comments\n").unwrap();

    let artifacts = list_artifacts_for(&repo, "task").unwrap();

    assert!(artifacts.contains(&"03-design.md".to_string()));
    assert!(artifacts.contains(&"03-design.comments.md".to_string()));
    assert!(!artifacts.contains(&"03-design.comments.json".to_string()));
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn list_artifacts_hides_handoff_sidecars() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-handoff-sidecars-list-{n}"));
    let artifacts = repo.join(".alinery/tasks/task/artifacts");
    fs::create_dir_all(&artifacts).unwrap();
    fs::write(artifacts.join("03-design.md"), "# Design\n").unwrap();
    fs::write(artifacts.join("03-design.comments.md"), "# Human comments\n").unwrap();
    fs::write(artifacts.join("review-handoff-001.md"), "# Handoff\n").unwrap();
    fs::write(artifacts.join("review-handoff-001.handoff.json"), "{}\n").unwrap();
    fs::write(artifacts.join("03-review-findings.handoff-001.json"), "{}\n").unwrap();

    let names = list_artifacts_for(&repo, "task").unwrap();
    assert!(names.contains(&"03-design.md".to_string()));
    assert!(names.contains(&"03-design.comments.md".to_string()));
    assert!(names.contains(&"review-handoff-001.md".to_string()));
    assert!(!names.contains(&"review-handoff-001.handoff.json".to_string()));
    assert!(!names.contains(&"03-review-findings.handoff-001.json".to_string()));
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn list_artifacts_with_metadata_includes_handoff_records() {
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-handoff-metadata-{n}"));
    let artifacts = repo.join(".alinery/tasks/task/artifacts");
    fs::create_dir_all(&artifacts).unwrap();
    fs::write(artifacts.join("review-handoff-001.md"), "# Handoff\n").unwrap();
    let record = alinery_core::ReviewHandoffRecord {
        version: 1,
        direction: "inbound".into(),
        source_task: "review".into(),
        source_session: "s1".into(),
        source_artifact: "03-review-findings.md".into(),
        target_task: "task".into(),
        target_artifact: "review-handoff-001.md".into(),
        target_session: "s2".into(),
        target_phase: "implementation".into(),
        created_at_ms: 7,
    };
    fs::write(artifacts.join("review-handoff-001.handoff.json"), serde_json::to_string(&record).unwrap()).unwrap();
    set_active_repo_global(Some(repo.clone())).unwrap();
    let items = tauri::async_runtime::block_on(list_artifacts_with_metadata("task".into())).unwrap();
    let item = items.iter().find(|item| item.name == "review-handoff-001.md").unwrap();
    assert_eq!(item.handoffs, vec![record]);
    assert!(item.modified_at_ms.is_some());
    set_active_repo_global(None).unwrap();
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn list_artifacts_with_metadata_maps_session_artifact_override() {
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-artifact-session-map-{n}"));
    let artifacts = repo.join(".alinery/tasks/task/artifacts");
    let sessions = repo.join(".alinery/tasks/task/sessions");
    fs::create_dir_all(&artifacts).unwrap();
    fs::create_dir_all(&sessions).unwrap();
    fs::write(artifacts.join("06-implementation-002.md"), "# Implementation\n").unwrap();
    let meta = SessionMeta {
        id: "s1".into(),
        worktree: "/tmp/wt".into(),
        created: 1,
        phase: "implementation".into(),
        playbook: "superdevelop".into(),
        artifact: "06-implementation-002.md".into(),
        ..Default::default()
    };
    fs::write(sessions.join("s1.meta.json"), serde_json::to_string(&meta).unwrap()).unwrap();
    set_active_repo_global(Some(repo.clone())).unwrap();
    let items = tauri::async_runtime::block_on(list_artifacts_with_metadata("task".into())).unwrap();
    let item = items.iter().find(|item| item.name == "06-implementation-002.md").unwrap();
    assert_eq!(item.playbook_step, "implementation");
    assert_eq!(item.session_id, "s1");
    set_active_repo_global(None).unwrap();
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn artifact_comments_archive_creates_numbered_reviews_and_clears_active_files() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-artifact-comments-archive-{n}"));
    let artifacts = repo.join(".alinery/tasks/task/artifacts");
    fs::create_dir_all(&artifacts).unwrap();
    fs::write(artifacts.join("03-design.md"), "# Design\n").unwrap();

    add_artifact_comment_for(
        &repo,
        "task",
        "03-design.md",
        "h3:12-12:6f3a91c2".into(),
        "h3".into(),
        "Summary of change request".into(),
        "Summary of change request".into(),
        12,
        12,
        "Please make the migration path explicit.".into(),
    )
    .unwrap();

    let review_001 = archive_artifact_comments_for(&repo, "task", "03-design.md").unwrap();

    assert_eq!(review_001, artifacts.join("03-design.review-001.md"));
    assert!(!artifact_comment_json_path(&repo, "task", "03-design.md").unwrap().exists());
    assert!(!artifact_comment_markdown_path(&repo, "task", "03-design.md").unwrap().exists());
    let first_review = fs::read_to_string(&review_001).unwrap();
    assert!(first_review.contains("# Human comments for 03-design.md"));
    assert!(first_review.contains("Please make the migration path explicit."));
    assert_eq!(
        next_artifact_review_markdown_path(&repo, "task", "03-design.md").unwrap(),
        artifacts.join("03-design.review-002.md")
    );

    add_artifact_comment_for(
        &repo,
        "task",
        "03-design.md",
        "p:20-20:d34db33f".into(),
        "p".into(),
        "Second review request".into(),
        "Second review request".into(),
        20,
        20,
        "Tighten the rollout section.".into(),
    )
    .unwrap();

    let review_002 = archive_artifact_comments_for(&repo, "task", "03-design.md").unwrap();

    assert_eq!(review_002, artifacts.join("03-design.review-002.md"));
    assert_eq!(fs::read_to_string(&review_001).unwrap(), first_review);
    let second_review = fs::read_to_string(&review_002).unwrap();
    assert!(second_review.contains("# Human comments for 03-design.md"));
    assert!(second_review.contains("Tighten the rollout section."));
    assert!(!second_review.contains("Please make the migration path explicit."));
    assert!(!artifact_comment_json_path(&repo, "task", "03-design.md").unwrap().exists());
    assert!(!artifact_comment_markdown_path(&repo, "task", "03-design.md").unwrap().exists());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn artifact_review_pending_survives_unchanged_artifact_and_clears_when_hash_changes() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-artifact-review-pending-hash-{n}"));
    let artifacts = repo.join(".alinery/tasks/task/artifacts");
    fs::create_dir_all(&artifacts).unwrap();
    fs::write(artifacts.join("03-design.md"), "# Design\n").unwrap();

    add_artifact_comment_for(
        &repo,
        "task",
        "03-design.md",
        "h3:12-12:6f3a91c2".into(),
        "h3".into(),
        "Summary of change request".into(),
        "Summary of change request".into(),
        12,
        12,
        "Please make the migration path explicit.".into(),
    )
    .unwrap();

    let review = archive_artifact_comments_for(&repo, "task", "03-design.md").unwrap();
    let pending_path = artifact_review_pending_path(&repo, "task", "03-design.md").unwrap();

    assert_eq!(review, artifacts.join("03-design.review-001.md"));
    assert_eq!(pending_path, artifacts.join("03-design.review-pending.json"));
    assert!(pending_path.exists());
    let status = artifact_review_pending_status_for(&repo, "task", "03-design.md").unwrap();
    assert_eq!(status.unwrap().review, "03-design.review-001.md");

    fs::write(artifacts.join("03-design.md"), "# Design\nChanged after send.\n").unwrap();

    let stale_status = artifact_review_pending_status_for(&repo, "task", "03-design.md").unwrap();
    assert!(stale_status.is_none());
    assert!(!pending_path.exists());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn artifact_review_pending_clear_removes_marker() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-artifact-review-pending-clear-{n}"));
    let artifacts = repo.join(".alinery/tasks/task/artifacts");
    fs::create_dir_all(&artifacts).unwrap();
    fs::write(artifacts.join("03-design.md"), "# Design\n").unwrap();

    add_artifact_comment_for(
        &repo,
        "task",
        "03-design.md",
        "h3:12-12:6f3a91c2".into(),
        "h3".into(),
        "Summary of change request".into(),
        "Summary of change request".into(),
        12,
        12,
        "Please make the migration path explicit.".into(),
    )
    .unwrap();
    archive_artifact_comments_for(&repo, "task", "03-design.md").unwrap();
    let pending_path = artifact_review_pending_path(&repo, "task", "03-design.md").unwrap();
    assert!(pending_path.exists());

    clear_artifact_review_pending_for(&repo, "task", "03-design.md").unwrap();

    assert!(!pending_path.exists());
    let status = artifact_review_pending_status_for(&repo, "task", "03-design.md").unwrap();
    assert!(status.is_none());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn artifact_comments_archive_without_active_comments_returns_error() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-artifact-comments-empty-archive-{n}"));
    let artifacts = repo.join(".alinery/tasks/task/artifacts");
    fs::create_dir_all(&artifacts).unwrap();
    fs::write(artifacts.join("03-design.md"), "# Design\n").unwrap();

    let err = archive_artifact_comments_for(&repo, "task", "03-design.md").unwrap_err();

    assert!(err.contains("no comments to archive for 03-design.md"));
    assert!(!artifacts.join("03-design.review-001.md").exists());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn send_review_handoff_creates_target_session_with_selected_phase() {
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo = init_git_test_repo("send-review-handoff-command");
    set_active_repo_global(Some(repo.clone())).unwrap();

    let source = create_task_in(
        &repo,
        "Review Task".into(),
        "".into(),
        "".into(),
        vec![],
        "".into(),
        "".into(),
        "review".into(),
        "omp".into(),
        String::new(),
        None,
        true,
        "".into(),
        "".into(),
    )
    .expect("create review task")
    .task;
    let target = create_task_for_test(&repo, "Implementation Task", true, "", "");
    let source_artifacts = repo.join(".alinery/tasks").join(&source.slug).join("artifacts");
    fs::write(source_artifacts.join("03-review-findings.md"), "# Findings\n\nFix it.\n").unwrap();

    let result = alinery_core::send_review_handoff_for(
        &repo.join("app.toml"),
        &repo,
        alinery_core::ReviewHandoffRequest {
            source_slug: source.slug.clone(),
            source_session: "source-session".into(),
            source_artifact: "03-review-findings.md".into(),
            target_slug: target.slug.clone(),
            target_phase: "design".into(),
            harness: "omp".into(),
            model: "sonnet".into(),
            prompt_extra: "Use the smallest safe fix.".into(),
        },
    )
    .expect("handoff");

    assert_eq!(result.target_artifact, "review-handoff-001.md");
    assert_eq!(result.target_session.phase, "design");
    assert_eq!(result.target_session.handoff_artifact, "review-handoff-001.md");
    assert_eq!(result.target_session.prompt_extra, "Use the smallest safe fix.");
    let target_dir = repo.join(".alinery/tasks").join(&target.slug).join("artifacts");
    assert!(target_dir.join("review-handoff-001.md").exists());
    assert!(target_dir.join("review-handoff-001.handoff.json").exists());
    assert!(source_artifacts.join("03-review-findings.handoff-001.json").exists());

    set_active_repo_global(None).unwrap();
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn send_review_handoff_command_returns_target_session() {
    send_review_handoff_creates_target_session_with_selected_phase();
}
#[test]
fn attachment_path_rejects_traversal_and_missing_files() {
    let repo = unique_attachment_temp("attachment-path");
    let attach = attachments_of(&repo, "task");
    fs::create_dir_all(&attach).unwrap();
    fs::write(attach.join("trace.log"), "log").unwrap();

    assert_eq!(
        attachment_path_in(&repo, "task", "trace.log").unwrap(),
        attach.join("trace.log").to_string_lossy().to_string()
    );
    for bad in ["../../task.md", "a/b.log", "", "/etc/passwd", "..\\x"] {
        assert!(attachment_path_in(&repo, "task", bad).is_err(), "accepted {bad:?}");
    }
    assert!(attachment_path_in(&repo, "../other", "trace.log").is_err());
    assert!(attachment_path_in(&repo, "task", "missing.log").is_err());
    // A directory is not a revealable attachment.
    fs::create_dir_all(attach.join("subdir")).unwrap();
    assert!(attachment_path_in(&repo, "task", "subdir").is_err());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn artifact_node_adapters_preserve_opaque_owner_aware_resolution() {
    let repo = unique_attachment_temp("artifact-node-adapter");
    let task = alinery_core::Task {
        name: "Task".into(),
        slug: "task".into(),
        branch: "task".into(),
        worktree: repo.join("worktree").display().to_string(),
        has_worktree: true,
        created: 1,
        playbook: "superdevelop".into(),
        ..Default::default()
    };
    alinery_core::write_task(&repo, &task).unwrap();
    fs::create_dir_all(crate::artifacts_dir(&repo, "task").join("attachments")).unwrap();
    fs::write(crate::artifacts_dir(&repo, "task").join("01-owned.md"), "owned").unwrap();
    fs::write(crate::artifacts_dir(&repo, "task").join("attachments/evidence.txt"), "evidence").unwrap();

    let tree = crate::list_task_artifact_tree_for(&repo, "task").unwrap();
    let owned = tree.iter().find(|node| node.label == "01-owned.md").unwrap();
    let attachment = tree.iter().flat_map(|node| node.children.iter()).find(|node| node.label == "evidence.txt").unwrap();
    assert_eq!(crate::read_task_artifact_node_for(&repo, "task", &owned.id).unwrap(), "owned");
    assert!(crate::artifact_node_path_for(&repo, "task", &attachment.id).unwrap().ends_with("evidence.txt"));
    assert!(crate::read_task_artifact_node_for(&repo, "task", &attachment.id).is_err());
    let _ = fs::remove_dir_all(repo);
}
