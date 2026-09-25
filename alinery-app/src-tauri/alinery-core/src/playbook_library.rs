//! Scope-qualified v2 library. Files are the definition registry; picker data
//! is presentation metadata scoped to a repository (or global without one), never definition lookup.
use crate::fs_atomic::write_bytes_atomic;
use crate::lockfile::lock_exclusive_blocking;
use crate::playbook::{parse_playbook_md, render_playbook_md, valid_playbook_key, NormalizedPlaybook, PlaybookRef, PlaybookScope, PlaybookValidationError};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

pub const BUNDLED_PLAYBOOKS: &[(&str, &str)] = &[
    ("superdevelop", include_str!("../../playbooks/superdevelop/playbook.md")),
    ("one-shot", include_str!("../../playbooks/one-shot/playbook.md")),
    ("review", include_str!("../../playbooks/review/playbook.md")),
    ("bug-hunting", include_str!("../../playbooks/bug-hunting/playbook.md")),
    ("free-form", include_str!("../../playbooks/free-form/playbook.md")),
    ("generic-session", include_str!("../../playbooks/generic-session/playbook.md")),
    ("natural-planning-brainstorm", include_str!("../../playbooks/natural-planning-brainstorm/playbook.md")),
    ("systematic-naming", include_str!("../../playbooks/systematic-naming/playbook.md")),
    ("parallel-numbers", include_str!("../../playbooks/parallel-numbers/playbook.md")),
    ("parallel-squares", include_str!("../../playbooks/parallel-squares/playbook.md")),
    ("primed-feature-development", include_str!("../../playbooks/primed-feature-development/playbook.md")),
    ("systematic-evidence-review", include_str!("../../playbooks/systematic-evidence-review/playbook.md")),
    ("academic-survey", include_str!("../../playbooks/academic-survey/playbook.md")),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlaybookRoots {
    /// Stable app config directory, NOT the parent of a dev-instance app.toml.
    pub global_config_dir: PathBuf,
    /// Empty only for global library management without an active repository.
    pub repo_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaybookSource {
    pub reference: PlaybookRef,
    pub path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopedPlaybook {
    pub source: PlaybookSource,
    pub definition: NormalizedPlaybook,
    pub source_text: String,
    /// Actual filesystem modification time; bundled timestamps are unavailable.
    pub modified_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybookCandidate {
    pub source: PlaybookSource,
    pub title: Option<String>,
    pub description: Option<String>,
    pub modified_at_ms: Option<u64>,
    pub diagnostics: Vec<PlaybookValidationError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybookCatalog {
    pub candidates: Vec<PlaybookCandidate>,
    pub picker_preferences: PickerPreferences,
    /// Root enumeration and preference errors cannot be assigned to a candidate.
    pub diagnostics: Vec<PlaybookValidationError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlaybookLoadError {
    Unknown {
        source: PlaybookSource,
    },
    Invalid {
        source: PlaybookSource,
        diagnostics: Vec<PlaybookValidationError>,
    },
    Io {
        source: PlaybookSource,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlaybookSaveError {
    ReadOnly { reference: PlaybookRef },
    Invalid { diagnostics: Vec<PlaybookValidationError> },
    Conflict { source: PlaybookSource },
    Unknown { source: PlaybookSource },
    Io { message: String },
}

impl std::fmt::Display for PlaybookLoadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unknown { source } => write!(formatter, "unknown playbook {:?}/{}", source.reference.scope, source.reference.key),
            Self::Io { source, message } => write!(formatter, "playbook {:?}/{}: {message}", source.reference.scope, source.reference.key),
            Self::Invalid { source, diagnostics } => {
                write!(formatter, "invalid playbook {:?}/{}", source.reference.scope, source.reference.key)?;
                for diagnostic in diagnostics {
                    write!(formatter, "; {}: {}", diagnostic.code, diagnostic.message)?;
                }
                Ok(())
            }
        }
    }
}
impl std::error::Error for PlaybookLoadError {}

impl std::fmt::Display for PlaybookSaveError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ReadOnly { reference } => write!(formatter, "bundled playbook {} is read-only; save a global or repo copy", reference.key),
            Self::Conflict { source } => write!(
                formatter,
                "playbook {:?}/{} already exists; explicit overwrite is required",
                source.reference.scope, source.reference.key
            ),
            Self::Unknown { source } => write!(formatter, "unknown playbook {:?}/{}", source.reference.scope, source.reference.key),
            Self::Io { message } => formatter.write_str(message),
            Self::Invalid { diagnostics } => {
                formatter.write_str("invalid playbook")?;
                for diagnostic in diagnostics {
                    write!(formatter, "; {}: {}", diagnostic.code, diagnostic.message)?;
                }
                Ok(())
            }
        }
    }
}
impl std::error::Error for PlaybookSaveError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavePlaybookRequest {
    pub target: PlaybookRef,
    pub source: String,
    pub overwrite: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PickerPreferences {
    #[serde(default)]
    pub order: Vec<PlaybookRef>,
    #[serde(default)]
    pub entries: Vec<PickerPreference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PickerPreference {
    pub reference: PlaybookRef,
    #[serde(default)]
    pub preferred: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub collapsed: bool,
    pub badge: Option<String>,
    pub color: Option<String>,
    pub last_imported_at_ms: Option<u64>,
}

fn io_save(error: impl ToString) -> PlaybookSaveError {
    PlaybookSaveError::Io { message: error.to_string() }
}

fn root(roots: &PlaybookRoots, scope: PlaybookScope) -> Option<PathBuf> {
    match scope {
        PlaybookScope::Bundled => None,
        PlaybookScope::Global => Some(roots.global_config_dir.join("playbooks")),
        PlaybookScope::Repo if roots.repo_dir.as_os_str().is_empty() => None,
        PlaybookScope::Repo => Some(roots.repo_dir.join(".alinery/playbooks")),
    }
}

fn source_for(roots: &PlaybookRoots, reference: &PlaybookRef) -> PlaybookSource {
    PlaybookSource {
        reference: reference.clone(),
        path: root(roots, reference.scope).map(|root| root.join(&reference.key).join("playbook.md")),
    }
}

fn modification_time(path: &Path) -> Option<u64> {
    fs::metadata(path).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis().try_into().ok()
}

fn invalid_key(key: &str) -> PlaybookValidationError {
    PlaybookValidationError::new("invalid_key", format!("unsafe playbook key {key:?}"), None, Some("key".into()))
}

pub fn validate_playbook_for_storage(path_key: &str, source: &str) -> Result<NormalizedPlaybook, Vec<PlaybookValidationError>> {
    let mut definition = parse_playbook_md(source);
    if !valid_playbook_key(path_key) {
        match &mut definition {
            Ok(_) => return Err(vec![invalid_key(path_key)]),
            Err(errors) => errors.push(invalid_key(path_key)),
        }
    }
    let definition = definition?;
    if definition.key != path_key {
        return Err(vec![PlaybookValidationError::new(
            "storage_key_mismatch",
            format!("directory key {path_key:?} does not match declared key {:?}", definition.key),
            None,
            Some("key".into()),
        )]);
    }
    Ok(definition)
}

// The explicit root is trusted. All library-owned components beneath it must
// be real directories/files, never links into another scope or arbitrary data.
fn checked_directory(path: &Path, create: bool) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(format!("{} is not a regular directory", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => match fs::create_dir(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => checked_directory(path, false),
            Err(error) => Err(format!("create {}: {error}", path.display())),
        },
        Err(error) => Err(format!("read {}: {error}", path.display())),
    }
}

fn checked_root(roots: &PlaybookRoots, scope: PlaybookScope, create: bool) -> Result<PathBuf, String> {
    if scope == PlaybookScope::Repo && roots.repo_dir.as_os_str().is_empty() {
        return Err("repo-scoped playbooks require an active repository".into());
    }
    let base = match scope {
        PlaybookScope::Global => &roots.global_config_dir,
        PlaybookScope::Repo => &roots.repo_dir,
        PlaybookScope::Bundled => return Err("bundled library is read-only".into()),
    };
    if create {
        fs::create_dir_all(base).map_err(|error| format!("create {}: {error}", base.display()))?;
    }
    let mut path = base.clone();
    if scope == PlaybookScope::Repo {
        path.push(".alinery");
        checked_directory(&path, create)?;
    }
    path.push("playbooks");
    checked_directory(&path, create)?;
    Ok(path)
}

fn check_leaf(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(format!("{} is not a regular file", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("read {}: {error}", path.display())),
    }
}

// Bundled bytes are compiled in. Global tombstones keep deletions effective
// across repositories and upgrades without changing task-owned definitions.
fn bundled_deleted(roots: &PlaybookRoots, key: &str) -> Result<bool, String> {
    let path = root(roots, PlaybookScope::Global).expect("global root");
    if fs::symlink_metadata(&path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) {
        return Ok(false);
    }
    checked_root(roots, PlaybookScope::Global, false)?;
    check_leaf(&path.join(format!(".deleted-bundled-{key}")))
}

pub fn resolve_playbook(roots: &PlaybookRoots, reference: &PlaybookRef) -> Result<ScopedPlaybook, PlaybookLoadError> {
    let source = source_for(roots, reference);
    if !valid_playbook_key(&reference.key) {
        return Err(PlaybookLoadError::Invalid {
            source,
            diagnostics: vec![invalid_key(&reference.key)],
        });
    }
    if reference.scope == PlaybookScope::Repo && roots.repo_dir.as_os_str().is_empty() {
        return Err(PlaybookLoadError::Io {
            source,
            message: "repo-scoped playbooks require an active repository".into(),
        });
    }
    let (source_text, modified_at_ms) = if reference.scope == PlaybookScope::Bundled {
        let Some((_, text)) = BUNDLED_PLAYBOOKS.iter().find(|(key, _)| *key == reference.key) else {
            return Err(PlaybookLoadError::Unknown { source });
        };
        if bundled_deleted(roots, &reference.key).map_err(|message| PlaybookLoadError::Io { source: source.clone(), message })? {
            return Err(PlaybookLoadError::Unknown { source });
        }
        ((*text).to_owned(), None)
    } else {
        let path = source.path.as_ref().expect("writable scope has a path");
        let read = || -> Result<Option<String>, String> {
            // Check parents before probing the leaf; never traverse a scope link.
            let expected_root = root(roots, reference.scope).expect("writable root");
            if fs::symlink_metadata(&expected_root).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) {
                return Ok(None);
            }
            checked_root(roots, reference.scope, false)?;
            let directory = path.parent().expect("canonical path has parent");
            if fs::symlink_metadata(directory).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) {
                return Ok(None);
            }
            checked_directory(directory, false)?;
            if !check_leaf(path)? {
                return Ok(None);
            }
            fs::read_to_string(path).map(Some).map_err(|error| format!("read {}: {error}", path.display()))
        };
        match read() {
            Ok(Some(text)) => (text, modification_time(path)),
            Ok(None) => return Err(PlaybookLoadError::Unknown { source }),
            Err(message) => return Err(PlaybookLoadError::Io { source, message }),
        }
    };
    let definition = validate_playbook_for_storage(&reference.key, &source_text).map_err(|diagnostics| PlaybookLoadError::Invalid {
        source: source.clone(),
        diagnostics,
    })?;
    Ok(ScopedPlaybook {
        source,
        definition,
        source_text,
        modified_at_ms,
    })
}

pub fn load_playbook_catalog(roots: &PlaybookRoots) -> PlaybookCatalog {
    let mut references: Vec<PlaybookRef> = BUNDLED_PLAYBOOKS
        .iter()
        .map(|(key, _)| PlaybookRef {
            scope: PlaybookScope::Bundled,
            key: (*key).into(),
        })
        .collect();
    let mut diagnostics = Vec::new();
    for scope in [PlaybookScope::Global, PlaybookScope::Repo] {
        let Some(path) = root(roots, scope) else {
            continue;
        };
        if fs::symlink_metadata(&path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) {
            continue;
        }
        let mut scan = || -> Result<(), String> {
            checked_root(roots, scope, false)?;
            for entry in fs::read_dir(&path).map_err(|error| format!("read {}: {error}", path.display()))? {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => {
                        diagnostics.push(PlaybookValidationError::new("library_io", format!("read entry in {}: {error}", path.display()), None, None));
                        continue;
                    }
                };
                let file_type = match entry.file_type() {
                    Ok(file_type) => file_type,
                    Err(error) => {
                        diagnostics.push(PlaybookValidationError::new("library_io", format!("read {}: {error}", entry.path().display()), None, None));
                        continue;
                    }
                };
                // Legacy flat prompts and picker/lock files are not candidates.
                if !file_type.is_dir() && !file_type.is_symlink() {
                    continue;
                }
                let key = match entry.file_name().into_string() {
                    Ok(key) => key,
                    Err(_) => {
                        diagnostics.push(PlaybookValidationError::new(
                            "library_io",
                            format!("non-UTF-8 playbook directory {}", entry.path().display()),
                            None,
                            None,
                        ));
                        continue;
                    }
                };
                if !fs::symlink_metadata(entry.path().join("playbook.md")).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) || file_type.is_symlink() {
                    references.push(PlaybookRef { scope, key });
                }
            }
            Ok(())
        };
        if let Err(message) = scan() {
            diagnostics.push(PlaybookValidationError::new("library_io", message, None, None));
        }
    }
    references.sort();
    let candidates = references
        .into_iter()
        .filter_map(|reference| {
            let source = source_for(roots, &reference);
            Some(match resolve_playbook(roots, &reference) {
                Ok(playbook) => PlaybookCandidate {
                    source,
                    title: Some(playbook.definition.title),
                    description: Some(playbook.definition.description),
                    modified_at_ms: playbook.modified_at_ms,
                    diagnostics: Vec::new(),
                },
                Err(PlaybookLoadError::Unknown { .. }) if reference.scope == PlaybookScope::Bundled => return None,
                Err(error) => {
                    let diagnostics = match error {
                        PlaybookLoadError::Invalid { diagnostics, .. } => diagnostics,
                        PlaybookLoadError::Io { message, .. } => vec![PlaybookValidationError::new("library_io", message, None, None)],
                        PlaybookLoadError::Unknown { .. } => vec![PlaybookValidationError::new("unknown_playbook", "playbook disappeared during discovery", None, None)],
                    };
                    let modified_at_ms = source.path.as_deref().and_then(modification_time);
                    PlaybookCandidate {
                        source,
                        title: None,
                        description: None,
                        modified_at_ms,
                        diagnostics,
                    }
                }
            })
        })
        .collect();
    let picker_preferences = match load_picker_preferences(roots) {
        Ok(preferences) => preferences,
        Err(message) => {
            diagnostics.push(PlaybookValidationError::new("picker_preferences", message, None, None));
            PickerPreferences::default()
        }
    };
    PlaybookCatalog {
        candidates,
        picker_preferences,
        diagnostics,
    }
}

