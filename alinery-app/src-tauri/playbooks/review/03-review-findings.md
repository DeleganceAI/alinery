# Review Findings

Read the latest/highest-numbered matching review-context and review-checks artifacts in
`{{ARTIFACTS_DIR}}`. Inspect the diff for correctness, security, regression, and maintainability issues.

If `{{REVIEW_HANDOFF_FILE}}` is non-empty and the file exists, read it immediately after the
review-context/checks artifacts. Treat it as explicit cross-task review input/provenance for this phase.
If `{{PROMPT_EXTRA}}` is non-empty, incorporate those extra instructions.

Write `{{ARTIFACT_FILE}}` with severity-rated findings, each with file/line evidence, expected behavior,
observed risk, and suggested fix. If no blocking findings exist, say so with evidence.
