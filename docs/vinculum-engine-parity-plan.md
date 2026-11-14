# Vinculum engine parity with the task record

Status: implemented. This is a working note, not a product contract. `README.md` is human-edited and is not the place for it.

The TypeScript engine in `playbook-engine/` is a clean-room scheduler for the playbook rules. It is the runner. It was not given the product record the create-task screen writes, and Vinculum only recently connected the model. The goal of this work is parity with that record: the same gate, cap, start choice, prompt tokens, and model fallback the old launcher used. It is not a second scheduler and it is not a rewrite of `schedule.ts`.

The model chain already shipped in `2bc8ebb7`: a per-step override, then the playbook model, then the task default. Leave that order. Extend it. Do not put the fallback back.

## One record

Rust create still writes both files. `task.md` is the durable task. `execution.json` is the live execution record the old launcher read. `engine.jsonl` is the new run log. Do not add a third file, and do not teach the board to read `engine.jsonl`.

`graph.ts` already refuses a task whose `execution.json` is missing or not `creation = "ready"`. The same read is where the rest of the record comes from. Read it again when a decision can change while the daemon is up. Cache nothing that the task screen can still edit.

| Field | Where it lives | When the old launcher read it |
|---|---|---|
| `enabled_steps` | `execution.json` | Once, when the execution was reserved. Not edited after create. |
| `auto_approve_all` | `execution.json`, also mirrored on `task.md` | Every completion. Turning it off does not rewrite `enabled_steps`. |
| `max_live_sessions` | `execution.json` | Every time a queued execution was claimed. `0` is invalid. |
| `initial_start_requested` | `execution.json` | The create request. There is no later editor. |
| `launch_defaults.model`, `step_models` | both files | Every launch. Already read from `task.md`. Keep that, and treat `execution.json` as the same values. |
| `defaults.model` | app config, `HarnessChoice` | Last model, after the task, via `omp_default_model`. |
| `prompt_extra`, `handoff_artifact` | the session meta created for a review handoff | When that session's prompt was built. |

`playbook.md` `auto_advance_default` is only the seed for `enabled_steps` at create. After the task exists, the set on `execution.json` wins, including when it is empty.

## Gate

`Engine.#permitted` in `playbook-engine/src/engine.ts` is `autoAdvance[step] ?? playbook default`, then a human `permit`. Vinculum never passes `autoAdvance`, so every step follows the playbook file. Unchecking a step on the create screen, or turning approve-all on later, does nothing.

Change the lookup, not the scheduler:

- The host passes the task set. A step in `enabled_steps` may complete on its own. A step absent from that set is locked, even when `auto_advance_default` is true. Tests that construct an engine with no task set keep today's playbook default.
- `auto_approve_all` is read from `execution.json` inside the completion check, not at process start. True lets a locked execution complete. False leaves the reserved gate as it was. It does not rewrite `enabled_steps`.
- A human grant (`permit`, already wired through `allow_execution_completion`) still wins for that execution. A resume clears it, which the engine already does.

Do not apply a later edit of `enabled_steps` to an execution that was already reserved. Nothing in the app writes that set after create. Snapshot it when the execution is reserved (the reserved event, or a `permitted` event for steps that were in the set at that moment) so a future editor cannot move the gate under a live session.

## Cap

`maxLiveSessions` exists and defaults to 10. `graph.ts` does not pass it, so a task created with 3 slots still runs 10.

Read `max_live_sessions` from `execution.json` when deciding to launch. Refuse `0`. The number on the task detail ("N active / M slots") is this field. After the change, M is the cap the runner enforces, not a label.

Coding exclusivity stays as it is. The engine already holds the worktree for a coding step until that execution exits.

## Start later

`createTask` calls `runTask` only when the request says start. The 2 second tick then calls `discover` and ticks every ready task. `holdTask` is never called. "Create without starting" starts on the next tick.

Hold a task until it has been started, then leave it running across restarts:

- `initial_start_requested` true: tick immediately, as today.
- False, and `engine.jsonl` has no `started` or `resumed` event: hold. `runTask` and `startSession` are the only release. Both already call `runTask`, which clears the hold.
- False, but the log already has a start: the user started it earlier. Tick. Do not hold again after a daemon restart.

Do not pre-launch the playbook from `materializeSessions`. That helper writes a session file per step with an empty model so the board has rows before the engine runs. Those files are not the engine's sessions. Leave the helper for this slice only if the board breaks without it. The engine remains the only thing that opens a playbook session.

## Prompt tokens

