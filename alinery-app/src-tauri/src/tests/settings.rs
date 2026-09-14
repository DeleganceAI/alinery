//! Tests for settings.rs — config, harness registry, appearance
//!
//! `use super::*` reaches the shared imports and fixtures in tests/mod.rs.
use super::*;
use std::path::PathBuf;

#[test]
fn subst_placeholders() {
    assert_eq!(subst("--chdir {worktree}", "/wt", "", ""), "--chdir /wt");
    assert_eq!(subst("{model}", "/wt", "opus", ""), "opus");
    assert_eq!(subst("noliteral", "/wt", "m", ""), "noliteral");
}

#[test]
fn default_registry_parses_with_expected_shape() {
    let f: HarnessFile = toml::from_str(DEFAULT_HARNESSES_TOML).expect("bundled default registry must parse");
    let keys: Vec<&str> = f.harness.iter().map(|h| h.key.as_str()).collect();
    assert_eq!(keys, ["omp"]);

    let omp = f.harness.iter().find(|h| h.key == "omp").unwrap();
    assert_eq!(omp.adapter, alinery_core::HarnessAdapter::Omp);
    assert_eq!(omp.message_adapter, alinery_core::MessageAdapter::OmpBracketedPaste);
    assert_eq!(omp.prompt_injection, "arg");
    assert_eq!(omp.prompt_arg, ["--", "{prompt}"]);
    assert_eq!(omp.prompt_arg.iter().map(|arg| arg.matches("{prompt}").count()).sum::<usize>(), 1);
    let resume = omp.resume.as_ref().expect("omp has [harness.resume]");
    assert!(resume.enabled);
    assert_eq!(resume.id_source, "manual");
    assert!(omp.models_cmd.contains("{binary}"), "models_cmd must use {{binary}}: {}", omp.models_cmd);
    assert!(!omp.models_cmd.contains("omp models"), "models_cmd must not PATH-exec omp: {}", omp.models_cmd);
}

#[test]
fn bundled_registry_is_omp_only() {
    let f: HarnessFile = toml::from_str(DEFAULT_HARNESSES_TOML).expect("bundled default registry must parse");
    let keys: Vec<&str> = f.harness.iter().map(|h| h.key.as_str()).collect();
    assert_eq!(keys, ["omp"]);
    let omp = f.harness.iter().find(|h| h.key == "omp").unwrap();
    assert_eq!(omp.adapter, alinery_core::HarnessAdapter::Omp);
    assert_eq!(omp.message_adapter, alinery_core::MessageAdapter::OmpBracketedPaste);
    let resume = omp.resume.as_ref().expect("omp has [harness.resume]");
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
key = "omp"
name = "OMP"
binary = "omp"
message_adapter = "omp_bracketed_paste"
"#,
    )
    .unwrap();
    assert_eq!(supported.harness[0].message_adapter, alinery_core::MessageAdapter::OmpBracketedPaste);

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
    assert_eq!(empty.appearance.session_default_view, "chat");

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
        chat_auto_scroll: false,
        chat_rail_density: "compact".into(),
        chat_font_size: 16,
        chat_rail_font_size: 13,
        chat_show_meta: false,
        chat_show_composer_hints: false,
        chat_max_width: "1200".into(),
        chat_show_date: false,
        chat_show_time: true,
        chat_show_actor_labels: true,
        chat_show_agent_bubbles: true,
        session_default_view: "terminal".into(),
        mode: "light".into(),
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
    assert!(back.chat_show_actor_labels);
    assert!(back.chat_show_agent_bubbles);
    assert_eq!(back.chat_rail_font_size, 13);
    assert_eq!(back.session_default_view, "terminal");

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

#[test]
fn default_config_parses_as_partial_repo_overrides() {
    let repo_overrides: RepoOverrides = toml::from_str(DEFAULT_CONFIG_TOML).expect("bundled repo config must parse");
    assert_eq!(repo_overrides.github.token, None);
    assert_eq!(repo_overrides.defaults.model, None);

    let global = alinery_core::default_global_settings();
    let effective = alinery_core::resolve_effective_config(&global, &repo_overrides);
    assert!(effective.notifications.enabled);
    assert!(effective.notifications.sound);
    assert!(!effective.notifications.bounce, "dock bounce defaults OFF");
    assert!(effective.notifications.banner);
    assert!(effective.defaults.draft_autosave);
    assert!(effective.telemetry.enabled);

    let legacy = r#"
[notifications]
enabled = false
sound = false
bounce = true
banner = false

[telemetry]
enabled = false

[linear]
api_key = "lin_x"

[github]
token = "gh_x"
"#;
    let legacy_overrides: RepoOverrides = toml::from_str(legacy).expect("legacy repo config parses");
    assert_eq!(legacy_overrides.github.token.as_deref(), Some("gh_x"));
    let effective = alinery_core::resolve_effective_config(&global, &legacy_overrides);
    assert!(effective.notifications.enabled, "legacy repo notifications are ignored");
    assert!(effective.telemetry.enabled, "legacy repo telemetry is ignored");
    assert_eq!(effective.github.token, "gh_x");
}

