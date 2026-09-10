//! Tests for update.rs — semver compare, manifest parsing/tolerance, bundle detection,
//! and a real loopback fetch. `use crate::*` (not `use super::*`): update.rs's pure
//! functions are reached the same way any other module's are, through the crate-root glob
//! every production module already uses — tests/mod.rs's curated re-export list is not
//! touched by this file.
use crate::*;
use std::net::TcpListener;

// ---- is_newer ----------------------------------------------------------------------

#[test]
fn is_newer_compares_semver_triples() {
    assert_eq!(is_newer("0.11.0", "0.10.0"), Some(true));
    assert_eq!(is_newer("0.10.0", "0.9.12"), Some(true), "second component outranks a bigger third");
    assert_eq!(is_newer("0.10.0", "0.10.0"), Some(false), "equal is not newer");
    assert_eq!(is_newer("0.9.0", "0.10.0"), Some(false));
}

#[test]
fn is_newer_rejects_unparseable_versions() {
    assert_eq!(is_newer("x", "0.10.0"), None);
    assert_eq!(is_newer("v0.11.0", "0.10.0"), None, "no v prefix accepted");
    assert_eq!(is_newer("0.11", "0.10.0"), None, "exactly three components required");
    assert_eq!(is_newer("0.10.0", "x"), None, "either side unparseable is None");
}

// ---- parse_manifest -----------------------------------------------------------------

const HAPPY_SHA: &str = "761a4574abcdef01761a4574abcdef01761a4574abcdef01761a4574abcdef01";
const HAPPY_MANIFEST: &str = r#"{
  "schema": 1,
  "targets": {
    "aarch64-apple-darwin": {
      "version": "0.11.0",
      "url": "https://cdn.alinery.ai/v0.11.0/Alinery-aarch64-apple-darwin.app.zip",
      "sha256": "761a4574abcdef01761a4574abcdef01761a4574abcdef01761a4574abcdef01",
      "size": 13853257,
      "protocol_version": 2,
      "published_at": "2026-08-17T12:00:00Z"
    }
  }
}"#;

#[test]
fn parse_manifest_happy_path() {
    let release = parse_manifest(HAPPY_MANIFEST.as_bytes(), "aarch64-apple-darwin").expect("manifest parses");
    assert_eq!(
        release,
        UpdateRelease {
            version: "0.11.0".into(),
            url: "https://cdn.alinery.ai/v0.11.0/Alinery-aarch64-apple-darwin.app.zip".into(),
            sha256: HAPPY_SHA.into(),
            size: 13853257,
            protocol_version: 2,
            published_at: "2026-08-17T12:00:00Z".into(),
        }
    );
}

#[test]
fn parse_manifest_ignores_unknown_fields() {
    let with_extra = r#"{
      "schema": 1,
      "channel": "stable",
      "targets": {
        "aarch64-apple-darwin": {
          "version": "0.11.0",
          "url": "https://cdn.alinery.ai/v0.11.0/Alinery-aarch64-apple-darwin.app.zip",
          "sha256": "761a4574abcdef01761a4574abcdef01761a4574abcdef01761a4574abcdef01",
          "size": 13853257,
          "protocol_version": 2,
          "published_at": "2026-08-17T12:00:00Z",
          "mandatory": false
        }
      }
    }"#;
    let release = parse_manifest(with_extra.as_bytes(), "aarch64-apple-darwin").expect("unknown fields are ignored, not rejected");
    assert_eq!(release.version, "0.11.0");
}

#[test]
fn parse_manifest_missing_triple_is_none() {
    assert_eq!(parse_manifest(HAPPY_MANIFEST.as_bytes(), "x86_64-unknown-linux-gnu"), None);
}

