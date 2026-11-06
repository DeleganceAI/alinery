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

use serde::Serialize;
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
    scrub_git_env(&mut cmd);
    cmd
}

/// Payload for `git credential fill` against github.com. The blank line terminates
/// the request. No `gh` binary: the user's configured credential helper answers.
pub const GITHUB_CREDENTIAL_FILL: &str = "protocol=https\nhost=github.com\n\n";

pub struct GitCredential {
    pub username: String,
    pub secret: String,
}

/// Run `git credential fill`. `Ok(None)` is "git ran and has no credential" (the
/// normal logged-out state). `Err` is git missing or the helper hanging past 5s.
/// `GIT_TERMINAL_PROMPT=0` so a GUI launch does not block on a password prompt.
/// Does not force `credential.helper=osxkeychain` — that override is only for
/// bundled `git push`, and here it would hide the helper the user actually configured.
pub fn git_credential_fill(input: &str) -> Result<Option<GitCredential>, String> {
    let selected = resolve_git_program();
    let mut cmd = Command::new(&selected.program);
    cmd.arg("credential").arg("fill");
    if selected.bundled {
        if let Some(exec_path) = git_tree_exec_path(&selected.program) {
            cmd.env("GIT_EXEC_PATH", exec_path);
        }
    }
    scrub_git_env(&mut cmd);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("git credential fill: {e}"))?;
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().ok_or_else(|| "git credential fill: stdin unavailable".to_string())?;
        stdin.write_all(input.as_bytes()).map_err(|e| format!("git credential fill: {e}"))?;
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut bytes = Vec::new();
        if let Some(mut pipe) = stdout {
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    });
    let stderr_reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut bytes = Vec::new();
        if let Some(mut pipe) = stderr {
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err("git credential fill timed out".into());
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(error) => return Err(format!("git credential fill: {error}")),
        }
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let _ = stderr_reader.join();
    if !status.success() {
        return Ok(None);
    }
    Ok(parse_git_credential(&String::from_utf8_lossy(&stdout)))
}

fn scrub_git_env(cmd: &mut Command) {
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
}

fn parse_git_credential(text: &str) -> Option<GitCredential> {
    let mut username = None;
    let mut secret = None;
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("username=") {
            username = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("password=") {
            secret = Some(value.to_string());
        }
    }
    let secret = secret.filter(|value| !value.is_empty())?;
    Some(GitCredential {
        username: username.unwrap_or_default(),
        secret,
    })
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
            return GitProgram {
                program: path.to_path_buf(),
                bundled: git_tree_exec_path(path).is_some(),
            };
        }
    }
    if let Some(path) = path_candidates.first() {
        return GitProgram {
            program: path.clone(),
            bundled: false,
        };
    }
    if let Some(path) = alongside {
        if path.is_file() {
            return GitProgram {
                program: path.to_path_buf(),
                bundled: true,
            };
        }
    }
    GitProgram {
        program: PathBuf::from("git"),
        bundled: false,
    }
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
    match rev_parse_show_toplevel(path) {
        ToplevelProbe::Root(root) => Ok(root),
        // Keep the historical prefix so existing callers and tests still match it, and
        // keep Git's own stderr — a bare "not a git repo" hid the reason.
        ToplevelProbe::Rejected { detail } => Err(format!("not a git repo: {}\n{detail}", path.display())),
        ToplevelProbe::Failed { detail } => Err(detail),
    }
}

/// The same probe as `git_top_level`, worded for an open that must not offer `git init`.
/// `Err` is the user-facing sentence plus the probe detail. It does not parse the
/// `not a git repo` prefix.
pub fn require_working_tree(path: &Path) -> Result<PathBuf, String> {
    match rev_parse_show_toplevel(path) {
        ToplevelProbe::Root(root) => Ok(root),
        ToplevelProbe::Rejected { detail } | ToplevelProbe::Failed { detail } => Err(couldnt_open(&path.display().to_string(), &detail)),
    }
}

enum ToplevelProbe {
    Root(PathBuf),
    /// Git ran and rejected this path as a working tree.
    Rejected {
        detail: String,
    },
    /// Empty path, spawn failure, empty stdout, or a canonicalize failure.
    Failed {
        detail: String,
    },
}

