//! One repository owner, with lane-specific sockets and historical session identities.
use std::collections::BTreeSet;
use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::FileTypeExt;
use std::path::Path;

use crate::execution::{interrupt_unproven_owners, read_execution_state, read_task_playbook, write_execution_state_unlocked, TaskExecutionState};
use crate::lockfile::{try_lock_exclusive, LockFile};

/// Permanent inode leases, retained until the daemon exits. Never unlink these files.
pub struct RepoOwnership {
    _leases: Vec<LockFile>,
}

#[derive(Debug)]
pub struct RepoOwnerReport {
    pub lanes: Vec<RepoOwnerObservation>,
    pub issues: Vec<String>,
}

#[derive(Debug)]
pub struct RepoOwnerObservation {
    pub lane: String,
    /// A connectable socket is a candidate, not verified process identity.
    pub reachable: bool,
    /// Held/unreadable leases and socket inspection errors are not stopped evidence.
    pub issue: Option<String>,
}

pub(crate) fn validate_lane(lane: &str) -> Result<(), String> {
    if lane == "reconciler" || lane.len() > 48 || !lane.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        return Err(format!("invalid daemon ownership lane {lane:?}"));
    }
    Ok(())
}

fn lease(path: &Path) -> Result<LockFile, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => return Err(format!("invalid project owner lock {}", path.display())),
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(format!("inspect project owner lock {}: {error}", path.display())),
    }
    try_lock_exclusive(path)
        .map_err(|error| format!("cannot establish project owner stopped ({}): {error}", path.display()))?
        .ok_or_else(|| format!("project owner is still running ({}); stop it before opening this project here", path.display()))
}

fn entries(path: &Path, issues: &mut Vec<String>) -> Vec<fs::DirEntry> {
    let read = || {
        match fs::symlink_metadata(path) {
            Ok(metadata) if !metadata.is_dir() => return Err(format!("invalid ownership directory {}", path.display())),
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("inspect {}: {error}", path.display())),
        }
        fs::read_dir(path).map(Some).map_err(|error| format!("read {}: {error}", path.display()))
    };
    let mut result = Vec::new();
    match read() {
        Ok(Some(entries)) => {
            for entry in entries {
                match entry {
                    Ok(entry) => result.push(entry),
                    Err(error) => issues.push(format!("read {}: {error}", path.display())),
                }
            }
        }
        Ok(None) => {}
        Err(error) => issues.push(error),
    }
    result.sort_by_key(|entry| entry.file_name());
    result
}

#[derive(Default)]
struct Evidence {
    lanes: BTreeSet<String>,
    states: Vec<(String, TaskExecutionState)>,
    issues: Vec<String>,
}

fn regular_file(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(()),
        Ok(_) => Err(format!("invalid task owner file {}", path.display())),
        Err(error) => Err(format!("missing or unreadable task owner {}: {error}", path.display())),
    }
}

