//! Taskless OMP chat threads. The rail, the thread writes and the attachments are the daemon's ChatService
//! (`vinculum-daemon/src/rpc/chat.ts`); what stays here is which repos Chat may use and the four turn controls
//! that still travel the legacy socket ops, each marked `chat` so the daemon refuses an id that is not a thread.
use crate::*;

/// Explicit-repo client. A miss does not consult the active daemon.
pub(crate) fn require_explicit_daemon<T>(explicit: Option<T>, active: impl FnOnce() -> Option<T>) -> Result<T, String> {
    if let Some(client) = explicit {
        return Ok(client);
    }
    let _active = active;
    Err("daemon not connected".into())
}

/// Chat shows only repos that are open in this window: this window holds the repo's GUI
/// flock, a daemon is connected for it, and no close is in flight. A repo another Alinery
/// holds, one whose daemon is stopped or conflicted, or one being closed drops out of the
/// rail with its threads, rather than listing threads every action on would refuse. A remote
/// repo is open while its host is connected and its daemon is attached.
pub(crate) fn open_chat_repos_in(known: &[String], state: &AppState) -> Vec<PathBuf> {
    known
        .iter()
        .map(PathBuf::from)
        .filter(|repo| {
            let ready = match RepoRef::parse(&repo.to_string_lossy()) {
                Ok(RepoRef::Remote { host_id, .. }) => connected_session(state, &host_id).is_ok(),
                _ => is_local_repo_dir(repo) && state.owns_repo(repo),
            };
            ready && !state.is_closing(repo) && state.daemon_for(repo).is_some()
        })
        .collect()
}

#[tauri::command]
pub(crate) fn list_chat_repos(app: AppHandle, state: State<'_, AppState>) -> Vec<String> {
    open_chat_repos_in(&load_app_config(&app).known_repos, &state)
        .into_iter()
        .map(|repo| repo.to_string_lossy().into_owned())
        .collect()
}

fn local_daemon(state: &AppState, repo: &Path) -> Result<DaemonClient, String> {
    require_explicit_daemon(state.daemon_for(repo), || state.daemon())
}

/// The daemon client of a thread's repo: its own socket, or the forward to its host.
fn chat_daemon(state: &AppState, target: &RepoRef) -> Result<DaemonClient, String> {
    match target {
        RepoRef::Local(repo) => local_daemon(state, repo),
        remote => repo_client(state, remote),
    }
}

#[tauri::command]
pub(crate) async fn chat_prompt(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String, text: String) -> Result<(), String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let daemon = chat_daemon(&state, &target)?;
    off_main_thread("chat prompt", move || daemon.chat_prompt(&id, &text)).await
}

#[tauri::command]
pub(crate) async fn chat_abort(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String) -> Result<(), String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let daemon = chat_daemon(&state, &target)?;
    off_main_thread("chat abort", move || daemon.chat_abort(&id)).await
}

#[tauri::command]
pub(crate) async fn chat_set_model(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    id: String,
    model: String,
) -> Result<alinery_core::daemon_client::SessionControls, String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let daemon = chat_daemon(&state, &target)?;
    off_main_thread("chat set model", move || daemon.chat_set_model(&id, &model)).await
}

#[tauri::command]
pub(crate) async fn chat_set_thinking_level(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    id: String,
    level: String,
) -> Result<alinery_core::daemon_client::SessionControls, String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let daemon = chat_daemon(&state, &target)?;
    off_main_thread("chat set thinking level", move || daemon.chat_set_thinking_level(&id, &level)).await
}
