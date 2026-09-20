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
// ponytail: no timeout on models_cmd; a hung list command blocks this call. Add a timeout
// if a real harness ever ships a slow one.
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

#[tauri::command]
pub(crate) fn list_harness_models(app: AppHandle, harness: String) -> Vec<String> {
    match (active_repo(), app_config_path(&app)) {
        (Ok(repo), Ok(app_config)) => list_harness_models_in(&app_config, &repo, &harness),
        _ => vec![],
    }
}

#[tauri::command]
pub(crate) fn list_harness_models_for_repo(app: AppHandle, repo_path: String, harness: String) -> Result<Vec<String>, String> {
    Ok(list_harness_models_in(&app_config_path(&app)?, &target_repo_for_app(&app, &repo_path)?, &harness))
}

// ---- Scoped settings ----------------------------------------------------------
// Global settings live in app.toml. Repository config.toml is now a partial override
// layer: absent fields inherit, present blank strings are intentional values.
pub(crate) type Config = alinery_core::EffectiveConfig;

pub(crate) const DEFAULT_CONFIG_TOML: &str = include_str!("../config.default.toml");

pub(crate) fn config_toml_path(repo: &Path) -> PathBuf {
    alinery_dir(repo).join("config.toml")
}

pub(crate) fn ensure_config_toml(repo: &Path) -> Result<(), String> {
    let p = config_toml_path(repo);
    if p.exists() {
        return Ok(());
    }
    fs::create_dir_all(alinery_dir(repo)).map_err(|e| e.to_string())?;
    fs::write(&p, DEFAULT_CONFIG_TOML).map_err(|e| format!("write {}: {e}", p.display()))
}

pub(crate) fn load_config_with_app_path(app_config: &Path, repo: &Path) -> Config {
    let _ = ensure_config_toml(repo);
    let global = alinery_core::load_global_settings(app_config);
    let overrides = alinery_core::load_repo_overrides(repo);
    alinery_core::resolve_effective_config(&global, &overrides)
}

pub(crate) fn scoped_settings_for(app: &AppHandle, repo: &Path) -> Result<alinery_core::ScopedSettings, String> {
    let _ = ensure_config_toml(repo);
    Ok(alinery_core::read_scoped_settings(&app_config_path(app)?, repo))
}

#[tauri::command]
pub(crate) fn read_config(app: AppHandle) -> Result<Config, String> {
    let repo = active_repo()?;
    Ok(load_config_with_app_path(&app_config_path(&app)?, &repo))
}

#[tauri::command]
pub(crate) fn read_config_for_repo(app: AppHandle, repo_path: String) -> Result<Config, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    Ok(load_config_with_app_path(&app_config_path(&app)?, &repo))
}

#[tauri::command]
pub(crate) fn read_global_settings(app: AppHandle) -> Result<alinery_core::GlobalSettings, String> {
    Ok(alinery_core::load_global_settings(&app_config_path(&app)?))
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
pub(crate) fn read_scoped_settings_for_repo(app: AppHandle, repo_path: String) -> Result<alinery_core::ScopedSettings, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    scoped_settings_for(&app, &repo)
}

#[tauri::command]
pub(crate) fn read_repo_overrides_for_repo(app: AppHandle, repo_path: String) -> Result<alinery_core::RepoOverrides, String> {
    Ok(alinery_core::load_repo_overrides(&target_repo_for_app(&app, &repo_path)?))
}

#[tauri::command]
pub(crate) fn write_repo_overrides_for_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    overrides: alinery_core::RepoOverrides,
) -> Result<alinery_core::ScopedSettings, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    alinery_core::write_repo_overrides(Some(&app_config_path(&app)?), &repo, &overrides)?;
    emit(
        &app,
        alinery_core::TelemetryEvent::SettingsChange {
            source: alinery_core::TelemetrySource::App,
            scope: alinery_core::SettingsChangeScope::Repo,
        },
    );
    scoped_settings_for(&app, &repo)
}

#[tauri::command]
pub(crate) fn clear_repo_override_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, field: String) -> Result<alinery_core::ScopedSettings, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    let mut overrides = alinery_core::load_repo_overrides(&repo);
    alinery_core::clear_repo_override(&mut overrides, &field)?;
    alinery_core::write_repo_overrides(Some(&app_config_path(&app)?), &repo, &overrides)?;
    emit(
        &app,
        alinery_core::TelemetryEvent::SettingsChange {
            source: alinery_core::TelemetrySource::App,
            scope: alinery_core::SettingsChangeScope::Repo,
        },
    );
    scoped_settings_for(&app, &repo)
}

