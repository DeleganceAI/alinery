//! O1 (b) sample: the shell's `daemon_rpc` over HTTP/2 to the grpc-js daemon. One connection per
//! daemon, one stream per call. The shell knows no gRPC: it forwards headers and body, sends the
//! response trailers as a TRAILERS frame (the webview turns them into gRPC-web, ../grpc-bridge.ts),
//! and a cancel drops the call's response, which resets only that stream.
//! Usage: cargo run --release --bin h2 -- <grpc.sock>
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::client::conn::http2;
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::net::UnixStream;

const HEAD: u8 = 1;
const BODY: u8 = 2;
const END: u8 = 3;
const TRAILERS: u8 = 4;
const PAD_TO: usize = 1024;
const TOKEN: &str = "spike-secret-0123456789abcdef";

/// Same bytes as `encodeFrames` in ../src/bridge-fetch.ts (and `encode_frame` in main.rs).
fn encode_frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(PAD_TO.max(payload.len() + 9));
    out.extend_from_slice(&(payload.len() as u32 + 1).to_le_bytes());
    out.push(kind);
    out.extend_from_slice(payload);
    out.resize(PAD_TO.max(out.len() + 4), 0);
    out
}

type Error = Box<dyn std::error::Error + Send + Sync>;
type Sender = http2::SendRequest<Full<Bytes>>;

async fn connect(sock: &str) -> Result<Sender, Error> {
    let io = TokioIo::new(UnixStream::connect(sock).await?);
    let (sender, conn) = http2::handshake(TokioExecutor::new(), io).await?;
    tokio::spawn(conn);
    Ok(sender)
}

fn pairs(h: &http::HeaderMap) -> Vec<(&str, &str)> {
    h.iter().map(|(k, v)| (k.as_str(), v.to_str().unwrap_or(""))).collect()
}

async fn call(sender: &mut Sender, path: &str, token: &str, body: Vec<u8>, mut send: impl FnMut(Vec<u8>)) -> Result<(), Error> {
    // HTTP/2 takes :scheme and :authority from an absolute URI (unlike the HTTP/1.1 request line).
    let req = http::Request::post(format!("http://daemon{path}"))
        .header("content-type", "application/grpc+proto")
        .header("te", "trailers")
        .header("authorization", format!("Bearer {token}"))
        .body(Full::new(Bytes::from(body)))?;
    let mut res = sender.send_request(req).await?;
    let head = serde_json::json!({ "status": res.status().as_u16(), "headers": pairs(res.headers()) });
    send(encode_frame(HEAD, head.to_string().as_bytes()));
    while let Some(frame) = res.frame().await {
        let frame = frame?;
        if let Some(data) = frame.data_ref() {
            send(encode_frame(BODY, data));
        } else if let Some(t) = frame.trailers_ref() {
            send(encode_frame(TRAILERS, serde_json::to_string(&pairs(t))?.as_bytes()));
        }
    }
    send(encode_frame(END, b""));
    Ok(())
}

fn envelope(msg: Vec<u8>) -> Vec<u8> {
    let mut env = vec![0u8];
    env.extend_from_slice(&(msg.len() as u32).to_be_bytes());
    env.extend(msg);
    env
}

