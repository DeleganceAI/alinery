// Auto-backup trigger queue (issue #79, Phase 4).
//
// Archiving a task, committing, pushing, and saving an artifact must stay instant. So the
// automatic path never zips inline: call sites publish into this per-repo coalescing queue
// and one worker thread drains it.
//
// Two slots per repo, ever: the one in flight and the latest pending. A burst of N artifact
// saves therefore costs at most two zips, not N. `now` is a parameter rather than an
// `Instant::now()` call inside, so the debounce is testable without sleeping.

use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use alinery_core::{backup_feature_ready, BackupDefaults, BackupTrigger};

/// A burst schedules its work from the burst's *end*: every publish pushes the deadline out.
pub const BACKUP_DEBOUNCE: Duration = Duration::from_secs(2);

/// Should this trigger enqueue a backup?
///
/// Only the three automatic triggers are gated here. `Manual` (BACKUP NOW) and `Mcp` never
/// consult this gate: they are explicit user/agent requests that call `create_backup` directly
/// and report their real result, rather than disappearing into a debounce window. Manual runs
/// still claim the in-flight slot via `begin`, so "is this repo busy" covers them too.
pub fn should_publish(settings: &BackupDefaults, repo: &Path, trigger: BackupTrigger) -> bool {
    if !backup_feature_ready(settings, repo) {
        return false;
    }
    match trigger {
        BackupTrigger::PreArchive => settings.trigger_pre_archive,
        BackupTrigger::PostArtifactChange => settings.trigger_post_artifact_change,
        BackupTrigger::PostPushCommit => settings.trigger_post_push_commit,
        BackupTrigger::Manual | BackupTrigger::Mcp => false,
    }
}

#[derive(Debug, Default)]
struct Slot {
    in_progress: bool,
    pending: Option<(BackupTrigger, Instant)>,
}

#[derive(Debug, Default)]
pub struct BackupQueue {
    repos: HashMap<String, Slot>,
}

