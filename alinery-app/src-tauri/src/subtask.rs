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
    let setup_manager_session = own_managers.iter().rev().find(|meta| meta.subtask_slug.is_empty()).cloned();
    let active_subtasks = relationships
        .active_subtasks
        .into_iter()
        .map(|child| {
            let manager_session = own_managers.iter().rev().find(|meta| meta.subtask_slug == child.slug).cloned();
            let can_recover = manager_session.as_ref().map(manager_is_usable) != Some(true);
            alinery_core::SubtaskChildState {
                child,
                manager_session,
                manager_owner_task_slug: task.slug.clone(),
                can_recover,
            }
        })
        .collect::<Vec<_>>();
    let (parent_manager_session, parent_manager_owner_task_slug) = if let Some(parent) = &relationships.parent_task {
        (
            manager_sessions(repo, &parent.slug).into_iter().rev().find(|meta| meta.subtask_slug == task.slug),
            parent.slug.clone(),
        )
    } else {
        (None, String::new())
    };

    let active_child_missing_worktree = active_subtasks.iter().any(|state| {
        let child = &state.child;
        child.draft || child.archived || !child.has_worktree || child.worktree.is_empty() || !Path::new(&child.worktree).is_dir()
    });
    let disabled_reason = if task.draft {
        "Draft tasks cannot start sub-tasks".into()
    } else if task.archived {
        "Archived tasks cannot start sub-tasks".into()
    } else if !alinery_core::task_has_existing_worktree(&task) {
        "A dedicated task worktree is required".into()
    } else if setup_manager_session.is_some() {
        "A sub-task setup manager already exists".into()
    } else if active_child_missing_worktree {
        "All active sub-tasks need dedicated worktrees before starting another".into()
    } else {
        String::new()
    };

    Ok(alinery_core::SubtaskManagerState {
        task: alinery_core::TaskSummary::from(&task),
        parent_task: relationships.parent_task,
        active_subtasks,
        setup_manager_session,
        manager_owner_task_slug: task.slug.clone(),
        parent_manager_session,
        parent_manager_owner_task_slug,
        can_start: disabled_reason.is_empty(),
        disabled_reason,
    })
}

fn create_manager_in(app_config: &Path, repo: &Path, task_slug: &str, subtask_slug: String) -> Result<SessionMeta, String> {
    let harness =
        alinery_core::resolve_harness_strict_for(app_config, repo, "omp").map_err(|_| "Sub-task managers require the OMP harness with Alinery integration".to_string())?;
    if harness.adapter != alinery_core::HarnessAdapter::Omp {
        return Err("Sub-task managers require the OMP harness with adapter = \"omp\"".into());
    }
    let core_meta = alinery_core::create_session_meta_for(
        app_config,
        repo,
        alinery_core::CreateSessionInput {
            task_slug: task_slug.to_string(),
            generic: true,
            harness: harness.key,
            model: String::new(),
            subtask_manager: true,
            subtask_slug,
            daemon_namespace: alineryd_socket_namespace().unwrap_or_default(),
            ..Default::default()
        },
    )?;
    serde_json::from_value(serde_json::to_value(core_meta).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

pub(crate) fn start_subtask_manager_in(app_config: &Path, repo: &Path, task_slug: &str) -> Result<SessionMeta, String> {
    alinery_core::with_task_mutation_lock(repo, "start sub-task manager", || {
        let state = subtask_state_in(repo, task_slug)?;
        if !state.can_start {
            return Err(state.disabled_reason);
        }
        create_manager_in(app_config, repo, task_slug, String::new())
    })
}

pub(crate) fn recover_subtask_manager_in(app_config: &Path, repo: &Path, task_slug: &str, child_slug: &str) -> Result<SessionMeta, String> {
    alinery_core::with_task_mutation_lock(repo, "recover sub-task manager", || {
        let state = subtask_state_in(repo, task_slug)?;
        let child_state = state
            .active_subtasks
            .iter()
            .find(|child| child.child.slug == child_slug)
            .ok_or_else(|| "Task has no matching active sub-task to recover".to_string())?;
        if !child_state.can_recover {
            return Err("The active sub-task already has a usable manager session".into());
        }
        create_manager_in(app_config, repo, task_slug, child_state.child.slug.clone())
    })
}

pub(crate) fn discard_subtask_with(
    repo: &Path,
    task_slug: &str,
    manager_session_id: &str,
    child_slug: Option<&str>,
    mut stop_session: impl FnMut(&str, &str) -> Result<(), String>,
) -> Result<Vec<String>, String> {
    let sessions = alinery_core::subtask_discard_sessions(repo, task_slug, manager_session_id, child_slug)?;
    for (owner_slug, session_id) in &sessions {
        stop_session(owner_slug, session_id)?;
    }
    alinery_core::discard_subtask(repo, task_slug, manager_session_id, child_slug)?;
    Ok(sessions.into_iter().map(|(_, session_id)| session_id).collect())
}

pub(crate) fn discard_subtask_in(state: &AppState, repo: &Path, task_slug: &str, manager_session_id: &str, child_slug: Option<&str>) -> Result<(), String> {
    let session_ids = discard_subtask_with(repo, task_slug, manager_session_id, child_slug, |owner_slug, session_id| {
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
pub(crate) fn start_subtask_manager(app: AppHandle, state: State<'_, AppState>, task_slug: String) -> Result<SessionMeta, String> {
    let repo = require_owned_active_repo(&state)?;
    start_subtask_manager_in(&app_config_path(&app)?, &repo, &task_slug)
}

#[tauri::command]
pub(crate) fn recover_subtask_manager(app: AppHandle, state: State<'_, AppState>, task_slug: String, child_slug: String) -> Result<SessionMeta, String> {
    let repo = require_owned_active_repo(&state)?;
    recover_subtask_manager_in(&app_config_path(&app)?, &repo, &task_slug, &child_slug)
}

#[tauri::command]
pub(crate) fn discard_subtask(app: AppHandle, state: State<'_, AppState>, task_slug: String, manager_session_id: String, child_slug: Option<String>) -> Result<(), String> {
    let repo = require_owned_active_repo(&state)?;
    publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PreArchive);
    discard_subtask_in(&state, &repo, &task_slug, &manager_session_id, child_slug.as_deref())
}
