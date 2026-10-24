//! A repository's playbook files as a plain list of (path, bytes), and a checked way to change them.
//!
//! The playbook library, the community import registry and the picker preferences are all ordinary
//! files under `<repo>/.alinery/playbooks/` (and committed ones under `<repo>/alinery/playbooks/`).
//! For a repo on another machine the app copies that tree into a scratch directory, runs the same
//! library code on the copy, and sends back only what changed. `apply_changes` is the receiving
//! half: it refuses to overwrite a file that is no longer what the app started from.

use crate::playbook_library::PlaybookRoots;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Where playbook files live inside a repository, relative to its root.
pub const LIBRARY_DIRS: [&str; 2] = [".alinery/playbooks", "alinery/playbooks"];
/// The library's own lock marker: every side keeps its own, so it is never copied.
const LOCK_MARKER: &str = ".mutation.lock";
const MAX_FILES: usize = 4000;
const MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeFile {
    /// Relative to the repository root, with `/` separators.
    pub path: String,
    #[serde(with = "crate::rpc_chunk::base64_bytes")]
    pub data: Vec<u8>,
    pub modified_ms: Option<u64>,
}

/// One file's change. `expected` is what the sender last saw (`None`: it did not exist); `new` is
/// what it should become (`None`: remove it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeChange {
    pub path: String,
    #[serde(default, with = "optional_bytes")]
    pub expected: Option<Vec<u8>>,
    #[serde(default, with = "optional_bytes")]
    pub new: Option<Vec<u8>>,
}

