use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use alinery_core::{SessionMeta, Task, BRACKETED_PASTE_END, BRACKETED_PASTE_START, MESSAGE_SUBMIT};
use serde_json::{json, Value};

static ROOT_COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_root() -> PathBuf {
    let counter = ROOT_COUNTER.fetch_add(1, Ordering::Relaxed);
    PathBuf::from(format!("/tmp/sgmsg-{}-{counter}", std::process::id()))
}

fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if condition() {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!("condition did not become true within {timeout:?}");
}

struct Fixture {
    root: PathBuf,
    socket: PathBuf,
    tokens: PathBuf,
    child: Child,
}

impl Fixture {
    fn new() -> Self {
        let root = unique_root();
        fs::create_dir_all(root.join(".alinery")).unwrap();
        let tokens = root.join("tokens.tsv");
        let runner = root.join("fake-alinery-runner");
        // The capture path is baked into the script: an OMP child inherits only
        // `OMP_ENV_ALLOWLIST` from the daemon, so a fixture var cannot reach it through the
        // environment any more.
        fs::write(
            &runner,
            format!(
                "#!/bin/sh\nprintf '%s\\t%s\\n' \"$ALINERY_SESSION_ID\" \"$ALINERY_EVENT_TOKEN\" >> \"{}\"\nshift 4\nexec \"$@\"\n",
                tokens.display()
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&runner).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&runner, permissions).unwrap();

        fs::write(
            root.join(".alinery/harnesses.toml"),
            r#"
[[harness]]
key = "omp"
name = "OMP capture"
binary = "sh"
args = ["-c", "stty raw -echo; cat >> \"$ALINERY_REPO/message.bin.$ALINERY_SESSION_ID\""]
model_arg = []
prompt_injection = "arg"
adapter = "omp"
message_adapter = "omp_bracketed_paste"
"#,
        )
        .unwrap();

        let socket = root.join(".alinery/alineryd.sock");
        let mut child = Command::new(env!("CARGO_BIN_EXE_alineryd"))
            .arg("--repo")
            .arg(&root)
            .arg("--build-id")
            .arg("message-test")
            .arg("--app-config")
            .arg(root.join(".alinery/unused-app-config.toml"))
            .env("ALINERY_RUNNER_PATH", &runner)
            .env("ALINERY_HOST_EXECUTABLE", &runner)
            .env("ALINERY_RUNNER_CAPTURE", &tokens)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        wait_until(Duration::from_secs(5), || {
            if let Some(status) = child.try_wait().unwrap() {
                let mut stderr = String::new();
                if let Some(pipe) = child.stderr.as_mut() {
                    let _ = pipe.read_to_string(&mut stderr);
                }
                panic!("alineryd exited before readiness with {status}: {stderr}");
            }
            UnixStream::connect(&socket).is_ok()
        });
        Self { root, socket, tokens, child }
    }

