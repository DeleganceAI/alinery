//! Remote (SSH) repos: parsing the destination, probing the host, choosing and installing the
//! bundled runtime, and keeping one OpenSSH master per host.
//!
//! This is the only module that spawns `ssh` (enforced by `scripts/tests/check-ssh-spawn.sh`).
//! It shells out to the system OpenSSH on purpose: ControlMaster, unix-socket forwarding,
//! agents, ProxyJump and the user's `~/.ssh/config` all come for free.
//!
//! The first half is pure (parsing, quoting, paths, probe, selection) so it is unit tested
//! without a network; the second half drives ssh.

use crate::*;
use std::collections::BTreeMap;

// ── destination ────────────────────────────────────────────────────────────────────────

/// Split a command line into words, honouring single quotes, double quotes and backslashes.
fn split_words(input: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut chars = input.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '\'' => {
                started = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(inner) => current.push(inner),
                        None => return Err("unterminated single quote".into()),
                    }
                }
            }
            '"' => {
                started = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(escaped) => current.push(escaped),
                            None => return Err("unterminated double quote".into()),
                        },
                        Some(inner) => current.push(inner),
                        None => return Err("unterminated double quote".into()),
                    }
                }
            }
            '\\' => {
                started = true;
                current.push(chars.next().ok_or("trailing backslash")?);
            }
            c if c.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            c => {
                started = true;
                current.push(c);
            }
        }
    }
    if started {
        words.push(current);
    }
    Ok(words)
}

/// `-o` keys a destination may carry. Anything that can run a command or open a forward
/// (ProxyCommand, LocalCommand, LocalForward, PermitLocalCommand…) is refused: the destination
/// is stored and replayed on every connect.
const ALLOWED_O_KEYS: [&str; 7] = ["port", "user", "identityfile", "identitiesonly", "proxyjump", "hostkeyalias", "connecttimeout"];

fn plain_value(value: &str, what: &str, extra: &str) -> Result<(), String> {
    let ok = !value.is_empty() && !value.starts_with('-') && value.chars().all(|c| c.is_ascii_alphanumeric() || "._@%:[]-".contains(c) || extra.contains(c));
    ok.then_some(()).ok_or_else(|| format!("invalid {what}: {value}"))
}

fn path_value(value: &str, what: &str) -> Result<(), String> {
    let ok = !value.is_empty() && !value.starts_with('-') && !value.chars().any(|c| c.is_control());
    ok.then_some(()).ok_or_else(|| format!("invalid {what}: {value}"))
}

fn port_value(value: &str) -> Result<(), String> {
    value
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .map(|_| ())
        .ok_or_else(|| format!("invalid port: {value}"))
}

fn validate_o(option: &str) -> Result<(), String> {
    let (key, value) = option.split_once('=').ok_or_else(|| format!("expected -o Key=Value, got {option}"))?;
    if !ALLOWED_O_KEYS.contains(&key.to_ascii_lowercase().as_str()) {
        return Err(format!("ssh option {key} is not allowed"));
    }
    match key.to_ascii_lowercase().as_str() {
        "port" => port_value(value),
        "identityfile" => path_value(value, "identity file"),
        "identitiesonly" => matches!(value, "yes" | "no").then_some(()).ok_or_else(|| format!("invalid IdentitiesOnly: {value}")),
        "connecttimeout" => value.parse::<u32>().map(|_| ()).map_err(|_| format!("invalid ConnectTimeout: {value}")),
        _ => plain_value(value, key, ",:"),
    }
}

/// Turn what the user typed (`ssh -p 2222 me@box`, `devbox`, `-i ~/.ssh/k me@box`) into the
/// stored ssh arguments: allowlisted flags, then the host as the final element.
pub(crate) fn parse_destination(input: &str) -> Result<Vec<String>, String> {
    let mut words = split_words(input.trim())?.into_iter().peekable();
    if words.peek().map(String::as_str) == Some("ssh") {
        words.next();
    }
    let mut args = Vec::new();
    let mut host: Option<String> = None;
    while let Some(word) = words.next() {
        if !word.starts_with('-') {
            if host.replace(word).is_some() {
                return Err("expected a single host; a remote command is not allowed".into());
            }
            continue;
        }
        if host.is_some() {
            return Err("options must come before the host".into());
        }
        if matches!(word.as_str(), "-4" | "-6") {
            args.push(word);
            continue;
        }
        let (flag, attached) = word.split_at(2.min(word.len()));
        if !matches!(flag, "-p" | "-l" | "-i" | "-J" | "-F" | "-o") {
            return Err(format!("ssh option {word} is not allowed"));
        }
        let value = if attached.is_empty() {
            words.next().ok_or_else(|| format!("{flag} needs a value"))?
        } else {
            attached.to_string()
        };
        match flag {
            "-p" => port_value(&value)?,
            "-l" => plain_value(&value, "user", "")?,
            "-i" => path_value(&value, "identity file")?,
            "-F" => path_value(&value, "config file")?,
            "-J" => plain_value(&value, "jump host", ",")?,
            _ => {
                let normalized = value.replacen(' ', "=", 1);
                validate_o(&normalized)?;
                args.push(flag.to_string());
                args.push(normalized);
                continue;
            }
        }
        args.push(flag.to_string());
        args.push(value);
    }
    let host = host.ok_or("enter an ssh destination, for example me@host or an alias from ~/.ssh/config")?;
    plain_value(&host, "host", "")?;
    // `me@-oFoo` would reach ssh as a host that starts with a dash.
    if host.rsplit('@').next().is_some_and(|name| name.starts_with('-') || name.is_empty()) {
        return Err(format!("invalid host: {host}"));
    }
    args.push(host);
    Ok(args)
}

/// Stable id for a destination: a readable slug of the host plus a hash of the full argument
/// list, so the same host reached with a different port or key is a different remote.
pub(crate) fn host_id(ssh_args: &[String]) -> String {
    let host = ssh_args.last().map(String::as_str).unwrap_or_default();
    let name = host.rsplit('@').next().unwrap_or(host);
    let slug: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "host" } else { &slug[..slug.len().min(24)] };
    format!("{slug}-{}", &crate::daemon::fnv1a64_hex(&ssh_args.join("\0"))[..6])
}

