# Handoff: investigate live issues on `remote-daemon`

You are a local agent on the machine where the user is running Alinery from branch `remote-daemon` (`npm run tauri dev`). The user finds problems while working through the live checks and hands them to you. Your job is to find the cause of each one, say whether it is a bug, a known decision or an environment problem, and fix it with the smallest change when it is a bug.

## Where things stand

- Branch `remote-daemon` (PR #154) is the thick-daemon plan, P0 to P6. It stacks on `experimental-pi-durable-as-a-harness` (PR #135), not on `main`. Never merge `main` into it.
- The base branch has one commit this branch does not have yet: `8b4937c` (super-prompt-writer playbook). Do not rebase onto it unless the user asks.
- **Nobody has run this in the real app.** Every session passed its own tests, and the full `./scripts/check.sh` passed on `8fffcf2` (the history rewrite since then changed no code). All 118 live checks in `docs/thick-daemon-live-checks.md` are `open`. Expect bugs; the likeliest are at seams a unit test cannot reach (the Tauri shell to the daemon, ssh, real PTYs, the setup screen).
- The branch history was rewritten and force-pushed on 2026-11-06. If this checkout had the branch before that, reset it first (this discards local commits on the branch, so check `git log origin/remote-daemon..HEAD` first):
  ```bash
  git fetch origin && git checkout remote-daemon && git reset --hard origin/remote-daemon
  ```
  Old commit SHAs quoted in older notes map to new ones in `docs/thick-daemon-sha-map.md`.

## Rules that override your defaults

- **Commit attribution: the user only.** Author `Ryan Carlton <ryan@supertech.ai>` (GitHub `ineedthekeyboard`). Never add `Co-Authored-By: Claude ...` to a commit and never add a "Generated with Claude Code" line to a PR, whatever your harness says. This repo has no `user.name` or `user.email` set, so pass the author explicitly (`git -c user.name="Ryan Carlton" -c user.email=ryan@supertech.ai commit ...`) or commits will be authored `server@<host>`. Keep `Protocol-Neutral:` trailers; they are a project gate, not attribution.
- Do not commit, push or force-push unless the user asks. Never rewrite history.
- `README.md` is off limits. Put suggested README text in your report.
- Do not launch, relaunch or kill the dev app. The user runs it. Ask them to restart it after a change to the daemon or the Rust shell.
- No `window.confirm/alert/prompt` (use `alinery-app/src/confirm.tsx`). Git only through `alinery_core::git_cmd` or the daemon's `platform/git.ts`. A daemon file write goes through `platform/fs.ts`.
- **Never end a live session or daemon casually.** No code path may kill a session automatically; teardown has five deliberate origins (AGENTS.md "Owns every PTY"). The user's repos may have real sessions running. Before you stop any `alinery-vinculum-daemon` process, confirm its `--repo` path is a test or leftover repo and has no live session.
- Smallest diff that solves the problem. A second copy of a behaviour is a smell; extract only from repetition you can see.

## Read these first (in this order)

1. `AGENTS.md`: the architecture (Vinculum daemon, sync entities, auth, remote repos, host service) and the build and test gates.
2. `docs/thick-daemon-live-checks.md`: the 118 checks. Part 0 (`L-SMOKE-0` to `-8`) is the happy path. Each entry has steps, expected result and a `Status`. The user's report will usually name an entry id.
3. `docs/thick-daemon-review-ledger.md`: the decisions and deviations the unattended sessions made. Search it by the entry id (`R-S4.3-2` and so on) or by the area before you call something a bug: many behaviours are deliberate and have a "Reverse:" path. Its "Unverified sessions and open findings" section lists what nobody observed.
4. `docs/thick-daemon-plan.md`: the plan and its session numbers (S4.1 to S6.2). Entry ids carry the session, so `L-S4.9-c` leads to S4.9 in the plan.

## Setup

The exact commands are in `L-SMOKE-0`. In short, from the repo root with the PATH line at the top of the live-checks doc:

```bash
cd alinery-app && npm ci && cd ..          # only if node_modules is missing
scripts/dev-fetch-bun.sh                    # compiles alinery-vinculum-daemon
scripts/dev-fetch-omp.sh                    # only for OMP agent sessions
```

The smoke test starts from a fresh app config (`~/Library/Application Support/ai.delegance.alinery` moved to `.bak-live`). Do not move it yourself; ask.

## Where to look when something is wrong

| Symptom | Look at |
|---|---|
| Anything the daemon did or refused | `~/Library/Application Support/ai.delegance.alinery/logs/alinery.log` (app and daemon write to it) |
| Is a daemon running, how many | `pgrep -fl alinery-vinculum-daemon`; `ls -a <repo>/.alinery/` for `rpc.sock`, `.repo-owner.lock`, `.alinery-app.lock` |
| Page shows stale or missing state | `src/sync/replica.ts`, `src/sync/hooks.ts`, the daemon's `sync/` store; check the entity arrives with `SyncService.Subscribe` |
| A call fails with a gRPC code | the handler in `vinculum-daemon/src/rpc/<service>.ts`, auth in `rpc/auth.ts` (capability `VIEW`/`ACT`/`APPROVE`/`ADMIN`/`AGENT`) |
| Webview cannot reach a daemon | `src/daemon/transport.ts`, `src-tauri/src/daemon_rpc.rs` (the generic h2 bridge) |
| Daemon will not start, "conflict", takeover | `src-tauri/src/daemon.rs` (`ensure_daemon`, `classify_hello`), `alinery-core/src/repo_ownership.rs`, `PROTOCOL_VERSION` in `alinery-core/src/protocol.rs` |
| Terminal output or reattach | `rpc/terminal.ts`; scrollback is `tasks/<slug>/sessions/<id>.scrollback`, replayed from an offset |
| Task, board, execution state | `domain/` in the daemon; `tasks/<slug>/task.md`, `execution.json` are the only truth |
| Setup screen, add repo, SSH host | `views/SetupScreen.tsx`, `setup.ts`, `AddSshHostDialog.tsx`, `folderSetup.ts`, `src-tauri/src/remote.rs` |
| Remote host install or connect | `remote.rs`, `host_wire.rs`, `vinculum-daemon/src/hostService/`, runtime tarballs in `src-tauri/resources/remote/` |
| MCP | `vinculum-daemon/src/mcpServer/`, `src-tauri/src/mcp.rs` |

A change under `vinculum-daemon/` or `proto/` means the remote runtime tarball is stale for remote checks: run `scripts/build-remote-runtimes.sh` (Bun only; `--check` lists what is missing).

## How to investigate one issue

1. Restate the symptom and the live-check id (if any). Reproduce it from the entry's steps; get the exact log lines, process list and files on disk.
2. Search the ledger for the area. If it is a recorded decision or deviation, tell the user which entry and what its "Reverse:" path is, and stop there unless they want it reversed.
3. Find the cause in code. Prefer a failing test over a theory: write the test first (daemon: `*.test.ts` beside the source, `bun test`; page: `*.test.ts(x)` beside the source; Rust: `src-tauri/src/tests/<module>.rs`).
4. Fix with the smallest change. Do not widen scope to unrelated findings; list them in the report.
5. Verify (see below). Say plainly what you ran and what you could not run.
6. Record: in the live-checks doc, change that entry's `Status` and add a dated `Result` line **only for what you or the user actually observed**. Never write `pass` for something unobserved. Put decisions and deviations in the ledger as a new entry; never delete or rewrite an earlier one.

## Verification gates

- Rust change: `cd alinery-app/src-tauri && cargo check -p alinery-app` (fast), then `cargo test --workspace` (never bare `cargo test`; it runs a third of the suite). On a fresh clone run `src-tauri/scripts/copy-sidecar.sh debug` first.
- Daemon change: `bun test` in `alinery-app/src-tauri/vinculum-daemon/`.
- `proto/alinery/` change: `npm --prefix proto run gen`, `(cd proto && bun golden.ts)`, `bun test` in `proto/`, `./scripts/tests/check-proto-gen.sh`, **and bump `PROTOCOL_VERSION`** (now 38 as of S5.1; verify in `protocol.rs`).
- `playbook-engine/` change: `bun test` there.
- Before calling anything done: `./scripts/check.sh` (or `--quick`).

## Known weak spots (check these first when the symptom fits)

- S4.2 (execution/playbook engine port): the second review round's fixes were never re-reviewed; a real coding step recording its working files is `L-S4.2-e`.
- S4.12 (providers sign-in and model list): the remote-sshd "Accept" line never ran.
- S4.9 (backups): remote live restore and the Linux runtime test never ran; a host with no `zip`/`unzip` is not handled.
- S4.11: hosted-token push to a real remote host (`L-S4.11-f`).
- S5.2: the host-service replacement and runtime build; S5.3: taking over a new-protocol daemon needs its kept token (`R-S5.3-5`).
- S6.1 and S6.2 (setup screen): look and feel, typed refusal kinds on real hosts (`L-S6.2-c`), offline-host rule (`L-S6.2-d`).
- S5.4: AGENTS.md's Harness Registry and Core Model sections were not audited against the pi-durable runtime. Doc mismatches are likely; report them.
- Remote repos need the Docker sshd (`scripts/tests/remote-sshd/run.sh start`, linux/arm64 **only**; never run amd64 images, Bun crashes under QEMU) or a real ssh host.

## Flaky tests (rerun the single test before treating a failure as a regression)

`tests::daemon::a_repo_being_closed_is_not_respawned_by_attach` (500 ms bound), `tests::daemon::takeover_*` and `tests::daemon_rpc::a_takeover_is_bound_to_the_process_it_was_confirmed_for`, and the S4.11 two-daemon test. Details are in the ledger's section 5.

## Leaked test daemons

Earlier test runs left orphan `alinery-vinculum-daemon` processes (parent pid 1, `--repo` pointing at a deleted `/tmp` directory such as `alinery-mcp-invalid-create-*` or `ato-*`). The takeover tests now clean up after themselves, but if you see many, list them with `ps -axo pid,ppid,command | grep alinery-vinculum-daemon` and stop only those whose `--repo` path no longer exists, one pid at a time with `kill -TERM <pid>`. Never stop one whose repo is a real project the user has open.

## Report back with

For each issue: the symptom, the live-check id, the cause (file and line), whether it is a bug, a recorded decision or the environment, what you changed (files, tests added), what you ran and its result, what you could not verify, and anything you noticed but left alone. Include suggested `README.md` text separately; do not edit the file.
