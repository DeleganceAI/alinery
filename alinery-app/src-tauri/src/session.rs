//! session: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

pub(crate) use alinery_core::board::session_display_context as session_display_context_for_repo;
pub(crate) use alinery_core::board::{project_session_display, SessionDisplayContext, SessionDisplayMeta};
pub(crate) use alinery_core::session_actions::{
    mark_exit_notification_read as mark_session_exit_notification_read_in, mark_notification_read as mark_session_notification_read_in,
};
pub(crate) use alinery_core::SessionMeta;

#[tauri::command]
pub(crate) fn rename_session<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    repo_path: String,
    task_slug: String,
    session_id: String,
    name: String,
) -> Result<alinery_core::SessionName, String> {
    match target_repo_ref_for_app(&app, &repo_path)? {
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::RenameSession {
                repo: path.into(),
                slug: task_slug,
                session_id,
                name,
            },
        ),
        RepoRef::Local(repo) => {
            require_repo_owned(&state, &repo)?;
            Ok(alinery_core::set_session_name(&repo, &task_slug, &session_id, &name, alinery_core::SessionNameSource::User)?.value)
        }
    }
}

#[tauri::command]
pub(crate) fn get_session_display<R: tauri::Runtime>(app: AppHandle<R>, repo_path: String, task_slug: String, session_id: String) -> Result<SessionDisplayContext, String> {
    match target_repo_ref_for_app(&app, &repo_path)? {
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::GetSessionDisplay {
                repo: path.into(),
                slug: task_slug,
                session_id,
            },
        ),
        RepoRef::Local(repo) => session_display_context_for_repo(&repo, &task_slug, &session_id),
    }
}

#[derive(Deserialize, Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub(crate) struct SessionStatusRef {
    pub(crate) repo_path: String,
    pub(crate) task_slug: String,
    pub(crate) id: String,
}

// Structured observation returned to the frontend for a single session.
// `state` is Some only when the daemon owns the session id; `checkpoint` is always
// read from meta so accepted completion remains visible while the daemon is offline.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct SessionObservation {
    pub(crate) lifecycle: LifecycleState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) state: Option<alinery_core::SessionState>,
    pub(crate) checkpoint: alinery_core::SemanticCheckpoint,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) transport: Option<alinery_core::SessionTransport>,
}

pub(crate) use alinery_core::board::{session_list_items_for_repo, SessionListItem};
pub(crate) use alinery_core::session_actions::{clear_session_notifications_in, SessionNotificationClearRef};

pub(crate) fn session_list_status_key(repo_path: &str, task_slug: &str, id: &str) -> String {
    format!("{repo_path}:{task_slug}:{id}")
}

// Only the tests build the meta path now (the daemon resolves its own); keep it as the
// canonical helper so a test and the daemon can't drift.
pub(crate) fn session_meta_path(repo: &Path, slug: &str, id: &str) -> PathBuf {
    let dir = if slug.is_empty() { root_sessions_dir(repo) } else { sessions_dir(repo, slug) };
    dir.join(format!("{id}.meta.json"))
}

#[tauri::command]
pub(crate) async fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    request: alinery_core::task_creation::CreateExecutionSessionRequest,
) -> Result<alinery_core::task_creation::CreateExecutionSessionReply, String> {
    // Daemon control waits up to DAEMON_CONTROL_TIMEOUT. A sync command runs that on the main thread.
    let app_config = app_config_path(&app)?;
    let daemon = task_client(&state, &app_config, &active_repo_ref()?, &request.task_slug)?;
    tauri::async_runtime::spawn_blocking(move || daemon.create_execution_session(&request))
        .await
        .map_err(|error| format!("create session task: {error}"))?
}

#[tauri::command]
pub(crate) async fn create_session_for_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    request: alinery_core::task_creation::CreateExecutionSessionRequest,
) -> Result<alinery_core::task_creation::CreateExecutionSessionReply, String> {
    let app_config = app_config_path(&app)?;
    let daemon = task_client(&state, &app_config, &target_repo_ref_for_app(&app, &repo_path)?, &request.task_slug)?;
    tauri::async_runtime::spawn_blocking(move || daemon.create_execution_session(&request))
        .await
        .map_err(|error| format!("create session task: {error}"))?
}

#[tauri::command]
pub(crate) fn mark_session_notification_read(app: AppHandle, state: State<'_, AppState>, repo_path: String, task_slug: String, id: String) -> Result<(), String> {
    match target_repo_ref_for_app(&app, &repo_path)? {
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::MarkSessionNotificationRead {
                repo: path.into(),
                slug: task_slug,
                session_id: id,
            },
        ),
        RepoRef::Local(repo) => {
            require_repo_owned(&state, &repo)?;
            mark_session_notification_read_in(&repo, &task_slug, &id)
        }
    }
}

#[tauri::command]
pub(crate) async fn clear_session_notifications(app: AppHandle, state: State<'_, AppState>, refs: Vec<SessionNotificationClearRef>) -> Result<(), String> {
    // Resolve (and ownership-check) every repo first, then group: a remote host gets one call for its refs.
    let mut grouped = BTreeMap::<String, (RepoRef, Vec<SessionNotificationClearRef>)>::new();
    for reference in refs {
        let target = owned_target(&app, &state, &reference.repo_path)?;
        grouped.entry(target.uri()).or_insert_with(|| (target, Vec::new())).1.push(reference);
    }
    off_main_thread("clear session notifications", move || {
        let state = app.state::<AppState>();
        for (target, refs) in grouped.into_values() {
            match target {
                RepoRef::Local(repo) => clear_session_notifications_in(&repo, &refs)?,
                RepoRef::Remote { host_id, path } => remote_call::<()>(&state, &host_id, RepoOp::ClearSessionNotifications { repo: path.into(), refs })?,
            }
        }
        Ok(())
    })
    .await
}

pub(crate) fn unended_task_session_refs_for_repo(repo: &Path) -> Vec<(String, String)> {
    let mut refs = Vec::new();
    let Ok(tasks) = list_tasks_for_repo(repo) else {
        return refs;
    };
    for task in tasks {
        let Ok(sessions) = list_sessions_for_repo(repo, &task.slug) else {
            continue;
        };
        refs.extend(
            sessions
                .into_iter()
                .filter(|session| session.started_at.is_some() && session.ended_at.is_none())
                .map(|session| (task.slug.clone(), session.id)),
        );
    }
    refs.sort();
    refs
}

