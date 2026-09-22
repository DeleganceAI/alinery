---
schema: alinery.playbook/v1

playbook:
  id: bug-hunting
  description: >-
    Establish the cause of a reported failure, choose a justified resolution,
    and, when code must change, design, implement, and verify the correction.
  budget_defaults:
    max_step_executions: 20
    max_wall_clock_seconds: 6000

steps:
  - id: root-cause-analysis
    harness: omp
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    inputs: [ticket.md]
    outputs: [root-cause-analysis.md]

  - id: evaluate-resolutions
    harness: omp
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    inputs: [ticket.md, root-cause-analysis.md]
    outputs: [resolution-options.md, selected-fix.md, investigation-needed.md, no-fix-required.md]
    completion:
      human_approval: true

  - id: design-the-fix
    harness: omp
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    inputs: [ticket.md, root-cause-analysis.md, resolution-options.md, selected-fix.md]
    outputs: [fix-design.md]
    completion:
      human_approval: true

  - id: implement-and-verify
    harness: omp
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    inputs: [ticket.md, root-cause-analysis.md, resolution-options.md, selected-fix.md, fix-design.md]
    outputs: [bug-fix-report.md]
    completion:
      human_approval: true
---

# Bug Hunting

This candidate Playbook is for a reported failure or suspected defect whose
cause is not yet proven. It separates four different jobs:

1. establish what fails and why;
2. compare materially different resolutions and choose whether code should
   change;
3. turn the selected correction into an implementation-ready design; and
4. implement the fix and prove that the diagnosed failure no longer occurs.

An unfavorable finding is not a failed Execution. If an agent cannot perform
its assigned work reliably enough to provide the handoff, it should explain
the blocker and leave completion unrequested. A specific failure-tool API is
not assumed by this Playbook.

## Process

```text
ticket.md
  -> Prove the Root Cause       -> root-cause-analysis.md
  -> Evaluate Resolutions       -> resolution-options.md
       [human review in conversation]
       |-> no-fix-required.md       [no automatic successor]
       |-> investigation-needed.md  [further investigation needs user direction]
       `-> selected-fix.md
             -> Design the Fix       -> fix-design.md
                  [human review in conversation]
             -> Implement and Verify -> bug-fix-report.md
                  [human review in conversation]
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

Do not propose or implement a fix in this Step. Use the engine-provided
completion operation only when the causal account is sufficiently evidenced
for another agent to evaluate resolutions without guessing the cause. If only
an unsupported hypothesis remains, explain the missing evidence or access to
the human and do not request completion.

<a id="evaluate-resolutions"></a>
## Evaluate Possible Resolutions

Read the exact bound `root-cause-analysis.md` and `ticket.md`, then inspect the
cited code. Confirm that the diagnosis addresses that report. If the code or
ticket contradicts the causal chain, explain the blocker to the human and leave
completion unrequested; do not build resolution options on an invalid diagnosis.

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

Write exactly one disposition artifact in the writable result-artifact area:

- `selected-fix.md` when a code correction should proceed, naming the exact
  option and the behavior it must restore;
- `investigation-needed.md` when more evidence is required before choosing a
  resolution, naming the missing evidence and next investigation; or
- `no-fix-required.md` when the evidence supports no code change, naming the
  conclusion and any documentation, configuration, or communication follow-up.

Do not design or implement a selected fix. Present `resolution-options.md`
and the proposed disposition to the human in the conversation. Obtain the
requested decision, address revisions, and record what was actually approved
in the options and chosen disposition artifact before requesting completion.
Do not infer approval from a captured State.

Keep this result truthful about the selected disposition. Remove an unchosen
disposition file from the writable result only when it is known to be this
Playbook's generated output; preserve uncertain or user-owned material and ask
for direction. This does not alter historical source snapshots, withdraw
existing claims or prevent work from older eligible States. There is no engine
exclusivity rule or automatic cleanup.

Design requires `selected-fix.md` together with the exact ticket, RCA and
resolution options. Record enough of the chosen option and supporting evidence
to check that these handoffs agree. When the resolution and chosen handoff are
ready, use the engine-provided completion operation. The other dispositions
have no automatic successor in this Playbook. The advisory output list names
all alternatives; an unchosen alternative need not be created.

<a id="design-the-fix"></a>
## Design the Fix

