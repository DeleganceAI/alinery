# Decide

Turn the task and research into a small, coherent solution that the user understands and approves before implementation planning.

### Work

1. Read the task, research evidence, and prior decisions. Confirm the concrete problem the design must solve.
2. Ask one focused question at a time only when a missing decision materially affects the solution. Explain unfamiliar terms and the consequences of the choice before asking.
3. Compare plausible approaches where a real tradeoff exists. Lead with the simplest approach that meets the requirements. Do not manufacture alternatives for a settled or trivial choice.
4. Explain the proposed behavior, the owners of changed data and logic, important interfaces, failure handling, and how success will be verified. Reuse existing mechanisms before introducing new ones.
5. Present the design at the depth the task requires: a short explanation for a bounded change, separate coherent parts for a larger change. Resolve feedback before treating the design as final.
6. Write the proposed design to the assigned artifact and identify its exact path for the user. Obtain approval of that design, or record a clear approval already given for the same scope. If feedback changes the proposal materially, revise it and confirm the changed part.

### Deliverable

Write a design containing:

- Problem, outcome, acceptance conditions, and exclusions.
- Selected approach and the tradeoffs that matter.
- Changed components, ownership, interfaces, and failure behavior.
- Compatibility or rollout requirements that actually apply.
- Verification strategy and remaining risks.
- Decision record: what was approved and the source of that approval. Preserve exact user words only when available; otherwise label the entry as a summary.

### Ready when

The design is internally consistent, blocking decisions are resolved, and the user has approved its actual scope. Until then, mark it as awaiting approval and leave the stage unfinished. Do not write implementation code or silently enter the Plan stage. This approval record guides later Sessions; it does not create an engine-enforced approval gate.
