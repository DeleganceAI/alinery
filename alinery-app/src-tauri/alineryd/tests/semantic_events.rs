//! Real socket/PTY coverage for the OMP semantic control plane.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use alinery_core::daemon_client::DaemonClient;
use alinery_core::execution::{CompletionOutcome, ExecutionLifecycle, ExecutionRecord};
use alinery_core::task_creation::{CreateExecutionSessionRequest, CreateTaskRequest, ExecutionSessionTarget, GetTaskExecutionRequest, StartSessionRequest};
use alinery_core::{SessionMeta, RUNNER_EVENT_PROTOCOL_VERSION};
use serde_json::{json, Value};
static ROOT_COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_root() -> PathBuf {
    let counter = ROOT_COUNTER.fetch_add(1, Ordering::Relaxed);
    PathBuf::from(format!("/tmp/sgsem-{}-{counter}", std::process::id()))
}

struct Fixture {
    root: PathBuf,
    socket: PathBuf,
    capture: PathBuf,
    runner: PathBuf,
    shell: Option<PathBuf>,
    host: PathBuf,
    host_enabled: bool,
    child: Child,
}

fn start_daemon(root: &Path, runner: &Path, capture: &Path, protected_host: Option<&Path>, shell: Option<&Path>) -> (Child, PathBuf) {
    let socket = root.join(".alinery/alineryd.sock");
    let mut command = Command::new(env!("CARGO_BIN_EXE_alineryd"));
    command
        .arg("--repo")
        .arg(root)
        .arg("--build-id")
        .arg("semantic-test")
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
    if let Some(shell) = shell {
        command.env("SHELL", shell);
    }
    let mut child = command.spawn().unwrap();

    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        if let Some(status) = child.try_wait().unwrap() {
            let mut stderr = String::new();
            if let Some(pipe) = child.stderr.as_mut() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            panic!("alineryd exited before readiness with {status}; repo {}; stderr: {stderr}", root.display());
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
    panic!("alineryd did not become ready at {}; socket {}", root.display(), socket.display());
}

impl Fixture {
    fn new() -> Self {
        let root = unique_root();
        fs::create_dir_all(root.join(".alinery")).unwrap();
        for args in [
            vec!["init", "-q"],
            vec![
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-qm",
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
        let capture = root.join("runner-events.tsv");
        let runner = root.join("fake-alinery-runner");
        // `capture` is baked in rather than read from the environment: an OMP child inherits only
        // `OMP_ENV_ALLOWLIST` from the daemon, so a fixture var no longer reaches it.
        fs::write(
            &runner,
            format!(
                r#"#!/bin/sh
printf '%s\t%s\t%s\n' "$ALINERY_SESSION_ID" "$ALINERY_EVENT_TOKEN" "$ALINERY_HOST_EXECUTABLE" >> "{capture}"
printf '%s\n' "$@" > "{capture}.$ALINERY_SESSION_ID.args"
printf '%s\n' "$ALINERY_REPO" > "{capture}.$ALINERY_SESSION_ID.repo"
printf '%s\n' "$ALINERY_APP_CONFIG" > "{capture}.$ALINERY_SESSION_ID.app-config"
if [ -f "{capture}.early" ]; then
  printf '{{"op":"event","version":{event_version},"session_id":"%s","token":"%s","event":{{"type":"busy"}}}}\n' "$ALINERY_SESSION_ID" "$ALINERY_EVENT_TOKEN" |
    /usr/bin/nc -U "$ALINERY_DAEMON_SOCKET" >/dev/null 2>&1
fi
shift 4
exec "$@"
"#,
                capture = capture.display(),
                event_version = RUNNER_EVENT_PROTOCOL_VERSION
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&runner).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&runner, permissions).unwrap();

        // Overlay the product omp key. Extra overlay keys are not launchable;
        // tests that need a different binary/adapter rewrite this same-key omp row.
        fs::write(
            root.join(".alinery/harnesses.toml"),
            r#"
[[harness]]
key = "omp"
name = "OMP fixture"
binary = "sh"
args = ["-c", "while [ ! -f \"$ALINERY_REPO/release.$ALINERY_SESSION_ID\" ]; do sleep 0.02; done; printf 'producer drained\\n'"]
model_arg = []
prompt_injection = "arg"
adapter = "omp"
env = { ALINERY_HOST_EXECUTABLE = "harness-override" }

[harness.resume]
enabled = true
id_source = "manual"
resume_args = ["--resume={resume_token}"]
"#,
        )
        .unwrap();

        let shell = root.join("no-harness-shell");
        fs::write(
            &shell,
            format!(
                "#!/bin/sh\nif [ \"$1\" = \"-ilc\" ]; then printf '/usr/bin:/bin:/usr/sbin:/sbin'; exit 0; fi\nprintf '%s' \"${{ALINERY_HOST_EXECUTABLE-}}\" > '{}'\nsleep 30\n",
                root.join("no-harness-host").display()
            ),
        )
        .unwrap();
        let mut shell_permissions = fs::metadata(&shell).unwrap().permissions();
        shell_permissions.set_mode(0o755);
        fs::set_permissions(&shell, shell_permissions).unwrap();

        let host_link = root.join("host-link");
        std::os::unix::fs::symlink(&host, &host_link).unwrap();
        let (child, socket) = start_daemon(&root, &runner, &capture, Some(&host_link), None);
        Self {
            root,
            socket,
            capture,
            runner,
            shell: None,
            host,
            host_enabled: true,
            child,
        }
    }
    fn without_protected_host() -> Self {
        let mut fixture = Self::new();
        fixture.request_shutdown();
        let _ = fixture.child.wait();
        let (child, socket) = start_daemon(&fixture.root, &fixture.runner, &fixture.capture, None, fixture.shell.as_deref());
        fixture.child = child;
        fixture.socket = socket;
        fixture.host_enabled = false;
        fixture
    }

    fn rpc(&self, request: Value) -> Value {
        let mut stream = UnixStream::connect(&self.socket).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        writeln!(stream, "{request}").unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    fn client(&self) -> DaemonClient {
        DaemonClient::connect_path(self.socket.clone()).unwrap()
    }

    fn create_task(&self, automatic: bool) -> SessionMeta {
        let source = r#"+++
version = 2
key = "semantic"
title = "Semantic events"
description = ""
default_model = ""
default_harness = "omp"
[[step]]
key = "source"
title = "Source"
short = ""
is_coding_step = false
auto_advance_default = true
inputs = [{path = "ticket.md", mode = "single"}]
outputs = [{path = "source.md"}]
model = ""
harness = ""
[[step]]
key = "target"
title = "Target"
short = ""
is_coding_step = false
auto_advance_default = true
inputs = [{path = "source.md", mode = "single"}]
outputs = [{path = "target.md"}]
model = ""
harness = ""
+++
<!-- alinery:step source -->
Write the assigned source output.
<!-- alinery:step target -->
Read the assigned input and write the assigned target output.
"#;
        let request: CreateTaskRequest = serde_json::from_value(json!({
            "name": "task", "requested_slug": "task",
            "playbook": {"reference": {"scope": "repo", "key": "semantic"}, "source": source},
            "auto_advance_steps": if automatic { vec!["source", "target"] } else { vec!["target"] },
            "start": false
        }))
        .unwrap();
        let reply = self.client().create_task(&request).unwrap();
        assert_eq!(reply.creation, "ready", "{:?}", reply.errors);
        assert!(reply.errors.is_empty(), "{:?}", reply.errors);
        assert_eq!(reply.sessions.len(), 1);
        let session = reply.sessions.into_iter().next().unwrap();
        assert_eq!(self.execution(&session).lifecycle, ExecutionLifecycle::Queued);
        assert!(!self.execution(&session).start_requested);
        session
    }

    fn auxiliary(&self, task_slug: &str, harness: &str, prompt: Option<&str>) -> SessionMeta {
        self.client()
            .create_execution_session(&CreateExecutionSessionRequest {
                task_slug: task_slug.into(),
                target: ExecutionSessionTarget::Auxiliary {
                    harness: harness.into(),
                    model: None,
                    prompt: prompt.map(str::to_owned),
                },
                launch_override: None,
                prompt_extra: None,
                handoff_artifact: None,
                start: false,
            })
            .unwrap()
            .session
    }

    fn start_response(&self, task_slug: &str, session: &SessionMeta) -> alinery_core::task_creation::CreateExecutionSessionReply {
        self.client()
            .start_session(&StartSessionRequest {
                task_slug: task_slug.into(),
                session_id: session.id.clone(),
            })
            .unwrap()
    }

    fn start(&self, task_slug: &str, session: &SessionMeta) {
        let reply = self.start_response(task_slug, session);
        assert_eq!(reply.start, "started", "{:?}", reply.errors);
        assert!(reply.errors.is_empty(), "{:?}", reply.errors);
    }

    fn meta_path(&self, task_slug: &str, session: &SessionMeta) -> PathBuf {
        if task_slug.is_empty() {
            self.root.join(format!(".alinery/sessions/{}.meta.json", session.id))
        } else {
            self.root.join(format!(".alinery/tasks/{task_slug}/sessions/{}.meta.json", session.id))
        }
    }

    fn state(&self) -> alinery_core::task_creation::TaskExecutionReply {
        self.client().get_task_execution(&GetTaskExecutionRequest { task_slug: "task".into() }).unwrap()
    }

    fn execution(&self, session: &SessionMeta) -> ExecutionRecord {
        self.state().state.executions[&session.execution_id].clone()
    }

    fn output_path(&self, session: &SessionMeta) -> PathBuf {
        self.root.join(".alinery/tasks/task/artifacts").join(&self.execution(session).outputs[0].relative_path)
    }

    fn event(&self, session: &SessionMeta, token: &str, event: Value) -> Value {
        self.rpc(json!({"op": "event", "version": RUNNER_EVENT_PROTOCOL_VERSION,
            "session_id": session.id, "token": token, "event": event}))
    }

    fn complete(&self, session: &SessionMeta, token: &str) -> Value {
        self.event(session, token, json!({"type": "phase_completed", "omp_session_id": "omp-session", "omp_turn_id": 7}))
    }

    fn release(&self, session: &SessionMeta) {
        fs::write(self.root.join(format!("release.{}", session.id)), "").unwrap();
        wait_until(Duration::from_secs(5), || self.rpc(json!({"op":"status", "id":session.id}))["process"]["state"] == "exited");
    }

    fn target(&self) -> ExecutionRecord {
        wait_until(Duration::from_secs(8), || {
            self.state()
                .state
                .executions
                .values()
                .any(|e| e.candidate.step_key == "target" && e.lifecycle == ExecutionLifecycle::Running)
        });
        self.state().state.executions.into_values().find(|e| e.candidate.step_key == "target").unwrap()
    }

    fn token_for(&self, id: &str) -> String {
        wait_until(Duration::from_secs(5), || {
            fs::read_to_string(&self.capture)
                .ok()
                .and_then(|text| {
                    text.lines().find_map(|line| {
                        let mut fields = line.split('\t');
                        let session = fields.next()?;
                        let token = fields.next()?;
                        (session == id).then(|| token.to_string())
                    })
                })
                .is_some()
        });
        fs::read_to_string(&self.capture)
            .unwrap()
            .lines()
            .find_map(|line| {
                let mut fields = line.split('\t');
                let session = fields.next()?;
                let token = fields.next()?;
                (session == id).then(|| token.to_string())
            })
            .unwrap()
    }

    fn host_for(&self, id: &str) -> String {
        wait_until(Duration::from_secs(5), || {
            fs::read_to_string(&self.capture)
                .ok()
                .is_some_and(|text| text.lines().any(|line| line.split('\t').next() == Some(id)))
        });
        fs::read_to_string(&self.capture)
            .unwrap()
            .lines()
            .find_map(|line| {
                let mut fields = line.split('\t');
                let session = fields.next()?;
                let _token = fields.next()?;
                let host = fields.next()?;
                (session == id).then(|| host.to_string())
            })
            .unwrap()
    }
    fn request_shutdown(&self) {
        if let Ok(mut stream) = UnixStream::connect(&self.socket) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = writeln!(stream, "{}", json!({"op": "shutdown"}));
            let mut line = String::new();
            let _ = BufReader::new(stream).read_line(&mut line);
        }
    }

    fn restart(&mut self) {
        self.request_shutdown();
        let _ = self.child.wait();
        let protected_host = self.host_enabled.then_some(self.host.as_path());
        let (child, socket) = start_daemon(&self.root, &self.runner, &self.capture, protected_host, self.shell.as_deref());
        self.child = child;
        self.socket = socket;
    }

    fn with_slow_login_shell() -> Self {
        let mut fixture = Self::new();
        fixture.request_shutdown();
        let _ = fixture.child.wait();

        let shell = fixture.root.join("slow-login-shell");
        fs::write(&shell, "#!/bin/sh\nsleep 1\nprintf '/usr/bin:/bin:/usr/sbin:/sbin\\n'\n").unwrap();
        let mut permissions = fs::metadata(&shell).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&shell, permissions).unwrap();

        let (child, socket) = start_daemon(&fixture.root, &fixture.runner, &fixture.capture, Some(&fixture.host), Some(&shell));
        fixture.child = child;
        fixture.socket = socket;
        fixture.shell = Some(shell);
        fixture
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.request_shutdown();
        let _ = self.child.wait();
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

fn overlay_omp(root: &Path, contents: &str) {
    fs::write(root.join(".alinery/harnesses.toml"), contents).unwrap();
}

fn accepted_receipt(response: &Value) -> String {
    assert_eq!(response["ok"], true, "{response}");
    match serde_json::from_value::<CompletionOutcome>(response["completion"].clone()).unwrap() {
        CompletionOutcome::Accepted { receipt_id } => {
            assert!(!receipt_id.is_empty());
            receipt_id
        }
        other => panic!("expected accepted completion: {other:?}"),
    }
}

#[test]
fn omp_spawn_creates_session_omp_dir() {
    let fixture = Fixture::new();
    let source = fixture.create_task(true);
    fixture.start("task", &source);
    assert!(fixture.meta_path("task", &source).with_file_name(format!("{}.omp", source.id)).is_dir());
}

#[test]
fn no_harness_spawn_does_not_create_session_omp_dir() {
    let mut fixture = Fixture::new();
    fixture.shell = Some(fixture.root.join("no-harness-shell"));
    fixture.restart();
    let session = fixture.auxiliary("", "no-harness", None);
    fixture.start("", &session);
    assert!(!fixture.root.join(format!(".alinery/sessions/{}.omp", session.id)).exists());
}

#[test]
fn protected_host_reaches_only_omp_runner_launches() {
    let mut fixture = Fixture::new();
    let source = fixture.create_task(true);
    fixture.start("task", &source);
    assert_eq!(fixture.host_for(&source.id), fixture.host.to_string_lossy());
    assert!(!fixture
        .rpc(json!({"op":"status", "id":source.id}))
        .to_string()
        .contains(fixture.host.to_string_lossy().as_ref()));

    // Resume launch of a newly created auxiliary owner retains the protected boundary.
    let auxiliary = fixture.auxiliary("task", "omp", None);
    let resumed = fixture.rpc(json!({"op":"resume", "id":auxiliary.id, "task_slug":"task", "resume_token":"resume-token"}));
    assert_eq!(resumed["ok"], true, "{resumed}");
    assert!(!resumed.to_string().contains(fixture.host.to_string_lossy().as_ref()));
    assert_eq!(fixture.host_for(&auxiliary.id), fixture.host.to_string_lossy());
    overlay_omp(
        &fixture.root,
        r#"
[[harness]]
key = "omp"
name = "Unsupported fixture"
binary = "sh"
args = ["-c", "printf '%s' \"$ALINERY_HOST_EXECUTABLE\" > \"{worktree}/unsupported-host\"; sleep 30"]
model_arg = []
prompt_injection = "arg"
adapter = "unsupported"
"#,
    );
    let unsupported = fixture.auxiliary("task", "omp", None);
    fixture.start("task", &unsupported);
    let capture = Path::new(&unsupported.worktree).join("unsupported-host");
    wait_until(Duration::from_secs(5), || capture.exists());
    assert_eq!(fs::read_to_string(capture).unwrap(), "");
    assert!(!fs::read_to_string(&fixture.capture)
        .unwrap()
        .lines()
        .any(|line| line.starts_with(&format!("{}\t", unsupported.id))));

    fixture.shell = Some(fixture.root.join("no-harness-shell"));
    fixture.restart();
    let terminal = fixture.auxiliary("", "no-harness", None);
    fixture.start("", &terminal);
    wait_until(Duration::from_secs(5), || fixture.root.join("no-harness-host").exists());
    assert_eq!(fs::read_to_string(fixture.root.join("no-harness-host")).unwrap(), "");
}

#[test]
fn missing_protected_host_rejects_only_omp_launches() {
    let mut fixture = Fixture::without_protected_host();
    assert_eq!(fixture.rpc(json!({"op":"version"}))["host_guard_ready"], false);
    let source = fixture.create_task(true);
    let rejected = fixture.start_response("task", &source);
    assert_eq!(rejected.start, "failed");
    assert!(!rejected.errors.is_empty());
    let meta: SessionMeta = serde_json::from_slice(&fs::read(fixture.meta_path("task", &source)).unwrap()).unwrap();
    assert!(meta.started_at.is_none());
    assert_eq!(fixture.rpc(json!({"op":"status", "id":source.id}))["error"], "unknown-session");
    let auxiliary = fixture.auxiliary("task", "omp", None);
    let resumed = fixture.rpc(json!({"op":"resume", "id":auxiliary.id, "task_slug":"task", "resume_token":"resume-token"}));
    assert!(resumed["error"].is_string());
    assert_eq!(fixture.rpc(json!({"op":"status", "id":auxiliary.id}))["error"], "unknown-session");
    overlay_omp(
        &fixture.root,
        r#"
[[harness]]
key = "omp"
name = "Unsupported fixture"
binary = "sh"
args = ["-c", "sleep 30"]
model_arg = []
prompt_injection = "arg"
adapter = "unsupported"
"#,
    );
    let direct = fixture.auxiliary("task", "omp", None);
    fixture.start("task", &direct);
    assert_eq!(fixture.rpc(json!({"op":"status", "id":direct.id}))["adapter"], "unsupported");
    fixture.shell = Some(fixture.root.join("no-harness-shell"));
    fixture.restart();
    let terminal = fixture.auxiliary("", "no-harness", None);
    fixture.start("", &terminal);
}

#[test]
fn phase_less_generic_omp_spawn_keeps_seed_without_completion_contract() {
    let fixture = Fixture::new();
    fixture.create_task(true);
    let session = fixture.auxiliary("task", "omp", Some("Keep this auxiliary seed."));
    overlay_omp(
        &fixture.root,
        r#"[[harness]]
key = "omp"
name = "OMP seed fixture"
binary = "sh"
args = ["-c", '''printf '%s\n' '{"type":"ready"}'; while IFS= read -r line; do printf '%s\n' "$line" >> "$ALINERY_REPO/seed.$ALINERY_SESSION_ID"; done''']
model_arg = []
prompt_injection = "arg"
adapter = "omp"
"#,
    );
    fixture.start("task", &session);
    let args_path = fixture.root.join(format!("seed.{}", session.id));
    wait_until(Duration::from_secs(5), || {
        fs::read_to_string(&args_path).is_ok_and(|text| text.contains("Keep this auxiliary seed."))
    });
    let args = fs::read_to_string(args_path).unwrap();
    assert!(!args.contains("alinery_phase_complete"), "auxiliary sessions cannot complete an execution: {args}");
    let status = fixture.rpc(json!({"op":"status", "id":session.id}));
    assert_eq!(status["process"]["state"], "alive");
    assert_eq!(status["adapter"], "omp");
    assert_eq!(
        fs::read_to_string(fixture.root.join(format!("runner-events.tsv.{}.repo", session.id))).unwrap().trim(),
        fixture.root.to_string_lossy()
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join(format!("runner-events.tsv.{}.app-config", session.id)))
            .unwrap()
            .trim(),
        fixture.root.join(".alinery/unused-app-config.toml").to_string_lossy()
    );
    let token = fixture.token_for(&session.id);
    assert!(fixture.complete(&session, &token)["error"].is_string());
    assert_eq!(fixture.state().state.executions.len(), 1);
}

#[test]
fn callback_emitted_during_child_startup_is_authenticated() {
    let fixture = Fixture::new();
    fs::write(format!("{}.early", fixture.capture.display()), "").unwrap();
    let source = fixture.create_task(true);
    fixture.start("task", &source);
    wait_until(Duration::from_secs(5), || {
        let status = fixture.rpc(json!({"op":"status", "id":source.id}));
        status["process"]["state"] == "alive" && status["agent"]["state"] == "busy"
    });
    let meta: SessionMeta = serde_json::from_slice(&fs::read(fixture.meta_path("task", &source)).unwrap()).unwrap();
    assert!(meta.started_at.is_some());
    assert_eq!(meta.status_changed_at, meta.started_at);
}

#[test]
fn status_changed_at_runner_transitions_are_normalized() {
    let fixture = Fixture::new();
    let source = fixture.create_task(true);
    let id = source.id.as_str();
    let meta_path = fixture.meta_path("task", &source);
    fixture.start("task", &source);
    let token = fixture.token_for(id);
    let send = |event: Value| {
        let response = fixture.rpc(json!({
            "op": "event",
            "version": RUNNER_EVENT_PROTOCOL_VERSION,
            "session_id": id,
            "token": token,
            "event": event,
        }));
        assert_eq!(response["ok"], true, "event response: {response}");
    };

    let mut seeded: Value = serde_json::from_slice(&fs::read(&meta_path).unwrap()).unwrap();
    let initial = seeded["status_changed_at"].as_u64().expect("fresh spawn status timestamp");
    let initial_revision = seeded["status_revision"].as_u64().expect("fresh spawn status revision");
    seeded["notification_read_at"] = json!(17);
    seeded["exit_notification_read_at"] = json!(19);
    seeded["harness_resume_token"] = json!("resume-token");
    seeded["sentinel"] = json!({"keep": true});
    fs::write(&meta_path, serde_json::to_vec(&seeded).unwrap()).unwrap();

    let before_busy = fs::read(&meta_path).unwrap();
    let before_busy_modified = fs::metadata(&meta_path).unwrap().modified().unwrap();
    send(json!({"type": "busy"}));
    assert_eq!(fs::read(&meta_path).unwrap(), before_busy, "Alive/Unknown and Busy are both In progress");
    assert_eq!(fs::metadata(&meta_path).unwrap().modified().unwrap(), before_busy_modified);

    send(json!({"type": "waiting_for_input", "correlation_id": "ask-1"}));
    let waiting: Value = serde_json::from_slice(&fs::read(&meta_path).unwrap()).unwrap();
    assert!(waiting["status_changed_at"].as_u64().unwrap() >= initial);
    assert!(waiting["status_revision"].as_u64().unwrap() > initial_revision);
    assert_eq!(waiting["notification_read_at"], 17);
    assert_eq!(waiting["exit_notification_read_at"], 19);
    assert_eq!(waiting["harness_resume_token"], "resume-token");
    assert_eq!(waiting["sentinel"]["keep"], true);

    let before_correlation = fs::read(&meta_path).unwrap();
    let before_correlation_modified = fs::metadata(&meta_path).unwrap().modified().unwrap();
    send(json!({"type": "waiting_for_input", "correlation_id": "ask-2"}));
    assert_eq!(fs::read(&meta_path).unwrap(), before_correlation, "wait correlation changes are payload-only");
    assert_eq!(fs::metadata(&meta_path).unwrap().modified().unwrap(), before_correlation_modified);

    send(json!({"type": "busy", "correlation_id": "ask-2"}));
    assert_eq!(fixture.rpc(json!({"op": "status", "id": id}))["agent"]["state"], "busy");
    send(json!({"type": "waiting_for_approval", "correlation_id": "approval-1"}));
    assert_eq!(fixture.rpc(json!({"op": "status", "id": id}))["agent"]["state"], "waiting_for_approval");
    let before_approval_correlation = fs::read(&meta_path).unwrap();
    let before_approval_modified = fs::metadata(&meta_path).unwrap().modified().unwrap();
    send(json!({"type": "waiting_for_approval", "correlation_id": "approval-2"}));
    assert_eq!(fs::read(&meta_path).unwrap(), before_approval_correlation);
    assert_eq!(fs::metadata(&meta_path).unwrap().modified().unwrap(), before_approval_modified);
    send(json!({"type": "busy", "correlation_id": "approval-2"}));
    send(json!({"type": "idle"}));
    assert_eq!(fixture.rpc(json!({"op": "status", "id": id}))["agent"]["state"], "idle");
    let before_repeated_idle = fs::read(&meta_path).unwrap();
    let before_idle_modified = fs::metadata(&meta_path).unwrap().modified().unwrap();
    send(json!({"type": "idle"}));
    assert_eq!(fs::read(&meta_path).unwrap(), before_repeated_idle);
    assert_eq!(fs::metadata(&meta_path).unwrap().modified().unwrap(), before_idle_modified);
    send(json!({"type": "adapter_error", "detail": "boom"}));
    assert_eq!(fixture.rpc(json!({"op": "status", "id": id}))["playbook"]["state"], "failed");

    let before_failure_detail = fs::read(&meta_path).unwrap();
    let before_failure_modified = fs::metadata(&meta_path).unwrap().modified().unwrap();
    send(json!({"type": "adapter_error", "detail": "different boom"}));
    assert_eq!(fs::read(&meta_path).unwrap(), before_failure_detail, "failure detail remains one visible class");
    assert_eq!(fs::metadata(&meta_path).unwrap().modified().unwrap(), before_failure_modified);

    let final_meta: Value = serde_json::from_slice(&fs::read(&meta_path).unwrap()).unwrap();
    assert!(final_meta["status_changed_at"].as_u64().unwrap() >= initial);
    assert!(final_meta["status_revision"].as_u64().unwrap() > initial_revision);
    assert_eq!(final_meta["sentinel"]["keep"], true);
}

#[test]
fn reversible_transition_is_not_published_when_stamp_fails() {
    let fixture = Fixture::new();
    let source = fixture.create_task(true);
    fixture.start("task", &source);
    let token = fixture.token_for(&source.id);
    let meta_path = fixture.meta_path("task", &source);
    let directory = meta_path.parent().unwrap();
    let permissions = PermissionGuard::readonly(directory);
    let waiting = fixture.event(&source, &token, json!({"type":"waiting_for_input", "correlation_id":"ask"}));
    drop(permissions);
    assert!(waiting["error"].is_string(), "{waiting}");
    let status = fixture.rpc(json!({"op":"status", "id":source.id}));
    assert_eq!(status["agent"]["state"], "unknown");
    assert_eq!(status["playbook"]["state"], "in_progress");
    assert!(fixture.execution(&source).receipt_id.is_none());
}

struct PermissionGuard {
    path: PathBuf,
    mode: u32,
}
impl PermissionGuard {
    fn readonly(path: &Path) -> Self {
        let guard = Self {
            path: path.into(),
            mode: fs::metadata(path).unwrap().permissions().mode(),
        };
        fs::set_permissions(path, fs::Permissions::from_mode(0o555)).unwrap();
        guard
    }
}
impl Drop for PermissionGuard {
    fn drop(&mut self) {
        fs::set_permissions(&self.path, fs::Permissions::from_mode(self.mode)).unwrap();
    }
}

#[test]
fn completion_receipt_requires_authoritative_persistence_not_projection() {
    let fixture = Fixture::new();
    let source = fixture.create_task(true);
    fixture.start("task", &source);
    let token = fixture.token_for(&source.id);
    fs::write(fixture.output_path(&source), "complete").unwrap();
    let state_path = fixture.root.join(".alinery/tasks/task/execution.json");
    let before = fs::read(&state_path).unwrap();
    let permissions = PermissionGuard::readonly(state_path.parent().unwrap());
    let failed = fixture.complete(&source, &token);
    drop(permissions);
    assert!(failed["error"].is_string(), "{failed}");
    assert!(failed.get("completion").is_none(), "{failed}");
    assert_eq!(fs::read(&state_path).unwrap(), before);
    assert!(fixture.execution(&source).receipt_id.is_none());
    assert_eq!(fixture.execution(&source).lifecycle, ExecutionLifecycle::Running);

    // Session metadata is a repairable projection: its failure cannot revoke an
    // execution.json receipt that has already committed.
    let path = fixture.meta_path("task", &source);
    let permissions = PermissionGuard::readonly(path.parent().unwrap());
    let accepted = fixture.complete(&source, &token);
    drop(permissions);
    let receipt = accepted_receipt(&accepted);
    assert_eq!(fixture.execution(&source).receipt_id.as_deref(), Some(receipt.as_str()));
    assert_eq!(fixture.execution(&source).lifecycle, ExecutionLifecycle::Finishing);
}

#[test]
fn structured_events_require_the_live_token_and_advance_exactly_once() {
    let fixture = Fixture::new();
    let source = fixture.create_task(true);
    fixture.start("task", &source);
    let token = fixture.token_for(&source.id);
    let auxiliary = fixture.auxiliary("task", "omp", None);
    fixture.start("task", &auxiliary);
    let other_token = fixture.token_for(&auxiliary.id);
    assert!(!token.is_empty());
    assert_eq!(fixture.event(&auxiliary, &token, json!({"type":"busy"}))["error"], "invalid-event-token");
    assert_eq!(fixture.event(&source, &other_token, json!({"type":"busy"}))["error"], "invalid-event-token");
    assert_eq!(fixture.event(&source, "wrong", json!({"type":"busy"}))["error"], "invalid-event-token");
    assert_eq!(
        fixture.rpc(json!({"op":"event", "version":RUNNER_EVENT_PROTOCOL_VERSION + 1, "session_id":source.id, "token":token, "event":{"type":"busy"}}))["error"],
        "unsupported-event-version"
    );
    assert_eq!(
        fixture.rpc(json!({"op":"event", "version":RUNNER_EVENT_PROTOCOL_VERSION, "session_id":"unknown", "token":token, "event":{"type":"busy"}}))["error"],
        "unknown-session"
    );
    assert!(fixture.complete(&auxiliary, &other_token)["error"].is_string());
    let status = fixture.rpc(json!({"op":"status", "id":source.id}));
    assert_eq!(status["process"]["state"], "alive");
    assert_eq!(status["agent"]["state"], "unknown");
    assert_eq!(status["playbook"]["state"], "in_progress");
    assert_eq!(status["adapter"], "omp");
    assert!(status.get("status").is_none());
    let list = fixture.rpc(json!({"op":"list"}));
    let row = list["sessions"].as_array().unwrap().iter().find(|row| row["id"] == source.id).unwrap();
    assert_eq!(row["process"]["state"], "alive");
    assert_eq!(row["adapter"], "omp");
    assert_eq!(fixture.event(&source, &token, json!({"type":"busy"}))["ok"], true);
    assert_eq!(fixture.event(&source, &token, json!({"type":"waiting_for_input", "correlation_id":"ask"}))["ok"], true);
    assert_eq!(fixture.event(&source, &token, json!({"type":"busy", "correlation_id":"other"}))["ok"], true);
    assert_eq!(fixture.rpc(json!({"op":"status", "id":source.id}))["agent"]["state"], "waiting_for_input");
    assert_eq!(fixture.event(&source, &token, json!({"type":"busy", "correlation_id":"ask"}))["ok"], true);
    fs::write(fixture.output_path(&source), "complete").unwrap();
    assert!(fixture.execution(&source).receipt_id.is_none());
    assert_eq!(fixture.state().state.executions.len(), 1);
    let receipt = accepted_receipt(&fixture.complete(&source, &token));
    let finishing = fixture.execution(&source);
    assert_eq!(finishing.lifecycle, ExecutionLifecycle::Finishing);
    assert!(!finishing.shutdown_confirmed);
    assert_eq!(fixture.rpc(json!({"op":"status", "id":source.id}))["process"]["state"], "alive");
    assert_eq!(fixture.state().state.executions.len(), 1, "live producer must not release a successor");
    assert_eq!(accepted_receipt(&fixture.complete(&source, &token)), receipt);
    assert_eq!(fixture.state().state.executions.len(), 1);
    let checkpoint: Value = serde_json::from_slice(&fs::read(fixture.meta_path("task", &source)).unwrap()).unwrap();
    assert_eq!(checkpoint["semantic"]["omp_session_id"], "omp-session");
    assert_eq!(checkpoint["semantic"]["omp_turn_id"], 7);
    for transient in ["event_token", "process_state", "agent_state", "playbook_state"] {
        assert!(checkpoint.get(transient).is_none());
    }
    fixture.release(&source);
    let target = fixture.target();
    assert_eq!(fixture.host_for(&target.owner_session_id), fixture.host.to_string_lossy());
    assert_eq!(fixture.execution(&source).lifecycle, ExecutionLifecycle::Completed);
    assert!(fixture.execution(&source).shutdown_confirmed);
    assert_eq!(fixture.state().state.executions.values().filter(|e| e.candidate.step_key == "target").count(), 1);
    assert_eq!(fixture.event(&source, &token, json!({"type":"busy"}))["error"], "session-exited");
    let ended: SessionMeta = serde_json::from_slice(&fs::read(fixture.meta_path("task", &source)).unwrap()).unwrap();
    assert!(ended.ended_at.is_some());
    assert!(ended.status_changed_at >= ended.started_at);
}

#[test]
fn completion_ack_precedes_slow_auto_advance() {
    let fixture = Fixture::with_slow_login_shell();
    let source = fixture.create_task(true);
    fixture.start("task", &source);
    let token = fixture.token_for(&source.id);
    fs::write(fixture.output_path(&source), "complete").unwrap();
    let started = Instant::now();
    accepted_receipt(&fixture.complete(&source, &token));
    let elapsed = started.elapsed();
    assert!(elapsed < Duration::from_millis(250), "receipt acknowledgement exceeded runner deadline: {elapsed:?}");
    assert_eq!(fixture.execution(&source).lifecycle, ExecutionLifecycle::Finishing);
    assert_eq!(fixture.state().state.executions.len(), 1);
    fixture.release(&source);
    fixture.target();
}

#[test]
fn accepted_live_owner_is_not_handed_off_after_restart_without_exit_proof() {
    let mut fixture = Fixture::new();
    let source = fixture.create_task(true);
    fixture.start("task", &source);
    let token = fixture.token_for(&source.id);
    fs::write(fixture.output_path(&source), "complete").unwrap();
    let receipt = accepted_receipt(&fixture.complete(&source, &token));
    fixture.restart();
    let execution = fixture.execution(&source);
    assert_eq!(execution.receipt_id.as_deref(), Some(receipt.as_str()));
    // Shutdown may prove the reap; otherwise restart must retain uncertain ownership.
    if execution.shutdown_confirmed {
        assert_eq!(execution.lifecycle, ExecutionLifecycle::Completed);
    } else {
        assert_eq!(execution.lifecycle, ExecutionLifecycle::Interrupted);
        assert_eq!(fixture.state().state.executions.len(), 1);
    }
}

#[test]
fn failed_successor_launch_requires_explicit_recovery_without_duplicate_execution() {
    let mut fixture = Fixture::new();
    let source = fixture.create_task(true);
    fixture.start("task", &source);
    let token = fixture.token_for(&source.id);
    fs::write(fixture.output_path(&source), "complete").unwrap();
    accepted_receipt(&fixture.complete(&source, &token));
    let hidden_runner = fixture.root.join("saved-runner");
    fs::rename(&fixture.runner, &hidden_runner).unwrap();
    fixture.release(&source);
    wait_until(Duration::from_secs(5), || {
        fixture
            .state()
            .state
            .executions
            .values()
            .any(|e| e.candidate.step_key == "target" && e.lifecycle == ExecutionLifecycle::LaunchFailed)
    });
    let failed = fixture.state().state.executions.into_values().find(|e| e.candidate.step_key == "target").unwrap();
    fs::rename(hidden_runner, &fixture.runner).unwrap();
    fixture.restart();
    assert_eq!(fixture.state().state.executions[&failed.id].lifecycle, ExecutionLifecycle::LaunchFailed);
    let recovered = fixture
        .client()
        .create_execution_session(&CreateExecutionSessionRequest {
            task_slug: "task".into(),
            target: ExecutionSessionTarget::Primary {
                step_key: "target".into(),
                execution_id: Some(failed.id.clone()),
                input_occurrence_ids: None,
            },
            launch_override: None,
            prompt_extra: None,
            handoff_artifact: None,
            start: false,
        })
        .unwrap();
    assert_ne!(recovered.session.id, failed.owner_session_id);
    fixture.start("task", &recovered.session);
    let target = fixture.target();
    assert_eq!(target.id, failed.id);
    assert_eq!(fixture.state().state.executions.len(), 2);
    assert!(!fixture.token_for(&recovered.session.id).is_empty());
    assert!(fixture
        .client()
        .start_session(&StartSessionRequest {
            task_slug: "task".into(),
            session_id: failed.owner_session_id
        })
        .is_err());
}

#[test]
fn missing_runner_blocks_only_omp_adapted_spawn() {
    let fixture = Fixture::new();
    let source = fixture.create_task(true);
    fs::remove_file(&fixture.runner).unwrap();
    let rejected = fixture.start_response("task", &source);
    assert_eq!(rejected.start, "failed");
    assert!(!rejected.errors.is_empty());
    let meta: SessionMeta = serde_json::from_slice(&fs::read(fixture.meta_path("task", &source)).unwrap()).unwrap();
    assert!(meta.started_at.is_none());
    overlay_omp(
        &fixture.root,
        r#"
[[harness]]
key = "omp"
name = "Broken fixture"
binary = "/definitely/missing/alinery-harness"
args = []
model_arg = []
prompt_injection = "arg"
adapter = "unsupported"
"#,
    );
    let broken = fixture.auxiliary("task", "omp", None);
    assert_eq!(fixture.start_response("task", &broken).start, "failed");
    assert_eq!(fixture.rpc(json!({"op":"status", "id":broken.id}))["error"], "unknown-session");
    let rolled_back: SessionMeta = serde_json::from_slice(&fs::read(fixture.meta_path("task", &broken)).unwrap()).unwrap();
    assert!(rolled_back.started_at.is_none());
    overlay_omp(
        &fixture.root,
        r#"
[[harness]]
key = "omp"
name = "Unsupported fixture"
binary = "sh"
args = ["-c", "sleep 30"]
model_arg = []
prompt_injection = "arg"
adapter = "unsupported"
"#,
    );
    let direct = fixture.auxiliary("task", "omp", None);
    fixture.start("task", &direct);
    let status = fixture.rpc(json!({"op":"status", "id":direct.id}));
    assert_eq!(status["process"]["state"], "alive");
    assert_eq!(status["adapter"], "unsupported");
    assert!(!fixture.capture.exists());
}

#[test]
fn oversized_runner_event_is_rejected_before_state_mutation() {
    let fixture = Fixture::new();
    let source = fixture.create_task(true);
    fixture.start("task", &source);
    let token = fixture.token_for(&source.id);
    let request = json!({"op": "event", "version": RUNNER_EVENT_PROTOCOL_VERSION,
        "session_id": source.id, "token": token, "event": {"type":"adapter_error", "detail":"x".repeat(130 * 1024)}});
    let mut stream = UnixStream::connect(&fixture.socket).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    // Rejection can close the socket before an oversized frame finishes writing.
    if let Err(error) = writeln!(stream, "{request}") {
        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
    }
    let mut response = String::new();
    BufReader::new(stream).read_line(&mut response).unwrap();
    let response: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(response["error"], "request-too-large");
    let status = fixture.rpc(json!({"op":"status", "id":source.id}));
    assert_eq!(status["agent"]["state"], "unknown");
    assert_eq!(status["playbook"]["state"], "in_progress");
}

#[test]
fn invalid_artifact_is_nonfatal_and_can_be_fixed_before_completion() {
    let fixture = Fixture::new();
    let source = fixture.create_task(true);
    fixture.start("task", &source);
    let token = fixture.token_for(&source.id);
    for content in [None, Some("")] {
        if let Some(content) = content {
            fs::write(fixture.output_path(&source), content).unwrap();
        }
        let response = fixture.complete(&source, &token);
        assert_eq!(response["ok"], true, "{response}");
        assert!(
            matches!(serde_json::from_value::<CompletionOutcome>(response["completion"].clone()).unwrap(), CompletionOutcome::InvalidOutputs { diagnostics } if !diagnostics.is_empty())
        );
        assert!(fixture.execution(&source).receipt_id.is_none());
        assert_eq!(fixture.execution(&source).lifecycle, ExecutionLifecycle::Running);
        assert_eq!(fixture.rpc(json!({"op":"status", "id":source.id}))["playbook"]["state"], "in_progress");
        assert_eq!(fixture.state().state.executions.len(), 1);
    }
    fs::write(fixture.output_path(&source), "complete").unwrap();
    accepted_receipt(&fixture.complete(&source, &token));
    assert_eq!(fixture.execution(&source).lifecycle, ExecutionLifecycle::Finishing);
    fixture.release(&source);
    fixture.target();
}

#[test]
fn human_locked_completion_is_nonfatal_and_cannot_be_granted_by_runner_socket() {
    let fixture = Fixture::new();
    let source = fixture.create_task(false);
    fixture.start("task", &source);
    let token = fixture.token_for(&source.id);
    fs::write(fixture.output_path(&source), "complete").unwrap();
    let response = fixture.complete(&source, &token);
    assert_eq!(response["ok"], true, "{response}");
    assert!(matches!(
        serde_json::from_value::<CompletionOutcome>(response["completion"].clone()).unwrap(),
        CompletionOutcome::HumanAuthorizationRequired
    ));
    let denied = fixture
        .rpc(json!({"op":"allow_execution_completion", "request":{"task_slug":"task", "execution_id":source.execution_id, "session_id":source.id}, "token":token, "caller":"ui"}));
    assert!(denied["error"].is_string());
    assert!(fixture.execution(&source).receipt_id.is_none());
    assert_eq!(fixture.execution(&source).lifecycle, ExecutionLifecycle::Running);
    assert_eq!(fixture.complete(&source, &token)["completion"]["status"], "human_authorization_required");
}

#[test]
fn mismatched_session_lane_cannot_start_an_execution() {
    let fixture = Fixture::new();
    let source = fixture.create_task(true);
    let path = fixture.meta_path("task", &source);
    let original = fs::read(&path).unwrap();
    let mut projection: Value = serde_json::from_slice(&original).unwrap();
    projection["daemon_namespace"] = json!("another-lane");
    fs::write(&path, serde_json::to_vec(&projection).unwrap()).unwrap();
    let denied = fixture.client().start_session(&StartSessionRequest {
        task_slug: "task".into(),
        session_id: source.id.clone(),
    });
    fs::write(path, original).unwrap();
    assert!(denied.is_err());
    assert_eq!(fixture.execution(&source).lifecycle, ExecutionLifecycle::Queued);
    assert!(!fixture.capture.exists());
    fixture.start("task", &source);
}

#[test]
fn missing_protected_host_requires_explicit_recovery_after_ready_restart() {
    let mut fixture = Fixture::without_protected_host();
    let source = fixture.create_task(true);
    assert_eq!(fixture.start_response("task", &source).start, "failed");
    assert_eq!(fixture.execution(&source).lifecycle, ExecutionLifecycle::LaunchFailed);
    fixture.host_enabled = true;
    fixture.restart();
    assert_eq!(fixture.execution(&source).lifecycle, ExecutionLifecycle::LaunchFailed);
    assert!(!fixture.capture.exists(), "failed work must not silently acquire a new owner");
    let recovered = fixture
        .client()
        .create_execution_session(&CreateExecutionSessionRequest {
            task_slug: "task".into(),
            target: ExecutionSessionTarget::Primary {
                step_key: "source".into(),
                execution_id: Some(source.execution_id.clone()),
                input_occurrence_ids: None,
            },
            launch_override: None,
            prompt_extra: None,
            handoff_artifact: None,
            start: false,
        })
        .unwrap();
    assert_ne!(recovered.session.id, source.id);
    assert!(fixture
        .client()
        .start_session(&StartSessionRequest {
            task_slug: "task".into(),
            session_id: source.id.clone()
        })
        .is_err());
    fixture.start("task", &recovered.session);
    assert_eq!(fixture.host_for(&recovered.session.id), fixture.host.to_string_lossy());
    assert_eq!(fixture.state().state.executions.len(), 1);
}
