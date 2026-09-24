//! task: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

use alinery_core::task_creation::{CreateTaskReply, CreateTaskRequest, TaskAttachment, TaskPlaybookPackage};
pub(crate) use alinery_core::Task;
use std::io::Read;

#[derive(Serialize, Clone)]
pub(crate) struct BoardTask {
    #[serde(flatten)]
    pub(crate) task: Task,
    pub(crate) repo_path: String,
    pub(crate) session_count: usize,
    pub(crate) playbook_title: String,
    pub(crate) updated: u64,
    pub(crate) current_phase: String,
    pub(crate) current_step_title: String,
    pub(crate) latest_session_title: String,
    pub(crate) latest_session_column_key: String,
    pub(crate) current_column_key: String,
    pub(crate) current_column_title: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskActivityRef {
    pub(crate) repo_path: String,
    pub(crate) task_slug: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct TaskActivitySession {
    pub(crate) id: String,
    pub(crate) worktree: String,
    pub(crate) phase: String,
    pub(crate) harness: String,
    pub(crate) model: String,
    pub(crate) playbook: String,
    pub(crate) generic: bool,
    pub(crate) step_title: String,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskActivityStatus {
    Running,
    WaitingForInput,
    WaitingForApproval,
    Failed,
    Completed,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct TaskActivitySummary {
    pub(crate) status: Option<TaskActivityStatus>,
    pub(crate) active_session: Option<TaskActivitySession>,
}

pub(crate) fn task_activity_key(repo_path: &str, slug: &str) -> String {
    format!("{repo_path}:{slug}")
}

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

pub(crate) fn read_task(repo: &Path, slug: &str) -> Result<Task, String> {
    let p = task_dir(repo, slug).join("task.md");
    let s = fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))?;
    toml::from_str(&s).map_err(|e| format!("parse {}: {e}", p.display()))
}

// Ok(None): task.md missing (deleted, or never existed) — a drop-in for today's `?? null`.
// Err: task.md exists but will not parse — a real fault, not "no task." Neither existing
// read_task has this split (task.rs:133 errors on both; alinery-core/src/task.rs:25 returns
// None for both), so this needs its own thin body rather than reuse of either.
pub(crate) fn read_task_opt(repo: &Path, slug: &str) -> Result<Option<Task>, String> {
    let p = task_dir(repo, slug).join("task.md");
    match fs::read_to_string(&p) {
        Ok(s) => toml::from_str(&s).map(Some).map_err(|e| format!("parse {}: {e}", p.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", p.display())),
    }
}

#[tauri::command]
pub(crate) async fn get_task(app: AppHandle, slug: String, repo_path: Option<String>) -> Result<Option<Task>, String> {
    let repo = match repo_path {
        Some(path) => target_repo_for_app(&app, &path)?,
        None => active_repo()?,
    };
    read_task_opt(&repo, &slug)
}

pub(crate) fn write_task_unlocked(repo: &Path, task: &Task) -> Result<(), String> {
    let p = task_dir(repo, &task.slug).join("task.md");
    let s = toml::to_string(task).map_err(|e| e.to_string())?;
    write_bytes_atomic(&p, s.as_bytes()).map_err(|e| format!("write {}: {e}", p.display()))
}

// M0: prove one JS -> Rust -> JS command round-trip.
#[tauri::command]
pub(crate) fn ping(name: &str) -> String {
    format!("pong: {name}")
}

#[tauri::command]
pub(crate) async fn create_task(state: State<'_, AppState>, request: CreateTaskRequest) -> Result<CreateTaskReply, String> {
    let repo = require_owned_active_repo(&state)?;
    let daemon = state.daemon_for(&repo).ok_or("daemon not connected")?;
    tauri::async_runtime::spawn_blocking(move || daemon.create_task(&request))
        .await
        .map_err(|error| format!("create task: {error}"))?
}

#[tauri::command]
pub(crate) async fn create_task_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, request: CreateTaskRequest) -> Result<CreateTaskReply, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    let daemon = state.daemon_for(&repo).ok_or("daemon not connected")?;
    tauri::async_runtime::spawn_blocking(move || daemon.create_task(&request))
        .await
        .map_err(|error| format!("create task: {error}"))?
}

#[tauri::command]
pub(crate) fn rename_task<R: tauri::Runtime>(app: AppHandle<R>, state: State<'_, AppState>, repo_path: String, task_slug: String, name: String) -> Result<Task, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    alinery_core::rename_task(&repo, &task_slug, &name)
}

#[tauri::command]
pub(crate) async fn duplicate_task_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, source_slug: String) -> Result<CreateTaskReply, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    let daemon = state.daemon_for(&repo).ok_or("daemon not connected")?;
    tauri::async_runtime::spawn_blocking(move || daemon.create_task(&duplicate_task_package(&repo, &source_slug)?))
        .await
        .map_err(|error| format!("duplicate task: {error}"))?
}

