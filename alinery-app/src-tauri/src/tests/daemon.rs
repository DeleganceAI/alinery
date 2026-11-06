//! Tests for daemon.rs — lanes, ownership, protocol classification, quit/teardown latches
//!
//! `use super::*` reaches the shared imports and fixtures in tests/mod.rs.
use super::daemon_rpc::{answer_hello_with, answer_live_sessions_with, serve_at, shutdowns_with, teardown_fixture, Teardown};
use super::*;
use crate::daemon_rpc::{shutdown_daemon, HelloResponse, ShutdownOrigin, ShutdownRequest};
use crate::{canonical_host_executable, DaemonConflict};
use alinery_core::legacy_daemon::BoundDaemonConnection;
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

fn recording_lane_with_response(socket_path: PathBuf, response: impl Fn(&str) -> String + Send + 'static) -> (std::sync::Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>) {
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixListener;
    fs::create_dir_all(socket_path.parent().unwrap()).unwrap();

    let listener = UnixListener::bind(&socket_path).unwrap();
    listener.set_nonblocking(true).unwrap();
    let requests = std::sync::Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let handle = std::thread::spawn(move || {
        // Idle deadline, reset per request: a slow runner (binary hash, git auth between
        // requests) must not outlive the listener mid-test.
        let mut deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    deadline = Instant::now() + Duration::from_secs(3);
                    // Accepted sockets inherit nonblocking mode on macOS; full execution
                    // replies can exceed the send buffer, unlike the small version reply.
                    stream.set_nonblocking(false).unwrap();
                    let mut line = String::new();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        continue;
                    }
                    stream.set_write_timeout(Some(Duration::from_secs(1))).unwrap();
                    let request: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
                    let op = request.get("op").and_then(serde_json::Value::as_str).unwrap().to_string();
                    recorded.lock().unwrap_or_else(|error| error.into_inner()).push(op.clone());
                    let response = response(&op);
                    writeln!(stream, "{response}").unwrap();
                    stream.flush().unwrap();
                    if op == "shutdown" {
                        break;
                    }
                }
                // Same as the fixtures in tests/mod.rs: ECONNABORTED and EINTR must
                // not tear the listener down.
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
        drop(listener);
        let _ = fs::remove_file(socket_path);
    });
    (requests, handle)
}

#[test]
fn app_lifecycle_targets_the_namespaced_lane_not_production() {
    let lane = crate::alineryd_socket_namespace();
    assert!(lane.is_some(), "app tests must exercise the development namespace");
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (current_token, production_token) = (format!("current-{id}"), format!("production-{id}"));
    let t = teardown_fixture(lane.as_deref(), &current_token);
    let production_socket = alinery_core::rpc_socket_path(&t.repo, None);
    assert_ne!(production_socket, t.server.socket, "the two lanes must not share a socket");
    let key = t.repo.display().to_string();
    crate::daemon::store_rpc_secret(alinery_core::app_config_dir_of(&t.app_config).unwrap(), &key, "", &production_token).unwrap();
    let production = tauri::async_runtime::block_on(serve_at(production_socket.clone(), t.repo.clone()));

    // The current lane's daemon exits when it is told to: its socket goes.
    let (socket, token) = (t.server.socket.clone(), current_token.clone());
    let exits = std::thread::spawn(move || {
        let until = Instant::now() + Duration::from_secs(10);
        while shutdowns_with(&token).is_empty() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(5));
        }
        let _ = fs::remove_file(&socket);
    });
    let state = AppState::default();
    let lifecycle = state.repo_lifecycle(&t.repo);
    let guard = lifecycle.lock().unwrap_or_else(|error| error.into_inner());
    crate::close_repo_daemon(&state, &t.repo, &t.app_config, &guard).expect("close must stop and wait for the app's current lane");
    exits.join().unwrap();

    assert_eq!(
        shutdowns_with(&current_token),
        vec![ShutdownRequest {
            origin: ShutdownOrigin::CloseRepo as i32,
            confirmation_id: String::new()
        }],
        "close must stop the current lane, once, with its origin"
    );
    assert!(shutdowns_with(&production_token).is_empty(), "app lifecycle operations must not stop the production lane");
    assert!(std::os::unix::net::UnixStream::connect(&production.socket).is_ok(), "the production lane is still serving");
    let _ = fs::remove_dir_all(t.repo.parent().unwrap());
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
    let repo = activity_repo("wait-gone");
    fs::create_dir_all(repo.join(".alinery")).unwrap();
    // No listener ⇒ connect fails immediately ⇒ Ok.
    alinery_core::wait_for_daemon_gone(&repo, crate::alineryd_socket_namespace().as_deref().unwrap_or("")).expect("quiet socket is success");
    let _ = fs::remove_dir_all(&repo);
}

// macOS `sockaddr_un.sun_path` is 104 bytes. `temp_dir()` in a nested runner is
// already long enough that these control sockets do not fit, so they stay in `/tmp`.
fn control_sock(label: &str, n: u128) -> PathBuf {
    PathBuf::from(format!("/tmp/alinery-{label}-{n}.sock"))
}

// T2.2: the branch — `Closed` vs. `TimedOut` must no longer collapse into the same `None`.
#[test]
fn read_socket_line_distinguishes_timeout_from_closed() {
    use std::os::unix::net::UnixListener;
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);

    // Sub-case 1: peer closes without writing anything.
    let closed_sock = control_sock("t22-closed", n);
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
    let hang_sock = control_sock("t22-hang", n);
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
    // The two asserts above are the proof that nothing was spawned; this bound only separates "returned at once" from a spawn wait, which takes seconds, so it is wide enough for a loaded machine.
    assert!(started.elapsed() < Duration::from_secs(5), "returned before any spawn attempt");

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
        // The asserts above prove nothing was spawned; this bound only separates "returned at once" from a spawn wait (seconds), so it is wide enough for a loaded suite.
        assert!(started.elapsed() < Duration::from_secs(5), "returned before any spawn attempt");
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

