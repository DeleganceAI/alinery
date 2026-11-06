//! Tests for task.rs — tasks, drafts, attachments, board projection, targeted (per-repo) helpers
//!
//! `use super::*` reaches the shared imports and fixtures in tests/mod.rs.
use super::*;
use crate::{artifacts_dir, chat_file_stat, copy_chat_attachments_in, read_chat_image_in, write_chat_attachment_bytes_in, MAX_CHAT_IMAGE_BYTES};
use std::collections::BTreeMap;

#[test]
fn draft_attachments_roundtrip_replace_and_reject_promoted_writes() {
    use crate::{read_draft_attachments_in, DraftAttachments, DraftImage};

    let repo = unique_attachment_temp("draft-attachments");
    let save = |slug: &str, attachments: Option<DraftAttachments>| {
        write_draft_in_with_slug(
            &repo,
            None,
            slug,
            "",
            "Image Draft".into(),
            "description".into(),
            String::new(),
            String::new(),
            String::new(),
            alinery_core::playbook::PlaybookRef {
                scope: alinery_core::playbook::PlaybookScope::Bundled,
                key: default_playbook_key(),
            },
            "claude".into(),
            String::new(),
            None,
            None,
            10,
            String::new(),
            String::new(),
            None,
            attachments,
        )
    };
    let draft = save("", None).unwrap();
    assert_eq!(read_draft_attachments_in(&repo, &draft.slug).unwrap(), DraftAttachments::default());
    let snapshot = DraftAttachments {
        entries: vec!["/tmp/local screenshot.png".into(), "https://example.com/reference".into()],
        images: vec![DraftImage {
            name: "pasted.png".into(),
            bytes: vec![0, 127, 128, 255],
            mime_type: "image/png".into(),
        }],
    };
    save(&draft.slug, Some(snapshot.clone())).unwrap();
    assert_eq!(read_draft_attachments_in(&repo, &draft.slug).unwrap(), snapshot);
    let path = task_dir(&repo, &draft.slug).join("draft-attachments.json");
    let json: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(json["images"][0]["bytes"], "AH+A/w==");
    assert!(!artifacts_dir(&repo, &draft.slug).join("draft-attachments.json").exists());
    assert!(!attachments_of(&repo, &draft.slug).exists());

    let replacement = DraftAttachments {
        entries: vec!["https://example.com/replacement".into()],
        images: vec![],
    };
    save(&draft.slug, Some(replacement.clone())).unwrap();
    assert_eq!(read_draft_attachments_in(&repo, &draft.slug).unwrap(), replacement);
    save(&draft.slug, None).unwrap();
    assert_eq!(read_draft_attachments_in(&repo, &draft.slug).unwrap(), replacement);
    save(&draft.slug, Some(DraftAttachments::default())).unwrap();
    assert_eq!(read_draft_attachments_in(&repo, &draft.slug).unwrap(), DraftAttachments::default());

    let mut invalid = snapshot.clone();
    invalid.images[0].name = "../escape.png".into();
    assert!(save(&draft.slug, Some(invalid)).is_err());
    assert_eq!(read_draft_attachments_in(&repo, &draft.slug).unwrap(), DraftAttachments::default());
    alinery_core::mutate_task(&repo, &draft.slug, "promote test draft", |task| {
        task.draft = false;
        Ok(())
    })
    .unwrap();
    assert!(save(&draft.slug, Some(snapshot)).unwrap_err().contains("promoted"));
    assert_eq!(read_draft_attachments_in(&repo, &draft.slug).unwrap(), DraftAttachments::default());

    fs::write(&path, b"invalid json").unwrap();
    assert!(read_draft_attachments_in(&repo, &draft.slug).is_err());
    assert!(read_draft_attachments_in(&repo, "../escape").is_err());
    assert!(read_draft_attachments_in(&repo, "missing-task").is_err());
    fs::remove_dir_all(repo).unwrap();
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
fn draft_source_roundtrips_independently_of_destination() {
    let repo = init_git_test_repo("draft-source-roundtrip");
    let oid = alinery_core::git_cmd(&repo).args(["rev-parse", "HEAD"]).output().unwrap();
    assert!(oid.status.success());
    let oid = String::from_utf8(oid.stdout).unwrap();
    let mut slug = String::new();
    for source in [
        Some("refs/heads/release/next"),
        Some(oid.trim()),
        Some("refs/heads/deleted"),
        Some("  HEAD~1  "),
        Some(""),
        None,
    ] {
        let task = write_draft_in_with_slug(
            &repo,
            None,
            &slug,
            "",
            "Source Roundtrip".into(),
            "composition survives unavailable sources".into(),
            String::new(),
            String::new(),
            String::new(),
            alinery_core::playbook::PlaybookRef {
                scope: alinery_core::playbook::PlaybookScope::Bundled,
                key: default_playbook_key(),
            },
            "claude".into(),
            String::new(),
            None,
            None,
            10,
            "destination-branch".into(),
            "destination-worktree".into(),
            source.map(str::to_owned),
            None,
        )
        .unwrap();
        if !slug.is_empty() {
            assert_eq!(task.slug, slug);
        }
        slug = task.slug;
        let persisted = read_task(&repo, &slug).unwrap();
        assert_eq!(persisted.draft_base_ref.as_deref(), source);
        assert_eq!(persisted.branch, "destination-branch");
        assert_eq!(persisted.worktree, "destination-worktree");
        let stored = fs::read_to_string(task_dir(&repo, &slug).join("task.md")).unwrap();
        let stored: toml::Value = toml::from_str(&stored).unwrap();
        assert_eq!(stored.get("draft_base_ref").and_then(toml::Value::as_str), source);
        let ticket = fs::read_to_string(artifacts_dir(&repo, &slug).join("00-ticket.md")).unwrap();
        assert!(ticket.contains("composition survives unavailable sources"));
    }
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn draft_step_models_round_trip() {
    let repo = init_git_test_repo("draft-step-models");
    let reference = alinery_core::playbook::PlaybookRef {
        scope: alinery_core::playbook::PlaybookScope::Bundled,
        key: default_playbook_key(),
    };
    let mut models = BTreeMap::new();
    models.insert("clarify".into(), " override ".into());
    models.insert("plan".into(), "  ".into());
    let save = |slug: &str, step_models: Option<BTreeMap<String, String>>| {
        write_draft_in_with_slug(
            &repo,
            None,
            slug,
            "",
            "Step Models".into(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            reference.clone(),
            "omp".into(),
            String::new(),
            None,
            step_models,
            10,
            String::new(),
            String::new(),
            None,
            None,
        )
        .unwrap()
    };
    let first = save("", Some(models));
    let mut expected = BTreeMap::new();
    expected.insert("clarify".into(), "override".into());
    assert_eq!(read_task(&repo, &first.slug).unwrap().step_models, expected);
    let missing = save(&first.slug, None);
    assert!(missing.step_models.is_empty(), "a missing map must not invent keys: {:?}", missing.step_models);
    let cleared = save(&first.slug, Some(BTreeMap::new()));
    assert!(cleared.step_models.is_empty());
    let _ = fs::remove_dir_all(repo);
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
fn write_draft_in_rejects_empty_name() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-write-draft-empty-{n}"));
    fs::create_dir_all(&repo).unwrap();

    let err = write_draft_in_with_slug(
        &repo,
        None,
        "",
        "",
        "  ".into(),
        "desc".into(),
        "".into(),
        "".into(),
        "".into(),
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Bundled,
            key: default_playbook_key(),
        },
        "claude".into(),
        String::new(),
        None,
        None,
        10,
        "".into(),
        "".into(),
        None,
        None,
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

    let task = write_draft_in_with_slug(
        &repo,
        None,
        "",
        "",
        "Autosave Me".into(),
        "partial desc".into(),
        "".into(),
        "ENG-1".into(),
        "owner/repo#9".into(),
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Bundled,
            key: default_playbook_key(),
        },
        "claude".into(),
        "opus".into(),
        Some(vec!["tdd".into()]),
        None,
        10,
        "feat/x".into(),
        "wt-x".into(),
        None,
        None,
    )
    .expect("write draft");

    assert!(task.draft);
    assert_eq!(task.name, "Autosave Me");
    assert_eq!(task.slug, "autosave-me");
    assert_eq!(task.linear_id, "ENG-1");
    assert_eq!(task.github_issue, "owner/repo#9");
    assert!(!repo.join(".alinery/tasks/autosave-me/sessions").exists());
    assert!(!repo.join(".alinery/worktrees").exists() || fs::read_dir(worktrees_dir(&repo)).map(|mut d| d.next().is_none()).unwrap_or(true));
    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn write_draft_in_updates_same_slug() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-write-draft-update-{n}"));
    fs::create_dir_all(&repo).unwrap();

    let first = write_draft_in_with_slug(
        &repo,
        None,
        "",
        "",
        "Same Name".into(),
        "v1".into(),
        "".into(),
        "".into(),
        "".into(),
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Bundled,
            key: default_playbook_key(),
        },
        "claude".into(),
        String::new(),
        None,
        None,
        10,
        "".into(),
        "".into(),
        None,
        None,
    )
    .unwrap();
    let second = write_draft_in_with_slug(
        &repo,
        None,
        "",
        "",
        "Same Name".into(),
        "v2".into(),
        "".into(),
        "".into(),
        "".into(),
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Bundled,
            key: default_playbook_key(),
        },
        "codex".into(),
        "gpt".into(),
        None,
        None,
        10,
        "".into(),
        "".into(),
        None,
        None,
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

    let archived = write_draft_in_with_slug(
        &repo,
        None,
        "",
        "",
        "Archived Draft".into(),
        "keep this body".into(),
        "".into(),
        "ENG-1".into(),
        "".into(),
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Bundled,
            key: default_playbook_key(),
        },
        "claude".into(),
        String::new(),
        None,
        None,
        10,
        "".into(),
        "".into(),
        None,
        None,
    )
    .unwrap();
    alinery_core::mutate_task(&repo, &archived.slug, "archive test draft", |task| {
        task.archived = true;
        Ok(())
    })
    .unwrap();

    let replacement = write_draft_in_with_slug(
        &repo,
        None,
        "",
        "",
        "Archived Draft".into(),
        "new body".into(),
        "".into(),
        "ENG-2".into(),
        "".into(),
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Bundled,
            key: default_playbook_key(),
        },
        "claude".into(),
        String::new(),
        None,
        None,
        10,
        "".into(),
        "".into(),
        None,
        None,
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
fn draft_duplicate_regression_write_draft_reuses_suffixed_draft_when_base_slug_is_task() {
    let repo = init_git_test_repo("draft-duplicate-reuse");

    let real = create_task_for_test(&repo, "Duplicate Title", false, "", "");
    assert_eq!(real.slug, "duplicate-title");
    assert!(!real.draft);

    let first = write_draft_in_with_slug(
        &repo,
        None,
        "",
        "",
        "Duplicate Title".into(),
        "first autosave".into(),
        "".into(),
        "ENG-1".into(),
        "".into(),
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Bundled,
            key: default_playbook_key(),
        },
        "claude".into(),
        String::new(),
        None,
        None,
        10,
        "".into(),
        "".into(),
        None,
        None,
    )
    .unwrap();
    let second = write_draft_in_with_slug(
        &repo,
        None,
        "",
        "",
        "Duplicate Title".into(),
        "second autosave".into(),
        "".into(),
        "ENG-2".into(),
        "".into(),
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Bundled,
            key: default_playbook_key(),
        },
        "codex".into(),
        "gpt".into(),
        None,
        None,
        10,
        "".into(),
        "".into(),
        None,
        None,
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

    let real = create_task_for_test(&repo, "Supplied Draft", false, "", "");
    assert_eq!(real.slug, "supplied-draft");
    assert!(!real.draft);

    let draft = write_draft_in_with_slug(
        &repo,
        None,
        "",
        "",
        "Supplied Draft".into(),
        "first body".into(),
        "".into(),
        "ENG-1".into(),
        "".into(),
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Bundled,
            key: default_playbook_key(),
        },
        "claude".into(),
        String::new(),
        None,
        None,
        10,
        "".into(),
        "".into(),
        None,
        None,
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
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Bundled,
            key: default_playbook_key(),
        },
        "codex".into(),
        "gpt".into(),
        None,
        None,
        10,
        "updated-branch".into(),
        "".into(),
        None,
        None,
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
fn draft_ticket_carries_evidence_and_never_attachments() {
    let repo = unique_attachment_temp("draft-evidence");

    let draft = write_draft_in_with_slug(
        &repo,
        None,
        "",
        "",
        "Draft Task".into(),
        "the ask".into(),
        "log line one".into(),
        String::new(),
        String::new(),
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Bundled,
            key: default_playbook_key(),
        },
        "claude".into(),
        String::new(),
        None,
        None,
        10,
        String::new(),
        String::new(),
        None,
        None,
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

    let task = write_draft_in_with_slug(
        &repo,
        None,
        "",
        "",
        "Gone".into(),
        "".into(),
        "".into(),
        "".into(),
        "".into(),
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Bundled,
            key: default_playbook_key(),
        },
        "claude".into(),
        String::new(),
        None,
        None,
        10,
        "".into(),
        "".into(),
        None,
        None,
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
    let task = write_draft_in_with_slug(
        &repo,
        None,
        "",
        "",
        "Locked Draft".into(),
        String::new(),
        String::new(),
        String::new(),
        String::new(),
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Bundled,
            key: default_playbook_key(),
        },
        "claude".into(),
        String::new(),
        None,
        None,
        10,
        String::new(),
        String::new(),
        None,
        None,
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
fn rename_task_uses_owned_explicit_repo_and_returns_committed_record() {
    use tauri::Manager;
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo_a = init_git_test_repo("rename-task-a");
    let repo_b = init_git_test_repo("rename-task-b");
    for repo in [&repo_a, &repo_b] {
        write_activity_task(repo, "child", "implementation", true);
        let mut task = read_task(repo, "child").unwrap();
        task.archived = true;
        task.parent_task = "parent".into();
        write_task(repo, &task).unwrap();
    }
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!("test.alinery.task-names.{}", uuid::Uuid::new_v4());
    let app = tauri::test::mock_builder().manage(AppState::default()).build(context).unwrap();
    let config_path = crate::app_config_path(app.handle()).unwrap();
    crate::write_app_config_at(
        &config_path,
        &AppConfig {
            known_repos: vec![repo_a.display().to_string(), repo_b.display().to_string()],
            ..Default::default()
        },
    )
    .unwrap();
    set_active_repo_global(Some(repo_b.clone())).unwrap();
    let name = "A manually corrected child name longer than forty characters";
    let saved = tauri::async_runtime::block_on(crate::rename_task(
        app.handle().clone(),
        app.state(),
        repo_a.display().to_string(),
        "child".into(),
        format!("  {name}  "),
    ))
    .unwrap();
    assert_eq!(saved.name, name);
    assert_eq!(read_task(&repo_a, "child").unwrap().name, name);
    assert_ne!(read_task(&repo_b, "child").unwrap().name, name);
    assert!(tauri::async_runtime::block_on(crate::rename_task(
        app.handle().clone(),
        app.state(),
        repo_a.display().to_string(),
        "missing".into(),
        name.into()
    ))
    .is_err());
    assert!(tauri::async_runtime::block_on(crate::rename_task(app.handle().clone(), app.state(), "/unknown".into(), "child".into(), name.into())).is_err());
    let owner = AppState::default();
    assert!(owner.claim_repo(&repo_b));
    assert!(tauri::async_runtime::block_on(crate::rename_task(
        app.handle().clone(),
        app.state(),
        repo_b.display().to_string(),
        "child".into(),
        name.into()
    ))
    .is_err());
    assert!(!alinery_core::alineryd_socket_path(&repo_a, None).exists());
    set_active_repo_global(None).unwrap();
    drop(app);
    drop(owner);
    let _ = fs::remove_dir_all(config_path.parent().unwrap());
    let _ = fs::remove_dir_all(repo_a);
    let _ = fs::remove_dir_all(repo_b);
}

#[test]
fn targeted_draft_writes_land_only_in_selected_repo() {
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo_a = init_git_test_repo("targeted-draft-a");
    let repo_b = init_git_test_repo("targeted-draft-b");

    set_active_repo_global(Some(repo_a.clone())).unwrap();
    let known = vec![repo_a.display().to_string(), repo_b.display().to_string()];
    let target = validate_known_target_repo(&known, &repo_b.display().to_string()).unwrap();

    let draft = write_draft_in_with_slug(
        &target,
        None,
        "",
        "",
        "Only In B".into(),
        "draft body".into(),
        "".into(),
        "".into(),
        "".into(),
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Bundled,
            key: default_playbook_key(),
        },
        "claude".into(),
        String::new(),
        None,
        None,
        10,
        "".into(),
        "".into(),
        Some("refs/heads/source-in-b".into()),
        None,
    )
    .unwrap();

    assert!(task_dir(&repo_b, &draft.slug).join("task.md").exists());
    let persisted = read_task(&repo_b, &draft.slug).unwrap();
    assert_eq!(persisted.draft_base_ref.as_deref(), Some("refs/heads/source-in-b"));
    assert!(!task_dir(&repo_a, &draft.slug).exists());
    assert!(!crate::sessions_dir(&repo_a, &draft.slug).exists());
    assert!(!crate::worktrees_dir(&repo_a).exists());
    assert_eq!(crate::active_repo().unwrap(), repo_a);

    set_active_repo_global(None).unwrap();
    let _ = fs::remove_dir_all(repo_a);
    let _ = fs::remove_dir_all(repo_b);
}

