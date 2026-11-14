//! Tests for settings.rs — config, harness registry, appearance
//!
//! `use super::*` reaches the shared imports and fixtures in tests/mod.rs.
use super::*;
use std::path::PathBuf;

#[test]
fn default_registry_parses_with_expected_shape() {
    let f: HarnessFile = toml::from_str(DEFAULT_HARNESSES_TOML).expect("bundled default registry must parse");
    let keys: Vec<&str> = f.harness.iter().map(|h| h.key.as_str()).collect();
    assert_eq!(keys, ["vinculum"]);

    let vinculum = f.harness.iter().find(|h| h.key == "vinculum").unwrap();
    assert_eq!(vinculum.adapter, alinery_core::HarnessAdapter::Vinculum);
    assert_eq!(vinculum.message_adapter, alinery_core::MessageAdapter::VinculumBracketedPaste);
    assert_eq!(vinculum.prompt_injection, "arg");
    assert_eq!(vinculum.prompt_arg, ["--", "{prompt}"]);
    assert_eq!(vinculum.prompt_arg.iter().map(|arg| arg.matches("{prompt}").count()).sum::<usize>(), 1);
    let resume = vinculum.resume.as_ref().expect("vinculum has [harness.resume]");
    assert!(resume.enabled);
    assert_eq!(resume.id_source, "manual");
    assert!(vinculum.models_cmd.contains("{binary}"), "models_cmd must use {{binary}}: {}", vinculum.models_cmd);
}

#[test]
fn bundled_registry_is_vinculum_only() {
    let f: HarnessFile = toml::from_str(DEFAULT_HARNESSES_TOML).expect("bundled default registry must parse");
    let keys: Vec<&str> = f.harness.iter().map(|h| h.key.as_str()).collect();
    assert_eq!(keys, ["vinculum"]);
    let vinculum = f.harness.iter().find(|h| h.key == "vinculum").unwrap();
    assert_eq!(vinculum.adapter, alinery_core::HarnessAdapter::Vinculum);
    assert_eq!(vinculum.message_adapter, alinery_core::MessageAdapter::VinculumBracketedPaste);
    let resume = vinculum.resume.as_ref().expect("vinculum has [harness.resume]");
    assert!(resume.enabled);
    assert_eq!(resume.id_source, "manual");
}

#[test]
fn message_adapter_defaults_parses_and_rejects_unknown_names() {
    let legacy: HarnessFile = toml::from_str(
        r#"
[[harness]]
key = "legacy"
name = "Legacy"
binary = "legacy"
"#,
    )
    .unwrap();
    assert_eq!(legacy.harness[0].message_adapter, alinery_core::MessageAdapter::Unsupported);

    let supported: HarnessFile = toml::from_str(
        r#"
[[harness]]
key = "vinculum"
name = "Vinculum"
binary = "vinculum"
message_adapter = "vinculum_bracketed_paste"
"#,
    )
    .unwrap();
    assert_eq!(supported.harness[0].message_adapter, alinery_core::MessageAdapter::VinculumBracketedPaste);

    assert!(toml::from_str::<HarnessFile>(
        r#"
[[harness]]
key = "unknown"
name = "Unknown"
binary = "unknown"
message_adapter = "guessed"
"#
    )
    .is_err());
}

#[test]
fn app_config_defaults_round_trips_and_dedupes() {
    let empty: AppConfig = toml::from_str("").expect("missing app config means defaults");
    assert_eq!(empty.active_repo, "");
    assert!(empty.known_repos.is_empty());
    assert!(empty.mcp_enabled);

    let cfg = sanitize_app_config(AppConfig {
        active_repo: " /repo/a ".into(),
        known_repos: vec!["/repo/a".into(), "/repo/a".into(), "  ".into(), "/repo/b".into()],
        mcp_enabled: true,
        appearance: AppearancePrefs::default(),
        ..Default::default()
    });
    assert_eq!(cfg.active_repo, "/repo/a");
    assert_eq!(cfg.known_repos, vec!["/repo/a".to_string(), "/repo/b".to_string()]);

    let s = toml::to_string(&cfg).expect("app config serializes");
    let back: AppConfig = toml::from_str(&s).expect("app config re-parses");
    assert_eq!(back.active_repo, "/repo/a");
    assert_eq!(back.known_repos, cfg.known_repos);
}

