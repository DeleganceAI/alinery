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
use std::collections::{BTreeMap, BTreeSet};

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
    let ok = !value.is_empty() && !value.starts_with('-') && value.chars().all(|c| c.is_ascii_alphanumeric() || "._@%:[]-_".contains(c) || extra.contains(c));
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

// ── ssh config aliases ─────────────────────────────────────────────────────────────────

const MAX_ALIASES: usize = 500;
const MAX_CONFIG_BYTES: u64 = 1 << 20;
const MAX_INCLUDE_DEPTH: u8 = 4;

/// `*` and `?` against one file name.
fn wildcard_match(pattern: &[u8], name: &[u8]) -> bool {
    match (pattern.first(), name.first()) {
        (None, None) => true,
        (Some(b'*'), _) => wildcard_match(&pattern[1..], name) || (!name.is_empty() && wildcard_match(pattern, &name[1..])),
        (Some(b'?'), Some(_)) => wildcard_match(&pattern[1..], &name[1..]),
        (Some(p), Some(n)) if p == n => wildcard_match(&pattern[1..], &name[1..]),
        _ => false,
    }
}

/// Add the host names an ssh config declares with `Host`, following `Include` through
/// `includes` (pattern in, file contents out). Patterns (`*`, `?`, `!`) are not hosts a user can
/// pick, and a name this app would refuse as a destination is skipped.
pub(crate) fn collect_aliases(text: &str, includes: &dyn Fn(&str) -> Vec<String>, depth: u8, found: &mut BTreeSet<String>) {
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(split) = line.find(|c: char| c.is_whitespace() || c == '=') else { continue };
        let rest = line[split..].trim_start_matches(|c: char| c.is_whitespace() || c == '=');
        let Ok(words) = split_words(rest) else { continue };
        let words = words.into_iter().take_while(|word| !word.starts_with('#'));
        match line[..split].to_ascii_lowercase().as_str() {
            "host" => found.extend(words.filter(|word| !word.contains(['*', '?', '!']) && plain_value(word, "host", "").is_ok())),
            "include" if depth < MAX_INCLUDE_DEPTH => {
                for pattern in words {
                    for body in includes(&pattern) {
                        collect_aliases(&body, includes, depth + 1, found);
                    }
                }
            }
            _ => {}
        }
    }
}

fn read_small_file(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    (meta.is_file() && meta.len() <= MAX_CONFIG_BYTES).then(|| std::fs::read_to_string(path).ok()).flatten()
}

/// The files an `Include` pattern names: relative to `~/.ssh`, `~/` expanded, and a wildcard only
/// in the last path component (the common `conf.d/*` shape), in name order.
pub(crate) fn include_bodies(pattern: &str, ssh_dir: &Path, home: &Path) -> Vec<String> {
    let path = match pattern.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None if pattern.starts_with('/') => PathBuf::from(pattern),
        None => ssh_dir.join(pattern),
    };
    let (Some(dir), Some(name)) = (path.parent(), path.file_name().and_then(|name| name.to_str())) else {
        return Vec::new();
    };
    if !name.contains(['*', '?']) {
        return read_small_file(&path).into_iter().collect();
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut matched: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_str().is_some_and(|file| wildcard_match(name.as_bytes(), file.as_bytes())))
        .map(|entry| entry.path())
        .collect();
    matched.sort();
    matched.iter().filter_map(|file| read_small_file(file)).collect()
}

/// The host aliases in `~/.ssh/config`, sorted. Names only: nothing else in the file is read out.
fn load_ssh_aliases() -> Vec<String> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return Vec::new() };
    let ssh_dir = home.join(".ssh");
    let Some(text) = read_small_file(&ssh_dir.join("config")) else { return Vec::new() };
    let mut found = BTreeSet::new();
    collect_aliases(&text, &|pattern| include_bodies(pattern, &ssh_dir, &home), 0, &mut found);
    found.into_iter().take(MAX_ALIASES).collect()
}

/// Where a destination resolves to, as `ssh -G` reports it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct SshTarget {
    pub(crate) hostname: String,
    pub(crate) user: Option<String>,
    pub(crate) port: u16,
    pub(crate) jump: Option<String>,
}

