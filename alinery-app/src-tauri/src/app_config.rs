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
pub(crate) fn default_compaction_basis() -> String {
    "percent".into()
}
pub(crate) fn default_compaction_percent() -> u16 {
    80
}
pub(crate) fn default_compaction_tokens() -> u32 {
    128_000
}
pub(crate) fn default_chat_max_width() -> String {
    "900".into()
}
pub(crate) fn default_session_default_view() -> String {
    "chat".into()
}
pub(crate) fn default_startup_view() -> String {
    "list".into()
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
    /// `percent` uses `chat_compaction_percent` of the model window. `tokens` uses `chat_compaction_tokens`, capped at that window.
    #[serde(default = "default_compaction_basis")]
    pub(crate) chat_compaction_basis: String,
    #[serde(default = "default_compaction_percent")]
    pub(crate) chat_compaction_percent: u16,
    #[serde(default = "default_compaction_tokens")]
    pub(crate) chat_compaction_tokens: u32,
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
    #[serde(default = "default_true")]
    pub(crate) chat_show_block_copy_buttons: bool,
    #[serde(default = "default_true")]
    pub(crate) chat_show_copy_buttons: bool,
    #[serde(default = "default_session_default_view")]
    pub(crate) session_default_view: String,
    #[serde(default = "default_startup_view")]
    pub(crate) startup_view: String,
    /// "system" | "light" | "dark" — absent in pre-reskin configs (serde default).
    #[serde(default = "default_appearance_mode")]
    pub(crate) mode: String,
    /// The Chat view's own copy of the `chat_*` settings above (those drive the Sessions view).
    /// The frontend owns the names and the value ranges (`normalizeChatView`), so this only keeps
    /// scalar `chat_*` entries. Last field: TOML needs tables after plain values.
    #[serde(default)]
    pub(crate) ava_chat: BTreeMap<String, toml::Value>,
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
            chat_compaction_basis: default_compaction_basis(),
            chat_compaction_percent: default_compaction_percent(),
            chat_compaction_tokens: default_compaction_tokens(),
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
            chat_show_block_copy_buttons: true,
            chat_show_copy_buttons: true,
            session_default_view: default_session_default_view(),
            startup_view: default_startup_view(),
            mode: default_appearance_mode(),
            ava_chat: BTreeMap::new(),
        }
    }
}

/// An SSH host that remote repos (`alinery+ssh://<host-id>/…`) live on. `ssh_args` is the
/// already-validated destination (host plus allowlisted flags); the probed fields are filled on
/// connect.
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
pub(crate) struct RemoteHost {
    #[serde(default)]
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) ssh_args: Vec<String>,
    #[serde(default)]
    pub(crate) home: Option<String>,
    #[serde(default)]
    pub(crate) platform: Option<String>,
    #[serde(default)]
    pub(crate) glibc: Option<String>,
    /// What this host may receive. `None` is a host from before this was a choice; its first
    /// connect keeps what it had, minus browser sign-ins, and records it here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) sharing: Option<RemoteSharing>,
    /// Whether the onboarding steps have run on this host (S6.1, D9). Always written, so a file
    /// without the key is one from before the mark existed (`migrate_onboarded_marks`).
    #[serde(default)]
    pub(crate) onboarded: bool,
}

