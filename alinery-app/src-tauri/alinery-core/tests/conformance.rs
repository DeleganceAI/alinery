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

/// Replaces everything a run makes different: the scratch directory (and its canonical form), comment ids (`c<ms>`), the
/// `_ms` clocks and the hash of a markdown that carries those ids. The daemon's `scrub` (artifactConformance) does the same.
fn scrub_str(text: &str, scratch: &Path) -> String {
    let mut out = text.to_string();
    let canonical = scratch.canonicalize().unwrap_or_else(|_| scratch.to_path_buf());
    for dir in [canonical, scratch.to_path_buf()] {
        out = out.replace(&dir.to_string_lossy().into_owned(), "<REPO>");
    }
    let bytes = out.as_bytes();
    let boundary = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut result = String::new();
    let mut i = 0;
    while i < bytes.len() {
        let starts = bytes[i] == b'c' && (i == 0 || !boundary(bytes[i - 1])) && bytes.len() >= i + 14 && bytes[i + 1..i + 14].iter().all(u8::is_ascii_digit);
        if starts {
            let mut end = i + 14;
            if end < bytes.len() && bytes[end] == b'_' && bytes.get(end + 1).is_some_and(u8::is_ascii_digit) {
                end += 1;
                while end < bytes.len() && bytes[end].is_ascii_digit() {
                    end += 1;
                }
            }
            if end >= bytes.len() || !boundary(bytes[end]) {
                result.push_str("cID");
                i = end;
                continue;
            }
        }
        let ch = out[i..].chars().next().unwrap();
        result.push(ch);
        i += ch.len_utf8();
    }
    result
}

/// The artifact tree each named task sees, a read of every file node (an attachment answers `error`: it is revealed, never
/// read) and the revealable path of every node, relative to the repository.
fn artifact_tree(case: &Path) -> Value {
    fn walk<'a>(nodes: &'a [alinery_core::ArtifactTreeNode], out: &mut Vec<&'a alinery_core::ArtifactTreeNode>) {
        for node in nodes {
            out.push(node);
            walk(&node.children, out);
        }
    }
    let (scratch, command) = scratch_of(case, "atree");
    let mut out = Map::new();
    for view in command["views"].as_array().unwrap() {
        let view = view.as_str().unwrap();
        let Ok(tree) = alinery_core::list_task_artifact_tree(&scratch, view) else {
            out.insert(view.into(), serde_json::json!({ "error": true }));
            continue;
        };
        let mut flat = Vec::new();
        walk(&tree, &mut flat);
        let mut reads = Map::new();
        let mut paths = Map::new();
        for node in flat {
            reads.insert(
                node.id.clone(),
                match alinery_core::read_task_artifact_node(&scratch, view, &node.id) {
                    Ok(text) => text.into(),
                    Err(_) => serde_json::json!({ "error": true }),
                },
            );
            paths.insert(
                node.id.clone(),
                match alinery_core::artifact_node_path(&scratch, view, &node.id) {
                    Ok(path) => scrub_str(&path, &scratch).into(),
                    Err(_) => serde_json::json!({ "error": true }),
                },
            );
        }
        let unknown = alinery_core::read_task_artifact_node(&scratch, view, "artifact-0000000000000000").is_err();
        out.insert(
            view.into(),
            serde_json::json!({ "tree": serde_json::to_value(&tree).unwrap(), "reads": reads, "paths": paths, "unknown_node_refused": unknown }),
        );
    }
    let _ = fs::remove_dir_all(&scratch);
    out.into()
}