pub(crate) fn parse_ssh_g(output: &str) -> Option<SshTarget> {
    let value = |key: &str| {
        output
            .lines()
            .find_map(|line| line.strip_prefix(key).and_then(|rest| rest.strip_prefix(' ')))
            .map(|rest| rest.trim().to_string())
            .filter(|rest| !rest.is_empty())
    };
    Some(SshTarget {
        hostname: value("hostname")?,
        user: value("user"),
        port: value("port").and_then(|port| port.parse().ok()).unwrap_or(22),
        jump: value("proxyjump").filter(|jump| jump != "none"),
    })
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

/// The `app.toml` the host's daemon and repo service read: an allowlist, not a copy of this Mac's.
///
/// What a host-side process actually consults is small. The default model and thinking level for a
/// new session come from `defaults`, and the Grok key is handed to the daemon as `XAI_API_KEY` when
/// it starts (a provider credential, so only when the user chose to share it). Everything else in
/// the Mac's settings is either a UI preference or something that must not leave it: the GitHub
/// token (imports and PR discovery run here, and the host pushes with its own git credentials), the
/// telemetry install id and endpoint (the host records no events under this install), harness rows
/// that name Mac paths and may carry keys in `env`, and the backup destination. Those stay at their
/// defaults.
pub(crate) fn render_remote_app_toml(local: &AppConfig, remote_repo_paths: &[String], share_grok: bool) -> Result<String, String> {
    let mut config = AppConfig {
        settings_version: local.settings_version,
        known_repos: remote_repo_paths.to_vec(),
        ..AppConfig::default()
    };
    config.global.defaults = local.global.defaults.clone();
    if share_grok {
        config.global.experiments.grok_api_key = local.global.experiments.grok_api_key.clone();
    }
    config.global.telemetry = alinery_core::TelemetryPrefs {
        enabled: false,
        prompted: true,
        install_id: String::new(),
        ..config.global.telemetry
    };
    toml::to_string(&config).map_err(|error| format!("render remote app.toml: {error}"))
}

// ── ssh driving ────────────────────────────────────────────────────────────────────────

pub(crate) use alinery_core::repo_service::RepoOp;
use alinery_core::repo_service::{Hello, Launch, RepoReply, RepoRequest, HELLO_ID};
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

const SHARE_HOSTED: &str = "hosted-models";
const SHARE_CUSTOM: &str = "custom-providers";
const SHARE_GROK: &str = "grok";
const SHARE_KEY: &str = "key:";

fn key_providers(items: &[String]) -> Vec<String> {
    items.iter().filter_map(|item| item.strip_prefix(SHARE_KEY)).map(str::to_string).collect()
}

/// A host from before sharing was a choice keeps what it was given (hosted models, custom
/// providers, the Grok key, the API keys this Mac held), and nothing new is added silently later.
pub(crate) fn inherited_sharing(credentials: &Path) -> Result<RemoteSharing, String> {
    let mut shared: Vec<String> = [SHARE_HOSTED, SHARE_CUSTOM, SHARE_GROK].map(str::to_string).into();
    for (provider, kind) in alinery_core::credential_sync::kinds(credentials)? {
        if kind == "api_key" {
            shared.push(format!("{SHARE_KEY}{provider}"));
        }
    }
    Ok(RemoteSharing {
        reviewed: true,
        placed: shared.clone(),
        shared,
        erased_sign_ins: Vec::new(),
    })
}

/// Push this Mac's settings to the host's private config directory, and the credentials the user
/// chose for it. Browser sign-ins are never copied. Returns the host's sharing record to keep.
pub(crate) fn sync_config(channel: &RepoChannel, local: &AppConfig, host_id: &str, config_dir: &str, app_config: &Path) -> Result<RemoteSharing, String> {
    let host = local.remote_hosts.get(host_id).ok_or("unknown remote host")?;
    let repos: Vec<String> = local
        .known_repos
        .iter()
        .filter_map(|key| match RepoRef::parse(key) {
            Ok(RepoRef::Remote { host_id: id, path }) if id == host_id => Some(path),
            _ => None,
        })
        .collect();
    let local_dir = app_config.parent().ok_or("app config has no parent directory")?;
    let credentials = local_dir.join("provider-credentials.json");
    let legacy = host.sharing.is_none();
    let mut sharing = match &host.sharing {
        Some(sharing) => sharing.clone(),
        None => inherited_sharing(&credentials)?,
    };
    let wants = |item: &str| sharing.reviewed && sharing.shared.iter().any(|shared| shared == item);
    write_remote_file(channel, format!("{config_dir}/app.toml"), render_remote_app_toml(local, &repos, wants(SHARE_GROK))?)?;
    if !sharing.reviewed {
        return Ok(sharing);
    }

    let set = alinery_core::credential_sync::api_keys(&credentials, &key_providers(&sharing.shared))?;
    let remove: Vec<String> = key_providers(&sharing.placed).into_iter().filter(|provider| !set.contains_key(provider)).collect();
    let mut placed: Vec<String> = set.keys().map(|provider| format!("{SHARE_KEY}{provider}")).collect();
    let erased = channel.call(
        RepoOp::SyncCredentials {
            path: format!("{config_dir}/provider-credentials.json").into(),
            set,
            remove,
            erase_oauth: legacy,
        },
        SERVICE_TIMEOUT,
    )?;
    if legacy {
        sharing.erased_sign_ins = serde_json::from_value(erased).map_err(|error| format!("read the erased sign-ins: {error}"))?;
    }
    // inference.json is refreshed by the app, so a shared copy is re-pushed on every connect.
    for (item, source, name) in [
        (SHARE_CUSTOM, local_dir.join("custom-providers.json"), "custom-providers.json"),
        (SHARE_HOSTED, alinery_core::inference_path(&alinery_core::pairing_config_dir(app_config)), "inference.json"),
    ] {
        let path = format!("{config_dir}/{name}");
        match std::fs::read_to_string(&source) {
            Ok(contents) if wants(item) => {
                write_remote_file(channel, path, contents)?;
                placed.push(item.to_string());
            }
            _ if sharing.placed.iter().any(|placed| placed == item) => {
                channel.call(RepoOp::RemoveFile { path: path.into() }, SERVICE_TIMEOUT)?;
            }
            _ => {}
        }
    }
    sharing.placed = placed;
    Ok(sharing)
}

/// Keep the sharing record a sync produced, if it changed.
fn record_sharing<R: tauri::Runtime>(app: &AppHandle<R>, host_id: &str, sharing: RemoteSharing) -> Result<(), String> {
    let mut config = load_app_config(app);
    match config.remote_hosts.get_mut(host_id) {
        Some(host) if host.sharing.as_ref() != Some(&sharing) => {
            host.sharing = Some(sharing);
            write_app_config(app, &config)
        }
        _ => Ok(()),
    }
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
    record_sharing(app, host_id, sync_config(&channel, &config, host_id, &config_dir, &app_config)?)?;

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
            secrets_dir: remote_secrets_dir(&app_config, host_id)?,
        },
    );
    Ok(())
}

