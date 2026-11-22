//! The loopback half of a provider sign-in that runs on another machine.
//!
//! A browser sign-in ends by redirecting to a loopback address on the machine that holds the
//! credential — `http://127.0.0.1:<port>/<path>`, a constant inside the daemon's agent runtime.
//! When the daemon is on a remote host (a repository over SSH), that address is on the host, so the
//! browser here cannot reach it and the daemon's own sign-in falls back to asking for a pasted URL.
//!
//! This listens on the same loopback address *here* for the length of one sign-in. The redirect the
//! browser cannot deliver to the host lands here instead, and the URL is handed to the frontend,
//! which replies it to the daemon's pending prompt. Nothing is proxied: the one-time code is
//! validated and exchanged on the host, under the daemon's `state` check.
//!
//! Only armed for a remote sign-in. A local repository's daemon already owns that port and completes
//! the callback itself, so binding it would fail there by design — and does, which is why the caller
//! treats a failed arm as "fall back to pasting the address bar".

use crate::*;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

/// How long an armed listener waits. A sign-in is minutes, not hours; past this the panel's paste
/// fallback is the only way left, and holding the port would block the next attempt.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Guards a client that connects and never sends, not normal jitter. Short on purpose: each
/// connection is answered on its own thread, but a stray socket should not hold even that for long.
const CALLBACK_READ_TIMEOUT: Duration = Duration::from_secs(2);
/// The ports the agent runtime's own sign-in redirects use: OpenAI 1455, Radius 1456, Anthropic 53692.
/// The daemon names the port, but on a remote repository that prompt arrives over ssh, so without an
/// allowlist a remote daemon could park any loopback port on this Mac. A flow that picks an ephemeral
/// port (OpenRouter's OAuth) never names one, so it keeps the paste fallback instead of arming.
const CALLBACK_PORTS: &[u16] = &[1455, 1456, 53692];
/// How long a re-arm keeps retrying a bind. A just-disarmed listener lets go of its port on its own
/// thread's next poll — after `disarm` returns — so a cancel followed by a quick retry would
/// otherwise read a port nothing holds as "in use" and fall back to pasting for no reason.
const BIND_RETRY_WINDOW: Duration = Duration::from_millis(1500);
const BIND_RETRY_PAUSE: Duration = Duration::from_millis(50);
const REQUEST_LINE_LIMIT: usize = 8 * 1024;

/// One armed listener at a time: the daemon's login broker aborts an older sign-in when a new one
/// starts, so two listeners would only ever be one live one plus a leak.
static ARMED: Mutex<Option<ArmedCallback>> = Mutex::new(None);

pub(crate) struct ArmedCallback {
    stop: Arc<AtomicBool>,
}

/// Owns the slot it registered, so a thread that ends by itself (delivered, expired) does not clear
/// a listener armed in the meantime.
pub(crate) struct CallbackGuard(pub(crate) Arc<AtomicBool>);

impl Drop for CallbackGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = ARMED.lock() {
            if slot.as_ref().is_some_and(|armed| Arc::ptr_eq(&armed.stop, &self.0)) {
                *slot = None;
            }
        }
    }
}

/// Arm the loopback listener. Binds before returning, so "the port is taken" reaches the caller
/// while it can still fall back to the paste path, and before it opens the browser.
///
/// The bind can retry past a just-disarmed listener for up to `BIND_RETRY_WINDOW`, so it runs on
/// the blocking pool rather than the UI thread.
#[tauri::command]
pub(crate) async fn provider_callback_arm<R: tauri::Runtime>(app: AppHandle<R>, port: u16, path: String) -> Result<(), String> {
    validate_callback_target(port, &path)?;
    disarm_provider_callback();
    let listener = tauri::async_runtime::spawn_blocking(move || bind_callback_listener(port))
        .await
        .map_err(|error| format!("sign-in callback bind task: {error}"))??;
    let stop = Arc::new(AtomicBool::new(false));
    *ARMED.lock().map_err(|e| e.to_string())? = Some(ArmedCallback { stop: stop.clone() });
    let guard = CallbackGuard(stop.clone());
    std::thread::spawn(move || {
        let _guard = guard;
        let deadline = Instant::now() + CALLBACK_TIMEOUT;
        match wait_for_provider_callback(listener, &path, &stop, deadline) {
            Ok(Some(url)) => {
                let _ = app.emit("provider_callback", json!({ "url": url }));
            }
            Ok(None) => {
                // Expired, not disarmed (a disarm sets `stop` first): the panel is still promising a
                // pickup that is no longer coming, so it must hear the listener gave up.
                if !stop.load(Ordering::SeqCst) {
                    let _ = app.emit("provider_callback_expired", ());
                }
            }
            Err(error) => eprintln!("provider callback listener: {error}"),
        }
    });
    Ok(())
}

