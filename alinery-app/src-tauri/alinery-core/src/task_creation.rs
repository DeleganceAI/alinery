//! Daemon-invoked task provisioning. A failed saga retains its intent and worktree.
use crate::{execution::*, playbook::PlaybookRef, RelatedTaskRef, SessionMeta, Task};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskPlaybookPackage {
    pub reference: PlaybookRef,
    pub source: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskAttachment {
    pub name: String,
    #[serde(with = "crate::rpc_chunk::base64_bytes")]
    pub bytes: Vec<u8>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateTaskRequest {
    pub name: String,
    #[serde(default)]
    pub draft_slug: Option<String>,
    #[serde(default)]
    pub requested_slug: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub attachments: Vec<TaskAttachment>,
    #[serde(default)]
    pub original_ticket: Option<String>,
    #[serde(default)]
    pub attachment_urls: Vec<String>,
    #[serde(default)]
    pub attachment_errors: Vec<String>,
    #[serde(default)]
    pub linear_id: String,
    #[serde(default)]
    pub github_issue: String,
    #[serde(default)]
    pub related_tasks: Vec<RelatedTaskRef>,
    #[serde(default)]
    pub parent_task: String,
    pub playbook: TaskPlaybookPackage,
    #[serde(default)]
    pub branch_name: Option<String>,
    #[serde(default)]
    pub worktree_name: Option<String>,
    #[serde(default)]
    pub base_ref: Option<String>,
    #[serde(default)]
    pub launch_defaults: LaunchChoices,
    #[serde(default)]
    pub auto_advance_steps: Option<Vec<String>>,
    #[serde(default)]
    pub step_models: BTreeMap<String, String>,
    #[serde(default)]
    pub max_live_sessions: Option<u32>,
    pub start: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreationError {
    pub stage: String,
    pub code: String,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTaskReply {
    pub task: Option<Task>,
    pub sessions: Vec<SessionMeta>,
    pub executions: Vec<ExecutionRecord>,
    pub creation: String,
    pub start: String,
    pub errors: Vec<CreationError>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExecutionSessionTarget {
    Primary {
        step_key: String,
        #[serde(default)]
        execution_id: Option<String>,
        #[serde(default)]
        input_occurrence_ids: Option<Vec<String>>,
    },
    Auxiliary {
        harness: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        prompt: Option<String>,
    },
    SubtaskManager {
        #[serde(default)]
        subtask_slug: Option<String>,
        #[serde(default)]
        recover: bool,
        harness: String,
        #[serde(default)]
        model: Option<String>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateExecutionSessionRequest {
    pub task_slug: String,
    pub target: ExecutionSessionTarget,
    #[serde(default)]
    pub launch_override: Option<LaunchChoices>,
    #[serde(default)]
    pub prompt_extra: Option<String>,
    #[serde(default)]
    pub handoff_artifact: Option<String>,
    pub start: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateExecutionSessionReply {
    pub session: SessionMeta,
    pub execution: Option<ExecutionRecord>,
    pub start: String,
    pub errors: Vec<CreationError>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskExecutionReply {
    pub state: TaskExecutionState,
    pub definition: crate::playbook::NormalizedPlaybook,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartSessionRequest {
    pub task_slug: String,
    pub session_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GetTaskExecutionRequest {
    pub task_slug: String,
}
