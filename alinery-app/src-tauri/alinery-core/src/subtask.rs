use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::git_cmd;
use crate::lockfile::with_task_mutation_lock;
use crate::paths::{
    alinery_dir, artifacts_dir, safe_component, session_meta_path, session_scrollback_path, sessions_dir, subtask_snapshot_dir, subtask_snapshot_staging_dir, tasks_dir,
    worktrees_dir,
};
use crate::shared::{read_session_meta_full, write_meta_atomic};
use crate::task::{read_task, task_dir, write_task_unlocked};
use crate::task_creation::{provision_task_with_reservation, CreateTaskRequest, TaskPlaybookPackage};
use crate::types::{
    CreateSubtaskInput, CreateSubtaskResult, FinalizeMode, FinalizeSubtaskResult, FinishInspection, SessionMeta, SnapshotProvenance, SubtaskArtifactState, SubtaskGitState, Task,
    TaskRelationships, TaskSummary,
};
use crate::write_bytes_atomic;

const RELATIONSHIP_ERROR: &str = "relationship corruption";

fn relationship_error(message: impl AsRef<str>) -> String {
    format!("{RELATIONSHIP_ERROR}: {}", message.as_ref())
}

fn task_map(tasks: &[Task]) -> Result<HashMap<&str, &Task>, String> {
    let mut by_slug = HashMap::new();
    for task in tasks {
        if task.slug.is_empty() || safe_component(&task.slug) != Some(task.slug.as_str()) {
            return Err(relationship_error(format!("invalid task slug '{}'", task.slug)));
        }
        if by_slug.insert(task.slug.as_str(), task).is_some() {
            return Err(relationship_error(format!("duplicate task slug '{}'", task.slug)));
        }
    }
    Ok(by_slug)
}

fn validate_relationship_set(tasks: &[Task]) -> Result<(), String> {
    validate_task_relationship_fields(
        tasks
            .iter()
            .map(|task| (task.slug.as_str(), task.parent_task.as_str(), task.active_subtask.as_str(), task.archived)),
    )
}

pub fn validate_task_relationship_fields<'a>(tasks: impl IntoIterator<Item = (&'a str, &'a str, &'a str, bool)>) -> Result<(), String> {
    let tasks = tasks.into_iter().collect::<Vec<_>>();
    let mut by_slug = HashMap::with_capacity(tasks.len());
    for task @ (slug, _, _, _) in &tasks {
        if slug.is_empty() {
            return Err(relationship_error("task slug is empty"));
        }
        if by_slug.insert(*slug, *task).is_some() {
            return Err(relationship_error(format!("duplicate task slug '{slug}'")));
        }
    }

    for (slug, parent_slug, child_slug, archived) in &tasks {
        if parent_slug == slug || child_slug == slug {
            return Err(relationship_error(format!("task '{slug}' links to itself")));
        }
        if !parent_slug.is_empty() {
            let parent = by_slug
                .get(parent_slug)
                .ok_or_else(|| relationship_error(format!("task '{slug}' names missing parent '{parent_slug}'")))?;
            if *archived {
                if parent.2 == *slug {
                    return Err(relationship_error(format!("archived task '{slug}' is still active on parent '{}'", parent.0)));
                }
            } else if parent.2 != *slug {
                return Err(relationship_error(format!(
                    "task '{slug}' names parent '{}', but that parent names active child '{}'",
                    parent.0, parent.2
                )));
            }
        }
        if !child_slug.is_empty() {
            let child = by_slug
                .get(child_slug)
                .ok_or_else(|| relationship_error(format!("task '{slug}' names missing active child '{child_slug}'")))?;
            if child.3 {
                return Err(relationship_error(format!("task '{slug}' names archived active child '{}'", child.0)));
            }
            if child.1 != *slug {
                return Err(relationship_error(format!(
                    "task '{slug}' names active child '{}', but that child names parent '{}'",
                    child.0, child.1
                )));
            }
        }
    }

    for task in &tasks {
        let mut seen = HashSet::new();
        let mut cursor = *task;
        while !cursor.2.is_empty() {
            if !seen.insert(cursor.0) {
                return Err(relationship_error(format!("active-child cycle reaches '{}'", cursor.0)));
            }
            cursor = by_slug[cursor.2];
        }

        seen.clear();
        cursor = *task;
        while !cursor.1.is_empty() {
            if !seen.insert(cursor.0) {
                return Err(relationship_error(format!("parent cycle reaches '{}'", cursor.0)));
            }
            cursor = by_slug[cursor.1];
        }
    }
    Ok(())
}

pub fn validate_task_relationships(tasks: &[Task]) -> Result<(), String> {
    validate_relationship_set(tasks)
}

fn load_relationship_tasks(repo: &Path) -> Result<Vec<Task>, String> {
    let dir = tasks_dir(repo);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut tasks = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("read {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let Some(slug) = entry.file_name().to_str().map(str::to_owned) else {
            return Err(relationship_error("task directory name is not UTF-8"));
        };
        if !entry.path().join("task.md").is_file() {
            continue;
        }
        let task = read_task(repo, &slug).ok_or_else(|| relationship_error(format!("cannot parse task '{slug}'")))?;
        if task.slug != slug {
            return Err(relationship_error(format!("task directory '{slug}' contains slug '{}'", task.slug)));
        }
        tasks.push(task);
    }
    validate_relationship_set(&tasks)?;
    Ok(tasks)
}

pub fn read_task_relationships(repo: &Path, task_slug: &str) -> Result<TaskRelationships, String> {
    let tasks = load_relationship_tasks(repo)?;
    let by_slug = task_map(&tasks)?;
    let task = by_slug.get(task_slug).ok_or_else(|| format!("no such task: {task_slug}"))?;
    Ok(TaskRelationships {
        parent_task: (!task.parent_task.is_empty()).then(|| TaskSummary::from(by_slug[task.parent_task.as_str()])),
        active_subtask: (!task.active_subtask.is_empty()).then(|| TaskSummary::from(by_slug[task.active_subtask.as_str()])),
    })
}

#[derive(Clone)]
struct ManagerContext {
    owner_slug: String,
    parent: Task,
    meta: SessionMeta,
    meta_path: PathBuf,
}

fn resolve_subtask_manager(repo: &Path, manager_session_id: &str) -> Result<ManagerContext, String> {
    if manager_session_id.is_empty() || safe_component(manager_session_id) != Some(manager_session_id) {
        return Err("invalid sub-task manager session id".into());
    }
    let tasks = load_relationship_tasks(repo)?;
    let mut matches = Vec::new();
    for task in tasks {
        let dir = sessions_dir(repo, &task.slug);
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Some(meta) = read_session_meta_full(&path) else { continue };
            if meta.id == manager_session_id && meta.subtask_manager && !meta.archived {
                matches.push(ManagerContext {
                    owner_slug: task.slug.clone(),
                    parent: task.clone(),
                    meta,
                    meta_path: path,
                });
            }
        }
    }
    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err("sub-task manager session is missing, archived, or unauthorized".into()),
        _ => Err("sub-task manager session id is ambiguous".into()),
    }
}

