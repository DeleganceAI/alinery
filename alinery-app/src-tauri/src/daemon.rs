//! daemon: extracted from lib.rs. See AGENTS.md for the module map.
use crate::daemon_rpc::{hello_at, live_sessions_at, resolve, HelloResponse};
use crate::*;
use alinery_core::legacy_daemon::{self, BoundDaemonConnection, PeerProcessIdentity, DAEMON_CONTROL_TIMEOUT, DAEMON_OBSERVATION_TIMEOUT};
#[cfg(test)]
use std::cell::Cell;

pub(crate) static EFFECTIVE_APP_IDENTIFIER: OnceLock<String> = OnceLock::new();

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
    /// Tasks whose saved progress will not read and that `repair_task_state` can fix.
    pub(crate) repairable_tasks: Vec<String>,
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
    identity: PeerProcessIdentity,
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

/// How long a `Hello` to the daemon on this machine may take when it is only being observed.
const HELLO_OBSERVE: Duration = Duration::from_secs(2);

fn takeover_impact(repo: &Path, lane: &str, live: Result<Vec<String>, String>) -> TakeoverImpact {
    match live {
        Ok(mut ids) => {
            ids.sort();
            ids.dedup();
            let mut sessions = ids.into_iter().map(|id| TakeoverSession { id, name: None }).collect::<Vec<_>>();
            takeover_session_names(repo, lane, &mut sessions);
            TakeoverImpact::Known { sessions }
        }
        Err(detail) => TakeoverImpact::Unknown { detail },
    }
}

