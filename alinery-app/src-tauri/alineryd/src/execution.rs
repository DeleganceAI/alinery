//! Durable graph orchestration. Filesystem transitions precede process effects.
use super::*;
use alinery_core::{execution::*, playbook_scheduler::reconcile_graph, task_creation::*};
use std::collections::BTreeSet;

/// One lock per live transport incarnation. Never held with the registry lock
/// across child IO; every controlled write and protected lifecycle takes it.
#[derive(Default)]
pub(super) struct ContinuationGate {
    process: Option<ExecutionProcess>,
    bound_session: Option<String>,
    available: bool,
    reason: Option<String>,
    operations: HashMap<String, Option<String>>,
    settled: HashMap<String, Option<String>>,
    pending_dispatches: BTreeSet<String>,
    dispatches: HashMap<String, DispatchOutcome>,
    dispatch_proofs: HashMap<String, String>,
    dispatch_claims: HashMap<String, String>,
    rpc_intakes: HashMap<String, &'static str>,
    consumed: BTreeSet<String>,
    rejected: BTreeSet<String>,
    transfers: HashMap<String, String>,
    finished_dispatches: BTreeSet<String>,
    uncertain: BTreeSet<String>,
    admissions: HashMap<String, u64>,
    admission_sequence: u64,
    capability_revision: u64,
    capability_operations: HashMap<String, (RunnerEvent, bool)>,
    native_entries: HashMap<String, RunnerEvent>,
    rpc_seed: Option<String>,
    rpc_ready: bool,
    seed_requires_binding: bool,
}
impl ContinuationGate {
    pub fn with_rpc_seed(rpc_seed: Option<String>, seed_requires_binding: bool) -> Self {
        Self {
            rpc_seed,
            seed_requires_binding,
            ..Self::default()
        }
    }
    pub fn mark_rpc_ready(&mut self) {
        self.rpc_ready = true;
    }
    pub fn take_rpc_seed(&mut self) -> Option<String> {
        if self.rpc_ready && (!self.seed_requires_binding || self.available) {
            self.rpc_seed.take()
        } else {
            None
        }
    }
    pub fn seed_failed(&mut self, reason: String) {
        self.available = false;
        self.reason = Some(reason);
    }
    pub fn available(&self) -> bool {
        self.available
    }
    pub fn matches_incarnation(&self, incarnation: &str) -> bool {
        self.process.as_ref().is_some_and(|process| process.incarnation == incarnation)
    }
    pub fn register_rpc_intake(&mut self, id: &str, command: &'static str) {
        self.rpc_intakes.insert(id.into(), command);
    }
    pub fn replay(&self, id: &str) -> Option<DispatchOutcome> {
        self.dispatches.get(id).cloned()
    }
    pub fn dispatch_proof(&mut self, id: &str) -> &str {
        self.dispatch_proofs.entry(id.into()).or_insert_with(|| uuid::Uuid::new_v4().to_string())
    }
    fn waiting_reason(&self) -> Option<String> {
        if self.rpc_seed.is_some() {
            return Some("initial prompt awaits native RPC readiness and authenticated binding".into());
        }
        if self.uncertain.is_empty() && self.operations.is_empty() && self.pending_dispatches.is_empty() {
            return None;
        }
        fn sample<'a>(ids: impl Iterator<Item = &'a String>) -> Vec<String> {
            ids.take(8).map(|id| id.chars().take(128).collect()).collect()
        }
        Some(format!(
            "selected work has not settled: {} native operations {:?}; {} submitted dispatches {:?}; {} uncertain writes {:?}",
            self.operations.len(),
            sample(self.operations.keys()),
            self.pending_dispatches.len(),
            sample(self.pending_dispatches.iter()),
            self.uncertain.len(),
            sample(self.uncertain.iter())
        ))
    }
}

pub(super) fn capture_process(reg: &Registry, session: &str, process: Option<ExecutionProcess>) {
    let gate = reg.lock().unwrap_or_else(|e| e.into_inner()).get(session).map(|s| s.continuation.clone());
    if let Some(gate) = gate {
        gate.lock().unwrap_or_else(|e| e.into_inner()).process = process;
    }
}

pub(super) struct Owner {
    pub gate: Arc<Mutex<ContinuationGate>>,
    pub inner: Arc<Mutex<Inner>>,
    pub replacing: Arc<AtomicBool>,
    pub task_slug: String,
    pub session_id: String,
    pub meta_path: PathBuf,
    pub token: String,
}

pub(super) fn owner(reg: &Registry, session_id: &str) -> Result<Owner, String> {
    let map = reg.lock().unwrap_or_else(|e| e.into_inner());
    let session = map.get(session_id).ok_or("unknown-session")?;
    Ok(Owner {
        gate: session.continuation.clone(),
        inner: session.inner.clone(),
        replacing: session.replacing.clone(),
        task_slug: session.task_slug.clone(),
        session_id: session_id.into(),
        meta_path: session.meta_path.clone(),
        token: session.event_token.clone(),
    })
}

impl Owner {
    fn live(&self) -> Result<(), String> {
        if self.replacing.load(Ordering::SeqCst) {
            return Err("session transport replacement in progress".into());
        }
        if !process_accepts_runner_events(&self.inner.lock().unwrap_or_else(|e| e.into_inner()).state.process) {
            return Err("session-exited".into());
        }
        Ok(())
    }
    fn lane(&self) -> Result<String, String> {
        Ok(read_session_meta_full(&self.meta_path).ok_or("missing-session-meta")?.daemon_namespace)
    }
    fn invalidate(&self, repo: &Path, gate: &mut ContinuationGate, operation: &str) -> Result<(), String> {
        self.live()?;
        let Some(process) = &gate.process else {
            if read_session_meta_full(&self.meta_path).is_some_and(|meta| !meta.execution_id.is_empty()) {
                return Err("execution process capture pending".into());
            }
            return Ok(());
        };
        let admissions = &mut gate.admissions;
        let admission_sequence = &mut gate.admission_sequence;
        mutate_execution_state(repo, &self.task_slug, &self.lane()?, "admit controlled work", |_, state| {
            let record = state.executions.get(&process.execution_id).ok_or("missing execution")?;
            let sequence = match admissions.get(operation) {
                Some(sequence) => *sequence,
                None => {
                    // Failed writes still reserve their identity: a different operation
                    // must not reuse it, even when the durable sequence did not advance.
                    let sequence = (*admission_sequence)
                        .max(record.last_admission_sequence)
                        .checked_add(1)
                        .ok_or("work admission sequence exhausted")?;
                    *admission_sequence = sequence;
                    admissions.insert(operation.into(), sequence);
                    sequence
                }
            };
            invalidate_execution_readiness(state, &process.execution_id, &self.session_id, sequence).map(|_| ())
        })
    }
    pub fn admit(&self, repo: &Path, gate: &mut ContinuationGate, id: &str, tracked: bool) -> Result<Option<DispatchOutcome>, String> {
        if let Some(outcome) = gate.dispatches.get(id) {
            return Ok(Some(outcome.clone()));
        }
        self.invalidate(repo, gate, &format!("dispatch:{id}"))?;
        if tracked && gate.process.is_some() {
            gate.pending_dispatches.insert(id.into());
        }
        Ok(None)
    }
    pub fn dispatched(&self, gate: &mut ContinuationGate, id: &str, outcome: DispatchOutcome) {
        if matches!(outcome, DispatchOutcome::Unknown { .. }) {
            gate.uncertain.insert(id.into());
        }
        gate.dispatches.insert(id.into(), outcome);
    }
    fn control(&self, repo: &Path, gate: &ContinuationGate) -> Result<alinery_core::ContinuationControl, String> {
        let process = gate.process.as_ref().ok_or("execution process capture pending")?;
        let state = read_execution_state(repo, &self.task_slug)?;
        let record = state.executions.get(&process.execution_id).ok_or("missing execution")?;
        if record.owner_session_id != self.session_id {
            return Err("stale execution owner".into());
        }
        let live = self.live().is_ok();
        Ok(alinery_core::ContinuationControl {
            process_incarnation: process.incarnation.clone(),
            capability_revision: gate.capability_revision,
            work_revision: record.work_revision,
            continuation_requested_revision: record.continuation_requested_revision,
            available: gate.available && live,
            reason: if !live {
                Some("execution process is unavailable".into())
            } else if gate.available {
                gate.waiting_reason()
            } else {
                Some(gate.reason.clone().unwrap_or_else(|| "selected native boundaries have not bound".into()))
            },
        })
    }
    fn blocked(&self, gate: &ContinuationGate) -> Option<CompletionOutcome> {
        if !gate.available {
            return Some(CompletionOutcome::Unavailable {
                reason: gate.reason.clone().unwrap_or_else(|| "selected native boundaries have not bound".into()),
            });
        }
        if let Some(reason) = gate.waiting_reason() {
            return Some(CompletionOutcome::Waiting { reason });
        }
        if matches!(
            self.inner.lock().unwrap_or_else(|e| e.into_inner()).state.agent,
            alinery_core::AgentState::WaitingForApproval { .. }
        ) {
            return Some(CompletionOutcome::Waiting {
                reason: "a substantive approval is outstanding".into(),
            });
        }
        None
    }
    fn dispatch_progress(&self, id: &str, status: &str, reason: Option<&str>) {
        let mut line = serde_json::to_vec(&json!({"type":"alinery_dispatch","dispatch_id":id,"status":status,"reason":reason})).expect("serializable dispatch event");
        line.push(b'\n');
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        push_rpc_line(&mut inner, line, RpcLineKind::Other);
    }
}

