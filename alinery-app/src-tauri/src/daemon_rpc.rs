//! The webview bridge (plan 2.1.9): `daemon_rpc` forwards one gRPC-web call from the webview to the
//! repo's daemon as one HTTP/2 stream, and streams the answer back on a `Channel`.
//!
//! The shell knows neither gRPC nor protobuf here. It moves headers, data and trailers, adds the
//! bearer token (the webview never sees it), and batches frames the way `pump_session_stream` does.
//! Frame format on the Channel: `[u32 LE len][u8 kind][payload]`, `len` counting the kind byte; one
//! message holds one or more frames, then zeros up to 1 KiB (Tauri sends smaller raw bodies through
//! `webview.eval`, `session.rs` `frame_session_channel_bytes`). A zero length ends the message.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::client::conn::http2;
use hyper_util::rt::{TokioExecutor, TokioIo};
use tauri::ipc::{InvokeBody, InvokeResponseBody, JavaScriptChannelId, Request};
use tauri::{Manager, Webview};
use tokio::net::UnixStream;
use tokio::sync::{watch, Mutex as AsyncMutex};
use tokio::time::Instant;

use crate::daemon::{alineryd_socket_namespace, rpc_secret_path};
use crate::paths::{app_config_path, RepoRef};

const HEAD: u8 = 1;
const BODY: u8 = 2;
const END: u8 = 3;
const TRAILERS: u8 = 4;
const PAD_TO: usize = 1024;
const BATCH_BYTES: usize = 16 * 1024;
const FLUSH_AFTER: Duration = Duration::from_millis(8);
/// A cancel can arrive before its call registered, or after it ended; remember it briefly, bounded.
const MAX_TOMBSTONES: usize = 256;

type Sender = http2::SendRequest<Full<Bytes>>;

/// What the webview sends in the `x-alinery-rpc` header (ASCII JSON; the TypeScript side escapes the rest).
#[derive(serde::Deserialize)]
struct CallHeader {
    repo: String,
    call_id: String,
    path: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
}

pub(crate) struct Call {
    pub id: String,
    /// Whose calls die together: the label of the webview that made them.
    pub owner: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Default)]
struct Calls {
    live: HashMap<String, (String, watch::Sender<bool>)>,
    cancelled: HashSet<String>,
}

#[derive(Default)]
pub(crate) struct Bridge {
    conns: AsyncMutex<HashMap<PathBuf, Sender>>,
    calls: Mutex<Calls>,
}

static BRIDGE: LazyLock<Bridge> = LazyLock::new(Bridge::default);

/// One Channel message in the making: frames so far, flushed at 16 KiB, at 8 ms, and at END.
struct Out<F: FnMut(Vec<u8>) -> bool> {
    send: F,
    buf: Vec<u8>,
    since: Option<Instant>,
}

impl<F: FnMut(Vec<u8>) -> bool> Out<F> {
    /// False when the receiving side is gone.
    fn push(&mut self, kind: u8, payload: &[u8]) -> bool {
        self.buf.extend_from_slice(&(payload.len() as u32 + 1).to_le_bytes());
        self.buf.push(kind);
        self.buf.extend_from_slice(payload);
        self.since.get_or_insert_with(Instant::now);
        self.buf.len() < BATCH_BYTES || self.flush()
    }

    fn flush(&mut self) -> bool {
        self.since = None;
        if self.buf.is_empty() {
            return true;
        }
        let mut msg = std::mem::take(&mut self.buf);
        msg.resize(PAD_TO.max(msg.len() + 4), 0);
        (self.send)(msg)
    }

    fn deadline(&self) -> Option<Instant> {
        self.since.map(|at| at + FLUSH_AFTER)
    }
}

fn pairs(headers: &http::HeaderMap) -> Vec<(&str, &str)> {
    headers.iter().map(|(k, v)| (k.as_str(), v.to_str().unwrap_or(""))).collect()
}

async fn connect(socket: &Path) -> Result<Sender, String> {
    let stream = UnixStream::connect(socket).await.map_err(|e| format!("connect {}: {e}", socket.display()))?;
    let (sender, conn) = http2::handshake(TokioExecutor::new(), TokioIo::new(stream)).await.map_err(|e| e.to_string())?;
    tokio::spawn(conn);
    Ok(sender)
}

