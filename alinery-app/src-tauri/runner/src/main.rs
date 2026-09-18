// alinery-runner: exec-only boundary between alineryd and OMP.
//
// Subcommands:
//   run --adapter omp -- <omp-executable> [args...]
//       Validates the protocol environment, materialises the embedded OMP extension
//       package and repository-scoped Alinery MCP config under an Alinery-owned
//       temporary directory, injects --extension <package> immediately after the executable
//       name, then replaces this process via exec(2).
//
//   emit
//       Reads one RunnerEvent JSON object from stdin, wraps it in a RunnerEventEnvelope
//       using the six fixed ALINERY_* launch environment variables, sends it as a single
//       newline-terminated JSON request to the owning Unix socket, and waits for the
//       bounded acknowledgement. Passive callbacks use silent fail-open mode;
//       `emit --result` returns a structured accepted/rejected/delivery-failed result
//       for the transactional phase-completion tool.
//
// Fixed environment variable names (shared with alineryd):
//   ALINERY_RUNNER_PATH              path to this binary (set by alineryd for OMP children)
//   ALINERY_SESSION_ID               Alinery session ID
//   ALINERY_DAEMON_SOCKET            Unix socket path
//   ALINERY_DAEMON_NAMESPACE         Alinery socket namespace
//   ALINERY_EVENT_PROTOCOL_VERSION   must match RUNNER_EVENT_PROTOCOL_VERSION
//   ALINERY_EVENT_TOKEN              per-session secret token

use alinery_core::{CompletionOutcome, HarnessAdapter, RunnerEvent, RunnerEventEnvelope, RUNNER_EVENT_PROTOCOL_VERSION};
use libc::execvp;
use serde_json::Value;
use std::ffi::CString;
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

// ---------- embedded OMP extension ----------

/// The embedded OMP extension TypeScript source.  Compiled into the binary at build
/// time via include_str! so the runner is entirely self-contained.
const OMP_EXTENSION_SRC: &str = include_str!("../assets/omp-extension.ts");

/// Version tag embedded with the source.  When the source changes this string must
/// change so the content-addressed path changes with it.
const OMP_EXTENSION_VERSION: &str = env!("CARGO_PKG_VERSION");

// ---------- protocol environment variable names (shared with alineryd) ----------

const ENV_SESSION_ID: &str = "ALINERY_SESSION_ID";
const ENV_DAEMON_SOCKET: &str = "ALINERY_DAEMON_SOCKET";
const ENV_DAEMON_NAMESPACE: &str = "ALINERY_DAEMON_NAMESPACE";
const ENV_PROTOCOL_VERSION: &str = "ALINERY_EVENT_PROTOCOL_VERSION";
const ENV_EVENT_TOKEN: &str = "ALINERY_EVENT_TOKEN";
const ENV_REPO: &str = "ALINERY_REPO";
const ENV_APP_CONFIG: &str = "ALINERY_APP_CONFIG";

// ---------- limits ----------

/// Maximum bytes accepted on stdin from the OMP extension callback.
const MAX_STDIN_BYTES: usize = 64 * 1024; // 64 KiB

/// Maximum bytes sent to the daemon per emit request.
const MAX_REQUEST_BYTES: usize = 128 * 1024; // 128 KiB

/// Maximum milliseconds to wait for a daemon acknowledgement.
const ACK_TIMEOUT_MS: u64 = 250;

/// Completion commits may include durable filesystem writes and output validation.
const COMPLETION_ACK_TIMEOUT_MS: u64 = 5_000;
const MAX_ACK_BYTES: usize = 64 * 1024;

// ---------- entry point ----------

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: alinery-runner <run|emit|mcp> [options...]");
        std::process::exit(1);
    }

    match args[1].as_str() {
        "run" => match cmd_run(&args[2..]) {
            Ok(()) => {} // unreachable after exec
            Err(e) => {
                eprintln!("alinery-runner: run failed: {e}");
                std::process::exit(1);
            }
        },
        "emit" => {
            let report_result = match &args[2..] {
                [] => false,
                [flag] if flag == "--result" => true,
                _ => std::process::exit(1),
            };
            let exit_code = cmd_emit(report_result);
            if exit_code != 0 {
                std::process::exit(exit_code);
            }
        }
        "mcp" => match cmd_mcp(&args[2..]) {
            Ok(()) => {} // unreachable after exec
            Err(e) => {
                eprintln!("alinery-runner: mcp failed: {e}");
                std::process::exit(1);
            }
        },
        other => {
            eprintln!("alinery-runner: unknown subcommand: {other}");
            std::process::exit(1);
        }
    }
}

// ---------- run ----------