// A remote daemon cannot tell that a UI-only request (approving a step's completion) comes from this
// app: over the ssh forward its peer is `sshd`. So the app that starts a daemon gives it a secret,
// through a file the daemon deletes at startup, and keeps its own copy here, owner-only, per repo.
// The host never holds the secret on disk once the daemon is up.

pub(crate) fn remote_secrets_dir(app_config: &Path, host_id: &str) -> Result<PathBuf, String> {
    Ok(app_config_dir_of(app_config).ok_or("app config root unavailable")?.join("remote").join(host_id))
}

pub(crate) fn read_ui_secrets(secrets_dir: &Path) -> std::collections::BTreeMap<String, String> {
    fs::read(secrets_dir.join("ui-secrets.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub(crate) fn store_ui_secret(secrets_dir: &Path, repo_path: &str, secret: &str) -> Result<(), String> {
    let mut secrets = read_ui_secrets(secrets_dir);
    secrets.insert(repo_path.to_string(), secret.to_string());
    fs::create_dir_all(secrets_dir).map_err(|error| format!("create {}: {error}", secrets_dir.display()))?;
    alinery_core::write_owner_only_bytes(&secrets_dir.join("ui-secrets.json"), &serde_json::to_vec(&secrets).map_err(|error| error.to_string())?)
}

/// The secret for the daemon this Mac started for `repo_path` on `host_id`.
pub(crate) fn remote_ui_secret(app_config: &Path, host_id: &str, repo_path: &str) -> Result<String, String> {
    read_ui_secrets(&remote_secrets_dir(app_config, host_id)?).remove(repo_path).ok_or_else(|| {
        "this remote daemon was not started by this Mac, so it cannot approve from here; stop the daemon on the host and reconnect to start one that can".to_string()
    })
}

fn new_ui_secret() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
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
        // The secret goes to the host in a file only the daemon reads, and is kept here before the
        // daemon exists so a successful start can never lack its copy.
        let secret = new_ui_secret();
        let secret_file = format!("{}/ui-secrets/{}.secret", session.config_dir, &repo_hash[..12]);
        store_ui_secret(&session.secrets_dir, repo_path, &secret)?;
        session.channel.call(
            RepoOp::WriteFile {
                path: secret_file.clone().into(),
                contents: secret,
            },
            SERVICE_TIMEOUT,
        )?;
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
                ui_secret_file: Some(secret_file.into()),
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

pub(crate) fn connected_session(state: &AppState, host_id: &str) -> Result<std::sync::Arc<RemoteSession>, String> {
    state
        .remotes
        .session(host_id)
        .filter(|session| session.channel.is_alive())
        .ok_or_else(|| format!("not connected to {host_id}; connect first"))
}

/// Two repositories share a machine when both are local or both are on the same host. Anything that
/// links or copies files between repositories needs that: a path means one thing per machine.
pub(crate) fn same_machine(left: &RepoRef, right: &RepoRef) -> bool {
    match (left, right) {
        (RepoRef::Local(_), RepoRef::Local(_)) => true,
        (RepoRef::Remote { host_id: a, .. }, RepoRef::Remote { host_id: b, .. }) => a == b,
        _ => false,
    }
}

/// The `app.toml` the host's daemon and repo service run with.
pub(crate) fn host_app_config(state: &AppState, host_id: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(format!("{}/app.toml", connected_session(state, host_id)?.config_dir)))
}

/// Run a typed repo operation on a connected host and decode its answer. The remote half of
/// an in-process core call: both run the same function in alinery-core.
pub(crate) fn remote_call<T: serde::de::DeserializeOwned>(state: &AppState, host_id: &str, op: RepoOp) -> Result<T, String> {
    let value = connected_session(state, host_id)?.channel.call(op, SERVICE_TIMEOUT)?;
    serde_json::from_value(value).map_err(|error| format!("unexpected reply from the host: {error}"))
}

/// The active repo of a command that talks to a daemon: a local repo this window owns, or a
/// remote one whose host is connected and whose daemon answers.
pub(crate) enum ActiveRepo {
    Local(PathBuf),
    Remote { host_id: String, path: String },
}

pub(crate) fn require_active_target(state: &AppState) -> Result<ActiveRepo, String> {
    match active_repo_ref()? {
        RepoRef::Local(_) => require_owned_active_repo(state).map(ActiveRepo::Local),
        RepoRef::Remote { host_id, path } => {
            connected_session(state, &host_id)?;
            let key = RepoRef::Remote {
                host_id: host_id.clone(),
                path: path.clone(),
            }
            .uri();
            state
                .daemon_for(Path::new(&key))
                .ok_or_else(|| "this remote repository's daemon is not connected".to_string())?;
            Ok(ActiveRepo::Remote { host_id, path })
        }
    }
}

/// The daemon client that owns `task_slug` in `repo`. A local task may live on a foreign lane, so
/// it is found through its retained execution; a remote repo has the one forwarded daemon.
pub(crate) fn task_client(state: &AppState, app_config: &Path, repo: &RepoRef, task_slug: &str) -> Result<DaemonClient, String> {
    match repo {
        RepoRef::Local(path) => {
            require_repo_owned(state, path)?;
            task_daemon_for(path, task_slug, app_config)
        }
        RepoRef::Remote { host_id, .. } => {
            connected_session(state, host_id)?;
            state
                .daemon_for(Path::new(&repo.uri()))
                .ok_or_else(|| "this remote repository's daemon is not connected".to_string())
        }
    }
}

/// The repo's own daemon client (its own lane), for operations that are not about one task.
pub(crate) fn repo_client(state: &AppState, repo: &RepoRef) -> Result<DaemonClient, String> {
    match repo {
        RepoRef::Local(path) => {
            require_repo_owned(state, path)?;
            state.daemon_for(path).ok_or_else(|| "daemon not connected".to_string())
        }
        RepoRef::Remote { host_id, .. } => {
            connected_session(state, host_id)?;
            state
                .daemon_for(Path::new(&repo.uri()))
                .ok_or_else(|| "this remote repository's daemon is not connected".to_string())
        }
    }
}

/// For the commands that only need a live daemon for the active repo (write, resize, transcript,
/// prompt, ...): the local ownership check, or the remote connection check.
pub(crate) fn require_active_repo_ready(state: &AppState) -> Result<(), String> {
    require_active_target(state).map(|_| ())
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
    /// False for a host that has not been told what it may receive yet.
    pub(crate) sharing_reviewed: bool,
    /// Sign-ins removed from this host that the user has not acknowledged.
    pub(crate) erased_sign_ins: Vec<String>,
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
        sharing_reviewed: host.sharing.as_ref().is_none_or(|sharing| sharing.reviewed),
        erased_sign_ins: host.sharing.as_ref().map(|sharing| sharing.erased_sign_ins.clone()).unwrap_or_default(),
    }
}

