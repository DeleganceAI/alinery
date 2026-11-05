//! The webview bridge against a stand-in daemon: a hyper HTTP/2 server on a temp unix socket.

use super::*;
use crate::daemon_rpc::{hello, resolve, shutdown_daemon, Bridge, Call, Capability, HelloRequest, HelloResponse, ShutdownOrigin, ShutdownRequest, ShutdownResponse};
use bytes::Bytes;
use http::HeaderMap;
use http_body_util::BodyExt;
use hyper::body::{Body, Frame, Incoming};
use hyper::server::conn::http2;
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo};
use prost::Message;
use std::convert::Infallible;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::sync::{mpsc, watch};

const HEAD: u8 = 1;
const BODY: u8 = 2;
const END: u8 = 3;
const TRAILERS: u8 = 4;

type Held = Arc<Mutex<Vec<mpsc::UnboundedSender<Frame<Bytes>>>>>;

/// A response body fed from a channel. Dropping it before the end is how the server sees a client reset.
struct Feed {
    rx: mpsc::UnboundedReceiver<Frame<Bytes>>,
    finished: bool,
    empty: bool,
    aborted: Arc<AtomicUsize>,
}

impl Body for Feed {
    type Data = Bytes;
    type Error = Infallible;
    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        match self.rx.poll_recv(cx) {
            Poll::Ready(Some(frame)) => Poll::Ready(Some(Ok(frame))),
            Poll::Ready(None) => {
                self.finished = true;
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
    fn is_end_stream(&self) -> bool {
        self.empty
    }
}

impl Drop for Feed {
    fn drop(&mut self) {
        if !self.finished && !self.empty {
            self.aborted.fetch_add(1, Ordering::SeqCst);
        }
    }
}

/// Every Shutdown any stand-in received: the Authorization header, then the decoded request.
static SHUTDOWNS: Mutex<Vec<(String, ShutdownRequest)>> = Mutex::new(Vec::new());

fn shutdowns_with(token: &str) -> Vec<ShutdownRequest> {
    SHUTDOWNS
        .lock()
        .unwrap()
        .iter()
        .filter(|(t, _)| t == &format!("Bearer {token}"))
        .map(|(_, r)| r.clone())
        .collect()
}

struct Server {
    socket: PathBuf,
    accepts: Arc<AtomicUsize>,
    aborted: Arc<AtomicUsize>,
    kill: watch::Sender<u32>,
    _dir: PathBuf,
}

fn trailers(status: &str) -> Frame<Bytes> {
    let mut map = HeaderMap::new();
    map.insert("grpc-status", status.parse().unwrap());
    Frame::trailers(map)
}

async fn answer(req: http::Request<Incoming>, aborted: Arc<AtomicUsize>, held: Held, kill: watch::Sender<u32>) -> Result<http::Response<Feed>, Infallible> {
    let (tx, rx) = mpsc::unbounded_channel();
    let mut builder = http::Response::builder().header("content-type", "application/grpc");
    let mut empty = false;
    match req.uri().path() {
        "/unary" => {
            tx.send(Frame::data(Bytes::from_static(b"hello"))).unwrap();
            tx.send(trailers("0")).unwrap();
        }
        "/echo" => {
            let sent = req.into_body().collect().await.unwrap().to_bytes();
            tx.send(Frame::data(sent)).unwrap();
            tx.send(trailers("0")).unwrap();
        }
        // protocol 25, build_id "b-1", epoch "e-7", capabilities [1, 2] (packed), repo_root "/r".
        "/alinery.v1.AdminService/Hello" if req.headers().get("authorization").is_some_and(|v| v == "Bearer stale") => {
            builder = builder.header("grpc-status", "16").header("grpc-message", "wrong token");
            empty = true;
        }
        "/alinery.v1.AdminService/Hello" => {
            let mut message = vec![0x08, 25, 0x12, 3];
            message.extend_from_slice(b"b-1");
            message.extend_from_slice(&[0x1a, 3]);
            message.extend_from_slice(b"e-7");
            message.extend_from_slice(&[0x22, 2, 1, 2, 0x2a, 2]);
            message.extend_from_slice(b"/r");
            let mut body = vec![0, 0, 0, 0, message.len() as u8];
            body.extend_from_slice(&message);
            tx.send(Frame::data(Bytes::from(body))).unwrap();
            tx.send(trailers("0")).unwrap();
        }
        // Reads the token and the request the way the real daemon would, and answers with what it saw:
        // sessions_stopped = origin * 1000 + the length of the confirmation id.
        "/alinery.v1.AdminService/Shutdown" => {
            let token = req.headers().get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            let sent = req.into_body().collect().await.unwrap().to_bytes();
            let request = ShutdownRequest::decode(&sent[5..]).unwrap();
            SHUTDOWNS.lock().unwrap().push((token.clone(), request.clone()));
            if token == "Bearer wrong" {
                builder = builder.header("grpc-status", "16").header("grpc-message", "wrong token");
                empty = true;
            } else {
                let message = ShutdownResponse {
                    sessions_stopped: request.origin as u32 * 1000 + request.confirmation_id.len() as u32,
                }
                .encode_to_vec();
                let mut body = vec![0, 0, 0, 0, message.len() as u8];
                body.extend_from_slice(&message);
                tx.send(Frame::data(Bytes::from(body))).unwrap();
                tx.send(trailers("0")).unwrap();
            }
        }
        "/trailers-only" => {
            builder = builder.header("grpc-status", "16");
            empty = true;
        }
        "/stream100" => {
            for i in 0..100u8 {
                tx.send(Frame::data(Bytes::from(vec![i; 10]))).unwrap();
            }
            tx.send(trailers("0")).unwrap();
        }
        "/hang" => {
            tx.send(Frame::data(Bytes::from_static(b"x"))).unwrap();
            held.lock().unwrap().push(tx);
        }
        "/close" => {
            kill.send_modify(|n| *n += 1);
            std::future::pending::<()>().await;
        }
        "/headers" => {
            let seen: Vec<(String, String)> = req.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_string())).collect();
            tx.send(Frame::data(Bytes::from(serde_json::to_vec(&seen).unwrap()))).unwrap();
        }
        other => panic!("unexpected path {other}"),
    }
    Ok(builder
        .body(Feed {
            rx,
            finished: false,
            empty,
            aborted,
        })
        .unwrap())
}

