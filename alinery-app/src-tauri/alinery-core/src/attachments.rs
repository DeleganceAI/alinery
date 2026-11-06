//! A task's attachments: files a person added to a task, stored under its artifacts directory and
//! deliberately invisible to artifact scans. Reading an image, resolving a file's path, and writing
//! a new attachment live in core so a remote host runs the same code a local repo does.

use serde::{Deserialize, Serialize};
use std::fs;
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
