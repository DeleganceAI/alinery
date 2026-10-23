//! task: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

use alinery_core::task_creation::{unique_attachment_name, CreateTaskReply, CreateTaskRequest, TaskAttachment, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_SET_BYTES};
pub(crate) use alinery_core::{write_task_unlocked, Task};
use std::io::Read;

// The board projection lives in alinery-core so a remote host computes the same rows.
pub(crate) use alinery_core::board::list_tasks_checked as list_tasks_for_repo;
pub(crate) use alinery_core::board::{board_tasks_from_loaded, BoardTask};

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskActivityRef {
    pub(crate) repo_path: String,
    pub(crate) task_slug: String,
}

#[cfg(test)]
pub(crate) use alinery_core::task_activity::TaskActivityStatus;
pub(crate) use alinery_core::task_activity::{task_activity_key, TaskActivitySummary};

pub(crate) fn branch_ref_conflicts(repo: &Path, candidate: &str) -> bool {
    let Ok(out) = git_cmd(repo).args(["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"]).output() else {
        return false;
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .any(|existing| alinery_core::branch_names_conflict(existing, candidate))
}

// Dedupe so dir, branch, and worktree path are all unique (-2, -3, …). `git
// worktree add -b` fails if the branch OR path already exists — check all three.
pub(crate) fn unique_slug(repo: &Path, base: &str) -> String {
    unique_slug_except(repo, base, "")
}

pub(crate) fn unique_slug_except(repo: &Path, base: &str, except: &str) -> String {
    let mut slug = base.to_string();
    let mut n = 2;
    while (task_dir(repo, &slug).exists() && slug != except) || worktrees_dir(repo).join(&slug).exists() || branch_ref_conflicts(repo, &slug) {
        slug = format!("{base}-{n}");
        n += 1;
    }
    slug
}

pub(crate) use alinery_core::board::read_task_checked as read_task;

#[cfg(test)]
pub(crate) use alinery_core::attachments::MAX_CHAT_IMAGE_BYTES;
pub(crate) use alinery_core::attachments::{
    attachment_dir_bytes, read_attachment_image as read_attachment_image_in, read_chat_image as read_chat_image_in, write_chat_attachment_bytes as write_chat_attachment_bytes_in,
    ChatImage,
};
pub(crate) use alinery_core::board::read_task_opt;
pub(crate) use alinery_core::task_creation::duplicate_task_package;

#[tauri::command]
pub(crate) async fn get_task(app: AppHandle, state: State<'_, AppState>, slug: String, repo_path: Option<String>) -> Result<Option<Task>, String> {
    match target_or_active_ref(&app, repo_path)? {
        RepoRef::Remote { host_id, path } => remote_call(&state, &host_id, RepoOp::GetTask { repo: path.into(), slug }),
        RepoRef::Local(repo) => read_task_opt(&repo, &slug),
    }
}

// M0: prove one JS -> Rust -> JS command round-trip.
#[tauri::command]
pub(crate) fn ping(name: &str) -> String {
    format!("pong: {name}")
}

#[tauri::command]
pub(crate) async fn create_task(state: State<'_, AppState>, request: CreateTaskRequest) -> Result<CreateTaskReply, String> {
    let daemon = repo_client(&state, &active_repo_ref()?)?;
    tauri::async_runtime::spawn_blocking(move || daemon.create_task(&request))
        .await
        .map_err(|error| format!("create task: {error}"))?
}

#[tauri::command]
pub(crate) async fn create_task_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, request: CreateTaskRequest) -> Result<CreateTaskReply, String> {
    let daemon = repo_client(&state, &target_repo_ref_for_app(&app, &repo_path)?)?;
    tauri::async_runtime::spawn_blocking(move || daemon.create_task(&request))
        .await
        .map_err(|error| format!("create task: {error}"))?
}

#[tauri::command]
pub(crate) fn rename_task<R: tauri::Runtime>(app: AppHandle<R>, state: State<'_, AppState>, repo_path: String, task_slug: String, name: String) -> Result<Task, String> {
    match target_repo_ref_for_app(&app, &repo_path)? {
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::RenameTask {
                repo: path.into(),
                slug: task_slug,
                name,
            },
        ),
        RepoRef::Local(repo) => {
            require_repo_owned(&state, &repo)?;
            alinery_core::rename_task(&repo, &task_slug, &name)
        }
    }
}

