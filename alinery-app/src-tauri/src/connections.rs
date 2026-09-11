//! Browser-backed GitHub and Linear connections used by Settings and issue imports.
use crate::*;
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri_plugin_opener::OpenerExt;

const LINEAR_CALLBACK_ADDR: &str = "127.0.0.1:43119";
const LINEAR_CALLBACK_URL: &str = "http://127.0.0.1:43119/oauth/linear/callback";
const LINEAR_KEYCHAIN_SERVICE: &str = "ai.delegance.alinery.oauth";
const LINEAR_OAUTH_CLIENT_ID: &str = "175bd9ec87c9edbdf6125968776f62dc";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionStatus {
    provider: String,
    name: String,
    kind: String,
    connected: bool,
    reconnect: bool,
    available: bool,
    /// Whether this app owns a credential it can remove.
    removable: bool,
    account: String,
    detail: String,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct LinearOAuthTokens {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    #[serde(default)]
    account: String,
}

fn linear_client_id() -> Option<String> {
    std::env::var("ALINERY_LINEAR_CLIENT_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| option_env!("ALINERY_LINEAR_CLIENT_ID").map(str::to_string))
        .or_else(|| Some(LINEAR_OAUTH_CLIENT_ID.to_string()))
}

// Gated because it links Security.framework: every call site already has a
// `#[cfg(not(target_os = "macos"))]` arm returning "Linear connections require macOS Keychain",
// so without this the module is the only thing that would fail a non-Darwin build.
#[cfg(target_os = "macos")]
mod macos_keychain {
    use std::ffi::c_void;
    use std::ptr;

    const ITEM_NOT_FOUND: i32 = -25300;

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecKeychainFindGenericPassword(
            keychain_or_array: *const c_void,
            service_name_length: u32,
            service_name: *const u8,
            account_name_length: u32,
            account_name: *const u8,
            password_length: *mut u32,
            password_data: *mut *mut c_void,
            item_ref: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainAddGenericPassword(
            keychain_or_array: *const c_void,
            service_name_length: u32,
            service_name: *const u8,
            account_name_length: u32,
            account_name: *const u8,
            password_length: u32,
            password_data: *const c_void,
            item_ref: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainItemModifyAttributesAndData(item_ref: *mut c_void, attr_list: *const c_void, length: u32, data: *const c_void) -> i32;
        fn SecKeychainItemFreeContent(attr_list: *const c_void, data: *mut c_void) -> i32;
        fn SecKeychainItemDelete(item_ref: *mut c_void) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: *const c_void);
    }

    pub fn read(service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
        let mut length = 0;
        let mut data = ptr::null_mut();
        let mut item = ptr::null_mut();
        let status = unsafe {
            SecKeychainFindGenericPassword(
                ptr::null(),
                service.len() as u32,
                service.as_ptr(),
                account.len() as u32,
                account.as_ptr(),
                &mut length,
                &mut data,
                &mut item,
            )
        };
        if status == ITEM_NOT_FOUND {
            return Ok(None);
        }
        if status != 0 {
            return Err(format!("Keychain read failed ({status})"));
        }
        let value = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), length as usize) }.to_vec();
        unsafe {
            SecKeychainItemFreeContent(ptr::null(), data);
            CFRelease(item);
        }
        Ok(Some(value))
    }

    /// Does the item exist? A null password buffer means macOS never decrypts it, so this
    /// never raises the "Alinery wants to use your confidential information" prompt that a
    /// real read does on every rebuild (the ACL is keyed to the binary's signature).
    pub fn exists(service: &str, account: &str) -> Result<bool, String> {
        let status = unsafe {
            SecKeychainFindGenericPassword(
                ptr::null(),
                service.len() as u32,
                service.as_ptr(),
                account.len() as u32,
                account.as_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        match status {
            0 => Ok(true),
            ITEM_NOT_FOUND => Ok(false),
            other => Err(format!("Keychain read failed ({other})")),
        }
    }

    /// Delete the item. Finding it takes no password buffer, so removing a connection stays as
    /// prompt-free as reading its status. Already gone is success — the caller wanted it gone.
    pub fn delete(service: &str, account: &str) -> Result<(), String> {
        let mut item = ptr::null_mut();
        let found = unsafe {
            SecKeychainFindGenericPassword(
                ptr::null(),
                service.len() as u32,
                service.as_ptr(),
                account.len() as u32,
                account.as_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
                &mut item,
            )
        };
        if found == ITEM_NOT_FOUND {
            return Ok(());
        }
        if found != 0 {
            return Err(format!("Keychain read failed ({found})"));
        }
        let status = unsafe { SecKeychainItemDelete(item) };
        unsafe { CFRelease(item) };
        if status == 0 {
            Ok(())
        } else {
            Err(format!("Keychain delete failed ({status})"))
        }
    }

    pub fn write(service: &str, account: &str, value: &[u8]) -> Result<(), String> {
        let mut item = ptr::null_mut();
        let found = unsafe {
            SecKeychainFindGenericPassword(
                ptr::null(),
                service.len() as u32,
                service.as_ptr(),
                account.len() as u32,
                account.as_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
                &mut item,
            )
        };
        let status = if found == 0 {
            let status = unsafe { SecKeychainItemModifyAttributesAndData(item, ptr::null(), value.len() as u32, value.as_ptr().cast()) };
            unsafe { CFRelease(item) };
            status
        } else if found == ITEM_NOT_FOUND {
            unsafe {
                SecKeychainAddGenericPassword(
                    ptr::null(),
                    service.len() as u32,
                    service.as_ptr(),
                    account.len() as u32,
                    account.as_ptr(),
                    value.len() as u32,
                    value.as_ptr().cast(),
                    ptr::null_mut(),
                )
            }
        } else {
            found
        };
        if status == 0 {
            Ok(())
        } else {
            Err(format!("Keychain write failed ({status})"))
        }
    }
}

/// Only one Linear credential failure is repairable without the user: a blob that will not parse is
/// dead until they reconnect, so the import path clears the account label to put Reconnect back on
/// the row. A Keychain read, a refresh, or a network failure may work on the next try — the label
/// must survive those, or a dropped connection quietly demotes a healthy row.
pub(crate) enum LinearTokenError {
    Corrupt(String),
    Transient(String),
}

impl From<String> for LinearTokenError {
    fn from(error: String) -> Self {
        Self::Transient(error)
    }
}

impl LinearTokenError {
    /// The one decision this type exists to make. Kept as a named predicate rather than a match arm
    /// at the call site so it can be tested: swapping the arms in imports.rs would otherwise make a
    /// network blip delete the user's account label with every existing test still green.
    pub(crate) fn clears_account_label(&self) -> bool {
        matches!(self, Self::Corrupt(_))
    }

    pub(crate) fn reason(&self) -> &str {
        match self {
            Self::Corrupt(reason) | Self::Transient(reason) => reason,
        }
    }
}

pub(crate) fn parse_linear_oauth_tokens(value: &[u8]) -> Result<LinearOAuthTokens, LinearTokenError> {
    serde_json::from_slice(value).map_err(|e| LinearTokenError::Corrupt(format!("invalid Linear credential in Keychain: {e}")))
}

fn load_linear_oauth_tokens() -> Result<Option<LinearOAuthTokens>, LinearTokenError> {
    #[cfg(target_os = "macos")]
    {
        macos_keychain::read(LINEAR_KEYCHAIN_SERVICE, "linear")?
            .map(|value| parse_linear_oauth_tokens(&value))
            .transpose()
    }
    #[cfg(not(target_os = "macos"))]
    Err("Linear connections require macOS Keychain".to_string().into())
}

/// Connection status only needs to know whether a token is there, never its bytes.
fn linear_tokens_present() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    return macos_keychain::exists(LINEAR_KEYCHAIN_SERVICE, "linear");
    #[cfg(not(target_os = "macos"))]
    Err("Linear connections require macOS Keychain".into())
}

