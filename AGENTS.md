# Alinery — Agent Context

Playbook IDE: a local macOS (and Linux) Tauri v2 + React/TS desktop app for task-centric agent work. Playbooks are reusable graphs; each task keeps sessions, decisions, and artifacts together. Filesystem is the database. Local-first. Optional anonymized product-usage telemetry (asked on first launch, off until answered; Settings → Telemetry). A detached per-repo daemon (`alineryd`) owns the PTYs so sessions survive app quit.

This repository is the **public product source**. Release signing, CDN publish, Linux builder droplets, and `scripts/install.sh` live elsewhere. Do not assume those scripts exist here.

## Do not launch the app

Never launch, build-and-open, or `open` the desktop app (`npm run tauri dev` or a bundled `.app`) unless the user explicitly asks to see the window. Verify with `cargo check -p alinery-app` and `./scripts/check.sh`. If they do ask, open Alinery from this branch.

## Core Model

- **Task** = durable container (`.alinery/tasks/<slug>/task.md`).
- **Session** = one PTY running OMP (or Terminal `no-harness`). Cheap, disposable; many per task.
- **Artifact** = numbered markdown output written by the harness to `artifacts/NN-*.md`. Checkpoint between playbook steps.
- **Attachment** = a user-supplied file copied at task creation into `artifacts/attachments/`. Deliberately invisible to every artifact scan; a harness reaches it through `{{ARTIFACTS_DIR}}/attachments/`.
- **Worktree** = one per task (`git worktree add` on branch `<slug>`). Kept until explicit removal.
- **Current step** = derived from the latest non-archived playbook session's phase. Auxiliary sessions do not regress board position (no stored field).
- **Grid / Kanban** = read-only projection grouping tasks by derived playbook step.

## Storage Layout

```
<target-repo>/.alinery/
  config.toml
  harnesses.toml
  playbooks.toml            # overlay; bundled defaults in playbooks.default.toml
  tasks/<slug>/
    task.md                 # TOML frontmatter
    artifacts/NN-*.md
    artifacts/attachments/  # user files copied at create (never scanned as artifacts)
    sessions/<id>.meta.json
    sessions/<id>.scrollback
  worktrees/<slug>/
  canvas.json               # Orbitron View spatial sidecar (absent until first write)
  orbitron-agent/           # manager `omp --mode rpc` log (not an alineryd session)
```

The app is not locked to a single hardcoded target repo. Global process log (not per-repo): `<app_config_dir>/logs/alinery.log` (1 MB × 5 files; written by the app, alineryd, and alinery-mcp). No UI.

## Harness Registry (`harnesses.toml`)

Bundled `[omp]` only. Terminal (`no-harness`) is a compiled sentinel, not a TOML row. Adding a harness is **not** a supported config change. Leftover overlay JSON on disk is leftover bytes, not a product surface.

Packaged OMP is **not** a Tauri sidecar and is **not** found on PATH. `scripts/omp-pin.txt` pins the official GitHub tag. Production installs place `omp` alongside the dest (`/Applications/Alinery.omp/omp` on macOS, `~/.local/share/alinery/omp/omp` on Linux). Isolated HOME is under `app_config_dir()` (`PI_CODING_AGENT_DIR` + `PI_CONFIG_DIR`). Spawn resolves `binary = "omp"` to that path and fail-closes with `bundled OMP not found` if the file is missing. `scripts/dev-fetch-omp.sh` (`npm run omp:fetch`) populates the default alongside dir for `tauri dev`; `npm run omp:check` prints the resolved binary, its version, and the config roots. An OMP child gets `env_clear()` plus `OMP_ENV_ALLOWLIST`, so an exported provider key never authenticates an instance — inject through the harness row's `env` map instead. Overlay `binary = "sh"` (tests) is still honored verbatim.

The daemon launches from the product launch list (Terminal + bundled/overlaid `omp`). Extra overlay keys are not launchable.

