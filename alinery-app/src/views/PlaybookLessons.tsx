import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import * as ipc from "../ipc";
import { PlaybookRing, RingReadout, stepOwnPrompt } from "../PlaybookRing";
import { InlineStatus } from "../shared";
import { toast } from "../toast";
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

const LEARN_URL = "https://alinery.ai/learn";

/** Onboarding's "Playbooks: Overview" page: what a playbook is and why the process matters, beside one real playbook's ring. */
export function PlaybookOverview({ playbook }: { playbook: NormalizedPlaybook | null }) {
  return (
    <>
      <div className="onboarding-overview-copy">
        <h2>A playbook is an expert's process, written down for agents</h2>
        <ul>
          <li>A playbook encodes how a human expert does a kind of work: the steps, their order, and what each one hands to the next.</li>
          <li>You launch it and you steer it. Agents do the steps, and you step in where the playbook waits for you.</li>
          <li>A playbook guarantees the agents follow that process. Each step runs in order, and its handoff is checked before the next one starts.</li>
          <li>Much of the work agents do can't be verified from the output alone. You can rely on the result only if you can rely on the process that produced it.</li>
        </ul>
      </div>
      <div className="onboarding-overview-ring">
        {playbook ? (
          <PlaybookRing steps={playbook.step} label={`${playbook.title} ring`} selectedStepKey={null}>
            <RingReadout title={playbook.title} steps={playbook.step} activeKey={null} />
          </PlaybookRing>
        ) : (
          <p role="status">Loading the example playbook…</p>
        )}
      </div>
    </>
  );
}

/** The four moves every playbook is built from. `tile` names its animation in handoffTiles.ts; the view boxes crop each to the same height. */
export const BUILDING_BLOCKS = [
  { tile: "branch", viewBox: "50 50 500 135", title: "Fan out, then merge" },
  { tile: "parallel", viewBox: "0 24 300 140", title: "Parallel steps" },
  { tile: "loop", viewBox: "0 40 300 115", title: "Loop back" },
  { tile: "human", viewBox: "0 60 300 85", title: "Human checkpoints" },
] as const;

/** Onboarding's "Playbooks: Components" page: the four moves, as four small animated tiles, and where to read more. */
export function LearnPlaybooks() {
  const root = useTiles();
  return (
    <>
      <h2>Playbooks are built from four composable moves</h2>
      <div className="onboarding-tiles" ref={root}>
        {BUILDING_BLOCKS.map((block) => (
          <figure key={block.tile} className="onboarding-tile">
            <svg viewBox={block.viewBox} data-tile={block.tile} aria-hidden="true" />
            <figcaption>{block.title}</figcaption>
          </figure>
        ))}
      </div>
      <a
        className="onboarding-learn-link"
        href={LEARN_URL}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          event.preventDefault();
          void ipc.openUrl(LEARN_URL).catch((cause: unknown) => toast(String(cause), "error"));
        }}
      >
        Learn how each one works at alinery.ai/learn
        <ExternalLink size={14} strokeWidth={1.5} aria-hidden="true" />
      </a>
    </>
  );
}

const noteDwell = () => NOTE_DWELL_MS;

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
          <div className="onboarding-prompt">
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
