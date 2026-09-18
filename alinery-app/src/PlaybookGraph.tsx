import { ArrowRight } from "lucide-react";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, layoutDefinitionGraph } from "./playbookGraphLayout";
import type { NormalizedStep } from "./types";
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
  defaultModel = "",
  defaultHarness = "",
}: {
  title: string;
  steps: NormalizedStep[];
  countsByStep?: Record<string, number>;
  selectedAutoAdvance?: string[];
  variant?: "definition" | "execution";
  defaultModel?: string;
  defaultHarness?: string;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const inspectorId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const selectedStep = steps.find((step) => step.key === selectedKey) ?? steps[0];
  const edges = useMemo(
    () =>
      steps.flatMap((producer) =>
        steps.flatMap((consumer) =>
          consumer.inputs.flatMap((input) =>
            producer.outputs.filter((output) => selectorsOverlap(output.path, input.path)).map((output) => ({ from: producer, to: consumer, input, output })),
          ),
        ),
      ),
    [steps],
  );
  const layout = useMemo(
    () =>
      variant === "definition"
        ? layoutDefinitionGraph(
            steps.map((step) => step.key),
            edges.map(({ from, to, output }) => ({ from: from.key, to: to.key, label: output.path })),
            new Set(steps.filter((step) => step.inputs.some((input) => input.mode === "each")).map((step) => step.key)),
          )
        : null,
    [variant, steps, edges],
  );

  useLayoutEffect(() => {
    if (!layout) return;
    const revealSelection = () => {
      const viewport = viewportRef.current;
      const selected = viewport?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
      if (!viewport || !selected || !viewport.clientWidth) return;
      viewport.scrollLeft = Math.max(0, selected.offsetLeft + selected.offsetWidth / 2 - viewport.clientWidth / 2);
    };
    revealSelection();
    window.addEventListener("resize", revealSelection);
    return () => window.removeEventListener("resize", revealSelection);
  }, [layout]);

  if (variant === "definition" && layout) {
    const selectedEdges = edges.filter(({ from, to }) => from.key === selectedStep?.key || to.key === selectedStep?.key);
    const stepsByKey = Object.fromEntries(steps.map((step) => [step.key, step]));
    const arrowId = `${inspectorId}-arrow`;
    const selectedArrowId = `${inspectorId}-selected-arrow`;
    return (
      <section className="playbook-graph-view playbook-definition-graph" aria-label={`${title} graph`}>
        <p className="playbook-definition-hint">
          Select a step to inspect it. Arrows name the artifacts; dashed arrows return to earlier steps.
          {layout.ellipses.length > 0 && " Three example instances illustrate fan-out; actual counts vary."}
        </p>
        <div className="playbook-definition-layout">
          <div className="playbook-definition-map">
            {steps.length > 0 ? (
              <div ref={viewportRef} className="playbook-definition-viewport" role="region" aria-label="Dependency graph canvas">
                <div className="playbook-definition-canvas" style={{ width: `calc(${layout.width}px * var(--ui-scale))`, height: `calc(${layout.height}px * var(--ui-scale))` }}>
                  <svg className="playbook-definition-connections" viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="Artifact dependency connections">
                    <defs>
                      <marker id={arrowId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                        <path d="M 0 0 L 7 3.5 L 0 7 Z" className="playbook-definition-arrow" />
                      </marker>
                      <marker id={selectedArrowId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                        <path d="M 0 0 L 7 3.5 L 0 7 Z" className="playbook-definition-arrow selected" />
                      </marker>
                    </defs>
                    {layout.edges.map(({ from, to, paths, feedback }) => {
                      const selected = from === selectedStep?.key || to === selectedStep?.key;
                      const description = edges
                        .filter((edge) => edge.from.key === from && edge.to.key === to)
                        .map(({ input, output }) => `${output.path} → ${input.path} (${input.mode})`)
                        .join("; ");
                      const label = `${stepsByKey[from].title} to ${stepsByKey[to].title}`;
                      return (
                        <g key={JSON.stringify([from, to])} aria-label={`${label}: ${description}`}>
                          <title>
                            {label}: {description}
                          </title>
                          {paths.map((path) => (
                            <path
                              key={path}
                              className={`playbook-definition-connection${selected ? " selected" : ""}${feedback ? " feedback" : ""}`}
                              d={path}
                              markerEnd={`url(#${selected ? selectedArrowId : arrowId})`}
                            />
                          ))}
                        </g>
                      );
                    })}
                    {layout.edges.map(
                      ({ from, to, label, labelX, labelY, labelWidth, labelHeight }) =>
                        label && (
                          <foreignObject key={JSON.stringify([from, to])} x={labelX} y={labelY} width={labelWidth} height={labelHeight}>
                            <div className={`playbook-definition-edge-label${from === selectedStep?.key || to === selectedStep?.key ? " selected" : ""}`} title={label}>
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
                          aria-label={`Inspect ${step.title}${instance === null ? "" : ` — example ${instance}`}`}
                          aria-pressed={selectedStep?.key === key}
                          aria-controls={inspectorId}
                          title={`${step.title}${instance === null ? "" : " — illustrative instance, not a fixed count"}`}
                          onClick={() => setSelectedKey(key)}
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
            ) : (
              <p className="playbook-definition-hint">This playbook has no steps to inspect.</p>
            )}
            {edges.length === 0 && steps.length > 0 && <p className="playbook-definition-hint">No matching artifact selectors connect these steps.</p>}
          </div>
          {selectedStep && (
            <section className="playbook-definition-inspector" id={inspectorId} aria-label={`${selectedStep.title} definition`}>
              <h3>{selectedStep.title}</h3>
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
      <ul aria-label="Artifact dependencies">
        {edges.map(({ from, to, input, output }) => (
          <li key={`${from.key}:${output.path}:${to.key}:${input.path}`} aria-label={`${from.title} to ${to.title}: ${input.mode}`}>
            <span>{from.title}</span> <ArrowRight size={12} aria-hidden="true" /> <span>{to.title}</span>
            <code>
              {output.path} → {input.path}
            </code>{" "}
            <span>({input.mode})</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
