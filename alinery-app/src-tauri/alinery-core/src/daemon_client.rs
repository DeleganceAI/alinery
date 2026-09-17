//! Shared alineryd wire, Unix transport, compatibility gate, and detached launcher.
//!
//! Every app and MCP request is built and every daemon-only reply field is parsed here.

use crate::{alineryd_socket_path, app_config_identity, daemon_compat, login_shell_path, DaemonCompat, ProcessState, SessionState, SessionTransport, PROTOCOL_VERSION};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

pub const DAEMON_OBSERVATION_TIMEOUT: Duration = Duration::from_millis(250);

// 250ms = passive observation that must never stall a poll (status/list/version).
// 100s  = control ops that legitimately do work before acking (spawn/kill/write/resize/
//         detach/shutdown + the open handshake). A wedge detector, not a latency
//         budget: a healthy ack is milliseconds.
pub const DAEMON_CONTROL_TIMEOUT: Duration = Duration::from_secs(100);

/// Serialized JSON bytes, excluding the trailing newline. Four 5 MiB images need
/// ~27 MiB of base64; even a 4 MiB caption escaped at 6x fits with JSON overhead.
pub const MAX_CONTROL_REQUEST_BYTES: usize = 64 * 1024 * 1024;

pub fn control_request_size_error() -> String {
    format!("request-too-large: encoded daemon request exceeds {MAX_CONTROL_REQUEST_BYTES} bytes (64 MiB); reduce the message or attachments")
}

// Formats a timeout for the "daemon not responding after ..." message: subsecond
// durations as milliseconds (`250ms`), everything else as whole seconds (`100s`, truncating
// any fractional remainder — the two constants above are the only values this ever sees).
pub fn format_daemon_timeout(timeout: Duration) -> String {
    if timeout < Duration::from_secs(1) {
        format!("{}ms", timeout.as_millis())
    } else {
        format!("{}s", timeout.as_secs())
    }
}

pub mod ops {
    pub const VERSION: &str = "version";
    pub const LIST: &str = "list";
    pub const SHUTDOWN: &str = "shutdown";
    pub const ATTACH: &str = "attach";
    pub const SPAWN: &str = "spawn";
    pub const RESUME: &str = "resume";
    pub const DETACH: &str = "detach";
    pub const WRITE: &str = "write";
    pub const SEND_MESSAGE: &str = "send_message";
    pub const RESIZE: &str = "resize";
    pub const STATUS: &str = "status";
    pub const KILL: &str = "kill";
    pub const RESTATE: &str = "restate";
    pub const RPC_ATTACH: &str = "rpc_attach";
    pub const RPC_WRITE: &str = "rpc_write";
    pub const OMP_SETUP: &str = "omp_setup";
}

pub fn is_known_open_intent(intent: &str) -> bool {
    matches!(intent, ops::ATTACH | ops::SPAWN | ops::RESUME)
}

pub fn version_request() -> Value {
    json!({"op": ops::VERSION})
}

pub fn list_request() -> Value {
    json!({"op": ops::LIST})
}

pub fn shutdown_request() -> Value {
    json!({"op": ops::SHUTDOWN})
}

pub fn write_request(id: &str, data: &str) -> Value {
    json!({"op": ops::WRITE, "id": id, "data": data})
}

pub fn send_message_header(id: &str, body_bytes: usize) -> Value {
    json!({"op": ops::SEND_MESSAGE, "id": id, "body_bytes": body_bytes})
}

pub fn resize_request(id: &str, cols: u16, rows: u16) -> Value {
    json!({"op": ops::RESIZE, "id": id, "cols": cols, "rows": rows})
}

pub fn kill_request(id: &str) -> Value {
    json!({"op": ops::KILL, "id": id})
}

pub fn status_request(id: &str) -> Value {
    json!({"op": ops::STATUS, "id": id})
}

pub fn detach_request(id: &str, attach_id: u64) -> Value {
    json!({"op": ops::DETACH, "id": id, "attach_id": attach_id})
}

