import { ArrowUpRight, FileText } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { defaultFocus, formatElapsed, type RolloutEntry, type RolloutRow } from "./rolloutModel";
import { hasAcknowledgedExit, observationDisplayKind } from "./sessionAttention";
import { formatAbsolute, StatusDot } from "./shared";
import type { SessionDisplayMeta, SessionObservation } from "./types";
import type { SessionBare } from "./views/SessionView";
import { sessionTerminalLabel } from "./vinculumHarness";
import "./TaskRollout.css";

function Bubble({ entry, state }: { entry: RolloutEntry; state: string }) {
  return (
    <span className={`rollout-bubble${entry.auxiliary ? " aux" : ""}${state}`} role="img" aria-label={entry.stepNumber ? `Step ${entry.stepNumber}` : "Auxiliary session"}>
      {entry.stepNumber ?? ""}
    </span>
  );
}

/** Never empty: a step that has published nothing still shows a sliver, so its line reads as started. */
const MIN_PROGRESS = 0.06;

/** A closed group shows this many of its sessions as dots, then a count of the rest. */
const MAX_DOTS = 12;

/**
 * A task as one conversation: every session in the order it ran, each introduced by its step's bubble. A running
 * session shows one line of what it is doing; a click opens its messages in place. The session itself is mounted
 * for both (`renderSession`), so nothing here is a second conversation, and its composer lands in the one box
 * pinned at the bottom. Sessions that ran at the same time are a group: one line for the step, then a line each.
 */
