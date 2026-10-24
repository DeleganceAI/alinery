//! ALINERY_TEST_OMP=/absolute/omp cargo test -p alinery-core --test omp_config -- --ignored
use alinery_core::{omp_home_dirs, read_omp_compaction, OmpCompactionSnapshot};
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Fixture {
    fn app(&self) -> PathBuf {
        self.0.join("app.toml")
    }
    fn omp(&self, args: &[&str]) -> Vec<u8> {
        let (agent, config) = omp_home_dirs(&self.app());
        let mut child = Running(
            Command::new(std::env::var_os("ALINERY_TEST_OMP").unwrap())
                .env_clear()
                .env("HOME", &self.0)
                .env("PATH", "/usr/bin:/bin")
                .env("PI_CODING_AGENT_DIR", agent)
                .env("PI_CONFIG_DIR", config)
                .current_dir(&self.0)
                .args(args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut stdout = child.0.stdout.take().unwrap();
        let reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).unwrap();
            bytes
        });
        let mut stderr = child.0.stderr.take().unwrap();
        let errors = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stderr.read_to_end(&mut bytes).unwrap();
            bytes
        });
        let deadline = Instant::now() + Duration::from_secs(30);
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "packaged OMP fixture timed out");
            std::thread::sleep(Duration::from_millis(10));
        };
        let output = reader.join().unwrap();
        let errors = errors.join().unwrap();
        assert!(status.success(), "OMP failed: {}", String::from_utf8_lossy(&errors));
        output
    }
    fn compare_native_values(&self, snapshot: &OmpCompactionSnapshot) {
        for (key, field) in [
            ("enabled", &snapshot.enabled),
            ("thresholdPercent", &snapshot.threshold_percent),
            ("thresholdTokens", &snapshot.threshold_tokens),
            ("midTurnEnabled", &snapshot.mid_turn_enabled),
            ("asyncEnabled", &snapshot.async_enabled),
        ] {
            let output = self.omp(&["config", "get", &format!("compaction.{key}"), "--json"]);
            let native: Value = serde_json::from_slice(&output).unwrap();
            assert_eq!(field.value.as_ref(), Some(&native["value"]), "{key}");
        }
    }
}

#[test]
#[ignore = "requires explicitly supplied actual packaged OMP 18.1.13 executable"]
fn packaged_omp_values_match_read_only_snapshot() {
    let binary = std::env::var_os("ALINERY_TEST_OMP").expect("set ALINERY_TEST_OMP to the packaged executable");
    std::env::set_var("ALINERY_OMP_PATH", binary);
    let f = Fixture(std::env::temp_dir().join(format!("alinery-omp-reader-{}", uuid::Uuid::new_v4())));
    fs::create_dir_all(&f.0).unwrap();
    let (agent, _) = omp_home_dirs(&f.app());
    let fresh = read_omp_compaction(&f.app()).unwrap();
    assert_eq!(fresh.installed_version.as_deref(), Some("18.1.13"));
    assert_eq!(fresh.status, "ready");
    assert_eq!(fresh.enabled.value, Some(json!(true)));
    assert_eq!(fresh.threshold_percent.value, Some(json!(-1)));
    assert!(!agent.exists(), "reading must not initialize configuration");

    // Native initialization is fixture setup, never part of the reader.
    f.omp(&["config", "path"]);
    let before = fs::read(agent.join("agent.db")).unwrap();
    let defaults = read_omp_compaction(&f.app()).unwrap();
    assert_eq!(defaults.enabled.source, "upstream_default");
    assert!(fs::read(agent.join("agent.db")).unwrap() == before);
    assert!(!agent.join("config.yml").exists());
    f.compare_native_values(&defaults);

    let explicit = "compaction: {enabled: false, thresholdPercent: 65, thresholdTokens: 10000, midTurnEnabled: false, asyncEnabled: true}\ndefaultThinkingLevel: high\n";
    fs::write(agent.join("config.yaml"), explicit).unwrap();
    let snapshot = read_omp_compaction(&f.app()).unwrap();
    assert_eq!(snapshot.enabled.value, Some(json!(false)));
    assert_eq!(snapshot.threshold_percent.value, Some(json!(65)));
    assert_eq!(snapshot.enabled.source, "configured");
    assert_eq!(fs::read_to_string(agent.join("config.yaml")).unwrap(), explicit);
    assert!(!agent.join("config.yml").exists());
    f.compare_native_values(&snapshot);
    assert_eq!(fs::read_to_string(agent.join("config.yaml")).unwrap(), explicit);
}
