//! daemon: extracted from lib.rs. See AGENTS.md for the module map.
use crate::pi_durable::restart_prototype_pair;
use crate::*;
use std::cell::Cell;
#[cfg(test)]
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
#[cfg(test)]
use std::sync::Condvar;

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

pub(crate) use alinery_core::board::saved_task_execution as saved_task_execution_for;

fn availability_from_client_error(error: daemon_client::DaemonClientError) -> ExecutionAvailability {
    let detail = error.to_string();
    match error {
        daemon_client::DaemonClientError::Unreachable { .. } => ExecutionAvailability::Offline { detail },
        daemon_client::DaemonClientError::AppConfigMismatch { .. } => ExecutionAvailability::ForeignOwner { detail },
        daemon_client::DaemonClientError::ProtocolMismatch { .. } => ExecutionAvailability::Incompatible { detail },
        daemon_client::DaemonClientError::Malformed(_) | daemon_client::DaemonClientError::Launch(_) => ExecutionAvailability::Unavailable { detail },
    }
}

fn observation_build_id() -> String {
    #[cfg(test)]
    OBSERVE_HASH_CALLS.fetch_add(1, Ordering::Relaxed);
    daemon_client::daemon_binary_build_id()
}

pub(crate) fn authorize_observation_repo(known_repos: &[String], requested: &str) -> Result<PathBuf, String> {
    #[cfg(test)]
    {
        OBSERVE_AUTH_CALLS.fetch_add(1, Ordering::Relaxed);
        if OBSERVE_REQUIRE_WORKER.load(Ordering::SeqCst) && !OBSERVE_WORKER.with(Cell::get) {
            return Err("authorization left the observation worker".into());
        }
        OBSERVE_AUTH_ENTERED.store(true, Ordering::SeqCst);
        if let Some(hold) = OBSERVE_AUTH_HOLD.lock().unwrap_or_else(|error| error.into_inner()).clone() {
            let (lock, cv) = &*hold;
            let mut release = lock.lock().unwrap_or_else(|error| error.into_inner());
            while !*release {
                release = cv.wait(release).unwrap_or_else(|error| error.into_inner());
            }
        }
    }
    validate_known_target_repo(known_repos, requested)
}
#[cfg(test)]
pub(crate) fn task_execution_for(repo: &Path, task_slug: &str, app_config: &Path) -> Result<AppTaskExecutionReply, String> {
    // Validate durable data before observing its owner. Browsing never starts or adopts a lane.
    let saved = saved_task_execution_for(repo, task_slug)?;
    let socket = owner_socket(repo, &saved);
    let identity = alinery_core::app_config_identity(app_config);
    let live = match daemon_client::observe_compatible(&socket, &observation_build_id(), &identity) {
        Ok(_) => match daemon_client::observe_task_execution(&socket, task_slug) {
            Ok(execution) => {
                return Ok(AppTaskExecutionReply {
                    execution,
                    live: ExecutionAvailability::Available,
                })
            }
            Err(detail) => ExecutionAvailability::Unavailable { detail },
        },
        Err(error) => availability_from_client_error(error),
    };
    Ok(AppTaskExecutionReply { execution: saved, live })
}

