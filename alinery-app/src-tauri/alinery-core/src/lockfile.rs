//! Exclusive flock helper: alineryd lane / reconciler locks, and the app's per-repo
//! GUI ownership lock (`.alinery/.alinery-app.lock`).
//!
//! The kernel releases the lock when the process dies; lock files are permanent
//! 0-byte markers, never unlinked on drop. flock is per-inode, so after acquiring
//! we re-verify the fd still points at the file linked at `path` — an external
//! unlink/replace would otherwise silently defeat the singleton.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, TryLockError};
use std::time::{Duration, Instant};

/// Holds an exclusive `flock` for the process lifetime (or until drop).
pub struct LockFile(File);

/// Open `path` (create if needed) and try `LOCK_EX|LOCK_NB`.
///
/// - `Ok(Some(lock))` — exclusive lock acquired; keep the value alive.
/// - `Ok(None)` — another process holds the lock (`EWOULDBLOCK`).
/// - `Err(_)` — open/flock I/O error other than would-block.
pub fn try_lock_exclusive(path: &Path) -> io::Result<Option<LockFile>> {
    lock_exclusive(path, false)
}

/// Same as [`try_lock_exclusive`], but waits until the other holder drops rather than
/// returning `Ok(None)`. Account credential mutations use this so a second Alinery window
/// serializes against the first instead of racing `auth.json`.
pub fn lock_exclusive_blocking(path: &Path) -> io::Result<LockFile> {
    lock_exclusive(path, true).map(|lock| lock.expect("blocking flock always returns a holder"))
}

fn lock_exclusive(path: &Path, blocking: bool) -> io::Result<Option<LockFile>> {
    use std::os::unix::fs::MetadataExt;
    // Retry a few times: flock is per-inode, so if `path` is unlinked/replaced between
    // open() and flock() the lock we hold no longer guards the path. After acquiring,
    // confirm the fd's inode still matches the file at `path`; if not, release and re-open.
    for _ in 0..5 {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false) // 0-byte marker; never clobber a peer's lock file
            .open(path)?;
        let how = if blocking { libc::LOCK_EX } else { libc::LOCK_EX | libc::LOCK_NB };
        let rc = unsafe { libc::flock(file.as_raw_fd(), how) };
        if rc != 0 {
            let err = io::Error::last_os_error();
            return if !blocking && (err.raw_os_error() == Some(libc::EWOULDBLOCK) || err.raw_os_error() == Some(libc::EAGAIN)) {
                Ok(None)
            } else {
                Err(err)
            };
        }
        let locked = file.metadata()?;
        let still_linked = fs::metadata(path)
            .map(|on_path| on_path.dev() == locked.dev() && on_path.ino() == locked.ino())
            .unwrap_or(false);
        if still_linked {
            return Ok(Some(LockFile(file)));
        }
        // The file was unlinked/replaced under us — dropping `file` releases the stale
        // flock; loop to re-open and lock the currently-linked inode.
        drop(file);
    }
    Err(io::Error::other("lock file kept being replaced underneath"))
}

/// Is `path` currently held exclusively by *someone else*?
///
/// Probes with `LOCK_SH|LOCK_NB` rather than `LOCK_EX`: a shared probe is refused by a
/// held exclusive lock (which is the question) but does **not** compete with ownership
/// attempts made by another window. The app uses this for status/teardown decisions after
/// a retained exclusive claim was unavailable.
///
/// A probe may still overlap a real `try_lock_exclusive` claim for the microseconds it is
/// held; callers retry ownership through their normal startup/poller path. An absent or
/// unopenable path returns `false`: nothing can be holding a lock we cannot open.
pub fn is_locked_by_other(path: &Path) -> bool {
    let Ok(file) = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path) else {
        return false;
    };
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) };
    if rc != 0 {
        let err = io::Error::last_os_error();
        return err.raw_os_error() == Some(libc::EWOULDBLOCK) || err.raw_os_error() == Some(libc::EAGAIN);
    }
    let _ = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    false
}

impl Drop for LockFile {
    fn drop(&mut self) {
        let fd = self.0.as_raw_fd();
        let _ = unsafe { libc::flock(fd, libc::LOCK_UN) };
    }
}
struct TaskMutationSlot {
    mutex: Mutex<()>,
    owner: Mutex<Option<std::thread::ThreadId>>,
}

struct ClearOwner<'a>(&'a Mutex<Option<std::thread::ThreadId>>);
impl Drop for ClearOwner<'_> {
    fn drop(&mut self) {
        *self.0.lock().unwrap_or_else(|error| error.into_inner()) = None;
    }
}

static TASK_MUTATION_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Arc<TaskMutationSlot>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// How long an execution commit waits for another thread to finish its critical
/// section. Longer than a JSON rewrite under CI load; shorter than the control
/// socket and fixture timeouts. Fail-fast callers do not use this.
pub const TASK_MUTATION_CONTENTION_WAIT: Duration = Duration::from_secs(2);

