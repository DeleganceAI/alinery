//! Reads of one task's files that more than one caller needs: `task.md`, session metas, the saved
//! execution and the artifact list. The board's derived rows (current step, activity, display names)
//! come from the daemon's store, not from here.

use crate::execution::{read_execution_state, read_task_playbook};
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

pub fn load_session_meta(repo: &Path, task_slug: &str, id: &str) -> Result<SessionMeta, String> {
    let path = crate::session_meta_path(repo, task_slug, id);
    let raw = fs::read_to_string(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    serde_json::from_str(&raw).map_err(|error| format!("parse {}: {error}", path.display()))
}

/// The task's retained execution state and playbook, as stored on disk.
pub fn saved_task_execution(repo: &Path, task_slug: &str) -> Result<crate::task_creation::TaskExecutionReply, String> {
    let state = read_execution_state(repo, task_slug)?;
    let definition = read_task_playbook(repo, task_slug, &state)?;
    Ok(crate::task_creation::TaskExecutionReply { state, definition })
}

pub fn artifacts_with_metadata(repo: &Path, task_slug: &str) -> Result<Vec<crate::ArtifactListItem>, String> {
    let task = read_task_checked(repo, task_slug)?;
    if task.engine_version >= 2 {
        let execution = saved_task_execution(repo, task_slug)?;
        crate::list_artifacts_with_execution_metadata(repo, task_slug, &execution.state)
    } else {
        crate::list_artifacts_with_metadata_for(repo, task_slug)
    }
}

/// Whether the task's recorded worktree still exists on disk.
pub fn worktree_exists(repo: &Path, task_slug: &str) -> Result<bool, String> {
    let task = read_task_checked(repo, task_slug)?;
    Ok(!task.worktree.is_empty() && Path::new(&task.worktree).exists())
}

/// True when the session's phase artifact exists and is non-empty. A content feature, not a completion signal.
pub fn session_artifact_ready(repo: &Path, task_slug: &str, id: &str) -> bool {
    let Some(meta) = std::fs::read_to_string(crate::session_meta_path(repo, task_slug, id))
        .ok()
        .and_then(|text| serde_json::from_str::<SessionMeta>(&text).ok())
    else {
        return false;
    };
    crate::artifact_file_path(repo, task_slug, &meta.artifact)
        .ok()
        .and_then(|path| std::fs::metadata(path).ok())
        .is_some_and(|metadata| metadata.is_file() && metadata.len() > 0)
}
