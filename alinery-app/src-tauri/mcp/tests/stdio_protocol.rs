use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::JoinHandle;

use std::os::unix::net::UnixListener;

use alinery_core::{git_cmd, sessions_dir, worktrees_dir, SessionMeta, Task};
use serde_json::{json, Value};

static ROOT_COUNTER: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    daemon: Option<JoinHandle<Vec<Value>>>,
    root: PathBuf,
}

impl Fixture {
    fn start() -> Self {
        Self::start_with_defaults("omp", "configured-model")
    }

    fn start_with_defaults(harness: &str, model: &str) -> Self {
        let n = ROOT_COUNTER.fetch_add(1, Ordering::Relaxed);
        // A short, literal /tmp base (not `std::env::temp_dir()`, which on macOS resolves to
        // a long `/var/folders/.../T/` path): canonicalizing below adds a `/private` prefix
        // for the daemon-socket-bearing repo, and a long base plus nested `.alinery/...sock`
        // suffix can exceed the unix-socket SUN_LEN limit.
        let root = PathBuf::from(format!("/tmp/alinery-mcp-stdio-{}-{n}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        run_git(&root, &["init", "-b", "main"]);
        run_git(&root, &["config", "user.email", "alinery-tests@example.com"]);
        run_git(&root, &["config", "user.name", "Alinery Tests"]);
        fs::write(root.join(".gitignore"), ".alinery/\n").unwrap();
        fs::write(root.join("seed.txt"), "seed").unwrap();
        run_git(&root, &["add", "."]);
        run_git(&root, &["commit", "-m", "seed"]);
        // Canonicalize once: repo is a required per-call tool argument, resolved through
        // `git rev-parse --show-toplevel` -> `fs::canonicalize`. The daemon socket this
        // fixture binds must be derived from the same canonical path dispatch resolves to,
        // or macOS's /tmp -> /private/tmp symlink makes the two disagree and every daemon
        // call silently misses the fixture's listener.
        let root = fs::canonicalize(&root).unwrap();
        alinery_core::ensure_playbooks(&root).unwrap();

        let parent_worktree = worktrees_dir(&root).join("a");
        fs::create_dir_all(worktrees_dir(&root)).unwrap();
        let output = git_cmd(&root).args(["worktree", "add"]).arg(&parent_worktree).args(["-b", "a", "main"]).output().unwrap();
        assert!(output.status.success(), "parent worktree: {}", String::from_utf8_lossy(&output.stderr));

        let parent = Task {
            name: "Parent A".into(),
            slug: "a".into(),
            branch: "a".into(),
            worktree: parent_worktree.to_string_lossy().into_owned(),
            has_worktree: true,
            created: 1,
            playbook: "superdevelop".into(),
            ..Default::default()
        };
        alinery_core::write_task(&root, &parent).unwrap();
        fs::create_dir_all(sessions_dir(&root, "a")).unwrap();
        let manager = SessionMeta {
            id: "manager".into(),
            worktree: parent.worktree,
            created: 2,
            harness: "omp".into(),
            playbook: "superdevelop".into(),
            generic: true,
            subtask_manager: true,
            ..Default::default()
        };
        alinery_core::write_meta_atomic(&sessions_dir(&root, "a").join("manager.meta.json"), &serde_json::to_value(manager).unwrap()).unwrap();

        let app_config = root.join(".alinery").join("app.toml");
        let mut global = alinery_core::default_global_settings();
        global.defaults.harness = harness.into();
        global.defaults.model = model.into();
        alinery_core::write_global_settings(&app_config, &global).unwrap();
        let listener = UnixListener::bind(alinery_core::alineryd_socket_path(&root, None)).unwrap();
        let app_config_identity = alinery_core::app_config_identity(&app_config);
        let daemon = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut line = String::new();
                BufReader::new(stream.try_clone().unwrap()).read_line(&mut line).unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                let response = match request["op"].as_str().unwrap() {
                    "version" => json!({
                        "protocol": alinery_core::PROTOCOL_VERSION,
                        "build_id": "stdio-test",
                        "app_config_identity": app_config_identity,
                    }),
                    "spawn" => json!({"ok": true}),
                    op => panic!("unexpected daemon op: {op}"),
                };
                requests.push(request);
                writeln!(stream, "{response}").unwrap();
                stream.flush().unwrap();
            }
            requests
        });

        let mut child = Command::new(env!("CARGO_BIN_EXE_alinery-mcp"))
            .arg("--repo")
            .arg(&root)
            .arg("--app-config")
            .arg(app_config)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            stdin,
            stdout,
            daemon: Some(daemon),
            root,
        }
    }

    fn request(&mut self, request: Value) -> Value {
        writeln!(self.stdin, "{request}").unwrap();
        self.stdin.flush().unwrap();
        let mut line = String::new();
        self.stdout.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap_or_else(|error| panic!("non-JSON data on MCP stdout: {line:?}: {error}"))
    }

    fn daemon_requests(&mut self) -> Vec<Value> {
        self.daemon.take().unwrap().join().unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(daemon) = self.daemon.take() {
            let _ = daemon.join();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn run_git(path: &Path, args: &[&str]) {
    let output = git_cmd(path).args(args).output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn create_subtask_keeps_stdout_json_rpc_framed() {
    let mut fixture = Fixture::start();
    let initialized = fixture.request(json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "stdio-test", "version": "1"}
        }
    }));
    assert_eq!(initialized["id"], 1);

    let created = fixture.request(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": "alinery_create_subtask",
            "arguments": {
                "repo": fixture.root.to_str().unwrap(),
                "manager_session_id": "manager",
                "name": "Child B",
                "slug": "b",
                "playbook": "superdevelop",
                "instructions": "Review the parent."
            }
        }
    }));
    assert_eq!(created["id"], 2);
    assert_eq!(created["jsonrpc"], "2.0");
    let result: Value = serde_json::from_str(created["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(result["child_task"]["slug"], "b");
    assert_eq!(result["initial_session"]["phase"], "research-questions");
    assert_eq!(result["initial_session"]["playbook"], "superdevelop");
    assert_eq!(result["initial_session"]["harness"], "omp");
    assert_eq!(result["initial_session"]["model"], "configured-model");

    let requests = fixture.daemon_requests();
    assert_eq!(requests[0]["op"], "version");
    assert_eq!(requests[1]["op"], "spawn");
    assert_eq!(requests[1]["task_slug"], "b");
    assert_eq!(requests[1]["id"], result["initial_session"]["id"]);
    let sessions = fs::read_dir(sessions_dir(&fixture.root, "b")).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
    assert_eq!(sessions.len(), 1);
}

#[test]
fn create_subtask_clears_leftover_claude_model() {
    let mut fixture = Fixture::start_with_defaults("claude", "sonnet");
    let initialized = fixture.request(json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "stdio-test", "version": "1"}
        }
    }));
    assert_eq!(initialized["id"], 1);

    let created = fixture.request(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": "alinery_create_subtask",
            "arguments": {
                "repo": fixture.root.to_str().unwrap(),
                "manager_session_id": "manager",
                "name": "Child B",
                "slug": "b",
                "playbook": "superdevelop",
                "instructions": "Review the parent."
            }
        }
    }));
    assert_eq!(created["id"], 2);
    let result: Value = serde_json::from_str(created["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(result["initial_session"]["harness"], "omp");
    assert_eq!(result["initial_session"]["model"], "");
}
