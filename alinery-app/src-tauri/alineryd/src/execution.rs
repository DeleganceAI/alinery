//! Durable graph orchestration. Filesystem transitions precede process effects.
use super::*;
use alinery_core::{execution::*, task_creation::*, playbook_scheduler::reconcile_graph};
use std::collections::BTreeSet;

fn mutate_execution_state<T>(repo: &Path, slug: &str, lane: &str, operation: &str,
    mutate: impl FnOnce(&alinery_core::playbook::NormalizedPlaybook, &mut TaskExecutionState) -> Result<T, String>) -> Result<T, String> {
    alinery_core::execution::mutate_execution_state(repo, slug, lane, execution_config_identity(), operation, mutate)
}

pub(super) fn product(repo: &Path, app_config: &Path) -> Result<LaunchChoices, String> {
    let defaults = alinery_core::read_scoped_settings_strict(app_config, repo)?.effective.defaults;
    Ok(LaunchChoices { harness: "omp".into(), model: alinery_core::omp_default_model(&defaults) })
}
fn project(repo: &Path, slug: &str, state: &TaskExecutionState, definition: &alinery_core::playbook::NormalizedPlaybook, record: &ExecutionRecord, extra: &str) -> Result<SessionMeta, String> {
    let task = read_task(repo, slug).ok_or("missing task")?;
    let step = definition.step.iter().find(|s| s.key == record.candidate.step_key).ok_or("missing step")?;
    let path = session_meta_path(repo, slug, &record.owner_session_id);
    let existing = read_session_meta_full(&path);
    let mut meta = existing.clone().unwrap_or_default();
    meta.id = record.owner_session_id.clone();
    meta.execution_id = record.id.clone(); meta.execution_revision = state.revision;
    meta.worktree = task.worktree.clone(); meta.phase = step.key.clone();
    meta.harness = record.launch.harness.clone(); meta.model = record.launch.model.clone();
    meta.daemon_namespace = state.owning_lane.clone();
    meta.playbook.clear(); meta.generic = false;
    if existing.is_none() {
        meta.created = now_secs(); meta.telemetry_id = alinery_core::new_telemetry_id();
        meta.prompt_extra = extra.into();
        meta.prompt = None;
    }
    let value = serde_json::to_value(&meta).map_err(|e| e.to_string())?;
    if existing.is_some() {
        stamp_meta(&path, |current| {
            for field in ["execution_id", "execution_revision", "worktree", "phase", "harness", "model", "daemon_namespace", "playbook", "generic"] {
                current[field] = value[field].clone();
            }
        })?;
    } else { write_meta_atomic(&path, &value)?; }
    Ok(meta)
}
fn project_all(repo: &Path, slug: &str) -> Result<Vec<SessionMeta>, String> {
    let state = read_execution_state(repo, slug)?; let definition = read_task_playbook(repo, slug, &state)?;
    state.executions.values().map(|record| project(repo, slug, &state, &definition, record, "")).collect()
}

