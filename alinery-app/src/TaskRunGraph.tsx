import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, layoutDefinitionGraph } from "./playbookGraphLayout";
import type { RunGraphNode } from "./runGraphModel";
import { buildTaskRunGraph, occurrenceLabel } from "./runGraphModel";
import { StatusDot } from "./shared";
import type { SessionMeta, SessionObservation, TaskExecutionState } from "./types";
import { type PanZoomView, usePanZoom } from "./usePanZoom";
import "./TaskRunGraph.css";

function nodeName(node: RunGraphNode) {
  return "session" in node ? node.session.name || node.session.id : node.label;
}

export function TaskRunGraph({
  sessions,
  state,
  observations = {},
  onOpenSession,
  onOpenArtifact,
}: {
  sessions: SessionMeta[];
  state: TaskExecutionState | null;
  observations?: Record<string, SessionObservation>;
  onOpenSession: (session: SessionMeta) => void;
  onOpenArtifact: (relativePath: string) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [focusedEdge, setFocusedEdge] = useState<string | null>(null);
  const arrowId = `${useId()}-run-arrow`;
  const graph = useMemo(() => buildTaskRunGraph(sessions, state), [sessions, state]);
  const layout = useMemo(
    () =>
      layoutDefinitionGraph(
        [...graph.nodes.keys()],
        graph.connections.map((connection) => ({
          from: connection.from,
          to: connection.to,
          label: [...connection.artifacts.map(occurrenceLabel), ...(connection.resumed ? ["Resumed session (not an artifact)"] : [])].join("\n"),
        })),
      ),
    [graph],
  );
  const activeEdge = hoveredEdge ?? focusedEdge;
  const highlightedEdge = activeEdge ? layout.edges.find((edge) => JSON.stringify([edge.from, edge.to]) === activeEdge) : undefined;
  const connections = new Map(graph.connections.map((connection) => [JSON.stringify([connection.from, connection.to]), connection]));
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const enabled = graph.nodes.size > 0;
  const paintView = useCallback(({ scale, tx, ty }: PanZoomView) => {
    if (stageRef.current) stageRef.current.style.transform = `translate(${tx}px, ${ty}px)`;
    if (canvasRef.current) canvasRef.current.style.zoom = `calc(${scale} * var(--ui-scale))`;
    setZoom(scale);
  }, []);
  const { viewRef, panning, setView, zoomBy, onPointerDown, onFocusCapture } = usePanZoom({
    viewportRef,
    paint: paintView,
    minScale: 0.25,
    maxScale: 2,
    enabled,
  });
  const resetView = useCallback(() => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!viewport || !canvas) return;
    const width = canvas.getBoundingClientRect().width / viewRef.current.scale;
    setView({ scale: 1, tx: Math.max(0, (viewport.clientWidth - width) / 2), ty: 0 });
  }, [setView, viewRef]);
  useLayoutEffect(() => {
    if (enabled) resetView();
  }, [enabled, resetView]);

  return (
    <section className="task-run-graph" aria-label="Task run graph">
      {sessions.length === 0 && <p className="dim">No sessions yet.</p>}
      {graph.nodes.size > 0 && (
        <>
          <div className="task-run-toolbar" role="group" aria-label="Run graph zoom controls">
            <button type="button" className="btn ghost small" aria-label="Zoom out run graph" disabled={zoom <= 0.25} onClick={() => zoomBy(1 / 1.25)}>
              −
            </button>
            <output aria-label="Run graph zoom">{Math.round(zoom * 100)}%</output>
            <button type="button" className="btn ghost small" aria-label="Zoom in run graph" disabled={zoom >= 2} onClick={() => zoomBy(1.25)}>
              +
            </button>
            <button type="button" className="btn ghost small" onClick={resetView}>
              Reset view
            </button>
          </div>
          <div
            ref={viewportRef}
            className={`task-run-viewport${panning ? " is-panning" : ""}`}
            role="region"
            aria-label="Run graph canvas"
            tabIndex={-1}
            onPointerDown={onPointerDown}
            onFocusCapture={onFocusCapture}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return;
              const dx = event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0;
              const dy = event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0;
              if (!dx && !dy) return;
              event.preventDefault();
              const view = viewRef.current;
              setView({ ...view, tx: view.tx + dx, ty: view.ty + dy });
            }}
          >
            <div ref={stageRef} className="task-run-stage">
              <div ref={canvasRef} className="task-run-canvas" style={{ width: layout.width, height: layout.height, zoom: "var(--ui-scale)" }}>
                <svg className="task-run-paths" aria-hidden="true">
                  <defs>
                    <marker id={arrowId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                      <path d="M 0 0 L 8 4 L 0 8 z" />
                    </marker>
                    <marker id={`${arrowId}-active`} className="highlighted" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                      <path d="M 0 0 L 8 4 L 0 8 z" />
                    </marker>
                  </defs>
                  {layout.edges.map((edge) => (
                    <g key={JSON.stringify([edge.from, edge.to])}>
                      {edge.paths.map((path) => (
                        <path key={path} className="task-run-path" d={path} markerEnd={`url(#${arrowId})`} />
                      ))}
                    </g>
                  ))}
                  {highlightedEdge?.paths.map((path) => (
                    <path key={path} className="task-run-path highlighted" d={path} markerEnd={`url(#${arrowId}-active)`} />
                  ))}
                </svg>
                {layout.edges.map((edge) => {
                  const key = JSON.stringify([edge.from, edge.to]);
                  const connection = connections.get(key);
                  if (!connection) return null;
                  const from = graph.nodes.get(edge.from);
                  const to = graph.nodes.get(edge.to);
                  if (!from || !to) return null;
                  const provenance = `${nodeName(from)} → ${nodeName(to)}`;
                  return (
                    <div
                      key={key}
                      className="task-run-labels"
                      role="group"
                      aria-label={provenance}
                      style={{ left: edge.labelX, top: edge.labelY, width: edge.labelWidth }}
                      onMouseEnter={() => setHoveredEdge(key)}
                      onMouseLeave={() => setHoveredEdge(null)}
                      onFocus={() => setFocusedEdge(key)}
                      onBlur={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedEdge(null);
                      }}
                    >
                      {connection.artifacts.map((occurrence) => (
                        <button
                          type="button"
                          key={occurrence.id}
                          className="task-run-artifact"
                          title={`${occurrence.relative_path}\nOccurrence: ${occurrence.id}\nProducer execution: ${occurrence.producer_execution_id ?? "seed input"}\n${provenance}\n${edge.from} → ${edge.to}`}
                          aria-label={`Open artifact ${occurrence.relative_path}, occurrence ${occurrence.id}`}
                          onClick={() => onOpenArtifact(occurrence.relative_path)}
                        >
                          {occurrence.relative_path.slice(occurrence.relative_path.lastIndexOf("/") + 1)}
                        </button>
                      ))}
                      {connection.resumed && <span className="task-run-resume">Resumed session (not an artifact)</span>}
                    </div>
                  );
                })}
                {layout.nodes.map((position) => {
                  const node = graph.nodes.get(position.key);
                  if (!node || (!("session" in node) && node.seed)) return null;
                  const style = { left: position.x, top: position.y, width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT };
                  if (!("session" in node))
                    return (
                      <div key={node.key} className="task-run-node task-run-endpoint" style={style} title={node.detail}>
                        <strong>{node.label}</strong>
                        <span>{node.detail}</span>
                      </div>
                    );
                  const { session, execution } = node;
                  const observation = observations[session.id];
                  const previousAttempt = execution && execution.owner_session_id !== session.id;
                  const savedStatus = previousAttempt
                    ? "Previous attempt"
                    : (execution?.lifecycle.replace(/_/g, " ") ?? (session.ended_at != null ? "Exited" : "Status unavailable"));
                  return (
                    <button
                      type="button"
                      key={node.key}
                      className="task-run-node"
                      style={style}
                      aria-label={`Open session ${nodeName(node)}`}
                      title={`${nodeName(node)}\nSession: ${session.id}${execution ? `\nExecution: ${execution.id}` : ""}\n${savedStatus}${session.archived ? " · archived" : ""}`}
                      onClick={() => onOpenSession(session)}
                    >
                      <strong>{nodeName(node)}</strong>
                      <span className="task-run-node-status">
                        {observation ? <StatusDot id={session.id} observation={observation} notifyTransitions={false} /> : savedStatus}
                        {session.archived && " · archived"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