enum Outcome {
    Done,
    /// The Channel refused a send: the webview is gone.
    ReceiverGone,
}

impl Bridge {
    /// The daemon's connection, opened on first use and again when a call finds it closed.
    async fn sender(&self, socket: &Path, fresh: bool) -> Result<Sender, String> {
        let mut conns = self.conns.lock().await;
        if !fresh {
            if let Some(sender) = conns.get(socket).filter(|s| !s.is_closed()) {
                return Ok(sender.clone());
            }
        }
        let sender = connect(socket).await?;
        conns.insert(socket.to_path_buf(), sender.clone());
        Ok(sender)
    }

    async fn request(&self, socket: &Path, token: &str, call: &Call) -> Result<hyper::Response<hyper::body::Incoming>, String> {
        let build = || -> Result<http::Request<Full<Bytes>>, String> {
            // HTTP/2 takes :scheme and :authority from an absolute URI.
            let mut req = http::Request::post(format!("http://daemon{}", call.path));
            for (name, value) in &call.headers {
                // The token is the shell's to add, `te` is fixed, and a webview must not pick the transport's pseudo-fields.
                if !matches!(name.as_str(), "authorization" | "te" | "host" | "content-length") {
                    req = req.header(name, value);
                }
            }
            req.header("te", "trailers")
                .header("authorization", format!("Bearer {token}"))
                .body(Full::new(Bytes::from(call.body.clone())))
                .map_err(|e| e.to_string())
        };
        let mut sender = self.sender(socket, false).await?;
        match sender.send_request(build()?).await {
            // A connection that died between calls: nothing reached the daemon, so open another and send again.
            Err(e) if e.is_closed() || e.is_canceled() => self.sender(socket, true).await?.send_request(build()?).await.map_err(|e| e.to_string()),
            other => other.map_err(|e| e.to_string()),
        }
    }

