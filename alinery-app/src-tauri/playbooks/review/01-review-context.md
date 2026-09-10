# Review Context

Read `{{TICKET_FILE}}`. Identify the PR, branch, or diff under review. List checkout, dependency, or
reproduction prerequisites.

If `{{REVIEW_HANDOFF_FILE}}` is non-empty and the file exists, read it immediately after the ticket.
Treat it as explicit cross-task review input/provenance for this phase. If `{{PROMPT_EXTRA}}` is
non-empty, incorporate those extra instructions.

Write `{{ARTIFACT_FILE}}` with the review target, current repo state, prerequisites, and open context gaps.
