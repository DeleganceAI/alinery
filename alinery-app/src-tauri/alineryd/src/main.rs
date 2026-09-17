// alineryd — the persistent daemon that owns every session child (survives app restart).
// Listens on <repo>/.alinery/alineryd.sock by default; debug/dev builds use a namespaced socket.
//
// Protocol: one JSON request line per connection.
//   open/attach → reply {"ok":true}\n, then the connection becomes a raw PTY byte pipe:
//                 a reconstructed screen frame (not a raw tail — see #96) followed by live pty bytes.
//   rpc_attach → reply {"ok":true}\n, then the connection becomes a JSON-line pipe:
//                each child-stdout line, verbatim, including the trailing newline.
//   write/resize/detach/status/list/shutdown/restate/rpc_write → one JSON request, one JSON response line, close.
//
// The pty spawn + reader-thread + idle-tap logic is the in-process code that used to
// live in lib.rs open_session, moved here so it keeps running after the app quits.

// Use alinery-core for all pure FS/path/harness/phase/status logic (pty bits stay local to alineryd).
use alinery_core::{
    alinery_dir, alineryd_lock_path, alineryd_reconciler_lock_path, alineryd_socket_path, all_session_meta_paths, completion_decision, create_session_meta_for, get_playbook,
    list_tasks_for_repo, login_shell_path, normalized_session_status, process_exited, process_started, read_meta_launch_fields, read_session_meta_full, read_task,
    reduce_runner_event, resolve_launch_prompt, resolved_session_artifact_file, safe_component, session_meta_path, session_omp_dir, session_scrollback_path, sessions_dir,
    stamp_meta, strip_terminal_queries, subst, sweep_ends_session, validate_message_body, validate_task_session_start, write_message, AutoAdvanceCreate, CompletionDecision,
    CreateSessionInput, Harness, HarnessAdapter, LaunchFields, MessageAdapter, PlaybookState, ProcessState, RpcChunkAssembler, RunnerEvent, RunnerEventEnvelope, SessionMeta,
    SessionState, SessionTransport, Task, DAEMON_CONTROL_TIMEOUT, DEFAULT_PLAYBOOK_KEY, NO_HARNESS_KEY, PROTOCOL_VERSION, RUNNER_EVENT_PROTOCOL_VERSION,
};

use alinery_core::daemon_client::{control_request_size_error, MAX_CONTROL_REQUEST_BYTES};
use alinery_core::lockfile::{try_lock_exclusive, LockFile};

use std::collections::{HashMap, VecDeque};
use std::env;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{self, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc, Arc, Condvar, Mutex,
};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};

const MAX_EVENT_REQUEST_BYTES: usize = 128 * 1024;
const MAX_MESSAGE_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_IN_FLIGHT_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const INITIAL_PROMPT_TIMEOUT: Duration = Duration::from_secs(2);
const OMP_HOST_PROTECTION_ERROR: &str = "OMP host protection is unavailable; restart the daemon from Alinery before starting this OMP session";
const SPAWN_ROLLBACK_REAP_TIMEOUT: Duration = Duration::from_secs(2);
const RPC_PENDING_MAX_BYTES: usize = 1024 * 1024;
const WRONG_TRANSPORT: &str = "wrong-transport";

#[derive(Clone, Copy, PartialEq, Eq)]
enum SpawnLifecycle {
    Pending,
    Committed,
    Aborted,
}

enum SessionIo {
    Pty {
        writer: Arc<Mutex<Box<dyn Write + Send>>>,
        master: Box<dyn MasterPty + Send>,
        scrollback_path: PathBuf,
    },
    Rpc {
        stdin: Arc<Mutex<process::ChildStdin>>,
    },
}

struct Inner {
    // PTY only. RPC sessions have no vt100 emulator.
    parser: Option<vt100::Parser>,
    // (attach_id, live byte/line sink). PTY reader enqueues raw chunks; RPC reader enqueues
    // one stdout line (including newline) per event.
    clients: Vec<(u64, ClientSink)>,
    // RPC stdout lines for the turn currently in flight, replayed to a client that attaches
    // mid-turn. Cleared when the turn closes: its content is durable in OMP's journal by then,
    // and replaying it again would render the turn a second time above the new client's live
    // output. Cap RPC_PENDING_MAX_BYTES, drop oldest. Never written to disk.
    rpc_pending: VecDeque<Vec<u8>>,
    rpc_pending_bytes: usize,
    // The one-shot `ready` handshake, held outside the ring so neither turn eviction nor the
    // byte cap can drop it. OMP emits it once at spawn; without it every later attach pays a
    // full 2s wait for a line that will never come again.
    rpc_ready: Option<Vec<u8>>,
    completion_in_flight: bool,
    state: SessionState,
}

struct Sess {
    io: SessionIo,
    inner: Arc<Mutex<Inner>>,
    // Harness child pid (== process-group leader) for an explicit process-group kill
    // (issue #24 P6). None only if the OS didn't report one.
    pid: Option<u32>,
    // Meta path for fallback ended_at stamps during graceful teardown (Fix 2).
    meta_path: PathBuf,
    // Authenticates runner events for this live session only. Never persisted.
    event_token: String,
    task_slug: String,
    // Restate in-flight: reader EOF must not stamp ended_at / exit_code.
    replacing: Arc<AtomicBool>,
}

impl Sess {
    fn transport(&self) -> SessionTransport {
        match self.io {
            SessionIo::Pty { .. } => SessionTransport::Pty,
            SessionIo::Rpc { .. } => SessionTransport::Rpc,
        }
    }
}

type Registry = Arc<Mutex<HashMap<String, Sess>>>;
type ProtectedHost = Arc<Option<PathBuf>>;

type MessageBudget = Arc<AtomicUsize>;

#[derive(Debug)]
struct MessageBudgetReservation {
    budget: MessageBudget,
    bytes: usize,
}

impl Drop for MessageBudgetReservation {
    fn drop(&mut self) {
        self.budget.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

#[derive(Debug)]
struct MessageBody {
    bytes: Vec<u8>,
    _reservation: MessageBudgetReservation,
}

fn reserve_message_bytes(budget: &MessageBudget, bytes: usize) -> Result<MessageBudgetReservation, String> {
    budget
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            current.checked_add(bytes).filter(|next| *next <= MAX_IN_FLIGHT_MESSAGE_BYTES)
        })
        .map_err(|_| "message-in-flight-budget-exceeded".to_string())?;
    Ok(MessageBudgetReservation { budget: budget.clone(), bytes })
}

// The pty's fixed geometry at spawn time; kept as constants so the openpty call and the
// parser construction can't drift apart. A reattach with a client's real geometry resizes
// both (Step 5/6).
const PTY_ROWS: u16 = 40;
const PTY_COLS: u16 = 120;

// A client byte-sink MUST NEVER block the pty reader thread: that thread also drains the pty
// master, so a stalled sink would fill the pty's kernel buffer and block the harness process.
// Each client therefore gets a fixed byte-budgeted queue and a dedicated blocking writer thread.
// The fixed budget applies only to live bytes queued behind this writer. Initial replay is owned
// by the writer thread directly, so durable history can exceed the live backlog without blocking
// the PTY reader or weakening stuck-client pruning.
const CLIENT_BACKLOG_BYTES: usize = 2 * 1024 * 1024;
const ATTACH_REPLAY_BYTES: u64 = 8 * 1024 * 1024;

struct ClientQueue {
    chunks: VecDeque<Vec<u8>>,
    queued_bytes: usize,
    closed: bool,
}

struct ClientSink {
    shared: Arc<(Mutex<ClientQueue>, Condvar)>,
}

impl ClientSink {
    fn new(stream: UnixStream) -> Self {
        Self::with_initial(stream, Vec::new())
    }

    fn with_initial(mut stream: UnixStream, initial: Vec<Vec<u8>>) -> Self {
        let _ = stream.set_nonblocking(false);
        let shared = Arc::new((
            Mutex::new(ClientQueue {
                chunks: VecDeque::new(),
                queued_bytes: 0,
                closed: false,
            }),
            Condvar::new(),
        ));
        let writer_shared = Arc::clone(&shared);

        std::thread::spawn(move || {
            for chunk in initial {
                if stream.write_all(&chunk).and_then(|_| stream.flush()).is_err() {
                    let (queue, ready) = &*writer_shared;
                    let mut queue = queue.lock().unwrap_or_else(|e| e.into_inner());
                    queue.closed = true;
                    queue.chunks.clear();
                    queue.queued_bytes = 0;
                    ready.notify_all();
                    return;
                }
            }

            loop {
                let chunk = {
                    let (queue, ready) = &*writer_shared;
                    let mut queue = queue.lock().unwrap_or_else(|e| e.into_inner());
                    while queue.chunks.is_empty() && !queue.closed {
                        queue = ready.wait(queue).unwrap_or_else(|e| e.into_inner());
                    }
                    if queue.closed {
                        return;
                    }
                    let chunk = queue.chunks.pop_front().expect("non-empty client queue");
                    queue.queued_bytes -= chunk.len();
                    chunk
                };

                if stream.write_all(&chunk).and_then(|_| stream.flush()).is_err() {
                    let (queue, ready) = &*writer_shared;
                    let mut queue = queue.lock().unwrap_or_else(|e| e.into_inner());
                    queue.closed = true;
                    queue.chunks.clear();
                    queue.queued_bytes = 0;
                    ready.notify_all();
                    return;
                }
            }
        });

        Self { shared }
    }

    fn try_enqueue(&self, mut bytes: Vec<u8>) -> bool {
        let (queue, ready) = &*self.shared;
        let mut queue = queue.lock().unwrap_or_else(|e| e.into_inner());
        let Some(queued_bytes) = queue.queued_bytes.checked_add(bytes.len()) else {
            return false;
        };
        if queue.closed || queued_bytes > CLIENT_BACKLOG_BYTES {
            return false;
        }
        let coalesce = queue.chunks.back().and_then(|last| last.len().checked_add(bytes.len())).is_some_and(|len| len <= 8192);
        if coalesce {
            queue.chunks.back_mut().expect("checked above").append(&mut bytes);
        } else {
            queue.chunks.push_back(bytes);
        }
        queue.queued_bytes = queued_bytes;
        ready.notify_one();
        true
    }
}

impl Drop for ClientSink {
    fn drop(&mut self) {
        let (queue, ready) = &*self.shared;
        let mut queue = queue.lock().unwrap_or_else(|e| e.into_inner());
        queue.closed = true;
        queue.chunks.clear();
        queue.queued_bytes = 0;
        ready.notify_all();
    }
}

fn ack_line() -> Vec<u8> {
    let mut v = serde_json::to_vec(&json!({"ok": true})).unwrap_or_default();
    v.push(b'\n');
    v
}

fn usage() -> ! {
    eprintln!(
        "usage: alineryd --repo <path> [--build-id <id>] [--socket-namespace <name>]\n\
                alineryd --protocol-version"
    );
    process::exit(1);
}

fn canonical_protected_host(path: Option<PathBuf>) -> Option<PathBuf> {
    let canonical = fs::canonicalize(path?).ok()?;
    let metadata = fs::metadata(&canonical).ok()?;
    (metadata.is_file() && metadata.permissions().mode() & 0o111 != 0).then_some(canonical)
}

