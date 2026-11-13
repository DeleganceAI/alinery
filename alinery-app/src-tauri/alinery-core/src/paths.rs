use std::fs;
use std::path::{Path, PathBuf};

pub const REPO_DATA_DIR: &str = ".alinery";

/// The uid this process runs as; keys per-user scratch directories such as `/tmp/alinery-<uid>`.
pub fn effective_uid() -> u32 {
    unsafe { libc::geteuid() }
}

/// Stable application configuration root, including development instance paths.
pub fn app_config_dir_of(app_config: &Path) -> Option<&Path> {
    let dir = app_config.parent()?;
    match dir.parent() {
        Some(instances) if instances.file_name() == Some(std::ffi::OsStr::new("instances")) => instances.parent(),
        _ => Some(dir),
    }
}

pub fn alinery_dir(repo: &Path) -> PathBuf {
    repo.join(REPO_DATA_DIR)
}

fn alineryd_stem(namespace: Option<&str>) -> String {
    let clean = namespace
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(48)
        .collect::<String>();
    if clean.is_empty() {
        "alineryd".to_string()
    } else {
        format!("alineryd-{clean}")
    }
}

pub fn alineryd_socket_path(repo: &Path, namespace: Option<&str>) -> PathBuf {
    alinery_dir(repo).join(format!("{}.sock", alineryd_stem(namespace)))
}

pub fn alineryd_lock_path(repo: &Path, namespace: Option<&str>) -> PathBuf {
    alinery_dir(repo).join(format!(".{}.lock", alineryd_stem(namespace)))
}

/// MCP stdio bridge socket: `.alinery/mcp.sock` or `.alinery/mcp-<ns>.sock`.
pub fn mcp_socket_path(repo: &Path, namespace: Option<&str>) -> PathBuf {
    alinery_dir(repo).join(format!("{}.sock", mcp_stem(namespace)))
}

/// MCP status sidecar: `.alinery/mcp.status.json` or `.alinery/mcp-<ns>.status.json`.
pub fn mcp_status_path(repo: &Path, namespace: Option<&str>) -> PathBuf {
    alinery_dir(repo).join(format!("{}.status.json", mcp_stem(namespace)))
}

fn mcp_stem(namespace: Option<&str>) -> String {
    let clean = namespace
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(48)
        .collect::<String>();
    if clean.is_empty() {
        "mcp".to_string()
    } else {
        format!("mcp-{clean}")
    }
}

/// The daemon's gRPC socket (plan T1): `.alinery/rpc.sock` or `.alinery/rpc-<ns>.sock`, the lane naming of `alineryd[-ns].sock`.
pub fn rpc_socket_path(repo: &Path, namespace: Option<&str>) -> PathBuf {
    let clean = namespace
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(48)
        .collect::<String>();
    let stem = if clean.is_empty() { "rpc".to_string() } else { format!("rpc-{clean}") };
    alinery_dir(repo).join(format!("{stem}.sock"))
}

/// Reconciler transaction lock (one per repo, separate from daemon ownership).
pub fn alineryd_reconciler_lock_path(repo: &Path) -> PathBuf {
    alinery_dir(repo).join(".alineryd-reconciler.lock")
}

/// GUI ownership lock: the alinery *app* (not the daemon) holds this exclusively while a
/// repo is its active repo, so a second alinery opening the same folder can refuse-and-
/// explain instead of silently running two GUIs over one working tree.
///
/// Deliberately **not namespaced**, unlike lane-specific daemon sockets. A daemon
/// separately holds repository ownership, so build lanes retain distinct identities
/// without allowing concurrent daemons over the same project.
pub fn alinery_app_lock_path(repo: &Path) -> PathBuf {
    alinery_dir(repo).join(".alinery-app.lock")
}

/// Repository-wide task record transaction lock. This is separate from GUI ownership and
/// daemon lifecycle locks because app and MCP task mutations share it.
pub fn task_mutation_lock_path(repo: &Path) -> PathBuf {
    alinery_dir(repo).join(".task-mutation.lock")
}

