import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { confirmDanger } from "./confirm";
import * as ipc from "./ipc";
import { InlineStatus, repoName } from "./shared";
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

// A5 and B3 are the same screen, built once. Under #132's ownership model a daemon that
// does not speak this app's wire protocol simply belongs to a *different* alinery instance —
// same condition, same remedy, same danger button.
//
// Blocking banner in the shell chrome: not a modal, not a dialog, and deliberately with
// no "stop them for me" control. This is tmux's refuse-and-explain, plus a pointer at the
// fix. Reclaiming the repo is an express, intentional click that warns first.
export function DaemonConflictBanner({ conflict, onReclaimed }: { conflict: DaemonConflict | null; onReclaimed?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!conflict) return null;

  const name = repoName(conflict.repo);
  const running =
    conflict.reason === "app_config"
      ? "uses a different app configuration"
      : conflict.daemon_protocol === null
        ? "predates protocol versioning"
        : `speaks protocol ${conflict.daemon_protocol}`;
  const live = conflict.live_sessions;

  const takeover = async () => {
    const ok = await confirmDanger(
      `Take over ${name}?`,
      live > 0 ? (
        <>
          <p>The daemon currently serving this repo is stopped and replaced.</p>
          <p className="confirm-loss">
            This kills {live} live session{live === 1 ? "" : "s"} owned by the other Alinery instance. In-flight harness work is lost and cannot be recovered.
          </p>
        </>
      ) : (
        <p>The daemon currently serving this repo is stopped and replaced.</p>
      ),
      "Take over",
    );
    if (!ok) return;
    setBusy(true);
    setErr("");
    try {
      await ipc.takeoverRepoDaemon(conflict.repo);
      onReclaimed?.();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="daemon-conflict" role="alert">
      <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" className="daemon-conflict-icon" />
      <div>
        <strong>{name} is served by another Alinery.</strong> Its session daemon {running}
        {conflict.reason === "protocol" ? `; this app speaks protocol ${conflict.app_protocol}` : ""}. Session actions are refused until one of you lets go.
        {live > 0 ? ` ${live} live session${live === 1 ? "" : "s"} would be lost.` : ""}
        <br />
        Finish your work there, stop the sessions from <em>Settings → Chat</em>, then relaunch — or take the repo over below.
        {err && (
          <InlineStatus tone="error" detail={err}>
            Takeover failed. The other daemon is still serving this repo — try again, or stop it from the other Alinery.
          </InlineStatus>
        )}
      </div>
      <button type="button" className="btn danger" disabled={busy} onClick={takeover}>
        {busy ? "Taking over…" : `Take over ${name}`}
      </button>
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
