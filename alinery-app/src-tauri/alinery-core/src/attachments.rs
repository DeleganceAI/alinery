//! A task's attachments: files a person added to a task, stored under its artifacts directory and
//! deliberately invisible to artifact scans. Reading an image, resolving a file's path, and writing
//! a new attachment live in core so a remote host runs the same code a local repo does.

use crate::task_creation::{unique_attachment_name, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_SET_BYTES};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::Path;

// safe_component is pass-or-None: it rejects empty, any `..`, any separator and absolute
// paths, and never rewrites — the right guard for two user-supplied components.
pub fn attachment_path(repo: &Path, task_slug: &str, name: &str) -> Result<String, String> {
    let slug = crate::safe_component(task_slug).ok_or("invalid task slug")?;
    let name = crate::safe_component(name).ok_or_else(|| format!("invalid attachment name: {name}"))?;
    let path = crate::resolve_artifact_path(repo, &format!(".alinery/tasks/{slug}/artifacts/attachments/{name}"))?;
    if !path.is_file() {
        return Err(format!("attachment not found: {name}"));
    }
    Ok(path.to_string_lossy().to_string())
}

pub const MAX_CHAT_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

pub fn attachment_dir_bytes(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .filter(|meta| meta.is_file())
        .map(|meta| meta.len())
        .sum()
}

#[derive(Serialize, Deserialize)]
pub struct ChatImage {
    pub mime_type: String,
    pub data: String,
}

pub fn chat_image_mime(name: &str) -> Result<String, String> {
    let ext = Path::new(name).extension().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase());
    match ext.as_deref() {
        Some("png") => Ok("image/png".into()),
        Some("jpg") | Some("jpeg") => Ok("image/jpeg".into()),
        Some("gif") => Ok("image/gif".into()),
        Some("webp") => Ok("image/webp".into()),
        _ => Err(format!("{name} — not a chat image")),
    }
}

pub fn write_attachment_bytes_into(dir: &Path, file_name: &str, bytes: &[u8]) -> Result<String, String> {
    let base = crate::safe_component(file_name).ok_or_else(|| format!("invalid attachment name: {file_name}"))?;
    let len = bytes.len() as u64;
    if len > MAX_ATTACHMENT_BYTES {
        return Err(format!("{file_name} — larger than 25 MB"));
    }
    let batch_bytes = attachment_dir_bytes(dir);
    if batch_bytes + len > MAX_ATTACHMENT_SET_BYTES {
        return Err(format!("{file_name} — attachment set would exceed 100 MB"));
    }
    fs::create_dir_all(dir).map_err(|e| format!("{file_name} — {e}"))?;
    let Some(target) = unique_attachment_name(dir, base) else {
        return Err(format!("{file_name} — too many name collisions"));
    };
    fs::write(dir.join(&target), bytes).map_err(|e| format!("{file_name} — {e}"))?;
    Ok(target)
}

pub fn read_chat_image_file(path: &Path, name: &str) -> Result<ChatImage, String> {
    let meta = fs::metadata(path).map_err(|e| format!("{name} — {e}"))?;
    if meta.len() > MAX_CHAT_IMAGE_BYTES {
        return Err(format!("{name} — larger than 5 MB"));
    }
    let mime_type = chat_image_mime(name)?;
    let bytes = fs::read(path).map_err(|e| format!("{name} — {e}"))?;
    Ok(ChatImage {
        mime_type,
        data: crate::rpc_chunk::encode_base64(&bytes),
    })
}

pub fn read_chat_image(repo: &Path, task_slug: &str, name: &str) -> Result<ChatImage, String> {
    let path = attachment_path(repo, task_slug, name)?;
    read_chat_image_file(Path::new(&path), name)
}

pub fn read_attachment_image(repo: &Path, task_slug: &str, name: &str, node_id: Option<&str>) -> Result<Vec<u8>, String> {
    let path = match node_id {
        Some(id) => crate::artifact_node_path(repo, task_slug, id)?,
        None => attachment_path(repo, task_slug, name)?,
    };
    let path = Path::new(&path);
    let name = path.file_name().and_then(|name| name.to_str()).ok_or("invalid image name")?;
    chat_image_mime(name)?;
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err("Image must be a regular file no larger than 25 MB".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_ATTACHMENT_BYTES + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err("Image is larger than 25 MB".into());
    }
    Ok(bytes)
}

pub fn write_chat_attachment_bytes(repo: &Path, task_slug: &str, file_name: &str, bytes: &[u8]) -> Result<String, String> {
    let slug = crate::safe_component(task_slug).ok_or("invalid task slug")?;
    write_attachment_bytes_into(&crate::attachments_dir(repo, slug), file_name, bytes)
}
