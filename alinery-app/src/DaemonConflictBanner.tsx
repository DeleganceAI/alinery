import { ChevronDown, CircleAlert, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { copyTextToClipboard } from "./chat/CopyMessage";
import { confirmDanger } from "./confirm";
import * as ipc from "./ipc";
import { repoName } from "./shared";
import { toast } from "./toast";
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

/** One muted line under the top bar: what is unavailable, plus one action. Technical
 *  evidence, when there is no dialog to hold it, sits behind a collapsed Details. */
function RepoStatusStrip({ tone, children, action, details }: { tone: "warning" | "error"; children: ReactNode; action?: ReactNode; details?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const Icon = tone === "error" ? CircleAlert : TriangleAlert;
  return (
    <div className={`repo-strip ${tone}`} role="status">
      <div className="repo-strip-row">
        <Icon size={14} strokeWidth={2} aria-hidden="true" className="repo-strip-icon" />
        <span className="repo-strip-text">{children}</span>
        {details && (
          <button type="button" className="btn ghost small repo-strip-toggle" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((value) => !value)}>
            Details
            <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
        {action}
      </div>
      {details && open && (
        <div id={detailsId} className="repo-strip-details">
          {details}
        </div>
      )}
    </div>
  );
}

const EVIDENCE_NOTE = "Sessions started after this check also stop. Lock files are released when their owner stops; deleting them doesn't force access.";

/** Copyable monospace evidence plus one line of guidance. */
function EvidenceBlock({ text }: { text: string }) {
  const copy = () =>
    copyTextToClipboard(text).then(
      () => toast.success("Details copied", "short"),
      () => toast.error("Couldn't copy the details"),
    );
  return (
    <>
      <pre className="repo-evidence">{text}</pre>
      <div className="repo-evidence-foot">
        <span>{EVIDENCE_NOTE}</span>
        <button type="button" className="btn ghost small" onClick={() => void copy()}>
          Copy details
        </button>
      </div>
    </>
  );
}

const KEY_WIDTH = 12;
const row = (key: string, value: string) => `${key.padEnd(KEY_WIDTH)}${value}`;

// Rust reports one held lease from several probes (repository lease, lane lease,
// availability check), each as a full sentence. Collapse those into one path list and
// keep anything else verbatim.
const HELD_LEASE = /project owner is still (?:running \((.+?)\)|answering (.+?)); stop it before opening this project here/g;

export function conflictEvidence(conflict: DaemonConflict): { held: string[]; issues: string[] } {
  const held = new Set<string>();
  const issues = new Set<string>();
  for (const issue of conflict.issues) {
    for (const match of issue.matchAll(HELD_LEASE)) held.add(match[1] ?? match[2]);
    const rest = issue.replace(HELD_LEASE, "").replace(/^[;\s]+|[;\s]+$/g, "");
    if (rest) issues.add(rest);
  }
  return { held: [...held], issues: [...issues] };
}

function evidenceText(conflict: DaemonConflict): string {
  const { held, issues } = conflictEvidence(conflict);
  const lines = [row("Repository", conflict.repo), row("This app", `protocol ${conflict.app_protocol} · config ${conflict.app_config_identity}`)];
  for (const owner of conflict.owners) {
    const identity = [owner.lane ? `lane ${owner.lane}` : "default lane", owner.pid !== null && `PID ${owner.pid}`, owner.protocol !== null && `protocol ${owner.protocol}`];
    lines.push("", row("Owner", identity.filter(Boolean).join(" · ")));
    if (owner.build_id !== null) lines.push(row("Build", owner.build_id));
    if (owner.app_config_identity !== null) lines.push(row("Config", owner.app_config_identity));
    const { impact } = owner;
    const sessions =
      impact.status === "unknown"
        ? `unknown (${impact.detail})`
        : impact.sessions.length
          ? `${impact.sessions.length} live: ${impact.sessions.map((session) => (session.name ? `${session.name} (${session.id})` : session.id)).join(", ")}`
          : "none live";
    lines.push(row("Sessions", sessions));
    if (owner.takeover_unavailable) lines.push(row("Takeover", owner.takeover_unavailable));
  }
  if (held.length || issues.length) lines.push("");
  held.forEach((path, index) => {
    lines.push(row(index === 0 ? "Held locks" : "", path));
  });
  issues.forEach((issue, index) => {
    lines.push(row(index === 0 ? "Issues" : "", issue));
  });
  return lines.join("\n");
}

/** Dialog sentence and accept label, both naming what the takeover stops. */
function takeoverPrompt(owner: DaemonOwnerConflict): { sentence: string; accept: string } {
  if (owner.impact.status === "unknown") {
    return { sentence: "This repository is open in another Alinery window. Taking over stops all of its sessions.", accept: "Stop all sessions and take over" };
  }
  const count = owner.impact.sessions.length;
  if (count === 0) return { sentence: "This repository is open in another Alinery window (no live sessions). Taking over stops its session service.", accept: "Take over" };
  const noun = count === 1 ? "session" : "sessions";
  return {
    sentence: `This repository is open in another Alinery window (${count} live ${noun}). Taking over stops ${count === 1 ? "it" : "them"}.`,
    accept: `Stop ${count} ${noun} and take over`,
  };
}

// A conflict prompts once per owner process for the life of the app: polling may drop
// and re-raise the same conflict, and a cancelled dialog must not keep coming back.
const prompted = new Set<string>();

/** Test seam: forget which owners already prompted. */
export function resetTakeoverPrompts() {
  prompted.clear();
}

export function DaemonConflictBanner({ conflict, onRefresh }: { conflict: DaemonConflict | null; onRefresh: () => void }) {
  return conflict ? <SelectedRepoConflict key={conflict.repo} conflict={conflict} onRefresh={onRefresh} /> : null;
}

function SelectedRepoConflict({ conflict, onRefresh }: { conflict: DaemonConflict; onRefresh: () => void }) {
  const [pending, setPending] = useState(false);
  const [remaining, setRemaining] = useState<{ source: DaemonConflict; value: DaemonConflict | null } | null>(null);
  const operation = useRef<{ disposed: boolean; confirmationId: string | null; dialog: AbortController } | null>(null);
  const strip = useRef<HTMLButtonElement>(null);
  const displayed = remaining?.source === conflict ? remaining.value : conflict;
  const name = repoName(conflict.repo);
  // One owner per confirmation: a partial takeover leaves the next owner for another click.
  const target = displayed?.owners.find((owner) => !owner.takeover_unavailable);

  useEffect(
    () => () => {
      const current = operation.current;
      if (!current) return;
      current.disposed = true;
      current.dialog.abort();
      if (current.confirmationId) {
        // Backend expiry remains the backstop if IPC disappears during teardown.
        void ipc.cancelRepoTakeover(current.confirmationId).catch(() => {});
        current.confirmationId = null;
      }
    },
    [],
  );

  const takeOver = async (owner: DaemonOwnerConflict) => {
    if (operation.current || owner.takeover_unavailable) return;
    const current = { disposed: false, confirmationId: null as string | null, dialog: new AbortController() };
    operation.current = current;
    setPending(true);
    try {
      let preview = await ipc.prepareRepoTakeover(conflict.repo, owner.lane);
      for (;;) {
        current.confirmationId = preview.confirmation_id;
        if (current.disposed) return;
        if (preview.repo !== conflict.repo) throw new Error("Takeover preview belongs to another repository. Select the owner again.");
        prompted.add(`${preview.repo}\0${preview.owner.lane}\0${preview.owner.pid}`);
        const { sentence, accept } = takeoverPrompt(preview.owner);
        const owners = (displayed ?? conflict).owners.map((candidate) => (candidate.lane === preview.owner.lane ? preview.owner : candidate));
        const accepted = await confirmDanger(
          `Take over ${name}?`,
          <>
            <p>{sentence}</p>
            <details className="takeover-details">
              <summary>Details</summary>
              <EvidenceBlock text={evidenceText({ ...(displayed ?? conflict), owners })} />
            </details>
          </>,
          accept,
          current.dialog.signal,
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
          toast.info(`Stopped one owner. ${name} is still open elsewhere; take it over separately.`);
        } else {
          setRemaining({ source: conflict, value: null });
          toast.success(`Took over ${name}`);
        }
        return;
      }
    } catch (cause) {
      if (!current.disposed) {
        toast.error(`Couldn't take over ${name}: ${String(cause)}`);
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
        // Dismissal restores focus to the compact recovery action, including an automatic prompt.
        requestAnimationFrame(() => {
          if (!current.disposed && !operation.current) strip.current?.focus();
        });
      }
    }
  };

  // Auto-open once per conflict: the first takeable owner this mount sees, and never an owner
  // that already prompted. A partial takeover's next owner waits for an explicit click.
  const autoPrompted = useRef(false);
  const promptKey = target && `${conflict.repo}\0${target.lane}\0${target.pid}`;
  const willPrompt = !autoPrompted.current && !!promptKey && !prompted.has(promptKey);
  // takeOver closes over this render's conflict; the owner identity is the trigger, not the closure.
  // biome-ignore lint/correctness/useExhaustiveDependencies: promptKey is the prompt identity.
  useEffect(() => {
    if (!willPrompt || !target || !promptKey) return;
    autoPrompted.current = true;
    prompted.add(promptKey);
    void takeOver(target);
  }, [promptKey]);

  if (!displayed) return null;
  if (target) {
    // The strip is the dismissed dialog, collapsed: hidden while the dialog is (about to be)
    // up, and the whole line reopens it. It leaves only when the conflict or takeover ends.
    if (pending || willPrompt) return null;
    return (
      <div className="repo-strip warning" role="status">
        <button ref={strip} type="button" className="repo-strip-row repo-strip-reopen" onClick={() => void takeOver(target)}>
          <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" className="repo-strip-icon" />
          <span className="repo-strip-text">{name} is open elsewhere · showing saved progress</span>
          <span className="btn small repo-strip-action">Take over</span>
        </button>
      </div>
    );
  }
  const blockingIssues = displayed.owners.length === 0 && conflictEvidence(displayed).issues.length > 0;
  return (
    <RepoStatusStrip tone={blockingIssues ? "error" : "warning"} details={<EvidenceBlock text={evidenceText(displayed)} />}>
      {blockingIssues ? `${name} can't be opened here · showing saved progress` : `${name} is open elsewhere · showing saved progress · quit the other window to work here`}
    </RepoStatusStrip>
  );
}

// B6 / #132: a *second GUI* on the same folder. Distinct from the conflict above —
// there the daemon is unusable; here the daemon is fine and the other alinery is using it.
// Two windows over one working tree quietly fight over task.md, worktrees and the
// reconciler, so the second one refuses-and-explains rather than pretending it is alone.
//
// The remedy is deliberately *not* a takeover button: nothing is wedged and nothing needs
// reclaiming. Pick another folder, or quit the other alinery — the flock is kernel-released,
// so the strip disappears on its own within a poll.
export function RepoBusyBanner({ repo, onPickRepo }: { repo: string; onPickRepo: () => void }) {
  return (
    <RepoStatusStrip
      tone="warning"
      action={
        <button type="button" className="btn small" onClick={onPickRepo}>
          Open another repo…
        </button>
      }
    >
      {repoName(repo)} is open in another Alinery window · quit it, or open a different repository here
    </RepoStatusStrip>
  );
}
