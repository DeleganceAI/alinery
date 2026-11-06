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
