//! Hosted Alinery models (Track B). Catalog/mint/revoke against accounts.alinery.ai;
//! isolated OMP `models.yml`; never puts `inf_…` on IPC or in the OMP child env.
//!
//! Contract: envelope fields are frozen; `models[]` membership and `price` values are live.

use crate::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const HOSTED_PROVIDER: &str = "alinery";
const INFERENCE_JSON: &str = "inference.json";
const INFERENCE_SKEW_SECS: u64 = 120;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct HostedModel {
    pub id: String,
    pub name: String,
    pub context_window: u64,
    pub max_tokens: u64,
    #[serde(default)]
    pub price: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct HostedCatalog {
    pub provider: String,
    pub default_model: String,
    pub base_url: String,
    pub plans_url: String,
    pub models: Vec<HostedModel>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostedModelView {
    pub id: String,
    pub name: String,
    pub context_window: u64,
    pub max_tokens: u64,
    pub price: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostedCatalogView {
    pub provider: String,
    pub default_model: String,
    pub base_url: String,
    pub plans_url: String,
    pub models: Vec<HostedModelView>,
    pub ready: bool,
    pub upsell: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InferenceFile {
    token: String,
    expires_at: u64,
    #[serde(default)]
    session_id: String,
    catalog: HostedCatalog,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HostedApiError {
    pub status: u16,
    pub error: String,
    pub code: Option<String>,
}

pub(crate) fn is_paid_plan(id: &str) -> bool {
    matches!(id, "founders" | "teams")
}

pub(crate) fn paid_from_stored_plan(plan: Option<&str>, paid: bool) -> bool {
    paid || matches!(plan, Some("Founders Edition" | "Teams"))
}

pub(crate) fn hosted_fixture(accounts_url: &str) -> HostedCatalog {
    let origin = accounts_url.trim_end_matches('/');
    HostedCatalog {
        provider: HOSTED_PROVIDER.into(),
        default_model: "alinery/Qwen3.6-35B-A3B".into(),
        base_url: "https://inference.alinery.ai/v1".into(),
        plans_url: format!("{origin}/plans"),
        models: vec![
            HostedModel {
                id: "Qwen3.6-35B-A3B".into(),
                name: "Qwen3.6-35B-A3B".into(),
                context_window: 262144,
                max_tokens: 32768,
                price: Some(1),
            },
            HostedModel {
                id: "DeepSeek-V4-Pro-0813".into(),
                name: "DeepSeek-V4-Pro-0813".into(),
                context_window: 1048576,
                max_tokens: 32768,
                price: Some(2),
            },
            HostedModel {
                id: "GLM-5.3-Flash".into(),
                name: "GLM-5.3-Flash".into(),
                context_window: 1048576,
                max_tokens: 32768,
                price: Some(1),
            },
        ],
    }
}

pub(crate) fn inference_path(config_dir: &Path) -> PathBuf {
    config_dir.join(INFERENCE_JSON)
}

pub(crate) fn models_yml_path(app_config: &Path) -> PathBuf {
    alinery_core::omp_home_dirs(app_config).0.join("models.yml")
}

fn require_alinery_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.contains('/') {
        return Err("hosted model id must be non-empty and contain no slash".into());
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
    if catalog.base_url.is_empty() || catalog.plans_url.is_empty() {
        return Err("hosted catalog is missing base_url or plans_url".into());
    }
    for model in &catalog.models {
        require_alinery_id(&model.id)?;
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

pub(crate) fn parse_hosted_error(status: u16, body: &[u8]) -> HostedApiError {
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

pub(crate) fn parse_hosted_catalog_body(body: &[u8]) -> Result<HostedCatalog, String> {
    let value: Value = serde_json::from_slice(body).map_err(|e| format!("bad hosted catalog: {e}"))?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(parse_hosted_error(200, body).error);
    }
    catalog_from_value(&value, true)
}

pub(crate) fn parse_inference_session_body(body: &[u8]) -> Result<(String, u64, HostedCatalog), String> {
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
    if value.is_empty() || value.chars().any(|c| c.is_whitespace() || ":#{}[]&*?|>'!%@`,\"'".contains(c)) {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

pub(crate) fn render_models_yml(catalog: &HostedCatalog, token: &str) -> String {
    let mut out = String::from("providers:\n  alinery:\n");
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

pub(crate) fn write_inference_file(path: &Path, token: &str, expires_at: u64, session_id: &str, catalog: &HostedCatalog) -> Result<(), String> {
    let file = InferenceFile {
        token: token.to_string(),
        expires_at,
        session_id: session_id.to_string(),
        catalog: catalog.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
    write_owner_only_bytes(path, &bytes)
}

pub(crate) fn write_hosted_models_yml(app_config: &Path, catalog: &HostedCatalog, token: &str) -> Result<(), String> {
    let path = models_yml_path(app_config);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let yaml = render_models_yml(catalog, token);
    let tmp = path.with_extension("yml.tmp");
    fs::write(&tmp, yaml.as_bytes()).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename {}: {e}", path.display()))
}

pub(crate) fn wipe_hosted_files(config_dir: &Path, app_config: &Path) {
    let _ = fs::remove_file(inference_path(config_dir));
    let _ = fs::remove_file(models_yml_path(app_config));
}

fn model_view(model: HostedModel) -> HostedModelView {
    HostedModelView {
        id: model.id,
        name: model.name,
        context_window: model.context_window,
        max_tokens: model.max_tokens,
        price: model.price,
    }
}

fn view_from(catalog: HostedCatalog, ready: bool, upsell: Option<&str>, source: &str) -> HostedCatalogView {
    HostedCatalogView {
        provider: catalog.provider,
        default_model: catalog.default_model,
        base_url: catalog.base_url,
        plans_url: catalog.plans_url,
        models: catalog.models.into_iter().map(model_view).collect(),
        ready,
        upsell: upsell.map(str::to_string),
        source: source.into(),
    }
}

fn upsell_for(signed_in: bool, paid: bool) -> Option<&'static str> {
    if !signed_in {
        Some("sign-in")
    } else if !paid {
        Some("get-credits")
    } else {
        None
    }
}

pub(crate) fn resolve_hosted_catalog(live: Option<HostedCatalog>, minted: Option<HostedCatalog>, fixture: HostedCatalog, signed_in: bool, paid: bool) -> HostedCatalogView {
    let ready = minted.is_some();
    let upsell = upsell_for(signed_in, paid);
    if let Some(catalog) = live {
        return view_from(catalog, ready, upsell, "live");
    }
    if let Some(catalog) = minted {
        return view_from(catalog, true, upsell, "minted");
    }
    view_from(fixture, false, upsell, "fixture")
}

fn hosted_headers(access_token: Option<&str>) -> Vec<String> {
    let mut headers = vec!["Accept: application/json".into(), "Content-Type: application/json".into()];
    if let Some(token) = access_token {
        headers.push(format!("Authorization: Bearer {token}"));
    }
    headers
}

fn fetch_live_catalog(accounts_url: &str) -> Result<HostedCatalog, HostedApiError> {
    let url = format!("{}/api/desktop/hosted-models", accounts_url.trim_end_matches('/'));
    let http = curl_http(&url, &hosted_headers(None), None).map_err(|e| HostedApiError { status: 0, error: e, code: None })?;
    if !(200..300).contains(&http.status) {
        return Err(parse_hosted_error(http.status, &http.body));
    }
    parse_hosted_catalog_body(&http.body).map_err(|error| HostedApiError {
        status: http.status,
        error,
        code: None,
    })
}

fn mint_inference_session(accounts_url: &str, access_token: &str, session_id: &str) -> Result<(String, u64, HostedCatalog), HostedApiError> {
    let url = format!("{}/api/desktop/inference-session", accounts_url.trim_end_matches('/'));
    let body = json!({ "session_id": session_id }).to_string();
    let http = curl_http(&url, &hosted_headers(Some(access_token)), Some(&body)).map_err(|e| HostedApiError { status: 0, error: e, code: None })?;
    if !(200..300).contains(&http.status) {
        return Err(parse_hosted_error(http.status, &http.body));
    }
    parse_inference_session_body(&http.body).map_err(|error| HostedApiError {
        status: http.status,
        error,
        code: None,
    })
}

fn delete_inference_session(accounts_url: &str, access_token: &str, session_id: &str) {
    let url = format!("{}/api/desktop/inference-session", accounts_url.trim_end_matches('/'));
    let body = json!({ "session_id": session_id }).to_string();
    let _ = curl_http_method(&url, "DELETE", &hosted_headers(Some(access_token)), Some(&body));
}

fn apply_default_model_role(app_config: &Path, default_model: &str) {
    let (agent_dir, _) = alinery_core::omp_home_dirs(app_config);
    let _ = ensure_default_model_role(&agent_dir, default_model);
}

pub(crate) fn sync_hosted_inference(config_dir: &Path, app_config: &Path, accounts_url: &str, access_token: &str, session_id: &str, paid: bool) {
    if !paid {
        return;
    }
    let inf_path = inference_path(config_dir);
    let now = now_secs();
    let existing = load_inference_file(&inf_path);
    if existing.as_ref().is_some_and(|file| inference_unexpired(file, now)) {
        if let Some(file) = existing {
            if let Ok(live) = fetch_live_catalog(accounts_url) {
                let _ = write_inference_file(&inf_path, &file.token, file.expires_at, session_id, &live);
                let _ = write_hosted_models_yml(app_config, &live, &file.token);
                apply_default_model_role(app_config, &live.default_model);
            } else {
                let _ = write_hosted_models_yml(app_config, &file.catalog, &file.token);
            }
        }
        return;
    }
    if let Ok((token, expires_at, catalog)) = mint_inference_session(accounts_url, access_token, session_id) {
        let _ = write_inference_file(&inf_path, &token, expires_at, session_id, &catalog);
        let _ = write_hosted_models_yml(app_config, &catalog, &token);
        apply_default_model_role(app_config, &catalog.default_model);
    }
}

pub(crate) fn revoke_hosted_inference(config_dir: &Path, app_config: &Path, accounts_url: &str, access_token: Option<&str>, session_id: Option<&str>) {
    if let (Some(token), Some(session)) = (access_token, session_id) {
        if !token.is_empty() && !session.is_empty() {
            delete_inference_session(accounts_url, token, session);
        }
    }
    wipe_hosted_files(config_dir, app_config);
}

pub(crate) fn hosted_catalog_at(config_dir: &Path, accounts_url: &str, signed_in: bool, paid: bool) -> HostedCatalogView {
    let live = fetch_live_catalog(accounts_url).ok();
    let minted = load_inference_file(&inference_path(config_dir)).and_then(|file| inference_unexpired(&file, now_secs()).then_some(file.catalog));
    resolve_hosted_catalog(live, minted, hosted_fixture(accounts_url), signed_in, paid)
}

pub(crate) fn unsigned_hosted_catalog(accounts_url: &str) -> HostedCatalogView {
    view_from(hosted_fixture(accounts_url), false, Some("sign-in"), "fixture")
}
