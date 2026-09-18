//! Loopback pairing with `accounts.alinery.ai` and the titlebar account chip's backend.
//!
//! Copies Linear's loopback idea from connections.rs (ephemeral listener, 180s wait, ignore
//! unsolicited requests, HTML 200, opener, curl) without reusing its port or path.
//! Session lives in owner-only `auth.json` under the app config dir (see
//! docs/architecture/desktop-pairing.md). The pairing nonce is memory-only for the handshake.
use crate::*;
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri_plugin_opener::OpenerExt;

const DEFAULT_ACCOUNTS_URL: &str = "https://accounts.alinery.ai";
const SUPABASE_URL: &str = "https://cppinfludeyomoyinrkl.supabase.co";
// Publishable key, not a secret — safe to bake, same as Linear's OAuth client id. Never bake
// SUPABASE_SERVICE_ROLE_KEY / sb_secret_… here.
const SUPABASE_PUBLISHABLE_KEY: &str = "sb_publishable_BJ356xdHfbL0B0BeHfqf7A_QBDFiAto";
const AUTH_JSON_NAME: &str = "auth.json";
// The pairing code dies 60s after the web 302 (see docs/architecture/desktop-pairing.md), but a
// human has to sign in first — Linear gives that the same 180s.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(180);
// Both the accept loop and the post-callback check return exactly this; AccountMenu.tsx
// matches /cancelled/i so a user-initiated abort stays silent instead of toasting.
const SIGN_IN_CANCELLED: &str = "Sign-in cancelled";
// Refresh a little before actual expiry so clock drift and request latency do not race a token
// that is valid the moment we read it but expired by the time GoTrue sees it.
const REFRESH_SKEW_SECS: u64 = 120;
const REQUEST_LINE_LIMIT: usize = 8192;

/// One in-flight pairing. `cancelled` is set by Cancel sign-in; `committed` is set
/// under the credential lock after `auth.json` is renamed into place. Cancel and
/// commit inspect both under that lock so a successful cancel cannot land after persist.
#[derive(Debug)]
pub(crate) struct SignInAttempt {
    cancelled: AtomicBool,
    committed: AtomicBool,
}

impl SignInAttempt {
    pub(crate) fn fresh() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            committed: AtomicBool::new(false),
        }
    }

    #[cfg(test)]
    pub(crate) fn cancelled() -> Self {
        let attempt = Self::fresh();
        attempt.cancelled.store(true, Ordering::SeqCst);
        attempt
    }

    #[cfg(test)]
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    #[cfg(test)]
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

static SIGN_IN_IN_FLIGHT: Mutex<Option<Arc<SignInAttempt>>> = Mutex::new(None);
// Every auth.json mutation goes through this lock so a refresh that started for
// session A cannot overwrite or delete a newer session B. Network work stays
// outside the lock; compare-and-mutate is one critical section. The inner mutex is
// process-local; the flock at `auth.json.lock` serializes a second Alinery window
// that shares the same config dir (see docs/architecture/desktop-pairing.md).
static CREDENTIALS: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub(crate) static AFTER_CREDENTIAL_COMPARE: Mutex<Option<Box<dyn Fn() + Send>>> = Mutex::new(None);
#[cfg(test)]
pub(crate) static BEFORE_SIGN_IN_PERSIST: Mutex<Option<Box<dyn Fn() + Send>>> = Mutex::new(None);
#[cfg(test)]
pub(crate) static CREDENTIAL_HOOK_TEST: Mutex<()> = Mutex::new(());

pub(crate) fn accounts_url() -> String {
    std::env::var("ALINERY_ACCOUNTS_URL")
        .ok()
        .map(|value| value.trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_ACCOUNTS_URL.to_string())
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct AccountUser {
    #[serde(default)]
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) email: Option<String>,
    #[serde(default)]
    pub(crate) providers: Vec<String>,
}

/// What `auth.json` holds. Never leaves this module — commands return `AccountStatus`.
///
/// `session_id` is minted once at pairing and survives every token rotation, because the
/// refresh token does not: a mount refresh can rotate R1→R2 while sign-out still holds R1.
/// Comparing by refresh token then makes sign-out lose to its own app's rotation and leave
/// R2 on disk. Every compare-and-mutate below therefore keys on `session_id`.
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct AccountTokens {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    user: AccountUser,
    #[serde(default)]
    plan: Option<String>,
    #[serde(default)]
    paid: bool,
    session_id: String,
}

/// What the frontend gets. No tokens, ever — see docs/architecture/desktop-pairing.md
/// "Frontend never sees access_token / refresh_token".
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountStatus {
    pub(crate) signed_in: bool,
    pub(crate) email: Option<String>,
    pub(crate) plan: Option<String>,
    pub(crate) paid: bool,
    pub(crate) unavailable: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountSignOutResult {
    pub(crate) signed_in: bool,
    pub(crate) email: Option<String>,
    pub(crate) plan: Option<String>,
    pub(crate) paid: bool,
    pub(crate) unavailable: bool,
    pub(crate) remote_revoked: bool,
}

const SIGNED_OUT: AccountStatus = AccountStatus {
    signed_in: false,
    email: None,
    plan: None,
    paid: false,
    unavailable: false,
};

#[derive(Debug)]
pub(crate) enum AccountAuthError {
    Corrupt(String),
    InvalidRefreshToken(String),
    Transient(String),
}

impl AccountAuthError {
    pub(crate) fn clears_credential(&self) -> bool {
        matches!(self, Self::Corrupt(_) | Self::InvalidRefreshToken(_))
    }
}

impl std::fmt::Display for AccountAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Corrupt(s) | Self::InvalidRefreshToken(s) | Self::Transient(s) => f.write_str(s),
        }
    }
}

pub(crate) fn plan_label(plan: &str) -> String {
    match plan {
        "founders" => "Founders Edition".into(),
        "teams" => "Teams".into(),
        "free" => "Free".into(),
        other => other.to_string(),
    }
}

