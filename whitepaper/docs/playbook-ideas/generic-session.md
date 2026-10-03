---
schema: alinery.playbook/sketch-0

playbook:
  id: generic-session
  title: Generic Session
  revision: 1
  status: potential
  description: >-
    Carry out one user-described request in a single atomic Step and preserve
    the result, evidence, and workspace changes in one inspectable task state.

steps:
  - id: complete-the-request
    title: Complete the Request
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'Exists(["ticket.md"])'
    inputs: [ticket.md]
    outputs: [result.md]
    instructions: "#complete-the-request"
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

Call `step_complete` only when the requested work is complete and `result.md`
truthfully describes the resulting state. If the request cannot be completed
reliably, call `step_fail` with the concrete blocker.

## Handoff and state conventions

A successful execution publishes one successor task state containing
`result.md` and all workspace changes together. `result.md` is the primary
handoff; it is not the whole result.

The exact `ticket.md` occurrence binds the automatic execution. A deliberate
manual rerun from a selected state may create another branch with a different
successor.

The atomic Step should normally require one harness Session, but continuation
in another Session remains possible. Session exit alone does not complete the
Step; only accepted `step_complete` publishes its state.

## Status and adaptation points

This is a candidate default Generic Session Playbook. Teams can specialize its
instructions, model, verification requirements, output structure, or final
approval policy. Work that benefits from distinct phases, fan-out, or merge
should become a multi-Step Playbook.
