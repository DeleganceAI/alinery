import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, layoutDefinitionGraph, reduceFlowConnections } from "./playbookGraphLayout";
import type { RunGraphNode } from "./runGraphModel";
import { buildTaskRunGraph, occurrenceLabel } from "./runGraphModel";
import { classifySessionNotice, hasAcknowledgedExit, hasUnacknowledgedExit } from "./sessionAttention";
import { StatusDot } from "./shared";
import type { ArtifactOccurrence, SessionMeta, SessionObservation, TaskExecutionState } from "./types";
import { type PanZoomView, usePanZoom } from "./usePanZoom";
import "./TaskRunGraph.css";

const MIN_ZOOM = 0.01;
const ARTIFACT_ROW_HEIGHT = 24;
const ARTIFACTS_GAP = 8;

function ArtifactLink({
  artifact,
  onOpenArtifact,
  onHoverArtifact,
  onFocusArtifact,
}: {
  artifact: ArtifactOccurrence;
  onOpenArtifact: (relativePath: string) => void;
  onHoverArtifact: (id: string | null) => void;
  onFocusArtifact: (id: string | null) => void;
}) {
  return (
    <button
      type="button"
      className="task-run-artifact"
      style={{ height: ARTIFACT_ROW_HEIGHT }}
      title={`${artifact.relative_path}\nOccurrence: ${artifact.id}\nProducer execution: ${artifact.producer_execution_id ?? "seed input"}`}
      aria-label={`Open artifact ${artifact.relative_path}, occurrence ${artifact.id}`}
      onClick={() => onOpenArtifact(artifact.relative_path)}
      onMouseEnter={() => onHoverArtifact(artifact.id)}
      onMouseLeave={() => onHoverArtifact(null)}
      onFocus={() => onFocusArtifact(artifact.id)}
      onBlur={() => onFocusArtifact(null)}
    >
      <span>{artifact.relative_path.slice(artifact.relative_path.lastIndexOf("/") + 1)}</span>
    </button>
  );
}

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
  const [displayMode, setDisplayMode] = useState<"flow" | "dependencies">("flow");
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [hoveredArtifactId, setHoveredArtifactId] = useState<string | null>(null);
  const [focusedArtifactId, setFocusedArtifactId] = useState<string | null>(null);
  const arrowId = `${useId()}-run-arrow`;
  const graph = useMemo(() => buildTaskRunGraph(sessions, state), [sessions, state]);
  const { artifacts, artifactsBySource, externalArtifacts, nodeHeights } = useMemo(() => {
    const unique = new Map<string, ArtifactOccurrence>();
    const bySource = new Map<string, ArtifactOccurrence[]>();
    const external: ArtifactOccurrence[] = [];
    for (const connection of graph.connections) {
      const source = graph.nodes.get(connection.from);
      for (const artifact of connection.artifacts) {
        if (unique.has(artifact.id)) continue;
        unique.set(artifact.id, artifact);
        if (source && "session" in source) {
          const outputs = bySource.get(source.key);
          if (outputs) outputs.push(artifact);
          else bySource.set(source.key, [artifact]);
        } else {
          external.push(artifact);
        }
      }
    }
    return {
      artifacts: [...unique.values()],
      artifactsBySource: bySource,
      externalArtifacts: external,
      nodeHeights: new Map([...bySource].map(([key, outputs]) => [key, GRAPH_NODE_HEIGHT + ARTIFACTS_GAP + outputs.length * ARTIFACT_ROW_HEIGHT])),
    };
  }, [graph]);
  const selectedArtifact = artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? artifacts[0];
  const visibleConnections = useMemo(() => {
    if (displayMode === "dependencies") {
      return graph.connections.filter((connection) => connection.artifacts.some((artifact) => artifact.id === selectedArtifact?.id));
    }
    const sessionConnections = graph.connections.filter((connection) => {
      const from = graph.nodes.get(connection.from);
      const to = graph.nodes.get(connection.to);
      return from && "session" in from && to && "session" in to;
    });
    const reduced = new Set(reduceFlowConnections(sessionConnections));
    // Resume history is a distinct relationship, even when an ordering path also exists.
    return sessionConnections.filter((connection) => reduced.has(connection) || connection.resumed);
  }, [graph, displayMode, selectedArtifact?.id]);
  const layout = useMemo(() => {
    const keys =
      displayMode === "flow"
        ? [...graph.nodes.values()].filter((node) => "session" in node).map((node) => node.key)
        : [...new Set(visibleConnections.flatMap((connection) => [connection.from, connection.to]))];
    // Fixed-size output labels belong to their producer, never to an arbitrary consumer edge.
    return layoutDefinitionGraph(keys, visibleConnections, undefined, undefined, displayMode === "flow" ? nodeHeights : undefined);
  }, [graph, displayMode, visibleConnections, nodeHeights]);
  const visualNodes = useMemo(() => [...layout.nodes].sort((left, right) => left.y - right.y || left.x - right.x || left.key.localeCompare(right.key)), [layout]);
  const resumedPairs = useMemo(
    () => new Set(visibleConnections.filter((connection) => connection.resumed).map((connection) => JSON.stringify([connection.from, connection.to]))),
    [visibleConnections],
  );
  const activeArtifactId = hoveredArtifactId ?? focusedArtifactId;
  const highlightedPairs = useMemo(
    () =>
      new Set(
        visibleConnections
          .filter((connection) => connection.artifacts.some((artifact) => artifact.id === activeArtifactId))
          .map((connection) => JSON.stringify([connection.from, connection.to])),
      ),
    [visibleConnections, activeArtifactId],
  );
  const viewportRef = useRef<HTMLDivElement>(null);
  const panButtonRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const enabled = layout.nodes.length > 0;
  const paintView = useCallback(({ scale, tx, ty }: PanZoomView) => {
    if (stageRef.current) stageRef.current.style.transform = `translate(${tx}px, ${ty}px)`;
    if (canvasRef.current) canvasRef.current.style.zoom = `calc(${scale} * var(--ui-scale))`;
    setZoom(scale);
  }, []);
  const { viewRef, panning, setView, zoomBy, onPointerDown, onFocusCapture } = usePanZoom({
    viewportRef,
    paint: paintView,
    minScale: MIN_ZOOM,
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
  const viewKey = JSON.stringify([displayMode, displayMode === "dependencies" ? selectedArtifact?.id : null]);
  const previousViewKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!enabled) {
      previousViewKey.current = null;
    } else if (previousViewKey.current !== viewKey) {
      previousViewKey.current = viewKey;
      resetView();
    }
  }, [enabled, resetView, viewKey]);

  return (
    <section className="task-run-graph" aria-label="Task run graph">
      {sessions.length === 0 && <p className="dim">No sessions yet.</p>}
      <div className="task-run-modes" role="group" aria-label="Run graph display mode">
        <button type="button" className="btn ghost small" aria-pressed={displayMode === "flow"} onClick={() => setDisplayMode("flow")}>
          Flow
        </button>
        <button type="button" className="btn ghost small" aria-pressed={displayMode === "dependencies"} onClick={() => setDisplayMode("dependencies")}>
          Artifact dependencies
        </button>
        {displayMode === "flow" && <p className="dim task-run-flow-hint">Session ordering · dashed links indicate resumed sessions.</p>}
      </div>
      {displayMode === "flow" && externalArtifacts.length > 0 && (
        <div className="task-run-shared-artifacts" role="group" aria-label="Seed inputs and artifacts whose producer is not shown">
          <span className="dim">Inputs &amp; other artifacts</span>
          {externalArtifacts.map((artifact) => (
            <ArtifactLink key={artifact.id} artifact={artifact} onOpenArtifact={onOpenArtifact} onHoverArtifact={setHoveredArtifactId} onFocusArtifact={setFocusedArtifactId} />
          ))}
        </div>
      )}
      {displayMode === "dependencies" && (
        <div className="task-run-artifact-details">
          {selectedArtifact ? (
            <>
              <label>
                Artifact occurrence
                <select value={selectedArtifact.id} onChange={(event) => setSelectedArtifactId(event.target.value)}>
                  {artifacts.map((artifact) => (
                    <option key={artifact.id} value={artifact.id}>
                      {occurrenceLabel(artifact)}
                    </option>
                  ))}
                </select>
              </label>
              <ArtifactLink artifact={selectedArtifact} onOpenArtifact={onOpenArtifact} onHoverArtifact={setHoveredArtifactId} onFocusArtifact={setFocusedArtifactId} />
              <div className="task-run-provenance" role="group" aria-label="Artifact provenance">
                <span>Producer execution: {selectedArtifact.producer_execution_id ?? "seed input"}</span>
              </div>
            </>
          ) : (
            <p className="dim">No published artifacts.</p>
          )}
        </div>
      )}
      <ul className={displayMode === "flow" ? "sr-only" : "task-run-provenance"} aria-label="Displayed connections">
        {visibleConnections.map((connection) => {
          const from = graph.nodes.get(connection.from);
          const to = graph.nodes.get(connection.to);
          if (!from || !to) return null;
          const provenance = `${nodeName(from)} → ${nodeName(to)}`;
          return (
            <li
              key={JSON.stringify([connection.from, connection.to])}
              aria-label={`${displayMode === "dependencies" ? "Artifact" : connection.resumed ? "Resumed session (not an artifact)" : "Ordering"}: ${provenance}`}
            >
              {provenance}
            </li>
          );
        })}
      </ul>
      {enabled && (
        <>
          <div className="task-run-toolbar" role="group" aria-label="Run graph zoom controls">
            <button type="button" className="btn ghost small" aria-label="Zoom out run graph" disabled={zoom <= MIN_ZOOM} onClick={() => zoomBy(1 / 1.25)}>
              −
            </button>
            <output aria-label="Run graph zoom">{Math.round(zoom * 100)}%</output>
            <button type="button" className="btn ghost small" aria-label="Zoom in run graph" disabled={zoom >= 2} onClick={() => zoomBy(1.25)}>
              +
            </button>
            <button type="button" className="btn ghost small" onClick={resetView}>
              Reset view
            </button>
            <button
              ref={panButtonRef}
              type="button"
              className="btn ghost small"
              aria-label="Pan run graph"
              title="Use arrow keys to pan; Escape returns to this button"
              onClick={() => viewportRef.current?.focus({ preventScroll: true })}
            >
              Pan
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
              if (event.key === "Escape") {
                event.preventDefault();
                panButtonRef.current?.focus();
                return;
              }
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
                        <path
                          key={path}
                          className={`task-run-path${displayMode === "flow" && resumedPairs.has(JSON.stringify([edge.from, edge.to])) ? " resumed" : ""}`}
                          d={path}
                          markerEnd={`url(#${arrowId})`}
                        />
                      ))}
                    </g>
                  ))}
                  {layout.edges
                    .filter((edge) => highlightedPairs.has(JSON.stringify([edge.from, edge.to])))
                    .flatMap((edge) =>
                      edge.paths.map((path) => (
                        <path
                          key={JSON.stringify([edge.from, edge.to, path])}
                          className={`task-run-path highlighted${displayMode === "flow" && resumedPairs.has(JSON.stringify([edge.from, edge.to])) ? " resumed" : ""}`}
                          d={path}
                          markerEnd={`url(#${arrowId}-active)`}
                        />
                      )),
                    )}
                </svg>
                {visualNodes.map((position) => {
                  const node = graph.nodes.get(position.key);
                  if (!node) return null;
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
                  const previousAttempt = Boolean(execution && execution.owner_session_id !== session.id);
                  const unreadCompletion = classifySessionNotice(session, observation) === "unread_completion";
                  const exitAcknowledged = hasAcknowledgedExit(session);
                  const savedStatus = previousAttempt
                    ? "Previous attempt"
                    : (execution?.lifecycle.replace(/_/g, " ") ?? (session.ended_at != null ? "Exited" : "Status unavailable"));
                  return (
                    <div
                      key={node.key}
                      className="task-run-session"
                      style={{ ...style, height: displayMode === "flow" ? (nodeHeights.get(node.key) ?? GRAPH_NODE_HEIGHT) : GRAPH_NODE_HEIGHT }}
                    >
                      <button
                        type="button"
                        className="task-run-node"
                        style={{ width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT }}
                        aria-label={`Open session ${nodeName(node)}`}
                        title={`${nodeName(node)}\nSession: ${session.id}${execution ? `\nExecution: ${execution.id}` : ""}\n${savedStatus}${session.archived ? " · archived" : ""}`}
                        onClick={() => onOpenSession(session)}
                      >
                        <strong>{nodeName(node)}</strong>
                        <span className="task-run-node-status">
                          {observation || unreadCompletion || hasUnacknowledgedExit(session) || exitAcknowledged ? (
                            <StatusDot
                              id={session.id}
                              observation={observation ?? null}
                              superseded={previousAttempt}
                              unreadCompletion={unreadCompletion}
                              exitCode={session.exit_code}
                              exitAcknowledged={exitAcknowledged}
                              notifyTransitions={false}
                            />
                          ) : (
                            savedStatus
                          )}
                          {session.archived && " · archived"}
                        </span>
                      </button>
                      {displayMode === "flow" && artifactsBySource.has(node.key) && (
                        <div className="task-run-output-labels" style={{ paddingTop: ARTIFACTS_GAP }} role="group" aria-label={`Artifacts published by ${nodeName(node)}`}>
                          {artifactsBySource.get(node.key)?.map((artifact) => (
                            <ArtifactLink
                              key={artifact.id}
                              artifact={artifact}
                              onOpenArtifact={onOpenArtifact}
                              onHoverArtifact={setHoveredArtifactId}
                              onFocusArtifact={setFocusedArtifactId}
                            />
                          ))}
                        </div>
                      )}
                    </div>
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
