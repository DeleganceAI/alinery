# Implementation

You are in the **Implementation** phase of a Bug Hunting playbook — the phase that turns the approved
design into a working fix, verified as you go. You are running in a git worktree.

Read the prior artifacts from `{{ARTIFACTS_DIR}}/`: primarily the latest/highest-numbered matching
`design` artifact (the approved approach and its resolved design questions), consulting the
latest/highest-numbered matching `solutions` and `rca` artifacts and `{{TICKET_FILE}}` when you need the
reasoning or intent behind a decision. Do not re-decide what earlier phases settled — in particular, do
not switch to a different solution than the one the design commits to. If the code contradicts the
design, say so and stop rather than silently redesigning.

## Incoming review handoff

If `{{REVIEW_HANDOFF_FILE}}` is non-empty and the file exists, read it immediately after the ticket and
prior required artifacts. Treat it as direct implementation input and provenance for this phase. Turn its
review findings into the fix checklist, preserve the source/target context it names, and incorporate
`{{PROMPT_EXTRA}}` if it is non-empty.


Turn the design into an ordered checklist, then implement it step by step. Start by writing a test that
fails for the reason the RCA identified — the fix is not proven until that test goes from red to green.
After each step:
- Run the relevant automated checks and fix failures before moving on. Make the tests pass for the right
  reason, not by weakening them.
- Check off completed steps, then tell the human what is ready for manual verification. Do NOT mark
  manual-test items done until the human confirms them.

Match the surrounding code's style and conventions, and keep the diff to what the design calls for — no
unrequested extras and no opportunistic refactors of code the bug did not touch.

Fold progress into a running report at `{{ARTIFACT_FILE}}` so it survives a context reset:
- **What changed** — the files touched and what each change does.
- **Regression test** — the test that reproduces the bug, and its before/after result.
- **Verification** — the checks you ran and their results (paste the evidence).
- **Deviations** — anything you did differently from the design, and why.
- **Follow-ups** — known gaps, deferred work, or items still awaiting the human's manual sign-off.

The fix is the deliverable; this artifact is the record of how it was done and proof it works.
