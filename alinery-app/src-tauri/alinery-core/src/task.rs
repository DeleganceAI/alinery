use std::fs;
use std::path::{Path, PathBuf};

use crate::lockfile::with_task_mutation_lock_waiting;
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
    with_task_mutation_lock_waiting(repo, "write task", crate::TASK_MUTATION_CONTENTION_WAIT, || write_task_unlocked(repo, task))
}

/// Caller holds the task mutation lock.
pub fn write_task_unlocked(repo: &Path, task: &Task) -> Result<(), String> {
    if read_task(repo, &task.slug).as_ref() == Some(task) {
        return Ok(());
    }
    let path = task_dir(repo, &task.slug).join("task.md");
    let serialized = toml::to_string(task).map_err(|e| e.to_string())?;
    write_bytes_atomic(&path, serialized.as_bytes()).map_err(|e| format!("write {}: {e}", path.display()))
}

pub fn mutate_task<T>(repo: &Path, slug: &str, operation: &str, mutate: impl FnOnce(&mut Task) -> Result<T, String>) -> Result<T, String> {
    with_task_mutation_lock_waiting(repo, operation, crate::TASK_MUTATION_CONTENTION_WAIT, || {
        let mut task = read_task(repo, slug).ok_or_else(|| format!("no such task: {slug}"))?;
        let result = mutate(&mut task)?;
        write_task_unlocked(repo, &task)?;
        Ok(result)
    })
}

pub fn validate_task_name(input: &str) -> Result<&str, String> {
    let name = input.trim();
    if name.is_empty() {
        return Err("task name is empty".into());
    }
    Ok(name)
}

pub fn rename_task(repo: &Path, task_slug: &str, name: &str) -> Result<Task, String> {
    let name = validate_task_name(name)?;
    if safe_component(task_slug) != Some(task_slug) {
        return Err("invalid task slug".into());
    }
    let path = task_dir(repo, task_slug).join("task.md");
    crate::paths::validate_retained_file(repo, &path)?;
    mutate_task(repo, task_slug, "rename task", |task| {
        crate::paths::validate_retained_file(repo, &path)?;
        if task.slug != task_slug {
            return Err("task slug does not match retained target".into());
        }
        task.name = name.to_owned();
        Ok(task.clone())
    })
}

