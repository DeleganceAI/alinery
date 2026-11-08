# Alinery — Agent Context

Playbook IDE: a local macOS (and Linux) Tauri v2 + React/TS desktop app for task-centric agent work. Playbooks are reusable graphs; each task keeps sessions, decisions, and artifacts together. Filesystem is the database. Local-first. Optional anonymized product-usage telemetry (asked on first launch, off until answered; Settings → General → Misc). A detached per-repo daemon (Vinculum, the `alinery-vinculum-daemon` sidecar) is the application: it owns the PTYs so sessions survive app quit, the domain logic (tasks, sessions, executions, artifacts, playbooks, git, backups, settings, providers) and the repository's state, and serves them over one RPC socket. The desktop app is one client of it; MCP is another. A repository can also live on another Linux machine over SSH (see Remote repositories).

This repository is the **public product source**. Release signing, CDN publish, Linux builder droplets, and `scripts/install.sh` live elsewhere. Do not assume those scripts exist here.

## README is human-edited only

`README.md` is off limits to agents. You may read it for context, but must not edit, replace, delete, rename, or regenerate it. This includes documentation updates for features, fixes, and cleanup. Put suggested README changes in your handoff to the human instead.

## Do not launch the app

Never launch, build-and-open, or `open` the desktop app (`npm run tauri dev` or a bundled `.app`) unless the user explicitly asks to see the window. Verify with `cargo check -p alinery-app` and `./scripts/check.sh`. If they do ask, open Alinery from this branch.

## Core Model

- **Task** = durable container (`.alinery/tasks/<slug>/task.md`).
- **Session** = one agent conversation inside the daemon's Vinculum harness (or Terminal `no-harness`). Cheap, disposable; many per task.
- **Artifact** = numbered markdown output written by the harness to `artifacts/NN-*.md`. Checkpoint between playbook steps.
- **Attachment** = a user-supplied file copied at task creation into `artifacts/attachments/`. Deliberately invisible to every artifact scan; a harness reaches it through `{{ARTIFACTS_DIR}}/attachments/`.
- **Worktree** = one per task (`git worktree add` on branch `<slug>`). Kept until explicit removal.
- **Current step** = derived from the latest non-archived playbook session's phase. Auxiliary sessions do not regress board position (no stored field).
- **Grid** = read-only projection grouping tasks by derived playbook step.

## Storage Layout

```
<target-repo>/.alinery/
  config.toml
  harnesses.toml
  playbooks.toml            # overlay; bundled defaults in playbooks.default.toml
  rpc.sock                  # the daemon's one listener (rpc-<ns>.sock on a dev/other lane); alinery.v1
  .alinery-app.lock         # the GUI's flock
  .repo-owner.lock          # the one daemon owner across lanes (permanent marker)
  tasks/<slug>/
    task.md                 # TOML frontmatter
    execution.json          # the playbook engine's state; the file is the only truth
    executions/<id>/objects/  # step snapshots (O27); removed on archive, artifacts and manifests stay
    artifacts/NN-*.md
    artifacts/attachments/  # user files copied at create (never scanned as artifacts)
    sessions/<id>.meta.json
    sessions/<id>.pi.sqlite    # pi-durable agent state (harness sessions)
    sessions/<id>.scrollback
  worktrees/<slug>/
```

The app is not locked to a single hardcoded target repo. Global process log (not per-repo): `<app_config_dir>/logs/alinery.log` (1 MB × 5 files; written by the app and the daemon). No UI.

## Harness Registry (`harnesses.toml`)

Bundled `[omp]` row only, and it is now vestigial: it names a binary that is no longer shipped or spawned. Terminal (`no-harness`) is a compiled sentinel, not a TOML row. Adding a harness is **not** a supported config change. Leftover overlay JSON on disk is leftover bytes, not a product surface.

The harness that actually runs is **Vinculum**: the daemon opens a conversation in-process on `@earendil-works/pi-durable` (`main.ts` `openSession`), with no external agent binary and no PATH lookup. Its harness key is `vinculum`; `omp` is read as a legacy spelling of the same thing (`isVinculumSession`, `ALLOWED_HARNESSES`, the telemetry enum), and an old `harness: "omp"` meta is rewritten to `vinculum` on first read. There is **no OMP binary to fetch**: `scripts/dev-fetch-omp.sh` and the `omp:fetch`/`omp:check` npm scripts survive as packaging leftovers, and `npm run omp:fetch` is never needed for `tauri dev`.

Terminal (`no-harness`) and Vinculum sessions differ by transport, not by spawn: a Terminal row is a real PTY (`src/terminal.ts`), a Vinculum row is `rpc` (`sessionState().transport`).

## Daemon (Vinculum) — persistent sessions