pub(crate) fn duplicate_task_package(repo: &Path, source_slug: &str) -> Result<CreateTaskRequest, String> {
    let source_slug = alinery_core::safe_component(source_slug).ok_or("invalid source slug")?;
    let source = read_task(repo, source_slug)?;
    if source.draft {
        return Err("draft tasks cannot be duplicated".into());
    }
    if source.engine_version < 2 {
        return Err("pre-v2 task data cannot be duplicated into executable work".into());
    }
    let state = alinery_core::execution::read_execution_state(repo, source_slug)?;
    let source_definition = fs::read_to_string(alinery_core::execution::task_playbook_path(repo, source_slug)?).map_err(|error| error.to_string())?;
    if alinery_core::execution::definition_identity(source_definition.as_bytes()) != state.definition_identity {
        return Err("retained task definition integrity mismatch".into());
    }
    let dir = alinery_core::attachments_dir(repo, source_slug);
    let original_ticket = fs::read_to_string(artifact_file_path(repo, source_slug, "00-ticket.md")?).map_err(|error| error.to_string())?;
    let mut attachments = Vec::new();
    match fs::symlink_metadata(&dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("source attachments are not a directory".into());
            }
            for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                let name = entry.file_name().into_string().map_err(|_| "invalid attachment name")?;
                let name = alinery_core::safe_component(&name).ok_or("invalid attachment name")?.to_string();
                let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(format!("attachment '{name}' is not a regular file"));
                }
                attachments.push(TaskAttachment {
                    name,
                    bytes: fs::read(entry.path()).map_err(|error| error.to_string())?,
                });
            }
        }
    }
    attachments.sort_by(|left, right| left.name.cmp(&right.name));
    let generation = source
        .name
        .trim_end()
        .rsplit_once(" D+")
        .and_then(|(base, number)| number.parse::<u64>().ok().filter(|number| *number > 0).map(|number| (base, number)));
    let name = match generation.and_then(|(base, number)| number.checked_add(1).map(|next| (base, next))) {
        Some((base, next)) => format!("{base} D+{next}"),
        None => format!("{} D+1", source.name.trim_end()),
    };
    let identity_base = |value: &str| -> String {
        if generation.is_some() {
            if let Some((base, number)) = value.rsplit_once('-') {
                if number.parse::<u64>().is_ok() {
                    return base.to_string();
                }
            }
        }
        value.to_string()
    };
    let requested_slug = identity_base(&source.slug);
    let branch_name = identity_base(&source.branch);
    let worktree_name = Path::new(&source.worktree).file_name().and_then(|name| name.to_str()).map(identity_base);
    Ok(CreateTaskRequest {
        name,
        draft_slug: None,
        requested_slug: Some(requested_slug),
        description: String::new(),
        evidence: String::new(),
        original_ticket: Some(original_ticket),
        attachments,
        attachment_urls: Vec::new(),
        attachment_errors: Vec::new(),
        linear_id: source.linear_id,
        github_issue: source.github_issue,
        related_tasks: source.related_tasks,
        parent_task: String::new(),
        playbook: TaskPlaybookPackage {
            reference: state.reference,
            source: source_definition,
        },
        branch_name: Some(branch_name),
        worktree_name,
        base_ref: None,
        launch_defaults: source.launch_defaults,
        auto_advance_steps: Some(source.auto_advance),
        max_live_sessions: Some(source.max_live_sessions),
        start: true,
    })
}

#[derive(Serialize, Default)]
pub(crate) struct PreparedTaskAttachments {
    attachments: Vec<TaskAttachment>,
    attachment_urls: Vec<String>,
    attachment_errors: Vec<String>,
}

