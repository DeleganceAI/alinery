//! Actual packaged-runtime checks are opt-in, never substituted with an echoing CLI.
//! ALINERY_TEST_OMP=/absolute/verified/omp cargo test -p alinery-runner --test omp_config -- --ignored --nocapture
use alinery_core::{omp_home_dirs, read_omp_compaction, set_omp_auto_compaction, set_omp_model_roles, RUNNER_EVENT_PROTOCOL_VERSION};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

struct Fixture {
    root: tempfile::TempDir,
    binary: PathBuf,
}
impl Fixture {
    fn new(binary: &Path) -> Self {
        Self {
            root: tempfile::tempdir().unwrap(),
            binary: binary.into(),
        }
    }
    fn app(&self) -> PathBuf {
        self.root.path().join("app.toml")
    }
    fn agent(&self) -> PathBuf {
        let path = omp_home_dirs(&self.app()).0;
        fs::create_dir_all(&path).unwrap();
        path
    }
    fn runner(&self, repo: &str) -> Command {
        let cwd = self.root.path().join(repo);
        fs::create_dir_all(&cwd).unwrap();
        let (agent, config) = omp_home_dirs(&self.app());
        let mut command = Command::new(env!("CARGO_BIN_EXE_alinery-runner"));
        command
            .env_clear()
            .current_dir(&cwd)
            .env("HOME", self.root.path())
            .env("PATH", "/usr/bin:/bin")
            .env("PI_CODING_AGENT_DIR", agent)
            .env("PI_CONFIG_DIR", config)
            .env("PI_SKIP_VERSION_CHECK", "1")
            .env("ALINERY_OMP_PATH", &self.binary)
            .env("ALINERY_RUNNER_PATH", env!("CARGO_BIN_EXE_alinery-runner"))
            .env("ALINERY_SESSION_ID", "compaction-fixture")
            .env("ALINERY_DAEMON_SOCKET", self.root.path().join("daemon.sock"))
            .env("ALINERY_DAEMON_NAMESPACE", "compaction-fixture")
            .env("ALINERY_EVENT_PROTOCOL_VERSION", RUNNER_EVENT_PROTOCOL_VERSION.to_string())
            .env("ALINERY_EVENT_TOKEN", "compaction-fixture")
            .env("ALINERY_REPO", cwd)
            .env("ALINERY_APP_CONFIG", self.app())
            .args(["run", "--adapter", "omp", "--"])
            .arg(&self.binary);
        command
    }
    fn get(&self, key: &str) -> Value {
        let mut command = self.runner("repo-a");
        command.args(["config", "get", key, "--json"]).stdout(Stdio::piped()).stderr(Stdio::piped());
        let output = bounded_output(command);
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["value"].clone()
    }
    fn rpc(&self, repo: &str) -> Running {
        let mut command = self.runner(repo);
        // Startup only: no prompt is sent and no remote provider call is made.
        command
            .env("OPENAI_API_KEY", "fixture-not-real")
            .args(["--mode", "rpc", "--no-session", "--provider", "openai", "--model", "gpt-4o"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut running = Running(command.spawn().unwrap());
        let stdout = running.0.stdout.take().unwrap();
        let stderr = running.0.stderr.take().unwrap();
        let (errors_send, errors_recv) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut error = String::new();
            let _ = stderr.take(65536).read_to_string(&mut error);
            let _ = errors_send.send(error);
        });
        let (send, recv) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if serde_json::from_str::<Value>(&line).ok().is_some_and(|v| v["type"] == "ready") {
                    let _ = send.send(());
                }
            }
        });
        if recv.recv_timeout(Duration::from_secs(20)).is_err() {
            let _ = running.0.kill();
            let _ = running.0.wait();
            let stderr = errors_recv.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
            panic!("actual OMP RPC was not ready; stderr={stderr}; snapshot={:?}", read_omp_compaction(&self.app()));
        }
        running
    }
}
struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn bounded_output(mut command: Command) -> Output {
    let mut child = Running(command.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(30);
    while child.0.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "OMP configuration fixture timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(mut pipe) = child.0.stdout.take() {
        pipe.read_to_end(&mut stdout).unwrap();
    }
    if let Some(mut pipe) = child.0.stderr.take() {
        pipe.read_to_end(&mut stderr).unwrap();
    }
    Output {
        status: child.0.wait().unwrap(),
        stdout,
        stderr,
    }
}
struct BinaryEnv(Option<std::ffi::OsString>);
impl Drop for BinaryEnv {
    fn drop(&mut self) {
        match self.0.take() {
            Some(value) => std::env::set_var("ALINERY_OMP_PATH", value),
            None => std::env::remove_var("ALINERY_OMP_PATH"),
        }
    }
}