// ── local socket paths ─────────────────────────────────────────────────────────────────

/// ssh appends `.` and 16 random characters to the control path while the master binds, and
/// macOS `sun_path` holds 104 bytes, so the finished control path must stay well under that.
const MAX_CONTROL_PATH_BYTES: usize = 80;

/// A short, per-user, mode-0700 directory. `/tmp` rather than `$TMPDIR`: macOS `$TMPDIR` is
/// already ~49 bytes and gets swept after days of disuse.
pub(crate) fn control_dir(uid: u32) -> PathBuf {
    PathBuf::from(format!("/tmp/alinery-{uid}"))
}

pub(crate) fn control_socket(dir: &Path, host_id: &str) -> Result<PathBuf, String> {
    let path = dir.join(format!("h-{}.ctl", &crate::daemon::fnv1a64_hex(host_id)[..12]));
    short_enough(path)
}

pub(crate) fn forward_socket(dir: &Path, host_id: &str, remote_socket: &str) -> Result<PathBuf, String> {
    let path = dir.join(format!("f-{}.sock", &crate::daemon::fnv1a64_hex(&format!("{host_id}\0{remote_socket}"))[..16]));
    short_enough(path)
}

fn short_enough(path: PathBuf) -> Result<PathBuf, String> {
    (path.as_os_str().len() <= MAX_CONTROL_PATH_BYTES)
        .then_some(path.clone())
        .ok_or_else(|| format!("socket path is too long for a unix socket: {}", path.display()))
}

// ── probe ──────────────────────────────────────────────────────────────────────────────

pub(crate) const PROBE_SENTINEL: &str = "__ALINERY_PROBE__";

/// Run on the remote with `sh -s`. Everything after the sentinel is `key=value`; anything
/// before it is shell rc noise.
pub(crate) const PROBE_SCRIPT: &str = r#"
echo __ALINERY_PROBE__
echo "uname=$(uname -sm)"
echo "home=$HOME"
echo "glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null)"
echo "pagesize=$(getconf PAGESIZE 2>/dev/null)"
for tool in tar gzip sha256sum git setsid systemd-run; do
  if command -v "$tool" >/dev/null 2>&1; then echo "has_$tool=1"; else echo "has_$tool=0"; fi
done
echo "linger=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)"
echo "killuser=$(busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillUserProcesses 2>/dev/null)"
"#;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Probe {
    pub(crate) os: String,
    pub(crate) arch: String,
    pub(crate) home: String,
    pub(crate) glibc: Option<String>,
    pub(crate) pagesize: Option<u64>,
    pub(crate) tools: BTreeMap<String, bool>,
    pub(crate) linger: Option<bool>,
    pub(crate) kill_user_processes: Option<bool>,
}

pub(crate) fn parse_probe(output: &str) -> Result<Probe, String> {
    let body = output
        .split_once(PROBE_SENTINEL)
        .map(|(_, rest)| rest)
        .ok_or("the host did not answer the probe (is a login shell printing instead of running sh?)")?;
    let mut probe = Probe::default();
    for line in body.lines() {
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        match key {
            "uname" => {
                let (os, arch) = value.split_once(' ').unwrap_or((value, ""));
                probe.os = os.to_string();
                probe.arch = arch.to_string();
            }
            "home" => probe.home = value.to_string(),
            "glibc" => probe.glibc = value.strip_prefix("glibc ").map(str::to_string),
            "pagesize" => probe.pagesize = value.parse().ok(),
            "linger" => {
                probe.linger = match value {
                    "yes" => Some(true),
                    "no" => Some(false),
                    _ => None,
                }
            }
            // busctl prints `b true` / `b false`.
            "killuser" => {
                probe.kill_user_processes = match value {
                    "b true" => Some(true),
                    "b false" => Some(false),
                    _ => None,
                }
            }
            _ => {
                if let Some(tool) = key.strip_prefix("has_") {
                    probe.tools.insert(tool.to_string(), value == "1");
                }
            }
        }
    }
    if probe.os.is_empty() || !probe.home.starts_with('/') {
        return Err("the host's probe reply was incomplete".into());
    }
    Ok(probe)
}

// ── runtime selection ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub(crate) struct ManifestTarget {
    pub(crate) archive: String,
    pub(crate) sha256: String,
    pub(crate) runtime_hash: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub(crate) struct RuntimeManifest {
    #[serde(default)]
    pub(crate) glibc_floor: String,
    #[serde(default)]
    pub(crate) targets: BTreeMap<String, ManifestTarget>,
}

fn version_parts(version: &str) -> Vec<u64> {
    version.split('.').map(|part| part.parse().unwrap_or(0)).collect()
}

