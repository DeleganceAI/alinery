import { Hand } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import "./PlaybookRing.css";
import { selectorsOverlap } from "./PlaybookGraph";
import type { NormalizedStep } from "./types";

// A playbook drawn as a ring (docs/ux/playbook-pane-ring on claude/ring-pane, and the alinery.ai hero): the ring is
// step i → i+1, a chord is one file a later step reads, a dashed inner rail is a file two or more later steps read, the
// dashed closing arc is the loop, a stacked node fans out, and a hand waits for the human. Position is a closed-form
// function of index, so the ring fits any box with no panning.

export type RingEdge = { from: number; to: number; path: string };
export type RingRail = { from: number; path: string; consumers: number[] };
export type RingEdges = { rails: RingRail[]; chords: RingEdge[]; loop: RingEdge | null };

/** Producer→consumer edges by selector overlap (the rule PlaybookGraph uses), sorted into what the ring draws. */
export function classifyRingEdges(steps: NormalizedStep[]): RingEdges {
  const edges: RingEdge[] = [];
  steps.forEach((consumer, to) => {
    for (const input of consumer.inputs) {
      steps.forEach((producer, from) => {
        if (from !== to && producer.outputs.some((output) => selectorsOverlap(output.path, input.path))) edges.push({ from, to, path: input.path });
      });
    }
  });
  // ponytail: an artifact read by two or more later non-adjacent steps is a rail, anything else a chord.
  // Context artifacts (a brief every later step reads) would otherwise be five chords each.
  const byArtifact = new Map<string, RingEdge[]>();
  for (const edge of edges) {
    if (edge.to <= edge.from + 1) continue;
    const key = `${edge.from}|${edge.path}`;
    byArtifact.set(key, [...(byArtifact.get(key) ?? []), edge]);
  }
  const rails: RingRail[] = [];
  const chords: RingEdge[] = [];
  for (const group of byArtifact.values()) {
    const consumers = [...new Set(group.map((edge) => edge.to))].sort((a, b) => a - b);
    if (consumers.length >= 2) rails.push({ from: group[0].from, path: group[0].path, consumers });
    else chords.push(group[0]);
  }
  rails.sort((a, b) => a.from - b.from);
  const loop = edges.find((edge) => edge.from === steps.length - 1 && edge.to < edge.from) ?? null;
  return { rails, chords, loop };
}

/**
 * First prose paragraph of a step prompt: skips headings, lists, fences, tables, and template-only lines.
 * Every bundled step opens with the shared "## Execution contract" section, so that section is dropped first.
 */
