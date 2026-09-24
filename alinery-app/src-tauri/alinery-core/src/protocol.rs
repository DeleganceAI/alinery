//! Wire protocol identity for the `alineryd` JSON op socket, and the two pure decision
//! tables built on it (daemon reuse, poller safety).
//!
//! Shared by the app, `alineryd` and `alinery-mcp` so the number cannot drift between the
//! binary that answers `version` and the binary that asks.

/// Wire protocol spoken over the `alineryd` unix socket.
///
/// Bump this **only** when the daemon op-set or the wire format changes. Never bump it
/// for an app release: a marketing version bump that leaves the protocol alone must
/// leave every running daemon — and every live session — exactly where it is.
///
/// A protocol bump means every user with live sessions has to stop them deliberately
/// before installing, so treat it as a real cost.
pub const PROTOCOL_VERSION: u32 = 12;

/// How a running daemon relates to this build of the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DaemonCompat {
    /// Same protocol, same build stamp.
    Current,
    /// Same protocol, different (or unknown) `build_id`. Usable — informational only.
    BuildDrift,
    /// Different protocol, or a pre-gate daemon that reports none at all.
    ProtocolMismatch,
    /// Same protocol, but the daemon captured another (or no) app config path.
    AppConfigMismatch,
}

impl DaemonCompat {
    /// Whether the app may talk to this daemon. Build drift is never a refusal.
    pub fn usable(&self) -> bool {
        matches!(self, DaemonCompat::Current | DaemonCompat::BuildDrift)
    }
}

/// Reuse requires both protocol equality and app-config identity equality.
/// `build_id` remains informational once both compatibility gates pass.
pub fn daemon_compat(daemon_protocol: Option<u32>, daemon_build: Option<&str>, daemon_config_identity: Option<&str>, app_build: &str, app_config_identity: &str) -> DaemonCompat {
    if daemon_protocol != Some(PROTOCOL_VERSION) {
        return DaemonCompat::ProtocolMismatch;
    }
    if daemon_config_identity != Some(app_config_identity) {
        return DaemonCompat::AppConfigMismatch;
    }
    if daemon_build == Some(app_build) {
        DaemonCompat::Current
    } else {
        DaemonCompat::BuildDrift
    }
}

/// What the background daemon poller may do about a repo.
///
/// There is deliberately no kill/restart variant: reclaiming a repo from an
/// incompatible daemon is an express user click (B3 takeover), never a timer's
/// decision. A poller that kills-and-respawns on mismatch reintroduces the original bug
/// every few seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PollerAction {
    /// Nothing answers the socket — start a daemon.
    Spawn,
    /// A usable daemon is serving the repo.
    Leave,
    /// A daemon answers but fails a hard reuse gate: surface the takeover banner.
    SurfaceTakeover,
}

/// `None` = nothing answered the socket.
pub fn poller_action(compat: Option<DaemonCompat>) -> PollerAction {
    match compat {
        None => PollerAction::Spawn,
        Some(c) if c.usable() => PollerAction::Leave,
        Some(_) => PollerAction::SurfaceTakeover,
    }
}
