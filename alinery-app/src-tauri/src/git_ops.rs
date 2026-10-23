//! git_ops: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

// This crate's git spawns all come from here (module-ownership rule), but the implementation
// lives in alinery-core so alineryd/mcp share the one env-scrub list rather than copying it. See
// alinery-core/src/git.rs for why `-C <dir>` alone targets the wrong repository.
pub(crate) use alinery_core::git_cmd;

pub(crate) use alinery_core::git_actions::commit_worktree_in;
pub(crate) use alinery_core::git_actions::{
    github_pull_request_ref, record_discovered_pull_request_in, set_pr_url_in, task_source_branches as task_source_branches_in, TaskSourceBranches,
};
// Only the tests reach these directly; the commands use them through core.
#[cfg(test)]
pub(crate) use alinery_core::git_actions::{compare_url, default_base_branch, record_pushed_url_in, record_removed_worktree_in, TaskSourceHead};

pub(crate) fn remove_worktree_in(app: &AppHandle, repo: &Path, slug: String) -> Result<(), String> {
    alinery_core::git_actions::remove_worktree(repo, &slug)?;
    emit(
        app,
        alinery_core::TelemetryEvent::GitWorktreeRemove {
            source: alinery_core::TelemetrySource::App,
        },
    );
    Ok(())
}

// Push the task branch from its worktree, then build + store the forge compare URL.
pub(crate) fn push_and_compare_url_in(app: &AppHandle, repo: &Path, slug: String) -> Result<String, String> {
    let url = alinery_core::git_actions::push_and_compare_url(repo, &slug)?;
    publish_auto_backup(app, repo, alinery_core::BackupTrigger::PostPushCommit);
    emit(
        app,
        alinery_core::TelemetryEvent::GitPush {
            source: alinery_core::TelemetrySource::App,
        },
    );
    Ok(url)
}

#[tauri::command]
pub(crate) async fn task_source_branches_for_repo(app: AppHandle, repo_path: String, selected_base_ref: Option<String>) -> Result<TaskSourceBranches, String> {
    let target = target_repo_ref_for_app(&app, &repo_path)?;
    tauri::async_runtime::spawn_blocking(move || match target {
        RepoRef::Local(repo) => task_source_branches_in(&repo, selected_base_ref.as_deref()),
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::TaskSourceBranches {
                repo: path.into(),
                selected_base_ref,
            },
        ),
    })
    .await
    .map_err(|error| format!("task source discovery worker: {error}"))?
}

// ---- M5 remove worktree ------------------------------------------------------
// End the task's live sessions (a running pty holds the worktree), then git worktree remove
// --force, then clear task.worktree. The branch, sessions, artifacts, pr_url all survive.
#[tauri::command]
pub(crate) async fn remove_worktree(app: AppHandle, state: State<'_, AppState>, slug: String) -> Result<(), String> {
    let repo = match active_repo_ref()? {
        RepoRef::Local(_) => RepoRef::Local(require_owned_active_repo(&state)?),
        remote => remote,
    };
    remove_worktree_off_thread(app, repo, slug).await
}

async fn remove_worktree_off_thread(app: AppHandle, repo: RepoRef, slug: String) -> Result<(), String> {
    let result = tauri::async_runtime::spawn_blocking(move || match repo {
        RepoRef::Local(repo) => remove_worktree_in(&app, &repo, slug),
        RepoRef::Remote { host_id, path } => remote_call(&app.state::<AppState>(), &host_id, RepoOp::RemoveWorktree { repo: path.into(), slug }),
    })
    .await;
    result.map_err(|e| format!("remove worktree task: {e}"))?
}

#[tauri::command]
pub(crate) async fn remove_worktree_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, slug: String) -> Result<(), String> {
    let repo = owned_target(&app, &state, &repo_path)?;
    remove_worktree_off_thread(app, repo, slug).await
}