/// What the user chose to put on a host, and what this app has put there. Nothing that is a
/// credential is copied until `reviewed`. Items are `hosted-models`, `custom-providers`, `grok`
/// and `key:<provider>` (an API key).
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
pub(crate) struct RemoteSharing {
    #[serde(default)]
    pub(crate) reviewed: bool,
    #[serde(default)]
    pub(crate) shared: Vec<String>,
    /// Items this app has written to the host, so that taking one off `shared` removes exactly
    /// what it put there and never something the host made for itself.
    #[serde(default)]
    pub(crate) placed: Vec<String>,
    /// Sign-ins removed from the host when it moved to this scheme. Shown until the user has
    /// seen them and confirmed the choices again.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) erased_sign_ins: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct AppConfig {
    #[serde(default)]
    pub(crate) active_repo: String,
    #[serde(default)]
    pub(crate) known_repos: Vec<String>,
    /// Whether the onboarding steps have run on this computer, the host that is always there
    /// (S6.1, D9). Always written, like `RemoteHost::onboarded`.
    #[serde(default)]
    pub(crate) local_onboarded: bool,
    /// Keyed by host id. Core's `AppConfig` has no such key and ignores it.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) remote_hosts: BTreeMap<String, RemoteHost>,
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
            local_onboarded: false,
            remote_hosts: BTreeMap::new(),
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
        chat_compaction_basis: match prefs.chat_compaction_basis.trim() {
            "tokens" => "tokens".into(),
            _ => default_compaction_basis(),
        },
        chat_compaction_percent: prefs.chat_compaction_percent.clamp(1, 100),
        chat_compaction_tokens: prefs.chat_compaction_tokens.clamp(1, 10_000_000),
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
        chat_show_block_copy_buttons: prefs.chat_show_block_copy_buttons,
        chat_show_copy_buttons: prefs.chat_show_copy_buttons,
        session_default_view: match prefs.session_default_view.trim() {
            "terminal" => "terminal".into(),
            _ => default_session_default_view(),
        },
        startup_view: match prefs.startup_view.trim() {
            view @ ("list" | "sessions" | "kanban" | "chat" | "notifications" | "playbooks" | "settings") => view.into(),
            view if view.strip_prefix("grid:").is_some_and(|id| !id.trim().is_empty()) => view.into(),
            _ => default_startup_view(),
        },
        mode,
        ava_chat: prefs
            .ava_chat
            .into_iter()
            .filter(|(key, value)| key.starts_with("chat_") && matches!(value, toml::Value::Boolean(_) | toml::Value::Integer(_) | toml::Value::String(_)))
            .collect(),
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

/// A file written before the onboarded mark has neither key. Such an install has already
/// onboarded wherever it holds a repository: this computer if `known_repos` has a local one, a
/// remote host if it has one on that host. A file that has the key is never touched, so a mark
/// the user left unset stays unset. The old once-per-install `localStorage` flag is folded in by
/// the page (`set_host_onboarded`).
fn migrate_onboarded_marks(cfg: &mut AppConfig, source: &str) {
    let raw: toml::Table = source.parse().unwrap_or_default();
    if !raw.contains_key("local_onboarded") {
        cfg.local_onboarded = cfg.known_repos.iter().any(|key| !is_remote_repo_key(key));
    }
    for (id, host) in &mut cfg.remote_hosts {
        let has_key = raw.get("remote_hosts").and_then(|hosts| hosts.get(id)).and_then(|host| host.get("onboarded")).is_some();
        if !has_key {
            host.onboarded = cfg
                .known_repos
                .iter()
                .any(|key| matches!(RepoRef::parse(key), Ok(RepoRef::Remote { host_id, .. }) if &host_id == id));
        }
    }
}

pub(crate) fn read_existing_app_config(path: &Path) -> Result<Option<AppConfig>, String> {
    let source = match fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read application configuration {}: {error}", path.display())),
    };
    toml::from_str::<AppConfig>(&source)
        .map(sanitize_app_config)
        .map(|mut cfg| {
            migrate_onboarded_marks(&mut cfg, &source);
            Some(cfg)
        })
        .map_err(|error| {
            format!(
                "invalid application configuration {} (playbook defaults require a scope-qualified reference): {error}",
                path.display()
            )
        })
}

pub(crate) fn load_app_config<R: tauri::Runtime>(app: &AppHandle<R>) -> AppConfig {
    let Ok(p) = app_config_path(app) else {
        return AppConfig::default();
    };
    read_existing_app_config(&p).ok().flatten().unwrap_or_default()
}

