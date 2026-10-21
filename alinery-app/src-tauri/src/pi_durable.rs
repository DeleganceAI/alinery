//! Vinculum process supervision.
//!
//! The binary beside the app is `alinery-vinculum-daemon`. The UI socket stays
//! `alineryd.sock`, which is the path the app already opens. Nothing in this
//! module starts release `alineryd`.

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, Manager};

use alinery_core::daemon_client::{self, configure_detached_process, configure_host_guard_environment};

use crate::daemon::{alineryd_socket_namespace, canonical_host_executable, connect_current_daemon};
use crate::paths::app_config_path;
use crate::state::AppState;

fn grok_key(app_config: &Path) -> String {
    alinery_core::load_global_settings(app_config).experiments.grok_api_key
}

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

fn spawn_detached(binary: &Path, repo: &Path, app_config: &Path, extra_env: &[(&str, &str)]) -> Result<(), String> {
    let namespace = alineryd_socket_namespace();
    let host_executable = canonical_host_executable(std::env::current_exe());
    let mut command = Command::new(binary);
    command
        .arg("--repo")
        .arg(repo)
        .arg("--app-config")
        .arg(app_config)
        .arg("--build-id")
        .arg(binary.file_name().unwrap_or_default())
        .env("PATH", alinery_core::login_shell_path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    configure_host_guard_environment(&mut command, host_executable.as_deref());
    if let Some(namespace) = namespace.as_deref().filter(|value| !value.is_empty()) {
        command.arg("--socket-namespace").arg(namespace);
    }
    for (key, value) in extra_env {
        command.env(key, value);
    }
    configure_detached_process(&mut command);
    command.spawn().map(|_| ()).map_err(|error| format!("spawn {}: {error}", binary.display()))
}

fn start_pi_daemon(repo: &Path, app_config: &Path) -> Result<(), String> {
    let binary = resolve_alongside("alinery-vinculum-daemon").ok_or("alinery-vinculum-daemon binary not found beside the app")?;
    let library = ownership_library().ok_or("ownership library not found beside the app")?;
    let library = library.to_string_lossy().into_owned();
    let mut env = vec![("ALINERY_OWNERSHIP_LIB", library)];
    let key = grok_key(app_config);
    let key = key.trim();
    if !key.is_empty() {
        env.push(("XAI_API_KEY", key.to_string()));
    }
    let borrowed: Vec<(&str, &str)> = env.iter().map(|(key, value)| (*key, value.as_str())).collect();
    spawn_detached(&binary, repo, app_config, &borrowed)
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
            if !repo.is_dir() || state.is_closing(&repo) {
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
