# Review Response

Read all review artifacts in `{{ARTIFACTS_DIR}}`, using the latest/highest-numbered matching artifact
when a review step has been run more than once. Write a final paste-ready review summary.

If `{{REVIEW_HANDOFF_FILE}}` is non-empty and the file exists, read it with the review artifacts. Treat
it as explicit cross-task review input/provenance for this phase. If `{{PROMPT_EXTRA}}` is non-empty,
incorporate those extra instructions.

The approval/request-changes action is harness-owned: if the decision is to approve or comment on the PR,
use your GitHub capability to submit the PR review/comment and record the evidence here. Alinery does not
submit a local app-level GitHub approval.

Write `{{ARTIFACT_FILE}}` with:
- **Decision**: approve, request changes, or comment-only
- **Summary**
- **Findings**
- **Verification evidence**
- **Requested changes or approval rationale**
- **GitHub review/comment evidence** when you actually submitted one