## Daemon (`alineryd`) — persistent sessions

- Separate binary, spawned detached per active repo; listens on `<repo>/.alinery/alineryd.sock`, single instance via `.alineryd.lock` (stale-lock tolerant — a dead socket is reclaimed).
- **Owns every PTY.** The app proxies over the socket. Quit tears down nothing *unless the user says so*; relaunch reconnects and replays scrollback. **No code path automatically kills a live session** — exactly four deliberate teardown origins send `shutdown`, each behind a user click naming the repo and the live count: `stop_daemon` (Settings), `takeover_repo_daemon` (reclaim banner), `close_repo_daemon` (close repo — called by `remove_repo` and by `close_all_repos`), `restore_backup`. Enforced by `scripts/tests/check-no-auto-session-kill.sh`.
- **Quit asks.** Closing the window raises a three-way dialog (`App.tsx` `onCloseRequested`): *leave sessions running* (default), *close all repos*, or *cancel*. `close_all_repos` latches `AppState.quitting` first so the poller cannot resurrect a daemon. Cmd+Q is not covered — macOS `applicationWillTerminate` keeps the leave-running behaviour.
- **`alinery-core`** holds Tauri-free pty/fs/parse/lifecycle logic, consumed by the app, `alineryd`, and `alinery-mcp`. Keep shared daemon request builders/reply parsing here so neither app nor MCP grows a second wire.
- **Wire protocol gate.** `alinery-core::PROTOCOL_VERSION` (`protocol.rs`) is the single source of truth, bumped **only** on op-set/wire changes — never for app releases. `ensure_daemon` reuses a daemon only when **protocol and app-config identity both match**. `scripts/tests/check-protocol-version-bump.sh` and `check-wire-parsing-boundary.sh` enforce this. A genuinely wire-neutral refactor uses a commit-scoped `Protocol-Neutral: <why>` trailer.
- **OMP host guard.** `alineryd` refuses fresh/resumed/auto-advanced OMP launches when the captured GUI executable is invalid. Terminal remains available. A missing packaged OMP binary is a separate fail-closed spawn error (`bundled OMP not found`).
- **GUI ownership locks** (`.alinery/.alinery-app.lock`). Dev and production are mutually exclusive on one folder. Product ownership is flock-only: never a pid file.
- **Activity sidecar**: every session byte is appended to `sessions/<id>.scrollback`. The daemon's in-memory `vt100` emulator is reattach truth.

In-app self-update embeds `scripts/lib/preflight.sh` (compile-time `include_str!`) and runs the same quiet-machine gate as the public CDN installer. That installer script itself is not in this repo.

## Playbooks

Bundled playbooks live in `alinery-app/src-tauri/playbooks/` with the registry in `playbooks.default.toml`. Default playbook is **superdevelop** (clarify → investigate → decide → plan → define-tests → build → prepare-review). `{{ARTIFACTS_DIR}}` and related tokens are substituted at spawn. Custom overlays go in the target repo's `playbooks.toml`. This is **not** the old compiled-in RPI six-prompt set.

## App crate layout (`alinery-app/src-tauri/src/`)

`lib.rs` is the crate root: shared `use`s, the module list, and `run()` with `generate_handler!`. Each module is `pub(crate)` and glob-imported at the root. Tests live in `src/tests/<module>.rs`, not a single `tests.rs`.

