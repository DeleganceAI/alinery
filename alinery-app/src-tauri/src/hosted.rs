//! Hosted Alinery models (Track B). Catalog/mint/revoke against accounts.alinery.ai;
//! isolated OMP `models.yml`; never puts `inf_…` on IPC or in the OMP child env.
//!
//! Contract: envelope fields are frozen; `models[]` membership and `price` values are live.
//! `GET /api/desktop/hosted-models` is unauthenticated — unsigned browse uses that, not a
//! compiled-in list. Mint/credits still need a paid session.

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance_cents: Option<i64>,
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

/// Track B desktop credits snapshot. Display only — never price tokens from `balance_cents`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct DesktopCredits {
    pub ok: bool,
    pub plan: String,
    pub included_cents: i64,
    pub purchased_cents: i64,
    pub balance_cents: i64,
    pub used_this_period_cents: i64,
    #[serde(default)]
    pub cutoff: bool,
    #[serde(default)]
    pub auto_reload: bool,
    #[serde(default)]
    pub last_reload_error: Option<String>,
    pub account_url: String,
    pub plans_url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopCreditsView {
    pub visible: bool,
    pub signed_out: bool,
    pub plan: Option<String>,
    pub paid: bool,
    pub balance_cents: Option<i64>,
    pub cutoff: bool,
    pub upsell: Option<String>,
    pub account_url: Option<String>,
    pub plans_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum CreditsFetchError {
    Status(u16),
    Parse(String),
    Transport(String),
}

static CREDITS_SNAPSHOT: std::sync::Mutex<Option<DesktopCredits>> = std::sync::Mutex::new(None);

#[cfg(test)]
pub(crate) static CREDITS_SNAPSHOT_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn store_credits_snapshot(credits: Option<DesktopCredits>) {
    if let Ok(mut guard) = CREDITS_SNAPSHOT.lock() {
        *guard = credits;
    }
}

pub(crate) fn last_credits_snapshot() -> Option<DesktopCredits> {
    CREDITS_SNAPSHOT.lock().ok().and_then(|guard| guard.clone())
}

pub(crate) fn credits_hidden() -> DesktopCreditsView {
    DesktopCreditsView {
        visible: false,
        signed_out: false,
        plan: None,
        paid: false,
        balance_cents: None,
        cutoff: false,
        upsell: None,
        account_url: None,
        plans_url: None,
    }
}

pub(crate) fn credits_signed_out() -> DesktopCreditsView {
    DesktopCreditsView {
        visible: false,
        signed_out: true,
        plan: None,
        paid: false,
        balance_cents: None,
        cutoff: false,
        upsell: None,
        account_url: None,
        plans_url: None,
    }
}

pub(crate) fn credits_view_from(credits: &DesktopCredits) -> DesktopCreditsView {
    let paid = is_paid_plan(&credits.plan);
    let upsell = if !paid {
        Some("subscribe")
    } else if credits.balance_cents <= 0 || credits.cutoff {
        Some("buy-credits")
    } else {
        None
    };
    DesktopCreditsView {
        visible: true,
        signed_out: false,
        plan: Some(credits.plan.clone()),
        paid,
        balance_cents: Some(credits.balance_cents),
        cutoff: credits.cutoff,
        upsell: upsell.map(str::to_string),
        account_url: Some(credits.account_url.clone()),
        plans_url: Some(credits.plans_url.clone()),
    }
}

pub(crate) fn parse_desktop_credits_body(body: &[u8]) -> Result<DesktopCredits, String> {
    let value: Value = serde_json::from_slice(body).map_err(|e| format!("bad desktop credits: {e}"))?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(parse_hosted_error(200, body).error);
    }
    serde_json::from_value(value).map_err(|e| format!("bad desktop credits: {e}"))
}

pub(crate) fn fetch_desktop_credits(accounts_url: &str, access_token: &str) -> Result<DesktopCredits, CreditsFetchError> {
    let url = format!("{}/api/desktop/credits", accounts_url.trim_end_matches('/'));
    let http = curl_http(&url, &hosted_headers(Some(access_token)), None).map_err(CreditsFetchError::Transport)?;
    if http.status == 200 {
        return parse_desktop_credits_body(&http.body).map_err(CreditsFetchError::Parse);
    }
    Err(CreditsFetchError::Status(http.status))
}

