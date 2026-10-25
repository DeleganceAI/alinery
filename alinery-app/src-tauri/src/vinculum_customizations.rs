//! Installation inventory for the Vinculum agent directory.
//!
//! Skills, extensions, and MCP server names are read from disk and never executed.
//! Connection state and the daemon's own tools come from the `vinculum_customizations`
//! socket op, not from this scan. No command lines, env values, headers, or frontmatter
//! bodies are copied into the result. A parser error is a path plus a fixed reason.
use crate::*;
use std::io::{Read, Write};
use std::path::Component;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
#[cfg(test)]
use zip::write::SimpleFileOptions;
use zip::ZipArchive;
#[cfg(test)]
use zip::{CompressionMethod, ZipWriter};

const MAX_METADATA_BYTES: u64 = 1024 * 1024;
const ZIP_CAP: u64 = 25 * 1024 * 1024;
const FILE_CAP: u64 = 8 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 200;

#[derive(Debug, Serialize)]
pub(crate) struct VinculumCustomization {
    pub name: String,
    pub kind: String,
    pub source: String,
    pub path: Option<String>,
    /// Skills only. False when the model is not told about this file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offered: Option<bool>,
}

#[derive(Debug, Default, Serialize)]
pub(crate) struct VinculumCustomizations {
    pub items: Vec<VinculumCustomization>,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct SkillInstall {
    pub name: String,
    /// The skill directory already existed and `replace` was false. Nothing was written.
    pub exists: bool,
}

impl VinculumCustomizations {
    fn item(&mut self, name: String, kind: &str, source: String, path: Option<&Path>, offered: Option<bool>) {
        self.items.push(VinculumCustomization {
            name,
            kind: kind.into(),
            source,
            path: path.map(|p| p.to_string_lossy().into_owned()),
            offered,
        });
    }

    fn file_error(&mut self, path: &Path, reason: &str) {
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

fn metadata_json(path: &Path, inventory: &mut VinculumCustomizations) -> Option<serde_json::Value> {
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

fn directory_entries(path: &Path, inventory: &mut VinculumCustomizations) -> Vec<(PathBuf, fs::Metadata)> {
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

struct SkillDoc {
    name: Option<String>,
    description: Option<String>,
    /// False when frontmatter sets `disable-model-invocation`.
    model_invocation: bool,
}

fn parse_skill_text(text: &str) -> Result<Option<SkillDoc>, &'static str> {
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
    let disabled = match metadata.get("disable-model-invocation") {
        Some(serde_json::Value::Bool(value)) => *value,
        Some(serde_json::Value::String(value)) => value == "true",
        _ => false,
    };
    let model_invocation = !disabled;
    Ok(Some(SkillDoc {
        name: display_name(metadata.get("name")).map(str::to_owned),
        description: display_name(metadata.get("description")).map(str::to_owned),
        model_invocation,
    }))
}

fn skill_name_rule(name: &str) -> Result<(), &'static str> {
    if name.is_empty()
        || name.len() > 64
        || name.starts_with('-')
        || name.ends_with('-')
        || name.contains("--")
        || !name.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("A skill name must be lowercase letters, numbers, and hyphens, at most 64 characters, with no leading, trailing, or doubled hyphen.");
    }
    Ok(())
}

fn require_upload_skill(text: &str) -> Result<SkillDoc, String> {
    let Some(doc) = parse_skill_text(text).map_err(|reason| format!("A skill file must start with YAML frontmatter ({reason})."))? else {
        return Err("A skill file must start with YAML frontmatter.".into());
    };
    let name = doc.name.as_deref().ok_or("A skill needs a name.")?;
    skill_name_rule(name).map_err(str::to_owned)?;
    let description = doc.description.as_deref().ok_or("A skill needs a description.")?;
    if description.chars().count() > 1024 {
        return Err("A skill description must be at most 1024 characters.".into());
    }
    Ok(doc)
}

fn scan_skills(agent_dir: &Path, inventory: &mut VinculumCustomizations) {
    for (directory, metadata) in directory_entries(&agent_dir.join("skills"), inventory) {
        if !metadata.is_dir() {
            continue;
        }
        let path = directory.join("SKILL.md");
        let (name, offered) = match metadata_text(&path) {
            Ok(None) => continue,
            Ok(Some(text)) => match parse_skill_text(&text) {
                Ok(Some(doc)) => {
                    let offered = doc.name.is_some() && doc.description.is_some() && doc.model_invocation;
                    (doc.name, Some(offered))
                }
                Ok(None) => (None, Some(false)),
                Err(reason) => {
                    inventory.file_error(&path, reason);
                    (None, Some(false))
                }
            },
            Err(reason) => {
                inventory.file_error(&path, reason);
                (None, Some(false))
            }
        };
        inventory.item(name.unwrap_or_else(|| filename(&directory)), "Skill", path.display().to_string(), Some(&path), offered);
    }
}

fn scan_extensions(agent_dir: &Path, inventory: &mut VinculumCustomizations) {
    for (path, metadata) in directory_entries(&agent_dir.join("extensions"), inventory) {
        if metadata.is_file() && matches!(path.extension().and_then(|ext| ext.to_str()), Some("ts" | "js")) {
            inventory.item(filename(&path), "Extension", path.display().to_string(), Some(&path), None);
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
                inventory.item(name, "Extension", path.display().to_string(), Some(&path), None);
            }
        }
    }
}

fn scan_mcp(agent_dir: &Path, inventory: &mut VinculumCustomizations) {
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
            inventory.item(name.clone(), "MCP server", path.display().to_string(), Some(&path), None);
        }
    }
}