pub(crate) fn acknowledge_exited_session_refs(repo: &Path, refs: &[(String, String)]) -> Result<(), String> {
    let errors = refs
        .iter()
        .filter_map(|(task_slug, id)| {
            mark_session_exit_notification_read_in(repo, task_slug, id)
                .err()
                .map(|error| format!("{task_slug}/{id}: {error}"))
        })
        .collect::<Vec<_>>();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[tauri::command]
pub(crate) async fn list_sessions(app: AppHandle, state: State<'_, AppState>, task_slug: String, repo_path: Option<String>) -> Result<Vec<SessionDisplayMeta>, String> {
    match target_or_active_ref(&app, repo_path)? {
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::ListSessions {
                repo: path.into(),
                slug: task_slug,
            },
        ),
        RepoRef::Local(repo) => Ok(list_sessions_for_repo(&repo, &task_slug)?
            .into_iter()
            .map(|meta| project_session_display(&repo, &task_slug, meta))
            .collect()),
    }
}

#[tauri::command]
pub(crate) async fn list_session_items(app: AppHandle, all_repos: bool, include_archived: bool, repo_path: Option<String>) -> Result<Vec<SessionListItem>, String> {
    let known_repos = load_app_config(&app).known_repos;
    off_main_thread("list session items", move || {
        list_session_items_with_repo_resolver(&app.state::<AppState>(), all_repos, include_archived, known_repos, repo_path.as_deref(), |path| {
            target_repo_ref_for_app(&app, path)
        })
    })
    .await
}

/// Session rows of every known repo, or of one: the requested repo (resolved and validated by
/// `resolve_repo`) or else the active one. A remote repo's rows come from its host.
pub(crate) fn list_session_items_with_repo_resolver(
    state: &AppState,
    all_repos: bool,
    include_archived: bool,
    known_repos: Vec<String>,
    repo_path: Option<&str>,
    resolve_repo: impl FnOnce(&str) -> Result<RepoRef, String>,
) -> Result<Vec<SessionListItem>, String> {
    let repos = if all_repos {
        known_repos
    } else {
        let target = match repo_path {
            Some(path) => resolve_repo(path)?,
            None => active_repo_ref()?,
        };
        vec![target.uri()]
    };
    let mut out = vec![];
    for key in dedupe_known_repos(repos) {
        match RepoRef::parse(&key)? {
            RepoRef::Local(repo) => out.extend(session_list_items_for_repo(&repo, &key, include_archived)?),
            RepoRef::Remote { host_id, path } => {
                let op = RepoOp::ListSessionItems {
                    repo: path.into(),
                    repo_path: key.clone(),
                    include_archived,
                };
                match remote_call::<Vec<SessionListItem>>(state, &host_id, op) {
                    Ok(rows) => out.extend(rows),
                    // One unreachable host must not blank the other repos' lists.
                    Err(_) if all_repos => {}
                    Err(error) => return Err(error),
                }
            }
        }
    }
    sort_session_items(&mut out);
    Ok(out)
}

fn sort_session_items(items: &mut [SessionListItem]) {
    items.sort_by(|a, b| {
        b.session
            .created
            .cmp(&a.session.created)
            .then_with(|| a.repo_path.cmp(&b.repo_path))
            .then_with(|| a.task_slug.cmp(&b.task_slug))
            .then_with(|| a.session.id.cmp(&b.session.id))
    });
}

#[allow(dead_code)]
pub(crate) fn list_root_sessions_for_repo(repo: &Path) -> Result<Vec<SessionMeta>, String> {
    list_sessions_in_dir(root_sessions_dir(repo))
}

pub(crate) use alinery_core::board::list_session_metas_in_dir as list_sessions_in_dir;
pub(crate) use alinery_core::board::list_task_sessions as list_sessions_for_repo;

pub(crate) fn archive_session_in(app: &AppHandle, state: &AppState, repo: &Path, task_slug: String, id: String) -> Result<(), String> {
    let task_slug = task_slug.trim().to_string();
    if task_slug.is_empty() {
        return Err("sessions must be attached to a task".into());
    }
    // Kill+reap the pty on its OWNING lane FIRST — own or a foreign daemon, routed via
    // with_session_client — so archiving can't leak a cross-lane daemon-owned pty; the reap
    // stamps ended_at/exit_code. An unknown/offline owner yields "unknown"/Err, so we skip
    // straight to the flag flip (issue #24 P6 / #71 cross-lane).
    let owned = with_session_client(state, repo, &task_slug, &id, |d| d.session_status_observed(&id))
        .map(|s| s.is_some())
        .unwrap_or(false);
    if owned {
        with_session_client(state, repo, &task_slug, &id, |d| d.kill_session(&id))?;
    }
    // stamp_meta does a read-modify-write of only `archived`, so it can't clobber the
    // daemon's concurrently-written started/ended/exit fields (issue #24 three-writer safety).
    stamp_meta(&session_meta_path(repo, &task_slug, &id), |v| v["archived"] = serde_json::json!(true))?;
    emit_with(app, || {
        let ids = alinery_core::telemetry_ids_for_session(repo, &task_slug, &id);
        alinery_core::TelemetryEvent::SessionArchive {
            source: alinery_core::TelemetrySource::App,
            killed_live: owned,
            session_id: ids.session,
            task_id: ids.task,
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn archive_session(app: AppHandle, state: State<'_, AppState>, task_slug: String, id: String) -> Result<(), String> {
    let repo = match active_repo_ref()? {
        RepoRef::Local(_) => RepoRef::Local(require_owned_active_repo(&state)?),
        remote => remote,
    };
    archive_session_off_thread(app, repo, task_slug, id).await
}

// Resolve managed routing state inside the worker; no borrowed command State crosses threads.
async fn archive_session_off_thread(app: AppHandle, repo: RepoRef, task_slug: String, id: String) -> Result<(), String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        match repo {
            RepoRef::Local(repo) => archive_session_in(&app, &state, &repo, task_slug, id),
            RepoRef::Remote { host_id, path } => archive_remote_session(&state, &host_id, path, task_slug, id),
        }
    })
    .await;
    result.map_err(|e| format!("archive session task: {e}"))?
}

/// Stop the session's process through the repo's daemon if it is live, then flag it archived on
/// the host. A remote repo has the one daemon, so there is no foreign lane to route to.
pub(crate) fn archive_remote_session(state: &AppState, host_id: &str, path: String, task_slug: String, id: String) -> Result<(), String> {
    let task_slug = task_slug.trim().to_string();
    if task_slug.is_empty() {
        return Err("sessions must be attached to a task".into());
    }
    let key = RepoRef::Remote {
        host_id: host_id.to_string(),
        path: path.clone(),
    };
    let client = repo_client(state, &key)?;
    if client.session_status_observed(&id).map(|status| status.is_some()).unwrap_or(false) {
        client.kill_session(&id)?;
    }
    remote_call(
        state,
        host_id,
        RepoOp::StampSessionArchived {
            repo: path.into(),
            slug: task_slug,
            session_id: id,
        },
    )
}

#[tauri::command]
pub(crate) async fn archive_session_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, task_slug: String, id: String) -> Result<(), String> {
    let repo = target_repo_ref_for_app(&app, &repo_path)?;
    if let RepoRef::Local(local) = &repo {
        require_repo_owned(&state, local)?;
    }
    archive_session_off_thread(app, repo, task_slug, id).await
}