pub(crate) fn write_app_config_at(path: &Path, cfg: &AppConfig) -> Result<(), String> {
    // An unrelated appearance/repository edit must not erase a corrupt file.
    let prior = read_existing_app_config(path)?;
    if let Some(parent) = path.parent() {
        // 0700: this is the same app config dir that later holds `auth.json`, and it is created
        // here first on a fresh install, so `create_dir_all` at the umask is what would decide
        // the mode of the directory the credential lives in.
        alinery_core::create_dir_owner_only(parent)?;
    }
    let s = toml::to_string(cfg).map_err(|e| e.to_string())?;
    write_owner_only_bytes(path, s.as_bytes()).map_err(|e| format!("write {}: {e}", path.display()))?;
    if let Some(prior) = prior {
        if prior.mcp_enabled != cfg.mcp_enabled {
            alinery_core::append_info(path, &format!("settings.app mcp_enabled={}", cfg.mcp_enabled));
        }
    }
    Ok(())
}

/// Renames an older Alinery's `omp` harness to Vinculum in the files a reset keeps: the project's settings and playbooks,
/// the global playbooks, and `app.toml` (its favorites and default move over, its saved harness row goes). Returns how many
/// files changed.
pub(crate) fn forget_older_harness(repo: &Path, app_config: &Path) -> Result<usize, String> {
    let alinery = alinery_core::alinery_dir(repo);
    let global_playbooks = app_config.parent().map(|dir| dir.join("playbooks"));
    let mut roots = vec![alinery.join("config.toml"), alinery.join("playbooks"), repo.join("alinery").join("playbooks")];
    roots.extend(global_playbooks);
    let mut changed = alinery_core::older_alinery::rename_older_harness_in(&roots.iter().map(PathBuf::as_path).collect::<Vec<_>>())?;
    if let Some(mut cfg) = read_existing_app_config(app_config)? {
        if forget_older_harness_in_config(&mut cfg) {
            write_app_config_at(app_config, &cfg)?;
            changed += 1;
        }
    }
    Ok(changed)
}

/// `app.toml`'s half of `forget_older_harness`. Returns whether anything changed.
pub(crate) fn forget_older_harness_in_config(cfg: &mut AppConfig) -> bool {
    let global = &mut cfg.global;
    let mut changed = false;
    if let Some(older) = global.model_favorites.remove("omp") {
        let favorites = global.model_favorites.entry(alinery_core::DEFAULT_HARNESS_KEY.into()).or_default();
        for model in older {
            if !favorites.contains(&model) {
                favorites.push(model);
            }
        }
        changed = true;
    }
    if global.defaults.harness == "omp" {
        global.defaults.harness = alinery_core::DEFAULT_HARNESS_KEY.into();
        changed = true;
    }
    let rows = global.harnesses.harness.len();
    global.harnesses.harness.retain(|row| row.key != "omp");
    changed | (global.harnesses.harness.len() != rows)
}

pub(crate) fn write_app_config<R: tauri::Runtime>(app: &AppHandle<R>, cfg: &AppConfig) -> Result<(), String> {
    write_app_config_at(&app_config_path(app)?, cfg)
}

/// The id of the host that is always there.
pub(crate) const LOCAL_HOST_ID: &str = "local";

/// One row of the host list: this computer first, then each remote host.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct HostEntry {
    pub(crate) host_id: String,
    pub(crate) label: String,
    pub(crate) local: bool,
    pub(crate) onboarded: bool,
    /// The connection view of a remote host; `None` for this computer.
    pub(crate) remote: Option<RemoteHostView>,
}

pub(crate) fn host_entries(cfg: &AppConfig, remote: Vec<RemoteHostView>) -> Vec<HostEntry> {
    let mut hosts = vec![HostEntry {
        host_id: LOCAL_HOST_ID.into(),
        label: "This computer".into(),
        local: true,
        onboarded: cfg.local_onboarded,
        remote: None,
    }];
    hosts.extend(remote.into_iter().map(|view| HostEntry {
        host_id: view.host_id.clone(),
        label: view.label.clone(),
        local: false,
        onboarded: cfg.remote_hosts.get(&view.host_id).is_some_and(|host| host.onboarded),
        remote: Some(view),
    }));
    hosts
}