/// Enumerate the daemon lane sockets under `.alinery/`: `(namespace, path)`. A lane has the gRPC socket
/// `rpc[-ns].sock`, and an older daemon's lane also has `alineryd[-ns].sock`. The prod lane uses `namespace == ""`.
pub fn list_alineryd_lane_sockets(repo: &Path) -> Vec<(String, PathBuf)> {
    let dir = alinery_dir(repo);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for ent in entries.flatten() {
        let name = ent.file_name();
        let Some(s) = name.to_str() else { continue };
        let Some(stem) = s.strip_suffix(".sock") else { continue };
        // skip unrelated *.sock
        let ns = if stem == "alineryd" || stem == "rpc" {
            String::new()
        } else if let Some(rest) = stem.strip_prefix("alineryd-").or_else(|| stem.strip_prefix("rpc-")) {
            rest.to_string()
        } else {
            continue;
        };
        out.push((ns, ent.path()));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

pub fn tasks_dir(repo: &Path) -> PathBuf {
    alinery_dir(repo).join("tasks")
}

// task_dir defined in task.rs (unique_slug/read/write use it)
// ... more paths as needed
pub fn config_toml_path(repo: &Path) -> PathBuf {
    alinery_dir(repo).join("config.toml")
}

pub fn harnesses_toml_path(repo: &Path) -> PathBuf {
    alinery_dir(repo).join("harnesses.toml")
}

pub fn artifacts_dir(repo: &Path, slug: &str) -> PathBuf {
    tasks_dir(repo).join(slug).join("artifacts")
}

// Compat alias for alineryd and old code (ponytail: no bigger rename yet)
pub fn attachments_dir(repo: &Path, slug: &str) -> PathBuf {
    artifacts_dir(repo, slug).join("attachments")
}

pub fn subtask_snapshots_dir(repo: &Path, parent_slug: &str) -> PathBuf {
    artifacts_dir(repo, parent_slug).join("subtasks")
}

pub fn subtask_snapshot_dir(repo: &Path, parent_slug: &str, child_slug: &str) -> PathBuf {
    subtask_snapshots_dir(repo, parent_slug).join(child_slug)
}

pub fn subtask_snapshot_staging_dir(repo: &Path, parent_slug: &str, child_slug: &str, nonce: &str) -> PathBuf {
    subtask_snapshots_dir(repo, parent_slug).join(format!(".{child_slug}.staging-{nonce}"))
}

pub fn sessions_dir(repo: &Path, slug: &str) -> PathBuf {
    tasks_dir(repo).join(slug).join("sessions")
}

// Root (taskless) sessions live at .alinery/sessions/ (vs task-owned .alinery/tasks/<slug>/sessions/).
pub fn root_sessions_dir(repo: &Path) -> PathBuf {
    alinery_dir(repo).join("sessions")
}

// Resolve a session's meta path, honoring the root ("") vs task branch.
pub fn session_meta_path(repo: &Path, task_slug: &str, id: &str) -> PathBuf {
    let dir = if task_slug.is_empty() { root_sessions_dir(repo) } else { sessions_dir(repo, task_slug) };
    dir.join(format!("{id}.meta.json"))
}

pub fn session_name_path(repo: &Path, task_slug: &str, id: &str) -> PathBuf {
    let dir = if task_slug.is_empty() { root_sessions_dir(repo) } else { sessions_dir(repo, task_slug) };
    dir.join(format!("{id}.name.json"))
}

/// Verify retained storage without following repository-controlled directory/file links.
pub(crate) fn validate_retained_file(repo: &Path, path: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let relative = path.strip_prefix(repo).map_err(|_| "storage path escapes repository")?;
    let mut current = repo.to_path_buf();
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("invalid retained storage path".into());
        }
        current.push(component.as_os_str());
        let metadata = std::fs::symlink_metadata(&current).map_err(|_| "retained storage is unavailable")?;
        if components.peek().is_none() {
            if !metadata.is_file() || metadata.nlink() != 1 {
                return Err("retained storage must be a regular, unlinked file".into());
            }
        } else if !metadata.is_dir() {
            return Err("retained storage directory must not be a link".into());
        }
    }
    Ok(())
}

