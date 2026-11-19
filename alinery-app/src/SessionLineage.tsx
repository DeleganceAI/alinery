import { ChevronRight, FileText } from "lucide-react";
import { type ReactNode, useId, useMemo, useSyncExternalStore } from "react";
import { executionLineage } from "./executionLineage";
import { RunningIndicator } from "./Indicators";
import { selectorsOverlap } from "./PlaybookGraph";
import { observationDisplayKind } from "./sessionAttention";
import type { ExecutionRecord, SessionDisplayMeta, SessionMeta, SessionObservation, TaskExecutionReply } from "./types";
import "./SessionLineage.css";

const EXPANDED_KEY = "alinery.sessionNavigatorExpanded";
let unsavedExpanded: boolean | undefined;

function readExpanded() {
  if (unsavedExpanded !== undefined) return unsavedExpanded;
  try {
    return localStorage.getItem(EXPANDED_KEY) === "true";
  } catch {
    return false;
  }
}

function subscribeExpanded(refresh: () => void) {
  window.addEventListener(EXPANDED_KEY, refresh);
  window.addEventListener("storage", refresh);
  return () => {
    window.removeEventListener(EXPANDED_KEY, refresh);
    window.removeEventListener("storage", refresh);
  };
}

function toggleExpanded() {
  const next = !readExpanded();
  try {
    localStorage.setItem(EXPANDED_KEY, String(next));
    unsavedExpanded = undefined;
  } catch {
    unsavedExpanded = next;
  }
  // The browser's storage event only reaches other windows. Hidden session tabs stay mounted here.
  window.dispatchEvent(new Event(EXPANDED_KEY));
}

type Props = {
  id: string;
  name: string;
  phase: string;
  sessions: SessionDisplayMeta[];
  executionView: TaskExecutionReply | null;
  observations?: Record<string, SessionObservation | null | undefined>;
  error: string;
  artifactPaths: string[];
  readableArtifactPaths: string[];
  followControl?: ReactNode;
  onOpenSession?: (session: SessionMeta) => void;
  onOpenArtifact: (path: string) => void;
};

