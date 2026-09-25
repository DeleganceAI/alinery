import { ArrowRight } from "lucide-react";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, layoutDefinitionGraph, reduceFlowConnections } from "./playbookGraphLayout";
import type { NormalizedStep } from "./types";
import { type PanZoomView, usePanZoom } from "./usePanZoom";
import { usePointerDrag } from "./usePointerDrag";
import "./PlaybookGraph.css";

/** The same literal-plus-one-star language as core; source order is not an edge. */
export function selectorsOverlap(left: string, right: string): boolean {
  const split = (path: string) => {
    const slash = path.lastIndexOf("/");
    const name = path.slice(slash + 1);
    const star = name.indexOf("*");
    return { directory: path.slice(0, slash + 1), prefix: star < 0 ? name : name.slice(0, star), suffix: star < 0 ? "" : name.slice(star + 1), wildcard: star >= 0 };
  };
  const a = split(left);
  const b = split(right);
  if (a.directory !== b.directory) return false;
  if (!a.wildcard && !b.wildcard) return a.prefix === b.prefix;
  if (a.wildcard && b.wildcard) return (a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix)) && (a.suffix.endsWith(b.suffix) || b.suffix.endsWith(a.suffix));
  const pattern = a.wildcard ? a : b;
  const exact = a.wildcard ? b.prefix : a.prefix;
  return exact.length >= pattern.prefix.length + pattern.suffix.length && exact.startsWith(pattern.prefix) && exact.endsWith(pattern.suffix);
}

