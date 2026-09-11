use alinery_core::{AgentState, CreateSessionInput, ProcessState, SessionHistoryResult, SessionMeta, SessionStartResult, SessionStatusResult, Task};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

static ROOT_COUNTER: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    app_config: PathBuf,
    runner_tokens: PathBuf,
    omp_prompt: PathBuf,
    omp_stop: PathBuf,
    daemon_child: Option<std::process::Child>,
}

impl Fixture {
    fn new() -> Self {
        let sequence = ROOT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = PathBuf::from(format!("/tmp/almcp-{}-{sequence}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // repo is a required per-call tool argument, resolved via `git rev-parse
        // --show-toplevel` — a bare `.git/` directory does not satisfy that.
        let init = alinery_core::git_cmd(&root).args(["init"]).output().unwrap();
        assert!(init.status.success(), "git init failed: {init:?}");
        // Canonicalize once: dispatch resolves `repo` the same way (git_top_level ->
        // fs::canonicalize), and macOS's /tmp -> /private/tmp symlink would otherwise make
        // every path this fixture embeds (prompts, worktree) disagree with dispatch's own.
        let root = fs::canonicalize(&root).unwrap();
        fs::create_dir_all(root.join(".alinery/tasks/task/artifacts")).unwrap();
        fs::create_dir_all(root.join(".alinery/tasks/task/sessions")).unwrap();
        let worktree = root.join("worktree");
        fs::create_dir_all(&worktree).unwrap();
        alinery_core::ensure_playbooks(&root).unwrap();

        let task = Task {
            name: "Task".into(),
            slug: "task".into(),
            branch: "task".into(),
            worktree: worktree.display().to_string(),
            has_worktree: true,
            created: 1,
            playbook: "one-shot".into(),
            ..Default::default()
        };
        alinery_core::write_task(&root, &task).unwrap();

        let app_config = root.join(".alinery/app.toml");
        fs::write(&app_config, "").unwrap();
        let runner_tokens = root.join("runner-tokens.tsv");
        let runner = root.join("fake-alinery-runner");
        fs::write(
            &runner,
            "#!/bin/sh\nprintf '%s\\t%s\\n' \"$ALINERY_SESSION_ID\" \"$ALINERY_EVENT_TOKEN\" >> \"$ALINERY_RUNNER_TOKENS\"\nshift 4\nexec \"$@\"\n",
        )
        .unwrap();
        fs::set_permissions(&runner, fs::Permissions::from_mode(0o755)).unwrap();

        let omp_prompt = root.join("omp.prompt");
        let omp_stop = root.join("omp.stop");
        let harnesses = format!(
            r#"
[[harness]]
key = "omp"
name = "OMP recording harness"
binary = "/bin/sh"
args = ["-c", 'prompt_path="$1"; stop_path="$2"; shift 2; while [ "$#" -gt 1 ]; do case "$1" in --session-dir|--mode|--thinking|--resume|--extension) shift 2 ;; *) break ;; esac; done; printf "%s\n" "{{\"type\":\"ready\"}}"; while IFS= read -r line; do case "$line" in *negotiate_protocol*) continue ;; *) printf "%s" "$line" > "$prompt_path.$ALINERY_SESSION_ID"; break ;; esac; done; while [ ! -f "$stop_path.$ALINERY_SESSION_ID" ]; do sleep 0.05; done; exit 17', "runner", "{}", "{}"]
model_arg = []
prompt_injection = "arg"
prompt_arg = ["{{prompt}}"]
adapter = "omp"
# An OMP child inherits only `OMP_ENV_ALLOWLIST` from the daemon, so this fixture path has to
# come through the harness `env` map -- the same explicit route a real injected key would take.
env = {{ ALINERY_RUNNER_TOKENS = "{}" }}
"#,
            omp_prompt.display(),
            omp_stop.display(),
            runner_tokens.display(),
        );
        fs::write(root.join(".alinery/harnesses.toml"), harnesses).unwrap();

        Self {
            root,
            app_config,
            runner_tokens,
            omp_prompt,
            omp_stop,
            daemon_child: None,
        }
    }

    fn with_ready_daemon() -> Self {
        let mut fixture = Self::new();
        let host = fixture.root.join("host-executable");
        fs::write(&host, "host").unwrap();
        fs::set_permissions(&host, fs::Permissions::from_mode(0o755)).unwrap();
        let runner = fixture.root.join("fake-alinery-runner");
        let daemon = std::env::current_exe()
            .unwrap()
            .parent()
            .and_then(Path::parent)
            .unwrap()
            .join(format!("alineryd{}", std::env::consts::EXE_SUFFIX));
        let child = Command::new(daemon)
            .arg("--repo")
            .arg(&fixture.root)
            .arg("--build-id")
            .arg("mcp-session-tools")
            .arg("--app-config")
            .arg(&fixture.app_config)
            .env("ALINERY_HOST_EXECUTABLE", &host)
            .env("ALINERY_RUNNER_PATH", runner)
            .env("ALINERY_RUNNER_TOKENS", &fixture.runner_tokens)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        fixture.daemon_child = Some(child);
        let socket = alinery_core::alineryd_socket_path(&fixture.root, None);
        wait_until(Duration::from_secs(5), || UnixStream::connect(&socket).is_ok());
        fixture
    }

    fn call(&self, name: &str, arguments: Value) -> String {
        self.call_with_app_config(&self.app_config, name, arguments)
    }

    fn call_with_app_config(&self, app_config: &Path, name: &str, arguments: Value) -> String {
        // repo is a required per-call tool argument; every call in this fixture targets the
        // process's own launch repo, so inject it once here instead of at every call site.
        let mut arguments = arguments;
        match arguments.as_object_mut() {
            Some(map) => {
                map.entry("repo".to_string()).or_insert_with(|| Value::String(self.root.display().to_string()));
            }
            None => arguments = json!({"repo": self.root.display().to_string()}),
        }
        let runner = self.root.join("fake-alinery-runner");
        let mut child = Command::new(env!("CARGO_BIN_EXE_alinery-mcp"))
            .arg("--repo")
            .arg(&self.root)
            .arg("--app-config")
            .arg(app_config)
            .env("ALINERY_RUNNER_PATH", runner)
            .env("ALINERY_RUNNER_TOKENS", &self.runner_tokens)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        writeln!(
            child.stdin.as_mut().unwrap(),
            "{}",
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments}
            })
        )
        .unwrap();
        drop(child.stdin.take());
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "alinery-mcp exited with {}", output.status);
        let line = String::from_utf8(output.stdout).unwrap();
        let response: Value = serde_json::from_str(line.lines().next().expect("JSON-RPC response")).unwrap();
        response["result"]["content"][0]["text"].as_str().unwrap().to_string()
    }

    fn daemon_rpc(&self, request: Value) -> Value {
        let socket = alinery_core::alineryd_socket_path(&self.root, None);
        let mut stream = UnixStream::connect(socket).unwrap();
        writeln!(stream, "{request}").unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    fn token_for(&self, session_id: &str) -> String {
        wait_until(Duration::from_secs(5), || {
            fs::read_to_string(&self.runner_tokens)
                .ok()
                .is_some_and(|contents| contents.lines().any(|line| line.starts_with(&format!("{session_id}\t"))))
        });
        fs::read_to_string(&self.runner_tokens)
            .unwrap()
            .lines()
            .find_map(|line| {
                let (id, token) = line.split_once('\t')?;
                (id == session_id).then(|| token.to_string())
            })
            .unwrap()
    }

    fn prompt_file(&self, session_id: &str) -> PathBuf {
        PathBuf::from(format!("{}.{}", self.omp_prompt.display(), session_id))
    }

    fn stop_file(&self, session_id: &str) -> PathBuf {
        PathBuf::from(format!("{}.{}", self.omp_stop.display(), session_id))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::write(&self.omp_stop, "stop");
        let socket = alinery_core::alineryd_socket_path(&self.root, None);
        if let Ok(mut stream) = UnixStream::connect(&socket) {
            let _ = writeln!(stream, "{}", json!({"op": "shutdown"}));
            let mut line = String::new();
            let _ = BufReader::new(stream).read_line(&mut line);
        }
        wait_until(Duration::from_secs(5), || !socket.exists());
        if let Some(mut child) = self.daemon_child.take() {
            let _ = child.wait();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
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

fn marker_count(text: &str, marker: &str) -> usize {
    text.match_indices(marker).count()
}

#[test]
fn real_mcp_create_start_disconnect_observe_history_and_exit() {
    let fixture = Fixture::with_ready_daemon();
    let playbook_extra = "PLAYBOOK-EXTRA-ONCE";
    let expected_playbook_prompt = alinery_core::preview_session_prompt_for(
        &fixture.app_config,
        &fixture.root,
        CreateSessionInput {
            task_slug: "task".into(),
            playbook: "superdevelop".into(),
            phase: "implementation".into(),
            harness: "omp".into(),
            prompt_extra: playbook_extra.into(),
            ..Default::default()
        },
    )
    .unwrap();
    let playbook: SessionStartResult = serde_json::from_str(&fixture.call(
        "alinery_create_session",
        json!({
            "task_slug": "task",
            "playbook": "superdevelop",
            "phase": "implementation",
            "prompt_extra": playbook_extra,
            "start": true
        }),
    ))
    .unwrap();
    assert_eq!(playbook.task_slug, "task");
    assert!(matches!(playbook.state.process, ProcessState::Starting | ProcessState::Alive));

    let generic_meta: SessionMeta = serde_json::from_str(&fixture.call(
        "alinery_create_session",
        json!({
            "task_slug": "task",
            "generic": true
        }),
    ))
    .unwrap();
    assert!(generic_meta.generic);
    assert_eq!(generic_meta.playbook, "one-shot");
    assert_eq!(generic_meta.phase, "");
    assert_eq!(generic_meta.artifact, "");
    assert_eq!(generic_meta.harness, alinery_core::NO_HARNESS_KEY);
    assert!(generic_meta.started_at.is_none());

    wait_until(Duration::from_secs(5), || fixture.prompt_file(&playbook.session_id).exists());
    let seed: Value = serde_json::from_str(&fs::read_to_string(fixture.prompt_file(&playbook.session_id)).unwrap()).unwrap();
    let playbook_prompt = seed["message"].as_str().unwrap();
    assert!(playbook_prompt.contains("# Build"));
    assert!(playbook_prompt.starts_with(&expected_playbook_prompt));
    assert_eq!(marker_count(playbook_prompt, playbook_extra), 1);

    let token = fixture.token_for(&playbook.session_id);
    assert_eq!(
        fixture.daemon_rpc(json!({
            "op": "event",
            "version": 1,
            "session_id": playbook.session_id,
            "token": token,
            "event": {"type": "waiting_for_input", "correlation_id": "merge-conflict"}
        }))["ok"],
        true
    );

    let playbook_status: SessionStatusResult =
        serde_json::from_str(&fixture.call("alinery_session_status", json!({"task_slug": "task", "session_id": playbook.session_id}))).unwrap();
    assert!(matches!(
        playbook_status.state.unwrap().agent,
        AgentState::WaitingForInput { ref correlation_id } if correlation_id == "merge-conflict"
    ));

    let screen: SessionHistoryResult =
        serde_json::from_str(&fixture.call("alinery_read_session_history", json!({"task_slug": "task", "session_id": playbook.session_id}))).unwrap();
    assert!(screen.data.is_empty(), "RPC sessions have no PTY scrollback");
    let raw: SessionHistoryResult = serde_json::from_str(&fixture.call(
        "alinery_read_session_history",
        json!({"task_slug": "task", "session_id": playbook.session_id, "offset": 0, "limit": 1024}),
    ))
    .unwrap();
    assert!(raw.data.is_empty(), "RPC sessions have no PTY scrollback");
    assert_eq!(raw.offset, Some(0));
    assert!(raw.next_offset.unwrap() <= 1024);

    fs::write(fixture.stop_file(&playbook.session_id), "stop").unwrap();
    wait_until(Duration::from_secs(5), || {
        let playbook_meta = alinery_core::read_session_meta_full(&alinery_core::session_meta_path(&fixture.root, "task", &playbook.session_id));
        playbook_meta.is_some_and(|meta| meta.exit_code == Some(17))
    });
    let playbook_exited: SessionStatusResult =
        serde_json::from_str(&fixture.call("alinery_session_status", json!({"task_slug": "task", "session_id": playbook.session_id}))).unwrap();
    assert!(matches!(playbook_exited.state.unwrap().process, ProcessState::Exited { code: Some(17) }));
}

#[test]
fn mcp_first_daemon_refuses_omp_without_a_protected_host() {
    let fixture = Fixture::new();
    let failure = fixture.call(
        "alinery_create_session",
        json!({
            "task_slug": "task",
            "playbook": "superdevelop",
            "phase": "implementation",
            "start": true
        }),
    );
    assert!(failure.starts_with("error: created task_slug=task session_id="), "{failure}");
    assert!(failure.contains("OMP host protection is unavailable"), "{failure}");
    let failed_id = failure
        .split_once("session_id=")
        .and_then(|(_, tail)| tail.split_once(';').map(|(id, _)| id.to_string()))
        .expect("retained session id in combined failure");
    let failed_meta = alinery_core::read_session_meta_full(&alinery_core::session_meta_path(&fixture.root, "task", &failed_id)).unwrap();
    assert!(failed_meta.started_at.is_none());
    assert_eq!(fixture.daemon_rpc(json!({"op": "version"}))["host_guard_ready"], false);

    let unsupported: SessionStartResult = serde_json::from_str(&fixture.call(
        "alinery_create_session",
        json!({
            "task_slug": "task",
            "generic": true,
            "start": true
        }),
    ))
    .unwrap();
    assert!(matches!(unsupported.state.process, ProcessState::Starting | ProcessState::Alive));
}

#[test]
fn combined_start_failure_is_retryable_and_mismatches_do_not_touch_live_sessions() {
    let fixture = Fixture::with_ready_daemon();
    let runner = fixture.root.join("fake-alinery-runner");
    let disabled_runner = fixture.root.join("fake-alinery-runner.disabled");
    fs::rename(&runner, &disabled_runner).unwrap();

    let failure = fixture.call(
        "alinery_create_session",
        json!({
            "task_slug": "task",
            "playbook": "superdevelop",
            "phase": "implementation",
            "start": true
        }),
    );
    assert!(failure.starts_with("error: created task_slug=task session_id="), "{failure}");
    assert!(failure.contains("alinery-runner not found"), "{failure}");
    let failed_id = failure
        .split_once("session_id=")
        .and_then(|(_, tail)| tail.split_once(';').map(|(id, _)| id.to_string()))
        .expect("retained session id in combined failure");
    let failed_meta = alinery_core::read_session_meta_full(&alinery_core::session_meta_path(&fixture.root, "task", &failed_id)).unwrap();
    assert!(failed_meta.started_at.is_none());

    fs::rename(&disabled_runner, &runner).unwrap();
    let retried: SessionStartResult = serde_json::from_str(&fixture.call("alinery_start_session", json!({"task_slug": "task", "session_id": failed_id}))).unwrap();
    assert_eq!(retried.session_id, failed_id);
    let repeated = fixture.call("alinery_start_session", json!({"task_slug": "task", "session_id": retried.session_id}));
    assert!(repeated.contains("already-started"), "{repeated}");
    assert!(matches!(
        fixture.daemon_rpc(json!({"op": "status", "id": failed_id}))["process"]["state"].as_str(),
        Some("starting" | "alive")
    ));

    for (id, handoff) in [("app-row", ""), ("review-row", "review-handoff-001.md")] {
        let meta = alinery_core::create_session_meta_for(
            &fixture.app_config,
            &fixture.root,
            CreateSessionInput {
                task_slug: "task".into(),
                playbook: "one-shot".into(),
                phase: "implementation".into(),
                harness: alinery_core::NO_HARNESS_KEY.into(),
                handoff_artifact: handoff.into(),
                id_override: Some(id.into()),
                ..Default::default()
            },
        )
        .unwrap();
        let started: SessionStartResult = serde_json::from_str(&fixture.call("alinery_start_session", json!({"task_slug": "task", "session_id": meta.id}))).unwrap();
        assert_eq!(started.session_id, id);
    }
    let auto_meta = alinery_core::create_session_meta_for(
        &fixture.app_config,
        &fixture.root,
        CreateSessionInput {
            task_slug: "task".into(),
            playbook: "one-shot".into(),
            phase: "implementation".into(),
            harness: alinery_core::NO_HARNESS_KEY.into(),
            id_override: Some("auto-row".into()),
            exclusive_create: true,
            ..Default::default()
        },
    )
    .unwrap();
    let auto_start = fixture.call("alinery_start_session", json!({"task_slug": "task", "session_id": auto_meta.id}));
    assert!(auto_start.contains("already-started"), "{auto_start}");

    let alternate_config = fixture.root.join(".alinery/alternate-app.toml");
    fs::write(&alternate_config, "").unwrap();
    let config_error = fixture.call_with_app_config(&alternate_config, "alinery_session_status", json!({"task_slug": "task", "session_id": retried.session_id}));
    assert!(config_error.contains("repo-app-config-mismatch"), "{config_error}");
    assert!(matches!(
        fixture.daemon_rpc(json!({"op": "status", "id": retried.session_id}))["process"]["state"].as_str(),
        Some("starting" | "alive")
    ));

    let protocol_meta = alinery_core::create_session_meta_for(
        &fixture.app_config,
        &fixture.root,
        CreateSessionInput {
            task_slug: "task".into(),
            generic: true,
            harness: alinery_core::NO_HARNESS_KEY.into(),
            daemon_namespace: "foreign".into(),
            id_override: Some("protocol-row".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let foreign_socket = alinery_core::alineryd_socket_path(&fixture.root, Some("foreign"));
    let listener = UnixListener::bind(&foreign_socket).unwrap();
    let expected_identity = alinery_core::app_config_identity(&fixture.app_config);
    let server = thread::spawn(move || {
        let mut requests = Vec::new();
        for _ in 0..2 {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line.trim().is_empty() {
                continue;
            }
            let request: Value = serde_json::from_str(line.trim()).unwrap();
            requests.push(request);
            writeln!(
                reader.get_mut(),
                "{}",
                json!({
                    "protocol": alinery_core::PROTOCOL_VERSION + 1,
                    "build_id": "foreign",
                    "app_config_identity": expected_identity
                })
            )
            .unwrap();
        }
        requests
    });
    let protocol_error = fixture.call("alinery_session_status", json!({"task_slug": "task", "session_id": protocol_meta.id}));
    assert!(protocol_error.contains("repo-protocol-mismatch"), "{protocol_error}");
    let requests = server.join().unwrap();
    assert_eq!(requests, vec![json!({"op": "version"})]);
    assert!(matches!(
        fixture.daemon_rpc(json!({"op": "status", "id": retried.session_id}))["process"]["state"].as_str(),
        Some("starting" | "alive")
    ));
}

#[test]
fn mcp_history_reads_migrated_bin_chunks() {
    let fixture = Fixture::new();
    let session_id = "migrated-history";
    let sessions = fixture.root.join(".alinery/tasks/task/sessions");
    let meta = SessionMeta {
        id: session_id.into(),
        archived: true,
        ..Default::default()
    };
    fs::write(alinery_core::session_meta_path(&fixture.root, "task", session_id), serde_json::to_vec(&meta).unwrap()).unwrap();
    let history = sessions.join(format!("{session_id}.scrollback"));
    fs::create_dir_all(&history).unwrap();
    fs::write(history.join("1"), b"first\r\n").unwrap();
    fs::write(history.join("0002"), b"second").unwrap();
    fs::write(history.join("ignore.txt"), b"hidden").unwrap();

    let raw: SessionHistoryResult = serde_json::from_str(&fixture.call(
        "alinery_read_session_history",
        json!({"task_slug": "task", "session_id": session_id, "offset": 0, "limit": 1024}),
    ))
    .unwrap();
    assert_eq!(raw.mode, alinery_core::HistoryMode::Raw);
    assert_eq!(raw.data, b"first\r\nsecond");
    assert_eq!(raw.length, Some(13));
    assert_eq!(raw.next_offset, Some(13));
    assert_eq!(raw.eof, Some(true));

    let screen: SessionHistoryResult = serde_json::from_str(&fixture.call("alinery_read_session_history", json!({"task_slug": "task", "session_id": session_id}))).unwrap();
    let screen = String::from_utf8_lossy(&screen.data);
    assert!(screen.contains("first"));
    assert!(screen.contains("second"));
    assert!(!screen.contains("hidden"));
}
