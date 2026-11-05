//! Conformance cases shared with the daemon's TypeScript parsers (plan S2.3).
//!
//! `conformance/<domain>/<case>/input/` is a small `.alinery` tree and `expected.json` is today's serde
//! JSON of what the Rust reader makes of it, keyed by the store key. The daemon's `bun test` runs its
//! parser over the same inputs and compares against the same file, after both sides drop null and
//! default-valued fields (proto3 JSON omits defaults). `UPDATE_FIXTURES=1` rewrites `expected.json`.
//! The directory outlives the Rust reader (migration rule 5).

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

fn run(domain: &str, input: &Path) -> Value {
    match domain {
        "session_meta" => session_meta(input),
        other => panic!("no Rust reader for conformance domain {other}"),
    }
}

#[test]
fn rust_readers_match_expected_json() {
    let update = std::env::var("UPDATE_FIXTURES").is_ok_and(|v| v == "1");
    let mut cases = 0;
    for domain in fs::read_dir(root()).unwrap().flatten().filter(|e| e.path().is_dir()) {
        let domain_name = domain.file_name().to_string_lossy().into_owned();
        for case in fs::read_dir(domain.path()).unwrap().flatten().filter(|e| e.path().is_dir()) {
            let actual = run(&domain_name, &case.path().join("input"));
            let expected_path = case.path().join("expected.json");
            if update {
                fs::write(&expected_path, serde_json::to_string_pretty(&actual).unwrap() + "\n").unwrap();
            } else {
                let expected: Value = serde_json::from_str(&fs::read_to_string(&expected_path).unwrap_or_else(|_| panic!("{} missing; run with UPDATE_FIXTURES=1", expected_path.display()))).unwrap();
                assert_eq!(actual, expected, "{domain_name}/{}", case.file_name().to_string_lossy());
            }
            cases += 1;
        }
    }
    assert!(cases >= 6, "found only {cases} conformance cases");
}
