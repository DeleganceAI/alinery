//! backup: the shell's half. The daemon creates, lists, verifies and prunes backups and runs the automatic triggers
//! (`BackupService`, `JobService.StartBackup`); what stays here is the folder picker and the one step that must happen
//! while no daemon runs: restore (plan 2.3.5, S4.9).
use crate::*;

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

pub(crate) fn require_restore_authority(state: &AppState, repo: &Path, known: &[String]) -> Result<(), String> {
    if state.is_quitting() {
        return Err("application is quitting; restore cancelled".into());
    }
    validate_known_target_repo(known, &repo.display().to_string())?;
    require_repo_owned(state, repo)
}

/// Restore a remote repo from an archive on its host: the host extracts it while its daemon is stopped, then the daemon
/// is started again. The page has already asked the daemon to verify the archive (`BackupService.VerifyBackup`); the host
/// checks it once more here so that a refused archive costs no live session. Both stay repo-service ops until S5.2.
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
        HostOp::BackupVerify {
            repo: repo.clone(),
            backup_path: backup_path.clone(),
        },
    )?;
    // DELIBERATE TEARDOWN ORIGIN: the confirmed restore ends the host's daemon (its sessions hold
    // the data being replaced), restores, and starts the daemon again.
    stop_remote_daemon(app, host_id, path, |state, _| {
        remote_call_within::<Value>(state, host_id, HostOp::BackupRestore { repo, backup_path }, BACKUP_TIMEOUT).map(|_| ())
    })
}

/// What the daemon program printed for `--restore-backup`: one JSON line, `{"result": ...}` or `{"error": "..."}`.
pub(crate) fn restore_outcome(success: bool, stdout: &str, stderr: &str) -> Result<(), String> {
    let line = stdout.lines().rev().find_map(|l| serde_json::from_str::<Value>(l.trim()).ok().filter(Value::is_object));
    match line {
        Some(v) if v.get("error").is_some() => Err(v["error"].as_str().unwrap_or("restore failed").to_string()),
        Some(v) if v.get("result").is_some() && success => Ok(()),
        _ => Err(format!(
            "restore did not finish: {}",
            stderr.trim().lines().last().unwrap_or("the daemon program printed no result")
        )),
    }
}

/// The restore itself, run by the daemon program (`--restore-backup <repo> <archive>`) while no daemon runs: it unpacks into
/// a new directory under `.alinery/tmp` and renames it into place (plan 2.3.5, O11).
fn restore_with_daemon_program(repo: &Path, zip: &Path) -> Result<(), String> {
    let program = resolve_alineryd_path().ok_or("the daemon program was not found; restore cancelled")?;
    let out = Command::new(program)
        .arg("--restore-backup")
        .arg(repo)
        .arg(zip)
        .output()
        .map_err(|error| format!("could not run the restore: {error}"))?;
    restore_outcome(out.status.success(), &String::from_utf8_lossy(&out.stdout), &String::from_utf8_lossy(&out.stderr))
}

/// Destructive, and confirmed in the UI before it gets here (the page has verified the archive through the daemon): stop the
/// daemon (its ptys and MCP child hold the data we are about to replace), then restore. Worktrees, locks, and sockets are
/// deliberately left alone.
#[tauri::command]
pub(crate) async fn restore_backup(app: AppHandle, repo_path: Option<String>, backup_path: String) -> Result<(), String> {
    let target = target_or_active_ref(&app, repo_path)?;
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
    alinery_core::require_backup_matches_repo(&repo, &zip)?;
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
            shutdown_daemon(
                &repo.display().to_string(),
                &app_config_path(&worker_app)?,
                alineryd_socket_namespace().as_deref(),
                ShutdownOrigin::RestoreBackup,
                "",
                None,
                || daemon.call(&daemon_client::shutdown_request()).map(|_| ()),
            )
            .map_err(|error| format!("could not stop daemon before restore: {error}"))?;
            daemon_client::wait_for_daemon_gone(&repo, alineryd_socket_namespace().as_deref().unwrap_or(""))
                .map_err(|error| format!("{error}; restore aborted so live sessions cannot write over the archive"))?;
        }
        state.clear_daemon(&repo);
        restore_with_daemon_program(&repo, &zip)
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
