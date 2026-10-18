//! Experimental Pi Durable process switch.
//!
//! This is a deliberate teardown origin. It is not `stop_daemon`: that command always
//! restarts the release daemon. Enable stops release `alineryd`, then starts the helper,
//! then starts `alinery-pi-daemon`. Disable reverses that and restarts release through
//! the existing spawn.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use alinery_core::daemon_client::{self, configure_detached_process, configure_host_guard_environment};
use alinery_core::{playbook_client, playbook_socket_path, poller_action, DaemonCompat, PollerAction};

use crate::app_config::load_app_config;
use crate::daemon::{alineryd_socket_namespace, attach_repo_daemon_locked, canonical_host_executable, connect_current_daemon, takeover_allowed};
use crate::paths::{active_repo, app_config_path, validate_known_target_repo};
use crate::state::{AppState, ClosingGuard};

pub(crate) enum TogglePoll {
    Release(PollerAction),
    RestartPair,
    Leave,
}

pub(crate) fn experimental_poller_decision(toggle_on: bool, compat: Option<DaemonCompat>) -> TogglePoll {
    if !toggle_on {
        return TogglePoll::Release(poller_action(compat));
    }
    match poller_action(compat) {
        PollerAction::Spawn => TogglePoll::RestartPair,
        PollerAction::Leave | PollerAction::SurfaceConflict => TogglePoll::Leave,
    }
}

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

pub(crate) trait PiSwitchOps {
    fn validate(&mut self) -> Result<(), String>;
    fn reserve(&mut self) -> Result<(), String>;
    fn mark_closing(&mut self) -> Result<(), String>;
    fn wait_socket_gone(&mut self) -> Result<(), String>;
    fn persist_flag(&mut self, enabled: bool) -> Result<(), String>;
    fn stop_helper(&mut self) -> Result<(), String>;
    fn start_helper(&mut self) -> Result<(), String>;
    fn start_pi_daemon(&mut self) -> Result<(), String>;
    fn start_release(&mut self) -> Result<(), String>;
    fn drop_closing(&mut self);
}

pub(crate) fn run_experimental_switch(enable: bool, ops: &mut dyn PiSwitchOps, shutdown_ui: &mut dyn FnMut() -> Result<(), String>) -> Result<(), String> {
    ops.validate()?;
    ops.reserve()?;
    ops.mark_closing()?;
    let result = (|| {
        shutdown_ui()?;
        ops.wait_socket_gone()?;
        ops.persist_flag(enable)?;
        if enable {
            ops.start_helper()?;
            ops.start_pi_daemon()
        } else {
            ops.stop_helper()?;
            ops.start_release()
        }
    })();
    ops.drop_closing();
    result
}

fn pi_durable_enabled(app_config: &Path) -> bool {
    alinery_core::load_global_settings(app_config).experiments.pi_durable
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

fn restart_pair(state: &AppState, repo: &Path, app_config: &Path) -> Result<(), String> {
    let _ = stop_helper(repo);
    start_helper(repo, app_config)?;
    start_pi_daemon(repo, app_config)?;
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
        if !pi_durable_enabled(&app_config) {
            continue;
        }
        for repo in load_app_config(&app).known_repos.iter().map(PathBuf::from) {
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

struct LiveSwitch<'a> {
    state: &'a AppState,
    app: &'a AppHandle,
    repo: PathBuf,
    app_config: PathBuf,
    closing: Option<ClosingGuard<'a>>,
}

impl PiSwitchOps for LiveSwitch<'_> {
    fn validate(&mut self) -> Result<(), String> {
        takeover_allowed(self.state, &self.repo)?;
        validate_known_target_repo(&load_app_config(self.app).known_repos, &self.repo.display().to_string()).map(|_| ())
    }
    fn reserve(&mut self) -> Result<(), String> {
        let reservation = self.state.reserve_repo(&self.repo)?.ok_or("repo-busy: another Alinery window owns this project")?;
        reservation.commit(self.state);
        Ok(())
    }
    fn mark_closing(&mut self) -> Result<(), String> {
        self.closing = Some(self.state.mark_closing(&self.repo));
        Ok(())
    }
    fn wait_socket_gone(&mut self) -> Result<(), String> {
        daemon_client::wait_for_daemon_gone(&self.repo, alineryd_socket_namespace().as_deref().unwrap_or(""))
    }
    fn persist_flag(&mut self, enabled: bool) -> Result<(), String> {
        let mut settings = alinery_core::load_global_settings(&self.app_config);
        settings.experiments.pi_durable = enabled;
        alinery_core::write_global_settings(&self.app_config, &settings)
    }
    fn stop_helper(&mut self) -> Result<(), String> {
        stop_helper(&self.repo)
    }
    fn start_helper(&mut self) -> Result<(), String> {
        start_helper(&self.repo, &self.app_config)
    }
    fn start_pi_daemon(&mut self) -> Result<(), String> {
        start_pi_daemon(&self.repo, &self.app_config)
    }
    fn start_release(&mut self) -> Result<(), String> {
        let lifecycle = self.state.repo_lifecycle(&self.repo);
        let guard = lifecycle.lock().unwrap_or_else(|error| error.into_inner());
        attach_repo_daemon_locked(self.state, &self.repo, &self.app_config, &guard);
        Ok(())
    }
    fn drop_closing(&mut self) {
        self.closing.take();
    }
}

// DELIBERATE TEARDOWN ORIGIN. Settings switches this repo between the release daemon
// and the experimental pair. Not `stop_daemon`, and not a caller of `close_repo_daemon`.
fn switch_pi_durable_blocking(app: &AppHandle, enabled: bool) -> Result<alinery_core::GlobalSettings, String> {
    let state = app.state::<AppState>();
    let repo = active_repo()?;
    takeover_allowed(&state, &repo)?;
    let app_config = app_config_path(app)?;
    let mut live = LiveSwitch {
        state: &state,
        app,
        repo: repo.clone(),
        app_config: app_config.clone(),
        closing: None,
    };
    run_experimental_switch(enabled, &mut live, &mut || {
        if let Ok(daemon) = connect_current_daemon(&repo) {
            daemon.call(&daemon_client::shutdown_request()).map(|_| ())?;
        }
        Ok(())
    })?;
    state.clear_daemon(&repo);
    Ok(alinery_core::load_global_settings(&app_config))
}

#[tauri::command]
pub(crate) async fn switch_pi_durable(app: AppHandle, enabled: bool) -> Result<alinery_core::GlobalSettings, String> {
    tauri::async_runtime::spawn_blocking(move || switch_pi_durable_blocking(&app, enabled))
        .await
        .map_err(|error| format!("switch pi durable task: {error}"))?
}

pub(crate) fn poller_should_spawn_release(toggle_on: bool, action: PollerAction) -> bool {
    !toggle_on && matches!(action, PollerAction::Spawn)
}