#[tauri::command]
pub(crate) async fn duplicate_task_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, source_slug: String) -> Result<CreateTaskReply, String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let daemon = repo_client(&state, &target)?;
    tauri::async_runtime::spawn_blocking(move || {
        // A remote task's files are read on its host; the copy itself is created by the host's daemon.
        let package = match target {
            RepoRef::Local(repo) => duplicate_task_package(&repo, &source_slug)?,
            RepoRef::Remote { host_id, path } => remote_call(&app.state::<AppState>(), &host_id, RepoOp::DuplicateTaskPackage { repo: path.into(), source_slug })?,
        };
        daemon.create_task(&package)
    })
    .await
    .map_err(|error| format!("duplicate task: {error}"))?
}

#[derive(Serialize, Default)]
pub(crate) struct PreparedTaskAttachments {
    attachments: Vec<TaskAttachment>,
    attachment_urls: Vec<String>,
    attachment_errors: Vec<String>,
}

pub(crate) fn prepare_task_attachments_in(entries: Vec<String>) -> PreparedTaskAttachments {
    let mut result = PreparedTaskAttachments::default();
    let mut bytes = 0u64;
    for entry in entries {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        if entry.starts_with("https://") || entry.starts_with("http://") {
            result.attachment_urls.push(entry.to_string());
            continue;
        }
        let loaded = (|| -> Result<TaskAttachment, String> {
            let path = Path::new(entry);
            let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
            if !metadata.is_file() {
                return Err("not a regular file".into());
            }
            if metadata.len() > MAX_ATTACHMENT_BYTES {
                return Err("larger than 25 MB".into());
            }
            if metadata.len() > MAX_ATTACHMENT_SET_BYTES - bytes {
                return Err("attachment set would exceed 100 MB".into());
            }
            let base = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(alinery_core::safe_component)
                .ok_or("unusable file name")?;
            let mut content = Vec::new();
            fs::File::open(path)
                .map_err(|error| error.to_string())?
                .take(MAX_ATTACHMENT_BYTES + 1)
                .read_to_end(&mut content)
                .map_err(|error| error.to_string())?;
            if content.len() as u64 > MAX_ATTACHMENT_BYTES {
                return Err("larger than 25 MB".into());
            }
            if content.len() as u64 > MAX_ATTACHMENT_SET_BYTES - bytes {
                return Err("attachment set would exceed 100 MB".into());
            }
            Ok(TaskAttachment {
                name: base.to_string(),
                bytes: content,
            })
        })();
        match loaded {
            Ok(attachment) => {
                bytes += attachment.bytes.len() as u64;
                result.attachments.push(attachment);
            }
            Err(error) => result.attachment_errors.push(format!("{entry} — {error}")),
        }
    }
    result
}

#[tauri::command]
pub(crate) async fn prepare_task_attachments(entries: Vec<String>) -> PreparedTaskAttachments {
    // Dropped files are read in full (up to 100 MB) before Create task continues.
    // A sync command does that read on the main thread.
    tauri::async_runtime::spawn_blocking(move || prepare_task_attachments_in(entries))
        .await
        .unwrap_or_else(|_| {
            let mut result = PreparedTaskAttachments::default();
            result.attachment_errors.push("could not read attachments".into());
            result
        })
}

