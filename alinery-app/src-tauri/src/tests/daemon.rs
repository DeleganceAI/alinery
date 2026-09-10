//! Tests for daemon.rs — lanes, ownership, protocol classification, quit/teardown latches
//!
//! `use super::*` reaches the shared imports and fixtures in tests/mod.rs.
use super::*;
use crate::{canonical_host_executable, DaemonClient, DaemonConflict};
use alinery_core::DaemonCompat;
use std::path::{Path, PathBuf};

#[test]
fn runtime_builder_exposes_opener_actions() {
    use tauri_plugin_opener::OpenerExt;

    let app = register_runtime_plugins(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("runtime plugins should initialize");
    let missing = std::env::temp_dir().join(format!("alinery-opener-smoke-{}", uuid::Uuid::new_v4()));

    app.opener()
        .reveal_item_in_dir(&missing)
        .expect_err("the registered reveal action should reject a missing path");
}

// B6/#132: the whole point of the GUI ownership lock — a second alinery opening the
// folder must be told "no", and must be let in the moment the first one lets go.
// Also pins the lock as *un*-namespaced: a debug build and a release build are two
// windows over one working tree, which is the case the user actually hits.
#[test]
fn second_app_cannot_claim_a_repo_the_first_one_owns() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-repo-claim-{n}"));
    fs::create_dir_all(repo.join(".alinery")).unwrap();

    let first = AppState::default();
    let second = AppState::default();
    assert!(first.claim_repo(&repo), "first app takes the free repo");
    assert!(first.claim_repo(&repo), "re-claiming our own repo is a no-op");
    assert!(!second.claim_repo(&repo), "second app must be refused");

    // The lock lives at the bare, non-namespaced path.
    assert!(repo.join(".alinery/.alinery-app.lock").exists());
    assert_eq!(alinery_app_lock_path(&repo), repo.join(".alinery/.alinery-app.lock"));

    // Opening another repo keeps both repositories owned by the first app.
    let other = repo.with_extension("other");
    fs::create_dir_all(other.join(".alinery")).unwrap();
    assert!(first.claim_repo(&other));
    assert!(first.owns_repo(&repo));
    assert!(first.owns_repo(&other));
    assert!(!second.claim_repo(&repo), "a known inactive repo must remain exclusive");

    // Refusing a busy addition must retain every repository we already own.
    first.release_repo(&repo);
    assert!(second.claim_repo(&repo));
    assert!(!first.claim_repo(&repo));
    assert!(first.owns_repo(&other));
    let contender = AppState::default();
    assert!(!contender.claim_repo(&other), "failed addition must not release existing repositories");

    // Explicit close-repo hands back only the repository being closed.
    second.release_repo(&repo);
    assert!(first.claim_repo(&repo));
    assert!(first.owns_repo(&other));

    // Backend gate: failed claim ⇒ require_repo_owned errs and attach is a no-op.
    let busy = AppState::default();
    assert!(!busy.claim_repo(&repo), "third app still refused while first holds");
    let err = require_repo_owned(&busy, &repo).expect_err("guest must not mutate");
    assert!(err.contains("repo-busy"), "unexpected error: {err}");
    assert!(!busy.owns_repo(&repo));
    // attach_repo_daemon must not record a Connected entry for a busy repo.
    attach_repo_daemon(&busy, &repo, &repo.join("app.toml"));
    assert!(busy.repo_daemon(&repo).is_none(), "guest must not adopt a Connected daemon for a busy repo");

    let _ = fs::remove_dir_all(&repo);
    let _ = fs::remove_dir_all(&other);
}

#[test]
fn repo_reservation_keeps_current_ownership_until_commit() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_nanos()).unwrap_or(0);
    let root = std::env::temp_dir().join(format!("alinery-repo-reservation-{n}"));
    let current = root.join("current");
    let candidate = root.join("candidate");
    fs::create_dir_all(current.join(".alinery")).unwrap();
    fs::create_dir_all(candidate.join(".alinery")).unwrap();

    let owner = AppState::default();
    let contender = AppState::default();
    assert!(owner.claim_repo(&current));

    let reservation = owner.reserve_repo(&candidate).expect("candidate lock is readable").expect("candidate is free");
    assert!(owner.owns_repo(&current));
    assert!(!contender.claim_repo(&candidate), "reservation must exclude another app before commit");

    drop(reservation);
    assert!(owner.owns_repo(&current));
    assert!(contender.claim_repo(&candidate), "dropping a reservation must release only the candidate");
    contender.release_repo(&candidate);

    let reservation = owner.reserve_repo(&candidate).expect("candidate lock is readable").expect("candidate is free again");
    reservation.commit(&owner);
    assert!(owner.owns_repo(&candidate));
    assert!(owner.owns_repo(&current), "committing another known repo must retain current ownership");
    assert!(!contender.claim_repo(&current), "the previous repo remains exclusive until explicitly closed");
    owner.release_repo(&current);
    assert!(contender.claim_repo(&current));

    let _ = fs::remove_dir_all(root);
}