// ponytail: the account label is a display string, not a secret, so it lives on disk where reading
// it costs nothing and never raises the Keychain prompt this module exists to avoid.
//
// It lives beside the per-identifier config dirs rather than inside one of them, under a directory
// named for the Keychain service. One credential, one label: the Keychain item is shared by every
// Alinery build on the machine, so a label kept per bundle identifier can name account A while the
// shared token belongs to B -- Settings would name one Linear account while imports ran as another.
// Keying the label by the same service constant as the credential keeps the two moving together.
//
// It can hold the account's email (linear_viewer_account falls back to it when the name is absent),
// so it is written owner-only rather than at whatever the umask happens to be.
pub(crate) fn linear_account_path_in(config_dir: &Path) -> PathBuf {
    config_dir.parent().unwrap_or(config_dir).join(LINEAR_KEYCHAIN_SERVICE).join("linear-account")
}

fn linear_account_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(linear_account_path_in(&app.path().app_config_dir().map_err(|e| e.to_string())?))
}

/// Deletes the current account label; true when it is absent. The label is the only
/// thing that lets an unusable credential render as a plain Connected row with no button, so
/// deleting it is the whole repair: the next status read has no name to show and offers Reconnect.
/// Takes the config dir because the import path has no AppHandle.
pub(crate) fn clear_linear_account_in(config_dir: &Path) -> bool {
    let mut gone = true;
    for path in std::iter::once(linear_account_path_in(config_dir)) {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => {
                eprintln!("remove Linear account label {}: {e}", path.display());
                gone = false;
            }
        }
    }
    gone
}

