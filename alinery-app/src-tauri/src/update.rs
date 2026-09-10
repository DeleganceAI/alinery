//! update: self-update. See AGENTS.md for the module map.
//!
//! `check_update` curls `latest.json`, picks this build's target triple, and compares its
//! version against `CARGO_PKG_VERSION` with a pure semver-triple compare — never an Err,
//! so the frontend can poll it the same way `useDaemonStatus` polls `daemon_status`.
//! `download_update` re-verifies the offer, streams the zip to a process-scoped scratch
//! dir, checks origin/size/sha256, and extracts it with `ditto`. `apply_update` takes a
//! version (not a caller-supplied tree), re-verifies that scratch against a fresh
//! manifest, writes an embedded swap script (`assets/swap.sh`) plus a compile-time copy
//! of `scripts/lib/preflight.sh`, and spawns `/bin/bash` on it, detached — the helper owns
//! teardown via `preflight_gate`, so this module never asks the daemon to end sessions.
use crate::*;
use std::process::Stdio;

const DEFAULT_MANIFEST_URL: &str = "https://cdn.alinery.ai/latest.json";
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(10);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

#[cfg(all(target_arch = "aarch64", target_os = "macos"))]
const HOST_TRIPLE: &str = "aarch64-apple-darwin";
#[cfg(not(all(target_arch = "aarch64", target_os = "macos")))]
const HOST_TRIPLE: &str = "unsupported";

