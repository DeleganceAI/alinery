//! Tests for backup.rs — backup and restore commands
//!
//! `use super::*` reaches the shared imports and fixtures in tests/mod.rs.
use super::*;

// ---- Backup commands (issue #79, Phase 3) --------------------------------
// The Tauri command bodies are thin; the policy worth pinning is the destructive
// half of restore — what gets cleared, what survives, and that identity is checked
// before a single byte is removed.
use alinery_core::{alinery_dir, create_backup, BackupDefaults, BackupTrigger, CURATED_ALINERY_PATHS};
use std::collections::BTreeSet;
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
    plant(
        alinery.join("canvas.json"),
        b"{\"version\":1,\"concepts\":[],\"placements\":{},\"relations\":[],\"view\":{\"camX\":0,\"camY\":0,\"scale\":1,\"autoArrange\":false}}\n",
    );
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

fn ready(dest: &Path) -> BackupDefaults {
    BackupDefaults {
        destination: dest.to_string_lossy().to_string(),
        enabled: true,
        retention: 10,
        ..Default::default()
    }
}

fn only_zip(dest: &Path) -> PathBuf {
    let zips: Vec<PathBuf> = fs::read_dir(dest)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|e| e == "zip").unwrap_or(false))
        .collect();
    assert_eq!(zips.len(), 1, "expected one zip in {dest:?}");
    zips.into_iter().next().unwrap()
}

fn alinery_entries(repo: &Path) -> BTreeSet<String> {
    fs::read_dir(alinery_dir(repo))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect()
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
#[test]
fn clear_set_equals_backup_include_set() {
    let (repo, dest) = fixture_repo("clear-equals-include");
    let meta = create_backup(&repo, &ready(&dest), BackupTrigger::Manual, "9.9.9").unwrap();
    let before = alinery_entries(&repo);
    clear_curated_alinery_data(&repo).unwrap();
    let after = alinery_entries(&repo);
    let cleared: BTreeSet<String> = before.difference(&after).cloned().collect();
    let archived: BTreeSet<String> = meta.included_dirs.iter().cloned().collect();
    assert_eq!(cleared, archived, "clear set and backup include set diverged: cleared={cleared:?} archived={archived:?}");
    cleanup(&repo);
}

// 3.6 — identity is checked before anything is removed. The ordering
// validate -> stop daemon -> clear -> extract cannot be asserted end to end in a
// unit test; this pins the half that matters: validate before mutate.
#[test]
fn restore_rejects_meta_repo_path_mismatch() {
    let (repo_a, dest) = fixture_repo("restore-mismatch-a");
    create_backup(&repo_a, &ready(&dest), BackupTrigger::Manual, "9.9.9").unwrap();
    let zip = only_zip(&dest);

    let (repo_b, _dest_b) = fixture_repo("restore-mismatch-b");
    let before = alinery_entries(&repo_b);
    assert!(restore_backup_into(&repo_b, &zip).is_err());
    assert_eq!(alinery_entries(&repo_b), before, "repo B was cleared anyway");
    assert!(alinery_dir(&repo_b).join("tasks/alpha/task.md").is_file());
    cleanup(&repo_a);
    cleanup(&repo_b);
}

// 3.7 — a refused BACKUP NOW writes nothing anywhere, including inside `.alinery/`.
#[test]
fn backup_now_errors_before_writing_when_dest_invalid() {
    let (repo, dest) = fixture_repo("backup-now-bad-dest");
    let before = alinery_entries(&repo);

    let mut unset = ready(&dest);
    unset.destination = String::new();
    assert!(backup_now_with(&repo, &unset).is_err());

    let inside = alinery_dir(&repo).join("backups");
    fs::create_dir_all(&inside).unwrap();
    let mut inner = ready(&dest);
    inner.destination = inside.to_string_lossy().to_string();
    assert!(backup_now_with(&repo, &inner).is_err());

    assert_eq!(fs::read_dir(&dest).unwrap().count(), 0, "a zip was written");
    assert!(fs::read_dir(&inside).unwrap().count() == 0, "wrote into .alinery/");
    let _ = fs::remove_dir_all(&inside);
    assert_eq!(alinery_entries(&repo), before, "alinery data changed on failure");
    cleanup(&repo);
}

// The happy path the manual checklist exercises live, pinned cheaply here too:
// a real create followed by a real restore into the same repo.
#[test]
fn restore_round_trips_curated_data_and_keeps_worktrees() {
    let (repo, dest) = fixture_repo("restore-round-trip");
    backup_now_with(&repo, &ready(&dest)).unwrap();
    let zip = only_zip(&dest);
    fs::write(alinery_dir(&repo).join("tasks/alpha/task.md"), b"clobbered").unwrap();

    restore_backup_into(&repo, &zip).unwrap();
    assert_eq!(fs::read(alinery_dir(&repo).join("tasks/alpha/task.md")).unwrap(), b"name = \"alpha\"\n");
    assert!(alinery_dir(&repo).join("sessions/root1.meta.json").is_file());
    assert!(alinery_dir(&repo).join("worktrees/alpha/README.md").is_file());
    assert!(alinery_dir(&repo).join("alineryd.sock").exists());
    cleanup(&repo);
}

#[test]
fn curated_paths_include_canvas_json() {
    assert!(
        CURATED_ALINERY_PATHS.contains(&"canvas.json"),
        "canvas.json must be in CURATED_ALINERY_PATHS so restore cannot drop the sidecar"
    );
}

#[test]
fn restore_round_trips_canvas_json() {
    let (repo, dest) = fixture_repo("restore-canvas-json");
    let path = alinery_dir(&repo).join("canvas.json");
    let original = fs::read(&path).unwrap();
    backup_now_with(&repo, &ready(&dest)).unwrap();
    let zip = only_zip(&dest);
    fs::write(&path, b"clobbered").unwrap();

    restore_backup_into(&repo, &zip).unwrap();
    assert_eq!(fs::read(&path).unwrap(), original, "restore must put canvas.json bytes back");
    cleanup(&repo);
}

#[test]
fn curated_paths_include_orbitron_agent() {
    assert!(
        CURATED_ALINERY_PATHS.contains(&"orbitron-agent"),
        "orbitron-agent must be in CURATED_ALINERY_PATHS so restore cannot drop the manager session dir"
    );
}

#[test]
fn restore_round_trips_orbitron_agent() {
    let (repo, dest) = fixture_repo("restore-orbitron-agent");
    let dir = alinery_dir(&repo).join("orbitron-agent");
    plant(dir.join("current.json"), br#"{"sessionFile":"sess.jsonl"}"#);
    plant(dir.join("sess.jsonl"), b"dummy\n");
    let original = fs::read(dir.join("current.json")).unwrap();
    backup_now_with(&repo, &ready(&dest)).unwrap();
    let zip = only_zip(&dest);
    fs::write(dir.join("current.json"), b"clobbered").unwrap();

    restore_backup_into(&repo, &zip).unwrap();
    assert_eq!(
        fs::read(dir.join("current.json")).unwrap(),
        original,
        "restore must put orbitron-agent/current.json bytes back"
    );
    cleanup(&repo);
}
