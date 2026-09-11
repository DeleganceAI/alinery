use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

pub const RUNNER_EVENT_PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HarnessAdapter {
    Omp,
    #[default]
    Unsupported,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageAdapter {
    OmpBracketedPaste,
    #[default]
    Unsupported,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionTransport {
    #[default]
    Pty,
    Rpc,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct SemanticCheckpoint {
    #[serde(default)]
    pub phase_completed_at: Option<u64>,
    #[serde(default)]
    pub omp_session_id: Option<String>,
    #[serde(default)]
    pub omp_turn_id: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunnerEventEnvelope {
    pub version: u16,
    pub session_id: String,
    pub token: String,
    pub event: RunnerEvent,
}

fn deserialize_non_empty_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.trim().is_empty() {
        return Err(serde::de::Error::custom("value must not be empty"));
    }
    Ok(value)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum RunnerEvent {
    Busy {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        omp_turn_id: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_optional_non_empty_string")]
        correlation_id: Option<String>,
    },
    Idle {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        omp_turn_id: Option<u64>,
    },
    WaitingForInput {
        #[serde(deserialize_with = "deserialize_non_empty_string")]
        correlation_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        omp_turn_id: Option<u64>,
    },
    WaitingForApproval {
        #[serde(deserialize_with = "deserialize_non_empty_string")]
        correlation_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        omp_turn_id: Option<u64>,
    },
    PhaseCompleted {
        #[serde(deserialize_with = "deserialize_non_empty_string")]
        omp_session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        omp_turn_id: Option<u64>,
    },
    AdapterError {
        detail: String,
    },
}

fn deserialize_optional_non_empty_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    if value.as_ref().is_some_and(|value| value.trim().is_empty()) {
        return Err(serde::de::Error::custom("value must not be empty"));
    }
    Ok(value)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
#[derive(Default)]
pub enum ProcessState {
    #[default]
    Starting,
    Alive,
    Exited {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<i32>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum AgentState {
    #[default]
    Unknown,
    Busy,
    WaitingForInput {
        correlation_id: String,
    },
    WaitingForApproval {
        correlation_id: String,
    },
    Idle,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum PlaybookState {
    #[default]
    InProgress,
    ReadyToAdvance,
    Completed,
    Failed {
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct SessionState {
    pub process: ProcessState,
    pub agent: AgentState,
    pub playbook: PlaybookState,
    pub adapter: HarnessAdapter,
    pub message_adapter: MessageAdapter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NormalizedSessionStatus {
    Starting,
    InProgress,
    WaitingForInput,
    WaitingForApproval,
    Idle,
    ReadyToAdvance,
    Completed,
    Failed,
    Stale,
    Exited,
}

pub fn default_playbook_key() -> String {
    "superdevelop".to_string()
}

pub fn default_playbook_version() -> u32 {
    1
}

pub fn default_playbook_kind() -> String {
    "linear".to_string()
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Mint an anonymous correlation id for product telemetry.
///
/// The single home for what `telemetry_id` on `Task` / `SessionMeta` is for (AGENTS.md
/// "DRY & Comments" rule 3). It exists only to join events about the same task or session in
/// the stream: an opaque v4 UUID, never derived from the slug, name, or path.
///
/// It is not *rendered* anywhere in the UI, but it is not confined to Rust either — it rides
/// the IPC boundary on every `list_sessions` / `create_session` / `resume_session` /
/// `ensure_drawer_terminal` reply, because the frontend passes whole `SessionMeta` values
/// around. Persisting it is also unconditional: minting is not gated on telemetry consent,
/// only transmission is (see `record_event`, and APP.md § Telemetry).
pub fn new_telemetry_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct RelatedTaskRef {
    pub repo_path: String,
    pub slug: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Task {
    pub name: String,
    pub slug: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub requested_slug: String,
    pub branch: String,
    pub worktree: String,
    #[serde(default = "default_has_worktree")]
    pub has_worktree: bool,
    pub created: u64,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub pr_url: String,
    #[serde(default)]
    pub linear_id: String,
    #[serde(default)]
    pub github_issue: String,
    #[serde(default)]
    pub playbook: String,
    #[serde(default)]
    pub auto_advance: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub parent_task: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub active_subtask: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub subtask_outcome: String,
    // M6: partial create-form entry; false for real tasks.
    #[serde(default)]
    pub draft: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related_tasks: Vec<RelatedTaskRef>,
    // Anonymous telemetry correlation id; rationale at new_telemetry_id() above.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub telemetry_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotificationSuppressionKind {
    WaitingForInput,
    WaitingForApproval,
    Failure,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NotificationSuppression {
    pub notice: NotificationSuppressionKind,
    pub occurrence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct SessionMeta {
    pub id: String,
    pub worktree: String,
    pub created: u64,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub harness: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub playbook: String,
    #[serde(default)]
    pub generic: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub subtask_manager: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub subtask_slug: String,
    // Per-session artifact assignment. Empty means "use the playbook step's base artifact".
    #[serde(default)]
    pub artifact: String,
    // Incoming review handoff payload for this session, if any.
    #[serde(default)]
    pub handoff_artifact: String,
    // Extra confirmation-page instructions appended through {{PROMPT_EXTRA}}.
    #[serde(default)]
    pub prompt_extra: String,
    // Some is the exact fresh-spawn prompt, including empty; None derives from playbook metadata.
    #[serde(default)]
    pub prompt: Option<String>,
    // ---- session durability & resume (issue #24) ----
    // Daemon-owned lifecycle timestamps; all serde-defaulted so pre-#24 metas still parse.
    #[serde(default)]
    pub started_at: Option<u64>,
    #[serde(default)]
    pub status_changed_at: Option<u64>,
    #[serde(default)]
    pub status_revision: u64,
    #[serde(default)]
    pub ended_at: Option<u64>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub harness_resume_token: String, // "" = none
    #[serde(default)]
    pub resume_of: Option<String>, // single hop back to the resumed session
    #[serde(default)]
    pub daemon_namespace: String,
    // App-owned acknowledgment for accepted semantic completion.
    #[serde(default)]
    pub notification_read_at: Option<u64>,
    // App-owned acknowledgment for a nonzero process exit.
    #[serde(default)]
    pub exit_notification_read_at: Option<u64>,
    // App-owned suppression of one exact live notification occurrence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification_suppression: Option<NotificationSuppression>,
    #[serde(default)]
    pub semantic: SemanticCheckpoint,
    // Anonymous telemetry correlation id; rationale at new_telemetry_id() above.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub telemetry_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct CreateSessionInput {
    pub task_slug: String,
    pub playbook: String,
    pub generic: bool,
    pub phase: String,
    pub harness: String,
    pub model: String,
    pub artifact: String,
    pub handoff_artifact: String,
    pub prompt_extra: String,
    pub prompt: Option<String>,
    pub subtask_manager: bool,
    pub subtask_slug: String,
    pub daemon_namespace: String,
    /// Force a specific session id instead of a fresh timestamp. Used by the auto-advance
    /// reconciler so racing daemons compute the SAME id for one (task, to_phase) edge and the
    /// exclusive create below lets only one win. `None` = generate `s<nanos>` as usual.
    pub id_override: Option<String>,
    /// Write the meta with O_EXCL (`create_new`) so a concurrent reconciler on another daemon
    /// can't also create it — the loser gets an "already exists" error. Defends the dedup
    /// against the cross-process TOCTOU that `next_step_session_exists` alone can't close.
    pub exclusive_create: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionStartResult {
    pub task_slug: String,
    pub session_id: String,
    pub started_at: u64,
    pub state: SessionState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionStatusResult {
    #[serde(flatten)]
    pub session: SessionMeta,
    pub task_slug: String,
    pub session_id: String,
    pub lifecycle: crate::shared::LifecycleState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<SessionState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct TaskSummary {
    pub name: String,
    pub slug: String,
    pub branch: String,
    pub worktree: String,
    pub has_worktree: bool,
    pub playbook: String,
    pub archived: bool,
    pub draft: bool,
    pub subtask_outcome: String,
}

impl From<&Task> for TaskSummary {
    fn from(task: &Task) -> Self {
        Self {
            name: task.name.clone(),
            slug: task.slug.clone(),
            branch: task.branch.clone(),
            worktree: task.worktree.clone(),
            has_worktree: task.has_worktree,
            playbook: task.playbook.clone(),
            archived: task.archived,
            draft: task.draft,
            subtask_outcome: task.subtask_outcome.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct TaskRelationships {
    pub parent_task: Option<TaskSummary>,
    pub active_subtask: Option<TaskSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct SubtaskManagerState {
    pub parent_manager_session: Option<SessionMeta>,
    pub parent_manager_owner_task_slug: String,
    pub task: TaskSummary,
    pub parent_task: Option<TaskSummary>,
    pub active_subtask: Option<TaskSummary>,
    pub manager_session: Option<SessionMeta>,
    pub manager_owner_task_slug: String,
    pub can_start: bool,
    pub can_recover: bool,
    pub disabled_reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct CreateSubtaskInput {
    pub manager_session_id: String,
    pub name: String,
    pub slug: String,
    pub playbook: String,
    pub instructions: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct CreateSubtaskResult {
    pub parent_task: TaskSummary,
    pub child_task: TaskSummary,
    pub manager_session: SessionMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct SubtaskGitState {
    pub parent_worktree_exists: bool,
    pub child_worktree_exists: bool,
    pub parent_worktree_clean: bool,
    pub child_worktree_clean: bool,
    pub child_only_commits: u64,
    pub child_head_contained: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct SubtaskArtifactState {
    pub has_artifacts: bool,
    pub snapshot_exists: bool,
    pub snapshot_reusable: bool,
    pub snapshot_path: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum FinalizeMode {
    ArtifactsOnly,
    IntegratedCode,
    ArchiveWithoutCode,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct FinishInspection {
    pub child_task: TaskSummary,
    pub code_state: SubtaskGitState,
    pub artifact_state: SubtaskArtifactState,
    pub observed_live_parent_sessions: Vec<String>,
    pub allowed_modes: Vec<FinalizeMode>,
    pub blockers: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct FinalizeSubtaskResult {
    pub parent_task: TaskSummary,
    pub archived_child: TaskSummary,
    pub snapshot_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct SnapshotProvenance {
    pub child_slug: String,
    pub branch: String,
    pub snapshot_time: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ReviewHandoffRecord {
    pub version: u32,
    pub direction: String,
    pub source_task: String,
    pub source_session: String,
    pub source_artifact: String,
    pub target_task: String,
    pub target_artifact: String,
    pub target_session: String,
    pub target_phase: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ReviewHandoffRequest {
    pub source_slug: String,
    pub source_session: String,
    pub source_artifact: String,
    pub target_slug: String,
    pub target_phase: String,
    pub harness: String,
    pub model: String,
    pub prompt_extra: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ReviewHandoffResult {
    pub target_artifact: String,
    pub target_session: SessionMeta,
    pub source_record: ReviewHandoffRecord,
    pub target_record: ReviewHandoffRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ArtifactListItem {
    pub name: String,
    pub modified_at_ms: Option<u64>,
    pub playbook_step: String,
    pub session_id: String,
    #[serde(default)]
    pub handoffs: Vec<ReviewHandoffRecord>,
    #[serde(default)]
    pub attachment: bool,
}

fn default_has_worktree() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub active_repo: String,
    #[serde(default)]
    pub known_repos: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NotificationPrefs {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default = "default_enabled")]
    pub sound: bool,
    #[serde(default)]
    pub bounce: bool,
    #[serde(default = "default_enabled")]
    pub banner: bool,
    #[serde(default = "default_enabled")]
    pub dock_badge: bool,
    #[serde(default = "default_enabled")]
    pub dock_badge_input_waits: bool,
    #[serde(default = "default_enabled")]
    pub dock_badge_approval_waits: bool,
    #[serde(default = "default_enabled")]
    pub dock_badge_failures: bool,
    #[serde(default = "default_enabled")]
    pub dock_badge_completions: bool,
}

fn default_enabled() -> bool {
    true
}

impl Default for NotificationPrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            sound: true,
            bounce: false,
            banner: true,
            dock_badge: true,
            dock_badge_input_waits: true,
            dock_badge_approval_waits: true,
            dock_badge_failures: true,
            dock_badge_completions: true,
        }
    }
}

fn default_telemetry_enabled() -> bool {
    true
}

fn default_telemetry_prompted() -> bool {
    false
}

// One endpoint for every build: the hosted production OpenObserve ingest proxy.
// Not settings-editable (Settings shows only the enabled checkbox); the local
// scripts/telemetry/ fixture is reached only by pointing curl/smoke-test.sh at
// it directly, never through this default.
pub fn default_telemetry_endpoint() -> String {
    "https://telemetry.alinery.ai".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TelemetryPrefs {
    #[serde(default = "default_telemetry_enabled")]
    pub enabled: bool,
    #[serde(default = "default_telemetry_prompted")]
    pub prompted: bool,
    #[serde(default)]
    pub install_id: String,
    #[serde(default = "default_telemetry_endpoint")]
    pub endpoint: String,
}

impl Default for TelemetryPrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            prompted: false,
            install_id: String::new(),
            endpoint: default_telemetry_endpoint(),
        }
    }
}

fn default_update_check_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdatePrefs {
    #[serde(default = "default_update_check_enabled")]
    pub check_enabled: bool,
}

impl Default for UpdatePrefs {
    fn default() -> Self {
        Self { check_enabled: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ExperimentalFeatures {
    /// Opt-in classic Kanban tab (⌘3). Default off — Grid (Kanban+) is the primary board.
    #[serde(default)]
    pub show_original_kanban: bool,
}

pub const MAX_GRID_VIEWS: usize = 3;
pub const DEFAULT_GRID_VIEW_ID: &str = "default-kanban-plus";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GridViewDefinition {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub slot: u8,
}

pub fn default_grid_views() -> Vec<GridViewDefinition> {
    vec![GridViewDefinition {
        id: DEFAULT_GRID_VIEW_ID.into(),
        name: "Kanban+".into(),
        slot: 1,
    }]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct GitHubPrefs {
    #[serde(default)]
    pub token: String,
}

/// Retention slider bounds. 0 would delete every backup on the next create, so the
/// resolved value is always clamped into this range.
pub const MIN_BACKUP_RETENTION: u8 = 1;
pub const MAX_BACKUP_RETENTION: u8 = 100;

fn default_retention() -> u8 {
    10
}

/// Backup preferences. Global tier holds concrete values; the repo tier overrides
/// them field-by-field (see `RepoBackupOverrides`). Feature is off until `destination`
/// is a valid directory outside the repo's `.alinery/`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BackupDefaults {
    #[serde(default)]
    pub destination: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_retention")]
    pub retention: u8,
    #[serde(default)]
    pub trigger_pre_archive: bool,
    #[serde(default)]
    pub trigger_post_artifact_change: bool,
    #[serde(default)]
    pub trigger_post_push_commit: bool,
}

impl Default for BackupDefaults {
    fn default() -> Self {
        Self {
            destination: String::new(),
            enabled: false,
            retention: default_retention(),
            trigger_pre_archive: false,
            trigger_post_artifact_change: false,
            trigger_post_push_commit: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HarnessChoice {
    #[serde(default)]
    pub harness: String,
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_playbook_key")]
    pub playbook: String,
    #[serde(default = "default_enabled")]
    pub draft_autosave: bool,
}

impl Default for HarnessChoice {
    fn default() -> Self {
        Self {
            harness: String::new(),
            model: String::new(),
            playbook: default_playbook_key(),
            draft_autosave: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GlobalSettings {
    #[serde(default)]
    pub notifications: NotificationPrefs,
    #[serde(default)]
    pub github: GitHubPrefs,
    #[serde(default)]
    pub defaults: HarnessChoice,
    #[serde(default)]
    pub backup: BackupDefaults,
    #[serde(default)]
    pub harnesses: HarnessFile,
    #[serde(default)]
    pub model_favorites: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub telemetry: TelemetryPrefs,
    #[serde(default)]
    pub updates: UpdatePrefs,
    #[serde(default)]
    pub experiments: ExperimentalFeatures,
    #[serde(default = "default_grid_views")]
    pub grid_views: Vec<GridViewDefinition>,
}

impl Default for GlobalSettings {
    fn default() -> Self {
        Self {
            notifications: NotificationPrefs::default(),
            github: GitHubPrefs::default(),
            defaults: HarnessChoice::default(),
            backup: BackupDefaults::default(),
            harnesses: HarnessFile::default(),
            model_favorites: BTreeMap::new(),
            telemetry: TelemetryPrefs::default(),
            updates: UpdatePrefs::default(),
            experiments: ExperimentalFeatures::default(),
            grid_views: default_grid_views(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct RepoGitHubOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct RepoHarnessChoiceOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playbook: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_autosave: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct RepoBackupOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retention: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_pre_archive: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_post_artifact_change: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_post_push_commit: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct RepoOverrides {
    #[serde(default)]
    pub github: RepoGitHubOverrides,
    #[serde(default)]
    pub defaults: RepoHarnessChoiceOverrides,
    #[serde(default)]
    pub backup: RepoBackupOverrides,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SettingSource {
    Global,
    Repository,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChoiceProvenance {
    pub harness: SettingSource,
    pub model: SettingSource,
    pub playbook: SettingSource,
    pub draft_autosave: SettingSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConfigProvenance {
    pub github_token: SettingSource,
    pub defaults: ChoiceProvenance,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EffectiveConfig {
    pub notifications: NotificationPrefs,
    pub github: GitHubPrefs,
    pub defaults: HarnessChoice,
    pub provenance: ConfigProvenance,
    pub backup: BackupDefaults,
    pub telemetry: TelemetryPrefs,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct Harness {
    pub key: String,
    pub name: String,
    pub binary: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub model_arg: Vec<String>,
    #[serde(default)]
    pub prompt_arg: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub prompt_injection: String,
    #[serde(default)]
    pub adapter: HarnessAdapter,
    #[serde(default)]
    pub message_adapter: MessageAdapter,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub models_cmd: String,
    // ---- resume (issue #24) ---- absent block ⇒ not resume-capable.
    #[serde(default)]
    pub resume: Option<HarnessResume>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct HarnessResume {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub id_source: String, // "launch" | "manual" (v1)
    #[serde(default)]
    pub launch_args: Vec<String>,
    #[serde(default)]
    pub resume_args: Vec<String>,
}

#[derive(Deserialize, Serialize, Default, Debug, Clone, PartialEq, Eq)]
pub struct HarnessFile {
    #[serde(default)]
    pub harness: Vec<Harness>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Phase {
    pub key: String,
    pub name: String,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlaybookFile {
    #[serde(default = "default_playbook_version")]
    pub version: u32,
    #[serde(default = "default_playbook_key")]
    pub default: String,
    #[serde(default)]
    pub playbook_order: Vec<String>,
    #[serde(default)]
    pub playbooks: BTreeMap<String, Playbook>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Playbook {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_playbook_kind")]
    pub kind: String,
    #[serde(default)]
    pub steps: Vec<String>,
    #[serde(default)]
    pub default_harness: String,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub step: BTreeMap<String, PlaybookStep>,
    #[serde(default)]
    pub column: BTreeMap<String, PlaybookColumn>,
    #[serde(default)]
    pub auto_advance: BTreeMap<String, AutoAdvanceEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlaybookStep {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub short: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub prompt_inline: String,
    #[serde(default)]
    pub artifact: String,
    #[serde(default)]
    pub column: String,
    #[serde(default)]
    pub harness: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlaybookColumn {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub steps: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AutoAdvanceEdge {
    #[serde(default)]
    pub title: String,
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub default_enabled: bool,
}

pub struct PromptVars<'a> {
    pub artifacts_dir: &'a Path,
    pub artifact_file: &'a Path,
    pub review_handoff_file: Option<&'a Path>,
    pub prompt_extra: &'a str,
    pub session_history_dir: &'a Path,
    pub task_name: &'a str,
    pub task_slug: &'a str,
    pub worktree: &'a str,
    pub playbook_key: &'a str,
    pub phase_key: &'a str,
    pub phase_title: &'a str,
    pub ticket_file: &'a Path,
}

pub const DEFAULT_CONFIG_TOML: &str = include_str!("../../config.default.toml");
pub const DEFAULT_HARNESSES_TOML: &str = include_str!("../../harnesses.default.toml");
pub const DEFAULT_PLAYBOOKS_TOML: &str = include_str!("../../playbooks.default.toml");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_transport_snake_case_and_default() {
        assert_eq!(SessionTransport::default(), SessionTransport::Pty);
        assert_eq!(serde_json::to_value(SessionTransport::Pty).unwrap(), serde_json::json!("pty"));
        assert_eq!(serde_json::to_value(SessionTransport::Rpc).unwrap(), serde_json::json!("rpc"));
    }

    #[test]
    fn session_meta_has_no_transport_field() {
        let value = serde_json::to_value(SessionMeta::default()).unwrap();
        let object = value.as_object().expect("SessionMeta serializes as an object");
        assert!(!object.contains_key("transport"));
        assert!(!object.contains_key("ui_mode"));
    }
}
