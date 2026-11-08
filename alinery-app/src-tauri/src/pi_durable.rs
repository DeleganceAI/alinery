//! Starting Vinculum.
//!
//! The binary beside the app is `alinery-vinculum-daemon`; it listens on `rpc[-ns].sock`. Keeping one running per repo is the
//! poller's job (`daemon::spawn_daemon_poller`), which calls this when nothing answers. Nothing here starts release `alineryd`.

use std::path::{Path, PathBuf};

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
    let spawned = daemon_command(
        &binary,
        repo,
        app_config,
        binary.file_name().unwrap_or_default(),
        namespace.as_deref(),
        host_executable.as_deref(),
        Some(&handoff),
    )
    .spawn();
    match spawned {
        Ok(_) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_file(&handoff);
            Err(format!("spawn {}: {error}", binary.display()))
        }
    }
}