- **What it is.** `alinery-vinculum-daemon` is a Bun/TypeScript program (`alinery-app/src-tauri/vinculum-daemon/`, agent runtime pi-durable) and the only daemon sidecar (`check-experimental-daemon-names.sh`). There is no `alineryd` or `runner` crate. It has one listener, `<repo>/.alinery/rpc[-ns].sock`, speaking `alinery.v1` (gRPC over a unix socket, bearer token); the JSON-lines wire is retired. The old name survives in a few Rust helpers (`alineryd_socket_namespace`, `resolve_alineryd_path`) and in `alinery-core/src/legacy_daemon.rs`, which only observes and stops a daemon of protocol 38 or older (plan O23 a); delete it when no supported release speaks that. The Rust workspace is the app and `alinery-core`.
- **The thick daemon.** The wire is `proto/alinery/v1/*.proto` (admin, sync, entities, terminal, blobs, jobs and one service per domain: tasks, drafts, sessions, executions, artifacts, playbooks, git, subtasks, settings and `RepoService`, backups, chat, agent, providers). `proto/gen` is checked in and regenerated with `npm --prefix proto run gen` (`buf generate` plus `buf lint`); `proto/golden` is the bytes the shell's hand-written messages are tested against, from `(cd proto && bun golden.ts)`; `check-proto-gen.sh` fails on drift in either. Layout of `vinculum-daemon/src/`: `rpc/` is thin handlers (auth, validation, mapping errors), `domain/` the logic, `platform/` the only place that touches the OS (`fs.ts` atomic and durable writes, `git.ts`, `lock.ts`, `process.ts`, `log.ts`, `telemetry.ts`, `keepawake.ts`, `zip.ts`), `jobs/` the backup, purge and storage jobs, `sync/` the store, `mcpServer/` the `--mcp` mode and `hostService/` the `--host-service` mode. A file the daemon writes goes through `platform/fs.ts` (`check-daemon-fs-writes.sh`; exceptions with a reason in `daemon-fs-writes-ok.txt`).
- **Sync.** State reaches clients as entities: `SyncService.Subscribe` streams a scope's snapshot and then changes, each with a cursor (`epoch` plus `seq`) so a client resumes or resubscribes. The store folds the filesystem watcher, reconcile passes and engine events into entities. A mutation carries `MutationMeta` (client id plus a per-call id) so the daemon dedupes a retry. The frontend keeps one replica per repo and scope (`src/sync/replica.ts`, read through `src/sync/hooks.ts`) and calls the services through `src/sync/*.ts`; it keeps no poller for daemon state.
- **Auth.** Every request carries a bearer token. The shell creates the per-start token, writes it to a 0600 file and passes `--rpc-secret-file`; the daemon reads it and deletes the file before it listens, and the shell keeps its copy so a relaunched app reconnects. The peer is classified once at accept (`shell`, `other`, `ssh`, `rpc/auth.ts`). Capabilities: `VIEW`, `ACT`, `APPROVE`, `ADMIN`, and `AGENT`, which a minted token (`AdminService.MintToken`) carries and which is exactly the RPCs behind MCP's tools (`AGENT_RPCS`). A local peer that is not the app gets `VIEW` and `ACT` only; `APPROVE` and `ADMIN` need the app's own executable or, over ssh, the token. `Hello` and `Shutdown` (with `ShutdownOrigin`) are frozen once released so an old app can always ask any daemon what it is (`check-admin-wire-frozen.sh`).
- **The webview.** The page speaks gRPC-web to the daemon through the shell's bridge: `src/daemon/transport.ts` (`daemonTransport(repoKey)`) calls the `daemon_rpc` and `daemon_rpc_cancel` commands (`src/daemon_rpc.rs`), which carry bytes over h2 to the right daemon, local socket or ssh forward, and never decode a reply beyond `Hello`, `LiveSessions`, `Shutdown`, `EnsureRepoReady` and the hosted-inference write. The bridge is generic over the service path, so a new daemon RPC needs no new Rust command.
- Separate binary, spawned detached per active repo. Socket and lane-lock identities remain build-specific, but `.alinery/.repo-owner.lock` permits only one daemon owner across all lanes. Startup retains every discovered historical lane lock too; lock markers are permanent and never unlinked.
- **Automatic project adoption.** `alinery-core::repo_ownership` checks every previous daemon owner and all retained task records under the repository mutation lock before updating task ownership. A live owner, missing socket with held process lock, or unknown/unreadable ownership evidence blocks the whole project. Once all owners are stopped, opening the project adopts all retained tasks, including archived tasks, automatically. History, artifacts, output reservations, and completed work remain intact; interrupted execution ownership is not recovered and child shutdown is not inferred. There is no per-task transfer or simultaneous task-owning dev/prod coexistence.
- **Confirmed takeover.** Each reachable incompatible owner has an individual **Take over {repo}** action. App-only prepare/confirm/cancel commands bind a 120-second, single-use confirmation to native peer process incarnation and observed session impact; zero and unknown impact still require confirmation. Checked shutdown uses that exact bound stream; replacement waits for the selected socket and permanent lane lease to be released, then normal all-owner acquisition. Another owner requires separate confirmation. No forced kill or lock deletion. Per-repository lifecycle ordering covers attachment, polling, teardown, and takeover.
- **Owns every PTY.** The app proxies over the socket. Quit tears down nothing *unless the user says so*; relaunch reconnects and replays scrollback. **No code path automatically kills a live session** — exactly five deliberate teardown origins send `AdminService.Shutdown` (or, for a daemon of protocol 38 or older, its JSON `shutdown` through `legacy_shutdown`), each behind explicit user action: `stop_daemon` (Settings), `stop_remote_daemon` (the remote form of `stop_daemon`, reached through it and the conflict banner's Restart daemon; it waits for the host to release the socket, then starts the daemon from the runtime this app installed), `close_repo_daemon` (close repo — called by `remove_repo` and `close_all_repos`), `restore_backup` (for a remote repo it runs the host's restore inside `stop_remote_daemon`, which takes a `while_down` closure and restarts the daemon afterwards), and `confirm_repo_takeover_blocking` (only through the consumed confirmation command). Enforced by `scripts/tests/check-no-auto-session-kill.sh`.
- **Quit asks.** Closing the window raises a three-way dialog (`App.tsx` `onCloseRequested`): *leave sessions running* (default), *close all repos*, or *cancel*. Close-all never stops a remote repo: it disconnects its host (ssh ends) and the host's daemon and sessions keep running. `close_all_repos` latches `AppState.quitting` first so the poller cannot resurrect a daemon. Cmd+Q is not covered — macOS `applicationWillTerminate` keeps the leave-running behaviour.
- **`alinery-core`** holds Tauri-free logic the app consumes (paths, board projection, settings structs, the git spawn, HTTP, telemetry, credential sharing, the repo-ownership checks, `legacy_daemon.rs`) plus the Rust originals the conformance cases run. The daemon does not load it: its domain logic is TypeScript, and where Rust is the byte reference for a TypeScript port (config writer, playbook parser, ownership) the conformance cases hold the two equal (`alinery-app/src-tauri/conformance/`). Do not add a second parser of a daemon reply to the shell.
- **Wire protocol gate.** `alinery-core::PROTOCOL_VERSION` (`protocol.rs`) is the single source of truth, bumped **only** on op-set/wire changes — never for app releases. The wire is `proto/alinery/v1` plus `legacy_daemon.rs`, so a proto change bumps it too. `ensure_daemon` is one `Hello` and reuses a daemon only when **protocol and app-config identity both match** (a build mismatch is `BuildDrift`, never a stop); the poller and the remote supervisor use the same `Hello`. `scripts/tests/check-protocol-version-bump.sh` enforces the bump and `check-wire-parsing-boundary.sh` keeps the old wire inside `legacy_daemon.rs`. A genuinely wire-neutral refactor uses a commit-scoped `Protocol-Neutral: <why>` trailer.
- **Missing OMP.** Nothing to miss: the agent runtime is in-process, so there is no spawn that can fail closed on a missing binary. Terminal remains available. (A `bundled OMP not found` error belongs to a shell or daemon from before this branch.)
- **GUI ownership locks** (`.alinery/.alinery-app.lock`). Dev and production are mutually exclusive on one folder. Product ownership is flock-only: never a pid file.
- **Activity sidecar**: every session byte is appended to `sessions/<id>.scrollback`. Reattach replays that file from an offset (`rpc/terminal.ts`, `REPLAY_BYTES`); the daemon keeps no screen emulator.