fn cmd_run(args: &[String]) -> Result<(), String> {
    // Parse: --adapter <value> -- <executable> [child-args...]
    let (adapter_str, child_start) = parse_run_args(args)?;

    // Validate adapter; only "omp" is accepted.
    match parse_adapter(&adapter_str)? {
        HarnessAdapter::Omp => {}
        HarnessAdapter::Unsupported => {
            return Err(format!("adapter '{}' is not supported; only 'omp' is accepted", adapter_str));
        }
    }

    // Validate protocol version from environment before doing any FS work.
    validate_protocol_env()?;

    // Child argv starts immediately after the "--" separator.
    let child_args = &args[child_start..];
    if child_args.is_empty() {
        return Err("no child command after '--'".to_string());
    }
    let executable = &child_args[0];
    let rest = &child_args[1..];

    let (repo, app_config) = take_mcp_launch_context()?;
    let extension_package = materialise_extension(&repo, &app_config)?;

    let new_argv = build_exec_argv(executable, rest, &extension_package);

    // Replace this process.  This call does not return on success.
    exec_replace(executable, &new_argv)
}

fn build_exec_argv(executable: &str, args: &[String], extension_package: &Path) -> Vec<String> {
    let mut argv = Vec::with_capacity(args.len() + 3);
    argv.push(executable.to_string());
    argv.push("--extension".to_string());
    argv.push(extension_package.to_string_lossy().into_owned());
    argv.extend_from_slice(args);
    argv
}

fn cmd_mcp(args: &[String]) -> Result<(), String> {
    for name in [
        ENV_SESSION_ID,
        ENV_DAEMON_SOCKET,
        ENV_DAEMON_NAMESPACE,
        ENV_PROTOCOL_VERSION,
        ENV_EVENT_TOKEN,
        ENV_REPO,
        ENV_APP_CONFIG,
    ] {
        std::env::remove_var(name);
    }
    let executable = resolve_alinery_mcp_path()?;
    let executable = executable.to_string_lossy().into_owned();
    let mut argv = Vec::with_capacity(args.len() + 1);
    argv.push(executable.clone());
    argv.extend_from_slice(args);
    exec_replace(&executable, &argv)
}

fn resolve_alinery_mcp_path() -> Result<PathBuf, String> {
    let runner = std::env::current_exe().map_err(|e| format!("cannot resolve alinery-runner executable: {e}"))?;
    let dir = runner.parent().ok_or_else(|| format!("alinery-runner has no parent directory: {}", runner.display()))?;
    let exact = dir.join("alinery-mcp");
    if exact.is_file() {
        return Ok(exact);
    }
    let mut candidates = std::fs::read_dir(dir)
        .map_err(|e| format!("cannot inspect alinery-runner directory {}: {e}", dir.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("alinery-mcp-") && path.is_file())
        })
        .collect::<Vec<_>>();
    candidates.sort();
    candidates
        .into_iter()
        .next()
        .ok_or_else(|| format!("alinery-mcp binary not found next to {}", runner.display()))
}

/// Parse flags before `--`.  Returns (adapter_value, index_of_first_child_arg_in_args).
fn parse_run_args(args: &[String]) -> Result<(String, usize), String> {
    let mut i = 0;
    let mut adapter: Option<String> = None;

    while i < args.len() {
        match args[i].as_str() {
            "--" => {
                let a = adapter.ok_or("--adapter <value> is required before '--'")?;
                return Ok((a, i + 1));
            }
            "--adapter" => {
                i += 1;
                if i >= args.len() {
                    return Err("--adapter requires a value".to_string());
                }
                adapter = Some(args[i].clone());
            }
            other if other.starts_with("--adapter=") => {
                adapter = Some(other["--adapter=".len()..].to_string());
            }
            other => {
                return Err(format!("unknown option: {other}"));
            }
        }
        i += 1;
    }
    Err("missing '--' separator (use: alinery-runner run --adapter omp -- <command>)".to_string())
}

fn parse_adapter(s: &str) -> Result<HarnessAdapter, String> {
    match s {
        "omp" => Ok(HarnessAdapter::Omp),
        "unsupported" => Ok(HarnessAdapter::Unsupported),
        other => Err(format!("unknown adapter: '{other}'")),
    }
}

/// Validate that the inherited version matches the runner event protocol.
fn validate_protocol_env() -> Result<(), String> {
    let raw = std::env::var(ENV_PROTOCOL_VERSION).map_err(|_| format!("environment variable {ENV_PROTOCOL_VERSION} is not set"))?;
    let version: u16 = raw.trim().parse().map_err(|_| format!("{ENV_PROTOCOL_VERSION} is not a valid integer: '{raw}'"))?;
    if version != RUNNER_EVENT_PROTOCOL_VERSION {
        return Err(format!("{ENV_PROTOCOL_VERSION} is {version}, expected {}", RUNNER_EVENT_PROTOCOL_VERSION));
    }
    Ok(())
}

