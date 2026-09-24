use std::path::{Path, PathBuf};

pub const REPO_DATA_DIR: &str = ".alinery";

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

/// Cross-lane auto-advance reconciler lock (one per repo, not namespaced).
pub fn alineryd_reconciler_lock_path(repo: &Path) -> PathBuf {
    alinery_dir(repo).join(".alineryd-reconciler.lock")
}

/// GUI ownership lock: the alinery *app* (not the daemon) holds this exclusively while a
/// repo is its active repo, so a second alinery opening the same folder can refuse-and-
/// explain instead of silently running two GUIs over one working tree.
///
/// Deliberately **not namespaced**, unlike the alineryd lane lock: the lane namespace
/// (`alineryd_socket_path`) is a debug escape hatch that lets `npm run tauri dev` keep its
/// own daemon, but two *windows* over one repo is the same hazard whatever channel they
/// were built from. Same reasoning as `alineryd_reconciler_lock_path`.
pub fn alinery_app_lock_path(repo: &Path) -> PathBuf {
    alinery_dir(repo).join(".alinery-app.lock")
}

/// Repository-wide task record transaction lock. This is separate from GUI ownership and
/// daemon lifecycle locks because app and MCP task mutations share it.
pub fn task_mutation_lock_path(repo: &Path) -> PathBuf {
    alinery_dir(repo).join(".task-mutation.lock")
}

