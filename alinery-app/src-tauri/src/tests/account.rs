//! Tests for account.rs — pairing callback parsing, nonce matching, and the display label rule.
use super::*;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

#[test]
fn parses_code_and_nonce_from_the_loopback_callback() {
    assert_eq!(
        parse_desktop_login_callback("GET /?code=abc123&nonce=deadbeef HTTP/1.1\r\n\r\n").unwrap(),
        ("abc123".to_string(), "deadbeef".to_string())
    );
}

#[test]
fn rejects_a_path_other_than_root() {
    // Deliberately not Linear's /oauth/linear/callback — the accounts loopback is `/`.
    assert!(parse_desktop_login_callback("GET /oauth/linear/callback?code=a&nonce=b HTTP/1.1\r\n\r\n").is_err());
}

#[test]
fn rejects_a_callback_missing_code_or_nonce() {
    assert!(parse_desktop_login_callback("GET /?nonce=deadbeef HTTP/1.1\r\n\r\n").is_err());
    assert!(parse_desktop_login_callback("GET /?code=abc123 HTTP/1.1\r\n\r\n").is_err());
    assert!(parse_desktop_login_callback("GET / HTTP/1.1\r\n\r\n").is_err());
}

// The nonce is the only thing standing between a real sign-in and a stray request hitting the
// ephemeral port (a port scanner, a stale tab). A mismatch must be ignored and the wait must keep
// going for the real one, exactly like Linear ignores unsolicited OAuth callbacks.
#[test]
fn wait_for_desktop_login_callback_ignores_a_nonce_mismatch_then_accepts_the_right_one() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let handle = std::thread::spawn(move || wait_for_desktop_login_callback(listener, "expected-nonce"));

    let mut wrong = TcpStream::connect(address).unwrap();
    wrong.write_all(b"GET /?code=stolen&nonce=wrong-nonce HTTP/1.1\r\n\r\n").unwrap();
    let mut drain = [0u8; 512];
    let _ = wrong.read(&mut drain);
    drop(wrong);

    let mut right = None;
    for _ in 0..50 {
        if let Ok(stream) = TcpStream::connect(address) {
            right = Some(stream);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let mut right = right.expect("listener still accepting after the mismatched callback");
    right.write_all(b"GET /?code=the-real-code&nonce=expected-nonce HTTP/1.1\r\n\r\n").unwrap();
    let mut drain = [0u8; 512];
    let _ = right.read(&mut drain);

    assert_eq!(handle.join().unwrap().unwrap(), "the-real-code");
}

// docs/architecture/desktop-pairing.md: "email (or providers[0] if email is null)".
#[test]
fn display_label_prefers_email_then_falls_back_to_the_first_provider() {
    let with_email = AccountUser {
        id: "u1".into(),
        email: Some("a@example.com".into()),
        providers: vec!["github".into()],
    };
    assert_eq!(display_label(&with_email), "a@example.com");

    let no_email = AccountUser {
        id: "u2".into(),
        email: None,
        providers: vec!["github".into(), "google".into()],
    };
    assert_eq!(display_label(&no_email), "github");

    let neither = AccountUser {
        id: "u3".into(),
        email: None,
        providers: vec![],
    };
    assert_eq!(display_label(&neither), "");
}

#[test]
fn accounts_url_defaults_to_production_and_honors_the_local_override() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    std::env::remove_var("ALINERY_ACCOUNTS_URL");
    assert_eq!(accounts_url(), "https://accounts.alinery.ai");
    // Production pairs against Stripe live mode; anything else is a test-mode setup.
    assert!(production_livemode());

    std::env::set_var("ALINERY_ACCOUNTS_URL", "http://localhost:3000/");
    assert_eq!(accounts_url(), "http://localhost:3000");
    assert!(!production_livemode());
    std::env::remove_var("ALINERY_ACCOUNTS_URL");
}

// Dev and prod share one Supabase project and one entitlements table, so dropping the livemode
// filter would leave a user holding both a test and a live entitlement with an arbitrary row —
// the query has no ordering and `parse_entitlement_plan` takes the first.
#[test]
fn entitlement_url_selects_the_stripe_mode_for_the_environment() {
    assert_eq!(
        entitlement_url("https://x.supabase.co", true),
        "https://x.supabase.co/rest/v1/entitlements?select=plan&livemode=eq.true"
    );
    assert_eq!(
        entitlement_url("https://x.supabase.co", false),
        "https://x.supabase.co/rest/v1/entitlements?select=plan&livemode=eq.false"
    );
}

#[test]
fn plan_label_maps_known_ids() {
    assert_eq!(plan_label("founders"), "Founders Edition");
    assert_eq!(plan_label("teams"), "Teams");
    assert_eq!(plan_label("free"), "Free");
}

