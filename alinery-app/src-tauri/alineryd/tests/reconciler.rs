//! Repository owner exclusion and legacy checkpoint compatibility with real daemons.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::LazyLock;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use alinery_core::{read_task, SemanticCheckpoint, SessionMeta, Task};

static BIN: LazyLock<PathBuf> = LazyLock::new(|| PathBuf::from(env!("CARGO_BIN_EXE_alineryd")));

/// Concurrent lane startups elect one owner; the loser can restart after it exits.
#[test]
fn t7b_concurrent_prod_and_dev_elect_one_repo_owner() {
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

    let deadline = Instant::now() + Duration::from_secs(5);
    let prod_won = loop {
        if let Some(status) = prod.try_wait().unwrap() {
            assert!(!status.success());
            break false;
        }
        if let Some(status) = dev.try_wait().unwrap() {
            assert!(!status.success());
            break true;
        }
        assert!(Instant::now() < deadline, "two owners remained alive");
        thread::sleep(Duration::from_millis(20));
    };
    let (winner, namespace) = if prod_won { (&mut prod, None) } else { (&mut dev, Some("devlane")) };
    let client = alinery_core::daemon_client::DaemonClient {
        socket_path: alinery_core::alineryd_socket_path(&root, namespace),
    };
    while client.version_checked().is_err() {
        assert!(Instant::now() < deadline, "winner did not bind");
        thread::sleep(Duration::from_millis(20));
    }
    winner.kill().unwrap();
    winner.wait().unwrap();
    let mut replacement = Command::new(&*BIN)
        .arg("--repo")
        .arg(&root)
        .arg("--socket-namespace")
        .arg("replacement")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let client = alinery_core::daemon_client::DaemonClient {
        socket_path: alinery_core::alineryd_socket_path(&root, Some("replacement")),
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    while client.version_checked().is_err() {
        assert!(replacement.try_wait().unwrap().is_none(), "replacement failed");
        assert!(Instant::now() < deadline, "replacement did not bind");
        thread::sleep(Duration::from_millis(20));
    }
    replacement.kill().unwrap();
    replacement.wait().unwrap();
    fs::remove_dir_all(&root).unwrap();
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
