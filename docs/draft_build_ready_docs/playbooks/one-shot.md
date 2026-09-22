---
schema: alinery.playbook/v1
playbook:
  id: one-shot
  description: Implement and verify one clear, bounded task directly, leaving an evidence-backed
    record of the completed work.
  budget_defaults:
    max_step_executions: 5
    max_wall_clock_seconds: 1500
steps:
- id: implementation
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - ticket.md
  outputs:
  - implementation-report.md
---

# One-shot Implementation

Use this single-Step Playbook for a clear, bounded task that should be
implemented directly without separate research, design, or planning Steps.
“One-shot” means one atomic Step, not necessarily one harness Session; the Step
may continue across Sessions when context limits require it.

## Process

```text
ticket.md
  -> Implement and Verify -> implementation-report.md
```

<a id="implementation"></a>
## Implement and Verify

Read the exact bound `ticket.md`, then inspect the complete input state,
including repository guidance, source, tests, attachments, relevant artifacts,
and engine-supplied supplemental instructions.

Implement the request directly. Do not stop after proposing a design or plan
when the ticket asks for a working change. Understand the affected code paths
before editing, preserve unrelated work, follow established project
conventions, and keep the change limited to what the request requires.

Run the repository-prescribed checks and the smallest targeted checks that
exercise the changed behavior. Fix failures caused by the change without
weakening valid tests. Never claim that a command or manual check ran when it
did not.

Write `implementation-report.md` containing:

1. **What changed:** the delivered behavior and important files changed.
2. **Verification:** every command actually run, its result, and any relevant
   environment limitation.
3. **Follow-ups:** residual risks, required manual checks, or genuinely
   deferred work.

If missing information or authority prevents completion, explain the exact
blocker to the user and follow the engine-provided lifecycle instructions; do
not claim successful completion. Otherwise, finalize the repository changes as
directed by the engine context and request `complete` when the requested change
and agent-executable verification are complete. Record human-only manual checks
that remain in the report.

Keep the accepted implementation result available for separately authorized
PR preparation; this Step does not publish a PR merely by completing.

## Handoff and State conventions

The exact engine-assigned `ticket.md` binds the work. Code, tests and
`implementation-report.md` remain intermediate until accepted completion
captures the actual result material. That result may reuse an existing State;
its report is an advisory output declaration, not an engine-enforced quality
check. Follow the engine context for source views, workspace and completion.

The Execution may use sequential Sessions. Explicit Continue, when offered,
retains the unfinished Execution and workspace. Recovery without a live Session
instead marks unfinished work Interrupted; explicit Retry creates a new
Execution with the original source assignment and fresh starting material.
Session exit does not itself complete the Execution. Users may still return to
previous Sessions after accepted completion.

## Draft status

This converted v1 definition awaits production-engine validation. The
frontmatter budgets are initial suggestions that users may adjust. If a task
needs separate design, test or
review dependencies, use a multi-Step Playbook such as PRIMED.