/// Set a host's onboarded mark in `cfg`. An unknown remote host is an error.
pub(crate) fn set_onboarded_in(cfg: &mut AppConfig, host_id: &str, onboarded: bool) -> Result<(), String> {
    if host_id == LOCAL_HOST_ID {
        cfg.local_onboarded = onboarded;
        return Ok(());
    }
    cfg.remote_hosts.get_mut(host_id).ok_or("unknown remote host")?.onboarded = onboarded;
    Ok(())
}

#[tauri::command]
pub(crate) fn list_hosts(app: AppHandle, state: State<'_, AppState>) -> Vec<HostEntry> {
    host_entries(&load_app_config(&app), host_views(&app, &state))
}

#[tauri::command]
pub(crate) async fn set_host_onboarded(app: AppHandle, host_id: String, onboarded: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cfg = read_existing_app_config(&app_config_path(&app)?)?.unwrap_or_default();
        set_onboarded_in(&mut cfg, &host_id, onboarded)?;
        write_app_config(&app, &cfg)
    })
    .await
    .map_err(|error| format!("set host onboarded task: {error}"))?
}

#[tauri::command]
pub(crate) async fn read_app_config(app: AppHandle) -> Result<AppConfig, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = read_existing_app_config(&app_config_path(&app)?)?.unwrap_or_default();
        let active = (!cfg.active_repo.is_empty()).then(|| PathBuf::from(&cfg.active_repo));
        let _ = set_active_repo_global(active.clone());
        if let Some(state) = app.try_state::<AppState>() {
            // Claim every repository this window has open before the daemon poller can manage
            // it. Active goes first so a startup collision preserves the selected repo's
            // existing repo_busy recovery path; inactive busy repos simply remain unattached.
            if let Some(repo) = active.as_ref().filter(|repo| is_local_repo_dir(repo)) {
                let lifecycle = state.repo_lifecycle(repo);
                let _guard = lifecycle.lock().unwrap_or_else(|error| error.into_inner());
                if !state.is_quitting() && !state.is_closing(repo) && load_app_config(&app).known_repos.iter().any(|known| Path::new(known) == repo) {
                    let _ = state.claim_repo(repo);
                }
            }
            for known in &cfg.known_repos {
                let repo = PathBuf::from(known);
                if active.as_ref() == Some(&repo) || !is_local_repo_dir(&repo) {
                    continue;
                }
                let lifecycle = state.repo_lifecycle(&repo);
                let _guard = lifecycle.lock().unwrap_or_else(|error| error.into_inner());
                if !state.is_quitting() && !state.is_closing(&repo) && load_app_config(&app).known_repos.iter().any(|known| Path::new(known) == repo) {
                    let _ = state.claim_repo(&repo);
                }
            }

            // Bring up the restored active repo immediately. The poller handles the other
            // owned known repositories without allowing an unowned daemon adoption.
            if let Some(repo) = active.as_ref().filter(|repo| state.owns_repo(repo)) {
                if let Ok(app_config) = app_config_path(&app) {
                    attach_repo_daemon(&state, repo, &app_config);
                }
                ensure_mcp_server(&app, repo, false);
            }
        }
        emit(&app, alinery_core::TelemetryEvent::AppOpen { cold_start: true });
        Ok(cfg)
    })
    .await
    .map_err(|error| format!("read app configuration task: {error}"))?
}

#[tauri::command]
pub(crate) async fn set_active_repo(app: AppHandle, path: String) -> Result<AppConfig, String> {
    // The switch waits on the repo's lock and daemon; a sync command would run that on the main thread.
    // The whole switch moves together so reservation, config write and commit stay in order.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        set_active_repo_sync(app.clone(), state, path)
    })
    .await
    .map_err(|e| format!("set active repo task: {e}"))?
}

