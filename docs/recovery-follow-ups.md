# After the current recovery work

- [x] Compared the recovery worktree with the current heads of #236 (`b0c214e1`) and #239 (`e6a327f6`). The branch includes GitHub `main` at `8291bd15`. The permission fixes use the reviewed Continue flow, and idle reminders follow the effective automatic setting.

## Completion permissions · [PR #239](https://github.com/DeleganceAI/alinery/pull/239)

- [x] Preserve a grant when the same execution resumes. Require the replacement session to report readiness again. Cover repaired tasks, older playbook defaults, and failed Auto Approval All saves in regression tests.
- [x] Show the engine’s reason when a reviewed step cannot continue. Keep invalid output with the agent for correction and surface real tool approvals separately. A fresh report of readiness enables the existing review controls.
- [x] Restore **Continue** after the agent answers a follow-up on a previously submitted manual step. Exercise both a file-list question and a revision, including reopening the graph before the answer arrives.
- [ ] Desktop smoke test with the updated daemon. Send a question on a ready **Wait for me** step, then request an edit. Check that **Continue** returns after each answer and the next step waits for your click.

## Missed completion calls · [PR #236](https://github.com/DeleganceAI/alinery/pull/236)

- [x] Remind an agent on an automatic step after 30 seconds of continuous idle with valid outputs and a missing completion call. Allow at most two reminders per execution during the daemon run.
- [x] Skip **Wait for me**, an active turn, queued work, an outstanding approval, invalid outputs and a handoff already waiting for review.

## Verify the combined behavior

- [ ] Run a playbook through **Wait for me**, **Continue automatically**, and **Auto Approval All**. Confirm a final step stays open for review and that **Follow next session** only changes which session is shown.
- [ ] With an ordinary message queued during an active turn, send an explicit wrap-up nudge. Verify it reaches that turn at the next tool boundary, the ordinary message keeps its place, and a later automatic reminder cannot advance the step on its own.
- [x] Run the affected engine, daemon, and UI regression tests, `cargo check -p alinery-app`, and `./scripts/check.sh` on the combined changes.
- [ ] Record the integrated commits for both PRs once the desktop smoke test is complete.
