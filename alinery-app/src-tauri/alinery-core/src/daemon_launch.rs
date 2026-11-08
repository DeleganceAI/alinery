//! Launching the daemon: where its binary is, the build stamp the app compares, and the one recipe for starting it detached.
//! Moved here from the JSON-lines client when S5.3 retired that wire.

use crate::login_shell_path;
use std::fs;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

fn daemon_in(directory: &Path) -> Option<PathBuf> {
    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == "alinery-vinculum-daemon" || name.starts_with("alinery-vinculum-daemon-") {
                return Some(entry.path());
            }
        }
    }
    let development = directory.join("alinery-vinculum-daemon");
    development.exists().then_some(development)
}

pub fn resolve_alineryd_path() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let directory = executable.parent()?;
    if let Some(found) = daemon_in(directory) {
        return Some(found);
    }
    // `cargo test` runs from target/<profile>/deps. The built daemon sits next to that directory.
    if directory.file_name().and_then(|name| name.to_str()) == Some("deps") {
        return directory.parent().and_then(daemon_in);
    }
    None
}

pub fn file_content_id(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut hash = 0xcbf29ce484222325u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        for byte in &buffer[..count] {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    Some(format!("{hash:016x}"))
}

pub fn daemon_binary_build_id() -> String {
    // Vinculum is a large bun bundle. Attach, the poller, activity, and
    // observation all ask for this id; hashing the file on every call keeps
    // the blocking pool busy for the whole session. The bytes do not change
    // until this process is replaced.
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED
        .get_or_init(|| resolve_alineryd_path().and_then(|path| file_content_id(&path)).unwrap_or_default())
        .clone()
}

pub fn configure_detached_process(command: &mut Command) {
    unsafe {
        command.pre_exec(|| if libc::setsid() == -1 { Err(std::io::Error::last_os_error()) } else { Ok(()) });
    }
}

pub fn configure_host_guard_environment(command: &mut Command, host_executable: Option<&Path>) {
    command.env_remove("ALINERY_HOST_EXECUTABLE");
    if let Some(host_executable) = host_executable {
        command.env("ALINERY_HOST_EXECUTABLE", host_executable);
    }
}

/// The one recipe for launching the daemon, locally or (through the repo service) on a remote
/// host: arguments, login-shell PATH, the Grok key, detachment and null stdio. Callers add
/// anything host-specific (such as the ownership library) and spawn it.
///
/// `rpc_secret_file` is a file holding the bearer token for the daemon's RPC socket; the daemon
/// reads it and deletes it before it listens (`--rpc-secret-file`).
pub fn daemon_command(
    binary: &Path,
    repo: &Path,
    app_config: &Path,
    build_id: &std::ffi::OsStr,
    namespace: Option<&str>,
    host_executable: Option<&Path>,
    rpc_secret_file: Option<&Path>,
) -> Command {
    let mut command = Command::new(binary);
    command
        .arg("--repo")
        .arg(repo)
        .arg("--app-config")
        .arg(app_config)
        .arg("--build-id")
        .arg(build_id)
        // The version a telemetry event carries (plan S4.1). All three crates move together, so this is the app's.
        .arg("--app-version")
        .arg(env!("CARGO_PKG_VERSION"))
        .env("PATH", login_shell_path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_host_guard_environment(&mut command, host_executable);
    if let Some(namespace) = namespace.filter(|value| !value.is_empty()) {
        command.arg("--socket-namespace").arg(namespace);
    }
    if let Some(file) = rpc_secret_file {
        command.arg("--rpc-secret-file").arg(file);
    }
    let grok_key = crate::load_global_settings(app_config).experiments.grok_api_key;
    if !grok_key.trim().is_empty() {
        command.env("XAI_API_KEY", grok_key.trim());
    }
    configure_detached_process(&mut command);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daemon_command_passes_the_rpc_secret_file_after_the_lane_and_only_when_given() {
        let args = |secret: Option<&Path>| -> Vec<String> {
            daemon_command(Path::new("/d"), Path::new("/r"), Path::new("/c/app.toml"), "b".as_ref(), Some("ns"), None, secret)
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect()
        };
        assert_eq!(
            args(Some(Path::new("/t/rpc.secret"))),
            [
                "--repo",
                "/r",
                "--app-config",
                "/c/app.toml",
                "--build-id",
                "b",
                "--app-version",
                env!("CARGO_PKG_VERSION"),
                "--socket-namespace",
                "ns",
                "--rpc-secret-file",
                "/t/rpc.secret"
            ]
        );
        assert!(!args(None).iter().any(|arg| arg == "--rpc-secret-file"));
    }
}