pub fn spawn_request(id: &str, task_slug: &str) -> Value {
    json!({"op": ops::SPAWN, "id": id, "task_slug": task_slug})
}

pub fn restate_request(id: &str, transport: &str) -> Value {
    json!({"op": ops::RESTATE, "id": id, "transport": transport})
}

pub fn rpc_attach_request(id: &str, attach_id: u64) -> Value {
    json!({"op": ops::RPC_ATTACH, "id": id, "attach_id": attach_id})
}

pub fn rpc_write_request(id: &str, payload: &Value) -> Value {
    json!({"op": ops::RPC_WRITE, "id": id, "payload": payload})
}

/// Bring up (or reuse) the reserved setup session. Carries no id: the daemon owns the reserved
/// one and returns it, so the app cannot ask for a setup session under an id of its choosing.
pub fn omp_setup_request() -> Value {
    json!({"op": ops::OMP_SETUP})
}

pub struct OpenRequest<'a> {
    pub intent: &'a str,
    pub id: &'a str,
    pub cwd: &'a str,
    pub task_slug: Option<&'a str>,
    pub phase: Option<&'a str>,
    pub model: Option<&'a str>,
    pub attach_id: u64,
    pub resume_token: Option<&'a str>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

pub fn open_request(request: &OpenRequest<'_>) -> Value {
    json!({
        "op": request.intent,
        "id": request.id,
        "cwd": request.cwd,
        "task_slug": request.task_slug,
        "phase": request.phase,
        "model": request.model,
        "attach_id": request.attach_id,
        "resume_token": request.resume_token,
        "cols": request.cols,
        "rows": request.rows,
    })
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DaemonVersionReply {
    pub protocol: Option<u32>,
    pub build_id: Option<String>,
    pub app_config_identity: Option<String>,
    pub host_guard_ready: Option<bool>,
}

impl DaemonVersionReply {
    pub fn host_guard_warning(&self) -> bool {
        self.host_guard_ready != Some(true)
    }
}

pub fn classify_version_reply(reply: &DaemonVersionReply, app_build: &str, expected_app_config_identity: &str) -> DaemonCompat {
    daemon_compat(
        reply.protocol,
        reply.build_id.as_deref(),
        reply.app_config_identity.as_deref(),
        app_build,
        expected_app_config_identity,
    )
}

pub fn parse_version_reply(value: &Value) -> DaemonVersionReply {
    DaemonVersionReply {
        protocol: value.get("protocol").and_then(Value::as_u64).and_then(|protocol| u32::try_from(protocol).ok()),
        build_id: value.get("build_id").and_then(Value::as_str).map(String::from),
        app_config_identity: value.get("app_config_identity").and_then(Value::as_str).map(String::from),
        host_guard_ready: value.get("host_guard_ready").and_then(Value::as_bool),
    }
}

pub fn reply_error(value: &Value) -> Option<&str> {
    value.get("error").and_then(Value::as_str)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveSessionStatus {
    pub state: SessionState,
    pub transport: SessionTransport,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonSessionStatus {
    pub id: String,
    pub state: SessionState,
    pub transport: SessionTransport,
}

fn required_transport(value: &Value) -> Result<SessionTransport, String> {
    let Some(raw) = value.get("transport").and_then(Value::as_str) else {
        return Err("daemon status response is missing transport".into());
    };
    match raw {
        "pty" => Ok(SessionTransport::Pty),
        "rpc" => Ok(SessionTransport::Rpc),
        other => Err(format!("daemon status response has unknown transport '{other}'")),
    }
}

pub fn parse_list_reply(response: &Value) -> Result<Vec<DaemonSessionStatus>, String> {
    let sessions = response.get("sessions").and_then(Value::as_array).ok_or("daemon list response is missing sessions")?;
    sessions
        .iter()
        .map(|session| {
            let id = session
                .get("id")
                .and_then(Value::as_str)
                .ok_or("daemon list response has a session without an id")?
                .to_string();
            let transport = required_transport(session)?;
            let state = serde_json::from_value(session.clone()).map_err(|error| format!("daemon list response has an unparseable session state: {error}"))?;
            Ok(DaemonSessionStatus { id, state, transport })
        })
        .collect()
}

pub fn parse_status_reply(response: &Value) -> Result<Option<LiveSessionStatus>, String> {
    if let Some(error) = reply_error(response) {
        return if error == "unknown-session" { Ok(None) } else { Err(error.to_string()) };
    }
    let transport = required_transport(response)?;
    let state = serde_json::from_value(response.clone()).map_err(|error| format!("daemon status response has an unparseable session state: {error}"))?;
    Ok(Some(LiveSessionStatus { state, transport }))
}

// A peer that closes and a peer that never answers are different failures: the first is a
// dead daemon, the second a wedged one, and collapsing both into `None` produced "daemon
// closed" for a timeout.
#[derive(Debug, PartialEq, Eq)]
pub enum SocketReadError {
    Closed,
    TimedOut,
}

pub fn read_socket_line(stream: &mut UnixStream) -> Result<String, SocketReadError> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => return Err(SocketReadError::Closed),
            Ok(_) => {
                if byte[0] == b'\n' {
                    break;
                }
                line.push(byte[0]);
            }
            Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                return Err(SocketReadError::TimedOut);
            }
            Err(_) => return Err(SocketReadError::Closed),
        }
    }
    if line.is_empty() {
        return Err(SocketReadError::Closed);
    }
    Ok(String::from_utf8_lossy(&line).into_owned())
}