pub fn restore_task(repo: &Path, slug: &str) -> Result<(), String> {
    with_task_mutation_lock_waiting(repo, "restore task", crate::TASK_MUTATION_CONTENTION_WAIT, || {
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
/// `copied` contains stored basenames; this composer adds the `attachments/` prefix.
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

/// A related task is one whose files this machine can read, so its repository must be an absolute path
/// here. A task in a repository on another machine cannot be linked: the reference would become a
/// dangling link and a prompt that points the agent at nothing, so it is refused up front.
pub fn validate_related_refs(related: &[RelatedTaskRef]) -> Result<(), String> {
    for tag in related {
        if !Path::new(tag.repo_path.trim()).is_absolute() {
            return Err(format!(
                "related task '{}' is not on this machine ({}); tasks can only be related to tasks on the same machine",
                tag.slug, tag.repo_path
            ));
        }
    }
    Ok(())
}

pub fn set_related_tasks_in(repo: &Path, slug: String, related: Vec<crate::RelatedTaskRef>) -> Result<Task, String> {
    let task = crate::board::read_task_checked(repo, &slug)?;
    if task.archived {
        return Err("task is archived — read-only".into());
    }
    let self_path = repo.to_string_lossy();
    let mut cleaned: Vec<crate::RelatedTaskRef> = Vec::new();
    for mut tag in related {
        tag.repo_path = tag.repo_path.trim().to_string();
        tag.slug = tag.slug.trim().to_string();
        tag.name = tag.name.trim().to_string();
        if tag.repo_path.is_empty() || tag.slug.is_empty() {
            return Err("related task is missing repo or slug".into());
        }
        validate_related_refs(std::slice::from_ref(&tag))?;
        if crate::safe_component(&tag.slug) != Some(tag.slug.as_str()) {
            return Err(format!("invalid related-task slug '{}'", tag.slug));
        }
        if tag.repo_path == self_path && tag.slug == slug {
            return Err("cannot tag a task as related to itself".into());
        }
        if cleaned.iter().any(|existing| existing.repo_path == tag.repo_path && existing.slug == tag.slug) {
            continue;
        }
        // A new tag must name a task this machine can read. A path from another machine (a remote
        // host's, or this Mac's seen from a host) fails here instead of becoming a dangling link. A tag
        // the task already has survives its repository going away, so a stale one can still be removed.
        let already_tagged = task.related_tasks.iter().any(|old| old.repo_path == tag.repo_path && old.slug == tag.slug);
        match crate::board::read_task_checked(Path::new(&tag.repo_path), &tag.slug) {
            Ok(other) if tag.name.is_empty() => tag.name = other.name,
            Ok(_) => {}
            Err(_) if already_tagged => {}
            Err(error) => {
                return Err(format!(
                    "related task '{}' was not found in {} on this machine ({error}); tasks can only be related to tasks on the same machine",
                    tag.slug, tag.repo_path
                ))
            }
        }
        cleaned.push(tag);
    }
    crate::with_task_mutation_lock_waiting(repo, "set related tasks", crate::TASK_MUTATION_CONTENTION_WAIT, || {
        let mut task = crate::board::read_task_checked(repo, &slug)?;
        if task.archived {
            return Err("task is archived — read-only".into());
        }
        task.related_tasks = cleaned;
        write_task_unlocked(repo, &task)?;
        crate::sync_related_artifact_links(repo, &task.slug, &task.related_tasks)?;
        Ok(task)
    })
}

pub fn set_auto_approve_all_in(repo: &Path, slug: String, enabled: bool) -> Result<Task, String> {
    crate::with_task_mutation_lock_waiting(repo, "set auto approve all", crate::TASK_MUTATION_CONTENTION_WAIT, || {
        let mut task = crate::board::read_task_checked(repo, &slug)?;
        if task.archived {
            return Err("task is archived — read-only".into());
        }
        if task.draft {
            return Err("draft tasks have no execution to override".into());
        }
        if task.engine_version < 2 {
            return Err("pre-v2 tasks have no automatic completion to override".into());
        }
        // Completion reads execution.json, not task.md. Write the task first so a failed
        // execution write leaves the engine off rather than approving while the file says off.
        let mut state = crate::execution::read_execution_state(repo, &slug)?;
        task.auto_approve_all = enabled;
        write_task_unlocked(repo, &task)?;
        if state.auto_approve_all != enabled {
            state.auto_approve_all = enabled;
            crate::execution::write_execution_state_unlocked(repo, &slug, &mut state)?;
        }
        Ok(task)
    })
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
    fn rename_retained_child_preserves_identity_and_relationships() {
        let repo = unique_temp("alinery_rename_child");
        let mut task = restore_fixture("child");
        task.parent_task = "parent".into();
        write_task(&repo, &task).unwrap();
        let name = "A child task name that is deliberately longer than forty characters";
        let saved = rename_task(&repo, "child", &format!("  {name}  ")).unwrap();
        task.name = name.into();
        assert_eq!(toml::to_string(&saved).unwrap(), toml::to_string(&task).unwrap());
        assert_eq!(toml::to_string(&read_task(&repo, "child").unwrap()).unwrap(), toml::to_string(&task).unwrap());
        for (slug, name) in [("child", " \n "), ("missing", "No"), ("../child", "No")] {
            assert!(rename_task(&repo, slug, name).is_err());
        }
        let before = fs::read(task_dir(&repo, "child").join("task.md")).unwrap();
        task.slug = "wrong".into();
        fs::write(task_dir(&repo, "child").join("task.md"), toml::to_string(&task).unwrap()).unwrap();
        assert!(rename_task(&repo, "child", "No").is_err());
        fs::write(task_dir(&repo, "child").join("task.md"), &before).unwrap();
        let outside = repo.join("outside.md");
        fs::rename(task_dir(&repo, "child").join("task.md"), &outside).unwrap();
        std::os::unix::fs::symlink(&outside, task_dir(&repo, "child").join("task.md")).unwrap();
        assert!(rename_task(&repo, "child", "No").is_err());
        assert_eq!(fs::read(&outside).unwrap(), before);
        assert!(!task_dir(&repo, "missing").exists());
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn rename_and_other_task_mutation_preserve_both_commits() {
        use std::sync::mpsc;
        use std::time::Duration;
        let repo = unique_temp("alinery_rename_mutation");
        write_task(&repo, &relationship_task("child")).unwrap();
        let root = repo.clone();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            mutate_task(&root, "child", "ordinary mutation", |task| {
                task.archived = true;
                ready_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            })
            .unwrap()
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let result = rename_task(&repo, "child", "New name");
        release_tx.send(()).unwrap();
        thread.join().unwrap();
        assert!(result.unwrap_err().contains("busy"));
        rename_task(&repo, "child", "New name").unwrap();
        let saved = read_task(&repo, "child").unwrap();
        assert!(saved.archived);
        assert_eq!(saved.name, "New name");
        let _ = fs::remove_dir_all(repo);
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
    fn related_refs_must_be_paths_on_this_machine() {
        let ok = RelatedTaskRef {
            repo_path: "/srv/other".into(),
            slug: "t".into(),
            name: String::new(),
        };
        assert!(validate_related_refs(std::slice::from_ref(&ok)).is_ok());
        for bad in ["alinery+ssh://box-a1b2c3/srv/other", "relative/repo", ""] {
            let tag = RelatedTaskRef {
                repo_path: bad.into(),
                ..ok.clone()
            };
            let error = validate_related_refs(&[tag]).unwrap_err();
            assert!(error.contains("same machine"), "{bad}: {error}");
        }
    }

    #[test]
    fn set_related_tasks_needs_a_readable_task_for_new_tags_but_keeps_stale_ones() {
        let repo = unique_temp("rel_here");
        let other = unique_temp("rel_there");
        write_task(&repo, &relationship_task("here")).unwrap();
        let mut there = relationship_task("there");
        there.name = "There".into();
        write_task(&other, &there).unwrap();
        let tag = |repo: &Path, slug: &str| RelatedTaskRef {
            repo_path: repo.to_string_lossy().into_owned(),
            slug: slug.into(),
            name: String::new(),
        };

        // The name comes from the task that is really there.
        let updated = set_related_tasks_in(&repo, "here".into(), vec![tag(&other, "there")]).unwrap();
        assert_eq!(updated.related_tasks[0].name, "There");

        // A task that is not on this machine (another machine's path, or one that does not exist) is refused.
        let error = set_related_tasks_in(&repo, "here".into(), vec![tag(&other, "there"), tag(&other, "missing")]).unwrap_err();
        assert!(error.contains("same machine"), "{error}");
        let error = set_related_tasks_in(&repo, "here".into(), vec![tag(Path::new("/definitely/not/here"), "there")]).unwrap_err();
        assert!(error.contains("same machine"), "{error}");
        assert_eq!(read_task(&repo, "here").unwrap().related_tasks.len(), 1, "a refused update changes nothing");

        // A tag the task already has outlives its repository, so it can still be removed or kept.
        fs::remove_dir_all(&other).unwrap();
        let kept = set_related_tasks_in(&repo, "here".into(), vec![tag(&other, "there")]).unwrap();
        assert_eq!(kept.related_tasks.len(), 1);
        assert!(set_related_tasks_in(&repo, "here".into(), vec![]).unwrap().related_tasks.is_empty());
        let _ = fs::remove_dir_all(repo);
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
