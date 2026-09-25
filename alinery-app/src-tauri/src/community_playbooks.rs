//! Community playbook catalog, import registry, and publish.
//!
//! Accounts HTTP is injected. Production uses `curl_http_method`. Tests must not
//! open a socket to the accounts host.
use crate::*;
use alinery_core::playbook::{parse_playbook_md, PlaybookRef, PlaybookScope, PlaybookValidationError};
use alinery_core::playbook_library::{self as library, PlaybookRoots, PlaybookSaveError, SavePlaybookRequest};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const UNAVAILABLE: &str = "Playbook library is unavailable.";
const UNREACHABLE: &str = "Could not reach the playbook library.";
const SERVICE_ROLE_KEY: &str = "SUPABASE_SERVICE_ROLE_KEY";

pub(crate) struct CommunityHttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<String>,
    pub body: Option<String>,
}

pub(crate) struct CommunityHttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

pub(crate) trait CommunityHttp {
    fn exchange(&mut self, request: CommunityHttpRequest) -> Result<CommunityHttpResponse, String>;
}

struct CurlCommunityHttp;

impl CommunityHttp for CurlCommunityHttp {
    fn exchange(&mut self, request: CommunityHttpRequest) -> Result<CommunityHttpResponse, String> {
        let response = curl_http_method(&request.url, &request.method, &request.headers, request.body.as_deref())?;
        Ok(CommunityHttpResponse {
            status: response.status,
            body: response.body,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CommunitySummary {
    pub id: String,
    pub label: String,
    #[serde(rename = "playbookKey", alias = "playbook_key")]
    pub playbook_key: String,
    pub title: String,
    pub description: String,
    #[serde(rename = "defaultHarness", alias = "default_harness")]
    pub default_harness: String,
    #[serde(rename = "hasCodingStep", alias = "has_coding_step")]
    pub has_coding_step: bool,
    #[serde(rename = "stepCount", alias = "step_count")]
    pub step_count: u64,
    pub version: u64,
    #[serde(rename = "bodySha256", alias = "body_sha256")]
    pub body_sha256: String,
    #[serde(rename = "publishedAt", alias = "published_at")]
    pub published_at: String,
    #[serde(rename = "updatedAt", alias = "updated_at")]
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommunityList {
    pub playbooks: Vec<CommunitySummary>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CommunityImportRecord {
    pub id: String,
    pub label: String,
    pub playbook_key: String,
    pub local_scope: String,
    pub local_key: String,
    pub imported_version: u64,
    pub local_sha256: String,
    pub imported_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommunityImportRow {
    pub id: String,
    pub label: String,
    pub playbook_key: String,
    pub local_key: String,
    pub imported_version: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommunityImportList {
    pub imports: Vec<CommunityImportRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadStatusRow {
    pub id: String,
    pub label: String,
    pub playbook_key: String,
    pub local_key: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub imported_version: u64,
    pub remote_version: Option<u64>,
    pub update_available: bool,
    pub remote_missing: bool,
    pub local_missing: bool,
    pub locally_edited: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadStatusList {
    pub rows: Vec<DownloadStatusRow>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportFile {
    #[serde(default)]
    import: Vec<CommunityImportRecord>,
}

pub(crate) fn registry_path(repo_dir: &Path) -> PathBuf {
    repo_dir.join(".alinery/playbooks/community-imports.toml")
}

fn browse_headers() -> Vec<String> {
    vec!["Accept: application/json".into(), "Content-Type: application/json".into()]
}

fn body_names_service_role(body: &[u8]) -> bool {
    body.windows(SERVICE_ROLE_KEY.len()).any(|window| window == SERVICE_ROLE_KEY.as_bytes())
}

fn library_failure_message(status: u16, body: &[u8]) -> String {
    if status == 503 || body_names_service_role(body) {
        return UNAVAILABLE.into();
    }
    let parsed = serde_json::from_slice::<Value>(body).ok();
    if let Some(error) = parsed.as_ref().and_then(|value| value.get("error")).and_then(|error| error.as_str()) {
        if error.contains(SERVICE_ROLE_KEY) {
            return UNAVAILABLE.into();
        }
        if !error.is_empty() {
            return error.to_string();
        }
    }
    UNREACHABLE.into()
}

fn list_url(base: &str, q: Option<&str>, cursor: Option<&str>) -> Result<String, String> {
    let mut pairs = Vec::new();
    if let Some(raw) = q {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            if trimmed.chars().count() > 80 {
                return Err("Invalid query.".into());
            }
            pairs.push(format!("q={}", percent_encode(trimmed)));
        }
    }
    if let Some(raw) = cursor {
        if !raw.is_empty() {
            pairs.push(format!("cursor={}", percent_encode(raw)));
        }
    }
    let path = format!("{}/api/desktop/playbooks", base.trim_end_matches('/'));
    if pairs.is_empty() {
        Ok(path)
    } else {
        Ok(format!("{path}?{}", pairs.join("&")))
    }
}

fn parse_list(body: &[u8]) -> Result<CommunityList, String> {
    let value: Value = serde_json::from_slice(body).map_err(|_| UNREACHABLE.to_string())?;
    if value.get("ok").and_then(|ok| ok.as_bool()) != Some(true) {
        return Err(library_failure_message(200, body));
    }
    let playbooks = value.get("playbooks").cloned().ok_or_else(|| UNREACHABLE.to_string())?;
    let playbooks: Vec<CommunitySummary> = serde_json::from_value(playbooks).map_err(|_| UNREACHABLE.to_string())?;
    let next_cursor = match value.get("next_cursor") {
        Some(Value::Null) => None,
        Some(Value::String(cursor)) => Some(cursor.clone()),
        _ => return Err(UNREACHABLE.to_string()),
    };
    Ok(CommunityList { playbooks, next_cursor })
}

pub(crate) fn list_community_playbooks_with(http: &mut dyn CommunityHttp, base: &str, q: Option<&str>, cursor: Option<&str>) -> Result<CommunityList, String> {
    let url = list_url(base, q, cursor)?;
    let response = http.exchange(CommunityHttpRequest {
        method: "GET".into(),
        url,
        headers: browse_headers(),
        body: None,
    })?;
    if response.status == 503 || body_names_service_role(&response.body) {
        return Err(UNAVAILABLE.into());
    }
    // Browse ignores auth. A 401 must not become the sign-in sentence.
    if response.status == 401 {
        return Err(UNREACHABLE.into());
    }
    if response.status != 200 {
        return Err(library_failure_message(response.status, &response.body));
    }
    parse_list(&response.body)
}

pub(crate) fn read_community_imports(repo_dir: &Path) -> Result<Vec<CommunityImportRecord>, String> {
    let path = registry_path(repo_dir);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let text = String::from_utf8(bytes).map_err(|_| format!("invalid {}", path.display()))?;
    let file: ImportFile = toml::from_str(&text).map_err(|_| format!("invalid {}", path.display()))?;
    Ok(file.import)
}

pub(crate) fn write_community_imports(repo_dir: &Path, records: &[CommunityImportRecord]) -> Result<(), String> {
    let path = registry_path(repo_dir);
    let file = ImportFile { import: records.to_vec() };
    let text = toml::to_string(&file).map_err(|error| error.to_string())?;
    write_bytes_atomic(&path, text.as_bytes())
}

pub(crate) fn forget_repo_import(roots: &PlaybookRoots, key: &str) -> Result<(), String> {
    let path = registry_path(&roots.repo_dir);
    if !path.exists() {
        return Ok(());
    }
    let mut records = read_community_imports(&roots.repo_dir)?;
    let before = records.len();
    records.retain(|record| record.local_key != key);
    if records.len() == before {
        return Ok(());
    }
    write_community_imports(&roots.repo_dir, &records)
}

fn publication_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let groups = [8usize, 4, 4, 4, 12];
    let mut index = 0;
    for (group, length) in groups.iter().enumerate() {
        if group > 0 {
            if bytes.get(index) != Some(&b'-') {
                return false;
            }
            index += 1;
        }
        for _ in 0..*length {
            let byte = match bytes.get(index) {
                Some(byte) => *byte,
                None => return false,
            };
            if !byte.is_ascii_digit() && !matches!(byte, b'a'..=b'f') {
                return false;
            }
            index += 1;
        }
    }
    index == bytes.len()
}

fn sha256_bytes(bytes: &[u8]) -> Result<String, String> {
    let mut child = Command::new("/usr/bin/openssl")
        .args(["dgst", "-sha256"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    child.stdin.as_mut().ok_or("openssl stdin")?.write_all(bytes).map_err(|error| error.to_string())?;
    drop(child.stdin.take());
    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("openssl dgst failed".into());
    }
    let hash = String::from_utf8_lossy(&output.stdout).split_whitespace().last().unwrap_or_default().to_lowercase();
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("openssl dgst output".into());
    }
    Ok(hash)
}

fn local_playbook_path(repo_dir: &Path, key: &str) -> PathBuf {
    repo_dir.join(".alinery/playbooks").join(key).join("playbook.md")
}

fn parse_summary(body: &[u8]) -> Result<CommunitySummary, String> {
    let value: Value = serde_json::from_slice(body).map_err(|_| UNREACHABLE.to_string())?;
    if value.get("ok").and_then(|ok| ok.as_bool()) != Some(true) {
        return Err(library_failure_message(200, body));
    }
    serde_json::from_value(value).map_err(|_| UNREACHABLE.to_string())
}

fn status_row(http: &mut dyn CommunityHttp, base: &str, repo_dir: &Path, record: &CommunityImportRecord) -> DownloadStatusRow {
    let path = local_playbook_path(repo_dir, &record.local_key);
    let local_missing = !path.is_file();
    let locally_edited = if local_missing {
        false
    } else {
        match fs::read(&path).ok().and_then(|bytes| sha256_bytes(&bytes).ok()) {
            Some(hash) => hash != record.local_sha256,
            None => true,
        }
    };
    let mut row = DownloadStatusRow {
        id: record.id.clone(),
        label: record.label.clone(),
        playbook_key: record.playbook_key.clone(),
        local_key: record.local_key.clone(),
        title: None,
        description: None,
        imported_version: record.imported_version,
        remote_version: None,
        update_available: false,
        remote_missing: false,
        local_missing,
        locally_edited,
        error: None,
    };
    if !publication_id(&record.id) {
        row.error = Some("Playbook not found.".into());
        return row;
    }
    let url = format!("{}/api/desktop/playbooks/{}", base.trim_end_matches('/'), record.id);
    let response = match http.exchange(CommunityHttpRequest {
        method: "GET".into(),
        url,
        headers: browse_headers(),
        body: None,
    }) {
        Ok(response) => response,
        Err(error) => {
            row.error = Some(if error.contains(SERVICE_ROLE_KEY) { UNAVAILABLE.into() } else { UNREACHABLE.into() });
            return row;
        }
    };
    if response.status == 404 {
        row.remote_missing = true;
        return row;
    }
    if response.status == 503 || body_names_service_role(&response.body) {
        row.error = Some(UNAVAILABLE.into());
        return row;
    }
    if response.status == 401 {
        row.error = Some(UNREACHABLE.into());
        return row;
    }
    if response.status != 200 {
        row.error = Some(library_failure_message(response.status, &response.body));
        return row;
    }
    match parse_summary(&response.body) {
        Ok(summary) => {
            row.title = Some(summary.title);
            row.description = Some(summary.description);
            row.remote_version = Some(summary.version);
            row.update_available = summary.version > record.imported_version;
        }
        Err(error) => row.error = Some(error),
    }
    row
}

pub(crate) fn community_download_status_with(http: &mut dyn CommunityHttp, base: &str, repo_dir: &Path) -> Result<Vec<DownloadStatusRow>, String> {
    let records = read_community_imports(repo_dir)?;
    Ok(records.into_iter().map(|record| status_row(http, base, repo_dir, &record)).collect())
}

fn owned_repo(app: &AppHandle, repo_path: &str) -> Result<PlaybookRoots, String> {
    let roots = library_roots(app, Some(repo_path))?;
    if roots.repo_dir.as_os_str().is_empty() {
        return Err("select a repository before saving a repo playbook".into());
    }
    require_repo_owned(&app.state::<AppState>(), &roots.repo_dir)?;
    Ok(roots)
}

#[tauri::command]
pub(crate) async fn list_community_playbooks(q: Option<String>, cursor: Option<String>) -> Result<CommunityList, String> {
    let base = accounts_url();
    tauri::async_runtime::spawn_blocking(move || {
        let mut http = CurlCommunityHttp;
        list_community_playbooks_with(&mut http, &base, q.as_deref(), cursor.as_deref())
    })
    .await
    .map_err(|_| UNREACHABLE.to_string())?
}

#[tauri::command]
pub(crate) fn list_community_imports(app: AppHandle, repo_path: String) -> Result<CommunityImportList, String> {
    let roots = owned_repo(&app, &repo_path)?;
    let imports = read_community_imports(&roots.repo_dir)?
        .into_iter()
        .map(|record| CommunityImportRow {
            id: record.id,
            label: record.label,
            playbook_key: record.playbook_key,
            local_key: record.local_key,
            imported_version: record.imported_version,
        })
        .collect();
    Ok(CommunityImportList { imports })
}

#[tauri::command]
pub(crate) async fn community_download_status(app: AppHandle, repo_path: String) -> Result<DownloadStatusList, String> {
    let roots = owned_repo(&app, &repo_path)?;
    let base = accounts_url();
    let repo_dir = roots.repo_dir;
    let rows = tauri::async_runtime::spawn_blocking(move || {
        let mut http = CurlCommunityHttp;
        community_download_status_with(&mut http, &base, &repo_dir)
    })
    .await
    .map_err(|_| UNREACHABLE.to_string())??;
    Ok(DownloadStatusList { rows })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum ImportResult {
    Saved {
        reference: PlaybookRef,
        #[serde(rename = "importedVersion")]
        imported_version: u64,
        #[serde(rename = "localSha256")]
        local_sha256: String,
    },
    NeedsAccount,
    Conflict {
        #[serde(rename = "localKey")]
        local_key: String,
    },
    AlreadyDownloaded,
    Invalid {
        diagnostics: Vec<PlaybookValidationError>,
    },
    Failed {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum UpdateResult {
    Saved {
        reference: PlaybookRef,
        #[serde(rename = "importedVersion")]
        imported_version: u64,
        #[serde(rename = "localSha256")]
        local_sha256: String,
    },
    NeedsAccount,
    Edited,
    Invalid {
        diagnostics: Vec<PlaybookValidationError>,
    },
    Failed {
        message: String,
    },
}

struct SourceDetail {
    document: String,
    version: u64,
    label: String,
    playbook_key: String,
}

fn format_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let hour = tod / 3600;
    let minute = (tod % 3600) / 60;
    let second = tod % 60;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn utc_now() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_secs()).unwrap_or(0);
    format_utc(secs)
}

fn safe_transport(error: &str) -> String {
    if error.contains(SERVICE_ROLE_KEY) {
        UNAVAILABLE.into()
    } else {
        UNREACHABLE.into()
    }
}

fn authed_exchange<R>(http: &mut dyn CommunityHttp, auth_path: &Path, refresh: R, method: &str, url: String, body: Option<String>) -> Result<CommunityHttpResponse, AuthRetryError>
where
    R: FnOnce(&str) -> Result<String, AccountAuthError>,
{
    let method = method.to_string();
    with_access_token_retry(
        auth_path,
        |token| match http.exchange(CommunityHttpRequest {
            method: method.clone(),
            url: url.clone(),
            headers: vec![
                "Accept: application/json".into(),
                "Content-Type: application/json".into(),
                format!("Authorization: Bearer {token}"),
            ],
            body: body.clone(),
        }) {
            Ok(response) if response.status == 401 => AuthAttempt::Unauthorized,
            Ok(response) => AuthAttempt::Response(response),
            Err(error) => AuthAttempt::Transport(error),
        },
        refresh,
    )
}

fn parse_source(body: &[u8]) -> Result<SourceDetail, String> {
    let value: Value = serde_json::from_slice(body).map_err(|_| UNREACHABLE.to_string())?;
    if value.get("ok").and_then(|ok| ok.as_bool()) != Some(true) {
        return Err(library_failure_message(200, body));
    }
    let document = value.get("body").and_then(|item| item.as_str()).ok_or_else(|| UNREACHABLE.to_string())?.to_string();
    let version = value
        .get("version")
        .and_then(|version| version.as_u64())
        .filter(|version| *version >= 1)
        .ok_or_else(|| UNREACHABLE.to_string())?;
    let label = value.get("label").and_then(|label| label.as_str()).unwrap_or("").to_string();
    let playbook_key = value.get("playbook_key").and_then(|key| key.as_str()).unwrap_or("").to_string();
    Ok(SourceDetail {
        document,
        version,
        label,
        playbook_key,
    })
}

fn download_source<R>(http: &mut dyn CommunityHttp, base: &str, auth_path: &Path, refresh: R, id: &str) -> Result<SourceDetail, Result<String, AuthRetryError>>
where
    R: FnOnce(&str) -> Result<String, AccountAuthError>,
{
    let url = format!("{}/api/desktop/playbooks/{id}/source", base.trim_end_matches('/'));
    let response = authed_exchange(http, auth_path, refresh, "GET", url, None).map_err(Err)?;
    if response.status == 503 || body_names_service_role(&response.body) {
        return Err(Ok(UNAVAILABLE.into()));
    }
    if response.status == 404 {
        return Err(Ok("Playbook not found.".into()));
    }
    if response.status != 200 {
        return Err(Ok(library_failure_message(response.status, &response.body)));
    }
    parse_source(&response.body).map_err(Ok)
}

fn record_import(repo_dir: &Path, record: CommunityImportRecord) -> Result<(), String> {
    let mut records = read_community_imports(repo_dir)?;
    records.retain(|existing| existing.id != record.id && existing.local_key != record.local_key);
    records.push(record);
    write_community_imports(repo_dir, &records)
}

fn restore_or_delete(roots: &PlaybookRoots, key: &str, previous: Option<Vec<u8>>) {
    let path = local_playbook_path(&roots.repo_dir, key);
    if let Some(bytes) = previous {
        let _ = write_bytes_atomic(&path, &bytes);
        return;
    }
    let _ = library::delete_playbook(
        roots,
        &PlaybookRef {
            scope: PlaybookScope::Repo,
            key: key.into(),
        },
    );
}

fn save_imported(roots: &PlaybookRoots, key: &str, document: &str, overwrite: bool) -> Result<library::ScopedPlaybook, ImportResult> {
    match library::save_playbook(
        roots,
        SavePlaybookRequest {
            target: PlaybookRef {
                scope: PlaybookScope::Repo,
                key: key.into(),
            },
            source: document.into(),
            overwrite,
        },
    ) {
        Ok(saved) => Ok(saved),
        Err(PlaybookSaveError::Invalid { diagnostics }) => Err(ImportResult::Invalid { diagnostics }),
        Err(PlaybookSaveError::Conflict { source }) => Err(ImportResult::Conflict { local_key: source.reference.key }),
        Err(PlaybookSaveError::Io { message }) => Err(ImportResult::Failed { message }),
        Err(PlaybookSaveError::ReadOnly { .. }) | Err(PlaybookSaveError::Unknown { .. }) => Err(ImportResult::Failed { message: UNREACHABLE.into() }),
    }
}

fn finish_import(roots: &PlaybookRoots, detail: &SourceDetail, key: &str, id: &str, saved_text: &str, previous: Option<Vec<u8>>) -> ImportResult {
    let local_sha256 = match sha256_bytes(saved_text.as_bytes()) {
        Ok(hash) => hash,
        Err(_) => {
            restore_or_delete(roots, key, previous);
            return ImportResult::Failed { message: UNREACHABLE.into() };
        }
    };
    let record = CommunityImportRecord {
        id: id.into(),
        label: detail.label.clone(),
        playbook_key: detail.playbook_key.clone(),
        local_scope: "repo".into(),
        local_key: key.into(),
        imported_version: detail.version,
        local_sha256: local_sha256.clone(),
        imported_at: utc_now(),
    };
    if let Err(message) = record_import(&roots.repo_dir, record) {
        restore_or_delete(roots, key, previous);
        return ImportResult::Failed {
            message: if message.contains(SERVICE_ROLE_KEY) { UNAVAILABLE.into() } else { message },
        };
    }
    ImportResult::Saved {
        reference: PlaybookRef {
            scope: PlaybookScope::Repo,
            key: key.into(),
        },
        imported_version: detail.version,
        local_sha256,
    }
}

pub(crate) fn import_community_playbook_with<R>(
    http: &mut dyn CommunityHttp,
    base: &str,
    auth_path: &Path,
    refresh: R,
    roots: &PlaybookRoots,
    id: &str,
    overwrite: bool,
) -> ImportResult
where
    R: FnOnce(&str) -> Result<String, AccountAuthError>,
{
    if !publication_id(id) {
        return ImportResult::Failed {
            message: "Playbook not found.".into(),
        };
    }
    if !access_token_present(auth_path) {
        return ImportResult::NeedsAccount;
    }
    if roots.repo_dir.as_os_str().is_empty() {
        return ImportResult::Failed {
            message: "select a repository before saving a repo playbook".into(),
        };
    }
    match read_community_imports(&roots.repo_dir) {
        Ok(records) if records.iter().any(|record| record.id == id) => return ImportResult::AlreadyDownloaded,
        Ok(_) => {}
        Err(message) => return ImportResult::Failed { message },
    }
    let detail = match download_source(http, base, auth_path, refresh, id) {
        Ok(detail) => detail,
        Err(Err(AuthRetryError::NeedsAccount)) => return ImportResult::NeedsAccount,
        Err(Err(AuthRetryError::Transport(message))) => {
            return ImportResult::Failed {
                message: safe_transport(&message),
            }
        }
        Err(Ok(message)) => return ImportResult::Failed { message },
    };
    let definition = match parse_playbook_md(&detail.document) {
        Ok(definition) => definition,
        Err(diagnostics) => return ImportResult::Invalid { diagnostics },
    };
    let key = definition.key;
    let path = local_playbook_path(&roots.repo_dir, &key);
    let previous = if path.is_file() { fs::read(&path).ok() } else { None };
    if previous.is_some() && !overwrite {
        return ImportResult::Conflict { local_key: key };
    }
    let saved = match save_imported(roots, &key, &detail.document, previous.is_some()) {
        Ok(saved) => saved,
        Err(result) => return result,
    };
    finish_import(roots, &detail, &key, id, &saved.source_text, previous)
}

pub(crate) fn update_community_import_with<R>(
    http: &mut dyn CommunityHttp,
    base: &str,
    auth_path: &Path,
    refresh: R,
    roots: &PlaybookRoots,
    id: &str,
    overwrite_edited: bool,
) -> UpdateResult
where
    R: FnOnce(&str) -> Result<String, AccountAuthError>,
{
    if !publication_id(id) {
        return UpdateResult::Failed {
            message: "Playbook not found.".into(),
        };
    }
    if !access_token_present(auth_path) {
        return UpdateResult::NeedsAccount;
    }
    if roots.repo_dir.as_os_str().is_empty() {
        return UpdateResult::Failed {
            message: "select a repository before saving a repo playbook".into(),
        };
    }
    let records = match read_community_imports(&roots.repo_dir) {
        Ok(records) => records,
        Err(message) => return UpdateResult::Failed { message },
    };
    let Some(record) = records.into_iter().find(|record| record.id == id) else {
        return UpdateResult::Failed {
            message: "Playbook not found.".into(),
        };
    };
    let path = local_playbook_path(&roots.repo_dir, &record.local_key);
    let previous = if path.is_file() {
        match fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) => return UpdateResult::Failed { message: error.to_string() },
        }
    } else {
        None
    };
    if let Some(bytes) = &previous {
        match sha256_bytes(bytes) {
            Ok(hash) if hash != record.local_sha256 && !overwrite_edited => return UpdateResult::Edited,
            Ok(_) => {}
            Err(_) => return UpdateResult::Failed { message: UNREACHABLE.into() },
        }
    }
    let detail = match download_source(http, base, auth_path, refresh, id) {
        Ok(detail) => detail,
        Err(Err(AuthRetryError::NeedsAccount)) => return UpdateResult::NeedsAccount,
        Err(Err(AuthRetryError::Transport(message))) => {
            return UpdateResult::Failed {
                message: safe_transport(&message),
            }
        }
        Err(Ok(message)) => return UpdateResult::Failed { message },
    };
    if let Err(diagnostics) = parse_playbook_md(&detail.document) {
        return UpdateResult::Invalid { diagnostics };
    }
    let saved = match save_imported(roots, &record.local_key, &detail.document, true) {
        Ok(saved) => saved,
        Err(ImportResult::Invalid { diagnostics }) => return UpdateResult::Invalid { diagnostics },
        Err(ImportResult::Failed { message }) => return UpdateResult::Failed { message },
        Err(_) => return UpdateResult::Failed { message: UNREACHABLE.into() },
    };
    match finish_import(roots, &detail, &record.local_key, id, &saved.source_text, previous) {
        ImportResult::Saved {
            reference,
            imported_version,
            local_sha256,
        } => UpdateResult::Saved {
            reference,
            imported_version,
            local_sha256,
        },
        ImportResult::Invalid { diagnostics } => UpdateResult::Invalid { diagnostics },
        ImportResult::Failed { message } => UpdateResult::Failed { message },
        ImportResult::NeedsAccount => UpdateResult::NeedsAccount,
        ImportResult::Conflict { .. } | ImportResult::AlreadyDownloaded => UpdateResult::Failed { message: UNREACHABLE.into() },
    }
}

pub(crate) fn delete_playbook_keeping_imports(roots: &PlaybookRoots, reference: &PlaybookRef) -> Result<(), PlaybookSaveError> {
    library::delete_playbook(roots, reference)?;
    if reference.scope == PlaybookScope::Repo {
        forget_repo_import(roots, &reference.key).map_err(|message| PlaybookSaveError::Io { message })?;
    }
    Ok(())
}

fn refresh_for(auth_path: PathBuf) -> impl FnOnce(&str) -> Result<String, AccountAuthError> {
    move |token| refresh_paired_access(&auth_path, token)
}

#[tauri::command]
pub(crate) async fn import_community_playbook(app: AppHandle, id: String, repo_path: String, overwrite: bool) -> ImportResult {
    let roots = match owned_repo(&app, &repo_path) {
        Ok(roots) => roots,
        Err(message) => return ImportResult::Failed { message },
    };
    let auth_path = match account_auth_path_for(&app) {
        Ok(path) => path,
        Err(message) => return ImportResult::Failed { message },
    };
    let base = accounts_url();
    tauri::async_runtime::spawn_blocking(move || {
        let mut http = CurlCommunityHttp;
        import_community_playbook_with(&mut http, &base, &auth_path, refresh_for(auth_path.clone()), &roots, &id, overwrite)
    })
    .await
    .unwrap_or(ImportResult::Failed { message: UNREACHABLE.into() })
}

#[tauri::command]
pub(crate) async fn update_community_import(app: AppHandle, id: String, repo_path: String, overwrite_edited: bool) -> UpdateResult {
    let roots = match owned_repo(&app, &repo_path) {
        Ok(roots) => roots,
        Err(message) => return UpdateResult::Failed { message },
    };
    let auth_path = match account_auth_path_for(&app) {
        Ok(path) => path,
        Err(message) => return UpdateResult::Failed { message },
    };
    let base = accounts_url();
    tauri::async_runtime::spawn_blocking(move || {
        let mut http = CurlCommunityHttp;
        update_community_import_with(&mut http, &base, &auth_path, refresh_for(auth_path.clone()), &roots, &id, overwrite_edited)
    })
    .await
    .unwrap_or(UpdateResult::Failed { message: UNREACHABLE.into() })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum PreviewResult {
    Loaded { source: String },
    NeedsAccount,
    Failed { message: String },
}

/// Read-only preview of a published document. No repo and no ownership: the body is
/// the only read that requires a bearer, and a signed-in caller may download any
/// publication. Nothing is written, so this never touches the import registry.
pub(crate) fn preview_community_playbook_with<R>(http: &mut dyn CommunityHttp, base: &str, auth_path: &Path, refresh: R, id: &str) -> PreviewResult
where
    R: FnOnce(&str) -> Result<String, AccountAuthError>,
{
    if !publication_id(id) {
        return PreviewResult::Failed {
            message: "Playbook not found.".into(),
        };
    }
    if !access_token_present(auth_path) {
        return PreviewResult::NeedsAccount;
    }
    match download_source(http, base, auth_path, refresh, id) {
        Ok(detail) => PreviewResult::Loaded { source: detail.document },
        Err(Err(AuthRetryError::NeedsAccount)) => PreviewResult::NeedsAccount,
        Err(Err(AuthRetryError::Transport(message))) => PreviewResult::Failed {
            message: safe_transport(&message),
        },
        Err(Ok(message)) => PreviewResult::Failed { message },
    }
}

#[tauri::command]
pub(crate) async fn preview_community_playbook(app: AppHandle, id: String) -> PreviewResult {
    let auth_path = match account_auth_path_for(&app) {
        Ok(path) => path,
        Err(message) => return PreviewResult::Failed { message },
    };
    let base = accounts_url();
    tauri::async_runtime::spawn_blocking(move || {
        let mut http = CurlCommunityHttp;
        preview_community_playbook_with(&mut http, &base, &auth_path, refresh_for(auth_path.clone()), &id)
    })
    .await
    .unwrap_or(PreviewResult::Failed { message: UNREACHABLE.into() })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum PublishResult {
    Saved {
        id: String,
        label: String,
        #[serde(rename = "playbookKey")]
        playbook_key: String,
        title: String,
        description: String,
        version: u64,
    },
    NeedsAccount,
    LabelRequired,
    Invalid {
        diagnostics: Vec<PlaybookValidationError>,
    },
    Failed {
        message: String,
        code: String,
    },
}

const CREATE_CONFLICT: &str = "You already published this playbook. Update it.";
const CONCURRENT_CONFLICT: &str = "Playbook was updated concurrently. Try again.";
const KEY_CHANGED: &str = "The playbook key cannot change. Publish a new one.";
const TRUNCATED_MINE: &str = "You already published this playbook, but it is not in the newest 1000. It was not updated.";

fn json_object(entries: &[(&str, Value)]) -> String {
    let mut map = serde_json::Map::new();
    for (key, value) in entries {
        map.insert((*key).into(), value.clone());
    }
    Value::Object(map).to_string()
}

fn server_diagnostics(value: &Value) -> Vec<PlaybookValidationError> {
    value
        .get("diagnostics")
        .and_then(|diagnostics| diagnostics.as_array())
        .map(|items| {
            items
                .iter()
                .map(|item| PlaybookValidationError {
                    code: item.get("code").and_then(|code| code.as_str()).unwrap_or("").into(),
                    message: item.get("message").and_then(|message| message.as_str()).unwrap_or("").into(),
                    line: item.get("line").and_then(|line| line.as_u64()).map(|line| line as usize),
                    field: item.get("field").and_then(|field| field.as_str()).map(str::to_string),
                    severity: "error".into(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn publish_failure(status: u16, body: &[u8]) -> PublishResult {
    if status == 503 || body_names_service_role(body) {
        return PublishResult::Failed {
            message: UNAVAILABLE.into(),
            code: "unavailable".into(),
        };
    }
    let value: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let code = value.get("code").and_then(|code| code.as_str()).unwrap_or("");
    let error = value.get("error").and_then(|error| error.as_str()).unwrap_or("");
    let message = match code {
        "key_changed" => KEY_CHANGED.into(),
        "label_taken" => "That label is taken.".into(),
        "label_set" => "That label is already set.".into(),
        "invalid_label" => "Label must be a lowercase slug, 2 to 32 characters.".into(),
        "attest_required" => "Confirm you can share this playbook.".into(),
        "too_large" => "Playbook is larger than 256 KiB.".into(),
        "unsupported_media_type" => "Expected application/json.".into(),
        "forbidden" => "You cannot update this playbook.".into(),
        "not_found" => "Playbook not found.".into(),
        "invalid_body" if !error.is_empty() && !error.contains(SERVICE_ROLE_KEY) => error.into(),
        _ if !error.is_empty() && !error.contains(SERVICE_ROLE_KEY) => error.into(),
        _ => UNREACHABLE.into(),
    };
    PublishResult::Failed { message, code: code.into() }
}

fn saved_detail(body: &[u8]) -> PublishResult {
    let value: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => {
            return PublishResult::Failed {
                message: UNREACHABLE.into(),
                code: String::new(),
            }
        }
    };
    if value.get("ok").and_then(|ok| ok.as_bool()) != Some(true) {
        return publish_failure(200, body);
    }
    let id = value.get("id").and_then(|id| id.as_str()).unwrap_or("").to_string();
    let version = value.get("version").and_then(|version| version.as_u64()).unwrap_or(0);
    if id.is_empty() || version < 1 {
        return PublishResult::Failed {
            message: UNREACHABLE.into(),
            code: String::new(),
        };
    }
    PublishResult::Saved {
        id,
        label: value.get("label").and_then(|label| label.as_str()).unwrap_or("").into(),
        playbook_key: value.get("playbook_key").and_then(|key| key.as_str()).unwrap_or("").into(),
        title: value.get("title").and_then(|title| title.as_str()).unwrap_or("").into(),
        description: value.get("description").and_then(|description| description.as_str()).unwrap_or("").into(),
        version,
    }
}

fn authed_json(http: &mut dyn CommunityHttp, token: &str, method: &str, url: String, body: Option<String>) -> AuthAttempt<CommunityHttpResponse> {
    match http.exchange(CommunityHttpRequest {
        method: method.into(),
        url,
        headers: vec![
            "Accept: application/json".into(),
            "Content-Type: application/json".into(),
            format!("Authorization: Bearer {token}"),
        ],
        body,
    }) {
        Ok(response) if response.status == 401 => AuthAttempt::Unauthorized,
        Ok(response) => AuthAttempt::Response(response),
        Err(error) => AuthAttempt::Transport(error),
    }
}

fn take_publish(attempt: AuthAttempt<CommunityHttpResponse>) -> Result<CommunityHttpResponse, Box<AuthAttempt<PublishResult>>> {
    match attempt {
        AuthAttempt::Response(response) => Ok(response),
        AuthAttempt::Unauthorized => Err(Box::new(AuthAttempt::Unauthorized)),
        AuthAttempt::Transport(message) => Err(Box::new(AuthAttempt::Transport(message))),
    }
}

fn put_publication(http: &mut dyn CommunityHttp, base: &str, token: &str, id: &str, source: &str) -> AuthAttempt<PublishResult> {
    let url = format!("{}/api/desktop/playbooks/{id}", base.trim_end_matches('/'));
    let body = json_object(&[("source", Value::String(source.into())), ("attest", Value::Bool(true))]);
    for attempt in 0..3 {
        let response = match take_publish(authed_json(http, token, "PUT", url.clone(), Some(body.clone()))) {
            Ok(response) => response,
            Err(stopped) => return *stopped,
        };
        if response.status == 503 || body_names_service_role(&response.body) {
            return AuthAttempt::Response(PublishResult::Failed {
                message: UNAVAILABLE.into(),
                code: "unavailable".into(),
            });
        }
        if response.status == 200 || response.status == 201 {
            return AuthAttempt::Response(saved_detail(&response.body));
        }
        let value: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
        let code = value.get("code").and_then(|code| code.as_str()).unwrap_or("");
        let error = value.get("error").and_then(|error| error.as_str()).unwrap_or("");
        if code == "key_changed" {
            return AuthAttempt::Response(PublishResult::Failed {
                message: KEY_CHANGED.into(),
                code: "key_changed".into(),
            });
        }
        if code == "conflict" && error == CONCURRENT_CONFLICT && attempt < 2 {
            continue;
        }
        if code == "conflict" && error == CONCURRENT_CONFLICT {
            return AuthAttempt::Response(PublishResult::Failed {
                message: CONCURRENT_CONFLICT.into(),
                code: "conflict".into(),
            });
        }
        return AuthAttempt::Response(publish_failure(response.status, &response.body));
    }
    AuthAttempt::Response(PublishResult::Failed {
        message: CONCURRENT_CONFLICT.into(),
        code: "conflict".into(),
    })
}

fn mine_then_put(http: &mut dyn CommunityHttp, base: &str, token: &str, source: &str, key: &str) -> AuthAttempt<PublishResult> {
    let url = format!("{}/api/desktop/playbooks/mine", base.trim_end_matches('/'));
    let response = match take_publish(authed_json(http, token, "GET", url, None)) {
        Ok(response) => response,
        Err(stopped) => return *stopped,
    };
    if response.status != 200 || body_names_service_role(&response.body) {
        return AuthAttempt::Response(publish_failure(response.status, &response.body));
    }
    let value: Value = match serde_json::from_slice(&response.body) {
        Ok(value) => value,
        Err(_) => {
            return AuthAttempt::Response(PublishResult::Failed {
                message: UNREACHABLE.into(),
                code: String::new(),
            })
        }
    };
    let truncated = value.get("truncated").and_then(|truncated| truncated.as_bool()).unwrap_or(false);
    let found = value
        .get("playbooks")
        .and_then(|playbooks| playbooks.as_array())
        .and_then(|playbooks| playbooks.iter().find(|row| row.get("playbook_key").and_then(|key_value| key_value.as_str()) == Some(key)));
    if let Some(id) = found.and_then(|row| row.get("id")).and_then(|id| id.as_str()).filter(|id| publication_id(id)) {
        return put_publication(http, base, token, id, source);
    }
    let message = if truncated { TRUNCATED_MINE } else { CREATE_CONFLICT };
    AuthAttempt::Response(PublishResult::Failed {
        message: message.into(),
        code: "conflict".into(),
    })
}

fn publish_authenticated(http: &mut dyn CommunityHttp, base: &str, token: &str, source: &str, key: &str, label: Option<&str>) -> AuthAttempt<PublishResult> {
    let validate_url = format!("{}/api/desktop/playbooks/validate", base.trim_end_matches('/'));
    let validate_body = json_object(&[("source", Value::String(source.into()))]);
    let response = match take_publish(authed_json(http, token, "POST", validate_url, Some(validate_body))) {
        Ok(response) => response,
        Err(stopped) => return *stopped,
    };
    if response.status == 503 || body_names_service_role(&response.body) {
        return AuthAttempt::Response(PublishResult::Failed {
            message: UNAVAILABLE.into(),
            code: "unavailable".into(),
        });
    }
    if response.status == 401 {
        return AuthAttempt::Unauthorized;
    }
    if response.status != 200 {
        return AuthAttempt::Response(publish_failure(response.status, &response.body));
    }
    let value: Value = match serde_json::from_slice(&response.body) {
        Ok(value) => value,
        Err(_) => {
            return AuthAttempt::Response(PublishResult::Failed {
                message: UNREACHABLE.into(),
                code: String::new(),
            })
        }
    };
    if value.get("valid").and_then(|valid| valid.as_bool()) == Some(false) {
        return AuthAttempt::Response(PublishResult::Invalid {
            diagnostics: server_diagnostics(&value),
        });
    }
    if value.get("key_taken").and_then(|taken| taken.as_bool()) == Some(true) {
        return match value.get("existing_id").and_then(|id| id.as_str()) {
            Some(id) if publication_id(id) => put_publication(http, base, token, id, source),
            _ => mine_then_put(http, base, token, source, key),
        };
    }
    let create_url = format!("{}/api/desktop/playbooks", base.trim_end_matches('/'));
    let mut entries = vec![("source", Value::String(source.into())), ("attest", Value::Bool(true))];
    if let Some(label) = label {
        entries.push(("label", Value::String(label.into())));
    }
    let create_body = json_object(&entries);
    let response = match take_publish(authed_json(http, token, "POST", create_url, Some(create_body))) {
        Ok(response) => response,
        Err(stopped) => return *stopped,
    };
    if response.status == 503 || body_names_service_role(&response.body) {
        return AuthAttempt::Response(PublishResult::Failed {
            message: UNAVAILABLE.into(),
            code: "unavailable".into(),
        });
    }
    if response.status == 201 || response.status == 200 {
        return AuthAttempt::Response(saved_detail(&response.body));
    }
    let parsed: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    let code = parsed.get("code").and_then(|code| code.as_str()).unwrap_or("");
    let error = parsed.get("error").and_then(|error| error.as_str()).unwrap_or("");
    if code == "label_required" {
        return AuthAttempt::Response(PublishResult::LabelRequired);
    }
    if code == "conflict" && error == CREATE_CONFLICT {
        return mine_then_put(http, base, token, source, key);
    }
    if code == "invalid_playbook" {
        return AuthAttempt::Response(PublishResult::Invalid {
            diagnostics: server_diagnostics(&parsed),
        });
    }
    AuthAttempt::Response(publish_failure(response.status, &response.body))
}

pub(crate) fn publish_community_playbook_with<R>(
    http: &mut dyn CommunityHttp,
    base: &str,
    auth_path: &Path,
    refresh: R,
    roots: &PlaybookRoots,
    reference: &PlaybookRef,
    label: Option<&str>,
) -> PublishResult
where
    R: FnOnce(&str) -> Result<String, AccountAuthError>,
{
    let loaded = match library::resolve_playbook(roots, reference) {
        Ok(playbook) => playbook,
        Err(alinery_core::playbook_library::PlaybookLoadError::Invalid { diagnostics, .. }) => return PublishResult::Invalid { diagnostics },
        Err(error) => {
            return PublishResult::Failed {
                message: error.to_string(),
                code: String::new(),
            }
        }
    };
    if !access_token_present(auth_path) {
        return PublishResult::NeedsAccount;
    }
    let source = loaded.source_text;
    let key = loaded.definition.key;
    match with_access_token_retry(auth_path, |token| publish_authenticated(http, base, token, &source, &key, label), refresh) {
        Ok(result) => result,
        Err(AuthRetryError::NeedsAccount) => PublishResult::NeedsAccount,
        Err(AuthRetryError::Transport(message)) => PublishResult::Failed {
            message: safe_transport(&message),
            code: String::new(),
        },
    }
}

#[tauri::command]
pub(crate) async fn publish_community_playbook(app: AppHandle, reference: PlaybookRef, repo_path: String, label: Option<String>) -> PublishResult {
    let roots = match library_roots(&app, Some(&repo_path)) {
        Ok(roots) => roots,
        Err(message) => return PublishResult::Failed { message, code: String::new() },
    };
    let auth_path = match account_auth_path_for(&app) {
        Ok(path) => path,
        Err(message) => return PublishResult::Failed { message, code: String::new() },
    };
    let base = accounts_url();
    tauri::async_runtime::spawn_blocking(move || {
        let mut http = CurlCommunityHttp;
        publish_community_playbook_with(&mut http, &base, &auth_path, refresh_for(auth_path.clone()), &roots, &reference, label.as_deref())
    })
    .await
    .unwrap_or(PublishResult::Failed {
        message: UNREACHABLE.into(),
        code: String::new(),
    })
}
