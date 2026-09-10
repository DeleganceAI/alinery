//! E4: an orphaned managed `alinery-mcp` must be reaped by asking it to exit over its own
//! socket — never by killing a pid read from `mcp.status.json` (pid reuse; the
//! identity-from-files antipattern #74 already deleted).
//!
//! Acceptance #9: force-quit the app, relaunch → exactly one `alinery-mcp` listener.
//! `ensure_mcp_server` currently unlinks a live socket out from under its listener and
//! spawns a second one; the exit control is what makes the old one leave first.
//!
//! RED until `alinery-mcp --serve` answers `{"op":"exit"}`.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

static ROOT_COUNTER: AtomicU64 = AtomicU64::new(0);

struct Serve {
    child: Child,
    root: PathBuf,
    socket: PathBuf,
}

impl Serve {
    fn start() -> Self {
        let n = ROOT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("alinery-mcp-exit-{}-{n}", std::process::id()));
        fs::create_dir_all(root.join(".alinery")).expect("mkdir .alinery");
        let socket = alinery_core::mcp_socket_path(&root, None);
        let child = Command::new(env!("CARGO_BIN_EXE_alinery-mcp"))
            .arg("--repo")
            .arg(&root)
            .arg("--serve")
            // Isolate from this machine's real alinery app config (same reason as the alineryd
            // integration tests): point at a path that does not exist.
            .arg("--app-config")
            .arg(root.join(".alinery").join("unused-app-config.toml"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn alinery-mcp --serve");

        let s = Self { child, root, socket };
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            if UnixStream::connect(&s.socket).is_ok() {
                return s;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("alinery-mcp never started listening on {}", s.socket.display());
    }

    fn listening(&self) -> bool {
        UnixStream::connect(&self.socket).is_ok()
    }
}

impl Drop for Serve {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn serve_mode_exits_when_asked_over_its_own_socket() {
    let mut serve = Serve::start();

    let mut stream = UnixStream::connect(&serve.socket).expect("connect mcp socket");
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    writeln!(stream, r#"{{"op":"exit"}}"#).expect("write exit op");
    let mut line = String::new();
    BufReader::new(stream.try_clone().unwrap())
        .read_line(&mut line)
        .expect("exit op must be acknowledged before the listener goes away");
    assert!(line.contains("\"ok\":true") || line.contains("\"ok\": true"), "exit reply: {line:?}");

    let start = Instant::now();
    let mut exited = false;
    while start.elapsed() < Duration::from_secs(5) {
        if matches!(serve.child.try_wait(), Ok(Some(_))) {
            exited = true;
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    assert!(exited, "listener must exit after acknowledging {{\"op\":\"exit\"}}");
    assert!(!serve.listening(), "socket must stop answering — the caller unlinks only after that");
}

#[test]
fn serve_mode_keeps_serving_when_no_exit_was_requested() {
    // Guards the other half: the reap path must not be reachable by an ordinary probe.
    // `mcp_socket_listening` connects (and disconnects) on every poll — that must never
    // take the server down.
    let serve = Serve::start();
    for _ in 0..5 {
        assert!(serve.listening(), "liveness probe killed the listener");
        thread::sleep(Duration::from_millis(50));
    }
}
