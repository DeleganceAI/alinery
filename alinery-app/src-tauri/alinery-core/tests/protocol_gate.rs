//! Wire/config-identity gate decision table and poller safety table.
//!
//! Pure logic only — no sockets, no processes, no filesystem. This is the table that
//! decides whether a running `alineryd` may be reused. Protocol equality prevents current
//! app code from speaking an incompatible wire; config-identity equality prevents a
//! dev app from adopting a daemon that captured the production `app.toml`. Neither
//! mismatch may kill the daemon or its live sessions.

use alinery_core::{daemon_compat, poller_action, DaemonCompat, PollerAction, PROTOCOL_VERSION};

const APP_BUILD: &str = "app-build-aaaa";
const APP_CONFIG_IDENTITY: &str = "config-aaaa";

fn compat(daemon_protocol: Option<u32>, daemon_build: Option<&str>, daemon_config_identity: Option<&str>) -> DaemonCompat {
    daemon_compat(daemon_protocol, daemon_build, daemon_config_identity, APP_BUILD, APP_CONFIG_IDENTITY)
}

#[test]
fn matching_protocol_and_build_is_current() {
    assert_eq!(compat(Some(PROTOCOL_VERSION), Some(APP_BUILD), Some(APP_CONFIG_IDENTITY),), DaemonCompat::Current);
}

#[test]
fn matching_protocol_with_different_build_stays_usable() {
    // The whole bug: Rust builds are not byte-reproducible, so `build_id` differs on
    // every release even when `alineryd/` is byte-identical. Build drift is a display
    // signal (A6) and must never refuse — let alone kill — a running daemon (A4).
    let compat = compat(Some(PROTOCOL_VERSION), Some("daemon-build-bbbb"), Some(APP_CONFIG_IDENTITY));
    assert_eq!(compat, DaemonCompat::BuildDrift);
    assert!(compat.usable(), "build drift must never refuse the daemon");
}

#[test]
fn unknown_build_id_does_not_refuse_a_matching_protocol() {
    let compat = compat(Some(PROTOCOL_VERSION), None, Some(APP_CONFIG_IDENTITY));
    assert_eq!(compat, DaemonCompat::BuildDrift);
    assert!(compat.usable());
}

#[test]
fn newer_daemon_protocol_is_incompatible_even_when_build_matches() {
    let compat = compat(Some(PROTOCOL_VERSION + 1), Some(APP_BUILD), Some(APP_CONFIG_IDENTITY));
    assert_eq!(compat, DaemonCompat::ProtocolMismatch);
    assert!(!compat.usable());
}

#[test]
fn older_daemon_protocol_is_incompatible() {
    // Guards the `PROTOCOL_VERSION - 1` below: at 0 it would underflow. A const assert
    // fails the build rather than this one test, which is where that mistake belongs.
    const _: () = assert!(PROTOCOL_VERSION >= 1, "protocol numbering starts at 1");
    assert_eq!(
        compat(Some(PROTOCOL_VERSION - 1), Some(APP_BUILD), Some(APP_CONFIG_IDENTITY),),
        DaemonCompat::ProtocolMismatch
    );
}

#[test]
fn missing_protocol_field_is_incompatible() {
    // A pre-gate daemon replies with `build_id` only. It genuinely predates the gate,
    // so a missing field is incompatible — the first release carrying A2/A3 always
    // takes this branch against a still-running old daemon. Correct, not a bug.
    assert_eq!(compat(None, Some(APP_BUILD), Some(APP_CONFIG_IDENTITY)), DaemonCompat::ProtocolMismatch);
    assert_eq!(compat(None, None, Some(APP_CONFIG_IDENTITY)), DaemonCompat::ProtocolMismatch);
}

#[test]
fn mismatched_config_identity_is_incompatible_even_when_protocol_matches() {
    let result = compat(Some(PROTOCOL_VERSION), Some(APP_BUILD), Some("config-bbbb"));
    assert_eq!(result, DaemonCompat::AppConfigMismatch);
    assert!(!result.usable());
}

#[test]
fn missing_config_identity_is_incompatible() {
    assert_eq!(compat(Some(PROTOCOL_VERSION), Some(APP_BUILD), None), DaemonCompat::AppConfigMismatch);
}

#[test]
fn protocol_mismatch_takes_precedence_for_diagnostics() {
    assert_eq!(compat(Some(PROTOCOL_VERSION + 1), Some(APP_BUILD), Some("config-bbbb"),), DaemonCompat::ProtocolMismatch);
}

#[test]
fn poller_spawns_only_when_nothing_answers() {
    assert_eq!(poller_action(None), PollerAction::Spawn);
}

#[test]
fn poller_leaves_a_usable_daemon_alone() {
    assert_eq!(poller_action(Some(DaemonCompat::Current)), PollerAction::Leave);
    assert_eq!(poller_action(Some(DaemonCompat::BuildDrift)), PollerAction::Leave);
}

#[test]
fn poller_never_respawns_over_a_protocol_or_config_mismatch() {
    // Highest-risk regression in the ticket: a poller that kills-and-respawns on
    // either mismatch destroys live sessions on a timer.
    for mismatch in [DaemonCompat::ProtocolMismatch, DaemonCompat::AppConfigMismatch] {
        assert_eq!(poller_action(Some(mismatch)), PollerAction::SurfaceTakeover);
    }
}

#[test]
fn poller_action_cannot_express_a_kill() {
    // Exhaustive match by construction: adding a Kill/Restart/Respawn variant makes this
    // match non-exhaustive and fails to compile. That compile error is the guard —
    // reclaiming a repo is a deliberate user click (B3), never a timer's decision.
    for action in [PollerAction::Spawn, PollerAction::Leave, PollerAction::SurfaceTakeover] {
        match action {
            PollerAction::Spawn | PollerAction::Leave | PollerAction::SurfaceTakeover => {}
        }
    }
}
