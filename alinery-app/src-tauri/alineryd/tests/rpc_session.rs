//! Fake-child coverage for native RPC transport and v2 execution-owner restate.
//! Unix-socket + overlay TOML; never launches live omp.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use alinery_core::SessionMeta;
use serde_json::{json, Value};

static ROOT_COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_root() -> PathBuf {
    let counter = ROOT_COUNTER.fetch_add(1, Ordering::Relaxed);
    PathBuf::from(format!("/tmp/sgrpc-{}-{counter}", std::process::id()))
}

fn wait_until(timeout: Duration, condition: impl Fn() -> bool) {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if condition() {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!("condition did not become true within {timeout:?}");
}

fn read_line_retry(stream: &mut UnixStream) -> String {
    stream.set_read_timeout(Some(Duration::from_millis(200))).unwrap();
    let mut reader = BufReader::new(stream);
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => panic!("daemon closed the connection"),
            Ok(_) => return line,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted
                ) =>
            {
                if Instant::now() >= deadline {
                    panic!("timed out waiting for daemon reply");
                }
            }
            Err(error) => panic!("read daemon reply: {error}"),
        }
    }
}

const PLAYBOOK: &str = r#"+++
version = 2
key = "transport"
title = "Transport fixture"
description = ""
default_model = ""
default_harness = "omp"
[[step]]
key = "run"
title = "Run"
short = ""
is_coding_step = false
auto_advance_default = false
model = ""
inputs = [{path = "ticket.md", mode = "single"}]
outputs = [{path = "result.md"}]
harness = "omp"
+++
<!-- alinery:step run -->
TRANSPORT_SEED_SENTINEL: read {{TICKET_FILE}} and produce the assigned result.
"#;

const FIXTURE_SCRIPT: &str = r#"#!/bin/sh
printf '%s\n' "$0" "$@" > "$ALINERY_REPO/argv.$ALINERY_SESSION_ID"
printf '%s' "${ALINERY_HOST_EXECUTABLE-}" > "$ALINERY_REPO/host.$ALINERY_SESSION_ID"
rpc=0
prev=
for a in "$@"; do
  if [ "$prev" = "--mode" ] && [ "$a" = "rpc" ]; then rpc=1; fi
  prev=$a
done
if [ "$rpc" = 1 ]; then
  printf '%s\n' '{"type":"ready"}'
  if [ -f "$ALINERY_REPO/emit-chunk.$ALINERY_SESSION_ID" ]; then
    printf '%s\n' '{"type":"rpc_chunk","chunkId":"rpc-1","index":0,"count":2,"byteLength":35,"data":"eyJ0eXBlIjoibm90aWNlIiw="}'
    printf '%s\n' '{"type":"rpc_chunk","chunkId":"rpc-1","index":1,"count":2,"byteLength":35,"data":"InRleHQiOiJjaHVuay1vayJ9"}'
  fi
  while IFS= read -r line; do
    printf '%s\n' "$line" >> "$ALINERY_REPO/stdin.$ALINERY_SESSION_ID"
    typ=`printf '%s' "$line" | sed -n 's/.*"type":"\([^"]*\)".*/\1/p'`
    method=`printf '%s' "$line" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p'`
    rid=`printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'`
    if [ "$typ" = "get_messages" ] || [ "$method" = "get_messages" ]; then
      printf '%s\n' "{\"type\":\"response\",\"id\":\"$rid\",\"command\":\"get_messages\",\"success\":true,\"data\":{\"messages\":[{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"hydrated thought\"},{\"type\":\"text\",\"text\":\"hydrated text\"}]}]}}"
      printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_start","contentIndex":0},"message":{"role":"assistant","content":[{"type":"thinking","thinking":""}]}}'
      printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"live"},"message":{"role":"assistant","content":[{"type":"thinking","thinking":"live"}]}}'
      printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","contentIndex":0},"message":{"role":"assistant","content":[{"type":"thinking","thinking":"live"},{"type":"text","text":"hi"}]}}'
    fi
  done
  exit 0