impl BackupQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace this repo's pending request and push the debounce deadline out. Replacing
    /// rather than appending is what bounds the queue: a backlog would mean the user's last
    /// action waits behind N stale zips of the same data.
    pub fn publish(&mut self, repo: &str, trigger: BackupTrigger, now: Instant) {
        let slot = self.repos.entry(repo.to_string()).or_default();
        slot.pending = Some((trigger, now + BACKUP_DEBOUNCE));
    }

    /// The next repo whose pending request is past its deadline and has nothing in flight.
    /// Marks it in progress; the worker must call `finish` when the zip is done or failed.
    pub fn take_ready(&mut self, now: Instant) -> Option<(String, BackupTrigger)> {
        // Deterministic pick so one busy repo cannot starve another under a hash reorder.
        let mut ready: Vec<(&String, BackupTrigger)> = self
            .repos
            .iter()
            .filter_map(|(repo, slot)| match slot.pending {
                Some((trigger, deadline)) if !slot.in_progress && deadline <= now => Some((repo, trigger)),
                _ => None,
            })
            .collect();
        ready.sort_by(|a, b| a.0.cmp(b.0));
        let (repo, trigger) = ready.first().map(|(r, t)| ((*r).clone(), *t))?;

        let slot = self.repos.get_mut(&repo)?;
        slot.pending = None;
        slot.in_progress = true;
        Some((repo, trigger))
    }

    pub fn finish(&mut self, repo: &str) {
        if let Some(slot) = self.repos.get_mut(repo) {
            slot.in_progress = false;
        }
    }

    /// Claim the in-flight slot for work run outside the worker (BACKUP NOW, restore). `false`
    /// means this repo is already being zipped or extracted: the caller must not proceed, or its
    /// `finish` would clear the flag out from under the run that is still going.
    pub fn begin(&mut self, repo: &str) -> bool {
        let slot = self.repos.entry(repo.to_string()).or_default();
        if slot.in_progress {
            return false;
        }
        slot.in_progress = true;
        true
    }

    /// Is anything running or already scheduled for this repo? Asked by the Backup view, which
    /// cannot answer it from component state: the work lives in the backend and outlives the
    /// view, so leaving and coming back must still show a run in progress. Pending counts —
    /// a debounced trigger is about to zip, and reporting idle would invite a racing manual run.
    pub fn busy(&self, repo: &str) -> bool {
        self.repos.get(repo).is_some_and(|slot| slot.in_progress || slot.pending.is_some())
    }

    /// Finer slot inspection than `busy`, and test-only: production code drives the queue
    /// through publish/take_ready/begin/finish, and an unused public accessor is dead weight.
    #[cfg(test)]
    pub fn pending(&self, repo: &str) -> Option<BackupTrigger> {
        self.repos.get(repo).and_then(|s| s.pending.map(|p| p.0))
    }

    #[cfg(test)]
    pub fn pending_total(&self) -> usize {
        self.repos.values().filter(|s| s.pending.is_some()).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_repo(name: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let base = std::env::temp_dir().join(format!("alinery-bkq-{name}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(base.join("repo/.alinery")).unwrap();
        fs::create_dir_all(base.join("dest")).unwrap();
        base
    }

    fn all_triggers_on(dest: &Path) -> BackupDefaults {
        BackupDefaults {
            destination: dest.to_string_lossy().to_string(),
            enabled: true,
            retention: 10,
            trigger_pre_archive: true,
            trigger_post_artifact_change: true,
            trigger_post_push_commit: true,
        }
    }

    const AUTO: [BackupTrigger; 3] = [BackupTrigger::PreArchive, BackupTrigger::PostArtifactChange, BackupTrigger::PostPushCommit];

    // 4.1 — the master switch beats every individual trigger flag.
    #[test]
    fn gate_off_when_feature_disabled() {
        let base = temp_repo("disabled");
        let (repo, dest) = (base.join("repo"), base.join("dest"));
        let mut settings = all_triggers_on(&dest);
        settings.enabled = false;
        for trigger in AUTO {
            assert!(!should_publish(&settings, &repo, trigger), "{trigger:?} passed");
        }
        let _ = fs::remove_dir_all(base);
    }

    // 4.2 — "feature off until a valid destination", enforced at the gate, not just the UI.
    #[test]
    fn gate_off_when_destination_unset_or_invalid() {
        let base = temp_repo("no-dest");
        let (repo, dest) = (base.join("repo"), base.join("dest"));

        let mut unset = all_triggers_on(&dest);
        unset.destination = String::new();
        assert!(!should_publish(&unset, &repo, BackupTrigger::PreArchive));

        let inside = repo.join(".alinery/backups");
        fs::create_dir_all(&inside).unwrap();
        let mut inner = all_triggers_on(&dest);
        inner.destination = inside.to_string_lossy().to_string();
        assert!(!should_publish(&inner, &repo, BackupTrigger::PreArchive));
        let _ = fs::remove_dir_all(base);
    }

    // 4.3 — the three triggers are independent switches, not one shared flag.
    #[test]
    fn gate_matches_trigger_flag_independently() {
        let base = temp_repo("independent");
        let (repo, dest) = (base.join("repo"), base.join("dest"));
        let mut settings = all_triggers_on(&dest);
        settings.trigger_post_artifact_change = false;
        settings.trigger_post_push_commit = false;
        assert!(should_publish(&settings, &repo, BackupTrigger::PreArchive));
        assert!(!should_publish(&settings, &repo, BackupTrigger::PostArtifactChange));
        assert!(!should_publish(&settings, &repo, BackupTrigger::PostPushCommit));
        let _ = fs::remove_dir_all(base);
    }

    // 4.4 — manual and MCP backups are explicit requests: they bypass this gate entirely
    // and run synchronously, so a user pressing BACKUP NOW is never silently debounced.
    #[test]
    fn gate_never_gates_manual_or_mcp() {
        let base = temp_repo("manual");
        let (repo, dest) = (base.join("repo"), base.join("dest"));
        let mut settings = all_triggers_on(&dest);
        settings.trigger_pre_archive = false;
        settings.trigger_post_artifact_change = false;
        settings.trigger_post_push_commit = false;
        assert!(!should_publish(&settings, &repo, BackupTrigger::Manual));
        assert!(!should_publish(&settings, &repo, BackupTrigger::Mcp));
        // With every auto flag off the queue stays empty, yet create_backup is still allowed:
        // the manual path never consults should_publish.
        assert!(alinery_core::backup_feature_ready(&settings, &repo));
        let _ = fs::remove_dir_all(base);
    }

    // 4.5 — ticket-critical: N artifact saves must not mean N zips.
    #[test]
    fn rapid_publishes_collapse_to_one_pending() {
        let mut queue = BackupQueue::new();
        let t0 = Instant::now();
        for (i, trigger) in [
            BackupTrigger::PostArtifactChange,
            BackupTrigger::PostArtifactChange,
            BackupTrigger::PostArtifactChange,
            BackupTrigger::PostArtifactChange,
            BackupTrigger::PreArchive,
        ]
        .into_iter()
        .enumerate()
        {
            queue.publish("/r", trigger, t0 + Duration::from_millis(i as u64 * 10));
        }
        assert_eq!(queue.pending_total(), 1);
        assert_eq!(queue.pending("/r"), Some(BackupTrigger::PreArchive));
    }

    // 4.6 — max two slots per repo: one in flight plus one pending, never a backlog.
    #[test]
    fn publish_during_in_progress_replaces_pending_not_backlog() {
        let mut queue = BackupQueue::new();
        let t0 = Instant::now();
        queue.publish("/r", BackupTrigger::PreArchive, t0);
        assert!(queue.take_ready(t0 + BACKUP_DEBOUNCE).is_some());

        for _ in 0..3 {
            queue.publish("/r", BackupTrigger::PostArtifactChange, t0);
        }
        assert_eq!(queue.pending_total(), 1);
        assert_eq!(queue.pending("/r"), Some(BackupTrigger::PostArtifactChange));
    }

    // 4.7 — inside the window the burst is still coalescing; nothing runs yet.
    #[test]
    fn pending_is_not_ready_before_debounce_deadline() {
        let mut queue = BackupQueue::new();
        let t0 = Instant::now();
        queue.publish("/r", BackupTrigger::PreArchive, t0);
        assert_eq!(queue.take_ready(t0 + Duration::from_secs(1)), None);
    }

    // 4.8 — ready at the boundary, and served exactly once.
    #[test]
    fn pending_becomes_ready_after_debounce() {
        let mut queue = BackupQueue::new();
        let t0 = Instant::now();
        queue.publish("/r", BackupTrigger::PreArchive, t0);
        assert_eq!(queue.take_ready(t0 + BACKUP_DEBOUNCE), Some(("/r".to_string(), BackupTrigger::PreArchive)));
        assert_eq!(queue.take_ready(t0 + Duration::from_secs(3)), None);
    }

    // 4.9 — coalescing means the END of a burst schedules the work, not its start.
    #[test]
    fn republish_refreshes_the_deadline() {
        let mut queue = BackupQueue::new();
        let t0 = Instant::now();
        queue.publish("/r", BackupTrigger::PreArchive, t0);
        queue.publish("/r", BackupTrigger::PreArchive, t0 + Duration::from_secs(1));
        assert_eq!(queue.take_ready(t0 + Duration::from_secs(2)), None);
        assert!(queue.take_ready(t0 + Duration::from_secs(3)).is_some());
    }

    // 4.10 — one repo's in-flight zip must never stall another repo's backup.
    #[test]
    fn distinct_repos_do_not_share_slots() {
        let mut queue = BackupQueue::new();
        let t0 = Instant::now();
        queue.publish("/a", BackupTrigger::PreArchive, t0);
        queue.publish("/b", BackupTrigger::PostPushCommit, t0);
        let ready = t0 + BACKUP_DEBOUNCE;
        let first = queue.take_ready(ready).unwrap();
        let second = queue.take_ready(ready).unwrap();
        let mut repos = [first.0, second.0];
        repos.sort();
        assert_eq!(repos, ["/a".to_string(), "/b".to_string()]);
    }

    // 4.11 — the worker's completion callback is what unblocks the next run.
    #[test]
    fn finish_clears_in_progress_and_allows_next() {
        let mut queue = BackupQueue::new();
        let t0 = Instant::now();
        queue.publish("/r", BackupTrigger::PreArchive, t0);
        assert!(queue.take_ready(t0 + BACKUP_DEBOUNCE).is_some());

        queue.publish("/r", BackupTrigger::PostArtifactChange, t0 + BACKUP_DEBOUNCE);
        let later = t0 + BACKUP_DEBOUNCE + BACKUP_DEBOUNCE;
        assert_eq!(queue.take_ready(later), None, "in-flight must block");

        queue.finish("/r");
        assert_eq!(queue.take_ready(later), Some(("/r".to_string(), BackupTrigger::PostArtifactChange)));
    }

    // The Backup view's source of truth: a trigger-driven run must read as busy from the moment
    // it is scheduled until the worker calls finish, so leaving the view and coming back shows it.
    #[test]
    fn busy_covers_pending_then_in_flight_then_clears() {
        let mut queue = BackupQueue::new();
        let t0 = Instant::now();
        assert!(!queue.busy("/r"), "idle repo must not read busy");

        queue.publish("/r", BackupTrigger::PreArchive, t0);
        assert!(queue.busy("/r"), "debounced trigger is about to zip");

        assert!(queue.take_ready(t0 + BACKUP_DEBOUNCE).is_some());
        assert!(queue.busy("/r"), "in flight");

        queue.finish("/r");
        assert!(!queue.busy("/r"));
    }

    // BACKUP NOW and restore run outside the worker, so they claim the slot themselves —
    // otherwise the view reads idle mid-zip and the worker could start a second one.
    #[test]
    fn begin_claims_the_slot_and_refuses_a_second_claim() {
        let mut queue = BackupQueue::new();
        assert!(queue.begin("/r"));
        assert!(queue.busy("/r"));
        assert!(!queue.begin("/r"), "second claim must be refused");

        queue.finish("/r");
        assert!(!queue.busy("/r"));
        assert!(queue.begin("/r"), "claimable again once finished");
    }

    // A manual run must not race the worker onto the same repo's retention/zip.
    #[test]
    fn begin_blocks_the_worker_and_the_worker_blocks_begin() {
        let mut queue = BackupQueue::new();
        let t0 = Instant::now();
        assert!(queue.begin("/r"));
        queue.publish("/r", BackupTrigger::PostArtifactChange, t0);
        assert_eq!(queue.take_ready(t0 + BACKUP_DEBOUNCE), None, "manual claim must hold off the worker");

        queue.finish("/r");
        assert!(queue.take_ready(t0 + BACKUP_DEBOUNCE).is_some());
        assert!(!queue.begin("/r"), "worker claim must hold off manual");
    }
}
