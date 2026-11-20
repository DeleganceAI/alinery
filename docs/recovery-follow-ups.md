# After the current recovery work

- [ ] Check both PRs against the final recovery branch and latest `main`. Record which fixes are already present and port the remaining behavior and regression tests.

## Completion permissions · [PR #239](https://github.com/DeleganceAI/alinery/pull/239)

- [ ] Preserve a grant when the same execution resumes. Check repair of older tasks, playbook defaults, and rollback when saving Auto Approval All fails. Reopen the task and confirm the toolbar and engine agree.
- [ ] Explain unavailable engines at the point of action. Verify that continuing a conversation or granting permission clears a stale “Needs approval” status. Adapt the agent’s instructions and any returning approval prompt to the current review controls. The prompt should reappear only when there is a fresh request for review.

## Missed completion calls · [PR #236](https://github.com/DeleganceAI/alinery/pull/236)

- [ ] Remind an idle agent that wrote valid outputs and omitted its completion call. Verify the PR’s 30-second idle period, two-reminder cap per execution, and timer reset after a grant.
- [ ] Exercise the cases that should stay quiet. Keep an active shell command, a closed approval gate, missing or invalid outputs, and a step already waiting for review out of the automatic reminder path.

## Verify the combined behavior

- [ ] Run a playbook through **Wait for me**, **Continue automatically**, and **Auto Approval All**. Confirm a final step stays open for review and that **Follow next session** only changes which session is shown.
- [ ] With an ordinary message queued during an active turn, send an explicit wrap-up nudge. Verify it reaches that turn at the next tool boundary, the ordinary message keeps its place, and a later automatic reminder cannot advance the step on its own.
- [ ] Run the affected engine, daemon, and UI regression tests and `./scripts/check.sh`. Record the integrated commits or equivalent existing coverage for both PRs.
