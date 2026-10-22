//! Model-role helpers. They follow the Vinculum agent directory. This version does not
//! ship or update an OMP binary. The customization list and its prompt live in
//! `vinculum_customizations`.
use crate::*;

#[tauri::command]
pub(crate) fn omp_agent_sessions_dir(app: AppHandle) -> Result<String, String> {
    let (agent_dir, _) = alinery_core::vinculum_home_dirs(&app_config_path(&app)?);
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
    let (agent_dir, _) = alinery_core::vinculum_home_dirs(&app_config_path(&app)?);
    Ok(read_model_roles_from_agent_dir(&agent_dir))
}

#[tauri::command]
pub(crate) fn write_omp_model_roles(app: AppHandle, roles: HashMap<String, String>) -> Result<HashMap<String, String>, String> {
    let (agent_dir, _) = alinery_core::vinculum_home_dirs(&app_config_path(&app)?);
    write_model_roles_to_agent_dir(&agent_dir, &roles)?;
    Ok(roles)
}