/// Materialise the embedded OMP extension and repository-scoped Alinery MCP config
/// as one content-addressed extension package.
///
/// OMP discovers sibling `.mcp.json` files only when `--extension` points to a
/// directory. The package identity includes the repository, app config, and
/// runner path so concurrent Alinery builds and repositories cannot reuse the wrong
/// MCP launch envelope.
pub fn materialise_extension(repo: &Path, app_config: &Path) -> Result<PathBuf, String> {
    let runner = std::env::current_exe().map_err(|e| format!("cannot resolve alinery-runner executable: {e}"))?;
    materialise_extension_in(
        &std::env::temp_dir().join("alinery-runner-exts"),
        OMP_EXTENSION_SRC,
        OMP_EXTENSION_VERSION,
        &runner,
        repo,
        app_config,
    )
}

fn take_mcp_launch_context() -> Result<(PathBuf, PathBuf), String> {
    let repo = std::env::var_os(ENV_REPO).map(PathBuf::from);
    let app_config = std::env::var_os(ENV_APP_CONFIG).map(PathBuf::from);
    std::env::remove_var(ENV_REPO);
    std::env::remove_var(ENV_APP_CONFIG);
    let repo = repo.ok_or_else(|| format!("environment variable {ENV_REPO} is not set"))?;
    let app_config = app_config.ok_or_else(|| format!("environment variable {ENV_APP_CONFIG} is not set"))?;
    Ok((repo, app_config))
}

fn materialise_extension_in(root: &Path, source: &str, version: &str, runner: &Path, repo: &Path, app_config: &Path) -> Result<PathBuf, String> {
    let mcp_config = serde_json::to_vec_pretty(&serde_json::json!({
        "mcpServers": {
            "alinery": {
                "command": runner,
                "args": [
                    "mcp",
                    "--repo",
                    repo,
                    "--app-config",
                    app_config,
                ],
            },
        },
    }))
    .map_err(|e| format!("cannot encode Alinery MCP config: {e}"))?;
    let mut identity = Vec::with_capacity(source.len() + mcp_config.len());
    identity.extend_from_slice(source.as_bytes());
    identity.extend_from_slice(&mcp_config);
    let digest = content_hash(&identity, version);
    let package = root.join(format!("alinery-omp-ext-{digest}"));

    std::fs::create_dir_all(root).map_err(|e| format!("cannot create extension temp dir {}: {e}", root.display()))?;
    let root_meta = std::fs::symlink_metadata(root).map_err(|e| format!("cannot inspect extension temp dir {}: {e}", root.display()))?;
    if !root_meta.file_type().is_dir() {
        return Err(format!("extension temp path is not a directory: {}", root.display()));
    }

    match std::fs::symlink_metadata(&package) {
        Ok(_) => {
            verify_materialised_package(&package, source.as_bytes(), &mcp_config)?;
            return Ok(package);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("cannot inspect extension package at {}: {error}", package.display())),
    }

    let staging = root.join(format!(".alinery-omp-ext-{digest}.{}.tmp", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&staging)
        .map_err(|e| format!("cannot create extension staging dir {}: {e}", staging.display()))?;
    if let Err(error) = write_materialised_file(&staging.join("index.ts"), source.as_bytes()).and_then(|_| write_materialised_file(&staging.join(".mcp.json"), &mcp_config)) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }

    if let Err(error) = std::fs::rename(&staging, &package) {
        let package_exists = std::fs::symlink_metadata(&package).is_ok();
        let _ = std::fs::remove_dir_all(&staging);
        if !package_exists {
            return Err(format!("extension materialisation failed at {}: {error}", package.display()));
        }
    }
    verify_materialised_package(&package, source.as_bytes(), &mcp_config)?;
    Ok(package)
}

fn write_materialised_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("cannot create extension package file {}: {e}", path.display()))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("cannot write extension package file {}: {e}", path.display()))
}

fn verify_materialised_package(package: &Path, source: &[u8], mcp_config: &[u8]) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(package).map_err(|e| format!("cannot inspect extension package at {}: {e}", package.display()))?;
    if !metadata.file_type().is_dir() {
        return Err(format!("extension package path is not a directory: {}", package.display()));
    }
    let mut names = std::fs::read_dir(package)
        .map_err(|e| format!("cannot read extension package {}: {e}", package.display()))?
        .map(|entry| entry.map(|value| value.file_name()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("cannot read extension package {}: {e}", package.display()))?;
    names.sort();
    let mut expected = vec![std::ffi::OsString::from(".mcp.json"), std::ffi::OsString::from("index.ts")];
    expected.sort();
    if names != expected {
        return Err(format!("extension package contains unexpected entries: {}", package.display()));
    }
    verify_materialised_file(&package.join("index.ts"), source)?;
    verify_materialised_file(&package.join(".mcp.json"), mcp_config)
}

fn verify_materialised_file(path: &Path, expected: &[u8]) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| format!("cannot inspect extension package file {}: {e}", path.display()))?;
    if !metadata.file_type().is_file() {
        return Err(format!("extension package entry is not a regular file: {}", path.display()));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("cannot read extension package file {}: {e}", path.display()))?;
    if bytes != expected {
        return Err(format!("extension package contents do not match: {}", path.display()));
    }
    Ok(())
}

