//! Taskless OMP chat threads: the file and git half of listing, pinning, archiving, worktrees and
//! resume. It lives in core so a local repo and a remote host run the same code. The daemon client
//! is passed in, so a host runs it against its own daemon.
use crate::{DaemonClient, SessionMeta};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatThread {
    pub repo_path: String,
    pub session: SessionMeta,
    pub name: Option<String>,
    pub branch_label: String,
    pub checkout: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatBranch {
    pub label: String,
    pub checkout: bool,
}

pub fn load_root_omp(repo: &Path, id: &str) -> Result<SessionMeta, String> {
    if crate::safe_component(id) != Some(id) {
        return Err("invalid session id".into());
    }
    let meta = crate::board::load_session_meta(repo, "", id)?;
    if meta.id != id || meta.harness != crate::DEFAULT_HARNESS_KEY || !meta.generic {
        return Err("not a chat thread".into());
    }
    Ok(meta)
}

fn root_omp_metas(repo: &Path) -> Vec<SessionMeta> {
    let Ok(entries) = fs::read_dir(crate::root_sessions_dir(repo)) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            if !name.ends_with(".meta.json") {
                return None;
            }
            let raw = fs::read_to_string(entry.path()).ok()?;
            serde_json::from_str::<SessionMeta>(&raw).ok()
        })
        .filter(|meta| meta.harness == crate::DEFAULT_HARNESS_KEY)
        .collect()
}

/// The generation whose id names `meta`'s live chat worktree. A resumed thread inherits its
/// predecessor's directory, which keeps the name of the generation that ran `git worktree add`, so
/// ownership is any id on the thread's own `resume_of` chain, never an arbitrary path.
pub fn chat_worktree_owner(repo: &Path, meta: &SessionMeta) -> Option<String> {
    let path = Path::new(&meta.worktree);
    if path.parent() != Some(crate::chat_worktrees_dir(repo).as_path()) || !path.is_dir() {
        return None;
    }
    let dir = path.file_name()?.to_str()?;
    let mut seen = std::collections::HashSet::new();
    let mut next = Some(meta.id.clone());
    while let Some(id) = next {
        if id == dir {
            return Some(id);
        }
        if !seen.insert(id.clone()) {
            return None;
        }
        next = load_root_omp(repo, &id).ok().and_then(|ancestor| ancestor.resume_of);
    }
    None
}

pub fn chat_branch_of(repo: &Path, meta: &SessionMeta) -> ChatBranch {
    chat_branch_with(repo, meta, || crate::abbrev_ref(repo).unwrap_or_default())
}

fn chat_branch_with(repo: &Path, meta: &SessionMeta, checkout_label: impl FnOnce() -> String) -> ChatBranch {
    if chat_worktree_owner(repo, meta).is_some() {
        ChatBranch {
            label: crate::abbrev_ref(Path::new(&meta.worktree)).unwrap_or_default(),
            checkout: false,
        }
    } else {
        ChatBranch {
            label: checkout_label(),
            checkout: true,
        }
    }
}

pub fn list_chat_threads_in(repos: &[PathBuf], include_archived: bool) -> Result<Vec<ChatThread>, String> {
    let mut threads = Vec::new();
    for repo in repos.iter() {
        let metas = root_omp_metas(repo);
        let superseded: std::collections::HashSet<String> = metas.iter().filter_map(|meta| meta.resume_of.clone()).collect();
        // Every checkout thread in a repo shares its branch: one git call per repo, not per thread.
        let repo_branch = std::cell::OnceCell::new();
        for meta in metas {
            if superseded.contains(&meta.id) {
                continue;
            }
            if meta.archived && !include_archived {
                continue;
            }
            let branch = chat_branch_with(repo, &meta, || repo_branch.get_or_init(|| crate::abbrev_ref(repo).unwrap_or_default()).clone());
            let name = crate::read_session_name(repo, "", &meta.id).ok().flatten().map(|value| value.name);
            threads.push(ChatThread {
                repo_path: repo.to_string_lossy().into_owned(),
                session: meta,
                name,
                branch_label: branch.label,
                checkout: branch.checkout,
            });
        }
    }
    sort_chat_threads(&mut threads);
    Ok(threads)
}

/// Pinned first, then newest. Applied again when threads from several hosts are merged.
pub fn sort_chat_threads(threads: &mut [ChatThread]) {
    threads.sort_by(|left, right| {
        right
            .session
            .pinned
            .cmp(&left.session.pinned)
            .then_with(|| right.session.created.cmp(&left.session.created))
            .then_with(|| left.session.id.cmp(&right.session.id))
    });
}

fn stamp_chat(repo: &Path, id: &str, mutate: impl FnOnce(&mut Value)) -> Result<(), String> {
    crate::stamp_meta(&crate::session_meta_path(repo, "", id), mutate)
}

