import { ChevronRight, FileText } from "lucide-react";
import { type ReactNode, useState } from "react";
import { defaultFocus, formatElapsed, type RolloutEntry, type RolloutRow } from "./rolloutModel";
import { hasAcknowledgedExit, observationDisplayKind } from "./sessionAttention";
import { formatAbsolute, StatusDot } from "./shared";
import type { SessionDisplayMeta, SessionObservation } from "./types";
import { sessionTerminalLabel } from "./vinculumHarness";
import "./TaskRollout.css";

function Bubble({ entry, state }: { entry: RolloutEntry; state: string }) {
  return (
    <span className={`rollout-bubble${entry.auxiliary ? " aux" : ""}${state}`} role="img" aria-label={entry.stepNumber ? `Step ${entry.stepNumber}` : "Auxiliary session"}>
      {entry.stepNumber ?? ""}
    </span>
  );
}

/**
 * A task's sessions as one scroll, in the order they ran. Every step starts collapsed: a bubble, its status and the
 * files it published. Expanding one mounts the session itself (`renderSession`), so nothing here is a second
 * conversation; sessions that ran at the same time share a row, one wide and the rest as bars to switch to.
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
  /** The embedded session for an expanded step; `collapse` closes it (the session was archived). */
  renderSession: (session: SessionDisplayMeta, collapse: () => void) => ReactNode;
  onOpenSession: (session: SessionDisplayMeta) => void;
  onOpenArtifact: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<Record<string, string>>({});
  const kindOf = (entry: RolloutEntry) => (observations[entry.session.id] ? observationDisplayKind(observations[entry.session.id]) : "loading");
  const needsUser = (entry: RolloutEntry) => !entry.session.archived && ["waiting_for_input", "waiting_for_approval"].includes(kindOf(entry));
  const stateClass = (entry: RolloutEntry) => (needsUser(entry) ? " needs-user" : ["busy", "starting"].includes(kindOf(entry)) ? " running" : "");
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  if (!rows.length) return <p className="dim">No sessions yet.</p>;
  return (
    <ol className="rollout" aria-label="Rollout">
      {rows.map((row) => {
        const rowKey = row[0].session.id;
        const focusedId = row.some((entry) => entry.session.id === focus[rowKey]) ? focus[rowKey] : defaultFocus(row, needsUser);
        const entry = row.find((candidate) => candidate.session.id === focusedId) ?? row[0];
        const s = entry.session;
        const obs = observations[s.id] ?? null;
        const open = expanded.has(s.id);
        const superseded = Boolean(entry.execution && entry.execution.owner_session_id !== s.id);
        return (
          <li key={rowKey} className="rollout-row">
            <article className={`rollout-step${open ? " open" : ""}`}>
              <div className="rollout-step-head">
                <button type="button" className="rollout-toggle" aria-expanded={open} disabled={!s.worktree} onClick={() => toggle(s.id)}>
                  <ChevronRight size={14} aria-hidden="true" className="rollout-chevron" />
                  <Bubble entry={entry} state={stateClass(entry)} />
                  <span className="rollout-step-title">{entry.title}</span>
                  {s.name && <span className="dim rollout-step-name">{s.name}</span>}
                </button>
                <StatusDot
                  id={s.id}
                  slug={slug}
                  repoPath={repoPath}
                  observation={obs}
                  superseded={superseded}
                  exitCode={s.exit_code}
                  exitAcknowledged={hasAcknowledgedExit(s)}
                  terminalLabel={superseded ? null : sessionTerminalLabel(s.harness, s.id, entry.execution, entry.end != null)}
                />
                <span className="dim rollout-elapsed" title={`Started ${formatAbsolute(entry.start)}`}>
                  {formatElapsed((entry.end ?? now) - entry.start)}
                </span>
                <button type="button" className="btn ghost small" disabled={!s.worktree} onClick={() => onOpenSession(s)}>
                  Open session
                </button>
              </div>
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
              {open && <div className="rollout-session">{renderSession(s, () => toggle(s.id))}</div>}
            </article>
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
                      onClick={() => setFocus((current) => ({ ...current, [rowKey]: other.session.id }))}
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
  );
}
