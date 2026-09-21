//! state: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

// PTY ownership and semantic event reduction live in alineryd/alinery-core.
// The app consumes structured session observations through the daemon protocol.

pub(crate) struct ManagedMcpChild {
    pub(crate) repo: PathBuf,
    pub(crate) child: std::process::Child,
}

/// Everything the RPC reader thread and the Tauri commands both touch, shared by `Arc`
/// and deliberately NOT reachable through `AppState.orbitron_agent`: that mutex is held
/// across spawn *and* bootstrap, while `omp` emits its first `extension_ui_request`
/// before the spawn call returns. A reader that reached for the outer lock would
/// deadlock the very launch that started it.
#[derive(Default)]
pub(crate) struct OrbitronRuntime {
    /// The child's stdin. Both the reader thread (extension-UI answers) and the commands
    /// (prompt, host-tool results, tool re-registration) write here, so one lock owns it.
    pub(crate) stdin: Mutex<Option<std::process::ChildStdin>>,
    /// The pane's event channel, replaced on reattach so a reopened pane gets the frames.
    pub(crate) channel: Mutex<Option<Channel<crate::OrbitronAgentEvent>>>,
    /// `<repo>/.alinery/orbitron-agent/agent.log`, opened once at spawn.
    pub(crate) log: Mutex<Option<std::fs::File>>,
    /// Redaction target for the log, never a source of the key for anything else.
    pub(crate) key: Mutex<Option<String>>,
    /// Where the session pointer goes once `get_state` names the session file.
    pub(crate) dir: PathBuf,
    pub(crate) streaming: AtomicBool,
    pub(crate) compacting: AtomicBool,
    /// RPC id of the one in-flight mutating host-tool call, per `reject_second_write`.
    pub(crate) pending_write_id: Mutex<Option<String>>,
}

pub(crate) struct ManagedOrbitronAgent {
    pub(crate) repo: PathBuf,
    pub(crate) child: Option<std::process::Child>,
    pub(crate) pid: u32,
    pub(crate) mcp_seeded: bool,
    pub(crate) spawn_count: usize,
    pub(crate) rt: std::sync::Arc<OrbitronRuntime>,
    pub(crate) stdin_writes: usize,
    pub(crate) attached: bool,
}

/// What the app knows about one repo's daemon. Exactly the two outcomes of
/// `ensure_daemon`, so "conflicted but still holding a client" is unrepresentable.
#[derive(Clone)]
pub(crate) enum RepoDaemon {
    Connected {
        client: DaemonClient,
        /// Decided once at attach; build drift is informational only.
        compat: DaemonCompat,
        /// Expected identity accepted during the handshake. Foreign lanes reuse it.
        app_config_identity: String,
        /// The connected daemon reports that it lacks a canonical host executable.
        host_guard_warning: bool,
    },
    /// A daemon owns the repo but fails a hard reuse gate. No client, no kill.
    Conflicted(DaemonConflict),
}

#[derive(Default)]
pub(crate) struct AppState {
    // B5 substrate: one entry per repo the app has brought up, keyed by repo root.
    // Built to REMOTE-DAEMONS-KICKOFF.md's shape (#88 keys remotes as `host:path`) so
    // remote daemons reuse this map instead of redoing it. The active repo is a
    // *selection* over this map, no longer the only slot that can hold a client.
    pub(crate) daemons: Mutex<HashMap<PathBuf, RepoDaemon>>,
    // Cache of foreign-lane clients keyed by session id (Fix 3 / #71 Mode A).
    // Cleared whenever own daemon is replaced (repo switch / restart).
    pub(crate) session_routes: Mutex<HashMap<String, DaemonClient>>,
    // R2: managed MCP child (one per active repo). Killed on app exit / repo switch.
    pub(crate) mcp_child: Mutex<Option<ManagedMcpChild>>,
    pub(crate) mcp_spawn_error: Mutex<Option<String>>,
    pub(crate) orbitron_agent: Mutex<Option<ManagedOrbitronAgent>>,
    // B6/#132: one exclusive flock for every repository this window has open. Active
    // repository selection is only a UI scope over this map; switching repositories must
    // not release an inactive repository that remains in `known_repos`.
    pub(crate) repo_locks: Mutex<HashMap<PathBuf, LockFile>>,
    // Set by `close_all_repos`: the user asked, on the way out, that nothing be left
    // running. Without it the 5s poller (or the footer's next status tick) would spawn a
    // fresh daemon for every known repo in the seconds between teardown and window
    // destroy — resurrecting exactly the orphans they just declined.
    //
    // NOT one-way. `close_all_repos` is fail-closed per repo and can return `Err` after
    // closing only some of them, and the quit dialog then offers a way back to the window
    // so the user can stop the stragglers by hand. Leaving the latch set on that path
    // handed them a *degraded* window: attach and the poller both stay off, so the repos
    // that did close cannot be reopened and a daemon that dies later is never recovered.
    // `cancel_quit` clears it (see the `cancel_quit` command).
    pub(crate) quitting: AtomicBool,
    // Repos with a teardown in flight. `close_repo_daemon` shuts the daemon down and then
    // waits for its socket to go away — an intentional gap in which the repo is still
    // listed and has no daemon, which is exactly the shape the poller reads as "died,
    // respawn it". Membership here means "someone is deliberately closing this"; the
    // poller and `attach_repo_daemon` skip it, so the user's close cannot be raced into
    // an orphan process the UI no longer has a handle for.
    pub(crate) closing_repos: Mutex<HashSet<PathBuf>>,
}

