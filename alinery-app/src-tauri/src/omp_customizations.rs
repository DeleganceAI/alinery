//! Direct installation inventory, not OMP's session discovery/precedence engine.
//! Formats verified against OMP v18.1.13: discovery/{builtin,helpers}.ts and cli/plugin-cli.ts.
use crate::*;
use std::io::Read;
use std::process::Stdio;

const INVENTORY_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_METADATA_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Serialize)]
pub(crate) struct OmpCustomization {
    pub name: String,
    pub kind: String,
    pub source: String,
    pub path: Option<String>,
}

#[derive(Debug, Default, Serialize)]
pub(crate) struct OmpCustomizations {
    pub items: Vec<OmpCustomization>,
    pub errors: Vec<String>,
}

impl OmpCustomizations {
    fn item(&mut self, name: String, kind: &str, source: String, path: Option<&Path>) {
        self.items.push(OmpCustomization {
            name,
            kind: kind.into(),
            source,
            path: path.map(|p| p.to_string_lossy().into_owned()),
        });
    }

    fn file_error(&mut self, path: &Path, reason: &str) {
        // Never surface parser diagnostics: YAML/JSON errors can quote credential values.
        self.errors.push(format!("{}: {reason}", path.display()));
    }
}

fn metadata_text(path: &Path) -> Result<Option<String>, &'static str> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("could not read metadata"),
    };
    if !metadata.is_file() || metadata.len() > MAX_METADATA_BYTES {
        return Err("metadata must be a regular file smaller than 1 MiB");
    }
    let mut text = String::new();
    fs::File::open(path)
        .and_then(|file| file.take(MAX_METADATA_BYTES + 1).read_to_string(&mut text))
        .map_err(|_| "could not read metadata")?;
    if text.len() as u64 > MAX_METADATA_BYTES {
        return Err("metadata exceeds 1 MiB");
    }
    Ok(Some(text))
}

fn metadata_json(path: &Path, inventory: &mut OmpCustomizations) -> Option<serde_json::Value> {
    match metadata_text(path) {
        Ok(Some(text)) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(value) if value.is_object() => Some(value),
            _ => {
                inventory.file_error(path, "malformed JSON metadata (expected an object)");
                None
            }
        },
        Ok(None) => None,
        Err(reason) => {
            inventory.file_error(path, reason);
            None
        }
    }
}

fn directory_entries(path: &Path, inventory: &mut OmpCustomizations) -> Vec<(PathBuf, fs::Metadata)> {
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(_) => {
            inventory.file_error(path, "could not list directory");
            return Vec::new();
        }
    };
    let mut paths = Vec::new();
    for entry in entries {
        match entry {
            Ok(entry) if !entry.file_name().to_string_lossy().starts_with('.') => match fs::metadata(entry.path()) {
                Ok(metadata) => paths.push((entry.path(), metadata)),
                Err(_) => inventory.file_error(&entry.path(), "could not inspect installed item (unreadable or broken link)"),
            },
            Ok(_) => {}
            Err(_) => inventory.file_error(path, "could not read directory entry"),
        }
    }
    paths.sort_by(|a, b| a.0.cmp(&b.0));
    paths
}

fn filename(path: &Path) -> String {
    path.file_name().unwrap_or_default().to_string_lossy().into_owned()
}

fn display_name(value: Option<&serde_json::Value>) -> Option<&str> {
    value.and_then(serde_json::Value::as_str).map(str::trim).filter(|name| !name.is_empty())
}

fn skill_name(text: &str) -> Result<Option<String>, &'static str> {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Ok(None);
    }
    let mut yaml = String::new();
    let mut closed = false;
    for line in lines {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        yaml.push_str(line);
        yaml.push('\n');
    }
    if !closed {
        return Err("unterminated skill frontmatter");
    }
    let metadata: serde_json::Value = serde_saphyr::from_str(&yaml).map_err(|_| "malformed YAML skill frontmatter")?;
    if !metadata.is_object() && !metadata.is_null() {
        return Err("skill frontmatter must be a mapping");
    }
    Ok(display_name(metadata.get("name")).map(str::to_owned))
}

