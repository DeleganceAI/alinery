use std::fs;
use std::path::{Path, PathBuf};

use crate::lockfile::with_task_mutation_lock;
use crate::paths::{artifacts_dir, safe_component, sessions_dir, tasks_dir, worktrees_dir};
use crate::types::{RelatedTaskRef, Task};
use crate::write_bytes_atomic;

pub fn slugify(name: &str) -> String {
    name.to_lowercase().replace(' ', "-").chars().filter(|c| c.is_alphanumeric() || *c == '-').collect()
}

pub fn unique_slug(repo: &Path, base: &str) -> String {
    let mut slug = base.to_string();
    let mut i = 1;
    while task_dir(repo, &slug).exists() {
        slug = format!("{}-{}", base, i);
        i += 1;
    }
    slug
}

pub fn task_dir(repo: &Path, slug: &str) -> std::path::PathBuf {
    tasks_dir(repo).join(slug)
}

/// Directory of related-task artifact links: `<task>/related/`, not under `artifacts/`.
pub fn related_links_dir(repo: &Path, slug: &str) -> PathBuf {
    task_dir(repo, slug).join("related")
}

pub const RELATED_TASKS_MARKDOWN: &str = "related-tasks.md";

pub fn related_tasks_markdown_path(repo: &Path, slug: &str) -> PathBuf {
    artifacts_dir(repo, slug).join(RELATED_TASKS_MARKDOWN)
}
pub fn related_link_name(repo_path: &str, slug: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in repo_path.as_bytes().iter().copied().chain(std::iter::once(0)).chain(slug.bytes()) {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{slug}-{hash:08x}")
}

/// Replace `<task>/related/` directory-symlinks so they match `related`.
/// Only removes existing symlinks; never deletes a regular file or directory.
pub fn sync_related_artifact_links(repo: &Path, slug: &str, related: &[RelatedTaskRef]) -> Result<(), String> {
    let dir = related_links_dir(repo, slug);
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let mut desired: Vec<(String, PathBuf)> = Vec::new();
    for tag in related {
        let name = related_link_name(&tag.repo_path, &tag.slug);
        if safe_component(&name) != Some(name.as_str()) {
            return Err(format!("unsafe related-task link name '{name}'"));
        }
        desired.push((name, artifacts_dir(Path::new(&tag.repo_path), &tag.slug)));
    }

    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if desired.iter().any(|(want, _)| want == name) {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                fs::remove_file(&path).map_err(|e| format!("remove {}: {e}", path.display()))?;
            }
        }
    }

    for (name, target) in &desired {
        let path = dir.join(name);
        match fs::read_link(&path) {
            Ok(existing) if existing == *target => continue,
            Ok(_) => fs::remove_file(&path).map_err(|e| format!("replace {}: {e}", path.display()))?,
            Err(_) if path.exists() => {
                return Err(format!("related-task link path is not a symlink: {}", path.display()));
            }
            Err(_) => {}
        }
        std::os::unix::fs::symlink(target, &path).map_err(|e| format!("symlink {}: {e}", path.display()))?;
    }
    write_related_tasks_markdown(repo, slug, related)?;
    Ok(())
}

pub fn write_related_tasks_markdown(repo: &Path, slug: &str, related: &[RelatedTaskRef]) -> Result<(), String> {
    let path = related_tasks_markdown_path(repo, slug);
    if related.is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    let mut body = String::from("# Related tasks\n\nTagged from this task. Tickets are inlined; further artifacts live at the listed directories.\n");
    for tag in related {
        let artifacts = artifacts_dir(Path::new(&tag.repo_path), &tag.slug);
        let ticket_path = artifacts.join("00-ticket.md");
        let name = if tag.name.is_empty() { tag.slug.as_str() } else { tag.name.as_str() };
        body.push_str(&format!(
            "\n## {name} (`{}`)\n\nRepository: `{}`\nArtifacts directory: `{}`\nTicket path: `{}`\n",
            tag.slug,
            tag.repo_path,
            artifacts.display(),
            ticket_path.display(),
        ));
        match fs::read_to_string(&ticket_path) {
            Ok(ticket) if !ticket.trim().is_empty() => {
                let ticket = truncate_at_char_boundary(&ticket, 32_768);
                body.push_str("\n### Ticket\n\n");
                body.push_str(&ticket);
                if !ticket.ends_with('\n') {
                    body.push('\n');
                }
            }
            _ => body.push_str("\n_Ticket not readable._\n"),
        }
    }
    fs::create_dir_all(artifacts_dir(repo, slug)).map_err(|e| format!("create {}: {e}", artifacts_dir(repo, slug).display()))?;
    write_bytes_atomic(&path, body.as_bytes()).map_err(|e| format!("write {}: {e}", path.display()))
}