// Serialize cooperating threads as well as processes. The filesystem marker is
// permanent: deleting it would let waiters lock different inodes.
static LIBRARY_MUTATION: Mutex<()> = Mutex::new(());
fn with_library_lock<T>(roots: &PlaybookRoots, scope: PlaybookScope, mutate: impl FnOnce(&Path) -> Result<T, PlaybookSaveError>) -> Result<T, PlaybookSaveError> {
    let _thread = LIBRARY_MUTATION.lock().map_err(io_save)?;
    let root = checked_root(roots, scope, true).map_err(io_save)?;
    let lock_path = root.join(".mutation.lock");
    check_leaf(&lock_path).map_err(io_save)?;
    let _process = lock_exclusive_blocking(&lock_path).map_err(io_save)?;
    mutate(&root)
}

pub fn save_playbook(roots: &PlaybookRoots, request: SavePlaybookRequest) -> Result<ScopedPlaybook, PlaybookSaveError> {
    if request.target.scope == PlaybookScope::Bundled {
        return Err(PlaybookSaveError::ReadOnly { reference: request.target });
    }
    let definition = validate_playbook_for_storage(&request.target.key, &request.source).map_err(|diagnostics| PlaybookSaveError::Invalid { diagnostics })?;
    let canonical = render_playbook_md(&definition);
    let source = source_for(roots, &request.target);
    with_library_lock(roots, request.target.scope, |root| {
        let directory = root.join(&request.target.key);
        checked_directory(&directory, true).map_err(io_save)?;
        let path = directory.join("playbook.md");
        let exists = check_leaf(&path).map_err(io_save)?;
        if exists && !request.overwrite {
            return Err(PlaybookSaveError::Conflict { source: source.clone() });
        }
        write_bytes_atomic(&path, canonical.as_bytes()).map_err(io_save)?;
        Ok(ScopedPlaybook {
            source: source.clone(),
            definition,
            source_text: canonical,
            modified_at_ms: modification_time(&path),
        })
    })
}