// ---- M5 worktree existence check ---------------------------------------------
// The task's `worktree` path can go stale if the directory is removed outside the app
// (manually, or by a `git worktree remove` run outside alinery); this gives the frontend a
// live filesystem check instead of trusting the stored path.
#[tauri::command]
pub(crate) fn worktree_exists(state: State<'_, AppState>, slug: String) -> Result<bool, String> {
    worktree_exists_for(&state, slug)
}

pub(crate) fn worktree_exists_for(state: &AppState, slug: String) -> Result<bool, String> {
    match active_repo_ref()? {
        RepoRef::Local(repo) => alinery_core::board::worktree_exists(&repo, &slug),
        RepoRef::Remote { host_id, path } => remote_call(state, &host_id, alinery_core::repo_service::RepoOp::WorktreeExists { repo: path.into(), slug }),
    }
}

// ---- M5 PR compare URL -------------------------------------------------------
// Pure remote-URL -> compare-URL parsing. Handles ssh (git@host:owner/repo(.git) and
// ssh://[user@]host/owner/repo(.git)) and http(s). GitHub adds ?expand=1 to prefill the PR
// form; other forges (Gitea) use the bare compare path.
// origin/HEAD is the remote default branch (e.g. "origin/main"); fall back to "main".
// Push the task branch from its worktree, then build + store the forge compare URL.
#[tauri::command]
pub(crate) async fn push_and_compare_url(app: AppHandle, state: State<'_, AppState>, slug: String) -> Result<String, String> {
    let repo = match active_repo_ref()? {
        RepoRef::Local(_) => RepoRef::Local(require_owned_active_repo(&state)?),
        remote => remote,
    };
    push_off_thread(app, repo, slug).await
}

// A remote push runs on the host with the host's git credentials; the local backup and telemetry
// are about this machine's copy of a repo, which a remote one is not.
async fn push_off_thread(app: AppHandle, repo: RepoRef, slug: String) -> Result<String, String> {
    let result = tauri::async_runtime::spawn_blocking(move || match repo {
        RepoRef::Local(repo) => push_and_compare_url_in(&app, &repo, slug),
        RepoRef::Remote { host_id, path } => remote_call(&app.state::<AppState>(), &host_id, RepoOp::PushAndCompareUrl { repo: path.into(), slug }),
    })
    .await;
    result.map_err(|e| format!("push task: {e}"))?
}

#[tauri::command]
pub(crate) async fn push_and_compare_url_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, slug: String) -> Result<String, String> {
    let repo = owned_target(&app, &state, &repo_path)?;
    push_off_thread(app, repo, slug).await
}

// Hand-edit the PR link to the real PR URL once it exists (compare URL is just the prefill).
#[tauri::command]
pub(crate) fn set_pr_url(state: State<'_, AppState>, slug: String, url: String) -> Result<(), String> {
    match require_active_target(&state)? {
        ActiveRepo::Local(repo) => set_pr_url_in(&repo, slug, url),
        ActiveRepo::Remote { host_id, path } => remote_call(&state, &host_id, RepoOp::SetPrUrl { repo: path.into(), slug, url }),
    }
}

