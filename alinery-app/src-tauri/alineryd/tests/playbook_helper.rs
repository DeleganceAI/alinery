use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::json;

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Helper {
    repo: PathBuf,
    child: Child,
    socket: PathBuf,
}

impl Helper {
    fn spawn() -> Self {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let repo = PathBuf::from(format!("/tmp/ap-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(repo.join(".alinery")).unwrap();
        let socket = repo.join(".alinery/alinery-playbook.sock");
        let child = Command::new(env!("CARGO_BIN_EXE_alinery-playbook"))
            .arg("--repo")
            .arg(&repo)
            .arg("--app-config")
            .arg(repo.join(".alinery/app.toml"))
            .arg("--build-id")
            .arg("test")
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !socket.exists() && started.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(socket.exists(), "helper did not bind {}", socket.display());
        Self { repo, child, socket }
    }

    fn call(&self, request: serde_json::Value) -> serde_json::Value {
        let mut stream = UnixStream::connect(&self.socket).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        writeln!(stream, "{request}").unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.call(json!({"op":"stop"}));
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.repo);
    }
}

#[test]
fn helper_binds_the_playbook_socket_and_not_the_ui_socket() {
    let helper = Helper::spawn();
    assert!(UnixStream::connect(helper.repo.join(".alinery/alineryd.sock")).is_err());
    assert_eq!(helper.call(json!({"op":"health"}))["ok"], true);
}

#[test]
fn empty_task_slug_does_not_write_an_execution() {
    let helper = Helper::spawn();
    let reply = helper.call(json!({"op":"phase_request","task_slug":"","session_id":"s","nonce":"n1","phase":"build","execution_id":"e"}));
    assert_eq!(reply["forwarded"], false);
    assert!(!helper.repo.join(".alinery/tasks").exists());
}

#[test]
fn root_chat_start_opens_on_the_pi_daemon() {
    let helper = Helper::spawn();
    let ui = helper.repo.join(".alinery/alineryd.sock");
    let listener = UnixListener::bind(&ui).unwrap();
    let sessions = helper.repo.join(".alinery/sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::write(
        sessions.join("s-chat.meta.json"),
        r#"{"id":"s-chat","worktree":"/tmp","created":1,"generic":true,"harness":"omp","model":"alinery/DeepSeek-V4.1-Flash"}"#,
    )
    .unwrap();
    let accepted = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut line = String::new();
        BufReader::new(stream.try_clone().unwrap()).read_line(&mut line).unwrap();
        writeln!(stream, "{}", json!({"ok":true})).unwrap();
        let _ = stream.flush();
        line
    });
    let reply = helper.call(json!({"op":"start_session","request":{"task_slug":"","session_id":"s-chat"}}));
    let line = accepted.join().unwrap();
    assert!(line.contains("\"op\":\"pi_open\""), "{line}");
    assert_eq!(reply["start"], "started", "{reply}");
    let message = reply["errors"][0]["message"].as_str().unwrap_or("");
    assert!(!message.contains("OMP host"), "{reply}");
}

#[test]
fn replayed_nonce_returns_the_existing_outcome() {
    let helper = Helper::spawn();
    let request = json!({"op":"phase_request","task_slug":"missing","session_id":"s","nonce":"same","phase":"build","execution_id":"e"});
    let first = helper.call(request.clone());
    let second = helper.call(request);
    assert_eq!(first, second);
    let nonces = std::fs::read_to_string(helper.repo.join(".alinery/phase-nonces.json")).unwrap_or_default();
    assert_eq!(nonces.matches("missing/s/same").count(), 1, "{nonces}");
}
