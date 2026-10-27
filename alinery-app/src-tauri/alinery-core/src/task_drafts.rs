//! Task drafts: the half-written task a person autosaves before creating it. A draft is files only
//! (`task.md`, a ticket artifact, an attachments file), so a remote host writes it with the same
//! code a local repo uses.
use crate::task_creation::{MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_SET_BYTES};
use crate::{artifacts_dir, task_dir, tasks_dir, worktrees_dir, write_bytes_atomic, write_task_unlocked, Task};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn read_task(repo: &Path, slug: &str) -> Result<Task, String> {
    crate::board::read_task_checked(repo, slug)
}

// kebab-case: lowercase alnum runs joined by single dashes, no leading/trailing dash.
pub fn slugify(name: &str) -> String {
    let mut s = String::new();
    let mut prev_dash = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !s.is_empty() && !prev_dash {
            s.push('-');
            prev_dash = true;
        }
    }
    let s = s.trim_end_matches('-').to_string();
    if s.is_empty() {
        "task".to_string()
    } else {
        s
    }
}

pub fn branch_ref_conflicts(repo: &Path, candidate: &str) -> bool {
    let Ok(out) = crate::git_cmd(repo).args(["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"]).output() else {
        return false;
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .any(|existing| crate::branch_names_conflict(existing, candidate))
}

// Dedupe so dir, branch, and worktree path are all unique (-2, -3, …). `git
// worktree add -b` fails if the branch OR path already exists — check all three.
pub fn unique_slug(repo: &Path, base: &str) -> String {
    unique_slug_except(repo, base, "")
}

pub fn unique_slug_except(repo: &Path, base: &str, except: &str) -> String {
    let mut slug = base.to_string();
    let mut n = 2;
    while (task_dir(repo, &slug).exists() && slug != except) || worktrees_dir(repo).join(&slug).exists() || branch_ref_conflicts(repo, &slug) {
        slug = format!("{base}-{n}");
        n += 1;
    }
    slug
}

// Archived drafts require explicit restore. Autosave and create must treat their slugs as occupied.
pub fn is_reusable_draft(task: &Task) -> bool {
    task.draft && !task.archived
}

pub fn latest_draft_slug_with_name(repo: &Path, name: &str) -> Option<String> {
    let mut best: Option<(u64, String)> = None;
    let entries = fs::read_dir(tasks_dir(repo)).ok()?;
    for entry in entries.flatten() {
        if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }
        let slug = entry.file_name().to_string_lossy().to_string();
        let Ok(task) = read_task(repo, &slug) else {
            continue;
        };
        if !is_reusable_draft(&task) || task.name != name {
            continue;
        }
        if best
            .as_ref()
            .map(|(created, best_slug)| task.created > *created || (task.created == *created && slug > *best_slug))
            .unwrap_or(true)
        {
            best = Some((task.created, slug));
        }
    }
    best.map(|(_, slug)| slug)
}