/// Scope guard for `AppState::closing_repos` — teardown has several fallible steps and an
/// early return must not leave a repo permanently un-attachable.
///
/// Nesting is expected (`remove_repo` marks the repo, then calls `close_repo_daemon`,
/// which marks it again) and only the guard that actually inserted clears the entry, so
/// the inner scope ending does not open the window the outer scope is still holding shut.
pub(crate) struct ClosingGuard<'a> {
    pub(crate) state: &'a AppState,
    pub(crate) repo: PathBuf,
    pub(crate) inserted: bool,
}

impl Drop for ClosingGuard<'_> {
    fn drop(&mut self) {
        if self.inserted {
            self.state.closing_repos.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.repo);
        }
    }
}
pub(crate) enum RepoReservation {
    AlreadyOwned,
    Candidate { repo: PathBuf, lock: LockFile },
}

impl RepoReservation {
    pub(crate) fn commit(self, state: &AppState) {
        if let Self::Candidate { repo, lock } = self {
            state.repo_locks.lock().unwrap_or_else(|e| e.into_inner()).insert(repo, lock);
        }
    }
}

impl AppState {
    pub(crate) fn repo_daemon(&self, repo: &Path) -> Option<RepoDaemon> {
        self.daemons.lock().unwrap_or_else(|e| e.into_inner()).get(repo).cloned()
    }
    pub(crate) fn daemon_for(&self, repo: &Path) -> Option<DaemonClient> {
        match self.repo_daemon(repo)? {
            RepoDaemon::Connected { client, .. } => Some(client),
            RepoDaemon::Conflicted(_) => None,
        }
    }
    /// The active repo's client — what every session command still routes through.
    pub(crate) fn daemon(&self) -> Option<DaemonClient> {
        self.daemon_for(&active_repo().ok()?)
    }
    pub(crate) fn set_daemon(&self, repo: &Path, client: DaemonClient, compat: DaemonCompat, app_config_identity: String, host_guard_warning: bool) {
        self.daemons.lock().unwrap_or_else(|e| e.into_inner()).insert(
            repo.to_path_buf(),
            RepoDaemon::Connected {
                client,
                compat,
                app_config_identity,
                host_guard_warning,
            },
        );
        // Own-lane identity changed — drop any foreign route cache entries.
        self.session_routes.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
    /// Refresh fields reported by the daemon currently answering this repo's socket.
    /// Keep the existing client and foreign session routes: the socket identity did not change.
    pub(crate) fn refresh_daemon_observation(&self, repo: &Path, observed_compat: DaemonCompat, observed_app_config_identity: String, observed_host_guard_warning: bool) -> bool {
        let mut daemons = self.daemons.lock().unwrap_or_else(|error| error.into_inner());
        let Some(RepoDaemon::Connected {
            compat,
            app_config_identity,
            host_guard_warning,
            ..
        }) = daemons.get_mut(repo)
        else {
            return false;
        };
        *compat = observed_compat;
        *app_config_identity = observed_app_config_identity;
        *host_guard_warning = observed_host_guard_warning;
        true
    }
    pub(crate) fn set_daemon_conflict(&self, repo: &Path, c: DaemonConflict) {
        self.daemons.lock().unwrap_or_else(|e| e.into_inner()).insert(repo.to_path_buf(), RepoDaemon::Conflicted(c));
    }
    /// A6: `BuildDrift` means the running daemon is a different build of the same wire
    /// protocol. Informational for the footer — never a reason to restart or kill it.
    pub(crate) fn daemon_compat(&self, repo: &Path) -> Option<DaemonCompat> {
        match self.repo_daemon(repo)? {
            RepoDaemon::Connected { compat, .. } => Some(compat),
            RepoDaemon::Conflicted(_) => None,
        }
    }

    pub(crate) fn daemon_app_config_identity(&self, repo: &Path) -> Option<String> {
        match self.repo_daemon(repo)? {
            RepoDaemon::Connected { app_config_identity, .. } => Some(app_config_identity),
            RepoDaemon::Conflicted(_) => None,
        }
    }
    pub(crate) fn daemon_host_guard_warning(&self, repo: &Path) -> bool {
        match self.repo_daemon(repo) {
            Some(RepoDaemon::Connected { host_guard_warning, .. }) => host_guard_warning,
            Some(RepoDaemon::Conflicted(_)) | None => false,
        }
    }
    pub(crate) fn daemon_conflict(&self, repo: &Path) -> Option<DaemonConflict> {
        match self.repo_daemon(repo)? {
            RepoDaemon::Conflicted(c) => Some(c),
            RepoDaemon::Connected { .. } => None,
        }
    }

    /// Reserve GUI ownership of `repo` without changing any lock already held.
    ///
    /// Dropping an uncommitted candidate releases only that candidate's flock. A busy
    /// candidate returns `None`; lock-directory or lock-file failures remain diagnostics.
    pub(crate) fn reserve_repo(&self, repo: &Path) -> Result<Option<RepoReservation>, String> {
        if self.repo_locks.lock().unwrap_or_else(|e| e.into_inner()).contains_key(repo) {
            return Ok(Some(RepoReservation::AlreadyOwned));
        }

        fs::create_dir_all(alinery_dir(repo)).map_err(|e| format!("prepare repository lock for {}: {e}", repo.display()))?;
        try_lock_exclusive(&alinery_app_lock_path(repo))
            .map(|lock| lock.map(|lock| RepoReservation::Candidate { repo: repo.to_path_buf(), lock }))
            .map_err(|e| format!("lock repository {}: {e}", repo.display()))
    }

    /// Claim GUI ownership immediately. Startup and polling use this path; explicit
    /// repository switches hold the reservation until their fallible preparation passes.
    pub(crate) fn claim_repo(&self, repo: &Path) -> bool {
        match self.reserve_repo(repo) {
            Ok(Some(reservation)) => {
                reservation.commit(self);
                true
            }
            Ok(None) | Err(_) => false,
        }
    }

    /// Give one repo back (close-repo). Every other known repository stays owned.
    pub(crate) fn release_repo(&self, repo: &Path) {
        self.repo_locks.lock().unwrap_or_else(|e| e.into_inner()).remove(repo);
    }

    /// True iff this app currently holds the GUI ownership flock for `repo`.
    pub(crate) fn owns_repo(&self, repo: &Path) -> bool {
        self.repo_locks.lock().unwrap_or_else(|e| e.into_inner()).contains_key(repo)
    }

    /// Latch "the user is quitting and asked for nothing to be left running".
    pub(crate) fn begin_quit(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }
    /// Roll the quit latch back: teardown did not complete and the user came back to the
    /// window instead. Everything the latch suppresses (attach, the poller, the relaunch
    /// button) has to work again, or they cannot act on the very sessions we just told
    /// them are still running.
    pub(crate) fn cancel_quit(&self) {
        self.quitting.store(false, Ordering::SeqCst);
    }
    pub(crate) fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    /// Mark `repo` as being torn down for as long as the returned guard lives.
    pub(crate) fn mark_closing(&self, repo: &Path) -> ClosingGuard<'_> {
        let inserted = self.closing_repos.lock().unwrap_or_else(|e| e.into_inner()).insert(repo.to_path_buf());
        ClosingGuard {
            state: self,
            repo: repo.to_path_buf(),
            inserted,
        }
    }