pub(crate) fn vinculum_customizations_from_dir(agent_dir: &Path) -> VinculumCustomizations {
    let mut inventory = VinculumCustomizations::default();
    scan_skills(agent_dir, &mut inventory);
    scan_extensions(agent_dir, &mut inventory);
    scan_mcp(agent_dir, &mut inventory);
    inventory
        .items
        .sort_by(|a, b| (&a.kind, &a.name, &a.source, &a.path).cmp(&(&b.kind, &b.name, &b.source, &b.path)));
    inventory.errors.sort();
    inventory.errors.dedup();
    inventory
}

fn skill_dir_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
        && Path::new(name).components().all(|component| matches!(component, Component::Normal(_)))
}

fn remove_skill_dir(skills: &Path, name: &str) -> Result<(), String> {
    if !skill_dir_name(name) {
        return Err("That skill directory is not inside skills/.".into());
    }
    let path = skills.join(name);
    let metadata = fs::symlink_metadata(&path).map_err(|_| "That skill is not installed.".to_string())?;
    if metadata.file_type().is_symlink() {
        return fs::remove_file(&path).map_err(|_| "Could not remove that skill.".to_string());
    }
    if !metadata.is_dir() {
        return Err("That skill is not installed.".into());
    }
    let real_skills = fs::canonicalize(skills).map_err(|_| "Could not remove that skill.".to_string())?;
    let real = fs::canonicalize(&path).map_err(|_| "Could not remove that skill.".to_string())?;
    if !real.starts_with(&real_skills) {
        return Err("That skill directory is not inside skills/.".into());
    }
    fs::remove_dir_all(&path).map_err(|_| "Could not remove that skill.".to_string())
}

fn place_skill(agent_dir: &Path, name: &str, staging: &Path, replace: bool) -> Result<SkillInstall, String> {
    let skills = agent_dir.join("skills");
    fs::create_dir_all(&skills).map_err(|_| "Could not create the skills directory.".to_string())?;
    let dest = skills.join(name);
    if dest.exists() || fs::symlink_metadata(&dest).is_ok() {
        if !replace {
            let _ = fs::remove_dir_all(staging);
            return Ok(SkillInstall {
                name: name.to_string(),
                exists: true,
            });
        }
        remove_skill_dir(&skills, name)?;
    }
    fs::rename(staging, &dest).map_err(|_| "Could not install that skill.".to_string())?;
    Ok(SkillInstall {
        name: name.to_string(),
        exists: false,
    })
}