/// `Ok(None)` is a successful response carrying no entitlement row — the caller must clear a
/// cached plan. `Err` is a failed or unparseable lookup, where the cached plan is kept.
pub(crate) fn parse_entitlement_id(body: &[u8]) -> Result<Option<String>, String> {
    let rows: Vec<serde_json::Value> = serde_json::from_slice(body).map_err(|e| format!("bad entitlement response: {e}"))?;
    let plan = rows
        .first()
        .and_then(|row| row.get("plan"))
        .and_then(|value| value.as_str())
        .filter(|plan| !plan.is_empty());
    Ok(plan.map(str::to_string))
}

#[cfg(test)]
pub(crate) fn parse_entitlement_plan(body: &[u8]) -> Result<Option<String>, String> {
    Ok(parse_entitlement_id(body)?.as_deref().map(plan_label))
}

/// Test-mode and live-mode entitlements share one table: `SUPABASE_URL` is a constant with no
/// override, so every environment queries the same project, and `livemode` is the only thing
/// telling a Stripe test row from a real one. The query has no ordering and the caller takes the
/// first row, so an unfiltered lookup would pick arbitrarily for anyone holding both.
pub(crate) fn entitlement_url(base: &str, livemode: bool) -> String {
    format!("{base}/rest/v1/entitlements?select=plan&livemode=eq.{livemode}")
}

/// The pairing origin is the one signal that does vary by environment: anything other than
/// production is a local or staging setup, which pairs against Stripe test mode.
pub(crate) fn production_livemode() -> bool {
    accounts_url() == DEFAULT_ACCOUNTS_URL
}

fn fetch_account_plan_at(base: &str, access_token: &str) -> Result<(Option<String>, bool), String> {
    let http = curl_http(
        &entitlement_url(base, production_livemode()),
        &[
            format!("apikey: {SUPABASE_PUBLISHABLE_KEY}"),
            format!("Authorization: Bearer {access_token}"),
            "Accept: application/json".into(),
        ],
        None,
    )?;
    if !(200..300).contains(&http.status) {
        return Err(format!("entitlement HTTP {}", http.status));
    }
    let id = parse_entitlement_id(&http.body)?;
    let paid = id.as_deref().is_some_and(is_paid_plan);
    Ok((id.as_deref().map(plan_label), paid))
}

fn status_for(tokens: &AccountTokens) -> AccountStatus {
    AccountStatus {
        signed_in: true,
        email: Some(display_label(&tokens.user)),
        plan: tokens.plan.clone(),
        paid: paid_from_stored_plan(tokens.plan.as_deref(), tokens.paid),
        unavailable: false,
    }
}

fn status_unavailable(tokens: &AccountTokens) -> AccountStatus {
    AccountStatus {
        signed_in: true,
        email: Some(display_label(&tokens.user)),
        plan: tokens.plan.clone(),
        paid: paid_from_stored_plan(tokens.plan.as_deref(), tokens.paid),
        unavailable: true,
    }
}

/// The product rule from docs/architecture/desktop-pairing.md: "email (or providers[0] if email is null)".
pub(crate) fn display_label(user: &AccountUser) -> String {
    user.email.clone().unwrap_or_else(|| user.providers.first().cloned().unwrap_or_default())
}

/// Parses the loopback GET the browser makes after `/desktop-login` 302s here. Path is `/`
/// with `?code&nonce` — deliberately not Linear's `/oauth/linear/callback`.
pub(crate) fn parse_desktop_login_callback(request: &str) -> Result<(String, String), String> {
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "invalid pairing callback request".to_string())?;
    let (path, query) = target.split_once('?').ok_or_else(|| "pairing callback is missing query parameters".to_string())?;
    if path != "/" {
        return Err("unexpected pairing callback path".into());
    }
    let mut values = HashMap::new();
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        values.insert(percent_decode(key)?, percent_decode(value)?);
    }
    let code = values.get("code").cloned().ok_or_else(|| "pairing callback is missing code".to_string())?;
    let nonce = values.get("nonce").cloned().ok_or_else(|| "pairing callback is missing nonce".to_string())?;
    Ok((code, nonce))
}

/// Browser-facing page after `/desktop-login` 302s here. Inline tokens from
/// accounts.alinery.ai (`DESIGN.md`) so the tab is not a raw user-agent page.
pub(crate) fn loopback_html(ok: bool) -> String {
    // Neutral wording: the loopback handler has only received the code. Exchange
    // and auth.json persistence happen after this response is already sent.
    let (title, lede) = if ok {
        ("Authorization received", "Return to Alinery.")
    } else {
        ("This link expired", "Return to Alinery and try again.")
    };
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · Alinery</title>
<style>
:root {{
  --canvas: #000104;
  --surface: #08090b;
  --text-strong: #fffefa;
  --text: #f4f1ea;
  --muted: #9b9b97;
  --border: rgb(244 241 234 / 0.12);
  --font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
}}
@media (prefers-color-scheme: light) {{
  :root {{
    --canvas: #fffefa;
    --surface: #ffffff;
    --text-strong: #0a0a0a;
    --text: #0a0a0a;
    --muted: #60625e;
    --border: rgb(10 10 10 / 0.12);
  }}
}}
* {{ box-sizing: border-box; }}
html, body {{ margin: 0; min-height: 100%; }}
body {{
  min-height: 100vh;
  display: flex;
  justify-content: center;
  padding: 32px 16px 64px;
  background: var(--canvas);
  color: var(--text);
  font: 400 14px/1.45 var(--font-ui);
}}
main {{ width: 100%; max-width: 420px; }}
.kicker {{
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.02em;
}}
h1 {{
  margin: 0 0 16px;
  color: var(--text-strong);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.03em;
}}
.lede {{ margin: 0; color: var(--muted); }}
</style>
</head>
<body>
<main>
<p class="kicker">Alinery</p>
<h1>{title}</h1>
<p class="lede">{lede}</p>
</main>
</body>
</html>"#
    )
}

fn write_loopback_page(stream: &mut TcpStream, ok: bool) {
    let body = loopback_html(ok);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}

fn read_request_line(stream: &mut TcpStream) -> Result<String, ()> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 256];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if let Some(end) = buf.iter().position(|&b| b == b'\n') {
                    buf.truncate(end + 1);
                    return Ok(String::from_utf8_lossy(&buf).into_owned());
                }
                if buf.len() >= REQUEST_LINE_LIMIT {
                    return Err(());
                }
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return Err(()),
        }
    }
    if buf.is_empty() {
        Err(())
    } else {
        Ok(String::from_utf8_lossy(&buf).into_owned())
    }
}

