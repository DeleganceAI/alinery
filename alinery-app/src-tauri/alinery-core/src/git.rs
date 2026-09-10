// The only way this workspace spawns git.
//
// `git -C <dir>` changes git's working directory but does NOT override an inherited GIT_DIR:
// when GIT_DIR is set, git honours it regardless of `-C`, so the command operates on whatever
// repository the caller's environment points at instead of `dir`.
//
// That is not hypothetical. Git exports GIT_DIR (and its siblings) whenever it runs a hook, so
// anything alinery spawns from a hook — or from a shell that happens to have them set — inherits
// them. The test suite proved the damage first: `init_git_test_repo`'s `git init` + `git config`
// reinitialised the developer's *actual* repository, setting core.bare=true on it (which breaks
// `git status` in the clone and in every worktree) and writing a test identity into its config.
// The production paths are worse, not better: `git worktree add`, `git checkout -b` and
// `git commit` would land in the wrong repo.
//
// Every git invocation in the workspace goes through here; scripts/tests/check-git-env-scrub.sh
// enforces that.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

/// A `git -C <dir>` command with the repo-redirecting environment stripped.
pub fn git_cmd(dir: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir);
    for var in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_PREFIX",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_NAMESPACE",
    ] {
        cmd.env_remove(var);
    }
    cmd
}

/// Canonicalized top-level directory of the Git working tree containing `path`. The single
/// place that turns an arbitrary caller-supplied path into a trustworthy repo identity —
/// `git rev-parse --show-toplevel` rejects anything that is not a real, locally accessible
/// Git checkout, and canonicalizing the result means spelling/symlink differences never
/// produce two "different" identities for the same repo.
pub fn git_top_level(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err("repo path is empty".into());
    }
    let out = git_cmd(path).args(["rev-parse", "--show-toplevel"]).output().map_err(|e| format!("git rev-parse: {e}"))?;
    if !out.status.success() {
        return Err(format!("not a git repo: {}", path.display()));
    }
    let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if root.is_empty() {
        return Err(format!("git returned an empty repo root for {}", path.display()));
    }
    std::fs::canonicalize(&root).map_err(|e| format!("canonicalize {root}: {e}"))
}

/// Resolve a caller-requested repo path to its canonical Git top level, accepted only when
/// it matches an entry in `known_repos` or the calling process's own `process_repo` — no
/// auto-register, no silent fallback to any other repo. Shared by the app crate (targeted
/// create-form operations) and `alinery-mcp` (every per-call `repo` tool argument).
pub fn resolve_target_repo(requested: &str, process_repo: Option<&Path>, known_repos: &[String]) -> Result<PathBuf, String> {
    let target = git_top_level(Path::new(requested.trim()))?;
    let matches_process = process_repo.and_then(|p| git_top_level(p).ok()).is_some_and(|p| p == target);
    let matches_known = known_repos.iter().filter_map(|known| git_top_level(Path::new(known)).ok()).any(|known| known == target);
    if !matches_process && !matches_known {
        return Err(format!("repository is not in the known repository set: {}", target.display()));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Guards the list itself: `-C` is not enough, so every one of these must be cleared.
    #[test]
    fn git_cmd_clears_the_repo_redirecting_env() {
        let cmd = git_cmd("/tmp");
        let cleared: Vec<String> = cmd.get_envs().filter(|(_, v)| v.is_none()).map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        for var in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_PREFIX",
            "GIT_COMMON_DIR",
            "GIT_OBJECT_DIRECTORY",
            "GIT_NAMESPACE",
        ] {
            assert!(cleared.contains(&var.to_string()), "{var} is not cleared: {cleared:?}");
        }
    }

    // Real `git init` so `git rev-parse --show-toplevel` — what `resolve_target_repo` shells
    // out to — succeeds. A bare `.git/` directory is not enough (it rejects an uninitialized one).
    fn unique_repo(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let repo = std::env::temp_dir().join(format!("alinery-core-git-{name}-{nanos}"));
        std::fs::create_dir_all(&repo).unwrap();
        let init = git_cmd(&repo).args(["init"]).output().expect("git init");
        assert!(init.status.success(), "git init failed: {init:?}");
        repo
    }

    #[test]
    fn git_top_level_rejects_non_git_dir() {
        let dir = unique_repo_dir_only("not-a-repo");
        assert!(git_top_level(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // A plain (non-git-init'd) directory — distinct from `unique_repo`, which does init.
    fn unique_repo_dir_only(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("alinery-core-git-{name}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_target_repo_rejects_non_git_path() {
        let missing = unique_repo_dir_only("missing").join("does-not-exist");
        assert!(resolve_target_repo(missing.to_str().unwrap(), None, &[]).is_err());
    }

    #[test]
    fn resolve_target_repo_accepts_known_repo() {
        let repo = unique_repo("known");
        let known = vec![repo.to_string_lossy().into_owned()];
        let resolved = resolve_target_repo(repo.to_str().unwrap(), None, &known).expect("known repo must resolve");
        assert_eq!(resolved, std::fs::canonicalize(&repo).unwrap());
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn resolve_target_repo_accepts_process_repo_not_yet_known() {
        let repo = unique_repo("process-only");
        let resolved = resolve_target_repo(repo.to_str().unwrap(), Some(&repo), &[]).expect("process repo must resolve without being in known_repos");
        assert_eq!(resolved, std::fs::canonicalize(&repo).unwrap());
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn resolve_target_repo_rejects_repo_not_known_or_process() {
        let repo = unique_repo("unregistered");
        let other = unique_repo("other-process");
        let err = resolve_target_repo(repo.to_str().unwrap(), Some(&other), &[]).unwrap_err();
        assert!(err.contains("not in the known repository set"), "{err}");
        let _ = std::fs::remove_dir_all(repo);
        let _ = std::fs::remove_dir_all(other);
    }

    // Canonical equality: a trailing-slash spelling of an entry already in `known_repos`
    // must resolve to the exact same canonical path — spelling differences never produce
    // two "different" identities for one repo.
    #[test]
    fn resolve_target_repo_treats_trailing_slash_as_the_same_repo() {
        let repo = unique_repo("spelling");
        let known = vec![repo.to_string_lossy().into_owned()];
        let with_trailing_slash = format!("{}/", repo.display());
        let resolved = resolve_target_repo(&with_trailing_slash, None, &known).expect("trailing-slash spelling must resolve to the same known repo");
        assert_eq!(resolved, std::fs::canonicalize(&repo).unwrap());
        let _ = std::fs::remove_dir_all(repo);
    }
}
