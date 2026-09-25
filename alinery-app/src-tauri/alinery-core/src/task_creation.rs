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
