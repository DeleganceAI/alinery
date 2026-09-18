use crate::*;

fn manager_sessions(repo: &Path, owner_slug: &str) -> Vec<alinery_core::SessionMeta> {
    let mut sessions = fs::read_dir(sessions_dir(repo, owner_slug))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| alinery_core::read_session_meta_full(&entry.path()))
        .filter(|meta| meta.subtask_manager && !meta.archived)
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| left.created.cmp(&right.created).then_with(|| left.id.cmp(&right.id)));
    sessions
}

fn manager_is_usable(meta: &alinery_core::SessionMeta) -> bool {
    !meta.archived && (meta.ended_at.is_none() || !meta.harness_resume_token.is_empty())
}

pub(crate) fn subtask_state_in(repo: &Path, task_slug: &str) -> Result<alinery_core::SubtaskManagerState, String> {
    let task = alinery_core::read_task(repo, task_slug).ok_or_else(|| format!("no such task: {task_slug}"))?;
    let relationships = alinery_core::read_task_relationships(repo, task_slug)?;
    let own_managers = manager_sessions(repo, task_slug);
    let manager_session = if let Some(child) = &relationships.active_subtask {
        own_managers.iter().rev().find(|meta| meta.subtask_slug == child.slug).cloned()
    } else {
        own_managers.iter().rev().find(|meta| meta.subtask_slug.is_empty()).cloned()
    };
    let (parent_manager_session, parent_manager_owner_task_slug) = if let Some(parent) = &relationships.parent_task {
        (
            manager_sessions(repo, &parent.slug).into_iter().rev().find(|meta| meta.subtask_slug == task.slug),
            parent.slug.clone(),
        )
    } else {
        (None, String::new())
    };

    let historical = task.engine_version < 2;
    let disabled_reason = if historical {
        "Pre-v2 task data is read-only".into()
    } else if task.draft {
        "Draft tasks cannot start sub-tasks".into()
    } else if task.archived {
        "Archived tasks cannot start sub-tasks".into()
    } else if !task.has_worktree || task.worktree.is_empty() || !Path::new(&task.worktree).is_dir() {
        "A dedicated task worktree is required".into()
    } else if relationships.active_subtask.is_some() {
        "Finish the active sub-task before starting another".into()
    } else if own_managers.iter().any(|meta| meta.subtask_slug.is_empty()) {
        "A sub-task setup manager already exists".into()
    } else {
        String::new()
    };
    let can_recover = relationships.active_subtask.is_some() && manager_session.as_ref().map(manager_is_usable) != Some(true);

    Ok(alinery_core::SubtaskManagerState {
        task: alinery_core::TaskSummary::from(&task),
        parent_task: relationships.parent_task,
        active_subtask: relationships.active_subtask,
        manager_session,
        manager_owner_task_slug: task.slug.clone(),
        parent_manager_session,
        parent_manager_owner_task_slug,
        can_start: disabled_reason.is_empty(),
        can_recover,
        disabled_reason,
    })
}

fn create_manager_in(daemon: &DaemonClient, task_slug: String, recover: bool) -> Result<alinery_core::task_creation::CreateExecutionSessionReply, String> {
    daemon.create_execution_session(&alinery_core::task_creation::CreateExecutionSessionRequest {
        task_slug,
        target: alinery_core::task_creation::ExecutionSessionTarget::SubtaskManager {
            subtask_slug: None, recover, harness: "omp".into(), model: None,
        },
        launch_override: None, prompt_extra: None, start: true,
    })
}

pub(crate) fn discard_subtask_with(
    repo: &Path,
    task_slug: &str,
    manager_session_id: &str,
    mut stop_session: impl FnMut(&str, &str) -> Result<(), String>,
) -> Result<Vec<String>, String> {
    let sessions = alinery_core::subtask_discard_sessions(repo, task_slug, manager_session_id)?;
    for (owner_slug, session_id) in &sessions {
        stop_session(owner_slug, session_id)?;
    }
    alinery_core::discard_subtask(repo, task_slug, manager_session_id)?;
    Ok(sessions.into_iter().map(|(_, session_id)| session_id).collect())
}

pub(crate) fn discard_subtask_in(state: &AppState, repo: &Path, task_slug: &str, manager_session_id: &str) -> Result<(), String> {
    let session_ids = discard_subtask_with(repo, task_slug, manager_session_id, |owner_slug, session_id| {
        let owned = with_session_client(state, repo, owner_slug, session_id, |daemon| daemon.session_status_observed(session_id))
            .map(|status| status.is_some())
            .unwrap_or(false);
        if owned {
            with_session_client(state, repo, owner_slug, session_id, |daemon| daemon.kill_session(session_id))?;
        }
        Ok(())
    })?;
    for session_id in session_ids {
        state.clear_session_route(&session_id);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn subtask_state(state: State<'_, AppState>, task_slug: String) -> Result<alinery_core::SubtaskManagerState, String> {
    let repo = require_owned_active_repo(&state)?;
    subtask_state_in(&repo, &task_slug)
}

#[tauri::command]
pub(crate) fn start_subtask_manager(app: AppHandle, state: State<'_, AppState>, task_slug: String) -> Result<alinery_core::task_creation::CreateExecutionSessionReply, String> {
    let repo = require_owned_active_repo(&state)?;
    create_manager_in(&task_daemon_for(&repo, &task_slug, &app_config_path(&app)?)?, task_slug, false)
}

#[tauri::command]
pub(crate) fn recover_subtask_manager(app: AppHandle, state: State<'_, AppState>, task_slug: String) -> Result<alinery_core::task_creation::CreateExecutionSessionReply, String> {
    let repo = require_owned_active_repo(&state)?;
    create_manager_in(&task_daemon_for(&repo, &task_slug, &app_config_path(&app)?)?, task_slug, true)
}

#[tauri::command]
pub(crate) fn discard_subtask(app: AppHandle, state: State<'_, AppState>, task_slug: String, manager_session_id: String) -> Result<(), String> {
    let repo = require_owned_active_repo(&state)?;
    publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PreArchive);
    discard_subtask_in(&state, &repo, &task_slug, &manager_session_id)
}
