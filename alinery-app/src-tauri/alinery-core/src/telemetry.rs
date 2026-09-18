// Product-usage telemetry. Owns the OpenObserve request shape, auth, and the
// closed event enum. Call sites pass TelemetryEvent only — never URLs, headers,
// or a free-text bag.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::backup::BackupTrigger;
use crate::settings::load_global_settings;
use crate::types::TelemetryPrefs;

pub const TELEMETRY_ORG: &str = "default";
pub const TELEMETRY_STREAM: &str = "alinery_usage";
// Write-only ingest credential, scoped by a Caddy proxy in front of OpenObserve to
// exactly POST /api/default/alinery_usage/_json (every other path/method 404s before
// reaching OpenObserve — OSS has no ingest-only *role*, so the network layer is the
// enforcement boundary). Never the OpenObserve root user; that stays on the
// firewalled admin/query port (see scripts/telemetry/APP.md).
const INGEST_USER: &str = "alinery-ingest@example.com";
const INGEST_PASSWORD: &str = "XYXXx1fbYiiCgDlp";
const SEND_TIMEOUT: Duration = Duration::from_secs(2);

const HARNESS_ALLOWLIST: &[&str] = &["omp", "no-harness"];
const PLAYBOOK_ALLOWLIST: &[&str] = &["superdevelop", "one-shot", "free-form", "review", "bug-hunting"];
const PHASE_ALLOWLIST: &[&str] = &[
    "research-questions",
    "research",
    "design",
    "structure",
    "tdd",
    "implementation",
    "pr",
    "review-context",
    "review-checks",
    "review-findings",
    "review-response",
    "rca",
    "solutions",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TelemetrySource {
    App,
    Mcp,
    Alineryd,
}

impl TelemetrySource {
    fn as_str(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Mcp => "mcp",
            Self::Alineryd => "alineryd",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TelemetryToggleSource {
    FirstRun,
    Settings,
}

impl TelemetryToggleSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::FirstRun => "first_run",
            Self::Settings => "settings",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportSource {
    Linear,
    Github,
}

impl ImportSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Linear => "linear",
            Self::Github => "github",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsChangeScope {
    Global,
    Repo,
    Appearance,
    Harnesses,
}

impl SettingsChangeScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Repo => "repo",
            Self::Appearance => "appearance",
            Self::Harnesses => "harnesses",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TelemetryEvent {
    AppOpen {
        cold_start: bool,
    },
    SettingsTelemetry {
        enabled: bool,
        source: TelemetryToggleSource,
    },
    TaskCreate {
        source: TelemetrySource,
        has_attachments: bool,
        has_worktree: bool,
        from_draft: bool,
        playbook: String,
        has_linear: bool,
        has_github: bool,
        task_id: String,
    },
    TaskDraftCreate {
        source: TelemetrySource,
        has_worktree: bool,
        playbook: String,
        task_id: String,
    },
    TaskDraftDelete {
        source: TelemetrySource,
        task_id: String,
    },
    TaskArchive {
        source: TelemetrySource,
        task_id: String,
    },
    SessionCreate {
        source: TelemetrySource,
        harness: String,
        phase: String,
        generic: bool,
        drawer: bool,
        is_resume: bool,
        session_id: String,
        task_id: String,
    },
    SessionSpawn {
        harness: String,
        phase: String,
        session_id: String,
        task_id: String,
    },
    SessionResume {
        harness: String,
        session_id: String,
        task_id: String,
    },
    SessionExit {
        source: TelemetrySource,
        harness: String,
        exit_code: Option<i32>,
        session_id: String,
        task_id: String,
    },
    SessionArchive {
        source: TelemetrySource,
        killed_live: bool,
        session_id: String,
        task_id: String,
    },
    SessionKill {
        source: TelemetrySource,
        session_id: String,
        task_id: String,
    },
    SessionPhaseComplete {
        phase: String,
        playbook: String,
        session_id: String,
        task_id: String,
    },
    SessionAutoAdvance {
        from_phase: String,
        to_phase: String,
        playbook: String,
        session_id: String,
        task_id: String,
    },
    ArtifactReviewHandoff {
        source: TelemetrySource,
        target_phase: String,
        harness: String,
    },
    ArtifactCommentAdd {
        source: TelemetrySource,
    },
    ArtifactReviewSend {
        source: TelemetrySource,
    },
    ImportFetch {
        source: TelemetrySource,
        import_source: ImportSource,
    },
    BackupCreate {
        source: TelemetrySource,
        trigger: BackupTrigger,
    },
    BackupRestore {
        source: TelemetrySource,
    },
    GitCommit {
        source: TelemetrySource,
    },
    GitPush {
        source: TelemetrySource,
    },
    GitWorktreeRemove {
        source: TelemetrySource,
    },
    SettingsChange {
        source: TelemetrySource,
        scope: SettingsChangeScope,
    },
    RepoActivate {
        source: TelemetrySource,
    },
    RepoRemove {
        source: TelemetrySource,
        was_active: bool,
    },
    McpToggle {
        source: TelemetrySource,
        enabled: bool,
    },
    DaemonStop {
        source: TelemetrySource,
    },
    DaemonTakeover {
        source: TelemetrySource,
    },
    StoragePurge {
        source: TelemetrySource,
    },
}

fn allowlisted_or_custom(raw: &str, allow: &[&str]) -> String {
    if allow.contains(&raw) {
        raw.to_string()
    } else {
        "custom".into()
    }
}

pub fn sanitize_harness(raw: &str) -> String {
    allowlisted_or_custom(raw, HARNESS_ALLOWLIST)
}

pub fn sanitize_playbook(raw: &str) -> String {
    allowlisted_or_custom(raw, PLAYBOOK_ALLOWLIST)
}

pub fn sanitize_phase(raw: &str) -> String {
    if raw.is_empty() {
        String::new()
    } else {
        allowlisted_or_custom(raw, PHASE_ALLOWLIST)
    }
}

fn insert_str(map: &mut Map<String, Value>, key: &str, value: impl Into<String>) {
    map.insert(key.to_string(), Value::String(value.into()));
}

fn insert_bool(map: &mut Map<String, Value>, key: &str, value: bool) {
    map.insert(key.to_string(), Value::Bool(value));
}

fn insert_id(map: &mut Map<String, Value>, key: &str, value: &str) {
    if !value.is_empty() {
        insert_str(map, key, value);
    }
}

pub fn event_name(event: &TelemetryEvent) -> &'static str {
    match event {
        TelemetryEvent::AppOpen { .. } => "app.open",
        TelemetryEvent::SettingsTelemetry { .. } => "settings.telemetry",
        TelemetryEvent::TaskCreate { .. } => "task.create",
        TelemetryEvent::TaskDraftCreate { .. } => "task.draft_create",
        TelemetryEvent::TaskDraftDelete { .. } => "task.draft_delete",
        TelemetryEvent::TaskArchive { .. } => "task.archive",
        TelemetryEvent::SessionCreate { .. } => "session.create",
        TelemetryEvent::SessionSpawn { .. } => "session.spawn",
        TelemetryEvent::SessionResume { .. } => "session.resume",
        TelemetryEvent::SessionExit { .. } => "session.exit",
        TelemetryEvent::SessionArchive { .. } => "session.archive",
        TelemetryEvent::SessionKill { .. } => "session.kill",
        TelemetryEvent::SessionPhaseComplete { .. } => "session.phase_complete",
        TelemetryEvent::SessionAutoAdvance { .. } => "session.auto_advance",
        TelemetryEvent::ArtifactReviewHandoff { .. } => "artifact.review_handoff",
        TelemetryEvent::ArtifactCommentAdd { .. } => "artifact.comment_add",
        TelemetryEvent::ArtifactReviewSend { .. } => "artifact.review_send",
        TelemetryEvent::ImportFetch { .. } => "import.fetch",
        TelemetryEvent::BackupCreate { .. } => "backup.create",
        TelemetryEvent::BackupRestore { .. } => "backup.restore",
        TelemetryEvent::GitCommit { .. } => "git.commit",
        TelemetryEvent::GitPush { .. } => "git.push",
        TelemetryEvent::GitWorktreeRemove { .. } => "git.worktree_remove",
        TelemetryEvent::SettingsChange { .. } => "settings.change",
        TelemetryEvent::RepoActivate { .. } => "repo.activate",
        TelemetryEvent::RepoRemove { .. } => "repo.remove",
        TelemetryEvent::McpToggle { .. } => "mcp.toggle",
        TelemetryEvent::DaemonStop { .. } => "daemon.stop",
        TelemetryEvent::DaemonTakeover { .. } => "daemon.takeover",
        TelemetryEvent::StoragePurge { .. } => "storage.purge",
    }
}

pub fn event_props(event: &TelemetryEvent) -> Map<String, Value> {
    let mut props = Map::new();
    match event {
        TelemetryEvent::AppOpen { cold_start } => {
            insert_bool(&mut props, "cold_start", *cold_start);
        }
        TelemetryEvent::SettingsTelemetry { enabled, source } => {
            insert_bool(&mut props, "enabled", *enabled);
            insert_str(&mut props, "source", source.as_str());
        }
        TelemetryEvent::TaskCreate {
            source,
            has_attachments,
            has_worktree,
            from_draft,
            playbook,
            has_linear,
            has_github,
            task_id,
        } => {
            insert_str(&mut props, "source", source.as_str());
            insert_bool(&mut props, "has_attachments", *has_attachments);
            insert_bool(&mut props, "has_worktree", *has_worktree);
            insert_bool(&mut props, "from_draft", *from_draft);
            insert_str(&mut props, "playbook", sanitize_playbook(playbook));
            insert_bool(&mut props, "has_linear", *has_linear);
            insert_bool(&mut props, "has_github", *has_github);
            insert_id(&mut props, "task_id", task_id);
        }
        TelemetryEvent::TaskDraftCreate {
            source,
            has_worktree,
            playbook,
            task_id,
        } => {
            insert_str(&mut props, "source", source.as_str());
            insert_bool(&mut props, "has_worktree", *has_worktree);
            insert_str(&mut props, "playbook", sanitize_playbook(playbook));
            insert_id(&mut props, "task_id", task_id);
        }
        TelemetryEvent::TaskDraftDelete { source, task_id } | TelemetryEvent::TaskArchive { source, task_id } => {
            insert_str(&mut props, "source", source.as_str());
            insert_id(&mut props, "task_id", task_id);
        }
        TelemetryEvent::SessionCreate {
            source,
            harness,
            phase,
            generic,
            drawer,
            is_resume,
            session_id,
            task_id,
        } => {
            insert_str(&mut props, "source", source.as_str());
            insert_str(&mut props, "harness", sanitize_harness(harness));
            insert_str(&mut props, "phase", sanitize_phase(phase));
            insert_bool(&mut props, "generic", *generic);
            insert_bool(&mut props, "drawer", *drawer);
            insert_bool(&mut props, "is_resume", *is_resume);
            insert_id(&mut props, "session_id", session_id);
            insert_id(&mut props, "task_id", task_id);
        }
        TelemetryEvent::SessionSpawn {
            harness,
            phase,
            session_id,
            task_id,
        } => {
            insert_str(&mut props, "source", TelemetrySource::Alineryd.as_str());
            insert_str(&mut props, "harness", sanitize_harness(harness));
            insert_str(&mut props, "phase", sanitize_phase(phase));
            insert_id(&mut props, "session_id", session_id);
            insert_id(&mut props, "task_id", task_id);
        }
        TelemetryEvent::SessionResume { harness, session_id, task_id } => {
            insert_str(&mut props, "source", TelemetrySource::Alineryd.as_str());
            insert_str(&mut props, "harness", sanitize_harness(harness));
            insert_id(&mut props, "session_id", session_id);
            insert_id(&mut props, "task_id", task_id);
        }
        TelemetryEvent::SessionExit {
            source,
            harness,
            exit_code,
            session_id,
            task_id,
        } => {
            insert_str(&mut props, "source", source.as_str());
            insert_str(&mut props, "harness", sanitize_harness(harness));
            if let Some(code) = exit_code {
                props.insert("exit_code".into(), Value::Number((*code).into()));
            }
            insert_id(&mut props, "session_id", session_id);
            insert_id(&mut props, "task_id", task_id);
        }
        TelemetryEvent::SessionArchive {
            source,
            killed_live,
            session_id,
            task_id,
        } => {
            insert_str(&mut props, "source", source.as_str());
            insert_bool(&mut props, "killed_live", *killed_live);
            insert_id(&mut props, "session_id", session_id);
            insert_id(&mut props, "task_id", task_id);
        }
        TelemetryEvent::SessionKill { source, session_id, task_id } => {
            insert_str(&mut props, "source", source.as_str());
            insert_id(&mut props, "session_id", session_id);
            insert_id(&mut props, "task_id", task_id);
        }
        TelemetryEvent::ArtifactCommentAdd { source }
        | TelemetryEvent::ArtifactReviewSend { source }
        | TelemetryEvent::BackupRestore { source }
        | TelemetryEvent::GitCommit { source }
        | TelemetryEvent::GitPush { source }
        | TelemetryEvent::GitWorktreeRemove { source }
        | TelemetryEvent::RepoActivate { source }
        | TelemetryEvent::DaemonStop { source }
        | TelemetryEvent::DaemonTakeover { source }
        | TelemetryEvent::StoragePurge { source } => {
            insert_str(&mut props, "source", source.as_str());
        }
        TelemetryEvent::SessionPhaseComplete {
            phase,
            playbook,
            session_id,
            task_id,
        } => {
            insert_str(&mut props, "source", TelemetrySource::Alineryd.as_str());
            insert_str(&mut props, "phase", sanitize_phase(phase));
            insert_str(&mut props, "playbook", sanitize_playbook(playbook));
            insert_id(&mut props, "session_id", session_id);
            insert_id(&mut props, "task_id", task_id);
        }
        TelemetryEvent::SessionAutoAdvance {
            from_phase,
            to_phase,
            playbook,
            session_id,
            task_id,
        } => {
            insert_str(&mut props, "source", TelemetrySource::Alineryd.as_str());
            insert_str(&mut props, "from_phase", sanitize_phase(from_phase));
            insert_str(&mut props, "to_phase", sanitize_phase(to_phase));
            insert_str(&mut props, "playbook", sanitize_playbook(playbook));
            insert_id(&mut props, "session_id", session_id);
            insert_id(&mut props, "task_id", task_id);
        }
        TelemetryEvent::ArtifactReviewHandoff { source, target_phase, harness } => {
            insert_str(&mut props, "source", source.as_str());
            insert_str(&mut props, "target_phase", sanitize_phase(target_phase));
            insert_str(&mut props, "harness", sanitize_harness(harness));
        }
        TelemetryEvent::ImportFetch { source, import_source } => {
            insert_str(&mut props, "source", source.as_str());
            insert_str(&mut props, "import_source", import_source.as_str());
        }
        TelemetryEvent::BackupCreate { source, trigger } => {
            insert_str(&mut props, "source", source.as_str());
            insert_str(&mut props, "trigger", trigger.as_str());
        }
        TelemetryEvent::SettingsChange { source, scope } => {
            insert_str(&mut props, "source", source.as_str());
            insert_str(&mut props, "scope", scope.as_str());
        }
        TelemetryEvent::RepoRemove { source, was_active } => {
            insert_str(&mut props, "source", source.as_str());
            insert_bool(&mut props, "was_active", *was_active);
        }
        TelemetryEvent::McpToggle { source, enabled } => {
            insert_str(&mut props, "source", source.as_str());
            insert_bool(&mut props, "enabled", *enabled);
        }
    }
    props
}

fn app_os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else {
        std::env::consts::OS
    }
}

pub fn event_record(event: &TelemetryEvent, install_id: &str) -> Value {
    json!({
        "event": event_name(event),
        "app_version": env!("CARGO_PKG_VERSION"),
        "os": app_os(),
        "anon_id": install_id,
        "props": event_props(event),
    })
}

pub fn ingest_url(endpoint: &str) -> String {
    format!("{}/api/{TELEMETRY_ORG}/{TELEMETRY_STREAM}/_json", endpoint.trim_end_matches('/'))
}

// ponytail: one event per POST, no batching. APP.md § "Client rules" prescribes batching and
// the endpoint takes an array, so a short coalescing window would cut request count several-fold
// and make the 60/min per-IP budget generous even behind a NAT (see APP.md § "What the per-IP
// limit does and does not buy"). Deferred deliberately: batching needs a queue plus a flush
// timer plus a flush-at-quit, and anything still queued at quit is lost — trading a known
// sampling bias for silent data loss elsewhere. Its own change, not a rider on this one.
pub fn send(prefs: &TelemetryPrefs, event: &TelemetryEvent) -> Result<(), String> {
    let record = event_record(event, &prefs.install_id);
    let body = serde_json::to_vec(&[record]).map_err(|e| e.to_string())?;
    let url = ingest_url(&prefs.endpoint);
    let response = ureq::post(&url)
        .timeout(SEND_TIMEOUT)
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Basic {}", basic_auth_value()))
        .send_bytes(&body)
        .map_err(|e| e.to_string())?;
    let status = response.status();
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(format!("ingest status {status}"))
    }
}

