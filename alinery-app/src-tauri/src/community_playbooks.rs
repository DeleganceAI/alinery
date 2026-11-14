//! The community playbook library's HTTP half: the catalog, a publication's preview and source, the downloaded list's remote status,
//! the signed-in author's own list, and publish. These need this machine's account, or the accounts URL it holds, so they stay in the
//! shell (S4.10). What lands in a repository, and the registry of what did, is the repository's daemon's (`PlaybookService`).
//!
//! Accounts HTTP is injected. Production uses `curl_http_method`. Tests must not
//! open a socket to the accounts host.
use crate::*;
use alinery_core::playbook::PlaybookValidationError;
use std::path::Path;

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

fn parse_mine(body: &[u8]) -> Result<(Vec<CommunitySummary>, bool), String> {
    let value: Value = serde_json::from_slice(body).map_err(|_| UNREACHABLE.to_string())?;
    if value.get("ok").and_then(|ok| ok.as_bool()) != Some(true) {
        return Err(library_failure_message(200, body));
    }
    let playbooks = value.get("playbooks").cloned().ok_or_else(|| UNREACHABLE.to_string())?;
    let playbooks: Vec<CommunitySummary> = serde_json::from_value(playbooks).map_err(|_| UNREACHABLE.to_string())?;
    let truncated = match value.get("truncated") {
        Some(Value::Bool(flag)) => *flag,
        _ => return Err(UNREACHABLE.to_string()),
    };
    Ok((playbooks, truncated))
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

fn parse_summary(body: &[u8]) -> Result<CommunitySummary, String> {
    let value: Value = serde_json::from_slice(body).map_err(|_| UNREACHABLE.to_string())?;
    if value.get("ok").and_then(|ok| ok.as_bool()) != Some(true) {
        return Err(library_failure_message(200, body));
    }
    serde_json::from_value(value).map_err(|_| UNREACHABLE.to_string())
}

/// What the library says about one publication, for a row of the downloaded list. The page puts it beside what the daemon says about the local file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteStatus {
    pub id: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub remote_version: Option<u64>,
    pub remote_missing: bool,
    pub error: Option<String>,
}

fn remote_status(http: &mut dyn CommunityHttp, base: &str, id: &str) -> RemoteStatus {
    let mut row = RemoteStatus {
        id: id.into(),
        title: None,
        description: None,
        remote_version: None,
        remote_missing: false,
        error: None,
    };
    if !publication_id(id) {
        row.error = Some("Playbook not found.".into());
        return row;
    }
    let url = format!("{}/api/desktop/playbooks/{}", base.trim_end_matches('/'), id);
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
        }
        Err(error) => row.error = Some(error),
    }
    row
}