// Alinery-owned OMP conversation dir, sibling of `<id>.meta.json`. Not the worktree
// checkout and not `~/.omp/agent/sessions/`.
pub fn session_omp_dir(repo: &Path, task_slug: &str, id: &str) -> PathBuf {
    let dir = if task_slug.is_empty() { root_sessions_dir(repo) } else { sessions_dir(repo, task_slug) };
    dir.join(format!("{id}.omp"))
}

// Files a taskless chat thread attached. Sibling of `<id>.omp`, not inside the worktree,
// so removing that worktree does not delete them and they are not untracked git files.
// The daemon appends raw session output to this single-file sidecar.
pub fn session_scrollback_path(repo: &Path, task_slug: &str, id: &str) -> PathBuf {
    let dir = if task_slug.is_empty() { root_sessions_dir(repo) } else { sessions_dir(repo, task_slug) };
    dir.join(format!("{id}.scrollback"))
}
pub fn session_scrollback_dir(repo: &Path, task_slug: &str, id: &str) -> PathBuf {
    session_scrollback_path(repo, task_slug, id)
}

pub fn session_scrollback_chunk_path(repo: &Path, task_slug: &str, id: &str, idx: u32) -> PathBuf {
    session_scrollback_dir(repo, task_slug, id).join(format!("{idx:04}"))
}

// Every session meta on disk: root sessions + each task's sessions. Skips non-meta files
// and never panics on a missing dir (the daemon runs this at boot before dirs may exist).
pub fn all_session_meta_paths(repo: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    collect_meta_files(&root_sessions_dir(repo), &mut out);
    if let Ok(entries) = std::fs::read_dir(tasks_dir(repo)) {
        for e in entries.flatten() {
            collect_meta_files(&e.path().join("sessions"), &mut out);
        }
    }
    out
}

fn collect_meta_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_file() && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(".meta.json")) {
            out.push(p);
        }
    }
}

pub fn worktrees_dir(repo: &Path) -> PathBuf {
    alinery_dir(repo).join("worktrees")
}

// task_dir moved to task.rs to avoid glob import ambiguity

/// Tauri bundle identifiers used to resolve app.toml.
pub const PRODUCTION_APP_IDENTIFIER: &str = "ai.delegance.alinery";
pub const DEVELOPMENT_APP_IDENTIFIER: &str = "ai.delegance.alinery.dev";

/// Cross-platform path to an identity's app-level config (known_repos, active_repo).
/// Mirrors Tauri's `app_config_dir()` = `dirs::config_dir()/<identifier>`.
pub fn app_config_toml_path_for(identifier: &str) -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(identifier).join("app.toml"))
}

pub fn app_config_toml_path() -> Option<PathBuf> {
    app_config_toml_path_for(PRODUCTION_APP_IDENTIFIER)
}

/// Directory sibling to `app.toml` that holds the rolling process log.
pub fn logs_dir(app_config: &Path) -> PathBuf {
    app_config.parent().unwrap_or(app_config).join("logs")
}

pub fn log_path(app_config: &Path) -> PathBuf {
    logs_dir(app_config).join("alinery.log")
}

pub fn log_lock_path(app_config: &Path) -> PathBuf {
    logs_dir(app_config).join("alinery.log.lock")
}

/// Stable discriminator for the exact path captured at a process boundary.
pub fn app_config_identity(path: &Path) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in path.as_os_str().as_encoded_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// Reject a client-supplied path component that could escape its parent dir
/// (traversal, separators, absolute). Returns the component if safe.
pub fn safe_component(s: &str) -> Option<&str> {
    if s.is_empty() || s.contains("..") || s.contains('/') || s.contains('\\') || Path::new(s).is_absolute() {
        None
    } else {
        Some(s)
    }
}