fn read_reply_line(stream: &mut UnixStream, timeout: Duration) -> Result<String, String> {
    read_socket_line(stream).map_err(|error| match error {
        SocketReadError::Closed => "daemon closed".to_string(),
        SocketReadError::TimedOut => format!("daemon not responding after {}", format_daemon_timeout(timeout)),
    })
}

fn format_socket_write_error(error: std::io::Error) -> String {
    if matches!(
        error.kind(),
        std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::NotConnected
    ) {
        "daemon closed".to_string()
    } else {
        error.to_string()
    }
}

#[derive(Clone, Debug)]
pub struct DaemonClient {
    pub socket_path: PathBuf,
}

impl DaemonClient {
    pub fn connect_local(repo: &Path) -> Result<Self, String> {
        Self::connect_path_checked(alineryd_socket_path(repo, None))
    }

    pub fn connect_path(socket_path: PathBuf) -> Result<Self, String> {
        Ok(Self { socket_path })
    }

    pub fn connect_path_checked(socket_path: PathBuf) -> Result<Self, String> {
        UnixStream::connect(&socket_path).map_err(|error| format!("daemon not running: {error}"))?;
        Ok(Self { socket_path })
    }

    // Timeouts are set before write_all so a wedged daemon can't hang the write side either.
    pub fn send(&self, request: &Value) -> Result<UnixStream, String> {
        self.send_with_timeout(request, DAEMON_CONTROL_TIMEOUT)
    }

    fn send_with_timeout(&self, request: &Value, timeout: Duration) -> Result<UnixStream, String> {
        let encoded = request.to_string();
        if encoded.len() > MAX_CONTROL_REQUEST_BYTES {
            return Err(control_request_size_error());
        }
        let mut stream = UnixStream::connect(&self.socket_path).map_err(|error| error.to_string())?;
        stream.set_read_timeout(Some(timeout)).map_err(|error| error.to_string())?;
        stream.set_write_timeout(Some(timeout)).map_err(|error| error.to_string())?;
        stream.write_all(encoded.as_bytes()).map_err(format_socket_write_error)?;
        stream.write_all(b"\n").map_err(format_socket_write_error)?;
        stream.flush().map_err(format_socket_write_error)?;
        Ok(stream)
    }