// Default derived via #[derive(Default)] on struct (Mutex<Option<T>> defaults to None)

pub(crate) const SESSION_CHANNEL_BATCH_BYTES: usize = 16 * 1024;
pub(crate) const SESSION_CHANNEL_FLUSH_AFTER: Duration = Duration::from_millis(8);
pub(crate) const SESSION_CHANNEL_HEADER_BYTES: usize = size_of::<u32>();
pub(crate) const TAURI_RAW_FETCH_MIN_BYTES: usize = 1024;

// Tauri 2.11 routes raw bodies shorter than 1 KiB through `webview.eval`, compiling a fresh
// JavaScript array literal for every message. Frame and pad the app-only channel body so even an
// idle-flushed short batch takes Tauri's binary fetch path; the frontend strips this envelope.
pub(crate) fn frame_session_channel_bytes(bytes: Vec<u8>) -> Vec<u8> {
    let payload_len = u32::try_from(bytes.len()).expect("session channel batch exceeds u32");
    let frame_len = (SESSION_CHANNEL_HEADER_BYTES + bytes.len()).max(TAURI_RAW_FETCH_MIN_BYTES);
    let mut framed = Vec::with_capacity(frame_len);
    framed.extend_from_slice(&payload_len.to_le_bytes());
    framed.extend_from_slice(&bytes);
    framed.resize(frame_len, 0);
    framed
}

// Tauri delivers raw channel bodies below 1 KiB through `webview.eval` as JavaScript array
// literals. Chatty TUIs emit many sub-KiB PTY reads, so forwarding each read independently can
// saturate WebKit's main thread even when the byte rate is modest. Briefly coalesce consecutive
// reads here; this thread may block without affecting alineryd's PTY reader or other clients.
pub(crate) fn pump_session_stream(mut stream: UnixStream, mut send: impl FnMut(Vec<u8>) -> bool) {
    let _ = stream.set_read_timeout(Some(SESSION_CHANNEL_FLUSH_AFTER));
    let mut read_buf = [0u8; 8192];
    let mut pending = Vec::with_capacity(SESSION_CHANNEL_BATCH_BYTES);

    loop {
        match stream.read(&mut read_buf) {
            Ok(0) => {
                if !pending.is_empty() {
                    let _ = send(pending);
                }
                break;
            }
            Ok(n) => {
                pending.extend_from_slice(&read_buf[..n]);
                if pending.len() >= SESSION_CHANNEL_BATCH_BYTES {
                    let batch = std::mem::replace(&mut pending, Vec::with_capacity(SESSION_CHANNEL_BATCH_BYTES));
                    if !send(batch) {
                        break;
                    }
                }
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                if !pending.is_empty() {
                    let batch = std::mem::replace(&mut pending, Vec::with_capacity(SESSION_CHANNEL_BATCH_BYTES));
                    if !send(batch) {
                        break;
                    }
                }
            }
            Err(_) => {
                if !pending.is_empty() {
                    let _ = send(pending);
                }
                break;
            }
        }
    }
}

// Root (taskless) drawer open guard. Used only when task_slug is empty: allow when
// existing meta is no-harness, or when no meta exists yet (the only remaining root
// session type is the drawer). Meta wins when present. Harness is not on the wire.
pub(crate) fn allow_root_session_open(meta_harness: Option<&str>) -> bool {
    match meta_harness {
        Some(harness) => harness == alinery_core::NO_HARNESS_KEY,
        None => true,
    }
}

pub(crate) fn hosted_refresh_needed(intent: &str, harness: &str, model: &str) -> bool {
    alinery_core::is_vinculum_session(harness) && matches!(intent, daemon_client::ops::SPAWN | daemon_client::ops::RESUME) && (model.trim().is_empty() || is_hosted_model(model))
}

/// Refresh hosted inference inside the one-hour renewal lead. Vinculum is the only daemon.
pub(crate) const PI_DURABLE_HOSTED_REFRESH: Duration = Duration::from_secs(30 * 60);

pub(crate) fn spawn_pi_hosted_refresh(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(PI_DURABLE_HOSTED_REFRESH);
        let Ok(app_config) = app_config_path(&app) else { continue };
        let _ = alinery_core::ensure_hosted_inference_for_spawn(&app_config);
    });
}