#[test]
fn remove_repo_delists_and_reports_active() {
    let cfg = || AppConfig {
        active_repo: "/repo/a".into(),
        known_repos: vec!["/repo/a".into(), "/repo/b".into()],
        ..Default::default()
    };

    // Inactive repo: list shrinks, active selection untouched.
    let (out, was_active) = remove_repo_from_config(cfg(), "/repo/b").expect("removes b");
    assert!(!was_active);
    assert_eq!(out.active_repo, "/repo/a");
    assert_eq!(out.known_repos, vec!["/repo/a".to_string()]);

    // Active repo: must be cleared, else sanitize_app_config re-adds it to known_repos.
    let (out, was_active) = remove_repo_from_config(cfg(), " /repo/a ").expect("removes a");
    assert!(was_active);
    assert_eq!(out.active_repo, "");
    assert_eq!(out.known_repos, vec!["/repo/b".to_string()]);

    // Last repo out leaves an empty list (frontend falls back to the picker).
    let (out, _) = remove_repo_from_config(
        AppConfig {
            active_repo: "/repo/a".into(),
            known_repos: vec!["/repo/a".into()],
            ..Default::default()
        },
        "/repo/a",
    )
    .expect("removes the only repo");
    assert_eq!(out.active_repo, "");
    assert!(out.known_repos.is_empty());

    assert!(remove_repo_from_config(cfg(), "/repo/zzz").is_err());
    assert!(remove_repo_from_config(cfg(), "   ").is_err());
}