fn rev_parse_show_toplevel(path: &Path) -> ToplevelProbe {
    if path.as_os_str().is_empty() {
        return ToplevelProbe::Failed {
            detail: "repo path is empty".into(),
        };
    }
    let out = match git_cmd(path).args(["rev-parse", "--show-toplevel"]).output() {
        Ok(out) => out,
        Err(e) => {
            return ToplevelProbe::Failed {
                detail: format!("git rev-parse: {e}"),
            }
        }
    };
    if !out.status.success() {
        return ToplevelProbe::Rejected { detail: git_detail(&out.stderr) };
    }
    let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if root.is_empty() {
        return ToplevelProbe::Failed {
            detail: format!("git returned an empty repo root for {}", path.display()),
        };
    }
    match std::fs::canonicalize(&root) {
        Ok(root) => ToplevelProbe::Root(root),
        Err(e) => ToplevelProbe::Failed {
            detail: format!("canonicalize {root}: {e}"),
        },
    }
}

enum GitDirProbe {
    Found,
    /// Git ran and did not report a git dir.
    Rejected {
        detail: String,
    },
    Failed {
        detail: String,
    },
}

fn rev_parse_git_dir(path: &Path) -> GitDirProbe {
    let out = match git_cmd(path).args(["rev-parse", "--git-dir"]).output() {
        Ok(out) => out,
        Err(e) => {
            return GitDirProbe::Failed {
                detail: format!("git rev-parse: {e}"),
            }
        }
    };
    if !out.status.success() {
        return GitDirProbe::Rejected { detail: git_detail(&out.stderr) };
    }
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if dir.is_empty() {
        return GitDirProbe::Failed {
            detail: "git returned an empty git dir".into(),
        };
    }
    GitDirProbe::Found
}

fn git_detail(stderr: &[u8]) -> String {
    spoken_detail(&String::from_utf8_lossy(stderr))
}

fn spoken_detail(detail: &str) -> String {
    let trimmed = detail.trim();
    if trimmed.is_empty() {
        "Git did not say why.".to_string()
    } else {
        trimmed.to_string()
    }
}

fn with_detail(sentence: &str, detail: &str) -> String {
    format!("{sentence}\n{}", spoken_detail(detail))
}

fn couldnt_initialize(path: &Path, detail: &str) -> String {
    format!("Couldn't initialize Git in {}.\n{}", path.display(), spoken_detail(detail))
}

fn couldnt_open(path: &str, detail: &str) -> String {
    format!("Couldn't open {path}: it is not a Git working tree.\n{}", spoken_detail(detail))
}

const NOT_A_WORK_TREE: &str = "This folder is a Git repository, but not a working tree. Alinery will not initialize a new repository here.";
const HAS_GIT_ENTRY: &str = "This folder already has a Git entry that is not a usable checkout. Alinery will not initialize over it.";

/// What a picked folder is, before any init or open.
///
/// A failed `git_top_level` is not safe to init. A bare repo and a checkout's `.git`
/// directory both fail `--show-toplevel`, and `git init` there nests another repository.
/// Only `Absent` may be initialized.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FolderClass {
    Checkout { root: PathBuf },
    Absent { path: PathBuf },
    Refused { message: String },
}

/// Result of trying to init a folder that was classified `Absent`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InitFolder {
    Initialized { root: PathBuf },
    AlreadyCheckout { root: PathBuf },
}