#[tauri::command]
pub(crate) fn set_pr_url_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, slug: String, url: String) -> Result<(), String> {
    match owned_target(&app, &state, &repo_path)? {
        RepoRef::Local(repo) => set_pr_url_in(&repo, slug, url),
        RepoRef::Remote { host_id, path } => remote_call(&state, &host_id, RepoOp::SetPrUrl { repo: path.into(), slug, url }),
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PullRequestState {
    Open,
    Merged,
    Closed,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub(crate) struct PullRequest {
    pub(crate) number: u64,
    pub(crate) url: String,
    pub(crate) state: PullRequestState,
}

#[derive(Serialize)]
pub(crate) struct PullRequestSnapshot {
    pub(crate) pr: Option<PullRequest>,
    pub(crate) error: Option<String>,
}

fn pull_request_from_json(value: &Value) -> Result<PullRequest, String> {
    let invalid = || "invalid GitHub pull request response".to_string();
    let url = value["html_url"].as_str().ok_or_else(invalid)?;
    let reference = github_pull_request_ref(url).ok_or_else(invalid)?;
    let number = value["number"].as_u64().ok_or_else(invalid)?;
    if number != reference.number {
        return Err(invalid());
    }
    let state = match (value["state"].as_str(), value.get("merged_at")) {
        (Some("open"), Some(Value::Null)) => PullRequestState::Open,
        (Some("closed"), Some(Value::String(_))) => PullRequestState::Merged,
        (Some("closed"), Some(Value::Null)) => PullRequestState::Closed,
        _ => return Err(invalid()),
    };
    Ok(PullRequest { number, url: url.into(), state })
}

pub(crate) fn select_branch_pull_request(value: &Value, owner: &str, repo: &str, branch: &str) -> Result<Option<PullRequest>, String> {
    let pulls = value.as_array().ok_or("invalid GitHub pull request list")?;
    let head_repository = format!("{owner}/{repo}");
    let mut selected: Option<PullRequest> = None;
    for value in pulls {
        // The server's head filter is not enough: forks may reuse the same branch name.
        if value["head"]["ref"].as_str() != Some(branch)
            || !value["head"]["repo"]["full_name"].as_str().is_some_and(|name| name.eq_ignore_ascii_case(&head_repository))
            || !value["head"]["user"]["login"].as_str().is_some_and(|login| login.eq_ignore_ascii_case(owner))
        {
            continue;
        }
        let pull = pull_request_from_json(value)?;
        // PR numbers increase within one repository, so the largest is the latest.
        if selected
            .as_ref()
            .is_none_or(|previous| (pull.state == PullRequestState::Open, pull.number) > (previous.state == PullRequestState::Open, previous.number))
        {
            selected = Some(pull);
        }
    }
    Ok(selected)
}

fn github_pull_request_json(_repo: &Path, endpoint: &str, fields: &[(&str, &str)]) -> Result<Value, String> {
    let mut url = format!("https://api.github.com/{endpoint}");
    if !fields.is_empty() {
        let query = fields
            .iter()
            .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
            .collect::<Vec<_>>()
            .join("&");
        url.push('?');
        url.push_str(&query);
    }
    let mut headers = vec!["Accept: application/vnd.github+json".to_string(), "User-Agent: alinery".to_string()];
    if let Some(credential) = alinery_core::git_credential_fill(alinery_core::GITHUB_CREDENTIAL_FILL).map_err(|error| format!("GitHub PR lookup: {error}"))? {
        headers.push(format!("Authorization: Bearer {}", credential.secret));
    }
    let response = curl_request_with_timeouts(&url, &headers, None, Duration::from_secs(5), Duration::from_secs(15))?;
    if !(200..300).contains(&response.status) {
        let detail = String::from_utf8_lossy(&response.body);
        let detail = detail.trim();
        return Err(if detail.is_empty() {
            format!("GitHub PR lookup failed: HTTP {}", response.status)
        } else {
            format!("GitHub PR lookup failed: HTTP {} {detail}", response.status)
        });
    }
    serde_json::from_slice(&response.body).map_err(|error| format!("invalid GitHub PR response: {error}"))
}

/// Look up a task's pull request from its stored link, or else its branch and origin. Pure: the
/// caller supplies the repo facts and the GitHub request, so the same logic serves a local repo and
/// a remote one whose facts come from its host.
pub(crate) fn find_task_pull_request(
    pr_url: &str,
    task_branch: &str,
    mut origin: impl FnMut() -> Result<Option<(String, String)>, String>,
    mut request: impl FnMut(&str, &[(&str, &str)]) -> Result<Value, String>,
) -> Result<Option<PullRequest>, String> {
    let pull = if let Some(reference) = github_pull_request_ref(pr_url) {
        // The durable URL remains authoritative even after merge or branch removal.
        let endpoint = format!("repos/{}/{}/pulls/{}", reference.owner, reference.repo, reference.number);
        let pull = pull_request_from_json(&request(&endpoint, &[])?)?;
        if pull.number != reference.number {
            return Err("GitHub returned a different pull request".into());
        }
        Some(pull)
    } else {
        if task_branch.is_empty() {
            return Ok(None);
        }
        let Some((owner, repo_name)) = origin()? else {
            return Ok(None);
        };
        let endpoint = format!("repos/{owner}/{repo_name}/pulls");
        let head = format!("{owner}:{task_branch}");
        let mut found = None;
        // Query open separately so many historical PRs cannot hide an existing open PR.
        for state in ["open", "all"] {
            let response = request(
                &endpoint,
                &[("head", &head), ("state", state), ("sort", "created"), ("direction", "desc"), ("per_page", "100")],
            )?;
            found = select_branch_pull_request(&response, &owner, &repo_name, task_branch)?;
            if found.is_some() {
                break;
            }
        }
        found
    };
    Ok(pull)
}

pub(crate) fn task_pull_request_with(
    repo: &Path,
    slug: &str,
    origin: impl FnMut() -> Result<Option<(String, String)>, String>,
    request: impl FnMut(&str, &[(&str, &str)]) -> Result<Value, String>,
) -> Result<Option<PullRequest>, String> {
    if alinery_core::safe_component(slug).is_none() {
        return Err("invalid task slug".into());
    }
    let task = read_task(repo, slug)?;
    let pull = find_task_pull_request(&task.pr_url, &task.branch, origin, request)?;
    if let Some(pull) = &pull {
        record_discovered_pull_request_in(repo, slug, &task.branch, &task.pr_url, &pull.url)?;
    }
    Ok(pull)
}

/// A remote repo's lookup: the host supplies the stored link, branch and origin; the GitHub call is
/// made from here with this machine's token, and the discovered link is recorded back on the host.
fn remote_task_pull_request(state: &AppState, host_id: &str, path: &str, slug: &str) -> Result<Option<PullRequest>, String> {
    let inputs: alinery_core::git_actions::PullRequestInputs = remote_call(
        state,
        host_id,
        RepoOp::TaskPullRequestInputs {
            repo: path.into(),
            slug: slug.to_string(),
        },
    )?;
    let pull = find_task_pull_request(
        &inputs.pr_url,
        &inputs.branch,
        || Ok(inputs.origin_url.as_deref().and_then(github_repo_from_remote)),
        |endpoint, fields| github_pull_request_json(Path::new(""), endpoint, fields),
    )?;
    if let Some(pull) = &pull {
        remote_call::<()>(
            state,
            host_id,
            RepoOp::RecordDiscoveredPullRequest {
                repo: path.into(),
                slug: slug.to_string(),
                branch: inputs.branch.clone(),
                previous_url: inputs.pr_url.clone(),
                url: pull.url.clone(),
            },
        )?;
    }
    Ok(pull)
}

pub(crate) fn task_pull_request_in(repo: &Path, slug: &str) -> Result<Option<PullRequest>, String> {
    task_pull_request_with(
        repo,
        slug,
        || {
            let mut command = git_cmd(repo);
            command.args(["remote", "get-url", "origin"]).stdin(std::process::Stdio::null());
            let output = output_with_timeout(command, Duration::from_secs(5)).map_err(|error| format!("read GitHub origin: {error}"))?;
            if !output.status.success() {
                return Err(format!("read GitHub origin: {}", String::from_utf8_lossy(&output.stderr).trim()));
            }
            Ok(github_repo_from_remote(String::from_utf8_lossy(&output.stdout).trim()))
        },
        |endpoint, fields| github_pull_request_json(repo, endpoint, fields),
    )
}

pub(crate) fn task_pull_request_snapshots_with(
    tasks: Vec<TaskActivityRef>,
    lookup: impl Fn(&TaskActivityRef) -> Result<Option<PullRequest>, String> + Sync,
) -> HashMap<String, PullRequestSnapshot> {
    let tasks: HashMap<_, _> = tasks
        .into_iter()
        .map(|reference| (task_activity_key(&reference.repo_path, &reference.task_slug), reference))
        .collect();
    let worker_count = tasks.len().min(4);
    let (job_tx, job_rx) = std::sync::mpsc::channel();
    let job_rx = Mutex::new(job_rx);
    let (result_tx, result_rx) = std::sync::mpsc::channel();
    for task in tasks {
        let _ = job_tx.send(task);
    }
    drop(job_tx);

    // As with activity polling, bound subprocess fan-out without serializing the whole board.
    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            let job_rx = &job_rx;
            let lookup = &lookup;
            let result_tx = result_tx.clone();
            scope.spawn(move || loop {
                let job = job_rx.lock().unwrap_or_else(|e| e.into_inner()).recv();
                let Ok((key, reference)) = job else {
                    break;
                };
                let snapshot = match lookup(&reference) {
                    Ok(pr) => PullRequestSnapshot { pr, error: None },
                    Err(error) => PullRequestSnapshot { pr: None, error: Some(error) },
                };
                let _ = result_tx.send((key, snapshot));
            });
        }
        drop(result_tx);
    });
    result_rx.into_iter().collect()
}

