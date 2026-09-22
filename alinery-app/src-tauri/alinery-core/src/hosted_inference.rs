//! Hosted inference token files (`inference.json` + isolated `models.yml`).
//!
//! One home for mint/reuse/persist so app spawn, daemon auto-advance, restate, and MCP
//! all refresh the same way. Never puts `inf_…` in the return value.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::lockfile::lock_exclusive_blocking;
use crate::paths::omp_home_dirs;
use crate::write_owner_only_bytes;

const HOSTED_PROVIDER: &str = "alinery";
const INFERENCE_JSON: &str = "inference.json";
const INFERENCE_SKEW_SECS: u64 = 120;
const RENEWAL_LEAD_SECS: u64 = 3600;
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_ACCOUNTS_URL: &str = "https://accounts.alinery.ai";
// Keep in sync with alinery-app `account.rs`. Publishable key, not a secret.
const SUPABASE_URL: &str = "https://cppinfludeyomoyinrkl.supabase.co";
const SUPABASE_PUBLISHABLE_KEY: &str = "sb_publishable_BJ356xdHfbL0B0BeHfqf7A_QBDFiAto";
const REFRESH_SKEW_SECS: u64 = 120;

pub const HOSTED_MODEL_UNAVAILABLE: &str = "the selected model isn't available right now";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostedModel {
    pub id: String,
    pub name: String,
    pub context_window: u64,
    pub max_tokens: u64,
    #[serde(default)]
    pub price: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostedCatalog {
    pub provider: String,
    pub default_model: String,
    pub base_url: String,
    pub plans_url: String,
    pub models: Vec<HostedModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InferenceFile {
    token: String,
    expires_at: u64,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    minted_at: u64,
    catalog: HostedCatalog,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HostedApiError {
    pub status: u16,
    pub error: String,
    pub code: Option<String>,
}

pub fn is_hosted_model(model: &str) -> bool {
    let model = model.trim();
    model.split_once('/').is_some_and(|(provider, id)| provider == HOSTED_PROVIDER && !id.is_empty())
}

pub fn hosted_models_yml_unavailable(app_config: &Path) -> String {
    format!("Alinery could not update its model configuration — see `{}`", models_yml_path(app_config).display())
}

pub fn inference_path(config_dir: &Path) -> PathBuf {
    config_dir.join(INFERENCE_JSON)
}

pub fn models_yml_path(app_config: &Path) -> PathBuf {
    omp_home_dirs(app_config).0.join("models.yml")
}

/// Directory that holds `auth.json` / `inference.json` for this `app.toml`.
///
/// Production: parent of `app.toml`. Dev instances: `<config_dir>/instances/<hash>/app.toml`
/// → `<config_dir>` so pairing files stay on the Tauri config dir.
pub fn pairing_config_dir(app_config: &Path) -> PathBuf {
    let Some(dir) = app_config.parent() else {
        return app_config.to_path_buf();
    };
    match (dir.parent().and_then(|p| p.file_name()), dir.parent().and_then(|p| p.parent())) {
        (Some(parent_name), Some(config_dir)) if parent_name == "instances" => config_dir.to_path_buf(),
        _ => dir.to_path_buf(),
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn accounts_url() -> String {
    std::env::var("ALINERY_ACCOUNTS_URL")
        .ok()
        .map(|value| value.trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_ACCOUNTS_URL.to_string())
}

fn require_alinery_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.chars().any(char::is_control) {
        return Err("hosted model id must be non-empty, contain no slash, and contain no control characters".into());
    }
    Ok(())
}

fn validate_catalog(catalog: &HostedCatalog, require_price: bool) -> Result<(), String> {
    if catalog.provider != HOSTED_PROVIDER {
        return Err(format!("hosted provider must be {HOSTED_PROVIDER}"));
    }
    let Some(id) = catalog.default_model.strip_prefix("alinery/") else {
        return Err("default_model must be alinery/<id>".into());
    };
    require_alinery_id(id)?;
    if !catalog.models.iter().any(|model| model.id == id) {
        return Err(format!("default_model {id} is not in models"));
    }
    if catalog.base_url.is_empty() || catalog.plans_url.is_empty() {
        return Err("hosted catalog is missing base_url or plans_url".into());
    }
    for model in &catalog.models {
        require_alinery_id(&model.id)?;
        if model.name.chars().any(char::is_control) {
            return Err(format!("hosted model {} name must not contain control characters", model.id));
        }
        if require_price {
            match model.price {
                Some(p) if p <= 5 => {}
                _ => return Err(format!("hosted model {} is missing price 0–5", model.id)),
            }
        } else if let Some(p) = model.price {
            if p > 5 {
                return Err(format!("hosted model {} has price {p} outside 0–5", model.id));
            }
        }
    }
    Ok(())
}

fn catalog_from_value(value: &Value, require_price: bool) -> Result<HostedCatalog, String> {
    let catalog: HostedCatalog = serde_json::from_value(value.clone()).map_err(|e| format!("bad hosted catalog: {e}"))?;
    validate_catalog(&catalog, require_price)?;
    Ok(catalog)
}

pub fn parse_hosted_error(status: u16, body: &[u8]) -> HostedApiError {
    let value: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let error = value
        .get("error")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("hosted models request failed")
        .to_string();
    let code = value.get("code").and_then(Value::as_str).map(str::to_string);
    HostedApiError { status, error, code }
}

pub fn parse_hosted_catalog_body(body: &[u8]) -> Result<HostedCatalog, String> {
    let value: Value = serde_json::from_slice(body).map_err(|e| format!("bad hosted catalog: {e}"))?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(parse_hosted_error(200, body).error);
    }
    catalog_from_value(&value, true)
}

pub fn parse_inference_session_body(body: &[u8]) -> Result<(String, u64, HostedCatalog), String> {
    let value: Value = serde_json::from_slice(body).map_err(|e| format!("bad inference session: {e}"))?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(parse_hosted_error(200, body).error);
    }
    let token = value
        .get("token")
        .and_then(Value::as_str)
        .filter(|t| t.starts_with("inf_"))
        .ok_or_else(|| "inference session is missing token".to_string())?
        .to_string();
    let expires_at = value
        .get("expires_at")
        .and_then(Value::as_u64)
        .ok_or_else(|| "inference session is missing expires_at".to_string())?;
    let catalog = catalog_from_value(&value, true)?;
    Ok((token, expires_at, catalog))
}

fn yaml_scalar(value: &str) -> String {
    if value.is_empty() || value.chars().any(|c| c.is_control() || c.is_whitespace() || ":#{}[]&*?|>'!%@`,\"'".contains(c)) {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r"))
    } else {
        value.to_string()
    }
}

fn render_alinery_block(catalog: &HostedCatalog, token: &str) -> String {
    let mut out = String::from("  alinery:\n");
    out.push_str(&format!("    baseUrl: {}\n", yaml_scalar(&catalog.base_url)));
    out.push_str("    api: openai-completions\n");
    out.push_str(&format!("    apiKey: {}\n", yaml_scalar(token)));
    out.push_str("    models:\n");
    for model in &catalog.models {
        out.push_str(&format!("      - id: {}\n", yaml_scalar(&model.id)));
        out.push_str(&format!("        name: {}\n", yaml_scalar(&model.name)));
        out.push_str(&format!("        contextWindow: {}\n", model.context_window));
        out.push_str(&format!("        maxTokens: {}\n", model.max_tokens));
    }
    out
}

pub fn render_models_yml(catalog: &HostedCatalog, token: &str) -> String {
    let mut out = String::from("providers:\n");
    out.push_str(&render_alinery_block(catalog, token));
    out
}

fn load_inference_file(path: &Path) -> Option<InferenceFile> {
    let bytes = fs::read(path).ok()?;
    let file: InferenceFile = serde_json::from_slice(&bytes).ok()?;
    validate_catalog(&file.catalog, false).ok()?;
    if !file.token.starts_with("inf_") {
        return None;
    }
    Some(file)
}

fn inference_unexpired(file: &InferenceFile, now: u64) -> bool {
    now.saturating_add(INFERENCE_SKEW_SECS) < file.expires_at
}

fn inference_due_for_renewal(file: &InferenceFile, now: u64) -> bool {
    file.expires_at.saturating_sub(now) < RENEWAL_LEAD_SECS
}

pub fn inference_spawn_cache_fresh(config_dir: &Path, now: u64) -> bool {
    load_inference_file(&inference_path(config_dir)).is_some_and(|file| inference_unexpired(&file, now) && !inference_due_for_renewal(&file, now))
}

pub fn minted_catalog_if_unexpired(config_dir: &Path) -> Option<HostedCatalog> {
    let file = load_inference_file(&inference_path(config_dir))?;
    inference_unexpired(&file, now_secs()).then_some(file.catalog)
}

fn persist_minted_inference(inf_path: &Path, app_config: &Path, token: &str, expires_at: u64, session_id: &str, minted_at: u64, catalog: &HostedCatalog) -> Result<(), String> {
    // models.yml first: splice fail-closed must not leave a rotated token in inference.json.
    write_hosted_models_yml(app_config, catalog, token)?;
    write_inference_file(inf_path, token, expires_at, session_id, minted_at, catalog).map_err(|_| HOSTED_MODEL_UNAVAILABLE.to_string())
}

fn reuse_cached_inference(inf_path: &Path, app_config: &Path, accounts_url: &str, session_id: &str, file: &InferenceFile) -> Result<(), String> {
    if let Ok(live) = fetch_live_catalog(accounts_url) {
        persist_minted_inference(inf_path, app_config, &file.token, file.expires_at, session_id, file.minted_at, &live)
    } else {
        write_hosted_models_yml(app_config, &file.catalog, &file.token)
    }
}

pub fn write_inference_file(path: &Path, token: &str, expires_at: u64, session_id: &str, minted_at: u64, catalog: &HostedCatalog) -> Result<(), String> {
    let file = InferenceFile {
        token: token.to_string(),
        expires_at,
        session_id: session_id.to_string(),
        minted_at,
        catalog: catalog.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
    write_owner_only_bytes(path, &bytes)
}

fn top_level_key(seg: &str) -> Option<&str> {
    let line = seg.trim_end_matches(['\n', '\r']);
    if line.is_empty() {
        return None;
    }
    let first = line.as_bytes()[0];
    if first == b' ' || first == b'\t' || first == b'#' {
        return None;
    }
    let (key, _) = line.split_once(':')?;
    if key.chars().any(char::is_whitespace) {
        return None;
    }
    Some(key)
}

fn provider_key(seg: &str) -> Option<&str> {
    let line = seg.trim_end_matches(['\n', '\r']);
    let rest = line.strip_prefix("  ")?;
    if rest.starts_with(' ') {
        return None;
    }
    let (key, _) = rest.split_once(':')?;
    if key.is_empty() || key.chars().any(char::is_whitespace) {
        return None;
    }
    Some(key)
}

fn splice_alinery(yml: &str, alinery_block: Option<&str>) -> Result<Option<String>, String> {
    let segments: Vec<&str> = yml.split_inclusive('\n').collect();
    let providers_line = segments
        .iter()
        .position(|seg| top_level_key(seg) == Some("providers"))
        .ok_or_else(|| "models.yml has no providers: map".to_string())?;

    let mut blocks: Vec<(&str, usize, usize)> = Vec::new();
    let mut i = providers_line + 1;
    while i < segments.len() {
        if let Some(key) = provider_key(segments[i]) {
            let start = i;
            i += 1;
            while i < segments.len() && provider_key(segments[i]).is_none() && top_level_key(segments[i]).is_none() {
                i += 1;
            }
            blocks.push((key, start, i));
        } else {
            i += 1;
        }
    }

    match alinery_block {
        Some(block) => {
            let merged = match blocks.iter().find(|(key, _, _)| *key == "alinery") {
                Some((_, start, end)) => {
                    let mut out = String::with_capacity(yml.len() + block.len());
                    out.push_str(&segments[..*start].concat());
                    out.push_str(block);
                    out.push_str(&segments[*end..].concat());
                    out
                }
                None => {
                    let mut out = String::with_capacity(yml.len() + block.len());
                    out.push_str(&segments[..=providers_line].concat());
                    out.push_str(block);
                    out.push_str(&segments[providers_line + 1..].concat());
                    out
                }
            };
            Ok(Some(merged))
        }
        None => match blocks.iter().position(|(key, _, _)| *key == "alinery") {
            Some(index) => {
                let (_, start, end) = blocks[index];
                if blocks.len() == 1 {
                    return Ok(None);
                }
                let mut out = String::with_capacity(yml.len());
                out.push_str(&segments[..start].concat());
                out.push_str(&segments[end..].concat());
                Ok(Some(out))
            }
            None => {
                if blocks.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(yml.to_string()))
                }
            }
        },
    }
}

pub fn write_hosted_models_yml(app_config: &Path, catalog: &HostedCatalog, token: &str) -> Result<(), String> {
    let yml_path = models_yml_path(app_config);
    let block = render_alinery_block(catalog, token);
    let merged = match fs::read_to_string(&yml_path) {
        Ok(existing) if !existing.trim().is_empty() => splice_alinery(&existing, Some(&block))
            .map_err(|_| hosted_models_yml_unavailable(app_config))?
            .ok_or_else(|| hosted_models_yml_unavailable(app_config))?,
        _ => render_models_yml(catalog, token),
    };
    write_owner_only_bytes(&yml_path, merged.as_bytes())
}

pub fn wipe_hosted_files(config_dir: &Path, app_config: &Path) {
    let _ = fs::remove_file(inference_path(config_dir));
    let yml_path = models_yml_path(app_config);
    let existing = match fs::read_to_string(&yml_path) {
        Ok(text) => text,
        Err(_) => return,
    };
    match splice_alinery(&existing, None) {
        Ok(Some(remaining)) => {
            let _ = write_owner_only_bytes(&yml_path, remaining.as_bytes());
        }
        Ok(None) => {
            let _ = fs::remove_file(&yml_path);
        }
        Err(_) => {}
    }
}

fn http_call(method: &str, url: &str, headers: &[(String, String)], body: Option<&str>) -> Result<(u16, Vec<u8>), String> {
    let mut req = ureq::request(method, url).timeout(HTTP_TIMEOUT);
    for (key, value) in headers {
        req = req.set(key, value);
    }
    let result = match body {
        Some(bytes) => req.send_string(bytes),
        None => req.call(),
    };
    match result {
        Ok(resp) => read_ureq(resp),
        Err(ureq::Error::Status(_, resp)) => read_ureq(resp),
        Err(error) => Err(error.to_string()),
    }
}

fn read_ureq(resp: ureq::Response) -> Result<(u16, Vec<u8>), String> {
    let status = resp.status();
    let mut body = Vec::new();
    resp.into_reader().read_to_end(&mut body).map_err(|e| e.to_string())?;
    Ok((status, body))
}

fn hosted_headers(access_token: Option<&str>) -> Vec<(String, String)> {
    let mut headers = vec![("Accept".into(), "application/json".into()), ("Content-Type".into(), "application/json".into())];
    if let Some(token) = access_token {
        headers.push(("Authorization".into(), format!("Bearer {token}")));
    }
    headers
}

fn fetch_live_catalog(accounts_url: &str) -> Result<HostedCatalog, HostedApiError> {
    let url = format!("{}/api/desktop/hosted-models", accounts_url.trim_end_matches('/'));
    let (status, body) = http_call("GET", &url, &hosted_headers(None), None).map_err(|e| HostedApiError { status: 0, error: e, code: None })?;
    if !(200..300).contains(&status) {
        return Err(parse_hosted_error(status, &body));
    }
    parse_hosted_catalog_body(&body).map_err(|error| HostedApiError { status, error, code: None })
}

fn mint_inference_session(accounts_url: &str, access_token: &str, session_id: &str) -> Result<(String, u64, HostedCatalog), HostedApiError> {
    let url = format!("{}/api/desktop/inference-session", accounts_url.trim_end_matches('/'));
    let body = json!({ "session_id": session_id }).to_string();
    let (status, bytes) = http_call("POST", &url, &hosted_headers(Some(access_token)), Some(&body)).map_err(|e| HostedApiError { status: 0, error: e, code: None })?;
    if !(200..300).contains(&status) {
        return Err(parse_hosted_error(status, &bytes));
    }
    parse_inference_session_body(&bytes).map_err(|error| HostedApiError { status, error, code: None })
}

fn delete_inference_session(accounts_url: &str, access_token: &str, session_id: &str) {
    let url = format!("{}/api/desktop/inference-session", accounts_url.trim_end_matches('/'));
    let body = json!({ "session_id": session_id }).to_string();
    match http_call("DELETE", &url, &hosted_headers(Some(access_token)), Some(&body)) {
        Ok((status, _)) if (200..300).contains(&status) => {}
        Ok((status, _)) => eprintln!("delete inference session: HTTP {status}"),
        Err(e) => eprintln!("delete inference session: {e}"),
    }
}

pub fn sync_hosted_inference(config_dir: &Path, app_config: &Path, accounts_url: &str, access_token: &str, session_id: &str, paid: bool) -> Result<(), String> {
    if !paid {
        revoke_hosted_inference(config_dir, app_config, accounts_url, Some(access_token), Some(session_id));
        return Ok(());
    }
    let inf_path = inference_path(config_dir);
    let lock_path = inf_path.with_extension("json.lock");
    let _lock = lock_exclusive_blocking(&lock_path).map_err(|e| e.to_string())?;
    let now = now_secs();
    let existing = load_inference_file(&inf_path);
    if let Some(file) = existing.filter(|file| inference_unexpired(file, now)) {
        if !inference_due_for_renewal(&file, now) {
            return reuse_cached_inference(&inf_path, app_config, accounts_url, session_id, &file);
        }
        return match mint_inference_session(accounts_url, access_token, session_id) {
            Ok((token, expires_at, catalog)) => persist_minted_inference(&inf_path, app_config, &token, expires_at, session_id, now, &catalog),
            Err(_) => reuse_cached_inference(&inf_path, app_config, accounts_url, session_id, &file),
        };
    }
    match mint_inference_session(accounts_url, access_token, session_id) {
        Ok((token, expires_at, catalog)) => persist_minted_inference(&inf_path, app_config, &token, expires_at, session_id, now, &catalog),
        Err(_) => Err(HOSTED_MODEL_UNAVAILABLE.into()),
    }
}

pub fn revoke_hosted_inference(config_dir: &Path, app_config: &Path, accounts_url: &str, access_token: Option<&str>, session_id: Option<&str>) {
    if let (Some(token), Some(session)) = (access_token, session_id) {
        if !token.is_empty() && !session.is_empty() {
            delete_inference_session(accounts_url, token, session);
        }
    }
    wipe_hosted_files(config_dir, app_config);
}

fn auth_is_paid(value: &Value) -> bool {
    let paid = value.get("paid").and_then(Value::as_bool).unwrap_or(false);
    let plan = value.get("plan").and_then(Value::as_str);
    paid || matches!(plan, Some("Founders Edition" | "Teams"))
}

fn load_auth_value(path: &Path) -> Option<Value> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn refresh_jwt_access_token(supabase_url: &str, auth_path: &Path, tokens: &mut Value) -> Result<(), String> {
    let refresh_token = tokens
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| HOSTED_MODEL_UNAVAILABLE.to_string())?;
    let body = json!({ "refresh_token": refresh_token }).to_string();
    let headers = vec![
        ("apikey".into(), SUPABASE_PUBLISHABLE_KEY.to_string()),
        ("Authorization".into(), format!("Bearer {SUPABASE_PUBLISHABLE_KEY}")),
        ("Content-Type".into(), "application/json".into()),
    ];
    let url = format!("{}/auth/v1/token?grant_type=refresh_token", supabase_url.trim_end_matches('/'));
    let (status, bytes) = http_call("POST", &url, &headers, Some(&body)).map_err(|_| HOSTED_MODEL_UNAVAILABLE.to_string())?;
    if !(200..300).contains(&status) {
        return Err(HOSTED_MODEL_UNAVAILABLE.into());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| HOSTED_MODEL_UNAVAILABLE.to_string())?;
    let access = value
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| HOSTED_MODEL_UNAVAILABLE.to_string())?;
    tokens["access_token"] = json!(access);
    if let Some(next_refresh) = value.get("refresh_token").and_then(Value::as_str).filter(|t| !t.is_empty()) {
        tokens["refresh_token"] = json!(next_refresh);
    }
    let expires_in = value.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);
    tokens["expires_at"] = json!(now_secs().saturating_add(expires_in));
    let lock_path = auth_path.with_extension("json.lock");
    let _lock = lock_exclusive_blocking(&lock_path).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(tokens).map_err(|e| e.to_string())?;
    write_owner_only_bytes(auth_path, &bytes)
}

