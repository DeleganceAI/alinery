import { Hand } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { type SimulatedStepStatus, selectorsOverlap } from "./PlaybookGraph";
import type { NormalizedStep } from "./types";
import "./PlaybookRing.css";

export type RingEdge = { from: number; to: number; path: string };
export type RingRail = { from: number; path: string; consumers: number[] };
export type RingEdges = { rails: RingRail[]; chords: RingEdge[]; loop: RingEdge | null };

/**
 * Producer→consumer edges by selector overlap (the rule PlaybookGraph uses), sorted into what the
 * ring draws. Adjacent steps are the ring itself and are not returned.
 */
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

/** First prose paragraph of a step prompt: skips headings, lists, fences, tables, and template-only lines. */
export function promptExcerpt(prompt: string, max = 240): string {
  for (const block of prompt.split(/\n\s*\n/)) {
    const paragraph = block.trim();
    if (!paragraph || /^(#|-|\*|\||```|\{\{|<|\d+\.)/.test(paragraph)) continue;
    const text = paragraph.replace(/[`*_]/g, "").replace(/\s+/g, " ");
    return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, "")}…` : text;
  }
  return "";
}

const readsEach = (step: NormalizedStep) => step.inputs.some((input) => input.mode === "each");
const readsComplete = (step: NormalizedStep) => step.inputs.some((input) => input.mode === "complete");

// Geometry in viewBox units; the SVG scales to its pane, so the ring fits at any step count.
const W = 760;
const H = 520;
const CX = 380;
const CY = 262;
const R = 186;
const NODE_R = 11;
const point = (angle: number, radius: number): [number, number] => [CX + radius * Math.cos(angle), CY + radius * Math.sin(angle)];
const angleOf = (index: number, count: number) => -Math.PI / 2 + (index * 2 * Math.PI) / count;
function arcPath(a1: number, a2: number, radius: number): string {
  const [x1, y1] = point(a1, radius);
  const [x2, y2] = point(a2, radius);
  return `M${x1},${y1} A${radius},${radius} 0 ${a2 - a1 > Math.PI ? 1 : 0} 1 ${x2},${y2}`;
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

type Props = {
  steps: NormalizedStep[];
  selectedStepKey: string | null;
  simulatedStatuses?: Record<string, SimulatedStepStatus>;
  onSelectStep: (key: string) => void;
  onHoverStep?: (key: string | null) => void;
  /** Demo position, exposed as a progressbar so the ring doubles as the demo's progress indicator. */
  progress?: { now: number; max: number; text: string };
  /** Rendered in the centre of the ring. */
  children?: ReactNode;
};

export function PlaybookRing({ steps, selectedStepKey, simulatedStatuses = {}, onSelectStep, onHoverStep, progress, children }: Props) {
  const id = useId();
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const { rails, chords, loop } = classifyRingEdges(steps);
  const count = steps.length;
  const focusIndex = steps.findIndex((step) => step.key === (hoveredKey ?? selectedStepKey));
  const touches = (indexes: number[]) => hoveredKey === null || indexes.includes(focusIndex);
  const hover = (key: string | null) => {
    setHoveredKey(key);
    onHoverStep?.(key);
  };

  return (
    <div
      className="playbook-ring"
      role={progress ? "progressbar" : undefined}
      aria-label={progress ? "Playbook demo" : undefined}
      aria-valuemin={progress ? 1 : undefined}
      aria-valuemax={progress?.max}
      aria-valuenow={progress?.now}
      aria-valuetext={progress?.text}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" aria-hidden={count === 0 || undefined}>
        <title>{`${count} playbook steps as a ring`}</title>
        {rails.map((rail, order) => {
          const radius = R - 16 - order * 9;
          return (
            <g key={`${rail.from}-${rail.path}`} className={`ring-edge ring-rail${touches([rail.from, ...rail.consumers]) ? "" : " dim"}`}>
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
          const qx = CX * 0.45 + ((xa + xb) / 2) * 0.55;
          const qy = CY * 0.45 + ((ya + yb) / 2) * 0.55;
          return (
            <path
              key={`${chord.from}-${chord.to}-${chord.path}`}
              className={`ring-edge ring-chord${touches([chord.from, chord.to]) ? "" : " dim"}`}
              d={`M${xa},${ya} Q${qx},${qy} ${xb},${yb}`}
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
              {[-5, 0, 5].map((offset) => {
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
            const label = `${loop.path} · back to ${loop.to + 1}`;
            const dim = touches([loop.from, loop.to]) ? "" : " dim";
            // Back to step 1 the ring closes. Back to any other step it is a chord and the ring stays open.
            if (loop.to === 0) {
              return (
                <g className={`ring-edge ring-loop${dim}`}>
                  <path d={arcPath(a1, a2, R)} />
                  <path id={`${id}-loop`} className="ring-loop-label" d={arcPath(a1, a2, R - 22)} />
                  <text>
                    <textPath href={`#${id}-loop`} startOffset="50%" textAnchor="middle">
                      {label}
                    </textPath>
                  </text>
                </g>
              );
            }
            const [xa, ya] = point(a1, R - NODE_R);
            const [xb, yb] = point(angleOf(loop.to, count), R - NODE_R);
            const qx = CX * 0.12 + ((xa + xb) / 2) * 0.88;
            const qy = CY * 0.12 + ((ya + yb) / 2) * 0.88;
            return (
              <g className={`ring-edge ring-loop${dim}`}>
                <path d={`M${xa},${ya} Q${qx},${qy} ${xb},${yb}`} />
                <path id={`${id}-loop`} className="ring-loop-label" d={`M${xa},${ya} Q${qx},${qy - 16} ${xb},${yb}`} />
                <text>
                  <textPath href={`#${id}-loop`} startOffset="50%" textAnchor="middle">
                    {label}
                  </textPath>
                </text>
              </g>
            );
          })()}
        {steps.map((step, index) => {
          if (step.auto_advance_default) return null;
          // The hand sits on the segment after the checkpoint, where the pause is. A last step with no loop gets it just past the node.
          const angle = index === count - 1 && !loop ? angleOf(index, count) + ((2 * Math.PI) / count) * 0.3 : (angleOf(index, count) + angleOf(index + 1, count)) / 2;
          const [x, y] = point(angle, R);
          return (
            <g key={step.key} className="ring-hand">
              <circle cx={x} cy={y} r={8} />
              <Hand size={10} x={x - 5} y={y - 5} strokeWidth={2.2} aria-hidden="true" />
            </g>
          );
        })}
        {steps.map((step, index) => {
          const angle = angleOf(index, count);
          const [x, y] = point(angle, R);
          const [lx, ly] = point(angle, R + 28);
          const cos = Math.cos(angle);
          const anchor = Math.abs(cos) < 0.25 ? "middle" : cos > 0 ? "start" : "end";
          const lines = wrapTitle(step.title, 22);
          const status = simulatedStatuses[step.key];
          const classes = ["ring-node"];
          if (!step.auto_advance_default) classes.push("cp");
          if (status === "completed") classes.push("done");
          if (index === focusIndex) classes.push("cur");
          const select = () => onSelectStep(step.key);
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
                  <circle className="ghost" cx={x + 6} cy={y - 6} r={NODE_R} opacity={0.45} />
                  <circle className="ghost" cx={x + 3} cy={y - 3} r={NODE_R} opacity={0.8} />
                </>
              )}
              <circle className="main" cx={x} cy={y} r={NODE_R} />
              <text className="num" x={x} y={y + 3.5} textAnchor="middle">
                {index + 1}
              </text>
              <text className="lbl" x={lx} y={ly + (lines.length === 2 ? -3 : 4)} textAnchor={anchor}>
                {lines.map((line, row) => (
                  <tspan key={line} x={lx} dy={row ? 14 : 0}>
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          );
        })}
      </svg>
      {children && <div className="playbook-ring-centre">{children}</div>}
    </div>
  );
}
