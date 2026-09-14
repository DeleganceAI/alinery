//! app_config: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

pub(crate) fn default_true() -> bool {
    true
}
pub(crate) fn default_ui_scale() -> f64 {
    1.0
}
pub(crate) fn default_terminal_font_size() -> u16 {
    13
}
pub(crate) fn default_artifact_font_size() -> u16 {
    14
}
pub(crate) fn default_artifact_viewer_width() -> u16 {
    360
}
pub(crate) fn default_chat_font_size() -> u16 {
    14
}
pub(crate) fn default_chat_rail_font_size() -> u16 {
    12
}
pub(crate) fn default_chat_rail_density() -> String {
    "normal".into()
}
pub(crate) fn default_chat_max_width() -> String {
    "900".into()
}
pub(crate) fn default_session_default_view() -> String {
    "chat".into()
}

pub(crate) fn default_appearance_mode() -> String {
    "system".into()
}
pub(crate) fn default_accent_color() -> String {
    "#315bff".into()
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct AppearancePrefs {
    #[serde(default = "default_accent_color")]
    pub(crate) accent_color: String,
    #[serde(default = "default_ui_scale")]
    pub(crate) ui_scale: f64,
    #[serde(default = "default_terminal_font_size")]
    pub(crate) terminal_font_size: u16,
    #[serde(default = "default_artifact_font_size")]
    pub(crate) artifact_font_size: u16,
    #[serde(default = "default_artifact_viewer_width")]
    pub(crate) artifact_viewer_width: u16,
    #[serde(default)]
    pub(crate) chat_show_thinking: bool,
    #[serde(default)]
    pub(crate) chat_expand_thinking: bool,
    #[serde(default)]
    pub(crate) chat_show_tools: bool,
    #[serde(default)]
    pub(crate) chat_expand_tools: bool,
    #[serde(default = "default_true")]
    pub(crate) chat_show_harness: bool,
    #[serde(default)]
    pub(crate) chat_show_turn_markers: bool,
    #[serde(default = "default_true")]
    pub(crate) chat_show_subagent_rows: bool,
    #[serde(default = "default_true")]
    pub(crate) chat_show_subagent_drawer: bool,
    #[serde(default = "default_true")]
    pub(crate) chat_auto_collapse_thinking: bool,
    #[serde(default = "default_true")]
    pub(crate) chat_auto_compaction: bool,
    #[serde(default = "default_true")]
    pub(crate) chat_auto_scroll: bool,
    #[serde(default = "default_chat_rail_density")]
    pub(crate) chat_rail_density: String,
    #[serde(default = "default_chat_font_size")]
    pub(crate) chat_font_size: u16,
    #[serde(default = "default_chat_rail_font_size")]
    pub(crate) chat_rail_font_size: u16,
    #[serde(default = "default_true")]
    pub(crate) chat_show_meta: bool,
    #[serde(default = "default_true")]
    pub(crate) chat_show_composer_hints: bool,
    #[serde(default = "default_chat_max_width")]
    pub(crate) chat_max_width: String,
    #[serde(default = "default_true")]
    pub(crate) chat_show_date: bool,
    #[serde(default = "default_true")]
    pub(crate) chat_show_time: bool,
    #[serde(default = "default_true")]
    pub(crate) chat_show_actor_labels: bool,
    #[serde(default = "default_true")]
    pub(crate) chat_show_agent_bubbles: bool,
    #[serde(default = "default_session_default_view")]
    pub(crate) session_default_view: String,
    /// "system" | "light" | "dark" — absent in pre-reskin configs (serde default).
    #[serde(default = "default_appearance_mode")]
    pub(crate) mode: String,
}

impl Default for AppearancePrefs {
    fn default() -> Self {
        Self {
            accent_color: default_accent_color(),
            ui_scale: default_ui_scale(),
            terminal_font_size: default_terminal_font_size(),
            artifact_font_size: default_artifact_font_size(),
            artifact_viewer_width: default_artifact_viewer_width(),
            chat_show_thinking: false,
            chat_expand_thinking: false,
            chat_show_tools: false,
            chat_expand_tools: false,
            chat_show_harness: true,
            chat_show_turn_markers: false,
            chat_show_subagent_rows: true,
            chat_show_subagent_drawer: true,
            chat_auto_collapse_thinking: true,
            chat_auto_compaction: true,
            chat_auto_scroll: true,
            chat_rail_density: default_chat_rail_density(),
            chat_font_size: default_chat_font_size(),
            chat_rail_font_size: default_chat_rail_font_size(),
            chat_show_meta: true,
            chat_show_composer_hints: true,
            chat_max_width: default_chat_max_width(),
            chat_show_date: true,
            chat_show_time: true,
            chat_show_actor_labels: true,
            chat_show_agent_bubbles: true,
            session_default_view: default_session_default_view(),
            mode: default_appearance_mode(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct AppConfig {
    #[serde(default)]
    pub(crate) active_repo: String,
    #[serde(default)]
    pub(crate) known_repos: Vec<String>,
    #[serde(default = "default_true")]
    pub(crate) mcp_enabled: bool,
    #[serde(default)]
    pub(crate) appearance: AppearancePrefs,
    #[serde(default)]
    pub(crate) settings_version: u32,
    #[serde(default = "default_global_settings_app")]
    pub(crate) global: alinery_core::GlobalSettings,
}

pub(crate) fn default_global_settings_app() -> alinery_core::GlobalSettings {
    alinery_core::default_global_settings()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            active_repo: String::new(),
            known_repos: vec![],
            mcp_enabled: true,
            appearance: AppearancePrefs::default(),
            settings_version: 1,
            global: default_global_settings_app(),
        }
    }
}

pub(crate) fn dedupe_known_repos(repos: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for repo in repos {
        let repo = repo.trim().to_string();
        if !repo.is_empty() && !out.contains(&repo) {
            out.push(repo);
        }
    }
    out
}

pub(crate) fn snap_ui_scale(v: f64) -> f64 {
    const STEPS: [f64; 7] = [0.75, 0.875, 1.0, 1.125, 1.25, 1.375, 1.5];
    if !v.is_finite() {
        return default_ui_scale();
    }
    STEPS
        .into_iter()
        .min_by(|a, b| (v - *a).abs().partial_cmp(&(v - *b).abs()).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap_or(default_ui_scale())
}

pub(crate) fn is_hex_rgb(value: &str) -> bool {
    let value = value.trim();
    value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|character| character.is_ascii_hexdigit())
}
pub(crate) fn sanitize_appearance(prefs: AppearancePrefs) -> AppearancePrefs {
    let mode = match prefs.mode.trim() {
        m @ ("system" | "light" | "dark") => m.to_string(),
        _ => default_appearance_mode(),
    };
    let accent_color = prefs.accent_color.trim().to_ascii_lowercase();
    AppearancePrefs {
        accent_color: if is_hex_rgb(&accent_color) { accent_color } else { default_accent_color() },
        ui_scale: snap_ui_scale(prefs.ui_scale),
        terminal_font_size: prefs.terminal_font_size.clamp(8, 22),
        artifact_font_size: prefs.artifact_font_size.clamp(10, 22),
        artifact_viewer_width: prefs.artifact_viewer_width.clamp(260, 2400),
        chat_show_thinking: prefs.chat_show_thinking,
        chat_expand_thinking: prefs.chat_expand_thinking,
        chat_show_tools: prefs.chat_show_tools,
        chat_expand_tools: prefs.chat_expand_tools,
        chat_show_harness: prefs.chat_show_harness,
        chat_show_turn_markers: prefs.chat_show_turn_markers,
        chat_show_subagent_rows: prefs.chat_show_subagent_rows,
        chat_show_subagent_drawer: prefs.chat_show_subagent_drawer,
        chat_auto_collapse_thinking: prefs.chat_auto_collapse_thinking,
        chat_auto_compaction: prefs.chat_auto_compaction,
        chat_auto_scroll: prefs.chat_auto_scroll,
        chat_rail_density: match prefs.chat_rail_density.trim() {
            "dense" | "compact" => "dense".into(),
            "comfortable" => "comfortable".into(),
            "normal" => "normal".into(),
            _ => default_chat_rail_density(),
        },
        chat_font_size: prefs.chat_font_size.clamp(10, 22),
        chat_rail_font_size: prefs.chat_rail_font_size.clamp(10, 22),
        chat_show_meta: prefs.chat_show_meta,
        chat_show_composer_hints: prefs.chat_show_composer_hints,
        chat_max_width: match prefs.chat_max_width.trim() {
            "600" | "900" | "1200" | "none" => prefs.chat_max_width.trim().into(),
            _ => default_chat_max_width(),
        },
        chat_show_date: prefs.chat_show_date,
        chat_show_time: prefs.chat_show_time,
        chat_show_actor_labels: prefs.chat_show_actor_labels,
        chat_show_agent_bubbles: prefs.chat_show_agent_bubbles,
        session_default_view: match prefs.session_default_view.trim() {
            "terminal" => "terminal".into(),
            _ => default_session_default_view(),
        },
        mode,
    }
}

pub(crate) fn sanitize_app_config(mut cfg: AppConfig) -> AppConfig {
    cfg.active_repo = cfg.active_repo.trim().to_string();
    cfg.known_repos = dedupe_known_repos(cfg.known_repos);
    if !cfg.active_repo.is_empty() && !cfg.known_repos.contains(&cfg.active_repo) {
        cfg.known_repos.push(cfg.active_repo.clone());
    }
    cfg.appearance = sanitize_appearance(cfg.appearance);
    cfg.settings_version = 1;
    cfg.global = alinery_core::normalize_global_settings(cfg.global);
    cfg
}

pub(crate) fn load_app_config(app: &AppHandle) -> AppConfig {
    let Ok(p) = app_config_path(app) else {
        return AppConfig::default();
    };
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| toml::from_str::<AppConfig>(&s).ok())
        .map(sanitize_app_config)
        .unwrap_or_default()
}

pub(crate) fn write_app_config_at(path: &Path, cfg: &AppConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        // 0700: this is the same app config dir that later holds `auth.json`, and it is created
        // here first on a fresh install, so `create_dir_all` at the umask is what would decide
        // the mode of the directory the credential lives in.
        alinery_core::create_dir_owner_only(parent)?;
    }
    let prior = fs::read_to_string(path).ok().and_then(|s| toml::from_str::<AppConfig>(&s).ok());
    let s = toml::to_string(cfg).map_err(|e| e.to_string())?;
    fs::write(path, s).map_err(|e| format!("write {}: {e}", path.display()))?;
    if let Some(prior) = prior {
        if prior.mcp_enabled != cfg.mcp_enabled {
            alinery_core::append_info(path, &format!("settings.app mcp_enabled={}", cfg.mcp_enabled));
        }
    }
    Ok(())
}

pub(crate) fn write_app_config(app: &AppHandle, cfg: &AppConfig) -> Result<(), String> {
    write_app_config_at(&app_config_path(app)?, cfg)
}

#[tauri::command]
pub(crate) fn read_app_config(app: AppHandle) -> AppConfig {
    let cfg = load_app_config(&app);
    let active = (!cfg.active_repo.is_empty()).then(|| PathBuf::from(&cfg.active_repo));
    let _ = set_active_repo_global(active.clone());
    if let Some(state) = app.try_state::<AppState>() {
        // Claim every repository this window has open before the daemon poller can manage
        // it. Active goes first so a startup collision preserves the selected repo's
        // existing repo_busy recovery path; inactive busy repos simply remain unattached.
        if let Some(repo) = active.as_ref().filter(|repo| repo.is_dir()) {
            let _ = state.claim_repo(repo);
        }
        for known in &cfg.known_repos {
            let repo = PathBuf::from(known);
            if active.as_ref() == Some(&repo) || !repo.is_dir() {
                continue;
            }
            let _ = state.claim_repo(&repo);
        }

        // Bring up the restored active repo immediately. The poller handles the other
        // owned known repositories without allowing an unowned daemon adoption.
        if let Some(repo) = active.as_ref().filter(|repo| state.owns_repo(repo)) {
            if let Ok(app_config) = app_config_path(&app) {
                attach_repo_daemon(&state, repo, &app_config);
            }
            ensure_mcp_server(&app, repo); // R2
        }
    }
    emit(&app, alinery_core::TelemetryEvent::AppOpen { cold_start: true });
    cfg
}

#[tauri::command]
pub(crate) fn set_active_repo(app: AppHandle, state: State<'_, AppState>, path: String, drawer_session_id: Option<String>) -> Result<AppConfig, String> {
    let repo = git_top_level(Path::new(path.trim()))?;
    let reservation = state.reserve_repo(&repo)?.ok_or_else(|| {
        let name = repo
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| repo.display().to_string());
        format!("{name} is open in another Alinery window.")
    })?;

    ensure_repo_ready(&repo)?;
    let app_config = app_config_path(&app)?;
    let previous_repo = active_repo().ok();
    let repo_s = repo.to_string_lossy().to_string();
    let mut cfg = load_app_config(&app);
    cfg.active_repo = repo_s.clone();
    cfg.known_repos.push(repo_s);
    cfg = sanitize_app_config(cfg);
    write_app_config(&app, &cfg)?;

    if let (Some(previous), Some(id)) = (previous_repo.as_ref(), drawer_session_id.as_deref()) {
        if previous != &repo && state.owns_repo(previous) {
            let _ = with_session_client(&state, previous, "", id, |daemon| daemon.kill_session(id));
            state.clear_session_route(id);
        }
    }

    reservation.commit(&state);
    set_active_repo_global(Some(repo.clone()))?;
    attach_repo_daemon(&state, &repo, &app_config);
    ensure_mcp_server(&app, &repo);
    emit(
        &app,
        alinery_core::TelemetryEvent::RepoActivate {
            source: alinery_core::TelemetrySource::App,
        },
    );
    Ok(cfg)
}