fn main() {
    let protected_host = Arc::new(canonical_protected_host(
        env::var_os("ALINERY_HOST_EXECUTABLE").filter(|value| !value.is_empty()).map(PathBuf::from),
    ));
    env::remove_var("ALINERY_HOST_EXECUTABLE");
    let args: Vec<String> = env::args().collect();
    let mut repo: Option<PathBuf> = None;
    let mut build_id: Arc<str> = Arc::from("");
    let mut daemon_namespace: Arc<str> = Arc::from("");
    let mut app_config: Option<PathBuf> = None;
    let mut i = 1usize;
    while i < args.len() {
        match args[i].as_str() {
            // Load-bearing for the installer (E1): it runs the *extracted* bundle's
            // alineryd to learn the incoming release's protocol, with no repo context.
            "--protocol-version" => {
                println!("{PROTOCOL_VERSION}");
                process::exit(0);
            }
            "--repo" if i + 1 < args.len() => {
                repo = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--build-id" if i + 1 < args.len() => {
                build_id = Arc::from(args[i + 1].as_str());
                i += 2;
            }
            "--socket-namespace" if i + 1 < args.len() => {
                daemon_namespace = Arc::from(args[i + 1].as_str());
                i += 2;
            }
            "--app-config" if i + 1 < args.len() => {
                app_config = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            _ => usage(),
        }
    }
    let Some(repo) = repo else { usage() };
    // Developer-invocation artefact, not a product path: a daemon started without
    // `--app-config` and without a resolvable `app_config_toml_path()` logs into a per-repo `logs/`.
    let app_config = Arc::new(
        app_config
            .or_else(alinery_core::app_config_toml_path)
            .unwrap_or_else(|| repo.join(".alinery").join("app.toml")),
    );
    let app_config_identity: Arc<str> = Arc::from(alinery_core::app_config_identity(app_config.as_ref()));
    let alinery = alinery_dir(&repo);
    let namespace = (!daemon_namespace.is_empty()).then_some(daemon_namespace.as_ref());
    let socket_path = alineryd_socket_path(&repo, namespace);
    let lock_path = alineryd_lock_path(&repo, namespace);

    let _ = fs::create_dir_all(&alinery);

    // Real flock singleton (Fix 1 / RC4). Hold for process life; kernel releases on any death.
    // Policy: never unlink the lock file — flock is the only truth.
    let _lane_lock = match acquire_lane_lock(&lock_path, &socket_path) {
        Ok(l) => l,
        Err(msg) => {
            alinery_core::append_exception(app_config.as_ref(), &format!("daemon.lane-lock-failed err={}", alinery_core::quote_log_value(&msg)));
            eprintln!("{msg}");
            process::exit(1);
        }
    };

    let listener = match UnixListener::bind(&socket_path) {
        Ok(l) => l,
        Err(e) => {
            // A too-long socket path (macOS ~104-byte sun_path limit under a deep worktree)
            // or a permissions error must fail cleanly, not panic-abort the daemon.
            alinery_core::append_exception(
                app_config.as_ref(),
                &format!(
                    "daemon.bind-failed socket={} err={}",
                    alinery_core::quote_log_value(&socket_path.display().to_string()),
                    alinery_core::quote_log_value(&e.to_string())
                ),
            );
            eprintln!("alineryd: bind {socket_path:?} failed: {e}");
            process::exit(1);
        }
    };
    // Keep accept non-blocking-ish via short timeouts so the signal self-pipe can be polled
    // from the main loop without a dedicated reactor crate.
    let _ = listener.set_nonblocking(true);
    eprintln!("alineryd listening on {socket_path:?}");
    alinery_core::append_info(
        app_config.as_ref(),
        &format!(
            "daemon.listening repo={} ns={} socket={} protocol={PROTOCOL_VERSION}",
            alinery_core::quote_log_value(&repo.display().to_string()),
            alinery_core::quote_log_value(daemon_namespace.as_ref()),
            alinery_core::quote_log_value(&socket_path.display().to_string()),
        ),
    );

    // Boot sweep: any session with started_at but no ended_at was interrupted by a daemon
    // crash/quit (we never got to stamp its exit). Mark it ended (exit_code left absent ⇒
    // classified Interrupted) so it can't masquerade as still-running. Per-file tolerant.
    // Must finish before we accept connections (T9).
    let swept = boot_sweep(&repo, &daemon_namespace);
    if swept > 0 {
        eprintln!("boot sweep: marked {swept} interrupted session(s)");
        alinery_core::append_info(app_config.as_ref(), &format!("daemon.boot-sweep interrupted={swept}"));
    }

    let reg: Registry = Arc::new(Mutex::new(HashMap::new()));
    let message_budget: MessageBudget = Arc::new(AtomicUsize::new(0));
    start_auto_advance_reconciler(repo.clone(), reg.clone(), daemon_namespace.to_string(), app_config.as_ref().clone(), protected_host.clone());

    // Signal self-pipe: handler writes one byte; main loop reads and graceful_exits.
    let mut signal_rx = install_signal_self_pipe();

    loop {
        // Drain signal pipe (non-blocking).
        if let Some(rx) = signal_rx.as_mut() {
            let mut buf = [0u8; 8];
            match rx.read(&mut buf) {
                Ok(n) if n > 0 => {
                    graceful_exit(&reg, &socket_path);
                }
                _ => {}
            }
        }

        match listener.accept() {
            Ok((stream, _)) => {
                let reg = reg.clone();
                let message_budget = message_budget.clone();
                let repo = repo.clone();
                let lock_path = lock_path.clone();
                let socket_path = socket_path.clone();
                let build_id = build_id.clone();
                let daemon_namespace = daemon_namespace.clone();
                let app_config = app_config.clone();
                let app_config_identity = app_config_identity.clone();
                let protected_host = protected_host.clone();
                std::thread::spawn(move || {
                    handle_conn(
                        stream,
                        &reg,
                        &message_budget,
                        &repo,
                        &lock_path,
                        &socket_path,
                        &daemon_namespace,
                        &build_id,
                        &app_config_identity,
                        &app_config,
                        &protected_host,
                    );
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// tmux-style lane acquire: connect-before-unlink, flock held across reclaim→bind fence.
fn acquire_lane_lock(lock_path: &Path, socket_path: &Path) -> Result<LockFile, String> {
    // 1. Unconditional connect probe — live socket ⇒ another daemon owns this lane.
    if UnixStream::connect(socket_path).is_ok() {
        return Err("daemon already running for repo".into());
    }

    // 2. Exclusive flock with short retries (startup races with a dying peer).
    let mut lock = None;
    for _ in 0..10 {
        match try_lock_exclusive(lock_path) {
            Ok(Some(l)) => {
                lock = Some(l);
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("lock {}: {e}", lock_path.display())),
        }
    }
    let Some(lock) = lock else {
        return Err("daemon already running for repo (lock held)".into());
    };

    // 3. Socket is now-provably stale (or absent) — reclaim and let caller bind.
    let _ = fs::remove_file(socket_path);
    Ok(lock)
}

/// SIGTERM/SIGINT/SIGHUP → write one byte on a pipe the main loop polls.
/// Returns the read end, or None if pipe/sigaction setup failed (daemon still runs).
fn install_signal_self_pipe() -> Option<std::fs::File> {
    use std::os::unix::io::FromRawFd;

    let mut fds = [0i32; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return None;
    }
    let (rfd, wfd) = (fds[0], fds[1]);
    // Non-blocking read end so the accept loop can poll.
    unsafe {
        let flags = libc::fcntl(rfd, libc::F_GETFL);
        if flags >= 0 {
            let _ = libc::fcntl(rfd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
    }
    // Leak the write fd into a static so the handler can write without capturing state.
    // SAFETY: single assignment at boot; handler only writes one byte.
    unsafe {
        SIGNAL_PIPE_WFD = wfd;
    }

    unsafe {
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = signal_handler as *const () as usize;
        sa.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut sa.sa_mask);
        libc::sigaction(libc::SIGTERM, &sa, std::ptr::null_mut());
        libc::sigaction(libc::SIGINT, &sa, std::ptr::null_mut());
        libc::sigaction(libc::SIGHUP, &sa, std::ptr::null_mut());
    }

    // SAFETY: rfd is an open fd we own; File takes ownership.
    Some(unsafe { std::fs::File::from_raw_fd(rfd) })
}

static mut SIGNAL_PIPE_WFD: i32 = -1;

extern "C" fn signal_handler(_sig: libc::c_int) {
    let wfd = unsafe { SIGNAL_PIPE_WFD };
    if wfd >= 0 {
        let b = [1u8];
        unsafe {
            let _ = libc::write(wfd, b.as_ptr() as *const _, 1);
        }
    }
}

/// Kill every live session, stamp any stragglers, unlink socket (never lock), exit.
fn graceful_exit(reg: &Registry, socket_path: &Path) -> ! {
    kill_all_sessions(reg);
    let _ = fs::remove_file(socket_path);
    // Drop lock by process exit — do NOT unlink lock_path.
    process::exit(0);
}

/// (session id, harness pid, shared inner state, meta path) — snapshot for teardown.
type KillSnapshot = (String, Option<u32>, Arc<Mutex<Inner>>, PathBuf);

/// Batch form of the per-session kill ladder. Guarantees every owned session meta has
/// `ended_at` before return (reader stamp preferred; direct stamp fallback).
fn kill_all_sessions(reg: &Registry) {
    let snapshot: Vec<KillSnapshot> = {
        let map = reg.lock().unwrap_or_else(|e| e.into_inner());
        map.iter().map(|(id, s)| (id.clone(), s.pid, s.inner.clone(), s.meta_path.clone())).collect()
    };

    // Has the reader thread finished reaping this session?
    let reaped = |inner: &Arc<Mutex<Inner>>| -> bool { matches!(inner.lock().unwrap_or_else(|e| e.into_inner()).state.process, ProcessState::Exited { .. }) };
    // Poll ALL sessions within one bounded window (concurrent, not sequential per session,
    // so N SIGTERM-ignoring sessions can't blow the shutdown budget with N×2s).
    let wait_all = |steps: u32| -> bool {
        for _ in 0..steps {
            if snapshot.iter().all(|(_, _, inner, _)| reaped(inner)) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        false
    };

    // SIGTERM every live group first. Skip already-Exited sessions: the reader thread has
    // already child.wait()'d their pid, which the OS may have reused for another process.
    for (_, pid, inner, _) in &snapshot {
        if let (Some(pid), false) = (pid, reaped(inner)) {
            unsafe { libc::killpg(*pid as i32, libc::SIGTERM) };
        }
    }

    // ≤1s grace, then SIGKILL the stragglers, then ≤1s more.
    if !wait_all(40) {
        for (_, pid, inner, _) in &snapshot {
            if let (Some(pid), false) = (pid, reaped(inner)) {
                unsafe { libc::killpg(*pid as i32, libc::SIGKILL) };
            }
        }
        let _ = wait_all(40);
    }

    // Fallback stamp: anything still not Exited gets ended_at now (no exit_code).
    let now = now_secs();
    for (_, _, inner, meta_path) in &snapshot {
        let mut state = inner.lock().unwrap_or_else(|e| e.into_inner());
        if !matches!(state.state.process, ProcessState::Exited { .. }) {
            let candidate = process_exited(&state.state, None);
            let before = state.state.clone();
            let _ = stamp_meta(meta_path, |value| {
                if value.get("ended_at").and_then(|x| x.as_u64()).is_none() {
                    value["ended_at"] = json!(now);
                }
                stamp_status_transition(value, &before, &candidate, now);
            });
            state.state = candidate;
        }
    }

    reg.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn advance_status_revision(value: &mut Value) {
    let previous = value.get("status_revision").and_then(Value::as_u64).unwrap_or(0);
    value["status_revision"] = json!(previous.saturating_add(1));
}

fn stamp_status_transition(value: &mut Value, before: &SessionState, after: &SessionState, now: u64) -> bool {
    if normalized_session_status(before) == normalized_session_status(after) {
        return false;
    }
    let previous = value.get("status_changed_at").and_then(Value::as_u64).unwrap_or(0);
    value["status_changed_at"] = json!(now.max(previous));
    advance_status_revision(value);
    true
}

// Mark this daemon namespace's started-but-unended sessions as interrupted.
// Runs once at daemon boot, before any connection. Malformed/absent metas are skipped.
fn boot_sweep(repo: &Path, daemon_namespace: &str) -> usize {
    let mut swept = 0usize;
    let now = now_secs();
    for path in all_session_meta_paths(repo) {
        let Some(meta) = read_session_meta_full(&path) else {
            continue;
        };
        if meta.daemon_namespace != daemon_namespace || !sweep_ends_session(meta.started_at, meta.ended_at) {
            continue;
        }
        // Prefer scrollback mtime (flushed ~2s while bytes flow) clamped to started_at..=now.
        let ended = {
            // scrollback sidecar sibling: foo.meta.json → foo.scrollback
            let scroll = {
                let s = path.to_string_lossy();
                match s.strip_suffix(".meta.json") {
                    Some(base) => PathBuf::from(format!("{base}.scrollback")),
                    None => path.with_extension("scrollback"),
                }
            };
            let mtime = fs::metadata(&scroll)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            match (meta.started_at, mtime) {
                (Some(started), Some(mt)) => {
                    // clamp panics if min > max; a backward clock step (started > now)
                    // would otherwise crash-loop the daemon at boot. Guard it.
                    if started > now {
                        now
                    } else {
                        mt.clamp(started, now)
                    }
                }
                _ => now,
            }
        };
        if stamp_meta(&path, |value| {
            value["ended_at"] = json!(ended);
            let previous = value.get("status_changed_at").and_then(Value::as_u64).unwrap_or(0);
            value["status_changed_at"] = json!(now.max(previous));
            advance_status_revision(value);
        })
        .is_ok()
        {
            swept += 1;
        }
    }
    swept
}

#[derive(Debug, PartialEq, Eq)]
enum RequestLineError {
    Closed,
    TooLarge,
}

// Peek in chunks, then consume only through the newline: send_message's body
// must stay on the socket. Reading byte-by-byte makes accepted image sets slow.
fn read_line(stream: &mut UnixStream, max_bytes: usize) -> Result<String, RequestLineError> {
    let mut line = Vec::with_capacity(1024.min(max_bytes));
    let mut chunk = [0u8; 16 * 1024];
    let mut too_large = false;
    loop {
        // SAFETY: the fd is live and chunk is writable for exactly chunk.len() bytes.
        let peeked = unsafe { libc::recv(stream.as_raw_fd(), chunk.as_mut_ptr().cast(), chunk.len(), libc::MSG_PEEK) };
        if peeked < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        if peeked <= 0 {
            return Err(if too_large { RequestLineError::TooLarge } else { RequestLineError::Closed });
        }
        let newline = chunk[..peeked as usize].iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(peeked as usize, |index| index + 1);
        stream.read_exact(&mut chunk[..count]).map_err(|_| RequestLineError::Closed)?;
        let content_len = newline.unwrap_or(count);
        if !too_large {
            if content_len > max_bytes - line.len() {
                too_large = true;
                line.clear();
            } else {
                line.extend_from_slice(&chunk[..content_len]);
            }
        }
        // Drain an oversized line without retaining it so write-then-read clients
        // can finish writing and receive the rejection instead of a broken pipe.
        if newline.is_some() {
            return if too_large {
                Err(RequestLineError::TooLarge)
            } else {
                String::from_utf8(line).map_err(|_| RequestLineError::Closed)
            };
        }
    }
}

fn read_message_body(stream: &mut UnixStream, request: &Value, budget: &MessageBudget) -> Result<MessageBody, String> {
    let body_bytes = request
        .get("body_bytes")
        .and_then(Value::as_u64)
        .and_then(|bytes| usize::try_from(bytes).ok())
        .ok_or_else(|| "invalid-message-body-length".to_string())?;
    if body_bytes == 0 {
        return Err("message-body-empty".to_string());
    }
    if body_bytes > MAX_MESSAGE_BODY_BYTES {
        return Err("message-body-too-large".to_string());
    }
    let reservation = reserve_message_bytes(budget, body_bytes)?;
    let mut body = Vec::new();
    body.try_reserve_exact(body_bytes).map_err(|_| "message-body-too-large".to_string())?;
    body.resize(body_bytes, 0);
    stream.read_exact(&mut body).map_err(|error| format!("read-message-body: {error}"))?;
    std::str::from_utf8(&body).map_err(|_| "message-body-invalid-utf8".to_string())?;
    Ok(MessageBody {
        bytes: body,
        _reservation: reservation,
    })
}

fn reply(stream: &mut UnixStream, v: Value) {
    let _ = writeln!(stream, "{v}");
}

fn message_error_response(error: impl Into<String>, delivery: &str) -> Value {
    json!({"error": error.into(), "delivery": delivery})
}

fn reply_message_error(stream: &mut UnixStream, error: impl Into<String>, delivery: &str) {
    reply(stream, message_error_response(error, delivery));
}

fn write_and_flush_message<W: Write + ?Sized>(writer: &mut W, adapter: MessageAdapter, body: &[u8]) -> Result<(), String> {
    write_message(adapter, writer, body)
        .map_err(|error| format!("write-message: {error}"))
        .and_then(|_| writer.flush().map_err(|error| format!("flush-message: {error}")))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CompletionEventAction {
    NotNeeded,
    Attempt,
    InFlight,
}

fn completion_event_action(required: bool, in_flight: &mut bool) -> CompletionEventAction {
    if !required {
        CompletionEventAction::NotNeeded
    } else if *in_flight {
        CompletionEventAction::InFlight
    } else {
        *in_flight = true;
        CompletionEventAction::Attempt
    }
}

fn start_auto_advance_once(repo: PathBuf, reg: Registry, daemon_namespace: String, app_config: PathBuf, protected_host: ProtectedHost) {
    std::thread::spawn(move || {
        if let Ok(Some(_lease)) = try_lock_exclusive(&alineryd_reconciler_lock_path(&repo)) {
            reconcile_auto_advance_repo(&repo, &reg, &daemon_namespace, &app_config, &protected_host);
        }
    });
}

fn accept_phase_completion(
    reg: &Registry,
    repo: &Path,
    session_id: &str,
    task_slug: &str,
    omp_session_id: &str,
    omp_turn_id: Option<u64>,
    meta_path: &Path,
    app_config: &Path,
) -> Result<(), String> {
    let mut source = read_session_meta_full(meta_path).ok_or_else(|| "missing-session-meta".to_string())?;
    let task = read_task(repo, task_slug).ok_or_else(|| "missing-task".to_string())?;
    let playbook_key = source.playbook.clone();
    let playbook = get_playbook(repo, &playbook_key).ok_or_else(|| "missing-playbook".to_string())?;
    let sessions = read_task_session_metas(repo, task_slug)
        .into_iter()
        .filter(|session| session.playbook == playbook_key)
        .collect::<Vec<_>>();
    source.semantic.phase_completed_at = Some(now_secs());
    source.semantic.omp_session_id = Some(omp_session_id.to_string());
    source.semantic.omp_turn_id = omp_turn_id;

    if let CompletionDecision::Reject(reason) = completion_decision(repo, task_slug, &task, &playbook_key, &playbook, &source, &sessions) {
        set_live_playbook(reg, session_id, PlaybookState::Failed { reason: format!("{reason:?}") })?;
        return Err(format!("completion-rejected:{reason:?}"));
    }

    let completed_at = source.semantic.phase_completed_at;
    let omp_session_id = source.semantic.omp_session_id.clone();
    stamp_meta(meta_path, |value| {
        value["semantic"] = json!({
            "phase_completed_at": completed_at,
            "omp_session_id": omp_session_id,
            "omp_turn_id": omp_turn_id,
        });
    })?;
    alinery_core::record_event_with(app_config, || {
        let ids = alinery_core::telemetry_ids_for_session(repo, task_slug, session_id);
        alinery_core::TelemetryEvent::SessionPhaseComplete {
            phase: source.phase.clone(),
            playbook: playbook_key.clone(),
            session_id: ids.session,
            task_id: ids.task,
        }
    });
    set_live_playbook(reg, session_id, PlaybookState::ReadyToAdvance)?;

    Ok(())
}

fn emit_session_started(app_config: &Path, is_resume: bool, harness: &str, phase: &str, session_id: &str, task_id: &str) {
    let event = if is_resume {
        alinery_core::TelemetryEvent::SessionResume {
            harness: harness.to_string(),
            session_id: session_id.to_string(),
            task_id: task_id.to_string(),
        }
    } else {
        alinery_core::TelemetryEvent::SessionSpawn {
            harness: harness.to_string(),
            phase: phase.to_string(),
            session_id: session_id.to_string(),
            task_id: task_id.to_string(),
        }
    };
    alinery_core::record_event(app_config, event);
}

fn emit_session_exit(app_config: &Path, harness: &str, session_id: &str, task_id: &str, exit_code: Option<i32>) {
    alinery_core::record_event(
        app_config,
        alinery_core::TelemetryEvent::SessionExit {
            source: alinery_core::TelemetrySource::Alineryd,
            harness: harness.to_string(),
            exit_code,
            session_id: session_id.to_string(),
            task_id: task_id.to_string(),
        },
    );
}

fn process_accepts_runner_events(process: &ProcessState) -> bool {
    matches!(process, ProcessState::Starting | ProcessState::Alive)
}

fn publish_live_transition(inner: &mut Inner, meta_path: &Path, candidate: SessionState) -> Result<(), String> {
    let before = inner.state.clone();
    if normalized_session_status(&before) == normalized_session_status(&candidate) || matches!(before.process, ProcessState::Starting) {
        inner.state = candidate;
        return Ok(());
    }
    let now = now_secs();
    stamp_meta(meta_path, |value| {
        stamp_status_transition(value, &before, &candidate, now);
    })?;
    inner.state = candidate;
    Ok(())
}

fn handle_runner_event(req: &Value, reg: &Registry, repo: &Path, app_config: &Path) -> Result<bool, String> {
    let envelope: RunnerEventEnvelope = serde_json::from_value(req.clone()).map_err(|_| "invalid-event".to_string())?;
    if envelope.version != RUNNER_EVENT_PROTOCOL_VERSION {
        return Err("unsupported-event-version".into());
    }
    let (inner, meta_path, task_slug) = {
        let map = reg.lock().unwrap_or_else(|e| e.into_inner());
        let session = map.get(&envelope.session_id).ok_or_else(|| "unknown-session".to_string())?;
        if session.event_token != envelope.token {
            return Err("invalid-event-token".into());
        }
        (session.inner.clone(), session.meta_path.clone(), session.task_slug.clone())
    };

    let completion_action = {
        let mut state = inner.lock().unwrap_or_else(|e| e.into_inner());
        if !process_accepts_runner_events(&state.state.process) {
            return Err("session-exited".into());
        }
        if state.state.adapter != HarnessAdapter::Omp {
            return Err("unsupported-adapter".into());
        }
        let reduced = reduce_runner_event(&state.state, &envelope.event);
        publish_live_transition(&mut state, &meta_path, reduced.state)?;
        if matches!(envelope.event, RunnerEvent::PhaseCompleted { .. }) {
            completion_event_action(reduced.completion_attempt_required, &mut state.completion_in_flight)
        } else {
            CompletionEventAction::NotNeeded
        }
    };

    match (&envelope.event, completion_action) {
        (_, CompletionEventAction::InFlight) => Err("completion-in-progress".into()),
        (RunnerEvent::PhaseCompleted { omp_session_id, omp_turn_id }, CompletionEventAction::Attempt) => {
            let result = accept_phase_completion(reg, repo, &envelope.session_id, &task_slug, omp_session_id, *omp_turn_id, &meta_path, app_config);
            inner.lock().unwrap_or_else(|error| error.into_inner()).completion_in_flight = false;
            result?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn handle_conn(
    mut stream: UnixStream,
    reg: &Registry,
    message_budget: &MessageBudget,
    repo: &Path,
    lock_path: &Path,
    socket_path: &Path,
    daemon_namespace: &str,
    build_id: &str,
    app_config_identity: &str,
    app_config: &Path,
    protected_host: &ProtectedHost,
) {
    // The listener is non-blocking so the accept loop can poll the signal pipe.
    // On macOS accept() inherits O_NONBLOCK; a temporary gap must not be EOF.
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(DAEMON_CONTROL_TIMEOUT));
    let line = match read_line(&mut stream, MAX_CONTROL_REQUEST_BYTES) {
        Ok(line) => line,
        Err(RequestLineError::TooLarge) => {
            reply(&mut stream, json!({"error": control_request_size_error()}));
            return;
        }
        Err(RequestLineError::Closed) => return,
    };
    let line_len = line.len();
    let Ok(req) = serde_json::from_str::<Value>(&line) else {
        reply(&mut stream, json!({"error": "bad json"}));
        return;
    };
    drop(line);
    let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
    if op == "event" && line_len > MAX_EVENT_REQUEST_BYTES {
        reply(&mut stream, json!({"error": "request-too-large"}));
        return;
    }
    let id = || req.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();

    match op {
        // attach NEVER spawns: reconnect to a daemon-owned pty, or fail. This is the #24
        // guarantee — opening an orphaned (not-owned) session can't silently re-run it.
        "attach" => {
            let attach_id = req.get("attach_id").and_then(|v| v.as_u64()).unwrap_or(0);
            match attach_only(reg, &req, &mut stream, attach_id) {
                Ok(()) => {} // stream now owned by the session as a live client; keep it open
                Err(e) => reply(&mut stream, json!({ "error": e })),
            }
        }
        // spawn a fresh pty (or attach if already live). Refuses to re-spawn a session that
        // has already started but isn't owned (orphan) — that path is resume/start-fresh.
        "spawn" => {
            let attach_id = req.get("attach_id").and_then(|v| v.as_u64()).unwrap_or(0);
            match spawn_or_attach(reg, repo, app_config, &req, &mut stream, attach_id, daemon_namespace, protected_host) {
                Ok(()) => {}
                Err(e) => reply(&mut stream, json!({ "error": e })),
            }
        }
        // resume: reconnect a resume-capable harness to its prior conversation (resume_args, no
        // phase seed) on a fresh id, or attach if already live. The #24 explicit-resume path.
        "resume" => {
            let attach_id = req.get("attach_id").and_then(|v| v.as_u64()).unwrap_or(0);
            match resume_or_attach(reg, repo, app_config, &req, &mut stream, attach_id, daemon_namespace, protected_host) {
                Ok(()) => {}
                Err(e) => reply(&mut stream, json!({ "error": e })),
            }
        }
        "event" => match handle_runner_event(&req, reg, repo, app_config) {
            Ok(reconcile) => {
                reply(&mut stream, json!({"ok": true}));
                if reconcile {
                    start_auto_advance_once(
                        repo.to_path_buf(),
                        reg.clone(),
                        daemon_namespace.to_string(),
                        app_config.to_path_buf(),
                        protected_host.clone(),
                    );
                }
            }
            Err(error) => reply(&mut stream, json!({"error": error})),
        },
        "write" => {
            let data = req.get("data").and_then(|v| v.as_str()).unwrap_or("");
            // #119 T0-2: snapshot the per-session writer + inner Arc handles under the
            // registry lock, then DROP the global guard before the blocking PTY
            // write_all/flush. Holding the registry mutex across a write to a harness
            // that has stopped draining stdin (full kernel PTY input buffer) would
            // starve every other control op repo-wide. Mirror `kill`'s clone-then-drop.
            let handles = {
                let map = reg.lock().unwrap_or_else(|e| e.into_inner());
                match map.get(&id()) {
                    None => None,
                    Some(s) => match &s.io {
                        SessionIo::Rpc { .. } => Some(Err(WRONG_TRANSPORT)),
                        SessionIo::Pty { writer, .. } => Some(Ok((writer.clone(), s.inner.clone()))),
                    },
                }
            };
            match handles {
                None => reply(&mut stream, json!({"error": "unknown-session"})),
                Some(Err(error)) => reply(&mut stream, json!({"error": error})),
                Some(Ok((writer, inner))) => {
                    let process = inner.lock().unwrap_or_else(|e| e.into_inner()).state.process.clone();
                    if matches!(process, ProcessState::Exited { .. }) {
                        reply(&mut stream, json!({"error": "session-exited"}));
                        return;
                    }
                    let write_result = {
                        let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
                        w.write_all(data.as_bytes()).and_then(|_| w.flush())
                    };
                    match write_result {
                        Ok(()) => reply(&mut stream, json!({"ok": true})),
                        Err(e) => reply(&mut stream, json!({"error": format!("write-session: {e}")})),
                    }
                }
            }
        }
        "send_message" => {
            let body = match read_message_body(&mut stream, &req, message_budget) {
                Ok(body) => body,
                Err(error) => {
                    reply_message_error(&mut stream, error, "not_sent");
                    return;
                }
            };
            let handles = {
                let map = reg.lock().unwrap_or_else(|error| error.into_inner());
                match map.get(&id()) {
                    None => None,
                    Some(session) => match &session.io {
                        SessionIo::Rpc { .. } => Some(Err(WRONG_TRANSPORT)),
                        SessionIo::Pty { writer, .. } => Some(Ok((writer.clone(), session.inner.clone()))),
                    },
                }
            };
            let handles = match handles {
                None => {
                    reply_message_error(&mut stream, "unknown-session", "not_sent");
                    return;
                }
                Some(Err(error)) => {
                    reply_message_error(&mut stream, error, "not_sent");
                    return;
                }
                Some(Ok(handles)) => handles,
            };
            let (writer, inner) = handles;
            let mut writer = writer.lock().unwrap_or_else(|error| error.into_inner());
            let adapter = {
                let inner = inner.lock().unwrap_or_else(|error| error.into_inner());
                if inner.state.process != ProcessState::Alive {
                    Err("session-not-alive")
                } else if inner.state.message_adapter == MessageAdapter::Unsupported {
                    Err("message-adapter-unsupported")
                } else if inner.state.agent != alinery_core::AgentState::Idle {
                    Err("session-not-idle")
                } else {
                    Ok(inner.state.message_adapter)
                }
            };
            let adapter = match adapter {
                Ok(adapter) => adapter,
                Err(error) => {
                    reply_message_error(&mut stream, error, "not_sent");
                    return;
                }
            };
            if let Err(error) = validate_message_body(adapter, &body.bytes) {
                reply_message_error(&mut stream, error, "not_sent");
                return;
            }
            let result = write_and_flush_message(&mut **writer, adapter, &body.bytes);
            match result {
                Ok(()) => reply(&mut stream, json!({"ok": true})),
                Err(error) => reply_message_error(&mut stream, error, "unknown"),
            }
        }
        "resize" => {
            let cols = req.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
            let rows = req.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
            let result = {
                let mut map = reg.lock().unwrap_or_else(|e| e.into_inner());
                match map.get_mut(&id()) {
                    None => Ok(()),
                    Some(sess) => match &mut sess.io {
                        SessionIo::Rpc { .. } => Err(WRONG_TRANSPORT),
                        SessionIo::Pty { master, .. } => {
                            let _ = master.resize(PtySize {
                                rows,
                                cols,
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                            // Keep the emulator in lockstep with the pty: a resize-while-detached would
                            // otherwise leave the replayed frame at the old geometry. Guard against an
                            // explicit 0 from a client — set_size(0, _) would drop every cell irrecoverably.
                            if cols > 0 && rows > 0 {
                                if let Some(parser) = sess.inner.lock().unwrap_or_else(|e| e.into_inner()).parser.as_mut() {
                                    parser.screen_mut().set_size(rows, cols);
                                }
                            }
                            Ok(())
                        }
                    },
                }
            };
            match result {
                Ok(()) => reply(&mut stream, json!({"ok": true})),
                Err(error) => reply(&mut stream, json!({"error": error})),
            }
        }
        "detach" => {
            let attach_id = req.get("attach_id").and_then(|v| v.as_u64()).unwrap_or(0);
            let map = reg.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(sess) = map.get(&id()) {
                let mut inner = sess.inner.lock().unwrap_or_else(|e| e.into_inner());
                inner.clients.retain(|(aid, _)| *aid != attach_id);
            }
            reply(&mut stream, json!({"ok": true}));
        }
        // kill: terminate the harness process GROUP and reap it. SIGTERM first (clean-shutdown
        // chance), escalating to SIGKILL if it doesn't die within the grace — an interactive
        // shell or a SIGTERM-ignoring harness would otherwise leak its pty (the very leak this
        // phase exists to stop). The reader thread observes child EOF and stamps ended_at/exit_code
        // (flipping status to Exited LAST), so we wait for that before dropping the id — the row
        // then classifies Exited (read-only), not orphaned. Idempotent: unknown id => ok ack.
        // Bounded (~1s total) so the UI never blocks (issue #24 P6).
        "kill" => {
            let kid = id();
            let (pid, inner, cancelled_starting) = {
                let mut map = reg.lock().unwrap_or_else(|e| e.into_inner());
                let cancel_starting = map.get(&kid).is_some_and(|session| {
                    session.pid.is_none() && matches!(session.inner.lock().unwrap_or_else(|error| error.into_inner()).state.process, ProcessState::Starting)
                });
                if cancel_starting {
                    map.remove(&kid);
                    (None, None, true)
                } else {
                    match map.get(&kid) {
                        Some(session) => (session.pid, Some(session.inner.clone()), false),
                        None => (None, None, false),
                    }
                }
            };
            if cancelled_starting {
                reply(&mut stream, json!({"ok": true}));
                return;
            }
            // Poll the reader thread's status (Exited only AFTER it has reaped) for steps*25ms.
            let reaped = |inner: &Arc<Mutex<Inner>>, steps: u32| -> bool {
                for _ in 0..steps {
                    if matches!(inner.lock().unwrap_or_else(|e| e.into_inner()).state.process, ProcessState::Exited { .. }) {
                        return true;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                false
            };
            if let (Some(pid), Some(inner)) = (pid, inner.as_ref()) {
                // Skip signaling an already-Exited session: the reader thread has already
                // child.wait()'d its pid, which the OS may have reused for another process.
                let already_exited = matches!(inner.lock().unwrap_or_else(|e| e.into_inner()).state.process, ProcessState::Exited { .. });
                if !already_exited {
                    // Whole-group signal so the harness AND its children die (the pty makes
                    // the child a session/group leader).
                    unsafe { libc::killpg(pid as i32, libc::SIGTERM) };
                    if !reaped(inner, 20) {
                        // SIGTERM ignored (e.g. an interactive shell) — force it. SIGKILL
                        // can't be caught, so the child then EOFs and the reader reaps.
                        unsafe { libc::killpg(pid as i32, libc::SIGKILL) };
                        reaped(inner, 20);
                    }
                }
            }
            reg.lock().unwrap_or_else(|e| e.into_inner()).remove(&kid);
            reply(&mut stream, json!({"ok": true}));
        }
        "status" => {
            let value = {
                let map = reg.lock().unwrap_or_else(|e| e.into_inner());
                map.get(&id()).map(|sess| {
                    let state = sess.inner.lock().unwrap_or_else(|e| e.into_inner()).state.clone();
                    let mut value = serde_json::to_value(state).unwrap_or_else(|_| json!({"error": "encode-state"}));
                    if let Value::Object(fields) = &mut value {
                        fields.insert("transport".into(), json!(sess.transport()));
                    }
                    value
                })
            };
            match value {
                Some(value) => reply(&mut stream, value),
                None => reply(&mut stream, json!({"error": "unknown-session"})),
            }
        }
        "list" => {
            let map = reg.lock().unwrap_or_else(|e| e.into_inner());
            let sessions: Vec<Value> = map
                .iter()
                // The setup session has no task and no meta; surfacing it would put a phantom row
                // on the board and in every session count.
                .filter(|(id, _)| id.as_str() != OMP_SETUP_SESSION_ID)
                .map(|(id, sess)| {
                    let state = sess.inner.lock().unwrap_or_else(|e| e.into_inner()).state.clone();
                    let mut value = serde_json::to_value(state).unwrap_or_else(|_| json!({}));
                    if let Value::Object(fields) = &mut value {
                        fields.insert("id".into(), json!(id));
                        fields.insert("transport".into(), json!(sess.transport()));
                    }
                    value
                })
                .collect();
            reply(&mut stream, json!({ "sessions": sessions }));
        }
        "restate" => {
            let transport = match req.get("transport").and_then(|v| v.as_str()) {
                Some("pty") => SessionTransport::Pty,
                Some("rpc") => SessionTransport::Rpc,
                _ => {
                    reply(&mut stream, json!({"error": "missing transport"}));
                    return;
                }
            };
            match restate_session(reg, repo, app_config, daemon_namespace, protected_host, &id(), transport) {
                Ok(()) => reply(&mut stream, json!({"ok": true})),
                Err(e) => reply(&mut stream, json!({"error": e})),
            }
        }
        // Bring up (or reuse) the reserved setup session so the accounts dialog has something to
        // talk to before any real session exists. Returns its id; the caller then uses the normal
        // rpc_attach / rpc_write ops against it.
        "omp_setup" => match spawn_omp_setup_session(reg, repo, app_config, daemon_namespace, protected_host) {
            Ok(()) => reply(&mut stream, json!({"ok": true, "id": OMP_SETUP_SESSION_ID})),
            Err(error) => reply(&mut stream, json!({"error": error})),
        },
        "rpc_attach" => {
            let attach_id = req.get("attach_id").and_then(|v| v.as_u64()).unwrap_or(0);
            match rpc_attach_only(reg, &req, &mut stream, attach_id) {
                Ok(()) => {}
                Err(e) => reply(&mut stream, json!({ "error": e })),
            }
        }
        "rpc_write" => {
            let Some(payload) = req.get("payload").filter(|value| value.is_object()) else {
                reply(&mut stream, json!({"error": "missing payload"}));
                return;
            };
            let handles = {
                let map = reg.lock().unwrap_or_else(|e| e.into_inner());
                match map.get(&id()) {
                    None => None,
                    Some(s) => match &s.io {
                        SessionIo::Pty { .. } => Some(Err(WRONG_TRANSPORT)),
                        SessionIo::Rpc { stdin } => Some(Ok((stdin.clone(), s.inner.clone()))),
                    },
                }
            };
            match handles {
                None => reply(&mut stream, json!({"error": "unknown-session"})),
                Some(Err(error)) => reply(&mut stream, json!({"error": error})),
                Some(Ok((stdin, inner))) => {
                    let process = inner.lock().unwrap_or_else(|e| e.into_inner()).state.process.clone();
                    if matches!(process, ProcessState::Exited { .. }) {
                        reply(&mut stream, json!({"error": "session-exited"}));
                        return;
                    }
                    let write_result = {
                        let mut w = stdin.lock().unwrap_or_else(|e| e.into_inner());
                        writeln!(w, "{payload}").and_then(|_| w.flush())
                    };
                    match write_result {
                        Ok(()) => reply(&mut stream, json!({"ok": true})),
                        Err(e) => reply(&mut stream, json!({"error": format!("rpc-write: {e}")})),
                    }
                }
            }
        }
        "version" => {
            // Protocol, app-config identity, and host-guard readiness describe whether
            // this exact retained daemon is safe to reuse. Build id remains soft.
            reply(
                &mut stream,
                json!({
                    "protocol": PROTOCOL_VERSION,
                    "build_id": build_id,
                    "app_config_identity": app_config_identity,
                    "host_guard_ready": protected_host.as_ref().is_some(),
                }),
            );
        }
        "shutdown" => {
            // kill sessions + stamp metas, unlink socket, THEN ack so the app never
            // observes "shutdown done" while the socket still exists (Fix 2).
            // Never unlink the lock file — flock is the only singleton truth.
            let _ = lock_path; // retained in signature for protocol stability
            kill_all_sessions(reg);
            let _ = fs::remove_file(socket_path);
            reply(&mut stream, json!({"ok": true}));
            process::exit(0);
        }
        other => reply(&mut stream, json!({ "error": format!("unknown op {other}") })),
    }
}

// Attach to a live, daemon-owned session and replay its scrollback. NEVER creates a pty:
// an id the daemon doesn't own is an error, so the caller must decide (resume/start-fresh)
// instead of the daemon silently re-running the original prompt (issue #24).
fn attach_only(reg: &Registry, req: &Value, stream: &mut UnixStream, attach_id: u64) -> Result<(), String> {
    let id = req.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if id.is_empty() {
        return Err("missing id".into());
    }
    let size = client_size(req);
    let mut map = reg.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(sess) = map.get_mut(&id) {
        if matches!(sess.io, SessionIo::Rpc { .. }) {
            return Err(WRONG_TRANSPORT.into());
        }
        return attach_client(sess, stream, attach_id, size);
    }
    Err("unknown-session".into())
}

// (cols, rows) from a client's xterm, if it sent a valid one. `None` (an older app build, or
// the daemon-initiated reattach path) keeps the frame at pty geometry (#96 Step 7).
fn client_size(req: &Value) -> Option<(u16, u16)> {
    match (req.get("cols").and_then(|v| v.as_u64()), req.get("rows").and_then(|v| v.as_u64())) {
        (Some(c), Some(r)) if c > 0 && r > 0 => Some((c as u16, r as u16)),
        _ => None,
    }
}

// Reattach if the session's pty is still live (replay scrollback under the inner lock so
// no live byte slips between the snapshot and this client joining), else spawn fresh —
// unless the meta shows it already started (orphan), which we refuse (defense in depth).
fn spawn_or_attach(
    reg: &Registry,
    repo: &Path,
    app_config: &Path,
    req: &Value,
    stream: &mut UnixStream,
    attach_id: u64,
    daemon_namespace: &str,
    protected_host: &ProtectedHost,
) -> Result<(), String> {
    let id = req.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if id.is_empty() {
        return Err("missing id".into());
    }

    {
        let mut map = reg.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sess) = map.get_mut(&id) {
            return match sess.transport() {
                SessionTransport::Pty => attach_client(sess, stream, attach_id, client_size(req)),
                SessionTransport::Rpc => attach_rpc_client(sess, stream, attach_id),
            };
        }
    }

    let task_slug = req.get("task_slug").and_then(|value| value.as_str()).unwrap_or("").trim().to_string();
    if safe_component(&id).is_none() || (!task_slug.is_empty() && safe_component(&task_slug).is_none()) {
        return Err("invalid task or session id".into());
    }
    let empty_slug = task_slug.is_empty();
    let requested_model = req.get("model").and_then(|value| value.as_str()).unwrap_or("");
    let requested_phase = req.get("phase").and_then(|value| value.as_str()).unwrap_or("");
    let cwd = req.get("cwd").and_then(|value| value.as_str()).unwrap_or("");

    let launch = if empty_slug {
        let launch = read_meta_launch_fields(repo, &task_slug, &id).unwrap_or_else(|| LaunchFields {
            id: id.clone(),
            task_slug: task_slug.clone(),
            worktree: cwd.to_string(),
            playbook: DEFAULT_PLAYBOOK_KEY.to_string(),
            generic: false,
            subtask_manager: false,
            subtask_slug: String::new(),
            phase: requested_phase.to_string(),
            harness: NO_HARNESS_KEY.to_string(),
            model: requested_model.to_string(),
            created: 0,
            artifact: String::new(),
            handoff_artifact: String::new(),
            prompt_extra: String::new(),
            prompt: None,
            resume_token: String::new(),
        });
        if !allow_empty_slug_spawn(&launch.harness) {
            return Err("sessions must be attached to a task".into());
        }
        launch
    } else {
        validate_task_session_start(app_config, repo, &task_slug, &id)?
    };
    if !alinery_core::is_allowed_launch_harness(&launch.harness) {
        return Err(format!("unknown harness '{}'", launch.harness));
    }
    spawn_session(
        reg,
        repo,
        launch,
        initial_client(stream, attach_id)?,
        false,
        SessionTransport::Pty,
        false,
        None,
        daemon_namespace,
        app_config,
        protected_host,
    )?;
    ack_detached_open(stream, attach_id);
    Ok(())
}

fn allow_empty_slug_spawn(harness: &str) -> bool {
    harness == NO_HARNESS_KEY
}

// Resume: reconnect a resume-capable harness to its prior conversation via resume_args, on a
// NEW session id (the app mints the row carrying the old token). Idempotent attach if already
// live; never seeds the phase prompt (issue #24).
fn resume_or_attach(
    reg: &Registry,
    repo: &Path,
    app_config: &Path,
    req: &Value,
    stream: &mut UnixStream,
    attach_id: u64,
    daemon_namespace: &str,
    protected_host: &ProtectedHost,
) -> Result<(), String> {
    let id = req.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if id.is_empty() {
        return Err("missing id".into());
    }
    {
        let mut map = reg.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sess) = map.get_mut(&id) {
            return match sess.transport() {
                SessionTransport::Pty => attach_client(sess, stream, attach_id, client_size(req)),
                SessionTransport::Rpc => attach_rpc_client(sess, stream, attach_id),
            };
        }
    }
    let task_slug = req.get("task_slug").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if task_slug.trim().is_empty() {
        return Err("sessions must be attached to a task".into());
    }
    if let Some(meta) = read_session_meta_full(&session_meta_path(repo, &task_slug, &id)) {
        if meta.started_at.is_some() {
            return Err("already-started; use resume or start-fresh".into());
        }
    }
    let cwd = req.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
    let req_token = req.get("resume_token").and_then(|v| v.as_str()).unwrap_or("");
    let mut launch = read_meta_launch_fields(repo, &task_slug, &id).ok_or_else(|| "missing-session-meta".to_string())?;
    if launch.worktree.is_empty() {
        launch.worktree = cwd.to_string();
    }
    if !req_token.is_empty() {
        launch.resume_token = req_token.to_string();
    }
    if launch.resume_token.is_empty() {
        return Err("no resume token for this session".into());
    }
    if !alinery_core::is_allowed_launch_harness(&launch.harness) {
        return Err(format!("unknown harness '{}'", launch.harness));
    }
    spawn_session(
        reg,
        repo,
        launch,
        initial_client(stream, attach_id)?,
        true,
        SessionTransport::Pty,
        false,
        None,
        daemon_namespace,
        app_config,
        protected_host,
    )?;
    ack_detached_open(stream, attach_id);
    Ok(())
}

// Detached spawn/resume omit attach_id (the app Chat path). That is a control op: one JSON
// ack, then close. A non-zero attach_id keeps this socket as the first live client.
fn initial_client(stream: &mut UnixStream, attach_id: u64) -> Result<Option<(u64, UnixStream)>, String> {
    if attach_id == 0 {
        Ok(None)
    } else {
        Ok(Some((attach_id, stream.try_clone().map_err(|e| e.to_string())?)))
    }
}

fn ack_detached_open(stream: &mut UnixStream, attach_id: u64) {
    if attach_id == 0 {
        reply(stream, json!({ "ok": true }));
    }
}

fn build_seeded_prompt(repo: &Path, launch: &LaunchFields) -> Result<Option<String>, String> {
    resolve_launch_prompt(repo, launch)
}

fn augment_omp_seed(repo: &Path, launch: &LaunchFields, seeded: &mut Option<String>) -> Result<(), String> {
    if launch.phase.trim().is_empty() {
        return Ok(());
    }
    let explicit_empty = launch.prompt.as_deref() == Some("");
    if seeded.is_none() && !explicit_empty {
        return Ok(());
    }
    let artifact = resolved_session_artifact_file(repo, &launch.task_slug, &launch.playbook, &launch.phase, &launch.artifact)?;
    let contract = format!(
        "Alinery completion contract: after the requested artifact at `{}` is complete and non-empty, call `alinery_phase_complete`. The phase is complete only when the tool reports that Alinery accepted it. If Alinery rejects the request, fix the reported artifact or session-ownership problem and retry; if delivery fails, retry after the daemon is available. Ending a turn is not phase completion. Do not call the tool before the artifact is finished.",
        artifact.display()
    );
    if let Some(prompt) = seeded.as_mut() {
        if !prompt.is_empty() {
            prompt.push_str("\n\n");
        }
        prompt.push_str(&contract);
    } else {
        *seeded = Some(contract);
    }
    Ok(())
}

fn resolve_runner_path() -> Result<PathBuf, String> {
    let path = match env::var_os("ALINERY_RUNNER_PATH").filter(|value| !value.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => {
            let daemon = env::current_exe().map_err(|error| error.to_string())?;
            let name = daemon
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| "invalid alineryd executable path".to_string())?;
            let suffix = name.strip_prefix("alineryd").ok_or_else(|| "alineryd executable name is not recognized".to_string())?;
            daemon.with_file_name(format!("alinery-runner{suffix}"))
        }
    };
    if !path.is_file() {
        return Err(format!("alinery-runner not found at {}", path.display()));
    }
    Ok(path)
}

fn append_prompt_args(child_args: &mut Vec<String>, harness: &Harness, prompt: &str, cwd: &str, model: &str, resume_token: &str) -> Result<(), String> {
    if harness.prompt_arg.is_empty() {
        child_args.push("--".to_string());
        child_args.push(prompt.to_string());
        return Ok(());
    }
    let placeholders = harness.prompt_arg.iter().map(|arg| arg.matches("{prompt}").count()).sum::<usize>();
    if placeholders != 1 {
        return Err(format!("harness '{}' prompt_arg must contain exactly one {{prompt}} placeholder", harness.key));
    }
    child_args.extend(harness.prompt_arg.iter().map(|arg| {
        if let Some((before, after)) = arg.split_once("{prompt}") {
            format!("{}{prompt}{}", subst(before, cwd, model, resume_token), subst(after, cwd, model, resume_token))
        } else {
            subst(arg, cwd, model, resume_token)
        }
    }));
    Ok(())
}

fn spawn_session(
    reg: &Registry,
    repo: &Path,
    mut launch: LaunchFields,
    initial_client: Option<(u64, UnixStream)>,
    // resume=true: launch via the harness resume_args (no phase seed); false: fresh spawn (issue #24).
    resume: bool,
    transport: SessionTransport,
    restate: bool,
    restate_jsonl: Option<PathBuf>,
    daemon_namespace: &str,
    app_config: &Path,
    protected_host: &ProtectedHost,
) -> Result<(), String> {
    if launch.harness == NO_HARNESS_KEY {
        launch.phase.clear();
        launch.model.clear();
    }
    let hkey = launch.harness.clone();
    let model = launch.model.clone();
    let cwd = launch.worktree.clone();
    if !Path::new(&cwd).is_dir() {
        return Err(format!("worktree is not an existing directory: {cwd}"));
    }
    let harness = alinery_core::resolve_harness_strict_for(app_config, repo, &hkey)?;
    if harness.adapter == HarnessAdapter::Omp && protected_host.as_ref().is_none() {
        return Err(OMP_HOST_PROTECTION_ERROR.into());
    }
    // Fresh OMP (spawn / resume / auto-advance) is RPC. Restate honors the requested transport.
    let transport = if restate {
        transport
    } else if harness.adapter == HarnessAdapter::Omp {
        SessionTransport::Rpc
    } else {
        SessionTransport::Pty
    };
    let omp_dir = if harness.adapter == HarnessAdapter::Omp {
        let dir = session_omp_dir(repo, &launch.task_slug, &launch.id);
        fs::create_dir_all(&dir).map_err(|error| format!("create session omp dir: {error}"))?;
        Some(fs::canonicalize(&dir).unwrap_or(dir))
    } else {
        None
    };

    let resolved_binary = if harness.adapter == HarnessAdapter::Omp && harness.binary == "omp" {
        alinery_core::resolve_packaged_omp_path()?.to_string_lossy().into_owned()
    } else {
        harness.binary.clone()
    };

    let token = launch.resume_token.as_str();
    let mut child_args = Vec::new();
    if hkey == NO_HARNESS_KEY {
        child_args.push("-l".to_string());
    } else {
        if !model.is_empty() {
            child_args.extend(harness.model_arg.iter().map(|arg| subst(arg, &cwd, &model, token)));
        }
        child_args.extend(harness.args.iter().map(|arg| subst(arg, &cwd, &model, token)));
        if let Some(resume_config) = &harness.resume {
            if resume && !token.is_empty() {
                child_args.extend(resume_config.resume_args.iter().map(|arg| subst(arg, &cwd, &model, token)));
            } else if !resume && resume_config.enabled && resume_config.id_source == "launch" && !token.is_empty() {
                child_args.extend(resume_config.launch_args.iter().map(|arg| subst(arg, &cwd, &model, token)));
            }
        }
    }
    if let Some(dir) = &omp_dir {
        child_args.push("--session-dir".into());
        child_args.push(dir.to_string_lossy().into_owned());
    }
    if transport == SessionTransport::Rpc {
        child_args.push("--mode".into());
        child_args.push("rpc".into());
        child_args.push("--thinking".into());
        child_args.push("high".into());
    }
    if let Some(path) = &restate_jsonl {
        child_args.push("--resume".into());
        child_args.push(path.to_string_lossy().into_owned());
    }

    // Seed suppression keys off the journal, not the restate flag. A journal means the child we
    // just killed produced durable output, so `--resume` carries the work forward and re-seeding
    // would duplicate it. No journal means it produced nothing — it may have died before the RPC
    // `ready` that delivers the seed — so re-seeding the replacement is recovery, not a repeat.
    let mut seeded = if resume || restate_jsonl.is_some() || hkey == NO_HARNESS_KEY {
        None
    } else {
        build_seeded_prompt(repo, &launch)?
    };
    if restate_jsonl.is_none() && harness.adapter == HarnessAdapter::Omp {
        augment_omp_seed(repo, &launch, &mut seeded)?;
    }
    let inject_arg = hkey != NO_HARNESS_KEY && harness.prompt_injection != "stdin";
    // RPC ignores CLI `--` / prompt_arg; the first turn is `{ type: "prompt", message }` after ready.
    if inject_arg && transport != SessionTransport::Rpc {
        if let Some(prompt) = &seeded {
            append_prompt_args(&mut child_args, &harness, prompt, &cwd, &model, token)?;
        }
    }

    let event_token = if harness.adapter == HarnessAdapter::Omp {
        uuid::Uuid::new_v4().to_string()
    } else {
        String::new()
    };
    let runner_path = if harness.adapter == HarnessAdapter::Omp { Some(resolve_runner_path()?) } else { None };
    let program = if hkey == NO_HARNESS_KEY {
        env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    } else if let Some(path) = &runner_path {
        path.to_string_lossy().to_string()
    } else {
        resolved_binary.clone()
    };
    let mut cmd = CommandBuilder::new(&program);
    if runner_path.is_some() {
        cmd.args(vec![
            "run".to_string(),
            "--adapter".to_string(),
            "omp".to_string(),
            "--".to_string(),
            resolved_binary.clone(),
        ]);
    }
    cmd.args(&child_args);
    // OMP only. A `no-harness` session *is* the user's shell and must keep their environment.
    if runner_path.is_some() {
        cmd.env_clear();
        for (key, value) in alinery_core::omp_inherited_env() {
            cmd.env(key, value);
        }
    }
    for (key, value) in &harness.env {
        cmd.env(key, subst(value, &cwd, &model, token));
    }
    if let Some(path) = &runner_path {
        let namespace = (!daemon_namespace.is_empty()).then_some(daemon_namespace);
        cmd.env("ALINERY_RUNNER_PATH", path);
        cmd.env("ALINERY_SESSION_ID", &launch.id);
        cmd.env("ALINERY_DAEMON_SOCKET", alineryd_socket_path(repo, namespace));
        cmd.env("ALINERY_DAEMON_NAMESPACE", daemon_namespace);
        cmd.env("ALINERY_EVENT_PROTOCOL_VERSION", RUNNER_EVENT_PROTOCOL_VERSION.to_string());
        cmd.env("ALINERY_EVENT_TOKEN", &event_token);
        if let Some(host) = protected_host.as_ref() {
            cmd.env("ALINERY_HOST_EXECUTABLE", host);
        }
        cmd.env("ALINERY_REPO", repo);
        cmd.env("ALINERY_APP_CONFIG", app_config);
        let (agent_dir, config_root) = alinery_core::omp_home_dirs(app_config);
        let _ = fs::create_dir_all(&agent_dir);
        cmd.env("PI_CODING_AGENT_DIR", &agent_dir);
        cmd.env("PI_CONFIG_DIR", &config_root);
        cmd.env("OMP_SKIP_SETUP", "1");
    }
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("PATH", login_shell_path());

    if transport == SessionTransport::Rpc {
        return spawn_rpc_session(
            reg,
            repo,
            &launch,
            &harness,
            &program,
            &resolved_binary,
            &child_args,
            runner_path.as_deref(),
            &event_token,
            daemon_namespace,
            app_config,
            protected_host,
            &cwd,
            &model,
            token,
            initial_client,
            resume,
            seeded,
        );
    }

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: PTY_ROWS,
            cols: PTY_COLS,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));
    let meta_path = session_meta_path(repo, &launch.task_slug, &launch.id);
    let meta_path_reader = meta_path.clone();
    let app_config_reader = app_config.to_path_buf();
    let harness_reader = launch.harness.clone();
    // Eager, unlike the other id lookups: the reader thread still needs these at exit time,
    // long after the meta may have been archived, so they are captured once here.
    let ids = alinery_core::telemetry_ids_for_session(repo, &launch.task_slug, &launch.id);
    let session_id_reader = ids.session.clone();
    let task_id_reader = ids.task.clone();
    let scrollback_path = session_scrollback_path(repo, &launch.task_slug, &launch.id);
    let scrollback_path_sess = scrollback_path.clone();
    let replacing = Arc::new(AtomicBool::new(false));
    let replacing_reader = Arc::clone(&replacing);
    let inner = Arc::new(Mutex::new(Inner {
        parser: Some(vt100::Parser::new(PTY_ROWS, PTY_COLS, 0)),
        clients: vec![],
        rpc_pending: VecDeque::new(),
        rpc_pending_bytes: 0,
        rpc_ready: None,
        completion_in_flight: false,
        state: SessionState {
            process: ProcessState::Starting,
            adapter: harness.adapter,
            message_adapter: harness.message_adapter,
            ..SessionState::default()
        },
    }));
    let inner_t = inner.clone();

    // Register the token and Starting state before spawn_command can run the OMP child.
    // Immediate extension callbacks can then authenticate instead of being silently lost.
    {
        let mut map = reg.lock().unwrap_or_else(|e| e.into_inner());
        if map.contains_key(&launch.id) {
            return Err("session-already-owned".into());
        }
        map.insert(
            launch.id.clone(),
            Sess {
                io: SessionIo::Pty {
                    writer: writer.clone(),
                    master: pair.master,
                    scrollback_path: scrollback_path_sess,
                },
                inner: inner.clone(),
                pid: None,
                meta_path: meta_path.clone(),
                event_token,
                task_slug: launch.task_slug.clone(),
                replacing,
            },
        );
    }

    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(child) => child,
        Err(error) => {
            reg.lock().unwrap_or_else(|e| e.into_inner()).remove(&launch.id);
            return Err(error.to_string());
        }
    };
    let pid = child.process_id();
    {
        let mut map = reg.lock().unwrap_or_else(|e| e.into_inner());
        let Some(session) = map.get_mut(&launch.id) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("session-spawn-cancelled".into());
        };
        session.pid = pid;
    }

    let mut child_killer = child.clone_killer();
    let lifecycle = Arc::new((Mutex::new(SpawnLifecycle::Pending), Condvar::new()));
    let lifecycle_reader = Arc::clone(&lifecycle);
    let (reaped_sender, reaped_receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        // Append-only full-history log (#96 Part 2): every byte the session ever produced.
        // Open lazily on first output so a silent session's history sidecar is not created.
        let mut log: Option<std::fs::File> = None;
        let mut log_failed = false;
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let code = child.wait().ok().map(|status| status.exit_code() as i32);
                    let committed = {
                        let (lock, ready) = &*lifecycle_reader;
                        let mut lifecycle = lock.lock().unwrap_or_else(|error| error.into_inner());
                        while *lifecycle == SpawnLifecycle::Pending {
                            lifecycle = ready.wait(lifecycle).unwrap_or_else(|error| error.into_inner());
                        }
                        *lifecycle == SpawnLifecycle::Committed
                    };
                    let mut inner = inner_t.lock().unwrap_or_else(|error| error.into_inner());
                    let before = inner.state.clone();
                    let candidate = process_exited(&before, code);
                    if committed && !replacing_reader.load(Ordering::SeqCst) {
                        // Stamp lifecycle and normalized status before publishing Exited. Physical
                        // exit is irreversible, so a persistence error is reported but cannot keep
                        // the dead process live in memory.
                        let now = now_secs();
                        if let Err(error) = stamp_meta(&meta_path_reader, |value| {
                            value["ended_at"] = json!(now);
                            value["exit_code"] = json!(code);
                            stamp_status_transition(value, &before, &candidate, now);
                        }) {
                            eprintln!("reap stamp {}: {error}", meta_path_reader.display());
                        }
                        emit_session_exit(&app_config_reader, &harness_reader, &session_id_reader, &task_id_reader, code);
                    }
                    inner.state = candidate;
                    let _ = reaped_sender.send(());
                    break;
                }
                Ok(n) => {
                    let chunk = &buf[..n];
                    if log.is_none() && !log_failed {
                        match std::fs::OpenOptions::new().create(true).append(true).open(&scrollback_path) {
                            Ok(file) => log = Some(file),
                            Err(_) => log_failed = true,
                        }
                    }
                    if let Some(file) = log.as_mut() {
                        let _ = file.write_all(chunk);
                    }
                    let mut output = inner_t.lock().unwrap_or_else(|error| error.into_inner());
                    if let Some(parser) = output.parser.as_mut() {
                        parser.process(chunk);
                    }
                    // Non-blocking fan-out: the short queue operation never writes to the
                    // socket. Prune any client whose byte budget is full or writer has died.
                    output.clients.retain(|(_, sink)| sink.try_enqueue(chunk.to_vec()));
                }
            }
        }
    });

    macro_rules! set_spawn_lifecycle {
        ($state:expr) => {{
            let (lock, ready) = &*lifecycle;
            *lock.lock().unwrap_or_else(|error| error.into_inner()) = $state;
            ready.notify_all();
        }};
    }
    macro_rules! terminate_child {
        () => {{
            if let Some(pid) = pid {
                unsafe {
                    libc::killpg(pid as i32, libc::SIGTERM);
                    libc::killpg(pid as i32, libc::SIGKILL);
                }
            }
            let _ = child_killer.kill();
            let _ = reaped_receiver.recv_timeout(SPAWN_ROLLBACK_REAP_TIMEOUT);
        }};
    }
    macro_rules! rollback_spawn {
        () => {{
            set_spawn_lifecycle!(SpawnLifecycle::Aborted);
            reg.lock().unwrap_or_else(|error| error.into_inner()).remove(&launch.id);
            terminate_child!();
        }};
    }

    if !inject_arg {
        if let Some(prompt) = seeded.take() {
            let prompt_writer = Arc::clone(&writer);
            let (result_sender, result_receiver) = mpsc::sync_channel(1);
            std::thread::spawn(move || {
                let result = {
                    let mut writer = prompt_writer.lock().unwrap_or_else(|error| error.into_inner());
                    writer
                        .write_all(prompt.as_bytes())
                        .and_then(|_| writer.write_all(b"\r"))
                        .and_then(|_| writer.flush())
                        .map_err(|error| error.to_string())
                };
                let _ = result_sender.send(result);
            });
            match result_receiver.recv_timeout(INITIAL_PROMPT_TIMEOUT) {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    rollback_spawn!();
                    return Err(format!("write initial prompt: {error}"));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    rollback_spawn!();
                    return Err(format!("write initial prompt timed out after {}s", INITIAL_PROMPT_TIMEOUT.as_secs()));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    rollback_spawn!();
                    return Err("write initial prompt worker disconnected".into());
                }
            }
        }
    }

    let started = now_secs();
    if let Err(error) = stamp_meta(&meta_path, |value| {
        value["started_at"] = json!(started);
        value["status_changed_at"] = json!(started);
        advance_status_revision(value);
        value["daemon_namespace"] = json!(daemon_namespace);
    }) {
        rollback_spawn!();
        return Err(error);
    }
    // Stamp and expose Alive only after successful spawn. process_started preserves any
    // agent/playbook event that arrived between spawn and this transition.
    emit_session_started(app_config, resume, &launch.harness, &launch.phase, &ids.session, &ids.task);
    {
        let mut state = inner.lock().unwrap_or_else(|error| error.into_inner());
        state.state = process_started(&state.state);
    }
    set_spawn_lifecycle!(SpawnLifecycle::Committed);

    if let Some((attach_id, stream)) = initial_client {
        let sink = ClientSink::new(stream);
        if !sink.try_enqueue(ack_line()) {
            reg.lock().unwrap_or_else(|error| error.into_inner()).remove(&launch.id);
            terminate_child!();
            return Err("failed to initialize client stream".into());
        }
        inner.lock().unwrap_or_else(|error| error.into_inner()).clients.push((attach_id, sink));
    }

    Ok(())
}

fn attach_rpc_client(sess: &mut Sess, stream: &mut UnixStream, attach_id: u64) -> Result<(), String> {
    if matches!(sess.io, SessionIo::Pty { .. }) {
        return Err(WRONG_TRANSPORT.into());
    }
    let mut inner = sess.inner.lock().unwrap_or_else(|e| e.into_inner());
    let mut replay = vec![ack_line()];
    replay.extend(inner.rpc_ready.iter().cloned());
    replay.extend(inner.rpc_pending.iter().cloned());
    let socket = stream.try_clone().map_err(|e| e.to_string())?;
    let sink = ClientSink::with_initial(socket, replay);
    inner.clients.retain(|(aid, _)| *aid != attach_id);
    inner.clients.push((attach_id, sink));
    Ok(())
}

// Picks by FILENAME, not mtime. OMP's `updateSessionTitle` rewrites the fixed 256-byte title
// record in place, so mtime moves without any conversation being added — an untouched journal can
// look newer than the one actually being written to. Journal names are `<timestamp>_<uuidv7>`,
// both monotonic, so lexical order is chronological.
fn newest_jsonl_in(dir: &Path) -> Option<PathBuf> {
    let path = alinery_core::newest_omp_jsonl(dir)?;
    Some(fs::canonicalize(&path).unwrap_or(path))
}

/// What one OMP stdout line is worth to a client that attaches *later*. Classified once by the
/// reader and handed to `push_rpc_line`, so the hot path still parses each line exactly once.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum RpcLineKind {
    /// The one-shot spawn handshake.
    Ready,
    /// Closes a turn. Everything buffered before it is committed to OMP's journal.
    TurnEnd,
    /// A reply to a history request. The client that asked correlates it against its own walk;
    /// replaying it to a different client resurrects a dead cursor.
    HistoryResponse,
    Other,
}

fn classify_rpc_line(line: &[u8]) -> RpcLineKind {
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return RpcLineKind::Other;
    };
    match value.get("type").and_then(Value::as_str) {
        Some("ready") => RpcLineKind::Ready,
        Some("agent_end") | Some("turn_end") => RpcLineKind::TurnEnd,
        Some("response") if matches!(value.get("command").and_then(Value::as_str), Some("get_messages") | Some("get_messages_page")) => RpcLineKind::HistoryResponse,
        _ => RpcLineKind::Other,
    }
}

fn push_rpc_line(inner: &mut Inner, line: Vec<u8>, kind: RpcLineKind) {
    // Live delivery first and unconditionally. Retention policy decides what a *future* attacher
    // is replayed; it must never change what an already-attached client sees.
    inner.clients.retain(|(_, sink)| sink.try_enqueue(line.clone()));
    match kind {
        RpcLineKind::Ready => {
            // `ready` is OMP saying it is up and waiting for a prompt, which is exactly Idle. Until
            // now nothing set the agent axis until the OMP extension emitted its first lifecycle
            // event — and that only fires once a turn starts. A session spawned and left at the
            // prompt therefore sat at AgentState::Unknown, which the UI renders as "Loading"
            // forever even though the process is alive and waiting.
            if inner.state.agent == alinery_core::AgentState::Unknown {
                inner.state.agent = alinery_core::AgentState::Idle;
            }
            inner.rpc_ready = Some(line);
        }
        RpcLineKind::HistoryResponse => {}
        RpcLineKind::TurnEnd => {
            inner.rpc_pending.clear();
            inner.rpc_pending_bytes = 0;
        }
        RpcLineKind::Other => {
            while inner.rpc_pending_bytes.saturating_add(line.len()) > RPC_PENDING_MAX_BYTES && !inner.rpc_pending.is_empty() {
                if let Some(old) = inner.rpc_pending.pop_front() {
                    inner.rpc_pending_bytes = inner.rpc_pending_bytes.saturating_sub(old.len());
                }
            }
            inner.rpc_pending_bytes = inner.rpc_pending_bytes.saturating_add(line.len());
            inner.rpc_pending.push_back(line);
        }
    }
}

#[cfg(test)]
mod rpc_ring_tests {
    use super::*;

    fn empty_inner() -> Inner {
        Inner {
            parser: None,
            clients: vec![],
            rpc_pending: VecDeque::new(),
            rpc_pending_bytes: 0,
            rpc_ready: None,
            completion_in_flight: false,
            state: SessionState::default(),
        }
    }

    fn push(inner: &mut Inner, line: &str) {
        let bytes = format!("{line}\n").into_bytes();
        let kind = classify_rpc_line(&bytes);
        push_rpc_line(inner, bytes, kind);
    }

    fn ring(inner: &Inner) -> Vec<String> {
        inner.rpc_pending.iter().map(|line| String::from_utf8_lossy(line).trim_end().to_string()).collect()
    }

    // The bug this exists for: attach_rpc_client replays the whole ring, so a stale
    // get_messages_page reply from a PREVIOUS attach was consumed by a NEW client as if it
    // answered that client's walk — leaving a cursor set, which made the fresh first page append
    // to stale rows instead of replacing them.
    #[test]
    fn history_replies_never_enter_the_ring() {
        let mut inner = empty_inner();
        push(&mut inner, r#"{"type":"response","command":"get_messages_page","success":true,"data":{"nextCursor":"c1"}}"#);
        push(&mut inner, r#"{"type":"response","command":"get_messages","success":true}"#);
        assert!(ring(&inner).is_empty(), "only the client that asked can correlate a history reply");

        push(&mut inner, r#"{"type":"response","command":"get_state","success":true}"#);
        assert_eq!(ring(&inner).len(), 1, "every other response is still worth replaying");
    }

    #[test]
    fn a_closed_turn_is_evicted_but_ready_is_pinned() {
        let mut inner = empty_inner();
        push(&mut inner, r#"{"type":"ready"}"#);
        push(&mut inner, r#"{"type":"text_delta","text":"hello"}"#);
        assert_eq!(ring(&inner).len(), 1, "an in-flight turn is buffered for a client attaching mid-turn");

        push(&mut inner, r#"{"type":"agent_end"}"#);
        assert!(ring(&inner).is_empty(), "a committed turn lives in OMP's journal, not the ring");
        assert!(inner.rpc_ready.is_some(), "ready is emitted once at spawn and must survive eviction");
    }

    // A session that spawns and waits at the prompt never starts a turn, so the OMP extension
    // never emits a lifecycle event and the agent axis stayed Unknown — which the UI renders as
    // "Loading" indefinitely. `ready` is OMP telling us it is up and waiting, which is Idle.
    #[test]
    fn ready_moves_the_agent_off_unknown() {
        let mut inner = empty_inner();
        assert_eq!(inner.state.agent, alinery_core::AgentState::Unknown);
        push(&mut inner, r#"{"type":"ready"}"#);
        assert_eq!(inner.state.agent, alinery_core::AgentState::Idle);
    }

    // A late or replayed `ready` must not walk a real turn backwards.
    #[test]
    fn ready_does_not_overwrite_a_known_agent_state() {
        let mut inner = empty_inner();
        inner.state.agent = alinery_core::AgentState::Busy;
        push(&mut inner, r#"{"type":"ready"}"#);
        assert_eq!(inner.state.agent, alinery_core::AgentState::Busy);
    }

    #[test]
    fn ready_survives_the_byte_cap() {
        let mut inner = empty_inner();
        push(&mut inner, r#"{"type":"ready"}"#);
        let filler = format!(r#"{{"type":"text_delta","text":"{}"}}"#, "x".repeat(64 * 1024));
        for _ in 0..24 {
            push(&mut inner, &filler);
        }
        assert!(inner.rpc_pending_bytes <= RPC_PENDING_MAX_BYTES, "the ring still honours its cap");
        assert!(inner.rpc_ready.is_some(), "the cap must not be able to evict the handshake");
    }
}

fn apply_rpc_command_env(
    cmd: &mut process::Command,
    harness: &Harness,
    launch: &LaunchFields,
    runner_path: Option<&Path>,
    event_token: &str,
    daemon_namespace: &str,
    app_config: &Path,
    protected_host: &ProtectedHost,
    repo: &Path,
    cwd: &str,
    model: &str,
    token: &str,
) {
    // OMP only, and before the harness `env` map so an explicit injection there still wins.
    if runner_path.is_some() {
        cmd.env_clear();
        cmd.envs(alinery_core::omp_inherited_env());
    }
    for (key, value) in &harness.env {
        cmd.env(key, subst(value, cwd, model, token));
    }
    if let Some(path) = runner_path {
        let namespace = (!daemon_namespace.is_empty()).then_some(daemon_namespace);
        cmd.env("ALINERY_RUNNER_PATH", path);
        cmd.env("ALINERY_SESSION_ID", &launch.id);
        cmd.env("ALINERY_DAEMON_SOCKET", alineryd_socket_path(repo, namespace));
        cmd.env("ALINERY_DAEMON_NAMESPACE", daemon_namespace);
        cmd.env("ALINERY_EVENT_PROTOCOL_VERSION", RUNNER_EVENT_PROTOCOL_VERSION.to_string());
        cmd.env("ALINERY_EVENT_TOKEN", event_token);
        if let Some(host) = protected_host.as_ref() {
            cmd.env("ALINERY_HOST_EXECUTABLE", host);
        }
        cmd.env("ALINERY_REPO", repo);
        cmd.env("ALINERY_APP_CONFIG", app_config);
        let (agent_dir, config_root) = alinery_core::omp_home_dirs(app_config);
        let _ = fs::create_dir_all(&agent_dir);
        cmd.env("PI_CODING_AGENT_DIR", &agent_dir);
        cmd.env("PI_CONFIG_DIR", &config_root);
        cmd.env("OMP_SKIP_SETUP", "1");
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("PATH", login_shell_path());
}

/// Reserved id for the setup session: an OMP with no task, no journal and no prompt, spawned so
/// the accounts dialog can read `get_login_providers` and drive a login before any real session
/// exists. The id is reserved rather than generated so a second request attaches to the one
/// already up instead of starting a second OMP.
pub(crate) const OMP_SETUP_SESSION_ID: &str = "__omp-setup__";

/// How long the setup session may sit with nobody attached before it is killed. It holds a real
/// OMP process, so it must not outlive the dialog that asked for it. The clock starts at the
/// first attach, not at spawn -- otherwise a slow first attach would race the reaper.
const OMP_SETUP_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// Spawn (or no-op onto) the reserved setup session.
///
/// Deliberately not routed through `spawn_session`: that path writes session meta, emits
/// telemetry and arms a completion contract, none of which mean anything for a session with no
/// task. What it *does* share is `apply_rpc_command_env`, which is the part that must never
/// drift -- a probe that built its own environment could report on a different OMP config home
/// than the one real sessions use, which is exactly the class of bug this workstream exists to
/// close. Registration is a normal `Sess`, so `rpc_write` and `rpc_attach` work unchanged.
fn spawn_omp_setup_session(reg: &Registry, repo: &Path, app_config: &Path, daemon_namespace: &str, protected_host: &ProtectedHost) -> Result<(), String> {
    if reg.lock().unwrap_or_else(|e| e.into_inner()).contains_key(OMP_SETUP_SESSION_ID) {
        return Ok(());
    }
    let harness = alinery_core::resolve_harness_strict_for(app_config, repo, "omp")?;
    if harness.adapter != HarnessAdapter::Omp {
        return Err("the omp harness row is not omp-adapted".into());
    }
    if protected_host.as_ref().is_none() {
        return Err(OMP_HOST_PROTECTION_ERROR.into());
    }
    let resolved_binary = if harness.binary == "omp" {
        alinery_core::resolve_packaged_omp_path()?.to_string_lossy().into_owned()
    } else {
        harness.binary.clone()
    };
    let runner_path = resolve_runner_path()?;
    let cwd = repo.to_string_lossy().into_owned();

    // An explicit model lets OMP reach login RPC before credentials exist. No prompt is sent
    // and no task journal is requested with `--session-dir`.
    let mut child_args: Vec<String> = harness.args.iter().map(|arg| subst(arg, &cwd, "", "")).collect();
    child_args.push("--mode".into());
    child_args.push("rpc".into());
    child_args.push("--model=openai-codex/gpt-5.5".into());

    let event_token = uuid::Uuid::new_v4().to_string();
    let launch = LaunchFields {
        id: OMP_SETUP_SESSION_ID.to_string(),
        task_slug: String::new(),
        worktree: cwd.clone(),
        playbook: String::new(),
        generic: true,
        subtask_manager: false,
        subtask_slug: String::new(),
        phase: String::new(),
        harness: "omp".to_string(),
        model: String::new(),
        created: now_secs(),
        artifact: String::new(),
        handoff_artifact: String::new(),
        prompt_extra: String::new(),
        prompt: None,
        resume_token: String::new(),
    };

    let mut cmd = process::Command::new(runner_path.to_string_lossy().into_owned());
    cmd.args(["run", "--adapter", "omp", "--"]);
    cmd.arg(&resolved_binary);
    cmd.args(&child_args);
    apply_rpc_command_env(
        &mut cmd,
        &harness,
        &launch,
        Some(runner_path.as_path()),
        &event_token,
        daemon_namespace,
        app_config,
        protected_host,
        repo,
        &cwd,
        "",
        "",
    );
    cmd.current_dir(&cwd);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::inherit());
    cmd.process_group(0);

    let inner = Arc::new(Mutex::new(Inner {
        parser: None,
        clients: vec![],
        rpc_pending: VecDeque::new(),
        rpc_pending_bytes: 0,
        rpc_ready: None,
        completion_in_flight: false,
        state: SessionState {
            process: ProcessState::Starting,
            adapter: harness.adapter,
            message_adapter: harness.message_adapter,
            ..SessionState::default()
        },
    }));

    let mut child = cmd.spawn().map_err(|error| error.to_string())?;
    let stdin = match child.stdin.take() {
        Some(stdin) => Arc::new(Mutex::new(stdin)),
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("setup rpc child stdin missing".into());
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("setup rpc child stdout missing".into());
        }
    };
    let pid = child.id();
    let stdin_reader = stdin.clone();

    {
        let mut map = reg.lock().unwrap_or_else(|e| e.into_inner());
        if map.contains_key(OMP_SETUP_SESSION_ID) {
            // Another request won the race while we were spawning; keep theirs.
            let _ = child.kill();
            let _ = child.wait();
            return Ok(());
        }
        map.insert(
            OMP_SETUP_SESSION_ID.to_string(),
            Sess {
                io: SessionIo::Rpc { stdin },
                inner: inner.clone(),
                pid: Some(pid),
                // No meta on disk to stamp: this session has no task and leaves no record.
                meta_path: PathBuf::new(),
                event_token,
                task_slug: String::new(),
                replacing: Arc::new(AtomicBool::new(false)),
            },
        );
    }

    let inner_reader = inner.clone();
    std::thread::spawn(move || {
        let mut reader = stdout;
        let mut buf = Vec::new();
        let mut tmp = [0u8; 8192];
        let mut assembler = RpcChunkAssembler::new();
        loop {
            match reader.read(&mut tmp) {
                Ok(0) | Err(_) => {
                    let code = child.wait().ok().and_then(|status| status.code());
                    let mut inner = inner_reader.lock().unwrap_or_else(|error| error.into_inner());
                    let before = inner.state.clone();
                    inner.state = process_exited(&before, code);
                    break;
                }
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    while let Some(idx) = buf.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = buf.drain(..=idx).collect();
                        match assembler.push_jsonl(&line) {
                            Ok(Some(complete)) => {
                                let kind = classify_rpc_line(&complete);
                                {
                                    let mut inner = inner_reader.lock().unwrap_or_else(|error| error.into_inner());
                                    push_rpc_line(&mut inner, complete, kind);
                                }
                                if kind == RpcLineKind::Ready {
                                    let negotiate = json!({"id": "protocol-1", "type": "negotiate_protocol", "protocolVersion": 2});
                                    let mut writer = stdin_reader.lock().unwrap_or_else(|error| error.into_inner());
                                    if let Err(error) = writeln!(writer, "{negotiate}").and_then(|_| writer.flush()) {
                                        eprintln!("setup negotiate_protocol: {error}");
                                    }
                                }
                            }
                            Ok(None) => {}
                            Err(error) => {
                                eprintln!("setup rpc_chunk: {error}");
                                assembler.reset();
                            }
                        }
                    }
                }
            }
        }
    });

    let reaper_reg = reg.clone();
    let reaper_inner = inner;
    std::thread::spawn(move || {
        let mut ever_attached = false;
        let mut idle_since: Option<Instant> = None;
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let still_registered = {
                let map = reaper_reg.lock().unwrap_or_else(|e| e.into_inner());
                map.contains_key(OMP_SETUP_SESSION_ID)
            };
            if !still_registered {
                return;
            }
            let attached = {
                let inner = reaper_inner.lock().unwrap_or_else(|e| e.into_inner());
                if matches!(inner.state.process, ProcessState::Exited { .. }) {
                    drop(inner);
                    reaper_reg.lock().unwrap_or_else(|e| e.into_inner()).remove(OMP_SETUP_SESSION_ID);
                    return;
                }
                !inner.clients.is_empty()
            };
            if attached {
                ever_attached = true;
                idle_since = None;
                continue;
            }
            // The clock only starts once somebody has attached, so a slow first attach cannot
            // race the reaper into killing the session it was about to use.
            if !ever_attached {
                continue;
            }
            match idle_since {
                None => idle_since = Some(Instant::now()),
                Some(since) if since.elapsed() >= OMP_SETUP_IDLE_TIMEOUT => {
                    let removed = reaper_reg.lock().unwrap_or_else(|e| e.into_inner()).remove(OMP_SETUP_SESSION_ID);
                    if let Some(pid) = removed.and_then(|sess| sess.pid) {
                        // Same shape as the `kill` op: SIGTERM the group, brief grace, SIGKILL.
                        unsafe { libc::killpg(pid as i32, libc::SIGTERM) };
                        std::thread::sleep(Duration::from_millis(500));
                        unsafe { libc::killpg(pid as i32, libc::SIGKILL) };
                    }
                    return;
                }
                Some(_) => {}
            }
        }
    });

    Ok(())
}

fn spawn_rpc_session(
    reg: &Registry,
    repo: &Path,
    launch: &LaunchFields,
    harness: &Harness,
    program: &str,
    resolved_binary: &str,
    child_args: &[String],
    runner_path: Option<&Path>,
    event_token: &str,
    daemon_namespace: &str,
    app_config: &Path,
    protected_host: &ProtectedHost,
    cwd: &str,
    model: &str,
    token: &str,
    initial_client: Option<(u64, UnixStream)>,
    resume: bool,
    seeded: Option<String>,
) -> Result<(), String> {
    let stderr_path = sessions_dir(repo, &launch.task_slug).join(format!("{}.stderr.log", launch.id));
    let stderr = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stderr_path)
        .map_err(|error| format!("open session stderr {}: {error}", stderr_path.display()))?;
    let mut cmd = process::Command::new(program);
    if runner_path.is_some() {
        cmd.args(["run", "--adapter", "omp", "--"]);
        cmd.arg(resolved_binary);
    }
    cmd.args(child_args);
    apply_rpc_command_env(
        &mut cmd,
        harness,
        launch,
        runner_path,
        event_token,
        daemon_namespace,
        app_config,
        protected_host,
        repo,
        cwd,
        model,
        token,
    );
    cmd.current_dir(cwd);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::inherit());
    cmd.process_group(0);

    cmd.stderr(Stdio::from(stderr));
    let meta_path = session_meta_path(repo, &launch.task_slug, &launch.id);
    let meta_path_reader = meta_path.clone();
    let app_config_reader = app_config.to_path_buf();
    let harness_reader = launch.harness.clone();
    let ids = alinery_core::telemetry_ids_for_session(repo, &launch.task_slug, &launch.id);
    let session_id_reader = ids.session.clone();
    let task_id_reader = ids.task.clone();
    let replacing = Arc::new(AtomicBool::new(false));
    let replacing_reader = Arc::clone(&replacing);
    let inner = Arc::new(Mutex::new(Inner {
        parser: None,
        clients: vec![],
        rpc_pending: VecDeque::new(),
        rpc_pending_bytes: 0,
        rpc_ready: None,
        completion_in_flight: false,
        state: SessionState {
            process: ProcessState::Starting,
            adapter: harness.adapter,
            message_adapter: harness.message_adapter,
            ..SessionState::default()
        },
    }));
    let inner_t = inner.clone();

    let mut child = cmd.spawn().map_err(|error| error.to_string())?;
    let stdin = match child.stdin.take() {
        Some(stdin) => Arc::new(Mutex::new(stdin)),
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("rpc child stdin missing".into());
        }
    };
    let stdin_reader = stdin.clone();
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("rpc child stdout missing".into());
        }
    };
    let pid = child.id();

    {
        let mut map = reg.lock().unwrap_or_else(|e| e.into_inner());
        if map.contains_key(&launch.id) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("session-already-owned".into());
        }
        map.insert(
            launch.id.clone(),
            Sess {
                io: SessionIo::Rpc { stdin },
                inner: inner.clone(),
                pid: Some(pid),
                meta_path: meta_path.clone(),
                event_token: event_token.to_string(),
                task_slug: launch.task_slug.clone(),
                replacing,
            },
        );
    }

    let lifecycle = Arc::new((Mutex::new(SpawnLifecycle::Pending), Condvar::new()));
    let lifecycle_reader = Arc::clone(&lifecycle);
    let (reaped_sender, reaped_receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut reader = stdout;
        let mut buf = Vec::new();
        let mut tmp = [0u8; 8192];
        let mut assembler = RpcChunkAssembler::new();
        let mut seed = seeded;
        loop {
            match reader.read(&mut tmp) {
                Ok(0) | Err(_) => {
                    if !buf.is_empty() {
                        buf.push(b'\n');
                        match assembler.push_jsonl(&buf) {
                            Ok(Some(complete)) => {
                                let kind = classify_rpc_line(&complete);
                                let mut inner = inner_t.lock().unwrap_or_else(|error| error.into_inner());
                                push_rpc_line(&mut inner, complete, kind);
                            }
                            Ok(None) => {}
                            Err(error) => eprintln!("rpc_chunk: {error}"),
                        }
                        buf.clear();
                    }
                    let code = child.wait().ok().and_then(|status| status.code());
                    let committed = {
                        let (lock, ready) = &*lifecycle_reader;
                        let mut lifecycle = lock.lock().unwrap_or_else(|error| error.into_inner());
                        while *lifecycle == SpawnLifecycle::Pending {
                            lifecycle = ready.wait(lifecycle).unwrap_or_else(|error| error.into_inner());
                        }
                        *lifecycle == SpawnLifecycle::Committed
                    };
                    let mut inner = inner_t.lock().unwrap_or_else(|error| error.into_inner());
                    let before = inner.state.clone();
                    let candidate = process_exited(&before, code);
                    if committed && !replacing_reader.load(Ordering::SeqCst) {
                        let now = now_secs();
                        if let Err(error) = stamp_meta(&meta_path_reader, |value| {
                            value["ended_at"] = json!(now);
                            value["exit_code"] = json!(code);
                            stamp_status_transition(value, &before, &candidate, now);
                        }) {
                            eprintln!("reap stamp {}: {error}", meta_path_reader.display());
                        }
                        emit_session_exit(&app_config_reader, &harness_reader, &session_id_reader, &task_id_reader, code);
                    }
                    inner.state = candidate;
                    let _ = reaped_sender.send(());
                    break;
                }
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    while let Some(idx) = buf.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = buf.drain(..=idx).collect();
                        match assembler.push_jsonl(&line) {
                            Ok(Some(complete)) => {
                                let kind = classify_rpc_line(&complete);
                                {
                                    let mut inner = inner_t.lock().unwrap_or_else(|error| error.into_inner());
                                    push_rpc_line(&mut inner, complete, kind);
                                }
                                if kind == RpcLineKind::Ready {
                                    {
                                        let negotiate = json!({"id": "protocol-1", "type": "negotiate_protocol", "protocolVersion": 2});
                                        let mut writer = stdin_reader.lock().unwrap_or_else(|error| error.into_inner());
                                        if let Err(error) = writeln!(writer, "{negotiate}").and_then(|_| writer.flush()) {
                                            eprintln!("rpc negotiate_protocol: {error}");
                                        }
                                    }
                                    if let Some(message) = seed.take() {
                                        let payload = json!({"type": "prompt", "message": message});
                                        let mut writer = stdin_reader.lock().unwrap_or_else(|error| error.into_inner());
                                        if let Err(error) = writeln!(writer, "{payload}").and_then(|_| writer.flush()) {
                                            eprintln!("rpc seed prompt: {error}");
                                        }
                                    }
                                }
                            }
                            Ok(None) => {}
                            Err(error) => {
                                eprintln!("rpc_chunk: {error}");
                                assembler.reset();
                            }
                        }
                    }
                }
            }
        }
    });

    macro_rules! set_spawn_lifecycle {
        ($state:expr) => {{
            let (lock, ready) = &*lifecycle;
            *lock.lock().unwrap_or_else(|error| error.into_inner()) = $state;
            ready.notify_all();
        }};
    }
    macro_rules! terminate_child {
        () => {{
            unsafe {
                libc::killpg(pid as i32, libc::SIGTERM);
                libc::killpg(pid as i32, libc::SIGKILL);
            }
            let _ = reaped_receiver.recv_timeout(SPAWN_ROLLBACK_REAP_TIMEOUT);
        }};
    }
    macro_rules! rollback_spawn {
        () => {{
            set_spawn_lifecycle!(SpawnLifecycle::Aborted);
            reg.lock().unwrap_or_else(|error| error.into_inner()).remove(&launch.id);
            terminate_child!();
        }};
    }

    let started = now_secs();
    if let Err(error) = stamp_meta(&meta_path, |value| {
        value["started_at"] = json!(started);
        value["status_changed_at"] = json!(started);
        advance_status_revision(value);
        value["daemon_namespace"] = json!(daemon_namespace);
    }) {
        rollback_spawn!();
        return Err(error);
    }
    emit_session_started(app_config, resume, &launch.harness, &launch.phase, &ids.session, &ids.task);
    {
        let mut state = inner.lock().unwrap_or_else(|error| error.into_inner());
        state.state = process_started(&state.state);
    }
    set_spawn_lifecycle!(SpawnLifecycle::Committed);
    if reaped_receiver.recv_timeout(Duration::from_millis(300)).is_ok() {
        reg.lock().unwrap_or_else(|error| error.into_inner()).remove(&launch.id);
        return Err("rpc child exited".into());
    }

    if let Some((attach_id, stream)) = initial_client {
        let sink = ClientSink::new(stream);
        if !sink.try_enqueue(ack_line()) {
            rollback_spawn!();
            return Err("failed to initialize client stream".into());
        }
        inner.lock().unwrap_or_else(|error| error.into_inner()).clients.push((attach_id, sink));
    }

    Ok(())
}

