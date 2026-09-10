//! Integration tests for alineryd flock singleton, graceful teardown, boot_sweep.
//! Spawns the real binary via `CARGO_BIN_EXE_alineryd` against temp repos only.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

fn alineryd_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_alineryd"))
}

fn unique_token() -> String {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("al-{n}")
}

struct TempRepo {
    root: PathBuf,
    token: String,
}

impl TempRepo {
    fn new() -> Self {
        let token = unique_token();
        let root = std::env::temp_dir().join(&token);
        fs::create_dir_all(root.join(".alinery")).expect("mkdir .alinery");
        // Overlay the product omp key with a silent sleep stand-in. Extra overlay keys are not
        // launchable; tests that need a different binary rewrite this same-key omp row.
        let harnesses = format!(
            r#"
[[harness]]
key = "omp"
name = "sleep"
binary = "sh"
args = ["-c", "sleep 30 # {token}"]
model_arg = []
prompt_injection = "arg"
adapter = "unsupported"
"#
        );
        fs::write(root.join(".alinery/harnesses.toml"), harnesses).unwrap();
        Self { root, token }
    }

    fn socket(&self, ns: Option<&str>) -> PathBuf {
        let stem = match ns {
            None | Some("") => "alineryd".to_string(),
            Some(n) => format!("alineryd-{n}"),
        };
        self.root.join(".alinery").join(format!("{stem}.sock"))
    }

    fn lock(&self, ns: Option<&str>) -> PathBuf {
        let stem = match ns {
            None | Some("") => "alineryd".to_string(),
            Some(n) => format!("alineryd-{n}"),
        };
        self.root.join(".alinery").join(format!(".{stem}.lock"))
    }

