//! imports: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

// ---- M5 Linear import (opt-in, one-way) --------------------------------------
// Extract a Linear identifier ("ENG-123") from a bare id or a Linear URL
// (https://linear.app/team/issue/ENG-123/slug). Pure + testable (no network).
pub(crate) fn parse_linear_ref(input: &str) -> Option<String> {
    let s = input.trim();
    let candidate = match s.find("/issue/") {
        Some(idx) => s[idx + "/issue/".len()..].split('/').next().unwrap_or(""),
        None => s,
    }
    .trim();
    // Identifier shape: LETTERS "-" DIGITS.
    let ok = candidate
        .split_once('-')
        .is_some_and(|(a, b)| !a.is_empty() && a.chars().all(|c| c.is_ascii_alphabetic()) && !b.is_empty() && b.chars().all(|c| c.is_ascii_digit()));
    ok.then(|| candidate.to_uppercase())
}

#[derive(Serialize)]
pub(crate) struct LinearTicket {
    pub(crate) identifier: String,
    pub(crate) title: String,
    pub(crate) description: String,
}

// Import through the current OAuth connection.
pub(crate) fn import_linear_in(app_config: &Path, _repo: &Path, reference: &str) -> Result<LinearTicket, String> {
    let token = linear_oauth_access_token()
        .map_err(|error| {
            if error.clears_account_label() {
                if let Some(config_dir) = app_config_dir_of(app_config) {
                    clear_linear_account_in(config_dir);
                }
            }
            format!("Linear credential could not be used: {}. Reconnect it in Settings → Connections.", error.reason())
        })?
        .ok_or_else(|| "Linear is not connected. Connect it in Settings → Connections.".to_string())?;
    let authorization = format!("Bearer {token}");
    let id = parse_linear_ref(reference).ok_or_else(|| format!("not a Linear issue id or URL: {reference}"))?;
    // Linear's issue(id:) accepts the human identifier (ENG-123) as well as the UUID.
    let query = format!(r#"{{"query":"query {{ issue(id: \"{id}\") {{ identifier title description }} }}"}}"#);
    let out = curl_request(
        "https://api.linear.app/graphql",
        &["Content-Type: application/json".into(), format!("Authorization: {authorization}")],
        Some(&query),
    )?;
    let v: serde_json::Value = serde_json::from_slice(&out).map_err(|e| format!("bad Linear response: {e}"))?;
    if let Some(errs) = v.get("errors") {
        return Err(format!("Linear error: {errs}"));
    }
    let issue = match v.get("data").and_then(|d| d.get("issue")) {
        Some(i) if !i.is_null() => i.clone(),
        _ => return Err(format!("Linear issue not found: {id}")),
    };
    let get = |k: &str| issue.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let ticket = LinearTicket {
        identifier: {
            let i = get("identifier");
            if i.is_empty() {
                id
            } else {
                i
            }
        },
        title: get("title"),
        description: get("description"),
    };
    emit_at(
        app_config,
        alinery_core::TelemetryEvent::ImportFetch {
            source: alinery_core::TelemetrySource::App,
            import_source: alinery_core::ImportSource::Linear,
        },
    );
    Ok(ticket)
}

#[tauri::command]
pub(crate) fn import_linear(app: AppHandle, state: State<'_, AppState>, reference: String) -> Result<LinearTicket, String> {
    import_linear_in(&app_config_path(&app)?, &require_owned_active_repo(&state)?, &reference)
}

#[tauri::command]
pub(crate) fn import_linear_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, reference: String) -> Result<LinearTicket, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    import_linear_in(&app_config_path(&app)?, &repo, &reference)
}

// ---- GitHub issue and pull-request import ------------------------------------
// Accepts a full issue or pull-request URL, owner/repo#123,
// owner/repo/issues/123, owner/repo/pull/123, or a bare #123/123 when the
// active repo's origin is github.com/owner/repo(.git).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GitHubIssueRef {
    pub(crate) owner: String,
    pub(crate) repo: String,
    pub(crate) number: u64,
}