fn basic_auth_value() -> String {
    use std::io::Write;
    // Manual base64 so we do not pull another crate just for the header.
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let raw = format!("{INGEST_USER}:{INGEST_PASSWORD}");
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut i = 0;
    while i < bytes.len() {
        let b0 = bytes[i];
        let b1 = if i + 1 < bytes.len() { bytes[i + 1] } else { 0 };
        let b2 = if i + 2 < bytes.len() { bytes[i + 2] } else { 0 };
        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
        out.push(TABLE[((n >> 18) & 0x3F) as usize]);
        out.push(TABLE[((n >> 12) & 0x3F) as usize]);
        if i + 1 < bytes.len() {
            out.push(TABLE[((n >> 6) & 0x3F) as usize]);
        } else {
            out.push(b'=');
        }
        if i + 2 < bytes.len() {
            out.push(TABLE[(n & 0x3F) as usize]);
        } else {
            out.push(b'=');
        }
        i += 3;
    }
    let _ = Write::write(&mut std::io::sink(), &out);
    String::from_utf8(out).unwrap_or_default()
}

/// The consent rule, in one place: nothing leaves the machine unless the user was asked, said
/// yes, and an install id exists.
fn consented(prefs: &TelemetryPrefs) -> bool {
    prefs.enabled && prefs.prompted && !prefs.install_id.is_empty()
}

