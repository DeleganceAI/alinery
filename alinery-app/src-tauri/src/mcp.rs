//! mcp: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

// R2: spawn (or reuse) the managed MCP child for the active repo: the daemon binary in `--mcp --serve --managed` mode (S5.1, O10 b).
// The child lives only as long as the app (or until repo switch). It is killed on app exit.
//
// It calls each daemon over its RPC socket with an AGENT token this app mints (O20 c) and keeps in an owner-only endpoints file the
// child re-reads on every call, so a repository opened or a daemon restarted after the child started is found without restarting it.
pub(crate) fn ensure_mcp_server<R: tauri::Runtime>(app: &AppHandle<R>, repo: &Path, restart: bool) {
    // Selection stays stable through check/stop/spawn. A stale caller for A must
    // never terminate B's MCP after a concurrent repository switch.
    let active = active_repo_cell().read().unwrap_or_else(|error| error.into_inner());
    if active.as_deref() != Some(repo) {
        return;
    }
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    state.set_mcp_error(None);
    let config = load_app_config(app);
    if !config.mcp_enabled {
        state.kill_mcp();
        return;
    }
    refresh_mcp_endpoints_in_background(app, config.known_repos, restart);

    // Hold the mcp_child lock across the whole check-spawn-store sequence. Callers
    // (one poller per visible task card, per-3s) can fire concurrently on Kanban/list
    // mount; without a single critical section they'd all observe "no live child yet"
    // before the first spawn finishes storing its child, racing each other into
    // spawning duplicate MCP processes (the "spawned managed alinery-mcp" log loop).
    let mut guard = state.mcp_child.lock().unwrap_or_else(|e| e.into_inner());
    if restart {
        if let Some(mut managed) = guard.take() {
            AppState::stop_mcp_child(&mut managed);
        }
    }
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
    let Some(mcp_path) = mcp_binary_path() else {
        state.set_mcp_error(Some("alinery-vinculum-daemon binary not found — restart the app (npm run tauri dev rebuilds it)".into()));
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
    cmd.args(mcp_host_args(&app_config, ns_ref)).arg("--repo").arg(repo).arg("--serve").arg("--managed");
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
/// The MCP server is the Vinculum daemon binary beside the app, started with `--mcp`.
pub(crate) fn mcp_binary_path() -> Option<PathBuf> {
    crate::pi_durable::resolve_alongside("alinery-vinculum-daemon")
}

/// Where the AGENT tokens the managed MCP uses are kept, one file per lane like the sockets.
pub(crate) fn mcp_endpoints_path(app_config: &Path, ns: Option<&str>) -> Option<PathBuf> {
    let dir = alinery_core::app_config_dir_of(app_config)?;
    Some(dir.join(match ns {
        Some(n) if !n.is_empty() => format!("mcp-endpoints-{n}.json"),
        _ => "mcp-endpoints.json".into(),
    }))
}

/// The arguments that start this app's MCP over stdio for a host (Claude Desktop and the like) that runs it itself: the same endpoints file, so the
/// host's MCP reaches the daemons of the repositories this app has open. The host does not get `alinery_send_review_handoff` (O22 a).
pub(crate) fn mcp_host_args(app_config: &Path, ns: Option<&str>) -> Vec<String> {
    let mut args = vec!["--mcp".to_string(), "--app-config".into(), app_config.to_string_lossy().into_owned()];
    if let Some(file) = mcp_endpoints_path(app_config, ns) {
        args.push("--endpoints-file".into());
        args.push(file.to_string_lossy().into_owned());
    }
    args
}

const MCP_ENDPOINT_LABEL: &str = "alinery-managed-mcp";
const MCP_ENDPOINTS_REFRESH: Duration = Duration::from_secs(30);

/// `{"version":1,"repos":{<repo>:{"socket","token"}}}`, owner-only and written whole, the shape `vinculum-daemon/src/mcpServer/endpoints.ts` reads.
pub(crate) fn write_mcp_endpoints(path: &Path, repos: &std::collections::BTreeMap<String, (PathBuf, String)>) -> Result<(), String> {
    let repos: serde_json::Map<String, Value> = repos
        .iter()
        .map(|(repo, (socket, token))| (repo.clone(), serde_json::json!({ "socket": socket.to_string_lossy(), "token": token })))
        .collect();
    let body = serde_json::to_vec(&serde_json::json!({ "version": 1, "repos": repos })).map_err(|e| e.to_string())?;
    alinery_core::write_owner_only_bytes(path, &body)
}

/// One AGENT token for each local repository whose daemon answers, and the endpoints file written from them. A remote repository is left out: MCP is
/// on the daemon's host only (O20 c). Blocking. Returns how many tokens were minted.
fn refresh_mcp_endpoints(app_config: &Path, known_repos: &[String]) -> Result<usize, String> {
    let dir = alinery_core::app_config_dir_of(app_config).ok_or("app config root unavailable")?;
    let ns = alineryd_socket_namespace();
    let mut endpoints = std::collections::BTreeMap::new();
    for repo in known_repos {
        if !matches!(RepoRef::parse(repo), Ok(RepoRef::Local(_))) {
            continue;
        }
        let Ok((socket, secret)) = crate::daemon_rpc::resolve(repo, dir, ns.as_deref()) else {
            continue;
        };
        if !socket.exists() {
            continue;
        }
        let minted = tauri::async_runtime::block_on(async {
            let admin = crate::daemon_rpc::rpc_token(&socket, &secret).await?;
            crate::daemon_rpc::mint_agent_token(&socket, &admin, MCP_ENDPOINT_LABEL).await
        });
        if let Ok(token) = minted {
            endpoints.insert(repo.clone(), (socket, token));
        }
    }
    let path = mcp_endpoints_path(app_config, ns.as_deref()).ok_or("app config root unavailable")?;
    write_mcp_endpoints(&path, &endpoints)?;
    Ok(endpoints.len())
}

/// Mints again at most every 30 s (a restarted daemon forgets its tokens; `force` is for the callers that just restarted one), off the calling
/// thread because a daemon that does not answer costs ten seconds.
fn refresh_mcp_endpoints_in_background<R: tauri::Runtime>(app: &AppHandle<R>, known_repos: Vec<String>, force: bool) {
    static STATE: Mutex<(Option<Instant>, bool)> = Mutex::new((None, false));
    {
        let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
        let fresh = state.0.is_some_and(|at| at.elapsed() < MCP_ENDPOINTS_REFRESH);
        if state.1 || (fresh && !force) {
            return;
        }
        state.1 = true;
    }
    let Ok(app_config) = app_config_path(app) else {
        STATE.lock().unwrap_or_else(|e| e.into_inner()).1 = false;
        return;
    };
    std::thread::spawn(move || {
        let minted = refresh_mcp_endpoints(&app_config, &known_repos);
        let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
        state.1 = false;
        // A refresh that reached no daemon (none started yet) is tried again on the next call.
        state.0 = matches!(minted, Ok(n) if n > 0).then(Instant::now);
    });
}

#[derive(serde::Serialize)]
pub(crate) struct McpStatus {
    pub(crate) enabled: bool,
    pub(crate) running: bool,
    pub(crate) clients: u32,
    pub(crate) socket_reachable: bool,
    pub(crate) binary_found: bool,
    pub(crate) binary_path: String,
    /// What follows `binary_path` in a host's stdio config (`--mcp ...`).
    pub(crate) host_args: Vec<String>,
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
    let binary_path = mcp_binary_path().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let host_args = app_config_path(app)
        .map(|path| mcp_host_args(&path, alineryd_socket_namespace().as_deref()))
        .unwrap_or_default();
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
        host_args,
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
    ensure_mcp_server(&app, &repo, false);
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
