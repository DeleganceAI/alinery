//! Daemon-invoked task provisioning. A failed saga retains its intent and worktree.
use crate::{
    execution::*,
    playbook::{parse_playbook_md, PlaybookRef},
    RelatedTaskRef, SessionMeta, Task,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs, path::Path};

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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AllowExecutionCompletionRequest {
    pub task_slug: String,
    pub execution_id: String,
    pub session_id: String,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()
}
fn nonempty(value: Option<&str>, fallback: &str) -> String {
    value.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(fallback).to_string()
}
fn unique_name(mut occupied: impl FnMut(&str) -> bool, base: &str) -> String {
    let mut name = base.to_string();
    let mut index = 1_u64;
    while occupied(&name) {
        name = format!("{base}-{index}");
        index += 1;
    }
    name
}

pub fn ensure_task_data_ignored(repo: &Path) -> Result<(), String> {
    let path = repo.join(".gitignore");
    let mut contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("read .gitignore: {error}")),
    };
    if contents.lines().any(|line| line.trim() == "/.alinery/") {
        return Ok(());
    }
    if !contents.is_empty() && !contents.ends_with('\n') {
        contents.push('\n');
    }
    contents.push_str("/.alinery/\n");
    crate::fs_atomic::write_bytes_durable(&path, contents.as_bytes())
}

/// Validates the complete package before reserving intent. Git runs after the intent
/// transaction and outside the repository lock; an uncertain outcome is never retried.
pub fn provision_task(repo: &Path, lane: &str, app_config_identity: &str, request: &CreateTaskRequest) -> Result<CreateTaskReply, String> {
    if !request.parent_task.is_empty() {
        return Err("child creation requires an authorized subtask manager".into());
    }
    provision_task_with_reservation(repo, lane, app_config_identity, request, || Ok(()), |_| Ok(()))
}

