//! task: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

use alinery_core::task_creation::MAX_ATTACHMENT_BYTES;

// The board projection lives in alinery-core so a remote host computes the same rows.
pub(crate) use alinery_core::board::list_tasks_checked as list_tasks_for_repo;

#[cfg(test)]
pub(crate) use alinery_core::board::read_task_checked as read_task;
#[cfg(test)]
pub(crate) use alinery_core::task_drafts::{branch_ref_conflicts, slugify};
#[cfg(test)]
pub(crate) use alinery_core::Task;

#[cfg(test)]
pub(crate) use alinery_core::attachments::MAX_CHAT_IMAGE_BYTES;
// The daemon's BlobService reads chat images now; the file-level original is the reference its conformance test runs.
#[cfg(test)]
pub(crate) use alinery_core::attachments::read_chat_image as read_chat_image_in;

// M0: prove one JS -> Rust -> JS command round-trip.
#[tauri::command]
pub(crate) fn ping(name: &str) -> String {
    format!("pong: {name}")
}

#[derive(Serialize, Debug)]
pub(crate) struct ChatFileStat {
    pub(crate) name: String,
    pub(crate) bytes: u64,
}

#[tauri::command]
pub(crate) fn chat_file_stat(path: String) -> Result<ChatFileStat, String> {
    let path = Path::new(&path);
    let meta = fs::metadata(path).map_err(|e| format!("{} — {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} — not a regular file", path.display()));
    }
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("{} — unreadable", path.display()))?
        .to_string();
    Ok(ChatFileStat { name, bytes: meta.len() })
}

/// Saves bytes the page read from a daemon (a canvas file's Save a copy) where the user picks. The body is the raw
/// bytes; `x-alinery-name` (JSON) is only the name the dialog starts with. Nothing is written without that choice.
#[tauri::command]
pub(crate) async fn save_file_dialog(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<bool, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_file_dialog takes a raw body".into());
    };
    let header = request.headers().get("x-alinery-name").and_then(|v| v.to_str().ok()).unwrap_or("\"file\"");
    let name: String = serde_json::from_str(header).map_err(|e| format!("bad x-alinery-name header: {e}"))?;
    let name = Path::new(&name).file_name().and_then(|s| s.to_str()).unwrap_or("file").to_string();
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let Some(target) = app.dialog().file().set_title("Save a copy").set_file_name(&name).blocking_save_file() else {
            return Ok(false);
        };
        let path = target.into_path().map_err(|e| e.to_string())?;
        fs::write(&path, bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("save file: {e}"))?
}

/// A local file's bytes, for the webview to upload through `BlobService` (the daemon never takes a path from the
/// client). The checks are the ones attachment copying always made: a regular file, 25 MB at most, a usable name.
#[tauri::command]
pub(crate) async fn read_local_file(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = Path::new(path.trim());
        let meta = fs::metadata(src).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("not a regular file".to_string());
        }
        if meta.len() > MAX_ATTACHMENT_BYTES {
            return Err("larger than 25 MB".to_string());
        }
        src.file_name()
            .and_then(|s| s.to_str())
            .and_then(alinery_core::safe_component)
            .ok_or("unusable file name")?;
        fs::read(src).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("read file: {e}"))?
}