pub fn set_chat_pinned_in(repo: &Path, session_id: &str, pinned: bool) -> Result<(), String> {
    let _ = load_root_omp(repo, session_id)?;
    stamp_chat(repo, session_id, |value| value["pinned"] = json!(pinned))
}

fn delete_chat_row(repo: &Path, id: &str) -> Result<(), String> {
    let meta = crate::session_meta_path(repo, "", id);
    if meta.exists() {
        fs::remove_file(&meta).map_err(|error| error.to_string())?;
    }
    let name = crate::session_name_path(repo, "", id);
    if name.exists() {
        fs::remove_file(name).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn create_chat_thread_in(repo: &Path, daemon: &DaemonClient, model: &str, create_worktree: bool) -> Result<crate::task_creation::CreateExecutionSessionReply, String> {
    let reply = daemon.create_execution_session(&crate::task_creation::CreateExecutionSessionRequest {
        task_slug: String::new(),
        target: crate::task_creation::ExecutionSessionTarget::Auxiliary {
            harness: crate::DEFAULT_HARNESS_KEY.into(),
            model: (!model.is_empty()).then(|| model.to_string()),
            prompt: None,
        },
        launch_override: None,
        prompt_extra: None,
        handoff_artifact: None,
        start: false,
    })?;
    let id = reply.session.id.clone();
    if create_worktree {
        match crate::add_chat_worktree(repo, &id) {
            Ok(path) => stamp_chat(repo, &id, |value| value["worktree"] = json!(path.to_string_lossy()))?,
            Err(error) => {
                let path = crate::chat_worktrees_dir(repo).join(&id);
                let remove_error = if path.exists() {
                    crate::remove_chat_worktree_path(repo, &id, &path).err()
                } else {
                    None
                };
                let _ = delete_chat_row(repo, &id);
                return match remove_error {
                    Some(remove_error) => Err(format!("{error}; {remove_error}")),
                    None => Err(error),
                };
            }
        }
    }
    match daemon.start_session(&crate::task_creation::StartSessionRequest {
        task_slug: String::new(),
        session_id: id,
    }) {
        Ok(started) => Ok(started),
        Err(error) => Ok(crate::task_creation::CreateExecutionSessionReply {
            session: load_root_omp(repo, &reply.session.id).unwrap_or(reply.session),
            execution: None,
            start: "failed".into(),
            errors: vec![crate::task_creation::CreationError {
                stage: "launch".into(),
                code: "spawn_failed".into(),
                message: error,
            }],
        }),
    }
}

/// Whether the thread's OMP is running. Without its repo's daemon a started, unended thread may
/// still be, so that is an error rather than "no".
fn chat_running(meta: &SessionMeta, daemon: Option<&DaemonClient>) -> Result<bool, String> {
    match daemon {
        Some(daemon) => Ok(daemon
            .session_status_observed(&meta.id)?
            .is_some_and(|status| !matches!(status.state.process, crate::ProcessState::Exited { .. }))),
        None if meta.started_at.is_some() && meta.ended_at.is_none() => Err("daemon not connected".into()),
        None => Ok(false),
    }
}

pub fn archive_chat_thread_in(repo: &Path, session_id: &str, remove_worktree: bool, daemon: Option<&DaemonClient>) -> Result<(), String> {
    let meta = load_root_omp(repo, session_id)?;
    if chat_running(&meta, daemon)? {
        daemon.ok_or("daemon not connected")?.kill_session(session_id)?;
    }
    stamp_chat(repo, session_id, |value| value["archived"] = json!(true))?;
    if !remove_worktree {
        return Ok(());
    }
    remove_owned_worktree(repo, &meta)
}

/// Standalone removal never stops the thread: a running OMP would be left inside a deleted directory.
pub fn remove_chat_worktree_in(repo: &Path, session_id: &str, daemon: Option<&DaemonClient>) -> Result<(), String> {
    let meta = load_root_omp(repo, session_id)?;
    if chat_running(&meta, daemon)? {
        return Err("This thread is still running. Archive it with Archive and remove worktree, or stop it first.".into());
    }
    remove_owned_worktree(repo, &meta)
}

fn remove_owned_worktree(repo: &Path, meta: &SessionMeta) -> Result<(), String> {
    let path = PathBuf::from(&meta.worktree);
    let owner = chat_worktree_owner(repo, meta).unwrap_or_else(|| meta.id.clone());
    crate::remove_chat_worktree_path(repo, &owner, &path)?;
    stamp_chat(repo, &meta.id, |value| value["worktree"] = json!(repo.to_string_lossy()))
}

fn find_successor(repo: &Path, predecessor_id: &str) -> Option<SessionMeta> {
    root_omp_metas(repo).into_iter().find(|meta| meta.resume_of.as_deref() == Some(predecessor_id))
}

pub fn resolve_resume_cwd(repo: &Path, predecessor: &SessionMeta) -> Result<PathBuf, String> {
    if chat_worktree_owner(repo, predecessor).is_some() {
        return Ok(PathBuf::from(&predecessor.worktree));
    }
    let checkout = repo.to_path_buf();
    if predecessor.worktree != checkout.to_string_lossy() {
        stamp_chat(repo, &predecessor.id, |value| value["worktree"] = json!(checkout.to_string_lossy()))?;
    }
    Ok(checkout)
}

// ponytail: one process-wide lock, so resumes of any two threads queue behind each other; per-thread
// locks if that wait ever shows.
static RESUMING: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn resume_chat_thread_in(repo: &Path, predecessor_id: &str, daemon: Option<&DaemonClient>) -> Result<SessionMeta, String> {
    // Held from the successor lookup through the launch, so overlapping resumes of one thread
    // (two clicks, a send racing the Resume button) mint and launch exactly one successor.
    let _resuming = RESUMING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let predecessor = load_root_omp(repo, predecessor_id)?;
    if let Some(successor) = find_successor(repo, predecessor_id) {
        return Ok(successor);
    }
    // Kill and boot_sweep stamp ended_at, not the journal path. OMP --resume takes that jsonl.
    let token = if predecessor.harness_resume_token.is_empty() {
        crate::newest_omp_jsonl(&crate::session_omp_dir(repo, "", predecessor_id))
            .map(|path| path.to_string_lossy().into_owned())
            .ok_or_else(|| "cannot continue".to_string())?
    } else {
        predecessor.harness_resume_token.clone()
    };
    let daemon = daemon.ok_or("daemon not connected")?;
    let cwd = resolve_resume_cwd(repo, &predecessor)?;
    let minted = daemon.create_execution_session(&crate::task_creation::CreateExecutionSessionRequest {
        task_slug: String::new(),
        target: crate::task_creation::ExecutionSessionTarget::Auxiliary {
            harness: crate::DEFAULT_HARNESS_KEY.into(),
            model: (!predecessor.model.is_empty()).then(|| predecessor.model.clone()),
            prompt: None,
        },
        launch_override: None,
        prompt_extra: None,
        handoff_artifact: None,
        start: false,
    })?;
    let successor_id = minted.session.id.clone();
    let link = stamp_chat(repo, &successor_id, |value| {
        value["resume_of"] = json!(predecessor_id);
        value["pinned"] = json!(predecessor.pinned);
        value["worktree"] = json!(cwd.to_string_lossy());
    });
    if let Err(error) = link {
        let _ = delete_chat_row(repo, &successor_id);
        return Err(error);
    }
    if let Ok(Some(name)) = crate::read_session_name(repo, "", predecessor_id) {
        if let Err(error) = crate::set_session_name(repo, "", &successor_id, &name.name, name.source) {
            let _ = delete_chat_row(repo, &successor_id);
            return Err(error);
        }
    }
    let cwd_text = cwd.to_string_lossy().into_owned();
    let launched = daemon.resume_session(&crate::daemon_client::OpenRequest {
        intent: crate::daemon_client::ops::RESUME,
        id: &successor_id,
        cwd: &cwd_text,
        task_slug: Some(""),
        phase: None,
        model: None,
        attach_id: 0,
        resume_token: Some(&token),
        cols: None,
        rows: None,
    });
    if let Err(error) = launched {
        let live = daemon.session_status_observed(&successor_id).map(|status| status.is_some()).unwrap_or(true);
        if live {
            if let Err(kill_error) = daemon.kill_session(&successor_id) {
                return Err(format!("{error}; {kill_error}"));
            }
        }
        let _ = delete_chat_row(repo, &successor_id);
        return Err(error);
    }
    stamp_chat(repo, predecessor_id, |value| value["archived"] = json!(true))?;
    load_root_omp(repo, &successor_id)
}

pub fn chat_thread_attachment_dir(repo: &Path, id: &str) -> Result<PathBuf, String> {
    let _ = load_root_omp(repo, id)?;
    Ok(crate::chat_attachments_dir(repo, id))
}

pub fn write_chat_thread_attachment_bytes_in(repo: &Path, id: &str, file_name: &str, bytes: &[u8]) -> Result<String, String> {
    let dir = chat_thread_attachment_dir(repo, id)?;
    crate::attachments::write_attachment_bytes_into(&dir, file_name, bytes)
}

pub fn read_chat_thread_image_in(repo: &Path, id: &str, name: &str) -> Result<crate::attachments::ChatImage, String> {
    load_root_omp(repo, id)?;
    let name = crate::safe_component(name).ok_or_else(|| format!("invalid attachment name: {name}"))?;
    let dir = crate::chat_attachments_dir(repo, id);
    let path = crate::resolve_artifact_path(&dir, name)?;
    if !path.is_file() {
        return Err(format!("attachment not found: {name}"));
    }
    crate::attachments::read_chat_image_file(&path, name)
}
