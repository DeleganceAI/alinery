//! backup: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

// ---- Backup (issue #79) ------------------------------------------------------
// The zip/list/prune/extract mechanics live in alinery-core. The app owns repo resolution,
// settings resolution, and the one genuinely destructive step: restore, which stops the
// daemon and clears the curated set before extracting.

/// Stamped into every archive filename and meta so a restored zip names the build that
/// wrote it. alinery-core takes this from the caller so app and MCP report their own version.
pub(crate) const BACKUP_ALINERY_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The backup settings of a local repo. A remote repo's live on its host, which applies them itself
/// (`RepoOp::BackupCreate`, `BackupList`): the Mac's destination folder means nothing there.
pub(crate) fn backup_settings_for(app: &AppHandle, repo: &Path) -> Result<alinery_core::BackupDefaults, String> {
    Ok(load_config_with_app_path(&app_config_path(app)?, repo).backup)
}

/// A backup or listing on a remote repo, run by its host with the settings in force there.
pub(crate) fn host_backup<T: serde::de::DeserializeOwned>(state: &AppState, host_id: &str, path: &str, op: impl FnOnce(PathBuf, PathBuf) -> RepoOp) -> Result<T, String> {
    let op = op(path.into(), host_app_config(state, host_id)?);
    remote_call_within(state, host_id, op, BACKUP_TIMEOUT)
}

/// The repo a backup command is about: the explicit key if given, otherwise the active repo.
fn backup_target(app: &AppHandle, repo_path: Option<String>) -> Result<RepoRef, String> {
    target_or_active_ref(app, repo_path)
}

/// The queue slot of a repo: the canonical path of a local one, the stored URI of a remote one.
fn backup_slot_key(target: &RepoRef) -> Result<String, String> {
    match target {
        RepoRef::Local(repo) => backup_key(repo),
        remote => Ok(remote.uri()),
    }
}

// ---- Auto-backup trigger path ------------------------------------------------
// Archive/commit/push/artifact-save publish here and return immediately. One worker thread
// drains the coalescing queue, so a burst costs at most two zips and a failing backup can
// never fail the action that triggered it.

pub(crate) static BACKUP_QUEUE: LazyLock<Mutex<backup_queue::BackupQueue>> = LazyLock::new(|| Mutex::new(backup_queue::BackupQueue::new()));
/// Captured on the first publish so the worker can resolve settings and raise notifications
/// without an `AppHandle` threaded through every pure write helper.
pub(crate) static BACKUP_APP: OnceLock<AppHandle> = OnceLock::new();
/// The drain thread. `LazyLock` so the initializer lives with the static and the thread is
/// spawned exactly once, on the first publish that survives the gate.
pub(crate) static BACKUP_WORKER: LazyLock<()> = LazyLock::new(|| {
    std::thread::spawn(|| loop {
        std::thread::sleep(BACKUP_POLL);
        let Some((key, trigger)) = backup_queue_lock().take_ready(Instant::now()) else {
            continue;
        };
        run_queued_backup(&key, trigger);
        backup_queue_lock().finish(&key);
    });
});

/// How often the worker checks for a request past its debounce deadline.
pub(crate) const BACKUP_POLL: Duration = Duration::from_millis(250);

pub(crate) fn backup_queue_lock() -> std::sync::MutexGuard<'static, backup_queue::BackupQueue> {
    BACKUP_QUEUE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Queue key for a repo: the canonical path, so the same repo reached by two different paths
/// (a symlink, a trailing slash) shares one slot rather than looking like two idle repos. A remote
/// repo's key is its stored `alinery+ssh://` entry: there is no local path to resolve.
pub(crate) fn backup_key(repo: &Path) -> Result<String, String> {
    if is_remote_repo_key(&repo.to_string_lossy()) {
        return Ok(repo.to_string_lossy().into_owned());
    }
    Ok(fs::canonicalize(repo)
        .map_err(|e| format!("resolve {}: {e}", repo.display()))?
        .to_string_lossy()
        .to_string())
}