pub(crate) async fn refresh_hosted_inference_before_open(app: AppHandle, intent: &str, harness: &str, model: &str) -> Result<(), String> {
    if !hosted_refresh_needed(intent, harness, model) {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || refresh_hosted_inference_for_spawn(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn ensure_drawer_terminal(state: State<'_, AppState>) -> Result<SessionMeta, String> {
    let reply = repo_client(&state, &active_repo_ref()?)?.create_execution_session(&alinery_core::task_creation::CreateExecutionSessionRequest {
        task_slug: String::new(),
        target: alinery_core::task_creation::ExecutionSessionTarget::Auxiliary {
            harness: alinery_core::NO_HARNESS_KEY.into(),
            model: None,
            prompt: None,
        },
        launch_override: None,
        prompt_extra: None,
        handoff_artifact: None,
        start: false,
    })?;
    Ok(reply.session)
}

// Open a session: REATTACH if its pty is still running (replay scrollback, then go
// live), else spawn a fresh harness in `cwd`. This is what lets a session keep
// running in the background — switching away no longer kills it, and switching
// back shows the same process at its current screen, not a fresh one. Distinct ids
// coexist: the "bag of cheap sessions", many ptys alive at once.
// M4: the spawn is GENERIC over the registry — which binary/args/env and how the seeded
// prompt is delivered come from the session's harness (read from its meta), not hardcoded.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn open_session(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
    cwd: String,
    attach_id: u64,
    stream_token: u64,
    task_slug: Option<String>,
    phase: Option<String>,
    model: Option<String>,
    intent: Option<String>,
    resume_token: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    on_bytes: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let task_slug_clean = task_slug.clone().unwrap_or_default();
    let slug_trim = task_slug_clean.trim();
    if slug_trim.is_empty() {
        let meta_harness = match active_repo_ref() {
            Ok(RepoRef::Remote { host_id, path }) => remote_call::<Option<alinery_core::LaunchFields>>(
                &state,
                &host_id,
                RepoOp::ReadLaunchFields {
                    repo: path.into(),
                    slug: String::new(),
                    session_id: id.clone(),
                },
            )
            .ok()
            .flatten()
            .map(|launch| launch.harness),
            _ => active_repo().ok().and_then(|repo| {
                let path = session_meta_path(&repo, "", &id);
                fs::read_to_string(path).ok().and_then(|s| serde_json::from_str::<SessionMeta>(&s).ok()).map(|m| m.harness)
            }),
        };
        if !allow_root_session_open(meta_harness.as_deref()) {
            return Err("root sessions are limited to no-harness drawer".into());
        }
    }
    let intent = intent.as_deref().unwrap_or(daemon_client::ops::SPAWN);
    if !daemon_client::is_known_open_intent(intent) {
        return Err(format!("unknown session intent '{intent}'"));
    }
    let target = require_active_target(&state)?;
    let mut harness = String::new();
    let mut session_model = model.clone().filter(|m| !m.is_empty()).unwrap_or_default();
    if !slug_trim.is_empty() {
        let launch = match &target {
            ActiveRepo::Local(repo) => {
                let task = read_task(repo, slug_trim)?;
                if task.engine_version < 2 {
                    return Err("pre-v2 task data is read-only; create a new v2 task to launch sessions".into());
                }
                if task.draft || task.archived {
                    return Err("draft or archived tasks cannot launch sessions".into());
                }
                task_daemon_for(repo, &task.slug, &app_config_path(&app)?)?
                    .get_task_execution(&alinery_core::task_creation::GetTaskExecutionRequest { task_slug: task.slug.clone() })?;
                alinery_core::read_meta_launch_fields(repo, slug_trim, &id)
            }
            ActiveRepo::Remote { host_id, path } => {
                let task: Task = remote_call::<Option<Task>>(
                    &state,
                    host_id,
                    RepoOp::GetTask {
                        repo: path.clone().into(),
                        slug: slug_trim.to_string(),
                    },
                )?
                .ok_or_else(|| format!("no such task: {slug_trim}"))?;
                if task.engine_version < 2 {
                    return Err("pre-v2 task data is read-only; create a new v2 task to launch sessions".into());
                }
                if task.draft || task.archived {
                    return Err("draft or archived tasks cannot launch sessions".into());
                }
                state
                    .daemon()
                    .ok_or("daemon not connected")?
                    .get_task_execution(&alinery_core::task_creation::GetTaskExecutionRequest { task_slug: task.slug.clone() })?;
                remote_call::<Option<alinery_core::LaunchFields>>(
                    &state,
                    host_id,
                    RepoOp::ReadLaunchFields {
                        repo: path.clone().into(),
                        slug: slug_trim.to_string(),
                        session_id: id.clone(),
                    },
                )?
            }
        };
        if let Some(launch) = launch {
            if !alinery_core::is_allowed_launch_harness(&launch.harness) {
                return Err(format!("unknown harness '{}'", launch.harness));
            }
            harness = launch.harness;
            if session_model.is_empty() {
                session_model = launch.model;
            }
        }
    }
    refresh_hosted_inference_before_open(app.clone(), intent, &harness, &session_model).await?;
    let daemon = match &target {
        ActiveRepo::Local(repo) if intent == daemon_client::ops::ATTACH => client_for_session(&state, repo, slug_trim, &id)?,
        _ => state.daemon().ok_or("daemon not connected")?,
    };
    open_daemon_session(
        &daemon,
        &id,
        &cwd,
        Some(slug_trim),
        phase.as_deref(),
        model.as_deref(),
        attach_id,
        stream_token,
        intent,
        resume_token.as_deref(),
        cols,
        rows,
        on_bytes,
        app,
    )
}

// Detach the frontend without killing the pty: the session keeps running in the
// background (scrollback keeps filling) until you reopen it. Called when a terminal
// pane unmounts so the reader stops forwarding to a torn-down channel. Only clears
// the sink if `attach_id` still matches the current attach — a stale detach racing a
// newer open_session is a no-op, so it can't clobber the live sink (freeze the feed).
#[tauri::command]
pub(crate) fn detach_session(state: State<'_, AppState>, id: String, attach_id: u64) -> Result<(), String> {
    require_active_repo_ready(&state)?;
    // Route cache only (no task_slug on this command). Miss → own lane.
    let daemon = cached_or_own_client(&state, &id).ok_or("daemon not connected")?;
    match daemon.detach_session(&id, attach_id) {
        Ok(()) => Ok(()),
        Err(e) => {
            state.clear_session_route(&id);
            let own = state.daemon().ok_or_else(|| e.clone())?;
            if own.socket_path == daemon.socket_path {
                return Err(e);
            }
            own.detach_session(&id, attach_id)
        }
    }
}

// Frontend keystrokes -> pty. No-op if the session isn't registered yet.
#[tauri::command]
pub(crate) fn write_session(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    require_active_repo_ready(&state)?;
    let daemon = cached_or_own_client(&state, &id).ok_or("daemon not connected")?;
    match daemon.write_session(&id, &data) {
        Ok(()) => Ok(()),
        Err(e) => {
            state.clear_session_route(&id);
            let own = state.daemon().ok_or_else(|| e.clone())?;
            if own.socket_path == daemon.socket_path {
                return Err(e);
            }
            own.write_session(&id, &data)
        }
    }
}

#[tauri::command]
pub(crate) fn prepare_review_approval_prompt(state: State<'_, AppState>, task_slug: String, review_artifact: String) -> Result<PreparedSessionMessageAction, String> {
    match require_active_target(&state)? {
        ActiveRepo::Local(repo) => prepare_review_approval_prompt_for(&repo, &task_slug, &review_artifact),
        ActiveRepo::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::PrepareReviewApprovalPrompt {
                repo: path.into(),
                slug: task_slug,
                review_artifact,
            },
        ),
    }
}
#[tauri::command]
pub(crate) fn finalize_session_message_actions(state: State<'_, AppState>, id: String, task_slug: String, actions: Vec<SessionMessageActionProvenance>) -> Result<(), String> {
    match require_active_target(&state)? {
        ActiveRepo::Local(repo) => finalize_session_message_actions_for(&repo, &id, &task_slug, &actions),
        ActiveRepo::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::FinalizeSessionMessageActions {
                repo: path.into(),
                slug: task_slug,
                session_id: id,
                actions,
            },
        ),
    }
}