// Finding 2: the post-spawn retry used to return `DaemonCompat::Current` "by
// construction", so two apps racing an empty socket let the loser adopt the winner's
// daemon with no `version` probe. Both branches now call `classify_connected_daemon`,
// whose decision is this pure function — exercised here with synthetic version replies.
#[test]
fn classify_version_rejects_a_foreign_protocol_on_either_branch() {
    let repo = Path::new("/tmp/alinery-classify-fixture");

    let foreign = crate::daemon_client::DaemonVersionReply {
        protocol: Some(PROTOCOL_VERSION.wrapping_add(99)),
        build_id: Some("theirs".into()),
        app_config_identity: Some("config".into()),
        host_guard_ready: Some(true),
    };
    let err = classify_version(&foreign, "ours", "config", repo, || 4).expect_err("a foreign protocol must never be adopted");
    match err {
        EnsureDaemonError::Mismatch(conflict) => {
            assert_eq!(conflict.daemon_protocol, foreign.protocol);
            assert_eq!(conflict.app_protocol, PROTOCOL_VERSION);
            assert_eq!(conflict.reason, "protocol");
            // The banner's loss-of-work warning must carry the real count.
            assert_eq!(conflict.live_sessions, 4);
            assert_eq!(conflict.repo, repo.display().to_string());
        }
        other => panic!("expected mismatch, got {other}"),
    }

    // A pre-gate daemon reports no `protocol` at all — also a mismatch, not a pass.
    assert!(classify_version(
        &crate::daemon_client::DaemonVersionReply {
            protocol: None,
            build_id: Some("pre-gate".into()),
            app_config_identity: Some("config".into()),
            host_guard_ready: None,
        },
        "ours",
        "config",
        repo,
        || 0,
    )
    .is_err());

    let wrong_config = crate::daemon_client::DaemonVersionReply {
        protocol: Some(PROTOCOL_VERSION),
        build_id: Some("ours".into()),
        app_config_identity: Some("other-config".into()),
        host_guard_ready: Some(true),
    };
    let err = classify_version(&wrong_config, "ours", "config", repo, || 3).expect_err("same protocol with another app config must be refused");
    match err {
        EnsureDaemonError::Mismatch(conflict) => {
            assert_eq!(conflict.reason, "app_config");
            assert_eq!(conflict.daemon_app_config_identity.as_deref(), Some("other-config"));
            assert_eq!(conflict.app_config_identity.as_deref(), Some("config"));
            assert_eq!(conflict.live_sessions, 3);
        }
        other => panic!("expected config mismatch, got {other}"),
    }

    // Matching hard gates admit it; build drift is a soft signal (A6), so a
    // differing build_id must NOT be rejected.
    let drifted = crate::daemon_client::DaemonVersionReply {
        protocol: Some(PROTOCOL_VERSION),
        build_id: Some("a-different-release".into()),
        app_config_identity: Some("config".into()),
        host_guard_ready: Some(true),
    };
    // Accepted replies must not pay the live-session count round trip.
    assert!(
        classify_version(&drifted, "ours", "config", repo, || {
            panic!("the accept path must not pay for a live-session round trip")
        })
        .is_ok(),
        "protocol and app-config identity match; build drift is a soft signal"
    );
}

#[test]
fn effective_identifier_alone_selects_the_daemon_lane() {
    let alineryd = std::path::PathBuf::from("/tmp/alinery-lane-fixture/alineryd");
    assert!(
        alineryd_socket_namespace_for(alinery_core::DEVELOPMENT_APP_IDENTIFIER, alineryd.clone()).is_some(),
        "development uses a namespaced lane in every compiler profile"
    );
    assert_eq!(
        alineryd_socket_namespace_for(alinery_core::PRODUCTION_APP_IDENTIFIER, alineryd.clone()),
        None,
        "production always uses the bare lane"
    );
    assert_eq!(alineryd_socket_namespace_for("ai.delegance.alinery.unknown", alineryd), None);
}

fn recording_lane(socket_path: std::path::PathBuf, live_sessions: usize) -> (std::sync::Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>) {
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixListener;

    let listener = UnixListener::bind(&socket_path).unwrap();
    listener.set_nonblocking(true).unwrap();
    let requests = std::sync::Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let handle = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut line = String::new();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        continue;
                    }
                    let request: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
                    let op = request.get("op").and_then(serde_json::Value::as_str).unwrap().to_string();
                    recorded.lock().unwrap_or_else(|error| error.into_inner()).push(op.clone());
                    let response = match op.as_str() {
                        "list" => serde_json::json!({
                            "sessions": (0..live_sessions)
                                .map(|index| serde_json::json!({
                                    "id": format!("live-{index}"),
                                    "process": {"state": "alive"},
                                    "agent": {"state": "unknown"},
                                    "playbook": {"state": "in_progress"},
                                    "adapter": "unsupported",
                                    "message_adapter": "unsupported",
                                    "transport": "pty",
                                }))
                                .collect::<Vec<_>>(),
                        }),
                        "version" => serde_json::json!({
                            "protocol": PROTOCOL_VERSION,
                            "build_id": "fixture",
                            "app_config_identity": "fixture",
                        }),
                        "shutdown" => serde_json::json!({"ok": true}),
                        other => panic!("unexpected daemon request: {other}"),
                    };
                    writeln!(stream, "{response}").unwrap();
                    stream.flush().unwrap();
                    if op == "shutdown" {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("lane listener failed: {error}"),
            }
        }
        drop(listener);
        let _ = fs::remove_file(socket_path);
    });
    (requests, handle)
}

#[test]
fn app_lifecycle_targets_the_namespaced_lane_not_production() {
    let repo = activity_repo("app-lifecycle-lane");
    let production_path = alinery_core::alineryd_socket_path(&repo, None);
    let current_path = current_alineryd_socket_path(&repo);
    assert_ne!(current_path, production_path, "app tests must exercise the development namespace");

    let (production_requests, production) = recording_lane(production_path.clone(), 7);
    let (current_requests, current) = recording_lane(current_path.clone(), 2);

    let live_sessions = crate::repo_live_sessions(repo.display().to_string());
    let version = crate::connect_current_daemon(&repo).expect("poller probe must connect to the current lane").version();
    assert_eq!(version.protocol, Some(PROTOCOL_VERSION));
    let state = AppState::default();
    crate::close_repo_daemon(&state, &repo).expect("close must stop and wait for the app's current lane");

    let production_before_cleanup = production_requests.lock().unwrap_or_else(|error| error.into_inner()).clone();
    let current_before_cleanup = current_requests.lock().unwrap_or_else(|error| error.into_inner()).clone();

    for path in [&production_path, &current_path] {
        if let Ok(client) = crate::DaemonClient::connect_path_checked(path.clone()) {
            let _ = client.call(&crate::daemon_client::shutdown_request());
        }
    }
    production.join().unwrap();
    current.join().unwrap();
    let _ = fs::remove_dir_all(repo);

    assert_eq!(live_sessions, 2, "loss-of-work counts must describe the current app lane");
    assert!(current_before_cleanup.iter().any(|op| op == "list"), "live count must query the current lane");
    assert!(current_before_cleanup.iter().any(|op| op == "version"), "poller probe must query the current lane");
    assert!(current_before_cleanup.iter().any(|op| op == "shutdown"), "close must stop the current lane");
    assert!(
        !production_before_cleanup.iter().any(|op| op == "list" || op == "version" || op == "shutdown"),
        "app lifecycle operations must not query or stop the production lane: {production_before_cleanup:?}"
    );
}