pub fn delete_playbook(roots: &PlaybookRoots, reference: &PlaybookRef) -> Result<(), PlaybookSaveError> {
    if !valid_playbook_key(&reference.key) {
        return Err(PlaybookSaveError::Invalid {
            diagnostics: vec![invalid_key(&reference.key)],
        });
    }
    let source = source_for(roots, reference);
    if reference.scope == PlaybookScope::Bundled {
        if !BUNDLED_PLAYBOOKS.iter().any(|(key, _)| *key == reference.key) {
            return Err(PlaybookSaveError::Unknown { source });
        }
        return with_library_lock(roots, PlaybookScope::Global, |root| {
            let path = root.join(format!(".deleted-bundled-{}", reference.key));
            check_leaf(&path).map_err(io_save)?;
            write_bytes_atomic(&path, b"").map_err(io_save)
        });
    }
    with_library_lock(roots, reference.scope, |root| {
        let directory = root.join(&reference.key);
        if fs::symlink_metadata(&directory).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) {
            return Err(PlaybookSaveError::Unknown { source: source.clone() });
        }
        checked_directory(&directory, false).map_err(io_save)?;
        let path = directory.join("playbook.md");
        if !check_leaf(&path).map_err(io_save)? {
            return Err(PlaybookSaveError::Unknown { source: source.clone() });
        }
        fs::remove_file(&path).map_err(io_save)?;
        // Only remove an empty directory. Never recursively delete user material.
        match fs::remove_dir(&directory) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => Ok(()),
            Err(error) => Err(io_save(error)),
        }
    })
}

