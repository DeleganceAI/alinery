//! settings: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

// Bundled Vinculum launch config + compiled Terminal. Not a multi-harness picker registry.

// A path or value that lands in command position inside a shell pipeline (the remote install
// script) can hold spaces or shell syntax. Single-quote it so the shell sees exactly one word:
// inside '...' every character is literal, so only the closing quote itself needs the '\'' dance.
pub(crate) fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// True when Settings has a Grok key. The key itself stays out of this reply.
#[tauri::command]
pub(crate) fn grok_key_ready(app: AppHandle) -> bool {
    app_config_path(&app)
        .ok()
        .is_some_and(|path| !alinery_core::load_global_settings(&path).experiments.grok_api_key.trim().is_empty())
}

// ---- Scoped settings ----------------------------------------------------------
// Global settings live in app.toml. Repository config.toml is now a partial override
// layer: absent fields inherit, present blank strings are intentional values.
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