pub(super) fn continuation_event(repo: &Path, owner: &Owner, event: &RunnerEvent) -> Result<Option<RunnerEventResult>, String> {
    use alinery_core::ContinuationBoundary::*;
    let incarnation = match event {
        RunnerEvent::ContinuationBind { .. } => None,
        RunnerEvent::ContinuationPoll { process_incarnation } => process_incarnation.as_ref(),
        RunnerEvent::ContinuationRevoke { process_incarnation, .. }
        | RunnerEvent::NativeWorkEntered { process_incarnation, .. }
        | RunnerEvent::NativeWorkSettled { process_incarnation, .. }
        | RunnerEvent::NativeDispatchConsumed { process_incarnation, .. }
        | RunnerEvent::NativeDispatchTransferred { process_incarnation, .. }
        | RunnerEvent::NativeDispatchRejected { process_incarnation, .. }
        | RunnerEvent::ReadinessReported { process_incarnation, .. }
        | RunnerEvent::ContinuationFinalize { process_incarnation, .. } => Some(process_incarnation),
        _ => return Ok(None),
    };
    let mut gate = owner.gate.lock().unwrap_or_else(|e| e.into_inner());
    if gate.process.is_none() && read_session_meta_full(&owner.meta_path).is_none_or(|meta| meta.execution_id.is_empty()) {
        return Err("session has no primary execution".into());
    }
    let process = gate.process.clone().ok_or("execution process capture pending")?;
    if incarnation.is_some_and(|value| value != &process.incarnation) {
        return Err("stale process incarnation".into());
    }
    if matches!(event, RunnerEvent::ContinuationPoll { process_incarnation: None }) {
        return Ok(Some(RunnerEventResult::Control(owner.control(repo, &gate)?)));
    }
    let capability_operation = match event {
        RunnerEvent::ContinuationBind {
            operation_id,
            expected_capability_revision,
            ..
        }
        | RunnerEvent::ContinuationRevoke {
            operation_id,
            expected_capability_revision,
            ..
        } => Some((operation_id, *expected_capability_revision)),
        _ => None,
    };
    if let Some((operation_id, _)) = capability_operation {
        if gate.capability_operations.get(operation_id).is_some_and(|(previous, _)| previous != event) {
            return Err("capability operation replay changed its body".into());
        }
    }
    // Accepted receipt replay remains available after ordinary shutdown.
    let receipt = read_execution_state(repo, &owner.task_slug)?
        .executions
        .get(&process.execution_id)
        .and_then(|r| r.receipt_id.clone());
    if matches!(
        event,
        RunnerEvent::ReadinessReported { .. }
            | RunnerEvent::ContinuationFinalize { .. }
            | RunnerEvent::ContinuationPoll { process_incarnation: Some(_) }
            | RunnerEvent::ContinuationRevoke { .. }
    ) {
        if let Some(receipt_id) = receipt {
            sync_execution_state(repo, &owner.task_slug)?;
            return Ok(Some(RunnerEventResult::Completion(CompletionOutcome::Accepted { receipt_id })));
        }
    }
    if let Some((operation_id, expected)) = capability_operation {
        if gate.capability_operations.get(operation_id).is_some_and(|(_, applied)| *applied) {
            return Ok(Some(RunnerEventResult::Control(owner.control(repo, &gate)?)));
        }
        if expected != gate.capability_revision {
            return Err("stale capability revision".into());
        }
        gate.capability_revision
            .checked_add(1)
            .filter(|revision| *revision <= MAX_WORK_REVISION)
            .ok_or("capability revision overflow")?;
        gate.capability_operations.entry(operation_id.clone()).or_insert_with(|| (event.clone(), false));
    }
    owner.live()?;
    match event {
        RunnerEvent::ContinuationBind {
            omp_session_id,
            groups,
            operation_id,
            ..
        } => {
            let missing: Vec<_> = [PrimaryControl, NativeTools, AdmittedQueue, PublicEntries]
                .into_iter()
                .filter(|group| !groups.contains(group))
                .collect();
            if gate.bound_session.is_some() || gate.capability_revision != 0 {
                owner.invalidate(repo, &mut gate, &format!("capability:{operation_id}"))?;
            }
            gate.bound_session = Some(omp_session_id.clone());
            gate.available = missing.is_empty();
            gate.reason = (!missing.is_empty()).then(|| format!("missing native boundaries: {missing:?}"));
            gate.capability_revision += 1;
            gate.capability_operations.get_mut(operation_id).expect("validated capability operation").1 = true;
        }
        RunnerEvent::ContinuationRevoke { operation_id, reason, .. } => {
            owner.invalidate(repo, &mut gate, &format!("capability:{operation_id}"))?;
            gate.available = false;
            gate.reason = Some(reason.clone());
            gate.capability_revision += 1;
            gate.capability_operations.get_mut(operation_id).expect("validated capability operation").1 = true;
        }
        RunnerEvent::NativeWorkEntered {
            operation_id,
            dispatch_id,
            dispatch_proof,
            parent_operation_id,
            ..
        } => {
            let previous = gate.native_entries.get(operation_id);
            if previous.is_some_and(|previous| previous != event) {
                return Err("native operation replay changed its body".into());
            }
            let replay = gate.operations.contains_key(operation_id) || gate.settled.contains_key(operation_id);
            if let Some(id) = dispatch_id {
                if dispatch_proof.as_ref().is_none_or(|proof| gate.dispatch_proofs.get(id) != Some(proof)) {
                    return Err("invalid native dispatch proof".into());
                }
                if gate.dispatch_claims.get(id).is_some_and(|claimed| claimed != operation_id) {
                    return Err("native dispatch proof already claimed by another operation".into());
                }
                if !replay && !gate.pending_dispatches.contains(id) {
                    return Err("native work references an unknown dispatch".into());
                }
            } else if dispatch_proof.is_some() {
                return Err("native dispatch proof requires a dispatch identity".into());
            }
            if !replay {
                if parent_operation_id.as_ref().is_some_and(|parent| !gate.operations.contains_key(parent)) {
                    return Err("native parent operation is no longer active".into());
                }
                if !gate.available && parent_operation_id.is_none() && dispatch_id.is_none() {
                    return Err("unavailable capability cannot admit a new protected root".into());
                }
                gate.native_entries.entry(operation_id.clone()).or_insert_with(|| event.clone());
                owner.invalidate(repo, &mut gate, &format!("native:{operation_id}"))?;
                gate.operations.insert(operation_id.clone(), dispatch_id.clone());
                if let Some(id) = dispatch_id {
                    gate.dispatch_claims.insert(id.clone(), operation_id.clone());
                }
            }
        }
        RunnerEvent::NativeWorkSettled { operation_id, .. } => {
            if let Some(dispatch) = gate.operations.remove(operation_id) {
                if let Some(id) = &dispatch {
                    if !gate.operations.values().any(|dispatch| dispatch.as_ref() == Some(id)) {
                        gate.finished_dispatches.insert(id.clone());
                        let consumed = gate.consumed.contains(id) || gate.transfers.get(id).is_some_and(|replacement| gate.consumed.contains(replacement));
                        if consumed || gate.rejected.contains(id) {
                            gate.pending_dispatches.remove(id);
                        }
                        if consumed {
                            owner.dispatch_progress(id, "settled", None);
                        }
                    }
                }
                gate.settled.insert(operation_id.clone(), dispatch);
            } else if !gate.settled.contains_key(operation_id) {
                return Err("native settlement references an unknown operation".into());
            }
        }
        RunnerEvent::NativeDispatchTransferred {
            dispatch_id,
            replacement_dispatch_id,
            ..
        } => {
            if !gate.dispatch_claims.contains_key(dispatch_id) || !gate.dispatch_claims.contains_key(replacement_dispatch_id) {
                return Err("native transfer requires claimed dispatch proofs".into());
            }
            if gate.transfers.get(dispatch_id) != Some(replacement_dispatch_id)
                && (!gate.pending_dispatches.contains(dispatch_id) || !gate.pending_dispatches.contains(replacement_dispatch_id))
            {
                return Err("native transfer requires both admitted dispatches".into());
            }
            gate.transfers.insert(dispatch_id.clone(), replacement_dispatch_id.clone());
            let mut line =
                serde_json::to_vec(&json!({"type":"alinery_dispatch","status":"transferred","dispatch_id":dispatch_id,"replacement_dispatch_id":replacement_dispatch_id}))
                    .expect("serializable dispatch transfer");
            line.push(b'\n');
            push_rpc_line(&mut owner.inner.lock().unwrap_or_else(|e| e.into_inner()), line, RpcLineKind::Other);
        }
        RunnerEvent::NativeDispatchConsumed { dispatch_id, .. } => {
            if !gate.dispatch_claims.contains_key(dispatch_id) {
                return Err("native consumption references an unknown dispatch".into());
            }
            if gate.rejected.contains(dispatch_id) {
                return Err("native consumption contradicts rejected dispatch".into());
            }
            gate.consumed.insert(dispatch_id.clone());
            gate.uncertain.remove(dispatch_id);
            owner.dispatch_progress(dispatch_id, "consumed", None);
            if gate.finished_dispatches.contains(dispatch_id) {
                gate.pending_dispatches.remove(dispatch_id);
                owner.dispatch_progress(dispatch_id, "settled", None);
            }
        }
        RunnerEvent::NativeDispatchRejected { dispatch_id, reason, .. } => {
            if gate.consumed.contains(dispatch_id) {
                return Err("cannot reject a consumed native dispatch".into());
            }
            if !gate.dispatch_claims.contains_key(dispatch_id) {
                return Err("native rejection references an unknown dispatch".into());
            }
            gate.pending_dispatches.remove(dispatch_id);
            gate.rejected.insert(dispatch_id.clone());
            gate.uncertain.remove(dispatch_id);
            owner.dispatch_progress(dispatch_id, "rejected", Some(reason));
        }
        RunnerEvent::ReadinessReported { expected_work_revision, .. }
        | RunnerEvent::ContinuationFinalize {
            ready_revision: expected_work_revision,
            ..
        } => {
            if let Some(outcome) = owner.blocked(&gate) {
                return Ok(Some(RunnerEventResult::Completion(outcome)));
            }
            let outcome = mutate_execution_state(repo, &owner.task_slug, &owner.lane()?, "accept execution completion", |definition, state| {
                if matches!(event, RunnerEvent::ReadinessReported { .. }) {
                    report_execution_ready(repo, &owner.task_slug, definition, state, &process.execution_id, &owner.session_id, *expected_work_revision)
                } else {
                    finalize_execution_continuation(repo, &owner.task_slug, definition, state, &process.execution_id, &owner.session_id, *expected_work_revision)
                }
            })?;
            if matches!(outcome, CompletionOutcome::Accepted { .. }) {
                sync_execution_state(repo, &owner.task_slug)?;
                // Repairable presentation never revokes durable acceptance.
                if let Err(error) = stamp_meta(&owner.meta_path, |value| {
                    value["semantic"] = json!({"phase_completed_at":now_secs(),"omp_session_id":gate.bound_session});
                }) {
                    eprintln!("completion projection: {error}");
                }
                let mut inner = owner.inner.lock().unwrap_or_else(|e| e.into_inner());
                let mut candidate = inner.state.clone();
                candidate.playbook = PlaybookState::ReadyToAdvance;
                if let Err(error) = publish_live_transition(&mut inner, &owner.meta_path, candidate) {
                    eprintln!("completion state projection: {error}");
                }
            }
            return Ok(Some(RunnerEventResult::Completion(outcome)));
        }
        _ => {}
    }
    Ok(Some(RunnerEventResult::Control(owner.control(repo, &gate)?)))
}