// Infallible by construction: a bad attachment is data, never control flow. Runs strictly after
// the git block so it can never reach a rollback_task_dir call site.
pub(crate) fn copy_task_attachments(repo: &Path, slug: &str, entries: &[String]) -> (Vec<String>, Vec<String>, Vec<String>) {
    copy_attachments_into(&alinery_core::attachments_dir(repo, slug), entries)
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

pub(crate) fn copy_chat_attachments_in(repo: &Path, task_slug: &str, paths: &[String]) -> Result<CopyChatAttachmentsResult, String> {
    let slug = alinery_core::safe_component(task_slug).ok_or("invalid task slug")?;
    let (_urls, copied, failures) = copy_task_attachments(repo, slug, paths);
    Ok(CopyChatAttachmentsResult { copied, failures })
}

#[tauri::command]
pub(crate) fn copy_chat_attachments(state: State<'_, AppState>, task_slug: String, paths: Vec<String>) -> Result<CopyChatAttachmentsResult, String> {
    match active_repo_ref()? {
        RepoRef::Local(repo) => copy_chat_attachments_in(&repo, &task_slug, &paths),
        RepoRef::Remote { host_id, path } => copy_files_to_remote_attachments(&state, &host_id, &path, &task_slug, &paths),
    }
}

/// Send files from this machine to a remote task's attachments, one at a time. The same per-file
/// checks as a local copy run here; the host enforces the set limit and picks unique names.
pub(crate) fn copy_files_to_remote_attachments(state: &AppState, host_id: &str, repo: &str, task_slug: &str, paths: &[String]) -> Result<CopyChatAttachmentsResult, String> {
    alinery_core::safe_component(task_slug).ok_or("invalid task slug")?;
    Ok(send_files_to_host(paths, |file_name, data| {
        remote_call::<String>(
            state,
            host_id,
            RepoOp::WriteAttachment {
                repo: repo.into(),
                slug: task_slug.to_string(),
                file_name,
                data,
            },
        )
    }))
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
pub(crate) fn write_chat_attachment_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    task_slug: String,
    file_name: String,
    bytes: Vec<u8>,
    repo_path: Option<String>,
) -> Result<String, String> {
    match target_or_active_ref(&app, repo_path)? {
        RepoRef::Local(repo) => write_chat_attachment_bytes_in(&repo, &task_slug, &file_name, &bytes),
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::WriteAttachment {
                repo: path.into(),
                slug: task_slug,
                file_name,
                data: bytes,
            },
        ),
    }
}

#[tauri::command]
pub(crate) fn read_chat_image(state: State<'_, AppState>, task_slug: String, name: String) -> Result<ChatImage, String> {
    match active_repo_ref()? {
        RepoRef::Local(repo) => read_chat_image_in(&repo, &task_slug, &name),
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::ReadChatImage {
                repo: path.into(),
                slug: task_slug,
                name,
            },
        ),
    }
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

// Archived drafts require explicit restore. Autosave and create must treat their slugs as occupied.
fn is_reusable_draft(task: &Task) -> bool {
    task.draft && !task.archived
}

pub(crate) fn latest_draft_slug_with_name(repo: &Path, name: &str) -> Option<String> {
    let mut best: Option<(u64, String)> = None;
    let entries = fs::read_dir(tasks_dir(repo)).ok()?;
    for entry in entries.flatten() {
        if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }
        let slug = entry.file_name().to_string_lossy().to_string();
        let Ok(task) = read_task(repo, &slug) else {
            continue;
        };
        if !is_reusable_draft(&task) || task.name != name {
            continue;
        }
        if best
            .as_ref()
            .map(|(created, best_slug)| task.created > *created || (task.created == *created && slug > *best_slug))
            .unwrap_or(true)
        {
            best = Some((task.created, slug));
        }
    }
    best.map(|(_, slug)| slug)
}

