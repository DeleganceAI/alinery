//! session: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

pub(crate) use alinery_core::session_actions::mark_exit_notification_read as mark_session_exit_notification_read_in;
// The daemon's SessionService marks notifications read; the file-level original stays as the reference its conformance test runs.
#[cfg(test)]
pub(crate) use alinery_core::session_actions::mark_notification_read as mark_session_notification_read_in;
pub(crate) use alinery_core::SessionMeta;

// Only the tests build the meta path now (the daemon resolves its own); keep it as the
// canonical helper so a test and the daemon can't drift.
#[cfg(test)]
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

pub(crate) fn hosted_refresh_needed(harness: &str, model: &str) -> bool {
    alinery_core::is_vinculum_session(harness) && (model.trim().is_empty() || is_hosted_model(model))
}

/// Refresh hosted inference inside the one-hour renewal lead. Vinculum is the only daemon.
pub(crate) const PI_DURABLE_HOSTED_REFRESH: Duration = Duration::from_secs(30 * 60);

pub(crate) fn spawn_pi_hosted_refresh(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(PI_DURABLE_HOSTED_REFRESH);
        let Ok(app_config) = app_config_path(&app) else { continue };
        let _ = alinery_core::ensure_hosted_inference_for_spawn(&app_config);
        crate::remote::push_hosted_inference_to_hosts(&app);
    });
}

pub(crate) async fn refresh_hosted_inference_before_open(app: AppHandle, harness: &str, model: &str) -> Result<(), String> {
    if !hosted_refresh_needed(harness, model) {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        refresh_hosted_inference_for_spawn(&app)?;
        // A remote repo's daemon reads the token on its own host: hand it the fresh one before it spawns (a failure is
        // logged there). Only the active repo's host waits here; the 30-minute refresh and each connect cover the rest.
        if let Ok(RepoRef::Remote { host_id, .. }) = active_repo_ref() {
            crate::remote::push_hosted_inference(&app, &host_id);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Hosted inference is refreshed on this machine before the daemon spawns a hosted-model session or chat thread: the daemon
/// reads the credential the refresh writes, and the webview asks for it before CreateChatThread / StartChatThread and before it
/// spawns or resumes a session (`harness` is a hint for that refresh and nothing else; unset means the default harness).
#[tauri::command]
pub(crate) async fn prepare_hosted_inference(app: AppHandle, model: String, harness: Option<String>) -> Result<(), String> {
    refresh_hosted_inference_before_open(app, harness.as_deref().unwrap_or(alinery_core::DEFAULT_HARNESS_KEY), &model).await
}