export function TaskRollout({
  rows,
  observations,
  repoPath,
  slug,
  now,
  renderSession,
  onOpenSession,
  onOpenArtifact,
}: {
  rows: RolloutRow[];
  observations: Record<string, SessionObservation>;
  repoPath: string;
  slug: string;
  /** Epoch seconds. */
  now: number;
  /** The session of a row, without its own header; `collapse` closes the row (the session was archived). */
  renderSession: (session: SessionDisplayMeta, bare: SessionBare, collapse: () => void) => ReactNode;
  onOpenSession: (session: SessionDisplayMeta) => void;
  onOpenArtifact: (path: string) => void;
}) {
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [picked, setPicked] = useState("");
  const [composerSlot, setComposerSlot] = useState<HTMLElement | null>(null);
  const kindOf = (entry: RolloutEntry) => (observations[entry.session.id] ? observationDisplayKind(observations[entry.session.id]) : "loading");
  const needsUser = (entry: RolloutEntry) => !entry.session.archived && ["waiting_for_input", "waiting_for_approval"].includes(kindOf(entry));
  const stateOf = (entry: RolloutEntry): "needs-user" | "running" | "failed" | "done" | "" => {
    const kind = kindOf(entry);
    if (needsUser(entry)) return "needs-user";
    if (kind === "busy" || kind === "starting") return "running";
    if (kind === "failed" || kind === "errored" || kind === "stale") return "failed";
    return entry.execution?.receipt_id || kind === "completed" ? "done" : "";
  };
  const stateClass = (entry: RolloutEntry) => (stateOf(entry) ? ` ${stateOf(entry)}` : "");
  const isOpen = (entry: RolloutEntry) => toggled[entry.session.id] ?? needsUser(entry);

  // The one composer talks to a running session: the one the reader picked or last opened, else one waiting on them, else the newest step.
  const running = rows.flat().filter((entry) => entry.end == null && !entry.session.archived && entry.session.worktree);
  const target =
    running.find((entry) => entry.session.id === picked) ?? (running.length ? running.find((entry) => entry.session.id === defaultFocus(running, needsUser)) : undefined);

  // One scroll for the whole task: follow new output while the reader is at the bottom, and stay put once they scroll up.
  const stream = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = stream.current;
    if (!el || !list.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(list.current);
    return () => observer.disconnect();
  }, []);

  // The line beside a step is its progress: the files its sessions owe, filled as they are written.
  const progress = (entries: RolloutEntry[], label: string) => {
    const owed = entries.flatMap((item) => item.artifacts);
    const total = owed.length;
    const done = owed.filter((artifact) => !artifact.pending).length;
    const fraction = total ? Math.max(MIN_PROGRESS, done / total) : entries.every((item) => item.end != null) ? 1 : MIN_PROGRESS;
    return (
      <span
        className="rollout-rule"
        role="progressbar"
        aria-label={`${label} artifacts`}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        title={total ? `${done} of ${total} artifacts written` : undefined}
      >
        <span className="rollout-rule-fill" style={{ width: `${fraction * 100}%` }} />
      </span>
    );
  };

  /** One session: its line, its conversation or preview, its files. In a group the session's own name leads, since the step is the group's. */
  const turn = (entry: RolloutEntry, member: boolean) => {
    const s = entry.session;
    const open = isOpen(entry);
    const live = entry.end == null && !s.archived;
    const superseded = Boolean(entry.execution && entry.execution.owner_session_id !== s.id);
    const toggle = () => {
      setToggled((current) => ({ ...current, [s.id]: !open }));
      // Opening a running session is how the reader says which one they are talking to.
      if (!open && live) setPicked(s.id);
    };
    return (
      <div key={s.id} className={`rollout-turn${member ? " member" : ""}`}>
        <div className="rollout-mark">
          <button type="button" className="rollout-toggle" aria-expanded={open} disabled={!s.worktree} onClick={toggle}>
            <Bubble entry={entry} state={stateClass(entry)} />
            <span className="rollout-step-title">{member ? s.name || entry.title : entry.title}</span>
            {!member && s.name && <span className="rollout-step-name">{s.name}</span>}
          </button>
          {progress([entry], member ? s.name || entry.title : entry.title)}
          <StatusDot
            id={s.id}
            slug={slug}
            repoPath={repoPath}
            observation={observations[s.id] ?? null}
            superseded={superseded}
            exitCode={s.exit_code}
            exitAcknowledged={hasAcknowledgedExit(s)}
            terminalLabel={superseded ? null : sessionTerminalLabel(s.harness, s.id, entry.execution, entry.end != null)}
          />
          <span className="rollout-elapsed" title={`Started ${formatAbsolute(entry.start)}`}>
            {formatElapsed((entry.end ?? now) - entry.start)}
          </span>
          <button type="button" className="btn ghost small rollout-open" aria-label="Open session" title="Open session" disabled={!s.worktree} onClick={() => onOpenSession(s)}>
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        </div>
        {/* A running session stays mounted while collapsed: its one-line preview and its composer come from it. */}
        {s.worktree && (open || live) && (
          <div className="rollout-session">
            {renderSession(s, { composerSlot: target?.session.id === s.id ? composerSlot : null, preview: !open, onExpand: toggle }, () =>
              setToggled((current) => ({ ...current, [s.id]: false })),
            )}
          </div>
        )}
        {entry.artifacts.length > 0 && (
          <div className="rollout-artifacts">
            {entry.artifacts.map((artifact) => (
              <button
                key={artifact.path}
                type="button"
                className="rollout-artifact"
                disabled={artifact.pending}
                title={artifact.pending ? `${artifact.path} — not written yet` : artifact.path}
                onClick={() => onOpenArtifact(artifact.path)}
              >
                <FileText size={12} aria-hidden="true" />
                {artifact.path.slice(artifact.path.lastIndexOf("/") + 1)}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  // Within a group, the sessions that need the reader come first: waiting, then failed, then working, then the rest in start order.
  const RANK = { "needs-user": 0, failed: 1, running: 2, done: 3, "": 3 };

  return (
    <div className="rollout">
      <div
        className="rollout-stream"
        ref={stream}
        onScroll={(event) => {
          const el = event.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
        }}
      >
        {rows.length === 0 && <p className="dim">No sessions yet.</p>}
        <ol className="rollout-rows" aria-label="Rollout" ref={list}>
          {rows.map((row) => {
            if (row.length === 1) {
              return (
                <li key={row[0].session.id} className="rollout-row">
                  {turn(row[0], false)}
                </li>
              );
            }
            const lead = row.find((entry) => !entry.auxiliary) ?? row[0];
            const title = row.every((entry) => entry.title === lead.title) ? lead.title : "Running together";
            const count = (state: string) => row.filter((entry) => stateOf(entry) === state).length;
            const summary = [
              `${row.length} agents`,
              count("done") && `${count("done")} done`,
              count("failed") && `${count("failed")} failed`,
              count("needs-user") && `${count("needs-user")} waiting on you`,
            ]
              .filter(Boolean)
              .join(" · ");
            // A group is one line until the reader opens it, or one of its sessions is waiting on them.
            const id = row[0].session.id;
            const open = toggled[`group:${id}`] ?? row.some(needsUser);
            const flip = () => setToggled((current) => ({ ...current, [`group:${id}`]: !open }));
            const sorted = [...row].sort((left, right) => RANK[stateOf(left)] - RANK[stateOf(right)]);
            return (
              <li key={id} className="rollout-row rollout-group">
                <div className="rollout-mark rollout-group-mark">
                  <button type="button" className="rollout-toggle" aria-expanded={open} onClick={flip}>
                    <Bubble entry={lead} state="" />
                    <span className="rollout-step-title">{title}</span>
                    <span className="rollout-step-name">{summary}</span>
                  </button>
                  {progress(row, title)}
                </div>
                {/* Closed, only the session the composer talks to stays mounted, unseen: its composer comes from it. */}
                {/* Closed, a dot per session says there is more under this line than a single step has. */}
                {!open && (
                  <button type="button" className="rollout-dots" aria-label={`Show ${row.length} agents`} onClick={flip}>
                    {sorted.slice(0, MAX_DOTS).map((entry) => (
                      <span key={entry.session.id} className={`rollout-bubble${entry.auxiliary ? " aux" : ""}${stateClass(entry)}`} title={entry.session.name || entry.title} />
                    ))}
                    {row.length > MAX_DOTS && <span>… +{row.length - MAX_DOTS}</span>}
                  </button>
                )}
                <div hidden={!open}>{sorted.filter((entry) => open || entry === target).map((entry) => turn(entry, true))}</div>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="rollout-composer">
        {running.length > 1 && target && (
          <label className="rollout-to">
            To
            <select value={target.session.id} onChange={(event) => setPicked(event.target.value)}>
              {running.map((entry) => (
                <option key={entry.session.id} value={entry.session.id}>
                  {[entry.stepNumber, entry.title, entry.session.name].filter(Boolean).join(" · ")}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="rollout-composer-slot" ref={setComposerSlot} data-empty={target ? "Connecting to the session…" : "No session is running. Start one to send a message."} />
      </div>
    </div>
  );
}
