import { TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { confirmDanger } from "./confirm";
import * as ipc from "./ipc";
import { repoName } from "./shared";
import type { DaemonConflict, DaemonOwnerConflict } from "./types";

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

function OwnerEvidence({ owner }: { owner: DaemonOwnerConflict }) {
  return (
    <div className="daemon-owner-evidence">
      <p>
        <strong>{owner.lane ? `Development lane ${owner.lane}` : "Production"}</strong>
        {owner.pid !== null && ` · PID ${owner.pid}`}
        {owner.protocol !== null && ` · Protocol ${owner.protocol}`}
      </p>
      {owner.build_id !== null && <p>Build: {owner.build_id}</p>}
      {owner.app_config_identity !== null && <p>App configuration: {owner.app_config_identity}</p>}
      {owner.impact.status === "unknown" ? (
        <p>Session impact unknown: {owner.impact.detail}</p>
      ) : (
        <>
          <p>{owner.impact.sessions.length} listed live task sessions</p>
          {owner.impact.sessions.length > 0 && (
            <ul>
              {owner.impact.sessions.map((session) => (
                <li key={session.id}>{session.name ? `${session.name} (${session.id})` : session.id}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export function DaemonConflictBanner({ conflict, onRefresh }: { conflict: DaemonConflict | null; onRefresh: () => void }) {
  return conflict ? <SelectedRepoConflict key={conflict.repo} conflict={conflict} onRefresh={onRefresh} /> : null;
}

function SelectedRepoConflict({ conflict, onRefresh }: { conflict: DaemonConflict; onRefresh: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [remaining, setRemaining] = useState<{ source: DaemonConflict; value: DaemonConflict | null } | null>(null);
  const operation = useRef<{ disposed: boolean; confirmationId: string | null } | null>(null);
  const displayed = remaining?.source === conflict ? remaining.value : conflict;
  const name = repoName(conflict.repo);

  useEffect(
    () => () => {
      const current = operation.current;
      if (!current) return;
      current.disposed = true;
      if (current.confirmationId) {
        // Backend expiry remains the backstop if IPC disappears during teardown.
        void ipc.cancelRepoTakeover(current.confirmationId).catch(() => {});
        current.confirmationId = null;
      }
    },
    [],
  );

  const takeOver = async (owner: DaemonOwnerConflict, opener: HTMLButtonElement) => {
    if (operation.current || owner.takeover_unavailable) return;
    const current = { disposed: false, confirmationId: null as string | null };
    operation.current = current;
    setPending(true);
    setError("");
    setProgress("");
    try {
      let preview = await ipc.prepareRepoTakeover(conflict.repo, owner.lane);
      for (;;) {
        current.confirmationId = preview.confirmation_id;
        if (current.disposed) return;
        if (preview.repo !== conflict.repo) throw new Error("Takeover preview belongs to another repository. Select the owner again.");
        const accepted = await confirmDanger(
          `Take over ${name}?`,
          <>
            <OwnerEvidence owner={preview.owner} />
            <p>All sessions of this daemon will stop, including in-flight work and any setup or new sessions started after this preview. Save your work before continuing.</p>
            <p>All repository tasks switch together, only after every previous owner has stopped. Other owners require separate confirmation.</p>
          </>,
          "Stop daemon and take over",
        );
        if (current.disposed) return;
        if (!accepted) {
          const id = current.confirmationId;
          current.confirmationId = null;
          await ipc.cancelRepoTakeover(id);
          return;
        }
        current.confirmationId = null; // Confirm consumes the handle even on failure.
        const outcome = await ipc.confirmRepoTakeover(preview.confirmation_id);
        if (outcome.status === "reconfirm") {
          preview = outcome.preview;
          current.confirmationId = preview.confirmation_id;
        }
        if (current.disposed) return;
        onRefresh();
        if (outcome.status === "reconfirm") continue;
        if (outcome.status === "blocked") {
          setRemaining({ source: conflict, value: outcome.conflict });
          setProgress("The selected daemon stopped. Other owners or ownership evidence still block switching; each remaining owner requires a separate confirmation.");
        } else {
          setRemaining({ source: conflict, value: null });
          setProgress("Repository takeover completed.");
        }
        return;
      }
    } catch (cause) {
      if (!current.disposed) {
        setError(String(cause));
        onRefresh();
      }
    } finally {
      if (current.confirmationId) {
        void ipc.cancelRepoTakeover(current.confirmationId).catch(() => {});
        current.confirmationId = null;
      }
      if (!current.disposed) {
        operation.current = null;
        setPending(false);
        // The modal closes while this button is still disabled. Restore focus
        // after React re-enables it, unless another operation replaced this one.
        requestAnimationFrame(() => {
          if (!current.disposed && !operation.current && opener.isConnected) opener.focus();
        });
      }
    }
  };

  return (
    <div className="daemon-conflict" role="alert">
      <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" className="daemon-conflict-icon" />
      <div>
        {displayed && <strong>{name} cannot be opened here yet.</strong>}
        {displayed?.owners.map((owner) => (
          <section key={owner.lane}>
            <OwnerEvidence owner={owner} />
            {owner.takeover_unavailable ? (
              <>
                <p>{owner.takeover_unavailable}</p>
                <p>Stop this owner from its owning app, or resolve the reported access problem. Do not delete lock or ownership files to force access.</p>
              </>
            ) : (
              <button type="button" className="btn small danger" disabled={pending} onClick={(event) => void takeOver(owner, event.currentTarget)}>
                Take over {name}
              </button>
            )}
          </section>
        ))}
        {[...new Set(displayed?.issues)].map((issue) => (
          <p key={issue}>{issue}</p>
        ))}
        {!!displayed?.issues.length && <p>Resolve the reported ownership evidence before switching. Do not delete lock or ownership files to force access.</p>}
        {pending && <p role="status">Takeover awaiting confirmation or completion…</p>}
        {progress && <p role="status">{progress}</p>}
        {error && <p role="alert">{error}</p>}
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