// Finding 3 follow-up: `begin` refuses a second claim, so any `?` between claim and
// release wedges the repo's backup/restore slot for the life of the process. The
// guard must release on the error paths too, not just the happy one.
#[test]
fn backup_slot_is_released_on_every_exit_path() {
    let key = format!("alinery-slot-{}", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    assert!(!backup_queue_lock().busy(&key));

    // Scope that returns early, exactly like restore_backup's ownership refusal.
    let bail = |k: &str| -> Result<(), String> {
        let _slot = BackupSlot::claim(k.to_string()).ok_or("already running")?;
        Err("repo-busy: another Alinery window holds it".into())
    };
    assert!(bail(&key).is_err());
    assert!(!backup_queue_lock().busy(&key), "an early return must not wedge the slot");

    // And the slot is genuinely exclusive while held.
    let held = BackupSlot::claim(key.clone()).expect("free slot claims");
    assert!(backup_queue_lock().busy(&key));
    assert!(BackupSlot::claim(key.clone()).is_none(), "a second claim must be refused while one is held");
    drop(held);
    assert!(!backup_queue_lock().busy(&key));
}

// Finding 1 follow-up: remove_repo/close_all_repos shut a daemon down, which is the
// owning window's call. A guest must be refused before it reaches close_repo_daemon.
#[test]
fn a_guest_alinery_cannot_tear_down_the_owners_repo() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-guest-teardown-{n}"));
    fs::create_dir_all(repo.join(".alinery")).unwrap();

    let owner = AppState::default();
    let guest = AppState::default();
    assert!(owner.claim_repo(&repo));
    assert!(!guest.claim_repo(&repo));

    // The gate remove_repo applies before it ever calls close_repo_daemon.
    assert!(require_repo_owned(&guest, &repo).is_err());
    // The owner is of course allowed.
    assert!(require_repo_owned(&owner, &repo).is_ok());
    // …and the shared probe agrees without stealing the lock: the owner still holds it.
    assert!(gui_lock_held_elsewhere(&repo));
    assert!(owner.owns_repo(&repo), "probing must not evict the owner");

    // A free known repo is claimed and retained before it may be mutated.
    let free = repo.with_extension("free");
    fs::create_dir_all(free.join(".alinery")).unwrap();
    assert!(require_repo_owned(&guest, &free).is_ok());
    assert!(guest.owns_repo(&free));
    assert!(gui_lock_held_elsewhere(&free));

    let _ = fs::remove_dir_all(&repo);
    let _ = fs::remove_dir_all(&free);
}

#[test]
fn wait_for_daemon_gone_ok_when_socket_quiet() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-wait-gone-{n}"));
    fs::create_dir_all(repo.join(".alinery")).unwrap();
    // No listener ⇒ connect fails immediately ⇒ Ok.
    wait_for_daemon_gone(&repo).expect("quiet socket is success");
    let _ = fs::remove_dir_all(&repo);
}

// T2.1: pins the one behavior change with no branch of its own but a concrete,
// checkable postcondition — every `send()` must set both timeouts before `write_all`.
#[test]
fn daemon_client_send_sets_the_control_timeout() {
    use std::os::unix::net::UnixListener;
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let sock = std::env::temp_dir().join(format!("alinery-t21-{n}.sock"));
    let listener = UnixListener::bind(&sock).unwrap();
    let accept_thread = std::thread::spawn(move || {
        // Accept once and just hold the stream open — the assertion is entirely client-side.
        let (stream, _) = listener.accept().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        drop(stream);
    });
    let client = crate::DaemonClient::connect_path(sock.clone()).unwrap();
    let stream = client.send(&serde_json::json!({"op": "status"})).expect("send");
    assert_eq!(stream.read_timeout().unwrap(), Some(crate::DAEMON_CONTROL_TIMEOUT));
    assert_eq!(stream.write_timeout().unwrap(), Some(crate::DAEMON_CONTROL_TIMEOUT));
    drop(stream);
    accept_thread.join().unwrap();
    let _ = fs::remove_file(&sock);
}

// T2.2: the branch — `Closed` vs. `TimedOut` must no longer collapse into the same `None`.
#[test]
fn read_socket_line_distinguishes_timeout_from_closed() {
    use std::os::unix::net::UnixListener;
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);

    // Sub-case 1: peer closes without writing anything.
    let closed_sock = std::env::temp_dir().join(format!("alinery-t22-closed-{n}.sock"));
    let listener = UnixListener::bind(&closed_sock).unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        drop(stream);
    });
    let mut client_stream = std::os::unix::net::UnixStream::connect(&closed_sock).unwrap();
    server.join().unwrap();
    assert_eq!(crate::read_socket_line(&mut client_stream), Err(crate::SocketReadError::Closed));
    let _ = fs::remove_file(&closed_sock);

    // Sub-case 2: peer accepts and never writes, with a short read timeout — not the real
    // 100s constant.
    let hang_sock = std::env::temp_dir().join(format!("alinery-t22-hang-{n}.sock"));
    let listener = UnixListener::bind(&hang_sock).unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        drop(stream);
    });
    let mut client_stream = std::os::unix::net::UnixStream::connect(&hang_sock).unwrap();
    client_stream.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
    assert_eq!(crate::read_socket_line(&mut client_stream), Err(crate::SocketReadError::TimedOut));
    server.join().unwrap();
    let _ = fs::remove_file(&hang_sock);
}

