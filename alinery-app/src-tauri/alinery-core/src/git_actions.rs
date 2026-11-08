//! The GitHub pull-request link and issue-number parsing the app shell still uses. The git work itself (commit, push, remove a
//! worktree, the PR link, the source branches, the compare URL) moved to the daemon in S4.7: `vinculum-daemon/src/domain/gitActions.ts`.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitHubIssueRef {
    pub owner: String,
    pub repo: String,
    pub number: u64,
}

impl GitHubIssueRef {
    pub fn label(&self) -> String {
        format!("{}/{}#{}", self.owner, self.repo, self.number)
    }
}

pub fn issue_number(s: &str) -> Option<u64> {
    let s = s.trim();
    (!s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
        .then(|| s.parse::<u64>().ok())
        .flatten()
        .filter(|n| *n > 0)
}

pub fn github_pull_request_ref(url: &str) -> Option<GitHubIssueRef> {
    let path = url.trim().strip_prefix("https://github.com/")?;
    let path = path.split(['?', '#']).next()?.trim_end_matches('/');
    let parts: Vec<_> = path.split('/').collect();
    let valid_component = |part: &str| !part.is_empty() && part != "." && part != ".." && part.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'));
    if parts.len() != 4 || parts[2] != "pull" || !valid_component(parts[0]) || !valid_component(parts[1]) {
        return None;
    }
    Some(GitHubIssueRef {
        owner: parts[0].into(),
        repo: parts[1].into(),
        number: issue_number(parts[3])?,
    })
}
