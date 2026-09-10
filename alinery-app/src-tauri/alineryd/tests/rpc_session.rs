//! Fake-child coverage for protocol-8 RPC transport and restate.
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

use alinery_core::{SessionMeta, Task};
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
sleep 30
"#;

struct Fixture {
    root: PathBuf,
    socket: PathBuf,
    child: Child,
    host: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = unique_root();
        fs::create_dir_all(root.join(".alinery")).unwrap();
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
        Self { root, socket, child, host }
    }

    fn rpc(&self, request: Value) -> Value {
        let mut stream = UnixStream::connect(&self.socket).unwrap();
        writeln!(stream, "{request}").unwrap();
        let line = read_line_retry(&mut stream);
        serde_json::from_str(line.trim()).unwrap_or_else(|error| panic!("bad json {error}: {line}"))
    }

    fn spawn_omp(&self, id: &str) {
        write_task_and_source(&self.root, id);
        let reply = self.rpc(json!({
            "op": "spawn",
            "id": id,
            "cwd": self.root,
            "task_slug": "task",
            "harness": "omp",
            "model": "",
            "phase": "research-questions",
        }));
        assert_eq!(reply.get("ok"), Some(&json!(true)), "spawn response: {reply}");
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

fn write_task_and_source(root: &Path, id: &str) {
    let task_dir = root.join(".alinery/tasks/task");
    let sessions = task_dir.join("sessions");
    fs::create_dir_all(task_dir.join("artifacts")).unwrap();
    fs::create_dir_all(&sessions).unwrap();
    let task = Task {
        name: "task".into(),
        slug: "task".into(),
        branch: "task".into(),
        worktree: root.to_string_lossy().into_owned(),
        has_worktree: true,
        created: 1,
        playbook: "superdevelop".into(),
        ..Default::default()
    };
    fs::write(task_dir.join("task.md"), toml::to_string(&task).unwrap()).unwrap();
    let source = SessionMeta {
        id: id.into(),
        worktree: root.to_string_lossy().into_owned(),
        created: 1,
        phase: "research-questions".into(),
        harness: "omp".into(),
        playbook: "superdevelop".into(),
        artifact: "01-research-questions.md".into(),
        ..Default::default()
    };
    fs::write(sessions.join(format!("{id}.meta.json")), serde_json::to_vec(&source).unwrap()).unwrap();
}

#[test]
fn spawn_omp_is_rpc_and_restate_pty_keeps_id() {
    let fixture = Fixture::new();
    fixture.spawn_omp("s1");
    let status = fixture.rpc(json!({"op": "status", "id": "s1"}));
    assert_eq!(status["transport"], "rpc", "{status}");
    let reply = fixture.restate("s1", "pty");
    assert_eq!(reply.get("ok"), Some(&json!(true)), "restate reply: {reply}");
    let meta = fixture.meta("s1");
    assert!(meta.started_at.is_some());
    assert!(meta.ended_at.is_none());
    let status = fixture.rpc(json!({"op": "status", "id": "s1"}));
    assert_ne!(status.get("error"), Some(&json!("unknown-session")));
    assert_eq!(status["transport"], "pty");
}

#[test]
fn rpc_negotiates_protocol_v2_before_seed_prompt() {
    let fixture = Fixture::new();
    fixture.spawn_omp("s1");
    let stdin_path = fixture.root.join("stdin.s1");
    wait_until(Duration::from_secs(5), || {
        stdin_path.is_file() && fs::read_to_string(&stdin_path).unwrap().contains("negotiate_protocol")
    });
    let stdin = fs::read_to_string(&stdin_path).unwrap();
    let negotiate = stdin.find("negotiate_protocol").expect("negotiate_protocol missing");
    let seed = stdin.find(r#""type":"prompt""#).or_else(|| stdin.find(r#""type": "prompt""#));
    if let Some(seed) = seed {
        assert!(negotiate < seed, "negotiate must precede seed prompt:\n{stdin}");
    }
    assert!(stdin.contains(r#""protocolVersion":2"#) || stdin.contains(r#""protocolVersion": 2"#), "{stdin}");
}

#[test]
fn rpc_attach_forwards_ready_and_get_messages_thinking() {
    let fixture = Fixture::new();
    fixture.spawn_omp("s1");
    let mut attach = fixture.rpc_attach("s1");
    let request = json!({"id": "1", "type": "get_messages"});
    let write = fixture.rpc(json!({"op": "rpc_write", "id": "s1", "payload": request}));
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
    fixture.spawn_omp("s1");
    for request in [
        json!({"op": "attach", "id": "s1", "attach_id": 1}),
        json!({"op": "write", "id": "s1", "data": "x"}),
        json!({"op": "resize", "id": "s1", "cols": 80, "rows": 24}),
    ] {
        let reply = fixture.rpc(request.clone());
        let error = reply.get("error").and_then(Value::as_str).unwrap_or("");
        assert!(error.contains("wrong-transport"), "{request} => {reply}");
    }
    let mut stream = UnixStream::connect(&fixture.socket).unwrap();
    writeln!(stream, "{}", json!({"op": "send_message", "id": "s1", "body_bytes": 1})).unwrap();
    stream.write_all(b"x").unwrap();
    stream.flush().unwrap();
    let line = read_line_retry(&mut stream);
    assert!(line.contains("wrong-transport"), "send_message: {line}");
}

#[test]
fn rpc_write_on_pty_is_wrong_transport() {
    let fixture = Fixture::new();
    fixture.spawn_omp("s1");
    assert_eq!(fixture.restate("s1", "pty").get("ok"), Some(&json!(true)));
    let reply = fixture.rpc(json!({"op": "rpc_write", "id": "s1", "payload": {"type": "prompt", "message": "hi"}}));
    let error = reply.get("error").and_then(Value::as_str).unwrap_or("");
    assert!(error.contains("wrong-transport"), "{reply}");
}

#[test]
fn status_and_list_report_rpc_on_omp_spawn() {
    let fixture = Fixture::new();
    fixture.spawn_omp("s1");
    let status = fixture.rpc(json!({"op": "status", "id": "s1"}));
    assert_eq!(status["transport"], "rpc");
    let list = fixture.rpc(json!({"op": "list"}));
    let sessions = list["sessions"].as_array().expect("sessions");
    assert!(sessions.iter().any(|session| session["id"] == "s1" && session["transport"] == "rpc"));
}

#[test]
fn failed_rpc_restate_does_not_silent_pty_attach() {
    let fixture = Fixture::new();
    fixture.spawn_omp("s1");
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
    let reply = fixture.restate("s1", "rpc");
    assert!(reply.get("error").is_some(), "failed restate should error: {reply}");
    let meta = fixture.meta("s1");
    let ended_or_interrupted =
        meta.ended_at.is_some() || (meta.started_at.is_some() && fixture.rpc(json!({"op": "status", "id": "s1"})).get("error") == Some(&json!("unknown-session")));
    assert!(ended_or_interrupted, "failed restate must classify ended or interrupted");
    let attach = fixture.rpc(json!({"op": "attach", "id": "s1", "attach_id": 1}));
    let error = attach.get("error").and_then(Value::as_str).unwrap_or("");
    assert!(
        error.contains("unknown-session") || error.contains("wrong-transport"),
        "attach after failed restate: {attach}"
    );
}

#[test]
fn kill_after_rpc_stamps_ended_at() {
    let fixture = Fixture::new();
    fixture.spawn_omp("s1");
    let kill = fixture.rpc(json!({"op": "kill", "id": "s1"}));
    assert_eq!(kill.get("ok"), Some(&json!(true)), "{kill}");
    wait_until(Duration::from_secs(5), || fixture.meta("s1").ended_at.is_some());
    assert_eq!(fixture.rpc(json!({"op": "status", "id": "s1"}))["error"], "unknown-session");
}

#[test]
fn rpc_argv_has_extension_mode_thinking_session_dir() {
    let fixture = Fixture::new();
    fixture.spawn_omp("s1");
    let argv = fixture.argv("s1");
    assert!(argv.contains("--extension"), "{argv}");
    assert!(argv.contains("--mode"), "{argv}");
    assert!(argv.contains("rpc"), "{argv}");
    assert!(argv.contains("--thinking"), "{argv}");
    assert!(argv.contains("high"), "{argv}");
    assert!(argv.contains("--session-dir"), "{argv}");
    assert!(argv.contains("s1.omp"), "{argv}");
    assert!(!argv.contains("--trusted-extension"), "{argv}");
    wait_until(Duration::from_secs(5), || fixture.root.join("host.s1").is_file());
    assert_eq!(fs::read_to_string(fixture.root.join("host.s1")).unwrap(), fixture.host.to_string_lossy());
}

#[test]
fn pty_argv_omits_mode_rpc_and_thinking_high() {
    let fixture = Fixture::new();
    fixture.spawn_omp("s1");
    let _ = fs::remove_file(fixture.root.join("argv.s1"));
    assert_eq!(fixture.restate("s1", "pty").get("ok"), Some(&json!(true)));
    let argv = fixture.argv("s1");
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
    fixture.spawn_omp("s1");
    let dir = fixture.root.join(".alinery/tasks/task/sessions/s1.omp");
    fs::create_dir_all(&dir).unwrap();
    let older = dir.join("2026-01-01T00-00-00Z_0193a1.jsonl");
    let newer = dir.join("2026-02-01T00-00-00Z_0193b2.jsonl");
    fs::write(&newer, "new\n").unwrap();
    thread::sleep(Duration::from_millis(20));
    fs::write(&older, "old\n").unwrap();
    let _ = filetime_touch(&newer, SystemTime::now() - Duration::from_secs(3600));
    let _ = fs::remove_file(fixture.root.join("argv.s1"));
    assert_eq!(fixture.restate("s1", "rpc").get("ok"), Some(&json!(true)));
    let argv = fixture.argv("s1");
    let newer_abs = fs::canonicalize(&newer).unwrap();
    assert!(
        argv.contains(&format!("--resume\n{}", newer_abs.display())) || argv.contains(&newer_abs.display().to_string()),
        "{argv}"
    );
    let meta = fixture.meta("s1");
    assert_eq!(meta.harness_resume_token, newer_abs.to_string_lossy());
    assert_eq!(meta.harness, "omp");
    assert_eq!(meta.id, "s1");
}

#[test]
fn restate_without_jsonl_passes_session_dir_only() {
    let fixture = Fixture::new();
    fixture.spawn_omp("s1");
    assert_eq!(fixture.restate("s1", "rpc").get("ok"), Some(&json!(true)));
    let argv = fixture.argv("s1");
    assert!(argv.contains("--session-dir"), "{argv}");
    assert!(!argv.contains("--resume"), "{argv}");
}

// The tail of the OMP seed, so its presence in argv also proves the whole prompt was written.
const SEED_CONTRACT: &str = "Alinery completion contract";

// A restate kills the current child, and the Settings "prefer Terminal" restate fires as soon as
// the session goes live — possibly before the RPC child ever reached `ready` and got its seed.
// The journal, not the restate flag, says whether anything durable survived that kill.
#[test]
fn restate_reseeds_phase_prompt_only_without_jsonl() {
    let fixture = Fixture::new();
    fixture.spawn_omp("s1");
    let argv_path = fixture.root.join("argv.s1");

    let _ = fs::remove_file(&argv_path);
    assert_eq!(fixture.restate("s1", "pty").get("ok"), Some(&json!(true)));
    wait_until(Duration::from_secs(5), || fs::read_to_string(&argv_path).is_ok_and(|argv| argv.contains(SEED_CONTRACT)));
    let argv = fixture.argv("s1");
    assert_eq!(argv.matches(SEED_CONTRACT).count(), 1, "seed must reach the replacement exactly once: {argv}");
    assert!(argv.contains("--"), "seed must be injected as a prompt arg: {argv}");
    assert!(!argv.contains("--resume"), "{argv}");

    let dir = fixture.root.join(".alinery/tasks/task/sessions/s1.omp");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("2026-03-01T00-00-00Z_0193c3.jsonl"), "turn\n").unwrap();
    let _ = fs::remove_file(&argv_path);
    assert_eq!(fixture.restate("s1", "pty").get("ok"), Some(&json!(true)));
    let argv = fixture.argv("s1");
    assert!(argv.contains("--resume"), "{argv}");
    assert!(!argv.contains(SEED_CONTRACT), "a resumed restate must not replay the seed: {argv}");
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
    fixture.spawn_omp("s1");
    thread::sleep(Duration::from_millis(100));
    let scrollback = fixture.root.join(".alinery/tasks/task/sessions/s1.scrollback");
    if scrollback.exists() {
        let bytes = fs::read(&scrollback).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("\"type\":\"ready\""), "NDJSON leaked into scrollback");
    }
}

#[test]
fn rpc_chunk_reassembles_before_clients() {
    let fixture = Fixture::new();
    write_task_and_source(&fixture.root, "s1");
    fs::write(fixture.root.join("emit-chunk.s1"), b"").unwrap();
    fixture.spawn_omp("s1");
    let mut attach = fixture.rpc_attach("s1");
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
    write_task_and_source(&fixture.root, "unused");

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
    assert!(argv.lines().any(|arg| arg == "--model=openai-codex/gpt-5.5"), "setup must start without saved credentials: {argv}");
    assert!(!argv.contains("--session-dir"), "setup session must not be given a journal: {argv}");
    assert!(!fixture.root.join(format!(".alinery/sessions/{id}.omp")).exists());

    let _ = fixture.rpc(json!({"op": "kill", "id": id}));
}
