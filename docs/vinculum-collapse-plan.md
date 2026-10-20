# Vinculum collapse plan

Status: not started past the five task operations. Written 2026-10-20 from the working plan on `experimental-pi-durable-as-a-harness`, plus the holes found when that plan was checked against the tree.

This is a working note, not a product contract. `README.md` is human-edited and is not the place for it.

## Goal

One process, `alinery-vinculum-daemon`, loads a task, ticks the TypeScript playbook engine, and runs Pi sessions itself. A remote machine needs the repo, model credentials, and that process. It does not need the Tauri app or `alinery-playbook`.

Published names are Vinculum, not pi or pi-durable, unless the code requires the pi name or an internal note that the agent runtime is pi-durable.

The UI socket stays newline-JSON on `.alinery/alineryd.sock`. Remote attach later is a transport over that socket. An SSH forward is enough. Do not add a second protocol.

## Where the branch is

Branch: `experimental-pi-durable-as-a-harness`. It is two commits ahead of `origin`, and those two have not been confirmed pushed.

PR 138 (`claude/playbook-engine-node-ts-e27dff`) was rebased onto this branch from parent `265f2461` and merged. The merge only added `playbook-engine/`. Do not retarget this work at `main`. CodeQL's five high alerts are test-only `*` path replacements. The branch is unprotected, so they did not block the merge.

Local commits:

- `fb8ae2e9` names the experimental daemon Vinculum.
- `e2eb7f6c` runs playbook graphs inside Vinculum.

Uncommitted, on top of `e2eb7f6c`:

- `alinery-app/src-tauri/vinculum-daemon/src/tasks.ts` (new)
- `alinery-app/src-tauri/vinculum-daemon/src/graph.ts`
- `alinery-app/src-tauri/vinculum-daemon/src/main.ts`

Those three files are the five task operations. `bun build --target bun` bundled them. They are not committed.

`playbook-engine/` is a clean-room Node 22 TypeScript engine for v2 `playbook.md` (`+++` frontmatter, `<!-- alinery:step KEY -->`, inputs `single` / `each` / `complete`). One runtime dependency, `smol-toml`. No build step. Bun imports the `.ts` directly. `Harness` is in-process: `start`, `resume`, `status`, `send`, `stop`, `requestCompletion`, `permit`, `tick`. The engine never sees processes, sockets, or Pi. One JSONL log per task, `.alinery/tasks/<slug>/engine.jsonl`, replayed on startup. No migration from Rust execution files. Only new runs use this engine. It is a second implementation of rules `alinery-core` already runs. Tests do not check parity. Scheduler caching is claimed not to change results. The same tests are the evidence.

## Already done

Rename (`fb8ae2e9`):

- Binary `alinery-vinculum-daemon`.
- Package directory `alinery-app/src-tauri/vinculum-daemon/` (moved from `pi-daemon`).
- Log lines and build id say Vinculum.
- Settings key `experiments.vinculum`. Old `pi_durable = true` still loads (`vinculum_opt_in_still_loads_the_old_key`). Nothing reads that flag to choose a daemon.
- Left unchanged on purpose: `@earendil-works/pi-durable` and `@earendil-works/pi-ai`, one comment that Vinculum's agent runtime is pi-durable, harness key `omp` (the UI already shows it as Vinculum), socket `.alinery/alineryd.sock`, Rust module `pi_durable`, launcher `piDaemonCompile`, session files `*.pi.sqlite`.
- Two settings tests still mention a "PI durable" checkbox. The Settings screen does not render one. The experimental test expects it absent. The general test still expects it as the fifth checkbox. Both were left alone.

Embed (`e2eb7f6c`):

- Parser and `inspectOutputs` accept `required`, so `spec/playbook.md` loads. Completion rejects until that exact file exists.
- Prompts use the same tokens as Rust, including `{{TASK_NAME}}` and `{{WORKTREE}}`.
- Every two seconds the daemon opens one `Engine` per task with `playbook.md`, replays the JSONL, and ticks. Tick launches the session in-process.
- Phase completion and the permission grant go to that engine when it started the session.
- The session list prefers engine playbook state and still asks the helper for anything else.
- The helper no longer reconciles the graph and no longer opens a playbook session. A root chat still does.

Verified for those commits: `npm test` and `npm run typecheck` in `playbook-engine` (16 tests), `cargo check -p alinery-app`, `cargo test -p alinery-core vinculum_opt_in_still_loads_the_old_key`, `cargo test -p alineryd --test playbook_helper`, `bun build --target bun`, and the two shell guards `scripts/tests/dev_fetch_bun_test.sh` and `scripts/tests/check-experimental-daemon-names.sh`. `./scripts/check.sh` was not run.

