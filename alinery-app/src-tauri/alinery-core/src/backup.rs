// Backup engine (issue #79): curated zip archives of a repo's `.alinery/` data.
//
// Pure path-based create/list/prune/extract. No Tauri, no UI, no daemon — the app owns the
// queue and the destructive restore orchestration, MCP owns its tools, and both call in here.
//
// Two rules the rest of the feature leans on:
//   * `CURATED_ALINERY_PATHS` is the single source of truth for what is backed up. Restore clears
//     exactly this set before extracting, so anything cleared is guaranteed to have been saved.
//   * `meta.repo_path` — not the filename — decides which backups belong to a repo. Two repos
//     with the same basename may share one destination directory.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use zip::ZipArchive;

use crate::paths::alinery_dir;

/// Archive-root name of the metadata sidecar. Never extracted back into `.alinery/`.
pub const BACKUP_META_NAME: &str = "backup-meta.json";

/// Everything under `.alinery/` that is durable alinery data, relative to `.alinery/`.
///
/// Deliberately excluded: `worktrees/` (git-backed, holds uncommitted user work), sockets,
/// lock files, and MCP status sidecars — all runtime-only and meaningless after a restore.
/// `sessions/` is the root (taskless) session store and IS durable data, so it is included;
/// backing it up but not clearing it would leave stale sessions pointing at replaced tasks.
pub const CURATED_ALINERY_PATHS: &[&str] = &["tasks", "sessions", "config.toml", "harnesses.toml", "playbooks.toml", "playbooks"];

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

/// Remove exactly what `create_backup` archives — no more. Anything cleared here but not
/// archived there is data the user loses on restore, so both read `CURATED_ALINERY_PATHS`.
/// Missing paths are not an error: a repo may never have had a `playbooks.toml`.
pub fn clear_curated_alinery_data(repo: &Path) -> Result<(), String> {
    let alinery = alinery_dir(repo);
    for name in CURATED_ALINERY_PATHS {
        let path = alinery.join(name);
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        let removed = if meta.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
        removed.map_err(|e| format!("clear {}: {e}", path.display()))?;
    }
    Ok(())
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

/// Validate → clear → extract. Stopping the daemon is the caller's job (it owns the sessions that
/// hold this data); keeping that out of here is what makes the destructive half testable.
pub fn restore_backup_into(repo: &Path, backup_path: &Path) -> Result<(), String> {
    // Identity first. A mismatched archive must cost the user nothing.
    require_backup_matches_repo(repo, backup_path)?;
    clear_curated_alinery_data(repo)?;
    extract_backup_into(backup_path, &alinery_dir(repo), Some(repo)).map(|_| ())
}

/// Reject archive entry names that would escape the extraction root: absolute paths, `..`,
/// and anything the zip crate cannot resolve to a contained relative path. An archive is
/// untrusted input — a user can be handed a `.zip` and restore it.
fn safe_entry_path(name: &str) -> Option<PathBuf> {
    if name.starts_with('/') || name.starts_with('\\') {
        return None;
    }
    let candidate = Path::new(name);
    let mut out = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Extract a backup's curated files into `target_alinery_dir`.
///
/// Additive by design: nothing existing is deleted. Clearing the curated set first is the
/// caller's job (the app's restore command), which keeps this API usable for inspection and
/// for non-app callers. When `expected_repo` is given, a `repo_path` mismatch fails *before*
/// anything is written.
pub fn extract_backup_into(zip_path: &Path, target_alinery_dir: &Path, expected_repo: Option<&Path>) -> Result<BackupMeta, String> {
    let meta = read_backup_meta(zip_path)?;
    if let Some(repo) = expected_repo {
        let expected = canonical_string(repo)?;
        if meta.repo_path != expected {
            return Err(format!("backup belongs to {}, not {expected}", meta.repo_path));
        }
    }

    let file = File::open(zip_path).map_err(|e| format!("{}: {e}", zip_path.display()))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("{}: {e}", zip_path.display()))?;
    fs::create_dir_all(target_alinery_dir).map_err(|e| format!("{}: {e}", target_alinery_dir.display()))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let raw = entry.name().to_string();
        if raw == BACKUP_META_NAME {
            continue;
        }
        let rel = safe_entry_path(&raw).ok_or_else(|| format!("unsafe archive entry rejected: {raw}"))?;
        let out_path = target_alinery_dir.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("{}: {e}", out_path.display()))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes).map_err(|e| format!("{raw}: {e}"))?;
        fs::write(&out_path, &bytes).map_err(|e| format!("{}: {e}", out_path.display()))?;
    }
    Ok(meta)
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

    // ---- 2F. read_backup_meta / extract_backup_into ----

    // 2.29 — list reads meta for every archive in the folder; it must not extract them.

    // 2.30 — three flavours of broken input, three clean errors, no panic.

    // 2.31 — the restore payload: every curated file back, bytes intact, dirs recreated.

    // 2.32 — an archive is untrusted input: a user can be handed a zip and restore it.

    // 2.33 — restoring repo A's data over repo B, caught before a single byte is written.

    // 2.34 — non-app callers (inspection, migration) still get a usable API.

    // 2.35 — extract is additive; clearing is the caller's job. Pins the contract boundary
    // that keeps worktrees and live sockets alive through a restore.
}