Read the exact bound `selected-fix.md`, resolution options, RCA and ticket,
including the recorded human decision. Verify that the selected option and
diagnosis agree with those exact handoffs; do not combine conflicting decisions
from different passes. Inspect relevant repository patterns in the assigned
sources. A captured State does not prove approval. If a required decision is
missing or inconsistent, obtain human direction before proceeding. Design the
selected fix without silently substituting another option.

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
invalid, explain the evidence and required follow-up to the human; do not
request completion or silently replace the recorded assignment.

Present `fix-design.md`, its scope, tradeoffs and regression-test contract to
the human for approval through the conversation. Resolve material questions
and requested revisions, and record the actual decision in the design. Use
the engine-provided completion operation when the approved design is clear
enough to implement without reopening material decisions.

<a id="implement-and-verify"></a>
## Implement and Verify the Fix

Read the exact bound `fix-design.md`, selected fix, resolution comparison, RCA
and ticket, including the recorded human decisions. Verify that the design
implements the chosen resolution for that diagnosis; surface conflicting
handoffs to the human before changing code. Use attachments and repository
instructions from the assigned source material as context. Check that the
required direction is documented; do not treat a captured State as proof of
approval.

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
design, stop implementation and explain the contradictory evidence to the
human. Preserve it and the disposition of partial work in `bug-fix-report.md`.
Do not request completion, silently redesign, or claim the engine will replay
an earlier Step. Ask for direction on the required follow-up work.

When the fix and all agent-executable verification are complete, finalize the
intended repository changes in Git. Present `bug-fix-report.md`, the fix and
its verification evidence to the human for the requested approval. Complete
required manual checks or record the human's explicit decision about them;
never imply that an unperformed check passed. Record the actual approval and
any accepted limits in the report. Address revisions and repeat affected
checks before using the engine-provided completion operation. Any separate
PR-preparation Playbook belongs to another Task or subtask.

## Handoff and State conventions

Follow engine-generated context for exact assigned inputs, source snapshots,
the writable repository and the result-artifact area. Primary handoffs are
`root-cause-analysis.md`, `resolution-options.md`, one chosen disposition,
`fix-design.md`, and `bug-fix-report.md`. Inspect the assigned repository as
well as its explanatory artifacts; a handoff is not the whole result.

Finalize intended repository changes in Git and put handoff files in the
result-artifact area before requesting completion. Accepted completion records
the actual result State and the Execution history. Unchanged material may reuse
a State; unchanged files do not become new outputs merely because they are
still present. Authored `outputs` remain advisory rather than a capture
whitelist or an engine-enforced completion checklist.

The advisory approval Boolean signals the conversation instructions in each
Step. The engine does not check or certify approval. Artifact comments may
inform review without changing accepted material.

An Execution is an attempt at a Step with its assigned inputs. Ordinary Session
exit without acceptance permits explicit Continue in the same unfinished
Execution. Recovery with no live Session uses explicit Retry from the original
inputs in a new attempt, without unaccepted partial edits. Obtain user direction
before Retry, including through MCP; the scheduler never retries automatically.
This Playbook assumes no arbitrary historical-Step replay operation.

The frontmatter budget defaults are editable limits on starting more Executions,
not duration predictions or hard ceilings for active work.

## Why this is Playbook-friendly

The process is a linear investigation with one artifact-defined disposition
branch. Design requires a selected fix and the exact governing handoffs; the
other dispositions leave no successor work defined here. This is not proof
that the reported problem has been solved, nor does a later disposition erase
historical eligibility. Investigation may iterate within the unfinished RCA
Execution. Later contradictory evidence calls for human-directed follow-up,
not an assumed replay mechanism.

No split or merge is needed for the default. A specialized Playbook could later
fan out independent hypotheses or platform reproductions and merge their
evidence before solution evaluation.

## Status and pilot

This is a draft v1 conversion of Bug Hunting, not a completed engine pilot.
Pilot it on one reproducible logic defect, one intermittent bug, and one report
that ultimately proves to be expected behavior. Confirm that:

1. RCA distinguishes observations from hypotheses and changes no production
   behavior.
2. Resolution approval chooses a disposition before detailed design work
   begins.
3. Design approval resolves the material decisions needed by implementation.
4. Implementation proves the diagnosed behavior with red-to-green evidence or
   explains why an equivalent verification was necessary.
5. A contradicted diagnosis stops instead of being silently rewritten during a
   later Step.