pub(super) fn continue_execution(repo: &Path, reg: &Registry, request: &ContinueExecutionRequest) -> Result<CompletionOutcome, String> {
    let owner = owner(reg, &request.session_id)?;
    let gate = owner.gate.lock().unwrap_or_else(|e| e.into_inner());
    owner.live()?;
    let Some(process) = &gate.process else {
        return Ok(CompletionOutcome::Unavailable {
            reason: "execution process capture pending".into(),
        });
    };
    if owner.task_slug != request.task_slug || process.execution_id != request.execution_id || process.incarnation != request.process_incarnation {
        return Ok(CompletionOutcome::Stale {
            reason: "execution owner or process incarnation changed".into(),
        });
    }
    if gate.available {
        let state = read_execution_state(repo, &owner.task_slug)?;
        let record = state.executions.get(&process.execution_id).ok_or("missing execution")?;
        if record.receipt_id.is_none() && (record.ready_revision != Some(request.ready_revision) || record.work_revision != request.ready_revision) {
            return Ok(CompletionOutcome::Stale {
                reason: "ready generation is no longer current".into(),
            });
        }
    }
    if let Some(outcome) = owner.blocked(&gate) {
        return Ok(outcome);
    }
    mutate_execution_state(repo, &request.task_slug, &owner.lane()?, "request execution continuation", |_, state| {
        request_execution_continuation(state, &request.execution_id, &request.session_id, request.ready_revision)
    })
}
fn end_identity(repo: &Path, slug: &str, execution: &str, session: &str) -> Result<(SessionMeta, ExecutionProcess, ExecutionRecord), String> {
    if alinery_core::safe_component(slug) != Some(slug) || alinery_core::safe_component(session) != Some(session) {
        return Err("invalid task or session id".into());
    }
    let meta = read_session_meta_full(&session_meta_path(repo, slug, session)).ok_or("missing session")?;
    if meta.generic || meta.execution_id != execution {
        return Err("session is not the selected primary execution".into());
    }
    let state = read_execution_state(repo, slug)?;
    let record = state.executions.get(execution).ok_or("unknown execution")?.clone();
    if record.owner_session_id != session {
        return Err("stale execution owner".into());
    }
    let process = read_process(repo, slug, session)?.ok_or("execution process identity unavailable")?;
    if process.execution_id != execution || process.session_id != session {
        return Err("execution process identity changed".into());
    }
    Ok((meta, process, record))
}

