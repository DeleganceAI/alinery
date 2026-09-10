//! omp_update: between-release GitHub poll + atomic alongside-binary replace.
//!
//! Not a wire change and not a daemon teardown origin. Live children keep the old
//! inode; the next spawn uses the renamed file. Triple → asset mapping is the same
//! two cases as `scripts/lib/omp.sh` `omp_release_asset_name`.
use crate::*;
use std::os::unix::fs::PermissionsExt;
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

const GITHUB_LATEST: &str = "https://api.github.com/repos/can1357/oh-my-pi/releases/latest";
const GITHUB_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct OmpRelease {
    pub version: String,
    pub asset_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct OmpUpdateStatus {
    pub installed: String,
    pub available: Option<OmpRelease>,
    pub checked_at: u64,
    /// The binary that will actually run -- or, when it does not resolve, the path we looked at.
    /// A version with no location cannot answer "which install am I looking at", which is the
    /// question anyone reading this panel is asking.
    #[serde(default)]
    pub binary_path: String,
    /// This install's isolated OMP config home (`PI_CODING_AGENT_DIR`). Prod, and every dev
    /// checkout, gets its own; credentials live in `agent.db` under here and nowhere else.
    #[serde(default)]
    pub config_dir: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

/// Keep in sync with `scripts/lib/omp.sh` `omp_release_asset_name`.
pub(crate) fn omp_github_asset_name() -> Option<&'static str> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        Some("omp-darwin-arm64")
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        Some("omp-linux-x64")
    }
    #[cfg(not(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_arch = "x86_64"))))]
    {
        None
    }
}

pub(crate) fn normalize_omp_version(raw: &str) -> String {
    let trimmed = raw.trim();
    let without_prefix = trimmed.strip_prefix("omp/").unwrap_or(trimmed);
    without_prefix.trim().trim_start_matches('v').to_string()
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub(crate) fn parse_github_omp_release(body: &[u8], asset_name: &str) -> Option<OmpRelease> {
    let release: GithubRelease = serde_json::from_slice(body).ok()?;
    let asset = release.assets.iter().find(|a| a.name == asset_name)?;
    Some(OmpRelease {
        version: release.tag_name,
        asset_url: asset.browser_download_url.clone(),
    })
}

pub(crate) fn evaluate_omp_update(installed_raw: &str, latest: Option<&OmpRelease>, now: u64) -> OmpUpdateStatus {
    let installed = installed_raw.trim().to_string();
    let available = latest.and_then(|release| {
        let candidate = normalize_omp_version(&release.version);
        let current = normalize_omp_version(&installed);
        (is_newer(&candidate, &current) == Some(true)).then(|| release.clone())
    });
    OmpUpdateStatus {
        installed,
        available,
        checked_at: now,
        binary_path: String::new(),
        config_dir: String::new(),
    }
}

fn version_stdout(path: &Path) -> String {
    Command::new(path)
        .arg("--version")
        .stderr(Stdio::null())
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default()
}

fn github_latest_url() -> String {
    std::env::var("ALINERY_OMP_RELEASE_API_URL").unwrap_or_else(|_| GITHUB_LATEST.to_string())
}

fn fetch_github_latest() -> Result<Vec<u8>, String> {
    let response = curl_request_with_timeouts(
        &github_latest_url(),
        &["User-Agent: Alinery".into(), "Accept: application/vnd.github+json".into()],
        None,
        Duration::from_secs(5),
        GITHUB_TIMEOUT,
    )?;
    Ok(response.body)
}

pub(crate) fn expected_sha256(sums_txt: &str, asset_name: &str) -> Option<String> {
    sums_txt.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        (name == asset_name).then(|| hash.to_string())
    })
}