    pub fn call(&self, request: &Value) -> Result<Value, String> {
        let mut stream = self.send(request)?;
        let line = read_reply_line(&mut stream, DAEMON_CONTROL_TIMEOUT)?;
        serde_json::from_str(&line).map_err(|error| error.to_string())
    }

    pub fn call_with_timeout(&self, request: &Value, timeout: Duration) -> Result<Value, String> {
        let mut stream = self.send_with_timeout(request, timeout)?;
        let line = read_reply_line(&mut stream, timeout)?;
        serde_json::from_str(&line).map_err(|error| error.to_string())
    }

    pub fn version_checked(&self) -> Result<DaemonVersionReply, String> {
        self.call_with_timeout(&version_request(), DAEMON_OBSERVATION_TIMEOUT)
            .map(|value| parse_version_reply(&value))
    }

    pub fn version(&self) -> DaemonVersionReply {
        self.version_checked().unwrap_or_default()
    }

    pub fn live_session_count(&self) -> u32 {
        self.session_statuses_observed()
            .map(|sessions| {
                sessions
                    .iter()
                    .filter(|session| matches!(session.state.process, ProcessState::Starting | ProcessState::Alive))
                    .count() as u32
            })
            .unwrap_or(0)
    }

    pub fn detach_session(&self, id: &str, attach_id: u64) -> Result<(), String> {
        self.call(&detach_request(id, attach_id)).and_then(expect_ok)
    }

    pub fn write_session(&self, id: &str, data: &str) -> Result<(), String> {
        self.call(&write_request(id, data)).and_then(expect_ok)
    }

    pub fn send_message(&self, id: &str, body: &str) -> Result<(), String> {
        let mut stream = self.send(&send_message_header(id, body.len())).map_err(|error| unknown_message_delivery(&error))?;
        stream.write_all(body.as_bytes()).map_err(|error| unknown_message_delivery(&error.to_string()))?;
        stream.flush().map_err(|error| unknown_message_delivery(&error.to_string()))?;
        let line = read_socket_line(&mut stream).map_err(|error| match error {
            SocketReadError::Closed => unknown_message_delivery("daemon closed without a reply"),
            SocketReadError::TimedOut => unknown_message_delivery("daemon timed out without a reply"),
        })?;
        let response: Value = serde_json::from_str(&line).map_err(|error| unknown_message_delivery(&format!("malformed daemon reply: {error}")))?;
        expect_message_send(response)
    }

    pub fn resize_session(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.call(&resize_request(id, cols, rows)).and_then(expect_ok)
    }

    pub fn session_status_observed(&self, id: &str) -> Result<Option<LiveSessionStatus>, String> {
        let response = self.call_with_timeout(&status_request(id), DAEMON_OBSERVATION_TIMEOUT)?;
        parse_status_reply(&response)
    }

    pub fn spawn_session(&self, id: &str, task_slug: &str) -> Result<(), String> {
        self.call(&spawn_request(id, task_slug)).and_then(expect_ok)
    }

    pub fn resume_session(&self, request: &OpenRequest<'_>) -> Result<(), String> {
        self.call(&open_request(request)).and_then(expect_ok)
    }

    pub fn restate_session(&self, id: &str, transport: &str) -> Result<(), String> {
        self.call(&restate_request(id, transport)).and_then(expect_ok)
    }

    pub fn rpc_write_session(&self, id: &str, payload: &Value) -> Result<(), String> {
        self.call(&rpc_write_request(id, payload)).and_then(expect_ok)
    }

    /// Returns the reserved setup session id to attach to.
    pub fn omp_setup(&self) -> Result<String, String> {
        let reply = self.call(&omp_setup_request())?;
        if let Some(error) = reply_error(&reply) {
            return Err(error.to_string());
        }
        reply
            .get("id")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .ok_or_else(|| "daemon returned no setup session id".to_string())
    }

    pub fn kill_session(&self, id: &str) -> Result<(), String> {
        self.call(&kill_request(id)).and_then(expect_ok)
    }