pub(crate) fn apply_credits_to_hosted_view(mut view: HostedCatalogView, credits: &DesktopCreditsView) -> HostedCatalogView {
    if credits.signed_out {
        view.ready = false;
        view.upsell = Some("sign-in".into());
        view.balance_cents = None;
        return view;
    }
    if !credits.visible {
        return view;
    }
    view.balance_cents = credits.balance_cents;
    if let Some(upsell) = credits.upsell.as_deref() {
        view.upsell = Some(upsell.to_string());
        if upsell == "subscribe" || upsell == "buy-credits" {
            view.ready = false;
        }
    }
    view
}

pub(crate) fn is_paid_plan(id: &str) -> bool {
    matches!(id, "founders" | "teams")
}

pub(crate) fn paid_from_stored_plan(plan: Option<&str>, paid: bool) -> bool {
    paid || matches!(plan, Some("Founders Edition" | "Teams"))
}

fn empty_hosted_catalog(accounts_url: &str) -> HostedCatalog {
    let origin = accounts_url.trim_end_matches('/');
    HostedCatalog {
        provider: HOSTED_PROVIDER.into(),
        default_model: String::new(),
        base_url: "https://inference.alinery.ai/v1".into(),
        plans_url: format!("{origin}/plans"),
        models: Vec::new(),
    }
}

pub(crate) fn inference_path(config_dir: &Path) -> PathBuf {
    config_dir.join(INFERENCE_JSON)
}

pub(crate) fn models_yml_path(app_config: &Path) -> PathBuf {
    alinery_core::omp_home_dirs(app_config).0.join("models.yml")
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
    if value.is_empty() || value.chars().any(|c| c.is_control() || c.is_whitespace() || ":#{}[]&*?|>'!%@`,\"'".contains(c)) {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r"))
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
    write_owner_only_bytes(&models_yml_path(app_config), render_models_yml(catalog, token).as_bytes())
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
        balance_cents: None,
    }
}

fn upsell_for(signed_in: bool, paid: bool) -> Option<&'static str> {
    if !signed_in {
        Some("sign-in")
    } else if !paid {
        Some("subscribe")
    } else {
        None
    }
}

pub(crate) fn resolve_hosted_catalog(live: Option<HostedCatalog>, minted: Option<HostedCatalog>, accounts_url: &str, signed_in: bool, paid: bool) -> HostedCatalogView {
    let ready = paid && minted.is_some();
    let upsell = upsell_for(signed_in, paid);
    if let Some(catalog) = live {
        return view_from(catalog, ready, upsell, "live");
    }
    if let Some(catalog) = minted {
        return view_from(catalog, ready, upsell, "minted");
    }
    view_from(empty_hosted_catalog(accounts_url), false, upsell, "empty")
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
    match curl_http_method(&url, "DELETE", &hosted_headers(Some(access_token)), Some(&body)) {
        Ok(http) if (200..300).contains(&http.status) => {}
        Ok(http) => eprintln!("delete inference session: HTTP {}", http.status),
        Err(e) => eprintln!("delete inference session: {e}"),
    }
}

fn apply_default_model_role(app_config: &Path, default_model: &str) {
    let (agent_dir, _) = alinery_core::omp_home_dirs(app_config);
    let _ = ensure_default_model_role(&agent_dir, default_model);
}

pub(crate) fn sync_hosted_inference(config_dir: &Path, app_config: &Path, accounts_url: &str, access_token: &str, session_id: &str, paid: bool) {
    if !paid {
        revoke_hosted_inference(config_dir, app_config, accounts_url, Some(access_token), Some(session_id));
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
    resolve_hosted_catalog(live, minted, accounts_url, signed_in, paid)
}

pub(crate) fn unsigned_hosted_catalog(accounts_url: &str) -> HostedCatalogView {
    resolve_hosted_catalog(fetch_live_catalog(accounts_url).ok(), None, accounts_url, false, false)
}