/// Refresh hosted inference before an OMP process starts. Unsigned/unpaid is `Ok` (BYOK).
/// Unexpired cache that is not due for renewal skips JWT and mint HTTP.
pub fn ensure_hosted_inference_for_spawn(app_config: &Path) -> Result<(), String> {
    ensure_hosted_inference_for_spawn_at(app_config, &accounts_url(), SUPABASE_URL)
}

pub fn ensure_hosted_inference_for_spawn_at(app_config: &Path, accounts_url: &str, supabase_url: &str) -> Result<(), String> {
    let config_dir = pairing_config_dir(app_config);
    let auth_path = config_dir.join("auth.json");
    let Some(mut tokens) = load_auth_value(&auth_path) else {
        return Ok(());
    };
    if !auth_is_paid(&tokens) {
        return Ok(());
    }
    let now = now_secs();
    if inference_spawn_cache_fresh(&config_dir, now) {
        let Some(file) = load_inference_file(&inference_path(&config_dir)) else {
            return Ok(());
        };
        return write_hosted_models_yml(app_config, &file.catalog, &file.token);
    }
    let jwt_fresh = tokens
        .get("expires_at")
        .and_then(Value::as_u64)
        .is_some_and(|expires_at| now.saturating_add(REFRESH_SKEW_SECS) < expires_at);
    if !jwt_fresh {
        refresh_jwt_access_token(supabase_url, &auth_path, &mut tokens)?;
    }
    let access = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| HOSTED_MODEL_UNAVAILABLE.to_string())?;
    let session_id = tokens.get("session_id").and_then(Value::as_str).unwrap_or("").to_string();
    let access = access.to_string();
    sync_hosted_inference(&config_dir, app_config, accounts_url, &access, &session_id, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alinery-hosted-inf-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn pairing_config_dir_uses_app_toml_parent_except_dev_instances() {
        assert_eq!(pairing_config_dir(Path::new("/tmp/id/app.toml")), PathBuf::from("/tmp/id"));
        assert_eq!(pairing_config_dir(Path::new("/tmp/id/instances/abc123/app.toml")), PathBuf::from("/tmp/id"));
    }

    #[test]
    fn is_hosted_model_trims_and_requires_alinery_id() {
        assert!(is_hosted_model("alinery/Qwen3.6-35B-A3B"));
        assert!(is_hosted_model(" alinery/Qwen3.6-35B-A3B "));
        assert!(!is_hosted_model("anthropic/claude"));
        assert!(!is_hosted_model("alinery"));
        assert!(!is_hosted_model("alinery/"));
        assert!(!is_hosted_model(""));
        assert!(!is_hosted_model("   "));
    }

    #[test]
    fn ensure_without_auth_is_ok() {
        let dir = temp_dir("unsigned");
        let app_config = dir.join("app.toml");
        fs::write(&app_config, b"").unwrap();
        assert_eq!(ensure_hosted_inference_for_spawn_at(&app_config, "http://127.0.0.1:1", "http://127.0.0.1:1"), Ok(()));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ensure_unpaid_is_ok_and_does_not_wipe() {
        let dir = temp_dir("unpaid");
        let app_config = dir.join("app.toml");
        fs::write(&app_config, b"").unwrap();
        fs::write(
            dir.join("auth.json"),
            serde_json::json!({
                "access_token": "a",
                "refresh_token": "r",
                "expires_at": 4_000_000_000u64,
                "user": { "id": "u1" },
                "plan": "Free",
                "paid": false,
                "session_id": "s"
            })
            .to_string(),
        )
        .unwrap();
        let inf = inference_path(&dir);
        fs::write(&inf, br#"{"token":"inf_keep"}"#).unwrap();
        let before = fs::read(&inf).unwrap();
        assert_eq!(ensure_hosted_inference_for_spawn_at(&app_config, "http://127.0.0.1:1", "http://127.0.0.1:1"), Ok(()));
        assert_eq!(fs::read(&inf).unwrap(), before);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ensure_paid_fresh_cache_skips_network() {
        let dir = temp_dir("fresh");
        let app_config = dir.join("app.toml");
        fs::write(&app_config, b"").unwrap();
        fs::write(
            dir.join("auth.json"),
            serde_json::json!({
                "access_token": "a",
                "refresh_token": "r",
                "expires_at": 4_000_000_000u64,
                "user": { "id": "u1" },
                "plan": "Founders Edition",
                "paid": true,
                "session_id": "s"
            })
            .to_string(),
        )
        .unwrap();
        let catalog = parse_hosted_catalog_body(
            br#"{
              "ok": true,
              "provider": "alinery",
              "default_model": "alinery/Qwen3.6-35B-A3B",
              "base_url": "https://inference.alinery.ai/v1",
              "plans_url": "https://accounts.alinery.ai/plans",
              "models": [{"id":"Qwen3.6-35B-A3B","name":"Qwen3.6-35B-A3B","context_window":1,"max_tokens":1,"price":1}]
            }"#,
        )
        .unwrap();
        let now = now_secs();
        write_inference_file(&inference_path(&dir), "inf_keep", now + 86_400, "s", now, &catalog).unwrap();
        write_hosted_models_yml(&app_config, &catalog, "inf_keep").unwrap();
        assert_eq!(ensure_hosted_inference_for_spawn_at(&app_config, "http://127.0.0.1:1", "http://127.0.0.1:1"), Ok(()));
        let _ = fs::remove_dir_all(dir);
    }
}