#[allow(dead_code)]
pub(crate) fn wait_for_desktop_login_callback(listener: TcpListener, expected_nonce: &str) -> Result<String, String> {
    wait_for_desktop_login_callback_until(listener, expected_nonce, &SignInAttempt::fresh(), Instant::now() + SIGN_IN_TIMEOUT)
}

/// Nonblocking accept loop with a hard deadline and a cancel flag. HTML 200 on every hit;
/// ignore anything that is not our own code+nonce rather than erroring the whole wait.
pub(crate) fn wait_for_desktop_login_callback_until(listener: TcpListener, expected_nonce: &str, attempt: &SignInAttempt, deadline: Instant) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    loop {
        if attempt.cancelled.load(Ordering::SeqCst) {
            return Err(SIGN_IN_CANCELLED.into());
        }
        if Instant::now() >= deadline {
            return Err("Sign-in timed out".into());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err("Sign-in timed out".into());
                }
                // Generous relative to a loopback round-trip — this only guards against a client
                // that connects and never sends anything, not normal scheduling jitter. Capped by
                // the overall deadline so a stalled client cannot stretch the wait past 180s.
                let read_timeout = remaining.min(Duration::from_secs(10));
                if stream.set_read_timeout(Some(read_timeout)).is_err() {
                    write_loopback_page(&mut stream, false);
                    continue;
                }
                let request = match read_request_line(&mut stream) {
                    Ok(line) => line,
                    Err(()) => {
                        write_loopback_page(&mut stream, false);
                        continue;
                    }
                };
                let parsed = parse_desktop_login_callback(&request);
                let ok = parsed.as_ref().is_ok_and(|(_, nonce)| nonce == expected_nonce);
                write_loopback_page(&mut stream, ok);
                match parsed {
                    Ok((code, nonce)) if nonce == expected_nonce => return Ok(code),
                    _ => continue,
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(format!("receive pairing callback: {error}")),
        }
    }
}

pub(crate) fn begin_sign_in_attempt() -> Result<Arc<SignInAttempt>, String> {
    let mut slot = SIGN_IN_IN_FLIGHT.lock().map_err(|e| e.to_string())?;
    if slot
        .as_ref()
        .is_some_and(|attempt| !attempt.cancelled.load(Ordering::SeqCst) && !attempt.committed.load(Ordering::SeqCst))
    {
        return Err("Sign-in already in progress".into());
    }
    let attempt = Arc::new(SignInAttempt::fresh());
    *slot = Some(attempt.clone());
    Ok(attempt)
}

/// Test-only teardown: production unregisters through `SignInGuard`, which checks identity.
#[cfg(test)]
pub(crate) fn end_sign_in_attempt() {
    if let Ok(mut slot) = SIGN_IN_IN_FLIGHT.lock() {
        *slot = None;
    }
}

/// Owns the `Arc` it registered. A cancelled attempt can be replaced in the slot while its
/// worker is still unwinding, and clearing the slot blind would unregister that replacement —
/// leaving Cancel sign-in a no-op for a pairing that is still live.
pub(crate) struct SignInGuard(pub(crate) Arc<SignInAttempt>);

impl Drop for SignInGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = SIGN_IN_IN_FLIGHT.lock() {
            if slot.as_ref().is_some_and(|current| Arc::ptr_eq(current, &self.0)) {
                *slot = None;
            }
        }
    }
}

#[derive(Deserialize)]
struct ExchangeResponse {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_at: Option<u64>,
    #[serde(default)]
    user: Option<AccountUser>,
}

/// `base` is injected so the pairing backend is a parameter, not a hardcoded constant —
/// the production URL stays at the command boundary in `sign_in_blocking`.
fn exchange_pairing_code_at(base: &str, code: &str, nonce: &str) -> Result<AccountTokens, String> {
    let body = serde_json::to_string(&json!({ "code": code, "nonce": nonce })).map_err(|e| e.to_string())?;
    let out = curl_request(&format!("{base}/api/desktop/exchange"), &["Content-Type: application/json".into()], Some(&body))?;
    let value: ExchangeResponse = serde_json::from_slice(&out).map_err(|e| format!("bad pairing exchange response: {e}"))?;
    if !value.ok {
        return Err(value.error.unwrap_or_else(|| "This pairing code is invalid or expired.".into()));
    }
    Ok(AccountTokens {
        access_token: value
            .access_token
            .filter(|t| !t.is_empty())
            .ok_or_else(|| "pairing exchange response is missing access_token".to_string())?,
        refresh_token: value
            .refresh_token
            .filter(|t| !t.is_empty())
            .ok_or_else(|| "pairing exchange response is missing refresh_token".to_string())?,
        expires_at: value.expires_at.ok_or_else(|| "pairing exchange response is missing expires_at".to_string())?,
        user: value.user.ok_or_else(|| "pairing exchange response is missing user".to_string())?,
        plan: None,
        paid: false,
        // Minted here, then carried through every rotation — see `AccountTokens`.
        session_id: uuid::Uuid::new_v4().simple().to_string(),
    })
}
#[derive(Deserialize, Default, Debug)]
struct GoTrueAppMetadata {
    #[serde(default)]
    providers: Vec<String>,
}

#[derive(Deserialize, Debug)]
struct GoTrueUser {
    #[serde(default)]
    id: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    app_metadata: GoTrueAppMetadata,
}

#[derive(Deserialize, Default, Debug)]
pub(crate) struct GoTrueRefreshResponse {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
    #[serde(default)]
    error_code: Option<String>,
    #[serde(default)]
    msg: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    user: Option<GoTrueUser>,
}

/// GoTrue / Supabase Auth codes that prove *this refresh token* is dead.
/// Unknown 4xx (rotated API key, 404 routing, 401/403 without a token code) stay
/// transient so we do not sign everyone out on a service-side misconfig.
fn invalid_refresh_token_message(value: &GoTrueRefreshResponse) -> Option<String> {
    const INVALID: &[&str] = &["invalid_grant", "refresh_token_not_found", "refresh_token_already_used", "session_not_found"];
    let codes = [value.error.as_deref(), value.error_code.as_deref()];
    if !codes.iter().flatten().any(|code| INVALID.contains(code)) {
        return None;
    }
    Some(
        value
            .error_description
            .clone()
            .or(value.msg.clone())
            .or(value.error.clone())
            .or(value.error_code.clone())
            .unwrap_or_else(|| "invalid refresh token".into()),
    )
}