#[test]
#[ignore = "requires explicitly supplied, version-verified actual OMP 18.1.13 executable"]
fn omp_config_real_binary_persistence_and_exclusion() {
    let binary = PathBuf::from(std::env::var_os("ALINERY_TEST_OMP").expect("set ALINERY_TEST_OMP to the actual pinned OMP executable"));
    let _env = BinaryEnv(std::env::var_os("ALINERY_OMP_PATH"));
    std::env::set_var("ALINERY_OMP_PATH", &binary);
    let unconfigured = Fixture::new(&binary);
    let (agent, config) = omp_home_dirs(&unconfigured.app());
    let mut init = Command::new(&binary);
    init.env_clear()
        .current_dir(unconfigured.root.path())
        .env("HOME", unconfigured.root.path())
        .env("PATH", "/usr/bin:/bin")
        .env("PI_CODING_AGENT_DIR", &agent)
        .env("PI_CONFIG_DIR", config)
        .args(["config", "path"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    assert!(bounded_output(init).status.success());
    assert!(agent.join("agent.db").exists());
    assert!(!agent.join("config.yml").exists());
    let before = fs::read(agent.join("agent.db")).unwrap();
    let defaults = read_omp_compaction(&unconfigured.app()).unwrap();
    assert_eq!(defaults.enabled.value, Some(json!(true)));
    assert_eq!(defaults.threshold_percent.value, Some(json!(-1)));
    assert_eq!(defaults.threshold_tokens.value, Some(json!(-1)));
    assert_eq!(defaults.mid_turn_enabled.value, Some(json!(true)));
    assert_eq!(defaults.async_enabled.value, Some(json!(true)));
    assert_eq!(defaults.enabled.source, "upstream_default");
    assert_eq!(fs::read(agent.join("agent.db")).unwrap(), before);
    assert!(!agent.join("config.yml").exists());
    assert_eq!(unconfigured.get("compaction.thresholdPercent"), defaults.threshold_percent.value.unwrap());

    let f = Fixture::new(&binary);
    let fresh = read_omp_compaction(&f.app()).unwrap();
    assert_eq!(fresh.installed_version.as_deref(), Some("18.1.13"));
    assert!(fresh.write_allowed, "fresh installation deferred: {fresh:?}");
    assert_eq!(f.get("compaction.thresholdPercent"), json!(40), "snapshot={:?}", read_omp_compaction(&f.app()));
    for key in ["enabled", "midTurnEnabled", "asyncEnabled"] {
        assert_eq!(f.get(&format!("compaction.{key}")), json!(true));
    }
    assert_eq!(f.get("compaction.thresholdTokens"), json!(-1));
    let seeded = fs::read(f.agent().join("config.yml")).unwrap();
    assert!(!String::from_utf8_lossy(&seeded).contains("thresholdTokens"));
    assert_eq!(f.get("compaction.thresholdPercent"), json!(40));
    assert_eq!(fs::read(f.agent().join("config.yml")).unwrap(), seeded);

    let first = f.rpc("repo-a");
    let second = f.rpc("repo-b");
    let active = read_omp_compaction(&f.app()).unwrap();
    assert!(!active.write_allowed, "{active:?}");
    assert!(set_omp_auto_compaction(&f.app(), false, &active.revision).is_err());
    assert!(set_omp_model_roles(&f.app(), &HashMap::from([("default".into(), "fixture/model".into())]), false).is_err());
    let independent = Fixture::new(&binary);
    assert!(read_omp_compaction(&independent.app()).unwrap().write_allowed);
    drop(first);
    assert!(!read_omp_compaction(&f.app()).unwrap().write_allowed);
    drop(second);
    let idle = read_omp_compaction(&f.app()).unwrap();
    assert!(idle.write_allowed, "{idle:?}");
    let changed = set_omp_auto_compaction(&f.app(), false, &idle.revision).unwrap();
    assert_eq!(changed.enabled.value, Some(json!(false)));
    assert_eq!(f.get("compaction.enabled"), json!(false));
    assert!(set_omp_auto_compaction(&f.app(), true, &idle.revision).is_err());

    let explicit = Fixture::new(&binary);
    fs::write(explicit.agent().join("config.yaml"), "compaction: {enabled: false, thresholdPercent: 65, thresholdTokens: 10000, midTurnEnabled: false, asyncEnabled: false}\ndefaultThinkingLevel: high\nmodelRoles: {default: 'fixture/original'}\n").unwrap();
    let credentials = b"{\"fixture-secret\":\"never-rewrite\"}";
    fs::write(explicit.agent().join("auth.json"), credentials).unwrap();
    assert_eq!(explicit.get("compaction.thresholdPercent"), json!(65));
    let state = read_omp_compaction(&explicit.app()).unwrap();
    set_omp_auto_compaction(&explicit.app(), true, &state.revision).unwrap();
    assert_eq!(explicit.get("compaction.thresholdTokens"), json!(10000));
    assert_eq!(explicit.get("compaction.midTurnEnabled"), json!(false));
    assert_eq!(explicit.get("compaction.asyncEnabled"), json!(false));
    assert_eq!(explicit.get("defaultThinkingLevel"), json!("high"));
    assert_eq!(fs::read(explicit.agent().join("auth.json")).unwrap(), credentials);
    assert!(!explicit.agent().join("config.yml").exists());
    let keep = set_omp_model_roles(&explicit.app(), &HashMap::from([("default".into(), "fixture/replacement".into())]), true).unwrap();
    assert_eq!(keep.get("default").map(String::as_str), Some("fixture/original"));
    set_omp_model_roles(&explicit.app(), &HashMap::from([("default".into(), "fixture/replacement".into())]), false).unwrap();
    assert_eq!(explicit.get("modelRoles"), json!({"default":"fixture/replacement"}));
    assert_eq!(explicit.get("compaction.thresholdPercent"), json!(65));

    let legacy = Fixture::new(&binary);
    fs::write(
        legacy.agent().join("settings.json"),
        "{/* old settings */\"compaction\":{\"enabled\":false,\"thresholdPercent\":65},\"defaultThinkingLevel\":\"high\",\"modelRoles\":{\"default\":\"fixture/legacy\"}}",
    )
    .unwrap();
    assert_eq!(read_omp_compaction(&legacy.app()).unwrap().status, "legacy_unresolved");
    assert!(!legacy.agent().join("config.yml").exists());
    assert_eq!(legacy.get("compaction.enabled"), json!(false));
    assert_eq!(legacy.get("compaction.thresholdPercent"), json!(65));
    assert_eq!(legacy.get("compaction.midTurnEnabled"), json!(true));
    assert_eq!(legacy.get("defaultThinkingLevel"), json!("high"));
    assert_eq!(legacy.get("modelRoles"), json!({"default":"fixture/legacy"}));

    let corrupt = Fixture::new(&binary);
    let malformed = "{ definitely invalid JSONC";
    fs::write(corrupt.agent().join("settings.json"), malformed).unwrap();
    // OMP itself silently ignores this malformed legacy file. Alinery must not
    // mistake successful native initialization for evidence that it was empty.
    assert_eq!(corrupt.get("compaction.thresholdPercent"), json!(-1));
    assert!(!corrupt.agent().join("config.yml").exists());
    assert_eq!(fs::read_to_string(corrupt.agent().join("settings.json")).unwrap(), malformed);
    let unresolved = read_omp_compaction(&corrupt.app()).unwrap();
    assert_eq!(unresolved.status, "legacy_unresolved");
    assert!(set_omp_auto_compaction(&corrupt.app(), true, &unresolved.revision).is_err());
    assert!(set_omp_model_roles(&corrupt.app(), &HashMap::from([("default".into(), "fixture/model".into())]), false).is_err());
    assert!(!corrupt.agent().join("config.yml").exists());
}
