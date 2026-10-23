use crate::*;

pub(crate) use alinery_core::subtask::subtask_manager_state as subtask_state_in;

pub(crate) fn subtask_manager_request_in(repo: &Path, task_slug: String, recover: bool) -> Result<alinery_core::task_creation::CreateExecutionSessionRequest, String> {
    let subtask_slug = if recover {
        Some(
            alinery_core::read_task_relationships(repo, &task_slug)?
                .active_subtask
                .ok_or("task has no active sub-task to recover")?
                .slug,
        )
    } else {
        None
    };
    Ok(alinery_core::task_creation::CreateExecutionSessionRequest {
        task_slug,
        target: alinery_core::task_creation::ExecutionSessionTarget::SubtaskManager {
            subtask_slug,
            recover,
            harness: "omp".into(),
            model: None,
        },
        launch_override: None,
        prompt_extra: None,
        handoff_artifact: None,
        start: true,
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
pub(crate) fn subtask_state(app: AppHandle, state: State<'_, AppState>, task_slug: String, repo_path: Option<String>) -> Result<alinery_core::SubtaskManagerState, String> {
    match target_or_active_ref(&app, repo_path)? {
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::SubtaskState {
                repo: path.into(),
                slug: task_slug,
            },
        ),
        RepoRef::Local(repo) => {
            require_repo_owned(&state, &repo)?;
            subtask_state_in(&repo, &task_slug)
        }
    }
}

#[tauri::command]
pub(crate) async fn start_subtask_manager(
    app: AppHandle,
    state: State<'_, AppState>,
    task_slug: String,
) -> Result<alinery_core::task_creation::CreateExecutionSessionReply, String> {
    let repo = require_owned_active_repo(&state)?;
    let app_config = app_config_path(&app)?;
    // Creating the manager session waits on the daemon. Keep that off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let request = subtask_manager_request_in(&repo, task_slug, false)?;
        task_daemon_for(&repo, &request.task_slug, &app_config)?.create_execution_session(&request)
    })
    .await
    .map_err(|error| format!("start subtask manager task: {error}"))?
}

#[tauri::command]
pub(crate) async fn recover_subtask_manager(
    app: AppHandle,
    state: State<'_, AppState>,
    task_slug: String,
) -> Result<alinery_core::task_creation::CreateExecutionSessionReply, String> {
    let repo = require_owned_active_repo(&state)?;
    let app_config = app_config_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let request = subtask_manager_request_in(&repo, task_slug, true)?;
        task_daemon_for(&repo, &request.task_slug, &app_config)?.create_execution_session(&request)
    })
    .await
    .map_err(|error| format!("recover subtask manager task: {error}"))?
}

#[tauri::command]
pub(crate) fn discard_subtask(app: AppHandle, state: State<'_, AppState>, task_slug: String, manager_session_id: String) -> Result<(), String> {
    let repo = require_owned_active_repo(&state)?;
    publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PreArchive);
    discard_subtask_in(&state, &repo, &task_slug, &manager_session_id)
}
