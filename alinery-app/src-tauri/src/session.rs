//! session: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

pub(crate) use alinery_core::session_actions::mark_exit_notification_read as mark_session_exit_notification_read_in;
// The daemon's SessionService marks notifications read; the file-level original stays as the reference its conformance test runs.
#[cfg(test)]
pub(crate) use alinery_core::session_actions::mark_notification_read as mark_session_notification_read_in;
pub(crate) use alinery_core::SessionMeta;

// Only the tests build the meta path now (the daemon resolves its own); keep it as the
// canonical helper so a test and the daemon can't drift.
pub(crate) fn session_meta_path(repo: &Path, slug: &str, id: &str) -> PathBuf {
    let dir = if slug.is_empty() { root_sessions_dir(repo) } else { sessions_dir(repo, slug) };
    dir.join(format!("{id}.meta.json"))
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

/// Hosted inference is refreshed on this machine before the daemon spawns a hosted-model chat thread: the daemon
/// reads the credential the refresh writes, and the webview asks for it before CreateChatThread / StartChatThread.
#[tauri::command]
pub(crate) async fn prepare_hosted_inference(app: AppHandle, model: String) -> Result<(), String> {
    refresh_hosted_inference_before_open(app, daemon_client::ops::SPAWN, alinery_core::DEFAULT_HARNESS_KEY, &model).await
}

/// Daemon socket I/O waits up to DAEMON_CONTROL_TIMEOUT (a daemon blocked writing a full OMP
/// stdin pipe can take that long). A sync command would run it on the main thread and freeze
/// the whole window; these run on the blocking pool instead.
pub(crate) async fn off_main_thread<T: Send + 'static>(what: &str, work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|error| format!("{what}: {error}"))?
}