/// Pick the bundled runtime for a probed host, or say plainly why none fits.
pub(crate) fn select_target<'a>(probe: &Probe, manifest: &'a RuntimeManifest) -> Result<(&'a str, &'a ManifestTarget), String> {
    if probe.os != "Linux" {
        return Err(format!("{} hosts are not supported yet; remote repositories need Linux", probe.os));
    }
    let triple = match probe.arch.as_str() {
        "x86_64" => "x86_64-unknown-linux-gnu",
        "aarch64" | "arm64" => "aarch64-unknown-linux-gnu",
        other => return Err(format!("unsupported CPU architecture: {other}")),
    };
    let glibc = probe.glibc.as_deref().ok_or("the host has no glibc (musl and Alpine are not supported)")?;
    if version_parts(glibc) < version_parts(&manifest.glibc_floor) {
        return Err(format!("the host's glibc {glibc} is older than the required {}", manifest.glibc_floor));
    }
    if triple.starts_with("aarch64") && probe.pagesize == Some(65536) {
        return Err("arm64 hosts with 64 KiB pages are not supported".into());
    }
    let missing: Vec<&str> = ["tar", "gzip", "sha256sum", "git"]
        .into_iter()
        .filter(|tool| !probe.tools.get(*tool).copied().unwrap_or(false))
        .collect();
    if !missing.is_empty() {
        return Err(format!("the host is missing {}", missing.join(", ")));
    }
    manifest
        .targets
        .get_key_value(triple)
        .map(|(triple, target)| (triple.as_str(), target))
        .ok_or_else(|| format!("this build of Alinery does not bundle a runtime for {triple}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Launcher {
    /// A transient user unit, which survives logout when lingering is on.
    SystemdRun,
    Setsid,
    Nohup,
}

/// How to start the daemon so it outlives the ssh session. A user systemd manager stops at
/// the last logout unless lingering is on, so `systemd-run --user` is only chosen then; a
/// plain setsid process survives unless logind kills the session's processes.
pub(crate) fn choose_launcher(probe: &Probe) -> Result<Launcher, String> {
    let has = |tool: &str| probe.tools.get(tool).copied().unwrap_or(false);
    if has("systemd-run") && probe.linger == Some(true) {
        return Ok(Launcher::SystemdRun);
    }
    if probe.kill_user_processes == Some(true) {
        return Err("this host stops your processes when you log out; run `loginctl enable-linger` on it so sessions can keep running".into());
    }
    Ok(if has("setsid") { Launcher::Setsid } else { Launcher::Nohup })
}

// ── remote layout and config ───────────────────────────────────────────────────────────

pub(crate) fn remote_root(home: &str) -> String {
    format!("{}/.local/share/alinery-remote", home.trim_end_matches('/'))
}

/// A directory named by content hash is never overwritten, so a running daemon's binary is
/// never replaced and several app versions can coexist on one host.
pub(crate) fn runtime_dir(root: &str, runtime_hash: &str) -> String {
    format!("{root}/runtime/{runtime_hash}")
}

pub(crate) fn remote_config_dir(root: &str, local_identity: &str) -> String {
    format!("{root}/config/{local_identity}")
}

/// The `app.toml` the remote daemon and repo service read: the local settings, minus the
/// remote host list, with only this host's repositories (the remote alinery-mcp allowlists
/// repos from it).
pub(crate) fn render_remote_app_toml(local: &AppConfig, remote_repo_paths: &[String]) -> Result<String, String> {
    let mut config = local.clone();
    config.remote_hosts.clear();
    config.active_repo = String::new();
    config.known_repos = remote_repo_paths.to_vec();
    toml::to_string(&config).map_err(|error| format!("render remote app.toml: {error}"))
}

// ── ssh driving ────────────────────────────────────────────────────────────────────────

use alinery_core::repo_service::{Hello, Launch, RepoOp, RepoReply, RepoRequest, HELLO_ID};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, ExitStatus, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SshFailure {
    /// First contact with this host. Only a user's explicit trust may retry past it.
    UnknownHostKey,
    Other(String),
}

pub(crate) const HOST_KEY_UNKNOWN: &str = "host-key-unknown";

impl std::fmt::Display for SshFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // The frontend matches this prefix to offer the trust prompt.
            Self::UnknownHostKey => write!(f, "{HOST_KEY_UNKNOWN}: this host's key is not in known_hosts yet"),
            Self::Other(message) => f.write_str(message),
        }
    }
}

/// Turn ssh's stderr (or the master's `-E` log) into something a person can act on.
pub(crate) fn classify_ssh_failure(text: &str) -> SshFailure {
    let text = text.trim();
    if text.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") || text.contains("Offending") {
        return SshFailure::Other("the host's key changed since you last connected; check ~/.ssh/known_hosts before continuing".into());
    }
    if text.contains("Host key verification failed") {
        return SshFailure::UnknownHostKey;
    }
    if text.contains("Permission denied") {
        return SshFailure::Other("ssh authentication failed. Alinery connects without prompts, so load your key into ssh-agent or add -i <key> to the destination".into());
    }
    if text.contains("Could not resolve hostname") {
        return SshFailure::Other("could not resolve the host name".into());
    }
    let last = text.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("ssh failed");
    SshFailure::Other(last.trim().to_string())
}

pub(crate) enum RemoteStdin {
    None,
    File(std::fs::File),
}

fn wait_with_timeout(child: &mut Child, timeout: Duration) -> Result<ExitStatus, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("ssh timed out".to_string());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => return Err(format!("wait for ssh: {error}")),
        }
    }
}

fn run_command(mut command: Command, stdin: RemoteStdin, timeout: Duration) -> Result<Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command.stdin(match &stdin {
        RemoteStdin::None => Stdio::null(),
        RemoteStdin::File(file) => Stdio::from(file.try_clone().map_err(|error| error.to_string())?),
    });
    let mut child = command.spawn().map_err(|error| format!("start ssh: {error}"))?;
    let drain = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = pipe.read_to_end(&mut buffer);
            buffer
        })
    };
    let stdout = drain(Box::new(child.stdout.take().ok_or("ssh stdout")?));
    let stderr = drain(Box::new(child.stderr.take().ok_or("ssh stderr")?));
    let status = wait_with_timeout(&mut child, timeout)?;
    Ok(Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

/// One OpenSSH master per host, reused by every exec, forward and the service channel.
#[derive(Debug, Clone)]
pub(crate) struct HostConn {
    pub(crate) host_id: String,
    flags: Vec<String>,
    host: String,
    control: PathBuf,
    log: PathBuf,
}

/// Create the per-user control directory and refuse one that someone else could have made.
fn ensure_control_dir() -> Result<PathBuf, String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    let uid = alinery_core::effective_uid();
    let dir = control_dir(uid);
    match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("create {}: {error}", dir.display())),
    }
    let meta = std::fs::symlink_metadata(&dir).map_err(|error| format!("inspect {}: {error}", dir.display()))?;
    if !meta.is_dir() || meta.uid() != uid || meta.permissions().mode() & 0o077 != 0 {
        return Err(format!("{} is not a private directory owned by you", dir.display()));
    }
    Ok(dir)
}

impl HostConn {
    pub(crate) fn new(host_id: &str, ssh_args: &[String]) -> Result<Self, String> {
        let (host, flags) = ssh_args.split_last().ok_or("empty ssh destination")?;
        let control = control_socket(&ensure_control_dir()?, host_id)?;
        Ok(Self {
            host_id: host_id.to_string(),
            flags: flags.to_vec(),
            host: host.clone(),
            log: control.with_extension("log"),
            control,
        })
    }

