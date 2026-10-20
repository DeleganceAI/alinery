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

#[test]
fn helper_restarts_alone_only_while_the_ui_socket_is_up() {
    assert!(matches!(
        crate::pi_durable::helper_supervision(true, false),
        crate::pi_durable::HelperSupervision::RestartHelperOnly
    ));
    assert!(matches!(
        crate::pi_durable::helper_supervision(false, false),
        crate::pi_durable::HelperSupervision::RestartPair
    ));
    assert!(matches!(
        crate::pi_durable::helper_supervision(false, true),
        crate::pi_durable::HelperSupervision::RestartPair
    ));
    assert!(matches!(crate::pi_durable::helper_supervision(true, true), crate::pi_durable::HelperSupervision::Leave));
}
