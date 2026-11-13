//! Starting Vinculum.
//!
//! The binary beside the app is `alinery-vinculum-daemon`; it listens on `rpc[-ns].sock`. Keeping one running per repo is the
//! poller's job (`daemon::spawn_daemon_poller`), which calls this when nothing answers. Nothing here starts release `alineryd`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use alinery_core::daemon_command;

use crate::daemon::{alineryd_socket_namespace, canonical_host_executable, new_rpc_secret, store_pending_rpc_secret, write_rpc_secret_handoff};

pub(crate) fn resolve_alongside(name: &str) -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let directory = executable.parent()?;
    let candidate = directory.join(name);
    candidate.is_file().then_some(candidate)
}

/// Start a daemon for `repo` and return; the caller waits for it to answer `Hello`.
pub(crate) fn start_daemon(repo: &Path, app_config: &Path) -> Result<(), String> {
    // The file whose content the build id hashes, so the daemon started is the one the app compares against (and `cargo test` finds it).
    let binary = alinery_core::resolve_alineryd_path().ok_or("alinery-vinculum-daemon binary not found beside the app")?;
    let namespace = alineryd_socket_namespace();
    let host_executable = canonical_host_executable(std::env::current_exe());
    // The token is kept before the daemon exists, as for a remote daemon, so a started daemon never
    // lacks its copy. The daemon deletes the hand-off file once it has read it.
    let secret = new_rpc_secret()?;
    store_pending_rpc_secret(
        alinery_core::app_config_dir_of(app_config).ok_or("app config root unavailable")?,
        &repo.to_string_lossy(),
        namespace.as_deref().unwrap_or(""),
        &secret,
    )?;
    let handoff = write_rpc_secret_handoff(&secret)?;
    let mut command = daemon_command(
        &binary,
        repo,
        app_config,
        binary.file_name().unwrap_or_default(),
        namespace.as_deref(),
        host_executable.as_deref(),
        Some(&handoff),
    );
    if let Some(python) = local_python_home(app_config) {
        command.env("ALINERY_PYTHON_HOME", python);
    }
    let spawned = command.spawn();
    match spawned {
        Ok(_) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_file(&handoff);
            Err(format!("spawn {}: {error}", binary.display()))
        }
    }
}

/// Where the bundled runtimes are (`remote::bundled_runtime_dir`), set once at startup.
pub(crate) static RUNTIME_BUNDLE: OnceLock<PathBuf> = OnceLock::new();

/// The runtime triple of this machine, as `scripts/build-remote-runtimes.sh` names it.
pub(crate) fn local_triple() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-gnu"),
        ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu"),
        _ => None,
    }
}

/// The Python the office skills run on, for the local daemon: this machine's bundled runtime archive carries it, and it is
/// unpacked once per runtime into `<app config dir>/runtime/<hash>/python`, the layout an ssh host gets. Unpacked rather
/// than shipped loose in the app bundle, so the release signing never meets its thousands of files. None when this build
/// bundles no runtime (`cargo test`, a build without remote runtimes): agents then use whatever Python the machine has.
fn local_python_home(app_config: &Path) -> Option<PathBuf> {
    let bundle = RUNTIME_BUNDLE.get()?;
    let target = crate::remote::load_manifest(bundle).ok()?.targets.remove(local_triple()?)?;
    let root = alinery_core::app_config_dir_of(app_config)?.join("runtime");
    let dir = root.join(&target.runtime_hash);
    if !dir.join(".complete").is_file() {
        unpack_python(&bundle.join(&target.archive), &root, &dir)?;
    }
    Some(dir.join("python"))
}

pub(crate) fn unpack_python(archive: &Path, root: &Path, dir: &Path) -> Option<()> {
    // Two daemons can start at once: each unpacks into its own directory, and the rename that loses leaves the winner's.
    let tmp = root.join(format!(".unpack-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).ok()?;
    let unpacked = std::process::Command::new("tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(&tmp)
        .arg("python")
        .status()
        .is_ok_and(|status| status.success());
    if !unpacked || std::fs::write(tmp.join(".complete"), b"").is_err() || (std::fs::rename(&tmp, dir).is_err() && !dir.join(".complete").is_file()) {
        let _ = std::fs::remove_dir_all(&tmp);
        return None;
    }
    let _ = std::fs::remove_dir_all(&tmp);
    prune_runtimes(root, dir);
    Some(())
}

/// Keeps the new runtime and the newest older one. ponytail: a daemon still running from two or more updates ago loses its
/// Python; keep more, or count live daemons, if that ever bites.
fn prune_runtimes(root: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    let mut older: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path != keep && path.is_dir() && !path.file_name().is_some_and(|name| name.to_string_lossy().starts_with('.')))
        .map(|path| (path.metadata().and_then(|meta| meta.modified()).unwrap_or(std::time::UNIX_EPOCH), path))
        .collect();
    older.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    for (_, path) in older.into_iter().skip(1) {
        let _ = std::fs::remove_dir_all(path);
    }
}
