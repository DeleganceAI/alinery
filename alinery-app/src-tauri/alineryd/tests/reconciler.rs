//! T7b: two alineryd lanes over one repo — prod holds the reconciler lease, dev defers
//! instead of dying. Needs real processes, so it lives here.
//!
//! Pure flock mutual exclusion (T7) is `alinery_core::lockfile::tests` — deterministic, and
//! deliberately not in this binary, which forks subprocesses that can transiently inherit
//! a lock fd and make a same-process re-lock spuriously fail.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::LazyLock;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use alinery_core::{read_task, SemanticCheckpoint, SessionMeta, Task};

static BIN: LazyLock<PathBuf> = LazyLock::new(|| PathBuf::from(env!("CARGO_BIN_EXE_alineryd")));

/// T7b smoke: prod holds lease; dev lane does not die (it just skips reconcile).
#[test]
fn t7b_prod_and_dev_both_live() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let root = PathBuf::from("/tmp").join(format!("al-t7b-{n}"));
    fs::create_dir_all(root.join(".alinery")).unwrap();

    let mut prod = Command::new(&*BIN)
        .arg("--repo")
        .arg(&root)
        .arg("--build-id")
        .arg("prod")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut dev = Command::new(&*BIN)
        .arg("--repo")
        .arg(&root)
        .arg("--build-id")
        .arg("dev")
        .arg("--socket-namespace")
        .arg("devlane")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    // Both should stay alive for a few seconds (dev defers lease, does not exit).
    thread::sleep(Duration::from_millis(500));
    assert!(prod.try_wait().ok().flatten().is_none(), "prod alive");
    assert!(dev.try_wait().ok().flatten().is_none(), "dev alive");

    // Kill prod → lock released; dev can take lease (we only assert it stays alive).
    let _ = prod.kill();
    let _ = prod.wait();
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(6) {
        if dev.try_wait().ok().flatten().is_some() {
            panic!("dev should keep running after prod death");
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = dev.kill();
    let _ = dev.wait();
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn legacy_checkpoints_remain_readable_without_auto_advance() {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_nanos()).unwrap_or(0);
    let root = PathBuf::from("/tmp").join(format!("al-selected-playbook-{n}"));
    let task_dir = root.join(".alinery/tasks/task");
    let sessions_dir = task_dir.join("sessions");
    let artifacts_dir = task_dir.join("artifacts");
    fs::create_dir_all(&sessions_dir).unwrap();
    fs::create_dir_all(&artifacts_dir).unwrap();
    fs::write(
        root.join(".alinery/harnesses.toml"),
        r#"
[[harness]]
key = "omp"
name = "recording"
binary = "sh"
args = ["-c", "sleep 30"]
model_arg = []
prompt_injection = "arg"
adapter = "unsupported"
"#,
    )
    .unwrap();

    let task = Task {
        name: "task".into(),
        slug: "task".into(),
        branch: "task".into(),
        worktree: root.display().to_string(),
        has_worktree: true,
        created: 1,
        playbook: "one-shot".into(),
        auto_advance: vec!["questions_to_research".into()],
        ..Default::default()
    };
    fs::write(task_dir.join("task.md"), toml::to_string(&task).unwrap()).unwrap();
    fs::write(artifacts_dir.join("01-research-questions.md"), "complete").unwrap();

    let source = SessionMeta {
        id: "selected-source".into(),
        worktree: root.display().to_string(),
        created: 1,
        harness: "omp".into(),
        playbook: "superdevelop".into(),
        artifact: "01-research-questions.md".into(),
        started_at: Some(1),
        ended_at: Some(2),
        exit_code: Some(0),
        semantic: SemanticCheckpoint {
            phase_completed_at: Some(2),
            ..Default::default()
        },
        ..Default::default()
    };
    fs::write(sessions_dir.join("selected-source.meta.json"), serde_json::to_vec(&source).unwrap()).unwrap();
    let generic = SessionMeta {
        id: "generic-checkpoint".into(),
        worktree: root.display().to_string(),
        created: 3,
        generic: true,
        harness: "omp".into(),
        playbook: "superdevelop".into(),
        semantic: SemanticCheckpoint {
            phase_completed_at: Some(3),
            ..Default::default()
        },
        ..Default::default()
    };
    let daemon_log = root.join("daemon.log");
    fs::write(sessions_dir.join("generic-checkpoint.meta.json"), serde_json::to_vec(&generic).unwrap()).unwrap();

    let app_config = root.join(".alinery/app.toml");
    let mut daemon = Command::new(&*BIN)
        .arg("--repo")
        .arg(&root)
        .arg("--app-config")
        .arg(&app_config)
        .arg("--build-id")
        .arg("selected-playbook")
        .stdout(Stdio::null())
        .stderr(Stdio::from(fs::File::create(&daemon_log).unwrap()))
        .spawn()
        .unwrap();

    thread::sleep(Duration::from_millis(750));
    assert!(daemon.try_wait().unwrap().is_none(), "daemon must preserve legacy history without launching it");
    let metas = fs::read_dir(&sessions_dir)
        .unwrap()
        .flatten()
        .filter_map(|entry| fs::read(entry.path()).ok())
        .filter_map(|raw| serde_json::from_slice::<SessionMeta>(&raw).ok())
        .collect::<Vec<_>>();
    assert_eq!(metas.len(), 2, "legacy and auxiliary checkpoints must not create graph executions");
    assert!(!task_dir.join("execution.json").exists(), "legacy data is never automatically migrated");
    assert_eq!(read_task(&root, "task").unwrap().playbook, "one-shot");
    let generic_after = metas.iter().find(|meta| meta.id == generic.id).unwrap();
    assert_eq!(generic_after.semantic.phase_completed_at, Some(3));

    unsafe {
        libc::kill(daemon.id() as i32, libc::SIGTERM);
    }
    let _ = daemon.wait();
    let _ = fs::remove_dir_all(root);
}
