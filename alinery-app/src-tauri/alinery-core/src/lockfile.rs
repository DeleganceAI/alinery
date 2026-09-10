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

static TASK_MUTATION_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Run one task-record transaction under both a process-local nonblocking mutex and a
/// repository flock. `flock` alone is insufficient because separate descriptors in one process
/// do not exclude one another on every supported Unix.
pub fn with_task_mutation_lock<T>(repo: &Path, operation: &str, mutate: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let key = repo.canonicalize().unwrap_or_else(|_| repo.to_path_buf());
    let process_lock = {
        let mut locks = TASK_MUTATION_LOCKS.lock().map_err(|_| format!("task mutation lock registry poisoned during {operation}"))?;
        Arc::clone(locks.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))))
    };
    let _process_guard = match process_lock.try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::WouldBlock) => {
            return Err(format!("task mutation busy during {operation}"));
        }
        Err(TryLockError::Poisoned(_)) => {
            return Err(format!("task mutation lock poisoned during {operation}"));
        }
    };

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