/// Deterministic content hash: hex-encoded u64 djb2-mix of source bytes and version.
/// Sufficient for content-addressing within a single machine's temp directory.
pub fn content_hash(src: &[u8], version: &str) -> String {
    let mut h: u64 = 5381;
    for &b in version.as_bytes() {
        h = h.wrapping_mul(33).wrapping_add(b as u64);
    }
    for &b in src {
        h = h.wrapping_mul(33).wrapping_add(b as u64);
    }
    format!("{h:016x}")
}

/// Unix exec(2): replace this process with the child.
/// On success this function never returns.  On failure it returns Err.
fn exec_replace(executable: &str, argv: &[String]) -> Result<(), String> {
    let exe_c = CString::new(executable).map_err(|e| format!("executable contains nul byte: {e}"))?;

    let argv_c: Vec<CString> = argv
        .iter()
        .map(|s| CString::new(s.as_str()).map_err(|e| format!("argv contains nul byte: {e}")))
        .collect::<Result<_, _>>()?;

    let mut argv_ptrs: Vec<*const libc::c_char> = argv_c.iter().map(|s| s.as_ptr()).collect();
    argv_ptrs.push(std::ptr::null()); // null-terminate

    // Safety: exe_c and argv_ptrs are valid C strings and null-terminated.
    // execvp searches PATH if the executable has no slash.
    unsafe { execvp(exe_c.as_ptr(), argv_ptrs.as_ptr()) };

    // execvp only returns on error, with errno set. last_os_error() reads it
    // through whichever platform accessor is correct (macOS's __error(),
    // Linux's __errno_location(), ...) instead of us hardcoding one -- the
    // previous libc::__error() call only exists on macOS/BSD and failed to
    // link on Linux.
    Err(format!("execvp({executable:?}) failed: {}", std::io::Error::last_os_error()))
}

// ---------- emit ----------

/// The daemon's bounded acknowledgement to one normalized event.
#[derive(Debug, Clone, PartialEq, Eq)]
enum DaemonEventAck {
    Passive,
    Completion(CompletionOutcome),
    Rejected { reason: String },
}

/// Emit one event. Passive lifecycle callbacks preserve the original silent,
/// fail-open behavior. The phase-completion tool opts into a structured result.
fn cmd_emit(report_result: bool) -> i32 {
    let result = try_emit();
    if !report_result {
        return 0;
    }

    let (report, exit_code) = emit_report(result);
    let _ = writeln!(io::stdout(), "{report}");
    exit_code
}

fn emit_report(result: Result<DaemonEventAck, ()>) -> (Value, i32) {
    match result {
        Ok(DaemonEventAck::Completion(outcome)) => (serde_json::to_value(outcome).expect("completion outcome is serializable"), 0),
        Ok(DaemonEventAck::Passive) => (serde_json::json!({"status": "delivery_failed"}), 3),
        Ok(DaemonEventAck::Rejected { reason }) => (serde_json::json!({"status": "rejected", "reason": reason}), 2),
        Err(()) => (serde_json::json!({"status": "delivery_failed"}), 3),
    }
}

fn try_emit() -> Result<DaemonEventAck, ()> {
    // Missing launch state is a delivery failure. It stays terminal-silent unless
    // the transactional completion caller explicitly requests a result.
    let session_id = read_env(ENV_SESSION_ID)?;
    let socket_path = read_env(ENV_DAEMON_SOCKET)?;
    let token = read_env(ENV_EVENT_TOKEN)?;
    let version_str = read_env(ENV_PROTOCOL_VERSION)?;

    let version: u16 = version_str.trim().parse().map_err(|_| ())?;
    if version != RUNNER_EVENT_PROTOCOL_VERSION {
        return Err(());
    }

    let raw = read_stdin_bounded(MAX_STDIN_BYTES)?;
    let event: RunnerEvent = serde_json::from_slice(&raw).map_err(|_| ())?;
    validate_event(&event)?;
    let completion = matches!(&event, RunnerEvent::PhaseCompleted { .. });

    let envelope = RunnerEventEnvelope {
        version: RUNNER_EVENT_PROTOCOL_VERSION,
        session_id,
        token,
        event,
    };
    let request = build_event_request(&envelope).map_err(|_| ())?;
    if request.len() > MAX_REQUEST_BYTES {
        return Err(());
    }

    send_event_to_daemon(&socket_path, &request, completion)
}

fn read_env(name: &str) -> Result<String, ()> {
    std::env::var(name).map_err(|_| ())
}

/// Read at most `limit` bytes from stdin.  Returns Err if stdin is empty or exceeds the limit.
fn read_stdin_bounded(limit: usize) -> Result<Vec<u8>, ()> {
    let stdin = io::stdin();
    read_bounded(stdin.lock(), limit)
}

