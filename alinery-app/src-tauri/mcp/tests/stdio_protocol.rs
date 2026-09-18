use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use alinery_core::task_creation::{CreateExecutionSessionRequest, CreateTaskRequest, ExecutionSessionTarget, TaskPlaybookPackage};
use serde_json::{json, Value};

static ROOT_COUNTER: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    child: Child,
    daemon: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    root: PathBuf,
    manager_id: String,
}

impl Fixture {
    fn start() -> Self {
        let n = ROOT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = PathBuf::from(format!("/tmp/almcp-stdio-{}-{n}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        run_git(&root, &["init", "-b", "main"]);
        run_git(&root, &["config", "user.email", "alinery-tests@example.com"]);
        run_git(&root, &["config", "user.name", "Alinery Tests"]);
        fs::write(root.join(".gitignore"), ".alinery/\n").unwrap();
        fs::write(root.join("seed.txt"), "seed").unwrap();
        run_git(&root, &["add", "."]);
        run_git(&root, &["commit", "-m", "seed"]);
        let root = fs::canonicalize(root).unwrap();
        fs::create_dir_all(root.join(".alinery")).unwrap();
        let app_config = root.join(".alinery/app.toml");
        fs::write(&app_config, "").unwrap();
        let daemon_binary = std::env::current_exe().unwrap().parent().and_then(Path::parent).unwrap().join(format!("alineryd{}", std::env::consts::EXE_SUFFIX));
        let daemon = Command::new(daemon_binary).arg("--repo").arg(&root).arg("--app-config").arg(&app_config).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let socket = alinery_core::alineryd_socket_path(&root, None);
        let deadline = Instant::now() + Duration::from_secs(5);
        let client = loop {
            if let Ok((client, _)) = alinery_core::connect_compatible_once(socket.clone(), &app_config) { break client; }
            assert!(Instant::now() < deadline, "daemon did not become ready");
            std::thread::sleep(Duration::from_millis(20));
        };
        let reference = alinery_core::playbook::PlaybookRef { scope: alinery_core::playbook::PlaybookScope::Bundled, key: "superdevelop".into() };
        let selected = alinery_core::playbook_library::resolve_playbook(&alinery_core::playbook_library::PlaybookRoots { global_config_dir: root.join(".alinery"), repo_dir: root.clone() }, &reference).unwrap();
        let request: CreateTaskRequest = serde_json::from_value(json!({
            "name":"Parent A", "requested_slug":"a", "playbook":TaskPlaybookPackage { reference, source: selected.source_text }, "start":false
        })).unwrap();
        let created = client.create_task(&request).unwrap();
        assert_eq!(created.creation, "ready", "{created:?}");
        let manager = client.create_execution_session(&CreateExecutionSessionRequest {
            task_slug: "a".into(), target: ExecutionSessionTarget::SubtaskManager { subtask_slug: None, recover: false, harness: "omp".into(), model: None },
            launch_override: None, prompt_extra: None, start: false,
        }).unwrap();
        assert!(manager.session.subtask_manager);
        let mut child = Command::new(env!("CARGO_BIN_EXE_alinery-mcp"))
            .arg("--repo").arg(&root).arg("--app-config").arg(app_config)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self { child, daemon, stdin, stdout, root, manager_id: manager.session.id }
    }

    fn request(&mut self, request: Value) -> Value {
        writeln!(self.stdin, "{request}").unwrap();
        self.stdin.flush().unwrap();
        let mut line = String::new();
        self.stdout.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap_or_else(|error| panic!("non-JSON data on MCP stdout: {line:?}: {error}"))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn run_git(path: &Path, args: &[&str]) {
    let output = alinery_core::git_cmd(path).args(args).output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn create_subtask_keeps_stdout_json_rpc_framed_and_retains_child_definition() {
    let mut fixture = Fixture::start();
    let initialized = fixture.request(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"stdio-test","version":"1"}}}));
    assert_eq!(initialized["id"], 1);
    let created = fixture.request(json!({
        "jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"alinery_create_subtask","arguments":{
            "repo":fixture.root,"manager_session_id":fixture.manager_id,"name":"Child B","slug":"b",
            "playbook":{"scope":"bundled","key":"one-shot"},"instructions":"Review the parent.","start":false
        }}
    }));
    assert_eq!(created["id"], 2);
    assert_eq!(created["jsonrpc"], "2.0");
    let result: alinery_core::CreateSubtaskResult = serde_json::from_str(created["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    let child = result.child_task.unwrap();
    assert_eq!(child.slug, "b");
    let persisted = alinery_core::read_task(&fixture.root, "b").unwrap();
    assert_eq!(persisted.parent_task, "a");
    assert_eq!(persisted.playbook_ref.as_ref().unwrap().key, "one-shot");
    assert_eq!(alinery_core::read_task(&fixture.root, "a").unwrap().active_subtask, "b");
    assert_eq!(result.provisioning.creation, "ready");
    assert_eq!(result.provisioning.start, "not_requested");
    assert!(result.provisioning.sessions.iter().all(|session| session.started_at.is_none()));
    let state = alinery_core::execution::read_execution_state(&fixture.root, "b").unwrap();
    let definition = alinery_core::execution::read_task_playbook(&fixture.root, "b", &state).unwrap();
    assert_eq!(definition.key, "one-shot");
    let repeated = fixture.request(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"alinery_create_subtask","arguments":{
        "repo":fixture.root,"manager_session_id":fixture.manager_id,"name":"Other child","slug":"c","start":false
    }}}));
    assert!(repeated["result"]["content"][0]["text"].as_str().unwrap().starts_with("error:"));
    assert!(!alinery_core::task_dir(&fixture.root, "c").exists());
}