    pub fn session_statuses_observed(&self) -> Result<Vec<DaemonSessionStatus>, String> {
        parse_list_reply(&self.call_with_timeout(&list_request(), DAEMON_OBSERVATION_TIMEOUT)?)
    }
}

fn unknown_message_delivery(detail: &str) -> String {
    format!("message delivery is unknown; Alinery will not retry: {detail}")
}

fn expect_message_send(response: Value) -> Result<(), String> {
    if let Some(error) = reply_error(&response) {
        return match response.get("delivery").and_then(Value::as_str) {
            Some("not_sent") => Err(error.to_string()),
            Some("unknown") => Err(format!(
                "Message may have been partially sent. Alinery did not retry. Check OMP before resending; resending may duplicate or corrupt the input. Daemon error: {error}"
            )),
            _ => Err(unknown_message_delivery("malformed daemon reply: missing message delivery classification")),
        };
    }
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(unknown_message_delivery("malformed daemon reply: missing ok:true"));
    }
    Ok(())
}

fn expect_ok(response: Value) -> Result<(), String> {
    if let Some(error) = reply_error(&response) {
        return Err(error.to_string());
    }
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("daemon response is missing ok:true".into());
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DaemonClientError {
    Unreachable {
        socket_path: PathBuf,
        detail: String,
    },
    ProtocolMismatch {
        observed_protocol: Option<u32>,
        expected_protocol: u32,
        observed_build_id: Option<String>,
    },
    AppConfigMismatch {
        observed_identity: Option<String>,
        expected_identity: String,
        observed_build_id: Option<String>,
    },
    Launch(String),
    Malformed(String),
}

impl std::fmt::Display for DaemonClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable { socket_path, detail } => write!(formatter, "daemon at {} is unreachable: {detail}", socket_path.display()),
            Self::ProtocolMismatch {
                observed_protocol,
                expected_protocol,
                ..
            } => write!(
                formatter,
                "repo-protocol-mismatch: daemon speaks protocol {}, client speaks {expected_protocol}",
                observed_protocol.map(|value| value.to_string()).unwrap_or_else(|| "<missing>".into())
            ),
            Self::AppConfigMismatch {
                observed_identity,
                expected_identity,
                ..
            } => write!(
                formatter,
                "repo-app-config-mismatch: daemon app-config identity {} does not match {expected_identity}",
                observed_identity.as_deref().unwrap_or("<missing>")
            ),
            Self::Launch(message) => write!(formatter, "daemon launch failed: {message}"),
            Self::Malformed(message) => write!(formatter, "malformed daemon reply: {message}"),
        }
    }
}

impl std::error::Error for DaemonClientError {}

fn classify_client(client: DaemonClient, expected_identity: &str) -> Result<(DaemonClient, DaemonCompat), DaemonClientError> {
    let version = client.version_checked().map_err(DaemonClientError::Malformed)?;
    let build_id = daemon_binary_build_id();
    match classify_version_reply(&version, &build_id, expected_identity) {
        compatible @ (DaemonCompat::Current | DaemonCompat::BuildDrift) => Ok((client, compatible)),
        DaemonCompat::ProtocolMismatch => Err(DaemonClientError::ProtocolMismatch {
            observed_protocol: version.protocol,
            expected_protocol: PROTOCOL_VERSION,
            observed_build_id: version.build_id,
        }),
        DaemonCompat::AppConfigMismatch => Err(DaemonClientError::AppConfigMismatch {
            observed_identity: version.app_config_identity,
            expected_identity: expected_identity.to_string(),
            observed_build_id: version.build_id,
        }),
    }
}

pub fn connect_compatible(socket_path: PathBuf, app_config: &Path) -> Result<(DaemonClient, DaemonCompat), DaemonClientError> {
    let client = DaemonClient::connect_path_checked(socket_path.clone()).map_err(|detail| DaemonClientError::Unreachable { socket_path, detail })?;
    classify_client(client, &app_config_identity(app_config))
}