/// A `Hello` that reports this build's protocol and `config`'s identity, for a daemon whose build is `build`.
fn current_hello(config: &Path, build: &str) -> HelloResponse {
    HelloResponse {
        protocol: PROTOCOL_VERSION,
        build_id: build.into(),
        epoch: "e-1".into(),
        capabilities: Vec::new(),
        repo_root: String::new(),
        app_config_identity: alinery_core::app_config_identity(config),
    }
}

fn ensure_outcome(t: &Teardown) -> Result<DaemonCompat, Box<DaemonConflict>> {
    match crate::ensure_daemon(&t.repo, &t.app_config) {
        Ok(compat) => Ok(compat),
        Err(crate::EnsureDaemonError::Mismatch(conflict)) => Err(conflict),
        Err(error) => panic!("an answering daemon must not be a start failure: {error}"),
    }
}

// A daemon that answers `Hello` with this protocol and app config is reused whatever its build. Nothing is stopped.
#[test]
fn ensure_daemon_reuses_an_answering_daemon_of_our_protocol_and_config() {
    for (label, build, expected) in [
        ("same", crate::alineryd_build_id(), DaemonCompat::Current),
        ("drift", "another-build".to_string(), DaemonCompat::BuildDrift),
    ] {
        let token = format!("reuse-{label}-{}", uuid::Uuid::new_v4().simple());
        let t = teardown_fixture(crate::alineryd_socket_namespace().as_deref(), &token);
        answer_hello_with(&token, current_hello(&t.app_config, &build));
        assert_eq!(ensure_outcome(&t).unwrap(), expected, "{label}");
        assert!(shutdowns_with(&token).is_empty(), "attaching is never a teardown origin");
    }
}

// The relaunch case (S5.3): a daemon started by one app process is found by the next one with the token the first kept on disk.
// Nothing but that file carries over, so the second attach has no in-memory state to lean on. It must be the same process
// (PID and epoch unchanged), and it must not have been started again. Runs the real sidecar, which `copy-sidecar.sh debug` puts
// beside the test binary; without it there is nothing to launch and the test says so.
#[test]
fn a_relaunched_app_reattaches_to_the_daemon_that_outlived_it_with_the_stored_token() {
    if alinery_core::resolve_alineryd_path().is_none() {
        eprintln!("skipped: no alinery-vinculum-daemon beside the test binary (run src-tauri/scripts/copy-sidecar.sh debug)");
        return;
    }
    let lane = crate::alineryd_socket_namespace();
    let root = PathBuf::from(format!("/tmp/alinery-rl-{}", &uuid::Uuid::new_v4().simple().to_string()[..10]));
    let repo = root.join("repo");
    fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new(std::env::var("ALINERY_GIT_PATH").unwrap_or_else(|_| "git".into()))
            .args(["-c", "user.email=t@example.com", "-c", "user.name=t"])
            .args(args)
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q"]);
    git(&["commit", "-q", "--allow-empty", "-m", "init"]);
    let app_config = root.join("cfg").join("app.toml");
    register_takeover_repo(&repo, &app_config);
    // The test's own daemon goes the way a person would stop it (a confirmed stop-daemon), also when an assertion fails.
    struct StopDaemon<'a>(&'a Path, &'a Path, Option<&'a str>, &'a Path);
    impl Drop for StopDaemon<'_> {
        fn drop(&mut self) {
            let key = self.0.display().to_string();
            let _ = shutdown_daemon(&key, self.1, self.2, ShutdownOrigin::StopDaemon, "relaunch-test", None, || Err("an rpc daemon".into()));
            let _ = alinery_core::legacy_daemon::wait_for_daemon_gone(self.0, self.2.unwrap_or(""));
            let _ = fs::remove_dir_all(self.3);
        }
    }
    let _stop = StopDaemon(&repo, &app_config, lane.as_deref(), &root);
    let peer = || {
        let stream = std::os::unix::net::UnixStream::connect(alinery_core::rpc_socket_path(&repo, lane.as_deref())).unwrap();
        alinery_core::legacy_daemon::peer_process_id(&stream).unwrap()
    };

    let first = AppState::default();
    attach_repo_daemon(&first, &repo, &app_config);
    assert!(first.daemon_attached(&repo), "the first app process starts and attaches the daemon");
    let (pid, epoch) = (peer(), crate::daemon::hello_current(&repo, &app_config, Duration::from_secs(5)).unwrap().epoch);
    let secret = crate::daemon::rpc_secret_path(
        alinery_core::app_config_dir_of(&app_config).unwrap(),
        &repo.to_string_lossy(),
        lane.as_deref().unwrap_or(""),
    );
    assert!(secret.exists(), "the token the daemon accepted is kept");
    assert!(!crate::daemon::pending_rpc_secret_path(&secret).exists(), "and it was committed after the first Hello");

    // The first app process quits: its GUI ownership flock goes with it, and the daemon stays.
    let compat = first.daemon_compat(&repo);
    drop(first);
    let second = AppState::default();
    attach_repo_daemon(&second, &repo, &app_config);
    assert!(second.daemon_attached(&repo), "the next app process reattaches");
    assert_eq!(second.daemon_compat(&repo), compat);
    assert_eq!(peer(), pid, "the daemon was not started again");
    assert_eq!(crate::daemon::hello_current(&repo, &app_config, Duration::from_secs(5)).unwrap().epoch, epoch);
}

// A daemon on another protocol, or one started with another app config, is a conflict that names it and its sessions. It is
// never stopped here and the app never speaks to it as if it were current.
#[test]
fn ensure_daemon_refuses_a_foreign_protocol_or_app_config_and_stops_nothing() {
    let lane = crate::alineryd_socket_namespace();
    for label in ["protocol", "config"] {
        let token = format!("foreign-{label}-{}", uuid::Uuid::new_v4().simple());
        let t = teardown_fixture(lane.as_deref(), &token);
        let mut hello = current_hello(&t.app_config, "foreign");
        if label == "protocol" {
            hello.protocol = PROTOCOL_VERSION + 1;
        } else {
            hello.app_config_identity = "another-config".into();
        }
        answer_hello_with(&token, hello.clone());
        answer_live_sessions_with(&token, &["live-a", "live-b"]);
        let conflict = ensure_outcome(&t).expect_err("must refuse");
        let owner = conflict
            .owners
            .iter()
            .find(|owner| owner.lane == lane.clone().unwrap_or_default())
            .expect("the answering daemon is named");
        assert_eq!(owner.protocol, Some(hello.protocol), "{label}");
        assert_eq!(owner.app_config_identity.as_deref(), Some(hello.app_config_identity.as_str()), "{label}");
        let crate::TakeoverImpact::Known { sessions } = &owner.impact else {
            panic!("{label}: live sessions are listed: {:?}", owner.impact)
        };
        assert_eq!(sessions.len(), 2, "{label}");
        assert!(shutdowns_with(&token).is_empty(), "{label}: observing a conflict stops nothing");
    }
}

