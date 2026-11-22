import { useEffect, useState } from "react";
import { PlaybookRing, RingReadout, stepOwnPrompt } from "../PlaybookRing";
import { InlineStatus } from "../shared";
import type { NormalizedPlaybook } from "../types";
import { useTiles } from "./handoffTiles";

// The two onboarding lessons about what a playbook is. They show, not tell: the building blocks are the
// animated tiles from alinery.ai (Composable Swarm Dynamics), and the agents page walks a real playbook's ring.

/** The four moves every playbook is built from. `tile` names its animation in handoffTiles.ts. */
export const BUILDING_BLOCKS = [
  { tile: "branch", viewBox: "0 0 600 180", title: "Fan out, then merge", line: "One agent per file. The next step waits for every one." },
  { tile: "parallel", viewBox: "0 0 300 170", title: "Parallel steps", line: "Independent steps run at the same time." },
  { tile: "loop", viewBox: "0 0 300 150", title: "Loop back", line: "Another pass, or a closing report." },
  { tile: "human", viewBox: "0 0 300 150", title: "Human checkpoints", line: "The agent finishes its work and holds for you." },
] as const;

/** Onboarding's "Learning how to use playbooks" page: the four building blocks, each one animated. */
export function LearnPlaybooks() {
  const root = useTiles();
  return (
    <>
      <h2>Learning how to use playbooks</h2>
      <p className="onboarding-lede">Every playbook is built from four moves.</p>
      <div className="onboarding-tiles" ref={root}>
        {BUILDING_BLOCKS.map((block) => (
          <figure key={block.tile} className="onboarding-tile">
            <svg viewBox={block.viewBox} data-tile={block.tile} aria-hidden="true" />
            <figcaption>
              <strong>{block.title}</strong>
              <span>{block.line}</span>
            </figcaption>
          </figure>
        ))}
      </div>
    </>
  );
}

const AGENT_DWELL_MS = 3200;

/** Onboarding's "Every step is its own agent" page: a real playbook's ring walks step to step, showing the prompt each agent follows. */
export function StepAgentsLesson({ playbook, error, onRetry }: { playbook: NormalizedPlaybook | null; error?: string; onRetry: () => void }) {
  const steps = playbook?.step ?? [];
  const [index, setIndex] = useState(0);
  // The walk stops for good once the person chooses a step themself.
  const [walking, setWalking] = useState(() => !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const count = steps.length;
  useEffect(() => {
    if (!walking || count < 2) return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % count), AGENT_DWELL_MS);
    return () => window.clearInterval(timer);
  }, [walking, count]);
  const step = steps[Math.min(index, count - 1)];
  return (
    <>
      <div className="onboarding-agent-copy">
        <h2>Every step is its own agent</h2>
        <p className="onboarding-lede">A fresh agent runs each step, following a prompt written for that step.</p>
        {playbook && step && (
          <PlaybookRing
            size="panel"
            steps={steps}
            label={`${playbook.title} ring`}
            selectedStepKey={step.key}
            onSelectStep={(key) => {
              setWalking(false);
              setIndex(steps.findIndex((candidate) => candidate.key === key));
            }}
          >
            <RingReadout steps={steps} activeKey={step.key} />
          </PlaybookRing>
        )}
      </div>
      {playbook && step ? (
        <section className="onboarding-agent-stage" aria-label={`${playbook.title} step prompts`}>
          <h3>
            Agent {Math.min(index, count - 1) + 1} of {count}: {step.title}
          </h3>
          <pre key={step.key}>{stepOwnPrompt(step.prompt)}</pre>
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
