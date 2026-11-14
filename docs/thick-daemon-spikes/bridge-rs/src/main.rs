//! S0.3 sample: what the shell's `daemon_rpc` command does with one Connect call. One HTTP/1.1
//! connection per call over the daemon's unix socket (a pooled connection breaks after a cancelled
//! stream, see ../src/bridge-fetch.ts). Each response chunk becomes a frame for the webview's
//! Channel. Aborting the call task drops the connection, which is how a cancel reaches the daemon.
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::client::conn::http1;
use hyper_util::rt::TokioIo;
use tokio::net::UnixStream;

const HEAD: u8 = 1;
const BODY: u8 = 2;
const END: u8 = 3;
/// Tauri 2.11 sends raw Channel payloads under 1 KiB through `webview.eval` (channel.rs:39).
const PAD_TO: usize = 1024;

/// One Channel message: `[u32 LE len][u8 kind][payload]`, zero padded to `PAD_TO`. Must match
/// `encodeFrames` in ../src/bridge-fetch.ts byte for byte.
fn encode_frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(PAD_TO.max(payload.len() + 9));
    out.extend_from_slice(&(payload.len() as u32 + 1).to_le_bytes());
    out.push(kind);
    out.extend_from_slice(payload);
    out.resize(PAD_TO.max(out.len() + 4), 0);
    out
}

type Error = Box<dyn std::error::Error + Send + Sync>;

async fn call(
    sock: &str,
    path: &str,
    content_type: &str,
    token: &str,
    body: Vec<u8>,
    mut send: impl FnMut(Vec<u8>),
) -> Result<(), Error> {
    let io = TokioIo::new(UnixStream::connect(sock).await?);
    let (mut sender, conn) = http1::handshake(io).await?;
    let conn = tokio::spawn(conn);
    // Origin-form URI: hyper's conn API sends the URI verbatim, and an absolute-form
    // `http://daemon/...` request line makes the Connect router answer 404.
    let req = http::Request::post(path)
        .header("host", "daemon")
        .header("content-type", content_type)
        .header("connect-protocol-version", "1")
        .header("authorization", format!("Bearer {token}"))
        .body(Full::new(Bytes::from(body)))?;
    let mut res = sender.send_request(req).await?;
    let headers: Vec<(&str, &str)> =
        res.headers().iter().map(|(k, v)| (k.as_str(), v.to_str().unwrap_or(""))).collect();
    let head = serde_json::json!({ "status": res.status().as_u16(), "headers": headers });
    send(encode_frame(HEAD, head.to_string().as_bytes()));
    while let Some(frame) = res.frame().await {
        if let Some(data) = frame?.data_ref() {
            send(encode_frame(BODY, data));
        }
    }
    send(encode_frame(END, b""));
    conn.abort();
    Ok(())
}

/// Connect streaming envelope around a hand-encoded `TicksRequest { size = 1, interval_ms = 2 }`.
fn ticks_request(size: u32, interval_ms: u32) -> Vec<u8> {
    fn varint(mut v: u32, out: &mut Vec<u8>) {
        while v >= 0x80 {
            out.push(v as u8 | 0x80);
            v >>= 7;
        }
        out.push(v as u8);
    }
    let mut msg = vec![0x08];
    varint(size, &mut msg);
    msg.push(0x10);
    varint(interval_ms, &mut msg);
    let mut env = vec![0u8];
    env.extend_from_slice(&(msg.len() as u32).to_be_bytes());
    env.extend(msg);
    env
}

async fn hello_stats(sock: &str, token: &str) -> serde_json::Value {
    let mut body = Vec::new();
    call(sock, "/alinery.v1.AdminService/Hello", "application/json", token, b"{}".to_vec(), |m| {
        if m[4] == BODY {
            let len = u32::from_le_bytes(m[..4].try_into().unwrap()) as usize - 1;
            body.extend_from_slice(&m[5..5 + len]);
        }
    })
    .await
    .unwrap();
    let reply: serde_json::Value = serde_json::from_slice(&body).unwrap();
    serde_json::from_str(reply["buildId"].as_str().unwrap()).unwrap()
}

#[tokio::main]
async fn main() {
    let sock = std::env::args().nth(1).expect("usage: bridge-rs <rpc.sock>");
    let token = "spike-secret-0123456789abcdef";

    // Unary, JSON encoding, so the reply is readable.
    let stats = hello_stats(&sock, token).await;
    println!("hello ok: peer={}", stats["peer"]);

    // 1,000 unary calls, one connection each.
    let mut t: Vec<f64> = Vec::new();
    for _ in 0..1000 {
        let t0 = Instant::now();
        call(&sock, "/alinery.v1.AdminService/Hello", "application/json", token, b"{}".to_vec(), |_| {})
            .await
            .unwrap();
        t.push(t0.elapsed().as_secs_f64() * 1e3);
    }
    t.sort_by(f64::total_cmp);
    println!("unary, connection per call: p50 {:.3} ms p99 {:.3} ms", t[500], t[990]);

    // Server stream: 16 KiB ticks for 2 s, cancelled by aborting the task.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<usize>();
    let s = sock.clone();
    let task = tokio::spawn(async move {
        let _ = call(&s, "/alinery.v1.SpikeService/Ticks", "application/connect+proto", token, ticks_request(16384, 0), |m| {
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
    let before = hello_stats(&sock, token).await["abortEvents"].as_u64().unwrap();
    task.abort();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let after = hello_stats(&sock, token).await["abortEvents"].as_u64().unwrap();
    println!(
        "stream: {msgs} channel messages, {:.0} MB/s framed; cancel reached server: {}",
        bytes as f64 / 2.0 / 1e6,
        after == before + 1
    );
}

#[test]
fn frame_matches_typescript() {
    let m = encode_frame(BODY, &[1, 2, 3]);
    assert_eq!(m.len(), PAD_TO);
    assert_eq!(&m[..12], &[4, 0, 0, 0, 2, 1, 2, 3, 0, 0, 0, 0]);
}