pub(super) fn reconcile_task(repo: &Path, slug: &str, reg: &Registry, lane: &str, app_config: &Path, host: &ProtectedHost) -> Result<(), String> {
    let defaults = product(repo, app_config)?;
    mutate_execution_state(repo, slug, lane, "reconcile graph", |definition, state| {
        if state.creation != "ready" { return Ok(()); }
        let candidates = reconcile_graph(definition, state)?;
        for candidate in candidates {
            let root_binding = candidate.inputs.values().flatten().all(|id| state.occurrences.get(id).is_some_and(|o| o.producer_execution_id.is_none()));
            let start_requested = !root_binding || state.initial_start_requested;
            reserve_execution(repo, slug, definition, state, candidate, &defaults, None, start_requested)?;
        }
        // Materialize every collection expectation before a single child may launch.
        let _ = reconcile_graph(definition, state)?;
        Ok(())
    })?;
    project_all(repo, slug)?;
    let ids: Vec<_> = read_execution_state(repo, slug)?.executions.values().filter(|r| r.lifecycle == ExecutionLifecycle::Queued && r.start_requested).map(|r| r.id.clone()).collect();
    for id in ids { launch_execution(repo, slug, &id, reg, lane, app_config, host)?; }
    Ok(())
}
fn launch_execution(repo: &Path, slug: &str, id: &str, reg: &Registry, lane: &str, app_config: &Path, host: &ProtectedHost) -> Result<(), String> {
    let claimed = mutate_execution_state(repo, slug, lane, "reserve execution launch", |_, state| claim_execution_launch(state, id))?;
    if !claimed { return Ok(()); }
    let state = read_execution_state(repo, slug)?;
    let record = state.executions.get(id).ok_or("missing execution")?;
    let session_id = record.owner_session_id.clone();
    let result = (|| {
        let definition = read_task_playbook(repo, slug, &state)?;
        let meta = project(repo, slug, &state, &definition, record, "")?;
        let launch = read_meta_launch_fields(repo, slug, &meta.id).ok_or("missing session projection")?;
        spawn_session(reg, repo, launch, None, false, SessionTransport::Rpc, false, None, lane, app_config, host)
    })();
    let error = result.as_ref().err().cloned();
    if let Some(error) = &error {
        let stopped = {
            let map = reg.lock().unwrap_or_else(|e| e.into_inner());
            map.get(&session_id).is_none_or(|s| s.inner.lock().unwrap_or_else(|e| e.into_inner()).reaped_and_drained)
        };
        mutate_execution_state(repo, slug, lane, "record execution launch failure", |_, state| {
            let record = state.executions.get_mut(id).ok_or("missing execution")?;
            if record.owner_session_id != session_id { return Err("stale execution owner".into()); }
            if record.shutdown_confirmed { return Ok(()); }
            if record.receipt_id.is_some() { return Ok(()); }
            record.lifecycle = if stopped { ExecutionLifecycle::LaunchFailed } else { ExecutionLifecycle::Interrupted };
            record.shutdown_confirmed = stopped;
            record.error = Some(error.clone());
            Ok(())
        })?;
    }
    if let Some(error) = error { eprintln!("launch {slug}/{id}: {error}"); }
    Ok(())
}
pub(super) fn task_for_owner(repo: &Path, slug: &str, lane: &str) -> Result<Option<alinery_core::Task>, String> {
    if slug.is_empty() { return Ok(None); }
    if alinery_core::safe_component(slug) != Some(slug) { return Err("invalid task slug".into()); }
    let task = read_task(repo, slug).ok_or("missing task")?;
    if task.archived || task.draft { return Err("task is archived or draft".into()); }
    if !task.has_worktree || task.worktree.trim().is_empty() || !Path::new(&task.worktree).is_dir() { return Err("missing-worktree".into()); }
    if task.engine_version == 2 {
        let state = read_execution_state(repo, slug)?;
        if state.owning_lane != lane || state.owning_app_config_identity != execution_config_identity() {
            return Err("task belongs to another daemon lane or app configuration".into());
        }
    } else if task.engine_version != 0 {
        return Err("unsupported task engine version".into());
    }
    Ok(Some(task))
}

