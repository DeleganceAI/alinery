//! The one JSON-lines client left: it talks to a daemon older than the gRPC server (protocol 38 and below).
//!
//! The daemon itself no longer speaks this wire (S5.3). The app keeps this module so a person who upgrades
//! with an old daemon still running can see that daemon's version and live sessions and stop it behind the
//! same confirmation (O23). Three ops, nothing else: version, list and shutdown.

use crate::{alineryd_socket_path, daemon_compat, rpc_socket_path, DaemonCompat, SessionState, SessionTransport};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

pub const DAEMON_OBSERVATION_TIMEOUT: Duration = Duration::from_millis(250);

// 250ms = passive observation that must never stall a poll (status/list/version).
// 100s  = control ops that legitimately do work before acking (spawn/kill/write/resize/
//         detach/shutdown + the open handshake). A wedge detector, not a latency
//         budget: a healthy ack is milliseconds.
pub const DAEMON_CONTROL_TIMEOUT: Duration = Duration::from_secs(100);

/// A kernel-authenticated local process incarnation; consent never binds to a PID alone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerProcessIdentity {
    uid: u32,
    pid: i32,
    start: (u64, u64),
}

impl PeerProcessIdentity {
    pub fn pid(&self) -> i32 {
        self.pid
    }
}

pub fn peer_process_id(stream: &UnixStream) -> Result<i32, String> {
    #[cfg(target_os = "macos")]
    {
        let (mut uid, mut gid) = (0, 0);
        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 || uid != unsafe { libc::geteuid() } {
            return Err("peer same-user credentials unavailable".into());
        }
        let mut pid: libc::pid_t = 0;
        let mut size = std::mem::size_of_val(&pid) as libc::socklen_t;
        if unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_LOCAL, libc::LOCAL_PEERPID, (&mut pid as *mut libc::pid_t).cast(), &mut size) } != 0
            || size as usize != std::mem::size_of_val(&pid)
            || pid <= 0
        {
            return Err("peer PID unavailable".into());
        }
        Ok(pid)
    }
    #[cfg(target_os = "linux")]
    {
        let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of_val(&cred) as libc::socklen_t;
        if unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut cred as *mut libc::ucred).cast(), &mut size) } != 0
            || size as usize != std::mem::size_of_val(&cred)
            || cred.uid != unsafe { libc::geteuid() }
            || cred.pid <= 0
        {
            return Err("peer same-user credentials unavailable".into());
        }
        Ok(cred.pid)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = stream;
        Err("peer process identity unsupported on this platform".into())
    }
}

#[cfg(any(target_os = "linux", test))]
fn parse_process_start(stat: &str, pid: i32) -> Result<u64, String> {
    let (prefix, rest) = stat.split_once(" (").ok_or("missing process comm")?;
    if pid <= 0 || prefix.parse::<i32>().ok() != Some(pid) {
        return Err("process PID evidence changed".into());
    }
    let (_, fields) = rest.rsplit_once(") ").ok_or("missing process comm terminator")?;
    // Fields after comm start at 3 (state); starttime is field 22.
    let start = fields.split_whitespace().nth(19).ok_or("missing process start time")?;
    let start = start.parse::<u64>().map_err(|_| "invalid process start time")?;
    if start == 0 {
        return Err("missing process start time".into());
    }
    Ok(start)
}

#[cfg(target_os = "macos")]
fn checked_bsd_start(info: &libc::proc_bsdinfo, read: i32, pid: i32, uid: u32) -> Result<(u64, u64), String> {
    if read != std::mem::size_of_val(info) as i32
        || pid <= 0
        || info.pbi_pid != pid as u32
        || info.pbi_uid != uid
        || info.pbi_start_tvsec == 0
        || info.pbi_start_tvusec >= 1_000_000
    {
        return Err("peer process start evidence unavailable or inconsistent".into());
    }
    Ok((info.pbi_start_tvsec, info.pbi_start_tvusec))
}

