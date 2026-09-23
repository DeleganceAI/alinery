// Storage accounting + archived-data purge (issue #91).
//
// One classification walk of `<repo>/.alinery` splits every byte into two buckets:
//   - archived  = exactly what `purge_archived_storage` deletes (reclaimable)
//   - active    = everything else (read-only number for the user)
// Size and delete MUST share the same scan so the MB the UI confirms is the MB the button frees.
//
// Nothing outside `.alinery` is ever measured or touched: `task.worktree` holds the MAIN repo path
// when `has_worktree == false`, so worktrees are discovered by scanning `.alinery/worktrees/` only.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::lockfile::with_task_mutation_lock;
use crate::paths::{alinery_dir, tasks_dir, worktrees_dir};
use crate::shared::read_session_meta_full;
use crate::task::{read_task, task_dir};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct StorageStats {
    /// Archived task dirs under `.alinery/tasks/`.
    pub archived_task_count: u32,
    /// Every session meta under an archived task + archived sessions under live tasks.
    pub archived_session_count: u32,
    /// Reclaimable — exactly what `purge_archived_storage` frees.
    pub archived_bytes: u64,
    /// Live tasks + live/orphan worktrees + all other `.alinery` content.
    pub active_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PurgeFailure {
    /// Identifies what failed: `task:<slug>` | `session:<id>` | `worktree:<slug>`.
    pub target: String,
    pub error: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PurgeArchivedResult {
    pub deleted_tasks: u32,
    pub deleted_sessions: u32,
    pub deleted_worktrees: u32,
    pub errors: Vec<PurgeFailure>,
}

/// Single classification walk of `<repo>/.alinery`. Missing `.alinery` → all zeros.
pub fn storage_stats(repo: &Path) -> StorageStats {
    scan(repo).stats
}

/// Delete the archived bucket. `kill(task_slug, session_id)` is invoked once per session id that
/// is about to disappear, before any unlink; it is best effort and its failures are not recorded.
pub fn purge_archived_storage(repo: &Path, kill: &dyn Fn(&str, &str)) -> Result<PurgeArchivedResult, String> {
    with_task_mutation_lock(repo, "purge archived storage", || {
        let targets = scan(repo);
        let mut res = PurgeArchivedResult::default();

        // 1) Every pty that owns a file we are about to unlink dies first. Best effort: an offline
        //    daemon is exactly the case where nothing holds the files.
        for (slug, id) in &targets.kill_ids {
            kill(slug, id);
        }

        // 2) Archived sessions living under a still-live task: unlink their files, keep the task.
        for (_slug, id, files) in &targets.session_files {
            let mut failure = None;
            for f in files {
                if !f.exists() {
                    continue;
                }
                if let Err(e) = fs::remove_file(f) {
                    failure = Some(format!("{}: {e}", f.display()));
                    break;
                }
            }
            match failure {
                Some(error) => res.errors.push(PurgeFailure {
                    target: format!("session:{id}"),
                    error,
                }),
                None => res.deleted_sessions += 1,
            }
        }

        // 3) Worktrees of archived tasks. git first (keeps the worktree admin data consistent),
        //    plain removal as the fallback. A failure here never blocks the task delete below.
        for (slug, path) in &targets.worktrees {
            let mut why = match crate::git_cmd(repo).args(["worktree", "remove", "--force"]).arg(path).output() {
                Ok(out) if out.status.success() => String::new(),
                Ok(out) => String::from_utf8_lossy(&out.stderr).trim().to_string(),
                Err(e) => format!("git worktree remove: {e}"),
            };
            if path.exists() {
                if let Err(e) = fs::remove_dir_all(path) {
                    why = format!("{}: {e}", path.display());
                }
            }
            if path.exists() {
                if why.is_empty() {
                    why = format!("{} still present after removal", path.display());
                }
                res.errors.push(PurgeFailure {
                    target: format!("worktree:{slug}"),
                    error: why,
                });
            } else {
                res.deleted_worktrees += 1;
            }
        }

        // 4) Archived task dirs. Scan and delete are not atomic, so re-assert `archived` right
        //    before the unlink (same guard shape as the app's `delete_draft_in`).
        for slug in &targets.tasks {
            let still_archived = read_task(repo, slug).is_some_and(|t| t.archived);
            if !still_archived {
                res.errors.push(PurgeFailure {
                    target: format!("task:{slug}"),
                    error: "not archived".into(),
                });
                continue;
            }
            let dir = task_dir(repo, slug);
            match fs::remove_dir_all(&dir) {
                Ok(()) => res.deleted_tasks += 1,
                Err(e) => res.errors.push(PurgeFailure {
                    target: format!("task:{slug}"),
                    error: format!("{}: {e}", dir.display()),
                }),
            }
        }

        Ok(res)
    })
}

/// MiB with exactly two fraction digits, e.g. "0.00 MB", "4.02 MB". Mirrors the TS `formatMb`.
pub fn format_mb(bytes: u64) -> String {
    format!("{:.2} MB", bytes as f64 / 1024.0 / 1024.0)
}

#[derive(Default)]
struct ArchivedTargets {
    stats: StorageStats,
    /// Archived slugs — the whole task dir is reclaimable.
    tasks: Vec<String>,
    /// (live task slug, session id, files to unlink).
    session_files: Vec<(String, String, Vec<PathBuf>)>,
    /// (archived slug, `.alinery/worktrees/<slug>`).
    worktrees: Vec<(String, PathBuf)>,
    /// (task slug, session id) to kill before anything is unlinked.
    kill_ids: Vec<(String, String)>,
}

/// The only walk: stats and purge targets come from one pass so they cannot diverge.
fn scan(repo: &Path) -> ArchivedTargets {
    let alinery = alinery_dir(repo);
    let mut t = ArchivedTargets::default();
    let Ok(root) = fs::read_dir(&alinery) else {
        return t;
    };

    let tasks = tasks_dir(repo);
    let worktrees = worktrees_dir(repo);
    for entry in root.flatten() {
        let path = entry.path();
        if path == tasks || path == worktrees {
            continue; // classified below
        }
        // config.toml, harnesses.toml, playbooks/, sessions/, sockets, locks, anything unknown.
        t.stats.active_bytes += path_size(&path);
    }

    let mut archived_slugs: Vec<String> = vec![];
    if let Ok(rd) = fs::read_dir(&tasks) {
        for entry in rd.flatten() {
            let path = entry.path();
            let size = path_size(&path);
            let Some(slug) = entry.file_name().to_str().map(str::to_string) else {
                t.stats.active_bytes += size;
                continue;
            };
            // Unreadable or unparseable task.md → never classifiable, never a target.
            let Some(task) = read_task(repo, &slug) else {
                t.stats.active_bytes += size;
                continue;
            };
            if task.archived {
                t.stats.archived_bytes += size;
                t.stats.archived_task_count += 1;
                for id in session_ids(&path.join("sessions")) {
                    t.stats.archived_session_count += 1;
                    t.kill_ids.push((slug.clone(), id));
                }
                archived_slugs.push(slug.clone());
                t.tasks.push(slug);
            } else {
                t.stats.active_bytes += size;
                // Archived sessions under a live task move their own files to the archived bucket.
                let sessions = path.join("sessions");
                for id in session_ids(&sessions) {
                    let meta = sessions.join(format!("{id}.meta.json"));
                    if !read_session_meta_full(&meta).is_some_and(|m| m.archived) {
                        continue; // live, or unparseable → stays active, never deleted
                    }
                    let files = session_files(&sessions, &id);
                    let moved: u64 = files.iter().map(|f| file_len(f)).sum();
                    t.stats.active_bytes -= moved;
                    t.stats.archived_bytes += moved;
                    t.stats.archived_session_count += 1;
                    t.kill_ids.push((slug.clone(), id.clone()));
                    t.session_files.push((slug.clone(), id, files));
                }
            }
        }
    }

    if let Ok(rd) = fs::read_dir(&worktrees) {
        for entry in rd.flatten() {
            let path = entry.path();
            let size = path_size(&path);
            let slug = entry.file_name().to_string_lossy().to_string();
            // Live-task slug or true orphan (no task at all) → active, never a target.
            if archived_slugs.contains(&slug) {
                t.stats.archived_bytes += size;
                t.worktrees.push((slug, path));
            } else {
                t.stats.active_bytes += size;
            }
        }
    }

    t
}

/// Session ids in a `sessions/` dir, taken from `<id>.meta.json` names.
fn session_ids(dir: &Path) -> Vec<String> {
    let Ok(rd) = fs::read_dir(dir) else {
        return vec![];
    };
    rd.flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_suffix(".meta.json").map(str::to_string)
        })
        .collect()
}