/// An owner that only speaks the JSON-lines wire (protocol 38 and below, plan O23): its version and its live sessions are read
/// over bound connections, and a takeover stops it over the same wire.
fn observe_legacy_owner(repo: &Path, lane: &str, connection: BoundDaemonConnection, app_config_identity: &str) -> Result<(PeerProcessIdentity, DaemonOwnerConflict), String> {
    let socket = alinery_core::alineryd_socket_path(repo, Some(lane));
    let identity = connection.identity().clone();
    let version = connection.version()?;
    let unavailable = if !legacy_daemon::audited_shutdown_protocol(version.protocol) {
        Some("Shutdown compatibility is not established for this daemon; stop it from its original application.".into())
    } else if lane == alineryd_socket_namespace().as_deref().unwrap_or("") && legacy_daemon::classify_version_reply(&version, &alineryd_build_id(), app_config_identity).usable() {
        Some("This daemon is already compatible; reconnect instead of taking it over.".into())
    } else {
        None
    };
    // Failure to bind the list request is stale identity, never unknown session impact.
    let connection = BoundDaemonConnection::connect(&socket, Some(&identity), DAEMON_OBSERVATION_TIMEOUT)?;
    let impact = takeover_impact(
        repo,
        lane,
        connection.sessions().map(|sessions| {
            sessions
                .into_iter()
                .filter(|session| matches!(session.state.process, ProcessState::Starting | ProcessState::Alive))
                .map(|session| session.id)
                .collect()
        }),
    );
    // Even a failed list exchange must not conceal a replacement during observation.
    drop(BoundDaemonConnection::connect(&socket, Some(&identity), DAEMON_OBSERVATION_TIMEOUT)?);
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

/// The process on the other end of `socket`, or why it cannot be named.
fn peer_identity_at(socket: &Path) -> Result<PeerProcessIdentity, String> {
    let stream = UnixStream::connect(socket).map_err(|error| format!("connect {}: {error}", socket.display()))?;
    legacy_daemon::peer_process_identity(&stream)
}

/// An owner that serves `alinery.v1`: asked `Hello` and `LiveSessions` with the token this app kept for that lane. An owner
/// this app holds no token for (another application started it) is named but cannot be taken over from here.
fn observe_rpc_owner(
    repo: &Path,
    lane: &str,
    expected: Option<&PeerProcessIdentity>,
    app_config: &Path,
    app_config_identity: &str,
) -> Result<(PeerProcessIdentity, DaemonOwnerConflict), String> {
    let (socket, secret_path) = resolve(&repo.to_string_lossy(), app_config_dir_of(app_config).ok_or("app config root unavailable")?, Some(lane))?;
    let identity = peer_identity_at(&socket)?;
    if expected.is_some_and(|expected| *expected != identity) {
        return Err("stale daemon: peer process incarnation changed".into());
    }
    let hello = hello_at(&socket, &secret_path, HELLO_OBSERVE);
    let own_lane = lane == alineryd_socket_namespace().as_deref().unwrap_or("");
    let (protocol, build_id, owner_identity, impact, unavailable) = match hello {
        Ok(hello) => {
            let compat = classify_hello(&hello, &alineryd_build_id(), app_config_identity);
            let unavailable = (own_lane && compat.usable()).then(|| "This daemon is already compatible; reconnect instead of taking it over.".to_string());
            let impact = takeover_impact(repo, lane, live_sessions_at(&socket, &secret_path));
            (Some(hello.protocol), Some(hello.build_id), Some(hello.app_config_identity), impact, unavailable)
        }
        Err(detail) => (
            None,
            None,
            None,
            TakeoverImpact::Unknown { detail },
            Some("This daemon was started by another application; stop it from there.".to_string()),
        ),
    };
    // Even a failed exchange must not conceal a replacement during observation.
    if peer_identity_at(&socket)? != identity {
        return Err("stale daemon: peer process incarnation changed".into());
    }
    Ok((
        identity.clone(),
        DaemonOwnerConflict {
            lane: lane.into(),
            pid: Some(identity.pid()),
            protocol,
            build_id,
            app_config_identity: owner_identity,
            impact,
            takeover_unavailable: unavailable,
        },
    ))
}

/// Observe the owner of `lane`. The older wire is tried first: a daemon that speaks it is stopped over it, while one that
/// speaks only `alinery.v1` is asked over its RPC socket.
fn observe_takeover_owner(repo: &Path, lane: &str, expected: Option<&PeerProcessIdentity>, app_config: &Path) -> Result<(PeerProcessIdentity, DaemonOwnerConflict), String> {
    let app_config_identity = alinery_core::app_config_identity(app_config);
    let legacy = alinery_core::alineryd_socket_path(repo, Some(lane));
    match BoundDaemonConnection::connect(&legacy, expected, DAEMON_OBSERVATION_TIMEOUT) {
        Ok(connection) => observe_legacy_owner(repo, lane, connection, &app_config_identity),
        Err(error) if error.starts_with("stale daemon") => Err(error),
        Err(_) => observe_rpc_owner(repo, lane, expected, app_config, &app_config_identity),
    }
}

fn daemon_conflicts(repo: &Path, app_config: &Path) -> DaemonConflict {
    let app_config_identity = alinery_core::app_config_identity(app_config);
    let mut conflict = DaemonConflict {
        repo: repo.display().to_string(),
        app_protocol: PROTOCOL_VERSION,
        app_config_identity,
        owners: Vec::new(),
        issues: Vec::new(),
        repairable_tasks: Vec::new(),
    };
    match alinery_core::repo_ownership::inspect_owners(repo) {
        Err(error) => conflict.issues.push(error),
        Ok(report) => {
            conflict.issues = report.issues;
            conflict.repairable_tasks = report.repairable;
            for observation in report.lanes {
                if let Some(issue) = observation.issue {
                    conflict.issues.push(issue);
                }
                if !observation.reachable {
                    continue;
                }
                let owner = match observe_takeover_owner(repo, &observation.lane, None, app_config) {
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
            Self::Mismatch(conflict) if !conflict.repairable_tasks.is_empty() => write!(
                f,
                "{} can't open because {} of its tasks {} damaged saved progress. Use Repair in the banner at the top of the window.",
                Path::new(&conflict.repo)
                    .file_name()
                    .map_or(conflict.repo.clone(), |name| name.to_string_lossy().into_owned()),
                conflict.repairable_tasks.len(),
                if conflict.repairable_tasks.len() == 1 { "has" } else { "have" },
            ),
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

/// What `Hello` reports, read against this app: protocol and app-config identity must match, the build may differ.
pub(crate) fn classify_hello(hello: &HelloResponse, app_build: &str, expected_app_config_identity: &str) -> DaemonCompat {
    alinery_core::daemon_compat(
        Some(hello.protocol),
        Some(&hello.build_id),
        Some(&hello.app_config_identity),
        app_build,
        expected_app_config_identity,
    )
}

/// `Hello` to this build's lane of `repo`'s daemon, with the token this app kept for it.
pub(crate) fn hello_current(repo: &Path, app_config: &Path, within: Duration) -> Result<HelloResponse, String> {
    let (socket, secret_path) = resolve(
        &repo.to_string_lossy(),
        app_config_dir_of(app_config).ok_or("app config root unavailable")?,
        alineryd_socket_namespace().as_deref(),
    )?;
    hello_at(&socket, &secret_path, within)
}

/// Normal attachment is never a shutdown origin. Build drift remains reusable.
fn classify_attached(hello: &HelloResponse, repo: &Path, app_config: &Path) -> Result<DaemonCompat, EnsureDaemonError> {
    let compat = classify_hello(hello, &alineryd_build_id(), &alinery_core::app_config_identity(app_config));
    if !compat.usable() {
        return Err(EnsureDaemonError::Mismatch(Box::new(daemon_conflicts(repo, app_config))));
    }
    Ok(compat)
}

pub(crate) fn ensure_daemon(repo: &Path, app_config: &Path) -> Result<DaemonCompat, EnsureDaemonError> {
    if let Ok(hello) = hello_current(repo, app_config, HELLO_OBSERVE) {
        return classify_attached(&hello, repo, app_config);
    }
    alinery_core::repo_ownership::check_available(repo).map_err(|detail| {
        let mut conflict = daemon_conflicts(repo, app_config);
        if !conflict.issues.contains(&detail) {
            conflict.issues.push(detail);
        }
        EnsureDaemonError::Mismatch(Box::new(conflict))
    })?;
    crate::pi_durable::start_daemon(repo, app_config).map_err(EnsureDaemonError::Failed)?;
    // About 5 s: the daemon takes the repository's ownership locks and adopts its tasks before it listens.
    for _ in 0..100 {
        if let Ok(hello) = hello_current(repo, app_config, HELLO_OBSERVE) {
            return classify_attached(&hello, repo, app_config);
        }
        std::thread::sleep(Duration::from_millis(50));
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
        Ok(compat) => {
            state.set_daemon(repo, compat);
            // Idempotent, so every attach asks. A daemon that cannot answer it leaves the repo as it was: the board still works.
            if let Err(error) = crate::daemon_rpc::ensure_repo_ready(&repo.to_string_lossy(), app_config) {
                log_ensure_ready_failed(app_config, &repo.display().to_string(), &error);
            }
        }
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

pub(crate) fn log_ensure_ready_failed(app_config: &Path, repo: &str, error: &str) {
    alinery_core::append_exception(
        app_config,
        &format!(
            "app.ensure-ready-failed repo={} err={}",
            alinery_core::quote_log_value(repo),
            alinery_core::quote_log_value(error)
        ),
    );
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

fn remember_takeover(state: &AppState, repo: PathBuf, identity: PeerProcessIdentity, owner: DaemonOwnerConflict, now: Instant) -> TakeoverPreview {
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
    let (identity, owner) = observe_takeover_owner(&repo, owner_lane, None, app_config)?;
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

/// The user's "Repair" on a task whose saved progress will not read. It touches one task file, keeps the
/// original beside it, and refuses while any daemon answers for the project. Then it reconnects.
#[tauri::command]
pub(crate) async fn repair_task_state(app: AppHandle, repo: String, slug: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let repo = match RepoRef::parse(&repo)? {
            RepoRef::Local(repo) => repo,
            RepoRef::Remote { .. } => return Err("Repair is only available for projects on this computer".into()),
        };
        takeover_allowed(&state, &repo)?;
        let lifecycle = state.repo_lifecycle(&repo);
        let guard = lifecycle.lock().unwrap_or_else(|error| error.into_inner());
        takeover_allowed(&state, &repo)?;
        validate_known_target_repo(&load_app_config(&app).known_repos, &repo.display().to_string())?;
        let report = alinery_core::repo_ownership::inspect_owners(&repo)?;
        if report.lanes.iter().any(|lane| lane.reachable || lane.issue.is_some()) {
            return Err("Another Alinery window has this project open. Close it, then try again.".into());
        }
        if !report.repairable.contains(&slug) {
            return Err("This task no longer needs repair.".into());
        }
        let records = alinery_core::repair_execution_state(&repo, &slug)?;
        let app_config = app_config_path(&app)?;
        alinery_core::append_exception(
            &app_config,
            &format!(
                "app.task-state-repaired repo={} task={} records={records}",
                alinery_core::quote_log_value(&repo.display().to_string()),
                alinery_core::quote_log_value(&slug),
            ),
        );
        attach_repo_daemon_locked(&state, &repo, &app_config, &guard);
        Ok(())
    })
    .await
    .map_err(|error| format!("repair task state: {error}"))?
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
    let (identity, owner) = observe_takeover_owner(repo, &preparation.owner.lane, Some(&preparation.identity), app_config)?;
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
    // DELIBERATE TEARDOWN ORIGIN: exactly this consumed, process-bound confirmation.
    takeover_allowed(state, repo)?;
    if preparation.expires <= takeover_now() {
        return Err("takeover confirmation expired; prepare again".into());
    }
    shutdown_daemon(
        &repo.display().to_string(),
        app_config,
        Some(&owner.lane),
        ShutdownOrigin::ConfirmedTakeover,
        confirmation_id,
        Some(&preparation.identity),
        legacy_shutdown(repo, &owner.lane, Some(preparation.identity.clone())),
    )
    .map_err(|error| format!("selected daemon shutdown failed: {error}"))?;
    legacy_daemon::wait_for_daemon_gone(repo, &owner.lane).map_err(|error| format!("selected daemon exit not established: {error}"))?;
    takeover_allowed(state, repo)?;
    validate_known_target_repo(&known(), &repo.display().to_string())?;
    match ensure_daemon(repo, app_config) {
        Ok(compat) => {
            takeover_allowed(state, repo)?;
            reservation.commit(state);
            state.set_daemon(repo, compat);
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
    alinery_core::resolve_alineryd_path()
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

/// A fresh bearer token for a daemon's RPC socket: 32 random bytes, hex (plan 2.1.10).
pub(crate) fn new_rpc_secret() -> Result<String, String> {
    use std::io::Read;
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut urandom| urandom.read_exact(&mut bytes))
        .map_err(|error| format!("read random bytes: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Where this app keeps the token of the daemon it started for `repo` on `lane` ("" is the product
/// lane): one owner-only file each, so two repos starting at once never rewrite a shared file.
/// A relaunched app reads it to talk to a daemon that outlived it. `dir` is the app config
/// directory, or `remote/<host-id>` under it for a remote repo.
pub(crate) fn rpc_secret_path(dir: &Path, repo: &str, lane: &str) -> PathBuf {
    dir.join("rpc-secrets").join(format!("{}.secret", fnv1a64_hex(&format!("{repo}\n{lane}"))))
}

/// Where a token waits until its daemon has answered with it (`daemon_rpc::rpc_token` promotes it).
pub(crate) fn pending_rpc_secret_path(committed: &Path) -> PathBuf {
    committed.with_extension("pending")
}

/// Write the kept copy directly (tests; a start goes through `store_pending_rpc_secret`).
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn store_rpc_secret(dir: &Path, repo: &str, lane: &str, secret: &str) -> Result<(), String> {
    alinery_core::write_owner_only_bytes(&rpc_secret_path(dir, repo, lane), secret.as_bytes())
}

/// Keep the token of a daemon about to be spawned, without replacing the live daemon's token: the
/// spawn may lose the ownership lock to a daemon that is alive but slow to answer, and then the new
/// token belongs to nobody. A daemon that does start answers with it, and `rpc_token` commits it.
pub(crate) fn store_pending_rpc_secret(dir: &Path, repo: &str, lane: &str, secret: &str) -> Result<(), String> {
    alinery_core::write_owner_only_bytes(&pending_rpc_secret_path(&rpc_secret_path(dir, repo, lane)), secret.as_bytes())
}

/// The hand-off file a local daemon reads and deletes before it listens (`--rpc-secret-file`).
pub(crate) fn write_rpc_secret_handoff(secret: &str) -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!("alinery-rpc-{}.secret", uuid::Uuid::new_v4().simple()));
    alinery_core::write_owner_only_bytes(&path, secret.as_bytes())?;
    Ok(path)
}

pub(crate) fn current_alineryd_socket_path(repo: &Path) -> PathBuf {
    alineryd_socket_path(repo, alineryd_socket_namespace().as_deref())
}

/// Whether anything accepts a connection on one of this build's sockets for `repo`: the RPC socket of a daemon that serves
/// `alinery.v1`, or the legacy one of an older daemon (plan O23). Connect-don't-stat: dead sockets stay on disk. A connect says
/// something listens, not that it is usable; `Hello` says that.
pub(crate) fn daemon_answers(repo: &Path) -> bool {
    let ns = alineryd_socket_namespace();
    [alinery_core::rpc_socket_path(repo, ns.as_deref()), current_alineryd_socket_path(repo)]
        .iter()
        .any(|socket| UnixStream::connect(socket).is_ok())
}

/// The way to stop an older daemon of `lane` (it speaks the JSON-lines wire only, plan O23), for `shutdown_daemon` to fall back
/// to when the daemon does not answer `AdminService.Shutdown`. `bound` is the incarnation a takeover's consent was given for.
pub(crate) fn legacy_shutdown(repo: &Path, lane: &str, bound: Option<PeerProcessIdentity>) -> impl FnOnce() -> Result<(), String> {
    let socket = alinery_core::alineryd_socket_path(repo, Some(lane));
    move || BoundDaemonConnection::connect(&socket, bound.as_ref(), DAEMON_CONTROL_TIMEOUT)?.shutdown()
}

// Identify the actual daemon executable, not its mtime. Dev relaunch runs the sidecar build
// command every time; a harmless relink or copy can change timestamps and previously made alinery
// shut down a still-compatible daemon (and all of its live harnesses) as "stale".
pub(crate) fn alineryd_build_id() -> String {
    alinery_core::daemon_binary_build_id()
}
pub(crate) fn canonical_host_executable(current_exe: std::io::Result<PathBuf>) -> Option<PathBuf> {
    fs::canonicalize(current_exe.ok()?).ok()
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
        let target = match path.as_deref().map(str::trim) {
            Some(p) if !p.is_empty() => p.to_string(),
            _ => active_repo_ref()?.uri(),
        };
        let repo = match RepoRef::parse(&target)? {
            RepoRef::Remote { host_id, path } => {
                crate::stop_remote_daemon(&app, &host_id, &path, |_, _| Ok(()))?;
                emit(
                    &app,
                    alinery_core::TelemetryEvent::DaemonStop {
                        source: alinery_core::TelemetrySource::App,
                    },
                );
                return Ok(());
            }
            RepoRef::Local(repo) => repo,
        };
        takeover_allowed(&state, &repo)?;
        let lifecycle = state.repo_lifecycle(&repo);
        let guard = lifecycle.lock().unwrap_or_else(|error| error.into_inner());
        takeover_allowed(&state, &repo)?;
        validate_known_target_repo(&load_app_config(&app).known_repos, &repo.display().to_string())?;
        // Explicit Settings stop remains available for an incompatible daemon on this
        // build's lane, but never while another GUI holds the project.
        let reservation = state.reserve_repo(&repo)?.ok_or("repo-busy: another Alinery window owns this project")?;
        if !daemon_answers(&repo) {
            return Err("daemon not connected".into());
        }
        reservation.commit(&state);
        let closing = state.mark_closing(&repo);
        // The MCP child is bound to the active repo only; stopping another repo's sessions
        // must not take it down with them.
        let is_active = active_repo().ok().as_deref() == Some(repo.as_path());
        if is_active {
            state.kill_mcp_for_repo(&repo);
        }
        let app_config = app_config_path(&app)?;
        shutdown_daemon(
            &repo.display().to_string(),
            &app_config,
            alineryd_socket_namespace().as_deref(),
            ShutdownOrigin::StopDaemon,
            "",
            None,
            legacy_shutdown(&repo, alineryd_socket_namespace().as_deref().unwrap_or(""), None),
        )?;
        legacy_daemon::wait_for_daemon_gone(&repo, alineryd_socket_namespace().as_deref().unwrap_or(""))?;
        // Own-lane teardown.
        state.clear_daemon(&repo);
        drop(closing);

        // Restart what we just stopped, for this repo only.
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

// DELIBERATE TEARDOWN ORIGIN (B4). Stop one repo's daemon and sessions without deciding
// when the app-level repository ownership ends. `remove_repo` releases the flock only
// after delisting succeeds; `close_all_repos` releases each successfully closed repo.
//
// Fail-closed: if a daemon still answers after shutdown+wait, do NOT clear state.
pub(crate) fn close_repo_daemon(state: &AppState, repo: &Path, app_config: &Path, _guard: &std::sync::MutexGuard<'_, ()>) -> Result<(), String> {
    // Shutdown opens a window in which the repo is still listed and its socket is going
    // away — indistinguishable, to the poller, from a daemon that just crashed. Hold the
    // repo closed for the whole teardown so nothing respawns into the gap. The guard
    // releases on every exit path, including the fail-closed `?` below.
    let _closing = state.mark_closing(repo);
    if daemon_answers(repo) {
        shutdown_daemon(
            &repo.display().to_string(),
            app_config,
            alineryd_socket_namespace().as_deref(),
            ShutdownOrigin::CloseRepo,
            "",
            None,
            legacy_shutdown(repo, alineryd_socket_namespace().as_deref().unwrap_or(""), None),
        )
        .map_err(|e| format!("shutdown failed for {}: {e}", repo.display()))?;
        legacy_daemon::wait_for_daemon_gone(repo, alineryd_socket_namespace().as_deref().unwrap_or(""))?;
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
    tauri::async_runtime::spawn_blocking(move || close_all_repos_blocking(&app))
        .await
        .map_err(|error| format!("close repositories task: {error}"))?
}

pub(crate) fn close_all_repos_blocking<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<u32, String> {
    let state = app.state::<AppState>();
    // Latch FIRST: the poller ticks every 5s and the footer polls every 1.5s, and both
    // spawn a daemon for a repo that has none. Tearing down before shutting those off
    // would race them into resurrecting the processes the user just asked us to stop.
    // Stop the app-managed session producer before freezing the plan. The quit latch
    // already prevents the GUI pollers and commands from starting replacement work.
    state.kill_mcp();
    // `sanitize_app_config` keeps a non-empty `active_repo` inside `known_repos`, so this
    // list is the complete set of repos this app has open.
    let known = load_app_config(app).known_repos;
    // Remote repositories are not torn down here. Their daemons and sessions belong to the
    // host, and stopping those is a separate, confirmed action; "close all" only lets go of
    // the hosts, once the local repos have closed.
    let remote_hosts = remote_host_ids(&known);
    let repos = known
        .into_iter()
        .filter(|repo| !is_remote_repo_key(repo))
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
        close_repo_daemon(&state, repo, &app_config_path(app)?, &guard)?;
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
    // Ends ssh only. After a failure above the hosts stay connected, for the user who comes back.
    for host_id in &remote_hosts {
        disconnect_host(app, host_id);
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
        // Hashing the daemon binary is only needed once a repo actually answers, and at most once per tick.
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
            // `Hello` is the probe: it says whether the daemon answers and what it is. A socket that accepts a connection
            // but does not answer (a daemon this app holds no token for, one still starting) is not a dead daemon.
            let compat = hello_current(&repo, &app_config, HELLO_OBSERVE).ok().map(|hello| {
                let build = app_build.get_or_insert_with(alineryd_build_id);
                classify_hello(&hello, build, &alinery_core::app_config_identity(&app_config))
            });
            if state.is_quitting() || state.is_closing(&repo) {
                continue;
            }
            match alinery_core::poller_action(compat) {
                PollerAction::Leave => {
                    if let Some(compat) = compat {
                        // Refresh the compatibility reported by whichever process currently answers this socket.
                        state.set_daemon(&repo, compat);
                    }
                }
                PollerAction::Spawn if !daemon_answers(&repo) => {
                    let _ = crate::pi_durable::start_daemon(&repo, &app_config);
                }
                PollerAction::Spawn => {}
                PollerAction::SurfaceConflict => {
                    let conflict = daemon_conflicts(&repo, &app_config);
                    if !state.is_quitting() && !state.is_closing(&repo) {
                        state.set_daemon_conflict(&repo, conflict);
                    }
                }
            }
        }
    });
}

// The shell's half of the footer status. The live count and the agent counts are the daemon's `daemon/_/status` entity, and
// whether it is reachable is the webview's own link; what only the shell knows is here: the foreign lanes, build drift, a
// conflict, and whether another window holds the repo. `mode` is a field so a remote daemon reports "remote".
#[derive(serde::Serialize)]
pub(crate) struct DaemonStatus {
    pub(crate) mode: String,
    /// Foreign daemon lanes that answer connect (Mode C visibility).
    pub(crate) extra_lanes: u32,
    /// Foreign daemon lanes whose sockets exist but refuse connect.
    pub(crate) stale_lanes: u32,
    /// Active repo path, so the UI can name what it is about to act on (B1/B3).
    pub(crate) repo: String,
    /// A6: same wire protocol, different daemon build. Informational only — a drifted
    /// daemon is fully usable and must never be restarted or killed for it.
    pub(crate) build_drift: bool,
    /// A5/B3: a daemon owns this repo but fails the protocol or app-config identity gate.
    /// Session ops are refused until the user stops the sessions or takes the repo over.
    pub(crate) conflict: Option<DaemonConflict>,
    /// B6: another live alinery holds this repo's GUI ownership flock. Distinct from
    /// `conflict` (that is about the daemon's hard reuse fields): the daemon here is
    /// perfectly usable, it is the second *window* that is the hazard.
    pub(crate) repo_busy: bool,
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
    Ok(DaemonStatus {
        mode: if remote { "remote" } else { "local" }.into(),
        extra_lanes,
        stale_lanes,
        repo,
        build_drift,
        conflict,
        repo_busy,
    })
}

/// Count every daemon lane except our own. A lane that accepts a connect on any of its sockets → extra; none does → stale.
pub(crate) fn count_foreign_lanes() -> (u32, u32) {
    let Ok(repo) = active_repo() else {
        return (0, 0);
    };
    let own = alineryd_socket_namespace().unwrap_or_default();
    let mut lanes = BTreeMap::<String, bool>::new();
    for (ns, path) in alinery_core::list_alineryd_lane_sockets(&repo) {
        if ns == own {
            continue;
        }
        let answers = UnixStream::connect(&path).is_ok();
        *lanes.entry(ns).or_default() |= answers;
    }
    let extra = lanes.values().filter(|answers| **answers).count() as u32;
    (extra, lanes.len() as u32 - extra)
}
