//! Isolated one-request legacy peers. Child handles, never machine-wide PID searches.
use alinery_core::daemon_client::{audited_shutdown_protocol, wait_for_daemon_gone, BoundDaemonConnection, DaemonClient, PeerProcessIdentity};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Peer {
    child: Child,
    socket: PathBuf,
    log: PathBuf,
}
impl Peer {
    fn start(root: &Path, socket: PathBuf, version: &str, list: &str, ack: &str) -> Self {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let log = root.join(format!("{id}.log"));
        let ready = root.join(format!("{id}.ready"));
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "legacy_peer_child", "--nocapture"])
            .env("TAKEOVER_SOCKET", &socket)
            .env("TAKEOVER_LOG", &log)
            .env("TAKEOVER_READY", &ready)
            .env("TAKEOVER_VERSION", version)
            .env("TAKEOVER_LIST", list)
            .env("TAKEOVER_ACK", ack)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let mut peer = Self { child, socket, log };
        let end = Instant::now() + Duration::from_secs(5);
        while !ready.exists() {
            assert!(peer.child.try_wait().unwrap().is_none(), "fixture exited before readiness");
            assert!(Instant::now() < end, "fixture readiness timed out");
            std::thread::sleep(Duration::from_millis(5));
        }
        let client = DaemonClient::connect_path(peer.socket.clone()).unwrap();
        assert_eq!(client.version_checked().unwrap().protocol, Some(12));
        fs::write(&peer.log, b"").unwrap();
        peer
    }
    fn requests(&self) -> Vec<String> {
        fs::read_to_string(&self.log).unwrap_or_default().lines().map(str::to_owned).collect()
    }
    fn connect(&self, expected: Option<&PeerProcessIdentity>) -> Result<BoundDaemonConnection, String> {
        BoundDaemonConnection::connect(&self.socket, expected, Duration::from_secs(5))
    }
    fn release_lease(&self) {
        fs::write(self.log.with_extension("release"), b"release").unwrap();
        let end = Instant::now() + Duration::from_secs(5);
        while !self.log.with_extension("released").exists() {
            assert!(Instant::now() < end);
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        // EOF on our private control pipe stops only this retained fixture child.
        drop(self.child.stdin.take());
        let _ = self.child.wait();
    }
}
struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let path = PathBuf::from(format!("/tmp/at-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]));
        fs::create_dir_all(path.join(".alinery")).unwrap();
        Self(path)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn legacy_peer_child() {
    let Ok(socket) = std::env::var("TAKEOVER_SOCKET") else {
        return;
    };
    let listener = UnixListener::bind(&socket).unwrap();
    let socket = Path::new(&socket);
    let lock = socket.with_file_name(format!(".{}.lock", socket.file_stem().unwrap().to_str().unwrap()));
    let mut lease = alinery_core::lockfile::try_lock_exclusive(&lock).unwrap();
    assert!(lease.is_some());
    let log = PathBuf::from(std::env::var("TAKEOVER_LOG").unwrap());
    let mut ready_exchange = false;
    let stopped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = stopped.clone();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    listener.set_nonblocking(true).unwrap();
    fs::write(std::env::var("TAKEOVER_READY").unwrap(), b"ready").unwrap();
    while !stopped.load(std::sync::atomic::Ordering::SeqCst) {
        if log.with_extension("release").exists() {
            drop(lease.take());
            fs::write(log.with_extension("released"), b"released").unwrap();
        }
        let (mut stream, _) = match listener.accept() {
            Ok(pair) => pair,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(2));
                continue;
            }
            Err(error) => panic!("{error}"),
        };
        if stream.set_nonblocking(false).is_err() || stream.set_read_timeout(Some(Duration::from_secs(5))).is_err() {
            // Identity-only probes may close before this accepted stream is configured.
            continue;
        }
        let mut line = String::new();
        if BufReader::new(stream.try_clone().unwrap()).read_line(&mut line).is_err() || line.is_empty() {
            continue;
        }
        let request: Value = serde_json::from_str(&line).unwrap();
        let op = request["op"].as_str().unwrap();
        writeln!(fs::OpenOptions::new().create(true).append(true).open(&log).unwrap(), "{op}").unwrap();
        if !ready_exchange {
            assert_eq!(op, "version");
            writeln!(stream, "{{\"protocol\":12}}").unwrap();
            ready_exchange = true;
            continue;
        }
        let key = match op {
            "version" => "TAKEOVER_VERSION",
            "list" => "TAKEOVER_LIST",
            "shutdown" => "TAKEOVER_ACK",
            _ => panic!("unexpected op"),
        };
        let response = std::env::var(key).unwrap();
        if response == "SILENT" {
            while !stopped.load(std::sync::atomic::Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(2));
            }
        } else if response != "EOF" {
            let _ = writeln!(stream, "{response}");
        }
    }
}

