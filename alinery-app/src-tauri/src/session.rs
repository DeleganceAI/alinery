//! session: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

pub(crate) use alinery_core::SessionMeta;

pub(crate) fn load_session_meta_for(repo: &Path, slug: &str, id: &str) -> Result<SessionMeta, String> {
    let path = session_meta_path(repo, slug, id);
    let raw = fs::read_to_string(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    serde_json::from_str(&raw).map_err(|error| format!("parse {}: {error}", path.display()))
}

#[derive(Serialize, Clone)]
pub(crate) struct SessionDisplayMeta {
    #[serde(flatten)]
    pub(crate) meta: SessionMeta,
    pub(crate) name: Option<String>,
    pub(crate) name_source: Option<alinery_core::SessionNameSource>,
    pub(crate) name_error: Option<String>,
}

impl std::ops::Deref for SessionDisplayMeta {
    type Target = SessionMeta;
    fn deref(&self) -> &Self::Target {
        &self.meta
    }
}

#[derive(Serialize, Clone)]
pub(crate) struct SessionDisplayContext {
    pub(crate) session: SessionDisplayMeta,
    pub(crate) task_name: String,
    pub(crate) subtask_name: Option<String>,
}

fn project_session_display(repo: &Path, task_slug: &str, meta: SessionMeta) -> SessionDisplayMeta {
    let (name, name_source, name_error) = match alinery_core::read_session_name(repo, task_slug, &meta.id) {
        Ok(Some(value)) => (Some(value.name), Some(value.source), None),
        Ok(None) => (None, None, None),
        Err(error) => (None, None, Some(error.chars().take(256).collect())),
    };
    SessionDisplayMeta {
        meta,
        name,
        name_source,
        name_error,
    }
}

fn current_subtask_name(repo: &Path, session: &SessionMeta) -> Option<String> {
    if alinery_core::safe_component(&session.subtask_slug) != Some(session.subtask_slug.as_str()) {
        return None;
    }
    read_task(repo, &session.subtask_slug).ok().map(|task| task.name)
}

pub(crate) fn session_display_context_for_repo(repo: &Path, task_slug: &str, session_id: &str) -> Result<SessionDisplayContext, String> {
    if alinery_core::safe_component(task_slug) != Some(task_slug) || alinery_core::safe_component(session_id) != Some(session_id) {
        return Err("invalid task slug or session id".into());
    }
    let task = read_task(repo, task_slug)?;
    let meta = load_session_meta_for(repo, task_slug, session_id)?;
    if meta.id != session_id || task.slug != task_slug {
        return Err("retained display identity mismatch".into());
    }
    Ok(SessionDisplayContext {
        subtask_name: current_subtask_name(repo, &meta),
        session: project_session_display(repo, task_slug, meta),
        task_name: task.name,
    })
}

#[tauri::command]
pub(crate) fn rename_session<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    repo_path: String,
    task_slug: String,
    session_id: String,
    name: String,
) -> Result<alinery_core::SessionName, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    Ok(alinery_core::set_session_name(&repo, &task_slug, &session_id, &name, alinery_core::SessionNameSource::User)?.value)
}

#[tauri::command]
pub(crate) fn get_session_display<R: tauri::Runtime>(app: AppHandle<R>, repo_path: String, task_slug: String, session_id: String) -> Result<SessionDisplayContext, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    session_display_context_for_repo(&repo, &task_slug, &session_id)
}

#[derive(Serialize, Clone)]
pub(crate) struct SessionListItem {
    #[serde(flatten)]
    pub(crate) session: SessionDisplayMeta,
    pub(crate) task_slug: String,
    pub(crate) task_name: String,
    pub(crate) subtask_name: Option<String>,
    pub(crate) task_worktree: String,
    pub(crate) repo_path: String,
    pub(crate) playbook_title: String,
    pub(crate) step_title: String,
    pub(crate) is_playbook_step: bool,
}

#[derive(Deserialize, Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub(crate) struct SessionStatusRef {
    pub(crate) repo_path: String,
    pub(crate) task_slug: String,
    pub(crate) id: String,
}

#[derive(Deserialize, Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionNotificationClearRef {
    pub(crate) repo_path: String,
    pub(crate) task_slug: String,
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) notification_suppression: Option<alinery_core::NotificationSuppression>,
}