/// Verify checksum then atomically replace `dest`. Unverified bytes never land at dest.
pub(crate) fn install_verified_omp(dest: &Path, asset_bytes: &[u8], sums_txt: &str, asset_name: &str) -> Result<(), String> {
    let want = expected_sha256(sums_txt, asset_name).ok_or_else(|| format!("SHA256SUMS.txt has no entry for {asset_name}"))?;
    let parent = dest.parent().ok_or_else(|| format!("OMP dest has no parent: {}", dest.display()))?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let stem = dest.file_name().unwrap_or_default().to_string_lossy();
    let tmp = parent.join(format!(".omp-new-{}-{stem}-{nonce}", std::process::id()));
    fs::write(&tmp, asset_bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    let got = sha256_file(&tmp);
    if !checksums_match(&got, &want) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("OMP checksum mismatch for {asset_name}"));
    }
    let mut perms = fs::metadata(&tmp).map_err(|e| e.to_string())?.permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&tmp, perms).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("replace {}: {e}", dest.display())
    })?;
    Ok(())
}

pub(crate) fn omp_update_status_now() -> OmpUpdateStatus {
    let resolved = alinery_core::resolve_packaged_omp_path();
    let installed = resolved.as_ref().map(|path| version_stdout(path)).unwrap_or_default();
    let latest = fetch_github_latest()
        .ok()
        .and_then(|body| omp_github_asset_name().and_then(|asset| parse_github_omp_release(&body, asset)));
    let mut status = evaluate_omp_update(&installed, latest.as_ref(), now_unix());
    // On failure the error already names the path it looked at, which is the useful half.
    status.binary_path = match &resolved {
        Ok(path) => path.display().to_string(),
        Err(error) => error.clone(),
    };
    status
}

#[tauri::command]
pub(crate) fn check_omp_update(app: AppHandle) -> OmpUpdateStatus {
    let mut status = omp_update_status_now();
    if let Ok(app_config) = app_config_path(&app) {
        let (agent_dir, _) = alinery_core::omp_home_dirs(&app_config);
        status.config_dir = agent_dir.display().to_string();
    }
    status
}

