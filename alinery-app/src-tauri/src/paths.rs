//! paths: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;
use std::ffi::OsStr;

const ALINERY_DEV_LAUNCH_ROOT: &str = "ALINERY_DEV_LAUNCH_ROOT";

pub(crate) static ACTIVE_REPO: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();
pub(crate) fn active_repo_cell() -> &'static RwLock<Option<PathBuf>> {
    ACTIVE_REPO.get_or_init(|| RwLock::new(None))
}

const REMOTE_REPO_SCHEME: &str = "alinery+ssh://";

/// A known-repo entry. Remote entries are `alinery+ssh://<host-id>/<absolute remote path>`
/// and name a path on another machine, so they must never reach a local filesystem call:
/// parse once at the command boundary, then branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RepoRef {
    Local(PathBuf),
    Remote { host_id: String, path: String },
}

impl RepoRef {
    pub(crate) fn parse(key: &str) -> Result<Self, String> {
        let Some(rest) = key.strip_prefix(REMOTE_REPO_SCHEME) else {
            return Ok(Self::Local(PathBuf::from(key)));
        };
        match rest.split_once('/') {
            Some((host_id, path)) if !host_id.is_empty() && !path.is_empty() => Ok(Self::Remote {
                host_id: host_id.to_string(),
                path: format!("/{path}"),
            }),
            _ => Err(format!("malformed remote repository: {key}")),
        }
    }

    pub(crate) fn uri(&self) -> String {
        match self {
            Self::Local(path) => path.to_string_lossy().into_owned(),
            Self::Remote { host_id, path } => format!("{REMOTE_REPO_SCHEME}{host_id}{path}"),
        }
    }
}

pub(crate) fn is_remote_repo_key(key: &str) -> bool {
    key.starts_with(REMOTE_REPO_SCHEME)
}

/// A known repo that exists as a directory on this machine. Local-only loops (the pollers,
/// claims, the chat rail) use this instead of `is_dir()` so a remote key is skipped on purpose,
/// not because the URI happens to be a nonexistent relative path.
pub(crate) fn is_local_repo_dir(repo: &Path) -> bool {
    !is_remote_repo_key(&repo.to_string_lossy()) && repo.is_dir()
}

fn remote_unavailable(key: &str) -> String {
    format!("this action is not yet available for remote repository {key}")
}

/// The active repo exactly as stored, local path or remote URI.
pub(crate) fn active_repo_ref() -> Result<RepoRef, String> {
    let key = active_repo_cell()
        .read()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "no active repo selected".to_string())?;
    RepoRef::parse(&key.to_string_lossy())
}

/// The active repo as a local path. Fails closed for a remote repo, so every command that has
/// not been moved onto the repo service refuses instead of touching a nonexistent local path.
pub(crate) fn active_repo() -> Result<PathBuf, String> {
    match active_repo_ref()? {
        RepoRef::Local(path) => Ok(path),
        remote => Err(remote_unavailable(&remote.uri())),
    }
}

pub(crate) fn set_active_repo_global(repo: Option<PathBuf>) -> Result<(), String> {
    *active_repo_cell().write().map_err(|e| e.to_string())? = repo;
    Ok(())
}

/// True when another process holds `.alinery/.alinery-app.lock` (and we do not).
///
/// Shared probe, never exclusive: status reads may ask about a repository this process
/// failed to claim, and those reads must not become lock contenders themselves.
pub(crate) fn gui_lock_held_elsewhere(repo: &Path) -> bool {
    alinery_core::lockfile::is_locked_by_other(&alinery_app_lock_path(repo))
}

/// Backend ownership gate (B6): every repository this window mutates must have a retained
/// GUI flock. Claim a free repository atomically; refuse one held by another Alinery.
pub(crate) fn require_repo_owned(state: &AppState, repo: &Path) -> Result<(), String> {
    if let Some(conflict) = state.daemon_conflict(repo) {
        return Err(EnsureDaemonError::Mismatch(Box::new(conflict)).to_string());
    }
    match state.reserve_repo(repo)? {
        Some(reservation) => {
            reservation.commit(state);
            Ok(())
        }
        None => Err(format!("repo-busy: another Alinery window holds {}", repo.display())),
    }
}

pub(crate) fn app_config_path_for(app_config_dir: &Path, identifier: &str, launch_root: Option<&OsStr>) -> PathBuf {
    if identifier != alinery_core::DEVELOPMENT_APP_IDENTIFIER {
        return app_config_dir.join("app.toml");
    }

    let instance = launch_root
        .and_then(OsStr::to_str)
        .filter(|root| !root.is_empty())
        .map(fnv1a64_hex)
        .unwrap_or_else(|| "unknown".to_string());
    app_config_dir.join("instances").join(instance).join("app.toml")
}