// T2.3: integration-level — proves the message text callers see actually distinguishes
// the two cases, not just the low-level read.
#[test]
fn call_reports_daemon_not_responding_on_a_real_timeout() {
    use std::os::unix::net::UnixListener;
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);

    // Peer accepts and never writes: call_with_timeout with a short timeout must report
    // "not responding", never "closed".
    let hang_sock = std::env::temp_dir().join(format!("alinery-t23-hang-{n}.sock"));
    let listener = UnixListener::bind(&hang_sock).unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        drop(stream);
    });
    let client = crate::DaemonClient::connect_path(hang_sock.clone()).unwrap();
    let err = client
        .call_with_timeout(&serde_json::json!({"op": "status"}), Duration::from_millis(50))
        .expect_err("must time out");
    // Exact match, not a substring: `as_secs()` truncation used to report "0s" here for any
    // sub-second timeout, which would also satisfy a loose "not responding" substring check.
    assert_eq!(err, "daemon not responding after 50ms");
    server.join().unwrap();
    let _ = fs::remove_file(&hang_sock);

    // Companion case: peer closes instead of hanging — message contains "daemon closed".
    let closed_sock = std::env::temp_dir().join(format!("alinery-t23-closed-{n}.sock"));
    let listener = UnixListener::bind(&closed_sock).unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        // Consume the request so the client's write_all/flush succeeds before we close —
        // otherwise the client can observe a write-side broken pipe instead of the
        // read-side "closed" this case is meant to pin.
        let mut buf = [0u8; 256];
        let _ = std::io::Read::read(&mut stream, &mut buf);
        drop(stream);
    });
    let client = crate::DaemonClient::connect_path(closed_sock.clone()).unwrap();
    let err = client
        .call_with_timeout(&serde_json::json!({"op": "status"}), Duration::from_millis(500))
        .expect_err("must report closed");
    assert!(err.contains("daemon closed"), "unexpected message: {err}");
    server.join().unwrap();
    let _ = fs::remove_file(&closed_sock);
}

// Pins the formatter's two branches against the codebase's only two timeout values, cheaply
// (no socket, no sleep) — the review-4 fix: DAEMON_OBSERVATION_TIMEOUT (250ms) used to render
// as "0s" via `as_secs()`; DAEMON_CONTROL_TIMEOUT (100s) wording must stay unchanged.
#[test]
fn format_daemon_timeout_pairs() {
    assert_eq!(crate::format_daemon_timeout(crate::DAEMON_OBSERVATION_TIMEOUT), "250ms");
    assert_eq!(crate::format_daemon_timeout(crate::DAEMON_CONTROL_TIMEOUT), "100s");
}

// The quit dialog's "close all repos" is only worth anything if nothing brings the
// daemons back in the seconds before the window is destroyed. `attach_repo_daemon` is
// the single bring-up path (poller, footer poll, every command), so the latch is
// pinned there: with it set, the call must return without spawning anything.
#[test]
fn quitting_stops_every_daemon_bring_up() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-quit-latch-{n}"));
    fs::create_dir_all(repo.join(".alinery")).unwrap();

    let state = AppState::default();
    assert!(!state.is_quitting());
    state.begin_quit();
    assert!(state.is_quitting());

    let started = Instant::now();
    attach_repo_daemon(&state, &repo, &repo.join("app.toml"));
    // No handle recorded, no conflict recorded, and no socket on disk: the spawn path
    // was never entered (it would also have burned its ~2s connect-retry window).
    assert!(state.repo_daemon(&repo).is_none(), "no daemon may be attached while quitting");
    assert!(!current_alineryd_socket_path(&repo).exists(), "no daemon may be spawned while quitting");
    assert!(started.elapsed() < Duration::from_millis(500), "returned before any spawn attempt");

    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn close_all_freezes_every_repository_acknowledgment_before_teardown() {
    let first = activity_repo("quit-plan-first");
    let second = activity_repo("quit-plan-second");
    write_status_session(&first, "task", "first-live", "implementation", "", Some(10), None, None, "");
    write_status_session(&second, "task", "second-before", "implementation", "", Some(10), None, None, "");

    let plan = crate::close_repo_acknowledgment_plan(&[first.clone(), second.clone()]);
    let (closed, errors) = crate::execute_close_repo_acknowledgment_plan(&plan, |repo| {
        let stop = |repo: &Path, id: &str, ended_at: u64| {
            let path = session_meta_path(repo, "task", id);
            let mut meta: SessionMeta = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            meta.ended_at = Some(ended_at);
            meta.exit_code = Some(143);
            fs::write(path, serde_json::to_vec(&meta).unwrap()).unwrap();
        };
        if repo == first {
            stop(&first, "first-live", 20);
            stop(&second, "second-before", 20);
            write_status_session(&second, "task", "second-after", "implementation", "", Some(30), None, None, "");
        } else {
            stop(&second, "second-after", 40);
        }
        Ok(())
    });

    assert_eq!(closed, vec![first.clone(), second.clone()]);
    assert!(errors.is_empty());
    let before: SessionMeta = serde_json::from_str(&fs::read_to_string(session_meta_path(&second, "task", "second-before")).unwrap()).unwrap();
    let after: SessionMeta = serde_json::from_str(&fs::read_to_string(session_meta_path(&second, "task", "second-after")).unwrap()).unwrap();
    assert_eq!(before.exit_notification_read_at, Some(20));
    assert_eq!(after.exit_notification_read_at, None);

    let _ = fs::remove_dir_all(first);
    let _ = fs::remove_dir_all(second);
}

