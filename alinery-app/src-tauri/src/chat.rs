//! Taskless OMP chat threads. Session bytes stay in `<repo>/.alinery/sessions/`.
//! The rail scans known repos. Every daemon call uses `daemon_for(repo)` only.
use crate::*;

#[derive(Serialize, Clone)]
pub(crate) struct ChatThread {
    pub repo_path: String,
    pub session: SessionMeta,
    pub name: Option<String>,
    pub branch_label: String,
    pub checkout: bool,
}

#[derive(Serialize, Clone)]
pub(crate) struct ChatBranch {
    pub label: String,
    pub checkout: bool,
}

/// Explicit-repo client. A miss does not consult the active daemon.
pub(crate) fn require_explicit_daemon<T>(explicit: Option<T>, active: impl FnOnce() -> Option<T>) -> Result<T, String> {
    if let Some(client) = explicit {
        return Ok(client);
    }
    let _active = active;
    Err("daemon not connected".into())
}

fn load_root_omp(repo: &Path, id: &str) -> Result<SessionMeta, String> {
    if alinery_core::safe_component(id) != Some(id) {
        return Err("invalid session id".into());
    }
    let meta = load_session_meta_for(repo, "", id)?;
    if meta.id != id || meta.harness != alinery_core::DEFAULT_HARNESS_KEY || !meta.generic {
        return Err("not a chat thread".into());
    }
    Ok(meta)
}

