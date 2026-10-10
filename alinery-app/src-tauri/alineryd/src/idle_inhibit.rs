//! Settings → General → Misc → "Keep this computer awake": block idle system sleep while at least one
//! session is live and not Idle.
//!
//! The daemon owns the hold, not the app: quit-leave-running destroys the app and keeps the
//! daemon, which is exactly when the machine still has work to stay awake for. Each per-repo
//! daemon holds at most one inhibit; IOKit and logind aggregate them and idle sleep returns
//! after the last release, so there is no cross-daemon coordinator. The pref is re-read from
//! the app config on a poll instead of being pushed over the socket, which keeps the wire
//! protocol unchanged, and the poll never runs under the registry lock, so spawn and reap
//! paths cannot deadlock against it.
//!
//! Idle-only by construction: every backend blocks idle system sleep and nothing else. The
//! display can still sleep, closing the lid still sleeps, and explicit sleep still works.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use alinery_core::{
    append_exception, append_info, load_global_settings, normalized_session_status, quote_log_value, HarnessAdapter, NormalizedSessionStatus, ProcessState, SessionState,
};

/// Idle sleep is minutes away, so a second of lag after the last session goes Idle is invisible.
const POLL: Duration = Duration::from_secs(1);

fn should_hold(keep_awake: bool, live_sessions: usize) -> bool {
    keep_awake && live_sessions > 0
}

/// Whether one registry row keeps the machine awake: live, not the setup session, and not
/// showing the Idle badge. The badge is `observationDisplayKind` returning "idle"
/// (`sessionAttention.ts`): a supported adapter whose normalized status is Idle. Unsupported
/// adapters (Terminal) never show Idle, so a live Terminal always counts. The setup session
/// is the accounts-dialog probe, not work, and it stays Starting for its whole life.
pub(crate) fn session_holds(id: &str, state: &SessionState) -> bool {
    if id == crate::OMP_SETUP_SESSION_ID || !matches!(state.process, ProcessState::Starting | ProcessState::Alive) {
        return false;
    }
    let idle_badge = state.adapter != HarnessAdapter::Unsupported && normalized_session_status(state) == NormalizedSessionStatus::Idle;
    !idle_badge
}

trait InhibitBackend {
    fn acquire(&mut self) -> Result<(), String>;
    fn release(&mut self) -> Result<(), String>;
}

#[derive(Debug, PartialEq, Eq)]
enum InhibitEvent {
    Acquired,
    Released,
    Unavailable(String),
}

/// Whether the OS hold is actually held. A failed release stays held so the next poll retries
/// it: recording it as off would leave the machine awake with nothing left to drop the hold.
struct Machine<B> {
    backend: B,
    held: bool,
    // Last failure logged. Kept across want changes, so a backend that can never work (no
    // systemd-inhibit) logs once, not once per agent turn. Cleared by the next success.
    last_error: Option<String>,
}

impl<B: InhibitBackend> Machine<B> {
    fn new(backend: B) -> Self {
        Self {
            backend,
            held: false,
            last_error: None,
        }
    }

    fn sync(&mut self, want: bool) -> Option<InhibitEvent> {
        if want == self.held {
            return None;
        }
        let result = if want { self.backend.acquire() } else { self.backend.release() };
        match result {
            Ok(()) => {
                self.held = want;
                self.last_error = None;
                Some(if want { InhibitEvent::Acquired } else { InhibitEvent::Released })
            }
            Err(error) if self.last_error.as_deref() == Some(error.as_str()) => None,
            Err(error) => {
                self.last_error = Some(error.clone());
                Some(InhibitEvent::Unavailable(error))
            }
        }
    }
}

#[derive(Default)]
struct Shared {
    stop: Mutex<bool>,
    wake: Condvar,
    thread: Mutex<Option<JoinHandle<()>>>,
}

/// Stops the poll and drops the OS hold. Cloned into every connection so the `shutdown` op can
/// release as well as the signal path.
#[derive(Clone)]
pub(crate) struct Handle(Arc<Shared>);

