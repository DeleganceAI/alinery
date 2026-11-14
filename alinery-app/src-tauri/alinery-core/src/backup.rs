// Backup types and the checks the shell still makes locally: destination validation and reading an archive's metadata.
// Creating, listing, pruning and restoring archives is the daemon's (`vinculum-daemon/src/domain/backup.ts`), and a remote
// repo's restore runs in the host service. The one archive written here is a reset's (`reset_alinery_state`): a project
// that needs one is one no daemon can open.
//
// `meta.repo_path` — not the filename — decides which backups belong to a repo. Two repos with the same basename may share
// one destination directory.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

use crate::paths::alinery_dir;

/// Archive-root name of the metadata sidecar.
pub const BACKUP_META_NAME: &str = "backup-meta.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BackupTrigger {
    Manual,
    PreArchive,
    PostArtifactChange,
    PostPushCommit,
    Mcp,
}

impl BackupTrigger {
    pub fn as_str(self) -> &'static str {
        match self {
            BackupTrigger::Manual => "manual",
            BackupTrigger::PreArchive => "pre_archive",
            BackupTrigger::PostArtifactChange => "post_artifact_change",
            BackupTrigger::PostPushCommit => "post_push_commit",
            BackupTrigger::Mcp => "mcp",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BackupMeta {
    pub repo_name: String,
    /// Canonical absolute path of the repo this archive was taken from. Authoritative for
    /// list membership, retention membership, and cross-repo restore rejection.
    pub repo_path: String,
    pub created_at: u64,
    pub schema_version: u32,
    pub alinery_version: String,
    pub trigger: BackupTrigger,
    pub included_dirs: Vec<String>,
}

fn canonical_string(path: &Path) -> Result<String, String> {
    fs::canonicalize(path)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("resolve {}: {e}", path.display()))
}

/// Validate a backup destination: non-empty, an existing writable directory, and not equal to
/// or under the repo's `.alinery/` (a destination inside `.alinery/` would zip and clear itself).
/// Both sides are canonicalized, so a symlink pointing into `.alinery/` is rejected too.
pub fn validate_backup_destination(repo: &Path, dest: &Path) -> Result<PathBuf, String> {
    if dest.as_os_str().is_empty() {
        return Err("backup destination is not set".to_string());
    }
    let meta = fs::metadata(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    if !meta.is_dir() {
        return Err(format!("{} is not a directory", dest.display()));
    }
    let dest_canon = fs::canonicalize(dest).map_err(|e| format!("{}: {e}", dest.display()))?;

    let alinery = alinery_dir(repo);
    // An absent `.alinery/` cannot contain anything; only compare when it resolves.
    if let Ok(alinery_canon) = fs::canonicalize(&alinery) {
        if dest_canon == alinery_canon || dest_canon.starts_with(&alinery_canon) {
            return Err(format!("backup destination must be outside {}", alinery_canon.display()));
        }
    }

    // Honest writability check: permission bits do not tell the whole story (read-only mounts,
    // ACLs, sandboxes), so probe with a real file.
    let probe = dest_canon.join(format!(
        ".alinery-backup-probe.{}.{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    ));
    File::create(&probe).map_err(|e| format!("{} is not writable: {e}", dest_canon.display()))?;
    let _ = fs::remove_file(&probe);

    Ok(dest_canon)
}

/// Read `backup-meta.json` out of an archive without extracting anything else.
pub fn read_backup_meta(zip_path: &Path) -> Result<BackupMeta, String> {
    let file = File::open(zip_path).map_err(|e| format!("{}: {e}", zip_path.display()))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("{}: {e}", zip_path.display()))?;
    let mut entry = archive.by_name(BACKUP_META_NAME).map_err(|e| format!("{}: {BACKUP_META_NAME}: {e}", zip_path.display()))?;
    let mut body = String::new();
    entry.read_to_string(&mut body).map_err(|e| format!("{}: {e}", zip_path.display()))?;
    serde_json::from_str(&body).map_err(|e| format!("{}: {e}", zip_path.display()))
}

/// A backup may only be restored into the repo it was taken from.
pub fn require_backup_matches_repo(repo: &Path, backup_path: &Path) -> Result<(), String> {
    let meta = read_backup_meta(backup_path)?;
    let expected = canonical_string(repo)?;
    if meta.repo_path != expected {
        return Err(format!("this backup belongs to {}, not {expected}", meta.repo_path));
    }
    Ok(())
}

/// What a backup holds, as in `backup.ts` `CURATED`: the durable data under `.alinery/`. Worktrees (uncommitted work), sockets,
/// locks and `tmp/` are runtime or git's, never archived.
const CURATED: [&str; 6] = ["tasks", "sessions", "config.toml", "harnesses.toml", "playbooks.toml", "playbooks"];

/// What a reset clears once the archive is safe: every task and the root session store. Settings and playbooks stay, worktrees
/// stay (they hold uncommitted work, and their branches with them), and lock files stay (permanent markers, never unlinked).
pub const RESET_CLEARED: [&str; 2] = ["tasks", "sessions"];

fn collect_files(root: &Path, name: &str, out: &mut Vec<String>) -> Result<(), String> {
    let path = root.join(name);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    // A symlink is skipped, not followed: it could reach outside the tree the archive describes.
    if metadata.is_dir() {
        let mut entries: Vec<_> = fs::read_dir(&path)
            .map_err(|e| format!("{}: {e}", path.display()))?
            .flatten()
            .map(|e| e.file_name())
            .collect();
        entries.sort();
        for entry in entries {
            collect_files(root, &format!("{name}/{}", entry.to_string_lossy()), out)?;
        }
    } else if metadata.is_file() {
        out.push(name.to_string());
    }
    Ok(())
}

/// The user's reset of a project whose saved state will not open: archive everything a backup holds to a zip next to the
/// repository (outside `.alinery/`, which is being cleared, and outside the working tree), check the archive reads back, then
/// clear [`RESET_CLEARED`]. The archive is a normal backup (`backup-meta.json`), so it restores into this repository. Callers
/// make sure no daemon is running. Returns the archive's path.
pub fn reset_alinery_state(repo: &Path, alinery_version: &str) -> Result<PathBuf, String> {
    crate::with_task_mutation_lock(repo, "reset project state", || {
        let alinery = alinery_dir(repo);
        let repo_path = canonical_string(repo)?;
        let canonical = PathBuf::from(&repo_path);
        let repo_name = canonical.file_name().map_or_else(|| "repo".to_string(), |name| name.to_string_lossy().into_owned());
        let dest = canonical.parent().ok_or("the repository has no parent folder to hold the backup")?;
        let mut files = Vec::new();
        for name in CURATED {
            collect_files(&alinery, name, &mut files)?;
        }
        let meta = BackupMeta {
            repo_name: repo_name.clone(),
            repo_path,
            created_at: SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()),
            schema_version: 1,
            alinery_version: alinery_version.to_string(),
            trigger: BackupTrigger::Manual,
            included_dirs: CURATED
                .iter()
                .filter(|name| fs::symlink_metadata(alinery.join(name)).is_ok())
                .map(|name| name.to_string())
                .collect(),
        };
        let safe: String = repo_name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
        let stem = format!("{safe}-alinery-reset-{}", meta.created_at);
        let final_path = (1..1000)
            .map(|n| dest.join(if n == 1 { format!("{stem}.zip") } else { format!("{stem}-{n}.zip") }))
            .find(|path| fs::symlink_metadata(path).is_err())
            .ok_or("no free name for the backup")?;
        let tmp = dest.join(format!(".{stem}.{}.tmp.zip", std::process::id()));
        let written = (|| -> Result<(), String> {
            let mut zip = ZipWriter::new(File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?);
            let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file(BACKUP_META_NAME, options).map_err(|e| e.to_string())?;
            zip.write_all(&serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            for name in &files {
                zip.start_file(name.as_str(), options).map_err(|e| e.to_string())?;
                zip.write_all(&fs::read(alinery.join(name)).map_err(|e| format!("{name}: {e}"))?)
                    .map_err(|e| e.to_string())?;
            }
            zip.finish().map_err(|e| e.to_string())?.sync_all().map_err(|e| e.to_string())?;
            // Nothing is cleared on the strength of an archive that does not read back whole.
            let entries = ZipArchive::new(File::open(&tmp).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?.len();
            if entries != files.len() + 1 || read_backup_meta(&tmp)? != meta {
                return Err("the backup did not read back whole".into());
            }
            fs::rename(&tmp, &final_path).map_err(|e| format!("{}: {e}", final_path.display()))
        })();
        if let Err(error) = written {
            let _ = fs::remove_file(&tmp);
            return Err(format!("backup failed, nothing was cleared: {error}"));
        }
        for name in RESET_CLEARED {
            let path = alinery.join(name);
            if fs::symlink_metadata(&path).is_ok() {
                fs::remove_dir_all(&path).map_err(|e| format!("the backup is at {}, but clearing {} failed: {e}", final_path.display(), path.display()))?;
            }
        }
        Ok(final_path)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp(name: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = TEST_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{name}_{}_{}_{}", std::process::id(), nanos, seq))
    }

    fn plant(path: PathBuf, body: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    /// A repo whose `.alinery/` holds one of every curated AND every excluded thing, plus a
    /// sibling destination directory. The fixture is the spec: membership assertions read
    /// straight off it.
    fn fixture_repo(name: &str) -> (PathBuf, PathBuf) {
        let base = unique_temp(name);
        let repo = base.join("myrepo");
        let dest = base.join("dest");
        let alinery = alinery_dir(&repo);
        // curated
        plant(alinery.join("tasks/alpha/task.md"), b"name = \"alpha\"\n");
        plant(alinery.join("tasks/alpha/artifacts/00-ticket.md"), b"# ticket\n");
        plant(alinery.join("tasks/alpha/sessions/s1.meta.json"), b"{\"id\":\"s1\"}");
        plant(alinery.join("tasks/alpha/sessions/s1.scrollback"), &[0u8, 27, 91, 255, 10]);
        plant(alinery.join("sessions/root1.meta.json"), b"{\"id\":\"root1\"}");
        plant(alinery.join("config.toml"), b"[linear]\n");
        plant(alinery.join("harnesses.toml"), b"[[harness]]\n");
        plant(alinery.join("playbooks.toml"), b"[[playbook]]\n");
        plant(alinery.join("playbooks/custom.md"), b"custom\n");
        // excluded
        plant(alinery.join("worktrees/alpha/README.md"), b"work in progress\n");
        plant(alinery.join("alineryd.sock"), b"");
        plant(alinery.join(".alineryd.lock"), b"");
        plant(alinery.join("mcp.status.json"), b"{}");
        fs::create_dir_all(&dest).unwrap();
        (repo, dest)
    }

    fn cleanup(repo: &Path) {
        let _ = fs::remove_dir_all(repo.parent().unwrap());
    }

    // ---- 2A. validate_backup_destination ----

    // 2.1 — an unset destination is the "feature off" state, not a usable path.
    #[test]
    fn destination_empty_is_rejected() {
        let (repo, _dest) = fixture_repo("bk_dest_empty");
        assert!(validate_backup_destination(&repo, Path::new("")).is_err());
        cleanup(&repo);
    }

    // 2.2 — a path that does not exist, or is a regular file, cannot hold archives.
    #[test]
    fn destination_missing_or_file_is_rejected() {
        let (repo, dest) = fixture_repo("bk_dest_missing");
        assert!(validate_backup_destination(&repo, &dest.join("nope")).is_err());
        let file = dest.join("a-file");
        fs::write(&file, b"x").unwrap();
        assert!(validate_backup_destination(&repo, &file).is_err());
        cleanup(&repo);
    }

    // 2.3 — `.alinery/` itself is zipped and cleared on restore; archives cannot live there.
    #[test]
    fn destination_equal_to_alinery_dir_is_rejected() {
        let (repo, _dest) = fixture_repo("bk_dest_is_alinery");
        assert!(validate_backup_destination(&repo, &alinery_dir(&repo)).is_err());
        cleanup(&repo);
    }

    // 2.4 — same recursion guard one level down.
    #[test]
    fn destination_under_alinery_dir_is_rejected() {
        let (repo, _dest) = fixture_repo("bk_dest_under_alinery");
        let inside = alinery_dir(&repo).join("backups");
        fs::create_dir_all(&inside).unwrap();
        assert!(validate_backup_destination(&repo, &inside).is_err());
        cleanup(&repo);
    }

    // 2.5 — both sides are canonicalized, so a symlink cannot smuggle the destination inside.
    #[test]
    fn destination_symlinked_into_alinery_dir_is_rejected() {
        let (repo, dest) = fixture_repo("bk_dest_symlink");
        let inside = alinery_dir(&repo).join("backups");
        fs::create_dir_all(&inside).unwrap();
        let link = dest.join("link");
        std::os::unix::fs::symlink(&inside, &link).unwrap();
        assert!(validate_backup_destination(&repo, &link).is_err());
        cleanup(&repo);
    }

    // 2.6 — the rule is "not under .alinery/", nothing broader: the repo root is fine.
    #[test]
    fn destination_outside_alinery_dir_is_accepted() {
        let (repo, dest) = fixture_repo("bk_dest_outside");
        assert!(validate_backup_destination(&repo, &dest).is_ok());
        assert!(validate_backup_destination(&repo, &repo).is_ok());
        cleanup(&repo);
    }

    // 2.7 — permission bits lie less than metadata does; the probe is the real answer.
    #[test]
    fn destination_not_writable_is_rejected() {
        use std::os::unix::fs::PermissionsExt;
        let (repo, dest) = fixture_repo("bk_dest_ro");
        let ro = dest.join("readonly");
        fs::create_dir_all(&ro).unwrap();
        fs::set_permissions(&ro, fs::Permissions::from_mode(0o555)).unwrap();
        // Root ignores the mode entirely; skip rather than assert something false.
        if File::create(ro.join(".root-check")).is_ok() {
            let _ = fs::remove_file(ro.join(".root-check"));
        } else {
            assert!(validate_backup_destination(&repo, &ro).is_err());
        }
        fs::set_permissions(&ro, fs::Permissions::from_mode(0o755)).unwrap();
        cleanup(&repo);
    }

    // ---- 2B. backup_feature_ready ----

    // 2.8 — the one gate the UI, the auto queue, and MCP all share.

    // ---- 2C. create_backup ----

    // 2.9 — everything durable makes it in, including root sessions and binary scrollback.

    // 2.10 — whole-name scan, so a future stray include fails loudly instead of bloating zips.

    // 2.11 — scrollback is raw terminal bytes; a text-mode writer would corrupt it.

    // 2.12 — the meta is what makes an archive identifiable after the filename is renamed.

    // 2.13 — the name must stay parseable: list's cheap prefix filter depends on it.

    // 2.14 — a repo directory name is user input; it must never become a path separator.

    // 2.15 — a refused create must leave the destination byte-identical: no partial artifact.

    // 2.16 — a leaked `.tmp` would be counted by list/retention and shown to the user.

    // 2.17 — epoch-second names collide; silently replacing the first would make "keep 10"
    // quietly keep fewer and hide a backup the user explicitly asked for.

    // ---- 2D. list_backups ----

    // 2.18 — the Settings list renders this order verbatim.

    // 2.19 — collision safety: two repos may share a basename and a destination folder.

    // 2.20 — the destination is a user folder; junk in it must not break the list.

    // 2.21 — "no backups yet" is a normal state, not an error banner.

    // 2.22 — an unusable destination is an error the user needs to see.

    // ---- 2E. enforce_retention ----

    // 2.23 — the off-by-one: at exactly N, nothing is deleted.

    // 2.24 — oldest first, and the surviving order is still newest-first.

    // 2.25 — retention 1 is a legal setting, not a wipe.

    // 2.26 — a shared destination must never cost another repo its history.

    // 2.27 — deleting a user's unrelated files from their own folder is the worst outcome here.

    // 2.28 — 0 must not mean "delete everything"; 200 must not mean "unbounded".

    #[test]
    fn reset_archives_everything_a_backup_holds_then_clears_tasks_and_sessions_only() {
        let parent = unique_temp("reset");
        let repo = parent.join("my repo");
        let alinery = alinery_dir(&repo);
        plant(alinery.join("tasks/t/task.md"), b"task");
        plant(alinery.join("tasks/t/execution.json"), b"{\"version\":2}");
        plant(alinery.join("sessions/s.meta.json"), b"{}");
        plant(alinery.join("config.toml"), b"[backup]");
        plant(alinery.join("worktrees/t/uncommitted.rs"), b"work");
        plant(alinery.join(".repo-owner.lock"), b"");

        let zip = reset_alinery_state(&repo, "9.9.9").unwrap();
        assert_eq!(zip.parent().unwrap(), fs::canonicalize(&parent).unwrap(), "next to the repository, not inside it");
        assert!(zip.file_name().unwrap().to_string_lossy().starts_with("my-repo-alinery-reset-"));
        require_backup_matches_repo(&repo, &zip).unwrap();
        let mut archive = ZipArchive::new(File::open(&zip).unwrap()).unwrap();
        let mut names: Vec<String> = (0..archive.len()).map(|i| archive.by_index(i).unwrap().name().to_string()).collect();
        names.sort();
        assert_eq!(
            names,
            ["backup-meta.json", "config.toml", "sessions/s.meta.json", "tasks/t/execution.json", "tasks/t/task.md"]
        );
        let mut body = String::new();
        archive.by_name("tasks/t/execution.json").unwrap().read_to_string(&mut body).unwrap();
        assert_eq!(body, "{\"version\":2}");

        assert!(!alinery.join("tasks").exists() && !alinery.join("sessions").exists());
        assert!(alinery.join("config.toml").exists(), "settings stay");
        assert!(alinery.join("worktrees/t/uncommitted.rs").exists(), "uncommitted work stays");
        assert!(alinery.join(".repo-owner.lock").exists(), "lock markers are never unlinked");
        let _ = fs::remove_dir_all(&parent);
    }
}
