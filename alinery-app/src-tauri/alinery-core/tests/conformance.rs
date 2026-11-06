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

/// A task created in a scratch repository, reduced to what must not differ between the Rust and the TypeScript creator:
/// the `task.md` record without its clock and its paths, the ticket, the attachments, and the shape of `execution.json`.
/// `command.json` holds the request, the attachment bytes as text, and `twice` to create the same request a second time
/// (the slug and the attachment names then collide). The daemon's `bun test` runs `provisionTask` over the same files.
fn task_create(case: &Path) -> Value {
    let command: Value = serde_json::from_str(&fs::read_to_string(case.join("command.json")).unwrap()).unwrap();
    let scratch = std::env::temp_dir().join(format!("alinery-conf-create-{}-{}", std::process::id(), case.file_name().unwrap().to_string_lossy()));
    let _ = fs::remove_dir_all(&scratch);
    fs::create_dir_all(&scratch).unwrap();
    let git = |args: &[&str]| {
        let out = alinery_core::git_cmd(&scratch).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.email", "t@example.com"]);
    git(&["config", "user.name", "t"]);
    git(&["commit", "--allow-empty", "-q", "-m", "init"]);
    let playbook = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../playbooks/one-shot/playbook.md")).unwrap();
    let mut request = command["request"].clone();
    if request["playbook"]["source"] == "@one-shot" {
        request["playbook"]["source"] = playbook.into();
    }
    request["attachments"] = command["attachments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| serde_json::json!({ "name": a["name"], "bytes": alinery_core::rpc_chunk::encode_base64(a["text"].as_str().unwrap().as_bytes()) }))
        .collect();
    let request: alinery_core::CreateTaskRequest = serde_json::from_value(request).unwrap();
    let mut slugs = Vec::new();
    for _ in 0..if command["twice"] == true { 2 } else { 1 } {
        let reply = alinery_core::provision_task(&scratch, "", "fixture", &request).unwrap();
        assert_eq!(reply.creation, "ready", "{:?}", reply.errors);
        slugs.push(reply.task.unwrap().slug);
    }
    let mut out = Map::new();
    for slug in slugs {
        let dir = scratch.join(".alinery/tasks").join(&slug);
        let mut files = Map::new();
        let mut task: Value = serde_json::to_value(toml::from_str::<toml::Value>(&fs::read_to_string(dir.join("task.md")).unwrap()).unwrap()).unwrap();
        for volatile in ["created", "telemetry_id", "worktree"] {
            task.as_object_mut().unwrap().remove(volatile);
        }
        files.insert("task.md".into(), task);
        if let Ok(ticket) = fs::read_to_string(dir.join("artifacts/00-ticket.md")) {
            files.insert("artifacts/00-ticket.md".into(), ticket.into());
        }
        if let Ok(entries) = fs::read_dir(dir.join("artifacts/attachments")) {
            for entry in entries.flatten() {
                files.insert(
                    format!("artifacts/attachments/{}", entry.file_name().to_string_lossy()),
                    fs::read_to_string(entry.path()).unwrap().into(),
                );
            }
        }
        let execution: Value = serde_json::from_str(&fs::read_to_string(dir.join("execution.json")).unwrap()).unwrap();
        let mut shape = Map::new();
        for key in [
            "version",
            "creation",
            "owning_lane",
            "definition_identity",
            "enabled_steps",
            "max_live_sessions",
            "launch_defaults",
            "reference",
        ] {
            if let Some(value) = execution.get(key) {
                shape.insert(key.into(), value.clone());
            }
        }
        files.insert("execution.json".into(), shape.into());
        out.insert(slug, files.into());
    }
    let _ = fs::remove_dir_all(&scratch);
    out.into()
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

/// The scrollback windows and the OMP journal pages `read_session_history` and `read_omp_window` give for the case.
/// (The tail read renders a terminal screen and has no TypeScript twin: the daemon returns the replay bytes themselves.)
fn history(case: &Path) -> Value {
    let (scratch, command) = scratch_of(case, "history");
    let slug = command["slug"].as_str().unwrap();
    let id_of = |read: &Value| read["id"].as_str().unwrap_or(command["id"].as_str().unwrap()).to_string();
    let reads: Vec<Value> = command["reads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|read| {
            let outcome = alinery_core::read_session_history(&scratch, slug, &id_of(read), read["offset"].as_u64(), read["limit"].as_u64());
            match outcome {
                Ok(r) => serde_json::json!({ "data": String::from_utf8_lossy(&r.data), "length": r.length, "next_offset": r.next_offset, "eof": r.eof }),
                Err(_) => serde_json::json!({ "error": true }),
            }
        })
        .collect();
    let mut previous_start = None;
    let mut windows = Vec::new();
    for window in command["windows"].as_array().unwrap() {
        let end = if window["end"] == "previous_start" { previous_start } else { window["end"].as_u64() };
        match alinery_core::read_omp_window(&scratch, slug, &id_of(window), end, window["want"].as_u64()) {
            Ok(w) => {
                previous_start = Some(w.start);
                windows.push(serde_json::json!({ "data": String::from_utf8_lossy(&w.data), "start": w.start, "end": w.end, "length": w.length }));
            }
            Err(_) => windows.push(serde_json::json!({ "error": true })),
        }
    }
    let _ = fs::remove_dir_all(&scratch);
    serde_json::json!({ "reads": reads, "windows": windows })
}

/// The chat rail `list_chat_threads_in` makes of a repository's root sessions, with and without the archived ones. The case
/// is made a git checkout on `main` first, so a thread without a worktree of its own reports that branch. The daemon's
/// `ChatPublisher` rows (chat.ts) plus its session rows must give the same threads.
fn chat(case: &Path) -> Value {
    let (scratch, command) = scratch_of(case, "chat");
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.email", "t@example.com"],
        &["config", "user.name", "t"],
        &["commit", "--allow-empty", "-q", "-m", "init"],
    ] {
        let out = alinery_core::git_cmd(&scratch).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }
    let mut out = Map::new();
    for include in command["include_archived"].as_array().unwrap() {
        let include = include.as_bool().unwrap();
        let threads = alinery_core::chat::list_chat_threads_in(std::slice::from_ref(&scratch), include).unwrap();
        let rows: Vec<Value> = threads
            .iter()
            .map(|t| {
                serde_json::json!({
                    "id": t.session.id,
                    "name": t.name,
                    "branch_label": t.branch_label,
                    "checkout": t.checkout,
                    "archived": t.session.archived,
                    "pinned": t.session.pinned,
                })
            })
            .collect();
        out.insert(format!("include_archived_{include}"), rows.into());
    }
    let _ = fs::remove_dir_all(&scratch);
    out.into()
}

fn run(domain: &str, case: &Path, update: bool) -> Value {
    let input = case.join("input");
    match domain {
        "session_meta" => session_meta(&input),
        "task" => task(&input),
        "settings" => settings(&input),
        "settings_write" => settings_write(case, update),
        "telemetry" => telemetry(case),
        "task_create" => task_create(case),
        "session_name" => session_name(case),
        "history" => history(case),
        "chat" => chat(case),
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
    assert!(cases >= 16, "found only {cases} conformance cases");
}
