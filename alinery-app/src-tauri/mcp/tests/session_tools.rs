use alinery_core::task_creation::{CreateExecutionSessionReply, CreateTaskReply, TaskExecutionReply};
use alinery_core::{AgentState, ProcessState, SessionHistoryResult, SessionMeta, SessionStatusResult, Task};
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
        for args in [
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
            vec!["commit", "--allow-empty", "-m", "fixture"],
        ] {
            assert!(alinery_core::git_cmd(&root).args(args).status().unwrap().success());
        }
        let library = root.join(".alinery/playbooks/fixture");
        fs::create_dir_all(&library).unwrap();
        fs::write(
            library.join("playbook.md"),
            r#"+++
version = 2
key = "fixture"
title = "Fixture"
description = ""
default_model = ""
default_harness = "omp"
[[step]]
key = "build"
title = "Build"
short = ""
inputs = []
outputs = [{path = "result.md"}]
model = ""
harness = ""
is_coding_step = false
auto_advance_default = false
[[step]]
key = "inspect"
title = "Inspect"
short = ""
inputs = []
outputs = [{path = "inspection.md"}]
model = ""
harness = ""
is_coding_step = false
auto_advance_default = false
+++
<!-- alinery:step build -->
Fixture instructions. Write the assigned result for {{TASK_NAME}}.
<!-- alinery:step inspect -->
Inspect and write the assigned report.
"#,
        )
        .unwrap();

        let app_config = root.join(".alinery/app.toml");
        fs::write(&app_config, "[global.defaults.playbook]\nscope = 'repo'\nkey = 'fixture'\n").unwrap();
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
        Self::start_daemon(Self::new())
    }

    fn start_daemon(mut fixture: Self) -> Self {
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
        let created: CreateTaskReply = serde_json::from_str(&fixture.call(
            "alinery_create_task",
            json!({"name":"Task","requested_slug":"task","evidence":"Imported evidence","attachments":[{"name":"proof.bin","bytes":"AP8K"}],"github_issue":"42","start":false}),
        ))
        .unwrap();
        assert_eq!(created.creation, "ready", "{created:?}");
        assert_eq!(created.task.unwrap().slug, "task");
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
fn explicit_playbook_overrides_configured_default_and_creates_eligible_sessions() {
    let fixture = Fixture::with_ready_daemon();
    let reply = fixture.call(
        "alinery_create_task",
        json!({"name":"Review task","playbook":{"scope":"bundled","key":"review"},"start":false}),
    );
    let created: CreateTaskReply = serde_json::from_str(&reply).unwrap_or_else(|error| panic!("{error}: {reply}"));
    assert_eq!(created.creation, "ready", "{created:?}");
    let task = created.task.unwrap();
    let retained: TaskExecutionReply = serde_json::from_str(&fixture.call("alinery_get_task_execution", json!({"task_slug":task.slug}))).unwrap();
    assert_eq!(retained.state.reference.scope, alinery_core::playbook::PlaybookScope::Bundled);
    assert_eq!(retained.definition.key, "review");
    assert_eq!(
        retained.state.executions.values().map(|record| record.candidate.step_key.as_str()).collect::<Vec<_>>(),
        ["review-context"]
    );
    let sessions: Vec<SessionMeta> = serde_json::from_str(&fixture.call("alinery_list_sessions", json!({"slug":task.slug}))).unwrap();
    assert_eq!(sessions.iter().map(|session| session.phase.as_str()).collect::<Vec<_>>(), ["review-context"]);
    assert!(sessions.iter().all(|session| session.started_at.is_none()));
}

#[test]
fn real_mcp_create_start_disconnect_observe_history_and_exit() {
    let fixture = Fixture::with_ready_daemon();
    let playbook_extra = "PLAYBOOK-EXTRA-ONCE";
    let retained: TaskExecutionReply = serde_json::from_str(&fixture.call("alinery_get_task_execution", json!({"task_slug":"task"}))).unwrap();
    assert_eq!(retained.state.executions.len(), 2);
    assert_eq!(
        fs::read(fixture.root.join(".alinery/tasks/task/playbook.md")).unwrap(),
        fs::read(fixture.root.join(".alinery/playbooks/fixture/playbook.md")).unwrap()
    );
    assert_eq!(fs::read(fixture.root.join(".alinery/tasks/task/artifacts/attachments/proof.bin")).unwrap(), [0, 255, 10]);
    assert!(fs::read_to_string(fixture.root.join(".alinery/tasks/task/artifacts/00-ticket.md"))
        .unwrap()
        .contains("Imported evidence"));
    let task = alinery_core::read_task(&fixture.root, "task").unwrap();
    assert_eq!(task.github_issue, "42");
    assert_ne!(Path::new(&task.worktree), fixture.root.as_path());
    assert!(Path::new(&task.worktree).join(".git").is_file());
    for record in retained.state.executions.values() {
        let session = &record.owner_session_id;
        assert!(alinery_core::read_session_meta_full(&alinery_core::session_meta_path(&fixture.root, "task", session))
            .unwrap()
            .started_at
            .is_none());
    }
    fs::remove_file(fixture.root.join(".alinery/playbooks/fixture/playbook.md")).unwrap();
    let queried: TaskExecutionReply = serde_json::from_str(&fixture.call("alinery_list_playbook_steps", json!({"task_slug":"task"}))).unwrap();
    assert_eq!(queried.definition, retained.definition);
    let playbook: CreateExecutionSessionReply = serde_json::from_str(&fixture.call(
        "alinery_create_session",
        json!({"task_slug":"task","step_key":"build","prompt_extra":playbook_extra,"start":true}),
    ))
    .unwrap();
    assert_eq!(playbook.start, "started", "{playbook:?}");
    let playbook_id = &playbook.session.id;
    let generic: CreateExecutionSessionReply = serde_json::from_str(&fixture.call("alinery_create_session", json!({"task_slug":"task","generic":true}))).unwrap();
    let generic_meta = generic.session;
    assert!(generic_meta.generic);
    assert_eq!(generic_meta.phase, "");
    assert_eq!(generic_meta.artifact, "");
    assert_eq!(generic_meta.harness, alinery_core::NO_HARNESS_KEY);
    assert!(generic_meta.started_at.is_none());

    wait_until(Duration::from_secs(5), || fixture.prompt_file(playbook_id).exists());
    let seed: Value = serde_json::from_str(&fs::read_to_string(fixture.prompt_file(playbook_id)).unwrap()).unwrap();
    let playbook_prompt = seed["message"].as_str().unwrap();
    assert!(playbook_prompt.contains("Fixture instructions."));
    assert_eq!(marker_count(playbook_prompt, playbook_extra), 1);
    for record in retained.state.executions.values() {
        let session = &record.owner_session_id;
        assert!(
            alinery_core::read_session_meta_full(&alinery_core::session_meta_path(&fixture.root, "task", session))
                .unwrap()
                .started_at
                .is_none(),
            "starting one execution must not start held siblings"
        );
    }

    let token = fixture.token_for(playbook_id);
    assert_eq!(
        fixture.daemon_rpc(json!({
            "op": "event",
            "version": alinery_core::RUNNER_EVENT_PROTOCOL_VERSION,
            "session_id": playbook_id,
            "token": token,
            "event": {"type": "waiting_for_input", "correlation_id": "merge-conflict"}
        }))["ok"],
        true
    );

    let playbook_status: SessionStatusResult = serde_json::from_str(&fixture.call("alinery_session_status", json!({"task_slug": "task", "session_id": playbook_id}))).unwrap();
    assert!(matches!(
        playbook_status.state.unwrap().agent,
        AgentState::WaitingForInput { ref correlation_id } if correlation_id == "merge-conflict"
    ));

    let screen: SessionHistoryResult = serde_json::from_str(&fixture.call("alinery_read_session_history", json!({"task_slug": "task", "session_id": playbook_id}))).unwrap();
    assert!(screen.data.is_empty(), "RPC sessions have no PTY scrollback");
    let raw: SessionHistoryResult = serde_json::from_str(&fixture.call(
        "alinery_read_session_history",
        json!({"task_slug": "task", "session_id": playbook_id, "offset": 0, "limit": 1024}),
    ))
    .unwrap();
    assert!(raw.data.is_empty(), "RPC sessions have no PTY scrollback");
    assert_eq!(raw.offset, Some(0));
    assert!(raw.next_offset.unwrap() <= 1024);

    fs::write(fixture.stop_file(playbook_id), "stop").unwrap();
    wait_until(Duration::from_secs(5), || {
        let playbook_meta = alinery_core::read_session_meta_full(&alinery_core::session_meta_path(&fixture.root, "task", playbook_id));
        playbook_meta.is_some_and(|meta| meta.exit_code == Some(17))
    });
    let playbook_exited: SessionStatusResult = serde_json::from_str(&fixture.call("alinery_session_status", json!({"task_slug": "task", "session_id": playbook_id}))).unwrap();
    assert!(matches!(playbook_exited.state.unwrap().process, ProcessState::Exited { code: Some(17) }));
}

#[test]
fn mcp_first_daemon_refuses_omp_without_a_protected_host() {
    let fixture = Fixture::new();
    let failed: CreateTaskReply = serde_json::from_str(&fixture.call("alinery_create_task", json!({"name":"Task","requested_slug":"task","start":true}))).unwrap();
    assert_eq!(failed.task.as_ref().unwrap().slug, "task");
    assert_eq!(failed.start, "failed");
    assert!(
        failed.errors.iter().any(|error| error.stage == "launch" && error.code == "launch_failed"),
        "{:?}",
        failed.errors
    );
    let failed_meta = alinery_core::read_session_meta_full(&alinery_core::session_meta_path(&fixture.root, "task", &failed.sessions[0].id)).unwrap();
    assert!(failed_meta.started_at.is_none());
    assert_eq!(fixture.daemon_rpc(json!({"op": "version"}))["host_guard_ready"], false);
    let terminal: CreateExecutionSessionReply = serde_json::from_str(&fixture.call("alinery_create_session", json!({"task_slug":"task","generic":true,"start":true}))).unwrap();
    assert_eq!(terminal.start, "started", "{terminal:?}");
}

#[test]
fn combined_start_failure_retains_owner_and_mismatches_do_not_touch_live_sessions() {
    let fixture = Fixture::with_ready_daemon();
    let runner = fixture.root.join("fake-alinery-runner");
    let disabled_runner = fixture.root.join("fake-alinery-runner.disabled");
    fs::rename(&runner, &disabled_runner).unwrap();

    let failure: CreateExecutionSessionReply = serde_json::from_str(&fixture.call("alinery_create_session", json!({"task_slug":"task","step_key":"build","start":true}))).unwrap();
    assert_eq!(failure.start, "failed");
    assert!(!failure.errors.is_empty());
    let failed_id = failure.session.id;
    let execution_id = failure.execution.unwrap().id;
    let failed_meta = alinery_core::read_session_meta_full(&alinery_core::session_meta_path(&fixture.root, "task", &failed_id)).unwrap();
    assert!(failed_meta.started_at.is_none());

    fs::rename(&disabled_runner, &runner).unwrap();
    let retried: CreateExecutionSessionReply = serde_json::from_str(&fixture.call(
        "alinery_create_session",
        json!({"task_slug":"task","step_key":"build","execution_id":execution_id,"start":true}),
    ))
    .unwrap();
    assert_ne!(retried.session.id, failed_id);
    assert!(retried.execution.as_ref().unwrap().previous_session_ids.contains(&failed_id));
    assert_eq!(retried.start, "started", "{retried:?}");
    assert!(matches!(
        fixture.daemon_rpc(json!({"op": "status", "id": retried.session.id}))["process"]["state"].as_str(),
        Some("starting" | "alive")
    ));

    let auxiliary: CreateExecutionSessionReply = serde_json::from_str(&fixture.call("alinery_create_session", json!({"task_slug":"task","generic":true}))).unwrap();
    let started: CreateExecutionSessionReply = serde_json::from_str(&fixture.call("alinery_start_session", json!({"task_slug":"task","session_id":auxiliary.session.id}))).unwrap();
    assert_eq!(started.start, "started", "{started:?}");

    let alternate_config = fixture.root.join(".alinery/alternate-app.toml");
    fs::write(&alternate_config, "").unwrap();
    let config_error = fixture.call_with_app_config(&alternate_config, "alinery_session_status", json!({"task_slug": "task", "session_id": retried.session.id}));
    assert!(config_error.contains("repo-app-config-mismatch"), "{config_error}");
    assert!(matches!(
        fixture.daemon_rpc(json!({"op": "status", "id": retried.session.id}))["process"]["state"].as_str(),
        Some("starting" | "alive")
    ));

    let protocol_meta = SessionMeta {
        id: "protocol-row".into(),
        generic: true,
        harness: alinery_core::NO_HARNESS_KEY.into(),
        daemon_namespace: "foreign".into(),
        ..Default::default()
    };
    fs::write(
        alinery_core::session_meta_path(&fixture.root, "task", &protocol_meta.id),
        serde_json::to_vec(&protocol_meta).unwrap(),
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
        fixture.daemon_rpc(json!({"op": "status", "id": retried.session.id}))["process"]["state"].as_str(),
        Some("starting" | "alive")
    ));
}