/// Collect independent evidence even if a different record is corrupt. Acquisition
/// rejects any issue before using the collected states or writing anything.
fn enumerate(repo: &Path) -> Evidence {
    let mut evidence = Evidence {
        lanes: BTreeSet::from([String::new()]),
        ..Evidence::default()
    };
    for entry in entries(&crate::alinery_dir(repo), &mut evidence.issues) {
        let result = || -> Result<Option<String>, String> {
            let name = entry.file_name().into_string().map_err(|_| "non-UTF-8 project ownership evidence")?;
            if name == ".alineryd-reconciler.lock" {
                return Ok(None);
            }
            let stem = name.strip_prefix('.').and_then(|s| s.strip_suffix(".lock")).or_else(|| name.strip_suffix(".sock"));
            let Some(stem) = stem else { return Ok(None) };
            let candidate = if stem == "alineryd" {
                ""
            } else if let Some(lane) = stem.strip_prefix("alineryd-") {
                lane
            } else {
                return Ok(None);
            };
            validate_lane(candidate)?;
            if stem != "alineryd" && candidate.is_empty() {
                return Err(format!("invalid daemon ownership file {name}"));
            }
            Ok(Some(candidate.to_owned()))
        };
        match result() {
            Ok(Some(lane)) => {
                evidence.lanes.insert(lane);
            }
            Ok(None) => {}
            Err(error) => evidence.issues.push(error),
        }
    }
    // Archived tasks live in the same directory and are intentionally included.
    for entry in entries(&crate::tasks_dir(repo), &mut evidence.issues) {
        let result = || -> Result<String, String> {
            let slug = entry.file_name().into_string().map_err(|_| "non-UTF-8 task directory")?;
            if crate::safe_component(&slug) != Some(slug.as_str()) || !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                return Err(format!("invalid task ownership evidence: {}", entry.path().display()));
            }
            Ok(slug)
        };
        let slug = match result() {
            Ok(slug) => slug,
            Err(error) => {
                evidence.issues.push(error);
                continue;
            }
        };
        let task_path = entry.path().join("task.md");
        let task = regular_file(&task_path).and_then(|()| {
            let source = fs::read_to_string(&task_path).map_err(|e| format!("read {}: {e}", task_path.display()))?;
            toml::from_str::<crate::Task>(&source).map_err(|e| format!("invalid {}: {e}", task_path.display()))
        });
        let legacy = task.as_ref().is_ok_and(|task| task.engine_version < 2);
        if let Err(error) = task {
            evidence.issues.push(error);
        }
        let state_path = entry.path().join("execution.json");
        if legacy && matches!(fs::symlink_metadata(&state_path), Err(error) if error.kind() == ErrorKind::NotFound) {
            continue;
        }
        let state = regular_file(&state_path).and_then(|()| read_execution_state(repo, &slug));
        let state = match state {
            Ok(state) => state,
            Err(error) => {
                evidence.issues.push(error);
                continue;
            }
        };
        match validate_lane(&state.owning_lane) {
            Ok(()) => {
                evidence.lanes.insert(state.owning_lane.clone());
            }
            Err(error) => evidence.issues.push(error),
        }
        if let Err(error) = regular_file(&entry.path().join("playbook.md")).and_then(|()| read_task_playbook(repo, &slug, &state).map(|_| ())) {
            evidence.issues.push(error);
        }
        if state.revision.checked_add(1).is_none() {
            evidence.issues.push("execution revision overflow".into());
        }
        evidence.states.push((slug, state));
    }
    evidence
}

fn socket_reachable(repo: &Path, lane: &str) -> Result<bool, String> {
    let socket = crate::alineryd_socket_path(repo, Some(lane));
    match fs::symlink_metadata(&socket) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("inspect owner socket {}: {error}", socket.display())),
        Ok(metadata) if !metadata.file_type().is_socket() => return Err(format!("invalid owner socket {}", socket.display())),
        Ok(_) => {}
    }
    match crate::daemon_client::connect_for_ownership_probe(&socket) {
        Ok(_) => Ok(true),
        Err(error) if matches!(error.kind(), ErrorKind::ConnectionRefused | ErrorKind::NotFound) => Ok(false),
        Err(error) => Err(format!("cannot establish owner socket stopped ({}): {error}", socket.display())),
    }
}

/// Non-authoritative diagnostics. A held repository lease must not hide reachable
/// legacy owners; historical held lane leases are blockers, never invented processes.
/// No task writes, shutdown requests, or retained leases are produced here.
pub fn inspect_owners(repo: &Path) -> Result<RepoOwnerReport, String> {
    let evidence = enumerate(repo);
    let mut report = RepoOwnerReport {
        lanes: Vec::new(),
        issues: evidence.issues,
    };
    if let Err(error) = lease(&crate::alinery_dir(repo).join(".repo-owner.lock")) {
        report.issues.push(error);
    }
    for lane in evidence.lanes {
        let lock_error = lease(&crate::alineryd_lock_path(repo, Some(&lane))).err();
        let (reachable, socket_error) = match socket_reachable(repo, &lane) {
            Ok(reachable) => (reachable, None),
            Err(error) => (false, Some(error)),
        };
        let issue = match (lock_error, socket_error) {
            (Some(a), Some(b)) => Some(format!("{a}; {b}")),
            (a, b) => a.or(b),
        };
        report.lanes.push(RepoOwnerObservation { lane, reachable, issue });
    }
    Ok(report)
}

