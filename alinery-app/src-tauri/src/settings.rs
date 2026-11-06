//! settings: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

// Bundled OMP launch config + compiled Terminal. Not a multi-harness picker registry.

// {binary} lands in command position inside a shell pipeline, and the path behind it comes
// from the environment (ALINERY_OMP_PATH) or the install location — either can hold spaces
// or shell syntax. Single-quote it so the shell sees exactly one word: inside '...' every
// character is literal, so only the closing quote itself needs the '\'' dance.
pub(crate) fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

// Model suggestions for a harness's picker: its static `models` plus, if the harness
// defines a `models_cmd`, whatever that command prints (one model per line). Never fails
// — a missing repo, unknown harness, or a failing/hanging command just yields the statics.
// ponytail: no timeout on models_cmd; a hung list command blocks this worker. The Tauri
// commands below run it off the webview thread. Add a timeout if that hang needs a bound.
pub(crate) fn list_harness_models_in(app_config: &Path, repo: &Path, harness: &str) -> Vec<String> {
    if !alinery_core::is_allowed_launch_harness(harness) || harness == alinery_core::NO_HARNESS_KEY {
        return vec![];
    }
    let Some(h) = alinery_core::resolve_harness_for(app_config, repo, harness) else {
        return vec![];
    };
    let mut out = h.models.clone();
    // models_cmd is a shell pipeline (each harness prints its own format, then greps/seds it
    // to one model per line) — run it through the user's login shell so pipes work AND PATH
    // additions from .zshrc/.zprofile are visible. A GUI-launched app inherits a bare PATH
    // (no ~/.local/bin, ~/.grok/bin, etc.), so plain `sh -c` silently can't find these CLIs.
    if !h.models_cmd.trim().is_empty() {
        let binary = if h.adapter == alinery_core::HarnessAdapter::Omp && h.binary == "omp" {
            match alinery_core::resolve_packaged_omp_path() {
                Ok(path) => path.to_string_lossy().into_owned(),
                Err(_) => return out,
            }
        } else {
            h.binary.clone()
        };
        let resolved_cmd = h.models_cmd.replace("{binary}", &shell_quote(&binary));
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        if let Ok(o) = Command::new(shell).arg("-ilc").arg(&resolved_cmd).output() {
            if o.status.success() {
                for line in String::from_utf8_lossy(&o.stdout).lines() {
                    let m = line.trim().to_string();
                    if !m.is_empty() && !out.contains(&m) {
                        out.push(m);
                    }
                }
            }
        }
    }
    out
}

/// True when Settings has a Grok key. The key itself stays out of this reply.
#[tauri::command]
pub(crate) fn grok_key_ready(app: AppHandle) -> bool {
    app_config_path(&app)
        .ok()
        .is_some_and(|path| !alinery_core::load_global_settings(&path).experiments.grok_api_key.trim().is_empty())
}

/// Models come from the harness binary on this machine. A remote repo has no overlay `harnesses.toml`
/// here, so it resolves against an empty directory and gets the bundled harness rows.
fn models_repo(target: &RepoRef) -> PathBuf {
    match target {
        RepoRef::Local(repo) => repo.clone(),
        RepoRef::Remote { .. } => PathBuf::from("/var/empty"),
    }
}