/// Walk `exe` for a real install prefix. Some only for
/// `…/<X>.app/Contents/MacOS/<exe>` or a parent directory named `Alinery`
/// (Linux prefix). `target/debug/Alinery` and `target/debug/deps/…` return None
/// so resolve falls through to `default_git_alongside_dir`.
pub fn containing_install_root(exe: &Path) -> Option<PathBuf> {
    let macos_dir = exe.parent()?;
    if macos_dir.file_name()? == "MacOS" {
        let contents_dir = macos_dir.parent()?;
        if contents_dir.file_name()? == "Contents" {
            let bundle = contents_dir.parent()?;
            if bundle.extension()? == "app" {
                return Some(bundle.to_path_buf());
            }
        }
    }
    if macos_dir.file_name()? == "Alinery" {
        return Some(macos_dir.to_path_buf());
    }
    None
}

/// Alongside directory for the fallback Git tree. Path-shape, not cfg:
/// `.app` → sibling `<stem>.git`; otherwise sibling `git`.
pub fn git_alongside_dir(install_root: &Path) -> PathBuf {
    let parent = install_root.parent().unwrap_or(install_root);
    if install_root.extension().is_some_and(|ext| ext == "app") {
        let stem = install_root.file_stem().unwrap_or_default().to_string_lossy();
        parent.join(format!("{stem}.git"))
    } else {
        parent.join("git")
    }
}

pub fn git_binary_path(git_dir: &Path) -> PathBuf {
    git_dir.join("bin").join("git")
}

/// One Alinery-global alongside dir used when `containing_install_root` is None
/// (`tauri dev`, cargo test). Matches install.sh's default dest formula.
pub fn default_git_alongside_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        git_alongside_dir(Path::new("/Applications/Alinery.app"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/root"));
        git_alongside_dir(&home.join(".local/share/alinery/Alinery"))
    }
}

pub(crate) fn installed_git_binary() -> PathBuf {
    match std::env::current_exe() {
        Ok(exe) => match containing_install_root(&exe) {
            Some(root) => git_binary_path(&git_alongside_dir(&root)),
            None => git_binary_path(&default_git_alongside_dir()),
        },
        Err(_) => git_binary_path(&default_git_alongside_dir()),
    }
}

