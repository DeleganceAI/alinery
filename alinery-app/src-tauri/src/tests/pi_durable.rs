use alinery_core::PollerAction;

#[test]
fn nothing_on_the_socket_restarts_the_pair_and_never_spawns_release() {
    assert!(matches!(alinery_core::poller_action(None), PollerAction::Spawn));
    assert!(matches!(alinery_core::poller_action(Some(alinery_core::DaemonCompat::Current)), PollerAction::Leave));
    assert!(matches!(
        alinery_core::poller_action(Some(alinery_core::DaemonCompat::ProtocolMismatch)),
        PollerAction::SurfaceConflict
    ));
}