fn scan_skills(agent_dir: &Path, inventory: &mut OmpCustomizations) {
    for (directory, metadata) in directory_entries(&agent_dir.join("skills"), inventory) {
        if !metadata.is_dir() {
            continue;
        }
        let path = directory.join("SKILL.md");
        let name = match metadata_text(&path) {
            Ok(None) => continue,
            Ok(Some(text)) => match skill_name(&text) {
                Ok(name) => name,
                Err(reason) => {
                    inventory.file_error(&path, reason);
                    None
                }
            },
            Err(reason) => {
                inventory.file_error(&path, reason);
                None
            }
        };
        // Installed, including disabled/incomplete skills; never a claim that a session loaded it.
        inventory.item(name.unwrap_or_else(|| filename(&directory)), "Skill", path.display().to_string(), Some(&path));
    }
}

fn scan_extensions(agent_dir: &Path, inventory: &mut OmpCustomizations) {
    for (path, metadata) in directory_entries(&agent_dir.join("extensions"), inventory) {
        if metadata.is_file() && matches!(path.extension().and_then(|ext| ext.to_str()), Some("ts" | "js")) {
            inventory.item(filename(&path), "Extension", path.display().to_string(), Some(&path));
        } else if metadata.is_dir() {
            let package_path = path.join("package.json");
            let errors_before = inventory.errors.len();
            let package = metadata_json(&package_path, inventory);
            let gemini_path = path.join("gemini-extension.json");
            let gemini = metadata_json(&gemini_path, inventory);
            let declared = package
                .as_ref()
                .and_then(|pkg| pkg.get("omp").or_else(|| pkg.get("pi")))
                .and_then(|manifest| manifest.get("extensions"));
            let has_declared = match declared {
                Some(serde_json::Value::Array(entries)) => {
                    if entries.iter().any(|entry| !entry.is_string()) {
                        inventory.file_error(&package_path, "extension paths must be strings");
                    }
                    entries.iter().any(serde_json::Value::is_string)
                }
                Some(_) => {
                    inventory.file_error(&package_path, "extension paths must be an array");
                    false
                }
                None => false,
            };
            if has_declared || path.join("index.ts").is_file() || path.join("index.js").is_file() || gemini.is_some() || inventory.errors.len() > errors_before {
                let name = display_name(package.as_ref().and_then(|pkg| pkg.get("name")))
                    .or_else(|| display_name(gemini.as_ref().and_then(|pkg| pkg.get("name"))))
                    .map(str::to_owned)
                    .unwrap_or_else(|| filename(&path));
                inventory.item(name, "Extension", path.display().to_string(), Some(&path));
            }
        }
    }
}

fn scan_mcp(agent_dir: &Path, inventory: &mut OmpCustomizations) {
    for name in ["mcp.json", ".mcp.json"] {
        let path = agent_dir.join(name);
        let Some(config) = metadata_json(&path, inventory) else { continue };
        let Some(servers) = config.get("mcpServers") else { continue };
        let Some(servers) = servers.as_object() else {
            inventory.file_error(&path, "mcpServers must be an object");
            continue;
        };
        for (name, definition) in servers {
            if !definition.is_object() {
                inventory.file_error(&path, "an MCP server definition must be an object");
            }
            // Only map keys and the source file leave this function. No expansion of env or commands.
            inventory.item(name.clone(), "MCP server", path.display().to_string(), Some(&path));
        }
    }
}