In-app self-update embeds `scripts/lib/preflight.sh` (compile-time `include_str!`) and runs the same quiet-machine gate as the public CDN installer. The gate holds no RPC token, so against a current daemon it connects to `rpc.sock` (liveness), counts live sessions from the session metas, and ends the daemon with SIGTERM, which the daemon handles as its `Shutdown` teardown (a signal handler, not a sender of `Shutdown`); a daemon from before the single listener is still probed and stopped over its JSON-lines `alineryd.sock`. That installer script itself is not in this repo.

## Remote repositories (SSH)

A repo can live on another Linux machine. Its key is `alinery+ssh://<host-id>/<absolute path>` (`RepoRef` in `paths.rs`; `src/remoteRepo.ts` mirrors the parser), so `known_repos` and every frontend repo key keep working. Hosts are in `AppConfig.remote_hosts`; this computer is the fixed host `local` (`list_hosts` puts it first). Each host has an `onboarded` mark in the app config (`AppConfig.local_onboarded`, `RemoteHost.onboarded`; `set_host_onboarded` sets it, and the first read of an older file derives it from `known_repos`).

- **Transport.** `src/remote.rs` is the only place that spawns `ssh` (`check-ssh-spawn.sh`): one OpenSSH ControlMaster per host (sockets in `/tmp/alinery-<uid>/`), a unix-socket forward to each repo's daemon socket, and one stdio channel to the host service (`alinery-vinculum-daemon --host-service`). Disconnecting ends ssh processes only. It never sends `shutdown`, and removing a remote repo leaves its sessions running on the host. A host the user connected and did not disconnect is brought back when it drops, by `spawn_remote_supervisor` (waits 5, 10, 30, then 60 s; it only connects, and gives up on an unknown or changed host key or a refused login). `connect_and_attach` and `disconnect_host` take a per-host lock, and a successful connect emits `remote_host_connected` so a terminal that lost its stream rejoins.
- **Runtime.** The app bundles Linux runtimes (`alinery-app/src-tauri/resources/remote/<triple>.tar.gz` plus `manifest.json`; glibc, x64 and arm64) and installs one on connect to `~/.local/share/alinery-remote/runtime/<content-hash>/` on the host. A directory named by hash is never overwritten, so a daemon from an older app keeps its own runtime. `scripts/build-remote-runtimes.sh` builds them (needs Bun only; each archive holds the one `alinery-vinculum-daemon` executable and a `MANIFEST`; `--check` lists what is missing). `scripts/tauri.mjs` warns on an empty manifest and fails with `ALINERY_REQUIRE_REMOTE_RUNTIMES=1`. Rebuild after a change to `vinculum-daemon/` or `proto/`, or the live tests run stale code.
- **Host layout.** `~/.local/share/alinery-remote/config/<app-config identity>/` holds the host's `app.toml`, `provider-credentials.json`, `custom-providers.json`, `inference.json`, `rpc-secrets/` and `logs/`, owner-only. The `app.toml` is an allowlist rendered by `render_remote_app_toml`; add a field only when a host process reads it, and never copy a Mac-private setting into it.
- **Provider sign-in and the model list** are the host daemon's `ProviderService` (`rpc/providers.ts`), not shell commands: a remote repo signs in on its host and lists that host's models (`src/sync/providers.ts` picks the daemon). Every call that touches a credential is ADMIN; the browser stays in the shell (the page opens an `auth_url` event with `open_url`).
- **Host service.** What a host needs while no daemon runs (claim a repo, browse and classify a folder, `git init`, write a settings file, merge credentials, verify and restore a backup, wait for a daemon to go, start one) goes through `alinery-vinculum-daemon --host-service`: a long-lived stdio process, one ssh channel per host, holding each claimed repo's `.alinery-app.lock` for as long as the channel lives. Its messages are `proto/alinery/v1/host.proto`, framed `[u32 BE length][message]`, after a `alinery-host-service/1` line. The Rust side is `HostOp` and `HostChannel` (`src/host_wire.rs`, `src/remote.rs`); the TypeScript side is `vinculum-daemon/src/hostService/`. These are not daemon ops, so they need no `PROTOCOL_VERSION` bump (the installed runtime is the app's exact build). A new request goes into `host.proto`, the regenerated `proto/gen`, `golden.ts`, both sides' tests and `HostOp`. Domain work on a remote repo is the daemon's RPCs over the forward, never a host request.
- **Moving a command to remote.** A daemon call by repo key already reaches a remote repo's daemon through the forward, so most new work is a daemon RPC and a `src/sync/*.ts` call. Add a `HostOp` only for work that must run with no daemon (`host.proto`), with its logic in `alinery-core`. A shell command that resolves its repo with a local-only helper (`active_repo()`, `target_repo_for_app`, `validate_known_target_repo`) must route a remote repo (`RepoRef`, `owned_target`, `active_repo_ref()`) or be listed, with a reason, in `scripts/tests/remote-local-only.txt` (`check-remote-routing.sh`). `check-remote-offload.sh` fails when a command that reaches a remote call is not async or never offloads: a remote call waits on ssh, so on the main thread it freezes the window, and on a runtime worker it ties one up. Terminal input goes through the bridge's stream, not a shell command.
- **Approvals.** Over a forward the daemon's peer is sshd, so the daemon is given an RPC secret (`--rpc-secret-file`, deleted when read) and the app keeps its copy in `<app_config_dir>/rpc-secrets/<hash>.secret`. A daemon this app did not start has no kept token, and approvals fail closed.
- **Remote storage and backups.** The daemon's `BackupService` and storage jobs do the work on the host's own disk with the host's own settings. Only verifying an archive and restoring it are host requests (`BackupVerify`, `BackupRestore`), because a restore runs while the daemon is down. A remote repo's backup destination is a host path typed in Settings and checked by the host's daemon (`BackupService`). The automatic triggers run in the daemon (`jobs/autoBackup.ts`), gated by the host's own trigger flags, so they also run while the app is closed.
- **A daemon this app cannot use.** If the host's daemon speaks another protocol or was started with other settings, `attach_remote_repo` records a `DaemonConflict` instead of failing, so the repo still opens and shows only its banner. Daemon-backed commands answer "restart it from the banner" (`remote_daemon`), and `DaemonConflictBanner` offers *Restart daemon…* (confirmed, names the live sessions), which runs `stop_daemon` → `stop_remote_daemon`. A remote daemon is never taken over, only restarted.
- **Credentials are chosen, never implied.** Each host has a `RemoteSharing` record: what it may receive, and what the app has placed there. A new host receives nothing until the user has chosen. Browser sign-ins (`oauth`) are never copied, because their refresh tokens rotate and two copies sign each other out; the host signs in for itself, and a sync never touches a sign-in made there. Do not send a credential-like value to a host without an item for it in the sharing list.
- **UI.** The setup screen (`views/SetupScreen.tsx`) is where a repo is added, opened or created, on this computer or on an ssh host: the full window when `shouldShowSetup` (`setup.ts`) says so (no repo, or every known repo remote and the open one's host `gave_up`: failed with nothing left to retry it, never a link that is merely down), a dialog from Add repository otherwise. "Add SSH connection" (`src/AddSshHostDialog.tsx`) saves a host and can test it first (`remote_test_host`, which installs nothing); the probe's refusals are typed (`Refusal` in `remote.rs`, `host-refused: <json>`), so the screen shows the fix for each kind. `folderSetup.ts` (`openFolderAsRepo`) is the only caller of the classify and init commands, local or remote. `RemoteModal` is only the reconnect dialog for a repo whose host dropped. `RemoteCredentials.tsx` holds the credentials choices. Onboarding (playbooks, models, first task) runs after a repo opens on a host whose onboarded mark is not set.
- **Testing.** Unit tests are in `src/tests/remote.rs`. The `live_*` tests need an sshd and skip without one: `scripts/tests/remote-sshd/run.sh start` builds a throwaway Debian sshd in Docker and prints the `ALINERY_TEST_SSH_ARGS` line to export; then `cargo test -p alinery-app --lib -- tests::remote::live`; then `run.sh stop`.

## Playbooks

Bundled playbooks live in `alinery-app/src-tauri/playbooks/` with the registry in `playbooks.default.toml`. Default playbook is **superdevelop** (clarify → investigate → decide → plan → define-tests → build → prepare-review). `{{ARTIFACTS_DIR}}` and related tokens are substituted at spawn. Custom overlays go in the target repo's `playbooks.toml`. This is **not** the old compiled-in RPI six-prompt set. The playbook library is the daemon's `PlaybookService` (the `playbook/*` entities; one TypeScript parser in `vinculum-daemon/src/domain/playbookLibrary.ts`, held equal to the Rust parser by the conformance cases). Execution is the standalone `playbook-engine/` package (TypeScript, `bun test` there), which the daemon embeds (`domain/executions.ts`).

## App crate layout (`alinery-app/src-tauri/src/`)

`lib.rs` is the crate root: shared `use`s, the module list, and `run()` with `generate_handler!`. Each module is `pub(crate)` and glob-imported at the root. Tests live in `src/tests/<module>.rs`, not a single `tests.rs`.

| Module | Owns |
|---|---|
| `paths.rs` | active-repo cell, ownership claims, repo/task/session/artifact path builders |
| `state.rs` | `AppState`, `RepoDaemon`, `RepoReservation`, `ClosingGuard`, the managed MCP child record |
| `app_config.rs` | `AppConfig`/appearance prefs, known-repo list, repo switching/removal, the repo and attachment pickers |
| `settings.rs` | global (app-level) settings, model favorites, `shell_quote`; the repo's `config.toml`, `harnesses.toml` and effective settings are the daemon's `SettingsService` |
| `task.rs` | local-file reads for the page (`read_local_file`, `chat_file_stat`) and `ping`; tasks, drafts, attachments and the board are the daemon's `TaskService`, `DraftService`, `BlobService` and the `board` entity |
| `session.rs` | hosted-inference refresh before a session opens (`prepare_hosted_inference`) and the close-all exited-session acks; session CRUD, terminals and history are the daemon's `SessionService`, `TerminalService` and `BlobService` |
| `daemon.rs` | `Hello`-based `ensure_daemon` and `classify_hello`, lane routing, teardown origins, the 5s poller |
| `daemon_rpc.rs` | the h2 bridge to a daemon's `rpc[-ns].sock`: `Hello`, `LiveSessions`, `Shutdown`, `EnsureRepoReady`, the stream bridge |
| `pi_durable.rs` | starting Vinculum (the poller calls it when nothing answers `Hello`) |
| `host_wire.rs` | the host service's messages (`host.proto`) as hand-written prost types, and their framing |
| `remote.rs` | SSH hosts: destination parsing, probe, runtime install, ControlMaster, host-service channel, credential sharing, `~/.ssh/config` aliases |
| `chat.rs` | which repos Chat may use and the turn controls; the rail, thread writes and attachments are the daemon's `ChatService` |
| `hosted.rs` | hosted Alinery models: catalog, credits, mint/revoke against the accounts service |
| `vinculum_customizations.rs` | the Finder window and skill picker of the agent directory (the directory itself is the daemon's `AgentService`); declared in `lib.rs` as `mod agent_customizations` |
| `community_playbooks.rs` | community catalog, preview, mine, remote status, package download, publish (the import registry is the daemon's) |
| `mcp.rs` | managed MCP child lifecycle and status |
| `notify.rs` | notification sound + attention notifications |
| `backup.rs` | the backup-destination picker and restore, the one step that runs while no daemon does (creating, listing and the automatic triggers are the daemon's `BackupService`) |
| `git_ops.rs` | the GitHub pull-request lookup (`lookup_task_pull_request`); re-exports `alinery_core::git_cmd`. Commit, push, worktree removal and the compare URL are the daemon's `GitService` |
| `connections.rs` | GitHub browser login plus Linear OAuth PKCE |
| `imports.rs` | Linear and GitHub issue fetch (the page passes the repo's origin URL and token override) |
| `account.rs` | pairing / account chip |
| `update.rs` | CDN manifest poll, download+sha256 verify, detached swap helper |
| `omp_update.rs` | the hosted default model role write into this machine's agent directory |
| `telemetry.rs` | opt-in usage events (fire-and-forget wrapper over `alinery_core::record_event`) |

A new command goes in the module that owns its data; `lib.rs` only gains a name in `generate_handler!`. Most new work is not a command at all: it is a daemon RPC (`proto/alinery/v1`, `vinculum-daemon/src/rpc/` and `domain/`) called from `src/sync/*.ts`.

## Commands (Rust Tauri)

The shell keeps 79 commands, all of them local-machine work or provisioning. Everything about a repository's tasks, sessions, artifacts, playbooks, git, backups, settings and providers is a daemon RPC. `lib.rs` `generate_handler!` is the list; `check-ipc-commands.sh` ties it to `src/ipc.ts`.

- Bridge: `daemon_rpc`, `daemon_rpc_cancel` (the webview's only path to a daemon), `daemon_status`, `ping`
- App config and repos: `read_app_config`, `write_appearance`, `list_hosts`, `set_host_onboarded`, `set_active_repo`, `remove_repo`, `pick_repo_dialog`, `classify_picked_folder`, `init_picked_folder`, `pick_attachment_files_dialog`, `read_local_file`, `chat_file_stat`
- Daemon lifecycle (the five teardown origins and their prerequisites): `prepare_repo_takeover`, `confirm_repo_takeover`, `cancel_repo_takeover`, `stop_daemon`, `close_all_repos`, `cancel_quit`, `restore_backup`, `pick_backup_destination_dialog`
- Remote: `remote_hosts`, `remote_add_host`, `remote_ssh_aliases`, `remote_describe_destination`, `remote_test_host`, `remote_discard_host`, `remote_sharing`, `remote_set_sharing`, `remote_connect`, `remote_disconnect`, `remote_list_dir`, `remote_classify`, `remote_init`, `remote_add_repo`, `remove_remote_repo_keep_running`
- Settings that are this machine's: `read_global_settings`, `write_global_settings`, `read_model_favorites`, `set_model_favorite`, `grok_key_ready`
- Sessions on this machine: `list_chat_repos`, `prepare_hosted_inference`, `notify_session_attention`, `notify_test`, `set_dock_badge_count`
- Playbook community (network half): `list_community_playbooks`, `community_remote_status`, `download_community_source`, `preview_community_playbook`, `list_my_community_playbooks`, `publish_community_playbook`
- Agent directory (Finder and picker half): `open_vinculum_agent_dir`, `pick_vinculum_skill_dialog`
- Connections and import: `connection_statuses`, `connect_github`, `connect_linear`, `disconnect_linear`, `import_linear_for_repo`, `import_github_for_repo`, `lookup_task_pull_request`
- Account and hosted models: `account_status`, `account_refresh`, `account_sign_in`, `account_cancel_sign_in`, `account_sign_out`, `account_open`, `account_open_plans`, `account_credits`, `hosted_catalog`
- MCP child: `mcp_status`, `start_mcp_server`, `stop_mcp_server`
- Update: `check_update` (never Err; silent no-offer), `download_update`, `apply_update` — prod-only

MCP is the daemon binary's `--mcp` mode (`alinery-app/src-tauri/vinculum-daemon/src/mcpServer/`): every tool is a call on the repository's daemon over its RPC socket with a minted AGENT token (`AdminService.MintToken`; `AGENT_RPCS` in `rpc/auth.ts` is exactly the RPCs behind the tools), and it writes nothing in `.alinery/` itself. A harness's MCP gets `ALINERY_RPC_SOCKET` and `ALINERY_RPC_TOKEN` from its daemon; the shell's managed MCP (`--mcp --serve --managed`, `src/mcp.rs`) and a host's stdio config read the app's owner-only `mcp-endpoints.json`, and only the managed one offers `alinery_send_review_handoff`. MCP session tools: `alinery_create_session` / `alinery_start_session` / `alinery_session_status` / `alinery_read_session_history`. MCP never exposes attach/write/resize/detach/kill/resume/takeover/bulk operations, and a mismatch never triggers teardown.

## Frontend Views (no router)

`useState` switch: Task list, Grid, Task detail, Session (xterm.js). Reuse `<SessionTerminal>` everywhere.

**Never use `window.confirm` / `alert` / `prompt`.** `tauri_plugin_dialog::init()` injects an init script that replaces them: `window.confirm` becomes **async**, so `if (!window.confirm(msg)) return;` tests a Promise (always truthy) and the destructive action runs with no dialog. Every confirmation goes through `alinery-app/src/confirm.tsx`: `await confirmDanger(...)` for yes/no, `await askConfirm({choices, defaultKey})` when there are more than two answers. Default focus is the safe choice, never the danger button. Guarded by `scripts/tests/check-no-window-confirm.sh`.

## Engineering rules

- Smallest diff that solves the requested problem. No speculative traits, registries, or abstractions.
- Git = `alinery_core::git_cmd` only (in the daemon: `platform/git.ts`, the one place that spawns it; `check-daemon-git-spawn.sh`). Never `Command::new("git")`. `git_cmd` uses a real git on this process's PATH when there is one (macOS `/usr/bin/git` does not count until the Command Line Tools are installed — that binary is a stub and running it raises a dialog). Otherwise it uses the alongside tree (`/Applications/Alinery.git/bin/git`, or `~/.local/share/alinery/git/bin/git` on Linux) and sets `GIT_EXEC_PATH` so HTTPS push can find `git-remote-https`. `scripts/git-pin.txt` pins the official tarball the release build compiles; `install.sh` copies that tree only when the app would not already see a git. `tauri dev` keeps using the system git. `ALINERY_GIT_PATH` is a dev/test override, not a PATH search.
- `time` is pinned to `0.3.51` in `Cargo.lock` — never un-pin (`cargo update` breaks the Tauri v2 build).
- Do not infer correctness from editor state or partial compiles. See "Build & Compile Verification". Do not launch the app to verify unless the user asks.
- Quit must never kill harnesses **on its own** — the daemon outlives the app on purpose. Teardown inside the app is explicit only (the five origins above).
- **DRY: one behaviour, one home — and the comment lives with it.** Second copy = extract. Extract from *observed* repetition, never anticipated repetition. Comments explain *why*, and only in the canonical place.

## Build & Compile Verification (mandatory)

After **any** Rust change in `alinery-app/src-tauri/src/` or `alinery-core/`:

```bash
cd alinery-app/src-tauri
cargo check -p alinery-app
```

Do **not** consider the change done until this passes. For sidecar/bundler work (`copy-sidecar.sh`, `tauri.conf.json`, `externalBin`), also run the copy script. A change in `vinculum-daemon/src` is TypeScript: run `bun test` in `alinery-app/src-tauri/vinculum-daemon/` (the tests sit beside the source as `*.test.ts`). A change under `proto/alinery/` needs `scripts/install-proto.sh --with-dev` once (`check.sh` runs it; it also links `alinery-proto` for the daemon and the app), then `npm --prefix proto run gen` (`buf generate` plus `buf lint`, rewriting `proto/gen`), `(cd proto && bun golden.ts)` (rewriting `proto/golden`), `bun test` in `proto/`, `./scripts/tests/check-proto-gen.sh`, and a `PROTOCOL_VERSION` bump. A change in `playbook-engine/` needs `bun test` there.

Live GUI verify is opt-in only, when the user asks to see the app. There is nothing to fetch first: the agent runtime is the daemon's own pi-durable conversation, and no OMP binary is spawned or resolved from PATH.

`npm run tauri dev` and `npm run tauri build` also compile `alinery-vinculum-daemon` beside the app executable they are about to run, by invoking `scripts/dev-fetch-bun.sh --no-download` for the launch's cargo profile. Its agent runtime is pi-durable. The launch never reaches the network for a toolchain, and a missing Bun or a failed compile only prints a line. Run the script bare to fetch the pinned Bun and compile by hand; it short-circuits an up-to-date output.

## App version bump (marketing semver)

There is no bump script in this repo. Bump first, commit, push. This is **not** `alinery-core::PROTOCOL_VERSION` — that integer moves only on wire/op-set changes. Cutting the GitHub Release and publishing `cdn.alinery.ai` is done from `alinery-deploy`, which **reads** these versions and will not write them.

Edit **all six** of these, to the same `X.Y.Z`:

| File | What to change |
|---|---|
| `alinery-app/package.json` | `"version"` |
| `alinery-app/package-lock.json` | both `"version"` keys (root **and** `packages[""]`) |
| `alinery-app/src-tauri/tauri.conf.json` | `"version"` |
| `alinery-app/src-tauri/Cargo.toml` | `[package] version` |
| `alinery-app/src-tauri/alinery-core/Cargo.toml` | `[package] version` |
| `alinery-app/src-tauri/Cargo.lock` | `version` on the **two workspace packages only**: `alinery-app` and `alinery-core` |

**Gotchas:** TOML has no trailing commas. Do not `replace_all` the old semver inside `Cargo.lock` (third-party crates can share that string). After the edit, run `cargo metadata --manifest-path alinery-app/src-tauri/Cargo.toml --format-version 1 --no-deps` (or `cargo check -p alinery-app`) so the lockfile still parses.

## Testing & Linting

**One command decides whether a change is good:**

```bash
./scripts/check.sh            # everything
./scripts/check.sh --quick    # skips the slow behavioural suites
```

It covers biome, both typecheck passes, vitest, the omp-extension suite (a stub that passes: the OMP runner is gone), `bun test` for `proto/`, the daemon and `playbook-engine/`, `cargo fmt`/`clippy`/`test --workspace`, and the product shell gates. `cargo check -p alinery-app` is the fast inner-loop gate while editing; `check.sh` is the one that must pass before you call a change done.

**Two traps that will hand you a false green:**

- **`cargo test` alone runs a third of the suite.** `default-members = ["."]` in `src-tauri/Cargo.toml` means a bare `cargo test` builds only the app crate. Always `cargo test --workspace`.
- **`cargo test`/`clippy` need the sidecars.** On a fresh clone the tauri build script fails with `resource path alinery-vinculum-daemon-<triple> doesn't exist`. Run `src-tauri/scripts/copy-sidecar.sh debug` first — `check.sh` does.

**TypeScript:** Biome is the formatter *and* the linter (`alinery-app/biome.jsonc`). There is no Prettier and no ESLint. Warnings do not fail the gate.

**Where a new test goes:**

| What you changed | Test goes |
|---|---|
| Pure TS logic | `alinery-app/src/<module>.test.ts`, beside the source |
| Daemon logic, RPC handlers | `vinculum-daemon/src/**/<module>.test.ts`, beside the source (`bun test`); a handler test serves the real service on a real socket |
| A port that must stay byte-equal to Rust | a case under `alinery-app/src-tauri/conformance/` run by both sides |
| A React component | same |
| Rust logic in the **app crate** | `src-tauri/src/tests/<owning-module>.rs` |
| Rust logic in another crate | that crate's `#[cfg(test)] mod tests` |
| Cross-process / real-daemon behaviour | `<crate>/tests/` |
| An invariant no runtime test can reach | a new `scripts/tests/check-*.sh` source guard |

**The IPC rule:** `@tauri-apps/*` is imported by `alinery-app/src/ipc.ts` and nowhere else. Calling a command means adding a typed wrapper there. Enforced by `check-ipc-boundary.sh` and `check-ipc-commands.sh`.

## `scripts/tests/` — shell-level gates

These run from `scripts/check.sh`. Source guards also run under `--quick`; the behavioural suites do not.

- `check-git-env-scrub.sh` — no raw `Command::new("git")` outside `alinery-core/src/git.rs`
- `check-daemon-git-spawn.sh` / `daemon_git_spawn_test.sh` — the daemon spawns git only from `vinculum-daemon/src/platform/git.ts`
- `check-daemon-fs-writes.sh` — every daemon file write goes through `platform/fs.ts`; exceptions with a reason in `daemon-fs-writes-ok.txt`
- `check-proto-gen.sh` — `proto/gen` and `proto/golden` equal a fresh regeneration from `proto/alinery`
- `check-admin-wire-frozen.sh` / `admin_wire_frozen_test.sh` — `buf breaking` on `admin.proto` and `common.proto` against the last release tag that has `proto/` (skips when none does)
- `check-ssh-spawn.sh` — `ssh` is spawned only from `src/remote.rs`, and the remote path kills no process by name or signal
- `check-remote-routing.sh` — every repo-resolving command routes remote repos or is listed in `remote-local-only.txt`
- `check-remote-offload.sh` — every command that reaches a remote call is async and reaches `off_main_thread`/`spawn_blocking`, or is listed with a reason in `remote-offload-ok.txt`
- `check-blocking-commands.sh` — blocking user commands are async and reach `spawn_blocking`
- `check-experimental-daemon-names.sh` — `externalBin` is `alinery-vinculum-daemon` alone (MCP and the host service are modes of it); no `alineryd` or runner
- `check-no-curl.sh` — HTTP is `alinery_core::http`, never a `curl` child
- `check-no-auto-session-kill.sh` — `ShutdownOrigin` (and `legacy_shutdown`) callers stay on the five-name allowlist
- `check-no-window-confirm.sh` — no `window.confirm|alert|prompt` in `alinery-app/src`
- `check-protocol-version-bump.sh` / `check-wire-parsing-boundary.sh` / `protocol_gate_test.sh` — wire protocol (a change under `proto/alinery/` bumps `PROTOCOL_VERSION`; the old JSON-lines wire stays inside `alinery-core/src/legacy_daemon.rs`)
- `check-ipc-boundary.sh` / `check-ipc-commands.sh` — IPC seam
- `check-omp-no-path-fallback.sh` / `omp_lib_test.sh` / `dev_fetch_omp_test.sh` / `install_omp_place_test.sh` — packaged OMP. The gates still run; they guard install/packaging bytes for a binary this branch's daemon never spawns (`scripts/dev-fetch-omp.sh` is not invoked by `check.sh`).
- `git_lib_test.sh` / `dev_fetch_bun_test.sh` — the git and Bun fetch helpers
- `no_auto_session_kill_test.sh` — the self-test of the teardown allowlist gate
- `check-telemetry-privacy.sh` / `check-connection-status-never-decrypts.sh`
- `preflight_test.sh` / `preflight_live_test.sh` — installer/updater quiet-machine helpers in `scripts/lib/preflight.sh`
- `updater_swap_test.sh` — in-app swap helper

`remote-sshd/` is not a gate: it is the Docker sshd the live remote tests run against (see Remote repositories).

Signing, CDN, droplet, and `install.sh` prompt tests are **not** in this repo.

## References

- `README.md` — product overview and `tauri dev`
- `alinery-app/src-tauri/playbooks/` — bundled playbook prompts
- `alinery-app/src-tauri/playbooks.default.toml` — playbook registry