/// Every file belonging to one session: its meta, name, scrollback, and any crashed
/// `atomic_tmp_path` leftover (`<id>.<something>.tmp.<pid>.<nanos>.<seq>`). The `<id>.` prefix
/// keeps session `a1` from claiming session `a`'s files.
fn session_files(dir: &Path, id: &str) -> Vec<PathBuf> {
    let prefix = format!("{id}.");
    let Ok(rd) = fs::read_dir(dir) else {
        return vec![];
    };
    rd.flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let keep = name == format!("{id}.meta.json")
                || name == format!("{id}.name.json")
                || name == format!("{id}.scrollback")
                || (name.starts_with(&prefix) && name.contains(".tmp."));
            keep.then(|| e.path())
        })
        .collect()
}

fn file_len(path: &Path) -> u64 {
    fs::symlink_metadata(path).ok().filter(|md| md.is_file()).map_or(0, |md| md.len())
}

/// Bytes at `path`: a regular file's length, or the recursive sum of a directory.
/// `symlink_metadata` throughout — a symlink is neither file nor dir here, so the walk can
/// never follow one out of `.alinery`.
fn path_size(path: &Path) -> u64 {
    let Ok(md) = fs::symlink_metadata(path) else {
        return 0;
    };
    if md.is_file() {
        return md.len();
    }
    if !md.is_dir() {
        return 0;
    }
    let Ok(rd) = fs::read_dir(path) else {
        return 0;
    };
    rd.flatten().map(|e| path_size(&e.path())).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lockfile::with_task_mutation_lock;
    use crate::paths::{alinery_dir, worktrees_dir};
    use crate::task::{restore_task, task_dir};
    use crate::types::{SessionMeta, Task};
    use parking_lot::Mutex;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_repo(name: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = TEST_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let repo = std::env::temp_dir().join(format!("alinery_storage_{name}_{}_{}_{}", std::process::id(), nanos, seq));
        fs::create_dir_all(alinery_dir(&repo)).unwrap();
        repo
    }

    /// Write `body` at `path`, creating parents. Returns the byte length written.
    fn write_file(path: &Path, body: &str) -> u64 {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
        body.len() as u64
    }

    fn write_task_md(repo: &Path, slug: &str, archived: bool, worktree: &str) -> u64 {
        let task = Task {
            name: slug.to_string(),
            slug: slug.to_string(),
            branch: slug.to_string(),
            worktree: worktree.to_string(),
            has_worktree: !worktree.is_empty(),
            created: 1,
            archived,
            ..Default::default()
        };
        let body = toml::to_string(&task).unwrap();
        write_file(&task_dir(repo, slug).join("task.md"), &body)
    }

    fn write_session_meta(repo: &Path, slug: &str, id: &str, archived: bool) -> u64 {
        let meta = SessionMeta {
            id: id.to_string(),
            worktree: String::new(),
            created: 1,
            archived,
            phase: "research".into(),
            harness: "claude".into(),
            playbook: "superdevelop".into(),
            ..Default::default()
        };
        let body = serde_json::to_string_pretty(&meta).unwrap();
        write_file(&task_dir(repo, slug).join("sessions").join(format!("{id}.meta.json")), &body)
    }

    fn session_file(repo: &Path, slug: &str, name: &str) -> PathBuf {
        task_dir(repo, slug).join("sessions").join(name)
    }

    /// Independent recursive byte sum (regular files only) — the oracle for the coverage test.
    fn recursive_size(dir: &Path) -> u64 {
        let mut total = 0u64;
        let Ok(rd) = fs::read_dir(dir) else {
            return 0;
        };
        for entry in rd.flatten() {
            let p = entry.path();
            let Ok(md) = fs::symlink_metadata(&p) else {
                continue;
            };
            if md.is_dir() {
                total += recursive_size(&p);
            } else if md.is_file() {
                total += md.len();
            }
        }
        total
    }

    /// Fixture shared by the split/coverage/purge tests.
    ///
    /// ```text
    /// .alinery/config.toml
    /// .alinery/tasks/arch/task.md                  archived task
    /// .alinery/tasks/arch/artifacts/01.md
    /// .alinery/tasks/arch/sessions/s1.meta.json
    /// .alinery/tasks/arch/sessions/s1.scrollback
    /// .alinery/tasks/arch/sessions/s2.meta.json
    /// .alinery/tasks/live/task.md                  live task
    /// .alinery/tasks/live/sessions/a1.meta.json    archived == true
    /// .alinery/tasks/live/sessions/a1.scrollback
    /// .alinery/tasks/live/sessions/l1.meta.json    live
    /// .alinery/worktrees/arch/f                    worktree of an archived task
    /// .alinery/worktrees/live/f                    worktree of a live task
    /// ```
    /// Returns `(archived_bytes, active_bytes)` hand-summed from the writes.
    fn build_mixed_repo(repo: &Path) -> (u64, u64) {
        let mut archived = 0u64;
        let mut active = 0u64;

        active += write_file(&alinery_dir(repo).join("config.toml"), "notify = false\n");

        archived += write_task_md(repo, "arch", true, "");
        archived += write_file(&task_dir(repo, "arch").join("artifacts").join("01.md"), "archived artifact body\n");
        archived += write_session_meta(repo, "arch", "s1", false);
        archived += write_file(&session_file(repo, "arch", "s1.scrollback"), "scrollback bytes for s1");
        archived += write_session_meta(repo, "arch", "s2", true);

        active += write_task_md(repo, "live", false, "");
        archived += write_session_meta(repo, "live", "a1", true);
        archived += write_file(&session_file(repo, "live", "a1.scrollback"), "scrollback bytes for a1");
        active += write_session_meta(repo, "live", "l1", false);

        archived += write_file(&worktrees_dir(repo).join("arch").join("f"), "archived wt\n");
        active += write_file(&worktrees_dir(repo).join("live").join("f"), "live wt\n");

        (archived, active)
    }

    #[test]
    fn storage_stats_empty_repo_is_zero() {
        let repo = temp_repo("empty");
        fs::remove_dir_all(alinery_dir(&repo)).unwrap();
        assert_eq!(storage_stats(&repo), StorageStats::default());
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn storage_stats_splits_archived_and_active() {
        let repo = temp_repo("split");
        let (want_archived, want_active) = build_mixed_repo(&repo);

        let stats = storage_stats(&repo);
        assert_eq!(stats.archived_task_count, 1, "one archived task dir");
        assert_eq!(stats.archived_session_count, 3, "s1 + s2 under the archived task, a1 under the live task");
        assert_eq!(stats.archived_bytes, want_archived);
        assert_eq!(stats.active_bytes, want_active);

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn storage_stats_counts_archived_session_names_as_reclaimable() {
        let repo = temp_repo("name-accounting");
        write_task_md(&repo, "live", false, "");
        let meta_bytes = write_session_meta(&repo, "live", "s1", true);
        let name_bytes = write_file(&session_file(&repo, "live", "s1.name.json"), r#"{"name":"Repair cache eviction","source":"user"}"#);
        write_session_meta(&repo, "live", "s10", false);
        write_file(&session_file(&repo, "live", "s10.name.json"), r#"{"name":"Import CSV","source":"auto"}"#);

        let stats = storage_stats(&repo);
        let total = recursive_size(&alinery_dir(&repo));
        fs::remove_dir_all(&repo).unwrap();

        assert_eq!(stats.archived_session_count, 1, "a name sidecar is not another session");
        assert_eq!(stats.archived_bytes, meta_bytes + name_bytes, "the displayed reclaimable size includes the archived name");
        assert_eq!(stats.active_bytes, total - meta_bytes - name_bytes);
    }

    #[test]
    fn purge_removes_archived_session_name_without_touching_other_names() {
        let repo = temp_repo("name-purge");
        write_task_md(&repo, "live", false, "");
        write_session_meta(&repo, "live", "s1", true);
        let archived_name = session_file(&repo, "live", "s1.name.json");
        write_file(&archived_name, r#"{"name":"Repair cache eviction","source":"user"}"#);
        write_session_meta(&repo, "live", "s10", false);
        write_file(&session_file(&repo, "live", "broken.meta.json"), "{not json");
        let retained = ["s10.name.json", "broken.name.json", "orphan.name.json"];
        let name = r#"{"name":"Keep this name","source":"user"}"#;
        for file in retained {
            write_file(&session_file(&repo, "live", file), name);
        }

        let result = purge_archived_storage(&repo, &|_, _| {}).unwrap();
        let archived_name_remains = archived_name.exists();
        let retained_contents: Vec<_> = retained.iter().map(|file| fs::read_to_string(session_file(&repo, "live", file)).unwrap()).collect();
        fs::remove_dir_all(&repo).unwrap();

        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.deleted_sessions, 1);
        assert!(!archived_name_remains, "purging an archived session must not orphan its persisted name");
        assert!(
            retained_contents.iter().all(|contents| contents == name),
            "live, unreadable and orphan records are not purge targets"
        );
    }

    #[test]
    fn storage_stats_buckets_cover_whole_alinery_dir() {
        let repo = temp_repo("coverage");
        build_mixed_repo(&repo);

        let stats = storage_stats(&repo);
        assert_eq!(
            stats.active_bytes + stats.archived_bytes,
            recursive_size(&alinery_dir(&repo)),
            "every byte under .alinery lands in exactly one bucket"
        );

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn storage_stats_ignores_worktree_outside_alinery() {
        let repo = temp_repo("outside");
        write_task_md(&repo, "live", false, repo.to_str().unwrap());
        let before = storage_stats(&repo);

        // has_worktree == false stores the MAIN repo path in `task.worktree`; measuring it would
        // count the whole repository.
        write_file(&repo.join("big.bin"), &"x".repeat(1024 * 1024));
        let after = storage_stats(&repo);

        assert_eq!(before, after, "nothing outside .alinery is measured");
        assert!(after.active_bytes < 1024 * 1024);

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn storage_stats_keeps_unreadable_task_and_meta_active() {
        let repo = temp_repo("unreadable");
        let mut want_active = 0u64;
        // Task dir without task.md.
        want_active += write_file(&task_dir(&repo, "no-task-md").join("stray.txt"), "orphan dir contents\n");
        // Live task with a corrupt session meta.
        want_active += write_task_md(&repo, "live", false, "");
        want_active += write_file(&session_file(&repo, "live", "bad.meta.json"), "{not json");

        let stats = storage_stats(&repo);
        assert_eq!(stats.archived_task_count, 0);
        assert_eq!(stats.archived_session_count, 0);
        assert_eq!(stats.archived_bytes, 0);
        assert_eq!(stats.active_bytes, want_active);

        // Neither is ever a purge target.
        let res = purge_archived_storage(&repo, &|_, _| {}).unwrap();
        assert_eq!(res, PurgeArchivedResult::default());
        assert!(task_dir(&repo, "no-task-md").join("stray.txt").exists());
        assert!(session_file(&repo, "live", "bad.meta.json").exists());

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn purge_removes_archived_targets_only() {
        let repo = temp_repo("purge");
        let (_, want_active) = build_mixed_repo(&repo);
        let live_wt = worktrees_dir(&repo).join("live").join("f");
        let live_wt_bytes = fs::metadata(&live_wt).unwrap().len();

        let res = purge_archived_storage(&repo, &|_, _| {}).unwrap();
        assert_eq!(res.deleted_tasks, 1);
        assert_eq!(res.deleted_sessions, 1);
        assert_eq!(res.deleted_worktrees, 1);
        assert!(res.errors.is_empty(), "unexpected failures: {:?}", res.errors);

        // Gone.
        assert!(!task_dir(&repo, "arch").exists());
        assert!(!worktrees_dir(&repo).join("arch").exists());
        assert!(!session_file(&repo, "live", "a1.meta.json").exists());
        assert!(!session_file(&repo, "live", "a1.scrollback").exists());

        // Untouched.
        assert!(session_file(&repo, "live", "l1.meta.json").exists());
        assert!(task_dir(&repo, "live").join("task.md").exists());
        assert!(alinery_dir(&repo).join("config.toml").exists());
        assert_eq!(fs::metadata(&live_wt).unwrap().len(), live_wt_bytes);

        let after = storage_stats(&repo);
        assert_eq!(after.archived_task_count, 0);
        assert_eq!(after.archived_session_count, 0);
        assert_eq!(after.archived_bytes, 0);
        assert_eq!(after.active_bytes, want_active, "active bytes untouched");

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn purge_archived_task_includes_name_sidecars() {
        let repo = temp_repo("purge_task_names");
        write_task_md(&repo, "arch", true, "");
        write_session_meta(&repo, "arch", "s1", false);
        let name = session_file(&repo, "arch", "s1.name.json");
        write_file(&name, r#"{"name":"Retained","source":"user"}"#);
        let result = purge_archived_storage(&repo, &|_, _| {}).unwrap();
        assert_eq!(result.deleted_tasks, 1);
        assert!(!name.exists());
        assert!(!task_dir(&repo, "arch").exists());
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn purge_kills_every_targeted_session_before_delete() {
        let repo = temp_repo("kill");
        build_mixed_repo(&repo);

        let killed: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
        purge_archived_storage(&repo, &|slug: &str, id: &str| {
            assert!(task_dir(&repo, slug).exists(), "kill must run BEFORE the files disappear");
            killed.lock().push((slug.into(), id.into()));
        })
        .unwrap();

        let killed = killed.into_inner();
        assert!(killed.contains(&("arch".into(), "s1".into())));
        assert!(killed.contains(&("arch".into(), "s2".into())));
        assert!(killed.contains(&("live".into(), "a1".into())));
        assert!(!killed.iter().any(|(_, id)| id == "l1"), "live session must never be killed: {killed:?}");

        let _ = fs::remove_dir_all(&repo);
    }

    #[cfg(unix)]
    #[test]
    fn purge_reports_failed_target_and_continues() {
        use std::os::unix::fs::PermissionsExt;

        let repo = temp_repo("failure");
        write_task_md(&repo, "blocked", true, "");
        write_file(&task_dir(&repo, "blocked").join("artifacts").join("01.md"), "cannot be unlinked\n");
        write_task_md(&repo, "second", true, "");

        let blocked = task_dir(&repo, "blocked");
        // r-x: readable (scan still works) but children cannot be unlinked → remove_dir_all EACCES.
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o500)).unwrap();

        let res = purge_archived_storage(&repo, &|_, _| {}).unwrap();

        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o700)).unwrap();

        assert_eq!(res.deleted_tasks, 1, "the healthy task is still deleted");
        assert_eq!(res.errors.len(), 1, "one named failure: {:?}", res.errors);
        assert_eq!(res.errors[0].target, "task:blocked");
        assert!(!res.errors[0].error.is_empty());
        assert!(!task_dir(&repo, "second").exists());
        assert!(blocked.exists());

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn purge_sweeps_archived_session_tmp_leftovers_only() {
        let repo = temp_repo("tmpleftover");
        let mut want_archived = 0u64;
        let mut want_active = 0u64;

        want_active += write_task_md(&repo, "live", false, "");
        // Archived session: meta + scrollback + a crashed atomic-write temp
        // (`path.with_extension("tmp.<pid>.<nanos>.<seq>")`, shared.rs:1623-1629).
        want_archived += write_session_meta(&repo, "live", "a1", true);
        want_archived += write_file(&session_file(&repo, "live", "a1.scrollback"), "a1 bytes");
        want_archived += write_file(&session_file(&repo, "live", "a1.meta.tmp.4242.99.0"), "half-written a1 meta");
        // Live session with its own leftover temp: neither may be counted or deleted.
        want_active += write_session_meta(&repo, "live", "l1", false);
        want_active += write_file(&session_file(&repo, "live", "l1.meta.tmp.4242.99.1"), "half-written l1 meta");

        let stats = storage_stats(&repo);
        assert_eq!(stats.archived_session_count, 1);
        assert_eq!(stats.archived_bytes, want_archived, "temp joins its session");
        assert_eq!(stats.active_bytes, want_active);

        let res = purge_archived_storage(&repo, &|_, _| {}).unwrap();
        assert_eq!(res.deleted_sessions, 1);
        assert!(res.errors.is_empty(), "unexpected failures: {:?}", res.errors);
        assert!(!session_file(&repo, "live", "a1.meta.tmp.4242.99.0").exists());
        assert!(session_file(&repo, "live", "l1.meta.tmp.4242.99.1").exists());
        assert!(session_file(&repo, "live", "l1.meta.json").exists());

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn storage_keeps_orphan_worktree_active() {
        let repo = temp_repo("orphan");
        // A worktree dir whose slug has no task.md at all — never a purge target (design rule 4).
        let bytes = write_file(&worktrees_dir(&repo).join("ghost").join("f"), "ghost tree\n");

        let stats = storage_stats(&repo);
        assert_eq!(stats.archived_bytes, 0);
        assert_eq!(stats.active_bytes, bytes);

        let res = purge_archived_storage(&repo, &|_, _| {}).unwrap();
        assert_eq!(res.deleted_worktrees, 0);
        assert!(worktrees_dir(&repo).join("ghost").join("f").exists());

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn purge_lock_contention_has_no_side_effects() {
        let repo = temp_repo("lock-contention");
        build_mixed_repo(&repo);
        let preserved = [
            task_dir(&repo, "arch").join("task.md"),
            task_dir(&repo, "arch").join("artifacts").join("01.md"),
            session_file(&repo, "arch", "s1.meta.json"),
            session_file(&repo, "live", "a1.meta.json"),
            worktrees_dir(&repo).join("arch").join("f"),
        ];
        let kill_count = AtomicU64::new(0);

        with_task_mutation_lock(&repo, "test hold", || {
            let error = purge_archived_storage(&repo, &|_, _| {
                kill_count.fetch_add(1, Ordering::Relaxed);
            })
            .unwrap_err();
            assert_eq!(error, "task mutation busy during purge archived storage");
            Ok(())
        })
        .unwrap();

        assert_eq!(kill_count.load(Ordering::Relaxed), 0);
        for path in preserved {
            assert!(path.exists(), "{} was removed", path.display());
        }
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn purge_holds_lock_during_kill_callback() {
        let repo = temp_repo("lock-during-kill");
        write_task_md(&repo, "arch", true, "");
        write_session_meta(&repo, "arch", "s1", false);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let purge_repo = repo.clone();
        let purge = std::thread::spawn(move || {
            purge_archived_storage(&purge_repo, &|_, _| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            })
        });

        entered_rx.recv().unwrap();
        let error = restore_task(&repo, "arch").unwrap_err();
        assert_eq!(error, "task mutation busy during restore task");
        assert!(read_task(&repo, "arch").unwrap().archived);
        release_tx.send(()).unwrap();

        let result = purge.join().unwrap().unwrap();
        assert_eq!(result.deleted_tasks, 1);
        assert!(!task_dir(&repo, "arch").exists());
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn format_mb_uses_two_decimals() {
        assert_eq!(format_mb(0), "0.00 MB");
        assert_eq!(format_mb(1_000), "0.00 MB");
        assert_eq!(format_mb(4_215_275), "4.02 MB");
        assert_eq!(format_mb(1_048_576), "1.00 MB");
    }
}