async fn serve() -> Server {
    let dir = PathBuf::from(format!("/tmp/alinery-rpc-test-{}", &uuid::Uuid::new_v4().simple().to_string()[..10]));
    fs::create_dir_all(&dir).unwrap();
    serve_at(dir.join("rpc.sock"), dir).await
}

async fn serve_at(socket: PathBuf, dir: PathBuf) -> Server {
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let (accepts, aborted, held) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)), Held::default());
    let (kill, _) = watch::channel(0u32);
    let server = Server {
        socket,
        accepts: accepts.clone(),
        aborted: aborted.clone(),
        kill: kill.clone(),
        _dir: dir,
    };
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            accepts.fetch_add(1, Ordering::SeqCst);
            let (aborted, held, kill) = (aborted.clone(), held.clone(), kill.clone());
            let mut killed = kill.subscribe();
            tokio::spawn(async move {
                let service = service_fn(move |req| answer(req, aborted.clone(), held.clone(), kill.clone()));
                let conn = http2::Builder::new(TokioExecutor::new()).serve_connection(TokioIo::new(stream), service);
                tokio::select! {
                    _ = conn => {}
                    _ = killed.changed() => {}
                }
            });
        }
    });
    server
}

fn call(id: &str, owner: &str, path: &str) -> Call {
    Call {
        id: id.into(),
        owner: owner.into(),
        path: path.into(),
        headers: vec![("content-type".into(), "application/grpc+proto".into())],
        body: vec![0, 0, 0, 0, 0],
    }
}

