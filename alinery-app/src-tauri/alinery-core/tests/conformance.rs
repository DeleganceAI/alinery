//! Conformance cases shared with the daemon's TypeScript parsers (plan S2.3).
//!
//! `conformance/<domain>/<case>/input/` is a small `.alinery` tree and `expected.json` is today's serde
//! JSON of what the Rust reader makes of it, keyed by the store key. The daemon's `bun test` runs its
//! parser over the same inputs and compares against the same file, after both sides drop null and
//! default-valued fields (proto3 JSON omits defaults). `UPDATE_FIXTURES=1` rewrites `expected.json`.
//! The directory outlives the Rust reader (migration rule 5): the `board` domain has no Rust reader any more.

use alinery_core::shared::read_session_meta_full;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance")
}

/// Every `*.meta.json` under `input/.alinery`, keyed `session/<slug or _>/<id>`; a file Rust refuses is absent.
fn session_meta(input: &Path) -> Value {
    let alinery = input.join(".alinery");
    let mut found = Vec::new();
    let mut dirs = vec![("_".to_string(), alinery.join("sessions"))];
    if let Ok(tasks) = fs::read_dir(alinery.join("tasks")) {
        for task in tasks.flatten() {
            dirs.push((task.file_name().to_string_lossy().into_owned(), task.path().join("sessions")));
        }
    }
    for (slug, dir) in dirs {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(".meta.json") {
                found.push((format!("session/{slug}/{id}"), entry.path()));
            }
        }
    }
    let mut out = Map::new();
    for (key, path) in found {
        if let Some(meta) = read_session_meta_full(&path) {
            out.insert(key, serde_json::to_value(meta).unwrap());
        }
    }
    Value::Object(out)
}

/// Every `tasks/*/task.md` under `input/.alinery`, keyed `task/<dir>/<dir>`; a file Rust refuses is absent.
fn task_dirs(input: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(input.join(".alinery/tasks")) else { return vec![] };
    entries.flatten().map(|e| (e.file_name().to_string_lossy().into_owned(), e.path())).collect()
}

fn task(input: &Path) -> Value {
    let mut out = Map::new();
    for (slug, _) in task_dirs(input) {
        if let Ok(task) = alinery_core::board::read_task_checked(input, &slug) {
            out.insert(format!("task/{slug}/{slug}"), serde_json::to_value(task).unwrap());
        }
    }
    Value::Object(out)
}