#[test]
fn parse_entitlement_plan_reads_the_first_row() {
    assert_eq!(parse_entitlement_plan(br#"[{"plan":"founders"}]"#).unwrap().as_deref(), Some("Founders Edition"));
    // A successful empty response is Ok(None) — the caller must clear a cached plan.
    assert_eq!(parse_entitlement_plan(br#"[]"#).unwrap(), None);
    assert_eq!(parse_entitlement_plan(br#"[{"plan":""}]"#).unwrap(), None);
    // An unparseable body is an error, so the cached plan survives.
    assert!(parse_entitlement_plan(br#"not json"#).is_err());
}

#[test]
fn auth_json_lives_in_the_app_config_dir() {
    assert_eq!(
        account_auth_path_in(Path::new("/tmp/ai.delegance.alinery.dev")),
        Path::new("/tmp/ai.delegance.alinery.dev/auth.json")
    );
}

const DEAD_ENTITLEMENT: &str = "http://127.0.0.1:1";

#[test]
fn loopback_html_matches_the_accounts_page_tokens() {
    let ok = loopback_html(true);
    assert!(ok.contains("Authorization received"));
    assert!(ok.contains("Return to Alinery."));
    assert!(!ok.contains("Signed in"));
    assert!(ok.contains("#000104"));
    assert!(ok.contains("SF Pro Text"));
    assert!(ok.contains("class=\"kicker\""));
    let expired = loopback_html(false);
    assert!(expired.contains("This link expired"));
    assert!(expired.contains("Return to Alinery and try again."));
}

fn write_session_tokens(path: &Path, session: &str, access: &str, refresh: &str, expires_at: u64) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        path,
        serde_json::json!({
            "access_token": access,
            "refresh_token": refresh,
            "expires_at": expires_at,
            "user": { "id": "u1", "email": "a@example.com", "providers": [] },
            "plan": "Founders Edition",
            "session_id": session
        })
        .to_string(),
    )
    .unwrap();
}

/// A fixture write stands for a fresh pairing, so its session id is derived from its own
/// refresh token: two fixtures with different tokens are two different sessions. Use
/// `write_session_tokens` directly to write a *rotation* of an existing session.
fn write_tokens(path: &Path, access: &str, refresh: &str, expires_at: u64) {
    write_session_tokens(path, &format!("session-{refresh}"), access, refresh, expires_at);
}

/// How long a fixture server waits for the request it was set up to answer.
///
/// A request that never arrives used to park the server thread in `accept()` forever. The test
/// joins that thread while holding `CREDENTIAL_HOOK_TEST`, so one such miss hung the whole test
/// binary behind the mutex -- every other account test reported "running for over 60 seconds" and
/// none of them named the one at fault. Giving up lets the test fail on its own assertion, which
/// says what actually went wrong. Generous, because a slow machine must not turn a pass into a
/// spurious failure.
const SERVE_TIMEOUT: Duration = Duration::from_secs(20);

fn serve_routes(routes: Vec<(String, u16, &'static str)>) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let handle = std::thread::spawn(move || {
        for (want_path, status, body) in routes {
            let deadline = Instant::now() + SERVE_TIMEOUT;
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if Instant::now() >= deadline {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => return,
                }
            };
            // A socket accepted from a non-blocking listener inherits O_NONBLOCK on the BSDs, so
            // the read below would spin off into WouldBlock without this.
            if stream.set_nonblocking(false).is_err() {
                return;
            }
            let _ = stream.set_read_timeout(Some(SERVE_TIMEOUT));
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let path = req.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("");
            assert!(path.contains(&want_path), "expected {want_path} got {path}");
            let resp = format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = stream.write_all(resp.as_bytes());
        }
    });
    (format!("http://127.0.0.1:{}", addr.port()), handle)
}

#[test]
fn classify_refresh_response_table() {
    struct Case {
        status: u16,
        body: &'static [u8],
        clears: bool,
        invalid_refresh: bool,
    }
    let cases = [
        Case {
            status: 400,
            body: br#"{"error":"invalid_grant"}"#,
            clears: true,
            invalid_refresh: true,
        },
        Case {
            status: 400,
            body: br#"{"error_code":"refresh_token_not_found","msg":"gone"}"#,
            clears: true,
            invalid_refresh: true,
        },
        Case {
            status: 400,
            body: br#"{"error_code":"refresh_token_already_used"}"#,
            clears: true,
            invalid_refresh: true,
        },
        Case {
            status: 400,
            body: br#"{"error":"invalid_api_key"}"#,
            clears: false,
            invalid_refresh: false,
        },
        Case {
            status: 401,
            body: b"nope",
            clears: false,
            invalid_refresh: false,
        },
        Case {
            status: 403,
            body: br#"{"message":"forbidden"}"#,
            clears: false,
            invalid_refresh: false,
        },
        Case {
            status: 404,
            body: b"missing",
            clears: false,
            invalid_refresh: false,
        },
        Case {
            status: 429,
            body: b"slow",
            clears: false,
            invalid_refresh: false,
        },
        Case {
            status: 500,
            body: b"nope",
            clears: false,
            invalid_refresh: false,
        },
        Case {
            status: 200,
            body: b"not json",
            clears: false,
            invalid_refresh: false,
        },
        Case {
            status: 401,
            body: br#"{"error":"invalid_grant","error_description":"Invalid Refresh Token"}"#,
            clears: true,
            invalid_refresh: true,
        },
    ];
    for case in cases {
        let err = classify_refresh_response(case.status, case.body).unwrap_err();
        assert_eq!(err.clears_credential(), case.clears, "status {} body {}", case.status, String::from_utf8_lossy(case.body));
        assert_eq!(
            matches!(err, AccountAuthError::InvalidRefreshToken(_)),
            case.invalid_refresh,
            "status {} body {}",
            case.status,
            String::from_utf8_lossy(case.body)
        );
    }
}

#[test]
fn account_status_from_path_is_local_even_when_expired() {
    let dir = unique_attachment_temp("account-status-expired");
    let path = dir.join("auth.json");
    write_tokens(&path, "access", "refresh-keep", 1);
    let status = account_status_from_path(&path);
    assert!(status.signed_in);
    assert_eq!(status.email.as_deref(), Some("a@example.com"));
    assert!(!status.unavailable);
    assert!(path.exists());
}

#[test]
fn refresh_against_a_dead_port_keeps_auth_json() {
    let dir = unique_attachment_temp("account-refresh-dead");
    let path = dir.join("auth.json");
    write_tokens(&path, "access", "refresh-keep", 1);
    let status = refresh_account_at(&path, "http://127.0.0.1:1", DEAD_ENTITLEMENT);
    assert!(status.signed_in);
    assert!(status.unavailable);
    assert!(fs::read_to_string(&path).unwrap().contains("refresh-keep"));
}

#[test]
fn refresh_invalid_grant_removes_auth_json() {
    let dir = unique_attachment_temp("account-refresh-terminal");
    let path = dir.join("auth.json");
    write_tokens(&path, "access", "refresh-dead", 1);
    let (base, server) = serve_routes(vec![("/auth/v1/token".into(), 400, r#"{"error":"invalid_grant"}"#)]);
    let status = refresh_account_at(&path, &base, DEAD_ENTITLEMENT);
    server.join().unwrap();
    assert!(!status.signed_in);
    assert!(!path.exists());
}

#[test]
fn refresh_does_not_rewrite_auth_json_after_sign_out() {
    let dir = unique_attachment_temp("account-refresh-after-signout");
    let path = dir.join("auth.json");
    write_tokens(&path, "access", "refresh-keep", 1);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let victim = path.clone();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buf = [0u8; 4096];
        let _ = stream.read(&mut buf);
        let _ = fs::remove_file(&victim);
        let body = r#"{"access_token":"new","refresh_token":"r2","expires_in":3600}"#;
        let resp = format!("HTTP/1.1 200 X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let _ = stream.write_all(resp.as_bytes());
    });
    let status = refresh_account_at(&path, &format!("http://{addr}"), DEAD_ENTITLEMENT);
    server.join().unwrap();
    assert!(!status.signed_in);
    assert!(!path.exists());
}

#[test]
fn terminal_refresh_does_not_delete_a_newer_session() {
    let dir = unique_attachment_temp("account-refresh-newer-session");
    let path = dir.join("auth.json");
    write_tokens(&path, "access", "refresh-old", 1);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let victim = path.clone();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buf = [0u8; 4096];
        let _ = stream.read(&mut buf);
        write_tokens(&victim, "access-new", "refresh-new", 4_000_000_000);
        let body = r#"{"error":"invalid_grant"}"#;
        let resp = format!("HTTP/1.1 400 X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let _ = stream.write_all(resp.as_bytes());
    });
    let status = refresh_account_at(&path, &format!("http://{addr}"), DEAD_ENTITLEMENT);
    server.join().unwrap();
    assert!(status.signed_in);
    assert!(fs::read_to_string(&path).unwrap().contains("refresh-new"));
}

#[test]
fn refresh_401_without_token_code_keeps_auth_json() {
    let dir = unique_attachment_temp("account-refresh-401-keep");
    let path = dir.join("auth.json");
    write_tokens(&path, "access", "refresh-keep", 1);
    let (base, server) = serve_routes(vec![("/auth/v1/token".into(), 401, r#"{"error":"invalid_api_key"}"#)]);
    let status = refresh_account_at(&path, &base, DEAD_ENTITLEMENT);
    server.join().unwrap();
    assert!(status.signed_in);
    assert!(status.unavailable);
    assert!(fs::read_to_string(&path).unwrap().contains("refresh-keep"));
}

fn pause_after_compare() -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
    let (gate_tx, gate_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    *crate::AFTER_CREDENTIAL_COMPARE.lock().unwrap() = Some(Box::new(move || {
        let _ = gate_tx.send(());
        let _ = resume_rx.recv();
    }));
    (gate_rx, resume_tx)
}

#[test]
fn stale_save_after_compare_does_not_clobber_a_newer_session() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let dir = unique_attachment_temp("account-cas-save");
    let path = dir.join("auth.json");
    write_tokens(&path, "access", "refresh-old", 1);
    let (gate_rx, resume_tx) = pause_after_compare();
    let (base, server) = serve_routes(vec![("/auth/v1/token".into(), 200, r#"{"access_token":"new","refresh_token":"r2","expires_in":3600}"#)]);
    let refresh_path = path.clone();
    let refresh = std::thread::spawn(move || refresh_account_at(&refresh_path, &base, DEAD_ENTITLEMENT));
    gate_rx.recv().unwrap();
    write_tokens(&path, "access-b", "refresh-b", 4_000_000_000);
    resume_tx.send(()).unwrap();
    let _status = refresh.join().unwrap();
    server.join().unwrap();
    let on_disk = fs::read_to_string(&path).unwrap();
    assert!(on_disk.contains("refresh-b"), "{on_disk}");
    assert!(!on_disk.contains("\"r2\""), "{on_disk}");
}

#[test]
fn stale_clear_after_compare_does_not_delete_a_newer_session() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let dir = unique_attachment_temp("account-cas-clear");
    let path = dir.join("auth.json");
    write_tokens(&path, "access", "refresh-old", 1);
    let (gate_rx, resume_tx) = pause_after_compare();
    let (base, server) = serve_routes(vec![("/auth/v1/token".into(), 400, r#"{"error":"invalid_grant"}"#)]);
    let refresh_path = path.clone();
    let refresh = std::thread::spawn(move || refresh_account_at(&refresh_path, &base, DEAD_ENTITLEMENT));
    gate_rx.recv().unwrap();
    write_tokens(&path, "access-b", "refresh-b", 4_000_000_000);
    resume_tx.send(()).unwrap();
    let _status = refresh.join().unwrap();
    server.join().unwrap();
    assert!(fs::read_to_string(&path).unwrap().contains("refresh-b"));
}

#[test]
fn refresh_persists_rotated_token_before_entitlement() {
    let dir = unique_attachment_temp("account-refresh-persist-first");
    let path = dir.join("auth.json");
    write_tokens(&path, "access", "refresh-old", 1);
    let token_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let plan_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let token_addr = token_listener.local_addr().unwrap();
    let plan_addr = plan_listener.local_addr().unwrap();
    let (persisted_tx, persisted_rx) = std::sync::mpsc::channel::<String>();
    let victim = path.clone();
    let token_server = std::thread::spawn(move || {
        let (mut stream, _) = token_listener.accept().unwrap();
        let mut buf = [0u8; 4096];
        let _ = stream.read(&mut buf);
        let body = r#"{"access_token":"new-access","refresh_token":"rotated","expires_in":3600}"#;
        let resp = format!("HTTP/1.1 200 X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let _ = stream.write_all(resp.as_bytes());
    });
    let plan_server = std::thread::spawn(move || {
        let (mut stream, _) = plan_listener.accept().unwrap();
        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]).into_owned();
        persisted_tx.send(fs::read_to_string(&victim).unwrap_or_default()).unwrap();
        assert!(req.contains("Authorization: Bearer new-access"), "{req}");
        let body = r#"[{"plan":"founders"}]"#;
        let resp = format!("HTTP/1.1 200 X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let _ = stream.write_all(resp.as_bytes());
    });
    let status = refresh_account_at(&path, &format!("http://{token_addr}"), &format!("http://{plan_addr}"));
    token_server.join().unwrap();
    plan_server.join().unwrap();
    let on_disk_at_plan = persisted_rx.recv().unwrap();
    assert!(on_disk_at_plan.contains("rotated"), "{on_disk_at_plan}");
    assert_eq!(status.plan.as_deref(), Some("Founders Edition"));
    assert!(fs::read_to_string(&path).unwrap().contains("Founders Edition"));
}

#[test]
fn refresh_write_failure_is_unavailable_not_success() {
    use std::os::unix::fs::PermissionsExt;
    let dir = unique_attachment_temp("account-refresh-write-fail");
    let path = dir.join("auth.json");
    write_tokens(&path, "access", "refresh-old", 1);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let parent = path.parent().unwrap().to_path_buf();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buf = [0u8; 4096];
        let _ = stream.read(&mut buf);
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o555)).unwrap();
        let body = r#"{"access_token":"new","refresh_token":"rotated","expires_in":3600}"#;
        let resp = format!("HTTP/1.1 200 X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let _ = stream.write_all(resp.as_bytes());
    });
    let status = refresh_account_at(&path, &format!("http://{addr}"), DEAD_ENTITLEMENT);
    server.join().unwrap();
    let _ = fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o700));
    assert!(status.signed_in);
    assert!(status.unavailable);
    assert!(fs::read_to_string(&path).unwrap().contains("refresh-old"));
}

#[test]
fn sign_out_refresh_then_logout_200_revokes_remotely() {
    let dir = unique_attachment_temp("account-signout-ok");
    let path = dir.join("auth.json");
    write_tokens(&path, "old", "refresh-ok", 1);
    let (base, server) = serve_routes(vec![
        ("/auth/v1/token".into(), 200, r#"{"access_token":"new","refresh_token":"r2","expires_in":3600}"#),
        ("/auth/v1/logout".into(), 200, ""),
    ]);
    let result = sign_out_at(&path, &base).unwrap();
    server.join().unwrap();
    assert!(result.remote_revoked);
    assert!(!path.exists());
}

#[test]
fn sign_out_expired_refresh_transport_fail_clears_locally() {
    let dir = unique_attachment_temp("account-signout-transport");
    let path = dir.join("auth.json");
    write_tokens(&path, "old", "refresh-keep", 1);
    let result = sign_out_at(&path, "http://127.0.0.1:1").unwrap();
    assert!(!result.remote_revoked);
    assert!(!path.exists());
}

#[test]
fn sign_out_logout_401_clears_locally() {
    let dir = unique_attachment_temp("account-signout-401");
    let path = dir.join("auth.json");
    write_tokens(&path, "live", "refresh-keep", 4_000_000_000);
    let (base, server) = serve_routes(vec![("/auth/v1/logout".into(), 401, "nope")]);
    let result = sign_out_at(&path, &base).unwrap();
    server.join().unwrap();
    assert!(!result.remote_revoked);
    assert!(!path.exists());
}

#[test]
fn sign_out_logout_500_clears_locally() {
    let dir = unique_attachment_temp("account-signout-500");
    let path = dir.join("auth.json");
    write_tokens(&path, "live", "refresh-keep", 4_000_000_000);
    let (base, server) = serve_routes(vec![("/auth/v1/logout".into(), 500, "boom")]);
    let result = sign_out_at(&path, &base).unwrap();
    server.join().unwrap();
    assert!(!result.remote_revoked);
    assert!(!path.exists());
}

#[test]
fn sign_out_logout_204_revokes_remotely() {
    let dir = unique_attachment_temp("account-signout-204");
    let path = dir.join("auth.json");
    write_tokens(&path, "live", "refresh-keep", 4_000_000_000);
    let (base, server) = serve_routes(vec![("/auth/v1/logout".into(), 204, "")]);
    let result = sign_out_at(&path, &base).unwrap();
    server.join().unwrap();
    assert!(result.remote_revoked);
    assert!(!path.exists());
}

#[test]
fn sign_out_expired_invalid_grant_is_already_revoked() {
    let dir = unique_attachment_temp("account-signout-invalid-grant");
    let path = dir.join("auth.json");
    write_tokens(&path, "old", "refresh-dead", 1);
    let (base, server) = serve_routes(vec![("/auth/v1/token".into(), 400, r#"{"error":"invalid_grant"}"#)]);
    let result = sign_out_at(&path, &base).unwrap();
    server.join().unwrap();
    assert!(result.remote_revoked);
    assert!(!path.exists());
}

#[test]
fn sign_out_expired_401_without_token_code_is_not_revoked() {
    let dir = unique_attachment_temp("account-signout-expired-401");
    let path = dir.join("auth.json");
    write_tokens(&path, "old", "refresh-keep", 1);
    let (base, server) = serve_routes(vec![("/auth/v1/token".into(), 401, r#"{"error":"invalid_api_key"}"#)]);
    let result = sign_out_at(&path, &base).unwrap();
    server.join().unwrap();
    assert!(!result.remote_revoked);
    assert!(!path.exists());
}

#[test]
fn sign_out_expired_404_is_not_revoked() {
    let dir = unique_attachment_temp("account-signout-expired-404");
    let path = dir.join("auth.json");
    write_tokens(&path, "old", "refresh-keep", 1);
    let (base, server) = serve_routes(vec![("/auth/v1/token".into(), 404, "missing")]);
    let result = sign_out_at(&path, &base).unwrap();
    server.join().unwrap();
    assert!(!result.remote_revoked);
    assert!(!path.exists());
}

#[test]
fn wait_cancel_returns_quickly() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let attempt = std::sync::Arc::new(SignInAttempt::fresh());
    let flag = attempt.clone();
    let started = Instant::now();
    let waiter = std::thread::spawn(move || wait_for_desktop_login_callback_until(listener, "nonce", &flag, Instant::now() + Duration::from_secs(2)));
    std::thread::sleep(Duration::from_millis(50));
    attempt.cancel();
    let err = waiter.join().unwrap().unwrap_err();
    assert!(err.contains("cancelled"), "{err}");
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn wait_accepts_a_fragmented_request_line() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let waiter = std::thread::spawn(move || wait_for_desktop_login_callback_until(listener, "n", &SignInAttempt::fresh(), Instant::now() + Duration::from_secs(2)));
    let mut stream = TcpStream::connect(addr).unwrap();
    stream.write_all(b"GET /?code=c&nonce=n HTTP/1.1").unwrap();
    std::thread::sleep(Duration::from_millis(50));
    stream.write_all(b"\r\n").unwrap();
    assert_eq!(waiter.join().unwrap().unwrap(), "c");
}

#[test]
fn wait_caps_a_stalled_client_to_the_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let started = Instant::now();
    let waiter = std::thread::spawn(move || wait_for_desktop_login_callback_until(listener, "n", &SignInAttempt::fresh(), Instant::now() + Duration::from_secs(2)));
    let _stall = TcpStream::connect(addr).unwrap();
    let err = waiter.join().unwrap().unwrap_err();
    assert!(err.contains("timed out"), "{err}");
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[test]
fn second_sign_in_attempt_is_rejected_while_first_is_live() {
    // SIGN_IN_IN_FLIGHT is global, so every test that registers an attempt shares this mutex.
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let first = begin_sign_in_attempt().unwrap();
    let err = begin_sign_in_attempt().unwrap_err();
    assert!(err.contains("already in progress"), "{err}");
    drop(first);
    end_sign_in_attempt();
}

// The mount refresh and Sign out both load R1. If the refresh persists rotation R2 first, a
// refresh-token comparison leaves sign-out unable to remove its own session: R2 stays on disk
// while the chip says Sign in, and the next mount reads it back. Keyed on the session id, the
// rotation is still recognised as the session being signed out of.
#[test]
fn sign_out_clears_a_concurrent_rotation_of_the_same_session() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let dir = unique_attachment_temp("account-signout-rotated");
    let path = dir.join("auth.json");
    write_tokens(&path, "live", "refresh-1", 4_000_000_000);
    let (base, server) = serve_routes(vec![("/auth/v1/logout".into(), 200, "")]);
    let (gate_rx, resume_tx) = pause_after_compare();
    let signout_path = path.clone();
    let signout = std::thread::spawn(move || sign_out_at(&signout_path, &base));
    gate_rx.recv().unwrap();
    write_session_tokens(&path, "session-refresh-1", "access-2", "refresh-2", 4_000_000_000);
    resume_tx.send(()).unwrap();
    let result = signout.join().unwrap().unwrap();
    server.join().unwrap();
    assert!(result.remote_revoked);
    assert!(!path.exists(), "a rotation of the signed-out session must not survive sign-out");
}

// The other side of the same comparison: a different session id is a genuinely new pairing,
// which sign-out must leave alone.
#[test]
fn sign_out_preserves_a_newer_pairing_written_mid_flight() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let dir = unique_attachment_temp("account-signout-newer");
    let path = dir.join("auth.json");
    write_tokens(&path, "live", "refresh-1", 4_000_000_000);
    let (base, server) = serve_routes(vec![("/auth/v1/logout".into(), 200, "")]);
    let (gate_rx, resume_tx) = pause_after_compare();
    let signout_path = path.clone();
    let signout = std::thread::spawn(move || sign_out_at(&signout_path, &base));
    gate_rx.recv().unwrap();
    write_tokens(&path, "live-b", "refresh-b", 4_000_000_000);
    resume_tx.send(()).unwrap();
    let result = signout.join().unwrap().unwrap();
    server.join().unwrap();
    assert!(fs::read_to_string(&path).unwrap().contains("refresh-b"));
    assert!(result.signed_in, "preserving a newer pairing must not report signed out");
    assert_eq!(result.email.as_deref(), Some("a@example.com"));
}

#[test]
fn sign_out_local_removal_failure_is_an_error_not_a_signed_out_success() {
    use std::os::unix::fs::PermissionsExt;
    let dir = unique_attachment_temp("account-signout-clear-fail");
    let path = dir.join("auth.json");
    write_tokens(&path, "live", "refresh-keep", 4_000_000_000);
    let (base, server) = serve_routes(vec![("/auth/v1/logout".into(), 200, "")]);
    let parent = path.parent().unwrap().to_path_buf();
    // Readable but not writable: the load succeeds, the unlink does not.
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o500)).unwrap();
    let outcome = sign_out_at(&path, &base);
    server.join().unwrap();
    let _ = fs::set_permissions(&parent, fs::Permissions::from_mode(0o700));
    let error = outcome.err().expect("sign-out must not report success while the credential is still on disk");
    assert!(error.contains("could not remove this device's credential"), "{error}");
    assert!(path.exists(), "the tokens are still there, so the UI must not claim signed out");
}

#[test]
fn refresh_clears_a_stale_plan_when_the_entitlement_is_gone() {
    let dir = unique_attachment_temp("account-plan-cleared");
    let path = dir.join("auth.json");
    write_tokens(&path, "live", "refresh-keep", 4_000_000_000);
    let (base, server) = serve_routes(vec![("/rest/v1/entitlements".into(), 200, "[]")]);
    let status = refresh_account_at(&path, &base, &base);
    server.join().unwrap();
    assert!(status.signed_in);
    assert_eq!(status.plan, None);
    assert!(!fs::read_to_string(&path).unwrap().contains("Founders Edition"));
}

#[test]
fn refresh_keeps_a_cached_plan_when_the_entitlement_lookup_fails() {
    let dir = unique_attachment_temp("account-plan-kept");
    let path = dir.join("auth.json");
    write_tokens(&path, "live", "refresh-keep", 4_000_000_000);
    let offline = refresh_account_at(&path, DEAD_ENTITLEMENT, DEAD_ENTITLEMENT);
    assert_eq!(offline.plan.as_deref(), Some("Founders Edition"));
    // curl exits 0 on a 5xx and hands back the error body, which is why the status is checked.
    let (base, server) = serve_routes(vec![("/rest/v1/entitlements".into(), 500, "boom")]);
    let broken = refresh_account_at(&path, &base, &base);
    server.join().unwrap();
    assert_eq!(broken.plan.as_deref(), Some("Founders Edition"));
    assert!(fs::read_to_string(&path).unwrap().contains("Founders Edition"));
}

const EXCHANGE_OK: &str =
    r#"{"ok":true,"access_token":"paired-access","refresh_token":"paired-refresh","expires_at":4000000000,"user":{"id":"u9","email":"b@example.com","providers":["google"]}}"#;

#[test]
fn sign_in_persists_the_paired_session_and_mints_a_session_id() {
    let dir = unique_attachment_temp("account-signin-ok");
    let path = dir.join("auth.json");
    let (base, server) = serve_routes(vec![("/api/desktop/exchange".into(), 200, EXCHANGE_OK)]);
    let status = finish_sign_in(&path, &base, "code", "nonce", &SignInAttempt::fresh()).unwrap();
    server.join().unwrap();
    assert!(status.signed_in);
    assert_eq!(status.email.as_deref(), Some("b@example.com"));
    // No entitlement base in the signature: the plan is the frontend's follow-up refresh, so
    // sign-in resolves the moment the credential is durable.
    assert_eq!(status.plan, None);
    let on_disk: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(on_disk["refresh_token"], "paired-refresh");
    assert_eq!(on_disk["session_id"].as_str().unwrap().len(), 32);
}

#[test]
fn sign_in_cancelled_before_the_exchange_writes_nothing() {
    let dir = unique_attachment_temp("account-signin-cancel-early");
    let path = dir.join("auth.json");
    // A dead port: reaching the exchange at all would be a slow failure, not a fast cancel.
    let error = finish_sign_in(&path, "http://127.0.0.1:1", "code", "nonce", &SignInAttempt::cancelled())
        .err()
        .expect("a cancelled attempt must not report a signed-in status");
    assert!(error.contains("cancelled"), "{error}");
    assert!(!path.exists());
}

// Cancel sign-in stays visible until the promise settles, so the click can land while the
// exchange is on the wire. The attempt must persist nothing and must not clobber the session
// that was already signed in.
#[test]
fn sign_in_cancelled_during_the_exchange_keeps_the_previous_session() {
    let dir = unique_attachment_temp("account-signin-cancel-exchange");
    let path = dir.join("auth.json");
    write_tokens(&path, "old-access", "refresh-old", 4_000_000_000);
    let attempt = std::sync::Arc::new(SignInAttempt::fresh());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let flag = attempt.clone();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buf = [0u8; 4096];
        let _ = stream.read(&mut buf);
        flag.cancel();
        let resp = format!("HTTP/1.1 200 X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{EXCHANGE_OK}", EXCHANGE_OK.len());
        let _ = stream.write_all(resp.as_bytes());
    });
    let outcome = finish_sign_in(&path, &format!("http://{addr}"), "code", "nonce", &attempt);
    let error = outcome.err().expect("a cancelled attempt must not report a signed-in status");
    server.join().unwrap();
    assert!(error.contains("cancelled"), "{error}");
    let on_disk = fs::read_to_string(&path).unwrap();
    assert!(on_disk.contains("refresh-old"), "{on_disk}");
    assert!(!on_disk.contains("paired-refresh"), "{on_disk}");
}

fn pause_before_persist() -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
    let (gate_tx, gate_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    *crate::BEFORE_SIGN_IN_PERSIST.lock().unwrap() = Some(Box::new(move || {
        let _ = gate_tx.send(());
        let _ = resume_rx.recv();
    }));
    (gate_rx, resume_tx)
}

// Cancel and persist share auth.json.lock. Pausing after the pre-lock flag check lets the
// visible Cancel click land before the write; a successful cancel must leave the previous
// session untouched rather than racing the rename.
#[test]
fn sign_in_cancelled_after_the_persist_check_writes_nothing() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let dir = unique_attachment_temp("account-signin-cancel-persist");
    let path = dir.join("auth.json");
    write_tokens(&path, "old-access", "refresh-old", 4_000_000_000);
    let attempt = begin_sign_in_attempt().unwrap();
    let (gate_rx, resume_tx) = pause_before_persist();
    let (base, server) = serve_routes(vec![("/api/desktop/exchange".into(), 200, EXCHANGE_OK)]);
    let persist_path = path.clone();
    let persist = std::thread::spawn(move || finish_sign_in(&persist_path, &base, "code", "nonce", &attempt));
    gate_rx.recv().unwrap();
    cancel_sign_in_at(&path).expect("cancel must succeed before persist commits");
    resume_tx.send(()).unwrap();
    let error = persist.join().unwrap().err().expect("a cancelled attempt must not report signed in");
    server.join().unwrap();
    end_sign_in_attempt();
    assert!(error.contains("cancelled"), "{error}");
    let on_disk = fs::read_to_string(&path).unwrap();
    assert!(on_disk.contains("refresh-old"), "{on_disk}");
    assert!(!on_disk.contains("paired-refresh"), "{on_disk}");
}

#[test]
#[ignore = "invoked as a child of two_process_clear_after_compare_does_not_delete_a_newer_session"]
fn account_child_write_newer_session() {
    let path = std::env::var("ALINERY_ACCOUNT_AUTH").expect("parent must pass the auth.json path");
    write_tokens(Path::new(&path), "access-b", "refresh-b", 4_000_000_000);
}

// Process A holds auth.json.lock after its session-id compare. Process B then installs a
// newer pairing (a raw write, the remaining interleaving the flock cannot see). A's second
// compare must refuse to delete B.
#[test]
fn two_process_clear_after_compare_does_not_delete_a_newer_session() {
    let dir = unique_attachment_temp("account-two-process-clear");
    let path = dir.join("auth.json");
    write_tokens(&path, "access", "refresh-old", 1);
    let (gate_tx, gate_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    let clear_path = path.clone();
    let clearer = std::thread::spawn(move || hold_lock_after_compare_then_clear(&clear_path, "session-refresh-old", &gate_tx, &resume_rx));
    gate_rx.recv().unwrap();
    assert!(
        alinery_core::try_lock_exclusive(&account_lock_path(&path)).unwrap().is_none(),
        "process A must still hold the flock after its compare",
    );
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .env("ALINERY_ACCOUNT_AUTH", &path)
        .args(["--exact", "tests::account::account_child_write_newer_session", "--ignored", "--nocapture"])
        .status()
        .expect("spawn child");
    assert!(child.success(), "child must write session B, got {child}");
    resume_tx.send(()).unwrap();
    let cleared = clearer.join().unwrap().unwrap();
    assert!(cleared.is_none(), "a newer pairing written mid-flight must survive the stale clear");
    let on_disk = fs::read_to_string(&path).unwrap();
    assert!(on_disk.contains("refresh-b"), "{on_disk}");
    assert!(!on_disk.contains("refresh-old"), "{on_disk}");
}

// `session_id` survives rotation by design, so it cannot tell R1 from the R2 another window
// wrote while the entitlement request was out. A session-only compare that writes back the
// pre-request clone restores the superseded token, and the next refresh signs the user out
// with it. Only `plan` may be written, onto whatever is on disk now.
#[test]
fn plan_write_does_not_restore_a_token_the_same_session_already_rotated() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let dir = unique_attachment_temp("account-plan-rotation");
    let path = dir.join("auth.json");
    write_session_tokens(&path, "session-s", "access-1", "refresh-1", 4_000_000_000);
    let (gate_rx, resume_tx) = pause_after_compare();
    let (base, server) = serve_routes(vec![("/rest/v1/entitlements".into(), 200, r#"[{"plan":"teams"}]"#)]);
    let refresh_path = path.clone();
    let refresh = std::thread::spawn(move || refresh_account_at(&refresh_path, DEAD_ENTITLEMENT, &base));
    gate_rx.recv().unwrap();
    write_session_tokens(&path, "session-s", "access-2", "refresh-2", 4_000_000_000);
    resume_tx.send(()).unwrap();
    let status = refresh.join().unwrap();
    server.join().unwrap();
    let on_disk = fs::read_to_string(&path).unwrap();
    assert!(on_disk.contains("refresh-2"), "the rotation must survive the plan write: {on_disk}");
    assert!(!on_disk.contains("refresh-1"), "the pre-request token must not come back: {on_disk}");
    assert!(on_disk.contains("access-2"), "{on_disk}");
    assert!(on_disk.contains("Teams"), "the plan belongs on the rotated tokens: {on_disk}");
    assert_eq!(status.plan.as_deref(), Some("Teams"));
}

// The same window on the rotation write itself: this refresh started from R1, so R2 on disk
// means another window already rotated the session and won.
#[test]
fn refresh_save_does_not_clobber_a_newer_generation_of_the_same_session() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let dir = unique_attachment_temp("account-cas-save-same-session");
    let path = dir.join("auth.json");
    write_session_tokens(&path, "session-s", "access-1", "refresh-1", 1);
    let (gate_rx, resume_tx) = pause_after_compare();
    let (base, server) = serve_routes(vec![(
        "/auth/v1/token".into(),
        200,
        r#"{"access_token":"new","refresh_token":"r-from-server","expires_in":3600}"#,
    )]);
    let refresh_path = path.clone();
    let refresh = std::thread::spawn(move || refresh_account_at(&refresh_path, &base, DEAD_ENTITLEMENT));
    gate_rx.recv().unwrap();
    write_session_tokens(&path, "session-s", "access-2", "refresh-2", 4_000_000_000);
    resume_tx.send(()).unwrap();
    let status = refresh.join().unwrap();
    server.join().unwrap();
    let on_disk = fs::read_to_string(&path).unwrap();
    assert!(on_disk.contains("refresh-2"), "{on_disk}");
    assert!(!on_disk.contains("r-from-server"), "a refresh that started from R1 must not overwrite R2: {on_disk}");
    assert!(status.signed_in);
}

// invalid_grant proves *this* refresh token is dead, not the session. Another window can
// already have rotated to R2, and deleting on a session-only compare signs the user out of a
// credential that still works.
#[test]
fn invalid_refresh_does_not_delete_a_newer_generation_of_the_same_session() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let dir = unique_attachment_temp("account-cas-clear-same-session");
    let path = dir.join("auth.json");
    write_session_tokens(&path, "session-s", "access-1", "refresh-1", 1);
    let (gate_rx, resume_tx) = pause_after_compare();
    let (base, server) = serve_routes(vec![("/auth/v1/token".into(), 400, r#"{"error":"invalid_grant"}"#)]);
    let refresh_path = path.clone();
    let refresh = std::thread::spawn(move || refresh_account_at(&refresh_path, &base, DEAD_ENTITLEMENT));
    gate_rx.recv().unwrap();
    write_session_tokens(&path, "session-s", "access-2", "refresh-2", 4_000_000_000);
    resume_tx.send(()).unwrap();
    let status = refresh.join().unwrap();
    server.join().unwrap();
    assert!(path.exists(), "a rotation of the same session must survive a dead R1");
    assert!(fs::read_to_string(&path).unwrap().contains("refresh-2"));
    assert!(status.signed_in, "the rotated credential is still live");
}

// The read that classifies a credential as corrupt happens before the lock. Atomic rename
// keeps another window's write whole, but it does not make read-then-lock atomic, so cleanup
// has to re-read under the lock and leave a valid pairing alone.
#[test]
fn corrupt_cleanup_leaves_a_valid_pairing_written_before_it_got_the_lock() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let dir = unique_attachment_temp("account-corrupt-replaced");
    let path = dir.join("auth.json");
    fs::create_dir_all(&dir).unwrap();
    fs::write(&path, b"{ not json").unwrap();
    let (gate_rx, resume_tx) = pause_after_compare();
    let read_path = path.clone();
    let reader = std::thread::spawn(move || account_status_from_path(&read_path));
    gate_rx.recv().unwrap();
    write_session_tokens(&path, "session-b", "access-b", "refresh-b", 4_000_000_000);
    resume_tx.send(()).unwrap();
    let status = reader.join().unwrap();
    assert!(path.exists(), "a valid pairing must survive cleanup of the corrupt bytes it replaced");
    assert!(status.signed_in, "and must be reported instead of Sign in");
    assert_eq!(status.email.as_deref(), Some("a@example.com"));
}

// Sign out follows the same rule: a pairing that landed while cleanup was taking the lock is a
// session the user just created, so report it instead of unlinking it.
#[test]
fn sign_out_reports_a_pairing_that_replaced_the_corrupt_bytes() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let dir = unique_attachment_temp("account-signout-corrupt-replaced");
    let path = dir.join("auth.json");
    fs::create_dir_all(&dir).unwrap();
    fs::write(&path, b"{ not json").unwrap();
    let (gate_rx, resume_tx) = pause_after_compare();
    let signout_path = path.clone();
    // The corrupt branch never reaches the network.
    let signout = std::thread::spawn(move || sign_out_at(&signout_path, DEAD_ENTITLEMENT));
    gate_rx.recv().unwrap();
    write_session_tokens(&path, "session-b", "access-b", "refresh-b", 4_000_000_000);
    resume_tx.send(()).unwrap();
    let result = signout.join().unwrap().unwrap();
    assert!(path.exists(), "a valid pairing must survive the corrupt-credential cleanup");
    assert!(result.signed_in, "preserving that pairing must not report signed out");
    assert_eq!(result.email.as_deref(), Some("a@example.com"));
}

// A cancelled attempt can be replaced in the slot while its own worker is still unwinding. A
// guard that cleared the slot blind would unregister the replacement, and Cancel sign-in would
// then silently do nothing for a pairing that is still live.
#[test]
fn a_dropped_guard_does_not_unregister_the_attempt_that_replaced_it() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let dir = unique_attachment_temp("account-guard-identity");
    let path = dir.join("auth.json");
    let first = begin_sign_in_attempt().unwrap();
    let guard = SignInGuard(first.clone());
    first.cancel();
    // The user clicks Sign in again before the cancelled attempt's worker has returned.
    let second = begin_sign_in_attempt().unwrap();
    drop(guard);
    cancel_sign_in_at(&path).expect("cancel must reach the registered attempt");
    assert!(second.is_cancelled(), "Cancel sign-in must still reach the live attempt");
    end_sign_in_attempt();
}
