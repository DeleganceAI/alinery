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
    let https_only = url.starts_with("https://");
    let agent = ureq::AgentBuilder::new().timeout_connect(connect_timeout).timeout(total_timeout).https_only(https_only).build();
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
    let https_only = url.starts_with("https://");
    let agent = ureq::AgentBuilder::new().timeout_connect(connect_timeout).timeout(total_timeout).https_only(https_only).build();
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
    file.flush().map_err(|e| e.to_string())?;
    if copied > limit {
        let _ = std::fs::remove_file(dest);
        return Err(format!("download exceeded {limit} bytes"));
    }
    Ok(())
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