    /// One unary call for the shell's own use: `message` is the protobuf body, the answer is the
    /// protobuf body of the reply. A non-zero `grpc-status` (in the trailers, or in the head of a
    /// trailers-only answer) is an error naming the status.
    pub(crate) async fn unary(&self, socket: &Path, token: &str, path: &str, message: &[u8]) -> Result<Vec<u8>, String> {
        let mut body = vec![0u8];
        body.extend_from_slice(&(message.len() as u32).to_be_bytes());
        body.extend_from_slice(message);
        let call = Call {
            id: String::new(),
            owner: String::new(),
            path: path.to_string(),
            headers: vec![("content-type".into(), "application/grpc+proto".into())],
            body,
        };
        let mut res = self.request(socket, token, &call).await?;
        let header = |map: &http::HeaderMap, name: &str| map.get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
        let (mut status, mut detail) = (header(res.headers(), "grpc-status"), header(res.headers(), "grpc-message"));
        let mut data = Vec::new();
        while let Some(frame) = res.frame().await {
            let frame = frame.map_err(|e| e.to_string())?;
            if let Some(chunk) = frame.data_ref() {
                data.extend_from_slice(chunk);
            } else if let Some(trailers) = frame.trailers_ref() {
                status = header(trailers, "grpc-status").or(status);
                detail = header(trailers, "grpc-message").or(detail);
            }
        }
        match status.as_deref() {
            Some("0") => {}
            Some(code) => return Err(format!("grpc-status {code}: {}", detail.unwrap_or_default())),
            None => return Err("the daemon answered without a grpc-status".into()),
        }
        let len = data.get(1..5).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize);
        match (data.first(), len) {
            (Some(0), Some(len)) if data.len() == 5 + len => Ok(data[5..].to_vec()),
            _ => Err("the daemon's reply was not one uncompressed gRPC message".into()),
        }
    }

    async fn drive<F: FnMut(Vec<u8>) -> bool>(&self, socket: &Path, token: &str, call: &Call, out: &mut Out<F>) -> Outcome {
        macro_rules! check {
            ($sent:expr) => {
                if !$sent {
                    return Outcome::ReceiverGone;
                }
            };
        }
        let mut res = match self.request(socket, token, call).await {
            Ok(res) => res,
            Err(e) => {
                check!(out.push(END, e.as_bytes()));
                check!(out.flush());
                return Outcome::Done;
            }
        };
        let head = serde_json::json!({ "status": res.status().as_u16(), "headers": pairs(res.headers()) });
        check!(out.push(HEAD, head.to_string().as_bytes()));
        loop {
            let next = match out.deadline() {
                Some(deadline) => tokio::select! {
                    frame = res.frame() => Some(frame),
                    _ = tokio::time::sleep_until(deadline) => None,
                },
                None => Some(res.frame().await),
            };
            match next {
                None => check!(out.flush()),
                Some(None) => break,
                Some(Some(Err(e))) => {
                    check!(out.push(END, e.to_string().as_bytes()));
                    check!(out.flush());
                    return Outcome::Done;
                }
                Some(Some(Ok(frame))) => {
                    if let Some(data) = frame.data_ref() {
                        if !data.is_empty() {
                            check!(out.push(BODY, data));
                        }
                    } else if let Some(trailers) = frame.trailers_ref() {
                        check!(out.push(TRAILERS, serde_json::to_string(&pairs(trailers)).unwrap_or_default().as_bytes()));
                    }
                }
            }
        }
        check!(out.push(END, b""));
        check!(out.flush());
        Outcome::Done
    }

    /// Run one call to its end. Returns when the call ended, was cancelled (nothing more is sent), or
    /// the receiver vanished (every call of the same owner is cancelled, so no orphan stream outlives its view).
    pub(crate) async fn run(&self, socket: &Path, token: &str, call: Call, send: impl FnMut(Vec<u8>) -> bool) {
        let Some(mut cancelled) = self.register(&call) else { return };
        let mut out = Out {
            send,
            buf: Vec::new(),
            since: None,
        };
        let outcome = tokio::select! {
            _ = cancelled.wait_for(|c| *c) => None,
            outcome = self.drive(socket, token, &call, &mut out) => Some(outcome),
        };
        // Dropping `drive` dropped the response, which resets only that stream.
        self.calls.lock().unwrap().live.remove(&call.id);
        if let Some(Outcome::ReceiverGone) = outcome {
            self.cancel_owner(&call.owner);
        }
    }

    fn register(&self, call: &Call) -> Option<watch::Receiver<bool>> {
        let mut calls = self.calls.lock().unwrap();
        if calls.cancelled.remove(&call.id) {
            return None;
        }
        let (tx, rx) = watch::channel(false);
        calls.live.insert(call.id.clone(), (call.owner.clone(), tx));
        Some(rx)
    }

    pub(crate) fn cancel(&self, call_id: &str) {
        let mut calls = self.calls.lock().unwrap();
        match calls.live.get(call_id) {
            Some((_, tx)) => {
                tx.send_replace(true);
            }
            None => {
                if calls.cancelled.len() >= MAX_TOMBSTONES {
                    calls.cancelled.clear();
                }
                calls.cancelled.insert(call_id.to_string());
            }
        }
    }

    pub(crate) fn cancel_owner(&self, owner: &str) {
        for (call_owner, tx) in self.calls.lock().unwrap().live.values() {
            if call_owner == owner {
                tx.send_replace(true);
            }
        }
    }
}

/// Where a repo key's RPC socket and token live. Pure: it touches no file, so an unknown key costs nothing.
pub(crate) fn resolve(repo_key: &str, app_config_dir: &Path, lane: Option<&str>) -> Result<(PathBuf, PathBuf), String> {
    match RepoRef::parse(repo_key)? {
        RepoRef::Local(repo) if repo.is_absolute() => Ok((alinery_core::rpc_socket_path(&repo, lane), rpc_secret_path(app_config_dir, repo_key, lane.unwrap_or("")))),
        RepoRef::Local(_) => Err(format!("not an absolute repository path: {repo_key}")),
        // The ssh forward's local end; the token is the copy this app kept when it started the daemon there.
        RepoRef::Remote { host_id, path } => Ok((
            crate::remote::rpc_forward(&host_id, &path)?.0,
            rpc_secret_path(&app_config_dir.join("remote").join(&host_id), &path, ""),
        )),
    }
}

fn read_call(request: &Request<'_>, owner: String) -> Result<(String, Call), String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("daemon_rpc takes a raw body".into());
    };
    let header = request.headers().get("x-alinery-rpc").and_then(|v| v.to_str().ok()).ok_or("missing x-alinery-rpc header")?;
    let call: CallHeader = serde_json::from_str(header).map_err(|e| format!("bad x-alinery-rpc header: {e}"))?;
    Ok((
        call.repo,
        Call {
            id: call.call_id,
            owner,
            path: call.path,
            headers: call.headers,
            body: body.clone(),
        },
    ))
}

