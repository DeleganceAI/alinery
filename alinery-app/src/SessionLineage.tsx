import { ArrowRight, ChevronRight, FileText } from "lucide-react";
import { useMemo, useState } from "react";
import { RunningIndicator } from "./Indicators";
import { buildTaskRunGraph, type RunGraphNode } from "./runGraphModel";
import { observationDisplayKind } from "./sessionAttention";
import type { ArtifactOccurrence, SessionDisplayMeta, SessionMeta, SessionObservation, TaskExecutionReply } from "./types";
import "./SessionLineage.css";

const NAVIGATOR_EXPANDED_KEY = "alinery.sessionNavigatorExpanded";

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
  onOpenSession,
  onOpenArtifact,
}: {
  id: string;
  name: string;
  phase: string;
  sessions: SessionDisplayMeta[];
  executionView: TaskExecutionReply | null;
  observations?: Record<string, SessionObservation | null | undefined>;
  error: string;
  artifactPaths: string[];
  readableArtifactPaths: string[];
  onOpenSession?: (session: SessionMeta) => void;
  onOpenArtifact: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(NAVIGATOR_EXPANDED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const graph = useMemo(() => buildTaskRunGraph(sessions, executionView?.state ?? null), [sessions, executionView]);
  const key = `session:${id}`;
  const current = graph.nodes.get(key);
  const execution = current && "session" in current ? current.execution : undefined;
  const incoming = graph.connections.filter((connection) => connection.to === key);
  const outgoing = graph.connections.filter((connection) => connection.from === key);
  const upstream = new Set(incoming.map((connection) => connection.from));
  const downstream = new Set(outgoing.map((connection) => connection.to));
  // Control-flow parents also cover handoffs without a published artifact edge.
  if (execution) {
    for (const parent of execution.parent_execution_ids) {
      const record = executionView?.state.executions[parent];
      if (record) upstream.add(`session:${record.owner_session_id}`);
    }
    if (execution.owner_session_id === id) {
      for (const record of Object.values(executionView?.state.executions ?? {})) {
        if (record.parent_execution_ids.includes(execution.id)) downstream.add(`session:${record.owner_session_id}`);
      }
    }
  }
  const relatedNodes = (keys: Set<string>) =>
    [...keys].flatMap((nodeKey) => {
      const node = graph.nodes.get(nodeKey);
      return node ? [node] : [];
    });
  const before = relatedNodes(upstream);
  const after = relatedNodes(downstream).filter((node) => "session" in node);
  const uniqueArtifacts = (connections: typeof incoming) => [
    ...new Map(connections.flatMap((connection) => connection.artifacts).map((artifact) => [artifact.id, artifact])).values(),
  ];
  const inputs = uniqueArtifacts(incoming);
  const outputs = uniqueArtifacts(outgoing);
  const publishedPaths = new Set(outputs.map((artifact) => artifact.relative_path));
  const unpublishedOutputs =
    execution?.owner_session_id === id ? execution.outputs.filter((output) => !publishedPaths.has(output.relative_path) && artifactPaths.includes(output.relative_path)) : [];
  const newest = [...graph.nodes.values()]
    .filter((node) => "session" in node && node.execution)
    .reduce<SessionDisplayMeta | undefined>(
      (latest, node) =>
        "session" in node && (!latest || node.session.created > latest.created || (node.session.created === latest.created && node.session.id > latest.id)) ? node.session : latest,
      undefined,
    );
  const completed = execution?.owner_session_id === id && execution.lifecycle === "completed";
  const stale = Boolean(error) || (executionView != null && executionView.live?.status !== "available");
  const newestVisible = newest && (newest.id === id || [...before, ...after].some((node) => "session" in node && node.session.id === newest.id));
  const sessionLabel = (session: SessionDisplayMeta) => {
    if (session.name) return session.name;
    const node = graph.nodes.get(`session:${session.id}`);
    const stepKey = node && "session" in node ? (node.execution?.candidate.step_key ?? session.phase) : session.phase;
    return executionView?.definition.step.find((step) => step.key === stepKey)?.title || stepKey || "Unnamed session";
  };
  const activityLabel = (sessionId: string) => {
    const observation = observations[sessionId];
    return !stale && observation && observationDisplayKind(observation) === "busy" ? (
      <span className="session-lineage-working">
        <RunningIndicator />
        Working…
      </span>
    ) : null;
  };
  const sessionLink = (node: RunGraphNode) => {
    if (!("session" in node))
      return (
        <span className="session-lineage-empty" key={node.key} title={node.detail}>
          {node.label}
        </span>
      );
    return (
      <button
        type="button"
        className="session-lineage-node"
        key={node.key}
        disabled={!onOpenSession}
        title={`${sessionLabel(node.session)} · ${node.session.id}`}
        onClick={() => onOpenSession?.(node.session)}
      >
        <strong>{sessionLabel(node.session)}</strong>
        <small>
          {activityLabel(node.session.id)}
          {node.session.archived ? " · Archived" : ""}
          {newest?.id === node.session.id && <span className="session-lineage-newest">Newest</span>}
        </small>
      </button>
    );
  };
  const artifactLink = (artifact: ArtifactOccurrence) => (
    <button
      type="button"
      className="session-lineage-node session-lineage-artifact"
      key={artifact.id}
      title={artifact.relative_path}
      disabled={!readableArtifactPaths.includes(artifact.relative_path)}
      onClick={() => onOpenArtifact(artifact.relative_path)}
    >
      <FileText size={13} aria-hidden="true" />
      <span>{artifact.relative_path.slice(artifact.relative_path.lastIndexOf("/") + 1)}</span>
    </button>
  );

  return (
    <section className="session-lineage" aria-label="Session lineage">
      <details className="session-lineage-details" open={expanded}>
        <summary
          onClick={(event) => {
            event.preventDefault();
            const next = !expanded;
            setExpanded(next);
            try {
              localStorage.setItem(NAVIGATOR_EXPANDED_KEY, String(next));
            } catch {
              // Keep the navigator usable when preference storage is unavailable.
            }
          }}
        >
          <span>
            <ChevronRight size={12} aria-hidden="true" />
            <span>Session Navigator</span>
            {completed && (
              <span>
                · Finished{stale ? " (last known state)" : ""} · {after.length} next {after.length === 1 ? "session" : "sessions"}
              </span>
            )}
          </span>
        </summary>
        <div className="session-lineage-flow" role="group" aria-label="Session neighborhood">
          <div className="session-lineage-column">
            <h3>Previous sessions</h3>
            {before.length ? before.map(sessionLink) : <span className="session-lineage-empty">No previous sessions</span>}
          </div>
          <ArrowRight className="session-lineage-arrow" size={16} aria-hidden="true" />
          <div className="session-lineage-column">
            <h3>Inputs</h3>
            {inputs.length ? inputs.map(artifactLink) : <span className="session-lineage-empty">No input artifacts</span>}
          </div>
          <ArrowRight className="session-lineage-arrow" size={16} aria-hidden="true" />
          <div className="session-lineage-column">
            <h3>This session</h3>
            <div className="session-lineage-node session-lineage-current" aria-current="step" title={id}>
              <strong>{name || phase || "Unnamed session"}</strong>
              <small>
                {activityLabel(id)}
                {newest?.id === id && <span className="session-lineage-newest">Newest</span>}
              </small>
            </div>
          </div>
          <ArrowRight className="session-lineage-arrow" size={16} aria-hidden="true" />
          <div className="session-lineage-column">
            <h3>Outputs</h3>
            {outputs.map(artifactLink)}
            {unpublishedOutputs.map((output) => (
              <button
                type="button"
                className="session-lineage-node"
                key={output.relative_path}
                title={output.relative_path}
                disabled={!readableArtifactPaths.includes(output.relative_path)}
                onClick={() => onOpenArtifact(output.relative_path)}
              >
                <span>{output.relative_path.slice(output.relative_path.lastIndexOf("/") + 1)}</span>
                <small>{readableArtifactPaths.includes(output.relative_path) ? "Not yet published" : "Not yet readable"}</small>
              </button>
            ))}
            {!outputs.length && !unpublishedOutputs.length && <span className="session-lineage-empty">None produced yet</span>}
          </div>
          <ArrowRight className="session-lineage-arrow" size={16} aria-hidden="true" />
          <div className="session-lineage-column">
            <h3>Next sessions</h3>
            {after.length ? after.map(sessionLink) : <span className="session-lineage-empty">None created yet</span>}
          </div>
        </div>
        {(stale || (newest && !newestVisible)) && (
          <div className="session-lineage-footer">
            {stale && <span role="status">Live lineage unavailable; showing last known relationships.</span>}
            {newest && !newestVisible && (
              <button type="button" className="session-lineage-shortcut" title={newest.id} disabled={!onOpenSession} onClick={() => onOpenSession?.(newest)}>
                Jump to newest: {sessionLabel(newest)} <ArrowRight size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </details>
    </section>
  );
}