pub(super) fn query(repo: &Path, slug: &str, lane: &str) -> Result<TaskExecutionReply, String> {
    let state = read_execution_state(repo, slug)?;
    if state.owning_lane != lane || state.owning_app_config_identity != execution_config_identity() { return Err("task belongs to another daemon lane or app configuration".into()); }
    let definition = read_task_playbook(repo, slug, &state)?;
    Ok(TaskExecutionReply { state, definition })
}
pub(super) fn create_task(repo: &Path, reg: &Registry, lane: &str, config: &Path, host: &ProtectedHost, request: CreateTaskRequest) -> Result<CreateTaskReply, String> {
    product(repo, config)?;
    let mut reply = provision_task(repo, lane, execution_config_identity(), &request)?;
    initialize_created_task(repo, reg, lane, config, host, request.start, &mut reply)?;
    Ok(reply)
}
pub(super) fn initialize_created_task(repo: &Path, reg: &Registry, lane: &str, config: &Path, host: &ProtectedHost, start: bool, reply: &mut CreateTaskReply) -> Result<(), String> {
    if reply.creation != "ready" { return Ok(()); }
    let slug = reply.task.as_ref().ok_or("missing created task")?.slug.clone();
    if let Err(error) = reconcile_task(repo, &slug, reg, lane, config, host) {
        reply.errors.push(CreationError { stage: "execution".into(), code: "reconcile_failed".into(), message: error });
    }
    reply.sessions = project_all(repo, &slug)?;
    reply.executions = read_execution_state(repo, &slug)?.executions.into_values().collect();
    for record in &reply.executions {
        if let Some(error) = &record.error {
            let code = match record.lifecycle {
                ExecutionLifecycle::LaunchFailed => "launch_failed",
                ExecutionLifecycle::Interrupted => "interrupted",
                _ => "execution_failed",
            };
            reply.errors.push(CreationError { stage: "launch".into(), code: code.into(), message: format!("{}: {error}", record.owner_session_id) });
        }
    }
    reply.start = if !start { "not_requested" } else if reply.executions.iter().any(|r| matches!(r.lifecycle, ExecutionLifecycle::LaunchFailed | ExecutionLifecycle::Failed | ExecutionLifecycle::Interrupted)) { "failed" } else if reply.executions.iter().any(|r| r.lifecycle == ExecutionLifecycle::Queued) { "queued" } else { "started" }.into();
    Ok(())
}
fn session_reply(repo: &Path, slug: &str, session: SessionMeta, requested: bool) -> Result<CreateExecutionSessionReply, String> {
    let execution = if session.execution_id.is_empty() { None } else { read_execution_state(repo, slug)?.executions.remove(&session.execution_id) };
    let start = if !requested { "not_requested" } else { match execution.as_ref().map(|r| &r.lifecycle) { Some(ExecutionLifecycle::Queued) => "queued", Some(ExecutionLifecycle::LaunchFailed | ExecutionLifecycle::Failed | ExecutionLifecycle::Interrupted) => "failed", _ => "started" } }.into();
    let errors = execution.as_ref().and_then(|r| r.error.as_ref()).map(|e| vec![CreationError { stage: "launch".into(), code: "execution_failed".into(), message: e.clone() }]).unwrap_or_default();
    Ok(CreateExecutionSessionReply { session, execution, start, errors })
}
pub(super) fn session_for_launch(repo: &Path, slug: &str, id: &str) -> Result<SessionMeta, String> {
    let meta = read_session_meta_full(&session_meta_path(repo, slug, id)).ok_or("missing-session-meta")?;
    if meta.archived { return Err("session-archived".into()); }
    Ok(meta)
}