fi
if [ -n "${ALINERY_PTY_INITIAL_PROMPT-}" ]; then
  printf '%s' "$ALINERY_PTY_INITIAL_PROMPT" > "$ALINERY_REPO/editor.$ALINERY_SESSION_ID"
  printf '%s' "$ALINERY_EVENT_TOKEN" > "$ALINERY_REPO/token.$ALINERY_SESSION_ID"
  if IFS= read -r submitted; then
    printf '%s' "$ALINERY_PTY_INITIAL_PROMPT" > "$ALINERY_REPO/submitted.$ALINERY_SESSION_ID"
  fi
fi
sleep 30
"#;

struct Fixture {
    root: PathBuf,
    socket: PathBuf,
    child: Child,
    host: PathBuf,
    session_id: String,
}

impl Fixture {
    fn new() -> Self {
        let root = unique_root();
        fs::create_dir_all(root.join(".alinery")).unwrap();
        for args in [
            vec!["init", "--quiet"],
            vec![
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        ] {
            assert!(alinery_core::git_cmd(&root).args(args).status().unwrap().success());
        }
        fs::write(root.join("host-executable"), b"host fixture").unwrap();
        let mut host_permissions = fs::metadata(root.join("host-executable")).unwrap().permissions();
        host_permissions.set_mode(0o755);
        fs::set_permissions(root.join("host-executable"), host_permissions).unwrap();
        let host = fs::canonicalize(root.join("host-executable")).unwrap();

        let fixture_bin = root.join("omp-fixture");
        fs::write(&fixture_bin, FIXTURE_SCRIPT).unwrap();
        let mut bin_permissions = fs::metadata(&fixture_bin).unwrap().permissions();
        bin_permissions.set_mode(0o755);
        fs::set_permissions(&fixture_bin, bin_permissions).unwrap();

        let ext = root.join("fake-ext");
        fs::create_dir_all(&ext).unwrap();
        fs::write(ext.join("index.ts"), "export {}").unwrap();

        let runner = root.join("fake-alinery-runner");
        // Baked in, not inherited: an OMP child only gets `OMP_ENV_ALLOWLIST` from the daemon.
        let capture = root.join("runner-events.tsv");
        fs::write(
            &runner,
            format!(
                r#"#!/bin/sh
printf '%s\n' "$@" > "{capture}.$ALINERY_SESSION_ID.args"
shift 4
bin="$1"
shift
exec "$bin" --extension "{ext}" "$@"
"#,
                capture = capture.display(),
                ext = ext.display()
            ),
        )
        .unwrap();
        let mut runner_permissions = fs::metadata(&runner).unwrap().permissions();
        runner_permissions.set_mode(0o755);
        fs::set_permissions(&runner, runner_permissions).unwrap();

        fs::write(
            root.join(".alinery/harnesses.toml"),
            format!(
                r#"
[[harness]]
key = "omp"
name = "OMP fixture"
binary = "{}"
args = []
model_arg = []
prompt_injection = "arg"
adapter = "omp"

[harness.resume]
enabled = true
id_source = "manual"
resume_args = ["--resume={{resume_token}}"]
"#,
                fixture_bin.display()
            ),
        )
        .unwrap();

        let (child, socket) = start_daemon(&root, &runner, &capture, Some(&host));
        let mut fixture = Self {
            root,
            socket,
            child,
            host,
            session_id: String::new(),
        };
        let created = fixture.rpc(json!({"op": "create_task", "request": {
            "name": "task", "requested_slug": "task",
            "playbook": {"reference": {"scope": "repo", "key": "transport"}, "source": PLAYBOOK},
            "start": false
        }}));
        assert_eq!(created["creation"], "ready", "{created}");
        assert_eq!(created["errors"], json!([]), "{created}");
        fixture.session_id = created["sessions"][0]["id"].as_str().expect("reserved owner").into();
        fixture
    }

    fn rpc(&self, mut request: Value) -> Value {
        if request["op"] == "create_task" {
            let client = alinery_core::DaemonClient { socket_path: self.socket.clone() };
            let request = serde_json::from_value(request.get_mut("request").unwrap().take()).unwrap();
            return match client.create_task(&request) {
                Ok(reply) => serde_json::to_value(reply).unwrap(),
                Err(error) => json!({"error": error}),
            };
        }
        let mut stream = UnixStream::connect(&self.socket).unwrap();
        writeln!(stream, "{request}").unwrap();
        let line = read_line_retry(&mut stream);
        serde_json::from_str(line.trim()).unwrap_or_else(|error| panic!("bad json {error}: {line}"))
    }

    fn spawn_omp(&self) -> &str {
        let reply = self.rpc(json!({"op": "start_session", "request": {
            "task_slug": "task", "session_id": self.session_id
        }}));
        assert_eq!(reply["start"], "started", "start response: {reply}");
        assert_eq!(reply["errors"], json!([]), "{reply}");
        &self.session_id
    }

    fn execution(&self) -> Value {
        let reply = self.rpc(json!({"op": "get_task_execution", "request": {"task_slug": "task"}}));
        let id = self.meta(&self.session_id).execution_id;
        reply["state"]["executions"][&id].clone()
    }

    fn restate(&self, id: &str, transport: &str) -> Value {
        self.rpc(json!({"op": "restate", "id": id, "transport": transport}))
    }

    fn rpc_attach(&self, id: &str) -> BufReader<UnixStream> {
        let mut stream = UnixStream::connect(&self.socket).unwrap();
        stream.set_read_timeout(Some(Duration::from_millis(200))).unwrap();
        writeln!(stream, "{}", json!({"op": "rpc_attach", "id": id, "attach_id": 7})).unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            match reader.read_line(&mut line) {
                Ok(0) => panic!("rpc_attach: daemon closed"),
                Ok(_) => break,
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    if Instant::now() >= deadline {
                        panic!("rpc_attach timed out");
                    }
                    thread::sleep(Duration::from_millis(25));
                    continue;
                }
                Err(error) => panic!("rpc_attach: {error}"),
            }
        }
        assert!(line.contains("\"ok\":true"), "rpc_attach ack: {line}");
        reader
    }

    fn read_lines(reader: &mut BufReader<UnixStream>, min: usize) -> Vec<String> {
        let mut lines = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while lines.len() < min && Instant::now() < deadline {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => lines.push(line.trim_end_matches(['\n', '\r']).to_string()),
                Err(_) => thread::sleep(Duration::from_millis(25)),
            }
        }
        lines
    }

    fn meta(&self, id: &str) -> SessionMeta {
        let path = self.root.join(".alinery/tasks/task/sessions").join(format!("{id}.meta.json"));
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    fn argv(&self, id: &str) -> String {
        wait_until(Duration::from_secs(5), || self.root.join(format!("argv.{id}")).is_file());
        fs::read_to_string(self.root.join(format!("argv.{id}"))).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.rpc(json!({"op": "shutdown"}));
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn start_daemon(root: &Path, runner: &Path, capture: &Path, protected_host: Option<&Path>) -> (Child, PathBuf) {
    let socket = root.join(".alinery/alineryd.sock");
    let mut command = Command::new(env!("CARGO_BIN_EXE_alineryd"));
    command
        .arg("--repo")
        .arg(root)
        .arg("--build-id")
        .arg("rpc-test")
        .arg("--app-config")
        .arg(root.join(".alinery/unused-app-config.toml"))
        .env_remove("ALINERY_HOST_EXECUTABLE")
        .env("ALINERY_RUNNER_PATH", runner)
        .env("ALINERY_RUNNER_CAPTURE", capture)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(protected_host) = protected_host {
        command.env("ALINERY_HOST_EXECUTABLE", protected_host);
    }
    let mut child = command.spawn().unwrap();
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        if let Some(status) = child.try_wait().unwrap() {
            let mut stderr = String::new();
            if let Some(pipe) = child.stderr.as_mut() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            panic!("alineryd exited before readiness with {status}; stderr: {stderr}");
        }
        if socket.exists() {
            if let Ok(mut stream) = UnixStream::connect(&socket) {
                let _ = writeln!(stream, r#"{{"op":"version"}}"#);
                let mut line = String::new();
                if BufReader::new(stream).read_line(&mut line).is_ok() && line.contains("build_id") {
                    return (child, socket);
                }
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    let _ = child.kill();
    let _ = child.wait();
    panic!("alineryd did not become ready");
}

#[test]
fn spawn_omp_is_rpc_and_restate_pty_keeps_id() {
    let fixture = Fixture::new();
    let id = fixture.spawn_omp();
    let before = fixture.execution();
    assert_eq!(before["lifecycle"], "running", "{before}");
    let status = fixture.rpc(json!({"op": "status", "id": id}));
    assert_eq!(status["transport"], "rpc", "{status}");
    let reply = fixture.restate(id, "pty");
    assert_eq!(reply.get("ok"), Some(&json!(true)), "restate reply: {reply}");
    let meta = fixture.meta(id);
    assert!(meta.started_at.is_some());
    assert!(meta.ended_at.is_none());
    let status = fixture.rpc(json!({"op": "status", "id": id}));
    assert_ne!(status.get("error"), Some(&json!("unknown-session")));
    assert_eq!(status["transport"], "pty");
    let after = fixture.execution();
    assert_eq!(after["id"], before["id"], "restate must preserve the execution");
    assert_eq!(after["owner_session_id"], id, "restate must preserve the owner");
    assert_eq!(after["lifecycle"], "running", "{after}");
}

#[test]
#[ignore = "subprocess fixture for delayed RPC output drain"]
fn delayed_rpc_output_child() {
    let root = PathBuf::from(std::env::var("ALINERY_REPO").unwrap());
    assert_ne!(unsafe { libc::setsid() }, -1);
    fs::write(root.join("output-holder-ready"), "").unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while root.exists() && !root.join("release-output-holder").exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn failed_restate_recovers_after_delayed_output_drain() {
    let fixture = Fixture::new();
    let helper = std::env::current_exe().unwrap().display().to_string().replace('\'', "'\\''");
    fs::write(
        fixture.root.join("omp-fixture"),
        FIXTURE_SCRIPT.replacen(
            "#!/bin/sh\n",
            &format!("#!/bin/sh\n'{helper}' --ignored --exact delayed_rpc_output_child --nocapture &\n"),
            1,
        ),
    )
    .unwrap();
    let id = fixture.spawn_omp();
    wait_until(Duration::from_secs(5), || fixture.root.join("output-holder-ready").exists());
    let reply = fixture.restate(id, "pty");
    assert!(reply["error"].as_str().is_some_and(|error| error.contains("not proven")), "{reply}");
    let pending = fixture.execution();
    assert_eq!(pending["lifecycle"], "interrupted");
    assert_eq!(pending["shutdown_confirmed"], false);
    fs::write(fixture.root.join("release-output-holder"), "").unwrap();
    wait_until(Duration::from_secs(5), || fixture.execution()["shutdown_confirmed"] == true);
    let stopped = fixture.execution();
    assert_eq!(stopped["lifecycle"], "failed");
    let recovered = fixture.rpc(json!({"op": "create_execution_session", "request": {
        "task_slug": "task",
        "target": {"kind": "primary", "step_key": "run", "execution_id": stopped["id"]},
        "start": false
    }}));
    assert_eq!(recovered["start"], "not_requested", "{recovered}");
    assert_ne!(recovered["session"]["id"], id);
}

#[test]
fn rpc_negotiates_protocol_v2_before_seed_prompt() {
    let fixture = Fixture::new();
    let id = fixture.spawn_omp();
    let stdin_path = fixture.root.join(format!("stdin.{id}"));
    wait_until(Duration::from_secs(5), || {
        fs::read_to_string(&stdin_path).is_ok_and(|text| text.contains("TRANSPORT_SEED_SENTINEL"))
    });
    let stdin = fs::read_to_string(&stdin_path).unwrap();
    let negotiate = stdin.find("negotiate_protocol").expect("negotiate_protocol missing");
    let seed = stdin.find(r#""type":"prompt""#).or_else(|| stdin.find(r#""type": "prompt""#)).expect("seed prompt missing");
    assert!(negotiate < seed, "negotiate must precede seed prompt:\n{stdin}");
    assert!(stdin.contains(r#""protocolVersion":2"#) || stdin.contains(r#""protocolVersion": 2"#), "{stdin}");
}

#[test]
fn rpc_attach_forwards_ready_and_get_messages_thinking() {
    let fixture = Fixture::new();
    let id = fixture.spawn_omp();
    let mut attach = fixture.rpc_attach(id);
    let request = json!({"id": "1", "type": "get_messages"});
    let write = fixture.rpc(json!({"op": "rpc_write", "id": id, "payload": request}));
    assert_eq!(write.get("ok"), Some(&json!(true)), "rpc_write: {write}");
    let lines = Fixture::read_lines(&mut attach, 5);
    let joined = lines.join("\n");
    assert!(joined.contains(r#""type":"ready""#), "lines: {joined}");
    assert!(joined.contains(r#""type":"thinking""#), "lines: {joined}");
    assert!(!lines.iter().any(|line| line == &request.to_string()), "stdin echoed: {joined}");
}

#[test]
fn pty_ops_on_rpc_are_wrong_transport() {
    let fixture = Fixture::new();
    let id = fixture.spawn_omp();
    for request in [
        json!({"op": "attach", "id": id, "attach_id": 1}),
        json!({"op": "write", "id": id, "data": "x"}),
        json!({"op": "resize", "id": id, "cols": 80, "rows": 24}),
    ] {
        let reply = fixture.rpc(request.clone());
        let error = reply.get("error").and_then(Value::as_str).unwrap_or("");
        assert!(error.contains("wrong-transport"), "{request} => {reply}");
    }
    let mut stream = UnixStream::connect(&fixture.socket).unwrap();
    writeln!(stream, "{}", json!({"op": "send_message", "id": id, "body_bytes": 1})).unwrap();
    stream.write_all(b"x").unwrap();
    stream.flush().unwrap();
    let line = read_line_retry(&mut stream);
    assert!(line.contains("wrong-transport"), "send_message: {line}");
}

#[test]
fn rpc_write_on_pty_is_wrong_transport() {
    let fixture = Fixture::new();
    let id = fixture.spawn_omp();
    assert_eq!(fixture.restate(id, "pty").get("ok"), Some(&json!(true)));
    let reply = fixture.rpc(json!({"op": "rpc_write", "id": id, "payload": {"type": "prompt", "message": "hi"}}));
    let error = reply.get("error").and_then(Value::as_str).unwrap_or("");
    assert!(error.contains("wrong-transport"), "{reply}");
}

#[test]
fn status_and_list_report_rpc_on_omp_spawn() {
    let fixture = Fixture::new();
    let id = fixture.spawn_omp();
    let status = fixture.rpc(json!({"op": "status", "id": id}));
    assert_eq!(status["transport"], "rpc");
    let list = fixture.rpc(json!({"op": "list"}));
    let sessions = list["sessions"].as_array().expect("sessions");
    assert!(sessions.iter().any(|session| session["id"] == id && session["transport"] == "rpc"));
}

#[test]
fn failed_rpc_restate_does_not_silent_pty_attach() {
    let fixture = Fixture::new();
    let id = fixture.spawn_omp();
    // Restate must exec a new file (Darwin often keeps the running omp-fixture inode)
    // and skip the OMP runner: runner+shell routinely outlives the 300ms crash-before-ready
    // window under cargo-test load, so restate returned ok and this assertion flaked.
    fs::write(
        fixture.root.join(".alinery/harnesses.toml"),
        r#"
[[harness]]
key = "omp"
name = "OMP fixture"
binary = "/usr/bin/false"
args = []
model_arg = []
prompt_injection = "arg"
adapter = "unsupported"
"#,
    )
    .unwrap();
    let reply = fixture.restate(id, "rpc");
    assert!(reply.get("error").is_some(), "failed restate should error: {reply}");
    let meta = fixture.meta(id);
    let ended_or_interrupted =
        meta.ended_at.is_some() || (meta.started_at.is_some() && fixture.rpc(json!({"op": "status", "id": id})).get("error") == Some(&json!("unknown-session")));
    assert!(ended_or_interrupted, "failed restate must classify ended or interrupted");
    let execution = fixture.execution();
    assert_eq!(execution["owner_session_id"], id);
    assert!(matches!(execution["lifecycle"].as_str(), Some("launch_failed" | "interrupted")), "{execution}");
    assert!(execution["receipt_id"].is_null(), "failed restate cannot complete graph work");
    let attach = fixture.rpc(json!({"op": "attach", "id": id, "attach_id": 1}));
    let error = attach.get("error").and_then(Value::as_str).unwrap_or("");
    assert!(
        error.contains("unknown-session") || error.contains("wrong-transport"),
        "attach after failed restate: {attach}"
    );
}

#[test]
fn kill_after_rpc_stamps_ended_at() {
    let fixture = Fixture::new();
    let id = fixture.spawn_omp();
    let kill = fixture.rpc(json!({"op": "kill", "id": id}));
    assert_eq!(kill.get("ok"), Some(&json!(true)), "{kill}");
    wait_until(Duration::from_secs(5), || fixture.meta(id).ended_at.is_some());
    assert_eq!(fixture.rpc(json!({"op": "status", "id": id}))["error"], "unknown-session");
}

#[test]
fn rpc_argv_has_extension_mode_thinking_session_dir() {
    let fixture = Fixture::new();
    let id = fixture.spawn_omp();
    let argv = fixture.argv(id);
    assert!(argv.contains("--extension"), "{argv}");
    assert!(argv.contains("--mode"), "{argv}");
    assert!(argv.contains("rpc"), "{argv}");
    assert!(argv.contains("--thinking"), "{argv}");
    assert!(argv.contains("high"), "{argv}");
    assert!(argv.contains("--session-dir"), "{argv}");
    assert!(argv.contains(&format!("{id}.omp")), "{argv}");
    assert!(!argv.contains("--trusted-extension"), "{argv}");
    wait_until(Duration::from_secs(5), || fixture.root.join(format!("host.{id}")).is_file());
    assert_eq!(fs::read_to_string(fixture.root.join(format!("host.{id}"))).unwrap(), fixture.host.to_string_lossy());
}

#[test]
fn pty_argv_omits_mode_rpc_and_thinking_high() {
    let fixture = Fixture::new();
    let id = fixture.spawn_omp();
    let _ = fs::remove_file(fixture.root.join(format!("argv.{id}")));
    assert_eq!(fixture.restate(id, "pty").get("ok"), Some(&json!(true)));
    let argv = fixture.argv(id);
    assert!(argv.contains("--session-dir"), "{argv}");
    assert!(!argv.contains("--mode"), "{argv}");
    assert!(!argv.contains("\nrpc\n") && !argv.ends_with("rpc"), "{argv}");
    assert!(!argv.contains("--thinking"), "{argv}");
}

// "Newest" means newest by FILENAME, not mtime. OMP names journals `<timestamp>_<uuidv7>.jsonl`
// (both halves monotonic) and rewrites the fixed 256-byte title record in place via
// `updateSessionTitle`, which moves mtime without adding any conversation. So the fixture writes
// the newer-by-name file FIRST and then backdates it, leaving mtime pointing at the wrong file:
// only filename ordering resumes the journal that actually holds the conversation.
#[test]
fn restate_resume_uses_newest_jsonl_in_session_dir() {
    let fixture = Fixture::new();
    let id = fixture.spawn_omp();
    let dir = fixture.root.join(format!(".alinery/tasks/task/sessions/{id}.omp"));
    fs::create_dir_all(&dir).unwrap();
    let older = dir.join("2026-01-01T00-00-00Z_0193a1.jsonl");
    let newer = dir.join("2026-02-01T00-00-00Z_0193b2.jsonl");
    fs::write(&newer, "new\n").unwrap();
    thread::sleep(Duration::from_millis(20));
    fs::write(&older, "old\n").unwrap();
    let _ = filetime_touch(&newer, SystemTime::now() - Duration::from_secs(3600));
    let _ = fs::remove_file(fixture.root.join(format!("argv.{id}")));
    assert_eq!(fixture.restate(id, "rpc").get("ok"), Some(&json!(true)));
    let argv = fixture.argv(id);
    let newer_abs = fs::canonicalize(&newer).unwrap();
    assert!(
        argv.contains(&format!("--resume\n{}", newer_abs.display())) || argv.contains(&newer_abs.display().to_string()),
        "{argv}"
    );
    let meta = fixture.meta(id);
    assert_eq!(meta.harness_resume_token, newer_abs.to_string_lossy());
    assert_eq!(meta.harness, "omp");
    assert_eq!(meta.id, id);
}

#[test]
fn restate_without_jsonl_passes_session_dir_only() {
    let fixture = Fixture::new();
    let id = fixture.spawn_omp();
    assert_eq!(fixture.restate(id, "rpc").get("ok"), Some(&json!(true)));
    let argv = fixture.argv(id);
    assert!(argv.contains("--session-dir"), "{argv}");
    assert!(!argv.contains("--resume"), "{argv}");
}

// A restate kills the current child, and the Settings "prefer Terminal" restate fires as soon as
// the session goes live — possibly before the RPC child ever reached `ready` and got its seed.
// The journal, not the restate flag, says whether anything durable survived that kill.
#[test]
fn restate_reseeds_assigned_prompt_only_without_jsonl() {
    let fixture = Fixture::new();
    let id = fixture.spawn_omp();
    let argv_path = fixture.root.join(format!("argv.{id}"));

    let _ = fs::remove_file(&argv_path);
    assert_eq!(fixture.restate(id, "pty").get("ok"), Some(&json!(true)));
    let editor = fixture.root.join(format!("editor.{id}"));
    let submitted = fixture.root.join(format!("submitted.{id}"));
    wait_until(Duration::from_secs(5), || editor.is_file() && fixture.root.join(format!("token.{id}")).is_file());
    let token = fs::read_to_string(fixture.root.join(format!("token.{id}"))).unwrap();
    assert!(!submitted.exists(), "the seed must wait until the editor reports readiness");
    assert_eq!(
        fixture.rpc(json!({"op":"event", "version":alinery_core::RUNNER_EVENT_PROTOCOL_VERSION, "session_id":id, "token":token, "event":{"type":"idle"}}))["ok"],
        true
    );
    wait_until(Duration::from_secs(5), || {
        fs::read_to_string(&submitted).is_ok_and(|body| body.contains("TRANSPORT_SEED_SENTINEL"))
    });
    let body = fs::read_to_string(&submitted).unwrap();
    assert_eq!(body.matches("TRANSPORT_SEED_SENTINEL").count(), 1);
    let execution = fixture.execution();
    let assigned_output = fixture
        .root
        .join(".alinery/tasks/task/artifacts")
        .join(execution["outputs"][0]["relative_path"].as_str().unwrap());
    assert!(
        body.contains(assigned_output.to_str().unwrap()),
        "the replacement must receive its actual output assignment"
    );
    let argv = fixture.argv(id);
    assert!(!argv.contains("--resume"), "{argv}");

    let dir = fixture.root.join(format!(".alinery/tasks/task/sessions/{id}.omp"));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("2026-03-01T00-00-00Z_0193c3.jsonl"), "turn\n").unwrap();
    let _ = fs::remove_file(&argv_path);
    fs::remove_file(&editor).unwrap();
    fs::remove_file(&submitted).unwrap();
    assert_eq!(fixture.restate(id, "pty").get("ok"), Some(&json!(true)));
    let argv = fixture.argv(id);
    assert!(argv.contains("--resume"), "{argv}");
    assert!(!argv.contains("TRANSPORT_SEED_SENTINEL"), "a resumed restate must not replay the seed: {argv}");
    assert!(!editor.exists(), "resuming a journal must not overwrite the editor with a fresh seed");
    assert!(!submitted.exists());
}

#[test]
fn rpc_unknown_id() {
    let fixture = Fixture::new();
    for request in [
        json!({"op": "rpc_attach", "id": "missing", "attach_id": 1}),
        json!({"op": "rpc_write", "id": "missing", "payload": {"id": "1", "method": "prompt"}}),
        json!({"op": "restate", "id": "missing", "transport": "rpc"}),
    ] {
        let reply = fixture.rpc(request);
        assert_eq!(reply.get("error"), Some(&json!("unknown-session")), "{reply}");
    }
}

#[test]
fn rpc_does_not_create_scrollback() {
    let fixture = Fixture::new();
    let id = fixture.spawn_omp();
    thread::sleep(Duration::from_millis(100));
    let scrollback = fixture.root.join(format!(".alinery/tasks/task/sessions/{id}.scrollback"));
    if scrollback.exists() {
        let bytes = fs::read(&scrollback).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("\"type\":\"ready\""), "NDJSON leaked into scrollback");
    }
}

#[test]
fn rpc_chunk_reassembles_before_clients() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join(format!("emit-chunk.{}", fixture.session_id)), b"").unwrap();
    let id = fixture.spawn_omp();
    let mut attach = fixture.rpc_attach(id);
    let lines = Fixture::read_lines(&mut attach, 2);
    let joined = lines.join("\n");
    assert!(joined.contains(r#""text":"chunk-ok""#), "lines: {joined}");
    assert!(!joined.contains("rpc_chunk"), "raw chunks leaked: {joined}");
}

fn filetime_touch(path: &Path, when: SystemTime) -> std::io::Result<()> {
    let file = fs::OpenOptions::new().write(true).open(path)?;
    file.set_modified(when)
}

// The setup session exists so the accounts dialog has an OMP to query before any real session
// does. It must be a first-class RPC session to `rpc_attach`/`rpc_write` and invisible to
// everything else: no journal on disk, and no phantom row in `list` (which feeds the board and
// every session count).
#[test]
fn omp_setup_session_is_attachable_but_never_a_listed_session() {
    let fixture = Fixture::new();

    let opened = fixture.rpc(json!({"op": "omp_setup"}));
    assert_eq!(opened["ok"], json!(true), "omp_setup: {opened}");
    let id = opened["id"].as_str().expect("setup reply carries an id").to_string();

    // A second request must reuse the one already up rather than start a second OMP.
    let again = fixture.rpc(json!({"op": "omp_setup"}));
    assert_eq!(again["id"].as_str(), Some(id.as_str()), "second omp_setup: {again}");

    let listed = fixture.rpc(json!({"op": "list"}));
    let ids: Vec<&str> = listed["sessions"]
        .as_array()
        .map(|rows| rows.iter().filter_map(|row| row["id"].as_str()).collect())
        .unwrap_or_default();
    assert!(!ids.contains(&id.as_str()), "setup session must not be listed: {listed}");

    // Writable like any RPC session: this is what lets the existing dialog drive it unchanged.
    let written = fixture.rpc(json!({"op": "rpc_write", "id": id, "payload": {"type": "get_login_providers", "id": "p1"}}));
    assert_eq!(written["ok"], json!(true), "rpc_write to setup session: {written}");

    // No `--session-dir`, so nothing on disk claims this was a session.
    let argv = fixture.argv(&id);
    assert!(argv.contains("--mode"), "{argv}");
    assert!(
        argv.lines().any(|arg| arg == "--model=openai-codex/gpt-5.5"),
        "setup must start without saved credentials: {argv}"
    );
    assert!(!argv.contains("--session-dir"), "setup session must not be given a journal: {argv}");
    assert!(!fixture.root.join(format!(".alinery/sessions/{id}.omp")).exists());

    let _ = fixture.rpc(json!({"op": "kill", "id": id}));
}