| Module | Owns |
|---|---|
| `paths.rs` | active-repo cell, ownership claims, repo/task/session/artifact path builders |
| `state.rs` | `AppState`, `RepoDaemon`, `RepoReservation`, `ClosingGuard` |
| `app_config.rs` | `AppConfig`/appearance prefs, known-repo list, repo switching/removal |
| `settings.rs` | `config.toml`, scoped/global settings, harness + model registry, storage info |
| `playbook.rs` | playbooks, steps, kanban columns |
| `artifacts.rs` | artifacts, comments/drafts, review handoff |
| `task.rs` | `Task`/`BoardTask`, create/draft/attachment/board paths |
| `session.rs` | `SessionMeta`, session CRUD, message actions, open/write/resize/kill, history |
| `subtask.rs` | parent/child sub-task lifecycle |
| `daemon.rs` | `DaemonClient`, `ensure_daemon`, lane routing, teardown origins, the 5s poller |
| `mcp.rs` | managed MCP child lifecycle and status |
| `notify.rs` | notification sound + attention notifications |
| `backup.rs` / `backup_queue.rs` | auto-backup queue, backup/restore |
| `canvas.rs` | `.alinery/canvas.json` — Orbitron View spatial sidecar (concepts, placements, relations, camera) plus `read_canvas` / `write_canvas`. Validates and normalizes only; never invents layout, never drops a placement whose slug is absent from the catalog |
| `orbitron_agent.rs` | installation-global `tokens.toml`, the Orbitron manager `omp --mode rpc` child, and the stdio transport to it: bootstrap, the reader thread, `agent.log`. Not an `alineryd` session, and not on the alineryd wire — its contract is `omp://rpc.md`. Spawn uses packaged OMP (`resolve_packaged_omp_path`), `env_clear` + isolated HOME, and fail-closes with `bundled OMP not found` |
| `git_ops.rs` | worktree removal, compare URL; re-exports `alinery_core::git_cmd` (the only git spawn) |
| `connections.rs` | GitHub browser login plus Linear OAuth PKCE |
| `imports.rs` | Linear and GitHub issue import |
| `account.rs` | pairing / account chip |
| `update.rs` | CDN manifest poll, download+sha256 verify, detached swap helper |
| `omp_update.rs` | OMP binary update status |
| `telemetry.rs` | opt-in usage events |

A new command goes in the module that owns its data; `lib.rs` only gains a name in `generate_handler!`.

## Commands (Rust Tauri)

- Task: `create_task`, `list_tasks`, `archive_task`, `restore_task_for_repo`, `attachment_path`
- Session (proxy to daemon): `create_session`, `list_sessions`, `archive_session`, `open_session`, `write_session`, `resize_session`, `detach_session`, `session_status`, `kill_session`, `resume_session`, `set_resume_token`, `session_resume_state`, `read_session_history`
- Playbook/Harness: `list_phases`, `list_playbooks`, `list_harness_models`, `list_artifacts`
- Orbitron View (canvas): `read_canvas` (active repo, claims nothing — missing sidecar reads as the empty board), `write_canvas` (requires the GUI flock; validates, normalizes relations to sorted endpoints with one kind per pair, then writes atomically so a refused write leaves the previous board untouched)
- Orbitron agent: `orbitron_xai_key_status`, `set_orbitron_xai_key`, `clear_orbitron_xai_key` (installation-global `tokens.toml`; JS never reads the secret), `orbitron_agent_availability`, `start_orbitron_agent`, `send_orbitron_agent_prompt`, `orbitron_host_tool_result`, `set_orbitron_agent_mode`
- Daemon/repo: `stop_daemon`, `takeover_repo_daemon`, `close_all_repos`, `repo_live_sessions`, `set_active_repo`, `remove_repo`, `pick_repo_dialog`, `read_app_config`
- Connections/import: `connection_statuses`, `connect_github`, `connect_linear`, `import_linear`, `import_github`
- Update: `check_update` (never Err; silent no-offer), `download_update`, `apply_update` — prod-only
- Storage: `storage_info`, `delete_all_archived_storage`

MCP session tools: `alinery_create_session` / `alinery_start_session` / `alinery_session_status` / `alinery_read_session_history`. MCP never exposes attach/write/resize/detach/kill/resume/takeover/bulk operations, and a mismatch never triggers teardown.

## Frontend Views (no router)

`useState` switch: Task list, Grid, Kanban, Task detail, Session (xterm.js), Orbitron View (`{ kind: "canvas" }`, hotkey-gated). Reuse `<SessionTerminal>` everywhere.