pub(crate) fn set_active_repo_sync<R: tauri::Runtime>(app: AppHandle<R>, state: State<'_, AppState>, path: String) -> Result<AppConfig, String> {
    if is_remote_repo_key(path.trim()) {
        return activate_remote_repo(&app, &state, path.trim());
    }
    let repo = alinery_core::require_working_tree(Path::new(path.trim()))?;
    let lifecycle = state.repo_lifecycle(&repo);
    let guard = lifecycle.lock().unwrap_or_else(|error| error.into_inner());
    if state.is_quitting() || state.is_closing(&repo) {
        return Err("project is closing".into());
    }
    let reservation = state.reserve_repo(&repo)?.ok_or_else(|| {
        let name = repo
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| repo.display().to_string());
        format!("{name} is open in another Alinery window.")
    })?;

    ensure_alinery_dir(&repo)?;
    let app_config = app_config_path(&app)?;
    let repo_s = repo.to_string_lossy().to_string();
    let mut cfg = load_app_config(&app);
    cfg.active_repo = repo_s.clone();
    cfg.known_repos.push(repo_s);
    cfg = sanitize_app_config(cfg);
    write_app_config(&app, &cfg)?;

    reservation.commit(&state);
    set_active_repo_global(Some(repo.clone()))?;
    attach_repo_daemon_locked(&state, &repo, &app_config, &guard);
    ensure_mcp_server(&app, &repo, false);
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
/// deliberate — the UI confirms with the live session count first (the `daemon/_/status` entity),
/// and cancelling never reaches this command. Removing the *active* repo also clears the
/// active selection; picking the next one is the caller's job so daemon/MCP bring-up
/// lives only in `set_active_repo`.
#[tauri::command]
pub(crate) async fn remove_repo(app: AppHandle, path: String) -> Result<AppConfig, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if is_remote_repo_key(path.trim()) {
            return Err("stopping a remote repository's sessions is not available yet; remove it and leave its sessions running".to_string());
        }
        let target = PathBuf::from(path.trim());
        // Bound once so the closing guard below can borrow from it for the whole function.
        // `None` only in unit tests, which drive `AppState` directly.
        let state = app.try_state::<AppState>();
        // Held across teardown *and* the delisting below, not just teardown: until the repo
        // is out of `known_repos` the poller still has a reason to spawn for it, so releasing
        // between the two would leave a last tick free to hand us a daemon that no listed
        // repo owns. Dropped at the end of the function, after the config write.
        let _closing = state.as_ref().map(|s| s.mark_closing(&target));
        let lifecycle = state.as_ref().map(|state| state.repo_lifecycle(&target));
        let guard = lifecycle.as_ref().map(|lock| lock.lock().unwrap_or_else(|error| error.into_inner()));
        // Teardown BEFORE delisting: if the daemon will not stop, keep the repo in
        // config/UI so the user still has a handle. Never pretend a close succeeded.
        if let Some(state) = state.as_ref() {
            // B6: removing a repo shuts its daemon down. That is the owner's call — a second
            // alinery must not tear down the window that actually holds the folder.
            require_repo_closable(state, &target)?;
            close_repo_daemon(state, &target, &app_config_path(&app)?, guard.as_ref().expect("lifecycle guard accompanies state"))
                .map_err(|e| format!("{e}. Live sessions may still be running — stop them from Settings → Harness, then try again."))?;
        }
        // One source of truth for "was this the active repo": the same normalization the
        // delist itself uses, computed after teardown so it reflects the config we write.
        let (cfg, was_active) = remove_repo_from_config(load_app_config(&app), &path)?;
        write_app_config(&app, &cfg)?;
        if was_active {
            if let Some(state) = state.as_ref() {
                state.kill_mcp_for_repo(&target);
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
    })
    .await
    .map_err(|error| format!("remove repository task: {error}"))?
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
    let Some(folder) = app.dialog().file().set_title("Choose a folder").blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder.into_path().map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
pub(crate) fn classify_picked_folder(path: String) -> Result<alinery_core::FolderClass, String> {
    alinery_core::classify_folder(Path::new(path.trim()))
}

#[tauri::command]
pub(crate) fn init_picked_folder(path: String) -> Result<alinery_core::InitFolder, String> {
    alinery_core::init_absent_folder(Path::new(path.trim()))
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