export function PlaybookGraph({
  title,
  steps,
  countsByStep = {},
  selectedAutoAdvance = [],
  variant = "execution",
  showInspector = true,
  defaultModel = "",
  defaultHarness = "",
  graphFraction,
  onGraphFractionChange,
}: {
  title: string;
  steps: NormalizedStep[];
  countsByStep?: Record<string, number>;
  selectedAutoAdvance?: string[];
  variant?: "definition" | "execution";
  showInspector?: boolean;
  defaultModel?: string;
  defaultHarness?: string;
  graphFraction?: number;
  onGraphFractionChange?: (fraction: number) => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<"flow" | "dependencies">("flow");
  const [focusConnections, setFocusConnections] = useState(false);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const inspectorId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const zoomLabelRef = useRef<HTMLOutputElement>(null);
  const panButtonRef = useRef<HTMLButtonElement>(null);
  const initializedViewRef = useRef(false);
  const canvasEnabled = variant === "definition" && steps.length > 0;
  const paintView = useCallback(({ scale, tx, ty }: PanZoomView) => {
    if (stageRef.current) stageRef.current.style.transform = `translate(${tx}px, ${ty}px)`;
    if (canvasRef.current) canvasRef.current.style.zoom = String(scale);
    if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(scale * 100)}%`;
  }, []);
  const { viewRef, panning, setView, zoomBy, center, fit, onPointerDown } = usePanZoom({
    viewportRef,
    paint: paintView,
    enabled: canvasEnabled,
  });
  const fitGraph = () => {
    const canvas = canvasRef.current;
    if (canvas) fit(canvas.offsetWidth, canvas.offsetHeight);
  };
  const resetZoom = () => {
    const canvas = canvasRef.current;
    if (canvas) center(canvas.offsetWidth, canvas.offsetHeight, 1);
  };
  const splitRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const [localFraction, setLocalFraction] = useState(2 / 3);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [resizing, setResizing] = useState(false);
  const { start: startPointerDrag } = usePointerDrag();
  const minimumFraction = availableWidth > 0 ? Math.min(0.45, (GRAPH_NODE_WIDTH + 16) / availableWidth) : 0.2;
  const fraction = Math.max(minimumFraction, Math.min(1 - minimumFraction, graphFraction ?? localFraction));
  const changeFraction = (next: number) => {
    const bounded = Math.max(minimumFraction, Math.min(1 - minimumFraction, next));
    if (onGraphFractionChange) onGraphFractionChange(bounded);
    else setLocalFraction(bounded);
  };
  const selectedStep = steps.find((step) => step.key === selectedKey) ?? (showInspector ? steps[0] : undefined);
  const edges = useMemo(
    () =>
      variant === "definition"
        ? steps.flatMap((producer) =>
            steps.flatMap((consumer) =>
              consumer.inputs.flatMap((input) =>
                producer.outputs.filter((output) => selectorsOverlap(output.path, input.path)).map((output) => ({ from: producer, to: consumer, input, output })),
              ),
            ),
          )
        : [],
    [variant, steps],
  );
  const connections = useMemo(() => (variant === "definition" ? edges.map(({ from, to, output }) => ({ from: from.key, to: to.key, label: output.path })) : []), [variant, edges]);
  const flowConnections = useMemo(() => reduceFlowConnections(connections).map(({ from, to }) => ({ from, to })), [connections]);
  const layout = useMemo(
    () =>
      variant === "definition"
        ? layoutDefinitionGraph(
            steps.map((step) => step.key),
            displayMode === "flow" ? flowConnections : connections,
            new Set(steps.filter((step) => step.inputs.some((input) => input.mode === "each")).map((step) => step.key)),
          )
        : null,
    [variant, steps, displayMode, flowConnections, connections],
  );

  useLayoutEffect(() => {
    if (!canvasEnabled) {
      initializedViewRef.current = false;
      return;
    }
    const split = splitRef.current;
    const viewport = viewportRef.current;
    if (!split || !viewport) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    paintView(viewRef.current);
    const measure = () => {
      const width = split.clientWidth - (dividerRef.current?.offsetWidth ?? 0);
      if (width > 0) setAvailableWidth(width);
      if (!initializedViewRef.current && viewport.clientWidth > 0 && viewport.clientHeight > 0 && canvas.offsetWidth > 0 && canvas.offsetHeight > 0) {
        fit(canvas.offsetWidth, canvas.offsetHeight);
        initializedViewRef.current = true;
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(split);
    observer.observe(viewport);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvasEnabled, layout, showInspector, fit, paintView, viewRef]);

  if (variant === "definition" && layout) {
    const selectedEdges = showInspector ? edges.filter(({ from, to }) => from.key === selectedStep?.key || to.key === selectedStep?.key) : [];
    const stepsByKey = Object.fromEntries(steps.map((step) => [step.key, step]));
    const arrowId = `${inspectorId}-arrow`;
    const selectedArrowId = `${inspectorId}-selected-arrow`;
    // Filtering after layout keeps every node and route in place while focusing.
    const visibleEdges =
      displayMode === "dependencies" && focusConnections && selectedStep
        ? layout.edges.filter(({ from, to }) => from === selectedStep.key || to === selectedStep.key)
        : layout.edges;
    return (
      <section className="playbook-graph-view playbook-definition-graph" aria-label={`${title} graph`}>
        <div className="playbook-canvas-toolbar" role="group" aria-label="Graph display mode">
          <button type="button" className="btn ghost small" aria-pressed={displayMode === "flow"} onClick={() => setDisplayMode("flow")}>
            Flow
          </button>
          <button type="button" className="btn ghost small" aria-pressed={displayMode === "dependencies"} onClick={() => setDisplayMode("dependencies")}>
            Artifact dependencies
          </button>
          {displayMode === "dependencies" && (
            <button
              type="button"
              className="btn ghost small"
              aria-pressed={focusConnections}
              disabled={!selectedStep}
              title={selectedStep ? `Show only connections entering or leaving ${selectedStep.title}` : "Select a step first"}
              onClick={() => setFocusConnections((focused) => !focused)}
            >
              Focus connections
            </button>
          )}
        </div>
        <p id={`${inspectorId}-hint`} className="playbook-definition-hint">
          Static definition, not an execution trace.{" "}
          {displayMode === "flow"
            ? "Flow shows dependency ordering, not artifact forwarding. Cyclic graphs retain all connections."
            : "All declared dependencies. Hover a step or connection, or select a step, to reveal artifact names."}{" "}
          {showInspector ? "Inspect a step for its full inputs, outputs and connections." : "Select a step to highlight its connections."}
        </p>
        <p className="playbook-definition-hint">
          Wheel to zoom; drag the background to pan. Pan: +/− zoom, arrows move, Escape returns. Dashed arrows are return paths.
          {layout.ellipses.length > 0 && " Three example instances illustrate fan-out; actual counts vary."}
        </p>
        <div
          ref={splitRef}
          className={`playbook-definition-layout${resizing ? " resizing" : ""}`}
          style={{ gridTemplateColumns: showInspector ? `minmax(0, ${fraction}fr) var(--playbook-divider-width) minmax(0, ${1 - fraction}fr)` : "minmax(0, 1fr)" }}
        >
          <div className="playbook-definition-map">
            {steps.length > 0 ? (
              <>
                <div className="playbook-canvas-toolbar" role="group" aria-label="Graph zoom controls">
                  <button type="button" className="btn ghost small" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
                    −
                  </button>
                  <output ref={zoomLabelRef} aria-label="Graph zoom">
                    100%
                  </output>
                  <button type="button" className="btn ghost small" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
                    +
                  </button>
                  <button type="button" className="btn ghost small" onClick={fitGraph}>
                    Fit graph
                  </button>
                  <button type="button" className="btn ghost small" onClick={resetZoom}>
                    Reset zoom
                  </button>
                  <button ref={panButtonRef} type="button" className="btn ghost small" aria-label="Pan graph" onClick={() => viewportRef.current?.focus({ preventScroll: true })}>
                    Pan
                  </button>
                </div>
                <div
                  ref={viewportRef}
                  id={`${inspectorId}-graph`}
                  className={`playbook-definition-viewport${panning ? " is-panning" : ""}`}
                  role="region"
                  aria-label="Dependency graph canvas"
                  aria-describedby={`${inspectorId}-hint`}
                  tabIndex={-1}
                  onPointerDown={onPointerDown}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return;
                    const view = viewRef.current;
                    switch (event.key) {
                      case "Escape":
                        panButtonRef.current?.focus();
                        break;
                      case "+":
                      case "=":
                        zoomBy(1.25);
                        break;
                      case "-":
                        zoomBy(1 / 1.25);
                        break;
                      case "ArrowLeft":
                        setView({ ...view, tx: view.tx + 40 });
                        break;
                      case "ArrowRight":
                        setView({ ...view, tx: view.tx - 40 });
                        break;
                      case "ArrowUp":
                        setView({ ...view, ty: view.ty + 40 });
                        break;
                      case "ArrowDown":
                        setView({ ...view, ty: view.ty - 40 });
                        break;
                      default:
                        return;
                    }
                    event.preventDefault();
                  }}
                  onFocusCapture={(event) => {
                    const viewport = event.currentTarget;
                    const node = event.target.closest<HTMLButtonElement>(".playbook-definition-node");
                    if (!node || !viewport.clientWidth || !viewport.clientHeight) return;
                    // Focus must reveal nodes through the camera, not the hidden overflow's scroll offset.
                    viewport.scrollLeft = 0;
                    viewport.scrollTop = 0;
                    const bounds = viewport.getBoundingClientRect();
                    const rect = node.getBoundingClientRect();
                    const left = bounds.left + viewport.clientLeft + 16;
                    const top = bounds.top + viewport.clientTop + 16;
                    const right = left + viewport.clientWidth - 32;
                    const bottom = top + viewport.clientHeight - 32;
                    const dx = rect.left < left ? left - rect.left : rect.right > right ? Math.max(left - rect.left, right - rect.right) : 0;
                    const dy = rect.top < top ? top - rect.top : rect.bottom > bottom ? Math.max(top - rect.top, bottom - rect.bottom) : 0;
                    if (dx || dy) {
                      const view = viewRef.current;
                      setView({ ...view, tx: view.tx + dx, ty: view.ty + dy });
                    }
                  }}
                >
                  <div ref={stageRef} className="playbook-definition-stage">
                    <div
                      ref={canvasRef}
                      className="playbook-definition-canvas"
                      style={{ width: `calc(${layout.width}px * var(--ui-scale))`, height: `calc(${layout.height}px * var(--ui-scale))` }}
                    >
                      <svg
                        className="playbook-definition-connections"
                        viewBox={`0 0 ${layout.width} ${layout.height}`}
                        role="group"
                        aria-label={displayMode === "flow" ? "Flow ordering connections" : "Artifact dependency connections"}
                      >
                        <defs>
                          <marker id={arrowId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                            <path d="M 0 0 L 7 3.5 L 0 7 Z" className="playbook-definition-arrow" />
                          </marker>
                          <marker id={selectedArrowId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                            <path d="M 0 0 L 7 3.5 L 0 7 Z" className="playbook-definition-arrow selected" />
                          </marker>
                        </defs>
                        {visibleEdges.map(({ from, to, paths, feedback }) => {
                          const selected = from === selectedStep?.key || to === selectedStep?.key;
                          const description =
                            displayMode === "flow"
                              ? "ordering"
                              : edges
                                  .filter((edge) => edge.from.key === from && edge.to.key === to)
                                  .map(({ input, output }) => `${output.path} → ${input.path} (${input.mode})`)
                                  .join("; ");
                          const label = `${stepsByKey[from].title} to ${stepsByKey[to].title}`;
                          const pair = JSON.stringify([from, to]);
                          return (
                            <g key={pair} aria-label={`${label}: ${description}`} onMouseEnter={() => setHoveredEdge(pair)} onMouseLeave={() => setHoveredEdge(null)}>
                              <title>
                                {label}: {description}
                              </title>
                              {paths.map((path) => (
                                <g key={path}>
                                  <path className="playbook-definition-connection-hit" d={path} />
                                  <path
                                    className={`playbook-definition-connection${selected ? " selected" : ""}${feedback ? " feedback" : ""}`}
                                    d={path}
                                    markerEnd={`url(#${selected ? selectedArrowId : arrowId})`}
                                  />
                                </g>
                              ))}
                            </g>
                          );
                        })}
                        {visibleEdges.map(
                          ({ from, to, label, labelX, labelY, labelWidth, labelHeight }) =>
                            displayMode === "dependencies" &&
                            label &&
                            (from === selectedKey || to === selectedKey || from === hoveredKey || to === hoveredKey || hoveredEdge === JSON.stringify([from, to])) && (
                              <foreignObject
                                key={JSON.stringify([from, to])}
                                x={labelX}
                                y={labelY}
                                width={labelWidth}
                                height={labelHeight}
                                onMouseEnter={() => setHoveredEdge(JSON.stringify([from, to]))}
                                onMouseLeave={() => setHoveredEdge(null)}
                              >
                                <div className={`playbook-definition-edge-label${from === selectedKey || to === selectedKey ? " selected" : ""}`} title={label}>
                                  {label}
                                </div>
                              </foreignObject>
                            ),
                        )}
                      </svg>
                      <div role="group" aria-label="Graph steps">
                        {layout.nodes.map(({ key, id, instance, x, y }) => {
                          const step = stepsByKey[key];
                          return (
                            <button
                              type="button"
                              className={`playbook-definition-node${instance === null ? "" : " illustrative"}`}
                              key={id}
                              style={{
                                left: `calc(${x}px * var(--ui-scale))`,
                                top: `calc(${y}px * var(--ui-scale))`,
                                width: `calc(${GRAPH_NODE_WIDTH}px * var(--ui-scale))`,
                                height: `calc(${GRAPH_NODE_HEIGHT}px * var(--ui-scale))`,
                              }}
                              aria-label={`${showInspector ? "Inspect" : "Highlight"} ${step.title}${instance === null ? "" : ` — example ${instance}`}`}
                              aria-pressed={selectedStep?.key === key}
                              aria-controls={showInspector ? inspectorId : undefined}
                              title={`${step.title}${instance === null ? "" : " — illustrative instance, not a fixed count"}`}
                              onClick={() => setSelectedKey(key)}
                              onMouseEnter={() => setHoveredKey(key)}
                              onMouseLeave={() => setHoveredKey(null)}
                            >
                              <span className="playbook-definition-node-title">{step.title}</span>
                              {instance !== null && <span className="playbook-definition-instance">Example {instance}</span>}
                            </button>
                          );
                        })}
                      </div>
                      {layout.ellipses.map(({ key, x, y }) => (
                        <span
                          key={key}
                          className="playbook-definition-ellipsis"
                          aria-hidden="true"
                          style={{ left: `calc(${x}px * var(--ui-scale))`, top: `calc(${y}px * var(--ui-scale))` }}
                        >
                          ⋯
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <p className="playbook-definition-hint">This playbook has no steps to inspect.</p>
            )}
            {edges.length === 0 && steps.length > 0 && <p className="playbook-definition-hint">No matching artifact selectors connect these steps.</p>}
          </div>
          {showInspector && selectedStep && (
            <div
              ref={dividerRef}
              className="playbook-definition-divider"
              role="separator"
              aria-label="Resize graph and description"
              aria-orientation="vertical"
              aria-controls={`${inspectorId}-graph ${inspectorId}`}
              aria-valuemin={Math.round(minimumFraction * 100)}
              aria-valuemax={Math.round((1 - minimumFraction) * 100)}
              aria-valuenow={Math.round(fraction * 100)}
              aria-valuetext={`Graph ${Math.round(fraction * 100)}%, description ${Math.round((1 - fraction) * 100)}%`}
              tabIndex={0}
              title="Drag to resize graph and description. Arrow keys adjust; Home and End reach the limits."
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                const width = (splitRef.current?.getBoundingClientRect().width ?? 0) - event.currentTarget.offsetWidth;
                if (width <= 0) return;
                event.preventDefault();
                event.currentTarget.focus();
                const startX = event.clientX;
                const startFraction = fraction;
                setResizing(true);
                startPointerDrag(event, {
                  onMove: (move) => changeFraction(startFraction + (move.clientX - startX) / width),
                  onComplete: (end) => {
                    if (end.type !== "pointercancel") changeFraction(startFraction + (end.clientX - startX) / width);
                    setResizing(false);
                  },
                });
              }}
              onKeyDown={(event) => {
                const next =
                  event.key === "ArrowLeft"
                    ? fraction - 0.025
                    : event.key === "ArrowRight"
                      ? fraction + 0.025
                      : event.key === "Home"
                        ? minimumFraction
                        : event.key === "End"
                          ? 1 - minimumFraction
                          : null;
                if (next === null) return;
                event.preventDefault();
                changeFraction(next);
              }}
            />
          )}
          {showInspector && selectedStep && (
            <section className="playbook-definition-inspector" id={inspectorId} aria-label={`${selectedStep.title} definition`}>
              <h3>{selectedStep.title}</h3>
              <p className="playbook-definition-hint">Full artifact dependencies, including connections omitted from Flow.</p>
              {selectedStep.inputs.some((input) => input.mode === "each") && (
                <p className="playbook-definition-hint">One instance per matching artifact. The example boxes share this step definition.</p>
              )}
              <dl className="playbook-definition-properties">
                <dt>Key</dt>
                <dd>
                  <code>{selectedStep.key}</code>
                </dd>
                <dt>Title</dt>
                <dd>{selectedStep.title}</dd>
                <dt>Short label</dt>
                <dd>{selectedStep.short || "Not specified"}</dd>
                <dt>Model</dt>
                <dd>{selectedStep.model || (defaultModel ? `Inherits playbook default: ${defaultModel}` : "Inherits task / product default")}</dd>
                <dt>Harness</dt>
                <dd>{selectedStep.harness || (defaultHarness ? `Inherits playbook default: ${defaultHarness}` : "Inherits task default")}</dd>
                <dt>Coding step</dt>
                <dd>{selectedStep.is_coding_step ? "Yes" : "No"}</dd>
                <dt>Automatic completion by default</dt>
                <dd>{selectedStep.auto_advance_default ? "Yes" : "No"}</dd>
              </dl>
              <h4>Inputs</h4>
              {selectedStep.inputs.length > 0 ? (
                <ul className="playbook-definition-selectors" aria-label={`${selectedStep.title} inputs`}>
                  {selectedStep.inputs.map((input) => (
                    <li key={`${input.path}:${input.mode}`}>
                      <code>{input.path}</code>
                      <span>{input.mode}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="playbook-definition-hint">No inputs</p>
              )}
              <h4>Outputs</h4>
              {selectedStep.outputs.length > 0 ? (
                <ul className="playbook-definition-selectors" aria-label={`${selectedStep.title} outputs`}>
                  {selectedStep.outputs.map((output) => (
                    <li key={output.path}>
                      <code>{output.path}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="playbook-definition-hint">No outputs</p>
              )}
              <details className="playbook-definition-edge-details">
                <summary>Connections ({selectedEdges.length})</summary>
                <ul className="playbook-definition-edges" aria-label={`${selectedStep.title} connections`}>
                  {selectedEdges.map(({ from, to, input, output }) => (
                    <li key={`${from.key}:${output.path}:${to.key}:${input.path}`} aria-label={`${from.title} to ${to.title}: ${input.mode}`}>
                      <div className="playbook-definition-edge-ends">
                        <button type="button" aria-controls={inspectorId} onClick={() => setSelectedKey(from.key)}>
                          {from.title}
                        </button>
                        <ArrowRight size={16} aria-hidden="true" />
                        <button type="button" aria-controls={inspectorId} onClick={() => setSelectedKey(to.key)}>
                          {to.title}
                        </button>
                        <span>({input.mode})</span>
                      </div>
                      <code>
                        {output.path} → {input.path}
                      </code>
                    </li>
                  ))}
                </ul>
                {selectedEdges.length === 0 && <p className="playbook-definition-hint">No matching artifact selectors connect this step.</p>}
              </details>
              <h4>Prompt</h4>
              <pre className="playbook-definition-prompt" aria-label={`${selectedStep.title} prompt`}>
                {selectedStep.prompt || "No prompt authored."}
              </pre>
            </section>
          )}
        </div>
      </section>
    );
  }
  return (
    <section className="playbook-graph-view" aria-label={`${title} graph`}>
      <div className="playbook-graph-title">{title}</div>
      <div className="playbook-chain" aria-label="Graph steps">
        {steps.map((step) => (
          <div className={`playbook-node${countsByStep[step.key] ? " solid" : " future"}`} key={step.key}>
            <div className="playbook-node-main">
              <span className="playbook-node-key">{step.short || step.key}</span>
              <span className="playbook-node-title">{step.title}</span>
            </div>
            <span aria-label={`${step.title}: ${countsByStep[step.key] ?? 0} active sessions`}>{countsByStep[step.key] ?? 0} active</span>
            {selectedAutoAdvance.includes(step.key) && <span title="Completion automatically authorized">Automatic</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
