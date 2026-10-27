//! Taskless OMP chat threads. Session bytes stay in `<repo>/.alinery/sessions/`.
//! The rail scans known repos. Every daemon call uses `daemon_for(repo)` only.
//! The file and git half lives in `alinery_core::chat`, so a remote host runs the same code.
use crate::*;

pub(crate) use alinery_core::chat::{
    archive_chat_thread_in, chat_branch_of, chat_thread_attachment_dir, create_chat_thread_in, list_chat_threads_in, load_root_omp, read_chat_thread_image_in,
    remove_chat_worktree_in, resume_chat_thread_in, set_chat_pinned_in, sort_chat_threads, write_chat_thread_attachment_bytes_in, ChatBranch, ChatThread,
};

#[cfg(test)]
pub(crate) use alinery_core::chat::resolve_resume_cwd;

/// Explicit-repo client. A miss does not consult the active daemon.
pub(crate) fn require_explicit_daemon<T>(explicit: Option<T>, active: impl FnOnce() -> Option<T>) -> Result<T, String> {
    if let Some(client) = explicit {
        return Ok(client);
    }
    let _active = active;
    Err("daemon not connected".into())
}

/// Chat shows only repos that are open in this window: this window holds the repo's GUI
/// flock, a daemon is connected for it, and no close is in flight. A repo another Alinery
/// holds, one whose daemon is stopped or conflicted, or one being closed drops out of the
/// rail with its threads, rather than listing threads every action on would refuse. A remote
/// repo is open while its host is connected and its daemon is attached.
pub(crate) fn open_chat_repos_in(known: &[String], state: &AppState) -> Vec<PathBuf> {
    known
        .iter()
        .map(PathBuf::from)
        .filter(|repo| {
            let ready = match RepoRef::parse(&repo.to_string_lossy()) {
                Ok(RepoRef::Remote { host_id, .. }) => connected_session(state, &host_id).is_ok(),
                _ => is_local_repo_dir(repo) && state.owns_repo(repo),
            };
            ready && !state.is_closing(repo) && state.daemon_for(repo).is_some()
        })
        .collect()
}

#[tauri::command]
pub(crate) fn list_chat_repos(app: AppHandle, state: State<'_, AppState>) -> Vec<String> {
    open_chat_repos_in(&load_app_config(&app).known_repos, &state)
        .into_iter()
        .map(|repo| repo.to_string_lossy().into_owned())
        .collect()
}

fn local_daemon(state: &AppState, repo: &Path) -> Result<DaemonClient, String> {
    require_explicit_daemon(state.daemon_for(repo), || state.daemon())
}

/// The daemon client of a thread's repo: its own socket, or the forward to its host.
fn chat_daemon(state: &AppState, target: &RepoRef) -> Result<DaemonClient, String> {
    match target {
        RepoRef::Local(repo) => local_daemon(state, repo),
        remote => repo_client(state, remote),
    }
}

/// The thread's meta, refusing an id that is not a chat thread.
fn chat_meta(state: &AppState, target: &RepoRef, id: &str) -> Result<SessionMeta, String> {
    match target {
        RepoRef::Local(repo) => load_root_omp(repo, id),
        RepoRef::Remote { host_id, path } => remote_call(
            state,
            host_id,
            RepoOp::ChatThreadMeta {
                repo: path.into(),
                session_id: id.into(),
            },
        ),
    }
}

fn require_chat_thread(app: &AppHandle, target: &RepoRef, id: &str) -> Result<(), String> {
    chat_meta(&app.state::<AppState>(), target, id).map(|_| ())
}

/// Run one chat action where the thread's repo lives, off the main thread: `local` against a repo
/// on this machine, or the op `remote` builds (from the host path and the host's `app.toml`) on its host.
async fn on_repo<T: Send + serde::de::DeserializeOwned + 'static>(
    app: &AppHandle,
    target: RepoRef,
    what: &'static str,
    local: impl FnOnce(&AppState, &Path) -> Result<T, String> + Send + 'static,
    remote: impl FnOnce(PathBuf, PathBuf) -> RepoOp + Send + 'static,
) -> Result<T, String> {
    let app = app.clone();
    off_main_thread(what, move || {
        let state = app.state::<AppState>();
        match target {
            RepoRef::Local(repo) => local(&state, &repo),
            RepoRef::Remote { host_id, path } => {
                let op = remote(path.into(), host_app_config(&state, &host_id)?);
                remote_call(&state, &host_id, op)
            }
        }
    })
    .await
}