pub fn classify_folder(path: &Path) -> Result<FolderClass, String> {
    if path.as_os_str().is_empty() {
        return Err(couldnt_initialize(path, "repo path is empty"));
    }
    // `is_dir` follows symlinks, so a symlink to a directory is classified as that
    // directory. A broken symlink is missing.
    if !path.exists() {
        return Err(couldnt_initialize(path, "folder does not exist"));
    }
    if !path.is_dir() {
        return Err(couldnt_initialize(path, "path is not a directory"));
    }

    let toplevel_detail = match rev_parse_show_toplevel(path) {
        ToplevelProbe::Root(root) => return Ok(FolderClass::Checkout { root }),
        ToplevelProbe::Failed { detail } => return Err(couldnt_initialize(path, &detail)),
        ToplevelProbe::Rejected { detail } => detail,
    };

    // `--git-dir` before the filesystem `.git` check. A bare repo and a picked `.git`
    // directory have no `.git` child, so the filesystem check alone would call them absent.
    match rev_parse_git_dir(path) {
        GitDirProbe::Found => Ok(FolderClass::Refused {
            message: with_detail(NOT_A_WORK_TREE, &toplevel_detail),
        }),
        GitDirProbe::Failed { detail } => Err(couldnt_initialize(path, &detail)),
        GitDirProbe::Rejected { detail } => {
            if git_entry_exists(path) {
                Ok(FolderClass::Refused {
                    message: with_detail(HAS_GIT_ENTRY, &prefer_probe_detail(&toplevel_detail, &detail)),
                })
            } else {
                match std::fs::canonicalize(path) {
                    Ok(canonical) => Ok(FolderClass::Absent { path: canonical }),
                    Err(e) => Err(couldnt_initialize(path, &format!("canonicalize {}: {e}", path.display()))),
                }
            }
        }
    }
}

/// `symlink_metadata` so a broken `.git` symlink still counts as an entry.
fn git_entry_exists(path: &Path) -> bool {
    path.join(".git").symlink_metadata().is_ok()
}

fn prefer_probe_detail(toplevel: &str, git_dir: &str) -> String {
    if toplevel != "Git did not say why." {
        toplevel.to_string()
    } else {
        git_dir.to_string()
    }
}

/// Re-classifies immediately before writing. A folder that became a working tree while
/// the confirm was open is returned as `AlreadyCheckout` and is not re-initialized.
/// A root that does not match the canonical directory is not opened and is not deleted.
pub fn init_absent_folder(path: &Path) -> Result<InitFolder, String> {
    match classify_folder(path)? {
        FolderClass::Checkout { root } => Ok(InitFolder::AlreadyCheckout { root }),
        FolderClass::Refused { message } => Err(message),
        FolderClass::Absent { path: canonical } => init_canonical(&canonical),
    }
}