pub fn peer_process_identity(stream: &UnixStream) -> Result<PeerProcessIdentity, String> {
    let pid = peer_process_id(stream)?;
    let uid = unsafe { libc::geteuid() };
    #[cfg(target_os = "macos")]
    let start = {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info);
        let read = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size as i32) };
        checked_bsd_start(&info, read, pid, uid)?
    };
    #[cfg(target_os = "linux")]
    let start = {
        use std::os::unix::fs::MetadataExt;
        let path = format!("/proc/{pid}/stat");
        let file = fs::File::open(path).map_err(|error| format!("peer process inspection failed: {error}"))?;
        if file.metadata().map_err(|error| error.to_string())?.uid() != uid {
            return Err("peer process user evidence changed".into());
        }
        let mut stat = String::new();
        (&file).read_to_string(&mut stat).map_err(|error| error.to_string())?;
        (parse_process_start(&stat, pid)?, 0)
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let start = return Err("peer process start inspection unsupported".into());
    if peer_process_id(stream)? != pid {
        return Err("peer process identity changed during inspection".into());
    }
    Ok(PeerProcessIdentity { uid, pid, start })
}

/// Source-audited shutdown request/ack dialects (9/10/12/15/16/18 historical, 24 to 37 current).
/// Gaps are deliberate: normal protocol compatibility is not shutdown authority.
/// Protocol 18 dropped the OMP process ops. Shutdown is still
/// `{"op":"shutdown"}` acknowledged by `{"ok":true}`; the 24 to 38 daemons' handler
/// (`vinculum-daemon/src/main.ts`, `op === "shutdown"`) still speaks exactly that; 25 added the RPC
/// socket, 26 the settings services, 27 the execution service, 28 the task, draft and blob services (`create_task` stays as the wire `alinery-mcp` uses until S5.1), 29 the session and chat services, 30 the artifact service, 31 the playbook service, 32 the git service, 33 the sub-task service, 34 the backup service and the backup and purge jobs 35 the agent service and the community import calls 36 `SettingsService.WriteHostedInference` 37 the provider service (the `provider_*` and `custom_provider_*` ops left the JSON-lines wire) and 38 `AdminService.MintToken` and the three sub-task calls the MCP server makes, and each left this op alone.
pub fn audited_shutdown_protocol(protocol: Option<u32>) -> bool {
    matches!(
        protocol,
        Some(9 | 10 | 12 | 15 | 16 | 18 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38)
    )
}

fn version_request() -> Value {
    json!({"op": "version"})
}

fn list_request() -> Value {
    json!({"op": "list"})
}

fn shutdown_request() -> Value {
    json!({"op": "shutdown"})
}

/// One request on one authenticated stream. No operation reconnects or retries.
pub struct BoundDaemonConnection {
    stream: UnixStream,
    identity: PeerProcessIdentity,
    deadline: ObservationDeadline,
}

impl BoundDaemonConnection {
    pub fn connect(socket: &Path, expected: Option<&PeerProcessIdentity>, timeout: Duration) -> Result<Self, String> {
        let deadline = ObservationDeadline::start(timeout);
        let stream = connect_until(socket, &deadline).map_err(|error| error.to_string())?;
        let identity = peer_process_identity(&stream)?;
        if expected.is_some_and(|expected| *expected != identity) {
            return Err("stale daemon: peer process incarnation changed".into());
        }
        deadline.remaining().map_err(|error| error.to_string())?;
        Ok(Self { stream, identity, deadline })
    }

    pub fn identity(&self) -> &PeerProcessIdentity {
        &self.identity
    }

    fn exchange(mut self, request: Value, budget: Duration) -> Result<Value, String> {
        self.deadline.end = self.deadline.end.min(Instant::now() + budget);
        if peer_process_identity(&self.stream)? != self.identity {
            return Err("stale daemon: peer process incarnation changed".into());
        }
        let mut payload = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
        payload.push(b'\n');
        write_until(&mut self.stream, &payload, &self.deadline).map_err(|error| error.to_string())?;
        let line = read_line_until(&mut self.stream, &self.deadline).map_err(|error| error.to_string())?;
        serde_json::from_slice(&line).map_err(|error| error.to_string())
    }

    pub fn version(self) -> Result<DaemonVersionReply, String> {
        let value = self.exchange(version_request(), DAEMON_OBSERVATION_TIMEOUT)?;
        if value.get("error").is_some() {
            return Err("daemon version observation was rejected".into());
        }
        let version = parse_version_reply(&value);
        if version.protocol.is_none() || ["build_id", "app_config_identity"].iter().any(|key| value.get(key).is_some_and(|v| !v.is_string())) {
            return Err("daemon version response is malformed or missing protocol".into());
        }
        Ok(version)
    }