    fn rpc(&self, request: Value) -> Value {
        let mut stream = UnixStream::connect(&self.socket).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        writeln!(stream, "{request}").unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    fn send_message(&self, id: &str, body: &[u8]) -> Value {
        let mut stream = UnixStream::connect(&self.socket).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        writeln!(stream, "{}", json!({"op": "send_message", "id": id, "body_bytes": body.len()})).unwrap();
        stream.write_all(body).unwrap();
        stream.flush().unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    fn send_message_header_only(&self, id: &str, body_bytes: usize) -> Value {
        let mut stream = UnixStream::connect(&self.socket).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        writeln!(stream, "{}", json!({"op": "send_message", "id": id, "body_bytes": body_bytes})).unwrap();
        stream.flush().unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    fn write_meta(&self, id: &str, harness: &str) {
        let task_dir = self.root.join(".alinery/tasks/task");
        fs::create_dir_all(task_dir.join("artifacts")).unwrap();
        fs::create_dir_all(task_dir.join("sessions")).unwrap();
        if !task_dir.join("task.md").exists() {
            let task = Task {
                name: "task".into(),
                slug: "task".into(),
                branch: "task".into(),
                worktree: self.root.to_string_lossy().into_owned(),
                has_worktree: true,
                created: 1,
                ..Default::default()
            };
            fs::write(task_dir.join("task.md"), toml::to_string(&task).unwrap()).unwrap();
        }
        let meta = SessionMeta {
            id: id.into(),
            worktree: self.root.to_string_lossy().into_owned(),
            created: 1,
            // Message framing exercises an auxiliary PTY, not a graph execution.
            generic: true,
            prompt: Some(String::new()),
            harness: harness.into(),
            ..Default::default()
        };
        fs::write(task_dir.join("sessions").join(format!("{id}.meta.json")), serde_json::to_vec(&meta).unwrap()).unwrap();
    }

    fn spawn(&self, id: &str, harness: &str) {
        self.write_meta(id, harness);
        let response = self.rpc(json!({
            "op": "spawn",
            "id": id,
            "cwd": self.root,
            "task_slug": "task",
            "harness": harness,
            "model": "",
            "phase": "",
            "attach_id": 1,
            "cols": 80,
            "rows": 24
        }));
        assert_eq!(response["ok"], true, "spawn response: {response}");
        wait_until(Duration::from_secs(5), || self.rpc(json!({"op": "status", "id": id}))["process"]["state"] == "alive");
        if self.rpc(json!({"op": "status", "id": id}))["transport"] == "rpc" {
            // Restate mints a new event token. Wait for that capture line or `token_for` still
            // sees the RPC spawn's token and every runner event comes back invalid-event-token.
            wait_until(Duration::from_secs(5), || self.token_count(id) > 0);
            let prior_tokens = self.token_count(id);
            let restated = self.rpc(json!({"op": "restate", "id": id, "transport": "pty"}));
            assert_eq!(restated["ok"], true, "restate pty: {restated}");
            wait_until(Duration::from_secs(5), || self.rpc(json!({"op": "status", "id": id}))["transport"] == "pty");
            wait_until(Duration::from_secs(5), || self.token_count(id) > prior_tokens);
            let _ = fs::write(self.root.join(format!("message.bin.{id}")), b"");
        }
    }

    fn token_count(&self, id: &str) -> usize {
        fs::read_to_string(&self.tokens)
            .map(|text| text.lines().filter(|line| line.starts_with(&format!("{id}\t"))).count())
            .unwrap_or(0)
    }

    fn token_for(&self, id: &str) -> String {
        wait_until(Duration::from_secs(5), || self.token_count(id) > 0);
        fs::read_to_string(&self.tokens)
            .unwrap()
            .lines()
            .rev()
            .find_map(|line| line.split_once('\t').and_then(|(session, token)| (session == id).then(|| token.to_string())))
            .unwrap()
    }

    fn event(&self, id: &str, event: Value) {
        let response = self.rpc(json!({
            "op": "event",
            "version": alinery_core::RUNNER_EVENT_PROTOCOL_VERSION,
            "session_id": id,
            "token": self.token_for(id),
            "event": event
        }));
        assert_eq!(response["ok"], true, "event response: {response}");
    }

    fn captured(&self, id: &str) -> Vec<u8> {
        fs::read(self.root.join(format!("message.bin.{id}"))).unwrap_or_default()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Ok(mut stream) = UnixStream::connect(&self.socket) {
            let _ = writeln!(stream, "{}", json!({"op": "shutdown"}));
            let mut line = String::new();
            let _ = BufReader::new(stream).read_line(&mut line);
        }
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn exact_body_framing_and_rejections_preserve_pty_bytes() {
    let fixture = Fixture::new();
    fixture.spawn("supported", "omp");
    fixture.event("supported", json!({"type": "idle"}));

    let body = "  first\n\nsecond\r猫🙂  ".as_bytes();
    assert_eq!(fixture.send_message("supported", body)["ok"], true);
    let expected = [BRACKETED_PASTE_START, body, BRACKETED_PASTE_END, MESSAGE_SUBMIT].concat();
    wait_until(Duration::from_secs(5), || fixture.captured("supported") == expected);

    let before = fixture.captured("supported");
    fixture.event("supported", json!({"type": "busy"}));
    assert_eq!(fixture.send_message("supported", b"busy")["error"], "session-not-idle");
    fixture.event("supported", json!({"type": "idle"}));
    assert_eq!(fixture.send_message("supported", b"")["error"], "message-body-empty");
    assert_eq!(fixture.send_message("supported", b"bad\x1b[201~body")["error"], "message-body-contains-bracketed-paste-end");
    assert_eq!(fixture.send_message("unknown", b"body")["error"], "unknown-session");
    assert_eq!(fixture.captured("supported"), before);

    assert_eq!(fixture.send_message("supported", b"  \n")["ok"], true);
    let expected_whitespace = [before.as_slice(), BRACKETED_PASTE_START, b"  \n", BRACKETED_PASTE_END, MESSAGE_SUBMIT].concat();
    wait_until(Duration::from_secs(5), || fixture.captured("supported") == expected_whitespace);

    fs::write(
        fixture.root.join(".alinery/harnesses.toml"),
        format!(
            r#"
[[harness]]
key = "omp"
name = "Unsupported capture"
binary = "sh"
args = ["-c", "stty raw -echo; cat >> '{}'"]
model_arg = []
prompt_injection = "arg"
adapter = "unsupported"
message_adapter = "unsupported"
"#,
            fixture.root.join("unsupported.bin").display(),
        ),
    )
    .unwrap();
    fixture.spawn("unsupported", "omp");
    assert_eq!(fixture.send_message("unsupported", b"body")["error"], "message-adapter-unsupported");
}

#[test]
fn message_body_limit_is_enforced_before_pty_delivery() {
    const MAX_MESSAGE_BODY_BYTES: usize = 4 * 1024 * 1024;

    let fixture = Fixture::new();
    fixture.spawn("limited", "omp");
    fixture.event("limited", json!({"type": "idle"}));

    let body = vec![b'x'; MAX_MESSAGE_BODY_BYTES];
    assert_eq!(fixture.send_message("limited", &body)["ok"], true);
    let expected_len = BRACKETED_PASTE_START.len() + body.len() + BRACKETED_PASTE_END.len() + MESSAGE_SUBMIT.len();
    wait_until(Duration::from_secs(10), || fixture.captured("limited").len() == expected_len);
    let captured = fixture.captured("limited");
    assert!(captured.starts_with(BRACKETED_PASTE_START));
    assert!(captured[BRACKETED_PASTE_START.len()..].starts_with(&body));
    assert!(captured.ends_with(&[BRACKETED_PASTE_END, MESSAGE_SUBMIT].concat()));

    let before = fixture.captured("limited");
    let rejected = fixture.send_message_header_only("limited", MAX_MESSAGE_BODY_BYTES + 1);
    assert_eq!(rejected["error"], "message-body-too-large");
    assert_eq!(rejected["delivery"], "not_sent");
    assert_eq!(fixture.captured("limited"), before);
}

#[test]
fn live_adapter_is_frozen_while_new_sessions_see_registry_edits() {
    let fixture = Fixture::new();
    fixture.spawn("first", "omp");
    fixture.event("first", json!({"type": "idle"}));

    let registry = fixture.root.join(".alinery/harnesses.toml");
    let changed = fs::read_to_string(&registry)
        .unwrap()
        .replacen("message_adapter = \"omp_bracketed_paste\"", "message_adapter = \"unsupported\"", 1);
    fs::write(&registry, changed).unwrap();

    assert_eq!(fixture.send_message("first", b"frozen")["ok"], true);
    let expected = [BRACKETED_PASTE_START, b"frozen", BRACKETED_PASTE_END, MESSAGE_SUBMIT].concat();
    wait_until(Duration::from_secs(5), || fixture.captured("first") == expected);

    fixture.spawn("second", "omp");
    fixture.event("second", json!({"type": "idle"}));
    assert_eq!(fixture.send_message("second", b"new")["error"], "message-adapter-unsupported");
    assert_eq!(fixture.captured("first"), expected);
}
