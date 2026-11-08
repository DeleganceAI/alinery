// Pure (non-pty) logic extracted for sharing with alineryd + mcp + app.
// This is the common surface that used to live only in session_core.rs (src-tauri/src/).

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::types::ProcessState;
use crate::write_bytes_atomic;
use serde::{Deserialize, Serialize};

pub const DEFAULT_HARNESS_KEY: &str = "omp";
pub const VINCULUM_HARNESS_KEY: &str = "vinculum";
pub const NO_HARNESS_KEY: &str = "no-harness";

/// Session meta for the Vinculum agent. `omp` is the registry key and the value on a file written before the rename.
pub fn is_vinculum_session(key: &str) -> bool {
    key == VINCULUM_HARNESS_KEY || key == DEFAULT_HARNESS_KEY
}

fn validate_relative_artifact_path(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.contains(['\\', '\0', ':'])
        || name.split('/').any(|part| part.is_empty() || part == "." || part == "..")
        || Path::new(name).components().any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!("invalid artifact path: {name}"));
    }
    Ok(())
}

fn resolve_artifact_entry(root: &Path, relative: &str, directory: bool) -> Result<PathBuf, String> {
    if !relative.is_empty() {
        validate_relative_artifact_path(relative)?;
    } else if !directory {
        return Err("empty artifact path".into());
    }
    let inspect = |path: &Path, is_directory: bool| -> Result<(), String> {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() => Err(format!("symlink rejected: {}", path.display())),
            Ok(metadata) if if is_directory { metadata.is_dir() } else { metadata.is_file() } => Ok(()),
            Ok(_) => Err(format!("not a regular {}: {}", if is_directory { "directory" } else { "file" }, path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("inspect {}: {error}", path.display())),
        }
    };
    // The root is the caller's trusted repository boundary; do not canonicalize
    // descendants before inspection, which would hide symlink components.
    inspect(root, true)?;
    let mut path = root.to_path_buf();
    let mut parts = relative.split('/').filter(|part| !part.is_empty()).peekable();
    while let Some(part) = parts.next() {
        path.push(part);
        inspect(&path, directory || parts.peek().is_some())?;
    }
    Ok(path)
}

/// Resolve an ordinary file below a trusted root without following symlinks.
/// Missing directories and the final file are allowed for output reservations.
/// Namespace policy belongs to the caller (attachments use this resolver too).
pub fn resolve_artifact_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    resolve_artifact_entry(root, relative, false)
}

// login_shell_path returns a full $PATH by running the user's $SHELL -ilc.
pub fn login_shell_path() -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    if let Ok(o) = std::process::Command::new(&shell).arg("-ilc").arg("echo -n $PATH").output() {
        if o.status.success() {
            let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !p.is_empty() {
                return p;
            }
        }
    }
    std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into())
}

// ---- session durability & resume (issue #24): pure meta + lifecycle logic ----

// Atomic meta write: serialize to a same-dir tmp file, then rename over the target so a
// concurrent reader never sees a half-written file (three-writer safety: app + daemon).
pub fn write_meta_atomic(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let body = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    write_bytes_atomic(path, body.as_bytes())
}

// Read-modify-write a meta on disjoint fields without clobbering fields written by another
// actor (e.g. the daemon stamps ended_at/exit_code while the app owns started_at/archived).
pub fn stamp_meta(path: &Path, mutate: impl FnOnce(&mut serde_json::Value)) -> Result<(), String> {
    let s = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut v: serde_json::Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    mutate(&mut v);
    write_meta_atomic(path, &v)
}

// Daemon-owned process state wins whenever the owning daemon knows the session.
// Persisted timestamps classify only sessions absent from the live daemon registry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum LifecycleState {
    Live,
    LiveExited,
    NeverStarted,
    Orphaned,
    Interrupted,
    Exited { code: i32 },
}

