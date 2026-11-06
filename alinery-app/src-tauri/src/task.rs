//! task: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

use alinery_core::task_creation::{unique_attachment_name, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_SET_BYTES};

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

#[cfg(test)]
pub(crate) use alinery_core::attachments::MAX_CHAT_IMAGE_BYTES;
pub(crate) use alinery_core::attachments::{attachment_dir_bytes, read_attachment_image as read_attachment_image_in, read_chat_image as read_chat_image_in, ChatImage};

// M0: prove one JS -> Rust -> JS command round-trip.
#[tauri::command]
pub(crate) fn ping(name: &str) -> String {
    format!("pong: {name}")
}

/// Copy local files into `dir`. `http(s)` entries are recorded and never fetched.
/// Returns `(urls, copied names, failures)`.
pub(crate) fn copy_attachments_into(dir: &Path, entries: &[String]) -> (Vec<String>, Vec<String>, Vec<String>) {
    let (mut urls, mut copied, mut failures) = (vec![], vec![], vec![]);
    let mut batch_bytes: u64 = attachment_dir_bytes(dir);
    for entry in entries {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        if entry.starts_with("http://") || entry.starts_with("https://") {
            // Recorded verbatim, never fetched.
            urls.push(entry.to_string());
            continue;
        }
        let src = Path::new(entry);
        let meta = match fs::metadata(src) {
            Ok(m) => m,
            Err(e) => {
                failures.push(format!("{entry} — {e}"));
                continue;
            }
        };
        if !meta.is_file() {
            failures.push(format!("{entry} — not a regular file"));
            continue;
        }
        if meta.len() > MAX_ATTACHMENT_BYTES {
            failures.push(format!("{entry} — larger than 25 MB"));
            continue;
        }
        if batch_bytes + meta.len() > MAX_ATTACHMENT_SET_BYTES {
            failures.push(format!("{entry} — attachment set would exceed 100 MB"));
            continue;
        }
        let Some(base) = src.file_name().and_then(|s| s.to_str()).and_then(alinery_core::safe_component) else {
            failures.push(format!("{entry} — unusable file name"));
            continue;
        };
        if let Err(e) = fs::create_dir_all(dir) {
            failures.push(format!("{entry} — {e}"));
            continue;
        }
        let Some(target) = unique_attachment_name(dir, base) else {
            failures.push(format!("{entry} — too many name collisions"));
            continue;
        };
        match fs::copy(src, dir.join(&target)) {
            Ok(_) => {
                batch_bytes += meta.len();
                copied.push(target);
            }
            Err(e) => failures.push(format!("{entry} — {e}")),
        }
    }
    (urls, copied, failures)
}

#[derive(Serialize, Debug)]
pub(crate) struct ChatFileStat {
    pub(crate) name: String,
    pub(crate) bytes: u64,
}

#[derive(Serialize)]
pub(crate) struct CopyChatAttachmentsResult {
    pub(crate) copied: Vec<String>,
    pub(crate) failures: Vec<String>,
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

/// The per-file half of a copy to a host: read and check each local file, hand its bytes to `send`
/// (which returns the name the host stored it under), and collect what was copied and what failed.
pub(crate) fn send_files_to_host(paths: &[String], mut send: impl FnMut(String, Vec<u8>) -> Result<String, String>) -> CopyChatAttachmentsResult {
    let (mut copied, mut failures) = (vec![], vec![]);
    for entry in paths
        .iter()
        .map(|entry| entry.trim())
        .filter(|entry| !entry.is_empty() && !entry.starts_with("http://") && !entry.starts_with("https://"))
    {
        let src = Path::new(entry);
        let loaded = (|| -> Result<(String, Vec<u8>), String> {
            let meta = fs::metadata(src).map_err(|e| e.to_string())?;
            if !meta.is_file() {
                return Err("not a regular file".into());
            }
            if meta.len() > MAX_ATTACHMENT_BYTES {
                return Err("larger than 25 MB".into());
            }
            let base = src
                .file_name()
                .and_then(|s| s.to_str())
                .and_then(alinery_core::safe_component)
                .ok_or("unusable file name")?;
            Ok((base.to_string(), fs::read(src).map_err(|e| e.to_string())?))
        })();
        match loaded.and_then(|(file_name, data)| send(file_name, data)) {
            Ok(name) => copied.push(name),
            Err(error) => failures.push(format!("{entry} — {error}")),
        }
    }
    CopyChatAttachmentsResult { copied, failures }
}

#[tauri::command]
pub(crate) async fn read_chat_image<R: tauri::Runtime>(app: AppHandle<R>, task_slug: String, name: String) -> Result<ChatImage, String> {
    let target = active_repo_ref()?;
    off_main_thread("read chat image", move || match target {
        RepoRef::Local(repo) => read_chat_image_in(&repo, &task_slug, &name),
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::ReadChatImage {
                repo: path.into(),
                slug: task_slug,
                name,
            },
        ),
    })
    .await
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