pub(crate) fn classify_refresh_response(status: u16, body: &[u8]) -> Result<GoTrueRefreshResponse, AccountAuthError> {
    let parsed = serde_json::from_slice::<GoTrueRefreshResponse>(body).ok();
    if let Some(message) = parsed.as_ref().and_then(invalid_refresh_token_message) {
        return Err(AccountAuthError::InvalidRefreshToken(message));
    }
    if !(200..300).contains(&status) {
        return Err(AccountAuthError::Transient(format!("refresh HTTP {status}")));
    }
    let value = parsed.ok_or_else(|| AccountAuthError::Transient("bad refresh response".into()))?;
    if value.access_token.as_ref().is_none_or(|token| token.is_empty()) {
        return Err(AccountAuthError::Transient("refresh response is missing access_token".into()));
    }
    Ok(value)
}

fn tokens_from_refresh(value: GoTrueRefreshResponse, tokens: &AccountTokens) -> AccountTokens {
    let access_token = value.access_token.filter(|t| !t.is_empty()).unwrap_or_default();
    let refresh_token = value.refresh_token.filter(|t| !t.is_empty()).unwrap_or_else(|| tokens.refresh_token.clone());
    let expires_at = now_secs().saturating_add(value.expires_in.unwrap_or(3600));
    let user = match value.user {
        Some(u) => AccountUser {
            id: u.id,
            email: u.email,
            providers: u.app_metadata.providers,
        },
        None => tokens.user.clone(),
    };
    AccountTokens {
        access_token,
        refresh_token,
        expires_at,
        user,
        plan: tokens.plan.clone(),
        paid: tokens.paid,
        // A rotation is the same session with new tokens; the id must not change or every
        // in-flight compare-and-mutate would stop recognising its own credential.
        session_id: tokens.session_id.clone(),
    }
}

pub(crate) fn refresh_account_tokens_at(base: &str, tokens: &AccountTokens) -> Result<AccountTokens, AccountAuthError> {
    let body = serde_json::to_string(&json!({ "refresh_token": tokens.refresh_token })).map_err(|e| AccountAuthError::Transient(e.to_string()))?;
    let http = curl_http(
        &format!("{base}/auth/v1/token?grant_type=refresh_token"),
        &[
            format!("apikey: {SUPABASE_PUBLISHABLE_KEY}"),
            format!("Authorization: Bearer {SUPABASE_PUBLISHABLE_KEY}"),
            "Content-Type: application/json".into(),
        ],
        Some(&body),
    )
    .map_err(AccountAuthError::Transient)?;
    let value = classify_refresh_response(http.status, &http.body)?;
    Ok(tokens_from_refresh(value, tokens))
}

pub(crate) fn account_auth_path_in(config_dir: &Path) -> PathBuf {
    config_dir.join(AUTH_JSON_NAME)
}

fn account_auth_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(account_auth_path_in(&app.path().app_config_dir().map_err(|e| e.to_string())?))
}

pub(crate) fn account_lock_path(auth_path: &Path) -> PathBuf {
    auth_path.with_extension("json.lock")
}

/// Process-local mutex plus the flock at `auth.json.lock`. The mutex is not enough on
/// its own: a second Alinery window that lost the repo lock still mounts AccountMenu
/// against the same config dir, and a process-local lock cannot see that window.
fn lock_credentials(path: &Path) -> Result<(std::sync::MutexGuard<'static, ()>, alinery_core::LockFile), String> {
    let process = CREDENTIALS.lock().unwrap_or_else(|e| e.into_inner());
    let lock_path = account_lock_path(path);
    if let Some(parent) = lock_path.parent() {
        // 0700, not the umask: this runs before the first credential write, so a `create_dir_all`
        // here is what the config dir's mode ends up being.
        alinery_core::create_dir_owner_only(parent)?;
    }
    let file = alinery_core::lock_exclusive_blocking(&lock_path).map_err(|e| format!("lock {}: {e}", lock_path.display()))?;
    Ok((process, file))
}

fn load_tokens_from_path(path: &Path) -> Result<Option<AccountTokens>, AccountAuthError> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| AccountAuthError::Corrupt(format!("invalid {}: {e}", path.display()))),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AccountAuthError::Transient(format!("read {}: {error}", path.display()))),
    }
}

fn save_tokens_to_path(path: &Path, tokens: &AccountTokens) -> Result<(), String> {
    let value = serde_json::to_string(tokens).map_err(|e| e.to_string())?;
    write_owner_only_bytes(path, value.as_bytes())
}

fn clear_tokens_at(path: &Path) -> Result<(), String> {
    store_credits_snapshot(None);
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove {}: {e}", path.display())),
    }
}

/// What a compare-and-mutate must still find on disk.
///
/// `session_id` deliberately survives token rotation, so on its own it cannot tell R1 from the
/// R2 another window just wrote. Only sign-out's final removal wants that: it owns every
/// generation of the session it revoked. Every other mutation started from one specific refresh
/// token and must not overwrite or delete the rotation that replaced it.
#[derive(Clone, Copy)]
enum Expect<'a> {
    Session(&'a str),
    Generation { session: &'a str, refresh: &'a str },
}

impl Expect<'_> {
    fn matches(self, current: &AccountTokens) -> bool {
        match self {
            Self::Session(session) => current.session_id == session,
            Self::Generation { session, refresh } => current.session_id == session && current.refresh_token == refresh,
        }
    }
}

/// The generation a request started from: the pair that must still be on disk for that
/// request's answer to be about the credential that is actually there.
fn generation_of(tokens: &AccountTokens) -> Expect<'_> {
    Expect::Generation {
        session: &tokens.session_id,
        refresh: &tokens.refresh_token,
    }
}

fn current_if(path: &Path, expect: Expect<'_>) -> Option<AccountTokens> {
    match load_tokens_from_path(path) {
        Ok(Some(current)) if expect.matches(&current) => Some(current),
        _ => None,
    }
}

