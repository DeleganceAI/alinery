//! mcp: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

// R2: spawn (or reuse) a managed alinery-mcp child in --serve mode for the active repo.
// The child lives only as long as the app (or until repo switch). It is killed on app exit.
pub(crate) fn ensure_mcp_server(app: &AppHandle, repo: &Path) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    state.set_mcp_error(None);
    if !load_app_config(app).mcp_enabled {
        state.kill_mcp();
        return;
    }

    // Hold the mcp_child lock across the whole check-spawn-store sequence. Callers
    // (one poller per visible task card, per-3s) can fire concurrently on Kanban/list
    // mount; without a single critical section they'd all observe "no live child yet"
    // before the first spawn finishes storing its child, racing each other into
    // spawning duplicate alinery-mcp processes (the "spawned managed alinery-mcp" log loop).
    let mut guard = state.mcp_child.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(managed) = guard.as_mut() {
        if managed.repo == repo {
            match managed.child.try_wait() {
                Ok(None) => return, // still alive for this repo — nothing to do
                Ok(Some(_)) => *guard = None,
                Err(_) => {
                    AppState::stop_mcp_child(managed);
                    *guard = None;
                }
            }
        } else {
            AppState::stop_mcp_child(managed); // switching repos
            *guard = None;
        }
    }
    let _alinery = alinery_dir(repo);
    let ns = alineryd_socket_namespace();
    let ns_ref = ns.as_deref();
    let mcp_sock = alinery_core::mcp_socket_path(repo, ns_ref);
    let mcp_status = alinery_core::mcp_status_path(repo, ns_ref);
    // Delete only own-lane runtime files (#74) — but never out from under a live
    // listener. A force-quit/crashed app leaves its managed alinery-mcp orphaned; asking it
    // to exit first is what makes "relaunch → exactly one listener" true (E4).
    reap_mcp_listener(&mcp_sock);
    let _ = fs::remove_file(&mcp_status);
    let _ = fs::remove_file(&mcp_sock);
    let Some(mcp_path) = resolve_mcp_path() else {
        state.set_mcp_error(Some("alinery-mcp binary not found — restart the app (npm run tauri dev rebuilds it)".into()));
        return;
    };
    let app_config = match app_config_path(app) {
        Ok(path) => path,
        Err(error) => {
            state.set_mcp_error(Some(format!("alinery-mcp spawn failed: {error}")));
            return;
        }
    };
    let mut cmd = Command::new(&mcp_path);
    cmd.arg("--repo").arg(repo).arg("--app-config").arg(app_config).arg("--serve").arg("--managed");
    if let Some(n) = ns_ref {
        cmd.arg("--socket-namespace").arg(n);
    }
    match cmd
        .env("PATH", login_shell_path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(mut child) => {
            // Brief pause so a bad/stale binary exiting on startup is caught before status poll.
            std::thread::sleep(std::time::Duration::from_millis(200));
            match child.try_wait() {
                Ok(Some(status)) => {
                    state.set_mcp_error(Some(format!("alinery-mcp exited on startup ({status}) — restart the app to rebuild it")));
                }
                Ok(None) => {
                    *guard = Some(ManagedMcpChild { repo: repo.to_path_buf(), child });
                    eprintln!("R2: spawned managed alinery-mcp for {}", repo.display());
                }
                Err(e) => {
                    state.set_mcp_error(Some(format!("alinery-mcp status check failed: {e}")));
                    *guard = Some(ManagedMcpChild { repo: repo.to_path_buf(), child });
                }
            }
        }
        Err(e) => state.set_mcp_error(Some(format!("alinery-mcp spawn failed: {e}"))),
    }
}
// Locate the alinery-mcp binary: a sibling of the app exe (bundled via externalBin as `alinery-mcp` or
// `alinery-mcp-<triple>`), else the dev build under target/.
pub(crate) fn resolve_mcp_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if name == "alinery-mcp" || name.starts_with("alinery-mcp-") {
                return Some(e.path());
            }
        }
    }
    // dev: bare binary next to the cargo tauri dev exe in target/debug (script also populates tripled sidecar)
    let dev = dir.join("alinery-mcp");
    dev.exists().then_some(dev)
}

#[derive(serde::Serialize)]
pub(crate) struct McpStatus {
    pub(crate) enabled: bool,
    pub(crate) running: bool,
    pub(crate) clients: u32,
    pub(crate) socket_reachable: bool,
    pub(crate) binary_found: bool,
    pub(crate) binary_path: String,
    pub(crate) repo: String,
    pub(crate) socket_path: String,
    pub(crate) error: String,
}

// running = actual socket connect succeeds alone (#74: no kill -0 / file-exists shortcuts).

#[cfg(unix)]
pub(crate) fn mcp_socket_listening(path: &str) -> bool {
    !path.is_empty() && UnixStream::connect(path).is_ok()
}