fn validate_preferences(preferences: &PickerPreferences) -> Result<(), String> {
    let mut order = HashSet::new();
    for reference in &preferences.order {
        if !valid_playbook_key(&reference.key) || !order.insert(reference) {
            return Err("picker order contains an invalid or duplicate scoped reference".into());
        }
    }
    let mut entries = HashSet::new();
    for entry in &preferences.entries {
        if !valid_playbook_key(&entry.reference.key) || !entries.insert(&entry.reference) {
            return Err("picker metadata contains an invalid or duplicate scoped reference".into());
        }
        if entry.last_imported_at_ms.is_some() && entry.reference.scope != PlaybookScope::Global {
            return Err("last-imported metadata applies only to global playbooks".into());
        }
    }
    Ok(())
}

fn picker_scope(roots: &PlaybookRoots) -> PlaybookScope {
    if roots.repo_dir.as_os_str().is_empty() {
        PlaybookScope::Global
    } else {
        PlaybookScope::Repo
    }
}

pub fn load_picker_preferences(roots: &PlaybookRoots) -> Result<PickerPreferences, String> {
    let scope = picker_scope(roots);
    if scope == PlaybookScope::Repo {
        let directory = roots.repo_dir.join(".alinery");
        if fs::symlink_metadata(&directory).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) {
            return Ok(PickerPreferences::default());
        }
        checked_directory(&directory, false)?;
    }
    let path = root(roots, scope).expect("picker scope has a root").join("picker.toml");
    if fs::symlink_metadata(path.parent().expect("picker parent")).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) {
        return Ok(PickerPreferences::default());
    }
    checked_root(roots, scope, false)?;
    if !check_leaf(&path)? {
        return Ok(PickerPreferences::default());
    }
    let source = fs::read_to_string(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let preferences: PickerPreferences = toml::from_str(&source).map_err(|error| format!("parse {}: {error}", path.display()))?;
    validate_preferences(&preferences)?;
    Ok(preferences)
}

