---
schema: alinery.playbook/sketch-0

playbook:
  id: bug-hunting
  title: Bug Hunting
  revision: 1
  status: potential
  description: >-
    Establish the cause of a reported failure, choose a justified resolution,
    and, when code must change, design, implement, and verify the correction.

steps:
  - id: root-cause-analysis
    title: Prove the Root Cause
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'Exists(["ticket.md"])'
    inputs: [ticket.md]
    outputs: [root-cause-analysis.md]
    instructions: "#root-cause-analysis"

  - id: evaluate-resolutions
    title: Evaluate Possible Resolutions
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'Exists(["root-cause-analysis.md"])'
    inputs: [root-cause-analysis.md]
    outputs:
      required: [resolution-options.md]
      possible:
        - selected-fix.md
        - investigation-needed.md
        - no-fix-required.md
    completion:
      human_approval:
        focus: resolution-options.md
        guidance: >-
          Confirm the proposed fix, further-investigation, or no-fix disposition
          before any automatic successor is considered.
    instructions: "#evaluate-resolutions"

  - id: design-the-fix
    title: Design the Fix
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'Exists(["selected-fix.md"])'
    inputs: [selected-fix.md]
    outputs: [fix-design.md]
    completion:
      human_approval:
        focus: fix-design.md
        guidance: >-
          Confirm the fix design, scope, tradeoffs, and regression-test contract
          before implementation begins.
    instructions: "#design-the-fix"

  - id: implement-and-verify
    title: Implement and Verify the Fix
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'Exists(["fix-design.md"])'
    inputs: [fix-design.md]
    outputs: [bug-fix-report.md]
    completion:
      human_approval:
        focus: bug-fix-report.md
        guidance: >-
          Review the fix, regression evidence, broader verification, and any
          required manual testing before accepting the result.
    instructions: "#implement-and-verify"
---

# Bug Hunting

This candidate Playbook is for a reported failure or suspected defect whose
cause is not yet proven. It separates four different jobs:

1. establish what fails and why;
2. compare materially different resolutions and choose whether code should
   change;
3. turn the selected correction into an implementation-ready design; and
4. implement the fix and prove that the diagnosed failure no longer occurs.

An unfavorable finding is not a failed Step. A Step fails only when it cannot
perform its own work reliably enough to publish the promised handoff.

## Process

```text
ticket.md
  -> Prove the Root Cause       -> root-cause-analysis.md
  -> Evaluate Resolutions       -> resolution-options.md
       [human approval gate]
       |-> no-fix-required.md       [no automatic successor]
       |-> investigation-needed.md  [manual RCA rerun if desired]
       `-> selected-fix.md
             -> Design the Fix       -> fix-design.md
                  [human approval gate]
             -> Implement and Verify -> bug-fix-report.md
                  [human approval gate]