fn curl_download_to(url: &str, dest: &Path) -> Result<(), String> {
    let https_only = url.starts_with("https://");
    let mut config = format!(
        "url = \"{}\"\nsilent\nshow-error\nlocation\nconnect-timeout = 5.000\nmax-time = {:.3}\noutput = \"{}\"\n",
        crate::curl_config_quote(url),
        DOWNLOAD_TIMEOUT.as_secs_f64(),
        crate::curl_config_quote(&dest.display().to_string()),
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

fn sums_url_for_asset(asset_url: &str) -> Option<String> {
    let (prefix, _) = asset_url.rsplit_once('/')?;
    Some(format!("{prefix}/SHA256SUMS.txt"))
}

#[tauri::command]
pub(crate) fn update_omp(_app: AppHandle) -> Result<String, String> {
    let dest = alinery_core::resolve_packaged_omp_path()?;
    let asset_name = omp_github_asset_name().ok_or_else(|| "this host is not a shipped OMP triple".to_string())?;
    let body = fetch_github_latest()?;
    let release = parse_github_omp_release(&body, asset_name).ok_or_else(|| "GitHub latest release has no matching OMP asset".to_string())?;
    let sums_url = sums_url_for_asset(&release.asset_url).ok_or_else(|| "could not derive SHA256SUMS.txt URL".to_string())?;
    let scratch = dest.parent().unwrap_or(dest.as_path()).join(format!(".omp-fetch-{}", std::process::id()));
    fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    let asset_path = scratch.join(asset_name);
    let sums_path = scratch.join("SHA256SUMS.txt");
    let download = (|| {
        curl_download_to(&release.asset_url, &asset_path)?;
        curl_download_to(&sums_url, &sums_path)?;
        let bytes = fs::read(&asset_path).map_err(|e| e.to_string())?;
        let sums = fs::read_to_string(&sums_path).map_err(|e| e.to_string())?;
        install_verified_omp(&dest, &bytes, &sums, asset_name)
    })();
    let _ = fs::remove_dir_all(&scratch);
    download?;
    Ok(version_stdout(&dest))
}

#[tauri::command]
pub(crate) fn omp_agent_sessions_dir(app: AppHandle) -> Result<String, String> {
    let (agent_dir, _) = alinery_core::omp_home_dirs(&app_config_path(&app)?);
    Ok(agent_dir.join("sessions").to_string_lossy().into_owned())
}

fn omp_agent_config_yml(agent_dir: &Path) -> PathBuf {
    let yml = agent_dir.join("config.yml");
    if yml.is_file() {
        return yml;
    }
    let yaml = agent_dir.join("config.yaml");
    if yaml.is_file() {
        return yaml;
    }
    yml
}

/// Best-effort parse of a top-level `modelRoles:` map from OMP agent YAML.
pub(crate) fn parse_model_roles_yaml(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut in_block = false;
    for line in text.lines() {
        let trimmed = line.trim_end();
        if !in_block {
            let t = trimmed.trim_start();
            if let Some(rest) = t.strip_prefix("modelRoles:") {
                let rest = rest.trim();
                if rest.is_empty() {
                    in_block = true;
                    continue;
                }
                if rest == "{}" || rest == "null" || rest == "~" {
                    return out;
                }
            }
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if indent == 0 {
            break;
        }
        let body = trimmed.trim_start();
        if body.starts_with('-') {
            continue;
        }
        let Some((key, value)) = body.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let mut value = value.trim();
        if value.is_empty() {
            continue;
        }
        if (value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\'')) {
            value = &value[1..value.len() - 1];
        }
        if !key.is_empty() {
            out.insert(key.to_string(), value.to_string());
        }
    }
    out
}

fn strip_model_roles_yaml(text: &str) -> String {
    let mut out = String::new();
    let mut skipping = false;
    for line in text.lines() {
        let trimmed = line.trim_end();
        if !skipping {
            let t = trimmed.trim_start();
            if let Some(rest) = t.strip_prefix("modelRoles:") {
                let rest = rest.trim();
                if rest.is_empty() {
                    skipping = true;
                    continue;
                }
                // inline form — drop the whole line
                continue;
            }
            out.push_str(line);
            out.push('\n');
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if indent == 0 {
            skipping = false;
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

pub(crate) fn render_model_roles_yaml(existing: &str, roles: &HashMap<String, String>) -> String {
    let mut base = strip_model_roles_yaml(existing);
    while base.ends_with("\n\n") {
        base.pop();
    }
    if !base.is_empty() && !base.ends_with('\n') {
        base.push('\n');
    }
    if roles.is_empty() {
        return base;
    }
    if !base.is_empty() && !base.ends_with("\n\n") {
        if !base.ends_with('\n') {
            base.push('\n');
        }
        base.push('\n');
    }
    base.push_str("modelRoles:\n");
    let mut keys: Vec<_> = roles.keys().cloned().collect();
    keys.sort();
    for key in keys {
        if let Some(value) = roles.get(&key) {
            base.push_str(&format!("  {key}: {value}\n"));
        }
    }
    base
}

fn read_model_roles_from_agent_dir(agent_dir: &Path) -> HashMap<String, String> {
    let config = omp_agent_config_yml(agent_dir);
    if config.is_file() {
        if let Ok(text) = fs::read_to_string(&config) {
            let roles = parse_model_roles_yaml(&text);
            if !roles.is_empty() {
                return roles;
            }
        }
    }
    HashMap::new()
}

fn write_model_roles_to_agent_dir(agent_dir: &Path, roles: &HashMap<String, String>) -> Result<(), String> {
    fs::create_dir_all(agent_dir).map_err(|e| format!("create {}: {e}", agent_dir.display()))?;
    let path = omp_agent_config_yml(agent_dir);
    let existing = if path.is_file() {
        fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?
    } else {
        String::new()
    };
    let next = render_model_roles_yaml(&existing, roles);
    let tmp = path.with_extension("yml.tmp");
    fs::write(&tmp, next.as_bytes()).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename {}: {e}", path.display()))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn read_omp_model_roles(app: AppHandle) -> Result<HashMap<String, String>, String> {
    let (agent_dir, _) = alinery_core::omp_home_dirs(&app_config_path(&app)?);
    Ok(read_model_roles_from_agent_dir(&agent_dir))
}

#[tauri::command]
pub(crate) fn write_omp_model_roles(app: AppHandle, roles: HashMap<String, String>) -> Result<HashMap<String, String>, String> {
    let (agent_dir, _) = alinery_core::omp_home_dirs(&app_config_path(&app)?);
    write_model_roles_to_agent_dir(&agent_dir, &roles)?;
    Ok(roles)
}