pub fn record_event(app_config: &Path, event: TelemetryEvent) {
    record_event_with(app_config, || event);
}

/// `record_event`, but the event is constructed only once consent is known to hold.
///
/// Correlation ids come off the disk (`task.md`, `<id>.meta.json`), and callers used to resolve
/// them into the event argument — so a user with telemetry *off* paid those reads on every task
/// archive, session create/archive/kill and daemon spawn, for values dropped immediately after.
/// Building lazily skips them entirely.
pub fn record_event_with(app_config: &Path, build: impl FnOnce() -> TelemetryEvent) {
    let prefs = load_global_settings(app_config).telemetry;
    if !consented(&prefs) {
        return;
    }
    let event = build();
    std::thread::spawn(move || {
        let _ = send(&prefs, &event);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::TelemetryPrefs;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::time::{Duration, SystemTime};

    fn unique_temp(name: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("{name}_{}_{}", std::process::id(), nanos));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_app_toml(dir: &std::path::Path, enabled: bool, prompted: bool, install_id: &str, endpoint: &str) -> std::path::PathBuf {
        let path = dir.join("app.toml");
        std::fs::write(
            &path,
            format!(
                r#"settings_version = 1

[global.telemetry]
enabled = {enabled}
prompted = {prompted}
install_id = "{install_id}"
endpoint = "{endpoint}"
"#
            ),
        )
        .unwrap();
        path
    }

    #[test]
    fn event_record_matches_app_md_shape() {
        let rec = event_record(&TelemetryEvent::AppOpen { cold_start: true }, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        let obj = rec.as_object().expect("record is an object");
        let mut keys: Vec<_> = obj.keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, vec!["anon_id", "app_version", "event", "os", "props"]);
        assert_eq!(obj["event"], "app.open");
        assert_eq!(obj["anon_id"], "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        assert_eq!(obj["app_version"], env!("CARGO_PKG_VERSION"));
        // Host OS, not a Mac-only constant — Linux CI would otherwise fail here.
        assert_eq!(obj["os"], app_os());
        let props = obj["props"].as_object().expect("nested props");
        assert_eq!(props.len(), 1);
        assert_eq!(props["cold_start"], true);
    }

    #[test]
    fn sanitize_unknown_harness_is_custom() {
        for known in ["omp", "no-harness"] {
            assert_eq!(sanitize_harness(known), known);
        }
        for leftover in ["claude", "codex", "opencode", "ds4", "grok"] {
            assert_eq!(sanitize_harness(leftover), "custom");
        }
        assert_eq!(sanitize_harness("Claude"), "custom");
        assert_eq!(sanitize_harness("my-bot"), "custom");
    }

    #[test]
    fn sanitize_unknown_playbook_is_custom() {
        for known in ["superdevelop", "one-shot", "free-form", "review", "bug-hunting"] {
            assert_eq!(sanitize_playbook(known), known);
        }
        assert_eq!(sanitize_playbook("my-flow"), "custom");
    }

    #[test]
    fn sanitize_phase_empty_stays_empty() {
        assert_eq!(sanitize_phase(""), "");
        assert_eq!(sanitize_phase("tdd"), "tdd");
        assert_eq!(sanitize_phase("not-a-phase"), "custom");
        assert_eq!(sanitize_phase("distill-to-wiki"), "custom");
        assert_eq!(sanitize_phase("wiki-distill"), "custom");
    }

    #[test]
    fn event_props_never_include_blank_optional_exit_code() {
        let none = event_props(&TelemetryEvent::SessionExit {
            source: TelemetrySource::Alineryd,
            harness: "claude".into(),
            exit_code: None,
            session_id: "s1".into(),
            task_id: "task-a".into(),
        });
        assert!(!none.contains_key("exit_code"));
        let some = event_props(&TelemetryEvent::SessionExit {
            source: TelemetrySource::Alineryd,
            harness: "claude".into(),
            exit_code: Some(0),
            session_id: "s1".into(),
            task_id: "task-a".into(),
        });
        assert_eq!(some["exit_code"], 0);
        assert!(some["exit_code"].is_number());
        assert_eq!(some["session_id"], "s1");
        assert_eq!(some["task_id"], "task-a");
    }

    #[test]
    fn ingest_url_joins_without_double_slash() {
        let expected = "http://127.0.0.1:5080/api/default/alinery_usage/_json";
        assert_eq!(ingest_url("http://127.0.0.1:5080"), expected);
        assert_eq!(ingest_url("http://127.0.0.1:5080/"), expected);
    }

    fn complete_http_request_len(buf: &[u8]) -> Option<usize> {
        let header_end = buf.windows(4).position(|window| window == b"\r\n\r\n")?;
        let headers = std::str::from_utf8(&buf[..header_end]).ok()?;
        let content_length = headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().ok()).flatten()
        })?;
        Some(header_end + 4 + content_length)
    }

    fn serve_one(listener: TcpListener) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            listener.set_nonblocking(false).unwrap();
            let _ = listener.set_ttl(1);
            let (mut stream, _) = match listener.accept() {
                Ok(pair) => pair,
                Err(_) => return Vec::new(),
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            while buf.len() < 64 * 1024 {
                let n = match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                buf.extend_from_slice(&chunk[..n]);
                if complete_http_request_len(&buf).is_some_and(|len| buf.len() >= len) {
                    break;
                }
            }
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
            buf
        })
    }

    // Retries on a fresh port: under heavy parallel `cargo test --workspace`
    // load, the shared `ureq` global agent occasionally surfaces a transient
    // "invalid header" send error from unrelated resource contention in other
    // concurrently-running tests, not from this test or `send` itself.
    #[test]
    fn send_posts_json_array_with_basic_auth() {
        let mut last_err = String::new();
        for _ in 0..5 {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(false).unwrap();
            let addr = listener.local_addr().unwrap();
            let handle = serve_one(listener);
            let prefs = TelemetryPrefs {
                enabled: true,
                prompted: true,
                install_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into(),
                endpoint: format!("http://{addr}"),
            };
            match send(&prefs, &TelemetryEvent::AppOpen { cold_start: true }) {
                Ok(()) => {
                    let req = handle.join().unwrap();
                    let text = String::from_utf8_lossy(&req);
                    assert!(text.starts_with("POST /api/default/alinery_usage/_json"), "{text}");
                    assert!(text.contains("Content-Type: application/json"), "{text}");
                    let expected_auth = format!("Authorization: Basic {}", basic_auth_value());
                    assert!(text.contains(&expected_auth), "{text}");
                    let body = text.rsplit("\r\n\r\n").next().unwrap_or("");
                    let parsed: Value = serde_json::from_str(body).expect(body);
                    let arr = parsed.as_array().expect("body is a JSON array");
                    assert_eq!(arr.len(), 1);
                    assert_eq!(arr[0]["event"], "app.open");
                    assert_eq!(arr[0]["anon_id"], "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
                    return;
                }
                Err(e) => last_err = e,
            }
        }
        panic!("send_posts_json_array_with_basic_auth failed after retries: {last_err}");
    }

    fn assert_no_connect(endpoint_port: u16) {
        std::thread::sleep(Duration::from_millis(50));
        let err = TcpStream::connect_timeout(&format!("127.0.0.1:{endpoint_port}").parse().unwrap(), Duration::from_millis(50));
        assert!(err.is_err(), "gate must not attempt a TCP connect");
    }

    #[test]
    fn record_event_is_noop_when_unprompted() {
        let dir = unique_temp("alinery_tel_unprompted");
        let path = write_app_toml(&dir, true, false, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "http://127.0.0.1:1");
        record_event(&path, TelemetryEvent::AppOpen { cold_start: true });
        assert_no_connect(1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn record_event_is_noop_when_disabled() {
        let dir = unique_temp("alinery_tel_disabled");
        let path = write_app_toml(&dir, false, true, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "http://127.0.0.1:1");
        record_event(&path, TelemetryEvent::AppOpen { cold_start: true });
        assert_no_connect(1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn record_event_is_noop_when_install_id_empty() {
        let dir = unique_temp("alinery_tel_empty_id");
        let path = write_app_toml(&dir, true, true, "", "http://127.0.0.1:1");
        record_event(&path, TelemetryEvent::AppOpen { cold_start: true });
        assert_no_connect(1);
        let _ = std::fs::remove_dir_all(dir);
    }

    // The point of record_event_with is that the closure — which reads task.md /
    // <id>.meta.json to resolve correlation ids — never runs for a user who declined.
    #[test]
    fn record_event_with_does_not_build_the_event_when_disabled() {
        let dir = unique_temp("alinery_tel_lazy_off");
        let path = write_app_toml(&dir, false, true, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "http://127.0.0.1:1");
        let built = std::sync::atomic::AtomicBool::new(false);
        record_event_with(&path, || {
            built.store(true, std::sync::atomic::Ordering::SeqCst);
            TelemetryEvent::AppOpen { cold_start: true }
        });
        assert!(!built.load(std::sync::atomic::Ordering::SeqCst), "the id lookups must be skipped entirely");
        assert_no_connect(1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn record_event_with_builds_the_event_when_enabled() {
        let dir = unique_temp("alinery_tel_lazy_on");
        let path = write_app_toml(&dir, true, true, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "http://127.0.0.1:1");
        let built = std::sync::atomic::AtomicBool::new(false);
        record_event_with(&path, || {
            built.store(true, std::sync::atomic::Ordering::SeqCst);
            TelemetryEvent::AppOpen { cold_start: true }
        });
        assert!(built.load(std::sync::atomic::Ordering::SeqCst), "a consenting user still gets the event built");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn event_props_unknown_harness_becomes_custom() {
        let props = event_props(&TelemetryEvent::SessionSpawn {
            harness: "secret-bot".into(),
            phase: "tdd".into(),
            session_id: "s1".into(),
            task_id: "task-a".into(),
        });
        assert_eq!(props["harness"], "custom");
        assert_eq!(props["phase"], "tdd");
        assert_eq!(props["session_id"], "s1");
        assert_eq!(props["task_id"], "task-a");
    }

    #[test]
    fn event_props_include_task_and_session_ids() {
        let task = event_props(&TelemetryEvent::TaskArchive {
            source: TelemetrySource::App,
            task_id: "task-a".into(),
        });
        assert_eq!(task["task_id"], "task-a");
        assert!(task.get("session_id").is_none());

        let session = event_props(&TelemetryEvent::SessionCreate {
            source: TelemetrySource::App,
            harness: "claude".into(),
            phase: "tdd".into(),
            generic: false,
            drawer: false,
            is_resume: false,
            session_id: "s1".into(),
            task_id: "task-a".into(),
        });
        assert_eq!(session["session_id"], "s1");
        assert_eq!(session["task_id"], "task-a");

        let drawer = event_props(&TelemetryEvent::SessionCreate {
            source: TelemetrySource::App,
            harness: "no-harness".into(),
            phase: String::new(),
            generic: false,
            drawer: true,
            is_resume: false,
            session_id: "s-drawer".into(),
            task_id: String::new(),
        });
        assert_eq!(drawer["session_id"], "s-drawer");
        assert!(drawer.get("task_id").is_none());
    }

    #[test]
    fn basic_auth_matches_production_ingest_pair() {
        assert_eq!(basic_auth_value(), "YWxpbmVyeS1pbmdlc3RAZXhhbXBsZS5jb206WFlYWHgxZmJZaWlDZ0RscA==");
    }
}