fn wait_session_reaped(inner: &Arc<Mutex<Inner>>, pid: Option<u32>) {
    let reaped = |inner: &Arc<Mutex<Inner>>, steps: u32| -> bool {
        for _ in 0..steps {
            if matches!(inner.lock().unwrap_or_else(|e| e.into_inner()).state.process, ProcessState::Exited { .. }) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        false
    };
    if let Some(pid) = pid {
        let already_exited = matches!(inner.lock().unwrap_or_else(|e| e.into_inner()).state.process, ProcessState::Exited { .. });
        if !already_exited {
            unsafe { libc::killpg(pid as i32, libc::SIGTERM) };
            if !reaped(inner, 20) {
                unsafe { libc::killpg(pid as i32, libc::SIGKILL) };
                reaped(inner, 20);
            }
        }
    }
}

fn restate_session(
    reg: &Registry,
    repo: &Path,
    app_config: &Path,
    daemon_namespace: &str,
    protected_host: &ProtectedHost,
    id: &str,
    transport: SessionTransport,
) -> Result<(), String> {
    if id.is_empty() {
        return Err("missing id".into());
    }
    let (pid, inner, meta_path, task_slug) = {
        let map = reg.lock().unwrap_or_else(|e| e.into_inner());
        let Some(sess) = map.get(id) else {
            return Err("unknown-session".into());
        };
        sess.replacing.store(true, Ordering::SeqCst);
        (sess.pid, sess.inner.clone(), sess.meta_path.clone(), sess.task_slug.clone())
    };
    wait_session_reaped(&inner, pid);
    let launch = read_meta_launch_fields(repo, &task_slug, id).ok_or_else(|| format!("missing session meta for {id}"))?;
    let omp_dir = session_omp_dir(repo, &task_slug, id);
    let jsonl = newest_jsonl_in(&omp_dir);
    reg.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    match spawn_session(reg, repo, launch, None, false, transport, true, jsonl.clone(), daemon_namespace, app_config, protected_host) {
        Ok(()) => {
            if let Some(path) = jsonl {
                let _ = stamp_meta(&meta_path, |value| {
                    value["harness_resume_token"] = json!(path.to_string_lossy());
                });
            }
            Ok(())
        }
        Err(error) => {
            let now = now_secs();
            let _ = stamp_meta(&meta_path, |value| {
                if value.get("ended_at").and_then(|ended| ended.as_u64()).is_none() {
                    value["ended_at"] = json!(now);
                }
            });
            Err(error)
        }
    }
}

fn rpc_attach_only(reg: &Registry, req: &Value, stream: &mut UnixStream, attach_id: u64) -> Result<(), String> {
    let id = req.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if id.is_empty() {
        return Err("missing id".into());
    }
    let mut map = reg.lock().unwrap_or_else(|e| e.into_inner());
    let Some(sess) = map.get_mut(&id) else {
        return Err("unknown-session".into());
    };
    attach_rpc_client(sess, stream, attach_id)
}

fn read_task_session_metas(repo: &Path, slug: &str) -> Vec<SessionMeta> {
    let dir = sessions_dir(repo, slug);
    let Ok(entries) = fs::read_dir(dir) else {
        return vec![];
    };
    let mut sessions: Vec<SessionMeta> = entries
        .flatten()
        // #119 T0-1: only session metas — never read_to_string `.scrollback` (MB-sized) or
        // atomic-write `.tmp.*` leftovers on the reconciler path.
        .filter(|entry| entry.file_name().to_str().is_some_and(|n| n.ends_with(".meta.json")))
        .filter_map(|entry| read_session_meta_full(&entry.path()))
        .collect();
    sessions.sort_by(|a, b| a.created.cmp(&b.created).then_with(|| a.id.cmp(&b.id)));
    sessions
}

fn start_auto_advance_reconciler(repo: PathBuf, reg: Registry, daemon_namespace: String, app_config: PathBuf, protected_host: ProtectedHost) {
    std::thread::spawn(move || loop {
        if !daemon_namespace.is_empty() && UnixStream::connect(alineryd_socket_path(&repo, None)).is_ok() {
            std::thread::sleep(Duration::from_secs(10));
            continue;
        }
        if let Ok(Some(_lease)) = try_lock_exclusive(&alineryd_reconciler_lock_path(&repo)) {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                reconcile_auto_advance_repo(&repo, &reg, &daemon_namespace, &app_config, &protected_host);
            }));
            if outcome.is_err() {
                eprintln!("auto-advance reconcile panicked; continuing");
                alinery_core::append_exception(&app_config, "daemon.reconcile-panicked");
            }
        }
        std::thread::sleep(Duration::from_secs(10));
    });
}