## Five task operations, uncommitted

These no longer go to the helper socket:

- `create_task` writes the task directory, playbook, ticket, and `execution.json`, then tries `git worktree add`. If start was requested, the engine ticks before the reply. This is not the Rust saga below.
- `get_task_execution` reads that record and overlays engine executions. The ownership check uses the same projection. Replies must include `worktree` and `created` or the app cannot decode them.
- `create_execution_session` and `start_session` open a session the engine already reserved, or open a chat. They do not reserve a binding the scheduler refused.
- `create_subtask` returns a clear unsupported error so it does not keep the helper alive.

The helper still answers `phase_request`, `playbook_axis`, and `allow_execution_completion` for sessions the engine did not start. The app still spawns `alinery-playbook` from `alinery-app/src-tauri/src/pi_durable.rs`, with `ALINERY_PI_LAUNCH_TOKEN` and a supervisor restart-helper branch. `alinery-core/src/playbook_client.rs` is the socket client.

## Bundling today

`npm run tauri dev` runs `alinery-app/scripts/tauri.mjs` before Cargo. For `dev` and `build`, `scripts/dev-fetch-bun.sh --no-download` then `bun build --compile` writes `target/debug/alinery-vinculum-daemon` (about 73 MB; it bundles the daemon, pi-durable, and the playbook engine). The machine that runs it does not need Bun. If Bun is missing, launch prints a line and continues. The app fails later looking for the binary.

`alineryd` is a Rust `externalBin` with `alinery-mcp` and `alinery-runner` in `alinery-app/src-tauri/tauri.conf.json`. `alinery-app/src-tauri/scripts/copy-sidecar.sh` copies the triple-suffixed binaries. A missing sidecar fails the build.

Vinculum is deliberately not an `externalBin`. The release resolver starts any sibling `alineryd` or `alineryd-*`. `scripts/tests/check-experimental-daemon-names.sh` refuses to let that resolver learn the name `alinery-vinculum-daemon`. The experimental app finds the exact filename next to `Alinery`. This branch still builds the old sidecars on every `tauri dev` even though it does not launch release `alineryd`.

`alinery-playbook` is another bin from the `alineryd` crate, looked up beside the app, not a sidecar. The five operations just stopped calling it. The process `alineryd` is already not launched on this branch. What forces the compile is `externalBin` plus `copy-sidecar.sh`.

## Original sequence

Do this in order. None of it has been started except the uncommitted five operations.

1. Commit the five task operations if they are still uncommitted.
2. Replace the thin Vinculum create with the full Rust provisioning saga before deleting either binary. In that same cut, drop the helper fallbacks `phase_request`, `playbook_axis`, and `allow_execution_completion`. New tasks will not have a Rust execution to fall back to.
3. Delete `alineryd/src/playbook_helper.rs`, the `alinery-playbook` spawn in `pi_durable.rs`, the helper socket, `ALINERY_PI_LAUNCH_TOKEN`, the supervisor restart-helper branch, and `playbook_client.rs`. The supervisor watches only Vinculum.
4. Stop compiling `alineryd` and `alinery-playbook`. Remove them from `externalBin` and `copy-sidecar.sh`, then delete the bins.
5. Make Vinculum the product sidecar. `externalBin` becomes `alinery-vinculum-daemon` instead of `alineryd`. `bun build --compile` must emit the triple-suffixed file Tauri bundles, not only `target/debug/alinery-vinculum-daemon`. The release resolver must spawn that name and stop spawning `alineryd`. Update the name-guard check that currently forbids the resolver from learning `alinery-vinculum-daemon`.
6. Prove it standalone. Start the daemon with `--repo` on a checkout, create one task, and let ticks carry the academic-survey graph through a fan-out and a fan-in. No helper socket. No Tauri process.

Previously treated as out of scope, and now required before deletion: draft promotion, branch-namespace checks, related-task links, attachments beyond a seeded ticket, and subtasks.

Still out of scope: replaying old Rust execution state, porting the Rust scheduler, and the playbook library editor. The app keeps speaking the UI socket.

## Provisioning saga that step 2 has to match

The Rust source is `provision_task_with_reservation` in `alinery-app/src-tauri/alinery-core/src/task_creation.rs` and `create_subtask` in `alinery-app/src-tauri/alinery-core/src/subtask.rs`. A failed saga keeps the task it already reserved. The current TypeScript create does not. Reservation happens first, then Git.

