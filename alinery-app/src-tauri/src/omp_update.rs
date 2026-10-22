//! OMP config helpers still used by Settings: the config folder, the customization
//! prompt, and model roles. This version does not ship or update an OMP binary.
use crate::*;
use tauri_plugin_opener::OpenerExt;

pub(crate) fn normalize_omp_version(raw: &str) -> String {
    let trimmed = raw.trim();
    let without_prefix = trimmed.strip_prefix("omp/").unwrap_or(trimmed);
    without_prefix.trim().trim_start_matches('v').to_string()
}

#[tauri::command]
pub(crate) fn omp_agent_sessions_dir(app: AppHandle) -> Result<String, String> {
    let (agent_dir, _) = alinery_core::omp_home_dirs(&app_config_path(&app)?);
    Ok(agent_dir.join("sessions").to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) async fn open_omp_config_dir(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (agent_dir, _) = alinery_core::omp_home_dirs(&app_config_path(&app)?);
        fs::create_dir_all(&agent_dir).map_err(|e| format!("Cannot create OMP configuration directory: {e}"))?;
        app.opener().open_path(agent_dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "Could not open OMP configuration directory".to_string())?
}

// Only installation metadata enters this prompt; never read configuration or credential files.
pub(crate) fn render_omp_customization_prompt(app_config: &Path, identifier: &str, binary: &Path, version: &str) -> String {
    let (agent_dir, config_dir) = alinery_core::omp_home_dirs(app_config);
    let agent = shell_quote(&agent_dir.to_string_lossy());
    let config = shell_quote(&config_dir.to_string_lossy());
    let binary = shell_quote(&binary.to_string_lossy());
    format!(
        r#"Help me customize the official OMP packaged with this Alinery installation, not a separate OMP on PATH.

Alinery installation identifier: {identifier}
Alinery app configuration: {app_config}
Installed OMP version: {version}
OMP binary (shell quoted): {binary}
PI_CONFIG_DIR={config}
PI_CODING_AGENT_DIR={agent}

Inspect existing files locally first; do not print, copy, or upload secrets. Before changing a file, make a private backup preserving permissions. Make the smallest necessary edits, preserve unrelated settings, and verify syntax and behavior. Do not read or copy credential databases (including agent.db), tokens, headers, or secret environment values into your response.

Configuration roles verified against official OMP v18.1.13:
- PI_CONFIG_DIR is the isolated configuration root; PI_CODING_AGENT_DIR is this installation's agent directory.
- In the agent directory, config.yml holds OMP settings (including modelRoles); models.yml defines custom model providers/models. OMP also supports .yaml fallback and legacy JSON migration: inspect what exists before creating competing files.
- Preserve Alinery's managed providers.alinery entry in models.yml when adding custom/local providers. Do not replace the entire providers map or copy its credentials.
- skills/ contains instruction Markdown, typically skills/<name>/SKILL.md with YAML frontmatter. Loose skills need not be registered plugins.
- extensions/ contains executable OMP extensions (files or packages). Inspect their metadata/source without importing or executing them merely to inventory them.
- mcp.json and .mcp.json in the agent directory hold MCP server definitions under mcpServers. They may include secret headers, environment values, or arguments. Inspect only what the requested change requires; never echo those values.
- Plugin packages are separate from loose skills/extensions; an empty `plugin list` is not an empty customization inventory.
- Alinery injects its own extension package and repository-scoped .mcp.json at launch. Those are provided by Alinery, not user-installed files here; do not edit or replace the injected integration.

Confirm the installed version above still matches before editing. If it differs from v18.1.13, verify the schema/discovery behavior against that release's official source rather than assuming these roles or filenames are unchanged:
https://github.com/can1357/oh-my-pi/tree/v{version}/packages/coding-agent/src

Example read-only inspection commands (POSIX shell; exact installation paths):
(
  cd {agent} || exit
  env -i HOME="$HOME" PATH="$PATH" PI_CONFIG_DIR={config} PI_CODING_AGENT_DIR={agent} {binary} --version
  env -i HOME="$HOME" PATH="$PATH" PI_CONFIG_DIR={config} PI_CODING_AGENT_DIR={agent} {binary} plugin list --json
  find . -maxdepth 3 -type f \( -name 'config.yml' -o -name 'config.yaml' -o -name 'models.yml' -o -name 'models.yaml' -o -name '*mcp*' -o -name 'SKILL.md' -o -name 'package.json' \) -print
)
These commands list metadata/paths, not configuration contents. Do not use a broad config dump.

Alinery clears the session environment and only inherits an allowlist. Shell-exported provider credentials are NOT automatically inherited by Alinery sessions. Use the supported provider/account setup or an explicitly configured harness env map when needed; do not put secret values into this prompt.

Verify the requested change in a fresh OMP session launched by this Alinery installation. The inventory describes installed items, not what an existing session loaded. Project-specific and externally discovered customizations are outside its scope. Do not stop running sessions or repository daemons.

My requested change:
"#,
        app_config = app_config.display(),
    )
}

pub(crate) fn omp_customization_prompt_for(app_config: &Path, identifier: &str, binary: &Path) -> Result<String, String> {
    let (agent_dir, config_dir) = alinery_core::omp_home_dirs(app_config);
    let mut command = Command::new(binary);
    command.env_clear().envs(alinery_core::omp_inherited_env());
    command.env("PI_CONFIG_DIR", config_dir).env("PI_CODING_AGENT_DIR", agent_dir).arg("--version");
    let output = output_with_timeout(command, Duration::from_secs(5)).map_err(|_| "Could not read installed OMP version (failed or timed out)".to_string())?;
    let raw = std::str::from_utf8(&output.stdout).unwrap_or_default().trim();
    let version = normalize_omp_version(raw);
    // Version output is metadata, not a channel for arbitrary CLI/config contents.
    if !output.status.success() || is_newer(&version, &version).is_none() {
        return Err("Installed OMP returned an invalid version".into());
    }
    Ok(render_omp_customization_prompt(app_config, identifier, binary, &version))
}

#[tauri::command]
pub(crate) async fn omp_customization_prompt(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || omp_customization_prompt_for(&app_config_path(&app)?, &app.config().identifier, &alinery_core::resolve_packaged_omp_path()?))
        .await
        .map_err(|_| "Could not prepare OMP customization instructions".to_string())?
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

pub(crate) fn ensure_default_model_role(agent_dir: &Path, selector: &str) -> Result<(), String> {
    let mut roles = read_model_roles_from_agent_dir(agent_dir);
    if roles.contains_key("default") {
        return Ok(());
    }
    roles.insert("default".into(), selector.to_string());
    write_model_roles_to_agent_dir(agent_dir, &roles)
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