export function promptExcerpt(prompt: string, max = 240): string {
  const own = prompt.replace(/^##\s+execution contract\b[\s\S]*?(?=\n#{1,2}\s|$(?![\s\S]))/im, "");
  for (const block of own.split(/\n\s*\n/)) {
    const paragraph = block.trim();
    if (!paragraph || /^(#|-|\*|\||```|\{\{|<|\d+\.)/.test(paragraph)) continue;
    // Strip emphasis markers only; underscores inside tokens like {{TASK_NAME}} stay.
    const text = paragraph.replace(/[`*]|\b_|_\b/g, "").replace(/\s+/g, " ");
    return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, "")}…` : text;
  }
  return "";
}

export const readsEach = (step: NormalizedStep) => step.inputs.some((input) => input.mode === "each");
const readsComplete = (step: NormalizedStep) => step.inputs.some((input) => input.mode === "complete");

/** A ring of `count` bare steps, for a listing that only says how many steps it has (the catalog sends no graph). */
export function placeholderSteps(count: number): NormalizedStep[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `step-${index}`,
    title: `Step ${index + 1}`,
    short: "",
    is_coding_step: false,
    auto_advance_default: true,
    inputs: [],
    outputs: [],
    model: "",
    harness: "",
    prompt: "",
  }));
}

function wrapTitle(title: string, max: number): string[] {
  const lines: string[] = [""];
  for (const word of title.split(" ")) {
    const current = lines[lines.length - 1];
    if (current && `${current} ${word}`.length > max) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`.trim();
  }
  if (lines.length > 2) return [lines[0], `${lines[1].slice(0, max - 1)}…`];
  return lines;
}

// Geometry in viewBox units; the SVG scales to its box. `full` labels its steps; `panel` numbers them.
const SIZES = {
  full: { w: 760, h: 520, r: 186, node: 11, strand: 5, labels: true },
  panel: { w: 300, h: 300, r: 116, node: 9, strand: 3.5, labels: false },
} as const;
const MAX_LABELS = 16;

type Geometry = { cx: number; cy: number; r: number; count: number };
const angleOf = (index: number, count: number) => -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(count, 1);
const pointOf = (g: Geometry, angle: number, radius: number): [number, number] => [g.cx + radius * Math.cos(angle), g.cy + radius * Math.sin(angle)];
function arcOf(g: Geometry, a1: number, a2: number, radius: number): string {
  const [x1, y1] = pointOf(g, a1, radius);
  const [x2, y2] = pointOf(g, a2, radius);
  return `M${x1},${y1} A${radius},${radius} 0 ${a2 - a1 > Math.PI ? 1 : 0} 1 ${x2},${y2}`;
}

type Props = {
  steps: NormalizedStep[];
  size?: keyof typeof SIZES;
  /** Names the ring for assistive technology, e.g. "Review ring". */
  label: string;
  /** The step that stays highlighted when nothing is hovered. */
  selectedStepKey: string | null;
  onSelectStep?: (key: string) => void;
  onHoverStep?: (key: string | null) => void;
  /** Rendered in the centre of the ring. */
  children?: ReactNode;
};

export function PlaybookRing({ steps, size = "full", label, selectedStepKey, onSelectStep, onHoverStep, children }: Props) {
  const id = useId();
  const spec = SIZES[size];
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const { rails, chords, loop } = classifyRingEdges(steps);
  const count = steps.length;
  const g: Geometry = { cx: spec.w / 2, cy: spec.h / 2, r: spec.r, count };
  const R = spec.r;
  const NODE_R = spec.node;
  const point = (angle: number, radius: number) => pointOf(g, angle, radius);
  const arcPath = (a1: number, a2: number, radius: number) => arcOf(g, a1, a2, radius);
  const labels = spec.labels && count <= MAX_LABELS;
  const focusIndex = steps.findIndex((step) => step.key === (hoveredKey ?? selectedStepKey));
  // Chords and the loop light up for the focused step; hovering fades the others. Rails never change.
  const edgeClass = (indexes: number[]) => (indexes.includes(focusIndex) ? " lit" : hoveredKey === null ? "" : " dim");
  const hover = (key: string | null) => {
    setHoveredKey(key);
    onHoverStep?.(key);
  };

  return (
    <section className={`playbook-ring playbook-ring-${size}`} aria-label={label}>
      {/* No <title>: WebKit shows it as a tooltip wherever the pointer rests. */}
      <svg viewBox={`0 0 ${spec.w} ${spec.h}`} preserveAspectRatio="xMidYMid meet" role="presentation" aria-hidden={count === 0 || undefined}>
        <defs>
          {(["chord", "loop"] as const).map((kind) => (
            <marker
              key={kind}
              id={`${id}-arrow-${kind}`}
              className={`ring-arrow-${kind}`}
              viewBox="0 0 10 10"
              refX="10"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path d="M0,0 L10,5 L0,10 z" />
            </marker>
          ))}
        </defs>
        {count === 1 && <circle className="ring-solo" cx={g.cx} cy={g.cy} r={R} />}
        {rails.map((rail, order) => {
          const radius = R - (size === "full" ? 16 + order * 9 : 12 + order * 6);
          if (radius < R * 0.45) return null;
          return (
            <g key={`${rail.from}-${rail.path}`} className="ring-rail">
              <path d={arcPath(angleOf(rail.from, count), angleOf(rail.consumers[rail.consumers.length - 1], count), radius)} />
              {rail.consumers.map((consumer) => {
                const angle = angleOf(consumer, count);
                const [x1, y1] = point(angle, radius);
                const [x2, y2] = point(angle, R - NODE_R - 1);
                return <path key={consumer} d={`M${x1},${y1} L${x2},${y2}`} />;
              })}
            </g>
          );
        })}
        {chords.map((chord) => {
          const [xa, ya] = point(angleOf(chord.from, count), R - NODE_R);
          const [xb, yb] = point(angleOf(chord.to, count), R - NODE_R);
          const qx = g.cx * 0.45 + ((xa + xb) / 2) * 0.55;
          const qy = g.cy * 0.45 + ((ya + yb) / 2) * 0.55;
          return (
            <path
              key={`${chord.from}-${chord.to}-${chord.path}`}
              className={`ring-edge ring-chord${edgeClass([chord.from, chord.to])}`}
              d={`M${xa},${ya} Q${qx},${qy} ${xb},${yb}`}
              markerEnd={`url(#${id}-arrow-chord)`}
            />
          );
        })}
        {steps.slice(0, -1).map((step, index) => {
          const a1 = angleOf(index, count);
          const a2 = angleOf(index + 1, count);
          const next = steps[index + 1];
          if (!readsEach(next) && !readsComplete(next)) return <path key={step.key} className="ring-segment" d={arcPath(a1, a2, R)} />;
          // Three strands: they spread out into a per-file step and merge back into a waits-for-all step.
          const mid = (a1 + a2) / 2;
          return (
            <g key={step.key} className="ring-segment">
              {[-spec.strand, 0, spec.strand].map((offset) => {
                const [x1, y1] = point(a1, R + (readsEach(next) ? 0 : offset));
                const [x2, y2] = point(a2, R + (readsEach(next) ? offset : 0));
                const [qx, qy] = point(mid, R + offset * 1.4);
                return <path key={offset} d={`M${x1},${y1} Q${qx},${qy} ${x2},${y2}`} />;
              })}
            </g>
          );
        })}
        {loop &&
          (() => {
            const a1 = angleOf(count - 1, count);
            const a2 = angleOf(count, count);
            const text = `${loop.path} · back to ${loop.to + 1}`;
            const dim = edgeClass([loop.from, loop.to]);
            // Back to step 1 the ring closes. Back to any other step it is a chord and the ring stays open.
            if (loop.to === 0) {
              return (
                <g className={`ring-edge ring-loop${dim}`}>
                  {/* Stops at the edge of node 1 so the arrowhead is not drawn under it. */}
                  <path d={arcPath(a1, a2 - (NODE_R + 2) / R, R)} markerEnd={`url(#${id}-arrow-loop)`} />
                  {labels && (
                    <>
                      <path id={`${id}-loop`} className="ring-loop-label" d={arcPath(a1, a2, R - 22)} />
                      <text>
                        <textPath href={`#${id}-loop`} startOffset="50%" textAnchor="middle">
                          {text}
                        </textPath>
                      </text>
                    </>
                  )}
                </g>
              );
            }
            const [xa, ya] = point(a1, R - NODE_R);
            const [xb, yb] = point(angleOf(loop.to, count), R - NODE_R);
            const qx = g.cx * 0.12 + ((xa + xb) / 2) * 0.88;
            const qy = g.cy * 0.12 + ((ya + yb) / 2) * 0.88;
            return (
              <g className={`ring-edge ring-loop${dim}`}>
                <path d={`M${xa},${ya} Q${qx},${qy} ${xb},${yb}`} markerEnd={`url(#${id}-arrow-loop)`} />
                {labels && (
                  <>
                    <path id={`${id}-loop`} className="ring-loop-label" d={`M${xa},${ya} Q${qx},${qy - 16} ${xb},${yb}`} />
                    <text>
                      <textPath href={`#${id}-loop`} startOffset="50%" textAnchor="middle">
                        {text}
                      </textPath>
                    </text>
                  </>
                )}
              </g>
            );
          })()}
        {steps.map((step, index) => {
          if (step.auto_advance_default) return null;
          // The hand sits on the segment after the checkpoint, where the pause is. A last step with no loop gets it just past the node.
          const angle = index === count - 1 && !loop ? angleOf(index, count) + ((2 * Math.PI) / count) * 0.3 : (angleOf(index, count) + angleOf(index + 1, count)) / 2;
          const [x, y] = point(angle, R);
          const hand = size === "full" ? 8 : 6.5;
          return (
            <g key={step.key} className="ring-hand">
              <circle cx={x} cy={y} r={hand} />
              <Hand size={hand * 1.25} x={x - hand * 0.625} y={y - hand * 0.625} strokeWidth={2.2} aria-hidden="true" />
            </g>
          );
        })}
        {steps.map((step, index) => {
          const angle = angleOf(index, count);
          const [x, y] = point(angle, R);
          const [lx, ly] = point(angle, R + 28);
          const cos = Math.cos(angle);
          const anchor = Math.abs(cos) < 0.25 ? "middle" : cos > 0 ? "start" : "end";
          const lines = labels ? wrapTitle(step.title, 22) : [];
          const classes = ["ring-node"];
          if (!step.auto_advance_default) classes.push("cp");
          if (index === focusIndex) classes.push("cur");
          const select = () => onSelectStep?.(step.key);
          return (
            <g
              key={step.key}
              className={classes.join(" ")}
              role="button"
              tabIndex={0}
              aria-label={step.title}
              aria-pressed={step.key === selectedStepKey}
              onClick={select}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  select();
                }
              }}
              onMouseEnter={() => hover(step.key)}
              onMouseLeave={() => hover(null)}
              onFocus={() => hover(step.key)}
              onBlur={() => hover(null)}
            >
              {readsEach(step) && (
                <>
                  <circle className="ghost" cx={x + NODE_R * 0.55} cy={y - NODE_R * 0.55} r={NODE_R} opacity={0.45} />
                  <circle className="ghost" cx={x + NODE_R * 0.27} cy={y - NODE_R * 0.27} r={NODE_R} opacity={0.8} />
                </>
              )}
              <circle className="main" cx={x} cy={y} r={NODE_R} />
              {/* A wider invisible target, so a small ring is still easy to hover. */}
              <circle className="hit" cx={x} cy={y} r={NODE_R + 6} />
              <text className="num" x={x} y={y + 3.5} textAnchor="middle">
                {index + 1}
              </text>
              {labels && (
                <text className="lbl" x={lx} y={ly + (lines.length === 2 ? -3 : 4)} textAnchor={anchor}>
                  {lines.map((line, row) => (
                    <tspan key={line} x={lx} dy={row ? 14 : 0}>
                      {line}
                    </tspan>
                  ))}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {children && <div className="playbook-ring-centre">{children}</div>}
    </section>
  );
}

/** The ring's centre: the playbook at rest, or the step being looked at. */
export function RingReadout({ title, steps, activeKey, excerpt }: { title?: string; steps: NormalizedStep[]; activeKey: string | null; excerpt?: boolean }) {
  const index = steps.findIndex((step) => step.key === activeKey);
  if (index < 0) {
    const checkpoints = steps.filter((step) => !step.auto_advance_default).length;
    const fans = steps.filter(readsEach).length;
    const loops = classifyRingEdges(steps).loop !== null;
    const facts = [checkpoints ? `${checkpoints} where you step in` : "runs on its own", fans && `${fans} fan${fans === 1 ? "s" : ""} out`, loops && "loops back"].filter(Boolean);
    return (
      <>
        <span className="ring-eyebrow">
          {steps.length} {steps.length === 1 ? "step" : "steps"}
        </span>
        {title && <strong className="ring-title">{title}</strong>}
        <span className="ring-sub">{facts.join(" · ")}</span>
      </>
    );
  }
  const step = steps[index];
  const how = !step.auto_advance_default ? "Waits for you" : readsEach(step) ? "One agent per item, all at once" : "Moves on by itself";
  const text = excerpt ? promptExcerpt(step.prompt) : "";
  return (
    <>
      <span className="ring-eyebrow">
        Step {index + 1} of {steps.length}
      </span>
      <strong className="ring-title">{step.title}</strong>
      <span className="ring-sub">
        {how}
        {step.is_coding_step && " · edits code"}
      </span>
      {text && <span className="ring-excerpt">{text}</span>}
    </>
  );
}

const MARK = { w: 40, h: 40, r: 15, node: 2.6 };
/** A playbook's ring at row size: shape only, no labels or interaction. Amber nodes wait for the human. */
export function PlaybookRingMark({ steps }: { steps: NormalizedStep[] }) {
  const count = steps.length;
  const g: Geometry = { cx: MARK.w / 2, cy: MARK.h / 2, r: MARK.r, count };
  const { chords, loop } = classifyRingEdges(steps);
  const closed = loop?.to === 0;
  return (
    <svg className="playbook-ring-mark" viewBox={`0 0 ${MARK.w} ${MARK.h}`} aria-hidden="true">
      {count <= 1 && <circle className="ring-solo" cx={g.cx} cy={g.cy} r={MARK.r} />}
      {chords.map((chord) => {
        const [xa, ya] = pointOf(g, angleOf(chord.from, count), MARK.r);
        const [xb, yb] = pointOf(g, angleOf(chord.to, count), MARK.r);
        return <path key={`${chord.from}-${chord.to}-${chord.path}`} className="ring-chord" d={`M${xa},${ya} Q${g.cx},${g.cy} ${xb},${yb}`} />;
      })}
      {steps.slice(0, -1).map((step, index) => (
        <path key={step.key} className="ring-segment" d={arcOf(g, angleOf(index, count), angleOf(index + 1, count), MARK.r)} />
      ))}
      {loop && closed && <path className="ring-loop" d={arcOf(g, angleOf(count - 1, count), angleOf(count, count), MARK.r)} />}
      {loop &&
        !closed &&
        (() => {
          const [xa, ya] = pointOf(g, angleOf(loop.from, count), MARK.r);
          const [xb, yb] = pointOf(g, angleOf(loop.to, count), MARK.r);
          return <path className="ring-loop" d={`M${xa},${ya} Q${g.cx},${g.cy} ${xb},${yb}`} />;
        })()}
      {steps.map((step, index) => {
        const [x, y] = pointOf(g, angleOf(index, count), MARK.r);
        return <circle key={step.key} className={`ring-dot${step.auto_advance_default ? "" : " cp"}${readsEach(step) ? " each" : ""}`} cx={x} cy={y} r={MARK.node} />;
      })}
    </svg>
  );
}
