import { useEffect, useRef, useState } from "react";
import { PlaybookRing, RingReadout, stepOwnPrompt } from "../PlaybookRing";
import { InlineStatus } from "../shared";
import type { NormalizedPlaybook } from "../types";
import { useTiles } from "./handoffTiles";

// The two onboarding lessons about what a playbook is. They show, not tell: the building blocks are the
// animated tiles from alinery.ai (Composable Swarm Dynamics), and the agents page reads a real step's prompt.

const NOTE_DWELL_MS = 3600;
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Steps through `count` items, staying `dwellMs(index)` on each, until the person chooses one. Stands still under reduced motion. */
function useAutoAdvance(count: number, dwellMs: (index: number) => number): [number, (index: number) => void] {
  const [index, setIndex] = useState(0);
  const [auto, setAuto] = useState(() => !reducedMotion());
  useEffect(() => {
    if (!auto || count < 2) return;
    const timer = window.setTimeout(() => setIndex((index + 1) % count), dwellMs(index));
    return () => window.clearTimeout(timer);
  }, [auto, count, dwellMs, index]);
  return [
    Math.min(index, Math.max(0, count - 1)),
    (next) => {
      setAuto(false);
      setIndex(next);
    },
  ];
}

/** The four moves every playbook is built from. `tile` names its animation in handoffTiles.ts; `dwellMs` is one loop of it. */
export const BUILDING_BLOCKS = [
  {
    tile: "branch",
    viewBox: "0 0 600 180",
    dwellMs: 7000,
    title: "Fan out, then merge",
    headline: "One agent per file. The next step waits for every one.",
    body: "A step can run once for each file the step before it wrote, in parallel. The step after it gets the whole collection, and starts when the last one is done.",
  },
  {
    tile: "parallel",
    viewBox: "0 0 300 170",
    dwellMs: 5600,
    title: "Parallel steps",
    headline: "Independent steps run at the same time.",
    body: "Two steps that need the same input but not each other both start at once. The step that joins them waits for both.",
  },
  {
    tile: "loop",
    viewBox: "0 0 300 150",
    dwellMs: 7500,
    title: "Loop back",
    headline: "Another pass, or a closing report.",
    body: "The last step decides. A fresh request sends the work back around with everything learned so far.",
  },
  {
    tile: "human",
    viewBox: "0 0 300 150",
    dwellMs: 5200,
    title: "Human checkpoints",
    headline: "The agent finishes its work and holds.",
    body: "Nothing moves on until you review it and say so.",
  },
] as const;

const blockDwell = (index: number) => BUILDING_BLOCKS[index].dwellMs;
const noteDwell = () => NOTE_DWELL_MS;

function BlockTile({ tile, viewBox }: { tile: string; viewBox: string }) {
  const root = useTiles();
  return (
    <div className="onboarding-tile" ref={root}>
      <svg viewBox={viewBox} data-tile={tile} aria-hidden="true" />
    </div>
  );
}

/** Onboarding's "Learning how to use playbooks" page: one building block at a time, described on the left and animated on the right. */
export function LearnPlaybooks() {
  const [index, choose] = useAutoAdvance(BUILDING_BLOCKS.length, blockDwell);
  const block = BUILDING_BLOCKS[index];
  return (
    <>
      <h2>Learning how to use playbooks</h2>
      <p className="onboarding-lede">Every playbook is built from four moves.</p>
      <div className="onboarding-block" id="onboarding-block-panel" role="tabpanel" aria-label={block.title}>
        <div className="onboarding-block-copy" key={block.tile}>
          <h3>{block.title}</h3>
          <p className="onboarding-block-headline">{block.headline}</p>
          <p>{block.body}</p>
        </div>
        <BlockTile key={block.tile} tile={block.tile} viewBox={block.viewBox} />
      </div>
      <div className="onboarding-block-tabs" role="tablist" aria-label="Building blocks">
        {BUILDING_BLOCKS.map((item, itemIndex) => (
          <button key={item.tile} type="button" role="tab" aria-selected={itemIndex === index} aria-controls="onboarding-block-panel" onClick={() => choose(itemIndex)}>
            {item.title}
          </button>
        ))}
      </div>
    </>
  );
}