fn auto_advance_source_owned_by_lane(source: &SessionMeta, daemon_namespace: &str) -> bool {
    source.daemon_namespace == daemon_namespace
}

fn reconcile_auto_advance_repo(repo: &Path, reg: &Registry, daemon_namespace: &str, app_config: &Path, protected_host: &ProtectedHost) {
    for task in list_tasks_for_repo(repo) {
        if task.archived || task.draft {
            continue;
        }
        let mut sessions = read_task_session_metas(repo, &task.slug);
        // A completed source advances on its owning daemon lane. Letting any repository
        // reconciler claim it can strand the next session behind another app-config identity.
        let sources: Vec<SessionMeta> = sessions
            .iter()
            .filter(|source| source.semantic.phase_completed_at.is_some() && auto_advance_source_owned_by_lane(source, daemon_namespace))
            .cloned()
            .collect();
        for source in &sources {
            let playbook_key = source.playbook.clone();
            let Some(playbook) = get_playbook(repo, &playbook_key) else {
                continue;
            };
            let same_playbook = sessions.iter().filter(|session| session.playbook == playbook_key).cloned().collect::<Vec<_>>();
            match reconcile_auto_advance_source(
                repo,
                reg,
                daemon_namespace,
                app_config,
                protected_host,
                &task,
                &playbook_key,
                &playbook,
                source,
                &same_playbook,
            ) {
                Ok(Some(meta)) => {
                    sessions.push(meta);
                    sessions.sort_by(|left, right| left.created.cmp(&right.created).then_with(|| left.id.cmp(&right.id)));
                }
                Ok(None) => {}
                Err(error) => eprintln!("auto-advance reconcile: {error}"),
            }
        }
    }
}