fn linear_account(app: &AppHandle) -> String {
    linear_account_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn save_linear_account(app: &AppHandle, account: &str) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    write_owner_only_bytes(&linear_account_path_in(&config_dir), account.as_bytes())?;
    Ok(())
}

fn save_linear_oauth_tokens(tokens: &LinearOAuthTokens) -> Result<(), String> {
    let value = serde_json::to_string(tokens).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    return macos_keychain::write(LINEAR_KEYCHAIN_SERVICE, "linear", value.as_bytes());
    #[cfg(not(target_os = "macos"))]
    Err("Linear connections require macOS Keychain".into())
}

fn output_with_timeout(mut cmd: Command, timeout: Duration) -> std::io::Result<std::process::Output> {
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "command timed out"));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn github_connection_status() -> ConnectionStatus {
    let mut cmd = Command::new("gh");
    cmd.args(["auth", "status", "--hostname", "github.com", "--active", "--json", "hosts"])
        .env("PATH", login_shell_path());
    let out = output_with_timeout(cmd, Duration::from_secs(3));
    let Ok(out) = out else {
        return ConnectionStatus {
            provider: "github".into(),
            name: "GitHub".into(),
            kind: "Web".into(),
            connected: false,
            reconnect: false,
            available: false,
            removable: false,
            account: String::new(),
            detail: "GitHub CLI is not installed".into(),
        };
    };
    let value: Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
    let active = value
        .get("hosts")
        .and_then(|hosts| hosts.get("github.com"))
        .and_then(Value::as_array)
        .and_then(|accounts| accounts.iter().find(|account| account.get("active") == Some(&Value::Bool(true))));
    let connected = active.and_then(|account| account.get("state")).and_then(Value::as_str) == Some("success");
    let account = active.and_then(|account| account.get("login")).and_then(Value::as_str).unwrap_or("").to_string();
    ConnectionStatus {
        provider: "github".into(),
        name: "GitHub".into(),
        kind: "Web".into(),
        connected,
        reconnect: active.is_some() && !connected,
        available: true,
        removable: false,
        detail: if connected { "Connected" } else { "Not connected" }.into(),
        account,
    }
}