/// Run one task-record transaction under both a process-local nonblocking mutex and a
/// repository flock. `flock` alone is insufficient because separate descriptors in one process
/// do not exclude one another on every supported Unix.
///
/// This rejects immediately when the lock is held. That is required: a same-thread re-entry
/// must not deadlock, and a caller proving "busy rejects rather than blocks" must not be
/// waited out. Execution commits that race the reconciler use [`with_task_mutation_lock_waiting`].
pub fn with_task_mutation_lock<T>(repo: &Path, operation: &str, mutate: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let mut mutate = Some(mutate);
    run_task_mutation(repo, operation, &mut || mutate.take().expect("task mutation runs once")())
}

/// Same transaction as [`with_task_mutation_lock`], but another thread's brief hold is waited
/// out. A same-thread re-entry still fails immediately: waiting cannot succeed until this
/// thread drops the lock it already holds.
pub fn with_task_mutation_lock_waiting<T>(repo: &Path, operation: &str, wait: Duration, mutate: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let deadline = Instant::now() + wait;
    let mut mutate = Some(mutate);
    loop {
        match run_task_mutation(repo, operation, &mut || mutate.take().expect("task mutation runs once")()) {
            Err(error) if task_mutation_busy(&error) && !task_mutation_owned_by_current_thread(repo) && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            other => return other,
        }
    }
}

fn task_mutation_busy(error: &str) -> bool {
    error.starts_with("task mutation busy during ")
}

fn task_mutation_slot(repo: &Path) -> Result<Arc<TaskMutationSlot>, String> {
    let key = repo.canonicalize().unwrap_or_else(|_| repo.to_path_buf());
    let mut locks = TASK_MUTATION_LOCKS.lock().map_err(|_| "task mutation lock registry poisoned".to_string())?;
    Ok(Arc::clone(locks.entry(key).or_insert_with(|| {
        Arc::new(TaskMutationSlot {
            mutex: Mutex::new(()),
            owner: Mutex::new(None),
        })
    })))
}

fn task_mutation_owned_by_current_thread(repo: &Path) -> bool {
    let Ok(slot) = task_mutation_slot(repo) else {
        return false;
    };
    let owned = slot.owner.lock().unwrap_or_else(|error| error.into_inner()).as_ref() == Some(&std::thread::current().id());
    owned
}