fn discover(repo: &Path, lane: Option<&str>) -> Result<(RepoOwnership, Vec<(String, TaskExecutionState)>), String> {
    let root = crate::alinery_dir(repo);
    fs::create_dir_all(&root).map_err(|error| format!("create {}: {error}", root.display()))?;
    let mut leases = vec![lease(&root.join(".repo-owner.lock"))?];
    let mut evidence = enumerate(repo);
    if let Some(error) = evidence.issues.into_iter().next() {
        return Err(error);
    }
    if let Some(lane) = lane {
        validate_lane(lane)?;
        evidence.lanes.insert(lane.to_owned());
    }
    for lane in evidence.lanes {
        leases.push(lease(&crate::alineryd_lock_path(repo, Some(&lane)))?);
        if socket_reachable(repo, &lane)? {
            return Err(format!(
                "project owner is still answering {}; stop it before opening this project here",
                crate::alineryd_socket_path(repo, Some(&lane)).display()
            ));
        }
    }
    Ok((RepoOwnership { _leases: leases }, evidence.states))
}

/// Diagnostic availability fence: no task writes; all leases released on return.
pub fn check_available(repo: &Path) -> Result<(), String> {
    crate::with_task_mutation_lock_waiting(repo, "check project ownership", crate::TASK_MUTATION_CONTENTION_WAIT, || discover(repo, None).map(|_| ()))
}

#[cfg(test)]
thread_local! {
    static FAIL_ADOPTION_WRITE_AFTER: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}

/// Thread-scoped private test seam: real writes until the selected write fails.
#[cfg(test)]
pub(crate) fn with_adoption_write_failure<T>(after: usize, run: impl FnOnce() -> T) -> T {
    struct Reset(Option<usize>);
    impl Drop for Reset {
        fn drop(&mut self) {
            FAIL_ADOPTION_WRITE_AFTER.set(self.0);
        }
    }
    let _reset = Reset(FAIL_ADOPTION_WRITE_AFTER.replace(Some(after)));
    run()
}

