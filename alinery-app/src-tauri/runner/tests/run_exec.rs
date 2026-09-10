use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

fn make_executable(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
}

fn runner_command(root: &Path, fixture: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_alinery-runner"));
    command
        .current_dir(root)
        .env("HOME", root.join("home"))
        .env("ALINERY_RUNNER_PATH", env!("CARGO_BIN_EXE_alinery-runner"))
        .env("ALINERY_SESSION_ID", "runner-exec-test")
        .env("ALINERY_DAEMON_SOCKET", root.join("daemon.sock"))
        .env("ALINERY_DAEMON_NAMESPACE", "runner-exec-test")
        .env("ALINERY_EVENT_PROTOCOL_VERSION", "1")
        .env("ALINERY_EVENT_TOKEN", "runner-exec-token")
        .env("ALINERY_REPO", root)
        .env("ALINERY_APP_CONFIG", root.join("app.toml"))
        .env("RUNNER_EXEC_ENV", "preserved")
        .args(["run", "--adapter", "omp", "--", fixture.to_str().unwrap()]);
    command
}

fn wait_for_exit(child: &mut Child, timeout: Duration) -> ExitStatus {
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        assert!(started.elapsed() < timeout, "runner child did not exit");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn run_exec_preserves_pid_cwd_environment_arguments_and_exit_code() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("home")).unwrap();
    let fixture = root.path().join("capture.sh");
    make_executable(
        &fixture,
        r#"#!/bin/sh
printf '%s' "$$" > pid
pwd > cwd
printf '%s' "$RUNNER_EXEC_ENV" > environment
printf '%s' "${ALINERY_REPO-unset}" > repo-environment
printf '%s' "${ALINERY_APP_CONFIG-unset}" > app-config-environment
printf '%s\n' "$@" > arguments
exit 23
"#,
    );

    let mut command = runner_command(root.path(), &fixture);
    command.args(["--model", "model-x", "prompt text"]);
    let mut child = command.spawn().unwrap();
    let runner_pid = child.id();
    let status = wait_for_exit(&mut child, Duration::from_secs(5));

    assert_eq!(status.code(), Some(23));
    assert_eq!(fs::read_to_string(root.path().join("pid")).unwrap(), runner_pid.to_string());
    assert_eq!(
        fs::read_to_string(root.path().join("cwd")).unwrap().trim(),
        root.path().canonicalize().unwrap().to_string_lossy()
    );
    assert_eq!(fs::read_to_string(root.path().join("environment")).unwrap(), "preserved");
    assert_eq!(fs::read_to_string(root.path().join("repo-environment")).unwrap(), "unset");
    assert_eq!(fs::read_to_string(root.path().join("app-config-environment")).unwrap(), "unset");
    let arguments = fs::read_to_string(root.path().join("arguments")).unwrap();
    let arguments: Vec<_> = arguments.lines().collect();
    assert_eq!(arguments[0], "--extension");
    let extension_package = Path::new(arguments[1]);
    assert!(extension_package.is_dir());
    assert!(extension_package.join("index.ts").is_file());
    let mcp_config: serde_json::Value = serde_json::from_slice(&fs::read(extension_package.join(".mcp.json")).unwrap()).unwrap();
    assert_eq!(mcp_config["mcpServers"]["alinery"]["command"], env!("CARGO_BIN_EXE_alinery-runner"));
    assert_eq!(
        mcp_config["mcpServers"]["alinery"]["args"],
        serde_json::json!(["mcp", "--repo", root.path(), "--app-config", root.path().join("app.toml"),])
    );
    assert_eq!(&arguments[2..], ["--model", "model-x", "prompt text"]);
    assert!(!root.path().join(".omp").exists());
    assert!(!root.path().join("home/.omp").exists());
}

#[test]
fn run_exec_remains_in_the_supervised_process_group() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("home")).unwrap();
    let fixture = root.path().join("wait.sh");
    make_executable(
        &fixture,
        r#"#!/bin/sh
trap 'printf term > terminated; exit 42' TERM
printf '%s' "$$" > pid
printf ready > ready
while :; do sleep 1; done
"#,
    );

    let mut command = runner_command(root.path(), &fixture);
    command.process_group(0);
    let mut child = command.spawn().unwrap();
    let runner_pid = child.id();
    let started = Instant::now();
    while !root.path().join("ready").exists() {
        assert!(started.elapsed() < Duration::from_secs(5), "fixture did not become ready");
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(fs::read_to_string(root.path().join("pid")).unwrap(), runner_pid.to_string());

    let result = unsafe { libc::killpg(runner_pid as i32, libc::SIGTERM) };
    assert_eq!(result, 0);
    let status = wait_for_exit(&mut child, Duration::from_secs(5));
    assert_eq!(status.code(), Some(42));
    assert_eq!(fs::read_to_string(root.path().join("terminated")).unwrap(), "term");
}

fn run_result_emit(socket: &Path) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_alinery-runner"))
        .env("ALINERY_SESSION_ID", "runner-result-test")
        .env("ALINERY_DAEMON_SOCKET", socket)
        .env("ALINERY_EVENT_PROTOCOL_VERSION", "1")
        .env("ALINERY_EVENT_TOKEN", "runner-result-token")
        .args(["emit", "--result"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(br#"{"type":"phase_completed","omp_session_id":"omp-session"}"#)
        .unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn emit_result_preserves_accepted_and_rejected_daemon_acknowledgements() {
    for (reply, expected_status, expected_code, expected_reason) in [
        (r#"{"ok":true}"#, "accepted", 0, None),
        (
            r#"{"error":"completion-rejected:MissingArtifact"}"#,
            "rejected",
            2,
            Some("completion-rejected:MissingArtifact"),
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let socket = root.path().join("daemon.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let reply = reply.to_string();
        let server = thread::spawn(move || {
            let (mut connection, _) = listener.accept().unwrap();
            let mut request = String::new();
            BufReader::new(&connection).read_line(&mut request).unwrap();
            let request: serde_json::Value = serde_json::from_str(&request).unwrap();
            assert_eq!(request["op"], "event");
            assert_eq!(request["event"]["type"], "phase_completed");
            writeln!(connection, "{reply}").unwrap();
        });

        let output = run_result_emit(&socket);
        server.join().unwrap();
        assert_eq!(output.status.code(), Some(expected_code));
        assert!(output.stderr.is_empty());
        let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["status"], expected_status);
        assert_eq!(result.get("reason").and_then(serde_json::Value::as_str), expected_reason);
    }
}

#[test]
fn emit_result_reports_bounded_delivery_failure_without_terminal_noise() {
    let root = tempfile::tempdir().unwrap();
    let missing_socket = root.path().join("missing.sock");
    let output = run_result_emit(&missing_socket);
    assert_eq!(output.status.code(), Some(3));
    assert!(output.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap(),
        serde_json::json!({"status": "delivery_failed"})
    );

    let slow_socket = root.path().join("slow.sock");
    let listener = UnixListener::bind(&slow_socket).unwrap();
    let server = thread::spawn(move || {
        let (_connection, _) = listener.accept().unwrap();
        thread::sleep(Duration::from_secs(2));
    });
    let started = Instant::now();
    let output = run_result_emit(&slow_socket);
    assert!(started.elapsed() < Duration::from_secs(1), "completion acknowledgement timeout was not bounded");
    assert_eq!(output.status.code(), Some(3));
    assert!(output.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap(),
        serde_json::json!({"status": "delivery_failed"})
    );
    server.join().unwrap();
}