#[tauri::command]
pub(crate) async fn list_task_pull_requests(app: AppHandle, tasks: Vec<TaskActivityRef>) -> Result<HashMap<String, PullRequestSnapshot>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        task_pull_request_snapshots_with(tasks, |reference| match owned_target(&app, &state, &reference.repo_path)? {
            RepoRef::Local(repo) => task_pull_request_in(&repo, &reference.task_slug),
            RepoRef::Remote { host_id, path } => remote_task_pull_request(&state, &host_id, &path, &reference.task_slug),
        })
    })
    .await
    .map_err(|error| format!("GitHub PR lookup worker: {error}"))
}

// ---- commit-to-branch ---------------------------------------------------------
// Stage everything and commit in the task's working directory (dedicated worktree, or the
// main repo when the task opted out of one). Local commit only — no push. Protects in-progress
// code from remove_worktree's --force discard.
#[tauri::command]
pub(crate) async fn commit_worktree(app: AppHandle, state: State<'_, AppState>, slug: String, message: String) -> Result<(), String> {
    let repo = match active_repo_ref()? {
        RepoRef::Local(_) => RepoRef::Local(require_owned_active_repo(&state)?),
        remote => remote,
    };
    if commit_off_thread(&app, repo, slug, message).await? {
        emit(
            &app,
            alinery_core::TelemetryEvent::GitCommit {
                source: alinery_core::TelemetrySource::App,
            },
        );
    }
    Ok(())
}

/// Commit in the task's worktree. Returns whether it was a local repo, which is the only kind
/// that has a backup to publish and telemetry to send.
async fn commit_off_thread(app: &AppHandle, repo: RepoRef, slug: String, message: String) -> Result<bool, String> {
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || match repo {
        RepoRef::Local(repo) => {
            commit_worktree_in(&repo, slug, message)?;
            Ok::<_, String>(Some(repo))
        }
        RepoRef::Remote { host_id, path } => {
            remote_call::<()>(&worker_app.state::<AppState>(), &host_id, RepoOp::CommitWorktree { repo: path.into(), slug, message })?;
            Ok(None)
        }
    })
    .await;
    match result.map_err(|e| format!("commit task: {e}"))?? {
        Some(repo) => {
            publish_auto_backup(app, &repo, alinery_core::BackupTrigger::PostPushCommit);
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
pub(crate) async fn commit_worktree_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, slug: String, message: String) -> Result<(), String> {
    let repo = owned_target(&app, &state, &repo_path)?;
    commit_off_thread(&app, repo, slug, message).await.map(|_| ())
}