/// Vinculum agent home under the app-config parent (not `~/.pi` and not `~/.omp`).
/// Returns `(agent dir, config root)`: `<app.toml parent>/vinculum/config/agent` and `.../config`.
///
/// On first use, if `vinculum/` is absent and `omp/` is a directory, rename `omp` to `vinculum`
/// so an existing install keeps its skills, MCP files, and `models.yml`. If `vinculum/` already
/// exists, `omp/` is left unread.
pub fn vinculum_home_dirs(app_config: &Path) -> (PathBuf, PathBuf) {
    let parent = app_config.parent().unwrap_or(app_config);
    let vinculum = parent.join("vinculum");
    let omp = parent.join("omp");
    if !vinculum.exists() && omp.is_dir() {
        let _ = fs::rename(&omp, &vinculum);
    }
    let config_root = vinculum.join("config");
    (config_root.join("agent"), config_root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_scrollback_chunk_paths_are_deterministic() {
        let repo = Path::new("/repo");
        assert_eq!(
            session_scrollback_dir(repo, "task", "s1"),
            PathBuf::from("/repo/.alinery/tasks/task/sessions/s1.scrollback")
        );
        assert_eq!(
            session_scrollback_chunk_path(repo, "task", "s1", 1),
            PathBuf::from("/repo/.alinery/tasks/task/sessions/s1.scrollback/0001")
        );
        assert_eq!(
            session_scrollback_chunk_path(repo, "task", "s1", 42),
            PathBuf::from("/repo/.alinery/tasks/task/sessions/s1.scrollback/0042")
        );
    }

    #[test]
    fn session_omp_dir_root_vs_task() {
        let repo = Path::new("/tmp/alinery_repo");
        assert_eq!(session_omp_dir(repo, "", "s1"), root_sessions_dir(repo).join("s1.omp"));
        assert_eq!(session_omp_dir(repo, "my-task", "s1"), sessions_dir(repo, "my-task").join("s1.omp"));
        // Sibling of meta, not nested under it, not a worktree path, not ~/.omp.
        assert_eq!(session_omp_dir(repo, "my-task", "s1").parent(), session_meta_path(repo, "my-task", "s1").parent());
    }

    #[test]
    fn attachments_dir_is_nested_under_artifacts() {
        let repo = Path::new("/repo");
        assert_eq!(attachments_dir(repo, "task-a"), PathBuf::from("/repo/.alinery/tasks/task-a/artifacts/attachments"));
        assert_eq!(attachments_dir(repo, "task-a"), artifacts_dir(repo, "task-a").join("attachments"));
    }

    // B2 / #132: product ownership of a repo is ONE socket + ONE lock, shared by every
    // release channel, so two alinery builds cannot both serve the same repo.
    #[test]
    fn product_daemon_lane_is_one_socket_and_lock_per_repo() {
        let repo = Path::new("/repo");
        assert_eq!(alineryd_socket_path(repo, None), PathBuf::from("/repo/.alinery/alineryd.sock"));
        assert_eq!(alineryd_lock_path(repo, None), PathBuf::from("/repo/.alinery/.alineryd.lock"));
        // An empty namespace must collapse to the product lane, never `alineryd-.sock`.
        assert_eq!(alineryd_socket_path(repo, Some("")), alineryd_socket_path(repo, None));
        assert_eq!(alineryd_lock_path(repo, Some("")), alineryd_lock_path(repo, None));
    }

    // D1: the namespaced lane survives B2 as a debug-only escape hatch so
    // `npm run tauri dev` does not fight an installed alinery over the same repo.
    #[test]
    fn debug_lane_namespace_stays_distinct_from_the_product_lane() {
        let repo = Path::new("/repo");
        assert_eq!(alineryd_socket_path(repo, Some("d0123456789a")), PathBuf::from("/repo/.alinery/alineryd-d0123456789a.sock"));
        assert_ne!(alineryd_lock_path(repo, Some("d0123456789a")), alineryd_lock_path(repo, None));
    }

    #[test]
    fn production_and_development_identifiers_resolve_to_distinct_app_configs() {
        let production = app_config_toml_path_for(PRODUCTION_APP_IDENTIFIER).expect("config root available");
        let development = app_config_toml_path_for(DEVELOPMENT_APP_IDENTIFIER).expect("config root available");

        assert_ne!(production, development);
        assert_eq!(production.file_name().unwrap(), "app.toml");
        assert_eq!(development.file_name().unwrap(), "app.toml");
        assert_eq!(
            production.parent().and_then(Path::parent),
            development.parent().and_then(Path::parent),
            "identities must partition one OS config root"
        );
    }

    #[test]
    fn standalone_app_config_path_remains_the_production_default() {
        assert_eq!(app_config_toml_path(), app_config_toml_path_for(PRODUCTION_APP_IDENTIFIER));
    }

    #[test]
    fn app_config_identity_is_deterministic_over_the_exact_supplied_path() {
        let first = Path::new("/tmp/alinery-dev/app.toml");
        let same = Path::new("/tmp/alinery-dev/app.toml");
        let different = Path::new("/tmp/alinery-prod/app.toml");
        let noncanonical_spelling = Path::new("/tmp/alinery-dev/../alinery-dev/app.toml");

        assert_eq!(app_config_identity(first), app_config_identity(same));
        assert_ne!(app_config_identity(first), app_config_identity(different));
        assert_ne!(
            app_config_identity(first),
            app_config_identity(noncanonical_spelling),
            "identity must hash the exact process-boundary path without canonicalizing it"
        );
    }

    #[test]
    fn logs_dir_is_sibling_logs() {
        let app_config = Path::new("/tmp/id/app.toml");
        assert_eq!(logs_dir(app_config), PathBuf::from("/tmp/id/logs"));
        assert_eq!(log_path(app_config), PathBuf::from("/tmp/id/logs/alinery.log"));
        assert_eq!(log_lock_path(app_config), PathBuf::from("/tmp/id/logs/alinery.log.lock"));
        let bare = Path::new("app.toml");
        assert_eq!(logs_dir(bare), PathBuf::from("logs"));
    }

    #[test]
    fn containing_install_root_macos_bundle() {
        assert_eq!(
            containing_install_root(Path::new("/Applications/Alinery.app/Contents/MacOS/Alinery")),
            Some(PathBuf::from("/Applications/Alinery.app"))
        );
    }

    #[test]
    fn containing_install_root_custom_macos_dir() {
        assert_eq!(
            containing_install_root(Path::new("/tmp/apps/Alinery.app/Contents/MacOS/Alinery")),
            Some(PathBuf::from("/tmp/apps/Alinery.app"))
        );
    }

    #[test]
    fn containing_install_root_linux_prefix() {
        assert_eq!(
            containing_install_root(Path::new("/home/u/.local/share/alinery/Alinery/Alinery")),
            Some(PathBuf::from("/home/u/.local/share/alinery/Alinery"))
        );
    }

    #[test]
    fn containing_install_root_tauri_dev_is_none() {
        assert_eq!(containing_install_root(Path::new("/repo/alinery-app/src-tauri/target/debug/Alinery")), None);
    }

    #[test]
    fn containing_install_root_cargo_test_deps_is_none() {
        assert_eq!(
            containing_install_root(Path::new("/repo/alinery-app/src-tauri/target/debug/deps/alinery_core-deadbeef")),
            None
        );
    }

    #[test]
    fn git_alongside_dir_macos_app() {
        assert_eq!(git_alongside_dir(Path::new("/Applications/Alinery.app")), PathBuf::from("/Applications/Alinery.git"));
    }

    #[test]
    fn git_alongside_dir_custom_macos_dir() {
        assert_eq!(git_alongside_dir(Path::new("/tmp/apps/Alinery.app")), PathBuf::from("/tmp/apps/Alinery.git"));
    }

    #[test]
    fn git_alongside_dir_linux_prefix() {
        assert_eq!(
            git_alongside_dir(Path::new("/home/u/.local/share/alinery/Alinery")),
            PathBuf::from("/home/u/.local/share/alinery/git")
        );
    }

    #[test]
    fn git_binary_path_joins_bin_git() {
        assert_eq!(git_binary_path(Path::new("/Applications/Alinery.git")), PathBuf::from("/Applications/Alinery.git/bin/git"));
    }

    #[test]
    fn default_git_alongside_dir_matches_install_default() {
        #[cfg(target_os = "macos")]
        assert_eq!(default_git_alongside_dir(), PathBuf::from("/Applications/Alinery.git"));
        #[cfg(not(target_os = "macos"))]
        {
            let home = dirs::home_dir().expect("HOME");
            assert_eq!(default_git_alongside_dir(), home.join(".local/share/alinery/git"));
        }
    }

    #[test]
    fn vinculum_home_dirs_rename_omp_once_and_then_leave_it() {
        let root = std::env::temp_dir().join(format!("alinery-vinculum-home-{}", uuid::Uuid::new_v4()));
        let app_config = root.join("app.toml");
        fs::create_dir_all(root.join("omp/config/agent")).unwrap();
        fs::write(root.join("omp/config/agent/marker"), "kept").unwrap();
        let (agent, config_root) = vinculum_home_dirs(&app_config);
        assert_eq!(agent, root.join("vinculum/config/agent"));
        assert_eq!(config_root, root.join("vinculum/config"));
        assert_eq!(fs::read_to_string(agent.join("marker")).unwrap(), "kept");
        assert!(!root.join("omp").exists());
        fs::create_dir_all(root.join("omp/config/agent")).unwrap();
        fs::write(root.join("omp/config/agent/other"), "stay").unwrap();
        let (again, _) = vinculum_home_dirs(&app_config);
        assert_eq!(again, agent);
        assert_eq!(fs::read_to_string(root.join("omp/config/agent/other")).unwrap(), "stay");
        let _ = fs::remove_dir_all(&root);
    }
}