#[test]
fn parse_manifest_truncated_or_bad_body_is_none() {
    assert_eq!(parse_manifest(b"", "aarch64-apple-darwin"), None);
    assert_eq!(parse_manifest(b"Internal Server Error", "aarch64-apple-darwin"), None);
    assert_eq!(parse_manifest(br#"{"schema":1,"targets":{"aarch64-apple-darwin":{"version""#, "aarch64-apple-darwin"), None);
}

// ---- evaluate_update ------------------------------------------------------------------

#[test]
fn evaluate_update_refuses_when_not_allowed() {
    let status = evaluate_update("0.10.0", "aarch64-apple-darwin", HAPPY_MANIFEST.as_bytes(), 1_000, false);
    assert_eq!(status.available, None, "a newer release is not offered when the caller says not allowed");
    assert_eq!(status.current, "0.10.0");
    assert_eq!(status.checked_at, 1_000);
}

#[test]
fn evaluate_update_offers_nothing_when_not_newer() {
    let equal = evaluate_update("0.11.0", "aarch64-apple-darwin", HAPPY_MANIFEST.as_bytes(), 1_000, true);
    assert_eq!(equal.available, None, "manifest version equal to current is not an offer");

    let newer_running = evaluate_update("0.12.0", "aarch64-apple-darwin", HAPPY_MANIFEST.as_bytes(), 1_000, true);
    assert_eq!(newer_running.available, None, "manifest version older than current is not an offer");
}

#[test]
fn evaluate_update_offers_a_newer_parseable_release() {
    let status = evaluate_update("0.10.0", "aarch64-apple-darwin", HAPPY_MANIFEST.as_bytes(), 1_000, true);
    assert_eq!(status.available.map(|r| r.version), Some("0.11.0".to_string()));
}

// ---- running_bundle -------------------------------------------------------------------

#[test]
fn running_bundle_strips_contents_macos_executable() {
    assert_eq!(
        running_bundle(Path::new("/Applications/Alinery.app/Contents/MacOS/Alinery")),
        Some(PathBuf::from("/Applications/Alinery.app"))
    );
    assert_eq!(
        running_bundle(Path::new("/Users/me/Applications/Alinery.app/Contents/MacOS/Alinery")),
        Some(PathBuf::from("/Users/me/Applications/Alinery.app"))
    );
}

#[test]
fn running_bundle_is_none_outside_a_bundle() {
    assert_eq!(running_bundle(Path::new("/usr/local/bin/alinery")), None);
    assert_eq!(running_bundle(Path::new("alinery")), None);
}

// ---- is_homebrew_cask -----------------------------------------------------------------

#[test]
fn is_homebrew_cask_detects_caskroom_component() {
    assert!(is_homebrew_cask(Path::new("/opt/homebrew/Caskroom/alinery/0.10.0/Alinery.app")));
    assert!(!is_homebrew_cask(Path::new("/tmp/alinery-not-cask/Alinery.app")));
}

#[test]
fn is_homebrew_cask_follows_symlink_into_caskroom() {
    let root = std::env::temp_dir().join(format!("alinery-cask-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let real = root.join("Caskroom/alinery/0.10.0/Alinery.app");
    fs::create_dir_all(&real).unwrap();
    let link_dir = root.join("Applications");
    fs::create_dir_all(&link_dir).unwrap();
    let link = link_dir.join("Alinery.app");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    assert!(is_homebrew_cask(&link), "a /Applications symlink into Caskroom must still refuse");
    let _ = fs::remove_dir_all(&root);
}

// ---- checksum / origin / free-space ---------------------------------------------------

#[test]
fn checksums_match_requires_two_64_hex_digests() {
    assert!(!checksums_match("", ""));
    assert!(!checksums_match("", HAPPY_SHA));
    assert!(!checksums_match(HAPPY_SHA, ""));
    assert!(!checksums_match("761a4574abcdef", "761a4574abcdef"));
    assert!(checksums_match(HAPPY_SHA, HAPPY_SHA));
    assert!(checksums_match(HAPPY_SHA, &HAPPY_SHA.to_uppercase()));
}

#[test]
fn release_url_allowed_is_same_origin_under_cdn_base() {
    assert!(release_url_allowed("https://cdn.alinery.ai/v0.11.0/Alinery-aarch64-apple-darwin.app.zip"));
    assert!(!release_url_allowed("https://evil.example/v0.11.0/Alinery-aarch64-apple-darwin.app.zip"));
    assert!(!release_url_allowed("https://cdn.alinery.ai.evil.example/x"));
    assert!(!release_url_allowed("http://cdn.alinery.ai/v0.11.0/Alinery-aarch64-apple-darwin.app.zip"));
}

#[test]
fn sha256_file_of_known_bytes_is_64_hex() {
    let path = std::env::temp_dir().join(format!("alinery-sha-test-{}", std::process::id()));
    fs::write(&path, b"hello").unwrap();
    let hex = sha256_file(&path);
    let _ = fs::remove_file(&path);
    assert!(is_sha256_digest(&hex), "openssl digest must be 64 hex, not empty");
}

#[test]
fn evaluate_update_refuses_a_short_sha256() {
    let bad = HAPPY_MANIFEST.replace(HAPPY_SHA, "deadbeef");
    let status = evaluate_update("0.10.0", "aarch64-apple-darwin", bad.as_bytes(), 1_000, true);
    assert_eq!(status.available, None);
}

#[test]
fn parse_df_k_available_reads_posix_fourth_column() {
    let out = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 488245288 100 12345 1% /\n";
    assert_eq!(parse_df_k_available(out), Some(12345 * 1024));
}

#[test]
fn path_is_under_rejects_sibling_prefix() {
    let root = std::env::temp_dir().join(format!("alinery-under-test-{}", std::process::id()));
    let parent = root.join("scratch");
    let child = parent.join("extract/Alinery.app");
    let sibling = root.join("scratch-evil/Alinery.app");
    fs::create_dir_all(&child).unwrap();
    fs::create_dir_all(&sibling).unwrap();
    assert!(path_is_under(&child, &parent));
    assert!(!path_is_under(&sibling, &parent));
    let _ = fs::remove_dir_all(&root);
}

// ---- loopback: a real fetch over the wire ----------------------------------------------

fn serve_once(listener: TcpListener, status_line: &'static str, headers_and_body: Vec<u8>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut buf = [0u8; 4096];
        let _ = stream.read(&mut buf);
        let _ = stream.write_all(status_line.as_bytes());
        let _ = stream.write_all(&headers_and_body);
    })
}

#[test]
fn loopback_manifest_fetch_offers_a_newer_release() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let body = HAPPY_MANIFEST.as_bytes().to_vec();
    let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), HAPPY_MANIFEST);
    let server = serve_once(listener, "", response.into_bytes());

    std::env::set_var("ALINERY_UPDATE_MANIFEST_URL", format!("http://{address}/latest.json"));
    let url = std::env::var("ALINERY_UPDATE_MANIFEST_URL").unwrap();
    let fetched = curl_request_with_timeouts(&url, &[], None, Duration::from_secs(5), Duration::from_secs(10))
        .map(|r| r.body)
        .unwrap_or_default();
    std::env::remove_var("ALINERY_UPDATE_MANIFEST_URL");
    server.join().unwrap();

    let status = evaluate_update("0.10.0", "aarch64-apple-darwin", &fetched, 42, true);
    assert_eq!(status.available.map(|r| r.version), Some("0.11.0".to_string()));
    assert_eq!(status.checked_at, 42);
}