/** The step whose prompt the agents page opens on, and the comments drawn beside the parts of it they match. */
export const ANNOTATED_STEP = "evaluate-source";
export const PROMPT_NOTES = [
  { starts: "You own one source", tone: "accent", label: "Its one job", note: "One agent reads one source." },
  { starts: "Write one assigned", tone: "success", label: "Handoff instructions", note: "The file the next step reads." },
  { starts: "1. **Identity", tone: "accent", label: "Expertise for the work", note: "How a careful reviewer appraises a source." },
  { starts: "Citation triage", tone: "warning", label: "Boundaries", note: "What to leave for another agent." },
  { starts: "Use only engine-assigned", tone: "success", label: "How to know when to finish", note: "Finish the handoff, then stop." },
] as const;

/** Onboarding's "Every step is its own agent" page: a real step's prompt, with comments on what each part is for. */
export function StepAgentsLesson({ playbook, error, onRetry }: { playbook: NormalizedPlaybook | null; error?: string; onRetry: () => void }) {
  const steps = playbook?.step ?? [];
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const step = steps.find((candidate) => candidate.key === (chosenKey ?? ANNOTATED_STEP)) ?? steps[0];
  const blocks = step
    ? stepOwnPrompt(step.prompt)
        .split(/\n{2,}/)
        .map((text) => ({ text, note: PROMPT_NOTES.find((note) => text.startsWith(note.starts)) }))
    : [];
  const noted = blocks.filter((block) => block.note);
  const [active, choose] = useAutoAdvance(noted.length, noteDwell);
  const activeNote = noted[active]?.note;
  // The prompt is longer than its pane, so the pane follows the comment being shown.
  const pane = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the highlighted comment or the step changes
  useEffect(() => {
    const block = pane.current?.querySelector<HTMLElement>("[data-active]");
    if (pane.current && block) pane.current.scrollTo?.({ top: block.offsetTop - pane.current.offsetTop - 12, behavior: "smooth" });
  }, [active, step?.key]);
  return (
    <>
      <div className="onboarding-agent-copy">
        <h2>Every step is its own agent</h2>
        <p className="onboarding-lede">A fresh agent runs each step, following a prompt written for that step. Read what it is told to do.</p>
        {playbook && step && (
          <PlaybookRing size="panel" steps={steps} label={`${playbook.title} ring`} selectedStepKey={step.key} onSelectStep={setChosenKey}>
            <RingReadout steps={steps} activeKey={step.key} />
          </PlaybookRing>
        )}
      </div>
      {playbook && step ? (
        <section className="onboarding-agent-stage" aria-label={`${playbook.title} step prompts`}>
          <h3>
            Agent {steps.indexOf(step) + 1} of {steps.length}: {step.title}
          </h3>
          <div className="onboarding-prompt" ref={pane}>
            {blocks.map((block, blockIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a prompt's paragraphs have no identity but their order
              <div key={blockIndex} className="onboarding-prompt-block" data-tone={block.note?.tone} data-active={(block.note && block.note === activeNote) || undefined}>
                <p>{block.text}</p>
                {block.note && (
                  <button type="button" className="onboarding-prompt-note" aria-pressed={block.note === activeNote} onClick={() => choose(noted.indexOf(block))}>
                    <strong>{block.note.label}</strong>
                    <span>{block.note.note}</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : (
        <div className="onboarding-agent-stage">
          {error ? (
            <>
              <InlineStatus tone="error" detail={error}>
                Couldn't load the example playbook.
              </InlineStatus>
              <button type="button" className="btn small" onClick={onRetry}>
                Retry
              </button>
            </>
          ) : playbook ? (
            <p role="status">The example playbook has no steps.</p>
          ) : (
            <p role="status">Loading the example playbook…</p>
          )}
        </div>
      )}
    </>
  );
}
