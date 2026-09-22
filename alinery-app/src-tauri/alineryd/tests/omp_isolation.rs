//! Fail-closed packaged OMP resolve + isolation env. Copies the small Fixture /
//! overlay helpers from daemon_lifecycle.rs / semantic_events.rs (integration
//! crates cannot import each other).

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use alinery_core::SessionMeta;
use serde_json::{json, Value};

static ROOT_COUNTER: AtomicU64 = AtomicU64::new(0);

const PLAYBOOK: &str = r#"+++
version = 2
key = "isolation"
title = "Isolation fixture"
description = ""
default_model = ""
default_harness = "omp"
[[step]]
key = "run"
title = "Run"
short = ""
is_coding_step = false
auto_advance_default = false
inputs = [{path = "ticket.md", mode = "single"}]
outputs = [{path = "result.md"}]
model = ""
harness = "omp"
+++
<!-- alinery:step run -->
Read {{TICKET_FILE}} and produce the assigned result.
"#;

fn unique_root() -> PathBuf {
    let counter = ROOT_COUNTER.fetch_add(1, Ordering::Relaxed);
    PathBuf::from(format!("/tmp/sgomp-{}-{counter}", std::process::id()))
}

struct Fixture {
    root: PathBuf,
    socket: PathBuf,
    child: Child,
}

