//! Hosted Alinery models (Track B). Catalog/mint/revoke against accounts.alinery.ai;
//! isolated OMP `models.yml`; never puts `inf_…` on IPC or in the OMP child env.
//!
//! Contract: envelope fields are frozen; `models[]` membership and `price` values are live.
//! `GET /api/desktop/hosted-models` is unauthenticated — unsigned browse uses that, not a
//! compiled-in list. Mint/credits still need a paid session.

use crate::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) use alinery_core::{
    inference_path, is_hosted_model, parse_hosted_catalog_body, parse_hosted_error, HostedApiError, HostedCatalog, HostedModel, HOSTED_MODEL_UNAVAILABLE,
};

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

#[cfg(not(test))]
static CREDITS_SNAPSHOT: std::sync::Mutex<Option<DesktopCredits>> = std::sync::Mutex::new(None);

// Tests share the process and run in parallel; sign-out clears this snapshot. A thread-local
// copy keeps the 503 keep-last path from racing another test's clear.
#[cfg(test)]
thread_local! {
    static CREDITS_SNAPSHOT: std::cell::RefCell<Option<DesktopCredits>> = const { std::cell::RefCell::new(None) };
}

pub(crate) fn store_credits_snapshot(credits: Option<DesktopCredits>) {
    #[cfg(not(test))]
    if let Ok(mut guard) = CREDITS_SNAPSHOT.lock() {
        *guard = credits;
    }
    #[cfg(test)]
    CREDITS_SNAPSHOT.with(|slot| *slot.borrow_mut() = credits);
}

pub(crate) fn last_credits_snapshot() -> Option<DesktopCredits> {
    #[cfg(not(test))]
    {
        CREDITS_SNAPSHOT.lock().ok().and_then(|guard| guard.clone())
    }
    #[cfg(test)]
    CREDITS_SNAPSHOT.with(|slot| slot.borrow().clone())
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
        provider: "alinery".into(),
        default_model: String::new(),
        base_url: "https://inference.alinery.ai/v1".into(),
        plans_url: format!("{origin}/plans"),
        models: Vec::new(),
    }
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

fn apply_default_role_after_sync(config_dir: &Path, app_config: &Path) {
    let Ok(bytes) = fs::read(inference_path(config_dir)) else {
        return;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return;
    };
    let Some(default_model) = value.get("catalog").and_then(|catalog| catalog.get("default_model")).and_then(Value::as_str) else {
        return;
    };
    apply_default_model_role(app_config, default_model);
}

fn apply_default_model_role(app_config: &Path, default_model: &str) {
    let (agent_dir, _) = alinery_core::omp_home_dirs(app_config);
    let _ = ensure_default_model_role(&agent_dir, default_model);
}

pub(crate) fn sync_hosted_inference(config_dir: &Path, app_config: &Path, accounts_url: &str, access_token: &str, session_id: &str, paid: bool) -> Result<(), String> {
    alinery_core::sync_hosted_inference(config_dir, app_config, accounts_url, access_token, session_id, paid)?;
    if paid {
        apply_default_role_after_sync(config_dir, app_config);
    }
    Ok(())
}

pub(crate) fn revoke_hosted_inference(config_dir: &Path, app_config: &Path, accounts_url: &str, access_token: Option<&str>, session_id: Option<&str>) {
    alinery_core::revoke_hosted_inference(config_dir, app_config, accounts_url, access_token, session_id);
}

pub(crate) fn hosted_catalog_at(config_dir: &Path, accounts_url: &str, signed_in: bool, paid: bool) -> HostedCatalogView {
    let live = fetch_live_catalog(accounts_url).ok();
    let minted = alinery_core::minted_catalog_if_unexpired(config_dir);
    resolve_hosted_catalog(live, minted, accounts_url, signed_in, paid)
}

pub(crate) fn unsigned_hosted_catalog(accounts_url: &str) -> HostedCatalogView {
    resolve_hosted_catalog(fetch_live_catalog(accounts_url).ok(), None, accounts_url, false, false)
}
