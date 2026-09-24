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
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::paths::alinery_dir;
use crate::types::{BackupDefaults, MAX_BACKUP_RETENTION, MIN_BACKUP_RETENTION};

pub const BACKUP_SCHEMA_VERSION: u32 = 1;

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BackupListItem {
    /// Archive file name. Stable within a destination; the UI passes `path` back for restore.
    pub id: String,
    pub path: String,
    pub created_at: u64,
    pub trigger: String,
    pub size_bytes: u64,
    pub alinery_version: String,
}

fn now_epoch_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Filesystem-safe form of a repo directory name, used for the archive filename and for the
/// cheap prefix filter in `list_backups`. `meta.repo_name` keeps the unsanitized name.
fn sanitize_repo_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim_matches('.');
    if trimmed.is_empty() {
        "repo".to_string()
    } else {
        trimmed.to_string()
    }
}

fn repo_dir_name(repo: &Path) -> String {
    repo.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "repo".to_string())
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

/// The single gate the UI, the auto-trigger queue, and MCP all consult before doing anything.
/// Trigger flags are the caller's business; this answers "is the feature usable at all".
pub fn backup_feature_ready(settings: &BackupDefaults, repo: &Path) -> bool {
    settings.enabled && !settings.destination.is_empty() && validate_backup_destination(repo, Path::new(&settings.destination)).is_ok()
}

fn clamped_retention(settings: &BackupDefaults) -> usize {
    settings.retention.clamp(MIN_BACKUP_RETENTION, MAX_BACKUP_RETENTION) as usize
}

/// Collect regular files under `root`, keyed by their `/`-joined path relative to `.alinery/`.
/// Symlinks are skipped rather than followed: `.alinery/` is alinery-written, and following links
/// would let an archive reach outside the tree it claims to describe.
fn collect_files(root: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = format!("{prefix}/{name}");
        if kind.is_dir() {
            collect_files(&entry.path(), &rel, out);
        } else if kind.is_file() {
            out.push((rel, entry.path()));
        }
    }
}