    /// `ssh <your flags> -S <control> -o BatchMode=yes`, ready for a destination and command.
    fn base(&self) -> Command {
        let mut command = Command::new("ssh");
        command.args(&self.flags).arg("-S").arg(&self.control).args(["-o", "BatchMode=yes"]);
        command
    }

    fn master_alive(&self) -> bool {
        self.base()
            .args(["-O", "check"])
            .arg(&self.host)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    /// Start the master unless one (possibly left by a previous app run) already answers.
    /// `trust` accepts a first-seen host key; a changed key is never accepted.
    pub(crate) fn ensure_master(&self, trust: bool) -> Result<(), SshFailure> {
        if self.master_alive() {
            return Ok(());
        }
        let _ = std::fs::remove_file(&self.control);
        let _ = std::fs::write(&self.log, "");
        let mut command = Command::new("ssh");
        command
            .args(&self.flags)
            .args(["-M", "-f", "-N", "-S"])
            .arg(&self.control)
            .arg("-E")
            .arg(&self.log)
            .args(["-o", "ControlPersist=yes", "-o", "BatchMode=yes", "-o", "StreamLocalBindUnlink=yes"])
            .args([
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "-o",
                "Compression=yes",
                "-o",
                "ConnectTimeout=15",
            ]);
        if trust {
            command.args(["-o", "StrictHostKeyChecking=accept-new"]);
        }
        // Not piped: `-f` leaves the master holding any pipe we gave it, so a reader would hang.
        command.arg(&self.host).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let mut child = command.spawn().map_err(|error| SshFailure::Other(format!("start ssh: {error}")))?;
        let status = wait_with_timeout(&mut child, Duration::from_secs(45)).map_err(SshFailure::Other)?;
        if status.success() {
            return Ok(());
        }
        Err(classify_ssh_failure(&std::fs::read_to_string(&self.log).unwrap_or_default()))
    }

    /// Run a POSIX sh script on the host over the master.
    pub(crate) fn exec(&self, script: &str, stdin: RemoteStdin, timeout: Duration) -> Result<Output, String> {
        let mut command = self.base();
        command.arg("-T").arg(&self.host).arg(format!("sh -c {}", shell_quote(script)));
        run_command(command, stdin, timeout)
    }

    pub(crate) fn exec_ok(&self, script: &str, stdin: RemoteStdin, timeout: Duration) -> Result<String, String> {
        let output = self.exec(script, stdin, timeout)?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
        }
        Err(classify_ssh_failure(&String::from_utf8_lossy(&output.stderr)).to_string())
    }

    fn control_op(&self, op: &str, forward: Option<String>) -> Result<(), String> {
        let mut command = self.base();
        command.args(["-O", op]);
        if let Some(spec) = forward {
            command.arg("-L").arg(spec);
        }
        command.arg(&self.host);
        let output = run_command(command, RemoteStdin::None, Duration::from_secs(15))?;
        output
            .status
            .success()
            .then_some(())
            .ok_or_else(|| classify_ssh_failure(&String::from_utf8_lossy(&output.stderr)).to_string())
    }

    fn forward_spec(local: &Path, remote: &str) -> Result<String, String> {
        // ssh splits `-L local:remote` on colons, so neither side can contain one.
        if local.to_string_lossy().contains(':') || remote.contains(':') {
            return Err("paths containing ':' cannot be forwarded".into());
        }
        Ok(format!("{}:{remote}", local.display()))
    }

    pub(crate) fn forward(&self, local: &Path, remote: &str) -> Result<(), String> {
        self.control_op("forward", Some(Self::forward_spec(local, remote)?))
    }

    /// Drop the master. This never stops anything running on the host.
    pub(crate) fn exit_master(&self) {
        let _ = self.control_op("exit", None);
    }

    pub(crate) fn probe(&self) -> Result<Probe, String> {
        parse_probe(&self.exec_ok(PROBE_SCRIPT, RemoteStdin::None, Duration::from_secs(30))?)
    }

    pub(crate) fn runtime_installed(&self, runtime: &str) -> Result<bool, String> {
        Ok(self
            .exec(&format!("test -f {}/.complete", shell_quote(runtime)), RemoteStdin::None, Duration::from_secs(20))?
            .status
            .success())
    }

    /// Stream a bundled `.tar.gz` into `<runtime>.tmp`, verify its MANIFEST, then move it into
    /// place. A directory named by hash is never overwritten.
    pub(crate) fn install_runtime(&self, runtime: &str, archive: std::fs::File) -> Result<(), String> {
        let dir = shell_quote(runtime);
        let script = format!(
            "set -e; rm -rf {dir}.tmp; mkdir -p {dir}.tmp; tar -xzf - -C {dir}.tmp; (cd {dir}.tmp && sha256sum -c MANIFEST >/dev/null); touch {dir}.tmp/.complete; mv {dir}.tmp {dir}"
        );
        self.exec_ok(&script, RemoteStdin::File(archive), Duration::from_secs(600)).map(|_| ())
    }
}

pub(crate) const DISCONNECTED: &str = "remote host disconnected";

type Pending = std::sync::Arc<Mutex<HashMap<u64, mpsc::Sender<RepoReply>>>>;

/// The long-lived `alinery-mcp --repo-service` process on the host, spoken to over one ssh
/// channel. Closing it releases the repo locks it holds and stops nothing else.
pub(crate) struct RepoChannel {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
    alive: std::sync::Arc<AtomicBool>,
}