#[tauri::command]
pub(crate) async fn list_harness_models(app: AppHandle, harness: String) -> Vec<String> {
    // `models_cmd` is a login shell plus `omp models`. Never run that on the webview thread.
    tauri::async_runtime::spawn_blocking(move || match (active_repo_ref(), app_config_path(&app)) {
        (Ok(target), Ok(app_config)) => list_harness_models_in(&app_config, &models_repo(&target), &harness),
        _ => vec![],
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub(crate) async fn list_harness_models_for_repo(app: AppHandle, repo_path: String, harness: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(list_harness_models_in(
            &app_config_path(&app)?,
            &models_repo(&target_repo_ref_for_app(&app, &repo_path)?),
            &harness,
        ))
    })
    .await
    .map_err(|error| error.to_string())?
}

// ---- Scoped settings ----------------------------------------------------------
// Global settings live in app.toml. Repository config.toml is now a partial override
// layer: absent fields inherit, present blank strings are intentional values.
pub(crate) type Config = alinery_core::EffectiveConfig;

pub(crate) fn load_config_with_app_path(app_config: &Path, repo: &Path) -> Config {
    let global = alinery_core::load_global_settings(app_config);
    let overrides = alinery_core::load_repo_overrides(repo);
    alinery_core::resolve_effective_config(&global, &overrides)
}

/// The GitHub token in force for a remote repo: its host's `config.toml` override over this machine's global one.
/// The import itself runs here with this machine's credentials, so this is the one repo-settings read the shell keeps (S4.10).
pub(crate) fn remote_github_token(app_config: &Path, state: &AppState, host_id: &str, path: &Path) -> Result<String, String> {
    let overrides: alinery_core::RepoOverrides = remote_call(state, host_id, RepoOp::ReadRepoOverrides { repo: path.into() })?;
    Ok(alinery_core::scoped_settings_with(app_config, overrides)?.effective.github.token)
}

pub(crate) fn owned_active_target(state: &AppState) -> Result<RepoRef, String> {
    Ok(match require_active_target(state)? {
        ActiveRepo::Local(repo) => RepoRef::Local(repo),
        ActiveRepo::Remote { host_id, path } => RepoRef::Remote { host_id, path },
    })
}

#[tauri::command]
pub(crate) fn read_global_settings(app: AppHandle) -> Result<alinery_core::GlobalSettings, String> {
    alinery_core::load_global_settings_strict(&app_config_path(&app)?)
}

pub(crate) fn read_model_favorites_in(app_config: &Path, harness: &str) -> Vec<String> {
    alinery_core::load_global_settings(app_config).model_favorites.get(harness).cloned().unwrap_or_default()
}

pub(crate) fn set_model_favorite_in(app_config: &Path, harness: &str, model: &str, favorite: bool) -> Result<Vec<String>, String> {
    if harness.trim().is_empty() {
        return Err("harness must not be empty".into());
    }
    if model.trim().is_empty() {
        return Err("model must not be empty".into());
    }

    let mut global = alinery_core::load_global_settings(app_config);
    let models = global.model_favorites.entry(harness.to_string()).or_default();
    if favorite {
        if !models.iter().any(|saved| saved == model) {
            models.push(model.to_string());
        }
    } else {
        models.retain(|saved| saved != model);
    }
    alinery_core::write_global_settings(app_config, &global)?;
    Ok(read_model_favorites_in(app_config, harness))
}

pub(crate) fn write_global_settings_in(
    app_config: &Path,
    mut requested: alinery_core::GlobalSettings,
) -> Result<(alinery_core::GlobalSettings, alinery_core::GlobalSettings), String> {
    let previous = alinery_core::load_global_settings(app_config);
    requested.model_favorites = previous.model_favorites.clone();
    alinery_core::write_global_settings(app_config, &requested)?;
    let next = alinery_core::load_global_settings(app_config);
    Ok((previous, next))
}

#[tauri::command]
pub(crate) fn read_model_favorites(app: AppHandle, harness: String) -> Result<Vec<String>, String> {
    Ok(read_model_favorites_in(&app_config_path(&app)?, &harness))
}

#[tauri::command]
pub(crate) fn set_model_favorite(app: AppHandle, harness: String, model: String, favorite: bool) -> Result<Vec<String>, String> {
    set_model_favorite_in(&app_config_path(&app)?, &harness, &model, favorite)
}

#[tauri::command]
pub(crate) fn write_global_settings(app: AppHandle, global: alinery_core::GlobalSettings) -> Result<alinery_core::GlobalSettings, String> {
    let path = app_config_path(&app)?;
    let (previous, next) = write_global_settings_in(&path, global)?;
    if next.telemetry.enabled != previous.telemetry.enabled || (!previous.telemetry.prompted && next.telemetry.prompted) {
        let source = if previous.telemetry.prompted {
            alinery_core::TelemetryToggleSource::Settings
        } else {
            alinery_core::TelemetryToggleSource::FirstRun
        };
        emit(
            &app,
            alinery_core::TelemetryEvent::SettingsTelemetry {
                enabled: next.telemetry.enabled,
                source,
            },
        );
        if source == alinery_core::TelemetryToggleSource::FirstRun && next.telemetry.enabled {
            emit(&app, alinery_core::TelemetryEvent::AppOpen { cold_start: true });
        }
    } else {
        emit(
            &app,
            alinery_core::TelemetryEvent::SettingsChange {
                source: alinery_core::TelemetrySource::App,
                scope: alinery_core::SettingsChangeScope::Global,
            },
        );
    }
    Ok(next)
}

#[tauri::command]
pub(crate) async fn storage_info(app: AppHandle, repo_path: String) -> Result<alinery_core::StorageInfo, String> {
    // `storage_stats` walks the whole `.alinery` tree. Settings loads this when Storage
    // opens; a sync command runs that walk on the main thread.
    let target = target_repo_ref_for_app(&app, &repo_path)?;
    let app_config = app_config_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || match target {
        RepoRef::Local(repo) => Ok(alinery_core::storage_info_in(&repo, &app_config, alineryd_socket_namespace().as_deref())),
        // The numbers and paths are the host's: the host walks its own disk.
        RepoRef::Remote { host_id, path } => {
            let state = app.state::<AppState>();
            remote_call(
                &state,
                &host_id,
                RepoOp::StorageInfo {
                    repo: path.into(),
                    app_config: host_app_config(&state, &host_id)?,
                },
            )
        }
    })
    .await
    .map_err(|error| format!("storage info task: {error}"))?
}

// Irreversible: drops every archived task dir, every archived session's files, and the worktrees
// of archived tasks. Live data is never a target (alinery-core owns the walk). A remote repo is
// purged by its host, which kills any session still running under an archived task first.
#[tauri::command]
pub(crate) async fn delete_all_archived_storage(app: AppHandle, state: State<'_, AppState>, repo_path: String) -> Result<alinery_core::PurgeArchivedResult, String> {
    let target = target_repo_ref_for_app(&app, &repo_path)?;
    if let RepoRef::Local(repo) = &target {
        require_repo_owned(&state, repo)?;
    }
    // Keep the shared route cache/fallback behavior without borrowing command State in the worker.
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = worker_app.state::<AppState>();
        let repo = match target {
            RepoRef::Local(repo) => repo,
            RepoRef::Remote { host_id, path } => {
                return remote_call(
                    &state,
                    &host_id,
                    RepoOp::PurgeArchived {
                        repo: path.into(),
                        app_config: host_app_config(&state, &host_id)?,
                    },
                )
            }
        };
        let kill = |task_slug: &str, id: &str| {
            let owned = with_session_client(&state, &repo, task_slug, id, |d| d.session_status_observed(id))
                .map(|s| s.is_some())
                .unwrap_or(false);
            if owned {
                let _ = with_session_client(&state, &repo, task_slug, id, |d| d.kill_session(id));
                state.clear_session_route(id);
            }
        };
        alinery_core::purge_archived_storage(&repo, &kill)
    })
    .await
    .map_err(|e| format!("purge archived storage task: {e}"))??;
    emit(
        &app,
        alinery_core::TelemetryEvent::StoragePurge {
            source: alinery_core::TelemetrySource::App,
        },
    );
    Ok(result)
}