impl GitHubIssueRef {
    pub(crate) fn label(&self) -> String {
        format!("{}/{}#{}", self.owner, self.repo, self.number)
    }
}

pub(crate) fn issue_number(s: &str) -> Option<u64> {
    let s = s.trim();
    (!s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
        .then(|| s.parse::<u64>().ok())
        .flatten()
        .filter(|n| *n > 0)
}

pub(crate) fn owner_repo(owner: &str, repo: &str) -> Option<(String, String)> {
    let owner = owner.trim();
    let repo = repo.trim().trim_end_matches(".git");
    (!owner.is_empty() && !repo.is_empty() && !owner.contains('/') && !repo.contains('/') && !owner.contains('#') && !repo.contains('#'))
        .then(|| (owner.to_string(), repo.to_string()))
}

pub(crate) fn github_repo_from_remote(remote: &str) -> Option<(String, String)> {
    let remote = remote.trim().trim_end_matches('/').trim_end_matches(".git");
    let hostpath = if let Some(rest) = remote.strip_prefix("git@") {
        rest.replacen(':', "/", 1)
    } else if let Some(rest) = remote.strip_prefix("ssh://") {
        rest.to_string()
    } else if let Some(rest) = remote.strip_prefix("https://") {
        rest.to_string()
    } else {
        remote.strip_prefix("http://")?.to_string()
    };
    let (host, path) = hostpath.split_once('/')?;
    let host = host.rsplit_once('@').map(|(_, h)| h).unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    if host != "github.com" {
        return None;
    }
    let mut parts = path.split('/');
    owner_repo(parts.next()?, parts.next()?)
}

pub(crate) fn active_github_repo(repo: &Path) -> Option<(String, String)> {
    let out = git_cmd(repo).args(["remote", "get-url", "origin"]).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .and_then(|remote| github_repo_from_remote(&remote))
}

pub(crate) fn parse_issue_path(path: &str) -> Option<GitHubIssueRef> {
    let path = path.split('?').next().unwrap_or(path).split('#').next().unwrap_or(path).trim_matches('/');
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() != 4 || !matches!(parts[2], "issues" | "pull") {
        return None;
    }
    let (owner, repo) = owner_repo(parts[0], parts[1])?;
    Some(GitHubIssueRef {
        owner,
        repo,
        number: issue_number(parts[3])?,
    })
}

pub(crate) fn parse_github_ref(input: &str, default_repo: Option<(String, String)>) -> Option<GitHubIssueRef> {
    let s = input.trim().trim_end_matches('/');
    if s.is_empty() {
        return None;
    }

    if let Some(n) = s.strip_prefix('#').and_then(issue_number) {
        let (owner, repo) = default_repo?;
        return Some(GitHubIssueRef { owner, repo, number: n });
    }
    if let Some(n) = issue_number(s) {
        let (owner, repo) = default_repo?;
        return Some(GitHubIssueRef { owner, repo, number: n });
    }

    if let Some(path) = s.strip_prefix("https://github.com/").or_else(|| s.strip_prefix("http://github.com/")) {
        if let Some(issue) = parse_issue_path(path) {
            return Some(issue);
        }
    }
    if let Some(issue) = parse_issue_path(s) {
        return Some(issue);
    }

    let (repo_ref, number) = s.rsplit_once('#')?;
    let number = issue_number(number)?;
    let (owner, repo) = repo_ref.split_once('/').and_then(|(o, r)| owner_repo(o, r))?;
    Some(GitHubIssueRef { owner, repo, number })
}

#[derive(Serialize)]
pub(crate) struct GitHubIssue {
    pub(crate) reference: String,
    pub(crate) title: String,
    pub(crate) description: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GitHubResourceKind {
    Issue,
    PullRequest,
}

impl GitHubResourceKind {
    fn url_segment(self) -> &'static str {
        match self {
            Self::Issue => "issues",
            Self::PullRequest => "pull",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GitHubResource {
    pub(crate) reference: GitHubIssueRef,
    pub(crate) kind: GitHubResourceKind,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) url: String,
    pub(crate) comment_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GitHubDiscussionItem {
    pub(crate) source: GitHubIssueRef,
    pub(crate) body: String,
    pub(crate) author: Option<String>,
    pub(crate) created_at: Option<String>,
    pub(crate) url: Option<String>,
}

pub(crate) const MAX_GITHUB_COMMENTS: usize = 100;
pub(crate) const MAX_GITHUB_IMPORT_BYTES: usize = 64 * 1024;

pub(crate) fn github_error(v: &serde_json::Value) -> Option<String> {
    v.get("message").and_then(|x| x.as_str()).map(|msg| {
        v.get("status")
            .and_then(|x| x.as_str())
            .map(|status| format!("{msg} ({status})"))
            .unwrap_or_else(|| msg.to_string())
    })
}

pub(crate) fn gh_auth_token_command() -> Command {
    let mut command = Command::new("gh");
    command.args(["auth", "token", "--hostname", "github.com"]).env("PATH", login_shell_path());
    command
}

pub(crate) fn gh_auth_token() -> Option<String> {
    let out = gh_auth_token_command().output().ok()?;
    if !out.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!token.is_empty()).then_some(token)
}

fn github_json_request(url: &str, token: Option<&str>) -> Result<serde_json::Value, String> {
    let mut headers = vec!["Accept: application/vnd.github+json".into(), "User-Agent: alinery".into()];
    if let Some(token) = token.filter(|token| !token.trim().is_empty()) {
        headers.push(format!("Authorization: Bearer {token}"));
    }
    serde_json::from_slice(&curl_request(url, &headers, None)?).map_err(|error| format!("bad GitHub response: {error}"))
}

pub(crate) trait GitHubTransport {
    fn request_json(&mut self, url: &str, token: Option<&str>) -> Result<serde_json::Value, String>;
}

pub(crate) struct CurlGitHubTransport;

impl GitHubTransport for CurlGitHubTransport {
    fn request_json(&mut self, url: &str, token: Option<&str>) -> Result<serde_json::Value, String> {
        github_json_request(url, token)
    }
}

pub(crate) trait GitHubRequester {
    fn rest_json(&mut self, url: &str) -> Result<serde_json::Value, String>;
}

pub(crate) struct GitHubClient<T> {
    transport: T,
    connected_token: Option<String>,
    configured_token: Option<String>,
}

impl<T: GitHubTransport> GitHubClient<T> {
    pub(crate) fn new(transport: T, connected_token: Option<String>, configured_token: Option<String>) -> Self {
        Self {
            transport,
            connected_token: connected_token.filter(|token| !token.trim().is_empty()),
            configured_token: configured_token.filter(|token| !token.trim().is_empty()),
        }
    }

    fn redact_tokens(&self, mut message: String) -> String {
        for token in [self.connected_token.as_deref(), self.configured_token.as_deref()].into_iter().flatten() {
            message = message.replace(token, "[REDACTED]");
        }
        message
    }

    fn request_with_auth(&mut self, url: &str) -> Result<serde_json::Value, String> {
        let first_token = self.connected_token.clone().or_else(|| self.configured_token.clone());
        let first = self.transport.request_json(url, first_token.as_deref()).map_err(|error| self.redact_tokens(error))?;
        if github_error(&first).is_none() {
            return Ok(first);
        }

        let retry_token = self.configured_token.clone().filter(|token| first_token.as_deref() != Some(token.as_str()));
        let Some(retry_token) = retry_token else {
            return Ok(first);
        };
        let retry = self.transport.request_json(url, Some(&retry_token)).map_err(|error| self.redact_tokens(error))?;
        if github_error(&retry).is_some() {
            Ok(first)
        } else {
            Ok(retry)
        }
    }
}

impl<T: GitHubTransport> GitHubRequester for GitHubClient<T> {
    fn rest_json(&mut self, url: &str) -> Result<serde_json::Value, String> {
        let value = self.request_with_auth(url)?;
        if let Some(error) = github_error(&value) {
            let error = self.redact_tokens(error);
            return Err(format!("GitHub error: {error}. Check token access in Settings."));
        }
        Ok(value)
    }
}

fn github_client(app_config: &Path, repo: &Path) -> GitHubClient<CurlGitHubTransport> {
    let configured = load_config_with_app_path(app_config, repo).github.token.trim().to_string();
    GitHubClient::new(CurlGitHubTransport, gh_auth_token(), Some(configured))
}

fn github_resource_url(reference: &GitHubIssueRef, kind: GitHubResourceKind) -> String {
    format!("https://github.com/{}/{}/{}/{}", reference.owner, reference.repo, kind.url_segment(), reference.number)
}

pub(crate) fn fetch_github_resource<R: GitHubRequester>(requester: &mut R, reference: &GitHubIssueRef) -> Result<GitHubResource, String> {
    let api = format!("https://api.github.com/repos/{}/{}/issues/{}", reference.owner, reference.repo, reference.number);
    let value = requester.rest_json(&api)?;
    let title = value
        .get("title")
        .and_then(|title| title.as_str())
        .ok_or_else(|| format!("GitHub resource not found or malformed: {}", reference.label()))?
        .to_string();
    let kind = if value.get("pull_request").is_some() {
        GitHubResourceKind::PullRequest
    } else {
        GitHubResourceKind::Issue
    };
    let comment_count = value
        .get("comments")
        .and_then(|comments| comments.as_u64())
        .ok_or_else(|| format!("bad GitHub comment count for {}", reference.label()))?;
    let body = match value.get("body") {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(body) => body
            .as_str()
            .ok_or_else(|| format!("bad GitHub opening body for {}", reference.label()))?
            .trim()
            .to_string(),
    };
    let url = match value.get("html_url") {
        None | Some(serde_json::Value::Null) => github_resource_url(reference, kind),
        Some(url) => url.as_str().ok_or_else(|| format!("bad GitHub resource URL for {}", reference.label()))?.to_string(),
    };
    Ok(GitHubResource {
        reference: reference.clone(),
        kind,
        title,
        body,
        url,
        comment_count,
    })
}

fn discussion_item(value: &serde_json::Value, source: &GitHubIssueRef) -> Result<GitHubDiscussionItem, String> {
    let body = value
        .get("body")
        .and_then(|body| body.as_str())
        .ok_or_else(|| format!("bad GitHub discussion body for {}", source.label()))?;
    Ok(GitHubDiscussionItem {
        source: source.clone(),
        body: body.to_string(),
        author: value.pointer("/user/login").and_then(|login| login.as_str()).map(str::to_string),
        created_at: value.get("created_at").and_then(|created| created.as_str()).map(str::to_string),
        url: value.get("html_url").and_then(|url| url.as_str()).map(str::to_string),
    })
}

fn github_comments_page(resource: &GitHubResource, page: u64) -> String {
    format!(
        "https://api.github.com/repos/{}/{}/issues/{}/comments?per_page={MAX_GITHUB_COMMENTS}&page={page}",
        resource.reference.owner, resource.reference.repo, resource.reference.number
    )
}

pub(crate) fn fetch_github_discussion<R: GitHubRequester>(requester: &mut R, resource: &GitHubResource) -> Result<(Vec<GitHubDiscussionItem>, bool), String> {
    if resource.comment_count == 0 {
        return Ok((Vec::new(), false));
    }

    let page_size = MAX_GITHUB_COMMENTS as u64;
    let first_page = resource.comment_count.saturating_sub(page_size) / page_size + 1;
    let last_page = (resource.comment_count - 1) / page_size + 1;
    let mut discussion = Vec::with_capacity(MAX_GITHUB_COMMENTS);
    for page in first_page..=last_page {
        let value = requester.rest_json(&github_comments_page(resource, page))?;
        let values = value.as_array().ok_or_else(|| format!("bad GitHub comments response for {}", resource.reference.label()))?;
        discussion.extend(values.iter().map(|value| discussion_item(value, &resource.reference)).collect::<Result<Vec<_>, _>>()?);
    }
    if discussion.len() > MAX_GITHUB_COMMENTS {
        discussion.drain(..discussion.len() - MAX_GITHUB_COMMENTS);
    }
    Ok((discussion, resource.comment_count > page_size))
}

fn start_github_section(description: &mut String, title: &str) {
    if !description.ends_with('\n') {
        description.push('\n');
    }
    description.push('\n');
    description.push_str(title);
}

fn github_comment_markdown(item: &GitHubDiscussionItem) -> String {
    let mut markdown = format!("\n\n### {} — {}", item.source.label(), item.author.as_deref().unwrap_or("unknown GitHub author"));
    if let Some(created_at) = &item.created_at {
        markdown.push_str(" — ");
        markdown.push_str(created_at);
    }
    if let Some(url) = &item.url {
        markdown.push_str(" — ");
        markdown.push_str(url);
    }
    markdown.push_str("\n\n");
    markdown.push_str(&item.body);
    markdown
}

pub(crate) fn compose_github_description(selected: &GitHubResource, discussion: &[GitHubDiscussionItem], comments_truncated: bool) -> String {
    let mut description = if selected.body.is_empty() {
        format!("GitHub: {}\n", selected.url)
    } else {
        format!("GitHub: {}\n\n{}", selected.url, selected.body)
    };
    if discussion.is_empty() && !comments_truncated {
        return description;
    }

    let comments = discussion.iter().map(github_comment_markdown).collect::<Vec<_>>();
    let section = "\n\n## GitHub Comments";
    let full_len = description.len() + section.len() + comments.iter().map(String::len).sum::<usize>();
    let must_truncate = comments_truncated || full_len > MAX_GITHUB_IMPORT_BYTES;
    if !must_truncate {
        start_github_section(&mut description, "## GitHub Comments");
        for comment in comments {
            description.push_str(&comment);
        }
        return description;
    }

    let notice = format!("\n\nGitHub import truncated. Additional discussion remains at {}.", selected.url);
    let mut used = description.len() + section.len() + notice.len();
    let mut kept_newest = Vec::new();
    for comment in comments.into_iter().rev() {
        if used + comment.len() > MAX_GITHUB_IMPORT_BYTES {
            break;
        }
        used += comment.len();
        kept_newest.push(comment);
    }
    start_github_section(&mut description, "## GitHub Comments");
    for comment in kept_newest.into_iter().rev() {
        description.push_str(&comment);
    }
    description.push_str(&notice);
    description
}

pub(crate) fn import_github_with<R: GitHubRequester>(requester: &mut R, reference: GitHubIssueRef) -> Result<GitHubIssue, String> {
    let selected = fetch_github_resource(requester, &reference)?;
    let (discussion, comments_truncated) = fetch_github_discussion(requester, &selected)?;
    Ok(GitHubIssue {
        reference: selected.reference.label(),
        title: selected.title.clone(),
        description: compose_github_description(&selected, &discussion, comments_truncated),
    })
}

pub(crate) fn import_github_in(app_config: &Path, repo_root: &Path, reference: &str) -> Result<GitHubIssue, String> {
    let reference = parse_github_ref(reference, active_github_repo(repo_root)).ok_or_else(|| format!("not a GitHub issue or pull request URL/ref: {reference}"))?;
    let issue = import_github_with(&mut github_client(app_config, repo_root), reference)?;
    emit_at(
        app_config,
        alinery_core::TelemetryEvent::ImportFetch {
            source: alinery_core::TelemetrySource::App,
            import_source: alinery_core::ImportSource::Github,
        },
    );
    Ok(issue)
}

#[tauri::command]
pub(crate) fn import_github(app: AppHandle, state: State<'_, AppState>, reference: String) -> Result<GitHubIssue, String> {
    import_github_in(&app_config_path(&app)?, &require_owned_active_repo(&state)?, &reference)
}

#[tauri::command]
pub(crate) fn import_github_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, reference: String) -> Result<GitHubIssue, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    import_github_in(&app_config_path(&app)?, &repo, &reference)
}
