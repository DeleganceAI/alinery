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
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How long an armed listener waits. A sign-in is minutes, not hours; past this the panel's paste
/// fallback is the only way left, and holding the port would block the next attempt.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Guards a client that connects and never sends, not normal jitter.
const CALLBACK_READ_TIMEOUT: Duration = Duration::from_secs(10);
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
#[tauri::command]
pub(crate) fn provider_callback_arm<R: tauri::Runtime>(app: AppHandle<R>, port: u16, path: String) -> Result<(), String> {
    if port == 0 {
        return Err("a callback port is required".into());
    }
    if !path.starts_with('/') || path.contains(['?', '#']) {
        return Err(format!("not a callback path: {path}"));
    }
    disarm_provider_callback();
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|error| format!("listen on 127.0.0.1:{port} for the sign-in callback: {error}"))?;
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
            Ok(None) => {}
            Err(error) => eprintln!("provider callback listener: {error}"),
        }
    });
    Ok(())
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
    loop {
        if stop.load(Ordering::SeqCst) || Instant::now() >= deadline {
            return Ok(None);
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                // Accepted sockets inherit O_NONBLOCK on the BSDs, and one read can miss a split request line.
                if stream.set_nonblocking(false).is_err() || stream.set_read_timeout(Some(CALLBACK_READ_TIMEOUT)).is_err() {
                    continue;
                }
                let Ok(line) = read_request_line(&mut stream) else {
                    write_callback_page(&mut stream, false);
                    continue;
                };
                match callback_url(&line, &origin, path) {
                    Some(url) => {
                        write_callback_page(&mut stream, true);
                        return Ok(Some(url));
                    }
                    // A browser asks for more than the redirect (favicon, spare connections): keep waiting.
                    None => write_callback_page(&mut stream, false),
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => return Err(format!("receive sign-in callback: {error}")),
        }
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
    let rest = target.strip_prefix(path)?;
    if !(rest.is_empty() || rest.starts_with('?')) {
        return None;
    }
    Some(format!("{origin}{target}"))
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
