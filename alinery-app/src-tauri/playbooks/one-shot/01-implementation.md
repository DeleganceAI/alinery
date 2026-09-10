# One-shot Implementation

Read the task ticket at `{{TICKET_FILE}}` and any existing artifacts in `{{ARTIFACTS_DIR}}`. Implement
the request directly in `{{WORKTREE}}`. Run targeted checks that cover the change.

If `{{REVIEW_HANDOFF_FILE}}` is non-empty and the file exists, read it immediately after the ticket and
existing artifacts. Treat it as direct implementation input and provenance for this one-shot session. If
`{{PROMPT_EXTRA}}` is non-empty, incorporate those extra instructions.

Write `{{ARTIFACT_FILE}}` with:
- **What changed**
- **Verification**: exact commands run and results
- **Follow-ups**