pub(crate) fn host_views<R: tauri::Runtime>(app: &AppHandle<R>, state: &AppState) -> Vec<RemoteHostView> {
    load_app_config(app).remote_hosts.iter().map(|(id, host)| host_view(state, id, host)).collect()
}

#[tauri::command]
pub(crate) fn remote_hosts(app: AppHandle, state: State<'_, AppState>) -> Vec<RemoteHostView> {
    host_views(&app, &state)
}

/// Validate and remember a destination. Nothing connects yet. `label` names a new host; an
/// existing one keeps its name.
#[tauri::command]
pub(crate) fn remote_add_host(app: AppHandle, state: State<'_, AppState>, destination: String, label: Option<String>) -> Result<RemoteHostView, String> {
    let ssh_args = parse_destination(&destination)?;
    let host_id = host_id(&ssh_args);
    let mut config = load_app_config(&app);
    let host = config.remote_hosts.entry(host_id.clone()).or_insert_with(|| RemoteHost {
        label: label
            .map(|label| label.trim().to_string())
            .filter(|label| !label.is_empty() && !label.chars().any(char::is_control))
            .unwrap_or_else(|| ssh_args.last().cloned().unwrap_or_default()),
        ssh_args: ssh_args.clone(),
        // A new host receives no credentials until the user has chosen which.
        sharing: Some(RemoteSharing::default()),
        ..Default::default()
    });
    let view = host_view(&state, &host_id, host);
    write_app_config(&app, &config)?;
    Ok(view)
}