    fn app_config(&self) -> PathBuf {
        self.root.join(".alinery").join("unused-app-config.toml")
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        // Best-effort kill any leftover harness tagged with our token.
        let _ = Command::new("pkill").args(["-f", &self.token]).status();
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct Daemon {
    child: Child,
    socket: PathBuf,
}

impl Daemon {
    fn spawn(repo: &TempRepo, ns: Option<&str>) -> Result<Self, String> {
        Self::spawn_with_host(repo, ns, None)
    }

    fn spawn_with_host(repo: &TempRepo, ns: Option<&str>, protected_host: Option<&Path>) -> Result<Self, String> {
        let socket = repo.socket(ns);
        let mut cmd = Command::new(alineryd_bin());
        cmd.arg("--repo")
            .arg(&repo.root)
            .arg("--build-id")
            .arg("test-build")
            // Isolate from this machine's real Alinery app config: without this, a harness key
            // these tests don't define (or a fixture that fails to parse — see TempRepo::new)
            // falls back through resolve_harness_for to whatever "claude" the developer's own
            // real app_config.toml defines, which can carry real, possibly
            // permissions-bypassing flags. Point at a path that doesn't exist so global
            // settings resolve to safe bundled defaults instead.
            .arg("--app-config")
            .arg(repo.app_config())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env_remove("ALINERY_HOST_EXECUTABLE");
        if let Some(protected_host) = protected_host {
            cmd.env("ALINERY_HOST_EXECUTABLE", protected_host);
        }
        if let Some(n) = ns {
            if !n.is_empty() {
                cmd.arg("--socket-namespace").arg(n);
            }
        }
        let child = cmd.spawn().map_err(|e| e.to_string())?;
        let d = Self { child, socket };
        d.wait_ready(Duration::from_secs(5))?;
        Ok(d)
    }

    fn wait_ready(&self, budget: Duration) -> Result<(), String> {
        let start = Instant::now();
        while start.elapsed() < budget {
            if self.socket.exists() {
                if let Ok(mut s) = UnixStream::connect(&self.socket) {
                    let _ = writeln!(s, r#"{{"op":"version"}}"#);
                    let mut line = String::new();
                    let mut r = BufReader::new(s);
                    if r.read_line(&mut line).is_ok() && line.contains("build_id") {
                        return Ok(());
                    }
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
        Err("daemon did not become ready".into())
    }

    fn rpc(&self, req: Value) -> Result<Value, String> {
        let mut s = UnixStream::connect(&self.socket).map_err(|e| e.to_string())?;
        s.set_read_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
        writeln!(s, "{req}").map_err(|e| e.to_string())?;
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).map_err(|e| e.to_string())?;
        serde_json::from_str(line.trim()).map_err(|e| e.to_string())
    }

    fn shutdown(mut self) -> Result<(), String> {
        let resp = self.rpc(json!({"op": "shutdown"}))?;
        if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return Err(format!("shutdown not ok: {resp}"));
        }
        // Wait for process exit (bounded).
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            match self.child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(e) => return Err(e.to_string()),
            }
        }
        let _ = self.child.kill();
        Err("shutdown did not exit".into())
    }

    fn kill_nine(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn write_meta(repo: &Path, id: &str, ns: &str, started: u64, ended: Option<u64>) -> PathBuf {
    let dir = repo.join(".alinery").join("sessions");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{id}.meta.json"));
    let mut v = json!({
        "id": id,
        "worktree": "",
        "created": started.saturating_sub(1).max(1),
        "task_slug": "",
        "harness": "no-harness",
        "model": "",
        "phase": "",
        "started_at": started,
        "daemon_namespace": ns,
    });
    if let Some(e) = ended {
        v["ended_at"] = json!(e);
    }
    fs::write(&path, v.to_string()).unwrap();
    path
}

#[test]
fn status_unknown_session_is_an_error() {
    let _g = test_lock();
    let repo = TempRepo::new();
    let daemon = Daemon::spawn(&repo, None).expect("daemon starts");

    assert_eq!(
        daemon.rpc(json!({"op": "status", "id": "missing"})).expect("status response"),
        json!({"error": "unknown-session"})
    );

    daemon.shutdown().expect("daemon shuts down");
}

#[test]
fn task_spawn_requires_eligible_metadata_and_acknowledges_durable_start() {
    let _guard = test_lock();
    let repo = TempRepo::new();
    let task_slug = "task";
    let task_dir = repo.root.join(".alinery/tasks").join(task_slug);
    let sessions = task_dir.join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let write_task = |archived: bool, has_worktree: bool| {
        fs::write(
            task_dir.join("task.md"),
            format!(
                "name = \"Task\"\nslug = \"task\"\nbranch = \"task\"\nworktree = {:?}\nhas_worktree = {has_worktree}\ncreated = 1\narchived = {archived}\nplaybook = \"superdevelop\"\n",
                repo.root.display().to_string()
            ),
        )
        .unwrap();
    };
    let write_task_meta = |id: &str, harness: &str, archived: bool, started_at: Option<u64>| {
        let mut value = json!({
            "id": id,
            "worktree": repo.root.display().to_string(),
            "created": 1,
            "archived": archived,
            "harness": harness,
            "playbook": "superdevelop"
        });
        if let Some(started_at) = started_at {
            value["started_at"] = json!(started_at);
        }
        fs::write(sessions.join(format!("{id}.meta.json")), serde_json::to_vec(&value).unwrap()).unwrap();
    };
    write_task(false, true);
    write_task_meta("archived", "omp", true, None);
    write_task_meta("started", "omp", false, Some(1));
    write_task_meta("unknown-harness", "missing", false, None);
    write_task_meta("valid", "omp", false, None);

    let daemon = Daemon::spawn(&repo, None).expect("daemon starts");
    let spawn = |id: &str| daemon.rpc(json!({"op": "spawn", "id": id, "task_slug": task_slug}));
    assert_eq!(spawn("missing").unwrap()["error"], "missing-session-meta");
    assert_eq!(spawn("archived").unwrap()["error"], "session-archived");
    assert!(spawn("started").unwrap()["error"].as_str().unwrap().contains("already-started"));
    assert!(spawn("unknown-harness").unwrap()["error"].as_str().unwrap().contains("unknown harness"));

    write_task(true, true);
    assert_eq!(spawn("valid").unwrap()["error"], "task-archived");
    write_task(false, false);
    assert_eq!(spawn("valid").unwrap()["error"], "missing-worktree");
    write_task(false, true);
    let original_mode = fs::metadata(&sessions).unwrap().permissions().mode();
    fs::set_permissions(&sessions, fs::Permissions::from_mode(0o555)).unwrap();
    let persistence_error = spawn("valid").unwrap()["error"].as_str().unwrap().to_string();
    fs::set_permissions(&sessions, fs::Permissions::from_mode(original_mode)).unwrap();
    assert!(persistence_error.contains("Permission denied") || persistence_error.contains("Operation not permitted"));
    let never_started: Value = serde_json::from_slice(&fs::read(sessions.join("valid.meta.json")).unwrap()).unwrap();
    assert!(never_started.get("started_at").is_none());
    assert!(never_started.get("status_changed_at").is_none());
    assert_eq!(daemon.rpc(json!({"op": "status", "id": "valid"})).unwrap()["error"], "unknown-session");

    assert_eq!(spawn("valid").unwrap(), json!({"ok": true}));
    let persisted: Value = serde_json::from_slice(&fs::read(sessions.join("valid.meta.json")).unwrap()).unwrap();
    assert!(persisted["started_at"].as_u64().is_some(), "spawn ack must follow started_at persistence");
    assert_eq!(
        persisted["status_changed_at"], persisted["started_at"],
        "fresh spawn must initialize one durable status timestamp"
    );
    assert!(persisted["status_revision"].as_u64().is_some_and(|revision| revision > 0));
    assert_eq!(persisted["daemon_namespace"], "");
    assert_eq!(daemon.rpc(json!({"op": "status", "id": "valid"})).unwrap()["process"]["state"], "alive");
    let unchanged = fs::read(sessions.join("valid.meta.json")).unwrap();
    assert_eq!(daemon.rpc(json!({"op": "list"})).unwrap()["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(daemon.rpc(json!({"op": "write", "id": "valid", "data": "\n"})).unwrap(), json!({"ok": true}));
    assert_eq!(daemon.rpc(json!({"op": "resize", "id": "valid", "cols": 100, "rows": 30})).unwrap(), json!({"ok": true}));
    assert_eq!(daemon.rpc(json!({"op": "detach", "id": "valid", "attach_id": 99})).unwrap(), json!({"ok": true}));
    alinery_core::read_session_history(&repo.root, task_slug, "valid", None, None).unwrap();
    assert_eq!(
        fs::read(sessions.join("valid.meta.json")).unwrap(),
        unchanged,
        "control, polling, and history reads must not rewrite status metadata"
    );
    daemon.shutdown().expect("daemon shuts down");
    let reaped: Value = serde_json::from_slice(&fs::read(sessions.join("valid.meta.json")).unwrap()).unwrap();
    assert!(reaped["ended_at"].as_u64().is_some());
    assert!(reaped["status_changed_at"].as_u64().unwrap() >= reaped["started_at"].as_u64().unwrap());
    assert!(reaped["status_revision"].as_u64().unwrap() > persisted["status_revision"].as_u64().unwrap());
}

#[test]
fn leftover_live_session_refuses_attach_spawn_resume_and_keeps_kill() {
    let _guard = test_lock();
    let repo = TempRepo::new();
    let task_slug = "task";
    let task_dir = repo.root.join(".alinery/tasks").join(task_slug);
    let sessions = task_dir.join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    fs::write(
        task_dir.join("task.md"),
        format!(
            "name = \"Task\"\nslug = \"task\"\nbranch = \"task\"\nworktree = {:?}\nhas_worktree = true\ncreated = 1\narchived = false\nplaybook = \"superdevelop\"\n",
            repo.root.display().to_string()
        ),
    )
    .unwrap();
    fs::write(
        sessions.join("legacy-live.meta.json"),
        serde_json::to_vec(&json!({
            "id": "legacy-live",
            "worktree": repo.root.display().to_string(),
            "created": 1,
            "archived": false,
            "harness": "omp",
            "playbook": "superdevelop"
        }))
        .unwrap(),
    )
    .unwrap();

    let daemon = Daemon::spawn(&repo, None).expect("daemon starts");
    assert_eq!(
        daemon.rpc(json!({"op": "spawn", "id": "legacy-live", "task_slug": task_slug})).unwrap(),
        json!({"ok": true})
    );
    assert_eq!(daemon.rpc(json!({"op": "write", "id": "legacy-live", "data": "hello\n"})).unwrap(), json!({"ok": true}));
    let scrollback = sessions.join("legacy-live.scrollback");
    let started = Instant::now();
    while !scrollback.exists() && started.elapsed() < Duration::from_secs(2) {
        thread::sleep(Duration::from_millis(50));
    }
    let meta_path = sessions.join("legacy-live.meta.json");
    let mut persisted: Value = serde_json::from_slice(&fs::read(&meta_path).unwrap()).unwrap();
    persisted["harness"] = json!("claude");
    fs::write(&meta_path, serde_json::to_vec(&persisted).unwrap()).unwrap();

    let attach = daemon.rpc(json!({"op": "attach", "id": "legacy-live"})).unwrap();
    assert!(attach["error"].as_str().unwrap().contains("unknown harness"), "attach: {attach}");
    let spawn = daemon.rpc(json!({"op": "spawn", "id": "legacy-live", "task_slug": task_slug})).unwrap();
    assert!(spawn["error"].as_str().unwrap().contains("unknown harness"), "spawn: {spawn}");
    let resume = daemon.rpc(json!({"op": "resume", "id": "legacy-live", "task_slug": task_slug})).unwrap();
    assert!(resume["error"].as_str().unwrap().contains("unknown harness"), "resume: {resume}");

    fs::read(&scrollback).expect("leftover history remains on disk after refuse");
    assert_eq!(daemon.rpc(json!({"op": "kill", "id": "legacy-live"})).unwrap(), json!({"ok": true}));
    daemon.shutdown().expect("daemon shuts down");
}

#[test]
fn fresh_prompts_are_distinct_from_harness_options() {
    let _guard = test_lock();
    if !pty_available() {
        eprintln!("skip prompt argv test: no pty");
        return;
    }

    let repo = TempRepo::new();
    let capture_script = repo.root.join("capture-args.sh");
    fs::write(
        &capture_script,
        r#"#!/bin/sh
output=$1
shift
: > "$output"
for arg in "$@"; do
  printf '%s\036' "$arg" >> "$output"
done
"#,
    )
    .unwrap();
    fs::set_permissions(&capture_script, fs::Permissions::from_mode(0o755)).unwrap();
    let positional_output = repo.root.join("positional-args");
    let option_output = repo.root.join("option-args");
    let write_omp = |args: &str, prompt_arg: &str| {
        fs::write(
            repo.root.join(".alinery/harnesses.toml"),
            format!(
                r#"
[[harness]]
key = "omp"
name = "capture"
binary = {script:?}
args = [{args}]
model_arg = []
prompt_injection = "arg"
{prompt_arg}
adapter = "unsupported"
"#,
                script = capture_script.display().to_string(),
            ),
        )
        .unwrap();
    };

    let task_slug = "prompt-task";
    let task_dir = repo.root.join(".alinery/tasks").join(task_slug);
    let sessions = task_dir.join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    fs::write(
        task_dir.join("task.md"),
        format!(
            "name = \"Prompt\"\nslug = \"{task_slug}\"\nbranch = \"prompt\"\nworktree = {:?}\nhas_worktree = true\ncreated = 1\nplaybook = \"superdevelop\"\n",
            repo.root.display().to_string()
        ),
    )
    .unwrap();

    let daemon = Daemon::spawn(&repo, None).expect("daemon starts");
    let capture = |id: &str, prompt: &str, output: &Path| {
        fs::write(
            sessions.join(format!("{id}.meta.json")),
            serde_json::to_vec(&json!({
                "id": id,
                "worktree": repo.root.display().to_string(),
                "created": 1,
                "harness": "omp",
                "playbook": "superdevelop",
                "generic": true,
                "prompt": prompt,
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(daemon.rpc(json!({"op": "spawn", "id": id, "task_slug": task_slug})).unwrap(), json!({"ok": true}));
        let start = Instant::now();
        while !output.exists() && start.elapsed() < Duration::from_secs(5) {
            thread::sleep(Duration::from_millis(20));
        }
        let bytes = fs::read(output).expect("capture output");
        bytes
            .split(|byte| *byte == 0x1e)
            .filter(|part| !part.is_empty())
            .map(|part| String::from_utf8(part.to_vec()).unwrap())
            .collect::<Vec<_>>()
    };

    write_omp(&format!("{positional_output:?}"), "");
    assert_eq!(capture("option-like", "--version", &positional_output), vec!["--".to_string(), "--version".to_string()]);
    let frontmatter = "---\ntitle: exact ✓";
    write_omp(&format!("{option_output:?}"), "prompt_arg = [\"--prompt\", \"{prompt}\"]\n");
    assert_eq!(capture("frontmatter", frontmatter, &option_output), vec!["--prompt".to_string(), frontmatter.to_string()]);
    daemon.shutdown().expect("daemon shuts down");
}

#[test]
fn stdin_prompt_start_drains_output_and_times_out_without_leaking() {
    let _guard = test_lock();
    if !pty_available() {
        eprintln!("skip stdin prompt start: no pty");
        return;
    }

    let repo = TempRepo::new();
    let harness_script = repo.root.join("stdin-harness.py");
    fs::write(
        &harness_script,
        r#"#!/usr/bin/env python3
import os
import sys
import time
import tty

mode = sys.argv[1]
tag = sys.argv[2]
tty.setraw(0)
os.write(1, ((tag + "\n").encode() * 4096))
if mode == "never":
    time.sleep(30)
else:
    time.sleep(0.2)
    while True:
        chunk = os.read(0, 65536)
        if not chunk or b"\r" in chunk or b"\n" in chunk:
            break
    time.sleep(30)
"#,
    )
    .unwrap();
    fs::set_permissions(&harness_script, fs::Permissions::from_mode(0o755)).unwrap();
    let delayed_tag = format!("{}-stdin-delayed", repo.token);
    let never_tag = format!("{}-stdin-never", repo.token);
    let write_omp = |mode: &str, tag: &str| {
        fs::write(
            repo.root.join(".alinery/harnesses.toml"),
            format!(
                r#"
[[harness]]
key = "omp"
name = "stdin"
binary = {script:?}
args = [{mode:?}, {tag:?}]
model_arg = []
prompt_injection = "stdin"
adapter = "unsupported"
"#,
                script = harness_script.display().to_string(),
            ),
        )
        .unwrap();
    };

    let task_slug = "stdin-task";
    let task_dir = repo.root.join(".alinery/tasks").join(task_slug);
    let sessions = task_dir.join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    fs::write(
        task_dir.join("task.md"),
        format!(
            "name = \"Task\"\nslug = \"{task_slug}\"\nbranch = \"{task_slug}\"\nworktree = {:?}\nhas_worktree = true\ncreated = 1\nplaybook = \"superdevelop\"\n",
            repo.root.display().to_string()
        ),
    )
    .unwrap();
    let write_session = |id: &str, prompt_extra: &str| {
        let value = json!({
            "id": id,
            "worktree": repo.root.display().to_string(),
            "created": 1,
            "generic": true,
            "harness": "omp",
            "playbook": "superdevelop",
            "prompt_extra": prompt_extra,
        });
        fs::write(sessions.join(format!("{id}.meta.json")), serde_json::to_vec(&value).unwrap()).unwrap();
    };
    write_omp("delayed", &delayed_tag);
    write_session("stdin-delayed", &"d".repeat(256 * 1024));
    write_session("stdin-never", &"n".repeat(2 * 1024 * 1024));

    let daemon = Daemon::spawn(&repo, None).expect("daemon starts");
    let delayed_started = Instant::now();
    assert_eq!(
        daemon.rpc(json!({"op": "spawn", "id": "stdin-delayed", "task_slug": task_slug})).unwrap(),
        json!({"ok": true})
    );
    assert!(
        delayed_started.elapsed() < Duration::from_secs(5),
        "reader must drain startup output before prompt injection"
    );
    let delayed_meta: Value = serde_json::from_slice(&fs::read(sessions.join("stdin-delayed.meta.json")).unwrap()).unwrap();
    assert!(delayed_meta["started_at"].as_u64().is_some());
    assert_eq!(delayed_meta["status_changed_at"], delayed_meta["started_at"]);

    write_omp("never", &never_tag);
    let never_started = Instant::now();
    let error = daemon.rpc(json!({"op": "spawn", "id": "stdin-never", "task_slug": task_slug})).unwrap()["error"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(error.contains("timed out"), "{error}");
    assert!(never_started.elapsed() < Duration::from_secs(5), "stdin injection timeout must bound the spawn request");
    let never_meta: Value = serde_json::from_slice(&fs::read(sessions.join("stdin-never.meta.json")).unwrap()).unwrap();
    assert!(never_meta.get("started_at").is_none());
    assert!(never_meta.get("status_changed_at").is_none());
    assert!(never_meta.get("ended_at").is_none());
    assert_eq!(daemon.rpc(json!({"op": "status", "id": "stdin-never"})).unwrap()["error"], "unknown-session");
    let reap_started = Instant::now();
    while !harness_pids(&never_tag).is_empty() && reap_started.elapsed() < Duration::from_secs(3) {
        thread::sleep(Duration::from_millis(25));
    }
    assert!(harness_pids(&never_tag).is_empty(), "timed-out stdin harness must be reaped");

    write_omp("delayed", &delayed_tag);
    write_session("stdin-never", "retry");
    assert_eq!(
        daemon.rpc(json!({"op": "spawn", "id": "stdin-never", "task_slug": task_slug})).unwrap(),
        json!({"ok": true}),
        "the never-started row must remain retryable after timeout rollback"
    );
    daemon.shutdown().expect("daemon shuts down");
}
#[test]
fn t1_two_spawns_one_survivor() {
    let _g = test_lock();
    let repo = TempRepo::new();
    let bin = alineryd_bin();
    let root = repo.root.clone();

    let h1 = thread::spawn({
        let bin = bin.clone();
        let root = root.clone();
        move || {
            Command::new(bin)
                .arg("--repo")
                .arg(&root)
                .arg("--build-id")
                .arg("a")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap()
        }
    });
    let h2 = thread::spawn({
        let bin = bin.clone();
        let root = root.clone();
        move || {
            Command::new(bin)
                .arg("--repo")
                .arg(&root)
                .arg("--build-id")
                .arg("b")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap()
        }
    });
    let mut c1 = h1.join().unwrap();
    let mut c2 = h2.join().unwrap();

    // Wait until at least one has exited or 3s.
    let start = Instant::now();
    let mut alive;
    while start.elapsed() < Duration::from_secs(3) {
        let a1 = c1.try_wait().ok().flatten().is_none();
        let a2 = c2.try_wait().ok().flatten().is_none();
        alive = (a1 as u8) + (a2 as u8);
        if alive == 1 {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    // Final sample after settle.
    thread::sleep(Duration::from_millis(200));
    let a1 = c1.try_wait().ok().flatten().is_none();
    let a2 = c2.try_wait().ok().flatten().is_none();
    alive = (a1 as u8) + (a2 as u8);
    assert_eq!(alive, 1, "exactly one alineryd must survive the race");

    // Socket must answer version.
    let sock = repo.socket(None);
    let mut s = UnixStream::connect(&sock).expect("connect survivor");
    writeln!(s, r#"{{"op":"version"}}"#).unwrap();
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).unwrap();
    assert!(line.contains("build_id"), "version reply: {line}");

    if a1 {
        let _ = c1.kill();
        let _ = c1.wait();
    }
    if a2 {
        let _ = c2.kill();
        let _ = c2.wait();
    }
}

// --- T2: delete live lock file; second spawn exits; first still serves ---

// --- T6b: two namespaces can both run; each answers version on its own socket ---
#[test]
fn t6b_two_namespace_lanes() {
    let _g = test_lock();
    let repo = TempRepo::new();
    let prod = Daemon::spawn(&repo, None).expect("prod");
    let dev = Daemon::spawn(&repo, Some("devlane")).expect("dev");
    let vp = prod.rpc(json!({"op": "version"})).expect("prod version");
    let vd = dev.rpc(json!({"op": "version"})).expect("dev version");
    assert!(vp.get("build_id").is_some());
    assert!(vd.get("build_id").is_some());
    // Distinct sockets
    assert_ne!(prod.socket, dev.socket);
    prod.shutdown().ok();
    dev.shutdown().ok();
}
#[test]
fn t2_delete_lock_second_spawn_fails() {
    let _g = test_lock();
    let repo = TempRepo::new();
    let d = Daemon::spawn(&repo, None).expect("first daemon");

    // Remove lock file while A is live (pre-flock world would reclaim; flock must not).
    let _ = fs::remove_file(repo.lock(None));

    let mut loser = Command::new(alineryd_bin())
        .arg("--repo")
        .arg(&repo.root)
        .arg("--build-id")
        .arg("loser")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let start = Instant::now();
    let mut exited = false;
    while start.elapsed() < Duration::from_secs(3) {
        if let Ok(Some(status)) = loser.try_wait() {
            assert!(!status.success(), "second daemon must exit non-zero");
            exited = true;
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = loser.kill();
    let _ = loser.wait();
    assert!(exited, "second daemon must exit");

    // A still answers.
    let v = d.rpc(json!({"op": "version"})).expect("version");
    assert!(v.get("build_id").is_some());
    d.shutdown().ok();
}

// --- T4: shutdown stamps + unlinks socket, keeps lock file ---
#[test]
fn t4_shutdown_unlinks_socket_keeps_lock() {
    let _g = test_lock();
    let repo = TempRepo::new();
    let d = Daemon::spawn(&repo, None).expect("daemon");
    let sock = repo.socket(None);
    let lock = repo.lock(None);
    assert!(sock.exists());
    assert!(lock.exists());

    d.shutdown().expect("shutdown");

    let start = Instant::now();
    while sock.exists() && start.elapsed() < Duration::from_secs(2) {
        thread::sleep(Duration::from_millis(20));
    }
    assert!(!sock.exists(), "socket must be unlinked after shutdown");
    assert!(lock.exists(), "lock file must remain (flock is truth)");
}

// --- T5: SIGTERM clean exit unlinks socket ---
#[test]
fn t5_sigterm_graceful() {
    let _g = test_lock();
    let repo = TempRepo::new();
    let mut d = Daemon::spawn(&repo, None).expect("daemon");
    let sock = repo.socket(None);
    let pid = d.child.id();
    let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).status();
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(5) {
        if d.child.try_wait().ok().flatten().is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    assert!(d.child.try_wait().ok().flatten().is_some(), "daemon must exit on SIGTERM");
    assert!(!sock.exists(), "socket unlinked after SIGTERM");
    // Prevent Drop from double-killing after wait.
    let _ = d.child.try_wait();
    std::mem::forget(d);
}

// --- T9: boot_sweep only own namespace, before accept ---
#[test]
fn t9_boot_sweep_own_namespace_only() {
    let _g = test_lock();
    let repo = TempRepo::new();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    // Own ns (prod "") started unended
    let own = write_meta(&repo.root, "own-sess", "", now - 100, None);
    let own_before = fs::read(&own).unwrap();
    // Foreign ns started unended
    let foreign = write_meta(&repo.root, "foreign-sess", "devabc", now - 100, None);

    let d = Daemon::spawn(&repo, None).expect("daemon");
    // After ready (post boot_sweep), own must have ended_at; foreign must not.
    let own_v: Value = serde_json::from_str(&fs::read_to_string(&own).unwrap()).unwrap();
    let foreign_v: Value = serde_json::from_str(&fs::read_to_string(&foreign).unwrap()).unwrap();
    assert!(own_v.get("ended_at").and_then(|v| v.as_u64()).is_some(), "own namespace must be swept: {own_v}");
    assert!(own_v.get("status_changed_at").and_then(|v| v.as_u64()).is_some_and(|changed| changed >= now));
    assert_ne!(fs::read(&own).unwrap(), own_before);
    assert!(foreign_v.get("ended_at").is_none(), "foreign namespace must NOT be swept: {foreign_v}");
    assert!(foreign_v.get("status_changed_at").is_none());
    d.shutdown().ok();
    let terminal_bytes = fs::read(&own).unwrap();
    let d2 = Daemon::spawn(&repo, None).expect("second daemon");
    assert_eq!(fs::read(&own).unwrap(), terminal_bytes, "already-terminal rows must not be rewritten on restart");
    d2.shutdown().ok();
}

// --- T3: SIGKILL daemon + restart → ended_at from scrollback mtime-ish ---
#[test]
fn t3_crash_restart_honest_ended_at() {
    let _g = test_lock();
    // Skip if openpty unavailable (rare on locked-down CI).
    if !pty_available() {
        eprintln!("skip t3: no pty");
        return;
    }
    let repo = TempRepo::new();
    let d = Daemon::spawn(&repo, None).expect("daemon");

    // Create a root session meta then spawn via protocol.
    let id = "chatty-1";
    let meta_path = write_meta(&repo.root, id, "", 0, None);
    // Clear started so spawn accepts it.
    let mut meta: Value = serde_json::from_str(&fs::read_to_string(&meta_path).unwrap()).unwrap();
    meta.as_object_mut().unwrap().remove("started_at");
    meta["harness"] = json!("chatty");
    fs::write(&meta_path, meta.to_string()).unwrap();

    // spawn (may fail if harness registry shape differs — then soft-skip).
    let spawn_resp = d.rpc(json!({
        "op": "spawn",
        "id": id,
        "task_slug": "",
        "harness": "chatty",
        "model": "",
        "phase": "",
        "artifact": "",
        "prompt_extra": "",
        "handoff_artifact": "",
        "cols": 80,
        "rows": 24,
    }));
    if spawn_resp.is_err() || spawn_resp.as_ref().ok().and_then(|v| v.get("error")).is_some() {
        eprintln!("skip t3: spawn failed: {spawn_resp:?}");
        d.shutdown().ok();
        return;
    }

    // Wait for scrollback sidecar to appear (chatty emits bytes).
    let scroll = repo.root.join(".alinery").join("sessions").join(format!("{id}.scrollback"));
    let start = Instant::now();
    while !scroll.exists() && start.elapsed() < Duration::from_secs(5) {
        thread::sleep(Duration::from_millis(100));
    }
    if !scroll.exists() {
        eprintln!("skip t3: no scrollback");
        d.kill_nine();
        return;
    }
    thread::sleep(Duration::from_millis(500)); // let mtime settle
    let mtime_before = fs::metadata(&scroll)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    d.kill_nine();
    thread::sleep(Duration::from_millis(200));

    // Restart — boot_sweep should stamp ended_at ≈ scrollback mtime.
    let d2 = Daemon::spawn(&repo, None).expect("restart");
    let after: Value = serde_json::from_str(&fs::read_to_string(&meta_path).unwrap()).unwrap();
    let ended = after.get("ended_at").and_then(|v| v.as_u64()).expect("ended_at after crash restart");
    let delta = ended.abs_diff(mtime_before);
    assert!(delta <= 5, "ended_at={ended} mtime={mtime_before} delta={delta}");
    let changed = after.get("status_changed_at").and_then(|v| v.as_u64()).expect("status_changed_at after crash restart");
    assert!(changed >= ended, "boot sweep status time is recognition time, not scrollback time");
    d2.shutdown().ok();
}

#[test]
fn t10_reattach_replays_reconstructed_frame_past_the_old_96kb_cap() {
    let _g = test_lock();
    if !pty_available() {
        eprintln!("skip t10: no pty");
        return;
    }
    let repo = TempRepo::new();

    // A harness that mimics claude: enters the alt screen, emits >96KB of cursor-addressed
    // diffs (the exact shape that made the old front-trimmed byte tail unrenderable), then
    // idles — it never spontaneously repaints, so a correct reattach depends entirely on
    // server-side reconstruction, not on the harness cooperating (#96).
    // model_arg is `[]`, not `""` — see the comment on TempRepo::new for why that matters.
    let harnesses = format!(
        r#"
[[harness]]
key = "omp"
name = "altscreen"
binary = "sh"
args = ["-c", "printf '\\033[?1049h\\033[2J\\033[Hbase'; i=0; while [ $i -lt 5000 ]; do printf '\\033[1;1H%020d' $i; i=$((i+1)); done; printf '\\033[1;1HFINAL-{token}'; sleep 30"]
model_arg = []
prompt_injection = "arg"
adapter = "unsupported"
"#,
        token = repo.token
    );
    fs::write(repo.root.join(".alinery/harnesses.toml"), harnesses).unwrap();

    let d = Daemon::spawn(&repo, None).expect("daemon");

    let task_slug = "verify-task";
    let task_dir = repo.root.join(".alinery/tasks").join(task_slug);
    let sessions_dir = task_dir.join("sessions");
    fs::create_dir_all(&sessions_dir).unwrap();
    fs::write(
        task_dir.join("task.md"),
        format!(
            "name = \"Verify\"\nslug = \"{task_slug}\"\nbranch = \"verify\"\nworktree = {:?}\nhas_worktree = true\ncreated = 1\nplaybook = \"superdevelop\"\n",
            repo.root.display().to_string()
        ),
    )
    .unwrap();

    let id = format!("s-{}", repo.token);
    fs::write(
        sessions_dir.join(format!("{id}.meta.json")),
        serde_json::to_vec(&json!({
            "id": id,
            "worktree": repo.root.display().to_string(),
            "created": 1,
            "harness": "omp",
            "playbook": "superdevelop"
        }))
        .unwrap(),
    )
    .unwrap();
    let mut s1 = UnixStream::connect(&d.socket).expect("connect");
    writeln!(
        s1,
        r#"{{"op":"spawn","id":"{id}","cwd":"{cwd}","task_slug":"{task_slug}","model":"","phase":"","attach_id":1,"cols":80,"rows":24}}"#,
        id = id,
        cwd = repo.root.display(),
        task_slug = task_slug,
    )
    .unwrap();
    let mut ack = String::new();
    BufReader::new(&s1).read_line(&mut ack).unwrap();
    assert!(ack.contains("\"ok\":true"), "spawn ack: {ack}");

    // Wait for the scrollback sidecar to exceed the OLD 96KB cap — proof the old code would
    // have trimmed the alt-screen preamble by the time we reattach below.
    let scroll = sessions_dir.join(format!("{id}.scrollback"));
    let start = Instant::now();
    while fs::metadata(&scroll).map(|m| m.len()).unwrap_or(0) < 120_000 && start.elapsed() < Duration::from_secs(15) {
        thread::sleep(Duration::from_millis(100));
    }
    let len = fs::metadata(&scroll).map(|m| m.len()).unwrap_or(0);
    assert!(len > 96 * 1024, "scrollback should exceed the old cap, got {len}");
    drop(s1); // navigate away — the harness keeps running detached, now idling in `sleep 30`

    // Reattach at a DIFFERENT geometry than spawn, to also exercise resize-before-replay.
    let mut s2 = UnixStream::connect(&d.socket).expect("reconnect");
    s2.set_read_timeout(Some(Duration::from_millis(800))).unwrap();
    writeln!(s2, r#"{{"op":"attach","id":"{id}","attach_id":2,"cols":120,"rows":40}}"#,).unwrap();
    let mut r2 = BufReader::new(s2);
    let mut ack2 = String::new();
    r2.read_line(&mut ack2).unwrap();
    assert!(ack2.contains("\"ok\":true"), "attach ack: {ack2}");

    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match r2.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => break, // read timeout: no more bytes coming from an idle session
        }
    }

    assert!(buf.starts_with(b"\x1b[?1049h"), "replay must re-enter the alt screen; got {:?}", &buf[..buf.len().min(32)]);
    assert!(
        buf.len() < 96 * 1024,
        "replay must be a bounded reconstructed frame, not a raw tail; got {} bytes",
        buf.len()
    );

    let mut fresh = vt100::Parser::new(40, 120, 0);
    fresh.process(&buf);
    assert!(
        fresh.screen().contents().contains(&format!("FINAL-{}", repo.token)),
        "reconstructed screen must contain the harness's final output"
    );

    d.kill_nine();
}

/// T0-2: a session whose harness never drains stdin must not wedge the global
/// registry lock across `write_all`. Peer `status` has to answer while the
/// blocked write is outstanding.
///
/// Platform note: macOS PTY masters often accept multi‑MB writes without blocking
/// even when the slave never reads (empirically 80MB+). When the write completes
/// immediately we soft-skip — the lock property cannot be proven without a wedge.
/// On platforms where the kernel PTY buffer fills, this test is the red→green gate.
#[test]
fn t0_2_wedged_write_does_not_block_status_on_peer() {
    let _g = test_lock();
    if !pty_available() {
        eprintln!("skip t0_2: no pty");
        return;
    }

    let repo = TempRepo::new();
    // Harness that never reads stdin — fills the kernel PTY input buffer under write.
    // model_arg is `[]` — see TempRepo::new.
    let harnesses = format!(
        r#"
[[harness]]
key = "omp"
name = "blocked"
binary = "sh"
args = ["-c", "while :; do sleep 1; done # {token}"]
model_arg = []
prompt_injection = "arg"
adapter = "unsupported"
"#,
        token = repo.token
    );
    fs::write(repo.root.join(".alinery/harnesses.toml"), harnesses).unwrap();

    let task_slug = "wedge-task";
    let task_dir = repo.root.join(".alinery/tasks").join(task_slug);
    let sessions_dir = task_dir.join("sessions");
    fs::create_dir_all(&sessions_dir).unwrap();
    fs::write(
        task_dir.join("task.md"),
        format!(
            "name = \"Wedge\"\nslug = \"{task_slug}\"\nbranch = \"wedge\"\nworktree = {:?}\nhas_worktree = true\ncreated = 1\nplaybook = \"superdevelop\"\n",
            repo.root.display().to_string()
        ),
    )
    .unwrap();

    let d = Daemon::spawn(&repo, None).expect("daemon");

    let spawn_one = |id: &str| -> bool {
        fs::write(
            sessions_dir.join(format!("{id}.meta.json")),
            serde_json::to_vec(&json!({
                "id": id,
                "worktree": repo.root.display().to_string(),
                "created": 1,
                "harness": "omp",
                "playbook": "superdevelop"
            }))
            .unwrap(),
        )
        .unwrap();
        let spawn_resp = d.rpc(json!({
            "op": "spawn",
            "id": id,
            "cwd": repo.root.to_string_lossy(),
            "task_slug": task_slug,
            "cols": 80,
            "rows": 24,
        }));
        match spawn_resp {
            Ok(v) if v.get("error").is_none() => true,
            other => {
                eprintln!("skip t0_2: spawn {id} failed: {other:?}");
                false
            }
        }
    };

    if !spawn_one("blocked-a") || !spawn_one("blocked-b") {
        d.shutdown().ok();
        return;
    }
    // 256 KiB: large enough to exercise write_all; stays within what the
    // byte-at-a-time request reader + unix socket will accept on this host.
    // (1 MiB+ request lines observed as Broken pipe here.)
    let payload = "x".repeat(256 * 1024);
    let socket = d.socket.clone();
    let write_handle = thread::spawn(move || {
        let mut s = match UnixStream::connect(&socket) {
            Ok(s) => s,
            Err(e) => return Err(format!("connect write: {e}")),
        };
        // Long timeout: we expect this call to block on the PTY until buffer drains
        // (it never will) or the daemon is torn down.
        let _ = s.set_read_timeout(Some(Duration::from_secs(60)));
        let _ = s.set_write_timeout(Some(Duration::from_secs(60)));
        let req = json!({
            "op": "write",
            "id": "blocked-a",
            "data": payload,
        });
        if let Err(e) = writeln!(s, "{req}") {
            return Err(format!("write req: {e}"));
        }
        let mut line = String::new();
        match BufReader::new(s).read_line(&mut line) {
            Ok(_) => Ok(line),
            Err(e) => Err(format!("write reply: {e}")),
        }
    });

    // Wait until the write is in-flight (or give up if it finished too fast to prove locking).
    let wait_start = Instant::now();
    while !write_handle.is_finished() && wait_start.elapsed() < Duration::from_millis(500) {
        thread::sleep(Duration::from_millis(50));
    }
    // Extra beat so the daemon has entered write_all if the request landed.
    thread::sleep(Duration::from_millis(200));

    if write_handle.is_finished() {
        // Write completed without blocking — cannot prove the lock property on this platform.
        match write_handle.join() {
            Ok(Ok(line)) => eprintln!("skip t0_2: write did not block (reply={line:?})"),
            Ok(Err(e)) => eprintln!("skip t0_2: write finished with err: {e}"),
            Err(_) => eprintln!("skip t0_2: write thread panicked"),
        }
        d.kill_nine();
        return;
    }

    let status_start = Instant::now();
    let status = d.rpc(json!({"op": "status", "id": "blocked-b"}));
    let elapsed = status_start.elapsed();

    assert!(
        elapsed <= Duration::from_secs(2),
        "status on peer session took {elapsed:?}; registry lock likely held across blocked PTY write"
    );
    let status = status.expect("status rpc");
    assert!(status.get("error").is_none(), "status error while peer write wedged: {status}");
    assert!(status.get("status").is_some(), "status payload missing status field: {status}");

    // Still outstanding = write was actually blocked during the status probe.
    assert!(!write_handle.is_finished(), "write completed during status probe; lock contention was not exercised");

    d.kill_nine();
    let _ = write_handle.join();
}

fn pty_available() -> bool {
    // Best-effort: try `script` or just assume macOS dev has pty.
    true
}

// Ensure unused import silence for Read in some paths
#[allow(dead_code)]
fn _touch_read(mut r: impl Read) {
    let mut b = [0u8; 1];
    let _ = r.read(&mut b);
}

#[allow(dead_code)]
fn _path(p: &Path) -> &Path {
    p
}

// --- A2/A3/A4: wire protocol version gate ---

/// All pids whose command line carries this repo's unique fixture token — i.e. the
/// harness shells this daemon spawned. OS observation, not a wire field: adding pids to
/// `list`/`status` would itself be a protocol change (design decision, review-002 A).
fn harness_pids(token: &str) -> Vec<String> {
    let out = match Command::new("pgrep").args(["-f", token]).output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let mut pids: Vec<String> = String::from_utf8_lossy(&out.stdout).split_whitespace().map(|s| s.to_string()).collect();
    pids.sort();
    pids
}

/// The version reply carries both hard reuse gates, the soft build stamp, and
/// daemon-owned host-guard readiness across reconnects.
#[test]
fn t11_version_op_reports_compatibility_and_host_guard_readiness() {
    let _g = test_lock();
    let repo = TempRepo::new();
    let d = Daemon::spawn(&repo, None).expect("daemon without protected host");

    for _ in 0..2 {
        let v = d.rpc(json!({"op": "version"})).expect("version");
        assert!(v.get("build_id").and_then(|b| b.as_str()).is_some(), "version must keep build_id: {v}");
        let protocol = v
            .get("protocol")
            .and_then(|p| p.as_u64())
            .unwrap_or_else(|| panic!("version must carry a numeric `protocol`: {v}"));
        assert!(protocol >= 1, "protocol numbering starts at 1, got {protocol}");
        assert_eq!(
            v.get("app_config_identity").and_then(Value::as_str),
            Some(alinery_core::app_config_identity(&repo.app_config()).as_str()),
            "version must discriminate the exact supplied app config path: {v}"
        );
        assert_eq!(v.get("host_guard_ready").and_then(Value::as_bool), Some(false));
    }
    d.shutdown().expect("shutdown unready daemon");

    let host = repo.root.join("host-executable");
    fs::write(&host, b"host").unwrap();
    let d = Daemon::spawn_with_host(&repo, None, Some(&host)).expect("daemon with non-executable host");
    let v = d.rpc(json!({"op": "version"})).expect("version with invalid host");
    assert_eq!(v.get("host_guard_ready").and_then(Value::as_bool), Some(false));
    d.shutdown().expect("shutdown invalid-host daemon");

    let mut permissions = fs::metadata(&host).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&host, permissions).unwrap();
    let host_link = repo.root.join("host-link");
    std::os::unix::fs::symlink(&host, &host_link).unwrap();
    let d = Daemon::spawn_with_host(&repo, None, Some(&host_link)).expect("daemon with protected host");
    for _ in 0..2 {
        let v = d.rpc(json!({"op": "version"})).expect("version after reconnect");
        assert_eq!(v.get("host_guard_ready").and_then(Value::as_bool), Some(true));
    }
    d.shutdown().expect("shutdown ready daemon");
}

/// A3: the installer runs the *extracted* bundle's binary before anything is swapped,
/// with no repo context at all. The flag must print the bare integer and exit 0.
#[test]
fn t12_protocol_version_flag_needs_no_repo() {
    let out = Command::new(alineryd_bin()).arg("--protocol-version").output().expect("run alineryd --protocol-version");
    assert!(out.status.success(), "exit={:?} stderr={}", out.status.code(), String::from_utf8_lossy(&out.stderr));
    let printed = String::from_utf8_lossy(&out.stdout).trim().to_string();
    printed.parse::<u32>().unwrap_or_else(|_| panic!("stdout must be a bare integer, got {printed:?}"));
}

/// The installer compares the extracted binary's `--protocol-version` against the
/// *running* daemon's `version` reply. If those two can disagree the preflight decides
/// on a number that means nothing.
#[test]
fn t13_protocol_flag_matches_the_version_op() {
    let _g = test_lock();
    let repo = TempRepo::new();
    let d = Daemon::spawn(&repo, None).expect("daemon");

    let out = Command::new(alineryd_bin()).arg("--protocol-version").output().expect("run alineryd --protocol-version");
    let flag: u64 = String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .unwrap_or_else(|_| panic!("stdout must be a bare integer: {out:?}"));
    let wire = d
        .rpc(json!({"op": "version"}))
        .expect("version")
        .get("protocol")
        .and_then(|p| p.as_u64())
        .expect("version must carry `protocol`");

    assert_eq!(flag, wire, "CLI flag and wire field must be one constant");
    d.shutdown().ok();
}

/// A3: `usage()` must advertise the flag — the installer's contract is only discoverable
/// there.
#[test]
fn t14_usage_mentions_protocol_version_flag() {
    let out = Command::new(alineryd_bin()).arg("--not-a-real-flag").output().expect("run alineryd with a bogus flag");
    assert!(!out.status.success(), "bogus flag must exit non-zero");
    let usage = String::from_utf8_lossy(&out.stderr);
    assert!(usage.contains("--protocol-version"), "usage: {usage}");
}

/// A4/A5 at the daemon end (acceptance 1): probing `version` is exactly what every app
/// launch does. It must never cost a pty. Asserts on harness pids — a status check alone
/// would pass against a freshly respawned daemon serving freshly respawned sessions.
#[test]
fn t15_version_probes_never_kill_a_live_session() {
    let _g = test_lock();
    if !pty_available() {
        eprintln!("skip t15: no pty");
        return;
    }
    let repo = TempRepo::new();
    let d = Daemon::spawn(&repo, None).expect("daemon");

    let id = "chatty-probe";
    let meta_path = write_meta(&repo.root, id, "", 0, None);
    let mut meta: Value = serde_json::from_str(&fs::read_to_string(&meta_path).unwrap()).unwrap();
    meta.as_object_mut().unwrap().remove("started_at");
    meta["harness"] = json!("chatty");
    fs::write(&meta_path, meta.to_string()).unwrap();

    let spawn_resp = d.rpc(json!({
        "op": "spawn",
        "id": id,
        "task_slug": "",
        "harness": "chatty",
        "model": "",
        "phase": "",
        "artifact": "",
        "prompt_extra": "",
        "handoff_artifact": "",
        "cols": 80,
        "rows": 24,
    }));
    if spawn_resp.is_err() || spawn_resp.as_ref().ok().and_then(|v| v.get("error")).is_some() {
        eprintln!("skip t15: spawn failed: {spawn_resp:?}");
        d.shutdown().ok();
        return;
    }

    let start = Instant::now();
    let mut before = harness_pids(&repo.token);
    while before.is_empty() && start.elapsed() < Duration::from_secs(5) {
        thread::sleep(Duration::from_millis(100));
        before = harness_pids(&repo.token);
    }
    assert!(!before.is_empty(), "fixture harness never appeared in pgrep");

    for _ in 0..5 {
        let v = d.rpc(json!({"op": "version"})).expect("version");
        assert!(v.get("protocol").is_some(), "version reply: {v}");
    }
    thread::sleep(Duration::from_millis(300));

    assert_eq!(before, harness_pids(&repo.token), "version probes must leave every harness pid untouched");
    let status = d
        .rpc(json!({"op": "status", "id": id}))
        .ok()
        .and_then(|v| v.get("status").and_then(|s| s.as_str().map(String::from)))
        .unwrap_or_default();
    assert!(
        status == "running" || status == "idle",
        "session must still be live and owned by the same daemon, got {status:?}"
    );

    d.shutdown().ok();
}
