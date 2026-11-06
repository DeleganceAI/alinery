//! git_ops: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

// This crate's git spawns all come from here (module-ownership rule), but the implementation
// lives in alinery-core so alineryd/mcp share the one env-scrub list rather than copying it. See
// alinery-core/src/git.rs for why `-C <dir>` alone targets the wrong repository.
pub(crate) use alinery_core::git_cmd;

pub(crate) use alinery_core::git_actions::github_pull_request_ref;

// The git work itself (commit, push, remove a worktree, the PR link, the source branches) is the daemon's GitService
// (S4.7); the frontend calls it through `src/sync/git.ts`. What stays here is what needs this machine: the GitHub API call
// with this machine's token.

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

fn github_pull_request_json(endpoint: &str, fields: &[(&str, &str)]) -> Result<Value, String> {
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

/// A task's pull request, looked up from the facts the daemon holds for it (`TaskPullRequestInputs`): the stored link, the
/// branch and the origin URL. The GitHub call is made here with this machine's token; the frontend records what it finds
/// back through the daemon.
#[tauri::command]
pub(crate) async fn lookup_task_pull_request(pr_url: String, branch: String, origin_url: Option<String>) -> Result<Option<PullRequest>, String> {
    tauri::async_runtime::spawn_blocking(move || find_task_pull_request(&pr_url, &branch, || Ok(origin_url.as_deref().and_then(github_repo_from_remote)), github_pull_request_json))
        .await
        .map_err(|error| format!("GitHub PR lookup worker: {error}"))?
}