pub fn connect_compatible_once(socket_path: PathBuf, app_config: &Path) -> Result<(DaemonClient, DaemonCompat), DaemonClientError> {
    let client = DaemonClient::connect_path(socket_path).map_err(DaemonClientError::Malformed)?;
    classify_client(client, &app_config_identity(app_config))
}

pub fn ensure_compatible_daemon(repo: &Path, app_config: &Path, namespace: Option<&str>) -> Result<(DaemonClient, DaemonCompat), DaemonClientError> {
    let socket_path = alineryd_socket_path(repo, namespace);
    match connect_compatible(socket_path.clone(), app_config) {
        Ok(connected) => return Ok(connected),
        Err(DaemonClientError::Unreachable { .. }) => {}
        Err(error) => return Err(error),
    }

    spawn_daemon_detached(repo, app_config, namespace, None).map_err(DaemonClientError::Launch)?;
    for _ in 0..40 {
        match connect_compatible(socket_path.clone(), app_config) {
            Ok(connected) => return Ok(connected),
            Err(DaemonClientError::Unreachable { .. }) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(error),
        }
    }
    Err(DaemonClientError::Launch("daemon did not start".into()))
}

pub fn resolve_alineryd_path() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let directory = executable.parent()?;
    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == "alineryd" || name.starts_with("alineryd-") {
                return Some(entry.path());
            }
        }
    }
    let development = directory.join("alineryd");
    development.exists().then_some(development)
}

