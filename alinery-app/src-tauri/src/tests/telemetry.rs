//! Draft telemetry remains app-owned; executable provisioning telemetry is daemon-owned.
use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, SystemTime};

fn unique_temp(name: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("{name}_{}_{}", std::process::id(), nanos));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_app_toml_with_telemetry(dir: &Path, enabled: bool, prompted: bool, endpoint: &str) -> std::path::PathBuf {
    let app_config = dir.join("app.toml");
    let mut global = alinery_core::default_global_settings();
    global.telemetry.enabled = enabled;
    global.telemetry.prompted = prompted;
    global.telemetry.endpoint = endpoint.to_string();
    alinery_core::write_global_settings(&app_config, &global).unwrap();
    app_config
}

// Production emits each event on its own `record_event`-spawned thread and connection
// (never batched), so a round can produce more than one HTTP request. Accept connections
// until a quiet window passes with no new one, collecting every record.
fn serve_many(listener: TcpListener) -> std::thread::JoinHandle<Vec<serde_json::Value>> {
    std::thread::spawn(move || {
        listener.set_nonblocking(true).unwrap();
        let mut collected = Vec::new();
        let overall_deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut last_activity = std::time::Instant::now();
        let quiet = Duration::from_millis(300);
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 8192];
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
                    let read_deadline = std::time::Instant::now() + Duration::from_secs(3);
                    loop {
                        match stream.read(&mut chunk) {
                            Ok(0) => break,
                            Ok(n) => {
                                buf.extend_from_slice(&chunk[..n]);
                                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                    break;
                                }
                            }
                            Err(_) if std::time::Instant::now() < read_deadline => continue,
                            Err(_) => break,
                        }
                    }
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
                    let text = String::from_utf8_lossy(&buf);
                    let body = text.rsplit("\r\n\r\n").next().unwrap_or("");
                    if let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(body) {
                        collected.extend(items);
                    }
                    last_activity = std::time::Instant::now();
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if (!collected.is_empty() && last_activity.elapsed() > quiet) || std::time::Instant::now() > overall_deadline {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
        collected
    })
}

// ureq's shared global agent occasionally surfaces a transient send error under heavy
// parallel `cargo test --workspace` load (resource contention from unrelated concurrently
// running tests, not this test or the emitter itself) - retry the whole round on a fresh
// port until the expected record count shows up, matching `alinery-core::telemetry::tests`
// and `alineryd::telemetry`.
fn capture_events(dir: &Path, expected: usize, emit: impl Fn(&Path)) -> Vec<serde_json::Value> {
    let mut last: Vec<serde_json::Value> = Vec::new();
    for _ in 0..5 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = serve_many(listener);
        let app_config = write_app_toml_with_telemetry(dir, true, true, &format!("http://{addr}"));
        emit(&app_config);
        let events = handle.join().unwrap();
        if events.len() == expected {
            return events;
        }
        last = events;
    }
    panic!("capture_events: expected {expected} events, got {}: {last:?}", last.len());
}

#[test]
fn write_draft_in_emits_task_draft_create_only_on_first_write() {
    let repo = init_git_test_repo("telemetry-draft");
    let dir = unique_temp("telemetry_draft");
    let events = capture_events(&dir, 1, |app_config| {
        let draft = write_draft_in_with_slug(
            &repo,
            Some(app_config),
            "",
            "",
            "Draft Task".into(),
            "".into(),
            "".into(),
            "".into(),
            "".into(),
            alinery_core::playbook::PlaybookRef {
                scope: alinery_core::playbook::PlaybookScope::Bundled,
                key: "one-shot".into(),
            },
            "claude".into(),
            String::new(),
            None,
            10,
            "".into(),
            "".into(),
        );
        assert!(draft.is_ok(), "{draft:?}");
        // Re-saving the same draft must not re-emit: only the JSON array captured by the
        // listener above (the first write) is asserted on.
        let draft = draft.unwrap();
        write_draft_in_with_slug(
            &repo,
            Some(app_config),
            &draft.slug,
            "",
            "Draft Task".into(),
            "".into(),
            "".into(),
            "".into(),
            "".into(),
            alinery_core::playbook::PlaybookRef {
                scope: alinery_core::playbook::PlaybookScope::Bundled,
                key: "one-shot".into(),
            },
            "claude".into(),
            String::new(),
            None,
            10,
            "".into(),
            "".into(),
        )
        .unwrap();
    });
    assert_eq!(events[0]["event"], "task.draft_create");
    let _ = fs::remove_dir_all(&repo);
    let _ = fs::remove_dir_all(&dir);
}