/// What the setup step and the host's credentials dialog show: what this Mac could give a host,
/// and what the host is set to receive.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SharingView {
    pub(crate) reviewed: bool,
    /// Ticked items: the host's choice, or the proposed one for a host that has not been reviewed.
    pub(crate) shared: Vec<String>,
    /// Providers this Mac holds an API key for.
    pub(crate) keys: Vec<String>,
    /// Providers this Mac is signed in to with a browser. These are never copied.
    pub(crate) sign_ins: Vec<String>,
    pub(crate) custom_providers: bool,
    pub(crate) grok: bool,
    /// Whether this Mac has a hosted-model token to give, and when it stops working.
    pub(crate) hosted: bool,
    pub(crate) hosted_expires_at: Option<u64>,
    pub(crate) erased_sign_ins: Vec<String>,
}

pub(crate) fn sharing_view(config: &AppConfig, host_id: &str, app_config: &Path) -> Result<SharingView, String> {
    let host = config.remote_hosts.get(host_id).ok_or("unknown remote host")?;
    let local_dir = app_config.parent().ok_or("app config has no parent directory")?;
    let credentials = local_dir.join("provider-credentials.json");
    let kinds = alinery_core::credential_sync::kinds(&credentials)?;
    let holding = |wanted: &str| kinds.iter().filter(|(_, kind)| *kind == wanted).map(|(provider, _)| provider.clone()).collect::<Vec<_>>();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs());
    let hosted_expires_at = alinery_core::inference_expires_at(&alinery_core::pairing_config_dir(app_config)).filter(|expires| *expires > now);
    let sharing = match &host.sharing {
        Some(sharing) => sharing.clone(),
        None => inherited_sharing(&credentials)?,
    };
    let shared = if sharing.reviewed {
        sharing.shared
    } else if hosted_expires_at.is_some() {
        vec![SHARE_HOSTED.to_string()]
    } else {
        Vec::new()
    };
    Ok(SharingView {
        reviewed: sharing.reviewed,
        shared,
        keys: holding("api_key"),
        sign_ins: holding("oauth"),
        custom_providers: local_dir.join("custom-providers.json").is_file(),
        grok: !config.global.experiments.grok_api_key.trim().is_empty(),
        hosted: hosted_expires_at.is_some(),
        hosted_expires_at,
        erased_sign_ins: sharing.erased_sign_ins,
    })
}