fn resolve_bound_manager(repo: &Path, manager_session_id: &str) -> Result<(ManagerContext, Task), String> {
    let manager = resolve_subtask_manager(repo, manager_session_id)?;
    if manager.meta.subtask_slug.is_empty() {
        return Err("sub-task manager is not bound to an active child".into());
    }
    if manager.parent.active_subtask != manager.meta.subtask_slug {
        return Err(relationship_error("manager binding does not match its parent active child"));
    }
    let relationships = read_task_relationships(repo, &manager.owner_slug)?;
    let child = relationships.active_subtask.ok_or_else(|| relationship_error("manager parent has no active child"))?;
    if child.slug != manager.meta.subtask_slug {
        return Err(relationship_error("manager binding does not match reciprocal child"));
    }
    let child_task = read_task(repo, &child.slug).ok_or_else(|| relationship_error("active child task is missing"))?;
    Ok((manager, child_task))
}

fn command_output(mut command: std::process::Command, description: &str) -> Result<std::process::Output, String> {
    command.output().map_err(|e| format!("{description}: {e}"))
}

fn worktree_clean(path: &Path) -> Result<bool, String> {
    if !path.is_dir() {
        return Ok(false);
    }
    let mut command = git_cmd(path);
    command.args(["status", "--porcelain=v1", "--untracked-files=normal"]);
    let output = command_output(command, "git status")?;

    if !output.status.success() {
        return Err(format!("git status failed: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(output.stdout.is_empty())
}
pub fn subtask_manager_owner_slug(repo: &Path, manager_session_id: &str) -> Result<String, String> {
    resolve_subtask_manager(repo, manager_session_id).map(|manager| manager.owner_slug)
}

fn exact_child_slug(slug: &str) -> bool {
    !slug.is_empty()
        && safe_component(slug) == Some(slug)
        && slug
            .bytes()
            .enumerate()
            .all(|(index, byte)| byte.is_ascii_lowercase() || byte.is_ascii_digit() || (byte == b'-' && index > 0 && index + 1 < slug.len()))
        && !slug.contains("--")
}

fn ref_exists(repo: &Path, slug: &str) -> bool {
    let mut check = git_cmd(repo);
    check.args(["check-ref-format", "--branch", slug]);
    if command_output(check, "git check-ref-format").map(|output| !output.status.success()).unwrap_or(true) {
        return true;
    }
    let mut show = git_cmd(repo);
    show.args(["show-ref", "--verify", "--quiet", &format!("refs/heads/{slug}")]);
    command_output(show, "git show-ref").map(|output| output.status.success()).unwrap_or(true)
}

pub fn task_worktree_is_clean(task: &Task) -> Result<bool, String> {
    if task.worktree.is_empty() {
        return Ok(false);
    }
    worktree_clean(Path::new(&task.worktree))
}

fn validate_subtask_creation(repo: &Path, input: &CreateSubtaskInput) -> Result<ManagerContext, String> {
    let manager = resolve_subtask_manager(repo, &input.manager_session_id)?;
    if !manager.meta.subtask_slug.is_empty() {
        return Err("sub-task manager already has an active child".into());
    }
    if manager.parent.draft || manager.parent.archived {
        return Err("sub-task parent must be a non-draft active task".into());
    }
    if !manager.parent.active_subtask.is_empty() {
        return Err("sub-task parent already has an active child".into());
    }
    if !manager.parent.has_worktree || manager.parent.worktree.is_empty() {
        return Err("sub-task parent has no dedicated worktree".into());
    }
    if !task_worktree_is_clean(&manager.parent)? {
        return Err("sub-task parent worktree must exist and be clean".into());
    }
    if !exact_child_slug(&input.slug) {
        return Err("sub-task slug must use lowercase ASCII letters, numbers, and single dashes without normalization".into());
    }
    if task_dir(repo, &input.slug).exists() {
        return Err("sub-task slug collides with an existing task".into());
    }
    if worktrees_dir(repo).join(&input.slug).exists() {
        return Err("sub-task slug collides with an existing worktree".into());
    }
    if ref_exists(repo, &input.slug) {
        return Err("sub-task slug collides with an existing or invalid Git ref".into());
    }
    Ok(manager)
}

/// Daemon-only child provisioning. Relationship reservation shares the task intent
/// lock; Git and input installation use the same retained, partial-outcome saga as
/// ordinary tasks. The daemon schedules every eligible root only after readiness.
pub fn create_subtask(repo: &Path, lane: &str, app_config_identity: &str, input: CreateSubtaskInput) -> Result<CreateSubtaskResult, String> {
    let manager = with_task_mutation_lock(repo, "inspect sub-task creation", || validate_subtask_creation(repo, &input))?;
    let state = crate::execution::read_execution_state(repo, &manager.owner_slug)?;
    if state.owning_lane != lane || state.owning_app_config_identity != app_config_identity {
        return Err("sub-task parent belongs to another daemon lane or app configuration".into());
    }
    if state.creation != "ready" {
        return Err("sub-task parent provisioning is not ready".into());
    }
    let source = fs::read_to_string(crate::execution::task_playbook_path(repo, &manager.owner_slug)?).map_err(|error| format!("read retained parent definition: {error}"))?;
    if crate::execution::definition_identity(source.as_bytes()) != state.definition_identity {
        return Err("retained parent definition integrity mismatch".into());
    }
    let base_ref = task_head(repo, &manager.parent, true, "parent")?;
    let inherited_definition = input.playbook.is_none();
    let request = CreateTaskRequest {
        name: input.name.clone(),
        draft_slug: None,
        requested_slug: Some(input.slug.clone()),
        description: input.instructions.clone(),
        evidence: String::new(),
        attachments: Vec::new(),
        original_ticket: None,
        attachment_urls: Vec::new(),
        attachment_errors: Vec::new(),
        linear_id: String::new(),
        github_issue: String::new(),
        related_tasks: Vec::new(),
        parent_task: manager.owner_slug.clone(),
        playbook: input.playbook.clone().unwrap_or(TaskPlaybookPackage {
            reference: state.reference,
            source,
        }),
        branch_name: Some(input.slug.clone()),
        worktree_name: Some(input.slug.clone()),
        base_ref: Some(base_ref.clone()),
        launch_defaults: state.launch_defaults,
        auto_advance_steps: inherited_definition.then(|| state.enabled_steps.into_iter().collect()),
        max_live_sessions: Some(input.max_live_sessions.unwrap_or(state.max_live_sessions)),
        start: input.start,
    };
    let provisioning = provision_task_with_reservation(
        repo,
        lane,
        app_config_identity,
        &request,
        || {
            let current = validate_subtask_creation(repo, &input)?;
            let current_state = crate::execution::read_execution_state(repo, &current.owner_slug)?;
            if current_state.owning_lane != lane || current_state.owning_app_config_identity != app_config_identity || current_state.creation != "ready" {
                return Err("sub-task parent ownership or provisioning changed during creation".into());
            }
            if current.owner_slug != manager.owner_slug || task_head(repo, &current.parent, true, "parent")? != base_ref {
                return Err("sub-task parent changed during creation".into());
            }
            Ok(())
        },
        |child| {
            let mut parent = read_task(repo, &manager.owner_slug).ok_or("sub-task parent is missing")?;
            parent.active_subtask = child.slug.clone();
            write_task_unlocked(repo, &parent)?;
            let mut meta = read_session_meta_full(&manager.meta_path).ok_or("sub-task manager is missing")?;
            meta.subtask_slug = child.slug.clone();
            write_meta_atomic(&manager.meta_path, &serde_json::to_value(&meta).map_err(|error| error.to_string())?)
        },
    )?;
    Ok(CreateSubtaskResult {
        parent_task: TaskSummary::from(&read_task(repo, &manager.owner_slug).unwrap_or(manager.parent)),
        child_task: provisioning.task.as_ref().map(TaskSummary::from),
        manager_session: read_session_meta_full(&manager.meta_path).unwrap_or(manager.meta),
        provisioning,
    })
}

fn task_head(repo: &Path, task: &Task, worktree_exists: bool, role: &str) -> Result<String, String> {
    let command_path = if worktree_exists { Path::new(&task.worktree) } else { repo };
    if worktree_exists {
        let mut symbolic_ref = git_cmd(command_path);
        symbolic_ref.args(["symbolic-ref", "--quiet", "HEAD"]);
        let output = command_output(symbolic_ref, "git symbolic-ref")?;
        if !output.status.success() {
            return Err(format!("{role} worktree HEAD is detached; expected branch '{}'", task.branch));
        }
        let actual = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let expected = if task.branch.starts_with("refs/heads/") {
            task.branch.clone()
        } else {
            format!("refs/heads/{}", task.branch)
        };
        if actual != expected {
            return Err(format!(
                "{role} worktree is on branch '{}'; expected '{}'",
                actual.strip_prefix("refs/heads/").unwrap_or(&actual),
                task.branch
            ));
        }
    }

    let revision = if worktree_exists { "HEAD" } else { task.branch.as_str() };
    let mut rev_parse = git_cmd(command_path);
    rev_parse.args(["rev-parse", "--verify", revision]);
    let output = command_output(rev_parse, "git rev-parse")?;
    if !output.status.success() {
        return Err(format!("cannot resolve {role} {}: {}", revision, String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_state(repo: &Path, parent: &Task, child: &Task) -> Result<SubtaskGitState, String> {
    let parent_worktree_exists = Path::new(&parent.worktree).is_dir();
    let child_worktree_exists = Path::new(&child.worktree).is_dir();
    let parent_worktree_clean = parent_worktree_exists && worktree_clean(Path::new(&parent.worktree))?;
    let child_worktree_clean = child_worktree_exists && worktree_clean(Path::new(&child.worktree))?;
    let parent_head = task_head(repo, parent, parent_worktree_exists, "parent")?;
    let child_head = task_head(repo, child, child_worktree_exists, "child")?;

    let mut count = git_cmd(repo);
    count.args(["rev-list", "--count", &format!("{parent_head}..{child_head}")]);
    let count_output = command_output(count, "git rev-list")?;
    if !count_output.status.success() {
        return Err(format!("git rev-list failed: {}", String::from_utf8_lossy(&count_output.stderr).trim()));
    }
    let child_only_commits = String::from_utf8_lossy(&count_output.stdout)
        .trim()
        .parse::<u64>()
        .map_err(|e| format!("parse child commit count: {e}"))?;

    let mut ancestor = git_cmd(repo);
    ancestor.args(["merge-base", "--is-ancestor", &child_head, &parent_head]);
    let ancestor_status = ancestor.status().map_err(|e| format!("git merge-base: {e}"))?;
    let child_head_contained = ancestor_status.success();

    Ok(SubtaskGitState {
        parent_worktree_exists,
        child_worktree_exists,
        parent_worktree_clean,
        child_worktree_clean,
        child_only_commits,
        child_head_contained,
    })
}

fn validate_snapshot_source(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("inspect {}: {e}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("snapshot source contains symlink: {}", path.display()));
    }
    if metadata.is_file() {
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err(format!("snapshot source contains unsupported file: {}", path.display()));
    }
    for entry in fs::read_dir(path).map_err(|e| format!("read {}: {e}", path.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_str().ok_or_else(|| format!("snapshot component is not UTF-8 under {}", path.display()))?;
        if safe_component(name) != Some(name) {
            return Err(format!("unsafe snapshot component: {name}"));
        }
        validate_snapshot_source(&entry.path())?;
    }
    Ok(())
}

fn copy_snapshot_tree(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        fs::create_dir_all(destination).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let metadata = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if metadata.is_file() {
        fs::copy(source, destination).map_err(|e| format!("copy {}: {e}", source.display()))?;
        return Ok(());
    }
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        copy_snapshot_tree(&entry.path(), &destination.join(entry.file_name()))?;
    }
    Ok(())
}

fn read_snapshot_provenance(path: &Path) -> Option<SnapshotProvenance> {
    fs::read_to_string(path.join("provenance.toml")).ok().and_then(|content| toml::from_str(&content).ok())
}

fn reusable_snapshot(path: &Path, child: &Task) -> bool {
    path.is_dir()
        && validate_snapshot_source(path).is_ok()
        && read_snapshot_provenance(path)
            .map(|provenance| provenance.child_slug == child.slug && provenance.branch == child.branch)
            .unwrap_or(false)
}

fn install_snapshot(repo: &Path, parent: &Task, child: &Task) -> Result<PathBuf, String> {
    let source = artifacts_dir(repo, &child.slug);
    validate_snapshot_source(&source)?;
    if source.join("provenance.toml").exists() {
        return Err("child artifacts contain reserved provenance.toml".into());
    }
    let destination = subtask_snapshot_dir(repo, &parent.slug, &child.slug);
    if destination.exists() {
        if reusable_snapshot(&destination, child) {
            return Ok(destination);
        }
        return Err(format!("sub-task snapshot already exists with different provenance: {}", destination.display()));
    }
    let nonce = format!("{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let staging = subtask_snapshot_staging_dir(repo, &parent.slug, &child.slug, &nonce);
    if let Some(parent_dir) = staging.parent() {
        fs::create_dir_all(parent_dir).map_err(|e| e.to_string())?;
    }
    let result = (|| {
        copy_snapshot_tree(&source, &staging)?;
        let provenance = SnapshotProvenance {
            child_slug: child.slug.clone(),
            branch: child.branch.clone(),
            snapshot_time: now_secs(),
        };
        let serialized = toml::to_string(&provenance).map_err(|e| e.to_string())?;
        write_bytes_atomic(&staging.join("provenance.toml"), serialized.as_bytes())?;
        fs::rename(&staging, &destination).map_err(|e| format!("install snapshot {}: {e}", destination.display()))?;
        Ok(destination.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn mode_key(mode: FinalizeMode) -> &'static str {
    match mode {
        FinalizeMode::ArtifactsOnly => "artifacts_only",
        FinalizeMode::IntegratedCode => "integrated_code",
        FinalizeMode::ArchiveWithoutCode => "archive_without_code",
    }
}

fn outcome_for_mode(mode: FinalizeMode) -> &'static str {
    match mode {
        FinalizeMode::IntegratedCode => "merged",
        FinalizeMode::ArtifactsOnly | FinalizeMode::ArchiveWithoutCode => "finished",
    }
}

pub fn inspect_subtask_finish(repo: &Path, manager_session_id: &str, observed_live_parent_sessions: Vec<String>) -> Result<FinishInspection, String> {
    let (manager, child) = resolve_bound_manager(repo, manager_session_id)?;
    let code_state = git_state(repo, &manager.parent, &child)?;
    let snapshot_path = subtask_snapshot_dir(repo, &manager.parent.slug, &child.slug);
    let snapshot_exists = snapshot_path.exists();
    let snapshot_reusable = reusable_snapshot(&snapshot_path, &child);
    let has_artifacts = fs::read_dir(artifacts_dir(repo, &child.slug)).map(|mut entries| entries.next().is_some()).unwrap_or(false);
    let artifact_state = SubtaskArtifactState {
        has_artifacts,
        snapshot_exists,
        snapshot_reusable,
        snapshot_path: snapshot_path.to_string_lossy().into_owned(),
    };
    let mut common = Vec::new();
    if !child.active_subtask.is_empty() {
        common.push(format!("child '{}' still has active child '{}'", child.slug, child.active_subtask));
    }
    if let Err(error) = validate_snapshot_source(&artifacts_dir(repo, &child.slug)) {
        common.push(error);
    }
    if snapshot_exists && !snapshot_reusable {
        common.push("an immutable snapshot already exists with different provenance".into());
    }

    let mut blockers = BTreeMap::new();
    let mut artifact_only = common.clone();
    if !code_state.child_worktree_exists {
        artifact_only.push("child worktree is missing".into());
    } else if !code_state.child_worktree_clean {
        artifact_only.push("child worktree is dirty".into());
    }
    if code_state.child_only_commits != 0 {
        artifact_only.push(format!("child has {} child-only commit(s)", code_state.child_only_commits));
    }
    blockers.insert(mode_key(FinalizeMode::ArtifactsOnly).into(), artifact_only);

    let mut integrated = common.clone();
    if !code_state.child_worktree_exists {
        integrated.push("child worktree is missing".into());
    } else if !code_state.child_worktree_clean {
        integrated.push("child worktree is dirty".into());
    }
    if !code_state.child_head_contained {
        integrated.push("child branch is not contained by the parent branch".into());
    }
    if !code_state.parent_worktree_exists {
        integrated.push("parent worktree is missing".into());
    } else if !code_state.parent_worktree_clean {
        integrated.push("parent worktree is dirty or has unresolved merge state".into());
    }
    blockers.insert(mode_key(FinalizeMode::IntegratedCode).into(), integrated);
    blockers.insert(mode_key(FinalizeMode::ArchiveWithoutCode).into(), common);

    let allowed_modes = [FinalizeMode::ArtifactsOnly, FinalizeMode::IntegratedCode, FinalizeMode::ArchiveWithoutCode]
        .into_iter()
        .filter(|mode| blockers[mode_key(*mode)].is_empty())
        .collect();
    let observed_live_parent_sessions = observed_live_parent_sessions
        .into_iter()
        .filter(|id| id != manager_session_id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();

    Ok(FinishInspection {
        child_task: TaskSummary::from(&child),
        code_state,
        artifact_state,
        observed_live_parent_sessions,
        allowed_modes,
        blockers,
    })
}

pub fn finalize_subtask(repo: &Path, manager_session_id: &str, mode: FinalizeMode) -> Result<FinalizeSubtaskResult, String> {
    with_task_mutation_lock(repo, "finalize sub-task", || {
        let inspection = inspect_subtask_finish(repo, manager_session_id, Vec::new())?;
        let mode_blockers = inspection.blockers.get(mode_key(mode)).cloned().unwrap_or_else(|| vec!["unknown finish mode".into()]);
        if !mode_blockers.is_empty() {
            return Err(format!("cannot finalize as {}: {}", mode_key(mode), mode_blockers.join("; ")));
        }
        let (mut manager, mut child) = resolve_bound_manager(repo, manager_session_id)?;
        let parent_path = task_dir(repo, &manager.parent.slug).join("task.md");
        let child_path = task_dir(repo, &child.slug).join("task.md");
        let parent_bytes = fs::read(&parent_path).map_err(|e| e.to_string())?;
        let child_bytes = fs::read(&child_path).map_err(|e| e.to_string())?;
        let snapshot = install_snapshot(repo, &manager.parent, &child)?;

        child.archived = true;
        child.subtask_outcome = outcome_for_mode(mode).into();
        if let Err(error) = write_task_unlocked(repo, &child) {
            let _ = write_bytes_atomic(&child_path, &child_bytes);
            return Err(error);
        }
        manager.parent.active_subtask.clear();
        if let Err(error) = write_task_unlocked(repo, &manager.parent) {
            let _ = write_bytes_atomic(&child_path, &child_bytes);
            let _ = write_bytes_atomic(&parent_path, &parent_bytes);
            return Err(error);
        }
        Ok(FinalizeSubtaskResult {
            parent_task: TaskSummary::from(&manager.parent),
            archived_child: TaskSummary::from(&child),
            snapshot_path: snapshot.to_string_lossy().into_owned(),
        })
    })
}

struct DiscardContext {
    manager: ManagerContext,
    descendants: Vec<Task>,
    sessions: Vec<(String, String)>,
}

fn discard_context(repo: &Path, owner_task_slug: &str, manager_session_id: &str) -> Result<DiscardContext, String> {
    let manager = if manager_session_id.is_empty() {
        let tasks = load_relationship_tasks(repo)?;
        let by_slug = task_map(&tasks)?;
        let parent = by_slug.get(owner_task_slug).ok_or_else(|| format!("no such task: {owner_task_slug}"))?;
        if parent.active_subtask.is_empty() {
            return Err("task has no active sub-task to discard".into());
        }
        ManagerContext {
            owner_slug: owner_task_slug.to_string(),
            parent: (*parent).clone(),
            meta: SessionMeta {
                subtask_manager: true,
                subtask_slug: parent.active_subtask.clone(),
                ..Default::default()
            },
            meta_path: PathBuf::new(),
        }
    } else {
        let manager = resolve_subtask_manager(repo, manager_session_id)?;
        if manager.owner_slug != owner_task_slug {
            return Err("sub-task manager does not belong to this task".into());
        }
        manager
    };

    let tasks = load_relationship_tasks(repo)?;
    let mut descendants = Vec::new();
    if !manager.meta.subtask_slug.is_empty() {
        if manager.parent.active_subtask != manager.meta.subtask_slug {
            return Err(relationship_error("manager binding does not match its parent active child"));
        }
        let by_slug = task_map(&tasks)?;
        let mut parent_slug = manager.owner_slug.as_str();
        let mut child_slug = manager.meta.subtask_slug.as_str();
        loop {
            let child = by_slug.get(child_slug).ok_or_else(|| relationship_error("active child task is missing"))?;
            if child.parent_task != parent_slug {
                return Err(relationship_error("manager binding does not match reciprocal child"));
            }
            descendants.push((*child).clone());
            if child.active_subtask.is_empty() {
                break;
            }
            parent_slug = child.slug.as_str();
            child_slug = child.active_subtask.as_str();
        }
    }

    let mut sessions = BTreeSet::new();
    if let Ok(entries) = fs::read_dir(sessions_dir(repo, &manager.owner_slug)) {
        for entry in entries.flatten() {
            let Some(meta) = read_session_meta_full(&entry.path()) else {
                continue;
            };
            if meta.subtask_manager && meta.subtask_slug == manager.meta.subtask_slug {
                sessions.insert((manager.owner_slug.clone(), meta.id));
            }
        }
    }
    for task in &descendants {
        if let Ok(entries) = fs::read_dir(sessions_dir(repo, &task.slug)) {
            for entry in entries.flatten() {
                if let Some(meta) = read_session_meta_full(&entry.path()) {
                    sessions.insert((task.slug.clone(), meta.id));
                }
            }
        }
    }

    Ok(DiscardContext {
        manager,
        descendants,
        sessions: sessions.into_iter().collect(),
    })
}

pub fn subtask_discard_sessions(repo: &Path, owner_task_slug: &str, manager_session_id: &str) -> Result<Vec<(String, String)>, String> {
    discard_context(repo, owner_task_slug, manager_session_id).map(|context| context.sessions)
}

fn restore_task_bytes(originals: &[(PathBuf, Vec<u8>)]) {
    for (path, bytes) in originals {
        let _ = write_bytes_atomic(path, bytes);
    }
}

fn archive_killed_lineage(repo: &Path, manager: &ManagerContext, descendants: &[Task]) -> Result<(), String> {
    let parent_path = task_dir(repo, &manager.parent.slug).join("task.md");
    let mut originals = vec![(parent_path.clone(), fs::read(&parent_path).map_err(|e| format!("read {}: {e}", parent_path.display()))?)];
    for task in descendants {
        let path = task_dir(repo, &task.slug).join("task.md");
        originals.push((path.clone(), fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?));
    }

    let write_result = (|| {
        for task in descendants {
            let mut killed = task.clone();
            killed.active_subtask.clear();
            killed.archived = true;
            killed.subtask_outcome = "killed".into();
            write_task_unlocked(repo, &killed)?;
        }
        let mut parent = manager.parent.clone();
        parent.active_subtask.clear();
        write_task_unlocked(repo, &parent)
    })();
    if let Err(error) = write_result {
        restore_task_bytes(&originals);
        return Err(error);
    }
    Ok(())
}

fn rollback_discard_moves(moved: &[(PathBuf, PathBuf)]) {
    for (source, destination) in moved.iter().rev() {
        let _ = fs::rename(destination, source);
    }
}

fn move_if_present(source: PathBuf, destination: PathBuf, moved: &mut Vec<(PathBuf, PathBuf)>) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    fs::rename(&source, &destination).map_err(|e| format!("move {}: {e}", source.display()))?;
    moved.push((source, destination));
    Ok(())
}

pub fn discard_subtask(repo: &Path, owner_task_slug: &str, manager_session_id: &str) -> Result<(), String> {
    with_task_mutation_lock(repo, "discard or kill sub-task", || {
        let DiscardContext { manager, descendants, sessions } = discard_context(repo, owner_task_slug, manager_session_id)?;
        if !manager.meta.subtask_slug.is_empty() {
            return archive_killed_lineage(repo, &manager, &descendants);
        }

        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_nanos()).unwrap_or(0);
        let trash = alinery_dir(repo).join("subtask-trash").join(format!("{manager_session_id}-{stamp}"));
        fs::create_dir_all(&trash).map_err(|e| format!("create {}: {e}", trash.display()))?;
        let mut moved = Vec::new();
        let move_result = (|| {
            for (task_slug, session_id) in &sessions {
                if task_slug != &manager.owner_slug {
                    continue;
                }
                move_if_present(
                    session_meta_path(repo, task_slug, session_id),
                    trash.join("sessions").join(format!("{session_id}.meta.json")),
                    &mut moved,
                )?;
                move_if_present(
                    session_scrollback_path(repo, task_slug, session_id),
                    trash.join("sessions").join(format!("{session_id}.scrollback")),
                    &mut moved,
                )?;
                move_if_present(
                    crate::session_name_path(repo, task_slug, session_id),
                    trash.join("sessions").join(format!("{session_id}.name.json")),
                    &mut moved,
                )?;
            }
            Ok::<(), String>(())
        })();
        if let Err(error) = move_result {
            rollback_discard_moves(&moved);
            let _ = fs::remove_dir_all(&trash);
            return Err(error);
        }
        fs::remove_dir_all(&trash).map_err(|e| format!("remove discarded sub-task setup data {}: {e}", trash.display()))
    })
}

pub fn ensure_task_can_archive(repo: &Path, slug: &str) -> Result<(), String> {
    let task = read_task(repo, slug).ok_or_else(|| format!("no such task: {slug}"))?;
    if !task.active_subtask.is_empty() {
        return Err("task has an active child; finalize the sub-task first".into());
    }
    if !task.parent_task.is_empty() && !task.archived {
        let parent = read_task(repo, &task.parent_task).ok_or_else(|| relationship_error("active child parent is missing"))?;
        if parent.active_subtask == task.slug {
            return Err(format!(
                "This task is still active under “{}”. Open the parent task and use its sub-task manager to finish or kill this task.",
                parent.name
            ));
        }
    }
    Ok(())
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_secs()).unwrap_or(0)
}

pub fn archive_task_guarded(repo: &Path, slug: &str) -> Result<(), String> {
    with_task_mutation_lock(repo, "archive task", || {
        ensure_task_can_archive(repo, slug)?;
        let mut task = read_task(repo, slug).ok_or_else(|| format!("no such task: {slug}"))?;
        task.archived = true;
        write_task_unlocked(repo, &task)
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn repo(name: &str) -> PathBuf {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("alinery-subtask-{name}-{}-{id}", std::process::id()))
    }

    fn task(slug: &str) -> Task {
        Task {
            name: slug.into(),
            slug: slug.into(),
            branch: slug.into(),
            worktree: format!("/tmp/{slug}"),
            has_worktree: true,
            created: 1,
            engine_version: 2,
            playbook_ref: Some(crate::playbook::PlaybookRef {
                scope: crate::playbook::PlaybookScope::Repo,
                key: "subtask-test".into(),
            }),
            ..Default::default()
        }
    }

    fn run_git(path: &Path, args: &[&str]) {
        let output = git_cmd(path).args(args).output().unwrap();
        assert!(output.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&output.stderr));
    }

    fn retained_source() -> &'static str {
        "+++\nversion = 2\nkey = \"subtask-test\"\ntitle = \"Subtask\"\ndescription = \"\"\ndefault_model = \"\"\ndefault_harness = \"omp\"\n[[step]]\nkey = \"left\"\ntitle = \"Left\"\nshort = \"\"\nis_coding_step = false\nauto_advance_default = false\nmodel = \"\"\nharness = \"\"\ninputs = [{path=\"ticket.md\", mode=\"single\"}]\noutputs = [{path=\"left.md\"}]\n[[step]]\nkey = \"right\"\ntitle = \"Right\"\nshort = \"\"\nis_coding_step = false\nauto_advance_default = false\nmodel = \"\"\nharness = \"\"\ninputs = [{path=\"ticket.md\", mode=\"single\"}]\noutputs = [{path=\"right.md\"}]\n+++\n<!-- alinery:step left -->\nInvestigate left.\n<!-- alinery:step right -->\nInvestigate right.\n"
    }

    fn lifecycle_repo(name: &str) -> (PathBuf, Task, SessionMeta) {
        let repo = repo(name);
        fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "user.email", "alinery-tests@example.com"]);
        run_git(&repo, &["config", "user.name", "Alinery Tests"]);
        fs::write(repo.join(".gitignore"), ".alinery/\n").unwrap();
        fs::write(repo.join("seed.txt"), "seed").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["commit", "-m", "seed"]);
        let parent_worktree = worktrees_dir(&repo).join("a");
        fs::create_dir_all(worktrees_dir(&repo)).unwrap();
        let mut add = git_cmd(&repo);
        let output = add.args(["worktree", "add"]).arg(&parent_worktree).args(["-b", "a", "main"]).output().unwrap();
        assert!(output.status.success(), "parent worktree: {}", String::from_utf8_lossy(&output.stderr));

        let mut parent = task("a");
        parent.worktree = parent_worktree.to_string_lossy().into_owned();
        write_task_unlocked(&repo, &parent).unwrap();
        let source = retained_source();
        fs::write(crate::execution::task_playbook_path(&repo, "a").unwrap(), source).unwrap();
        let mut state = crate::execution::new_execution_state(parent.playbook_ref.clone().unwrap(), source, "lane".into(), 10, BTreeSet::new(), Default::default()).unwrap();
        state.creation = "ready".into();
        state.owning_app_config_identity = "config".into();
        crate::execution::write_execution_state_unlocked(&repo, "a", &mut state).unwrap();
        fs::create_dir_all(sessions_dir(&repo, "a")).unwrap();
        let manager = SessionMeta {
            id: "manager".into(),
            worktree: parent.worktree.clone(),
            created: 2,
            harness: "omp".into(),
            generic: true,
            subtask_manager: true,
            ..Default::default()
        };
        write_meta_atomic(&sessions_dir(&repo, "a").join("manager.meta.json"), &serde_json::to_value(&manager).unwrap()).unwrap();
        (repo, parent, manager)
    }

    fn create_input() -> CreateSubtaskInput {
        CreateSubtaskInput {
            manager_session_id: "manager".into(),
            name: "Child B".into(),
            slug: "b".into(),
            instructions: "Investigate the follow-up.".into(),
            ..Default::default()
        }
    }
    #[test]
    fn subtask_relationship_validation_accepts_nesting_and_archived_history() {
        let mut a = task("a");
        let mut b = task("b");
        let mut c = task("c");
        a.active_subtask = "b".into();
        b.parent_task = "a".into();
        b.active_subtask = "c".into();
        c.parent_task = "b".into();
        validate_task_relationships(&[a.clone(), b.clone(), c]).unwrap();

        a.active_subtask.clear();
        b.active_subtask.clear();
        b.archived = true;
        validate_task_relationships(&[a, b]).unwrap();
    }

    #[test]
    fn subtask_relationship_validation_rejects_mismatch_archive_and_cycles() {
        let mut a = task("a");
        let mut b = task("b");
        a.active_subtask = "b".into();
        b.parent_task = "wrong".into();
        assert!(validate_task_relationships(&[a.clone(), b.clone()]).unwrap_err().contains(RELATIONSHIP_ERROR));
        b.parent_task = "a".into();
        b.archived = true;
        assert!(validate_task_relationships(&[a.clone(), b.clone()]).unwrap_err().contains("archived"));
        b.archived = false;
        b.active_subtask = "a".into();
        a.parent_task = "b".into();
        assert!(validate_task_relationships(&[a, b]).unwrap_err().contains("cycle"));
    }

    #[test]
    fn subtask_creation_rejects_dirty_parent_without_moving_changes() {
        let (repo, parent, _) = lifecycle_repo("dirty-parent-create");
        let parent_marker = Path::new(&parent.worktree).join("uncommitted-parent.txt");
        fs::write(&parent_marker, b"parent-only").unwrap();
        assert!(create_subtask(&repo, "lane", "config", create_input()).is_err());
        assert_eq!(fs::read(&parent_marker).unwrap(), b"parent-only");
        assert!(read_task(&repo, &parent.slug).unwrap().active_subtask.is_empty());
        assert!(!task_dir(&repo, "b").exists());
        assert!(!worktrees_dir(&repo).join("b").exists());
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn subtask_creation_inspection_and_integrated_finalize_follow_git_invariants() {
        let (repo, parent, _) = lifecycle_repo("lifecycle");
        let created = create_subtask(&repo, "lane", "config", create_input()).unwrap();
        assert_eq!(created.parent_task.slug, "a");
        assert_eq!(created.child_task.as_ref().unwrap().slug, "b");
        assert_eq!(created.manager_session.subtask_slug, "b");
        let child = read_task(&repo, "b").unwrap();
        assert_eq!(child.parent_task, "a");
        assert!(child.active_subtask.is_empty());
        assert!(child.linear_id.is_empty() && child.github_issue.is_empty() && child.pr_url.is_empty() && child.requested_slug.is_empty());
        assert_eq!(read_task(&repo, "a").unwrap().active_subtask, "b");
        assert_eq!(created.provisioning.creation, "ready");
        let mut state = crate::execution::read_execution_state(&repo, "b").unwrap();
        let definition = crate::execution::read_task_playbook(&repo, "b", &state).unwrap();
        let roots = crate::playbook_scheduler::reconcile_graph(&definition, &mut state).unwrap();
        assert_eq!(roots.iter().map(|root| root.step_key.as_str()).collect::<BTreeSet<_>>(), BTreeSet::from(["left", "right"]));
        assert_eq!(fs::read(crate::execution::task_playbook_path(&repo, "b").unwrap()).unwrap(), retained_source().as_bytes());
        assert!(fs::read_to_string(artifacts_dir(&repo, "b").join("00-ticket.md"))
            .unwrap()
            .contains("Investigate the follow-up."));
        let child_head = {
            let mut command = git_cmd(&child.worktree);
            let output = command.args(["rev-parse", "HEAD"]).output().unwrap();
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        };
        let parent_head = {
            let mut command = git_cmd(&parent.worktree);
            let output = command.args(["rev-parse", "HEAD"]).output().unwrap();
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        };
        assert_eq!(child_head, parent_head, "child must start from parent.branch");

        let initial = inspect_subtask_finish(&repo, "manager", vec!["manager".into(), "other".into(), "other".into()]).unwrap();
        assert!(initial.allowed_modes.contains(&FinalizeMode::ArtifactsOnly));
        assert!(initial.allowed_modes.contains(&FinalizeMode::IntegratedCode));
        assert_eq!(initial.observed_live_parent_sessions, vec!["other"]);

        let mut child_with_grandchild = read_task(&repo, "b").unwrap();
        child_with_grandchild.active_subtask = "c".into();
        let mut grandchild = task("c");
        grandchild.parent_task = "b".into();
        write_task_unlocked(&repo, &child_with_grandchild).unwrap();
        write_task_unlocked(&repo, &grandchild).unwrap();
        let nested = inspect_subtask_finish(&repo, "manager", Vec::new()).unwrap();
        assert!(nested.allowed_modes.is_empty());
        child_with_grandchild.active_subtask.clear();
        write_task_unlocked(&repo, &child_with_grandchild).unwrap();
        fs::remove_dir_all(task_dir(&repo, "c")).unwrap();

        fs::write(Path::new(&child.worktree).join("code.txt"), "dirty").unwrap();
        let dirty = inspect_subtask_finish(&repo, "manager", Vec::new()).unwrap();
        assert!(!dirty.allowed_modes.contains(&FinalizeMode::ArtifactsOnly));
        assert!(!dirty.allowed_modes.contains(&FinalizeMode::IntegratedCode));
        assert!(dirty.allowed_modes.contains(&FinalizeMode::ArchiveWithoutCode));
        run_git(Path::new(&child.worktree), &["add", "code.txt"]);
        run_git(Path::new(&child.worktree), &["commit", "-m", "child code"]);
        let committed = inspect_subtask_finish(&repo, "manager", Vec::new()).unwrap();
        assert_eq!(committed.code_state.child_only_commits, 1);
        assert!(!committed.allowed_modes.contains(&FinalizeMode::IntegratedCode));

        run_git(Path::new(&parent.worktree), &["merge", "--no-ff", "b", "-m", "integrate b"]);
        let integrated = inspect_subtask_finish(&repo, "manager", Vec::new()).unwrap();
        assert!(integrated.code_state.child_head_contained);
        assert!(integrated.allowed_modes.contains(&FinalizeMode::IntegratedCode));
        let result = finalize_subtask(&repo, "manager", FinalizeMode::IntegratedCode).unwrap();
        assert!(result.archived_child.archived);
        assert_eq!(result.archived_child.subtask_outcome, "merged");
        assert!(read_task(&repo, "a").unwrap().active_subtask.is_empty());
        let archived_child = read_task(&repo, "b").unwrap();
        assert!(archived_child.archived);
        assert_eq!(archived_child.subtask_outcome, "merged");
        assert!(Path::new(&result.snapshot_path).join("provenance.toml").is_file());
        assert!(Path::new(&child.worktree).is_dir(), "finalize preserves the child worktree");
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn subtask_finish_rejects_worktrees_on_unrecorded_or_detached_branches() {
        let (repo, parent, _) = lifecycle_repo("finish-branch-identity");
        create_subtask(&repo, "lane", "config", create_input()).unwrap();
        let child = read_task(&repo, "b").unwrap();
        let child_worktree = Path::new(&child.worktree);
        let parent_worktree = Path::new(&parent.worktree);

        run_git(child_worktree, &["switch", "-c", "unrecorded-child"]);
        fs::write(child_worktree.join("stranded.txt"), "stranded").unwrap();
        run_git(child_worktree, &["add", "stranded.txt"]);
        run_git(child_worktree, &["commit", "-m", "stranded child code"]);
        let child_error = inspect_subtask_finish(&repo, "manager", Vec::new()).unwrap_err();
        assert!(child_error.contains("child worktree is on branch 'unrecorded-child'; expected 'b'"));
        for mode in [FinalizeMode::ArtifactsOnly, FinalizeMode::IntegratedCode, FinalizeMode::ArchiveWithoutCode] {
            assert!(finalize_subtask(&repo, "manager", mode).unwrap_err().contains("child worktree is on branch"));
        }

        run_git(child_worktree, &["switch", "b"]);
        run_git(child_worktree, &["switch", "--detach"]);
        assert!(inspect_subtask_finish(&repo, "manager", Vec::new())
            .unwrap_err()
            .contains("child worktree HEAD is detached"));
        run_git(child_worktree, &["switch", "b"]);

        run_git(parent_worktree, &["switch", "-c", "unrecorded-parent"]);
        let parent_error = inspect_subtask_finish(&repo, "manager", Vec::new()).unwrap_err();
        assert!(parent_error.contains("parent worktree is on branch 'unrecorded-parent'; expected 'a'"));
        for mode in [FinalizeMode::ArtifactsOnly, FinalizeMode::IntegratedCode, FinalizeMode::ArchiveWithoutCode] {
            assert!(finalize_subtask(&repo, "manager", mode).unwrap_err().contains("parent worktree is on branch"));
        }

        run_git(parent_worktree, &["switch", "a"]);
        assert!(inspect_subtask_finish(&repo, "manager", Vec::new()).is_ok());
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn non_integrated_finalize_modes_persist_finished_outcome() {
        for (name, mode) in [("artifacts-only", FinalizeMode::ArtifactsOnly), ("archive-without-code", FinalizeMode::ArchiveWithoutCode)] {
            let (repo, _, _) = lifecycle_repo(name);
            create_subtask(&repo, "lane", "config", create_input()).unwrap();
            let result = finalize_subtask(&repo, "manager", mode).unwrap();
            assert_eq!(result.archived_child.subtask_outcome, "finished");
            assert_eq!(read_task(&repo, "b").unwrap().subtask_outcome, "finished");
            let _ = fs::remove_dir_all(repo);
        }
    }

    #[test]
    fn subtask_creation_rejects_bound_manager_and_exact_slug_collisions() {
        let (repo, _, _) = lifecycle_repo("creation-exclusion");
        fs::create_dir_all(task_dir(&repo, "b")).unwrap();
        assert!(create_subtask(&repo, "lane", "config", create_input()).is_err());
        assert!(!task_dir(&repo, "b-2").exists());
        fs::remove_dir(task_dir(&repo, "b")).unwrap();
        create_subtask(&repo, "lane", "config", create_input()).unwrap();
        let mut another = create_input();
        another.slug = "c".into();
        assert!(create_subtask(&repo, "lane", "config", another).is_err());
        assert!(!task_dir(&repo, "c").exists());
        assert_eq!(read_task(&repo, "a").unwrap().active_subtask, "b");
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn subtask_partial_git_creation_preserves_worktree_and_relationships() {
        use std::os::unix::fs::PermissionsExt;
        let (repo, _, _) = lifecycle_repo("partial-git");
        let hook = repo.join(".git/hooks/post-checkout");
        fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        let result = create_subtask(&repo, "lane", "config", create_input()).unwrap();
        assert_eq!(result.provisioning.creation, "partial");
        assert!(result.provisioning.errors.iter().any(|error| error.stage == "git_worktree"));
        let child = result.child_task.unwrap();
        assert_eq!(child.slug, "b");
        assert!(Path::new(&child.worktree).is_dir());
        assert!(ref_exists(&repo, "b"));
        assert_eq!(read_task(&repo, &result.parent_task.slug).unwrap().active_subtask, "b");
        assert_eq!(result.manager_session.subtask_slug, "b");
        assert_eq!(crate::execution::read_execution_state(&repo, "b").unwrap().creation, "partial");
        assert!(create_subtask(&repo, "lane", "config", create_input()).is_err());
        validate_task_relationships(&load_relationship_tasks(&repo).unwrap()).unwrap();
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn discard_unbound_subtask_manager_removes_its_session_only() {
        let (repo, _, manager) = lifecycle_repo("discard-setup");
        let scrollback = session_scrollback_path(&repo, "a", &manager.id);
        fs::write(&scrollback, b"expired login").unwrap();
        crate::set_session_name(&repo, "a", &manager.id, "Plan child work", crate::SessionNameSource::User).unwrap();
        let name_path = crate::session_name_path(&repo, "a", &manager.id);

        assert_eq!(subtask_discard_sessions(&repo, "a", "manager").unwrap(), vec![("a".into(), "manager".into())]);
        discard_subtask(&repo, "a", "manager").unwrap();

        assert!(read_task(&repo, "a").is_some());
        assert!(!session_meta_path(&repo, "a", "manager").exists());
        assert!(!scrollback.exists());
        assert!(!name_path.exists(), "discard must remove the manager's name sidecar");
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn killing_bound_subtask_archives_active_lineage_and_preserves_its_record() {
        let (repo, _, _) = lifecycle_repo("kill-lineage");
        create_subtask(&repo, "lane", "config", create_input()).unwrap();
        let child = read_task(&repo, "b").unwrap();
        let nested_manager = SessionMeta {
            id: "manager-b".into(),
            worktree: child.worktree.clone(),
            created: 3,
            harness: "omp".into(),
            generic: true,
            subtask_manager: true,
            ..Default::default()
        };
        write_meta_atomic(&session_meta_path(&repo, "b", "manager-b"), &serde_json::to_value(&nested_manager).unwrap()).unwrap();
        create_subtask(
            &repo,
            "lane",
            "config",
            CreateSubtaskInput {
                manager_session_id: "manager-b".into(),
                name: "Grandchild C".into(),
                slug: "c".into(),
                instructions: String::new(),
                ..Default::default()
            },
        )
        .unwrap();
        let grandchild = read_task(&repo, "c").unwrap();
        let ordinary = SessionMeta {
            id: "child-session".into(),
            worktree: grandchild.worktree.clone(),
            created: 4,
            harness: "omp".into(),
            generic: true,
            ..Default::default()
        };
        write_meta_atomic(&session_meta_path(&repo, "c", "child-session"), &serde_json::to_value(&ordinary).unwrap()).unwrap();

        let mut finished = task("d");
        finished.parent_task = "b".into();
        finished.archived = true;
        finished.subtask_outcome = "finished".into();
        finished.has_worktree = false;
        finished.worktree.clear();
        write_task_unlocked(&repo, &finished).unwrap();
        fs::write(Path::new(&child.worktree).join("dirty-parent"), b"dirty").unwrap();
        fs::write(Path::new(&grandchild.worktree).join("dirty-child"), b"dirty").unwrap();
        fs::write(artifacts_dir(&repo, "b").join("01-result.md"), b"result").unwrap();

        let planned = subtask_discard_sessions(&repo, "a", "manager").unwrap();
        assert!(planned.contains(&("a".into(), "manager".into())));
        assert!(planned.contains(&("b".into(), "manager-b".into())));
        assert!(planned.contains(&("c".into(), "child-session".into())));
        discard_subtask(&repo, "a", "manager").unwrap();

        assert!(read_task(&repo, "a").unwrap().active_subtask.is_empty());
        for slug in ["b", "c"] {
            let killed = read_task(&repo, slug).unwrap();
            assert!(killed.archived, "{slug} stayed active");
            assert!(killed.active_subtask.is_empty(), "{slug} retained an active child pointer");
            assert_eq!(killed.subtask_outcome, "killed");
            assert!(worktrees_dir(&repo).join(slug).is_dir(), "{slug} worktree was deleted");
            let mut show = git_cmd(&repo);
            assert!(show.args(["show-ref", "--verify", "--quiet", &format!("refs/heads/{slug}")]).status().unwrap().success());
        }
        assert_eq!(read_task(&repo, "d").unwrap().subtask_outcome, "finished");
        assert!(session_meta_path(&repo, "a", "manager").is_file());
        assert!(session_meta_path(&repo, "b", "manager-b").is_file());
        assert!(session_meta_path(&repo, "c", "child-session").is_file());
        assert!(Path::new(&child.worktree).join("dirty-parent").is_file());
        assert!(Path::new(&grandchild.worktree).join("dirty-child").is_file());
        assert!(artifacts_dir(&repo, "b").join("01-result.md").is_file());
        validate_task_relationships(&load_relationship_tasks(&repo).unwrap()).unwrap();
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn subtask_snapshot_rejects_symlinks_and_preserves_nested_bytes() {
        use std::os::unix::fs::symlink;

        let snapshot_repo = repo("snapshot");
        let parent = task("a");
        let mut child = task("b");
        child.parent_task = "a".into();
        fs::create_dir_all(artifacts_dir(&snapshot_repo, "b").join("attachments")).unwrap();
        fs::create_dir_all(artifacts_dir(&snapshot_repo, "b").join("subtasks/c")).unwrap();
        fs::write(artifacts_dir(&snapshot_repo, "b").join("01.md"), b"one").unwrap();
        fs::write(artifacts_dir(&snapshot_repo, "b").join("attachments/x.bin"), [0, 1, 2]).unwrap();
        fs::write(artifacts_dir(&snapshot_repo, "b").join("subtasks/c/nested.md"), b"nested").unwrap();
        let snapshot = install_snapshot(&snapshot_repo, &parent, &child).unwrap();
        assert_eq!(fs::read(snapshot.join("attachments/x.bin")).unwrap(), vec![0, 1, 2]);
        assert_eq!(fs::read_to_string(snapshot.join("subtasks/c/nested.md")).unwrap(), "nested");
        assert!(reusable_snapshot(&snapshot, &child));
        let different = SnapshotProvenance {
            child_slug: "b".into(),
            branch: "different".into(),
            snapshot_time: 1,
        };
        fs::write(snapshot.join("provenance.toml"), toml::to_string(&different).unwrap()).unwrap();
        assert!(install_snapshot(&snapshot_repo, &parent, &child).unwrap_err().contains("different provenance"));
        assert_eq!(fs::read_to_string(snapshot.join("01.md")).unwrap(), "one");
        let other_repo = repo("snapshot-symlink");
        fs::create_dir_all(artifacts_dir(&other_repo, "b")).unwrap();
        fs::write(other_repo.join("outside"), "outside").unwrap();
        symlink(other_repo.join("outside"), artifacts_dir(&other_repo, "b").join("link")).unwrap();
        assert!(install_snapshot(&other_repo, &parent, &child).unwrap_err().contains("symlink"));
        assert!(!subtask_snapshot_dir(&other_repo, "a", "b").exists());
        let _ = fs::remove_dir_all(snapshot_repo);
        let _ = fs::remove_dir_all(other_repo);
    }

    #[test]
    fn subtask_generic_archive_guard_blocks_both_active_ends() {
        let repo = repo("archive-guard");
        let mut parent = task("a");
        let mut child = task("b");
        parent.active_subtask = "b".into();
        child.parent_task = "a".into();
        write_task_unlocked(&repo, &parent).unwrap();
        write_task_unlocked(&repo, &child).unwrap();
        assert!(archive_task_guarded(&repo, "a").is_err());
        assert!(archive_task_guarded(&repo, "b").is_err());
        let mut unrelated = task("u");
        unrelated.parent_task.clear();
        write_task_unlocked(&repo, &unrelated).unwrap();
        archive_task_guarded(&repo, "u").unwrap();
        assert!(read_task(&repo, "u").unwrap().archived);
        let _ = fs::remove_dir_all(repo);
    }
}