fn run_task_mutation<T>(repo: &Path, operation: &str, mutate: &mut dyn FnMut() -> Result<T, String>) -> Result<T, String> {
    let slot = task_mutation_slot(repo).map_err(|error| format!("{error} during {operation}"))?;
    let _process_guard = match slot.mutex.try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::WouldBlock) => {
            return Err(format!("task mutation busy during {operation}"));
        }
        Err(TryLockError::Poisoned(_)) => {
            return Err(format!("task mutation lock poisoned during {operation}"));
        }
    };
    *slot.owner.lock().unwrap_or_else(|error| error.into_inner()) = Some(std::thread::current().id());
    // Declared after the process guard so the owner is cleared before the mutex drops.
    let _clear_owner = ClearOwner(&slot.owner);

    let path = crate::paths::task_mutation_lock_path(repo);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let _file_guard = try_lock_exclusive(&path)
        .map_err(|e| format!("open task mutation lock {} during {operation}: {e}", path.display()))?
        .ok_or_else(|| format!("task mutation busy during {operation}"))?;
    mutate()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_path(label: &str) -> std::path::PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        std::env::temp_dir().join(format!("alineryd-lockfile-{label}-{n}"))
    }

    #[test]
    fn second_lock_fails_until_first_dropped() {
        let path = tmp_path("exclusive");
        let _ = std::fs::remove_file(&path);
        let first = try_lock_exclusive(&path).expect("open").expect("first lock should succeed");
        assert!(try_lock_exclusive(&path).expect("open").is_none(), "second exclusive lock must fail while first is held");
        drop(first);
        let second = try_lock_exclusive(&path).expect("open").expect("lock after drop should succeed");
        drop(second);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn blocking_lock_waits_until_the_holder_drops() {
        let path = tmp_path("blocking");
        let _ = std::fs::remove_file(&path);
        let first = lock_exclusive_blocking(&path).expect("first lock");
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let waiter_path = path.clone();
        let waiter = std::thread::spawn(move || {
            entered_tx.send(()).unwrap();
            lock_exclusive_blocking(&waiter_path).expect("waiter lock")
        });
        entered_rx.recv().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(
            try_lock_exclusive(&path).expect("probe").is_none(),
            "holder still owns the lock while the waiter is blocked"
        );
        drop(first);
        let second = waiter.join().expect("waiter thread");
        drop(second);
        let _ = std::fs::remove_file(&path);
    }

    // T7, rehomed from alineryd/tests/reconciler.rs. It lived in a test binary that also
    // spawns real alineryd children; `Command::spawn` forks, and a child forked while this
    // test holds `first` briefly shares that open file description, so the flock outlives
    // `drop(first)` until the child execs. That made T7 fail ~1 run in 3 for reasons that
    // had nothing to do with locking. Same assertions, in a binary that never forks.
    #[test]
    fn reconciler_lock_is_mutually_exclusive() {
        let root = tmp_path("reconciler");
        std::fs::create_dir_all(root.join(".alinery")).expect("repo");
        let path = crate::paths::alineryd_reconciler_lock_path(&root);
        let first = try_lock_exclusive(&path).expect("open").expect("first lock");
        assert!(try_lock_exclusive(&path).expect("open").is_none(), "second must fail");
        drop(first);
        let second = try_lock_exclusive(&path).expect("open").expect("after drop");
        drop(second);
        let _ = std::fs::remove_dir_all(&root);
    }

    // The app polls this over every non-active repo every 5s. It must answer the question
    // without becoming a contender: an exclusive probe let two alinerys bounce each other's
    // claim and flash a spurious "repo busy" at a folder neither of them owns.
    #[test]
    fn shared_probe_sees_a_held_lock_without_taking_it() {
        let path = tmp_path("probe");
        let _ = std::fs::remove_file(&path);

        assert!(!is_locked_by_other(&path), "a free lock is not held");
        // Probing must not leave anything behind that blocks a real claim.
        let held = try_lock_exclusive(&path).expect("open").expect("probe must not have taken the lock");

        assert!(is_locked_by_other(&path), "a held lock is visible");
        // …and probing does not evict the holder.
        assert!(is_locked_by_other(&path));
        drop(held);

        assert!(!is_locked_by_other(&path), "released lock reads free again");
        // Two concurrent probes do not contend with each other.
        assert!(!is_locked_by_other(&path) && !is_locked_by_other(&path));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn missing_parent_is_error() {
        let path = tmp_path("missing-parent").join("nested").join("lock");
        assert!(try_lock_exclusive(&path).is_err());
    }

    #[test]
    fn task_mutation_serializes_in_process_without_waiting() {
        let repo = tmp_path("task-mutation-process");
        std::fs::create_dir_all(repo.join(".alinery")).unwrap();
        let worker_repo = repo.clone();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            with_task_mutation_lock(&worker_repo, "first mutation", || {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
        });
        entered_rx.recv().unwrap();

        let error = with_task_mutation_lock(&repo, "second mutation", || Ok(())).unwrap_err();
        assert_eq!(error, "task mutation busy during second mutation");

        release_tx.send(()).unwrap();
        worker.join().unwrap().unwrap();
        with_task_mutation_lock(&repo, "retry mutation", || Ok(())).unwrap();
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn waiting_mutation_outlasts_a_brief_holder_and_still_fails_if_it_stays() {
        let repo = tmp_path("task-mutation-wait");
        std::fs::create_dir_all(repo.join(".alinery")).unwrap();
        let worker_repo = repo.clone();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            with_task_mutation_lock(&worker_repo, "holder", || {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
        });
        entered_rx.recv().unwrap();

        let started = Instant::now();
        let stuck = with_task_mutation_lock_waiting(&repo, "stuck", Duration::from_millis(80), || Ok(())).unwrap_err();
        assert_eq!(stuck, "task mutation busy during stuck");
        assert!(started.elapsed() >= Duration::from_millis(80));
        assert!(started.elapsed() < Duration::from_millis(500), "a timed-out wait must not sit on the holder");

        let waiter_repo = repo.clone();
        let waiter = std::thread::spawn(move || with_task_mutation_lock_waiting(&waiter_repo, "waiter", Duration::from_secs(2), || Ok("done")));
        std::thread::sleep(Duration::from_millis(40));
        release_tx.send(()).unwrap();
        assert_eq!(waiter.join().unwrap().unwrap(), "done");
        worker.join().unwrap().unwrap();
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn waiting_mutation_rejects_same_thread_reentry_without_waiting() {
        let repo = tmp_path("task-mutation-reentry");
        std::fs::create_dir_all(repo.join(".alinery")).unwrap();
        let started = Instant::now();
        let error = with_task_mutation_lock(&repo, "outer", || with_task_mutation_lock_waiting(&repo, "inner", Duration::from_secs(2), || Ok(()))).unwrap_err();
        assert_eq!(error, "task mutation busy during inner");
        assert!(started.elapsed() < Duration::from_millis(200), "same-thread re-entry must not wait out itself");
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn task_mutation_serializes_against_file_lock_holder() {
        let repo = tmp_path("task-mutation-file");
        std::fs::create_dir_all(repo.join(".alinery")).unwrap();
        let path = crate::paths::task_mutation_lock_path(&repo);
        assert_ne!(path, crate::paths::alinery_app_lock_path(&repo));
        assert_ne!(path, crate::paths::alineryd_reconciler_lock_path(&repo));

        let held = try_lock_exclusive(&path).unwrap().unwrap();
        let error = with_task_mutation_lock(&repo, "cross process mutation", || Ok(())).unwrap_err();
        assert_eq!(error, "task mutation busy during cross process mutation");
        drop(held);
        with_task_mutation_lock(&repo, "retry mutation", || Ok(())).unwrap();
        let _ = std::fs::remove_dir_all(repo);
    }
}
