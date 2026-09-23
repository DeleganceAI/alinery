---
schema: alinery.playbook/v1
playbook:
  id: generic-session
  description: Carry out one user-described request in a single atomic Step and preserve the
    result, evidence, and workspace changes in one inspectable task state.
  budget_defaults:
    max_step_executions: 5
    max_wall_clock_seconds: 1500
steps:
- id: complete-the-request
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - ticket.md
  outputs:
  - result.md
---

# Generic Session

This is a single-Step Playbook for a user-described task. The bound
`ticket.md` defines the requested outcome, while the Step supplies a consistent
completion and handoff contract.

## Process

```text
ticket.md
  -> Complete the Request -> result.md
```

<a id="complete-the-request"></a>
## Complete the Request

Read the exact bound `ticket.md`. Inspect the complete input state, including
attachments, repository files, and earlier artifacts, when they are relevant
to the request.

Carry out the request directly. The ticket may ask for research, analysis,
writing, editing, implementation, investigation, or another kind of work.
Follow repository instructions, preserve unrelated work, and stay within the
authority granted by the request. Ask the human when a missing decision or
authorization would materially change the result.

Use verification appropriate to the work. When commands, checks, or external
sources matter, record the exact evidence supporting the result. Do not claim
an action, change, or successful check that was not completed.

Write `result.md` containing:

1. The requested outcome as understood.
2. The result and work performed.
3. Evidence and verification, including exact commands and results when
   applicable.
4. Material assumptions or decisions.
5. Remaining limitations, blockers, or follow-ups.

When the requested work and verification are complete, finalize repository
changes as directed by the engine context and request `complete`. Describe the
actual result truthfully in `result.md`. If blocked, explain the concrete
blocker to the user and follow the engine-provided lifecycle instructions; do
not claim successful completion.

## Handoff and State conventions

Accepted completion captures the actual repository and artifact material as
one result State, which may reuse an existing State. `result.md` is the primary
handoff, not the whole result; the declared output is advisory to the engine.
The engine supplies the exact assignment, workspace and completion interface.
Follow that context rather than inventing a publication list or runtime API.

Continue, when offered, retains the unfinished Execution. Explicit Retry uses
a new Execution with the original sources and binding. Session exit alone does
not complete the Execution. Previous Sessions remain accessible after accepted
completion without reopening it or changing the captured State.

## Draft status

This converted v1 definition awaits production-engine validation. The
frontmatter budgets are initial suggestions that users may adjust. Specialize
the instructions, model or
verification for the request. Work needing distinct dependencies or parallel
applications can use a multi-Step Playbook.