impl Handle {
    /// No poll thread, so `release` has nothing to join.
    #[cfg(test)]
    pub(crate) fn noop() -> Self {
        Self(Arc::default())
    }

    /// Call before every `process::exit` that can run after `start`: exit skips `Drop`.
    /// Idempotent. Returns only after the poll thread has run its final `sync(false)`, with no
    /// join timeout, because exiting early would skip the Linux reap. Never call this while
    /// holding the registry lock: the poll thread may be waiting on it.
    pub(crate) fn release(&self) {
        let shared = &self.0;
        *shared.stop.lock().unwrap_or_else(|e| e.into_inner()) = true;
        shared.wake.notify_all();
        // Hold the slot across the join, so a second caller (a signal racing the shutdown op)
        // waits for the release too instead of exiting underneath it.
        let mut thread = shared.thread.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(thread) = thread.take() {
            let _ = thread.join();
        }
    }
}

/// Starts the poll even when the pref is off, so a later toggle in Settings is seen.
/// `live_sessions` counts registry rows for which `session_holds` is true.
pub(crate) fn start(app_config: PathBuf, live_sessions: impl Fn() -> usize + Send + 'static) -> Handle {
    spawn(platform::backend(), app_config, POLL, live_sessions)
}

fn spawn<B: InhibitBackend + Send + 'static>(backend: B, app_config: PathBuf, poll: Duration, live_sessions: impl Fn() -> usize + Send + 'static) -> Handle {
    let shared = Arc::<Shared>::default();
    let thread_shared = shared.clone();
    let thread = std::thread::spawn(move || run(Machine::new(backend), &app_config, poll, live_sessions, &thread_shared));
    *shared.thread.lock().unwrap_or_else(|e| e.into_inner()) = Some(thread);
    Handle(shared)
}

fn run<B: InhibitBackend>(mut machine: Machine<B>, app_config: &Path, poll: Duration, live_sessions: impl Fn() -> usize, shared: &Shared) {
    loop {
        let stop = *shared.stop.lock().unwrap_or_else(|e| e.into_inner());
        // Not the strict loader: a missing, unreadable, unparseable, or half-written app config
        // reads as off and releases. A corrupt file must never keep the machine awake.
        let keep_awake = !stop && load_global_settings(app_config).power.keep_awake;
        // Count only when it can matter, so a daemon with the pref off never touches the registry.
        let live = if keep_awake { live_sessions() } else { 0 };
        if let Some(event) = machine.sync(should_hold(keep_awake, live)) {
            log(app_config, event);
        }
        if stop {
            return;
        }
        let guard = shared.stop.lock().unwrap_or_else(|e| e.into_inner());
        let _ = shared.wake.wait_timeout_while(guard, poll, |stop| !*stop);
    }
}

fn log(app_config: &Path, event: InhibitEvent) {
    match event {
        InhibitEvent::Acquired => append_info(app_config, "power.idle-inhibit acquired"),
        InhibitEvent::Released => append_info(app_config, "power.idle-inhibit released"),
        InhibitEvent::Unavailable(error) => append_exception(app_config, &format!("power.idle-inhibit unavailable err={}", quote_log_value(&error))),
    }
}

#[cfg(target_os = "macos")]
mod platform {
    //! In-process IOKit assertion. A `caffeinate` child is a second process that can outlive a
    //! bad exit; an assertion belongs to this process.
    use std::ffi::{c_char, c_void, CStr};

