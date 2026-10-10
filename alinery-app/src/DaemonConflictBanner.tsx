import { TriangleAlert } from "lucide-react";
import { repoName } from "./shared";
import type { DaemonConflict } from "./types";

const HOST_GUARD_WARNING =
  "OMP sessions are unavailable because Alinery could not validate its executable path. Use the confirmed Restart daemon / Stop all sessions action in Settings → Chat to restore OMP host protection. Terminal sessions remain available.";

export function HostGuardWarning({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="daemon-host-warning" role="alert">
      {HOST_GUARD_WARNING}
    </div>
  );
}

// Ownership conflicts are informational: only an explicit stop in the owning app
// releases the project. The daemon status poll retries opening automatically.
export function DaemonConflictBanner({ conflict }: { conflict: DaemonConflict | null }) {
  if (!conflict) return null;

  const name = repoName(conflict.repo);
  const running =
    conflict.reason === "app_config"
      ? "uses a different app configuration"
      : conflict.daemon_protocol === null
        ? "predates protocol versioning"
        : `speaks protocol ${conflict.daemon_protocol}`;

  return (
    <div className="daemon-conflict" role="alert">
      <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" className="daemon-conflict-icon" />
      <div>
        <strong>{name} cannot be opened here yet.</strong>{" "}
        {conflict.reason === "ownership" ? (
          <>A previous daemon owner is still running, or Alinery cannot confirm that every previous owner has stopped.</>
        ) : (
          <>
            Its session daemon {running}
            {conflict.reason === "protocol" ? `; this app speaks protocol ${conflict.app_protocol}` : ""}.
          </>
        )}
        {conflict.detail && <p>{conflict.detail}</p>}
        <p>
          Tasks cannot be adopted and sessions cannot be launched here until every previous daemon owner has stopped. Finish your work in the owning Alinery, then explicitly stop
          its daemon from <em>Settings → Chat</em>. This app retries automatically; it will not stop another daemon for you.
        </p>
      </div>
    </div>
  );
}

// B6 / #132: a *second GUI* on the same folder. Distinct from the conflict above —
// there the daemon is unusable; here the daemon is fine and the other alinery is using it.
// Two windows over one working tree quietly fight over task.md, worktrees and the
// reconciler, so the second one refuses-and-explains rather than pretending it is alone.
//
// The remedy is deliberately *not* a takeover button: nothing is wedged and nothing needs
// reclaiming. Pick another folder, or quit the other alinery — the flock is kernel-released,
// so the banner disappears on its own within a poll.
export function RepoBusyBanner({ repo, onPickRepo }: { repo: string; onPickRepo: () => void }) {
  const name = repoName(repo);
  return (
    <div className="daemon-conflict" role="alert">
      <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" className="daemon-conflict-icon" />
      <div>
        <strong>{name} is already open in another Alinery.</strong> That window owns this folder. Two Alinery windows on one working tree overwrite each other's task, phase and
        worktree state, and edits here can be silently lost.
        <br />
        Switch this window to a different repository, or quit the other Alinery window — this banner clears itself as soon as it does.
      </div>
      <button type="button" className="btn" onClick={onPickRepo}>
        Open another repo…
      </button>
    </div>
  );
}
