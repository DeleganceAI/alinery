//! git_ops: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

// This crate's git spawns all come from here (module-ownership rule), but the implementation
// lives in alinery-core so alineryd/mcp share the one env-scrub list rather than copying it. See
// alinery-core/src/git.rs for why `-C <dir>` alone targets the wrong repository.
pub(crate) use alinery_core::git_cmd;

// ---- M5 remove worktree ------------------------------------------------------
// End the task's live sessions (a running pty holds the worktree), then git worktree remove
// --force, then clear task.worktree. The branch, sessions, artifacts, pr_url all survive.
pub(crate) fn record_removed_worktree_in(repo: &Path, slug: &str, removed_worktree: &str) -> Result<(), String> {
    alinery_core::mutate_task(repo, slug, "record worktree removal", |task| {
        if task.worktree != removed_worktree {
            return Err("task worktree changed during removal".into());
        }
        task.worktree.clear();
        Ok(())
    })
}

pub(crate) fn remove_worktree_in(app: &AppHandle, repo: &Path, slug: String) -> Result<(), String> {
    let task = read_task(repo, &slug)?;
    if !task.has_worktree {
        return Err("this task has no dedicated worktree to remove".into());
    }
    if task.worktree.is_empty() {
        return Err("worktree already removed".into());
    }
    // 1) The daemon owns live ptys now; --force below removes the worktree even if a
    //    session is still holding it. (A daemon "kill session" op can be added later if a
    //    lingering pty on a removed worktree proves a problem in practice.)
    // 2) --force: a coding session may have left the tree dirty, and the UI already gated this
    //    behind a confirm (that IS the explicit dirty-tree handling). Branch is kept.
    let out = git_cmd(repo)
        .args(["worktree", "remove", "--force", &task.worktree])
        .output()
        .map_err(|e| format!("git worktree remove: {e}"))?;
    if !out.status.success() {
        return Err(format!("git worktree remove failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    record_removed_worktree_in(repo, &slug, &task.worktree)?;
    emit(
        app,
        alinery_core::TelemetryEvent::GitWorktreeRemove {
            source: alinery_core::TelemetrySource::App,
        },
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn remove_worktree(app: AppHandle, state: State<'_, AppState>, slug: String) -> Result<(), String> {
    let repo = require_owned_active_repo(&state)?;
    remove_worktree_in(&app, &repo, slug)
}

#[tauri::command]
pub(crate) fn remove_worktree_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, slug: String) -> Result<(), String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    remove_worktree_in(&app, &repo, slug)
}

// ---- M5 worktree existence check ---------------------------------------------
// The task's `worktree` path can go stale if the directory is removed outside the app
// (manually, or by a `git worktree remove` run outside alinery); this gives the frontend a
// live filesystem check instead of trusting the stored path.
#[tauri::command]
pub(crate) fn worktree_exists(slug: String) -> Result<bool, String> {
    let repo = active_repo()?;
    let task = read_task(&repo, &slug)?;
    if task.worktree.is_empty() {
        return Ok(false);
    }
    Ok(Path::new(&task.worktree).exists())
}

// ---- M5 PR compare URL -------------------------------------------------------
// Pure remote-URL -> compare-URL parsing (the whole PR feature minus the git shell-outs), so
// it's unit-testable with no network/remote. Handles ssh (git@host:owner/repo(.git) and
// ssh://[user@]host/owner/repo(.git)) and http(s). GitHub adds ?expand=1 to prefill the PR
// form; other forges (Gitea) use the bare compare path.
pub(crate) fn compare_url(remote: &str, base: &str, branch: &str) -> Option<String> {
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
    } else if let Some(rest) = remote.strip_prefix("http://") {
        rest.to_string()
    } else {
        return None;
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

// origin/HEAD is the remote default branch (e.g. "origin/main"); fall back to "main".
pub(crate) fn default_base_branch(repo: &Path) -> String {
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

pub(crate) fn record_pushed_url_in(repo: &Path, slug: &str, pushed_branch: &str, url: &str) -> Result<(), String> {
    alinery_core::mutate_task(repo, slug, "store pull request URL", |task| {
        if task.branch != pushed_branch {
            return Err("task branch changed during push".into());
        }
        task.pr_url = url.to_string();
        Ok(())
    })
}

// Push the task branch from its worktree, then build + store the forge compare URL.
pub(crate) fn push_and_compare_url_in(app: &AppHandle, repo: &Path, slug: String) -> Result<String, String> {
    let task = read_task(repo, &slug)?;
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
    record_pushed_url_in(repo, &slug, &task.branch, &url)?;
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
pub(crate) fn push_and_compare_url(app: AppHandle, state: State<'_, AppState>, slug: String) -> Result<String, String> {
    let repo = require_owned_active_repo(&state)?;
    push_and_compare_url_in(&app, &repo, slug)
}

#[tauri::command]
pub(crate) fn push_and_compare_url_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, slug: String) -> Result<String, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    push_and_compare_url_in(&app, &repo, slug)
}

// Hand-edit the PR link to the real PR URL once it exists (compare URL is just the prefill).
pub(crate) fn set_pr_url_in(repo: &Path, slug: String, url: String) -> Result<(), String> {
    let url = url.trim().to_string();
    alinery_core::mutate_task(repo, &slug, "set pull request URL", |task| {
        task.pr_url = url;
        Ok(())
    })
}

#[tauri::command]
pub(crate) fn set_pr_url(state: State<'_, AppState>, slug: String, url: String) -> Result<(), String> {
    let repo = require_owned_active_repo(&state)?;
    set_pr_url_in(&repo, slug, url)
}

#[tauri::command]
pub(crate) fn set_pr_url_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, slug: String, url: String) -> Result<(), String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    set_pr_url_in(&repo, slug, url)
}

// ---- commit-to-branch ---------------------------------------------------------
// Stage everything and commit in the task's working directory (dedicated worktree, or the
// main repo when the task opted out of one). Local commit only — no push. Protects in-progress
// code from remove_worktree's --force discard.
#[tauri::command]
pub(crate) fn commit_worktree(app: AppHandle, state: State<'_, AppState>, slug: String, message: String) -> Result<(), String> {
    let repo = require_owned_active_repo(&state)?;
    commit_worktree_in(&repo, slug, message)?;
    publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PostPushCommit);
    emit(
        &app,
        alinery_core::TelemetryEvent::GitCommit {
            source: alinery_core::TelemetrySource::App,
        },
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn commit_worktree_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, slug: String, message: String) -> Result<(), String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    commit_worktree_in(&repo, slug, message)?;
    publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PostPushCommit);
    Ok(())
}

pub(crate) fn commit_worktree_in(repo: &Path, slug: String, message: String) -> Result<(), String> {
    let task = read_task(repo, &slug)?;
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