#[test]
fn appearance_defaults_sanitize_and_round_trip() {
    // Empty TOML yields system appearance defaults.
    let empty: AppConfig = toml::from_str("").expect("empty toml parses");
    assert_eq!(empty.appearance.accent_color, "#315bff");
    assert!((empty.appearance.ui_scale - 1.0).abs() < f64::EPSILON);
    assert_eq!(empty.appearance.terminal_font_size, 13);
    assert_eq!(empty.appearance.artifact_viewer_width, 360);
    assert!(!empty.appearance.chat_show_thinking);
    assert!(!empty.appearance.chat_expand_thinking);
    assert!(!empty.appearance.chat_show_tools);
    assert!(!empty.appearance.chat_expand_tools);
    assert!(empty.appearance.chat_show_harness);
    assert!(!empty.appearance.chat_show_turn_markers);
    assert!(empty.appearance.chat_show_subagent_rows);
    assert!(empty.appearance.chat_show_subagent_drawer);
    assert!(empty.appearance.chat_auto_collapse_thinking);
    assert!(empty.appearance.chat_auto_compaction);
    assert_eq!(empty.appearance.chat_compaction_basis, "percent");
    assert_eq!(empty.appearance.chat_compaction_percent, 80);
    assert_eq!(empty.appearance.chat_compaction_tokens, 128_000);
    assert!(empty.appearance.chat_auto_scroll);
    assert_eq!(empty.appearance.chat_rail_density, "normal");
    assert_eq!(empty.appearance.chat_font_size, 14);
    assert_eq!(empty.appearance.chat_rail_font_size, 12);
    assert!(empty.appearance.chat_show_meta);
    assert!(empty.appearance.chat_show_composer_hints);
    assert_eq!(empty.appearance.chat_max_width, "900");
    assert!(empty.appearance.chat_show_date);
    assert!(empty.appearance.chat_show_time);
    assert!(empty.appearance.chat_show_actor_labels);
    assert!(empty.appearance.chat_show_agent_bubbles);
    assert!(empty.appearance.chat_show_block_copy_buttons);
    assert!(empty.appearance.chat_show_copy_buttons);
    assert_eq!(empty.appearance.session_default_view, "chat");
    assert_eq!(empty.appearance.startup_view, "list");

    let old_default = AppearancePrefs {
        accent_color: "#38459D".into(),
        ..AppearancePrefs::default()
    };
    assert_eq!(sanitize_appearance(old_default).accent_color, "#38459d");

    // A pre-reskin config (no mode key) defaults to following the OS appearance.
    assert_eq!(empty.appearance.mode, "system");

    // Valid appearance settings serialize and re-parse.
    let custom = AppearancePrefs {
        accent_color: "#5566BF".into(),
        ui_scale: 1.25,
        terminal_font_size: 16,
        artifact_font_size: 15,
        artifact_viewer_width: 480,
        chat_show_thinking: true,
        chat_expand_thinking: false,
        chat_show_tools: true,
        chat_expand_tools: false,
        chat_show_harness: false,
        chat_show_turn_markers: false,
        chat_show_subagent_rows: false,
        chat_show_subagent_drawer: false,
        chat_auto_collapse_thinking: false,
        chat_auto_compaction: false,
        chat_compaction_basis: "tokens".into(),
        chat_compaction_percent: 40,
        chat_compaction_tokens: 50_000,
        chat_auto_scroll: false,
        chat_rail_density: "compact".into(),
        chat_font_size: 16,
        chat_rail_font_size: 13,
        chat_show_meta: false,
        chat_show_composer_hints: false,
        chat_max_width: "1200".into(),
        chat_show_date: false,
        chat_show_time: true,
        chat_show_actor_labels: false,
        chat_show_agent_bubbles: false,
        chat_show_block_copy_buttons: false,
        chat_show_copy_buttons: false,
        session_default_view: "terminal".into(),
        startup_view: "grid:custom-board".into(),
        mode: "light".into(),
        ava_chat: std::collections::BTreeMap::from([
            ("chat_show_tools".into(), toml::Value::Boolean(true)),
            ("chat_max_width".into(), toml::Value::String("600".into())),
            ("not_a_chat_key".into(), toml::Value::Boolean(true)),
        ]),
    };
    let s = toml::to_string(&custom).expect("appearance serializes");
    let back: AppearancePrefs = toml::from_str(&s).expect("appearance re-parses");
    assert_eq!(back.accent_color, "#5566BF");
    assert!((back.ui_scale - 1.25).abs() < f64::EPSILON);
    assert_eq!(back.terminal_font_size, 16);
    assert_eq!(back.mode, "light");
    assert_eq!(back.artifact_viewer_width, 480);
    assert_eq!(back.chat_max_width, "1200");
    assert!(!back.chat_show_date);
    assert!(back.chat_show_time);
    assert!(!sanitize_appearance(back.clone()).chat_show_actor_labels);
    assert!(!sanitize_appearance(back.clone()).chat_show_agent_bubbles);
    assert!(!sanitize_appearance(back.clone()).chat_show_block_copy_buttons);
    assert!(!back.chat_show_copy_buttons);
    let ava = sanitize_appearance(back.clone()).ava_chat;
    assert_eq!(ava.get("chat_show_tools"), Some(&toml::Value::Boolean(true)));
    assert_eq!(ava.get("chat_max_width"), Some(&toml::Value::String("600".into())));
    assert!(!ava.contains_key("not_a_chat_key"));
    assert_eq!(back.chat_rail_font_size, 13);
    assert_eq!(back.session_default_view, "terminal");
    assert_eq!(back.chat_compaction_basis, "tokens");
    assert_eq!(back.chat_compaction_percent, 40);
    assert_eq!(back.chat_compaction_tokens, 50_000);
    assert_eq!(back.startup_view, "grid:custom-board");
    let clamped = sanitize_appearance(AppearancePrefs {
        chat_compaction_basis: "loud".into(),
        chat_compaction_percent: 0,
        chat_compaction_tokens: 99_000_000,
        ..AppearancePrefs::default()
    });
    assert_eq!(clamped.chat_compaction_basis, "percent");
    assert_eq!(clamped.chat_compaction_percent, 1);
    assert_eq!(clamped.chat_compaction_tokens, 10_000_000);

    // Legacy compact sanitizes to dense.
    assert_eq!(
        sanitize_appearance(AppearancePrefs {
            chat_rail_density: "compact".into(),
            ..AppearancePrefs::default()
        })
        .chat_rail_density,
        "dense"
    );
    // Legacy color tables are ignored so old presets migrate to the branded pair.
    let legacy: AppearancePrefs = toml::from_str(
        r##"
ui_scale = 1.25
terminal_font_size = 16
artifact_font_size = 15
mode = "dark"

[colors]
primary = "#ff00ff"
"##,
    )
    .expect("legacy appearance parses");
    assert_eq!(legacy.accent_color, "#315bff");
    assert_eq!(legacy.mode, "dark");
    assert_eq!(legacy.startup_view, "list");
    assert!(legacy.chat_show_actor_labels);
    assert!(legacy.chat_show_agent_bubbles);
    assert!(legacy.chat_show_block_copy_buttons);
    let serialized = toml::to_string(&legacy).expect("legacy appearance serializes");
    assert!(!serialized.contains("colors"));

    // An unknown mode sanitizes back to "system"; valid ones survive.
    let weird_mode = AppearancePrefs {
        mode: "neon".into(),
        ..AppearancePrefs::default()
    };
    assert_eq!(sanitize_appearance(weird_mode).mode, "system");
    let dark_mode = AppearancePrefs {
        mode: "dark".into(),
        ..AppearancePrefs::default()
    };
    assert_eq!(sanitize_appearance(dark_mode).mode, "dark");

    let invalid_accent = AppearancePrefs {
        accent_color: "blue".into(),
        ..AppearancePrefs::default()
    };
    assert_eq!(sanitize_appearance(invalid_accent).accent_color, "#315bff");
    // ui_scale snaps to the nearest notch and clamps above range to 1.5
    let between = AppearancePrefs {
        ui_scale: 1.37,
        ..AppearancePrefs::default()
    };
    assert!((sanitize_appearance(between).ui_scale - 1.375).abs() < f64::EPSILON);
    let big = AppearancePrefs {
        ui_scale: 9.0,
        ..AppearancePrefs::default()
    };
    assert!((sanitize_appearance(big).ui_scale - 1.5).abs() < f64::EPSILON);

    // terminal_font_size = 1 sanitizes to 8
    let small = AppearancePrefs {
        terminal_font_size: 1,
        ..AppearancePrefs::default()
    };
    assert_eq!(sanitize_appearance(small).terminal_font_size, 8);
    let narrow = AppearancePrefs {
        artifact_viewer_width: 1,
        ..AppearancePrefs::default()
    };
    assert_eq!(sanitize_appearance(narrow).artifact_viewer_width, 260);
    let wide = AppearancePrefs {
        artifact_viewer_width: 9000,
        ..AppearancePrefs::default()
    };
    assert_eq!(sanitize_appearance(wide).artifact_viewer_width, 2400);
    let weird_width = AppearancePrefs {
        chat_max_width: "loud".into(),
        ..AppearancePrefs::default()
    };
    assert_eq!(sanitize_appearance(weird_width).chat_max_width, "900");
    let wide_chat = AppearancePrefs {
        chat_max_width: "600".into(),
        ..AppearancePrefs::default()
    };
    assert_eq!(sanitize_appearance(wide_chat).chat_max_width, "600");
    let weird_view = AppearancePrefs {
        session_default_view: "loud".into(),
        ..AppearancePrefs::default()
    };
    assert_eq!(sanitize_appearance(weird_view).session_default_view, "chat");
}