/// Threads of every open repo. A host that does not answer drops out of the list rather than
/// failing the rest.
pub(crate) fn chat_threads_across(state: &AppState, repos: &[PathBuf], include_archived: bool) -> Result<Vec<ChatThread>, String> {
    let (remote, local): (Vec<_>, Vec<_>) = repos.iter().cloned().partition(|repo| is_remote_repo_key(&repo.to_string_lossy()));
    let mut threads = list_chat_threads_in(&local, include_archived)?;
    for key in remote.iter().map(|repo| repo.to_string_lossy().into_owned()) {
        let Ok(RepoRef::Remote { host_id, path }) = RepoRef::parse(&key) else {
            continue;
        };
        let op = RepoOp::ListChatThreads {
            repo: path.into(),
            include_archived,
        };
        if let Ok(rows) = remote_call::<Vec<ChatThread>>(state, &host_id, op) {
            // The host answers with its own paths; the rail addresses the repo by its key.
            threads.extend(rows.into_iter().map(|thread| ChatThread { repo_path: key.clone(), ..thread }));
        }
    }
    sort_chat_threads(&mut threads);
    Ok(threads)
}

#[tauri::command]
pub(crate) async fn list_chat_threads(app: AppHandle, state: State<'_, AppState>, include_archived: bool) -> Result<Vec<ChatThread>, String> {
    let repos = open_chat_repos_in(&load_app_config(&app).known_repos, &state);
    // A directory scan plus a git call per worktree thread: never on the main thread.
    off_main_thread("list chat threads", move || chat_threads_across(&app.state::<AppState>(), &repos, include_archived)).await
}

/// One thread's name, so a title refresh reads one file instead of relisting every thread.
#[tauri::command]
pub(crate) async fn chat_thread_name(app: AppHandle, state: State<'_, AppState>, repo_path: String, session_id: String) -> Result<Option<String>, String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let remote_id = session_id.clone();
    on_repo(
        &app,
        target,
        "chat thread name",
        move |_, repo| {
            load_root_omp(repo, &session_id)?;
            Ok(alinery_core::read_session_name(repo, "", &session_id)?.map(|name| name.name))
        },
        move |repo, _| RepoOp::ChatThreadName { repo, session_id: remote_id },
    )
    .await
}