impl RepoChannel {
    pub(crate) fn open(conn: &HostConn, service_binary: &str, app_config: &str) -> Result<Self, String> {
        let mut command = conn.base();
        command
            .arg("-T")
            .arg(&conn.host)
            .arg(format!("{} --repo-service --app-config {}", shell_quote(service_binary), shell_quote(app_config)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().map_err(|error| format!("start the repo service: {error}"))?;
        let stdin = child.stdin.take().ok_or("repo service stdin")?;
        let stdout = child.stdout.take().ok_or("repo service stdout")?;

        let pending: Pending = Default::default();
        let alive = std::sync::Arc::new(AtomicBool::new(true));
        let (hello_tx, hello_rx) = mpsc::channel();
        pending.lock().unwrap_or_else(|e| e.into_inner()).insert(HELLO_ID, hello_tx);
        {
            let (pending, alive) = (std::sync::Arc::clone(&pending), std::sync::Arc::clone(&alive));
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    // Anything that is not a reply (shell rc noise) is skipped.
                    let Ok(reply) = serde_json::from_str::<RepoReply>(&line) else { continue };
                    let sender = pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&reply.id);
                    if let Some(sender) = sender {
                        let _ = sender.send(reply);
                    }
                }
                alive.store(false, Ordering::SeqCst);
                // Dropping every sender wakes each waiter with a disconnect.
                pending.lock().unwrap_or_else(|e| e.into_inner()).clear();
            });
        }
        // The hello proves this stdout is the repo service and not a shell printing something else.
        hello_rx
            .recv_timeout(Duration::from_secs(20))
            .map_err(|_| "the repo service did not start on the host".to_string())?
            .into_result()
            .and_then(|value| serde_json::from_value::<Hello>(value).map_err(|error| error.to_string()))?;
        Ok(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending,
            next_id: AtomicU64::new(1),
            alive,
        })
    }

    pub(crate) fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub(crate) fn call(&self, op: RepoOp, timeout: Duration) -> Result<Value, String> {
        if !self.is_alive() {
            return Err(DISCONNECTED.to_string());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, sender);
        let line = serde_json::to_string(&RepoRequest { id, op }).map_err(|error| error.to_string())?;
        let written = {
            let mut stdin = self.stdin.lock().unwrap_or_else(|e| e.into_inner());
            writeln!(stdin, "{line}").and_then(|()| stdin.flush())
        };
        if written.is_err() {
            self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            return Err(DISCONNECTED.to_string());
        }
        match receiver.recv_timeout(timeout) {
            Ok(reply) => reply.into_result(),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                Err("the remote host did not answer in time".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(DISCONNECTED.to_string()),
        }
    }
}

impl Drop for RepoChannel {
    fn drop(&mut self) {
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
        let _ = child.kill();
        let _ = child.wait();
    }
}

// ── connect ────────────────────────────────────────────────────────────────────────────

/// Where the bundled runtimes live: the release resource dir, then beside the executable, then
/// the source tree for `tauri dev`. `ALINERY_REMOTE_RUNTIME_DIR` overrides it for tests.
fn bundled_runtime_dir<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(dir) = std::env::var_os("ALINERY_REMOTE_RUNTIME_DIR") {
        candidates.push(PathBuf::from(dir));
    }
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("remote"));
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|parent| parent.join("remote"))) {
        candidates.push(dir);
    }
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/remote"));
    candidates
        .into_iter()
        .find(|dir| dir.join("manifest.json").is_file())
        .ok_or_else(|| "this build of Alinery has no bundled remote runtimes".to_string())
}