#[test]
fn strips_queries_keeps_output() {
    // DA (ESC[c, ESC[0c), DSR (ESC[6n) dropped; visible text + SGR color kept.
    let input = b"\x1b[6nhello \x1b[31mred\x1b[0m\x1b[c world\x1b[0c!";
    assert_eq!(strip_terminal_queries(input), b"hello \x1b[31mred\x1b[0m world!".to_vec());
    // OSC color *query* (ESC]10;?BEL) dropped; OSC title set (ESC]0;hiBEL) kept.
    let osc = b"\x1b]10;?\x07keep\x1b]0;hi\x07";
    assert_eq!(strip_terminal_queries(osc), b"keep\x1b]0;hi\x07".to_vec());
    // Plain bytes untouched; a lone ESC is preserved.
    assert_eq!(strip_terminal_queries(b"plain\x1b"), b"plain\x1b".to_vec());
}

// ---- draft tasks (M6) — red until implementation lands ----

#[test]
fn draft_autosave_defaults_true_when_key_absent() {
    let empty: RepoOverrides = toml::from_str("").expect("empty config parses");
    let global = alinery_core::default_global_settings();
    let effective = alinery_core::resolve_effective_config(&global, &empty);
    assert!(effective.defaults.draft_autosave, "draft_autosave must default true");

    let partial = r#"
[defaults]
harness = "claude"
"#;
    let c: RepoOverrides = toml::from_str(partial).expect("partial defaults parses");
    let effective = alinery_core::resolve_effective_config(&global, &c);
    assert!(effective.defaults.draft_autosave);
}

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
    let omp = f.harness.iter().find(|h| h.key == "omp").unwrap();
    assert!(omp.models_cmd.contains("{binary}"));
    assert!(!omp.models_cmd.contains("omp models"));
}

static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct OmpPathGuard {
    prev: Option<std::ffi::OsString>,
    _lock: std::sync::MutexGuard<'static, ()>,
}
impl OmpPathGuard {
    fn set(value: Option<&str>) -> Self {
        let lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var_os("ALINERY_OMP_PATH");
        match value {
            Some(v) => std::env::set_var("ALINERY_OMP_PATH", v),
            None => std::env::remove_var("ALINERY_OMP_PATH"),
        }
        Self { prev, _lock: lock }
    }
}
impl Drop for OmpPathGuard {
    fn drop(&mut self) {
        match &self.prev {
            Some(v) => std::env::set_var("ALINERY_OMP_PATH", v),
            None => std::env::remove_var("ALINERY_OMP_PATH"),
        }
    }
}

fn models_cmd_repo(name: &str, toml: &str) -> (PathBuf, PathBuf) {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-{name}-{n}"));
    fs::create_dir_all(repo.join(".alinery")).unwrap();
    fs::write(repo.join(".alinery/harnesses.toml"), toml).unwrap();
    let app_config = repo.join("app.toml");
    (repo, app_config)
}

#[test]
fn list_harness_models_in_substitutes_absolute_binary() {
    let fixture = std::env::temp_dir().join(format!("alinery-omp-models-{}", std::process::id()));
    fs::write(&fixture, "#!/bin/sh\nprintf '%s\\n' '{\"selector\":\"fixture/model\"}'\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut p = fs::metadata(&fixture).unwrap().permissions();
        p.set_mode(0o755);
        fs::set_permissions(&fixture, p).unwrap();
    }
    let _guard = OmpPathGuard::set(Some(fixture.to_str().unwrap()));
    let (repo, app_config) = models_cmd_repo(
        "models-sub",
        r#"
[[harness]]
key = "omp"
name = "OMP"
binary = "omp"
args = []
adapter = "omp"
models = []
models_cmd = "{binary} models --json 2>/dev/null | grep -oE '\"selector\":\"[^\"]*\"' | cut -d'\"' -f4"
"#,
    );
    let models = crate::list_harness_models_in(&app_config, &repo, "omp");
    let _ = fs::remove_file(&fixture);
    assert!(models.iter().any(|m| m == "fixture/model"), "got {models:?}");
}

#[test]
fn list_harness_models_in_missing_binary_returns_statics_only() {
    let _guard = OmpPathGuard::set(Some("/no/such/alinery-omp-models"));
    let (repo, app_config) = models_cmd_repo(
        "models-miss",
        r#"
[[harness]]
key = "omp"
name = "OMP"
binary = "omp"
args = []
adapter = "omp"
models = ["static/one"]
models_cmd = "echo SHOULD_NOT_RUN >&2; exit 1"
"#,
    );
    let models = crate::list_harness_models_in(&app_config, &repo, "omp");
    assert_eq!(models, vec!["static/one".to_string()]);
}

#[test]
fn shell_quote_keeps_hostile_paths_one_literal_word() {
    // The trailing `extra` word is the tell: if quoting leaked, the path splits into extra
    // fields (space), swallows them (unbalanced quote), or runs something else (`;`, `$()`).
    for path in [
        "/Applications/My App/omp",
        "/tmp/it's here/omp",
        "/tmp/omp; echo pwned",
        "/tmp/$HOME/omp",
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
