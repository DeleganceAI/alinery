//! Task-owned execution truth. Callers serialize mutations with the repository task lock;
//! session metadata is a repairable projection, never a scheduling input.
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::playbook::{parse_playbook_md, ArtifactSelector, NormalizedPlaybook, NormalizedStep, PlaybookRef};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct LaunchChoices {
    pub harness: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionLifecycle {
    Queued,
    Starting,
    Running,
    Finishing,
    Completed,
    LaunchFailed,
    Failed,
    Interrupted,
}

impl ExecutionLifecycle {
    pub fn holds_capacity(&self) -> bool {
        matches!(self, Self::Starting | Self::Running | Self::Finishing | Self::Interrupted)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CompletionPermission {
    Automatic,
    Locked,
    HumanGranted { execution_id: String, session_id: String },
    Consumed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ContextCause {
    Root,
    Member {
        collection_id: String,
        occurrence_id: String,
    },
    Loop {
        component_steps: BTreeSet<String>,
        trigger_occurrences: BTreeSet<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionContext {
    pub id: String,
    pub parent_id: Option<String>,
    pub cause: ContextCause,
    pub bindings: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactOccurrence {
    pub id: String,
    pub producer_execution_id: Option<String>,
    pub selector: String,
    pub logical_path: String,
    pub relative_path: String,
    pub depth: u64,
    pub discriminator: u64,
    pub context_id: String,
    pub collection_ids: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactCollection {
    pub id: String,
    pub context_id: String,
    pub selector: String,
    pub producer_step: String,
    pub source_collection_id: Option<String>,
    pub expected_execution_ids: BTreeSet<String>,
    pub member_occurrence_ids: BTreeSet<String>,
    pub membership_closed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutputAssignment {
    pub selector: String,
    pub relative_path: String,
    pub discriminator: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionCandidate {
    pub step_key: String,
    pub context_id: String,
    pub inputs: BTreeMap<String, Vec<String>>,
    pub complete_collection_id: Option<String>,
    pub each_collection_id: Option<String>,
    pub each_member_id: Option<String>,
    pub manual: bool,
}

impl ExecutionCandidate {
    pub fn binding_key(&self) -> Result<String, String> {
        let mut normalized = self.clone();
        for ids in normalized.inputs.values_mut() {
            ids.sort();
            ids.dedup();
        }
        serde_json::to_string(&normalized).map_err(|e| e.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionRecord {
    pub id: String,
    pub binding_key: String,
    pub candidate: ExecutionCandidate,
    pub outputs: Vec<OutputAssignment>,
    pub parent_execution_ids: BTreeSet<String>,
    pub depth: u64,
    pub owner_session_id: String,
    pub previous_session_ids: Vec<String>,
    pub launch: LaunchChoices,
    pub is_coding_step: bool,
    pub start_requested: bool,
    pub lifecycle: ExecutionLifecycle,
    pub permission: CompletionPermission,
    pub receipt_id: Option<String>,
    pub exit_code: Option<i32>,
    pub shutdown_confirmed: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskExecutionState {
    pub version: u32,
    pub revision: u64,
    pub creation: String,
    pub creation_error: Option<String>,
    #[serde(default)]
    pub initial_start_requested: bool,
    pub owning_lane: String,
    #[serde(default)]
    pub owning_app_config_identity: String,
    pub definition_identity: String,
    pub reference: PlaybookRef,
    pub max_live_sessions: u32,
    pub enabled_steps: BTreeSet<String>,
    pub launch_defaults: LaunchChoices,
    pub contexts: BTreeMap<String, ExecutionContext>,
    pub executions: BTreeMap<String, ExecutionRecord>,
    pub occurrences: BTreeMap<String, ArtifactOccurrence>,
    pub collections: BTreeMap<String, ArtifactCollection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CompletionOutcome {
    Accepted { receipt_id: String },
    HumanAuthorizationRequired,
    InvalidOutputs { diagnostics: Vec<String> },
}

pub fn execution_state_path(repo: &Path, slug: &str) -> Result<PathBuf, String> {
    if crate::safe_component(slug) != Some(slug) {
        return Err("invalid task slug".into());
    }
    Ok(crate::task_dir(repo, slug).join("execution.json"))
}

pub fn task_playbook_path(repo: &Path, slug: &str) -> Result<PathBuf, String> {
    Ok(execution_state_path(repo, slug)?.with_file_name("playbook.md"))
}

pub fn read_execution_state(repo: &Path, slug: &str) -> Result<TaskExecutionState, String> {
    let path = execution_state_path(repo, slug)?;
    let bytes = fs::read(&path).map_err(|e| format!("task execution state unavailable (pre-v2 tasks cannot launch): {}: {e}", path.display()))?;
    let state: TaskExecutionState = serde_json::from_slice(&bytes).map_err(|e| format!("invalid task execution state: {e}"))?;
    if state.version != 1 || state.max_live_sessions == 0 {
        return Err("unsupported or invalid task execution state".into());
    }
    Ok(state)
}

pub fn read_task_playbook(repo: &Path, slug: &str, state: &TaskExecutionState) -> Result<NormalizedPlaybook, String> {
    let path = task_playbook_path(repo, slug)?;
    let source = fs::read_to_string(&path).map_err(|e| format!("read retained task definition: {e}"))?;
    if definition_identity(source.as_bytes()) != state.definition_identity {
        return Err("retained task definition integrity mismatch".into());
    }
    parse_playbook_md(&source).map_err(|errors| format!("invalid retained task definition: {errors:?}"))
}

// Integrity detection, not authentication against a user who can edit both task files.
pub fn definition_identity(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

pub fn new_execution_state(
    reference: PlaybookRef,
    source: &str,
    owning_lane: String,
    max_live_sessions: u32,
    enabled_steps: BTreeSet<String>,
    launch_defaults: LaunchChoices,
) -> Result<TaskExecutionState, String> {
    if max_live_sessions == 0 {
        return Err("maximum live sessions must be positive".into());
    }
    let definition = parse_playbook_md(source).map_err(|e| format!("invalid task playbook: {e:?}"))?;
    if definition.key != reference.key {
        return Err("task playbook key does not match source identity".into());
    }
    for harness in std::iter::once(definition.default_harness.as_str())
        .chain(definition.step.iter().map(|step| step.harness.as_str()))
        .chain(std::iter::once(launch_defaults.harness.as_str()))
    {
        if !harness.trim().is_empty() && harness.trim() != "omp" {
            return Err(format!("unsupported graph harness '{harness}'"));
        }
    }
    for key in &enabled_steps {
        if !definition.step.iter().any(|step| &step.key == key) {
            return Err(format!("unknown enabled step '{key}'"));
        }
    }
    let root = ExecutionContext {
        id: "root".into(),
        parent_id: None,
        cause: ContextCause::Root,
        bindings: BTreeMap::new(),
    };
    Ok(TaskExecutionState {
        version: 1,
        revision: 0,
        creation: "provisioning".into(),
        creation_error: None,
        owning_lane,
        owning_app_config_identity: String::new(),
        definition_identity: definition_identity(source.as_bytes()),
        reference,
        max_live_sessions,
        enabled_steps,
        launch_defaults,
        initial_start_requested: false,
        contexts: BTreeMap::from([(root.id.clone(), root)]),
        executions: BTreeMap::new(),
        occurrences: BTreeMap::new(),
        collections: BTreeMap::new(),
    })
}

pub fn install_seed(state: &mut TaskExecutionState, logical_path: &str, relative_path: &str) -> Result<String, String> {
    let selector = ArtifactSelector::parse(logical_path)?;
    if selector.wildcard {
        return Err("seed must have an exact logical path".into());
    }
    let root = state.contexts.get_mut("root").ok_or("missing root context")?;
    if root.bindings.contains_key(logical_path) {
        return Err(format!("duplicate seed '{logical_path}'"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    root.bindings.insert(logical_path.into(), vec![id.clone()]);
    state.occurrences.insert(
        id.clone(),
        ArtifactOccurrence {
            id: id.clone(),
            producer_execution_id: None,
            selector: logical_path.into(),
            logical_path: logical_path.into(),
            relative_path: relative_path.into(),
            depth: 0,
            discriminator: 0,
            context_id: "root".into(),
            collection_ids: BTreeSet::new(),
        },
    );
    Ok(id)
}

/// Caller holds the task mutation lock. An error after rename is explicitly ambiguous.
pub fn write_execution_state_unlocked(repo: &Path, slug: &str, state: &mut TaskExecutionState) -> Result<(), String> {
    state.revision = state.revision.checked_add(1).ok_or("execution revision overflow")?;
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    crate::fs_atomic::write_bytes_durable(&execution_state_path(repo, slug)?, &bytes)
}

pub fn mutate_execution_state<T>(
    repo: &Path,
    slug: &str,
    lane: &str,
    app_config_identity: &str,
    operation: &str,
    mutate: impl FnOnce(&NormalizedPlaybook, &mut TaskExecutionState) -> Result<T, String>,
) -> Result<T, String> {
    crate::with_task_mutation_lock(repo, operation, || {
        let mut state = read_execution_state(repo, slug)?;
        if state.owning_lane != lane || state.owning_app_config_identity != app_config_identity {
            return Err("task execution belongs to another daemon lane or app configuration".into());
        }
        let definition = read_task_playbook(repo, slug, &state)?;
        let result = mutate(&definition, &mut state)?;
        write_execution_state_unlocked(repo, slug, &mut state)?;
        Ok(result)
    })
}

pub fn resolve_execution_launch(
    definition: &NormalizedPlaybook,
    step: &NormalizedStep,
    task: &LaunchChoices,
    product: &LaunchChoices,
    explicit: Option<&LaunchChoices>,
) -> Result<LaunchChoices, String> {
    fn first<'a>(values: impl IntoIterator<Item = &'a str>) -> String {
        values.into_iter().find(|s| !s.trim().is_empty()).unwrap_or("").trim().to_string()
    }
    let launch = LaunchChoices {
        harness: first([
            explicit.map_or("", |v| v.harness.as_str()),
            &step.harness,
            &definition.default_harness,
            &task.harness,
            &product.harness,
            "omp",
        ]),
        model: first([
            explicit.map_or("", |v| v.model.as_str()),
            &step.model,
            &definition.default_model,
            &task.model,
            &product.model,
        ]),
    };
    if launch.harness != "omp" {
        return Err(format!("unsupported graph harness '{}'", launch.harness));
    }
    Ok(launch)
}

fn output_path(selector: &str, depth: u64, discriminator: u64) -> Result<String, String> {
    ArtifactSelector::parse(selector)?;
    let (directory, name) = selector.rsplit_once('/').map_or(("", selector), |(dir, name)| (dir, name));
    let stem = name.strip_suffix(".md").ok_or("output must be Markdown")?;
    let filename = format!("{depth}-{stem}-{discriminator}.md");
    Ok(if directory.is_empty() { filename } else { format!("{directory}/{filename}") })
}

fn parent_directories<'a>(paths: impl IntoIterator<Item = &'a str>) -> BTreeSet<String> {
    let mut directories = BTreeSet::new();
    for mut path in paths {
        while let Some((parent, _)) = path.rsplit_once('/') {
            directories.insert(parent.to_string());
            path = parent;
        }
    }
    directories
}

fn validate_execution_binding(state: &TaskExecutionState, step: &NormalizedStep, candidate: &ExecutionCandidate) -> Result<(), String> {
    use crate::playbook::InputMode;
    let expected: BTreeSet<_> = step.inputs.iter().map(|input| input.path.as_str()).collect();
    if expected != candidate.inputs.keys().map(String::as_str).collect() {
        return Err("execution bindings must match the step's declared inputs".into());
    }
    let mut uses_each = false;
    let mut uses_complete = false;
    for input in &step.inputs {
        let ids = &candidate.inputs[&input.path];
        let selector = ArtifactSelector::parse(&input.path)?;
        if ids.is_empty() || ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
            return Err("execution inputs must be nonempty distinct occurrences".into());
        }
        for id in ids {
            let occurrence = state.occurrences.get(id).ok_or("unknown input occurrence")?;
            if !selector.matches(&occurrence.logical_path) {
                return Err("input occurrence does not match declared selector".into());
            }
        }
        match input.mode {
            InputMode::Single if ids.len() != 1 => return Err("single input requires exactly one occurrence".into()),
            InputMode::Single => {}
            InputMode::Each => {
                uses_each = true;
                let collection_id = candidate.each_collection_id.as_ref().ok_or("missing each collection")?;
                let collection = state.collections.get(collection_id).ok_or("unknown each collection")?;
                if ids.len() != 1 || candidate.each_member_id.as_ref() != ids.first() || !collection.membership_closed || !collection.member_occurrence_ids.contains(&ids[0]) {
                    return Err("each binding does not identify one accepted collection member".into());
                }
                let context = state.contexts.get(&candidate.context_id).ok_or("unknown each context")?;
                if !matches!(&context.cause, ContextCause::Member { collection_id: bound, occurrence_id } if bound == collection_id && occurrence_id == &ids[0]) {
                    return Err("each execution context does not match its member".into());
                }
            }
            InputMode::Complete => {
                uses_complete = true;
                let collection = state
                    .collections
                    .get(candidate.complete_collection_id.as_ref().ok_or("missing complete collection")?)
                    .ok_or("unknown complete collection")?;
                let members: BTreeSet<_> = collection
                    .member_occurrence_ids
                    .iter()
                    .filter(|id| state.occurrences.get(*id).is_some_and(|occurrence| selector.matches(&occurrence.logical_path)))
                    .collect();
                if !collection.membership_closed
                    || members != ids.iter().collect()
                    || collection.context_id != candidate.context_id
                    || collection.expected_execution_ids.iter().any(|id| {
                        !state
                            .executions
                            .get(id)
                            .is_some_and(|record| record.lifecycle == ExecutionLifecycle::Completed && record.shutdown_confirmed && record.receipt_id.is_some())
                    })
                {
                    return Err("complete input requires the entire closed collection after producer handoff".into());
                }
            }
        }
    }
    if uses_each != candidate.each_collection_id.is_some() || uses_each != candidate.each_member_id.is_some() || uses_complete != candidate.complete_collection_id.is_some() {
        return Err("undeclared collection binding".into());
    }
    Ok(())
}

fn occupied_artifacts(root: &Path, relative: &Path, paths: &mut Vec<String>) -> Result<(), String> {
    let directory = root.join(relative);
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("read artifacts {}: {e}", directory.display())),
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let rel = relative.join(entry.file_name());
        let name = rel.to_str().ok_or("non UTF-8 artifact path")?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            if relative.as_os_str().is_empty() && matches!(entry.file_name().to_str(), Some("attachments" | "subtasks")) {
                continue;
            }
            paths.push(name.into());
            occupied_artifacts(root, &rel, paths)?;
        } else {
            paths.push(name.into());
        }
    }
    Ok(())
}

/// Reserve the complete output set before any process launch or artifact write.
/// All callers must hold the repo mutation lock until this state is committed.
pub fn reserve_execution(
    repo: &Path,
    slug: &str,
    definition: &NormalizedPlaybook,
    state: &mut TaskExecutionState,
    candidate: ExecutionCandidate,
    product: &LaunchChoices,
    explicit: Option<&LaunchChoices>,
    start_requested: bool,
) -> Result<String, String> {
    let binding_key = candidate.binding_key()?;
    if !candidate.manual {
        if let Some(existing) = state.executions.values().find(|e| !e.candidate.manual && e.binding_key == binding_key) {
            return Ok(existing.id.clone());
        }
    }
    let step = definition.step.iter().find(|step| step.key == candidate.step_key).ok_or("unknown execution step")?;
    if !state.contexts.contains_key(&candidate.context_id) {
        return Err("unknown binding context".into());
    }
    validate_execution_binding(state, step, &candidate)?;
    let mut parents = BTreeSet::new();
    let mut parent_depth = 0;
    for occurrence_id in candidate.inputs.values().flatten() {
        let occurrence = state.occurrences.get(occurrence_id).ok_or("unknown input occurrence")?;
        if !occurrence_deliverable(state, occurrence) {
            return Err("input producer has not completed handoff".into());
        }
        parent_depth = parent_depth.max(occurrence.depth);
        if let Some(parent) = &occurrence.producer_execution_id {
            parents.insert(parent.clone());
        }
    }
    let depth = parent_depth.checked_add(1).ok_or("execution depth overflow")?;
    let mut occupied = Vec::new();
    let root = crate::shared::resolve_artifact_directory(repo, &format!(".alinery/tasks/{slug}/artifacts"))?;
    occupied_artifacts(&root, Path::new(""), &mut occupied)?;
    // Physical reservations remain disjoint on case-insensitive filesystems too;
    // logical selector identity stays case-sensitive.
    let occupied: Vec<_> = occupied.into_iter().map(|path| path.to_lowercase()).collect();
    let reservations: Vec<_> = state
        .executions
        .values()
        .flat_map(|e| e.outputs.iter())
        .map(|a| ArtifactSelector::parse(&a.relative_path.to_lowercase()))
        .collect::<Result<_, _>>()?;
    let required_directories = parent_directories(step.outputs.iter().map(|output| output.path.as_str()));
    for directory in &required_directories {
        crate::shared::resolve_artifact_directory(&root, directory)?;
        if reservations.iter().any(|reservation| reservation.matches(&directory.to_lowercase())) {
            return Err(format!("output directory '{directory}' conflicts with a reserved output file"));
        }
    }
    let mut occupied_directories = parent_directories(
        state
            .executions
            .values()
            .flat_map(|record| record.outputs.iter())
            .map(|assignment| assignment.relative_path.as_str()),
    );
    occupied_directories.extend(required_directories);
    let occupied_directories: BTreeSet<_> = occupied_directories.into_iter().map(|path| path.to_lowercase()).collect();
    let mut outputs: Vec<OutputAssignment> = Vec::new();
    let mut output_selectors = Vec::new();
    for output in &step.outputs {
        let mut instance = 1_u64;
        loop {
            let relative_path = output_path(&output.path, depth, instance)?;
            let physical = ArtifactSelector::parse(&relative_path.to_lowercase())?;
            let existing_overlap = occupied.iter().any(|name| physical.matches(name)) || occupied_directories.iter().any(|directory| physical.matches(directory));
            let reserved_overlap = reservations.iter().chain(&output_selectors).any(|other| physical.overlaps(other));
            if !existing_overlap && !reserved_overlap {
                outputs.push(OutputAssignment {
                    selector: output.path.clone(),
                    relative_path,
                    discriminator: instance,
                });
                output_selectors.push(physical);
                break;
            }
            instance = instance.checked_add(1).ok_or("artifact instance overflow")?;
        }
    }
    let launch = resolve_execution_launch(definition, step, &state.launch_defaults, product, explicit)?;
    let id = uuid::Uuid::new_v4().to_string();
    let record = ExecutionRecord {
        id: id.clone(),
        binding_key,
        candidate,
        outputs,
        parent_execution_ids: parents,
        depth,
        owner_session_id: format!("s{}", uuid::Uuid::new_v4()),
        previous_session_ids: Vec::new(),
        launch,
        is_coding_step: step.is_coding_step,
        start_requested,
        lifecycle: ExecutionLifecycle::Queued,
        permission: if state.enabled_steps.contains(&step.key) {
            CompletionPermission::Automatic
        } else {
            CompletionPermission::Locked
        },
        receipt_id: None,
        exit_code: None,
        shutdown_confirmed: false,
        error: None,
    };
    state.executions.insert(id.clone(), record);
    Ok(id)
}

pub fn occurrence_deliverable(state: &TaskExecutionState, occurrence: &ArtifactOccurrence) -> bool {
    match &occurrence.producer_execution_id {
        None => state.creation == "ready",
        Some(id) => state
            .executions
            .get(id)
            .is_some_and(|e| e.lifecycle == ExecutionLifecycle::Completed && e.shutdown_confirmed && e.receipt_id.is_some()),
    }
}

pub fn request_execution_start(state: &mut TaskExecutionState, id: &str) -> Result<(), String> {
    let record = state.executions.get_mut(id).ok_or("unknown execution")?;
    if record.lifecycle != ExecutionLifecycle::Queued {
        return Err("execution is not queued; recover failed work explicitly".into());
    }
    record.start_requested = true;
    Ok(())
}

pub fn claim_execution_launch(state: &mut TaskExecutionState, id: &str) -> Result<bool, String> {
    if state.creation != "ready" {
        return Err("task creation is not ready".into());
    }
    let record = state.executions.get(id).ok_or("unknown execution")?;
    if record.lifecycle != ExecutionLifecycle::Queued || !record.start_requested {
        return Ok(false);
    }
    let live = state.executions.values().filter(|e| e.lifecycle.holds_capacity()).count();
    if live >= state.max_live_sessions as usize {
        return Ok(false);
    }
    if record.is_coding_step && state.executions.values().any(|e| e.is_coding_step && e.lifecycle.holds_capacity()) {
        return Ok(false);
    }
    state.executions.get_mut(id).ok_or("unknown execution")?.lifecycle = ExecutionLifecycle::Starting;
    Ok(true)
}

pub fn record_execution_spawn(state: &mut TaskExecutionState, id: &str, session_id: &str, result: Result<(), String>) -> Result<(), String> {
    let record = owned_execution(state, id, session_id)?;
    if record.lifecycle != ExecutionLifecycle::Starting {
        return Err("execution has no launch claim".into());
    }
    match result {
        Ok(()) => record.lifecycle = ExecutionLifecycle::Running,
        Err(error) => {
            record.lifecycle = ExecutionLifecycle::LaunchFailed;
            record.shutdown_confirmed = true;
            record.error = Some(error);
        }
    }
    Ok(())
}

fn owned_execution<'a>(state: &'a mut TaskExecutionState, id: &str, session_id: &str) -> Result<&'a mut ExecutionRecord, String> {
    let record = state.executions.get_mut(id).ok_or("unknown execution")?;
    if record.owner_session_id != session_id {
        return Err("stale execution owner".into());
    }
    Ok(record)
}

pub fn grant_execution_completion(state: &mut TaskExecutionState, id: &str, session_id: &str) -> Result<(), String> {
    let record = owned_execution(state, id, session_id)?;
    if record.lifecycle != ExecutionLifecycle::Running || record.receipt_id.is_some() {
        return Err("execution is not awaiting completion permission".into());
    }
    record.permission = CompletionPermission::HumanGranted {
        execution_id: id.into(),
        session_id: session_id.into(),
    };
    Ok(())
}

fn assigned_members(repo: &Path, slug: &str, assignment: &OutputAssignment) -> Result<Vec<(String, String)>, String> {
    let logical = ArtifactSelector::parse(&assignment.selector)?;
    let physical = ArtifactSelector::parse(&assignment.relative_path)?;
    let root = crate::shared::resolve_artifact_directory(repo, &format!(".alinery/tasks/{slug}/artifacts"))?;
    let paths = if physical.wildcard {
        let probe = if physical.directory.is_empty() {
            "__assignment_probe.md".to_string()
        } else {
            format!("{}/__assignment_probe.md", physical.directory)
        };
        let parent = crate::resolve_artifact_path(&root, &probe)?.parent().ok_or("artifact has no directory")?.to_path_buf();
        let mut paths = Vec::new();
        for entry in fs::read_dir(parent).map_err(|e| format!("read assigned output directory: {e}"))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().into_string().map_err(|_| "non UTF-8 output")?;
            let relative = if physical.directory.is_empty() {
                name
            } else {
                format!("{}/{name}", physical.directory)
            };
            if physical.matches(&relative) {
                paths.push(relative);
            }
        }
        paths.sort();
        paths
    } else {
        vec![assignment.relative_path.clone()]
    };
    if paths.is_empty() {
        return Err(format!("required output family '{}' is empty", assignment.relative_path));
    }
    let mut members = Vec::new();
    for relative in paths {
        let path = crate::resolve_artifact_path(&root, &relative)?;
        let meta = fs::symlink_metadata(&path).map_err(|e| format!("required output {relative}: {e}"))?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() == 0 {
            return Err(format!("required output '{relative}' must be a nonempty regular file"));
        }
        let logical_path = if physical.wildcard {
            let name = relative.rsplit('/').next().ok_or("invalid output filename")?;
            let slot = name
                .strip_prefix(&physical.prefix)
                .and_then(|rest| rest.strip_suffix(&physical.suffix))
                .filter(|s| !s.is_empty())
                .ok_or("wildcard output member must have a nonempty slot")?;
            let name = format!("{}{}{}", logical.prefix, slot, logical.suffix);
            if logical.directory.is_empty() {
                name
            } else {
                format!("{}/{name}", logical.directory)
            }
        } else {
            assignment.selector.clone()
        };
        members.push((logical_path, relative));
    }
    Ok(members)
}

/// The enclosing transaction must commit before returning this outcome to the runner.
pub fn accept_execution_completion(repo: &Path, slug: &str, state: &mut TaskExecutionState, id: &str, session_id: &str) -> Result<CompletionOutcome, String> {
    let record = owned_execution(state, id, session_id)?;
    if let Some(receipt_id) = &record.receipt_id {
        return Ok(CompletionOutcome::Accepted { receipt_id: receipt_id.clone() });
    }
    if record.lifecycle != ExecutionLifecycle::Running {
        return Err("execution owner is not running".into());
    }
    match &record.permission {
        CompletionPermission::Automatic => {}
        CompletionPermission::HumanGranted { execution_id, session_id: owner } if execution_id == id && owner == session_id => {}
        _ => return Ok(CompletionOutcome::HumanAuthorizationRequired),
    }
    let mut accepted = Vec::new();
    let mut diagnostics = Vec::new();
    for assignment in &record.outputs {
        match assigned_members(repo, slug, assignment) {
            Ok(members) => {
                for (logical_path, relative_path) in members {
                    let occurrence_id = uuid::Uuid::new_v4().to_string();
                    accepted.push(ArtifactOccurrence {
                        id: occurrence_id,
                        producer_execution_id: Some(id.into()),
                        selector: assignment.selector.clone(),
                        logical_path,
                        relative_path,
                        depth: record.depth,
                        discriminator: assignment.discriminator,
                        context_id: record.candidate.context_id.clone(),
                        collection_ids: BTreeSet::new(),
                    });
                }
            }
            Err(error) => diagnostics.push(error),
        }
    }
    if !diagnostics.is_empty() {
        record.error = Some(diagnostics.join("\n"));
        return Ok(CompletionOutcome::InvalidOutputs { diagnostics });
    }
    let receipt_id = uuid::Uuid::new_v4().to_string();
    record.receipt_id = Some(receipt_id.clone());
    record.permission = CompletionPermission::Consumed;
    record.lifecycle = ExecutionLifecycle::Finishing;
    record.error = None;
    for occurrence in accepted {
        state.occurrences.insert(occurrence.id.clone(), occurrence);
    }
    Ok(CompletionOutcome::Accepted { receipt_id })
}

/// Only the process owner may invoke this after wait/reap AND output drain succeed.
pub fn confirm_execution_exit(state: &mut TaskExecutionState, id: &str, session_id: &str, exit_code: Option<i32>) -> Result<(), String> {
    let record = owned_execution(state, id, session_id)?;
    record.shutdown_confirmed = true;
    record.exit_code = exit_code;
    record.lifecycle = if record.receipt_id.is_some() {
        ExecutionLifecycle::Completed
    } else {
        ExecutionLifecycle::Failed
    };
    if record.receipt_id.is_none() {
        record.error = Some(format!("execution ended without accepted completion (exit {exit_code:?})"));
    }
    Ok(())
}

pub fn recover_execution_owner(state: &mut TaskExecutionState, id: &str) -> Result<String, String> {
    let record = state.executions.get_mut(id).ok_or("unknown execution")?;
    if record.receipt_id.is_some() || !record.shutdown_confirmed {
        return Err("recovery requires an unaccepted execution with proven stopped owner".into());
    }
    record.previous_session_ids.push(record.owner_session_id.clone());
    record.owner_session_id = format!("s{}", uuid::Uuid::new_v4());
    record.permission = CompletionPermission::Locked;
    record.lifecycle = ExecutionLifecycle::Queued;
    record.start_requested = false;
    record.shutdown_confirmed = false;
    record.exit_code = None;
    record.error = None;
    Ok(record.owner_session_id.clone())
}

pub fn interrupt_unproven_owners(state: &mut TaskExecutionState, proven_live_sessions: &BTreeSet<String>) {
    for record in state.executions.values_mut() {
        if record.lifecycle.holds_capacity() && !proven_live_sessions.contains(&record.owner_session_id) {
            record.lifecycle = ExecutionLifecycle::Interrupted;
            record.error = Some("previous process disposition is unknown; ownership retained".into());
        }
    }
}

pub fn execution_assignment_prompt(repo: &Path, slug: &str, state: &TaskExecutionState, id: &str) -> Result<String, String> {
    use std::fmt::Write;
    let record = state.executions.get(id).ok_or("unknown execution")?;
    let root = crate::artifacts_dir(repo, slug);
    let mut prompt = String::from(concat!(
        "\n\n## Engine assignment (authoritative)\n",
        "You are responsible for this one engine-assigned execution in an Alinery Playbook. Other executions may run before, after, or concurrently in the same task. Work only on this execution. Do not start, stop, advance, or modify other executions; the engine coordinates them.\n\n",
        "Read only the assigned input occurrences below. Do not infer lineage or choose versions by filenames.\n",
    ));
    for (selector, ids) in &record.candidate.inputs {
        for occurrence_id in ids {
            let occurrence = state.occurrences.get(occurrence_id).ok_or("missing assigned occurrence")?;
            let _ = writeln!(
                prompt,
                "Read: {} (logical {selector}; occurrence {occurrence_id}; producer {})",
                root.join(&occurrence.relative_path).display(),
                occurrence.producer_execution_id.as_deref().unwrap_or("seed")
            );
        }
    }
    for assignment in &record.outputs {
        let _ = writeln!(
            prompt,
            "Write: {} (logical {}; {}required)",
            root.join(&assignment.relative_path).display(),
            assignment.selector,
            if assignment.relative_path.contains('*') {
                "nonempty wildcard family, all members "
            } else {
                ""
            }
        );
    }
    prompt.push_str(concat!(
        "\nCompletion is an explicit handshake: you request completion through alinery_phase_complete, the engine validates the assigned outputs and completion permission and records acceptance, and the session then shuts down normally. A written artifact, user-facing report, idle session, or process exit does not complete this execution by itself.\n\n",
        "When the assigned work, required outputs, verification, and substantive decisions are ready, do both of these in the same assistant turn:\n",
        "1. Send the user-facing handoff text.\n",
        "2. Call alinery_phase_complete before ending the turn.\n\n",
        "Finish all required work and the handoff before invoking the tool because acceptance requests shutdown.\n\n",
        "The example text below is illustrative. Report the actual assigned output and verification result; do not copy an unsupported claim. The tool-call line denotes an actual tool invocation, not prose to print.\n\n",
        "Valid:\n",
        "  assistant text: \"Design complete; here is the artifact and decision.\"\n",
        "  assistant tool call: alinery_phase_complete({})\n\n",
        "Not valid:\n",
        "  assistant text: \"Design complete.\"\n",
        "  <turn ends without calling alinery_phase_complete>\n\n",
        "If clarification, substantive approval, output work, or another blocker remains, explain what is needed and stay interactive instead. Do not call the completion tool merely because the session is idle.\n\n",
        "When ready, call alinery_phase_complete even when completion permission is locked. The tool handles the separate permission-to-finish gate; substantive approval of the work does not replace the completion call. If permission is denied or unavailable, stay interactive without repeatedly requesting it.\n\n",
        "Correct invalid outputs before retrying. Resolve delivery or ownership failures rather than claiming success. Only an accepted tool result confirms completion. After acceptance, do no further work; allow ordinary shutdown. The engine releases dependent work only after confirmed process exit.\n\n",
        "Do not modify other executions' artifacts.\n",
    ));
    Ok(prompt)
}

#[cfg(test)]
#[path = "execution_tests.rs"]
mod tests;