pub(super) fn create_session(repo: &Path, reg: &Registry, lane: &str, config: &Path, host: &ProtectedHost, request: CreateExecutionSessionRequest) -> Result<CreateExecutionSessionReply, String> {
    let slug = request.task_slug.as_str();
    if !slug.is_empty() && alinery_core::safe_component(slug) != Some(slug) { return Err("invalid task slug".into()); }
    task_for_owner(repo, slug, lane)?;
    if let ExecutionSessionTarget::Primary { step_key, execution_id, input_occurrence_ids } = &request.target {
        let defaults = product(repo, config)?;
        let id = mutate_execution_state(repo, slug, lane, "create execution session", |definition, state| {
            let id = if let Some(id) = execution_id {
                let record = state.executions.get(id).ok_or("unknown execution")?;
                if &record.candidate.step_key != step_key { return Err("execution step mismatch".into()); }
                let launch = if let Some(override_choices) = &request.launch_override {
                    let step = definition.step.iter().find(|step| &step.key == step_key).ok_or("unknown execution step")?;
                    Some(resolve_execution_launch(definition, step, &state.launch_defaults, &defaults, Some(override_choices))?)
                } else { None };
                recover_execution_owner(state, id)?;
                if let Some(launch) = launch { state.executions.get_mut(id).ok_or("unknown execution")?.launch = launch; }
                id.clone()
            } else {
                let ids: BTreeSet<_> = input_occurrence_ids.clone().unwrap_or_default().into_iter().collect();
                let mut candidates = reconcile_graph(definition, state)?;
                candidates.extend(state.executions.values().map(|r| r.candidate.clone()));
                let mut candidates: Vec<_> = candidates.into_iter().filter(|c| &c.step_key == step_key && c.inputs.values().flatten().cloned().collect::<BTreeSet<_>>() == ids).collect();
                for candidate in &mut candidates { candidate.manual = false; }
                candidates.sort_by_key(|c| c.binding_key().unwrap_or_default()); candidates.dedup();
                if candidates.len() != 1 { return Err("choose one complete eligible input binding".into()); }
                let mut candidate = candidates.remove(0); candidate.manual = true;
                reserve_execution(repo, slug, definition, state, candidate, &defaults, request.launch_override.as_ref(), request.start)?
            };
            if request.start { request_execution_start(state, &id)?; }
            Ok(id)
        })?;
        let snapshot = query(repo, slug, lane)?;
        let record = snapshot.state.executions.get(&id).ok_or("missing execution")?;
        let session = project(repo, slug, &snapshot.state, &snapshot.definition, record, request.prompt_extra.as_deref().unwrap_or(""))?;
        if request.start { launch_execution(repo, slug, &id, reg, lane, config, host)?; }
        return session_reply(repo, slug, session, request.start);
    }
    let mut session = alinery_core::with_task_mutation_lock(repo, "create auxiliary session", || {
        let task = task_for_owner(repo, slug, lane)?;
        let (harness, model, prompt, manager, child) = match &request.target {
            ExecutionSessionTarget::Auxiliary { harness, model, prompt } => (harness.clone(), model.clone().unwrap_or_default(), prompt.clone(), false, String::new()),
            ExecutionSessionTarget::SubtaskManager { subtask_slug, recover, harness, model } => {
                let task = task.as_ref().ok_or("manager requires task")?;
                if read_task_session_metas(repo, slug).iter().any(|m| m.subtask_manager && !m.archived && m.ended_at.is_none()) { return Err("task already has a live or unstarted manager".into()); }
                let child = subtask_slug.clone().unwrap_or_default();
                if *recover {
                    let target = read_task(repo, &child).ok_or("missing child task")?;
                    if target.parent_task != slug || task.active_subtask != child { return Err("invalid manager recovery binding".into()); }
                } else if !task.active_subtask.is_empty() || !child.is_empty() { return Err("task already has an active child".into()); }
                (harness.clone(), model.clone().unwrap_or_default(), None, true, child)
            }, _ => unreachable!(),
        };
        if slug.is_empty() && harness != NO_HARNESS_KEY { return Err("root session must be Terminal".into()); }
        alinery_core::resolve_harness_strict_for(config, repo, &harness)?;
        let id = format!("s{}", uuid::Uuid::new_v4());
        let meta = SessionMeta { id: id.clone(), worktree: task.as_ref().map(|t| t.worktree.clone()).unwrap_or_else(|| repo.to_string_lossy().into_owned()),
            harness, model, prompt, generic: true, subtask_manager: manager, subtask_slug: child, prompt_extra: request.prompt_extra.clone().unwrap_or_default(),
            created: now_secs(), telemetry_id: alinery_core::new_telemetry_id(), daemon_namespace: lane.into(), ..SessionMeta::default() };
        fs::create_dir_all(session_meta_path(repo, slug, &id).parent().ok_or("missing session directory")?).map_err(|e| e.to_string())?;
        write_meta_atomic(&session_meta_path(repo, slug, &id), &serde_json::to_value(&meta).map_err(|e| e.to_string())?)?;
        Ok(meta)
    })?;
    if request.start {
        let launch = read_meta_launch_fields(repo, slug, &session.id).ok_or("missing session")?;
        if let Err(error) = spawn_session(reg, repo, launch, None, false, SessionTransport::Pty, false, None, lane, config, host) {
            return Ok(CreateExecutionSessionReply { session, execution: None, start: "failed".into(), errors: vec![CreationError { stage:"launch".into(),code:"spawn_failed".into(),message:error }] });
        }
        session = read_session_meta_full(&session_meta_path(repo, slug, &session.id)).unwrap_or(session);
    }
    session_reply(repo, slug, session, request.start)
}
pub(super) fn start(repo: &Path, reg: &Registry, lane: &str, config: &Path, host: &ProtectedHost, request: StartSessionRequest) -> Result<CreateExecutionSessionReply, String> {
    if alinery_core::safe_component(&request.session_id) != Some(request.session_id.as_str()) || (!request.task_slug.is_empty() && alinery_core::safe_component(&request.task_slug) != Some(request.task_slug.as_str())) { return Err("invalid task or session id".into()); }
    task_for_owner(repo, &request.task_slug, lane)?;
    let meta = session_for_launch(repo, &request.task_slug, &request.session_id)?;
    if meta.daemon_namespace != lane { return Err("session belongs to another daemon lane".into()); }
    if !meta.execution_id.is_empty() {
        mutate_execution_state(repo, &request.task_slug, lane, "request execution start", |_, state| {
            let record = state.executions.get(&meta.execution_id).ok_or("missing execution")?;
            if record.owner_session_id != meta.id { return Err("stale execution owner".into()); }
            request_execution_start(state, &meta.execution_id)
        })?;
        launch_execution(repo, &request.task_slug, &meta.execution_id, reg, lane, config, host)?;
        session_reply(repo, &request.task_slug, meta, true)
    } else {
        if !meta.generic && meta.harness != NO_HARNESS_KEY { return Err("pre-v2 task sessions cannot launch".into()); }
        if meta.started_at.is_some() || meta.ended_at.is_some() { return Err("session already started".into()); }
        let launch = read_meta_launch_fields(repo, &request.task_slug, &meta.id).ok_or("missing session")?;
        let result = spawn_session(reg, repo, launch, None, false, SessionTransport::Pty, false, None, lane, config, host);
        let mut reply = session_reply(repo, &request.task_slug, meta, result.is_ok())?;
        if let Err(error) = result { reply.start = "failed".into(); reply.errors.push(CreationError { stage:"launch".into(),code:"spawn_failed".into(),message:error }); }
        Ok(reply)
    }
}
pub(super) fn exited(repo: &Path, slug: &str, session_id: &str, lane: &str, code: Option<i32>) {
    if slug.is_empty() { return; }
    let Some(meta) = read_session_meta_full(&session_meta_path(repo, slug, session_id)) else { return; };
    if meta.execution_id.is_empty() { return; }
    if let Err(error) = mutate_execution_state(repo, slug, lane, "confirm reaped execution", |_, state| confirm_execution_exit(state, &meta.execution_id, session_id, code)) { eprintln!("execution exit {slug}/{session_id}: {error}"); }
}
pub(super) fn boot(repo: &Path, lane: &str) {
    for task in alinery_core::list_tasks_for_repo(repo) {
        if read_execution_state(repo, &task.slug).is_ok_and(|s| s.owning_lane == lane && s.owning_app_config_identity == execution_config_identity()) {
            if let Err(error) = mutate_execution_state(repo, &task.slug, lane, "recover execution owners", |_, state| { interrupt_unproven_owners(state, &BTreeSet::new()); Ok(()) }) { eprintln!("execution recovery {}: {error}", task.slug); }
        }
    }
}
pub(super) fn reconcile_repo(repo: &Path, reg: &Registry, lane: &str, config: &Path, host: &ProtectedHost) {
    for task in alinery_core::list_tasks_for_repo(repo).into_iter().filter(|t| !t.draft) {
        if read_execution_state(repo, &task.slug).is_ok_and(|s| s.owning_lane == lane && s.owning_app_config_identity == execution_config_identity() && s.creation == "ready") {
            if let Err(error) = reconcile_task(repo, &task.slug, reg, lane, config, host) { eprintln!("reconcile {}: {error}", task.slug); }
        }
    }
}

