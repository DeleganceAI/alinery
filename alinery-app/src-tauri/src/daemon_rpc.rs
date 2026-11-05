//! The webview bridge (plan 2.1.9): `daemon_rpc` forwards one gRPC-web call from the webview to the
//! repo's daemon as one HTTP/2 stream, and streams the answer back on a `Channel`.
//!
//! The shell knows neither gRPC nor protobuf here. It moves headers, data and trailers, adds the
//! bearer token (the webview never sees it), and batches frames so a chatty stream is not one Channel message per read.
//! Frame format on the Channel: `[u32 LE len][u8 kind][payload]`, `len` counting the kind byte; one
//! message holds one or more frames, then zeros up to 1 KiB (Tauri sends smaller raw bodies through
//! `webview.eval`). A zero length ends the message.

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

use alinery_core::daemon_client::{peer_process_identity, PeerProcessIdentity, DAEMON_CONTROL_TIMEOUT};
use prost::Message;

use crate::daemon::{alineryd_socket_namespace, rpc_secret_path};
use crate::paths::{app_config_dir_of, app_config_path, RepoRef};

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

fn build_request(token: &str, call: &Call) -> Result<http::Request<Full<Bytes>>, String> {
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
}

enum Outcome {
    Done,
    /// The Channel refused a send: the webview is gone.
    ReceiverGone,
}

fn unary_call(path: &str, message: &[u8]) -> Call {
    let mut body = vec![0u8];
    body.extend_from_slice(&(message.len() as u32).to_be_bytes());
    body.extend_from_slice(message);
    Call {
        id: String::new(),
        owner: String::new(),
        path: path.to_string(),
        headers: vec![("content-type".into(), "application/grpc+proto".into())],
        body,
    }
}

/// An error that carries the daemon's own answer, as opposed to one where no answer arrived.
const STATUS_PREFIX: &str = "grpc-status ";

