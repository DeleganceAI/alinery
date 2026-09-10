//! task: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

// task.md is pure TOML (frontmatter only, no body in M2 — kickoff blesses this).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct Task {
    pub(crate) name: String,
    pub(crate) slug: String,
    // Final user-visible slug requested on the create page while this row is still a draft.
    // The draft's own `slug` remains its stable storage key until promotion.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) requested_slug: String,
    pub(crate) branch: String,
    // M5: cleared to "" by remove_worktree (the worktree is gone — the UI then hides the
    // create-session controls). Every other field survives worktree removal.
    pub(crate) worktree: String,
    // false when the task opted out of a dedicated worktree at creation — `worktree` then
    // holds the main repo path instead of "" so cwd-consuming code paths are unaffected.
    // #[serde(default = ...)] so pre-existing task.md (all of which had a real worktree)
    // still parses.
    #[serde(default = "default_has_worktree")]
    pub(crate) has_worktree: bool,
    pub(crate) created: u64,
    #[serde(default)]
    pub(crate) archived: bool,
    // M5: prefilled with the forge compare URL on push, hand-editable to the real PR URL
    // once created; shown as a clickable/copyable link. #[serde(default)] so pre-M5 task.md
    // (no pr_url) still parses.
    #[serde(default)]
    pub(crate) pr_url: String,
    // M5: the Linear identifier (e.g. "ENG-123") when a task was imported from Linear; ""
    // for inline tasks. Import-only in v1 (no status write-back).
    #[serde(default)]
    pub(crate) linear_id: String,
    // GitHub issue reference ("owner/repo#123") when imported from GitHub; "" otherwise.
    #[serde(default)]
    pub(crate) github_issue: String,
    #[serde(default)]
    pub(crate) playbook: String,
    #[serde(default)]
    pub(crate) auto_advance: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) parent_task: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) active_subtask: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) subtask_outcome: String,
    // M6: true while CreateTaskPage is still drafting (no worktree/session yet).
    // #[serde(default)] so pre-M6 task.md still parses as non-draft.
    #[serde(default)]
    pub(crate) draft: bool,
    // Cross-repo (or same-repo) related-task tags. Empty omitted so pre-existing task.md
    // still parses. Pair with artifacts/related/<link> directory symlinks.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) related_tasks: Vec<alinery_core::RelatedTaskRef>,
    // Anonymous telemetry correlation id; rationale at new_telemetry_id() in alinery-core/src/types.rs.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) telemetry_id: String,
}

#[derive(Serialize, Clone)]
pub(crate) struct BoardTask {
    #[serde(flatten)]
    pub(crate) task: Task,
    pub(crate) repo_path: String,
    pub(crate) session_count: usize,
    pub(crate) playbook_title: String,
    pub(crate) updated: u64,
    pub(crate) current_phase: String,
    pub(crate) current_step_title: String,
    pub(crate) latest_session_title: String,
    pub(crate) latest_session_column_key: String,
    pub(crate) current_column_key: String,
    pub(crate) current_column_title: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskActivityRef {
    pub(crate) repo_path: String,
    pub(crate) task_slug: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct TaskActivitySession {
    pub(crate) id: String,
    pub(crate) worktree: String,
    pub(crate) phase: String,
    pub(crate) harness: String,
    pub(crate) model: String,
    pub(crate) playbook: String,
    pub(crate) generic: bool,
    pub(crate) step_title: String,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskActivityStatus {
    Running,
    WaitingForInput,
    WaitingForApproval,
    Failed,
    Completed,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct TaskActivitySummary {
    pub(crate) status: Option<TaskActivityStatus>,
    pub(crate) active_session: Option<TaskActivitySession>,
}

pub(crate) fn task_activity_key(repo_path: &str, slug: &str) -> String {
    format!("{repo_path}:{slug}")
}

pub(crate) fn branch_ref_conflicts(repo: &Path, candidate: &str) -> bool {
    let Ok(out) = git_cmd(repo).args(["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"]).output() else {
        return false;
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .any(|existing| existing == candidate || existing.starts_with(&format!("{candidate}/")) || candidate.starts_with(&format!("{existing}/")))
}

// Never reuse/check out an existing branch, including Git's `fix` vs `fix/...` ref collision.
pub(crate) fn dedupe_branch_name(repo: &Path, base: &str) -> String {
    let mut name = base.to_string();
    let mut n = 2;
    while branch_ref_conflicts(repo, &name) {
        name = format!("{base}-{n}");
        n += 1;
    }
    name
}

// Same idea for the worktree directory leaf name.
pub(crate) fn dedupe_worktree_name(repo: &Path, base: &str) -> String {
    let mut name = base.to_string();
    let mut n = 2;
    while worktrees_dir(repo).join(&name).exists() {
        name = format!("{base}-{n}");
        n += 1;
    }
    name
}

// Dedupe so dir, branch, and worktree path are all unique (-2, -3, …). `git
// worktree add -b` fails if the branch OR path already exists — check all three.
pub(crate) fn unique_slug(repo: &Path, base: &str) -> String {
    unique_slug_except(repo, base, "")
}

pub(crate) fn unique_slug_except(repo: &Path, base: &str, except: &str) -> String {
    let mut slug = base.to_string();
    let mut n = 2;
    while (task_dir(repo, &slug).exists() && slug != except) || worktrees_dir(repo).join(&slug).exists() || branch_ref_conflicts(repo, &slug) {
        slug = format!("{base}-{n}");
        n += 1;
    }
    slug
}

pub(crate) fn read_task(repo: &Path, slug: &str) -> Result<Task, String> {
    let p = task_dir(repo, slug).join("task.md");
    let s = fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))?;
    toml::from_str(&s).map_err(|e| format!("parse {}: {e}", p.display()))
}

// Ok(None): task.md missing (deleted, or never existed) — a drop-in for today's `?? null`.
// Err: task.md exists but will not parse — a real fault, not "no task." Neither existing
// read_task has this split (task.rs:133 errors on both; alinery-core/src/task.rs:25 returns
// None for both), so this needs its own thin body rather than reuse of either.
pub(crate) fn read_task_opt(repo: &Path, slug: &str) -> Result<Option<Task>, String> {
    let p = task_dir(repo, slug).join("task.md");
    match fs::read_to_string(&p) {
        Ok(s) => toml::from_str(&s).map(Some).map_err(|e| format!("parse {}: {e}", p.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", p.display())),
    }
}

// task.rs — mirrors the playbook.rs:56-58 twin template; TaskDetail makes zero ipc calls with
// the repoPath prop it receives, so this stays active-repo-implicit with no `_for_repo` twin.
#[tauri::command]
pub(crate) async fn get_task(slug: String) -> Result<Option<Task>, String> {
    read_task_opt(&active_repo()?, &slug)
}
pub(crate) fn write_task(repo: &Path, task: &Task) -> Result<(), String> {
    alinery_core::with_task_mutation_lock(repo, "write task", || write_task_unlocked(repo, task))
}

pub(crate) fn write_task_unlocked(repo: &Path, task: &Task) -> Result<(), String> {
    let p = task_dir(repo, &task.slug).join("task.md");
    let s = toml::to_string(task).map_err(|e| e.to_string())?;
    write_bytes_atomic(&p, s.as_bytes()).map_err(|e| format!("write {}: {e}", p.display()))
}

// M0: prove one JS -> Rust -> JS command round-trip.
#[tauri::command]
pub(crate) fn ping(name: &str) -> String {
    format!("pong: {name}")
}

#[derive(Serialize)]
pub(crate) struct CreateTaskResult {
    pub(crate) task: Task,
    pub(crate) session: SessionMeta,
    pub(crate) attachment_errors: Vec<String>,
}

#[derive(Serialize)]
pub(crate) struct AutoAdvanceSummary {
    pub(crate) key: String,
    pub(crate) title: String,
    pub(crate) from: String,
    pub(crate) to: String,
    pub(crate) default_enabled: bool,
}

// Create a task: slug+dedupe, mkdir task dir, always fork a branch (`-b`), and — when
// `use_worktree` is true — a dedicated worktree checkout too; when false, the branch is
// checked out directly in the main repo (switching its active branch immediately).
// `description` is the human's feature ask — the "ticket". Stashed as artifacts/00-ticket.md
// so EVERY phase session (research-questions included) can read the original impetus from
// {{ARTIFACTS_DIR}}/00-ticket.md, matching ticket.md. Written only if non-empty.
#[tauri::command]
pub(crate) async fn create_task(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    task_slug: String,
    description: String,
    evidence: String,
    attachments: Vec<String>,
    linear_id: String,
    github_issue: String,
    playbook: String,
    harness: String,
    model: String,
    auto_advance: Option<Vec<String>>,
    use_worktree: bool,
    branch_name: String,
    worktree_name: String,
    draft_slug: String,
) -> Result<CreateTaskResult, String> {
    let repo = require_owned_active_repo(&state)?;
    let app_config = app_config_path(&app)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        create_task_in_with_draft_slug(
            &repo,
            Some(&app_config),
            &draft_slug,
            &task_slug,
            name,
            description,
            evidence,
            attachments,
            linear_id,
            github_issue,
            playbook,
            harness,
            model,
            auto_advance,
            use_worktree,
            branch_name,
            worktree_name,
        )
    })
    .await;
    result.map_err(|e| format!("create task: {e}"))?
}

#[cfg(test)]
pub(crate) fn create_task_in(
    repo: &Path,
    name: String,
    description: String,
    evidence: String,
    attachments: Vec<String>,
    linear_id: String,
    github_issue: String,
    playbook: String,
    harness: String,
    model: String,
    auto_advance: Option<Vec<String>>,
    use_worktree: bool,
    branch_name: String,
    worktree_name: String,
) -> Result<CreateTaskResult, String> {
    create_task_in_with_draft_slug(
        repo,
        None,
        "",
        "",
        name,
        description,
        evidence,
        attachments,
        linear_id,
        github_issue,
        playbook,
        harness,
        model,
        auto_advance,
        use_worktree,
        branch_name,
        worktree_name,
    )
}

#[tauri::command]
pub(crate) async fn create_task_for_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
    task_slug: String,
    description: String,
    evidence: String,
    attachments: Vec<String>,
    linear_id: String,
    github_issue: String,
    playbook: String,
    harness: String,
    model: String,
    auto_advance: Option<Vec<String>>,
    use_worktree: bool,
    branch_name: String,
    worktree_name: String,
    draft_slug: String,
) -> Result<CreateTaskResult, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    let app_config = app_config_path(&app)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        create_task_in_with_draft_slug(
            &repo,
            Some(&app_config),
            &draft_slug,
            &task_slug,
            name,
            description,
            evidence,
            attachments,
            linear_id,
            github_issue,
            playbook,
            harness,
            model,
            auto_advance,
            use_worktree,
            branch_name,
            worktree_name,
        )
    })
    .await;
    result.map_err(|e| format!("create task: {e}"))?
}

