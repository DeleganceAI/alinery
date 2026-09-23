//! Same-dir tmp+rename writers. `write_bytes_atomic` uses umask dirs;
//! `write_owner_only_bytes` forces 0700 new dirs and 0600 files on unix.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static ATOMIC_WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn atomic_tmp_path(path: &Path) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let seq = ATOMIC_WRITE_COUNTER.fetch_add(1, Ordering::Relaxed);
    path.with_extension(format!("tmp.{}.{}.{}", std::process::id(), nanos, seq))
}

// Atomic raw-bytes write: same-dir tmp + rename so readers never see a half-written file.
// Used for scrollback sidecars and small text registries where the caller already serialized
// bytes; distinct from write_meta_atomic, which owns JSON pretty-printing.
pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("atomic write path has no parent dir")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = atomic_tmp_path(path);
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Persist a same-directory replacement through file and directory sync. A failure
/// after rename cannot promise rollback: callers must inspect durable state.
pub fn write_bytes_durable(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("durable write path has no parent")?;
    fs::create_dir_all(parent).map_err(|e| format!("create durable parent: {e}"))?;
    let tmp = atomic_tmp_path(path);
    let before_rename = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("create durable temporary file: {e}"))?;
        file.write_all(bytes).map_err(|e| format!("write durable temporary file: {e}"))?;
        file.sync_all().map_err(|e| format!("sync durable temporary file: {e}"))?;
        drop(file);
        fs::rename(&tmp, path).map_err(|e| format!("rename durable file: {e}"))
    })();
    if let Err(error) = before_rename {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    fs::File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| format!("ambiguous persistence after rename of {} (parent sync failed): {e}", path.display()))
}

/// Create `dir` and any missing parent 0700 rather than at the process umask, so a directory
/// that will hold credentials is never world-listable. An existing directory is left as it is.
///
/// Anything that may create such a directory has to call this, not `create_dir_all` — whichever
/// caller gets there first decides the mode, and a 0755 dir created by a lock file defeats a
/// 0700 dir created moments later by the credential write.
#[cfg(unix)]
pub fn create_dir_owner_only(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| format!("create {}: {e}", dir.display()))
}

#[cfg(not(unix))]
pub fn create_dir_owner_only(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))
}

/// Atomic like `write_bytes_atomic`, but a newly created parent is 0700 and the file is 0600
/// before it is renamed into place, so the bytes are never briefly world-readable.
#[cfg(unix)]
pub fn write_owner_only_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let dir = path.parent().ok_or("owner-only write path has no parent dir")?;
    create_dir_owner_only(dir)?;
    let tmp = atomic_tmp_path(path);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| format!("create {}: {e}", tmp.display()))?;
    file.write_all(bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    file.sync_all().map_err(|e| format!("sync {}: {e}", tmp.display()))?;
    drop(file);
    fs::rename(&tmp, path).map_err(|e| format!("rename into {}: {e}", path.display()))
}

#[cfg(not(unix))]
pub fn write_owner_only_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_bytes_atomic(path, bytes)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn write_owner_only_bytes_creates_restricted_dir_and_replaces_file() {
        let root = std::env::temp_dir().join(format!(
            "alinery-fs-atomic-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
        ));
        let path = root.join("nested").join("secret.txt");
        write_owner_only_bytes(&path, b"one").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"one");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);

        write_owner_only_bytes(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = fs::remove_dir_all(&root);
    }

    // The lock file is created before the credential is written, so whoever creates the
    // directory first decides its mode. `create_dir_all` would leave it at the umask (0755
    // for the default 022) and the later 0700 write would find it already there.
    #[test]
    fn create_dir_owner_only_beats_the_umask() {
        let root = std::env::temp_dir().join(format!(
            "alinery-fs-atomic-dir-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
        ));
        let nested = root.join("a").join("b");
        create_dir_owner_only(&nested).unwrap();
        assert_eq!(fs::metadata(&nested).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(root.join("a")).unwrap().permissions().mode() & 0o777, 0o700);
        // Idempotent, and an existing directory keeps whatever mode it already had.
        create_dir_owner_only(&nested).unwrap();
        assert_eq!(fs::metadata(&nested).unwrap().permissions().mode() & 0o777, 0o700);
        let _ = fs::remove_dir_all(&root);
    }
}