async fn read_unary(mut res: hyper::Response<hyper::body::Incoming>) -> Result<Vec<u8>, String> {
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
        Some(code) => return Err(format!("{STATUS_PREFIX}{code}: {}", detail.unwrap_or_default())),
        None => return Err("the daemon answered without a grpc-status".into()),
    }
    let len = data.get(1..5).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize);
    match (data.first(), len) {
        (Some(0), Some(len)) if data.len() == 5 + len => Ok(data[5..].to_vec()),
        _ => Err("the daemon's reply was not one uncompressed gRPC message".into()),
    }
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
        let mut sender = self.sender(socket, false).await?;
        match sender.send_request(build_request(token, call)?).await {
            // A connection that died between calls: nothing reached the daemon, so open another and send again.
            Err(e) if e.is_closed() || e.is_canceled() => self.sender(socket, true).await?.send_request(build_request(token, call)?).await.map_err(|e| e.to_string()),
            other => other.map_err(|e| e.to_string()),
        }
    }

    /// One unary call for the shell's own use: `message` is the protobuf body, the answer is the
    /// protobuf body of the reply. A non-zero `grpc-status` (in the trailers, or in the head of a
    /// trailers-only answer) is an error naming the status.
    pub(crate) async fn unary(&self, socket: &Path, token: &str, path: &str, message: &[u8]) -> Result<Vec<u8>, String> {
        let res = self.request(socket, token, &unary_call(path, message)).await?;
        read_unary(res).await
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
    let token = rpc_token(&socket, &secret_path).await.map_err(|e| format!("daemon RPC token for {repo}: {e}"))?;
    // A closed window ends its calls too; a reload does not announce itself, and a failed send covers that.
    let label = webview.label().to_string();
    watch_window(&webview, &label);
    BRIDGE.run(&socket, &token, call, |bytes| channel.send(InvokeResponseBody::Raw(bytes)).is_ok()).await;
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

// The admin messages the shell sends and reads, written by hand from proto/alinery/v1/admin.proto
// (grpc-js speaks only binary protobuf, so there is no generated Rust). `tests::daemon_rpc` decodes
// the bytes protobuf-es wrote from the same .proto (`proto/golden/admin.json`), so a field renumbered
// there fails `cargo test` and names the field.

#[derive(Clone, Copy, Debug, PartialEq, Eq, prost::Enumeration)]
#[repr(i32)]
pub(crate) enum Capability {
    Unspecified = 0,
    View = 1,
    Act = 2,
    Approve = 3,
    Admin = 4,
    Agent = 5,
}

/// Invariant 1: the only ways to stop a daemon. A name appears only in the functions the gate
/// (`check-no-auto-session-kill.sh`) lists.
#[derive(Clone, Copy, Debug, PartialEq, Eq, prost::Enumeration)]
#[repr(i32)]
pub(crate) enum ShutdownOrigin {
    Unspecified = 0,
    StopDaemon = 1,
    CloseRepo = 2,
    RestoreBackup = 3,
    ConfirmedTakeover = 4,
    StopRemote = 5,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(crate) struct HelloRequest {
    #[prost(string, tag = "1")]
    pub client_id: String,
    #[prost(string, tag = "2")]
    pub client_kind: String,
    #[prost(uint32, tag = "3")]
    pub protocol: u32,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(crate) struct HelloResponse {
    #[prost(uint32, tag = "1")]
    pub protocol: u32,
    #[prost(string, tag = "2")]
    pub build_id: String,
    #[prost(string, tag = "3")]
    pub epoch: String,
    #[prost(enumeration = "Capability", repeated, tag = "4")]
    pub capabilities: Vec<i32>,
    #[prost(string, tag = "5")]
    pub repo_root: String,
    #[prost(string, tag = "6")]
    pub app_config_identity: String,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(crate) struct ShutdownRequest {
    #[prost(enumeration = "ShutdownOrigin", tag = "1")]
    pub origin: i32,
    #[prost(string, tag = "2")]
    pub confirmation_id: String,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(crate) struct ShutdownResponse {
    #[prost(uint32, tag = "1")]
    pub sessions_stopped: u32,
}

/// One unary call on the bridge's pooled connection to `socket`, with the messages typed.
pub(crate) async fn unary<Req: prost::Message, Res: prost::Message + Default>(socket: &Path, token: &str, path: &str, request: &Req) -> Result<Res, String> {
    let reply = BRIDGE.unary(socket, token, path, &request.encode_to_vec()).await?;
    Res::decode(reply.as_slice()).map_err(|e| format!("the daemon's reply to {path} did not decode: {e}"))
}

/// Hello through the bridge path: the RPC liveness probe (over a forward a connect alone proves
/// nothing, plan 2.1.3).
pub(crate) async fn hello(socket: &Path, token: &str) -> Result<HelloResponse, String> {
    let request = HelloRequest {
        client_id: "alinery-shell".into(),
        client_kind: "desktop".into(),
        protocol: alinery_core::PROTOCOL_VERSION,
    };
    tokio::time::timeout(Duration::from_secs(10), unary(socket, token, "/alinery.v1.AdminService/Hello", &request))
        .await
        .map_err(|_| "Hello timed out".to_string())?
}

/// The token for the daemon on `socket`. A start keeps its new token as pending (see
/// `store_pending_rpc_secret`); the daemon that answers Hello with it makes it the committed one,
/// and until one does the committed token is still the live daemon's.
pub(crate) async fn rpc_token(socket: &Path, committed: &Path) -> Result<String, String> {
    let read = |path: &Path| std::fs::read_to_string(path).map(|token| token.trim().to_string());
    let old = read(committed);
    let pending = crate::daemon::pending_rpc_secret_path(committed);
    if let Ok(new) = read(&pending) {
        if hello(socket, &new).await.is_ok() {
            std::fs::rename(&pending, committed).map_err(|e| format!("commit RPC token: {e}"))?;
            return Ok(new);
        }
        if old.is_err() {
            return Ok(new);
        }
    }
    old.map_err(|e| e.to_string())
}

/// Stop one daemon through `AdminService.Shutdown` with the origin of the deliberate action that
/// asked for it, and return how many sessions it ended.
///
/// `bound` is the process incarnation a takeover's consent was given for: the connection is refused
/// when its peer is another process. The call goes on a connection of its own, never the bridge's
/// pooled one, which a restart would leave stale.
async fn shutdown_over_rpc(socket: &Path, token: &str, origin: ShutdownOrigin, confirmation_id: &str, bound: Option<&PeerProcessIdentity>) -> Result<u32, String> {
    let stream = std::os::unix::net::UnixStream::connect(socket).map_err(|e| format!("connect {}: {e}", socket.display()))?;
    if let Some(expected) = bound {
        if peer_process_identity(&stream)? != *expected {
            return Err("stale daemon: peer process incarnation changed".into());
        }
    }
    stream.set_nonblocking(true).map_err(|e| e.to_string())?;
    let stream = UnixStream::from_std(stream).map_err(|e| e.to_string())?;
    let (mut sender, conn) = http2::handshake(TokioExecutor::new(), TokioIo::new(stream)).await.map_err(|e| e.to_string())?;
    tokio::spawn(conn);
    let request = ShutdownRequest {
        origin: origin as i32,
        confirmation_id: confirmation_id.into(),
    };
    let call = unary_call("/alinery.v1.AdminService/Shutdown", &request.encode_to_vec());
    let reply = tokio::time::timeout(DAEMON_CONTROL_TIMEOUT, async {
        read_unary(sender.send_request(build_request(token, &call)?).await.map_err(|e| e.to_string())?).await
    })
    .await
    .map_err(|_| "Shutdown timed out".to_string())??;
    Ok(ShutdownResponse::decode(reply.as_slice())
        .map_err(|e| format!("the daemon's reply to Shutdown did not decode: {e}"))?
        .sessions_stopped)
}

/// Where a teardown reaches a daemon: `repo_key`'s RPC socket and the token this app kept for it.
/// A daemon that cannot be reached there (one of an older protocol has no `rpc.sock`, one started by
/// another app has a token this one lacks, or the socket is a stale file) is stopped through
/// `legacy`, the JSON `shutdown` op that `AdminService.Shutdown` replaces (plan O23: the new app must
/// still be able to stop an older daemon; S5.3 deletes it). A daemon that does answer and refuses
/// (a wrong token, a missing capability, a bad origin) is an error, never a retry on the old wire.
/// The five teardown origins call this, and only they.
pub(crate) fn shutdown_daemon(
    repo_key: &str,
    app_config: &Path,
    lane: Option<&str>,
    origin: ShutdownOrigin,
    confirmation_id: &str,
    bound: Option<&PeerProcessIdentity>,
    legacy: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let (socket, secret_path) = resolve(repo_key, app_config_dir_of(app_config).ok_or("app config root unavailable")?, lane)?;
    let shutdown = tauri::async_runtime::block_on(async {
        let token = rpc_token(&socket, &secret_path).await?;
        shutdown_over_rpc(&socket, &token, origin, confirmation_id, bound).await
    });
    match shutdown {
        Ok(_) => Ok(()),
        Err(error) if error.starts_with(STATUS_PREFIX) => Err(format!("the daemon refused to shut down: {error}")),
        // A daemon that took the connection and then went silent is not an older one; the old wire would only wedge too.
        Err(error) if error.starts_with("stale daemon") || error.ends_with("timed out") => Err(error),
        Err(_) => legacy(),
    }
}