fn linear_connection_status(app: &AppHandle) -> ConnectionStatus {
    let available = linear_client_id().is_some();
    match linear_tokens_present() {
        Ok(true) => {
            // A connection made before the label moved out of the Keychain has no sidecar file,
            // and the status path can no longer recover the name without the prompt this exists to
            // remove. Offer Reconnect instead of a row with no account and no way to fix it.
            let account = linear_account(app);
            let unlabelled = account.is_empty();
            ConnectionStatus {
                provider: "linear".into(),
                name: "Linear".into(),
                kind: "Web".into(),
                connected: true,
                reconnect: unlabelled,
                available: true,
                // The only branch with tokens of ours in the Keychain, so the only one Remove can act on.
                removable: true,
                account,
                detail: if unlabelled { "Connected — reconnect to show your account" } else { "Connected" }.into(),
            }
        }
        Ok(false) => ConnectionStatus {
            provider: "linear".into(),
            name: "Linear".into(),
            kind: if available { "Web" } else { "Unavailable" }.into(),
            connected: false,
            reconnect: false,
            available,
            removable: false,
            account: String::new(),
            detail: if available { "Not connected" } else { "OAuth is unavailable on this platform" }.into(),
        },
        Err(error) => ConnectionStatus {
            provider: "linear".into(),
            name: "Linear".into(),
            kind: if available { "Web" } else { "Unavailable" }.into(),
            connected: false,
            reconnect: available,
            available,
            removable: false,
            account: String::new(),
            detail: if available { error } else { "OAuth is unavailable on this platform".into() },
        },
    }
}

#[tauri::command]
pub(crate) fn connection_statuses(app: AppHandle) -> Vec<ConnectionStatus> {
    vec![github_connection_status(), linear_connection_status(&app)]
}