#[tauri::command]
pub(crate) async fn duplicate_task_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, source_slug: String) -> Result<CreateTaskResult, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    let result = tauri::async_runtime::spawn_blocking(move || duplicate_task_in(&repo, &source_slug)).await;
    result.map_err(|e| format!("duplicate task: {e}"))?
}

#[cfg(test)]
pub(crate) static FAIL_DUPLICATE_AFTER_WORKTREE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
pub(crate) fn duplicate_fail_key(slug: &str) -> u64 {
    slug.bytes().fold(14695981039346656037, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(1099511628211))
}

struct DuplicateFile {
    path: PathBuf,
    file: fs::File,
}

struct DuplicateAttachment {
    name: String,
    input: DuplicateFile,
}

struct DuplicateInputs {
    ticket: Option<DuplicateFile>,
    attachments: Vec<DuplicateAttachment>,
}

fn open_duplicate_file(path: PathBuf, kind: &str) -> Result<DuplicateFile, String> {
    let metadata = fs::symlink_metadata(&path).map_err(|e| format!("inspect duplicate source {kind} {}: {e}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("duplicate source {kind} is not a regular file: {}", path.display()));
    }
    let file = fs::File::open(&path).map_err(|e| format!("open duplicate source {kind} {}: {e}", path.display()))?;
    if !file
        .metadata()
        .map_err(|e| format!("inspect opened duplicate source {kind} {}: {e}", path.display()))?
        .is_file()
    {
        return Err(format!("duplicate source {kind} is not a regular file: {}", path.display()));
    }
    Ok(DuplicateFile { path, file })
}

fn copy_duplicate_file(input: &mut DuplicateFile, destination: &Path, kind: &str) -> Result<(), String> {
    let mut output = fs::File::create(destination).map_err(|e| format!("create duplicate {kind} {} from {}: {e}", destination.display(), input.path.display()))?;
    std::io::copy(&mut input.file, &mut output).map_err(|e| format!("copy duplicate {kind} {} to {}: {e}", input.path.display(), destination.display()))?;
    output.flush().map_err(|e| format!("flush duplicate {kind} {}: {e}", destination.display()))
}

fn read_duplicate_inputs(repo: &Path, source_slug: &str) -> Result<DuplicateInputs, String> {
    let artifacts = artifacts_dir(repo, source_slug);
    let ticket_path = artifacts.join("00-ticket.md");
    let ticket = match fs::symlink_metadata(&ticket_path) {
        Ok(_) => Some(open_duplicate_file(ticket_path, "ticket")?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("inspect duplicate source ticket {}: {e}", ticket_path.display())),
    };

    let attachments_path = alinery_core::attachments_dir(repo, source_slug);
    let attachments = match fs::symlink_metadata(&attachments_path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
        Err(e) => return Err(format!("inspect duplicate source attachments {}: {e}", attachments_path.display())),
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(format!("duplicate source attachments path is not a directory: {}", attachments_path.display()));
            }
            let mut inputs = vec![];
            for entry in fs::read_dir(&attachments_path).map_err(|e| format!("read duplicate source attachments {}: {e}", attachments_path.display()))? {
                let entry = entry.map_err(|e| format!("read duplicate source attachment entry: {e}"))?;
                let path = entry.path();
                let name = entry
                    .file_name()
                    .into_string()
                    .ok()
                    .and_then(|name| alinery_core::safe_component(&name).map(str::to_string))
                    .ok_or_else(|| format!("invalid duplicate source attachment name: {}", path.display()))?;
                inputs.push(DuplicateAttachment {
                    name,
                    input: open_duplicate_file(path, "attachment")?,
                });
            }
            inputs.sort_by(|a, b| a.name.cmp(&b.name));
            inputs
        }
    };
    Ok(DuplicateInputs { ticket, attachments })
}

