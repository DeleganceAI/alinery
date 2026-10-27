# Thick daemon plan: the Bun daemon becomes the application

Status: living draft v0.5, 2026-10-27. No product code is built yet. The P0 spikes ran on 2026-10-27 (Bun 1.4.3, darwin-arm64): their code, numbers and rerun commands are in `docs/thick-daemon-spikes/` (its `README.md`), and their results are folded into this doc. The work lands on branch `remote-daemon` and grows [PR #154](https://github.com/DeleganceAI/alinery/pull/154), which stacks on [PR #135](https://github.com/DeleganceAI/alinery/pull/135) (`experimental-pi-durable-as-a-harness`) (O16).

Supersedes: the repo-service `RepoOp` channel as the long-term wire, and items P2 to P7 of `docs/remote-repos-performance.md` (subscriptions replace every poller those items tuned). What already shipped on this branch stays and is reused: A1 to A6, P1 and B1 in `docs/remote-repos-todo.md` (ssh master and forwards, runtime install, credential sync, the ui secret, the repo-service). The repo-service is the bridge this plan retires one domain at a time.

Background: `docs/remote-daemon-architectures.md` (architecture B is the one chosen).

## How to use this doc

- **Decided**: the user made the call. Change it only with the user.
- **Working assumption (WA)**: a default chosen so work can start. Cheap to change; a session that finds it wrong says so and moves it to Open.
- **Open**: needs a decision. Options are listed; the session named beside it gathers the evidence.
- **UNCONFIRMED**: a fact from research that nobody has checked on this machine yet. Part 4.2 lists them all.

Every session in Part 3 ends the same way: update its status line, move resolved Open items to the decision log (4.1), add a changelog line (4.5). A session is one PR-sized change that passes `./scripts/check.sh`.

**Rule for implementers: no silent decisions.** If a session finds a fact that contradicts a WA, an Open item, a Decided row or a sketch's behaviour, or needs a choice this doc doesn't make about architecture (what owns what, what is stored where, who can do what, what the user sees change), it stops, writes the finding into the session, and asks the user. Choices inside one module (names, helper shape, file split) are the implementer's. Each session's **Accept** lines are the commands a reviewer runs; a session is done only when each gives its stated result.

---

# Part 1: High-level plan

## 1.1 Goal

One application, the Bun daemon, owns every business rule and all repo state on the host where the repo lives (this Mac or a remote Linux box). The client is the desktop app's webview, the Tauri UI we have today (D8): it renders a synced replica of the daemon's data and sends intent commands. MCP is a second, headless client of the same services (O18). The Rust desktop shell provisions daemons (local spawn, or install and start over ssh), bridges the webview to them, and does the OS jobs a host-side process can't do for this Mac (dialogs, notifications, keychain, browser sign-in, updates).

## 1.2 Decisions taken

| Id | Decision | Source |
|---|---|---|
| D1 | Architecture B: the TypeScript daemon is the application. | User, 2026-10-26 |
| D2 | Protobuf describes every client-to-daemon message, as gRPC-style services, on every transport (unix socket, ssh forward, WebSocket or HTTPS, in-process). | User, 2026-10-26 |
| D3 | All business logic that can move to the daemon moves. | User, 2026-10-26 |
| D4 | Protocol bumps are free for this work; no shipped users depend on the wire. | User, earlier in this branch |
| D5 | The UI talks only to the daemon, except for daemon setup and OS-only jobs. | User, 2026-10-26 |
| D6 | Host tools the daemon spawns (git today) are not shipped to a remote host. The setup wizard probes for them and, when one is missing, stops and tells the user to install it on that host first. | User, 2026-10-27 |
| D7 | A client needs a connected, compatible daemon to work on a repo. There is no browsing from files without one (O19). | User, 2026-10-27 |
| D8 | The Tauri UI is the only client this plan makes work with the new daemon. Web and iOS clients are out of scope (S6.1 to S6.3 and O13 of v0.3 are withdrawn). P6 builds the daemon setup screen instead: with no daemon to connect to, the UI offers to set up a local repo or to add an ssh remote first; both end with the user picking a repo. | User, 2026-10-27 |
| D9 | A host and a daemon are set up separately. This Mac is always a host and needs no set-up; a remote host is added over ssh. The user picks a host, then a repo on it to add, open or create, and that repo gets its daemon (one per repo, O4). The first daemon on a host runs the onboarding steps there (playbooks, models and providers, first task); a repo on a host that has run a daemon before goes straight to its board. | User, 2026-10-27 |

## 1.3 Invariants that survive the move

These hold in every phase. A session that has to break one stops and asks.

1. **No automatic session kill.** Teardown stays explicit and enumerable. Today `scripts/tests/check-no-auto-session-kill.sh` allows five senders of `shutdown`: `stop_daemon`, `close_repo_daemon`, `restore_backup`, `confirm_repo_takeover_blocking`, `stop_remote_daemon`. In the new wire they become the `ShutdownOrigin` enum on `AdminService.Shutdown` (2.1), and the gate checks the enum's callers.
2. **One owning daemon per repository** (`.alinery/.repo-owner.lock`). Lock marker files are never unlinked.
3. **One git spawn site with the env scrub.** Today `alinery_core::git_cmd`; in the daemon, `platform/git.ts`, with a gate like `check-git-env-scrub.sh`.
4. **Files are the truth** (WA, see O3). `.alinery/` stays readable and git-friendly, and agents keep writing artifacts straight to disk.
5. **Crash safety is not weaker than Rust's.** Atomic and durable writes, 0700 and 0600 permissions (2.3.2).
6. README is human-edited, telemetry stays opt-in, no `window.confirm`.

## 1.4 Where we are (measured 2026-10-26)

**Daemon** (`alinery-app/src-tauri/vinculum-daemon/src`): about 4,000 non-test lines in 15 modules. The largest are `main.ts` 1,180, `tasks.ts` 468, `mcp.ts` 412, `graph.ts` 393, `runtime.ts` 224, `terminal.ts` 210. It speaks JSON lines, one op per connection (`createServer` at `main.ts:1075`), `PROTOCOL = 24` (`main.ts:26`, matching `alinery-core/src/protocol.rs:15`). Auth is a peer-executable check for `ui_control`, plus the ui secret from `--ui-secret-file` over ssh (`main.ts:80-97`, constant-time `uiSecretMatches`). It already uses `bun:ffi` in three places: libc for the socket peer checks (`main.ts:679` on macOS, `:703` on Linux), `libalinery_core` for keep-awake (`main.ts:223`) and `alinery_pi_acquire` (`:253`), and `libalinery_core` again in `tasks.ts:40` for task provisioning, subtasks and session naming. Dependencies: chord, pi-ai and pi-durable 1.4.0, `playbook-engine` (a `file:` package), `smol-toml`.

**Playbook engine** (`playbook-engine/`): 1,434 lines of TypeScript. Executions are a fold over an append-only `engine.jsonl` (`state.ts`); events carry no sequence number or timestamp.

**Rust**: `alinery-core` 34,391 lines, app crate 17,151 non-test lines, `mcp/src` 2,641 lines.

**Frontend**: `ipc.ts` 574 lines, `types.ts` 1,142 lines, 66 test files that mock `ipc.ts` (53 of them through `src/test/mockIpc.ts`), and about 30 polling loops (2.2.11 maps them).

**Tauri commands: 241**, classified by what each one really does:

| Class | Count | Meaning | Fate |
|---|---|---|---|
| DOMAIN | 102 | Reads or writes repo state | Moves to the daemon |
| PROXY | 36 | Forwards to the daemon | Deleted; the client calls the daemon |
| SHELL | 47 | OS or this-Mac job | Stays in Rust |
| PROVISION | 21 | Starts, connects or installs daemons | Stays in Rust |
| MIXED | 28 | Several of the above in one command | Split (rules in 2.3.4, which moves two chat DOMAIN commands here, making 30) |
| STUB | 7 | Return "OMP process sessions are not available" | Deleted in S0.6 |

Per module: task 25 (D17 P2 S3 M3), session 43 (D11 P22 M6, 4 stubs), chat 27 (D11 P10 S1 M2, 3 stubs), artifacts 25 (D25), daemon 10 (P2 PV4 S1 M3), remote 14 (PV11 S3), app_config 8 (S4 PV3 M1), settings 16 (D8 S7 M1), playbook 9 (D9), community_playbooks 8 (D1 S3 M4), account 9 (S9), connections 4 (S4), imports 4 (S2 M2), git_ops 11 (D10 M1), backup 6 (D4 S1 M1), notify 3 (S2 M1), mcp 3 (PV3), update 3 (S3), omp_update 3 (D2 S1), subtask 4 (D1 M3), vinculum_customizations 6 (D3 S3).

**Remote plumbing on this branch**: `RepoRef {Local, Remote{host_id, path}}` (`paths.rs:12-47`) keyed as `alinery+ssh://<host-id>/<abs path>`; `remote_call` (`remote.rs:1249`) sends one of 96 `RepoOp` variants (`alinery-core/src/repo_service.rs:25-565`) to `alinery-mcp --repo-service` on the host; daemon ops go through an ssh-forwarded socket. Gates `check-remote-routing.sh` and `check-remote-offload.sh` track which commands are routed.

**App-side state and workers**: `AppState` (`state.rs:29-72`) is all lifecycle, provisioning and routing state. The one piece of business state in the app is the backup queue (`backup.rs:43-61`, 250 ms poll, 2 s debounce). Background loops: daemon poller (`daemon.rs:1432`, 5 s), Pi supervisor (`pi_durable.rs:77`, 5 s, duplicates the poller's spawn path), remote supervisor (`remote.rs:1671`, 1 s tick), hosted-token refresh (`session.rs:458`, 30 min), terminal stream pump (`daemon.rs:450`/`488`, 8 ms or 16 KiB frames).

**Defects the move fixes instead of porting**:

| Id | Defect | Where |
|---|---|---|
| R1 | `addExecution` read-modify-writes `execution.json` with no lock and no revision, while Rust writes the same file under `.alinery/.task-mutation.lock` (`lockfile.rs:127`, a process mutex plus a repo flock). Also `tasks.ts:200` maps with `.map(projectExecution)`, so the array index lands in `autoApproveAll` and every execution after the first reports permission `automatic` | daemon `tasks.ts:291-296`, `:200` |
| R2 | Two execution state machines: `execution.json` and the `engine.jsonl` fold | daemon and playbook-engine |
| R3 | Same rule implemented twice, differently: current step (`board.rs:166-171` vs the engine fold), playbook parsing, settings precedence (`sessionControls.ts:75-123` vs `settings.rs`) | Rust and TS |
| R4 | Writes that are not crash-safe (plain `writeFileSync`, no temp file and rename) | `main.ts:295`; `tasks.ts:295`, `:324`, `:361`, `:383`, `:402` |
| R5 | Telemetry credentials hardcoded at `alinery-core/src/telemetry.rs:21-22` | handoff, not this plan |
| R6 | Dead Rust: `playbook_scheduler.rs` (3,018 lines, used only by one `subtask.rs` test) and the 7 stubs | `alinery-core`, app crate |
| R7 | No push: every view polls | frontend |
| R8 | One request per connection; auth only on `ui_control` | daemon wire |

## 1.5 End state

```
+------------------------------+
| Desktop webview (Tauri UI)   |
| sync client (D8)             |
+--------------+---------------+
               | alinery.v1 (Connect, protobuf) through the shell
               | bridge, then a unix socket or an ssh forward
               v   HOST (local or remote)
+--------------------------------------------------------------+
| DAEMON (Bun): the application, one per repo (assumed)        |
|  +--------------------------------------------------------+  |
|  | Transport adapters + RPC router + auth (Hello)         |  |
|  +--------------------------------------------------------+  |
|  +--------------------------+  +--------------------------+  |
|  | Sync engine              |  | Session runner           |  |
|  | store, changelog,        |  | PTYs, pi-durable,        |  |
|  | Subscribe, cursors       |  | transcripts              |  |
|  +--------------------------+  +--------------------------+  |
|  +--------------------------------------------------------+  |
|  | Domain modules (TypeScript)                            |  |
|  | tasks, executions, sessions, artifacts, comments,      |  |
|  | chat, playbooks, settings, git, subtasks, storage      |  |
|  +--------------------------------------------------------+  |
|  +--------------------------+  +--------------------------+  |
|  | Playbook engine          |  | Jobs + workers           |  |
|  | state in execution.json  |  | backup, scans, purge     |  |
|  +--------------------------+  +--------------------------+  |
|  +--------------------------------------------------------+  |
|  | Platform: atomic writes, flock, git spawn, fs watcher  |  |
|  +--------------------------------------------------------+  |
+------------------------------+-------------------------------+
                               v
+--------------------------------------------------------------+
| .alinery files (the truth) + in-memory index                 |
+--------------------------------------------------------------+

+----------------------+
| Desktop shell (Rust) |   provisions daemons (local spawn, ssh
| provision, OS, bridge|   install), dialogs, notifications,
+----------------------+   keychain, browser sign-in, updates
```

- **The client** (the Tauri UI, D8) keeps a replica per scope (repo, task, session, chat), sends unary commands, and opens streams for terminals, transcripts and blobs. It reaches the daemon only through the shell bridge (T3 over T1 or T2). MCP calls the same services headless (O18).
- **The daemon** is one Bun process per repo (O4, decided) with six areas: `rpc/` (transports, router, auth), `sync/` (store, changelog, subscriptions, watcher), `domain/` (all business rules), `runtime/` (today's session runner: PTYs, pi-durable, transcripts), `jobs/` (slow work in child processes), `platform/` (atomic writes, flock, git spawn).
- **Files** under `.alinery/` stay the truth; the store is an in-memory index rebuilt at start (WA, O3).
- **The shell** keeps about 70 commands (SHELL 47, PROVISION 21, the shell halves of MIXED) plus one bridge command. It holds no business state.

## 1.6 Phases

| Phase | Outcome | Exit check |
|---|---|---|
| **P0** Contract, cleanup, spikes | `proto/` with buf and generated TS; dead code gone; R1 fixed; spikes answer O1, O2, O3, O6, O7 and the watcher choice | `buf lint` green; spike notes in 4.1; check.sh green |
| **P1** RPC host and transports | The daemon serves `alinery.v1` on a second socket next to the JSON-lines one; the shell bridges the webview to it, locally and over the ssh forward; `Shutdown` carries its origin | A webview call reaches a local and a remote daemon through the bridge; auth rejects a bad token |
| **P2** Sync engine core | Store, changelog, `Subscribe`; fed by commands, a file watcher plus reconcile, the session runner, engine events and jobs | A replica built from `Subscribe` equals the store after random commits, restarts and dropped streams |
| **P3** Client library and first slices | `src/sync/` replica and hooks; session status, transcript, terminal and board reads move to subscriptions and streams | The pollers for those views are deleted; their Tauri commands are deleted |
| **P4** Domain ports | One domain per session moves its writes into TypeScript, with conformance fixtures from the Rust goldens | Each session deletes its Tauri commands, `RepoOp` variants and core code |
| **P5** Shell slimming | JSON-lines wire, `daemon_client.rs`, `repo_service`, the daemon's `libalinery_core` FFI gone; MCP and host bootstrap settled (O10, O15) | The shell is SHELL plus PROVISION plus the bridge; AGENTS.md rewritten |
| **P6** Setup screen | Hosts and daemons set up separately (D9): this Mac is always a host, a remote host is added over ssh; the user picks a host, then a repo on it, and that repo's daemon starts. The first daemon on a host runs the onboarding steps; later repos on that host open straight onto their board | On a fresh app config the UI opens on the setup screen; the local flow and the ssh flow each end on the picked repo's live board, through onboarding the first time on that host and without it the second time |
| **P7** Hardening | Keeper and brain split (O5), memory and metrics, upgrade while sessions run | Upgrading the daemon keeps sessions alive |

Order: transport and sync come before domain ports, so each port lands straight onto subscriptions. Reads move before writes: the watcher keeps the store right while Rust still writes a domain's files, so the UI can switch to subscriptions before the write path moves.

## 1.7 Open decisions

| Id | Question | Options | WA | Decided by |
|---|---|---|---|---|
| O1 | RPC flavour on Bun | (a) Connect-ES on `node:http` (Connect and gRPC-Web over HTTP/1.1; gRPC too, since `node:http2` works under Bun 1.4.3); (b) `@grpc/grpc-js` server (real gRPC, HTTP/2 only, browsers need a proxy); (c) protobuf messages in our own length-prefixed framing over any byte stream | (a), spike-backed (4.1 S0.2): ready to confirm | S0.2 |
| O2 | Webview to daemon | (a) Tauri command plus `Channel` proxy, shell forwards bytes to the socket; (b) daemon loopback TCP plus a token; (c) custom URI scheme handled by the shell | (a), spike-backed except the live webview (4.1 S0.3): ready to confirm | S0.3 |
| O3 | Source of truth | (a) files plus in-memory index; (b) SQLite as truth, files as export; (c) files plus a SQLite index cache | (a), scan numbers in 4.1 (S0.7 spike) | S0.7 |
| O4 | Daemon per repo or per host | (a) per repo, as today; (b) per host, many repos | **Decided (a)**, with no per-host daemon: the user picks a repo before onboarding, so provider set-up runs through that repo's daemon (D9, todo B2 answered) | User, 2026-10-27 |
| O5 | Keeper and brain | (a) one process; (b) small keeper holds PTYs and scrollback, restartable brain holds the rest | (a) until P7 | S7.1 |
| O6 | flock from Bun | (a) `bun:ffi` to libc `flock(2)` (libc is already dlopened); (b) `flock(1)` child holding the lock (Linux only, macOS has no `flock(1)`); (c) no file lock once Rust stops writing (needs a lock during the strangler period anyway) | (a) | S0.5 |
| O7 | Where slow work runs | (a) child process of the same binary, `--job <kind>`; (b) Bun `Worker` (experimental per Bun docs; a crash takes the daemon) | **Decided (a)**: slow work runs in a child process | User, 2026-10-27 |
| O8 | Terminal input over the bridge (a `fetch` has no request stream, so no bidi) | (a) split: `Attach` server stream plus unary `Write` with `input_seq`; (b) WebSocket tunnel with a bidi frame stream | (a), measure | S3.4 |
| O9 | Keep-awake | (a) keep the IOKit FFI; (b) `caffeinate -w <pid>` on macOS, `systemd-inhibit` on Linux | (b) | S4.11 |
| O10 | MCP server for agents | (a) Rust `alinery-mcp` becomes a thin client of the new RPC; (b) the Bun binary gets an `--mcp` stdio mode that calls the daemon socket | Open | S5.1 |
| O11 | Zip for backups | (a) `fflate` in a job child (writes no zip64: an archive caps at 4 GiB or 65,535 entries); (b) the host's Info-ZIP `zip` and `unzip`; (c) split a backup into archives under the cap; must write and read today's `-v1.zip` | **Decided (b)**, `fflate` goes. If (b) fails S4.9's compatibility test, stop: (c) is the user's named fallback | User, 2026-10-27 |
| O12 | Agent dir placement (`omp_update`, `vinculum_customizations`) | (a) per host, daemon owns it, shell mirrors the Mac's copy; (b) Mac only, shell owns and pushes | Open | S4.10 |
| O13 | Pairing and the door for web and iOS | | **Withdrawn** 2026-10-27 (D8): no web or iOS client | |
| O14 | One execution state machine | (a) `engine.jsonl` fold is the truth, `execution.json` goes; (b) `execution.json` is the truth, the fold feeds it | **Decided (b)**: execution state lives in `execution.json`, not in the log (S4.2) | User, 2026-10-27 |
| O15 | Host bootstrap without a daemon | (a) keep `alinery-mcp --repo-service` for host-only ops (ListDir, Classify, Init, ClaimRepo, SpawnDaemon, WriteConfigFiles, MergeCredentials, WaitDaemonGone); (b) a `--host-service` stdio mode of the Bun binary, so the host runtime carries no Rust (no zig cross-build) | Open | S5.2 |
| O16 | What happens to PR #154 | (a) merge as is: remote repos work now through the repo-service, and this plan replaces it later; (b) keep it open and land the thick daemon on top | **Decided (b)**: the plan lands on `remote-daemon` and becomes PR #154, stacked on PR #135 | User, 2026-10-27 |
| O17 | Telemetry for ported commands (consent and ingest credentials live in the shell) | (a) the shell emits after `Applied`, with ids read from the replica entity, through one new allowlisted shell command; (b) the daemon returns a telemetry hint in `Applied` and the shell records it under its consent; (c) the daemon sends directly, with consent passed at spawn (a remote host would then hold the ingest credentials, R5) | **Decided (c)**: the daemon sends its own events when it can reach the ingest URL, best effort, and drops a failed send silently. Consent reaches it through `app.toml`. Events with no repo stay in the shell (S4.1) | User, 2026-10-27 |
| O18 | Capabilities for MCP's 21 tools beyond the four session tools, once they go through the daemon | (a) MCP holds a token passed at spawn and gets VIEW and ACT, like any local peer that isn't the shell (2.1.10); tools that need ADMIN (`alinery_storage_info`, `alinery_delete_archived_storage`) leave MCP; (b) a new capability that lists exactly the tools MCP exposes today, so no tool changes; (c) MCP keeps AGENT only and drops the other 21 tools | **Decided (b)**: MCP is a headless, AI-first client of the daemon, connecting like the desktop (T1 or T2) from any machine. Its token grants AGENT, exactly the RPCs behind its tools, storage scan and purge included; never `Shutdown` or approvals. "From any machine" was dropped for now by O20 (c) | User, 2026-10-27 |
| O19 | Reading a repo whose daemon is down, incompatible, or owned by another app instance (today the board reads files directly, `README.md:87`) | (a) the board needs a compatible daemon; such a repo shows only the conflict banner and its explicit restart; (b) the shell starts this app's daemon binary in a read-only mode beside the owner: it takes no ownership lock, runs no sessions, serves VIEW only from the files; (c) keep the Rust board reads for this case only | **Decided (a)** (D7) | User, 2026-10-27 |
| O20 | How MCP gets AGENT, now that O13 (pairing) is withdrawn and O18 says "from any machine" | (a) socket access is the credential: a request with no token on T1, or on a T2 forward the user opened, gets AGENT. The socket is 0600 and only the same OS user reaches it; any agent running as that user could also read a minted token from a harness's environment, so on the host a token adds no boundary. (b) minted tokens (today's WA in S5.1): the daemon puts one in each harness's environment, the shell mints one for its managed MCP through `AdminService.MintToken` (ADMIN), and an MCP on another machine needs a token the user copies from the shell. (c) as (b), but MCP runs only on the daemon's host or as the shell's managed MCP; "from any machine" is dropped | **Decided (c)**, for now | User, 2026-10-27 |
| O21 | Execution records the old Rust runner wrote, with no engine state (the trace could not confirm any exist) | (a) a one-time converter at daemon start makes engine state for them; (b) they show as finished history, read-only, and never run again; (c) they are seeded again, as `graph.ts:300` does today (a task created with start requested would rerun from its root steps, inferred) | **Decided (b)** (S4.2) | User, 2026-10-27 |
| O22 | How `alinery_send_review_handoff` reaches the second repo's daemon (it writes into another repo, `main.rs:906`), now that MCP holds a token for its own daemon only (O20 c) | (a) only the shell's managed MCP offers the tool, since the shell holds a token for every daemon it has open; an MCP inside a harness answers that the tool needs the app's MCP; (b) MCP asks its own daemon, which calls the target repo's daemon on the same host with a host-wide credential (a 0600 file in the host config dir) accepted for that one RPC; (c) the tool leaves MCP and the handoff is done from the UI | Open | S5.1 |

## 1.8 Migration rules (strangler)

1. **Second socket, old wire untouched.** The daemon serves `alinery.v1` on `rpc[-ns].sock` beside `alineryd[-ns].sock` until P5. Nothing on the old wire changes except to delete.
2. **One writer per domain at any time.** Before a domain's port session Rust writes its files; after it, only the daemon does. The session flips every write path of the domain in one PR. Two known exceptions, both under the shared flock (rule 3): `alinery-mcp` keeps writing settings, task creation, the playbook library and the pre-archive backup until S5.1, and five Rust modules keep writing execution state after S4.2 until their own ports (P4 intro, S4.2).
3. **Shared locks while two languages can touch one file.** Where Rust and TypeScript can both write (for example `execution.json`, `task.md`), both take the same flock (interop test in S2.2).
4. **Reads before writes.** A domain's read model (parser plus derived fields) lands first and is fed by the watcher, so the UI can subscribe before the write path moves.
5. **Conformance fixtures.** A port session turns the Rust tests for its domain (the inline `#[cfg(test)]` modules, `execution_tests.rs`, `alinery-core/tests/`) into fixture directories with expected JSON, runs them against Rust and TypeScript, and keeps them as TypeScript tests after Rust is deleted.
6. **Each port deletes what it replaced**: Tauri commands, `ipc.ts` wrappers, `RepoOp` variants, core functions with no callers, entries in `remote-local-only.txt` and `remote-offload-ok.txt`.
7. **Every command answers with its cursor** (`Applied`), so the client knows when its subscription shows the change.
8. **Protocol**: `PROTOCOL` moves whenever the op set changes (D4). `buf breaking` stays off: every client ships in this repo (D8), and a daemon of another protocol is a conflict with an explicit restart, as today.

---

# Part 2: Specs

## 2.1 Protocol and transports

### 2.1.1 Package layout (WA)

```
proto/
  buf.yaml
  buf.gen.yaml
  package.json              # name "alinery-proto", a file: package like playbook-engine
  alinery/v1/
    common.proto            # Cursor, MutationMeta, Applied, ErrorDetail
    admin.proto             # Hello, Shutdown, Stats
    sync.proto              # Subscribe and its frames
    entities.proto          # Entity and every entity message
    terminal.proto          # Attach, Write, Resize, Detach
    blobs.proto             # ranged reads, chunked uploads
    jobs.proto              # Job entity, Start, Cancel
    tasks.proto sessions.proto chat.proto artifacts.proto playbooks.proto
    settings.proto git.proto subtasks.proto storage.proto
  gen/                      # protoc-gen-es output, checked in
```

The daemon and the app both depend on `alinery-proto`. Generated code is checked in (WA) so `bun build --compile`, vitest and `tsc` work without buf installed; a gate (S0.1) regenerates and fails on a diff.

```yaml
# proto/buf.yaml
version: v2
modules:
  - path: .
lint:
  use: [STANDARD]
breaking:
  use: [FILE]
```

```yaml
# proto/buf.gen.yaml
version: v2
plugins:
  - local: protoc-gen-es
    out: gen
    opt: [target=ts]
```

Connect-ES v2 has no separate `protoc-gen-connect-es`: one `protoc-gen-es` (2.16.0) emits messages and service descriptors, with `@bufbuild/protobuf` 2.16.0 at runtime. Spike result (S0.1): the default `import_extension` (none) resolves under `bun run`, `bun build --compile`, `tsc --noEmit` with `moduleResolution: "bundler"` (the app's setting) and Vite 7.3.6, so `buf.gen.yaml` sets nothing. `@bufbuild/buf` 1.75.0 as a pinned devDependency puts the buf binary in `node_modules/.bin`, so `buf generate` and `buf lint` run offline after install; no `npx`, no system install.

**Naming (buf STANDARD lint, checked in the spike).** Every RPC has its own `<Rpc>Request` and `<Rpc>Response`, also for streams. All messages share the package `alinery.v1`, so an RPC name carries its entity (`RenameTask`, `ReadBlob`, `CancelJob`), which keeps message names unique. A write's response embeds `Applied applied = 1`; there is no shared response message.

### 2.1.2 Common messages

```proto
// proto/alinery/v1/common.proto
syntax = "proto3";
package alinery.v1;

// Position in one daemon's change stream. A cursor from another epoch is stale.
message Cursor {
  string epoch = 1;  // random per daemon start
  uint64 seq = 2;    // last change the holder has applied
}

// Every write carries one. A repeat of the same pair gets the first answer back.
message MutationMeta {
  string client_id = 1;    // random per client start
  string mutation_id = 2;  // unique within client_id
}

// Every write answers with the cursor that contains its effect (migration rule 7).
// Each write RPC's own <Rpc>Response embeds it as `Applied applied = 1`.
message Applied {
  Cursor cursor = 1;
}

// Attached to every error as a Connect error detail.
message ErrorDetail {
  string code = 1;     // stable machine code: "task_not_found", "repo_busy", "remote_daemon"
  string message = 2;  // human text, safe to show
  map<string, string> fields = 3;
}
```

### 2.1.3 Admin

```proto
// proto/alinery/v1/admin.proto
service AdminService {
  rpc Hello(HelloRequest) returns (HelloResponse);
  rpc Shutdown(ShutdownRequest) returns (ShutdownResponse);
  rpc Stats(StatsRequest) returns (StatsResponse);  // P7
  rpc MintToken(MintTokenRequest) returns (MintTokenResponse);  // S5.1 (O20 c)
}

message HelloRequest {
  string client_id = 1;
  string client_kind = 2;  // "desktop", "mcp"
  uint32 protocol = 3;
}

// Needs ADMIN. Only CAPABILITY_AGENT can be minted; anything else is INVALID_ARGUMENT.
// The token is 32 random bytes, hex; it lives in memory and dies with the daemon.
message MintTokenRequest { Capability capability = 1; string label = 2; }  // label: for the log only
message MintTokenResponse { string token = 1; }

message HelloResponse {
  uint32 protocol = 1;
  string build_id = 2;
  string epoch = 3;
  repeated Capability capabilities = 4;
  string repo_root = 5;
  string app_config_identity = 6;  // ensure_daemon reuses only on protocol and identity match
}

enum Capability {
  CAPABILITY_UNSPECIFIED = 0;
  CAPABILITY_VIEW = 1;     // read entities, read-only terminal attach
  CAPABILITY_ACT = 2;      // commands, terminal input
  CAPABILITY_APPROVE = 3;  // approvals, auto-approve
  CAPABILITY_ADMIN = 4;    // Shutdown, daemon-wide settings
  CAPABILITY_AGENT = 5;    // MCP: the four session tools until S5.1, then exactly the RPCs behind its tools (O18 b)
}

// Invariant 1: the only ways to stop a daemon. UNSPECIFIED is rejected.
enum ShutdownOrigin {
  SHUTDOWN_ORIGIN_UNSPECIFIED = 0;
  SHUTDOWN_ORIGIN_STOP_DAEMON = 1;
  SHUTDOWN_ORIGIN_CLOSE_REPO = 2;
  SHUTDOWN_ORIGIN_RESTORE_BACKUP = 3;
  SHUTDOWN_ORIGIN_CONFIRMED_TAKEOVER = 4;
  SHUTDOWN_ORIGIN_STOP_REMOTE = 5;
}

message ShutdownRequest {
  ShutdownOrigin origin = 1;
  string confirmation_id = 2;  // CONFIRMED_TAKEOVER only
}

message ShutdownResponse {
  uint32 sessions_stopped = 1;
}
```

`Hello` needs any one capability, so every credential in 2.1.10 can call it and learn what it holds. It is also the liveness probe. A successful socket connect proves nothing over a forward (today's lesson in `remote.rs`); a `Hello` round-trip does.

### 2.1.4 Sync

```proto
// proto/alinery/v1/sync.proto
service SyncService {
  rpc Subscribe(SubscribeRequest) returns (stream SubscribeResponse);
}

message SubscribeRequest {
  Scope scope = 1;
  Cursor cursor = 2;  // unset: start with a snapshot
}

message Scope {
  oneof kind {
    RepoScope repo = 1;        // board: tasks, drafts, execution summaries, daemon status, jobs
    TaskScope task = 2;        // one task: sessions, artifacts, comments, executions, attachments
    SessionScope session = 3;  // one session: status, attention, meta
    ChatScope chat = 4;        // chat threads and their sessions
  }
}
message RepoScope {}
message TaskScope { string slug = 1; }
message SessionScope { SessionRef session = 1; }
message ChatScope {}

message SubscribeResponse {  // one frame of the stream
  oneof frame {
    Snapshot snapshot = 1;
    Delta delta = 2;
    UpToDate up_to_date = 3;
    MustRefetch must_refetch = 4;
    Heartbeat heartbeat = 5;
  }
}

message Snapshot {
  repeated Entity entities = 1;
  Cursor cursor = 2;
  bool complete = 3;  // false: more Snapshot frames follow
}
message Delta { repeated Change changes = 1; Cursor cursor = 2; }
message UpToDate { Cursor cursor = 1; }
message MustRefetch { string reason = 1; }  // drop the replica, subscribe again with no cursor
message Heartbeat { Cursor cursor = 1; }

message Change {
  oneof op {
    Entity put = 1;
    string delete = 2;  // entity key
  }
}
```

```proto
// proto/alinery/v1/entities.proto
message SessionRef {
  string task_slug = 1;  // "" for taskless chat sessions, as the daemon's metaPath does today
  string id = 2;
}

message Entity {
  string key = 1;       // "<kind>/<task slug or _>/<id>", e.g. "session/fix-login/7f3a"
  uint64 revision = 2;  // seq of this entity's last change; the expected_revision for writes
  oneof value {
    Task task = 10;
    Draft draft = 11;
    Execution execution = 12;
    Session session = 13;
    Artifact artifact = 14;
    Comment comment = 15;
    ChatThread chat_thread = 16;
    Job job = 17;
    Settings settings = 18;
    DaemonStatus daemon_status = 19;
    Playbook playbook = 20;
    Attachment attachment = 21;
  }
}
```

Entity message fields start as copies of today's TypeScript types in `alinery-app/src/types.ts` (`BoardTask`, `SessionMeta`, the artifact and comment types), so views change little when they switch source. Each port session (P3, P4) defines its entity's fields.

### 2.1.5 Terminals, transcripts, blobs, jobs

```proto
// proto/alinery/v1/terminal.proto
service TerminalService {
  rpc Attach(AttachRequest) returns (stream AttachResponse);
  rpc Write(WriteRequest) returns (WriteResponse);
  rpc Resize(ResizeRequest) returns (ResizeResponse);
  rpc Detach(DetachRequest) returns (DetachResponse);
}

message AttachRequest {
  SessionRef session = 1;
  uint64 from_offset = 2;  // byte offset in sessions/<id>.scrollback; 0 means the kept tail
  uint32 cols = 3;
  uint32 rows = 4;
  bool read_only = 5;      // VIEW capability attaches read-only
}

message AttachResponse {  // one frame of terminal output
  oneof body {
    bytes data = 1;
    Exit exit = 2;
  }
  uint64 offset = 3;     // offset of the first byte of data
  string attach_id = 4;  // first frame only
  bool truncated = 5;    // from_offset was older than the kept scrollback
}
message Exit { int32 code = 1; string signal = 2; }

message WriteRequest {
  string attach_id = 1;
  uint64 input_seq = 2;  // the daemon applies writes per attach_id in this order
  bytes data = 3;
}
message ResizeRequest { string attach_id = 1; uint32 cols = 2; uint32 rows = 3; }
message DetachRequest { string attach_id = 1; }
message WriteResponse {}
message ResizeResponse {}
message DetachResponse {}
```

- **Replay is a file read.** The scrollback file is append-only and the daemon already replays its tail on attach (`terminal.ts:162`; `terminal.ts:2` says there is no vt100 frame). An offset turns reattach into "read from here", so a client that dropped for a second gets only what it missed.
- **Offset rules** (so client and daemon can't disagree):
  - An offset is a byte position in `sessions/<id>.scrollback`, counted from the file's first byte. The file only grows; nothing truncates or rotates it while the session exists.
  - `from_offset = 0` means "the tail": the daemon starts at `max(0, size - REPLAY_BYTES)` (`terminal.ts:7`), sets `truncated` when that is above 0, and the first frame's `offset` says where it started.
  - `from_offset > 0` starts exactly there. Above the current size is INVALID_ARGUMENT (the client is from another file, for example after a restore). Below `size - REPLAY_BYTES` is allowed: it is a file read, and the client asked for it.
  - Each frame's `offset` is the position of its first byte, and the next frame starts at `offset + data.length`. A client keeps `offset + data.length` of the last frame it rendered and reattaches from that.
  - Replay and live bytes meet without a gap or a repeat: the daemon reads the file up to the size it saw when it registered the live listener, and live frames start at that size. The registration and the size read happen in the same tick.
  - Bytes are cut anywhere, including inside a UTF-8 sequence or an escape sequence; xterm handles split writes.
- **Input order lives in the daemon.** `input_seq` replaces the app-side ordered worker `queue_terminal_op` (`session.rs:684`). The daemon buffers an out-of-order write until the gap fills (WA: give up after 2 s and apply in arrival order, logging it).
- **Pi sessions** have transcripts, not just bytes:

```proto
// in sessions.proto
service SessionService {
  // CreateSession, StartSession, RenameSession, ArchiveSession, KillSession, ResumeSession: unary, MutationMeta first (S4.4)
  rpc WatchTranscript(WatchTranscriptRequest) returns (stream WatchTranscriptResponse);
}
message WatchTranscriptRequest { SessionRef session = 1; uint64 from_item = 2; }
message WatchTranscriptResponse {
  repeated TranscriptItem items = 1;  // fields defined in S3.3 from today's transcript type
  uint64 next_item = 2;
  bool replace = 3;                   // true: items replace the client's copy from from_item on
}
```

- **Blobs** never take a path from the client. `BlobRef` names the thing (artifact, attachment, chat attachment) and the daemon resolves and checks the path, so a client can't read outside `.alinery/`.

```proto
// proto/alinery/v1/blobs.proto
service BlobService {
  rpc ReadBlob(ReadBlobRequest) returns (stream ReadBlobResponse);
  rpc BeginUpload(BeginUploadRequest) returns (BeginUploadResponse);
  rpc UploadChunk(UploadChunkRequest) returns (UploadChunkResponse);
  rpc CommitUpload(CommitUploadRequest) returns (CommitUploadResponse);
}

message BlobRef {
  oneof target {
    ArtifactBlob artifact = 1;                 // {task_slug, name}
    AttachmentBlob attachment = 2;             // {task_slug, name}
    ChatAttachmentBlob chat_attachment = 3;    // {thread_id, name}
    PlaybookPackageBlob playbook_package = 4;  // {upload_name}: a community package the shell downloaded (S4.10); staged only, never read back
  }
}
message ReadBlobRequest { BlobRef ref = 1; uint64 offset = 2; uint64 length = 3; }  // length 0: to the end
message ReadBlobResponse { bytes data = 1; uint64 offset = 2; uint64 total = 3; string content_type = 4; }

message BeginUploadRequest { MutationMeta meta = 1; BlobRef target = 2; uint64 size = 3; string sha256 = 4; }
message BeginUploadResponse { string upload_id = 1; uint32 chunk_size = 2; }  // WA 256 KiB
message UploadChunkRequest { string upload_id = 1; uint64 offset = 2; bytes data = 3; }
message UploadChunkResponse {}
message CommitUploadRequest { string upload_id = 1; }  // sha256 checked here, then atomic rename
message CommitUploadResponse { Applied applied = 1; BlobRef ref = 2; }  // ref: the final name (deduplicated)
```

Uploads are unary chunks because browsers and WebKit can't stream a request body. Staged chunks live in `.alinery/tmp/uploads/<upload_id>` and are cleared at daemon start.

```proto
// proto/alinery/v1/jobs.proto
service JobService {
  rpc StartJob(StartJobRequest) returns (StartJobResponse);  // {MutationMeta, oneof kind params}
  rpc CancelJob(CancelJobRequest) returns (CancelJobResponse);
}
message StartJobResponse { Applied applied = 1; string job_id = 2; }
message CancelJobRequest { MutationMeta meta = 1; string job_id = 2; }
message CancelJobResponse { Applied applied = 1; }

message Job {  // an Entity; progress arrives through Subscribe
  string id = 1;
  JobKind kind = 2;
  JobState state = 3;
  Progress progress = 4;  // {done, total, label}
  string error = 5;
  int64 started_at_ms = 6;
  int64 ended_at_ms = 7;
  oneof result {
    BackupResult backup = 10;
    StorageInfo storage = 11;
    PurgeResult purge = 12;
    ImportResult import = 13;
  }
}
enum JobState {
  JOB_STATE_UNSPECIFIED = 0;
  JOB_STATE_QUEUED = 1;
  JOB_STATE_RUNNING = 2;
  JOB_STATE_DONE = 3;
  JOB_STATE_FAILED = 4;
  JOB_STATE_CANCELLED = 5;
}
```

### 2.1.6 Domain services (pattern)

```proto
// proto/alinery/v1/tasks.proto
service TaskService {
  rpc CreateTask(CreateTaskRequest) returns (CreateTaskResponse);
  rpc RenameTask(RenameTaskRequest) returns (RenameTaskResponse);
  rpc ArchiveTask(ArchiveTaskRequest) returns (ArchiveTaskResponse);
  rpc RestoreTask(RestoreTaskRequest) returns (RestoreTaskResponse);
}

message ArchiveTaskRequest {
  MutationMeta meta = 1;
  string slug = 2;
  uint64 expected_revision = 3;  // 0: no check; a mismatch is ABORTED
}
message ArchiveTaskResponse { Applied applied = 1; }
```

Every write follows that shape: `MutationMeta` first, the target, an optional `expected_revision`, and its own `<Rpc>Response` with `Applied applied = 1` (2.1.1, naming). `docs/thick-daemon-spikes/proto/alinery/v1/tasks.proto` is a lint-clean example.

**What becomes an entity and what becomes an RPC.** State that several views show and that changes over time is an entity in the store, read only through `Subscribe`. A one-off computed answer (a diff, a compare URL, a dry run, a directory listing) is a unary RPC. No `List*` or `Get*` RPC exists for something that is an entity. A one-shot read (MCP, a CLI) is `Subscribe` with no cursor, read until the `Snapshot` frame with `complete = true`, then cancelled (WA).

**Errors** use Connect codes, each with an `ErrorDetail`:

| Code | When |
|---|---|
| INVALID_ARGUMENT | malformed request, bad slug |
| NOT_FOUND | task, session or artifact missing |
| ABORTED | `expected_revision` mismatch; the client refetches and retries |
| FAILED_PRECONDITION | state forbids it (task archived, session running) |
| PERMISSION_DENIED | missing capability |
| UNAUTHENTICATED | missing or wrong token |
| UNAVAILABLE | daemon shutting down, job runner busy |

### 2.1.7 The RPC host on Bun (O1)

Research facts that decide it:
- `Bun.serve` has no HTTP/2 response trailers, so it can't serve gRPC.
- Connect-ES 2.2.0 serves Connect and gRPC-Web over HTTP/1.1 through `node:http`. gRPC proper needs `node:http2`; the S0.2 spike served gRPC through `node:http2` on Bun 1.4.3.
- Over HTTP/1.1 Connect supports unary and server streaming; bidi needs HTTP/2.

| | (a) Connect-ES on `node:http` | (b) `@grpc/grpc-js` | (c) own framing |
|---|---|---|---|
| Runs on Bun | `node:http` handler (measured, 4.1 S0.2); gRPC through `node:http2` also works | needs `node:http2` (works) | any byte stream |
| Browser and WebKit | Connect over fetch, unary and server streaming | needs a proxy | WebSocket only |
| Bidi | HTTP/2 only | yes | yes |
| Codegen | `protoc-gen-es`, one plugin | separate generator | hand-written dispatch |
| Debug tools | curl (Connect JSON), buf curl, grpcurl if gRPC works | grpcurl | none |
| In-memory tests | `createRouterTransport` | no | hand-written |

WA (a). The plan needs no bidi call: terminals use the split form (O8 a), uploads are chunked. S0.2 measures it.

```ts
// vinculum-daemon/src/rpc/server.ts (sketch; working code: docs/thick-daemon-spikes/src/rpc-server.ts)
import { createServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { createContextValues } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";

export function serveRpc(socketPath: string, secret: Buffer, shellExe: string) {
  const handler = connectNodeAdapter({
    routes(router) {
      router.service(AdminService, admin);
      router.service(SyncService, sync);
    },
    // The interceptor sees only headers; contextValues sees the node request and its socket.
    contextValues: (req) => createContextValues().set(PEER, peerExecutable(req.socket as Socket)),
    interceptors: [authInterceptor(secret, shellExe)],
  });
  const http = createServer(handler);
  // Bun's node:http hides the socket fd, so a peer check on req.socket would always fail.
  // A node:net listener keeps the fd, and handing each socket to the HTTP server keeps it on req.socket.
  createNetServer((sock) => http.emit("connection", sock)).listen(socketPath);
}
```

Facts the S0.2 spike confirmed, which the sketch relies on:
- A server interceptor sees the request headers and can throw `Code.Unauthenticated` before the handler runs (HTTP 401 on the wire).
- `contextValues(req)` runs per request with the node request, so the peer check runs there and the interceptor reads it from `req.contextValues`.
- connect-node's `createConnectTransport({ httpVersion: "1.1", baseUrl: "http://daemon", nodeOptions: { socketPath } })` reaches the socket. curl does too (`--unix-socket`, Connect JSON).
- Client cancel aborts the handler's `ctx.signal`.

**Rule: every streaming handler wakes on `ctx.signal`.** A handler that awaits a timer or a queue must race it against the signal (`Promise.race([sleep, abortPromise(ctx.signal)])`), or an idle stream keeps its handler, and its memory, until the timer fires. The spike's `ticks` shows the pattern; S2.1's `Subscriber.frames` and S3.3's transcript watch follow it.

The shell bridge needs no protobuf client at all (2.1.9).

### 2.1.8 Transports

| Id | Transport | Who uses it | Notes |
|---|---|---|---|
| T1 | UDS `<repo>/.alinery/rpc[-ns].sock` | shell bridge for local repos, MCP on the daemon's host, tests | Same lane naming as `alineryd[-ns].sock`; 0600 |
| T2 | ssh `-O forward -L <local sock>:<remote rpc sock>` on the existing ControlMaster | shell bridge for remote repos (MCP does not use T2 for now, O20 c) | Reuses `remote.rs` masters and forward naming. Needs sshd `AllowStreamLocalForwarding`, which the probe already checks |
| T3 | Tauri bridge (O2) | desktop webview | The webview never opens a socket. The shell forwards HTTP/1.1 bytes to T1 or T2 |
| T7 | in-memory `createRouterTransport` | vitest and bun tests | replaces `mockIpc` for daemon calls (2.5) |

T4 to T6 (HTTPS, loopback TCP, iOS) were for web and iOS clients and are withdrawn (D8). The ids are not reused.

The protocol is the same on every row. Only the byte pipe changes.

### 2.1.9 The webview bridge (O2)

WA (a): one Tauri command proxies a Connect request to the daemon socket and streams the response back on a `Channel`.

```
webview: Connect client
  -> createConnectTransport({ baseUrl: "http://daemon", fetch: bridgeFetch(repoKey), useBinaryFormat: true })
  -> bridgeFetch: invoke("daemon_rpc", <request body bytes>, { headers: { x-alinery-rpc: {repo, call_id, path, headers}, x-alinery-channel: <channel> } })
shell:  daemon_rpc(request: tauri::ipc::Request, webview: Webview)
  -> body = request.body() (raw bytes); call = JSON of the x-alinery-rpc header
  -> channel = JavaScriptChannelId::from_str(<x-alinery-channel header>)?.channel_on(webview)
  -> resolve repoKey: local rpc.sock (T1) or the ssh forward (T2)
  -> add authorization header (the token never reaches the webview)
  -> hyper HTTP/1.1, one new connection per call, over UnixStream
  -> response chunks -> batched frames -> Channel messages
webview: bridgeFetch builds a Response with a ReadableStream body from the frames
```

Working code: `docs/thick-daemon-spikes/src/bridge-fetch.ts` (the webview half, plus a Bun stand-in for the shell) passes unary, error, streaming and cancel tests with a stock connect-web client; `docs/thick-daemon-spikes/bridge-rs/` is the shell half over hyper (4.1 S0.3).

- **The bridge is a `fetch`, not a protocol.** The Connect client is unchanged; `bridgeFetch` only moves bytes. That keeps one client code path for the webview (bridge) and tests (in-memory).
- **Request body and channel in one invoke.** A raw-body invoke (`invoke(cmd, Uint8Array, options)`) can't also carry a keyed `Channel` argument. The webview passes the channel in a header instead: Tauri's JS `Channel` serializes as `__CHANNEL__:<id>`, and the command takes `tauri::ipc::Request` plus `Webview` and calls `JavaScriptChannelId::from_str(..)?.channel_on(webview)`. Both are public API in Tauri 2.11.3 (re-exported at `tauri/src/ipc/mod.rs:39`). Read in the Tauri source, not yet run in a webview (4.2).
- **Frame format on the Channel:** `[u32 LE len][u8 kind][payload]`, where `len` counts the kind byte and the payload. Kinds: HEAD = 1 (status and headers as JSON), BODY = 2 (a response chunk), END = 3 (empty, or a transport error string). One Channel message holds one or more frames, then zeros up to at least 1 KiB; a zero length ends the message. The padding is because Tauri 2.11 sends raw channel bodies under 1 KiB (`MAX_RAW_DIRECT_EXECUTE_THRESHOLD`, `tauri/src/ipc/channel.rs:39`) through `webview.eval` as JavaScript array literals (`session.rs:384`). The TypeScript `encodeFrames` and Rust `encode_frame` in the samples are tested to give the same bytes.
- **Batching is mandatory.** Unbatched, a busy stream sent about 116,000 channel messages a second in the spike. The shell batches frames like `pump_session_stream` (`session.rs:401`): flush at 8 ms or 16 KiB, whichever comes first, and at END. `splitFrames` already reads several frames per message.
- **One HTTP/1.1 connection per call.** After a cancelled stream the daemon drops that connection, and a pooled reuse failed with ECONNRESET in the spike. A unix-socket connect costs microseconds (unary p50 through hyper was 0.076 ms with a new connection each call).
- **Cancel:** the `AbortSignal` calls `daemon_rpc_cancel(call_id)`; the shell aborts the call's task, which drops the connection, and the daemon's `ctx.signal` fires. **An abort before HEAD has arrived must reject the `fetch` itself**: the shell sends nothing more for a cancelled call, and Connect is still awaiting the `Response`. The sample's `abort()` does this; without it the cancel test hung.
- **Origin-form request line.** hyper's connection API sends the URI as given; an absolute `http://daemon/...` request line made the Connect router answer 404. Build the request with the path only and a `host` header.
- **Prior art:** connectrpc-tauri 0.1.6 does the same with JSON bodies. We use binary.

### 2.1.10 Auth and capabilities

- **Every request carries a bearer token**, over every transport, ssh included. R8 (auth only on `ui_control`) goes away.
- **The token is per daemon start.** The shell creates it, writes it to a 0600 file and passes `--rpc-secret-file` (the same mechanism as today's `--ui-secret-file`, `main.ts:80-97`); the daemon reads it and deletes the file before it listens. The shell keeps its copy under `<app_config_dir>` per repo and lane (0600), as `ui-secrets.json` does today, so a relaunched app can still talk to a daemon that outlived it. Compare in constant time (`uiSecretMatches`).
- **Capabilities by credential:**

| Credential | Capabilities |
|---|---|
| Shell token, local, and the peer executable is the shell | VIEW, ACT, APPROVE, ADMIN |
| Shell token over ssh (peer is sshd) | VIEW, ACT, APPROVE, ADMIN. The token is stored on the Mac only, never on the host, so host agents can't read it |
| Shell token, local, peer is something else | VIEW, ACT. On this Mac agents run as the same user and can read `<app_config_dir>`, so APPROVE and ADMIN keep today's peer-executable check |
| No token | AGENT, limited to the four MCP session tools (today's exposure) until S5.1, which deletes this row (O20 c) |
| Minted AGENT token (S5.1, O20 c): in each harness's environment, and the shell's managed MCP | AGENT |

**AGENT** is exactly the RPCs behind MCP's tools, storage scan and purge included. Never `Shutdown`, the rest of ADMIN, or APPROVE (O18 b). The v0.3 pairing-token row is withdrawn with O13 (D8).

APPROVE is never reachable from anything an agent on the host can read, so an agent can't approve its own step.

**Single OS user (WA).** Every row assumes the daemon, its socket and the agents it runs belong to one OS user, as today. Socket files are 0600 in a 0700 directory. A second OS user on the same host is not a client.

## 2.2 Sync engine

### 2.2.1 Entities

Repo and daemon status, task, draft, execution, session (meta, live status, attention), artifact metadata, comment, chat thread, attachment metadata, job, settings, playbook. Bytes (artifact bodies, attachments, scrollback, transcripts) are not entities; they come through `BlobService`, `TerminalService` and `WatchTranscript`.

### 2.2.2 Seq, epoch, revision

- **seq**: one monotonic uint64 per daemon process. Every commit takes the next one.
- **epoch**: a random UUID per daemon start. A cursor with another epoch gets `MustRefetch`, then a snapshot. Snapshots are small (one repo's metadata), so a restart costs one refetch per client.
- **revision**: the seq of an entity's last change. Writes may pass it as `expected_revision`.
- Nothing is persisted. The store rebuilds from files at start (O3 a).

### 2.2.3 Changelog

An in-memory ring of the last N changes (WA N = 10,000). A cursor older than the ring gets `MustRefetch`.

### 2.2.4 Subscribe flow

```
cursor unset, or epoch differs, or seq older than the ring
  -> Snapshot frames (chunked, last one complete=true) -> live Deltas
cursor current
  -> Deltas since cursor.seq (from the ring) -> UpToDate -> live Deltas
always
  -> Heartbeat after 15 s with nothing queued for this subscriber
```

- **The subscriber is registered and its snapshot or replay is taken in the same tick**, with no `await` between, so no commit falls between the two.
- **A heartbeat carries the store's current seq, and is sent only when the subscriber's queue is empty.** That moves a quiet scope's cursor past commits outside its scope, so the ring can roll over without forcing that client to refetch. With items queued, the next delta carries the cursor instead. The property test in `docs/thick-daemon-spikes/src/store.test.ts` pins this down: its last check needs the task-scope replica's cursor to reach the store's seq, which only a heartbeat can do.

### 2.2.5 Batching and backpressure

- One commit is one `Delta`. Per subscriber, deltas are coalesced over about 16 ms (one frame) before sending.
- Each subscriber has a bounded queue (WA 1,000 frames or 4 MB). On overflow the daemon drops the queue and sends `MustRefetch`. The store never waits on a slow client.

### 2.2.6 Scopes

Keys are `<kind>/<task slug or _>/<id>`. A scope is a filter over kind and slug:

| Scope | Includes |
|---|---|
| Repo | `task/*`, `draft/*`, execution summaries, `daemon/_/status`, `job/*`, `settings/*`, `playbook/*` |
| Task `{slug}` | every key whose slug is `slug` |
| Session `{ref}` | `session/<slug>/<id>` (attention is one of its fields) |
| Chat | `chat/*` and the sessions with slug `_` |

### 2.2.7 Mutations and optimistic UI

- **Dedupe:** the daemon keeps the last 256 `mutation_id`s per `client_id` with their answers, in memory, per epoch. A retry after a dropped response gets the first answer.
- **Optimistic overlay (client):** the client applies its own change locally, then drops the overlay once its subscription cursor reaches `Applied.cursor.seq`. On an error it drops the overlay and shows the error.
- **Conflicts:** `expected_revision` is optional. Use it where a lost update would hurt (rename, settings, comments); skip it for idempotent actions (archive).

### 2.2.8 What feeds the store

1. **Domain commands.** Each domain function writes files through `platform/fs` and then calls `store.commit`. The code that makes a change also reports it.
2. **File watcher plus reconcile.** Covers agents and Rust (during the strangler period) writing files directly. Watch `.alinery/tasks/**` and the config files (`config.toml`, `harnesses.toml`, `playbooks.toml`). Ignore `worktrees/`, `*.scrollback` (every PTY byte is appended there) and `.alinery/tmp/`. On an event, re-read the path, rebuild the entity, and commit only if protobuf-es `equals()` says it changed, so the daemon's own writes cost a re-read and no delta. A reconcile pass every 30 s (WA) stats every tracked file and re-reads what changed, which covers missed events. **The pass is async and batched** (`readdir` and `stat` from `node:fs/promises`, 256 at a time): on 1,075 tasks it took 42 ms with the longest event-loop gap 3.3 ms, and on 4,300 tasks 167 ms with a 5.4 ms gap (4.1, O3 scan). A synchronous pass would block the loop for its whole length. The watcher is a WA from S0.4: Bun `fs.watch` with `recursive: true` on `.alinery/tasks`, plus one non-recursive watch on `.alinery/` for the config files. On macOS it missed no op in 3,000, against Bun issues #44780 and #34160 too; Linux is S2.3's Accept. The handler re-reads and trusts no event's kind or path (S0.4 rules).
3. **The session runner.** Session start, exit, status and attention changes commit directly.
4. **Playbook engine events.** A hook after each engine event commits the execution entity (S2.4). From S4.2 the engine saves its state into `execution.json` (O14 b), and that save is the hook.
5. **Jobs.** The job runner commits job state and progress (throttled to about 4 per second).

### 2.2.9 Store sketch

```ts
// vinculum-daemon/src/sync/store.ts (sketch)
type Row = { revision: bigint; entity: Entity };

export class Store {
  readonly epoch = crypto.randomUUID();
  private seq = 0n;
  private rows = new Map<string, Row>();
  private ring: { seq: bigint; change: Change }[] = [];  // last RING_SIZE changes
  private subs = new Set<Subscriber>();

  // Synchronous on the event loop: no await between assigning seq and fanning out.
  commit(puts: Entity[], deletes: string[] = []): bigint {
    const changes: Change[] = [];
    for (const e of puts) {
      const prev = this.rows.get(e.key);
      if (prev && equals(EntitySchema, { ...prev.entity, revision: 0n }, { ...e, revision: 0n })) continue;
      changes.push(create(ChangeSchema, { op: { case: "put", value: e } }));
    }
    for (const key of deletes) if (this.rows.has(key)) changes.push(create(ChangeSchema, { op: { case: "delete", value: key } }));
    if (!changes.length) return this.seq;  // nothing changed: no seq taken, nothing sent
    const seq = ++this.seq;
    for (const c of changes) {
      if (c.op.case === "put") { c.op.value.revision = seq; this.rows.set(c.op.value.key, { revision: seq, entity: c.op.value }); }
      else this.rows.delete(c.op.value);
      this.pushRing(seq, c);
    }
    for (const sub of this.subs) sub.offer(seq, changes);
    return seq;
  }
}
```

Working code with tests: `docs/thick-daemon-spikes/src/store.ts` and `store.test.ts`. The property test runs 20 seeds of 400 random commits with dropped and resumed streams, queue overflow and ring rollover, and checks that each replica equals the store's rows in its scope with the same cursor. Measured cost of one commit: 0.8 µs with 1 subscriber, 2.4 µs with 10, 9.1 µs with 100; one task delta is 93 bytes on the wire (4.1, store spike).

```ts
// vinculum-daemon/src/sync/service.ts (sketch)
export const sync: ServiceImpl<typeof SyncService> = {
  async *subscribe(req, ctx) {
    yield* store.open(req.scope, req.cursor, ctx.signal);  // snapshot or ring replay, then live frames
  },
};
```

The index is built at start by scanning `.alinery/` with the same parsers the watcher uses.

### 2.2.10 Client replica

Lives in `alinery-app/src/sync/`. The `Replica` class at the end of `docs/thick-daemon-spikes/src/store.ts` is the tested core of `apply`; the property test drives it.

```ts
// alinery-app/src/sync/replica.ts (sketch)
export class Replica {
  cursor?: Cursor;
  stale = false;
  private rows = new Map<string, Entity>();
  private listeners = new Set<() => void>();

  apply(r: SubscribeResponse) { /* snapshot chunks: build, swap in on complete; delta: put/delete; up_to_date and heartbeat: move cursor; must_refetch: clear cursor */ }
  get = (key: string) => this.rows.get(key);
  listen = (fn: () => void) => (this.listeners.add(fn), () => this.listeners.delete(fn));
}

export function useEntity(replica: Replica, key: string) {
  return useSyncExternalStore(replica.listen, () => replica.get(key));
}
```

- `useEntities(replica, filter)` caches its array per replica version, because `useSyncExternalStore` needs a stable snapshot.
- A run loop resubscribes with backoff (0.5, 1, 2, 5 s) and passes the last cursor.
- While a connected repo's link drops, the replica keeps its last state, read-only, and sets `stale`; views show a banner over it (WA).
- A repo with no connected, compatible daemon has no replica. It shows only its banner: connect, or the explicit restart for a conflict (D7).
- No persistence on desktop.

### 2.2.11 Pollers that become subscriptions

Measured in `alinery-app/src` on 2026-10-26.

| Where | Today | Becomes |
|---|---|---|
| `TaskList.tsx:202`, `Kanban.tsx:116`, `Grid.tsx:919` | board `load()` every 3 s | repo scope |
| `Grid.tsx:1002` | `readTaskExecutions` | repo scope (execution entities) |
| `TaskDetail.tsx:580` | `refreshLiveTaskState` (task, artifacts, execution) | task scope |
| `CreateSessionPage.tsx:113` | `readTaskExecution` | task scope |
| `SessionView.tsx:298` | `refreshDisplay` | session scope |
| `SessionView.tsx:590` | `sessionStatus` every 1.5 s | session scope |
| `SessionView.tsx:605`, `:613` | `readTaskExecution` every 1.5 s | task scope |
| `SessionView.tsx:671` | `ipc.listTasks` (parent task) | repo scope |
| `SessionView.tsx:719`, `:736` | `listArtifactsWithMetadata`, `listTaskArtifactTree` | task scope |
| `SessionsList.tsx:239`, `:273` | `listSessionItems` (`:198`) every 3 s, `refreshStatuses` every 1.5 s (`listBoardTasks` at `:260` runs once, not polled) | repo scope plus session entities |
| `shared.tsx:1131`, `:1289` | `sessionStatus` every 1.5 s | session scope |
| `shared.tsx:1338` | `ipc.listTaskActivity` | repo scope |
| `TerminalDrawer.tsx:213` | `sessionStatus` | session scope |
| `ChatView.tsx:185` | `sessionListStatuses` | chat scope |
| `ChatView.tsx:300` | thread name re-read for a minute after a turn | chat scope (the title arrives as a delta) |
| `QuickChat.tsx:227` | thread list | chat scope |
| `useDaemonStatus.ts:50` | daemon status every 1.5 s | `DaemonStatus` entity; link state from the run loop |
| `Settings.tsx:354` | `probeLiveSessions` every 2 s | `DaemonStatus` entity per open repo |
| `Settings.tsx:518` | backup busy every 1 s | `Job` entity |

Stay shell-side: `ChatView.tsx:139` (the open-repo list is app config), `useMcpStatus.ts:87` (until O10), `useUpdateStatus`, `AccountMenu` credits, `providerAccess`, `RemoteModal`, `useRemoteHosts`.

## 2.3 Domain logic and workers

### 2.3.1 Daemon layout (WA)

```
vinculum-daemon/src/
  main.ts       # flags, start order, signals. Nothing else.
  rpc/          # server.ts, auth.ts, one file per service implementation
  sync/         # store.ts, service.ts, watcher.ts, reconcile.ts, parsers/
  domain/       # tasks, executions, sessions, chat, artifacts, comments, playbooks,
                # settings, git, subtasks, storage, backup, imports
  runtime/      # the session runner: PTYs, pi-durable, transcripts, MCP children
  jobs/         # runner.ts (parent side), child.ts (the --job entry), one file per kind
  platform/     # fs.ts, lock.ts, git.ts, process.ts, keepawake.ts
```

- `rpc/` is thin: check the capability, call one domain function, return `Applied`. No business rule lives there.
- `domain/` imports `platform/` and `sync/store`, never `rpc/`.
- `runtime/` imports neither `domain/` nor `rpc/`. It reports through callbacks wired in `main.ts`, so the keeper split (O5) can lift it out whole.
- Files move only when a session touches them. Today's modules land like this:

| Today | Lands in |
|---|---|
| `tasks.ts` (task create, executions, subtask create, `taskOp`) | `domain/tasks.ts`, `domain/executions.ts` |
| `graph.ts` (one playbook engine per task) | `domain/executions.ts` |
| `terminal.ts`, `transcript.ts`, `runtime.ts`, `mcp.ts`, `sessionLookup.ts` | `runtime/` |
| `sessionControls.ts` (settings precedence, thinking levels) | `domain/settings.ts` (R3) |
| `naming.ts` | `domain/sessions.ts` |
| `credentials.ts`, `customProviders.ts`, `provider.ts`, `login.ts`, `skills.ts` | stay as they are (provider plumbing, not repo state) |

### 2.3.2 Platform layer

Rust gave these for free. The daemon gets one home for each, and each has a gate or a conformance test.

**`platform/fs.ts`** mirrors `alinery-core/src/fs_atomic.rs`:

```ts
// vinculum-daemon/src/platform/fs.ts (sketch)
let tmpSeq = 0;

// fs_atomic.rs:20 write_bytes_atomic: temp file in the same directory, then rename.
export function writeAtomic(path: string, data: string | Uint8Array, mode = 0o644) {
  const tmp = `${path}.tmp.${process.pid}.${process.hrtime.bigint()}.${tmpSeq++}`;
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

// fs_atomic.rs:30 write_bytes_durable: as above, plus a full sync of the file and its directory.
// Rust's sync_all is fcntl(F_FULLFSYNC) on macOS; Bun's fsyncSync is plain fsync(2) (S0.5).
export function writeDurable(path: string, data: string | Uint8Array, mode = 0o644) { /* fullSync(fd) before close, then fullSync(dir fd) */ }
const fullSync = process.platform === "darwin"
  ? (fd: number) => { if (libc.symbols.fcntl(fd, F_FULLFSYNC) !== 0) throw errnoError("F_FULLFSYNC"); }
  : (fd: number) => fsyncSync(fd);

// fs_atomic.rs:62-99: 0700 directories and 0600 files for anything secret.
export function mkdirOwnerOnly(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
export function writeOwnerOnly(path: string, data: string | Uint8Array) { writeAtomic(path, data, 0o600); }
```

- **Answered in S0.5.** Rust std 1.96.1 `File::sync_all` is `fcntl(F_FULLFSYNC)` on Apple targets, and `write_bytes_durable` calls it on the file and the directory (`fs_atomic.rs:42`, `:50-51`). Bun 1.4.3 `fs.fsyncSync` is plain `fsync(2)` on every Unix (read in Bun's source; the timings agree). So on macOS `writeDurable` calls `fcntl(fd, F_FULLFSYNC)` through `bun:ffi`. `fcntl` is variadic and `bun:ffi` has no variadic calls: bind it with two arguments, which is valid only for commands with no third argument, such as `F_FULLFSYNC`. On Linux `fsyncSync` matches Rust.
- **Cost (WA).** One 1 KiB durable replace on an M4 Max with FileVault: about 9.8 ms p50 and 13 to 18 ms p99 with `F_FULLFSYNC`, against 0.12 ms with plain fsync; Rust's `write_bytes_durable` costs the same 9.8 ms. The FFI call is synchronous, so it blocks the event loop that long. Use `writeDurable` exactly where Rust uses `write_bytes_durable` today: task creation (`task_creation.rs:211`, `:352`, `:403`, `:411`, so task.md, the playbook copy, each attachment and the ticket) and `execution.json` (`execution.rs:322`). Everything else uses `writeAtomic`. A session that sees the loop stall from this (terminal echo, Subscribe latency) stops and asks.
- A gate (`check-daemon-fs-writes.sh`, S0.6) fails on `writeFileSync` or `Bun.write` outside `platform/fs.ts`.

**`platform/lock.ts`** ports `alinery-core/src/lockfile.rs`:

```ts
// vinculum-daemon/src/platform/lock.ts (sketch)
const LOCK_SH = 1, LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;  // same values on macOS and Linux
const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

// lockfile.rs:25 try_lock_exclusive. Never call flock without LOCK_NB: it would block the event loop.
export function tryLockExclusive(path: string): LockHandle | null {
  for (let attempt = 0; attempt < 5; attempt++) {  // lockfile.rs:41 retries a replaced file
    const fd = openSync(path, "a+", 0o600);
    if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) { closeSync(fd); return null; }
    const held = fstatSync(fd), now = statSync(path, { throwIfNoEntry: false });
    if (now && now.dev === held.dev && now.ino === held.ino) return new LockHandle(fd);
    closeSync(fd);  // someone replaced the file between open and flock; lock the new one
  }
  throw new Error(`lock file kept changing: ${path}`);
}

// lockfile.rs:82 is_locked_by_other
export function isLockedByOther(path: string): boolean { /* LOCK_SH | LOCK_NB, then LOCK_UN */ }
```

- **Interop is confirmed (S0.5).** A Rust `try_lock_exclusive` holder blocks Bun's `flock(LOCK_EX|LOCK_NB)` and the reverse, on macOS arm64, Linux arm64 and Linux x64 (60 of 60 runs each). Two descriptors in one process also exclude each other. Working code: `docs/thick-daemon-spikes/src/lock.ts`, `lock.test.ts` and `lock-rs/`.
- **errno.** Rust returns `Ok(None)` only for `EWOULDBLOCK` or `EAGAIN` and an error for anything else (`lockfile.rs:51-56`), so the port must read errno (`__error()` on macOS, `__errno_location()` on Linux, then `read.i32`). Read straight after the failed call it was right in 10,000 of 10,000 tries per platform. `bun:ffi` 1.4.3 can't capture errno, so **no JavaScript may run between the `flock` call and the errno read**: put both in one function with nothing between them. Measured with something between: a failing `statSync` clobbered errno every time, and a forced `Bun.gc(true)` clobbered it on macOS in 21 of 1,000 tries.
- **Hardened runtime: UNCONFIRMED.** The installed release (0.26.0) signs its binaries with the hardened runtime and no entitlements, and ships no Bun binary. The daemon already uses `bun:ffi` (1.4), so this risk predates the plan, but nobody has run `bun:ffi` under that signature. `docs/thick-daemon-spikes/src/hardened-probe.ts` is the probe (dlopen, two flocks, errno, `F_FULLFSYNC`); it passed with Bun's ad-hoc signature, and the user must sign it with the release identity (4.2).
- Lock marker files are never unlinked (invariant 2).

**`withTaskMutation`** is the TypeScript side of `with_task_mutation_lock` (`lockfile.rs:127`), which takes a process mutex and then a flock on `.alinery/.task-mutation.lock` (`alinery-core/src/paths.rs:88`):

```ts
// vinculum-daemon/src/platform/lock.ts (continued)
const queues = new Map<string, Promise<unknown>>();  // per repo: serializes callers in this process

export async function withTaskMutation<T>(repo: string, op: string, fn: () => T): Promise<T> {
  const prev = queues.get(repo) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const lock = await waitForLock(taskMutationLockPath(repo), 2_000);  // TASK_MUTATION_CONTENTION_WAIT, lockfile.rs:118
    if (!lock) throw new DomainError("repo_busy", `task mutation busy during ${op}`);
    try { return fn(); } finally { lock.release(); }
  });
  queues.set(repo, run);
  return run;
}
```

- `fn` is synchronous on purpose: no `await` while the flock is held, so a slow client can't hold the repo lock.
- `waitForLock` retries `tryLockExclusive` with a short timer backoff (10, 20, 40 ms, capped at 100 ms) until the deadline.
- While Rust still writes a domain (migration rule 3), every TypeScript write to the same files goes through `withTaskMutation`. After S5.1 no Rust code writes `.alinery/` files, but the flock stays: job children (O7 a) and the host bootstrap (S5.2) are separate processes that touch the same files, and the process queue can't see them.

**`platform/git.ts`** is the only `Bun.spawn(["git", ...])` site. It resolves git like `alinery_core::git_cmd` (PATH, skipping the macOS `/usr/bin/git` stub until the Command Line Tools are installed; then the alongside tree with `GIT_EXEC_PATH`; `ALINERY_GIT_PATH` for tests) and scrubs the same environment variables. A gate like `check-git-env-scrub.sh` covers `vinculum-daemon/src`. A remote host has no alongside tree: git comes from its PATH, and the setup probe refuses a host without it (D6).

**Host tools (D6).** Every program the daemon spawns on a remote host must be on the setup probe's list (`remote.rs:326` collects, `:429` refuses). Today that is git, plus tar, gzip and sha256sum for the runtime install itself. S4.9 adds `zip` and `unzip` (O11 b); `debian:12` has neither by default (checked in the plan review). The daemon makes HTTP calls with Bun's `fetch`, so curl is not on the list; a session that adds a spawned tool adds it to the probe in the same PR.

**`platform/process.ts`** holds detached spawns (`setsid` on Linux, as core `configure_detached_process` does) and the one place that sends signals to children, so the no-auto-kill gate has one file to scan.

**`platform/keepawake.ts`** follows O9.

### 2.3.3 Port order

Ordered by risk and by what unblocks the next port. Each row is one P4 session.

| Session | Domain | Rust it replaces (lines) | `RepoOp` variants retired | Why here |
|---|---|---|---|---|
| S4.1 | Settings | core `settings.rs` 1,036, settings half of `shared.rs` (`:756`-`:1049`), app `settings.rs` 396 | ReadRepoOverrides, WriteRepoOverrides | R3: the daemon already reimplements precedence (`sessionControls.ts:75-123`); everything else reads settings |
| S4.2 | Executions | `execution.rs` 929, `execution_tests.rs` 1,360, the execution parts of daemon `tasks.ts` | SavedExecution | R1, R2, O14; the board and every task view read it |
| S4.3 | Tasks, drafts, attachments | `task_creation.rs` 1,383, `task.rs` 831, `task_drafts.rs` 352, `attachments.rs` 114, `task_activity.rs` 218, app `task.rs` 757 | RenameTask, ArchiveTask, RestoreTask, DuplicateTaskPackage, WriteDraft, ReadDraftAttachments, DeleteDraft, AttachmentPath, ReadAttachmentImage, WriteAttachment, SetAutoApproveAll, SetRelatedTasks, ReadLaunchFields, WorktreeExists | `provision_ffi.rs` (175) goes with it, removing the daemon's main FFI use |
| S4.4 | Sessions meta and chat | `session_name.rs` 627, `session_actions.rs` 200, `history.rs` 684, `chat.rs` 359, `message.rs` 112, app `chat.rs` 618, most of app `session.rs` 1,447, `notify.rs` 93 (the attention text) | RenameSession, MarkSessionNotificationRead, StampSessionArchived, ReadSessionHistory, ReadOmpWindow, SessionArtifactReady, ClearSessionNotifications, SessionAttentionBody, FinalizeSessionMessageActions, PrepareReviewApprovalPrompt, and the 12 chat variants (ListChatThreads to ReadChatImage) | The runner already owns these sessions; the meta writes follow it |
| S4.5 | Artifacts and comments | `artifact_tree.rs` 571, `artifact_comments.rs` 589, the artifact half of `shared.rs` (`:144`-`:756`), app `artifacts.rs` 740 | the 17 artifact and comment variants (ListArtifactsWithMetadata to SendReviewHandoff) | Biggest command count (25), all DOMAIN |
| S4.6 | Playbook library | `playbook_library.rs` 1,510, `playbook.rs` 1,048, `playbook_tree.rs` 296, app `playbook.rs` 263 | ReadPlaybookTree, ApplyPlaybookTree | After S0.6 deletes `playbook_scheduler.rs`, the engine in `playbook-engine/` is the only scheduler |
| S4.7 | Git | `git_actions.rs` 425, the repo half of `git.rs` 1,060, app `git_ops.rs` 465 | TaskSourceBranches, RemoveWorktree, PushAndCompareUrl, SetPrUrl, CommitWorktree, TaskPullRequestInputs, RecordDiscoveredPullRequest, GitOriginUrl | Needs `platform/git.ts`; push needs host git credentials (already true for remote repos) |
| S4.8 | Subtasks | `subtask.rs` 1,450, app `subtask.rs` 174 | SubtaskState, SubtaskManagerRequest, SubtaskDiscardSessions, DiscardSubtask | Depends on tasks, executions and sessions |
| S4.9 | Storage and backup as jobs | `storage.rs` 816, `backup.rs` 1,188, app `backup.rs` 372, `backup_queue.rs` 342 | StorageInfo, PurgeArchived, BackupCreate, BackupList, BackupCheckDestination, BackupVerify, BackupRestore | The app's only business state (the backup queue) leaves the shell |
| S4.10 | Imports, community import, agent dir | app `imports.rs` 644, the repo half of `community_playbooks.rs` 1,362, `omp_update.rs` 182 and `vinculum_customizations.rs` 641 (per O12) | none (GitOriginUrl is counted under S4.7) | Network calls that need Mac secrets stay in the shell (2.3.4) |
| S4.11 | Ownership, takeover, keep-awake, hosted handoff | `repo_ownership.rs` 397, `ownership_ffi.rs` 59, `idle_inhibit.rs` 554 | none | Last FFI users; after this the daemon dlopens no `libalinery_core` |
| S4.12 | Providers and models | daemon `main.ts:964-1021` (JSON-lines ops), the seven app `session.rs` provider commands (`:1215`, `:1227`, `:1233`, `:1239`, `:1245`, `:1251`, `:1265`), `list_harness_models(_for_repo)` | none | Takes the provider ops off the JSON-lines wire before S5.3 deletes it |

The 11 host-level variants (Ping, ClaimRepo, ReleaseRepo, Classify, Init, ListDir, WriteFile, RemoveFile, SyncCredentials, WaitDaemonGone, SpawnDaemon) work when no daemon runs; O15 decides them in S5.2. The 8 board-read variants (ListBoardTasks, ListTasks, GetTask, TaskActivity, ListSessions, ListSessionItems, ReadSessionMetas, GetSessionDisplay) retire in S3.5. 11 + 8 + 77 above = 96.

### 2.3.4 Splitting the MIXED commands

30 commands do two kinds of work at once (1.4 counts 28; `create_chat_thread` and `start_chat_thread` also refresh the hosted token before opening, like `open_session`). Each splits by one of these rules:

| Shape today | Becomes |
|---|---|
| Reads meta files, then asks the daemon for live status | One subscription: the daemon already has both |
| Writes repo files, then kills or stops a session | One daemon command that does both in order |
| Builds a domain request, then creates a session | One daemon command |
| Reads a file on this Mac (picker result, dropped file), then writes it into the repo | The shell reads the file and uploads it through `BlobService`; the daemon writes it |
| Calls a network API that needs this Mac's secrets (GitHub token, Linear OAuth, account) | The shell calls the API and passes the result to a daemon command |
| Calls a network API that needs no Mac secret | The daemon calls it |
| `open_session` (meta preflight, hosted refresh, attach) | The daemon owns preflight and attach; hosted-token refresh stays in the shell and reaches the daemon as a settings write (S4.11) |
| `set_active_repo` (select, provision, ready the repo) | Selection and provisioning stay in the shell; a new `RepoService.EnsureReady` in the daemon does the repo half |
| Stops sessions, rewrites the repo, starts again (`restore_backup`) | `Shutdown` with origin `RESTORE_BACKUP` (S1.4), the restore itself while no daemon runs (S4.9), then a normal start |

The 30, with the rule and the session that owns each half (measured 2026-10-27; lines are the `fn` line under `alinery-app/src-tauri/src/`):

| Command | Rule | Owner |
|---|---|---|
| `task.rs:92` duplicate_task_for_repo | 3 | S4.3 |
| `task.rs:282` copy_chat_attachments | 4 | S4.3 (builds `BlobService` upload) |
| `task.rs:645` list_task_activity | 1 | S3.5 |
| `session.rs:321` archive_session, `:369` archive_session_for_repo | 2 | S4.4 |
| `session.rs:505` open_session | 7 | attach S3.4; preflight S4.3; hosted refresh stays in the shell (S4.11) |
| `session.rs:832` session_status, `:1013` session_list_statuses, `:1076` session_statuses, `chat.rs:395` chat_session_status | 1 | S3.2 |
| `chat.rs:152` create_chat_thread, `:180` start_chat_thread | 7 | S4.4; hosted refresh stays in the shell (S4.11) |
| `chat.rs:538` copy_chat_thread_attachments | 4 | S4.4 (uses S4.3's upload) |
| `daemon.rs:328` observe_task_executions | 1 | S4.2 |
| `daemon.rs:1345` close_all_repos | 2, in part | shutdown S1.4; the exited-session acks S4.4; the quit latch and MCP stop stay in the shell |
| `daemon.rs:1549` daemon_status | 1 | daemon half S2.5 and S3.1; lane, conflict and drift stay in the shell until P5 |
| `app_config.rs:411` set_active_repo | 8 | `EnsureReady` S4.1; the shell half S6.2 |
| `settings.rs:354` delete_all_archived_storage | 2, as a job | S4.9 |
| `community_playbooks.rs:455` community_download_status | 6 | S4.10 |
| `community_playbooks.rs:933` import_community_playbook, `:951` update_community_import | 5 (the package moves as `PlaybookPackageBlob`) | S4.10 |
| `community_playbooks.rs:1343` publish_community_playbook | 5, reversed: the daemon reads, the shell sends | S4.10 |
| `imports.rs:635` import_github, `:641` import_github_for_repo | 5 | S4.10 |
| `git_ops.rs:400` list_task_pull_requests | 5 | S4.7 |
| `backup.rs:318` restore_backup | the restore row | S4.9 (local and remote) |
| `notify.rs:82` notify_session_attention | 1 | body S4.4; trigger S3.2; the OS notification stays in the shell |
| `subtask.rs:57` start_subtask_manager, `:108` recover_subtask_manager | 3 | S4.8 |
| `subtask.rs:121` discard_subtask | 2 | S4.8; its pre-archive backup S4.9 |

These stay DOMAIN, because a remote repo already runs each as one `RepoOp`: `archive_chat_thread`, `remove_chat_worktree`, `resume_chat_thread`, `archive_task(_for_repo)`. `read_app_config` is shell plus provision and doesn't split.

### 2.3.5 Jobs and workers

**Decided (O7 a): a job is a child process of the daemon's own binary.**

```ts
// vinculum-daemon/src/jobs/runner.ts (sketch)
export function startJob(kind: JobKind, params: unknown): string {
  const id = crypto.randomUUID();
  const child = Bun.spawn([process.execPath, "--job", kindName(kind)], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: jobEnv(),
  });
  child.stdin.write(JSON.stringify(params)); child.stdin.end();
  commitJob({ id, kind, state: JobState.RUNNING, startedAtMs: Date.now() });
  readJsonLines(child.stdout, (line) => {  // {progress}, {result} or {error}
    if (line.progress) commitProgressThrottled(id, line.progress);  // about 4 per second (2.2.8)
    if (line.result) commitJob({ id, state: JobState.DONE, result: line.result, endedAtMs: Date.now() });
    if (line.error) commitJob({ id, state: JobState.FAILED, error: line.error, endedAtMs: Date.now() });
  });
  return id;
}
```

- **Why a child and not a `Worker`:** Bun's docs mark `Worker` experimental, and a native crash in a worker takes the daemon and every PTY with it. A child that dies only fails its job.
- **What is a job:** anything that can take over about 50 ms or reads many files: backup create and verify, storage scan, purge, import, community fetch and unpack, zip export. Git runs inline as async `Bun.spawn`; it doesn't block the loop.
- **Queueing:** one backup per repo at a time; FIFO per kind. The automatic backup trigger keeps today's 2 s debounce (`backup.rs:43-61`).
- **Restore is not a job.** It replaces the files under the daemon. It stays `Shutdown(RESTORE_BACKUP)`, then a one-shot restore by the shell (or the host bootstrap for a remote repo, O15), then a fresh daemon.
- **Cancel** sends SIGTERM to the child through `platform/process.ts`; the job ends `CANCELLED`. Child processes are not sessions, so this doesn't touch invariant 1.
- **Zip (O11 b):** the job child spawns the host's `zip` to write and `unzip` to read; no zip library in TypeScript. S4.9 runs Rust-made archives through the TypeScript side and the other way round.
- **A job's result is part of the `Job` entity**, so a client that was closed during a backup sees the result when it subscribes.

### 2.3.6 Defects fixed on the way

| Id | Fix | Session |
|---|---|---|
| R1 | `addExecution` goes through `withTaskMutation`, writes with `writeAtomic` and commits a revision | S0.6 |
| R2 | One execution state machine (O14) | S4.2 |
| R3 | One TypeScript implementation per rule; the Rust copy is deleted in the same session | S3.5, S4.1, S4.6 |
| R4 | Every write through `platform/fs.ts`, gate added | S0.6 |
| R6 | Stubs and `playbook_scheduler.rs` deleted | S0.6 |
| R7 | Subscriptions | P3 |
| R8 | One RPC server with auth on every call | S1.1 |

## 2.4 Shell end state

After P5 the Rust app keeps four jobs, about 70 commands plus the bridge:

1. **Provision daemons.** Local spawn and lane routing (`daemon.rs`), the ssh transport and host install (`remote.rs`), the per-start token files, and the GUI lock `.alinery/.alinery-app.lock` (flock, never a pid file).
2. **Bridge the webview** (`daemon_rpc`, `daemon_rpc_cancel`, 2.1.9).
3. **OS and this-Mac jobs.** Dialogs and pickers, notifications and sound, keychain, browser sign-in (GitHub, Linear, account pairing), app and OMP updates, telemetry consent, the close dialog, reveal-in-Finder.
4. **Teardown origins.** The five callers of `AdminService.Shutdown` (invariant 1).

Gone from the shell: `daemon_client.rs` (2,182), `repo_service.rs` (1,923), the reassembly half of `rpc_chunk.rs`, the pollers and supervisors' business checks, the backup queue, and every DOMAIN and PROXY command. Gone from the daemon: the `libalinery_core` FFI (`tasks.ts:15-47`, `ownership_ffi.rs`, `provision_ffi.rs`, `idle_inhibit` if O9 b).

## 2.5 Frontend

- **`ipc.ts` splits in two.** `ipc.ts` keeps the shell wrappers (still the only `@tauri-apps/*` importer, so `check-ipc-boundary.sh` stays as is). A new `src/daemon/` holds `bridgeFetch` (which calls one wrapper in `ipc.ts`), `daemonTransport(repoKey)`, and the generated service clients.
- **Views read entities, not commands.** `useEntity`, `useEntities` and `useScope(repoKey, scope)` from `src/sync/` (2.2.10) replace the poll-and-`setState` loops in 2.2.11.
- **`types.ts` shrinks** as generated message types replace its shapes. A view keeps its own field names only where a port session says so.
- **Tests move to `createRouterTransport`.** The 66 test files that mock `ipc.ts` move slice by slice as their commands go. A test builds a real store and router in memory, so it exercises the daemon's code instead of a canned answer.

```ts
// alinery-app/src/test/daemonHarness.ts (sketch)
export function daemonHarness(services: Partial<Services>) {
  const transport = createRouterTransport((router) => {
    for (const [desc, impl] of serviceEntries(services)) router.service(desc, impl);
  });
  return { transport, replica: new Replica() };
}
```

- **`check-ipc-commands.sh`** stops counting a command once its wrapper is gone; a new gate checks that `src/daemon/` calls only services that exist in `proto/`.

---

# Part 3: Sessions

Each session is one PR. The fields are always the same:

- **Status**: not started, in progress (who, branch), done (commit).
- **Needs**: sessions that must land first.
- **Read first**: code to read before writing any. Line numbers are from 2026-10-26 and drift; search for the symbol if a number is off.
- **Research**: what to confirm before building, and how. Results go to 4.1 or 4.2.
- **Build**: the change, with sketches. Sketches show shape, not final code.
- **Tests**: what proves it. Inner loop is targeted (`bun test <file>`, `npx vitest run <file>`, `cargo check -p alinery-app`); `./scripts/check.sh` runs once at check-in.
- **Accept**: commands a reviewer runs, each with the result it must give. A session is done when every line gives its result and `./scripts/check.sh` passes. A line that can't be run without the app open says so; the user runs it or allows it.
- **Exit**: the observable result, and what got deleted.

## P0: Contract, cleanup, spikes

### S0.1 Proto toolchain and the daemon test step

Status: not started. Needs: nothing. Its research was answered by the review spike (4.1 S0.1).

**Goal.** `proto/` exists with `common.proto` and `admin.proto`, generated TypeScript is checked in, and both the daemon and the app import it. `./scripts/check.sh` runs the daemon's and the engine's `bun test` (today it runs neither: its steps are biome, typecheck, vitest, the omp extension, the Rust steps and the shell gates).

**Read first.** `docs/thick-daemon-spikes/` (`package.json`, `buf.yaml`, `buf.gen.yaml`, `tsconfig.json`, `vite.config.mjs`, `proto/`): the working toolchain this session moves into the repo. `alinery-app/src-tauri/vinculum-daemon/package.json` (the `file:` dependency on `playbook-engine` is the pattern for `alinery-proto`); `scripts/check.sh:37-90`; `scripts/dev-fetch-bun.sh` (how the compiled daemon is built); `alinery-app/vite.config.ts` and `tsconfig.json`.

**Research (answered 2026-10-27).**
- protoc-gen-es 2.16.0, `target=ts`, default import extension (none): resolves under `bun run`, `bun build --compile`, `tsc --noEmit` with `moduleResolution: "bundler"` and Vite 7.3.6 `vite build`. `buf.gen.yaml` sets nothing more.
- `@bufbuild/buf` 1.75.0 as a pinned devDependency runs from `node_modules/.bin/buf` with no network. No `npx`.
- `@bufbuild/protobuf` 2.16.0 pairs with protoc-gen-es 2.16.0; Connect 2.2.0 works with both.
- **Left for this session (UNCONFIRMED, 4.2):** the spike imported the generated files by relative path. As a `file:` package, `alinery-proto/alinery/v1/admin_pb` must resolve through `exports`, and an extensionless subpath needs `"./*": "./gen/*.ts"`. Check it in Bun, Vite and `tsc`; if one refuses it, record what works in 4.1.

**Build.**
- `proto/` as in 2.1.1, with `common.proto` and `admin.proto` only. Later sessions add their files.
- `proto/package.json`:

```json
{
  "name": "alinery-proto",
  "private": true,
  "type": "module",
  "exports": { "./*": "./gen/*.ts" },
  "dependencies": { "@bufbuild/protobuf": "2.16.0" },
  "devDependencies": { "@bufbuild/buf": "1.75.0", "@bufbuild/protoc-gen-es": "2.16.0" },
  "scripts": { "gen": "buf generate && buf lint" }
}
```

- `"alinery-proto": "file:../../../proto"` in the daemon's `package.json` (path relative to `vinculum-daemon/`, like `playbook-engine`), and `"alinery-proto": "file:../proto"` in `alinery-app/package.json`.
- `scripts/tests/check-proto-gen.sh`: run `npm --prefix proto run gen` into a temp copy and `diff -r` against `proto/gen`; fail on any difference. Listed in `scripts/check.sh` with the source gates.
- Two steps in `scripts/check.sh`, before the Rust steps, in `--quick` too:

```bash
step "daemon: bun test"
(cd "$TAURI/vinculum-daemon" && "$BUN" test)

step "playbook engine: bun test"
(cd "$ROOT/playbook-engine" && "$BUN" test)
```

`$BUN` is the pinned one from `dev-fetch-bun.sh`, not a PATH search, if that script exposes its path; otherwise the step fails with the command to fetch it.

**Tests.** `proto/roundtrip.test.ts`: build a `HelloResponse` with every field set, `toBinary` then `fromBinary`, and `equals()` is true; the same through `toJson`/`fromJson`. One vitest file in the app imports the same generated module, so a resolution break fails in both toolchains.

**Accept.**
- `npm --prefix proto ci && npm --prefix proto run gen && git diff --exit-code proto/gen`: no diff, and buf lint prints nothing.
- `scripts/tests/check-proto-gen.sh`: exit 0. After adding a field to `common.proto` without regenerating: exit 1.
- `./scripts/check.sh --quick`: the output shows the two `bun test` steps, both passing.
- The binary `dev-fetch-bun.sh` builds, run with `--protocol-version`, prints the current `PROTOCOL`.

**Exit.** As Accept.

### S0.2 RPC spike (O1)

Status: **done by the plan review, 2026-10-27.** Code: `docs/thick-daemon-spikes/src/rpc-server.ts`, `rpc-bench.ts`, `jsonl-server.ts`, `idle-streams.ts`, `h2-probe.ts`, `peer.ts`. What remains is the user's call on O1 (S0.7); no product code.

**Results** (Bun 1.4.3, darwin-arm64; 4.1 S0.2):
- `connectNodeAdapter` on `node:http` serves unary and server streams over a unix socket, under `bun run` and in the compiled binary (71 MB). `node:http2` serves gRPC too (`h2-probe.ts`).
- An interceptor sees headers only. The peer check needs the `node:net` listener and `contextValues` (2.1.7); Bun's `node:http` hides the socket fd.
- connect-node over `nodeOptions.socketPath` works. Client cancel fires the handler's `ctx.signal`; a handler parked on its own timer doesn't see it until it wakes (the 2.1.7 rule).
- Unary 100-byte echo: p50 0.078 to 0.081 ms, p99 0.27 to 0.35 ms. The JSON-lines wire (one connection per op) as baseline: p50 0.035 ms. About 34,500 calls a second with 16 in flight.
- Server stream with 16 KiB frames: 356 to 362 MB/s.
- Memory: idle RSS about 47 MB; idle streams about 143 KB each at 100 open and 55 KB each at 1,000.

**Accept.** The rerun commands in `docs/thick-daemon-spikes/README.md` give numbers within 2x of these on Apple silicon.

### S0.3 Bridge spike (O2)

Status: **done by the plan review, 2026-10-27, except one check in the real webview** (moved to S1.2's Accept, because it needs the app launched, which the user must allow). Code: `docs/thick-daemon-spikes/src/bridge-fetch.ts` and its test, `bridge-rs/`, `src/ui-client.ts`.

**Results** (4.1 S0.3):
- A stock connect-web client with `bridgeFetch` as its `fetch`: unary, Connect error codes, a 100-frame server stream and mid-stream cancel all pass (6 tests). Through the Bun stand-in for the shell, unary p50 is 0.095 ms, p99 0.45 ms.
- Request body and channel in one invoke: raw body plus the channel id in a header, read with `JavaScriptChannelId::from_str(..).channel_on(webview)` (2.1.9). Read in Tauri 2.11.3's source; not yet run in a webview.
- Rust hyper 1 over a unix socket, one connection per call: p50 0.076 ms; the daemon's peer check sees the shell binary. The TypeScript and Rust frame encoders give the same bytes (`frame_matches_typescript`).
- An abort before HEAD must reject the `fetch`; a pooled connection after a cancelled stream fails with ECONNRESET; an absolute-form URI gets 404. All three are rules in 2.1.9.
- Unbatched, a busy stream sent about 116,000 channel messages a second; batching is mandatory (2.1.9).
- hyper, hyper-util, http-body-util and atomic-waker are in `Cargo.lock` but not built by the app today, so the first build downloads them at the lock's versions.
- The UI bundle of a connect-web client with two services is 176,382 bytes, 41,886 gzipped (Vite 7.3.6).

**Accept.**
- `cd docs/thick-daemon-spikes && bun install --frozen-lockfile && bun test src/bridge-fetch.test.ts`: 6 pass. (A stack trace from the server after the cancel test is the expected broken pipe.)
- `cd docs/thick-daemon-spikes/bridge-rs && CARGO_TARGET_DIR=<outside the repo> cargo test --locked`: `frame_matches_typescript` passes.

### S0.4 Watcher spike

Status: **done on macOS by the plan review, 2026-10-27.** Linux was not run; that run moves to S2.3's Accept. Code: `docs/thick-daemon-spikes/src/watch.ts`.

**Goal.** Choose the file watcher for 2.2.8: Bun `fs.watch` with `recursive: true`, or `@parcel/watcher` 2.6.0.

**What ran.** One watch on a synthetic `.alinery/tasks` of 45 tasks. Another process ran 3,000 ops on 1,000 paths (500 creates, 1,000 appends, 1,000 renames over in the `writeAtomic` pattern, 500 deletes) while a third appended 10 MB/s to a `*.scrollback` file. *Paced*: ops on one file 1 s apart, so each event maps to one op. *Burst*: no sleeps; only whether each path's last op got an event. Two seeds each, under `bun run` and as a compiled binary.

**Results** (macOS arm64, Bun 1.4.3; the two runners agree within noise):

| | Bun `fs.watch` recursive | `@parcel/watcher` 2.6.0 |
|---|---|---|
| Paced: ops with no event | 0 | 0 |
| Paced: extra events per 3,000 ops | 1 to 5 | 0 |
| Paced: latency p50 / p95 / max | 30 to 31 / 53 to 54 / 61 to 63 ms | 246 to 269 / 475 to 487 / 503 to 514 ms |
| Paced: watcher CPU | 0.8 to 0.9% | 2.7 to 4.4%; 3.1 to 4.9% with `ignore: ["**/*.scrollback"]` |
| Scrollback events a second | 19.8 | 2; 0 with the ignore list |
| Burst: paths whose last op got no event | 0 | 0; 1 in one `bun run` seed with the ignore list |
| Scrollback appends through one held fd | 2 to 3 extra events, no misses | no extras, no misses |
| Idle, 200 tasks, 30 s: CPU, RSS, events | 0.1%, 7.4 MB, 0 | 0.1%, 7.6 to 7.9 MB, 0 |
| Subscribe, 200 tasks | 9.8 to 9.9 ms | 12.6 to 14 ms |

With no watcher the idle process used 0.1% CPU and 6.3 MB.

- **Bun #44780's trigger** (`--flat`): two processes replacing files in a hot loop under `.alinery/worktrees/w/src`, with a non-recursive `fs.watch` on each of its five folders up to the repo root. Bun on macOS feeds every watch into one FSEvents stream. Bun missed nothing; latency fell to 6 ms p50, scrollback events rose to 131 to 135 a second and CPU to 2.7 to 2.8%. One compiled run reported two events for `.alinery/tasks/tasks`, a path that does not exist. `@parcel/watcher` was unchanged.
- **Bun #34160** (cost of each further non-recursive watch): 500 took 345 to 810 ms, 1,500 about 4.7 s, 3,000 about 22.8 s. The cost grows faster than the count. One recursive watch never meets it.
- **The addon in a compiled binary.** `@parcel/watcher` picks its prebuilt with a computed `require`, which `bun build --compile` can't follow. Required by a literal per-platform path (`watch.ts:55-66`), the `.node` file is embedded: the compiled binary, run from a folder with no `node_modules` above it, loaded it. Nothing sits beside the binary, but each build target needs its own literal line, and its addon package installed at build time. `--compile` drops the branches for other platforms, so a macOS build needs only the macOS addon; a plain `bun build` without `--compile` fails on any named addon that is not installed.

**WA: Bun `fs.watch` with `recursive: true`** on `.alinery/tasks`. On this evidence it needs no native addon, has about an eighth of the latency and a quarter of the CPU, and its extra events cost one re-read each, because the handler commits only when `equals()` says the entity changed (2.2.8). `@parcel/watcher` had no extra events and is the fallback if the Linux run misses events; switching changes only `sync/watcher.ts`.

**Rules for S2.3** (whichever watcher):
- The handler trusts neither an event's kind nor its path. It re-reads the path; a path no parser matches is dropped, which covers the stray `tasks/tasks` events. A missing file deletes the key of the parser that matches it.
- `*.scrollback` and the `.tmp.` names `writeAtomic` makes are dropped by name before any I/O.
- The config files (`config.toml`, `harnesses.toml`, `playbooks.toml`) sit in `.alinery/` beside `worktrees/`. WA: one non-recursive watch on `.alinery/`, filtered to those three names. On macOS that is the #44780 shape above (a busy `worktrees/` under a non-recursive watch): no misses, about 2.7% CPU while a build churns, stray paths possible.
- The 30 s reconcile stays (2.2.8), because no watcher is trusted alone.

**Accept.** `cd docs/thick-daemon-spikes && bun install --frozen-lockfile && bun run src/watch.ts matrix --reps 2 --idle-seconds 30`, and the same through a compiled binary (README): Bun's rows show 0 ops with no event and 0 burst misses, and the numbers fall within 2x of the table on Apple silicon.

**Exit.** The WA is recorded in 4.1.

### S0.5 Platform spike (O6, durability)

Status: **done by the plan review, 2026-10-27, except the hardened-runtime check**, which needs the user's signing identity (4.2). Code: `docs/thick-daemon-spikes/src/lock.ts`, `lock.test.ts`, `fsync-bench.ts`, `hardened-probe.ts`, `lock-rs/`.

**Results** (4.1 S0.5; the rules they set are in 2.3.2):
1. **flock interop works both ways** on macOS arm64, Linux arm64 and Linux x64 (emulated): 60 of 60 runs each. Two descriptors in one process also exclude each other.
2. **errno** read straight after the failed call is right in 10,000 of 10,000 tries per platform. Any JavaScript between the call and the read can clobber it.
3. **Durability:** Rust's `write_bytes_durable` uses `F_FULLFSYNC` on macOS; Bun's `fsyncSync` is plain `fsync`. `F_FULLFSYNC` through `bun:ffi` costs the same as Rust (about 9.8 ms p50 per 1 KiB replace, against 0.12 ms for plain fsync).
4. **Hardened runtime:** the probe passed with Bun's ad-hoc signature only.

**Accept.**
- `cd docs/thick-daemon-spikes/lock-rs && CARGO_TARGET_DIR=$T cargo build --release --locked`, then `LOCK_RS_BIN=$T/release/lock-rs bun test --rerun-each 10 src/lock.test.ts` from `docs/thick-daemon-spikes`: 60 pass.
- For the user: build `hardened-probe.ts` with `bun build --compile`, sign it with the release identity and entitlements (`--options runtime`), run it: exit 0 and `"ok":true`. The commands are in `docs/thick-daemon-spikes/README.md`.

**Exit.** O6 (a) moves to 4.1 with the user; the hardened-runtime item leaves 4.2 when the user runs the probe.

### S0.6 Cleanup and R1

Status: not started. Needs: nothing. `withTaskMutation` takes the flock through `bun:ffi` as in 2.3.2: S0.5 confirmed the interop, and `docs/thick-daemon-spikes/src/lock.ts` is the starting code (with its errno rule).

**Goal.** Delete the dead code, make every daemon write crash-safe and fix R1.

**Read first.** The stubs: `chat.rs` `chat_rpc_write` :361, `chat_rpc_attach` :367, `chat_restate` :421; `session.rs` `restate_session` :1158, `omp_setup_session` :1169, `rpc_write_session` :1271, `rpc_attach_session` :1277. `alinery-core/src/lib.rs:27` and `:68` (the `playbook_scheduler` module and its re-exports); the test at `alinery-core/src/subtask.rs:1118`. The R4 sites (1.4). `tasks.ts:291-296` (`addExecution`).

**Build.**
1. **Stubs.** Delete the 7 commands, their names in `generate_handler!`, their `ipc.ts` wrappers and any callers (they return "OMP process sessions are not available", so callers already handle an error).
2. **`playbook_scheduler.rs`** (3,018 lines). Delete it and the two `lib.rs` lines. Rewrite the `subtask.rs:1118` test to build its fixture without the scheduler, or delete it if it only tested the scheduler.
3. **`platform/fs.ts`** as in 2.3.2, and move every R4 site to it: `main.ts:295`; `tasks.ts:295`, `:324`, `:361`, `:383`, `:402`; `runtime.ts:134`. `credentials.ts:42` and `customProviders.ts:33` already write 0600 but not atomically; they move to `writeOwnerOnly`.
4. **`scripts/tests/check-daemon-fs-writes.sh`**: fail on `writeFileSync`, `appendFileSync` or `Bun.write` in `vinculum-daemon/src` outside `platform/fs.ts`, with an allowlist file for the scrollback append (`terminal.ts:88`, an append-only log, not a replace).

```bash
# scripts/tests/check-daemon-fs-writes.sh (sketch)
hits=$(grep -rnE 'writeFileSync|appendFileSync|Bun\.write\(' "$DAEMON/src" --include='*.ts' \
  | grep -v '\.test\.ts:' | grep -v '^'"$DAEMON"'/src/platform/fs\.ts:' \
  | grep -vFf "$ROOT/scripts/tests/daemon-fs-writes-ok.txt" || true)
[ -z "$hits" ] || { echo "write through platform/fs.ts:"; echo "$hits"; exit 1; }
```

5. **R1.** `addExecution` runs inside `withTaskMutation` (2.3.2), reads, appends and writes with `writeAtomic` in one synchronous `fn`.

```ts
// tasks.ts addExecution (sketch)
export function addExecution(repo: string, slug: string, entry: ExecutionEntry) {
  return withTaskMutation(repo, "add_execution", () => {
    const path = executionPath(repo, slug);
    const current = readExecutionFile(path);       // sync read under the lock
    writeAtomic(path, JSON.stringify(append(current, entry), null, 2));
  });
}
```

6. **O14 trace.** Done by the plan review (4.1, "O14 trace"). This session only re-runs its writer search (`grep -rn 'execution.json\|execution_state_path' alinery-app/src-tauri vinculum-daemon/src`) and corrects the note if code moved.

**Tests.**
- `bun test`: 50 concurrent `addExecution` calls on one task end with 50 entries.
- The same with a Rust helper process holding `.alinery/.task-mutation.lock` for 500 ms during the burst: all 50 land after it releases, none is lost, and a hold longer than 2 s gives `repo_busy`.
- `check-daemon-fs-writes.sh` passes, and fails on a planted `writeFileSync`.

**Accept.**
- `grep -rn 'chat_rpc_write\|chat_rpc_attach\|chat_restate\|restate_session\|omp_setup_session\|rpc_write_session\|rpc_attach_session\|playbook_scheduler' alinery-app/src alinery-app/src-tauri/src alinery-app/src-tauri/alinery-core/src`: no output.
- `scripts/tests/check-daemon-fs-writes.sh`: exit 0; with a planted `writeFileSync` in a daemon module: exit 1 naming that line.
- `(cd alinery-app/src-tauri/vinculum-daemon && bun test)`: the two `addExecution` tests above pass, and `rerun-each 20` of them passes.
- `cargo test --workspace` passes (the rewritten `subtask.rs` test included).

**Exit.** 7 stubs, `playbook_scheduler.rs` and every R4 site gone; the gate is in `check.sh`.

### S0.7 Decisions with the user

Status: in progress. The plan review (2026-10-27) wrote 2.3.4's table of the 30 MIXED commands and put O1, O2, O3, O6 and O7 to the user with the spike numbers (4.1). The watcher WA from S0.4 is in 4.1 too; its Linux run is in S2.3. The user decided O4, O7, O11, O14, O20 and O21 on 2026-10-27; O1, O2, O3 and O6 wait for confirmation, and O22 is new. Needs: nothing.

**Goal.** Close the P0 Open items.

**Build.** No code. Record the user's answers in 4.1 and 1.7. Whatever is still open when S1.1 starts is asked again here.

**Accept.** In 1.7, O1, O2, O3, O6 and O7 each say Decided (with the user and date) or WA with a 4.1 evidence line; the watcher choice has a 4.1 row.

## P1: RPC host and transports

### S1.1 RPC server, Admin and auth

Status: not started. Needs: S0.1, S0.7.

**Goal.** The daemon serves `alinery.v1` on `<repo>/.alinery/rpc[-ns].sock` beside `alineryd[-ns].sock`, with `AdminService.Hello` and bearer-token auth on every call (R8).

**Read first.** 2.1.3, 2.1.7, 2.1.10; `docs/thick-daemon-spikes/src/rpc-server.ts` and `peer.ts` (the working server, auth and peer check); `main.ts:26` (`PROTOCOL`), `main.ts:80-97` (ui secret read and delete), `main.ts:660-710` (peer credential checks: `getpeereid` and `LOCAL_PEERPID` on macOS, `SO_PEERCRED` on Linux); `alinery-core/src/daemon_client.rs:1470` (`daemon_command`, the one place that builds the daemon's arguments, used by local spawn in `pi_durable.rs:42` and the host spawn in `repo_service.rs:1021`); `alinery-core/src/protocol.rs:15`.

**Build.**
- `rpc/server.ts` as in 2.1.7, started from `main.ts` after the secret files are read and before sessions resume. The socket is created 0600: set `process.umask(0o077)` around `listen`, because today's socket (`main.ts:1146`) takes whatever umask the daemon inherited, and a chmod after `listen` leaves a window.
- `rpc/auth.ts`: an interceptor that reads `authorization: Bearer <hex>`, compares with `timingSafeEqual`, and attaches the capability set from 2.1.10 to the context. The peer executable comes from `contextValues` (2.1.7: the `node:net` listener keeps the socket fd; `peerExecutable` is `main.ts:666`, moved).

```ts
// rpc/auth.ts (sketch)
export const authInterceptor = (secret: Buffer, shellExe: string): Interceptor => (next) => async (req) => {
  const caps = capabilitiesFor(bearer(req.header), secret, req.contextValues.get(PEER), shellExe);
  if (!caps.size) throw new ConnectError("wrong token", Code.Unauthenticated);  // a wrong token is never "no token"
  req.contextValues.set(CAPS, caps);
  return next(req);
};
```
- `--rpc-secret-file <path>` in `daemon_command`, and the shell side in `daemon.rs` and `remote.rs`: create 32 random bytes, write 0600, pass the path; keep the copy per repo and lane under `<app_config_dir>`.
- `Hello` returns `protocol`, `build_id` (already cached per a2d23306), `epoch` (from the store, or a random UUID until S2.1), the capabilities, `repo_root`, `app_config_identity`.
- `PROTOCOL` 24 to 25 in `main.ts:26` and `protocol.rs:15` (the second socket is an op-set change).

**Tests.** `bun test` with connect-node over a temp socket: a wrong token gives UNAUTHENTICATED; no token gives `Hello` with AGENT only, and any non-AGENT RPC gives PERMISSION_DENIED; the right token gives `Hello` with VIEW, ACT, APPROVE and ADMIN when the peer is the expected executable and VIEW and ACT when it is not; the secret file is gone before the socket accepts. `cargo test` for `daemon_command` argument order. `protocol_gate_test.sh` passes at 25.

**Accept.**
- `(cd alinery-app/src-tauri/vinculum-daemon && bun test src/rpc)`: the cases above pass.
- Against a daemon started by the app, from a terminal: `curl -s --unix-socket <repo>/.alinery/rpc.sock -H 'content-type: application/json' -H "authorization: Bearer $(cat <the shell's token file>)" -d '{}' http://daemon/alinery.v1.AdminService/Hello` prints JSON with `"protocol":25` and capabilities VIEW and ACT only (curl is not the shell). With `Bearer 00` it prints HTTP 401. With no header it lists AGENT only.
- `ls <repo>/.alinery/` shows `rpc.sock` with mode `srw-------`; no secret file is left in the temp dir the shell used.
- `scripts/tests/protocol_gate_test.sh`: passes.

**Exit.** As Accept.

### S1.2 The webview bridge for real

Status: not started. Needs: S1.1.

**Goal.** Any view can call any daemon service through `daemonTransport(repoKey)`.

**Read first.** 2.1.9; `docs/thick-daemon-spikes/src/bridge-fetch.ts` and `bridge-fetch.test.ts` (the webview half, tested), `docs/thick-daemon-spikes/bridge-rs/src/main.rs` (`call` and `encode_frame`, the shell half); `pump_session_stream` (`session.rs:401`, the batching to copy); `daemon.rs` lane routing (`current_alineryd_socket_path`); `paths.rs` `RepoRef`.

**Build.**
- `src/daemon_rpc.rs` (the module owns the bridge; `lib.rs` only gains two names): `daemon_rpc(request: tauri::ipc::Request, webview: Webview)` and `daemon_rpc_cancel(call_id)`, from `bridge-rs` `call()` plus 2.1.9's rules: channel from the `x-alinery-channel` header, one hyper http1 connection per call, origin-form path with a `host` header, 8 ms or 16 KiB batching, nothing sent after cancel. `hyper` 1.10.1 (`client`, `http1`), `hyper-util` 0.1.20 (`tokio`) and `http-body-util` 0.1.3 become direct dependencies at the versions `Cargo.lock` already holds; `cargo build --locked` downloads them once.
- `daemon_rpc` resolves the repo key with `RepoRef::parse`: local gives `rpc[-ns].sock` for the current lane; remote waits for S1.3 and errors until then. It adds the `authorization` header from the shell's token store; the webview never sees the token.
- `src/daemon/bridgeFetch.ts` from the spike's `bridgeFetch`, calling one wrapper in `ipc.ts` (the IPC rule); it imports nothing from `@tauri-apps/*`.
- `src/daemon/transport.ts`:

```ts
// src/daemon/transport.ts (sketch)
const transports = new Map<string, Transport>();
export function daemonTransport(repo: string): Transport {
  let t = transports.get(repo);
  if (!t) {
    t = createConnectTransport({ baseUrl: "http://daemon", fetch: bridgeFetch(repo), useBinaryFormat: true });
    transports.set(repo, t);
  }
  return t;
}
export const admin = (repo: string) => createClient(AdminService, daemonTransport(repo));
```

- `useDaemonStatus.ts` calls `Hello` once per repo open to read `protocol` and `build_id` (it keeps its poll for live status until S2.5).

**Tests.**
- Rust, `src/tests/daemon_rpc.rs`, against a tiny hyper server on a temp socket: frames for a unary call; a stream of 100 chunks arrives in fewer than 100 channel messages (batching); cancel mid-stream reaches the server; a server that closes early gives END with an error; an unknown repo key errors without touching the filesystem.
- vitest: the spike's six `bridgeFetch` cases, ported to a fake `ipc.daemonRpc`; `daemonTransport` caches per repo.

**Accept.**
- `cargo test -p alinery-app --lib -- tests::daemon_rpc`: all pass.
- `cd alinery-app && npx vitest run src/daemon`: all pass.
- `grep -rn '@tauri-apps' alinery-app/src/daemon`: no output (`check-ipc-boundary.sh` passes).
- **In the real webview** (needs the app running; the user runs it or allows it): open a repo, and in the devtools console `await (await import("/src/daemon/transport.ts")).admin(<repo key>).hello({})` returns the protocol and capabilities VIEW, ACT, APPROVE and ADMIN. This is the one O2 check the spike could not make (4.2). If it fails, stop and ask: O2 is then open again.

**Exit.** A view gets `Hello` from a local daemon through the bridge.

### S1.3 ssh forward for the RPC socket

Status: not started. Needs: S1.2.

**Goal.** `daemon_rpc` reaches a remote repo's daemon through a second forward on the same ControlMaster.

**Read first.** `remote.rs` `forward_socket` :303, `forward_spec` :730, `forward` :738 (`control_op("forward")`); the forward naming in the plan file (`f-<fnv(host\0remote sock)[..16]>.sock`).

**Build.** `forward_socket` already names a forward by host and remote socket path, so the RPC socket is a second call with the remote `rpc[-ns].sock` path. `attach_remote_repo` opens both forwards. Liveness for the RPC forward is a `Hello` through the bridge path (a connect alone proves nothing over a forward, 2.1.3). The token for a remote daemon comes from the shell's per-host store (never written on the host), passed with `--rpc-secret-file` through `SpawnDaemon` and deleted on read like the ui secret.

**Tests.** The live remote test (`cargo test -p alinery-app --lib -- tests::remote::live`, with `remote-sshd/run.sh`) gains: `Hello` through the forward; `-O exit` on the master, reconnect, `Hello` again with the same `epoch` (the daemon didn't restart).

**Accept.**
- `scripts/tests/remote-sshd/run.sh start`, export the printed `ALINERY_TEST_SSH_ARGS`, then `cargo test -p alinery-app --lib -- tests::remote::live`: the two new cases pass; `run.sh stop`.
- `scripts/tests/check-no-auto-session-kill.sh` passes (the forward code sends no shutdown).

**Exit.** A remote repo answers `Hello` through the bridge; disconnect and reconnect keep the epoch.

### S1.4 Shutdown with an origin

Status: not started. Needs: S1.1, S1.2 (the hyper client).

**Goal.** The five teardown origins (invariant 1) call `AdminService.Shutdown` with their `ShutdownOrigin`, and the gate checks the enum's callers.

**Read first.** `scripts/tests/check-no-auto-session-kill.sh`; the five callers: `stop_daemon` (`daemon.rs:1196`), `close_repo_daemon` (`daemon.rs:1292`), `restore_backup`, `confirm_repo_takeover_blocking`, `stop_remote_daemon`; `main.ts:761` (today's `shutdown` op).

**Build.**
- `Shutdown` in `rpc/admin.ts` requires ADMIN, rejects `UNSPECIFIED`, checks `confirmation_id` for `CONFIRMED_TAKEOVER`, logs the origin, then runs the same teardown as `main.ts:761`.
- The shell sends it with Connect JSON (WA): a unary Connect call is a POST with `content-type: application/json`, so `serde_json` and the hyper client from S1.2 are enough, with no protobuf code in Rust. Keep the helper in `daemon_rpc.rs` beside the bridge. Any later unary call the shell makes for itself (S2.5's status read, S4.11's settings write) uses the same helper.
- The gate checks that `ShutdownOrigin::` appears only in the five functions, and that the old `shutdown` op has no new callers (it goes in S5.3).

**Tests.** `bun test`: each origin shuts down; `UNSPECIFIED` is INVALID_ARGUMENT; no ADMIN is PERMISSION_DENIED. The gate fails on a planted sixth caller.

**Accept.**
- `(cd alinery-app/src-tauri/vinculum-daemon && bun test src/rpc)`: the three cases pass.
- `scripts/tests/check-no-auto-session-kill.sh`: exit 0; with a planted `ShutdownOrigin::StopDaemon` call in a sixth function: exit 1 naming it.
- `grep -rn '"shutdown"' alinery-app/src-tauri/src`: only the old-op definitions S5.3 deletes, no callers.

**Exit.** Teardown goes through `Shutdown` with an origin; the old op is unused by the shell.

## P2: Sync engine core

### S2.1 Store and Subscribe

Status: not started. Needs: S1.1.

**Goal.** `SyncService.Subscribe` serves any scope from an in-memory store: snapshot, ring replay, live deltas, backpressure and heartbeats. Only tests commit to the store in this session; S2.3 to S2.6 connect the real feeds.

**Read first.** 2.1.4 (the messages), 2.2.1 to 2.2.7, 2.2.9; `docs/thick-daemon-spikes/src/store.ts` and `store.test.ts` (a working store, replica and property test against the spike's `sync.proto`); the 2.1.7 rule on `ctx.signal`.

**Research (answered 2026-10-27).** protobuf-es 2.16.0 `equals` compares a set oneof field by field, case included (spike test "equals ignores nothing but what we zero"). A client cancel fires `ctx.signal` over connect-node and through the bridge sample (S0.2, S0.3).

**Build.**
- `proto/alinery/v1/sync.proto` and `entities.proto` as in 2.1.4. The oneof field numbers are fixed now. Each entity message gets its fields in the session that first produces it (S2.3 session, S2.4 execution, S2.5 daemon status, S2.6 job, S3.5 task, P4 the rest). Field names are the snake_case form of today's serde names, so proto JSON lines up with the IPC JSON for the conformance tests (S2.3).
- `sync/store.ts`: the store from 2.2.9 (seq taken only once a change exists), a ring of 10,000 changes, `rowsMatching(scope)` filtering keys by 2.2.6, and a `Subscriber` class in the same file: a bounded queue (1,000 frames or 4 MB), a 16 ms coalescing timer, a 15 s heartbeat, and on overflow one `MustRefetch` and the end of the stream. Timers come in through the constructor so tests drive them.
- `store.open(scope, cursor, signal)`:

```ts
// vinculum-daemon/src/sync/store.ts (continued, sketch)
async *open(scope: Scope, cursor: Cursor | undefined, signal: AbortSignal): AsyncGenerator<SubscribeResponse> {
  const sub = new Subscriber(matcher(scope), this.timers);
  this.subs.add(sub);  // same tick as the read below: no commit can fall between them
  try {
    const replay = cursor?.epoch === this.epoch ? this.since(cursor.seq) : undefined;  // undefined if older than the ring
    if (replay) {
      const mine = replay.filter((c) => sub.matches(c));
      if (mine.length) yield delta(mine, this.cursor());
      yield upToDate(this.cursor());
    } else {
      const rows = [...this.rowsMatching(sub.matches)];  // copied now; later commits reach the queue
      yield* snapshotChunks(rows, this.cursor(), 500);    // last chunk has complete = true
    }
    yield* sub.frames(signal);  // live deltas and heartbeats, or one MustRefetch and return
  } finally {
    this.subs.delete(sub);
  }
}
```

- `sync/dedupe.ts`: `once(meta, fn)` keeps the last 256 `mutation_id`s per `client_id` with their answer (or error), in memory. A restart clears it, which matches the epoch rule in 2.2.7.
- `rpc/sync.ts`: `Subscribe` requires VIEW and yields from `store.open`.
- `Hello.epoch` returns `store.epoch` (S1.1 used a random UUID).

**Tests.** `bun test` in `vinculum-daemon/`:
- The spike's seeded property test, ported (20 seeds of 400 commits, dropped and resumed streams, ring rollover, queue overflow): each replica ends equal to `rowsMatching(scope)` with the store's seq as its cursor.
- A cursor from another epoch, or older than the ring, gets a snapshot. A current cursor gets only the missed deltas, then `UpToDate`.
- A subscriber that never reads gets `MustRefetch` after 1,000 frames, and commit time does not grow with it.
- A put equal to the stored row consumes no seq and sends nothing.
- Heartbeats and coalescing with injected timers.
- Dedupe: a repeated `mutation_id` gets the first answer; the 257th id evicts the oldest.
- Aborting the signal removes the subscriber.

**Measure.** 200 subscribers on the repo scope with 10,000 rows: snapshot time and memory per subscriber. Record in 4.1 beside the spike's fan-out numbers (one commit: 0.8 µs at 1 subscriber, 9.1 µs at 100).

**Accept.**
- `(cd alinery-app/src-tauri/vinculum-daemon && bun test src/sync)`: all pass; `bun test --rerun-each 5 src/sync/store.test.ts` passes.
- A connect-node client against a daemon with test rows: `Subscribe` on the repo scope returns a snapshot with `complete = true`, then a heartbeat within 16 s.

**Exit.** As Accept. (Over the bridge it is S3.1's check.)

### S2.2 Platform layer for real

Status: not started. Needs: S0.6.

**Goal.** `writeDurable` matches Rust's durability, `isLockedByOther` exists, and one file sends every signal to a child. (S0.6 already put the flock under `withTaskMutation`.)

**Read first.** 2.3.2 (the S0.5 results and rules); `docs/thick-daemon-spikes/src/lock.ts` (`fcntl` binding, errno read); `mcp.ts:246` (spawn) and `:323` (kill); `terminal.ts:127` (spawn) and `:198` (kill); `scripts/tests/check-no-auto-session-kill.sh`.

**Build.**
- `platform/lock.ts`: `isLockedByOther` as in 2.3.2, beside S0.6's `tryLockExclusive` and `waitForLock`.
- `writeDurable` calls `fcntl(F_FULLFSYNC)` on macOS for the file and the directory (2.3.2), and is used only at the sites Rust makes durable today.
- `platform/process.ts`: `spawnDetached` and `signalChild(child, signal, reason)`. The spawns and kills in `mcp.ts` and `terminal.ts` move there.
- `check-no-auto-session-kill.sh` also scans `vinculum-daemon/src`: `.kill(` and `process.kill(` may appear only in `platform/process.ts`, and every `signalChild` caller is listed in an allowlist with its reason (user kill of a session, MCP child restart, job cancel).

**Tests.**
- `isLockedByOther` is true while the S0.5 Rust helper holds the lock and false after.
- A lock file replaced between open and flock is retried and the new file is locked.
- On macOS, `writeDurable` issues `F_FULLFSYNC` twice per write (a test double for the `fcntl` symbol counts calls).
- The gate fails on a planted `proc.kill()` in `runtime/`.

**Accept.**
- `(cd alinery-app/src-tauri/vinculum-daemon && bun test src/platform)`: all pass.
- `scripts/tests/check-no-auto-session-kill.sh`: exit 0; with a planted `proc.kill()` in `runtime/`: exit 1.
- `grep -rn '\.kill(' alinery-app/src-tauri/vinculum-daemon/src --include='*.ts' | grep -v test | grep -v platform/process.ts`: no output.

**Exit.** As Accept.

### S2.3 Watcher, reconcile and the first parser

Status: not started. Needs: S2.1, S0.4.

**Goal.** Files written by agents, by Rust during the strangler period, or by hand reach the store. Session meta is the first entity fed this way.

**Read first.** 2.2.8 (feed 2); S0.4's watcher choice; `shared.rs:1288` (`read_session_meta_full`) and its tests; `types.ts:447` (`SessionMeta`).

**Research.** Which `SessionMeta` fields Rust writes today and which the daemon writes (grep the `meta.json` writers on both sides), so the parser reads every field either side writes.

**Build.**
- `sync/watcher.ts` wraps the S0.4 WA and follows its rules: a recursive watch on `.alinery/tasks`, a non-recursive one on `.alinery/` filtered to `config.toml`, `harnesses.toml` and `playbooks.toml`; it drops `*.scrollback` and `.tmp.` names before any I/O, debounces per path (WA 50 ms), and routes each path to a parser.
- `sync/parsers/index.ts`: a list of `{ match: RegExp, parse(path): Entity | null }`. `null` deletes the key.
- `sync/parsers/sessionMeta.ts` ports `read_session_meta_full`.
- `sync/reconcile.ts`: every 30 s, stat each tracked file and re-parse it when mtime or size changed; a missing file deletes its key; `readdir` of the task directories finds new files. Async and batched, 256 stats at a time (2.2.8); `docs/thick-daemon-spikes/src/scan-bench.ts` `reconcileAsync` is the pattern.
- Start order in `main.ts`: full scan with the same parsers, then the watcher, then the reconcile timer, then the RPC server listens.
- Conformance layout (WA): `alinery-app/src-tauri/conformance/<domain>/<case>/input/` (a small `.alinery` tree) and `expected.json` (today's serde JSON of the Rust result). A Rust test in `alinery-core/tests/conformance.rs` runs the Rust reader over each case; `UPDATE_FIXTURES=1` rewrites `expected.json`. A `bun test` runs the TypeScript parser over the same cases and compares `toJson(entity)`. Both sides drop null and default-valued fields before comparing, because proto3 JSON omits defaults. The directory outlives Rust (migration rule 5).

**Tests.**
- Writing, renaming over and deleting a `meta.json` gives put, put, delete. Writing the same bytes again gives no frame.
- With the watcher stopped, a changed file appears after one reconcile pass (injected clock).
- Appending 1 MB to a `.scrollback` calls no parser.
- Every session-meta conformance case passes in `cargo test -p alinery-core` and `bun test`.

- The reconcile pass over 1,000 synthetic tasks keeps the longest event-loop gap under 20 ms (measured with a 1 ms interval timer, as the spike did).

**Accept.**
- `(cd alinery-app/src-tauri/vinculum-daemon && bun test src/sync)` and `cargo test -p alinery-core --test conformance`: all pass.
- `UPDATE_FIXTURES=1 cargo test -p alinery-core --test conformance && git diff --exit-code alinery-app/src-tauri/conformance`: no diff.
- **The Linux watcher run S0.4 left.** In `debian:12` (x64 and arm64) under Docker, the spike's `watch.ts matrix --reps 2 --idle-seconds 30`, under `bun run` and compiled (README). Bun's rows show 0 ops with no event and 0 burst misses, and `inotifyWatches` stays under the default `max_user_watches`. If Bun misses events and `@parcel/watcher` does not, switch `sync/watcher.ts` to it (one literal `require` per build target, as `watch.ts:55-66` does) and record the switch in 4.1. If both miss, stop and ask.

**Exit.** A session meta written by Rust reaches a subscriber as a delta.

### S2.4 Engine events

Status: not started. Needs: S2.1.

**Goal.** Each playbook engine event commits the task's execution entity.

**Read first.** `playbook-engine/src/engine.ts:36` (`EngineOptions`), `:93` (`Engine.open`), `:312` (`#append`: `appendLog`, then `apply`); `playbook-engine/src/state.ts:89` (`Event`), `:196` (`appendLog`); `graph.ts:262` (`openTask`, which calls `Engine.open` at :278); `tasks.ts:155` (`executionState`), `:178` (`getTaskExecution`); `types.ts:772` (`ExecutionRecord`), `:802` (`TaskExecutionState`).

**Build.**
- `EngineOptions.onEvent?: (ev: Event, state: State) => void`, called in `#append` after `apply`. An exception from `onEvent` is logged and never fails the engine.
- `openTask` passes `onEvent: () => commitExecution(repo, slug)`.
- `domain/executions.ts`: `commitExecution(repo, slug)` uses the builder that `getTaskExecution` uses, extracted so both call it. The RPC read and the delta can't differ. Until S4.2 moves the engine's state into `execution.json` (O14 b), the entity carries what `getTaskExecution` returns today (`TaskExecutionState`, `types.ts:802`).

**Tests.** Run `alinery-core/tests/fixtures/parallel-numbers.md` through the engine with the fake harness the engine tests already use. A task-scope subscriber sees one execution delta per event, and the last one equals `getTaskExecution`. An `engine.jsonl` written before this change folds to the same state.

**Accept.**
- `(cd playbook-engine && bun test)` and `(cd alinery-app/src-tauri/vinculum-daemon && bun test)`: all pass, the old-log fold case included.

**Exit.** A step finishing in a playbook run reaches a subscriber as an execution delta.

### S2.5 Session, attention and daemon status entities

Status: not started. Needs: S2.3.

**Goal.** The session runner reports every session change to the store, so live status needs no poll.

**Read first.** `main.ts:326` (`startRecordedShell`, `live.set` at :335), `:352` (`sessionState`), `:364` (`openSession`, `live.set` at :382), `:491` (`maybeTitleChat`), `:532` (`watch`; the Attention doc at :549), `:806` and `:859` (`live.set` and `live.delete` in the op dispatch); `terminal.ts:144` (`onExit`); `types.ts:568` (`SessionStatusRef`), `:163` (`TaskActivityStatus`), `:1077` (`DaemonStatus`); `daemon.rs:1516` (Rust `DaemonStatus`), `:1281` (`repo_live_sessions`).

**Build.**
- There is no session-change hook today. Add `onSessionChange(ref)` to `runtime/`, wired in `main.ts` to `commitSession(ref)` in `domain/sessions.ts`. `commitSession` reads the meta through the S2.3 parser and the live state through `sessionState` and commits one Session entity.
- Call it from `startRecordedShell` and the terminal `onExit`, from `openSession`, at each `live.set` and `live.delete`, from the Attention watch when `wait` changes, and from `maybeTitleChat` after the title is written.
- Attention is a field of the Session entity (`wait`: kind, correlation id, prompt), not a key of its own.
- `daemon/_/status` carries the daemon's half of `DaemonStatus`: protocol, build id, live session count, `host_guard_warning`. It commits at start and when the live count changes. The shell keeps `reachable`, `build_drift`, `conflict` and the lanes, because only the shell can see them (WA).

**Tests.** `bun test` starts a Terminal session running `sh`. A subscriber sees a put while it runs and a put after `exit`. Setting and clearing the Attention doc gives two deltas. The live count in `daemon/_/status` follows sessions starting and ending.

**Accept.**
- `(cd alinery-app/src-tauri/vinculum-daemon && bun test src/domain/sessions)`: the three cases pass.
- `grep -n 'live.set\|live.delete' alinery-app/src-tauri/vinculum-daemon/src/main.ts`: each hit has a `commitSession` call beside it.

**Exit.** A session-scope subscription shows start, attention and exit with no poll.

### S2.6 Jobs runner

Status: not started. Needs: S2.1, S2.2.

**Goal.** Slow work runs in a child process and reports through the `Job` entity.

**Read first.** 2.3.5; 2.1.5 (`JobService`, `Job`); core `storage.rs` (`storage_info`); `Settings.tsx:518` (the 1 s backup poll); `backup.rs:43-61` (the 2 s debounce).

**Build.**
- `jobs/runner.ts` as in 2.3.5: FIFO per kind, one backup per repo at a time, progress throttled to about 4 per second, cancel through `signalChild`.
- `jobs/child.ts`: `main.ts` hands `--job <kind>` to it before any daemon start-up. It reads params from stdin and writes JSON lines.
- `jobs/storage.ts`: the storage scan, ported from `storage_info`. It only reads, so it can land before S4.9, which deletes the Rust and moves the command.
- `rpc/jobs.ts`: `Start` and `Cancel` require ACT (S4.9 makes purge require ADMIN).
- An ended Job stays in the store for 24 h (WA), so a client that was closed during the job sees its result, then it is deleted.

**Tests.** A fake kind that writes 100 progress lines in 100 ms commits one or two progress updates and the result. A child that exits 1 with no result ends FAILED with the tail of its stderr. Cancel ends CANCELLED and the child is gone. Two backups on one repo run one after the other.

**Accept.**
- `(cd alinery-app/src-tauri/vinculum-daemon && bun test src/jobs)`: all pass.
- Against a running daemon: a storage-scan Job through connect-node reaches DONE, and its `StorageInfo` equals the Rust `storage_info` for the same repo field by field.

**Exit.** `JobService.Start` for a storage scan returns an id, and the Job reaches DONE with a `StorageInfo` result.

## P3: Client library and first slices

### S3.1 Replica and hooks

Status: not started. Needs: S1.2, S1.3 (the polls it deletes serve remote repos too), S2.1, S2.5.

**Goal.** Views read entities through `src/sync/`. Daemon status moves first.

**Read first.** 2.2.10, 2.5; `useDaemonStatus.ts:50`; `Settings.tsx:343-354` (`probeLiveSessions` every 2 s); `App.tsx:132` (`repoLiveSessions` for the close dialog); `daemon.rs:1281`; `src/test/mockIpc.ts`.

**Build.**
- `src/sync/replica.ts` as in 2.2.10, plus the run loop: resubscribe with the last cursor, backoff 0.5, 1, 2, 5 s, `stale` while down.
- `src/sync/hooks.ts`: `useScope(repoKey, scope)` keeps one replica per repo and scope, counts its users and closes the stream when the last view unmounts; `useEntity` and `useEntities` read it.
- `src/test/daemonHarness.ts` as in 2.5.
- `useDaemonStatus` reads `daemon/_/status` and takes `reachable` from the run loop. The shell half (build drift, conflict) stays on its command until P5. The 1.5 s poll goes.
- `Settings.tsx` and `App.tsx:132` read the live count from `daemon/_/status` per open repo. `repo_live_sessions`, its `ipc.ts` wrapper and the 2 s poll go.
- The optimistic overlay (2.2.7) waits for the first port that sends a mutation (S4.1).

**Tests.** vitest with `daemonHarness`: a status delta re-renders the badge with no timer; a dropped stream sets `stale` and keeps the last value; a resubscribe sends the last cursor.

**Accept.**
- `cd alinery-app && npx vitest run src/sync src/useDaemonStatus`: all pass.
- `grep -n 'setInterval\|setTimeout' alinery-app/src/useDaemonStatus.ts`: no output. `grep -rn 'repoLiveSessions\|repo_live_sessions' alinery-app/src alinery-app/src-tauri/src`: no output.
- In the app (the user runs it): with a local and a remote repo open, starting a terminal session updates the live count in Settings within a second, with no poll in the network panel.

**Exit.** `useDaemonStatus` has no interval; `repo_live_sessions` is gone.

### S3.2 Session status

Status: not started. Needs: S3.1.

**Goal.** Session status and attention come from subscriptions; the status pollers and commands go.

**Read first.** The 2.2.11 rows for `shared.tsx`, `TerminalDrawer.tsx`, `ChatView.tsx:185` and `SessionsList.tsx:273`; `shared.tsx:1074` and `:1152` (where attention raises a notification); the status commands `session_status` (`session.rs:832`), `session_list_statuses` (`:1013`, with `:910` and `:1008`), `session_statuses` (`:1076`, with `:1084`) and `chat_session_status` (`chat.rs:395`).

**Build.**
- Each status poller reads the Session entity with `useEntity` in the session or chat scope.
- The attention notification fires on the replica's transition from no `wait` to a `wait`. A snapshot after a reconnect that shows the same `wait` raises nothing. The OS notification itself stays in the shell (`notify_session_attention`); only its trigger moves.
- Delete the four commands, their helpers, their `ipc.ts` wrappers, and the pollers at `shared.tsx:1131` and `:1289`, `TerminalDrawer.tsx:213`, `ChatView.tsx:185` and `SessionsList.tsx:273`.

**Tests.** vitest with `daemonHarness`: a session going from running to waiting to exited updates its badge with no timer; the attention transition raises one notification; a reconnect snapshot with the same `wait` raises none.

**Accept.**
- `cd alinery-app && npx vitest run`: passes.
- `grep -rn 'sessionStatus\|sessionListStatuses\|sessionStatuses\|chatSessionStatus' alinery-app/src --include='*.ts*' | grep -v test`: no output.
- `scripts/tests/check-ipc-commands.sh`: passes.

**Exit.** No session status poll is left in `src/`; the four commands are gone.

### S3.3 WatchTranscript

Status: not started. Needs: S3.1.

**Goal.** Pi transcripts stream from an item index instead of being re-read whole.

**Read first.** 2.1.5 (`WatchTranscript`); `transcript.ts:23` (`TranscriptPart`), `:29` (`TranscriptReply`); `main.ts:446` (`transcriptMessages`), `:882-896` (the `transcript` op); `session_transcript` (`session.rs:1175`, called from `SessionView.tsx:1382`); `read_session_history` (`session.rs:1424`); `ipc.ts:338` (`readChatOmp`), `:380` (`readSessionHistory`), `:385` (`sessionTranscript`).

**Research (answered 2026-10-27, from the pi-durable 1.4.0 package).** pi-durable exports `watchEvents`, marked experimental, which notifies on a conversation's events. WA: use it; if it misbehaves, fall back to the LiveDoc watch the daemon already uses for Attention (`main.ts:532`), and only then to a 250 ms poll per open watch. A session that falls back says so in 4.1.

**Build.**
- `TranscriptItem` in `sessions.proto`, built from `TranscriptReply` and `TranscriptPart`.
- `runtime/transcript.ts`: `watchTranscript(ref, fromItem, signal)` sends the items from `fromItem`, then waits for a change. When an earlier item changed (a streaming message updated in place), it sends from that item with `replace = true`.
- `rpc/sessions.ts`: `WatchTranscript` requires VIEW.
- `SessionView` and `ChatView` render from the stream. Delete `session_transcript`, the `transcript` op, and `read_chat_omp` and `read_session_history` if nothing else calls them, with their wrappers.

**Tests.** `bun test`: from item 0 gets everything; an append sends only the new item; editing the last item sends it with `replace`; resuming at `next_item` sends nothing old.

**Accept.**
- `(cd alinery-app/src-tauri/vinculum-daemon && bun test src/runtime/transcript)`: the four cases pass.
- `grep -n '"transcript"' alinery-app/src-tauri/vinculum-daemon/src/main.ts` and `grep -rn 'sessionTranscript' alinery-app/src`: no output.

**Exit.** A Pi transcript renders from `WatchTranscript`; the `transcript` op is gone.

### S3.4 Terminal

Status: not started. Needs: S3.1, S1.3.

**Goal.** xterm reads `Attach` and writes `Write` with `input_seq`; the app-side pump and ordered queue go. Measure O8.

**Read first.** 2.1.5 (`TerminalService`); `terminal.ts:7` (`REPLAY_BYTES`), `:88` (append), `:149` (`attachShell`), `:162` (replay); `daemon.rs:450` (the pump); `session.rs:384` (the padded channel frames), `:401` (`pump_session_stream`), `:684` and `:690` (`queue_terminal_op`).

**Build.**
- `rpc/terminal.ts`: `Attach` replays from `from_offset` (0 sends the last `REPLAY_BYTES`, as today) and then streams live bytes, each frame carrying its offset. A VIEW-only caller attaches read-only and `Write` refuses it.
- `Write` applies each `attach_id`'s writes in `input_seq` order and holds a gap for up to 2 s, then applies in arrival order and logs it (2.1.5).
- `SessionTerminal` uses a `TerminalService` client, keeps the last offset it rendered and reattaches from it.
- Delete the pump, `pump_session_stream`, `queue_terminal_op` and its chat arms, and the terminal commands with their wrappers.

**Measure (O8).** Keystroke to echo, locally, through the bridge and over a real ssh forward, against today's path. Record in 4.1. If the split path is more than 5 ms slower at p50, put O8 (b) to the user.

**Tests.** `bun test`: a reattach from an offset gets exactly the bytes after it; writes sent out of order apply in `input_seq` order; a gap over 2 s applies in arrival order. vitest: `SessionTerminal` reattaches from its last offset.

**Accept.**
- `(cd alinery-app/src-tauri/vinculum-daemon && bun test src/rpc/terminal)` and `cd alinery-app && npx vitest run src/SessionTerminal`: all pass.
- `grep -rn 'pump_session_stream\|queue_terminal_op' alinery-app/src-tauri/src`: no output.
- The O8 numbers are in 4.1 for local, bridge and ssh forward.
- In the app (the user runs it): in a remote Terminal session, `seq 1 100000`, then `ssh -O exit` on the host's ControlMaster while it prints; after the reconnect the output has every number once.

**Exit.** A remote terminal survives a forward drop with no duplicated output; the pump and the queue are gone.

### S3.5 Board reads

Status: not started. Needs: S3.1, S2.3, S2.4.

**Goal.** Tasks and the board come from the repo scope, and the 8 board-read `RepoOp` variants retire (2.3.3).

**Read first.** `task.rs:603` (`list_tasks`), `:618` (`list_board_tasks`), `:645` (`list_task_activity`); `session.rs:41` (`get_session_display`); `board.rs:166-171` (current step); `types.ts:163` (`TaskActivityStatus`); the board rows of 2.2.11; Rust's task frontmatter tests.

**Build.**
- `sync/parsers/task.ts`: `task.md` TOML frontmatter with `Bun.TOML.parse` (built in, no dependency), with conformance cases from the Rust parse tests.
- The current step is derived in the daemon (R3): a field of the Task entity, ported from `board.rs:166-171`, recomputed when a session or execution of that task commits. The Rust copy goes in this session.
- Every caller of the 8 board reads (ListBoardTasks, ListTasks, GetTask, TaskActivity, ListSessions, ListSessionItems, ReadSessionMetas, GetSessionDisplay) moves to a subscription, including the non-board callers of `get_task`, `list_sessions` and `list_session_items`. The 8 variants, their `run()` arms, their round-trip test entries, the commands and the pollers in 2.2.11 go.
- O19 is decided (a), D7: a client needs a connected, compatible daemon to work on a repo. Today a repo whose daemon is down, speaks another protocol, or belongs to another app instance still shows its board, read from files (`README.md:87`; `DaemonConflict` in AGENTS.md). After this session such a repo shows only its banner: connect for a host that is down, and the explicit restart (`DaemonConflictBanner`) for a conflict. `attach_remote_repo` keeps recording the conflict but no longer opens a board through the repo service.
- The all-repos board becomes one subscription per repo. Today a local repo that fails to read fails the whole board (`task.rs:625`, `?` on the local arm) while a remote one is skipped; after this each repo shows its own stale banner.

**Tests.** Task conformance cases and current-step cases (from `board.rs` tests) in cargo and bun. vitest: a Kanban card moves when an execution delta arrives; with one repo's daemon down, the other repo's board stays live and the down one shows stale; a repo opened with a conflicted daemon shows the banner and no tasks.

**Accept.**
- `cargo test --workspace` and `(cd alinery-app/src-tauri/vinculum-daemon && bun test)`: task and current-step conformance cases pass on both sides.
- `grep -n 'ListBoardTasks\|ListTasks\|GetTask\b\|TaskActivity\|ListSessions\b\|ListSessionItems\|ReadSessionMetas\|GetSessionDisplay' alinery-app/src-tauri/alinery-core/src/repo_service.rs`: no output.
- `scripts/tests/check-remote-routing.sh` and `check-remote-offload.sh`: pass.

**Exit.** No board poller is left; the 8 variants are gone; `remote-local-only.txt` and `remote-offload-ok.txt` lose their entries for the deleted commands.

## P4: Domain ports

Every P4 session follows the same recipe. Its **Build** lists only what the recipe doesn't cover.

**The port recipe.**
1. **Fixtures first.** Turn the domain's Rust tests into `conformance/<domain>/<case>/` (layout in S2.3) and make them pass against Rust with `UPDATE_FIXTURES=1` before any TypeScript exists. A write case also keeps an `after/` tree: the files the command left behind, compared byte for byte except where the session names a field that may differ (a timestamp, a random id).
2. **Read model.** `sync/parsers/<domain>.ts` and the entity's fields, fed by the watcher, so the UI can subscribe while Rust still writes (rule 4). Skip it when an earlier session already did.
3. **Write path.** `domain/<domain>.ts` writes through `platform/fs` inside `withTaskMutation`, then calls `store.commit`. The fixtures now run against TypeScript too.
4. **Service.** `proto/alinery/v1/<domain>.proto` in the 2.1.6 shape, and `rpc/<domain>.ts` with the capability each call needs.
5. **Flip every caller in one PR** (rule 2): the views, and the MIXED halves this session owns (S0.7 list).
6. **Telemetry** (O17): the events the session names move to the daemon's sender (`platform/telemetry.ts`, S4.1), and their Rust `emit` calls go with the commands.
7. **Delete**: the Tauri commands and their `generate_handler!` names; the `ipc.ts` wrappers and their `mockIpc` entries; the `RepoOp` variants with their `run()` arms and round-trip entries; core functions left with no caller; the entries in `remote-local-only.txt` and `remote-offload-ok.txt`.
8. **Bump `PROTOCOL`** (`protocol.rs:15` and `main.ts:26`).
9. **Records.** Status line, the 1.4 counts, 4.1 for any decision, 4.5.

The delete (step 7) is its own commit, after the commit that flips the callers. At the commit before it, both sides of the conformance suite still run, so a reviewer can check the port against Rust there.

**Accept, for every P4 session.** Each session lists only what it adds.
- At the commit before the delete: `cargo test -p alinery-core --test conformance` and `(cd alinery-app/src-tauri/vinculum-daemon && bun test)` pass, and the domain's cases run on both sides (the number of `conformance/<domain>/*/` directories equals the number of cases each side reports).
- At the session's last commit: `(cd alinery-app/src-tauri/vinculum-daemon && bun test)` passes over the same `expected.json` files (`git diff <port commit> -- alinery-app/src-tauri/conformance/<domain>` shows no change to any `expected.json`).
- For each deleted command: `rg -nw '<command>' alinery-app/src alinery-app/src-tauri/src` finds nothing; `scripts/tests/check-ipc-commands.sh` and `check-ipc-boundary.sh` exit 0.
- `scripts/tests/check-protocol-version-bump.sh`: exit 0.
- `./scripts/check.sh`: exit 0, at check-in.

**The standing exception to rule 2: `alinery-mcp`.** Agents call it, and it writes these itself until S5.1 settles O10 (the last five were found in the plan review): settings TOML (`write_toml_file`, `mcp/src/main.rs:1154`, a plain `fs::write` with no lock), task creation (`create_task`, `:1196`), the playbook library (`call_playbook_library`, `:528`), the pre-archive backup (`create_pre_archive_backup`, `:397`), task archive (`archive_task_guarded`, `:1079`), subtask finalize (`finalize_subtask`, `:1062`), purge (`purge_archived_storage`, `:1110`), backup now (`create_backup`, `:1128`) and the review handoff (`send_review_handoff_for_repos`, `:906`). The session that ports one of those domains moves the MCP write under the shared flock if it isn't already there, and keeps the core function it calls. The watcher picks up its writes (2.2.8). S5.1 deletes what is left.

### S4.1 Settings

Status: not started. Needs: S3.1, S2.3, S2.2 (`writeAtomic`, `withTaskMutation`).

**Goal.** The daemon owns repo `config.toml`, `harnesses.toml` and the effective settings; the shell keeps global `app.toml`. The first mutation lands, and with it the optimistic overlay. Fixes R3 for settings precedence.

**Read first.** App `settings.rs`: `:97-99` (absent inherits, a present blank string is a value), `read_overrides` :125, `write_overrides` :132, `scoped_for` :148, `read_config` :166, `read_config_for_repo` :172, `read_global_settings` :178, `write_global_settings` :229, `read_scoped_settings_for_repo` :261, `read_repo_overrides_for_repo` :267, `emit_repo_settings_change` :272, `write_repo_overrides_for_repo` :283, `clear_repo_override_for_repo` :300, `write_config` :315. Core `shared.rs` from :756: `ScopedSettings` :765, `resolve_backup` :816, `resolve_effective_config` :827, `read_scoped_settings` :843, `clear_repo_override` :861, the harness overlay :888-:1049. Core `types.rs:917` (`RepoOverrides`: github, defaults, backup); core `settings.rs:290`, `:296`, `:326` (the TOML writes) and `:483` (`log_repo_settings_event`). Daemon `sessionControls.ts:75-123` (the second precedence). 2.2.7.

**Research (answered 2026-10-27, `docs/thick-daemon-spikes/src/toml-roundtrip.ts`).** Bun 1.4.3 has `Bun.TOML.stringify`. Each of this repo's 43 `task.md` files, parsed and written again with `Bun.TOML.stringify`, comes out byte for byte as Rust's `toml::to_string` wrote it. `config.toml` differs only by its header comment, which Rust's own write drops too (core `settings.rs:326` writes `toml::to_string(overrides)`). smol-toml 1.9.1 matches 5 of 44 files (same values, different layout).
- **WA: write with `Bun.TOML.stringify`.** smol-toml stays where it parses today (`graph.ts:6`, `sessionControls.ts:6`, `playbook-md.ts:10`).
- The bytes follow key order, so each TypeScript shape lists its keys in the Rust struct's field order. A golden test per written shape (`RepoOverrides`, `task.md`) compares against bytes Rust wrote.
- UNCONFIRMED (4.2): `Bun.TOML.stringify` is missing from Bun's API docs. If a Bun upgrade drops or changes it, the golden test fails; the fallback is smol-toml with new golden bytes, which are a format change Rust readers accept (same values).

**Build.**
- `domain/settings.ts`: `effectiveSettings(global, repo)` ported from `resolve_effective_config`, with the precedence of `:97-99`. `sessionControls.ts:75-123` calls it; its own copy goes.

```ts
// vinculum-daemon/src/domain/settings.ts (sketch)
export function pick<T>(repo: T | undefined, global: T): Scoped<T> {
  return repo === undefined ? { value: global, source: Source.GLOBAL } : { value: repo, source: Source.REPOSITORY };
}
// "" is a value: a repo that blanks a field means blank, not inherit.
```

- The entity `settings/_/repo`: every field as value plus source (the `ScopedSettings` shape), the raw overrides, and the effective harness list. It commits when `config.toml`, `harnesses.toml` or `app.toml` changes; add `app.toml` to the watch list (locally the shell's file, remotely the rendered copy the shell pushes).
- `SettingsService.WriteOverrides` (the whole `RepoOverrides`, `expected_revision`, ACT) and `ClearOverride` (one key, ACT). Both run inside `withTaskMutation`, write with `writeAtomic` and call the ported `log_repo_settings_event` into the daemon log.
- `src/sync/overlay.ts` (2.2.7): the Settings view applies its write locally and drops the overlay at `Applied.cursor.seq`. An ABORTED reply refetches and shows the newer values.
- Global settings stay in the shell: `read_global_settings`, `write_global_settings`, the model favorites. When they change the shell re-renders the remote `app.toml` and pushes it, as today.
- `alinery-mcp` `write_toml_file` (`main.rs:1154`) takes the flock (see the exception above).
- **`RepoService.EnsureReady`** (ADMIN), the repo half of `set_active_repo` (2.3.4), ported from `ensure_repo_ready` (app `paths.rs:203`): `.alinery/`, the ignore entry (`ensure_task_data_ignored`), `harnesses.toml`, `config.toml`. Idempotent. The shell calls it once the daemon answers `Hello`, for local and remote repos alike. Today a remote repo never runs it (`activate_remote_repo`, `remote.rs:1417`, only attaches): it gets `config.toml` on its first settings read, and the ignore entry only when a task is created (core `task_creation.rs:300`). The daemon already creates `.alinery/` for its socket (`main.ts:124`).
- **Telemetry sender (O17 c).** `platform/telemetry.ts` ports core `telemetry.rs`: the consent rule (`consented` :563: enabled, prompted, and an install id), the record shape (`event_record` :506), the allowlists, the ingest URL and the basic auth. A send is one `fetch` with a 2 s `AbortSignal.timeout`, not awaited by the caller; any failure, an unreachable URL included, is dropped. No queue and no retry, as in Rust today (the comment above `send`, :530).
- Consent is read from `app.toml`, which is on the watch list above, so a change applies without a restart. `render_remote_app_toml` (`remote.rs:490`) stops blanking `telemetry` and copies `enabled`, `prompted`, `install_id` and `endpoint`, so a remote daemon sends under the Mac's install id; its doc comment ("the host records no events under this install") changes with it.
- `check-telemetry-privacy.sh` also scans `vinculum-daemon/src`: only `platform/telemetry.ts` builds an ingest request, and the banned fields apply there too.
- Worked example: `SettingsChange` for repo settings (`emit_repo_settings_change`, `settings.rs:272`) moves to the daemon. Global settings stay in the shell, and so does their `SettingsChange` (`settings.rs:251`). Events with no repo stay in the shell for good: `AppOpen`, `SettingsTelemetry`, `RepoActivate`, `RepoRemove`, `DaemonStop`, `McpToggle`, and `ImportFetch` (S4.10).

**Tests.** Conformance from the core `settings.rs` tests and `shared.rs` precedence cases: absent inherits, blank wins, a clear restores the global value. `after/` trees for write and clear. vitest: the overlay shows the new value at once, keeps it until the cursor passes, and rolls back on an error. Telemetry: one fixture event gives the same JSON record from Rust's `event_record` and the TypeScript port; with consent off nothing is sent; an unreachable endpoint neither throws nor delays the command.

**Accept.**
- `(cd alinery-app/src-tauri/vinculum-daemon && bun test src/domain/settings src/platform/telemetry)`: all pass, the golden TOML cases included.
- `rg -n 'smol-toml|from "smol-toml"' alinery-app/src-tauri/vinculum-daemon/src/sessionControls.ts`: no hit (its precedence copy and the import go together); `rg -n effectiveSettings` there finds the call.
- On a scratch git repo, against a running daemon: `EnsureReady` twice. After the first, `.alinery/config.toml` and `.alinery/harnesses.toml` exist and `git check-ignore -q .alinery/tasks` exits 0. The second call changes no mtime under `.alinery/`.
- `WriteOverrides` with a stale `expected_revision`: ABORTED, and `config.toml` is unchanged (sha256 before and after).
- Telemetry, with a local HTTP listener as the endpoint in `app.toml`: one repo settings write sends one record whose JSON equals Rust's `event_record` for the same event (fixture). With consent off, the listener gets nothing within 3 s. `scripts/tests/check-telemetry-privacy.sh`: exit 0.

**Exit.** The settings commands above, `ReadRepoOverrides` and `WriteRepoOverrides`, and the TS precedence copy are gone. `read_config` callers read `settings/_/repo`.

### S4.2 Executions

Status: not started. Needs: S4.1, S2.4. O14 and O21 are Decided (2026-10-27).

**Goal.** One execution state machine in TypeScript (R2), with `execution.json` as its only truth (O14 b), and execution reads and approvals through the store.

**Read first.** The O14 trace in 4.1 (done in the plan review), and its six disagreements. Core `execution.rs`: `ExecutionRecord` :124, `TaskExecutionState` :145, `mutate_execution_state` :325, `reserve_execution` :496, the transitions :619-:857, `execution_assignment_prompt` :866; `execution_tests.rs` (53 tests). App `daemon.rs`: `task_execution_for` :76, `observe_task_executions_in` :207, `observe_task_executions` :328, `observe_remote_task_execution` :364, `allow_execution_completion` :417. `ipc.ts:350-353`. Daemon `tasks.ts`: `executionState` :155, `getTaskExecution` :178, `addExecution` :291; `graph.ts:107` (`logHasStart`), `:262-306` (`openTask`). `playbook-engine/src/state.ts` (`State` :82, `Event` :89, `apply` :105, `readLog` :175, `appendLog` :196) and `engine.ts` (`EngineOptions.logPath` :39, `Engine.open` :93, `#append` :312).

**Build.**
- **O14 (b): execution state lives in `execution.json`, not in the log.**
  - `execution.json` gains what only the fold holds today (disagreements 1 to 3): the seeds, each execution's inputs, `outDir`, `origin`, receipt and failure, and the ambiguities, under the engine's own `eN` ids in place of placeholder UUIDs. Every field Rust writes today stays, because those writers keep running until their ports (the caveat below).
  - The engine keeps `apply` and the `Event` type, but persists `State` instead of events. `EngineOptions.logPath` becomes `load(): State` and `save(state): void`; `#append` becomes `apply`, then `save`. `save` runs inside `withTaskMutation` and writes with `writeDurable` (2.3.2): about 10 ms per save on macOS (S0.5), a few saves per step. `Engine.open` takes `load()`.
  - One restart rule (disagreement 4), the `owning_lane` check (5) and `execution_id` on every engine session (6), all read from `execution.json`. `logHasStart` reads it too.
  - **Existing logs (WA).** A task with an `engine.jsonl` and no engine state in `execution.json` is converted once, at its first open: fold the log, save the state. The log file stays where it is and is never read or written again. New tasks get no `engine.jsonl`.
- **O21 (b): records the old Rust runner wrote show as finished history, read-only, and never run again.** WA for spotting them: `execution.json` has records but no engine state, and the task has no `engine.jsonl`. (Task creation writes an empty `executions` list, `task_creation.rs`, so a new task never matches.) Such a task is never seeded, reserved or launched; its records reach the execution entity unchanged, and the UI shows them without approve or resume actions.
- `domain/executions.ts`: the transitions ported from `execution.rs` :219-:866, writing `execution.json`.
- The execution entity (from S2.4) gets every field the views read. `ExecutionService.AllowCompletion` (APPROVE, `expected_revision`) replaces `allow_execution_completion`.
- The four observe commands and `ipc.ts:351-353` go; their callers read the execution entity.
- **Caveat, rule 2 does not hold yet.** Besides `execution.rs` (:319, :325), these write `execution.json` in production (the trace): core `task_creation.rs` (:354, :358, :414, :443), core `task.rs:378` (`auto_approve_all`), core `repo_ownership.rs:290` (reached from the daemon through `ownership_ffi.rs:35`), and core `subtask.rs:436`, which goes through `task_creation`. `session_name.rs` only reads. They keep writing, under the shared flock, until S4.3 (task creation, auto-approve), S4.8 (subtasks) and S4.11 (ownership) port them. The watcher commits the Rust writes. Write this down in 4.1 as a known exception.
- The daemon's own `addExecution` (`tasks.ts:291`) writes today with no lock, a plain `writeFileSync` and no revision. It moves under `withTaskMutation` and `writeAtomic` first, before any transition is ported.

**Tests.** Conformance from the 53 `execution_tests.rs` cases (state in, transition, state and files out). An interop test: a Rust `reserve_execution` and a TypeScript transition on one task, interleaved, end in a valid state. vitest: approving moves the card once the delta arrives.

**Accept.**
- One conformance case per `execution_tests.rs` test (53), or a line in the PR naming the test and why it has no case.
- `(cd playbook-engine && bun test)`: kill the engine after each save in a seeded run of `alinery-core/tests/fixtures/parallel-numbers.md`, reopen it from `execution.json` alone, and it finishes with the same receipts as an uninterrupted run.
- Conversion: a fixture task with a pre-change `engine.jsonl` opens to the same state the old fold gave, and the log's bytes are unchanged afterwards.
- O21: a fixture with old-runner records and no `engine.jsonl` starts no session after a daemon restart, and its execution entity equals the records on disk.
- `rg -n 'appendLog|readLog' alinery-app/src-tauri/vinculum-daemon/src playbook-engine/src --glob '!*.test.ts'`: only the one-time conversion reads a log; nothing appends one.
- `(cd alinery-app/src-tauri/vinculum-daemon && bun test src/domain/executions)`: the interop case provisions a task through `alinery_provision_task` (the FFI that stays until S4.3) and interleaves 100 TypeScript transitions with it in a seeded order. Every round ends in a state the fold accepts.
- With the task flock held by another process (`docs/thick-daemon-spikes/lock-rs`), `addExecution` waits, and returns within 100 ms of the release.
- `rg -n 'observe_task_executions|observe_remote_task_execution|allow_execution_completion|SavedExecution' alinery-app/src alinery-app/src-tauri/src`: nothing.
- 4.1 has the multi-writer note with one owning session per Rust writer.

**Exit.** `SavedExecution` and the observe and allow commands are gone. R2 is closed: `execution.json` is the one truth. The multi-writer note in 4.1 lists which sessions remove each Rust writer.

### S4.3 Tasks, drafts, attachments

Status: not started. Needs: S4.2, S3.5.

**Goal.** Task create, rename, duplicate, archive, restore, drafts and attachments are daemon commands. The daemon stops calling `alinery_provision_task` over FFI.

**Read first.** App `task.rs`: `get_task` :39, `create_task` :55, `rename_task` :71, `duplicate_task_for_repo` :92, `archive_task_in` :654, `restore_task_in` :658, `archive_task_off_thread` :662 (PreArchive backup at :670 and :685, `TaskArchive` at :692), `archive_task` :701. Core `task_creation.rs`, `task.rs`, `task_drafts.rs`, `attachments.rs`, `task_activity.rs`. Daemon `tasks.ts:65` (`coreCall`) and `:332` (the provision call), `provision_ffi.rs:58`. `artifacts.rs` `attachment_path`. 2.1.5 (`BlobService`).

**Build.**
- `domain/tasks.ts`: create (slug, `task.md`, worktree, execution reservation from S4.2), rename, duplicate, archive, restore, auto-approve, related tasks.
- `platform/git.ts` gets `worktreeAdd`. It is the only git spawn site (invariant 3).
- Drop `alinery_provision_task` from `tasks.ts`; `provision_ffi.rs:58` and its export go. `alinery_create_subtask` and `alinery_set_session_name` stay until S4.8 and S4.4.
- **Pre-archive backup (WA, breaks a cycle).** The backup job is built in S4.9, which needs this session. Until then the shell keeps the Rust pre-archive backup (`task.rs:670` and `:685`): it runs it and calls `TaskService.ArchiveTask` only when it succeeds, as today. S4.9 moves the backup into the archive command as a job and deletes the shell half.
- `open_session`'s meta preflight (app `session.rs:505`, the meta read at `:529`) moves into the daemon's attach (2.3.4). The hosted refresh stays in the shell (S4.11).
- Attachments: this session builds the upload half of `BlobService` (`BeginUpload`, `UploadChunk`, `CommitUpload`; 2.1.5). The shell reads a picked or dropped file and uploads it; `CommitUpload` writes it under `artifacts/attachments/`. `copy_chat_attachments` (`task.rs:282`) becomes this upload, and S4.4 reuses it for chat. `attachment_path` becomes a shell reveal of a `BlobRef` on a local repo and is hidden for a remote one.
- Drafts are entities (`draft/*`); the draft commands become `DraftService` writes.
- MIXED halves from S0.7 that create a session after a task (rule "builds a domain request, then creates a session") become one daemon command.
- `alinery-mcp` `create_task` (`main.rs:1196`) stays on core under the flock until S5.1.
- Telemetry: `TaskArchive` (`task.rs:692`).

**Tests.** Conformance from the `task_creation.rs`, `task_drafts.rs` and `attachments.rs` tests, with `after/` trees (the slug and timestamps may differ). An archive whose backup job fails leaves the task unarchived. vitest: create shows the card at once through the overlay.

**Accept.**
- `rg -n alinery_provision_task alinery-app/src-tauri`: nothing.
- Through connect-node: a 5 MB file uploaded in 64 KiB chunks lands under `artifacts/attachments/` with the same sha256. A `BeginUpload` whose name holds `..` or `/` is INVALID_ARGUMENT, and nothing is written.
- Archive with the backup destination set to a plain file: the backup fails, the task stays unarchived, and the error reaches the UI (vitest).
- vitest: a created task shows its card before the delta arrives, and exactly once after.

**Exit.** The 14 variants in 2.3.3, the task commands and `provision_task` FFI are gone.

### S4.4 Session meta and chat

Status: not started. Needs: S4.3.

**Goal.** Session meta writes, message actions, history and chat threads move to the daemon, which already runs these sessions.

**Read first.** Core `session_name.rs`, `session_actions.rs`, `history.rs`, `chat.rs`, `message.rs`; app `chat.rs` and `session.rs`; `notify.rs` (`notify_session_attention`, `set_dock_badge_count`, `notify_test`); daemon `tasks.ts:55-58` (`suggestSessionName`, calling `alinery_set_session_name`, `provision_ffi.rs:89`). Pollers `ChatView.tsx:300` and `QuickChat.tsx:227`.

**Build.**
- `domain/sessions.ts`: rename, archive stamp, notification read and clear, message actions (finalize, prepare review approval), history and the OMP window.
- `SessionService` unary writes (2.1.5): `CreateSession`, `StartSession`, `RenameSession`, `ArchiveSession`, `KillSession`, `ResumeSession`, each with `MutationMeta` first. They replace the JSON-lines ops of the same job and the Rust proxies. `ArchiveSession` writes the stamp, then kills, in that order (2.3.4 rule 2; `archive_session` :321 and `_for_repo` :369). Kill needs ACT.
- `close_all_repos`'s exited-session acks (2.3.4) become `ArchiveSession` calls.
- Session naming moves into TypeScript; `suggestSessionName` and `alinery_set_session_name` go.
- Chat threads are entities in the chat scope: list, create, start, pin, archive, worktree add and remove, branch label, attachments (through `BlobService`), images (through `BlobService.Read`).
- The Session entity gets the attention body. `notify_session_attention` keeps the OS notification in the shell; the text comes from the entity, so the shell reads no meta file.
- The two chat pollers read the chat scope.
- Telemetry: `SessionArchive` (`session.rs:310`), `SessionKill` (`session.rs:1321`).

**Tests.** Conformance from the `session_name.rs`, `history.rs` and `chat.rs` tests. vitest: a new chat thread appears in the rail with no poll; a renamed session updates everywhere it shows.

**Accept.**
- `rg -n 'alinery_set_session_name|suggestSessionName' alinery-app/src-tauri`: nothing.
- `rg -n 'setInterval|setTimeout' alinery-app/src/views/ChatView.tsx alinery-app/src/views/QuickChat.tsx`: no timer that calls a chat command (the pollers at `ChatView.tsx:300` and `QuickChat.tsx:227`).
- Against a running daemon: `ArchiveSession` on a live Terminal session leaves the meta stamped and the process gone, and a subscriber sees the stamp put before the exit put.
- vitest: a chat attachment dropped in the composer goes through the S4.3 upload (the mock sees `BeginUpload`, not a path).

**Exit.** The 10 session variants and 12 chat variants in 2.3.3 are gone, with their commands, both pollers and the naming FFI.

### S4.5 Artifacts and comments

Status: not started. Needs: S4.3.

**Goal.** All 25 artifact commands go: artifact metadata and comments are entities, bodies come through `BlobService`.

**Read first.** App `artifacts.rs` (25 commands; `ArtifactReviewHandoff` :176, `ArtifactReviewSend` :505, `ArtifactCommentAdd` :591); core `artifact_tree.rs`, `artifact_comments.rs`; the artifact half of `shared.rs` (:144-:756: `visible_artifact_names` :618, `list_artifacts_with_metadata_for` :651, `list_artifacts_with_execution_metadata` :711). Pollers `SessionView.tsx:719` and `:736`, `TaskDetail.tsx:580`.

**Build.**
- `sync/parsers/artifacts.ts`: the artifact scan, which never sees `artifacts/attachments/`.
- Artifact metadata and comments are entities in the task scope. Comments write with `expected_revision` (2.2.7); drafts of comments too.
- Bodies and images: this session builds `BlobService.ReadBlob` (S4.3 built the upload half). `artifact_node_path` and `artifact_comment_markdown_path_for` become a shell reveal of a `BlobRef`, hidden for remote repos.
- Review handoff and send become one daemon command each.
- The three pollers read the task scope.
- Telemetry: the three events above.

**Tests.** Conformance from `artifact_tree.rs`, `artifact_comments.rs` and the `shared.rs` artifact tests. An agent writing `artifacts/03-plan.md` straight to disk shows up through the watcher. vitest: a comment from another client appears with no poll.

**Accept.**
- `ReadBlob` of a 20 MB artifact through connect-node: frames of at most 64 KiB (WA), and the sha256 of the joined bytes equals the file's. A `BlobRef` that resolves outside `.alinery/tasks/<slug>/artifacts/` (a symlink planted by the test) is PERMISSION_DENIED.
- An agent-style write (`cp` into `artifacts/03-plan.md` from a shell) reaches a task-scope subscriber within 1 s.
- The pollers at `alinery-app/src/views/SessionView.tsx:719`, `:736` and `views/TaskDetail.tsx:580` are gone (`git show` of the session's diff).

**Exit.** The 17 artifact and comment variants, the 25 commands and three pollers are gone.

### S4.6 Playbook library

Status: not started. Needs: S4.1, S0.6.

**Goal.** Playbook read, validate, render, save and delete in TypeScript; one playbook parser (R3).

**Read first.** App `playbook.rs` (9 commands: `list_playbook_catalog`, `read_playbook`, `validate_playbook_source`, `render_playbook_source`, `save_playbook_source`, `delete_playbook_source`, `read_playbook_picker_preferences`, `save_playbook_picker_preferences`, `list_kanban_columns`). Core `playbook_library.rs` (`save_playbook_if_unchanged` :596), `playbook.rs` (`deny_unknown_fields` at :15, :30, :37, :47, :62, :183, :195), `playbook_library.rs` (and at :31, :138, :146, :155), `playbook_tree.rs`. `playbook-engine/` (its own parser). MCP `call_playbook_library` (`main.rs:528`).

**Build.**
- One parser in `playbook-engine/` for both the engine and the library. It rejects unknown fields as `deny_unknown_fields` does.
- Playbooks are entities (`playbook/*`); the catalog and kanban columns are derived from them.
- `save_playbook_if_unchanged` becomes `expected_revision` on `PlaybookService.Save`.
- Validate and render stay unary RPCs (2.1.6: computed answers).
- Picker preferences: the repo half moves; the global half stays with `app.toml` (shell).
- MCP `call_playbook_library` keeps the core path under the flock until S5.1.

**Tests.** Conformance from the `playbook.rs`, `playbook_library.rs` and `playbook_tree.rs` tests, including every unknown-field rejection. A save with a stale revision is ABORTED.

**Accept.**
- One unknown-field conformance case per `deny_unknown_fields` struct (11 today: `rg -c deny_unknown_fields alinery-app/src-tauri/alinery-core/src/playbook.rs alinery-app/src-tauri/alinery-core/src/playbook_library.rs`). Each is rejected on both sides, and the TypeScript error names the field.
- `(cd playbook-engine && bun test)`: passes with the one parser; `rg -n 'smol-toml|parseToml' playbook-engine/src` shows one parse site.
- `cargo test -p alinery-mcp`: passes (MCP still saves through the core library).

**Exit.** `ReadPlaybookTree`, `ApplyPlaybookTree`, the 9 commands and the Rust playbook parser are gone (the core library stays for MCP until S5.1).

### S4.7 Git

Status: not started. Needs: S4.3.

**Goal.** Worktree, branch, commit and push run in the daemon through `platform/git.ts`.

**Read first.** App `git_ops.rs` (11 commands: `task_source_branches_for_repo`, `remove_worktree`, `remove_worktree_for_repo`, `worktree_exists`, `push_and_compare_url`, `push_and_compare_url_for_repo`, `set_pr_url`, `set_pr_url_for_repo`, `list_task_pull_requests`, `commit_worktree`, `commit_worktree_for_repo`); telemetry at `:21`, `:34`, `:425`. Core `git_actions.rs` and the repo half of `git.rs` (the env scrub in `git_cmd`). `check-git-env-scrub.sh`.

**Build.**
- `platform/git.ts` gets the env scrub ported from `git_cmd`, and a gate in the style of `check-git-env-scrub.sh` that allows `Bun.spawn(["git", ...])` only there.
- The `_for_repo` pairs collapse: one RPC each, the repo comes from the connection.
- `list_task_pull_requests` splits: the daemon returns branch and remote URL; the GitHub API call stays in the shell with the Mac's token (2.3.4).
- `set_pr_url` writes `task.md` through the task domain (S4.3).
- Telemetry: `GitWorktreeRemove`, `GitPush`, `GitCommit`.

**Research (UNCONFIRMED).** Which git does the daemon find on a Mac without Command Line Tools? Port the `git_cmd` lookup order (PATH, then the alongside tree with `GIT_EXEC_PATH`) and test it there. On a remote host git comes from PATH (D6); check that the daemon's PATH under `systemd-run --user` and under `setsid` finds the git the setup probe found over ssh exec.

**Tests.** Conformance from the `git_actions.rs` tests against a temp repo. The scrub test: a `GIT_DIR` in the daemon's env does not reach the child.

**Accept.**
- The new gate (`scripts/tests/check-daemon-git-spawn.sh`): exit 0; with a `Bun.spawn(["git"` added to any other daemon file, exit 1.
- `bun test src/platform/git`: the lookup order (PATH, then the alongside tree with `GIT_EXEC_PATH`) with the PATH and "Command Line Tools installed" checks injected, including the case where `/usr/bin/git` is the stub; and the scrub case (`GIT_DIR` in the daemon's env, absent in the child's).
- On the remote-sshd container (`scripts/tests/remote-sshd/run.sh start`): a daemon started with `setsid` runs `git --version` through `platform/git.ts`. `systemd-run --user` needs a VM (VERIFY.md); the container has no user systemd (UNCONFIRMED, 4.2).

**Exit.** The 8 git variants and 11 commands are gone; the daemon has one git spawn site with a gate.

### S4.8 Subtasks

Status: not started. Needs: S4.2, S4.3, S4.4.

**Goal.** The parent and child task lifecycle moves to the daemon, with the last provisioning FFI call.

**Read first.** App `subtask.rs` (`subtask_state`, `start_subtask_manager`, `recover_subtask_manager`, `discard_subtask`). Core `subtask.rs`: `subtask_manager_state` :247, `subtask_manager_request` :298, `create_subtask` :391, `inspect_subtask_finish` :644, `finalize_subtask` :718, `subtask_discard_sessions` :835, `discard_subtask` :890, `ensure_task_can_archive` :933, `archive_task_guarded` :954. Daemon `tasks.ts:438-439` (`createSubtask`) and `:466`, `provision_ffi.rs:66`.

**Build.**
- `domain/subtasks.ts` ported from the functions above.
- `createSubtask` calls the TypeScript domain; `alinery_create_subtask` and the rest of `provision_ffi.rs` go. `tasks.ts:40` (the dlopen) goes if nothing else uses it.
- `subtask.rs` was the last test user of `playbook_scheduler.rs`; S0.6 already removed both.
- The archive guard (`ensure_task_can_archive`) runs inside the task archive command (S4.3).

**Tests.** Conformance from the core `subtask.rs` tests. Discarding a subtask leaves the parent's execution valid.

**Accept.**
- `test ! -e alinery-app/src-tauri/alinery-core/src/provision_ffi.rs`, and `rg -n dlopen alinery-app/src-tauri/vinculum-daemon/src/tasks.ts` finds nothing.
- Discarding a subtask in a conformance case leaves the parent's execution in a state the fold accepts.

**Exit.** The 4 subtask variants and commands are gone, and so is `provision_ffi.rs`.

### S4.9 Storage and backup as jobs

Status: not started. Needs: S2.6, S4.3.

**Goal.** Backup, verify, storage scan and purge are jobs; the backup queue leaves the shell.

**Read first.** App `backup.rs` (`pick_backup_destination_dialog`, `backup_now`, `backup_busy`, `list_backups`, `check_backup_destination`, `restore_backup`; telemetry at :152, :233, :332, :367), `backup.rs:43-61` (the debounce), `backup_queue.rs`; app `settings.rs` `storage_info` :326 and `delete_all_archived_storage` :354 (`StoragePurge` at :391). Core `storage.rs`, `backup.rs`. `src/views/Settings.tsx:518`. 2.3.5.

**Build.**
- **O11 (b): the host's Info-ZIP `zip` writes and `unzip` reads; no zip library in TypeScript.** Why not `fflate`: it reads zip64 but writes none (`wzh` and `wzf` in `fflate/lib/index.cjs`), so its archives stop at 4 GiB or 65,535 entries. Rust's `zip` 8.6 writes zip64 when needed (core `backup.rs:275`). This repo's backup set today: 289 MB in 43 tasks, largest scrollback 53 MB.
  - **Checked in the plan review.** macOS ships `/usr/bin/zip` (Zip 3.0) and `/usr/bin/unzip` (UnZip 6.00), both built with `ZIP64_SUPPORT`. A 70,001-entry archive written by `/usr/bin/zip` listed all 70,001 entries with `unzip -Z1`. A name on the list that no longer exists prints `zip warning: name not matched` and zip still exits 0, which matches `write_archive` skipping a file that vanished (`backup.rs:282`). `debian:12` has neither tool by default.
  - **Today's layout** (`backup.rs:273-291`): `backup-meta.json` at the root, then each curated file named relative to `.alinery/`, deflated. With `zip`: write the meta to a temp directory and add it with `zip -q -j -X <tmp.zip> <dir>/backup-meta.json`, then run `zip -q -X -D <tmp.zip> -@` with its cwd at `.alinery/` and the curated list on stdin. Then rename, as today.
  - **Reading.** `unzip -p <zip> backup-meta.json` for the meta (list and verify). For restore, `unzip -Z1 <zip>` first, every name through a port of `safe_entry_path` (`backup.rs:418`), and the whole archive refused if one fails, as Rust does; then `unzip -q -o <zip> -x backup-meta.json -d <.alinery>`.
  - `zip` and `unzip` join the host probe list (2.3.2, D6), with the install hint the probe gives for git.
  - If the compatibility test below fails and can't be fixed with `zip` flags, stop and ask: splitting a backup into archives under the cap is the user's named fallback.
- The pre-archive backup moves into `TaskService.ArchiveTask` as a job (the S4.3 WA ends): the daemon waits for it and refuses to archive if it fails. The shell half at `task.rs:670` and `:685` goes.
- `jobs/backup.ts` (create and verify) and `jobs/purge.ts`; `jobs/storage.ts` exists from S2.6.
- Automatic triggers: the daemon owns the 2 s debounce and starts backup jobs itself. `backup_queue.rs` and `backup.rs:43-61` go.
- `pick_backup_destination_dialog` stays in the shell; the picked path goes to a settings write (S4.1).
- Storage scan and purge need ADMIN. From S5.1 AGENT reaches them too (O18 b).
- Restore stays `Shutdown(RESTORE_BACKUP)` then a one-shot restore (2.3.5); the shell still runs it locally, and the host bootstrap runs it remotely (O15).
- Telemetry: `BackupCreate`, `BackupRestore`, `StoragePurge`.

**Tests.** The zip compatibility test both ways. A purge job's progress reaches a subscriber; cancel leaves no half-deleted task (each task is removed atomically or not at all).

**Accept.**
- Zip compatibility through fixtures, as conformance: a Rust test writes `conformance/backup/rust-made-v1.zip` and a `bun test` verifies and restores it into a temp repo whose tree equals the source; a `bun test` writes `ts-made-v1.zip` with the host's `zip` and a Rust test verifies and restores it. `UPDATE_FIXTURES=1` regenerates both.
- A `bun test` writes a backup of 70,000 small files with the host's `zip`, and Rust's `read_backup_meta` and `extract_backup_into` read it back whole.
- The archive from `backup.rs:1128-1143` (entries `../../evil.txt` and `/etc/evil.txt`) is refused by the TypeScript restore, and no `evil.txt` exists outside the target afterwards, as that test asserts for Rust.
- `rg -n 'fflate' alinery-app/src-tauri/vinculum-daemon`: nothing.
- `test ! -e alinery-app/src-tauri/src/backup_queue.rs`; the 1 s poll at `alinery-app/src/views/Settings.tsx:518` is gone.
- A purge job cancelled half way: every archived task is either fully present or fully gone (`bun test src/jobs/purge`).
- Archive with a failing backup job: the task stays unarchived (the S4.3 case, now on the daemon side).

**Exit.** The 7 storage and backup variants, `backup_queue.rs`, `storage_info`, `delete_all_archived_storage` and the `Settings.tsx:518` poll are gone.

### S4.10 Imports, community import, agent dir

Status: not started. Needs: S4.3, S4.6.

**Goal.** Issue imports and community playbook imports write through the daemon; the agent dir gets one owner (O12).

**Read first.** App `imports.rs` (`import_linear`, `import_linear_for_repo`, `import_github`, `import_github_for_repo`; `import_github_at` :618; `RepoOp::GitOriginUrl` :625; `ImportFetch` at :187 and :608). `community_playbooks.rs`: repo-scoped at :435, :455, :933, :951, :1343; catalog, preview and mine at :424, :621, :1002. `omp_update.rs` (`omp_agent_sessions_dir`, `read_omp_model_roles`, `write_omp_model_roles`); `vinculum_customizations.rs` (`read_vinculum_customizations`, `open_vinculum_agent_dir`, `vinculum_customization_prompt`, `pick_vinculum_skill_dialog`, `install_vinculum_skill`, `delete_vinculum_skill`).

**Build.**
- Linear and GitHub (2.3.4, "needs this Mac's secrets"): the shell fetches the issues with its tokens and passes them to `TaskService.Import`, which creates the tasks. `GitOriginUrl` becomes a unary RPC the shell calls first.
- Community: the five repo-scoped commands become daemon writes (the shell downloads the package and uploads it through `BlobService` as `PlaybookPackageBlob`, 2.1.5). The catalog, preview and mine commands stay in the shell.
- Put O12 to the user: (a) the agent dir lives per host, the daemon owns it and the shell mirrors the Mac's copy; (b) it lives on the Mac only, the shell owns it and pushes it. Then move the model-role and skill commands to the chosen side. The dialogs (`pick_vinculum_skill_dialog`, `open_vinculum_agent_dir`) stay in the shell either way.
- Telemetry: `ImportFetch` (stays in the shell, which does the fetch).

**Tests.** Conformance for import: a fixed issue list in, task trees out. A community import into a remote repo writes on the host.

**Accept.**
- Conformance: a fixed GitHub issue list and a fixed Linear list in, task trees out (the slug and timestamps may differ).
- On the remote-sshd container: a community import into a remote repo writes the playbook on the host (`ssh … test -f <repo>/.alinery/…`), and nothing under the Mac's copy of the repo key changes.
- 4.1 records O12's answer, and `rg -n 'read_omp_model_roles|install_vinculum_skill' alinery-app/src-tauri/src` matches the side O12 chose.

**Exit.** The import and community commands are split as above; O12 is Decided.

### S4.11 Ownership, takeover, keep-awake, hosted handoff

Status: not started. Needs: S4.2, S4.8, S2.2.

**Goal.** Repo ownership and keep-awake run without `libalinery_core`; the hosted token reaches the daemon as a settings write.

**Read first.** Core `repo_ownership.rs`, `ownership_ffi.rs` (:27, :53), `idle_inhibit.rs` (:25, :40, :45). Daemon `main.ts:224-233` (keep-awake) and `:254-259` (`alinery_pi_acquire`). App `session.rs:458` (`spawn_pi_hosted_refresh`) and `:505` (`open_session`); `daemon.rs` takeover commands.

**Build.**
- Decide O9 with a test on both platforms: (a) keep the IOKit FFI; (b) `caffeinate -w <pid>` on macOS, `systemd-inhibit` on Linux, as a child the daemon holds.
- `domain/ownership.ts`: `repo_ownership.rs` ported onto `platform/lock.ts`, under `withTaskMutation`. It is the last Rust writer of execution state (S4.2 caveat).
- `main.ts:224-233` and `:254-259` stop calling FFI; `ownership_ffi.rs` and (if O9 b) `idle_inhibit.rs` go.
- The hosted refresh (`session.rs:458`) stays in the shell, which holds the account; it sends the token as a settings write instead of a file the daemon reads. (`open_session`'s preflight moved in S4.3.)
- Takeover keeps its app-only prepare, confirm and cancel; confirm sends `Shutdown(CONFIRMED_TAKEOVER)`.

**Tests.** Ownership conformance from the `repo_ownership.rs` tests. Two daemons on one repo: the second gets `repo_busy`. Keep-awake: the inhibitor child exits when the daemon exits.

**Accept.**
- `rg -n 'dlopen|libalinery_core' alinery-app/src-tauri/vinculum-daemon/src`: nothing.
- Two daemons on one scratch repo: the second exits with `repo_busy`, and the first's sessions are untouched.
- Keep-awake under O9 (b): with a session running, `pmset -g assertions` (macOS) or `systemd-inhibit --list` (Linux) shows the daemon's inhibitor; `kill -9` of the daemon removes it within 1 s.

**Exit.** No `libalinery_core` dlopen is left in the daemon (`tasks.ts:15-47` and the FFI in `main.ts` are gone).

### S4.12 Providers and models

Status: not started. Needs: S1.1, S1.2, S1.3.

**Goal.** Provider login, the catalog and model lists are a typed service instead of raw JSON-lines ops.

**Read first.** Daemon `main.ts:964-1021` (the seven `provider_*` and `custom_provider_*` ops: catalog, logout, login start, login poll, login reply, custom save, custom delete); app `session.rs` provider commands (:1215, :1221, :1233, :1239, :1251, all through `active_daemon`); app `settings.rs` `grok_key_ready` :58, `list_harness_models` :74, `list_harness_models_for_repo` :85; `credentials.ts`.

**Build.**
- `ProviderService`: `Catalog`, `LoginStart`, `LoginPoll`, `LoginReply`, `Logout`, `SaveCustom`, `DeleteCustom`, and `ListModels`, which replaces `list_harness_models(_for_repo)`.
- Login and logout need ADMIN: they touch credentials.
- The browser sign-in stays in the shell (it opens the Mac's browser); the daemon holds the device-code poll.
- Credentials sharing with a remote host is unchanged (`RemoteSharing`); this session moves the wire only.

**Tests.** `bun test` with a fake provider: login start, poll, logout. vitest: the model picker reads `ListModels`.

**Accept.**
- `rg -n '"provider_|"custom_provider_' alinery-app/src-tauri/vinculum-daemon/src/main.ts`: nothing.
- `bun test src/rpc/providers` with the fake provider: start, poll, reply, logout. The shell token from a peer that isn't the shell (VIEW and ACT, 2.1.10) gets PERMISSION_DENIED on `LoginStart`.
- On the remote-sshd container: `ListModels` through the forward returns the host's list.

**Exit.** The provider ops leave the JSON-lines wire; the five session commands and the two model-list commands are gone.

## P5: Shell slimming

MCP and the host bootstrap go first, because both still reach the daemon or the repo through code that S5.3 deletes.

### S5.1 MCP as a daemon client (O10)

Status: not started. Needs: S1.1, S1.3, S3.2, S3.5, S4.1, S4.2, S4.3, S4.4, S4.5, S4.6, S4.8, S4.9 (each tool's RPC comes from one of them; the map below), and S1.4 if O10 picks (a). O20 is Decided (c); O22 must be Decided before this session starts.

**Goal.** Every `alinery-mcp` tool goes through the daemon's RPC, and MCP writes no `.alinery/` file itself. This ends the standing exception to rule 2 (P4 intro).

**Read first.** MCP `main.rs` (2,552 lines): the 26 tools at :416-441; `create_pre_archive_backup` :397; `call_playbook_library` :528; `task_client` :588 (its `start_daemon` flag); `connect_compatible` :688; `write_toml_file` :1154; `create_task` :1196. App `mcp.rs` (the managed MCP child). 2.1.10 (the AGENT capability). AGENTS.md: MCP never exposes attach, write, resize, detach, kill, resume, takeover or bulk operations, and a mismatch never triggers teardown.

**Build.**
- Put O10 to the user: (a) Rust `alinery-mcp` stays, and each tool becomes an RPC call (prost messages generated from `proto/`, over HTTP/1.1 on the socket, extending the S1.4 helper); (b) the Bun binary gains an `--mcp` stdio mode that calls the daemon socket with the generated TypeScript client, and the Rust crate keeps only what S5.2 decides. Record the answer in 4.1.
- **MCP is a headless, AI-first client (O18 b), on the daemon's host only (O20 c).** Every tool is an RPC call over the local socket (T1). MCP runs either inside a harness the daemon launched, or as the shell's managed MCP on this Mac. "From any machine" over T2 is dropped for now.
- **AGENT becomes exactly MCP's tools.** After the tool map above, AGENT is the set of RPCs those tools call, storage scan and purge included (`alinery_storage_info` and `alinery_delete_archived_storage`, `main.rs:439-440`), so no tool changes. It never includes `Shutdown`, the rest of ADMIN, or anything that needs APPROVE. An agent that can run MCP can read its token and call those RPCs directly, so this list is what every agent on that machine may do; the user accepted that for purge.
- **Minted tokens (O20 c).** The daemon mints AGENT tokens (`AdminService.MintToken`, ADMIN). It puts one in the environment of each harness it launches, and the shell asks for one for the managed MCP. The no-token row of 2.1.10 goes: every request now carries a token (R8).
- **`alinery_send_review_handoff` reaches two daemons** (`:906`): it copies an artifact from one local repo into another and creates a session there. MCP holds a token for its own daemon only, so O22 decides how the second is reached. Build what O22 says; if it is still Open, stop.
- **Reads are one-shot subscriptions (WA).** A read tool opens `Subscribe` on its scope, keeps the `Snapshot` frames until one has `complete`, and cancels. No unary read RPC is added for MCP (2.1.6).
- `alinery_get_task` and `alinery_read_config` return file text today (`:779`, `:994`). Through the daemon they return `Bun.TOML.stringify` of the entity: the same text for a file Rust wrote (S4.1), and a hand-edited file comes back normalized, comments dropped. Tell the user, with the playbook save change below.
- MCP's own telemetry calls (`TaskArchive` :1084, `StoragePurge` :1117, `BackupCreate` :1133, `SettingsChange` :1177) go: the daemon commands they now call emit those events (O17).
- Map each of the 26 tools to the daemon RPC that replaced its code in P3 and P4. Write the table into this session before coding. `alinery_list_repos` keeps reading `app.toml`, which is app config, not repo state.
- `alinery_save_playbook` behaviour change, tell the user: today a repo save fails `repo_busy` while a desktop window owns the repo. Through the daemon it goes through `PlaybookService.Save` with `expected_revision` and succeeds.
- MCP starts a daemon only where it does today (`task_client` with `start_daemon`), and never calls `Shutdown`; `check-no-auto-session-kill.sh` scans the MCP code (Rust, or the `--mcp` module).
- Delete `write_toml_file`, `create_pre_archive_backup`, the MCP halves of `create_task`, `call_playbook_library` and the five writes the P4 exception lists last, and the core functions P4 kept alive for them (the settings TOML writer, `task_creation.rs`, `playbook_library.rs`, the core backup create, `archive_task_guarded`, `finalize_subtask`, `purge_archived_storage`, `send_review_handoff_for_repos`).
- Update the P4 exception paragraph and 1.8 rule 2: the exception is closed.

**Tests.** Before the change, record each tool's reply on a temp repo as a fixture; after it, the same calls against a real daemon give the same replies, except where this session names a change (the playbook save above). A tool call with a daemon of another protocol fails with the same message as today and starts no teardown. `bun test`: the AGENT set equals the RPCs in the tool map; with an AGENT token, `Shutdown` and every APPROVE call are PERMISSION_DENIED; a request with no token is UNAUTHENTICATED.

**Accept.**
- `rg -n 'std::fs::write|fs::write|write_bytes_durable|create_dir_all' alinery-app/src-tauri/mcp/src` (or the `--mcp` module under O10 b): no hit that writes under `.alinery/`.
- The fixture replay: every one of the 26 tools gives the recorded reply, except the changes this session names.
- `bun test src/rpc/auth`: the AGENT set equals the RPCs in the tool map, and `Shutdown` and every APPROVE RPC are PERMISSION_DENIED for AGENT. No token gives UNAUTHENTICATED.
- `rg -n 'Command::new\("ssh"\)|\["ssh"' alinery-app/src-tauri/mcp/src` (or the `--mcp` module under O10 b): nothing, so MCP opens no ssh forward.
- `scripts/tests/check-no-auto-session-kill.sh`: exit 0, and it scans the MCP code.
- A tool call against a daemon of another protocol: the same error text as today, and the daemon's PID is unchanged.

**Exit.** MCP writes nothing under `.alinery/` and reaches its daemon over T1 with a minted AGENT token; O10 and O22 are in 4.1; the core functions kept for MCP are gone.

### S5.2 Host bootstrap (O15)

Status: not started. Needs: S5.1, S4.9 (restore).

**Goal.** The work a host needs while no daemon runs has one home, and nothing else uses the repo-service channel.

**Read first.** The 11 host-level variants (2.3.3: Ping, ClaimRepo, ReleaseRepo, Classify, Init, ListDir, WriteFile, RemoveFile, SyncCredentials, WaitDaemonGone, SpawnDaemon); `mcp/src/repo_service.rs` (89 lines, the stdio loop); core `repo_service.rs` (1,923); `remote.rs` (`remote_call` :1249, the supervisor :1671); `scripts/build-remote-runtimes.sh` (`bun build` at :80, `cargo zigbuild` at :81); the remote restore (2.3.5).

**Build.**
- Check first: every non-host `RepoOp` variant has no caller left (P3 and P4 deleted them). One with a caller goes back to its port session.
- Put O15 to the user with what S5.1 decided. If O10 picked (b), (b) here takes the last Rust binary off the host: the runtime tarball holds one Bun binary, and the build needs no zig and no cargo-zigbuild (`libalinery_core.so` left in S4.11). If O10 picked (a), `alinery-mcp` ships to the host anyway, and (a) costs little.
- ClaimRepo holds `.alinery/.alinery-app.lock` for the life of the channel, so the bootstrap is a long-lived stdio loop either way, not a one-shot command. Under (b) the Bun binary gets that loop (`--host-service`) on `platform/lock.ts`; the credential merge reuses the `.lock` protocol in `credentials.ts`.
- WA: the host messages move into `proto/alinery/v1/host.proto` (D2) and are framed as `[u32 len][message]` on stdio. A Connect service needs HTTP, which a stdio pipe doesn't have.
- The remote restore (S4.9) runs on this channel while the daemon is down.
- D6 in the setup wizard: today a host without git fails with "the host is missing git" (`remote.rs:433`). Make the refusal name each missing tool and say to install it on that host and run setup again, and show it in `RemoteModal` before anything is installed.
- With the domain commands gone, `check-remote-routing.sh` and `check-remote-offload.sh` only see PROVISION commands. Keep them on those, or delete them with their two `.txt` lists if nothing is listed. Decide from the count.

**Tests.** The live remote test (`cargo test -p alinery-app --lib -- tests::remote::live` with `remote-sshd/run.sh`): connect, ListDir, Classify, Init, ClaimRepo, SpawnDaemon, WaitDaemonGone, and a second claimant gets `repo_busy`. A remote restore while the daemon is down.

**Accept.**
- `rg -o 'RepoOp::[A-Za-z]+' alinery-app/src-tauri/src alinery-app/src-tauri/alinery-core/src | sort -u`: only the 11 host variants, or nothing.
- `scripts/tests/remote-sshd/run.sh start`, export the printed `ALINERY_TEST_SSH_ARGS`, `cargo test -p alinery-app --lib -- tests::remote::live`: all pass, the restore-while-down case included; then `run.sh stop`.
- A unit test feeds the probe parser a canned probe with no git and no tar: the refusal names both tools.
- Under O15 (b): `scripts/build-remote-runtimes.sh --check` asks for no zig and no cargo-zigbuild, and `tar tzf` of each runtime lists one executable.

**Exit.** `RepoOp` is gone or holds only host variants; O15 is in 4.1; under (b), `build-remote-runtimes.sh` no longer needs zig.

### S5.3 Retire the JSON-lines wire

Status: not started. Needs: S5.1, S5.2, S1.4, S3.2, S3.3, S3.4, and S4.1 to S4.12.

**Goal.** Each daemon has one listener, speaking `alinery.v1`. The shell reaches it only through the bridge and the `Shutdown` helper.

**Read first.** `main.ts:734-1073` (`handle`, the op dispatch) and `:1075` (`createServer`); `alinery-core/src/daemon_client.rs` (2,182; `daemon_command` :1470 stays); `alinery-core/src/rpc_chunk.rs` (290; its base64 helpers are used by core `task_creation.rs:47`, app `imports.rs:36` and core `telemetry.rs:558`); app `daemon.rs` (`ensure_daemon`, the poller :1432); `pi_durable.rs` (99; the supervisor :77); `main.ts:80-97` and `ui_control` (the ui secret); gates `check-wire-parsing-boundary.sh`, `protocol_gate_test.sh`, `check-protocol-version-bump.sh`, `check-no-auto-session-kill.sh`.

**Build.**
1. **Inventory.** Every op in `main.ts:734-1073` with its last caller. An op with a caller left goes back to the session that owns its domain; this session ports nothing.
2. **Lifecycle on `Hello`.** `ensure_daemon`, the poller and the remote supervisor read protocol, build id and app-config identity from `Hello`. The reuse rule is unchanged: both must match. `spawn_pi_supervisor` folds into the poller (it duplicates the spawn path, 1.4).
3. **Delete.** The dispatch and `createServer`; `daemon_client.rs` except `daemon_command`, which moves next to its remaining callers; `RpcChunkAssembler` (the base64 helpers stay); the old `shutdown` op; `--ui-secret-file`, `ui_control` and `ui-secrets.json` (the RPC token replaced them, 2.1.10).
4. **Gates.** `check-no-auto-session-kill.sh` keeps only the `ShutdownOrigin` check from S1.4. `check-wire-parsing-boundary.sh` checks that the shell decodes daemon replies only through generated types, or goes if the shell decodes none. `protocol_gate_test.sh` reads the protocol from `Hello`.
5. **Measure** the shell (commands left per class) and update 1.4 and 2.4.

**Tests.** `cargo test --workspace`, `bun test`, the protocol gates, the live remote test end to end. A relaunched app reattaches to a daemon that outlived it, using the stored token.

**Accept.**
- With a daemon running on a scratch repo, `ls <repo>/.alinery/*.sock` lists only `rpc[-ns].sock`.
- `test ! -e alinery-app/src-tauri/alinery-core/src/daemon_client.rs`, and `rg -n 'ui_control|ui-secret|ui_secret|RpcChunkAssembler' alinery-app` finds nothing.
- `scripts/tests/protocol_gate_test.sh`, `check-protocol-version-bump.sh`, `check-wire-parsing-boundary.sh` (if kept) and `check-no-auto-session-kill.sh`: exit 0.
- The live remote test passes end to end, and so does the relaunch case: a daemon started by one app process is reattached by the next with the stored token, PID unchanged.

**Exit.** One listener per daemon; no JSON-lines client in Rust; 2.4 matches the code.

### S5.4 AGENTS.md

Status: not started. Needs: S5.3.

**Goal.** AGENTS.md describes the thick daemon. README suggestions go to the handoff.

**Read first.** AGENTS.md; 4.4 (the lines that are already stale).

**Build.**
- Rewrite: the Daemon section (the RPC socket, `alinery.v1`, capabilities, `ShutdownOrigin`), Remote repositories (domain work no longer goes through a repo service; the host bootstrap per O15), the Commands list, the app crate module table (`daemon_rpc.rs` in, deleted modules out), the gates list (new: `check-daemon-fs-writes.sh`, `check-proto-gen.sh`, the `src/daemon/` services gate, the daemon git-spawn gate; minus the deleted ones), and Build & Compile Verification (`bun test`, `buf lint`).
- Recount the App version bump table if a crate was removed.
- Mark the superseded items in `docs/remote-repos-performance.md` and `docs/remote-repos-todo.md`.
- README is human-edited: put the suggestions in 4.4 and the handoff.

**Accept.**
- `for g in $(rg -o 'check-[a-z-]+\.sh' AGENTS.md | sort -u); do test -e scripts/tests/$g || echo "missing $g"; done` prints nothing, and every `scripts/tests/check-*.sh` is named in AGENTS.md.
- Every module in the app crate table exists under `alinery-app/src-tauri/src/`, and every top-level `.rs` file there except `lib.rs` and `main.rs` is in the table.
- `git diff --stat main -- README.md`: empty.

**Exit.** AGENTS.md matches the code; 4.4 has the README suggestions.

## P6: Setup screen

The Tauri UI is the only client (D8). Hosts and daemons are set up separately (D9): this Mac is always a host; a remote host is added over ssh. The user picks a host, then a repo on it, and that repo gets its daemon (one per repo, O4). The first daemon on a host runs the onboarding steps there; a repo on a host that has run a daemon before opens straight onto its board.

### S6.1 Hosts and the onboarded mark (D9)

Status: not started. Needs: S5.2 (the host bootstrap).

**Goal.** The app holds a host list with this Mac always first, and records per host whether onboarding has run there.

**Read first.** D9; `app_config.rs:154` (`RemoteHost`) and `:198` (`remote_hosts`); `onboarding.ts` (completion lives in `localStorage` key `alinery.onboardingCompleted.v1` today, once per install); `App.tsx:470-490` (when the wizard opens) and `:1088` (`completeOnboarding`); `RemoteModal.tsx` (the hosts view and the ssh set-up).

**Build.**
- **The local host** is a fixed entry, `local`, shown as "This Mac". It can't be removed or renamed, and it needs no set-up.
- **The onboarded mark (WA): app-side, per host.** `AppConfig` gains `local_onboarded: bool`, and `RemoteHost` gains `onboarded: bool`, both `#[serde(default)]`. It is app config, not repo state, so the shell keeps it (D5: daemon setup).
- **Migration (WA), at the first read of an older app config:** the local host is onboarded if `alinery.onboardingCompleted.v1` is `"1"` (the frontend passes it once, then deletes the key) or `known_repos` holds a local repo; a remote host is onboarded if `known_repos` holds a repo on it. So nobody who already has a working repo sees onboarding again.
- **Set when** the onboarding steps finish or are closed on that host, as `completeOnboarding` marks completion today. Removing a remote host clears its entry and its mark with it.
- One IPC command each to read the host list with the marks and to set a mark, typed in `ipc.ts`.

**Tests.** Rust (`src/tests/app_config.rs`): an old `app.toml` with local and remote known repos reads with both marks set; one with none reads with neither; the mark survives a write and a read; removing a host removes its mark. vitest: `localStorage` completion moves into the mark once and the key is gone.

**Accept.**
- `cargo test -p alinery-app --lib -- tests::app_config`: the cases above pass.
- `(cd alinery-app && npx vitest run src/onboarding)`: pass.
- `rg -n 'onboardingCompleted' alinery-app/src --glob '!*.test.*'`: only the one-time migration reads it.

**Exit.** Every host has an onboarded mark the UI can read.

### S6.2 The setup screen (D8, D9)

Status: not started. Needs: S6.1, S5.2 (the host bootstrap and the missing-tool refusal), S4.1 (`EnsureReady`), S4.12 (provider set-up through the daemon).

**Goal.** One screen sets up work: pick a host (this Mac by default, a known remote, or add a remote over ssh), then a repo on it to add, open or create. That repo's daemon starts. On a host whose mark is not set, the onboarding steps run against this new daemon; otherwise the UI opens the board.

**Read first.**
- Today's empty state: `App.tsx:1518-1539` shows `OnboardingFlow` at its "workspace" step (`OnboardingFlow.tsx:388-457`: known repos, "Add a repository" :444, "Add a repository over SSH" :449-454). The onboarding modal at `App.tsx:1570-1588` passes no `onAddRemoteRepo`, so it has no ssh choice. The models and launch steps wait for an active repo (`OnboardingFlow.tsx:175`, `:358`).
- Local flow: `App.tsx:807-835` (`pick_repo_dialog` `app_config.rs:571`, classify `:580`, init `:585`), then `setRepo` (`App.tsx:607-627`) and `set_active_repo` (`app_config.rs:411`), which is where the daemon starts.
- Remote flow: `RemoteModal.tsx` views hosts, setup, connecting, access, pick (:11; wizard steps :16). Connect phases are polled from `remoteHosts` every 500 ms (`SETUP_PHASES`, `remoteRepo.ts:10`). Pick ends in `remoteAddRepo` and `setRepo`, and the remote daemon starts only then (`activate_remote_repo`, `remote.rs:1417`).
- Probe refusals (`remote.rs:414-460`): not Linux, unknown CPU, no glibc, glibc below the floor, arm64 with 64 KiB pages, missing tools (:429-434), no bundled runtime (:440), and the linger refusal in `choose_launcher` (:459-460). Each is a plain string today.
- The two classify and init paths: `App.tsx:807-835` and `RemoteModal.tsx:239-270`.

**Build.**
- **When it shows (WA).** No known repo; or every known repo is remote and its host is unreachable. A local known repo always counts as a daemon to connect to, because the shell can start one. "Add repository" in the repo menu opens the same screen.
- **Step 1, host.** "This Mac" first and selected by default, then each remote host with its connection state, then "Add a remote host". Adding one is the remote set-up from `RemoteModal` (alias or destination, connect, host-key trust, probe, install, credential sharing). A failure during that first set-up discards the half-made host (`remoteDiscardHost`, as `RemoteModal.tsx:185-188` does).
- **Structured refusals.** The probe returns a typed refusal in `host.proto` (S5.2): a kind, the missing tools, the command to run (`loginctl enable-linger <user>`). The screen shows the fix for each kind, before anything is installed.
- **Step 2, repo.** On this Mac, the folder dialog; on a remote host, the folder picker on that host. Then classify, and confirm and init when the folder is not a repo (`askConfirm`, as today). **One classify-and-init helper** in TypeScript serves both; the two copies go.
- **Step 3, daemon.** On this Mac the shell starts the daemon; on a remote host the host bootstrap does (O15). The shell waits for `Hello` (over the forward for a remote), calls `EnsureReady`, and the screen names each step: "Starting the daemon", "Preparing the repository".
- **Step 4, onboarding or board.** If the host's mark is not set, the onboarding steps after the repo step run against this daemon: playbooks, models and providers (provider set-up goes to this host through this daemon, S4.12), first task. Finishing or closing them sets the mark (S6.1). If the mark is set, the board opens.
- The screen replaces the "workspace" step of `OnboardingFlow` and the hosts view of `RemoteModal`. The playbooks, models and launch steps stay as they are; the replay command (`App.tsx:1320`) still runs them for the active repo.

**Tests.** vitest with `mockIpc`: the show rule (empty, one local repo, only offline remote repos); "This Mac" is first and selected; the local flow's calls in order; the ssh flow's phases in order; each refusal kind renders its fix; a host without the mark goes on to the playbooks step after the daemon answers, and a host with it goes to the board; finishing or closing onboarding sets the mark for that host only.

**Accept.**
- `(cd alinery-app && npx vitest run src/views/SetupScreen src/views/OnboardingFlow src/RemoteModal)`: all pass.
- `rg -n 'classifyPickedFolder|remoteClassify' alinery-app/src --glob '!*.test.*'`: both reached only through the one helper.
- The live remote test (S5.2) passes with a host missing git: the refusal reaches the UI as a kind with the tool list.
- **User-run** (the app must be launched, which the user allows): with an empty app config dir, the app opens on the setup screen with "This Mac" selected. A local repo goes through onboarding to its board; a second local repo goes straight to its board. Against the remote-sshd container, the first repo on the new host goes through onboarding and a second repo on it does not. This is the P6 exit check.

**Exit.** The P6 exit check passes.

## P7: Hardening

### S7.1 Keeper and brain (O5)

Status: not started. Needs: S5.3.

**Goal.** Know what a daemon restart loses, and split the process if O5 picks (b).

**Read first.** The `runtime/` boundary (2.3: it imports neither `domain/` nor `rpc/`); `terminal.ts` (Terminal sessions on `Bun.Terminal`, `Bun.spawn` at :127); `main.ts:1108` (`resumeInterrupted`: pi-durable sessions resume from SQLite storage after a restart, `openNodeSqliteStorage` at :11).

**Research (UNCONFIRMED).** What a pi-durable session loses on restart: an in-flight model stream, and a tool child such as bash (killed with the daemon, or orphaned). Whether Bun can pass a PTY master fd to another process (SCM_RIGHTS); if not, the keeper owns each PTY for its whole life.

**Build.**
- Measure first, on a throwaway test repo: end the daemon process during (1) a Terminal session, (2) a pi-durable turn with a bash tool running, (3) an idle pi session. Record what survives in 4.1.
- Put O5 to the user with that: (a) one process; a restart loses Terminal sessions and in-flight tools; (b) a keeper (same binary, `--keeper`) owns the `Bun.Terminal` PTYs and tool children, appends scrollback, and serves a small local protocol (`keeper.proto`: Spawn, Attach, Write, Resize, Signal, List) to the brain, which is everything else and can restart.
- If (b): the keeper's protocol has its own version, separate from `PROTOCOL`. The keeper stops only through `Shutdown` (invariant 1); a brain restart is not a teardown, and `check-no-auto-session-kill.sh` covers the keeper.

**Tests (if b).** End the brain mid-session: the terminal keeps running, a new brain lists the keeper's sessions, and clients reattach with scrollback after one `MustRefetch` (new epoch).

**Accept.**
- 4.1 has one row per measured case (Terminal; pi-durable turn with bash running; idle pi): what survived, with the commands.
- Under (b): `bun test src/keeper`: the brain-kill case passes; `check-no-auto-session-kill.sh` scans the keeper and exits 0.

**Exit.** O5 is in 4.1; under (b) the split ships, and clients see only a new epoch.

### S7.2 Memory

Status: not started. Needs: S5.3.

**Goal.** The daemon's memory stays flat over days.

**Read first.** 2.2.3 (the ring), 2.2.5 (subscriber queues), 2.2.7 (the dedupe map), `terminal.ts` (replay buffers), the transcript watchers (S3.3).

**Build.**
- A soak script in `vinculum-daemon/soak/`, not in `check.sh`: 24 hours of synthetic commits, subscribe and unsubscribe churn, and a chatty terminal. It samples `process.memoryUsage()` and `heapStats()` from `bun:jsc` every minute (checked in the plan review: it works under `bun run` and in the compiled binary on Bun 1.4.3).
- Every in-memory map keyed by client or session gets a bound. WA: the dedupe entries of a client idle for an hour are dropped.
- Fix what grows.

**Accept.**
- `bun alinery-app/src-tauri/vinculum-daemon/soak/run.ts --minutes 5`: exits 0 and prints one sample a minute (the smoke run).
- The 24-hour run's samples are committed beside the script, and 4.1 has the 1-hour and 24-hour RSS.

**Exit.** WA threshold: RSS after 24 hours is within 20% of RSS after one hour. The numbers are in 4.1.

### S7.3 Stats

Status: not started. Needs: S7.2.

**Goal.** `AdminService.Stats` (2.1.3) reports the daemon's health, and Settings shows it per repo.

**Build.** Counters: uptime, epoch, seq, ring size, subscribers per scope, queue drops (`MustRefetch` sent), watcher events, reconcile duration, jobs by state, RSS and heap, live sessions. `Stats` needs VIEW. It is shown, never sent anywhere: telemetry stays opt-in (invariant 6).

**Tests.** `bun test`: a forced queue overflow increments the drop counter.

**Accept.**
- `(cd alinery-app/src-tauri/vinculum-daemon && bun test src/rpc/admin)`: the overflow case passes, and `Stats` answers the shell token from a peer that isn't the shell (VIEW).
- `scripts/tests/check-telemetry-privacy.sh`: exit 0 (no `Stats` field reaches the telemetry sender).

**Exit.** Settings shows `Stats` for each open repo.

### S7.4 Upgrade while sessions run

Status: not started. Needs: S7.1, S7.3.

**Goal.** A new app version replaces the daemon's code without ending sessions.

**Read first.** The reuse rule (`ensure_daemon`: protocol and identity both match, otherwise a conflict and an explicit restart); the content-hash runtime directories on remote hosts (AGENTS.md); `update.rs` (the in-app swap).

**Build.**
- Under O5 (b): `AdminService.Upgrade` (ADMIN) hands the keeper to a new brain started from the new binary. Put the trigger to the user: (a) after an update, ask once per repo ("Upgrade daemon; sessions keep running"); (b) upgrade on relaunch without asking, since no session ends.
- A keeper whose protocol is too old for the new brain: the brain refuses, and the app shows today's conflict banner with its explicit restart.
- Remote: the new runtime installs to a new content-hash directory; the host's keeper stays, and the new brain starts from the new directory.
- Under O5 (a): an upgrade still ends Terminal sessions. The flow stays today's explicit restart, and 4.1 records that the P7 exit check can't pass for Terminal sessions.

**Tests.** `bun test` with two brain builds (an env flag changes `build_id`): upgrade mid-session; the terminal survives; clients resubscribe once.

**Accept.**
- Under O5 (b): `bun test src/upgrade` with two builds: the terminal's PID is unchanged across the upgrade, and each client gets exactly one new epoch.
- Under O5 (a): 4.1 records that the P7 exit check can't pass for Terminal sessions.

**Exit.** The P7 exit check passes, or 4.1 records why it can't under O5 (a).

---

# Part 4: Records

## 4.1 Decision log

| Id | Date | Decision | Evidence |
|---|---|---|---|
| D1 | 2026-10-26 | Architecture B | User |
| D2 | 2026-10-26 | Protobuf services on every transport | User |
| D3 | 2026-10-26 | All business logic that can move to the daemon moves | User |
| D4 | earlier on this branch | Protocol bumps are free | User |
| D5 | 2026-10-26 | The UI talks only to the daemon, except setup and OS jobs | User |
| D6 | 2026-10-27 | Host tools are probed at setup and the user installs missing ones; none are shipped to a remote host (2.3.2, S5.2) | User |
| D7 | 2026-10-27 | A client needs a connected, compatible daemon to work on a repo (O19) | User |
| O16 | 2026-10-27 | (b): this plan lands on `remote-daemon` and becomes PR #154, stacked on PR #135 | User |
| O17 | 2026-10-27 | (c): the daemon sends its own events, best effort, failures dropped silently; consent through `app.toml`; events with no repo stay in the shell (S4.1) | User |
| O18 | 2026-10-27 | (b): MCP is a headless client of the daemon over T1 or T2, from any machine; its token grants AGENT, exactly the RPCs behind its tools, storage scan and purge included, never `Shutdown` or approvals (S5.1). Narrowed by O20 (c) for now: T1 on the daemon's host only | User |
| O19 | 2026-10-27 | (a), recorded as D7 (S3.5) | User |
| O7 | 2026-10-27 | (a): slow work runs in a child process (2.3.5) | User |
| O14 | 2026-10-27 | (b): `execution.json` is the truth; execution state does not go in the log. The engine saves its state there; an existing `engine.jsonl` is folded once and then left unread (S4.2) | User; the engine's load and save and the conversion are the plan's reading of "don't put it in the log" |
| O21 | 2026-10-27 | (b): old-runner records show as finished history, read-only, never run again (S4.2) | User |
| O20 | 2026-10-27 | (c), for now: MCP runs only on the daemon's host or as the shell's managed MCP, with minted AGENT tokens; "from any machine" is dropped. O22 raised for the cross-repo handoff (S5.1) | User |
| O11 | 2026-10-27 | (b): the host's `zip` and `unzip`, `fflate` goes; splitting into archives under the cap is the fallback if the S4.9 compatibility test fails (stop and ask) | User |
| O4 | 2026-10-27 | (a) per repo, no per-host daemon; recorded with the host and daemon split as D9 (P6) | User |

**Results from the plan review, 2026-10-27.** Bun 1.4.3 on darwin-arm64 unless a row says otherwise. Code and rerun commands: `docs/thick-daemon-spikes/` and its README. These are evidence for the Open items, not decisions.

| Slot | Result |
|---|---|
| S0.1 | protoc-gen-es 2.16.0 with `target=ts` and no import extension resolves under `bun run`, `bun build --compile`, `tsc --noEmit` (`moduleResolution: "bundler"`) and Vite 7.3.6. `@bufbuild/buf` 1.75.0 as a devDependency runs from `node_modules/.bin` with no network. Left: the `exports` mapping (4.2). |
| S0.2 (O1) | Connect-ES 2.2.0 `connectNodeAdapter` on `node:http` over a unix socket, under `bun run` and compiled (71 MB). Unary 100-byte echo p50 0.078 to 0.081 ms, p99 0.27 to 0.35 ms (JSON lines today: p50 0.035 ms); about 34,500 calls/s at 16 in flight. Server stream of 16 KiB frames: 356 to 362 MB/s. Idle RSS about 47 MB; an idle stream costs about 143 KB at 100 open, 55 KB at 1,000. `node:http2` serves gRPC. An interceptor sees headers only; the peer check needs the `node:net` listener (2.1.7). |
| S0.3 (O2) | connect-web with `bridgeFetch`: unary, error codes, a 100-frame stream and mid-stream cancel pass (6 tests). Bun stand-in for the shell: p50 0.095 ms, p99 0.45 ms. Rust hyper 1 over a unix socket: p50 0.076 ms, and its frames match the TypeScript encoder byte for byte. Unbatched, a busy stream sent about 116,000 channel messages/s (batching rule, 2.1.9). UI bundle with two services: 176,382 bytes, 41,886 gzipped. Left: the live webview (S1.2). |
| S0.4 | macOS only. 3,000 ops on 1,000 paths beside a 10 MB/s scrollback: Bun `fs.watch` recursive and `@parcel/watcher` 2.6.0 both missed none, paced or burst. Bun: 1 to 5 extra events, p50 31 ms, 0.9% CPU. Parcel: no extras, p50 about 260 ms, 2.7 to 4.4% CPU. Idle on 200 tasks: 0.1% CPU for both. Bun #44780's trigger caused no misses but stray paths; #34160 is superlinear per non-recursive watch. The parcel addon embeds in a compiled binary when required by a literal path. WA: Bun `fs.watch` (S0.4); Linux in S2.3. |
| S0.5 (O6) | flock between Bun FFI and Rust: 60 of 60 runs each on macOS arm64, Linux arm64 and Linux x64 (emulated), both directions. errno right in 10,000 of 10,000 when read straight after the call. `F_FULLFSYNC` from Bun: about 9.8 ms p50 per 1 KiB replace, same as Rust; plain `fsync` 0.12 ms. Hardened runtime: ad-hoc signature only; the release-signed run is the user's (4.2). |
| O3 scan | Real tasks copied N times, large files emptied (`scan-bench.ts`). 43 tasks: full scan 7.2 ms. 1,075 tasks: scan 165 ms, index 4.5 MB, async reconcile 42 ms with a 3.3 ms longest loop gap. 4,300 tasks: 745 ms, 24 MB, 167 ms, 5.4 ms. |
| S2.1 (store) | `store.ts` property test: 20 seeds of 400 commits with drops, resumes, queue overflow and ring rollover; every replica equals the store in its scope with the same cursor. One commit costs 0.8 µs at 1 subscriber, 2.4 µs at 10, 9.1 µs at 100; a one-task delta is 93 bytes. |
| S3.3 | pi-durable 1.4.0 exports `watchEvents` (marked experimental). WA in S3.3 with two fallbacks. |
| S4.1 | `Bun.TOML.stringify` reproduces Rust's bytes for 43 of 43 `task.md` files; smol-toml for 5 of 44 files. WA: write with `Bun.TOML.stringify`. |
| S4.9 (O11) | fflate 0.8.3 reads zip64 and writes none, so a TypeScript-made archive stops at 4 GiB or 65,535 entries. This repo's backup set: 289 MB, 43 tasks. macOS `/usr/bin/zip` 3.0 and `unzip` 6.00 have `ZIP64_SUPPORT`; a 70,001-entry archive from `zip` listed whole with `unzip -Z1`; a vanished file on the list is a warning and exit 0. `debian:12` has neither tool. |
| S7.2 | `heapStats()` from `bun:jsc` works under `bun run` and compiled. |

**O14 trace** (a note, not a decision; done in the plan review).
- Writers of `execution.json`: core `execution.rs:319`, `:325`; core `task_creation.rs:354`, `:358`, `:414`, `:443`; core `task.rs:378` (`auto_approve_all`); core `repo_ownership.rs:290`, reached from the daemon (`main.ts:117`, then `ownership_ffi.rs:35`); core `subtask.rs:436`, through `task_creation`. The daemon's `addExecution` (`tasks.ts:291`, called from `:325` and `:385`) writes with no lock, a plain `writeFileSync` and no revision. `session_name.rs` only reads in production. The `execution.rs` transitions and `reconcile_graph` (:692) have no production caller.
- Readers of `execution.json`: Rust `board.rs:114`, `:295`; app `daemon.rs:78`, `:239`; `repo_service.rs:711`; `shared.rs:711-750`; MCP `main.rs:594`, `:1033`; `subtask.rs:395`, `:443`; `session_name.rs:123`; `task_creation.rs:470`; `repo_ownership.rs:157`. TypeScript `tasks.ts:146`, `:156`; `graph.ts:209` (and `:268`, `:284`, `:286`, `:289`, `:306`); `main.ts:639`.
- `engine.jsonl`: one writer, `engine.ts:312` through `appendLog` (`state.ts:196`), which syncs with a plain `fsyncSync` (`state.ts:200`). Readers: `state.ts:175` and `graph.ts:107`.
- Where the two disagree today: (1) step completions exist only in the fold; (2) the record holds placeholder UUIDs where the fold uses `eN`; (3) the overlay is partial (`outputs: []`); (4) there are two restart rules; (5) the fold checks no `owning_lane`; (6) engine sessions carry no `execution_id`.
- The board's current step comes from the last non-archived session file with an `execution_id`; `Grid.tsx:557` reads the lifecycle.
- Under (a): about 12 reader sites move to the fold; records written by the old runner fold to empty (O21); the log holds absolute paths (`engine.ts:112`, `:205`, `accept.ts:21`), so a repo moved on disk needs them rewritten or made relative.
- Under (b): `execution.json` has no field for the output directory, the origin, ambiguities or history, so the fold's richer state would need new fields.

Slots the sessions fill (empty until then):

| Session | Records |
|---|---|
| S0.1 | The `exports` mapping, if it needed a change |
| S2.3 | The Linux watcher run; a switch to `@parcel/watcher` if it happens |
| S0.7 | O1, O2, O3, O6 |
| S2.1 | The Subscribe measurements |
| S3.4 | The O8 measurement |
| S4.2 | The multi-writer exception and which session removes each Rust writer |
| S4.10 | O12 |
| S4.11 | O9 |
| S5.1 | O10; O22; the AGENT RPC list |
| S5.2 | O15 |
| S7.1 | What a restart loses; O5 |
| S7.2 | Soak numbers |
| S7.4 | The upgrade trigger |

## 4.2 UNCONFIRMED

Resolved by the plan review and removed in v0.4: buf and protoc-gen-es, Connect on `node:http` and `node:http2`, interceptors and `socketPath`, a custom `fetch` under connect-web, flock interop, errno, `F_FULLFSYNC`, `bun:jsc`, `Bun.TOML.stringify`, `watchEvents`, the parcel addon inside `bun build --compile`, and Bun #44780 and #34160 on macOS. Withdrawn with D8: `node:https`, swift-nio-ssh and Citadel, connect-swift, WKWebView pinning.

| Claim | Resolved in |
|---|---|
| A `file:` package with `"exports": { "./*": "./gen/*.ts" }` resolves extensionless subpaths in Bun, Vite and `tsc` | S0.1 |
| One Tauri invoke carries a raw `ipc::Request` body and a `Channel` (read in Tauri 2.11.3's source, not yet run in a webview) | S1.2 (user-run: needs the app launched) |
| Bun `fs.watch` recursive misses no event on Linux (inotify) under the S0.4 workload, and Bun #44780 and #34160 don't bite there either (macOS: no misses) | S2.3 |
| `bun:ffi` dlopen works under the hardened runtime with the release identity | S0.5 (the user runs the probe; 4.4) |
| `Bun.TOML.stringify` stays in Bun's API (it is missing from the docs; the S4.1 golden test guards it) | S4.1 |
| Which git the daemon finds on a Mac without Command Line Tools; whether its PATH on a remote host (under `systemd-run --user` or `setsid`) finds the git the setup probe found. The remote-sshd container has no user systemd | S4.7 |
| What a pi-durable session loses on restart; Bun can pass an fd (SCM_RIGHTS) | S7.1 |

## 4.3 References

In this repo:
- `docs/thick-daemon-spikes/`: the plan review's spike code, results and rerun commands (README).
- `docs/remote-daemon-architectures.md`: the brainstorm; architecture B was chosen.
- `docs/remote-repos-performance.md`, `docs/remote-repos-todo.md`: the SSH work this plan builds on.
- `AGENTS.md`: the invariants in 1.3.

External:
- Connect-ES: https://github.com/connectrpc/connect-es; Node and web docs at https://connectrpc.com/docs/node/getting-started and https://connectrpc.com/docs/web/getting-started
- protobuf-es and protoc-gen-es: https://github.com/bufbuild/protobuf-es
- buf: https://buf.build/docs/
- Tauri v2 calling Rust and channels: https://v2.tauri.app/develop/calling-rust/
- connectrpc-tauri 0.1.6 (npm), prior art for 2.1.9
- `@parcel/watcher`: https://github.com/parcel-bundler/watcher
- Bun issues: https://github.com/oven-sh/bun/issues/44780 and https://github.com/oven-sh/bun/issues/34160
- Bun FFI and workers: https://bun.sh/docs/api/ffi and https://bun.sh/docs/api/workers
- pi-durable: the `@earendil-works/pi-durable` package (1.4.0)
- fflate: https://github.com/101arrowz/fflate; smol-toml: https://github.com/squirrelchat/smol-toml

## 4.4 Handoff

For the user:
- **R5**: telemetry ingest credentials are hardcoded at `alinery-core/src/telemetry.rs:21-22`. Out of this plan's scope. After S4.1 the daemon holds a copy too (O17 c), and a remote host gets it with the runtime, so a fix changes both.
- **`check.sh` runs no daemon `bun test`.** S0.1 adds the step.
- **Hardened-runtime probe (S0.5).** Needs the release signing identity: build `docs/thick-daemon-spikes/src/hardened-probe.ts` with `bun build --compile`, sign it with `codesign --force --timestamp --options runtime --entitlements <the release plist> --sign "Developer ID Application: <team>"`, run it, and expect `"ok":true`. Commands in the spikes README.
- **Live webview check (S1.2).** Needs the app launched: in devtools, `admin(<repo>).hello({})` answers through the bridge.
- **On this Mac after the review:** the `debian:12` Docker image (389 MB, created 6 days before the review) ran the Linux flock runs. The review may not have pulled it; check before removing it with `docker rmi debian:12`.

AGENTS.md lines that are stale today (S5.4 rewrites them):
- Engineering rules: "the three origins above"; the Daemon section lists five.
- Gates list: "`shutdown` senders stay on the four-name allowlist"; the gate allows five.
- "The daemon's in-memory `vt100` emulator is reattach truth": `terminal.ts:2` says reattach sends the scrollback tail and there is no vt100 frame.

S5.4 also rewrites lines that become stale during the plan, such as the `libalinery_core` ownership library (gone in S4.11), the module table (`daemon_rpc.rs`, from S1.2), and "A daemon this app cannot use", whose repo "still opens and its board reads through the repo service" (no longer true after S3.5, D7).

README suggestions (README is human-edited; nothing here edits it):
- `README.md:77` names the daemon `alineryd`; it is Vinculum (`alinery-vinculum-daemon`) on this branch.
- `README.md:87` says task, session and board browsing, and artifact listings, work while the daemon is offline, incompatible, or owned by another app instance, without starting one. After S3.5 that is no longer true (D7): a repo without a connected, compatible daemon shows only its banner until the daemon is connected or restarted. The paragraph needs rewriting then.
- After P5, the architecture description could say that the per-repo daemon is the application and the desktop app is one of its clients.
- After S6.2, the getting-started text could describe the setup screen: a local repository, or an ssh remote and then a repository on it.

## 4.5 Changelog

- v0.1, 2026-10-26: first draft (Parts 1 to 4).
- v0.2, 2026-10-27: O16, O17 and O19 decided, O18 decided in part; D6 (host tools probed, not shipped) and D7 (no repo without a daemon). S3.5, S4.1, S4.7, S5.1 and S5.2 updated to match.
- v0.3, 2026-10-27: O18 decided (b): AGENT becomes exactly the RPCs behind MCP's tools (2.1.10, S4.9, S5.1).
- v0.4, 2026-10-27: plan review. D8 (the Tauri UI is the only client; P6 becomes the setup screen; O13 and T4 to T6 withdrawn). Spikes for S0.1 to S0.5, the O3 scan, the store, TOML and zip, with code in `docs/thick-daemon-spikes/`; their results in 2.x and 4.1. The bridge (2.1.9), auth (2.1.10, O20), durability (2.3.2) and the 30 MIXED commands (2.3.4) rewritten from them. Every session gets an Accept list; Needs corrected across P1 to P5. New Open items O20 and O21; the O14 trace in 4.1.
- v0.5, 2026-10-27: the user decided O4 (a) with D9 (hosts and daemons set up separately; onboarding runs on a host's first daemon), O7 (a), O11 (b, the host's `zip` and `unzip`), O14 (b, `execution.json` is the truth), O20 (c) and O21 (b). O22 raised (the cross-repo handoff under O20 c). S4.2, S4.9, S5.1 and P6 (S6.1 hosts and the onboarded mark, S6.2 the setup screen) rewritten to match.
