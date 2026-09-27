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

const MAX_TEST_REQUEST: usize = 64 * 1024;

/// Read one HTTP/1 request. A single `read` is not a request: Linux often delivers
/// the headers and a `Content-Length` body as separate packets, and a test that
/// asserts or replies on the first packet fails or resets the client.
pub fn read_http_request(stream: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        if let Some(len) = request_ready_len(&buf) {
            if buf.len() >= len {
                buf.truncate(len);
                return Ok(buf);
            }
        }
        if buf.len() >= MAX_TEST_REQUEST {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "http request exceeded 64KiB"));
        }
        let n = match stream.read(&mut chunk) {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            other => other?,
        };
        if n == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "incomplete http request"));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// Length of one complete request, or `None` while `buf` is still short.
/// No `Content-Length` and no chunked body means the request ends at the headers.
fn request_ready_len(buf: &[u8]) -> Option<usize> {
    if let Some(len) = crate::telemetry::complete_http_request_len(buf) {
        return Some(len);
    }
    let header_end = buf.windows(4).position(|window| window == b"\r\n\r\n")?;
    let headers = std::str::from_utf8(&buf[..header_end]).ok()?;
    if headers
        .lines()
        .any(|line| line.split_once(':').is_some_and(|(name, _)| name.eq_ignore_ascii_case("content-length")))
    {
        return None;
    }
    if headers.lines().any(|line| {
        line.split_once(':')
            .is_some_and(|(name, value)| name.eq_ignore_ascii_case("transfer-encoding") && value.to_ascii_lowercase().contains("chunked"))
    }) {
        return chunked_ready_len(buf, header_end + 4);
    }
    Some(header_end + 4)
}

fn chunked_ready_len(buf: &[u8], mut index: usize) -> Option<usize> {
    loop {
        let line_end = buf.get(index..)?.windows(2).position(|window| window == b"\r\n")? + index;
        let line = std::str::from_utf8(buf.get(index..line_end)?).ok()?;
        let size = usize::from_str_radix(line.split(';').next()?.trim(), 16).ok()?;
        let data_at = line_end + 2;
        if size == 0 {
            if buf.get(data_at..data_at + 2) == Some(b"\r\n") {
                return Some(data_at + 2);
            }
            let end = buf.get(data_at..)?.windows(4).position(|window| window == b"\r\n\r\n")?;
            return Some(data_at + end + 4);
        }
        let next = data_at.checked_add(size)?.checked_add(2)?;
        if buf.len() < next {
            return None;
        }
        index = next;
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
            let req = read_http_request(&mut stream).unwrap_or_else(|error| panic!("http request: {error}"));
            let req = String::from_utf8_lossy(&req).into_owned();
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
                stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let req = read_http_request(&mut stream).unwrap();
                let req = String::from_utf8_lossy(&req);
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
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = read_http_request(&mut stream);
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nx").unwrap();
            let _ = release_rx.recv_timeout(Duration::from_secs(2));
        });
        let dest = std::env::temp_dir().join(format!("alinery-http-stall-{}", std::process::id()));
        let _ = std::fs::remove_file(&dest);
        let started = Instant::now();
        let error = download(
            &format!("http://{address}/stall"),
            &dest,
            Duration::from_millis(200),
            Duration::from_millis(400),
            Some(1000),
        )
        .unwrap_err();
        let elapsed = started.elapsed();
        let _ = release_tx.send(());
        server.join().unwrap();
        assert!(error.to_ascii_lowercase().contains("timed out"), "{error}");
        assert!(elapsed < Duration::from_secs(2), "download ignored its timeout: {elapsed:?}");
        assert!(!dest.exists(), "a timed-out download must not leave a file");
    }

    /// One byte per `read`, so a reader that stops at the first packet cannot see the body.
    struct OneByte<'a> {
        data: &'a [u8],
        pos: usize,
    }

    impl Read for OneByte<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.pos >= self.data.len() || buf.is_empty() {
                return Ok(0);
            }
            buf[0] = self.data[self.pos];
            self.pos += 1;
            Ok(1)
        }
    }

    #[test]
    fn read_http_request_keeps_reading_until_the_body_arrives() {
        let raw = b"POST /token HTTP/1.1\r\nContent-Length: 19\r\nAuthorization: Bearer secret-token\r\n\r\ncode=secret%2Bvalue";
        let req = read_http_request(&mut OneByte { data: raw, pos: 0 }).unwrap();
        let req = String::from_utf8(req).unwrap();
        assert!(req.contains("Authorization: Bearer secret-token"), "{req}");
        assert!(req.ends_with("code=secret%2Bvalue"), "{req}");
    }

    #[test]
    fn read_http_request_completes_a_get_without_reading_past_the_headers() {
        let raw = b"GET /start HTTP/1.1\r\nHost: x\r\n\r\nNOT-A-REQUEST";
        let mut reader = OneByte { data: raw, pos: 0 };
        let req = read_http_request(&mut reader).unwrap();
        let headers_len = raw.len() - b"NOT-A-REQUEST".len();
        assert_eq!(req, &raw[..headers_len]);
        assert_eq!(reader.pos, headers_len);
    }

    #[test]
    fn read_http_request_waits_for_a_chunked_body() {
        let raw = b"POST /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n";
        let req = read_http_request(&mut OneByte { data: raw, pos: 0 }).unwrap();
        assert_eq!(req, raw);
    }
}