pub(crate) fn draft_slug_for_name(repo: &Path, base: &str, name: &str) -> String {
    match read_task(repo, base) {
        Ok(t) if is_reusable_draft(&t) => base.to_string(),
        Ok(_) => latest_draft_slug_with_name(repo, name).unwrap_or_else(|| unique_slug(repo, base)),
        Err(_) if task_dir(repo, base).exists() => latest_draft_slug_with_name(repo, name).unwrap_or_else(|| unique_slug(repo, base)),
        Err(_) => latest_draft_slug_with_name(repo, name).unwrap_or_else(|| base.to_string()),
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct DraftAttachments {
    pub(crate) entries: Vec<String>,
    pub(crate) images: Vec<DraftImage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct DraftImage {
    pub(crate) name: String,
    #[serde(with = "alinery_core::rpc_chunk::base64_bytes")]
    pub(crate) bytes: Vec<u8>,
    pub(crate) mime_type: String,
}

fn validate_draft_attachments(attachments: &DraftAttachments) -> Result<(), String> {
    let mut total = 0;
    for image in &attachments.images {
        alinery_core::safe_component(&image.name).ok_or_else(|| format!("invalid attachment name: {}", image.name))?;
        let len = image.bytes.len() as u64;
        if len > MAX_ATTACHMENT_BYTES {
            return Err(format!("{} — larger than 25 MB", image.name));
        }
        if len > MAX_ATTACHMENT_SET_BYTES - total {
            return Err("attachment set would exceed 100 MB".into());
        }
        total += len;
    }
    Ok(())
}

pub(crate) fn read_draft_attachments_in(repo: &Path, slug: &str) -> Result<DraftAttachments, String> {
    let slug = alinery_core::safe_component(slug).ok_or("invalid draft slug")?;
    read_task(repo, slug)?;
    let path = task_dir(repo, slug).join("draft-attachments.json");
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(DraftAttachments::default()),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let attachments = serde_json::from_slice(&bytes).map_err(|error| format!("read {}: {error}", path.display()))?;
    validate_draft_attachments(&attachments)?;
    Ok(attachments)
}

#[tauri::command]
pub(crate) async fn read_draft_attachments_for_repo(app: AppHandle, repo_path: String, slug: String) -> Result<DraftAttachments, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    tauri::async_runtime::spawn_blocking(move || read_draft_attachments_in(&repo, &slug))
        .await
        .map_err(|error| error.to_string())?
}

pub(crate) fn write_draft_in_with_slug(
    repo: &Path,
    app_config: Option<&Path>,
    draft_slug: &str,
    task_slug: &str,
    name: String,
    description: String,
    evidence: String,
    linear_id: String,
    github_issue: String,
    playbook: alinery_core::playbook::PlaybookRef,
    harness: String,
    model: String,
    auto_advance: Option<Vec<String>>,
    step_models: Option<std::collections::BTreeMap<String, String>>,
    max_live_sessions: u32,
    branch_name: String,
    worktree_name: String,
    draft_base_ref: Option<String>,
    draft_attachments: Option<DraftAttachments>,
) -> Result<Task, String> {
    alinery_core::with_task_mutation_lock_waiting(repo, "write draft", alinery_core::TASK_MUTATION_CONTENTION_WAIT, || {
        write_draft_in_with_slug_unlocked(
            repo,
            app_config,
            draft_slug,
            task_slug,
            name,
            description,
            evidence,
            linear_id,
            github_issue,
            playbook,
            harness,
            model,
            auto_advance,
            step_models,
            max_live_sessions,
            branch_name,
            worktree_name,
            draft_base_ref,
            draft_attachments,
        )
    })
}

fn write_draft_in_with_slug_unlocked(
    repo: &Path,
    app_config: Option<&Path>,
    draft_slug: &str,
    task_slug: &str,
    name: String,
    description: String,
    evidence: String,
    linear_id: String,
    github_issue: String,
    playbook: alinery_core::playbook::PlaybookRef,
    harness: String,
    model: String,
    auto_advance: Option<Vec<String>>,
    step_models: Option<std::collections::BTreeMap<String, String>>,
    max_live_sessions: u32,
    branch_name: String,
    worktree_name: String,
    draft_base_ref: Option<String>,
    draft_attachments: Option<DraftAttachments>,
) -> Result<Task, String> {
    if max_live_sessions == 0 {
        return Err("maximum live sessions must be positive".into());
    }
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("task name is empty".into());
    }
    let base = slugify(&name);
    if base.is_empty() {
        return Err("task name is empty".into());
    }
    let requested_draft = draft_slug.trim();
    let slug = if requested_draft.is_empty() {
        draft_slug_for_name(repo, &base, &name)
    } else {
        let requested_draft = alinery_core::safe_component(requested_draft).ok_or_else(|| "invalid draft slug".to_string())?;
        match read_task(repo, requested_draft) {
            Ok(t) if is_reusable_draft(&t) => requested_draft.to_string(),
            Ok(_) => return Err("draft is archived or has already been promoted".into()),
            Err(error) => return Err(error),
        }
    };

    if let Some(attachments) = &draft_attachments {
        validate_draft_attachments(attachments)?;
    }
    fs::create_dir_all(tasks_dir(repo)).map_err(|e| e.to_string())?;
    fs::create_dir_all(task_dir(repo, &slug)).map_err(|e| e.to_string())?;

    let previous = read_task(repo, &slug).ok();
    let requested_slug = if task_slug.trim().is_empty() {
        previous
            .as_ref()
            .map(|task| task.requested_slug.clone())
            .filter(|slug| !slug.is_empty())
            .unwrap_or_else(|| slugify(&name))
    } else {
        let normalized = slugify(task_slug.trim());
        if normalized != task_slug.trim() {
            return Err("task slug must use lowercase letters, numbers, and single dashes".into());
        }
        normalized
    };
    let created = previous.as_ref().map(|t| t.created).unwrap_or_else(now_secs);
    let branch = branch_name.trim().to_string();
    let worktree = worktree_name.trim().to_string();
    let task = Task {
        name: name.clone(),
        slug: slug.clone(),
        requested_slug,
        branch,
        worktree,
        has_worktree: true,
        created,
        archived: false,
        pr_url: String::new(),
        linear_id: linear_id.trim().to_string(),
        github_issue: github_issue.trim().to_string(),
        playbook: String::new(),
        playbook_ref: Some(playbook.clone()),
        engine_version: 0,
        max_live_sessions,
        launch_defaults: alinery_core::execution::LaunchChoices { harness, model },
        auto_advance: auto_advance.unwrap_or_default(),
        auto_approve_all: false,
        step_models: step_models
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(key, value)| {
                let trimmed = value.trim();
                (!trimmed.is_empty()).then(|| (key, trimmed.to_string()))
            })
            .collect(),
        draft: true,
        draft_base_ref,
        parent_task: String::new(),
        active_subtask: String::new(),
        subtask_outcome: String::new(),
        related_tasks: Vec::new(),
        telemetry_id: previous
            .as_ref()
            .map(|task| task.telemetry_id.clone())
            .filter(|id| !id.is_empty())
            .unwrap_or_else(alinery_core::new_telemetry_id),
    };
    write_task_unlocked(repo, &task)?;
    if previous.is_none() {
        if let Some(path) = app_config {
            emit_at(
                path,
                alinery_core::TelemetryEvent::TaskDraftCreate {
                    source: alinery_core::TelemetrySource::App,
                    has_worktree: true,
                    playbook: playbook.key,
                    task_id: task.telemetry_id.clone(),
                },
            );
        }
    }

    let ticket = alinery_core::compose_ticket(&name, &description, &evidence, &[], &[], &[]);
    if !ticket.is_empty() {
        fs::create_dir_all(artifacts_dir(repo, &slug)).map_err(|e| e.to_string())?;
        let path = artifacts_dir(repo, &slug).join("00-ticket.md");
        if fs::read_to_string(&path).ok().as_deref() != Some(ticket.as_str()) {
            write_bytes_atomic(&path, ticket.as_bytes())?;
        }
    }
    if let Some(attachments) = draft_attachments {
        let bytes = serde_json::to_vec(&attachments).map_err(|error| error.to_string())?;
        write_bytes_atomic(&task_dir(repo, &slug).join("draft-attachments.json"), &bytes)?;
    }
    Ok(task)
}

