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

use alinery_core::{SemanticCheckpoint, SessionMeta, Task};
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
  printf '{{"op":"event","version":1,"session_id":"%s","token":"%s","event":{{"type":"busy"}}}}\n' "$ALINERY_SESSION_ID" "$ALINERY_EVENT_TOKEN" |
    /usr/bin/nc -U "$ALINERY_DAEMON_SOCKET" >/dev/null 2>&1
fi
shift 4
exec "$@"
"#,
                capture = capture.display()
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
args = ["-c", "sleep 30"]
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

    fn open_response(&self, op: &str, id: &str, task_slug: &str, harness: &str, phase: &str, resume_token: Option<&str>) -> String {
        let mut stream = UnixStream::connect(&self.socket).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        writeln!(
            stream,
            "{}",
            json!({
                "op": op,
                "id": id,
                "cwd": self.root,
                "task_slug": task_slug,
                "harness": harness,
                "model": "",
                "phase": phase,
                "resume_token": resume_token,
                "attach_id": 1,
                "cols": 80,
                "rows": 24
            })
        )
        .unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        line
    }

    fn spawn_response(&self, id: &str, harness: &str, phase: &str) -> String {
        self.open_response("spawn", id, "task", harness, phase, None)
    }

    fn spawn_session(&self, id: &str, harness: &str, phase: &str) {
        let line = self.spawn_response(id, harness, phase);
        assert!(line.contains("\"ok\":true"), "spawn response: {line}");
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

fn write_task_and_source(root: &Path, id: &str) -> PathBuf {
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
        auto_advance: vec!["questions_to_research".into()],
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
        semantic: SemanticCheckpoint::default(),
        ..Default::default()
    };
    let path = sessions.join(format!("{id}.meta.json"));
    fs::write(&path, serde_json::to_vec(&source).unwrap()).unwrap();
    path
}

fn write_generic_omp_meta(root: &Path, id: &str) -> PathBuf {
    let path = write_task_and_source(root, id);
    let mut meta: SessionMeta = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    meta.phase.clear();
    meta.artifact.clear();
    meta.generic = true;
    fs::write(&path, serde_json::to_vec(&meta).unwrap()).unwrap();
    path
}

fn write_stale_omp_meta(root: &Path, id: &str) -> PathBuf {
    let meta = SessionMeta {
        id: id.into(),
        worktree: root.to_string_lossy().into_owned(),
        created: 0,
        phase: "research-questions".into(),
        harness: "omp".into(),
        playbook: "superdevelop".into(),
        artifact: "01-research-questions.md".into(),
        ..Default::default()
    };
    let path = root.join(".alinery/tasks/task/sessions").join(format!("{id}.meta.json"));
    fs::write(&path, serde_json::to_vec(&meta).unwrap()).unwrap();
    path
}

fn overlay_omp(root: &Path, contents: &str) {
    fs::write(root.join(".alinery/harnesses.toml"), contents).unwrap();
}

fn write_unsupported_meta(root: &Path, id: &str) {
    let meta = SessionMeta {
        id: id.into(),
        worktree: root.to_string_lossy().into_owned(),
        created: 3,
        harness: "omp".into(),
        playbook: "superdevelop".into(),
        ..Default::default()
    };
    fs::write(
        root.join(".alinery/tasks/task/sessions").join(format!("{id}.meta.json")),
        serde_json::to_vec(&meta).unwrap(),
    )
    .unwrap();
}

#[test]
fn omp_spawn_creates_session_omp_dir() {
    let fixture = Fixture::new();
    write_task_and_source(&fixture.root, "s1");
    fixture.spawn_session("s1", "omp", "research-questions");
    let dir = fixture.root.join(".alinery/tasks/task/sessions/s1.omp");
    assert!(dir.is_dir(), "expected OMP session dir {}", dir.display());
}

