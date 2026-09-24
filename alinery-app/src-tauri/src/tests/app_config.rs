//! Tests for app_config.rs — mcp_enabled logging via write_app_config_at.
use super::*;

fn temp_app(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let dir = unique_attachment_temp(name);
    let path = dir.join("app.toml");
    (dir, path)
}

fn log_text(app_config: &Path) -> String {
    fs::read_to_string(alinery_core::log_path(app_config)).unwrap_or_default()
}

#[test]
fn mcp_enabled_flip_logs_once() {
    let (dir, path) = temp_app("mcp-flip");
    let mut cfg = AppConfig::default();
    crate::write_app_config_at(&path, &cfg).unwrap();
    cfg.mcp_enabled = false;
    cfg.known_repos = vec!["/tmp/example".into()];
    crate::write_app_config_at(&path, &cfg).unwrap();
    let text = log_text(&path);
    let lines: Vec<&str> = text.lines().filter(|l| l.contains("settings.app")).collect();
    assert_eq!(lines.len(), 1, "{text}");
    assert!(lines[0].contains("settings.app mcp_enabled=false"), "{text}");
    assert!(!text.contains("appearance"), "{text}");
    assert!(!text.contains("known_repos"), "{text}");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn mcp_enabled_unchanged_is_silent() {
    let (dir, path) = temp_app("mcp-same");
    let cfg = AppConfig::default();
    crate::write_app_config_at(&path, &cfg).unwrap();
    crate::write_app_config_at(&path, &cfg).unwrap();
    let text = log_text(&path);
    assert!(!text.contains("settings.app"), "{text}");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn unparseable_prior_is_not_overwritten() {
    let (dir, path) = temp_app("mcp-garbage");
    let original = "this is not toml";
    fs::write(&path, original).unwrap();
    let result = crate::write_app_config_at(&path, &AppConfig::default());
    let retained = fs::read_to_string(&path).unwrap();
    let text = log_text(&path);
    let _ = fs::remove_dir_all(dir);
    assert!(result.is_err());
    assert_eq!(retained, original);
    assert!(!text.contains("settings.app"));
}

#[test]
fn legacy_playbook_default_keeps_repositories_and_appearance_on_save() {
    let (dir, path) = temp_app("legacy-default-integrity");
    let original = "active_repo='/keep'\nknown_repos=['/keep','/another']\n[appearance]\nui_scale=1.25\n[global.defaults]\nplaybook='superdevelop'\n";
    fs::write(&path, original).unwrap();
    let mut cfg: AppConfig = toml::from_str(original).unwrap();
    assert_eq!(cfg.active_repo, "/keep");
    assert_eq!(cfg.known_repos, ["/keep", "/another"]);
    assert_eq!(
        cfg.global.defaults.playbook,
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Bundled,
            key: "superdevelop".into(),
        }
    );
    cfg.appearance.chat_show_block_copy_buttons = false;
    crate::write_app_config_at(&path, &cfg).unwrap();
    let saved = fs::read_to_string(&path).unwrap();
    let reloaded: AppConfig = toml::from_str(&saved).unwrap();
    assert_eq!(reloaded.known_repos, cfg.known_repos);
    assert_eq!(reloaded.active_repo, cfg.active_repo);
    assert_eq!(reloaded.appearance.ui_scale, 1.25);
    assert!(!reloaded.appearance.chat_show_block_copy_buttons);
    let value: toml::Value = toml::from_str(&saved).unwrap();
    assert_eq!(value["global"]["defaults"]["playbook"]["scope"].as_str(), Some("bundled"));
    fs::remove_dir_all(dir).unwrap();
}