export function SessionLineage({
  id,
  name,
  phase,
  sessions,
  executionView,
  observations = {},
  error,
  artifactPaths,
  readableArtifactPaths,
  followControl,
  onOpenSession,
  onOpenArtifact,
}: Props) {
  const regionId = useId();
  const expanded = useSyncExternalStore(subscribeExpanded, readExpanded);
  const state = executionView?.state;
  const bySession = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const owners = useMemo(() => {
    const map = new Map<string, ExecutionRecord>();
    for (const record of Object.values(state?.executions ?? {})) {
      for (const attempt of record.previous_session_ids) map.set(attempt, record);
      if (record.owner_session_id) map.set(record.owner_session_id, record);
    }
    return map;
  }, [state]);
  const execution = owners.get(id);
  const lineage = useMemo(() => (state && execution ? executionLineage(state, execution) : undefined), [state, execution]);
  const selectedOwner = execution?.owner_session_id === id;
  const previousAttempt = Boolean(execution && !selectedOwner);
  const currentSession = execution && bySession.get(execution.owner_session_id);
  const parents = lineage?.parents ?? [];
  const successors = lineage?.successors ?? [];
  const inputs = lineage?.inputs ?? [];
  const published = selectedOwner ? (lineage?.published ?? []) : [];
  const completed = selectedOwner && execution?.lifecycle === "completed" && execution.shutdown_confirmed;
  const stale = Boolean(error) || (executionView != null && executionView.live?.status !== "available");
  const newest = useMemo(() => {
    let latest: SessionDisplayMeta | undefined;
    for (const session of sessions) {
      if (owners.has(session.id) && (!latest || session.created > latest.created || (session.created === latest.created && session.id > latest.id))) latest = session;
    }
    return latest;
  }, [sessions, owners]);
  const newestVisible = newest && (newest.id === id || [execution, ...parents, ...successors].some((record) => record?.owner_session_id === newest.id));
  const assignedPaths =
    expanded && selectedOwner && execution && !execution.receipt_id
      ? artifactPaths.filter((path) => execution.outputs.some((output) => selectorsOverlap(output.relative_path, path)) && !published.some((item) => item.relative_path === path))
      : [];
  const stepTitle = (record: ExecutionRecord) => executionView?.definition.step.find((step) => step.key === record.candidate.step_key)?.title || record.candidate.step_key;
  const sessionName = (session: SessionDisplayMeta) => {
    const record = owners.get(session.id);
    return session.name || (record && stepTitle(record)) || session.phase || "Unnamed session";
  };
  const sessionContent = (sessionId: string, label: string) => {
    const observation = observations[sessionId];
    return (
      <>
        <strong>{label}</strong>
        {!stale && observation && observationDisplayKind(observation) === "busy" && (
          <small>
            <RunningIndicator />
            Working…
          </small>
        )}
        {bySession.get(sessionId)?.archived && <small>Archived</small>}
        {newest?.id === sessionId && <small>Newest</small>}
      </>
    );
  };
  const sessionLink = (session: SessionDisplayMeta) => (
    <button
      key={session.id}
      type="button"
      className="lineage-node"
      aria-current={session.id === id ? "step" : undefined}
      disabled={!onOpenSession}
      title={`${sessionName(session)} · ${session.id}`}
      onClick={() => onOpenSession?.(session)}
    >
      {sessionContent(session.id, sessionName(session))}
    </button>
  );
  const attempts = (record?: ExecutionRecord) => {
    if (!record?.previous_session_ids.length) return null;
    const previous = record.previous_session_ids;
    return (
      <details className="lineage-attempts" key={record.id} open={previous.includes(id) || undefined}>
        <summary>Previous attempts ({previous.length})</summary>
        {previous.map((attemptId) => {
          const session = bySession.get(attemptId);
          if (session) return sessionLink(session);
          return (
            <span className="lineage-node" key={attemptId} aria-current={attemptId === id ? "step" : undefined}>
              {attemptId === id ? name || phase || attemptId : attemptId}
            </span>
          );
        })}
      </details>
    );
  };
  const step = (record: ExecutionRecord) => {
    const owner = bySession.get(record.owner_session_id);
    return (
      <div className="lineage-step" key={record.id}>
        {owner ? (
          sessionLink(owner)
        ) : (
          <span className="lineage-node">
            {stepTitle(record)}
            <small>{record.lifecycle === "queued" ? "Queued" : "Session unavailable"}</small>
          </span>
        )}
        {attempts(record)}
      </div>
    );
  };
  const artifact = (path: string, key: string, assigned = false) => (
    <button key={key} type="button" className="lineage-node lineage-artifact" disabled={!readableArtifactPaths.includes(path)} title={path} onClick={() => onOpenArtifact(path)}>
      <FileText size={13} aria-hidden="true" />
      <span>{path.slice(path.lastIndexOf("/") + 1)}</span>
      {assigned && <small>Not yet published</small>}
    </button>
  );
  const nextCount = successors.filter((record) => bySession.has(record.owner_session_id)).length;
  return (
    <section className="session-lineage" aria-label="Session lineage">
      <div className="lineage-bar">
        <button type="button" className="lineage-toggle" aria-expanded={expanded} aria-controls={regionId} onClick={toggleExpanded}>
          <ChevronRight size={13} aria-hidden="true" />
          Session Navigator
          {completed && (
            <span>
              {" "}
              · Finished{stale ? " (last known state)" : ""} · {nextCount} next {nextCount === 1 ? "session" : "sessions"}
            </span>
          )}
        </button>
        {followControl}
      </div>
      <div id={regionId} hidden={!expanded}>
        {expanded && (
          <>
            <div className="lineage-flow" role="group" aria-label="Session neighborhood">
              <div>
                <h3>Previous sessions</h3>
                {parents.length ? parents.map(step) : <span>No previous sessions</span>}
              </div>
              <div>
                <h3>Inputs</h3>
                {inputs.length ? inputs.map((item) => artifact(item.relative_path, item.id)) : <span>No input artifacts</span>}
              </div>
              <div>
                <h3>{execution ? "This step" : "This session"}</h3>
                {previousAttempt && execution ? (
                  <>
                    <span>Current attempt</span>
                    {currentSession ? sessionLink(currentSession) : <span>Session unavailable</span>}
                    <span>Viewing a previous attempt</span>
                  </>
                ) : (
                  <div className="lineage-node" aria-current="step">
                    {sessionContent(id, name || (execution && stepTitle(execution)) || phase || "Unnamed session")}
                  </div>
                )}
                {attempts(execution)}
              </div>
              <div>
                <h3>Outputs</h3>
                {published.map((item) => artifact(item.relative_path, item.id))}
                {assignedPaths.map((path) => artifact(path, path, true))}
                {!published.length && !assignedPaths.length && <span>{previousAttempt ? "Outputs belong to the current attempt" : "None produced yet"}</span>}
              </div>
              <div>
                <h3>Next sessions</h3>
                {successors.length ? successors.map(step) : <span>None created yet</span>}
              </div>
            </div>
            {(stale || (newest && !newestVisible)) && (
              <div className="lineage-footer">
                {stale && <span role="status">Showing last known relationships.</span>}
                {newest && !newestVisible && (
                  <button type="button" className="btn ghost small" title={newest.id} disabled={!onOpenSession} onClick={() => onOpenSession?.(newest)}>
                    Jump to newest · {sessionName(newest)}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
