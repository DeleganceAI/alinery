//! Task-owned execution truth. Callers serialize mutations with the repository task lock;
//! session metadata is a repairable projection, never a scheduling input.
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::playbook::{parse_playbook_md, ArtifactSelector, NormalizedPlaybook, PlaybookRef};
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

impl ExecutionLifecycle {}

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
    /// Missing on records reserved before required outputs existed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub required: bool,
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
    // Live override. Does not rewrite `enabled_steps`; completion checks it separately.
    #[serde(default)]
    pub auto_approve_all: bool,
    pub launch_defaults: LaunchChoices,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub step_models: BTreeMap<String, String>,
    pub contexts: BTreeMap<String, ExecutionContext>,
    pub executions: BTreeMap<String, ExecutionRecord>,
    pub occurrences: BTreeMap<String, ArtifactOccurrence>,
    pub collections: BTreeMap<String, ArtifactCollection>,
    /// The playbook engine's own state (S4.2), written by the daemon. Rust never reads it; it is carried
    /// through unchanged so a Rust writer's read-modify-write cannot erase it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<serde_json::Value>,
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

/// Execution files from before `permission` was a required field lack it on their records. `locked`
/// grants nothing, so filling it in cannot approve anything. Returns the fixed bytes and how many
/// records changed, or `None` when the bytes are not that case or the fix would not make them readable.
fn with_missing_permission(bytes: &[u8]) -> Option<(Vec<u8>, usize)> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let mut filled = 0;
    for record in value.get_mut("executions")?.as_object_mut()?.values_mut().filter_map(|record| record.as_object_mut()) {
        if !record.contains_key("permission") {
            record.insert("permission".into(), serde_json::json!({ "kind": "locked" }));
            filled += 1;
        }
    }
    let fixed = serde_json::to_vec_pretty(&value).ok()?;
    (filled > 0 && serde_json::from_slice::<TaskExecutionState>(&fixed).is_ok()).then_some((fixed, filled))
}

/// Whether [`repair_execution_state`] can make this task's saved progress readable.
pub fn execution_state_repairable(repo: &Path, slug: &str) -> bool {
    execution_state_path(repo, slug)
        .ok()
        .and_then(|path| fs::read(path).ok())
        .is_some_and(|bytes| with_missing_permission(&bytes).is_some())
}

/// User-triggered repair of a task whose saved progress will not read. The original is kept beside it as
/// `execution.json.before-repair-<unix seconds>`. Callers make sure no daemon is writing the file.
pub fn repair_execution_state(repo: &Path, slug: &str) -> Result<usize, String> {
    crate::with_task_mutation_lock(repo, "repair task state", || {
        let path = execution_state_path(repo, slug)?;
        let original = fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let (fixed, filled) = with_missing_permission(&original).ok_or("nothing in this task's saved progress can be repaired automatically")?;
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        crate::fs_atomic::write_bytes_durable(&path.with_file_name(format!("execution.json.before-repair-{stamp}")), &original)?;
        crate::fs_atomic::write_bytes_durable(&path, &fixed)?;
        Ok(filled)
    })
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
    step_models: BTreeMap<String, String>,
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
    let step_models = normalize_step_models(&definition, &step_models)?;
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
        auto_approve_all: false,
        launch_defaults,
        step_models,
        initial_start_requested: false,
        contexts: BTreeMap::from([(root.id.clone(), root)]),
        executions: BTreeMap::new(),
        occurrences: BTreeMap::new(),
        collections: BTreeMap::new(),
        engine: None,
    })
}
fn normalize_step_models(definition: &NormalizedPlaybook, raw: &BTreeMap<String, String>) -> Result<BTreeMap<String, String>, String> {
    let mut normalized = BTreeMap::new();
    for (key, value) in raw {
        if !definition.step.iter().any(|step| &step.key == key) {
            return Err(format!("unknown step model '{key}'"));
        }
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            normalized.insert(key.clone(), trimmed.to_string());
        }
    }
    Ok(normalized)
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
    // Reconcile, launch, reap, and a UI grant all commit this record. The lock
    // stays fail-fast so a re-entry cannot deadlock; this wait is what keeps a
    // grant from losing that race and surfacing as a failed gesture.
    crate::with_task_mutation_lock_waiting(repo, operation, crate::TASK_MUTATION_CONTENTION_WAIT, || {
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

/// Archiving a task drops the byte copies its executions kept (O27). Each execution's manifest stays in
/// `execution.json`, so what a step saw is still named; only the bytes go. The task's artifacts are untouched.
pub fn prune_execution_objects(repo: &Path, slug: &str) -> Result<(), String> {
    let root = crate::task_dir(repo, slug).join("executions");
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("read {}: {error}", root.display())),
    };
    for entry in entries {
        let objects = entry.map_err(|error| error.to_string())?.path().join("objects");
        match fs::remove_dir_all(&objects) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("remove {}: {error}", objects.display())),
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "execution_tests.rs"]
mod tests;