/// The text a playbook step names: `source` literally, else the case's `fixture` (or `fixture2`, `base`) with the `replace`
/// pairs applied to their first occurrence, the `replace_all` pairs to every one, then `append`. The daemon's `sourceOf` does the same.
fn playbook_source(command: &Value, step: &Value) -> String {
    if let Some(text) = step["source"].as_str() {
        return text.to_string();
    }
    let mut text = command[step["base"].as_str().unwrap_or("fixture")].as_str().unwrap().to_string();
    for pair in step["replace"].as_array().into_iter().flatten() {
        text = text.replacen(pair[0].as_str().unwrap(), pair[1].as_str().unwrap(), 1);
    }
    for pair in step["replace_all"].as_array().into_iter().flatten() {
        text = text.replace(pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
    }
    if let Some(tail) = step["append"].as_str() {
        text.push_str(tail);
    }
    text
}

/// Diagnostics in a fixed order (the library collects some from a hash set) as the JSON the daemon also produces.
fn playbook_errors(errors: Vec<alinery_core::playbook::PlaybookValidationError>) -> Value {
    let mut rows: Vec<Value> = errors.iter().map(|e| serde_json::to_value(e).unwrap()).collect();
    rows.sort_by_key(|row| row.to_string());
    rows.into()
}

fn playbook_parse(source: &str) -> Value {
    match alinery_core::playbook::parse_playbook_md(source) {
        Ok(definition) => serde_json::json!({ "ok": definition }),
        Err(errors) => serde_json::json!({ "errors": playbook_errors(errors) }),
    }
}

/// `modified_at_ms` is the file's real clock: present or absent is all a case can say about it.
fn playbook_scrub(value: Value, scratch: &Path) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, v)| {
                    let v = if key == "modified_at_ms" && !v.is_null() {
                        Value::from("MTIME")
                    } else {
                        playbook_scrub(v, scratch)
                    };
                    (key, v)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(|v| playbook_scrub(v, scratch)).collect()),
        Value::String(text) => Value::String(scrub_str(&text, scratch)),
        other => other,
    }
}

fn playbook_ref(value: &Value) -> alinery_core::playbook::PlaybookRef {
    serde_json::from_value(value.clone()).unwrap()
}