fn set_live_playbook(reg: &Registry, id: &str, playbook: PlaybookState) -> Result<(), String> {
    let session = {
        let map = reg.lock().unwrap_or_else(|e| e.into_inner());
        map.get(id).map(|session| (session.inner.clone(), session.meta_path.clone()))
    };
    if let Some((inner, meta_path)) = session {
        let mut inner = inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut candidate = inner.state.clone();
        candidate.playbook = playbook;
        publish_live_transition(&mut inner, &meta_path, candidate)?;
    }
    Ok(())
}

fn reconcile_auto_advance_source(
    repo: &Path,
    reg: &Registry,
    daemon_namespace: &str,
    app_config: &Path,
    protected_host: &ProtectedHost,
    task: &Task,
    playbook_key: &str,
    playbook: &alinery_core::Playbook,
    source: &SessionMeta,
    sessions: &[SessionMeta],
) -> Result<Option<SessionMeta>, String> {
    match completion_decision(repo, &task.slug, task, playbook_key, playbook, source, sessions) {
        CompletionDecision::Reject(reason) => {
            set_live_playbook(reg, &source.id, PlaybookState::Failed { reason: format!("{reason:?}") })?;
            Ok(None)
        }
        CompletionDecision::Complete => {
            set_live_playbook(reg, &source.id, PlaybookState::Completed)?;
            Ok(None)
        }
        CompletionDecision::CreateNext(create) => {
            set_live_playbook(reg, &source.id, PlaybookState::ReadyToAdvance)?;
            match create_and_spawn_auto_advance(reg, repo, task, playbook_key, source, create, daemon_namespace, app_config, protected_host) {
                Ok(meta) => {
                    set_live_playbook(reg, &source.id, PlaybookState::Completed)?;
                    Ok(Some(meta))
                }
                Err(error) => {
                    eprintln!("auto-advance reconcile: {error}");
                    alinery_core::append_exception(
                        app_config,
                        &format!(
                            "daemon.reconcile-failed task={} err={}",
                            alinery_core::quote_log_value(&task.slug),
                            alinery_core::quote_log_value(&error)
                        ),
                    );
                    Ok(None)
                }
            }
        }
    }
}