/// Delist `target`, returning the sanitized config plus whether it was the active repo.
/// `sanitize_app_config` re-adds a non-empty `active_repo` to `known_repos`, so removing the
/// active repo has to clear the active selection or the removal would silently undo itself.
pub(crate) fn remove_repo_from_config(mut cfg: AppConfig, target: &str) -> Result<(AppConfig, bool), String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("no repo given".into());
    }
    let before = cfg.known_repos.len();
    cfg.known_repos.retain(|known| known.trim() != target);
    if cfg.known_repos.len() == before {
        return Err(format!("repo not in list: {target}"));
    }
    let was_active = cfg.active_repo.trim() == target;
    if was_active {
        cfg.active_repo = String::new();
    }
    Ok((sanitize_app_config(cfg), was_active))
}

/// Drop a repository from the app-level list **and release ownership of it**: this repo's
/// `alineryd` is stopped (ending every live session), then its retained GUI flock is released
/// only after the app config no longer lists it.
///
/// The delist-only promise this docstring used to carry is retired. Teardown is still
/// deliberate — the UI confirms with the live session count first (`repo_live_sessions`),
/// and cancelling never reaches this command. Removing the *active* repo also clears the
/// active selection; picking the next one is the caller's job so daemon/MCP bring-up
/// lives only in `set_active_repo`.
#[tauri::command]
pub(crate) fn remove_repo(app: AppHandle, path: String) -> Result<AppConfig, String> {
    let target = PathBuf::from(path.trim());
    // Bound once so the closing guard below can borrow from it for the whole function.
    // `None` only in unit tests, which drive `AppState` directly.
    let state = app.try_state::<AppState>();
    // Held across teardown *and* the delisting below, not just teardown: until the repo
    // is out of `known_repos` the poller still has a reason to spawn for it, so releasing
    // between the two would leave a last tick free to hand us a daemon that no listed
    // repo owns. Dropped at the end of the function, after the config write.
    let _closing = state.as_ref().map(|s| s.mark_closing(&target));
    // Teardown BEFORE delisting: if the daemon will not stop, keep the repo in
    // config/UI so the user still has a handle. Never pretend a close succeeded.
    if let Some(state) = state.as_ref() {
        // B6: removing a repo shuts its daemon down. That is the owner's call — a second
        // alinery must not tear down the window that actually holds the folder.
        require_repo_owned(state, &target)?;
        close_repo_daemon(state, &target).map_err(|e| format!("{e}. Live sessions may still be running — stop them from Settings → Harness, then try again."))?;
    }
    // One source of truth for "was this the active repo": the same normalization the
    // delist itself uses, computed after teardown so it reflects the config we write.
    let (cfg, was_active) = remove_repo_from_config(load_app_config(&app), &path)?;
    write_app_config(&app, &cfg)?;
    if was_active {
        if let Some(state) = state.as_ref() {
            state.kill_mcp();
        }
        set_active_repo_global(None)?;
    }
    if let Some(state) = state.as_ref() {
        state.release_repo(&target);
    }
    emit(
        &app,
        alinery_core::TelemetryEvent::RepoRemove {
            source: alinery_core::TelemetrySource::App,
            was_active,
        },
    );
    Ok(cfg)
}

#[tauri::command]
pub(crate) fn write_appearance(app: AppHandle, appearance: AppearancePrefs) -> Result<AppConfig, String> {
    let mut cfg = load_app_config(&app);
    cfg.appearance = sanitize_appearance(appearance);
    write_app_config(&app, &cfg)?;
    emit(
        &app,
        alinery_core::TelemetryEvent::SettingsChange {
            source: alinery_core::TelemetrySource::App,
            scope: alinery_core::SettingsChangeScope::Appearance,
        },
    );
    Ok(cfg)
}

#[tauri::command]
pub(crate) async fn pick_repo_dialog(app: AppHandle) -> Result<Option<String>, String> {
    let Some(folder) = app.dialog().file().set_title("Choose a git repository").blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder.into_path().map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
pub(crate) async fn pick_attachment_files_dialog(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(app
        .dialog()
        .file()
        .set_title("Choose attachments")
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect())
}
