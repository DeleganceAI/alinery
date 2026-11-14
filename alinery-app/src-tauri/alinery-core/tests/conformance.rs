//! Conformance cases shared with the daemon's TypeScript parsers (plan S2.3).
//!
//! `conformance/<domain>/<case>/input/` is a small `.alinery` tree and `expected.json` is today's serde
//! JSON of what the Rust reader makes of it, keyed by the store key. The daemon's `bun test` runs its
//! parser over the same inputs and compares against the same file, after both sides drop null and
//! default-valued fields (proto3 JSON omits defaults). `UPDATE_FIXTURES=1` rewrites `expected.json`.
//! The directory outlives the Rust reader (migration rule 5): the `board` domain has no Rust reader any more.

use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance")
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

/// The record `event_record` builds for `event.json`, with the two host-dependent fields (`app_version`, `os`) replaced by
/// placeholders so the file does not move with a version bump or a platform. The daemon's TypeScript sender builds the same.
fn telemetry(case: &Path) -> Value {
    use alinery_core::{SettingsChangeScope, TelemetryEvent, TelemetrySource};
    let event: Value = serde_json::from_str(&fs::read_to_string(case.join("event.json")).unwrap()).unwrap();
    let source = match event["source"].as_str().unwrap() {
        "app" => TelemetrySource::App,
        "mcp" => TelemetrySource::Mcp,
        "alineryd" => TelemetrySource::Alineryd,
        other => panic!("unknown source {other}"),
    };
    let task_id = event["taskId"].as_str().unwrap_or_default().to_string();
    let telemetry_event = match event["event"].as_str().unwrap() {
        "settings.change" => TelemetryEvent::SettingsChange {
            source,
            scope: match event["scope"].as_str().unwrap() {
                "global" => SettingsChangeScope::Global,
                "repo" => SettingsChangeScope::Repo,
                "appearance" => SettingsChangeScope::Appearance,
                "harnesses" => SettingsChangeScope::Harnesses,
                other => panic!("unknown scope {other}"),
            },
        },
        "task.draft_create" => TelemetryEvent::TaskDraftCreate {
            source,
            has_worktree: event["hasWorktree"].as_bool().unwrap(),
            playbook: event["playbook"].as_str().unwrap().to_string(),
            task_id,
        },
        "task.draft_delete" => TelemetryEvent::TaskDraftDelete { source, task_id },
        "task.archive" => TelemetryEvent::TaskArchive { source, task_id },
        "git.commit" => TelemetryEvent::GitCommit { source },
        "git.push" => TelemetryEvent::GitPush { source },
        "git.worktree_remove" => TelemetryEvent::GitWorktreeRemove { source },
        "storage.purge" => TelemetryEvent::StoragePurge { source },
        "backup.create" => TelemetryEvent::BackupCreate {
            source,
            trigger: serde_json::from_value(event["trigger"].clone()).unwrap(),
        },
        "session.archive" => TelemetryEvent::SessionArchive {
            source,
            killed_live: event["killedLive"].as_bool().unwrap(),
            session_id: event["sessionId"].as_str().unwrap().to_string(),
            task_id,
        },
        "session.kill" => TelemetryEvent::SessionKill {
            source,
            session_id: event["sessionId"].as_str().unwrap().to_string(),
            task_id,
        },
        other => panic!("{other} has not moved to the daemon"),
    };
    let mut record = alinery_core::event_record(&telemetry_event, "11111111-2222-3333-4444-555555555555");
    record["app_version"] = "VERSION".into();
    record["os"] = "OS".into();
    record
}

/// A scratch copy of `case/input/`, and the case's `command.json`.
fn scratch_of(case: &Path, tag: &str) -> (PathBuf, Value) {
    let scratch = std::env::temp_dir().join(format!("alinery-conf-{tag}-{}-{}", std::process::id(), case.file_name().unwrap().to_string_lossy()));
    let _ = fs::remove_dir_all(&scratch);
    copy_tree(&case.join("input"), &scratch);
    let command = serde_json::from_str(&fs::read_to_string(case.join("command.json")).unwrap()).unwrap();
    (scratch, command)
}

/// `set_session_name` applied step by step to a copy of the case: what each step answered, then the name file left behind.
/// The daemon's `setSessionName` (vinculum-daemon/src/domain/sessionOps.ts) must give the same answers.
fn session_name(case: &Path) -> Value {
    use alinery_core::{SessionNameSource, SessionNameWriteStatus};
    let (scratch, command) = scratch_of(case, "name");
    let slug = command["slug"].as_str().unwrap();
    let mut answers = Vec::new();
    for step in command["steps"].as_array().unwrap() {
        let id = step["id"].as_str().unwrap_or(command["id"].as_str().unwrap());
        let source = if step["source"] == "user" { SessionNameSource::User } else { SessionNameSource::Auto };
        answers.push(match alinery_core::set_session_name(&scratch, slug, id, step["name"].as_str().unwrap(), source) {
            Ok(outcome) => serde_json::json!({
                "status": if outcome.status == SessionNameWriteStatus::Saved { "saved" } else { "unchanged" },
                "name": outcome.value.name,
                "source": if outcome.value.source == SessionNameSource::User { "user" } else { "auto" },
            }),
            Err(_) => serde_json::json!({ "error": true }),
        });
    }
    let stored = alinery_core::read_session_name(&scratch, slug, command["id"].as_str().unwrap()).unwrap().map(|n| n.name);
    let _ = fs::remove_dir_all(&scratch);
    serde_json::json!({ "steps": answers, "stored": stored })
}

fn run(domain: &str, case: &Path) -> Value {
    let input = case.join("input");
    match domain {
        "task" => task(&input),
        "telemetry" => telemetry(case),
        "session_name" => session_name(case),
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
        // `chat`, `artifact_comments` and `artifact_list` the same way: the Rust copies are gone and the daemon's `bun test`
        // still checks their cases against the `expected.json` written from them.
        // `session_meta`, `settings`, `settings_write`, `task_create`, `history`, `artifact_tree` and `playbook`: the Rust readers and
        // writers were deleted with `alinery-mcp`'s tools (S5.1), the last callers; the daemon's `bun test` checks these cases.
        if matches!(
            domain_name.as_str(),
            "board" | "chat" | "artifact_comments" | "artifact_list" | "session_meta" | "settings" | "settings_write" | "task_create" | "history" | "artifact_tree" | "playbook"
        ) {
            continue;
        }
        for case in fs::read_dir(domain.path()).unwrap().flatten().filter(|e| e.path().is_dir()) {
            let actual = run(&domain_name, &case.path());
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
    assert!(cases >= 18, "found only {cases} conformance cases");
}