    pub(crate) fn is_closing(&self, repo: &Path) -> bool {
        self.closing_repos.lock().unwrap_or_else(|e| e.into_inner()).contains(repo)
    }

    // Forget a repo's handle without touching the daemon process: dropping a repo from
    // the app list must never kill its live sessions (teardown stays explicit).
    pub(crate) fn clear_daemon(&self, repo: &Path) {
        self.daemons.lock().unwrap_or_else(|e| e.into_inner()).remove(repo);
        self.session_routes.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
    pub(crate) fn clear_session_route(&self, id: &str) {
        self.session_routes.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }
    pub(crate) fn set_mcp_error(&self, msg: Option<String>) {
        *self.mcp_spawn_error.lock().unwrap_or_else(|e| e.into_inner()) = msg;
    }
    pub(crate) fn mcp_error(&self) -> String {
        self.mcp_spawn_error.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default()
    }
    pub(crate) fn stop_mcp_child(managed: &mut ManagedMcpChild) {
        let _ = managed.child.kill();
        let _ = managed.child.wait();
    }

    // R2: MCP child management
    pub(crate) fn kill_mcp(&self) {
        if let Ok(mut guard) = self.mcp_child.lock() {
            if let Some(mut managed) = guard.take() {
                Self::stop_mcp_child(&mut managed);
            }
        }
    }

    pub(crate) fn stop_orbitron_agent(&self) {
        if let Ok(mut guard) = self.orbitron_agent.lock() {
            if let Some(mut managed) = guard.take() {
                crate::stop_managed_orbitron(&mut managed);
            }
        }
    }
}