#[test]
fn loopback_manifest_fetch_500_offers_nothing() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let body = b"Internal Server Error".to_vec();
    let response = format!("HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let mut payload = response.into_bytes();
    payload.extend_from_slice(&body);
    let server = serve_once(listener, "", payload);

    std::env::set_var("ALINERY_UPDATE_MANIFEST_URL", format!("http://{address}/latest.json"));
    let url = std::env::var("ALINERY_UPDATE_MANIFEST_URL").unwrap();
    let fetched = curl_request_with_timeouts(&url, &[], None, Duration::from_secs(5), Duration::from_secs(10))
        .map(|r| r.body)
        .unwrap_or_default();
    std::env::remove_var("ALINERY_UPDATE_MANIFEST_URL");
    server.join().unwrap();

    let status = evaluate_update("0.10.0", "aarch64-apple-darwin", &fetched, 42, true);
    assert_eq!(status.available, None);
}

#[test]
fn loopback_manifest_fetch_truncated_offers_nothing() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    // Content-Length lies: promises 1000 bytes, sends 10, then closes the connection.
    let response = b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{\"schema\":".to_vec();
    let server = serve_once(listener, "", response);

    std::env::set_var("ALINERY_UPDATE_MANIFEST_URL", format!("http://{address}/latest.json"));
    let url = std::env::var("ALINERY_UPDATE_MANIFEST_URL").unwrap();
    let fetched = curl_request_with_timeouts(&url, &[], None, Duration::from_secs(5), Duration::from_secs(10))
        .map(|r| r.body)
        .unwrap_or_default();
    std::env::remove_var("ALINERY_UPDATE_MANIFEST_URL");
    server.join().unwrap();

    let status = evaluate_update("0.10.0", "aarch64-apple-darwin", &fetched, 42, true);
    assert_eq!(status.available, None);
}