    pub fn sessions(self) -> Result<Vec<DaemonSessionStatus>, String> {
        let value = self.exchange(list_request(), DAEMON_OBSERVATION_TIMEOUT)?;
        if value.get("error").is_some() {
            return Err("daemon list observation was rejected".into());
        }
        parse_list_reply(&value)
    }

    pub fn shutdown(self) -> Result<(), String> {
        expect_ok(self.exchange(shutdown_request(), DAEMON_CONTROL_TIMEOUT)?)
    }
}

/// Selected-lane proof only; callers must still acquire repository-wide ownership.
pub fn wait_for_daemon_gone(repo: &Path, lane: &str) -> Result<(), String> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    crate::repo_ownership::validate_lane(lane)?;
    let root = repo.join(".alinery");
    let metadata = fs::symlink_metadata(&root).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_dir() {
        return Err("cannot establish daemon exit: invalid ownership directory".into());
    }
    // A daemon is gone when neither of its sockets answers: the legacy one an old daemon serves, the rpc one a new one does.
    let sockets = [alineryd_socket_path(repo, Some(lane)), rpc_socket_path(repo, Some(lane))];
    let lock = crate::alineryd_lock_path(repo, Some(lane));
    // 5 s: a daemon waits up to about 1.5 s for its job children before it exits.
    for _ in 0..100 {
        let before = match fs::symlink_metadata(&lock) {
            Ok(metadata) if metadata.file_type().is_file() => Some(metadata),
            Ok(_) => return Err("cannot establish daemon exit: invalid process lock path".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("cannot establish daemon exit: {error}")),
        };
        let mut answering = false;
        for socket in &sockets {
            match fs::symlink_metadata(socket) {
                Ok(metadata) if !metadata.file_type().is_socket() => return Err("cannot establish daemon exit: invalid socket path".into()),
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(format!("cannot establish daemon exit: {error}")),
                _ => {}
            }
            match connect_for_ownership_probe(socket) {
                Ok(_) => answering = true,
                Err(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused) => {}
                Err(error) => return Err(format!("cannot establish daemon exit: {error}")),
            }
        }
        if !answering {
            if let Some(_lease) = crate::lockfile::try_lock_exclusive(&lock).map_err(|error| format!("cannot establish daemon exit: {error}"))? {
                let after = fs::symlink_metadata(&lock).map_err(|error| error.to_string())?;
                if !after.file_type().is_file() || before.is_some_and(|before| before.dev() != after.dev() || before.ino() != after.ino()) {
                    return Err("cannot establish daemon exit: process lock changed".into());
                }
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(format!("daemon for {} lane {lane:?} has not released its socket and process lock", repo.display()))
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

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DaemonVersionReply {
    pub protocol: Option<u32>,
    pub build_id: Option<String>,
    pub app_config_identity: Option<String>,
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
    }
}

pub fn reply_error(value: &Value) -> Option<&str> {
    value.get("error").and_then(Value::as_str)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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

struct ObservationDeadline {
    end: Instant,
}

impl ObservationDeadline {
    fn start(budget: Duration) -> Self {
        Self { end: Instant::now() + budget }
    }

    fn remaining(&self) -> std::io::Result<Duration> {
        self.end
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::TimedOut, "observation deadline"))
    }

    fn poll_timeout_ms(&self) -> std::io::Result<i32> {
        let millis = self.remaining()?.as_millis();
        if millis == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "observation deadline"));
        }
        Ok(millis.min(i32::MAX as u128) as i32)
    }
}

fn wait_socket(fd: std::os::fd::RawFd, events: i16, deadline: &ObservationDeadline) -> std::io::Result<()> {
    loop {
        let timeout_ms = deadline.poll_timeout_ms()?;
        let mut pollfd = libc::pollfd { fd, events, revents: 0 };
        let ready = unsafe { libc::poll(&mut pollfd, 1, timeout_ms) };
        if ready == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "observation deadline"));
        }
        if ready < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if pollfd.revents & events != 0 {
            return Ok(());
        }
        if pollfd.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "observation socket closed"));
        }
        return Err(std::io::Error::other("observation poll returned no event"));
    }
}

