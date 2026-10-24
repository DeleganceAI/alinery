//! notify: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

// Bundled notification sound: a custom tron_notification.wav compiled into the binary via
// include_bytes! (same pattern as config.default.toml's include_str!). `afplay` needs a real
// file path, so the bytes are written once to a temp file on first use (LazyLock — the
// initializer is fixed at declaration time) and that path is reused for every play.
pub(crate) const NOTIFICATION_SOUND: &[u8] = include_bytes!("../tron_notification.wav");
pub(crate) static NOTIFICATION_SOUND_PATH: LazyLock<PathBuf> = LazyLock::new(|| {
    let path = std::env::temp_dir().join("alinery-notification.wav");
    let _ = fs::write(&path, NOTIFICATION_SOUND);
    path
});

// ---- M5 notifications --------------------------------------------------------
// The Running->Idle surface. Called OFF the reader's out lock (on its own thread) so a
// config read, a banner, an afplay spawn, or a dock bounce can never stall passthrough.
// Everything gates on global app settings, RE-READ each fire — so repository
// overrides never affect notification delivery.
// Sound is a decoupled afplay shell-out and bounce a window attention request, so
// sound/banner/bounce each toggle independently.
pub(crate) fn fire_idle_notification(app: &AppHandle, label: &str) {
    fire_app_notification(app, &format!("{label} — idle, needs you"));
}

// The gated banner/sound/bounce path itself, body supplied by the caller. Backup failures
// reuse it so a broken destination surfaces without a second notification subsystem.
pub(crate) fn fire_app_notification(app: &AppHandle, body: &str) {
    let Ok(app_config) = app_config_path(app) else {
        return;
    };
    let cfg = alinery_core::load_global_settings(&app_config).notifications;
    if !cfg.enabled {
        return;
    }
    if cfg.banner {
        let _ = app.notification().builder().title("Alinery").body(body).show();
    }
    if cfg.sound {
        // No dep, no coupling to the banner: play the bundled tron sound directly.
        let _ = Command::new("afplay").arg(&*NOTIFICATION_SOUND_PATH).spawn();
    }
    if cfg.bounce {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.request_user_attention(Some(UserAttentionType::Critical));
        }
    }
}

// Spike-as-feature: fire one notification on demand (the settings "Send test notification"
// button). This is the ONLY reliable way to confirm banners show from a REAL bundle with the
// app unfocused / Focus-DND checked, without waiting on a ds4 idle cycle. Respects config, so
// it tests the exact gated path the idle edge uses.
#[tauri::command]
pub(crate) fn notify_test(app: AppHandle) -> Result<(), String> {
    fire_idle_notification(&app, "test");
    Ok(())
}

pub(crate) fn dock_badge_value(count: i64) -> Option<i64> {
    (count > 0).then_some(count)
}

#[tauri::command]
pub(crate) fn set_dock_badge_count(app: AppHandle, count: i64) -> Result<(), String> {
    let badge = dock_badge_value(count);
    #[cfg(target_os = "macos")]
    if let Some(window) = app.get_webview_window("main") {
        window.set_badge_count(badge).map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, badge);
    Ok(())
}

// Semantic attention bridge. The frontend calls this on normalized transitions into
// idle/waiting states; only the three allowed semantic transitions may fire a notification.
// Unsupported/unknown sessions must never reach this path (plan Step 3, TDD 3C).
pub(crate) use alinery_core::session_actions::session_attention_body;

#[tauri::command]
pub(crate) async fn notify_session_attention(app: AppHandle, repo_path: String, slug: Option<String>, reason: String) -> Result<(), String> {
    let target = target_repo_ref_for_app(&app, &repo_path)?;
    let worker = app.clone();
    let body = off_main_thread("session attention", move || match target {
        RepoRef::Local(repo) => session_attention_body(&repo, slug, &reason),
        // The task's name is read on its host; the notification itself is shown here.
        RepoRef::Remote { host_id, path } => remote_call(&worker.state::<AppState>(), &host_id, RepoOp::SessionAttentionBody { repo: path.into(), slug, reason }),
    })
    .await?;
    fire_app_notification(&app, &body);
    Ok(())
}
