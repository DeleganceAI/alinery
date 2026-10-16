//! Installation-global OMP configuration. Only the verified OMP CLI writes YAML.
use crate::lockfile::{try_lock_exclusive, ProcessLease};
use serde::Serialize;
use serde_json::Value as Json;
use serde_yaml_ng::{Mapping, Value};
use std::collections::{hash_map::DefaultHasher, HashMap};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, LazyLock, Mutex,
};
use std::time::{Duration, Instant};

const SUPPORTED: &str = "18.1.13";
const MAX_CONFIG: u64 = 1024 * 1024;
const BUSY: &str = "OMP is active in this installation; retry after all managed OMP processes exit.";
static SEEDS: LazyLock<[(&str, Json); 4]> = LazyLock::new(|| {
    [
        ("enabled", Json::Bool(true)),
        ("thresholdPercent", Json::from(40)),
        ("midTurnEnabled", Json::Bool(true)),
        ("asyncEnabled", Json::Bool(true)),
    ]
});

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
    pub revision: String,
    pub write_allowed: bool,
    pub write_blocked_reason: Option<String>,
    pub pending_defaults: bool,
    pub enabled: OmpCompactionField,
    pub threshold_percent: OmpCompactionField,
    pub threshold_tokens: OmpCompactionField,
    pub mid_turn_enabled: OmpCompactionField,
    pub async_enabled: OmpCompactionField,
    pub errors: Vec<String>,
}

#[derive(Default)]
struct Slot {
    gate: Mutex<()>,
    active: AtomicUsize,
}
static SLOTS: LazyLock<Mutex<HashMap<PathBuf, Arc<Slot>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Close-only shared lease, retained by the final OMP process rather than its daemon.
pub struct OmpLaunchLease {
    lease: ProcessLease,
    slot: Arc<Slot>,
}
impl OmpLaunchLease {
    pub fn retain_across_exec(&self) -> Result<(), String> {
        self.lease.retain_across_exec().map_err(|_| "Cannot retain OMP process lease across exec".into())
    }
}
impl Drop for OmpLaunchLease {
    fn drop(&mut self) {
        self.slot.active.fetch_sub(1, Ordering::SeqCst);
    }
}

fn root(app_config: &Path) -> Result<PathBuf, String> {
    let root = crate::omp_home_dirs(app_config).1.parent().ok_or("Invalid OMP installation path")?.to_path_buf();
    fs::create_dir_all(&root).map_err(|_| "Cannot open OMP installation coordination directory")?;
    fs::canonicalize(root).map_err(|_| "Cannot resolve OMP installation identity".into())
}

pub fn register_omp_launch_owner(app_config: &Path) -> Result<(), String> {
    crate::omp_ownership::register(&root(app_config)?)
}

