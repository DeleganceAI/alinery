# Alinery — Agent Context

Playbook IDE: a local macOS (and Linux) Tauri v2 + React/TS desktop app for task-centric agent work. Playbooks are reusable graphs; each task keeps sessions, decisions, and artifacts together. Filesystem is the database. Local-first. Optional anonymized product-usage telemetry (asked on first launch, off until answered; Settings → General → Misc). A detached per-repo daemon (Vinculum, the `alinery-vinculum-daemon` sidecar) owns the PTYs so sessions survive app quit. A repository can also live on another Linux machine over SSH (see Remote repositories).

This repository is the **public product source**. Release signing, CDN publish, Linux builder droplets, and `scripts/install.sh` live elsewhere. Do not assume those scripts exist here.

## README is human-edited only

`README.md` is off limits to agents. You may read it for context, but must not edit, replace, delete, rename, or regenerate it. This includes documentation updates for features, fixes, and cleanup. Put suggested README changes in your handoff to the human instead.

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
```

The app is not locked to a single hardcoded target repo. Global process log (not per-repo): `<app_config_dir>/logs/alinery.log` (1 MB × 5 files; written by the app, the daemon, and alinery-mcp). No UI.

## Harness Registry (`harnesses.toml`)

Bundled `[omp]` only. Terminal (`no-harness`) is a compiled sentinel, not a TOML row. Adding a harness is **not** a supported config change. Leftover overlay JSON on disk is leftover bytes, not a product surface.

Packaged OMP is **not** a Tauri sidecar and is **not** found on PATH. `scripts/omp-pin.txt` pins the official GitHub tag. Production installs place `omp` alongside the dest (`/Applications/Alinery.omp/omp` on macOS, `~/.local/share/alinery/omp/omp` on Linux). Isolated HOME is under `app_config_dir()` (`PI_CODING_AGENT_DIR` + `PI_CONFIG_DIR`). Spawn resolves `binary = "omp"` to that path and fail-closes with `bundled OMP not found` if the file is missing. `scripts/dev-fetch-omp.sh` (`npm run omp:fetch`) populates the default alongside dir for `tauri dev`; `npm run omp:check` prints the resolved binary, its version, and the config roots. An OMP child gets `env_clear()` plus `OMP_ENV_ALLOWLIST`, so an exported provider key never authenticates an instance — inject through the harness row's `env` map instead. Overlay `binary = "sh"` (tests) is still honored verbatim.

The daemon launches from the product launch list (Terminal + bundled/overlaid `omp`). Extra overlay keys are not launchable.

## Daemon (Vinculum) — persistent sessions

- **What it is.** `alinery-vinculum-daemon` is a Bun/TypeScript program (`alinery-app/src-tauri/vinculum-daemon/`, agent runtime pi-durable) and the only daemon sidecar (`check-experimental-daemon-names.sh`). There is no `alineryd` or `runner` crate. The old name survives in the socket file, `<repo>/.alinery/alineryd[-ns].sock`, and in the Rust helpers that build its path. The Rust workspace is the app, `alinery-core` and `mcp`.
- Separate binary, spawned detached per active repo. Socket and lane-lock identities remain build-specific, but `.alinery/.repo-owner.lock` permits only one daemon owner across all lanes. Startup retains every discovered historical lane lock too; lock markers are permanent and never unlinked.
- **Automatic project adoption.** `alinery-core::repo_ownership` checks every previous daemon owner and all retained task records under the repository mutation lock before updating task ownership. A live owner, missing socket with held process lock, or unknown/unreadable ownership evidence blocks the whole project. Once all owners are stopped, opening the project adopts all retained tasks, including archived tasks, automatically. History, artifacts, output reservations, and completed work remain intact; interrupted execution ownership is not recovered and child shutdown is not inferred. There is no per-task transfer or simultaneous task-owning dev/prod coexistence.
- **Confirmed takeover.** Each reachable incompatible owner has an individual **Take over {repo}** action. App-only prepare/confirm/cancel commands bind a 120-second, single-use confirmation to native peer process incarnation and observed session impact; zero and unknown impact still require confirmation. Checked shutdown uses that exact bound stream; replacement waits for the selected socket and permanent lane lease to be released, then normal all-owner acquisition. Another owner requires separate confirmation. No forced kill or lock deletion. Per-repository lifecycle ordering covers attachment, polling, teardown, and takeover.
- **Owns every PTY.** The app proxies over the socket. Quit tears down nothing *unless the user says so*; relaunch reconnects and replays scrollback. **No code path automatically kills a live session** — exactly four deliberate teardown origins send `shutdown`, each behind explicit user action: `stop_daemon` (Settings), `close_repo_daemon` (close repo — called by `remove_repo` and `close_all_repos`), `restore_backup`, and `confirm_repo_takeover_blocking` (only through the consumed confirmation command). Enforced by `scripts/tests/check-no-auto-session-kill.sh`.
- **Quit asks.** Closing the window raises a three-way dialog (`App.tsx` `onCloseRequested`): *leave sessions running* (default), *close all repos*, or *cancel*. Close-all never stops a remote repo: it disconnects its host (ssh ends) and the host's daemon and sessions keep running. `close_all_repos` latches `AppState.quitting` first so the poller cannot resurrect a daemon. Cmd+Q is not covered — macOS `applicationWillTerminate` keeps the leave-running behaviour.
- **`alinery-core`** holds Tauri-free pty/fs/parse/lifecycle logic, consumed by the app and `alinery-mcp`, and by the daemon through the ownership library (`libalinery_core`). Keep shared daemon request builders/reply parsing here so neither app nor MCP grows a second wire.
- **Wire protocol gate.** `alinery-core::PROTOCOL_VERSION` (`protocol.rs`) is the single source of truth, bumped **only** on op-set/wire changes — never for app releases. `ensure_daemon` reuses a daemon only when **protocol and app-config identity both match**. `scripts/tests/check-protocol-version-bump.sh` and `check-wire-parsing-boundary.sh` enforce this. A genuinely wire-neutral refactor uses a commit-scoped `Protocol-Neutral: <why>` trailer.
- **Missing OMP.** A missing packaged OMP binary is a fail-closed spawn error (`bundled OMP not found`). Terminal remains available.
- **GUI ownership locks** (`.alinery/.alinery-app.lock`). Dev and production are mutually exclusive on one folder. Product ownership is flock-only: never a pid file.
- **Activity sidecar**: every session byte is appended to `sessions/<id>.scrollback`. The daemon's in-memory `vt100` emulator is reattach truth.

In-app self-update embeds `scripts/lib/preflight.sh` (compile-time `include_str!`) and runs the same quiet-machine gate as the public CDN installer. That installer script itself is not in this repo.

## Remote repositories (SSH)

A repo can live on another Linux machine. Its key is `alinery+ssh://<host-id>/<absolute path>` (`RepoRef` in `paths.rs`; `src/remoteRepo.ts` mirrors the parser), so `known_repos` and every frontend repo key keep working. Hosts are in `AppConfig.remote_hosts`.