pub(crate) fn valid_share_item(item: &str) -> bool {
    matches!(item, SHARE_HOSTED | SHARE_CUSTOM | SHARE_GROK)
        || item
            .strip_prefix(SHARE_KEY)
            .is_some_and(|provider| !provider.is_empty() && !provider.chars().any(char::is_control))
}

/// Record what a connected host may receive and apply it now: copy what was added, remove what
/// this app copied before and was taken off. Saving also acknowledges any removed sign-ins.
pub(crate) fn set_sharing<R: tauri::Runtime>(app: &AppHandle<R>, host_id: &str, mut shared: Vec<String>) -> Result<SharingView, String> {
    if let Some(unknown) = shared.iter().find(|item| !valid_share_item(item)) {
        return Err(format!("unknown item to share: {unknown}"));
    }
    shared.sort();
    shared.dedup();
    let state = app.state::<AppState>();
    let session = connected_session(&state, host_id)?;
    let app_config = app_config_path(app)?;
    let mut config = load_app_config(app);
    let host = config.remote_hosts.get_mut(host_id).ok_or("unknown remote host")?;
    let sharing = host.sharing.get_or_insert_with(RemoteSharing::default);
    sharing.reviewed = true;
    sharing.shared = shared;
    sharing.erased_sign_ins.clear();
    write_app_config(app, &config)?;
    record_sharing(app, host_id, sync_config(&session.channel, &config, host_id, &session.config_dir, &app_config)?)?;
    sharing_view(&load_app_config(app), host_id, &app_config)
}

#[tauri::command]
pub(crate) async fn remote_sharing(app: AppHandle, host_id: String) -> Result<SharingView, String> {
    tauri::async_runtime::spawn_blocking(move || sharing_view(&load_app_config(&app), &host_id, &app_config_path(&app)?))
        .await
        .map_err(|error| format!("remote sharing task: {error}"))?
}

#[tauri::command]
pub(crate) async fn remote_set_sharing(app: AppHandle, host_id: String, shared: Vec<String>) -> Result<SharingView, String> {
    tauri::async_runtime::spawn_blocking(move || set_sharing(&app, &host_id, shared))
        .await
        .map_err(|error| format!("remote sharing task: {error}"))?
}

/// The names in `~/.ssh/config`, for the "set up a remote" picker.
#[tauri::command]
pub(crate) async fn remote_ssh_aliases() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(load_ssh_aliases)
        .await
        .map_err(|error| format!("ssh aliases task: {error}"))
}

