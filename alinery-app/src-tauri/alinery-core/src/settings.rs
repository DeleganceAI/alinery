//! Global and repository settings load, persist, field-diff, and log redaction.
//!
//! `log.rs` owns record encoding, locking, rotation, and append. Privacy policy for
//! settings lives here so the typed writer and the raw-preserving MCP writer share one event path.

use std::collections::BTreeSet;
use std::fmt::Write;
use std::fs;
use std::path::Path;

use serde::Deserialize;

use crate::log::{append_exception, append_info, quote_log_value};
use crate::paths::{alinery_dir, config_toml_path};
use crate::types::{
    default_grid_views, default_telemetry_endpoint, GlobalSettings, GridViewDefinition, HarnessFile, RepoOverrides, TelemetryPrefs, DEFAULT_HARNESSES_TOML, MAX_GRID_VIEWS,
};

#[derive(Deserialize, Default)]
struct AppSettingsFile {
    #[serde(default)]
    global: GlobalSettings,
}

/// Prior on-disk value for a settings write. Parse failures carry no source text.
#[derive(Debug)]
pub enum LoadPrior<T> {
    Missing,
    Parsed(T),
    Unreadable(SettingsLogReason),
}

/// Stable log reason. `parse` never includes parser display text (that copies source lines).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettingsLogReason {
    pub kind: &'static str,
    pub line: Option<usize>,
    pub column: Option<usize>,
}

pub enum RepoSettingsEvent<'a> {
    Written { prior: &'a LoadPrior<RepoOverrides>, next: &'a RepoOverrides },
    UnparseableOverlay { source: &'a str, error: &'a toml::de::Error },
    WriteFailed { error: &'a str },
}

pub(crate) fn bundled_harness_file() -> HarnessFile {
    toml::from_str(DEFAULT_HARNESSES_TOML).unwrap_or_default()
}

pub fn default_global_settings() -> GlobalSettings {
    GlobalSettings {
        harnesses: bundled_harness_file(),
        ..Default::default()
    }
}
fn sort_grid_views_by_slot(mut views: Vec<GridViewDefinition>) -> Vec<GridViewDefinition> {
    let slots: BTreeSet<u8> = views.iter().map(|view| view.slot).collect();
    let complete_slots = slots.len() == views.len() && views.iter().all(|view| view.slot > 0 && usize::from(view.slot) <= views.len());
    if complete_slots {
        views.sort_by_key(|view| view.slot);
    }
    views
}

fn normalize_loaded_grid_views(views: Vec<GridViewDefinition>) -> Vec<GridViewDefinition> {
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    let mut normalized = Vec::new();
    for view in sort_grid_views_by_slot(views) {
        let id = view.id.trim();
        let name = view.name.trim();
        let name_key = name.to_lowercase();
        if id.is_empty() || name.is_empty() || !ids.insert(id.to_string()) || !names.insert(name_key) {
            continue;
        }
        normalized.push(GridViewDefinition {
            id: id.to_string(),
            name: name.to_string(),
            slot: normalized.len() as u8 + 1,
        });
        if normalized.len() == MAX_GRID_VIEWS {
            break;
        }
    }
    if normalized.is_empty() {
        default_grid_views()
    } else {
        normalized
    }
}

pub fn prepare_grid_views(views: Vec<GridViewDefinition>) -> Result<Vec<GridViewDefinition>, String> {
    if views.is_empty() {
        return Err("at least one Grid-based view is required".into());
    }
    if views.len() > MAX_GRID_VIEWS {
        return Err(format!("at most {MAX_GRID_VIEWS} Grid-based views are allowed"));
    }
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    let views = sort_grid_views_by_slot(views);
    let mut prepared = Vec::with_capacity(views.len());
    for view in views {
        let id = view.id.trim();
        let name = view.name.trim();
        if id.is_empty() || id != view.id {
            return Err("Grid-based view IDs must be non-blank and contain no surrounding whitespace".into());
        }
        if name.is_empty() {
            return Err("Grid-based view names must not be blank".into());
        }
        if !ids.insert(id.to_string()) {
            return Err(format!("duplicate Grid-based view ID: {id}"));
        }
        if !names.insert(name.to_lowercase()) {
            return Err(format!("duplicate Grid-based view name: {name}"));
        }
        prepared.push(GridViewDefinition {
            id: id.to_string(),
            name: name.to_string(),
            slot: prepared.len() as u8 + 1,
        });
    }
    Ok(prepared)
}

