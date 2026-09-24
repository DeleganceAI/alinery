//! daemon: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

pub(crate) static EFFECTIVE_APP_IDENTIFIER: OnceLock<String> = OnceLock::new();

pub(crate) fn task_daemon_for(repo: &Path, task_slug: &str, app_config: &Path) -> Result<DaemonClient, String> {
    // Live execution queries and mutations must reach the durable owning lane.
    let execution = alinery_core::execution::read_execution_state(repo, task_slug)?;
    let socket = alinery_core::alineryd_socket_path(repo, (!execution.owning_lane.is_empty()).then_some(execution.owning_lane.as_str()));
    daemon_client::connect_compatible(socket, app_config)
        .map(|(client, _)| client)
        .map_err(|error| error.to_string())
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum ExecutionAvailability {
    Available,
    Offline { detail: String },
    ForeignOwner { detail: String },
    Incompatible { detail: String },
    Unavailable { detail: String },
}

#[derive(Debug, Serialize)]
pub(crate) struct AppTaskExecutionReply {
    #[serde(flatten)]
    pub execution: alinery_core::task_creation::TaskExecutionReply,
    pub live: ExecutionAvailability,
}

pub(crate) fn saved_task_execution_for(repo: &Path, task_slug: &str) -> Result<alinery_core::task_creation::TaskExecutionReply, String> {
    let state = alinery_core::execution::read_execution_state(repo, task_slug)?;
    let definition = alinery_core::execution::read_task_playbook(repo, task_slug, &state)?;
    Ok(alinery_core::task_creation::TaskExecutionReply { state, definition })
}

pub(crate) fn task_execution_for(repo: &Path, task_slug: &str, app_config: &Path) -> Result<AppTaskExecutionReply, String> {
    // Validate durable data before observing its owner. Browsing never starts or adopts a lane.
    let saved = saved_task_execution_for(repo, task_slug)?;
    let lane = saved.state.owning_lane.as_str();
    let socket = alinery_core::alineryd_socket_path(repo, (!lane.is_empty()).then_some(lane));
    let live = match daemon_client::connect_compatible(socket, app_config) {
        Ok((client, _)) => match client.get_task_execution(&alinery_core::task_creation::GetTaskExecutionRequest { task_slug: task_slug.into() }) {
            Ok(execution) => {
                return Ok(AppTaskExecutionReply {
                    execution,
                    live: ExecutionAvailability::Available,
                })
            }
            Err(detail) => ExecutionAvailability::Unavailable { detail },
        },
        Err(error) => {
            let detail = error.to_string();
            match error {
                daemon_client::DaemonClientError::Unreachable { .. } => ExecutionAvailability::Offline { detail },
                daemon_client::DaemonClientError::AppConfigMismatch { .. } => ExecutionAvailability::ForeignOwner { detail },
                daemon_client::DaemonClientError::ProtocolMismatch { .. } => ExecutionAvailability::Incompatible { detail },
                daemon_client::DaemonClientError::Malformed(_) | daemon_client::DaemonClientError::Launch(_) => ExecutionAvailability::Unavailable { detail },
            }
        }
    };
    Ok(AppTaskExecutionReply { execution: saved, live })
}

#[tauri::command]
pub(crate) fn get_task_execution(app: AppHandle, repo_path: Option<String>, task_slug: String) -> Result<AppTaskExecutionReply, String> {
    let repo = match repo_path {
        Some(path) => target_repo_for_app(&app, &path)?,
        None => active_repo()?,
    };
    task_execution_for(&repo, &task_slug, &app_config_path(&app)?)
}

#[tauri::command]
pub(crate) fn allow_execution_completion(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: Option<String>,
    task_slug: String,
    execution_id: String,
    session_id: String,
) -> Result<(), String> {
    let repo = match repo_path {
        Some(path) => target_repo_for_app(&app, &path)?,
        None => require_owned_active_repo(&state)?,
    };
    require_repo_owned(&state, &repo)?;
    let daemon = task_daemon_for(&repo, &task_slug, &app_config_path(&app)?)?;
    daemon_client::UiControlConnection::connect(&daemon)?.allow_execution_completion(&alinery_core::task_creation::AllowExecutionCompletionRequest {
        task_slug,
        execution_id,
        session_id,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn open_daemon_session(
    client: &DaemonClient,
    id: &str,
    cwd: &str,
    task_slug: Option<&str>,
    phase: Option<&str>,
    model: Option<&str>,
    attach_id: u64,
    stream_token: u64,
    intent: &str,
    resume_token: Option<&str>,
    cols: Option<u16>,
    rows: Option<u16>,
    on_bytes: Channel<InvokeResponseBody>,
    app: AppHandle,
) -> Result<(), String> {
    let mut stream = client.send(&daemon_client::open_request(&daemon_client::OpenRequest {
        intent,
        id,
        cwd,
        task_slug,
        phase,
        model,
        attach_id,
        resume_token,
        cols,
        rows,
    }))?;
    // A wedged daemon must not read as a dead one: the handshake shares the control budget.
    let line = read_socket_line(&mut stream).map_err(|error| match error {
        SocketReadError::Closed => "daemon closed".to_string(),
        SocketReadError::TimedOut => format!("daemon not responding after {}", format_daemon_timeout(DAEMON_CONTROL_TIMEOUT)),
    })?;
    let response: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
    if let Some(error) = daemon_client::reply_error(&response) {
        return Err(error.to_string());
    }
    let event_id = id.to_string();
    std::thread::spawn(move || {
        pump_session_stream(stream, |bytes| on_bytes.send(InvokeResponseBody::Raw(frame_session_channel_bytes(bytes))).is_ok());
        let _ = app.emit("session_stream_closed", json!({ "id": event_id, "attach_id": attach_id, "stream_token": stream_token }));
    });
    Ok(())
}

pub(crate) fn passive_session_statuses(repo: &Path, expected_app_config_identity: &str) -> Result<Vec<DaemonSessionStatus>, String> {
    let client = DaemonClient::connect_path(current_alineryd_socket_path(repo))?;
    classify_connected_daemon(&client, repo, expected_app_config_identity).map_err(|error| error.to_string())?;
    client.session_statuses_observed()
}

fn task_activity_session(repo: &Path, task: &Task, session: &SessionMeta) -> TaskActivitySession {
    let playbook = task
        .playbook_ref
        .as_ref()
        .map(|reference| reference.key.clone())
        .unwrap_or_else(|| session.playbook.clone());
    let step_title = if session.generic {
        "Generic".to_string()
    } else {
        match retained_task_definition(repo, task) {
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
struct TaskSessionActivityProjection {
    status: Option<(u8, TaskActivityStatus)>,
    active_tier: Option<u8>,
}

fn has_unacknowledged_terminal_failure(session: &SessionMeta) -> bool {
    session.exit_code.is_some_and(|code| code != 0)
        && session
            .ended_at
            .is_none_or(|ended_at| session.exit_notification_read_at.is_none_or(|read_at| ended_at > read_at))
}

fn project_task_session_activity(repo: &Path, task: &Task, session: &SessionMeta, daemon_state: Option<&alinery_core::SessionState>) -> TaskSessionActivityProjection {
    let durable_status = if has_unacknowledged_terminal_failure(session) {
        Some((2, TaskActivityStatus::Failed))
    } else if is_primary_playbook_session(repo, task, session)
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
    let supported = !matches!(state.adapter, alinery_core::HarnessAdapter::Unsupported);
    if supported {
        if let alinery_core::PlaybookState::Failed { reason } = &state.playbook {
            let acknowledged_terminal_failure = matches!(state.process, alinery_core::ProcessState::Exited { .. })
                && session.exit_code.is_some_and(|code| code != 0)
                && !has_unacknowledged_terminal_failure(session);
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
    let process_live = matches!(state.process, alinery_core::ProcessState::Starting | alinery_core::ProcessState::Alive);
    let waiting_for_input = supported && process_live && matches!(state.agent, alinery_core::AgentState::WaitingForInput { .. });
    let waiting_for_approval = supported && process_live && matches!(state.agent, alinery_core::AgentState::WaitingForApproval { .. });
    let busy_or_starting = matches!(state.process, alinery_core::ProcessState::Starting) || (supported && process_live && matches!(state.agent, alinery_core::AgentState::Busy));
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

fn task_has_actionable_session(repo: &Path, task: &Task, sessions: &[SessionMeta], statuses_by_id: &HashMap<&str, &alinery_core::SessionState>) -> bool {
    sessions.iter().filter(|session| !session.archived).any(|session| {
        project_task_session_activity(repo, task, session, statuses_by_id.get(session.id.as_str()).copied())
            .active_tier
            .is_some()
    })
}

pub(crate) fn resolve_task_activity_for_repo(repo: &Path, slugs: &[String], statuses: &[DaemonSessionStatus]) -> HashMap<String, TaskActivitySummary> {
    let repo_path = repo.display().to_string();
    let statuses_by_id = statuses.iter().map(|status| (status.id.as_str(), &status.state)).collect::<HashMap<_, _>>();
    let mut activity = slugs
        .iter()
        .map(|slug| (task_activity_key(&repo_path, slug), TaskActivitySummary::default()))
        .collect::<HashMap<_, _>>();

    for slug in slugs {
        let Ok(task) = read_task(repo, slug) else {
            continue;
        };
        let Ok(mut sessions) = list_sessions_for_repo(repo, slug) else {
            continue;
        };
        let key = task_activity_key(&repo_path, slug);
        let mut activity_task = task;
        let mut visited = HashSet::from([activity_task.slug.clone()]);
        loop {
            if activity_task.active_subtask.is_empty() || task_has_actionable_session(repo, &activity_task, &sessions, &statuses_by_id) {
                break;
            }
            let child_slug = activity_task.active_subtask.clone();
            if !visited.insert(child_slug.clone()) {
                break;
            }
            let Ok(child) = read_task(repo, &child_slug) else {
                break;
            };
            let Ok(child_sessions) = list_sessions_for_repo(repo, &child.slug) else {
                break;
            };
            activity_task = child;
            sessions = child_sessions;
        }
        let mut summary = TaskActivitySummary::default();
        let mut status_choice: Option<(u8, u64, String, TaskActivityStatus)> = None;
        let mut active_choice: Option<(u8, u64, String, &SessionMeta)> = None;

        for session in sessions.iter().filter(|session| !session.archived) {
            let projection = project_task_session_activity(repo, &activity_task, session, statuses_by_id.get(session.id.as_str()).copied());

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

pub(crate) fn list_task_activity_for_refs(refs: &[TaskActivityRef], app_config_identity: Option<&str>) -> HashMap<String, TaskActivitySummary> {
    let mut activity = HashMap::new();
    let mut grouped = BTreeMap::<String, BTreeSet<String>>::new();
    for reference in refs {
        activity.insert(task_activity_key(&reference.repo_path, &reference.task_slug), TaskActivitySummary::default());
        grouped.entry(reference.repo_path.clone()).or_default().insert(reference.task_slug.clone());
    }
    if grouped.is_empty() {
        return activity;
    }

    let worker_count = grouped.len().min(4);
    let (job_tx, job_rx) = std::sync::mpsc::channel::<(String, Vec<String>)>();
    let job_rx = std::sync::Arc::new(Mutex::new(job_rx));
    let (result_tx, result_rx) = std::sync::mpsc::channel();

    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            let job_rx = std::sync::Arc::clone(&job_rx);
            let result_tx = result_tx.clone();
            scope.spawn(move || loop {
                let job = job_rx.lock().unwrap_or_else(|e| e.into_inner()).recv();
                let Ok((repo_path, slugs)) = job else {
                    break;
                };
                let repo = PathBuf::from(&repo_path);
                let statuses = app_config_identity
                    .ok_or_else(|| "app config identity unavailable".to_string())
                    .and_then(|identity| passive_session_statuses(&repo, identity))
                    .unwrap_or_default();
                let _ = result_tx.send(resolve_task_activity_for_repo(&repo, &slugs, &statuses));
            });
        }
        for (repo_path, slugs) in grouped {
            let _ = job_tx.send((repo_path, slugs.into_iter().collect()));
        }
        drop(job_tx);
        drop(result_tx);
    });

    for resolved in result_rx {
        activity.extend(resolved);
    }
    activity
}

/// A repo whose running daemon this app cannot talk to. Carries everything the banner
/// (A5/B3) and the takeover warning need — never a reason to kill anything.
#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct DaemonConflict {
    pub(crate) repo: String,
    pub(crate) reason: String,
    /// `None` when the running daemon predates protocol versioning.
    pub(crate) daemon_protocol: Option<u32>,
    pub(crate) app_protocol: u32,
    pub(crate) daemon_app_config_identity: Option<String>,
    pub(crate) app_config_identity: Option<String>,
    pub(crate) live_sessions: u32,
}

pub(crate) enum EnsureDaemonError {
    /// A responding daemon failed a hard compatibility gate. Nothing was killed or spawned.
    Mismatch(DaemonConflict),
    Failed(String),
}

impl std::fmt::Display for EnsureDaemonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EnsureDaemonError::Mismatch(c) if c.reason == "app_config" => {
                write!(f, "daemon for {} uses a different app configuration ({} live session(s))", c.repo, c.live_sessions)
            }
            EnsureDaemonError::Mismatch(c) => write!(
                f,
                "daemon for {} speaks protocol {}, this app speaks {} ({} live session(s))",
                c.repo,
                c.daemon_protocol.map(|p| p.to_string()).unwrap_or_else(|| "<pre-gate>".into()),
                c.app_protocol,
                c.live_sessions
            ),
            EnsureDaemonError::Failed(e) => f.write_str(e),
        }
    }
}

// Connect to the repo's daemon, spawning it (detached, so it OUTLIVES the app — that's
// the whole point) if none is answering. Retries the connect briefly while alineryd binds.
//
// INVARIANT: this function never kills a live session. It does not send `shutdown` —
// not conditionally, not "only when stale". Reuse requires matching protocol and app-config
// identity; a mismatch is reported and left alone. The four deliberate teardown origins are
// `stop_daemon` (B1), `takeover_repo_daemon` (B3), `close_repo_daemon` (B4), and
// `restore_backup`, each behind a user click carrying a loss-of-work warning.
// (Guarded by scripts/tests/check-no-auto-session-kill.sh.)
/// Probe a connected client's hard reuse fields. Used on *every* successful connect —
/// including post-spawn — so a race that attaches a pre-existing foreign daemon
/// cannot skip the gate by riding the "we just spawned" path.
/// The pure half: a `version` reply plus the app's build/config identities decide reuse.
/// Split out from the socket call so both `ensure_daemon` branches can be tested without
/// a live daemon — the post-spawn branch is exactly the one that used to skip this.
pub(crate) fn classify_version(
    version: &daemon_client::DaemonVersionReply,
    app_build: &str,
    app_config_identity: &str,
    repo: &Path,
    live_sessions: impl FnOnce() -> u32,
) -> Result<DaemonCompat, EnsureDaemonError> {
    let compat = daemon_client::classify_version_reply(version, app_build, app_config_identity);
    if compat.usable() {
        return Ok(compat);
    }
    let reason = match compat {
        DaemonCompat::ProtocolMismatch => "protocol",
        DaemonCompat::AppConfigMismatch => "app_config",
        DaemonCompat::Current | DaemonCompat::BuildDrift => unreachable!(),
    };
    Err(EnsureDaemonError::Mismatch(DaemonConflict {
        repo: repo.display().to_string(),
        reason: reason.into(),
        daemon_protocol: version.protocol,
        app_protocol: PROTOCOL_VERSION,
        daemon_app_config_identity: version.app_config_identity.clone(),
        app_config_identity: Some(app_config_identity.to_string()),
        live_sessions: live_sessions(),
    }))
}

pub(crate) fn classify_connected_daemon(client: &DaemonClient, repo: &Path, app_config_identity: &str) -> Result<(DaemonCompat, bool), EnsureDaemonError> {
    let version = client.version();
    let host_guard_warning = version.host_guard_warning();
    // `live_session_count` is a second round-trip; only a mismatch pays for it.
    let compat = classify_version(&version, &alineryd_build_id(), app_config_identity, repo, || client.live_session_count())?;
    Ok((compat, host_guard_warning))
}

pub(crate) fn ensure_daemon(repo: &Path, app_config: &Path) -> Result<(DaemonClient, DaemonCompat, String, bool), EnsureDaemonError> {
    let app_config_identity = alinery_core::app_config_identity(app_config);
    if let Ok(client) = DaemonClient::connect_path_checked(current_alineryd_socket_path(repo)) {
        let (compat, host_guard_warning) = classify_connected_daemon(&client, repo, &app_config_identity)?;
        return Ok((client, compat, app_config_identity, host_guard_warning));
    }
    spawn_daemon_detached(repo, app_config).map_err(EnsureDaemonError::Failed)?;
    for _ in 0..40 {
        if let Ok(client) = DaemonClient::connect_path_checked(current_alineryd_socket_path(repo)) {
            let (compat, host_guard_warning) = classify_connected_daemon(&client, repo, &app_config_identity)?;
            return Ok((client, compat, app_config_identity, host_guard_warning));
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Err(EnsureDaemonError::Failed("daemon did not start".to_string()))
}

/// Bring up (or reconnect to) `repo`'s daemon and record the outcome on `AppState`.
/// A hard reuse mismatch is remembered so `daemon_status` can raise the blocking banner
/// (A5/B3) — nothing is killed, nothing is spawned, session ops simply stay refused
/// until the user stops the sessions (B1) or takes the repo over (B3).
pub(crate) fn attach_repo_daemon(state: &AppState, repo: &Path, app_config: &Path) {
    // Single choke point for bringing a daemon up, so one check covers the poller, the
    // footer poll and every command: once "close all repos" has run, nothing resurrects.
    if state.is_quitting() {
        return;
    }
    // A close is in flight — its socket-gone gap is not a crash to recover from.
    if state.is_closing(repo) {
        return;
    }
    // B6: daemon ownership follows retained GUI ownership for every known repository,
    // not only the active selection. Claim a free repo here; never spawn or adopt for a
    // repository another alinery window holds.
    if !state.claim_repo(repo) {
        return;
    }
    match ensure_daemon(repo, app_config) {
        Ok((client, compat, app_config_identity, host_guard_warning)) => {
            // Re-check before *storing*, not just before starting: `ensure_daemon` can
            // block for ~2s spawning and retrying, which is ample time for the user to
            // quit or close this repo underneath us. Storing then would record a client
            // for a repo on its way out of the config, and would undo the `clear_daemon`
            // that the concurrent teardown has already done.
            //
            // Dropped, never shut down. This is a bring-up path
            // (`check-no-auto-session-kill.sh` enforces that) and the client may be an
            // *adopted* daemon full of live harnesses rather than one we just spawned —
            // stopping it to unwind our own race would kill exactly the work that guard
            // exists to protect. Nothing is silently orphaned either way: if we did
            // respawn into a teardown, the socket is back before `wait_for_daemon_gone`
            // is satisfied, so `close_repo_daemon` fails closed and tells the user the
            // repo did not close.
            if state.is_quitting() || state.is_closing(repo) {
                return;
            }
            state.set_daemon(repo, client, compat, app_config_identity, host_guard_warning);
        }
        Err(EnsureDaemonError::Mismatch(conflict)) => {
            eprintln!(
                "daemon {} mismatch for {}: daemon protocol {:?}, app protocol {}, {} live session(s)",
                conflict.reason, conflict.repo, conflict.daemon_protocol, conflict.app_protocol, conflict.live_sessions
            );
            alinery_core::append_exception(
                app_config,
                &format!(
                    "app.daemon-mismatch repo={} reason={} daemon_protocol={} app_protocol={} live={}",
                    alinery_core::quote_log_value(&conflict.repo),
                    alinery_core::quote_log_value(&conflict.reason),
                    conflict.daemon_protocol.map(|p| p.to_string()).unwrap_or_else(|| "none".into()),
                    conflict.app_protocol,
                    conflict.live_sessions
                ),
            );
            state.set_daemon_conflict(repo, conflict);
        }
        Err(e) => {
            eprintln!("daemon start failed for {}: {e}", repo.display());
            alinery_core::append_exception(
                app_config,
                &format!(
                    "app.daemon-start-failed repo={} err={}",
                    alinery_core::quote_log_value(&repo.display().to_string()),
                    alinery_core::quote_log_value(&e.to_string())
                ),
            );
        }
    }
}

// Locate the alineryd binary: a sibling of the app exe (bundled as `alineryd` or
// `alineryd-<triple>`), else the dev build under target/.
pub(crate) fn resolve_alineryd_path() -> Option<PathBuf> {
    daemon_client::resolve_alineryd_path()
}

/// Development identity uses the sidecar-derived namespace in every compiler profile.
/// Production identity always uses the bare lane.
pub(crate) fn alineryd_socket_namespace_for(identifier: &str, alineryd: PathBuf) -> Option<String> {
    if identifier != alinery_core::DEVELOPMENT_APP_IDENTIFIER {
        return None;
    }
    let stable = alineryd.canonicalize().unwrap_or(alineryd);
    let stable = stable.to_string_lossy();
    let hash = fnv1a64_hex(stable.as_ref());
    Some(format!("d{}", &hash[..12]))
}

pub(crate) fn alineryd_socket_namespace() -> Option<String> {
    // Unit tests bypass `run()`, which sets the effective identifier. Default them to
    // the harder development case so lifecycle tests exercise a namespaced lane.
    #[cfg(test)]
    let identifier = EFFECTIVE_APP_IDENTIFIER.get().map(String::as_str).unwrap_or(alinery_core::DEVELOPMENT_APP_IDENTIFIER);
    #[cfg(not(test))]
    let identifier = EFFECTIVE_APP_IDENTIFIER.get()?.as_str();
    alineryd_socket_namespace_for(identifier, resolve_alineryd_path()?)
}

pub(crate) fn fnv1a64_hex(input: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for b in input.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

pub(crate) fn current_alineryd_socket_path(repo: &Path) -> PathBuf {
    alineryd_socket_path(repo, alineryd_socket_namespace().as_deref())
}

pub(crate) fn connect_current_daemon(repo: &Path) -> Result<DaemonClient, String> {
    DaemonClient::connect_path_checked(current_alineryd_socket_path(repo))
}

pub(crate) fn current_alineryd_lock_path(repo: &Path) -> PathBuf {
    alineryd_lock_path(repo, alineryd_socket_namespace().as_deref())
}

/// Decide which alineryd socket owns a session given the meta's `daemon_namespace`.
///
/// - `None` → own lane (use `AppState.daemon`)
/// - `Some(path)` → foreign lane socket (may or may not be live)
///
/// `""` and missing meta ns both mean prod. Own ns (including both empty) → None.
pub(crate) fn route_socket_path(repo: &Path, own_ns: &str, meta_ns: &str) -> Option<PathBuf> {
    if own_ns == meta_ns {
        return None;
    }
    let ns = if meta_ns.is_empty() { None } else { Some(meta_ns) };
    Some(alineryd_socket_path(repo, ns))
}

/// Resolve the DaemonClient that currently owns `id`.
/// Cache hit → use; else read meta → route; foreign → connect *and classify* that socket.
/// On connect failure for a cached/foreign route: evict and fall back to own client once.
pub(crate) fn client_for_session(state: &AppState, repo: &Path, task_slug: &str, id: &str) -> Result<DaemonClient, String> {
    {
        let routes = state.session_routes.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(c) = routes.get(id) {
            return Ok(c.clone());
        }
    }

    let own = state.daemon_for(repo).ok_or("daemon not connected")?;
    let app_config_identity = state.daemon_app_config_identity(repo).ok_or("daemon app config identity unavailable")?;
    let own_ns = alineryd_socket_namespace().unwrap_or_default();
    let meta_ns = fs::read_to_string(session_meta_path(repo, task_slug, id))
        .ok()
        .and_then(|s| serde_json::from_str::<SessionMeta>(&s).ok())
        .map(|m| m.daemon_namespace)
        .unwrap_or_default();

    match route_socket_path(repo, &own_ns, &meta_ns) {
        None => Ok(own),
        Some(path) => match DaemonClient::connect_path_checked(path) {
            Ok(c) => {
                // Classify BEFORE caching. `connect_path_checked` proves only that
                // something accepted a connection on that socket — a dev-lane or
                // historical daemon can be perfectly reachable and speak a different (or
                // no) protocol. Caching it unclassified meant `open_session(attach)` and
                // then every write/resize/detach for this session id spoke the current
                // wire at it. The primary `ensure_daemon` paths have been gated since the
                // first review; this route was the way around them.
                classify_connected_daemon(&c, repo, &app_config_identity).map_err(|error| match error {
                    EnsureDaemonError::Mismatch(conflict) if conflict.reason == "app_config" => {
                        format!(
                            "repo-app-config-mismatch: the daemon owning session {id} \
                                 uses a different app configuration ({} live session(s)).",
                            conflict.live_sessions
                        )
                    }
                    EnsureDaemonError::Mismatch(conflict) => format!(
                        "repo-protocol-mismatch: the daemon owning session {id} speaks \
                             protocol {:?}, this app speaks {}. Stop that session's daemon \
                             ({} live session(s)) before using it here.",
                        conflict.daemon_protocol, conflict.app_protocol, conflict.live_sessions
                    ),
                    EnsureDaemonError::Failed(message) => message,
                })?;
                state.session_routes.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), c.clone());
                Ok(c)
            }
            // Foreign dead → fall back to own (status becomes unknown; classify uses meta).
            Err(_) => Ok(own),
        },
    }
}

/// Run a control op via the session's owner client. On connect-refused, evict route
/// and retry once on the own-lane client.
pub(crate) fn with_session_client<T, F>(state: &AppState, repo: &Path, task_slug: &str, id: &str, f: F) -> Result<T, String>
where
    F: Fn(&DaemonClient) -> Result<T, String>,
{
    let client = client_for_session(state, repo, task_slug, id)?;
    match f(&client) {
        Ok(v) => Ok(v),
        Err(e) => {
            let own = state.daemon().ok_or_else(|| e.clone())?;
            if own.socket_path == client.socket_path {
                return Err(e); // already the own lane — nothing to fall back to
            }
            // Only fall back to own if the routed (foreign) owner is actually unreachable
            // (transport failure). A reachable foreign owner returning an app error must
            // surface it, not be masked by replaying the op on the wrong lane.
            if UnixStream::connect(&client.socket_path).is_ok() {
                return Err(e);
            }
            state.clear_session_route(id);
            f(&own)
        }
    }
}

/// write/resize/detach have no task_slug — use route cache only, else own client.
pub(crate) fn cached_or_own_client(state: &AppState, id: &str) -> Option<DaemonClient> {
    {
        let routes = state.session_routes.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(c) = routes.get(id) {
            return Some(c.clone());
        }
    }
    state.daemon()
}

// Identify the actual daemon executable, not its mtime. Dev relaunch runs the sidecar build
// command every time; a harmless relink or copy can change timestamps and previously made alinery
// shut down a still-compatible daemon (and all of its live harnesses) as "stale".
pub(crate) fn alineryd_build_id() -> String {
    daemon_client::daemon_binary_build_id()
}
pub(crate) fn canonical_host_executable(current_exe: std::io::Result<PathBuf>) -> Option<PathBuf> {
    fs::canonicalize(current_exe.ok()?).ok()
}

pub(crate) fn spawn_daemon_detached(repo: &Path, app_config: &Path) -> Result<(), String> {
    let namespace = alineryd_socket_namespace();
    let host_executable = canonical_host_executable(std::env::current_exe());
    daemon_client::spawn_daemon_detached(repo, app_config, namespace.as_deref(), host_executable.as_deref())
}

// DELIBERATE TEARDOWN ORIGIN (B1). One of exactly three places allowed to end live
// sessions — the others are `takeover_repo_daemon` (B3) and `close_repo_daemon` (B4).
// Each is behind a user click naming the repo and warning about in-flight work; no code
// path reaches a kill on its own (see `ensure_daemon`, and the poller in `spawn_daemon_poller`).
//
// Ends EVERY live session for the TARGET repo and stops its daemon, then brings a fresh
// daemon back up for that repo: "stop the sessions" must not also mean "leave this repo
// daemonless until something incidentally reconnects" (B1). Normal app quit, by contrast,
// leaves the daemon and its sessions running on purpose.
//
// The target is the repo the caller names — the Settings scope selector, not the active
// repo, decides what the user is aiming at; `None` still means the active repo. An
// all-repositories stop is this command called once per repo in scope, so every kill
// still carries its own named confirmation.
#[tauri::command]
pub(crate) fn stop_daemon(app: AppHandle, state: State<'_, AppState>, path: Option<String>) -> Result<(), String> {
    let repo = match path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => active_repo()?,
    };
    require_repo_owned(&state, &repo)?;
    // The MCP child is bound to the active repo only; stopping another repo's sessions
    // must not take it down with them.
    let is_active = active_repo().ok().as_deref() == Some(repo.as_path());
    if is_active {
        state.kill_mcp(); // R2
    }
    let daemon = state.daemon_for(&repo).ok_or("daemon not running")?;
    daemon.call(&daemon_client::shutdown_request()).map(|_| ())?;
    // Own-lane teardown — drops cached foreign session routes too.
    state.clear_daemon(&repo);

    // Restart what we just stopped, for this repo only.
    let app_config = app_config_path(&app)?;
    attach_repo_daemon(&state, &repo, &app_config);
    if is_active {
        ensure_mcp_server(&app, &repo);
    }
    emit(
        &app,
        alinery_core::TelemetryEvent::DaemonStop {
            source: alinery_core::TelemetrySource::App,
        },
    );
    Ok(())
}

/// Live (running + idle) sessions on `repo`'s daemon, whether or not the app has a
/// client for it. Powers the loss-of-work warnings on close-repo (B4) and takeover (B3),
/// which can both act on a repo that is not the active one. Unreachable ⇒ 0.
#[tauri::command]
pub(crate) fn repo_live_sessions(path: String) -> u32 {
    connect_current_daemon(Path::new(path.trim())).map(|client| client.live_session_count()).unwrap_or(0)
}

/// Wait until nothing answers `repo`'s socket. `shutdown` unlinks the socket before it
/// acks and exits, but the process still has to go; spawning over a half-dead daemon
/// would just lose the lock race.
///
/// Fail-closed: timeout ⇒ `Err` so callers never treat a still-live daemon as gone.
pub(crate) fn wait_for_daemon_gone(repo: &Path) -> Result<(), String> {
    for _ in 0..40 {
        if connect_current_daemon(repo).is_err() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(format!("daemon for {} is still answering after shutdown", repo.display()))
}

// DELIBERATE TEARDOWN ORIGIN (B3). Reclaim a repo from a daemon this app cannot use —
// a protocol/config mismatch, or a wedged owner holding the lock with a dead socket. Reached
// only from the banner's danger button, behind an express click carrying the live
// session count. NEVER automatic: the poller surfaces this state, it never takes it.
#[tauri::command]
pub(crate) fn takeover_repo_daemon(app: AppHandle, state: State<'_, AppState>, path: Option<String>) -> Result<(), String> {
    let repo = match path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => active_repo()?,
    };
    // Talk to whoever answers the socket — that process is the owner by definition. A
    // protocol-mismatched daemon still understands `shutdown` (it predates the gate).
    if let Ok(prior) = connect_current_daemon(&repo) {
        let _ = prior.call(&daemon_client::shutdown_request());
        // Hostile reclaim: proceed to unlink even if wait times out; attach failure
        // below is the user-visible error if the prior daemon never lets go.
        let _ = wait_for_daemon_gone(&repo);
    }
    // The lock FILE is a permanent 0-byte marker, never the lock itself. Unlinking it
    // lets the fresh daemon flock a new inode; a wedged holder keeps its flock on the
    // now-unlinked inode, which no longer guards this path (see alineryd/src/lockfile.rs).
    let _ = fs::remove_file(current_alineryd_lock_path(&repo));
    state.clear_daemon(&repo);

    let app_config = app_config_path(&app)?;
    attach_repo_daemon(&state, &repo, &app_config);
    if state.daemon_for(&repo).is_none() {
        return Err(format!("could not take over {} — its daemon is still holding the repo", repo.display()));
    }
    if active_repo().ok().as_deref() == Some(repo.as_path()) {
        ensure_mcp_server(&app, &repo);
    }
    emit(
        &app,
        alinery_core::TelemetryEvent::DaemonTakeover {
            source: alinery_core::TelemetrySource::App,
        },
    );
    Ok(())
}

// DELIBERATE TEARDOWN ORIGIN (B4). Stop one repo's daemon and sessions without deciding
// when the app-level repository ownership ends. `remove_repo` releases the flock only
// after delisting succeeds; `close_all_repos` releases each successfully closed repo.
//
// Fail-closed: if a daemon still answers after shutdown+wait, do NOT clear state (and
// never unlink the alineryd lock on ordinary close — only takeover's hostile path may).
pub(crate) fn close_repo_daemon(state: &AppState, repo: &Path) -> Result<(), String> {
    // Shutdown opens a window in which the repo is still listed and its socket is going
    // away — indistinguishable, to the poller, from a daemon that just crashed. Hold the
    // repo closed for the whole teardown so nothing respawns into the gap. The guard
    // releases on every exit path, including the fail-closed `?` below.
    let _closing = state.mark_closing(repo);
    if let Ok(daemon) = connect_current_daemon(repo) {
        daemon
            .call(&daemon_client::shutdown_request())
            .map_err(|e| format!("shutdown failed for {}: {e}", repo.display()))?;
        wait_for_daemon_gone(repo)?;
    }
    // Ordinary close does NOT unlink the alineryd lock file — the daemon unlinks its
    // own lock on clean exit; hostile reclaim is takeover_repo_daemon only.
    state.clear_daemon(repo);
    Ok(())
}

pub(crate) fn close_repo_acknowledgment_plan(repos: &[PathBuf]) -> Vec<(PathBuf, Vec<(String, String)>)> {
    repos.iter().map(|repo| (repo.clone(), unended_task_session_refs_for_repo(repo))).collect()
}

pub(crate) fn execute_close_repo_acknowledgment_plan(
    plan: &[(PathBuf, Vec<(String, String)>)],
    mut close_repo: impl FnMut(&Path) -> Result<(), String>,
) -> (Vec<PathBuf>, Vec<String>) {
    let mut closed = Vec::new();
    let mut errors = Vec::new();
    for (repo, stopped_session_refs) in plan {
        match close_repo(repo) {
            Ok(()) => {
                if let Err(error) = acknowledge_exited_session_refs(repo, stopped_session_refs) {
                    errors.push(format!("acknowledge stopped sessions for {}: {error}", repo.display()));
                }
                closed.push(repo.clone());
            }
            Err(error) => errors.push(error),
        }
    }
    (closed, errors)
}

// DELIBERATE TEARDOWN ORIGIN (quit). "Close all repos" on the way out: the app is going
// away, so every repo it has open hands back its daemon, its alineryd lock and its GUI lock
// instead of leaving orphaned `alineryd` processes behind with no UI to reach them.
//
// Reached only from the window-close dialog's express choice — the default there is
// "leave sessions running", which calls nothing at all and preserves the documented
// quit-does-not-kill contract. The dialog names every repo and its live session count
// before this runs; cancelling never gets here.
//
// Daemon teardown remains centralized in `close_repo_daemon`; each caller releases the
// GUI flock at its own successful app-lifecycle commit point.
#[tauri::command]
pub(crate) fn close_all_repos(app: AppHandle, state: State<'_, AppState>) -> Result<u32, String> {
    // Latch FIRST: the poller ticks every 5s and the footer polls every 1.5s, and both
    // spawn a daemon for a repo that has none. Tearing down before shutting those off
    // would race them into resurrecting the processes the user just asked us to stop.
    state.begin_quit();
    // Stop the app-managed session producer before freezing the plan. The quit latch
    // already prevents the GUI pollers and commands from starting replacement work.
    state.kill_mcp();
    // `sanitize_app_config` keeps a non-empty `active_repo` inside `known_repos`, so this
    // list is the complete set of repos this app has open.
    let repos = load_app_config(&app)
        .known_repos
        .into_iter()
        .filter_map(|repo| {
            let repo = PathBuf::from(repo.trim());
            if repo.as_os_str().is_empty() {
                return None;
            }
            // B6: quitting closes *our* repos. A repo another alinery holds is that window's
            // to tear down — skipping it is correct, not a failure.
            if !state.owns_repo(&repo) && gui_lock_held_elsewhere(&repo) {
                return None;
            }
            Some(repo)
        })
        .collect::<Vec<_>>();
    // Freeze every repository's session references before the first blocking shutdown.
    // Repository order and teardown duration therefore cannot change acknowledgment.
    let plan = close_repo_acknowledgment_plan(&repos);
    let (closed_repos, errors) = execute_close_repo_acknowledgment_plan(&plan, |repo| close_repo_daemon(&state, repo));
    for repo in &closed_repos {
        state.release_repo(repo);
    }
    let closed = u32::try_from(closed_repos.len()).map_err(|_| "closed repository count overflow".to_string())?;
    if !errors.is_empty() {
        // The latch stays set. Quitting is still the user's stated intent and the dialog
        // asks them to confirm it; only their choosing to come back clears it, via
        // `cancel_quit`. Clearing it here would let the poller start respawning daemons
        // underneath a dialog that is still on its way to `destroy()`.
        return Err(format!("closed {closed} repo(s); failed: {}", errors.join("; ")));
    }
    Ok(closed)
}

/// Abandon a quit that did not complete: `close_all_repos` failed on some repo and the
/// user chose to return to the window rather than leave those daemons unreachable.
///
/// Undoes only the latch. The repos that *did* close stay closed — they are gone from
/// `daemons` and their locks are released, so the poller reattaches them on its next tick,
/// which is the behaviour we want and the reason the latch has to come off.
#[tauri::command]
pub(crate) fn cancel_quit(state: State<'_, AppState>) {
    state.cancel_quit();
}

/// How often B5 checks that every open repo still has a daemon.
pub(crate) const DAEMON_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// B5: the app owns the daemon lifecycle for every repo it has open — if one dies, a
/// replacement is up within a poll interval instead of the repo sitting daemonless until
/// some user action happens to call `ensure_daemon`.
///
/// SPAWN-ONLY BY CONSTRUCTION. The decision comes from `alinery_core::poller_action`, whose
/// `PollerAction` type has no kill/restart variant: a timer that kills-and-respawns over
/// a hard reuse mismatch would reintroduce the exact bug section A deletes, except firing
/// every few seconds. A mismatch only records the conflict for B3's takeover banner.
pub(crate) fn spawn_daemon_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(DAEMON_POLL_INTERVAL);
        let Some(state) = app.try_state::<AppState>() else {
            continue;
        };
        // "Close all repos" ran: the app is on its way out and re-attaching would undo it.
        // `continue`, not `return` — a partial close-all can be cancelled back into a live
        // window, and a poller thread that exited here would never come back, leaving that
        // window unable to recover any daemon that dies for the rest of the session.
        if state.is_quitting() {
            continue;
        }
        let Ok(app_config) = app_config_path(&app) else {
            continue;
        };
        let app_config_identity = alinery_core::app_config_identity(&app_config);
        // Hashing the alineryd binary is only needed once a repo actually answers, and at
        // most once per tick.
        let mut app_build: Option<String> = None;
        for repo in load_app_config(&app).known_repos.iter().map(PathBuf::from) {
            // A repo that no longer exists on disk cannot host a daemon; spawning for it
            // would burn the full connect-retry window (~2s) on every tick.
            if !repo.is_dir() {
                continue;
            }
            // Deliberate teardown in flight. Skipped before the probe, not just before the
            // spawn: `Leave` would otherwise re-adopt the daemon that close is in the
            // middle of stopping, and `set_daemon` would undo the `clear_daemon` that
            // teardown is about to perform.
            if state.is_closing(&repo) {
                continue;
            }
            // Every repo managed by this poller is open in this alinery window, so retain
            // its un-namespaced GUI flock before any connect, adoption, or spawn action.
            if !state.claim_repo(&repo) {
                state.clear_daemon(&repo);
                continue;
            }
            // Connect-don't-stat: dead lane socket files remain on disk, so probe the socket.
            let probe = connect_current_daemon(&repo).ok();
            let version = probe.as_ref().map(|c| c.version());
            let compat = version.as_ref().map(|reply| {
                let build = app_build.get_or_insert_with(alineryd_build_id);
                daemon_client::classify_version_reply(reply, build, &app_config_identity)
            });
            match poller_action(compat) {
                PollerAction::Leave => {
                    if let (Some(client), Some(compat), Some(version)) = (probe, compat, version.as_ref()) {
                        // Refresh the daemon-owned readiness and compatibility reported by
                        // whichever process currently answers this socket. Preserve the
                        // connected client and foreign routes when the entry already exists.
                        if !state.refresh_daemon_observation(&repo, compat, app_config_identity.clone(), version.host_guard_warning()) {
                            state.set_daemon(&repo, client, compat, app_config_identity.clone(), version.host_guard_warning());
                        }
                    }
                }
                PollerAction::Spawn => attach_repo_daemon(&state, &repo, &app_config),
                PollerAction::SurfaceTakeover => {
                    // Surface only. Reclaiming is B3's express user click.
                    state.set_daemon_conflict(
                        &repo,
                        DaemonConflict {
                            repo: repo.display().to_string(),
                            reason: match compat {
                                Some(DaemonCompat::AppConfigMismatch) => "app_config".into(),
                                _ => "protocol".into(),
                            },
                            daemon_protocol: version.as_ref().and_then(|reply| reply.protocol),
                            app_protocol: PROTOCOL_VERSION,
                            daemon_app_config_identity: version.as_ref().and_then(|reply| reply.app_config_identity.clone()),
                            app_config_identity: Some(app_config_identity.clone()),
                            live_sessions: probe.map(|client| client.live_session_count()).unwrap_or(0),
                        },
                    );
                }
            }
        }
    });
}

// Read-only footer status readout. Additive: aggregates the daemon's per-pty status
// (running/idle) so the UI shows one live count instead of fanning out N polls.
// `mode` is a field (not a hardcoded label) so a future remote daemon reports "remote".
#[derive(serde::Serialize)]
pub(crate) struct DaemonStatus {
    pub(crate) reachable: bool,
    pub(crate) mode: String,
    /// Sessions with a live process (Starting + Alive, regardless of agent state).
    pub(crate) alive: u32,
    pub(crate) busy: u32,
    pub(crate) waiting_for_input: u32,
    pub(crate) waiting_for_approval: u32,
    pub(crate) idle: u32,
    pub(crate) unknown: u32,
    pub(crate) exited: u32,
    pub(crate) total: u32,
    /// Foreign alineryd sockets that answer connect (Mode C visibility).
    pub(crate) extra_lanes: u32,
    /// Foreign alineryd sockets that exist but refuse connect.
    pub(crate) stale_lanes: u32,
    /// Active repo path, so the UI can name what it is about to act on (B1/B3).
    pub(crate) repo: String,
    /// A6: same wire protocol, different alineryd build. Informational only — a drifted
    /// daemon is fully usable and must never be restarted or killed for it.
    pub(crate) build_drift: bool,
    /// A5/B3: a daemon owns this repo but fails the protocol or app-config identity gate.
    /// Session ops are refused until the user stops the sessions or takes the repo over.
    pub(crate) conflict: Option<DaemonConflict>,
    /// B6: another live alinery holds this repo's GUI ownership flock. Distinct from
    /// `conflict` (that is about the daemon's hard reuse fields): the daemon here is
    /// perfectly usable, it is the second *window* that is the hazard.
    pub(crate) repo_busy: bool,
    /// Whether the selected daemon reports that it lacks a canonical host executable.
    pub(crate) host_guard_warning: bool,
}

#[tauri::command]
pub(crate) async fn daemon_status(state: State<'_, AppState>) -> Result<DaemonStatus, String> {
    let (extra_lanes, stale_lanes) = count_foreign_lanes();
    let active = active_repo().ok();
    let repo = active.as_ref().map(|r| r.display().to_string()).unwrap_or_default();
    let conflict = active.as_ref().and_then(|r| state.daemon_conflict(r));
    // Re-attempt on every poll so the banner clears by itself the moment the other
    // alinery quits — no relaunch, no button. Not while quitting: `close_all_repos` just
    // handed the flock back and a poll in flight must not take it again.
    let repo_busy = !state.is_quitting() && active.as_ref().is_some_and(|r| !state.claim_repo(r));
    let build_drift = active.as_ref().and_then(|r| state.daemon_compat(r)) == Some(DaemonCompat::BuildDrift);
    let host_guard_warning = active.as_ref().is_some_and(|repo| state.daemon_host_guard_warning(repo));
    let offline = || DaemonStatus {
        reachable: false,
        mode: "local".into(),
        alive: 0,
        busy: 0,
        waiting_for_input: 0,
        waiting_for_approval: 0,
        idle: 0,
        unknown: 0,
        exited: 0,
        total: 0,
        extra_lanes,
        stale_lanes,
        repo: repo.clone(),
        build_drift: false,
        repo_busy,
        conflict: conflict.clone(),
        host_guard_warning,
    };
    let Some(daemon) = state.daemon() else {
        return Ok(offline());
    };
    match daemon.session_statuses_observed() {
        Ok(statuses) => {
            let total = statuses.len() as u32;
            let mut alive = 0u32;
            let mut busy = 0u32;
            let mut waiting_for_input = 0u32;
            let mut waiting_for_approval = 0u32;
            let mut idle = 0u32;
            let mut unknown = 0u32;
            let mut exited = 0u32;
            for s in &statuses {
                match &s.state.process {
                    alinery_core::ProcessState::Starting | alinery_core::ProcessState::Alive => {
                        alive += 1;
                    }
                    alinery_core::ProcessState::Exited { .. } => {
                        exited += 1;
                    }
                }
                match &s.state.agent {
                    alinery_core::AgentState::Busy => busy += 1,
                    alinery_core::AgentState::WaitingForInput { .. } => waiting_for_input += 1,
                    alinery_core::AgentState::WaitingForApproval { .. } => waiting_for_approval += 1,
                    alinery_core::AgentState::Idle => idle += 1,
                    alinery_core::AgentState::Unknown => unknown += 1,
                }
            }
            Ok(DaemonStatus {
                reachable: true,
                mode: "local".into(),
                alive,
                busy,
                waiting_for_input,
                waiting_for_approval,
                idle,
                unknown,
                exited,
                total,
                extra_lanes,
                stale_lanes,
                repo,
                build_drift,
                repo_busy,
                conflict,
                host_guard_warning,
            })
        }
        Err(_) => Ok(offline()),
    }
}

/// Probe every alineryd lane socket except our own. Connect ok → extra; refuse → stale.
pub(crate) fn count_foreign_lanes() -> (u32, u32) {
    let Ok(repo) = active_repo() else {
        return (0, 0);
    };
    let own = current_alineryd_socket_path(&repo);
    let mut extra = 0u32;
    let mut stale = 0u32;
    for (_ns, path) in alinery_core::list_alineryd_lane_sockets(&repo) {
        if path == own {
            continue;
        }
        match UnixStream::connect(&path) {
            Ok(_) => extra += 1,
            Err(_) => stale += 1,
        }
    }
    (extra, stale)
}