pub fn file_content_id(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut hash = 0xcbf29ce484222325u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        for byte in &buffer[..count] {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    Some(format!("{hash:016x}"))
}

pub fn daemon_binary_build_id() -> String {
    resolve_alineryd_path().and_then(|path| file_content_id(&path)).unwrap_or_default()
}

pub fn configure_detached_process(command: &mut Command) {
    unsafe {
        command.pre_exec(|| if libc::setsid() == -1 { Err(std::io::Error::last_os_error()) } else { Ok(()) });
    }
}

pub fn configure_host_guard_environment(command: &mut Command, host_executable: Option<&Path>) {
    command.env_remove("ALINERY_HOST_EXECUTABLE");
    if let Some(host_executable) = host_executable {
        command.env("ALINERY_HOST_EXECUTABLE", host_executable);
    }
}

pub fn spawn_daemon_detached(repo: &Path, app_config: &Path, namespace: Option<&str>, host_executable: Option<&Path>) -> Result<(), String> {
    let daemon = resolve_alineryd_path().ok_or("alineryd binary not found")?;
    let mut command = Command::new(daemon);
    command
        .arg("--repo")
        .arg(repo)
        .arg("--app-config")
        .arg(app_config)
        .arg("--build-id")
        .arg(daemon_binary_build_id())
        .env("PATH", login_shell_path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_host_guard_environment(&mut command, host_executable);
    if let Some(namespace) = namespace.filter(|value| !value.is_empty()) {
        command.arg("--socket-namespace").arg(namespace);
    }
    configure_detached_process(&mut command);
    command.spawn().map(|_| ()).map_err(|error| format!("spawn alineryd: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixListener;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn socket_path(_name: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() % 1_000_000_000;
        PathBuf::from(format!("/tmp/ac{}_{}.sock", std::process::id(), nanos))
    }

    fn serve_version(name: &str, reply: Value) -> (PathBuf, thread::JoinHandle<Value>) {
        let path = socket_path(name);
        let listener = UnixListener::bind(&path).unwrap();
        let handle = thread::spawn(move || {
            let (probe, _) = listener.accept().unwrap();
            drop(probe);
            let (mut stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap()).read_line(&mut line).unwrap();
            stream.write_all(reply.to_string().as_bytes()).unwrap();
            stream.write_all(b"\n").unwrap();
            serde_json::from_str(line.trim()).unwrap()
        });
        (path, handle)
    }

    #[test]
    fn wire_requests_and_version_classification_remain_stable() {
        assert_eq!(shutdown_request()["op"], "shutdown");
        assert_eq!(version_request()["op"], "version");
        assert_eq!(list_request()["op"], "list");
        assert_eq!(write_request("s1", "hi")["data"], "hi");
        assert_eq!(send_message_header("s1", 7)["op"], "send_message");
        assert_eq!(send_message_header("s1", 7)["body_bytes"], 7);
        assert_eq!(resize_request("s1", 80, 24)["cols"], 80);
        assert_eq!(kill_request("s1")["id"], "s1");
        assert_eq!(status_request("s1")["op"], "status");
        assert_eq!(detach_request("s1", 7)["attach_id"], 7);
        assert_eq!(spawn_request("s1", "slug")["task_slug"], "slug");

        let exact = DaemonVersionReply {
            protocol: Some(PROTOCOL_VERSION),
            build_id: Some("build".into()),
            app_config_identity: Some("config".into()),
            host_guard_ready: Some(true),
        };
        assert_eq!(classify_version_reply(&exact, "build", "config"), DaemonCompat::Current);
        assert_eq!(classify_version_reply(&exact, "other", "config"), DaemonCompat::BuildDrift);
        assert_eq!(classify_version_reply(&exact, "build", "other"), DaemonCompat::AppConfigMismatch);
        let missing = parse_version_reply(&json!({"build_id": "old"}));
        assert_eq!(classify_version_reply(&missing, "new", "config"), DaemonCompat::ProtocolMismatch);
    }

    #[test]
    fn restate_request_shape() {
        assert_eq!(restate_request("s1", "rpc"), json!({"op": "restate", "id": "s1", "transport": "rpc"}));
    }

    #[test]
    fn rpc_attach_request_shape() {
        assert_eq!(rpc_attach_request("s1", 7), json!({"op": "rpc_attach", "id": "s1", "attach_id": 7}));
    }

    #[test]
    fn rpc_write_request_shape() {
        let payload = json!({"id": "1", "method": "prompt", "params": {"text": "hi"}});
        let request = rpc_write_request("s1", &payload);
        assert_eq!(request["op"], "rpc_write");
        assert_eq!(request["id"], "s1");
        assert_eq!(request["payload"], payload);
        assert!(request["payload"].is_object());
    }

    #[test]
    fn open_intent_still_pty_only() {
        assert!(is_known_open_intent("attach"));
        assert!(is_known_open_intent("spawn"));
        assert!(is_known_open_intent("resume"));
        assert!(!is_known_open_intent("rpc_attach"));
        assert!(!is_known_open_intent("restate"));
        assert!(!is_known_open_intent("rpc_write"));
    }

    #[test]
    fn oversized_encoded_requests_are_rejected_before_connecting() {
        let client = DaemonClient::connect_path(socket_path("oversized")).unwrap();
        // Raw text fits, but JSON escaping plus envelope bytes exceeds the wire cap.
        let request = rpc_write_request("session", &json!({"type": "prompt", "message": "\0".repeat(MAX_CONTROL_REQUEST_BYTES / 6)}));
        for error in [
            client.send(&request).unwrap_err(),
            client.call_with_timeout(&request, DAEMON_OBSERVATION_TIMEOUT).unwrap_err(),
        ] {
            assert!(error.starts_with("request-too-large:"), "{error}");
            assert!(error.contains(&MAX_CONTROL_REQUEST_BYTES.to_string()), "{error}");
        }
    }

    #[test]
    fn open_request_carries_the_intent_as_the_op() {
        let request = open_request(&OpenRequest {
            intent: ops::RESUME,
            id: "s1",
            cwd: "/tmp",
            task_slug: Some("slug"),
            phase: None,
            model: None,
            attach_id: 3,
            resume_token: Some("token"),
            cols: Some(80),
            rows: Some(24),
        });
        assert_eq!(request["op"], "resume");
        assert_eq!(request["resume_token"], "token");
        assert!(is_known_open_intent("attach") && !is_known_open_intent("bogus"));
    }

    #[test]
    fn open_request_omits_harness() {
        let request = open_request(&OpenRequest {
            intent: ops::SPAWN,
            id: "s1",
            cwd: "/tmp",
            task_slug: Some("slug"),
            phase: Some("research"),
            model: Some("sonnet"),
            attach_id: 1,
            resume_token: None,
            cols: None,
            rows: None,
        });
        assert!(request.get("harness").is_none());
        assert_eq!(request["model"], "sonnet");
    }
    #[test]
    fn message_send_reply_preserves_rejection_and_warns_on_partial_delivery() {
        assert_eq!(
            expect_message_send(json!({"error": "session-not-idle", "delivery": "not_sent"})).unwrap_err(),
            "session-not-idle"
        );
        let partial = expect_message_send(json!({"error": "write-message: fixture failure", "delivery": "unknown"})).unwrap_err();
        assert!(partial.contains("may have been partially sent"));
        assert!(partial.contains("did not retry"));
        assert!(partial.contains("resending may duplicate or corrupt"));
        assert!(partial.contains("write-message: fixture failure"));
        assert!(expect_message_send(json!({"error": "write-message: fixture failure"}))
            .unwrap_err()
            .contains("missing message delivery classification"));
    }

    #[test]
    fn spawn_ack_requires_ok_and_propagates_daemon_errors() {
        assert!(expect_ok(json!({"ok": true})).is_ok());
        assert_eq!(expect_ok(json!({"error": "already-started"})).unwrap_err(), "already-started");
        assert!(expect_ok(json!({"status": "maybe"})).unwrap_err().contains("ok:true"));
    }

    #[test]
    fn spawn_session_parses_daemon_errors_from_the_socket() {
        let path = socket_path("alinery_spawn_error");
        let listener = UnixListener::bind(&path).unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap()).read_line(&mut line).unwrap();
            stream.write_all(b"{\"error\":\"already-started\"}\n").unwrap();
            serde_json::from_str::<Value>(line.trim()).unwrap()
        });
        let client = DaemonClient::connect_path(path.clone()).unwrap();
        assert_eq!(client.spawn_session("s1", "task").unwrap_err(), "already-started");
        assert_eq!(server.join().unwrap(), spawn_request("s1", "task"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn connect_compatible_classifies_every_answering_socket_without_teardown() {
        let app_config = std::env::temp_dir().join("alinery-connect-compatible-app.toml");
        let identity = app_config_identity(&app_config);
        let (matching_path, matching_server) = serve_version(
            "alinery_compatible",
            json!({
                "protocol": PROTOCOL_VERSION,
                "build_id": daemon_binary_build_id(),
                "app_config_identity": identity,
            }),
        );
        let (_, compatibility) = connect_compatible(matching_path.clone(), &app_config).unwrap();
        assert!(compatibility.usable());
        assert_eq!(matching_server.join().unwrap(), version_request());
        let _ = fs::remove_file(matching_path);

        let previous_protocol = PROTOCOL_VERSION.checked_sub(1).expect("protocol version must remain positive");
        let (mismatch_path, mismatch_server) = serve_version(
            "alinery_previous_protocol",
            json!({
                "protocol": previous_protocol,
                "build_id": "retained-pre-host-guard",
                "app_config_identity": app_config_identity(&app_config),
            }),
        );
        let error = connect_compatible(mismatch_path.clone(), &app_config).unwrap_err();
        assert!(matches!(
            error,
            DaemonClientError::ProtocolMismatch {
                observed_protocol: Some(observed),
                expected_protocol: PROTOCOL_VERSION,
                ..
            } if observed == previous_protocol
        ));
        assert_eq!(mismatch_server.join().unwrap(), version_request());
        let _ = fs::remove_file(mismatch_path);
    }
}