fn install_markdown(agent_dir: &Path, source: &Path, replace: bool) -> Result<SkillInstall, String> {
    let text = fs::read_to_string(source).map_err(|_| "Could not read that skill file.".to_string())?;
    if text.len() as u64 > FILE_CAP {
        return Err("A skill file must be smaller than 8 MiB.".into());
    }
    let doc = require_upload_skill(&text)?;
    let name = doc.name.unwrap();
    let staging = agent_dir.join("skills").join(format!(".staging-{name}"));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|_| "Could not install that skill.".to_string())?;
    if fs::write(staging.join("SKILL.md"), text.as_bytes()).is_err() {
        let _ = fs::remove_dir_all(&staging);
        return Err("Could not install that skill.".into());
    }
    match place_skill(agent_dir, &name, &staging, replace) {
        Ok(result) => Ok(result),
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            Err(error)
        }
    }
}

fn zip_name_ok(name: &str) -> Result<(), &'static str> {
    if name.is_empty() || name.len() > 255 {
        return Err("a zip entry name is empty or too long");
    }
    if name.starts_with('/') || name.starts_with('\\') || (name.len() >= 2 && name.as_bytes()[1] == b':') {
        return Err("a zip entry is absolute");
    }
    for component in Path::new(name).components() {
        match component {
            Component::Normal(part) if !part.to_string_lossy().contains('\0') => {}
            Component::CurDir => {}
            _ => return Err("a zip entry escapes the skill directory"),
        }
    }
    Ok(())
}

fn allowed_skill_rel(rel: &str) -> bool {
    let rel = rel.trim_end_matches('/');
    if rel.is_empty() || rel == "SKILL.md" {
        return rel == "SKILL.md";
    }
    for prefix in ["scripts/", "references/", "assets/"] {
        if let Some(rest) = rel.strip_prefix(prefix) {
            return !rest.is_empty();
        }
    }
    false
}

fn skill_prefix(names: &[String]) -> Result<String, &'static str> {
    let files: Vec<&str> = names.iter().map(|name| name.trim_end_matches('/')).filter(|name| !name.is_empty()).collect();
    if files.iter().any(|name| *name == "SKILL.md") {
        if files.iter().any(|name| !allowed_skill_rel(name)) {
            return Err("This zip is not one skill.");
        }
        return Ok(String::new());
    }
    let mut root: Option<&str> = None;
    for name in &files {
        let Some((first, rest)) = name.split_once('/') else {
            return Err("This zip is not one skill.");
        };
        if rest.is_empty() {
            continue;
        }
        match root {
            None => root = Some(first),
            Some(prev) if prev != first => return Err("This zip is not one skill."),
            _ => {}
        }
        if !allowed_skill_rel(rest) {
            return Err("This zip is not one skill.");
        }
    }
    root.map(|root| format!("{root}/")).ok_or("This zip is not one skill.")
}