fn owner_socket(repo: &Path, saved: &alinery_core::task_creation::TaskExecutionReply) -> PathBuf {
    let lane = saved.state.owning_lane.as_str();
    alinery_core::alineryd_socket_path(repo, (!lane.is_empty()).then_some(lane))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskExecutionRef {
    pub repo_path: String,
    pub task_slug: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct TaskExecutionOutcome {
    pub repo_path: String,
    pub task_slug: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<AppTaskExecutionReply>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
pub(crate) static OBSERVE_AUTH_CALLS: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
pub(crate) static OBSERVE_HASH_CALLS: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
pub(crate) static OBSERVE_WORKERS: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
pub(crate) static OBSERVE_WORKERS_MAX: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
pub(crate) static OBSERVE_AUTH_ENTERED: AtomicBool = AtomicBool::new(false);
#[cfg(test)]
pub(crate) static OBSERVE_REQUIRE_WORKER: AtomicBool = AtomicBool::new(false);
#[cfg(test)]
type AuthHold = Arc<(std::sync::Mutex<bool>, Condvar)>;
#[cfg(test)]
pub(crate) static OBSERVE_AUTH_HOLD: std::sync::Mutex<Option<AuthHold>> = std::sync::Mutex::new(None);

thread_local! {
    static OBSERVE_WORKER: Cell<bool> = const { Cell::new(false) };
}

#[cfg(test)]
pub(crate) fn enter_observe_worker() {
    OBSERVE_WORKER.with(|flag| flag.set(true));
}

#[cfg(test)]
pub(crate) fn reset_observe_counts() {
    OBSERVE_AUTH_CALLS.store(0, Ordering::Relaxed);
    OBSERVE_HASH_CALLS.store(0, Ordering::Relaxed);
    OBSERVE_WORKERS.store(0, Ordering::Relaxed);
    OBSERVE_WORKERS_MAX.store(0, Ordering::Relaxed);
    OBSERVE_AUTH_ENTERED.store(false, Ordering::SeqCst);
}

struct ObserveWorkerGuard;
impl ObserveWorkerGuard {
    fn enter() -> Self {
        #[cfg(test)]
        {
            let current = OBSERVE_WORKERS.fetch_add(1, Ordering::SeqCst) + 1;
            OBSERVE_WORKERS_MAX.fetch_max(current, Ordering::SeqCst);
        }
        Self
    }
}
impl Drop for ObserveWorkerGuard {
    fn drop(&mut self) {
        #[cfg(test)]
        {
            OBSERVE_WORKERS.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

fn fan_out<T, R>(jobs: Vec<T>, work: impl Fn(T) -> R + Sync + Send) -> Vec<R>
where
    T: Send,
    R: Send,
{
    if jobs.is_empty() {
        return Vec::new();
    }
    let workers = jobs.len().min(4);
    let (job_tx, job_rx) = std::sync::mpsc::channel();
    let job_rx = Arc::new(std::sync::Mutex::new(job_rx));
    let (result_tx, result_rx) = std::sync::mpsc::channel();
    let work = &work;
    std::thread::scope(|scope| {
        for _ in 0..workers {
            let job_rx = Arc::clone(&job_rx);
            let result_tx = result_tx.clone();

            scope.spawn(move || loop {
                let job = job_rx.lock().unwrap_or_else(|error| error.into_inner()).recv();
                let Ok(job) = job else { break };
                let _guard = ObserveWorkerGuard::enter();
                let _ = result_tx.send(work(job));
            });
        }
        for job in jobs {
            let _ = job_tx.send(job);
        }
        drop(job_tx);
        drop(result_tx);
    });
    result_rx.into_iter().collect()
}

pub(crate) fn observe_task_executions_in(config_path: &Path, known_repos: &[String], tasks: Vec<TaskExecutionRef>) -> Result<Vec<TaskExecutionOutcome>, String> {
    if tasks.is_empty() {
        return Ok(Vec::new());
    }
    let mut order = Vec::new();
    let mut seen = HashSet::new();
    for task in tasks {
        let key = (task.repo_path, task.task_slug);
        if seen.insert(key.clone()) {
            order.push(key);
        }
    }
    let mut authorized: HashMap<String, Result<PathBuf, String>> = HashMap::new();
    for (repo_path, _) in &order {
        authorized.entry(repo_path.clone()).or_insert_with(|| authorize_observation_repo(known_repos, repo_path));
    }
    let mut outcomes = HashMap::new();
    let mut eligible = Vec::new();
    for (repo_path, task_slug) in &order {
        let key = (repo_path.clone(), task_slug.clone());
        match authorized.get(repo_path).expect("every requested repository is authorized once") {
            Err(error) => {
                outcomes.insert(
                    key,
                    TaskExecutionOutcome {
                        repo_path: repo_path.clone(),
                        task_slug: task_slug.clone(),
                        execution: None,
                        error: Some(error.clone()),
                    },
                );
            }
            Ok(repo) => match saved_task_execution_for(repo, task_slug) {
                Err(error) => {
                    outcomes.insert(
                        key,
                        TaskExecutionOutcome {
                            repo_path: repo_path.clone(),
                            task_slug: task_slug.clone(),
                            execution: None,
                            error: Some(error),
                        },
                    );
                }
                Ok(saved) => eligible.push((key, repo.clone(), owner_socket(repo, &saved), saved)),
            },
        }
    }
    if !eligible.is_empty() {
        let build_id = observation_build_id();
        let identity = alinery_core::app_config_identity(config_path);
        let mut sockets = Vec::new();
        let mut seen_sockets = HashSet::new();
        for (_, _, socket, _) in &eligible {
            if seen_sockets.insert(socket.clone()) {
                sockets.push(socket.clone());
            }
        }
        let compatible: HashMap<PathBuf, Result<alinery_core::DaemonCompat, daemon_client::DaemonClientError>> = fan_out(sockets, {
            let build_id = build_id.clone();
            let identity = identity.clone();
            move |socket| {
                let result = daemon_client::observe_compatible(&socket, &build_id, &identity);
                (socket, result)
            }
        })
        .into_iter()
        .collect();
        let mut queries = Vec::new();
        for (key, _, socket, saved) in eligible {
            match compatible.get(&socket) {
                Some(Ok(_)) => queries.push((key, socket, saved)),
                Some(Err(error)) => {
                    outcomes.insert(
                        key.clone(),
                        TaskExecutionOutcome {
                            repo_path: key.0.clone(),
                            task_slug: key.1.clone(),
                            execution: Some(AppTaskExecutionReply {
                                execution: saved,
                                live: availability_from_client_error(error.clone()),
                            }),
                            error: None,
                        },
                    );
                }
                None => return Err("observation worker did not return a compatibility result".into()),
            }
        }
        for (key, result, saved) in fan_out(queries, |(key, socket, saved)| {
            let slug = key.1.clone();
            (key, daemon_client::observe_task_execution(&socket, &slug), saved)
        }) {
            let reply = match result {
                Ok(execution) => AppTaskExecutionReply {
                    execution,
                    live: ExecutionAvailability::Available,
                },
                Err(detail) => AppTaskExecutionReply {
                    execution: saved,
                    live: ExecutionAvailability::Unavailable { detail },
                },
            };
            outcomes.insert(
                key.clone(),
                TaskExecutionOutcome {
                    repo_path: key.0,
                    task_slug: key.1,
                    execution: Some(reply),
                    error: None,
                },
            );
        }
    }
    Ok(order
        .into_iter()
        .map(|key| outcomes.remove(&key).expect("every requested reference has one outcome"))
        .collect())
}

#[tauri::command]
pub(crate) async fn observe_task_executions<R: tauri::Runtime>(app: AppHandle<R>, tasks: Vec<TaskExecutionRef>) -> Result<Vec<TaskExecutionOutcome>, String> {
    if tasks.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(test)]
        enter_observe_worker();
        let config_path = app_config_path(&app)?;
        let known = load_app_config(&app).known_repos;
        if !tasks.iter().any(|task| is_remote_repo_key(&task.repo_path)) {
            return observe_task_executions_in(&config_path, &known, tasks);
        }
        // Remote refs are answered from their host; the rest take the in-process path.
        let mut seen = HashSet::new();
        let order: Vec<(String, String)> = tasks
            .iter()
            .map(|task| (task.repo_path.clone(), task.task_slug.clone()))
            .filter(|key| seen.insert(key.clone()))
            .collect();
        let (remote, local): (Vec<_>, Vec<_>) = tasks.into_iter().partition(|task| is_remote_repo_key(&task.repo_path));
        let mut outcomes: HashMap<(String, String), TaskExecutionOutcome> = HashMap::new();
        for outcome in observe_task_executions_in(&config_path, &known, local)? {
            outcomes.insert((outcome.repo_path.clone(), outcome.task_slug.clone()), outcome);
        }
        let state = app.state::<AppState>();
        for task in remote {
            let outcome = observe_remote_task_execution(&state, &known, &task.repo_path, &task.task_slug);
            outcomes.insert((task.repo_path, task.task_slug), outcome);
        }
        Ok(order.into_iter().filter_map(|key| outcomes.remove(&key)).collect())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// A remote task's retained execution plus whatever its daemon says live, through the forward.
fn observe_remote_task_execution(state: &AppState, known: &[String], repo_path: &str, task_slug: &str) -> TaskExecutionOutcome {
    let outcome = |execution: Option<AppTaskExecutionReply>, error: Option<String>| TaskExecutionOutcome {
        repo_path: repo_path.to_string(),
        task_slug: task_slug.to_string(),
        execution,
        error,
    };
    let (host_id, path) = match RepoRef::parse(repo_path) {
        Ok(RepoRef::Remote { host_id, path }) if known.iter().any(|repo| repo == repo_path) => (host_id, path),
        _ => return outcome(None, Some(format!("unknown repository: {repo_path}"))),
    };
    let saved: alinery_core::task_creation::TaskExecutionReply = match remote_call(
        state,
        &host_id,
        RepoOp::SavedExecution {
            repo: path.into(),
            slug: task_slug.to_string(),
        },
    ) {
        Ok(saved) => saved,
        Err(error) => return outcome(None, Some(error)),
    };
    let request = alinery_core::task_creation::GetTaskExecutionRequest { task_slug: task_slug.to_string() };
    match state.daemon_for(Path::new(repo_path)) {
        None => outcome(
            Some(AppTaskExecutionReply {
                execution: saved,
                live: ExecutionAvailability::Offline {
                    detail: "this remote repository's daemon is not connected".into(),
                },
            }),
            None,
        ),
        Some(client) => match client.get_task_execution(&request) {
            Ok(execution) => outcome(
                Some(AppTaskExecutionReply {
                    execution,
                    live: ExecutionAvailability::Available,
                }),
                None,
            ),
            Err(detail) => outcome(
                Some(AppTaskExecutionReply {
                    execution: saved,
                    live: ExecutionAvailability::Unavailable { detail },
                }),
                None,
            ),
        },
    }
}

#[tauri::command]
pub(crate) async fn allow_execution_completion(
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
    let app_config = app_config_path(&app)?;
    // Daemon control waits up to DAEMON_CONTROL_TIMEOUT. Keep that off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let daemon = task_daemon_for(&repo, &task_slug, &app_config)?;
        daemon_client::UiControlConnection::connect(&daemon)?.allow_execution_completion(&alinery_core::task_creation::AllowExecutionCompletionRequest {
            task_slug,
            execution_id,
            session_id,
        })
    })
    .await
    .map_err(|error| format!("allow execution completion task: {error}"))?
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

pub(crate) fn resolve_task_activity_for_repo(repo: &Path, slugs: &[String], statuses: &[DaemonSessionStatus]) -> HashMap<String, TaskActivitySummary> {
    alinery_core::task_activity::resolve_task_activity_for_repo(repo, &repo.display().to_string(), slugs, statuses)
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

/// Activity for tasks of remote repos: the host reads its own files, this side supplies the live session states.
pub(crate) fn remote_task_activity(state: &AppState, refs: &[TaskActivityRef]) -> HashMap<String, TaskActivitySummary> {
    let mut activity = HashMap::new();
    let mut grouped = BTreeMap::<&str, BTreeSet<String>>::new();
    for reference in refs {
        activity.insert(task_activity_key(&reference.repo_path, &reference.task_slug), TaskActivitySummary::default());
        grouped.entry(&reference.repo_path).or_default().insert(reference.task_slug.clone());
    }
    for (key, slugs) in grouped {
        let Ok(target @ RepoRef::Remote { .. }) = RepoRef::parse(key) else {
            continue;
        };
        let RepoRef::Remote { host_id, path } = &target else {
            continue;
        };
        let statuses = repo_client(state, &target).and_then(|client| client.session_statuses_observed()).unwrap_or_default();
        let op = RepoOp::TaskActivity {
            repo: path.into(),
            repo_path: key.to_string(),
            slugs: slugs.into_iter().collect(),
            statuses,
        };
        if let Ok(resolved) = remote_call::<HashMap<String, TaskActivitySummary>>(state, host_id, op) {
            activity.extend(resolved);
        }
    }
    activity
}

pub(crate) fn list_task_activity_for_all(state: &AppState, refs: Vec<TaskActivityRef>, app_config_identity: Option<&str>) -> HashMap<String, TaskActivitySummary> {
    let (remote, local): (Vec<_>, Vec<_>) = refs.into_iter().partition(|reference| is_remote_repo_key(&reference.repo_path));
    let mut activity = list_task_activity_for_refs(&local, app_config_identity);
    activity.extend(remote_task_activity(state, &remote));
    activity
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct TakeoverSession {
    pub(crate) id: String,
    pub(crate) name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum TakeoverImpact {
    Known { sessions: Vec<TakeoverSession> },
    Unknown { detail: String },
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct DaemonOwnerConflict {
    pub(crate) lane: String,
    pub(crate) pid: Option<i32>,
    pub(crate) protocol: Option<u32>,
    pub(crate) build_id: Option<String>,
    pub(crate) app_config_identity: Option<String>,
    pub(crate) impact: TakeoverImpact,
    pub(crate) takeover_unavailable: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct DaemonConflict {
    pub(crate) repo: String,
    pub(crate) app_protocol: u32,
    pub(crate) app_config_identity: String,
    pub(crate) owners: Vec<DaemonOwnerConflict>,
    pub(crate) issues: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct TakeoverPreview {
    pub(crate) confirmation_id: String,
    pub(crate) repo: String,
    pub(crate) owner: DaemonOwnerConflict,
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum TakeoverOutcome {
    Attached,
    Blocked { conflict: DaemonConflict },
    Reconfirm { preview: TakeoverPreview },
}

pub(crate) struct PreparedTakeover {
    repo: PathBuf,
    identity: daemon_client::PeerProcessIdentity,
    owner: DaemonOwnerConflict,
    expires: Instant,
}

#[cfg(test)]
thread_local! { static TAKEOVER_TEST_TIME: Cell<Option<Instant>> = const { Cell::new(None) }; }

fn takeover_now() -> Instant {
    #[cfg(test)]
    if let Some(now) = TAKEOVER_TEST_TIME.with(Cell::get) {
        return now;
    }
    Instant::now()
}

#[cfg(test)]
pub(crate) fn with_takeover_time<T>(now: Instant, action: impl FnOnce() -> T) -> T {
    struct Reset(Option<Instant>);
    impl Drop for Reset {
        fn drop(&mut self) {
            TAKEOVER_TEST_TIME.with(|time| time.set(self.0));
        }
    }
    let _reset = Reset(TAKEOVER_TEST_TIME.with(|time| time.replace(Some(now))));
    action()
}

fn takeover_session_names(repo: &Path, lane: &str, sessions: &mut [TakeoverSession]) {
    let Ok(tasks) = list_tasks_for_repo(repo) else { return };
    let mut names = HashMap::<String, Option<String>>::new();
    for task in tasks {
        let Ok(metadata) = list_sessions_for_repo(repo, &task.slug) else { continue };
        for meta in metadata {
            if meta.daemon_namespace != lane || !sessions.iter().any(|session| session.id == meta.id) {
                continue;
            }
            let name = alinery_core::read_session_name(repo, &task.slug, &meta.id).ok().flatten().map(|value| value.name);
            // Duplicate metadata is ambiguous, not permission to guess a displayed name.
            names.entry(meta.id).and_modify(|name| *name = None).or_insert(name);
        }
    }
    for session in sessions {
        session.name = names.remove(&session.id).flatten();
    }
}

fn observe_takeover_owner(
    repo: &Path,
    lane: &str,
    expected: Option<&daemon_client::PeerProcessIdentity>,
    app_config_identity: &str,
) -> Result<(daemon_client::PeerProcessIdentity, DaemonOwnerConflict), String> {
    let socket = alinery_core::alineryd_socket_path(repo, Some(lane));
    let connection = daemon_client::BoundDaemonConnection::connect(&socket, expected, daemon_client::DAEMON_OBSERVATION_TIMEOUT)?;
    let identity = connection.identity().clone();
    let version = connection.version()?;
    let unavailable = if !daemon_client::audited_shutdown_protocol(version.protocol) {
        Some("Shutdown compatibility is not established for this daemon; stop it from its original application.".into())
    } else if lane == alineryd_socket_namespace().as_deref().unwrap_or("") && daemon_client::classify_version_reply(&version, &alineryd_build_id(), app_config_identity).usable() {
        Some("This daemon is already compatible; reconnect instead of taking it over.".into())
    } else {
        None
    };
    // Failure to bind the list request is stale identity, never unknown session impact.
    let connection = daemon_client::BoundDaemonConnection::connect(&socket, Some(&identity), daemon_client::DAEMON_OBSERVATION_TIMEOUT)?;
    let impact = match connection.sessions() {
        Ok(sessions) => {
            let mut sessions = sessions
                .into_iter()
                .filter(|session| matches!(session.state.process, ProcessState::Starting | ProcessState::Alive))
                .map(|session| TakeoverSession { id: session.id, name: None })
                .collect::<Vec<_>>();
            sessions.sort_by(|left, right| left.id.cmp(&right.id));
            sessions.dedup_by(|left, right| left.id == right.id);
            takeover_session_names(repo, lane, &mut sessions);
            TakeoverImpact::Known { sessions }
        }
        Err(detail) => TakeoverImpact::Unknown { detail },
    };
    // Even a failed list exchange must not conceal a replacement during observation.
    drop(daemon_client::BoundDaemonConnection::connect(
        &socket,
        Some(&identity),
        daemon_client::DAEMON_OBSERVATION_TIMEOUT,
    )?);
    Ok((
        identity.clone(),
        DaemonOwnerConflict {
            lane: lane.into(),
            pid: Some(identity.pid()),
            protocol: version.protocol,
            build_id: version.build_id,
            app_config_identity: version.app_config_identity,
            impact,
            takeover_unavailable: unavailable,
        },
    ))
}

fn daemon_conflicts(repo: &Path, app_config_identity: &str) -> DaemonConflict {
    let mut conflict = DaemonConflict {
        repo: repo.display().to_string(),
        app_protocol: PROTOCOL_VERSION,
        app_config_identity: app_config_identity.into(),
        owners: Vec::new(),
        issues: Vec::new(),
    };
    match alinery_core::repo_ownership::inspect_owners(repo) {
        Err(error) => conflict.issues.push(error),
        Ok(report) => {
            conflict.issues = report.issues;
            for observation in report.lanes {
                if let Some(issue) = observation.issue {
                    conflict.issues.push(issue);
                }
                if !observation.reachable {
                    continue;
                }
                let owner = match observe_takeover_owner(repo, &observation.lane, None, app_config_identity) {
                    Ok((_, owner)) => owner,
                    Err(detail) => DaemonOwnerConflict {
                        lane: observation.lane,
                        pid: None,
                        protocol: None,
                        build_id: None,
                        app_config_identity: None,
                        impact: TakeoverImpact::Unknown { detail: detail.clone() },
                        takeover_unavailable: Some(detail),
                    },
                };
                conflict.owners.push(owner);
            }
        }
    }
    conflict
}

pub(crate) enum EnsureDaemonError {
    Mismatch(Box<DaemonConflict>),
    Failed(String),
}

impl std::fmt::Display for EnsureDaemonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Mismatch(conflict) => write!(
                f,
                "project ownership unavailable for {}: {} owner(s); {}",
                conflict.repo,
                conflict.owners.len(),
                conflict.issues.join("; ")
            ),
            Self::Failed(error) => f.write_str(error),
        }
    }
}

/// Normal attachment is never a shutdown origin. Build drift remains reusable.
pub(crate) fn classify_connected_daemon(client: &DaemonClient, repo: &Path, app_config_identity: &str) -> Result<(DaemonCompat, bool), EnsureDaemonError> {
    let version = client.version_checked().map_err(|error| {
        let mut conflict = daemon_conflicts(repo, app_config_identity);
        conflict.issues.push(error);
        EnsureDaemonError::Mismatch(Box::new(conflict))
    })?;
    let compat = daemon_client::classify_version_reply(&version, &alineryd_build_id(), app_config_identity);
    if !compat.usable() {
        return Err(EnsureDaemonError::Mismatch(Box::new(daemon_conflicts(repo, app_config_identity))));
    }
    Ok((compat, version.host_guard_warning()))
}

pub(crate) fn ensure_daemon(repo: &Path, app_config: &Path) -> Result<(DaemonClient, DaemonCompat, String, bool), EnsureDaemonError> {
    let app_config_identity = alinery_core::app_config_identity(app_config);
    if let Ok(client) = DaemonClient::connect_path_checked(current_alineryd_socket_path(repo)) {
        let (compat, host_guard_warning) = classify_connected_daemon(&client, repo, &app_config_identity)?;
        return Ok((client, compat, app_config_identity, host_guard_warning));
    }
    alinery_core::repo_ownership::check_available(repo).map_err(|detail| {
        let mut conflict = daemon_conflicts(repo, &app_config_identity);
        if !conflict.issues.contains(&detail) {
            conflict.issues.push(detail);
        }
        EnsureDaemonError::Mismatch(Box::new(conflict))
    })?;
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
/// Conflicts are remembered for the blocking banner; the poller retries without
/// stopping another owner or replacing a held lock.
pub(crate) fn attach_repo_daemon(state: &AppState, repo: &Path, app_config: &Path) {
    if state.is_quitting() || state.is_closing(repo) {
        return;
    }
    let lifecycle = state.repo_lifecycle(repo);
    let guard = lifecycle.lock().unwrap_or_else(|error| error.into_inner());
    let Ok(Some(config)) = read_existing_app_config(app_config) else { return };
    if !config.known_repos.iter().any(|known| Path::new(known) == repo) {
        return;
    }
    attach_repo_daemon_locked(state, repo, app_config, &guard);
}

pub(crate) fn attach_repo_daemon_locked(state: &AppState, repo: &Path, app_config: &Path, _guard: &std::sync::MutexGuard<'_, ()>) {
    if state.is_quitting() || state.is_closing(repo) || !state.claim_repo(repo) {
        return;
    }
    let result = ensure_daemon(repo, app_config);
    // Close/quit can be requested while a bounded probe is in flight.
    if state.is_quitting() || state.is_closing(repo) {
        return;
    }
    match result {
        Ok((client, compat, identity, warning)) => state.set_daemon(repo, client, compat, identity, warning),
        Err(EnsureDaemonError::Mismatch(conflict)) => state.set_daemon_conflict(repo, *conflict),
        Err(error) => alinery_core::append_exception(
            app_config,
            &format!(
                "app.daemon-start-failed repo={} err={}",
                alinery_core::quote_log_value(&repo.display().to_string()),
                alinery_core::quote_log_value(&error.to_string()),
            ),
        ),
    }
}

pub(crate) fn takeover_allowed(state: &AppState, repo: &Path) -> Result<(), String> {
    if state.is_quitting() || state.is_closing(repo) {
        return Err("project is closing; takeover cancelled".into());
    }
    Ok(())
}

fn selected_owner_present(repo: &Path, lane: &str) -> Result<(), String> {
    let report = alinery_core::repo_ownership::inspect_owners(repo)?;
    if !report.lanes.iter().any(|owner| owner.lane == lane && owner.reachable) {
        return Err("selected daemon is no longer a reachable project owner; refresh and select again".into());
    }
    Ok(())
}

fn remember_takeover(state: &AppState, repo: PathBuf, identity: daemon_client::PeerProcessIdentity, owner: DaemonOwnerConflict, now: Instant) -> TakeoverPreview {
    let preview = TakeoverPreview {
        confirmation_id: uuid::Uuid::new_v4().to_string(),
        repo: repo.display().to_string(),
        owner: owner.clone(),
    };
    let mut prepared = state.prepared_takeovers.lock().unwrap_or_else(|error| error.into_inner());
    prepared.retain(|_, value| value.repo != repo && value.expires > now);
    prepared.insert(
        preview.confirmation_id.clone(),
        PreparedTakeover {
            repo,
            identity,
            owner,
            expires: now + Duration::from_secs(120),
        },
    );
    preview
}

pub(crate) fn prepare_repo_takeover_blocking(
    state: &AppState,
    app_config: &Path,
    repo_path: &str,
    owner_lane: &str,
    known: impl Fn() -> Vec<String>,
) -> Result<TakeoverPreview, String> {
    let repo = validate_known_target_repo(&known(), repo_path)?;
    takeover_allowed(state, &repo)?;
    let lifecycle = state.repo_lifecycle(&repo);
    let _guard = lifecycle.lock().unwrap_or_else(|error| error.into_inner());
    takeover_allowed(state, &repo)?;
    validate_known_target_repo(&known(), repo_path)?;
    selected_owner_present(&repo, owner_lane)?;
    let (identity, owner) = observe_takeover_owner(&repo, owner_lane, None, &alinery_core::app_config_identity(app_config))?;
    if let Some(reason) = &owner.takeover_unavailable {
        return Err(reason.clone());
    }
    Ok(remember_takeover(state, repo, identity, owner, takeover_now()))
}

#[tauri::command]
pub(crate) async fn prepare_repo_takeover(app: AppHandle, repo_path: String, owner_lane: String) -> Result<TakeoverPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        prepare_repo_takeover_blocking(&app.state::<AppState>(), &app_config_path(&app)?, &repo_path, &owner_lane, || {
            load_app_config(&app).known_repos
        })
    })
    .await
    .map_err(|error| format!("prepare takeover task: {error}"))?
}

#[tauri::command]
pub(crate) fn cancel_repo_takeover(state: State<'_, AppState>, confirmation_id: String) -> Result<(), String> {
    state.prepared_takeovers.lock().unwrap_or_else(|error| error.into_inner()).remove(&confirmation_id);
    Ok(())
}

pub(crate) fn confirm_repo_takeover_blocking(
    state: &AppState,
    app_config: &Path,
    confirmation_id: &str,
    known: impl Fn() -> Vec<String>,
    attached: impl FnOnce(&Path),
) -> Result<TakeoverOutcome, String> {
    // Consume before any fallible operation, including lock waits. A failed attempt is not reusable consent.
    let preparation = state
        .prepared_takeovers
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(confirmation_id)
        .ok_or("takeover confirmation is cancelled, expired, or already used")?;
    let repo = &preparation.repo;
    takeover_allowed(state, repo)?;
    let lifecycle = state.repo_lifecycle(repo);
    let _guard = lifecycle.lock().unwrap_or_else(|error| error.into_inner());
    takeover_allowed(state, repo)?;
    if preparation.expires <= takeover_now() {
        return Err("takeover confirmation expired; prepare again".into());
    }
    validate_known_target_repo(&known(), &repo.display().to_string())?;
    let reservation = state.reserve_repo(repo)?.ok_or("repo-busy: another Alinery window owns this project")?;
    selected_owner_present(repo, &preparation.owner.lane)?;
    let (identity, owner) = observe_takeover_owner(repo, &preparation.owner.lane, Some(&preparation.identity), &alinery_core::app_config_identity(app_config))?;
    if let Some(reason) = &owner.takeover_unavailable {
        return Err(reason.clone());
    }
    if owner != preparation.owner {
        return Ok(TakeoverOutcome::Reconfirm {
            preview: remember_takeover(state, repo.clone(), identity, owner, takeover_now()),
        });
    }
    takeover_allowed(state, repo)?;
    validate_known_target_repo(&known(), &repo.display().to_string())?;
    let socket = alinery_core::alineryd_socket_path(repo, Some(&owner.lane));
    // DELIBERATE TEARDOWN ORIGIN: exactly this consumed, process-bound confirmation.
    let connection = daemon_client::BoundDaemonConnection::connect(&socket, Some(&preparation.identity), daemon_client::DAEMON_CONTROL_TIMEOUT)?;
    takeover_allowed(state, repo)?;
    if preparation.expires <= takeover_now() {
        return Err("takeover confirmation expired; prepare again".into());
    }
    connection.shutdown().map_err(|error| format!("selected daemon shutdown failed: {error}"))?;
    daemon_client::wait_for_daemon_gone(repo, &owner.lane).map_err(|error| format!("selected daemon exit not established: {error}"))?;
    takeover_allowed(state, repo)?;
    validate_known_target_repo(&known(), &repo.display().to_string())?;
    match ensure_daemon(repo, app_config) {
        Ok((client, compat, config, warning)) => {
            takeover_allowed(state, repo)?;
            reservation.commit(state);
            state.set_daemon(repo, client, compat, config, warning);
            attached(repo);
            Ok(TakeoverOutcome::Attached)
        }
        Err(EnsureDaemonError::Mismatch(conflict)) => {
            state.set_daemon_conflict(repo, (*conflict).clone());
            Ok(TakeoverOutcome::Blocked { conflict: *conflict })
        }
        Err(error) => Err(format!("selected daemon stopped, but replacement failed: {error}")),
    }
}

#[tauri::command]
pub(crate) async fn confirm_repo_takeover(app: AppHandle, confirmation_id: String) -> Result<TakeoverOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        confirm_repo_takeover_blocking(
            &state,
            &app_config_path(&app)?,
            &confirmation_id,
            || load_app_config(&app).known_repos,
            |repo| {
                ensure_mcp_server(&app, repo, true);
            },
        )
    })
    .await
    .map_err(|error| format!("confirm takeover task: {error}"))?
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
                let version = c.version_checked()?;
                daemon_client::classify_observed_version(&version, &alineryd_build_id(), &app_config_identity).map_err(|error| error.to_string())?;
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
    // Repo attach starts the helper, then the Vinculum UI daemon. Release `alineryd` is not a launch path.
    crate::pi_durable::start_prototype_pair(repo, app_config)
}

// DELIBERATE TEARDOWN ORIGIN (B1). Settings explicitly stops this daemon's sessions.
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
pub(crate) async fn stop_daemon(app: AppHandle, path: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let repo = match path.as_deref().map(str::trim) {
            Some(p) if !p.is_empty() => PathBuf::from(p),
            _ => active_repo()?,
        };
        takeover_allowed(&state, &repo)?;
        let lifecycle = state.repo_lifecycle(&repo);
        let guard = lifecycle.lock().unwrap_or_else(|error| error.into_inner());
        takeover_allowed(&state, &repo)?;
        validate_known_target_repo(&load_app_config(&app).known_repos, &repo.display().to_string())?;
        // Explicit Settings stop remains available for an incompatible daemon on this
        // build's lane, but never while another GUI holds the project.
        let reservation = state.reserve_repo(&repo)?.ok_or("repo-busy: another Alinery window owns this project")?;
        let daemon = connect_current_daemon(&repo)?;
        reservation.commit(&state);
        let closing = state.mark_closing(&repo);
        // The MCP child is bound to the active repo only; stopping another repo's sessions
        // must not take it down with them.
        let is_active = active_repo().ok().as_deref() == Some(repo.as_path());
        if is_active {
            state.kill_mcp_for_repo(&repo);
        }
        daemon.call(&daemon_client::shutdown_request()).map(|_| ())?;
        daemon_client::wait_for_daemon_gone(&repo, alineryd_socket_namespace().as_deref().unwrap_or(""))?;
        // Own-lane teardown — drops cached foreign session routes too.
        state.clear_daemon(&repo);
        drop(closing);

        // Restart what we just stopped, for this repo only.
        let app_config = app_config_path(&app)?;
        attach_repo_daemon_locked(&state, &repo, &app_config, &guard);
        if is_active {
            ensure_mcp_server(&app, &repo, false);
        }
        emit(
            &app,
            alinery_core::TelemetryEvent::DaemonStop {
                source: alinery_core::TelemetrySource::App,
            },
        );
        Ok(())
    })
    .await
    .map_err(|error| format!("stop daemon task: {error}"))?
}

/// Live sessions on this app's lane, for explicit close/stop warnings. Not ownership proof.
#[tauri::command]
pub(crate) fn repo_live_sessions(path: String) -> u32 {
    connect_current_daemon(Path::new(path.trim())).map(|client| client.live_session_count()).unwrap_or(0)
}

// DELIBERATE TEARDOWN ORIGIN (B4). Stop one repo's daemon and sessions without deciding
// when the app-level repository ownership ends. `remove_repo` releases the flock only
// after delisting succeeds; `close_all_repos` releases each successfully closed repo.
//
// Fail-closed: if a daemon still answers after shutdown+wait, do NOT clear state.
pub(crate) fn close_repo_daemon(state: &AppState, repo: &Path, _guard: &std::sync::MutexGuard<'_, ()>) -> Result<(), String> {
    // Shutdown opens a window in which the repo is still listed and its socket is going
    // away — indistinguishable, to the poller, from a daemon that just crashed. Hold the
    // repo closed for the whole teardown so nothing respawns into the gap. The guard
    // releases on every exit path, including the fail-closed `?` below.
    let _closing = state.mark_closing(repo);
    if let Ok(daemon) = connect_current_daemon(repo) {
        daemon
            .call(&daemon_client::shutdown_request())
            .map_err(|e| format!("shutdown failed for {}: {e}", repo.display()))?;
        daemon_client::wait_for_daemon_gone(repo, alineryd_socket_namespace().as_deref().unwrap_or(""))?;
    }
    // Lock markers are permanent; only releasing the kernel lock ends ownership.
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
pub(crate) async fn close_all_repos(app: AppHandle) -> Result<u32, String> {
    app.state::<AppState>().begin_quit();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // Latch FIRST: the poller ticks every 5s and the footer polls every 1.5s, and both
        // spawn a daemon for a repo that has none. Tearing down before shutting those off
        // would race them into resurrecting the processes the user just asked us to stop.
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
        let (closed_repos, errors) = execute_close_repo_acknowledgment_plan(&plan, |repo| {
            let lifecycle = state.repo_lifecycle(repo);
            let guard = lifecycle.lock().unwrap_or_else(|error| error.into_inner());
            let reservation = state.reserve_repo(repo)?.ok_or("repo-busy: another Alinery window owns this project")?;
            close_repo_daemon(&state, repo, &guard)?;
            state.release_repo(repo);
            drop(reservation);
            Ok(())
        });
        let closed = u32::try_from(closed_repos.len()).map_err(|_| "closed repository count overflow".to_string())?;
        if !errors.is_empty() {
            // The latch stays set. Quitting is still the user's stated intent and the dialog
            // asks them to confirm it; only their choosing to come back clears it, via
            // `cancel_quit`. Clearing it here would let the poller start respawning daemons
            // underneath a dialog that is still on its way to `destroy()`.
            return Err(format!("closed {closed} repo(s); failed: {}", errors.join("; ")));
        }
        Ok(closed)
    })
    .await
    .map_err(|error| format!("close repositories task: {error}"))?
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
            if !is_local_repo_dir(&repo) {
                continue;
            }
            // Deliberate teardown in flight. Skipped before the probe, not just before the
            // spawn: `Leave` would otherwise re-adopt the daemon that close is in the
            // middle of stopping, and `set_daemon` would undo the `clear_daemon` that
            // teardown is about to perform.
            if state.is_closing(&repo) {
                continue;
            }
            let lifecycle = state.repo_lifecycle(&repo);
            let _guard = lifecycle.lock().unwrap_or_else(|error| error.into_inner());
            if state.is_quitting() || state.is_closing(&repo) || !load_app_config(&app).known_repos.iter().any(|known| Path::new(known) == repo) {
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
            let version = probe.as_ref().and_then(|client| client.version_checked().ok());
            let compat = version.as_ref().map(|reply| {
                let build = app_build.get_or_insert_with(alineryd_build_id);
                daemon_client::classify_version_reply(reply, build, &app_config_identity)
            });
            if state.is_quitting() || state.is_closing(&repo) {
                continue;
            }
            match alinery_core::poller_action(compat) {
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
                PollerAction::Spawn if probe.is_none() => {
                    let _ = restart_prototype_pair(&state, &repo, &app_config);
                }
                PollerAction::Spawn => {}
                PollerAction::SurfaceConflict => {
                    let conflict = daemon_conflicts(&repo, &app_config_identity);
                    if !state.is_quitting() && !state.is_closing(&repo) {
                        state.set_daemon_conflict(&repo, conflict);
                    }
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
    // A remote repo is looked up by its stored key; the lock probe below is for local folders.
    let active_ref = active_repo_ref().ok();
    let remote = matches!(active_ref, Some(RepoRef::Remote { .. }));
    let key = active_ref.map(|r| PathBuf::from(r.uri()));
    let local = key.as_ref().filter(|_| !remote);
    let repo = key.as_ref().map(|r| r.display().to_string()).unwrap_or_default();
    let conflict = key.as_ref().and_then(|r| state.daemon_conflict(r));
    // Status is observational. The ordered lifecycle poller owns GUI claims.
    let repo_busy = !state.is_quitting() && conflict.is_none() && local.is_some_and(|repo| !state.owns_repo(repo) && gui_lock_held_elsewhere(repo));
    let build_drift = key.as_ref().and_then(|r| state.daemon_compat(r)) == Some(DaemonCompat::BuildDrift);
    let host_guard_warning = key.as_ref().is_some_and(|repo| state.daemon_host_guard_warning(repo));
    let mode = if remote { "remote" } else { "local" };
    let offline = || DaemonStatus {
        reachable: false,
        mode: mode.into(),
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
                mode: mode.into(),
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