#[test]
fn startup_view_sanitization() {
    for view in ["list", "sessions", "kanban", "chat", "notifications", "playbooks", "settings", "grid:custom-board"] {
        let prefs = AppearancePrefs {
            startup_view: format!(" {view} "),
            ..AppearancePrefs::default()
        };
        assert_eq!(sanitize_appearance(prefs).startup_view, view);
    }
    for view in ["", " ", "task", "terminal", "grid", "grid:", "grid: "] {
        let prefs = AppearancePrefs {
            startup_view: view.into(),
            ..AppearancePrefs::default()
        };
        assert_eq!(sanitize_appearance(prefs).startup_view, "list");
    }
}

#[test]
fn notification_badge_preferences_default_on() {
    let config: AppConfig = toml::from_str(
        r#"
[global.notifications]
enabled = false
sound = false
bounce = true
banner = false
"#,
    )
    .expect("legacy notification settings parse");
    let notifications = config.global.notifications;
    assert!(!notifications.enabled);
    assert!(!notifications.sound);
    assert!(notifications.bounce);
    assert!(!notifications.banner);
    assert!(notifications.dock_badge);
    assert!(notifications.dock_badge_input_waits);
    assert!(notifications.dock_badge_approval_waits);
    assert!(notifications.dock_badge_failures);
    assert!(notifications.dock_badge_completions);

    let defaults = AppConfig::default().global.notifications;
    assert!(defaults.dock_badge);
    assert!(defaults.dock_badge_input_waits);
    assert!(defaults.dock_badge_approval_waits);
    assert!(defaults.dock_badge_failures);
    assert!(defaults.dock_badge_completions);
}

