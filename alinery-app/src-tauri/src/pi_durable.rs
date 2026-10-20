//! Vinculum process supervision.
//!
//! The UI socket is `alinery-pi-daemon`. `alinery-playbook` is the helper beside it.
//! Nothing in this module starts release `alineryd`.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use alinery_core::daemon_client::{self, configure_detached_process, configure_host_guard_environment};
use alinery_core::{playbook_client, playbook_socket_path};

use crate::daemon::{alineryd_socket_namespace, canonical_host_executable, connect_current_daemon};
use crate::paths::app_config_path;
use crate::state::AppState;

pub(crate) enum HelperSupervision {
    RestartHelperOnly,
    RestartPair,
    Leave,
}

/// Helper liveness is not a poller input. The supervisor calls this after its own probe.
pub(crate) fn helper_supervision(ui_socket_up: bool, helper_up: bool) -> HelperSupervision {
    if !ui_socket_up {
        HelperSupervision::RestartPair
    } else if !helper_up {
        HelperSupervision::RestartHelperOnly
    } else {
        HelperSupervision::Leave
    }
}

fn grok_key(app_config: &Path) -> String {
    alinery_core::load_global_settings(app_config).experiments.grok_api_key
}

static PI_LAUNCH_TOKEN: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{:x}-{:x}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    )
});

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
        let candidate = directory.join(name);
        if candidate.is_file() {
            return Some(candidate);
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

fn helper_call(repo: &Path, request: &Value) -> Result<Value, String> {
    let path = playbook_socket_path(repo, alineryd_socket_namespace().as_deref());
    let mut stream = UnixStream::connect(&path).map_err(|error| format!("playbook helper: {error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    writeln!(stream, "{request}").map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).map_err(|error| error.to_string())?;
    serde_json::from_str(line.trim()).map_err(|error| error.to_string())
}

fn stop_helper(repo: &Path) -> Result<(), String> {
    let path = playbook_socket_path(repo, alineryd_socket_namespace().as_deref());
    if UnixStream::connect(&path).is_err() {
        return Ok(());
    }
    let _ = helper_call(repo, &playbook_client::stop_request());
    for _ in 0..40 {
        if UnixStream::connect(&path).is_err() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("playbook helper did not exit".into())
}

fn start_helper(repo: &Path, app_config: &Path) -> Result<(), String> {
    let binary = resolve_alongside("alinery-playbook").ok_or("alinery-playbook binary not found beside the app")?;
    spawn_detached(&binary, repo, app_config, &[("ALINERY_PI_LAUNCH_TOKEN", PI_LAUNCH_TOKEN.as_str())])
}

fn start_pi_daemon(repo: &Path, app_config: &Path) -> Result<(), String> {
    let binary = resolve_alongside("alinery-pi-daemon").ok_or("alinery-pi-daemon binary not found beside the app")?;
    let library = ownership_library().ok_or("ownership library not found beside the app")?;
    let library = library.to_string_lossy().into_owned();
    let mut env = vec![("ALINERY_PI_LAUNCH_TOKEN", PI_LAUNCH_TOKEN.clone()), ("ALINERY_OWNERSHIP_LIB", library)];
    let key = grok_key(app_config);
    let key = key.trim();
    if !key.is_empty() {
        env.push(("XAI_API_KEY", key.to_string()));
    }
    let borrowed: Vec<(&str, &str)> = env.iter().map(|(key, value)| (*key, value.as_str())).collect();
    spawn_detached(&binary, repo, app_config, &borrowed)
}

/// Stop a leftover helper, then start the helper and the UI daemon. Does not start release `alineryd`.
pub(crate) fn start_prototype_pair(repo: &Path, app_config: &Path) -> Result<(), String> {
    let _ = stop_helper(repo);
    start_helper(repo, app_config)?;
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
            let ui_up = connect_current_daemon(&repo).is_ok();
            let helper_up = UnixStream::connect(playbook_socket_path(&repo, alineryd_socket_namespace().as_deref())).is_ok();
            match helper_supervision(ui_up, helper_up) {
                HelperSupervision::Leave => {}
                HelperSupervision::RestartHelperOnly => {
                    let _ = start_helper(&repo, &app_config);
                }
                HelperSupervision::RestartPair => {
                    let _ = restart_pair(&state, &repo, &app_config);
                }
            }
        }
    });
}