#[tauri::command]
pub(crate) async fn daemon_rpc(request: Request<'_>, webview: Webview) -> Result<(), String> {
    let (repo, call) = read_call(&request, webview.label().to_string())?;
    let channel_id = request
        .headers()
        .get("x-alinery-channel")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-alinery-channel header")?;
    let channel = JavaScriptChannelId::from_str(channel_id)
        .map_err(|e| format!("bad x-alinery-channel header: {e}"))?
        .channel_on::<_, InvokeResponseBody>(webview.clone());
    let app = webview.app_handle();
    let config = app_config_path(app)?;
    let config_dir = alinery_core::app_config_dir_of(&config).ok_or("app config root unavailable")?;
    let (socket, secret_path) = resolve(&repo, config_dir, alineryd_socket_namespace().as_deref())?;
    let token = std::fs::read_to_string(&secret_path).map_err(|e| format!("daemon RPC token for {repo}: {e}"))?;
    // A closed window ends its calls too; a reload does not announce itself, and a failed send covers that.
    let label = webview.label().to_string();
    watch_window(&webview, &label);
    BRIDGE.run(&socket, token.trim(), call, |bytes| channel.send(InvokeResponseBody::Raw(bytes)).is_ok()).await;
    Ok(())
}

fn watch_window(webview: &Webview, label: &str) {
    static WATCHED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);
    if WATCHED.lock().unwrap().insert(label.to_string()) {
        let label = label.to_string();
        webview.window().on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                BRIDGE.cancel_owner(&label);
                WATCHED.lock().unwrap().remove(&label);
            }
        });
    }
}

#[tauri::command]
pub(crate) fn daemon_rpc_cancel(call_id: String) {
    BRIDGE.cancel(&call_id);
}

/// What `AdminService.Hello` answers that the shell reads.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Hello {
    pub protocol: u32,
    pub build_id: String,
    pub epoch: String,
}

/// Hello through the bridge path: the RPC liveness probe (over a forward a connect alone proves
/// nothing, plan 2.1.3). The two messages are encoded by hand; S1.4 replaces this with its prost
/// structs and golden test.
pub(crate) async fn hello(socket: &Path, token: &str) -> Result<Hello, String> {
    let id = b"alinery-shell";
    let mut request = vec![0x0a, id.len() as u8];
    request.extend_from_slice(id);
    request.extend_from_slice(&[0x12, 7]);
    request.extend_from_slice(b"desktop");
    request.push(0x18);
    request.push(alinery_core::PROTOCOL_VERSION as u8);
    let reply = tokio::time::timeout(Duration::from_secs(10), BRIDGE.unary(socket, token, "/alinery.v1.AdminService/Hello", &request))
        .await
        .map_err(|_| "Hello timed out".to_string())??;
    decode_hello(&reply)
}

fn decode_hello(mut bytes: &[u8]) -> Result<Hello, String> {
    fn varint(bytes: &mut &[u8]) -> Result<u64, String> {
        let (mut value, mut shift) = (0u64, 0);
        loop {
            let (&byte, rest) = bytes.split_first().ok_or("truncated Hello")?;
            *bytes = rest;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
            shift += 7;
        }
    }
    let mut hello = Hello {
        protocol: 0,
        build_id: String::new(),
        epoch: String::new(),
    };
    while !bytes.is_empty() {
        let tag = varint(&mut bytes)?;
        match tag & 7 {
            0 => {
                let value = varint(&mut bytes)?;
                if tag >> 3 == 1 {
                    hello.protocol = value as u32;
                }
            }
            2 => {
                let len = varint(&mut bytes)? as usize;
                let (field, rest) = bytes.split_at_checked(len).ok_or("truncated Hello")?;
                bytes = rest;
                match tag >> 3 {
                    2 => hello.build_id = String::from_utf8_lossy(field).into_owned(),
                    3 => hello.epoch = String::from_utf8_lossy(field).into_owned(),
                    _ => {}
                }
            }
            other => return Err(format!("unexpected wire type {other} in Hello")),
        }
    }
    Ok(hello)
}
