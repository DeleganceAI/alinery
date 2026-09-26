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
//
// Resolution order, first hit wins:
//   1. `ALINERY_GIT_PATH` when that file exists (tests / dev override)
//   2. the first usable `git` on this process's PATH
//   3. the alongside tree install.sh placed (`Alinery.git/bin/git`, or `git/bin/git` on Linux)
//   4. the bare name `git`, so a missing binary still fails the way it always has
//
// macOS `/usr/bin/git` is a stub when the Command Line Tools are not installed. Running it
// raises the installer dialog, so it is not "usable". A Dock-launched app does not see
// Homebrew's PATH; step 2 is this process's PATH, and the installer uses the same rule
// when deciding whether to copy the alongside tree at all.
//
// The alongside binary is a relocatable tree. `GIT_EXEC_PATH` points it at its own
// `libexec/git-core` (so `git push` over https can exec `git-remote-https`). A system git
// keeps whatever exec path it was built with — we do not set the variable, and we do not
// scrub a caller-supplied one. On macOS the alongside tree also gets
// `-c credential.helper=osxkeychain` when that helper was built into it; a GUI push has
// no tty to ask for a password.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitProgram {
    program: PathBuf,
    /// True only for the alongside tree or an `ALINERY_GIT_PATH` whose layout is that tree.
    /// A git found on PATH is never bundled, even when its own libexec sits beside it
    /// (Homebrew). Forcing our exec path and credential helper onto that git would
    /// override the user's helper.
    bundled: bool,
}

/// A `git -C <dir>` command with the repo-redirecting environment stripped.
pub fn git_cmd(dir: impl AsRef<OsStr>) -> Command {
    git_command(dir, &resolve_git_program())
}

fn git_command(dir: impl AsRef<OsStr>, selected: &GitProgram) -> Command {
    let mut cmd = Command::new(&selected.program);
    cmd.arg("-C").arg(dir);
    if selected.bundled {
        if let Some(exec_path) = git_tree_exec_path(&selected.program) {
            cmd.env("GIT_EXEC_PATH", &exec_path);
            let helper = exec_path.join("git-credential-osxkeychain");
            if cfg!(target_os = "macos") && helper.is_file() {
                cmd.arg("-c").arg("credential.helper=osxkeychain");
            }
        }
    }
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

fn resolve_git_program() -> GitProgram {
    let override_path = std::env::var_os("ALINERY_GIT_PATH").filter(|value| !value.is_empty()).map(PathBuf::from);
    let alongside = crate::paths::installed_git_binary();
    let alongside = alongside.is_file().then_some(alongside);
    select_git_program(override_path.as_deref(), &path_git_candidates(), alongside.as_deref())
}

fn select_git_program(override_path: Option<&Path>, path_candidates: &[PathBuf], alongside: Option<&Path>) -> GitProgram {
    if let Some(path) = override_path {
        if path.is_file() {
            return GitProgram { program: path.to_path_buf(), bundled: git_tree_exec_path(path).is_some() };
        }
    }
    if let Some(path) = path_candidates.first() {
        return GitProgram { program: path.clone(), bundled: false };
    }
    if let Some(path) = alongside {
        if path.is_file() {
            return GitProgram { program: path.to_path_buf(), bundled: true };
        }
    }
    GitProgram { program: PathBuf::from("git"), bundled: false }
}

/// `…/bin/git` → `…/libexec/git-core`, when that directory exists.
fn git_tree_exec_path(program: &Path) -> Option<PathBuf> {
    let bin_dir = program.parent()?;
    if bin_dir.file_name()? != "bin" {
        return None;
    }
    let exec_path = bin_dir.parent()?.join("libexec").join("git-core");
    exec_path.is_dir().then_some(exec_path)
}

/// macOS ships `/usr/bin/git` as an xcode-select stub. It is not a git until the developer
/// directory exists. Anywhere else — including Linux `/usr/bin/git` — the path is a real
/// candidate. `developer_dir_present` is passed in so tests do not run `xcode-select`.
fn skips_macos_git_stub(path: &Path, developer_dir_present: bool) -> bool {
    cfg!(target_os = "macos") && path == Path::new("/usr/bin/git") && !developer_dir_present
}

fn path_git_candidates() -> Vec<PathBuf> {
    let Some(path_var) = std::env::var_os("PATH") else {
        return Vec::new();
    };
    let developer_dir = developer_dir_present();
    for dir in std::env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join("git");
        if skips_macos_git_stub(&candidate, developer_dir) {
            continue;
        }
        if is_executable_file(&candidate) {
            return vec![candidate];
        }
    }
    Vec::new()
}

fn developer_dir_present() -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        Command::new("xcode-select")
            .arg("-p")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    })
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub(crate) fn branch_is_parent(parent: &str, branch: &str) -> bool {
    branch.strip_prefix(parent).is_some_and(|suffix| suffix.starts_with('/'))
}

/// Git refs conflict on equality or a slash boundary, not merely a shared prefix.
pub fn branch_names_conflict(existing: &str, candidate: &str) -> bool {
    existing == candidate || branch_is_parent(existing, candidate) || branch_is_parent(candidate, existing)
}

