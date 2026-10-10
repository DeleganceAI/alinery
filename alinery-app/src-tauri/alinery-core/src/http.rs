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

/// Fetch an imported image without sending the Linear credential to another origin.
/// Redirects are handled here so every destination is checked before connecting.
pub fn download_image(url: &str, authorization: &str) -> Result<(Vec<u8>, String), String> {
    use std::net::ToSocketAddrs;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .try_proxy_from_env(false)
        .redirects(0)
        .resolver(|host: &str| {
            let addresses: Vec<_> = host.to_socket_addrs()?.collect();
            if addresses.is_empty() || addresses.iter().any(|address| !public_image_address(address.ip())) {
                return Err(std::io::Error::other("image destination is not a public address"));
            }
            Ok(addresses)
        })
        .build();
    download_image_with(&agent, url, authorization, crate::MAX_ATTACHMENT_BYTES)
}

fn public_image_address(address: std::net::IpAddr) -> bool {
    match address {
        std::net::IpAddr::V4(ip) => {
            let [a, b, _, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_documentation()
                || a == 0
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0)
                || (a == 198 && (18..=19).contains(&b)))
        }
        std::net::IpAddr::V6(ip) => {
            let segments = ip.segments();
            // Only global unicast; exclude documentation and IPv4 tunnelling ranges.
            (segments[0] & 0xe000) == 0x2000 && segments[0] != 0x2002 && !(segments[0] == 0x2001 && (segments[1] < 0x200 || segments[1] == 0xdb8))
        }
    }
}

fn image_url(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw).map_err(|_| "invalid image URL")?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() || url.host_str().is_none() {
        return Err("image URL must be HTTP(S) without credentials".into());
    }
    Ok(url)
}

fn linear_image_origin(url: &url::Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("uploads.linear.app") && url.port_or_known_default() == Some(443)
}

fn download_image_with(agent: &ureq::Agent, raw: &str, authorization: &str, limit: u64) -> Result<(Vec<u8>, String), String> {
    let mut url = image_url(raw)?;
    for hop in 0..=5 {
        let mut request = agent.get(url.as_str());
        if linear_image_origin(&url) {
            request = request.set("Authorization", authorization);
        }
        let response = match request.call() {
            Ok(response) => response,
            Err(ureq::Error::Status(status, _)) => return Err(format!("image download failed: HTTP {status}")),
            Err(_) => return Err("image download failed (network, timeout, or blocked destination)".into()),
        };
        if matches!(response.status(), 301 | 302 | 303 | 307 | 308) {
            if hop == 5 {
                return Err("image download exceeded five redirects".into());
            }
            let location = response.header("Location").ok_or("image redirect has no destination")?;
            let next = image_url(url.join(location).map_err(|_| "invalid image redirect")?.as_str())?;
            if url.scheme() == "https" && next.scheme() != "https" {
                return Err("image redirect would downgrade HTTPS".into());
            }
            url = next;
            continue;
        }
        if !(200..300).contains(&response.status()) {
            return Err(format!("image download failed: HTTP {}", response.status()));
        }
        let media_type = response.header("Content-Type").unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        let extension = match media_type.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/avif" => "avif",
            "image/bmp" => "bmp",
            "image/tiff" => "tiff",
            "image/heic" => "heic",
            "image/heif" => "heif",
            "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
            "image/svg+xml" => "svg",
            _ => return Err("download did not return a supported image Content-Type".into()),
        };
        if response
            .header("Content-Length")
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|size| size > limit)
        {
            return Err(format!("image exceeded {limit} bytes"));
        }
        let body = read_limited(response, limit)?.body;
        if body.is_empty() {
            return Err("download returned an empty image".into());
        }
        return Ok((body, extension.into()));
    }
    unreachable!("redirect limit is checked before continuing")
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

/// Accept one connection, or time out. A blocking `accept` with no client hangs
/// `join` until the job timeout on a slow or failed connect.
pub fn accept_for_test(listener: &std::net::TcpListener, timeout: Duration) -> std::io::Result<std::net::TcpStream> {
    listener.set_nonblocking(true)?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false)?;
                return Ok(stream);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() >= deadline {
                    return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "test server accept timed out"));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error),
        }
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
            let Ok(mut stream) = accept_for_test(&listener, Duration::from_secs(2)) else { return };
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let req = read_http_request(&mut stream).unwrap_or_else(|error| panic!("http request: {error}"));
            let req = String::from_utf8_lossy(&req).into_owned();
            let _ = stream.write_all(handler(&req).as_bytes());
        });
        (format!("http://{address}"), server)
    }

    #[test]
    fn image_download_follows_redirects_without_external_authorization() {
        let (image_url, image_server) = serve(|request| {
            assert!(!request.to_ascii_lowercase().contains("authorization:"));
            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 4\r\nConnection: close\r\n\r\nPNG!".into()
        });
        let (redirect_url, redirect_server) = serve(move |request| {
            assert!(!request.to_ascii_lowercase().contains("authorization:"));
            format!("HTTP/1.1 302 Found\r\nLocation: {image_url}/image\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        });
        let agent = ureq::AgentBuilder::new().redirects(0).build();
        let (bytes, extension) = download_image_with(&agent, &redirect_url, "Bearer private-token", 4).unwrap();
        assert_eq!(bytes, b"PNG!");
        assert_eq!(extension, "png");
        redirect_server.join().unwrap();
        image_server.join().unwrap();
    }

    #[test]
    fn image_download_rejects_error_pages_and_bounded_bodies() {
        for response in [
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 6\r\n\r\nsecret",
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 6\r\n\r\nsecret",
            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 0\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 6\r\n\r\nsecret",
            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nTransfer-Encoding: chunked\r\n\r\n6\r\nsecret\r\n0\r\n\r\n",
        ] {
            let (url, server) = serve(move |_| response.into());
            let agent = ureq::AgentBuilder::new().redirects(0).build();
            let error = download_image_with(&agent, &url, "Bearer private-token", 4).unwrap_err();
            assert!(!error.contains("secret"));
            assert!(!error.contains("private-token"));
            server.join().unwrap();
        }
    }

    #[test]
    fn image_credentials_require_exact_https_linear_origin() {
        assert!(linear_image_origin(&image_url("https://uploads.linear.app/a").unwrap()));
        for url in [
            "https://uploads.linear.app.evil.example/a",
            "https://evil.example/uploads.linear.app/a",
            "http://uploads.linear.app/a",
            "https://uploads.linear.app:444/a",
        ] {
            assert!(!linear_image_origin(&image_url(url).unwrap()), "{url}");
        }
        for url in ["file:///etc/passwd", "data:image/png;base64,aA==", "https://user:pass@uploads.linear.app/a"] {
            assert!(image_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn image_download_blocks_private_destinations_before_connecting() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
        ] {
            assert!(!public_image_address(address.parse().unwrap()), "{address}");
        }
        assert!(public_image_address("8.8.8.8".parse().unwrap()));
        assert!(public_image_address("2606:4700:4700::1111".parse().unwrap()));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/image.png", listener.local_addr().unwrap());
        assert!(download_image(&url, "Bearer private-token").is_err());
        listener.set_nonblocking(true).unwrap();
        assert_eq!(listener.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
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
                let mut stream = accept_for_test(&listener, Duration::from_secs(2)).unwrap();
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
            let mut stream = accept_for_test(&listener, Duration::from_secs(2)).unwrap();
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
