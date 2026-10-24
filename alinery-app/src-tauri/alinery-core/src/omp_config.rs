//! Read-only installation-global OMP compaction settings.
use serde::Serialize;
use serde_json::Value as Json;
use serde_yaml_ng::{Mapping, Value};
use std::fs;
use std::io::Read;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const SUPPORTED: &str = "18.1.13";
const MAX_CONFIG: u64 = 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
pub struct OmpCompactionField {
    pub value: Option<Json>,
    pub source: &'static str,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct OmpCompactionSnapshot {
    pub binary_path: Option<String>,
    pub installed_version: Option<String>,
    pub config_path: Option<String>,
    pub status: &'static str,
    pub enabled: OmpCompactionField,
    pub threshold_percent: OmpCompactionField,
    pub threshold_tokens: OmpCompactionField,
    pub mid_turn_enabled: OmpCompactionField,
    pub async_enabled: OmpCompactionField,
    pub errors: Vec<String>,
}

#[derive(Debug)]
struct Document {
    path: Option<PathBuf>,
    mapping: Mapping,
    legacy: bool,
}

fn document(agent: &Path) -> Result<Document, (&'static str, String)> {
    let mut selected = None;
    let mut selected_bytes = None;
    let mut legacy = false;
    for name in ["config.yml", "config.yaml", "settings.json", "agent.db"] {
        // OMP selects the first YAML file; lower-priority candidates are ignored.
        if selected.is_some() {
            break;
        }
        let path = agent.join(name);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(("unreadable", "Cannot inspect OMP configuration".into())),
            Ok(_) => {
                if name.starts_with("config.") {
                    let meta = fs::metadata(&path).map_err(|_| ("unreadable", "Cannot inspect OMP configuration".into()))?;
                    if !meta.is_file() || meta.len() > MAX_CONFIG {
                        return Err(("invalid", "OMP configuration is not a bounded regular file".into()));
                    }
                    let mut bytes = Vec::new();
                    fs::File::open(&path)
                        .and_then(|file| file.take(MAX_CONFIG + 1).read_to_end(&mut bytes))
                        .map_err(|_| ("unreadable", "Cannot read OMP configuration".into()))?;
                    if bytes.len() as u64 > MAX_CONFIG {
                        return Err(("invalid", "OMP configuration exceeds the read limit".into()));
                    }
                    selected = Some(path);
                    selected_bytes = Some(bytes);
                } else {
                    legacy = true;
                }
            }
        }
    }
    let mapping = if let Some(bytes) = selected_bytes {
        let value: Value = serde_yaml_ng::from_slice(&bytes).map_err(|_| ("invalid", "OMP configuration is not valid YAML".into()))?;
        if unsupported_yaml(&value) {
            return Err(("invalid", "OMP YAML tags or merge keys cannot be interpreted safely".into()));
        }
        match value {
            Value::Null => Mapping::new(),
            Value::Mapping(map) => map,
            _ => return Err(("invalid", "OMP configuration must be a mapping".into())),
        }
    } else {
        Mapping::new()
    };
    Ok(Document { path: selected, mapping, legacy })
}

fn database_compaction(agent: &Path) -> Result<Mapping, String> {
    use rusqlite::{Connection, OpenFlags, OptionalExtension};
    // OMP 18.1.13 stores legacy settings as top-level JSON values. Read only
    // compaction, never credentials. Normal read-only SQLite locking sees WAL
    // commits; immutable mode would silently ignore a running OMP's WAL.
    if agent.join("settings.json").try_exists().map_err(|_| "Cannot inspect legacy OMP settings")? {
        return Err("Legacy JSON settings have not been resolved".into());
    }
    let db = Connection::open_with_flags(agent.join("agent.db"), OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|_| "Cannot read the OMP settings database")?;
    db.busy_timeout(Duration::from_millis(250)).map_err(|_| "Cannot read the OMP settings database")?;
    let bytes: Option<Vec<u8>> = db
        .query_row(
            "SELECT substr(CAST(value AS BLOB), 1, ?1) FROM settings WHERE key = 'compaction'",
            [MAX_CONFIG + 1],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "Cannot read compaction from the OMP settings database")?;
    let mut mapping = Mapping::new();
    if let Some(bytes) = bytes {
        if bytes.len() as u64 > MAX_CONFIG {
            return Err("OMP compaction settings exceed the read limit".into());
        }
        let value: Json = serde_json::from_slice(&bytes).map_err(|_| "Invalid OMP database compaction settings")?;
        mapping.insert(
            Value::String("compaction".into()),
            serde_yaml_ng::to_value(value).map_err(|_| "Invalid OMP database compaction settings")?,
        );
    }
    Ok(mapping)
}