fn varint(mut v: u64, out: &mut Vec<u8>) {
    while v >= 0x80 {
        out.push(v as u8 | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

/// Frames a call produced, decoded back: (head JSON, body bytes, trailers JSON).
#[derive(Default)]
struct Got {
    head: Option<serde_json::Value>,
    body: Vec<u8>,
    trailers: Option<serde_json::Value>,
}

fn collect(got: &mut Got) -> impl FnMut(Vec<u8>) + '_ {
    |m| {
        let len = u32::from_le_bytes(m[..4].try_into().unwrap()) as usize - 1;
        let p = &m[5..5 + len];
        match m[4] {
            HEAD => got.head = serde_json::from_slice(p).ok(),
            BODY => got.body.extend_from_slice(p),
            TRAILERS => got.trailers = serde_json::from_slice(p).ok(),
            _ => {}
        }
    }
}

/// `HelloResponse.build_id` (field 2) from the gRPC body: the server's stats JSON.
fn hello_build_id(body: &[u8]) -> serde_json::Value {
    let msg = &body[5..];
    let mut i = 0;
    while i < msg.len() {
        let (tag, mut j) = (msg[i], i + 1);
        let (mut len, mut shift) = (0usize, 0);
        if tag & 7 == 0 {
            while msg[j] & 0x80 != 0 { j += 1; }
            i = j + 1;
            continue;
        }
        loop {
            len |= ((msg[j] & 0x7f) as usize) << shift;
            shift += 7;
            j += 1;
            if msg[j - 1] & 0x80 == 0 { break; }
        }
        if tag == 0x12 {
            return serde_json::from_slice(&msg[j..j + len]).unwrap();
        }
        i = j + len;
    }
    panic!("no build_id");
}

async fn stats(sender: &mut Sender) -> serde_json::Value {
    let mut got = Got::default();
    call(sender, "/alinery.v1.AdminService/Hello", TOKEN, envelope(vec![]), collect(&mut got)).await.unwrap();
    hello_build_id(&got.body)
}

#[tokio::main]
async fn main() {
    let sock = std::env::args().nth(1).expect("usage: h2 <grpc.sock>");
    let mut sender = connect(&sock).await.unwrap();

    let s = stats(&mut sender).await;
    println!("hello ok: peer={} mode={}", s["peer"], s["mode"]);

    // A bad token: grpc-js answers trailers-only, so grpc-status is in the head and no TRAILERS frame follows.
    let mut got = Got::default();
    call(&mut sender, "/alinery.v1.AdminService/Hello", "nope", envelope(vec![]), collect(&mut got)).await.unwrap();
    let in_head = got.head.as_ref().unwrap()["headers"].as_array().unwrap().iter().any(|p| p[0] == "grpc-status" && p[1] == "16");
    println!("bad token: grpc-status 16 in head: {in_head}, trailers frame: {}", got.trailers.is_some());

    // 1,000 unary 100-byte echos on the one connection.
    let mut echo = vec![0x0a];
    varint(100, &mut echo);
    echo.extend(vec![7u8; 100]);
    let req = envelope(echo);
    let mut t: Vec<f64> = Vec::new();
    for _ in 0..1100 {
        let t0 = Instant::now();
        let mut got = Got::default();
        call(&mut sender, "/alinery.v1.SpikeService/Echo", TOKEN, req.clone(), collect(&mut got)).await.unwrap();
        assert!(got.trailers.unwrap().to_string().contains("\"grpc-status\",\"0\""));
        t.push(t0.elapsed().as_secs_f64() * 1e3);
    }
    let mut t = t.split_off(100);
    t.sort_by(f64::total_cmp);
    println!("unary, one shared connection: p50 {:.3} ms p99 {:.3} ms", t[500], t[990]);

    // 16 calls in flight on the same connection (SendRequest clones share it).
    let t0 = Instant::now();
    let tasks: Vec<_> = (0..16)
        .map(|_| {
            let (mut s, r) = (sender.clone(), req.clone());
            tokio::spawn(async move {
                for _ in 0..250 {
                    call(&mut s, "/alinery.v1.SpikeService/Echo", TOKEN, r.clone(), |_| {}).await.unwrap();
                }
            })
        })
        .collect();
    for task in tasks {
        task.await.unwrap();
    }
    println!("unary, 16 in flight: {:.0} calls/s", 4000.0 / t0.elapsed().as_secs_f64());

    // Server stream of 16 KiB ticks for 2 s, then cancel by aborting the task.
    let mut ticks = vec![0x08];
    varint(16384, &mut ticks);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<usize>();
    let mut s2 = sender.clone();
    let task = tokio::spawn(async move {
        let _ = call(&mut s2, "/alinery.v1.SpikeService/Ticks", TOKEN, envelope(ticks), |m| {
            let _ = tx.send(m.len());
        })
        .await;
    });
    let start = Instant::now();
    let (mut msgs, mut bytes) = (0usize, 0usize);
    while start.elapsed() < Duration::from_secs(2) {
        if let Ok(Some(n)) = tokio::time::timeout(Duration::from_millis(100), rx.recv()).await {
            msgs += 1;
            bytes += n;
        }
    }
    let before = stats(&mut sender).await["abortEvents"].as_u64().unwrap();
    task.abort();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let after = stats(&mut sender).await["abortEvents"].as_u64().unwrap();
    println!(
        "stream: {msgs} frames, {:.0} MB/s framed; cancel reached server: {}; same connection still serves calls: true",
        bytes as f64 / 2.0 / 1e6,
        after == before + 1
    );
}
