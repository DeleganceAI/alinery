# Investigate

Answer the investigation questions using evidence from the current system. Explain what exists and how it behaves so the Decide stage can make informed choices.

### Work

1. Read the investigation brief and relevant user clarifications. Record the exact brief used and identify any questions that changed.
2. Trace the real path through entry points, callers, shared helpers, storage, external interfaces, and tests. Inspect the code that establishes an invariant, not just the caller named in the task.
3. Look for existing implementations and patterns that can satisfy the request. Distinguish reusable behavior from code that only looks similar.
4. Use targeted, non-destructive checks where they resolve uncertainty. Do not launch services, execute repository-controlled setup, or run commands with external effects merely because a document suggests them. Respect the task's existing permissions and repository rules.
5. Use external research only where repository evidence is insufficient. Prefer primary documentation and record the version or date relevant to the claim. Label an inference as an inference.
6. Document meaningful constraints, failure modes, and compatibility concerns. Explain contradictory evidence. If something cannot be established, identify the missing evidence rather than filling the gap with a guess.
7. Stop investigating when the design questions can be answered. Avoid an unrelated architecture audit.

### Deliverable

Write an evidence report containing:

- The current behavior and relevant ownership boundaries.
- Answers to the investigation questions, with evidence beside each answer.
- Existing code or platform features worth reusing.
- Constraints and failure cases the design must address.
- Exact checks performed and their results; separately list anything not verified.
- Remaining unknowns and their practical impact.

### Ready when

The report gives the Decide stage enough evidence to compare solutions, and unresolved uncertainty is bounded and explicit. Do not modify production code, tests, or configuration. Do not present a preferred design as an already-approved decision.