#[test]
fn mcp_history_reads_migrated_bin_chunks() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.root.join(".alinery/tasks/task/sessions")).unwrap();
    alinery_core::write_task(
        &fixture.root,
        &Task {
            slug: "task".into(),
            name: "Historical".into(),
            ..Default::default()
        },
    )
    .unwrap();
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

#[test]
fn review_handoff_addresses_same_slug_in_explicit_target_repository() {
    let source = Fixture::with_ready_daemon();
    let mut target = Fixture::new();
    target.app_config = source.app_config.clone();
    let target_source = target.root.join(".alinery/playbooks/fixture/playbook.md");
    let definition = fs::read_to_string(&target_source)
        .unwrap()
        .replacen("inputs = []", "inputs = [{path = \"ticket.md\", mode = \"single\"}]", 1)
        .replace("Fixture instructions.", "Fixture instructions. Incoming review: [{{REVIEW_HANDOFF_FILE}}].");
    fs::write(target_source, definition).unwrap();
    let target = Fixture::start_daemon(target);
    fs::write(
        &source.app_config,
        format!(
            "known_repos = [{}]\n[global.defaults.playbook]\nscope = 'repo'\nkey = 'fixture'\n",
            serde_json::to_string(&target.root.display().to_string()).unwrap()
        ),
    )
    .unwrap();
    fs::write(source.root.join(".alinery/tasks/task/artifacts/findings.md"), "Cross-repository finding").unwrap();
    fs::remove_file(target.root.join(".alinery/playbooks/fixture/playbook.md")).unwrap();
    let response = source.call(
        "alinery_send_review_handoff",
        json!({
            "source_slug":"task","source_artifact":"findings.md","target_repo":target.root,"target_slug":"task",
            "target_step_key":"build","prompt_extra":"Retain this finding","start":false
        }),
    );
    let result: alinery_core::ReviewHandoffResult = serde_json::from_str(&response).unwrap_or_else(|error| panic!("handoff failed: {response}\n{error}"));
    assert_eq!(Path::new(&result.target_repo_path), target.root.as_path());
    assert_eq!(result.start, "not_requested");
    assert!(result.errors.is_empty());
    let target_artifact = alinery_core::artifact_file_path(&target.root, "task", &result.target_artifact).unwrap();
    assert!(fs::read_to_string(&target_artifact).unwrap().contains("Cross-repository finding"));
    assert!(!source.root.join(".alinery/tasks/task/artifacts").join(&result.target_artifact).exists());
    let retained: TaskExecutionReply = serde_json::from_str(&target.call("alinery_get_task_execution", json!({"task_slug":"task"}))).unwrap();
    assert_eq!(retained.definition.key, "fixture");
    let execution = retained
        .state
        .executions
        .values()
        .find(|execution| execution.owner_session_id == result.target_session.id)
        .unwrap();
    let inputs = &execution.candidate.inputs["ticket.md"];
    assert_eq!(inputs.len(), 1);
    assert_eq!(retained.state.occurrences[&inputs[0]].relative_path, "00-ticket.md");
    let ordinary = retained
        .state
        .executions
        .values()
        .find(|execution| execution.candidate.step_key == "build" && !execution.candidate.manual)
        .unwrap();
    let ordinary_launch = alinery_core::read_meta_launch_fields(&target.root, "task", &ordinary.owner_session_id).unwrap();
    let ordinary_prompt = alinery_core::resolve_launch_prompt(&target.root, &ordinary_launch).unwrap().unwrap();
    assert!(ordinary_prompt.contains("Incoming review: []."));
    // Reload the durable projection, rather than resolving from the create reply.
    let launch = alinery_core::read_meta_launch_fields(&target.root, "task", &result.target_session.id).unwrap();
    let prompt = alinery_core::resolve_launch_prompt(&target.root, &launch).unwrap().unwrap();
    let handoff_instruction = format!("Incoming review: [{}].", target_artifact.display());
    assert!(prompt.contains(&handoff_instruction), "{prompt}");
    let started_response = target.call("alinery_start_session", json!({"task_slug":"task","session_id":result.target_session.id}));
    let started: CreateExecutionSessionReply = serde_json::from_str(&started_response).unwrap_or_else(|error| panic!("start failed: {started_response}\n{error}"));
    assert_eq!(started.start, "started", "{started:?}");
    wait_until(Duration::from_secs(5), || target.prompt_file(&result.target_session.id).exists());
    let seed: Value = serde_json::from_str(&fs::read_to_string(target.prompt_file(&result.target_session.id)).unwrap()).unwrap();
    assert!(seed["message"].as_str().unwrap().contains(&handoff_instruction), "{seed}");
    fs::write(target.stop_file(&result.target_session.id), "stop").unwrap();
}

#[test]
fn review_handoff_metadata_rejects_unsafe_paths_before_reserving_execution() {
    let fixture = Fixture::with_ready_daemon();
    let before = fixture.call("alinery_get_task_execution", json!({"task_slug":"task"}));
    let evidence_link = fixture.root.join(".alinery/tasks/task/artifacts/unsafe.md");
    std::os::unix::fs::symlink(fixture.root.join(".alinery/app.toml"), &evidence_link).unwrap();
    for (artifact, expected_error) in [("../task.md", "invalid artifact path"), ("unsafe.md", "symlink rejected")] {
        let response = fixture.daemon_rpc(json!({
            "op": "create_execution_session",
            "request": {
                "task_slug": "task",
                "target": {"kind": "primary", "step_key": "build"},
                "handoff_artifact": artifact,
                "start": false
            }
        }));
        assert!(response["error"].as_str().unwrap().contains(expected_error), "{response}");
    }
    assert_eq!(fixture.call("alinery_get_task_execution", json!({"task_slug":"task"})), before);
}