fn cleanup_failed_duplicate(repo: &Path, task_path: &Path, worktree: &Path, branch: &str, git_created: bool) -> Vec<String> {
    let mut errors = vec![];
    if git_created {
        match git_cmd(repo).args(["worktree", "remove", "--force"]).arg(worktree).output() {
            Ok(out) if out.status.success() => {}
            Ok(out) => errors.push(format!("git worktree cleanup failed: {}", String::from_utf8_lossy(&out.stderr).trim())),
            Err(e) => errors.push(format!("git worktree cleanup: {e}")),
        }
        match git_cmd(repo).args(["branch", "-D", branch]).output() {
            Ok(out) if out.status.success() => {}
            Ok(out) => errors.push(format!("git branch cleanup failed: {}", String::from_utf8_lossy(&out.stderr).trim())),
            Err(e) => errors.push(format!("git branch cleanup: {e}")),
        }
    }
    if task_path.exists() {
        if let Err(e) = fs::remove_dir_all(task_path) {
            errors.push(format!("task directory cleanup failed: {e}"));
        }
    }
    errors
}

fn duplicate_generation(source: &str) -> Option<usize> {
    let (_, suffix) = source.trim_end().rsplit_once(" D+")?;
    if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    suffix.parse().ok()
}

fn duplicate_identity_base(source: &str, generation: Option<usize>) -> String {
    let Some(_) = generation.filter(|generation| *generation > 0) else {
        return source.to_string();
    };

    match source.rsplit_once('-') {
        Some((base, suffix)) if !base.is_empty() && !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit()) => base.to_string(),
        _ => source.to_string(),
    }
}

fn dedupe_numbered_name(base: &str, start: usize, mut conflicts: impl FnMut(&str) -> bool) -> String {
    let mut n = start;
    loop {
        let candidate = format!("{base}-{n}");
        if !conflicts(&candidate) {
            return candidate;
        }
        let Some(next) = n.checked_add(1) else {
            return candidate;
        };
        n = next;
    }
}

pub(crate) fn duplicate_task_name(source: &str) -> String {
    if let Some(generation) = duplicate_generation(source) {
        if let Some(next) = generation.checked_add(1) {
            let (base, _) = source.trim_end().rsplit_once(" D+").expect("duplicate generation requires suffix");
            return format!("{base} D+{next}");
        }
    }
    format!("{} D+1", source.trim_end())
}