pub fn classify(started_at: Option<u64>, ended_at: Option<u64>, exit_code: Option<i32>, daemon_process: Option<&ProcessState>) -> LifecycleState {
    match daemon_process {
        Some(ProcessState::Starting | ProcessState::Alive) => LifecycleState::Live,
        Some(ProcessState::Exited { .. }) => LifecycleState::LiveExited,
        None => match (started_at, ended_at, exit_code) {
            (None, _, _) => LifecycleState::NeverStarted,
            (Some(_), None, _) => LifecycleState::Orphaned,
            (Some(_), Some(_), None) => LifecycleState::Interrupted,
            (Some(_), Some(_), Some(code)) => LifecycleState::Exited { code },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::Path;

    // ---- Session durability & resume (issue #24) — Phase 1 pure logic ----
    mod durability {
        use super::*;
        use crate::paths::{all_session_meta_paths, root_sessions_dir, session_meta_path, sessions_dir};
        use crate::types::SessionMeta;
        use serde_json::json;
        use std::path::PathBuf;
        use std::time::SystemTime;

        fn temp_repo(name: &str) -> PathBuf {
            let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos();
            let repo = std::env::temp_dir().join(format!("{name}_{}_{}", std::process::id(), nanos));
            let _ = fs::remove_dir_all(&repo);
            repo
        }

        // --- classify: daemon process precedence over persisted meta ---
        #[test]
        fn classify_alive_wins_over_stale_meta() {
            assert_eq!(classify(Some(1), Some(2), Some(0), Some(&ProcessState::Alive)), LifecycleState::Live);
        }

        #[test]
        fn classify_starting_is_live() {
            assert_eq!(classify(Some(1), None, None, Some(&ProcessState::Starting)), LifecycleState::Live);
        }

        #[test]
        fn classify_exited_daemon_process_is_live_exited() {
            assert_eq!(
                classify(Some(1), Some(2), Some(0), Some(&ProcessState::Exited { code: Some(0) })),
                LifecycleState::LiveExited
            );
        }

        // A missing daemon observation derives lifecycle from persisted facts.
        #[test]
        fn classify_unknown_never_started() {
            assert_eq!(classify(None, None, None, None), LifecycleState::NeverStarted);
        }

        #[test]
        fn classify_unknown_orphaned() {
            assert_eq!(classify(Some(10), None, None, None), LifecycleState::Orphaned);
        }

        #[test]
        fn classify_unknown_interrupted() {
            assert_eq!(classify(Some(10), Some(20), None, None), LifecycleState::Interrupted);
        }

        #[test]
        fn classify_unknown_exited_with_code() {
            assert_eq!(classify(Some(10), Some(20), Some(3), None), LifecycleState::Exited { code: 3 });
        }

        // --- boot-sweep predicate: started && !ended ---

        // --- path resolution: root ("") vs task session ---
        #[test]
        fn session_meta_path_root_vs_task() {
            let repo = Path::new("/tmp/alinery_repo");
            assert_eq!(session_meta_path(repo, "", "s1"), root_sessions_dir(repo).join("s1.meta.json"));
            assert_eq!(session_meta_path(repo, "my-task", "s1"), sessions_dir(repo, "my-task").join("s1.meta.json"));
        }

        // --- telemetry ids resolve through the same root ("") vs task branch ---
        // A root/drawer session's meta lives at .alinery/sessions/, not under tasks/. Reading it
        // from the task branch returns None, and insert_id() omits an empty string, so the minted
        // session_id vanishes from the event stream with no error anywhere. Pin both branches.

        // Legacy rows minted before telemetry_id existed must read back empty, never panic.

        // The daemon's only empty-slug caller is the drawer spawn, which gates on
        // allow_empty_slug_spawn(launch.harness). Reading the task branch always missed, so that
        // gate saw the request's claimed harness instead of the one persisted on disk.

        // --- enumerator: walks BOTH tasks/*/sessions and root sessions, skips non-meta ---
        #[test]
        fn all_session_meta_paths_walks_both_trees() {
            let repo = temp_repo("alinery_all_meta");
            let task_dir = sessions_dir(&repo, "task-a");
            let root_dir = root_sessions_dir(&repo);
            fs::create_dir_all(&task_dir).unwrap();
            fs::create_dir_all(&root_dir).unwrap();
            fs::write(task_dir.join("s1.meta.json"), "{}").unwrap();
            fs::write(root_dir.join("s2.meta.json"), "{}").unwrap();
            fs::write(root_dir.join("notes.txt"), "ignore me").unwrap(); // non-meta skipped

            let mut found = all_session_meta_paths(&repo);
            found.sort();
            let mut want = vec![task_dir.join("s1.meta.json"), root_dir.join("s2.meta.json")];
            want.sort();
            assert_eq!(found, want);
            let _ = fs::remove_dir_all(repo);
        }

        #[test]
        fn all_session_meta_paths_missing_repo_is_empty_not_panic() {
            assert!(all_session_meta_paths(Path::new("/nonexistent/alinery_repo")).is_empty());
        }

        // --- atomic write + typed read round-trip (three-writer safety, Risks §1) ---

        // --- stamp_meta: read-modify-write must not clobber disjoint fields ---

        // --- subst gains a 4th arg for {resume_token} ---

        // --- SessionMeta serde: old files parse (defaults), new fields round-trip ---
        #[test]
        fn session_meta_backward_compat_defaults() {
            // A pre-#24 meta with none of the new fields must still parse.
            let old = r#"{"id":"s1","worktree":"/wt","created":5}"#;
            let meta: SessionMeta = serde_json::from_str(old).unwrap();
            assert_eq!(meta.started_at, None);
            assert_eq!(meta.ended_at, None);
            assert_eq!(meta.exit_code, None);
            assert_eq!(meta.harness_resume_token, "");
            assert_eq!(meta.resume_of, None);
            assert_eq!(meta.status_changed_at, None);
            assert_eq!(meta.status_revision, 0);
            assert_eq!(meta.notification_read_at, None);
            assert_eq!(meta.exit_notification_read_at, None);
            let explicit_null: SessionMeta = serde_json::from_str(r#"{"id":"s1","worktree":"/wt","created":5,"status_changed_at":null}"#).unwrap();
            assert_eq!(explicit_null.status_changed_at, None);
        }

        #[test]
        fn session_meta_missing_pinned_defaults_false() {
            let old = r#"{"id":"s1","worktree":"/wt","created":5}"#;
            let meta: SessionMeta = serde_json::from_str(old).unwrap();
            assert!(!meta.pinned);
        }

        #[test]
        fn session_meta_new_fields_roundtrip() {
            let meta = SessionMeta {
                id: "s2".into(),
                worktree: "/wt".into(),
                created: 7,
                started_at: Some(100),
                status_changed_at: Some(150),
                status_revision: 17,
                ended_at: Some(200),
                exit_code: Some(1),
                harness_resume_token: "tok".into(),
                resume_of: Some("s1".into()),
                notification_read_at: Some(0),
                exit_notification_read_at: Some(200),
                ..Default::default()
            };
            let text = serde_json::to_string(&meta).unwrap();
            let back: SessionMeta = serde_json::from_str(&text).unwrap();
            assert_eq!(back.started_at, Some(100));
            assert_eq!(back.status_changed_at, Some(150));
            assert_eq!(back.status_revision, 17);
            assert_eq!(back.ended_at, Some(200));
            assert_eq!(back.exit_code, Some(1));
            assert_eq!(back.harness_resume_token, "tok");
            assert_eq!(back.notification_read_at, Some(0));
            assert_eq!(back.exit_notification_read_at, Some(200));
            assert_eq!(back.resume_of, Some("s1".into()));
        }

        #[test]
        fn session_meta_artifact_fields_default_and_roundtrip() {
            let old = r#"{"id":"s1","worktree":"/wt","created":5}"#;
            let old_meta: SessionMeta = serde_json::from_str(old).unwrap();
            assert_eq!(old_meta.artifact, "");
            assert_eq!(old_meta.handoff_artifact, "");
            assert_eq!(old_meta.prompt_extra, "");

            let meta = SessionMeta {
                id: "s3".into(),
                worktree: "/wt".into(),
                created: 9,
                phase: "implementation".into(),
                playbook: "superdevelop".into(),
                artifact: "06-implementation-002.md".into(),
                handoff_artifact: "review-handoff-001.md".into(),
                prompt_extra: "Prioritize the transferred review findings.".into(),
                ..Default::default()
            };
            let text = serde_json::to_string(&meta).unwrap();
            let back: SessionMeta = serde_json::from_str(&text).unwrap();
            assert_eq!(back.artifact, "06-implementation-002.md");
            assert_eq!(back.handoff_artifact, "review-handoff-001.md");
            assert_eq!(back.prompt_extra, "Prioritize the transferred review findings.");
            assert_eq!(back.harness_resume_token, "");
            assert_eq!(back.resume_of, None);
        }

        // --- Runner semantic contract — TDD red tests (05-tdd.md) ---
        #[test]
        fn session_meta_defaults_and_serializes_empty_semantic_checkpoint() {
            let old = r#"{"id":"s1","worktree":"/wt","created":5}"#;
            let meta: SessionMeta = serde_json::from_str(old).unwrap();
            let value = serde_json::to_value(meta).unwrap();

            assert_eq!(
                value["semantic"],
                json!({
                    "phase_completed_at": null,
                    "omp_session_id": null,
                    "omp_turn_id": null
                })
            );
            for ephemeral in ["event_token", "process_state", "agent_state", "playbook_state", "event_history"] {
                assert!(value.get(ephemeral).is_none(), "{ephemeral} must remain ephemeral");
            }
        }
    }
}