pub(super) fn prepare_end_execution(repo: &Path, reg: &Registry, request: &PrepareEndExecutionRequest) -> Result<EndExecutionPreparation, String> {
    let (meta, process, record) = end_identity(repo, &request.task_slug, &request.execution_id, &request.session_id)?;
    task_for_owner(repo, &request.task_slug, &meta.daemon_namespace)?;
    if record.receipt_id.is_some() {
        return Err("execution is already accepted".into());
    }
    if !record.shutdown_confirmed {
        match owner(reg, &request.session_id) {
            Ok(owner) => {
                let gate = owner.gate.lock().unwrap_or_else(|e| e.into_inner());
                owner.live()?;
                if gate.process.as_ref() != Some(&process) || !matches!(record.lifecycle, ExecutionLifecycle::Running | ExecutionLifecycle::Interrupted) {
                    return Err("current execution process disposition is unknown".into());
                }
            }
            // Interrupted with no session in this daemon (killed mid-step): the confirmed
            // end/restart request releases it in stop_execution_boundary, not here.
            Err(_) if record.lifecycle == ExecutionLifecycle::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    let inspected = inspect_execution_publications(repo, &request.task_slug, &record);
    let artifacts = inspected
        .as_ref()
        .map(|items| items.iter().map(|item| item.relative_path.clone()).collect())
        .unwrap_or_default();
    let diagnostics = inspected.err().unwrap_or_default();
    Ok(EndExecutionPreparation {
        request: EndExecutionRequest {
            task_slug: request.task_slug.clone(),
            execution_id: request.execution_id.clone(),
            session_id: request.session_id.clone(),
            process_incarnation: process.incarnation,
            work_revision: record.work_revision,
        },
        artifacts,
        diagnostics,
    })
}

pub(super) fn end_execution(repo: &Path, reg: &Registry, request: &EndExecutionRequest) -> Result<CompletionOutcome, String> {
    stop_execution_boundary(repo, reg, request, true)
}

fn stop_execution_boundary(repo: &Path, reg: &Registry, request: &EndExecutionRequest, accept: bool) -> Result<CompletionOutcome, String> {
    let stale = |reason: String| CompletionOutcome::Stale { reason };
    let (meta, process, _) = match end_identity(repo, &request.task_slug, &request.execution_id, &request.session_id) {
        Ok(identity) => identity,
        Err(reason) => return Ok(stale(reason)),
    };
    if process.incarnation != request.process_incarnation {
        return Ok(stale("execution process incarnation changed".into()));
    }
    let owner = owner(reg, &request.session_id).ok();
    let gate = owner.as_ref().map(|owner| owner.gate.lock().unwrap_or_else(|e| e.into_inner()));
    let authorized = mutate_execution_state(repo, &request.task_slug, &meta.daemon_namespace, "authorize human stopped handoff", |_, state| {
        let record = state.executions.get_mut(&request.execution_id).ok_or("missing execution")?;
        let current = read_process(repo, &request.task_slug, &request.session_id)?;
        if record.owner_session_id != request.session_id || current.as_ref() != Some(&process) || record.work_revision != request.work_revision {
            return Ok(Some(stale("execution owner or work revision changed".into())));
        }
        if let Some(receipt_id) = &record.receipt_id {
            if !accept {
                return Err("execution is already accepted".into());
            }
            return Ok(Some(if record.human_end.as_ref() == Some(request) {
                CompletionOutcome::Accepted { receipt_id: receipt_id.clone() }
            } else {
                stale("execution was accepted by another authorization".into())
            }));
        }
        if !record.shutdown_confirmed {
            if let Some(owner) = &owner {
                owner.live()?;
                if gate.as_ref().and_then(|gate| gate.process.as_ref()) != Some(&process)
                    || !matches!(record.lifecycle, ExecutionLifecycle::Running | ExecutionLifecycle::Interrupted)
                {
                    return Err("execution process disposition is unknown".into());
                }
                // Interrupted retains code/capacity claims and rejects all further input.
                record.lifecycle = ExecutionLifecycle::Interrupted;
            } else if record.lifecycle == ExecutionLifecycle::Interrupted {
                // No session in this daemon can ever prove this exit (daemon killed mid-step).
                // The confirmed human request is the attestation; nothing is signaled or inferred.
                let proof = proof_path(repo, &request.task_slug, &process);
                if proof.exists() || pending_exits().lock().unwrap_or_else(|e| e.into_inner()).contains_key(&proof) {
                    return Err("an exit for this process is still being recorded; retry".into());
                }
                release_interrupted_owner(state, &request.execution_id, &request.session_id)?;
            } else {
                return Err("live execution owner unavailable; shutdown is not proven".into());
            }
        }
        let record = state.executions.get_mut(&request.execution_id).ok_or("missing execution")?;
        record.human_end = Some(request.clone());
        record.ready_revision = None;
        record.ready_assessment = None;
        record.continuation_requested_revision = None;
        Ok(None)
    })?;
    // An unchanged retry may observe a prior rename whose directory sync failed.
    // Finish that durability obligation before either signaling or acknowledging a receipt.
    if authorized.is_none() || matches!(&authorized, Some(CompletionOutcome::Accepted { .. })) {
        sync_execution_state(repo, &request.task_slug)?;
    }
    if let Some(outcome) = authorized {
        return Ok(outcome);
    }
    drop(gate);
    // The registry is only held while copying the exact owner's PID; never during shutdown or disk IO.
    if let Some(owner) = &owner {
        let pid = {
            let map = reg.lock().unwrap_or_else(|e| e.into_inner());
            let current = map.get(&request.session_id).ok_or("session disappeared during human shutdown")?;
            if !Arc::ptr_eq(&current.inner, &owner.inner) || current.replacing.load(Ordering::SeqCst) {
                return Err("session process changed during human shutdown".into());
            }
            current.pid
        };
        wait_session_reaped(&owner.inner, pid);
        let inner = owner.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !inner.reaped_and_drained {
            return Ok(CompletionOutcome::Waiting {
                reason: "process exit and output drain are not proven; ownership retained; retry this handoff".into(),
            });
        }
        let ProcessState::Exited { code } = inner.state.process else {
            return Err("drained process has no exit status".into());
        };
        drop(inner);
        exited(repo, &request.task_slug, Some(&process), &meta.daemon_namespace, code);
    }
    reconcile_exits(repo, &request.task_slug, &meta.daemon_namespace)?;
    if !accept {
        sync_execution_state(repo, &request.task_slug)?;
        return Ok(CompletionOutcome::Waiting {
            reason: "execution stopped without publication".into(),
        });
    }
    let outcome = mutate_execution_state(repo, &request.task_slug, &meta.daemon_namespace, "accept human stopped handoff", |definition, state| {
        if read_process(repo, &request.task_slug, &request.session_id)?.as_ref() != Some(&process)
            || state
                .executions
                .get(&request.execution_id)
                .is_none_or(|record| record.owner_session_id != request.session_id)
        {
            return Ok(stale("execution owner changed before stopped handoff".into()));
        }
        accept_human_end(repo, &request.task_slug, definition, state, request)
    })?;
    if matches!(outcome, CompletionOutcome::Accepted { .. }) {
        sync_execution_state(repo, &request.task_slug)?;
    }
    Ok(outcome)
}

fn recovery_identity(repo: &Path, request: &EndExecutionRequest) -> Result<(SessionMeta, ExecutionRecord), String> {
    let (meta, process, record) = end_identity(repo, &request.task_slug, &request.execution_id, &request.session_id)?;
    task_for_owner(repo, &request.task_slug, &meta.daemon_namespace)?;
    if process.incarnation != request.process_incarnation || record.work_revision != request.work_revision {
        return Err("execution owner or work revision changed".into());
    }
    if record.receipt_id.is_some() {
        return Err("execution is already accepted".into());
    }
    Ok((meta, record))
}

pub(super) fn stop_execution(repo: &Path, reg: &Registry, request: &EndExecutionRequest) -> Result<StopExecutionReply, String> {
    recovery_identity(repo, request)?;
    let result = stop_execution_boundary(repo, reg, request, false)?;
    if let CompletionOutcome::Stale { reason } = result {
        return Err(reason);
    }
    let (_, record) = recovery_identity(repo, request)?;
    Ok(StopExecutionReply {
        shutdown_confirmed: record.shutdown_confirmed,
    })
}

pub(super) fn restart_execution(
    repo: &Path,
    reg: &Registry,
    lane: &str,
    config: &Path,
    host: &ProtectedHost,
    request: &EndExecutionRequest,
) -> Result<CreateExecutionSessionReply, String> {
    if !stop_execution(repo, reg, request)?.shutdown_confirmed {
        return Err("process exit and output drain are not proven; retry restart".into());
    }
    let (meta, record) = recovery_identity(repo, request)?;
    create_session_authorized(
        repo,
        reg,
        lane,
        config,
        host,
        CreateExecutionSessionRequest {
            task_slug: request.task_slug.clone(),
            target: ExecutionSessionTarget::Primary {
                step_key: record.candidate.step_key,
                execution_id: Some(request.execution_id.clone()),
                input_occurrence_ids: None,
            },
            start: true,
            launch_override: None,
            prompt_extra: Some(meta.prompt_extra),
            handoff_artifact: (!meta.handoff_artifact.is_empty()).then_some(meta.handoff_artifact),
        },
        Some(request),
    )
}

pub(super) fn preview_execution_artifacts(repo: &Path, request: &EndExecutionRequest, artifacts: &[SuppliedExecutionArtifact]) -> Result<ExecutionArtifactsPreview, String> {
    alinery_core::with_task_mutation_lock_waiting(repo, "preview supplied artifacts", alinery_core::TASK_MUTATION_CONTENTION_WAIT, || {
        let (_, record) = recovery_identity(repo, request)?;
        let state = read_execution_state(repo, &request.task_slug)?;
        let definition = read_task_playbook(repo, &request.task_slug, &state)?;
        preview_supplied(repo, request, artifacts, &definition, &state, &record)
    })
}

fn preview_supplied(
    repo: &Path,
    request: &EndExecutionRequest,
    artifacts: &[SuppliedExecutionArtifact],
    definition: &alinery_core::playbook::NormalizedPlaybook,
    state: &TaskExecutionState,
    record: &ExecutionRecord,
) -> Result<ExecutionArtifactsPreview, String> {
    use alinery_core::playbook_scheduler::{assess_execution, ExecutionAssessment, Terminality};
    if artifacts
        .iter()
        .any(|artifact| state.occurrences.values().any(|occurrence| occurrence.relative_path == artifact.relative_path))
    {
        return Err("supplied content cannot overwrite a published artifact".into());
    }
    match inspect_supplied_execution_publications(repo, &request.task_slug, record, artifacts) {
        Ok(publications) => Ok(ExecutionArtifactsPreview {
            assessment: assess_execution(definition, state, &request.execution_id, &publications)?,
            diagnostics: Vec::new(),
        }),
        Err(diagnostics) => Ok(ExecutionArtifactsPreview {
            assessment: ExecutionAssessment {
                destinations: Vec::new(),
                terminality: Terminality::Unresolved,
                reasons: Vec::new(),
            },
            diagnostics,
        }),
    }
}

pub(super) fn submit_execution_artifacts(repo: &Path, reg: &Registry, request: &EndExecutionRequest, artifacts: &[SuppliedExecutionArtifact]) -> Result<CompletionOutcome, String> {
    let preview = preview_execution_artifacts(repo, request, artifacts)?;
    if !preview.diagnostics.is_empty() {
        return Ok(CompletionOutcome::InvalidOutputs { diagnostics: preview.diagnostics });
    }
    if preview.assessment.terminality == alinery_core::playbook_scheduler::Terminality::Unresolved {
        return Ok(CompletionOutcome::Waiting {
            reason: "execution destinations remain unresolved".into(),
        });
    }
    if !stop_execution(repo, reg, request)?.shutdown_confirmed {
        return Ok(CompletionOutcome::Waiting {
            reason: "process exit and output drain are not proven; retry submission".into(),
        });
    }
    let (meta, _) = recovery_identity(repo, request)?;
    let outcome = mutate_execution_state(repo, &request.task_slug, &meta.daemon_namespace, "accept supplied artifact handoff", |definition, state| {
        let (_, record) = recovery_identity(repo, request)?;
        let preview = preview_supplied(repo, request, artifacts, definition, state, &record)?;
        if !preview.diagnostics.is_empty() {
            return Ok(CompletionOutcome::InvalidOutputs { diagnostics: preview.diagnostics });
        }
        if preview.assessment.terminality == alinery_core::playbook_scheduler::Terminality::Unresolved {
            return Ok(CompletionOutcome::Waiting {
                reason: "execution destinations remain unresolved".into(),
            });
        }
        for artifact in artifacts {
            save_supplied_artifact(repo, &request.task_slug, artifact)?;
        }
        accept_human_end(repo, &request.task_slug, definition, state, request)
    })?;
    sync_execution_state(repo, &request.task_slug)?;
    Ok(outcome)
}

// Traverse from a trusted repository descriptor. Neither a replaced directory
// symlink nor a final-file symlink can redirect human-supplied bytes.
fn save_supplied_artifact(repo: &Path, slug: &str, artifact: &SuppliedExecutionArtifact) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    alinery_core::artifact_file_path(repo, slug, &artifact.relative_path)?;
    let relative = format!(".alinery/tasks/{slug}/artifacts/{}", artifact.relative_path);
    let mut components = relative.split('/').peekable();
    let mut directory = fs::File::open(repo).map_err(|e| e.to_string())?;
    while let Some(component) = components.next() {
        let name = CString::new(component).map_err(|e| e.to_string())?;
        if components.peek().is_none() {
            let temporary = CString::new(format!(".recovery-{}", uuid::Uuid::new_v4())).unwrap();
            let fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    temporary.as_ptr(),
                    libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if fd < 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let mut file = unsafe { fs::File::from_raw_fd(fd) };
            let result = (|| {
                file.write_all(artifact.content.as_bytes()).map_err(|e| e.to_string())?;
                file.sync_all().map_err(|e| e.to_string())?;
                if unsafe { libc::renameat(directory.as_raw_fd(), temporary.as_ptr(), directory.as_raw_fd(), name.as_ptr()) } != 0 {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                directory.sync_all().map_err(|e| e.to_string())
            })();
            if result.is_err() {
                unsafe {
                    libc::unlinkat(directory.as_raw_fd(), temporary.as_ptr(), 0);
                }
            }
            return result;
        }
        if unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(error.to_string());
            }
        } else {
            directory.sync_all().map_err(|e| e.to_string())?;
        }
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        directory = unsafe { fs::File::from_raw_fd(fd) };
    }
    Err("missing artifact filename".into())
}

/// Captured at spawn, never reconstructed from an Exited projection or a PID.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(super) struct ExecutionProcess {
    execution_id: String,
    session_id: String,
    incarnation: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct ExitProof {
    process: ExecutionProcess,
    code: Option<i32>,
}

type PendingExits = std::collections::BTreeMap<PathBuf, ExitProof>;
static PENDING_EXITS: std::sync::LazyLock<Mutex<PendingExits>> = std::sync::LazyLock::new(|| Mutex::new(PendingExits::new()));

fn pending_exits() -> &'static Mutex<PendingExits> {
    &PENDING_EXITS
}

fn process_path(repo: &Path, slug: &str, session_id: &str) -> PathBuf {
    session_meta_path(repo, slug, session_id).with_file_name(format!("{session_id}.execution-process.json"))
}

pub(super) fn read_process(repo: &Path, slug: &str, session_id: &str) -> Result<Option<ExecutionProcess>, String> {
    match fs::read(process_path(repo, slug, session_id)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| format!("read execution incarnation: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read execution incarnation: {e}")),
    }
}

fn proof_path(repo: &Path, slug: &str, process: &ExecutionProcess) -> PathBuf {
    session_meta_path(repo, slug, &process.session_id).with_file_name(format!("{}.{}.execution-exit.json", process.session_id, process.incarnation))
}

// A previous rename may have succeeded while directory sync failed. Idempotent
// receipt/exit replay must finish durability without inventing another revision.
pub(super) fn sync_execution_state(repo: &Path, slug: &str) -> Result<(), String> {
    let path = execution_state_path(repo, slug)?;
    let parent = path.parent().ok_or("execution state has no parent")?;
    fs::File::open(&path)
        .and_then(|file| file.sync_all())
        .and_then(|()| fs::File::open(parent)?.sync_all())
        .map_err(|e| format!("ambiguous persistence after execution replay: {e}"))
}

fn apply_exit_proof(repo: &Path, slug: &str, lane: &str, proof: &ExitProof) -> Result<(), String> {
    mutate_execution_state(repo, slug, lane, "confirm reaped execution", |_, state| {
        let current = read_process(repo, slug, &proof.process.session_id)?.ok_or("missing execution process incarnation for exit proof")?;
        let record = state.executions.get(&proof.process.execution_id).ok_or("missing execution for exit proof")?;
        if current != proof.process || record.owner_session_id != proof.process.session_id {
            eprintln!("discard stale exit obligation for {slug}");
            return Ok(());
        }
        if matches!(record.lifecycle, ExecutionLifecycle::Starting | ExecutionLifecycle::Queued) {
            return Err("exit obligation cannot confirm an uncommitted or replacement launch".into());
        }
        confirm_execution_exit(state, &proof.process.execution_id, &proof.process.session_id, proof.code)
    })?;
    sync_execution_state(repo, slug)
}

