use std::cell::RefCell;

use alinery_core::{DaemonCompat, PollerAction};

struct Record<'a> {
    steps: &'a RefCell<Vec<&'static str>>,
}

impl crate::pi_durable::PiSwitchOps for Record<'_> {
    fn validate(&mut self) -> Result<(), String> {
        self.steps.borrow_mut().push("validate");
        Ok(())
    }
    fn reserve(&mut self) -> Result<(), String> {
        self.steps.borrow_mut().push("reserve");
        Ok(())
    }
    fn mark_closing(&mut self) -> Result<(), String> {
        self.steps.borrow_mut().push("mark_closing");
        Ok(())
    }
    fn wait_socket_gone(&mut self) -> Result<(), String> {
        self.steps.borrow_mut().push("wait_socket_gone");
        Ok(())
    }
    fn persist_flag(&mut self, enabled: bool) -> Result<(), String> {
        self.steps.borrow_mut().push(if enabled { "persist_on" } else { "persist_off" });
        Ok(())
    }
    fn stop_helper(&mut self) -> Result<(), String> {
        self.steps.borrow_mut().push("stop_helper");
        Ok(())
    }
    fn start_helper(&mut self) -> Result<(), String> {
        self.steps.borrow_mut().push("start_helper");
        Ok(())
    }
    fn start_pi_daemon(&mut self) -> Result<(), String> {
        self.steps.borrow_mut().push("start_pi_daemon");
        Ok(())
    }
    fn start_release(&mut self) -> Result<(), String> {
        self.steps.borrow_mut().push("start_release");
        Ok(())
    }
    fn drop_closing(&mut self) {
        self.steps.borrow_mut().push("drop_closing");
    }
}

fn run(enable: bool) -> Vec<&'static str> {
    let steps = RefCell::new(Vec::new());
    let mut record = Record { steps: &steps };
    crate::pi_durable::run_experimental_switch(enable, &mut record, &mut || {
        steps.borrow_mut().push("shutdown_ui");
        Ok(())
    })
    .unwrap();
    steps.into_inner()
}

#[test]
fn enable_stops_release_then_starts_helper_then_pi_daemon() {
    let steps = run(true);
    assert_eq!(
        steps,
        [
            "validate",
            "reserve",
            "mark_closing",
            "shutdown_ui",
            "wait_socket_gone",
            "persist_on",
            "start_helper",
            "start_pi_daemon",
            "drop_closing",
        ]
    );
}

#[test]
fn disable_stops_pi_daemon_then_helper_then_starts_release() {
    let steps = run(false);
    assert_eq!(
        steps,
        [
            "validate",
            "reserve",
            "mark_closing",
            "shutdown_ui",
            "wait_socket_gone",
            "persist_off",
            "stop_helper",
            "start_release",
            "drop_closing",
        ]
    );
}

#[test]
fn toggle_on_poller_restarts_the_pair_and_never_spawns_release() {
    assert!(matches!(
        crate::pi_durable::experimental_poller_decision(true, None),
        crate::pi_durable::TogglePoll::RestartPair
    ));
    assert!(!crate::pi_durable::poller_should_spawn_release(true, PollerAction::Spawn));
    assert!(matches!(
        crate::pi_durable::experimental_poller_decision(true, Some(DaemonCompat::Current)),
        crate::pi_durable::TogglePoll::Leave
    ));
}

#[test]
fn toggle_off_poller_is_the_release_poller() {
    assert!(matches!(
        crate::pi_durable::experimental_poller_decision(false, None),
        crate::pi_durable::TogglePoll::Release(PollerAction::Spawn)
    ));
    assert!(crate::pi_durable::poller_should_spawn_release(false, PollerAction::Spawn));
    assert!(matches!(
        crate::pi_durable::experimental_poller_decision(false, Some(DaemonCompat::Current)),
        crate::pi_durable::TogglePoll::Release(PollerAction::Leave)
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