#[tauri::command]
pub(crate) fn prepare_task_attachments(entries: Vec<String>) -> PreparedTaskAttachments {
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
            let mut name = base.to_string();
            let mut suffix = 2u64;
            while result.attachments.iter().any(|attachment| attachment.name == name) {
                let stem = Path::new(base).file_stem().and_then(|stem| stem.to_str()).ok_or("unusable file name")?;
                name = match Path::new(base).extension().and_then(|extension| extension.to_str()) {
                    Some(extension) => format!("{stem}-{suffix}.{extension}"),
                    None => format!("{stem}-{suffix}"),
                };
                suffix = suffix.checked_add(1).ok_or("too many name collisions")?;
            }
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
            Ok(TaskAttachment { name, bytes: content })
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

pub(crate) const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
pub(crate) const MAX_ATTACHMENT_SET_BYTES: u64 = 100 * 1024 * 1024;
pub(crate) const MAX_CHAT_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

// Suffix goes before the extension so `trace.log` collides into `trace-2.log`, never
// `trace.log-2`. Probing is against the on-disk dir, so a promoted draft's pre-existing
// attachments are respected.
pub(crate) fn unique_attachment_name(dir: &Path, base: &str) -> Option<String> {
    if !dir.join(base).exists() {
        return Some(base.to_string());
    }
    let stem = Path::new(base).file_stem()?.to_str()?.to_string();
    let ext = Path::new(base).extension().and_then(|s| s.to_str()).map(|s| s.to_string());
    for n in 2..=99u32 {
        let candidate = match &ext {
            Some(ext) => format!("{stem}-{n}.{ext}"),
            None => format!("{stem}-{n}"),
        };
        if !dir.join(&candidate).exists() {
            return Some(candidate);
        }
    }
    None
}

fn attachment_dir_bytes(dir: &Path) -> u64 {
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

// Infallible by construction: a bad attachment is data, never control flow. Runs strictly after
// the git block so it can never reach a rollback_task_dir call site.
pub(crate) fn copy_task_attachments(repo: &Path, slug: &str, entries: &[String]) -> (Vec<String>, Vec<String>, Vec<String>) {
    let dir = alinery_core::attachments_dir(repo, slug);
    let (mut urls, mut copied, mut failures) = (vec![], vec![], vec![]);
    let mut batch_bytes: u64 = attachment_dir_bytes(&dir);
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
        if let Err(e) = fs::create_dir_all(&dir) {
            failures.push(format!("{entry} — {e}"));
            continue;
        }
        let Some(target) = unique_attachment_name(&dir, base) else {
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

#[derive(Serialize)]
pub(crate) struct ChatImage {
    pub(crate) mime_type: String,
    pub(crate) data: String,
}

fn chat_image_mime(name: &str) -> Result<String, String> {
    let ext = Path::new(name).extension().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase());
    match ext.as_deref() {
        Some("png") => Ok("image/png".into()),
        Some("jpg") | Some("jpeg") => Ok("image/jpeg".into()),
        Some("gif") => Ok("image/gif".into()),
        Some("webp") => Ok("image/webp".into()),
        _ => Err(format!("{name} — not a chat image")),
    }
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
pub(crate) fn copy_chat_attachments(task_slug: String, paths: Vec<String>) -> Result<CopyChatAttachmentsResult, String> {
    copy_chat_attachments_in(&active_repo()?, &task_slug, &paths)
}

pub(crate) fn write_chat_attachment_bytes_in(repo: &Path, task_slug: &str, file_name: &str, bytes: &[u8]) -> Result<String, String> {
    let slug = alinery_core::safe_component(task_slug).ok_or("invalid task slug")?;
    let base = alinery_core::safe_component(file_name).ok_or_else(|| format!("invalid attachment name: {file_name}"))?;
    let len = bytes.len() as u64;
    if len > MAX_ATTACHMENT_BYTES {
        return Err(format!("{file_name} — larger than 25 MB"));
    }
    let dir = alinery_core::attachments_dir(repo, slug);
    let batch_bytes = attachment_dir_bytes(&dir);
    if batch_bytes + len > MAX_ATTACHMENT_SET_BYTES {
        return Err(format!("{file_name} — attachment set would exceed 100 MB"));
    }
    fs::create_dir_all(&dir).map_err(|e| format!("{file_name} — {e}"))?;
    let Some(target) = unique_attachment_name(&dir, base) else {
        return Err(format!("{file_name} — too many name collisions"));
    };
    fs::write(dir.join(&target), bytes).map_err(|e| format!("{file_name} — {e}"))?;
    Ok(target)
}

#[tauri::command]
pub(crate) fn write_chat_attachment_bytes(task_slug: String, file_name: String, bytes: Vec<u8>) -> Result<String, String> {
    write_chat_attachment_bytes_in(&active_repo()?, &task_slug, &file_name, &bytes)
}

pub(crate) fn read_chat_image_in(repo: &Path, task_slug: &str, name: &str) -> Result<ChatImage, String> {
    let path = attachment_path_in(repo, task_slug, name)?;
    let meta = fs::metadata(&path).map_err(|e| format!("{name} — {e}"))?;
    if meta.len() > MAX_CHAT_IMAGE_BYTES {
        return Err(format!("{name} — larger than 5 MB"));
    }
    let mime_type = chat_image_mime(name)?;
    let bytes = fs::read(&path).map_err(|e| format!("{name} — {e}"))?;
    Ok(ChatImage {
        mime_type,
        data: alinery_core::rpc_chunk::encode_base64(&bytes),
    })
}

#[tauri::command]
pub(crate) fn read_chat_image(task_slug: String, name: String) -> Result<ChatImage, String> {
    read_chat_image_in(&active_repo()?, &task_slug, &name)
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
    max_live_sessions: u32,
    branch_name: String,
    worktree_name: String,
) -> Result<Task, String> {
    alinery_core::with_task_mutation_lock(repo, "write draft", || {
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
            max_live_sessions,
            branch_name,
            worktree_name,
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
    max_live_sessions: u32,
    branch_name: String,
    worktree_name: String,
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
        draft: true,
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
        fs::write(artifacts_dir(repo, &slug).join("00-ticket.md"), ticket).map_err(|e| e.to_string())?;
    }
    Ok(task)
}

#[tauri::command]
pub(crate) fn write_draft(
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
    max_live_sessions: u32,
    branch_name: String,
    worktree_name: String,
    draft_slug: String,
) -> Result<Task, String> {
    let repo = require_owned_active_repo(&state)?;
    write_draft_in_with_slug(
        &repo,
        Some(&app_config_path(&app)?),
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
        max_live_sessions,
        branch_name,
        worktree_name,
    )
}

#[tauri::command]
pub(crate) fn write_draft_for_repo(
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
    max_live_sessions: u32,
    branch_name: String,
    worktree_name: String,
    draft_slug: String,
) -> Result<Task, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    write_draft_in_with_slug(
        &repo,
        Some(&app_config_path(&app)?),
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
        max_live_sessions,
        branch_name,
        worktree_name,
    )
}

// M6: remove a draft task directory entirely (archive is insufficient — leaves task.md).
pub(crate) fn delete_draft_in(repo: &Path, app_config: Option<&Path>, slug: &str) -> Result<(), String> {
    // Eager on purpose: the read must happen before the directory is removed below, so this one
    // cannot be deferred into the emit closure the way the other id lookups are.
    let telemetry_id = alinery_core::telemetry_id_for_task(repo, slug);
    alinery_core::with_task_mutation_lock(repo, "delete draft", || {
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
pub(crate) fn list_tasks_for_repo(repo: &Path) -> Result<Vec<Task>, String> {
    let dir = tasks_dir(repo);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut tasks = vec![];
    for entry in fs::read_dir(&dir).map_err(|error| format!("read {}: {error}", dir.display()))? {
        let entry = entry.map_err(|error| format!("read {}: {error}", dir.display()))?;
        if !entry.path().join("task.md").exists() {
            continue;
        }
        if let Some(slug) = entry.file_name().to_str() {
            tasks.push(read_task(repo, slug).map_err(|error| format!("task {}: {error}", entry.path().display()))?);
        }
    }
    tasks.sort_by_key(|t| t.created);
    Ok(tasks)
}

// Scan `.alinery/tasks/*/task.md`. Returns archived too; the UI hides them.
#[tauri::command]
pub(crate) async fn list_tasks(app: AppHandle, repo_path: Option<String>) -> Result<Vec<Task>, String> {
    let repo = match repo_path {
        Some(path) => target_repo_for_app(&app, &path)?,
        None => active_repo()?,
    };
    list_tasks_for_repo(&repo)
}

pub(crate) fn retained_task_definition(repo: &Path, task: &Task) -> Result<Option<alinery_core::playbook::NormalizedPlaybook>, String> {
    if task.draft || task.engine_version < 2 {
        return Ok(None);
    }
    // Display uses the task-owned snapshot, never a live owner or the mutable library.
    // The shared reader checks both the stored state and the retained source's integrity.
    saved_task_execution_for(repo, &task.slug)
        .map(|execution| Some(execution.definition))
        .map_err(|error| format!("task {}: {error}", task_dir(repo, &task.slug).display()))
}

pub(crate) fn is_primary_playbook_session(_repo: &Path, task: &Task, session: &SessionMeta) -> bool {
    !session.generic
        && if task.engine_version >= 2 {
            !session.execution_id.is_empty()
        } else {
            session.playbook == task.playbook
        }
}

pub(crate) fn task_updated_at(repo: &Path, task: &Task, sessions: &[SessionMeta]) -> u64 {
    let mut updated = task.created;
    if let Some(ts) = file_mtime_secs(task_dir(repo, &task.slug).join("task.md")) {
        updated = updated.max(ts);
    }
    if let Some(ts) = dir_latest_mtime_secs(sessions_dir(repo, &task.slug)) {
        updated = updated.max(ts);
    }
    if let Some(ts) = dir_latest_mtime_secs(artifacts_dir(repo, &task.slug)) {
        updated = updated.max(ts);
    }
    for session in sessions {
        updated = updated.max(session.created);
    }
    updated
}

pub(crate) fn board_task(repo: &Path, repo_path: &str, task: Task) -> Result<BoardTask, String> {
    let definition = retained_task_definition(repo, &task)?;
    let sessions = list_sessions_for_repo(repo, &task.slug)?;
    let live: Vec<&SessionMeta> = sessions.iter().filter(|session| !session.archived).collect();
    let current_phase = live
        .iter()
        .rev()
        .find(|session| is_primary_playbook_session(repo, &task, session))
        .map(|session| session.phase.clone())
        .unwrap_or_default();
    let title = |phase: &str| {
        definition
            .as_ref()
            .and_then(|definition| definition.step.iter().find(|step| step.key == phase))
            .map(|step| step.title.clone())
            .unwrap_or_else(|| phase.to_string())
    };
    let current_step_title = title(&current_phase);
    let latest_session_title = if task.draft {
        "Draft".into()
    } else {
        live.last()
            .map(|session| if session.generic { "Generic".into() } else { title(&session.phase) })
            .unwrap_or_else(|| "No sessions".into())
    };
    let updated = task_updated_at(repo, &task, &sessions);
    let playbook_title = definition.as_ref().map(|definition| definition.title.clone()).unwrap_or_else(|| task.playbook.clone());
    Ok(BoardTask {
        task,
        repo_path: repo_path.into(),
        session_count: live.len(),
        playbook_title,
        updated,
        current_phase,
        current_step_title,
        latest_session_title,
        latest_session_column_key: String::new(),
        current_column_key: String::new(),
        current_column_title: String::new(),
    })
}

fn board_tasks_from_loaded(repo: &Path, repo_path: &str, tasks: Vec<Task>) -> Result<Vec<BoardTask>, String> {
    alinery_core::validate_task_relationship_fields(
        tasks
            .iter()
            .map(|task| (task.slug.as_str(), task.parent_task.as_str(), task.active_subtask.as_str(), task.archived)),
    )?;
    tasks.into_iter().map(|task| board_task(repo, repo_path, task)).collect()
}

#[cfg(test)]
pub(crate) fn board_tasks_for_repo(repo: &Path, repo_path: &str) -> Result<Vec<BoardTask>, String> {
    board_tasks_from_loaded(repo, repo_path, list_tasks_for_repo(repo)?)
}

#[tauri::command]
pub(crate) async fn list_board_tasks(app: AppHandle, all_repos: bool) -> Result<Vec<BoardTask>, String> {
    let repos = if all_repos {
        load_app_config(&app).known_repos
    } else {
        vec![active_repo()?.to_string_lossy().to_string()]
    };
    let mut out = vec![];
    for repo_path in dedupe_known_repos(repos) {
        let repo = PathBuf::from(&repo_path);
        out.extend(board_tasks_from_loaded(&repo, &repo_path, list_tasks_for_repo(&repo)?)?);
    }
    out.sort_by_key(|task| task.task.created);
    Ok(out)
}

#[tauri::command]
pub(crate) async fn list_task_activity(app: AppHandle, refs: Vec<TaskActivityRef>) -> HashMap<String, TaskActivitySummary> {
    let app_config = app_config_path(&app).ok();
    let app_config_identity = app_config.as_ref().map(|path| alinery_core::app_config_identity(path));
    list_task_activity_for_refs(&refs, app_config_identity.as_deref())
}

pub(crate) fn archive_task_in(repo: &Path, slug: &str) -> Result<(), String> {
    alinery_core::archive_task_guarded(repo, slug)
}

pub(crate) fn restore_task_in(repo: &Path, slug: &str) -> Result<(), String> {
    alinery_core::restore_task(repo, slug)
}

async fn archive_task_off_thread(app: &AppHandle, repo: PathBuf, slug: String) -> Result<(), String> {
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
    let repo = require_owned_active_repo(&state)?;
    archive_task_off_thread(&app, repo, slug).await
}

#[tauri::command]
pub(crate) async fn archive_task_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, slug: String) -> Result<(), String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    archive_task_off_thread(&app, repo, slug).await
}

#[tauri::command]
pub(crate) async fn restore_task_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, slug: String) -> Result<(), String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    let result = tauri::async_runtime::spawn_blocking(move || restore_task_in(&repo, &slug)).await;
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
    alinery_core::with_task_mutation_lock(repo, "set related tasks", || {
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