fn install_zip(agent_dir: &Path, source: &Path, replace: bool) -> Result<SkillInstall, String> {
    let compressed_len = fs::metadata(source).map_err(|_| "Could not read that zip.".to_string())?.len();
    if compressed_len > ZIP_CAP {
        return Err("This zip is larger than 25 MiB.".into());
    }
    let file = fs::File::open(source).map_err(|_| "Could not read that zip.".to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|_| "Could not read that zip.".to_string())?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err("This zip has more than 200 files.".into());
    }
    let mut names = Vec::new();
    let mut uncompressed = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|_| "Could not read that zip.".to_string())?;
        let name = entry.name().to_string();
        zip_name_ok(&name).map_err(|reason| format!("Could not install that skill: {reason}."))?;
        if entry.is_symlink() {
            return Err("A zip entry is a symlink or a hard link.".into());
        }
        uncompressed = uncompressed.saturating_add(entry.size());
        if entry.size() > FILE_CAP {
            return Err("A file in this zip is larger than 8 MiB.".into());
        }
        if uncompressed > ZIP_CAP {
            return Err("This zip unpacks to more than 25 MiB.".into());
        }
        if !entry.is_dir() {
            names.push(name);
        }
    }
    let prefix = skill_prefix(&names).map_err(str::to_owned)?;
    let skill_index = names
        .iter()
        .position(|name| name.trim_end_matches('/') == format!("{prefix}SKILL.md") || (prefix.is_empty() && name == "SKILL.md"));
    let Some(skill_index) = skill_index else {
        return Err("This zip is not one skill.".into());
    };
    let mut skill_text = String::new();
    {
        let entry = archive.by_name(&names[skill_index]).map_err(|_| "Could not read that zip.".to_string())?;
        entry
            .take(FILE_CAP + 1)
            .read_to_string(&mut skill_text)
            .map_err(|_| "Could not read that skill.".to_string())?;
    }
    if skill_text.len() as u64 > FILE_CAP {
        return Err("A file in this zip is larger than 8 MiB.".into());
    }
    let doc = require_upload_skill(&skill_text)?;
    let name = doc.name.clone().unwrap();
    let staging = agent_dir.join("skills").join(format!(".staging-{name}"));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|_| "Could not install that skill.".to_string())?;
    let extract = (|| {
        for zip_name in &names {
            let rel = zip_name.strip_prefix(prefix.as_str()).unwrap_or(zip_name);
            if rel.is_empty() || rel.ends_with('/') {
                continue;
            }
            let dest = staging.join(rel);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut entry = archive.by_name(zip_name).map_err(|error| std::io::Error::other(error.to_string()))?;
            let mut file = fs::File::create(&dest)?;
            let mut left = FILE_CAP + 1;
            let mut buf = [0u8; 8192];
            loop {
                let n = entry.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                if left < n as u64 {
                    return Err(std::io::Error::other("file cap"));
                }
                left -= n as u64;
                file.write_all(&buf[..n])?;
            }
        }
        Ok(())
    })();
    if extract.is_err() {
        let _ = fs::remove_dir_all(&staging);
        return Err("Could not install that skill.".into());
    }
    match place_skill(agent_dir, &name, &staging, replace) {
        Ok(result) => Ok(result),
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            Err(error)
        }
    }
}

pub(crate) fn install_vinculum_skill_at(agent_dir: &Path, source: &Path, replace: bool) -> Result<SkillInstall, String> {
    let ext = source.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "md" => install_markdown(agent_dir, source, replace),
        "zip" => install_zip(agent_dir, source, replace),
        _ => Err("Choose a .md or .zip skill.".into()),
    }
}

pub(crate) fn delete_vinculum_skill_at(agent_dir: &Path, name: &str) -> Result<(), String> {
    remove_skill_dir(&agent_dir.join("skills"), name)
}

pub(crate) fn render_vinculum_customization_prompt(app_config: &Path, identifier: &str) -> String {
    let (agent_dir, _) = alinery_core::vinculum_home_dirs(app_config);
    let agent = crate::shell_quote(&agent_dir.to_string_lossy());
    format!(
        r#"Help me customize the Vinculum harness in this Alinery installation. Its agent runtime is pi-durable, from Pi (@earendil-works/pi-durable 1.3.0). It is not OMP. There is no OMP binary to run. ~/.pi and ~/.omp are the wrong directories.

Alinery installation identifier: {identifier}
Alinery app configuration: {app_config}
Agent directory (shell quoted): {agent}

Inspect existing files locally first. Do not print, copy, or upload secrets. Back up a file before editing it. Make the smallest necessary edit. mcp.json may contain commands, env, and headers; do not echo those values. Do not read credential stores into the reply. Do not put a secret in the prompt. Provider sign-in is the Accounts list, not models.yml.

Edit only the agent directory above.
- Skills that sessions load live at skills/<name>/SKILL.md. The model is told the name, the description, and the path. It is not given the body. It reads the file with the read tool. Paths inside the skill are relative to that skill's directory.
- mcp.json and .mcp.json in that directory are user MCP servers. The daemon connects stdio and streamable HTTP. It does not do OAuth. The alinery key is reserved for the built-in server. Do not add a server and claim it replaced the built-in.
- Extensions under extensions/ are listed and not loaded. Do not add one and claim the session picked it up.
- The daemon's own tools are read, write, edit, bash, alinery_phase_complete, and alinery_set_session_name. They are not files. Do not look for them in the agent directory. A write to xd://alinery_phase_complete is the phase tool.

- File formats are Pi's, in packages/coding-agent/docs/ of earendil-works/pi (skills and MCP). Do not use an OMP repository or pin these instructions to an OMP release.

Example read-only inspection (POSIX shell; names only, not file contents):
(
  cd {agent} || exit
  find . -name 'SKILL.md' -o -name 'mcp.json' -o -name '.mcp.json' -o -name 'package.json'
)

Alinery clears the session environment. A key exported in the shell is not a Vinculum credential.

My requested change:
"#,
        app_config = app_config.display(),
    )
}

