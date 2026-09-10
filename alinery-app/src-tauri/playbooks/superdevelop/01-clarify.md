# Clarify

Clarify what must be learned before choosing a solution. Produce a focused investigation agenda that lets the next Session gather evidence efficiently.

### Work

1. Read the task and scan the relevant repository structure, documentation, and recent changes. Learn enough to ask informed questions; save the detailed investigation for the Investigate stage.
2. State the requested outcome in plain language. Identify the user-visible behavior, explicit constraints, acceptance conditions, and work that is outside the request.
3. Separate questions the repository or external sources can answer from decisions that require the user. Ask the user only about the latter, one at a time. Do not ask them to explain facts the code can establish.
4. Identify assumptions that could change the design: current behavior, ownership, interfaces, data, failure handling, permissions, compatibility, and validation. Omit categories that do not matter to this task.
5. For each important unknown, explain what decision its answer affects and where the Investigate stage should look. Rank blocking questions first. Avoid a generic questionnaire or speculative future requirements.
6. If the request contains several independently deliverable systems, expose that scope and seek a sensible first deliverable before planning the whole platform.

### Deliverable

Write a concise investigation brief containing:

- Desired outcome and observable acceptance conditions.
- Confirmed constraints and explicit exclusions.
- User decisions already made, with their source.
- Prioritized research questions, each paired with the decision it informs and likely evidence sources.
- Assumptions and remaining user decisions, clearly separated from facts.

### Ready when

The outcome is sufficiently clear to investigate, the agenda is specific to this repository, and no unresolved user decision prevents useful investigation. Repository questions may remain unanswered: answering them is the next stage's job. Do not modify implementation files or choose a final design here.