#[test]
fn notification_badge_preferences_preserve_explicit_false() {
    let config: AppConfig = toml::from_str(
        r#"
[global.notifications]
enabled = true
sound = false
bounce = true
banner = false
dock_badge = false
dock_badge_input_waits = false
dock_badge_approval_waits = false
dock_badge_failures = false
dock_badge_completions = false
"#,
    )
    .expect("notification settings parse");
    let encoded = toml::to_string(&config).expect("notification settings serialize");
    let round_trip: AppConfig = toml::from_str(&encoded).expect("notification settings reparse");
    let notifications = round_trip.global.notifications;
    assert!(notifications.enabled);
    assert!(!notifications.sound);
    assert!(notifications.bounce);
    assert!(!notifications.banner);
    assert!(!notifications.dock_badge);
    assert!(!notifications.dock_badge_input_waits);
    assert!(!notifications.dock_badge_approval_waits);
    assert!(!notifications.dock_badge_failures);
    assert!(!notifications.dock_badge_completions);
}

// ---- draft tasks (M6) — red until implementation lands ----

#[test]
fn draft_autosave_round_trips_via_toml() {
    let c: RepoOverrides = toml::from_str(
        r#"
[defaults]
draft_autosave = false
model = ""
"#,
    )
    .expect("repo override config parses");
    assert_eq!(c.defaults.draft_autosave, Some(false));
    assert_eq!(c.defaults.model.as_deref(), Some(""));
    let s = toml::to_string(&c).expect("config serializes");
    let back: RepoOverrides = toml::from_str(&s).expect("config re-parses");
    assert_eq!(back.defaults.draft_autosave, Some(false));
    assert_eq!(back.defaults.model.as_deref(), Some(""));
}

fn model_favorite_app_config(name: &str) -> (PathBuf, PathBuf) {
    let root = unique_attachment_temp(name);
    let app_config = root.join("app.toml");
    (root, app_config)
}