/// Where a destination resolves to. `ssh -G` makes no connection, but it does evaluate the user's
/// own `Match exec` lines, exactly as connecting would.
pub(crate) fn describe_destination(destination: &str) -> Result<SshTarget, String> {
    let args = parse_destination(destination)?;
    let (host, flags) = args.split_last().ok_or("empty ssh destination")?;
    let mut command = Command::new("ssh");
    command.args(flags).arg("-G").arg(host);
    let output = run_command(command, RemoteStdin::None, Duration::from_secs(5))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    parse_ssh_g(&String::from_utf8_lossy(&output.stdout)).ok_or_else(|| "ssh did not report a host".to_string())
}

#[tauri::command]
pub(crate) async fn remote_describe_destination(destination: String) -> Result<SshTarget, String> {
    tauri::async_runtime::spawn_blocking(move || describe_destination(&destination))
        .await
        .map_err(|error| format!("describe task: {error}"))?
}

/// Forget a host that never finished its first connect, so a failed setup leaves nothing behind.
/// A host that has connected, or that has repos, is not touched.
pub(crate) fn discard_unconnected_host<R: tauri::Runtime>(app: &AppHandle<R>, host_id: &str) -> Result<(), String> {
    let mut config = load_app_config(app);
    let has_repos = config
        .known_repos
        .iter()
        .any(|key| matches!(RepoRef::parse(key), Ok(RepoRef::Remote { host_id: id, .. }) if id == host_id));
    if has_repos || config.remote_hosts.get(host_id).is_none_or(|host| host.home.is_some()) {
        return Ok(());
    }
    disconnect_host(app, host_id);
    config.remote_hosts.remove(host_id);
    write_app_config(app, &config)
}

#[tauri::command]
pub(crate) async fn remote_discard_host(app: AppHandle, host_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || discard_unconnected_host(&app, &host_id))
        .await
        .map_err(|error| format!("discard host task: {error}"))?
}

/// Connect (or reconnect) a host, then bring back every known repo on it.
pub(crate) fn connect_and_attach<R: tauri::Runtime>(app: &AppHandle<R>, host_id: &str, trust: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let was_connected = state.remotes.status(host_id).state == "connected";
    let lock = state.remotes.lock(host_id);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    // The automatic reconnect finished while this call waited for it.
    if !was_connected && state.remotes.status(host_id).state == "connected" {
        return Ok(());
    }
    connect_host(app, &state, host_id, trust)?;
    if let Some(session) = state.remotes.session(host_id) {
        attach_host_repos(app, &state, &session, host_id);
    }
    state.remotes.want(host_id);
    // Open terminals that lost their stream rejoin their sessions.
    let _ = app.emit("remote_host_connected", json!({ "host_id": host_id }));
    Ok(())
}

/// How often the supervisor looks for hosts that dropped.
const SUPERVISOR_TICK: Duration = Duration::from_secs(1);

/// Bring back a host that was connected and dropped (network change, sleep, ssh killed). It only
/// ever connects: it never stops a daemon or a session on the host, and it leaves a host the user
/// disconnected alone. Backoff is `RECONNECT_DELAYS_SECS`.
pub(crate) fn spawn_remote_supervisor<R: tauri::Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(SUPERVISOR_TICK);
        let Some(state) = app.try_state::<AppState>() else { continue };
        // "Close all repos" ran: the app is on its way out and reconnecting would undo it.
        if state.is_quitting() {
            continue;
        }
        for host_id in state.remotes.due_reconnects(Instant::now()) {
            let app = app.clone();
            std::thread::spawn(move || {
                let result = connect_and_attach(&app, &host_id, false);
                app.state::<AppState>().remotes.reconnect_finished(&host_id, &result, Instant::now());
            });
        }
    });
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
    // A connect in flight finishes first (and marks the host wanted), so the user's disconnect wins.
    let lock = state.remotes.lock(host_id);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    state.remotes.unwant(host_id);
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
    record_sharing(app, host_id, sync_config(&session.channel, &config, host_id, &session.config_dir, &app_config_path(app)?)?)?;
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
    /// Where this Mac keeps the approval secrets of the daemons it started on this host.
    pub(crate) secrets_dir: PathBuf,
}

/// Waits before each automatic reconnect attempt; the last repeats.
const RECONNECT_DELAYS_SECS: [u64; 4] = [5, 10, 30, 60];