**Never use `window.confirm` / `alert` / `prompt`.** `tauri_plugin_dialog::init()` injects an init script that replaces them: `window.confirm` becomes **async**, so `if (!window.confirm(msg)) return;` tests a Promise (always truthy) and the destructive action runs with no dialog. Every confirmation goes through `alinery-app/src/confirm.tsx`: `await confirmDanger(...)` for yes/no, `await askConfirm({choices, defaultKey})` when there are more than two answers. Default focus is the safe choice, never the danger button. Guarded by `scripts/tests/check-no-window-confirm.sh`.

### Orbitron View (spatial authoring canvas)

A sixth top-level `View` (`{ kind: "canvas" }`) reached only by `⌘⇧O` or the command palette entry "Toggle Orbitron View". Deliberately **not** a `Tab`: Grid stays the default surface, and `TopBar` must not grow an Orbitron tab (`src/TopBar.test.tsx` asserts it, because adding `"canvas"` to `Tab` typechecks fine). It is per-repository — All repos toasts and stays put. The name is the view's, never a typeface.

**Esc belongs to the canvas.** `useHotkeys` treats the presence of `canvasEscape` as "Orbitron is showing" and never falls through to `back()` there, even when there is nothing to cancel: leaving a spatial view by accident loses the user's place in it. Exit is the explicit Back control or the same chord. `H.board` stays `null`, so `j/k/h/l` are dead; bare tool keys route through `canvasKey`, which returns `true` for the keys it consumed. Still one `window` keydown listener.

The board is one `<canvas>` painted from a dirty flag, one paint per frame. Camera, gesture and document mirrors live in refs — a 60 fps pan must not re-render the tree, and paint must see the newest value synchronously — while React state carries only chrome-visible facts. Scene logic is React-free and unit-tested under `alinery-app/src/canvas/`.

**Pipes are routed, not drawn straight.** Every pipe is an orthogonal polyline through gutters the packer already leaves empty. The invariant that keeps this honest lives in `pipes.test.ts`: **no segment of a pipe may pass through the interior of any card, including the two it connects.** Touching a face is how a pipe docks; entering the box is the bug.

The join key is `Task.slug` (`task.md` gains no field). Archiving a task **keeps** its placement — the card greys out in place. Card fields come from `board_task` (durable `BoardSessionState`, not a live daemon round-trip). Mode words live in `canvas/camera.ts` beside `lodLabel`; the resting tool is "Viewing".

Six invariants live in `scripts/tests/check-canvas-invariants.sh` (registered in `check.sh`): no `getComputedStyle` on the paint path (`canvas/tokens.ts` is the only reader), no "lite card while panning", the agent pane talks through `ipc.ts` and consults `CanvasEditMode` via `applyBoardToolForMode` (never raw `invoke`/`fetch`, never `Accept (MCP apply)`), no Sample data control, the Orbitron typeface is never loaded, and `.orbitron` must be `position: absolute; inset: 0` (not `flex`). jsdom has no layout engine, so verifying this view in a real window is opt-in only.

#### The agent pane (chrome, not a chat app)

Attributed turns, not mirrored bubbles. Activity is the last row of the transcript (`RunningIndicator` while thinking / updating board / compacting; nothing when idle). A held host call is the one earned card: Accept / Reject. Pane width is `AGENT_MIN_WIDTH` in `views/orbitron-agent.ts`, also the close threshold. Live width is `--agent-w` on `.orbitron`.

#### The manager agent's transport (`omp --mode rpc`)

`orbitron_agent.rs` owns a plain child process on stdio; the contract is `omp://rpc.md`. This is **not** an `alineryd` session. Spawn resolves packaged OMP (`resolve_packaged_omp_path`), `env_clear()`s, injects `XAI_API_KEY` plus isolated `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`, and fail-closes with `bundled OMP not found`. MCP include list uses playbook tools, not workflows. Four load-bearing wire rules:

1. **Every command is keyed `type`.** `{"op": …}` is answered `Unknown command: undefined`. `omp_rpc` inserts the discriminator rather than writing it in the literal, because `check-wire-parsing-boundary.sh` reads an `op`-keyed literal as an alineryd request.
2. **`extension_ui_request` MUST be answered.** Unanswered, the turn never completes. Alinery renders no OMP widgets, so the reader answers all of them `{ cancelled: true }`.
3. **Host tools are correlated by the RPC call id**, not the tool name. `set_host_tools` names its schema field `parameters` (the MCP spelling `inputSchema` registers a tool that takes no arguments).
4. **Assistant text is `assistantMessageEvent` deltas**: only `text_start` / `text_delta` are transcript. `thinking_*` never reaches the pane, and `text_end` repeats the whole message.

Frames in and out, plus the child's stderr, are appended to `<repo>/.alinery/orbitron-agent/agent.log`. The xAI key is installation-global `tokens.toml` beside `app.toml`; JS only ever sees `{ present }`.

## Engineering rules

- Smallest diff that solves the requested problem. No speculative traits, registries, or abstractions.
- Git = `alinery_core::git_cmd` only. Never `Command::new("git")`.
- `time` is pinned to `0.3.51` in `Cargo.lock` — never un-pin (`cargo update` breaks the Tauri v2 build).
- Do not infer correctness from editor state or partial compiles. See "Build & Compile Verification". Do not launch the app to verify unless the user asks.
- Quit must never kill harnesses **on its own** — `alineryd` outlives the app on purpose. Teardown inside the app is explicit only (the four origins above).
- **DRY: one behaviour, one home — and the comment lives with it.** Second copy = extract. Extract from *observed* repetition, never anticipated repetition. Comments explain *why*, and only in the canonical place.

## Build & Compile Verification (mandatory)

After **any** Rust change in `alinery-app/src-tauri/src/`, `alineryd/`, `alinery-core/`, `mcp/`, or `runner/`:

```bash
cd alinery-app/src-tauri
cargo check -p alinery-app
```

Do **not** consider the change done until this passes. For sidecar/bundler work (`copy-sidecar.sh`, `tauri.conf.json`, `externalBin`), also run the copy script.

Live GUI verify is opt-in only, when the user asks to see the app. For a local `tauri dev` OMP session, run `scripts/dev-fetch-omp.sh` once so `/Applications/Alinery.omp/omp` exists. The resolver never falls back to PATH.

## App version bump (marketing semver)

There is no bump script in this repo. Bump first, commit, push. This is **not** `alinery-core::PROTOCOL_VERSION` — that integer moves only on wire/op-set changes. Cutting the GitHub Release and publishing `cdn.alinery.ai` is done from `alinery-deploy`, which **reads** these versions and will not write them.

Edit **all nine** of these, to the same `X.Y.Z`:

| File | What to change |
|---|---|
| `alinery-app/package.json` | `"version"` |
| `alinery-app/package-lock.json` | both `"version"` keys (root **and** `packages[""]`) |
| `alinery-app/src-tauri/tauri.conf.json` | `"version"` |
| `alinery-app/src-tauri/Cargo.toml` | `[package] version` |
| `alinery-app/src-tauri/alinery-core/Cargo.toml` | `[package] version` |
| `alinery-app/src-tauri/alineryd/Cargo.toml` | `[package] version` |
| `alinery-app/src-tauri/mcp/Cargo.toml` | `[package] version` |
| `alinery-app/src-tauri/runner/Cargo.toml` | `[package] version` |
| `alinery-app/src-tauri/Cargo.lock` | `version` on the **five workspace packages only**: `alinery-app`, `alinery-core`, `alinery-mcp`, `alinery-runner`, `alineryd` |