// Resize the pty so the TUI reflows. No-op if the session isn't registered yet.
#[tauri::command]
pub(crate) fn resize_session(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    require_active_repo_ready(&state)?;
    let daemon = cached_or_own_client(&state, &id).ok_or("daemon not connected")?;
    match daemon.resize_session(&id, cols, rows) {
        Ok(()) => Ok(()),
        Err(e) => {
            state.clear_session_route(&id);
            let own = state.daemon().ok_or_else(|| e.clone())?;
            if own.socket_path == daemon.socket_path {
                return Err(e);
            }
            own.resize_session(&id, cols, rows)
        }
    }
}

// Structured observation for a single session: lifecycle from process state or meta fallback,
// structured state axes when the daemon owns the id, checkpoint always from meta.
#[tauri::command]
pub(crate) async fn session_status(app: AppHandle, id: String, task_slug: Option<String>) -> SessionObservation {
    let app_state = app.state::<AppState>();
    let slug = task_slug.as_deref().unwrap_or("");
    let (meta, live) = match active_repo_ref() {
        Ok(RepoRef::Remote { host_id, path }) => {
            let sessions: Vec<SessionDisplayMeta> = remote_call(
                &app_state,
                &host_id,
                RepoOp::ListSessions {
                    repo: path.into(),
                    slug: slug.to_string(),
                },
            )
            .unwrap_or_default();
            let meta = sessions.into_iter().find(|session| session.meta.id == id).map(|session| session.meta);
            let live = app_state.daemon().and_then(|client| client.session_status_observed(&id).ok().flatten());
            (meta, live)
        }
        _ => {
            let meta = active_repo()
                .ok()
                .map(|repo| session_meta_path(&repo, slug, &id))
                .and_then(|p| fs::read_to_string(&p).ok())
                .and_then(|s| serde_json::from_str::<SessionMeta>(&s).ok());
            let live = active_repo()
                .ok()
                .and_then(|repo| with_session_client(&app_state, &repo, slug, &id, |d| d.session_status_observed(&id)).ok().flatten());
            (meta, live)
        }
    };

    let (started, ended, exit) = meta.as_ref().map(|m| (m.started_at, m.ended_at, m.exit_code)).unwrap_or((None, None, None));
    let checkpoint = meta.as_ref().map(|m| m.semantic.clone()).unwrap_or_default();

    let lifecycle = lifecycle_from_structured(started, ended, exit, live.as_ref().map(|live| &live.state));
    SessionObservation {
        lifecycle,
        state: live.as_ref().map(|live| live.state.clone()),
        checkpoint,
        transport: live.map(|live| live.transport),
    }
}

// Thin helper: extract process axis from optional structured state and call classify.
// This is the single place that bridges SessionState to LifecycleState in the app layer.
pub(crate) fn lifecycle_from_structured(
    started_at: Option<u64>,
    ended_at: Option<u64>,
    exit_code: Option<i32>,
    daemon_state: Option<&alinery_core::SessionState>,
) -> LifecycleState {
    classify(started_at, ended_at, exit_code, daemon_state.map(|s| &s.process))
}

#[derive(Clone)]
pub(crate) struct SessionStatusLaneRow {
    pub(crate) key: String,
    pub(crate) id: String,
    pub(crate) meta: SessionMeta,
}

pub(crate) fn unknown_session_observation(key: String) -> SessionObservation {
    let _ = key; // key is used by the caller, not stored in the observation itself
    SessionObservation {
        lifecycle: LifecycleState::NeverStarted,
        state: None,
        checkpoint: alinery_core::SemanticCheckpoint::default(),
        transport: None,
    }
}

pub(crate) fn session_list_statuses_with_repo_resolver(refs: &[SessionStatusRef], resolve_repo: impl Fn(&str) -> Result<PathBuf, String>) -> HashMap<String, SessionObservation> {
    let mut result: HashMap<String, SessionObservation> = HashMap::new();
    let mut grouped = BTreeMap::<PathBuf, Vec<SessionStatusLaneRow>>::new();
    let mut resolved_repos = HashMap::<String, Option<PathBuf>>::new();
    let own_namespace = alineryd_socket_namespace().unwrap_or_default();

    for reference in refs {
        let key = session_list_status_key(&reference.repo_path, &reference.task_slug, &reference.id);
        if result.contains_key(&key) {
            continue;
        }
        result.insert(key.clone(), unknown_session_observation(key.clone()));

        let Some(repo) = resolved_repos
            .entry(reference.repo_path.clone())
            .or_insert_with(|| resolve_repo(&reference.repo_path).ok())
            .clone()
        else {
            continue;
        };
        let Ok(contents) = fs::read_to_string(session_meta_path(&repo, &reference.task_slug, &reference.id)) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<SessionMeta>(&contents) else {
            continue;
        };
        // Replace the NeverStarted placeholder with the meta-derived observation.
        // When a daemon lane fails or is offline, callers see the correct historical lifecycle.
        let meta_lifecycle = lifecycle_from_structured(meta.started_at, meta.ended_at, meta.exit_code, None);
        result.insert(
            key.clone(),
            SessionObservation {
                lifecycle: meta_lifecycle,
                state: None,
                checkpoint: meta.semantic.clone(),
                transport: None,
            },
        );
        let socket_path = route_socket_path(&repo, &own_namespace, &meta.daemon_namespace).unwrap_or_else(|| current_alineryd_socket_path(&repo));
        grouped.entry(socket_path).or_default().push(SessionStatusLaneRow {
            key,
            id: reference.id.clone(),
            meta,
        });
    }

    if grouped.is_empty() {
        return result;
    }

    let worker_count = grouped.len().min(4);
    let (job_tx, job_rx) = std::sync::mpsc::channel::<(PathBuf, Vec<SessionStatusLaneRow>)>();
    let job_rx = std::sync::Arc::new(Mutex::new(job_rx));
    let (result_tx, result_rx) = std::sync::mpsc::channel::<(String, SessionObservation)>();

    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            let job_rx = std::sync::Arc::clone(&job_rx);
            let result_tx = result_tx.clone();
            scope.spawn(move || loop {
                let job = job_rx.lock().unwrap_or_else(|e| e.into_inner()).recv();
                let Ok((socket_path, rows)) = job else {
                    break;
                };
                let Ok(statuses) = DaemonClient::connect_path(socket_path).and_then(|client| client.session_statuses_observed()) else {
                    continue;
                };
                // Build id -> live status from daemon list response.
                let daemon_live: HashMap<String, (alinery_core::SessionState, alinery_core::SessionTransport)> =
                    statuses.into_iter().map(|s| (s.id, (s.state, s.transport))).collect();

                for row in rows {
                    let live = daemon_live.get(&row.id).cloned();
                    let daemon_state = live.as_ref().map(|(state, _)| state.clone());
                    let lifecycle = lifecycle_from_structured(row.meta.started_at, row.meta.ended_at, row.meta.exit_code, daemon_state.as_ref());
                    let checkpoint = row.meta.semantic.clone();
                    let observation = SessionObservation {
                        lifecycle,
                        state: daemon_state,
                        checkpoint,
                        transport: live.map(|(_, transport)| transport),
                    };
                    let _ = result_tx.send((row.key, observation));
                }
            });
        }
        for job in grouped {
            let _ = job_tx.send(job);
        }
        drop(job_tx);
        drop(result_tx);
    });

    result.extend(result_rx);
    result
}