mod optional_bytes {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(value: &Option<Vec<u8>>, serializer: S) -> Result<S::Ok, S::Error> {
        value.as_ref().map(|bytes| crate::rpc_chunk::encode_base64(bytes)).serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Vec<u8>>, D::Error> {
        Option::<String>::deserialize(deserializer)?
            .map(|text| crate::rpc_chunk::decode_base64(&text).map_err(serde::de::Error::custom))
            .transpose()
    }
}

/// A path that stays inside one of the library directories: relative, no `..`, no lock markers.
fn checked_relative(path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(path);
    let inside = LIBRARY_DIRS.iter().any(|dir| relative.starts_with(dir) && relative != Path::new(dir));
    let clean = relative.components().all(|component| matches!(component, Component::Normal(_)));
    let marker = relative.file_name().is_some_and(|name| name == LOCK_MARKER);
    if !inside || !clean || marker {
        return Err(format!("not a playbook library path: {path}"));
    }
    Ok(relative.to_path_buf())
}

pub fn read_tree(repo: &Path) -> Result<Vec<TreeFile>, String> {
    let mut files = Vec::new();
    let mut bytes = 0u64;
    for dir in LIBRARY_DIRS {
        let root = repo.join(dir);
        match fs::symlink_metadata(&root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("read {}: {error}", root.display())),
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => continue,
            Ok(_) => {}
        }
        let mut pending = vec![root];
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(&directory).map_err(|error| format!("read {}: {error}", directory.display()))? {
                let entry = entry.map_err(|error| format!("read {}: {error}", directory.display()))?;
                let file_type = entry.file_type().map_err(|error| error.to_string())?;
                // A link could point anywhere on the host: leave it out, as the library does.
                if file_type.is_symlink() {
                    continue;
                }
                if file_type.is_dir() {
                    pending.push(entry.path());
                    continue;
                }
                if !file_type.is_file() || entry.file_name() == LOCK_MARKER {
                    continue;
                }
                let path = entry.path();
                let metadata = entry.metadata().map_err(|error| error.to_string())?;
                bytes += metadata.len();
                if files.len() >= MAX_FILES || bytes > MAX_BYTES {
                    return Err("the playbook library is too large to copy".into());
                }
                let relative = path.strip_prefix(repo).map_err(|error| error.to_string())?;
                files.push(TreeFile {
                    path: relative.components().map(|part| part.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"),
                    data: fs::read(&path).map_err(|error| format!("read {}: {error}", path.display()))?,
                    modified_ms: metadata
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .and_then(|age| u64::try_from(age.as_millis()).ok()),
                });
            }
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

/// Write `files` under `repo`, keeping their modification times (the catalog shows them).
pub fn write_tree(repo: &Path, files: &[TreeFile]) -> Result<(), String> {
    for file in files {
        let path = repo.join(checked_relative(&file.path)?);
        fs::create_dir_all(path.parent().ok_or("playbook path has no parent")?).map_err(|error| error.to_string())?;
        fs::write(&path, &file.data).map_err(|error| format!("write {}: {error}", path.display()))?;
        if let Some(ms) = file.modified_ms {
            let time = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms);
            let _ = fs::File::options().write(true).open(&path).and_then(|handle| handle.set_modified(time));
        }
    }
    Ok(())
}

/// The changes that turn `before` into what is now under `repo`.
pub fn changes_since(repo: &Path, before: &[TreeFile]) -> Result<Vec<TreeChange>, String> {
    let now = read_tree(repo)?;
    let mut changes = Vec::new();
    for file in &now {
        let previous = before.iter().find(|old| old.path == file.path);
        if previous.map(|old| &old.data) != Some(&file.data) {
            changes.push(TreeChange {
                path: file.path.clone(),
                expected: previous.map(|old| old.data.clone()),
                new: Some(file.data.clone()),
            });
        }
    }
    for old in before {
        if !now.iter().any(|file| file.path == old.path) {
            changes.push(TreeChange {
                path: old.path.clone(),
                expected: Some(old.data.clone()),
                new: None,
            });
        }
    }
    Ok(changes)
}

/// Apply `changes` to `repo` under the library's own lock, but only if every file still holds what
/// the sender started from. Nothing is written when any file differs.
pub fn apply_changes(repo: &Path, changes: &[TreeChange]) -> Result<(), String> {
    let paths: Vec<PathBuf> = changes.iter().map(|change| checked_relative(&change.path)).collect::<Result<_, _>>()?;
    let roots = PlaybookRoots {
        global_config_dir: PathBuf::new(),
        repo_dir: repo.to_path_buf(),
    };
    crate::playbook_library::with_repo_library_lock(&roots, || {
        for (change, relative) in changes.iter().zip(&paths) {
            let current = match fs::read(repo.join(relative)) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(crate::playbook_library::PlaybookSaveError::Io { message: error.to_string() }),
            };
            if current != change.expected {
                return Err(crate::playbook_library::PlaybookSaveError::Io {
                    message: format!("{} changed on the host while it was being edited; try again", change.path),
                });
            }
        }
        for (change, relative) in changes.iter().zip(&paths) {
            let path = repo.join(relative);
            let io = |error: std::io::Error| crate::playbook_library::PlaybookSaveError::Io {
                message: format!("{}: {error}", path.display()),
            };
            match &change.new {
                Some(bytes) => {
                    fs::create_dir_all(path.parent().expect("checked path has a parent")).map_err(io)?;
                    crate::write_bytes_atomic(&path, bytes).map_err(|message| crate::playbook_library::PlaybookSaveError::Io { message })?;
                }
                None => {
                    fs::remove_file(&path).map_err(io)?;
                    // Only empty directories go, as the library's own delete does.
                    let mut parent = path.parent();
                    while let Some(directory) = parent {
                        if LIBRARY_DIRS.iter().any(|dir| directory == repo.join(dir)) || fs::remove_dir(directory).is_err() {
                            break;
                        }
                        parent = directory.parent();
                    }
                }
            }
        }
        Ok(())
    })
    .map_err(|error| match error {
        crate::playbook_library::PlaybookSaveError::Io { message } => message,
        other => format!("{other:?}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("alinery-tree-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn put(repo: &Path, relative: &str, text: &str) {
        let path = repo.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn tree_round_trips_and_changes_apply_only_to_an_unchanged_host() {
        let host = temp("host");
        put(&host, ".alinery/playbooks/a/playbook.md", "A");
        put(&host, ".alinery/playbooks/picker.toml", "p");
        put(&host, "alinery/playbooks/committed.md", "C");
        put(&host, "src/main.rs", "not the library");
        put(&host, ".alinery/playbooks/.mutation.lock", "");

        let before = read_tree(&host).unwrap();
        assert_eq!(
            before.iter().map(|file| file.path.as_str()).collect::<Vec<_>>(),
            [".alinery/playbooks/a/playbook.md", ".alinery/playbooks/picker.toml", "alinery/playbooks/committed.md"]
        );

        let stage = temp("stage");
        write_tree(&stage, &before).unwrap();
        assert_eq!(read_tree(&stage).unwrap(), before, "bytes and modification times survive the copy");
        put(&stage, ".alinery/playbooks/a/playbook.md", "A2");
        put(&stage, ".alinery/playbooks/b/playbook.md", "B");
        fs::remove_file(stage.join(".alinery/playbooks/picker.toml")).unwrap();

        let changes = changes_since(&stage, &before).unwrap();
        assert_eq!(changes.len(), 3);

        // The host moved on in the meantime: nothing is written.
        put(&host, ".alinery/playbooks/a/playbook.md", "edited elsewhere");
        let refused = apply_changes(&host, &changes).unwrap_err();
        assert!(refused.contains("changed on the host"), "{refused}");
        assert!(!host.join(".alinery/playbooks/b/playbook.md").exists());
        assert!(host.join(".alinery/playbooks/picker.toml").exists());

        put(&host, ".alinery/playbooks/a/playbook.md", "A");
        apply_changes(&host, &changes).unwrap();
        assert_eq!(fs::read_to_string(host.join(".alinery/playbooks/a/playbook.md")).unwrap(), "A2");
        assert_eq!(fs::read_to_string(host.join(".alinery/playbooks/b/playbook.md")).unwrap(), "B");
        assert!(!host.join(".alinery/playbooks/picker.toml").exists());

        // A removal also drops the directory it leaves empty, but never the library root.
        let before = read_tree(&host).unwrap();
        fs::remove_file(host.join(".alinery/playbooks/b/playbook.md")).unwrap();
        let removal = changes_since(&host, &before).unwrap();
        fs::write(host.join(".alinery/playbooks/b/playbook.md"), "B").unwrap();
        apply_changes(&host, &removal).unwrap();
        assert!(!host.join(".alinery/playbooks/b").exists());
        assert!(host.join(".alinery/playbooks").is_dir());

        let _ = fs::remove_dir_all(host);
        let _ = fs::remove_dir_all(stage);
    }

    #[test]
    fn paths_outside_the_library_are_refused() {
        let repo = temp("paths");
        for path in [
            "../x",
            "/etc/passwd",
            ".alinery/playbooks/../config.toml",
            "src/main.rs",
            ".alinery/playbooks",
            ".alinery/playbooks/a/.mutation.lock",
        ] {
            let change = TreeChange {
                path: path.into(),
                expected: None,
                new: Some(b"x".to_vec()),
            };
            assert!(apply_changes(&repo, &[change]).is_err(), "{path}");
        }
        let _ = fs::remove_dir_all(repo);
    }
}
