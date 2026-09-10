//! backup: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

// ---- Backup (issue #79) ------------------------------------------------------
// The zip/list/prune/extract mechanics live in alinery-core. The app owns repo resolution,
// settings resolution, and the one genuinely destructive step: restore, which stops the
// daemon and clears the curated set before extracting.

/// Stamped into every archive filename and meta so a restored zip names the build that
/// wrote it. alinery-core takes this from the caller so app and MCP report their own version.
pub(crate) const BACKUP_ALINERY_VERSION: &str = env!("CARGO_PKG_VERSION");

pub(crate) fn backup_repo_for(app: &AppHandle, repo_path: Option<String>) -> Result<PathBuf, String> {
    match repo_path {
        Some(path) => target_repo_for_app(app, &path),
        None => active_repo(),
    }
}

pub(crate) fn backup_settings_for(app: &AppHandle, repo: &Path) -> Result<alinery_core::BackupDefaults, String> {
    Ok(load_config_with_app_path(&app_config_path(app)?, repo).backup)
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
/// (a symlink, a trailing slash) shares one slot rather than looking like two idle repos.
pub(crate) fn backup_key(repo: &Path) -> Result<String, String> {
    Ok(fs::canonicalize(repo)
        .map_err(|e| format!("resolve {}: {e}", repo.display()))?
        .to_string_lossy()
        .to_string())
}

/// Enqueue an automatic backup. Never fails the caller: an unconfigured feature, a disabled
/// trigger, or an unusable destination is simply a no-op.
pub(crate) fn publish_auto_backup(app: &AppHandle, repo: &Path, trigger: alinery_core::BackupTrigger) {
    let Ok(settings) = backup_settings_for(app, repo) else {
        return;
    };
    if !backup_queue::should_publish(&settings, repo, trigger) {
        return;
    }
    let Ok(key) = backup_key(repo) else {
        return;
    };
    let _ = BACKUP_APP.set(app.clone());
    backup_queue_lock().publish(&key, trigger, Instant::now());
    LazyLock::force(&BACKUP_WORKER);
}

pub(crate) fn run_queued_backup(key: &str, trigger: alinery_core::BackupTrigger) {
    let repo = PathBuf::from(key);
    // Settings are re-read per run: the user may have changed the destination or turned the
    // feature off during the debounce window.
    let Some(app) = BACKUP_APP.get() else {
        return;
    };
    let settings = backup_settings_for(app, &repo).unwrap_or_default();
    if !alinery_core::backup_feature_ready(&settings, &repo) {
        return;
    }
    match alinery_core::create_backup(&repo, &settings, trigger, BACKUP_ALINERY_VERSION) {
        Ok(_) => {
            emit(
                app,
                alinery_core::TelemetryEvent::BackupCreate {
                    source: alinery_core::TelemetrySource::App,
                    trigger,
                },
            );
        }
        Err(e) => {
            if let Some(app) = BACKUP_APP.get() {
                fire_app_notification(app, &format!("Backup failed — {e}"));
            }
        }
    }
}

/// Remove exactly what `create_backup` archives — no more. Anything cleared here but not
/// archived there is data the user loses on restore, so both read `CURATED_ALINERY_PATHS`.
/// Missing paths are not an error: a repo may never have had a `playbooks.toml`.
pub(crate) fn clear_curated_alinery_data(repo: &Path) -> Result<(), String> {
    let alinery = alinery_dir(repo);
    for name in alinery_core::CURATED_ALINERY_PATHS {
        let path = alinery.join(name);
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        let removed = if meta.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
        removed.map_err(|e| format!("clear {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Validate → clear → extract. Stopping the daemon is the command's job (it owns AppState);
/// keeping that out of here is what makes the destructive half unit-testable.
pub(crate) fn restore_backup_into(repo: &Path, backup_path: &Path) -> Result<(), String> {
    // Identity first. A mismatched archive must cost the user nothing.
    require_backup_matches_repo(repo, backup_path)?;
    clear_curated_alinery_data(repo)?;
    alinery_core::extract_backup_into(backup_path, &alinery_dir(repo), Some(repo)).map(|_| ())
}

pub(crate) fn require_backup_matches_repo(repo: &Path, backup_path: &Path) -> Result<(), String> {
    let meta = alinery_core::read_backup_meta(backup_path)?;
    let expected = fs::canonicalize(repo)
        .map_err(|e| format!("resolve {}: {e}", repo.display()))?
        .to_string_lossy()
        .to_string();
    if meta.repo_path != expected {
        return Err(format!("this backup belongs to {}, not {expected}", meta.repo_path));
    }
    Ok(())
}

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
    let repo = backup_repo_for(&app, repo_path)?;
    let settings = backup_settings_for(&app, &repo)?;
    let _slot = BackupSlot::claim(backup_key(&repo)?).ok_or("a backup for this repository is already running")?;
    let result = tauri::async_runtime::spawn_blocking(move || backup_now_with(&repo, &settings)).await;
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
    let repo = backup_repo_for(&app, repo_path)?;
    Ok(backup_queue_lock().busy(&backup_key(&repo)?))
}

#[tauri::command]
pub(crate) fn list_backups(app: AppHandle, repo_path: Option<String>) -> Result<Vec<alinery_core::BackupListItem>, String> {
    let repo = backup_repo_for(&app, repo_path)?;
    let settings = backup_settings_for(&app, &repo)?;
    alinery_core::list_backups(&repo, &settings)
}

/// Destructive, and confirmed in the UI before it gets here: stop the daemon (its ptys and
/// MCP child hold the data we are about to replace), clear the curated set, extract.
/// Worktrees, locks, and sockets are deliberately left alone.
#[tauri::command]
pub(crate) async fn restore_backup(app: AppHandle, state: State<'_, AppState>, repo_path: Option<String>, backup_path: String) -> Result<(), String> {
    let repo = backup_repo_for(&app, repo_path)?;
    let zip = PathBuf::from(&backup_path);
    // Reject a foreign archive while the repo is still intact and the daemon still up.
    require_backup_matches_repo(&repo, &zip)?;
    // Same slot as a backup: an auto zip firing mid-restore would archive half-cleared data.
    // Guard, not a manual finish: every `?` below must release the slot (see BackupSlot).
    let _slot = BackupSlot::claim(backup_key(&repo)?).ok_or("a backup or restore for this repository is already running")?;
    // DELIBERATE TEARDOWN ORIGIN (destructive restore, confirmed in the UI before it gets
    // here). Unlike B1's stop-all this must NOT restart the daemon: a live daemon would
    // hold the very data we are about to replace.
    //
    // Teardown from the SOCKET, not only the Connected map entry: Conflicted and
    // uncached-but-live daemons still write storage. Abort restore if anything still
    // answers after shutdown+wait — leave backup queue slot + on-disk data untouched.
    require_repo_owned(&state, &repo)?;
    let is_active_mcp = active_repo().ok().as_deref() == Some(repo.as_path());
    if is_active_mcp {
        state.kill_mcp();
    }
    if let Ok(daemon) = DaemonClient::connect_path_checked(current_alineryd_socket_path(&repo)) {
        daemon
            .call(&daemon_client::shutdown_request())
            .map_err(|e| format!("could not stop daemon before restore: {e}"))?;
        wait_for_daemon_gone(&repo).map_err(|e| format!("{e}; restore aborted so live sessions cannot write over the archive"))?;
    }
    state.clear_daemon(&repo);
    // Clear + extract is as slow as the zip: blocking pool, same reason as backup_now.
    let result = tauri::async_runtime::spawn_blocking(move || restore_backup_into(&repo, &zip)).await;
    result.map_err(|e| format!("restore task: {e}"))??;
    emit(
        &app,
        alinery_core::TelemetryEvent::BackupRestore {
            source: alinery_core::TelemetrySource::App,
        },
    );
    Ok(())
}
