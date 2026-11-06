//! Reads of one task's files that more than one caller needs: `task.md`, session metas, the saved
//! execution and the artifact list. The board's derived rows (current step, activity, display names)
//! come from the daemon's store, not from here.

use crate::{sessions_dir, task_dir, tasks_dir, SessionMeta, Task};
use std::fs;
use std::path::{Path, PathBuf};

/// `task.md` parsed, with an error that names the file when it is missing or malformed.
pub fn read_task_checked(repo: &Path, slug: &str) -> Result<Task, String> {
    let path = task_dir(repo, slug).join("task.md");
    let text = fs::read_to_string(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    toml::from_str(&text).map_err(|error| format!("parse {}: {error}", path.display()))
}

/// Every task under `.alinery/tasks`, oldest first. A malformed `task.md` is an error, not a gap.
pub fn list_tasks_checked(repo: &Path) -> Result<Vec<Task>, String> {
    let dir = tasks_dir(repo);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut tasks = vec![];
    for entry in fs::read_dir(&dir).map_err(|error| format!("read {}: {error}", dir.display()))? {
        let entry = entry.map_err(|error| format!("read {}: {error}", dir.display()))?;
        if !entry.path().join("task.md").exists() {
            continue;
        }
        if let Some(slug) = entry.file_name().to_str() {
            tasks.push(read_task_checked(repo, slug).map_err(|error| format!("task {}: {error}", entry.path().display()))?);
        }
    }
    tasks.sort_by_key(|task| task.created);
    Ok(tasks)
}

pub fn list_session_metas_in_dir(dir: PathBuf) -> Result<Vec<SessionMeta>, String> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    let entries = fs::read_dir(&dir).map_err(|error| format!("read {}: {error}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("read {}: {error}", dir.display()))?;
        let path = entry.path();
        if !path.to_string_lossy().ends_with(".meta.json") {
            continue;
        }
        let text = fs::read_to_string(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
        out.push(serde_json::from_str::<SessionMeta>(&text).map_err(|error| format!("parse {}: {error}", path.display()))?);
    }
    // created is seconds-granularity, so two same-second sessions would tie and fall
    // to arbitrary read_dir order. Break ties on id (= "s{nanos}", lexicographically
    // chronological) so "latest session" — hence the DERIVED current_phase / kanban
    // column — is deterministic even for rapid create-then-advance.
    out.sort_by(|a, b| a.created.cmp(&b.created).then_with(|| a.id.cmp(&b.id)));
    Ok(out)
}

pub fn list_task_sessions(repo: &Path, task_slug: &str) -> Result<Vec<SessionMeta>, String> {
    list_session_metas_in_dir(sessions_dir(repo, task_slug))
}

/// Whether the task's recorded worktree still exists on disk.
pub fn worktree_exists(repo: &Path, task_slug: &str) -> Result<bool, String> {
    let task = read_task_checked(repo, task_slug)?;
    Ok(!task.worktree.is_empty() && Path::new(&task.worktree).exists())
}