/// The playbook library over `input/app` (the global config dir) and `input/repo`, step by step, then every file left behind.
/// `no_repo` makes the roots global-only. The daemon's `playbookLibrary.ts` must give the same answers and the same bytes.
fn playbook(case: &Path) -> Value {
    use alinery_core::playbook::render_playbook_md;
    use alinery_core::playbook_library as lib;
    let (scratch, command) = scratch_of(case, "playbook");
    let (app, repo) = (scratch.join("app"), scratch.join("repo"));
    fs::create_dir_all(&app).unwrap();
    fs::create_dir_all(&repo).unwrap();
    let roots = lib::PlaybookRoots {
        global_config_dir: app,
        repo_dir: if command["no_repo"] == true { PathBuf::new() } else { repo },
    };
    let bundled_source = |step: &Value| -> String {
        let spec = &step["bundled"];
        let key = spec["key"].as_str().unwrap();
        let mut definition = alinery_core::playbook::parse_playbook_md(lib::BUNDLED_PLAYBOOKS.iter().find(|(found, _)| *found == key).unwrap().1).unwrap();
        if let Some(title) = spec["title"].as_str() {
            definition.title = title.into();
        }
        if let Some(set_key) = spec["set_key"].as_str() {
            definition.key = set_key.into();
        }
        render_playbook_md(&definition)
    };
    let mut answers = Vec::new();
    for step in command["steps"].as_array().unwrap() {
        let answer = match step["op"].as_str().unwrap() {
            "parse" => playbook_parse(&playbook_source(&command, step)),
            "roundtrip" => match alinery_core::playbook::parse_playbook_md(&playbook_source(&command, step)) {
                Ok(definition) => {
                    let rendered = render_playbook_md(&definition);
                    let again = alinery_core::playbook::parse_playbook_md(&rendered);
                    serde_json::json!({
                        "rendered": rendered,
                        "reparsed_equal": again.as_ref().ok() == Some(&definition),
                        "rerendered_equal": again.map(|d| render_playbook_md(&d) == rendered).unwrap_or(false),
                    })
                }
                Err(errors) => serde_json::json!({ "errors": playbook_errors(errors) }),
            },
            "remove_lines_sweep" => {
                let source = playbook_source(&command, step);
                let codes: Vec<Value> = source
                    .split_inclusive('\n')
                    .enumerate()
                    .filter(|(_, line)| line.contains(" = "))
                    .map(|(removed, _)| {
                        let without: String = source.split_inclusive('\n').enumerate().filter_map(|(i, line)| (i != removed).then_some(line)).collect();
                        match alinery_core::playbook::parse_playbook_md(&without) {
                            Ok(_) => Value::from("ok"),
                            Err(errors) => {
                                let mut codes: Vec<String> = errors.into_iter().map(|e| e.code).collect();
                                codes.sort();
                                codes.dedup();
                                codes.into()
                            }
                        }
                    })
                    .collect();
                serde_json::json!({ "codes": codes })
            }
            "strict_json" => {
                let value = step["value"].clone();
                let rejected = match step["type"].as_str().unwrap() {
                    "NormalizedPlaybook" => serde_json::from_value::<alinery_core::playbook::NormalizedPlaybook>(value).err().map(|e| e.to_string()),
                    "NormalizedStep" => serde_json::from_value::<alinery_core::playbook::NormalizedStep>(value).err().map(|e| e.to_string()),
                    "SavePlaybookRequest" => serde_json::from_value::<lib::SavePlaybookRequest>(value).err().map(|e| e.to_string()),
                    "PlaybookRoots" => serde_json::from_value::<lib::PlaybookRoots>(value).err().map(|e| e.to_string()),
                    other => panic!("unknown strict type {other}"),
                };
                let field = step["field"].as_str().unwrap();
                if let Some(message) = &rejected {
                    assert!(message.contains(field), "{message} does not name {field}");
                }
                serde_json::json!({ "rejected": rejected.is_some() })
            }
            "catalog" => serde_json::to_value(lib::load_playbook_catalog(&roots)).unwrap(),
            "resolve" => match lib::resolve_playbook(&roots, &playbook_ref(&step["reference"])) {
                Ok(found) => serde_json::json!({ "ok": found }),
                Err(error) => serde_json::json!({ "error": error }),
            },
            "save" => {
                let source = if step["bundled"].is_object() {
                    bundled_source(step)
                } else {
                    playbook_source(&command, step)
                };
                let request = lib::SavePlaybookRequest {
                    target: playbook_ref(&step["target"]),
                    source,
                    overwrite: step["overwrite"] == true,
                };
                match lib::save_playbook(&roots, request) {
                    Ok(saved) => serde_json::json!({ "ok": saved }),
                    Err(error) => serde_json::json!({ "error": error }),
                }
            }
            "delete" => match lib::delete_playbook(&roots, &playbook_ref(&step["reference"])) {
                Ok(()) => serde_json::json!({ "ok": {} }),
                Err(error) => serde_json::json!({ "error": error }),
            },
            "load_picker" => match lib::load_picker_preferences(&roots) {
                Ok(preferences) => serde_json::json!({ "ok": preferences }),
                Err(_) => serde_json::json!({ "error": true }),
            },
            "save_picker" => match serde_json::from_value::<lib::PickerPreferences>(step["preferences"].clone()) {
                Ok(preferences) => match lib::save_picker_preferences(&roots, &preferences) {
                    Ok(()) => serde_json::json!({ "ok": {} }),
                    Err(error) => serde_json::json!({ "error": error }),
                },
                Err(_) => serde_json::json!({ "error": true }),
            },
            "read_file" => serde_json::json!({ "text": fs::read_to_string(scratch.join(step["path"].as_str().unwrap())).ok() }),
            "write_file" => {
                let path = scratch.join(step["path"].as_str().unwrap());
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, step["text"].as_str().unwrap()).unwrap();
                serde_json::json!({})
            }
            "symlink" => {
                let path = scratch.join(step["path"].as_str().unwrap());
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(scratch.join(step["target"].as_str().unwrap()), path).unwrap();
                serde_json::json!({})
            }
            other => panic!("unknown playbook op {other}"),
        };
        answers.push(playbook_scrub(answer, &scratch));
    }
    let mut files = Map::new();
    fn collect(dir: &Path, root: &Path, files: &mut Map<String, Value>) {
        let mut entries: Vec<_> = fs::read_dir(dir).into_iter().flatten().flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".mutation.lock" {
                continue;
            }
            if fs::symlink_metadata(&path).unwrap().file_type().is_symlink() {
                files.insert(path.strip_prefix(root).unwrap().to_string_lossy().into_owned(), "<symlink>".into());
            } else if path.is_dir() {
                collect(&path, root, files);
            } else {
                files.insert(
                    path.strip_prefix(root).unwrap().to_string_lossy().into_owned(),
                    String::from_utf8_lossy(&fs::read(&path).unwrap()).into_owned().into(),
                );
            }
        }
    }
    collect(&scratch, &scratch, &mut files);
    let _ = fs::remove_dir_all(&scratch);
    serde_json::json!({ "steps": answers, "files": files })
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
        "artifact_tree" => artifact_tree(case),
        "playbook" => playbook(case),
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
        if matches!(domain_name.as_str(), "board" | "chat" | "artifact_comments" | "artifact_list") {
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
    assert!(cases >= 21, "found only {cases} conformance cases");
}