    type CFStringRef = *const c_void;
    type IOPMAssertionID = u32;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_IOPM_ASSERTION_LEVEL_ON: u32 = 255;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(alloc: *const c_void, c_str: *const c_char, encoding: u32) -> CFStringRef;
        fn CFRelease(cf: *const c_void);
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(assertion_type: CFStringRef, level: u32, name: CFStringRef, id: *mut IOPMAssertionID) -> i32;
        fn IOPMAssertionRelease(id: IOPMAssertionID) -> i32;
    }

    #[derive(Default)]
    pub(super) struct Backend {
        id: Option<IOPMAssertionID>,
    }

    pub(super) fn backend() -> Backend {
        Backend::default()
    }

    fn cf_string(value: &CStr) -> CFStringRef {
        // SAFETY: `value` is NUL-terminated; a null allocator means the default allocator.
        unsafe { CFStringCreateWithCString(std::ptr::null(), value.as_ptr(), K_CF_STRING_ENCODING_UTF8) }
    }

    fn cf_release(value: CFStringRef) {
        if !value.is_null() {
            // SAFETY: `value` came from a Create call and is released exactly once.
            unsafe { CFRelease(value) };
        }
    }

    impl super::InhibitBackend for Backend {
        fn acquire(&mut self) -> Result<(), String> {
            // PreventUserIdleSystemSleep: the system may not idle-sleep, the display may, and
            // lid close and explicit sleep still work. Any other type breaks the product rule.
            let kind = cf_string(c"PreventUserIdleSystemSleep");
            let name = cf_string(c"Alinery");
            let mut id: IOPMAssertionID = 0;
            let result = if kind.is_null() || name.is_null() {
                Err("CFStringCreateWithCString failed".to_string())
            } else {
                // SAFETY: both strings are live CFStrings and `id` is a valid out-pointer. The
                // assertion copies what it needs, so they are released right after.
                let code = unsafe { IOPMAssertionCreateWithName(kind, K_IOPM_ASSERTION_LEVEL_ON, name, &mut id) };
                match (code, id) {
                    (0, 0) => Err("IOPMAssertionCreateWithName returned no assertion id".to_string()),
                    (0, _) => Ok(()),
                    (code, _) => Err(format!("IOPMAssertionCreateWithName returned {code:#x}")),
                }
            };
            cf_release(kind);
            cf_release(name);
            if result.is_ok() {
                self.id = Some(id);
            }
            result
        }

        fn release(&mut self) -> Result<(), String> {
            let Some(id) = self.id else { return Ok(()) };
            // SAFETY: `id` is an assertion this process created and has not released.
            let code = unsafe { IOPMAssertionRelease(id) };
            if code != 0 {
                return Err(format!("IOPMAssertionRelease returned {code:#x}"));
            }
            self.id = None;
            Ok(())
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    //! `systemd-inhibit --what=idle` running a `cat` that blocks on a pipe this daemon holds.
    //! Dropping the write end ends `cat`, which ends `systemd-inhibit` and its logind lock. A
    //! daemon that dies without releasing closes the pipe too, so the lock never outlives it.
    use std::path::Path;
    use std::process::{Child, ChildStdin, Command, Stdio};
    use std::time::{Duration, Instant};

    // Absolute paths only, no PATH search.
    const INHIBIT: [&str; 2] = ["/usr/bin/systemd-inhibit", "/bin/systemd-inhibit"];
    const CAT: [&str; 2] = ["/bin/cat", "/usr/bin/cat"];
    // A refused lock (no logind, bad bus) makes systemd-inhibit exit at once.
    const SPAWN_CHECK: Duration = Duration::from_millis(50);
    const RELEASE_GRACE: Duration = Duration::from_millis(200);

    #[derive(Default)]
    pub(super) struct Backend {
        pub(super) held: Option<(Child, ChildStdin)>,
    }

    pub(super) fn backend() -> Backend {
        Backend::default()
    }

    pub(super) fn inhibit_binary() -> Option<&'static str> {
        first_file(&INHIBIT)
    }

    fn first_file(candidates: &[&'static str]) -> Option<&'static str> {
        candidates.iter().copied().find(|path| Path::new(path).is_file())
    }

    // SIGKILL the inhibitor pid only (`Child::kill`), never its group: that group is the daemon's.
    fn reap(mut child: Child) -> Result<(), String> {
        let _ = child.kill();
        child.wait().map(|_| ()).map_err(|error| format!("wait systemd-inhibit: {error}"))
    }

    impl super::InhibitBackend for Backend {
        fn acquire(&mut self) -> Result<(), String> {
            let inhibit = inhibit_binary().ok_or("systemd-inhibit not found")?;
            let cat = first_file(&CAT).ok_or("cat not found")?;
            // `--what=idle` only. The default is idle:sleep:shutdown, which blocks explicit
            // suspend; `sleep` and `handle-lid-switch` break the product rule the same way.
            // No setsid and CLOEXEC left alone, so session spawns never inherit the write end.
            let mut child = Command::new(inhibit)
                .args(["--what=idle", "--who=Alinery", "--why=A session is running", "--mode=block", cat])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| format!("spawn systemd-inhibit: {error}"))?;
            let Some(stdin) = child.stdin.take() else {
                let _ = reap(child);
                return Err("systemd-inhibit stdin unavailable".into());
            };
            std::thread::sleep(SPAWN_CHECK);
            match child.try_wait() {
                Ok(None) => {
                    self.held = Some((child, stdin));
                    Ok(())
                }
                Ok(Some(status)) => Err(format!("systemd-inhibit exited ({status})")),
                Err(error) => {
                    let _ = reap(child);
                    Err(format!("systemd-inhibit: {error}"))
                }
            }
        }

        fn release(&mut self) -> Result<(), String> {
            let Some((mut child, stdin)) = self.held.take() else { return Ok(()) };
            drop(stdin);
            let deadline = Instant::now() + RELEASE_GRACE;
            while Instant::now() < deadline {
                match child.try_wait() {
                    Ok(Some(_)) => return Ok(()),
                    Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                    Err(_) => break,
                }
            }
            reap(child)
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod platform {
    pub(super) struct Backend;

    pub(super) fn backend() -> Backend {
        Backend
    }

    impl super::InhibitBackend for Backend {
        fn acquire(&mut self) -> Result<(), String> {
            Err("idle inhibit unsupported".into())
        }

        fn release(&mut self) -> Result<(), String> {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alinery_core::{AgentState, PlaybookState};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    fn session(adapter: HarnessAdapter, process: ProcessState, agent: AgentState, playbook: PlaybookState) -> SessionState {
        SessionState {
            process,
            agent,
            playbook,
            adapter,
            ..Default::default()
        }
    }

    fn omp(process: ProcessState, agent: AgentState) -> SessionState {
        session(HarnessAdapter::Omp, process, agent, PlaybookState::InProgress)
    }

    fn holding(states: &[SessionState]) -> usize {
        states.iter().filter(|state| session_holds("s", state)).count()
    }

    #[test]
    fn should_hold_needs_the_pref_and_a_holding_session() {
        assert!(!should_hold(false, 0));
        assert!(!should_hold(false, 3));
        assert!(!should_hold(true, 0));
        assert!(should_hold(true, 1));
        assert!(should_hold(true, 4));
        let only_idle = [omp(ProcessState::Alive, AgentState::Idle), omp(ProcessState::Alive, AgentState::Idle)];
        assert!(!should_hold(true, holding(&only_idle)), "a repo of Idle sessions lets the computer sleep");
    }

    #[test]
    fn idle_exited_and_setup_sessions_do_not_hold() {
        assert!(!session_holds("s", &omp(ProcessState::Alive, AgentState::Idle)), "the Idle badge");
        assert!(!session_holds("s", &omp(ProcessState::Exited { code: Some(0) }, AgentState::Busy)));
        assert!(!session_holds("s", &omp(ProcessState::Exited { code: None }, AgentState::Unknown)));
        assert!(!session_holds(crate::OMP_SETUP_SESSION_ID, &omp(ProcessState::Starting, AgentState::Unknown)));
        assert!(!session_holds(crate::OMP_SETUP_SESSION_ID, &omp(ProcessState::Alive, AgentState::Busy)));
    }

    #[test]
    fn every_live_label_other_than_idle_holds() {
        let input = AgentState::WaitingForInput { correlation_id: "c".into() };
        let approval = AgentState::WaitingForApproval { correlation_id: "c".into() };
        let failed = PlaybookState::Failed { reason: "boom".into() };
        let cases = [
            ("Running", omp(ProcessState::Alive, AgentState::Busy)),
            ("Starting", omp(ProcessState::Starting, AgentState::Unknown)),
            ("Starting with an Idle agent", omp(ProcessState::Starting, AgentState::Idle)),
            ("Loading", omp(ProcessState::Alive, AgentState::Unknown)),
            ("Needs input", omp(ProcessState::Alive, input)),
            ("Needs approval", omp(ProcessState::Alive, approval)),
            (
                "Ready to advance",
                session(HarnessAdapter::Omp, ProcessState::Alive, AgentState::Idle, PlaybookState::ReadyToAdvance),
            ),
            ("Completed", session(HarnessAdapter::Omp, ProcessState::Alive, AgentState::Idle, PlaybookState::Completed)),
            ("Failed", session(HarnessAdapter::Omp, ProcessState::Alive, AgentState::Idle, failed)),
            (
                "Terminal",
                session(HarnessAdapter::Unsupported, ProcessState::Alive, AgentState::Unknown, PlaybookState::InProgress),
            ),
            (
                "Terminal never shows Idle",
                session(HarnessAdapter::Unsupported, ProcessState::Alive, AgentState::Idle, PlaybookState::InProgress),
            ),
        ];
        for (label, state) in cases {
            assert!(session_holds("s", &state), "{label} must hold");
        }
    }

    #[derive(Default)]
    struct FakeState {
        acquires: usize,
        releases: usize,
        acquire_error: Option<String>,
        release_error: Option<String>,
    }

    #[derive(Clone, Default)]
    struct Fake(Arc<Mutex<FakeState>>);

    impl Fake {
        fn with(&self, edit: impl FnOnce(&mut FakeState)) {
            edit(&mut self.0.lock().unwrap());
        }

        fn counts(&self) -> (usize, usize) {
            let state = self.0.lock().unwrap();
            (state.acquires, state.releases)
        }
    }

    impl InhibitBackend for Fake {
        fn acquire(&mut self) -> Result<(), String> {
            let mut state = self.0.lock().unwrap();
            state.acquires += 1;
            state.acquire_error.clone().map_or(Ok(()), Err)
        }

        fn release(&mut self) -> Result<(), String> {
            let mut state = self.0.lock().unwrap();
            state.releases += 1;
            state.release_error.clone().map_or(Ok(()), Err)
        }
    }

    #[test]
    fn sync_acquires_and_releases_once_per_change() {
        let fake = Fake::default();
        let mut machine = Machine::new(fake.clone());
        assert_eq!(machine.sync(false), None);
        assert_eq!(machine.sync(true), Some(InhibitEvent::Acquired));
        assert_eq!(machine.sync(true), None);
        assert_eq!(fake.counts(), (1, 0));
        assert_eq!(machine.sync(false), Some(InhibitEvent::Released));
        assert_eq!(machine.sync(false), None);
        assert_eq!(fake.counts(), (1, 1));
    }

    #[test]
    fn acquire_failures_retry_every_poll_and_log_each_new_error_once() {
        let fake = Fake::default();
        let mut machine = Machine::new(fake.clone());
        fake.with(|state| state.acquire_error = Some("systemd-inhibit not found".into()));
        assert_eq!(machine.sync(true), Some(InhibitEvent::Unavailable("systemd-inhibit not found".into())));
        assert_eq!(machine.sync(true), None);
        // A session going Idle and back to work does not log the same failure again.
        assert_eq!(machine.sync(false), None);
        assert_eq!(machine.sync(true), None);
        assert_eq!(fake.counts(), (3, 0), "retried every poll, never released what it never held");
        assert!(!machine.held);
        fake.with(|state| state.acquire_error = Some("other".into()));
        assert_eq!(machine.sync(true), Some(InhibitEvent::Unavailable("other".into())));
        fake.with(|state| state.acquire_error = None);
        assert_eq!(machine.sync(true), Some(InhibitEvent::Acquired));
        assert!(machine.held);
    }

    #[test]
    fn failed_release_stays_held_and_retries() {
        let fake = Fake::default();
        let mut machine = Machine::new(fake.clone());
        assert_eq!(machine.sync(true), Some(InhibitEvent::Acquired));
        fake.with(|state| state.release_error = Some("stuck".into()));
        assert_eq!(machine.sync(false), Some(InhibitEvent::Unavailable("stuck".into())));
        assert!(machine.held, "a failed release is not off");
        assert_eq!(machine.sync(false), None);
        assert_eq!(fake.counts(), (1, 2));
        fake.with(|state| state.release_error = None);
        assert_eq!(machine.sync(false), Some(InhibitEvent::Released));
        assert!(!machine.held);
    }

    fn wait_for(what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn poll_follows_pref_and_sessions_and_release_drops_the_hold() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("alineryd_idle_inhibit_{}_{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let app_config = dir.join("app.toml");
        let live = Arc::new(AtomicUsize::new(1));
        let counted = Arc::new(AtomicUsize::new(0));
        let fake = Fake::default();
        let handle = {
            let (live, counted) = (live.clone(), counted.clone());
            spawn(fake.clone(), app_config.clone(), Duration::from_millis(10), move || {
                counted.fetch_add(1, Ordering::SeqCst);
                live.load(Ordering::SeqCst)
            })
        };

        // No app config: off, and the registry is never counted.
        std::thread::sleep(Duration::from_millis(80));
        assert_eq!(fake.counts(), (0, 0));
        assert_eq!(counted.load(Ordering::SeqCst), 0);

        std::fs::write(&app_config, "[global.power]\nkeep_awake = true\n").unwrap();
        wait_for("acquire on pref on", || fake.counts() == (1, 0));
        live.store(0, Ordering::SeqCst);
        wait_for("release when no session holds", || fake.counts() == (1, 1));
        live.store(2, Ordering::SeqCst);
        wait_for("acquire when a session holds again", || fake.counts() == (2, 1));
        std::fs::write(&app_config, "[global.power\nkeep_awake = true\n").unwrap();
        wait_for("release on an unparseable app config", || fake.counts() == (2, 2));
        std::fs::write(&app_config, "[global.power]\nkeep_awake = true\n").unwrap();
        wait_for("acquire after a good write", || fake.counts() == (3, 2));

        handle.clone().release();
        assert_eq!(fake.counts(), (3, 3), "release returns only after the hold is dropped");
        handle.release();
        Handle::noop().release();
        assert_eq!(fake.counts(), (3, 3));

        let log = std::fs::read_to_string(alinery_core::log_path(&app_config)).unwrap();
        assert_eq!(log.matches("power.idle-inhibit acquired").count(), 3, "{log}");
        assert_eq!(log.matches("power.idle-inhibit released").count(), 3, "{log}");
        assert!(!log.contains(&*dir.to_string_lossy()), "{log}");
        let _ = std::fs::remove_dir_all(dir);
    }

    // A real assertion for a moment. Do not shell out to `pmset`: a running Alinery already
    // shows up under the same name.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_assertion_acquires_and_releases() {
        let mut backend = platform::backend();
        backend.acquire().unwrap();
        backend.release().unwrap();
        backend.release().unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_inhibitor_stays_alive_until_released() {
        // No inhibitor binary, or no system bus for logind to answer on: nothing to exercise.
        if platform::inhibit_binary().is_none() || !Path::new("/run/dbus/system_bus_socket").exists() {
            return;
        }
        let mut backend = platform::backend();
        backend.acquire().unwrap();
        let (child, _) = backend.held.as_mut().unwrap();
        assert!(child.try_wait().unwrap().is_none(), "systemd-inhibit holds the lock until released");
        backend.release().unwrap();
        assert!(backend.held.is_none(), "release reaps the child");
    }
}