// The attach the poller and every command go through: a reachable current daemon is recorded, a refused one is a conflict.
#[test]
fn attach_records_the_hello_outcome_per_repo() {
    let lane = crate::alineryd_socket_namespace();
    let token = format!("attach-{}", uuid::Uuid::new_v4().simple());
    let t = teardown_fixture(lane.as_deref(), &token);
    register_takeover_repo(&t.repo, &t.app_config);
    answer_hello_with(&token, current_hello(&t.app_config, "another-build"));
    let state = AppState::default();
    attach_repo_daemon(&state, &t.repo, &t.app_config);
    assert!(state.daemon_attached(&t.repo));
    assert_eq!(state.daemon_compat(&t.repo), Some(DaemonCompat::BuildDrift));
    assert!(state.daemon_conflict(&t.repo).is_none());

    let refused = format!("attach-refused-{}", uuid::Uuid::new_v4().simple());
    let r = teardown_fixture(lane.as_deref(), &refused);
    register_takeover_repo(&r.repo, &r.app_config);
    let mut hello = current_hello(&r.app_config, "foreign");
    hello.protocol = PROTOCOL_VERSION + 1;
    answer_hello_with(&refused, hello);
    attach_repo_daemon(&state, &r.repo, &r.app_config);
    assert!(!state.daemon_attached(&r.repo));
    assert!(state.daemon_conflict(&r.repo).is_some());
    assert!(state.daemon_attached(&t.repo), "another repo's entry is untouched");
    assert!(shutdowns_with(&refused).is_empty());
}

// An entry is per repo, a later outcome replaces an earlier one, and clearing it leaves the others.
#[test]
fn a_daemon_entry_is_repo_scoped_replaced_and_cleared() {
    let (a, b, c, unknown) = (
        PathBuf::from("/tmp/alinery-entry-a"),
        PathBuf::from("/tmp/alinery-entry-b"),
        PathBuf::from("/tmp/alinery-entry-c"),
        PathBuf::from("/tmp/alinery-entry-unknown"),
    );
    let state = AppState::default();
    state.set_daemon(&a, DaemonCompat::Current);
    state.set_daemon(&b, DaemonCompat::BuildDrift);
    state.set_daemon_conflict(
        &c,
        DaemonConflict {
            repo: c.display().to_string(),
            app_protocol: PROTOCOL_VERSION,
            app_config_identity: "config".into(),
            owners: Vec::new(),
            issues: vec!["unavailable".into()],
        },
    );
    assert!(state.daemon_attached(&a) && state.daemon_attached(&b));
    assert!(!state.daemon_attached(&c) && !state.daemon_attached(&unknown));
    assert_eq!(state.daemon_compat(&a), Some(DaemonCompat::Current));
    assert_eq!(state.daemon_compat(&b), Some(DaemonCompat::BuildDrift));
    assert_eq!(state.daemon_compat(&c), None);

    state.set_daemon(&c, DaemonCompat::Current);
    assert!(state.daemon_attached(&c) && state.daemon_conflict(&c).is_none(), "an answer replaces the conflict");
    state.set_daemon_conflict(
        &a,
        DaemonConflict {
            repo: a.display().to_string(),
            app_protocol: PROTOCOL_VERSION,
            app_config_identity: "config".into(),
            owners: Vec::new(),
            issues: vec!["now refused".into()],
        },
    );
    assert!(!state.daemon_attached(&a) && state.daemon_conflict(&a).is_some(), "a conflict replaces the connection");

    state.clear_daemon(&c);
    assert!(state.repo_daemon(&c).is_none());
    assert!(state.daemon_attached(&b), "clearing one repo leaves the others");
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
    alinery_core::configure_host_guard_environment(&mut warning_command, None);
    let warning_value = warning_command
        .get_envs()
        .find(|(name, _)| *name == "ALINERY_HOST_EXECUTABLE")
        .expect("warning path must explicitly remove an inherited host value")
        .1;
    assert_eq!(warning_value, None);

    let canonical = Path::new("/canonical/Alinery Dev");
    let mut protected_command = std::process::Command::new("true");
    alinery_core::configure_host_guard_environment(&mut protected_command, Some(canonical));
    let protected_value = protected_command
        .get_envs()
        .find(|(name, _)| *name == "ALINERY_HOST_EXECUTABLE")
        .expect("protected path must explicitly supply the canonical host")
        .1;
    assert_eq!(protected_value, Some(canonical.as_os_str()));
}

#[test]
fn project_open_refuses_a_live_foreign_lock_without_seizing_the_gui() {
    use std::os::unix::fs::MetadataExt;
    let repo = activity_repo("foreign-live-owner");
    fs::create_dir_all(repo.join(".alinery")).unwrap();
    let config = repo.join(".alinery/app.toml");
    register_takeover_repo(&repo, &config);
    let lock_path = alinery_core::alineryd_lock_path(&repo, Some("old-checkout"));
    let lease = alinery_core::lockfile::try_lock_exclusive(&lock_path).unwrap().unwrap();
    let inode = fs::metadata(&lock_path).unwrap().ino();
    let state = AppState::default();
    crate::attach_repo_daemon(&state, &repo, &config);
    let conflict = state.daemon_conflict(&repo).expect("live foreign owner must be visible");
    assert!(conflict.owners.is_empty(), "a held lease without a socket is not an identified process");
    assert!(conflict.issues.iter().any(|issue| issue.contains("old-checkout")));
    assert!(!state.daemon_attached(&repo));
    assert!(!state.owns_repo(&repo));
    assert!(crate::require_repo_owned(&state, &repo).is_err());
    assert_eq!(fs::metadata(&lock_path).unwrap().ino(), inode, "refusal must never replace a held lock");
    assert!(!crate::current_alineryd_socket_path(&repo).exists());
    let owner_window = AppState::default();
    assert!(owner_window.claim_repo(&repo), "the original owner's GUI must still be able to reopen");
    drop(owner_window);
    drop(lease);
    fs::remove_dir_all(repo).unwrap();
}