#[test]
fn targeted_draft_cleanup_deletes_only_still_drafts() {
    let repo = init_git_test_repo("targeted-cleanup");

    let draft = write_draft_in_with_slug(
        &repo,
        None,
        "",
        "",
        "Draft Origin".into(),
        "".into(),
        "".into(),
        "".into(),
        "".into(),
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Bundled,
            key: default_playbook_key(),
        },
        "claude".into(),
        String::new(),
        None,
        None,
        10,
        "".into(),
        "".into(),
        None,
        None,
    )
    .unwrap();
    let promoted = create_task_for_test(&repo, "Promoted Origin", true, "", "");

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

    git_cmd(&repo_a).args(["remote", "add", "origin", "https://github.com/example/a.git"]).output().unwrap();
    git_cmd(&repo_b).args(["remote", "add", "origin", "https://github.com/example/b.git"]).output().unwrap();
    set_active_repo_global(Some(repo_a.clone())).unwrap();

    assert_eq!(parse_github_ref("#42", active_github_repo(&repo_b)).unwrap().label(), "example/b#42");
    assert_eq!(crate::active_repo().unwrap(), repo_a);

    set_active_repo_global(None).unwrap();
    let _ = fs::remove_dir_all(repo_a);
    let _ = fs::remove_dir_all(repo_b);
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
fn set_auto_approve_all_writes_both_files_without_changing_enabled_steps() {
    let repo = activity_repo("auto-approve-all");
    let task = write_retained_discovery_task(&repo, "here", "lane", false);
    let before = alinery_core::execution::read_execution_state(&repo, &task.slug).unwrap();
    let enabled = before.enabled_steps.clone();

    let updated = crate::set_auto_approve_all_in(&repo, task.slug.clone(), true).unwrap();
    assert!(updated.auto_approve_all);
    assert_eq!(updated.auto_advance, task.auto_advance);
    let on = alinery_core::execution::read_execution_state(&repo, &task.slug).unwrap();
    assert!(on.auto_approve_all);
    assert_eq!(on.enabled_steps, enabled);
    assert!(on.revision > before.revision);

    let updated = crate::set_auto_approve_all_in(&repo, task.slug.clone(), false).unwrap();
    assert!(!updated.auto_approve_all);
    let off = alinery_core::execution::read_execution_state(&repo, &task.slug).unwrap();
    assert!(!off.auto_approve_all);
    assert_eq!(off.enabled_steps, enabled);

    let archived = write_retained_discovery_task(&repo, "archived", "lane", true);
    assert!(crate::set_auto_approve_all_in(&repo, archived.slug, true).unwrap_err().contains("archived"));
    write_task(
        &repo,
        &Task {
            name: "Draft".into(),
            slug: "draft".into(),
            draft: true,
            engine_version: 2,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(crate::set_auto_approve_all_in(&repo, "draft".into(), true).unwrap_err().contains("draft"));
    let legacy = create_task_for_test(&repo, "Legacy", false, "", "");
    assert!(crate::set_auto_approve_all_in(&repo, legacy.slug, true).unwrap_err().contains("pre-v2"));
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
        &other,
        &Task {
            name: "There".into(),
            slug: "there".into(),
            ..Default::default()
        },
    )
    .unwrap();
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
            ..Default::default()
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
                ..Default::default()
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
fn duplicate_package_retains_definition_ticket_and_large_managed_input_without_history() {
    let repo = unique_attachment_temp("duplicate-retained");
    let task = retained_duplicate_fixture(&repo);
    let library = repo.join(".alinery/playbooks/one-shot");
    fs::create_dir_all(&library).unwrap();
    fs::write(library.join("playbook.md"), "invalid replacement").unwrap();
    fs::remove_dir_all(library).unwrap();
    let attachments = attachments_of(&repo, &task.slug);
    fs::create_dir_all(&attachments).unwrap();
    fs::File::create(attachments.join("managed.bin")).unwrap().set_len(MAX_ATTACHMENT_BYTES + 1).unwrap();
    fs::write(artifacts_dir(&repo, &task.slug).join("9-generated-1.md"), "not original input").unwrap();
    let package = crate::duplicate_task_package(&repo, &task.slug).unwrap();
    assert_eq!(package.playbook.source, include_str!("../../playbooks/one-shot/playbook.md"));
    assert_eq!(package.original_ticket.as_deref(), Some("# Edited original\nKeep exact bytes.\n"));
    assert_eq!(package.attachments.iter().map(|attachment| attachment.name.as_str()).collect::<Vec<_>>(), ["managed.bin"]);
    assert_eq!(package.attachments[0].bytes.len() as u64, MAX_ATTACHMENT_BYTES + 1);
    assert_eq!(package.name, "Original D+1");
    assert!(package.draft_slug.is_none());
    fs::remove_dir_all(repo).unwrap();
}

#[test]
fn duplicate_sends_parent_task_step_models() {
    let repo = unique_attachment_temp("duplicate-step-models");
    let mut task = retained_duplicate_fixture(&repo);
    task.step_models.insert("implementation".into(), "parent-override".into());
    write_task(&repo, &task).unwrap();
    let package = crate::duplicate_task_package(&repo, &task.slug).unwrap();
    assert_eq!(package.step_models.get("implementation").map(String::as_str), Some("parent-override"));
    fs::remove_dir_all(repo).unwrap();
}

#[test]
fn duplicate_reports_broken_retained_definition_instead_of_library_fallback() {
    let repo = unique_attachment_temp("retained-integrity");
    let task = retained_duplicate_fixture(&repo);
    fs::write(task_dir(&repo, &task.slug).join("playbook.md"), "changed").unwrap();
    assert!(crate::duplicate_task_package(&repo, &task.slug).is_err());
    fs::remove_dir_all(repo).unwrap();
}

#[test]
fn autosave_cannot_recreate_promoted_storage_slug_after_restore() {
    let repo = init_git_test_repo("promotion-autosave");
    let reference = alinery_core::playbook::PlaybookRef {
        scope: alinery_core::playbook::PlaybookScope::Bundled,
        key: "one-shot".into(),
    };
    let draft = write_draft_in_with_slug(
        &repo,
        None,
        "",
        "final-name",
        "Draft".into(),
        "before".into(),
        String::new(),
        String::new(),
        String::new(),
        reference.clone(),
        String::new(),
        String::new(),
        None,
        None,
        10,
        String::new(),
        String::new(),
        None,
        None,
    )
    .unwrap();
    let request: alinery_core::CreateTaskRequest = serde_json::from_value(serde_json::json!({
        "name": "Draft", "draft_slug": draft.slug, "requested_slug": "final-name", "description": "before",
        "playbook": { "reference": reference, "source": include_str!("../../playbooks/one-shot/playbook.md") },
        "start": false
    }))
    .unwrap();
    let created = alinery_core::provision_task(&repo, "", "fixture", &request).unwrap();
    assert_eq!(created.creation, "ready");
    let destination = repo.join("backups");
    fs::create_dir_all(&destination).unwrap();
    let settings = alinery_core::BackupDefaults {
        destination: destination.display().to_string(),
        enabled: true,
        ..Default::default()
    };
    alinery_core::create_backup(&repo, &settings, alinery_core::BackupTrigger::Manual, "test").unwrap();
    let archive = alinery_core::list_backups(&repo, &settings).unwrap().remove(0);
    let restored = repo.join("restored");
    fs::create_dir_all(&restored).unwrap();
    alinery_core::extract_backup_into(Path::new(&archive.path), &restored.join(".alinery"), Some(&repo)).unwrap();
    let late_save = write_draft_in_with_slug(
        &restored,
        None,
        &draft.slug,
        "final-name",
        "Draft".into(),
        "after".into(),
        String::new(),
        String::new(),
        String::new(),
        reference,
        String::new(),
        String::new(),
        None,
        None,
        10,
        String::new(),
        String::new(),
        None,
        None,
    );
    let resurrected = task_dir(&restored, &draft.slug).exists();
    let final_ticket = fs::read_to_string(artifacts_dir(&restored, "final-name").join("00-ticket.md")).unwrap();
    let replayed_promotion = alinery_core::provision_task(&restored, "", "fixture", &request);
    fs::remove_dir_all(repo).unwrap();
    assert!(late_save.is_err(), "a restored promotion must still close the old autosave identity");
    assert!(!resurrected);
    assert!(final_ticket.contains("before"));
    assert!(replayed_promotion.is_err(), "a repeated promotion must not create another task after restore");
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

// Clean up real preparation/provisioning fixtures even when a regression assertion fails.
struct PreparedAttachmentRepo(std::path::PathBuf);

impl Drop for PreparedAttachmentRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn prepared_attachment_request(entries: Vec<String>) -> alinery_core::CreateTaskRequest {
    // Use preparation's public serialized reply rather than exposing its private fields.
    // Consume each representation before decoding the next; never build JSON byte arrays.
    let mut package = serde_json::to_value(crate::prepare_task_attachments_in(entries)).unwrap();
    package["name"] = serde_json::json!("Prepared and pasted evidence");
    package["playbook"] = serde_json::json!({
        "reference": { "scope": "bundled", "key": "one-shot" },
        "source": include_str!("../../playbooks/one-shot/playbook.md")
    });
    package["start"] = serde_json::json!(false);
    serde_json::from_value(package).unwrap()
}

#[test]
fn prepared_paths_and_pasted_bytes_share_durable_admission() {
    let fixture = PreparedAttachmentRepo(init_git_test_repo("prepared-pasted-admission"));
    let repo = &fixture.0;
    let image = include_bytes!("../../icons/icon.png");
    let first = repo.join("first");
    let second = repo.join("second");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    fs::write(first.join("trace.log"), b"first").unwrap();
    fs::write(second.join("trace.log"), b"second").unwrap();
    let missing = repo.join("missing.png").display().to_string();
    let url = "https://example.invalid/image.png";
    let mut entries = vec![
        first.join("trace.log").display().to_string(),
        url.into(),
        missing.clone(),
        second.join("trace.log").display().to_string(),
    ];
    // Sparse source files keep fixture construction bounded; preparation reads real bytes.
    // Leave precisely one encoded image's allowance after the path-prepared package.
    for index in 0..4 {
        let source = repo.join(format!("part-{index}.bin"));
        let length = if index == 3 {
            MAX_ATTACHMENT_BYTES - image.len() as u64 - 11
        } else {
            MAX_ATTACHMENT_BYTES
        };
        fs::File::create(&source).unwrap().set_len(length).unwrap();
        entries.push(source.display().to_string());
    }
    let mut request = prepared_attachment_request(entries);
    assert_eq!(request.attachment_urls, [url]);
    assert_eq!(request.attachment_errors.len(), 1, "{:?}", request.attachment_errors);
    assert!(request.attachment_errors[0].contains(&missing));
    assert_eq!(
        request.attachments.iter().map(|attachment| attachment.bytes.len() as u64).sum::<u64>(),
        MAX_ATTACHMENT_SET_BYTES - image.len() as u64
    );
    request.attachments.extend([
        alinery_core::TaskAttachment {
            name: "pasted.png".into(),
            bytes: image.to_vec(),
        },
        alinery_core::TaskAttachment {
            name: "over-budget.png".into(),
            bytes: image.to_vec(),
        },
    ]);
    let reply = alinery_core::provision_task(repo, "", "fixture", &request).unwrap();
    assert_eq!(reply.creation, "ready", "{:?}", reply.errors);
    let artifacts = artifacts_dir(repo, &reply.task.unwrap().slug);
    let attachments = artifacts.join("attachments");
    assert_eq!(fs::read(attachments.join("trace.log")).unwrap(), b"first");
    assert_eq!(fs::read(attachments.join("trace-2.log")).unwrap(), b"second");
    assert_eq!(fs::read(attachments.join("pasted.png")).unwrap(), image.as_slice());
    assert!(
        !attachments.join("over-budget.png").exists(),
        "separately valid batches must share the final 100 MiB allowance"
    );
    let stored: u64 = fs::read_dir(&attachments).unwrap().map(|entry| entry.unwrap().metadata().unwrap().len()).sum();
    assert_eq!(stored, MAX_ATTACHMENT_SET_BYTES);
    assert_eq!(reply.errors.len(), 2, "{:?}", reply.errors);
    assert_eq!(reply.errors[0].message, request.attachment_errors[0]);
    assert!(reply.errors[1].message.contains("over-budget.png"));
    for error in &reply.errors {
        assert_eq!(error.stage, "attachments");
        assert_eq!(error.code, "import_failed");
    }
    let ticket = fs::read_to_string(artifacts.join("00-ticket.md")).unwrap();
    assert!(ticket.contains(url));
    for error in &reply.errors {
        assert!(ticket.contains(&error.message), "{ticket}");
    }
    let references: Vec<_> = ticket.lines().filter_map(|line| line.strip_prefix("- attachments/")).collect();
    assert_eq!(
        references,
        ["trace.log", "trace-2.log", "part-0.bin", "part-1.bin", "part-2.bin", "part-3.bin", "pasted.png"],
        "{ticket}"
    );
    for (reference, input) in references.into_iter().zip(&request.attachments) {
        assert_eq!(fs::read(attachments.join(reference)).unwrap(), input.bytes);
    }
}

#[test]
fn preparation_preserves_file_and_set_limits_with_empty_generic_files() {
    let fixture = PreparedAttachmentRepo(unique_attachment_temp("prepare-file-limits"));
    let repo = &fixture.0;
    let directory = repo.join("directory");
    fs::create_dir_all(&directory).unwrap();
    let oversize = repo.join("oversize.bin");
    fs::File::create(&oversize).unwrap().set_len(MAX_ATTACHMENT_BYTES + 1).unwrap();
    let empty = repo.join("empty.txt");
    fs::File::create(&empty).unwrap();
    let extra = repo.join("extra.bin");
    fs::write(&extra, [1]).unwrap();
    let mut entries = vec![directory.display().to_string(), oversize.display().to_string()];
    for index in 0..4 {
        let path = repo.join(format!("exact-{index}.bin"));
        fs::File::create(&path).unwrap().set_len(MAX_ATTACHMENT_BYTES).unwrap();
        entries.push(path.display().to_string());
    }
    entries.push(extra.display().to_string());
    entries.push(empty.display().to_string());
    let prepared = prepared_attachment_request(entries);
    assert!(prepared.attachment_urls.is_empty());
    assert_eq!(
        prepared.attachments.iter().map(|attachment| attachment.name.as_str()).collect::<Vec<_>>(),
        ["exact-0.bin", "exact-1.bin", "exact-2.bin", "exact-3.bin", "empty.txt"]
    );
    for attachment in &prepared.attachments[..4] {
        assert_eq!(attachment.bytes.len() as u64, MAX_ATTACHMENT_BYTES);
        assert!(attachment.bytes.iter().all(|byte| *byte == 0));
    }
    assert!(
        prepared.attachments[4].bytes.is_empty(),
        "empty generic files remain valid even when the byte allowance is full"
    );
    assert_eq!(prepared.attachment_errors.len(), 3, "{:?}", prepared.attachment_errors);
    for (error, source) in prepared.attachment_errors.iter().zip([directory, oversize, extra]) {
        assert!(error.contains(source.to_str().unwrap()), "{error}");
    }
}