// Structured observation returned to the frontend for a single session.
// `state` is Some only when the daemon owns the session id; `checkpoint` is always
// read from meta so accepted completion remains visible while the daemon is offline.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct SessionObservation {
    pub(crate) lifecycle: LifecycleState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) state: Option<alinery_core::SessionState>,
    pub(crate) checkpoint: alinery_core::SemanticCheckpoint,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) transport: Option<alinery_core::SessionTransport>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct PreparedSessionMessageAction {
    pub(crate) text: String,
    pub(crate) provenance: SessionMessageActionProvenance,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct PreparedArtifactCommentSnapshot {
    pub(crate) artifact: String,
    pub(crate) review: String,
    pub(crate) comments_hash: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum SessionMessageActionProvenance {
    ArtifactComments { items: Vec<PreparedArtifactCommentSnapshot> },
    ReviewApproval { review_artifact: String },
}

pub(crate) fn prepare_review_approval_prompt_for(repo: &Path, task_slug: &str, review_artifact: &str) -> Result<PreparedSessionMessageAction, String> {
    let task = read_task(repo, task_slug)?;
    let artifact_path = artifact_file_path(repo, task_slug, review_artifact)?;
    let metadata = fs::metadata(&artifact_path).map_err(|error| format!("read {}: {error}", artifact_path.display()))?;
    if !metadata.is_file() {
        return Err(format!("review findings artifact is not a file: {}", artifact_path.display()));
    }
    let artifact_path = fs::canonicalize(&artifact_path).map_err(|error| format!("resolve {}: {error}", artifact_path.display()))?;
    let pr = if task.pr_url.is_empty() {
        "PR URL: not set in Alinery task metadata; infer it from the checked-out branch/remote if possible.".to_string()
    } else {
        format!("PR URL: {}", task.pr_url)
    };
    Ok(PreparedSessionMessageAction {
        text: [
            "Review playbook action: approve this PR through the harness, not through Alinery.".to_string(),
            pr,
            format!("Review findings artifact: {review_artifact}"),
            format!("Review findings path: {}", artifact_path.display()),
            "Read the findings artifact. If it contains no blocking work, submit an approving GitHub PR review or comment using your own GitHub capability.".to_string(),
            "Do not ask Alinery/the local app to call a GitHub approval API; the approval/comment is harness-owned.".to_string(),
            "After submitting or deciding not to submit, write or update the review-response artifact with the decision and evidence.".to_string(),
        ]
        .join("\n"),
        provenance: SessionMessageActionProvenance::ReviewApproval {
            review_artifact: review_artifact.to_string(),
        },
    })
}

pub(crate) fn finalize_session_message_actions_for(repo: &Path, id: &str, task_slug: &str, actions: &[SessionMessageActionProvenance]) -> Result<(), String> {
    let session = load_session_meta_for(repo, task_slug, id)?;
    if session.id != id {
        return Err("session id mismatch".into());
    }
    for action in actions {
        match action {
            SessionMessageActionProvenance::ArtifactComments { items } => {
                validate_artifact_comments_finalization(repo, task_slug, items)?;
            }
            SessionMessageActionProvenance::ReviewApproval { review_artifact } => {
                artifact_file_path(repo, task_slug, review_artifact)?;
            }
        }
    }
    for action in actions {
        match action {
            SessionMessageActionProvenance::ArtifactComments { items } => {
                finalize_artifact_comments_for(repo, task_slug, items)?;
            }
            SessionMessageActionProvenance::ReviewApproval { .. } => {}
        }
    }
    Ok(())
}

pub(crate) fn session_list_status_key(repo_path: &str, task_slug: &str, id: &str) -> String {
    format!("{repo_path}:{task_slug}:{id}")
}

// Only the tests build the meta path now (the daemon resolves its own); keep it as the
// canonical helper so a test and the daemon can't drift.
pub(crate) fn session_meta_path(repo: &Path, slug: &str, id: &str) -> PathBuf {
    let dir = if slug.is_empty() { root_sessions_dir(repo) } else { sessions_dir(repo, slug) };
    dir.join(format!("{id}.meta.json"))
}

pub(crate) fn session_list_items_for_repo(repo: &Path, repo_path: &str, include_archived_sessions: bool) -> Result<Vec<SessionListItem>, String> {
    let mut out = vec![];
    for task in list_tasks_for_repo(repo)? {
        if task.archived {
            continue;
        }
        let definition = retained_task_definition(repo, &task)?;
        let sessions = list_sessions_for_repo(repo, &task.slug)?;
        out.extend(sessions.into_iter().filter(|session| include_archived_sessions || !session.archived).map(|session| {
            let step = definition.as_ref().and_then(|definition| definition.step.iter().find(|step| step.key == session.phase));
            let is_playbook_step = !session.generic && !session.execution_id.is_empty() && step.is_some();
            let title = if session.generic {
                "Generic".into()
            } else {
                step.map(|step| step.title.clone()).unwrap_or_else(|| session.phase.clone())
            };
            SessionListItem {
                subtask_name: current_subtask_name(repo, &session),
                session: project_session_display(repo, &task.slug, session),
                task_slug: task.slug.clone(),
                task_name: task.name.clone(),
                task_worktree: task.worktree.clone(),
                repo_path: repo_path.to_string(),
                playbook_title: definition.as_ref().map(|definition| definition.title.clone()).unwrap_or_else(|| task.playbook.clone()),
                step_title: title,
                is_playbook_step,
            }
        }));
    }
    out.sort_by(|a, b| {
        b.session
            .created
            .cmp(&a.session.created)
            .then_with(|| a.task_slug.cmp(&b.task_slug))
            .then_with(|| a.session.id.cmp(&b.session.id))
    });
    Ok(out)
}

#[tauri::command]
pub(crate) fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    request: alinery_core::task_creation::CreateExecutionSessionRequest,
) -> Result<alinery_core::task_creation::CreateExecutionSessionReply, String> {
    let repo = require_owned_active_repo(&state)?;
    task_daemon_for(&repo, &request.task_slug, &app_config_path(&app)?)?.create_execution_session(&request)
}

#[tauri::command]
pub(crate) fn create_session_for_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    request: alinery_core::task_creation::CreateExecutionSessionRequest,
) -> Result<alinery_core::task_creation::CreateExecutionSessionReply, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    task_daemon_for(&repo, &request.task_slug, &app_config_path(&app)?)?.create_execution_session(&request)
}

fn completion_notification_checkpoint(value: &serde_json::Value) -> Option<u64> {
    value
        .get("semantic")
        .and_then(|semantic| semantic.get("phase_completed_at"))
        .and_then(serde_json::Value::as_u64)
}

fn exit_notification_checkpoint(value: &serde_json::Value) -> Option<u64> {
    value
        .get("exit_code")
        .and_then(serde_json::Value::as_i64)
        .filter(|code| *code != 0)
        .and_then(|_| value.get("ended_at").and_then(serde_json::Value::as_u64))
}

fn stamp_notification_checkpoint(value: &mut serde_json::Value, field: &str, checkpoint: Option<u64>) {
    let Some(checkpoint) = checkpoint else {
        return;
    };
    let prior = value.get(field).and_then(serde_json::Value::as_u64).unwrap_or(0);
    value[field] = json!(prior.max(checkpoint));
}