#[tauri::command]
pub(crate) async fn create_chat_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    model: Option<String>,
    create_worktree: bool,
) -> Result<alinery_core::task_creation::CreateExecutionSessionReply, String> {
    let target = owned_target(&app, &state, &repo_path)?;
    chat_daemon(&state, &target)?;
    let model = model.unwrap_or_default();
    refresh_hosted_inference_before_open(app.clone(), daemon_client::ops::SPAWN, alinery_core::DEFAULT_HARNESS_KEY, &model).await?;
    let remote_model = model.clone();
    on_repo(
        &app,
        target,
        "create chat thread",
        move |state, repo| create_chat_thread_in(repo, &local_daemon(state, repo)?, &model, create_worktree),
        move |repo, app_config| RepoOp::CreateChatThread {
            repo,
            app_config,
            model: remote_model,
            create_worktree,
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn start_chat_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    session_id: String,
) -> Result<alinery_core::task_creation::CreateExecutionSessionReply, String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let daemon = chat_daemon(&state, &target)?;
    let meta = {
        let (app, id) = (app.clone(), session_id.clone());
        off_main_thread("start chat thread", move || chat_meta(&app.state::<AppState>(), &target, &id)).await?
    };
    refresh_hosted_inference_before_open(app, daemon_client::ops::SPAWN, alinery_core::DEFAULT_HARNESS_KEY, &meta.model).await?;
    off_main_thread("start chat thread", move || {
        daemon.start_session(&alinery_core::task_creation::StartSessionRequest {
            task_slug: String::new(),
            session_id,
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_chat_pinned(app: AppHandle, state: State<'_, AppState>, repo_path: String, session_id: String, pinned: bool) -> Result<(), String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let remote_id = session_id.clone();
    on_repo(
        &app,
        target,
        "set chat pinned",
        move |_, repo| set_chat_pinned_in(repo, &session_id, pinned),
        move |repo, _| RepoOp::SetChatPinned {
            repo,
            session_id: remote_id,
            pinned,
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn archive_chat_thread(app: AppHandle, state: State<'_, AppState>, repo_path: String, session_id: String, remove_worktree: bool) -> Result<(), String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let remote_id = session_id.clone();
    on_repo(
        &app,
        target,
        "archive chat thread",
        move |state, repo| archive_chat_thread_in(repo, &session_id, remove_worktree, state.daemon_for(repo).as_ref()),
        move |repo, app_config| RepoOp::ArchiveChatThread {
            repo,
            app_config,
            session_id: remote_id,
            remove_worktree,
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn remove_chat_worktree(app: AppHandle, state: State<'_, AppState>, repo_path: String, session_id: String) -> Result<(), String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let remote_id = session_id.clone();
    on_repo(
        &app,
        target,
        "remove chat worktree",
        move |state, repo| remove_chat_worktree_in(repo, &session_id, state.daemon_for(repo).as_ref()),
        move |repo, app_config| RepoOp::RemoveChatWorktree {
            repo,
            app_config,
            session_id: remote_id,
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn resume_chat_thread(app: AppHandle, state: State<'_, AppState>, repo_path: String, session_id: String) -> Result<SessionMeta, String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let remote_id = session_id.clone();
    on_repo(
        &app,
        target,
        "resume chat thread",
        move |state, repo| resume_chat_thread_in(repo, &session_id, state.daemon_for(repo).as_ref()),
        move |repo, app_config| RepoOp::ResumeChatThread {
            repo,
            app_config,
            session_id: remote_id,
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn chat_branch_label(app: AppHandle, state: State<'_, AppState>, repo_path: String, session_id: String) -> Result<ChatBranch, String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let remote_id = session_id.clone();
    on_repo(
        &app,
        target,
        "chat branch label",
        move |_, repo| Ok(chat_branch_of(repo, &load_root_omp(repo, &session_id)?)),
        move |repo, _| RepoOp::ChatBranchLabel { repo, session_id: remote_id },
    )
    .await
}

#[tauri::command]
pub(crate) async fn chat_transcript(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String) -> Result<alinery_core::daemon_client::TranscriptReply, String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let daemon = chat_daemon(&state, &target)?;
    off_main_thread("chat transcript", move || {
        // The polling read: a host round trip for the thread check would double its cost, and the
        // daemon addresses a session by id alone.
        if let RepoRef::Local(repo) = &target {
            load_root_omp(repo, &id)?;
        }
        daemon.transcript(&id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn chat_prompt(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String, text: String) -> Result<(), String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let daemon = chat_daemon(&state, &target)?;
    off_main_thread("chat prompt", move || {
        require_chat_thread(&app, &target, &id)?;
        daemon.prompt(&id, &text)
    })
    .await
}

#[tauri::command]
pub(crate) async fn chat_abort(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String) -> Result<(), String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let daemon = chat_daemon(&state, &target)?;
    off_main_thread("chat abort", move || {
        require_chat_thread(&app, &target, &id)?;
        daemon.abort(&id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn chat_set_model(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    id: String,
    model: String,
) -> Result<alinery_core::daemon_client::SessionControls, String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let daemon = chat_daemon(&state, &target)?;
    off_main_thread("chat set model", move || {
        require_chat_thread(&app, &target, &id)?;
        daemon.set_model(&id, &model)
    })
    .await
}

#[tauri::command]
pub(crate) async fn chat_set_thinking_level(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    id: String,
    level: String,
) -> Result<alinery_core::daemon_client::SessionControls, String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let daemon = chat_daemon(&state, &target)?;
    off_main_thread("chat set thinking level", move || {
        require_chat_thread(&app, &target, &id)?;
        daemon.set_thinking_level(&id, &level)
    })
    .await
}

#[tauri::command]
pub(crate) async fn chat_rpc_write(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String, payload: Value) -> Result<(), String> {
    let _ = (app, state, repo_path, id, payload);
    Err("OMP process sessions are not available".into())
}

#[tauri::command]
pub(crate) async fn chat_rpc_attach(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    id: String,
    attach_id: u64,
    stream_token: u64,
    on_line: Channel<String>,
) -> Result<(), String> {
    let _ = (app, state, repo_path, id, attach_id, stream_token, on_line);
    Err("OMP process sessions are not available".into())
}

#[tauri::command]
pub(crate) async fn chat_detach(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String, attach_id: u64) -> Result<(), String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let daemon = chat_daemon(&state, &target)?;
    off_main_thread("chat detach", move || {
        require_chat_thread(&app, &target, &id)?;
        let detached = daemon.detach_session(&id, attach_id);
        // A remote thread's input queue (see `queue_terminal_op`) ends with its terminal.
        drop_terminal_queue(&app.state::<AppState>(), &id);
        detached
    })
    .await
}

#[tauri::command]
pub(crate) async fn chat_session_status(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String) -> Result<SessionObservation, String> {
    let target = owned_target(&app, &state, &repo_path)?;
    // Chat polls this every 1.5s; a sync command would run the daemon round trip on the main thread.
    off_main_thread("chat session status", move || {
        let state = app.state::<AppState>();
        let meta = chat_meta(&state, &target, &id)?;
        // A slow or failed read is an error, not "no process": collapsing it to None read as
        // Orphaned, flickered the title, and made stream recovery skip a live thread.
        let live = match chat_daemon(&state, &target).ok() {
            Some(daemon) => daemon.session_status_observed(&id)?,
            None => None,
        };
        Ok(SessionObservation {
            lifecycle: lifecycle_from_structured(meta.started_at, meta.ended_at, meta.exit_code, live.as_ref().map(|live| &live.state)),
            state: live.as_ref().map(|live| live.state.clone()),
            checkpoint: meta.semantic,
            transport: live.map(|live| live.transport),
        })
    })
    .await
}

/// The chat's terminal hatch: respawn the thread's OMP on the same journal over the other transport
/// (`pty` = the OMP TUI, `rpc` = back to chat). The generic restate is bound to the active repo;
/// a chat thread can live in any known repo.
#[tauri::command]
pub(crate) async fn chat_restate(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String, transport: String) -> Result<(), String> {
    let _ = (app, state, repo_path, id, transport);
    Err("OMP process sessions are not available".into())
}

/// Attach the terminal view to a thread that is in its PTY transport. Attach only: it never spawns.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn chat_pty_attach(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    id: String,
    attach_id: u64,
    stream_token: u64,
    cols: Option<u16>,
    rows: Option<u16>,
    on_bytes: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let daemon = chat_daemon(&state, &target)?;
    off_main_thread("chat terminal attach", move || {
        let meta = chat_meta(&app.state::<AppState>(), &target, &id)?;
        open_daemon_session(
            &daemon,
            &id,
            &meta.worktree,
            Some(""),
            None,
            None,
            attach_id,
            stream_token,
            daemon_client::ops::ATTACH,
            None,
            cols,
            rows,
            on_bytes,
            app,
        )
    })
    .await
}

#[tauri::command]
pub(crate) fn chat_pty_write(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String, data: String) -> Result<(), String> {
    let target = owned_target(&app, &state, &repo_path)?;
    // Keystrokes: no host round trip for the thread check on a remote repo.
    match &target {
        RepoRef::Local(repo) => {
            load_root_omp(repo, &id)?;
            chat_daemon(&state, &target)?.write_session(&id, &data)
        }
        // Ordered with the other input of this thread, and off the main thread (see `queue_terminal_op`).
        RepoRef::Remote { .. } => queue_terminal_op_to(&state, &id, chat_daemon(&state, &target)?, TerminalOp::Write(data)),
    }
}

#[tauri::command]
pub(crate) fn chat_pty_resize(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let target = owned_target(&app, &state, &repo_path)?;
    match &target {
        RepoRef::Local(repo) => {
            load_root_omp(repo, &id)?;
            chat_daemon(&state, &target)?.resize_session(&id, cols, rows)
        }
        RepoRef::Remote { .. } => queue_terminal_op_to(&state, &id, chat_daemon(&state, &target)?, TerminalOp::Resize(cols, rows)),
    }
}

#[tauri::command]
pub(crate) async fn read_chat_omp(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    id: String,
    end: Option<u64>,
    want: Option<u64>,
) -> Result<tauri::ipc::Response, String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let window = off_main_thread("read chat omp", move || {
        let state = app.state::<AppState>();
        chat_meta(&state, &target, &id)?;
        match target {
            RepoRef::Local(repo) => alinery_core::read_omp_window(&repo, "", &id, end, want),
            RepoRef::Remote { host_id, path } => remote_call::<alinery_core::repo_service::WireOmpWindow>(
                &state,
                &host_id,
                RepoOp::ReadOmpWindow {
                    repo: path.into(),
                    slug: String::new(),
                    session_id: id,
                    end,
                    want,
                },
            )
            .map(Into::into),
        }
    })
    .await?;
    let mut body = serde_json::to_vec(&json!({
        "start": window.start,
        "end": window.end,
        "length": window.length,
    }))
    .map_err(|error| error.to_string())?;
    body.push(b'\n');
    body.extend_from_slice(&window.data);
    Ok(tauri::ipc::Response::new(body))
}

pub(crate) fn copy_chat_thread_attachments_in(repo: &Path, id: &str, paths: &[String]) -> Result<CopyChatAttachmentsResult, String> {
    let dir = chat_thread_attachment_dir(repo, id)?;
    let (_urls, copied, failures) = copy_attachments_into(&dir, paths);
    Ok(CopyChatAttachmentsResult { copied, failures })
}

#[tauri::command]
pub(crate) async fn copy_chat_thread_attachments(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    id: String,
    paths: Vec<String>,
) -> Result<CopyChatAttachmentsResult, String> {
    let target = owned_target(&app, &state, &repo_path)?;
    off_main_thread("copy chat attachments", move || match target {
        RepoRef::Local(repo) => copy_chat_thread_attachments_in(&repo, &id, &paths),
        RepoRef::Remote { host_id, path } => {
            let state = app.state::<AppState>();
            chat_meta(
                &state,
                &RepoRef::Remote {
                    host_id: host_id.clone(),
                    path: path.clone(),
                },
                &id,
            )?;
            Ok(send_files_to_host(&paths, |file_name, data| {
                remote_call::<String>(
                    &state,
                    &host_id,
                    RepoOp::WriteChatThreadAttachment {
                        repo: path.clone().into(),
                        session_id: id.clone(),
                        file_name,
                        data,
                    },
                )
            }))
        }
    })
    .await
}

#[tauri::command]
pub(crate) async fn write_chat_thread_attachment_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    id: String,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let target = owned_target(&app, &state, &repo_path)?;
    off_main_thread("write chat attachment", move || match target {
        RepoRef::Local(repo) => write_chat_thread_attachment_bytes_in(&repo, &id, &file_name, &bytes),
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::WriteChatThreadAttachment {
                repo: path.into(),
                session_id: id,
                file_name,
                data: bytes,
            },
        ),
    })
    .await
}

#[tauri::command]
pub(crate) async fn read_chat_thread_image(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String, name: String) -> Result<ChatImage, String> {
    let target = owned_target(&app, &state, &repo_path)?;
    let remote_id = id.clone();
    let remote_name = name.clone();
    on_repo(
        &app,
        target,
        "read chat image",
        move |_, repo| read_chat_thread_image_in(repo, &id, &name),
        move |repo, _| RepoOp::ReadChatThreadImage {
            repo,
            session_id: remote_id,
            name: remote_name,
        },
    )
    .await
}
