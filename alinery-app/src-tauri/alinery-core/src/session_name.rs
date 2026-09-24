use crate::{safe_component, session_meta_path, session_name_path, task_dir, with_task_mutation_lock, SessionMeta};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::Path;

const MAX_NAME_BYTES: u64 = 4096;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionNameSource {
    Auto,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionName {
    pub name: String,
    pub source: SessionNameSource,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionNameWriteStatus {
    Saved,
    Unchanged,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionNameOutcome {
    pub status: SessionNameWriteStatus,
    pub value: SessionName,
}

pub fn validate_session_name(input: &str) -> Result<String, String> {
    let name = input.trim();
    if name.is_empty() {
        return Err("session name must not be empty".into());
    }
    if name.chars().any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}')) {
        return Err("session name must be single-line text without control characters".into());
    }
    if name.chars().count() > 40 {
        return Err("session name must be at most 40 characters".into());
    }
    Ok(name.to_owned())
}

fn bounded_read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|_| "session naming data is unreadable")?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).map_err(|_| "session naming data is unreadable")?;
    if bytes.len() as u64 > limit {
        return Err("session naming data exceeds its size limit".into());
    }
    Ok(bytes)
}

fn validate_target(repo: &Path, slug: &str, id: &str) -> Result<SessionMeta, String> {
    if safe_component(slug) != Some(slug) || safe_component(id) != Some(id) {
        return Err("invalid task slug or session id".into());
    }
    crate::paths::validate_retained_file(repo, &task_dir(repo, slug).join("task.md"))?;
    let task = crate::read_task(repo, slug).ok_or("task record is unavailable")?;
    if task.slug != slug {
        return Err("task slug does not match retained target".into());
    }
    let path = session_meta_path(repo, slug, id);
    crate::paths::validate_retained_file(repo, &path)?;
    let meta: SessionMeta = serde_json::from_slice(&bounded_read(&path, 1024 * 1024)?).map_err(|_| "invalid session metadata")?;
    if meta.id != id {
        return Err("session metadata id does not match retained target".into());
    }
    Ok(meta)
}

fn read_name_bytes(repo: &Path, slug: &str, id: &str) -> Result<Option<Vec<u8>>, String> {
    let path = session_name_path(repo, slug, id);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("session naming data is unreadable".into()),
        Ok(_) => {}
    }
    crate::paths::validate_retained_file(repo, &path)?;
    bounded_read(&path, MAX_NAME_BYTES).map(Some)
}

fn parse_name(bytes: &[u8]) -> Result<SessionName, String> {
    let value: SessionName = serde_json::from_slice(bytes).map_err(|_| "invalid session name data")?;
    if validate_session_name(&value.name)? != value.name {
        return Err("stored session name must be trimmed".into());
    }
    Ok(value)
}

pub fn read_session_name(repo: &Path, task_slug: &str, session_id: &str) -> Result<Option<SessionName>, String> {
    validate_target(repo, task_slug, session_id)?;
    read_name_bytes(repo, task_slug, session_id)?.as_deref().map(parse_name).transpose()
}

