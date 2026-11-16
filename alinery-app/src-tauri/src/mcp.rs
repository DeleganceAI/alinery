//! mcp: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

// The shell starts no MCP of its own: every daemon it starts registers with this machine's MCP (docs/machine-mcp-plan.md), and a host
// such as Claude Desktop runs the stdio bridge to it. What is left here is that config and the confirmed Force restart (M3).
/// The MCP server is the Vinculum daemon binary beside the app, started with `--mcp`.
pub(crate) fn mcp_binary_path() -> Option<PathBuf> {
    crate::pi_durable::resolve_alongside("alinery-vinculum-daemon")
}

/// The arguments that start this app's MCP over stdio for a host (Claude Desktop and the like) that runs it itself: the stdio bridge to the
/// machine MCP (docs/machine-mcp-plan.md 4.5), which reaches every daemon on this machine that registered with it, the app open or not.
pub(crate) fn mcp_host_args(app_config: &Path, ns: Option<&str>) -> Vec<String> {
    let mut args = vec!["--mcp".to_string(), "--bridge".into(), "--app-config".into(), app_config.to_string_lossy().into_owned()];
    if let Some(ns) = ns.filter(|ns| !ns.is_empty()) {
        args.push("--socket-namespace".into());
        args.push(ns.into());
    }
    args
}

/// The machine MCP's socket for this lane, `machine-mcp[-ns].sock` in the app-config directory (`mcpServer/machine.ts` `machinePaths`).
pub(crate) fn machine_mcp_socket(app_config: &Path, ns: Option<&str>) -> Option<PathBuf> {
    let clean: String = ns.unwrap_or("").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').take(48).collect();
    let stem = if clean.is_empty() { "machine-mcp".to_string() } else { format!("machine-mcp-{clean}") };
    Some(alinery_core::app_config_dir_of(app_config)?.join(format!("{stem}.sock")))
}

/// The process answering a socket, as the kernel reports it (`LOCAL_PEERPID` / `SO_PEERCRED`), never a pid file.
#[cfg(unix)]
pub(crate) fn socket_peer(socket: &Path) -> Result<alinery_core::legacy_daemon::PeerProcessIdentity, String> {
    let stream = UnixStream::connect(socket).map_err(|error| format!("nothing answers at {}: {error}", socket.display()))?;
    alinery_core::legacy_daemon::peer_process_identity(&stream)
}

/// M3's Force restart, second half: SIGTERM to the machine MCP only if the process answering its socket is still the incarnation the
/// user confirmed. The machine MCP installs no SIGTERM handler, so even a wedged loop ends; the next daemon registration starts a new one.
#[cfg(unix)]
pub(crate) fn force_restart_peer(socket: &Path, expected: &str) -> Result<(), String> {
    let peer = socket_peer(socket)?;
    if peer.incarnation() != expected {
        return Err("the MCP answering its socket changed since you confirmed; look again".into());
    }
    // DELIBERATE: the user's confirmed Force restart of the machine MCP (check-no-auto-session-kill.sh). It holds no session.
    peer.terminate()
}

fn this_lane_machine_socket(app: &AppHandle) -> Result<PathBuf, String> {
    machine_mcp_socket(&app_config_path(app)?, alineryd_socket_namespace().as_deref()).ok_or_else(|| "app config root unavailable".into())
}

/// M3's Force restart, first half: which process incarnation answers this lane's machine MCP socket, for the confirmation to name and bind.
#[tauri::command]
pub(crate) async fn machine_mcp_peer(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(socket_peer(&this_lane_machine_socket(&app)?)?.incarnation()))
        .await
        .map_err(|error| format!("machine MCP peer task: {error}"))?
}

#[tauri::command]
pub(crate) async fn force_restart_machine_mcp(app: AppHandle, incarnation: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || force_restart_peer(&this_lane_machine_socket(&app)?, &incarnation))
        .await
        .map_err(|error| format!("machine MCP restart task: {error}"))?
}

/// What Settings needs for a host's stdio config: the binary and the arguments after it.
#[derive(serde::Serialize)]
pub(crate) struct McpStatus {
    pub(crate) binary_path: String,
    pub(crate) host_args: Vec<String>,
}

#[tauri::command]
pub(crate) async fn mcp_status(app: AppHandle) -> McpStatus {
    McpStatus {
        binary_path: mcp_binary_path().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        host_args: app_config_path(&app)
            .map(|path| mcp_host_args(&path, alineryd_socket_namespace().as_deref()))
            .unwrap_or_default(),
    }
}