#[test]
fn model_favorite_legacy_settings_default_and_toml_order() {
    let (root, app_config) = model_favorite_app_config("model-favorite-legacy");
    fs::write(
        &app_config,
        "settings_version = 1\n\n[global.notifications]\nenabled = false\nsound = true\nbounce = false\nbanner = true\n",
    )
    .unwrap();

    let legacy = alinery_core::load_global_settings(&app_config);
    assert!(legacy.model_favorites.is_empty());
    assert!(read_model_favorites_in(&app_config, "missing").is_empty());

    assert_eq!(set_model_favorite_in(&app_config, "opencode", "provider/z", true).unwrap(), ["provider/z"]);
    assert_eq!(set_model_favorite_in(&app_config, "opencode", "provider/a", true).unwrap(), ["provider/z", "provider/a"]);
    assert_eq!(set_model_favorite_in(&app_config, "claude", " sonnet ", true).unwrap(), [" sonnet "]);
    assert_eq!(set_model_favorite_in(&app_config, "claude", "opus", true).unwrap(), [" sonnet ", "opus"]);

    let text = fs::read_to_string(&app_config).unwrap();
    assert!(text.contains("[global.model_favorites]"));
    assert!(text.find("claude =").unwrap() < text.find("opencode =").unwrap());
    let reloaded = alinery_core::load_global_settings(&app_config);
    assert_eq!(reloaded.model_favorites["claude"], [" sonnet ", "opus"]);
    assert_eq!(reloaded.model_favorites["opencode"], ["provider/z", "provider/a"]);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn model_favorite_mutation_is_exact_idempotent_and_ordered() {
    let (root, app_config) = model_favorite_app_config("model-favorite-exact");
    let mut global = alinery_core::default_global_settings();
    global
        .model_favorites
        .insert("claude".into(), vec!["Opus".into(), " opus ".into(), "sonnet".into(), "opus".into(), "sonnet".into()]);
    alinery_core::write_global_settings(&app_config, &global).unwrap();

    assert_eq!(
        set_model_favorite_in(&app_config, "claude", "opus", true).unwrap(),
        ["Opus", " opus ", "sonnet", "opus", "sonnet"]
    );
    assert_eq!(
        set_model_favorite_in(&app_config, "claude", "OPUS", true).unwrap(),
        ["Opus", " opus ", "sonnet", "opus", "sonnet", "OPUS"]
    );
    assert_eq!(
        set_model_favorite_in(&app_config, "claude", "  model with spaces  ", true).unwrap(),
        ["Opus", " opus ", "sonnet", "opus", "sonnet", "OPUS", "  model with spaces  "]
    );
    assert_eq!(
        set_model_favorite_in(&app_config, "claude", "sonnet", false).unwrap(),
        ["Opus", " opus ", "opus", "OPUS", "  model with spaces  "]
    );
    assert_eq!(
        set_model_favorite_in(&app_config, "claude", "missing", false).unwrap(),
        ["Opus", " opus ", "opus", "OPUS", "  model with spaces  "]
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn model_favorite_rejects_blank_inputs_without_writing() {
    let (root, app_config) = model_favorite_app_config("model-favorite-invalid");
    let mut global = alinery_core::default_global_settings();
    global.model_favorites.insert("claude".into(), vec!["opus".into()]);
    alinery_core::write_global_settings(&app_config, &global).unwrap();

    for (harness, model) in [("", "opus"), (" \t\n ", "opus"), ("claude", ""), ("claude", " \t\n ")] {
        for favorite in [true, false] {
            let before = fs::read(&app_config).unwrap();
            assert!(set_model_favorite_in(&app_config, harness, model, favorite).is_err());
            assert_eq!(fs::read(&app_config).unwrap(), before);
        }
    }
    assert_eq!(read_model_favorites_in(&app_config, "claude"), ["opus"]);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn model_favorite_mutation_preserves_other_settings_and_harnesses() {
    let (root, app_config) = model_favorite_app_config("model-favorite-isolation");
    let mut global = alinery_core::default_global_settings();
    global.notifications.sound = false;
    global.telemetry.enabled = false;
    global.updates.check_enabled = false;
    global.defaults.harness = "opencode".into();
    global.defaults.model = "default-model".into();
    global.backup.enabled = true;
    global.backup.destination = "/tmp/backups".into();
    global.model_favorites.insert("claude".into(), vec!["unavailable-old".into(), "opus".into()]);
    global
        .model_favorites
        .insert("opencode".into(), vec!["anthropic/claude-sonnet-4-5".into(), "unknown-provider/model".into()]);
    alinery_core::write_global_settings(&app_config, &global).unwrap();

    assert_eq!(set_model_favorite_in(&app_config, "claude", "sonnet", true).unwrap(), ["unavailable-old", "opus", "sonnet"]);
    assert_eq!(set_model_favorite_in(&app_config, "claude", "opus", false).unwrap(), ["unavailable-old", "sonnet"]);

    let actual = alinery_core::load_global_settings(&app_config);
    assert_eq!(actual.model_favorites["opencode"], ["anthropic/claude-sonnet-4-5", "unknown-provider/model"]);
    let mut actual_without_mutation = actual.clone();
    actual_without_mutation.model_favorites = global.model_favorites.clone();
    assert_eq!(actual_without_mutation, global);
    assert!(!root.join("repo/.alinery/config.toml").exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn obsolete_distill_settings_are_ignored_without_rewriting() {
    let (root, app_config) = model_favorite_app_config("obsolete-distill-settings");
    let text = r#"[global.distill]
harness = "claude"
model = "legacy"

[global.defaults]
harness = "codex"
"#;
    fs::write(&app_config, text).unwrap();

    let loaded = alinery_core::load_global_settings(&app_config);

    assert_eq!(loaded.defaults.harness, "codex");
    assert_eq!(fs::read_to_string(&app_config).unwrap(), text);
    assert!(!toml::to_string(&loaded).unwrap().contains("[distill]"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn model_favorite_stale_whole_write_preserves_latest_map() {
    let (root, app_config) = model_favorite_app_config("model-favorite-stale");
    alinery_core::write_global_settings(&app_config, &alinery_core::default_global_settings()).unwrap();
    let mut stale = alinery_core::load_global_settings(&app_config);

    assert_eq!(set_model_favorite_in(&app_config, "claude", "opus", true).unwrap(), ["opus"]);
    stale.updates.check_enabled = false;
    let (previous, next) = write_global_settings_in(&app_config, stale).unwrap();

    assert_eq!(previous.model_favorites["claude"], ["opus"]);
    assert!(previous.updates.check_enabled);
    assert_eq!(next.model_favorites["claude"], ["opus"]);
    assert!(!next.updates.check_enabled);
    assert_eq!(alinery_core::load_global_settings(&app_config), next);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn write_global_settings_command_does_not_rewrite_app_config() {
    let dir = unique_attachment_temp("global-cmd-no-rewrite");
    let path = dir.join("app.toml");
    fs::write(&path, "foo = 1\n[appearance]\nui_scale = 1.125\n[global]\n").unwrap();
    alinery_core::write_global_settings(&path, &alinery_core::default_global_settings()).unwrap();
    let _loaded = alinery_core::load_global_settings(&path);
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("foo = 1") || text.contains("foo=1"), "{text}");
    assert!(text.contains("[appearance]"), "{text}");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn default_models_cmd_uses_binary_placeholder() {
    let f: HarnessFile = toml::from_str(DEFAULT_HARNESSES_TOML).expect("bundled default registry must parse");
    let vinculum = f.harness.iter().find(|h| h.key == "vinculum").unwrap();
    assert!(vinculum.models_cmd.contains("{binary}"));
    assert!(!vinculum.models_cmd.contains("vinculum models"));
}

#[test]
fn shell_quote_keeps_hostile_paths_one_literal_word() {
    // The trailing `extra` word is the tell: if quoting leaked, the path splits into extra
    // fields (space), swallows them (unbalanced quote), or runs something else (`;`, `$()`).
    for path in [
        "/Applications/My App/vinculum",
        "/tmp/it's here/vinculum",
        "/tmp/vinculum; echo pwned",
        "/tmp/$HOME/vinculum",
        "/tmp/$(echo pwned)/o'mp",
    ] {
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("printf '%s|' {} extra", crate::shell_quote(path)))
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), format!("{path}|extra|"), "quoting leaked for {path}");
    }
}