fn start_daemon(root: &Path, runner: &Path, capture: &Path, extra_env: &[(&str, String)]) -> (Child, PathBuf) {
    let socket = root.join(".alinery/alineryd.sock");
    let mut command = Command::new(env!("CARGO_BIN_EXE_alineryd"));
    command
        .arg("--repo")
        .arg(root)
        .arg("--build-id")
        .arg("omp-isolation-test")
        .arg("--app-config")
        .arg(root.join(".alinery/unused-app-config.toml"))
        .env_remove("ALINERY_HOST_EXECUTABLE")
        .env_remove("PI_CODING_AGENT_DIR")
        .env_remove("PI_CONFIG_DIR")
        .env("ALINERY_RUNNER_PATH", runner)
        .env("ALINERY_RUNNER_CAPTURE", capture)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    for (key, value) in extra_env {
        if key == &"ALINERY_OMP_PATH" && value.is_empty() {
            command.env_remove("ALINERY_OMP_PATH");
        } else {
            command.env(key, value);
        }
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
    panic!("alineryd did not become ready at {}", root.display());
}

fn write_executable(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
}

impl Fixture {
    fn with_env(extra_env: &[(&str, String)]) -> Self {
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

        let capture = root.join("runner-events.tsv");
        let runner = root.join("fake-alinery-runner");
        write_executable(
            &runner,
            &format!(
                "#!/bin/sh\nprintf '%s\\t%s\\n' \"$ALINERY_SESSION_ID\" \"$ALINERY_EVENT_TOKEN\" >> \"{}\"\nshift 4\nexec \"$@\"\n",
                capture.display()
            ),
        );

        overlay_omp(
            &root,
            r#"
[[harness]]
key = "omp"
name = "OMP fixture"
binary = "sh"
args = ["-c", "sleep 30"]
model_arg = []
prompt_injection = "arg"
adapter = "omp"
"#,
        );

        let mut env = vec![("ALINERY_HOST_EXECUTABLE".to_string(), host.to_string_lossy().into_owned())];
        for (k, v) in extra_env {
            env.push((k.to_string(), v.clone()));
        }
        let env_refs: Vec<(&str, String)> = env.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
        let (child, socket) = start_daemon(&root, &runner, &capture, &env_refs);
        Self { root, socket, child }
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
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        writeln!(stream, "{request}").unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    fn create_session(&self, harness: &str) -> String {
        let created = self.rpc(json!({"op": "create_task", "request": {
            "name": "task", "requested_slug": "task",
            "playbook": {"reference": {"scope": "repo", "key": "isolation"}, "source": PLAYBOOK},
            "start": false
        }}));
        assert_eq!(created["creation"], "ready", "{created}");
        assert_eq!(created["errors"], json!([]), "{created}");
        if harness == "omp" {
            created["sessions"][0]["id"].as_str().expect("reserved owner").into()
        } else {
            let auxiliary = self.rpc(json!({"op": "create_execution_session", "request": {
                "task_slug": "task", "target": {"kind": "auxiliary", "harness": harness}, "start": false
            }}));
            assert_eq!(auxiliary["errors"], json!([]), "{auxiliary}");
            auxiliary["session"]["id"].as_str().expect("auxiliary session").into()
        }
    }

    fn spawn_response(&self, id: &str) -> Value {
        self.rpc(json!({"op": "start_session", "request": {"task_slug": "task", "session_id": id}}))
    }

    fn request_shutdown(&self) {
        if let Ok(mut stream) = UnixStream::connect(&self.socket) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = writeln!(stream, "{}", json!({"op": "shutdown"}));
            let mut line = String::new();
            let _ = BufReader::new(stream).read_line(&mut line);
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.request_shutdown();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn overlay_omp(root: &Path, contents: &str) {
    fs::write(root.join(".alinery/harnesses.toml"), contents).unwrap();
}

fn wait_file(path: &Path, timeout: Duration) -> String {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if path.is_file() {
            return fs::read_to_string(path).unwrap();
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!("{} did not appear within {timeout:?}", path.display());
}

#[test]
fn missing_packaged_omp_does_not_exec_path_omp() {
    let root = unique_root();
    fs::create_dir_all(&root).unwrap();
    let sentinel = root.join("decoy-ran");
    let decoy_dir = root.join("decoy-bin");
    fs::create_dir_all(&decoy_dir).unwrap();
    write_executable(&decoy_dir.join("omp"), &format!("#!/bin/sh\necho ran > '{}'\n", sentinel.display()));
    let missing = root.join("no-such-packaged-omp");
    let login_path = format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", decoy_dir.display());
    let shell = root.join("login-shell");
    write_executable(
        &shell,
        &format!("#!/bin/sh\nif [ \"$1\" = \"-ilc\" ]; then printf '%s\\n' '{login_path}'; exit 0; fi\nexec /bin/sh \"$@\"\n"),
    );

    let fixture = Fixture::with_env(&[
        ("ALINERY_OMP_PATH", missing.to_string_lossy().into_owned()),
        ("PATH", format!("{}:{}", decoy_dir.display(), std::env::var("PATH").unwrap_or_default())),
        ("SHELL", shell.to_string_lossy().into_owned()),
    ]);
    overlay_omp(
        &fixture.root,
        r#"
[[harness]]
key = "omp"
name = "OMP sentinel"
binary = "omp"
args = []
model_arg = []
prompt_injection = "arg"
adapter = "omp"
"#,
    );
    let id = fixture.create_session("omp");
    let rejected = fixture.spawn_response(&id);
    assert_eq!(rejected["start"], "failed", "{rejected}");
    assert!(
        rejected["errors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|error| error["message"].as_str().is_some_and(|message| message.contains("bundled OMP not found"))),
        "{rejected}"
    );
    assert!(!sentinel.exists(), "PATH decoy named omp must not run");
    let meta: SessionMeta = serde_json::from_slice(&fs::read(fixture.root.join(format!(".alinery/tasks/task/sessions/{id}.meta.json"))).unwrap()).unwrap();
    assert!(meta.started_at.is_none());
    let query = fixture.rpc(json!({"op": "get_task_execution", "request": {"task_slug": "task"}}));
    assert_eq!(query["state"]["executions"][&meta.execution_id]["lifecycle"], "launch_failed", "{query}");
}

#[test]
fn no_harness_still_starts_when_omp_missing() {
    let missing = format!("/no/such/alinery-omp-{}", std::process::id());
    let fixture = Fixture::with_env(&[("ALINERY_OMP_PATH", missing)]);
    let id = fixture.create_session("no-harness");
    let reply = fixture.spawn_response(&id);
    assert_eq!(reply["start"], "started", "{reply}");
    let status = fixture.rpc(json!({"op": "status", "id": id}));
    assert_eq!(status["process"]["state"], "alive");
}

#[test]
fn overlay_binary_sh_still_honored() {
    let missing = format!("/no/such/alinery-omp-{}", std::process::id());
    let fixture = Fixture::with_env(&[("ALINERY_OMP_PATH", missing)]);
    let id = fixture.create_session("omp");
    let reply = fixture.spawn_response(&id);
    assert_eq!(reply["start"], "started", "{reply}");
    let status = fixture.rpc(json!({"op": "status", "id": id}));
    assert_eq!(status["process"]["state"], "alive");
}

#[test]
fn omp_spawn_sets_isolation_env_and_skips_home_omp() {
    let home = unique_root().join("fake-home");
    fs::create_dir_all(&home).unwrap();
    // The daemon is started holding a provider key, the way a daemon launched from a shell that
    // exports one would be. It must not reach the child: an instance whose credential store is
    // empty has to *behave* empty, or "a fresh install starts un-authenticated" is not true.
    let fixture = Fixture::with_env(&[("HOME", home.to_string_lossy().into_owned()), ("ANTHROPIC_API_KEY", "leaked-parent-key".to_string())]);
    let agent_dump = fixture.root.join("pi-agent");
    let config_dump = fixture.root.join("pi-config");
    let skip_dump = fixture.root.join("omp-skip");
    let home_omp_dump = fixture.root.join("home-omp");
    let leak_dump = fixture.root.join("leaked-key");
    overlay_omp(
        &fixture.root,
        &format!(
            r#"
[[harness]]
key = "omp"
name = "OMP fixture"
binary = "sh"
args = ["-c", "printf '%s' \"$PI_CODING_AGENT_DIR\" > '{agent}'; printf '%s' \"$PI_CONFIG_DIR\" > '{config}'; printf '%s' \"$OMP_SKIP_SETUP\" > '{skip}'; printf '[%s]' \"$ANTHROPIC_API_KEY\" > '{leak}'; if [ -d \"$HOME/.omp\" ]; then echo yes; else echo no; fi > '{home_omp}'; sleep 30"]
model_arg = []
prompt_injection = "arg"
adapter = "omp"
"#,
            agent = agent_dump.display(),
            config = config_dump.display(),
            skip = skip_dump.display(),
            leak = leak_dump.display(),
            home_omp = home_omp_dump.display(),
        ),
    );
    let id = fixture.create_session("omp");
    let reply = fixture.spawn_response(&id);
    assert_eq!(reply["start"], "started", "{reply}");

    let agent = wait_file(&agent_dump, Duration::from_secs(5));
    let config = wait_file(&config_dump, Duration::from_secs(5));
    let skip = wait_file(&skip_dump, Duration::from_secs(5));
    let leak = wait_file(&leak_dump, Duration::from_secs(5));
    let home_omp = wait_file(&home_omp_dump, Duration::from_secs(5));
    let app_config = fixture.root.join(".alinery/unused-app-config.toml");
    let (want_agent, want_config) = alinery_core::omp_home_dirs(&app_config);
    assert_eq!(agent, want_agent.to_string_lossy());
    assert_eq!(config, want_config.to_string_lossy());
    assert_eq!(skip.trim(), "1");
    assert!(config.ends_with("/omp/config"), "{config}");
    assert!(agent.ends_with("/omp/config/agent"), "{agent}");
    assert_eq!(home_omp.trim(), "no");
    assert!(!home.join(".omp").exists());
    // Bracketed so a read that lands between the shell truncating the file and printf writing it
    // fails loudly instead of passing as an empty string.
    assert_eq!(leak, "[]", "provider key from the daemon's environment reached the OMP child");
}

#[test]
fn omp_env_allowlist_carries_no_credentials() {
    // The allowlist is what survives `env_clear`, so a careless addition here is how a leak comes
    // back. Nothing on it may look like a credential, and PATH/TERM are set explicitly at spawn.
    for key in alinery_core::OMP_ENV_ALLOWLIST {
        let upper = key.to_uppercase();
        assert!(
            !upper.contains("KEY") && !upper.contains("TOKEN") && !upper.contains("SECRET") && !upper.contains("PASSWORD"),
            "allowlisted {key} looks like a credential"
        );
        assert!(*key != "PATH" && *key != "TERM", "{key} is set explicitly at spawn, not inherited");
    }
    assert!(alinery_core::OMP_ENV_ALLOWLIST.contains(&"HOME"), "OMP needs HOME for its caches");
}

#[test]
fn no_harness_does_not_set_pi_env() {
    let shell_dir = unique_root();
    fs::create_dir_all(&shell_dir).unwrap();
    let shell = shell_dir.join("dump-shell");
    let agent_dump = shell_dir.join("nh-agent");
    let config_dump = shell_dir.join("nh-config");
    write_executable(
        &shell,
        &format!(
            "#!/bin/sh\nif [ \"$1\" = \"-ilc\" ]; then printf '/usr/bin:/bin:/usr/sbin:/sbin\\n'; exit 0; fi\nprintf '%s' \"${{PI_CODING_AGENT_DIR-}}\" > '{}'\nprintf '%s' \"${{PI_CONFIG_DIR-}}\" > '{}'\nsleep 30\n",
            agent_dump.display(),
            config_dump.display(),
        ),
    );
    let fixture = Fixture::with_env(&[("SHELL", shell.to_string_lossy().into_owned())]);
    let id = fixture.create_session("no-harness");
    let reply = fixture.spawn_response(&id);
    assert_eq!(reply["start"], "started", "{reply}");
    let agent = wait_file(&agent_dump, Duration::from_secs(5));
    let config = wait_file(&config_dump, Duration::from_secs(5));
    assert!(agent.is_empty(), "PI_CODING_AGENT_DIR={agent}");
    assert!(config.is_empty(), "PI_CONFIG_DIR={config}");
}
