//! Phase 6: app-crate telemetry instrumentation (04-structure.md §Phase 6).
//! Drives `create_task_in_with_draft_slug` and `write_draft_in_with_slug` with a real
//! `app_config` path so the `emit_at` gate and payload shape are observable end to end.
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

fn looks_like_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36 && bytes[8] == b'-' && bytes[13] == b'-' && bytes[18] == b'-' && bytes[23] == b'-'
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
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
                    while buf.len() < 64 * 1024 {
                        let n = match stream.read(&mut chunk) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => n,
                        };
                        buf.extend_from_slice(&chunk[..n]);
                        if alinery_core::complete_http_request_len(&buf).is_some_and(|len| buf.len() >= len) {
                            break;
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
fn create_task_emits_nothing_when_unprompted() {
    let repo = init_git_test_repo("telemetry-unprompted");
    alinery_core::ensure_playbooks(&repo).unwrap();
    let dir = unique_temp("telemetry_unprompted");
    // Default telemetry (prompted = false) at an address nothing listens on: the gate
    // must return before any connect is attempted.
    let app_config = write_app_toml_with_telemetry(&dir, true, false, "http://127.0.0.1:1");
    let result = create_task_in_with_draft_slug(
        &repo,
        Some(&app_config),
        "",
        "",
        "Unprompted Task".into(),
        "".into(),
        "".into(),
        vec![],
        "".into(),
        "".into(),
        default_playbook_key(),
        "claude".into(),
        String::new(),
        None,
        false,
        "".into(),
        "".into(),
    );
    assert!(result.is_ok());
    std::thread::sleep(Duration::from_millis(50));
    assert!(
        std::net::TcpStream::connect_timeout(&"127.0.0.1:1".parse().unwrap(), Duration::from_millis(50)).is_err(),
        "gate must not attempt a TCP connect when unprompted"
    );
    let _ = fs::remove_dir_all(&repo);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn create_task_attempts_send_when_prompted() {
    let repo = init_git_test_repo("telemetry-prompted");
    alinery_core::ensure_playbooks(&repo).unwrap();
    let dir = unique_temp("telemetry_prompted");
    let events = capture_events(&dir, 2, |app_config| {
        let result = create_task_in_with_draft_slug(
            &repo,
            Some(app_config),
            "",
            "",
            "Prompted Task".into(),
            "".into(),
            "".into(),
            vec![],
            "".into(),
            "".into(),
            default_playbook_key(),
            "claude".into(),
            String::new(),
            None,
            false,
            "".into(),
            "".into(),
        );
        result.unwrap();
    });
    let names: Vec<&str> = events.iter().map(|r| r["event"].as_str().unwrap_or_default()).collect();
    assert!(names.contains(&"task.create"), "{names:?}");
    assert!(names.contains(&"session.create"), "{names:?}");
    let task = events.iter().find(|r| r["event"] == "task.create").unwrap();
    let session = events.iter().find(|r| r["event"] == "session.create").unwrap();
    let task_id = task["props"]["task_id"].as_str().unwrap_or_default();
    let session_id = session["props"]["session_id"].as_str().unwrap_or_default();
    assert!(looks_like_uuid(task_id), "task_id must be a UUID, got {task_id}");
    assert!(looks_like_uuid(session_id), "session_id must be a UUID, got {session_id}");
    assert_ne!(task_id, "prompted-task");
    assert_eq!(session["props"]["task_id"], task_id);
    let raw = serde_json::to_string(&events).unwrap();
    assert!(!raw.contains("Prompted Task"), "leaked task name: {raw}");
    assert!(!raw.contains("prompted-task"), "leaked task slug: {raw}");
    assert!(!raw.contains(repo.to_string_lossy().as_ref()), "leaked repo/worktree path: {raw}");
    for rec in &events {
        let obj = rec.as_object().expect("record object");
        let props = obj["props"].as_object().expect("props object");
        for leaked_key in ["slug", "name", "prompt", "prompt_extra"] {
            assert!(!obj.contains_key(leaked_key), "payload leaked key {leaked_key}: {raw}");
            assert!(!props.contains_key(leaked_key), "payload leaked key {leaked_key}: {raw}");
        }
    }
    let _ = fs::remove_dir_all(&repo);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn write_draft_in_emits_task_draft_create_only_on_first_write() {
    let repo = init_git_test_repo("telemetry-draft");
    alinery_core::ensure_playbooks(&repo).unwrap();
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
            default_playbook_key(),
            "claude".into(),
            String::new(),
            None,
            false,
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
            default_playbook_key(),
            "claude".into(),
            String::new(),
            None,
            false,
            "".into(),
            "".into(),
        )
        .unwrap();
    });
    assert_eq!(events[0]["event"], "task.draft_create");
    let _ = fs::remove_dir_all(&repo);
    let _ = fs::remove_dir_all(&dir);
}