/// Enumerate alineryd lane sockets under `.alinery/`: `(namespace, path)`.
/// Prod lane uses `namespace == ""` for `alineryd.sock`.
pub fn list_alineryd_lane_sockets(repo: &Path) -> Vec<(String, PathBuf)> {
    let dir = alinery_dir(repo);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for ent in entries.flatten() {
        let name = ent.file_name();
        let Some(s) = name.to_str() else { continue };
        if !s.ends_with(".sock") || !s.starts_with("alineryd") {
            continue;
        }
        // skip unrelated *.sock
        let ns = if s == "alineryd.sock" {
            String::new()
        } else if let Some(rest) = s.strip_prefix("alineryd-") {
            rest.trim_end_matches(".sock").to_string()
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

pub fn playbooks_dir(repo: &Path) -> PathBuf {
    alinery_dir(repo).join("playbooks")
}

pub fn artifacts_dir(repo: &Path, slug: &str) -> PathBuf {
    tasks_dir(repo).join(slug).join("artifacts")
}

// Compat alias for alineryd and old code (ponytail: no bigger rename yet)
pub fn artifacts_dir_for(repo: &Path, slug: &str) -> PathBuf {
    artifacts_dir(repo, slug)
}

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
    sessions_dir(repo, task_slug).join(format!("{id}.name.json"))
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
/// so resolve falls through to `default_omp_alongside_dir`.
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

/// Alongside directory for a given Alinery install root. Path-shape, not cfg:
/// `.app` → sibling `<stem>.omp`; otherwise sibling `omp`.
pub fn omp_alongside_dir(install_root: &Path) -> PathBuf {
    let parent = install_root.parent().unwrap_or(install_root);
    if install_root.extension().is_some_and(|ext| ext == "app") {
        let stem = install_root.file_stem().unwrap_or_default().to_string_lossy();
        parent.join(format!("{stem}.omp"))
    } else {
        parent.join("omp")
    }
}

pub fn omp_binary_path(omp_dir: &Path) -> PathBuf {
    omp_dir.join("omp")
}

/// One Alinery-global alongside dir used when `containing_install_root` is None
/// (`tauri dev`, cargo test). Matches install.sh's default dest formula.
pub fn default_omp_alongside_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        omp_alongside_dir(Path::new("/Applications/Alinery.app"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/root"));
        omp_alongside_dir(&home.join(".local/share/alinery/Alinery"))
    }
}

/// Isolated OMP HOME under the app-config parent (not `~/.omp`).
/// Returns `(PI_CODING_AGENT_DIR, PI_CONFIG_DIR)`.
pub fn omp_home_dirs(app_config: &Path) -> (PathBuf, PathBuf) {
    let omp_root = app_config.parent().unwrap_or(app_config).join("omp");
    let config_root = omp_root.join("config");
    let agent_dir = config_root.join("agent");
    (agent_dir, config_root)
}

/// The only variables an isolated OMP child inherits from the daemon's own environment.
///
/// Everything outside this list is dropped, because "a fresh install starts un-authenticated" and
/// "inherits whatever the launching shell exported" cannot both be true: OMP reads provider
/// credentials from env vars as readily as from its credential store, so one exported key silently
/// authenticates an instance that owns an empty store — and nothing in the UI would disagree.
///
/// So the list carries only what a coding agent cannot work without and what is not a credential:
/// locale and temp so tools behave, the ssh agent socket so git over ssh keeps working, and proxy
/// settings so a machine behind one can still reach an API. `PATH`, `TERM`, and every `ALINERY_*`
/// / `PI_*` var are set explicitly at spawn and do not belong here.
///
/// A key that genuinely must be injected goes in the harness row's `env` map, which is applied
/// after this and therefore still wins — explicit, per-install, and visible in config.
pub const OMP_ENV_ALLOWLIST: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TZ",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SSH_AUTH_SOCK",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
];

/// The allowlisted variables that are actually set, ready to re-apply after an `env_clear()`.
pub fn omp_inherited_env() -> Vec<(&'static str, String)> {
    OMP_ENV_ALLOWLIST.iter().filter_map(|key| std::env::var(key).ok().map(|value| (*key, value))).collect()
}

/// Packaged OMP binary: `ALINERY_OMP_PATH` override → install-root sibling →
/// default alongside dir. Fail-closed; never PATH search.
pub fn resolve_packaged_omp_path() -> Result<PathBuf, String> {
    let path = match std::env::var("ALINERY_OMP_PATH") {
        Ok(value) if !value.is_empty() => PathBuf::from(value),
        _ => match std::env::current_exe() {
            Ok(exe) => match containing_install_root(&exe) {
                Some(root) => omp_binary_path(&omp_alongside_dir(&root)),
                None => omp_binary_path(&default_omp_alongside_dir()),
            },
            Err(_) => omp_binary_path(&default_omp_alongside_dir()),
        },
    };
    if path.is_file() {
        Ok(path)
    } else {
        // Naming the fix here is worth more than the doc that also describes it: this is the
        // string a dev sees the first time a session refuses to start, and "not found" on its own
        // does not even say where it looked.
        Err(format!(
            "bundled OMP not found at {} — from a checkout run scripts/dev-fetch-omp.sh; in an installed app, reinstall Alinery",
            path.display()
        ))
    }
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
    fn omp_alongside_dir_macos_app() {
        assert_eq!(omp_alongside_dir(Path::new("/Applications/Alinery.app")), PathBuf::from("/Applications/Alinery.omp"));
    }

    #[test]
    fn omp_alongside_dir_linux_prefix() {
        assert_eq!(
            omp_alongside_dir(Path::new("/home/u/.local/share/alinery/Alinery")),
            PathBuf::from("/home/u/.local/share/alinery/omp")
        );
    }

    #[test]
    fn omp_binary_path_joins_omp() {
        assert_eq!(omp_binary_path(Path::new("/Applications/Alinery.omp")), PathBuf::from("/Applications/Alinery.omp/omp"));
    }

    #[test]
    fn default_omp_alongside_dir_matches_install_default() {
        #[cfg(target_os = "macos")]
        assert_eq!(default_omp_alongside_dir(), PathBuf::from("/Applications/Alinery.omp"));
        #[cfg(not(target_os = "macos"))]
        {
            let home = dirs::home_dir().expect("HOME");
            assert_eq!(default_omp_alongside_dir(), home.join(".local/share/alinery/omp"));
        }
    }

    #[test]
    fn omp_home_dirs_are_under_app_config_parent_omp() {
        let (agent, config_root) = omp_home_dirs(Path::new("/tmp/id/app.toml"));
        assert_eq!(agent, PathBuf::from("/tmp/id/omp/config/agent"));
        assert_eq!(config_root, PathBuf::from("/tmp/id/omp/config"));
        assert!(agent.starts_with("/tmp/id/omp"));
        assert!(config_root.starts_with("/tmp/id/omp"));
        assert!(!agent.starts_with(std::env::var_os("HOME").unwrap_or_default()));
    }

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct OmpPathEnvGuard {
        prev: Option<std::ffi::OsString>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }
    impl OmpPathEnvGuard {
        fn set(value: Option<&str>) -> Self {
            let lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let prev = std::env::var_os("ALINERY_OMP_PATH");
            match value {
                Some(v) => std::env::set_var("ALINERY_OMP_PATH", v),
                None => std::env::remove_var("ALINERY_OMP_PATH"),
            }
            Self { prev, _lock: lock }
        }
    }
    impl Drop for OmpPathEnvGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var("ALINERY_OMP_PATH", v),
                None => std::env::remove_var("ALINERY_OMP_PATH"),
            }
        }
    }

    #[test]
    fn resolve_packaged_omp_path_env_present() {
        let path = std::env::temp_dir().join(format!("alinery-omp-present-{}", std::process::id()));
        std::fs::write(&path, b"omp-fixture").unwrap();
        let _guard = OmpPathEnvGuard::set(Some(path.to_str().unwrap()));
        let got = resolve_packaged_omp_path().expect("present override");
        let _ = std::fs::remove_file(&path);
        assert_eq!(got, path);
        assert_ne!(got.as_os_str(), "omp");
    }

    #[test]
    fn resolve_packaged_omp_path_env_absent_file() {
        let missing = format!("/no/such/alinery-omp-{}", std::process::id());
        let _guard = OmpPathEnvGuard::set(Some(&missing));
        let err = resolve_packaged_omp_path().expect_err("missing override");
        assert!(err.contains("bundled OMP not found at"), "{err}");
        assert!(err.contains(&missing), "{err}");
    }

    #[test]
    fn resolve_packaged_omp_path_never_path_search() {
        let _guard = OmpPathEnvGuard::set(None);
        // Dev machines may already have `scripts/dev-fetch-omp.sh` output; CI usually
        // does not. Either way the resolver must not fall through to the PATH name `omp`.
        match resolve_packaged_omp_path() {
            Ok(path) => {
                assert!(path.is_absolute(), "{}", path.display());
                assert_ne!(path.as_os_str(), "omp");
                assert!(path.is_file(), "{}", path.display());
            }
            Err(err) => {
                assert!(err.contains("bundled OMP not found at"), "{err}");
                let path = err.rsplit_once(" at ").map(|(_, p)| p).unwrap_or(&err);
                assert!(path.starts_with('/'), "{err}");
                assert_ne!(path, "omp");
            }
        }
    }
}