**Gotchas:** TOML has no trailing commas. Do not `replace_all` the old semver inside `Cargo.lock` (third-party crates can share that string). After the edit, run `cargo metadata --manifest-path alinery-app/src-tauri/Cargo.toml --format-version 1 --no-deps` (or `cargo check -p alinery-app`) so the lockfile still parses.

## Testing & Linting

**One command decides whether a change is good:**

```bash
./scripts/check.sh            # everything
./scripts/check.sh --quick    # skips the slow behavioural suites — what the pre-push hook runs
```

It covers biome, both typecheck passes, vitest, the omp-extension suite, `cargo fmt`/`clippy`/`test --workspace`, and the product shell gates. `cargo check -p alinery-app` is the fast inner-loop gate while editing; `check.sh` is the one that must pass before you call a change done.

```bash
git config core.hooksPath scripts/hooks
```

Bypass for a work-in-progress push: `ALINERY_SKIP_CHECK=1 git push`.

**Two traps that will hand you a false green:**

- **`cargo test` alone runs a third of the suite.** `default-members = ["."]` in `src-tauri/Cargo.toml` means a bare `cargo test` builds only the app crate. Always `cargo test --workspace`.
- **`cargo test`/`clippy` need the sidecars.** On a fresh clone the tauri build script fails with `resource path alineryd-<triple> doesn't exist`. Run `src-tauri/scripts/copy-sidecar.sh debug` first — `check.sh` does.

**TypeScript:** Biome is the formatter *and* the linter (`alinery-app/biome.jsonc`). There is no Prettier and no ESLint. Warnings do not fail the gate.

**Where a new test goes:**

| What you changed | Test goes |
|---|---|
| Pure TS logic | `alinery-app/src/<module>.test.ts`, beside the source |
| A React component | same |
| Rust logic in the **app crate** | `src-tauri/src/tests/<owning-module>.rs` |
| Rust logic in another crate | that crate's `#[cfg(test)] mod tests` |
| Cross-process / real-daemon behaviour | `<crate>/tests/` |
| An invariant no runtime test can reach | a new `scripts/tests/check-*.sh` source guard |

**The IPC rule:** `@tauri-apps/*` is imported by `alinery-app/src/ipc.ts` and nowhere else. Calling a command means adding a typed wrapper there. Enforced by `check-ipc-boundary.sh` and `check-ipc-commands.sh`.

## `scripts/tests/` — shell-level gates

These run from `scripts/check.sh`. Source guards also run under `--quick`; the behavioural suites do not.

- `check-git-env-scrub.sh` — no raw `Command::new("git")` outside `alinery-core/src/git.rs`
- `check-no-auto-session-kill.sh` — `shutdown` senders stay on the four-name allowlist
- `check-no-window-confirm.sh` — no `window.confirm|alert|prompt` in `alinery-app/src`
- `check-canvas-invariants.sh` — Orbitron View source guard (no getComputedStyle in paint, no lite cards, agent pane uses ipc + mode-gated apply, no Sample data, no Orbitron font, stage fills the view)
- `check-protocol-version-bump.sh` / `check-wire-parsing-boundary.sh` / `protocol_gate_test.sh` — wire protocol
- `check-ipc-boundary.sh` / `check-ipc-commands.sh` — IPC seam
- `check-omp-no-path-fallback.sh` / `omp_lib_test.sh` / `dev_fetch_omp_test.sh` / `install_omp_place_test.sh` — packaged OMP
- `check-telemetry-privacy.sh` / `check-connection-status-never-decrypts.sh`
- `preflight_test.sh` / `preflight_live_test.sh` — installer/updater quiet-machine helpers in `scripts/lib/preflight.sh`
- `updater_swap_test.sh` — in-app swap helper

Signing, CDN, droplet, and `install.sh` prompt tests are **not** in this repo.

## References

- `README.md` — product overview and `tauri dev`
- `alinery-app/src-tauri/playbooks/` — bundled playbook prompts
- `alinery-app/src-tauri/playbooks.default.toml` — playbook registry