#[tauri::command]
pub(crate) async fn write_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    task_slug: String,
    description: String,
    evidence: String,
    linear_id: String,
    github_issue: String,
    playbook: alinery_core::playbook::PlaybookRef,
    harness: String,
    model: String,
    auto_advance: Option<Vec<String>>,
    step_models: Option<std::collections::BTreeMap<String, String>>,
    max_live_sessions: u32,
    branch_name: String,
    worktree_name: String,
    draft_slug: String,
    draft_base_ref: Option<String>,
    draft_attachments: Option<DraftAttachments>,
) -> Result<Task, String> {
    let repo = require_owned_active_repo(&state)?;
    let app_config = app_config_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        write_draft_in_with_slug(
            &repo,
            Some(&app_config),
            &draft_slug,
            &task_slug,
            name,
            description,
            evidence,
            linear_id,
            github_issue,
            playbook,
            harness,
            model,
            auto_advance,
            step_models,
            max_live_sessions,
            branch_name,
            worktree_name,
            draft_base_ref,
            draft_attachments,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn write_draft_for_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
    task_slug: String,
    description: String,
    evidence: String,
    linear_id: String,
    github_issue: String,
    playbook: alinery_core::playbook::PlaybookRef,
    harness: String,
    model: String,
    auto_advance: Option<Vec<String>>,
    step_models: Option<std::collections::BTreeMap<String, String>>,
    max_live_sessions: u32,
    branch_name: String,
    worktree_name: String,
    draft_slug: String,
    draft_base_ref: Option<String>,
    draft_attachments: Option<DraftAttachments>,
) -> Result<Task, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    let app_config = app_config_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        write_draft_in_with_slug(
            &repo,
            Some(&app_config),
            &draft_slug,
            &task_slug,
            name,
            description,
            evidence,
            linear_id,
            github_issue,
            playbook,
            harness,
            model,
            auto_advance,
            step_models,
            max_live_sessions,
            branch_name,
            worktree_name,
            draft_base_ref,
            draft_attachments,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

// M6: remove a draft task directory entirely (archive is insufficient — leaves task.md).
pub(crate) fn delete_draft_in(repo: &Path, app_config: Option<&Path>, slug: &str) -> Result<(), String> {
    // Eager on purpose: the read must happen before the directory is removed below, so this one
    // cannot be deferred into the emit closure the way the other id lookups are.
    let telemetry_id = alinery_core::telemetry_id_for_task(repo, slug);
    alinery_core::with_task_mutation_lock_waiting(repo, "delete draft", alinery_core::TASK_MUTATION_CONTENTION_WAIT, || {
        let task = read_task(repo, slug)?;
        if !task.draft {
            return Err("not a draft".into());
        }
        let dir = task_dir(repo, slug);
        fs::remove_dir_all(&dir).map_err(|e| format!("remove draft {}: {e}", dir.display()))
    })?;
    if let Some(path) = app_config {
        emit_at(
            path,
            alinery_core::TelemetryEvent::TaskDraftDelete {
                source: alinery_core::TelemetrySource::App,
                task_id: telemetry_id,
            },
        );
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn delete_draft(app: AppHandle, state: State<'_, AppState>, slug: String) -> Result<(), String> {
    let repo = require_owned_active_repo(&state)?;
    delete_draft_in(&repo, Some(&app_config_path(&app)?), &slug)
}

#[tauri::command]
pub(crate) fn delete_draft_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, slug: String) -> Result<(), String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    delete_draft_in(&repo, Some(&app_config_path(&app)?), &slug)
}
// Scan `.alinery/tasks/*/task.md`. Returns archived too; the UI hides them.
#[tauri::command]
pub(crate) async fn list_tasks(app: AppHandle, state: State<'_, AppState>, repo_path: Option<String>) -> Result<Vec<Task>, String> {
    match target_or_active_ref(&app, repo_path)? {
        RepoRef::Remote { host_id, path } => remote_call(&state, &host_id, RepoOp::ListTasks { repo: path.into() }),
        RepoRef::Local(repo) => list_tasks_for_repo(&repo),
    }
}

#[cfg(test)]
pub(crate) fn board_tasks_for_repo(repo: &Path, repo_path: &str) -> Result<Vec<BoardTask>, String> {
    board_tasks_from_loaded(repo, repo_path, list_tasks_for_repo(repo)?)
}

#[tauri::command]
pub(crate) async fn list_board_tasks(app: AppHandle, state: State<'_, AppState>, all_repos: bool) -> Result<Vec<BoardTask>, String> {
    let repos = if all_repos { load_app_config(&app).known_repos } else { vec![active_repo_ref()?.uri()] };
    let mut out = vec![];
    for repo_path in dedupe_known_repos(repos) {
        match RepoRef::parse(&repo_path)? {
            RepoRef::Local(repo) => out.extend(board_tasks_from_loaded(&repo, &repo_path, list_tasks_for_repo(&repo)?)?),
            RepoRef::Remote { host_id, path } => match remote_call::<Vec<BoardTask>>(&state, &host_id, RepoOp::ListBoardTasks { repo: path.into() }) {
                // The host answered with its own paths; the board addresses the repo by its key.
                Ok(rows) => out.extend(rows.into_iter().map(|row| BoardTask {
                    repo_path: repo_path.clone(),
                    ..row
                })),
                // One unreachable host must not blank the other repos' boards.
                Err(_) if all_repos => {}
                Err(error) => return Err(error),
            },
        }
    }
    out.sort_by_key(|task| task.task.created);
    Ok(out)
}

#[tauri::command]
pub(crate) async fn list_task_activity(app: AppHandle, refs: Vec<TaskActivityRef>) -> HashMap<String, TaskActivitySummary> {
    let app_config = app_config_path(&app).ok();
    let app_config_identity = app_config.as_ref().map(|path| alinery_core::app_config_identity(path));
    // File reads plus a daemon query per repo (and ssh round trips for remote ones).
    tauri::async_runtime::spawn_blocking(move || list_task_activity_for_all(&app.state::<AppState>(), refs, app_config_identity.as_deref()))
        .await
        .unwrap_or_default()
}

pub(crate) fn archive_task_in(repo: &Path, slug: &str) -> Result<(), String> {
    alinery_core::archive_task_guarded(repo, slug)
}

pub(crate) fn restore_task_in(repo: &Path, slug: &str) -> Result<(), String> {
    alinery_core::restore_task(repo, slug)
}

async fn archive_task_off_thread(app: &AppHandle, repo: RepoRef, slug: String) -> Result<(), String> {
    let repo = match repo {
        RepoRef::Local(repo) => repo,
        // The host checks eligibility and flips the flag itself; the pre-archive backup and
        // telemetry are about this machine's copy of a repo, which a remote one is not.
        RepoRef::Remote { host_id, path } => {
            let app = app.clone();
            return tauri::async_runtime::spawn_blocking(move || remote_call::<()>(&app.state::<AppState>(), &host_id, RepoOp::ArchiveTask { repo: path.into(), slug }))
                .await
                .map_err(|e| format!("archive task: {e}"))?;
        }
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        alinery_core::ensure_task_can_archive(&repo, &slug)?;
        Ok::<_, String>((repo, slug))
    })
    .await;
    let (repo, slug) = result.map_err(|e| format!("archive eligibility task: {e}"))??;
    // Publish before the flag flips so a crash mid-archive still has a shot at the
    // pre-archive state. Best-effort: backup failure never blocks archival.
    publish_auto_backup(app, &repo, alinery_core::BackupTrigger::PreArchive);
    let result = tauri::async_runtime::spawn_blocking(move || {
        archive_task_in(&repo, &slug)?;
        Ok::<_, String>((repo, slug))
    })
    .await;
    let (repo, slug) = result.map_err(|e| format!("archive task: {e}"))??;
    emit_with(app, || alinery_core::TelemetryEvent::TaskArchive {
        source: alinery_core::TelemetrySource::App,
        task_id: alinery_core::telemetry_id_for_task(&repo, &slug),
    });
    Ok(())
}

// Archive flips a flag; the worktree and branch are untouched (removal is M5).
#[tauri::command]
pub(crate) async fn archive_task(app: AppHandle, state: State<'_, AppState>, slug: String) -> Result<(), String> {
    let repo = match active_repo_ref()? {
        RepoRef::Local(_) => RepoRef::Local(require_owned_active_repo(&state)?),
        remote => remote,
    };
    archive_task_off_thread(&app, repo, slug).await
}

#[tauri::command]
pub(crate) async fn archive_task_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, slug: String) -> Result<(), String> {
    let repo = target_repo_ref_for_app(&app, &repo_path)?;
    if let RepoRef::Local(local) = &repo {
        require_repo_owned(&state, local)?;
    }
    archive_task_off_thread(&app, repo, slug).await
}

