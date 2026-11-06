//! task: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

use alinery_core::task_creation::MAX_ATTACHMENT_BYTES;

// The board projection lives in alinery-core so a remote host computes the same rows.
pub(crate) use alinery_core::board::list_tasks_checked as list_tasks_for_repo;

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskActivityRef {
    pub(crate) repo_path: String,
    pub(crate) task_slug: String,
}

pub(crate) use alinery_core::task_activity::task_activity_key;

pub(crate) use alinery_core::board::read_task_checked as read_task;
#[cfg(test)]
pub(crate) use alinery_core::task_drafts::{branch_ref_conflicts, slugify};
#[cfg(test)]
pub(crate) use alinery_core::Task;

pub(crate) use alinery_core::attachments::read_attachment_image as read_attachment_image_in;
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

#[tauri::command]
pub(crate) async fn read_attachment_image(
    app: AppHandle,
    state: State<'_, AppState>,
    task_slug: String,
    name: String,
    node_id: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let target = require_active_target(&state)?;
    tauri::async_runtime::spawn_blocking(move || match target {
        ActiveRepo::Local(repo) => read_attachment_image_in(&repo, &task_slug, &name, node_id.as_deref()),
        ActiveRepo::Remote { host_id, path } => remote_call::<alinery_core::repo_service::WireBytes>(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::ReadAttachmentImage {
                repo: path.into(),
                slug: task_slug,
                name,
                node_id,
            },
        )
        .map(|wire| wire.data),
    })
    .await
    .map_err(|error| error.to_string())?
    .map(tauri::ipc::Response::new)
}
