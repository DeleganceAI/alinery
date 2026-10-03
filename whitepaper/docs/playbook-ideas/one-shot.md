---
schema: alinery.playbook/sketch-0

playbook:
  id: one-shot
  title: One-shot Implementation
  revision: 1
  status: potential
  description: >-
    Implement and verify one clear, bounded task directly, leaving an
    evidence-backed record of the completed work.

steps:
  - id: implementation
    title: Implement and Verify
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'Exists(["ticket.md"])'
    inputs: [ticket.md]
    outputs: [implementation-report.md]
    instructions: "#implementation"
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

If missing information or authority prevents safe completion and cannot be
resolved within the Step, call `step_fail` with the exact blocker. Otherwise,
call `step_complete` only when the requested change and all agent-executable
verification are complete. Accepted completion publishes the Step's single
successor state. Record any human-only manual checks that remain in the report.

The accepted implementation state may ground a separate PR-preparation
Playbook.

## Handoff and state conventions

The exact `ticket.md` occurrence binds the automatic execution. The isolated
workspace, code changes, test changes, and `implementation-report.md` remain
intermediate until accepted completion seals them together.

The Step should normally finish in one harness Session. If context limits or
an interruption require continuation, later Sessions remain part of the same
atomic Step execution and publish no intermediate state.

A deliberate manual rerun from a selected state creates another execution and
may publish a sibling successor. The engine records the exact parent state,
input binding, Sessions, and resulting artifact occurrence.

## Status and adaptation points

This is a candidate default One-shot Playbook. It deliberately concentrates
implementation and verification in one Step. If the task regularly needs a
separate design decision, test contract, or review phase, use or adapt a
multi-Step Playbook such as PRIMED instead.