fn truncate_at_char_boundary(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…\n", &s[..end])
}

/// Point the launch seed at `artifacts/related-tasks.md` so the harness reads it like `00-ticket.md`.
pub fn append_related_tasks_prompt(repo: &Path, task: &Task, mut prompt: String) -> String {
    if task.related_tasks.is_empty() {
        return prompt;
    }
    let index = related_tasks_markdown_path(repo, &task.slug);
    prompt.push_str(&format!(
        "\n\n## Related tasks\n\nRead `{index}` for tagged related tasks and their inlined tickets. That file lives in this task's artifacts directory.\n",
        index = index.display(),
    ));
    prompt
}

pub fn read_task(repo: &Path, slug: &str) -> Option<Task> {
    let p = task_dir(repo, slug).join("task.md");
    fs::read_to_string(p).ok().and_then(|s| toml::from_str::<Task>(&s).ok())
}

pub fn write_task(repo: &Path, task: &Task) -> Result<(), String> {
    with_task_mutation_lock(repo, "write task", || write_task_unlocked(repo, task))
}

pub(crate) fn write_task_unlocked(repo: &Path, task: &Task) -> Result<(), String> {
    let path = task_dir(repo, &task.slug).join("task.md");
    let serialized = toml::to_string(task).map_err(|e| e.to_string())?;
    write_bytes_atomic(&path, serialized.as_bytes()).map_err(|e| format!("write {}: {e}", path.display()))
}

pub fn mutate_task<T>(repo: &Path, slug: &str, operation: &str, mutate: impl FnOnce(&mut Task) -> Result<T, String>) -> Result<T, String> {
    with_task_mutation_lock(repo, operation, || {
        let mut task = read_task(repo, slug).ok_or_else(|| format!("no such task: {slug}"))?;
        let result = mutate(&mut task)?;
        write_task_unlocked(repo, &task)?;
        Ok(result)
    })
}

pub fn restore_task(repo: &Path, slug: &str) -> Result<(), String> {
    with_task_mutation_lock(repo, "restore task", || {
        let mut task = read_task(repo, slug).ok_or_else(|| format!("no such task: {slug}"))?;
        if !task.parent_task.is_empty() {
            return Err(format!("cannot restore child task: {slug}"));
        }
        if !task.archived {
            return Ok(());
        }
        task.archived = false;
        write_task_unlocked(repo, &task)
    })
}

pub fn list_tasks_for_repo(repo: &Path) -> Vec<Task> {
    let dir = tasks_dir(repo);
    if !dir.exists() {
        return vec![];
    }
    fs::read_dir(dir).ok().map_or(vec![], |rd| {
        let mut out: Vec<Task> = rd
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let slug = e.file_name().to_string_lossy().to_string();
                read_task(repo, &slug)
            })
            .filter(|t| !t.archived)
            .collect();
        out.sort_by(|a, b| a.created.cmp(&b.created).then_with(|| a.slug.cmp(&b.slug)));
        out
    })
}

pub const TICKET_EVIDENCE_HEADING: &str = "## Evidence & Pointers";

/// The single format for every `00-ticket.md` alinery writes. Returns "" when there is nothing to
/// say; callers skip the write. `failures` entries are already `"<entry> — <reason>"`.
pub fn compose_ticket(name: &str, description: &str, evidence: &str, urls: &[String], copied: &[String], failures: &[String]) -> String {
    let description = description.trim();
    let evidence = evidence.trim();
    let has_evidence = !evidence.is_empty() || !urls.is_empty() || !copied.is_empty() || !failures.is_empty();
    if description.is_empty() && !has_evidence {
        return String::new();
    }
    let mut out = format!("# {name}\n");
    if !description.is_empty() {
        out.push_str(&format!("\n{description}\n"));
    }
    if has_evidence {
        out.push_str(&format!("\n{TICKET_EVIDENCE_HEADING}\n"));
        if !evidence.is_empty() {
            out.push_str(&format!("\n{evidence}\n"));
        }
        if !urls.is_empty() || !copied.is_empty() || !failures.is_empty() {
            out.push('\n');
            for url in urls {
                out.push_str(&format!("- {url}\n"));
            }
            for file in copied {
                out.push_str(&format!("- attachments/{file}\n"));
            }
            for failure in failures {
                out.push_str(&format!("- (not copied: {failure})\n"));
            }
        }
    }
    out
}