- Validate playbook, name, slug, worktree leaf, and branch. The branch must pass `check-ref-format`, must not collide with a local head or another task's reserved branch, and must not sit under an existing parent branch. A child whose slug, worktree, or branch is already taken is rejected with no suffix.
- `draft_slug` renames that draft directory onto the final slug. A missing, archived, or already-created draft is an error and creates nothing.
- Write `task.md`, `playbook.md`, and `execution.json` with `creation = "provisioning"`. If the relationship hook fails, stop with `creation = "partial"`, stage `relationships`, and keep the reservation.
- `git worktree add -b <branch> <path> [base_ref]`. On failure do not delete the task or the worktree path. Persist `creation = "partial"` and `creation_error` at stage `git_worktree`. If that write fails, add `ambiguous_commit`.
- Install inputs only after the worktree exists. Attachments are capped at 25 MiB each and 100 MiB together. Name collisions are stored as `name-2`. A rejected file is `import_failed`, not a failed task. The ticket is `original_ticket`, or `compose_ticket` from description, evidence, URLs, and attachment results. Then `sync_related_artifact_links`, seed `ticket.md` to `00-ticket.md`, and set `creation = "ready"`.
- `create_subtask` is the same saga plus locks. The manager session must belong to this lane and app config. The parent must be `ready`. Retained playbook bytes must match `definition_identity`. The child branch starts at the parent worktree HEAD. Slug, branch, and worktree are the requested slug with no uniquifying. After reserve, the parent `active_subtask` and the manager session's `subtask_slug` are set, and the parent is checked again under the lock so a concurrent change aborts.

Current Vinculum create skips branch and parent checks, does not promote drafts, writes a stub ticket, ignores related-task links, and refuses subtasks. A worktree failure may already report `partial`, but reservation and later stages are not this saga.

Rust saga tests in `task_creation.rs` stay until the TypeScript path covers the same reservation, partial, draft, and subtask cases.

## Holes the original sequence does not close

The sequence covers the playbook helper and the saga, then deletes `alineryd` as if it were already unused. It is not. These have to be decided before either binary is removed.

### PTY, Terminal, and OMP are still product behavior

Vinculum already answers `write`, `resize`, and `send_message` with `unsupported`. It has no `restate`, `rpc_attach`, `rpc_write`, or `omp_setup`. The UI still has the xterm pane (`alinery-app/src/SessionTerminal.tsx`), the Terminal drawer (`no-harness`), OMP setup, and the non-Vinculum branch of the session view. MCP still creates and starts sessions through the daemon socket (`alinery-app/src-tauri/mcp/src/main.rs`). `alinery-runner` exists so `alineryd` can take runner events.

Noting that deletion "drops PTY and OMP" is not a decision. Before the binary goes, either those paths move into Vinculum, or the plan cuts them on purpose: UI, commands, MCP, the runner sidecar, idle inhibit, scrollback reattach, the OMP host guard, and the tests that spawn a real `alineryd`.

### Repo ownership is a Rust library the bundle plan never ships

Vinculum takes the lane lock by loading `ALINERY_OWNERSHIP_LIB` (`libalinery_core.dylib` or `.so`) through `dlopen` in `vinculum-daemon/src/main.ts`. `pi_durable.rs` places that library next to the app. It is not an `externalBin`. Bundling the daemon does not bundle the library, and deleting the `alineryd` crate does not remove `alinery-core`. The plan has to say the dylib ships, or the lock moves into the Bun binary.

### A TypeScript saga can still call the wrong git

Rust provisioning goes through `alinery_core::git_cmd`: a real git, or the alongside tree with `GIT_EXEC_PATH`, never the macOS `/usr/bin/git` stub. The sequence lists `git worktree add` and not that rule. Shelling out to `git` on `PATH` is a different implementation.

### Removal is bigger than `externalBin` and `copy-sidecar.sh`

`alineryd` is a workspace member (`alinery-app/src-tauri/Cargo.toml`). `scripts/check.sh` copies the sidecar and then runs workspace tests, including `alineryd/tests/` that spawn the binary. Shell gates assume it (`check-no-auto-session-kill.sh`, the protocol gates, the name guard). MCP can connect to a lane socket and start a daemon. Takeover, backup restore, and quit send `shutdown` and expect the lane lock. Vinculum's `shutdown` exits the process. It does not hold `.alineryd.lock`. The sequence updates the name guard and the sidecar copy, and stops there.

### Two smaller pieces belong in the same cut

Attachment bytes arrive as the `create_task` socket body (`body_bytes`). Only the helper reads that body today. The saga port has to keep that wire.

`pi_open` still checks `ALINERY_PI_LAUNCH_TOKEN`. Deleting the helper should say whether that token stays for the app or dies with the helper.

## What stays a limit, not a missing step

The academic-survey run is the proof. Nothing in the sequence checks the TypeScript engine against the Rust execution suite before the Rust scheduler is gone. That is a limit of this plan unless parity is required first.
