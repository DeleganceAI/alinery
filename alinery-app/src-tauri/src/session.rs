//! session: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

pub(crate) use alinery_core::session_actions::{
    mark_exit_notification_read as mark_session_exit_notification_read_in, mark_notification_read as mark_session_notification_read_in,
};
pub(crate) use alinery_core::SessionMeta;

#[tauri::command]
pub(crate) async fn rename_session<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    repo_path: String,
    task_slug: String,
    session_id: String,
    name: String,
) -> Result<alinery_core::SessionName, String> {
    let target = target_repo_ref_for_app(&app, &repo_path)?;
    if let RepoRef::Local(repo) = &target {
        require_repo_owned(&state, repo)?;
    }
    off_main_thread("rename session", move || match target {
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::RenameSession {
                repo: path.into(),
                slug: task_slug,
                session_id,
                name,
            },
        ),
        RepoRef::Local(repo) => Ok(alinery_core::set_session_name(&repo, &task_slug, &session_id, &name, alinery_core::SessionNameSource::User)?.value),
    })
    .await
}

pub(crate) use alinery_core::session_actions::{clear_session_notifications_in, SessionNotificationClearRef};

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
pub(crate) async fn mark_session_notification_read(app: AppHandle, state: State<'_, AppState>, repo_path: String, task_slug: String, id: String) -> Result<(), String> {
    let target = target_repo_ref_for_app(&app, &repo_path)?;
    if let RepoRef::Local(repo) = &target {
        require_repo_owned(&state, repo)?;
    }
    off_main_thread("mark session notification read", move || match target {
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::MarkSessionNotificationRead {
                repo: path.into(),
                slug: task_slug,
                session_id: id,
            },
        ),
        RepoRef::Local(repo) => mark_session_notification_read_in(&repo, &task_slug, &id),
    })
    .await
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
pub(crate) async fn ensure_drawer_terminal(state: State<'_, AppState>) -> Result<SessionMeta, String> {
    let daemon = repo_client(&state, &active_repo_ref()?)?;
    off_main_thread("drawer terminal", move || {
        let reply = daemon.create_execution_session(&alinery_core::task_creation::CreateExecutionSessionRequest {
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
    })
    .await
}

// Start a session: spawn (or resume) a harness in `cwd` unless its pty is still running. The bytes
// are not this command's business: the webview attaches with TerminalService.Attach, so a session
// keeps running in the background and switching back shows the same process at its current screen.
// Distinct ids coexist: the "bag of cheap sessions", many ptys alive at once.
// The gate (a root session is only the drawer terminal; a task must exist, be v2 and not be a draft or archived; the
// session's harness must be launchable) is the daemon's: it runs it on the spawn, attach and resume ops, from the
// session's own meta (`domain/openPreflight.ts`). The shell keeps the hosted-inference refresh, which needs a harness
// and a model before the daemon is asked; the caller passes them (`harness` is a hint for that refresh and nothing else).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn open_session(
    app: AppHandle,
    id: String,
    cwd: String,
    task_slug: Option<String>,
    phase: Option<String>,
    model: Option<String>,
    harness: Option<String>,
    intent: Option<String>,
    resume_token: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<(), String> {
    let intent = intent.unwrap_or_else(|| daemon_client::ops::SPAWN.to_string());
    if !daemon_client::is_known_open_intent(&intent) {
        return Err(format!("unknown session intent '{intent}'"));
    }
    let slug = task_slug.unwrap_or_default().trim().to_string();
    let harness = harness.unwrap_or_default();
    let session_model = model.clone().unwrap_or_default();
    refresh_hosted_inference_before_open(app.clone(), &intent, &harness, &session_model).await?;
    off_main_thread("open session", move || {
        let daemon = app.state::<AppState>().daemon().ok_or("daemon not connected")?;
        daemon.resume_session(&daemon_client::OpenRequest {
            intent: &intent,
            id: &id,
            cwd: &cwd,
            task_slug: Some(&slug),
            phase: phase.as_deref(),
            model: model.as_deref(),
            resume_token: resume_token.as_deref(),
            cols,
            rows,
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn prepare_review_approval_prompt(
    app: AppHandle,
    state: State<'_, AppState>,
    task_slug: String,
    review_artifact: String,
) -> Result<PreparedSessionMessageAction, String> {
    let target = require_active_target(&state)?;
    off_main_thread("prepare review approval", move || match target {
        ActiveRepo::Local(repo) => prepare_review_approval_prompt_for(&repo, &task_slug, &review_artifact),
        ActiveRepo::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::PrepareReviewApprovalPrompt {
                repo: path.into(),
                slug: task_slug,
                review_artifact,
            },
        ),
    })
    .await
}

#[tauri::command]
pub(crate) async fn finalize_session_message_actions(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    task_slug: String,
    actions: Vec<SessionMessageActionProvenance>,
) -> Result<(), String> {
    let target = require_active_target(&state)?;
    off_main_thread("finalize message actions", move || match target {
        ActiveRepo::Local(repo) => finalize_session_message_actions_for(&repo, &id, &task_slug, &actions),
        ActiveRepo::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::FinalizeSessionMessageActions {
                repo: path.into(),
                slug: task_slug,
                session_id: id,
                actions,
            },
        ),
    })
    .await
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
