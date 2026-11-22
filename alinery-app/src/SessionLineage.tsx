import { ArrowRight, ChevronRight, FileText } from "lucide-react";
import { Children, type ReactNode, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { artifactLineage, executionLineage, hasPendingOutput } from "./executionLineage";
import { RunningIndicator } from "./Indicators";
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

function LineageFlow({ label, children }: { label: string; children: ReactNode[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const flow = ref.current;
    if (!flow) return;
    // On narrow panes the middle slot still opens in view. Users can pan to either end.
    let previousWidth: number | undefined;
    const center = () => {
      const width = flow.clientWidth;
      if (width === previousWidth) return;
      previousWidth = width;
      // Mirror the space used by the vertical scrollbar, including systems with overlay scrollbars.
      flow.style.setProperty("--lineage-gutter", `${flow.offsetWidth - width}px`);
      flow.scrollLeft = (flow.scrollWidth - width) / 2;
    };
    center();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(center);
    observer.observe(flow);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="lineage-flow" role="group" aria-label={label} ref={ref}>
      {Children.map(children, (slot, index) => (
        <>
          {index > 0 && <ArrowRight className="lineage-arrow" size={16} aria-hidden="true" />}
          {slot}
        </>
      ))}
    </div>
  );
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
  selectedFile?: { path: string; isTaskArtifact: boolean };
  viewingFile?: boolean;
  emptyMessage?: string;
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
  selectedFile,
  viewingFile = false,
  emptyMessage = "No sessions have been created for this task.",
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
  const filePath = selectedFile?.isTaskArtifact ? selectedFile.path : undefined;
  const fileLinks = useMemo(() => (expanded && filePath ? artifactLineage(state, filePath, artifactPaths) : undefined), [expanded, state, filePath, artifactPaths]);
  const showSession = !selectedFile;
  const lineage = useMemo(() => (showSession && state && execution ? executionLineage(state, execution) : undefined), [showSession, state, execution]);
  const selectedOwner = execution?.owner_session_id === id;
  const viewedSession = bySession.get(id);
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
  const fileBefore = fileLinks?.producers.length ? fileLinks.producers : (fileLinks?.assigned ?? []);
  const fileAfter = fileLinks?.consumers ?? [];
  const visibleSteps = selectedFile ? [...fileBefore, ...fileAfter] : [execution, ...parents, ...successors];
  const sourceLink = selectedFile && viewedSession && !visibleSteps.some((record) => record?.owner_session_id === id) ? viewedSession : undefined;
  const showNewest = newest && newest.id !== sourceLink?.id && !(showSession && newest.id === id) && !visibleSteps.some((record) => record?.owner_session_id === newest.id);
  const assignedPaths =
    showSession && expanded && selectedOwner && execution
      ? artifactPaths.filter((path) => hasPendingOutput(execution, path) && !published.some((item) => item.relative_path === path))
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
        <strong title={label}>{label}</strong>
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
      aria-current={showSession && session.id === id ? "step" : undefined}
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
        {showSession && attempts(record)}
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
          {showSession && completed && (
            <span>
              {" "}
              · Finished{stale ? " (last known state)" : ""} · {nextCount} next {nextCount === 1 ? "session" : "sessions"}
            </span>
          )}
        </button>
        {followControl}
      </div>
      <div id={regionId} className={id || selectedFile ? "lineage-panel" : undefined} hidden={!expanded}>
        {expanded && selectedFile && (
          <LineageFlow key={selectedFile.path} label="File handoff">
            <div>
              <h3>Producer inputs</h3>
              {fileLinks?.producerInputs.length ? fileLinks.producerInputs.map((path) => artifact(path, path)) : <span className="lineage-empty">No recorded inputs</span>}
            </div>
            <div>
              <h3>{fileLinks?.assigned.length ? "Assigned to" : "Produced by"}</h3>
              {fileBefore.length ? fileBefore.map(step) : <span className="lineage-empty">No recorded producer</span>}
            </div>
            <div>
              <h3>Open file</h3>
              <div className="lineage-node lineage-artifact" aria-current="page" title={selectedFile.path}>
                <FileText size={13} aria-hidden="true" />
                <span>{selectedFile.path.slice(selectedFile.path.lastIndexOf("/") + 1)}</span>
                {Boolean(fileLinks?.assigned.length) && <small>Not yet published</small>}
              </div>
            </div>
            <div>
              <h3>Used by</h3>
              {fileAfter.length ? fileAfter.map(step) : <span className="lineage-empty">No recorded consumers</span>}
            </div>
            <div>
              <h3>Consumer outputs</h3>
              {fileLinks?.consumerOutputs.length ? (
                fileLinks.consumerOutputs.map(({ path, assigned }) => artifact(path, path, assigned))
              ) : (
                <span className="lineage-empty">No recorded outputs</span>
              )}
            </div>
          </LineageFlow>
        )}
        {expanded && showSession && !id && (
          <div className="lineage-footer" role="status">
            {emptyMessage}
          </div>
        )}
        {expanded && showSession && id && (
          <LineageFlow key={id} label="Session neighborhood">
            <div>
              <h3>Previous sessions</h3>
              {parents.length ? parents.map(step) : <span className="lineage-empty">No previous sessions</span>}
            </div>
            <div>
              <h3>Inputs</h3>
              {inputs.length ? inputs.map((item) => artifact(item.relative_path, item.id)) : <span className="lineage-empty">No input artifacts</span>}
            </div>
            <div>
              <h3>{execution ? "This step" : "This session"}</h3>
              {previousAttempt && execution ? (
                <>
                  <span>Current attempt</span>
                  {currentSession ? sessionLink(currentSession) : <span>Session unavailable</span>}
                  <span>Viewing a previous attempt</span>
                </>
              ) : viewingFile && viewedSession ? (
                sessionLink(viewedSession)
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
              {!published.length && !assignedPaths.length && (
                <span className="lineage-empty">{previousAttempt ? "Outputs belong to the current attempt" : "None produced yet"}</span>
              )}
            </div>
            <div>
              <h3>Next sessions</h3>
              {successors.length ? successors.map(step) : <span className="lineage-empty">None created yet</span>}
            </div>
          </LineageFlow>
        )}
        {expanded && (id || selectedFile) && (stale || sourceLink || showNewest) && (
          <div className="lineage-footer">
            {stale && <span role="status">Showing last known relationships.</span>}
            {sourceLink && (
              <button type="button" className="btn ghost small" title={sourceLink.id} disabled={!onOpenSession} onClick={() => onOpenSession?.(sourceLink)}>
                Open session · {sessionName(sourceLink)}
              </button>
            )}
            {newest && showNewest && (
              <button type="button" className="btn ghost small" title={newest.id} disabled={!onOpenSession} onClick={() => onOpenSession?.(newest)}>
                Jump to newest · {sessionName(newest)}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