/// `settings/_/repo`: what the shell's `read_scoped_settings_strict` and `effective_harnesses_for` answered for the
/// case's `app.toml` and `.alinery/`. A file serde refuses is `{"error": true}`; the wording of the error is Rust's own.
fn settings(input: &Path) -> Value {
    let app_config = input.join("app.toml");
    let scoped = match alinery_core::read_scoped_settings_strict(&app_config, input) {
        Ok(scoped) => scoped,
        Err(_) => return serde_json::json!({ "settings/_/repo": { "error": true } }),
    };
    let harnesses = alinery_core::effective_harnesses_for(&app_config, input);
    serde_json::json!({ "settings/_/repo": {
        "overrides": scoped.overrides,
        "effective": scoped.effective,
        "harnesses": harnesses,
    } })
}

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).into_iter().flatten().flatten() {
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// A write case: `command.json` is applied to a copy of `input/` and `.alinery/config.toml` must be, byte for byte, the
/// one under `after/` (or absent in both). Rust's `write_repo_overrides` and `clear_repo_override` are the reference.
fn settings_write(case: &Path, update: bool) -> Value {
    let scratch = std::env::temp_dir().join(format!("alinery-conformance-{}-{}", std::process::id(), case.file_name().unwrap().to_string_lossy()));
    let _ = fs::remove_dir_all(&scratch);
    copy_tree(&case.join("input"), &scratch);
    let command: Value = serde_json::from_str(&fs::read_to_string(case.join("command.json")).unwrap()).unwrap();
    let outcome = match command["op"].as_str().unwrap() {
        "write" => {
            let overrides: alinery_core::RepoOverrides = serde_json::from_value(command["overrides"].clone()).unwrap();
            alinery_core::write_repo_overrides(None, &scratch, &overrides)
        }
        "clear" => alinery_core::load_repo_overrides_strict(&scratch).and_then(|mut overrides| {
            alinery_core::clear_repo_override(&mut overrides, command["field"].as_str().unwrap())?;
            alinery_core::write_repo_overrides(None, &scratch, &overrides)
        }),
        other => panic!("unknown settings_write op {other}"),
    };
    let written = fs::read(scratch.join(".alinery/config.toml")).ok();
    let after = case.join("after/.alinery/config.toml");
    if update {
        let _ = fs::remove_dir_all(case.join("after"));
        if let Some(bytes) = &written {
            fs::create_dir_all(after.parent().unwrap()).unwrap();
            fs::write(&after, bytes).unwrap();
        }
    } else {
        assert_eq!(written, fs::read(&after).ok(), "{}: config.toml after the command", case.display());
    }
    let _ = fs::remove_dir_all(&scratch);
    serde_json::json!({ "ok": outcome.is_ok() })
}

/// The record `event_record` builds for `event.json`, with the two host-dependent fields (`app_version`, `os`) replaced by
/// placeholders so the file does not move with a version bump or a platform. The daemon's TypeScript sender builds the same.
fn telemetry(case: &Path) -> Value {
    use alinery_core::{SettingsChangeScope, TelemetryEvent, TelemetrySource};
    let event: Value = serde_json::from_str(&fs::read_to_string(case.join("event.json")).unwrap()).unwrap();
    assert_eq!(event["event"], "settings.change", "only settings.change has moved to the daemon");
    let source = match event["source"].as_str().unwrap() {
        "app" => TelemetrySource::App,
        "mcp" => TelemetrySource::Mcp,
        "alineryd" => TelemetrySource::Alineryd,
        other => panic!("unknown source {other}"),
    };
    let scope = match event["scope"].as_str().unwrap() {
        "global" => SettingsChangeScope::Global,
        "repo" => SettingsChangeScope::Repo,
        "appearance" => SettingsChangeScope::Appearance,
        "harnesses" => SettingsChangeScope::Harnesses,
        other => panic!("unknown scope {other}"),
    };
    let mut record = alinery_core::event_record(&TelemetryEvent::SettingsChange { source, scope }, "11111111-2222-3333-4444-555555555555");
    record["app_version"] = "VERSION".into();
    record["os"] = "OS".into();
    record
}

fn run(domain: &str, case: &Path, update: bool) -> Value {
    let input = case.join("input");
    match domain {
        "session_meta" => session_meta(&input),
        "task" => task(&input),
        "settings" => settings(&input),
        "settings_write" => settings_write(case, update),
        "telemetry" => telemetry(case),
        other => panic!("no Rust reader for conformance domain {other}"),
    }
}

#[test]
fn rust_readers_match_expected_json() {
    let update = std::env::var("UPDATE_FIXTURES").is_ok_and(|v| v == "1");
    let mut cases = 0;
    for domain in fs::read_dir(root()).unwrap().flatten().filter(|e| e.path().is_dir()) {
        let domain_name = domain.file_name().to_string_lossy().into_owned();
        // `board`: the derived fields have one implementation now (the daemon's, rule R3). Its cases were written by the
        // Rust `board_task` before that was deleted, and the daemon's `bun test` still checks them.
        if domain_name == "board" {
            continue;
        }
        for case in fs::read_dir(domain.path()).unwrap().flatten().filter(|e| e.path().is_dir()) {
            let actual = run(&domain_name, &case.path(), update);
            let expected_path = case.path().join("expected.json");
            if update {
                fs::write(&expected_path, serde_json::to_string_pretty(&actual).unwrap() + "\n").unwrap();
            } else {
                let expected: Value =
                    serde_json::from_str(&fs::read_to_string(&expected_path).unwrap_or_else(|_| panic!("{} missing; run with UPDATE_FIXTURES=1", expected_path.display())))
                        .unwrap();
                assert_eq!(actual, expected, "{domain_name}/{}", case.file_name().to_string_lossy());
            }
            cases += 1;
        }
    }
    assert!(cases >= 11, "found only {cases} conformance cases");
}