/// Re-review finding 7. A partial `close_all_repos` can be cancelled back into the
/// window, and the latch has to come off with it — otherwise the user returns to an
/// app that can no longer attach or poll, i.e. cannot act on the very sessions the
/// error told them were still running.
#[test]
fn cancelling_a_failed_quit_restores_daemon_bring_up() {
    let state = AppState::default();
    state.begin_quit();
    assert!(state.is_quitting());

    state.cancel_quit();
    assert!(!state.is_quitting(), "cancelling a quit must clear the latch");

    // The latch is the only thing `attach_repo_daemon` consults before the ownership
    // check, so clearing it is what re-opens the bring-up path.
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-quit-cancel-{n}"));
    fs::create_dir_all(repo.join(".alinery")).unwrap();
    assert!(!state.is_closing(&repo));
    let _ = fs::remove_dir_all(&repo);
}

/// Re-review finding 8. `close_repo_daemon` shuts the daemon down and then waits for
/// the socket to vanish — a gap in which the repo is still listed and answers nothing,
/// which is exactly what the poller treats as "it died, respawn it". The closing set
/// is what tells the two apart, so it must be visible to `attach_repo_daemon` for the
/// whole teardown and released afterwards even when teardown fails.
#[test]
fn a_repo_being_closed_is_not_respawned_by_attach() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-closing-{n}"));
    fs::create_dir_all(repo.join(".alinery")).unwrap();

    let state = AppState::default();
    assert!(!state.is_closing(&repo));

    {
        let _closing = state.mark_closing(&repo);
        assert!(state.is_closing(&repo));

        let started = Instant::now();
        attach_repo_daemon(&state, &repo, &repo.join("app.toml"));
        assert!(state.repo_daemon(&repo).is_none(), "a repo being closed must not have a daemon attached");
        assert!(!current_alineryd_socket_path(&repo).exists(), "a repo being closed must not have a daemon spawned");
        assert!(started.elapsed() < Duration::from_millis(500), "returned before any spawn attempt");
    }

    // Guard dropped: teardown is over and the repo is attachable again. A set that
    // leaked here would silently make the repo un-reopenable for the process lifetime.
    assert!(!state.is_closing(&repo), "the closing mark must be released when teardown ends");

    let _ = fs::remove_dir_all(&repo);
}

/// `remove_repo` marks the repo closing and then calls `close_repo_daemon`, which
/// marks it again. Only the outer guard may clear it — if the inner one did, the mark
/// would come off while `remove_repo` was still mid-delist, reopening the exact window
/// the outer guard is held to cover.
#[test]
fn nested_closing_guards_release_only_at_the_outermost_scope() {
    let repo = std::path::PathBuf::from("/tmp/alinery-nested-closing");
    let state = AppState::default();

    let outer = state.mark_closing(&repo);
    {
        let _inner = state.mark_closing(&repo);
        assert!(state.is_closing(&repo));
    }
    assert!(state.is_closing(&repo), "an inner guard going out of scope must not release the outer scope's mark");

    drop(outer);
    assert!(!state.is_closing(&repo));
}

#[test]
fn daemon_build_identity_depends_on_content_not_file_metadata() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_nanos()).unwrap_or(0);
    let root = std::env::temp_dir().join(format!("alinery-build-id-{n}"));
    fs::create_dir_all(&root).unwrap();
    let first = root.join("first");
    let second = root.join("second");
    fs::write(&first, b"same daemon bytes").unwrap();
    fs::write(&second, b"same daemon bytes").unwrap();

    assert_eq!(file_content_id(&first), file_content_id(&second));
    fs::write(&second, b"different daemon bytes").unwrap();
    assert_ne!(file_content_id(&first), file_content_id(&second));

    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn detached_process_starts_a_new_os_session() {
    extern "C" {
        fn getpgid(pid: i32) -> i32;
        fn getsid(pid: i32) -> i32;
    }

    let mut command = Command::new("/bin/sleep");
    command.arg("10");
    configure_detached_process(&mut command);
    let mut child = command.spawn().expect("spawn detached probe");
    let pid = child.id() as i32;

    assert_eq!(unsafe { getpgid(pid) }, pid, "child must lead its process group");
    assert_eq!(unsafe { getsid(pid) }, pid, "child must lead a new OS session");

    child.kill().expect("kill detached probe");
    child.wait().expect("reap detached probe");
}