#[cfg(test)]
pub(crate) fn write_skill_zip(path: &Path, files: &[(&str, &str)], symlink: Option<(&str, u32)>) {
    let file = fs::File::create(path).unwrap();
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    for (name, body) in files {
        zip.start_file(*name, opts).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    }
    if let Some((name, _mode)) = symlink {
        zip.add_symlink(name, "target", opts).unwrap();
    }
    zip.finish().unwrap();
}

#[tauri::command]
pub(crate) async fn read_vinculum_customizations(app: AppHandle) -> Result<VinculumCustomizations, String> {
    let app_config = app_config_path(&app).map_err(|_| "Could not resolve this Alinery installation's configuration directory.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let (agent_dir, _) = alinery_core::vinculum_home_dirs(&app_config);
        vinculum_customizations_from_dir(&agent_dir)
    })
    .await
    .map_err(|_| "Vinculum customization discovery could not finish.".to_string())
}

#[tauri::command]
pub(crate) async fn open_vinculum_agent_dir(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (agent_dir, _) = alinery_core::vinculum_home_dirs(&app_config_path(&app)?);
        fs::create_dir_all(&agent_dir).map_err(|error| format!("Cannot create the Vinculum agent directory: {error}"))?;
        app.opener().open_path(agent_dir.to_string_lossy(), None::<&str>).map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "Could not open the Vinculum agent directory".to_string())?
}

#[tauri::command]
pub(crate) async fn vinculum_customization_prompt(app: AppHandle) -> Result<String, String> {
    let app_config = app_config_path(&app)?;
    let identifier = app.config().identifier.clone();
    Ok(render_vinculum_customization_prompt(&app_config, &identifier))
}

#[tauri::command]
pub(crate) async fn pick_vinculum_skill_dialog(app: AppHandle) -> Result<Option<String>, String> {
    let Some(file) = app.dialog().file().set_title("Choose a skill").add_filter("Skill", &["md", "zip"]).blocking_pick_file() else {
        return Ok(None);
    };
    Ok(Some(file.into_path().map_err(|error| error.to_string())?.to_string_lossy().into_owned()))
}

#[tauri::command]
pub(crate) async fn install_vinculum_skill(app: AppHandle, source_path: String, replace: bool) -> Result<SkillInstall, String> {
    let app_config = app_config_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (agent_dir, _) = alinery_core::vinculum_home_dirs(&app_config);
        fs::create_dir_all(&agent_dir).map_err(|error| format!("Cannot create the Vinculum agent directory: {error}"))?;
        install_vinculum_skill_at(&agent_dir, Path::new(&source_path), replace)
    })
    .await
    .map_err(|_| "Could not install that skill.".to_string())?
}

#[tauri::command]
pub(crate) async fn delete_vinculum_skill(app: AppHandle, name: String) -> Result<(), String> {
    let app_config = app_config_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (agent_dir, _) = alinery_core::vinculum_home_dirs(&app_config);
        delete_vinculum_skill_at(&agent_dir, &name)
    })
    .await
    .map_err(|_| "Could not remove that skill.".to_string())?
}