#[test]
fn legacy_fixture_preserves_unknown_list_and_records_requests() {
    let root = Root::new();
    let peer = Peer::start(
        &root.0,
        root.0.join("peer.sock"),
        r#"{"protocol":12,"build_id":"old"}"#,
        r#"{"error":"unsupported"}"#,
        r#"{"ok":true}"#,
    );
    let client = DaemonClient::connect_path(peer.socket.clone()).unwrap();
    assert_eq!(client.version_checked().unwrap().protocol, Some(12));
    assert!(client.session_statuses_observed().is_err());
    assert_eq!(peer.requests(), ["version", "list"]);
}

#[test]
fn native_peer_identity_tracks_child_incarnation() {
    let root = Root::new();
    let socket = root.0.join("peer.sock");
    let a = Peer::start(&root.0, socket.clone(), r#"{"protocol":12}"#, r#"{"sessions":[]}"#, r#"{"ok":true}"#);
    let connection = a.connect(None).unwrap();
    let identity = connection.identity().clone();
    assert_eq!(identity.pid(), a.child.id() as i32);
    connection.version().unwrap();
    let connection = a.connect(Some(&identity)).unwrap();
    assert_eq!(connection.identity(), &identity);
    connection.sessions().unwrap();
    drop(a);
    fs::remove_file(&socket).unwrap();
    let b = Peer::start(&root.0, socket, r#"{"protocol":12}"#, r#"{"sessions":[]}"#, r#"{"ok":true}"#);
    let connection = b.connect(None).unwrap();
    assert_ne!(connection.identity(), &identity);
    assert_eq!(connection.identity().pid(), b.child.id() as i32);
    connection.version().unwrap();
}

#[test]
fn same_path_replacement_never_receives_confirmed_shutdown() {
    for replace_after_list in [false, true] {
        let root = Root::new();
        let socket = root.0.join("peer.sock");
        let a = Peer::start(&root.0, socket.clone(), r#"{"protocol":12}"#, r#"{"sessions":[]}"#, r#"{"ok":true}"#);
        let preview = a.connect(None).unwrap();
        let identity = preview.identity().clone();
        preview.version().unwrap();
        if replace_after_list {
            a.connect(Some(&identity)).unwrap().sessions().unwrap();
        }
        drop(a);
        fs::remove_file(&socket).unwrap();
        let b = Peer::start(&root.0, socket, r#"{"protocol":15}"#, r#"{"sessions":[]}"#, r#"{"ok":true}"#);
        assert!(b.connect(Some(&identity)).is_err());
        assert_eq!(b.connect(None).unwrap().version().unwrap().protocol, Some(15));
        assert_eq!(b.requests(), ["version"]);
    }
}

#[test]
fn already_bound_stream_never_reconnects_to_replacement() {
    let root = Root::new();
    let socket = root.0.join("peer.sock");
    let a = Peer::start(&root.0, socket.clone(), r#"{"protocol":12}"#, r#"{"sessions":[]}"#, r#"{"ok":true}"#);
    // Release only the test lease so another fixture can bind the removed path.
    a.release_lease();
    let bound = a.connect(None).unwrap();
    fs::remove_file(&socket).unwrap();
    let b = Peer::start(&root.0, socket, r#"{"protocol":15}"#, r#"{"sessions":[]}"#, r#"{"ok":true}"#);
    bound.shutdown().unwrap();
    assert_eq!(a.requests(), ["shutdown"]);
    assert_eq!(b.connect(None).unwrap().version().unwrap().protocol, Some(15));
    assert_eq!(b.requests(), ["version"]);
}

#[test]
fn bound_shutdown_requires_checked_ack_without_retry() {
    for (ack, succeeds) in [
        (r#"{"ok":true}"#, true),
        (r#"{"ok":false}"#, false),
        (r#"{"error":"refused"}"#, false),
        (r#"{}"#, false),
        ("not json", false),
        ("EOF", false),
        ("SILENT", false),
    ] {
        let root = Root::new();
        let socket = root.0.join("peer.sock");
        let a = Peer::start(&root.0, socket.clone(), r#"{"protocol":12}"#, r#"{"sessions":[]}"#, ack);
        let bound = BoundDaemonConnection::connect(&a.socket, None, Duration::from_millis(500)).unwrap();
        assert_eq!(bound.shutdown().is_ok(), succeeds, "{ack}");
        assert_eq!(a.requests(), ["shutdown"]);
        drop(a);
        fs::remove_file(&socket).unwrap();
        let b = Peer::start(&root.0, socket, r#"{"protocol":15}"#, r#"{"sessions":[]}"#, r#"{"ok":true}"#);
        b.connect(None).unwrap().version().unwrap();
        assert_eq!(b.requests(), ["version"]);
    }
}

#[test]
fn legacy_dialect_and_unknown_impact_are_distinct() {
    for protocol in [9, 10, 12, 15, 16] {
        assert!(audited_shutdown_protocol(Some(protocol)));
    }
    for protocol in [None, Some(0), Some(11), Some(13), Some(14), Some(17), Some(u32::MAX)] {
        assert!(!audited_shutdown_protocol(protocol));
    }
    for protocol in [12, 15] {
        for list in [r#"{"sessions":[]}"#, r#"{"error":"unsupported"}"#, "malformed", r#"{"sessions":[{"id":"old"}]}"#, "SILENT"] {
            let root = Root::new();
            let version = json!({"protocol":protocol,"build_id":"old-build","app_config_identity":"other-config"}).to_string();
            let peer = Peer::start(&root.0, root.0.join("peer.sock"), &version, list, r#"{"ok":true}"#);
            let connection = peer.connect(None).unwrap();
            let identity = connection.identity().clone();
            let observed = connection.version().unwrap();
            assert!(audited_shutdown_protocol(observed.protocol));
            assert!(!alinery_core::daemon_client::classify_version_reply(&observed, "new-build", "new-config").usable());
            let sessions = peer.connect(Some(&identity)).unwrap().sessions();
            if list == r#"{"sessions":[]}"# {
                assert!(sessions.unwrap().is_empty());
            } else {
                assert!(sessions.is_err());
            }
            assert_eq!(peer.requests(), ["version", "list"]);
        }
    }
    for version in [
        r#"{}"#,
        r#"{"protocol":"12"}"#,
        r#"{"protocol":4294967296}"#,
        r#"{"protocol":12,"build_id":1}"#,
        r#"{"error":"refused","protocol":12}"#,
        "malformed",
        "EOF",
        "SILENT",
    ] {
        let root = Root::new();
        let peer = Peer::start(&root.0, root.0.join("peer.sock"), version, r#"{"sessions":[]}"#, r#"{"ok":true}"#);
        assert!(peer.connect(None).unwrap().version().is_err(), "{version}");
        assert_eq!(peer.requests(), ["version"]);
    }
}

#[test]
fn selected_lane_exit_requires_quiet_socket_and_released_lease() {
    use std::os::unix::fs::MetadataExt;
    let root = Root::new();
    let socket = alinery_core::alineryd_socket_path(&root.0, Some("old"));
    let lock = alinery_core::alineryd_lock_path(&root.0, Some("old"));
    let peer = Peer::start(&root.0, socket.clone(), r#"{"protocol":12}"#, r#"{"sessions":[]}"#, r#"{"ok":true}"#);
    let before = fs::metadata(&lock).unwrap();
    fs::remove_file(&socket).unwrap();
    assert!(wait_for_daemon_gone(&root.0, "other").is_ok());
    assert!(wait_for_daemon_gone(&root.0, "old").is_err());
    drop(peer);
    wait_for_daemon_gone(&root.0, "old").unwrap();
    let after = fs::metadata(&lock).unwrap();
    assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
    let peer = Peer::start(&root.0, socket, r#"{"protocol":12}"#, r#"{"sessions":[]}"#, r#"{"ok":true}"#);
    peer.release_lease();
    assert!(wait_for_daemon_gone(&root.0, "old").is_err());
    assert_eq!(peer.connect(None).unwrap().version().unwrap().protocol, Some(12));
    assert!(!peer.requests().iter().any(|op| op == "shutdown"));
}

#[test]
fn selected_lane_exit_refuses_invalid_paths() {
    let root = Root::new();
    assert!(wait_for_daemon_gone(&root.0, "../other").is_err());
    let lock = alinery_core::alineryd_lock_path(&root.0, Some("bad"));
    fs::create_dir(&lock).unwrap();
    assert!(wait_for_daemon_gone(&root.0, "bad").is_err());
    let target = root.0.join("target");
    fs::write(&target, b"keep").unwrap();
    std::os::unix::fs::symlink(&target, alinery_core::alineryd_lock_path(&root.0, Some("link"))).unwrap();
    assert!(wait_for_daemon_gone(&root.0, "link").is_err());
    assert_eq!(fs::read(&target).unwrap(), b"keep");
    fs::write(alinery_core::alineryd_socket_path(&root.0, Some("file")), b"not socket").unwrap();
    assert!(wait_for_daemon_gone(&root.0, "file").is_err());
}
