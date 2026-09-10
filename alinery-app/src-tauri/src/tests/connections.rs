//! Tests for connections.rs provider status and network helpers.
use super::*;
use std::net::TcpListener;
use std::sync::mpsc;

#[test]
fn curl_request_times_out_after_server_accepts_without_responding() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (accepted_tx, accepted_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let (_stream, _) = listener.accept().unwrap();
        accepted_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(2));
    });

    let started = Instant::now();
    let error = curl_request_with_timeouts(&format!("http://{address}/stall"), &[], None, Duration::from_millis(100), Duration::from_millis(250)).unwrap_err();
    let elapsed = started.elapsed();

    accepted_rx.recv_timeout(Duration::from_secs(1)).expect("curl did not connect to the stalled server");
    let _ = release_tx.send(());
    server.join().unwrap();

    assert!(error.to_ascii_lowercase().contains("timed out"), "unexpected curl error: {error}");
    assert!(elapsed < Duration::from_secs(1), "curl exceeded its total timeout: {elapsed:?}");
}

#[test]
fn the_curl_http_returns_status_and_body_for_http_401() {
    use std::io::{Read, Write};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            let body = b"nope";
            let resp = format!("HTTP/1.1 401 Unauthorized\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            stream.write_all(resp.as_bytes()).unwrap();
            stream.write_all(body).unwrap();
        }
    });
    let url = format!("http://{address}/denied");
    let http = curl_http(&url, &[], None).unwrap();
    assert_eq!(http.status, 401);
    assert_eq!(http.body, b"nope");
    assert_eq!(curl_request(&url, &[], None).unwrap(), b"nope");
    server.join().unwrap();
}

// The invariant the whole split exists for, and the one a compiler cannot hold: everything that is
// not the parse must land on Transient, because Corrupt is what deletes the user's account label.
// Flip `impl From<String> for LinearTokenError` to Corrupt and one network blip demotes a healthy
// connection -- with this assert, that flip fails here instead of in front of a user.
// The wiring, not just the classification: imports.rs asks clears_account_label() before deleting
// the label. Swap what that answers and a Keychain or refresh failure starts demoting healthy
// connections -- silently, since no other test drives that arm.
#[test]
fn only_a_corrupt_credential_clears_the_account_label() {
    assert!(LinearTokenError::Corrupt("invalid Linear credential in Keychain: x".into()).clears_account_label());
    assert!(!LinearTokenError::Transient("Keychain read failed (-25308)".into()).clears_account_label());
    assert_eq!(LinearTokenError::Transient("curl: (28) timed out".into()).reason(), "curl: (28) timed out");
}

#[test]
fn every_error_but_the_parse_is_transient() {
    assert!(matches!(
        LinearTokenError::from("Keychain read failed (-25308)".to_string()),
        LinearTokenError::Transient(_)
    ));
    assert!(matches!(LinearTokenError::from("curl: (28) timed out".to_string()), LinearTokenError::Transient(_)));
}

// The status path reports Connected from the Keychain entry's mere existence, so an unparseable blob
// plus a leftover label renders a row with no Reconnect button. Guard both halves of the escape
// hatch: garbage classifies as Corrupt (never Transient, which must leave the label alone), and
// clearing removes the label the row was reading.
#[test]
fn unparseable_linear_credential_is_corrupt_and_clearing_removes_the_label() {
    assert!(matches!(parse_linear_oauth_tokens(b"not json"), Err(LinearTokenError::Corrupt(_))));
    assert!(parse_linear_oauth_tokens(br#"{"access_token":"a","refresh_token":"r","expires_at":1}"#).is_ok());

    let root = unique_attachment_temp("linear-account");
    let config_dir = root.join("ai.delegance.alinery");
    fs::create_dir_all(&config_dir).unwrap();
    let label = linear_account_path_in(&config_dir);
    fs::create_dir_all(label.parent().unwrap()).unwrap();
    fs::write(&label, "someone@example.com").unwrap();
    assert!(clear_linear_account_in(&config_dir));
    assert!(!label.exists());
    assert!(clear_linear_account_in(&config_dir)); // already gone is not an error
}

// The Keychain item is shared by every Alinery build on the machine. When the label was not, a
// reconnect from one build left the others naming the account they last saw: Settings said A while
// an import used B's token. One store, or the row identifies the wrong Linear workspace.
#[test]
fn every_build_reads_one_account_label() {
    let root = unique_attachment_temp("linear-identities");
    let production = root.join("ai.delegance.alinery");
    let development = root.join("ai.delegance.alinery.dev");
    fs::create_dir_all(&production).unwrap();
    fs::create_dir_all(&development).unwrap();

    assert_eq!(linear_account_path_in(&production), linear_account_path_in(&development));

    // A label written by the dev build is what production reads -- not its own stale copy.
    let shared = linear_account_path_in(&development);
    fs::create_dir_all(shared.parent().unwrap()).unwrap();
    fs::write(&shared, "b@example.com").unwrap();
    fs::write(production.join("linear-account"), "a@example.com").unwrap();
    assert_eq!(fs::read_to_string(linear_account_path_in(&production)).unwrap(), "b@example.com");

    // Only the current shared label is managed; obsolete files are not migrated or deleted.
    assert!(clear_linear_account_in(&production));
    assert!(!shared.exists());
    assert!(production.join("linear-account").exists());
}