pub(crate) fn duplicate_task_in(repo: &Path, source_slug: &str) -> Result<CreateTaskResult, String> {
    let source_slug = alinery_core::safe_component(source_slug).ok_or_else(|| "invalid duplicate source slug".to_string())?;
    let source = read_task(repo, source_slug)?;
    if source.draft {
        return Err("draft tasks cannot be duplicated".into());
    }
    let source_session = list_sessions_for_repo(repo, source_slug)?
        .into_iter()
        .filter(|session| is_original_primary_playbook_session(&source, session))
        .min_by(|a, b| a.created.cmp(&b.created).then_with(|| a.id.cmp(&b.id)))
        .ok_or_else(|| "source task has no original primary playbook session".to_string())?;
    let mut inputs = read_duplicate_inputs(repo, source_slug)?;

    fs::create_dir_all(tasks_dir(repo)).map_err(|e| e.to_string())?;
    fs::create_dir_all(worktrees_dir(repo)).map_err(|e| e.to_string())?;
    ensure_gitignore(repo)?;
    alinery_core::ensure_playbooks(repo)?;

    let generation = duplicate_generation(&source.name);
    let next_identity_number = generation.and_then(|generation| generation.checked_add(2));
    let slug_base = duplicate_identity_base(source_slug, generation);
    let slug = match next_identity_number {
        Some(start) => dedupe_numbered_name(&slug_base, start, |candidate| {
            task_dir(repo, candidate).exists() || worktrees_dir(repo).join(candidate).exists() || branch_ref_conflicts(repo, candidate)
        }),
        None => unique_slug(repo, &slug_base),
    };
    let branch = if source.branch.trim().is_empty() {
        slug.clone()
    } else {
        let branch_base = duplicate_identity_base(source.branch.trim(), generation);
        match next_identity_number {
            Some(start) => dedupe_numbered_name(&branch_base, start, |candidate| branch_ref_conflicts(repo, candidate)),
            None => dedupe_branch_name(repo, &branch_base),
        }
    };
    let worktree_source = source.worktree.trim().strip_suffix(std::path::MAIN_SEPARATOR).unwrap_or(source.worktree.trim());
    let worktree_source = Path::new(worktree_source)
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(alinery_core::safe_component)
        .unwrap_or(source_slug);
    let worktree_base = duplicate_identity_base(worktree_source, generation);
    let worktree_leaf = match next_identity_number {
        Some(start) => dedupe_numbered_name(&worktree_base, start, |candidate| worktrees_dir(repo).join(candidate).exists()),
        None => dedupe_worktree_name(repo, &worktree_base),
    };
    let worktree = worktrees_dir(repo).join(worktree_leaf);
    let worktree_string = worktree.to_string_lossy().to_string();
    let destination_task_dir = task_dir(repo, &slug);

    fs::create_dir(&destination_task_dir).map_err(|e| format!("create duplicate task directory: {e}"))?;
    let mut git_created = false;
    let result = (|| -> Result<CreateTaskResult, String> {
        let out = git_cmd(repo)
            .args(["worktree", "add", &worktree_string, "-b", &branch])
            .output()
            .map_err(|e| format!("git worktree add: {e}"))?;
        if !out.status.success() {
            return Err(format!("git worktree add failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        git_created = true;
        #[cfg(test)]
        if FAIL_DUPLICATE_AFTER_WORKTREE
            .compare_exchange(duplicate_fail_key(source_slug), 0, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst)
            .is_ok()
        {
            return Err("injected duplicate failure after worktree creation".into());
        }

        fs::create_dir_all(artifacts_dir(repo, &slug)).map_err(|e| format!("create duplicate artifacts: {e}"))?;
        fs::create_dir_all(sessions_dir(repo, &slug)).map_err(|e| format!("create duplicate sessions: {e}"))?;
        if let Some(ticket) = inputs.ticket.as_mut() {
            copy_duplicate_file(ticket, &artifacts_dir(repo, &slug).join("00-ticket.md"), "ticket")?;
        }
        if !inputs.attachments.is_empty() {
            let destination_attachments = alinery_core::attachments_dir(repo, &slug);
            fs::create_dir_all(&destination_attachments).map_err(|e| format!("create duplicate attachments: {e}"))?;
            for attachment in &mut inputs.attachments {
                copy_duplicate_file(
                    &mut attachment.input,
                    &destination_attachments.join(&attachment.name),
                    &format!("attachment {}", attachment.name),
                )?;
            }
        }

        let task = Task {
            name: duplicate_task_name(&source.name),
            slug: slug.clone(),
            requested_slug: String::new(),
            branch: branch.clone(),
            worktree: worktree_string.clone(),
            has_worktree: true,
            created: now_secs(),
            archived: false,
            pr_url: String::new(),
            linear_id: source.linear_id.clone(),
            github_issue: source.github_issue.clone(),
            playbook: source.playbook.clone(),
            auto_advance: source.auto_advance.clone(),
            related_tasks: source.related_tasks.clone(),
            parent_task: String::new(),
            active_subtask: String::new(),
            subtask_outcome: String::new(),
            draft: false,
            telemetry_id: alinery_core::new_telemetry_id(),
        };
        write_task(repo, &task)?;
        let session = write_initial_session(
            repo,
            &task,
            if alinery_core::is_allowed_launch_harness(&source_session.harness) {
                InitialSessionLaunch::Preserve {
                    harness: source_session.harness.clone(),
                    model: if source_session.harness == alinery_core::NO_HARNESS_KEY {
                        String::new()
                    } else {
                        source_session.model.clone()
                    },
                }
            } else {
                InitialSessionLaunch::Preserve {
                    harness: alinery_core::DEFAULT_HARNESS_KEY.to_string(),
                    model: String::new(),
                }
            },
        )?;
        Ok(CreateTaskResult {
            task,
            session,
            attachment_errors: vec![],
        })
    })();

    match result {
        Ok(result) => Ok(result),
        Err(primary) => {
            let cleanup = cleanup_failed_duplicate(repo, &destination_task_dir, &worktree, &branch, git_created);
            if cleanup.is_empty() {
                Err(primary)
            } else {
                Err(format!("{primary}; cleanup failed: {}", cleanup.join("; ")))
            }
        }
    }
}

pub(crate) const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
pub(crate) const MAX_ATTACHMENT_SET_BYTES: u64 = 100 * 1024 * 1024;

// Suffix goes before the extension so `trace.log` collides into `trace-2.log`, never
// `trace.log-2`. Probing is against the on-disk dir, so a promoted draft's pre-existing
// attachments are respected.
pub(crate) fn unique_attachment_name(dir: &Path, base: &str) -> Option<String> {
    if !dir.join(base).exists() {
        return Some(base.to_string());
    }
    let stem = Path::new(base).file_stem()?.to_str()?.to_string();
    let ext = Path::new(base).extension().and_then(|s| s.to_str()).map(|s| s.to_string());
    for n in 2..=99u32 {
        let candidate = match &ext {
            Some(ext) => format!("{stem}-{n}.{ext}"),
            None => format!("{stem}-{n}"),
        };
        if !dir.join(&candidate).exists() {
            return Some(candidate);
        }
    }
    None
}

// Infallible by construction: a bad attachment is data, never control flow. Runs strictly after
// the git block so it can never reach a rollback_task_dir call site.
pub(crate) fn copy_task_attachments(repo: &Path, slug: &str, entries: &[String]) -> (Vec<String>, Vec<String>, Vec<String>) {
    let dir = alinery_core::attachments_dir(repo, slug);
    let (mut urls, mut copied, mut failures) = (vec![], vec![], vec![]);
    let mut batch_bytes: u64 = 0;
    for entry in entries {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        if entry.starts_with("http://") || entry.starts_with("https://") {
            // Recorded verbatim, never fetched.
            urls.push(entry.to_string());
            continue;
        }
        let src = Path::new(entry);
        let meta = match fs::metadata(src) {
            Ok(m) => m,
            Err(e) => {
                failures.push(format!("{entry} — {e}"));
                continue;
            }
        };
        if !meta.is_file() {
            failures.push(format!("{entry} — not a regular file"));
            continue;
        }
        if meta.len() > MAX_ATTACHMENT_BYTES {
            failures.push(format!("{entry} — larger than 25 MB"));
            continue;
        }
        if batch_bytes + meta.len() > MAX_ATTACHMENT_SET_BYTES {
            failures.push(format!("{entry} — attachment set would exceed 100 MB"));
            continue;
        }
        let Some(base) = src.file_name().and_then(|s| s.to_str()).and_then(alinery_core::safe_component) else {
            failures.push(format!("{entry} — unusable file name"));
            continue;
        };
        if let Err(e) = fs::create_dir_all(&dir) {
            failures.push(format!("{entry} — {e}"));
            continue;
        }
        let Some(target) = unique_attachment_name(&dir, base) else {
            failures.push(format!("{entry} — too many name collisions"));
            continue;
        };
        match fs::copy(src, dir.join(&target)) {
            Ok(_) => {
                batch_bytes += meta.len();
                copied.push(target);
            }
            Err(e) => failures.push(format!("{entry} — {e}")),
        }
    }
    (urls, copied, failures)
}

pub(crate) fn create_task_in_with_draft_slug(
    repo: &Path,
    app_config: Option<&Path>,
    draft_slug: &str,
    task_slug: &str,
    name: String,
    description: String,
    evidence: String,
    attachments: Vec<String>,
    linear_id: String,
    github_issue: String,
    playbook: String,
    harness: String,
    model: String,
    auto_advance: Option<Vec<String>>,
    use_worktree: bool,
    branch_name: String,
    worktree_name: String,
) -> Result<CreateTaskResult, String> {
    alinery_core::with_task_mutation_lock(repo, "create task", || {
        create_task_in_with_draft_slug_unlocked(
            repo,
            app_config,
            draft_slug,
            task_slug,
            name,
            description,
            evidence,
            attachments,
            linear_id,
            github_issue,
            playbook,
            harness,
            model,
            auto_advance,
            use_worktree,
            branch_name,
            worktree_name,
        )
    })
}

fn create_task_in_with_draft_slug_unlocked(
    repo: &Path,
    app_config: Option<&Path>,
    draft_slug: &str,
    task_slug: &str,
    name: String,
    description: String,
    evidence: String,
    attachments: Vec<String>,
    linear_id: String,
    github_issue: String,
    playbook: String,
    harness: String,
    model: String,
    auto_advance: Option<Vec<String>>,
    use_worktree: bool,
    branch_name: String,
    worktree_name: String,
) -> Result<CreateTaskResult, String> {
    let repo = repo.to_path_buf();
    alinery_core::ensure_playbooks(&repo)?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("task name is empty".into());
    }
    fs::create_dir_all(tasks_dir(&repo)).map_err(|e| e.to_string())?;
    fs::create_dir_all(worktrees_dir(&repo)).map_err(|e| e.to_string())?;
    ensure_gitignore(&repo)?;

    let playbook = resolve_playbook_selection(&repo, &playbook);

    // The draft slug is a stable autosave key. The final task slug is separately visible/editable
    // on the create page, so an early "Fix" autosave cannot dictate the final Git names.
    let base_slug = slugify(&name);
    let requested_draft = draft_slug.trim();
    let draft_storage_slug = if requested_draft.is_empty() {
        draft_slug_for_name(&repo, &base_slug, &name)
    } else {
        let requested_draft = alinery_core::safe_component(requested_draft).ok_or_else(|| "invalid draft slug".to_string())?;
        match read_task(&repo, requested_draft) {
            Ok(t) if is_reusable_draft(&t) => requested_draft.to_string(),
            Ok(t) if t.draft => draft_slug_for_name(&repo, &base_slug, &name),
            Ok(_) => return Err("draft was already created".into()),
            Err(_) => draft_slug_for_name(&repo, &base_slug, &name),
        }
    };
    let existing_draft = read_task(&repo, &draft_storage_slug).ok().filter(is_reusable_draft);
    let requested_final_slug = if task_slug.trim().is_empty() {
        existing_draft
            .as_ref()
            .map(|task| task.requested_slug.trim())
            .filter(|slug| !slug.is_empty())
            .unwrap_or(&base_slug)
    } else {
        task_slug.trim()
    };
    let normalized_slug = slugify(requested_final_slug);
    if normalized_slug != requested_final_slug {
        return Err("task slug must use lowercase letters, numbers, and single dashes".into());
    }
    let except = existing_draft.as_ref().map(|task| task.slug.as_str()).unwrap_or("");
    let slug = unique_slug_except(&repo, &normalized_slug, except);
    let moved_draft = existing_draft.as_ref().filter(|task| task.slug != slug).map(|task| task.slug.clone());
    if let Some(old_slug) = &moved_draft {
        fs::rename(task_dir(&repo, old_slug), task_dir(&repo, &slug)).map_err(|e| format!("rename draft {old_slug} to {slug}: {e}"))?;
    }
    fs::create_dir_all(sessions_dir(&repo, &slug)).map_err(|e| e.to_string())?;
    fs::create_dir_all(artifacts_dir(&repo, &slug)).map_err(|e| e.to_string())?;
    let rollback_task_dir = || {
        if let Some(old_slug) = &moved_draft {
            let _ = fs::rename(task_dir(&repo, &slug), task_dir(&repo, old_slug));
        } else if existing_draft.is_none() {
            let _ = fs::remove_dir_all(task_dir(&repo, &slug));
        }
    };

    let branch_base = {
        let b = branch_name.trim();
        if b.is_empty() {
            slug.clone()
        } else {
            b.to_string()
        }
    };
    let branch = dedupe_branch_name(&repo, &branch_base);

    let worktree_str = if use_worktree {
        let worktree_base = {
            let w = worktree_name.trim();
            if w.is_empty() {
                slug.clone()
            } else {
                w.to_string()
            }
        };
        let worktree_leaf = alinery_core::safe_component(&worktree_base).ok_or_else(|| "invalid worktree name".to_string())?.to_string();
        let worktree_leaf = dedupe_worktree_name(&repo, &worktree_leaf);
        let worktree = worktrees_dir(&repo).join(&worktree_leaf);
        let worktree_str = worktree.to_string_lossy().to_string();

        let out = git_cmd(&repo)
            .args(["worktree", "add", &worktree_str, "-b", &branch])
            .output()
            .map_err(|e| format!("git worktree add: {e}"))?;
        if !out.status.success() {
            rollback_task_dir();
            return Err(format!("git worktree add failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        worktree_str
    } else {
        // No dedicated worktree: fork the branch directly in the main repo, switching its
        // active branch immediately. `-b` never touches the working tree, so any uncommitted
        // state in the main repo rides along safely regardless of dirtiness.
        let out = git_cmd(&repo).args(["checkout", "-b", &branch]).output().map_err(|e| format!("git checkout: {e}"))?;
        if !out.status.success() {
            rollback_task_dir();
            return Err(format!("git checkout failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        repo.to_string_lossy().to_string()
    };

    let (urls, copied, attachment_errors) = copy_task_attachments(&repo, &slug, &attachments);
    let ticket = alinery_core::compose_ticket(&name, &description, &evidence, &urls, &copied, &attachment_errors);
    if !ticket.is_empty() {
        fs::write(artifacts_dir(&repo, &slug).join("00-ticket.md"), ticket).map_err(|e| e.to_string())?;
    }

    let task = Task {
        name,
        slug: slug.clone(),
        requested_slug: String::new(),
        branch,
        worktree: worktree_str.clone(),
        has_worktree: use_worktree,
        created: existing_draft.as_ref().map(|task| task.created).unwrap_or_else(now_secs),
        archived: false,
        pr_url: String::new(),
        linear_id: linear_id.trim().to_string(),
        github_issue: github_issue.trim().to_string(),
        playbook: playbook.clone(),
        auto_advance: auto_advance.unwrap_or_else(|| default_auto_advance_for_playbook(&repo, &playbook)),
        related_tasks: Vec::new(),
        parent_task: String::new(),
        active_subtask: String::new(),
        subtask_outcome: String::new(),
        draft: false,
        telemetry_id: existing_draft
            .as_ref()
            .map(|task| task.telemetry_id.clone())
            .filter(|id| !id.is_empty())
            .unwrap_or_else(alinery_core::new_telemetry_id),
    };
    write_task_unlocked(&repo, &task)?;

    let session = write_initial_session(&repo, &task, InitialSessionLaunch::Resolve { harness, model })?;
    if let Some(path) = app_config {
        emit_at(
            path,
            alinery_core::TelemetryEvent::TaskCreate {
                source: alinery_core::TelemetrySource::App,
                has_attachments: !copied.is_empty(),
                has_worktree: use_worktree,
                from_draft: existing_draft.is_some(),
                playbook: task.playbook.clone(),
                has_linear: !task.linear_id.is_empty(),
                has_github: !task.github_issue.is_empty(),
                task_id: task.telemetry_id.clone(),
            },
        );
        emit_at(
            path,
            alinery_core::TelemetryEvent::SessionCreate {
                source: alinery_core::TelemetrySource::App,
                harness: session.harness.clone(),
                phase: session.phase.clone(),
                generic: session.generic,
                drawer: false,
                is_resume: false,
                session_id: session.telemetry_id.clone(),
                task_id: task.telemetry_id.clone(),
            },
        );
    }
    Ok(CreateTaskResult { task, session, attachment_errors })
}

enum InitialSessionLaunch {
    Resolve { harness: String, model: String },
    Preserve { harness: String, model: String },
}

fn write_initial_session(repo: &Path, task: &Task, launch: InitialSessionLaunch) -> Result<SessionMeta, String> {
    let playbook = task.playbook.clone();
    let wf = alinery_core::get_playbook(repo, &playbook).unwrap_or_else(|| alinery_core::default_playbook(repo));
    let phase = if wf.kind == "freeform" {
        String::new()
    } else {
        first_step_for_playbook(repo, &playbook)
    };
    let (resolved_harness, resolved_model) = match launch {
        InitialSessionLaunch::Preserve { harness, model } => (harness, model),
        InitialSessionLaunch::Resolve { harness, model } => {
            let mut resolved_harness = harness.trim().to_string();
            if resolved_harness.is_empty() || !alinery_core::is_allowed_launch_harness(&resolved_harness) || resolved_harness == alinery_core::NO_HARNESS_KEY {
                resolved_harness = alinery_core::DEFAULT_HARNESS_KEY.to_string();
            }
            (resolved_harness, model)
        }
    };
    if !alinery_core::is_allowed_launch_harness(&resolved_harness) {
        return Err(format!("unknown harness '{resolved_harness}'"));
    }
    if let Some(app_config) = alinery_core::app_config_toml_path() {
        alinery_core::resolve_harness_strict_for(&app_config, repo, &resolved_harness)?;
    }
    let id = format!("s{}", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let session = SessionMeta {
        id: id.clone(),
        worktree: task.worktree.clone(),
        created: now_secs(),
        archived: false,
        phase,
        harness: resolved_harness,
        model: resolved_model,
        playbook,
        telemetry_id: alinery_core::new_telemetry_id(),
        ..Default::default()
    };
    write_meta_atomic(
        &sessions_dir(repo, &task.slug).join(format!("{id}.meta.json")),
        &serde_json::to_value(&session).map_err(|e| e.to_string())?,
    )?;
    Ok(session)
}

// Archived drafts require explicit restore. Autosave and create must treat their slugs as occupied.
fn is_reusable_draft(task: &Task) -> bool {
    task.draft && !task.archived
}

pub(crate) fn latest_draft_slug_with_name(repo: &Path, name: &str) -> Option<String> {
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

pub(crate) fn draft_slug_for_name(repo: &Path, base: &str, name: &str) -> String {
    match read_task(repo, base) {
        Ok(t) if is_reusable_draft(&t) => base.to_string(),
        Ok(_) => latest_draft_slug_with_name(repo, name).unwrap_or_else(|| unique_slug(repo, base)),
        Err(_) if task_dir(repo, base).exists() => latest_draft_slug_with_name(repo, name).unwrap_or_else(|| unique_slug(repo, base)),
        Err(_) => latest_draft_slug_with_name(repo, name).unwrap_or_else(|| base.to_string()),
    }
}

// M6: persist a draft task.md (no worktree, no sessions). Same name → same slug even
// when the natural slug is already a real task; never creates git worktrees.
#[cfg(test)]
pub(crate) fn write_draft_in(
    repo: &Path,
    name: String,
    description: String,
    evidence: String,
    linear_id: String,
    github_issue: String,
    playbook: String,
    harness: String,
    model: String,
    auto_advance: Option<Vec<String>>,
    use_worktree: bool,
    branch_name: String,
    worktree_name: String,
) -> Result<Task, String> {
    write_draft_in_with_slug(
        repo,
        None,
        "",
        "",
        name,
        description,
        evidence,
        linear_id,
        github_issue,
        playbook,
        harness,
        model,
        auto_advance,
        use_worktree,
        branch_name,
        worktree_name,
    )
}

pub(crate) fn write_draft_in_with_slug(
    repo: &Path,
    app_config: Option<&Path>,
    draft_slug: &str,
    task_slug: &str,
    name: String,
    description: String,
    evidence: String,
    linear_id: String,
    github_issue: String,
    playbook: String,
    harness: String,
    model: String,
    auto_advance: Option<Vec<String>>,
    use_worktree: bool,
    branch_name: String,
    worktree_name: String,
) -> Result<Task, String> {
    alinery_core::with_task_mutation_lock(repo, "write draft", || {
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
            use_worktree,
            branch_name,
            worktree_name,
        )
    })
}

fn write_draft_in_with_slug_unlocked(
    repo: &Path,
    app_config: Option<&Path>,
    draft_slug: &str,
    task_slug: &str,
    name: String,
    description: String,
    evidence: String,
    linear_id: String,
    github_issue: String,
    playbook: String,
    _harness: String,
    _model: String,
    auto_advance: Option<Vec<String>>,
    use_worktree: bool,
    branch_name: String,
    worktree_name: String,
) -> Result<Task, String> {
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
        let requested_draft = alinery_core::safe_component(requested_draft).ok_or_else(|| "invalid draft slug".to_string())?;
        match read_task(repo, requested_draft) {
            Ok(t) if is_reusable_draft(&t) => requested_draft.to_string(),
            Ok(t) if t.draft => draft_slug_for_name(repo, &base, &name),
            Ok(t) => return Ok(t),
            Err(_) => draft_slug_for_name(repo, &base, &name),
        }
    };

    fs::create_dir_all(tasks_dir(repo)).map_err(|e| e.to_string())?;
    fs::create_dir_all(task_dir(repo, &slug)).map_err(|e| e.to_string())?;

    let playbook = resolve_playbook_selection(repo, &playbook);
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
    // Drafts never materialize a worktree path; when use_worktree is on, stash the intended
    // folder name so reopen can restore it. When off, leave empty (matches create-time empty).
    let worktree = if use_worktree { worktree_name.trim().to_string() } else { String::new() };
    let task = Task {
        name: name.clone(),
        slug: slug.clone(),
        requested_slug,
        branch,
        worktree,
        has_worktree: use_worktree,
        created,
        archived: false,
        pr_url: String::new(),
        linear_id: linear_id.trim().to_string(),
        github_issue: github_issue.trim().to_string(),
        playbook: playbook.clone(),
        auto_advance: auto_advance.unwrap_or_else(|| default_auto_advance_for_playbook(repo, &playbook)),
        draft: true,
        parent_task: String::new(),
        active_subtask: String::new(),
        subtask_outcome: String::new(),
        related_tasks: Vec::new(),
        telemetry_id: previous
            .as_ref()
            .map(|task| task.telemetry_id.clone())
            .filter(|id| !id.is_empty())
            .unwrap_or_else(alinery_core::new_telemetry_id),
    };
    write_task_unlocked(repo, &task)?;
    if previous.is_none() {
        if let Some(path) = app_config {
            emit_at(
                path,
                alinery_core::TelemetryEvent::TaskDraftCreate {
                    source: alinery_core::TelemetrySource::App,
                    has_worktree: use_worktree,
                    playbook: task.playbook.clone(),
                    task_id: task.telemetry_id.clone(),
                },
            );
        }
    }

    let ticket = alinery_core::compose_ticket(&name, &description, &evidence, &[], &[], &[]);
    if !ticket.is_empty() {
        fs::create_dir_all(artifacts_dir(repo, &slug)).map_err(|e| e.to_string())?;
        fs::write(artifacts_dir(repo, &slug).join("00-ticket.md"), ticket).map_err(|e| e.to_string())?;
    }
    Ok(task)
}

#[tauri::command]
pub(crate) fn write_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    task_slug: String,
    description: String,
    evidence: String,
    linear_id: String,
    github_issue: String,
    playbook: String,
    harness: String,
    model: String,
    auto_advance: Option<Vec<String>>,
    use_worktree: bool,
    branch_name: String,
    worktree_name: String,
    draft_slug: String,
) -> Result<Task, String> {
    let repo = require_owned_active_repo(&state)?;
    write_draft_in_with_slug(
        &repo,
        Some(&app_config_path(&app)?),
        &draft_slug,
        &task_slug,
        name,
        description,
        evidence,
        linear_id,
        github_issue,
        playbook,
        harness,
        model,
        auto_advance,
        use_worktree,
        branch_name,
        worktree_name,
    )
}

#[tauri::command]
pub(crate) fn write_draft_for_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
    task_slug: String,
    description: String,
    evidence: String,
    linear_id: String,
    github_issue: String,
    playbook: String,
    harness: String,
    model: String,
    auto_advance: Option<Vec<String>>,
    use_worktree: bool,
    branch_name: String,
    worktree_name: String,
    draft_slug: String,
) -> Result<Task, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    write_draft_in_with_slug(
        &repo,
        Some(&app_config_path(&app)?),
        &draft_slug,
        &task_slug,
        name,
        description,
        evidence,
        linear_id,
        github_issue,
        playbook,
        harness,
        model,
        auto_advance,
        use_worktree,
        branch_name,
        worktree_name,
    )
}

// M6: remove a draft task directory entirely (archive is insufficient — leaves task.md).
pub(crate) fn delete_draft_in(repo: &Path, app_config: Option<&Path>, slug: &str) -> Result<(), String> {
    // Eager on purpose: the read must happen before the directory is removed below, so this one
    // cannot be deferred into the emit closure the way the other id lookups are.
    let telemetry_id = alinery_core::telemetry_id_for_task(repo, slug);
    alinery_core::with_task_mutation_lock(repo, "delete draft", || {
        let task = read_task(repo, slug)?;
        if !task.draft {
            return Err("not a draft".into());
        }
        let dir = task_dir(repo, slug);
        fs::remove_dir_all(&dir).map_err(|e| format!("remove draft {}: {e}", dir.display()))
    })?;
    if let Some(path) = app_config {
        emit_at(
            path,
            alinery_core::TelemetryEvent::TaskDraftDelete {
                source: alinery_core::TelemetrySource::App,
                task_id: telemetry_id,
            },
        );
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn delete_draft(app: AppHandle, state: State<'_, AppState>, slug: String) -> Result<(), String> {
    let repo = require_owned_active_repo(&state)?;
    delete_draft_in(&repo, Some(&app_config_path(&app)?), &slug)
}

#[tauri::command]
pub(crate) fn delete_draft_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, slug: String) -> Result<(), String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    delete_draft_in(&repo, Some(&app_config_path(&app)?), &slug)
}
pub(crate) fn list_tasks_for_repo(repo: &Path) -> Result<Vec<Task>, String> {
    let dir = tasks_dir(repo);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut tasks = vec![];
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        if !entry.path().join("task.md").exists() {
            continue;
        }
        if let Some(slug) = entry.file_name().to_str() {
            match read_task(repo, slug) {
                Ok(t) => tasks.push(t),
                Err(e) => eprintln!("skip task {slug}: {e}"),
            }
        }
    }
    tasks.sort_by_key(|t| t.created);
    Ok(tasks)
}

// Scan `.alinery/tasks/*/task.md`. Returns archived too; the UI hides them.
#[tauri::command]
pub(crate) async fn list_tasks() -> Result<Vec<Task>, String> {
    let repo = active_repo()?;
    list_tasks_for_repo(&repo)
}

fn is_original_primary_playbook_session(task: &Task, session: &SessionMeta) -> bool {
    if session.generic {
        return false;
    }
    let task_playbook = playbook_key_for_task(task);
    let session_playbook = if session.playbook.trim().is_empty() {
        task_playbook.as_str()
    } else {
        session.playbook.trim()
    };
    session_playbook == task_playbook
}

pub(crate) fn is_primary_playbook_session(repo: &Path, task: &Task, session: &SessionMeta) -> bool {
    if session.generic {
        return false;
    }
    let task_playbook = playbook_key_for_task(task);
    let session_playbook = if session.playbook.trim().is_empty() {
        task_playbook.as_str()
    } else {
        session.playbook.trim()
    };
    session_playbook == task_playbook && playbook_step_exists(repo, &task_playbook, &session.phase)
}

pub(crate) fn task_updated_at(repo: &Path, task: &Task, sessions: &[SessionMeta]) -> u64 {
    let mut updated = task.created;
    if let Some(ts) = file_mtime_secs(task_dir(repo, &task.slug).join("task.md")) {
        updated = updated.max(ts);
    }
    if let Some(ts) = dir_latest_mtime_secs(sessions_dir(repo, &task.slug)) {
        updated = updated.max(ts);
    }
    if let Some(ts) = dir_latest_mtime_secs(artifacts_dir(repo, &task.slug)) {
        updated = updated.max(ts);
    }
    for session in sessions {
        updated = updated.max(session.created);
    }
    updated
}

pub(crate) fn board_task(repo: &Path, repo_path: &str, task: Task) -> BoardTask {
    let sessions = list_sessions_for_repo(repo, &task.slug).unwrap_or_default();
    let live: Vec<&SessionMeta> = sessions.iter().filter(|s| !s.archived).collect();
    let playbook_live: Vec<&SessionMeta> = sessions.iter().filter(|s| !s.archived && is_primary_playbook_session(repo, &task, s)).collect();
    let current_phase = playbook_live.last().map(|s| s.phase.clone()).unwrap_or_default();
    let playbook = playbook_key_for_task(&task);
    let playbook_label = playbook_title(repo, &playbook);
    let updated = task_updated_at(repo, &task, &sessions);
    let (latest_session_title, latest_session_column_key) = if task.draft {
        ("Draft".into(), String::new())
    } else if let Some(session) = live.last() {
        if session.generic {
            ("Generic".into(), String::new())
        } else {
            let session_playbook = if session.playbook.trim().is_empty() { &playbook } else { &session.playbook };
            let session_step = if session.phase.trim().is_empty() {
                "No step".into()
            } else {
                step_title(repo, session_playbook, &session.phase)
            };
            let column_key = if playbook_step_exists(repo, session_playbook, &session.phase) {
                column_for_phase(repo, session_playbook, &session.phase).0
            } else {
                String::new()
            };
            (session_step, column_key)
        }
    } else {
        ("No sessions".into(), String::new())
    };
    let (current_column_key, current_column_title) = if task.draft {
        // Drafts always sit in Research & Design regardless of any sessions.
        ("research-design".into(), "Research & Design".into())
    } else if current_phase.is_empty() {
        column_for_phase(repo, &playbook, "")
    } else if playbook_step_exists(repo, &playbook, &current_phase) {
        column_for_phase(repo, &playbook, &current_phase)
    } else {
        ("other".into(), "Other".into())
    };
    let current_step_title = if task.draft {
        String::new()
    } else if current_phase.is_empty() {
        let first = first_step_for_playbook(repo, &playbook);
        step_title(repo, &playbook, &first)
    } else {
        step_title(repo, &playbook, &current_phase)
    };
    BoardTask {
        task,
        repo_path: repo_path.to_string(),
        session_count: live.len(),
        playbook_title: playbook_label,
        updated,
        current_phase,
        current_step_title,
        latest_session_title,
        latest_session_column_key,
        current_column_key,
        current_column_title,
    }
}

fn board_tasks_from_loaded(repo: &Path, repo_path: &str, tasks: Vec<Task>) -> Result<Vec<BoardTask>, String> {
    alinery_core::validate_task_relationship_fields(
        tasks
            .iter()
            .map(|task| (task.slug.as_str(), task.parent_task.as_str(), task.active_subtask.as_str(), task.archived)),
    )?;
    Ok(tasks.into_iter().map(|task| board_task(repo, repo_path, task)).collect())
}

#[cfg(test)]
pub(crate) fn board_tasks_for_repo(repo: &Path, repo_path: &str) -> Result<Vec<BoardTask>, String> {
    board_tasks_from_loaded(repo, repo_path, list_tasks_for_repo(repo)?)
}

#[tauri::command]
pub(crate) async fn list_board_tasks(app: AppHandle, all_repos: bool) -> Result<Vec<BoardTask>, String> {
    let repos = if all_repos {
        load_app_config(&app).known_repos
    } else {
        vec![active_repo()?.to_string_lossy().to_string()]
    };
    let mut out = vec![];
    for repo_path in dedupe_known_repos(repos) {
        let repo = PathBuf::from(&repo_path);
        match list_tasks_for_repo(&repo) {
            Ok(tasks) => out.extend(board_tasks_from_loaded(&repo, &repo_path, tasks)?),
            Err(error) => eprintln!("skip repo {repo_path}: {error}"),
        }
    }
    out.sort_by_key(|task| task.task.created);
    Ok(out)
}

#[tauri::command]
pub(crate) async fn list_task_activity(app: AppHandle, refs: Vec<TaskActivityRef>) -> HashMap<String, TaskActivitySummary> {
    let app_config_identity = app_config_path(&app).ok().map(|path| alinery_core::app_config_identity(&path));
    list_task_activity_for_refs(&refs, app_config_identity.as_deref())
}

pub(crate) fn archive_task_in(repo: &Path, slug: &str) -> Result<(), String> {
    alinery_core::archive_task_guarded(repo, slug)
}

pub(crate) fn restore_task_in(repo: &Path, slug: &str) -> Result<(), String> {
    alinery_core::restore_task(repo, slug)
}

// Archive flips a flag; the worktree and branch are untouched (removal is M5).
#[tauri::command]
pub(crate) fn archive_task(app: AppHandle, state: State<'_, AppState>, slug: String) -> Result<(), String> {
    let repo = require_owned_active_repo(&state)?;
    alinery_core::ensure_task_can_archive(&repo, &slug)?;
    // Publish before the flag flips so a crash mid-archive still has a shot at the
    // pre-archive state. Best-effort: backup failure never blocks archival.
    publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PreArchive);
    archive_task_in(&repo, &slug)?;
    emit_with(&app, || alinery_core::TelemetryEvent::TaskArchive {
        source: alinery_core::TelemetrySource::App,
        task_id: alinery_core::telemetry_id_for_task(&repo, &slug),
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn archive_task_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, slug: String) -> Result<(), String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    alinery_core::ensure_task_can_archive(&repo, &slug)?;
    publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PreArchive);
    archive_task_in(&repo, &slug)?;
    emit_with(&app, || alinery_core::TelemetryEvent::TaskArchive {
        source: alinery_core::TelemetrySource::App,
        task_id: alinery_core::telemetry_id_for_task(&repo, &slug),
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn restore_task_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, slug: String) -> Result<(), String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    restore_task_in(&repo, &slug)
}

pub(crate) fn set_related_tasks_in(repo: &Path, slug: String, related: Vec<alinery_core::RelatedTaskRef>) -> Result<Task, String> {
    let task = read_task(repo, &slug)?;
    if task.archived {
        return Err("task is archived — read-only".into());
    }
    let self_path = repo.to_string_lossy();
    let mut cleaned: Vec<alinery_core::RelatedTaskRef> = Vec::new();
    for mut tag in related {
        tag.repo_path = tag.repo_path.trim().to_string();
        tag.slug = tag.slug.trim().to_string();
        tag.name = tag.name.trim().to_string();
        if tag.repo_path.is_empty() || tag.slug.is_empty() {
            return Err("related task is missing repo or slug".into());
        }
        if alinery_core::safe_component(&tag.slug) != Some(tag.slug.as_str()) {
            return Err(format!("invalid related-task slug '{}'", tag.slug));
        }
        if tag.repo_path == self_path && tag.slug == slug {
            return Err("cannot tag a task as related to itself".into());
        }
        if cleaned.iter().any(|existing| existing.repo_path == tag.repo_path && existing.slug == tag.slug) {
            continue;
        }
        if tag.name.is_empty() {
            if let Ok(other) = read_task(Path::new(&tag.repo_path), &tag.slug) {
                tag.name = other.name;
            }
        }
        cleaned.push(tag);
    }
    alinery_core::with_task_mutation_lock(repo, "set related tasks", || {
        let mut task = read_task(repo, &slug)?;
        if task.archived {
            return Err("task is archived — read-only".into());
        }
        task.related_tasks = cleaned;
        write_task_unlocked(repo, &task)?;
        alinery_core::sync_related_artifact_links(repo, &task.slug, &task.related_tasks)?;
        Ok(task)
    })
}

#[tauri::command]
pub(crate) fn set_related_tasks_for_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    slug: String,
    related: Vec<alinery_core::RelatedTaskRef>,
) -> Result<Task, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    set_related_tasks_in(&repo, slug, related)
}