pub fn normalize_global_settings(mut global: GlobalSettings) -> GlobalSettings {
    if global.harnesses.harness.is_empty() {
        global.harnesses = bundled_harness_file();
    }
    global.grid_views = normalize_loaded_grid_views(global.grid_views);
    global
}

fn parse_global_settings(text: &str) -> Result<GlobalSettings, toml::de::Error> {
    let file: AppSettingsFile = toml::from_str(text)?;
    Ok(file.global)
}

pub fn load_global_settings(app_config: &Path) -> GlobalSettings {
    let Some(text) = fs::read_to_string(app_config).ok() else {
        return default_global_settings();
    };
    let Ok(global) = parse_global_settings(&text) else {
        return default_global_settings();
    };
    normalize_global_settings(global)
}

/// Missing settings inherit product defaults; present invalid/legacy values fail closed.
pub fn load_global_settings_strict(app_config: &Path) -> Result<GlobalSettings, String> {
    match fs::read_to_string(app_config) {
        Ok(text) => parse_global_settings(&text).map(normalize_global_settings).map_err(|error| {
            format!(
                "invalid global settings {} (playbook defaults require a scope-qualified v2 reference): {error}",
                app_config.display()
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(default_global_settings()),
        Err(error) => Err(format!("read settings {}: {error}", app_config.display())),
    }
}

pub fn load_repo_overrides_strict(repo: &Path) -> Result<RepoOverrides, String> {
    let path = config_toml_path(repo);
    match fs::read_to_string(&path) {
        Ok(text) => toml::from_str(&text).map_err(|error| {
            format!(
                "invalid repository settings {} (playbook defaults require a scope-qualified v2 reference): {error}",
                path.display()
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(RepoOverrides::default()),
        Err(error) => Err(format!("read settings {}: {error}", path.display())),
    }
}

pub fn prepare_telemetry_prefs(mut t: TelemetryPrefs) -> TelemetryPrefs {
    if t.prompted && t.enabled && t.install_id.is_empty() {
        t.install_id = uuid::Uuid::new_v4().to_string();
    }
    if t.endpoint.trim().is_empty() {
        t.endpoint = default_telemetry_endpoint();
    }
    t
}

fn line_column(source: &str, offset: usize) -> (usize, usize) {
    let mut line = 1usize;
    let mut column = 1usize;
    for (i, c) in source.char_indices() {
        if i >= offset {
            break;
        }
        if c == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    (line, column)
}

fn parse_reason(err: &toml::de::Error, source: &str) -> SettingsLogReason {
    match err.span() {
        Some(span) => {
            let (line, column) = line_column(source, span.start);
            SettingsLogReason {
                kind: "parse",
                line: Some(line),
                column: Some(column),
            }
        }
        None => SettingsLogReason {
            kind: "parse",
            line: None,
            column: None,
        },
    }
}

fn io_reason() -> SettingsLogReason {
    SettingsLogReason {
        kind: "io",
        line: None,
        column: None,
    }
}

fn push_reason(out: &mut String, reason: SettingsLogReason) {
    out.push_str("reason=");
    out.push_str(reason.kind);
    if let Some(line) = reason.line {
        let _ = write!(out, " line={line}");
    }
    if let Some(column) = reason.column {
        let _ = write!(out, " column={column}");
    }
}

fn try_load_global_settings(app_config: &Path) -> LoadPrior<GlobalSettings> {
    match fs::read_to_string(app_config) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => LoadPrior::Missing,
        Err(_) => LoadPrior::Unreadable(io_reason()),
        Ok(text) => match parse_global_settings(&text) {
            Ok(global) => LoadPrior::Parsed(global),
            Err(e) => LoadPrior::Unreadable(parse_reason(&e, &text)),
        },
    }
}

fn try_load_repo_overrides(repo: &Path) -> LoadPrior<RepoOverrides> {
    match fs::read_to_string(config_toml_path(repo)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => LoadPrior::Missing,
        Err(_) => LoadPrior::Unreadable(io_reason()),
        Ok(text) => repo_overrides_prior_from_text(Some(&text)),
    }
}

pub fn repo_overrides_prior_from_text(text: Option<&str>) -> LoadPrior<RepoOverrides> {
    match text {
        None => LoadPrior::Missing,
        Some(text) => match toml::from_str::<RepoOverrides>(text) {
            Ok(value) => LoadPrior::Parsed(value),
            Err(e) => LoadPrior::Unreadable(parse_reason(&e, text)),
        },
    }
}

pub fn write_global_settings(app_config: &Path, global: &GlobalSettings) -> Result<(), String> {
    let prior = try_load_global_settings(app_config);
    let mut global = global.clone();
    global.grid_views = prepare_grid_views(global.grid_views)?;
    global.telemetry = prepare_telemetry_prefs(global.telemetry);
    let next = normalize_global_settings(global);
    let mut root = fs::read_to_string(app_config)
        .ok()
        .and_then(|text| toml::from_str::<toml::Value>(&text).ok())
        .unwrap_or_else(|| toml::Value::Table(toml::map::Map::new()));
    let table = root.as_table_mut().ok_or_else(|| "app config must be a TOML table".to_string())?;
    table.insert("settings_version".into(), toml::Value::Integer(1));
    let global_toml = toml::to_string(&next).map_err(|e| e.to_string())?;
    let global_value = toml::from_str(&global_toml).map_err(|e| e.to_string())?;
    table.insert("global".into(), global_value);
    if let Some(parent) = app_config.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    match fs::write(app_config, toml::to_string(&root).map_err(|e| e.to_string())?) {
        Err(e) => {
            let mut message = format!("settings.global write-failed path={}", quote_log_value(&app_config.display().to_string()));
            message.push_str(" reason=io err=");
            message.push_str(&quote_log_value(&e.to_string()));
            append_exception(app_config, &message);
            Err(format!("write {}: {e}", app_config.display()))
        }
        Ok(()) => {
            match prior {
                LoadPrior::Unreadable(reason) => log_global_unreadable(app_config, reason),
                LoadPrior::Missing => log_global_diff(app_config, &default_global_settings(), &next),
                LoadPrior::Parsed(prev) => log_global_diff(app_config, &normalize_global_settings(prev), &next),
            }
            Ok(())
        }
    }
}

pub fn load_repo_overrides(repo: &Path) -> RepoOverrides {
    fs::read_to_string(config_toml_path(repo))
        .ok()
        .and_then(|text| toml::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn write_repo_overrides(app_config: Option<&Path>, repo: &Path, overrides: &RepoOverrides) -> Result<(), String> {
    let prior = app_config.map(|_| try_load_repo_overrides(repo));
    fs::create_dir_all(alinery_dir(repo)).map_err(|e| e.to_string())?;
    let path = config_toml_path(repo);
    match fs::write(&path, toml::to_string(overrides).map_err(|e| e.to_string())?) {
        Err(e) => {
            if let Some(cfg) = app_config {
                log_repo_settings_event(cfg, repo, RepoSettingsEvent::WriteFailed { error: &e.to_string() });
            }
            Err(format!("write {}: {e}", path.display()))
        }
        Ok(()) => {
            if let (Some(cfg), Some(prior)) = (app_config, prior) {
                log_repo_settings_event(cfg, repo, RepoSettingsEvent::Written { prior: &prior, next: overrides });
            }
            Ok(())
        }
    }
}

fn push_changed_bool(fields: &mut Vec<String>, key: &str, prev: bool, next: bool) {
    if prev != next {
        fields.push(format!("{key}={next}"));
    }
}

fn push_changed_quoted(fields: &mut Vec<String>, key: &str, prev: &str, next: &str) {
    if prev != next {
        fields.push(format!("{key}={}", quote_log_value(next)));
    }
}

fn push_changed_u8(fields: &mut Vec<String>, key: &str, prev: u8, next: u8) {
    if prev != next {
        fields.push(format!("{key}={next}"));
    }
}

fn push_opt_secret(fields: &mut Vec<String>, key: &str, prev: &Option<String>, next: &Option<String>) {
    if prev == next {
        return;
    }
    if prev.is_some() && next.is_none() {
        fields.push(format!("{key}=cleared"));
    } else {
        fields.push(format!("{key}=changed"));
    }
}

fn push_opt_quoted(fields: &mut Vec<String>, key: &str, prev: &Option<String>, next: &Option<String>) {
    match (prev, next) {
        (a, b) if a == b => {}
        (Some(_), None) => fields.push(format!("{key}=cleared")),
        (_, Some(value)) => fields.push(format!("{key}={}", quote_log_value(value))),
        (None, None) => {}
    }
}

fn push_opt_bool(fields: &mut Vec<String>, key: &str, prev: Option<bool>, next: Option<bool>) {
    match (prev, next) {
        (a, b) if a == b => {}
        (Some(_), None) => fields.push(format!("{key}=cleared")),
        (_, Some(value)) => fields.push(format!("{key}={value}")),
        (None, None) => {}
    }
}

fn push_opt_u8(fields: &mut Vec<String>, key: &str, prev: Option<u8>, next: Option<u8>) {
    match (prev, next) {
        (a, b) if a == b => {}
        (Some(_), None) => fields.push(format!("{key}=cleared")),
        (_, Some(value)) => fields.push(format!("{key}={value}")),
        (None, None) => {}
    }
}

fn log_global_unreadable(app_config: &Path, reason: SettingsLogReason) {
    let mut message = format!("settings.global unreadable path={}", quote_log_value(&app_config.display().to_string()));
    message.push(' ');
    push_reason(&mut message, reason);
    append_exception(app_config, &message);
}

fn log_global_diff(app_config: &Path, prev: &GlobalSettings, next: &GlobalSettings) {
    let mut fields = Vec::new();
    push_changed_bool(&mut fields, "notifications.enabled", prev.notifications.enabled, next.notifications.enabled);
    push_changed_bool(&mut fields, "notifications.sound", prev.notifications.sound, next.notifications.sound);
    push_changed_bool(&mut fields, "notifications.bounce", prev.notifications.bounce, next.notifications.bounce);
    push_changed_bool(&mut fields, "notifications.banner", prev.notifications.banner, next.notifications.banner);
    if prev.github.token != next.github.token {
        fields.push("github.token=changed".into());
    }
    push_changed_quoted(&mut fields, "defaults.harness", &prev.defaults.harness, &next.defaults.harness);
    push_changed_quoted(&mut fields, "defaults.model", &prev.defaults.model, &next.defaults.model);
    if prev.defaults.playbook != next.defaults.playbook {
        fields.push("defaults.playbook=changed".into());
    }
    push_changed_bool(&mut fields, "defaults.draft_autosave", prev.defaults.draft_autosave, next.defaults.draft_autosave);
    push_changed_quoted(&mut fields, "backup.destination", &prev.backup.destination, &next.backup.destination);
    push_changed_bool(&mut fields, "backup.enabled", prev.backup.enabled, next.backup.enabled);
    push_changed_u8(&mut fields, "backup.retention", prev.backup.retention, next.backup.retention);
    push_changed_bool(&mut fields, "backup.trigger_pre_archive", prev.backup.trigger_pre_archive, next.backup.trigger_pre_archive);
    push_changed_bool(
        &mut fields,
        "backup.trigger_post_artifact_change",
        prev.backup.trigger_post_artifact_change,
        next.backup.trigger_post_artifact_change,
    );
    push_changed_bool(
        &mut fields,
        "backup.trigger_post_push_commit",
        prev.backup.trigger_post_push_commit,
        next.backup.trigger_post_push_commit,
    );
    if prev.harnesses != next.harnesses {
        fields.push("harnesses=changed".into());
    }
    if prev.model_favorites != next.model_favorites {
        fields.push("model_favorites=changed".into());
    }
    push_changed_bool(&mut fields, "telemetry.enabled", prev.telemetry.enabled, next.telemetry.enabled);
    push_changed_bool(&mut fields, "telemetry.prompted", prev.telemetry.prompted, next.telemetry.prompted);
    if prev.telemetry.install_id != next.telemetry.install_id {
        fields.push("telemetry.install_id=changed".into());
    }
    push_changed_quoted(&mut fields, "telemetry.endpoint", &prev.telemetry.endpoint, &next.telemetry.endpoint);
    push_changed_bool(&mut fields, "updates.check_enabled", prev.updates.check_enabled, next.updates.check_enabled);
    push_changed_bool(
        &mut fields,
        "experiments.show_original_kanban",
        prev.experiments.show_original_kanban,
        next.experiments.show_original_kanban,
    );
    if prev.grid_views != next.grid_views {
        fields.push("grid_views=changed".into());
    }
    if fields.is_empty() {
        return;
    }
    append_info(app_config, &format!("settings.global {}", fields.join(" ")));
}

pub fn log_repo_settings_event(app_config: &Path, repo: &Path, event: RepoSettingsEvent<'_>) {
    match event {
        RepoSettingsEvent::Written { prior, next } => match prior {
            LoadPrior::Unreadable(reason) => {
                let mut message = format!("settings.repo unreadable repo={}", quote_log_value(&repo.display().to_string()));
                message.push(' ');
                push_reason(&mut message, *reason);
                append_exception(app_config, &message);
            }
            LoadPrior::Missing => log_repo_field_diff(app_config, repo, &RepoOverrides::default(), next),
            LoadPrior::Parsed(prev) => log_repo_field_diff(app_config, repo, prev, next),
        },
        RepoSettingsEvent::UnparseableOverlay { source, error } => {
            let mut message = format!("settings.repo unparseable-overlay repo={}", quote_log_value(&repo.display().to_string()));
            message.push(' ');
            push_reason(&mut message, parse_reason(error, source));
            append_exception(app_config, &message);
        }
        RepoSettingsEvent::WriteFailed { error } => {
            append_exception(
                app_config,
                &format!(
                    "settings.repo write-failed repo={} reason=io err={}",
                    quote_log_value(&repo.display().to_string()),
                    quote_log_value(error)
                ),
            );
        }
    }
}

fn log_repo_field_diff(app_config: &Path, repo: &Path, prev: &RepoOverrides, next: &RepoOverrides) {
    let mut fields = Vec::new();
    push_opt_secret(&mut fields, "github.token", &prev.github.token, &next.github.token);
    push_opt_quoted(&mut fields, "defaults.harness", &prev.defaults.harness, &next.defaults.harness);
    push_opt_quoted(&mut fields, "defaults.model", &prev.defaults.model, &next.defaults.model);
    if prev.defaults.playbook != next.defaults.playbook {
        fields.push("defaults.playbook=changed".into());
    }
    push_opt_bool(&mut fields, "defaults.draft_autosave", prev.defaults.draft_autosave, next.defaults.draft_autosave);
    push_opt_quoted(&mut fields, "backup.destination", &prev.backup.destination, &next.backup.destination);
    push_opt_bool(&mut fields, "backup.enabled", prev.backup.enabled, next.backup.enabled);
    push_opt_u8(&mut fields, "backup.retention", prev.backup.retention, next.backup.retention);
    push_opt_bool(&mut fields, "backup.trigger_pre_archive", prev.backup.trigger_pre_archive, next.backup.trigger_pre_archive);
    push_opt_bool(
        &mut fields,
        "backup.trigger_post_artifact_change",
        prev.backup.trigger_post_artifact_change,
        next.backup.trigger_post_artifact_change,
    );
    push_opt_bool(
        &mut fields,
        "backup.trigger_post_push_commit",
        prev.backup.trigger_post_push_commit,
        next.backup.trigger_post_push_commit,
    );
    if fields.is_empty() {
        return;
    }
    append_info(
        app_config,
        &format!("settings.repo repo={} {}", quote_log_value(&repo.display().to_string()), fields.join(" ")),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_path;
    use crate::types::RepoBackupOverrides;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp(name: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = TEST_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{name}_{}_{}_{}", std::process::id(), nanos, seq))
    }

    fn temp_app(name: &str) -> (PathBuf, PathBuf) {
        let dir = unique_temp(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        (dir.clone(), dir.join("app.toml"))
    }

    fn temp_pair(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let dir = unique_temp(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let app_config = dir.join("app.toml");
        let repo = dir.join("repo");
        fs::create_dir_all(alinery_dir(&repo)).unwrap();
        (dir, app_config, repo)
    }

    #[test]
    fn strict_defaults_reject_legacy_references_without_discarding_scope() {
        let (dir, app_config, repo) = temp_pair("strict-playbook-defaults");
        fs::write(&app_config, "[global.defaults]\nplaybook = 'superdevelop'\n").unwrap();
        assert!(load_global_settings_strict(&app_config).is_err());
        fs::write(&app_config, "[global.defaults.playbook]\nscope = 'global'\nkey = 'custom'\n").unwrap();
        let global = load_global_settings_strict(&app_config).unwrap();
        assert_eq!(global.defaults.playbook.scope, crate::playbook::PlaybookScope::Global);
        assert_eq!(global.defaults.playbook.key, "custom");
        fs::write(config_toml_path(&repo), "[defaults]\nplaybook = 'custom'\n").unwrap();
        assert!(crate::read_scoped_settings_strict(&app_config, &repo).is_err());
        fs::write(config_toml_path(&repo), "[defaults.playbook]\nscope = 'repo'\nkey = 'custom'\n").unwrap();
        let effective = crate::read_scoped_settings_strict(&app_config, &repo).unwrap().effective;
        assert_eq!(effective.defaults.playbook.scope, crate::playbook::PlaybookScope::Repo);
        assert_eq!(effective.defaults.playbook.key, "custom");
        fs::remove_dir_all(dir).unwrap();
    }

    fn log_text(app_config: &Path) -> String {
        fs::read_to_string(log_path(app_config)).unwrap_or_default()
    }

    fn all_log_generations(app_config: &Path) -> String {
        let dir = crate::logs_dir(app_config);
        let mut out = String::new();
        for name in ["alinery.log", "alinery.log.1", "alinery.log.2", "alinery.log.3", "alinery.log.4"] {
            if let Ok(text) = fs::read_to_string(dir.join(name)) {
                out.push_str(&text);
            }
        }
        out
    }

    #[test]
    fn grid_views_trim_names_follow_explicit_slots_and_keep_stable_ids() {
        let prepared = prepare_grid_views(vec![
            GridViewDefinition {
                id: "planning".into(),
                name: " Planning ".into(),
                slot: 2,
            },
            GridViewDefinition {
                id: "kanban-plus".into(),
                name: "Kanban+".into(),
                slot: 1,
            },
        ])
        .unwrap();
        assert_eq!(
            prepared,
            vec![
                GridViewDefinition {
                    id: "kanban-plus".into(),
                    name: "Kanban+".into(),
                    slot: 1,
                },
                GridViewDefinition {
                    id: "planning".into(),
                    name: "Planning".into(),
                    slot: 2,
                },
            ]
        );
    }

    #[test]
    fn grid_view_validation_rejects_empty_duplicate_and_excess_collections() {
        assert!(prepare_grid_views(Vec::new()).unwrap_err().contains("at least one"));
        assert!(prepare_grid_views(vec![
            GridViewDefinition {
                id: "one".into(),
                name: "Same".into(),
                slot: 1,
            },
            GridViewDefinition {
                id: "two".into(),
                name: "same".into(),
                slot: 2,
            },
        ])
        .unwrap_err()
        .contains("duplicate Grid-based view name"));
        let too_many = (0..=MAX_GRID_VIEWS)
            .map(|index| GridViewDefinition {
                id: format!("view-{index}"),
                name: format!("View {index}"),
                slot: index as u8 + 1,
            })
            .collect();
        assert!(prepare_grid_views(too_many).unwrap_err().contains("at most"));
    }
    #[test]
    fn global_diff_one_line_declaration_order() {
        let (dir, app_config) = temp_app("alinery_log_global_diff");
        write_global_settings(&app_config, &default_global_settings()).unwrap();
        let mut next = default_global_settings();
        next.notifications.enabled = false;
        next.backup.retention = 20;
        write_global_settings(&app_config, &next).unwrap();
        let text = log_text(&app_config);
        let lines: Vec<&str> = text.lines().filter(|l| l.contains("settings.global")).collect();
        assert_eq!(lines.len(), 1, "{text}");
        let n = lines[0].find("notifications.enabled=false").expect(lines[0]);
        let b = lines[0].find("backup.retention=20").expect(lines[0]);
        assert!(n < b, "{text}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn global_secret_and_harnesses_log_changed() {
        let (dir, app_config) = temp_app("alinery_log_global_secret");
        write_global_settings(&app_config, &default_global_settings()).unwrap();
        let mut next = default_global_settings();
        next.github.token = "sk-secret-material".into();
        next.harnesses.harness[0].binary = "/changed/omp".into();
        write_global_settings(&app_config, &next).unwrap();
        let text = log_text(&app_config);
        assert!(text.contains("github.token=changed"), "{text}");
        assert!(text.contains("harnesses=changed"), "{text}");
        assert!(!text.contains("sk-secret-material"), "{text}");
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn grid_settings_log_non_sensitive_changes() {
        let (dir, app_config) = temp_app("alinery_log_grid_settings");
        write_global_settings(&app_config, &default_global_settings()).unwrap();
        let mut next = default_global_settings();
        next.experiments.show_original_kanban = true;
        next.grid_views[0].name = "Private planning name".into();
        write_global_settings(&app_config, &next).unwrap();
        let text = log_text(&app_config);
        assert!(text.contains("experiments.show_original_kanban=true"), "{text}");
        assert!(text.contains("grid_views=changed"), "{text}");
        assert!(!text.contains("Private planning name"), "{text}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn telemetry_install_id_logs_changed_not_plaintext() {
        let (dir, app_config) = temp_app("alinery_log_tel_id");
        write_global_settings(&app_config, &default_global_settings()).unwrap();
        let mut next = default_global_settings();
        next.telemetry.prompted = true;
        next.telemetry.enabled = true;
        write_global_settings(&app_config, &next).unwrap();
        let text = log_text(&app_config);
        assert!(text.contains("telemetry.install_id=changed"), "{text}");
        assert!(text.contains("telemetry.prompted=true"), "{text}");
        let loaded = load_global_settings(&app_config);
        assert!(!loaded.telemetry.install_id.is_empty());
        assert!(!text.contains(&loaded.telemetry.install_id), "install_id leaked: {text}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn unreadable_prior_emits_exception_not_fake_diff() {
        let (dir, app_config) = temp_app("alinery_log_global_corrupt");
        fs::write(&app_config, "this is not toml").unwrap();
        write_global_settings(&app_config, &default_global_settings()).unwrap();
        let text = log_text(&app_config);
        assert!(text.contains("settings.global unreadable"), "{text}");
        assert!(text.contains("reason=parse"), "{text}");
        assert!(!text.contains("harnesses=changed"), "{text}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn equal_normalized_globals_emit_no_line() {
        let (dir, app_config) = temp_app("alinery_log_global_equal");
        let mut empty_harnesses = default_global_settings();
        empty_harnesses.harnesses = Default::default();
        write_global_settings(&app_config, &empty_harnesses).unwrap();
        let before = log_text(&app_config);
        write_global_settings(&app_config, &empty_harnesses).unwrap();
        assert_eq!(before, log_text(&app_config));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn malformed_global_secret_is_not_copied_into_any_log_generation() {
        let (dir, app_config) = temp_app("alinery_log_global_secret_parse");
        fs::write(&app_config, "[global.linear]\napi_key = \"sk-live-secret\n").unwrap();
        write_global_settings(&app_config, &default_global_settings()).unwrap();
        let text = all_log_generations(&app_config);
        assert!(text.contains("settings.global unreadable"), "{text}");
        assert!(text.contains("reason=parse"), "{text}");
        assert!(text.contains("line="), "{text}");
        assert!(!text.contains("sk-live-secret"), "{text}");
        assert!(!text.contains("api_key = "), "{text}");
        assert!(!text.contains("TOML parse error"), "{text}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn repo_diff_logs_when_app_config_supplied() {
        let (dir, app_config, repo) = temp_pair("alinery_log_repo_diff");
        let overrides = RepoOverrides {
            backup: RepoBackupOverrides {
                enabled: Some(true),
                ..Default::default()
            },
            ..Default::default()
        };
        write_repo_overrides(Some(&app_config), &repo, &overrides).unwrap();
        let text = log_text(&app_config);
        let quoted = quote_log_value(&repo.display().to_string());
        assert!(text.contains("settings.repo"), "{text}");
        assert!(text.contains(&format!("repo={quoted}")), "{text}");
        assert!(text.contains("backup.enabled=true"), "{text}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn repo_none_app_config_is_silent() {
        let (dir, app_config, repo) = temp_pair("alinery_log_repo_silent");
        let overrides = RepoOverrides {
            backup: RepoBackupOverrides {
                enabled: Some(true),
                ..Default::default()
            },
            ..Default::default()
        };
        write_repo_overrides(None, &repo, &overrides).unwrap();
        assert!(!log_text(&app_config).contains("settings.repo"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn repo_cleared_option_logs_cleared() {
        let (dir, app_config, repo) = temp_pair("alinery_log_repo_cleared");
        let prior = RepoOverrides {
            backup: RepoBackupOverrides {
                enabled: Some(true),
                ..Default::default()
            },
            ..Default::default()
        };
        write_repo_overrides(Some(&app_config), &repo, &prior).unwrap();
        write_repo_overrides(Some(&app_config), &repo, &RepoOverrides::default()).unwrap();
        assert!(log_text(&app_config).contains("backup.enabled=cleared"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn malformed_repo_secret_is_not_copied_into_any_log_generation() {
        let (dir, app_config, repo) = temp_pair("alinery_log_repo_secret_parse");
        fs::write(config_toml_path(&repo), "[linear]\napi_key = \"sk-live-secret\n").unwrap();
        write_repo_overrides(Some(&app_config), &repo, &RepoOverrides::default()).unwrap();
        let text = all_log_generations(&app_config);
        assert!(text.contains("settings.repo unreadable"), "{text}");
        assert!(text.contains("reason=parse"), "{text}");
        assert!(!text.contains("sk-live-secret"), "{text}");
        assert!(!text.contains("api_key = "), "{text}");
        assert!(!text.contains("TOML parse error"), "{text}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn unparseable_overlay_logs_reason_parse_without_source() {
        let (dir, app_config, repo) = temp_pair("alinery_log_repo_overlay");
        let source = "github = \"sk-overlay-secret\"\n";
        let err = toml::from_str::<RepoOverrides>(source).unwrap_err();
        log_repo_settings_event(&app_config, &repo, RepoSettingsEvent::UnparseableOverlay { source, error: &err });
        let text = all_log_generations(&app_config);
        assert!(text.contains("unparseable-overlay"), "{text}");
        assert!(text.contains("reason=parse"), "{text}");
        assert!(!text.contains("sk-overlay-secret"), "{text}");
        assert!(!text.contains("invalid type"), "{text}");
        let _ = fs::remove_dir_all(dir);
    }
}