fn connect_until(path: &Path, deadline: &ObservationDeadline) -> std::io::Result<UnixStream> {
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: socket() returned an owned descriptor that no other owner has.
    let owned = unsafe { OwnedFd::from_raw_fd(fd) };
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let descriptor_flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if descriptor_flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, descriptor_flags | libc::FD_CLOEXEC) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let bytes = std::os::unix::ffi::OsStrExt::as_bytes(path.as_os_str());
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.len() + 1 > address.sun_path.len() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "socket path too long"));
    }
    address.sun_family = libc::AF_UNIX as _;
    for (index, byte) in bytes.iter().enumerate() {
        address.sun_path[index] = *byte as libc::c_char;
    }
    let length = (std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1) as libc::socklen_t;
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "dragonfly",
        target_os = "openbsd",
        target_os = "netbsd"
    ))]
    {
        address.sun_len = length as u8;
    }
    let connected = unsafe { libc::connect(fd, &address as *const libc::sockaddr_un as *const libc::sockaddr, length) };
    if connected < 0 {
        let error = std::io::Error::last_os_error();
        let in_progress = error.kind() == std::io::ErrorKind::WouldBlock || error.raw_os_error() == Some(libc::EINPROGRESS);
        if !in_progress {
            return Err(error);
        }
        wait_socket(fd, libc::POLLOUT, deadline)?;
        let mut so_error: libc::c_int = 0;
        let mut so_len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        let queried = unsafe { libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_ERROR, &mut so_error as *mut libc::c_int as *mut libc::c_void, &mut so_len) };
        if queried < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if so_error != 0 {
            return Err(std::io::Error::from_raw_os_error(so_error));
        }
    }
    Ok(UnixStream::from(owned))
}

pub(crate) fn connect_for_ownership_probe(path: &Path) -> std::io::Result<UnixStream> {
    connect_until(path, &ObservationDeadline::start(DAEMON_OBSERVATION_TIMEOUT))
}