#[tauri::command]
pub(crate) async fn restore_task_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, slug: String) -> Result<(), String> {
    let target = owned_target(&app, &state, &repo_path)?;
    // The pre-archive backup has no restore counterpart, so a remote repo is just the file flip on the host.
    let result = tauri::async_runtime::spawn_blocking(move || match target {
        RepoRef::Local(repo) => restore_task_in(&repo, &slug),
        RepoRef::Remote { host_id, path } => remote_call::<()>(&app.state::<AppState>(), &host_id, RepoOp::RestoreTask { repo: path.into(), slug }),
    })
    .await;
    result.map_err(|e| format!("restore task: {e}"))?
}

pub(crate) fn set_related_tasks_in(repo: &Path, slug: String, related: Vec<alinery_core::RelatedTaskRef>) -> Result<Task, String> {
    let task = read_task(repo, &slug)?;
    if task.archived {
        return Err("task is archived — read-only".into());
    }
    let self_path = repo.to_string_lossy();
    let mut cleaned: Vec<alinery_core::RelatedTaskRef> = Vec::new();
    for mut tag in related {
        tag.repo_path = tag.repo_path.trim().to_string();
        tag.slug = tag.slug.trim().to_string();
        tag.name = tag.name.trim().to_string();
        if tag.repo_path.is_empty() || tag.slug.is_empty() {
            return Err("related task is missing repo or slug".into());
        }
        if alinery_core::safe_component(&tag.slug) != Some(tag.slug.as_str()) {
            return Err(format!("invalid related-task slug '{}'", tag.slug));
        }
        if tag.repo_path == self_path && tag.slug == slug {
            return Err("cannot tag a task as related to itself".into());
        }
        if cleaned.iter().any(|existing| existing.repo_path == tag.repo_path && existing.slug == tag.slug) {
            continue;
        }
        if tag.name.is_empty() {
            if let Ok(other) = read_task(Path::new(&tag.repo_path), &tag.slug) {
                tag.name = other.name;
            }
        }
        cleaned.push(tag);
    }
    alinery_core::with_task_mutation_lock_waiting(repo, "set related tasks", alinery_core::TASK_MUTATION_CONTENTION_WAIT, || {
        let mut task = read_task(repo, &slug)?;
        if task.archived {
            return Err("task is archived — read-only".into());
        }
        task.related_tasks = cleaned;
        write_task_unlocked(repo, &task)?;
        alinery_core::sync_related_artifact_links(repo, &task.slug, &task.related_tasks)?;
        Ok(task)
    })
}