#[cfg(test)]
pub(crate) fn session_list_statuses_for_refs(refs: &[SessionStatusRef]) -> HashMap<String, SessionObservation> {
    session_list_statuses_with_repo_resolver(refs, |repo_path| Ok(PathBuf::from(repo_path)))
}

#[tauri::command]
pub(crate) async fn session_list_statuses(app: AppHandle, refs: Vec<SessionStatusRef>) -> HashMap<String, SessionObservation> {
    // File reads plus a daemon round trip per lane: never on the async runtime's own threads.
    tauri::async_runtime::spawn_blocking(move || {
        let (remote, local): (Vec<_>, Vec<_>) = refs.into_iter().partition(|reference| is_remote_repo_key(&reference.repo_path));
        let mut result = session_list_statuses_with_repo_resolver(&local, |repo_path| target_repo_for_app(&app, repo_path));
        result.extend(remote_session_statuses(&app.state::<AppState>(), &remote));
        result
    })
    .await
    .unwrap_or_default()
}

/// One session's observation from its meta and the live state its daemon reported, if any.
fn observation_of(meta: SessionMeta, live: Option<&(alinery_core::SessionState, alinery_core::SessionTransport)>) -> SessionObservation {
    let state = live.map(|(state, _)| state.clone());
    SessionObservation {
        lifecycle: lifecycle_from_structured(meta.started_at, meta.ended_at, meta.exit_code, state.as_ref()),
        state,
        checkpoint: meta.semantic,
        transport: live.map(|(_, transport)| *transport),
    }
}

/// Statuses for sessions of remote repos: metas from each host in one call, live states from its forwarded
/// daemon. A host that does not answer leaves its rows as "never started", like an offline local daemon.
pub(crate) fn remote_session_statuses(state: &AppState, refs: &[SessionStatusRef]) -> HashMap<String, SessionObservation> {
    let mut result = HashMap::new();
    let mut grouped = BTreeMap::<&str, Vec<&SessionStatusRef>>::new();
    for reference in refs {
        let key = session_list_status_key(&reference.repo_path, &reference.task_slug, &reference.id);
        result.insert(key.clone(), unknown_session_observation(key));
        grouped.entry(&reference.repo_path).or_default().push(reference);
    }
    for (key, group) in grouped {
        let Ok(target @ RepoRef::Remote { .. }) = RepoRef::parse(key) else {
            continue;
        };
        let RepoRef::Remote { host_id, path } = &target else {
            continue;
        };
        let pairs = group.iter().map(|reference| (reference.task_slug.clone(), reference.id.clone())).collect();
        let Ok(metas) = remote_call::<Vec<Option<SessionMeta>>>(state, host_id, RepoOp::ReadSessionMetas { repo: path.into(), refs: pairs }) else {
            continue;
        };
        let live: HashMap<_, _> = repo_client(state, &target)
            .and_then(|client| client.session_statuses_observed())
            .unwrap_or_default()
            .into_iter()
            .map(|status| (status.id, (status.state, status.transport)))
            .collect();
        for (reference, meta) in group.into_iter().zip(metas) {
            if let Some(meta) = meta {
                let observation = observation_of(meta, live.get(&reference.id));
                result.insert(session_list_status_key(&reference.repo_path, &reference.task_slug, &reference.id), observation);
            }
        }
    }
    result
}

// Task pages render several session rows at once. Resolve all of their daemon states through one
// app IPC call and one `list` request per owning daemon lane instead of starting a poller per row.
#[tauri::command]
pub(crate) async fn session_statuses(app: AppHandle, ids: Vec<String>, task_slug: String) -> HashMap<String, SessionObservation> {
    let app_state = app.state::<AppState>();
    let repo = active_repo().ok();
    let mut metadata: HashMap<String, Option<SessionMeta>> = HashMap::new();
    let mut clients = BTreeMap::<PathBuf, DaemonClient>::new();

    // A remote repo's metas live on its host and its one daemon is the forwarded client.
    if let Ok(RepoRef::Remote { host_id, path }) = active_repo_ref() {
        let sessions: Vec<SessionDisplayMeta> = remote_call(
            &app_state,
            &host_id,
            RepoOp::ListSessions {
                repo: path.into(),
                slug: task_slug.clone(),
            },
        )
        .unwrap_or_default();
        for session in sessions.into_iter().filter(|session| ids.contains(&session.meta.id)) {
            metadata.insert(session.meta.id.clone(), Some(session.meta));
        }
        if let Some(client) = app_state.daemon() {
            clients.insert(client.socket_path.clone(), client);
        }
    }

    for id in ids.iter().filter(|_| repo.is_some()) {
        let meta = repo
            .as_ref()
            .map(|repo| session_meta_path(repo, &task_slug, id))
            .and_then(|path| fs::read_to_string(path).ok())
            .and_then(|contents| serde_json::from_str::<SessionMeta>(&contents).ok());
        metadata.insert(id.clone(), meta);

        // Board observation only: a session whose owning daemon is unreachable *or*
        // incompatible simply contributes no live status, exactly as before. The mismatch
        // is refused where it would matter (attach/write/resize/detach), not here.
        if let Some(client) = repo.as_ref().and_then(|repo| client_for_session(&app_state, repo, &task_slug, id).ok()) {
            clients.entry(client.socket_path.clone()).or_insert(client);
        }
    }

    // Collect structured state from all relevant daemon lanes.
    let daemon_live: HashMap<String, (alinery_core::SessionState, alinery_core::SessionTransport)> = clients
        .into_values()
        .filter_map(|client| client.session_statuses_observed().ok())
        .flatten()
        .map(|s| (s.id, (s.state, s.transport)))
        .collect();

    ids.into_iter()
        .map(|id| {
            let meta = metadata.remove(&id).flatten();
            let (started, ended, exit) = meta.as_ref().map(|m| (m.started_at, m.ended_at, m.exit_code)).unwrap_or((None, None, None));
            let checkpoint = meta.as_ref().map(|m| m.semantic.clone()).unwrap_or_default();
            let live = daemon_live.get(&id).cloned();
            let daemon_state = live.as_ref().map(|(state, _)| state.clone());
            let lifecycle = lifecycle_from_structured(started, ended, exit, daemon_state.as_ref());
            (
                id,
                SessionObservation {
                    lifecycle,
                    state: daemon_state,
                    checkpoint,
                    transport: live.map(|(_, transport)| transport),
                },
            )
        })
        .collect()
}