```

<a id="root-cause-analysis"></a>
## Prove the Root Cause

Read the exact bound `ticket.md`, its attachments, and any evidence or inbound
handoff identified by the task. Inspect the complete input state when it
contains relevant logs, traces, screenshots, data, or prior investigation.

Restate the reported symptom as expected behavior, observed behavior, and the
conditions that trigger the difference. Reproduce it when safe and possible.
Record exact commands, inputs, environment facts, and observed output. If direct
reproduction is unavailable, distinguish the evidence that was observed from
the inference needed to explain it.

Trace the real execution path through the code. Read implementations rather
than inferring behavior from names, and inspect callers of the shared function,
type, or boundary where the defect appears. Temporary instrumentation or
scratch tests may be used to prove a hypothesis, but remove them before
completion and leave production behavior unchanged.

Write `root-cause-analysis.md` containing:

1. **Symptom:** the precise expected and observed behavior.
2. **Reproduction:** exact steps, commands, inputs, outputs, and environment,
   or a clear account of why direct reproduction was unavailable.
3. **Causal chain:** the ordered path from trigger to failure, with concrete
   file, symbol, and line evidence for every material link.
4. **Root cause:** the defect, environmental cause, expected behavior, or
   violated invariant where the chain terminates.
5. **Confidence:** high, medium, or low, with the evidence that determines it
   and what would raise it.
6. **Blast radius:** other callers, data, platforms, or workflows affected by
   the same cause or condition.
7. **Ruled-out hypotheses:** plausible causes investigated and the evidence
   that rejected them.
8. **Verification target:** the evidence that would confirm the diagnosis and,
   when code should change, the behavior a regression test must demonstrate
   before and after the fix.

Do not propose or implement a fix in this Step. Call `step_complete` only when
the causal account is sufficiently evidenced for another agent to evaluate
resolutions without guessing the cause. If only an unsupported hypothesis
remains, call `step_fail` with the missing evidence or access.

<a id="evaluate-resolutions"></a>
## Evaluate Possible Resolutions

Read the exact bound `root-cause-analysis.md`, then inspect the cited code and
the ticket as supporting context. If the code contradicts the causal chain,
call `step_fail`; do not build resolution options on an invalid diagnosis.

If the RCA has low confidence or could not reproduce the report, state that
prominently and include further investigation as a real option. A report may
also prove to be expected behavior, an environmental problem, a duplicate, or
another case where changing code is not justified.

Identify the materially different resolutions the evidence can support. For a
confirmed code defect, do not manufacture alternatives when there is only one
credible root-cause fix, and do not include unrelated refactors merely to
increase the option count.

Write `resolution-options.md` containing:

1. A concise restatement of the causal conclusion, confidence, and affected
   invariant or environment.
2. Each credible option's mechanism, exact change surface, causal coverage,
   blast radius, compatibility impact, risk, rough effort, and verification
   requirements.
3. A direct comparison on the dimensions that actually differ.
4. One proposed disposition and why it is the smallest credible next move.
5. What the proposed direction intentionally does not fix or change.
6. Material uncertainties or human decisions that could change the proposal.

Publish exactly one disposition artifact:

- `selected-fix.md` when a code correction should proceed, naming the exact
  option and the behavior it must restore;
- `investigation-needed.md` when more evidence is required before choosing a
  resolution, naming the missing evidence and next investigation; or
- `no-fix-required.md` when the evidence supports no code change, naming the
  conclusion and any documentation, configuration, or communication follow-up.

Do not design or implement a selected fix. Call `step_complete` when the
options and proposed disposition form a complete candidate. The approval gate
presents `resolution-options.md`; approval seals that exact state. Only
`selected-fix.md` makes Design eligible. A revision request continues this
atomic Step.

<a id="design-the-fix"></a>
## Design the Fix

Read the exact bound `selected-fix.md`. Its sealed producing state proves that
the disposition passed the engine-owned approval gate. Read the resolution
options, root-cause analysis, ticket, and relevant repository patterns from
that state as supporting context. Design the selected fix rather than silently
substituting another option.

Write `fix-design.md` containing:

1. The current behavior and the invariant the defect violates.
2. The desired behavior after the correction.
3. The exact components, symbols, interfaces, and data shapes to change.
4. The control flow or state transition before and after the fix when that
   relationship is not obvious from prose.
5. Compatibility, migration, rollback, concurrency, security, and failure-mode
   implications when relevant.
6. Explicit non-goals that keep the correction scoped to the diagnosed defect.
7. Existing codebase patterns the implementation should follow, with concrete
   paths and examples.
8. A regression-test contract that demonstrates the diagnosed failure before
   the fix and the corrected behavior afterward.
9. Additional targeted checks and any human-only manual verification.
10. Material design questions and a concrete proposed resolution for each.

Do not modify production code or write a step-by-step implementation log. Ask
the human within the Step when missing product intent or authority prevents a
responsible proposal. If repository evidence makes the selected fix technically
invalid, call `step_fail` with that evidence so the human can rerun Resolutions
with the durable failure record supplied as supplemental input. Call
`step_complete` when the design is complete enough to implement without
reopening material decisions. The approval gate presents `fix-design.md`;
approval seals the design state, while a revision request continues this atomic
Step.

<a id="implement-and-verify"></a>
## Implement and Verify the Fix

Read the exact bound `fix-design.md`. Its sealed producing state proves that
the design passed the engine-owned approval gate. Use the root-cause analysis,
resolution comparison, ticket, attachments, and repository instructions from
the same state as supporting context.

Turn the design into an internal checklist and implement it. Establish the
regression failure before changing production code when feasible. Then fix the
defect at the shared root cause, make the regression test pass for the right
reason, and inspect affected sibling callers. Preserve unrelated work, follow
the surrounding code's conventions, and avoid opportunistic refactors.

Run the repository-prescribed checks and the smallest additional checks that
exercise the changed behavior and plausible blast radius. Never weaken a valid
test to make the change pass, and never claim a command or manual check ran
when it did not.

Write `bug-fix-report.md` containing:

1. **What changed:** delivered behavior and important files or symbols changed.
2. **Regression proof:** the test or equivalent reproduction, its pre-fix
   failure, and its post-fix result.
3. **Verification:** every command actually run, its result, and relevant
   environment limitations.
4. **Design conformance:** how the implementation follows the approved design.
5. **Deviations:** anything changed from the design and why.
6. **Follow-ups:** residual risks, human-only checks, or genuinely deferred
   work.

If implementation evidence invalidates the root-cause analysis or approved
design, do not silently redesign. Call `step_fail` with the contradictory
evidence. The engine retains that durable failure record outside the successful
state DAG; the human may rerun the applicable earlier Step from the last sealed
state with the failure record supplied as supplemental input.

Call `step_complete` when the fix and all agent-executable verification are
complete. The approval gate presents `bug-fix-report.md` with the entire
candidate state. Approval seals the fix; a revision request continues this
atomic Step. The accepted state may ground a separate PR-preparation Playbook.

## Handoff and state conventions

Each successful Step publishes one successor task state. The primary handoffs
are `root-cause-analysis.md`, `resolution-options.md`, one exact disposition
artifact, `fix-design.md`, and `bug-fix-report.md`. Source changes, tests,
commands, and other files remain part of each complete state even though the
Markdown handoff focuses the next Step.

For a gated Step, `step_complete` freezes one exact candidate. The engine
records approval provenance and publishes the successor only after approval. A
revision request continues the same atomic Step and publishes no intermediate
state.

Each automatic Step application is claimed once for its Step-definition
revision and exact input binding. An inherited artifact does not make the same
Step fire again. A human may deliberately rerun an earlier Step from a selected
state to create a new execution and sibling lineage; no task-global latest
artifact or active branch determines the result.

An atomic Step should normally finish in one harness Session. When context
limits or interruption require continuation, later Sessions remain part of the
same execution. Session exit alone does not complete the Step.

## Why this is Playbook-friendly

The process is a linear investigation with one artifact-defined disposition
branch. Only `selected-fix.md` continues into Design; the other dispositions
become quiescent in inspectable states. Investigation may iterate inside an
atomic RCA execution. If later evidence invalidates an earlier conclusion, the
human may rerun the affected Step from the intended sealed state and include
the durable failure record as supplemental evidence.

No split or merge is needed for the default. A specialized Playbook could later
fan out independent hypotheses or platform reproductions and merge their
evidence before solution evaluation.

## Status and pilot

This is a candidate default Bug Hunting Playbook. Pilot it on one reproducible
logic defect, one intermittent bug, and one report that ultimately proves to be
expected behavior. Confirm that:

1. RCA distinguishes observations from hypotheses and changes no production
   behavior.
2. Resolution approval chooses a disposition before detailed design work
   begins.
3. Design approval resolves the material decisions needed by implementation.
4. Implementation proves the diagnosed behavior with red-to-green evidence or
   explains why an equivalent verification was necessary.
5. A contradicted diagnosis stops instead of being silently rewritten during a
   later Step.