pub(crate) fn reconnect_delay(attempt: u32) -> Duration {
    Duration::from_secs(
        RECONNECT_DELAYS_SECS
            .get(attempt as usize)
            .copied()
            .unwrap_or(RECONNECT_DELAYS_SECS[RECONNECT_DELAYS_SECS.len() - 1]),
    )
}

/// A lost connection is retried, but not when retrying cannot help and would only hammer the host:
/// its key is unknown or changed, or it refused our key.
pub(crate) fn worth_retrying(error: &str) -> bool {
    !(error.starts_with(HOST_KEY_UNKNOWN) || error.contains("key changed") || error.contains("authentication failed"))
}

#[derive(Debug, Clone, Copy)]
struct Retry {
    attempt: u32,
    next_at: Instant,
    running: bool,
}

#[derive(Default)]
pub(crate) struct RemoteManager {
    statuses: Mutex<HashMap<String, RemoteStatus>>,
    sessions: Mutex<HashMap<String, std::sync::Arc<RemoteSession>>>,
    /// Hosts the user connected and has not disconnected: the ones to bring back when they drop.
    wanted: Mutex<HashSet<String>>,
    retries: Mutex<HashMap<String, Retry>>,
    /// One connect or disconnect at a time per host.
    locks: Mutex<HashMap<String, std::sync::Arc<Mutex<()>>>>,
}

impl RemoteManager {
    pub(crate) fn want(&self, host_id: &str) {
        self.wanted.lock().unwrap_or_else(|e| e.into_inner()).insert(host_id.to_string());
    }

    pub(crate) fn unwant(&self, host_id: &str) {
        self.wanted.lock().unwrap_or_else(|e| e.into_inner()).remove(host_id);
        self.retries.lock().unwrap_or_else(|e| e.into_inner()).remove(host_id);
    }

    pub(crate) fn lock(&self, host_id: &str) -> std::sync::Arc<Mutex<()>> {
        std::sync::Arc::clone(self.locks.lock().unwrap_or_else(|e| e.into_inner()).entry(host_id.to_string()).or_default())
    }

    /// Wanted hosts that are down and whose next attempt is due. A host seen down for the first
    /// time is marked `reconnecting` now and tried after the first delay. Marks each returned
    /// host as running, so a slow attempt is not started twice.
    pub(crate) fn due_reconnects(&self, now: Instant) -> Vec<String> {
        let wanted: Vec<String> = self.wanted.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect();
        let mut retries = self.retries.lock().unwrap_or_else(|e| e.into_inner());
        let mut due = Vec::new();
        for host_id in wanted {
            let status = self.status(&host_id);
            match status.state.as_str() {
                "connected" => {
                    retries.remove(&host_id);
                    continue;
                }
                "connecting" => continue,
                _ => {}
            }
            let retry = retries.entry(host_id.clone()).or_insert(Retry {
                attempt: 0,
                next_at: now + reconnect_delay(0),
                running: false,
            });
            // Just lost, or a manual attempt failed in between: either way it is being retried.
            if !retry.running && status.state != "reconnecting" {
                self.set(&host_id, "reconnecting", "Retrying automatically", status.error.clone());
            }
            if !retry.running && now >= retry.next_at {
                retry.running = true;
                due.push(host_id);
            }
        }
        due
    }

    /// Record how an automatic attempt went: success clears the backoff, a failure schedules the
    /// next attempt, and one that retrying cannot fix stops the retries.
    pub(crate) fn reconnect_finished(&self, host_id: &str, result: &Result<(), String>, now: Instant) {
        let Err(error) = result else {
            self.retries.lock().unwrap_or_else(|e| e.into_inner()).remove(host_id);
            return;
        };
        if !worth_retrying(error) {
            self.unwant(host_id);
            self.set(host_id, "failed", "", Some(error.clone()));
            return;
        }
        if let Some(retry) = self.retries.lock().unwrap_or_else(|e| e.into_inner()).get_mut(host_id) {
            retry.attempt += 1;
            retry.next_at = now + reconnect_delay(retry.attempt);
            retry.running = false;
        }
        self.set(host_id, "reconnecting", "Retrying automatically", Some(error.clone()));
    }

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
