//! Vinculum process supervision.
//!
//! The binary beside the app is `alinery-vinculum-daemon`. The UI socket stays
//! `alineryd.sock`, which is the path the app already opens. Nothing in this
//! module starts release `alineryd`.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use alinery_core::daemon_client::{self, daemon_command};

use crate::daemon::{alineryd_socket_namespace, canonical_host_executable, connect_current_daemon};
use crate::paths::{app_config_path, is_local_repo_dir};
use crate::state::AppState;

pub(crate) fn resolve_alongside(name: &str) -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let directory = executable.parent()?;
    let candidate = directory.join(name);
    candidate.is_file().then_some(candidate)
}

fn ownership_library() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let directory = executable.parent()?;
    for name in ["libalinery_core.dylib", "libalinery_core.so", "alinery_core.dll"] {
        for candidate in [directory.join(name), directory.join("../Resources/ownership").join(name)] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn start_pi_daemon(repo: &Path, app_config: &Path) -> Result<(), String> {
    let binary = resolve_alongside("alinery-vinculum-daemon").ok_or("alinery-vinculum-daemon binary not found beside the app")?;
    let library = ownership_library().ok_or("ownership library not found beside the app")?;
    let namespace = alineryd_socket_namespace();
    let host_executable = canonical_host_executable(std::env::current_exe());
    daemon_command(
        &binary,
        repo,
        app_config,
        binary.file_name().unwrap_or_default(),
        namespace.as_deref(),
        host_executable.as_deref(),
    )
    .env("ALINERY_OWNERSHIP_LIB", library)
    .spawn()
    .map(|_| ())
    .map_err(|error| format!("spawn {}: {error}", binary.display()))
}

/// Start Vinculum. Does not start release `alineryd`.
pub(crate) fn start_prototype_pair(repo: &Path, app_config: &Path) -> Result<(), String> {
    start_pi_daemon(repo, app_config)
}

fn restart_pair(state: &AppState, repo: &Path, app_config: &Path) -> Result<(), String> {
    start_prototype_pair(repo, app_config)?;
    if let Ok(client) = connect_current_daemon(repo) {
        if let Ok(version) = client.version_checked() {
            let identity = alinery_core::app_config_identity(app_config);
            let compat = daemon_client::classify_version_reply(&version, "", &identity);
            state.set_daemon(repo, client, compat, identity, version.host_guard_warning());
        }
    }
    Ok(())
}

pub(crate) fn restart_prototype_pair(state: &AppState, repo: &Path, app_config: &Path) -> Result<(), String> {
    restart_pair(state, repo, app_config)
}

pub(crate) fn spawn_pi_supervisor(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(crate::daemon::DAEMON_POLL_INTERVAL);
        let Some(state) = app.try_state::<AppState>() else { continue };
        if state.is_quitting() {
            continue;
        }
        let Ok(app_config) = app_config_path(&app) else { continue };
        for repo in crate::app_config::load_app_config(&app).known_repos.iter().map(PathBuf::from) {
            if !is_local_repo_dir(&repo) || state.is_closing(&repo) {
                continue;
            }
            let lifecycle = state.repo_lifecycle(&repo);
            let _guard = lifecycle.lock().unwrap_or_else(|error| error.into_inner());
            if state.is_quitting() || state.is_closing(&repo) {
                continue;
            }
            if connect_current_daemon(&repo).is_err() {
                let _ = restart_pair(&state, &repo, &app_config);
            }
        }
    });
}