#[tauri::command]
pub(crate) fn restate_session(state: State<'_, AppState>, id: String, transport: String) -> Result<(), String> {
    let _ = (state, id, transport);
    Err("OMP process sessions are not available".into())
}

/// Bring up the reserved setup session and return its id.
///
/// The dialog that follows uses the ordinary `rpc_attach_session` / `rpc_write_session` commands
/// against that id -- `cached_or_own_client` has no route for it, so it falls through to the
/// active repo's daemon, which is the one that owns it.
#[tauri::command]
pub(crate) fn omp_setup_session(state: State<'_, AppState>) -> Result<String, String> {
    let _ = state;
    Err("OMP process sessions are not available".into())
}

#[tauri::command]
pub(crate) async fn session_transcript(state: State<'_, AppState>, id: String) -> Result<alinery_core::daemon_client::TranscriptReply, String> {
    require_active_repo_ready(&state)?;
    let daemon = cached_or_own_client(&state, &id).ok_or("daemon not connected")?;
    off_main_thread("transcript", move || daemon.transcript(&id)).await
}

#[tauri::command]
pub(crate) async fn session_prompt(state: State<'_, AppState>, id: String, text: String) -> Result<(), String> {
    require_active_repo_ready(&state)?;
    let daemon = cached_or_own_client(&state, &id).ok_or("daemon not connected")?;
    off_main_thread("prompt", move || daemon.prompt(&id, &text)).await
}

#[tauri::command]
pub(crate) async fn session_abort(state: State<'_, AppState>, id: String) -> Result<(), String> {
    require_active_repo_ready(&state)?;
    let daemon = cached_or_own_client(&state, &id).ok_or("daemon not connected")?;
    off_main_thread("abort", move || daemon.abort(&id)).await
}

#[tauri::command]
pub(crate) async fn session_set_model(state: State<'_, AppState>, id: String, model: String) -> Result<alinery_core::daemon_client::SessionControls, String> {
    require_active_repo_ready(&state)?;
    let daemon = cached_or_own_client(&state, &id).ok_or("daemon not connected")?;
    off_main_thread("set model", move || daemon.set_model(&id, &model)).await
}

#[tauri::command]
pub(crate) async fn session_set_thinking_level(state: State<'_, AppState>, id: String, level: String) -> Result<alinery_core::daemon_client::SessionControls, String> {
    require_active_repo_ready(&state)?;
    let daemon = cached_or_own_client(&state, &id).ok_or("daemon not connected")?;
    off_main_thread("set thinking level", move || daemon.set_thinking_level(&id, &level)).await
}

fn active_daemon(state: &AppState) -> Result<alinery_core::daemon_client::DaemonClient, String> {
    require_active_repo_ready(state)?;
    state.daemon().ok_or_else(|| "daemon not connected".to_string())
}

#[tauri::command]
pub(crate) async fn provider_catalog(state: State<'_, AppState>) -> Result<alinery_core::daemon_client::ProviderCatalog, String> {
    let daemon = active_daemon(&state)?;
    off_main_thread("provider catalog", move || daemon.provider_catalog()).await
}

#[tauri::command]
pub(crate) async fn vinculum_customizations(state: State<'_, AppState>) -> Result<alinery_core::daemon_client::VinculumCustomizations, String> {
    let daemon = active_daemon(&state)?;
    off_main_thread("vinculum customizations", move || daemon.vinculum_customizations()).await
}

#[tauri::command]
pub(crate) async fn provider_logout(state: State<'_, AppState>, provider: String) -> Result<alinery_core::daemon_client::ProviderCatalog, String> {
    let daemon = active_daemon(&state)?;
    off_main_thread("provider logout", move || daemon.provider_logout(&provider)).await
}

#[tauri::command]
pub(crate) async fn provider_login_start(state: State<'_, AppState>, provider: String, method: String) -> Result<alinery_core::daemon_client::ProviderLoginStatus, String> {
    let daemon = active_daemon(&state)?;
    off_main_thread("provider login", move || daemon.provider_login_start(&provider, &method)).await
}

#[tauri::command]
pub(crate) async fn provider_login_poll(state: State<'_, AppState>, login_id: String) -> Result<alinery_core::daemon_client::ProviderLoginStatus, String> {
    let daemon = active_daemon(&state)?;
    off_main_thread("provider login poll", move || daemon.provider_login_poll(&login_id)).await
}

#[tauri::command]
pub(crate) async fn provider_login_reply(state: State<'_, AppState>, login_id: String, value: String, cancel: bool) -> Result<(), String> {
    let daemon = active_daemon(&state)?;
    off_main_thread("provider login reply", move || daemon.provider_login_reply(&login_id, &value, cancel)).await
}

#[tauri::command]
pub(crate) async fn custom_provider_save(
    state: State<'_, AppState>,
    id: String,
    name: String,
    base_url: String,
    api_key: String,
    keep_key: bool,
    models: Vec<String>,
) -> Result<alinery_core::daemon_client::ProviderCatalog, String> {
    let daemon = active_daemon(&state)?;
    off_main_thread("custom provider", move || daemon.custom_provider_save(&id, &name, &base_url, &api_key, keep_key, &models)).await
}

#[tauri::command]
pub(crate) async fn custom_provider_delete(state: State<'_, AppState>, id: String) -> Result<alinery_core::daemon_client::ProviderCatalog, String> {
    let daemon = active_daemon(&state)?;
    off_main_thread("custom provider delete", move || daemon.custom_provider_delete(&id)).await
}

#[tauri::command]
pub(crate) async fn rpc_write_session(state: State<'_, AppState>, id: String, payload: Value) -> Result<(), String> {
    let _ = (state, id, payload);
    Err("OMP process sessions are not available".into())
}