- **Transport.** `src/remote.rs` is the only place that spawns `ssh` (`check-ssh-spawn.sh`): one OpenSSH ControlMaster per host (sockets in `/tmp/alinery-<uid>/`), a unix-socket forward to each repo's daemon socket, and one stdio channel to the host's repo service. Disconnecting ends ssh processes only. It never sends `shutdown`, and removing a remote repo leaves its sessions running on the host. A host the user connected and did not disconnect is brought back when it drops, by `spawn_remote_supervisor` (waits 5, 10, 30, then 60 s; it only connects, and gives up on an unknown or changed host key or a refused login). `connect_and_attach` and `disconnect_host` take a per-host lock, and a successful connect emits `remote_host_connected` so a terminal that lost its stream rejoins.
- **Runtime.** The app bundles Linux runtimes (`alinery-app/src-tauri/resources/remote/<triple>.tar.gz` plus `manifest.json`; glibc, x64 and arm64) and installs one on connect to `~/.local/share/alinery-remote/runtime/<content-hash>/` on the host. A directory named by hash is never overwritten, so a daemon from an older app keeps its own runtime. `scripts/build-remote-runtimes.sh` builds them (needs zig, cargo-zigbuild and the two rustup targets; `--check` lists what is missing). `scripts/tauri.mjs` warns on an empty manifest and fails with `ALINERY_REQUIRE_REMOTE_RUNTIMES=1`. Rebuild after a change to `alinery-core`, `mcp/` or `vinculum-daemon/`, or the live tests run stale code.
- **Host layout.** `~/.local/share/alinery-remote/config/<app-config identity>/` holds the host's `app.toml`, `provider-credentials.json`, `custom-providers.json`, `inference.json`, `ui-secrets/` and `logs/`, owner-only. The `app.toml` is an allowlist rendered by `render_remote_app_toml`; add a field only when a host process reads it, and never copy a Mac-private setting into it.
- **Repo service.** File and git work on a remote repo goes through `alinery-mcp --repo-service`: a typed `RepoOp` and `run()` in `alinery-core/src/repo_service.rs`, JSON lines, one channel per host. These are not daemon ops, so they need no `PROTOCOL_VERSION` bump (the installed runtime is the app's exact build). No op field may be named `id`. Add every new op to the round-trip test.
- **Moving a command to remote.** Put the file and git logic in `alinery-core` as `*_in(repo, …)`, add a `RepoOp` and its `run()` arm, and have the command route `RepoRef::Local` in-process and `Remote` through `remote_call`/`repo_client` (async, off the main thread). `check-remote-routing.sh` fails when a command resolves its repo with a local-only helper and neither routes a remote repo nor is listed, with a reason, in `scripts/tests/remote-local-only.txt`.
- **Approvals.** Over a forward the daemon's peer is sshd, so the app gives the daemon a secret (`--ui-secret-file`, deleted when read) and keeps its copy in `<app_config_dir>/remote/<host-id>/ui-secrets.json`. A daemon this app did not start has none, and approvals fail closed.
- **Credentials are chosen, never implied.** Each host has a `RemoteSharing` record: what it may receive, and what the app has placed there. A new host receives nothing until the user has chosen. Browser sign-ins (`oauth`) are never copied, because their refresh tokens rotate and two copies sign each other out; the host signs in for itself, and a sync never touches a sign-in made there. Do not send a credential-like value to a host without an item for it in the sharing list.
- **UI.** The remote button beside Add repository opens `RemoteModal` (hosts, set up a remote, credentials, folder picker). `RemoteCredentials.tsx` holds the credentials choices.
- **Testing.** Unit tests are in `src/tests/remote.rs`. The `live_*` tests need an sshd and skip without one: `scripts/tests/remote-sshd/run.sh start` builds a throwaway Debian sshd in Docker and prints the `ALINERY_TEST_SSH_ARGS` line to export; then `cargo test -p alinery-app --lib -- tests::remote::live`; then `run.sh stop`.

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
| `pi_durable.rs` | Vinculum process supervision |
| `remote.rs` | SSH hosts: destination parsing, probe, runtime install, ControlMaster, repo-service channel, credential sharing, `~/.ssh/config` aliases |
| `chat.rs` | taskless chat threads (rail, create/pin/archive, attachments); file and git half in `alinery_core::chat` |
| `hosted.rs` | hosted Alinery models: catalog, credits, mint/revoke against the accounts service |
| `vinculum_customizations.rs` | read-only inventory of the Vinculum agent directory |
| `community_playbooks.rs` | community playbook catalog, import registry, publish |
| `mcp.rs` | managed MCP child lifecycle and status |
| `notify.rs` | notification sound + attention notifications |
| `backup.rs` / `backup_queue.rs` | auto-backup queue, backup/restore |
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
- Daemon/repo: `prepare_repo_takeover`, `confirm_repo_takeover`, `cancel_repo_takeover`, `stop_daemon`, `close_all_repos`, `repo_live_sessions`, `set_active_repo`, `remove_repo`, `pick_repo_dialog`, `read_app_config`
- Connections/import: `connection_statuses`, `connect_github`, `connect_linear`, `import_linear`, `import_github`
- Update: `check_update` (never Err; silent no-offer), `download_update`, `apply_update` — prod-only
- Storage: `storage_info`, `delete_all_archived_storage`
- Remote: `remote_hosts`, `remote_add_host`, `remote_ssh_aliases`, `remote_describe_destination`, `remote_discard_host`, `remote_sharing`, `remote_set_sharing`, `remote_connect`, `remote_disconnect`, `remote_list_dir`, `remote_classify`, `remote_init`, `remote_add_repo`, `remove_remote_repo_keep_running`

MCP session tools: `alinery_create_session` / `alinery_start_session` / `alinery_session_status` / `alinery_read_session_history`. MCP never exposes attach/write/resize/detach/kill/resume/takeover/bulk operations, and a mismatch never triggers teardown.

## Frontend Views (no router)

`useState` switch: Task list, Grid, Kanban, Task detail, Session (xterm.js). Reuse `<SessionTerminal>` everywhere.

**Never use `window.confirm` / `alert` / `prompt`.** `tauri_plugin_dialog::init()` injects an init script that replaces them: `window.confirm` becomes **async**, so `if (!window.confirm(msg)) return;` tests a Promise (always truthy) and the destructive action runs with no dialog. Every confirmation goes through `alinery-app/src/confirm.tsx`: `await confirmDanger(...)` for yes/no, `await askConfirm({choices, defaultKey})` when there are more than two answers. Default focus is the safe choice, never the danger button. Guarded by `scripts/tests/check-no-window-confirm.sh`.

## Engineering rules

- Smallest diff that solves the requested problem. No speculative traits, registries, or abstractions.
- Git = `alinery_core::git_cmd` only. Never `Command::new("git")`. `git_cmd` uses a real git on this process's PATH when there is one (macOS `/usr/bin/git` does not count until the Command Line Tools are installed — that binary is a stub and running it raises a dialog). Otherwise it uses the alongside tree (`/Applications/Alinery.git/bin/git`, or `~/.local/share/alinery/git/bin/git` on Linux) and sets `GIT_EXEC_PATH` so HTTPS push can find `git-remote-https`. `scripts/git-pin.txt` pins the official tarball the release build compiles; `install.sh` copies that tree only when the app would not already see a git. `tauri dev` keeps using the system git. `ALINERY_GIT_PATH` is a dev/test override, not a PATH search.
- `time` is pinned to `0.3.51` in `Cargo.lock` — never un-pin (`cargo update` breaks the Tauri v2 build).
- Do not infer correctness from editor state or partial compiles. See "Build & Compile Verification". Do not launch the app to verify unless the user asks.
- Quit must never kill harnesses **on its own** — the daemon outlives the app on purpose. Teardown inside the app is explicit only (the three origins above).
- **DRY: one behaviour, one home — and the comment lives with it.** Second copy = extract. Extract from *observed* repetition, never anticipated repetition. Comments explain *why*, and only in the canonical place.

## Build & Compile Verification (mandatory)

After **any** Rust change in `alinery-app/src-tauri/src/`, `alinery-core/`, or `mcp/`:

```bash
cd alinery-app/src-tauri
cargo check -p alinery-app
```

Do **not** consider the change done until this passes. For sidecar/bundler work (`copy-sidecar.sh`, `tauri.conf.json`, `externalBin`), also run the copy script. A change in `vinculum-daemon/src` is TypeScript: run `bun test` in `alinery-app/src-tauri/vinculum-daemon/` (the tests sit beside the source as `*.test.ts`).

Live GUI verify is opt-in only, when the user asks to see the app. For a local `tauri dev` OMP session, run `scripts/dev-fetch-omp.sh` once so `/Applications/Alinery.omp/omp` exists. The resolver never falls back to PATH.

`npm run tauri dev` and `npm run tauri build` also compile `alinery-vinculum-daemon` beside the app executable they are about to run, by invoking `scripts/dev-fetch-bun.sh --no-download` for the launch's cargo profile. Its agent runtime is pi-durable. The launch never reaches the network for a toolchain, and a missing Bun or a failed compile only prints a line. Run the script bare to fetch the pinned Bun and compile by hand; it short-circuits an up-to-date output.

## App version bump (marketing semver)

There is no bump script in this repo. Bump first, commit, push. This is **not** `alinery-core::PROTOCOL_VERSION` — that integer moves only on wire/op-set changes. Cutting the GitHub Release and publishing `cdn.alinery.ai` is done from `alinery-deploy`, which **reads** these versions and will not write them.

Edit **all seven** of these, to the same `X.Y.Z`:

| File | What to change |
|---|---|
| `alinery-app/package.json` | `"version"` |
| `alinery-app/package-lock.json` | both `"version"` keys (root **and** `packages[""]`) |
| `alinery-app/src-tauri/tauri.conf.json` | `"version"` |
| `alinery-app/src-tauri/Cargo.toml` | `[package] version` |
| `alinery-app/src-tauri/alinery-core/Cargo.toml` | `[package] version` |
| `alinery-app/src-tauri/mcp/Cargo.toml` | `[package] version` |
| `alinery-app/src-tauri/Cargo.lock` | `version` on the **three workspace packages only**: `alinery-app`, `alinery-core`, `alinery-mcp` |

**Gotchas:** TOML has no trailing commas. Do not `replace_all` the old semver inside `Cargo.lock` (third-party crates can share that string). After the edit, run `cargo metadata --manifest-path alinery-app/src-tauri/Cargo.toml --format-version 1 --no-deps` (or `cargo check -p alinery-app`) so the lockfile still parses.

## Testing & Linting

**One command decides whether a change is good:**

```bash
./scripts/check.sh            # everything
./scripts/check.sh --quick    # skips the slow behavioural suites
```

It covers biome, both typecheck passes, vitest, the omp-extension suite, `cargo fmt`/`clippy`/`test --workspace`, and the product shell gates. `cargo check -p alinery-app` is the fast inner-loop gate while editing; `check.sh` is the one that must pass before you call a change done.

**Two traps that will hand you a false green:**

- **`cargo test` alone runs a third of the suite.** `default-members = ["."]` in `src-tauri/Cargo.toml` means a bare `cargo test` builds only the app crate. Always `cargo test --workspace`.
- **`cargo test`/`clippy` need the sidecars.** On a fresh clone the tauri build script fails with `resource path alinery-vinculum-daemon-<triple> doesn't exist`. Run `src-tauri/scripts/copy-sidecar.sh debug` first — `check.sh` does.

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
- `check-ssh-spawn.sh` — `ssh` is spawned only from `src/remote.rs`, and the remote path kills nothing
- `check-remote-routing.sh` — every repo-resolving command routes remote repos or is listed in `remote-local-only.txt`
- `check-blocking-commands.sh` — blocking user commands are async and reach `spawn_blocking`
- `check-experimental-daemon-names.sh` — `externalBin` is Vinculum plus MCP; no `alineryd` or runner
- `check-no-curl.sh` — HTTP is `alinery_core::http`, never a `curl` child
- `check-no-auto-session-kill.sh` — `shutdown` senders stay on the four-name allowlist
- `check-no-window-confirm.sh` — no `window.confirm|alert|prompt` in `alinery-app/src`
- `check-protocol-version-bump.sh` / `check-wire-parsing-boundary.sh` / `protocol_gate_test.sh` — wire protocol
- `check-ipc-boundary.sh` / `check-ipc-commands.sh` — IPC seam
- `check-omp-no-path-fallback.sh` / `omp_lib_test.sh` / `dev_fetch_omp_test.sh` / `install_omp_place_test.sh` — packaged OMP
- `check-telemetry-privacy.sh` / `check-connection-status-never-decrypts.sh`
- `preflight_test.sh` / `preflight_live_test.sh` — installer/updater quiet-machine helpers in `scripts/lib/preflight.sh`
- `updater_swap_test.sh` — in-app swap helper

`remote-sshd/` is not a gate: it is the Docker sshd the live remote tests run against (see Remote repositories).

Signing, CDN, droplet, and `install.sh` prompt tests are **not** in this repo.

## References

- `README.md` — product overview and `tauri dev`
- `alinery-app/src-tauri/playbooks/` — bundled playbook prompts
- `alinery-app/src-tauri/playbooks.default.toml` — playbook registry
