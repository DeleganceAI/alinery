//! Tests for provider_callback.rs: the loopback listener that receives a browser sign-in's redirect
//! when the daemon holding the credential is on another machine.
use super::*;
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

fn deadline_in(seconds: u64) -> Instant {
    Instant::now() + Duration::from_secs(seconds)
}

fn get(address: std::net::SocketAddr, target: &str) -> String {
    let mut stream = TcpStream::connect(address).expect("connect to the callback listener");
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let request = format!("GET {target} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

#[test]
fn the_redirect_url_is_the_loopback_origin_plus_the_target_verbatim() {
    assert_eq!(
        callback_url("GET /auth/callback?code=ac_2&state=s1&client_id=oaiapp HTTP/1.1", "http://127.0.0.1:1455", "/auth/callback").as_deref(),
        Some("http://127.0.0.1:1455/auth/callback?code=ac_2&state=s1&client_id=oaiapp")
    );
}

#[test]
fn only_our_own_path_is_the_callback() {
    // A sibling path, a longer path, another method: the browser asks for more than the redirect.
    for line in [
        "GET /auth/callback/extra?code=ac_2&state=s1 HTTP/1.1",
        "GET /favicon.ico HTTP/1.1",
        "POST /auth/callback?code=ac_2&state=s1 HTTP/1.1",
    ] {
        assert_eq!(callback_url(line, "http://127.0.0.1:1455", "/auth/callback"), None, "{line}");
    }
}

#[test]
fn only_the_redirect_itself_ends_the_wait() {
    // A page open in the browser can ask for the callback path with no query at all; the listener
    // must keep waiting for the redirect, which always carries `state` and a `code` or an `error`.
    for line in [
        "GET /auth/callback HTTP/1.1",
        "GET /auth/callback?code=ac_2 HTTP/1.1",
        "GET /auth/callback?state=s1 HTTP/1.1",
        "GET /auth/callback?client_id=oaiapp&code=ac_2 HTTP/1.1",
    ] {
        assert_eq!(callback_url(line, "http://127.0.0.1:1455", "/auth/callback"), None, "{line}");
    }
    assert_eq!(
        callback_url("GET /auth/callback?state=s1&error=access_denied HTTP/1.1", "http://127.0.0.1:1455", "/auth/callback").as_deref(),
        Some("http://127.0.0.1:1455/auth/callback?state=s1&error=access_denied"),
        "a refused approval redirects here too, and the daemon reports it"
    );
}

#[test]
fn only_the_runtimes_own_callback_ports_are_armed() {
    for (port, ok) in [(1455, true), (1456, true), (53692, true), (0, false), (8080, false), (65535, false)] {
        assert_eq!(validate_callback_target(port, "/auth/callback").is_ok(), ok, "port {port}");
    }
    for path in ["auth/callback", "/auth/callback?x=1", "/auth/callback#f"] {
        assert!(validate_callback_target(1455, path).is_err(), "path {path}");
    }
}

#[test]
fn the_browsers_redirect_is_delivered_and_answered_with_the_loopback_page() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let stop = AtomicBool::new(false);
    let waiter = std::thread::spawn(move || wait_for_provider_callback(listener, "/auth/callback", &stop, deadline_in(5)));
    let response = get(address, "/auth/callback?code=ac_2&state=s1&client_id=oaiapp");
    assert!(response.contains("Return to Alinery"), "unexpected page: {response}");
    let url = waiter.join().unwrap().expect("no listener error").expect("the callback was not delivered");
    assert_eq!(url, format!("http://127.0.0.1:{}/auth/callback?code=ac_2&state=s1&client_id=oaiapp", address.port()));
}

#[test]
fn another_request_is_answered_but_the_wait_continues() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let stop = AtomicBool::new(false);
    let waiter = std::thread::spawn(move || wait_for_provider_callback(listener, "/auth/callback", &stop, deadline_in(5)));
    get(address, "/favicon.ico");
    let response = get(address, "/auth/callback?code=ac_2&state=s1&client_id=oaiapp");
    assert!(response.contains("Return to Alinery"), "unexpected page: {response}");
    assert!(waiter.join().unwrap().unwrap().is_some(), "the redirect after an unrelated request was dropped");
}

#[test]
fn an_idle_connection_does_not_stall_the_redirect() {
    // Browsers (Chrome especially) open speculative connections that send nothing; the redirect
    // arriving behind one must still be read within its own read timeout, not the idle one's.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let stop = AtomicBool::new(false);
    let waiter = std::thread::spawn(move || wait_for_provider_callback(listener, "/auth/callback", &stop, deadline_in(5)));
    let _idle = TcpStream::connect(address).unwrap();
    let response = get(address, "/auth/callback?code=ac_2&state=s1");
    assert!(response.contains("Return to Alinery"), "unexpected page: {response}");
    let url = waiter.join().unwrap().unwrap().expect("the redirect behind an idle connection was not delivered");
    assert_eq!(url, format!("http://127.0.0.1:{}/auth/callback?code=ac_2&state=s1", address.port()));
}

#[test]
fn rearming_the_same_port_waits_for_the_disarmed_listener_to_let_go() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    std::thread::spawn(move || wait_for_provider_callback(listener, "/auth/callback", &flag, deadline_in(30)));
    // Disarm and re-bind in the same breath, the way a cancelled sign-in retried quickly does: the
    // old thread drops its listener only on its next poll, so the bind has to wait past that.
    stop.store(true, Ordering::SeqCst);
    bind_callback_listener(port).expect("the just-disarmed port was not given back");
}

#[test]
fn disarming_ends_the_wait_without_a_url() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let waiter = std::thread::spawn(move || wait_for_provider_callback(listener, "/auth/callback", &flag, deadline_in(30)));
    std::thread::sleep(Duration::from_millis(150));
    stop.store(true, Ordering::SeqCst);
    assert_eq!(waiter.join().unwrap().unwrap(), None, "a disarmed listener must not wait for the browser");
}

#[test]
fn an_armed_listener_gives_the_port_back_when_it_expires() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let stop = AtomicBool::new(false);
    assert_eq!(wait_for_provider_callback(listener, "/auth/callback", &stop, Instant::now()).unwrap(), None);
    // The next sign-in can bind the same port: the expired listener closed its socket.
    TcpListener::bind(address).expect("the expired listener still holds the port");
}
