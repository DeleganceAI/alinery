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

fn validate_lane(lane: &str) -> Result<(), String> {
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

fn entries(path: &Path) -> Result<Vec<fs::DirEntry>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_dir() => return Err(format!("invalid ownership directory {}", path.display())),
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("inspect {}: {error}", path.display())),
    }
    match fs::read_dir(path) {
        Ok(entries) => entries.collect::<Result<Vec<_>, _>>().map_err(|error| format!("read {}: {error}", path.display())),
        Err(error) => Err(format!("read {}: {error}", path.display())),
    }
}

fn discover(repo: &Path, lane: Option<&str>) -> Result<(RepoOwnership, Vec<(String, TaskExecutionState)>), String> {
    let root = crate::alinery_dir(repo);
    fs::create_dir_all(&root).map_err(|error| format!("create {}: {error}", root.display()))?;
    let mut leases = vec![lease(&root.join(".repo-owner.lock"))?];
    let mut lanes = BTreeSet::from([String::new()]);
    if let Some(lane) = lane {
        validate_lane(lane)?;
        lanes.insert(lane.to_owned());
    }
    for entry in entries(&root)? {
        let name = entry.file_name().into_string().map_err(|_| "non-UTF-8 project ownership evidence")?;
        if name == ".alineryd-reconciler.lock" {
            continue;
        }
        let stem = name.strip_prefix('.').and_then(|s| s.strip_suffix(".lock")).or_else(|| name.strip_suffix(".sock"));
        let Some(stem) = stem else { continue };
        let candidate = if stem == "alineryd" {
            ""
        } else if let Some(lane) = stem.strip_prefix("alineryd-") {
            lane
        } else {
            continue;
        };
        validate_lane(candidate)?;
        if stem != "alineryd" && candidate.is_empty() {
            return Err(format!("invalid daemon ownership file {name}"));
        }
        lanes.insert(candidate.to_owned());
    }
    let mut states = Vec::new();
    // Archived tasks live in the same directory and are intentionally included.
    for entry in entries(&crate::tasks_dir(repo))? {
        let slug = entry.file_name().into_string().map_err(|_| "non-UTF-8 task directory")?;
        if crate::safe_component(&slug) != Some(slug.as_str()) || !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            return Err(format!("invalid task ownership evidence: {}", entry.path().display()));
        }
        let task_path = entry.path().join("task.md");
        let source = fs::read_to_string(&task_path).map_err(|e| format!("read {}: {e}", task_path.display()))?;
        let task: crate::Task = toml::from_str(&source).map_err(|e| format!("invalid {}: {e}", task_path.display()))?;
        let state_path = entry.path().join("execution.json");
        match fs::symlink_metadata(&state_path) {
            Err(error) if error.kind() == ErrorKind::NotFound && task.engine_version < 2 => continue,
            Err(error) => return Err(format!("missing or unreadable task owner {}: {error}", state_path.display())),
            Ok(metadata) if !metadata.is_file() => return Err(format!("invalid task owner file {}", state_path.display())),
            Ok(_) => {}
        }
        let state = read_execution_state(repo, &slug)?;
        validate_lane(&state.owning_lane)?;
        read_task_playbook(repo, &slug, &state)?;
        state.revision.checked_add(1).ok_or("execution revision overflow")?;
        lanes.insert(state.owning_lane.clone());
        states.push((slug, state));
    }
    for lane in lanes {
        leases.push(lease(&crate::alineryd_lock_path(repo, Some(&lane)))?);
        let socket = crate::alineryd_socket_path(repo, Some(&lane));
        match fs::symlink_metadata(&socket) {
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("inspect owner socket {}: {error}", socket.display())),
            Ok(metadata) if !metadata.file_type().is_socket() => return Err(format!("invalid owner socket {}", socket.display())),
            Ok(_) => {}
        }
        match crate::daemon_client::connect_for_ownership_probe(&socket) {
            Ok(_) => return Err(format!("project owner is still answering {}; stop it before opening this project here", socket.display())),
            Err(error) if matches!(error.kind(), ErrorKind::ConnectionRefused | ErrorKind::NotFound) => {}
            Err(error) => return Err(format!("cannot establish owner socket stopped ({}): {error}", socket.display())),
        }
    }
    Ok((RepoOwnership { _leases: leases }, states))
}

/// Diagnostic only: no task writes, and all leases are released before returning.
pub fn check_available(repo: &Path) -> Result<(), String> {
    crate::with_task_mutation_lock_waiting(repo, "check project ownership", crate::TASK_MUTATION_CONTENTION_WAIT, || discover(repo, None).map(|_| ()))
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
                write_execution_state_unlocked(repo, &slug, &mut state)?;
            }
        }
        Ok(guard)
    })
}
