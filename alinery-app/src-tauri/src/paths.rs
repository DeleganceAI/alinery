//! paths: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;
use std::ffi::OsStr;

const ALINERY_DEV_LAUNCH_ROOT: &str = "ALINERY_DEV_LAUNCH_ROOT";

pub(crate) static ACTIVE_REPO: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();
pub(crate) fn active_repo_cell() -> &'static RwLock<Option<PathBuf>> {
    ACTIVE_REPO.get_or_init(|| RwLock::new(None))
}

pub(crate) fn active_repo() -> Result<PathBuf, String> {
    active_repo_cell()
        .read()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "no active repo selected".to_string())
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
    match state.reserve_repo(repo)? {
        Some(reservation) => {
            reservation.commit(state);
            Ok(())
        }
        None => Err(format!("repo-busy: another Alinery window holds {}", repo.display())),
    }
}

pub(crate) fn require_owned_active_repo(state: &AppState) -> Result<PathBuf, String> {
    let repo = active_repo()?;
    require_repo_owned(state, &repo)?;
    Ok(repo)
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

pub(crate) fn app_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let launch_root = std::env::var_os(ALINERY_DEV_LAUNCH_ROOT);
    Ok(app_config_path_for(&app_config_dir, &app.config().identifier, launch_root.as_deref()))
}

pub(crate) fn git_top_level(path: &Path) -> Result<PathBuf, String> {
    alinery_core::git_top_level(path)
}

// Targeted create-form operations may inspect or modify only a repository already chosen by
// the user. Canonicalize both sides so spelling/symlink differences cannot fall back to the
// process-wide active repository.
pub(crate) fn validate_known_target_repo(known_repos: &[String], requested: &str) -> Result<PathBuf, String> {
    alinery_core::resolve_target_repo(requested, None, known_repos)
}

pub(crate) fn target_repo_for_app(app: &AppHandle, repo_path: &str) -> Result<PathBuf, String> {
    validate_known_target_repo(&load_app_config(app).known_repos, repo_path)
}

pub(crate) fn tasks_dir(repo: &Path) -> PathBuf {
    alinery_dir(repo).join("tasks")
}
pub(crate) fn task_dir(repo: &Path, slug: &str) -> PathBuf {
    tasks_dir(repo).join(slug)
}
pub(crate) fn sessions_dir(repo: &Path, slug: &str) -> PathBuf {
    task_dir(repo, slug).join("sessions")
}
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn root_sessions_dir(repo: &Path) -> PathBuf {
    alinery_dir(repo).join("sessions")
}
pub(crate) fn worktrees_dir(repo: &Path) -> PathBuf {
    alinery_dir(repo).join("worktrees")
}
// Option C: artifacts are task-owned (with task.md/sessions), NOT in the worktree —
// already gitignored, survives worktree removal, sensible once a task spans >1 repo.
pub(crate) fn artifacts_dir(repo: &Path, slug: &str) -> PathBuf {
    task_dir(repo, slug).join("artifacts")
}

pub(crate) fn artifact_file_path(repo: &Path, slug: &str, name: &str) -> Result<PathBuf, String> {
    alinery_core::artifact_file_path(repo, slug, name)
}

pub(crate) fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove {}: {e}", path.display())),
    }
}

pub(crate) fn ensure_repo_ready(repo: &Path) -> Result<(), String> {
    fs::create_dir_all(alinery_dir(repo)).map_err(|e| e.to_string())?;
    ensure_gitignore(repo)?;
    ensure_harnesses_toml(repo)?;
    ensure_config_toml(repo)
}

// read_session_meta moved into the daemon (alinery_core::read_meta_harness_model) —
// the app no longer spawns ptys, so it never reads a session's harness/model itself.

pub(crate) fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// kebab-case: lowercase alnum runs joined by single dashes, no leading/trailing dash.
pub(crate) fn slugify(name: &str) -> String {
    let mut s = String::new();
    let mut prev_dash = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !s.is_empty() && !prev_dash {
            s.push('-');
            prev_dash = true;
        }
    }
    let s = s.trim_end_matches('-').to_string();
    if s.is_empty() {
        "task".to_string()
    } else {
        s
    }
}

// Keep task data + worktrees out of the active repo's `git status` (like `.git`).
pub(crate) fn ensure_gitignore(repo: &Path) -> Result<(), String> {
    alinery_core::task_creation::ensure_task_data_ignored(repo)
}

pub(crate) fn file_mtime_secs(path: impl AsRef<Path>) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

pub(crate) fn dir_latest_mtime_secs(path: impl AsRef<Path>) -> Option<u64> {
    let mut latest: Option<u64> = None;
    let entries = fs::read_dir(path).ok()?;
    for entry in entries.flatten() {
        let modified = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        if let Some(ts) = modified {
            latest = Some(latest.map_or(ts, |cur| cur.max(ts)));
        }
    }
    latest
}