fn unsupported_yaml(value: &Value) -> bool {
    match value {
        Value::Tagged(_) => true,
        Value::Mapping(map) => map.iter().any(|(k, v)| k.as_str() == Some("<<") || unsupported_yaml(k) || unsupported_yaml(v)),
        Value::Sequence(values) => values.iter().any(unsupported_yaml),
        _ => false,
    }
}
fn get<'a>(map: &'a Mapping, key: &str) -> Option<&'a Value> {
    map.get(Value::String(key.into()))
}
fn group(doc: &Document) -> Result<Option<&Mapping>, String> {
    match get(&doc.mapping, "compaction") {
        None => Ok(None),
        Some(Value::Mapping(map)) => Ok(Some(map)),
        _ => Err("OMP compaction must be a mapping".into()),
    }
}
fn field(map: Option<&Mapping>, name: &str, boolean: bool, fallback: Json) -> OmpCompactionField {
    let Some(raw) = map.and_then(|map| get(map, name)) else {
        return OmpCompactionField {
            value: Some(fallback),
            source: "upstream_default",
            error: None,
        };
    };
    let value = if boolean {
        raw.as_bool().map(Json::Bool)
    } else {
        raw.as_i64()
            .map(Json::from)
            .or_else(|| raw.as_u64().map(Json::from))
            .or_else(|| raw.as_f64().and_then(serde_json::Number::from_f64).map(Json::Number))
    };
    let error = value.is_none().then(|| format!("Invalid compaction.{name} type or non-finite value"));
    OmpCompactionField {
        value,
        source: if error.is_some() { "unknown" } else { "configured" },
        error,
    }
}
fn unknown() -> OmpCompactionField {
    OmpCompactionField {
        value: None,
        source: "unknown",
        error: None,
    }
}

fn drain_output(stdout: &mut impl Read, output: &mut Vec<u8>) -> Result<(), String> {
    let mut buffer = [0u8; 4096];
    loop {
        match stdout.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(n) if output.len() + n <= 65536 => output.extend_from_slice(&buffer[..n]),
            Ok(_) => return Err("OMP version response exceeds the read limit".into()),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("Cannot read OMP version response".into()),
        }
    }
}

// No config subcommand is used by snapshots. Even `config get/path` initializes OMP.
fn version_output(app_config: &Path, binary: &Path, timeout: Duration) -> Result<Vec<u8>, String> {
    let (agent, config) = crate::omp_home_dirs(app_config);
    let mut command = Command::new(binary);
    command
        .env_clear()
        .envs(crate::omp_inherited_env())
        .env("PI_CODING_AGENT_DIR", &agent)
        .env("PI_CONFIG_DIR", &config)
        .env("PI_SKIP_VERSION_CHECK", "1")
        .env("HOME", config.parent().ok_or("Invalid installation home")?)
        .current_dir("/")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|_| "Cannot start OMP version probe")?;
    let mut stdout = child.stdout.take().ok_or("Cannot read OMP version response")?;
    let fd = stdout.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Cannot bound OMP version probe".into());
    }
    let deadline = Instant::now() + timeout;
    let mut output = Vec::new();
    let result = loop {
        if let Err(error) = drain_output(&mut stdout, &mut output) {
            break Err(error);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if let Err(error) = drain_output(&mut stdout, &mut output) {
                    break Err(error);
                }
                break if status.success() { Ok(output) } else { Err("OMP version probe failed".into()) };
            }
            Err(_) => break Err("Cannot inspect OMP version probe".into()),
            Ok(None) if Instant::now() >= deadline => break Err("OMP version probe timed out".into()),
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}
fn version(app_config: &Path, binary: &Path) -> Result<String, String> {
    let output = version_output(app_config, binary, Duration::from_secs(3))?;
    let raw = std::str::from_utf8(&output).map_err(|_| "OMP version response is not valid UTF-8")?.trim();
    let version = raw.strip_prefix("omp/").ok_or("OMP version response has an unrecognized format")?;
    if version.is_empty() || version.len() > 40 || !version.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return Err("OMP version response has an unrecognized format".into());
    }
    Ok(version.into())
}