#[cfg(test)]
fn new_auto_advance_session_id() -> String {
    format!("s{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0))
}

#[cfg(test)]
fn build_auto_advance_meta(
    app_config: &Path,
    repo: &Path,
    task: &Task,
    playbook_key: &str,
    source: &SessionMeta,
    create: &AutoAdvanceCreate,
    daemon_namespace: &str,
) -> SessionMeta {
    let harness_resume_token = match alinery_core::resolve_harness_for(app_config, repo, &create.harness).and_then(|h| h.resume) {
        Some(r) if r.enabled && r.id_source == "launch" => uuid::Uuid::new_v4().to_string(),
        _ => String::new(),
    };
    SessionMeta {
        id: new_auto_advance_session_id(),
        worktree: if source.worktree.is_empty() { task.worktree.clone() } else { source.worktree.clone() },
        created: now_secs().max(source.created.saturating_add(1)),
        archived: false,
        phase: create.to_phase.clone(),
        harness: create.harness.clone(),
        model: create.model.clone(),
        playbook: playbook_key.to_string(),
        daemon_namespace: daemon_namespace.to_string(),
        harness_resume_token,
        ..Default::default()
    }
}

#[cfg(test)]
fn write_auto_advance_meta(repo: &Path, task_slug: &str, meta: &SessionMeta) -> Result<(), String> {
    alinery_core::write_meta_atomic(
        &sessions_dir(repo, task_slug).join(format!("{}.meta.json", meta.id)),
        &serde_json::to_value(meta).map_err(|e| e.to_string())?,
    )
}

// Keep a deterministic auto-advance id filename-safe (slug/phase are already kebab, but a custom
// playbook step could carry anything). ponytail: alnum + `-`/`_` only, capped length.
fn sanitize_id_component(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "x".to_string()
    } else {
        cleaned
    }
}

fn recoverable_auto_advance_target(meta: &SessionMeta, daemon_namespace: &str) -> bool {
    !meta.archived && meta.started_at.is_none() && meta.ended_at.is_none() && meta.daemon_namespace == daemon_namespace
}