fn notification_checkpoint_advances(value: &serde_json::Value, field: &str, checkpoint: Option<u64>) -> bool {
    checkpoint.is_some_and(|checkpoint| value.get(field).and_then(serde_json::Value::as_u64).is_none_or(|prior| checkpoint > prior))
}

fn session_notification_path(repo: &Path, task_slug: &str, id: &str) -> Result<PathBuf, String> {
    let task_slug = alinery_core::safe_component(task_slug).ok_or_else(|| "invalid task slug".to_string())?;
    let id = alinery_core::safe_component(id).ok_or_else(|| "invalid session id".to_string())?;
    let path = session_meta_path(repo, task_slug, id);
    fs::metadata(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

pub(crate) fn mark_session_notification_read_in(repo: &Path, task_slug: &str, id: &str) -> Result<(), String> {
    let path = session_notification_path(repo, task_slug, id)?;
    let persisted: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let completion = completion_notification_checkpoint(&persisted);
    let exit = exit_notification_checkpoint(&persisted);
    if !notification_checkpoint_advances(&persisted, "notification_read_at", completion) && !notification_checkpoint_advances(&persisted, "exit_notification_read_at", exit) {
        return Ok(());
    }
    stamp_meta(&path, |value| {
        stamp_notification_checkpoint(value, "notification_read_at", completion);
        stamp_notification_checkpoint(value, "exit_notification_read_at", exit);
    })
}

pub(crate) fn clear_session_notifications_in(repo: &Path, refs: &[SessionNotificationClearRef]) -> Result<(), String> {
    for reference in refs {
        mark_session_notification_read_in(repo, &reference.task_slug, &reference.id)?;
        if let Some(suppression) = &reference.notification_suppression {
            let path = session_notification_path(repo, &reference.task_slug, &reference.id)?;
            stamp_meta(&path, |value| value["notification_suppression"] = json!(suppression))?;
        }
    }
    Ok(())
}

fn mark_session_exit_notification_read_in(repo: &Path, task_slug: &str, id: &str) -> Result<(), String> {
    let path = session_notification_path(repo, task_slug, id)?;
    let persisted: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let exit = exit_notification_checkpoint(&persisted);
    if !notification_checkpoint_advances(&persisted, "exit_notification_read_at", exit) {
        return Ok(());
    }
    stamp_meta(&path, |value| stamp_notification_checkpoint(value, "exit_notification_read_at", exit))
}

#[tauri::command]
pub(crate) fn mark_session_notification_read(app: AppHandle, state: State<'_, AppState>, repo_path: String, task_slug: String, id: String) -> Result<(), String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    mark_session_notification_read_in(&repo, &task_slug, &id)
}

#[tauri::command]
pub(crate) fn clear_session_notifications(app: AppHandle, state: State<'_, AppState>, refs: Vec<SessionNotificationClearRef>) -> Result<(), String> {
    for reference in refs {
        let repo = target_repo_for_app(&app, &reference.repo_path)?;
        require_repo_owned(&state, &repo)?;
        clear_session_notifications_in(&repo, std::slice::from_ref(&reference))?;
    }
    Ok(())
}

pub(crate) fn unended_task_session_refs_for_repo(repo: &Path) -> Vec<(String, String)> {
    let mut refs = Vec::new();
    let Ok(tasks) = list_tasks_for_repo(repo) else {
        return refs;
    };
    for task in tasks {
        let Ok(sessions) = list_sessions_for_repo(repo, &task.slug) else {
            continue;
        };
        refs.extend(
            sessions
                .into_iter()
                .filter(|session| session.started_at.is_some() && session.ended_at.is_none())
                .map(|session| (task.slug.clone(), session.id)),
        );
    }
    refs.sort();
    refs
}

pub(crate) fn acknowledge_exited_session_refs(repo: &Path, refs: &[(String, String)]) -> Result<(), String> {
    let errors = refs
        .iter()
        .filter_map(|(task_slug, id)| {
            mark_session_exit_notification_read_in(repo, task_slug, id)
                .err()
                .map(|error| format!("{task_slug}/{id}: {error}"))
        })
        .collect::<Vec<_>>();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[tauri::command]
pub(crate) async fn list_sessions(app: AppHandle, task_slug: String, repo_path: Option<String>) -> Result<Vec<SessionDisplayMeta>, String> {
    let repo = match repo_path {
        Some(path) => target_repo_for_app(&app, &path)?,
        None => active_repo()?,
    };
    Ok(list_sessions_for_repo(&repo, &task_slug)?
        .into_iter()
        .map(|meta| project_session_display(&repo, &task_slug, meta))
        .collect())
}

#[tauri::command]
pub(crate) async fn list_session_items(app: AppHandle, all_repos: bool, include_archived: bool) -> Result<Vec<SessionListItem>, String> {
    let repos = if all_repos {
        load_app_config(&app).known_repos
    } else {
        vec![active_repo()?.to_string_lossy().to_string()]
    };
    let mut out = vec![];
    for repo_path in dedupe_known_repos(repos) {
        let repo = PathBuf::from(&repo_path);
        out.extend(session_list_items_for_repo(&repo, &repo_path, include_archived)?);
    }
    out.sort_by(|a, b| {
        b.session
            .created
            .cmp(&a.session.created)
            .then_with(|| a.repo_path.cmp(&b.repo_path))
            .then_with(|| a.task_slug.cmp(&b.task_slug))
            .then_with(|| a.session.id.cmp(&b.session.id))
    });
    Ok(out)
}

#[allow(dead_code)]
pub(crate) fn list_root_sessions_for_repo(repo: &Path) -> Result<Vec<SessionMeta>, String> {
    list_sessions_in_dir(root_sessions_dir(repo))
}

pub(crate) fn list_sessions_for_repo(repo: &Path, task_slug: &str) -> Result<Vec<SessionMeta>, String> {
    list_sessions_in_dir(sessions_dir(repo, task_slug))
}

pub(crate) fn list_sessions_in_dir(dir: PathBuf) -> Result<Vec<SessionMeta>, String> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    let entries = fs::read_dir(&dir).map_err(|error| format!("read {}: {error}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("read {}: {error}", dir.display()))?;
        let path = entry.path();
        if !path.to_string_lossy().ends_with(".meta.json") {
            continue;
        }
        let s = fs::read_to_string(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
        out.push(serde_json::from_str::<SessionMeta>(&s).map_err(|error| format!("parse {}: {error}", path.display()))?);
    }
    // created is seconds-granularity, so two same-second sessions would tie and fall
    // to arbitrary read_dir order. Break ties on id (= "s{nanos}", lexicographically
    // chronological) so "latest session" — hence the DERIVED current_phase / kanban
    // column — is deterministic even for rapid create-then-advance.
    out.sort_by(|a, b| a.created.cmp(&b.created).then_with(|| a.id.cmp(&b.id)));
    Ok(out)
}

pub(crate) fn archive_session_in(app: &AppHandle, state: &AppState, repo: &Path, task_slug: String, id: String) -> Result<(), String> {
    let task_slug = task_slug.trim().to_string();
    if task_slug.is_empty() {
        return Err("sessions must be attached to a task".into());
    }
    // Kill+reap the pty on its OWNING lane FIRST — own or a foreign daemon, routed via
    // with_session_client — so archiving can't leak a cross-lane daemon-owned pty; the reap
    // stamps ended_at/exit_code. An unknown/offline owner yields "unknown"/Err, so we skip
    // straight to the flag flip (issue #24 P6 / #71 cross-lane).
    let owned = with_session_client(state, repo, &task_slug, &id, |d| d.session_status_observed(&id))
        .map(|s| s.is_some())
        .unwrap_or(false);
    if owned {
        with_session_client(state, repo, &task_slug, &id, |d| d.kill_session(&id))?;
    }
    // stamp_meta does a read-modify-write of only `archived`, so it can't clobber the
    // daemon's concurrently-written started/ended/exit fields (issue #24 three-writer safety).
    stamp_meta(&session_meta_path(repo, &task_slug, &id), |v| v["archived"] = serde_json::json!(true))?;
    emit_with(app, || {
        let ids = alinery_core::telemetry_ids_for_session(repo, &task_slug, &id);
        alinery_core::TelemetryEvent::SessionArchive {
            source: alinery_core::TelemetrySource::App,
            killed_live: owned,
            session_id: ids.session,
            task_id: ids.task,
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn archive_session(app: AppHandle, state: State<'_, AppState>, task_slug: String, id: String) -> Result<(), String> {
    let repo = require_owned_active_repo(&state)?;
    // Resolve managed routing state inside the worker; no borrowed command State crosses threads.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        archive_session_in(&app, &state, &repo, task_slug, id)
    })
    .await;
    result.map_err(|e| format!("archive session task: {e}"))?
}

#[tauri::command]
pub(crate) async fn archive_session_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, task_slug: String, id: String) -> Result<(), String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        archive_session_in(&app, &state, &repo, task_slug, id)
    })
    .await;
    result.map_err(|e| format!("archive session task: {e}"))?
}

// Default derived via #[derive(Default)] on struct (Mutex<Option<T>> defaults to None)

pub(crate) const SESSION_CHANNEL_BATCH_BYTES: usize = 16 * 1024;
pub(crate) const SESSION_CHANNEL_FLUSH_AFTER: Duration = Duration::from_millis(8);
pub(crate) const SESSION_CHANNEL_HEADER_BYTES: usize = size_of::<u32>();
pub(crate) const TAURI_RAW_FETCH_MIN_BYTES: usize = 1024;

// Tauri 2.11 routes raw bodies shorter than 1 KiB through `webview.eval`, compiling a fresh
// JavaScript array literal for every message. Frame and pad the app-only channel body so even an
// idle-flushed short batch takes Tauri's binary fetch path; the frontend strips this envelope.
pub(crate) fn frame_session_channel_bytes(bytes: Vec<u8>) -> Vec<u8> {
    let payload_len = u32::try_from(bytes.len()).expect("session channel batch exceeds u32");
    let frame_len = (SESSION_CHANNEL_HEADER_BYTES + bytes.len()).max(TAURI_RAW_FETCH_MIN_BYTES);
    let mut framed = Vec::with_capacity(frame_len);
    framed.extend_from_slice(&payload_len.to_le_bytes());
    framed.extend_from_slice(&bytes);
    framed.resize(frame_len, 0);
    framed
}

// Tauri delivers raw channel bodies below 1 KiB through `webview.eval` as JavaScript array
// literals. Chatty TUIs emit many sub-KiB PTY reads, so forwarding each read independently can
// saturate WebKit's main thread even when the byte rate is modest. Briefly coalesce consecutive
// reads here; this thread may block without affecting alineryd's PTY reader or other clients.
pub(crate) fn pump_session_stream(mut stream: UnixStream, mut send: impl FnMut(Vec<u8>) -> bool) {
    let _ = stream.set_read_timeout(Some(SESSION_CHANNEL_FLUSH_AFTER));
    let mut read_buf = [0u8; 8192];
    let mut pending = Vec::with_capacity(SESSION_CHANNEL_BATCH_BYTES);

    loop {
        match stream.read(&mut read_buf) {
            Ok(0) => {
                if !pending.is_empty() {
                    let _ = send(pending);
                }
                break;
            }
            Ok(n) => {
                pending.extend_from_slice(&read_buf[..n]);
                if pending.len() >= SESSION_CHANNEL_BATCH_BYTES {
                    let batch = std::mem::replace(&mut pending, Vec::with_capacity(SESSION_CHANNEL_BATCH_BYTES));
                    if !send(batch) {
                        break;
                    }
                }
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                if !pending.is_empty() {
                    let batch = std::mem::replace(&mut pending, Vec::with_capacity(SESSION_CHANNEL_BATCH_BYTES));
                    if !send(batch) {
                        break;
                    }
                }
            }
            Err(_) => {
                if !pending.is_empty() {
                    let _ = send(pending);
                }
                break;
            }
        }
    }
}

// Root (taskless) drawer open guard. Used only when task_slug is empty: allow when
// existing meta is no-harness, or when no meta exists yet (the only remaining root
// session type is the drawer). Meta wins when present. Harness is not on the wire.
pub(crate) fn allow_root_session_open(meta_harness: Option<&str>) -> bool {
    match meta_harness {
        Some(harness) => harness == alinery_core::NO_HARNESS_KEY,
        None => true,
    }
}

pub(crate) fn hosted_refresh_needed(intent: &str, harness: &str, model: &str) -> bool {
    harness == alinery_core::DEFAULT_HARNESS_KEY && matches!(intent, daemon_client::ops::SPAWN | daemon_client::ops::RESUME) && (model.trim().is_empty() || is_hosted_model(model))
}

async fn refresh_hosted_inference_before_open(app: AppHandle, intent: &str, harness: &str, model: &str) -> Result<(), String> {
    if !hosted_refresh_needed(intent, harness, model) {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || refresh_hosted_inference_for_spawn(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn ensure_drawer_terminal(state: State<'_, AppState>) -> Result<SessionMeta, String> {
    let repo = require_owned_active_repo(&state)?;
    let reply = state
        .daemon_for(&repo)
        .ok_or("daemon not connected")?
        .create_execution_session(&alinery_core::task_creation::CreateExecutionSessionRequest {
            task_slug: String::new(),
            target: alinery_core::task_creation::ExecutionSessionTarget::Auxiliary {
                harness: alinery_core::NO_HARNESS_KEY.into(),
                model: None,
                prompt: None,
            },
            launch_override: None,
            prompt_extra: None,
            handoff_artifact: None,
            start: false,
        })?;
    Ok(reply.session)
}

// Open a session: REATTACH if its pty is still running (replay scrollback, then go
// live), else spawn a fresh harness in `cwd`. This is what lets a session keep
// running in the background — switching away no longer kills it, and switching
// back shows the same process at its current screen, not a fresh one. Distinct ids
// coexist: the "bag of cheap sessions", many ptys alive at once.
// M4: the spawn is GENERIC over the registry — which binary/args/env and how the seeded
// prompt is delivered come from the session's harness (read from its meta), not hardcoded.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn open_session(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
    cwd: String,
    attach_id: u64,
    stream_token: u64,
    task_slug: Option<String>,
    phase: Option<String>,
    model: Option<String>,
    intent: Option<String>,
    resume_token: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    on_bytes: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let task_slug_clean = task_slug.clone().unwrap_or_default();
    let slug_trim = task_slug_clean.trim();
    if slug_trim.is_empty() {
        let meta_harness = active_repo().ok().and_then(|repo| {
            let path = session_meta_path(&repo, "", &id);
            fs::read_to_string(path).ok().and_then(|s| serde_json::from_str::<SessionMeta>(&s).ok()).map(|m| m.harness)
        });
        if !allow_root_session_open(meta_harness.as_deref()) {
            return Err("root sessions are limited to no-harness drawer".into());
        }
    }
    let intent = intent.as_deref().unwrap_or(daemon_client::ops::SPAWN);
    if !daemon_client::is_known_open_intent(intent) {
        return Err(format!("unknown session intent '{intent}'"));
    }
    let repo = require_owned_active_repo(&state)?;
    let mut harness = String::new();
    let mut session_model = model.clone().filter(|m| !m.is_empty()).unwrap_or_default();
    if !slug_trim.is_empty() {
        let task = read_task(&repo, slug_trim)?;
        if task.engine_version < 2 {
            return Err("pre-v2 task data is read-only; create a new v2 task to launch sessions".into());
        }
        if task.draft || task.archived {
            return Err("draft or archived tasks cannot launch sessions".into());
        }
        task_daemon_for(&repo, &task.slug, &app_config_path(&app)?)?.get_task_execution(&alinery_core::task_creation::GetTaskExecutionRequest { task_slug: task.slug.clone() })?;
        if let Some(launch) = alinery_core::read_meta_launch_fields(&repo, slug_trim, &id) {
            if !alinery_core::is_allowed_launch_harness(&launch.harness) {
                return Err(format!("unknown harness '{}'", launch.harness));
            }
            harness = launch.harness;
            if session_model.is_empty() {
                session_model = launch.model;
            }
        }
    }
    refresh_hosted_inference_before_open(app.clone(), intent, &harness, &session_model).await?;
    let daemon = if intent == daemon_client::ops::ATTACH {
        client_for_session(&state, &repo, slug_trim, &id)?
    } else {
        state.daemon().ok_or("daemon not connected")?
    };
    open_daemon_session(
        &daemon,
        &id,
        &cwd,
        Some(slug_trim),
        phase.as_deref(),
        model.as_deref(),
        attach_id,
        stream_token,
        intent,
        resume_token.as_deref(),
        cols,
        rows,
        on_bytes,
        app,
    )
}

// Detach the frontend without killing the pty: the session keeps running in the
// background (scrollback keeps filling) until you reopen it. Called when a terminal
// pane unmounts so the reader stops forwarding to a torn-down channel. Only clears
// the sink if `attach_id` still matches the current attach — a stale detach racing a
// newer open_session is a no-op, so it can't clobber the live sink (freeze the feed).
#[tauri::command]
pub(crate) fn detach_session(state: State<'_, AppState>, id: String, attach_id: u64) -> Result<(), String> {
    let _repo = require_owned_active_repo(&state)?;
    // Route cache only (no task_slug on this command). Miss → own lane.
    let daemon = cached_or_own_client(&state, &id).ok_or("daemon not connected")?;
    match daemon.detach_session(&id, attach_id) {
        Ok(()) => Ok(()),
        Err(e) => {
            state.clear_session_route(&id);
            let own = state.daemon().ok_or_else(|| e.clone())?;
            if own.socket_path == daemon.socket_path {
                return Err(e);
            }
            own.detach_session(&id, attach_id)
        }
    }
}

// Frontend keystrokes -> pty. No-op if the session isn't registered yet.
#[tauri::command]
pub(crate) fn write_session(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    let _repo = require_owned_active_repo(&state)?;
    let daemon = cached_or_own_client(&state, &id).ok_or("daemon not connected")?;
    match daemon.write_session(&id, &data) {
        Ok(()) => Ok(()),
        Err(e) => {
            state.clear_session_route(&id);
            let own = state.daemon().ok_or_else(|| e.clone())?;
            if own.socket_path == daemon.socket_path {
                return Err(e);
            }
            own.write_session(&id, &data)
        }
    }
}

#[tauri::command]
pub(crate) fn prepare_review_approval_prompt(state: State<'_, AppState>, task_slug: String, review_artifact: String) -> Result<PreparedSessionMessageAction, String> {
    let repo = require_owned_active_repo(&state)?;
    prepare_review_approval_prompt_for(&repo, &task_slug, &review_artifact)
}
#[tauri::command]
pub(crate) fn finalize_session_message_actions(state: State<'_, AppState>, id: String, task_slug: String, actions: Vec<SessionMessageActionProvenance>) -> Result<(), String> {
    let repo = require_owned_active_repo(&state)?;
    finalize_session_message_actions_for(&repo, &id, &task_slug, &actions)
}

// Resize the pty so the TUI reflows. No-op if the session isn't registered yet.
#[tauri::command]
pub(crate) fn resize_session(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let _repo = require_owned_active_repo(&state)?;
    let daemon = cached_or_own_client(&state, &id).ok_or("daemon not connected")?;
    match daemon.resize_session(&id, cols, rows) {
        Ok(()) => Ok(()),
        Err(e) => {
            state.clear_session_route(&id);
            let own = state.daemon().ok_or_else(|| e.clone())?;
            if own.socket_path == daemon.socket_path {
                return Err(e);
            }
            own.resize_session(&id, cols, rows)
        }
    }
}

// Structured observation for a single session: lifecycle from process state or meta fallback,
// structured state axes when the daemon owns the id, checkpoint always from meta.
#[tauri::command]
pub(crate) async fn session_status(app: AppHandle, id: String, task_slug: Option<String>) -> SessionObservation {
    let app_state = app.state::<AppState>();
    let slug = task_slug.as_deref().unwrap_or("");
    let meta = active_repo()
        .ok()
        .map(|repo| session_meta_path(&repo, slug, &id))
        .and_then(|p| fs::read_to_string(&p).ok())
        .and_then(|s| serde_json::from_str::<SessionMeta>(&s).ok());

    let (started, ended, exit) = meta.as_ref().map(|m| (m.started_at, m.ended_at, m.exit_code)).unwrap_or((None, None, None));
    let checkpoint = meta.as_ref().map(|m| m.semantic.clone()).unwrap_or_default();
    let live = active_repo()
        .ok()
        .and_then(|repo| with_session_client(&app_state, &repo, slug, &id, |d| d.session_status_observed(&id)).ok().flatten());

    let lifecycle = lifecycle_from_structured(started, ended, exit, live.as_ref().map(|live| &live.state));
    SessionObservation {
        lifecycle,
        state: live.as_ref().map(|live| live.state.clone()),
        checkpoint,
        transport: live.map(|live| live.transport),
    }
}

// Thin helper: extract process axis from optional structured state and call classify.
// This is the single place that bridges SessionState to LifecycleState in the app layer.
pub(crate) fn lifecycle_from_structured(
    started_at: Option<u64>,
    ended_at: Option<u64>,
    exit_code: Option<i32>,
    daemon_state: Option<&alinery_core::SessionState>,
) -> LifecycleState {
    classify(started_at, ended_at, exit_code, daemon_state.map(|s| &s.process))
}

#[derive(Clone)]
pub(crate) struct SessionStatusLaneRow {
    pub(crate) key: String,
    pub(crate) id: String,
    pub(crate) meta: SessionMeta,
}

pub(crate) fn unknown_session_observation(key: String) -> SessionObservation {
    let _ = key; // key is used by the caller, not stored in the observation itself
    SessionObservation {
        lifecycle: LifecycleState::NeverStarted,
        state: None,
        checkpoint: alinery_core::SemanticCheckpoint::default(),
        transport: None,
    }
}

pub(crate) fn session_list_statuses_with_repo_resolver(refs: &[SessionStatusRef], resolve_repo: impl Fn(&str) -> Result<PathBuf, String>) -> HashMap<String, SessionObservation> {
    let mut result: HashMap<String, SessionObservation> = HashMap::new();
    let mut grouped = BTreeMap::<PathBuf, Vec<SessionStatusLaneRow>>::new();
    let mut resolved_repos = HashMap::<String, Option<PathBuf>>::new();
    let own_namespace = alineryd_socket_namespace().unwrap_or_default();

    for reference in refs {
        let key = session_list_status_key(&reference.repo_path, &reference.task_slug, &reference.id);
        if result.contains_key(&key) {
            continue;
        }
        result.insert(key.clone(), unknown_session_observation(key.clone()));

        let Some(repo) = resolved_repos
            .entry(reference.repo_path.clone())
            .or_insert_with(|| resolve_repo(&reference.repo_path).ok())
            .clone()
        else {
            continue;
        };
        let Ok(contents) = fs::read_to_string(session_meta_path(&repo, &reference.task_slug, &reference.id)) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<SessionMeta>(&contents) else {
            continue;
        };
        // Replace the NeverStarted placeholder with the meta-derived observation.
        // When a daemon lane fails or is offline, callers see the correct historical lifecycle.
        let meta_lifecycle = lifecycle_from_structured(meta.started_at, meta.ended_at, meta.exit_code, None);
        result.insert(
            key.clone(),
            SessionObservation {
                lifecycle: meta_lifecycle,
                state: None,
                checkpoint: meta.semantic.clone(),
                transport: None,
            },
        );
        let socket_path = route_socket_path(&repo, &own_namespace, &meta.daemon_namespace).unwrap_or_else(|| current_alineryd_socket_path(&repo));
        grouped.entry(socket_path).or_default().push(SessionStatusLaneRow {
            key,
            id: reference.id.clone(),
            meta,
        });
    }

    if grouped.is_empty() {
        return result;
    }

    let worker_count = grouped.len().min(4);
    let (job_tx, job_rx) = std::sync::mpsc::channel::<(PathBuf, Vec<SessionStatusLaneRow>)>();
    let job_rx = std::sync::Arc::new(Mutex::new(job_rx));
    let (result_tx, result_rx) = std::sync::mpsc::channel::<(String, SessionObservation)>();

    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            let job_rx = std::sync::Arc::clone(&job_rx);
            let result_tx = result_tx.clone();
            scope.spawn(move || loop {
                let job = job_rx.lock().unwrap_or_else(|e| e.into_inner()).recv();
                let Ok((socket_path, rows)) = job else {
                    break;
                };
                let Ok(statuses) = DaemonClient::connect_path(socket_path).and_then(|client| client.session_statuses_observed()) else {
                    continue;
                };
                // Build id -> live status from daemon list response.
                let daemon_live: HashMap<String, (alinery_core::SessionState, alinery_core::SessionTransport)> =
                    statuses.into_iter().map(|s| (s.id, (s.state, s.transport))).collect();

                for row in rows {
                    let live = daemon_live.get(&row.id).cloned();
                    let daemon_state = live.as_ref().map(|(state, _)| state.clone());
                    let lifecycle = lifecycle_from_structured(row.meta.started_at, row.meta.ended_at, row.meta.exit_code, daemon_state.as_ref());
                    let checkpoint = row.meta.semantic.clone();
                    let observation = SessionObservation {
                        lifecycle,
                        state: daemon_state,
                        checkpoint,
                        transport: live.map(|(_, transport)| transport),
                    };
                    let _ = result_tx.send((row.key, observation));
                }
            });
        }
        for job in grouped {
            let _ = job_tx.send(job);
        }
        drop(job_tx);
        drop(result_tx);
    });

    result.extend(result_rx);
    result
}

#[cfg(test)]
pub(crate) fn session_list_statuses_for_refs(refs: &[SessionStatusRef]) -> HashMap<String, SessionObservation> {
    session_list_statuses_with_repo_resolver(refs, |repo_path| Ok(PathBuf::from(repo_path)))
}

#[tauri::command]
pub(crate) async fn session_list_statuses(app: AppHandle, refs: Vec<SessionStatusRef>) -> HashMap<String, SessionObservation> {
    session_list_statuses_with_repo_resolver(&refs, |repo_path| target_repo_for_app(&app, repo_path))
}
// Task pages render several session rows at once. Resolve all of their daemon states through one
// app IPC call and one `list` request per owning daemon lane instead of starting a poller per row.
#[tauri::command]
pub(crate) async fn session_statuses(app: AppHandle, ids: Vec<String>, task_slug: String) -> HashMap<String, SessionObservation> {
    let app_state = app.state::<AppState>();
    let repo = active_repo().ok();
    let mut metadata: HashMap<String, Option<SessionMeta>> = HashMap::new();
    let mut clients = BTreeMap::<PathBuf, DaemonClient>::new();

    for id in &ids {
        let meta = repo
            .as_ref()
            .map(|repo| session_meta_path(repo, &task_slug, id))
            .and_then(|path| fs::read_to_string(path).ok())
            .and_then(|contents| serde_json::from_str::<SessionMeta>(&contents).ok());
        metadata.insert(id.clone(), meta);

        // Board observation only: a session whose owning daemon is unreachable *or*
        // incompatible simply contributes no live status, exactly as before. The mismatch
        // is refused where it would matter (attach/write/resize/detach), not here.
        if let Some(client) = repo.as_ref().and_then(|repo| client_for_session(&app_state, repo, &task_slug, id).ok()) {
            clients.entry(client.socket_path.clone()).or_insert(client);
        }
    }

    // Collect structured state from all relevant daemon lanes.
    let daemon_live: HashMap<String, (alinery_core::SessionState, alinery_core::SessionTransport)> = clients
        .into_values()
        .filter_map(|client| client.session_statuses_observed().ok())
        .flatten()
        .map(|s| (s.id, (s.state, s.transport)))
        .collect();

    ids.into_iter()
        .map(|id| {
            let meta = metadata.remove(&id).flatten();
            let (started, ended, exit) = meta.as_ref().map(|m| (m.started_at, m.ended_at, m.exit_code)).unwrap_or((None, None, None));
            let checkpoint = meta.as_ref().map(|m| m.semantic.clone()).unwrap_or_default();
            let live = daemon_live.get(&id).cloned();
            let daemon_state = live.as_ref().map(|(state, _)| state.clone());
            let lifecycle = lifecycle_from_structured(started, ended, exit, daemon_state.as_ref());
            (
                id,
                SessionObservation {
                    lifecycle,
                    state: daemon_state,
                    checkpoint,
                    transport: live.map(|(_, transport)| transport),
                },
            )
        })
        .collect()
}

#[tauri::command]
pub(crate) fn restate_session(state: State<'_, AppState>, id: String, transport: String) -> Result<(), String> {
    let _repo = require_owned_active_repo(&state)?;
    if transport != "pty" && transport != "rpc" {
        return Err("missing transport".into());
    }
    let daemon = cached_or_own_client(&state, &id).ok_or("daemon not connected")?;
    daemon.restate_session(&id, &transport)
}

/// Bring up the reserved setup session and return its id.
///
/// The dialog that follows uses the ordinary `rpc_attach_session` / `rpc_write_session` commands
/// against that id -- `cached_or_own_client` has no route for it, so it falls through to the
/// active repo's daemon, which is the one that owns it.
#[tauri::command]
pub(crate) fn omp_setup_session(state: State<'_, AppState>) -> Result<String, String> {
    let _repo = require_owned_active_repo(&state)?;
    let daemon = state.daemon().ok_or("daemon not connected")?;
    daemon.omp_setup()
}

#[tauri::command]
pub(crate) fn rpc_write_session(state: State<'_, AppState>, id: String, payload: Value) -> Result<(), String> {
    let _repo = require_owned_active_repo(&state)?;
    let daemon = cached_or_own_client(&state, &id).ok_or("daemon not connected")?;
    daemon.rpc_write_session(&id, &payload)
}

#[tauri::command]
pub(crate) fn rpc_attach_session(state: State<'_, AppState>, app: AppHandle, id: String, attach_id: u64, stream_token: u64, on_line: Channel<String>) -> Result<(), String> {
    let _repo = require_owned_active_repo(&state)?;
    let daemon = cached_or_own_client(&state, &id).ok_or("daemon not connected")?;
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
pub(crate) fn start_session(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: Option<String>,
    task_slug: String,
    session_id: String,
) -> Result<alinery_core::task_creation::CreateExecutionSessionReply, String> {
    let repo = match repo_path {
        Some(path) => target_repo_for_app(&app, &path)?,
        None => require_owned_active_repo(&state)?,
    };
    require_repo_owned(&state, &repo)?;
    task_daemon_for(&repo, &task_slug, &app_config_path(&app)?)?.start_session(&alinery_core::task_creation::StartSessionRequest { task_slug, session_id })
}

// Terminate a live daemon-owned session's harness process group and reap it (issue #24 P6).
// The daemon awaits its own reap, so on return the meta is stamped and the id is dropped.
#[tauri::command]
pub(crate) fn kill_session(app: AppHandle, state: State<'_, AppState>, id: String, task_slug: String) -> Result<(), String> {
    let repo = require_owned_active_repo(&state)?;
    with_session_client(&state, &repo, &task_slug, &id, |d| d.kill_session(&id))?;
    state.clear_session_route(&id);
    emit_with(&app, || {
        let ids = alinery_core::telemetry_ids_for_session(&repo, &task_slug, &id);
        alinery_core::TelemetryEvent::SessionKill {
            source: alinery_core::TelemetrySource::App,
            session_id: ids.session,
            task_id: ids.task,
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn kill_session_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, id: String, task_slug: String) -> Result<(), String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    with_session_client(&state, &repo, &task_slug, &id, |d| d.kill_session(&id))?;
    state.clear_session_route(&id);
    Ok(())
}

/// True when the phase artifact for this session exists and is non-empty.
/// This is a content feature (artifact listing/rendering), not a completion signal.
#[tauri::command]
pub(crate) fn session_artifact_ready(id: String, task_slug: String) -> bool {
    let Ok(repo) = active_repo() else {
        return false;
    };
    let Ok(contents) = fs::read_to_string(session_meta_path(&repo, &task_slug, &id)) else {
        return false;
    };
    let Ok(meta) = serde_json::from_str::<SessionMeta>(&contents) else {
        return false;
    };
    artifact_file_path(&repo, &task_slug, &meta.artifact)
        .ok()
        .and_then(|path| fs::metadata(path).ok())
        .is_some_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

// One backward page of a session's OMP journal, as a JSON header line followed by the raw window
// bytes. The body crosses IPC as `tauri::ipc::Response` (an ArrayBuffer): a `Vec<u8>` return would
// be serialized as a JSON array of numbers, which measures 3.4x on the wire and forces the webview
// to materialise a multi-megabyte string and a per-byte number array before parsing a single row.
// Framing the header as its own line means the client's existing newline split does the work.
#[tauri::command]
pub(crate) async fn read_session_omp(id: String, task_slug: Option<String>, end: Option<u64>, want: Option<u64>) -> Result<tauri::ipc::Response, String> {
    let repo = active_repo()?;
    let slug = task_slug.unwrap_or_default();
    let window = tauri::async_runtime::spawn_blocking(move || alinery_core::read_omp_window(&repo, &slug, &id, end, want))
        .await
        .map_err(|error| error.to_string())??;
    let mut body = serde_json::to_vec(&serde_json::json!({
        "start": window.start,
        "end": window.end,
        "length": window.length,
    }))
    .map_err(|error| error.to_string())?;
    body.push(b'\n');
    body.extend_from_slice(&window.data);
    Ok(tauri::ipc::Response::new(body))
}

#[tauri::command]
pub(crate) fn read_session_history(id: String, task_slug: Option<String>, offset: Option<u64>, limit: Option<u64>) -> Result<Vec<u8>, String> {
    let repo = active_repo()?;
    let slug = task_slug.unwrap_or_default();
    alinery_core::read_session_history(&repo, &slug, &id, offset, limit).map(|result| result.data)
}