fn load_manifest(dir: &Path) -> Result<RuntimeManifest, String> {
    let text = std::fs::read_to_string(dir.join("manifest.json")).map_err(|error| format!("read the runtime manifest: {error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("the runtime manifest is invalid: {error}"))
}

const SERVICE_TIMEOUT: Duration = Duration::from_secs(30);

fn write_remote_file(channel: &RepoChannel, path: String, contents: String) -> Result<(), String> {
    channel.call(RepoOp::WriteFile { path: path.into(), contents }, SERVICE_TIMEOUT).map(|_| ())
}

/// Push this Mac's settings and credentials into the host's private config directory.
fn sync_config(channel: &RepoChannel, local: &AppConfig, host_id: &str, config_dir: &str, app_config: &Path) -> Result<(), String> {
    let repos: Vec<String> = local
        .known_repos
        .iter()
        .filter_map(|key| match RepoRef::parse(key) {
            Ok(RepoRef::Remote { host_id: id, path }) if id == host_id => Some(path),
            _ => None,
        })
        .collect();
    write_remote_file(channel, format!("{config_dir}/app.toml"), render_remote_app_toml(local, &repos)?)?;

    let local_dir = app_config.parent().ok_or("app config has no parent directory")?;
    let credentials = local_dir.join("provider-credentials.json");
    let entries = alinery_core::credential_sync::read_all(&credentials)?;
    if !entries.is_empty() {
        let newer = channel.call(
            RepoOp::SyncCredentials {
                path: format!("{config_dir}/provider-credentials.json").into(),
                entries,
            },
            SERVICE_TIMEOUT,
        )?;
        if let Value::Object(newer) = newer {
            alinery_core::credential_sync::overwrite_providers(&credentials, &newer)?;
        }
    }
    // One-way copies: only this Mac writes them. inference.json is refreshed by the app, so it
    // must be re-pushed on each connect.
    for (source, name) in [
        (local_dir.join("custom-providers.json"), "custom-providers.json"),
        (alinery_core::inference_path(&alinery_core::pairing_config_dir(app_config)), "inference.json"),
    ] {
        if let Ok(contents) = std::fs::read_to_string(&source) {
            write_remote_file(channel, format!("{config_dir}/{name}"), contents)?;
        }
    }
    Ok(())
}

/// Connect to a configured host: ssh master, probe, runtime install, repo service, settings.
/// Runs blocking; callers put it on a worker thread and poll `RemoteManager::status`.
pub(crate) fn connect_host<R: tauri::Runtime>(app: &AppHandle<R>, state: &AppState, host_id: &str, trust: bool) -> Result<(), String> {
    let result = connect_inner(app, state, host_id, trust);
    match &result {
        Ok(()) => state.remotes.set(host_id, "connected", "", None),
        Err(error) => state.remotes.set(host_id, "failed", "", Some(error.clone())),
    }
    result
}

fn connect_inner<R: tauri::Runtime>(app: &AppHandle<R>, state: &AppState, host_id: &str, trust: bool) -> Result<(), String> {
    let config = load_app_config(app);
    let host = config.remote_hosts.get(host_id).cloned().ok_or("unknown remote host")?;
    let phase = |label: &str| state.remotes.set(host_id, "connecting", label, None);

    // A reconnect replaces the old channel; dropping it only ends its ssh process.
    drop(state.remotes.remove_session(host_id));
    phase("Connecting");
    let conn = HostConn::new(host_id, &host.ssh_args)?;
    conn.ensure_master(trust).map_err(|failure| failure.to_string())?;

    phase("Checking the host");
    let probe = conn.probe()?;
    let bundle = bundled_runtime_dir(app)?;
    let manifest = load_manifest(&bundle)?;
    let (_, target) = select_target(&probe, &manifest)?;
    let launcher = choose_launcher(&probe)?;
    let root = remote_root(&probe.home);
    let runtime = runtime_dir(&root, &target.runtime_hash);
    if !conn.runtime_installed(&runtime)? {
        phase("Installing the runtime");
        let archive = std::fs::File::open(bundle.join(&target.archive)).map_err(|error| format!("open the bundled runtime: {error}"))?;
        conn.install_runtime(&runtime, archive)?;
    }

    phase("Starting the repo service");
    let app_config = app_config_path(app)?;
    let config_dir = remote_config_dir(&root, &alinery_core::app_config_identity(&app_config));
    let channel = RepoChannel::open(&conn, &format!("{runtime}/alinery-mcp"), &format!("{config_dir}/app.toml"))?;
    phase("Syncing settings");
    sync_config(&channel, &config, host_id, &config_dir, &app_config)?;

    // Remember what the host looked like, so the list can show it while offline.
    let mut latest = load_app_config(app);
    if let Some(entry) = latest.remote_hosts.get_mut(host_id) {
        entry.home = Some(probe.home.clone());
        entry.platform = Some(format!("{} {}", probe.os, probe.arch));
        entry.glibc = probe.glibc.clone();
        write_app_config(app, &latest)?;
    }
    state.remotes.install_session(
        host_id,
        RemoteSession {
            conn,
            channel,
            launcher,
            root,
            runtime_hash: target.runtime_hash.clone(),
            config_dir,
        },
    );
    Ok(())
}

/// The local forwarded socket and the host's daemon socket it reaches, for one repo.
fn repo_forward(host_id: &str, repo_path: &str) -> Result<(PathBuf, String), String> {
    let remote_socket = alinery_core::alineryd_socket_path(Path::new(repo_path), None).to_string_lossy().into_owned();
    let local = forward_socket(&control_dir(alinery_core::effective_uid()), host_id, &remote_socket)?;
    Ok((local, remote_socket))
}

/// Bring up (or reconnect to) a remote repo's daemon: forward its socket, start the daemon
/// if nothing answers, and return a client on the forwarded path. Never stops anything.
pub(crate) fn ensure_remote_daemon(session: &RemoteSession, repo_path: &str, app_config_identity: &str) -> Result<(DaemonClient, DaemonCompat, bool), String> {
    let (local, remote_socket) = repo_forward(&session.conn.host_id, repo_path)?;
    let client = DaemonClient::connect_path(local.clone())?.with_observe_timeout(REMOTE_OBSERVE_TIMEOUT);
    // A reachable socket is not a live daemon: over a forward `connect` succeeds whenever the
    // master is up, so liveness is a `version` round trip.
    let answers = |client: &DaemonClient| client.version_checked().ok();

    let mut version = answers(&client);
    if version.is_none() {
        // The forward may be missing (new master) or already there (re-requesting is harmless).
        let _ = session.conn.forward(&local, &remote_socket);
        version = answers(&client);
    }
    if version.is_none() {
        let repo_hash = crate::daemon::fnv1a64_hex(repo_path);
        let runtime = runtime_dir(&session.root, &session.runtime_hash);
        let (launch, unit) = match session.launcher {
            Launcher::SystemdRun => (Launch::SystemdRun, Some(format!("alinery-daemon-{}", &repo_hash[..12]))),
            Launcher::Setsid | Launcher::Nohup => (Launch::Direct, None),
        };
        session.channel.call(
            RepoOp::SpawnDaemon {
                repo: repo_path.into(),
                app_config: format!("{}/app.toml", session.config_dir).into(),
                binary: format!("{runtime}/alinery-vinculum-daemon").into(),
                build_id: session.runtime_hash.clone(),
                namespace: None,
                ownership_lib: Some(format!("{runtime}/libalinery_core.so").into()),
                log: format!("{}/logs/daemon-{}.log", session.config_dir, &repo_hash[..12]).into(),
                launch,
                unit,
            },
            SERVICE_TIMEOUT,
        )?;
        for _ in 0..75 {
            version = answers(&client);
            if version.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    let version = version.ok_or("the daemon did not start on the host; see its log under the remote config directory")?;
    let compat = daemon_client::classify_version_reply(&version, &session.runtime_hash, app_config_identity);
    if !compat.usable() {
        return Err("another Alinery build or settings directory owns this repository on the host".to_string());
    }
    Ok((client, compat, version.host_guard_warning()))
}

/// A forwarded socket costs a channel open plus the request.
pub(crate) const REMOTE_OBSERVE_TIMEOUT: Duration = Duration::from_secs(3);

fn connected_session(state: &AppState, host_id: &str) -> Result<std::sync::Arc<RemoteSession>, String> {
    state
        .remotes
        .session(host_id)
        .filter(|session| session.channel.is_alive())
        .ok_or_else(|| format!("not connected to {host_id}; connect first"))
}

/// Run a typed repo operation on a connected host and decode its answer. The remote half of
/// an in-process core call: both run the same function in alinery-core.
pub(crate) fn remote_call<T: serde::de::DeserializeOwned>(state: &AppState, host_id: &str, op: RepoOp) -> Result<T, String> {
    let value = connected_session(state, host_id)?.channel.call(op, SERVICE_TIMEOUT)?;
    serde_json::from_value(value).map_err(|error| format!("unexpected reply from the host: {error}"))
}

/// The repo a command targets: the explicit key if given, otherwise the active repo.
pub(crate) fn repo_key_or_active(repo_path: Option<String>) -> Result<String, String> {
    match repo_path {
        Some(path) => Ok(path),
        None => active_repo_ref().map(|repo| repo.uri()),
    }
}

/// Claim a remote repo on its host, bring its daemon up through the forward, and record the
/// client where the rest of the app looks for it. `key` is the `alinery+ssh://` entry.
fn attach_remote_repo(state: &AppState, session: &RemoteSession, key: &str, path: &str) -> Result<(), String> {
    let claim = session.channel.call(RepoOp::ClaimRepo { repo: path.into() }, SERVICE_TIMEOUT)?;
    if claim["claimed"] != true {
        return Err("repo-busy: another Alinery window holds this repository on the host".to_string());
    }
    let identity = alinery_core::app_config_identity(Path::new(&format!("{}/app.toml", session.config_dir)));
    let (client, compat, warning) = ensure_remote_daemon(session, path, &identity)?;
    state.set_daemon(Path::new(key), client, compat, identity, warning);
    Ok(())
}

/// After (re)connecting, bring back every known repo on the host. Failures are per repo: one
/// busy repository must not hide the others.
fn attach_host_repos<R: tauri::Runtime>(app: &AppHandle<R>, state: &AppState, session: &RemoteSession, host_id: &str) {
    for key in load_app_config(app).known_repos {
        if let Ok(RepoRef::Remote { host_id: id, path }) = RepoRef::parse(&key) {
            if id == host_id {
                if let Err(error) = attach_remote_repo(state, session, &key, &path) {
                    if let Ok(app_config) = app_config_path(app) {
                        alinery_core::append_exception(
                            &app_config,
                            &format!(
                                "app.remote-attach-failed repo={} err={}",
                                alinery_core::quote_log_value(&key),
                                alinery_core::quote_log_value(&error)
                            ),
                        );
                    }
                }
            }
        }
    }
}

/// `set_active_repo` for a remote key: it must be known and its host connected.
pub(crate) fn activate_remote_repo<R: tauri::Runtime>(app: &AppHandle<R>, state: &AppState, key: &str) -> Result<AppConfig, String> {
    let RepoRef::Remote { host_id, path } = RepoRef::parse(key)? else {
        return Err("not a remote repository".into());
    };
    let mut config = load_app_config(app);
    if !config.known_repos.iter().any(|known| known == key) {
        return Err(format!("unknown repository: {key}"));
    }
    let session = connected_session(state, &host_id)?;
    attach_remote_repo(state, &session, key, &path)?;
    config.active_repo = key.to_string();
    write_app_config(app, &config)?;
    set_active_repo_global(Some(PathBuf::from(key)))?;
    Ok(sanitize_app_config(config))
}

// ── commands ───────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub(crate) struct RemoteHostView {
    pub(crate) host_id: String,
    pub(crate) label: String,
    /// What the user typed, as stored (flags then host), for display.
    pub(crate) destination: String,
    pub(crate) state: String,
    pub(crate) phase: String,
    pub(crate) error: Option<String>,
    pub(crate) home: Option<String>,
    pub(crate) platform: Option<String>,
}

fn host_view(state: &AppState, host_id: &str, host: &RemoteHost) -> RemoteHostView {
    let status = state.remotes.status(host_id);
    RemoteHostView {
        host_id: host_id.to_string(),
        label: host.label.clone(),
        destination: host.ssh_args.join(" "),
        state: status.state,
        phase: status.phase,
        error: status.error,
        home: host.home.clone(),
        platform: host.platform.clone(),
    }
}

pub(crate) fn host_views<R: tauri::Runtime>(app: &AppHandle<R>, state: &AppState) -> Vec<RemoteHostView> {
    load_app_config(app).remote_hosts.iter().map(|(id, host)| host_view(state, id, host)).collect()
}

#[tauri::command]
pub(crate) fn remote_hosts(app: AppHandle, state: State<'_, AppState>) -> Vec<RemoteHostView> {
    host_views(&app, &state)
}

/// Validate and remember a destination. Nothing connects yet.
#[tauri::command]
pub(crate) fn remote_add_host(app: AppHandle, state: State<'_, AppState>, destination: String) -> Result<RemoteHostView, String> {
    let ssh_args = parse_destination(&destination)?;
    let host_id = host_id(&ssh_args);
    let mut config = load_app_config(&app);
    let host = config.remote_hosts.entry(host_id.clone()).or_insert_with(|| RemoteHost {
        label: ssh_args.last().cloned().unwrap_or_default(),
        ssh_args: ssh_args.clone(),
        ..Default::default()
    });
    let view = host_view(&state, &host_id, host);
    write_app_config(&app, &config)?;
    Ok(view)
}

/// Connect (or reconnect) a host, then bring back every known repo on it.
pub(crate) fn connect_and_attach<R: tauri::Runtime>(app: &AppHandle<R>, host_id: &str, trust: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    connect_host(app, &state, host_id, trust)?;
    if let Some(session) = state.remotes.session(host_id) {
        attach_host_repos(app, &state, &session, host_id);
    }
    Ok(())
}

/// `trust` accepts a first-seen host key after the user said so.
#[tauri::command]
pub(crate) async fn remote_connect(app: AppHandle, host_id: String, trust: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || connect_and_attach(&app, &host_id, trust))
        .await
        .map_err(|error| format!("remote connect task: {error}"))?
}

/// Drop the connection. Sessions keep running on the host; this ends only ssh processes and
/// forgets the local daemon handles, so the board shows the host as offline.
pub(crate) fn disconnect_host<R: tauri::Runtime>(app: &AppHandle<R>, host_id: &str) {
    let state = app.state::<AppState>();
    let mut forwards = Vec::new();
    for key in load_app_config(app).known_repos {
        if let Ok(RepoRef::Remote { host_id: id, path }) = RepoRef::parse(&key) {
            if id == host_id {
                state.clear_daemon(Path::new(&key));
                forwards.extend(repo_forward(host_id, &path).ok().map(|(local, _)| local));
            }
        }
    }
    if let Some(session) = state.remotes.remove_session(host_id) {
        session.conn.exit_master();
    }
    // The master is gone, so these sockets lead nowhere; the next connect binds them afresh.
    for socket in forwards {
        let _ = std::fs::remove_file(socket);
    }
    state.remotes.set(host_id, "idle", "", None);
}

#[tauri::command]
pub(crate) async fn remote_disconnect(app: AppHandle, host_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || disconnect_host(&app, &host_id))
        .await
        .map_err(|error| format!("remote disconnect task: {error}"))
}

fn session_call(app: &AppHandle, host_id: &str, op: RepoOp) -> Result<Value, String> {
    let state = app.state::<AppState>();
    connected_session(&state, host_id)?.channel.call(op, SERVICE_TIMEOUT)
}

#[tauri::command]
pub(crate) async fn remote_list_dir(app: AppHandle, host_id: String, path: String, show_hidden: bool) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || session_call(&app, &host_id, RepoOp::ListDir { path: path.into(), show_hidden }))
        .await
        .map_err(|error| format!("remote list task: {error}"))?
}