fn reconcile_exits(repo: &Path, slug: &str, lane: &str) -> Result<(), String> {
    let dir = session_meta_path(repo, slug, "_").parent().ok_or("missing sessions directory")?.to_path_buf();
    // Keep the in-memory obligation if even its independent durable write fails.
    // Once journaled, a daemon restart needs no process/metadata inference.
    let pending: Vec<_> = pending_exits()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|(path, _)| path.parent() == Some(dir.as_path()))
        .map(|(path, proof)| (path.clone(), proof.clone()))
        .collect();
    let mut errors = Vec::new();
    for (path, proof) in pending {
        match serde_json::to_vec(&proof)
            .map_err(|e| e.to_string())
            .and_then(|bytes| alinery_core::fs_atomic::write_bytes_durable(&path, &bytes))
        {
            Ok(()) => {
                pending_exits().lock().unwrap_or_else(|e| e.into_inner()).remove(&path);
            }
            Err(error) => errors.push(format!("persist exit obligation {}: {error}", path.display())),
        }
    }
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) },
        Err(e) => return Err(format!("read exit obligations: {e}")),
    };
    for entry in entries {
        let result = (|| {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_name().to_string_lossy().ends_with(".execution-exit.json") {
                return Ok(());
            }
            let path = entry.path();
            let proof: ExitProof = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            if path != proof_path(repo, slug, &proof.process) {
                return Err("exit proof filename does not match its owner".into());
            }
            apply_exit_proof(repo, slug, lane, &proof)?;
            // State is durable before removal. A crash before unlink merely replays
            // the same confirmation; the core rejects conflicting observations.
            fs::remove_file(&path).map_err(|e| format!("remove confirmed exit proof: {e}"))
        })();
        if let Err(error) = result {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn mutate_execution_state<T>(
    repo: &Path,
    slug: &str,
    lane: &str,
    operation: &str,
    mutate: impl FnOnce(&alinery_core::playbook::NormalizedPlaybook, &mut TaskExecutionState) -> Result<T, String>,
) -> Result<T, String> {
    alinery_core::execution::mutate_execution_state(repo, slug, lane, execution_config_identity(), operation, mutate)
}

pub(super) fn product(repo: &Path, app_config: &Path) -> Result<LaunchChoices, String> {
    let defaults = alinery_core::read_scoped_settings_strict(app_config, repo)?.effective.defaults;
    Ok(LaunchChoices {
        harness: "omp".into(),
        model: alinery_core::omp_default_model(&defaults),
    })
}
fn project(
    repo: &Path,
    slug: &str,
    state: &TaskExecutionState,
    definition: &alinery_core::playbook::NormalizedPlaybook,
    record: &ExecutionRecord,
    extra: &str,
    handoff_artifact: &str,
) -> Result<SessionMeta, String> {
    let task = read_task(repo, slug).ok_or("missing task")?;
    let step = definition.step.iter().find(|s| s.key == record.candidate.step_key).ok_or("missing step")?;
    let path = session_meta_path(repo, slug, &record.owner_session_id);
    let existing = read_session_meta_full(&path);
    let mut meta = existing.clone().unwrap_or_default();
    meta.id = record.owner_session_id.clone();
    meta.execution_id = record.id.clone();
    meta.execution_revision = state.revision;
    meta.worktree = task.worktree.clone();
    meta.phase = step.key.clone();
    meta.harness = record.launch.harness.clone();
    meta.model = record.launch.model.clone();
    // Unlaunched reservations follow task authority; historical and uncertain
    // process owners keep the lane that actually owned their session.
    if existing.is_none() || matches!(record.lifecycle, ExecutionLifecycle::Queued | ExecutionLifecycle::Starting) {
        meta.daemon_namespace = state.owning_lane.clone();
    }
    meta.playbook.clear();
    meta.generic = false;
    if existing.is_none() {
        meta.created = now_secs();
        meta.telemetry_id = alinery_core::new_telemetry_id();
        meta.prompt_extra = extra.into();
        meta.handoff_artifact = handoff_artifact.into();
        meta.prompt = None;
    }
    let value = serde_json::to_value(&meta).map_err(|e| e.to_string())?;
    if existing.is_some() {
        stamp_meta(&path, |current| {
            for field in [
                "execution_id",
                "execution_revision",
                "worktree",
                "phase",
                "harness",
                "model",
                "daemon_namespace",
                "playbook",
                "generic",
            ] {
                current[field] = value[field].clone();
            }
        })?;
    } else {
        write_meta_atomic(&path, &value)?;
    }
    Ok(meta)
}
fn project_all(repo: &Path, slug: &str) -> Result<Vec<SessionMeta>, String> {
    let state = read_execution_state(repo, slug)?;
    let definition = read_task_playbook(repo, slug, &state)?;
    state.executions.values().map(|record| project(repo, slug, &state, &definition, record, "", "")).collect()
}

pub(super) fn reconcile_task(repo: &Path, slug: &str, reg: &Registry, lane: &str, app_config: &Path, host: &ProtectedHost) -> Result<(), String> {
    reconcile_exits(repo, slug, lane)?;
    let defaults = product(repo, app_config)?;
    mutate_execution_state(repo, slug, lane, "reconcile graph", |definition, state| {
        if state.creation != "ready" {
            return Ok(());
        }
        let candidates = reconcile_graph(definition, state)?;
        for candidate in candidates {
            let root_binding = candidate
                .inputs
                .values()
                .flatten()
                .all(|id| state.occurrences.get(id).is_some_and(|o| o.producer_execution_id.is_none()));
            let start_requested = !root_binding || state.initial_start_requested;
            reserve_execution(repo, slug, definition, state, candidate, &defaults, None, start_requested)?;
        }
        // Materialize every collection expectation before a single child may launch.
        let _ = reconcile_graph(definition, state)?;
        Ok(())
    })?;
    project_all(repo, slug)?;
    let ids: Vec<_> = read_execution_state(repo, slug)?
        .executions
        .values()
        .filter(|r| r.lifecycle == ExecutionLifecycle::Queued && r.start_requested)
        .map(|r| r.id.clone())
        .collect();
    for id in ids {
        launch_execution(repo, slug, &id, reg, lane, app_config, host)?;
    }
    Ok(())
}
fn launch_execution(repo: &Path, slug: &str, id: &str, reg: &Registry, lane: &str, app_config: &Path, host: &ProtectedHost) -> Result<(), String> {
    let claimed = mutate_execution_state(repo, slug, lane, "reserve execution launch", |_, state| claim_execution_launch(state, id))?;
    if !claimed {
        return Ok(());
    }
    let state = read_execution_state(repo, slug)?;
    let record = state.executions.get(id).ok_or("missing execution")?;
    let session_id = record.owner_session_id.clone();
    let result = (|| {
        let definition = read_task_playbook(repo, slug, &state)?;
        let meta = project(repo, slug, &state, &definition, record, "", "")?;
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
            if record.owner_session_id != session_id {
                return Err("stale execution owner".into());
            }
            if record.shutdown_confirmed {
                return Ok(());
            }
            if record.receipt_id.is_some() {
                return Ok(());
            }
            record.lifecycle = if stopped { ExecutionLifecycle::LaunchFailed } else { ExecutionLifecycle::Interrupted };
            record.shutdown_confirmed = stopped;
            record.error = Some(error.clone());
            Ok(())
        })?;
    }
    if let Some(error) = error {
        eprintln!("launch {slug}/{id}: {error}");
    }
    Ok(())
}
pub(super) fn task_for_owner(repo: &Path, slug: &str, lane: &str) -> Result<Option<alinery_core::Task>, String> {
    if slug.is_empty() {
        return Ok(None);
    }
    if alinery_core::safe_component(slug) != Some(slug) {
        return Err("invalid task slug".into());
    }
    let task = read_task(repo, slug).ok_or("missing task")?;
    if task.archived || task.draft {
        return Err("task is archived or draft".into());
    }
    if !task.has_worktree || task.worktree.trim().is_empty() || !Path::new(&task.worktree).is_dir() {
        return Err("missing-worktree".into());
    }
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

pub(super) fn query(repo: &Path, slug: &str, lane: &str, reg: &Registry) -> Result<TaskExecutionReply, String> {
    let state = read_execution_state(repo, slug)?;
    if state.owning_lane != lane || state.owning_app_config_identity != execution_config_identity() {
        return Err("task belongs to another daemon lane or app configuration".into());
    }
    let definition = read_task_playbook(repo, slug, &state)?;
    let mut reply = task_execution_reply(repo, slug, state, definition)?;
    for record in reply.state.executions.values() {
        if let Ok(owner) = owner(reg, &record.owner_session_id) {
            let Ok(gate) = owner.gate.try_lock() else { continue };
            if let Some(process) = &gate.process {
                if process.execution_id == record.id && owner.task_slug == slug {
                    reply.continuation.insert(
                        record.id.clone(),
                        ContinuationCapability {
                            process_incarnation: process.incarnation.clone(),
                            available: gate.available && owner.live().is_ok(),
                            reason: if owner.live().is_err() {
                                Some("execution process is unavailable".into())
                            } else if !gate.available {
                                Some(gate.reason.clone().unwrap_or_else(|| "selected native boundaries have not bound".into()))
                            } else {
                                gate.waiting_reason()
                            },
                        },
                    );
                }
            }
        }
    }
    Ok(reply)
}

/// Pinned stock `/skill:name` enters its selected public scope synchronously
/// before this response; `compact` and `set_model` await their public methods,
/// and `set_thinking_level` invokes its public method synchronously before ACK.
/// Discharge successful exact intake only, never native descendants or UI queue items.
pub(super) fn rpc_intake_response(reg: &Registry, session_id: &str, expected_inner: &Arc<Mutex<Inner>>, line: &[u8]) {
    let Ok(response) = serde_json::from_slice::<Value>(line) else { return };
    if response["type"] != "response" || response["success"] != true {
        return;
    }
    let Some(command) = response["command"].as_str() else { return };
    if !(matches!(command, "compact" | "set_model" | "set_thinking_level" | "set_auto_compaction") || command == "prompt" && response["data"]["agentInvoked"] == true) {
        return;
    }
    let Some(id) = response["id"].as_str() else { return };
    let Ok(owner) = owner(reg, session_id) else { return };
    if !Arc::ptr_eq(&owner.inner, expected_inner) || owner.live().is_err() {
        return;
    }
    let mut gate = owner.gate.lock().unwrap_or_else(|e| e.into_inner());
    if gate.available && gate.rpc_intakes.get(id).copied() == Some(command) {
        gate.rpc_intakes.remove(id);
        gate.pending_dispatches.remove(id);
    }
}
pub(super) fn create_task(repo: &Path, reg: &Registry, lane: &str, config: &Path, host: &ProtectedHost, request: CreateTaskRequest) -> Result<CreateTaskReply, String> {
    product(repo, config)?;
    let mut reply = provision_task(repo, lane, execution_config_identity(), &request)?;
    initialize_created_task(repo, reg, lane, config, host, request.start, &mut reply)?;
    Ok(reply)
}
pub(super) fn initialize_created_task(
    repo: &Path,
    reg: &Registry,
    lane: &str,
    config: &Path,
    host: &ProtectedHost,
    start: bool,
    reply: &mut CreateTaskReply,
) -> Result<(), String> {
    if reply.creation != "ready" {
        return Ok(());
    }
    let slug = reply.task.as_ref().ok_or("missing created task")?.slug.clone();
    if let Err(error) = reconcile_task(repo, &slug, reg, lane, config, host) {
        reply.errors.push(CreationError {
            stage: "execution".into(),
            code: "reconcile_failed".into(),
            message: error,
        });
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
            reply.errors.push(CreationError {
                stage: "launch".into(),
                code: code.into(),
                message: format!("{}: {error}", record.owner_session_id),
            });
        }
    }
    reply.start = if !start {
        "not_requested"
    } else if reply
        .executions
        .iter()
        .any(|r| matches!(r.lifecycle, ExecutionLifecycle::LaunchFailed | ExecutionLifecycle::Failed | ExecutionLifecycle::Interrupted))
    {
        "failed"
    } else if reply.executions.iter().any(|r| r.lifecycle == ExecutionLifecycle::Queued) {
        "queued"
    } else {
        "started"
    }
    .into();
    Ok(())
}
fn session_reply(repo: &Path, slug: &str, session: SessionMeta, requested: bool) -> Result<CreateExecutionSessionReply, String> {
    let execution = if session.execution_id.is_empty() {
        None
    } else {
        read_execution_state(repo, slug)?.executions.remove(&session.execution_id)
    };
    let start = if !requested {
        "not_requested"
    } else {
        match execution.as_ref().map(|r| &r.lifecycle) {
            Some(ExecutionLifecycle::Queued) => "queued",
            Some(ExecutionLifecycle::LaunchFailed | ExecutionLifecycle::Failed | ExecutionLifecycle::Interrupted) => "failed",
            _ => "started",
        }
    }
    .into();
    let errors = execution
        .as_ref()
        .and_then(|r| r.error.as_ref())
        .map(|e| {
            vec![CreationError {
                stage: "launch".into(),
                code: "execution_failed".into(),
                message: e.clone(),
            }]
        })
        .unwrap_or_default();
    Ok(CreateExecutionSessionReply {
        session,
        execution,
        start,
        errors,
    })
}
pub(super) fn session_for_launch(repo: &Path, slug: &str, id: &str) -> Result<SessionMeta, String> {
    let meta = read_session_meta_full(&session_meta_path(repo, slug, id)).ok_or("missing-session-meta")?;
    if meta.archived {
        return Err("session-archived".into());
    }
    Ok(meta)
}

pub(super) fn create_session(
    repo: &Path,
    reg: &Registry,
    lane: &str,
    config: &Path,
    host: &ProtectedHost,
    request: CreateExecutionSessionRequest,
) -> Result<CreateExecutionSessionReply, String> {
    create_session_authorized(repo, reg, lane, config, host, request, None)
}

fn create_session_authorized(
    repo: &Path,
    reg: &Registry,
    lane: &str,
    config: &Path,
    host: &ProtectedHost,
    request: CreateExecutionSessionRequest,
    expected: Option<&EndExecutionRequest>,
) -> Result<CreateExecutionSessionReply, String> {
    let slug = request.task_slug.as_str();
    if !slug.is_empty() && alinery_core::safe_component(slug) != Some(slug) {
        return Err("invalid task slug".into());
    }
    task_for_owner(repo, slug, lane)?;
    if let Some(artifact) = &request.handoff_artifact {
        alinery_core::artifact_file_path(repo, slug, artifact)?;
    }
    if let ExecutionSessionTarget::Primary {
        step_key,
        execution_id,
        input_occurrence_ids,
    } = &request.target
    {
        let defaults = product(repo, config)?;
        let id = mutate_execution_state(repo, slug, lane, "create execution session", |definition, state| {
            if let Some(expected) = expected {
                recovery_identity(repo, expected)?;
            }
            let id = if let Some(id) = execution_id {
                let record = state.executions.get(id).ok_or("unknown execution")?;
                if &record.candidate.step_key != step_key {
                    return Err("execution step mismatch".into());
                }
                let launch = if let Some(override_choices) = &request.launch_override {
                    let step = definition.step.iter().find(|step| &step.key == step_key).ok_or("unknown execution step")?;
                    Some(resolve_execution_launch(
                        definition,
                        step,
                        &state.launch_defaults,
                        &defaults,
                        Some(override_choices),
                        &state.step_models,
                    )?)
                } else {
                    None
                };
                recover_execution_owner(state, id)?;
                if let Some(launch) = launch {
                    state.executions.get_mut(id).ok_or("unknown execution")?.launch = launch;
                }
                id.clone()
            } else {
                let ids = input_occurrence_ids.as_ref().map(|ids| ids.iter().collect::<BTreeSet<_>>());
                let mut candidates = reconcile_graph(definition, state)?;
                candidates.extend(state.executions.values().map(|r| r.candidate.clone()));
                let mut candidates: Vec<_> = candidates
                    .into_iter()
                    .filter(|c| &c.step_key == step_key && ids.as_ref().is_none_or(|ids| c.inputs.values().flatten().collect::<BTreeSet<_>>() == *ids))
                    .collect();
                for candidate in &mut candidates {
                    candidate.manual = false;
                }
                candidates.sort_by_key(|c| c.binding_key().unwrap_or_default());
                candidates.dedup();
                if candidates.len() != 1 {
                    return Err("choose one complete eligible input binding".into());
                }
                let mut candidate = candidates.remove(0);
                candidate.manual = true;
                reserve_execution(repo, slug, definition, state, candidate, &defaults, request.launch_override.as_ref(), request.start)?
            };
            if request.start {
                request_execution_start(state, &id)?;
            }
            if expected.is_some() {
                // Do not replace the stopped owner until its fresh session can
                // actually be projected. Failed preparation retains recovery.
                let record = state.executions.get(&id).ok_or("missing execution")?;
                project(
                    repo,
                    slug,
                    state,
                    definition,
                    record,
                    request.prompt_extra.as_deref().unwrap_or(""),
                    request.handoff_artifact.as_deref().unwrap_or(""),
                )?;
            }
            Ok(id)
        })?;
        let snapshot = query(repo, slug, lane, reg)?;
        let record = snapshot.state.executions.get(&id).ok_or("missing execution")?;
        let session = project(
            repo,
            slug,
            &snapshot.state,
            &snapshot.definition,
            record,
            request.prompt_extra.as_deref().unwrap_or(""),
            request.handoff_artifact.as_deref().unwrap_or(""),
        )?;
        if request.start {
            launch_execution(repo, slug, &id, reg, lane, config, host)?;
        }
        return session_reply(repo, slug, session, request.start);
    }
    let mut session = alinery_core::with_task_mutation_lock_waiting(repo, "create auxiliary session", alinery_core::TASK_MUTATION_CONTENTION_WAIT, || {
        let task = task_for_owner(repo, slug, lane)?;
        let (harness, mut model, prompt, manager, child) = match &request.target {
            ExecutionSessionTarget::Auxiliary { harness, model, prompt } => (harness.clone(), model.clone().unwrap_or_default(), prompt.clone(), false, String::new()),
            ExecutionSessionTarget::SubtaskManager {
                subtask_slug,
                recover,
                harness,
                model,
            } => {
                let task = task.as_ref().ok_or("manager requires task")?;
                if read_task_session_metas(repo, slug).iter().any(|m| m.subtask_manager && !m.archived && m.ended_at.is_none()) {
                    return Err("task already has a live or unstarted manager".into());
                }
                let child = subtask_slug.clone().unwrap_or_default();
                if *recover {
                    let target = read_task(repo, &child).ok_or("missing child task")?;
                    if target.parent_task != slug || task.active_subtask != child {
                        return Err("invalid manager recovery binding".into());
                    }
                } else if !task.active_subtask.is_empty() || !child.is_empty() {
                    return Err("task already has an active child".into());
                }
                (harness.clone(), model.clone().unwrap_or_default(), None, true, child)
            }
            _ => unreachable!(),
        };
        if slug.is_empty() && harness != NO_HARNESS_KEY && harness != alinery_core::DEFAULT_HARNESS_KEY {
            return Err("root session must be Terminal".into());
        }
        alinery_core::resolve_harness_strict_for(config, repo, &harness)?;
        if harness == "omp" && model.trim().is_empty() {
            model = product(repo, config)?.model;
        }
        let id = format!("s{}", uuid::Uuid::new_v4());
        let meta = SessionMeta {
            id: id.clone(),
            worktree: task.as_ref().map(|t| t.worktree.clone()).unwrap_or_else(|| repo.to_string_lossy().into_owned()),
            harness,
            model,
            prompt,
            generic: true,
            subtask_manager: manager,
            subtask_slug: child,
            prompt_extra: request.prompt_extra.clone().unwrap_or_default(),
            handoff_artifact: request.handoff_artifact.clone().unwrap_or_default(),
            created: now_secs(),
            telemetry_id: alinery_core::new_telemetry_id(),
            daemon_namespace: lane.into(),
            ..SessionMeta::default()
        };
        fs::create_dir_all(session_meta_path(repo, slug, &id).parent().ok_or("missing session directory")?).map_err(|e| e.to_string())?;
        write_meta_atomic(&session_meta_path(repo, slug, &id), &serde_json::to_value(&meta).map_err(|e| e.to_string())?)?;
        Ok(meta)
    })?;
    if request.start {
        let launch = read_meta_launch_fields(repo, slug, &session.id).ok_or("missing session")?;
        if let Err(error) = spawn_session(reg, repo, launch, None, false, SessionTransport::Pty, false, None, lane, config, host) {
            return Ok(CreateExecutionSessionReply {
                session,
                execution: None,
                start: "failed".into(),
                errors: vec![CreationError {
                    stage: "launch".into(),
                    code: "spawn_failed".into(),
                    message: error,
                }],
            });
        }
        session = read_session_meta_full(&session_meta_path(repo, slug, &session.id)).unwrap_or(session);
    }
    session_reply(repo, slug, session, request.start)
}
pub(super) fn start(repo: &Path, reg: &Registry, lane: &str, config: &Path, host: &ProtectedHost, request: StartSessionRequest) -> Result<CreateExecutionSessionReply, String> {
    if alinery_core::safe_component(&request.session_id) != Some(request.session_id.as_str())
        || (!request.task_slug.is_empty() && alinery_core::safe_component(&request.task_slug) != Some(request.task_slug.as_str()))
    {
        return Err("invalid task or session id".into());
    }
    task_for_owner(repo, &request.task_slug, lane)?;
    let meta = session_for_launch(repo, &request.task_slug, &request.session_id)?;
    if meta.daemon_namespace != lane {
        return Err("session belongs to another daemon lane".into());
    }
    if !meta.execution_id.is_empty() {
        mutate_execution_state(repo, &request.task_slug, lane, "request execution start", |_, state| {
            let record = state.executions.get(&meta.execution_id).ok_or("missing execution")?;
            if record.owner_session_id != meta.id {
                return Err("stale execution owner".into());
            }
            request_execution_start(state, &meta.execution_id)
        })?;
        launch_execution(repo, &request.task_slug, &meta.execution_id, reg, lane, config, host)?;
        session_reply(repo, &request.task_slug, meta, true)
    } else {
        if !meta.generic && meta.harness != NO_HARNESS_KEY {
            return Err("pre-v2 task sessions cannot launch".into());
        }
        if meta.started_at.is_some() || meta.ended_at.is_some() {
            return Err("session already started".into());
        }
        let launch = read_meta_launch_fields(repo, &request.task_slug, &meta.id).ok_or("missing session")?;
        let result = spawn_session(reg, repo, launch, None, false, SessionTransport::Pty, false, None, lane, config, host);
        let mut reply = session_reply(repo, &request.task_slug, meta, result.is_ok())?;
        if let Err(error) = result {
            reply.start = "failed".into();
            reply.errors.push(CreationError {
                stage: "launch".into(),
                code: "spawn_failed".into(),
                message: error,
            });
        }
        Ok(reply)
    }
}
pub(super) fn exited(repo: &Path, slug: &str, process: Option<&ExecutionProcess>, lane: &str, code: Option<i32>) {
    let Some(process) = process else { return };
    let proof = ExitProof { process: process.clone(), code };
    let path = proof_path(repo, slug, process);
    pending_exits().lock().unwrap_or_else(|e| e.into_inner()).insert(path, proof);
    if let Err(error) = reconcile_exits(repo, slug, lane) {
        eprintln!("execution exit pending {slug}/[redacted]: {error}");
    }
}
pub(super) fn reconcile_repo(repo: &Path, reg: &Registry, lane: &str, config: &Path, host: &ProtectedHost) {
    for task in alinery_core::list_tasks_for_repo(repo).into_iter().filter(|t| !t.draft) {
        if read_execution_state(repo, &task.slug).is_ok_and(|s| s.owning_lane == lane && s.owning_app_config_identity == execution_config_identity() && s.creation == "ready") {
            if let Err(error) = reconcile_task(repo, &task.slug, reg, lane, config, host) {
                eprintln!("reconcile {}: {error}", task.slug);
            }
        }
    }
}

pub(super) fn spawned(repo: &Path, slug: &str, session_id: &str, lane: &str) -> Result<Option<ExecutionProcess>, String> {
    let Some(meta) = read_session_meta_full(&session_meta_path(repo, slug, session_id)) else {
        return Ok(None);
    };
    if meta.execution_id.is_empty() {
        return Ok(None);
    }
    let process = ExecutionProcess {
        execution_id: meta.execution_id.clone(),
        session_id: session_id.into(),
        incarnation: uuid::Uuid::new_v4().to_string(),
    };
    mutate_execution_state(repo, slug, lane, "commit spawned execution", |_, state| {
        let record = state.executions.get(&meta.execution_id).ok_or("missing execution")?;
        if record.owner_session_id != session_id {
            return Err("stale execution owner".into());
        }
        alinery_core::fs_atomic::write_bytes_durable(&process_path(repo, slug, session_id), &serde_json::to_vec(&process).map_err(|e| e.to_string())?)?;
        if record.lifecycle == ExecutionLifecycle::Running {
            return Ok(());
        }
        record_execution_spawn(state, &meta.execution_id, session_id, Ok(()))
    })?;
    Ok(Some(process))
}

pub(super) fn failed_spawn(repo: &Path, slug: &str, session_id: &str, lane: &str, reg: &Registry, error: &str) -> Result<(), String> {
    let meta = read_session_meta_full(&session_meta_path(repo, slug, session_id)).ok_or("missing session")?;
    if meta.execution_id.is_empty() {
        return Ok(());
    }
    let stopped = {
        let map = reg.lock().unwrap_or_else(|e| e.into_inner());
        map.get(session_id).is_none_or(|s| s.inner.lock().unwrap_or_else(|e| e.into_inner()).reaped_and_drained)
    };
    mutate_execution_state(repo, slug, lane, "record replacement launch failure", |_, state| {
        let record = state.executions.get_mut(&meta.execution_id).ok_or("missing execution")?;
        if record.owner_session_id != session_id {
            return Err("stale owner".into());
        }
        if record.shutdown_confirmed {
            return Ok(());
        }
        record.lifecycle = if stopped { ExecutionLifecycle::LaunchFailed } else { ExecutionLifecycle::Interrupted };
        record.shutdown_confirmed = stopped;
        record.error = Some(error.into());
        Ok(())
    })
}

#[cfg(test)]
mod bookkeeping_tests {
    use super::*;

    struct Fixture {
        repo: PathBuf,
        process: ExecutionProcess,
    }

    impl Fixture {
        fn new() -> Self {
            Self::with_review(false)
        }
        fn with_review(review: bool) -> Self {
            let repo = std::env::temp_dir().join(format!("alinery-exit-proof-{}", uuid::Uuid::new_v4()));
            let source = "+++\nversion=2\nkey='fixture'\ntitle='Fixture'\ndescription=''\ndefault_model=''\ndefault_harness='omp'\n[[step]]\nkey='work'\ntitle='Work'\nshort=''\nis_coding_step=false\nmodel=''\nharness=''\ninputs=[]\noutputs=[{path='result.md'}]\nauto_advance_default=true\n+++\n<!-- alinery:step work -->\nWork.\n";
            let source = if review {
                source.replace("+++\n<!-- alinery:step work", "[[step]]\nkey='next'\ntitle='Next'\nshort=''\nis_coding_step=false\nmodel=''\nharness=''\ninputs=[{path='result.md',mode='single'}]\noutputs=[{path='next.md'}]\nauto_advance_default=false\n+++\n<!-- alinery:step work")
                    + "<!-- alinery:step next -->\nConsume the result.\n"
            } else {
                source.to_string()
            };
            let definition = alinery_core::playbook::parse_playbook_md(&source).unwrap();
            let mut state = new_execution_state(
                alinery_core::playbook::PlaybookRef {
                    scope: alinery_core::playbook::PlaybookScope::Repo,
                    key: "fixture".into(),
                },
                &source,
                "lane".into(),
                1,
                if review { BTreeSet::new() } else { BTreeSet::from(["work".into()]) },
                LaunchChoices::default(),
                Default::default(),
            )
            .unwrap();
            state.creation = "ready".into();
            state.owning_app_config_identity = execution_config_identity().into();
            fs::create_dir_all(alinery_core::artifacts_dir(&repo, "task")).unwrap();
            fs::write(task_playbook_path(&repo, "task").unwrap(), &source).unwrap();
            let candidate = reconcile_graph(&definition, &mut state).unwrap().remove(0);
            let id = reserve_execution(&repo, "task", &definition, &mut state, candidate, &LaunchChoices::default(), None, true).unwrap();
            let session_id = state.executions[&id].owner_session_id.clone();
            assert!(claim_execution_launch(&mut state, &id).unwrap());
            record_execution_spawn(&mut state, &id, &session_id, Ok(())).unwrap();
            let path = &state.executions[&id].outputs[0].relative_path;
            fs::write(alinery_core::artifacts_dir(&repo, "task").join(path), "verified output").unwrap();
            let completion = report_execution_ready(&repo, "task", &definition, &mut state, &id, &session_id, 0).unwrap();
            assert!(matches!(completion, CompletionOutcome::Ready { .. }));
            if !review {
                assert!(matches!(
                    request_execution_continuation(&mut state, &id, &session_id, 0).unwrap(),
                    CompletionOutcome::Requested { .. }
                ));
                let completion = finalize_execution_continuation(&repo, "task", &definition, &mut state, &id, &session_id, 0).unwrap();
                assert!(matches!(completion, CompletionOutcome::Accepted { .. }));
            }
            write_execution_state_unlocked(&repo, "task", &mut state).unwrap();
            let process = ExecutionProcess {
                execution_id: id,
                session_id,
                incarnation: uuid::Uuid::new_v4().to_string(),
            };
            alinery_core::fs_atomic::write_bytes_durable(&process_path(&repo, "task", &process.session_id), &serde_json::to_vec(&process).unwrap()).unwrap();
            Self { repo, process }
        }
        fn state(&self) -> TaskExecutionState {
            read_execution_state(&self.repo, "task").unwrap()
        }
        fn owner(&self) -> Owner {
            let meta_path = session_meta_path(&self.repo, "task", &self.process.session_id);
            let meta = SessionMeta {
                id: self.process.session_id.clone(),
                execution_id: self.process.execution_id.clone(),
                daemon_namespace: "lane".into(),
                ..SessionMeta::default()
            };
            fs::write(&meta_path, serde_json::to_vec(&meta).unwrap()).unwrap();
            Owner {
                gate: Arc::new(Mutex::new(ContinuationGate {
                    process: Some(self.process.clone()),
                    bound_session: Some("fixture".into()),
                    available: true,
                    ..ContinuationGate::default()
                })),
                inner: Arc::new(Mutex::new(Inner {
                    parser: None,
                    clients: Vec::new(),
                    rpc_pending: VecDeque::new(),
                    rpc_pending_bytes: 0,
                    rpc_ready: None,
                    state: SessionState {
                        process: ProcessState::Alive,
                        adapter: HarnessAdapter::Omp,
                        ..SessionState::default()
                    },
                    activity_at: None,
                    reaped_and_drained: false,
                })),
                replacing: Arc::new(AtomicBool::new(false)),
                task_slug: "task".into(),
                session_id: self.process.session_id.clone(),
                meta_path,
                token: "fixture".into(),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            pending_exits().lock().unwrap().retain(|path, _| !path.starts_with(&self.repo));
            let _ = fs::remove_dir_all(&self.repo);
        }
    }

    #[test]
    fn capability_revision_overflow_rejects_before_durable_readiness_mutation() {
        let fixture = Fixture::with_review(true);
        let owner = fixture.owner();
        owner.gate.lock().unwrap_or_else(|e| e.into_inner()).capability_revision = MAX_WORK_REVISION;
        let before = fixture.state();
        assert_eq!(before.executions[&fixture.process.execution_id].ready_revision, Some(0));
        for event in [
            RunnerEvent::ContinuationBind {
                omp_session_id: "replacement".into(),
                groups: vec![],
                operation_id: "overflow-bind".into(),
                expected_capability_revision: MAX_WORK_REVISION,
            },
            RunnerEvent::ContinuationRevoke {
                process_incarnation: fixture.process.incarnation.clone(),
                operation_id: "overflow-revoke".into(),
                reason: "fixture boundary failed".into(),
                expected_capability_revision: MAX_WORK_REVISION,
            },
        ] {
            let error = match continuation_event(&fixture.repo, &owner, &event) {
                Err(error) => error,
                Ok(_) => panic!("capability revision overflow must not acknowledge a mutation"),
            };
            assert_eq!(error, "capability revision overflow");
            assert_eq!(fixture.state(), before, "overflow must preserve durable readiness, intent and admission generation");
        }
        let Some(RunnerEventResult::Control(control)) = continuation_event(&fixture.repo, &owner, &RunnerEvent::ContinuationPoll { process_incarnation: None }).unwrap() else {
            panic!("bootstrap must remain read-only control")
        };
        assert_eq!(control.capability_revision, MAX_WORK_REVISION);
        assert!(control.available);
        assert_eq!(fixture.state(), before);
    }

    #[test]
    fn failed_admission_cannot_replay_another_dispatch_after_readiness_renews() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = Fixture::with_review(true);
        let owner = fixture.owner();
        let mut gate = owner.gate.lock().unwrap_or_else(|e| e.into_inner());
        let path = execution_state_path(&fixture.repo, "task").unwrap();
        let parent = path.parent().unwrap();
        let permissions = fs::metadata(parent).unwrap().permissions();
        fs::set_permissions(parent, fs::Permissions::from_mode(0o500)).unwrap();
        let failed = owner.admit(&fixture.repo, &mut gate, "a", false);
        fs::set_permissions(parent, permissions).unwrap();
        assert!(failed.unwrap_err().contains("create durable temporary file"));
        assert_eq!(fixture.state().executions[&fixture.process.execution_id].ready_revision, Some(0));

        owner.admit(&fixture.repo, &mut gate, "b", false).unwrap();
        mutate_execution_state(&fixture.repo, "task", "lane", "renew fixture readiness", |definition, state| {
            let revision = state.executions[&fixture.process.execution_id].work_revision;
            let outcome = report_execution_ready(
                &fixture.repo,
                "task",
                definition,
                state,
                &fixture.process.execution_id,
                &fixture.process.session_id,
                revision,
            )?;
            assert!(matches!(outcome, CompletionOutcome::Ready { .. }));
            Ok(())
        })
        .unwrap();
        let ready = fixture.state();
        assert!(ready.executions[&fixture.process.execution_id].ready_revision.is_some());

        // A retry of the committed operation remains idempotent, including when
        // the caller did not observe the successful persistence acknowledgment.
        owner.admit(&fixture.repo, &mut gate, "b", false).unwrap();
        assert_eq!(fixture.state(), ready);
        let mut input = Vec::new();
        let outcome = dispatch_under_gate(&fixture.repo, &owner, &mut gate, "a", true, false, |_| {
            input.extend_from_slice(b"x");
            Ok(())
        });
        assert!(matches!(outcome, DispatchOutcome::NotSent { .. }));
        assert!(input.is_empty(), "stale admission must be refused before raw input reaches the process");
        assert_eq!(fixture.state(), ready, "refused stale input must not change renewed readiness");
    }

    #[test]
    fn completion_bookkeeping_retains_obligation_when_journal_write_fails() {
        let f = Fixture::new();
        let path = proof_path(&f.repo, "task", &f.process);
        fs::create_dir(&path).unwrap();
        exited(&f.repo, "task", Some(&f.process), "lane", Some(0));
        assert!(!f.state().executions[&f.process.execution_id].shutdown_confirmed);
        fs::remove_dir(&path).unwrap();
        reconcile_exits(&f.repo, "task", "lane").unwrap();
        assert_eq!(f.state().executions[&f.process.execution_id].lifecycle, ExecutionLifecycle::Completed);
        assert!(!path.exists());
        let before = f.state();
        exited(&f.repo, "task", Some(&f.process), "lane", Some(0));
        assert_eq!(f.state(), before, "duplicate confirmation cannot republish or advance revision");
    }

    // Issue #129: a daemon killed mid-step leaves its owner Interrupted with no exit proof and
    // no registry entry. Only the confirmed end/restart request releases it, and only once the
    // record is Interrupted and no exit for that process is still being recorded.
    #[test]
    fn confirmed_end_releases_interrupted_owner_this_daemon_never_held() {
        let f = Fixture::with_review(true);
        let _ = f.owner(); // writes the session meta; the registry stays empty
        alinery_core::write_task(
            &f.repo,
            &alinery_core::Task {
                slug: "task".into(),
                name: "Task".into(),
                has_worktree: true,
                worktree: f.repo.to_string_lossy().into_owned(),
                ..Default::default()
            },
        )
        .unwrap();
        let reg: Registry = Arc::new(Mutex::new(HashMap::new()));
        let prepare = PrepareEndExecutionRequest {
            task_slug: "task".into(),
            execution_id: f.process.execution_id.clone(),
            session_id: f.process.session_id.clone(),
        };
        let before = f.state();
        assert_eq!(
            prepare_end_execution(&f.repo, &reg, &prepare).unwrap_err(),
            "unknown-session",
            "a running owner is never released"
        );
        assert_eq!(f.state(), before);

        mutate_execution_state(&f.repo, "task", "lane", "fixture daemon restart", |_, state| {
            interrupt_unproven_owners(state, &BTreeSet::new());
            Ok(())
        })
        .unwrap();
        let request = prepare_end_execution(&f.repo, &reg, &prepare).unwrap().request;
        assert_eq!(request.process_incarnation, f.process.incarnation);
        assert_eq!(
            f.state().executions[&f.process.execution_id].lifecycle,
            ExecutionLifecycle::Interrupted,
            "preparation releases nothing"
        );

        let proof = proof_path(&f.repo, "task", &f.process);
        pending_exits().lock().unwrap().insert(
            proof.clone(),
            ExitProof {
                process: f.process.clone(),
                code: Some(0),
            },
        );
        assert!(stop_execution(&f.repo, &reg, &request).is_err(), "a pending exit outranks the attestation");
        pending_exits().lock().unwrap().remove(&proof);
        assert_eq!(f.state().executions[&f.process.execution_id].lifecycle, ExecutionLifecycle::Interrupted);

        assert!(stop_execution(&f.repo, &reg, &request).unwrap().shutdown_confirmed);
        let state = f.state();
        let record = &state.executions[&f.process.execution_id];
        assert_eq!(record.lifecycle, ExecutionLifecycle::Failed);
        assert_eq!(record.exit_code, None);
        assert!(record.receipt_id.is_none(), "release is not acceptance");
        assert_eq!(record.error.as_deref(), Some("previous process released by user; no exit was recorded"));
    }

    #[test]
    fn completion_bookkeeping_rejects_stale_incarnation_and_owner() {
        let f = Fixture::new();
        let old = f.process.clone();
        let mut replacement = old.clone();
        replacement.incarnation = uuid::Uuid::new_v4().to_string();
        alinery_core::fs_atomic::write_bytes_durable(&process_path(&f.repo, "task", &old.session_id), &serde_json::to_vec(&replacement).unwrap()).unwrap();
        let before = f.state();
        exited(&f.repo, "task", Some(&old), "lane", Some(0));
        assert_eq!(f.state(), before, "a previous process cannot confirm its replacement");
        mutate_execution_state(&f.repo, "task", "lane", "fixture replace session owner", |_, state| {
            state.executions.get_mut(&old.execution_id).unwrap().owner_session_id = "replacement-owner".into();
            Ok(())
        })
        .unwrap();
        let before = f.state();
        exited(&f.repo, "task", Some(&replacement), "lane", Some(0));
        assert_eq!(f.state(), before, "a previous session cannot confirm its replacement");
    }
}
