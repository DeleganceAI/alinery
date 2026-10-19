import { ArrowRight, ChevronRight, FileText } from "lucide-react";
import { useMemo, useState } from "react";
import { buildTaskRunGraph, type RunGraphNode } from "./runGraphModel";
import type { ArtifactOccurrence, SessionDisplayMeta, SessionMeta, TaskExecutionReply } from "./types";
import "./SessionLineage.css";

const NAVIGATOR_EXPANDED_KEY = "alinery.sessionNavigatorExpanded";

export function SessionLineage({
  id,
  name,
  phase,
  sessions,
  executionView,
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
  const stale = Boolean(error) || (executionView != null && executionView.live.status !== "available");
  const sessionLabel = (session: SessionDisplayMeta) => session.name || session.id;
  const sessionLink = (node: RunGraphNode) => {
    if (!("session" in node))
      return (
        <span className="session-lineage-empty" key={node.key} title={node.detail}>
          {node.label}
        </span>
      );
    const previousOwner = node.execution && node.execution.owner_session_id !== node.session.id;
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
          {previousOwner ? "Previous attempt" : (node.execution?.lifecycle ?? (node.session.ended_at ? "Ended" : "Session"))}
          {node.session.archived ? " · Archived" : ""}
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
            Session Navigator
          </span>
        </summary>
        {completed && (
          <div className="session-lineage-finished" role="status">
            <strong>Session finished{stale ? " (last known state)" : ""}.</strong>
            {after.length > 0 ? (
              <>
                <span>Next sessions:</span>
                {after.map(sessionLink)}
              </>
            ) : (
              <span>{executionView?.assessment.status === "complete" ? "Playbook complete." : "No downstream sessions created yet."}</span>
            )}
          </div>
        )}
        <div className="session-lineage-flow" role="group" aria-label="Session neighborhood">
          <div className="session-lineage-column">
            <h3>Upstream sessions</h3>
            {before.length ? before.map(sessionLink) : <span className="session-lineage-empty">No upstream sessions</span>}
          </div>
          <ArrowRight className="session-lineage-arrow" size={16} aria-hidden="true" />
          <div className="session-lineage-column">
            <h3>Input artifacts</h3>
            {inputs.length ? inputs.map(artifactLink) : <span className="session-lineage-empty">No input artifacts</span>}
          </div>
          <ArrowRight className="session-lineage-arrow" size={16} aria-hidden="true" />
          <div className="session-lineage-column">
            <h3>This session</h3>
            <div className="session-lineage-node session-lineage-current" aria-current="step">
              <strong>{name || phase || id}</strong>
              <small>{execution?.owner_session_id === id ? execution.lifecycle : execution ? "Previous attempt" : phase || "Session"}</small>
            </div>
          </div>
          <ArrowRight className="session-lineage-arrow" size={16} aria-hidden="true" />
          <div className="session-lineage-column">
            <h3>Output artifacts</h3>
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
            <h3>Downstream sessions</h3>
            {after.length ? after.map(sessionLink) : <span className="session-lineage-empty">None created yet</span>}
          </div>
        </div>
        <div className="session-lineage-footer">
          <span>{stale ? "Live lineage unavailable; showing last known relationships." : "Direct relationships only · parallel sessions are stacked"}</span>
          {newest && (
            <span>
              Newest playbook session in this task:{" "}
              {newest.id === id ? (
                <strong>This session</strong>
              ) : (
                <button type="button" className="session-lineage-shortcut" disabled={!onOpenSession} onClick={() => onOpenSession?.(newest)}>
                  {sessionLabel(newest)} <ArrowRight size={12} aria-hidden="true" />
                </button>
              )}
            </span>
          )}
        </div>
      </details>
    </section>
  );
}
