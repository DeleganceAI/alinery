# Prepare Review

Prepare the completed change for a human reviewer. Make its purpose, behavior, and verification easy to assess.

### Work

1. Read the task, approved decisions, plan, test contract, and Build artifact. Inspect the complete change against the task's base branch and identify any unrelated work.
2. Check the implementation against the accepted requirements. Review correctness, failure handling, security boundaries, and maintainability. Fix issues only within the authorized scope, and rerun affected checks after changes.
3. Run the relevant verification commands against the current files. Record commands, outcomes, and remaining failures honestly. Earlier passing results do not establish that the current change passes.
4. Distinguish your own review from an independent review. Include independent findings only when an actual reviewer provided them, with their source and resolution. Never invent a review or approval.
5. Prepare a concise PR title and body explaining the problem, changed behavior, verification, and material limitations. Flag unresolved issues and decisions that still require the user.
6. Prepare the handoff without opening a PR, pushing, merging, rewriting history, removing the worktree, or stopping sessions unless the user has explicitly authorized that action.

### Deliverable

Write the review package to `{{ARTIFACT_FILE}}`, including:

- Proposed PR title and description.
- Requirements met and any known gaps.
- Current verification commands and results.
- Self-review findings and any actual independent review evidence.
- Remaining user decisions and the next concrete action.

### Ready when

The change has been inspected, verification is recorded accurately, and the review package is ready for the user. If a required check fails or the implementation is incomplete, report the blocker and leave this stage unfinished. Preparing a review is not approval to publish or merge.