fn create_and_spawn_auto_advance(
    reg: &Registry,
    repo: &Path,
    task: &Task,
    playbook_key: &str,
    _source: &SessionMeta,
    create: AutoAdvanceCreate,
    daemon_namespace: &str,
    app_config: &Path,
    protected_host: &ProtectedHost,
) -> Result<SessionMeta, String> {
    // One deterministic id per (task, playbook, to_phase) edge: two daemons that both decide to
    // advance this edge compute the SAME id, so the exclusive (O_EXCL) meta write lets exactly one
    // win — the loser gets "duplicate target session already exists". The reg-lock + on-disk
    // next_step_session_exists check is only a per-process fast path; it can't stop a cross-daemon
    // race (each daemon has its own reg lock), which is how two `design` sessions got spawned 12ms
    // apart by two dev daemons. The exclusive create is the real cross-process guard.
    let advance_id = format!(
        "sadv-{}-{}-{}",
        sanitize_id_component(&task.slug),
        sanitize_id_component(playbook_key),
        sanitize_id_component(&create.to_phase)
    );
    let (meta, new_claim) = {
        let _guard = reg.lock().unwrap_or_else(|e| e.into_inner());
        let existing = read_task_session_metas(repo, &task.slug)
            .into_iter()
            .filter(|meta| meta.playbook == playbook_key && meta.phase == create.to_phase)
            .max_by(|left, right| (left.created, left.id.as_str()).cmp(&(right.created, right.id.as_str())));
        match existing {
            Some(meta) if recoverable_auto_advance_target(&meta, daemon_namespace) => (meta, false),
            Some(_) => return Err("duplicate target session already exists".into()),
            None => {
                let created = create_session_meta_for(
                    app_config,
                    repo,
                    CreateSessionInput {
                        task_slug: task.slug.clone(),
                        playbook: playbook_key.to_string(),
                        phase: create.to_phase.clone(),
                        harness: create.harness.clone(),
                        model: create.model.clone(),
                        daemon_namespace: daemon_namespace.to_string(),
                        id_override: Some(advance_id),
                        exclusive_create: true,
                        ..Default::default()
                    },
                )?;
                alinery_core::record_event(
                    app_config,
                    alinery_core::TelemetryEvent::SessionAutoAdvance {
                        from_phase: create.from_phase.clone(),
                        to_phase: create.to_phase.clone(),
                        playbook: playbook_key.to_string(),
                        session_id: created.telemetry_id.clone(),
                        task_id: task.telemetry_id.clone(),
                    },
                );
                (created, true)
            }
        }
    };

    if reg.lock().unwrap_or_else(|error| error.into_inner()).contains_key(&meta.id) {
        return Ok(meta);
    }

    let launch = LaunchFields {
        id: meta.id.clone(),
        task_slug: task.slug.clone(),
        worktree: meta.worktree.clone(),
        playbook: meta.playbook.clone(),
        generic: meta.generic,
        subtask_manager: meta.subtask_manager,
        subtask_slug: meta.subtask_slug.clone(),
        phase: meta.phase.clone(),
        harness: meta.harness.clone(),
        model: meta.model.clone(),
        created: meta.created,
        artifact: meta.artifact.clone(),
        handoff_artifact: meta.handoff_artifact.clone(),
        prompt_extra: meta.prompt_extra.clone(),
        prompt: meta.prompt.clone(),
        resume_token: meta.harness_resume_token.clone(),
    };
    if let Err(error) = spawn_session(
        reg,
        repo,
        launch,
        None,
        false,
        SessionTransport::Pty,
        false,
        None,
        daemon_namespace,
        app_config,
        protected_host,
    ) {
        if new_claim {
            let _ = fs::remove_file(session_meta_path(repo, &task.slug, &meta.id));
        }
        return Err(error);
    }
    Ok(meta)
}

#[cfg(test)]
mod empty_slug_spawn {
    use super::*;

    #[test]
    fn allow_empty_slug_spawn_only_no_harness() {
        assert!(allow_empty_slug_spawn(NO_HARNESS_KEY));
        assert!(!allow_empty_slug_spawn("claude"));
        assert!(!allow_empty_slug_spawn(""));
    }
}

#[cfg(test)]
mod completion_gate {
    use super::*;

    #[test]
    fn overlapping_completion_is_not_reported_as_accepted() {
        let mut in_flight = false;
        assert_eq!(completion_event_action(true, &mut in_flight), CompletionEventAction::Attempt);
        assert!(in_flight);
        assert_eq!(completion_event_action(true, &mut in_flight), CompletionEventAction::InFlight);

        in_flight = false;
        assert_eq!(completion_event_action(false, &mut in_flight), CompletionEventAction::NotNeeded);
        assert!(!in_flight);
    }
}

#[cfg(test)]
mod status_transitions {
    use super::*;

    #[test]
    fn status_revision_distinguishes_visible_transitions_in_one_second() {
        let starting = SessionState::default();
        let alive = process_started(&starting);
        let mut waiting = alive.clone();
        waiting.agent = alinery_core::AgentState::WaitingForInput { correlation_id: "ask-1".into() };
        let mut value = json!({
            "status_changed_at": 150,
            "status_revision": 40,
            "sentinel": {"keep": true}
        });

        assert!(stamp_status_transition(&mut value, &starting, &alive, 100));
        assert_eq!(value["status_changed_at"], 150);
        assert_eq!(value["status_revision"], 41);
        assert!(stamp_status_transition(&mut value, &alive, &waiting, 100));
        assert_eq!(value["status_changed_at"], 150);
        assert_eq!(value["status_revision"], 42);
        assert_eq!(value["sentinel"]["keep"], true);

        let unchanged = value.clone();
        assert!(!stamp_status_transition(&mut value, &waiting, &waiting, 100));
        assert_eq!(value, unchanged);
    }
}

#[cfg(test)]
mod request_limits {
    use super::*;
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    use std::thread;

    fn socket_line(bytes: Vec<u8>, max_bytes: usize) -> Result<String, RequestLineError> {
        let (mut server, mut client) = UnixStream::pair().unwrap();
        let writer = thread::spawn(move || {
            client.write_all(&bytes).unwrap();
        });
        let line = read_line(&mut server, max_bytes);
        writer.join().unwrap();
        line
    }

    #[test]
    fn request_line_reader_accepts_the_limit_and_rejects_before_overallocation() {
        assert_eq!(socket_line(b"1234\n".to_vec(), 4).as_deref(), Ok("1234"));
        assert_eq!(socket_line(b"12345\n".to_vec(), 4), Err(RequestLineError::TooLarge));
        assert_eq!(socket_line(b"1234".to_vec(), 4), Err(RequestLineError::Closed));
    }

    #[test]
    fn request_line_reader_leaves_coalesced_message_body_on_socket() {
        let (mut server, mut client) = UnixStream::pair().unwrap();
        client.write_all(b"header\nbody\n").unwrap();
        assert_eq!(read_line(&mut server, 6).unwrap(), "header");
        let mut body = [0u8; 5];
        server.read_exact(&mut body).unwrap();
        assert_eq!(&body, b"body\n");
    }

    #[test]
    fn message_body_limit_and_budget_are_exact_and_released() {
        let budget: MessageBudget = Arc::new(AtomicUsize::new(0));
        let request = json!({"body_bytes": MAX_MESSAGE_BODY_BYTES});
        let (mut server, mut client) = UnixStream::pair().unwrap();
        let writer = thread::spawn(move || {
            client.write_all(&vec![b'a'; MAX_MESSAGE_BODY_BYTES]).unwrap();
        });
        let body = read_message_body(&mut server, &request, &budget).unwrap();
        assert_eq!(body.bytes.len(), MAX_MESSAGE_BODY_BYTES);
        assert_eq!(budget.load(Ordering::Acquire), MAX_MESSAGE_BODY_BYTES);
        drop(body);
        assert_eq!(budget.load(Ordering::Acquire), 0);
        writer.join().unwrap();

        let (mut server, _client) = UnixStream::pair().unwrap();
        assert_eq!(
            read_message_body(&mut server, &json!({"body_bytes": MAX_MESSAGE_BODY_BYTES + 1}), &budget).unwrap_err(),
            "message-body-too-large"
        );
        assert_eq!(budget.load(Ordering::Acquire), 0);
    }

    #[test]
    fn aggregate_message_budget_rejects_concurrency_and_recovers() {
        let budget: MessageBudget = Arc::new(AtomicUsize::new(0));
        let mut reservations = (0..4).map(|_| reserve_message_bytes(&budget, MAX_MESSAGE_BODY_BYTES).unwrap()).collect::<Vec<_>>();
        assert_eq!(budget.load(Ordering::Acquire), MAX_IN_FLIGHT_MESSAGE_BYTES);
        assert_eq!(reserve_message_bytes(&budget, 1).unwrap_err(), "message-in-flight-budget-exceeded");
        reservations.pop();
        let replacement = reserve_message_bytes(&budget, MAX_MESSAGE_BODY_BYTES).unwrap();
        drop(replacement);
        drop(reservations);
        assert_eq!(budget.load(Ordering::Acquire), 0);
    }

    #[test]
    fn failed_message_body_reads_and_validation_release_budget() {
        let budget: MessageBudget = Arc::new(AtomicUsize::new(0));

        let (mut server, client) = UnixStream::pair().unwrap();
        drop(client);
        assert!(read_message_body(&mut server, &json!({"body_bytes": 1}), &budget)
            .unwrap_err()
            .starts_with("read-message-body:"));
        assert_eq!(budget.load(Ordering::Acquire), 0);

        let (mut server, mut client) = UnixStream::pair().unwrap();
        client.write_all(&[0xff]).unwrap();
        assert_eq!(read_message_body(&mut server, &json!({"body_bytes": 1}), &budget).unwrap_err(), "message-body-invalid-utf8");
        assert_eq!(budget.load(Ordering::Acquire), 0);
    }

    #[test]
    fn message_error_replies_distinguish_rejection_from_ambiguous_delivery() {
        assert_eq!(
            message_error_response("session-not-idle", "not_sent"),
            json!({"error": "session-not-idle", "delivery": "not_sent"})
        );
        assert_eq!(
            message_error_response("write-message: fixture failure", "unknown"),
            json!({"error": "write-message: fixture failure", "delivery": "unknown"})
        );
        assert_eq!(
            message_error_response("flush-message: fixture failure", "unknown"),
            json!({"error": "flush-message: fixture failure", "delivery": "unknown"})
        );
    }

    #[test]
    fn every_segment_and_flush_failure_is_delivery_unknown() {
        struct FailingWriter {
            writes: usize,
            fail_write: Option<usize>,
            fail_flush: bool,
        }

        impl Write for FailingWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if self.fail_write == Some(self.writes) {
                    return Err(std::io::Error::other("fixture failure"));
                }
                self.writes += 1;
                Ok(bytes.len())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                if self.fail_flush {
                    Err(std::io::Error::other("fixture failure"))
                } else {
                    Ok(())
                }
            }
        }

        for fail_write in 0..4 {
            let mut writer = FailingWriter {
                writes: 0,
                fail_write: Some(fail_write),
                fail_flush: false,
            };
            let error = write_and_flush_message(&mut writer, MessageAdapter::OmpBracketedPaste, b"body").unwrap_err();
            assert_eq!(message_error_response(error, "unknown")["delivery"], "unknown");
        }

        let mut writer = FailingWriter {
            writes: 0,
            fail_write: None,
            fail_flush: true,
        };
        let error = write_and_flush_message(&mut writer, MessageAdapter::OmpBracketedPaste, b"body").unwrap_err();
        assert!(error.starts_with("flush-message:"));
        assert_eq!(message_error_response(error, "unknown")["delivery"], "unknown");
    }

    #[test]
    fn request_line_reader_survives_a_pause_after_clearing_inherited_nonblock() {
        let (mut server, mut client) = UnixStream::pair().unwrap();
        server.set_nonblocking(true).unwrap();
        server.set_nonblocking(false).unwrap();
        let writer = thread::spawn(move || {
            client.write_all(b"hello").unwrap();
            thread::sleep(std::time::Duration::from_millis(30));
            client.write_all(b" world\n").unwrap();
        });
        assert_eq!(read_line(&mut server, 64).as_deref(), Ok("hello world"));
        writer.join().unwrap();
    }

    #[test]
    fn runner_events_are_accepted_during_starting_and_alive_only() {
        assert!(process_accepts_runner_events(&ProcessState::Starting));
        assert!(process_accepts_runner_events(&ProcessState::Alive));
        assert!(!process_accepts_runner_events(&ProcessState::Exited { code: Some(0) }));
    }
}

#[cfg(test)]
mod client_sink {
    use super::*;
    use std::io::{BufRead, BufReader, Read};
    use std::os::unix::net::UnixStream;
    use std::time::{Duration, Instant};

    fn burst_chunks(count: usize) -> Vec<Vec<u8>> {
        (0..count).map(|i| format!("chunk-{i:04}\n").into_bytes()).collect()
    }

    // A stand-in "big replay" size for these tests — not tied to any production cap (the
    // scrollback log is uncapped since #96; this is just large enough to be a meaningful burst).
    const TEST_REPLAY_BYTES: usize = 96 * 1024;

    // The old 256-message cap drops healthy streams under chatty redraws long before the intended
    // ~2 MiB backlog is used. The replacement sink is byte-budgeted, so many tiny chunks are valid
    // while one oversized chunk is rejected.
    #[test]
    fn byte_budget_accepts_more_than_256_small_chunks_and_rejects_oversized_chunk() {
        let (sock, _reader) = UnixStream::pair().expect("socketpair");
        let sink = ClientSink::new(sock);

        for chunk in burst_chunks(320) {
            assert!(sink.try_enqueue(chunk), "small chunk below the byte budget must be accepted");
        }

        assert!(
            !sink.try_enqueue(vec![0u8; CLIENT_BACKLOG_BYTES + 1]),
            "a single chunk larger than the per-client byte budget must be rejected"
        );
    }

    // Regression for the ticket's raw-client evidence: a healthy reader must receive the complete
    // ack, full capped replay, more than 256 small live chunks in order, and a later sentinel without
    // EOF. This pins the real transport invariant instead of only proving stuck clients are pruned.
    #[test]
    fn healthy_client_receives_full_replay_and_chatty_live_burst() {
        let (sock, reader) = UnixStream::pair().expect("socketpair");
        reader.set_read_timeout(Some(Duration::from_secs(2))).expect("set read timeout");
        let sink = ClientSink::new(sock);

        let replay = vec![b'R'; TEST_REPLAY_BYTES];
        let burst = burst_chunks(320);
        let expected_burst: Vec<u8> = burst.iter().flatten().copied().collect();
        let sentinel = b"after-chatty-burst\n".to_vec();

        assert!(sink.try_enqueue(ack_line()), "ack enqueue");
        assert!(sink.try_enqueue(replay.clone()), "full replay enqueue");
        for chunk in &burst {
            assert!(sink.try_enqueue(chunk.clone()), "live burst enqueue");
        }
        assert!(sink.try_enqueue(sentinel.clone()), "sentinel enqueue after burst");

        let mut reader = BufReader::new(reader);
        let mut ack = String::new();
        reader.read_line(&mut ack).expect("ack line");
        assert_eq!(ack, "{\"ok\":true}\n");

        let mut actual_replay = vec![0u8; TEST_REPLAY_BYTES];
        reader.read_exact(&mut actual_replay).expect("full replay");
        assert_eq!(actual_replay, replay);

        let mut actual_burst = vec![0u8; expected_burst.len()];
        reader.read_exact(&mut actual_burst).expect("chatty burst");
        assert_eq!(actual_burst, expected_burst);

        let mut actual_sentinel = vec![0u8; sentinel.len()];
        reader.read_exact(&mut actual_sentinel).expect("sentinel after burst");
        assert_eq!(actual_sentinel, sentinel);
    }

    #[test]
    fn initial_replay_can_exceed_live_backlog_and_remains_ordered_with_live_bytes() {
        let (sock, reader) = UnixStream::pair().expect("socketpair");
        reader.set_read_timeout(Some(Duration::from_secs(3))).expect("set read timeout");
        let replay = vec![b'H'; CLIENT_BACKLOG_BYTES + 1];
        let sentinel = b"live-after-history\n".to_vec();
        let sink = ClientSink::with_initial(sock, vec![ack_line(), replay.clone()]);

        assert!(sink.try_enqueue(sentinel.clone()), "live byte enqueue");

        let mut reader = BufReader::new(reader);
        let mut ack = String::new();
        reader.read_line(&mut ack).expect("ack line");
        assert_eq!(ack, "{\"ok\":true}\n");

        let mut actual_replay = vec![0u8; replay.len()];
        reader.read_exact(&mut actual_replay).expect("full initial replay");
        assert_eq!(actual_replay, replay);

        let mut actual_sentinel = vec![0u8; sentinel.len()];
        reader.read_exact(&mut actual_sentinel).expect("live sentinel");
        assert_eq!(actual_sentinel, sentinel);
    }

    #[test]
    fn nonblocking_client_stream_is_restored_before_replay_write() {
        let (sock, mut reader) = UnixStream::pair().expect("socketpair");
        sock.set_nonblocking(true).expect("set nonblocking");
        reader.set_read_timeout(Some(Duration::from_secs(2))).expect("set read timeout");
        let sink = ClientSink::new(sock);
        let replay = vec![b'R'; 512 * 1024];

        assert!(sink.try_enqueue(replay.clone()), "large replay enqueue");
        std::thread::sleep(Duration::from_millis(20));

        let mut actual = vec![0u8; replay.len()];
        reader.read_exact(&mut actual).expect("blocking writer must finish the replay after the reader drains");
        assert_eq!(actual, replay);
    }

    // Regression guard for the frozen-session / harness-hang bug: the reader's fan-out to a client
    // must NEVER block. A stuck client (peer stops reading) fills the writer thread's socket buffer,
    // then its byte-budgeted queue; once full, `try_enqueue` returns false so the reader prunes it
    // and keeps draining the pty. If this regresses to a blocking write, the deadline turns the hang
    // into a clean failure instead of wedging the harness.
    #[test]
    fn stuck_client_queue_fills_and_try_enqueue_rejects_instead_of_blocking() {
        let (sock, _reader) = UnixStream::pair().expect("socketpair");
        let sink = ClientSink::new(sock);

        let worker = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if !sink.try_enqueue(vec![0u8; 8192]) {
                    return true;
                }
            }
            false
        });

        let deadline = Instant::now() + Duration::from_secs(11);
        while Instant::now() < deadline {
            if worker.is_finished() {
                assert!(worker.join().unwrap(), "a stuck client must become rejectable once the byte budget fills");
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("fan-out try_enqueue blocked — the pty reader would hang the harness");
    }
}

#[cfg(test)]
mod auto_advance {
    use super::*;
    use std::fs;
    use std::time::UNIX_EPOCH;

    fn temp_repo(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let repo = std::env::temp_dir().join(format!("{name}_{}_{}", std::process::id(), nanos));
        let _ = fs::remove_dir_all(&repo);
        repo
    }

    fn task() -> Task {
        Task {
            slug: "task".into(),
            worktree: "/tmp/task-worktree".into(),
            playbook: "review".into(),
            ..Default::default()
        }
    }

    fn source() -> SessionMeta {
        SessionMeta {
            id: "s1".into(),
            worktree: String::new(),
            created: 10,
            phase: "review-context".into(),
            harness: "claude".into(),
            model: "opus".into(),
            playbook: "review".into(),
            ..Default::default()
        }
    }

    fn create(harness: &str) -> AutoAdvanceCreate {
        AutoAdvanceCreate {
            edge_key: "context_to_checks".into(),
            from_phase: "review-context".into(),
            to_phase: "review-checks".into(),
            artifact: "01-review-context.md".into(),
            harness: harness.into(),
            model: if harness == NO_HARNESS_KEY { String::new() } else { "opus".into() },
        }
    }

