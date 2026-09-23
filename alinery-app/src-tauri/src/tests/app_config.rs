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
fn scoped_defaults_do_not_erase_legacy_app_configuration() {
    let (dir, path) = temp_app("legacy-default-integrity");
    let original = "active_repo='/keep'\nknown_repos=['/keep','/another']\n[global.defaults]\nplaybook='custom-v1'\n";
    fs::write(&path, original).unwrap();
    let result = crate::write_app_config_at(&path, &AppConfig::default());
    let retained = fs::read_to_string(&path).unwrap();
    fs::remove_dir_all(dir).unwrap();
    assert!(result.is_err(), "a settings edit must not replace an unsupported prior schema");
    assert_eq!(retained, original);
}