fn init_canonical(canonical: &Path) -> Result<InitFolder, String> {
    let init = match git_cmd(canonical).args(["init"]).output() {
        Ok(out) => out,
        Err(e) => return Err(couldnt_initialize(canonical, &format!("git init: {e}"))),
    };
    if !init.status.success() {
        return Err(couldnt_initialize(canonical, &git_detail(&init.stderr)));
    }
    match rev_parse_show_toplevel(canonical) {
        ToplevelProbe::Root(root) if root == canonical => Ok(InitFolder::Initialized { root }),
        ToplevelProbe::Root(root) => Err(couldnt_initialize(
            canonical,
            &format!("working tree root is {}, not {}", root.display(), canonical.display()),
        )),
        ToplevelProbe::Rejected { detail } | ToplevelProbe::Failed { detail } => Err(couldnt_initialize(canonical, &detail)),
    }
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
        let err = git_top_level(&dir).unwrap_err();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(err.contains("not a git repo"), "{err}");
        assert!(err.contains("not a git repository"), "{err}");
    }

    struct RestoreEnv {
        key: &'static str,
        prev: Option<std::ffi::OsString>,
    }

    impl RestoreEnv {
        fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
            let prev = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, prev }
        }
    }

    impl Drop for RestoreEnv {
        fn drop(&mut self) {
            match self.prev.take() {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    fn assert_absent(path: &Path) -> PathBuf {
        match classify_folder(path).unwrap() {
            FolderClass::Absent { path } => path,
            other => panic!("expected Absent, got {other:?}"),
        }
    }

    fn assert_checkout(path: &Path) -> PathBuf {
        match classify_folder(path).unwrap() {
            FolderClass::Checkout { root } => root,
            other => panic!("expected Checkout, got {other:?}"),
        }
    }

    fn assert_refused(path: &Path) -> String {
        match classify_folder(path).unwrap() {
            FolderClass::Refused { message } => message,
            other => panic!("expected Refused, got {other:?}"),
        }
    }

    #[test]
    fn plain_directory_and_directory_with_a_file_are_absent() {
        let plain = unique_repo_dir_only("plain");
        let with_file = unique_repo_dir_only("with-file");
        std::fs::write(with_file.join("note.txt"), b"hello").unwrap();
        let plain_class = assert_absent(&plain);
        let file_class = assert_absent(&with_file);
        assert_eq!(plain_class, std::fs::canonicalize(&plain).unwrap());
        assert_eq!(file_class, std::fs::canonicalize(&with_file).unwrap());
        let _ = std::fs::remove_dir_all(plain);
        let _ = std::fs::remove_dir_all(with_file);
    }

    #[test]
    fn child_symlink_and_linked_worktree_are_the_toplevel_checkout() {
        let repo = unique_repo("parent");
        let child = repo.join("nested");
        std::fs::create_dir(&child).unwrap();
        let parent_root = git_top_level(&repo).unwrap();
        assert_eq!(assert_checkout(&child), parent_root);

        let link_parent = unique_repo_dir_only("link-parent");
        let link = link_parent.join("link");
        std::os::unix::fs::symlink(&repo, &link).unwrap();
        assert_eq!(assert_checkout(&link), parent_root);

        let linked = unique_repo_dir_only("linked-worktree");
        let _ = std::fs::remove_dir_all(&linked);
        let added = git_cmd(&repo).args(["worktree", "add", "-b", "feature"]).arg(&linked).output().unwrap();
        assert!(added.status.success(), "{}", String::from_utf8_lossy(&added.stderr));
        let linked_root = git_top_level(&linked).unwrap();
        assert_eq!(assert_checkout(&linked), linked_root);
        assert_ne!(linked_root, parent_root);

        let _ = std::fs::remove_dir_all(&linked);
        let _ = std::fs::remove_dir_all(link_parent);
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn bare_repo_and_git_directory_are_refused_and_not_nested() {
        let parent = unique_repo_dir_only("bare-parent");
        let bare = parent.join("bare.git");
        let init = git_cmd(&parent).args(["init", "--bare"]).arg(&bare).output().unwrap();
        assert!(init.status.success(), "{}", String::from_utf8_lossy(&init.stderr));
        let bare_message = assert_refused(&bare);
        assert!(bare_message.contains(NOT_A_WORK_TREE), "{bare_message}");
        let bare_init = init_absent_folder(&bare).unwrap_err();
        assert!(bare_init.contains(NOT_A_WORK_TREE), "{bare_init}");
        assert!(!bare.join(".git").exists(), "init must not nest a .git inside a bare repo");

        let repo = unique_repo("dot-git");
        let git_dir = repo.join(".git");
        let git_message = assert_refused(&git_dir);
        assert!(git_message.contains(NOT_A_WORK_TREE), "{git_message}");
        let git_init = init_absent_folder(&git_dir).unwrap_err();
        assert!(git_init.contains(NOT_A_WORK_TREE), "{git_init}");
        assert!(!git_dir.join(".git").exists(), "init must not nest .git/.git");

        let _ = std::fs::remove_dir_all(parent);
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn broken_git_entries_are_refused_and_unchanged() {
        let empty = unique_repo_dir_only("empty-git");
        std::fs::create_dir(empty.join(".git")).unwrap();
        let empty_message = assert_refused(&empty);
        assert!(empty_message.contains(HAS_GIT_ENTRY), "{empty_message}");
        let empty_init = init_absent_folder(&empty).unwrap_err();
        assert!(empty_init.contains(HAS_GIT_ENTRY), "{empty_init}");
        assert!(std::fs::read_dir(empty.join(".git")).unwrap().next().is_none());

        let missing_head = unique_repo("missing-head");
        std::fs::remove_file(missing_head.join(".git/HEAD")).unwrap();
        let config_before = std::fs::read(missing_head.join(".git/config")).unwrap();
        let head_message = assert_refused(&missing_head);
        assert!(head_message.contains("will not initialize"), "{head_message}");
        let head_init = init_absent_folder(&missing_head).unwrap_err();
        assert!(head_init.contains("will not initialize"), "{head_init}");
        assert!(!missing_head.join(".git/HEAD").exists());
        assert_eq!(std::fs::read(missing_head.join(".git/config")).unwrap(), config_before);

        let garbage = unique_repo_dir_only("garbage-git");
        std::fs::write(garbage.join(".git"), b"not-a-gitfile").unwrap();
        let garbage_message = assert_refused(&garbage);
        assert!(garbage_message.contains(HAS_GIT_ENTRY), "{garbage_message}");
        let garbage_init = init_absent_folder(&garbage).unwrap_err();
        assert!(garbage_init.contains(HAS_GIT_ENTRY), "{garbage_init}");
        assert_eq!(std::fs::read(garbage.join(".git")).unwrap(), b"not-a-gitfile");

        let _ = std::fs::remove_dir_all(empty);
        let _ = std::fs::remove_dir_all(missing_head);
        let _ = std::fs::remove_dir_all(garbage);
    }

    #[test]
    fn inherited_git_dir_does_not_classify_or_init_the_other_repo() {
        let other = unique_repo("inherited-target");
        let plain = unique_repo_dir_only("inherited-plain");
        let other_config = std::fs::read(other.join(".git/config")).unwrap();
        let _guard = RestoreEnv::set("GIT_DIR", other.join(".git"));
        let class = assert_absent(&plain);
        assert_eq!(class, std::fs::canonicalize(&plain).unwrap());
        match init_absent_folder(&plain).unwrap() {
            InitFolder::Initialized { root } => assert_eq!(root, std::fs::canonicalize(&plain).unwrap()),
            other => panic!("expected Initialized, got {other:?}"),
        }
        drop(_guard);
        assert!(plain.join(".git").is_dir());
        assert!(!other.join(".git").join(".git").exists());
        assert_eq!(std::fs::read(other.join(".git/config")).unwrap(), other_config);
        let _ = std::fs::remove_dir_all(other);
        let _ = std::fs::remove_dir_all(plain);
    }

    #[test]
    fn init_absent_folder_inits_without_user_name() {
        let dir = unique_repo_dir_only("init-plain");
        let canonical = std::fs::canonicalize(&dir).unwrap();
        match init_absent_folder(&dir).unwrap() {
            InitFolder::Initialized { root } => assert_eq!(root, canonical),
            other => panic!("expected Initialized, got {other:?}"),
        }
        assert_eq!(git_top_level(&dir).unwrap(), canonical);
        let config = std::fs::read_to_string(dir.join(".git/config")).unwrap();
        assert!(!config.contains("user.name"), "{config}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn init_absent_folder_does_not_reinit_an_existing_checkout() {
        let repo = unique_repo("already");
        let config = std::fs::read(repo.join(".git/config")).unwrap();
        let head = std::fs::read(repo.join(".git/HEAD")).unwrap();
        match init_absent_folder(&repo).unwrap() {
            InitFolder::AlreadyCheckout { root } => assert_eq!(root, git_top_level(&repo).unwrap()),
            other => panic!("expected AlreadyCheckout, got {other:?}"),
        }
        assert_eq!(std::fs::read(repo.join(".git/config")).unwrap(), config);
        assert_eq!(std::fs::read(repo.join(".git/HEAD")).unwrap(), head);
        let _ = std::fs::remove_dir_all(repo);
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
    fn credential_fill_parses_username_and_secret() {
        let parsed = parse_git_credential("protocol=https\nhost=github.com\nusername=octocat\npassword=gho_secret\n").expect("credential");
        assert_eq!(parsed.username, "octocat");
        assert_eq!(parsed.secret, "gho_secret");
        assert!(parse_git_credential("username=octocat\npassword=\n").is_none());
        assert!(parse_git_credential("protocol=https\n").is_none());
    }

    #[test]
    fn system_git_sets_neither_exec_path_nor_credential_helper() {
        let selected = GitProgram {
            program: PathBuf::from("/usr/bin/git"),
            bundled: false,
        };
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