    #[test]
    fn auto_advance_launch_prompt_meta_uses_atomic_shape_and_resume_token() {
        let repo = temp_repo("alineryd-auto-meta");
        let task = task();
        let source = source();
        let app_config = repo.join("app.toml");
        let meta = build_auto_advance_meta(&app_config, &repo, &task, "review", &source, &create("omp"), "test-ns");

        assert!(meta.id.starts_with('s'));
        assert!(meta.created > source.created);
        assert_eq!(meta.worktree, task.worktree);
        assert!(!meta.archived);
        assert_eq!(meta.phase, "review-checks");
        assert_eq!(meta.harness, "omp");
        assert_eq!(meta.model, "opus");
        assert_eq!(meta.playbook, "review");
        assert_eq!(meta.daemon_namespace, "test-ns");
        assert!(!meta.subtask_manager);
        assert!(meta.subtask_slug.is_empty());
        assert!(meta.harness_resume_token.is_empty(), "product omp is manual, not launch-bind");
        assert_eq!(meta.started_at, None);
        assert_eq!(meta.ended_at, None);
        assert_eq!(meta.exit_code, None);
        assert_eq!(meta.resume_of, None);

        write_auto_advance_meta(&repo, &task.slug, &meta).unwrap();
        let path = sessions_dir(&repo, &task.slug).join(format!("{}.meta.json", meta.id));
        let on_disk = read_session_meta_full(&path).unwrap();
        assert_eq!(on_disk.id, meta.id);
        assert_eq!(on_disk.daemon_namespace, "test-ns");
        assert!(!on_disk.subtask_manager);
        assert!(on_disk.subtask_slug.is_empty());

        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn auto_advance_meta_skips_resume_token_for_non_launch_harnesses() {
        let repo = temp_repo("alineryd-auto-token");
        let task = task();
        let source = source();

        let app_config = repo.join("app.toml");
        let codex = build_auto_advance_meta(&app_config, &repo, &task, "review", &source, &create("codex"), "test-ns");
        assert_eq!(codex.harness_resume_token, "");

        let omp = build_auto_advance_meta(&app_config, &repo, &task, "review", &source, &create("omp"), "test-ns");
        assert_eq!(omp.harness_resume_token, "");

        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn unstarted_auto_advance_target_is_recoverable_only_by_its_daemon_lane() {
        let mut meta = source();
        meta.daemon_namespace = "owner".into();

        assert!(recoverable_auto_advance_target(&meta, "owner"));
        assert!(!recoverable_auto_advance_target(&meta, "foreign"));

        meta.started_at = Some(1);
        assert!(!recoverable_auto_advance_target(&meta, "owner"));
    }

    #[test]
    fn completed_source_is_advanced_only_by_its_daemon_lane() {
        let mut meta = source();
        meta.daemon_namespace = "owner".into();

        assert!(auto_advance_source_owned_by_lane(&meta, "owner"));
        assert!(!auto_advance_source_owned_by_lane(&meta, "foreign"));
    }
}

#[cfg(test)]
mod seeded_prompt {
    use super::*;
    use std::fs;
    use std::time::UNIX_EPOCH;

    fn temp_repo(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let repo = std::env::temp_dir().join(format!("{name}_{}_{}", std::process::id(), nanos));
        let _ = fs::remove_dir_all(&repo);
        repo
    }

    #[test]
    fn build_seeded_prompt_uses_launch_playbook() {
        let repo = temp_repo("alineryd-external-playbook-seed");
        alinery_core::ensure_playbooks(&repo).unwrap();
        let slug = "task";
        let worktree = repo.join(".alinery/worktrees/task");
        let task = Task {
            name: "Task".into(),
            slug: slug.into(),
            worktree: worktree.display().to_string(),
            playbook: "superdevelop".into(),
            ..Default::default()
        };
        let task_dir = alinery_dir(&repo).join("tasks").join(slug);
        fs::create_dir_all(task_dir.join("artifacts")).unwrap();
        fs::create_dir_all(task_dir.join("sessions")).unwrap();
        fs::write(task_dir.join("task.md"), toml::to_string(&task).unwrap()).unwrap();
        fs::write(
            alinery_dir(&repo).join("playbooks/superdevelop/06-build.md"),
            "SuperDevelop_MARKER {{ARTIFACT_FILE}} {{PLAYBOOK_KEY}}",
        )
        .unwrap();
        fs::write(
            alinery_dir(&repo).join("playbooks/one-shot/01-implementation.md"),
            "ONE_SHOT_MARKER {{ARTIFACT_FILE}} {{PLAYBOOK_KEY}}",
        )
        .unwrap();
        let launch = LaunchFields {
            id: "s1".into(),
            task_slug: slug.into(),
            worktree: task.worktree.clone(),
            playbook: "one-shot".into(),
            generic: false,
            subtask_manager: false,
            subtask_slug: String::new(),
            phase: "implementation".into(),
            harness: "claude".into(),
            model: String::new(),
            created: 1,
            artifact: "external-implementation.md".into(),
            handoff_artifact: String::new(),
            prompt_extra: String::new(),
            prompt: None,
            resume_token: String::new(),
        };

        let prompt = build_seeded_prompt(&repo, &launch).unwrap().unwrap();
        assert!(prompt.contains("ONE_SHOT_MARKER"));
        assert!(prompt.contains("external-implementation.md"));
        assert!(prompt.contains("one-shot"));
        assert!(!prompt.contains("SuperDevelop_MARKER"));
        assert!(!prompt.contains("06-implementation.md"));

        let phase_less = LaunchFields {
            phase: String::new(),
            ..launch.clone()
        };
        assert!(build_seeded_prompt(&repo, &phase_less).unwrap().is_none());
        let generic = LaunchFields {
            generic: true,
            ..phase_less.clone()
        };
        let generic_prompt = build_seeded_prompt(&repo, &generic).unwrap().unwrap();
        assert!(generic_prompt.contains("Generic Alinery session"));
        assert!(generic_prompt.contains(&task.worktree));
        assert!(generic_prompt.contains("Task playbook: one-shot"));

        let edited = LaunchFields {
            prompt: Some("edited exactly".into()),
            ..generic.clone()
        };
        assert_eq!(build_seeded_prompt(&repo, &edited).unwrap().as_deref(), Some("edited exactly"));

        let mut generic_seed = Some(generic_prompt.clone());
        augment_omp_seed(&repo, &generic, &mut generic_seed).unwrap();
        assert_eq!(generic_seed.as_deref(), Some(generic_prompt.as_str()));

        let explicit = LaunchFields {
            generic: false,
            prompt: Some("special prompt".into()),
            ..phase_less
        };
        let mut explicit_seed = build_seeded_prompt(&repo, &explicit).unwrap();
        augment_omp_seed(&repo, &explicit, &mut explicit_seed).unwrap();
        assert_eq!(explicit_seed.as_deref(), Some("special prompt"));

        let mut playbook_seed = build_seeded_prompt(&repo, &launch).unwrap();
        augment_omp_seed(&repo, &launch, &mut playbook_seed).unwrap();
        let playbook_prompt = playbook_seed.unwrap();
        assert!(playbook_prompt.contains("Alinery completion contract"));
        assert!(playbook_prompt.contains("external-implementation.md"));

        let explicit_empty = LaunchFields {
            harness: "omp".into(),
            prompt: Some(String::new()),
            ..launch.clone()
        };
        let mut contract_only_seed = build_seeded_prompt(&repo, &explicit_empty).unwrap();
        assert!(contract_only_seed.is_none());
        augment_omp_seed(&repo, &explicit_empty, &mut contract_only_seed).unwrap();
        let contract_only_prompt = contract_only_seed.unwrap();
        assert!(contract_only_prompt.starts_with("Alinery completion contract"));
        assert!(contract_only_prompt.contains("external-implementation.md"));
        assert!(!contract_only_prompt.contains("ONE_SHOT_MARKER"));

        let phase_less_empty = LaunchFields {
            phase: String::new(),
            ..explicit_empty
        };
        let mut phase_less_empty_seed = build_seeded_prompt(&repo, &phase_less_empty).unwrap();
        augment_omp_seed(&repo, &phase_less_empty, &mut phase_less_empty_seed).unwrap();
        assert!(phase_less_empty_seed.is_none());

        let malformed = LaunchFields {
            phase: "missing-phase".into(),
            artifact: String::new(),
            prompt: Some("owned prompt".into()),
            ..launch
        };
        let mut malformed_seed = build_seeded_prompt(&repo, &malformed).unwrap();
        assert_eq!(
            augment_omp_seed(&repo, &malformed, &mut malformed_seed).unwrap_err(),
            "playbook 'one-shot' step 'missing-phase' has no artifact"
        );

        let terminal = LaunchFields {
            harness: NO_HARNESS_KEY.into(),
            ..generic
        };
        assert!(build_seeded_prompt(&repo, &terminal).unwrap().is_none());

        let _ = fs::remove_dir_all(repo);
    }
}

// The bytes that make a freshly-attached xterm show this session's CURRENT SCREEN.
//
// Why a frame and not a byte tail (#96): claude enters the alt screen and emits a full base
// frame ONCE, then only cursor-addressed diffs. Any tail that lost the preamble is
// unrenderable, and an idle claude never repaints, so the pane stays broken forever.
fn replay_frame(parser: &vt100::Parser) -> Vec<u8> {
    let screen = parser.screen();
    let mut out = Vec::new();
    // state_formatted() reproduces cell contents, attributes, cursor, and input modes, but
    // NOT the ?1049 alt-screen switch — emit it ourselves so the client's alt buffer is
    // active and the harness's subsequent diffs land in the right buffer.
    if screen.alternate_screen() {
        out.extend_from_slice(b"\x1b[?1049h");
    }
    out.extend_from_slice(&screen.state_formatted());
    out
}

// Last `max` bytes of a file; empty on any error (missing file, pre-#96 session).
fn tail_bytes(path: &Path, max: u64) -> Vec<u8> {
    let Ok(mut f) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if f.seek(SeekFrom::Start(len.saturating_sub(max))).is_err() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let _ = f.take(max).read_to_end(&mut out); // never read_exact: len can be stale
    out
}

// Replay the current screen to a newly-attached client and register it for live bytes —
// both under the inner lock so the reader can't interleave a live byte mid-replay.
fn attach_client(
    sess: &mut Sess,
    stream: &mut UnixStream,
    attach_id: u64,
    size: Option<(u16, u16)>, // (cols, rows) from the client's xterm
) -> Result<(), String> {
    if let Some(meta) = alinery_core::read_session_meta_full(&sess.meta_path) {
        if !alinery_core::is_allowed_launch_harness(&meta.harness) {
            return Err(format!("unknown harness '{}'", meta.harness));
        }
    }

    let SessionIo::Pty { master, scrollback_path, .. } = &mut sess.io else {
        return Err(WRONG_TRANSPORT.into());
    };

    // Match the emulator (and the pty) to the client BEFORE rendering the frame: a frame
    // built at 40x120 written into a differently-sized xterm wraps into garbage, and an
    // idle claude will not repaint to save us.
    // Caveat: set_size on a SHRINK is destructive (vt100 drops the off-screen cells, and we
    // run with scrollback_len 0). That is acceptable because a real size change also resizes
    // the pty, delivering SIGWINCH and a harness repaint; a same-size attach is a no-op.
    if let Some((cols, rows)) = size {
        if cols > 0 && rows > 0 {
            let _ = master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
            if let Some(parser) = sess.inner.lock().unwrap_or_else(|e| e.into_inner()).parser.as_mut() {
                parser.screen_mut().set_size(rows, cols);
            }
        }
    }

    let scrollback_path = scrollback_path.clone();
    let mut inner = sess.inner.lock().unwrap_or_else(|e| e.into_inner());
    let (alt, frame) = {
        let parser = inner.parser.as_ref().ok_or_else(|| WRONG_TRANSPORT.to_string())?;
        (parser.screen().alternate_screen(), replay_frame(parser))
    };
    // A normal-buffer harness builds real terminal scrollback. Replay its durable byte history so
    // closing and reopening alinery does not collapse that history to the final few hundred lines.
    // Alt-screen TUIs still receive only a reconstructed frame: an arbitrary raw tail cannot
    // recreate an alternate screen and was the original frozen-frame failure in #96.
    let mut replay = if alt {
        Vec::new()
    } else {
        strip_terminal_queries(&tail_bytes(&scrollback_path, ATTACH_REPLAY_BYTES))
    };
    replay.extend_from_slice(&frame);

    // Hand the socket and initial ack/replay directly to a dedicated writer thread while holding
    // the inner lock, so no live byte can slip ahead of replay. Initial history is not charged to
    // the 2 MiB live backlog; live bytes arriving during replay remain byte-budgeted and a client
    // that cannot drain them is still pruned without blocking the PTY reader.
    let socket = stream.try_clone().map_err(|e| e.to_string())?;
    let sink = ClientSink::with_initial(socket, vec![ack_line(), replay]);
    // Drop any prior client with the same attach_id (a reopened pane), then join.
    inner.clients.retain(|(aid, _)| *aid != attach_id);
    inner.clients.push((attach_id, sink));
    Ok(())
}

#[cfg(test)]
mod replay {
    use super::*;

    #[test]
    fn frame_reconstructs_an_alt_screen_after_the_old_cap_would_have_trimmed_it() {
        let mut p = vt100::Parser::new(40, 120, 0);
        // Preamble + >96 KB of diffs: exactly the shape that made the old front-trimmed
        // byte tail unrenderable (#96).
        p.process(b"\x1b[?1049h\x1b[2J\x1b[Hbase");
        for i in 0..5000 {
            p.process(format!("\x1b[1;1H{i:0>20}").as_bytes());
        }
        p.process(b"\x1b[1;1HFINAL");

        let frame = replay_frame(&p);
        // The alt-screen switch must be re-emitted: state_formatted() does not include it,
        // and without it the client's diffs land in the wrong buffer.
        assert!(frame.starts_with(b"\x1b[?1049h"));
        // Bounded by screen size, not total output.
        assert!(frame.len() < 96 * 1024);
        // Feeding the frame to a FRESH emulator reproduces the screen — this is what the
        // client does, and it is the property the old byte tail lacked.
        let mut fresh = vt100::Parser::new(40, 120, 0);
        fresh.process(&frame);
        assert!(fresh.screen().contents().contains("FINAL"));
    }

    #[test]
    fn frame_omits_the_alt_switch_for_normal_buffer_sessions() {
        let mut p = vt100::Parser::new(40, 120, 0);
        p.process(b"$ echo hi\r\nhi\r\n");
        assert!(!replay_frame(&p).starts_with(b"\x1b[?1049h"));
    }

    #[test]
    fn tail_bytes_returns_the_end_and_tolerates_a_missing_file() {
        let dir = std::env::temp_dir().join(format!("alinery-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.scrollback");
        let mut body = vec![b'x'; 200 * 1024];
        body.extend_from_slice(b"TAIL");
        std::fs::write(&path, &body).unwrap();

        let t = tail_bytes(&path, 64 * 1024);
        assert_eq!(t.len(), 64 * 1024);
        assert!(t.ends_with(b"TAIL"));
        assert!(tail_bytes(&dir.join("nope"), 1024).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod telemetry {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{LazyLock, Mutex};
    use std::time::{Duration, SystemTime};

    // ureq's shared global agent misbehaves under concurrent multi-port localhost
    // traffic from one process (spurious "invalid header" errors) - a test-only
    // artifact since production always targets one fixed endpoint. Serialize the
    // real-network tests below, matching `alineryd/tests/daemon_lifecycle.rs::test_lock`.
    fn test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn unique_temp(name: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("{name}_{}_{}", std::process::id(), nanos));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_app_toml(dir: &Path, enabled: bool, prompted: bool, install_id: &str, endpoint: &str) -> PathBuf {
        let path = dir.join("app.toml");
        std::fs::write(
            &path,
            format!(
                r#"settings_version = 1

[global.telemetry]
enabled = {enabled}
prompted = {prompted}
install_id = "{install_id}"
endpoint = "{endpoint}"
"#
            ),
        )
        .unwrap();
        path
    }

    fn serve_one(listener: TcpListener) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let (mut stream, _) = match listener.accept() {
                Ok(pair) => pair,
                Err(_) => return Vec::new(),
            };
            let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    Err(_) if std::time::Instant::now() < deadline => continue,
                    Err(_) => break,
                }
            }
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
            buf
        })
    }

    // Retries the whole listen+emit+capture round on a fresh port: production
    // telemetry is explicit best-effort/fire-and-forget (failures discarded), and
    // under heavy parallel `cargo test --workspace` load the shared `ureq` agent
    // occasionally drops a send even with `test_lock` serializing these tests
    // against each other - a resource-contention artifact of the OTHER ~16
    // concurrent alineryd tests in this binary, not a logic defect.
    fn capture_event(dir: &Path, emit: impl Fn(&Path)) -> serde_json::Value {
        let mut last_err = String::new();
        for _ in 0..5 {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let handle = serve_one(listener);
            let path = write_app_toml(dir, true, true, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", &format!("http://{addr}"));
            emit(&path);
            let req = handle.join().unwrap();
            let text = String::from_utf8_lossy(&req);
            let body = text.rsplit("\r\n\r\n").next().unwrap_or("").to_string();
            match serde_json::from_str(&body) {
                Ok(v) => return v,
                Err(e) => last_err = format!("{e}: {body:?}"),
            }
        }
        panic!("capture_event failed after retries: {last_err}");
    }

    #[test]
    fn emit_session_started_spawn_vs_resume() {
        let _guard = test_lock();
        let dir = unique_temp("alineryd_tel_started");
        let first = capture_event(&dir, |path| emit_session_started(path, false, "omp", "tdd", "s1", "task-a"));
        assert_eq!(first[0]["event"], "session.spawn");
        assert_eq!(first[0]["props"]["source"], "alineryd");
        assert_eq!(first[0]["props"]["harness"], "omp");
        assert_eq!(first[0]["props"]["phase"], "tdd");

        let second = capture_event(&dir, |path| emit_session_started(path, true, "omp", "tdd", "s1", "task-a"));
        assert_eq!(second[0]["event"], "session.resume");
        assert_eq!(second[0]["props"]["harness"], "omp");
        assert!(second[0]["props"].get("phase").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn emit_session_exit_omits_missing_code() {
        let _guard = test_lock();
        let dir = unique_temp("alineryd_tel_exit");
        let first = capture_event(&dir, |path| emit_session_exit(path, "claude", "s1", "task-a", None));
        assert!(first[0]["props"].get("exit_code").is_none());

        let second = capture_event(&dir, |path| emit_session_exit(path, "claude", "s1", "task-a", Some(1)));
        assert_eq!(second[0]["props"]["exit_code"], 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn emit_session_started_noop_when_unprompted() {
        let dir = unique_temp("alineryd_tel_unprompted");
        let path = write_app_toml(&dir, true, false, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "http://127.0.0.1:1");
        emit_session_started(&path, false, "claude", "tdd", "s1", "task-a");
        std::thread::sleep(Duration::from_millis(50));
        assert!(std::net::TcpStream::connect_timeout(&"127.0.0.1:1".parse().unwrap(), Duration::from_millis(50)).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unknown_harness_is_custom() {
        let _guard = test_lock();
        let dir = unique_temp("alineryd_tel_custom");
        let body = capture_event(&dir, |path| emit_session_started(path, false, "secret-bot", "tdd", "s1", "task-a"));
        assert_eq!(body[0]["props"]["harness"], "custom");
        let _ = std::fs::remove_dir_all(dir);
    }
}