pub fn draft_slug_for_name(repo: &Path, base: &str, name: &str) -> String {
    match read_task(repo, base) {
        Ok(t) if is_reusable_draft(&t) => base.to_string(),
        Ok(_) => latest_draft_slug_with_name(repo, name).unwrap_or_else(|| unique_slug(repo, base)),
        Err(_) if task_dir(repo, base).exists() => latest_draft_slug_with_name(repo, name).unwrap_or_else(|| unique_slug(repo, base)),
        Err(_) => latest_draft_slug_with_name(repo, name).unwrap_or_else(|| base.to_string()),
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftAttachments {
    pub entries: Vec<String>,
    pub images: Vec<DraftImage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftImage {
    pub name: String,
    #[serde(with = "crate::rpc_chunk::base64_bytes")]
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

pub fn validate_draft_attachments(attachments: &DraftAttachments) -> Result<(), String> {
    let mut total = 0;
    for image in &attachments.images {
        crate::safe_component(&image.name).ok_or_else(|| format!("invalid attachment name: {}", image.name))?;
        let len = image.bytes.len() as u64;
        if len > MAX_ATTACHMENT_BYTES {
            return Err(format!("{} — larger than 25 MB", image.name));
        }
        if len > MAX_ATTACHMENT_SET_BYTES - total {
            return Err("attachment set would exceed 100 MB".into());
        }
        total += len;
    }
    Ok(())
}

pub fn read_draft_attachments_in(repo: &Path, slug: &str) -> Result<DraftAttachments, String> {
    let slug = crate::safe_component(slug).ok_or("invalid draft slug")?;
    read_task(repo, slug)?;
    let path = task_dir(repo, slug).join("draft-attachments.json");
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(DraftAttachments::default()),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let attachments = serde_json::from_slice(&bytes).map_err(|error| format!("read {}: {error}", path.display()))?;
    validate_draft_attachments(&attachments)?;
    Ok(attachments)
}

pub fn write_draft_in_with_slug(
    repo: &Path,
    app_config: Option<&Path>,
    draft_slug: &str,
    task_slug: &str,
    name: String,
    description: String,
    evidence: String,
    linear_id: String,
    github_issue: String,
    playbook: crate::playbook::PlaybookRef,
    harness: String,
    model: String,
    auto_advance: Option<Vec<String>>,
    step_models: Option<std::collections::BTreeMap<String, String>>,
    max_live_sessions: u32,
    branch_name: String,
    worktree_name: String,
    draft_base_ref: Option<String>,
    draft_attachments: Option<DraftAttachments>,
) -> Result<Task, String> {
    crate::with_task_mutation_lock_waiting(repo, "write draft", crate::TASK_MUTATION_CONTENTION_WAIT, || {
        write_draft_in_with_slug_unlocked(
            repo,
            app_config,
            draft_slug,
            task_slug,
            name,
            description,
            evidence,
            linear_id,
            github_issue,
            playbook,
            harness,
            model,
            auto_advance,
            step_models,
            max_live_sessions,
            branch_name,
            worktree_name,
            draft_base_ref,
            draft_attachments,
        )
    })
}

pub fn write_draft_in_with_slug_unlocked(
    repo: &Path,
    app_config: Option<&Path>,
    draft_slug: &str,
    task_slug: &str,
    name: String,
    description: String,
    evidence: String,
    linear_id: String,
    github_issue: String,
    playbook: crate::playbook::PlaybookRef,
    harness: String,
    model: String,
    auto_advance: Option<Vec<String>>,
    step_models: Option<std::collections::BTreeMap<String, String>>,
    max_live_sessions: u32,
    branch_name: String,
    worktree_name: String,
    draft_base_ref: Option<String>,
    draft_attachments: Option<DraftAttachments>,
) -> Result<Task, String> {
    if max_live_sessions == 0 {
        return Err("maximum live sessions must be positive".into());
    }
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("task name is empty".into());
    }
    let base = slugify(&name);
    if base.is_empty() {
        return Err("task name is empty".into());
    }
    let requested_draft = draft_slug.trim();
    let slug = if requested_draft.is_empty() {
        draft_slug_for_name(repo, &base, &name)
    } else {
        let requested_draft = crate::safe_component(requested_draft).ok_or_else(|| "invalid draft slug".to_string())?;
        match read_task(repo, requested_draft) {
            Ok(t) if is_reusable_draft(&t) => requested_draft.to_string(),
            Ok(_) => return Err("draft is archived or has already been promoted".into()),
            Err(error) => return Err(error),
        }
    };

    if let Some(attachments) = &draft_attachments {
        validate_draft_attachments(attachments)?;
    }
    fs::create_dir_all(tasks_dir(repo)).map_err(|e| e.to_string())?;
    fs::create_dir_all(task_dir(repo, &slug)).map_err(|e| e.to_string())?;

    let previous = read_task(repo, &slug).ok();
    let requested_slug = if task_slug.trim().is_empty() {
        previous
            .as_ref()
            .map(|task| task.requested_slug.clone())
            .filter(|slug| !slug.is_empty())
            .unwrap_or_else(|| slugify(&name))
    } else {
        let normalized = slugify(task_slug.trim());
        if normalized != task_slug.trim() {
            return Err("task slug must use lowercase letters, numbers, and single dashes".into());
        }
        normalized
    };
    let created = previous.as_ref().map(|t| t.created).unwrap_or_else(now_secs);
    let branch = branch_name.trim().to_string();
    let worktree = worktree_name.trim().to_string();
    let task = Task {
        name: name.clone(),
        slug: slug.clone(),
        requested_slug,
        branch,
        worktree,
        has_worktree: true,
        created,
        archived: false,
        pr_url: String::new(),
        linear_id: linear_id.trim().to_string(),
        github_issue: github_issue.trim().to_string(),
        playbook: String::new(),
        playbook_ref: Some(playbook.clone()),
        engine_version: 0,
        max_live_sessions,
        launch_defaults: crate::execution::LaunchChoices { harness, model },
        auto_advance: auto_advance.unwrap_or_default(),
        auto_approve_all: false,
        step_models: step_models
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(key, value)| {
                let trimmed = value.trim();
                (!trimmed.is_empty()).then(|| (key, trimmed.to_string()))
            })
            .collect(),
        draft: true,
        draft_base_ref,
        parent_task: String::new(),
        active_subtask: String::new(),
        subtask_outcome: String::new(),
        related_tasks: Vec::new(),
        telemetry_id: previous
            .as_ref()
            .map(|task| task.telemetry_id.clone())
            .filter(|id| !id.is_empty())
            .unwrap_or_else(crate::new_telemetry_id),
    };
    write_task_unlocked(repo, &task)?;
    if previous.is_none() {
        if let Some(path) = app_config {
            crate::record_event(
                path,
                crate::TelemetryEvent::TaskDraftCreate {
                    source: crate::TelemetrySource::App,
                    has_worktree: true,
                    playbook: playbook.key,
                    task_id: task.telemetry_id.clone(),
                },
            );
        }
    }

    let ticket = crate::compose_ticket(&name, &description, &evidence, &[], &[], &[]);
    if !ticket.is_empty() {
        fs::create_dir_all(artifacts_dir(repo, &slug)).map_err(|e| e.to_string())?;
        let path = artifacts_dir(repo, &slug).join("00-ticket.md");
        if fs::read_to_string(&path).ok().as_deref() != Some(ticket.as_str()) {
            write_bytes_atomic(&path, ticket.as_bytes())?;
        }
    }
    if let Some(attachments) = draft_attachments {
        let bytes = serde_json::to_vec(&attachments).map_err(|error| error.to_string())?;
        write_bytes_atomic(&task_dir(repo, &slug).join("draft-attachments.json"), &bytes)?;
    }
    Ok(task)
}

// M6: remove a draft task directory entirely (archive is insufficient — leaves task.md).
pub fn delete_draft_in(repo: &Path, app_config: Option<&Path>, slug: &str) -> Result<(), String> {
    // Eager on purpose: the read must happen before the directory is removed below, so this one
    // cannot be deferred into the emit closure the way the other id lookups are.
    let telemetry_id = crate::telemetry_id_for_task(repo, slug);
    crate::with_task_mutation_lock_waiting(repo, "delete draft", crate::TASK_MUTATION_CONTENTION_WAIT, || {
        let task = read_task(repo, slug)?;
        if !task.draft {
            return Err("not a draft".into());
        }
        let dir = task_dir(repo, slug);
        fs::remove_dir_all(&dir).map_err(|e| format!("remove draft {}: {e}", dir.display()))
    })?;
    if let Some(path) = app_config {
        crate::record_event(
            path,
            crate::TelemetryEvent::TaskDraftDelete {
                source: crate::TelemetrySource::App,
                task_id: telemetry_id,
            },
        );
    }
    Ok(())
}