/// Every curated file present under `.alinery/`, as `(zip entry path, source path)`.
fn curated_files(alinery: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    for name in CURATED_ALINERY_PATHS {
        let path = alinery.join(name);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_dir() => collect_files(&path, name, &mut out),
            Ok(meta) if meta.is_file() => out.push(((*name).to_string(), path)),
            _ => {}
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// First free `{stem}.zip`, `{stem}-2.zip`, `{stem}-3.zip`, … in `dest`.
///
/// Epoch-second filenames collide when two backups land in the same second (a manual BACKUP NOW
/// during an auto burst). Without this the second archive silently replaces the first, and
/// retention then quietly keeps fewer than the configured count.
fn unique_zip_path(dest: &Path, stem: &str) -> PathBuf {
    let first = dest.join(format!("{stem}.zip"));
    if !first.exists() {
        return first;
    }
    for n in 2..1000u32 {
        let candidate = dest.join(format!("{stem}-{n}.zip"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dest.join(format!("{stem}-{}.zip", now_epoch_secs()))
}

/// Create a curated zip of `repo`'s `.alinery/` data in the configured destination, then prune to
/// the retention count. Written to a temp name and renamed, so a crashed run never leaves a
/// half-written archive that `list_backups` would show.
///
/// `alinery_version` is caller-supplied so the app and the MCP server each stamp their own crate
/// version rather than alinery-core's.
pub fn create_backup(repo: &Path, settings: &BackupDefaults, trigger: BackupTrigger, alinery_version: &str) -> Result<BackupMeta, String> {
    if !settings.enabled {
        return Err("backup is disabled for this repository".to_string());
    }
    let dest = validate_backup_destination(repo, Path::new(&settings.destination))?;
    let repo_path = canonical_string(repo)?;
    let repo_name = repo_dir_name(repo);
    let alinery = alinery_dir(repo);
    if !alinery.is_dir() {
        return Err(format!("{} does not exist", alinery.display()));
    }

    let files = curated_files(&alinery);
    let mut included_dirs: Vec<String> = CURATED_ALINERY_PATHS
        .iter()
        .filter(|name| alinery.join(name).exists())
        .map(|name| (*name).to_string())
        .collect();
    included_dirs.sort();

    let meta = BackupMeta {
        repo_name: repo_name.clone(),
        repo_path,
        created_at: now_epoch_secs(),
        schema_version: BACKUP_SCHEMA_VERSION,
        alinery_version: alinery_version.to_string(),
        trigger,
        included_dirs,
    };
    let meta_json = serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?;

    let stem = format!("{}-{}-v{}", sanitize_repo_name(&repo_name), meta.created_at, alinery_version);
    let final_path = unique_zip_path(&dest, &stem);
    let tmp_path = dest.join(format!(
        ".{}.tmp.{}",
        final_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| stem.clone()),
        std::process::id()
    ));

    let write_result = write_archive(&tmp_path, &files, &meta_json);
    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }
    fs::rename(&tmp_path, &final_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("write {}: {e}", final_path.display())
    })?;

    enforce_retention(repo, settings)?;
    Ok(meta)
}

fn write_archive(tmp_path: &Path, files: &[(String, PathBuf)], meta_json: &[u8]) -> Result<(), String> {
    let file = File::create(tmp_path).map_err(|e| format!("{}: {e}", tmp_path.display()))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    zip.start_file(BACKUP_META_NAME, options).map_err(|e| e.to_string())?;
    zip.write_all(meta_json).map_err(|e| e.to_string())?;

    for (entry, source) in files {
        // Read-then-write: a file vanishing mid-backup (session churn) is normal, not fatal.
        let Ok(bytes) = fs::read(source) else {
            continue;
        };
        zip.start_file(entry.as_str(), options).map_err(|e| format!("{entry}: {e}"))?;
        zip.write_all(&bytes).map_err(|e| format!("{entry}: {e}"))?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
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

/// Backups belonging to `repo`, newest first. Unreadable, foreign, and meta-less files in the
/// destination are skipped silently — the destination is a user folder, not ours alone.
pub fn list_backups(repo: &Path, settings: &BackupDefaults) -> Result<Vec<BackupListItem>, String> {
    let dest = validate_backup_destination(repo, Path::new(&settings.destination))?;
    let repo_path = canonical_string(repo)?;
    let prefix = format!("{}-", sanitize_repo_name(&repo_dir_name(repo)));

    let mut items = Vec::new();
    let entries = fs::read_dir(&dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        if !name.starts_with(&prefix) || !name.ends_with(".zip") {
            continue;
        }
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let Ok(meta) = read_backup_meta(&path) else {
            continue;
        };
        if meta.repo_path != repo_path {
            continue;
        }
        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        items.push(BackupListItem {
            id: name,
            path: path.to_string_lossy().to_string(),
            created_at: meta.created_at,
            trigger: meta.trigger.as_str().to_string(),
            size_bytes,
            alinery_version: meta.alinery_version,
        });
    }
    // Same-second archives tie on created_at; the filename suffix (`-2`, `-3`) breaks it.
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    Ok(items)
}

/// Delete the oldest archives for this repo until at most `retention` remain. Only archives
/// whose `meta.repo_path` matches are considered, so a shared destination never loses another
/// repo's backups or the user's own files.
pub fn enforce_retention(repo: &Path, settings: &BackupDefaults) -> Result<(), String> {
    let keep = clamped_retention(settings);
    let items = list_backups(repo, settings)?;
    for item in items.into_iter().skip(keep) {
        fs::remove_file(&item.path).map_err(|e| format!("prune {}: {e}", item.path))?;
    }
    Ok(())
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

    fn ready(dest: &Path) -> BackupDefaults {
        BackupDefaults {
            destination: dest.to_string_lossy().to_string(),
            enabled: true,
            retention: 10,
            ..Default::default()
        }
    }

    fn entry_names(zip_path: &Path) -> Vec<String> {
        let mut archive = ZipArchive::new(File::open(zip_path).unwrap()).unwrap();
        (0..archive.len()).map(|i| archive.by_index(i).unwrap().name().to_string()).collect()
    }

    fn entry_bytes(zip_path: &Path, name: &str) -> Vec<u8> {
        let mut archive = ZipArchive::new(File::open(zip_path).unwrap()).unwrap();
        let mut entry = archive.by_name(name).unwrap();
        let mut out = Vec::new();
        entry.read_to_end(&mut out).unwrap();
        out
    }

    fn zips_in(dest: &Path) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = fs::read_dir(dest)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map(|e| e == "zip").unwrap_or(false))
            .collect();
        out.sort();
        out
    }

    fn only_zip(dest: &Path) -> PathBuf {
        let zips = zips_in(dest);
        assert_eq!(zips.len(), 1, "expected exactly one zip in {dest:?}");
        zips.into_iter().next().unwrap()
    }

    /// Synthetic archive with a chosen `created_at` / `repo_path`, so list and retention
    /// ordering can be tested without sleeping through real seconds.
    fn plant_backup(dest: &Path, repo_name: &str, repo_path: &str, created_at: u64) -> PathBuf {
        let meta = BackupMeta {
            repo_name: repo_name.to_string(),
            repo_path: repo_path.to_string(),
            created_at,
            schema_version: BACKUP_SCHEMA_VERSION,
            alinery_version: "0.0.0".to_string(),
            trigger: BackupTrigger::Manual,
            included_dirs: vec!["tasks".to_string()],
        };
        let path = dest.join(format!("{}-{created_at}-v0.0.0.zip", sanitize_repo_name(repo_name)));
        let mut zip = ZipWriter::new(File::create(&path).unwrap());
        let options = SimpleFileOptions::default();
        zip.start_file(BACKUP_META_NAME, options).unwrap();
        zip.write_all(&serde_json::to_vec(&meta).unwrap()).unwrap();
        zip.start_file("tasks/alpha/task.md", options).unwrap();
        zip.write_all(b"planted").unwrap();
        zip.finish().unwrap();
        path
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
    #[test]
    fn feature_not_ready_when_disabled_or_destination_unset() {
        let (repo, dest) = fixture_repo("bk_ready");
        assert!(backup_feature_ready(&ready(&dest), &repo));

        let mut no_dest = ready(&dest);
        no_dest.destination = String::new();
        assert!(!backup_feature_ready(&no_dest, &repo));

        let mut disabled = ready(&dest);
        disabled.enabled = false;
        assert!(!backup_feature_ready(&disabled, &repo));

        let inside = alinery_dir(&repo).join("backups");
        fs::create_dir_all(&inside).unwrap();
        let mut bad = ready(&dest);
        bad.destination = inside.to_string_lossy().to_string();
        assert!(!backup_feature_ready(&bad, &repo));
        cleanup(&repo);
    }

    // ---- 2C. create_backup ----

    // 2.9 — everything durable makes it in, including root sessions and binary scrollback.
    #[test]
    fn zip_contains_curated_paths() {
        let (repo, dest) = fixture_repo("bk_include");
        create_backup(&repo, &ready(&dest), BackupTrigger::Manual, "9.9.9").unwrap();
        let names = entry_names(&only_zip(&dest));
        for expected in [
            "tasks/alpha/task.md",
            "tasks/alpha/artifacts/00-ticket.md",
            "tasks/alpha/sessions/s1.meta.json",
            "tasks/alpha/sessions/s1.scrollback",
            "sessions/root1.meta.json",
            "config.toml",
            "harnesses.toml",
            "playbooks.toml",
            "playbooks/custom.md",
            BACKUP_META_NAME,
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected} in {names:?}");
        }
        cleanup(&repo);
    }

    // 2.10 — whole-name scan, so a future stray include fails loudly instead of bloating zips.
    #[test]
    fn zip_excludes_worktrees_and_runtime_files() {
        let (repo, dest) = fixture_repo("bk_exclude");
        create_backup(&repo, &ready(&dest), BackupTrigger::Manual, "9.9.9").unwrap();
        for name in entry_names(&only_zip(&dest)) {
            assert!(!name.starts_with("worktrees/"), "worktrees leaked: {name}");
            assert!(!name.ends_with(".sock"), "socket leaked: {name}");
            assert!(!name.ends_with(".lock"), "lock leaked: {name}");
            assert!(!name.ends_with(".status.json"), "status file leaked: {name}");
        }
        cleanup(&repo);
    }

    // 2.11 — scrollback is raw terminal bytes; a text-mode writer would corrupt it.
    #[test]
    fn zip_preserves_file_contents() {
        let (repo, dest) = fixture_repo("bk_bytes");
        create_backup(&repo, &ready(&dest), BackupTrigger::Manual, "9.9.9").unwrap();
        let zip = only_zip(&dest);
        assert_eq!(entry_bytes(&zip, "tasks/alpha/task.md"), b"name = \"alpha\"\n");
        assert_eq!(entry_bytes(&zip, "tasks/alpha/sessions/s1.scrollback"), vec![0u8, 27, 91, 255, 10]);
        cleanup(&repo);
    }

    // 2.12 — the meta is what makes an archive identifiable after the filename is renamed.
    #[test]
    fn meta_fields_are_populated() {
        let (repo, dest) = fixture_repo("bk_meta");
        let meta = create_backup(&repo, &ready(&dest), BackupTrigger::Manual, "9.9.9").unwrap();
        assert_eq!(meta.schema_version, BACKUP_SCHEMA_VERSION);
        assert_eq!(meta.repo_name, "myrepo");
        assert_eq!(meta.repo_path, fs::canonicalize(&repo).unwrap().to_string_lossy());
        assert_eq!(meta.trigger, BackupTrigger::Manual);
        assert_eq!(meta.alinery_version, "9.9.9");
        assert!(!meta.included_dirs.is_empty());
        let now = now_epoch_secs();
        assert!(meta.created_at.abs_diff(now) < 120, "created_at drifted: {meta:?}");
        cleanup(&repo);
    }

    // 2.13 — the name must stay parseable: list's cheap prefix filter depends on it.
    #[test]
    fn filename_matches_repo_epoch_version_pattern() {
        let (repo, dest) = fixture_repo("bk_name");
        let meta = create_backup(&repo, &ready(&dest), BackupTrigger::Manual, "9.9.9").unwrap();
        let name = only_zip(&dest).file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(name, format!("myrepo-{}-v9.9.9.zip", meta.created_at));
        cleanup(&repo);
    }

    // 2.14 — a repo directory name is user input; it must never become a path separator.
    #[test]
    fn repo_name_is_sanitized_for_filesystem() {
        let base = unique_temp("bk_sanitize");
        let repo = base.join("weird name.v2");
        let dest = base.join("dest");
        plant(alinery_dir(&repo).join("config.toml"), b"x\n");
        fs::create_dir_all(&dest).unwrap();
        create_backup(&repo, &ready(&dest), BackupTrigger::Manual, "9.9.9").unwrap();
        let zip = only_zip(&dest);
        let name = zip.file_name().unwrap().to_string_lossy().to_string();
        assert!(!name.contains('/') && !name.contains('\\'), "unsafe name: {name}");
        assert!(name.starts_with("weird_name.v2-"), "unexpected name: {name}");
        assert!(zip.is_file());
        cleanup(&repo);
    }

    // 2.15 — a refused create must leave the destination byte-identical: no partial artifact.
    #[test]
    fn create_fails_when_feature_not_ready() {
        let (repo, dest) = fixture_repo("bk_not_ready");
        let before = fs::read_dir(&dest).unwrap().count();

        let mut disabled = ready(&dest);
        disabled.enabled = false;
        assert!(create_backup(&repo, &disabled, BackupTrigger::Manual, "9.9.9").is_err());

        let mut no_dest = ready(&dest);
        no_dest.destination = String::new();
        assert!(create_backup(&repo, &no_dest, BackupTrigger::Manual, "9.9.9").is_err());

        assert_eq!(fs::read_dir(&dest).unwrap().count(), before);
        cleanup(&repo);
    }

    // 2.16 — a leaked `.tmp` would be counted by list/retention and shown to the user.
    #[test]
    fn create_leaves_no_staging_or_tmp_residue() {
        let (repo, dest) = fixture_repo("bk_residue");
        create_backup(&repo, &ready(&dest), BackupTrigger::Manual, "9.9.9").unwrap();
        let entries: Vec<String> = fs::read_dir(&dest).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(entries.len(), 1, "residue left behind: {entries:?}");
        assert!(entries[0].ends_with(".zip"), "not an archive: {entries:?}");
        cleanup(&repo);
    }

    // 2.17 — epoch-second names collide; silently replacing the first would make "keep 10"
    // quietly keep fewer and hide a backup the user explicitly asked for.
    #[test]
    fn two_creates_in_the_same_second_are_both_retained() {
        let (repo, dest) = fixture_repo("bk_collide");
        let settings = ready(&dest);
        for _ in 0..3 {
            let a = create_backup(&repo, &settings, BackupTrigger::Manual, "9.9.9").unwrap();
            let b = create_backup(&repo, &settings, BackupTrigger::Manual, "9.9.9").unwrap();
            if a.created_at == b.created_at {
                assert_eq!(list_backups(&repo, &settings).unwrap().len(), 2);
                cleanup(&repo);
                return;
            }
            for entry in fs::read_dir(&dest).unwrap().flatten() {
                fs::remove_file(entry.path()).unwrap();
            }
        }
        cleanup(&repo);
        panic!("could not create both backups within one second after three attempts");
    }

    // ---- 2D. list_backups ----

    // 2.18 — the Settings list renders this order verbatim.
    #[test]
    fn list_is_newest_first_with_sizes() {
        let (repo, dest) = fixture_repo("bk_list_order");
        let repo_path = fs::canonicalize(&repo).unwrap().to_string_lossy().to_string();
        for at in [100u64, 300, 200] {
            plant_backup(&dest, "myrepo", &repo_path, at);
        }
        let items = list_backups(&repo, &ready(&dest)).unwrap();
        assert_eq!(items.iter().map(|i| i.created_at).collect::<Vec<_>>(), vec![300, 200, 100]);
        for item in &items {
            assert!(item.size_bytes > 0, "empty size: {item:?}");
            assert_eq!(item.trigger, "manual");
            assert_eq!(item.alinery_version, "0.0.0");
        }
        cleanup(&repo);
    }

    // 2.19 — collision safety: two repos may share a basename and a destination folder.
    #[test]
    fn list_filters_by_meta_repo_path_not_filename() {
        let (repo, dest) = fixture_repo("bk_list_identity");
        let other = repo.parent().unwrap().join("elsewhere").join("myrepo");
        fs::create_dir_all(&other).unwrap();
        let mine = fs::canonicalize(&repo).unwrap().to_string_lossy().to_string();
        let theirs = fs::canonicalize(&other).unwrap().to_string_lossy().to_string();
        plant_backup(&dest, "myrepo", &mine, 100);
        plant_backup(&dest, "myrepo", &theirs, 200);
        let items = list_backups(&repo, &ready(&dest)).unwrap();
        assert_eq!(items.len(), 1, "filename prefix alone would return both: {items:?}");
        assert_eq!(items[0].created_at, 100);
        cleanup(&repo);
    }

    // 2.20 — the destination is a user folder; junk in it must not break the list.
    #[test]
    fn list_skips_unreadable_and_metaless_zips() {
        let (repo, dest) = fixture_repo("bk_list_junk");
        let repo_path = fs::canonicalize(&repo).unwrap().to_string_lossy().to_string();
        plant_backup(&dest, "myrepo", &repo_path, 500);
        fs::write(dest.join("notes.txt"), b"hello").unwrap();
        fs::write(dest.join("myrepo-1-v1.zip"), b"not really a zip").unwrap();
        let bare = dest.join("myrepo-2-v1.zip");
        let mut zip = ZipWriter::new(File::create(&bare).unwrap());
        zip.start_file("tasks/x.md", SimpleFileOptions::default()).unwrap();
        zip.write_all(b"x").unwrap();
        zip.finish().unwrap();

        let items = list_backups(&repo, &ready(&dest)).unwrap();
        assert_eq!(items.len(), 1, "junk was not skipped: {items:?}");
        assert_eq!(items[0].created_at, 500);
        cleanup(&repo);
    }

    // 2.21 — "no backups yet" is a normal state, not an error banner.
    #[test]
    fn list_on_empty_valid_destination_is_ok_empty() {
        let (repo, dest) = fixture_repo("bk_list_empty");
        assert_eq!(list_backups(&repo, &ready(&dest)).unwrap(), vec![]);
        cleanup(&repo);
    }

    // 2.22 — an unusable destination is an error the user needs to see.
    #[test]
    fn list_on_invalid_destination_errors() {
        let (repo, dest) = fixture_repo("bk_list_bad_dest");
        let mut unset = ready(&dest);
        unset.destination = String::new();
        assert!(list_backups(&repo, &unset).is_err());

        let inside = alinery_dir(&repo).join("backups");
        fs::create_dir_all(&inside).unwrap();
        let mut inner = ready(&dest);
        inner.destination = inside.to_string_lossy().to_string();
        assert!(list_backups(&repo, &inner).is_err());
        cleanup(&repo);
    }

    // ---- 2E. enforce_retention ----

    // 2.23 — the off-by-one: at exactly N, nothing is deleted.
    #[test]
    fn retention_boundary_keeps_exactly_n() {
        let (repo, dest) = fixture_repo("bk_ret_boundary");
        let repo_path = fs::canonicalize(&repo).unwrap().to_string_lossy().to_string();
        for at in 1..=5u64 {
            plant_backup(&dest, "myrepo", &repo_path, at);
        }
        let mut settings = ready(&dest);
        settings.retention = 5;
        enforce_retention(&repo, &settings).unwrap();
        assert_eq!(zips_in(&dest).len(), 5);
        cleanup(&repo);
    }

    // 2.24 — oldest first, and the surviving order is still newest-first.
    #[test]
    fn retention_deletes_oldest_first() {
        let (repo, dest) = fixture_repo("bk_ret_oldest");
        let repo_path = fs::canonicalize(&repo).unwrap().to_string_lossy().to_string();
        let oldest = plant_backup(&dest, "myrepo", &repo_path, 1);
        for at in 2..=6u64 {
            plant_backup(&dest, "myrepo", &repo_path, at);
        }
        let mut settings = ready(&dest);
        settings.retention = 5;
        enforce_retention(&repo, &settings).unwrap();
        assert!(!oldest.exists(), "oldest archive survived");
        let items = list_backups(&repo, &settings).unwrap();
        assert_eq!(items.iter().map(|i| i.created_at).collect::<Vec<_>>(), vec![6, 5, 4, 3, 2]);
        cleanup(&repo);
    }

    // 2.25 — retention 1 is a legal setting, not a wipe.
    #[test]
    fn retention_of_one_keeps_only_newest() {
        let (repo, dest) = fixture_repo("bk_ret_one");
        let repo_path = fs::canonicalize(&repo).unwrap().to_string_lossy().to_string();
        for at in 1..=4u64 {
            plant_backup(&dest, "myrepo", &repo_path, at);
        }
        let mut settings = ready(&dest);
        settings.retention = 1;
        enforce_retention(&repo, &settings).unwrap();
        let items = list_backups(&repo, &settings).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].created_at, 4);
        cleanup(&repo);
    }

    // 2.26 — a shared destination must never cost another repo its history.
    #[test]
    fn retention_never_touches_another_repos_backups() {
        let (repo, dest) = fixture_repo("bk_ret_other_repo");
        let other = repo.parent().unwrap().join("elsewhere").join("myrepo");
        fs::create_dir_all(&other).unwrap();
        let mine = fs::canonicalize(&repo).unwrap().to_string_lossy().to_string();
        let theirs = fs::canonicalize(&other).unwrap().to_string_lossy().to_string();
        for at in 1..=6u64 {
            plant_backup(&dest, "myrepo", &mine, at);
        }
        let mut theirs_paths = Vec::new();
        for at in 101..=103u64 {
            theirs_paths.push(plant_backup(&dest, "myrepo", &theirs, at));
        }
        let mut settings = ready(&dest);
        settings.retention = 2;
        enforce_retention(&repo, &settings).unwrap();
        assert_eq!(list_backups(&repo, &settings).unwrap().len(), 2);
        for p in theirs_paths {
            assert!(p.exists(), "other repo's backup deleted: {p:?}");
        }
        cleanup(&repo);
    }

    // 2.27 — deleting a user's unrelated files from their own folder is the worst outcome here.
    #[test]
    fn retention_ignores_foreign_and_corrupt_files() {
        let (repo, dest) = fixture_repo("bk_ret_foreign");
        let repo_path = fs::canonicalize(&repo).unwrap().to_string_lossy().to_string();
        for at in 1..=3u64 {
            plant_backup(&dest, "myrepo", &repo_path, at);
        }
        let notes = dest.join("notes.txt");
        let corrupt = dest.join("myrepo-9-v1.zip");
        fs::write(&notes, b"keep me").unwrap();
        fs::write(&corrupt, b"garbage").unwrap();
        let mut settings = ready(&dest);
        settings.retention = 1;
        enforce_retention(&repo, &settings).unwrap();
        assert!(notes.exists(), "unrelated user file deleted");
        assert!(corrupt.exists(), "unreadable file deleted");
        cleanup(&repo);
    }

    // 2.28 — 0 must not mean "delete everything"; 200 must not mean "unbounded".
    #[test]
    fn retention_clamps_zero_and_over_hundred() {
        let (repo, dest) = fixture_repo("bk_ret_clamp");
        let repo_path = fs::canonicalize(&repo).unwrap().to_string_lossy().to_string();
        for at in 1..=3u64 {
            plant_backup(&dest, "myrepo", &repo_path, at);
        }
        let mut zero = ready(&dest);
        zero.retention = 0;
        enforce_retention(&repo, &zero).unwrap();
        assert_eq!(zips_in(&dest).len(), 1, "retention 0 must behave as 1");

        let (repo2, dest2) = fixture_repo("bk_ret_clamp_hi");
        let repo2_path = fs::canonicalize(&repo2).unwrap().to_string_lossy().to_string();
        for at in 1..=3u64 {
            plant_backup(&dest2, "myrepo", &repo2_path, at);
        }
        let mut huge = ready(&dest2);
        huge.retention = 200;
        enforce_retention(&repo2, &huge).unwrap();
        assert_eq!(zips_in(&dest2).len(), 3, "retention 200 must delete nothing");
        cleanup(&repo);
        cleanup(&repo2);
    }

    // ---- 2F. read_backup_meta / extract_backup_into ----

    // 2.29 — list reads meta for every archive in the folder; it must not extract them.
    #[test]
    fn read_meta_without_full_extract() {
        let (repo, dest) = fixture_repo("bk_read_meta");
        let created = create_backup(&repo, &ready(&dest), BackupTrigger::Mcp, "1.2.3").unwrap();
        let zip = only_zip(&dest);
        assert_eq!(read_backup_meta(&zip).unwrap(), created);
        assert_eq!(zips_in(&dest).len(), 1);
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 1, "read wrote something");
        cleanup(&repo);
    }

    // 2.30 — three flavours of broken input, three clean errors, no panic.
    #[test]
    fn read_meta_on_missing_or_corrupt_zip_errors() {
        let (repo, dest) = fixture_repo("bk_read_meta_bad");
        assert!(read_backup_meta(&dest.join("nope.zip")).is_err());

        let text = dest.join("text.zip");
        fs::write(&text, b"i am not a zip").unwrap();
        assert!(read_backup_meta(&text).is_err());

        let bare = dest.join("bare.zip");
        let mut zip = ZipWriter::new(File::create(&bare).unwrap());
        zip.start_file("tasks/x.md", SimpleFileOptions::default()).unwrap();
        zip.write_all(b"x").unwrap();
        zip.finish().unwrap();
        assert!(read_backup_meta(&bare).is_err());
        cleanup(&repo);
    }

    // 2.31 — the restore payload: every curated file back, bytes intact, dirs recreated.
    #[test]
    fn extract_restores_curated_tree_into_empty_target() {
        let (repo, dest) = fixture_repo("bk_extract");
        let session_name = br#"{"name":"Repair cache eviction","source":"user"}"#;
        plant(alinery_dir(&repo).join("tasks/alpha/sessions/s1.name.json"), session_name);
        create_backup(&repo, &ready(&dest), BackupTrigger::Manual, "9.9.9").unwrap();
        let target = repo.parent().unwrap().join("restored").join(".alinery");
        extract_backup_into(&only_zip(&dest), &target, Some(&repo)).unwrap();
        assert_eq!(fs::read(target.join("tasks/alpha/task.md")).unwrap(), b"name = \"alpha\"\n");
        assert_eq!(fs::read(target.join("tasks/alpha/sessions/s1.scrollback")).unwrap(), vec![0u8, 27, 91, 255, 10]);
        assert_eq!(fs::read(target.join("tasks/alpha/sessions/s1.name.json")).unwrap(), session_name);
        assert!(target.join("sessions/root1.meta.json").is_file());
        assert!(target.join("config.toml").is_file());
        assert!(target.join("harnesses.toml").is_file());
        assert!(target.join("playbooks.toml").is_file());
        assert!(target.join("playbooks/custom.md").is_file());
        cleanup(&repo);
    }

    #[test]
    fn restored_session_name_is_readable_through_core_authority() {
        let (repo, dest) = fixture_repo("bk_name_read");
        let task = crate::Task {
            slug: "named".into(),
            name: "Named task".into(),
            ..Default::default()
        };
        crate::write_task(&repo, &task).unwrap();
        let meta = crate::SessionMeta {
            id: "s1".into(),
            ..Default::default()
        };
        plant(crate::session_meta_path(&repo, "named", "s1"), &serde_json::to_vec(&meta).unwrap());
        crate::set_session_name(&repo, "named", "s1", "Repair cache", crate::SessionNameSource::User).unwrap();
        create_backup(&repo, &ready(&dest), BackupTrigger::Manual, "9.9.9").unwrap();
        let restored = repo.parent().unwrap().join("restored");
        extract_backup_into(&only_zip(&dest), &alinery_dir(&restored), Some(&repo)).unwrap();
        assert_eq!(crate::read_session_name(&restored, "named", "s1").unwrap().unwrap().name, "Repair cache");
        cleanup(&repo);
    }

    // 2.32 — an archive is untrusted input: a user can be handed a zip and restore it.
    #[test]
    fn extract_rejects_zip_slip_entries() {
        let (repo, dest) = fixture_repo("bk_zipslip");
        let repo_path = fs::canonicalize(&repo).unwrap().to_string_lossy().to_string();
        let meta = BackupMeta {
            repo_name: "myrepo".into(),
            repo_path,
            created_at: 1,
            schema_version: BACKUP_SCHEMA_VERSION,
            alinery_version: "0.0.0".into(),
            trigger: BackupTrigger::Manual,
            included_dirs: vec![],
        };
        let evil = dest.join("evil.zip");
        let mut zip = ZipWriter::new(File::create(&evil).unwrap());
        let options = SimpleFileOptions::default();
        zip.start_file(BACKUP_META_NAME, options).unwrap();
        zip.write_all(&serde_json::to_vec(&meta).unwrap()).unwrap();
        zip.start_file("../../evil.txt", options).unwrap();
        zip.write_all(b"pwned").unwrap();
        zip.start_file("/etc/evil.txt", options).unwrap();
        zip.write_all(b"pwned").unwrap();
        zip.finish().unwrap();

        let holder = repo.parent().unwrap().join("restored");
        let target = holder.join(".alinery");
        assert!(extract_backup_into(&evil, &target, Some(&repo)).is_err());
        assert!(!holder.join("evil.txt").exists());
        assert!(!repo.parent().unwrap().join("evil.txt").exists());
        cleanup(&repo);
    }

    // 2.33 — restoring repo A's data over repo B, caught before a single byte is written.
    #[test]
    fn extract_rejects_repo_path_mismatch() {
        let (repo, dest) = fixture_repo("bk_extract_mismatch");
        create_backup(&repo, &ready(&dest), BackupTrigger::Manual, "9.9.9").unwrap();
        let other = repo.parent().unwrap().join("other");
        fs::create_dir_all(&other).unwrap();
        let target = repo.parent().unwrap().join("restored").join(".alinery");
        fs::create_dir_all(&target).unwrap();
        assert!(extract_backup_into(&only_zip(&dest), &target, Some(&other)).is_err());
        assert_eq!(fs::read_dir(&target).unwrap().count(), 0, "target was touched");
        cleanup(&repo);
    }

    // 2.34 — non-app callers (inspection, migration) still get a usable API.
    #[test]
    fn extract_with_expected_repo_none_succeeds() {
        let (repo, dest) = fixture_repo("bk_extract_none");
        create_backup(&repo, &ready(&dest), BackupTrigger::Manual, "9.9.9").unwrap();
        let target = repo.parent().unwrap().join("restored").join(".alinery");
        let meta = extract_backup_into(&only_zip(&dest), &target, None).unwrap();
        assert_eq!(meta.repo_name, "myrepo");
        assert!(target.join("config.toml").is_file());
        cleanup(&repo);
    }

    // 2.35 — extract is additive; clearing is the caller's job. Pins the contract boundary
    // that keeps worktrees and live sockets alive through a restore.
    #[test]
    fn extract_does_not_delete_preexisting_target_files() {
        let (repo, dest) = fixture_repo("bk_extract_additive");
        create_backup(&repo, &ready(&dest), BackupTrigger::Manual, "9.9.9").unwrap();
        let target = repo.parent().unwrap().join("restored").join(".alinery");
        plant(target.join("worktrees/x/keep.txt"), b"uncommitted work");
        plant(target.join("alineryd.sock"), b"");
        extract_backup_into(&only_zip(&dest), &target, Some(&repo)).unwrap();
        assert!(target.join("worktrees/x/keep.txt").is_file());
        assert!(target.join("alineryd.sock").exists());
        assert!(target.join("config.toml").is_file());
        cleanup(&repo);
    }
}
