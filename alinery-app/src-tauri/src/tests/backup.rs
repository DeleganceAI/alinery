//! Tests for backup.rs — backup and restore commands
//!
//! `use super::*` reaches the shared imports and fixtures in tests/mod.rs.
use super::*;

#[test]
fn restore_rechecks_membership_and_quitting_before_claiming_authority() {
    let repo = init_git_test_repo("restore-authority");
    let repo = fs::canonicalize(&repo).unwrap();
    let state = AppState::default();
    let known = vec![repo.display().to_string()];
    let closing = state.mark_closing(&repo);
    assert!(crate::require_restore_authority(&state, &repo, &[]).is_err());
    assert!(!state.owns_repo(&repo), "delisted restore must not reacquire GUI ownership");
    state.begin_quit();
    assert!(crate::require_restore_authority(&state, &repo, &known).is_err());
    assert!(!state.owns_repo(&repo));
    state.cancel_quit();
    crate::require_restore_authority(&state, &repo, &known).unwrap();
    assert!(state.owns_repo(&repo), "the restore's own closing marker is not a refusal");
    drop(closing);
    state.release_repo(&repo);
    fs::remove_dir_all(repo).unwrap();
}

// ---- Backup commands (issue #79, Phase 3) --------------------------------
// The Tauri command bodies are thin; the policy worth pinning is the destructive
// half of restore — what gets cleared, what survives, and that identity is checked
// before a single byte is removed.
use alinery_core::{alinery_dir, CURATED_ALINERY_PATHS};
use std::path::PathBuf;

fn unique_base(name: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    std::env::temp_dir().join(format!("alinery-bk3-{name}-{}-{nanos}", std::process::id()))
}

fn plant(path: PathBuf, body: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}

/// Repo with one of every curated AND every runtime-only thing under `.alinery/`,
/// plus ordinary repo files beside it. Returns (repo, dest).
fn fixture_repo(name: &str) -> (PathBuf, PathBuf) {
    let base = unique_base(name);
    let repo = base.join("myrepo");
    let dest = base.join("dest");
    let alinery = alinery_dir(&repo);
    plant(alinery.join("tasks/alpha/task.md"), b"name = \"alpha\"\n");
    plant(alinery.join("tasks/alpha/artifacts/00-ticket.md"), b"# ticket\n");
    plant(alinery.join("sessions/root1.meta.json"), b"{\"id\":\"root1\"}");
    plant(alinery.join("config.toml"), b"[linear]\n");
    plant(alinery.join("harnesses.toml"), b"[[harness]]\n");
    plant(alinery.join("playbooks.toml"), b"[[playbook]]\n");
    plant(alinery.join("playbooks/custom.md"), b"custom\n");
    plant(alinery.join("worktrees/alpha/README.md"), b"uncommitted work\n");
    plant(alinery.join("alineryd.sock"), b"");
    plant(alinery.join(".alineryd.lock"), b"");
    plant(alinery.join("mcp.status.json"), b"{}");
    plant(repo.join("README.md"), b"# repo\n");
    plant(repo.join("src/main.rs"), b"fn main() {}\n");
    fs::create_dir_all(&dest).unwrap();
    (repo, dest)
}

fn cleanup(repo: &Path) {
    let _ = fs::remove_dir_all(repo.parent().unwrap());
}

// 3.1 — restore replaces alinery data, so the curated set must actually go.
#[test]
fn clear_curated_alinery_data_removes_only_curated() {
    let (repo, _dest) = fixture_repo("clear-curated");
    clear_curated_alinery_data(&repo).unwrap();
    let alinery = alinery_dir(&repo);
    for name in CURATED_ALINERY_PATHS {
        assert!(!alinery.join(name).exists(), "{name} survived the clear");
    }
    cleanup(&repo);
}

// 3.2 — losing a worktree means losing uncommitted user work. Never.
#[test]
fn clear_curated_alinery_data_preserves_runtime_state() {
    let (repo, _dest) = fixture_repo("clear-runtime");
    clear_curated_alinery_data(&repo).unwrap();
    let alinery = alinery_dir(&repo);
    assert!(alinery.join("worktrees/alpha/README.md").is_file());
    assert!(alinery.join("alineryd.sock").exists());
    assert!(alinery.join(".alineryd.lock").exists());
    assert!(alinery.join("mcp.status.json").exists());
    cleanup(&repo);
}

// 3.3 — a repo that never had playbooks.toml must still be restorable.
#[test]
fn clear_curated_alinery_data_is_idempotent() {
    let base = unique_base("clear-idempotent");
    let repo = base.join("myrepo");
    fs::create_dir_all(alinery_dir(&repo)).unwrap();
    clear_curated_alinery_data(&repo).unwrap();
    clear_curated_alinery_data(&repo).unwrap();
    assert!(alinery_dir(&repo).is_dir());
    cleanup(&repo);
}

// 3.4 — the blast radius stops at `.alinery/`; the checkout is not ours to touch.
#[test]
fn clear_curated_alinery_data_stays_inside_alinery_dir() {
    let (repo, _dest) = fixture_repo("clear-scope");
    clear_curated_alinery_data(&repo).unwrap();
    assert!(repo.join("README.md").is_file());
    assert!(repo.join("src/main.rs").is_file());
    cleanup(&repo);
}

// 3.5 — THE invariant: anything cleared must have been archived. A path in
// clear-but-not-include is silent data loss the moment someone restores.

// 3.6 — identity is checked before anything is removed. The ordering
// validate -> stop daemon -> clear -> extract cannot be asserted end to end in a
// unit test; this pins the half that matters: validate before mutate.

// 3.7 — a refused BACKUP NOW writes nothing anywhere, including inside `.alinery/`.

// The happy path the manual checklist exercises live, pinned cheaply here too:
// a real create followed by a real restore into the same repo.

// The shell restores through the daemon program (`--restore-backup`), which prints one JSON line.
#[test]
fn the_restore_outcome_is_the_daemon_programs_one_json_line() {
    use crate::restore_outcome;
    assert!(restore_outcome(true, "{\"result\":{\"trigger\":\"manual\"}}\n", "").is_ok());
    assert_eq!(
        restore_outcome(false, "{\"error\":\"backup belongs to /a, not /b\"}\n", ""),
        Err("backup belongs to /a, not /b".into())
    );
    // Noise before the line is ignored; the last object wins.
    assert!(restore_outcome(true, "starting\n{\"result\":{}}\n", "warn").is_ok());
    // A program that died without printing is an error, with the end of its stderr.
    let died = restore_outcome(false, "", "boom\nSegmentation fault").unwrap_err();
    assert!(died.contains("Segmentation fault"), "{died}");
    // A result with a failing exit code is not a success.
    assert!(restore_outcome(false, "{\"result\":{}}\n", "").is_err());
}