#[test]
fn t8_list_alineryd_lane_sockets_counts() {
    use std::os::unix::net::UnixListener;
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let root = std::path::PathBuf::from("/tmp").join(format!("alinery-t8-{n}"));
    let alinery = root.join(".alinery");
    fs::create_dir_all(&alinery).unwrap();
    // Live foreign socket
    let live = alinery.join("alineryd-live.sock");
    let _listener = UnixListener::bind(&live).unwrap();
    // Stale foreign socket (bind then drop)
    let stale = alinery.join("alineryd-stale.sock");
    {
        let l = UnixListener::bind(&stale).unwrap();
        drop(l);
    }
    // Own prod socket path present but we just list
    let prod = alinery.join("alineryd.sock");
    let _prod = UnixListener::bind(&prod).unwrap();

    let lanes = alinery_core::list_alineryd_lane_sockets(&root);
    assert!(lanes.iter().any(|(ns, _)| ns == "live"));
    assert!(lanes.iter().any(|(ns, _)| ns == "stale"));
    assert!(lanes.iter().any(|(ns, _)| ns.is_empty()));

    // Connect probe: live answers, stale refuses
    assert!(std::os::unix::net::UnixStream::connect(&live).is_ok());
    assert!(std::os::unix::net::UnixStream::connect(&stale).is_err());

    drop(_listener);
    drop(_prod);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn t6_route_socket_path_table() {
    let repo = std::path::Path::new("/tmp/alinery-route-test-repo");
    // own empty (prod) + meta empty → own
    assert!(route_socket_path(repo, "", "").is_none());
    // own dev + meta same → own
    assert!(route_socket_path(repo, "dabc", "dabc").is_none());
    // own prod + meta foreign → foreign socket
    let p = route_socket_path(repo, "", "dabc").expect("foreign");
    assert!(p.ends_with("alineryd-dabc.sock"));
    // own foreign + meta prod → prod socket
    let p = route_socket_path(repo, "dabc", "").expect("prod");
    assert!(p.ends_with("alineryd.sock"));
    // own a + meta b → b
    let p = route_socket_path(repo, "a", "b").expect("b");
    assert!(p.ends_with("alineryd-b.sock"));
}

/// T0-4: namespaced cleanup must delete only that lane's status+socket.
#[test]
fn remove_mcp_lane_runtime_files_own_lane_only() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let root = std::env::temp_dir().join(format!("alinery-t0-4-mcp-{n}"));
    let alinery = root.join(".alinery");
    fs::create_dir_all(&alinery).unwrap();

    let prod_status = alinery.join("mcp.status.json");
    let prod_sock = alinery.join("mcp.sock");
    let dev_status = alinery.join("mcp-dabc.status.json");
    let dev_sock = alinery.join("mcp-dabc.sock");
    for p in [&prod_status, &prod_sock, &dev_status, &dev_sock] {
        fs::write(p, b"x").unwrap();
    }

    let (got_status, got_sock) = remove_mcp_lane_runtime_files(&root, Some("dabc"));
    assert!(got_status.ends_with("mcp-dabc.status.json"), "status path {:?}", got_status);
    assert!(got_sock.ends_with("mcp-dabc.sock"), "sock path {:?}", got_sock);

    assert!(!dev_status.exists(), "namespaced status must be removed");
    assert!(!dev_sock.exists(), "namespaced socket must be removed");
    assert!(prod_status.exists(), "prod status must be left untouched");
    assert!(prod_sock.exists(), "prod socket must be left untouched");

    // Prod lane targets only the un-namespaced pair.
    fs::write(&dev_status, b"x").unwrap();
    fs::write(&dev_sock, b"x").unwrap();
    let _ = remove_mcp_lane_runtime_files(&root, None);
    assert!(!prod_status.exists(), "prod status removed when ns=None");
    assert!(!prod_sock.exists(), "prod socket removed when ns=None");
    assert!(dev_status.exists(), "dev status preserved on prod cleanup");
    assert!(dev_sock.exists(), "dev socket preserved on prod cleanup");

    let _ = fs::remove_dir_all(&root);
}
#[test]
fn daemon_list_parser_rejects_old_scalar_status() {
    // Post-cutover: the scalar-only format (no process/agent/playbook axes) must fail.
    let result = crate::daemon_client::parse_list_reply(&serde_json::json!({
        "sessions": [
            {"id": "running-id", "status": "running"},
            {"id": "idle-id", "status": "idle"},
            {"id": "exited-id", "status": "exited"}
        ]
    }));
    assert!(result.is_err(), "stale scalar-only response must be rejected, not coerced");
}

#[test]
fn daemon_list_parser_accepts_structured_axes() {
    let sessions = crate::daemon_client::parse_list_reply(&serde_json::json!({
        "sessions": [{
            "id": "omp-id",
            "process": {"state": "alive"},
            "agent": {"state": "waiting_for_approval", "correlation_id": "call-1"},
            "playbook": {"state": "in_progress"},
            "adapter": "omp",
            "message_adapter": "omp_bracketed_paste",
            "transport": "pty"
        }]
    }))
    .expect("structured daemon session list should parse");

    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, "omp-id");
    assert_eq!(sessions[0].state.process, alinery_core::ProcessState::Alive);
    assert_eq!(sessions[0].state.agent, alinery_core::AgentState::WaitingForApproval { correlation_id: "call-1".into() });
    assert_eq!(sessions[0].state.adapter, alinery_core::HarnessAdapter::Omp);
    assert_eq!(sessions[0].state.message_adapter, alinery_core::MessageAdapter::OmpBracketedPaste);
    assert_eq!(sessions[0].transport, alinery_core::SessionTransport::Pty);
}

#[test]
fn daemon_list_parser_rejects_missing_transport() {
    let result = crate::daemon_client::parse_list_reply(&serde_json::json!({
        "sessions": [{
            "id": "omp-id",
            "process": {"state": "alive"},
            "agent": {"state": "waiting_for_approval", "correlation_id": "call-1"},
            "playbook": {"state": "in_progress"},
            "adapter": "omp",
            "message_adapter": "omp_bracketed_paste"
        }]
    }));
    assert!(result.is_err(), "missing transport must not default to pty");
}

#[test]
fn daemon_status_parser_requires_transport() {
    let result = crate::daemon_client::parse_status_reply(&serde_json::json!({
        "process": {"state": "alive"},
        "agent": {"state": "idle"},
        "playbook": {"state": "in_progress"},
        "adapter": "omp",
        "message_adapter": "omp_bracketed_paste"
    }));
    assert!(result.is_err(), "missing transport must not default to pty");
}

#[test]
fn daemon_status_parser_unknown_session_is_none() {
    let result = crate::daemon_client::parse_status_reply(&serde_json::json!({"error": "unknown-session"}));
    assert_eq!(result, Ok(None));
}

#[test]
fn daemon_status_parser_rpc() {
    let live = crate::daemon_client::parse_status_reply(&serde_json::json!({
        "process": {"state": "alive"},
        "agent": {"state": "idle"},
        "playbook": {"state": "in_progress"},
        "adapter": "omp",
        "message_adapter": "omp_bracketed_paste",
        "transport": "rpc"
    }))
    .expect("rpc status should parse")
    .expect("owned session");
    assert_eq!(live.transport, alinery_core::SessionTransport::Rpc);
    assert_eq!(live.state.process, alinery_core::ProcessState::Alive);
}