#[tauri::command]
pub(crate) async fn rpc_attach_session(state: State<'_, AppState>, app: AppHandle, id: String, attach_id: u64, stream_token: u64, on_line: Channel<String>) -> Result<(), String> {
    let _ = (state, app, id, attach_id, stream_token, on_line);
    Err("OMP process sessions are not available".into())
}

/// Daemon socket I/O waits up to DAEMON_CONTROL_TIMEOUT (a daemon blocked writing a full OMP
/// stdin pipe can take that long). A sync command would run it on the main thread and freeze
/// the whole window; these run on the blocking pool instead.
pub(crate) async fn off_main_thread<T: Send + 'static>(what: &str, work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|error| format!("{what}: {error}"))?
}

#[tauri::command]
pub(crate) async fn start_session(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: Option<String>,
    task_slug: String,
    session_id: String,
) -> Result<alinery_core::task_creation::CreateExecutionSessionReply, String> {
    let target = target_or_active_ref(&app, repo_path)?;
    let app_config = app_config_path(&app)?;
    let daemon = task_client(&state, &app_config, &target, &task_slug)?;
    // Daemon control waits up to DAEMON_CONTROL_TIMEOUT. A sync command runs that on the main thread.
    tauri::async_runtime::spawn_blocking(move || daemon.start_session(&alinery_core::task_creation::StartSessionRequest { task_slug, session_id }))
        .await
        .map_err(|error| format!("start session task: {error}"))?
}

// Terminate a live daemon-owned session's harness process group and reap it (issue #24 P6).
// The daemon awaits its own reap, so on return the meta is stamped and the id is dropped.
// That wait runs on the main thread if the command stays synchronous.
#[tauri::command]
pub(crate) async fn kill_session(app: AppHandle, state: State<'_, AppState>, id: String, task_slug: String) -> Result<(), String> {
    if let RepoRef::Remote { .. } = active_repo_ref()? {
        return kill_remote_session(app, active_repo_ref()?, id).await;
    }
    let repo = require_owned_active_repo(&state)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        with_session_client(&state, &repo, &task_slug, &id, |d| d.kill_session(&id))?;
        state.clear_session_route(&id);
        emit_with(&app, || {
            let ids = alinery_core::telemetry_ids_for_session(&repo, &task_slug, &id);
            alinery_core::TelemetryEvent::SessionKill {
                source: alinery_core::TelemetrySource::App,
                session_id: ids.session,
                task_id: ids.task,
            }
        });
        Ok(())
    })
    .await;
    result.map_err(|error| format!("kill session task: {error}"))?
}

#[tauri::command]
pub(crate) async fn kill_session_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String, task_slug: String) -> Result<(), String> {
    let target = target_repo_ref_for_app(&app, &repo_path)?;
    if let RepoRef::Remote { .. } = target {
        return kill_remote_session(app, target, id).await;
    }
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        with_session_client(&state, &repo, &task_slug, &id, |d| d.kill_session(&id))?;
        state.clear_session_route(&id);
        Ok(())
    })
    .await;
    result.map_err(|error| format!("kill session task: {error}"))?
}

/// Terminate a session's process group through the remote repo's daemon. Never stops the daemon.
async fn kill_remote_session(app: AppHandle, repo: RepoRef, id: String) -> Result<(), String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        repo_client(&state, &repo)?.kill_session(&id)?;
        state.clear_session_route(&id);
        Ok(())
    })
    .await;
    result.map_err(|error| format!("kill session task: {error}"))?
}

/// True when the phase artifact for this session exists and is non-empty.
/// This is a content feature (artifact listing/rendering), not a completion signal.
#[tauri::command]
pub(crate) async fn session_artifact_ready(app: AppHandle, id: String, task_slug: String) -> bool {
    let Ok(target) = active_repo_ref() else {
        return false;
    };
    off_main_thread("session artifact ready", move || match target {
        RepoRef::Local(repo) => Ok(alinery_core::board::session_artifact_ready(&repo, &task_slug, &id)),
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::SessionArtifactReady {
                repo: path.into(),
                slug: task_slug,
                session_id: id,
            },
        ),
    })
    .await
    .unwrap_or(false)
}

// One backward page of a session's OMP journal, as a JSON header line followed by the raw window
// bytes. The body crosses IPC as `tauri::ipc::Response` (an ArrayBuffer): a `Vec<u8>` return would
// be serialized as a JSON array of numbers, which measures 3.4x on the wire and forces the webview
// to materialise a multi-megabyte string and a per-byte number array before parsing a single row.
// Framing the header as its own line means the client's existing newline split does the work.
#[tauri::command]
pub(crate) async fn read_session_omp(app: AppHandle, id: String, task_slug: Option<String>, end: Option<u64>, want: Option<u64>) -> Result<tauri::ipc::Response, String> {
    let target = active_repo_ref()?;
    let slug = task_slug.unwrap_or_default();
    let window = tauri::async_runtime::spawn_blocking(move || match target {
        RepoRef::Local(repo) => alinery_core::read_omp_window(&repo, &slug, &id, end, want),
        RepoRef::Remote { host_id, path } => remote_call::<alinery_core::repo_service::WireOmpWindow>(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::ReadOmpWindow {
                repo: path.into(),
                slug,
                session_id: id,
                end,
                want,
            },
        )
        .map(Into::into),
    })
    .await
    .map_err(|error| error.to_string())??;
    let mut body = serde_json::to_vec(&serde_json::json!({
        "start": window.start,
        "end": window.end,
        "length": window.length,
    }))
    .map_err(|error| error.to_string())?;
    body.push(b'\n');
    body.extend_from_slice(&window.data);
    Ok(tauri::ipc::Response::new(body))
}

#[tauri::command]
pub(crate) async fn read_session_history(app: AppHandle, id: String, task_slug: Option<String>, offset: Option<u64>, limit: Option<u64>) -> Result<tauri::ipc::Response, String> {
    // Replay reads up to 8 MB. Returning `Vec<u8>` would JSON-encode that as a number array
    // on the main thread — the same cost `read_session_omp` already avoids with `Response`.
    let target = active_repo_ref()?;
    let slug = task_slug.unwrap_or_default();
    let data = tauri::async_runtime::spawn_blocking(move || match target {
        RepoRef::Local(repo) => alinery_core::read_session_history(&repo, &slug, &id, offset, limit).map(|result| result.data),
        RepoRef::Remote { host_id, path } => remote_call::<alinery_core::repo_service::WireBytes>(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::ReadSessionHistory {
                repo: path.into(),
                slug,
                session_id: id,
                offset,
                limit,
            },
        )
        .map(|wire| wire.data),
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(tauri::ipc::Response::new(data))
}
