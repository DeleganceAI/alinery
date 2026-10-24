use crate::*;

pub(crate) use alinery_core::subtask::subtask_manager_request as subtask_manager_request_in;
pub(crate) use alinery_core::subtask::subtask_manager_state as subtask_state_in;

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
    let target = active_owned_ref(&state)?;
    let app_config = app_config_path(&app)?;
    // Creating the manager session waits on the daemon. Keep that off the main thread.
    tauri::async_runtime::spawn_blocking(move || subtask_manager_session(&app.state::<AppState>(), &app_config, target, task_slug, false))
        .await
        .map_err(|error| format!("start subtask manager task: {error}"))?
}

/// The active repo, ownership-checked when it is a local one.
fn active_owned_ref(state: &AppState) -> Result<RepoRef, String> {
    Ok(match active_repo_ref()? {
        RepoRef::Local(_) => RepoRef::Local(require_owned_active_repo(state)?),
        remote => remote,
    })
}

/// Ask the repo's daemon for the manager session. A remote repo's request is built on its host,
/// where the relationships it reads live, and sent to its one forwarded daemon.
fn subtask_manager_session(
    state: &AppState,
    app_config: &Path,
    target: RepoRef,
    task_slug: String,
    recover: bool,
) -> Result<alinery_core::task_creation::CreateExecutionSessionReply, String> {
    match &target {
        RepoRef::Local(repo) => {
            let request = subtask_manager_request_in(repo, task_slug, recover)?;
            task_daemon_for(repo, &request.task_slug, app_config)?.create_execution_session(&request)
        }
        RepoRef::Remote { host_id, path } => {
            let request: alinery_core::task_creation::CreateExecutionSessionRequest = remote_call(
                state,
                host_id,
                RepoOp::SubtaskManagerRequest {
                    repo: path.clone().into(),
                    slug: task_slug,
                    recover,
                },
            )?;
            repo_client(state, &target)?.create_execution_session(&request)
        }
    }
}

#[tauri::command]
pub(crate) async fn recover_subtask_manager(
    app: AppHandle,
    state: State<'_, AppState>,
    task_slug: String,
) -> Result<alinery_core::task_creation::CreateExecutionSessionReply, String> {
    let target = active_owned_ref(&state)?;
    let app_config = app_config_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || subtask_manager_session(&app.state::<AppState>(), &app_config, target, task_slug, true))
        .await
        .map_err(|error| format!("recover subtask manager task: {error}"))?
}

#[tauri::command]
pub(crate) fn discard_subtask(app: AppHandle, state: State<'_, AppState>, task_slug: String, manager_session_id: String) -> Result<(), String> {
    match require_active_target(&state)? {
        ActiveRepo::Local(repo) => {
            publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PreArchive);
            discard_subtask_in(&state, &repo, &task_slug, &manager_session_id)
        }
        ActiveRepo::Remote { host_id, path } => {
            publish_remote_backup(&app, &host_id, &path, alinery_core::BackupTrigger::PreArchive);
            discard_remote_subtask(&state, &host_id, path, task_slug, manager_session_id)
        }
    }
}

/// Stop every live session the sub-task owns through the repo's daemon, then discard it on the
/// host. The list comes from the host's own files, so it is the same set a local discard stops.
pub(crate) fn discard_remote_subtask(state: &AppState, host_id: &str, path: String, task_slug: String, manager_session_id: String) -> Result<(), String> {
    let target = RepoRef::Remote {
        host_id: host_id.to_string(),
        path: path.clone(),
    };
    let sessions: Vec<(String, String)> = remote_call(
        state,
        host_id,
        RepoOp::SubtaskDiscardSessions {
            repo: path.clone().into(),
            slug: task_slug.clone(),
            manager_session_id: manager_session_id.clone(),
        },
    )?;
    let client = repo_client(state, &target)?;
    for (_, session_id) in &sessions {
        if client.session_status_observed(session_id).map(|status| status.is_some()).unwrap_or(false) {
            client.kill_session(session_id)?;
        }
    }
    remote_call::<()>(
        state,
        host_id,
        RepoOp::DiscardSubtask {
            repo: path.into(),
            slug: task_slug,
            manager_session_id,
        },
    )?;
    for (_, session_id) in sessions {
        state.clear_session_route(&session_id);
    }
    Ok(())
}
