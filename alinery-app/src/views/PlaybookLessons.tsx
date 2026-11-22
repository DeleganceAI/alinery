import { useState } from "react";
import { PlaybookRing, RingReadout, stepOwnPrompt } from "../PlaybookRing";
import { InlineStatus } from "../shared";
import type { InputSelector, NormalizedPlaybook, NormalizedStep } from "../types";

// The two onboarding lessons about what a playbook is. Their copy follows alinery.ai (Composable Swarm
// Dynamics, What is a Playbook?), and every diagram is the same ring the library and New task draw.

const lessonStep = (title: string, outputs: string[], inputs: InputSelector[] = [], waits = false): NormalizedStep => ({
  key: title,
  title,
  short: "",
  is_coding_step: false,
  auto_advance_default: !waits,
  inputs,
  outputs: outputs.map((path) => ({ path })),
  model: "",
  harness: "",
  prompt: "",
});
const reads = (path: string, mode: InputSelector["mode"] = "single"): InputSelector => ({ path, mode });

/** The four moves every playbook is built from, each as the smallest playbook that shows it. */
export const BUILDING_BLOCKS: { title: string; headline: string; body: string; mark: string; steps: NormalizedStep[] }[] = [
  {
    title: "Fan out, then merge",
    headline: "One agent per file. The next step waits for every one.",
    body: "A step can run once for each file the step before it wrote, in parallel. The step after that receives the whole collection, and it does not start until the last one is done.",
    mark: "On the ring: a stacked node fans out, and the strands join where a step waits for all of them.",
    steps: [
      lessonStep("Find sources", ["source-request-*.md"]),
      lessonStep("Read one source", ["source-note-*.md"], [reads("source-request-*.md", "each")]),
      lessonStep("Synthesize", ["survey.md"], [reads("source-note-*.md", "complete")]),
    ],
  },
  {
    title: "Parallel steps",
    headline: "Independent steps can run together.",
    body: "Two steps that need the same input but not each other do not wait for one another. The step that joins them waits for both.",
    mark: "On the ring: steps sit in order, and a chord is a file a later step reads. Audit docs reads the brief, not the code audit, so the two audits can overlap.",
    steps: [
      lessonStep("Clarify", ["brief.md"]),
      lessonStep("Audit code", ["code-audit.md"], [reads("brief.md")]),
      lessonStep("Audit docs", ["docs-audit.md"], [reads("brief.md")]),
      lessonStep("Decide", ["decision.md"], [reads("code-audit.md"), reads("docs-audit.md")]),
    ],
  },
  {
    title: "Loop back",
    headline: "Another pass, or a closing report.",
    body: "The last step decides. A fresh request sends the work back around with everything learned so far. The number of passes is not fixed in advance.",
    mark: "On the ring: the dashed arc returns to an earlier step.",
    steps: [
      lessonStep("Find source", ["source.md"], [reads("ticket.md"), reads("next-request.md")]),
      lessonStep("Read source", ["notes.md"], [reads("source.md")]),
      lessonStep("Assess next step", ["next-request.md", "report.md"], [reads("notes.md")]),
    ],
  },
  {
    title: "Human checkpoints",
    headline: "The agent finishes its work and holds.",
    body: "Nothing moves on until you review the work and say so. You choose which steps wait for you when you create a task.",
    mark: "On the ring: a hand marks where the work waits for you.",
    steps: [lessonStep("Plan", ["plan.md"]), lessonStep("Decide", ["decision.md"], [reads("plan.md")], true), lessonStep("Build", ["change.md"], [reads("decision.md")])],
  },
];

/** Onboarding's "Learning how to use playbooks" page: what a playbook is, and its four building blocks. */
export function LearnPlaybooks() {
  return (
    <>
      <div className="onboarding-lesson-intro">
        <h2>Learning how to use playbooks</h2>
        <p className="onboarding-lede">
          A playbook is a ready-made team of agents that follows a process you chose ahead of time. Each agent has one responsibility and hands its work to the next as a file.
          Every playbook, however large, is built from four moves. Each card draws one as a ring, the same drawing Alinery uses for every playbook.
        </p>
      </div>
      <ul className="onboarding-lesson-grid" aria-label="The four building blocks of a playbook">
        {BUILDING_BLOCKS.map((block) => (
          <li key={block.title} className="onboarding-lesson-card">
            <PlaybookRing size="panel" steps={block.steps} label={`${block.title} ring`} selectedStepKey={null} />
            <div>
              <h3>{block.title}</h3>
              <p className="onboarding-lesson-chain">{block.steps.map((step) => step.title).join(" → ")}</p>
              <p className="onboarding-lesson-headline">{block.headline}</p>
              <p>{block.body}</p>
              <p className="onboarding-lesson-mark">{block.mark}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="onboarding-lesson-note">One more mark: a dashed inner rail is a file that several later steps read, such as a brief.</p>
    </>
  );
}

/** Onboarding's "Every step is its own agent" page, shown on a real playbook: pick a step, read the prompt its agent follows. */
export function StepAgentsLesson({ playbook, error, onRetry }: { playbook: NormalizedPlaybook | null; error?: string; onRetry: () => void }) {
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const steps = playbook?.step ?? [];
  const index = Math.max(
    0,
    steps.findIndex((step) => step.key === chosenKey),
  );
  const step = steps[index];
  return (
    <>
      <div className="onboarding-agent-copy">
        <h2>Every step is its own agent</h2>
        <p className="onboarding-lede">
          Each step of a playbook is a full, independent agent. It starts with a fresh context, receives the files its step names as inputs, and writes the files the next step
          needs.
        </p>
        <p className="onboarding-lede">
          What makes it good at its one job is its prompt. Every step carries its own instructions, written for that step by the playbook's author: what to look for, what to check,
          when to stop and what to hand over.
        </p>
        <ul className="onboarding-agent-points">
          <li>
            <strong>One responsibility.</strong> A seven-step playbook is seven agents, each briefed for one part of the work, not one agent holding the whole job in its context.
          </li>
          <li>
            <strong>An expert's prompt.</strong> You choose the process ahead of time, so the agent does not invent one each run. Choose any step to read the instructions its agent
            starts from.
          </li>
          <li>
            <strong>Its own model.</strong> A playbook can name the model each step uses, and you can change it per step when you create a task.
          </li>
        </ul>
      </div>
      {playbook && step ? (
        <section className="onboarding-agent-stage" aria-label={`${playbook.title} step prompts`}>
          <div className="onboarding-agent-ring">
            <PlaybookRing size="panel" steps={steps} label={`${playbook.title} ring`} selectedStepKey={step.key} onSelectStep={setChosenKey}>
              <RingReadout steps={steps} activeKey={step.key} />
            </PlaybookRing>
            <p className="onboarding-agent-hint">{playbook.title}. Choose a step on the ring to read its prompt.</p>
          </div>
          <div className="onboarding-agent-prompt">
            <h3>
              Agent {index + 1} of {steps.length}: {step.title}
            </h3>
            <p className="onboarding-artifact-path">
              Reads {step.inputs.length ? step.inputs.map((input) => input.path).join(", ") : "ticket.md"} · Writes{" "}
              {step.outputs.length ? step.outputs.map((output) => output.path).join(", ") : "no declared files"}
            </p>
            <p className="onboarding-artifact-path">Shown without the contract every step shares. Tokens such as {"{{TASK_NAME}}"} are filled in when the session starts.</p>
            <pre>{stepOwnPrompt(step.prompt)}</pre>
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