#[cfg(test)]
fn run_after_compare_hook() {
    if let Some(hook) = AFTER_CREDENTIAL_COMPARE.lock().unwrap_or_else(|e| e.into_inner()).take() {
        hook();
    }
}

/// Test helper: take the credential lock, compare, then wait on `resume` before mutating.
/// Used by the two-process flock test so process A holds `auth.json.lock` across the
/// window process B uses to install a newer session.
#[cfg(test)]
pub(crate) fn hold_lock_after_compare_then_clear(
    path: &Path,
    expected_session: &str,
    gate: &std::sync::mpsc::Sender<()>,
    resume: &std::sync::mpsc::Receiver<()>,
) -> Result<Option<()>, String> {
    let _guard = lock_credentials(path)?;
    if current_if(path, Expect::Session(expected_session)).is_none() {
        return Ok(None);
    }
    let _ = gate.send(());
    let _ = resume.recv();
    if current_if(path, Expect::Session(expected_session)).is_none() {
        return Ok(None);
    }
    clear_tokens_at(path).map(Some)
}

/// Reload, compare, and mutate while holding both the process mutex and `auth.json.lock`.
/// `op` receives the tokens actually on disk, so a caller that only wants to change one field
/// never writes back its own pre-request clone.
fn mutate_if_current<T>(path: &Path, expect: Expect<'_>, op: impl FnOnce(AccountTokens) -> Result<T, String>) -> Result<Option<T>, String> {
    let _guard = lock_credentials(path)?;
    #[cfg(test)]
    {
        if current_if(path, expect).is_none() {
            return Ok(None);
        }
        // The hook is the two-window tests' window to install a replacement between the compare
        // and the mutation; the reload below is what has to notice it.
        run_after_compare_hook();
    }
    let Some(current) = current_if(path, expect) else {
        return Ok(None);
    };
    op(current).map(Some)
}

fn save_if_current(path: &Path, expect: Expect<'_>, tokens: &AccountTokens) -> Result<Option<()>, String> {
    mutate_if_current(path, expect, |_| save_tokens_to_path(path, tokens))
}

fn clear_if_current(path: &Path, expect: Expect<'_>) -> Result<Option<()>, String> {
    mutate_if_current(path, expect, |_| clear_tokens_at(path))
}

/// Sign-in's write. Cancel and commit share this lock so they have one linearization
/// point: either the write happens and `account_cancel_sign_in` reports that the attempt
/// already committed, or nothing on disk changed and any previous session is untouched.
/// There is deliberately no undo path — an undo would have to guess whether the file it
/// removes was this attempt's or the session it clobbered.
fn save_unless_cancelled(path: &Path, tokens: &AccountTokens, attempt: &SignInAttempt) -> Result<(), String> {
    if attempt.cancelled.load(Ordering::SeqCst) {
        return Err(SIGN_IN_CANCELLED.into());
    }
    #[cfg(test)]
    if let Some(hook) = BEFORE_SIGN_IN_PERSIST.lock().unwrap_or_else(|e| e.into_inner()).take() {
        hook();
    }
    let _guard = lock_credentials(path)?;
    if attempt.cancelled.load(Ordering::SeqCst) {
        return Err(SIGN_IN_CANCELLED.into());
    }
    save_tokens_to_path(path, tokens)?;
    // Visible to `account_cancel_sign_in` under the same lock: a later cancel cannot
    // claim success against a write that already renamed auth.json into place.
    attempt.committed.store(true, Ordering::SeqCst);
    Ok(())
}

/// Remove `auth.json` only while it is still the unreadable file we classified. Atomic rename
/// keeps another window's write whole, but it does not make our read-then-lock atomic: a valid
/// pairing that landed in that window is a live credential and must survive. Reports whether
/// the file was removed.
fn clear_if_still_invalid(path: &Path) -> Result<bool, String> {
    let _guard = lock_credentials(path)?;
    // Same window as `mutate_if_current`'s: the reload below is what has to notice a pairing
    // installed while we were taking the lock.
    #[cfg(test)]
    run_after_compare_hook();
    if matches!(load_tokens_from_path(path), Ok(Some(_))) {
        return Ok(false);
    }
    clear_tokens_at(path).map(|()| true)
}

/// Refreshes the cached entitlement. A successful empty response clears a stale plan — that
/// is the only path that ever clears one — while a failed lookup keeps whatever is cached,
/// so an outage never downgrades the chip.
fn persist_plan_if_current(path: &Path, tokens: &AccountTokens, entitlement_base: &str) -> AccountStatus {
    let (plan, paid) = match fetch_account_plan_at(entitlement_base, &tokens.access_token) {
        Ok(value) => value,
        Err(e) => {
            eprintln!("fetch account plan: {e}");
            return status_for(tokens);
        }
    };
    if tokens.plan == plan && tokens.paid == paid {
        return status_for(tokens);
    }
    // Only `plan`/`paid` are written, and onto whatever is on disk now: `tokens` is a pre-request clone,
    // and another window can have rotated this session while the entitlement request was out.
    // Writing that clone back would restore its superseded refresh token.
    let written = mutate_if_current(path, Expect::Session(&tokens.session_id), |mut current| {
        current.plan = plan;
        current.paid = paid;
        save_tokens_to_path(path, &current).map(|()| current)
    });
    match written {
        Ok(Some(current)) => status_for(&current),
        Ok(None) => account_status_from_path(path),
        Err(e) => {
            eprintln!("persist account plan: {e}");
            status_for(tokens)
        }
    }
}

pub(crate) fn account_status_from_path(path: &Path) -> AccountStatus {
    match load_tokens_from_path(path) {
        Ok(Some(tokens)) => status_for(&tokens),
        Ok(None) => SIGNED_OUT,
        Err(AccountAuthError::Corrupt(_)) => match clear_if_still_invalid(path) {
            // A valid pairing replaced the corrupt bytes while we were taking the lock.
            Ok(false) => load_tokens_from_path(path).ok().flatten().map_or(SIGNED_OUT, |current| status_for(&current)),
            _ => SIGNED_OUT,
        },
        Err(e) => {
            eprintln!("load account credential: {e}");
            SIGNED_OUT
        }
    }
}