fn write_until(stream: &mut (impl Write + AsRawFd), mut bytes: &[u8], deadline: &ObservationDeadline) -> std::io::Result<()> {
    while !bytes.is_empty() {
        deadline.remaining()?;
        match stream.write(bytes) {
            Ok(0) => return Err(std::io::Error::new(std::io::ErrorKind::WriteZero, "observation write")),
            Ok(count) => bytes = &bytes[count..],
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => wait_socket(stream.as_raw_fd(), libc::POLLOUT, deadline)?,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    deadline.remaining()?;
    Ok(())
}

fn read_line_until(stream: &mut (impl Read + AsRawFd), deadline: &ObservationDeadline) -> std::io::Result<Vec<u8>> {
    let mut line = Vec::new();
    let mut chunk = [0u8; 8 * 1024];
    loop {
        deadline.remaining()?;
        match stream.read(&mut chunk) {
            Ok(0) => return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "observation socket closed")),
            Ok(count) => {
                if let Some(end) = chunk[..count].iter().position(|byte| *byte == b'\n') {
                    line.extend_from_slice(&chunk[..end]);
                    if line.is_empty() {
                        return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "empty observation reply"));
                    }
                    deadline.remaining()?;
                    return Ok(line);
                }
                line.extend_from_slice(&chunk[..count]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => wait_socket(stream.as_raw_fd(), libc::POLLIN, deadline)?,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixListener;
    use std::path::PathBuf;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn bound_connection_rejects_same_pid_with_different_start() {
        let root = PathBuf::from(format!("/tmp/ai-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]));
        fs::create_dir_all(&root).unwrap();
        let socket = root.join("peer.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let connection = BoundDaemonConnection::connect(&socket, None, DAEMON_OBSERVATION_TIMEOUT).unwrap();
        let mut expected = connection.identity().clone();
        drop(connection);
        expected.start.0 += 1;
        let result = BoundDaemonConnection::connect(&socket, Some(&expected), DAEMON_OBSERVATION_TIMEOUT);
        assert!(result.is_err(), "matching PID must not override changed incarnation evidence");
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_nonblocking(false).unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).unwrap();
            assert!(bytes.is_empty(), "identity refusal must precede any request bytes");
        }
        drop(listener);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn peer_identity_rejects_missing_or_inconsistent_start_evidence() {
        let fields = ["0"; 18].join(" ");
        let stat = format!("42 (space (and) parentheses)) S {fields} 123456 999");
        assert_eq!(parse_process_start(&stat, 42).unwrap(), 123456);
        for bad in [
            String::new(),
            format!("43 (name) S {fields} 123456"),
            format!("42 name S {fields} 123456"),
            "42 (name) S 1".into(),
            format!("42 (name) S {fields} NaN"),
            format!("42 (name) S {fields} -1"),
            format!("42 (name) S {fields} 0"),
            format!("42 (name) S {fields} 18446744073709551616"),
        ] {
            assert!(parse_process_start(&bad, 42).is_err(), "{bad}");
        }
        let identity = PeerProcessIdentity {
            uid: 501,
            pid: 42,
            start: (123456, 0),
        };
        assert_ne!(
            identity,
            PeerProcessIdentity {
                start: (123457, 0),
                ..identity.clone()
            }
        );
        assert_ne!(
            identity,
            PeerProcessIdentity {
                start: (123456, 1),
                ..identity.clone()
            }
        );
        #[cfg(target_os = "macos")]
        {
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            info.pbi_pid = 42;
            info.pbi_uid = 501;
            info.pbi_start_tvsec = 123456;
            let size = std::mem::size_of_val(&info) as i32;
            assert_eq!(checked_bsd_start(&info, size, 42, 501).unwrap(), (123456, 0));
            assert!(checked_bsd_start(&info, size - 1, 42, 501).is_err());
            assert!(checked_bsd_start(&info, -1, 42, 501).is_err());
            assert!(checked_bsd_start(&info, size, 43, 501).is_err());
            assert!(checked_bsd_start(&info, size, 42, 502).is_err());
            info.pbi_start_tvusec = 1_000_000;
            assert!(checked_bsd_start(&info, size, 42, 501).is_err());
            info.pbi_start_tvusec = 0;
            info.pbi_start_tvsec = 0;
            assert!(checked_bsd_start(&info, size, 42, 501).is_err());
        }
    }

    fn socket_path(_name: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() % 1_000_000_000;
        PathBuf::from(format!("/tmp/ac{}_{}.sock", std::process::id(), nanos))
    }

    #[test]
    fn requests_and_version_classification_remain_stable() {
        assert_eq!(shutdown_request()["op"], "shutdown");
        assert_eq!(version_request()["op"], "version");
        assert_eq!(list_request()["op"], "list");

        let exact = DaemonVersionReply {
            protocol: Some(crate::PROTOCOL_VERSION),
            build_id: Some("build".into()),
            app_config_identity: Some("config".into()),
        };
        assert_eq!(classify_version_reply(&exact, "build", "config"), DaemonCompat::Current);
        assert_eq!(classify_version_reply(&exact, "other", "config"), DaemonCompat::BuildDrift);
        assert_eq!(classify_version_reply(&exact, "build", "other"), DaemonCompat::AppConfigMismatch);
        let missing = parse_version_reply(&json!({"build_id": "old"}));
        assert_eq!(classify_version_reply(&missing, "new", "config"), DaemonCompat::ProtocolMismatch);
        assert!(
            !audited_shutdown_protocol(Some(crate::PROTOCOL_VERSION)),
            "the gRPC daemon is stopped by Shutdown, never by this wire"
        );
        assert!(audited_shutdown_protocol(Some(38)));
    }

    /// An older daemon is observed and stopped over one bound connection each: its version, its sessions, its shutdown.
    #[test]
    fn a_bound_connection_reads_version_and_sessions_and_shuts_an_old_daemon_down() {
        let serve = |reply: Value| {
            let path = socket_path("legacy");
            let listener = UnixListener::bind(&path).unwrap();
            let handle = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut line = String::new();
                BufReader::new(stream.try_clone().unwrap()).read_line(&mut line).unwrap();
                stream.write_all(reply.to_string().as_bytes()).unwrap();
                stream.write_all(b"\n").unwrap();
                serde_json::from_str::<Value>(line.trim()).unwrap()
            });
            (path, handle)
        };
        let (path, server) = serve(json!({"protocol": 38, "build_id": "old", "app_config_identity": "cfg"}));
        let version = BoundDaemonConnection::connect(&path, None, DAEMON_OBSERVATION_TIMEOUT).unwrap().version().unwrap();
        assert_eq!((version.protocol, version.build_id.as_deref()), (Some(38), Some("old")));
        assert_eq!(server.join().unwrap(), version_request());
        let _ = fs::remove_file(&path);

        let (path, server) = serve(json!({"ok": true}));
        BoundDaemonConnection::connect(&path, None, DAEMON_CONTROL_TIMEOUT).unwrap().shutdown().unwrap();
        assert_eq!(server.join().unwrap(), shutdown_request());
        let _ = fs::remove_file(&path);

        let (path, server) = serve(json!({"error": "nope"}));
        let error = BoundDaemonConnection::connect(&path, None, DAEMON_CONTROL_TIMEOUT).unwrap().shutdown().unwrap_err();
        assert_eq!(error, "nope");
        server.join().unwrap();
        let _ = fs::remove_file(&path);
    }

    /// The gone proof waits on the rpc socket as well, so a gRPC daemon that is still answering is not "gone".
    #[test]
    fn wait_for_daemon_gone_refuses_while_the_rpc_socket_answers() {
        let root = PathBuf::from(format!("/tmp/ai-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]));
        fs::create_dir_all(root.join(".alinery")).unwrap();
        let listener = UnixListener::bind(rpc_socket_path(&root, Some("lane"))).unwrap();
        let started = Instant::now();
        // The listener answers connects, so the proof cannot complete within its 5 s budget.
        let handle = thread::spawn({
            let root = root.clone();
            move || wait_for_daemon_gone(&root, "lane")
        });
        thread::sleep(Duration::from_millis(300));
        assert!(!handle.is_finished(), "an answering rpc socket must keep the wait going");
        drop(listener);
        assert!(handle.join().unwrap().is_ok(), "once the socket stops answering and the lock is free the daemon is gone");
        assert!(started.elapsed() < Duration::from_secs(5));
        fs::remove_dir_all(root).unwrap();
    }

    struct DeadlineCrossingIo<'a> {
        stream: UnixStream,
        deadline: &'a ObservationDeadline,
        operations_before_expiry: usize,
        interrupt_on_expiry: bool,
    }

    impl DeadlineCrossingIo<'_> {
        fn before_io(&mut self) -> std::io::Result<()> {
            if self.operations_before_expiry > 0 {
                self.operations_before_expiry -= 1;
                if self.operations_before_expiry == 0 {
                    // Cross expiry deliberately, rather than racing a peer or assuming
                    // a sleep lands inside a narrow interval before the deadline.
                    while let Ok(remaining) = self.deadline.remaining() {
                        thread::sleep(remaining);
                    }
                    if self.interrupt_on_expiry {
                        return Err(std::io::ErrorKind::Interrupted.into());
                    }
                }
            }
            Ok(())
        }
    }

    impl AsRawFd for DeadlineCrossingIo<'_> {
        fn as_raw_fd(&self) -> std::os::fd::RawFd {
            self.stream.as_raw_fd()
        }
    }

    impl Read for DeadlineCrossingIo<'_> {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            self.before_io()?;
            let length = bytes.len().min(1);
            self.stream.read(&mut bytes[..length])
        }
    }

    impl Write for DeadlineCrossingIo<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.before_io()?;
            self.stream.write(&bytes[..bytes.len().min(1)])
        }

        fn flush(&mut self) -> std::io::Result<()> {
            self.stream.flush()
        }
    }

    #[test]
    fn observation_expired_deadline_rejects_buffered_complete_reply() {
        let (mut stream, mut peer) = UnixStream::pair().unwrap();
        stream.set_nonblocking(true).unwrap();
        peer.write_all(b"{}\n").unwrap();
        let deadline = ObservationDeadline::start(Duration::ZERO);

        assert_eq!(read_line_until(&mut stream, &deadline).unwrap_err().kind(), std::io::ErrorKind::TimedOut);
        let mut buffered = [0; 3];
        stream.read_exact(&mut buffered).unwrap();
        assert_eq!(&buffered, b"{}\n", "an expired exchange must not consume buffered bytes");
    }

    #[test]
    fn observation_deadline_stops_successful_reads_at_expiry() {
        // Cover both continued progress and a complete reply returned by the
        // operation that crosses expiry.
        for reply in [b"xy\n".as_slice(), b"x\n".as_slice()] {
            let (stream, mut peer) = UnixStream::pair().unwrap();
            stream.set_nonblocking(true).unwrap();
            peer.write_all(reply).unwrap();
            peer.shutdown(std::net::Shutdown::Write).unwrap();
            let deadline = ObservationDeadline::start(DAEMON_OBSERVATION_TIMEOUT);
            let mut stream = DeadlineCrossingIo {
                stream,
                deadline: &deadline,
                operations_before_expiry: 2,
                interrupt_on_expiry: false,
            };

            assert_eq!(read_line_until(&mut stream, &deadline).unwrap_err().kind(), std::io::ErrorKind::TimedOut);
            let mut unread = Vec::new();
            stream.stream.read_to_end(&mut unread).unwrap();
            assert_eq!(unread, reply[2..], "no further read may run after successful progress crosses expiry");
        }
    }

    #[test]
    fn observation_deadline_stops_successful_writes_at_expiry() {
        // Cover a partial write and the final write completing after expiry.
        for payload in [b"xyz".as_slice(), b"xy".as_slice()] {
            let (stream, mut peer) = UnixStream::pair().unwrap();
            stream.set_nonblocking(true).unwrap();
            let deadline = ObservationDeadline::start(DAEMON_OBSERVATION_TIMEOUT);
            let mut stream = DeadlineCrossingIo {
                stream,
                deadline: &deadline,
                operations_before_expiry: 2,
                interrupt_on_expiry: false,
            };

            assert_eq!(write_until(&mut stream, payload, &deadline).unwrap_err().kind(), std::io::ErrorKind::TimedOut);
            drop(stream);
            let mut written = Vec::new();
            peer.read_to_end(&mut written).unwrap();
            assert_eq!(written, b"xy", "no further write may run after successful progress crosses expiry");
        }
    }

    #[test]
    fn observation_deadline_stops_interrupted_read_and_write_retries() {
        for reading in [true, false] {
            let (stream, mut peer) = UnixStream::pair().unwrap();
            stream.set_nonblocking(true).unwrap();
            peer.write_all(b"{}\n").unwrap();
            let deadline = ObservationDeadline::start(DAEMON_OBSERVATION_TIMEOUT);
            let mut stream = DeadlineCrossingIo {
                stream,
                deadline: &deadline,
                operations_before_expiry: 1,
                interrupt_on_expiry: true,
            };

            let error = if reading {
                read_line_until(&mut stream, &deadline).unwrap_err()
            } else {
                write_until(&mut stream, b"{}\n", &deadline).unwrap_err()
            };
            assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        }
    }
    #[test]
    fn list_reply_rejects_the_old_scalar_status() {
        let result = parse_list_reply(&json!({
            "sessions": [
                {"id": "running-id", "status": "running"},
                {"id": "idle-id", "status": "idle"},
                {"id": "exited-id", "status": "exited"}
            ]
        }));
        assert!(result.is_err(), "a scalar-only response must be rejected, not coerced");
    }

    #[test]
    fn list_reply_accepts_structured_axes_and_requires_a_transport() {
        let session = |transport: Option<&str>| {
            let mut session = json!({
                "id": "omp-id",
                "process": {"state": "alive"},
                "agent": {"state": "waiting_for_approval", "correlation_id": "call-1"},
                "playbook": {"state": "in_progress"},
                "adapter": "omp",
                "message_adapter": "omp_bracketed_paste"
            });
            if let Some(transport) = transport {
                session["transport"] = json!(transport);
            }
            json!({"sessions": [session]})
        };
        let sessions = parse_list_reply(&session(Some("pty"))).expect("a structured session list parses");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "omp-id");
        assert_eq!(sessions[0].state.process, crate::ProcessState::Alive);
        assert_eq!(sessions[0].state.agent, crate::AgentState::WaitingForApproval { correlation_id: "call-1".into() });
        assert_eq!(sessions[0].state.adapter, crate::HarnessAdapter::Omp);
        assert_eq!(sessions[0].state.message_adapter, crate::MessageAdapter::OmpBracketedPaste);
        assert_eq!(sessions[0].transport, crate::SessionTransport::Pty);
        assert!(parse_list_reply(&session(None)).is_err(), "a missing transport must not default to pty");
    }
}
