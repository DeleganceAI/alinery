//! Taskless OMP chat threads. The rail, the thread writes, the turn controls and the attachments are the daemon's ChatService
//! (`vinculum-daemon/src/rpc/chat.ts`); what stays here is which repos Chat may use.
use crate::*;

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
            ready && !state.is_closing(repo) && state.daemon_attached(repo)
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