#[test]
fn no_harness_spawn_does_not_create_session_omp_dir() {
    let mut fixture = Fixture::new();
    fixture.shell = Some(fixture.root.join("no-harness-shell"));
    fixture.restart();
    fs::create_dir_all(fixture.root.join(".alinery/sessions")).unwrap();
    let meta = SessionMeta {
        id: "root-nh".into(),
        worktree: fixture.root.to_string_lossy().into_owned(),
        harness: "no-harness".into(),
        ..Default::default()
    };
    fs::write(fixture.root.join(".alinery/sessions/root-nh.meta.json"), serde_json::to_vec(&meta).unwrap()).unwrap();
    let spawned = fixture.open_response("spawn", "root-nh", "", "no-harness", "", None);
    assert!(spawned.contains("\"ok\":true"), "no-harness spawn response: {spawned}");
    assert!(!fixture.root.join(".alinery/sessions/root-nh.omp").exists());
}
#[test]
fn protected_host_reaches_only_omp_runner_launches() {
    let mut fixture = Fixture::new();

    write_task_and_source(&fixture.root, "fresh-host");
    let fresh = fixture.spawn_response("fresh-host", "omp", "research-questions");
    assert!(fresh.contains("\"ok\":true"), "fresh spawn response: {fresh}");
    assert_eq!(fixture.host_for("fresh-host"), fixture.host.to_string_lossy());
    assert!(!fresh.contains(fixture.host.to_string_lossy().as_ref()));

    let resume_path = write_stale_omp_meta(&fixture.root, "resume-host");
    let mut resume_meta: SessionMeta = serde_json::from_slice(&fs::read(&resume_path).unwrap()).unwrap();
    resume_meta.harness_resume_token = "resume-token".into();
    fs::write(&resume_path, serde_json::to_vec(&resume_meta).unwrap()).unwrap();
    let resumed = fixture.open_response("resume", "resume-host", "task", "omp", "", Some("resume-token"));
    assert!(resumed.contains("\"ok\":true"), "resume response: {resumed}");
    assert_eq!(fixture.host_for("resume-host"), fixture.host.to_string_lossy());
    assert!(!resumed.contains(fixture.host.to_string_lossy().as_ref()));

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
    write_unsupported_meta(&fixture.root, "unsupported-host");
    fixture.spawn_session("unsupported-host", "omp", "");
    wait_until(Duration::from_secs(5), || fixture.root.join("unsupported-host").exists());
    assert_eq!(fs::read_to_string(fixture.root.join("unsupported-host")).unwrap(), "");

    fixture.shell = Some(fixture.root.join("no-harness-shell"));
    fixture.restart();

    fs::create_dir_all(fixture.root.join(".alinery/sessions")).unwrap();
    let root_meta = SessionMeta {
        id: "root-host".into(),
        worktree: fixture.root.to_string_lossy().into_owned(),
        harness: "no-harness".into(),
        ..Default::default()
    };
    fs::write(fixture.root.join(".alinery/sessions/root-host.meta.json"), serde_json::to_vec(&root_meta).unwrap()).unwrap();
    let root_spawn = fixture.open_response("spawn", "root-host", "", "no-harness", "", None);
    assert!(root_spawn.contains("\"ok\":true"), "root spawn response: {root_spawn}");
    wait_until(Duration::from_secs(5), || fixture.root.join("no-harness-host").exists());
    assert_eq!(fs::read_to_string(fixture.root.join("no-harness-host")).unwrap(), "");

    let runner_capture = fs::read_to_string(&fixture.capture).unwrap();
    assert!(runner_capture
        .lines()
        .all(|line| !line.starts_with("unsupported-host\t") && !line.starts_with("root-host\t")));
}

