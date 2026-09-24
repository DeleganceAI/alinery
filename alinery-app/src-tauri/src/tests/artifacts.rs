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
    assert_eq!(
        artifact_file_path(repo, "task", "nested/x.md").unwrap(),
        repo.join(".alinery/tasks/task/artifacts/nested/x.md")
    );

    for name in [
        "",
        ".",
        "../x.md",
        "nested/../x.md",
        "./x.md",
        "nested//x.md",
        "/tmp/x.md",
        "nested\\x.md",
        "attachments/x.md",
        "subtasks/child/x.md",
    ] {
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
    assert_eq!(
        artifact_comment_json_path(repo, "task", "research/03-design.md").unwrap(),
        repo.join(".alinery/tasks/task/artifacts/research/03-design.comments.json")
    );

    for name in ["", ".", "../x.md", "nested/../x.md", "/tmp/x.md", "nested\\x.md", "attachments/x.md", "subtasks/child/x.md"] {
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

    let path = artifact_comment_drafts_path(&repo, "task").unwrap();
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
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-handoff-metadata-{n}"));
    let artifacts = repo.join(".alinery/tasks/task/artifacts");
    fs::create_dir_all(&artifacts).unwrap();
    write_task(
        &repo,
        &Task {
            slug: "task".into(),
            ..Default::default()
        },
    )
    .unwrap();
    fs::write(artifacts.join("review-handoff-001.md"), "# Handoff\n").unwrap();
    let record = alinery_core::ReviewHandoffRecord {
        version: 1,
        direction: "inbound".into(),
        source_repo_path: repo.to_string_lossy().into_owned(),
        target_repo_path: repo.to_string_lossy().into_owned(),
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
    let items = crate::list_artifacts_with_metadata_in(&repo, "task").unwrap();
    let item = items.iter().find(|item| item.name == "review-handoff-001.md").unwrap();
    assert_eq!(item.handoffs, vec![record]);
    assert!(item.modified_at_ms.is_some());
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn list_artifacts_with_metadata_maps_session_artifact_override() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-artifact-session-map-{n}"));
    let artifacts = repo.join(".alinery/tasks/task/artifacts");
    let sessions = repo.join(".alinery/tasks/task/sessions");
    fs::create_dir_all(&artifacts).unwrap();
    fs::create_dir_all(&sessions).unwrap();
    write_task(
        &repo,
        &Task {
            slug: "task".into(),
            ..Default::default()
        },
    )
    .unwrap();
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
    let items = crate::list_artifacts_with_metadata_in(&repo, "task").unwrap();
    let item = items.iter().find(|item| item.name == "06-implementation-002.md").unwrap();
    assert_eq!(item.playbook_step, "implementation");
    assert_eq!(item.session_id, "s1");
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

struct HandoffDaemonFixture {
    repo: std::path::PathBuf,
    child: std::process::Child,
    client: alinery_core::daemon_client::DaemonClient,
}

impl HandoffDaemonFixture {
    fn new() -> Self {
        // Match the real-daemon prerequisite used by mcp/tests/stdio_protocol.rs.
        let binary = std::env::current_exe()
            .unwrap()
            .parent()
            .and_then(Path::parent)
            .unwrap()
            .join(format!("alineryd{}", std::env::consts::EXE_SUFFIX));
        assert!(
            binary.is_file(),
            "build the sibling alineryd binary before running artifact handoff tests: {}",
            binary.display()
        );
        // Keep Unix socket paths short, including on macOS.
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let repo = std::path::PathBuf::from(format!("/tmp/al-art-{n}"));
        fs::create_dir_all(repo.join(".alinery")).unwrap();
        let repo = fs::canonicalize(repo).unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "fixture@example.invalid"],
            vec!["config", "user.name", "Artifact Fixture"],
            vec!["commit", "--allow-empty", "-qm", "initial"],
        ] {
            let output = git_cmd(&repo).args(&args).output().unwrap();
            assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        }
        let app_config = repo.join(".alinery/app.toml");
        fs::write(&app_config, "").unwrap();
        let child = Command::new(binary)
            .arg("--repo")
            .arg(&repo)
            .arg("--app-config")
            .arg(&app_config)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .unwrap();
        let client = alinery_core::daemon_client::DaemonClient::connect_path(alinery_core::alineryd_socket_path(&repo, None)).unwrap();
        let mut fixture = Self { repo, child, client };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if alinery_core::connect_compatible_once(fixture.client.socket_path.clone(), &app_config).is_ok() {
                return fixture;
            }
            assert!(fixture.child.try_wait().unwrap().is_none(), "artifact fixture daemon exited before readiness");
            assert!(Instant::now() < deadline, "artifact fixture daemon did not become ready");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn create_task(&self, step: &str, output: &str) -> alinery_core::task_creation::CreateTaskReply {
        let source = format!(
            "+++\nversion=2\nkey='artifact-fixture'\ntitle='Artifact fixture'\ndescription=''\ndefault_model=''\ndefault_harness='omp'\n\
             [[step]]\nkey='{step}'\ntitle='{step}'\nshort=''\ninputs=[]\noutputs=[{{path='{output}'}}]\nmodel=''\nharness=''\nis_coding_step=false\nauto_advance_default=false\n\
             +++\n<!-- alinery:step {step} -->\nWrite the assigned artifact.\n"
        );
        let request = serde_json::from_value(serde_json::json!({
            "name": "Task", "requested_slug": "task",
            "playbook": {"reference": {"scope": "bundled", "key": "artifact-fixture"}, "source": source},
            "start": false
        }))
        .unwrap();
        let created = self.client.create_task(&request).unwrap();
        assert_eq!(created.creation, "ready", "{created:?}");
        assert!(created.errors.is_empty(), "{created:?}");
        created
    }
}

impl Drop for HandoffDaemonFixture {
    fn drop(&mut self) {
        // Only the child process owned by this fixture is terminated.
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.repo);
    }
}

#[test]
fn send_review_handoff_preserves_nested_artifact_and_scoped_repo_identity() {
    let source_fixture = HandoffDaemonFixture::new();
    let target_fixture = HandoffDaemonFixture::new();
    let source_created = source_fixture.create_task("review", "findings.md");
    let source = source_created.task.as_ref().unwrap();
    let source_session = source_created.sessions.iter().find(|session| session.phase == "review").unwrap();
    let target_created = target_fixture.create_task("design", "design.md");
    let target = target_created.task.as_ref().unwrap();
    // Equal slugs in different repositories must not collapse into one task identity.
    assert_eq!(source.slug, target.slug);
    let source_artifacts = artifacts_dir(&source_fixture.repo, &source.slug);
    fs::create_dir_all(source_artifacts.join("research")).unwrap();
    fs::write(source_artifacts.join("research/03-review-findings.md"), "# Findings\n\nFix it.\n").unwrap();
    fs::write(source_artifacts.join("03-review-findings.md"), "unrelated same basename").unwrap();

    let result = alinery_core::send_review_handoff_for_repos(
        &target_fixture.client,
        &source_fixture.repo,
        &target_fixture.repo,
        alinery_core::ReviewHandoffRequest {
            source_slug: source.slug.clone(),
            source_session: source_session.id.clone(),
            source_artifact: "research/03-review-findings.md".into(),
            target_slug: target.slug.clone(),
            target_phase: "design".into(),
            harness: "omp".into(),
            model: "sonnet".into(),
            prompt_extra: "Use the smallest safe fix.".into(),
            start: false,
        },
    )
    .expect("handoff");

    assert!(result.errors.is_empty(), "{result:?}");
    assert_eq!(result.start, "not_requested");
    assert_eq!(result.target_repo_path, target_fixture.repo.to_string_lossy());
    assert_eq!(result.target_artifact, "review-handoff-001.md");
    assert_eq!(result.target_session.phase, "design");
    let target_dir = artifacts_dir(&target_fixture.repo, &target.slug);
    assert!(result.target_session.prompt_extra.contains("Use the smallest safe fix."));
    assert!(result.target_session.prompt_extra.contains(&target_dir.join(&result.target_artifact).display().to_string()));
    let state = target_fixture
        .client
        .get_task_execution(&alinery_core::task_creation::GetTaskExecutionRequest { task_slug: target.slug.clone() })
        .unwrap()
        .state;
    let execution = &state.executions[&result.target_session.execution_id];
    assert_eq!(execution.owner_session_id, result.target_session.id);
    assert_eq!(execution.candidate.step_key, "design");
    assert!(!execution.start_requested);
    let handed_off = fs::read_to_string(target_dir.join("review-handoff-001.md")).unwrap();
    assert!(handed_off.contains("# Findings\n\nFix it."));
    assert!(!handed_off.contains("unrelated same basename"));
    let inbound: alinery_core::ReviewHandoffRecord = serde_json::from_str(&fs::read_to_string(target_dir.join("review-handoff-001.handoff.json")).unwrap()).unwrap();
    assert_eq!(inbound, result.target_record);
    let outbound: alinery_core::ReviewHandoffRecord =
        serde_json::from_str(&fs::read_to_string(source_artifacts.join("research/03-review-findings.handoff-001.json")).unwrap()).unwrap();
    assert_eq!(outbound, result.source_record);
    assert_eq!(outbound.source_artifact, "research/03-review-findings.md");
    assert_eq!(outbound.source_repo_path, source_fixture.repo.to_string_lossy());
    assert_eq!(outbound.target_repo_path, target_fixture.repo.to_string_lossy());
    assert_eq!(outbound.source_session, source_session.id);
    assert_eq!(inbound.target_session, result.target_session.id);
    let items = alinery_core::list_artifacts_with_metadata_for(&source_fixture.repo, &source.slug).unwrap();
    assert_eq!(items.iter().find(|item| item.name == "research/03-review-findings.md").unwrap().handoffs, vec![outbound]);
    assert!(items.iter().find(|item| item.name == "03-review-findings.md").unwrap().handoffs.is_empty());
    let target_items = alinery_core::list_artifacts_with_execution_metadata(&target_fixture.repo, &target.slug, &state).unwrap();
    assert_eq!(target_items.iter().find(|item| item.name == result.target_artifact).unwrap().handoffs, vec![inbound]);
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

#[test]
fn nested_comments_prepare_finalize_and_archive_keep_relative_identity() {
    let repo = unique_attachment_temp("nested-comments");
    let root = artifacts_dir(&repo, "task");
    for (directory, body) in [("research", "first comment"), ("analysis", "second comment")] {
        fs::create_dir_all(root.join(directory)).unwrap();
        let artifact = format!("{directory}/2-findings.md");
        fs::write(root.join(&artifact), directory).unwrap();
        add_artifact_comment_for(&repo, "task", &artifact, "anchor".into(), "p".into(), "Finding".into(), "Finding".into(), 1, 1, body.into()).unwrap();
    }
    let artifact = "research/2-findings.md";
    let prepared = prepare_artifact_comments_prompt_for(&repo, "task", &[artifact.into()]).unwrap();
    let crate::SessionMessageActionProvenance::ArtifactComments { items } = prepared.provenance else {
        panic!("expected artifact comments");
    };
    assert_eq!(items[0].review, "research/2-findings.review-001.md");
    assert!(prepared.text.contains(&root.join(&items[0].review).display().to_string()));
    assert!(fs::read_to_string(root.join(&items[0].review)).unwrap().contains("first comment"));
    crate::finalize_artifact_comments_for(&repo, "task", &items).unwrap();
    assert!(load_artifact_comments_for(&repo, "task", artifact).unwrap().is_empty());
    assert_eq!(load_artifact_comments_for(&repo, "task", "analysis/2-findings.md").unwrap()[0].body, "second comment");
    assert_eq!(artifact_review_pending_status_for(&repo, "task", artifact).unwrap().unwrap().review, items[0].review);
    let archived = archive_artifact_comments_for(&repo, "task", "analysis/2-findings.md").unwrap();
    assert_eq!(archived, root.join("analysis/2-findings.review-001.md"));
    assert!(fs::read_to_string(archived).unwrap().contains("second comment"));
    fs::remove_dir_all(repo).unwrap();
}

#[cfg(unix)]
#[test]
fn artifact_consumers_reject_symlink_parents_and_sidecars() {
    use std::os::unix::fs::symlink;

    let repo = unique_attachment_temp("artifact-consumer-symlinks");
    let root = artifacts_dir(&repo, "task");
    let nested = root.join("research");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("findings.md"), "findings").unwrap();
    let protected = repo.join("protected.txt");
    fs::write(&protected, "protected").unwrap();
    let comments = nested.join("findings.comments.json");
    symlink(&protected, &comments).unwrap();
    assert!(load_artifact_comments_for(&repo, "task", "research/findings.md").is_err());
    assert!(add_artifact_comment_for(&repo, "task", "research/findings.md", "a".into(), "p".into(), "".into(), "".into(), 1, 1, "comment".into()).is_err());
    assert_eq!(fs::read_to_string(&protected).unwrap(), "protected");
    fs::remove_file(comments).unwrap();
    let moved = root.join("original");
    fs::rename(&nested, &moved).unwrap();
    symlink(&moved, &nested).unwrap();
    assert!(crate::read_artifact_for_repo_in(&repo, "task", "research/findings.md").is_err());
    assert!(artifact_comment_json_path(&repo, "task", "research/findings.md").is_err());
    assert!(list_artifacts_for(&repo, "task").is_err());
    fs::remove_file(&nested).unwrap();
    symlink(repo.join("missing"), &nested).unwrap();
    assert!(artifact_file_path(&repo, "task", "research/new.md").is_err());
    fs::remove_dir_all(repo).unwrap();
}

#[test]
fn nested_artifact_list_sorts_numerically_and_excludes_reserved_namespaces() {
    let repo = unique_attachment_temp("nested-artifact-list");
    let root = artifacts_dir(&repo, "task");
    for directory in ["research", "attachments", "subtasks/child"] {
        fs::create_dir_all(root.join(directory)).unwrap();
    }
    for name in [
        "research/2-result-2.md",
        "research/2-result-10.md",
        "research/10-result-1.md",
        "attachments/input.md",
        "subtasks/child/result.md",
    ] {
        fs::write(root.join(name), name).unwrap();
    }
    assert_eq!(
        list_artifacts_for(&repo, "task").unwrap(),
        ["research/10-result-1.md", "research/2-result-10.md", "research/2-result-2.md",]
    );
    fs::remove_dir_all(repo).unwrap();
}

#[test]
fn execution_artifact_metadata_browses_saved_ownership_offline_without_locks() {
    use alinery_core::execution::{install_seed, reserve_execution, write_execution_state_unlocked, ExecutionCandidate};
    let repo = activity_repo("art-off");
    write_retained_discovery_task(&repo, "task", "offline-owner", false);
    let mut saved = crate::saved_task_execution_for(&repo, "task").unwrap();
    let seed = install_seed(&mut saved.state, "ticket.md", "0-ticket-1.md").unwrap();
    let candidate = ExecutionCandidate {
        step_key: "implementation".into(),
        context_id: "root".into(),
        inputs: std::collections::BTreeMap::from([("ticket.md".into(), vec![seed])]),
        complete_collection_id: None,
        each_collection_id: None,
        each_member_id: None,
        manual: false,
    };
    let execution_id = reserve_execution(&repo, "task", &saved.definition, &mut saved.state, candidate, &Default::default(), None, false).unwrap();
    let record = saved.state.executions[&execution_id].clone();
    let output = &record.outputs[0].relative_path;
    fs::create_dir_all(artifacts_dir(&repo, "task")).unwrap();
    fs::write(artifacts_dir(&repo, "task").join(output), "# Saved report\n").unwrap();
    write_execution_state_unlocked(&repo, "task", &mut saved.state).unwrap();
    let stale = SessionMeta {
        id: "stale-session".into(),
        phase: "stale-step".into(),
        artifact: output.clone(),
        ..Default::default()
    };
    fs::write(sessions_dir(&repo, "task").join("stale-session.meta.json"), serde_json::to_vec(&stale).unwrap()).unwrap();
    let state_path = alinery_core::execution::execution_state_path(&repo, "task").unwrap();
    let before = fs::read(&state_path).unwrap();
    let owner = AppState::default();
    assert!(owner.claim_repo(&repo));
    let items = alinery_core::with_task_mutation_lock(&repo, "hold while browsing artifacts", || crate::list_artifacts_with_metadata_in(&repo, "task")).unwrap();
    let item = items.iter().find(|item| &item.name == output).unwrap();
    assert_eq!(item.execution_id.as_deref(), Some(execution_id.as_str()));
    assert_eq!(item.session_id, record.owner_session_id);
    assert_eq!(item.playbook_step, "implementation");
    assert_eq!(item.accepted, Some(false));
    assert_eq!(fs::read(&state_path).unwrap(), before);
    assert!(!alinery_core::alineryd_socket_path(&repo, Some("offline-owner")).exists());
    assert!(!crate::current_alineryd_socket_path(&repo).exists());
    assert!(!alinery_core::alineryd_lock_path(&repo, Some("offline-owner")).exists());
    fs::write(alinery_core::execution::task_playbook_path(&repo, "task").unwrap(), "corrupt definition").unwrap();
    assert!(crate::list_artifacts_with_metadata_in(&repo, "task").is_err());
    fs::write(state_path, "corrupt state").unwrap();
    assert!(crate::list_artifacts_with_metadata_in(&repo, "task").is_err());
    fs::remove_dir_all(repo).unwrap();
}