/// Enqueue an automatic backup. Never fails the caller: an unconfigured feature, a disabled
/// trigger, or an unusable destination is simply a no-op. A remote repo's settings are on its
/// host, so the host applies the gate when the queued backup runs, not here.
pub(crate) fn publish_auto_backup(app: &AppHandle, repo: &Path, trigger: alinery_core::BackupTrigger) {
    if !is_remote_repo_key(&repo.to_string_lossy()) {
        let Ok(settings) = backup_settings_for(app, repo) else {
            return;
        };
        if !backup_queue::should_publish(&settings, repo, trigger) {
            return;
        }
    }
    let Ok(key) = backup_key(repo) else {
        return;
    };
    let _ = BACKUP_APP.set(app.clone());
    backup_queue_lock().publish(&key, trigger, Instant::now());
    LazyLock::force(&BACKUP_WORKER);
}

/// `publish_auto_backup` for a repo on a host, as the trigger sites hold it (host id and path).
pub(crate) fn publish_remote_backup(app: &AppHandle, host_id: &str, path: &str, trigger: alinery_core::BackupTrigger) {
    let key = RepoRef::Remote {
        host_id: host_id.to_string(),
        path: path.to_string(),
    }
    .uri();
    publish_auto_backup(app, Path::new(&key), trigger);
}

/// A queued automatic backup of a remote repo: the host checks its own settings and either skips
/// (`None`) or writes the archive on its disk.
pub(crate) fn create_queued_remote_backup<R: tauri::Runtime>(
    app: &AppHandle<R>,
    key: &str,
    trigger: alinery_core::BackupTrigger,
) -> Result<Option<alinery_core::BackupMeta>, String> {
    let RepoRef::Remote { host_id, path } = RepoRef::parse(key)? else {
        return Err(format!("not a remote repository: {key}"));
    };
    host_backup(&app.state::<AppState>(), &host_id, &path, |repo, app_config| RepoOp::BackupCreate {
        repo,
        app_config,
        trigger,
    })
}

/// A queued automatic backup of a local repo, or `None` when its feature is not usable now.
fn create_queued_local_backup(app: &AppHandle, key: &str, trigger: alinery_core::BackupTrigger) -> Result<Option<alinery_core::BackupMeta>, String> {
    let repo = PathBuf::from(key);
    // Settings are re-read per run: the user may have changed the destination or turned the
    // feature off during the debounce window.
    let settings = backup_settings_for(app, &repo).unwrap_or_default();
    if !alinery_core::backup_feature_ready(&settings, &repo) {
        return Ok(None);
    }
    alinery_core::create_backup(&repo, &settings, trigger, BACKUP_ALINERY_VERSION).map(Some)
}

pub(crate) fn run_queued_backup(key: &str, trigger: alinery_core::BackupTrigger) {
    let Some(app) = BACKUP_APP.get() else {
        return;
    };
    let created = if is_remote_repo_key(key) {
        create_queued_remote_backup(app, key, trigger)
    } else {
        create_queued_local_backup(app, key, trigger)
    };
    match created {
        Ok(Some(_)) => {
            emit(
                app,
                alinery_core::TelemetryEvent::BackupCreate {
                    source: alinery_core::TelemetrySource::App,
                    trigger,
                },
            );
        }
        Ok(None) => {}
        Err(e) => fire_app_notification(app, &format!("Backup failed — {e}")),
    }
}

// The destructive half of restore (clear the curated set, extract) is in alinery-core so a remote
// host runs the same code; stopping the daemon first is the command's job (it owns AppState).
#[cfg(test)]
pub(crate) use alinery_core::clear_curated_alinery_data;
pub(crate) use alinery_core::{require_backup_matches_repo, restore_backup_into};

/// Finder folder picker for the backup destination. Validated here so an unusable folder
/// is rejected at pick time rather than at the first backup.
#[tauri::command]
pub(crate) async fn pick_backup_destination_dialog(app: AppHandle, repo_path: String) -> Result<Option<String>, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    let Some(folder) = app.dialog().file().set_title("Choose a backup destination").blocking_pick_folder() else {
        return Ok(None);
    };
    let picked = folder.into_path().map_err(|e| e.to_string())?;
    let validated = alinery_core::validate_backup_destination(&repo, &picked)?;
    Ok(Some(validated.to_string_lossy().to_string()))
}

/// The app's create policy in one testable place: manual trigger, app crate version.
pub(crate) fn backup_now_with(repo: &Path, settings: &alinery_core::BackupDefaults) -> Result<alinery_core::BackupMeta, String> {
    alinery_core::create_backup(repo, settings, alinery_core::BackupTrigger::Manual, BACKUP_ALINERY_VERSION)
}

