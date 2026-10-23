//! The board projection of a repo's tasks: each task with its playbook, session count, current
//! step and last-activity time. It lives in core so the same code answers an in-process board
//! read for a local repo and a `repo_service` call on a remote host.

use crate::execution::{read_execution_state, read_task_playbook};
use crate::{artifacts_dir, sessions_dir, task_dir, tasks_dir, visible_artifact_names, SessionMeta, Task};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BoardPlaybookStep {
    pub key: String,
    pub title: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BoardTask {
    #[serde(flatten)]
    pub task: Task,
    pub repo_path: String,
    pub session_count: usize,
    pub playbook_title: String,
    pub playbook_steps: Vec<BoardPlaybookStep>,
    pub updated: u64,
    pub current_phase: String,
    pub current_step_title: String,
    pub latest_session_title: String,
    pub latest_session_column_key: String,
    pub current_column_key: String,
    pub current_column_title: String,
}

pub fn file_mtime_secs(path: impl AsRef<Path>) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
}

/// `task.md` parsed, with an error that names the file when it is missing or malformed.
pub fn read_task_checked(repo: &Path, slug: &str) -> Result<Task, String> {
    let path = task_dir(repo, slug).join("task.md");
    let text = fs::read_to_string(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    toml::from_str(&text).map_err(|error| format!("parse {}: {error}", path.display()))
}

/// `Ok(None)` when `task.md` is missing (deleted, or never existed); `Err` when it exists but
/// will not parse, which is a real fault and not "no task".
pub fn read_task_opt(repo: &Path, slug: &str) -> Result<Option<Task>, String> {
    let path = task_dir(repo, slug).join("task.md");
    match fs::read_to_string(&path) {
        Ok(text) => toml::from_str(&text).map(Some).map_err(|error| format!("parse {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("read {}: {error}", path.display())),
    }
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

pub fn retained_task_definition(repo: &Path, task: &Task) -> Result<Option<crate::playbook::NormalizedPlaybook>, String> {
    if task.draft || task.engine_version < 2 {
        return Ok(None);
    }
    // Display uses the task-owned snapshot, never a live owner or the mutable library.
    // The shared reader checks both the stored state and the retained source's integrity.
    let state = read_execution_state(repo, &task.slug).map_err(|error| format!("task {}: {error}", task_dir(repo, &task.slug).display()))?;
    read_task_playbook(repo, &task.slug, &state)
        .map(Some)
        .map_err(|error| format!("task {}: {error}", task_dir(repo, &task.slug).display()))
}

pub fn is_primary_playbook_session(task: &Task, session: &SessionMeta) -> bool {
    !session.generic
        && if task.engine_version >= 2 {
            !session.execution_id.is_empty()
        } else {
            session.playbook == task.playbook
        }
}

pub fn task_updated_at(repo: &Path, task: &Task, sessions: &[SessionMeta]) -> Result<u64, String> {
    let mut updated = task.created;
    if let Some(ts) = file_mtime_secs(task_dir(repo, &task.slug).join("task.md")) {
        updated = updated.max(ts);
    }
    for name in visible_artifact_names(repo, &task.slug)? {
        if name.ends_with(".review-pending.json") {
            continue;
        }
        if let Some(ts) = file_mtime_secs(artifacts_dir(repo, &task.slug).join(name)) {
            updated = updated.max(ts);
        }
    }
    // Session files are projections: polling, replay, and acknowledgments can rewrite
    // them without work happening. Only durable semantic timestamps count as activity.
    for session in sessions {
        updated = updated.max(session.created);
        for ts in [
            session.started_at,
            session.ended_at,
            session.status_changed_at,
            session.semantic.phase_completed_at,
            session.activity_at,
        ]
        .into_iter()
        .flatten()
        {
            updated = updated.max(ts);
        }
    }
    Ok(updated)
}

pub fn board_task(repo: &Path, repo_path: &str, task: Task) -> Result<BoardTask, String> {
    let definition = retained_task_definition(repo, &task)?;
    let sessions = list_task_sessions(repo, &task.slug)?;
    let live: Vec<&SessionMeta> = sessions.iter().filter(|session| !session.archived).collect();
    let current_phase = live
        .iter()
        .rev()
        .find(|session| is_primary_playbook_session(&task, session))
        .map(|session| session.phase.clone())
        .unwrap_or_default();
    let title = |phase: &str| {
        definition
            .as_ref()
            .and_then(|definition| definition.step.iter().find(|step| step.key == phase))
            .map(|step| step.title.clone())
            .unwrap_or_else(|| phase.to_string())
    };
    let current_step_title = title(&current_phase);
    let latest_session_title = if task.draft {
        "Draft".into()
    } else {
        live.last()
            .map(|session| if session.generic { "Generic".into() } else { title(&session.phase) })
            .unwrap_or_else(|| "No sessions".into())
    };
    let updated = task_updated_at(repo, &task, &sessions)?;
    let playbook_title = definition.as_ref().map(|definition| definition.title.clone()).unwrap_or_else(|| task.playbook.clone());
    let playbook_steps = definition
        .into_iter()
        .flat_map(|definition| definition.step)
        .map(|step| BoardPlaybookStep { key: step.key, title: step.title })
        .collect();
    Ok(BoardTask {
        task,
        repo_path: repo_path.into(),
        session_count: live.len(),
        playbook_title,
        playbook_steps,
        updated,
        current_phase,
        current_step_title,
        latest_session_title,
        latest_session_column_key: String::new(),
        current_column_key: String::new(),
        current_column_title: String::new(),
    })
}

pub fn board_tasks_from_loaded(repo: &Path, repo_path: &str, tasks: Vec<Task>) -> Result<Vec<BoardTask>, String> {
    crate::validate_task_relationship_fields(
        tasks
            .iter()
            .map(|task| (task.slug.as_str(), task.parent_task.as_str(), task.active_subtask.as_str(), task.archived)),
    )?;
    tasks.into_iter().map(|task| board_task(repo, repo_path, task)).collect()
}

/// The whole board for one repo, `repo_path` stamped on every row.
pub fn board_tasks(repo: &Path, repo_path: &str) -> Result<Vec<BoardTask>, String> {
    board_tasks_from_loaded(repo, repo_path, list_tasks_checked(repo)?)
}