// src/update.rs -> src -> src-tauri -> alinery-app -> repo root. The shipped copy IS the
// repo's copy, at build time, so the two cannot drift.
const PREFLIGHT_SH: &str = include_str!("../../../scripts/lib/preflight.sh");
const SWAP_SH: &str = include_str!("../assets/swap.sh");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct UpdateRelease {
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub protocol_version: u32,
    pub published_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct UpdateStatus {
    pub current: String,
    pub available: Option<UpdateRelease>,
    pub checked_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct StagedUpdate {
    pub version: String,
    pub app_path: String,
    pub scratch_dir: String,
}

// Manifest on the wire (scripts/lib/cdn.sh writes it, this parses it). Unknown top-level
// and per-target fields are ignored by default (no `deny_unknown_fields`) — that is the
// forward-compat rule the design settled on: a client never errors on a manifest it does
// not fully understand.
#[derive(Debug, Clone, Deserialize)]
struct Manifest {
    #[serde(default)]
    targets: HashMap<String, UpdateRelease>,
}

/// `X.Y.Z` only — no `v` prefix, no pre-release/build suffix, no extra components.
/// `None` when either side does not parse, which the caller must treat as "no offer".
fn parse_semver_triple(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None; // trailing garbage, e.g. "0.11.0-beta" or "0.11.0.1"
    }
    Some((major, minor, patch))
}

/// `None` when either version fails to parse — an unparseable version is never an offer.
pub(crate) fn is_newer(candidate: &str, current: &str) -> Option<bool> {
    let candidate = parse_semver_triple(candidate)?;
    let current = parse_semver_triple(current)?;
    Some(candidate > current)
}

/// Pick this build's target out of the manifest. Missing triple or unparseable JSON body
/// both yield `None`, never an error — a client must degrade silently on a bad manifest.
pub(crate) fn parse_manifest(bytes: &[u8], triple: &str) -> Option<UpdateRelease> {
    let manifest: Manifest = serde_json::from_slice(bytes).ok()?;
    manifest.targets.get(triple).cloned()
}

/// The single decision `check_update` reports: given the manifest body already on hand,
/// is there a newer, parseable release for `triple`? `allowed` folds in both the
/// production-identity gate and the user's opt-out — false always means no offer, but
/// `current`/`checked_at` are still filled in so the frontend has something to show.
pub(crate) fn evaluate_update(current: &str, triple: &str, manifest_body: &[u8], now_unix: u64, allowed: bool) -> UpdateStatus {
    let available = if allowed {
        parse_manifest(manifest_body, triple).filter(|release| is_newer(&release.version, current) == Some(true) && release_ready(release))
    } else {
        None
    };
    UpdateStatus {
        current: current.to_string(),
        available,
        checked_at: now_unix,
    }
}

/// `.../Alinery.app/Contents/MacOS/Alinery` -> `.../Alinery.app`. `None` for anything that
/// does not have that exact shape — in particular a bare unix path, which means "not
/// running from an app bundle" (a `cargo run` dev build, or a relocated binary).
pub(crate) fn running_bundle(exe: &Path) -> Option<PathBuf> {
    let macos_dir = exe.parent()?;
    if macos_dir.file_name()? != "MacOS" {
        return None;
    }
    let contents_dir = macos_dir.parent()?;
    if contents_dir.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents_dir.parent()?;
    if bundle.extension()? != "app" {
        return None;
    }
    Some(bundle.to_path_buf())
}

/// A Homebrew cask's `.app` lives under a `Caskroom` symlink target; swapping it in place
/// would leave the cask receipt pointing at a version Homebrew never installed.
/// `current_exe()` may return the unresolvable `/Applications/Alinery.app` symlink, so
/// canonicalize before scanning — a failed canonicalize falls back to the raw path.
pub(crate) fn is_homebrew_cask(path: &Path) -> bool {
    let scan = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    scan.components().any(|c| c.as_os_str() == "Caskroom")
}

pub(crate) fn is_sha256_digest(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(crate) fn checksums_match(computed: &str, expected: &str) -> bool {
    is_sha256_digest(computed) && is_sha256_digest(expected) && computed.eq_ignore_ascii_case(expected)
}

fn cdn_base_url() -> String {
    std::env::var("ALINERY_CDN_BASE_URL").unwrap_or_else(|_| "https://cdn.alinery.ai".to_string())
}

/// Zip URLs must live under the CDN origin (or `ALINERY_CDN_BASE_URL` in tests). The
/// hash is same-document; this is the same-origin half of that integrity story.
pub(crate) fn release_url_allowed(url: &str) -> bool {
    let base = cdn_base_url();
    let base = base.trim_end_matches('/');
    url.starts_with(base) && url[base.len()..].starts_with('/')
}

pub(crate) fn release_ready(release: &UpdateRelease) -> bool {
    is_sha256_digest(&release.sha256) && release_url_allowed(&release.url) && release.size > 0
}

pub(crate) fn parse_df_k_available(stdout: &str) -> Option<u64> {
    let line = stdout.lines().find(|l| !l.is_empty() && !l.starts_with("Filesystem"))?;
    let avail_k: u64 = line.split_whitespace().nth(3)?.parse().ok()?;
    Some(avail_k.saturating_mul(1024))
}

fn available_bytes(path: &Path) -> Option<u64> {
    let out = Command::new("/bin/df").args(["-kP"]).arg(path).output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_df_k_available(&String::from_utf8_lossy(&out.stdout))
}

fn require_free_space(path: &Path, need: u64) -> Result<(), String> {
    match available_bytes(path) {
        Some(avail) if avail < need => Err(format!("not enough free space at {} (need {need} bytes)", path.display())),
        _ => Ok(()),
    }
}

pub(crate) fn path_is_under(child: &Path, parent: &Path) -> bool {
    let Ok(child) = fs::canonicalize(child) else {
        return false;
    };
    let Ok(parent) = fs::canonicalize(parent) else {
        return false;
    };
    child.starts_with(&parent)
}

fn process_scratch_dir() -> PathBuf {
    std::env::temp_dir().join(format!("alinery-update-{}", std::process::id()))
}

fn require_production() -> Result<(), String> {
    if is_production_identity() {
        Ok(())
    } else {
        Err("updates are only available in the production app".to_string())
    }
}

pub(crate) fn sha256_file(path: &Path) -> String {
    let Ok(out) = Command::new("/usr/bin/openssl").args(["dgst", "-sha256"]).arg(path).stderr(Stdio::null()).output() else {
        return String::new();
    };
    if !out.status.success() {
        return String::new();
    }
    String::from_utf8_lossy(&out.stdout).split_whitespace().last().unwrap_or_default().to_lowercase()
}

/// `ditto -x -k` extracts either straight into `extract_dir/Alinery.app` or, for a zip with
/// one wrapping directory, one level down — try both, in that order.
pub(crate) fn find_staged_app(extract_dir: &Path) -> Option<PathBuf> {
    let direct = extract_dir.join("Alinery.app");
    if direct.is_dir() {
        return Some(direct);
    }
    for entry in fs::read_dir(extract_dir).ok()?.flatten() {
        let candidate = entry.path().join("Alinery.app");
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    None
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn manifest_url() -> String {
    std::env::var("ALINERY_UPDATE_MANIFEST_URL").unwrap_or_else(|_| DEFAULT_MANIFEST_URL.to_string())
}

fn fetch_manifest(url: &str) -> Result<Vec<u8>, String> {
    Ok(curl_request_with_timeouts(url, &[], None, Duration::from_secs(5), MANIFEST_TIMEOUT)?.body)
}

/// Backend-side gate so a dev build can never offer to overwrite the production bundle:
/// only the production Tauri identity is allowed to check at all. Unset (should not
/// happen outside tests) is treated as not-production, i.e. refused.
fn is_production_identity() -> bool {
    EFFECTIVE_APP_IDENTIFIER.get().map(String::as_str) == Some(alinery_core::PRODUCTION_APP_IDENTIFIER)
}

/// The user's opt-out (`Settings -> Updates`). A settings load failure — no app.toml yet,
/// an unresolvable app-config dir — degrades to the same default the settings themselves
/// use: checking is on until someone turns it off.
fn update_check_enabled(app: &AppHandle) -> bool {
    app_config_path(app)
        .ok()
        .map(|path| alinery_core::load_global_settings(&path).updates.check_enabled)
        .unwrap_or(true)
}

/// Never `Err`: a network or parse failure must not be representable to the frontend, so it
/// degrades to "no update" the same way `useDaemonStatus` degrades to `OFFLINE`.
#[tauri::command]
pub(crate) fn check_update(app: AppHandle) -> UpdateStatus {
    let current = env!("CARGO_PKG_VERSION");
    let now = now_unix();
    let allowed = is_production_identity() && update_check_enabled(&app);
    if !allowed {
        return UpdateStatus {
            current: current.to_string(),
            available: None,
            checked_at: now,
        };
    }
    let body = fetch_manifest(&manifest_url()).unwrap_or_default();
    evaluate_update(current, HOST_TRIPLE, &body, now, true)
}

fn curl_download_file(url: &str, dest: &Path, max_bytes: u64) -> Result<(), String> {
    let https_only = url.starts_with("https://");
    let mut config = format!(
        "url = \"{}\"\nsilent\nshow-error\nlocation\nconnect-timeout = 5.000\nmax-time = {:.3}\nmax-filesize = {}\noutput = \"{}\"\n",
        curl_config_quote(url),
        DOWNLOAD_TIMEOUT.as_secs_f64(),
        max_bytes,
        curl_config_quote(&dest.display().to_string()),
    );
    if https_only {
        config.push_str("proto = \"=https\"\nproto-redir = \"=https\"\n");
    }
    let mut child = Command::new("curl")
        .args(["--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("start curl: {e}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "curl stdin unavailable".to_string())?
        .write_all(config.as_bytes())
        .map_err(|e| format!("write curl request: {e}"))?;
    let out = child.wait_with_output().map_err(|e| format!("finish curl: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

fn offered_release(version: &str) -> Result<UpdateRelease, String> {
    let current = env!("CARGO_PKG_VERSION");
    let body = fetch_manifest(&manifest_url())?;
    let release = parse_manifest(&body, HOST_TRIPLE)
        .filter(|release| is_newer(&release.version, current) == Some(true) && release_ready(release))
        .ok_or_else(|| "no update available for this build".to_string())?;
    if release.version != version {
        return Err(format!("requested version {version} is no longer the latest available ({})", release.version));
    }
    Ok(release)
}

fn extract_staged_app(release: &UpdateRelease, scratch_dir: &Path) -> Result<StagedUpdate, String> {
    let extract_dir = scratch_dir.join("extract");
    fs::create_dir_all(&extract_dir).map_err(|e| format!("create extract dir: {e}"))?;
    let zip_path = scratch_dir.join("update.zip");
    let status = Command::new("/usr/bin/ditto")
        .arg("-x")
        .arg("-k")
        .arg(&zip_path)
        .arg(&extract_dir)
        .status()
        .map_err(|e| format!("start ditto: {e}"))?;
    if !status.success() {
        return Err("failed to extract downloaded update".to_string());
    }
    let app_path = find_staged_app(&extract_dir).ok_or_else(|| "downloaded archive did not contain Alinery.app".to_string())?;
    if !app_path.join("Contents/MacOS").is_dir() {
        return Err("downloaded Alinery.app is missing Contents/MacOS".to_string());
    }
    if !path_is_under(&app_path, scratch_dir) {
        return Err("staged Alinery.app is outside the update scratch dir".to_string());
    }
    Ok(StagedUpdate {
        version: release.version.clone(),
        app_path: app_path.display().to_string(),
        scratch_dir: scratch_dir.display().to_string(),
    })
}

fn zip_matches_release(zip_path: &Path, release: &UpdateRelease) -> bool {
    let Ok(meta) = fs::metadata(zip_path) else {
        return false;
    };
    meta.len() == release.size && checksums_match(&sha256_file(zip_path), &release.sha256)
}

fn existing_valid_stage(release: &UpdateRelease, scratch_dir: &Path) -> Option<StagedUpdate> {
    if !zip_matches_release(&scratch_dir.join("update.zip"), release) {
        return None;
    }
    let app_path = find_staged_app(&scratch_dir.join("extract"))?;
    if !app_path.join("Contents/MacOS").is_dir() || !path_is_under(&app_path, scratch_dir) {
        return None;
    }
    Some(StagedUpdate {
        version: release.version.clone(),
        app_path: app_path.display().to_string(),
        scratch_dir: scratch_dir.display().to_string(),
    })
}

fn download_and_stage(release: &UpdateRelease, scratch_dir: &Path) -> Result<StagedUpdate, String> {
    if !release_ready(release) {
        return Err("update manifest entry is missing a valid url, sha256, or size".to_string());
    }
    require_free_space(scratch_dir, release.size.saturating_mul(3))?;
    let zip_path = scratch_dir.join("update.zip");
    if !zip_matches_release(&zip_path, release) {
        curl_download_file(&release.url, &zip_path, release.size).map_err(|e| format!("download update: {e}"))?;
        let got = fs::metadata(&zip_path).map_err(|e| format!("stat download: {e}"))?.len();
        if got != release.size {
            return Err(format!("downloaded file size {got} did not match manifest size {}", release.size));
        }
        if !checksums_match(&sha256_file(&zip_path), &release.sha256) {
            return Err("downloaded file failed checksum verification".to_string());
        }
    }
    extract_staged_app(release, scratch_dir)
}

#[tauri::command]
pub(crate) fn download_update(version: String) -> Result<StagedUpdate, String> {
    require_production()?;
    let release = offered_release(&version)?;
    let scratch_dir = process_scratch_dir();
    fs::create_dir_all(&scratch_dir).map_err(|e| format!("create scratch dir: {e}"))?;
    let staged = download_and_stage(&release, &scratch_dir);
    if staged.is_err() {
        let _ = fs::remove_dir_all(&scratch_dir);
    }
    staged
}

/// Probe writability by actually creating and removing a marker file — a `readonly()`
/// permission-bit check misses group/other/root-owned cases that matter on a real
/// `/Applications` install.
fn dir_is_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".alinery-update-write-test-{}", std::process::id()));
    match fs::File::create(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn write_executable_script(path: &Path, contents: &str) -> Result<(), String> {
    fs::write(path, contents).map_err(|e| format!("write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).map_err(|e| format!("chmod {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Writes the swap helper into the process-scoped scratch dir and spawns it detached.
/// Accepts a version, not a caller-supplied tree: re-fetches the manifest, re-hashes the
/// zip this process already staged (or re-downloads it), and refuses anything outside
/// `alinery-update-<pid>`. Never tears down a daemon itself — the helper owns that, via
/// `preflight_gate`. Returns as soon as the helper is spawned; the window's own destroy
/// is the frontend's job, not this command's.
#[tauri::command]
pub(crate) fn apply_update(version: String) -> Result<(), String> {
    require_production()?;
    let release = offered_release(&version)?;
    let scratch_dir = process_scratch_dir();
    fs::create_dir_all(&scratch_dir).map_err(|e| format!("create scratch dir: {e}"))?;
    let staged = match existing_valid_stage(&release, &scratch_dir) {
        Some(staged) => staged,
        None => download_and_stage(&release, &scratch_dir)?,
    };

    let app_path = PathBuf::from(&staged.app_path);
    if !path_is_under(&app_path, &scratch_dir) {
        return Err("staged Alinery.app is outside the update scratch dir".to_string());
    }

    let current_exe = std::env::current_exe().map_err(|e| format!("resolve running executable: {e}"))?;
    let dest = running_bundle(&current_exe).ok_or_else(|| "not running from an .app bundle".to_string())?;

    if is_homebrew_cask(&dest) {
        return Err("Alinery was installed via Homebrew; run `brew upgrade --cask alinery` instead".to_string());
    }

    let parent = dest.parent().ok_or_else(|| "running bundle has no parent directory".to_string())?;
    if !dir_is_writable(parent) {
        return Err(format!("{} is not writable; upgrading needs write access to install a new version", parent.display()));
    }
    if dest.is_dir() && !dir_is_writable(&dest) {
        return Err(format!("{} is not writable", dest.display()));
    }
    require_free_space(parent, release.size.saturating_mul(3))?;

    write_executable_script(&scratch_dir.join("preflight.sh"), PREFLIGHT_SH)?;
    let swap_path = scratch_dir.join("swap.sh");
    write_executable_script(&swap_path, SWAP_SH)?;

    // /bin/sh on macOS is bash-3.2 running in POSIX/`sh` compatibility mode, which
    // disables process substitution (`<(...)`) — `preflight.sh` uses that (and bash
    // arrays) and would fail to source under it, aborting the whole script under `set
    // -e` before it ever reaches `preflight_gate`. `scripts/install.sh` avoids this by
    // always running under real bash; do the same here.
    let mut command = Command::new("/bin/bash");
    command
        .arg(&swap_path)
        .arg(&dest)
        .arg(&app_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    alinery_core::daemon_client::configure_detached_process(&mut command);
    command.spawn().map(|_| ()).map_err(|e| format!("spawn swap helper: {e}"))
}