#[tauri::command]
pub(crate) async fn remote_classify(app: AppHandle, host_id: String, path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || session_call(&app, &host_id, RepoOp::Classify { path: path.into() }))
        .await
        .map_err(|error| format!("remote classify task: {error}"))?
}

#[tauri::command]
pub(crate) async fn remote_init(app: AppHandle, host_id: String, path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || session_call(&app, &host_id, RepoOp::Init { path: path.into() }))
        .await
        .map_err(|error| format!("remote init task: {error}"))?
}

/// List a git checkout on the host as a repository. `path` must be the checkout root that
/// `remote_classify` reported. Returns the key to pass to `set_active_repo`.
pub(crate) fn add_remote_repo<R: tauri::Runtime>(app: &AppHandle<R>, host_id: &str, path: &str) -> Result<String, String> {
    let state = app.state::<AppState>();
    let session = connected_session(&state, host_id)?;
    let class = session.channel.call(RepoOp::Classify { path: path.into() }, SERVICE_TIMEOUT)?;
    if class["kind"] != "checkout" || class["root"] != path {
        return Err(format!("{path} is not the root of a git checkout"));
    }
    let key = RepoRef::Remote {
        host_id: host_id.to_string(),
        path: path.to_string(),
    }
    .uri();
    let mut config = load_app_config(app);
    if !config.known_repos.contains(&key) {
        config.known_repos.push(key.clone());
    }
    write_app_config(app, &config)?;
    // The host's copy of app.toml allowlists its repos for the remote alinery-mcp.
    sync_config(&session.channel, &config, host_id, &session.config_dir, &app_config_path(app)?)?;
    Ok(key)
}