pub(crate) fn refresh_account_at(path: &Path, supabase_base: &str, entitlement_base: &str) -> AccountStatus {
    let tokens = match load_tokens_from_path(path) {
        Ok(None) => return SIGNED_OUT,
        Ok(Some(tokens)) => tokens,
        Err(e) if e.clears_credential() => {
            return match clear_if_still_invalid(path) {
                Ok(false) => account_status_from_path(path),
                _ => SIGNED_OUT,
            };
        }
        Err(e) => {
            eprintln!("load account credential: {e}");
            return SIGNED_OUT;
        }
    };
    if now_secs().saturating_add(REFRESH_SKEW_SECS) < tokens.expires_at {
        // Re-check the entitlement even when a plan is already cached: a removed subscription
        // answers with an empty list, and this is the only path that clears the stale value.
        return persist_plan_if_current(path, &tokens, entitlement_base);
    }
    match refresh_account_tokens_at(supabase_base, &tokens) {
        Ok(refreshed) => match save_if_current(path, generation_of(&tokens), &refreshed) {
            Ok(Some(())) => persist_plan_if_current(path, &refreshed, entitlement_base),
            Ok(None) => account_status_from_path(path),
            Err(e) => {
                eprintln!("persist refreshed account session: {e}");
                status_unavailable(&tokens)
            }
        },
        Err(AccountAuthError::InvalidRefreshToken(e)) => {
            eprintln!("refresh account session: {e}");
            let _ = clear_if_current(path, generation_of(&tokens));
            account_status_from_path(path)
        }
        Err(e) => {
            eprintln!("refresh account session: {e}");
            if current_if(path, generation_of(&tokens)).is_some() {
                status_unavailable(&tokens)
            } else {
                account_status_from_path(path)
            }
        }
    }
}

/// Everything after the browser callback. Split out of `sign_in_blocking` so the
/// cancellation and persistence rules are reachable without an `AppHandle`, and so the
/// pairing backend is injectable.
pub(crate) fn finish_sign_in(path: &Path, accounts_base: &str, code: &str, nonce: &str, attempt: &SignInAttempt) -> Result<AccountStatus, String> {
    if attempt.cancelled.load(Ordering::SeqCst) {
        return Err(SIGN_IN_CANCELLED.into());
    }
    let tokens = exchange_pairing_code_at(accounts_base, code, nonce)?;
    save_unless_cancelled(path, &tokens, attempt)?;
    // Resolves as soon as the credential is durable. The optional entitlement lookup is the
    // frontend's follow-up `account_refresh`, so Cancel sign-in never stays visible over work
    // it can no longer cancel — see AccountMenu.tsx.
    Ok(status_for(&tokens))
}