pub fn provision_task_with_reservation(
    repo: &Path,
    lane: &str,
    app_config_identity: &str,
    request: &CreateTaskRequest,
    before_reserve: impl FnOnce() -> Result<(), String>,
    after_reserve: impl FnOnce(&Task) -> Result<(), String>,
) -> Result<CreateTaskReply, String> {
    let definition = parse_playbook_md(&request.playbook.source).map_err(|e| format!("invalid playbook: {e:?}"))?;
    let name = request.name.trim();
    if name.is_empty() {
        return Err("task name is empty".into());
    }
    let enabled: BTreeSet<String> = request
        .auto_advance_steps
        .clone()
        .unwrap_or_else(|| definition.step.iter().filter(|s| s.auto_advance_default).map(|s| s.key.clone()).collect())
        .into_iter()
        .collect();
    let mut state = new_execution_state(
        request.playbook.reference.clone(),
        &request.playbook.source,
        lane.into(),
        request.max_live_sessions.unwrap_or(10),
        enabled,
        request.launch_defaults.clone(),
    )?;
    state.owning_app_config_identity = app_config_identity.into();
    state.initial_start_requested = request.start;
    let mut attachment_names = BTreeSet::new();
    for attachment in &request.attachments {
        if crate::safe_component(&attachment.name) != Some(attachment.name.as_str()) || !attachment_names.insert(attachment.name.clone()) {
            return Err(format!("invalid or duplicate attachment name '{}'", attachment.name));
        }
    }
    let base = crate::slugify(name);
    let requested = nonempty(request.requested_slug.as_deref(), &base);
    if requested.is_empty() || crate::slugify(&requested) != requested {
        return Err("invalid requested task slug".into());
    }
    let worktree_base = nonempty(request.worktree_name.as_deref(), &requested);
    if crate::safe_component(&worktree_base) != Some(worktree_base.as_str()) {
        return Err("invalid worktree name".into());
    }
    let branch_base = nonempty(request.branch_name.as_deref(), &requested);
    let valid_branch = crate::git_cmd(repo)
        .args(["check-ref-format", "--branch", &branch_base])
        .output()
        .map_err(|e| e.to_string())?;
    if !valid_branch.status.success() {
        return Err("invalid branch name".into());
    }
    let mut reservation_error = None;
    let task = crate::with_task_mutation_lock(repo, "reserve task provisioning", || {
        before_reserve()?;
        let reserved_tasks = crate::list_tasks_for_repo(repo);
        let branch_occupied = |branch: &str| {
            reserved_tasks.iter().any(|task| task.branch == branch)
                || crate::git_cmd(repo)
                    .args(["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")])
                    .status()
                    .is_ok_and(|s| s.success())
        };
        if !request.parent_task.is_empty()
            && (crate::task_dir(repo, &requested).exists() || crate::worktrees_dir(repo).join(&worktree_base).exists() || branch_occupied(&branch_base))
        {
            return Err("child task identity is already occupied".into());
        }
        ensure_task_data_ignored(repo)?;
        let draft = match request.draft_slug.as_deref().filter(|s| !s.is_empty()) {
            Some(slug) => {
                if crate::safe_component(slug) != Some(slug) {
                    return Err("invalid draft slug".into());
                }
                match crate::read_task(repo, slug) {
                    Some(task) if task.draft && !task.archived => Some(task),
                    Some(task) if task.draft => None,
                    Some(_) => return Err("draft was already created".into()),
                    None => return Err("draft is missing or has already been promoted".into()),
                }
            }
            None => None,
        };
        let slug = unique_name(|s| crate::task_dir(repo, s).exists() && draft.as_ref().is_none_or(|d| d.slug != s), &requested);
        if let Some(draft) = &draft {
            if draft.slug != slug {
                fs::rename(crate::task_dir(repo, &draft.slug), crate::task_dir(repo, &slug)).map_err(|e| e.to_string())?;
            }
        }
        fs::create_dir_all(crate::sessions_dir(repo, &slug)).map_err(|e| e.to_string())?;
        fs::create_dir_all(crate::artifacts_dir(repo, &slug)).map_err(|e| e.to_string())?;
        fs::create_dir_all(crate::worktrees_dir(repo)).map_err(|e| e.to_string())?;
        let branch = unique_name(branch_occupied, &branch_base);
        let worktree_leaf = unique_name(
            |s| crate::worktrees_dir(repo).join(s).exists() || reserved_tasks.iter().any(|t| Path::new(&t.worktree).file_name().is_some_and(|n| n == s)),
            &worktree_base,
        );
        let task = Task {
            name: name.into(),
            slug: slug.clone(),
            branch,
            worktree: crate::worktrees_dir(repo).join(worktree_leaf).to_string_lossy().into_owned(),
            has_worktree: true,
            created: draft.as_ref().map(|d| d.created).unwrap_or_else(now),
            linear_id: request.linear_id.trim().into(),
            github_issue: request.github_issue.trim().into(),
            related_tasks: request.related_tasks.clone(),
            parent_task: request.parent_task.clone(),
            auto_advance: state.enabled_steps.iter().cloned().collect(),
            engine_version: 2,
            playbook_ref: Some(state.reference.clone()),
            max_live_sessions: state.max_live_sessions,
            launch_defaults: state.launch_defaults.clone(),
            telemetry_id: crate::new_telemetry_id(),
            ..Task::default()
        };
        crate::fs_atomic::write_bytes_durable(&task_playbook_path(repo, &slug)?, request.playbook.source.as_bytes())?;
        crate::task::write_task_unlocked(repo, &task)?;
        write_execution_state_unlocked(repo, &slug, &mut state)?;
        if let Err(error) = after_reserve(&task) {
            state.creation = "partial".into();
            state.creation_error = Some(format!("relationships: {error}"));
            write_execution_state_unlocked(repo, &slug, &mut state)?;
            reservation_error = Some(error);
        }
        Ok(task)
    })?;
    let mut stage = "git_worktree";
    let result = (|| {
        if let Some(error) = reservation_error {
            stage = "relationships";
            return Err(error);
        }
        let mut command = crate::git_cmd(repo);
        command.args(["worktree", "add", &task.worktree, "-b", &task.branch]);
        if let Some(base) = request.base_ref.as_deref().filter(|s| !s.trim().is_empty()) {
            command.arg(base);
        }
        let output = command.output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!("git worktree add: {}", String::from_utf8_lossy(&output.stderr).trim()));
        }
        stage = "install_inputs";
        let mut copied = Vec::new();
        if !request.attachments.is_empty() {
            fs::create_dir_all(crate::artifacts_dir(repo, &task.slug).join("attachments")).map_err(|e| e.to_string())?;
        }
        for attachment in &request.attachments {
            crate::fs_atomic::write_bytes_durable(&crate::artifacts_dir(repo, &task.slug).join("attachments").join(&attachment.name), &attachment.bytes)?;
            copied.push(format!("attachments/{}", attachment.name));
        }
        let ticket = request
            .original_ticket
            .clone()
            .unwrap_or_else(|| crate::compose_ticket(name, &request.description, &request.evidence, &request.attachment_urls, &copied, &request.attachment_errors));
        crate::fs_atomic::write_bytes_durable(&crate::artifacts_dir(repo, &task.slug).join("00-ticket.md"), ticket.as_bytes())?;
        crate::task::sync_related_artifact_links(repo, &task.slug, &task.related_tasks)?;
        stage = "ready";
        mutate_execution_state(repo, &task.slug, lane, app_config_identity, "commit task ready", |_, state| {
            install_seed(state, "ticket.md", "00-ticket.md")?;
            state.creation = "ready".into();
            Ok(())
        })?;
        Ok::<(), String>(())
    })();
    let mut reply = CreateTaskReply {
        task: Some(task.clone()),
        sessions: Vec::new(),
        executions: Vec::new(),
        creation: "ready".into(),
        start: "not_requested".into(),
        errors: request
            .attachment_errors
            .iter()
            .map(|message| CreationError {
                stage: "attachments".into(),
                code: "import_failed".into(),
                message: message.clone(),
            })
            .collect(),
    };
    if let Err(error) = result {
        reply.creation = "partial".into();
        reply.errors.push(CreationError {
            stage: stage.into(),
            code: "provisioning_failed".into(),
            message: error.clone(),
        });
        if let Err(commit) = mutate_execution_state(repo, &task.slug, lane, app_config_identity, "record partial creation", |_, state| {
            state.creation = "partial".into();
            state.creation_error = Some(format!("{stage}: {error}"));
            Ok(())
        }) {
            reply.errors.push(CreationError {
                stage: "persistence".into(),
                code: "ambiguous_commit".into(),
                message: commit,
            });
        }
    }
    Ok(reply)
}
