//! Daemon-invoked task provisioning. A failed saga retains its intent and worktree.
use crate::{
    execution::*,
    playbook::{parse_playbook_md, PlaybookRef},
    RelatedTaskRef, SessionMeta, Task,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs, path::Path};

pub const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_ATTACHMENT_SET_BYTES: u64 = 100 * 1024 * 1024;

// Suffix goes before the extension. Probe the destination filesystem so promoted
// draft files and case aliases retain their bytes.
pub fn unique_attachment_name(dir: &Path, base: &str) -> Option<String> {
    if !dir.join(base).exists() {
        return Some(base.to_string());
    }
    let stem = Path::new(base).file_stem()?.to_str()?;
    let ext = Path::new(base).extension().and_then(|s| s.to_str());
    for n in 2..=99u32 {
        let candidate = match ext {
            Some(ext) => format!("{stem}-{n}.{ext}"),
            None => format!("{stem}-{n}"),
        };
        if !dir.join(&candidate).exists() {
            return Some(candidate);
        }
    }
    None
}

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

/// Validates the complete package and branch namespace before reserving intent.
/// Worktree creation runs outside the repository lock; an uncertain outcome is never retried.
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
    let name = crate::validate_task_name(&request.name)?;
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
    for attachment in &request.attachments {
        if crate::safe_component(&attachment.name) != Some(attachment.name.as_str()) {
            return Err(format!("invalid attachment name '{}'", attachment.name));
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
        let refs = crate::git_cmd(repo)
            .args(["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"])
            .output()
            .map_err(|error| format!("list local Git branches: {error}"))?;
        if !refs.status.success() {
            return Err(format!("list local Git branches: {}", String::from_utf8_lossy(&refs.stderr).trim()));
        }
        let refs = String::from_utf8(refs.stdout).map_err(|error| format!("decode local Git branches: {error}"))?;
        let branches = || refs.lines().chain(reserved_tasks.iter().map(|task| task.branch.as_str()));
        let branch_occupied = |candidate: &str| branches().any(|existing| crate::branch_names_conflict(existing, candidate));
        let registered_worktrees = crate::git::registered_worktree_paths(repo).map_err(|error| format!("read Git worktree registry: {error}"))?;
        if !request.parent_task.is_empty()
            && (crate::task_dir(repo, &requested).exists() || crate::worktrees_dir(repo).join(&worktree_base).exists() || branch_occupied(&branch_base))
        {
            return Err("child task identity is already occupied".into());
        }
        // Suffixing the leaf cannot escape an occupied parent namespace.
        if let Some(parent) = branches().find(|existing| crate::git::branch_is_parent(existing, &branch_base)) {
            return Err(format!(
                "branch '{branch_base}' is blocked by existing or reserved parent branch '{parent}'; choose a branch outside '{parent}/'"
            ));
        }
        let branch = unique_name(branch_occupied, &branch_base);
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
        let worktree_leaf = unique_name(
            |s| {
                crate::worktrees_dir(repo).join(s).exists()
                    || registered_worktrees.iter().any(|path| path.file_name().is_some_and(|n| n == s))
                    || reserved_tasks.iter().any(|t| Path::new(&t.worktree).file_name().is_some_and(|n| n == s))
            },
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
    let mut attachment_errors = request.attachment_errors.clone();
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
        let directory = crate::attachments_dir(repo, &task.slug);
        let mut accepted_bytes = 0u64;
        if !request.attachments.is_empty() {
            fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        }
        for attachment in &request.attachments {
            let size = attachment.bytes.len() as u64;
            let rejection = if size > MAX_ATTACHMENT_BYTES {
                Some("larger than 25 MiB")
            } else if size > MAX_ATTACHMENT_SET_BYTES - accepted_bytes {
                Some("attachment set would exceed 100 MiB")
            } else {
                None
            };
            if let Some(reason) = rejection {
                attachment_errors.push(format!("{} — {reason}", attachment.name));
                continue;
            }
            let Some(stored_name) = unique_attachment_name(&directory, &attachment.name) else {
                attachment_errors.push(format!("{} — too many name collisions", attachment.name));
                continue;
            };
            crate::fs_atomic::write_bytes_durable(&directory.join(&stored_name), &attachment.bytes)?;
            accepted_bytes += size;
            copied.push(stored_name);
        }
        let ticket = request
            .original_ticket
            .clone()
            .unwrap_or_else(|| crate::compose_ticket(name, &request.description, &request.evidence, &request.attachment_urls, &copied, &attachment_errors));
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
        errors: attachment_errors
            .into_iter()
            .map(|message| CreationError {
                stage: "attachments".into(),
                code: "import_failed".into(),
                message,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn git(repo: &Path, args: &[&str]) -> String {
        let output = crate::git_cmd(repo).args(args).output().unwrap();
        assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8(output.stdout).unwrap()
    }

    fn repo() -> PathBuf {
        let repo = std::env::temp_dir().join(format!("alinery-provisioning-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Test"]);
        git(&repo, &["config", "user.email", "test@example.com"]);
        git(&repo, &["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"]);
        repo
    }

    fn request(branch: &str) -> CreateTaskRequest {
        serde_json::from_value(serde_json::json!({
            "name": "New task",
            "branch_name": branch,
            "playbook": {
                "reference": { "scope": "bundled", "key": "one-shot" },
                "source": include_str!("../../playbooks/one-shot/playbook.md")
            },
            "start": false
        }))
        .unwrap()
    }

    fn occupy(repo: &Path, branch: &str, reservation: bool) {
        if reservation {
            let mut request = request(branch);
            request.name = format!("Reservation {branch}");
            let reply = provision_task_with_reservation(repo, "", "fixture", &request, || Ok(()), |_| Err("stop before git".into())).unwrap();
            assert_eq!(reply.creation, "partial");
            let task = reply.task.unwrap();
            assert_eq!(task.branch, branch);
            assert!(!Path::new(&task.worktree).exists());
            assert_eq!(git(repo, &["for-each-ref", "--format=%(refname)", &format!("refs/heads/{branch}")]), "");
        } else {
            git(repo, &["branch", branch]);
        }
    }

    #[test]
    fn descendant_conflicts_dedupe_every_candidate_before_provisioning() {
        for reservation in [false, true] {
            let repo = repo();
            occupy(&repo, "feat/one", reservation);
            occupy(&repo, "feat-1/one", reservation);
            // Packed refs must be checked too, not just loose ref paths.
            git(&repo, &["pack-refs", "--all", "--prune"]);
            let previous = crate::list_tasks_for_repo(&repo).len();
            let mut request = request("feat");
            request.name = "Feat".into();
            request.branch_name = None;
            request.worktree_name = Some("explicit-tree".into());
            let reply = provision_task(&repo, "", "fixture", &request).unwrap();
            assert_eq!(reply.creation, "ready", "{:?}", reply.errors);
            let task = reply.task.unwrap();
            assert_eq!(task.slug, "feat");
            assert_eq!(task.branch, "feat-2");
            assert_eq!(Path::new(&task.worktree).file_name().unwrap(), "explicit-tree");
            assert_eq!(git(Path::new(&task.worktree), &["branch", "--show-current"]).trim(), task.branch);
            assert_eq!(crate::list_tasks_for_repo(&repo).len(), previous + 1);
            assert_eq!(read_execution_state(&repo, &task.slug).unwrap().creation, "ready");
            assert!(!crate::task_dir(&repo, "feat-1").exists());
            fs::remove_dir_all(repo).unwrap();
        }
    }

    #[test]
    fn parent_conflicts_reject_without_new_task_or_worktree_state() {
        for reservation in [false, true] {
            let repo = repo();
            occupy(&repo, "feat", reservation);
            let previous = crate::list_tasks_for_repo(&repo).len();
            let worktrees = git(&repo, &["worktree", "list", "--porcelain"]);
            let error = provision_task(&repo, "", "fixture", &request("feat/area/one")).unwrap_err();
            assert!(error.contains("feat/area/one") && error.contains("'feat'") && error.contains("choose"), "{error}");
            assert_eq!(crate::list_tasks_for_repo(&repo).len(), previous);
            assert!(!crate::task_dir(&repo, "new-task").exists());
            assert!(!crate::worktrees_dir(&repo).join("new-task").exists());
            assert_eq!(git(&repo, &["worktree", "list", "--porcelain"]), worktrees);
            fs::remove_dir_all(repo).unwrap();
        }
    }

    #[test]
    fn parent_conflict_does_not_promote_or_rename_a_draft() {
        let repo = repo();
        occupy(&repo, "feat", false);
        let draft = Task {
            name: "Draft".into(),
            slug: "draft".into(),
            draft: true,
            ..Task::default()
        };
        crate::task::write_task_unlocked(&repo, &draft).unwrap();
        let path = crate::task_dir(&repo, "draft").join("task.md");
        let before = fs::read(&path).unwrap();
        let mut request = request("feat/one");
        request.draft_slug = Some("draft".into());
        assert!(provision_task(&repo, "", "fixture", &request).is_err());
        assert_eq!(fs::read(path).unwrap(), before);
        assert!(!crate::task_dir(&repo, "new-task").exists());
        assert!(!crate::worktrees_dir(&repo).exists());
        fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn child_namespace_conflicts_never_suffix_the_identity() {
        for reservation in [false, true] {
            let repo = repo();
            occupy(&repo, "feat/one", reservation);
            let mut request = request("feat");
            request.parent_task = "parent".into();
            let error = provision_task_with_reservation(&repo, "", "fixture", &request, || Ok(()), |_| Ok(())).unwrap_err();
            assert!(error.contains("child task identity"), "{error}");
            assert!(!crate::task_dir(&repo, "new-task").exists());
            assert!(!crate::worktrees_dir(&repo).join("new-task").exists());
            assert_eq!(git(&repo, &["for-each-ref", "--format=%(refname)", "refs/heads/feat-1"]), "");
            fs::remove_dir_all(repo).unwrap();
        }
    }

    #[test]
    fn exact_conflicts_dedupe_but_similar_names_remain_usable() {
        let repo = repo();
        occupy(&repo, "feat", false);
        let similar = provision_task(&repo, "", "fixture", &request("feature")).unwrap();
        assert_eq!(similar.creation, "ready");
        assert_eq!(similar.task.unwrap().branch, "feature");
        let exact = provision_task(&repo, "", "fixture", &request("feat")).unwrap();
        assert_eq!(exact.creation, "ready");
        assert_eq!(exact.task.unwrap().branch, "feat-1");
        fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn ref_enumeration_failure_is_not_branch_availability() {
        let repo = repo();
        fs::write(repo.join(".git/packed-refs"), "invalid packed ref\n").unwrap();
        let error = provision_task(&repo, "", "fixture", &request("feat")).unwrap_err();
        assert!(error.contains("list local Git branches"), "{error}");
        assert!(!crate::task_dir(&repo, "new-task").exists());
        assert!(!crate::worktrees_dir(&repo).exists());
        fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn external_ref_race_still_retains_partial_provisioning_evidence() {
        let repo = repo();
        let reply = provision_task_with_reservation(
            &repo,
            "",
            "fixture",
            &request("feat/one"),
            || Ok(()),
            |_| {
                // An independent Git writer can race the completed preflight.
                git(&repo, &["branch", "feat"]);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(reply.creation, "partial");
        assert!(reply.errors.iter().any(|error| error.stage == "git_worktree" && error.message.contains("feat")));
        let task = reply.task.unwrap();
        assert_eq!(crate::read_task(&repo, &task.slug).unwrap().branch, "feat/one");
        assert!(!Path::new(&task.worktree).exists());
        let state = read_execution_state(&repo, &task.slug).unwrap();
        assert_eq!(state.creation, "partial");
        assert!(state.creation_error.unwrap().contains("git_worktree"));
        assert!(task_playbook_path(&repo, &task.slug).unwrap().exists());
        fs::remove_dir_all(repo).unwrap();
    }

    // Keep failed assertions from leaking disposable repositories and worktrees.
    struct AttachmentRepo(PathBuf);

    impl Drop for AttachmentRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn attachment_ticket_references_resolve_to_stored_bytes() {
        let fixture = AttachmentRepo(repo());
        let repo = &fixture.0;
        let mut request = request("attachment-pointers");
        request.attachments = vec![TaskAttachment {
            name: "shot.png".into(),
            bytes: vec![0, 255, 128, 1],
        }];
        let reply = provision_task(repo, "", "fixture", &request).unwrap();
        assert_eq!(reply.creation, "ready", "{:?}", reply.errors);
        let artifacts = crate::artifacts_dir(repo, &reply.task.unwrap().slug);
        assert_eq!(fs::read(artifacts.join("attachments/shot.png")).unwrap(), request.attachments[0].bytes);
        let ticket = fs::read_to_string(artifacts.join("00-ticket.md")).unwrap();
        let references: Vec<_> = ticket.lines().filter_map(|line| line.strip_prefix("- attachments/")).collect();
        assert_eq!(references, ["shot.png"], "{ticket}");
        for reference in references {
            assert_eq!(fs::read(artifacts.join("attachments").join(reference)).unwrap(), request.attachments[0].bytes);
        }
    }

    #[test]
    fn attachment_duplicate_names_preserve_both_payloads() {
        let fixture = AttachmentRepo(repo());
        let repo = &fixture.0;
        let mut request = request("attachment-collisions");
        request.attachments = vec![
            TaskAttachment {
                name: "shot.png".into(),
                bytes: vec![1],
            },
            TaskAttachment {
                name: "shot.png".into(),
                bytes: vec![2],
            },
        ];
        let reply = provision_task(repo, "", "fixture", &request).expect("valid duplicate basenames must be allocated distinct destinations");
        assert_eq!(reply.creation, "ready", "{:?}", reply.errors);
        assert!(reply.errors.is_empty(), "{:?}", reply.errors);
        let attachments = crate::artifacts_dir(repo, &reply.task.unwrap().slug).join("attachments");
        assert_eq!(fs::read(attachments.join("shot.png")).unwrap(), [1]);
        assert_eq!(fs::read(attachments.join("shot-2.png")).unwrap(), [2]);
    }

    #[test]
    fn attachment_direct_bytes_enforce_per_file_limit_and_keep_valid_siblings() {
        let fixture = AttachmentRepo(repo());
        let repo = &fixture.0;
        let mut request = request("attachment-file-limit");
        let limit = 25 * 1024 * 1024;
        request.attachments = vec![
            TaskAttachment {
                name: "oversize.bin".into(),
                bytes: vec![1; limit + 1],
            },
            TaskAttachment {
                name: "exact.bin".into(),
                bytes: vec![2; limit],
            },
            TaskAttachment {
                name: "empty.txt".into(),
                bytes: vec![],
            },
            TaskAttachment {
                name: "small.png".into(),
                bytes: vec![0, 255, 128],
            },
        ];
        let reply = provision_task(repo, "", "fixture", &request).unwrap();
        assert_eq!(reply.creation, "ready", "{:?}", reply.errors);
        let artifacts = crate::artifacts_dir(repo, &reply.task.unwrap().slug);
        let attachments = artifacts.join("attachments");
        assert!(!attachments.join("oversize.bin").exists(), "direct byte requests must not bypass the 25 MiB limit");
        for attachment in &request.attachments[1..] {
            assert_eq!(fs::read(attachments.join(&attachment.name)).unwrap(), attachment.bytes);
        }
        assert_eq!(reply.errors.len(), 1, "{:?}", reply.errors);
        assert_eq!(reply.errors[0].stage, "attachments");
        assert_eq!(reply.errors[0].code, "import_failed");
        assert!(reply.errors[0].message.contains("oversize.bin"));
        let ticket = fs::read_to_string(artifacts.join("00-ticket.md")).unwrap();
        assert!(ticket.contains(&reply.errors[0].message));
        assert!(!ticket.contains("- attachments/oversize.bin"));
    }

    #[test]
    fn attachment_set_limit_counts_only_accepted_bytes() {
        let fixture = AttachmentRepo(repo());
        let repo = &fixture.0;
        let mut request = request("attachment-set-limit");
        let limit = 25 * 1024 * 1024;
        request.attachments = (0..4)
            .map(|index| TaskAttachment {
                name: format!("part-{index}.bin"),
                bytes: vec![index; if index == 3 { limit - 1 } else { limit }],
            })
            .collect();
        request.attachments.extend([
            TaskAttachment {
                name: "cannot-fit.bin".into(),
                bytes: vec![8; 2],
            },
            TaskAttachment {
                name: "last-byte.bin".into(),
                bytes: vec![9],
            },
            TaskAttachment {
                name: "over-set.bin".into(),
                bytes: vec![10],
            },
        ]);
        let reply = provision_task(repo, "", "fixture", &request).unwrap();
        assert_eq!(reply.creation, "ready", "{:?}", reply.errors);
        let attachments = crate::artifacts_dir(repo, &reply.task.unwrap().slug).join("attachments");
        assert!(!attachments.join("cannot-fit.bin").exists(), "reject an item that would exceed the accepted-set budget");
        assert_eq!(fs::read(attachments.join("last-byte.bin")).unwrap(), [9], "a rejection must not consume the remaining byte");
        assert!(!attachments.join("over-set.bin").exists(), "100 MiB plus one byte must not be retained");
        let stored: u64 = fs::read_dir(&attachments).unwrap().map(|entry| entry.unwrap().metadata().unwrap().len()).sum();
        assert_eq!(stored, 100 * 1024 * 1024);
        assert_eq!(reply.errors.len(), 2, "{:?}", reply.errors);
        for (error, name) in reply.errors.iter().zip(["cannot-fit.bin", "over-set.bin"]) {
            assert_eq!(error.stage, "attachments");
            assert_eq!(error.code, "import_failed");
            assert!(error.message.contains(name), "{error:?}");
        }
    }

    #[test]
    fn attachment_promotion_preserves_existing_and_case_aliased_files() {
        let fixture = AttachmentRepo(repo());
        let repo = &fixture.0;
        let draft = Task {
            name: "Draft".into(),
            slug: "draft".into(),
            draft: true,
            ..Task::default()
        };
        crate::task::write_task_unlocked(repo, &draft).unwrap();
        let existing = crate::artifacts_dir(repo, &draft.slug).join("attachments");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("trace.log"), b"old trace").unwrap();
        fs::write(existing.join("Shot.png"), b"old image").unwrap();
        let case_insensitive = existing.join("shot.png").exists();
        eprintln!("attachment filesystem case-insensitive: {case_insensitive}");
        fs::write(existing.join("old-large.bin"), b"retained").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(existing.join("old-large.bin"))
            .unwrap()
            .set_len(100 * 1024 * 1024 + 1)
            .unwrap();
        let mut request = request("attachment-promotion");
        request.draft_slug = Some(draft.slug);
        request.attachments = [("trace.log", b"first".as_slice()), ("trace.log", b"second"), ("shot.png", b"lower"), ("Shot.png", b"upper")]
            .into_iter()
            .map(|(name, bytes)| TaskAttachment {
                name: name.into(),
                bytes: bytes.to_vec(),
            })
            .collect();
        let reply = provision_task(repo, "", "fixture", &request).expect("promotion must retain repeated and case-aliased inputs");
        assert_eq!(reply.creation, "ready", "{:?}", reply.errors);
        assert!(reply.errors.is_empty(), "old files do not consume the incoming request allowance: {:?}", reply.errors);
        let task = reply.task.unwrap();
        assert!(!task.draft);
        let artifacts = crate::artifacts_dir(repo, &task.slug);
        let attachments = artifacts.join("attachments");
        assert_eq!(fs::read(attachments.join("trace.log")).unwrap(), b"old trace");
        assert_eq!(fs::read(attachments.join("Shot.png")).unwrap(), b"old image");
        let mut old_file = fs::File::open(attachments.join("old-large.bin")).unwrap();
        assert_eq!(old_file.metadata().unwrap().len(), 100 * 1024 * 1024 + 1);
        let mut marker = [0; 8];
        std::io::Read::read_exact(&mut old_file, &mut marker).unwrap();
        assert_eq!(&marker, b"retained");
        let names = if case_insensitive {
            ["trace-2.log", "trace-3.log", "shot-2.png", "Shot-3.png"]
        } else {
            ["trace-2.log", "trace-3.log", "shot.png", "Shot-2.png"]
        };
        let ticket = fs::read_to_string(artifacts.join("00-ticket.md")).unwrap();
        let references: Vec<_> = ticket.lines().filter_map(|line| line.strip_prefix("- attachments/")).collect();
        assert_eq!(references, names, "{ticket}");
        for (name, input) in names.into_iter().zip(&request.attachments) {
            assert_eq!(fs::read(attachments.join(name)).unwrap(), input.bytes);
        }
    }

    #[test]
    fn attachment_exhausted_names_report_error_without_replacement() {
        let fixture = AttachmentRepo(repo());
        let repo = &fixture.0;
        let draft = Task {
            name: "Draft".into(),
            slug: "draft".into(),
            draft: true,
            ..Task::default()
        };
        crate::task::write_task_unlocked(repo, &draft).unwrap();
        let existing = crate::artifacts_dir(repo, &draft.slug).join("attachments");
        fs::create_dir_all(&existing).unwrap();
        let names: Vec<_> = (1..=99).map(|index| if index == 1 { "shot.png".into() } else { format!("shot-{index}.png") }).collect();
        for (index, name) in names.iter().enumerate() {
            fs::write(existing.join(name), [index as u8]).unwrap();
        }
        let mut request = request("attachment-exhaustion");
        request.draft_slug = Some(draft.slug);
        request.attachments = vec![
            TaskAttachment {
                name: "shot.png".into(),
                bytes: vec![255],
            },
            TaskAttachment {
                name: "sibling.png".into(),
                bytes: vec![254],
            },
        ];
        let reply = provision_task(repo, "", "fixture", &request).unwrap();
        assert_eq!(reply.creation, "ready", "{:?}", reply.errors);
        let artifacts = crate::artifacts_dir(repo, &reply.task.unwrap().slug);
        let attachments = artifacts.join("attachments");
        for (index, name) in names.iter().enumerate() {
            assert_eq!(fs::read(attachments.join(name)).unwrap(), [index as u8], "{name} must not be replaced");
        }
        assert_eq!(fs::read(attachments.join("sibling.png")).unwrap(), [254]);
        assert!(!attachments.join("shot-100.png").exists());
        assert_eq!(reply.errors.len(), 1, "{:?}", reply.errors);
        assert_eq!(reply.errors[0].stage, "attachments");
        assert_eq!(reply.errors[0].code, "import_failed");
        assert!(reply.errors[0].message.contains("shot.png"));
        let ticket = fs::read_to_string(artifacts.join("00-ticket.md")).unwrap();
        assert!(ticket.contains(&reply.errors[0].message));
        let references: Vec<_> = ticket.lines().filter_map(|line| line.strip_prefix("- attachments/")).collect();
        assert_eq!(references, ["sibling.png"], "{ticket}");
    }

    #[test]
    fn attachment_unsafe_names_reject_before_reservation_even_when_oversized() {
        let fixture = AttachmentRepo(repo());
        let repo = &fixture.0;
        let tasks_before: Vec<_> = crate::list_tasks_for_repo(repo).into_iter().map(|task| task.slug).collect();
        let worktrees_before = git(repo, &["worktree", "list", "--porcelain"]);
        let branches_before = git(repo, &["for-each-ref", "--format=%(refname)", "refs/heads"]);
        let mut request = request("attachment-unsafe");
        request.attachments = vec![TaskAttachment {
            name: "../escape.png".into(),
            bytes: vec![1; 25 * 1024 * 1024 + 1],
        }];
        let reserved = std::cell::Cell::new(false);
        let result = provision_task_with_reservation(
            repo,
            "",
            "fixture",
            &request,
            || {
                reserved.set(true);
                Ok(())
            },
            |_| Ok(()),
        );
        assert!(result.is_err());
        assert!(!reserved.get(), "unsafe basenames must fail before reservation, not be skipped by size admission");
        assert_eq!(crate::list_tasks_for_repo(repo).into_iter().map(|task| task.slug).collect::<Vec<_>>(), tasks_before);
        assert_eq!(git(repo, &["worktree", "list", "--porcelain"]), worktrees_before);
        assert_eq!(git(repo, &["for-each-ref", "--format=%(refname)", "refs/heads"]), branches_before);
        assert!(!crate::task_dir(repo, "new-task").exists());
        assert!(!crate::worktrees_dir(repo).exists());
        assert!(!crate::artifacts_dir(repo, "new-task").join("escape.png").exists());
    }

    #[test]
    fn attachment_install_failure_retains_partial_task_identity() {
        let fixture = AttachmentRepo(repo());
        let repo = &fixture.0;
        let mut request = request("attachment-install-failure");
        request.attachments = vec![TaskAttachment {
            name: "shot.png".into(),
            bytes: vec![1, 2, 3],
        }];
        let mut reserved = None;
        let reply = provision_task_with_reservation(
            repo,
            "",
            "fixture",
            &request,
            || Ok(()),
            |task| {
                reserved = Some(task.clone());
                fs::write(crate::artifacts_dir(repo, &task.slug).join("attachments"), b"blocked").map_err(|error| error.to_string())
            },
        )
        .unwrap();
        assert_eq!(reply.creation, "partial", "{:?}", reply.errors);
        assert_eq!(reply.start, "not_requested");
        assert!(reply.sessions.is_empty());
        assert!(reply.errors.iter().any(|error| error.stage == "install_inputs" && error.code == "provisioning_failed"));
        let task = reply.task.expect("installation failure must keep the reserved identity");
        let reserved = reserved.unwrap();
        assert_eq!((&task.slug, &task.branch, &task.worktree), (&reserved.slug, &reserved.branch, &reserved.worktree));
        let persisted = crate::read_task(repo, &task.slug).unwrap();
        assert_eq!((&persisted.branch, &persisted.worktree), (&task.branch, &task.worktree));
        assert!(Path::new(&task.worktree).is_dir());
        assert_eq!(git(Path::new(&task.worktree), &["branch", "--show-current"]).trim(), task.branch);
        assert_eq!(crate::list_tasks_for_repo(repo).len(), 1);
        let state = read_execution_state(repo, &task.slug).unwrap();
        assert_eq!(state.creation, "partial");
        assert!(state.creation_error.unwrap().contains("install_inputs"));
        assert!(task_playbook_path(repo, &task.slug).unwrap().is_file());
        assert_eq!(fs::read(crate::artifacts_dir(repo, &task.slug).join("attachments")).unwrap(), b"blocked");
    }

    #[test]
    fn attachment_rejection_preserves_original_ticket_override() {
        let fixture = AttachmentRepo(repo());
        let repo = &fixture.0;
        let mut request = request("attachment-original-ticket");
        let original = "# Original\r\nKeep exactly.\r\n\rA final line without newline";
        request.original_ticket = Some(original.into());
        request.attachments = vec![
            TaskAttachment {
                name: "oversize.png".into(),
                bytes: vec![1; 25 * 1024 * 1024 + 1],
            },
            TaskAttachment {
                name: "retained.png".into(),
                bytes: vec![0, 255, 128],
            },
        ];
        let reply = provision_task(repo, "", "fixture", &request).unwrap();
        assert_eq!(reply.creation, "ready", "{:?}", reply.errors);
        let artifacts = crate::artifacts_dir(repo, &reply.task.unwrap().slug);
        assert_eq!(fs::read(artifacts.join("00-ticket.md")).unwrap(), original.as_bytes());
        assert!(!artifacts.join("attachments/oversize.png").exists());
        assert_eq!(fs::read(artifacts.join("attachments/retained.png")).unwrap(), [0, 255, 128]);
        assert_eq!(reply.errors.len(), 1, "{:?}", reply.errors);
        assert_eq!(reply.errors[0].stage, "attachments");
        assert_eq!(reply.errors[0].code, "import_failed");
        assert!(reply.errors[0].message.contains("oversize.png"));
    }

    #[test]
    fn missing_but_registered_worktree_clears_the_name() {
        let repo = repo();
        // A registered worktree whose directory was removed must still block its name,
        // including when the registered path contains spaces.
        let explicit_trees = crate::worktrees_dir(&repo).join("explicit trees");
        std::fs::create_dir_all(crate::worktrees_dir(&repo)).unwrap();
        git(&repo, &["worktree", "add", explicit_trees.to_str().unwrap(), "-b", "old-feat"]);
        fs::remove_dir_all(&explicit_trees).unwrap();
        assert!(crate::git::registered_worktree_paths(&repo)
            .unwrap()
            .iter()
            .any(|p| p.file_name().unwrap() == "explicit trees"));

        let mut request = request("new-feat");
        request.worktree_name = Some("explicit trees".into());
        let reply = provision_task(&repo, "", "fixture", &request).unwrap();
        assert_eq!(reply.creation, "ready", "{:?}", reply.errors);
        let task = reply.task.unwrap();
        assert!(Path::new(&task.worktree).exists());
        // The stale registration and its branch stay untouched.
        assert!(crate::git::registered_worktree_paths(&repo)
            .unwrap()
            .iter()
            .any(|p| p.file_name().unwrap() == "explicit trees"));
        assert_eq!(git(&repo, &["for-each-ref", "--format=%(refname)", "refs/heads/old-feat"]), "refs/heads/old-feat\n");
        assert!(git(&repo, &["worktree", "list"]).contains("explicit trees"));
        fs::remove_dir_all(repo).unwrap();
    }
}
