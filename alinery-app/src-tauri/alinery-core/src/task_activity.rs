//! What a task is doing right now, for the board: the newest actionable session's status and the
//! session to open. File reads only, plus the daemon's live session states passed in, so a remote
//! host computes it from its own files while the app supplies the states it observed.
use crate::daemon_client::DaemonSessionStatus;
use crate::{SessionMeta, Task};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskActivitySession {
    pub id: String,
    pub worktree: String,
    pub phase: String,
    pub harness: String,
    pub model: String,
    pub playbook: String,
    pub generic: bool,
    pub step_title: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskActivityStatus {
    Running,
    WaitingForInput,
    WaitingForApproval,
    Failed,
    Completed,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskActivitySummary {
    pub status: Option<TaskActivityStatus>,
    pub active_session: Option<TaskActivitySession>,
}

pub fn task_activity_key(repo_path: &str, slug: &str) -> String {
    format!("{repo_path}:{slug}")
}

pub fn task_activity_session(repo: &Path, task: &Task, session: &SessionMeta) -> TaskActivitySession {
    let playbook = task
        .playbook_ref
        .as_ref()
        .map(|reference| reference.key.clone())
        .unwrap_or_else(|| session.playbook.clone());
    let step_title = if session.generic {
        "Generic".to_string()
    } else {
        match crate::board::retained_task_definition(repo, task) {
            Ok(Some(definition)) => definition
                .step
                .iter()
                .find(|step| step.key == session.phase)
                .map(|step| step.title.clone())
                .unwrap_or_else(|| session.phase.clone()),
            Ok(None) => session.phase.clone(),
            Err(error) => format!("Execution unavailable: {error}"),
        }
    };
    TaskActivitySession {
        id: session.id.clone(),
        worktree: session.worktree.clone(),
        phase: session.phase.clone(),
        harness: session.harness.clone(),
        model: session.model.clone(),
        playbook,
        generic: session.generic,
        step_title,
    }
}

#[derive(Clone, Copy, Default)]
pub struct TaskSessionActivityProjection {
    pub status: Option<(u8, TaskActivityStatus)>,
    pub active_tier: Option<u8>,
}

pub fn has_unacknowledged_terminal_failure(session: &SessionMeta) -> bool {
    session.exit_code.is_some_and(|code| code != 0)
        && session
            .ended_at
            .is_none_or(|ended_at| session.exit_notification_read_at.is_none_or(|read_at| ended_at > read_at))
}

pub fn project_task_session_activity(task: &Task, session: &SessionMeta, daemon_state: Option<&crate::SessionState>) -> TaskSessionActivityProjection {
    let durable_status = if has_unacknowledged_terminal_failure(session) {
        Some((2, TaskActivityStatus::Failed))
    } else if crate::board::is_primary_playbook_session(task, session)
        && session
            .semantic
            .phase_completed_at
            .is_some_and(|completed_at| session.notification_read_at.is_none_or(|read_at| completed_at > read_at))
    {
        Some((2, TaskActivityStatus::Completed))
    } else {
        None
    };
    let Some(state) = daemon_state else {
        return TaskSessionActivityProjection {
            status: durable_status,
            active_tier: None,
        };
    };
    let supported = !matches!(state.adapter, crate::HarnessAdapter::Unsupported);
    if supported {
        if let crate::PlaybookState::Failed { reason } = &state.playbook {
            let acknowledged_terminal_failure =
                matches!(state.process, crate::ProcessState::Exited { .. }) && session.exit_code.is_some_and(|code| code != 0) && !has_unacknowledged_terminal_failure(session);
            return TaskSessionActivityProjection {
                status: if reason == "StaleSource" || acknowledged_terminal_failure {
                    durable_status
                } else {
                    Some((2, TaskActivityStatus::Failed))
                },
                active_tier: None,
            };
        }
    }
    let process_live = matches!(state.process, crate::ProcessState::Starting | crate::ProcessState::Alive);
    let waiting_for_input = supported && process_live && matches!(state.agent, crate::AgentState::WaitingForInput { .. });
    let waiting_for_approval = supported && process_live && matches!(state.agent, crate::AgentState::WaitingForApproval { .. });
    let busy_or_starting = matches!(state.process, crate::ProcessState::Starting) || (supported && process_live && matches!(state.agent, crate::AgentState::Busy));
    let status = if waiting_for_input {
        Some((0, TaskActivityStatus::WaitingForInput))
    } else if waiting_for_approval {
        Some((0, TaskActivityStatus::WaitingForApproval))
    } else if busy_or_starting {
        Some((1, TaskActivityStatus::Running))
    } else {
        durable_status
    };
    let active_tier = if busy_or_starting {
        Some(0)
    } else if waiting_for_input || waiting_for_approval {
        Some(1)
    } else {
        None
    };
    TaskSessionActivityProjection { status, active_tier }
}

pub fn task_has_actionable_session(task: &Task, sessions: &[SessionMeta], statuses_by_id: &HashMap<&str, &crate::SessionState>) -> bool {
    sessions.iter().filter(|session| !session.archived).any(|session| {
        project_task_session_activity(task, session, statuses_by_id.get(session.id.as_str()).copied())
            .active_tier
            .is_some()
    })
}

pub fn resolve_task_activity_for_repo(repo: &Path, repo_path: &str, slugs: &[String], statuses: &[DaemonSessionStatus]) -> HashMap<String, TaskActivitySummary> {
    let statuses_by_id = statuses.iter().map(|status| (status.id.as_str(), &status.state)).collect::<HashMap<_, _>>();
    let mut activity = slugs
        .iter()
        .map(|slug| (task_activity_key(repo_path, slug), TaskActivitySummary::default()))
        .collect::<HashMap<_, _>>();

    for slug in slugs {
        let Ok(task) = crate::board::read_task_checked(repo, slug) else {
            continue;
        };
        let Ok(mut sessions) = crate::board::list_task_sessions(repo, slug) else {
            continue;
        };
        let key = task_activity_key(repo_path, slug);
        let mut activity_task = task;
        let mut visited = HashSet::from([activity_task.slug.clone()]);
        loop {
            if activity_task.active_subtask.is_empty() || task_has_actionable_session(&activity_task, &sessions, &statuses_by_id) {
                break;
            }
            let child_slug = activity_task.active_subtask.clone();
            if !visited.insert(child_slug.clone()) {
                break;
            }
            let Ok(child) = crate::board::read_task_checked(repo, &child_slug) else {
                break;
            };
            let Ok(child_sessions) = crate::board::list_task_sessions(repo, &child.slug) else {
                break;
            };
            activity_task = child;
            sessions = child_sessions;
        }
        let mut summary = TaskActivitySummary::default();
        let mut status_choice: Option<(u8, u64, String, TaskActivityStatus)> = None;
        let mut active_choice: Option<(u8, u64, String, &SessionMeta)> = None;

        for session in sessions.iter().filter(|session| !session.archived) {
            let projection = project_task_session_activity(&activity_task, session, statuses_by_id.get(session.id.as_str()).copied());

            if let Some((tier, status)) = projection.status {
                let replace = status_choice.as_ref().is_none_or(|(current_tier, current_created, current_id, _)| {
                    tier < *current_tier || (tier == *current_tier && (session.created > *current_created || (session.created == *current_created && session.id > *current_id)))
                });
                if replace {
                    status_choice = Some((tier, session.created, session.id.clone(), status));
                }
            }

            let Some(active_tier) = projection.active_tier else {
                continue;
            };
            let replace = active_choice.as_ref().is_none_or(|(current_tier, current_created, current_id, _)| {
                active_tier < *current_tier
                    || (active_tier == *current_tier && (session.created > *current_created || (session.created == *current_created && session.id > *current_id)))
            });
            if replace {
                active_choice = Some((active_tier, session.created, session.id.clone(), session));
            }
        }
        summary.status = status_choice.map(|(_, _, _, status)| status);
        summary.active_session = active_choice.map(|(_, _, _, session)| task_activity_session(repo, &activity_task, session));
        activity.insert(key, summary);
    }
    activity
}