pub(crate) fn community_remote_status_with(http: &mut dyn CommunityHttp, base: &str, ids: &[String]) -> Vec<RemoteStatus> {
    ids.iter().map(|id| remote_status(http, base, id)).collect()
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

/// The library's remote half of the downloaded list: no account is needed to browse, so this is the public detail of each id.
#[tauri::command]
pub(crate) async fn community_remote_status(ids: Vec<String>) -> Result<Vec<RemoteStatus>, String> {
    let base = accounts_url();
    tauri::async_runtime::spawn_blocking(move || {
        let mut http = CurlCommunityHttp;
        community_remote_status_with(&mut http, &base, &ids)
    })
    .await
    .map_err(|_| UNREACHABLE.to_string())
}

/// What the shell downloaded of one publication with this machine's account, or why it could not. The page stages the document with
/// the repository's daemon (`BlobService`) and names it in `ImportCommunityPlaybook` / `UpdateCommunityImport`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum SourceResult {
    Downloaded {
        document: String,
        version: u64,
        label: String,
        #[serde(rename = "playbookKey")]
        playbook_key: String,
    },
    NeedsAccount,
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

fn safe_transport(error: &str) -> String {
    if error.contains(SERVICE_ROLE_KEY) {
        UNAVAILABLE.into()
    } else {
        UNREACHABLE.into()
    }
}

fn authed_exchange<R>(http: &mut dyn CommunityHttp, auth_path: &Path, refresh: R, method: &str, url: String, body: Option<String>) -> Result<CommunityHttpResponse, AuthRetryError>
where
    R: FnOnce(&AccountTokens) -> Result<AccountTokens, AccountAuthError>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum MineResult {
    Loaded { playbooks: Vec<CommunitySummary>, truncated: bool },
    NeedsAccount,
    Failed { message: String },
}

/// The caller's publications. Bearer required. No cursor. Cap 1000, with `truncated`
/// when older rows were omitted. Browse stays anonymous; this is the only list that
/// identifies the signed-in author.
pub(crate) fn list_my_community_playbooks_with<R>(http: &mut dyn CommunityHttp, base: &str, auth_path: &Path, refresh: R) -> MineResult
where
    R: FnOnce(&AccountTokens) -> Result<AccountTokens, AccountAuthError>,
{
    if !access_token_present(auth_path) {
        return MineResult::NeedsAccount;
    }
    let url = format!("{}/api/desktop/playbooks/mine", base.trim_end_matches('/'));
    let response = match authed_exchange(http, auth_path, refresh, "GET", url, None) {
        Ok(response) => response,
        Err(AuthRetryError::NeedsAccount) => return MineResult::NeedsAccount,
        Err(AuthRetryError::Transport(message)) => {
            return MineResult::Failed {
                message: safe_transport(&message),
            }
        }
    };
    if response.status == 503 || body_names_service_role(&response.body) {
        return MineResult::Failed { message: UNAVAILABLE.into() };
    }
    if response.status != 200 {
        return MineResult::Failed {
            message: library_failure_message(response.status, &response.body),
        };
    }
    match parse_mine(&response.body) {
        Ok((playbooks, truncated)) => MineResult::Loaded { playbooks, truncated },
        Err(message) => MineResult::Failed { message },
    }
}

#[tauri::command]
pub(crate) async fn list_my_community_playbooks(app: AppHandle) -> MineResult {
    let auth_path = match account_auth_path_for(&app) {
        Ok(path) => path,
        Err(message) => return MineResult::Failed { message },
    };
    let base = accounts_url();
    tauri::async_runtime::spawn_blocking(move || {
        let mut http = CurlCommunityHttp;
        list_my_community_playbooks_with(&mut http, &base, &auth_path, refresh_for(auth_path.clone()))
    })
    .await
    .unwrap_or(MineResult::Failed { message: UNREACHABLE.into() })
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
    R: FnOnce(&AccountTokens) -> Result<AccountTokens, AccountAuthError>,
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

fn refresh_for(auth_path: PathBuf) -> impl FnOnce(&AccountTokens) -> Result<AccountTokens, AccountAuthError> {
    move |tokens| refresh_paired_access(&auth_path, tokens)
}

pub(crate) fn download_community_source_with<R>(http: &mut dyn CommunityHttp, base: &str, auth_path: &Path, refresh: R, id: &str) -> SourceResult
where
    R: FnOnce(&AccountTokens) -> Result<AccountTokens, AccountAuthError>,
{
    if !publication_id(id) {
        return SourceResult::Failed {
            message: "Playbook not found.".into(),
        };
    }
    if !access_token_present(auth_path) {
        return SourceResult::NeedsAccount;
    }
    match download_source(http, base, auth_path, refresh, id) {
        Ok(detail) => SourceResult::Downloaded {
            document: detail.document,
            version: detail.version,
            label: detail.label,
            playbook_key: detail.playbook_key,
        },
        Err(Err(AuthRetryError::NeedsAccount)) => SourceResult::NeedsAccount,
        Err(Err(AuthRetryError::Transport(message))) => SourceResult::Failed {
            message: safe_transport(&message),
        },
        Err(Ok(message)) => SourceResult::Failed { message },
    }
}

#[tauri::command]
pub(crate) async fn download_community_source(app: AppHandle, id: String) -> SourceResult {
    let auth_path = match account_auth_path_for(&app) {
        Ok(path) => path,
        Err(message) => return SourceResult::Failed { message },
    };
    let base = accounts_url();
    tauri::async_runtime::spawn_blocking(move || {
        let mut http = CurlCommunityHttp;
        download_community_source_with(&mut http, &base, &auth_path, refresh_for(auth_path.clone()), &id)
    })
    .await
    .unwrap_or(SourceResult::Failed { message: UNREACHABLE.into() })
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
    R: FnOnce(&AccountTokens) -> Result<AccountTokens, AccountAuthError>,
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

/// `source` is the playbook as the repository's daemon holds it (`PlaybookService.ReadPlaybook`) and `key` its declared key. The daemon
/// reads, the shell sends: publishing needs this machine's account.
pub(crate) fn publish_community_playbook_with<R>(
    http: &mut dyn CommunityHttp,
    base: &str,
    auth_path: &Path,
    refresh: R,
    source: &str,
    key: &str,
    label: Option<&str>,
) -> PublishResult
where
    R: FnOnce(&AccountTokens) -> Result<AccountTokens, AccountAuthError>,
{
    if !access_token_present(auth_path) {
        return PublishResult::NeedsAccount;
    }
    match with_access_token_retry(auth_path, |token| publish_authenticated(http, base, token, source, key, label), refresh) {
        Ok(result) => result,
        Err(AuthRetryError::NeedsAccount) => PublishResult::NeedsAccount,
        Err(AuthRetryError::Transport(message)) => PublishResult::Failed {
            message: safe_transport(&message),
            code: String::new(),
        },
    }
}

#[tauri::command]
pub(crate) async fn publish_community_playbook(app: AppHandle, source: String, key: String, label: Option<String>) -> PublishResult {
    let auth_path = match account_auth_path_for(&app) {
        Ok(path) => path,
        Err(message) => return PublishResult::Failed { message, code: String::new() },
    };
    let base = accounts_url();
    tauri::async_runtime::spawn_blocking(move || {
        let mut http = CurlCommunityHttp;
        publish_community_playbook_with(&mut http, &base, &auth_path, refresh_for(auth_path.clone()), &source, &key, label.as_deref())
    })
    .await
    .unwrap_or(PublishResult::Failed {
        message: UNREACHABLE.into(),
        code: String::new(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum UnpublishResult {
    Removed,
    NeedsAccount,
    Failed { message: String },
}

/// Removes one of the caller's listings (`DELETE /api/desktop/playbooks/:id`, owner only). A listing already gone is removed: that is
/// what the person asked for. Local copies, the person's own and other people's downloads, are untouched.
pub(crate) fn unpublish_community_playbook_with<R>(http: &mut dyn CommunityHttp, base: &str, auth_path: &Path, refresh: R, id: &str) -> UnpublishResult
where
    R: FnOnce(&AccountTokens) -> Result<AccountTokens, AccountAuthError>,
{
    if !publication_id(id) {
        return UnpublishResult::Failed {
            message: "Playbook not found.".into(),
        };
    }
    if !access_token_present(auth_path) {
        return UnpublishResult::NeedsAccount;
    }
    let url = format!("{}/api/desktop/playbooks/{id}", base.trim_end_matches('/'));
    let response = match authed_exchange(http, auth_path, refresh, "DELETE", url, None) {
        Ok(response) => response,
        Err(AuthRetryError::NeedsAccount) => return UnpublishResult::NeedsAccount,
        Err(AuthRetryError::Transport(message)) => {
            return UnpublishResult::Failed {
                message: safe_transport(&message),
            }
        }
    };
    match response.status {
        200 | 404 => UnpublishResult::Removed,
        status => match publish_failure(status, &response.body) {
            PublishResult::Failed { code, .. } if code == "forbidden" => UnpublishResult::Failed {
                message: "You cannot remove this playbook.".into(),
            },
            PublishResult::Failed { message, .. } => UnpublishResult::Failed { message },
            _ => UnpublishResult::Failed { message: UNREACHABLE.into() },
        },
    }
}

#[tauri::command]
pub(crate) async fn unpublish_community_playbook(app: AppHandle, id: String) -> UnpublishResult {
    let auth_path = match account_auth_path_for(&app) {
        Ok(path) => path,
        Err(message) => return UnpublishResult::Failed { message },
    };
    let base = accounts_url();
    tauri::async_runtime::spawn_blocking(move || {
        let mut http = CurlCommunityHttp;
        unpublish_community_playbook_with(&mut http, &base, &auth_path, refresh_for(auth_path.clone()), &id)
    })
    .await
    .unwrap_or(UnpublishResult::Failed { message: UNREACHABLE.into() })
}