#[test]
fn missing_protected_host_rejects_only_omp_launches() {
    let mut fixture = Fixture::without_protected_host();
    assert_eq!(fixture.rpc(json!({"op": "version"}))["host_guard_ready"], false);

    let fresh_path = write_task_and_source(&fixture.root, "unready-fresh");
    let fresh = fixture.spawn_response("unready-fresh", "omp", "research-questions");
    assert!(fresh.contains("OMP host protection is unavailable"), "fresh OMP response: {fresh}");
    let fresh_meta: SessionMeta = serde_json::from_slice(&fs::read(fresh_path).unwrap()).unwrap();
    assert!(fresh_meta.started_at.is_none());
    assert_eq!(fixture.rpc(json!({"op": "status", "id": "unready-fresh"}))["error"], "unknown-session");

    let resume_path = write_stale_omp_meta(&fixture.root, "unready-resume");
    let mut resume_meta: SessionMeta = serde_json::from_slice(&fs::read(&resume_path).unwrap()).unwrap();
    resume_meta.harness_resume_token = "resume-token".into();
    fs::write(&resume_path, serde_json::to_vec(&resume_meta).unwrap()).unwrap();
    let resumed = fixture.open_response("resume", "unready-resume", "task", "omp", "", Some("resume-token"));
    assert!(resumed.contains("OMP host protection is unavailable"), "resumed OMP response: {resumed}");
    assert_eq!(fixture.rpc(json!({"op": "status", "id": "unready-resume"}))["error"], "unknown-session");

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
    write_unsupported_meta(&fixture.root, "unready-unsupported");
    fixture.spawn_session("unready-unsupported", "omp", "");
    assert_eq!(fixture.rpc(json!({"op": "status", "id": "unready-unsupported"}))["adapter"], "unsupported");

    fixture.shell = Some(fixture.root.join("no-harness-shell"));
    fixture.restart();
    fs::create_dir_all(fixture.root.join(".alinery/sessions")).unwrap();
    let root_meta = SessionMeta {
        id: "unready-root".into(),
        worktree: fixture.root.to_string_lossy().into_owned(),
        harness: "no-harness".into(),
        ..Default::default()
    };
    fs::write(fixture.root.join(".alinery/sessions/unready-root.meta.json"), serde_json::to_vec(&root_meta).unwrap()).unwrap();
    let root_spawn = fixture.open_response("spawn", "unready-root", "", "no-harness", "", None);
    assert!(root_spawn.contains("\"ok\":true"), "unready root response: {root_spawn}");
}

#[test]
fn missing_protected_host_defers_auto_advanced_omp_until_ready_restart() {
    let mut fixture = Fixture::without_protected_host();
    let source_path = write_task_and_source(&fixture.root, "unready-auto-source");
    let mut source: SessionMeta = serde_json::from_slice(&fs::read(&source_path).unwrap()).unwrap();
    source.semantic = SemanticCheckpoint {
        phase_completed_at: Some(1),
        omp_session_id: Some("omp-unready".into()),
        omp_turn_id: Some(1),
    };
    fs::write(&source_path, serde_json::to_vec(&source).unwrap()).unwrap();
    fs::write(fixture.root.join(".alinery/tasks/task/artifacts/01-research-questions.md"), "complete").unwrap();

    fixture.restart();
    let target_path = fixture.root.join(".alinery/tasks/task/sessions/sadv-task-superdevelop-research.meta.json");
    thread::sleep(Duration::from_secs(1));
    assert!(!target_path.exists(), "failed exclusive claim must be released for a protected retry");
    assert!(!fs::read_to_string(&fixture.capture).is_ok_and(|capture| capture.lines().any(|line| line.starts_with("sadv-task-superdevelop-research\t"))));

    fixture.host_enabled = true;
    fixture.restart();
    wait_until(Duration::from_secs(5), || {
        fs::read(&target_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<SessionMeta>(&bytes).ok())
            .is_some_and(|target| target.started_at.is_some())
    });
    wait_until(Duration::from_secs(5), || {
        fs::read_to_string(&fixture.capture).is_ok_and(|capture| capture.lines().any(|line| line.starts_with("sadv-task-superdevelop-research\t")))
    });
}

#[test]
fn phase_less_generic_omp_spawn_keeps_seed_without_completion_contract() {
    let fixture = Fixture::new();
    overlay_omp(
        &fixture.root,
        r#"
[[harness]]
key = "omp"
name = "OMP fixture"
binary = "sh"
args = ["-c", "printf '%s\\n' '{\"type\":\"ready\"}'; cat > \"$ALINERY_REPO/stdin.$ALINERY_SESSION_ID\""]
model_arg = []
prompt_injection = "arg"
adapter = "omp"
env = { ALINERY_HOST_EXECUTABLE = "harness-override" }
"#,
    );
    let id = "generic-omp";
    let meta_path = write_generic_omp_meta(&fixture.root, id);

    let line = fixture.spawn_response(id, "omp", "");
    assert!(line.contains("\"ok\":true"), "spawn response: {line}");
    wait_until(Duration::from_secs(5), || {
        fs::read_to_string(fixture.root.join(format!("stdin.{id}"))).is_ok_and(|text| text.contains("Generic Alinery session"))
    });

    let meta: SessionMeta = serde_json::from_slice(&fs::read(meta_path).unwrap()).unwrap();
    assert!(meta.started_at.is_some());
    let status = fixture.rpc(json!({"op": "status", "id": id}));
    assert_eq!(status["process"]["state"], "alive");
    assert_eq!(status["adapter"], "omp");

    let stdin = fs::read_to_string(fixture.root.join(format!("stdin.{id}"))).unwrap();
    assert!(stdin.contains("Generic Alinery session"), "{stdin}");
    assert!(!stdin.contains("Alinery completion contract"), "{stdin}");
    assert_eq!(
        fs::read_to_string(fixture.root.join(format!("runner-events.tsv.{id}.repo"))).unwrap().trim(),
        fixture.root.to_string_lossy()
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join(format!("runner-events.tsv.{id}.app-config"))).unwrap().trim(),
        fixture.root.join(".alinery/unused-app-config.toml").to_string_lossy()
    );
}