fn snapshot(app_config: &Path, binary: Option<&Path>) -> OmpCompactionSnapshot {
    let mut result = OmpCompactionSnapshot {
        binary_path: binary.map(|p| p.to_string_lossy().into_owned()),
        installed_version: None,
        config_path: None,
        status: "missing_binary",
        enabled: unknown(),
        threshold_percent: unknown(),
        threshold_tokens: unknown(),
        mid_turn_enabled: unknown(),
        async_enabled: unknown(),
        errors: Vec::new(),
    };
    let (agent, _) = crate::omp_home_dirs(app_config);
    result.config_path = ["config.yml", "config.yaml"]
        .into_iter()
        .map(|name| agent.join(name))
        .find(|path| !matches!(fs::symlink_metadata(path), Err(error) if error.kind() == std::io::ErrorKind::NotFound))
        .map(|path| path.to_string_lossy().into_owned());
    let doc = document(&agent);
    if let Ok(doc) = &doc {
        result.config_path = doc.path.as_ref().map(|p| p.to_string_lossy().into_owned());
    }
    let Some(binary) = binary else {
        result.errors.push("Packaged OMP is unavailable".into());
        return result;
    };
    result.installed_version = match version(app_config, binary) {
        Ok(version) => Some(version),
        Err(error) => {
            result.status = "unsupported";
            result.errors.push(format!("Cannot identify the installed OMP version: {error}"));
            return result;
        }
    };
    if result.installed_version.as_deref() != Some(SUPPORTED) {
        result.status = "unsupported";
        result
            .errors
            .push("Alinery has not verified compaction settings for this OMP version; verified version: 18.1.13".into());
        return result;
    }
    let mut doc = match doc {
        Ok(doc) => doc,
        Err((status, error)) => {
            result.status = status;
            result.errors.push(error);
            return result;
        }
    };
    if doc.path.is_none() && doc.legacy {
        match database_compaction(&agent) {
            Ok(mapping) => {
                doc.mapping = mapping;
                result.config_path = Some(agent.join("agent.db").to_string_lossy().into_owned());
            }
            Err(error) => {
                result.status = "legacy_unresolved";
                result.errors.push(error);
                return result;
            }
        }
    }
    let map = match group(&doc) {
        Ok(map) => map,
        Err(error) => {
            result.status = "invalid";
            result.errors.push(error);
            return result;
        }
    };
    result.enabled = field(map, "enabled", true, Json::Bool(true));
    result.threshold_percent = field(map, "thresholdPercent", false, Json::from(-1));
    result.threshold_tokens = field(map, "thresholdTokens", false, Json::from(-1));
    result.mid_turn_enabled = field(map, "midTurnEnabled", true, Json::Bool(true));
    result.async_enabled = field(map, "asyncEnabled", true, Json::Bool(true));
    for field in [
        &result.enabled,
        &result.threshold_percent,
        &result.threshold_tokens,
        &result.mid_turn_enabled,
        &result.async_enabled,
    ] {
        if let Some(error) = &field.error {
            result.errors.push(error.clone());
        }
    }
    result.status = if result.errors.is_empty() { "ready" } else { "invalid" };
    result
}