// Compatibility command: active-repo writes now replace only that repository's override layer.
#[tauri::command]
pub(crate) fn write_config(app: AppHandle, state: State<'_, AppState>, config: alinery_core::RepoOverrides) -> Result<(), String> {
    let repo = require_owned_active_repo(&state)?;
    alinery_core::write_repo_overrides(Some(&app_config_path(&app)?), &repo, &config)?;
    emit(
        &app,
        alinery_core::TelemetryEvent::SettingsChange {
            source: alinery_core::TelemetrySource::App,
            scope: alinery_core::SettingsChangeScope::Repo,
        },
    );
    Ok(())
}

#[derive(Serialize)]
pub(crate) struct StorageInfo {
    pub(crate) app_config_path: String,
    pub(crate) repo_path: String,
    pub(crate) alinery_dir: String,
    pub(crate) repo_config_path: String,
    pub(crate) harnesses_path: String,
    pub(crate) tasks_dir: String,
    pub(crate) worktrees_dir: String,
    pub(crate) alineryd_socket_path: String,
    pub(crate) alineryd_lock_path: String,
    pub(crate) mcp_socket_path: String,
    pub(crate) mcp_status_path: String,
    // Disk accounting (issue #91). `archived_bytes` is exactly what delete_all_archived_storage
    // frees; `active_bytes` is the read-only remainder. Both come from one alinery-core walk.
    pub(crate) archived_task_count: u32,
    pub(crate) archived_session_count: u32,
    pub(crate) archived_bytes: u64,
    pub(crate) active_bytes: u64,
}

#[tauri::command]
pub(crate) fn storage_info(app: AppHandle, repo_path: String) -> Result<StorageInfo, String> {
    let app_config = app_config_path(&app)?;
    let repo = target_repo_for_app(&app, &repo_path)?;
    let stats = alinery_core::storage_stats(&repo);
    let alinery = alinery_dir(&repo);
    let path = |p: PathBuf| p.to_string_lossy().to_string();

    Ok(StorageInfo {
        app_config_path: path(app_config),
        repo_path: repo.to_string_lossy().to_string(),
        alinery_dir: path(alinery.clone()),
        repo_config_path: path(config_toml_path(&repo)),
        harnesses_path: path(alinery.join("harnesses.toml")),
        tasks_dir: path(tasks_dir(&repo)),
        worktrees_dir: path(worktrees_dir(&repo)),
        alineryd_socket_path: path(current_alineryd_socket_path(&repo)),
        alineryd_lock_path: path(current_alineryd_lock_path(&repo)),
        mcp_socket_path: path(alinery_core::mcp_socket_path(&repo, alineryd_socket_namespace().as_deref())),
        mcp_status_path: path(alinery_core::mcp_status_path(&repo, alineryd_socket_namespace().as_deref())),
        archived_task_count: stats.archived_task_count,
        archived_session_count: stats.archived_session_count,
        archived_bytes: stats.archived_bytes,
        active_bytes: stats.active_bytes,
    })
}

// Irreversible, local-only: drops every archived task dir, every archived session's files, and
// the worktrees of archived tasks. Live data is never a target (alinery-core owns the walk).
#[tauri::command]
pub(crate) fn delete_all_archived_storage(app: AppHandle, state: State<'_, AppState>, repo_path: String) -> Result<alinery_core::PurgeArchivedResult, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    let kill = |task_slug: &str, id: &str| {
        let owned = with_session_client(&state, &repo, task_slug, id, |d| d.session_status_observed(id))
            .map(|s| s.is_some())
            .unwrap_or(false);
        if owned {
            let _ = with_session_client(&state, &repo, task_slug, id, |d| d.kill_session(id));
            state.clear_session_route(id);
        }
    };
    let result = alinery_core::purge_archived_storage(&repo, &kill)?;
    emit(
        &app,
        alinery_core::TelemetryEvent::StoragePurge {
            source: alinery_core::TelemetrySource::App,
        },
    );
    Ok(result)
}