/// Re-review finding 2. `connect_path_checked` proves a socket accepted a connection,
/// nothing more. A foreign lane (dev namespace, or a session left by an older build)
/// can be perfectly reachable while speaking a protocol this app does not — and until
/// now that client was cached unclassified, so `open_session(attach)` and every
/// subsequent write/resize/detach for that session id spoke the current wire at it.
/// The `ensure_daemon` paths were gated; this route went around them.
#[test]
fn a_reachable_foreign_daemon_on_another_protocol_is_refused_and_never_cached() {
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo = activity_repo("fpr");
    let own_ns = crate::alineryd_socket_namespace().unwrap_or_default();
    let lane = "badp";
    write_status_session(&repo, "task", "foreign-session", "implement", lane, Some(1), None, None, "");

    // Live, answering, and speaking a protocol we do not.
    let socket = status_list_socket(
        crate::route_socket_path(&repo, &own_ns, lane).unwrap(),
        Some(&format!(
            "{{\"protocol\":{},\"build_id\":\"theirs\",\"app_config_identity\":\"config\"}}\n",
            alinery_core::PROTOCOL_VERSION.wrapping_add(41)
        )),
    );

    set_active_repo_global(Some(repo.clone())).unwrap();
    let state = crate::AppState::default();
    state.set_daemon(
        &repo,
        crate::DaemonClient::connect_path(crate::current_alineryd_socket_path(&repo)).unwrap(),
        alinery_core::DaemonCompat::Current,
        "config".into(),
        false,
    );

    let err = match crate::client_for_session(&state, &repo, "task", "foreign-session") {
        Err(e) => e,
        Ok(_) => panic!("a foreign daemon on another protocol must not be handed out"),
    };
    assert!(err.contains("repo-protocol-mismatch"), "the refusal must name the protocol conflict, got: {err}");
    // Specifically the foreign protocol it *reported* — not `None`. A stub whose
    // listener has died also produces a mismatch, which would pass the assertion
    // above while proving nothing about classification.
    assert!(
        err.contains(&format!("{:?}", Some(alinery_core::PROTOCOL_VERSION.wrapping_add(41)))),
        "must have actually read the daemon's version reply, got: {err}"
    );
    assert!(
        state.session_routes.lock().unwrap_or_else(|e| e.into_inner()).is_empty(),
        "an unclassified foreign client must never reach the route cache — \
         caching it is what let write/resize/detach reuse it afterwards"
    );

    set_active_repo_global(None).unwrap();
    let _ = socket.join();
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn a_reachable_foreign_daemon_with_another_app_config_is_refused_and_never_cached() {
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo = activity_repo("fac");
    let own_ns = crate::alineryd_socket_namespace().unwrap_or_default();
    let lane = "different-config";
    write_status_session(&repo, "task", "foreign-config-session", "implement", lane, Some(1), None, None, "");
    let socket = status_list_socket(
        crate::route_socket_path(&repo, &own_ns, lane).unwrap(),
        Some(&format!(
            "{{\"protocol\":{},\"build_id\":\"ours\",\"app_config_identity\":\"other-config\"}}\n",
            alinery_core::PROTOCOL_VERSION
        )),
    );

    set_active_repo_global(Some(repo.clone())).unwrap();
    let state = crate::AppState::default();
    state.set_daemon(
        &repo,
        crate::DaemonClient::connect_path(crate::current_alineryd_socket_path(&repo)).unwrap(),
        alinery_core::DaemonCompat::Current,
        "config".into(),
        false,
    );

    let err = match crate::client_for_session(&state, &repo, "task", "foreign-config-session") {
        Err(error) => error,
        Ok(_) => panic!("a foreign daemon with another app config must not be handed out"),
    };
    assert!(err.contains("repo-app-config-mismatch"), "the refusal must name the config conflict, got: {err}");
    assert!(
        state.session_routes.lock().unwrap_or_else(|e| e.into_inner()).is_empty(),
        "an app-config-mismatched client must never reach the route cache"
    );

    set_active_repo_global(None).unwrap();
    assert!(socket.join().unwrap() >= 2);
    let _ = fs::remove_dir_all(repo);
}

/// The same route with a *compatible* foreign daemon still works — the gate must not
/// have cost us cross-lane routing, which is the whole point of `session_routes`.
#[test]
fn a_reachable_foreign_daemon_on_our_protocol_is_cached_and_used() {
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo = activity_repo("fpo");
    let own_ns = crate::alineryd_socket_namespace().unwrap_or_default();
    let lane = "okp";
    write_status_session(&repo, "task", "ok-session", "implement", lane, Some(1), None, None, "");

    let socket_path = crate::route_socket_path(&repo, &own_ns, lane).unwrap();
    let socket = status_list_socket(
        socket_path.clone(),
        Some(&format!(
            "{{\"protocol\":{},\"build_id\":\"theirs\",\"app_config_identity\":\"config\"}}\n",
            alinery_core::PROTOCOL_VERSION
        )),
    );

    set_active_repo_global(Some(repo.clone())).unwrap();
    let state = crate::AppState::default();
    state.set_daemon(
        &repo,
        crate::DaemonClient::connect_path(crate::current_alineryd_socket_path(&repo)).unwrap(),
        alinery_core::DaemonCompat::Current,
        "config".into(),
        false,
    );

    let client = crate::client_for_session(&state, &repo, "task", "ok-session").expect("a compatible foreign daemon is still routable");
    assert_eq!(client.socket_path, socket_path, "must route to the foreign lane, not fall back to the own-lane client");
    assert!(
        state.session_routes.lock().unwrap_or_else(|e| e.into_inner()).contains_key("ok-session"),
        "a classified foreign client is cached so later ops reuse the lane"
    );

    set_active_repo_global(None).unwrap();
    let _ = socket.join();
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn canonical_host_executable_resolves_files_and_symlinks() {
    let root = std::env::temp_dir().join(format!("alinery-host-executable-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let executable = root.join("Alinery Dev");
    fs::write(&executable, b"fixture").unwrap();
    let alias = root.join("host-link");
    std::os::unix::fs::symlink(&executable, &alias).unwrap();

    let expected = fs::canonicalize(&executable).unwrap();
    assert_eq!(canonical_host_executable(Ok(executable)), Some(expected.clone()));
    assert_eq!(canonical_host_executable(Ok(alias)), Some(expected));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn canonical_host_executable_fails_open_for_lookup_and_canonicalization_errors() {
    let missing = std::env::temp_dir().join(format!("alinery-missing-host-{}", uuid::Uuid::new_v4()));
    assert_eq!(canonical_host_executable(Ok(missing)), None);
    assert_eq!(
        canonical_host_executable(Err(std::io::Error::new(std::io::ErrorKind::NotFound, "injected current_exe failure"))),
        None
    );
}

#[test]
fn host_guard_environment_removes_stale_values_before_optional_injection() {
    let mut warning_command = std::process::Command::new("true");
    crate::daemon_client::configure_host_guard_environment(&mut warning_command, None);
    let warning_value = warning_command
        .get_envs()
        .find(|(name, _)| *name == "ALINERY_HOST_EXECUTABLE")
        .expect("warning path must explicitly remove an inherited host value")
        .1;
    assert_eq!(warning_value, None);

    let canonical = Path::new("/canonical/Alinery Dev");
    let mut protected_command = std::process::Command::new("true");
    crate::daemon_client::configure_host_guard_environment(&mut protected_command, Some(canonical));
    let protected_value = protected_command
        .get_envs()
        .find(|(name, _)| *name == "ALINERY_HOST_EXECUTABLE")
        .expect("protected path must explicitly supply the canonical host")
        .1;
    assert_eq!(protected_value, Some(canonical.as_os_str()));
}

#[test]
fn daemon_reported_host_guard_warning_is_conservative() {
    let ready = crate::daemon_client::parse_version_reply(&serde_json::json!({"host_guard_ready": true}));
    let unready = crate::daemon_client::parse_version_reply(&serde_json::json!({"host_guard_ready": false}));
    let missing = crate::daemon_client::parse_version_reply(&serde_json::json!({}));

    assert!(!ready.host_guard_warning());
    assert!(unready.host_guard_warning());
    assert!(missing.host_guard_warning());
}

#[test]
fn ensure_daemon_adoption_uses_reported_host_guard_readiness() {
    let mut fixtures = Vec::new();
    for (label, ready, expected_warning) in [("ready", true, false), ("unready", false, true)] {
        let repo = activity_repo(label);
        let app_config = repo.join(".alinery/app.toml");
        let app_config_identity = alinery_core::app_config_identity(&app_config);
        let socket = status_list_socket(
            crate::current_alineryd_socket_path(&repo),
            Some(&format!(
                "{{\"protocol\":{},\"build_id\":\"retained\",\"app_config_identity\":\"{}\",\"host_guard_ready\":{ready}}}\n",
                alinery_core::PROTOCOL_VERSION,
                app_config_identity
            )),
        );
        let warning = match crate::ensure_daemon(&repo, &app_config) {
            Ok((_, _, _, warning)) => warning,
            Err(error) => panic!("compatible retained daemon must be adopted: {error}"),
        };
        assert_eq!(warning, expected_warning);
        fixtures.push((repo, socket));
    }

    for (repo, socket) in fixtures {
        let _ = socket.join();
        let _ = fs::remove_dir_all(repo);
    }
}
#[test]
fn host_guard_warning_is_repo_scoped_replaced_and_cleared() {
    let warned = PathBuf::from("/tmp/alinery-warning-repo");
    let protected = PathBuf::from("/tmp/alinery-protected-repo");
    let conflicted = PathBuf::from("/tmp/alinery-conflicted-repo");
    let unknown = PathBuf::from("/tmp/alinery-unknown-repo");
    let state = AppState::default();
    let client = || DaemonClient::connect_path(PathBuf::from("/tmp/alinery-host-guard.sock")).unwrap();

    state.set_daemon(&warned, client(), DaemonCompat::Current, "warned".into(), true);
    state.set_daemon(&protected, client(), DaemonCompat::Current, "protected".into(), false);
    state.set_daemon_conflict(
        &conflicted,
        DaemonConflict {
            repo: conflicted.display().to_string(),
            reason: "protocol".into(),
            daemon_protocol: None,
            app_protocol: PROTOCOL_VERSION,
            daemon_app_config_identity: None,
            app_config_identity: None,
            live_sessions: 0,
        },
    );

    assert!(state.daemon_host_guard_warning(&warned));
    assert!(state.daemon_host_guard_warning(&warned), "warning is retained with the connected entry");
    assert!(!state.daemon_host_guard_warning(&protected));
    assert!(!state.daemon_host_guard_warning(&conflicted));
    assert!(!state.daemon_host_guard_warning(&unknown));

    state
        .session_routes
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert("foreign-session".into(), client());
    assert!(state.refresh_daemon_observation(&protected, DaemonCompat::BuildDrift, "observed-unready".into(), true,));
    assert!(state.daemon_host_guard_warning(&protected));
    assert_eq!(state.daemon_compat(&protected), Some(DaemonCompat::BuildDrift));
    assert_eq!(state.daemon_app_config_identity(&protected).as_deref(), Some("observed-unready"));
    assert!(state.session_routes.lock().unwrap_or_else(|error| error.into_inner()).contains_key("foreign-session"));

    assert!(state.refresh_daemon_observation(&protected, DaemonCompat::Current, "observed-ready".into(), false,));
    assert!(!state.daemon_host_guard_warning(&protected));
    assert_eq!(state.daemon_compat(&protected), Some(DaemonCompat::Current));
    assert_eq!(state.daemon_app_config_identity(&protected).as_deref(), Some("observed-ready"));
    assert!(state.session_routes.lock().unwrap_or_else(|error| error.into_inner()).contains_key("foreign-session"));
    assert!(!state.refresh_daemon_observation(&conflicted, DaemonCompat::Current, "ignored".into(), false,));

    state.set_daemon(&warned, client(), DaemonCompat::Current, "replacement".into(), false);
    assert!(!state.daemon_host_guard_warning(&warned), "replacement supplies its own warning state");
    state.set_daemon(&warned, client(), DaemonCompat::Current, "warned-again".into(), true);
    state.clear_daemon(&warned);
    assert!(!state.daemon_host_guard_warning(&warned));
}