`#render` already substitutes `PROMPT_EXTRA`, `REVIEW_HANDOFF_FILE`, and `SESSION_HISTORY_DIR`. The host passes empty strings, so the model sees a blank path.

- `SESSION_HISTORY_DIR` is the task's `sessions/` directory. It does not change per step. Pass it on every engine.
- `PROMPT_EXTRA` and `REVIEW_HANDOFF_FILE` belong to the review-handoff session the old launcher built the prompt from (`SessionMeta.prompt_extra` and `handoff_artifact`). The engine mints its own session id inside `harness.start`, so it never sees that meta.

Wire them at render time, per step. Before rendering, if this task has a not-yet-started session whose `phase` is the step being launched and whose meta carries a handoff or an extra, pass those strings for that launch only. Resolve `handoff_artifact` to the artifact file under the task, the same way `substitute_prompt_tokens` does. Do not copy the extra into later steps. A launch with neither field stays empty, not the previous step's text.

`TICKET_FILE`, `TASK_NAME`, `TASK_SLUG`, and `WORKTREE` stay as they are.

## Settings model

`executionModel` stops at the task default. A blank after that still falls through `resolveModel` to Alinery `DeepSeek-V4.1-Flash`.

The old last step was `omp_default_model`: Settings `defaults.model`, kept when `defaults.harness` is empty or an allowed launch harness, dropped when it is a leftover harness key. Read it from the app config the same way `readLaunchThinking` reads `defaults.thinking`. Order becomes: step override, playbook model, task default, settings model, and only then the hosted fallback. Do not skip the hosted fallback when settings are blank. That path is what a chat with no model already uses.

## A session that dies

Two engine methods exist and the daemon never calls them.

- `resume(execId)` continues a failed execution on an explicit human action. It is not automatic. The engine already reapplies the cap and the coding lock, and it clears the previous grant.
- `confirmExited(execId)` records an exit the harness could not confirm. The old record did this when the process had ended and the runner had not seen it.

Wire them without a new screen:

- Starting a session whose execution is already `failed` calls `engine.resume` for that execution. It does not open a second session beside it and it does not tick the failure into a new reservation.
- On startup, an execution still `finishing` or `live` whose session meta has `ended_at` calls `confirmExited` before the first tick. A missing meta stays `unknown`, which the engine already turns into `failed`. Do not guess that an unknown session exited.

The harness status callback in `main.ts` never returns `failed`. An agent error that leaves the process alive stays `idle` and holds a slot. Return `failed` with a fixed reason when the live row has a failure the engine did not ask for (launch threw, or the playbook state is already `failed`). Do not treat idle, waiting for input, or waiting for approval as failure. Those are the human gates.

`stop` may still abort and then resolve. The engine treats that resolution as the exit. Do not also wait for a second status poll. The gap is the case where the process is already gone and `stop` is never reached.

## What this slice does not do

- No change to `schedule.ts`, fan-out, fan-in, or ambiguity.
- No second task store. Subtask creation stays the Rust call in `tasks.ts`. A child task, once created, is subject to this same record.
- Resume uses `start_session`. No new socket op. `PROTOCOL_VERSION` is 23 because session meta now records the harness as `vinculum`, and the app must not talk to a daemon that still records `omp`.
- Session meta records the Vinculum agent as `vinculum`. `omp` remains the harness-registry key. A file that still says `omp` is rewritten when the daemon starts, and readers accept both until that rewrite.
- Do not launch the app to verify. `cargo check -p alinery-app` is not required for a TypeScript-only change. `bun test` for the new host tests and `bun build src/main.ts --target bun` are.

## Tests

- Gate: a step absent from `enabled_steps` rejects completion even when the playbook default is true. `auto_approve_all` accepts it, and turning that flag off rejects the next attempt without a grant. A step in the set completes with no grant. A grant still completes a locked step.
- Cap: `max_live_sessions` of 1 does not launch a second execution while the first is live.
- Start: a ready task with `initial_start_requested` false and an empty log does not launch on tick. `runTask` launches it. A log that already contains `started` launches on tick after a fresh `Engine.open`.
- Tokens: a handoff meta for that step puts its path and extra in that launch's prompt only. `SESSION_HISTORY_DIR` is the task sessions directory. Another step's prompt does not contain them.
- Model: blank playbook and blank task default uses the settings model. A leftover harness key in settings does not. Blank settings still reaches the hosted fallback.
- Failure: a status of `failed` marks the execution failed and frees the slot. `resume` on that execution launches one session. A meta with `ended_at` on a still-live execution confirms the exit and does not call `resume`.
