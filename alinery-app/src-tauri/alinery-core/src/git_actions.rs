//! Git work on a task's repo and worktree: commit, push (and the forge compare URL), remove the
//! worktree, the PR link, and the task-source branch discovery. It lives in core so a remote host
//! runs the same code a local repo does; the app adds what is about this machine (backups,
//! telemetry) around it.

use crate::board::read_task_checked;
use crate::git_cmd;
use serde::{Deserialize, Serialize};
use std::path::Path;

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

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskSourceBranch {
    pub full_ref: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TaskSourceHead {
    Branch { full_ref: String, name: String },
    Detached { oid: String },
    Unborn { full_ref: String, name: String },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TaskSourceSelection {
    pub base_ref: String,
    pub available: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TaskSourceBranches {
    pub branches: Vec<TaskSourceBranch>,
    pub head: TaskSourceHead,
    pub selected: Option<TaskSourceSelection>,
}

// Discovery cannot treat warnings (notably skipped broken refs) as an empty success.
fn task_source_output(output: std::process::Output, operation: &str, allowed_codes: &[i32]) -> Result<(i32, String), String> {
    let stderr = String::from_utf8(output.stderr).map_err(|error| format!("git {operation}: invalid UTF-8 in stderr: {error}"))?;
    let stdout = String::from_utf8(output.stdout).map_err(|error| format!("git {operation}: invalid UTF-8 in stdout: {error}"))?;
    let code = output.status.code().filter(|code| allowed_codes.contains(code));
    if !stderr.is_empty() || code.is_none() {
        return Err(format!("git {operation}: {}: {stderr}", output.status));
    }
    Ok((code.unwrap(), stdout))
}

fn task_source_git(repo: &Path, args: &[&str], allowed_codes: &[i32]) -> Result<(i32, String), String> {
    let output = git_cmd(repo).args(args).output().map_err(|error| format!("git {}: {error}", args[0]))?;
    task_source_output(output, args[0], allowed_codes)
}

fn task_source_line(output: &str) -> Result<&str, String> {
    output
        .strip_suffix('\n')
        .filter(|line| !line.is_empty() && !line.contains(['\n', '\r', '\0']))
        .ok_or_else(|| "malformed Git source identity output".to_string())
}

fn task_source_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn task_source_local_ref(repo: &Path, full_ref: &str) -> Result<bool, String> {
    if !full_ref.starts_with("refs/heads/") || full_ref.contains('\0') {
        return Ok(false);
    }
    let (code, output) = task_source_git(repo, &["check-ref-format", full_ref], &[0, 1])?;
    if !output.is_empty() {
        return Err("malformed Git ref validation output".into());
    }
    Ok(code == 0)
}

fn task_source_commit_exists(repo: &Path, oid: &str) -> Result<bool, String> {
    use std::io::Write;
    use std::process::Stdio;

    // A SHA-1-sized value can resolve as an abbreviation in a SHA-256 repository.
    let (_, format) = task_source_git(repo, &["rev-parse", "--show-object-format"], &[0])?;
    let oid_len = match task_source_line(&format)? {
        "sha1" => 40,
        "sha256" => 64,
        _ => return Err("unsupported Git object format".into()),
    };
    if oid.len() != oid_len {
        return Ok(false);
    }

    let mut child = git_cmd(repo)
        .args(["cat-file", "--batch-check=%(objectname) %(objecttype)"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("git cat-file: {error}"))?;
    let write_result = writeln!(child.stdin.take().expect("piped Git stdin"), "{oid}");
    let output = child.wait_with_output().map_err(|error| format!("git cat-file: {error}"))?;
    let (_, output) = task_source_output(output, "cat-file", &[0])?;
    write_result.map_err(|error| format!("git cat-file input: {error}"))?;
    let line = task_source_line(&output)?;
    let (actual, kind) = line.split_once(' ').ok_or_else(|| "malformed Git object output".to_string())?;
    if !actual.eq_ignore_ascii_case(oid) {
        return Err("Git object output did not match the requested identity".into());
    }
    match kind {
        "commit" => Ok(true),
        "missing" | "blob" | "tree" | "tag" => Ok(false),
        _ => Err("malformed Git object type output".into()),
    }
}

pub fn task_source_branches(repo: &Path, selected_base_ref: Option<&str>) -> Result<TaskSourceBranches, String> {
    let (_, output) = task_source_git(
        repo,
        &["for-each-ref", "--sort=refname", "--format=%(refname)%00%(objecttype)%00%(objectname)", "refs/heads/"],
        &[0],
    )?;
    let mut branches: Vec<TaskSourceBranch> = Vec::new();
    if !output.is_empty() {
        let rows = output.strip_suffix('\n').ok_or_else(|| "malformed Git branch output".to_string())?;
        for row in rows.split('\n') {
            let mut fields = row.split('\0');
            let (Some(full_ref), Some(kind), Some(oid), None) = (fields.next(), fields.next(), fields.next(), fields.next()) else {
                return Err("malformed Git branch output".into());
            };
            if kind != "commit" || !task_source_oid(oid) || !task_source_local_ref(repo, full_ref)? {
                return Err("Git local branch did not identify a valid commit".into());
            }
            if branches.last().is_some_and(|previous| previous.full_ref.as_str() >= full_ref) {
                return Err("Git local branches were not in unique ref-name order".into());
            }
            branches.push(TaskSourceBranch {
                full_ref: full_ref.into(),
                name: full_ref["refs/heads/".len()..].into(),
            });
        }
    }

    let (symbolic_code, symbolic) = task_source_git(repo, &["symbolic-ref", "--quiet", "HEAD"], &[0, 1])?;
    let head = if symbolic_code == 0 {
        let full_ref = task_source_line(&symbolic)?;
        if !task_source_local_ref(repo, full_ref)? {
            return Err("Git HEAD did not identify a local branch".into());
        }
        // Exact existence distinguishes an unborn branch from a present broken ref.
        let (exists, output) = task_source_git(repo, &["show-ref", "--verify", "--quiet", full_ref], &[0, 1])?;
        if !output.is_empty() {
            return Err("malformed Git HEAD ref output".into());
        }
        let listed = branches.iter().any(|branch| branch.full_ref == full_ref);
        let name = full_ref["refs/heads/".len()..].to_string();
        match (exists, listed) {
            (0, true) => TaskSourceHead::Branch { full_ref: full_ref.into(), name },
            (1, false) => TaskSourceHead::Unborn { full_ref: full_ref.into(), name },
            _ => return Err("Git HEAD changed during source discovery; refresh and try again".into()),
        }
    } else {
        if !symbolic.is_empty() {
            return Err("malformed Git detached HEAD output".into());
        }
        let (_, output) = task_source_git(repo, &["rev-parse", "--verify", "HEAD"], &[0])?;
        let oid = task_source_line(&output)?;
        if !task_source_oid(oid) || !task_source_commit_exists(repo, oid)? {
            return Err("Git detached HEAD did not identify a commit".into());
        }
        TaskSourceHead::Detached { oid: oid.into() }
    };
    let selected = selected_base_ref
        .map(|base_ref| -> Result<TaskSourceSelection, String> {
            let available = if task_source_oid(base_ref) {
                task_source_commit_exists(repo, base_ref)?
            } else {
                branches.iter().any(|branch| branch.full_ref == base_ref)
            };
            Ok(TaskSourceSelection {
                base_ref: base_ref.into(),
                available,
            })
        })
        .transpose()?;
    Ok(TaskSourceBranches { branches, head, selected })
}

pub fn record_removed_worktree_in(repo: &Path, slug: &str, removed_worktree: &str) -> Result<(), String> {
    crate::mutate_task(repo, slug, "record worktree removal", |task| {
        if task.worktree != removed_worktree {
            return Err("task worktree changed during removal".into());
        }
        task.worktree.clear();
        Ok(())
    })
}

pub fn compare_url(remote: &str, base: &str, branch: &str) -> Option<String> {
    let remote = remote.trim();
    // Track ssh scheme: an ssh URL's :port is the SSH port (never the web port) so it must be
    // dropped; an https URL's :port IS the web port and is kept.
    let mut is_ssh = false;
    let hostpath = if let Some(rest) = remote.strip_prefix("git@") {
        is_ssh = true;
        rest.replacen(':', "/", 1) // scp form git@host:owner/repo -> host/owner/repo (no port)
    } else if let Some(rest) = remote.strip_prefix("ssh://") {
        is_ssh = true;
        rest.to_string() // ssh://[user@]host[:port]/owner/repo — userinfo/port handled below
    } else if let Some(rest) = remote.strip_prefix("https://") {
        rest.to_string()
    } else {
        remote.strip_prefix("http://")?.to_string()
    };
    let hostpath = hostpath.trim_end_matches('/').trim_end_matches(".git");
    let (host, ownerrepo) = hostpath.split_once('/')?;
    // Strip any userinfo (user[:token]@) for ALL schemes so an embedded credential never
    // leaks into the stored/clickable/copied compare URL.
    let host = host.rsplit_once('@').map(|(_, h)| h).unwrap_or(host);
    // For ssh, drop a trailing :<port> (the SSH port, unknowable-as-web-port → default https).
    let host = if is_ssh {
        host.rsplit_once(':')
            .filter(|(_, p)| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
            .map(|(h, _)| h)
            .unwrap_or(host)
    } else {
        host
    };
    if host.is_empty() || !ownerrepo.contains('/') {
        return None;
    }
    let expand = if host.contains("github") { "?expand=1" } else { "" };
    Some(format!("https://{host}/{ownerrepo}/compare/{base}...{branch}{expand}"))
}

pub fn default_base_branch(repo: &Path) -> String {
    let out = git_cmd(repo).args(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).output();
    if let Ok(o) = out {
        if o.status.success() {
            if let Some(b) = String::from_utf8_lossy(&o.stdout).trim().strip_prefix("origin/") {
                if !b.is_empty() {
                    return b.to_string();
                }
            }
        }
    }
    "main".to_string()
}

pub fn record_pushed_url_in(repo: &Path, slug: &str, pushed_branch: &str, url: &str) -> Result<(), String> {
    crate::mutate_task(repo, slug, "store pull request URL", |task| {
        if task.branch != pushed_branch {
            return Err("task branch changed during push".into());
        }
        // Once discovery (or the user) supplies a real PR, pushing must not replace it
        // with the creation form: the durable link is how we find a merged PR later.
        if github_pull_request_ref(&task.pr_url).is_none() {
            task.pr_url = url.to_string();
        }
        Ok(())
    })
}

pub fn set_pr_url_in(repo: &Path, slug: String, url: String) -> Result<(), String> {
    let url = url.trim().to_string();
    crate::mutate_task(repo, &slug, "set pull request URL", |task| {
        task.pr_url = url;
        Ok(())
    })
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

pub fn record_discovered_pull_request_in(repo: &Path, slug: &str, branch: &str, previous_url: &str, url: &str) -> Result<(), String> {
    if github_pull_request_ref(url).is_none() {
        return Err("invalid GitHub pull request URL".into());
    }
    let check_snapshot = |current_branch: &str, current_url: &str| {
        if current_branch != branch || current_url != previous_url {
            Err("task branch or PR link changed during lookup".to_string())
        } else {
            Ok(())
        }
    };
    // Polling an already stored PR must not rewrite task.md every minute.
    if previous_url == url {
        let task = read_task_checked(repo, slug)?;
        return check_snapshot(&task.branch, &task.pr_url);
    }
    crate::mutate_task(repo, slug, "discover pull request URL", |task| {
        check_snapshot(&task.branch, &task.pr_url)?;
        task.pr_url = url.into();
        Ok(())
    })
}

pub fn commit_worktree_in(repo: &Path, slug: String, message: String) -> Result<(), String> {
    let task = read_task_checked(repo, &slug)?;
    if task.worktree.is_empty() {
        return Err("worktree removed — nothing to commit".into());
    }
    let message = message.trim();
    if message.is_empty() {
        return Err("commit message is empty".into());
    }
    let add = git_cmd(&task.worktree).args(["add", "-A"]).output().map_err(|e| format!("git add: {e}"))?;
    if !add.status.success() {
        return Err(format!("git add failed: {}", String::from_utf8_lossy(&add.stderr).trim()));
    }
    let commit = git_cmd(&task.worktree).args(["commit", "-m", message]).output().map_err(|e| format!("git commit: {e}"))?;
    if !commit.status.success() {
        let stderr = String::from_utf8_lossy(&commit.stderr);
        let stdout = String::from_utf8_lossy(&commit.stdout);
        let detail = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
        return Err(format!("git commit failed: {detail}"));
    }
    Ok(())
}

/// `git worktree remove --force` the task's worktree, then clear it from task.md. The branch,
/// sessions, artifacts and PR link survive. The caller has already confirmed with the user.
pub fn remove_worktree(repo: &Path, slug: &str) -> Result<(), String> {
    let task = read_task_checked(repo, slug)?;
    if !task.has_worktree {
        return Err("this task has no dedicated worktree to remove".into());
    }
    if task.worktree.is_empty() {
        return Err("worktree already removed".into());
    }
    // --force: a coding session may have left the tree dirty, and the UI already gated this
    // behind a confirm (that IS the explicit dirty-tree handling). Branch is kept.
    let out = git_cmd(repo)
        .args(["worktree", "remove", "--force", &task.worktree])
        .output()
        .map_err(|e| format!("git worktree remove: {e}"))?;
    if !out.status.success() {
        return Err(format!("git worktree remove failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    record_removed_worktree_in(repo, slug, &task.worktree)
}

/// Push the task branch from its worktree, then build and store the forge compare URL.
pub fn push_and_compare_url(repo: &Path, slug: &str) -> Result<String, String> {
    let task = read_task_checked(repo, slug)?;
    if task.worktree.is_empty() {
        return Err("worktree removed — nothing to push".into());
    }
    let out = git_cmd(&task.worktree)
        .args(["push", "-u", "origin", &task.branch])
        .output()
        .map_err(|e| format!("git push: {e}"))?;
    if !out.status.success() {
        return Err(format!("git push failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let remote = git_cmd(repo)
        .args(["remote", "get-url", "origin"])
        .output()
        .map_err(|e| format!("git remote get-url: {e}"))?;
    if !remote.status.success() {
        return Err("no 'origin' remote configured".into());
    }
    let remote = String::from_utf8_lossy(&remote.stdout).trim().to_string();
    let base = default_base_branch(repo);
    let url = compare_url(&remote, &base, &task.branch).ok_or_else(|| format!("could not parse remote URL: {remote}"))?;
    record_pushed_url_in(repo, slug, &task.branch, &url)?;
    Ok(url)
}

/// What a PR lookup needs from the repo, so the GitHub call can be made from another machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestInputs {
    pub pr_url: String,
    pub branch: String,
    /// `git remote get-url origin`, if there is one.
    pub origin_url: Option<String>,
}

pub fn pull_request_inputs(repo: &Path, slug: &str) -> Result<PullRequestInputs, String> {
    if crate::safe_component(slug).is_none() {
        return Err("invalid task slug".into());
    }
    let task = read_task_checked(repo, slug)?;
    let origin = git_cmd(repo)
        .args(["remote", "get-url", "origin"])
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("read GitHub origin: {e}"))?;
    let origin_url = origin.status.success().then(|| String::from_utf8_lossy(&origin.stdout).trim().to_string());
    Ok(PullRequestInputs {
        pr_url: task.pr_url,
        branch: task.branch,
        origin_url,
    })
}