// Create dirs and write ticket if description provided (like app).
// Does NOT do the git worktree (caller or mcp handler does).
pub fn prepare_task_dirs_and_ticket(repo: &Path, slug: &str, name: &str, description: &str) -> Result<(), String> {
    fs::create_dir_all(tasks_dir(repo)).map_err(|e| e.to_string())?;
    fs::create_dir_all(worktrees_dir(repo)).map_err(|e| e.to_string())?;
    fs::create_dir_all(sessions_dir(repo, slug)).map_err(|e| e.to_string())?;
    fs::create_dir_all(artifacts_dir(repo, slug)).map_err(|e| e.to_string())?;
    let ticket = compose_ticket(name, description, "", &[], &[], &[]);
    if !ticket.is_empty() {
        fs::write(artifacts_dir(repo, slug).join("00-ticket.md"), ticket).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;

    static TEST_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp(name: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos();
        let seq = TEST_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{name}_{}_{}_{}", std::process::id(), nanos, seq))
    }

    #[test]
    fn compose_ticket_matches_the_legacy_description_only_format() {
        assert_eq!(compose_ticket("Name", "desc", "", &[], &[], &[]), "# Name\n\ndesc\n");
        // Untrimmed input must still produce the legacy bytes: the composer trims.
        assert_eq!(compose_ticket("Name", "  desc \n", "  ", &[], &[], &[]), "# Name\n\ndesc\n");
    }

    #[test]
    fn compose_ticket_is_empty_when_there_is_nothing_to_say() {
        assert_eq!(compose_ticket("Name", "", "", &[], &[], &[]), "");
        assert_eq!(compose_ticket("Name", "  \n ", "\t", &[], &[], &[]), "");
    }

    #[test]
    fn compose_ticket_omits_the_description_blank_line_when_evidence_only() {
        let out = compose_ticket("Name", "", "just evidence", &[], &[], &[]);
        assert!(out.starts_with(&format!("# Name\n\n{TICKET_EVIDENCE_HEADING}\n")), "{out:?}");
        assert!(!out.contains("\n\n\n"), "{out:?}");
        assert_eq!(out, "# Name\n\n## Evidence & Pointers\n\njust evidence\n");
    }

    #[test]
    fn compose_ticket_orders_evidence_urls_copies_then_failures() {
        let out = compose_ticket(
            "Name",
            "desc",
            "stack trace here",
            &["https://x/y".to_string()],
            &["trace.log".to_string()],
            &["/bogus — not a regular file".to_string()],
        );
        assert_eq!(
            out,
            "# Name\n\ndesc\n\n## Evidence & Pointers\n\nstack trace here\n\n\
             - https://x/y\n\
             - attachments/trace.log\n\
             - (not copied: /bogus — not a regular file)\n"
        );
    }

    #[test]
    fn compose_ticket_emits_the_heading_when_only_lists_are_present() {
        let out = compose_ticket("Name", "desc", "", &["https://x/y".to_string()], &[], &[]);
        assert_eq!(out, "# Name\n\ndesc\n\n## Evidence & Pointers\n\n- https://x/y\n");
    }

    #[test]
    fn prepare_task_dirs_and_ticket_writes_the_legacy_ticket() {
        let repo = unique_temp("alinery_prepare_ticket");
        let _ = fs::remove_dir_all(&repo);
        prepare_task_dirs_and_ticket(&repo, "task-a", "Name", "  desc  ").unwrap();
        assert_eq!(fs::read_to_string(artifacts_dir(&repo, "task-a").join("00-ticket.md")).unwrap(), "# Name\n\ndesc\n");
        // An empty description still writes no ticket at all.
        prepare_task_dirs_and_ticket(&repo, "task-b", "Name", "   ").unwrap();
        assert!(!artifacts_dir(&repo, "task-b").join("00-ticket.md").exists());
        let _ = fs::remove_dir_all(&repo);
    }

    fn relationship_task(slug: &str) -> Task {
        Task {
            name: slug.into(),
            slug: slug.into(),
            requested_slug: "requested".into(),
            branch: slug.into(),
            worktree: format!("/tmp/{slug}"),
            has_worktree: true,
            created: 1,
            parent_task: "parent".into(),
            active_subtask: "child".into(),
            ..Default::default()
        }
    }

    fn restore_fixture(slug: &str) -> Task {
        Task {
            name: "Archived draft".into(),
            slug: slug.into(),
            requested_slug: "requested-archive".into(),
            branch: "feature/restore".into(),
            worktree: format!("/tmp/{slug}"),
            has_worktree: true,
            created: 42,
            archived: true,
            pr_url: "https://example.com/pr/42".into(),
            linear_id: "LIN-42".into(),
            github_issue: "GH-42".into(),
            playbook: "custom".into(),
            auto_advance: vec!["research".into(), "plan".into()],
            active_subtask: "child".into(),
            draft: true,
            related_tasks: vec![RelatedTaskRef {
                repo_path: "/other/repo".into(),
                slug: "related".into(),
                name: "Related".into(),
            }],
            ..Default::default()
        }
    }

    #[test]
    fn restore_task_changes_only_archived_value_and_preserves_owned_files() {
        let repo = unique_temp("alinery_restore_preserves");
        let task = restore_fixture("task-a");
        write_task(&repo, &task).unwrap();
        let sentinels = [
            (artifacts_dir(&repo, "task-a").join("01-research.md"), b"artifact bytes".as_slice()),
            (sessions_dir(&repo, "task-a").join("session.meta.json"), b"session bytes".as_slice()),
            (sessions_dir(&repo, "task-a").join("session.scrollback"), b"scrollback bytes".as_slice()),
            (worktrees_dir(&repo).join("task-a").join("sentinel"), b"worktree bytes".as_slice()),
        ];
        for (path, bytes) in &sentinels {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }

        let before = read_task(&repo, "task-a").unwrap();
        restore_task(&repo, "task-a").unwrap();
        let after = read_task(&repo, "task-a").unwrap();
        let mut expected = before;
        expected.archived = false;
        assert_eq!(toml::to_string(&after).unwrap(), toml::to_string(&expected).unwrap());
        for (path, bytes) in &sentinels {
            assert_eq!(fs::read(path).unwrap(), *bytes);
        }

        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn restore_task_active_top_level_is_idempotent() {
        let repo = unique_temp("alinery_restore_idempotent");
        let mut task = restore_fixture("task-a");
        task.archived = false;
        write_task(&repo, &task).unwrap();
        let artifact = artifacts_dir(&repo, "task-a").join("01.md");
        fs::create_dir_all(artifact.parent().unwrap()).unwrap();
        fs::write(&artifact, "unchanged").unwrap();
        let task_path = task_dir(&repo, "task-a").join("task.md");
        let task_bytes = fs::read(&task_path).unwrap();
        let task_modified = fs::metadata(&task_path).unwrap().modified().unwrap();

        restore_task(&repo, "task-a").unwrap();
        restore_task(&repo, "task-a").unwrap();

        assert_eq!(fs::read(&task_path).unwrap(), task_bytes);
        assert_eq!(fs::metadata(&task_path).unwrap().modified().unwrap(), task_modified);
        assert_eq!(fs::read_to_string(artifact).unwrap(), "unchanged");
        assert!(!read_task(&repo, "task-a").unwrap().archived);
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn restore_task_rejects_finalized_and_legacy_children() {
        let repo = unique_temp("alinery_restore_children");
        for (index, outcome) in ["merged", "finished", "killed", ""].into_iter().enumerate() {
            let slug = format!("child-{index}");
            let mut task = restore_fixture(&slug);
            task.parent_task = "parent".into();
            task.subtask_outcome = outcome.into();
            write_task(&repo, &task).unwrap();
            let before = fs::read(task_dir(&repo, &slug).join("task.md")).unwrap();

            let error = restore_task(&repo, &slug).unwrap_err();

            assert!(error.contains(&slug), "{error}");
            assert_eq!(fs::read(task_dir(&repo, &slug).join("task.md")).unwrap(), before);
            assert!(read_task(&repo, &slug).unwrap().archived);
        }
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn restore_task_missing_record_remains_absent() {
        let repo = unique_temp("alinery_restore_missing");
        let error = restore_task(&repo, "missing").unwrap_err();
        assert_eq!(error, "no such task: missing");
        assert!(!task_dir(&repo, "missing").exists());
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn task_mutation_preserves_complete_relationship_record() {
        let repo = unique_temp("alinery_task_mutation_preserves");
        let task = relationship_task("task-a");
        write_task(&repo, &task).unwrap();
        mutate_task(&repo, "task-a", "archive", |current| {
            current.archived = true;
            Ok(())
        })
        .unwrap();

        let updated = read_task(&repo, "task-a").unwrap();
        assert!(updated.archived);
        assert_eq!(updated.requested_slug, "requested");
        assert_eq!(updated.parent_task, "parent");
        assert_eq!(updated.active_subtask, "child");
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn task_mutation_atomic_writes_never_expose_partial_toml() {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;

        let repo = unique_temp("alinery_task_mutation_atomic");
        write_task(&repo, &relationship_task("task-a")).unwrap();
        let done = Arc::new(AtomicBool::new(false));
        let reader_repo = repo.clone();
        let reader_done = Arc::clone(&done);
        let reader = std::thread::spawn(move || {
            let path = task_dir(&reader_repo, "task-a").join("task.md");
            while !reader_done.load(Ordering::Acquire) {
                let bytes = fs::read_to_string(&path).unwrap();
                toml::from_str::<Task>(&bytes).expect("reader observed partial task TOML");
            }
        });

        for index in 0..100 {
            mutate_task(&repo, "task-a", "rename", |task| {
                task.name = format!("task-{index}");
                Ok(())
            })
            .unwrap();
        }
        done.store(true, Ordering::Release);
        reader.join().unwrap();
        assert_eq!(read_task(&repo, "task-a").unwrap().name, "task-99");
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn task_mutation_failed_temp_write_preserves_complete_old_record() {
        use std::os::unix::fs::PermissionsExt;

        let repo = unique_temp("alinery_task_mutation_failure");
        write_task(&repo, &relationship_task("task-a")).unwrap();
        let dir = task_dir(&repo, "task-a");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();
        let result = mutate_task(&repo, "task-a", "failing rename", |task| {
            task.name = "new name".into();
            Ok(())
        });
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();

        assert!(result.is_err());
        let old = read_task(&repo, "task-a").expect("old task remains complete");
        assert_eq!(old.name, "task-a");
        assert_eq!(old.parent_task, "parent");
        assert_eq!(old.active_subtask, "child");
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn sync_related_artifact_links_creates_and_replaces_symlinks_outside_artifacts() {
        let repo = unique_temp("related_links_src");
        let other = unique_temp("related_links_dst");
        fs::create_dir_all(artifacts_dir(&repo, "here")).unwrap();
        fs::create_dir_all(artifacts_dir(&other, "there")).unwrap();
        fs::write(artifacts_dir(&other, "there").join("00-ticket.md"), "# There\n\nDo the thing.\n").unwrap();
        fs::write(artifacts_dir(&other, "there").join("01.md"), "from-there").unwrap();

        let tag = RelatedTaskRef {
            repo_path: other.to_string_lossy().into_owned(),
            slug: "there".into(),
            name: "There".into(),
        };
        sync_related_artifact_links(&repo, "here", std::slice::from_ref(&tag)).unwrap();

        let link = related_links_dir(&repo, "here").join(related_link_name(&tag.repo_path, &tag.slug));
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(link.join("01.md")).unwrap(), "from-there");
        assert!(!artifacts_dir(&repo, "here").join("related").exists());
        let index = fs::read_to_string(related_tasks_markdown_path(&repo, "here")).unwrap();
        assert!(index.contains("## There (`there`)"));
        assert!(index.contains("Do the thing."));

        sync_related_artifact_links(&repo, "here", &[]).unwrap();
        assert!(!link.exists());
        assert!(!related_tasks_markdown_path(&repo, "here").exists());
        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(other);
    }

    #[test]
    fn related_tasks_prompt_points_at_artifacts_markdown_and_is_silent_when_empty() {
        let repo = PathBuf::from("/repo");
        let mut task = relationship_task("here");
        task.related_tasks.clear();
        assert_eq!(append_related_tasks_prompt(&repo, &task, "base".into()), "base");

        task.related_tasks = vec![RelatedTaskRef {
            repo_path: "/other".into(),
            slug: "there".into(),
            name: "There".into(),
        }];
        let out = append_related_tasks_prompt(&repo, &task, "base".into());
        let index = related_tasks_markdown_path(&repo, "here");
        assert!(out.contains(&format!("Read `{index}`", index = index.display())));
        assert!(!out.contains("/other/.alinery/tasks/there/artifacts"));
    }

    #[test]
    fn ticket_truncate_does_not_panic_on_a_multibyte_boundary() {
        let ticket = "é".repeat(20_000);
        let cut = truncate_at_char_boundary(&ticket, 3);
        assert!(cut.ends_with("…\n"));
        assert!(cut.is_char_boundary(cut.len() - "…\n".len()));
        assert_eq!(truncate_at_char_boundary("short", 32_768), "short");
    }

    #[test]
    fn related_tasks_prompt_does_not_write_markdown() {
        let repo = unique_temp("related_prompt_no_write");
        let mut task = relationship_task("here");
        task.related_tasks = vec![RelatedTaskRef {
            repo_path: "/other".into(),
            slug: "there".into(),
            name: "There".into(),
        }];
        let _ = append_related_tasks_prompt(&repo, &task, "base".into());
        assert!(!related_tasks_markdown_path(&repo, "here").exists());
        let _ = fs::remove_dir_all(repo);
    }
}