/// Holds a per-repo backup/restore slot for a scope, releasing it on **every** exit path.
///
/// `begin` refuses a second claim, so a `?` that returns between `begin` and `finish`
/// wedges that repo's slot for the life of the process: no restore, no manual backup, no
/// auto backup, and `backup_busy` stuck at true. `restore_backup` grew two such early
/// returns (ownership refusal and a failed `shutdown` call); a guard makes the leak
/// unrepresentable instead of asking every future branch to remember.
pub(crate) struct BackupSlot(pub(crate) String);

impl BackupSlot {
    /// `None` when another backup/restore already holds this repo's slot.
    pub(crate) fn claim(key: String) -> Option<Self> {
        backup_queue_lock().begin(&key).then(|| BackupSlot(key))
    }
}

impl Drop for BackupSlot {
    fn drop(&mut self) {
        backup_queue_lock().finish(&self.0);
    }
}

/// Manual BACKUP NOW: zipping a real `.alinery` takes seconds, and a non-async command body runs
/// on the main thread — which is a frozen window and a spinning cursor, not a busy button. The
/// zip goes to the blocking pool and the command awaits it, so the button still reports the
/// real meta or the real error. Auto triggers go through the coalescing queue instead — but the
/// run is registered in the same per-repo slot, so `backup_busy` answers for both and the auto
/// worker can't start a second zip on top of this one.
#[tauri::command]
pub(crate) async fn backup_now(app: AppHandle, repo_path: Option<String>) -> Result<alinery_core::BackupMeta, String> {
    let target = backup_target(&app, repo_path)?;
    let _slot = BackupSlot::claim(backup_slot_key(&target)?).ok_or("a backup for this repository is already running")?;
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || match target {
        RepoRef::Local(repo) => backup_now_with(&repo, &backup_settings_for(&worker_app, &repo)?),
        // The archive is written on the host, to the destination its own config names.
        RepoRef::Remote { host_id, path } => host_backup(&worker_app.state::<AppState>(), &host_id, &path, |repo, app_config| RepoOp::BackupCreate {
            repo,
            app_config,
            trigger: alinery_core::BackupTrigger::Manual,
        }),
    })
    .await;
    let meta = result.map_err(|e| format!("backup task: {e}"))??;
    emit(
        &app,
        alinery_core::TelemetryEvent::BackupCreate {
            source: alinery_core::TelemetrySource::App,
            trigger: alinery_core::BackupTrigger::Manual,
        },
    );
    Ok(meta)
}

/// Is a backup or restore running for this repo? The Backup view polls this because it cannot
/// know from component state: the work lives in the backend and outlives the view, so leaving
/// the page and coming back must still show a run — including one started by a trigger.
#[tauri::command]
pub(crate) fn backup_busy(app: AppHandle, repo_path: Option<String>) -> Result<bool, String> {
    let target = backup_target(&app, repo_path)?;
    Ok(backup_queue_lock().busy(&backup_slot_key(&target)?))
}

#[tauri::command]
pub(crate) async fn list_backups(app: AppHandle, repo_path: Option<String>) -> Result<Vec<alinery_core::BackupListItem>, String> {
    let target = backup_target(&app, repo_path)?;
    tauri::async_runtime::spawn_blocking(move || match target {
        RepoRef::Local(repo) => alinery_core::list_backups(&repo, &backup_settings_for(&app, &repo)?),
        RepoRef::Remote { host_id, path } => host_backup(&app.state::<AppState>(), &host_id, &path, |repo, app_config| RepoOp::BackupList { repo, app_config }),
    })
    .await
    .map_err(|error| format!("list backups task: {error}"))?
}

/// Is `destination` somewhere this repo may write backups? Run where the repo lives: a remote
/// repo's destination is a folder on its host, which the Mac's file picker cannot browse.
#[tauri::command]
pub(crate) async fn check_backup_destination(app: AppHandle, repo_path: Option<String>, destination: String) -> Result<String, String> {
    let target = backup_target(&app, repo_path)?;
    tauri::async_runtime::spawn_blocking(move || match target {
        RepoRef::Local(repo) => Ok(alinery_core::validate_backup_destination(&repo, Path::new(&destination))?.to_string_lossy().into_owned()),
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::BackupCheckDestination {
                repo: path.into(),
                destination: destination.into(),
            },
        ),
    })
    .await
    .map_err(|error| format!("check destination task: {error}"))?
}