pub(crate) fn append_omp_plugin_inventory(stdout: &[u8], inventory: &mut OmpCustomizations) {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(stdout) else {
        inventory.errors.push("OMP plugin list returned malformed JSON; package discovery is incomplete.".into());
        return;
    };
    for (key, name_key, path_key, source) in [
        ("npm", "name", "path", "OMP CLI · npm package"),
        ("marketplace", "id", "installPath", "OMP CLI · user marketplace package"),
    ] {
        let Some(plugins) = value.get(key).and_then(serde_json::Value::as_array) else {
            inventory.errors.push(format!("OMP plugin list has no valid {key} array; package discovery is incomplete."));
            continue;
        };
        for plugin in plugins {
            if key == "marketplace" && plugin.get("scope").and_then(serde_json::Value::as_str) != Some("user") {
                if plugin.get("scope").and_then(serde_json::Value::as_str) != Some("project") {
                    inventory.errors.push("OMP plugin list contains a marketplace package with invalid scope.".into());
                }
                continue;
            }
            let records = if key == "marketplace" {
                match plugin.get("entries").and_then(serde_json::Value::as_array) {
                    Some(entries) if !entries.is_empty() => entries.as_slice(),
                    _ => {
                        inventory.errors.push("OMP plugin list contains malformed marketplace entries.".into());
                        continue;
                    }
                }
            } else {
                std::slice::from_ref(plugin)
            };
            for record in records {
                let path = record.get(path_key).and_then(serde_json::Value::as_str).map(Path::new).filter(|path| path.is_absolute());
                let name = display_name(plugin.get(name_key)).map(str::to_owned).or_else(|| path.map(filename));
                let Some(name) = name else {
                    inventory.errors.push("OMP plugin list contains a package without a name or local path.".into());
                    continue;
                };
                inventory.item(name, "Plugin package", source.into(), path);
            }
        }
    }
}

pub(crate) fn omp_customizations_from_paths(agent_dir: &Path, config_root: &Path, binary: Option<&Path>, timeout: Duration) -> OmpCustomizations {
    let mut inventory = OmpCustomizations::default();
    scan_skills(agent_dir, &mut inventory);
    scan_extensions(agent_dir, &mut inventory);
    scan_mcp(agent_dir, &mut inventory);
    if let Some(binary) = binary {
        let mut command = Command::new(binary);
        command
            .args(["plugin", "list", "--json"])
            .env_clear()
            .envs(alinery_core::omp_inherited_env())
            .env("PI_CODING_AGENT_DIR", agent_dir)
            .env("PI_CONFIG_DIR", config_root)
            .env("OMP_SKIP_SETUP", "1")
            .env("NO_COLOR", "1")
            // Never run discovery from the active repo; discard project marketplace records too.
            .current_dir("/")
            .stdin(Stdio::null());
        match crate::output_with_timeout(command, timeout) {
            Ok(output) if output.status.success() => {
                append_omp_plugin_inventory(&output.stdout, &mut inventory);
                if !output.stderr.is_empty() {
                    inventory.errors.push("OMP plugin list reported diagnostics; package discovery may be incomplete.".into());
                }
            }
            Ok(_) => inventory.errors.push("OMP plugin list failed; package discovery is incomplete.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => inventory.errors.push("OMP plugin list timed out; package discovery is incomplete.".into()),
            Err(_) => inventory.errors.push("Could not run the packaged OMP plugin list; package discovery is incomplete.".into()),
        }
    } else {
        inventory.errors.push("Packaged OMP is unavailable; package discovery is incomplete.".into());
    }
    // runner::materialise_extension injects a content-addressed index.ts + .mcp.json per launch.
    // It is not a persistent user customization, and there is no single stable file to open.
    inventory.item(
        "Alinery runner integration".into(),
        "Extension",
        "Provided by Alinery · injected at session launch".into(),
        None,
    );
    inventory.item("alinery".into(), "MCP server", "Provided by Alinery · injected at session launch".into(), None);
    inventory
        .items
        .sort_by(|a, b| (&a.kind, &a.name, &a.source, &a.path).cmp(&(&b.kind, &b.name, &b.source, &b.path)));
    inventory.errors.sort();
    inventory.errors.dedup();
    inventory
}

#[tauri::command]
pub(crate) async fn read_omp_customizations(app: AppHandle) -> Result<OmpCustomizations, String> {
    let app_config = app_config_path(&app).map_err(|_| "Could not resolve this Alinery installation's configuration directory.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let (agent_dir, config_root) = alinery_core::omp_home_dirs(&app_config);
        let binary = alinery_core::resolve_packaged_omp_path().ok();
        omp_customizations_from_paths(&agent_dir, &config_root, binary.as_deref(), INVENTORY_TIMEOUT)
    })
    .await
    .map_err(|_| "OMP customization discovery could not finish.".into())
}