fn transaction<T>(app_config: &Path, operation: impl FnOnce(&Path, &Arc<Slot>) -> Result<T, String>) -> Result<T, String> {
    let root = root(app_config)?;
    let slot = SLOTS.lock().map_err(|_| "OMP coordination unavailable")?.entry(root.clone()).or_default().clone();
    let deadline = Instant::now() + Duration::from_secs(2);
    let local = loop {
        match slot.gate.try_lock() {
            Ok(guard) => break guard,
            Err(std::sync::TryLockError::Poisoned(_)) => return Err("OMP coordination unavailable".into()),
            Err(_) if Instant::now() >= deadline => return Err("OMP settings transaction busy; retry shortly".into()),
            Err(_) => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    let gate = loop {
        match try_lock_exclusive(&root.join("configuration.lock")).map_err(|_| "Cannot lock OMP configuration")? {
            Some(gate) => break gate,
            None if Instant::now() >= deadline => return Err("OMP settings transaction busy; retry shortly".into()),
            None => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    let result = operation(&root, &slot);
    drop(gate);
    drop(local);
    result
}

fn idle(app_config: &Path, root: &Path, slot: &Slot) -> Result<ProcessLease, String> {
    if slot.active.load(Ordering::SeqCst) != 0 {
        return Err(BUSY.into());
    }
    let lease = ProcessLease::acquire(&root.join("processes.lock"), true)
        .map_err(|_| "Cannot establish OMP process ownership")?
        .ok_or(BUSY)?;
    crate::omp_ownership::check(app_config, root)?;
    Ok(lease)
}

#[derive(Debug)]
struct Document {
    path: Option<PathBuf>,
    mapping: Mapping,
    revision: String,
    legacy: bool,
}

fn document(agent: &Path) -> Result<Document, (&'static str, String)> {
    let mut hash = DefaultHasher::new();
    let mut selected = None;
    let mut selected_bytes = None;
    let mut legacy = false;
    for name in ["config.yml", "config.yaml", "settings.json", "agent.db"] {
        // Once YAML is selected, OMP's live database is not a settings candidate.
        // Normal CLI initialization can update it without changing configuration.
        if !name.starts_with("config.") && selected.is_some() {
            continue;
        }
        name.hash(&mut hash);
        let path = agent.join(name);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                false.hash(&mut hash);
            }
            Err(_) => return Err(("unreadable", "Cannot inspect OMP configuration".into())),
            Ok(meta) => {
                use std::os::unix::fs::MetadataExt;
                true.hash(&mut hash);
                (meta.dev(), meta.ino(), meta.len(), meta.mtime(), meta.mtime_nsec()).hash(&mut hash);
                if name.starts_with("config.") {
                    if selected.is_none() {
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
                        bytes.hash(&mut hash);
                        selected = Some(path);
                        selected_bytes = Some(bytes);
                    }
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
    Ok(Document {
        path: selected,
        mapping,
        revision: format!("{:016x}", hash.finish()),
        legacy,
    })
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
            Ok(_) => return Err("OMP configuration response exceeds the read limit".into()),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("Cannot read OMP configuration response".into()),
        }
    }
}

// No config subcommand is used by snapshots. Even `config get/path` initializes OMP.
fn command(app_config: &Path, binary: &Path, args: &[&str], timeout: Duration) -> Result<Vec<u8>, String> {
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
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|_| "Cannot start OMP configuration command")?;
    let mut stdout = child.stdout.take().ok_or("Cannot read OMP configuration response")?;
    let fd = stdout.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Cannot bound OMP configuration command".into());
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
                break if status.success() {
                    Ok(output)
                } else {
                    Err("OMP configuration command failed; no settings success was confirmed".into())
                };
            }
            Err(_) => break Err("Cannot inspect OMP configuration command".into()),
            Ok(None) if Instant::now() >= deadline => break Err("OMP configuration command timed out".into()),
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}
fn version(app_config: &Path, binary: &Path) -> Option<String> {
    let output = command(app_config, binary, &["--version"], Duration::from_secs(3)).ok()?;
    let raw = std::str::from_utf8(&output).ok()?.trim();
    let version = raw.strip_prefix("omp/")?;
    if version.len() > 40 || !version.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return None;
    }
    Some(version.into())
}

fn snapshot(app_config: &Path, binary: Option<&Path>) -> OmpCompactionSnapshot {
    let mut result = OmpCompactionSnapshot {
        binary_path: binary.map(|p| p.to_string_lossy().into_owned()),
        installed_version: None,
        config_path: None,
        status: "missing_binary",
        revision: String::new(),
        write_allowed: false,
        write_blocked_reason: None,
        pending_defaults: false,
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
        result.revision.clone_from(&doc.revision);
        result.config_path = doc.path.as_ref().map(|p| p.to_string_lossy().into_owned());
    }
    let Some(binary) = binary else {
        result.errors.push("Packaged OMP is unavailable".into());
        return result;
    };
    result.installed_version = version(app_config, binary);
    if result.installed_version.as_deref() != Some(SUPPORTED) {
        result.status = "unsupported";
        result.errors.push("Compaction settings require verified OMP 18.1.13".into());
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
                result.write_blocked_reason = Some("Save settings in OMP before editing them here.".into());
            }
            Err(error) => {
                result.status = "legacy_unresolved";
                result.pending_defaults = true;
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
    result.pending_defaults = SEEDS.iter().any(|(key, _)| map.and_then(|map| get(map, key)).is_none());
    result.status = if !result.errors.is_empty() {
        "invalid"
    } else if result.pending_defaults {
        "pending_initialization"
    } else {
        "ready"
    };
    result
}

pub fn read_omp_compaction(app_config: &Path) -> Result<OmpCompactionSnapshot, String> {
    let binary = crate::resolve_packaged_omp_path().ok();
    let mut result = snapshot(app_config, binary.as_deref());
    if result.write_blocked_reason.is_none() && matches!(result.status, "ready" | "pending_initialization") {
        match transaction(app_config, |root, slot| idle(app_config, root, slot).map(drop)) {
            Ok(()) => result.write_allowed = true,
            Err(error) => result.write_blocked_reason = Some(error),
        }
    } else if result.write_blocked_reason.is_none() {
        result.write_blocked_reason = Some("Resolve the installation configuration state before editing".into());
    }
    Ok(result)
}

fn valid_document(app_config: &Path) -> Result<Document, String> {
    let doc = document(&crate::omp_home_dirs(app_config).0).map_err(|(_, error)| error)?;
    let map = group(&doc)?;
    for (name, boolean, fallback) in [
        ("enabled", true, Json::Bool(true)),
        ("thresholdPercent", false, Json::from(-1)),
        ("thresholdTokens", false, Json::from(-1)),
        ("midTurnEnabled", true, Json::Bool(true)),
        ("asyncEnabled", true, Json::Bool(true)),
    ] {
        if let Some(error) = field(map, name, boolean, fallback).error {
            return Err(error);
        }
    }
    Ok(doc)
}
fn unchanged(app_config: &Path, revision: &str) -> Result<(), String> {
    if valid_document(app_config)?.revision != revision {
        return Err("OMP configuration changed externally; refresh before retrying".into());
    }
    Ok(())
}
fn initialize(app_config: &Path, binary: &Path) -> Result<Option<Document>, String> {
    let before = valid_document(app_config)?;
    unchanged(app_config, &before.revision)?;
    command(app_config, binary, &["config", "path"], Duration::from_secs(10))?;
    let after = valid_document(app_config)?;
    // A fresh initialization creates agent.db without YAML. Preexisting legacy
    // evidence is different: OMP can silently ignore corrupt JSONC with exit 0.
    if before.path.is_none() && before.legacy && after.path.is_none() {
        return Ok(None);
    }
    if before.path.is_some() && before.revision != after.revision {
        return Err("OMP configuration changed during initialization; refresh before retrying".into());
    }
    Ok(Some(after))
}
fn set_key(app_config: &Path, binary: &Path, doc: &Document, key: &str, value: &Json) -> Result<Document, String> {
    unchanged(app_config, &doc.revision)?;
    let literal = serde_json::to_string(value).map_err(|_| "Cannot encode OMP setting")?;
    let response = command(app_config, binary, &["config", "set", key, &literal, "--json"], Duration::from_secs(10))?;
    let response: Json = serde_json::from_slice(&response).map_err(|_| "OMP returned an invalid settings confirmation")?;
    if response.get("key").and_then(Json::as_str) != Some(key) || response.get("value") != Some(value) {
        return Err("OMP did not confirm the requested setting".into());
    }
    let fresh = valid_document(app_config)?;
    let mut persisted = Value::Mapping(fresh.mapping.clone());
    for segment in key.split('.') {
        persisted = persisted.as_mapping().and_then(|m| get(m, segment)).cloned().ok_or("OMP setting was not persisted")?;
    }
    if serde_json::to_value(persisted).ok().as_ref() != Some(value) {
        return Err("OMP setting persistence did not match its confirmation".into());
    }
    let mut expected = doc.mapping.clone();
    let yaml_value = serde_yaml_ng::to_value(value).map_err(|_| "Cannot compare persisted OMP setting")?;
    if let Some((parent, leaf)) = key.split_once('.') {
        let mut map = get(&expected, parent).and_then(Value::as_mapping).cloned().unwrap_or_default();
        map.insert(Value::String(leaf.into()), yaml_value);
        expected.insert(Value::String(parent.into()), Value::Mapping(map));
    } else {
        expected.insert(Value::String(key.into()), yaml_value);
    }
    if fresh.mapping != expected {
        return Err("OMP configuration changed beyond the requested setting; refresh before retrying".into());
    }
    Ok(fresh)
}
fn seed(app_config: &Path, binary: &Path) -> Result<(), String> {
    let Some(mut doc) = initialize(app_config, binary)? else {
        return Ok(());
    };
    for (name, value) in SEEDS.iter() {
        if group(&doc)?.and_then(|map| get(map, name)).is_none() {
            doc = set_key(app_config, binary, &doc, &format!("compaction.{name}"), value)?;
        }
    }
    Ok(())
}

pub fn set_omp_auto_compaction(app_config: &Path, enabled: bool, expected_revision: &str) -> Result<OmpCompactionSnapshot, String> {
    let binary = crate::resolve_packaged_omp_path().map_err(|_| "Packaged OMP is unavailable")?;
    transaction(app_config, |root, slot| {
        let _idle = idle(app_config, root, slot)?;
        if version(app_config, &binary).as_deref() != Some(SUPPORTED) {
            return Err("Compaction settings require verified OMP 18.1.13".into());
        }
        unchanged(app_config, expected_revision)?;
        let doc = initialize(app_config, &binary)?.ok_or("Legacy OMP settings remain unresolved; no settings were written")?;
        set_key(app_config, &binary, &doc, "compaction.enabled", &Json::Bool(enabled))?;
        let mut fresh = snapshot(app_config, Some(&binary));
        fresh.write_allowed = matches!(fresh.status, "ready" | "pending_initialization");
        Ok(fresh)
    })
}

pub fn prepare_omp_launch(app_config: &Path, executable: &Path) -> Result<OmpLaunchLease, String> {
    transaction(app_config, |root, slot| {
        let packaged = crate::resolve_packaged_omp_path().ok();
        let managed = packaged
            .as_deref()
            .is_some_and(|p| fs::canonicalize(p).ok().zip(fs::canonicalize(executable).ok()).is_some_and(|(a, b)| a == b));
        // Explicit harness overrides are never configuration tools. They still
        // hold a shared lease, but need no version command or idle ownership scan.
        let exclusive = if managed { idle(app_config, root, slot).ok() } else { None };
        let lease = match exclusive {
            Some(lease) => {
                if version(app_config, executable).as_deref() == Some(SUPPORTED) {
                    // Invalid/unreadable YAML retains normal OMP startup behavior. Never
                    // initialize it here: OMP may quarantine it as part of its own startup.
                    if valid_document(app_config).is_ok() {
                        seed(app_config, executable)?;
                    }
                }
                lease.share().map_err(|_| "Cannot share OMP process lease")?;
                lease
            }
            None => {
                // A concurrent fork can temporarily inherit the rejected exclusive
                // probe until its CLOEXEC descriptors close. Never bypass that lease.
                let deadline = Instant::now() + Duration::from_secs(2);
                loop {
                    if let Some(lease) = ProcessLease::acquire(&root.join("processes.lock"), false).map_err(|_| "Cannot acquire OMP process lease")? {
                        break lease;
                    }
                    if Instant::now() >= deadline {
                        return Err("OMP settings transaction busy".into());
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        };
        slot.active.fetch_add(1, Ordering::SeqCst);
        Ok(OmpLaunchLease { lease, slot: slot.clone() })
    })
}

pub fn read_omp_model_roles(app_config: &Path) -> Result<HashMap<String, String>, String> {
    let doc = document(&crate::omp_home_dirs(app_config).0).map_err(|(_, error)| error)?;
    if doc.path.is_none() && doc.legacy {
        return Err("Legacy OMP model roles await normal migration at a safe launch".into());
    }
    match get(&doc.mapping, "modelRoles") {
        None | Some(Value::Null) => Ok(HashMap::new()),
        Some(value) => serde_yaml_ng::from_value(value.clone()).map_err(|_| "Invalid OMP model roles".into()),
    }
}

/// Role edits use the same migration and process-exclusion boundary; no YAML
/// renderer can precreate a file that suppresses normal legacy migration.
pub fn set_omp_model_roles(app_config: &Path, roles: &HashMap<String, String>, default_only: bool) -> Result<HashMap<String, String>, String> {
    let binary = crate::resolve_packaged_omp_path().map_err(|_| "Packaged OMP is unavailable")?;
    transaction(app_config, |root, slot| {
        let _idle = idle(app_config, root, slot)?;
        if version(app_config, &binary).as_deref() != Some(SUPPORTED) {
            return Err("Model role editing requires verified OMP 18.1.13".into());
        }
        let doc = initialize(app_config, &binary)?.ok_or("Legacy OMP settings remain unresolved; no model roles were written")?;
        let mut next = roles.clone();
        if default_only {
            next = match get(&doc.mapping, "modelRoles") {
                None | Some(Value::Null) => HashMap::new(),
                Some(value) => serde_yaml_ng::from_value(value.clone()).map_err(|_| "Invalid OMP model roles")?,
            };
            if next.contains_key("default") {
                return Ok(next);
            }
            if let Some(value) = roles.get("default") {
                next.insert("default".into(), value.clone());
            }
        }
        set_key(
            app_config,
            &binary,
            &doc,
            "modelRoles",
            &serde_json::to_value(&next).map_err(|_| "Cannot encode OMP model roles")?,
        )?;
        Ok(next)
    })
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
        let agent = f.agent();
        let absent = snapshot(&f.app(), Some(&binary));
        assert_eq!(absent.status, "pending_initialization");
        assert_eq!(absent.threshold_percent.value, Some(Json::from(-1)));
        assert_eq!(absent.mid_turn_enabled.value, Some(Json::Bool(true)));
        assert_eq!(absent.async_enabled.value, Some(Json::Bool(true)));
        assert!(fs::read_dir(&agent).unwrap().next().is_none());
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
        assert!(!configured.write_allowed);
        assert!(!serde_json::to_string(&configured).unwrap().contains("private-canary"));
        assert!(!agent.join("config.yml").exists());

        db.execute("UPDATE settings SET value = 'broken' WHERE key = 'compaction'", []).unwrap();
        let invalid = snapshot(&f.app(), Some(&binary));
        assert_eq!(invalid.enabled.source, "unknown");
        assert!(!invalid.write_allowed);
    }

    #[test]
    fn omp_config_selects_yaml_and_rejects_invalid_without_falling_through() {
        let f = Fixture::new();
        let agent = f.agent();
        fs::write(agent.join("config.yaml"), "compaction: {enabled: false}\n").unwrap();
        let yaml = valid_document(&f.app()).unwrap();
        fs::write(agent.join("config.yml"), "compaction: [broken\n").unwrap();
        assert!(valid_document(&f.app()).is_err());
        fs::write(agent.join("config.yml"), "compaction: {enabled: true}\n").unwrap();
        // Ignored candidate contents cannot invalidate the selected .yml.
        fs::remove_file(agent.join("config.yaml")).unwrap();
        fs::create_dir(agent.join("config.yaml")).unwrap();
        assert!(valid_document(&f.app()).is_ok());
        assert!(unchanged(&f.app(), &yaml.revision).is_err());
        for invalid in [
            "[]",
            "compaction: null",
            "compaction: {enabled: null}",
            "compaction: {enabled: 'false'}",
            "compaction: {thresholdPercent: .nan}",
            "base: &base {enabled: false}\ncompaction: {<<: *base}",
        ] {
            fs::write(agent.join("config.yml"), invalid).unwrap();
            assert!(valid_document(&f.app()).is_err(), "{invalid}");
            assert_eq!(fs::read_to_string(agent.join("config.yml")).unwrap(), invalid);
        }
        for valid in [
            "",
            "null",
            "compaction: {thresholdPercent: 0, thresholdTokens: -2}",
            "base: &base false\ncompaction: {enabled: *base}",
        ] {
            fs::write(agent.join("config.yml"), valid).unwrap();
            assert!(valid_document(&f.app()).is_ok(), "{valid}");
        }
    }

    #[test]
    fn omp_config_unsupported_version_never_claims_defaults_or_exposes_stderr() {
        let f = Fixture::new();
        for script in ["echo omp/99.0.0", "echo private-secret >&2; exit 1", "echo private-secret"] {
            let binary = f.script(script);
            let state = snapshot(&f.app(), Some(&binary));
            assert_eq!(state.status, "unsupported");
            assert_eq!(state.enabled.source, "unknown");
            assert!(!state.write_allowed);
            assert!(!serde_json::to_string(&state).unwrap().contains("private-secret"));
        }
        assert_eq!(snapshot(&f.app(), None).status, "missing_binary");
    }

    #[test]
    fn omp_config_false_success_and_timeout_are_not_persistence() {
        let f = Fixture::new();
        let agent = f.agent();
        fs::write(agent.join("config.yml"), "compaction: {enabled: false}\n").unwrap();
        let before = valid_document(&f.app()).unwrap();
        let liar = f.script("printf '{\"key\":\"compaction.enabled\",\"value\":true}\\n'");
        assert!(set_key(&f.app(), &liar, &before, "compaction.enabled", &Json::Bool(true)).is_err());
        assert_eq!(valid_document(&f.app()).unwrap().revision, before.revision);
        for body in [
            "printf private-secret >&2; exit 23",
            "printf '{broken private-secret'",
            "printf '{\"key\":\"compaction.enabled\",\"value\":\"true\"}\\n'",
        ] {
            let binary = f.script(body);
            let error = set_key(&f.app(), &binary, &before, "compaction.enabled", &Json::Bool(true)).unwrap_err();
            assert!(!error.contains("private-secret"));
            assert_eq!(valid_document(&f.app()).unwrap().revision, before.revision);
        }
        fs::write(agent.join("config.yml"), "compaction: {enabled: false, thresholdPercent: 65}\n").unwrap();
        let forbidden = f.script("touch \"$PI_CODING_AGENT_DIR/incorrectly-invoked\"; exit 1");
        assert!(set_key(&f.app(), &forbidden, &before, "compaction.enabled", &Json::Bool(true)).is_err());
        assert!(!agent.join("incorrectly-invoked").exists());
        let hangs = f.script("exec /bin/sleep 10");
        assert!(command(&f.app(), &hangs, &[], Duration::from_millis(30)).unwrap_err().contains("timed out"));
        let oversized = f.script("exec /usr/bin/yes overflow");
        assert!(command(&f.app(), &oversized, &[], Duration::from_secs(2)).unwrap_err().contains("read limit"));
    }

    #[test]
    fn omp_config_partial_failure_keeps_confirmed_state_and_pending_defaults() {
        let f = Fixture::new();
        let agent = f.agent();
        // Deliberate fault injection: the first setter persists, the second fails.
        // Normal persistence is exercised with actual OMP in runner/tests/omp_config.rs.
        let binary = f.script(
            r#"
case "$1:$2:$3" in
  --version::) printf 'omp/18.1.13\n' ;;
  config:path:) exit 0 ;;
  config:set:compaction.enabled)
    printf 'compaction: {enabled: true}\n' > "$PI_CODING_AGENT_DIR/config.yml"
    printf '{"key":"compaction.enabled","value":true}\n' ;;
  *) printf 'private-secret\n' >&2; exit 31 ;;
esac
"#,
        );
        let error = seed(&f.app(), &binary).unwrap_err();
        assert!(!error.contains("private-secret"));
        let partial = snapshot(&f.app(), Some(&binary));
        assert_eq!(partial.enabled.value, Some(Json::Bool(true)));
        assert_eq!(partial.enabled.source, "configured");
        assert_eq!(partial.threshold_percent.value, Some(Json::from(-1)));
        assert!(partial.pending_defaults);
        assert_eq!(fs::read_to_string(agent.join("config.yml")).unwrap(), "compaction: {enabled: true}\n");
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

    #[test]
    fn omp_config_shared_leases_reject_same_process_edits_until_all_drop() {
        let f = Fixture::new();
        let other = Fixture::new();
        let executable = Path::new("/bin/true");
        let first = prepare_omp_launch(&f.app(), executable).unwrap();
        let second = prepare_omp_launch(&f.app(), executable).unwrap();
        assert!(transaction(&f.app(), |root, slot| idle(&f.app(), root, slot).map(drop)).is_err());
        transaction(&other.app(), |root, slot| idle(&other.app(), root, slot).map(drop)).unwrap();
        drop(first);
        assert!(transaction(&f.app(), |root, slot| idle(&f.app(), root, slot).map(drop)).is_err());
        drop(second);
        transaction(&f.app(), |root, slot| idle(&f.app(), root, slot).map(drop)).unwrap();
    }

    #[test]
    fn omp_config_exec_lease_outlives_parent_descriptor() {
        use std::io::{BufRead, BufReader, Write};
        let f = Fixture::new();
        let path = f.0.join("lifetime.lock");
        let lease = ProcessLease::acquire(&path, false).unwrap().unwrap();
        use std::os::unix::process::CommandExt;
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf 'ready\n'; read answer"]).stdin(Stdio::piped()).stdout(Stdio::piped());
        // Clear CLOEXEC only in the fork child, never in this multithreaded test
        // process where unrelated concurrent fixtures could inherit the descriptor.
        unsafe {
            command.pre_exec(move || lease.retain_across_exec());
        }
        let mut child = command.spawn().unwrap();
        drop(command);
        let stdout = child.stdout.take().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = BufReader::new(stdout).read_line(&mut line);
            let _ = sender.send(line);
        });
        let ready = receiver.recv_timeout(Duration::from_secs(3));
        if ready.as_deref() != Ok("ready\n") {
            let _ = child.kill();
            let _ = child.wait();
            panic!("child readiness failed");
        }
        let blocked = ProcessLease::acquire(&path, true).unwrap().is_none();
        child.stdin.take().unwrap().write_all(b"done\n").unwrap();
        assert!(child.wait().unwrap().success());
        assert!(blocked);
        assert!(ProcessLease::acquire(&path, true).unwrap().is_some());
    }
}