fn root_omp_metas(repo: &Path) -> Vec<SessionMeta> {
    let Ok(entries) = fs::read_dir(alinery_core::root_sessions_dir(repo)) else {
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
        .filter(|meta| meta.harness == alinery_core::DEFAULT_HARNESS_KEY)
        .collect()
}

/// The generation whose id names `meta`'s live chat worktree. A resumed thread inherits its
/// predecessor's directory, which keeps the name of the generation that ran `git worktree add`, so
/// ownership is any id on the thread's own `resume_of` chain, never an arbitrary path.
pub(crate) fn chat_worktree_owner(repo: &Path, meta: &SessionMeta) -> Option<String> {
    let path = Path::new(&meta.worktree);
    if path.parent() != Some(alinery_core::chat_worktrees_dir(repo).as_path()) || !path.is_dir() {
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

pub(crate) fn chat_branch_of(repo: &Path, meta: &SessionMeta) -> ChatBranch {
    chat_branch_with(repo, meta, || alinery_core::abbrev_ref(repo).unwrap_or_default())
}

fn chat_branch_with(repo: &Path, meta: &SessionMeta, checkout_label: impl FnOnce() -> String) -> ChatBranch {
    if chat_worktree_owner(repo, meta).is_some() {
        ChatBranch {
            label: alinery_core::abbrev_ref(Path::new(&meta.worktree)).unwrap_or_default(),
            checkout: false,
        }
    } else {
        ChatBranch {
            label: checkout_label(),
            checkout: true,
        }
    }
}

pub(crate) fn list_chat_threads_in(repos: &[PathBuf], include_archived: bool) -> Result<Vec<ChatThread>, String> {
    let mut threads = Vec::new();
    for repo in repos.iter().filter(|repo| repo.is_dir()) {
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
            let branch = chat_branch_with(repo, &meta, || repo_branch.get_or_init(|| alinery_core::abbrev_ref(repo).unwrap_or_default()).clone());
            let name = alinery_core::read_session_name(repo, "", &meta.id).ok().flatten().map(|value| value.name);
            threads.push(ChatThread {
                repo_path: repo.to_string_lossy().into_owned(),
                session: meta,
                name,
                branch_label: branch.label,
                checkout: branch.checkout,
            });
        }
    }
    threads.sort_by(|left, right| {
        right
            .session
            .pinned
            .cmp(&left.session.pinned)
            .then_with(|| right.session.created.cmp(&left.session.created))
            .then_with(|| left.session.id.cmp(&right.session.id))
    });
    Ok(threads)
}

fn stamp_chat(repo: &Path, id: &str, mutate: impl FnOnce(&mut Value)) -> Result<(), String> {
    alinery_core::stamp_meta(&session_meta_path(repo, "", id), mutate)
}

pub(crate) fn set_chat_pinned_in(repo: &Path, session_id: &str, pinned: bool) -> Result<(), String> {
    let _ = load_root_omp(repo, session_id)?;
    stamp_chat(repo, session_id, |value| value["pinned"] = json!(pinned))
}

fn delete_chat_row(repo: &Path, id: &str) -> Result<(), String> {
    let meta = session_meta_path(repo, "", id);
    if meta.exists() {
        fs::remove_file(&meta).map_err(|error| error.to_string())?;
    }
    let name = alinery_core::session_name_path(repo, "", id);
    if name.exists() {
        fs::remove_file(name).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn create_chat_thread_in(
    repo: &Path,
    daemon: &DaemonClient,
    model: &str,
    create_worktree: bool,
) -> Result<alinery_core::task_creation::CreateExecutionSessionReply, String> {
    let reply = daemon.create_execution_session(&alinery_core::task_creation::CreateExecutionSessionRequest {
        task_slug: String::new(),
        target: alinery_core::task_creation::ExecutionSessionTarget::Auxiliary {
            harness: alinery_core::DEFAULT_HARNESS_KEY.into(),
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
        match alinery_core::add_chat_worktree(repo, &id) {
            Ok(path) => stamp_chat(repo, &id, |value| value["worktree"] = json!(path.to_string_lossy()))?,
            Err(error) => {
                let path = alinery_core::chat_worktrees_dir(repo).join(&id);
                let remove_error = if path.exists() {
                    alinery_core::remove_chat_worktree_path(repo, &id, &path).err()
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
    match daemon.start_session(&alinery_core::task_creation::StartSessionRequest {
        task_slug: String::new(),
        session_id: id,
    }) {
        Ok(started) => Ok(started),
        Err(error) => Ok(alinery_core::task_creation::CreateExecutionSessionReply {
            session: load_root_omp(repo, &reply.session.id).unwrap_or(reply.session),
            execution: None,
            start: "failed".into(),
            errors: vec![alinery_core::task_creation::CreationError {
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
            .is_some_and(|status| !matches!(status.state.process, alinery_core::ProcessState::Exited { .. }))),
        None if meta.started_at.is_some() && meta.ended_at.is_none() => Err("daemon not connected".into()),
        None => Ok(false),
    }
}

pub(crate) fn archive_chat_thread_in(repo: &Path, session_id: &str, remove_worktree: bool, daemon: Option<&DaemonClient>) -> Result<(), String> {
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
pub(crate) fn remove_chat_worktree_in(repo: &Path, session_id: &str, daemon: Option<&DaemonClient>) -> Result<(), String> {
    let meta = load_root_omp(repo, session_id)?;
    if chat_running(&meta, daemon)? {
        return Err("This thread is still running. Archive it with Archive and remove worktree, or stop it first.".into());
    }
    remove_owned_worktree(repo, &meta)
}

fn remove_owned_worktree(repo: &Path, meta: &SessionMeta) -> Result<(), String> {
    let path = PathBuf::from(&meta.worktree);
    let owner = chat_worktree_owner(repo, meta).unwrap_or_else(|| meta.id.clone());
    alinery_core::remove_chat_worktree_path(repo, &owner, &path)?;
    stamp_chat(repo, &meta.id, |value| value["worktree"] = json!(repo.to_string_lossy()))
}

fn find_successor(repo: &Path, predecessor_id: &str) -> Option<SessionMeta> {
    root_omp_metas(repo).into_iter().find(|meta| meta.resume_of.as_deref() == Some(predecessor_id))
}

pub(crate) fn resolve_resume_cwd(repo: &Path, predecessor: &SessionMeta) -> Result<PathBuf, String> {
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

pub(crate) fn resume_chat_thread_in(repo: &Path, predecessor_id: &str, daemon: Option<&DaemonClient>) -> Result<SessionMeta, String> {
    // Held from the successor lookup through the launch, so overlapping resumes of one thread
    // (two clicks, a send racing the Resume button) mint and launch exactly one successor.
    let _resuming = RESUMING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let predecessor = load_root_omp(repo, predecessor_id)?;
    if let Some(successor) = find_successor(repo, predecessor_id) {
        return Ok(successor);
    }
    // Kill and boot_sweep stamp ended_at, not the journal path. OMP --resume takes that jsonl.
    let token = if predecessor.harness_resume_token.is_empty() {
        alinery_core::newest_omp_jsonl(&alinery_core::session_omp_dir(repo, "", predecessor_id))
            .map(|path| path.to_string_lossy().into_owned())
            .ok_or_else(|| "cannot continue".to_string())?
    } else {
        predecessor.harness_resume_token.clone()
    };
    let daemon = daemon.ok_or("daemon not connected")?;
    let cwd = resolve_resume_cwd(repo, &predecessor)?;
    let minted = daemon.create_execution_session(&alinery_core::task_creation::CreateExecutionSessionRequest {
        task_slug: String::new(),
        target: alinery_core::task_creation::ExecutionSessionTarget::Auxiliary {
            harness: alinery_core::DEFAULT_HARNESS_KEY.into(),
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
    if let Ok(Some(name)) = alinery_core::read_session_name(repo, "", predecessor_id) {
        if let Err(error) = alinery_core::set_session_name(repo, "", &successor_id, &name.name, name.source) {
            let _ = delete_chat_row(repo, &successor_id);
            return Err(error);
        }
    }
    let cwd_text = cwd.to_string_lossy().into_owned();
    let launched = daemon.resume_session(&daemon_client::OpenRequest {
        intent: daemon_client::ops::RESUME,
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

fn known_chat_repos(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    Ok(load_app_config(app).known_repos.into_iter().map(PathBuf::from).filter(|path| path.is_dir()).collect())
}

fn owned_chat_repo(app: &AppHandle, state: &AppState, repo_path: &str) -> Result<PathBuf, String> {
    let repo = target_repo_for_app(app, repo_path)?;
    require_repo_owned(state, &repo)?;
    Ok(repo)
}

fn chat_daemon(state: &AppState, repo: &Path) -> Result<DaemonClient, String> {
    require_explicit_daemon(state.daemon_for(repo), || state.daemon())
}

#[tauri::command]
pub(crate) async fn list_chat_threads(app: AppHandle, include_archived: bool) -> Result<Vec<ChatThread>, String> {
    let repos = known_chat_repos(&app)?;
    // A directory scan plus a git call per worktree thread: never on the main thread.
    tauri::async_runtime::spawn_blocking(move || list_chat_threads_in(&repos, include_archived))
        .await
        .map_err(|error| format!("list chat threads: {error}"))?
}

/// One thread's name, so a title refresh reads one file instead of relisting every thread.
#[tauri::command]
pub(crate) fn chat_thread_name(app: AppHandle, state: State<'_, AppState>, repo_path: String, session_id: String) -> Result<Option<String>, String> {
    let repo = owned_chat_repo(&app, &state, &repo_path)?;
    load_root_omp(&repo, &session_id)?;
    Ok(alinery_core::read_session_name(&repo, "", &session_id)?.map(|name| name.name))
}

#[tauri::command]
pub(crate) async fn create_chat_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    model: Option<String>,
    create_worktree: bool,
) -> Result<alinery_core::task_creation::CreateExecutionSessionReply, String> {
    let repo = owned_chat_repo(&app, &state, &repo_path)?;
    let daemon = chat_daemon(&state, &repo)?;
    let model = model.unwrap_or_default();
    refresh_hosted_inference_before_open(app, daemon_client::ops::SPAWN, alinery_core::DEFAULT_HARNESS_KEY, &model).await?;
    tauri::async_runtime::spawn_blocking(move || create_chat_thread_in(&repo, &daemon, &model, create_worktree))
        .await
        .map_err(|error| format!("create chat thread: {error}"))?
}

#[tauri::command]
pub(crate) async fn start_chat_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    session_id: String,
) -> Result<alinery_core::task_creation::CreateExecutionSessionReply, String> {
    let repo = owned_chat_repo(&app, &state, &repo_path)?;
    let daemon = chat_daemon(&state, &repo)?;
    let meta = load_root_omp(&repo, &session_id)?;
    refresh_hosted_inference_before_open(app, daemon_client::ops::SPAWN, alinery_core::DEFAULT_HARNESS_KEY, &meta.model).await?;
    tauri::async_runtime::spawn_blocking(move || {
        daemon.start_session(&alinery_core::task_creation::StartSessionRequest {
            task_slug: String::new(),
            session_id,
        })
    })
    .await
    .map_err(|error| format!("start chat thread: {error}"))?
}

#[tauri::command]
pub(crate) fn set_chat_pinned(app: AppHandle, state: State<'_, AppState>, repo_path: String, session_id: String, pinned: bool) -> Result<(), String> {
    let repo = owned_chat_repo(&app, &state, &repo_path)?;
    set_chat_pinned_in(&repo, &session_id, pinned)
}

#[tauri::command]
pub(crate) async fn archive_chat_thread(app: AppHandle, state: State<'_, AppState>, repo_path: String, session_id: String, remove_worktree: bool) -> Result<(), String> {
    let repo = owned_chat_repo(&app, &state, &repo_path)?;
    let daemon = state.daemon_for(&repo);
    tauri::async_runtime::spawn_blocking(move || archive_chat_thread_in(&repo, &session_id, remove_worktree, daemon.as_ref()))
        .await
        .map_err(|error| format!("archive chat thread: {error}"))?
}

#[tauri::command]
pub(crate) async fn remove_chat_worktree(app: AppHandle, state: State<'_, AppState>, repo_path: String, session_id: String) -> Result<(), String> {
    let repo = owned_chat_repo(&app, &state, &repo_path)?;
    let daemon = state.daemon_for(&repo);
    tauri::async_runtime::spawn_blocking(move || remove_chat_worktree_in(&repo, &session_id, daemon.as_ref()))
        .await
        .map_err(|error| format!("remove chat worktree: {error}"))?
}

#[tauri::command]
pub(crate) async fn resume_chat_thread(app: AppHandle, state: State<'_, AppState>, repo_path: String, session_id: String) -> Result<SessionMeta, String> {
    let repo = owned_chat_repo(&app, &state, &repo_path)?;
    let daemon = state.daemon_for(&repo);
    tauri::async_runtime::spawn_blocking(move || resume_chat_thread_in(&repo, &session_id, daemon.as_ref()))
        .await
        .map_err(|error| format!("resume chat thread: {error}"))?
}

#[tauri::command]
pub(crate) fn chat_branch_label(app: AppHandle, state: State<'_, AppState>, repo_path: String, session_id: String) -> Result<ChatBranch, String> {
    let repo = owned_chat_repo(&app, &state, &repo_path)?;
    let meta = load_root_omp(&repo, &session_id)?;
    Ok(chat_branch_of(&repo, &meta))
}

#[tauri::command]
pub(crate) fn chat_rpc_write(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String, payload: Value) -> Result<(), String> {
    let repo = owned_chat_repo(&app, &state, &repo_path)?;
    let _ = load_root_omp(&repo, &id)?;
    let daemon = chat_daemon(&state, &repo)?;
    daemon.rpc_write_session(&id, &payload)
}

#[tauri::command]
pub(crate) fn chat_rpc_attach(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    id: String,
    attach_id: u64,
    stream_token: u64,
    on_line: Channel<String>,
) -> Result<(), String> {
    let repo = owned_chat_repo(&app, &state, &repo_path)?;
    let _ = load_root_omp(&repo, &id)?;
    let daemon = chat_daemon(&state, &repo)?;
    let mut stream = daemon.send(&daemon_client::rpc_attach_request(&id, attach_id))?;
    let line = read_socket_line(&mut stream).map_err(|error| match error {
        SocketReadError::Closed => "daemon closed".to_string(),
        SocketReadError::TimedOut => format!("daemon not responding after {}", format_daemon_timeout(DAEMON_CONTROL_TIMEOUT)),
    })?;
    let response: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
    if let Some(error) = daemon_client::reply_error(&response) {
        return Err(error.to_string());
    }
    let event_id = id.clone();
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let mut reader = BufReader::new(stream);
        let mut buf = String::new();
        loop {
            buf.clear();
            match reader.read_line(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = buf.trim_end_matches(['\n', '\r']).to_string();
                    if on_line.send(line).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = app.emit("session_stream_closed", json!({ "id": event_id, "attach_id": attach_id, "stream_token": stream_token }));
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn chat_detach(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String, attach_id: u64) -> Result<(), String> {
    let repo = owned_chat_repo(&app, &state, &repo_path)?;
    let _ = load_root_omp(&repo, &id)?;
    let daemon = chat_daemon(&state, &repo)?;
    daemon.detach_session(&id, attach_id)
}

#[tauri::command]
pub(crate) async fn chat_session_status(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String) -> Result<SessionObservation, String> {
    let repo = owned_chat_repo(&app, &state, &repo_path)?;
    let daemon = state.daemon_for(&repo);
    // Chat polls this every 1.5s; a sync command would run the daemon round trip on the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let meta = load_root_omp(&repo, &id)?;
        let live = daemon.as_ref().and_then(|daemon| daemon.session_status_observed(&id).ok().flatten());
        Ok(SessionObservation {
            lifecycle: lifecycle_from_structured(meta.started_at, meta.ended_at, meta.exit_code, live.as_ref().map(|live| &live.state)),
            state: live.as_ref().map(|live| live.state.clone()),
            checkpoint: meta.semantic,
            transport: live.map(|live| live.transport),
        })
    })
    .await
    .map_err(|error| format!("chat session status: {error}"))?
}

/// The chat's terminal hatch: respawn the thread's OMP on the same journal over the other transport
/// (`pty` = the OMP TUI, `rpc` = back to chat). The generic restate is bound to the active repo;
/// a chat thread can live in any known repo.
#[tauri::command]
pub(crate) async fn chat_restate(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String, transport: String) -> Result<(), String> {
    if transport != "pty" && transport != "rpc" {
        return Err("missing transport".into());
    }
    let repo = owned_chat_repo(&app, &state, &repo_path)?;
    let daemon = chat_daemon(&state, &repo)?;
    tauri::async_runtime::spawn_blocking(move || {
        load_root_omp(&repo, &id)?;
        daemon.restate_session(&id, &transport)
    })
    .await
    .map_err(|error| format!("chat restate: {error}"))?
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
    let repo = owned_chat_repo(&app, &state, &repo_path)?;
    let daemon = chat_daemon(&state, &repo)?;
    let meta = load_root_omp(&repo, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
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
    .map_err(|error| format!("chat terminal attach: {error}"))?
}

#[tauri::command]
pub(crate) fn chat_pty_write(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String, data: String) -> Result<(), String> {
    let repo = owned_chat_repo(&app, &state, &repo_path)?;
    let _ = load_root_omp(&repo, &id)?;
    chat_daemon(&state, &repo)?.write_session(&id, &data)
}

#[tauri::command]
pub(crate) fn chat_pty_resize(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let repo = owned_chat_repo(&app, &state, &repo_path)?;
    let _ = load_root_omp(&repo, &id)?;
    chat_daemon(&state, &repo)?.resize_session(&id, cols, rows)
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
    let repo = owned_chat_repo(&app, &state, &repo_path)?;
    let _ = load_root_omp(&repo, &id)?;
    let window = tauri::async_runtime::spawn_blocking(move || alinery_core::read_omp_window(&repo, "", &id, end, want))
        .await
        .map_err(|error| error.to_string())??;
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