/// The frames of every channel message, in order, and the number of messages.
struct Got {
    frames: Vec<(u8, Vec<u8>)>,
    messages: usize,
}

fn split(msg: &[u8], into: &mut Vec<(u8, Vec<u8>)>) {
    assert!(msg.len() >= 1024, "a channel message is padded to 1 KiB, got {}", msg.len());
    let mut at = 0;
    while at + 4 <= msg.len() {
        let len = u32::from_le_bytes(msg[at..at + 4].try_into().unwrap()) as usize;
        if len == 0 {
            break;
        }
        into.push((msg[at + 4], msg[at + 5..at + 4 + len].to_vec()));
        at += 4 + len;
    }
}

async fn collect(bridge: &Bridge, server: &Server, call: Call) -> Got {
    let mut got = Got { frames: vec![], messages: 0 };
    bridge
        .run(&server.socket, "tok", call, |msg| {
            got.messages += 1;
            split(&msg, &mut got.frames);
            true
        })
        .await;
    got
}

fn kinds(got: &Got) -> Vec<u8> {
    got.frames.iter().map(|f| f.0).collect()
}

async fn until(what: &str, mut ready: impl FnMut() -> bool) {
    for _ in 0..200 {
        if ready() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn a_unary_call_gives_head_body_trailers_then_end() {
    let (bridge, server) = (Bridge::default(), serve().await);
    let got = collect(&bridge, &server, call("c1", "w", "/unary")).await;
    assert_eq!(kinds(&got), vec![HEAD, BODY, TRAILERS, END]);
    let head: serde_json::Value = serde_json::from_slice(&got.frames[0].1).unwrap();
    assert_eq!(head["status"], 200);
    assert!(head["headers"].as_array().unwrap().iter().any(|p| p[0] == "content-type" && p[1] == "application/grpc"));
    assert_eq!(got.frames[1].1, b"hello");
    let trailers: serde_json::Value = serde_json::from_slice(&got.frames[2].1).unwrap();
    assert!(trailers.as_array().unwrap().iter().any(|p| p[0] == "grpc-status" && p[1] == "0"));
    assert!(got.frames[3].1.is_empty(), "END carries no error");
}

#[tokio::test]
async fn a_trailers_only_answer_gives_head_then_end_without_trailers() {
    let (bridge, server) = (Bridge::default(), serve().await);
    let got = collect(&bridge, &server, call("c1", "w", "/trailers-only")).await;
    assert_eq!(kinds(&got), vec![HEAD, END]);
    let head: serde_json::Value = serde_json::from_slice(&got.frames[0].1).unwrap();
    assert!(head["headers"].as_array().unwrap().iter().any(|p| p[0] == "grpc-status" && p[1] == "16"));
}

#[tokio::test]
async fn the_shell_adds_the_token_and_te_and_ignores_the_webviews_own() {
    let (bridge, server) = (Bridge::default(), serve().await);
    let mut c = call("c1", "w", "/headers");
    c.headers.push(("authorization".into(), "Bearer webview-chosen".into()));
    c.headers.push(("te".into(), "gzip".into()));
    c.headers.push(("x-custom".into(), "1".into()));
    let got = collect(&bridge, &server, c).await;
    let seen: Vec<(String, String)> = serde_json::from_slice(&got.frames[1].1).unwrap();
    let get = |name: &str| seen.iter().filter(|(k, _)| k == name).map(|(_, v)| v.as_str()).collect::<Vec<_>>();
    assert_eq!(get("authorization"), ["Bearer tok"]);
    assert_eq!(get("te"), ["trailers"]);
    assert_eq!(get("x-custom"), ["1"]);
    assert_eq!(get("content-type"), ["application/grpc+proto"]);
}

#[tokio::test]
async fn a_stream_of_100_chunks_arrives_in_fewer_messages_and_in_order() {
    let (bridge, server) = (Bridge::default(), serve().await);
    let got = collect(&bridge, &server, call("c1", "w", "/stream100")).await;
    let body: Vec<u8> = got.frames.iter().filter(|f| f.0 == BODY).flat_map(|f| f.1.clone()).collect();
    let expected: Vec<u8> = (0..100u8).flat_map(|i| vec![i; 10]).collect();
    assert_eq!(body, expected);
    assert_eq!(*kinds(&got).last().unwrap(), END);
    assert!(got.messages < 100, "100 chunks took {} channel messages", got.messages);
}

#[tokio::test]
async fn a_cancel_mid_stream_reaches_the_server_and_the_next_call_reuses_the_connection() {
    let (bridge, server) = (Arc::new(Bridge::default()), serve().await);
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let run = {
        let (bridge, socket) = (bridge.clone(), server.socket.clone());
        tokio::spawn(async move { bridge.run(&socket, "tok", call("c1", "w", "/hang"), move |msg| tx.send(msg).is_ok()).await })
    };
    let first = rx.recv().await.expect("the stream's first message");
    let mut frames = vec![];
    split(&first, &mut frames);
    assert_eq!(frames[0].0, HEAD);
    bridge.cancel("c1");
    run.await.unwrap();
    until("the server to see the reset", || server.aborted.load(Ordering::SeqCst) == 1).await;
    while let Ok(msg) = rx.try_recv() {
        let mut more = vec![];
        split(&msg, &mut more);
        assert!(more.iter().all(|f| f.0 != END), "nothing is sent after a cancel");
    }
    let got = collect(&bridge, &server, call("c2", "w", "/unary")).await;
    assert_eq!(*kinds(&got).last().unwrap(), END);
    assert_eq!(server.accepts.load(Ordering::SeqCst), 1, "the same connection served both calls");
}

#[tokio::test]
async fn a_cancel_that_arrives_before_the_call_starts_still_cancels_it() {
    let (bridge, server) = (Bridge::default(), serve().await);
    bridge.cancel("early");
    let got = collect(&bridge, &server, call("early", "w", "/unary")).await;
    assert!(got.frames.is_empty());
    assert_eq!(server.accepts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_closed_channel_resets_the_stream_and_every_call_of_that_webview() {
    let (bridge, server) = (Arc::new(Bridge::default()), serve().await);
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let sibling = {
        let (bridge, socket) = (bridge.clone(), server.socket.clone());
        tokio::spawn(async move { bridge.run(&socket, "tok", call("sibling", "w", "/hang"), move |msg| tx.send(msg).is_ok()).await })
    };
    rx.recv().await.expect("the sibling stream is open");
    // The webview is gone: its Channel refuses every send, and nobody calls daemon_rpc_cancel.
    bridge.run(&server.socket, "tok", call("c1", "w", "/hang"), |_| false).await;
    tokio::time::timeout(Duration::from_secs(5), sibling).await.expect("the sibling call ends too").unwrap();
    until("the server to see both resets", || server.aborted.load(Ordering::SeqCst) == 2).await;
}

#[tokio::test]
async fn cancelling_one_owner_leaves_another_owners_calls_alone() {
    let (bridge, server) = (Arc::new(Bridge::default()), serve().await);
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let other = {
        let (bridge, socket) = (bridge.clone(), server.socket.clone());
        tokio::spawn(async move { bridge.run(&socket, "tok", call("other", "w2", "/hang"), move |msg| tx.send(msg).is_ok()).await })
    };
    rx.recv().await.unwrap();
    bridge.cancel_owner("w1");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!other.is_finished());
    assert_eq!(server.aborted.load(Ordering::SeqCst), 0);
    bridge.cancel("other");
    other.await.unwrap();
}

#[tokio::test]
async fn a_server_that_closes_the_connection_gives_end_with_an_error_and_the_next_call_reconnects() {
    let (bridge, server) = (Bridge::default(), serve().await);
    let got = collect(&bridge, &server, call("c1", "w", "/close")).await;
    let (kind, payload) = got.frames.last().unwrap();
    assert_eq!(*kind, END);
    assert!(!payload.is_empty(), "END carries the transport error");
    assert_eq!(server.accepts.load(Ordering::SeqCst), 1);
    let got = collect(&bridge, &server, call("c2", "w", "/unary")).await;
    assert_eq!(kinds(&got), vec![HEAD, BODY, TRAILERS, END]);
    assert_eq!(server.accepts.load(Ordering::SeqCst), 2);
    let _ = server.kill;
}

#[tokio::test]
async fn a_daemon_that_is_not_there_gives_end_with_an_error() {
    let bridge = Bridge::default();
    let mut got = vec![];
    bridge
        .run(Path::new("/tmp/alinery-no-such-rpc.sock"), "tok", call("c1", "w", "/unary"), |msg| {
            split(&msg, &mut got);
            true
        })
        .await;
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].0, END);
    assert!(!got[0].1.is_empty());
}

#[test]
fn resolve_maps_a_local_key_to_its_lane_socket_and_token_without_touching_disk() {
    let cfg = Path::new("/nonexistent-alinery-config");
    let (socket, secret) = resolve("/nonexistent/repo", cfg, None).unwrap();
    assert_eq!(socket, Path::new("/nonexistent/repo/.alinery/rpc.sock"));
    assert_eq!(secret, crate::daemon::rpc_secret_path(cfg, "/nonexistent/repo", ""));
    let (socket, secret) = resolve("/nonexistent/repo", cfg, Some("d0123abc")).unwrap();
    assert_eq!(socket, Path::new("/nonexistent/repo/.alinery/rpc-d0123abc.sock"));
    assert_eq!(secret, crate::daemon::rpc_secret_path(cfg, "/nonexistent/repo", "d0123abc"));
    assert!(!Path::new("/nonexistent/repo").exists());
}

#[test]
fn resolve_refuses_an_unknown_key_without_touching_the_filesystem() {
    let cfg = Path::new("/nonexistent-alinery-config");
    for key in ["", "relative/repo", "alinery+ssh://", "alinery+ssh://host-only"] {
        assert!(resolve(key, cfg, None).is_err(), "{key:?} must not resolve");
    }
}

#[test]
fn resolve_maps_a_remote_key_to_its_ssh_forward_and_the_token_this_app_kept_for_it() {
    let cfg = Path::new("/nonexistent-alinery-config");
    let (socket, secret) = resolve("alinery+ssh://host-1/home/me/repo", cfg, Some("ignored-lane")).unwrap();
    let (forward, remote) = crate::remote::rpc_forward("host-1", "/home/me/repo").unwrap();
    assert_eq!(socket, forward);
    assert_eq!(remote, "/home/me/repo/.alinery/rpc.sock", "the host's daemon has no lane");
    assert_ne!(
        forward,
        crate::remote::repo_forward("host-1", "/home/me/repo").unwrap().0,
        "the RPC socket rides its own forward, not the JSON-lines one"
    );
    assert_eq!(secret, crate::daemon::rpc_secret_path(&cfg.join("remote").join("host-1"), "/home/me/repo", ""));
    assert_ne!(secret, crate::daemon::rpc_secret_path(&cfg.join("remote").join("host-2"), "/home/me/repo", ""));
}

#[tokio::test]
async fn unary_sends_one_enveloped_message_and_returns_the_reply_message() {
    let (bridge, server) = (Bridge::default(), serve().await);
    // The stand-in echoes the request body, envelope included: the reply is "abc" only if the shell
    // wrapped it as one uncompressed message and unwrapped the same on the way back.
    let reply = bridge.unary(&server.socket, "tok", "/echo", b"abc").await.unwrap();
    assert_eq!(reply, b"abc");
}

#[tokio::test]
async fn unary_reads_a_non_zero_grpc_status_from_a_trailers_only_answer() {
    let (bridge, server) = (Bridge::default(), serve().await);
    let error = bridge.unary(&server.socket, "tok", "/trailers-only", b"").await.unwrap_err();
    assert!(error.contains("grpc-status 16"), "{error}");
}

#[tokio::test]
async fn hello_decodes_the_fields_the_shell_reads() {
    let server = serve().await;
    assert_eq!(
        hello(&server.socket, "tok").await.unwrap(),
        HelloResponse {
            protocol: 25,
            build_id: "b-1".into(),
            epoch: "e-7".into(),
            capabilities: vec![Capability::View as i32, Capability::Act as i32],
            repo_root: "/r".into(),
            app_config_identity: String::new(),
        }
    );
    let gone = hello(&server.socket.with_file_name("none.sock"), "tok").await.unwrap_err();
    assert!(gone.contains("connect"), "{gone}");
}

/// The bytes protobuf-es wrote from proto/alinery/v1/admin.proto (`bun proto/golden.ts`). Each field is
/// checked by name, so a field number changed in a struct above fails here naming that field; the
/// re-encode catches a changed type or a lost field that decoding alone would pass.
fn golden(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../proto/golden/admin.json");
    let fixtures: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap();
    let hex = fixtures[name].as_str().unwrap_or_else(|| panic!("{name} is missing from {}", path.display()));
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
}

#[test]
fn golden_shutdown_request_decodes_field_by_field_and_encodes_back_to_the_same_bytes() {
    let bytes = golden("ShutdownRequest");
    let request = ShutdownRequest::decode(bytes.as_slice()).unwrap();
    assert_eq!(request.origin, ShutdownOrigin::ConfirmedTakeover as i32, "ShutdownRequest.origin");
    assert_eq!(request.confirmation_id, "confirm-1", "ShutdownRequest.confirmation_id");
    assert_eq!(request.encode_to_vec(), bytes);
}

#[test]
fn golden_shutdown_response_decodes_field_by_field_and_encodes_back_to_the_same_bytes() {
    let bytes = golden("ShutdownResponse");
    let response = ShutdownResponse::decode(bytes.as_slice()).unwrap();
    assert_eq!(response.sessions_stopped, 300, "ShutdownResponse.sessions_stopped");
    assert_eq!(response.encode_to_vec(), bytes);
}

#[test]
fn golden_hello_request_decodes_field_by_field_and_encodes_back_to_the_same_bytes() {
    let bytes = golden("HelloRequest");
    let request = HelloRequest::decode(bytes.as_slice()).unwrap();
    assert_eq!(request.client_id, "client-1", "HelloRequest.client_id");
    assert_eq!(request.client_kind, "desktop", "HelloRequest.client_kind");
    assert_eq!(request.protocol, 25, "HelloRequest.protocol");
    assert_eq!(request.encode_to_vec(), bytes);
}

#[test]
fn golden_hello_response_decodes_field_by_field_and_encodes_back_to_the_same_bytes() {
    let bytes = golden("HelloResponse");
    let response = HelloResponse::decode(bytes.as_slice()).unwrap();
    assert_eq!(response.protocol, 25, "HelloResponse.protocol");
    assert_eq!(response.build_id, "build-abc", "HelloResponse.build_id");
    assert_eq!(response.epoch, "epoch-1", "HelloResponse.epoch");
    assert_eq!(
        response.capabilities,
        vec![Capability::View as i32, Capability::Act as i32, Capability::Admin as i32],
        "HelloResponse.capabilities"
    );
    assert_eq!(response.repo_root, "/repo", "HelloResponse.repo_root");
    assert_eq!(response.app_config_identity, "identity-1", "HelloResponse.app_config_identity");
    assert_eq!(response.encode_to_vec(), bytes);
}

/// A repo whose `.alinery/rpc[-lane].sock` is served by a stand-in, with the token this app would have
/// kept for it. Plain `#[test]`, because `shutdown_daemon` blocks on the app's own runtime.
struct Teardown {
    repo: PathBuf,
    app_config: PathBuf,
    server: Server,
}

fn teardown_fixture(lane: Option<&str>, token: &str) -> Teardown {
    let root = PathBuf::from(format!("/tmp/alinery-sd-{}", &uuid::Uuid::new_v4().simple().to_string()[..10]));
    let repo = root.join("repo");
    fs::create_dir_all(repo.join(".alinery")).unwrap();
    let app_config = root.join("cfg").join("app.toml");
    let key = repo.display().to_string();
    crate::daemon::store_rpc_secret(alinery_core::app_config_dir_of(&app_config).unwrap(), &key, lane.unwrap_or(""), token).unwrap();
    let socket = alinery_core::rpc_socket_path(&repo, lane);
    let server = tauri::async_runtime::block_on(serve_at(socket, root));
    Teardown { repo, app_config, server }
}

#[test]
fn shutdown_goes_over_rpc_with_its_origin_and_confirmation_and_skips_the_old_op() {
    let origins = [
        ShutdownOrigin::StopDaemon,
        ShutdownOrigin::CloseRepo,
        ShutdownOrigin::RestoreBackup,
        ShutdownOrigin::ConfirmedTakeover,
        ShutdownOrigin::StopRemote,
    ];
    for origin in origins {
        let token = format!("origin-{}", origin as i32);
        let t = teardown_fixture(Some("d1234"), &token);
        let key = t.repo.display().to_string();
        shutdown_daemon(&key, &t.app_config, Some("d1234"), origin, "confirm-xyz", None, || {
            panic!("the old op must not run when rpc.sock answers")
        })
        .unwrap();
        assert_eq!(
            shutdowns_with(&token),
            vec![ShutdownRequest {
                origin: origin as i32,
                confirmation_id: "confirm-xyz".into()
            }]
        );
    }
}

#[test]
fn shutdown_falls_back_to_the_old_op_only_when_there_is_nothing_to_call() {
    let ran = std::cell::Cell::new(0);
    let legacy = || {
        ran.set(ran.get() + 1);
        Ok(())
    };
    // No token kept: a daemon of an older protocol, or one another app started.
    let t = teardown_fixture(None, "unused");
    let other = t.repo.with_file_name("repo-without-token");
    shutdown_daemon(&other.display().to_string(), &t.app_config, None, ShutdownOrigin::StopDaemon, "", None, legacy).unwrap();
    assert_eq!(ran.get(), 1);
    // A token but no socket answering: a daemon of an older protocol, or a stale file.
    let t = teardown_fixture(Some("a"), "unused");
    shutdown_daemon(
        &t.repo.display().to_string(),
        &t.app_config,
        Some("other-lane"),
        ShutdownOrigin::StopDaemon,
        "",
        None,
        legacy,
    )
    .unwrap();
    assert_eq!(ran.get(), 2);
    // A failing old op is still the caller's error.
    let t = teardown_fixture(None, "unused");
    let error = shutdown_daemon(
        &t.repo.display().to_string(),
        &t.app_config,
        Some("no-token-for-this-lane"),
        ShutdownOrigin::StopDaemon,
        "",
        None,
        || Err("old op failed".into()),
    )
    .unwrap_err();
    assert_eq!(error, "old op failed");
}

#[test]
fn a_pending_token_replaces_the_kept_one_only_once_its_daemon_answers_with_it() {
    let secret_of = |t: &Teardown| crate::daemon::rpc_secret_path(alinery_core::app_config_dir_of(&t.app_config).unwrap(), &t.repo.display().to_string(), "");
    let stop = |t: &Teardown| {
        shutdown_daemon(&t.repo.display().to_string(), &t.app_config, None, ShutdownOrigin::StopDaemon, "", None, || {
            panic!("must not fall back")
        })
    };
    let pend = |t: &Teardown, token: &str| {
        let dir = alinery_core::app_config_dir_of(&t.app_config).unwrap();
        crate::daemon::store_pending_rpc_secret(dir, &t.repo.display().to_string(), "", token).unwrap();
    };

    // A spawn that lost the ownership lock leaves a token no daemon holds; the live daemon's still works.
    let t = teardown_fixture(None, "live-kept");
    pend(&t, "stale");
    stop(&t).unwrap();
    assert_eq!(shutdowns_with("live-kept").len(), 1);
    assert!(shutdowns_with("stale").is_empty());
    assert_eq!(fs::read_to_string(secret_of(&t)).unwrap(), "live-kept");

    // A spawn that took over: its token answers, so it becomes the kept one.
    let t = teardown_fixture(None, "replaced");
    pend(&t, "fresh-token");
    stop(&t).unwrap();
    assert_eq!(shutdowns_with("fresh-token").len(), 1);
    assert!(shutdowns_with("replaced").is_empty());
    assert_eq!(fs::read_to_string(secret_of(&t)).unwrap(), "fresh-token");
    assert!(!crate::daemon::pending_rpc_secret_path(&secret_of(&t)).exists());
}

#[test]
fn a_daemon_that_refuses_is_an_error_and_never_retried_on_the_old_wire() {
    let t = teardown_fixture(None, "wrong");
    let error = shutdown_daemon(&t.repo.display().to_string(), &t.app_config, None, ShutdownOrigin::StopDaemon, "", None, || {
        panic!("must not fall back")
    })
    .unwrap_err();
    assert!(error.contains("refused") && error.contains("grpc-status 16"), "{error}");
}

/// A second copy of this test binary, listening on `ALINERY_TEST_LISTEN`, so there is a peer that is not this process.
#[test]
fn listener_child_for_the_takeover_identity_test() {
    let Some(path) = std::env::var_os("ALINERY_TEST_LISTEN") else { return };
    let _listener = std::os::unix::net::UnixListener::bind(path).unwrap();
    std::thread::sleep(Duration::from_secs(60));
}

#[test]
fn a_takeover_is_bound_to_the_process_it_was_confirmed_for() {
    let t = teardown_fixture(None, "bound");
    let key = t.repo.display().to_string();
    // This process serves the stand-in, so its identity is the one a takeover of it would hold.
    let here = alinery_core::daemon_client::peer_process_identity(&std::os::unix::net::UnixStream::connect(&t.server.socket).unwrap()).unwrap();
    shutdown_daemon(&key, &t.app_config, None, ShutdownOrigin::ConfirmedTakeover, "c-1", Some(&here), || panic!("rpc answers")).unwrap();
    assert_eq!(shutdowns_with("bound").len(), 1);
    // An identity taken from another process is stale: refused before any request is sent.
    let child_socket = t.repo.with_file_name("child.sock");
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "tests::daemon_rpc::listener_child_for_the_takeover_identity_test", "--nocapture"])
        .env("ALINERY_TEST_LISTEN", &child_socket)
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut stream = None;
    for _ in 0..100 {
        match std::os::unix::net::UnixStream::connect(&child_socket) {
            Ok(connected) => {
                stream = Some(connected);
                break;
            }
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    let foreign = alinery_core::daemon_client::peer_process_identity(&stream.expect("the child listens")).unwrap();
    let error = shutdown_daemon(&key, &t.app_config, None, ShutdownOrigin::ConfirmedTakeover, "c-2", Some(&foreign), || {
        panic!("must not fall back")
    })
    .unwrap_err();
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(error.starts_with("stale daemon"), "{error}");
    assert_eq!(shutdowns_with("bound").len(), 1, "the second call sent nothing");
}