#[test]
fn project_open_reports_unknown_lock_state_without_starting_a_daemon() {
    let repo = activity_repo("unknown-owner");
    fs::create_dir_all(repo.join(".alinery")).unwrap();
    register_takeover_repo(&repo, &repo.join(".alinery/app.toml"));
    let lock_path = alinery_core::alineryd_lock_path(&repo, Some("unreadable"));
    fs::create_dir(&lock_path).unwrap();
    let state = AppState::default();
    crate::attach_repo_daemon(&state, &repo, &repo.join(".alinery/app.toml"));
    assert!(state.daemon_conflict(&repo).unwrap().issues.iter().any(|issue| issue.contains("unreadable")));
    assert!(!state.daemon_attached(&repo));
    assert!(!state.owns_repo(&repo));
    assert!(!crate::current_alineryd_socket_path(&repo).exists());
    assert!(lock_path.is_dir());
    fs::remove_dir_all(repo).unwrap();
}

#[test]
fn daemon_exit_wait_does_not_accept_a_missing_socket_with_a_live_lock() {
    let repo = activity_repo("exit-live-lock");
    fs::create_dir_all(repo.join(".alinery")).unwrap();
    let lease = alinery_core::lockfile::try_lock_exclusive(&alinery_core::alineryd_lock_path(&repo, crate::alineryd_socket_namespace().as_deref()))
        .unwrap()
        .unwrap();
    assert!(alinery_core::wait_for_daemon_gone(&repo, crate::alineryd_socket_namespace().as_deref().unwrap_or("")).is_err());
    drop(lease);
    alinery_core::wait_for_daemon_gone(&repo, crate::alineryd_socket_namespace().as_deref().unwrap_or("")).unwrap();
    fs::remove_dir_all(repo).unwrap();
}
#[test]
fn closing_repo_discards_inflight_conflict_observation() {
    let repo = activity_repo("closing-probe");
    register_takeover_repo(&repo, &repo.join("app.toml"));
    let state = std::sync::Arc::new(AppState::default());
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    let paused = std::sync::atomic::AtomicBool::new(false);
    let (requests, listener) = recording_lane_with_response(crate::current_alineryd_socket_path(&repo), move |op| match op {
        "version" => {
            if !paused.swap(true, std::sync::atomic::Ordering::SeqCst) {
                entered_tx.send(()).unwrap();
                resume_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            }
            serde_json::json!({"protocol": 12, "build_id": "old", "app_config_identity": "old"}).to_string()
        }
        "list" => serde_json::json!({"sessions": []}).to_string(),
        other => panic!("unexpected destructive request: {other}"),
    });
    let worker_state = state.clone();
    let worker_repo = repo.clone();
    let worker = std::thread::spawn(move || {
        attach_repo_daemon(&worker_state, &worker_repo, &worker_repo.join("app.toml"));
    });
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let closing = state.mark_closing(&repo);
    resume_tx.send(()).unwrap();
    worker.join().unwrap();
    let published = state.repo_daemon(&repo).is_some();
    drop(closing);
    listener.join().unwrap();
    assert!(!requests.lock().unwrap_or_else(|error| error.into_inner()).iter().any(|op| op == "shutdown"));
    fs::remove_dir_all(repo).unwrap();
    assert!(!published, "an observation begun before close must not publish during teardown");
}

// App orchestration peers have mutable observations and orderly exit, unlike the
// core transport fixture, which deliberately stays alive after an acknowledgement.
struct TakeoverPeer {
    child: std::process::Child,
    root: PathBuf,
    lane: String,
}

impl TakeoverPeer {
    fn start(repo: &Path, lane: &str) -> Self {
        let root = repo.join(lane);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("version"), r#"{"protocol":12,"build_id":"old","app_config_identity":"old"}"#).unwrap();
        fs::write(root.join("list"), r#"{"sessions":[]}"#).unwrap();
        fs::write(root.join("ack"), r#"{"ok":true}"#).unwrap();
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::daemon::takeover_peer_child", "--nocapture"])
            .env("ALINERY_TEST_TAKEOVER_REPO", repo)
            .env("ALINERY_TEST_TAKEOVER_LANE", lane)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut peer = Self { child, root, lane: lane.into() };
        let until = Instant::now() + Duration::from_secs(5);
        let socket = alinery_core::alineryd_socket_path(repo, Some(lane));
        while BoundDaemonConnection::connect(&socket, None, crate::DAEMON_CONTROL_TIMEOUT)
            .and_then(|connection| connection.version())
            .is_err()
        {
            assert!(peer.child.try_wait().unwrap().is_none());
            assert!(Instant::now() < until, "legacy peer did not become queryable");
            std::thread::sleep(Duration::from_millis(5));
        }
        peer
    }
    fn shutdowns(&self) -> usize {
        fs::read_to_string(self.root.join("requests"))
            .unwrap_or_default()
            .lines()
            .filter(|op| *op == "shutdown")
            .count()
    }
    fn impact(&self, ids: &[&str]) {
        let sessions = ids
            .iter()
            .map(|id| {
                serde_json::json!({
                    "id":id, "process":{"state":"alive"}, "agent":{"state":"unknown"},
                    "playbook":{"state":"in_progress"}, "adapter":"unsupported",
                    "message_adapter":"unsupported", "transport":"pty",
                })
            })
            .collect::<Vec<_>>();
        fs::write(self.root.join("list"), serde_json::json!({"sessions":sessions}).to_string()).unwrap();
    }
}
impl Drop for TakeoverPeer {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        let _ = self.child.wait();
    }
}

#[test]
fn takeover_peer_child() {
    use std::io::{BufRead, BufReader};
    let Ok(repo) = std::env::var("ALINERY_TEST_TAKEOVER_REPO") else { return };
    let repo = PathBuf::from(repo);
    let lane = std::env::var("ALINERY_TEST_TAKEOVER_LANE").unwrap();
    let root = repo.join(&lane);
    let socket = alinery_core::alineryd_socket_path(&repo, Some(&lane));
    let _lease = alinery_core::lockfile::try_lock_exclusive(&alinery_core::alineryd_lock_path(&repo, Some(&lane)))
        .unwrap()
        .unwrap();
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    listener.set_nonblocking(true).unwrap();
    let stopped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let signal = stopped.clone();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
        signal.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    while !stopped.load(std::sync::atomic::Ordering::SeqCst) {
        let (mut stream, _) = match listener.accept() {
            Ok(pair) => pair,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(2));
                continue;
            }
            Err(error) => panic!("{error}"),
        };
        if stream.set_nonblocking(false).is_err() || stream.set_read_timeout(Some(Duration::from_secs(1))).is_err() {
            continue;
        }
        let mut line = String::new();
        if BufReader::new(stream.try_clone().unwrap()).read_line(&mut line).unwrap_or(0) == 0 {
            continue;
        }
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        let op = request["op"].as_str().unwrap();
        writeln!(fs::OpenOptions::new().create(true).append(true).open(root.join("requests")).unwrap(), "{op}").unwrap();
        let response = fs::read_to_string(root.join(if op == "shutdown" { "ack" } else { op })).unwrap();
        if op == "shutdown" && response == "HOLD_LEASE" {
            fs::remove_file(&socket).unwrap();
            writeln!(stream, "{{\"ok\":true}}").unwrap();
            while !stopped.load(std::sync::atomic::Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(2));
            }
            break;
        }
        if op == "shutdown" && response == r#"{"ok":true}"# {
            fs::remove_file(&socket).unwrap();
            writeln!(stream, "{response}").unwrap();
            break;
        }
        let _ = writeln!(stream, "{response}");
    }
    let _ = fs::remove_file(socket);
}