pub(super) fn spawned(repo: &Path, slug: &str, session_id: &str, lane: &str) -> Result<(), String> {
    let Some(meta) = read_session_meta_full(&session_meta_path(repo, slug, session_id)) else { return Ok(()); };
    if meta.execution_id.is_empty() { return Ok(()); }
    mutate_execution_state(repo, slug, lane, "commit spawned execution", |_, state| {
        let record = state.executions.get(&meta.execution_id).ok_or("missing execution")?;
        if record.owner_session_id != session_id { return Err("stale execution owner".into()); }
        if record.lifecycle == ExecutionLifecycle::Running { return Ok(()); }
        record_execution_spawn(state, &meta.execution_id, session_id, Ok(()))
    })
}


pub(super) fn failed_spawn(repo: &Path, slug: &str, session_id: &str, lane: &str, reg: &Registry, error: &str) -> Result<(), String> {
    let meta = read_session_meta_full(&session_meta_path(repo, slug, session_id)).ok_or("missing session")?;
    if meta.execution_id.is_empty() { return Ok(()); }
    let stopped = {
        let map = reg.lock().unwrap_or_else(|e| e.into_inner());
        map.get(session_id).is_none_or(|s| s.inner.lock().unwrap_or_else(|e| e.into_inner()).reaped_and_drained)
    };
    mutate_execution_state(repo, slug, lane, "record replacement launch failure", |_, state| {
        let record = state.executions.get_mut(&meta.execution_id).ok_or("missing execution")?;
        if record.owner_session_id != session_id { return Err("stale owner".into()); }
        if record.shutdown_confirmed { return Ok(()); }
        record.lifecycle = if stopped { ExecutionLifecycle::LaunchFailed } else { ExecutionLifecycle::Interrupted };
        record.shutdown_confirmed = stopped;
        record.error = Some(error.into());
        Ok(())
    })
}