#[test]
fn callback_emitted_during_child_startup_is_authenticated() {
    let fixture = Fixture::new();
    fs::write(format!("{}.early", fixture.capture.display()), "").unwrap();
    let meta_path = write_task_and_source(&fixture.root, "early-event");

    fixture.spawn_session("early-event", "omp", "research-questions");
    wait_until(Duration::from_secs(5), || {
        let status = fixture.rpc(json!({"op": "status", "id": "early-event"}));
        status["process"]["state"] == "alive" && status["agent"]["state"] == "busy"
    });

    let meta: SessionMeta = serde_json::from_slice(&fs::read(meta_path).unwrap()).unwrap();
    assert!(meta.started_at.is_some());
    assert_eq!(meta.status_changed_at, meta.started_at);
}

#[test]
fn status_changed_at_runner_transitions_are_normalized() {
    let fixture = Fixture::new();
    let id = "status-transitions";
    let meta_path = write_task_and_source(&fixture.root, id);
    fixture.spawn_session(id, "omp", "research-questions");
    let token = fixture.token_for(id);
    let send = |event: Value| {
        let response = fixture.rpc(json!({
            "op": "event",
            "version": 1,
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
    let id = "failed-status-stamp";
    let meta_path = write_task_and_source(&fixture.root, id);
    fixture.spawn_session(id, "omp", "research-questions");
    let token = fixture.token_for(id);
    fs::write(fixture.root.join(".alinery/tasks/task/artifacts/01-research-questions.md"), "complete").unwrap();

    let sessions_dir = meta_path.parent().unwrap();
    let original_mode = fs::metadata(sessions_dir).unwrap().permissions().mode();
    fs::set_permissions(sessions_dir, fs::Permissions::from_mode(0o555)).unwrap();
    let waiting = fixture.rpc(json!({
        "op": "event",
        "version": 1,
        "session_id": id,
        "token": token,
        "event": {"type": "waiting_for_input", "correlation_id": "ask"},
    }));
    assert!(waiting["error"]
        .as_str()
        .is_some_and(|error| error.contains("Permission denied") || error.contains("Operation not permitted")));
    let completion = fixture.rpc(json!({
        "op": "event",
        "version": 1,
        "session_id": id,
        "token": token,
        "event": {"type": "phase_completed", "omp_session_id": "omp-session"},
    }));
    fs::set_permissions(sessions_dir, fs::Permissions::from_mode(original_mode)).unwrap();
    assert!(completion["error"]
        .as_str()
        .is_some_and(|error| error.contains("Permission denied") || error.contains("Operation not permitted")));

    let status = fixture.rpc(json!({"op": "status", "id": id}));
    assert_eq!(status["agent"]["state"], "unknown");
    assert_eq!(status["playbook"]["state"], "in_progress");
    let meta: SessionMeta = serde_json::from_slice(&fs::read(meta_path).unwrap()).unwrap();
    assert!(meta.semantic.phase_completed_at.is_none());
}

#[test]
fn structured_events_require_the_live_token_and_advance_exactly_once() {
    let fixture = Fixture::new();
    let source_id = "source";
    let source_meta = write_task_and_source(&fixture.root, source_id);
    fixture.spawn_session(source_id, "omp", "research-questions");
    let token = fixture.token_for(source_id);
    assert!(!token.is_empty());
    let stale_id = "stale";
    let stale_meta = write_stale_omp_meta(&fixture.root, stale_id);
    fixture.spawn_session(stale_id, "omp", "research-questions");
    let stale_token = fixture.token_for(stale_id);
    assert_eq!(
        fixture.rpc(json!({
            "op": "event",
            "version": 1,
            "session_id": stale_id,
            "token": token,
            "event": {"type": "busy"}
        }))["error"],
        "invalid-event-token"
    );
    assert_eq!(
        fixture.rpc(json!({
            "op": "event",
            "version": 1,
            "session_id": source_id,
            "token": stale_token,
            "event": {"type": "busy"}
        }))["error"],
        "invalid-event-token"
    );
    let stale_completion = fixture.rpc(json!({
        "op": "event",
        "version": 1,
        "session_id": stale_id,
        "token": stale_token,
        "event": {
            "type": "phase_completed",
            "omp_session_id": "omp-stale"
        }
    }));
    assert_eq!(stale_completion["error"], "completion-rejected:StaleSource");
    let stale_on_disk: Value = serde_json::from_slice(&fs::read(&stale_meta).unwrap()).unwrap();
    assert!(stale_on_disk["semantic"]["phase_completed_at"].is_null());
    assert!(stale_on_disk["status_changed_at"].as_u64().is_some());
    assert_eq!(fixture.rpc(json!({"op": "status", "id": stale_id}))["playbook"]["state"], "failed");

    let status = fixture.rpc(json!({"op": "status", "id": source_id}));
    assert_eq!(status["process"]["state"], "alive");
    assert_eq!(status["agent"]["state"], "unknown");
    assert_eq!(status["playbook"]["state"], "in_progress");
    assert_eq!(status["adapter"], "omp");
    assert!(status.get("status").is_none(), "scalar status must be gone");

    let list = fixture.rpc(json!({"op": "list"}));
    let row = list["sessions"].as_array().unwrap().iter().find(|row| row["id"] == source_id).unwrap();
    assert_eq!(row["process"]["state"], "alive");
    assert_eq!(row["adapter"], "omp");

    assert_eq!(
        fixture.rpc(json!({
            "op": "event",
            "version": 2,
            "session_id": source_id,
            "token": token,
            "event": {"type": "busy"}
        }))["error"],
        "unsupported-event-version"
    );
    assert_eq!(
        fixture.rpc(json!({
            "op": "event",
            "version": 1,
            "session_id": "unknown",
            "token": token,
            "event": {"type": "busy"}
        }))["error"],
        "unknown-session"
    );
    let invalid = fixture.rpc(json!({
        "op": "event",
        "version": 1,
        "session_id": source_id,
        "token": "wrong",
        "event": {"type": "busy"}
    }));
    assert_eq!(invalid["error"], "invalid-event-token");

    let accepted = fixture.rpc(json!({
        "op": "event",
        "version": 1,
        "session_id": source_id,
        "token": token,
        "event": {"type": "busy"}
    }));
    assert_eq!(accepted["ok"], true);
    assert_eq!(fixture.rpc(json!({"op": "status", "id": source_id}))["agent"]["state"], "busy");

    fixture.rpc(json!({
        "op": "event",
        "version": 1,
        "session_id": source_id,
        "token": token,
        "event": {"type": "waiting_for_input", "correlation_id": "ask-1"}
    }));
    fixture.rpc(json!({
        "op": "event",
        "version": 1,
        "session_id": source_id,
        "token": token,
        "event": {"type": "busy", "correlation_id": "other"}
    }));
    assert_eq!(fixture.rpc(json!({"op": "status", "id": source_id}))["agent"]["state"], "waiting_for_input");
    fixture.rpc(json!({
        "op": "event",
        "version": 1,
        "session_id": source_id,
        "token": token,
        "event": {"type": "busy", "correlation_id": "ask-1"}
    }));

    // Artifact presence alone must remain inert beyond the old two-observation window.
    fs::write(fixture.root.join(".alinery/tasks/task/artifacts/01-research-questions.md"), "complete").unwrap();
    thread::sleep(Duration::from_millis(4_250));
    let before: Value = serde_json::from_slice(&fs::read(&source_meta).unwrap()).unwrap();
    assert!(before["semantic"]["phase_completed_at"].is_null());
    assert_eq!(
        fs::read_dir(fixture.root.join(".alinery/tasks/task/sessions"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().to_string_lossy().ends_with(".meta.json"))
            .count(),
        2
    );

    let completed = fixture.rpc(json!({
        "op": "event",
        "version": 1,
        "session_id": source_id,
        "token": token,
        "event": {
            "type": "phase_completed",
            "omp_session_id": "omp-session-1",
            "omp_turn_id": 7
        }
    }));
    assert_eq!(completed["ok"], true, "completion response: {completed}");

    wait_until(Duration::from_secs(5), || {
        fs::read_dir(fixture.root.join(".alinery/tasks/task/sessions"))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| entry.path().to_string_lossy().ends_with(".meta.json"))
                    .count()
                    == 3
            })
            .unwrap_or(false)
    });
    let checkpointed: Value = serde_json::from_slice(&fs::read(&source_meta).unwrap()).unwrap();
    assert!(checkpointed["semantic"]["phase_completed_at"].as_u64().is_some());
    assert_eq!(checkpointed["semantic"]["omp_session_id"], "omp-session-1");
    assert_eq!(checkpointed["semantic"]["omp_turn_id"], 7);
    assert!(checkpointed["status_changed_at"].as_u64().is_some());
    assert!(checkpointed.get("event_token").is_none());
    assert!(checkpointed.get("process_state").is_none());
    assert!(checkpointed.get("agent_state").is_none());
    assert!(checkpointed.get("playbook_state").is_none());

    let sessions = fs::read_dir(fixture.root.join(".alinery/tasks/task/sessions"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().to_string_lossy().ends_with(".meta.json"))
        .map(|entry| serde_json::from_slice::<SessionMeta>(&fs::read(entry.path()).unwrap()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(sessions.iter().filter(|meta| meta.phase == "research").count(), 1);
    let advanced = sessions.iter().find(|meta| meta.phase == "research").unwrap();
    assert_eq!(fixture.host_for(&advanced.id), fixture.host.to_string_lossy());
    wait_until(Duration::from_secs(5), || {
        fixture.rpc(json!({"op": "status", "id": source_id}))["playbook"]["state"] == "completed"
    });

    // Duplicate completion cannot stamp or create another target.
    let duplicate = fixture.rpc(json!({
        "op": "event",
        "version": 1,
        "session_id": source_id,
        "token": token,
        "event": {
            "type": "phase_completed",
            "omp_session_id": "omp-session-1",
            "omp_turn_id": 7
        }
    }));
    assert_eq!(duplicate["ok"], true);
    thread::sleep(Duration::from_millis(150));
    assert_eq!(
        fs::read_dir(fixture.root.join(".alinery/tasks/task/sessions"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().to_string_lossy().ends_with(".meta.json"))
            .count(),
        3
    );

    // Unsupported adapters launch directly, keep terminal process authority, and never
    // receive a runner token/capture entry.
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
    let unsupported_id = "unsupported";
    write_unsupported_meta(&fixture.root, unsupported_id);
    fixture.spawn_session(unsupported_id, "omp", "");
    let unsupported = fixture.rpc(json!({"op": "status", "id": unsupported_id}));
    assert_eq!(unsupported["process"]["state"], "alive");
    assert_eq!(unsupported["agent"]["state"], "unknown");
    assert_eq!(unsupported["adapter"], "unsupported");
    overlay_omp(
        &fixture.root,
        r#"
[[harness]]
key = "omp"
name = "Exiting OMP fixture"
binary = "sh"
args = ["-c", "sleep 1"]
model_arg = []
prompt_injection = "arg"
adapter = "omp"
"#,
    );
    let exited_id = "exited";
    let exited_meta = write_stale_omp_meta(&fixture.root, exited_id);
    fixture.spawn_session(exited_id, "omp", "research-questions");
    let exited_token = fixture.token_for(exited_id);
    wait_until(Duration::from_secs(5), || {
        fixture.rpc(json!({"op": "status", "id": exited_id}))["process"]["state"] == "exited"
    });
    let exited_on_disk: Value = serde_json::from_slice(&fs::read(&exited_meta).unwrap()).unwrap();
    assert!(exited_on_disk["ended_at"].as_u64().is_some());
    assert!(exited_on_disk["status_changed_at"].as_u64().unwrap() >= exited_on_disk["started_at"].as_u64().unwrap());
    assert_eq!(
        fixture.rpc(json!({
            "op": "event",
            "version": 1,
            "session_id": exited_id,
            "token": exited_token,
            "event": {"type": "busy"}
        }))["error"],
        "session-exited"
    );
    let capture = fs::read_to_string(&fixture.capture).unwrap();
    assert!(!capture.lines().any(|line| line.starts_with("unsupported\t")));
}

#[test]
fn completion_ack_precedes_slow_auto_advance() {
    let fixture = Fixture::with_slow_login_shell();
    let source_id = "slow-advance";
    let source_meta = write_task_and_source(&fixture.root, source_id);
    fixture.spawn_session(source_id, "omp", "research-questions");
    let token = fixture.token_for(source_id);
    fs::write(fixture.root.join(".alinery/tasks/task/artifacts/01-research-questions.md"), "complete").unwrap();

    let started = Instant::now();
    let response = fixture.rpc(json!({
        "op": "event",
        "version": 1,
        "session_id": source_id,
        "token": token,
        "event": {
            "type": "phase_completed",
            "omp_session_id": "omp-slow-advance",
            "omp_turn_id": 1
        }
    }));
    let elapsed = started.elapsed();

    assert_eq!(response["ok"], true, "completion response: {response}");
    assert!(elapsed < Duration::from_millis(250), "checkpoint acknowledgement exceeded runner deadline: {elapsed:?}");
    let checkpointed: SessionMeta = serde_json::from_slice(&fs::read(&source_meta).unwrap()).unwrap();
    assert!(checkpointed.semantic.phase_completed_at.is_some());

    wait_until(Duration::from_secs(5), || {
        fs::read_dir(fixture.root.join(".alinery/tasks/task/sessions"))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| entry.path().to_string_lossy().ends_with(".meta.json"))
                    .count()
                    == 2
            })
            .unwrap_or(false)
    });
}

#[test]
fn checkpointed_completion_retries_unstarted_target_after_restart_without_duplicate() {
    let mut fixture = Fixture::new();
    let source_meta = write_task_and_source(&fixture.root, "checkpointed");
    let mut source: SessionMeta = serde_json::from_slice(&fs::read(&source_meta).unwrap()).unwrap();
    source.semantic = SemanticCheckpoint {
        phase_completed_at: Some(1),
        omp_session_id: Some("omp-checkpointed".into()),
        omp_turn_id: Some(9),
    };
    fs::write(&source_meta, serde_json::to_vec(&source).unwrap()).unwrap();
    fs::write(fixture.root.join(".alinery/tasks/task/artifacts/01-research-questions.md"), "complete").unwrap();

    // Simulate the durable point between exclusive target-meta creation and a
    // failed child spawn. Reconciliation must launch this row, not create another.
    let target_id = "sadv-task-superdevelop-research";
    let target_meta = fixture.root.join(format!(".alinery/tasks/task/sessions/{target_id}.meta.json"));
    let target = SessionMeta {
        id: target_id.into(),
        worktree: source.worktree.clone(),
        created: source.created + 1,
        phase: "research".into(),
        harness: "omp".into(),
        playbook: "superdevelop".into(),
        ..Default::default()
    };
    fs::write(&target_meta, serde_json::to_vec(&target).unwrap()).unwrap();

    fixture.restart();
    wait_until(Duration::from_secs(5), || {
        let started = serde_json::from_slice::<SessionMeta>(&fs::read(&target_meta).unwrap()).unwrap().started_at.is_some();
        let captured = fs::read_to_string(&fixture.capture).is_ok_and(|text| text.lines().any(|line| line.starts_with(&format!("{target_id}\t"))));
        started && captured
    });

    let sessions_dir = fixture.root.join(".alinery/tasks/task/sessions");
    let phases = fs::read_dir(&sessions_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().to_string_lossy().ends_with(".meta.json"))
        .map(|entry| serde_json::from_slice::<SessionMeta>(&fs::read(entry.path()).unwrap()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(phases.iter().filter(|meta| meta.phase == "research").count(), 1);
    assert_eq!(
        fs::read_to_string(&fixture.capture)
            .unwrap()
            .lines()
            .filter(|line| line.starts_with(&format!("{target_id}\t")))
            .count(),
        1
    );

    fixture.restart();
    thread::sleep(Duration::from_millis(250));
    assert_eq!(
        fs::read_dir(&sessions_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().to_string_lossy().ends_with(".meta.json"))
            .count(),
        2
    );
    assert_eq!(
        fs::read_to_string(&fixture.capture)
            .unwrap()
            .lines()
            .filter(|line| line.starts_with(&format!("{target_id}\t")))
            .count(),
        1
    );
}

#[test]
fn missing_runner_blocks_only_omp_adapted_spawn() {
    let fixture = Fixture::new();
    write_task_and_source(&fixture.root, "missing-runner");
    fs::remove_file(&fixture.runner).unwrap();

    let rejected = fixture.spawn_response("missing-runner", "omp", "research-questions");
    assert!(rejected.contains("alinery-runner not found"), "OMP spawn response: {rejected}");
    let source: SessionMeta = serde_json::from_slice(&fs::read(fixture.root.join(".alinery/tasks/task/sessions/missing-runner.meta.json")).unwrap()).unwrap();
    assert!(source.started_at.is_none());

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
    write_unsupported_meta(&fixture.root, "broken");
    let broken_meta_path = fixture.root.join(".alinery/tasks/task/sessions/broken.meta.json");
    let broken = fixture.spawn_response("broken", "omp", "");
    assert!(broken.contains("No such file"), "broken spawn response: {broken}");
    assert_eq!(fixture.rpc(json!({"op": "status", "id": "broken"}))["error"], "unknown-session");
    let rolled_back: SessionMeta = serde_json::from_slice(&fs::read(&broken_meta_path).unwrap()).unwrap();
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
    write_unsupported_meta(&fixture.root, "direct");
    fixture.spawn_session("direct", "omp", "");
    let direct = fixture.rpc(json!({"op": "status", "id": "direct"}));
    assert_eq!(direct["process"]["state"], "alive");
    assert_eq!(direct["adapter"], "unsupported");
}

#[test]
fn oversized_runner_event_is_rejected_before_state_mutation() {
    let fixture = Fixture::new();
    write_task_and_source(&fixture.root, "oversized-event");
    fixture.spawn_session("oversized-event", "omp", "research-questions");
    let token = fixture.token_for("oversized-event");

    let response = fixture.rpc(json!({
        "op": "event",
        "version": 1,
        "session_id": "oversized-event",
        "token": token,
        "event": {
            "type": "adapter_error",
            "detail": "x".repeat(130 * 1024)
        }
    }));
    assert_eq!(response["error"], "request-too-large");

    let status = fixture.rpc(json!({"op": "status", "id": "oversized-event"}));
    assert_eq!(status["agent"]["state"], "unknown");
    assert_eq!(status["playbook"]["state"], "in_progress");
}

#[test]
fn invalid_artifact_rejects_without_checkpoint_until_fixed() {
    let fixture = Fixture::new();
    let source_meta = write_task_and_source(&fixture.root, "artifact-check");
    fixture.spawn_session("artifact-check", "omp", "research-questions");
    let token = fixture.token_for("artifact-check");
    let complete = || {
        fixture.rpc(json!({
            "op": "event",
            "version": 1,
            "session_id": "artifact-check",
            "token": token,
            "event": {
                "type": "phase_completed",
                "omp_session_id": "omp-artifact-check"
            }
        }))
    };

    assert_eq!(complete()["error"], "completion-rejected:MissingArtifact");
    let checkpoint: Value = serde_json::from_slice(&fs::read(&source_meta).unwrap()).unwrap();
    assert!(checkpoint["semantic"]["phase_completed_at"].is_null());

    let artifact = fixture.root.join(".alinery/tasks/task/artifacts/01-research-questions.md");
    fs::write(&artifact, "").unwrap();
    assert_eq!(complete()["error"], "completion-rejected:EmptyArtifact");
    let checkpoint: Value = serde_json::from_slice(&fs::read(&source_meta).unwrap()).unwrap();
    assert!(checkpoint["semantic"]["phase_completed_at"].is_null());

    fs::write(&artifact, "complete").unwrap();
    assert_eq!(complete()["ok"], true);
    wait_until(Duration::from_secs(5), || {
        fs::read_dir(fixture.root.join(".alinery/tasks/task/sessions"))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| entry.path().to_string_lossy().ends_with(".meta.json"))
                    .count()
                    == 2
            })
            .unwrap_or(false)
    });
    let checkpoint: Value = serde_json::from_slice(&fs::read(&source_meta).unwrap()).unwrap();
    assert!(checkpoint["semantic"]["phase_completed_at"].as_u64().is_some());
}
