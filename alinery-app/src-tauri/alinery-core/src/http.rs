// Blocking HTTPS for the app. ureq stays in this crate so the desktop binary does not
// shell out to curl. Callers that already have a 4xx/5xx body get it back; only a
// transport failure (DNS, timeout, TLS) is an Err.

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

const DEFAULT_MAX_BODY: u64 = 16 * 1024 * 1024;

pub fn request(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&[u8]>, connect_timeout: Duration, total_timeout: Duration) -> Result<HttpResponse, String> {
    let agent = agent(url, connect_timeout, total_timeout);
    let mut req = agent.request(method, url);
    for (name, value) in headers {
        req = req.set(name, value);
    }
    let result = match body {
        Some(bytes) => req.send_bytes(bytes),
        None => req.call(),
    };
    match result {
        Ok(resp) => read_limited(resp, DEFAULT_MAX_BODY),
        Err(ureq::Error::Status(_, resp)) => read_limited(resp, DEFAULT_MAX_BODY),
        Err(error) => Err(transport_error(&error)),
    }
}

/// Stream `url` to `dest`. A non-2xx response or a body over `max_bytes` (when set)
/// deletes the partial file and returns Err.
pub fn download(url: &str, dest: &Path, connect_timeout: Duration, total_timeout: Duration, max_bytes: Option<u64>) -> Result<(), String> {
    let agent = agent(url, connect_timeout, total_timeout);
    let result = agent.get(url).call();
    let resp = match result {
        Ok(resp) => resp,
        Err(ureq::Error::Status(status, resp)) => {
            let _ = resp;
            return Err(format!("download failed: HTTP {status}"));
        }
        Err(error) => return Err(transport_error(&error)),
    };
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = File::create(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    let limit = max_bytes.unwrap_or(u64::MAX);
    let mut reader = resp.into_reader().take(limit.saturating_add(1));
    let copied = std::io::copy(&mut reader, &mut file).map_err(|e| {
        let _ = std::fs::remove_file(dest);
        format!("download {}: {e}", dest.display())
    })?;
    if let Err(error) = file.flush() {
        let _ = std::fs::remove_file(dest);
        return Err(error.to_string());
    }
    if copied > limit {
        let _ = std::fs::remove_file(dest);
        return Err(format!("download exceeded {limit} bytes"));
    }
    Ok(())
}

fn agent(url: &str, connect_timeout: Duration, total_timeout: Duration) -> ureq::Agent {
    // timeout() is a deadline for the call, but ureq then resets the socket read
    // timeout to timeout_read for the body. Without timeout_read a server that
    // sends headers and then stalls hangs the download forever.
    ureq::AgentBuilder::new()
        .timeout_connect(connect_timeout)
        .timeout_read(total_timeout)
        .timeout_write(total_timeout)
        .timeout(total_timeout)
        .https_only(url.len() >= 8 && url[..8].eq_ignore_ascii_case("https://"))
        .build()
}

fn read_limited(resp: ureq::Response, max: u64) -> Result<HttpResponse, String> {
    let status = resp.status();
    let mut body = Vec::new();
    resp.into_reader().take(max.saturating_add(1)).read_to_end(&mut body).map_err(|e| e.to_string())?;
    if body.len() as u64 > max {
        return Err(format!("response exceeded {max} bytes"));
    }
    Ok(HttpResponse { status, body })
}

fn transport_error(error: &ureq::Error) -> String {
    let text = error.to_string();
    let lower = text.to_ascii_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") {
        "timed out".into()
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Instant;

    fn serve(handler: impl Fn(&str) -> String + Send + 'static) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else { return };
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut buf = [0u8; 4096];
            let Ok(n) = stream.read(&mut buf) else { return };
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            let _ = stream.write_all(handler(&req).as_bytes());
        });
        (format!("http://{address}"), server)
    }

    #[test]
    fn request_posts_the_header_and_body_and_keeps_an_error_status() {
        let (base, server) = serve(|req| {
            assert!(req.contains("Authorization: Bearer secret-token"), "{req}");
            assert!(req.contains("code=secret%2Bvalue"), "{req}");
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnope".into()
        });
        let response = request(
            "POST",
            &format!("{base}/token"),
            &[("Authorization", "Bearer secret-token")],
            Some(b"code=secret%2Bvalue"),
            Duration::from_secs(1),
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(response.status, 401);
        assert_eq!(response.body, b"nope");
        server.join().unwrap();
    }

    #[test]
    fn download_follows_a_redirect_and_writes_the_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0u8; 2048];
                let n = stream.read(&mut buf).unwrap();
                let req = String::from_utf8_lossy(&buf[..n]);
                let resp = if req.contains("GET /start ") {
                    format!("HTTP/1.1 302 Found\r\nLocation: http://{address}/file\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nzip!".into()
                };
                stream.write_all(resp.as_bytes()).unwrap();
            }
        });
        let dest = std::env::temp_dir().join(format!("alinery-http-ok-{}", std::process::id()));
        let _ = std::fs::remove_file(&dest);
        download(&format!("http://{address}/start"), &dest, Duration::from_secs(1), Duration::from_secs(2), Some(100)).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"zip!");
        std::fs::remove_file(&dest).unwrap();
        server.join().unwrap();
    }

    #[test]
    fn download_refuses_an_http_error_and_does_not_create_the_file() {
        let (base, server) = serve(|_| "HTTP/1.1 404 Not Found\r\nContent-Length: 3\r\nConnection: close\r\n\r\nnope".into());
        let dest = std::env::temp_dir().join(format!("alinery-http-404-{}", std::process::id()));
        let _ = std::fs::remove_file(&dest);
        let error = download(&format!("{base}/missing"), &dest, Duration::from_secs(1), Duration::from_secs(2), Some(100)).unwrap_err();
        assert!(error.contains("HTTP 404"), "{error}");
        assert!(!dest.exists(), "a failed download must not leave a file");
        server.join().unwrap();
    }

    #[test]
    fn download_rejects_a_body_over_the_cap_and_removes_the_partial_file() {
        let (base, server) = serve(|_| "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\n12345678".into());
        let dest = std::env::temp_dir().join(format!("alinery-http-cap-{}", std::process::id()));
        let _ = std::fs::remove_file(&dest);
        let error = download(&format!("{base}/big"), &dest, Duration::from_secs(1), Duration::from_secs(2), Some(4)).unwrap_err();
        assert!(error.contains("exceeded 4 bytes"), "{error}");
        assert!(!dest.exists(), "an over-cap download must not leave a file");
        server.join().unwrap();
    }

    #[test]
    fn download_times_out_when_the_body_stalls_after_the_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nx").unwrap();
            let _ = release_rx.recv_timeout(Duration::from_secs(2));
        });
        let dest = std::env::temp_dir().join(format!("alinery-http-stall-{}", std::process::id()));
        let _ = std::fs::remove_file(&dest);
        let started = Instant::now();
        let error = download(&format!("http://{address}/stall"), &dest, Duration::from_millis(200), Duration::from_millis(400), Some(1000)).unwrap_err();
        let elapsed = started.elapsed();
        let _ = release_tx.send(());
        server.join().unwrap();
        assert!(error.to_ascii_lowercase().contains("timed out"), "{error}");
        assert!(elapsed < Duration::from_secs(2), "download ignored its timeout: {elapsed:?}");
        assert!(!dest.exists(), "a timed-out download must not leave a file");
    }
}