pub fn set_session_name(repo: &Path, task_slug: &str, session_id: &str, name: &str, source: SessionNameSource) -> Result<SessionNameOutcome, String> {
    let name = validate_session_name(name)?;
    // Validate before the lock helper can create its directory, then again inside the transaction.
    validate_target(repo, task_slug, session_id)?;
    with_task_mutation_lock(repo, "rename session", || {
        let meta = validate_target(repo, task_slug, session_id)?;
        if source == SessionNameSource::Auto && !meta.execution_id.is_empty() {
            let path = crate::execution_state_path(repo, task_slug)?;
            crate::paths::validate_retained_file(repo, &path)?;
            let state = crate::read_execution_state(repo, task_slug).map_err(|_| "session execution ownership is unavailable")?;
            if state.executions.get(&meta.execution_id).is_none_or(|execution| execution.owner_session_id != session_id) {
                return Err("stale session execution owner".into());
            }
        }
        let path = session_name_path(repo, task_slug, session_id);
        if source == SessionNameSource::Auto {
            if let Some(bytes) = read_name_bytes(repo, task_slug, session_id)? {
                return Ok(SessionNameOutcome {
                    status: SessionNameWriteStatus::Unchanged,
                    value: parse_name(&bytes)?,
                });
            }
        } else {
            match fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("session naming data is unreadable".into()),
                Ok(_) => {
                    crate::paths::validate_retained_file(repo, &path)?;
                    // Manual repair may replace invalid/oversized data, but not an unreadable or read-only file.
                    fs::OpenOptions::new()
                        .read(true)
                        .write(true)
                        .open(&path)
                        .map_err(|_| "session naming data is not readable and writable")?;
                }
            }
        }
        let value = SessionName { name, source };
        let bytes = serde_json::to_vec(&value).map_err(|_| "could not serialize session name")?;
        crate::write_bytes_atomic(&path, &bytes).map_err(|_| "could not save session name; previous name retained")?;
        Ok(SessionNameOutcome {
            status: SessionNameWriteStatus::Saved,
            value,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{session_meta_path, session_name_path, sessions_dir, write_task, SessionMeta, Task};
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn recovery_rejects_old_auto_owner_but_keeps_manual_history() {
        use crate::execution::*;
        let repo = Repo::new();
        let source = include_str!("../../playbooks/one-shot/playbook.md");
        let mut state = new_execution_state(
            crate::playbook::PlaybookRef {
                scope: crate::playbook::PlaybookScope::Repo,
                key: "one-shot".into(),
            },
            source,
            String::new(),
            1,
            Default::default(),
            LaunchChoices::default(),
        )
        .unwrap();
        state.executions.insert(
            "e1".into(),
            ExecutionRecord {
                id: "e1".into(),
                binding_key: "binding".into(),
                candidate: ExecutionCandidate {
                    step_key: "implementation".into(),
                    context_id: "root".into(),
                    inputs: Default::default(),
                    complete_collection_id: None,
                    each_collection_id: None,
                    each_member_id: None,
                    manual: false,
                },
                outputs: vec![],
                parent_execution_ids: Default::default(),
                depth: 0,
                owner_session_id: "s1".into(),
                previous_session_ids: vec![],
                launch: LaunchChoices::default(),
                is_coding_step: true,
                start_requested: false,
                lifecycle: ExecutionLifecycle::Failed,
                permission: CompletionPermission::Locked,
                receipt_id: None,
                exit_code: Some(1),
                shutdown_confirmed: true,
                error: None,
            },
        );
        crate::with_task_mutation_lock(&repo.0, "fixture", || write_execution_state_unlocked(&repo.0, "task", &mut state)).unwrap();
        repo.session(
            "s1",
            SessionMeta {
                execution_id: "e1".into(),
                ..Default::default()
            },
        );
        let path = execution_state_path(&repo.0, "task").unwrap();
        let before = fs::read(&path).unwrap();
        repo.set("s1", "Original", SessionNameSource::Auto).unwrap();
        assert_eq!(fs::read(&path).unwrap(), before, "naming must not bump graph revision");
        let new_id = crate::with_task_mutation_lock(&repo.0, "recover", || {
            let mut saved = read_execution_state(&repo.0, "task")?;
            let id = recover_execution_owner(&mut saved, "e1")?;
            write_execution_state_unlocked(&repo.0, "task", &mut saved)?;
            Ok(id)
        })
        .unwrap();
        repo.session(
            &new_id,
            SessionMeta {
                execution_id: "e1".into(),
                ..Default::default()
            },
        );
        assert_eq!(repo.read(&new_id), None);
        assert_eq!(repo.read("s1").unwrap().name, "Original");
        assert!(repo.set("s1", "Stale", SessionNameSource::Auto).is_err());
        repo.set("s1", "Historical correction", SessionNameSource::User).unwrap();
        repo.set(&new_id, "Recovered work", SessionNameSource::Auto).unwrap();
        assert_eq!(repo.read("s1").unwrap().name, "Historical correction");
        assert_eq!(repo.read(&new_id).unwrap().name, "Recovered work");
    }

    #[test]
    fn lifecycle_updates_do_not_erase_committed_names() {
        let repo = Repo::new();
        let path = session_meta_path(&repo.0, "task", "s1");
        let (ready_tx, ready_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker_path = path.clone();
        let worker = std::thread::spawn(move || {
            crate::stamp_meta(&worker_path, |meta| {
                ready_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                meta["ended_at"] = serde_json::json!(12);
                meta["exit_code"] = serde_json::json!(0);
                meta["semantic"]["phase_completed_at"] = serde_json::json!(11);
            })
            .unwrap()
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let result = repo.set("s1", "Committed during exit", SessionNameSource::User);
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        result.unwrap();
        let saved: SessionMeta = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(saved.ended_at, Some(12));
        assert_eq!(saved.exit_code, Some(0));
        assert_eq!(saved.semantic.phase_completed_at, Some(11));
        assert_eq!(repo.read("s1").unwrap().name, "Committed during exit");
    }
    struct Repo(std::path::PathBuf);
    impl Repo {
        fn new() -> Self {
            let repo = Self(std::env::temp_dir().join(format!("alinery-names-{}", uuid::Uuid::new_v4())));
            write_task(
                &repo.0,
                &Task {
                    slug: "task".into(),
                    name: "Task".into(),
                    ..Default::default()
                },
            )
            .unwrap();
            std::fs::create_dir_all(sessions_dir(&repo.0, "task")).unwrap();
            repo.session("s1", SessionMeta::default());
            repo
        }
        fn session(&self, id: &str, mut meta: SessionMeta) {
            meta.id = id.into();
            std::fs::write(session_meta_path(&self.0, "task", id), serde_json::to_vec(&meta).unwrap()).unwrap();
        }
        fn set(&self, id: &str, name: &str, source: SessionNameSource) -> Result<SessionNameOutcome, String> {
            set_session_name(&self.0, "task", id, name, source)
        }
        fn read(&self, id: &str) -> Option<SessionName> {
            read_session_name(&self.0, "task", id).unwrap()
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn validates_trimmed_unicode_scalar_names_for_both_sources() {
        let repo = Repo::new();
        for source in [SessionNameSource::Auto, SessionNameSource::User] {
            for (index, name) in ["x".repeat(30), "🦀".repeat(40), "e\u{301}".repeat(20)].into_iter().enumerate() {
                let id = format!("s{index}-{source:?}");
                repo.session(&id, SessionMeta::default());
                repo.set(&id, &format!("\u{2003}{name}\u{2003}"), source).unwrap();
                assert_eq!(repo.read(&id).unwrap().name, name);
            }
            repo.set("s1", "Existing", SessionNameSource::User).unwrap();
            for name in [
                "🦀".repeat(41),
                String::new(),
                " \t\n".into(),
                "a\nb".into(),
                "a\0b".into(),
                "a\u{2028}b".into(),
                "a\u{2029}b".into(),
            ] {
                assert!(repo.set("s1", &name, source).is_err());
                assert_eq!(repo.read("s1").unwrap().name, "Existing");
            }
        }
        repo.session("s2", SessionMeta::default());
        repo.set("s2", "Existing", SessionNameSource::User).unwrap();
        assert_eq!(repo.read("s1"), repo.read("s2"));
    }

    #[test]
    fn manual_names_survive_all_retained_session_states_without_a_daemon() {
        let repo = Repo::new();
        for (id, meta) in [
            ("never", SessionMeta::default()),
            (
                "live",
                SessionMeta {
                    started_at: Some(1),
                    harness: "omp".into(),
                    ..Default::default()
                },
            ),
            (
                "terminal",
                SessionMeta {
                    generic: true,
                    harness: "terminal".into(),
                    ..Default::default()
                },
            ),
            (
                "exited",
                SessionMeta {
                    started_at: Some(1),
                    ended_at: Some(2),
                    exit_code: Some(0),
                    ..Default::default()
                },
            ),
            (
                "archive",
                SessionMeta {
                    archived: true,
                    ..Default::default()
                },
            ),
            (
                "historical",
                SessionMeta {
                    execution_id: "missing-old-graph".into(),
                    ..Default::default()
                },
            ),
        ] {
            repo.session(id, meta);
            let path = session_meta_path(&repo.0, "task", id);
            let before = std::fs::read(&path).unwrap();
            repo.set(id, "Retained work", SessionNameSource::User).unwrap();
            assert_eq!(repo.read(id).unwrap().source, SessionNameSource::User);
            assert_eq!(std::fs::read(path).unwrap(), before);
        }
        assert!(!crate::alineryd_socket_path(&repo.0, None).exists());
    }

    #[test]
    fn human_edits_win_every_automatic_ordering() {
        let repo = Repo::new();
        assert_eq!(repo.set("s1", "First", SessionNameSource::Auto).unwrap().status, SessionNameWriteStatus::Saved);
        assert_eq!(repo.set("s1", "Second", SessionNameSource::Auto).unwrap().value.name, "First");
        repo.set("s1", "Human", SessionNameSource::User).unwrap();
        let late = repo.set("s1", "Late", SessionNameSource::Auto).unwrap();
        assert_eq!(late.status, SessionNameWriteStatus::Unchanged);
        assert_eq!(late.value, repo.read("s1").unwrap());
        assert_eq!(late.value.source, SessionNameSource::User);
        repo.set("s1", "Later human", SessionNameSource::User).unwrap();
        assert_eq!(repo.read("s1").unwrap().name, "Later human");
        repo.session("s2", SessionMeta::default());
        repo.set("s2", "Human first", SessionNameSource::User).unwrap();
        assert_eq!(repo.set("s2", "Auto later", SessionNameSource::Auto).unwrap().value.name, "Human first");
    }

    #[test]
    fn busy_name_write_preserves_value_and_allows_explicit_retry() {
        let repo = Repo::new();
        repo.set("s1", "Before", SessionNameSource::User).unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let root = repo.0.clone();
        let worker = std::thread::spawn(move || {
            crate::with_task_mutation_lock(&root, "test", || {
                ready_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            })
            .unwrap()
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let result = repo.set("s1", "After", SessionNameSource::User);
        let before = repo.read("s1");
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        assert!(result.unwrap_err().contains("busy"));
        assert_eq!(before.unwrap().name, "Before");
        repo.set("s1", "After", SessionNameSource::User).unwrap();
        assert_eq!(repo.read("s1").unwrap().name, "After");
    }

    #[test]
    fn rejects_missing_mismatched_and_unsafe_targets_without_recreation() {
        let repo = Repo::new();
        for (slug, id) in [("", "s1"), ("../task", "s1"), ("task", "../s1"), ("missing", "s1"), ("task", "missing")] {
            assert!(set_session_name(&repo.0, slug, id, "No", SessionNameSource::User).is_err());
        }
        assert!(!crate::task_dir(&repo.0, "missing").exists());
        let meta = session_meta_path(&repo.0, "task", "s1");
        std::fs::write(
            &meta,
            serde_json::to_vec(&SessionMeta {
                id: "wrong".into(),
                ..Default::default()
            })
            .unwrap(),
        )
        .unwrap();
        assert!(repo.set("s1", "No", SessionNameSource::User).is_err());
        repo.session("s1", SessionMeta::default());
        let outside = repo.0.join("sentinel");
        std::fs::write(&outside, "sentinel").unwrap();
        let name = session_name_path(&repo.0, "task", "s1");
        std::os::unix::fs::symlink(&outside, &name).unwrap();
        assert!(repo.set("s1", "No", SessionNameSource::User).is_err());
        std::fs::remove_file(&name).unwrap();
        std::fs::hard_link(&outside, &name).unwrap();
        assert!(repo.set("s1", "No", SessionNameSource::User).is_err());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "sentinel");
        std::fs::remove_file(&name).unwrap();
        let sessions = sessions_dir(&repo.0, "task");
        let moved = repo.0.join("moved");
        std::fs::rename(&sessions, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &sessions).unwrap();
        assert!(repo.set("s1", "No", SessionNameSource::User).is_err());
        std::fs::remove_file(&sessions).unwrap();
        assert!(repo.set("s1", "No", SessionNameSource::User).is_err());
        assert!(!sessions.exists());
    }

    #[test]
    fn corrupt_name_requires_explicit_safe_manual_repair() {
        let repo = Repo::new();
        assert_eq!(repo.read("s1"), None);
        let path = session_name_path(&repo.0, "task", "s1");
        for raw in [
            "{".into(),
            r#"{"name":"Okay","source":"alien"}"#.into(),
            r#"{"name":"","source":"user"}"#.into(),
            "x".repeat(4097),
        ] {
            std::fs::write(&path, &raw).unwrap();
            assert!(read_session_name(&repo.0, "task", "s1").unwrap_err().len() < 512);
            assert!(repo.set("s1", "Auto", SessionNameSource::Auto).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), raw);
            repo.set("s1", "Repaired", SessionNameSource::User).unwrap();
            assert_eq!(repo.read("s1").unwrap().name, "Repaired");
        }
    }

    #[test]
    fn failed_name_write_preserves_committed_value() {
        use std::os::unix::fs::PermissionsExt;
        let repo = Repo::new();
        repo.set("s1", "Before", SessionNameSource::User).unwrap();
        let dir = sessions_dir(&repo.0, "task");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let probe = std::fs::write(dir.join("probe"), "probe");
        if probe.is_ok() {
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
            panic!("permission-denial fixture requires a non-root user");
        }
        let result = repo.set("s1", "After", SessionNameSource::User);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
        assert_eq!(repo.read("s1").unwrap().name, "Before");
        let path = session_name_path(&repo.0, "task", "s1");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let result = repo.set("s1", "Repair", SessionNameSource::User);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(result.is_err());
        assert_eq!(repo.read("s1").unwrap().name, "Before");
    }
}