pub(crate) fn require_restore_authority(state: &AppState, repo: &Path, known: &[String]) -> Result<(), String> {
    if state.is_quitting() {
        return Err("application is quitting; restore cancelled".into());
    }
    validate_known_target_repo(known, &repo.display().to_string())?;
    require_repo_owned(state, repo)
}

/// Restore a remote repo from an archive on its host: the host extracts it while its daemon is
/// stopped, then the daemon is started again.
pub(crate) fn restore_remote_backup<R: tauri::Runtime>(app: &AppHandle<R>, host_id: &str, path: &str, backup_path: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    if state.is_quitting() {
        return Err("application is quitting; restore cancelled".into());
    }
    let repo = PathBuf::from(path);
    let backup_path = PathBuf::from(backup_path);
    // Reject a foreign archive while the repo is still intact and the daemon still up.
    remote_call::<Value>(
        &state,
        host_id,
        RepoOp::BackupVerify {
            repo: repo.clone(),
            backup_path: backup_path.clone(),
        },
    )?;
    // DELIBERATE TEARDOWN ORIGIN: the confirmed restore ends the host's daemon (its sessions hold
    // the data being replaced), restores, and starts the daemon again.
    stop_remote_daemon(app, host_id, path, |state, _| {
        remote_call_within::<Value>(state, host_id, RepoOp::BackupRestore { repo, backup_path }, BACKUP_TIMEOUT).map(|_| ())
    })
}

/// Destructive, and confirmed in the UI before it gets here: stop the daemon (its ptys and
/// MCP child hold the data we are about to replace), clear the curated set, extract.
/// Worktrees, locks, and sockets are deliberately left alone.
#[tauri::command]
pub(crate) async fn restore_backup(app: AppHandle, repo_path: Option<String>, backup_path: String) -> Result<(), String> {
    let target = backup_target(&app, repo_path)?;
    // Same slot as a backup: an auto zip firing mid-restore would archive half-cleared data.
    // Guard, not a manual finish: every `?` below must release the slot (see BackupSlot).
    let _slot = BackupSlot::claim(backup_slot_key(&target)?).ok_or("a backup or restore for this repository is already running")?;
    let worker_app = app.clone();
    let repo = match target {
        RepoRef::Local(repo) => repo,
        RepoRef::Remote { host_id, path } => {
            tauri::async_runtime::spawn_blocking(move || restore_remote_backup(&worker_app, &host_id, &path, &backup_path))
                .await
                .map_err(|error| format!("restore task: {error}"))??;
            emit(
                &app,
                alinery_core::TelemetryEvent::BackupRestore {
                    source: alinery_core::TelemetrySource::App,
                },
            );
            return Ok(());
        }
    };
    let zip = PathBuf::from(&backup_path);
    // Reject a foreign archive while the repo is still intact and the daemon still up.
    require_backup_matches_repo(&repo, &zip)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = worker_app.state::<AppState>();
        let _closing = state.mark_closing(&repo);
        let lifecycle = state.repo_lifecycle(&repo);
        let _guard = lifecycle.lock().unwrap_or_else(|error| error.into_inner());
        require_restore_authority(&state, &repo, &load_app_config(&worker_app).known_repos)?;
        if active_repo().ok().as_deref() == Some(repo.as_path()) {
            state.kill_mcp_for_repo(&repo);
        }
        // DELIBERATE TEARDOWN ORIGIN: confirmed restore holds lifecycle ordering
        // through extraction, so no queued attach can publish against half-restored data.
        if let Ok(daemon) = DaemonClient::connect_path_checked(current_alineryd_socket_path(&repo)) {
            daemon
                .call(&daemon_client::shutdown_request())
                .map_err(|error| format!("could not stop daemon before restore: {error}"))?;
            daemon_client::wait_for_daemon_gone(&repo, alineryd_socket_namespace().as_deref().unwrap_or(""))
                .map_err(|error| format!("{error}; restore aborted so live sessions cannot write over the archive"))?;
        }
        state.clear_daemon(&repo);
        restore_backup_into(&repo, &zip)
    })
    .await
    .map_err(|error| format!("restore task: {error}"))??;
    emit(
        &app,
        alinery_core::TelemetryEvent::BackupRestore {
            source: alinery_core::TelemetrySource::App,
        },
    );
    Ok(())
}