pub fn read_omp_compaction(app_config: &Path) -> Result<OmpCompactionSnapshot, String> {
    let binary = crate::resolve_packaged_omp_path().ok();
    Ok(snapshot(app_config, binary.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("alinery-omp-config-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn app(&self) -> PathBuf {
            self.0.join("app.toml")
        }
        fn agent(&self) -> PathBuf {
            let agent = crate::omp_home_dirs(&self.app()).0;
            fs::create_dir_all(&agent).unwrap();
            agent
        }
        fn script(&self, body: &str) -> PathBuf {
            let path = self.0.join(format!("fixture-{}", uuid::Uuid::new_v4()));
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn omp_config_reads_are_nonmutating_and_honest() {
        let f = Fixture::new();
        let binary = f.script("test \"$1\" = --version || exit 91; printf 'omp/18.1.13\\n'");
        let agent = crate::omp_home_dirs(&f.app()).0;
        let absent = snapshot(&f.app(), Some(&binary));
        assert_eq!(absent.status, "ready");
        assert_eq!(absent.threshold_percent.value, Some(Json::from(-1)));
        assert_eq!(absent.mid_turn_enabled.value, Some(Json::Bool(true)));
        assert_eq!(absent.async_enabled.value, Some(Json::Bool(true)));
        assert!(!agent.exists());
        let agent = f.agent();
        fs::write(agent.join("settings.json"), b"{/* legacy */\"compaction\":{\"enabled\":false}}").unwrap();
        let legacy = snapshot(&f.app(), Some(&binary));
        assert_eq!(legacy.status, "legacy_unresolved");
        assert_eq!(legacy.enabled.source, "unknown");
        assert!(!agent.join("config.yml").exists());
        let content = "compaction: {enabled: false, thresholdPercent: 65, thresholdTokens: -1, midTurnEnabled: false, asyncEnabled: true}\nsecret: do-not-return-this\n";
        fs::write(agent.join("config.yaml"), content).unwrap();
        let before = fs::metadata(agent.join("config.yaml")).unwrap().modified().unwrap();
        let configured = snapshot(&f.app(), Some(&binary));
        assert_eq!(configured.status, "ready");
        assert_eq!(configured.enabled.value, Some(Json::Bool(false)));
        assert_eq!(configured.threshold_percent.value, Some(Json::from(65)));
        assert_eq!(configured.threshold_tokens.source, "configured");
        assert_eq!(configured.mid_turn_enabled.value, Some(Json::Bool(false)));
        assert!(!serde_json::to_string(&configured).unwrap().contains("do-not-return-this"));
        assert_eq!(fs::read_to_string(agent.join("config.yaml")).unwrap(), content);
        assert_eq!(fs::metadata(agent.join("config.yaml")).unwrap().modified().unwrap(), before);
    }

    #[test]
    fn omp_config_database_without_yaml_reports_native_values_without_migration() {
        let f = Fixture::new();
        let binary = f.script("test \"$1\" = --version || exit 91; printf 'omp/18.1.13\\n'");
        let agent = f.agent();
        let db = rusqlite::Connection::open(agent.join("agent.db")).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        db.execute("INSERT INTO settings VALUES ('unrelated', ?1)", ["\"private-canary\""]).unwrap();
        let before = fs::read(agent.join("agent.db")).unwrap();
        let wal_before = fs::read(agent.join("agent.db-wal")).unwrap();
        let state = snapshot(&f.app(), Some(&binary));
        assert_eq!(state.status, "ready");
        assert_eq!(state.enabled.value, Some(Json::Bool(true)));
        assert_eq!(state.threshold_percent.value, Some(Json::from(-1)));
        assert_eq!(state.threshold_tokens.value, Some(Json::from(-1)));
        assert_eq!(state.mid_turn_enabled.value, Some(Json::Bool(true)));
        assert_eq!(state.async_enabled.value, Some(Json::Bool(true)));
        assert_eq!(state.enabled.source, "upstream_default");
        assert_eq!(fs::read(agent.join("agent.db")).unwrap(), before);
        assert_eq!(fs::read(agent.join("agent.db-wal")).unwrap(), wal_before);
        assert!(!agent.join("config.yml").exists());

        // Keep the WAL writer open: a reader must not ignore committed WAL values.
        db.execute(
            "INSERT INTO settings VALUES ('compaction', ?1)",
            [r#"{"enabled":false,"thresholdPercent":65,"thresholdTokens":10000}"#],
        )
        .unwrap();
        let configured = snapshot(&f.app(), Some(&binary));
        assert_eq!(configured.enabled.value, Some(Json::Bool(false)));
        assert_eq!(configured.threshold_percent.value, Some(Json::from(65)));
        assert_eq!(configured.threshold_tokens.value, Some(Json::from(10000)));
        assert_eq!(configured.enabled.source, "configured");
        assert_eq!(configured.async_enabled.source, "upstream_default");
        assert_eq!(configured.status, "ready");
        assert!(!serde_json::to_string(&configured).unwrap().contains("private-canary"));
        assert!(!agent.join("config.yml").exists());

        db.execute("UPDATE settings SET value = 'broken' WHERE key = 'compaction'", []).unwrap();
        let invalid = snapshot(&f.app(), Some(&binary));
        assert_eq!(invalid.enabled.source, "unknown");
        assert_eq!(invalid.status, "legacy_unresolved");
    }

    #[test]
    fn omp_config_selects_yaml_and_rejects_invalid_without_falling_through() {
        let f = Fixture::new();
        let agent = f.agent();
        let binary = f.script("test \"$1\" = --version || exit 91; printf 'omp/18.1.13\\n'");
        fs::write(agent.join("config.yaml"), "compaction: {enabled: false}\n").unwrap();
        assert_eq!(snapshot(&f.app(), Some(&binary)).enabled.value, Some(Json::Bool(false)));
        fs::write(agent.join("config.yml"), "compaction: [broken\n").unwrap();
        assert_eq!(snapshot(&f.app(), Some(&binary)).status, "invalid");
        fs::write(agent.join("config.yml"), "compaction: {enabled: true}\n").unwrap();
        // Ignored candidate contents cannot invalidate the selected .yml.
        fs::remove_file(agent.join("config.yaml")).unwrap();
        fs::create_dir(agent.join("config.yaml")).unwrap();
        assert_eq!(snapshot(&f.app(), Some(&binary)).enabled.value, Some(Json::Bool(true)));
        for invalid in [
            "[]",
            "compaction: null",
            "compaction: {enabled: null}",
            "compaction: {enabled: 'false'}",
            "compaction: {thresholdPercent: .nan}",
            "base: &base {enabled: false}\ncompaction: {<<: *base}",
        ] {
            fs::write(agent.join("config.yml"), invalid).unwrap();
            assert_eq!(snapshot(&f.app(), Some(&binary)).status, "invalid", "{invalid}");
            assert_eq!(fs::read_to_string(agent.join("config.yml")).unwrap(), invalid);
        }
        for valid in [
            "",
            "null",
            "compaction: {thresholdPercent: 0, thresholdTokens: -2}",
            "base: &base false\ncompaction: {enabled: *base}",
        ] {
            fs::write(agent.join("config.yml"), valid).unwrap();
            let state = snapshot(&f.app(), Some(&binary));
            assert_eq!(state.status, "ready", "{valid}");
            if valid.contains("thresholdPercent") {
                assert_eq!(state.threshold_percent.value, Some(Json::from(0)));
                assert_eq!(state.threshold_tokens.value, Some(Json::from(-2)));
            }
        }
    }

    #[test]
    fn omp_config_unverified_and_unidentified_versions_keep_values_unknown_and_errors_safe() {
        let f = Fixture::new();
        let agent = f.agent();
        let content = "compaction: {enabled: false}\nsecret: private-secret\n";
        fs::write(agent.join("config.yml"), content).unwrap();
        for (script, installed, cause) in [
            ("echo omp/99.0.0", Some("99.0.0"), "not verified"),
            ("echo private-secret; echo private-secret >&2; exit 1", None, "probe failed"),
            ("echo private-secret", None, "unrecognized format"),
            ("printf 'omp/'", None, "unrecognized format"),
            ("printf '\\377'", None, "not valid UTF-8"),
        ] {
            let binary = f.script(script);
            let state = snapshot(&f.app(), Some(&binary));
            assert_eq!(state.status, "unsupported");
            assert_eq!(state.installed_version.as_deref(), installed);
            assert!(state.errors.iter().any(|error| error.contains(cause)));
            if installed.is_none() {
                assert!(state.errors.iter().any(|error| error.contains("Cannot identify")));
                assert!(!state.errors.iter().any(|error| error.contains("18.1.13")));
            }
            for field in [
                &state.enabled,
                &state.threshold_percent,
                &state.threshold_tokens,
                &state.mid_turn_enabled,
                &state.async_enabled,
            ] {
                assert_eq!(field.source, "unknown");
                assert_eq!(field.value, None);
            }
            assert!(!serde_json::to_string(&state).unwrap().contains("private-secret"));
            assert_eq!(fs::read_to_string(agent.join("config.yml")).unwrap(), content);
        }
        assert_eq!(snapshot(&f.app(), None).status, "missing_binary");
    }

    #[test]
    fn omp_config_version_probe_has_time_and_output_limits() {
        let f = Fixture::new();
        let hangs = f.script("exec /bin/sleep 10");
        assert!(version_output(&f.app(), &hangs, Duration::from_millis(30)).unwrap_err().contains("timed out"));
        let oversized = f.script("exec /usr/bin/yes overflow");
        assert!(version_output(&f.app(), &oversized, Duration::from_secs(2)).unwrap_err().contains("read limit"));
    }

    #[test]
    fn omp_config_denied_read_is_not_empty_configuration() {
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("permission-denial scenario requires a non-root UID; root bypasses chmod(000)");
            return;
        }
        let f = Fixture::new();
        let agent = f.agent();
        let path = agent.join("config.yml");
        fs::write(&path, "compaction: {enabled: false}\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        assert!(fs::read(&path).is_err(), "fixture must actually deny reads");
        let state = document(&agent).err().unwrap();
        assert_eq!(state.0, "unreadable");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "compaction: {enabled: false}\n");
    }
}