/// What the app will hold a loopback port for: one of the runtime's own callback ports, and a path
/// with no query of its own (the query is the redirect's, and it is the daemon that parses it).
pub(crate) fn validate_callback_target(port: u16, path: &str) -> Result<(), String> {
    if port == 0 {
        return Err("a callback port is required".into());
    }
    if !CALLBACK_PORTS.contains(&port) {
        return Err(format!("not a port a sign-in redirects to: {port}"));
    }
    if !path.starts_with('/') || path.contains(['?', '#']) {
        return Err(format!("not a callback path: {path}"));
    }
    Ok(())
}

/// Bind the callback port, retrying past a just-disarmed sign-in's socket: its thread releases the
/// port on its next poll, which is after `disarm` returns. A sign-in that genuinely owns the port
/// (a local one, or the Codex CLI) holds it past the window, so a taken port is still reported.
pub(crate) fn bind_callback_listener(port: u16) -> Result<TcpListener, String> {
    let deadline = Instant::now() + BIND_RETRY_WINDOW;
    loop {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => return Ok(listener),
            Err(_taken) if Instant::now() + BIND_RETRY_PAUSE < deadline => std::thread::sleep(BIND_RETRY_PAUSE),
            Err(error) => return Err(format!("listen on 127.0.0.1:{port} for the sign-in callback: {error}")),
        }
    }
}

#[tauri::command]
pub(crate) fn provider_callback_disarm() -> Result<(), String> {
    disarm_provider_callback();
    Ok(())
}

fn disarm_provider_callback() {
    if let Ok(mut slot) = ARMED.lock() {
        if let Some(armed) = slot.take() {
            armed.stop.store(true, Ordering::SeqCst);
        }
    }
}

/// Accept until the browser's callback arrives, the caller disarms, or the deadline passes.
/// `Ok(Some(url))` is the redirect to hand to the daemon; `Ok(None)` is stopped or expired.
pub(crate) fn wait_for_provider_callback(listener: TcpListener, path: &str, stop: &AtomicBool, deadline: Instant) -> Result<Option<String>, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let origin = format!("http://{}", listener.local_addr().map_err(|e| e.to_string())?);
    // The redirect, handed over by whichever connection thread reads it.
    let (delivered, delivered_in) = mpsc::channel::<String>();
    loop {
        if stop.load(Ordering::SeqCst) || Instant::now() >= deadline {
            return Ok(None);
        }
        if let Ok(url) = delivered_in.try_recv() {
            return Ok(Some(url));
        }
        match listener.accept() {
            Ok((stream, _)) => {
                // Browsers hold speculative connections that never send (Chrome especially), so one
                // connection must never stall the redirect behind it: every one gets its own thread.
                let delivered = delivered.clone();
                let origin = origin.clone();
                let path = path.to_string();
                std::thread::spawn(move || answer_connection(stream, &path, &origin, delivered));
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(format!("receive sign-in callback: {error}")),
        }
    }
}

/// Read one connection, answer it with the loopback page, and hand the redirect over if this is it.
fn answer_connection(mut stream: TcpStream, path: &str, origin: &str, delivered: mpsc::Sender<String>) {
    // Accepted sockets inherit O_NONBLOCK on the BSDs, and one read can miss a split request line.
    if stream.set_nonblocking(false).is_err() || stream.set_read_timeout(Some(CALLBACK_READ_TIMEOUT)).is_err() {
        return;
    }
    let Ok(line) = read_request_line(&mut stream) else {
        write_callback_page(&mut stream, false);
        return;
    };
    match callback_url(&line, origin, path) {
        Some(url) => {
            write_callback_page(&mut stream, true);
            let _ = delivered.send(url);
        }
        None => write_callback_page(&mut stream, false),
    }
}

/// `GET /auth/callback?code=… HTTP/1.1` → `http://127.0.0.1:1455/auth/callback?code=…`.
///
/// The target is passed through verbatim: the daemon parses it, and it compares the origin and path
/// to its own redirect URI before reading `code`, `state` and `client_id`.
pub(crate) fn callback_url(request_line: &str, origin: &str, path: &str) -> Option<String> {
    let mut parts = request_line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    let query = target.strip_prefix(path)?.strip_prefix('?')?;
    // Only the redirect itself ends the wait: `state` plus a `code`, or the `error` a refused approval
    // redirects with. A page already open in the browser can ask for this path with no query at all,
    // and a bare match would burn the one listener on it while the panel still promises a pickup.
    if !query_has(query, "state") || !(query_has(query, "code") || query_has(query, "error")) {
        return None;
    }
    Some(format!("{origin}{target}"))
}

/// `?code=ac_2&state=s1` has a `state`. Keys only: the daemon parses the values.
fn query_has(query: &str, key: &str) -> bool {
    query.split('&').any(|pair| pair.split('=').next() == Some(key))
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

fn write_callback_page(stream: &mut TcpStream, ok: bool) {
    let body = loopback_html(ok);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}
