//! Session and task actions that only change files under `<repo>/.alinery`: marking
//! notifications read, flagging a session archived, archiving a task. They live in core so the
//! same code runs in-process for a local repo and on the host for a remote one. Anything that
//! also has to stop a process (kill, the live half of archive) stays with the daemon client.

use crate::stamp_meta;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn completion_notification_checkpoint(value: &Value) -> Option<u64> {
    value.get("semantic").and_then(|semantic| semantic.get("phase_completed_at")).and_then(Value::as_u64)
}

fn exit_notification_checkpoint(value: &Value) -> Option<u64> {
    value
        .get("exit_code")
        .and_then(Value::as_i64)
        .filter(|code| *code != 0)
        .and_then(|_| value.get("ended_at").and_then(Value::as_u64))
}

fn stamp_notification_checkpoint(value: &mut Value, field: &str, checkpoint: Option<u64>) {
    let Some(checkpoint) = checkpoint else {
        return;
    };
    let prior = value.get(field).and_then(Value::as_u64).unwrap_or(0);
    value[field] = json!(prior.max(checkpoint));
}

fn notification_checkpoint_advances(value: &Value, field: &str, checkpoint: Option<u64>) -> bool {
    checkpoint.is_some_and(|checkpoint| value.get(field).and_then(Value::as_u64).is_none_or(|prior| checkpoint > prior))
}

pub fn session_notification_path(repo: &Path, task_slug: &str, id: &str) -> Result<PathBuf, String> {
    let task_slug = crate::safe_component(task_slug).ok_or_else(|| "invalid task slug".to_string())?;
    let id = crate::safe_component(id).ok_or_else(|| "invalid session id".to_string())?;
    let path = crate::session_meta_path(repo, task_slug, id);
    fs::metadata(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn read_meta_value(path: &Path) -> Result<Value, String> {
    serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

/// Mark both the completion and the failed-exit notification of a session read.
pub fn mark_notification_read(repo: &Path, task_slug: &str, id: &str) -> Result<(), String> {
    let path = session_notification_path(repo, task_slug, id)?;
    let persisted = read_meta_value(&path)?;
    let completion = completion_notification_checkpoint(&persisted);
    let exit = exit_notification_checkpoint(&persisted);
    if !notification_checkpoint_advances(&persisted, "notification_read_at", completion) && !notification_checkpoint_advances(&persisted, "exit_notification_read_at", exit) {
        return Ok(());
    }
    stamp_meta(&path, |value| {
        stamp_notification_checkpoint(value, "notification_read_at", completion);
        stamp_notification_checkpoint(value, "exit_notification_read_at", exit);
    })
}

/// Mark only the failed-exit notification read.
pub fn mark_exit_notification_read(repo: &Path, task_slug: &str, id: &str) -> Result<(), String> {
    let path = session_notification_path(repo, task_slug, id)?;
    let persisted = read_meta_value(&path)?;
    let exit = exit_notification_checkpoint(&persisted);
    if !notification_checkpoint_advances(&persisted, "exit_notification_read_at", exit) {
        return Ok(());
    }
    stamp_meta(&path, |value| stamp_notification_checkpoint(value, "exit_notification_read_at", exit))
}

/// Flag a session archived. This is a read-modify-write of `archived` only, so it cannot clobber
/// the started/ended/exit fields the daemon writes concurrently.
pub fn stamp_session_archived(repo: &Path, task_slug: &str, id: &str) -> Result<(), String> {
    stamp_meta(&crate::session_meta_path(repo, task_slug, id), |value| value["archived"] = json!(true))
}

/// Archive a task after checking nothing forbids it. The worktree and branch are untouched.
pub fn archive_task_on_disk(repo: &Path, slug: &str) -> Result<(), String> {
    crate::ensure_task_can_archive(repo, slug)?;
    crate::archive_task_guarded(repo, slug)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SessionMeta;

    fn repo_with_session(name: &str, meta: &SessionMeta) -> PathBuf {
        let repo = std::env::temp_dir().join(format!("ai-sa-{name}-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
        let path = crate::session_meta_path(&repo, "task", &meta.id);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, serde_json::to_string(meta).unwrap()).unwrap();
        repo
    }

    #[test]
    fn marking_read_records_the_completion_and_failed_exit_checkpoints() {
        let mut meta = SessionMeta {
            id: "s".into(),
            ended_at: Some(50),
            exit_code: Some(2),
            ..Default::default()
        };
        meta.semantic.phase_completed_at = Some(40);
        let repo = repo_with_session("read", &meta);
        mark_notification_read(&repo, "task", "s").unwrap();
        let stored = read_meta_value(&crate::session_meta_path(&repo, "task", "s")).unwrap();
        assert_eq!(
            (stored["notification_read_at"].as_u64(), stored["exit_notification_read_at"].as_u64()),
            (Some(40), Some(50))
        );
        // A second call has nothing to advance and leaves the file alone.
        mark_notification_read(&repo, "task", "s").unwrap();
        fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn a_clean_exit_has_no_exit_notification_to_read() {
        let meta = SessionMeta {
            id: "s".into(),
            ended_at: Some(50),
            exit_code: Some(0),
            ..Default::default()
        };
        let repo = repo_with_session("clean", &meta);
        mark_exit_notification_read(&repo, "task", "s").unwrap();
        let stored = read_meta_value(&crate::session_meta_path(&repo, "task", "s")).unwrap();
        assert!(stored.get("exit_notification_read_at").is_none_or(|value| value.is_null()), "{stored}");
        fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn unsafe_slugs_and_ids_are_refused_before_touching_disk() {
        let meta = SessionMeta {
            id: "s".into(),
            ..Default::default()
        };
        let repo = repo_with_session("unsafe", &meta);
        for (slug, id) in [("../task", "s"), ("task", "../s"), ("", "s"), ("task", "")] {
            assert!(mark_notification_read(&repo, slug, id).is_err(), "{slug}/{id}");
        }
        fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn archiving_a_session_changes_only_the_archived_flag() {
        let meta = SessionMeta {
            id: "s".into(),
            ended_at: Some(9),
            exit_code: Some(1),
            ..Default::default()
        };
        let repo = repo_with_session("archive", &meta);
        stamp_session_archived(&repo, "task", "s").unwrap();
        let stored: SessionMeta = serde_json::from_value(read_meta_value(&crate::session_meta_path(&repo, "task", "s")).unwrap()).unwrap();
        assert!(stored.archived);
        assert_eq!((stored.ended_at, stored.exit_code), (Some(9), Some(1)));
        fs::remove_dir_all(repo).unwrap();
    }
}