pub(crate) fn set_auto_approve_all_in(repo: &Path, slug: String, enabled: bool) -> Result<Task, String> {
    alinery_core::with_task_mutation_lock_waiting(repo, "set auto approve all", alinery_core::TASK_MUTATION_CONTENTION_WAIT, || {
        let mut task = read_task(repo, &slug)?;
        if task.archived {
            return Err("task is archived — read-only".into());
        }
        if task.draft {
            return Err("draft tasks have no execution to override".into());
        }
        if task.engine_version < 2 {
            return Err("pre-v2 tasks have no automatic completion to override".into());
        }
        // Completion reads execution.json, not task.md. Write the task first so a failed
        // execution write leaves the engine off rather than approving while the file says off.
        let mut state = alinery_core::execution::read_execution_state(repo, &slug)?;
        task.auto_approve_all = enabled;
        write_task_unlocked(repo, &task)?;
        if state.auto_approve_all != enabled {
            state.auto_approve_all = enabled;
            alinery_core::execution::write_execution_state_unlocked(repo, &slug, &mut state)?;
        }
        Ok(task)
    })
}

#[tauri::command]
pub(crate) fn set_auto_approve_all_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, slug: String, enabled: bool) -> Result<Task, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    set_auto_approve_all_in(&repo, slug, enabled)
}

#[tauri::command]
pub(crate) fn set_related_tasks_for_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    slug: String,
    related: Vec<alinery_core::RelatedTaskRef>,
) -> Result<Task, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    set_related_tasks_in(&repo, slug, related)
}
