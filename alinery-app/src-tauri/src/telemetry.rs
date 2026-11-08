//! Thin fire-and-forget wrapper so command handlers never re-resolve the
//! app-config path or talk HTTP. Failures are discarded in alinery-core.
use crate::*;

pub(crate) fn emit<R: tauri::Runtime>(app: &AppHandle<R>, event: alinery_core::TelemetryEvent) {
    let Ok(path) = app_config_path(app) else { return };
    alinery_core::record_event(&path, event);
}

pub(crate) fn emit_at(app_config: &Path, event: alinery_core::TelemetryEvent) {
    alinery_core::record_event(app_config, event);
}