/// Inverse of app_config_path_for, for callers holding only the app.toml path. The sidecars written
/// next to the config (linear-account) live in the identifier's config dir, which is app.toml's
/// parent for every identifier except the development one, where app.toml sits an instance deep.
pub(crate) fn app_config_dir_of(app_config: &Path) -> Option<&Path> {
    alinery_core::app_config_dir_of(app_config)
}

pub(crate) fn app_config_path<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let app_config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let launch_root = std::env::var_os(ALINERY_DEV_LAUNCH_ROOT);
    Ok(app_config_path_for(&app_config_dir, &app.config().identifier, launch_root.as_deref()))
}

// Targeted create-form operations may inspect or modify only a repository already chosen by
// the user. Canonicalize both sides so spelling/symlink differences cannot fall back to the
// process-wide active repository.
pub(crate) fn validate_known_target_repo(known_repos: &[String], requested: &str) -> Result<PathBuf, String> {
    if is_remote_repo_key(requested) {
        return Err(remote_unavailable(requested));
    }
    alinery_core::resolve_target_repo(requested, None, known_repos)
}

pub(crate) fn target_repo_for_app<R: tauri::Runtime>(app: &AppHandle<R>, repo_path: &str) -> Result<PathBuf, String> {
    validate_known_target_repo(&load_app_config(app).known_repos, repo_path)
}

/// Like `target_repo_for_app`, but a remote key is accepted when it is a known repository.
pub(crate) fn target_repo_ref_for_app<R: tauri::Runtime>(app: &AppHandle<R>, repo_path: &str) -> Result<RepoRef, String> {
    match RepoRef::parse(repo_path)? {
        RepoRef::Local(_) => target_repo_for_app(app, repo_path).map(RepoRef::Local),
        remote => load_app_config(app)
            .known_repos
            .iter()
            .any(|known| known == repo_path)
            .then_some(remote)
            .ok_or_else(|| format!("unknown repository: {repo_path}")),
    }
}

/// The repo a mutating `_for_repo` command acts on: a local one must be owned by this window.
pub(crate) fn owned_target(app: &AppHandle, state: &AppState, repo_path: &str) -> Result<RepoRef, String> {
    let target = target_repo_ref_for_app(app, repo_path)?;
    if let RepoRef::Local(repo) = &target {
        require_repo_owned(state, repo)?;
    }
    Ok(target)
}

/// The repo a command targets, validated: the explicit key if given, otherwise the active repo.
pub(crate) fn target_or_active_ref<R: tauri::Runtime>(app: &AppHandle<R>, repo_path: Option<String>) -> Result<RepoRef, String> {
    match repo_path {
        Some(path) => target_repo_ref_for_app(app, &path),
        None => active_repo_ref(),
    }
}

#[cfg(test)]
pub(crate) fn tasks_dir(repo: &Path) -> PathBuf {
    alinery_dir(repo).join("tasks")
}
#[cfg(test)]
pub(crate) fn task_dir(repo: &Path, slug: &str) -> PathBuf {
    tasks_dir(repo).join(slug)
}
#[cfg(test)]
pub(crate) fn sessions_dir(repo: &Path, slug: &str) -> PathBuf {
    task_dir(repo, slug).join("sessions")
}
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn root_sessions_dir(repo: &Path) -> PathBuf {
    alinery_dir(repo).join("sessions")
}
// Option C: artifacts are task-owned (with task.md/sessions), NOT in the worktree —
// already gitignored, survives worktree removal, sensible once a task spans >1 repo.
#[cfg(test)]
pub(crate) fn artifacts_dir(repo: &Path, slug: &str) -> PathBuf {
    task_dir(repo, slug).join("artifacts")
}

/// What selecting a repo needs before its daemon exists. The rest of readying it (the ignore entry,
/// `harnesses.toml`, `config.toml`) is the daemon's `RepoService.EnsureReady`, called once it answers.
pub(crate) fn ensure_alinery_dir(repo: &Path) -> Result<(), String> {
    fs::create_dir_all(alinery_dir(repo)).map_err(|e| e.to_string())
}

// read_session_meta moved into the daemon (alinery_core::read_meta_harness_model) —
// the app no longer spawns ptys, so it never reads a session's harness/model itself.

pub(crate) fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
