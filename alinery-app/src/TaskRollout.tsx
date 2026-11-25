import { FileText } from "lucide-react";
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

/**
 * A task as one conversation: every session in the order it ran, each introduced by its step's bubble. A running
 * session shows one line of what it is doing; a click opens its messages in place. The session itself is mounted
 * for both (`renderSession`), so nothing here is a second conversation, and its composer lands in the one box
 * pinned at the bottom. Sessions that ran at the same time share a row, one wide and the rest as bars.
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
  const [focus, setFocus] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState("");
  // The session brought forward in its row is the one the composer talks to: its composer only exists while it is the wide one.
  const bring = (id: string) => {
    const rowKey = rows.find((row) => row.some((entry) => entry.session.id === id))?.[0].session.id;
    if (rowKey) setFocus((current) => ({ ...current, [rowKey]: id }));
    setPicked(id);
  };
  const [composerSlot, setComposerSlot] = useState<HTMLElement | null>(null);
  const kindOf = (entry: RolloutEntry) => (observations[entry.session.id] ? observationDisplayKind(observations[entry.session.id]) : "loading");
  const needsUser = (entry: RolloutEntry) => !entry.session.archived && ["waiting_for_input", "waiting_for_approval"].includes(kindOf(entry));
  const stateClass = (entry: RolloutEntry) => (needsUser(entry) ? " needs-user" : ["busy", "starting"].includes(kindOf(entry)) ? " running" : "");
  const isOpen = (entry: RolloutEntry) => toggled[entry.session.id] ?? needsUser(entry);

  // The one composer talks to a running session: the one the reader picked, else one waiting on them, else the newest step.
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
            const rowKey = row[0].session.id;
            const focusedId = row.some((entry) => entry.session.id === focus[rowKey]) ? focus[rowKey] : defaultFocus(row, needsUser);
            const entry = row.find((candidate) => candidate.session.id === focusedId) ?? row[0];
            const s = entry.session;
            const open = isOpen(entry);
            const live = entry.end == null && !s.archived;
            const superseded = Boolean(entry.execution && entry.execution.owner_session_id !== s.id);
            // The line beside a step is its progress: the files every session of the row owes, filled as they are written.
            const owed = row.flatMap((item) => item.artifacts);
            const total = owed.length;
            const done = owed.filter((artifact) => !artifact.pending).length;
            const fraction = total ? Math.max(MIN_PROGRESS, done / total) : row.every((item) => item.end != null) ? 1 : MIN_PROGRESS;
            const toggle = () => setToggled((current) => ({ ...current, [s.id]: !open }));
            return (
              <li key={rowKey} className="rollout-row">
                <div className="rollout-turn">
                  <div className="rollout-mark">
                    <button type="button" className="rollout-toggle" aria-expanded={open} disabled={!s.worktree} onClick={toggle}>
                      <Bubble entry={entry} state={stateClass(entry)} />
                      <span className="rollout-step-title">{entry.title}</span>
                      {s.name && <span className="rollout-step-name">{s.name}</span>}
                    </button>
                    <span
                      className="rollout-rule"
                      role="progressbar"
                      aria-label={`${entry.title} artifacts`}
                      aria-valuemin={0}
                      aria-valuemax={total}
                      aria-valuenow={done}
                      title={total ? `${done} of ${total} artifacts written` : undefined}
                    >
                      <span className="rollout-rule-fill" style={{ width: `${fraction * 100}%` }} />
                    </span>
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
                    <button type="button" className="rollout-open" disabled={!s.worktree} onClick={() => onOpenSession(s)}>
                      Open session
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
                {row.length > 1 && (
                  // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring its own border and legend layout
                  <div className="rollout-bars" role="group" aria-label="Running at the same time">
                    {row
                      .filter((other) => other !== entry)
                      .map((other) => (
                        <button
                          key={other.session.id}
                          type="button"
                          className="rollout-bar"
                          title={[other.title, other.session.name].filter(Boolean).join(" · ")}
                          aria-label={`Show ${other.title}${other.session.name ? `, ${other.session.name}` : ""}`}
                          onClick={() => bring(other.session.id)}
                        >
                          <Bubble entry={other} state={stateClass(other)} />
                          <span className="rollout-bar-title">{other.title}</span>
                        </button>
                      ))}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      <div className="rollout-composer">
        {running.length > 1 && target && (
          <label className="rollout-to">
            To
            <select value={target.session.id} onChange={(event) => bring(event.target.value)}>
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