struct TakeoverRepo(PathBuf);
impl TakeoverRepo {
    fn new() -> Self {
        let repo = PathBuf::from(format!("/tmp/ato-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]));
        fs::create_dir_all(repo.join(".alinery")).unwrap();
        assert!(git_cmd(&repo).args(["init", "-q"]).status().unwrap().success());
        Self(fs::canonicalize(repo).unwrap())
    }
    fn known(&self) -> Vec<String> {
        vec![self.0.display().to_string()]
    }
    fn prepare(&self, state: &AppState, lane: &str) -> crate::TakeoverPreview {
        crate::prepare_repo_takeover_blocking(state, &self.0.join("app.toml"), &self.0.display().to_string(), lane, || self.known()).unwrap()
    }
    fn confirm(&self, state: &AppState, id: &str) -> Result<crate::TakeoverOutcome, String> {
        crate::confirm_repo_takeover_blocking(state, &self.0.join("app.toml"), id, || self.known(), |_| {})
    }
}
impl Drop for TakeoverRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn takeover_consent_is_passive_single_use_and_revalidates_gui() {
    let repo = TakeoverRepo::new();
    let peer = TakeoverPeer::start(&repo.0, "old");
    let state = AppState::default();
    let old = repo.prepare(&state, &peer.lane);
    assert_eq!(peer.shutdowns(), 0);
    let other_gui = AppState::default();
    assert!(other_gui.claim_repo(&repo.0), "preparation must not retain the GUI lease");
    assert!(repo.confirm(&state, &old.confirmation_id).unwrap_err().contains("repo-busy"));
    other_gui.release_repo(&repo.0);
    assert!(repo.confirm(&state, &old.confirmation_id).is_err(), "failed confirmation consumes consent");
    let old = repo.prepare(&state, &peer.lane);
    let fresh = repo.prepare(&state, &peer.lane);
    assert!(repo.confirm(&state, &old.confirmation_id).is_err(), "new preparation supersedes old consent");
    state.begin_quit();
    assert!(repo.confirm(&state, &fresh.confirmation_id).is_err());
    state.cancel_quit();
    let fresh = repo.prepare(&state, &peer.lane);
    let closing = state.mark_closing(&repo.0);
    assert!(repo.confirm(&state, &fresh.confirmation_id).is_err());
    drop(closing);
    let fresh = repo.prepare(&state, &peer.lane);
    assert!(crate::confirm_repo_takeover_blocking(&state, &repo.0.join("app.toml"), &fresh.confirmation_id, Vec::new, |_| {}).is_err());
    assert_eq!(peer.shutdowns(), 0, "none of these attempts authorizes a shutdown");
}

#[test]
fn changed_impact_requires_fresh_consent_and_replacement_invalidates_it() {
    let repo = TakeoverRepo::new();
    let a = TakeoverPeer::start(&repo.0, "old");
    a.impact(&["first"]);
    let state = AppState::default();
    let preview = repo.prepare(&state, "old");
    a.impact(&["second"]);
    let crate::TakeoverOutcome::Reconfirm { preview } = repo.confirm(&state, &preview.confirmation_id).unwrap() else {
        panic!("changed IDs require consent")
    };
    assert_eq!(a.shutdowns(), 0);
    fs::write(a.root.join("list"), r#"{"error":"unsupported"}"#).unwrap();
    let crate::TakeoverOutcome::Reconfirm { preview } = repo.confirm(&state, &preview.confirmation_id).unwrap() else {
        panic!("unknown impact requires consent")
    };
    assert!(matches!(preview.owner.impact, crate::TakeoverImpact::Unknown { .. }));
    assert_eq!(a.shutdowns(), 0);
    drop(a);
    let b = TakeoverPeer::start(&repo.0, "old");
    assert!(repo.confirm(&state, &preview.confirmation_id).is_err(), "replacement incarnation invalidates consent");
    assert_eq!(b.shutdowns(), 0);
}

#[test]
fn refused_shutdown_consumes_consent_without_attaching_replacement() {
    let repo = TakeoverRepo::new();
    let peer = TakeoverPeer::start(&repo.0, "old");
    fs::write(peer.root.join("ack"), r#"{"error":"refused"}"#).unwrap();
    let state = AppState::default();
    let preview = repo.prepare(&state, "old");
    assert!(repo.confirm(&state, &preview.confirmation_id).unwrap_err().contains("shutdown failed"));
    assert!(repo.confirm(&state, &preview.confirmation_id).is_err());
    assert_eq!(peer.shutdowns(), 1);
    assert!(!state.daemon_attached(&repo.0));
    assert!(!crate::current_alineryd_socket_path(&repo.0).exists());
    assert!(
        BoundDaemonConnection::connect(&alinery_core::alineryd_socket_path(&repo.0, Some("old")), None, crate::DAEMON_CONTROL_TIMEOUT)
            .and_then(|connection| connection.version())
            .is_ok(),
        "the refused owner is still serving"
    );
}

#[test]
fn two_legacy_owners_require_two_confirmations() {
    // Execute the real attach path from an isolated alongside installation, not
    // target/debug/deps (which also contains non-executable Rust depfiles).
    if std::env::var_os("ALINERY_TEST_TAKEOVER_INSTALL").is_none() {
        let install = TakeoverRepo::new();
        let executable = install.0.join("app-tests");
        fs::hard_link(std::env::current_exe().unwrap(), &executable).unwrap();
        let debug = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/debug");
        std::os::unix::fs::symlink(debug.join("alinery-vinculum-daemon"), install.0.join("alinery-vinculum-daemon")).unwrap();
        let result = Command::new(executable)
            .args(["--exact", "tests::daemon::two_legacy_owners_require_two_confirmations", "--nocapture"])
            .env("ALINERY_TEST_TAKEOVER_INSTALL", "1")
            .status()
            .unwrap();
        assert!(result.success());
        return;
    }
    let repo = TakeoverRepo::new();
    write_retained_discovery_task(&repo.0, "task", "old-a", false);
    let path = alinery_core::execution::execution_state_path(&repo.0, "task").unwrap();
    let before = fs::read(&path).unwrap();
    let mut a = TakeoverPeer::start(&repo.0, "old-a");
    let b = TakeoverPeer::start(&repo.0, "old-b");
    b.impact(&["still-running"]);
    let state = AppState::default();
    let preview = repo.prepare(&state, "old-a");
    let crate::TakeoverOutcome::Blocked { conflict } = repo.confirm(&state, &preview.confirmation_id).unwrap() else {
        panic!("second owner still blocks")
    };
    assert!(a.child.wait().unwrap().success());
    assert_eq!(a.shutdowns(), 1);
    assert_eq!(b.shutdowns(), 0);
    assert!(conflict.owners.iter().any(|owner| owner.lane == "old-b"));
    assert_eq!(fs::read(&path).unwrap(), before, "no partial task adoption");
    assert!(!state.daemon_attached(&repo.0));
    let preview = repo.prepare(&state, "old-b");
    assert!(matches!(repo.confirm(&state, &preview.confirmation_id).unwrap(), crate::TakeoverOutcome::Attached));
    assert!(state.daemon_attached(&repo.0));
    // The replacement is a real daemon: stop it over the wire it serves.
    struct Replacement(PathBuf);
    impl Drop for Replacement {
        fn drop(&mut self) {
            let _ = shutdown_daemon(
                &self.0.display().to_string(),
                &self.0.join("app.toml"),
                crate::alineryd_socket_namespace().as_deref(),
                ShutdownOrigin::StopDaemon,
                "",
                None,
                || Err("the replacement speaks alinery.v1".into()),
            );
        }
    }
    let _replacement = Replacement(repo.0.clone());
    assert_eq!(b.shutdowns(), 1);
    let adopted = alinery_core::execution::read_execution_state(&repo.0, "task").unwrap();
    assert_eq!(adopted.owning_lane, crate::alineryd_socket_namespace().as_deref().unwrap_or(""));
    assert_eq!(adopted.owning_app_config_identity, alinery_core::app_config_identity(&repo.0.join("app.toml")));
}

#[test]
fn takeover_expiry_is_monotonic_and_cancel_is_idempotent() {
    use tauri::Manager;
    let repo = TakeoverRepo::new();
    let peer = TakeoverPeer::start(&repo.0, "old");
    fs::write(peer.root.join("ack"), r#"{"error":"refused"}"#).unwrap();
    let app = tauri::test::mock_builder()
        .manage(AppState::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = app.state::<AppState>();
    let now = Instant::now();
    let expired = crate::with_takeover_time(now, || repo.prepare(&state, "old"));
    let result = crate::with_takeover_time(now + Duration::from_secs(120), || repo.confirm(&state, &expired.confirmation_id));
    assert!(result.unwrap_err().contains("expired"));
    assert_eq!(peer.shutdowns(), 0);
    let cancelled = repo.prepare(&state, "old");
    crate::cancel_repo_takeover(app.state(), cancelled.confirmation_id.clone()).unwrap();
    crate::cancel_repo_takeover(app.state(), cancelled.confirmation_id.clone()).unwrap();
    assert!(repo.confirm(&state, &cancelled.confirmation_id).is_err());
    assert_eq!(peer.shutdowns(), 0);
    let valid = crate::with_takeover_time(now, || repo.prepare(&state, "old"));
    let result = crate::with_takeover_time(now + Duration::from_secs(120) - Duration::from_nanos(1), || repo.confirm(&state, &valid.confirmation_id));
    assert!(result.unwrap_err().contains("refused"), "one instant before expiry reaches the verified peer");
    assert_eq!(peer.shutdowns(), 1);
}

#[test]
fn concurrent_confirmation_sends_at_most_one_shutdown() {
    let repo = TakeoverRepo::new();
    let peer = TakeoverPeer::start(&repo.0, "old");
    fs::write(peer.root.join("ack"), r#"{"error":"refused"}"#).unwrap();
    let state = std::sync::Arc::new(AppState::default());
    let preview = repo.prepare(&state, "old");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    std::thread::scope(|scope| {
        let mut workers = Vec::new();
        for _ in 0..2 {
            let state = state.clone();
            let barrier = barrier.clone();
            let repo = &repo;
            let id = &preview.confirmation_id;
            workers.push(scope.spawn(move || {
                barrier.wait();
                repo.confirm(&state, id)
            }));
        }
        barrier.wait();
        for worker in workers {
            assert!(worker.join().unwrap().is_err());
        }
    });
    assert_eq!(peer.shutdowns(), 1);
    assert!(!state.daemon_attached(&repo.0));
}

fn register_takeover_repo(repo: &Path, config: &Path) {
    crate::write_app_config_at(
        config,
        &AppConfig {
            known_repos: vec![repo.display().to_string()],
            ..Default::default()
        },
    )
    .unwrap();
}

#[test]
fn attach_rechecks_membership_after_lifecycle_wait() {
    let repo = TakeoverRepo::new();
    let peer = TakeoverPeer::start(&repo.0, "old");
    let config = repo.0.join("app.toml");
    register_takeover_repo(&repo.0, &config);
    let state = std::sync::Arc::new(AppState::default());
    let lifecycle = state.repo_lifecycle(&repo.0);
    let guard = lifecycle.lock().unwrap_or_else(|error| error.into_inner());
    let started = std::sync::Arc::new(std::sync::Barrier::new(2));
    std::thread::scope(|scope| {
        let thread_state = state.clone();
        let thread_started = started.clone();
        let repo = &repo.0;
        let config = &config;
        let worker = scope.spawn(move || {
            thread_started.wait();
            attach_repo_daemon(&thread_state, repo, config);
        });
        started.wait();
        crate::write_app_config_at(config, &AppConfig::default()).unwrap();
        drop(guard);
        worker.join().unwrap();
    });
    assert!(!state.owns_repo(&repo.0));
    assert!(state.repo_daemon(&repo.0).is_none());
    assert_eq!(peer.shutdowns(), 0);
}

#[test]
fn nonactive_takeover_refresh_preserves_selected_repository_mcp() {
    use tauri::Manager;
    let _active_lock = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let app = tauri::test::mock_builder()
        .manage(AppState::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = app.state::<AppState>();
    struct Cleanup<'a>(&'a AppState);
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            self.0.kill_mcp();
            set_active_repo_global(None).unwrap();
        }
    }
    let _cleanup = Cleanup(&state);
    let selected = PathBuf::from("/tmp/selected-mcp-fixture");
    set_active_repo_global(Some(selected.clone())).unwrap();
    let child = Command::new("/bin/cat")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id();
    *state.mcp_child.lock().unwrap_or_else(|error| error.into_inner()) = Some(crate::ManagedMcpChild { repo: selected, child });
    crate::ensure_mcp_server(app.handle(), Path::new("/tmp/old-takeover-fixture"), true);
    state.kill_mcp_for_repo(Path::new("/tmp/old-takeover-fixture"));
    let mut guard = state.mcp_child.lock().unwrap_or_else(|error| error.into_inner());
    let managed = guard.as_mut().expect("selected repository's connection must remain available");
    assert_eq!(managed.child.id(), pid);
    assert!(managed.child.try_wait().unwrap().is_none(), "nonactive refresh must not kill or replace the selected child");
}

#[test]
fn takeover_rejects_invalid_and_compatible_targets_before_shutdown() {
    let repo = TakeoverRepo::new();
    let lane = crate::alineryd_socket_namespace().unwrap_or_default();
    let state = AppState::default();
    let config = repo.0.join("app.toml");
    // A daemon that answers `Hello` with our protocol and app config is compatible: it is reconnected to, never taken over.
    let token = format!("compatible-{}", uuid::Uuid::new_v4().simple());
    crate::daemon::store_rpc_secret(alinery_core::app_config_dir_of(&config).unwrap(), &repo.0.display().to_string(), &lane, &token).unwrap();
    answer_hello_with(&token, current_hello(&config, "different-but-compatible"));
    let _server = tauri::async_runtime::block_on(serve_at(alinery_core::rpc_socket_path(&repo.0, Some(&lane)), repo.0.clone()));
    assert!(
        crate::prepare_repo_takeover_blocking(&state, &config, &repo.0.display().to_string(), &lane, || repo.known())
            .unwrap_err()
            .contains("compatible")
    );
    for invalid in ["../outside", "reconciler", "not-discovered"] {
        assert!(crate::prepare_repo_takeover_blocking(&state, &config, &repo.0.display().to_string(), invalid, || repo.known()).is_err());
    }
    assert!(crate::prepare_repo_takeover_blocking(&state, &config, "/unselected", &lane, || repo.known()).is_err());
    assert!(shutdowns_with(&token).is_empty());
}

#[test]
fn takeover_reconfirms_changed_names_and_presented_version() {
    let repo = TakeoverRepo::new();
    write_retained_discovery_task(&repo.0, "task", "old", false);
    write_status_session(&repo.0, "task", "named-session", "work", "old", Some(1), None, None, "");
    alinery_core::set_session_name(&repo.0, "task", "named-session", "Original name", alinery_core::SessionNameSource::User).unwrap();
    let peer = TakeoverPeer::start(&repo.0, "old");
    peer.impact(&["named-session"]);
    let state = AppState::default();
    let first = repo.prepare(&state, "old");
    let crate::TakeoverImpact::Known { sessions } = &first.owner.impact else {
        panic!("known list")
    };
    assert_eq!(sessions[0].name.as_deref(), Some("Original name"));
    alinery_core::set_session_name(&repo.0, "task", "named-session", "Renamed work", alinery_core::SessionNameSource::User).unwrap();
    let crate::TakeoverOutcome::Reconfirm { preview } = repo.confirm(&state, &first.confirmation_id).unwrap() else {
        panic!("new displayed name requires consent")
    };
    let crate::TakeoverImpact::Known { sessions } = &preview.owner.impact else {
        panic!("known list")
    };
    assert_eq!(sessions[0].name.as_deref(), Some("Renamed work"));
    fs::write(peer.root.join("version"), r#"{"protocol":15,"build_id":"new-evidence","app_config_identity":"different"}"#).unwrap();
    assert!(matches!(repo.confirm(&state, &preview.confirmation_id).unwrap(), crate::TakeoverOutcome::Reconfirm { .. }));
    assert_eq!(peer.shutdowns(), 0);
}

#[test]
fn acknowledged_shutdown_with_held_lease_never_attaches_replacement() {
    let repo = TakeoverRepo::new();
    let peer = TakeoverPeer::start(&repo.0, "old");
    fs::write(peer.root.join("ack"), "HOLD_LEASE").unwrap();
    let state = AppState::default();
    let preview = repo.prepare(&state, "old");
    assert!(repo.confirm(&state, &preview.confirmation_id).unwrap_err().contains("exit not established"));
    assert_eq!(peer.shutdowns(), 1);
    assert!(!state.daemon_attached(&repo.0));
    assert!(!crate::current_alineryd_socket_path(&repo.0).exists());
    assert!(alinery_core::lockfile::try_lock_exclusive(&alinery_core::alineryd_lock_path(&repo.0, Some("old")))
        .unwrap()
        .is_none());
}

#[test]
fn replacement_start_failure_preserves_history_without_restarting_owner() {
    if std::env::var_os("ALINERY_TEST_TAKEOVER_FAILED_INSTALL").is_none() {
        let install = TakeoverRepo::new();
        let executable = install.0.join("app-tests");
        fs::hard_link(std::env::current_exe().unwrap(), &executable).unwrap();
        fs::write(install.0.join("alinery-vinculum-daemon"), "not an executable").unwrap();
        let result = Command::new(executable)
            .args([
                "--exact",
                "tests::daemon::replacement_start_failure_preserves_history_without_restarting_owner",
                "--nocapture",
            ])
            .env("ALINERY_TEST_TAKEOVER_FAILED_INSTALL", "1")
            .status()
            .unwrap();
        assert!(result.success());
        return;
    }
    let repo = TakeoverRepo::new();
    write_retained_discovery_task(&repo.0, "task", "old", false);
    let path = alinery_core::execution::execution_state_path(&repo.0, "task").unwrap();
    let before = fs::read(&path).unwrap();
    let mut peer = TakeoverPeer::start(&repo.0, "old");
    let state = AppState::default();
    let preview = repo.prepare(&state, "old");
    assert!(repo.confirm(&state, &preview.confirmation_id).unwrap_err().contains("replacement failed"));
    assert!(peer.child.wait().unwrap().success());
    assert_eq!(peer.shutdowns(), 1);
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(!state.daemon_attached(&repo.0));
    assert!(!alinery_core::alineryd_socket_path(&repo.0, Some("old")).exists());
    assert!(!crate::current_alineryd_socket_path(&repo.0).exists());
}

#[test]
fn rpc_secrets_are_random_hex_kept_per_repo_and_lane_and_handed_off_owner_only() {
    use crate::daemon::{new_rpc_secret, rpc_secret_path, store_rpc_secret, write_rpc_secret_handoff};
    use std::os::unix::fs::PermissionsExt;
    let (a, b) = (new_rpc_secret().unwrap(), new_rpc_secret().unwrap());
    assert!(a.len() == 64 && a.bytes().all(|c| c.is_ascii_hexdigit()), "{a}");
    assert_ne!(a, b);

    let dir = std::env::temp_dir().join(format!("alinery-rpc-secrets-{}", uuid::Uuid::new_v4().simple()));
    let paths = [
        rpc_secret_path(&dir, "/repo/a", ""),
        rpc_secret_path(&dir, "/repo/a", "d0123"),
        rpc_secret_path(&dir, "/repo/b", ""),
    ];
    assert_eq!(paths.iter().collect::<std::collections::BTreeSet<_>>().len(), 3, "{paths:?}");
    store_rpc_secret(&dir, "/repo/a", "", &a).unwrap();
    store_rpc_secret(&dir, "/repo/b", "", &b).unwrap();
    assert_eq!(fs::read_to_string(&paths[0]).unwrap(), a);
    assert_eq!(fs::read_to_string(&paths[2]).unwrap(), b);
    assert!(!paths[1].exists());
    assert_eq!(fs::metadata(&paths[0]).unwrap().permissions().mode() & 0o777, 0o600);
    // A restart replaces the copy with the new daemon's token.
    store_rpc_secret(&dir, "/repo/a", "", &b).unwrap();
    assert_eq!(fs::read_to_string(&paths[0]).unwrap(), b);

    let handoff = write_rpc_secret_handoff(&a).unwrap();
    assert_eq!(fs::read_to_string(&handoff).unwrap(), a);
    assert_eq!(fs::metadata(&handoff).unwrap().permissions().mode() & 0o777, 0o600);
    assert_ne!(handoff, write_rpc_secret_handoff(&a).unwrap());
    fs::remove_file(handoff).unwrap();
    fs::remove_dir_all(dir).unwrap();
}

/// S5.1: the managed MCP reads its AGENT tokens from this file, so it is owner-only and has the shape `mcpServer/endpoints.ts` parses.
#[test]
fn mcp_endpoints_file_is_owner_only_and_holds_the_shape_the_daemon_binary_reads() {
    use std::os::unix::fs::PermissionsExt;
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let root = std::env::temp_dir().join(format!("alinery-s5-1-endpoints-{n}"));
    let app_config = root.join("config").join("app.toml");
    let path = crate::mcp::mcp_endpoints_path(&app_config, None).unwrap();
    assert_eq!(path, root.join("config").join("mcp-endpoints.json"));
    assert!(crate::mcp::mcp_endpoints_path(&app_config, Some("dabc")).unwrap().ends_with("mcp-endpoints-dabc.json"));

    let mut repos = std::collections::BTreeMap::new();
    repos.insert("/work/a".to_string(), (PathBuf::from("/work/a/.alinery/rpc.sock"), "token-a".to_string()));
    crate::mcp::write_mcp_endpoints(&path, &repos).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    let parsed: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        parsed,
        serde_json::json!({"version": 1, "repos": {"/work/a": {"socket": "/work/a/.alinery/rpc.sock", "token": "token-a"}}})
    );

    let args = crate::mcp::mcp_host_args(&app_config, None);
    assert_eq!(args[0], "--mcp");
    assert_eq!(args[args.len() - 2], "--endpoints-file");
    assert_eq!(args[args.len() - 1], path.to_string_lossy());
    let _ = fs::remove_dir_all(&root);
}