pub fn save_picker_preferences(roots: &PlaybookRoots, preferences: &PickerPreferences) -> Result<(), PlaybookSaveError> {
    validate_preferences(preferences).map_err(io_save)?;
    let source = toml::to_string(preferences).map_err(io_save)?;
    with_library_lock(roots, picker_scope(roots), |root| {
        let path = root.join("picker.toml");
        check_leaf(&path).map_err(io_save)?;
        write_bytes_atomic(&path, source.as_bytes()).map_err(io_save)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    struct Sandbox {
        path: PathBuf,
        roots: PlaybookRoots,
    }
    impl Sandbox {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("alinery-library-{}", uuid::Uuid::new_v4()));
            let roots = PlaybookRoots {
                global_config_dir: path.join("config"),
                repo_dir: path.join("repo"),
            };
            fs::create_dir_all(&roots.repo_dir).unwrap();
            fs::create_dir_all(&roots.global_config_dir).unwrap();
            Self { path, roots }
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn bundled_deletion_persists_across_repositories_without_deleting_copies() {
        let sandbox = Sandbox::new();
        let bundled = reference(PlaybookScope::Bundled);
        save(&sandbox.roots, PlaybookScope::Global, "Personal", false).unwrap();
        save(&sandbox.roots, PlaybookScope::Repo, "Team", false).unwrap();
        delete_playbook(&sandbox.roots, &bundled).unwrap();
        delete_playbook(&sandbox.roots, &bundled).unwrap();

        for repo_dir in [sandbox.roots.repo_dir.clone(), sandbox.path.join("other-repo"), PathBuf::new()] {
            let roots = PlaybookRoots {
                global_config_dir: sandbox.roots.global_config_dir.clone(),
                repo_dir,
            };
            assert!(matches!(resolve_playbook(&roots, &bundled), Err(PlaybookLoadError::Unknown { .. })));
            let catalog = load_playbook_catalog(&roots);
            assert!(!catalog.candidates.iter().any(|candidate| candidate.source.reference == bundled));
            assert!(catalog.diagnostics.is_empty());
            assert_eq!(resolve_playbook(&roots, &reference(PlaybookScope::Global)).unwrap().definition.title, "Personal");
        }
        assert_eq!(resolve_playbook(&sandbox.roots, &reference(PlaybookScope::Repo)).unwrap().definition.title, "Team");
        let other = PlaybookRef {
            scope: PlaybookScope::Bundled,
            key: "one-shot".into(),
        };
        assert!(resolve_playbook(&sandbox.roots, &other).is_ok());
        assert!(resolve_playbook(&Sandbox::new().roots, &bundled).is_ok());
    }

    #[test]
    fn bundled_deletion_rejects_unknown_keys_and_unsafe_markers() {
        let sandbox = Sandbox::new();
        let unknown = PlaybookRef {
            scope: PlaybookScope::Bundled,
            key: "missing".into(),
        };
        assert!(matches!(delete_playbook(&sandbox.roots, &unknown), Err(PlaybookSaveError::Unknown { .. })));
        let unsafe_key = PlaybookRef {
            scope: PlaybookScope::Bundled,
            key: "../outside".into(),
        };
        assert!(matches!(delete_playbook(&sandbox.roots, &unsafe_key), Err(PlaybookSaveError::Invalid { .. })));

        let root = checked_root(&sandbox.roots, PlaybookScope::Global, true).unwrap();
        let marker = root.join(".deleted-bundled-superdevelop");
        let outside = sandbox.path.join("outside");
        fs::write(&outside, "preserve").unwrap();
        std::os::unix::fs::symlink(&outside, &marker).unwrap();
        let bundled = reference(PlaybookScope::Bundled);
        assert!(matches!(delete_playbook(&sandbox.roots, &bundled), Err(PlaybookSaveError::Io { .. })));
        assert!(matches!(resolve_playbook(&sandbox.roots, &bundled), Err(PlaybookLoadError::Io { .. })));
        assert_eq!(fs::read_to_string(outside).unwrap(), "preserve");
    }

    fn reference(scope: PlaybookScope) -> PlaybookRef {
        PlaybookRef {
            scope,
            key: "superdevelop".into(),
        }
    }
    fn source(title: &str) -> String {
        let mut definition = parse_playbook_md(BUNDLED_PLAYBOOKS.iter().find(|(key, _)| *key == "superdevelop").unwrap().1).unwrap();
        definition.title = title.into();
        render_playbook_md(&definition)
    }
    fn save(roots: &PlaybookRoots, scope: PlaybookScope, title: &str, overwrite: bool) -> Result<ScopedPlaybook, PlaybookSaveError> {
        save_playbook(
            roots,
            SavePlaybookRequest {
                target: reference(scope),
                source: source(title),
                overwrite,
            },
        )
    }

    #[test]
    fn catalog_keeps_scopes_and_legacy_files_untouched() {
        let sandbox = Sandbox::new();
        save(&sandbox.roots, PlaybookScope::Global, "Personal", false).unwrap();
        save(&sandbox.roots, PlaybookScope::Repo, "Team", false).unwrap();
        let legacy = sandbox.roots.repo_dir.join(".alinery/playbooks.toml");
        let prompt = sandbox.roots.repo_dir.join(".alinery/playbooks/old.md");
        fs::write(&legacy, "legacy registry sentinel").unwrap();
        fs::write(&prompt, "legacy prompt sentinel").unwrap();
        let catalog = load_playbook_catalog(&sandbox.roots);
        let choices: Vec<_> = catalog.candidates.iter().filter(|candidate| candidate.source.reference.key == "superdevelop").collect();
        assert_eq!(choices.len(), 3);
        assert_eq!(resolve_playbook(&sandbox.roots, &reference(PlaybookScope::Global)).unwrap().definition.title, "Personal");
        let team = resolve_playbook(&sandbox.roots, &reference(PlaybookScope::Repo)).unwrap();
        assert_eq!(team.definition.title, "Team");
        assert_eq!(team.modified_at_ms, modification_time(team.source.path.as_ref().unwrap()));
        assert_eq!(resolve_playbook(&sandbox.roots, &reference(PlaybookScope::Bundled)).unwrap().modified_at_ms, None);
        assert_eq!(fs::read_to_string(legacy).unwrap(), "legacy registry sentinel");
        assert_eq!(fs::read_to_string(prompt).unwrap(), "legacy prompt sentinel");
        assert!(!catalog.candidates.iter().any(|candidate| candidate.source.reference.key == "old"));
    }

    #[test]
    fn invalid_candidates_never_fall_back_to_another_scope() {
        let sandbox = Sandbox::new();
        let global = save(&sandbox.roots, PlaybookScope::Global, "Personal", false).unwrap();
        let repo = save(&sandbox.roots, PlaybookScope::Repo, "Team", false).unwrap();
        let path = repo.source.path.unwrap();
        fs::write(&path, "not a playbook").unwrap();
        let catalog = load_playbook_catalog(&sandbox.roots);
        assert!(catalog
            .candidates
            .iter()
            .find(|candidate| candidate.source.reference == reference(PlaybookScope::Repo))
            .unwrap()
            .diagnostics
            .iter()
            .any(|error| error.code == "missing_frontmatter"));
        assert!(matches!(
            resolve_playbook(&sandbox.roots, &reference(PlaybookScope::Repo)),
            Err(PlaybookLoadError::Invalid { .. })
        ));
        assert_eq!(resolve_playbook(&sandbox.roots, &reference(PlaybookScope::Global)).unwrap().definition, global.definition);
        fs::write(&path, [0xff]).unwrap();
        assert!(matches!(
            resolve_playbook(&sandbox.roots, &reference(PlaybookScope::Repo)),
            Err(PlaybookLoadError::Io { .. })
        ));
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(matches!(
            resolve_playbook(&sandbox.roots, &reference(PlaybookScope::Repo)),
            Err(PlaybookLoadError::Io { .. })
        ));
        let unknown = PlaybookRef {
            scope: PlaybookScope::Repo,
            key: "missing".into(),
        };
        assert!(matches!(resolve_playbook(&sandbox.roots, &unknown), Err(PlaybookLoadError::Unknown { .. })));
    }

    #[test]
    fn save_validates_before_mutating_and_requires_explicit_overwrite() {
        let sandbox = Sandbox::new();
        let target = reference(PlaybookScope::Repo);
        let request = SavePlaybookRequest {
            target: target.clone(),
            source: "invalid".into(),
            overwrite: false,
        };
        assert!(matches!(save_playbook(&sandbox.roots, request), Err(PlaybookSaveError::Invalid { .. })));
        assert!(!sandbox.roots.repo_dir.join(".alinery/playbooks").exists());
        let original = save(&sandbox.roots, PlaybookScope::Repo, "Original", false).unwrap();
        let path = original.source.path.unwrap();
        let before = fs::read(&path).unwrap();
        assert!(matches!(
            save(&sandbox.roots, PlaybookScope::Repo, "Unconfirmed", false),
            Err(PlaybookSaveError::Conflict { .. })
        ));
        let wrong_key = source("Wrong key").replacen("key = \"superdevelop\"", "key = \"different\"", 1);
        let request = SavePlaybookRequest {
            target,
            source: wrong_key,
            overwrite: true,
        };
        assert!(matches!(save_playbook(&sandbox.roots, request), Err(PlaybookSaveError::Invalid { .. })));
        assert_eq!(fs::read(&path).unwrap(), before);
        save(&sandbox.roots, PlaybookScope::Repo, "Confirmed", true).unwrap();
        assert_eq!(parse_playbook_md(&fs::read_to_string(path).unwrap()).unwrap().title, "Confirmed");
    }

    #[test]
    fn bundled_copy_new_key_and_delete_are_isolated() {
        let sandbox = Sandbox::new();
        assert!(matches!(save(&sandbox.roots, PlaybookScope::Bundled, "No", true), Err(PlaybookSaveError::ReadOnly { .. })));
        save(&sandbox.roots, PlaybookScope::Global, "Global", false).unwrap();
        let repo = save(&sandbox.roots, PlaybookScope::Repo, "Repo", false).unwrap();
        let mut copy = repo.definition;
        copy.key = "new-key".into();
        let new_ref = PlaybookRef {
            scope: PlaybookScope::Repo,
            key: copy.key.clone(),
        };
        save_playbook(
            &sandbox.roots,
            SavePlaybookRequest {
                target: new_ref.clone(),
                source: render_playbook_md(&copy),
                overwrite: false,
            },
        )
        .unwrap();
        delete_playbook(&sandbox.roots, &reference(PlaybookScope::Repo)).unwrap();
        assert!(matches!(
            resolve_playbook(&sandbox.roots, &reference(PlaybookScope::Repo)),
            Err(PlaybookLoadError::Unknown { .. })
        ));
        assert_eq!(resolve_playbook(&sandbox.roots, &reference(PlaybookScope::Global)).unwrap().definition.title, "Global");
        assert_eq!(resolve_playbook(&sandbox.roots, &new_ref).unwrap().definition, copy);
        assert!(resolve_playbook(&sandbox.roots, &reference(PlaybookScope::Bundled)).is_ok());
    }

    #[test]
    fn picker_metadata_stays_separate_from_definitions() {
        let sandbox = Sandbox::new();
        let global = save(&sandbox.roots, PlaybookScope::Global, "First", false).unwrap();
        let path = global.source.path.unwrap();
        let before = fs::read(&path).unwrap();
        let preferences = PickerPreferences {
            order: vec![reference(PlaybookScope::Global), reference(PlaybookScope::Bundled)],
            entries: vec![PickerPreference {
                reference: reference(PlaybookScope::Global),
                preferred: true,
                hidden: true,
                collapsed: false,
                badge: Some("G".into()),
                color: Some("#123456".into()),
                last_imported_at_ms: Some(123),
            }],
        };
        save_picker_preferences(&sandbox.roots, &preferences).unwrap();
        assert_eq!(load_picker_preferences(&sandbox.roots).unwrap(), preferences);
        assert_eq!(fs::read(path).unwrap(), before);
        save(&sandbox.roots, PlaybookScope::Global, "Current", true).unwrap();
        assert_eq!(resolve_playbook(&sandbox.roots, &reference(PlaybookScope::Global)).unwrap().definition.title, "Current");
        let picker = sandbox.roots.repo_dir.join(".alinery/playbooks/picker.toml");
        fs::write(picker, "title = \"Not definition storage\"").unwrap();
        assert!(load_picker_preferences(&sandbox.roots).is_err());
        assert!(load_playbook_catalog(&sandbox.roots)
            .candidates
            .iter()
            .any(|candidate| candidate.source.reference == reference(PlaybookScope::Global) && candidate.diagnostics.is_empty()));
    }

    #[test]
    fn picker_preferences_are_repo_isolated_without_global_inheritance() {
        let sandbox = Sandbox::new();
        let global_roots = PlaybookRoots {
            global_config_dir: sandbox.roots.global_config_dir.clone(),
            repo_dir: PathBuf::new(),
        };
        let other_roots = PlaybookRoots {
            global_config_dir: sandbox.roots.global_config_dir.clone(),
            repo_dir: sandbox.path.join("other-repo"),
        };
        fs::create_dir(&other_roots.repo_dir).unwrap();
        let global_preferences = PickerPreferences {
            order: vec![reference(PlaybookScope::Bundled), reference(PlaybookScope::Global)],
            entries: vec![PickerPreference {
                reference: reference(PlaybookScope::Bundled),
                preferred: true,
                hidden: false,
                collapsed: false,
                badge: None,
                color: None,
                last_imported_at_ms: None,
            }],
        };
        save_picker_preferences(&global_roots, &global_preferences).unwrap();
        assert_eq!(load_playbook_catalog(&sandbox.roots).picker_preferences, PickerPreferences::default());
        assert_eq!(load_playbook_catalog(&other_roots).picker_preferences, PickerPreferences::default());
        assert!(!sandbox.roots.repo_dir.join(".alinery").exists());

        let app_config = global_roots.global_config_dir.join("app.toml");
        let repo_config = sandbox.roots.repo_dir.join(".alinery/config.toml");
        fs::create_dir(repo_config.parent().unwrap()).unwrap();
        let global_config = "[global.defaults.playbook]\nscope = 'bundled'\nkey = 'one-shot'\n";
        let local_config = "[defaults.playbook]\nscope = 'bundled'\nkey = 'review'\n";
        fs::write(&app_config, global_config).unwrap();
        fs::write(&repo_config, local_config).unwrap();
        let before = crate::read_scoped_settings_strict(&app_config, &sandbox.roots.repo_dir)
            .unwrap()
            .effective
            .defaults
            .playbook;
        let mut repo_preferences = global_preferences.clone();
        repo_preferences.order.reverse();
        repo_preferences.entries[0].preferred = false;
        save_picker_preferences(&sandbox.roots, &repo_preferences).unwrap();
        save_picker_preferences(&other_roots, &PickerPreferences::default()).unwrap();
        assert_eq!(load_playbook_catalog(&sandbox.roots).picker_preferences, repo_preferences);
        assert_eq!(load_playbook_catalog(&other_roots).picker_preferences, PickerPreferences::default());
        assert_eq!(load_playbook_catalog(&global_roots).picker_preferences, global_preferences);
        assert_eq!(
            crate::read_scoped_settings_strict(&app_config, &sandbox.roots.repo_dir)
                .unwrap()
                .effective
                .defaults
                .playbook,
            before
        );
        assert_eq!(fs::read_to_string(app_config).unwrap(), global_config);
        assert_eq!(fs::read_to_string(repo_config).unwrap(), local_config);
    }

    #[test]
    fn legacy_picker_metadata_does_not_imply_preferred_membership() {
        let sandbox = Sandbox::new();
        let root = checked_root(&sandbox.roots, PlaybookScope::Repo, true).unwrap();
        fs::write(
            root.join("picker.toml"),
            "order = [{ scope = 'bundled', key = 'superdevelop' }]\n[[entries]]\nreference = { scope = 'bundled', key = 'superdevelop' }\nhidden = true\n",
        )
        .unwrap();
        let preferences = load_picker_preferences(&sandbox.roots).unwrap();
        assert_eq!(preferences.order, vec![reference(PlaybookScope::Bundled)]);
        assert!(!preferences.entries[0].preferred);
        assert!(preferences.entries[0].hidden);
        save_picker_preferences(&sandbox.roots, &preferences).unwrap();
        assert_eq!(load_picker_preferences(&sandbox.roots).unwrap(), preferences);
    }

    #[test]
    fn invalid_picker_references_do_not_replace_saved_preferences() {
        let sandbox = Sandbox::new();
        let preferences = PickerPreferences {
            order: vec![reference(PlaybookScope::Bundled)],
            entries: Vec::new(),
        };
        save_picker_preferences(&sandbox.roots, &preferences).unwrap();
        let mut invalid = preferences.clone();
        invalid.order[0].key = "../escape".into();
        assert!(save_picker_preferences(&sandbox.roots, &invalid).is_err());
        assert_eq!(load_picker_preferences(&sandbox.roots).unwrap(), preferences);
        invalid.order = vec![reference(PlaybookScope::Bundled); 2];
        assert!(save_picker_preferences(&sandbox.roots, &invalid).is_err());
        assert_eq!(load_picker_preferences(&sandbox.roots).unwrap(), preferences);
        fs::write(
            sandbox.roots.repo_dir.join(".alinery/playbooks/picker.toml"),
            "[[entries]]\nreference = { scope = 'repo', key = '../escape' }\npreferred = true\n",
        )
        .unwrap();
        assert!(load_picker_preferences(&sandbox.roots).is_err());
    }

    #[test]
    fn picker_preferences_reject_symlinked_repo_components_and_lock() {
        use std::os::unix::fs::symlink;
        for component in [".alinery", ".alinery/playbooks", ".alinery/playbooks/picker.toml", ".alinery/playbooks/.mutation.lock"] {
            let sandbox = Sandbox::new();
            let outside = sandbox.path.join("outside");
            fs::create_dir(&outside).unwrap();
            let sentinel = outside.join("picker.toml");
            fs::write(&sentinel, "order = []\n").unwrap();
            let link = sandbox.roots.repo_dir.join(component);
            fs::create_dir_all(link.parent().unwrap()).unwrap();
            let is_leaf = component.ends_with("picker.toml") || component.ends_with(".mutation.lock");
            symlink(if is_leaf { &sentinel } else { &outside }, &link).unwrap();
            if !component.ends_with(".mutation.lock") {
                assert!(load_picker_preferences(&sandbox.roots).is_err(), "{component}");
            }
            assert!(save_picker_preferences(&sandbox.roots, &PickerPreferences::default()).is_err(), "{component}");
            assert_eq!(fs::read_to_string(&sentinel).unwrap(), "order = []\n");
            assert!(!outside.join("playbooks").exists());
        }
    }

    #[test]
    fn explicit_global_root_does_not_use_dev_instance_parents() {
        let sandbox = Sandbox::new();
        for instance in ["a", "b"] {
            let directory = sandbox.roots.global_config_dir.join("instances").join(instance);
            fs::create_dir_all(directory.join("playbooks/superdevelop")).unwrap();
            fs::write(directory.join("app.toml"), "").unwrap();
            fs::write(directory.join("playbooks/superdevelop/playbook.md"), source("Decoy")).unwrap();
        }
        save(&sandbox.roots, PlaybookScope::Global, "Shared", false).unwrap();
        assert_eq!(resolve_playbook(&sandbox.roots, &reference(PlaybookScope::Global)).unwrap().definition.title, "Shared");
        assert!(sandbox.roots.global_config_dir.join("playbooks/superdevelop/playbook.md").is_file());
    }

    #[test]
    fn storage_rejects_symlink_escape_and_unsafe_keys() {
        use std::os::unix::fs::symlink;
        let sandbox = Sandbox::new();
        let outside = sandbox.path.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("playbook.md"), source("Outside")).unwrap();
        fs::create_dir_all(sandbox.roots.repo_dir.join(".alinery/playbooks")).unwrap();
        symlink(&outside, sandbox.roots.repo_dir.join(".alinery/playbooks/superdevelop")).unwrap();
        assert!(matches!(save(&sandbox.roots, PlaybookScope::Repo, "Escape", true), Err(PlaybookSaveError::Io { .. })));
        assert!(matches!(
            resolve_playbook(&sandbox.roots, &reference(PlaybookScope::Repo)),
            Err(PlaybookLoadError::Io { .. })
        ));
        assert!(matches!(
            delete_playbook(&sandbox.roots, &reference(PlaybookScope::Repo)),
            Err(PlaybookSaveError::Io { .. })
        ));
        assert_eq!(parse_playbook_md(&fs::read_to_string(outside.join("playbook.md")).unwrap()).unwrap().title, "Outside");
        let unsafe_ref = PlaybookRef {
            scope: PlaybookScope::Repo,
            key: "../outside".into(),
        };
        assert!(matches!(resolve_playbook(&sandbox.roots, &unsafe_ref), Err(PlaybookLoadError::Invalid { .. })));
    }

    // A child test invocation exercises the actual OS lock rather than just a
    // thread mutex. Only the explicitly selected child test observes this env.
    #[test]
    fn save_race_child() {
        let Some(root) = std::env::var_os("ALINERY_LIBRARY_RACE_ROOT") else {
            return;
        };
        let path = PathBuf::from(root);
        let name = std::env::var("ALINERY_LIBRARY_RACE_NAME").unwrap();
        let roots = PlaybookRoots {
            global_config_dir: path.join("config"),
            repo_dir: path.join("repo"),
        };
        fs::write(path.join(format!("ready-{name}")), "").unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !path.join("go").exists() {
            assert!(Instant::now() < deadline, "race parent did not release barrier");
            std::thread::sleep(Duration::from_millis(5));
        }
        let outcome = match save(&roots, PlaybookScope::Repo, &name, false) {
            Ok(_) => "won",
            Err(PlaybookSaveError::Conflict { .. }) => "conflict",
            Err(error) => panic!("unexpected save error: {error:?}"),
        };
        fs::write(path.join(format!("outcome-{name}")), outcome).unwrap();
    }

    #[test]
    fn nonoverwrite_saves_have_one_cross_process_winner() {
        let sandbox = Sandbox::new();
        let executable = std::env::current_exe().unwrap();
        let mut children: Vec<_> = ["left", "right"]
            .into_iter()
            .map(|name| {
                Command::new(&executable)
                    .args(["--exact", "playbook_library::tests::save_race_child", "--nocapture"])
                    .env("ALINERY_LIBRARY_RACE_ROOT", &sandbox.path)
                    .env("ALINERY_LIBRARY_RACE_NAME", name)
                    .stdout(Stdio::null())
                    .spawn()
                    .unwrap()
            })
            .collect();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !["left", "right"].iter().all(|name| sandbox.path.join(format!("ready-{name}")).exists()) {
            if Instant::now() >= deadline {
                for child in &mut children {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                panic!("race children did not reach barrier");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        fs::write(sandbox.path.join("go"), "").unwrap();
        for child in &mut children {
            assert!(child.wait().unwrap().success());
        }
        let left = fs::read_to_string(sandbox.path.join("outcome-left")).unwrap();
        let right = fs::read_to_string(sandbox.path.join("outcome-right")).unwrap();
        assert!(matches!((left.as_str(), right.as_str()), ("won", "conflict") | ("conflict", "won")));
        let winner = if left == "won" { "left" } else { "right" };
        assert_eq!(resolve_playbook(&sandbox.roots, &reference(PlaybookScope::Repo)).unwrap().definition.title, winner);
    }

    #[test]
    fn global_management_without_repo_never_resolves_current_directory() {
        let sandbox = Sandbox::new();
        let roots = PlaybookRoots {
            global_config_dir: sandbox.roots.global_config_dir.clone(),
            repo_dir: PathBuf::new(),
        };
        save(&roots, PlaybookScope::Global, "Personal", false).unwrap();
        let catalog = load_playbook_catalog(&roots);
        assert!(catalog.candidates.iter().all(|candidate| candidate.source.reference.scope != PlaybookScope::Repo));
        assert_eq!(resolve_playbook(&roots, &reference(PlaybookScope::Global)).unwrap().definition.title, "Personal");
        assert!(matches!(resolve_playbook(&roots, &reference(PlaybookScope::Repo)), Err(PlaybookLoadError::Io { .. })));
        assert!(matches!(save(&roots, PlaybookScope::Repo, "No repository", false), Err(PlaybookSaveError::Io { .. })));
        assert!(matches!(delete_playbook(&roots, &reference(PlaybookScope::Repo)), Err(PlaybookSaveError::Io { .. })));
    }

    // APFS rejects non-UTF-8 filenames at creation. Exercise this filesystem
    // boundary on Linux rather than treating an unsupported fixture as success.
    #[cfg(target_os = "linux")]
    #[test]
    fn catalog_isolates_non_utf8_directory_errors() {
        use std::os::unix::ffi::OsStringExt;
        let sandbox = Sandbox::new();
        let root = sandbox.roots.global_config_dir.join("playbooks");
        fs::create_dir_all(&root).unwrap();
        for byte in [0xfe, 0xff] {
            let directory = root.join(std::ffi::OsString::from_vec(vec![b'a', b'-', byte]));
            fs::create_dir(&directory).unwrap();
            fs::write(directory.join("playbook.md"), source("Unreadable identity")).unwrap();
        }
        save(&sandbox.roots, PlaybookScope::Global, "Valid sibling", false).unwrap();
        let catalog = load_playbook_catalog(&sandbox.roots);
        assert!(catalog
            .candidates
            .iter()
            .any(|candidate| candidate.source.reference == reference(PlaybookScope::Global) && candidate.title.as_deref() == Some("Valid sibling")));
        // Both failures must be visible regardless of directory enumeration
        // order; stopping the scope scan at its first malformed entry loses one.
        assert_eq!(catalog.diagnostics.iter().filter(|diagnostic| diagnostic.code == "library_io").count(), 2);
    }
}
