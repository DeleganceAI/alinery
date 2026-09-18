//! Thin fire-and-forget wrapper so command handlers never re-resolve the
//! app-config path or talk HTTP. Failures are discarded in alinery-core.
use crate::*;

pub(crate) fn emit(app: &AppHandle, event: alinery_core::TelemetryEvent) {
    let Ok(path) = app_config_path(app) else { return };
    alinery_core::record_event(&path, event);
}

pub(crate) fn emit_at(app_config: &Path, event: alinery_core::TelemetryEvent) {
    alinery_core::record_event(app_config, event);
}

// Lazy variants: the event closure runs only if telemetry is on, so correlation ids are not
// read off the disk for a user who declined. See alinery_core::record_event_with.
pub(crate) fn emit_with(app: &AppHandle, build: impl FnOnce() -> alinery_core::TelemetryEvent) {
    let Ok(path) = app_config_path(app) else { return };
    alinery_core::record_event_with(&path, build);
}