#[cfg(not(unix))]
pub(crate) fn mcp_socket_listening(_path: &str) -> bool {
    false
}

pub(crate) fn mcp_status_inner(app: &AppHandle, state: &AppState) -> McpStatus {
    let app_cfg = load_app_config(app);
    let binary_path = resolve_mcp_path().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let binary_found = !binary_path.is_empty();
    let repo_s = active_repo_cell()
        .read()
        .ok()
        .and_then(|g| g.clone())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| app_cfg.active_repo.clone());
    let ns = alineryd_socket_namespace();
    let socket_path = if repo_s.is_empty() {
        String::new()
    } else {
        alinery_core::mcp_socket_path(Path::new(&repo_s), ns.as_deref()).to_string_lossy().into_owned()
    };
    // Reap exited managed child handle (does not drive "running").
    {
        let mut guard = state.mcp_child.lock().unwrap_or_else(|e| e.into_inner());
        let child_exited = match &mut *guard {
            Some(managed) => managed.child.try_wait().ok().flatten().is_some(),
            None => false,
        };
        if child_exited {
            *guard = None;
        }
    }
    let running = app_cfg.mcp_enabled && !socket_path.is_empty() && mcp_socket_listening(&socket_path);
    // Clients count is best-effort from status file when socket is live.
    let clients = if running && !repo_s.is_empty() {
        fs::read_to_string(alinery_core::mcp_status_path(Path::new(&repo_s), ns.as_deref()))
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| v.get("clients").and_then(|c| c.as_u64()).map(|n| n as u32))
            .unwrap_or(0)
    } else {
        0
    };

    McpStatus {
        enabled: app_cfg.mcp_enabled,
        running,
        clients,
        socket_reachable: running,
        binary_found,
        binary_path,
        repo: repo_s,
        socket_path,
        error: state.mcp_error(),
    }
}

#[tauri::command]
pub(crate) async fn mcp_status(app: AppHandle) -> McpStatus {
    let state = app.state::<AppState>();
    mcp_status_inner(&app, &state)
}

#[tauri::command]
pub(crate) fn start_mcp_server(app: AppHandle, state: State<'_, AppState>) -> Result<McpStatus, String> {
    let repo = active_repo()?;
    let mut cfg = load_app_config(&app);
    cfg.mcp_enabled = true;
    write_app_config(&app, &cfg)?;
    ensure_mcp_server(&app, &repo);
    emit(
        &app,
        alinery_core::TelemetryEvent::McpToggle {
            source: alinery_core::TelemetrySource::App,
            enabled: true,
        },
    );
    Ok(mcp_status_inner(&app, &state))
}

/// E4: ask whoever is listening on `sock` to exit, and wait until it stops answering.
///
/// The process that answers the socket is definitionally the listener to remove. We
/// never kill by the pid in `mcp.status.json` — pid reuse makes that a coin flip, and
/// identity-from-files is the antipattern #74 already deleted. A dead/stale socket file
/// simply refuses connect and costs nothing.
pub(crate) fn reap_mcp_listener(sock: &Path) {
    let Ok(mut stream) = UnixStream::connect(sock) else {
        return; // nothing listening — stale file, safe to unlink
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream.write_all(b"{\"op\":\"exit\"}\n").is_err() {
        return;
    }
    let _ = stream.flush();
    // Wait for the ack, then for the socket to go quiet: unlink only after that, never
    // out from under a live listener (the orphaning bug this fixes).
    let _ = read_socket_line(&mut stream);
    for _ in 0..40 {
        if UnixStream::connect(sock).is_err() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Remove this lane's MCP status sidecar + socket. Own-lane only (#119 RC-MCP-6).
/// A live listener is asked to exit first (E4) so we never orphan it. Returns the
/// (status, socket) paths it targeted.
pub(crate) fn remove_mcp_lane_runtime_files(repo: &Path, ns: Option<&str>) -> (PathBuf, PathBuf) {
    let status = alinery_core::mcp_status_path(repo, ns);
    let sock = alinery_core::mcp_socket_path(repo, ns);
    reap_mcp_listener(&sock);
    let _ = fs::remove_file(&status);
    let _ = fs::remove_file(&sock);
    (status, sock)
}

#[tauri::command]
pub(crate) fn stop_mcp_server(app: AppHandle, state: State<'_, AppState>) -> Result<McpStatus, String> {
    state.kill_mcp();
    if let Ok(repo) = active_repo() {
        remove_mcp_lane_runtime_files(&repo, alineryd_socket_namespace().as_deref());
    }
    let mut cfg = load_app_config(&app);
    cfg.mcp_enabled = false;
    write_app_config(&app, &cfg)?;
    emit(
        &app,
        alinery_core::TelemetryEvent::McpToggle {
            source: alinery_core::TelemetrySource::App,
            enabled: false,
        },
    );
    Ok(mcp_status_inner(&app, &state))
}