/// Authoritative startup fence. All owners and records are checked before any write.
pub fn acquire(repo: &Path, lane: &str, app_config_identity: &str) -> Result<RepoOwnership, String> {
    crate::with_task_mutation_lock_waiting(repo, "acquire project ownership", crate::TASK_MUTATION_CONTENTION_WAIT, || {
        let (guard, states) = discover(repo, Some(lane))?;
        for (slug, mut state) in states {
            // Always interrupt uncertain work, including retries after a partial durable
            // batch. Ownership adoption is not proof that any child process stopped.
            let interrupted = state.executions.values().any(|record| record.lifecycle.holds_capacity());
            interrupt_unproven_owners(&mut state, &BTreeSet::new());
            if state.owning_lane != lane || state.owning_app_config_identity != app_config_identity || interrupted {
                state.owning_lane = lane.into();
                state.owning_app_config_identity = app_config_identity.into();
                #[cfg(test)]
                if let Some(remaining) = FAIL_ADOPTION_WRITE_AFTER.get() {
                    if remaining == 0 {
                        return Err("injected adoption write failure".into());
                    }
                    FAIL_ADOPTION_WRITE_AFTER.set(Some(remaining - 1));
                }
                write_execution_state_unlocked(repo, &slug, &mut state)?;
            }
        }
        Ok(guard)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::unix::fs::{symlink, MetadataExt};
    use std::os::unix::net::UnixListener;
    use std::path::PathBuf;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let repo = PathBuf::from("/tmp").join(format!("ao-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(crate::tasks_dir(&repo)).unwrap();
            Self(repo)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn inspection_reports_two_owners_without_adoption() {
        let fixture = Fixture::new();
        let repo = &fixture.0;
        let root = crate::alinery_dir(repo);
        let repo_lease = lease(&root.join(".repo-owner.lock")).unwrap();
        let mut listeners = Vec::new();
        let mut leases = Vec::new();
        for lane in ["old-a", "old-b"] {
            listeners.push(UnixListener::bind(crate::alineryd_socket_path(repo, Some(lane))).unwrap());
            leases.push(lease(&crate::alineryd_lock_path(repo, Some(lane))).unwrap());
        }
        let broken = crate::task_dir(repo, "broken");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join("task.md"), "invalid task").unwrap();
        fs::write(broken.join("execution.json"), "invalid execution").unwrap();
        let before = fs::read(broken.join("execution.json")).unwrap();
        let report = inspect_owners(repo).unwrap();
        assert_eq!(
            report.lanes.iter().filter(|row| row.reachable).map(|row| row.lane.as_str()).collect::<Vec<_>>(),
            ["old-a", "old-b"]
        );
        assert!(report.issues.iter().any(|issue| issue.contains(".repo-owner.lock")));
        assert!(report.issues.iter().any(|issue| issue.contains("task.md")));
        assert!(report.issues.iter().any(|issue| issue.contains("execution state")));
        assert_eq!(fs::read(broken.join("execution.json")).unwrap(), before);
        assert_eq!(fs::read(broken.join("task.md")).unwrap(), b"invalid task");
        for listener in listeners {
            listener.set_nonblocking(true).unwrap();
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            stream.read_to_end(&mut request).unwrap();
            assert!(request.is_empty(), "diagnostics must not send shutdown or any request");
        }
        assert!(check_available(repo).is_err());
        drop((leases, repo_lease));
    }

    #[test]
    fn historical_held_leases_are_not_duplicate_processes() {
        let fixture = Fixture::new();
        let repo = &fixture.0;
        let listener = UnixListener::bind(crate::alineryd_socket_path(repo, Some("current"))).unwrap();
        let paths: Vec<_> = ["current", "historical-a", "historical-b"]
            .into_iter()
            .map(|lane| crate::alineryd_lock_path(repo, Some(lane)))
            .collect();
        let leases: Vec<_> = paths.iter().map(|path| lease(path).unwrap()).collect();
        let inodes: Vec<_> = paths
            .iter()
            .map(|path| {
                let m = fs::metadata(path).unwrap();
                (m.dev(), m.ino())
            })
            .collect();
        let invalid = crate::alineryd_lock_path(repo, Some("invalid"));
        symlink(&paths[0], &invalid).unwrap();
        let report = inspect_owners(repo).unwrap();
        assert_eq!(
            report.lanes.iter().filter(|row| row.reachable).map(|row| row.lane.as_str()).collect::<Vec<_>>(),
            ["current"]
        );
        for lane in ["historical-a", "historical-b", "invalid"] {
            let row = report.lanes.iter().find(|row| row.lane == lane).unwrap();
            assert!(!row.reachable);
            assert!(row.issue.is_some());
        }
        assert!(check_available(repo).is_err());
        assert!(acquire(repo, "replacement", "config").is_err());
        drop((listener, leases));
        assert!(check_available(repo).is_err(), "symlinked lease remains unsafe after owner exit");
        fs::remove_file(invalid).unwrap();
        check_available(repo).unwrap();
        for (path, inode) in paths.iter().zip(inodes) {
            let m = fs::metadata(path).unwrap();
            assert_eq!((m.dev(), m.ino()), inode);
        }
    }
}