#[tauri::command]
pub(crate) async fn connect_github() -> Result<ConnectionStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let protocol = Command::new("gh")
            .args(["config", "get", "git_protocol", "--host", "github.com"])
            .env("PATH", login_shell_path())
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .filter(|value| value == "ssh" || value == "https")
            .unwrap_or_else(|| "https".into());
        let out = Command::new("gh")
            .args([
                "auth",
                "login",
                "--hostname",
                "github.com",
                "--git-protocol",
                &protocol,
                "--web",
                "--clipboard",
                "--skip-ssh-key",
            ])
            .env("PATH", login_shell_path())
            .output()
            .map_err(|e| format!("start GitHub browser login: {e}"))?;
        if !out.status.success() {
            let error = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if error.is_empty() { "GitHub login failed".into() } else { error });
        }
        let status = github_connection_status();
        if status.connected {
            Ok(status)
        } else {
            Err("GitHub login completed without an active account".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn percent_encode(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out
}

pub(crate) fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
                out.push(u8::from_str_radix(hex, 16).map_err(|_| "invalid percent encoding".to_string())?);
                i += 2;
            }
            b'%' => return Err("invalid percent encoding".into()),
            byte => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

fn base64_url_no_pad(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let value = ((chunk[0] as u32) << 16) | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8) | chunk.get(2).copied().unwrap_or(0) as u32;
        out.push(TABLE[((value >> 18) & 63) as usize] as char);
        out.push(TABLE[((value >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((value >> 6) & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(TABLE[(value & 63) as usize] as char);
        }
    }
    out
}

pub(crate) fn pkce_challenge(verifier: &str) -> Result<String, String> {
    let mut child = Command::new("/usr/bin/openssl")
        .args(["dgst", "-sha256", "-binary"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("start PKCE digest: {e}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "PKCE digest stdin unavailable".to_string())?
        .write_all(verifier.as_bytes())
        .map_err(|e| format!("write PKCE verifier: {e}"))?;
    let out = child.wait_with_output().map_err(|e| format!("finish PKCE digest: {e}"))?;
    if out.status.success() {
        Ok(base64_url_no_pad(&out.stdout))
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OAuthCallback {
    Code { code: String, state: String },
    Error { message: String, state: String },
}

pub(crate) fn parse_oauth_callback(request: &str) -> Result<OAuthCallback, String> {
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "invalid OAuth callback request".to_string())?;
    let (path, query) = target.split_once('?').ok_or_else(|| "OAuth callback is missing query parameters".to_string())?;
    if path != "/oauth/linear/callback" {
        return Err("unexpected OAuth callback path".into());
    }
    let mut values = HashMap::new();
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        values.insert(percent_decode(key)?, percent_decode(value)?);
    }
    let state = values.get("state").cloned().ok_or_else(|| "OAuth callback is missing state".to_string())?;
    if let Some(error) = values.get("error") {
        return Ok(OAuthCallback::Error {
            message: values.get("error_description").cloned().unwrap_or_else(|| error.clone()),
            state,
        });
    }
    Ok(OAuthCallback::Code {
        code: values.get("code").cloned().ok_or_else(|| "OAuth callback is missing code".to_string())?,
        state,
    })
}

pub(crate) fn wait_for_linear_callback(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_read_timeout(Some(Duration::from_secs(3))).map_err(|e| e.to_string())?;
                let mut buf = [0; 8192];
                let count = stream.read(&mut buf).map_err(|e| e.to_string())?;
                let parsed = parse_oauth_callback(&String::from_utf8_lossy(&buf[..count]));
                let ok = parsed
                    .as_ref()
                    .is_ok_and(|callback| matches!(callback, OAuthCallback::Code { state, .. } if state == expected_state));
                let body = if ok {
                    "<h1>Authorization received</h1><p>You can close this window and return to Alinery.</p>"
                } else {
                    "<h1>Linear connection failed</h1><p>Return to Alinery for details.</p>"
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
                match parsed {
                    Ok(OAuthCallback::Code { code, state }) if state == expected_state => return Ok(code),
                    Ok(OAuthCallback::Error { message, state }) if state == expected_state => return Err(message),
                    _ => continue,
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => return Err("Linear login timed out".into()),
            Err(error) => return Err(format!("receive Linear OAuth callback: {error}")),
        }
    }
}

pub(crate) fn curl_config_quote(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r")
}

#[derive(Debug)]
pub(crate) struct CurlResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

const CURL_STATUS_MARK: &[u8] = b"\n__ALINERY_HTTP_STATUS__:";

const CURL_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const CURL_TOTAL_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) fn curl_request(url: &str, headers: &[String], body: Option<&str>) -> Result<Vec<u8>, String> {
    Ok(curl_http(url, headers, body)?.body)
}

pub(crate) fn curl_http(url: &str, headers: &[String], body: Option<&str>) -> Result<CurlResponse, String> {
    let method = if body.is_some() { "POST" } else { "GET" };
    curl_http_method(url, method, headers, body)
}

pub(crate) fn curl_http_method(url: &str, method: &str, headers: &[String], body: Option<&str>) -> Result<CurlResponse, String> {
    curl_request_with_method(url, method, headers, body, CURL_CONNECT_TIMEOUT, CURL_TOTAL_TIMEOUT)
}

pub(crate) fn curl_request_with_timeouts(url: &str, headers: &[String], body: Option<&str>, connect_timeout: Duration, total_timeout: Duration) -> Result<CurlResponse, String> {
    let method = if body.is_some() { "POST" } else { "GET" };
    curl_request_with_method(url, method, headers, body, connect_timeout, total_timeout)
}

fn curl_request_with_method(url: &str, method: &str, headers: &[String], body: Option<&str>, connect_timeout: Duration, total_timeout: Duration) -> Result<CurlResponse, String> {
    let mut config = format!(
        "url = \"{}\"\nsilent\nshow-error\nlocation\nconnect-timeout = {:.3}\nmax-time = {:.3}\nwrite-out = \"\\n__ALINERY_HTTP_STATUS__:%{{http_code}}\"\n",
        curl_config_quote(url),
        connect_timeout.as_secs_f64(),
        total_timeout.as_secs_f64(),
    );
    for header in headers {
        config.push_str(&format!("header = \"{}\"\n", curl_config_quote(header)));
    }
    if method != "GET" {
        config.push_str(&format!("request = \"{}\"\n", curl_config_quote(method)));
    }
    if let Some(body) = body {
        config.push_str(&format!("data-binary = \"{}\"\n", curl_config_quote(body)));
    }
    let mut child = Command::new("curl")
        .args(["--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("start curl: {e}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "curl stdin unavailable".to_string())?
        .write_all(config.as_bytes())
        .map_err(|e| format!("write curl request: {e}"))?;
    let out = child.wait_with_output().map_err(|e| format!("finish curl: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    split_curl_status(&out.stdout)
}

fn split_curl_status(stdout: &[u8]) -> Result<CurlResponse, String> {
    let pos = stdout
        .windows(CURL_STATUS_MARK.len())
        .rposition(|window| window == CURL_STATUS_MARK)
        .ok_or_else(|| "curl response missing HTTP status".to_string())?;
    let status = std::str::from_utf8(&stdout[pos + CURL_STATUS_MARK.len()..])
        .map_err(|_| "curl response missing HTTP status".to_string())?
        .trim()
        .parse::<u16>()
        .map_err(|_| "curl response missing HTTP status".to_string())?;
    Ok(CurlResponse {
        status,
        body: stdout[..pos].to_vec(),
    })
}

fn linear_oauth_post(fields: &[(&str, &str)]) -> Result<Value, String> {
    let body = fields
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let out = curl_request(
        "https://api.linear.app/oauth/token",
        &["Content-Type: application/x-www-form-urlencoded".into()],
        Some(&body),
    )?;
    let value: Value = serde_json::from_slice(&out).map_err(|e| format!("bad Linear OAuth response: {e}"))?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(value.get("error_description").and_then(Value::as_str).unwrap_or(error).to_string());
    }
    Ok(value)
}

fn linear_viewer_account(access_token: &str) -> Result<String, String> {
    let out = curl_request(
        "https://api.linear.app/graphql",
        &["Content-Type: application/json".into(), format!("Authorization: Bearer {access_token}")],
        Some(r#"{"query":"query { viewer { name email } }"}"#),
    )?;
    let value: Value = serde_json::from_slice(&out).map_err(|e| format!("bad Linear viewer response: {e}"))?;
    let viewer = value
        .get("data")
        .and_then(|data| data.get("viewer"))
        .ok_or_else(|| format!("Linear connection failed: {}", value.get("errors").unwrap_or(&Value::Null)))?;
    Ok(viewer
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| viewer.get("email").and_then(Value::as_str))
        .unwrap_or("Linear account")
        .to_string())
}

fn tokens_from_linear_response(value: &Value, refresh_token: &str, account: String) -> Result<LinearOAuthTokens, String> {
    Ok(LinearOAuthTokens {
        access_token: value
            .get("access_token")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
            .ok_or_else(|| "Linear OAuth response is missing access_token".to_string())?
            .to_string(),
        refresh_token: value.get("refresh_token").and_then(Value::as_str).unwrap_or(refresh_token).to_string(),
        expires_at: now_secs().saturating_add(value.get("expires_in").and_then(Value::as_u64).unwrap_or(86_399)),
        account,
    })
}

fn connect_linear_blocking(app: &AppHandle) -> Result<ConnectionStatus, String> {
    let client_id = linear_client_id()
        .ok_or_else(|| format!("Linear OAuth is not configured for this build. Set ALINERY_LINEAR_CLIENT_ID and register {LINEAR_CALLBACK_URL} as its callback URL."))?;
    let listener = TcpListener::bind(LINEAR_CALLBACK_ADDR).map_err(|e| format!("listen for Linear OAuth callback on {LINEAR_CALLBACK_ADDR}: {e}"))?;
    let state = uuid::Uuid::new_v4().simple().to_string();
    let verifier = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let challenge = pkce_challenge(&verifier)?;
    let authorize_url = format!(
        "https://linear.app/oauth/authorize?client_id={}&redirect_uri={}&response_type=code&scope=read&state={}&code_challenge={}&code_challenge_method=S256",
        percent_encode(&client_id),
        percent_encode(LINEAR_CALLBACK_URL),
        percent_encode(&state),
        percent_encode(&challenge),
    );
    app.opener()
        .open_url(authorize_url, None::<&str>)
        .map_err(|e| format!("open Linear login in browser: {e}"))?;
    let code = wait_for_linear_callback(listener, &state)?;
    let value = linear_oauth_post(&[
        ("code", &code),
        ("redirect_uri", LINEAR_CALLBACK_URL),
        ("client_id", &client_id),
        ("code_verifier", &verifier),
        ("grant_type", "authorization_code"),
    ])?;
    let access_token = value
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Linear OAuth response is missing access_token".to_string())?;
    let account = linear_viewer_account(access_token)?;
    let tokens = tokens_from_linear_response(&value, "", account)?;
    save_linear_oauth_tokens(&tokens)?;
    // The Keychain already took the tokens, so a failed label write must not report a failed
    // connection -- but it must not report a clean one either. The label is what names the
    // credential, and reconnecting as someone else leaves the previous account's name sitting on
    // these tokens: Settings would identify account A while imports ran as B. Dropping the label
    // falls back to "reconnect to show your account", which is honest about not knowing.
    //
    // If even that fails the row would name the wrong account, and no status this returns can be
    // trusted, so the connection is reported as the partial success it is.
    if let Err(e) = save_linear_account(app, &tokens.account) {
        eprintln!("save Linear account label: {e}");
        let config_dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
        if !clear_linear_account_in(&config_dir) {
            return Err(format!(
                "Connected to Linear, but the account label could not be written or removed ({e}). Settings may name the account you were connected as before; fix that file's permissions and reconnect."
            ));
        }
    }
    Ok(linear_connection_status(app))
}

#[tauri::command]
pub(crate) async fn connect_linear(app: AppHandle) -> Result<ConnectionStatus, String> {
    tauri::async_runtime::spawn_blocking(move || connect_linear_blocking(&app))
        .await
        .map_err(|e| e.to_string())?
}

// There is deliberately no disconnect_github. Alinery holds no GitHub credential of its own --
// it reads whatever the gh CLI has -- so the only way to "remove" that connection is
// `gh auth logout`, which signs the user out in their terminal and every other gh caller.
// Reaching that far outside the app is not this row's business: GitHub offers Reconnect only.

/// Remove the OAuth tokens and the current account label.
#[tauri::command]
pub(crate) fn disconnect_linear(app: AppHandle) -> Result<ConnectionStatus, String> {
    #[cfg(target_os = "macos")]
    macos_keychain::delete(LINEAR_KEYCHAIN_SERVICE, "linear")?;
    if let Ok(config_dir) = app.path().app_config_dir() {
        // Not just this build's: the credential these labels name was shared by all of them.
        clear_linear_account_in(&config_dir);
    }
    Ok(linear_connection_status(&app))
}

pub(crate) fn linear_oauth_access_token() -> Result<Option<String>, LinearTokenError> {
    let Some(tokens) = load_linear_oauth_tokens()? else {
        return Ok(None);
    };
    if tokens.expires_at > now_secs().saturating_add(60) {
        return Ok(Some(tokens.access_token));
    }
    let client_id = linear_client_id().ok_or_else(|| "Linear OAuth client id is unavailable".to_string())?;
    let value = linear_oauth_post(&[("refresh_token", &tokens.refresh_token), ("grant_type", "refresh_token"), ("client_id", &client_id)])?;
    let refreshed = tokens_from_linear_response(&value, &tokens.refresh_token, tokens.account)?;
    let access_token = refreshed.access_token.clone();
    save_linear_oauth_tokens(&refreshed)?;
    Ok(Some(access_token))
}