/// Absolute paths of every worktree Git has registered in `repo`, including missing (prunable)
/// and locked ones. `worktree list --porcelain` reports them all from the registry, not the
/// filesystem, so this is the truth about which paths Git reserves. Fail-closed: callers must
/// never treat an unreadable registry as empty.
pub fn registered_worktree_paths(repo: &Path) -> Result<Vec<PathBuf>, String> {
    let output = git_cmd(repo)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| format!("git worktree list: {e}"))?;
    if !output.status.success() {
        return Err(format!("git worktree list: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix("worktree ").map(PathBuf::from))
        .collect())
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
    use std::ffi::OsString;

    fn env_value(cmd: &Command, key: &str) -> Option<OsString> {
        cmd.get_envs().find(|(k, _)| *k == key).and_then(|(_, value)| value.map(OsString::from))
    }

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

    #[test]
    fn macos_stub_is_skipped_only_without_a_developer_dir() {
        let stub = Path::new("/usr/bin/git");
        let homebrew = Path::new("/opt/homebrew/bin/git");
        if cfg!(target_os = "macos") {
            assert!(skips_macos_git_stub(stub, false));
            assert!(!skips_macos_git_stub(stub, true));
            assert!(!skips_macos_git_stub(homebrew, false));
        } else {
            assert!(!skips_macos_git_stub(stub, false));
            assert!(!skips_macos_git_stub(stub, true));
        }
    }

    #[test]
    fn path_git_beats_an_alongside_tree() {
        let path_git = PathBuf::from("/usr/local/bin/git");
        let alongside = PathBuf::from("/Applications/Alinery.git/bin/git");
        let candidates = [path_git.clone()];
        let selected = select_git_program(None, &candidates, Some(&alongside));
        assert_eq!(selected.program, path_git);
        assert!(!selected.bundled);
    }

    #[test]
    fn alongside_tree_is_used_when_path_has_no_git() {
        let alongside = unique_git_tree("alongside");
        let program = alongside.join("bin/git");
        let selected = select_git_program(None, &[], Some(&program));
        assert_eq!(selected.program, program);
        assert!(selected.bundled);
        let _ = std::fs::remove_dir_all(alongside);
    }

    #[test]
    fn missing_everywhere_falls_through_to_the_name_git() {
        let missing = PathBuf::from("/no/such/alinery-git");
        let selected = select_git_program(Some(&missing), &[], Some(&missing));
        assert_eq!(selected.program, PathBuf::from("git"));
        assert!(!selected.bundled);
    }

    #[test]
    fn override_beats_path_and_alongside() {
        let tree = unique_git_tree("override");
        let program = tree.join("bin/git");
        let selected = select_git_program(Some(&program), &[PathBuf::from("/usr/bin/git")], Some(Path::new("/Applications/Alinery.git/bin/git")));
        assert_eq!(selected.program, program);
        assert!(selected.bundled);
        let _ = std::fs::remove_dir_all(tree);
    }

    #[test]
    fn bundled_tree_sets_exec_path_and_not_the_repo_scrub() {
        let tree = unique_git_tree("exec-path");
        let program = tree.join("bin/git");
        std::fs::write(tree.join("libexec/git-core/git-credential-osxkeychain"), b"helper").unwrap();
        let selected = select_git_program(Some(&program), &[], None);
        let cmd = git_command(Path::new("/tmp/repo"), &selected);
        assert_eq!(env_value(&cmd, "GIT_EXEC_PATH").as_deref(), Some(tree.join("libexec/git-core").as_os_str()));
        let cleared: Vec<String> = cmd.get_envs().filter(|(_, v)| v.is_none()).map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        assert!(cleared.iter().any(|name| name == "GIT_DIR"));
        assert!(!cleared.iter().any(|name| name == "GIT_EXEC_PATH"));
        #[cfg(target_os = "macos")]
        {
            let args: Vec<String> = cmd.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
            assert!(args.windows(2).any(|pair| pair[0] == "-c" && pair[1] == "credential.helper=osxkeychain"), "{args:?}");
        }
        let _ = std::fs::remove_dir_all(tree);
    }

    #[test]
    fn system_git_sets_neither_exec_path_nor_credential_helper() {
        let selected = GitProgram { program: PathBuf::from("/usr/bin/git"), bundled: false };
        let cmd = git_command(Path::new("/tmp/repo"), &selected);
        assert!(env_value(&cmd, "GIT_EXEC_PATH").is_none());
        let args: Vec<String> = cmd.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert!(!args.iter().any(|arg| arg == "credential.helper=osxkeychain"), "{args:?}");
        assert_eq!(args.first().map(String::as_str), Some("-C"));
    }

    fn unique_git_tree(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("alinery-core-git-tree-{name}-{nanos}"));
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(root.join("libexec/git-core")).unwrap();
        std::fs::write(root.join("bin/git"), b"#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root.join("bin/git"), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        root
    }
}