fn read_bounded(reader: impl Read, limit: usize) -> Result<Vec<u8>, ()> {
    let mut buf = Vec::with_capacity(512);
    // Take limit+1 so we can detect oversize input without unbounded allocation.
    reader.take((limit + 1) as u64).read_to_end(&mut buf).map_err(|_| ())?;
    if buf.is_empty() || buf.len() > limit {
        return Err(());
    }
    Ok(buf)
}

/// Validate that the event is a well-formed typed vocabulary member.
fn validate_event(event: &RunnerEvent) -> Result<(), ()> {
    match event {
        RunnerEvent::Busy { .. } | RunnerEvent::Idle { .. } | RunnerEvent::PhaseCompleted { .. } | RunnerEvent::AdapterError { .. } => Ok(()),
        RunnerEvent::WaitingForInput { correlation_id, .. } | RunnerEvent::WaitingForApproval { correlation_id, .. } => {
            if correlation_id.trim().is_empty() {
                Err(())
            } else {
                Ok(())
            }
        }
    }
}

/// Build a newline-terminated JSON request in the daemon's op:event format.
// `Result<_, ()>` is this module's convention for the whole daemon-event path
// (`send_event_to_daemon`, `emit_event`, and the `?` at the call site all use it): every
// failure here is "the request could not be built", with nothing further to report, and
// the runner's own exit codes carry the outcome. Swapping only this one function to
// Option would make it the odd one out; converting the whole path is a refactor, not a
// lint fix. Private fns with the same signature are not flagged — only this pub one is.
#[allow(clippy::result_unit_err)]
pub fn build_event_request(envelope: &RunnerEventEnvelope) -> Result<Vec<u8>, ()> {
    let mut map = serde_json::Map::new();
    map.insert("op".into(), Value::String("event".into()));

    let v = serde_json::to_value(envelope).map_err(|_| ())?;
    if let Value::Object(obj) = v {
        for (k, val) in obj {
            map.insert(k, val);
        }
    } else {
        return Err(());
    }

    let mut bytes = serde_json::to_vec(&Value::Object(map)).map_err(|_| ())?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Read one bounded, newline-terminated acknowledgement within an absolute deadline.
/// A passive acknowledgement is never sufficient proof of committed completion.
fn send_event_to_daemon(socket_path: &str, request: &[u8], completion: bool) -> Result<DaemonEventAck, ()> {
    let mut stream = UnixStream::connect(Path::new(socket_path)).map_err(|_| ())?;
    let timeout = Duration::from_millis(if completion { COMPLETION_ACK_TIMEOUT_MS } else { ACK_TIMEOUT_MS });
    let deadline = Instant::now() + timeout;
    stream.set_write_timeout(Some(timeout)).map_err(|_| ())?;
    stream.write_all(request).map_err(|_| ())?;

    let mut ack_buf = Vec::with_capacity(256);
    let mut chunk = [0u8; 4096];
    loop {
        let remaining = deadline.checked_duration_since(Instant::now()).ok_or(())?;
        stream.set_read_timeout(Some(remaining)).map_err(|_| ())?;
        let count = stream.read(&mut chunk).map_err(|_| ())?;
        if count == 0 {
            return Err(());
        }
        let newline = chunk[..count].iter().position(|byte| *byte == b'\n');
        let end = newline.map_or(count, |index| index + 1);
        if ack_buf.len() + end > MAX_ACK_BYTES {
            return Err(());
        }
        ack_buf.extend_from_slice(&chunk[..end]);
        if newline.is_some() {
            break;
        }
    }

    let ack: Value = serde_json::from_slice(&ack_buf).map_err(|_| ())?;
    if let Some(reason) = ack.get("error").and_then(Value::as_str) {
        if !reason.is_empty() && ack.get("ok").is_none() && ack.get("completion").is_none() {
            return Ok(DaemonEventAck::Rejected { reason: reason.to_string() });
        }
        return Err(());
    }
    if ack.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(());
    }
    match (completion, ack.get("completion")) {
        (true, Some(value)) => {
            let outcome: CompletionOutcome = serde_json::from_value(value.clone()).map_err(|_| ())?;
            if matches!(&outcome, CompletionOutcome::Accepted { receipt_id } if receipt_id.is_empty()) {
                return Err(());
            }
            Ok(DaemonEventAck::Completion(outcome))
        }
        (false, None) => Ok(DaemonEventAck::Passive),
        _ => Err(()),
    }
}

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixListener;
    use tempfile::TempDir;

    // ---- 2A: alinery-runner run ----

    #[test]
    fn exec_replace_reports_last_os_error_on_missing_binary() {
        // execvp fails for a nonexistent path; the error message must come
        // from std::io::Error::last_os_error() (portable across macOS/Linux),
        // not a hardcoded libc::__error() call that only links on macOS/BSD.
        let err = exec_replace("/definitely/does/not/exist-alinery-runner-test", &[]).unwrap_err();
        assert!(err.contains("execvp"), "unexpected error message: {err}");
    }

    #[test]
    fn run_requires_separator_and_child_command() {
        // No "--" at all.
        assert!(parse_run_args(&["--adapter".into(), "omp".into(), "/usr/bin/true".into()]).is_err());

        // "--" with no command is parseable (separator found); cmd_run checks empty child.
        let (_, idx) = parse_run_args(&["--adapter".into(), "omp".into(), "--".into()]).unwrap();
        assert_eq!(idx, 3); // index past "--"

        // Completely empty argv.
        assert!(parse_run_args(&[]).is_err());
    }

    #[test]
    fn run_accepts_only_omp_adapter() {
        // omp is the only accepted adapter.
        let a = parse_adapter("omp").unwrap();
        assert_eq!(a, HarnessAdapter::Omp);

        // unsupported parses but is rejected by cmd_run.
        let b = parse_adapter("unsupported").unwrap();
        assert_eq!(b, HarnessAdapter::Unsupported);

        // Unknown names are rejected immediately.
        assert!(parse_adapter("foobar").is_err());
        assert!(parse_adapter("").is_err());
        assert!(parse_adapter("codex").is_err());
    }

    #[test]
    fn run_rejects_protocol_mismatch() {
        // Save and restore env to avoid test pollution.
        let saved = std::env::var(ENV_PROTOCOL_VERSION).ok();

        // Missing env.
        std::env::remove_var(ENV_PROTOCOL_VERSION);
        assert!(validate_protocol_env().is_err(), "missing env should fail");

        // Version 0.
        std::env::set_var(ENV_PROTOCOL_VERSION, "0");
        assert!(validate_protocol_env().is_err(), "version 0 should fail");

        // A different version must not reuse this transport.
        std::env::set_var(ENV_PROTOCOL_VERSION, (RUNNER_EVENT_PROTOCOL_VERSION + 1).to_string());
        assert!(validate_protocol_env().is_err(), "different version should fail");

        // Malformed.
        std::env::set_var(ENV_PROTOCOL_VERSION, "not-a-number");
        assert!(validate_protocol_env().is_err(), "malformed should fail");

        // Correct version.
        std::env::set_var(ENV_PROTOCOL_VERSION, RUNNER_EVENT_PROTOCOL_VERSION.to_string());
        assert!(validate_protocol_env().is_ok(), "current version should succeed");

        // Restore.
        match saved {
            Some(v) => std::env::set_var(ENV_PROTOCOL_VERSION, v),
            None => std::env::remove_var(ENV_PROTOCOL_VERSION),
        }
    }

    #[test]
    fn run_inserts_one_extension_after_executable() {
        let rest = vec![
            "--model=claude".to_string(),
            "--prompt".to_string(),
            "do something".to_string(),
            "--resume=abc123".to_string(),
        ];
        let extension_package = PathBuf::from("/tmp/alinery-runner-exts/alinery-omp-ext-abc");
        let argv = build_exec_argv("/usr/bin/omp", &rest, &extension_package);

        assert_eq!(argv[0], "/usr/bin/omp");
        assert_eq!(argv[1], "--extension");
        assert_eq!(argv[2], extension_package.to_string_lossy());
        assert_eq!(&argv[3..], rest.as_slice());
        assert_eq!(argv.iter().filter(|arg| *arg == "--extension").count(), 1);
    }

    #[test]
    fn extension_materialization_is_deterministic_repo_scoped_and_fails_closed() {
        let dir = TempDir::new().unwrap();
        let runner = Path::new("/opt/alinery/alinery-runner");
        let repo = Path::new("/repo");
        let app_config = Path::new("/config/app.toml");
        let first = materialise_extension_in(dir.path(), "first", "1", runner, repo, app_config).unwrap();
        let repeated = materialise_extension_in(dir.path(), "first", "1", runner, repo, app_config).unwrap();
        let changed_source = materialise_extension_in(dir.path(), "second", "1", runner, repo, app_config).unwrap();
        let changed_version = materialise_extension_in(dir.path(), "first", "2", runner, repo, app_config).unwrap();
        let changed_repo = materialise_extension_in(dir.path(), "first", "1", runner, Path::new("/other"), app_config).unwrap();

        assert_eq!(first, repeated);
        assert_eq!(std::fs::read_to_string(first.join("index.ts")).unwrap(), "first");
        let config: Value = serde_json::from_slice(&std::fs::read(first.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(config["mcpServers"]["alinery"]["command"], "/opt/alinery/alinery-runner");
        assert_eq!(
            config["mcpServers"]["alinery"]["args"],
            serde_json::json!(["mcp", "--repo", "/repo", "--app-config", "/config/app.toml"])
        );
        assert_ne!(repeated, changed_source);
        assert_ne!(repeated, changed_version);
        assert_ne!(repeated, changed_repo);
        assert!(changed_source.starts_with(dir.path()));

        let tampered = materialise_extension_in(dir.path(), "tampered", "1", runner, repo, app_config).unwrap();
        std::fs::write(tampered.join("index.ts"), "different bytes").unwrap();
        let tamper_error = materialise_extension_in(dir.path(), "tampered", "1", runner, repo, app_config).unwrap_err();
        assert!(tamper_error.contains("do not match"));

        let symlinked = materialise_extension_in(dir.path(), "symlinked", "1", runner, repo, app_config).unwrap();
        std::fs::remove_file(symlinked.join("index.ts")).unwrap();
        let symlink_target = dir.path().join("symlink-target.ts");
        std::fs::write(&symlink_target, "symlinked").unwrap();
        std::os::unix::fs::symlink(&symlink_target, symlinked.join("index.ts")).unwrap();
        let symlink_error = materialise_extension_in(dir.path(), "symlinked", "1", runner, repo, app_config).unwrap_err();
        assert!(symlink_error.contains("not a regular file"));

        let unexpected = materialise_extension_in(dir.path(), "unexpected", "1", runner, repo, app_config).unwrap();
        std::fs::write(unexpected.join("extra.ts"), "extra").unwrap();
        let unexpected_error = materialise_extension_in(dir.path(), "unexpected", "1", runner, repo, app_config).unwrap_err();
        assert!(unexpected_error.contains("unexpected entries"));

        let blocked = dir.path().join("not-a-directory");
        std::fs::write(&blocked, "file").unwrap();
        assert!(materialise_extension_in(&blocked, "source", "1", runner, repo, app_config).is_err());
    }

    // ---- 2B: alinery-runner emit ----

    #[test]
    fn emit_rejects_invalid_input_matrix() {
        // Empty bytes → serde error.
        assert!(serde_json::from_slice::<RunnerEvent>(b"").is_err());

        // Malformed JSON.
        assert!(serde_json::from_slice::<RunnerEvent>(b"{ bad json").is_err());

        // Unknown event tag (process_exited is not in the vocabulary).
        assert!(serde_json::from_slice::<RunnerEvent>(br#"{"type":"process_exited"}"#).is_err());

        // WaitingForInput with empty correlation_id → serde error via custom deserialiser.
        assert!(serde_json::from_slice::<RunnerEvent>(br#"{"type":"waiting_for_input","correlation_id":""}"#).is_err());

        // WaitingForApproval with empty correlation_id → serde error.
        assert!(serde_json::from_slice::<RunnerEvent>(br#"{"type":"waiting_for_approval","correlation_id":""}"#).is_err());
        // A second JSON value and unrelated daemon-routing fields are rejected.
        assert!(serde_json::from_slice::<RunnerEvent>(br#"{"type":"idle"}{"type":"busy"}"#).is_err());
        assert!(serde_json::from_slice::<RunnerEvent>(br#"{"type":"idle","op":"shutdown"}"#).is_err());

        // The actual bounded reader rejects empty and oversized input without
        // allocating beyond limit+1, while accepting the exact boundary.
        assert!(read_bounded(io::Cursor::new(Vec::<u8>::new()), 4).is_err());
        assert_eq!(read_bounded(io::Cursor::new(b"1234"), 4).unwrap(), b"1234");
        assert!(read_bounded(io::Cursor::new(b"12345"), 4).is_err());
    }

    #[test]
    fn emit_builds_one_authenticated_event_request() {
        let event = RunnerEvent::Idle { omp_turn_id: Some(42) };
        let envelope = RunnerEventEnvelope {
            version: RUNNER_EVENT_PROTOCOL_VERSION,
            session_id: "sess-abc".into(),
            token: "tok-xyz".into(),
            event,
        };
        let req = build_event_request(&envelope).unwrap();

        // Must end with a newline for the daemon's line-oriented reader.
        assert_eq!(*req.last().unwrap(), b'\n');

        let val: Value = serde_json::from_slice(&req).unwrap();
        assert_eq!(val["op"], "event");
        assert_eq!(val["version"], RUNNER_EVENT_PROTOCOL_VERSION);
        assert_eq!(val["session_id"], "sess-abc");
        assert_eq!(val["token"], "tok-xyz");
        assert_eq!(val["event"]["type"], "idle");
        assert_eq!(val["event"]["omp_turn_id"], 42);
    }

    #[test]
    fn emit_cannot_address_general_daemon_operations() {
        // The request envelope only carries version, session_id, token, and event.
        // It is impossible to inject op:write, op:kill, etc.
        let event = RunnerEvent::Busy {
            omp_turn_id: None,
            correlation_id: None,
        };
        let envelope = RunnerEventEnvelope {
            version: RUNNER_EVENT_PROTOCOL_VERSION,
            session_id: "s".into(),
            token: "t".into(),
            event,
        };
        let req = build_event_request(&envelope).unwrap();
        let val: Value = serde_json::from_slice(&req).unwrap();

        // op is always "event".
        assert_eq!(val["op"], "event");

        // No forbidden operation names in the serialised bytes.
        let s = std::str::from_utf8(&req).unwrap();
        for forbidden in &["\"write\"", "\"kill\"", "\"shutdown\"", "\"spawn\"", "\"attach\""] {
            assert!(!s.contains(forbidden), "request must not contain {forbidden}");
        }
    }

    #[test]
    fn emit_waits_for_one_bounded_ack() {
        let dir = TempDir::new().unwrap();
        let socket_path = dir.path().join("ack.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let socket_str = socket_path.to_string_lossy().into_owned();

        let server = std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(&conn);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            conn.write_all(b"{\"ok\":true}\n").unwrap();
        });

        let event = RunnerEvent::Idle { omp_turn_id: None };
        let envelope = RunnerEventEnvelope {
            version: RUNNER_EVENT_PROTOCOL_VERSION,
            session_id: "alinery-s1".into(),
            token: "tok".into(),
            event,
        };
        let req = build_event_request(&envelope).unwrap();
        let result = send_event_to_daemon(&socket_str, &req, false);

        server.join().unwrap();
        assert_eq!(result, Ok(DaemonEventAck::Passive));
    }

    #[test]
    fn emit_preserves_daemon_rejection_reason() {
        let dir = TempDir::new().unwrap();
        let socket_path = dir.path().join("reject.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let socket_str = socket_path.to_string_lossy().into_owned();

        let server = std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(&conn);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            conn.write_all(b"{\"error\":\"execution owner is stale\"}\n").unwrap();
        });

        let result = send_event_to_daemon(&socket_str, b"{}\n", true);
        server.join().unwrap();
        assert_eq!(
            result,
            Ok(DaemonEventAck::Rejected {
                reason: "execution owner is stale".into(),
            })
        );
    }

    #[test]
    fn emit_result_reports_accepted_rejected_and_delivery_failed() {
        assert_eq!(
            emit_report(Ok(DaemonEventAck::Completion(CompletionOutcome::Accepted { receipt_id: "receipt-1".into() }))),
            (serde_json::json!({"status": "accepted", "receipt_id": "receipt-1"}), 0)
        );
        assert_eq!(
            emit_report(Ok(DaemonEventAck::Rejected {
                reason: "completion-rejected:StaleSource".into(),
            })),
            (
                serde_json::json!({
                    "status": "rejected",
                    "reason": "completion-rejected:StaleSource"
                }),
                2
            )
        );
        assert_eq!(emit_report(Err(())), (serde_json::json!({"status": "delivery_failed"}), 3));
    }

    #[test]
    fn emit_timeout_is_bounded_and_terminal_silent() {
        // Listener accepts but never acknowledges → must time out within budget.
        let dir = TempDir::new().unwrap();
        let socket_path = dir.path().join("slow.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let socket_str = socket_path.to_string_lossy().into_owned();

        let _server = std::thread::spawn(move || {
            let (_conn, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_secs(10));
        });

        let event = RunnerEvent::Idle { omp_turn_id: None };
        let envelope = RunnerEventEnvelope {
            version: RUNNER_EVENT_PROTOCOL_VERSION,
            session_id: "s".into(),
            token: "t".into(),
            event,
        };
        let req = build_event_request(&envelope).unwrap();

        let start = std::time::Instant::now();
        let result = send_event_to_daemon(&socket_str, &req, false);
        let elapsed = start.elapsed();

        assert!(result.is_err(), "must fail when no ack");
        // Complete within 2× the configured budget (generous scheduling slack).
        assert!(
            elapsed.as_millis() < (ACK_TIMEOUT_MS as u128 * 2),
            "timeout {elapsed:?} exceeded 2× budget ({ACK_TIMEOUT_MS}ms)"
        );
    }

    #[test]
    fn emit_silent_on_missing_socket() {
        let result = send_event_to_daemon("/nonexistent/path/alinery.sock", b"{}\n", false);
        assert!(result.is_err());
    }

    #[test]
    fn content_hash_is_hex_16_chars() {
        let h = content_hash(b"hello", "1.0.0");
        assert_eq!(h.len(), 16, "hash must be 16 hex chars");
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn validate_event_accepts_all_vocabulary_members() {
        assert!(validate_event(&RunnerEvent::Busy {
            omp_turn_id: None,
            correlation_id: None
        })
        .is_ok());
        assert!(validate_event(&RunnerEvent::Idle { omp_turn_id: Some(1) }).is_ok());
        assert!(validate_event(&RunnerEvent::WaitingForInput {
            correlation_id: "corr-id".into(),
            omp_turn_id: None,
        })
        .is_ok());
        assert!(validate_event(&RunnerEvent::WaitingForApproval {
            correlation_id: "corr-id".into(),
            omp_turn_id: None,
        })
        .is_ok());
        assert!(validate_event(&RunnerEvent::PhaseCompleted {
            omp_session_id: "sess".into(),
            omp_turn_id: None,
        })
        .is_ok());
        assert!(validate_event(&RunnerEvent::AdapterError { detail: "oops".into() }).is_ok());
    }
}