fn sign_in_blocking(app: &AppHandle) -> Result<AccountStatus, String> {
    let attempt = begin_sign_in_attempt()?;
    let _guard = SignInGuard(attempt.clone());
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("listen for pairing callback: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // 16 bytes, hex — satisfies the contract's `^[0-9a-f]{32,64}$` with room to spare.
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let accounts_base = accounts_url();
    let login_url = format!("{accounts_base}/desktop-login?port={port}&nonce={}", percent_encode(&nonce));
    app.opener().open_url(login_url, None::<&str>).map_err(|e| format!("open sign-in page in browser: {e}"))?;
    let code = wait_for_desktop_login_callback_until(listener, &nonce, &attempt, Instant::now() + SIGN_IN_TIMEOUT)?;
    finish_sign_in(&account_auth_path(app)?, &accounts_base, &code, &nonce, &attempt)
}

fn revoke_account_session_at(base: &str, access_token: &str) -> bool {
    match curl_http(
        &format!("{base}/auth/v1/logout"),
        &[format!("apikey: {SUPABASE_PUBLISHABLE_KEY}"), format!("Authorization: Bearer {access_token}")],
        Some("{}"),
    ) {
        Ok(http) => (200..300).contains(&http.status),
        Err(_) => false,
    }
}

fn signed_out_result(remote_revoked: bool) -> AccountSignOutResult {
    AccountSignOutResult {
        signed_in: false,
        email: None,
        plan: None,
        paid: false,
        unavailable: false,
        remote_revoked,
    }
}

/// Reported instead of a signed-out success: tokens left on disk mean the next titlebar
/// mount reads them and silently signs the user back in.
fn local_clear_failed(error: String) -> String {
    format!("could not remove this device's credential: {error}")
}

pub(crate) fn sign_out_at(path: &Path, supabase_base: &str) -> Result<AccountSignOutResult, String> {
    // Website cookie logout (`POST /api/auth/logout`) is a different session and is deliberately
    // not called here — see docs/architecture/desktop-pairing.md "Sign out".
    match load_tokens_from_path(path) {
        Ok(None) => Ok(signed_out_result(true)),
        Ok(Some(tokens)) => {
            let session = tokens.session_id.clone();
            let (access, already_revoked) = if now_secs() >= tokens.expires_at {
                match refresh_account_tokens_at(supabase_base, &tokens) {
                    Ok(refreshed) => {
                        // Persisted before the logout request: the server may have rotated the
                        // refresh token, and a crash here must not leave the dead one behind.
                        let _ = save_if_current(path, generation_of(&tokens), &refreshed);
                        (Some(refreshed.access_token), false)
                    }
                    // Only a proven-dead refresh token means the server session is already gone.
                    Err(AccountAuthError::InvalidRefreshToken(_)) => (None, true),
                    Err(_) => (None, false),
                }
            } else {
                (Some(tokens.access_token.clone()), false)
            };
            let remote = already_revoked || access.as_deref().is_some_and(|token| revoke_account_session_at(supabase_base, token));
            // Keyed on the session, not the refresh token: a rotation this app performed
            // concurrently is still this session and is still removed, while a genuinely
            // newer pairing has a different id and survives.
            match clear_if_current(path, Expect::Session(&session)).map_err(local_clear_failed)? {
                Some(()) => Ok(signed_out_result(remote)),
                // A newer pairing replaced the session we just revoked remotely. Report that
                // remaining session so the titlebar does not flash Sign in over a live credential.
                None => Ok(sign_out_status_for_remaining(path, remote)),
            }
        }
        // Same rule as the readable path: a valid pairing that landed while we were taking the
        // lock is a session the user just created, and reporting it beats flashing Sign in.
        Err(AccountAuthError::Corrupt(_)) => Ok(match clear_if_still_invalid(path).map_err(local_clear_failed)? {
            true => signed_out_result(true),
            false => sign_out_status_for_remaining(path, true),
        }),
        Err(error) => {
            eprintln!("load account credential: {error}");
            Ok(match clear_if_still_invalid(path).map_err(local_clear_failed)? {
                true => signed_out_result(false),
                false => sign_out_status_for_remaining(path, false),
            })
        }
    }
}

fn sign_out_status_for_remaining(path: &Path, remote_revoked: bool) -> AccountSignOutResult {
    let status = account_status_from_path(path);
    AccountSignOutResult {
        signed_in: status.signed_in,
        email: status.email,
        plan: status.plan,
        paid: status.paid,
        unavailable: status.unavailable,
        remote_revoked,
    }
}

fn access_token_for_hosted_revoke(path: &Path, tokens: &AccountTokens) -> Option<String> {
    if now_secs() < tokens.expires_at {
        return Some(tokens.access_token.clone());
    }
    match refresh_account_tokens_at(SUPABASE_URL, tokens) {
        Ok(refreshed) => {
            let _ = save_if_current(path, generation_of(tokens), &refreshed);
            Some(refreshed.access_token)
        }
        Err(AccountAuthError::InvalidRefreshToken(_)) => None,
        Err(e) => {
            eprintln!("refresh account session for hosted revoke: {e}");
            Some(tokens.access_token.clone())
        }
    }
}

fn sign_out_blocking(app: &AppHandle) -> Result<AccountSignOutResult, String> {
    let path = account_auth_path(app)?;
    if let Ok(Some(tokens)) = load_tokens_from_path(&path) {
        if let (Some(config_dir), Ok(app_config)) = (path.parent(), app_config_path(app)) {
            let access = access_token_for_hosted_revoke(&path, &tokens);
            revoke_hosted_inference(config_dir, &app_config, &accounts_url(), access.as_deref(), Some(&tokens.session_id));
        }
    }
    sign_out_at(&path, SUPABASE_URL)
}

fn sync_hosted_from_auth(app: &AppHandle, auth_path: &Path, status: &AccountStatus) {
    let Some(config_dir) = auth_path.parent() else {
        return;
    };
    let Ok(app_config) = app_config_path(app) else {
        return;
    };
    let tokens = load_tokens_from_path(auth_path).ok().flatten();
    if !(status.signed_in && status.paid) {
        revoke_hosted_inference(
            config_dir,
            &app_config,
            &accounts_url(),
            tokens.as_ref().map(|t| t.access_token.as_str()),
            tokens.as_ref().map(|t| t.session_id.as_str()),
        );
        return;
    }
    let Some(tokens) = tokens else {
        return;
    };
    let _ = sync_hosted_inference(config_dir, &app_config, &accounts_url(), &tokens.access_token, &tokens.session_id, true);
}

pub(crate) fn refresh_hosted_inference_for_spawn(app: &AppHandle) -> Result<(), String> {
    let auth_path = account_auth_path(app).map_err(|_| HOSTED_MODEL_UNAVAILABLE.to_string())?;
    let app_config = app_config_path(app).map_err(|_| HOSTED_MODEL_UNAVAILABLE.to_string())?;
    refresh_hosted_inference_for_spawn_at(&auth_path, &app_config, &accounts_url(), SUPABASE_URL, SUPABASE_URL)
}

pub(crate) fn refresh_hosted_inference_for_spawn_at(auth_path: &Path, app_config: &Path, accounts_url: &str, supabase_url: &str, entitlement_base: &str) -> Result<(), String> {
    let status = account_status_from_path(auth_path);
    let status = if status.signed_in {
        refresh_account_at(auth_path, supabase_url, entitlement_base)
    } else {
        status
    };
    if !(status.signed_in && status.paid) {
        return Err(HOSTED_MODEL_UNAVAILABLE.into());
    }
    let Some(config_dir) = auth_path.parent() else {
        return Err(HOSTED_MODEL_UNAVAILABLE.into());
    };
    let Some(tokens) = load_tokens_from_path(auth_path).ok().flatten() else {
        return Err(HOSTED_MODEL_UNAVAILABLE.into());
    };
    sync_hosted_inference(config_dir, app_config, accounts_url, &tokens.access_token, &tokens.session_id, true)
}

#[tauri::command]
pub(crate) fn account_status(app: AppHandle) -> AccountStatus {
    match account_auth_path(&app) {
        Ok(path) => account_status_from_path(&path),
        Err(_) => SIGNED_OUT,
    }
}

#[tauri::command]
pub(crate) async fn account_refresh(app: AppHandle) -> AccountStatus {
    tauri::async_runtime::spawn_blocking(move || match account_auth_path(&app) {
        Ok(path) => {
            let status = refresh_account_at(&path, SUPABASE_URL, SUPABASE_URL);
            sync_hosted_from_auth(&app, &path, &status);
            status
        }
        Err(_) => SIGNED_OUT,
    })
    .await
    .unwrap_or(SIGNED_OUT)
}

#[tauri::command]
pub(crate) async fn account_sign_in(app: AppHandle) -> Result<AccountStatus, String> {
    tauri::async_runtime::spawn_blocking(move || sign_in_blocking(&app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn account_cancel_sign_in(app: AppHandle) -> Result<(), String> {
    cancel_sign_in_at(&account_auth_path(&app)?)
}

/// Linearizes with `save_unless_cancelled` on `auth.json.lock`. A successful cancel means
/// the attempt had not committed; if persist already renamed the file, this returns Err
/// so the visible Cancel sign-in click does not claim it undid a completed pairing.
pub(crate) fn cancel_sign_in_at(path: &Path) -> Result<(), String> {
    let slot = SIGN_IN_IN_FLIGHT.lock().map_err(|e| e.to_string())?;
    let Some(attempt) = slot.as_ref().cloned() else {
        return Ok(());
    };
    drop(slot);
    let _guard = lock_credentials(path)?;
    mark_sign_in_cancelled(&attempt)
}

fn mark_sign_in_cancelled(attempt: &SignInAttempt) -> Result<(), String> {
    if attempt.committed.load(Ordering::SeqCst) {
        return Err("Sign-in already completed".into());
    }
    attempt.cancelled.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub(crate) async fn account_sign_out(app: AppHandle) -> Result<AccountSignOutResult, String> {
    tauri::async_runtime::spawn_blocking(move || sign_out_blocking(&app)).await.map_err(|e| e.to_string())?
}

/// GET /api/desktop/credits with the pairing JWT. 401 refreshes once; still 401 signs out.
/// 404 hides the balance (CREDITS_ENABLED off). 503 keeps the last snapshot.
pub(crate) fn fetch_desktop_credits_at(accounts_url: &str, supabase_base: &str, path: &Path) -> DesktopCreditsView {
    let tokens = match load_tokens_from_path(path) {
        Ok(Some(tokens)) => tokens,
        Ok(None) => {
            store_credits_snapshot(None);
            return credits_signed_out();
        }
        Err(e) if e.clears_credential() => {
            let _ = clear_if_still_invalid(path);
            store_credits_snapshot(None);
            return credits_signed_out();
        }
        Err(e) => {
            eprintln!("load account credential for credits: {e}");
            return last_credits_snapshot().as_ref().map(credits_view_from).unwrap_or_else(credits_hidden);
        }
    };
    match fetch_desktop_credits(accounts_url, &tokens.access_token) {
        Ok(credits) => {
            store_credits_snapshot(Some(credits.clone()));
            credits_view_from(&credits)
        }
        Err(CreditsFetchError::Status(401)) => fetch_desktop_credits_after_401(accounts_url, supabase_base, path, &tokens),
        Err(CreditsFetchError::Status(404)) => {
            store_credits_snapshot(None);
            credits_hidden()
        }
        Err(e) => {
            match &e {
                CreditsFetchError::Status(status) => eprintln!("desktop credits HTTP {status}"),
                CreditsFetchError::Parse(error) | CreditsFetchError::Transport(error) => eprintln!("desktop credits: {error}"),
            }
            last_credits_snapshot().as_ref().map(credits_view_from).unwrap_or_else(credits_hidden)
        }
    }
}

fn fetch_desktop_credits_after_401(accounts_url: &str, supabase_base: &str, path: &Path, tokens: &AccountTokens) -> DesktopCreditsView {
    match refresh_account_tokens_at(supabase_base, tokens) {
        Ok(refreshed) => {
            let _ = save_if_current(path, generation_of(tokens), &refreshed);
            let access = current_if(path, generation_of(&refreshed))
                .map(|current| current.access_token.clone())
                .unwrap_or_else(|| refreshed.access_token.clone());
            match fetch_desktop_credits(accounts_url, &access) {
                Ok(credits) => {
                    store_credits_snapshot(Some(credits.clone()));
                    credits_view_from(&credits)
                }
                Err(CreditsFetchError::Status(401)) => {
                    let _ = clear_if_current(path, generation_of(&refreshed));
                    store_credits_snapshot(None);
                    credits_signed_out()
                }
                Err(CreditsFetchError::Status(404)) => {
                    store_credits_snapshot(None);
                    credits_hidden()
                }
                Err(e) => {
                    match &e {
                        CreditsFetchError::Status(status) => eprintln!("desktop credits retry HTTP {status}"),
                        CreditsFetchError::Parse(error) | CreditsFetchError::Transport(error) => eprintln!("desktop credits retry: {error}"),
                    }
                    last_credits_snapshot().as_ref().map(credits_view_from).unwrap_or_else(credits_hidden)
                }
            }
        }
        Err(AccountAuthError::InvalidRefreshToken(e)) => {
            eprintln!("refresh account session for credits: {e}");
            let _ = clear_if_current(path, generation_of(tokens));
            store_credits_snapshot(None);
            credits_signed_out()
        }
        Err(e) => {
            eprintln!("refresh account session for credits: {e}");
            last_credits_snapshot().as_ref().map(credits_view_from).unwrap_or_else(credits_hidden)
        }
    }
}

fn hosted_catalog_blocking(app: &AppHandle) -> HostedCatalogView {
    let accounts = accounts_url();
    let Ok(auth_path) = account_auth_path(app) else {
        return unsigned_hosted_catalog(&accounts);
    };
    let config_dir = auth_path.parent().unwrap_or(auth_path.as_path()).to_path_buf();
    let status = account_status_from_path(&auth_path);
    let status = if status.signed_in {
        refresh_account_at(&auth_path, SUPABASE_URL, SUPABASE_URL)
    } else {
        status
    };
    sync_hosted_from_auth(app, &auth_path, &status);
    let view = hosted_catalog_at(&config_dir, &accounts, status.signed_in, status.paid);
    if !status.signed_in {
        return view;
    }
    let credits = fetch_desktop_credits_at(&accounts, SUPABASE_URL, &auth_path);
    if credits.signed_out {
        return unsigned_hosted_catalog(&accounts);
    }
    apply_credits_to_hosted_view(view, &credits)
}

#[tauri::command]
pub(crate) async fn hosted_catalog(app: AppHandle) -> HostedCatalogView {
    tauri::async_runtime::spawn_blocking(move || hosted_catalog_blocking(&app))
        .await
        .unwrap_or_else(|_| unsigned_hosted_catalog(&accounts_url()))
}

#[tauri::command]
pub(crate) async fn account_credits(app: AppHandle) -> DesktopCreditsView {
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(auth_path) = account_auth_path(&app) else {
            return credits_signed_out();
        };
        fetch_desktop_credits_at(&accounts_url(), SUPABASE_URL, &auth_path)
    })
    .await
    .unwrap_or_else(|_| credits_hidden())
}

#[tauri::command]
pub(crate) fn account_open_plans(app: AppHandle) -> Result<(), String> {
    let url = format!("{}/plans", accounts_url().trim_end_matches('/'));
    app.opener().open_url(&url, None::<&str>).map_err(|e| format!("open plans page in browser: {e}"))
}

#[tauri::command]
pub(crate) fn account_open(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(format!("{}/account", accounts_url()), None::<&str>)
        .map_err(|e| format!("open account page in browser: {e}"))
}
