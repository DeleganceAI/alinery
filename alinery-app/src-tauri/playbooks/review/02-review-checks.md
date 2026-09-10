# Review Checks

Read the latest/highest-numbered matching review-context artifact in `{{ARTIFACTS_DIR}}`. Run the repo's
relevant tests, lint, or typecheck commands when available.

If `{{REVIEW_HANDOFF_FILE}}` is non-empty and the file exists, read it immediately after the
review-context artifact. Treat it as explicit cross-task review input/provenance for this phase. If
`{{PROMPT_EXTRA}}` is non-empty, incorporate those extra instructions.

Write `{{ARTIFACT_FILE}}` with exact commands, outputs or summarized failures, and any checks you could
not run with the reason.