#[tauri::command]
pub(crate) async fn remote_add_repo(app: AppHandle, host_id: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || add_remote_repo(&app, &host_id, &path))
        .await
        .map_err(|error| format!("remote add repo task: {error}"))?
}

/// Delist a remote repo and let go of it locally, leaving its daemon and every session running
/// on the host. Stopping them is a separate, deliberate action.
pub(crate) fn remove_remote_repo<R: tauri::Runtime>(app: &AppHandle<R>, path: &str) -> Result<AppConfig, String> {
    let state = app.state::<AppState>();
    let RepoRef::Remote { host_id, path: remote_path } = RepoRef::parse(path.trim())? else {
        return Err("not a remote repository".into());
    };
    let (config, was_active) = remove_repo_from_config(load_app_config(app), path)?;
    write_app_config(app, &config)?;
    if was_active {
        set_active_repo_global(None)?;
    }
    state.clear_daemon(Path::new(path.trim()));
    if let Some(session) = state.remotes.session(&host_id) {
        let _ = session.channel.call(RepoOp::ReleaseRepo { repo: remote_path.into() }, SERVICE_TIMEOUT);
    }
    Ok(config)
}

#[tauri::command]
pub(crate) async fn remove_remote_repo_keep_running(app: AppHandle, path: String) -> Result<AppConfig, String> {
    tauri::async_runtime::spawn_blocking(move || remove_remote_repo(&app, &path))
        .await
        .map_err(|error| format!("remove remote repo task: {error}"))?
}

// ── connection manager ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub(crate) struct RemoteStatus {
    pub(crate) host_id: String,
    /// idle | connecting | connected | failed
    pub(crate) state: String,
    /// What the dialog shows while `connecting`.
    pub(crate) phase: String,
    pub(crate) error: Option<String>,
}

/// A connected host: its ssh master, its repo-service channel and what was learned installing.
pub(crate) struct RemoteSession {
    pub(crate) conn: HostConn,
    pub(crate) channel: RepoChannel,
    pub(crate) launcher: Launcher,
    pub(crate) root: String,
    pub(crate) runtime_hash: String,
    pub(crate) config_dir: String,
}

#[derive(Default)]
pub(crate) struct RemoteManager {
    statuses: Mutex<HashMap<String, RemoteStatus>>,
    sessions: Mutex<HashMap<String, std::sync::Arc<RemoteSession>>>,
}

impl RemoteManager {
    pub(crate) fn status(&self, host_id: &str) -> RemoteStatus {
        let statuses = self.statuses.lock().unwrap_or_else(|e| e.into_inner());
        let mut status = statuses.get(host_id).cloned().unwrap_or(RemoteStatus {
            host_id: host_id.to_string(),
            state: "idle".into(),
            ..Default::default()
        });
        // A dead channel is a lost connection even if nobody noticed yet.
        if status.state == "connected" && !self.session(host_id).is_some_and(|session| session.channel.is_alive()) {
            status.state = "failed".into();
            status.error = Some(DISCONNECTED.into());
        }
        status
    }

    pub(crate) fn session(&self, host_id: &str) -> Option<std::sync::Arc<RemoteSession>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).get(host_id).cloned()
    }

    pub(crate) fn set(&self, host_id: &str, state: &str, phase: &str, error: Option<String>) {
        self.statuses.lock().unwrap_or_else(|e| e.into_inner()).insert(
            host_id.to_string(),
            RemoteStatus {
                host_id: host_id.to_string(),
                state: state.into(),
                phase: phase.into(),
                error,
            },
        );
    }

    pub(crate) fn install_session(&self, host_id: &str, session: RemoteSession) -> std::sync::Arc<RemoteSession> {
        let session = std::sync::Arc::new(session);
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(host_id.to_string(), std::sync::Arc::clone(&session));
        session
    }

    pub(crate) fn remove_session(&self, host_id: &str) -> Option<std::sync::Arc<RemoteSession>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(host_id)
    }
}
