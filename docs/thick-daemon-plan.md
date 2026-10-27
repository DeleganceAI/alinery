# Thick daemon plan: the Bun daemon becomes the application

Status: living draft v0.1, 2026-10-26. Nothing in this plan is built yet. Written on branch `remote-daemon` ([PR #154](https://github.com/DeleganceAI/alinery/pull/154), base `experimental-pi-durable-as-a-harness`).

Supersedes: the repo-service `RepoOp` channel as the long-term wire, and items P2 to P7 of `docs/remote-repos-performance.md` (subscriptions replace every poller those items tuned). What already shipped on this branch stays and is reused: A1 to A6, P1 and B1 in `docs/remote-repos-todo.md` (ssh master and forwards, runtime install, credential sync, the ui secret, the repo-service). The repo-service is the bridge this plan retires one domain at a time.

Background: `docs/remote-daemon-architectures.md` (architecture B is the one chosen).

## How to use this doc

- **Decided**: the user made the call. Change it only with the user.
- **Working assumption (WA)**: a default chosen so work can start. Cheap to change; a session that finds it wrong says so and moves it to Open.
- **Open**: needs a decision. Options are listed; the session named beside it gathers the evidence.
- **UNCONFIRMED**: a fact from research that nobody has checked on this machine yet. Part 4.2 lists them all.

Every session in Part 3 ends the same way: update its status line, move resolved Open items to the decision log (4.1), add a changelog line (4.5). A session is one PR-sized change that passes `./scripts/check.sh`.

---

# Part 1: High-level plan

## 1.1 Goal

One application, the Bun daemon, owns every business rule and all repo state on the host where the repo lives (this Mac or a remote Linux box). Clients (the desktop webview, a web app, an iOS app) render a synced replica of the daemon's data and send intent commands. The Rust desktop shell provisions daemons (local spawn, or install and start over ssh), bridges the webview to them, and does the OS jobs a host-side process can't do for this Mac (dialogs, notifications, keychain, browser sign-in, updates).

## 1.2 Decisions taken

| Id | Decision | Source |
|---|---|---|
| D1 | Architecture B: the TypeScript daemon is the application. | User, 2026-10-26 |
| D2 | Protobuf describes every client-to-daemon message, as gRPC-style services, on every transport (unix socket, ssh forward, WebSocket or HTTPS, in-process). | User, 2026-10-26 |
| D3 | All business logic that can move to the daemon moves. | User, 2026-10-26 |
| D4 | Protocol bumps are free for this work; no shipped users depend on the wire. | User, earlier in this branch |
| D5 | The UI talks only to the daemon, except for daemon setup and OS-only jobs. | User, 2026-10-26 |

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
| MIXED | 28 | Several of the above in one command | Split (rules in 2.3.4) |
| STUB | 7 | Return "OMP process sessions are not available" | Deleted in S0.6 |

Per module: task 25 (D17 P2 S3 M3), session 43 (D11 P22 M6, 4 stubs), chat 27 (D11 P10 S1 M2, 3 stubs), artifacts 25 (D25), daemon 10 (P2 PV4 S1 M3), remote 14 (PV11 S3), app_config 8 (S4 PV3 M1), settings 16 (D8 S7 M1), playbook 9 (D9), community_playbooks 8 (D1 S3 M4), account 9 (S9), connections 4 (S4), imports 4 (S2 M2), git_ops 11 (D10 M1), backup 6 (D4 S1 M1), notify 3 (S2 M1), mcp 3 (PV3), update 3 (S3), omp_update 3 (D2 S1), subtask 4 (D1 M3), vinculum_customizations 6 (D3 S3).

**Remote plumbing on this branch**: `RepoRef {Local, Remote{host_id, path}}` (`paths.rs:12-47`) keyed as `alinery+ssh://<host-id>/<abs path>`; `remote_call` (`remote.rs:1249`) sends one of 96 `RepoOp` variants (`alinery-core/src/repo_service.rs:25-565`) to `alinery-mcp --repo-service` on the host; daemon ops go through an ssh-forwarded socket. Gates `check-remote-routing.sh` and `check-remote-offload.sh` track which commands are routed.

**App-side state and workers**: `AppState` (`state.rs:29-72`) is all lifecycle, provisioning and routing state. The one piece of business state in the app is the backup queue (`backup.rs:43-61`, 250 ms poll, 2 s debounce). Background loops: daemon poller (`daemon.rs:1432`, 5 s), Pi supervisor (`pi_durable.rs:77`, 5 s, duplicates the poller's spawn path), remote supervisor (`remote.rs:1671`, 1 s tick), hosted-token refresh (`session.rs:458`, 30 min), terminal stream pump (`daemon.rs:450`/`488`, 8 ms or 16 KiB frames).

**Defects the move fixes instead of porting**:

| Id | Defect | Where |
|---|---|---|
| R1 | `addExecution` read-modify-writes `execution.json` with no lock and no revision, while Rust writes the same file under `.alinery/.task-mutation.lock` (`lockfile.rs:127`, a process mutex plus a repo flock) | daemon `tasks.ts:291-296` |
| R2 | Two execution state machines: `execution.json` and the `engine.jsonl` fold | daemon and playbook-engine |
| R3 | Same rule implemented twice, differently: current step (`board.rs:166-171` vs the engine fold), playbook parsing, settings precedence (`sessionControls.ts:75-123` vs `settings.rs`) | Rust and TS |
| R4 | Writes that are not crash-safe (plain `writeFileSync`, no temp file and rename) | `main.ts:295`; `tasks.ts:295`, `:324`, `:361`, `:383`, `:402` |
| R5 | Telemetry credentials hardcoded at `telemetry.rs:21-22` | handoff, not this plan |
| R6 | Dead Rust: `playbook_scheduler.rs` (3,018 lines, used only by one `subtask.rs` test) and the 7 stubs | `alinery-core`, app crate |
| R7 | No push: every view polls | frontend |
| R8 | One request per connection; auth only on `ui_control` | daemon wire |

## 1.5 End state

```
+------------------+  +------------------+  +------------------+
| Desktop webview  |  | Web app          |  | iOS app          |
| sync client      |  | sync client      |  | sync client      |
+---------+--------+  +---------+--------+  +---------+--------+
          |                     |                     |
          +---------------------+---------------------+
                                | alinery.v1 (protobuf) over UDS, ssh,
                                | Tauri bridge, WebSocket+TLS
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
|  | engine.jsonl fold        |  | backup, scans, purge     |  |
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

- **Clients** keep a replica per scope (repo, task, session, chat), send unary commands, and open streams for terminals, transcripts and blobs. The desktop webview reaches the daemon through the shell bridge; web and iOS reach it over HTTPS or WebSocket (P6).
- **The daemon** is one Bun process per repo (WA, O4) with six areas: `rpc/` (transports, router, auth), `sync/` (store, changelog, subscriptions, watcher), `domain/` (all business rules), `runtime/` (today's session runner: PTYs, pi-durable, transcripts), `jobs/` (slow work in child processes), `platform/` (atomic writes, flock, git spawn).
- **Files** under `.alinery/` stay the truth; the store is an in-memory index rebuilt at start (WA, O3).
- **The shell** keeps about 70 commands (SHELL 47, PROVISION 21, the shell halves of MIXED) plus one bridge command. It holds no business state.

## 1.6 Phases

| Phase | Outcome | Exit check |
|---|---|---|
| **P0** Contract, cleanup, spikes | `proto/` with buf and generated TS; dead code gone; R1 fixed; spikes answer O1, O2, O6, O7 and the watcher choice | `buf lint` green; spike notes in 4.1; check.sh green |
| **P1** RPC host and transports | The daemon serves `alinery.v1` on a second socket next to the JSON-lines one; the shell bridges the webview to it, locally and over the ssh forward; `Shutdown` carries its origin | A webview call reaches a local and a remote daemon through the bridge; auth rejects a bad token |
| **P2** Sync engine core | Store, changelog, `Subscribe`; fed by commands, a file watcher plus reconcile, the session runner, engine events and jobs | A replica built from `Subscribe` equals the store after random commits, restarts and dropped streams |
| **P3** Client library and first slices | `src/sync/` replica and hooks; session status, transcript, terminal and board reads move to subscriptions and streams | The pollers for those views are deleted; their Tauri commands are deleted |
| **P4** Domain ports | One domain per session moves its writes into TypeScript, with conformance fixtures from the Rust goldens | Each session deletes its Tauri commands, `RepoOp` variants and core code |
| **P5** Shell slimming | JSON-lines wire, `daemon_client.rs`, `repo_service`, the daemon's `libalinery_core` FFI gone; MCP and host bootstrap settled (O10, O15) | The shell is SHELL plus PROVISION plus the bridge; AGENTS.md rewritten |
| **P6** Remote, web, iOS | TLS door, pairing and capabilities, web build of the UI, iOS spike, per-host daemon question (O4, todo B2) | A browser on another machine views and acts on a repo |
| **P7** Hardening | Keeper and brain split (O5), memory and metrics, upgrade while sessions run | Upgrading the daemon keeps sessions alive |

Order: transport and sync come before domain ports, so each port lands straight onto subscriptions. Reads move before writes: the watcher keeps the store right while Rust still writes a domain's files, so the UI can switch to subscriptions before the write path moves.

## 1.7 Open decisions

| Id | Question | Options | WA | Decided by |
|---|---|---|---|---|
| O1 | RPC flavour on Bun | (a) Connect-ES on `node:http` (Connect and gRPC-Web over HTTP/1.1; gRPC too if `node:http2` works under Bun); (b) `@grpc/grpc-js` server (real gRPC, HTTP/2 only, browsers need a proxy); (c) protobuf messages in our own length-prefixed framing over any byte stream | (a) | S0.2 |
| O2 | Webview to daemon | (a) Tauri command plus `Channel` proxy, shell forwards bytes to the socket; (b) daemon loopback TCP plus a token; (c) custom URI scheme handled by the shell | (a) | S0.3 |
| O3 | Source of truth | (a) files plus in-memory index; (b) SQLite as truth, files as export; (c) files plus a SQLite index cache | (a) | S0.7 |
| O4 | Daemon per repo or per host | (a) per repo, as today; (b) per host, many repos | (a) until P6 | S6.4 |
| O5 | Keeper and brain | (a) one process; (b) small keeper holds PTYs and scrollback, restartable brain holds the rest | (a) until P7 | S7.1 |
| O6 | flock from Bun | (a) `bun:ffi` to libc `flock(2)` (libc is already dlopened); (b) `flock(1)` child holding the lock (Linux only, macOS has no `flock(1)`); (c) no file lock once Rust stops writing (needs a lock during the strangler period anyway) | (a) | S0.5 |
| O7 | Where slow work runs | (a) child process of the same binary, `--job <kind>`; (b) Bun `Worker` (experimental per Bun docs; a crash takes the daemon) | (a) | S0.7 |
| O8 | Terminal input from browsers | (a) split: `Attach` server stream plus unary `Write` with `input_seq`; (b) WebSocket tunnel with a bidi frame stream | (a), measure | S3.4 |
| O9 | Keep-awake | (a) keep the IOKit FFI; (b) `caffeinate -w <pid>` on macOS, `systemd-inhibit` on Linux | (b) | S4.11 |
| O10 | MCP server for agents | (a) Rust `alinery-mcp` becomes a thin client of the new RPC; (b) the Bun binary gets an `--mcp` stdio mode that calls the daemon socket | Open | S5.1 |
| O11 | Zip for backups | (a) `fflate` in a job child; (b) system `zip`/`ditto`; must write and read today's `-v1.zip` | (a) | S4.9 |
| O12 | Agent dir placement (`omp_update`, `vinculum_customizations`) | (a) per host, daemon owns it, shell mirrors the Mac's copy; (b) Mac only, shell owns and pushes | Open | S4.10 |
| O13 | Pairing and the door for web and iOS | (a) shell-issued token by QR with capabilities; (b) through the existing account pairing (`account.rs`); iOS cannot forward unix sockets over ssh (no streamlocal in swift-nio-ssh or Citadel), so it needs TLS or an ssh `direct-tcpip` channel to a loopback port | Open | S6.1 |
| O14 | One execution state machine | (a) `engine.jsonl` fold is the truth, `execution.json` goes; (b) `execution.json` is the truth, the fold feeds it | Open, traced in S0.6 | S4.2 |
| O15 | Host bootstrap without a daemon | (a) keep `alinery-mcp --repo-service` for host-only ops (ListDir, Classify, Init, ClaimRepo, SpawnDaemon, WriteConfigFiles, MergeCredentials, WaitDaemonGone); (b) a `--host-service` stdio mode of the Bun binary, so the host runtime carries no Rust (no zig cross-build) | Open | S5.2 |
| O16 | What happens to PR #154 | (a) merge as is: remote repos work now through the repo-service, and this plan replaces it later; (b) keep it open and land the thick daemon on top | Open | User |
| O17 | Telemetry for ported commands (consent and ingest credentials live in the shell) | (a) the shell emits after `Applied`, with ids read from the replica entity, through one new allowlisted shell command; (b) the daemon returns a telemetry hint in `Applied` and the shell records it under its consent; (c) the daemon sends directly, with consent passed at spawn (a remote host would then hold the ingest credentials, R5) | Open | S4.1, with the user |
| O18 | Capabilities for MCP's 21 tools beyond the four session tools, once they go through the daemon | (a) MCP holds a token passed at spawn and gets VIEW and ACT, like any local peer that isn't the shell (2.1.10); tools that need ADMIN (`alinery_storage_info`, `alinery_delete_archived_storage`) leave MCP; (b) a new capability that lists exactly the tools MCP exposes today, so no tool changes; (c) MCP keeps AGENT only and drops the other 21 tools | Open | S5.1, with the user |
| O19 | Reading a repo whose daemon is down, incompatible, or owned by another app instance (today the board reads files directly, `README.md:87`) | (a) the board needs a compatible daemon; such a repo shows only the conflict banner and its explicit restart; (b) the shell starts this app's daemon binary in a read-only mode beside the owner: it takes no ownership lock, runs no sessions, serves VIEW only from the files; (c) keep the Rust board reads for this case only | Open | S3.5, with the user |

## 1.8 Migration rules (strangler)

1. **Second socket, old wire untouched.** The daemon serves `alinery.v1` on `rpc[-ns].sock` beside `alineryd[-ns].sock` until P5. Nothing on the old wire changes except to delete.
2. **One writer per domain at any time.** Before a domain's port session Rust writes its files; after it, only the daemon does. The session flips every write path of the domain in one PR. Two known exceptions, both under the shared flock (rule 3): `alinery-mcp` keeps writing settings, task creation, the playbook library and the pre-archive backup until S5.1, and five Rust modules keep writing execution state after S4.2 until their own ports (P4 intro, S4.2).
3. **Shared locks while two languages can touch one file.** Where Rust and TypeScript can both write (for example `execution.json`, `task.md`), both take the same flock (interop test in S2.2).
4. **Reads before writes.** A domain's read model (parser plus derived fields) lands first and is fed by the watcher, so the UI can subscribe before the write path moves.
5. **Conformance fixtures.** A port session turns the Rust tests for its domain (the inline `#[cfg(test)]` modules, `execution_tests.rs`, `alinery-core/tests/`) into fixture directories with expected JSON, runs them against Rust and TypeScript, and keeps them as TypeScript tests after Rust is deleted.
6. **Each port deletes what it replaced**: Tauri commands, `ipc.ts` wrappers, `RepoOp` variants, core functions with no callers, entries in `remote-local-only.txt` and `remote-offload-ok.txt`.
7. **Every command answers with its cursor** (`Applied`), so the client knows when its subscription shows the change.
8. **Protocol**: `PROTOCOL` moves whenever the op set changes (D4). `buf breaking` turns on once a client ships outside this repo (web or iOS).

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

Connect-ES v2 has no separate `protoc-gen-connect-es`: one `protoc-gen-es` (2.16.0) emits messages and service descriptors. Whether the default `import_extension` suits both Bun and Vite is checked in S0.1. buf is not installed here; `npx @bufbuild/buf` (1.75.0) avoids a system install.

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
message Applied {
  Cursor cursor = 1;
}

message MutationResponse {
  Applied applied = 1;
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
}

message HelloRequest {
  string client_id = 1;
  string client_kind = 2;  // "desktop", "web", "ios", "mcp"
  uint32 protocol = 3;
}

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
  CAPABILITY_AGENT = 5;    // the four MCP session tools only
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

`Hello` is also the liveness probe. A successful socket connect proves nothing over a forward (today's lesson in `remote.rs`); a `Hello` round-trip does.

### 2.1.4 Sync

```proto
// proto/alinery/v1/sync.proto
service SyncService {
  rpc Subscribe(SubscribeRequest) returns (stream SyncFrame);
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

message SyncFrame {
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
  rpc Attach(AttachRequest) returns (stream TerminalOutput);
  rpc Write(WriteRequest) returns (WriteResponse);
  rpc Resize(ResizeRequest) returns (ResizeResponse);
  rpc Detach(DetachRequest) returns (DetachResponse);
  // Possible later, HTTP/2 native clients only (O8):
  // rpc Stream(stream TerminalClientFrame) returns (stream TerminalOutput);
}

message AttachRequest {
  SessionRef session = 1;
  uint64 from_offset = 2;  // byte offset in sessions/<id>.scrollback; 0 means the kept tail
  uint32 cols = 3;
  uint32 rows = 4;
  bool read_only = 5;      // VIEW capability attaches read-only
}

message TerminalOutput {
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
- **Input order lives in the daemon.** `input_seq` replaces the app-side ordered worker `queue_terminal_op` (`session.rs:684`). The daemon buffers an out-of-order write until the gap fills (WA: give up after 2 s and apply in arrival order, logging it).
- **Pi sessions** have transcripts, not just bytes:

```proto
// in sessions.proto
service SessionService {
  // Create, Start, Rename, Archive, Kill, Resume: unary, MutationMeta first
  rpc WatchTranscript(WatchTranscriptRequest) returns (stream TranscriptFrame);
}
message WatchTranscriptRequest { SessionRef session = 1; uint64 from_item = 2; }
message TranscriptFrame {
  repeated TranscriptItem items = 1;  // fields defined in S3.3 from today's transcript type
  uint64 next_item = 2;
  bool replace = 3;                   // true: items replace the client's copy from from_item on
}
```

- **Blobs** never take a path from the client. `BlobRef` names the thing (artifact, attachment, chat attachment) and the daemon resolves and checks the path, so a client can't read outside `.alinery/`.

```proto
// proto/alinery/v1/blobs.proto
service BlobService {
  rpc Read(ReadBlobRequest) returns (stream BlobChunk);
  rpc BeginUpload(BeginUploadRequest) returns (BeginUploadResponse);
  rpc UploadChunk(UploadChunkRequest) returns (UploadChunkResponse);
  rpc CommitUpload(CommitUploadRequest) returns (MutationResponse);
}

message BlobRef {
  oneof target {
    ArtifactBlob artifact = 1;          // {task_slug, name}
    AttachmentBlob attachment = 2;      // {task_slug, name}
    ChatAttachmentBlob chat_attachment = 3;
  }
}
message ReadBlobRequest { BlobRef ref = 1; uint64 offset = 2; uint64 length = 3; }  // length 0: to the end
message BlobChunk { bytes data = 1; uint64 offset = 2; uint64 total = 3; string content_type = 4; }

message BeginUploadRequest { MutationMeta meta = 1; BlobRef target = 2; uint64 size = 3; string sha256 = 4; }
message BeginUploadResponse { string upload_id = 1; uint32 chunk_size = 2; }  // WA 256 KiB
message UploadChunkRequest { string upload_id = 1; uint64 offset = 2; bytes data = 3; }
message UploadChunkResponse {}
message CommitUploadRequest { string upload_id = 1; }  // sha256 checked here, then atomic rename
```

Uploads are unary chunks because browsers and WebKit can't stream a request body. Staged chunks live in `.alinery/tmp/uploads/<upload_id>` and are cleared at daemon start.

```proto
// proto/alinery/v1/jobs.proto
service JobService {
  rpc Start(StartJobRequest) returns (StartJobResponse);  // {MutationMeta, oneof kind params}
  rpc Cancel(CancelJobRequest) returns (MutationResponse);
}
message StartJobResponse { string job_id = 1; Applied applied = 2; }

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
  rpc Create(CreateTaskRequest) returns (CreateTaskResponse);
  rpc Rename(RenameTaskRequest) returns (MutationResponse);
  rpc Archive(ArchiveTaskRequest) returns (MutationResponse);
  rpc Restore(RestoreTaskRequest) returns (MutationResponse);
}

message ArchiveTaskRequest {
  MutationMeta meta = 1;
  string slug = 2;
  uint64 expected_revision = 3;  // 0: no check; a mismatch is ABORTED
}
```

Every write follows that shape: `MutationMeta` first, the target, an optional `expected_revision`, and `MutationResponse` (or a response that embeds `Applied`) back.

**What becomes an entity and what becomes an RPC.** State that several views show and that changes over time is an entity in the store, read only through `Subscribe`. A one-off computed answer (a diff, a compare URL, a dry run, a directory listing) is a unary RPC. No `List*` or `Get*` RPC exists for something that is an entity.

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
- Connect-ES 2.2.0 serves Connect and gRPC-Web over HTTP/1.1 through `node:http`. gRPC proper needs `node:http2`, and whether that works under Bun is UNCONFIRMED.
- Over HTTP/1.1 Connect supports unary and server streaming; bidi needs HTTP/2.

| | (a) Connect-ES on `node:http` | (b) `@grpc/grpc-js` | (c) own framing |
|---|---|---|---|
| Runs on Bun | `node:http` handler; gRPC also if `node:http2` works | needs `node:http2` (UNCONFIRMED) | any byte stream |
| Browser and WebKit | Connect over fetch, unary and server streaming | needs a proxy | WebSocket only |
| Bidi | HTTP/2 only | yes | yes |
| Codegen | `protoc-gen-es`, one plugin | separate generator | hand-written dispatch |
| Debug tools | curl (Connect JSON), buf curl, grpcurl if gRPC works | grpcurl | none |
| In-memory tests | `createRouterTransport` | no | hand-written |

WA (a). The plan needs no bidi call: terminals use the split form (O8 a), uploads are chunked. S0.2 measures it.

```ts
// vinculum-daemon/src/rpc/server.ts (sketch)
import { createServer } from "node:http";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { AdminService, SyncService } from "alinery-proto/gen/alinery/v1/...";

export function serveRpc(socketPath: string, secret: Buffer) {
  const handler = connectNodeAdapter({
    routes(router) {
      router.service(AdminService, admin);
      router.service(SyncService, sync);
    },
    interceptors: [authInterceptor(secret)],  // server interceptors: confirm in S0.2
  });
  createServer(handler).listen(socketPath);
}
```

A Bun or Node client reaches the socket with connect-node's `createConnectTransport` and `nodeOptions: { socketPath }` (UNCONFIRMED, S0.2). The shell bridge needs no protobuf client at all (2.1.9).

### 2.1.8 Transports

| Id | Transport | Who uses it | Notes |
|---|---|---|---|
| T1 | UDS `<repo>/.alinery/rpc[-ns].sock` | shell bridge for local repos, MCP, tests | Same lane naming as `alineryd[-ns].sock`; 0600 |
| T2 | ssh `-O forward -L <local sock>:<remote rpc sock>` on the existing ControlMaster | shell bridge for remote repos | Reuses `remote.rs` masters and forward naming. Needs sshd `AllowStreamLocalForwarding`, which the probe already checks |
| T3 | Tauri bridge (O2) | desktop webview | The webview never opens a socket. The shell forwards HTTP/1.1 bytes to T1 or T2 |
| T4 | HTTPS (Connect), optional WebSocket | web and iOS (P6) | TLS listener on the daemon or a relay; pairing tokens (O13) |
| T5 | loopback TCP | only if O2 (b) wins, or iOS `direct-tcpip` | token required |
| T6 | iOS | P6 (O13) | no streamlocal in swift-nio-ssh or Citadel, so T2 is out; TLS or `direct-tcpip` to T5 |
| T7 | in-memory `createRouterTransport` | vitest and bun tests | replaces `mockIpc` for daemon calls (2.5) |

The protocol is the same on every row. Only the byte pipe changes.

### 2.1.9 The webview bridge (O2)

WA (a): one Tauri command proxies a Connect request to the daemon socket and streams the response back on a `Channel`.

```
webview: Connect client
  -> createConnectTransport({ baseUrl: "http://daemon", fetch: bridgeFetch(repoKey), useBinaryFormat: true })
  -> bridgeFetch: invoke("daemon_rpc", {repo, method, headers, body}, channel)
shell:  daemon_rpc
  -> resolve repoKey: local rpc.sock (T1) or the ssh forward (T2)
  -> add authorization header (the token never reaches the webview)
  -> hyper HTTP/1.1 over UnixStream (hyper is already in Cargo.lock)
  -> each response chunk -> Channel frame
webview: bridgeFetch builds a Response with a ReadableStream body from the frames
```

- **The bridge is a `fetch`, not a protocol.** The Connect client is unchanged; `bridgeFetch` only moves bytes. That keeps one client code path for the webview (bridge), web (real fetch) and tests (in-memory).
- **Frame format on the Channel:** `[u32 len][u8 kind][payload]`, kind = head (status and headers as JSON), body chunk, end (trailers or transport error). Frames are padded to at least 1 KiB: Tauri 2.11 sends raw channel bodies under 1 KiB through `webview.eval` as JavaScript array literals (`session.rs:384`, `TAURI_RAW_FETCH_MIN_BYTES`). Today's terminal pump already does exactly this.
- **Coalescing:** body chunks are batched like `pump_session_stream` (`session.rs:401`, 8 ms or 16 KiB) before they cross into the webview.
- **Request body:** Open in S0.3. A raw `tauri::ipc::Request` body and a `Channel` argument in one invoke is UNCONFIRMED. Fallback: the request body goes base64 in the JSON args. Requests are small; uploads are chunked at 256 KiB.
- **Cancel:** the `AbortSignal` calls `daemon_rpc_cancel(call_id)`, and the shell drops the hyper request, which ends the server stream.
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
| No token | AGENT: the four MCP session tools, matching today's exposure (MCP's other tools: O18) |
| Pairing token (P6) | what the pairing granted (O13) |

APPROVE is never reachable from anything an agent on the host can read, so an agent can't approve its own step.

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
  -> Heartbeat every 15 s with the current cursor
```

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
2. **File watcher plus reconcile.** Covers agents and Rust (during the strangler period) writing files directly. Watch `.alinery/tasks/**` and the config files (`config.toml`, `harnesses.toml`, `playbooks.toml`). Ignore `worktrees/`, `*.scrollback` (every PTY byte is appended there) and `.alinery/tmp/`. On an event, re-read the path, rebuild the entity, and commit only if protobuf-es `equals()` says it changed, so the daemon's own writes cost a re-read and no delta. A reconcile pass every 30 s (WA) stats every tracked file and re-reads what changed, which covers missed events. Watcher choice in S0.4 (Bun `fs.watch` has open bugs #44780 and #34160, as reported by research; `@parcel/watcher` 2.6.0 is a native addon).
3. **The session runner.** Session start, exit, status and attention changes commit directly.
4. **Playbook engine events.** A hook in `appendLog` commits the execution entity after each event. Events gain an `at` timestamp (today they carry none, `state.ts`).
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
    const seq = ++this.seq;
    const changes: Change[] = [];
    for (const entity of puts) {
      const prev = this.rows.get(entity.key);
      if (prev && equals(EntitySchema, { ...prev.entity, revision: 0n }, { ...entity, revision: 0n })) continue;
      entity.revision = seq;
      this.rows.set(entity.key, { revision: seq, entity });
      changes.push(create(ChangeSchema, { op: { case: "put", value: entity } }));
    }
    for (const key of deletes) {
      if (this.rows.delete(key)) changes.push(create(ChangeSchema, { op: { case: "delete", value: key } }));
    }
    if (!changes.length) return this.seq - 1n;  // nothing changed; seq not consumed
    // (real code assigns seq only after finding a change; sketch kept short)
    for (const change of changes) this.pushRing(seq, change);
    for (const sub of this.subs) sub.offer(seq, changes);
    return seq;
  }
}
```

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

Lives in `alinery-app/src/sync/` (a shared package once web exists).

```ts
// alinery-app/src/sync/replica.ts (sketch)
export class Replica {
  cursor?: Cursor;
  stale = false;
  private rows = new Map<string, Entity>();
  private listeners = new Set<() => void>();

  apply(frame: SyncFrame) { /* snapshot: replace; delta: put/delete; must_refetch: clear cursor */ }
  get = (key: string) => this.rows.get(key);
  listen = (fn: () => void) => (this.listeners.add(fn), () => this.listeners.delete(fn));
}

export function useEntity(replica: Replica, key: string) {
  return useSyncExternalStore(replica.listen, () => replica.get(key));
}
```

- `useEntities(replica, filter)` caches its array per replica version, because `useSyncExternalStore` needs a stable snapshot.
- A run loop resubscribes with backoff (0.5, 1, 2, 5 s) and passes the last cursor.
- While disconnected the replica keeps its last state and sets `stale`; views show a banner instead of an empty board.
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
| `SessionView.tsx:590`, `:613` | `readTaskExecution` | task scope |
| `SessionView.tsx:671` | `ipc.listTasks` (parent task) | repo scope |
| `SessionView.tsx:719`, `:736` | `listArtifactsWithMetadata`, `listTaskArtifactTree` | task scope |
| `SessionsList.tsx:239`, `:273` | `listBoardTasks`, `refreshStatuses` | repo scope plus session entities |
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

// fs_atomic.rs:30 write_bytes_durable: as above, plus fsync of the file and its directory.
export function writeDurable(path: string, data: string | Uint8Array, mode = 0o644) { /* fsyncSync(fd) before close, then fsync the dir fd */ }

// fs_atomic.rs:62-99: 0700 directories and 0600 files for anything secret.
export function mkdirOwnerOnly(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
export function writeOwnerOnly(path: string, data: string | Uint8Array) { writeAtomic(path, data, 0o600); }
```

- Whether Rust's durable write uses `F_FULLFSYNC` on macOS, and whether Bun's `fsyncSync` does, is checked in S0.5 (UNCONFIRMED). If Rust does and Bun doesn't, `writeDurable` calls `fcntl(fd, F_FULLFSYNC)` through `bun:ffi`.
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

- A `-1` from `flock` with `LOCK_NB` is treated as busy. Telling `EWOULDBLOCK` from other errors needs errno (`__error()` on macOS, `__errno_location()` on Linux, read with `bun:ffi` `read.i32`); S0.5 checks that this works.
- Lock marker files are never unlinked (invariant 2).

**`withTaskMutation`** is the TypeScript side of `with_task_mutation_lock` (`lockfile.rs:127`), which takes a process mutex and then a flock on `.alinery/.task-mutation.lock` (`paths.rs:88`):

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

**`platform/git.ts`** is the only `Bun.spawn(["git", ...])` site. It resolves git like `alinery_core::git_cmd` (PATH, skipping the macOS `/usr/bin/git` stub until the Command Line Tools are installed; then the alongside tree with `GIT_EXEC_PATH`; `ALINERY_GIT_PATH` for tests) and scrubs the same environment variables. A gate like `check-git-env-scrub.sh` covers `vinculum-daemon/src`.

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
| S4.12 | Providers and models | daemon `main.ts:965-1002` (JSON-lines ops), app `session.rs` provider commands (:1215-:1251), `list_harness_models(_for_repo)` | none | Takes the provider ops off the JSON-lines wire before S5.3 deletes it |

The 11 host-level variants (Ping, ClaimRepo, ReleaseRepo, Classify, Init, ListDir, WriteFile, RemoveFile, SyncCredentials, WaitDaemonGone, SpawnDaemon) work when no daemon runs; O15 decides them in S5.2. The 8 board-read variants (ListBoardTasks, ListTasks, GetTask, TaskActivity, ListSessions, ListSessionItems, ReadSessionMetas, GetSessionDisplay) retire in S3.5. 11 + 8 + 77 above = 96.

### 2.3.4 Splitting the MIXED commands

28 commands do two kinds of work at once. Each splits by one of these rules:

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

S0.7 lists the 28 by name with the rule each takes, so each P4 session knows which halves it owns.

### 2.3.5 Jobs and workers

**WA (O7 a): a job is a child process of the daemon's own binary.**

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
- **Zip (O11 a):** `fflate` in the job child, if it reads and writes today's `-v1.zip` archives byte-compatibly enough for `backup.rs` verify. S4.9 runs Rust-made archives through the TypeScript verifier and the other way round.
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
- **Exit**: the observable result, and what got deleted.

## P0: Contract, cleanup, spikes

### S0.1 Proto toolchain and the daemon test step

Status: not started. Needs: nothing.

**Goal.** `proto/` exists with `common.proto` and `admin.proto`, generated TypeScript is checked in, and both the daemon and the app import it. `./scripts/check.sh` runs the daemon's and the engine's `bun test` (today it runs neither: its steps are biome, typecheck, vitest, the omp extension, the Rust steps and the shell gates).

**Read first.** `alinery-app/src-tauri/vinculum-daemon/package.json` (the `file:` dependency on `playbook-engine` is the pattern for `alinery-proto`); `scripts/check.sh:37-90`; `scripts/dev-fetch-bun.sh` (how the compiled daemon is built, so the proto package resolves in `bun build --compile`); `alinery-app/vite.config.ts` and `tsconfig.json` (import resolution for a `file:` package).

**Research.**
- protoc-gen-es 2.16.0 `import_extension`: the default in v2 is no extension (UNCONFIRMED). Generate both ways and check that `bun build --compile`, `vite build` and `tsc --noEmit` all resolve the imports. Record the setting in `buf.gen.yaml`.
- `npx @bufbuild/buf@1.75.0` works offline after the first fetch? If not, the gate skips with a message when buf is unavailable, and CI runs it.
- `@bufbuild/protobuf` version that matches protoc-gen-es 2.16.0 (same major and minor).

**Build.**
- `proto/` as in 2.1.1, with `common.proto` and `admin.proto` only. Later sessions add their files.
- `proto/package.json`:

```json
{
  "name": "alinery-proto",
  "private": true,
  "type": "module",
  "exports": { "./*": "./gen/*" },
  "dependencies": { "@bufbuild/protobuf": "2.x (pin in S0.1)" },
  "devDependencies": { "@bufbuild/protoc-gen-es": "2.16.0" },
  "scripts": { "gen": "npx @bufbuild/buf@1.75.0 generate && npx @bufbuild/buf@1.75.0 lint" }
}
```

- `"alinery-proto": "file:../../../proto"` in the daemon's `package.json` (path relative to `vinculum-daemon/`, like `playbook-engine`), and `"alinery-proto": "file:../proto"` in `alinery-app/package.json`.
- `scripts/tests/check-proto-gen.sh`: run `npm --prefix proto run gen` into a temp copy and `diff -r` against `proto/gen`; fail on any difference. Listed in `scripts/check.sh` with the source gates.
- Two steps in `scripts/check.sh`, before the Rust steps:

```bash
step "daemon: bun test"
(cd "$TAURI/vinculum-daemon" && bun test)

step "playbook engine: bun test"
(cd "$ROOT/playbook-engine" && bun test)
```

The `bun` they run is the pinned one from `dev-fetch-bun.sh`, not a PATH search, if that script exposes its path; otherwise the step fails with the command to fetch it.

**Tests.** `proto/roundtrip.test.ts` (run by `bun test` from the daemon step through an import, or a third step): build a `HelloResponse` with every field set, `toBinary` then `fromBinary`, and `equals()` is true; the same through `toJson`/`fromJson`. One vitest file in the app imports the same generated module, so a resolution break fails in both toolchains.

**Exit.** `buf lint` green; `check-proto-gen.sh` green; the two `bun test` steps run in `check.sh` and pass; the compiled daemon binary built by `dev-fetch-bun.sh` still starts (`--protocol-version` prints 24).

### S0.2 RPC spike (O1)

Status: not started. Needs: S0.1.

**Goal.** Evidence for O1 on this machine: does Connect-ES on `node:http` serve unary and server streams over a unix socket under Bun, in `bun run` and in the compiled binary, and what does it cost.

**Read first.** 2.1.7; `vinculum-daemon/src/main.ts:1075` (today's `createServer`); connect-node's `connectNodeAdapter` and `createConnectTransport` docs (4.3).

**Research.** Each line becomes a 4.1 entry or stays in 4.2 with what failed.
- `connectNodeAdapter` behind `node:http` `createServer` listening on a socket path, under `bun run` and under `bun build --compile`.
- The same with `node:http2` `createServer` (gRPC proper). If it fails, record the error and keep (a) with Connect and gRPC-Web only.
- Server interceptors in `connectNodeAdapter({ interceptors })`: does an interceptor see the request headers and can it reject with UNAUTHENTICATED before the handler runs?
- Clients: connect-node `createConnectTransport({ httpVersion: "1.1", baseUrl: "http://daemon", nodeOptions: { socketPath } })`; `curl --unix-socket` with `Content-Type: application/json` (Connect JSON); `grpcurl -unix` (only if http2 works); `npx @bufbuild/buf curl --unix-socket` if supported.
- Cancelling a server stream from the client: does the handler's `ctx.signal` abort?

**Build.** A throwaway `vinculum-daemon/spike/rpc.ts`, not imported by `main.ts`, deleted at the end of the session (its numbers move to 4.1):

```ts
// spike/rpc.ts (throwaway)
const routes = (router: ConnectRouter) =>
  router.service(SpikeService, {
    echo: (req) => ({ data: req.data }),
    async *ticks(req, ctx) {
      for (let i = 0; !ctx.signal.aborted; i++) {
        yield { seq: BigInt(i), data: new Uint8Array(req.size) };
        if (req.intervalMs) await Bun.sleep(req.intervalMs);
      }
    },
  });
createServer(connectNodeAdapter({ routes, interceptors: [rejectWithoutToken] })).listen(process.argv[2]);
```

`SpikeService` lives in `proto/alinery/v1/spike.proto` for the session only.

**Measure.** p50 and p99 of 1,000 unary `echo` calls with 100-byte bodies; throughput of `ticks` with 16 KiB frames and no interval, for 10 s; RSS with 100 idle `ticks` streams open (interval 15 s, like the heartbeat); the same numbers for the old JSON-lines wire (one connection per `version` op) as the baseline.

**Exit.** O1 moves to 4.1 as Decided (with the user) or stays WA with the numbers; the four UNCONFIRMED items for it in 4.2 are resolved; the spike code is deleted.

### S0.3 Bridge spike (O2)

Status: not started. Needs: S0.2.

**Goal.** Prove 2.1.9: a Connect client in the webview reaches a daemon socket through one Tauri command and a `Channel`, unary and streaming, with cancel.

**Read first.** 2.1.9; `src/session.rs:384` (`TAURI_RAW_FETCH_MIN_BYTES` and why frames are padded); `pump_session_stream` (`session.rs:401`, coalescing); `open_daemon_session` (`daemon.rs:450`); Tauri 2.11.3 `ipc::Channel` and `ipc::Request` docs.

**Research.**
- Can one command take a raw `tauri::ipc::Request` body and a `Channel` argument together? If not, the body goes base64 in JSON args (fallback in 2.1.9).
- Does Connect-ES's `createConnectTransport` accept a custom `fetch` (UNCONFIRMED), and does it read a `Response` whose body is a `ReadableStream` built in JS? Check streaming responses specifically.
- hyper (already in `Cargo.lock` as a transitive dependency; `hyper`, `hyper-util` and `http-body-util` are present, not direct dependencies of the app crate) as an HTTP/1.1 client over `tokio::net::UnixStream`: add them as direct dependencies at the versions the lock already carries, so nothing new downloads.
- A custom URI scheme (O2 c) streams a response body? Checked only if (a) fails.

**Build.**
- `daemon_rpc` and `daemon_rpc_cancel` in a new `src/daemon_rpc.rs` (the module owns the bridge; `lib.rs` only gains the two names):

```rust
// src/daemon_rpc.rs (sketch)
#[tauri::command]
pub(crate) async fn daemon_rpc(
    state: State<'_, AppState>,
    repo: String,
    call_id: String,
    path: String,                   // "/alinery.v1.AdminService/Hello"
    headers: Vec<(String, String)>, // content-type, connect-protocol-version, timeouts
    body_b64: String,               // fallback until the raw body is confirmed
    channel: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let target = rpc_socket_for(&state, &repo)?;   // T1 local, T2 forward (S1.3)
    let token = rpc_token_for(&state, &repo)?;     // never sent to the webview
    let stream = UnixStream::connect(&target).await.map_err(|e| e.to_string())?;
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.map_err(|e| e.to_string())?;
    tokio::spawn(conn);
    let req = build_request(&path, &headers, &token, decode(&body_b64)?)?;
    let cancel = state.rpc_calls.register(&call_id);
    let res = tokio::select! { r = sender.send_request(req) => r.map_err(|e| e.to_string())?, _ = cancel.cancelled() => return Ok(()) };
    send_frame(&channel, FrameKind::Head, &head_json(&res))?;
    let mut body = res.into_body();
    let mut batch = FrameBatch::new(Duration::from_millis(8), 16 * 1024);  // as pump_session_stream
    loop {
        tokio::select! {
            frame = body.frame() => match frame { Some(Ok(f)) => batch.push(&channel, f)?, Some(Err(e)) => return send_end(&channel, Some(e)), None => break },
            _ = cancel.cancelled() => return Ok(()),
        }
    }
    batch.flush(&channel)?;
    send_end(&channel, None)
}
```

- The frame format from 2.1.9 (`[u32 len][u8 kind][payload]`, padded to 1 KiB) shares its padding helper with today's terminal pump; extract it if both exist at once.
- `alinery-app/src/daemon/bridgeFetch.ts`: builds a `Response` from the frames:

```ts
// src/daemon/bridgeFetch.ts (sketch)
export function bridgeFetch(repo: string): typeof fetch {
  return async (input, init) => {
    const callId = crypto.randomUUID();
    let head: (h: ResponseInit) => void;
    const headP = new Promise<ResponseInit>((r) => (head = r));
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const onFrame = (frame: ArrayBuffer) => {
          for (const f of splitFrames(frame)) {
            if (f.kind === HEAD) head(JSON.parse(text(f.payload)));
            else if (f.kind === BODY) ctrl.enqueue(f.payload);
            else f.error ? ctrl.error(new Error(f.error)) : ctrl.close();
          }
        };
        void ipc.daemonRpc(repo, callId, pathOf(input), headersOf(init), bodyOf(init), onFrame);
      },
      cancel: () => ipc.daemonRpcCancel(callId),
    });
    init?.signal?.addEventListener("abort", () => ipc.daemonRpcCancel(callId));
    return new Response(body, await headP);
  };
}
```

`ipc.daemonRpc` is a wrapper in `ipc.ts` (the IPC rule); `bridgeFetch.ts` imports nothing from `@tauri-apps/*`.

**Tests.** A Rust test in `src/tests/daemon_rpc.rs` that runs a tiny hyper server on a temp socket and checks the frames for a unary call, a stream of 100 chunks, cancel mid-stream, and a server that closes early. A vitest for `splitFrames` and for `bridgeFetch` against a fake `ipc.daemonRpc` that replays recorded frames. Seeing it in the real webview needs the app running: ask the user first (AGENTS.md "Do not launch the app").

**Exit.** O2 moves to 4.1; the raw-body and custom-fetch items leave 4.2; `daemon_rpc` stays (S1.2 makes it real) or is reverted if O2 lands elsewhere.

### S0.4 Watcher spike

Status: not started. Needs: nothing.

**Goal.** Choose the file watcher for 2.2.8: Bun `fs.watch` with `recursive: true`, or `@parcel/watcher` 2.6.0.

**Read first.** 2.2.8; Bun issues #44780 and #34160 (as reported by research; read them and note whether they apply to macOS FSEvents, Linux inotify, or both).

**Research and measure,** on macOS and in the Linux sshd container (`scripts/tests/remote-sshd/run.sh start`), each in `bun run` and the compiled binary:
- A script that creates, appends, renames over (the `writeAtomic` pattern) and deletes 1,000 files under `.alinery/tasks/*/` while a 10 MB/s append runs on a `*.scrollback` file. Count missed and duplicated events per watcher.
- `@parcel/watcher` inside `bun build --compile`: does the `.node` addon load from the binary, or does it need to sit beside it? (UNCONFIRMED.) If beside, the runtime tarball (`build-remote-runtimes.sh`) and the sidecar copy (`copy-sidecar.sh`) both gain a file.
- CPU while idle with the watcher on a repo of 200 tasks.

**Build.** A throwaway script under `vinculum-daemon/spike/watch.ts`; deleted at the end.

**Exit.** The watcher choice is recorded in 4.1. Whatever is chosen, the 30 s reconcile stays (2.2.8), because no watcher is trusted alone.

### S0.5 Platform spike (O6, durability)

Status: not started. Needs: nothing.

**Goal.** Confirm the three platform facts `platform/lock.ts` and `platform/fs.ts` stand on.

**Read first.** `alinery-core/src/lockfile.rs:25-135`; `alinery-core/src/fs_atomic.rs:20-99`; the existing libc `dlopen` in `main.ts:679` and `:703`.

**Research.**
1. **flock interop.** A Rust test binary holds `LOCK_EX` on a temp file through `lockfile.rs`; a Bun script calls `flock(fd, LOCK_EX | LOCK_NB)` through `bun:ffi` and must get `-1`. Then the reverse. On macOS and in the Linux container.
2. **errno.** Read errno after the failed call (`__error()` on macOS, `__errno_location()` on Linux, then `read.i32` on the pointer) and check it equals `EWOULDBLOCK` (35 on macOS, 11 on Linux).
3. **Durable writes.** Does `fs_atomic.rs` `write_bytes_durable` call `F_FULLFSYNC` on macOS, or plain `fsync`? Does Bun's `fsyncSync` call `F_FULLFSYNC`? Read the Rust source; for Bun, run under `sudo dtruss` (or check Bun's source) for the syscall. Whatever Rust does, `writeDurable` matches.
4. **Hardened runtime.** Does `bun:ffi` `dlopen` of `libSystem.B.dylib` work in the signed, notarized daemon? Signing lives in `alinery-deploy`, so this check goes to the user with a one-line test binary. Today's daemon already dlopens libc in production, which suggests yes.

**Build.** Nothing kept, except the interop test, which becomes the S2.2 test.

**Exit.** O6 moves to 4.1; the errno, F_FULLFSYNC and hardened-runtime items leave 4.2 (the last one may stay with the user).

### S0.6 Cleanup and R1

Status: not started. Needs: nothing (S0.5 for the flock call; until it lands, `withTaskMutation` can use the process queue alone, behind a `ponytail:` comment naming the missing flock).

**Goal.** Delete the dead code, make every daemon write crash-safe, fix R1, and trace O14 so S4.2 starts from facts.

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

6. **O14 trace.** Write in 4.1 (as a note, not a decision) which behaviours read `execution.json` and which read the `engine.jsonl` fold: `executionState` `tasks.ts:155`, `getTaskExecution` :178, the board's current step (`board.rs:166-171`), the Rust readers in `execution.rs`, the subtask manager. List every field each side owns and where the two can disagree.

**Tests.**
- `bun test`: 50 concurrent `addExecution` calls on one task end with 50 entries.
- The same with a Rust helper process holding `.alinery/.task-mutation.lock` for 500 ms during the burst: all 50 land after it releases, none is lost, and a hold longer than 2 s gives `repo_busy`.
- `check-daemon-fs-writes.sh` passes, and fails on a planted `writeFileSync`.

**Exit.** 7 stubs, `playbook_scheduler.rs` and every R4 site gone; the gate is in `check.sh`; the O14 trace is in 4.1.

### S0.7 Decisions with the user

Status: not started. Needs: S0.2, S0.3, S0.4, S0.5, S0.6.

**Goal.** Close the P0 Open items and give P4 its split list.

**Build.** No code. A short writeup in this doc:
1. O3 (source of truth) and O7 (jobs), with the spike numbers. Ask the user; record the answers in 4.1.
2. The 28 MIXED commands by name, each with its 2.3.4 rule and the P4 session that owns each half. This becomes section 2.3.4's table.
3. O1, O2 and the watcher from the spikes: confirm with the user or leave as WA.

**Exit.** O1, O2, O3, O6 and O7 are Decided or explicitly WA with evidence; 2.3.4 has the full list.

## P1: RPC host and transports

### S1.1 RPC server, Admin and auth

Status: not started. Needs: S0.7.

**Goal.** The daemon serves `alinery.v1` on `<repo>/.alinery/rpc[-ns].sock` beside `alineryd[-ns].sock`, with `AdminService.Hello` and bearer-token auth on every call (R8).

**Read first.** 2.1.3, 2.1.7, 2.1.10; `main.ts:26` (`PROTOCOL`), `main.ts:80-97` (ui secret read and delete), `main.ts:660-710` (peer credential checks: `getpeereid` and `LOCAL_PEERPID` on macOS, `SO_PEERCRED` on Linux); `alinery-core/src/daemon_client.rs:1470` (`daemon_command`, the one place that builds the daemon's arguments, used by local spawn in `pi_durable.rs:42` and the host spawn in `repo_service.rs:1021`); `alinery-core/src/protocol.rs:15`.

**Build.**
- `rpc/server.ts` as in 2.1.7, started from `main.ts` after the secret files are read and before sessions resume.
- `rpc/auth.ts`: an interceptor that reads `authorization: Bearer <hex>`, compares with `timingSafeEqual`, and attaches the capability set from 2.1.10 to the context. The peer check needs the socket, which a Connect interceptor does not see; the `node:http` `connection` event records the peer executable per socket in a `WeakMap`, keyed by the request's socket.

```ts
// rpc/auth.ts (sketch)
const peerOf = new WeakMap<Socket, string | null>();
export function trackPeers(server: Server) {
  server.on("connection", (sock: Socket) => peerOf.set(sock, peerExecutable(sock)));  // main.ts:666, moved
}
export const authInterceptor = (secret: Buffer, shellExe: string): Interceptor => (next) => async (req) => {
  const caps = capabilitiesFor(bearer(req.header), secret, peerOf.get(socketOf(req)), shellExe);
  if (!caps.size) throw new ConnectError("missing or wrong token", Code.Unauthenticated);
  req.contextValues.set(CAPS, caps);
  return next(req);
};
```

Whether an interceptor can reach the underlying socket is part of S0.2; if not, the `connectNodeAdapter` is wrapped in a `node:http` handler that sets the capabilities on a context value before handing off.
- `--rpc-secret-file <path>` in `daemon_command`, and the shell side in `daemon.rs` and `remote.rs`: create 32 random bytes, write 0600, pass the path; keep the copy per repo and lane under `<app_config_dir>`.
- `Hello` returns `protocol`, `build_id` (already cached per a2d23306), `epoch` (from the store, or a random UUID until S2.1), the capabilities, `repo_root`, `app_config_identity`.
- `PROTOCOL` 24 to 25 in `main.ts:26` and `protocol.rs:15` (the second socket is an op-set change).

**Tests.** `bun test` with connect-node over a temp socket: no token gives UNAUTHENTICATED; a wrong token likewise; the right token gives `Hello` with all four capabilities when the peer is the expected executable and VIEW and ACT when it is not; the secret file is gone before the socket accepts. `cargo test` for `daemon_command` argument order. `protocol_gate_test.sh` passes at 25.

**Exit.** `curl --unix-socket .alinery/rpc.sock -H 'authorization: Bearer …' -H 'content-type: application/json' -d '{}' http://daemon/alinery.v1.AdminService/Hello` answers; without the header it is refused.

### S1.2 The webview bridge for real

Status: not started. Needs: S1.1, S0.3.

**Goal.** Any view can call any daemon service through `daemonTransport(repoKey)`.

**Read first.** S0.3's result; `daemon.rs` lane routing (`current_alineryd_socket_path`); `paths.rs` `RepoRef`.

**Build.**
- `daemon_rpc` resolves the repo key with `RepoRef::parse`: local gives `rpc[-ns].sock` for the current lane; remote waits for S1.3 and errors until then.
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

**Tests.** vitest: `daemonTransport` caches per repo; a `Hello` through a fake bridge decodes. Rust: `daemon_rpc` on an unknown repo key errors without touching the filesystem.

**Exit.** A view gets `Hello` from a local daemon through the bridge.

### S1.3 ssh forward for the RPC socket

Status: not started. Needs: S1.2.

**Goal.** `daemon_rpc` reaches a remote repo's daemon through a second forward on the same ControlMaster.

**Read first.** `remote.rs` `forward_socket` :303, `forward_spec` :730, `forward` :738 (`control_op("forward")`); the forward naming in the plan file (`f-<fnv(host\0remote sock)[..16]>.sock`).

**Build.** `forward_socket` already names a forward by host and remote socket path, so the RPC socket is a second call with the remote `rpc[-ns].sock` path. `attach_remote_repo` opens both forwards. Liveness for the RPC forward is a `Hello` through the bridge path (a connect alone proves nothing over a forward, 2.1.3). The token for a remote daemon comes from the shell's per-host store (never written on the host), passed with `--rpc-secret-file` through `SpawnDaemon` and deleted on read like the ui secret.

**Tests.** The live remote test (`cargo test -p alinery-app --lib -- tests::remote::live`, with `remote-sshd/run.sh`) gains: `Hello` through the forward; `-O exit` on the master, reconnect, `Hello` again with the same `epoch` (the daemon didn't restart).

**Exit.** A remote repo answers `Hello` through the bridge; disconnect and reconnect keep the epoch.

### S1.4 Shutdown with an origin

Status: not started. Needs: S1.1.

**Goal.** The five teardown origins (invariant 1) call `AdminService.Shutdown` with their `ShutdownOrigin`, and the gate checks the enum's callers.

**Read first.** `scripts/tests/check-no-auto-session-kill.sh`; the five callers: `stop_daemon` (`daemon.rs:1196`), `close_repo_daemon` (`daemon.rs:1292`), `restore_backup`, `confirm_repo_takeover_blocking`, `stop_remote_daemon`; `main.ts:761` (today's `shutdown` op).

**Build.**
- `Shutdown` in `rpc/admin.ts` requires ADMIN, rejects `UNSPECIFIED`, checks `confirmation_id` for `CONFIRMED_TAKEOVER`, logs the origin, then runs the same teardown as `main.ts:761`.
- The shell sends it through a small Rust helper (the shell has no generated protobuf client; a Connect unary call is a POST with a protobuf body, so `prost` or a hand-encoded two-field message is enough). Keep the helper in `daemon_rpc.rs` beside the bridge.
- The gate checks that `ShutdownOrigin::` appears only in the five functions, and that the old `shutdown` op has no new callers (it goes in S5.3).

**Tests.** `bun test`: each origin shuts down; `UNSPECIFIED` is INVALID_ARGUMENT; no ADMIN is PERMISSION_DENIED. The gate fails on a planted sixth caller.

**Exit.** Teardown goes through `Shutdown` with an origin; the old op is unused by the shell.

## P2: Sync engine core

### S2.1 Store and Subscribe

Status: not started. Needs: S1.1.

**Goal.** `SyncService.Subscribe` serves any scope from an in-memory store: snapshot, ring replay, live deltas, backpressure and heartbeats. Only tests commit to the store in this session; S2.3 to S2.6 connect the real feeds.

**Read first.** 2.1.4 (the messages), 2.2.1 to 2.2.7, 2.2.9; S0.2's notes on server streams and `ctx.signal`.

**Research.**
- Does protobuf-es v2 `equals(EntitySchema, a, b)` compare a set oneof message field by field? Read `equals.ts` in protobuf-es and confirm with a test. If it doesn't, compare `toBinary` of both with `revision` cleared: protobuf-es writes fields in field-number order, and entities use no map fields, so equal messages give equal bytes.
- Does a client that goes away fire `ctx.signal` both on connect-node over a unix socket and through the bridge (`daemon_rpc_cancel`, 2.1.9)? S0.2 measured the first; this session checks the second.

**Build.**
- `proto/alinery/v1/sync.proto` and `entities.proto` as in 2.1.4. The oneof field numbers are fixed now. Each entity message gets its fields in the session that first produces it (S2.3 session, S2.4 execution, S2.5 daemon status, S2.6 job, S3.5 task, P4 the rest). Field names are the snake_case form of today's serde names, so proto JSON lines up with the IPC JSON for the conformance tests (S2.3).
- `sync/store.ts`: the store from 2.2.9 (seq taken only once a change exists), a ring of 10,000 changes, `rowsMatching(scope)` filtering keys by 2.2.6, and a `Subscriber` class in the same file: a bounded queue (1,000 frames or 4 MB), a 16 ms coalescing timer, a 15 s heartbeat, and on overflow one `MustRefetch` and the end of the stream. Timers come in through the constructor so tests drive them.
- `store.open(scope, cursor, signal)`:

```ts
// vinculum-daemon/src/sync/store.ts (continued, sketch)
async *open(scope: Scope, cursor: Cursor | undefined, signal: AbortSignal): AsyncGenerator<SyncFrame> {
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
- A seeded property test with a small LCG (no new dependency): 1,000 commits of puts and deletes over 50 keys in 3 scopes. A replica subscribes, drops its stream at random points and resumes with its last cursor. After the last commit the replica equals `rowsMatching(scope)`. Three seeds.
- A cursor from another epoch, or older than the ring, gets a snapshot. A current cursor gets only the missed deltas, then `UpToDate`.
- A subscriber that never reads gets `MustRefetch` after 1,000 frames, and commit time does not grow with it.
- A put equal to the stored row consumes no seq and sends nothing.
- Heartbeats and coalescing with injected timers.
- Dedupe: a repeated `mutation_id` gets the first answer; the 257th id evicts the oldest.
- Aborting the signal removes the subscriber.

**Measure.** 200 subscribers on the repo scope with 10,000 rows: snapshot time, memory per subscriber, and the time one commit takes to fan out. Record in 4.1.

**Exit.** `Subscribe` over the bridge returns test rows; the property test passes on three seeds.

### S2.2 Platform layer for real

Status: not started. Needs: S0.5, S0.6.

**Goal.** `withTaskMutation` takes the real flock, and one file sends every signal to a child.

**Read first.** 2.3.2; S0.5's spike notes (flock and errno through `bun:ffi`, `F_FULLFSYNC`); the `ponytail:` comment S0.6 left in `platform/lock.ts`; `mcp.ts:246` (spawn) and `:323` (kill); `terminal.ts:127` (spawn) and `:198` (kill); `scripts/tests/check-no-auto-session-kill.sh`.

**Build.**
- `platform/lock.ts`: `tryLockExclusive`, `isLockedByOther` and `waitForLock` as in 2.3.2. `withTaskMutation` takes the flock after the process queue; the `ponytail:` comment goes.
- `writeDurable` calls `F_FULLFSYNC` if S0.5 found that Rust does.
- `platform/process.ts`: `spawnDetached` and `signalChild(child, signal, reason)`. The spawns and kills in `mcp.ts` and `terminal.ts` move there.
- `check-no-auto-session-kill.sh` also scans `vinculum-daemon/src`: `.kill(` and `process.kill(` may appear only in `platform/process.ts`, and every `signalChild` caller is listed in an allowlist with its reason (user kill of a session, MCP child restart, job cancel).

**Tests.**
- The S0.5 interop test now runs against the real `withTaskMutation`: a Rust helper process holds `.alinery/.task-mutation.lock`; the TypeScript call waits and then runs; a hold longer than 2 s gives `repo_busy`.
- A lock file replaced between open and flock is retried and the new file is locked.
- The gate fails on a planted `proc.kill()` in `runtime/`.

**Exit.** No `.kill(` outside `platform/process.ts`; the interop test passes.

### S2.3 Watcher, reconcile and the first parser

Status: not started. Needs: S2.1, S0.4.

**Goal.** Files written by agents, by Rust during the strangler period, or by hand reach the store. Session meta is the first entity fed this way.

**Read first.** 2.2.8 (feed 2); S0.4's watcher choice; `shared.rs:1288` (`read_session_meta_full`) and its tests; `types.ts:447` (`SessionMeta`).

**Research.** Which `SessionMeta` fields Rust writes today and which the daemon writes (grep the `meta.json` writers on both sides), so the parser reads every field either side writes.

**Build.**
- `sync/watcher.ts` wraps the S0.4 choice. It watches `.alinery/tasks/**`, `config.toml`, `harnesses.toml` and `playbooks.toml`, ignores `worktrees/`, `*.scrollback` and `.alinery/tmp/`, debounces per path (WA 50 ms), and routes each path to a parser.
- `sync/parsers/index.ts`: a list of `{ match: RegExp, parse(path): Entity | null }`. `null` deletes the key.
- `sync/parsers/sessionMeta.ts` ports `read_session_meta_full`.
- `sync/reconcile.ts`: every 30 s, stat each tracked file and re-parse it when mtime or size changed; a missing file deletes its key; `readdir` of the task directories finds new files.
- Start order in `main.ts`: full scan with the same parsers, then the watcher, then the reconcile timer, then the RPC server listens.
- Conformance layout (WA): `alinery-app/src-tauri/conformance/<domain>/<case>/input/` (a small `.alinery` tree) and `expected.json` (today's serde JSON of the Rust result). A Rust test in `alinery-core/tests/conformance.rs` runs the Rust reader over each case; `UPDATE_FIXTURES=1` rewrites `expected.json`. A `bun test` runs the TypeScript parser over the same cases and compares `toJson(entity)`. Both sides drop null and default-valued fields before comparing, because proto3 JSON omits defaults. The directory outlives Rust (migration rule 5).

**Tests.**
- Writing, renaming over and deleting a `meta.json` gives put, put, delete. Writing the same bytes again gives no frame.
- With the watcher stopped, a changed file appears after one reconcile pass (injected clock).
- Appending 1 MB to a `.scrollback` calls no parser.
- Every session-meta conformance case passes in `cargo test -p alinery-core` and `bun test`.

**Exit.** A session meta written by Rust reaches a subscriber as a delta.

### S2.4 Engine events

Status: not started. Needs: S2.1.

**Goal.** Each playbook engine event commits the task's execution entity.

**Read first.** `playbook-engine/src/engine.ts:36` (`EngineOptions`), `:93` (`Engine.open`), `:312` (`#append`: `appendLog`, then `apply`); `playbook-engine/src/state.ts:89` (`Event`), `:196` (`appendLog`); `graph.ts:262` (`openTask`, which calls `Engine.open` at :278); `tasks.ts:155` (`executionState`), `:178` (`getTaskExecution`); `types.ts:772` (`ExecutionRecord`), `:802` (`TaskExecutionState`).

**Build.**
- `EngineOptions.onEvent?: (ev: Event, state: State) => void`, called in `#append` after `apply`. An exception from `onEvent` is logged and never fails the engine.
- `Event` gains `at` (ms since epoch), set in `appendLog`. The fold ignores it, so logs without `at` still fold.
- `openTask` passes `onEvent: () => commitExecution(repo, slug)`.
- `domain/executions.ts`: `commitExecution(repo, slug)` uses the builder that `getTaskExecution` uses, extracted so both call it. The RPC read and the delta can't differ. Until S4.2 decides O14, the entity carries what `getTaskExecution` returns today (`TaskExecutionState`, `types.ts:802`).

**Tests.** Run `alinery-core/tests/fixtures/parallel-numbers.md` through the engine with the fake harness the engine tests already use. A task-scope subscriber sees one execution delta per event, and the last one equals `getTaskExecution`. An `engine.jsonl` written before this change folds to the same state.

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

**Exit.** `JobService.Start` for a storage scan returns an id, and the Job reaches DONE with a `StorageInfo` result.

## P3: Client library and first slices

### S3.1 Replica and hooks

Status: not started. Needs: S1.2, S2.1, S2.5.

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

**Exit.** No session status poll is left in `src/`; the four commands are gone.

### S3.3 WatchTranscript

Status: not started. Needs: S3.1.

**Goal.** Pi transcripts stream from an item index instead of being re-read whole.

**Read first.** 2.1.5 (`WatchTranscript`); `transcript.ts:23` (`TranscriptPart`), `:29` (`TranscriptReply`); `main.ts:446` (`transcriptMessages`), `:882-896` (the `transcript` op); `session_transcript` (`session.rs:1175`, called from `SessionView.tsx:1382`); `read_session_history` (`session.rs:1424`); `ipc.ts:338` (`readChatOmp`), `:380` (`readSessionHistory`), `:385` (`sessionTranscript`).

**Research (UNCONFIRMED).** Does pi-durable notify on a change to a conversation, the way `watch` (:532) gets one for the Attention doc? If not, the daemon polls the conversation every 250 ms for each open watch. That is one poll in the daemon instead of one per client.

**Build.**
- `TranscriptItem` in `sessions.proto`, built from `TranscriptReply` and `TranscriptPart`.
- `runtime/transcript.ts`: `watchTranscript(ref, fromItem, signal)` sends the items from `fromItem`, then waits for a change. When an earlier item changed (a streaming message updated in place), it sends from that item with `replace = true`.
- `rpc/sessions.ts`: `WatchTranscript` requires VIEW.
- `SessionView` and `ChatView` render from the stream. Delete `session_transcript`, the `transcript` op, and `read_chat_omp` and `read_session_history` if nothing else calls them, with their wrappers.

**Tests.** `bun test`: from item 0 gets everything; an append sends only the new item; editing the last item sends it with `replace`; resuming at `next_item` sends nothing old.

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

**Exit.** A remote terminal survives a forward drop with no duplicated output; the pump and the queue are gone.

### S3.5 Board reads

Status: not started. Needs: S3.1, S2.3, S2.4.

**Goal.** Tasks and the board come from the repo scope, and the 8 board-read `RepoOp` variants retire (2.3.3).

**Read first.** `task.rs:603` (`list_tasks`), `:618` (`list_board_tasks`), `:645` (`list_task_activity`); `session.rs:41` (`get_session_display`); `board.rs:166-171` (current step); `types.ts:163` (`TaskActivityStatus`); the board rows of 2.2.11; Rust's task frontmatter tests.

**Build.**
- `sync/parsers/task.ts`: `task.md` TOML frontmatter with `Bun.TOML.parse` (built in, no dependency), with conformance cases from the Rust parse tests.
- The current step is derived in the daemon (R3): a field of the Task entity, ported from `board.rs:166-171`, recomputed when a session or execution of that task commits. The Rust copy goes in this session.
- Every caller of the 8 board reads (ListBoardTasks, ListTasks, GetTask, TaskActivity, ListSessions, ListSessionItems, ReadSessionMetas, GetSessionDisplay) moves to a subscription, including the non-board callers of `get_task`, `list_sessions` and `list_session_items`. The 8 variants, their `run()` arms, their round-trip test entries, the commands and the pollers in 2.2.11 go.
- Put O19 to the user before deleting anything. Today a repo whose daemon is down, speaks another protocol, or belongs to another app instance still shows its board, read from files (`README.md:87`; `DaemonConflict` in AGENTS.md). After this session the board comes from a daemon, and the desktop replica keeps nothing across an app restart (2.2.10).
- The all-repos board becomes one subscription per repo. Today a local repo that fails to read fails the whole board (`task.rs:625`, `?` on the local arm) while a remote one is skipped; after this each repo shows its own stale banner.

**Tests.** Task conformance cases and current-step cases (from `board.rs` tests) in cargo and bun. vitest: a Kanban card moves when an execution delta arrives; with one repo's daemon down, the other repo's board stays live and the down one shows stale.

**Exit.** O19 is in 4.1. No board poller is left; the 8 variants are gone (under O19 (c), they stay for that case only); `remote-local-only.txt` and `remote-offload-ok.txt` lose their entries for the deleted commands.

## P4: Domain ports

Every P4 session follows the same recipe. Its **Build** lists only what the recipe doesn't cover.

**The port recipe.**
1. **Fixtures first.** Turn the domain's Rust tests into `conformance/<domain>/<case>/` (layout in S2.3) and make them pass against Rust with `UPDATE_FIXTURES=1` before any TypeScript exists. A write case also keeps an `after/` tree: the files the command left behind, compared byte for byte except where the session names a field that may differ (a timestamp, a random id).
2. **Read model.** `sync/parsers/<domain>.ts` and the entity's fields, fed by the watcher, so the UI can subscribe while Rust still writes (rule 4). Skip it when an earlier session already did.
3. **Write path.** `domain/<domain>.ts` writes through `platform/fs` inside `withTaskMutation`, then calls `store.commit`. The fixtures now run against TypeScript too.
4. **Service.** `proto/alinery/v1/<domain>.proto` in the 2.1.6 shape, and `rpc/<domain>.ts` with the capability each call needs.
5. **Flip every caller in one PR** (rule 2): the views, and the MIXED halves this session owns (S0.7 list).
6. **Telemetry** per O17, for the events the session names.
7. **Delete**: the Tauri commands and their `generate_handler!` names; the `ipc.ts` wrappers and their `mockIpc` entries; the `RepoOp` variants with their `run()` arms and round-trip entries; core functions left with no caller; the entries in `remote-local-only.txt` and `remote-offload-ok.txt`.
8. **Bump `PROTOCOL`** (`protocol.rs:15` and `main.ts:26`).
9. **Records.** Status line, the 1.4 counts, 4.1 for any decision, 4.5.

**The standing exception to rule 2: `alinery-mcp`.** Agents call it, and it writes four domains itself until S5.1 settles O10: settings TOML (`write_toml_file`, `mcp/src/main.rs:1154`, a plain `fs::write` with no lock), task creation (`create_task`, `:1196`), the playbook library (`call_playbook_library`, `:528`) and the pre-archive backup (`create_pre_archive_backup`, `:397`). The session that ports one of those domains moves the MCP write under the shared flock if it isn't already there, and keeps the core function it calls. The watcher picks up its writes (2.2.8). S5.1 deletes what is left.

### S4.1 Settings

Status: not started. Needs: S3.1, S2.3.

**Goal.** The daemon owns repo `config.toml`, `harnesses.toml` and the effective settings; the shell keeps global `app.toml`. The first mutation lands, and with it the optimistic overlay. Fixes R3 for settings precedence.

**Read first.** App `settings.rs`: `:97-99` (absent inherits, a present blank string is a value), `read_overrides` :125, `write_overrides` :132, `scoped_for` :148, `read_config` :166, `read_config_for_repo` :172, `read_global_settings` :178, `write_global_settings` :229, `read_scoped_settings_for_repo` :261, `read_repo_overrides_for_repo` :267, `emit_repo_settings_change` :272, `write_repo_overrides_for_repo` :283, `clear_repo_override_for_repo` :300, `write_config` :315. Core `shared.rs` from :756: `ScopedSettings` :765, `resolve_backup` :816, `resolve_effective_config` :827, `read_scoped_settings` :843, `clear_repo_override` :861, the harness overlay :888-:1049. Core `types.rs:917` (`RepoOverrides`: github, defaults, backup); core `settings.rs:290`, `:296`, `:326` (the TOML writes) and `:483` (`log_repo_settings_event`). Daemon `sessionControls.ts:75-123` (the second precedence). 2.2.7.

**Research (UNCONFIRMED).** Does the pinned Bun's `Bun.TOML` have only `parse`? Today Rust writes with `toml::to_string`, so comments in `config.toml` are already lost on every write; the port need not keep them. Writer options, to decide in this session: (a) `smol-toml` `stringify` (already a daemon dependency, `package.json:11`); (b) a writer for the `RepoOverrides` shape only. Either way the `after/` fixtures pin the bytes.

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
- Decide O17 with the user, using `SettingsChange` (`settings.rs:275`) as the worked example.

**Tests.** Conformance from the core `settings.rs` tests and `shared.rs` precedence cases: absent inherits, blank wins, a clear restores the global value. `after/` trees for write and clear. vitest: the overlay shows the new value at once, keeps it until the cursor passes, and rolls back on an error.

**Exit.** The settings commands above, `ReadRepoOverrides` and `WriteRepoOverrides`, and the TS precedence copy are gone. `read_config` callers read `settings/_/repo`.

### S4.2 Executions

Status: not started. Needs: S4.1, S2.4, S0.6 (the O14 trace).

**Goal.** One execution state machine in TypeScript (R2), and execution reads and approvals through the store.

**Read first.** The S0.6 trace (O14) in 4.1. Core `execution.rs`: `mutate_execution_state` :325, `reserve_execution` :496, the transitions :619-:857, `execution_assignment_prompt` :866; `execution_tests.rs` (53 tests). App `daemon.rs`: `task_execution_for` :76, `observe_task_executions_in` :207, `observe_task_executions` :328, `observe_remote_task_execution` :364, `allow_execution_completion` :417. `ipc.ts:350-353`. Daemon `tasks.ts`: `executionState` :155, `getTaskExecution` :178, `addExecution` :291. `playbook-engine/state.ts`.

**Build.**
- Put O14 to the user with the trace: (a) the `engine.jsonl` fold is the truth and `execution.json` goes; (b) `execution.json` is the truth and the fold feeds it. Record the answer in 4.1 before writing code.
- `domain/executions.ts`: the transitions ported from `execution.rs` :219-:866, writing the chosen truth.
- The execution entity (from S2.4) gets every field the views read. `ExecutionService.AllowCompletion` (APPROVE, `expected_revision`) replaces `allow_execution_completion`.
- The four observe commands and `ipc.ts:351-353` go; their callers read the execution entity.
- **Caveat, rule 2 does not hold yet.** Five Rust modules besides `execution.rs` write execution state: `task_creation.rs`, `task.rs`, `session_name.rs`, `subtask.rs` and `repo_ownership.rs`. They keep writing, under the shared flock, until S4.3, S4.4, S4.8 and S4.11 port them. Every TypeScript write in this session goes through `withTaskMutation`, and the watcher commits the Rust writes. Write this down in 4.1 as a known exception.

**Tests.** Conformance from the 53 `execution_tests.rs` cases (state in, transition, state and files out). An interop test: a Rust `reserve_execution` and a TypeScript transition on one task, interleaved, end in a valid state. vitest: approving moves the card once the delta arrives.

**Exit.** `SavedExecution` and the observe and allow commands are gone. R2 is closed if O14 picked one truth; the multi-writer note in 4.1 lists which sessions remove each Rust writer.

### S4.3 Tasks, drafts, attachments

Status: not started. Needs: S4.2, S3.5.

**Goal.** Task create, rename, duplicate, archive, restore, drafts and attachments are daemon commands. The daemon stops calling `alinery_provision_task` over FFI.

**Read first.** App `task.rs`: `get_task` :39, `create_task` :55, `rename_task` :71, `duplicate_task_for_repo` :92, `archive_task_in` :654, `restore_task_in` :658, `archive_task_off_thread` :662 (PreArchive backup at :670 and :685, `TaskArchive` at :692), `archive_task` :701. Core `task_creation.rs`, `task.rs`, `task_drafts.rs`, `attachments.rs`, `task_activity.rs`. Daemon `tasks.ts:65` (`coreCall`) and `:332` (the provision call), `provision_ffi.rs:58`. `artifacts.rs` `attachment_path`. 2.1.5 (`BlobService`).

**Build.**
- `domain/tasks.ts`: create (slug, `task.md`, worktree, execution reservation from S4.2), rename, duplicate, archive, restore, auto-approve, related tasks.
- `platform/git.ts` gets `worktreeAdd`. It is the only git spawn site (invariant 3).
- Drop `alinery_provision_task` from `tasks.ts`; `provision_ffi.rs:58` and its export go. `alinery_create_subtask` and `alinery_set_session_name` stay until S4.8 and S4.4.
- The pre-archive backup becomes a job the daemon starts before it archives (S2.6). It waits for the job and refuses to archive if the backup fails, as `:670` does today.
- Attachments: the shell reads a picked or dropped file and uploads it through `BlobService`; `CommitUpload` writes it under `artifacts/attachments/`. `attachment_path` becomes a shell reveal of a `BlobRef` on a local repo and is hidden for a remote one.
- Drafts are entities (`draft/*`); the draft commands become `DraftService` writes.
- MIXED halves from S0.7 that create a session after a task (rule "builds a domain request, then creates a session") become one daemon command.
- `alinery-mcp` `create_task` (`main.rs:1196`) stays on core under the flock until S5.1.
- Telemetry: `TaskArchive` (`task.rs:692`).

**Tests.** Conformance from the `task_creation.rs`, `task_drafts.rs` and `attachments.rs` tests, with `after/` trees (the slug and timestamps may differ). An archive whose backup job fails leaves the task unarchived. vitest: create shows the card at once through the overlay.

**Exit.** The 14 variants in 2.3.3, the task commands and `provision_task` FFI are gone.

### S4.4 Session meta and chat

Status: not started. Needs: S4.3.

**Goal.** Session meta writes, message actions, history and chat threads move to the daemon, which already runs these sessions.

**Read first.** Core `session_name.rs`, `session_actions.rs`, `history.rs`, `chat.rs`, `message.rs`; app `chat.rs` and `session.rs`; `notify.rs` (`notify_session_attention`, `set_dock_badge_count`, `notify_test`); daemon `tasks.ts:55-58` (`suggestSessionName`, calling `alinery_set_session_name`, `provision_ffi.rs:89`). Pollers `ChatView.tsx:300` and `QuickChat.tsx:227`.

**Build.**
- `domain/sessions.ts`: rename, archive stamp, notification read and clear, message actions (finalize, prepare review approval), history and the OMP window.
- Session naming moves into TypeScript; `suggestSessionName` and `alinery_set_session_name` go.
- Chat threads are entities in the chat scope: list, create, start, pin, archive, worktree add and remove, branch label, attachments (through `BlobService`), images (through `BlobService.Read`).
- The Session entity gets the attention body. `notify_session_attention` keeps the OS notification in the shell; the text comes from the entity, so the shell reads no meta file.
- The two chat pollers read the chat scope.
- Telemetry: `SessionArchive` (`session.rs:310`), `SessionKill` (`session.rs:1321`).

**Tests.** Conformance from the `session_name.rs`, `history.rs` and `chat.rs` tests. vitest: a new chat thread appears in the rail with no poll; a renamed session updates everywhere it shows.

**Exit.** The 10 session variants and 12 chat variants in 2.3.3 are gone, with their commands, both pollers and the naming FFI.

### S4.5 Artifacts and comments

Status: not started. Needs: S4.3.

**Goal.** All 25 artifact commands go: artifact metadata and comments are entities, bodies come through `BlobService`.

**Read first.** App `artifacts.rs` (25 commands; `ArtifactReviewHandoff` :176, `ArtifactReviewSend` :505, `ArtifactCommentAdd` :591); core `artifact_tree.rs`, `artifact_comments.rs`; the artifact half of `shared.rs` (:144-:756: `visible_artifact_names` :618, `list_artifacts_with_metadata_for` :651, `list_artifacts_with_execution_metadata` :711). Pollers `SessionView.tsx:719` and `:736`, `TaskDetail.tsx:580`.

**Build.**
- `sync/parsers/artifacts.ts`: the artifact scan, which never sees `artifacts/attachments/`.
- Artifact metadata and comments are entities in the task scope. Comments write with `expected_revision` (2.2.7); drafts of comments too.
- Bodies and images: `BlobService.Read`. `artifact_node_path` and `artifact_comment_markdown_path_for` become a shell reveal of a `BlobRef`, hidden for remote repos.
- Review handoff and send become one daemon command each.
- The three pollers read the task scope.
- Telemetry: the three events above.

**Tests.** Conformance from `artifact_tree.rs`, `artifact_comments.rs` and the `shared.rs` artifact tests. An agent writing `artifacts/03-plan.md` straight to disk shows up through the watcher. vitest: a comment from another client appears with no poll.

**Exit.** The 17 artifact and comment variants, the 25 commands and three pollers are gone.

### S4.6 Playbook library

Status: not started. Needs: S4.1, S0.6.

**Goal.** Playbook read, validate, render, save and delete in TypeScript; one playbook parser (R3).

**Read first.** App `playbook.rs` (9 commands: `list_playbook_catalog`, `read_playbook`, `validate_playbook_source`, `render_playbook_source`, `save_playbook_source`, `delete_playbook_source`, `read_playbook_picker_preferences`, `save_playbook_picker_preferences`, `list_kanban_columns`). Core `playbook_library.rs` (`save_playbook_if_unchanged` :596), `playbook.rs` (`deny_unknown_fields` at :31, :138, :146), `playbook_tree.rs`. `playbook-engine/` (its own parser). MCP `call_playbook_library` (`main.rs:528`).

**Build.**
- One parser in `playbook-engine/` for both the engine and the library. It rejects unknown fields as `deny_unknown_fields` does.
- Playbooks are entities (`playbook/*`); the catalog and kanban columns are derived from them.
- `save_playbook_if_unchanged` becomes `expected_revision` on `PlaybookService.Save`.
- Validate and render stay unary RPCs (2.1.6: computed answers).
- Picker preferences: the repo half moves; the global half stays with `app.toml` (shell).
- MCP `call_playbook_library` keeps the core path under the flock until S5.1.

**Tests.** Conformance from the `playbook.rs`, `playbook_library.rs` and `playbook_tree.rs` tests, including every unknown-field rejection. A save with a stale revision is ABORTED.

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

**Research (UNCONFIRMED).** Which git does the daemon find on a remote host and on a Mac without Command Line Tools? Port the `git_cmd` lookup order (PATH, then the alongside tree with `GIT_EXEC_PATH`) and test it on both.

**Tests.** Conformance from the `git_actions.rs` tests against a temp repo. The scrub test: a `GIT_DIR` in the daemon's env does not reach the child.

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

**Exit.** The 4 subtask variants and commands are gone, and so is `provision_ffi.rs`.

### S4.9 Storage and backup as jobs

Status: not started. Needs: S2.6, S4.3.

**Goal.** Backup, verify, storage scan and purge are jobs; the backup queue leaves the shell.

**Read first.** App `backup.rs` (`pick_backup_destination_dialog`, `backup_now`, `backup_busy`, `list_backups`, `check_backup_destination`, `restore_backup`; telemetry at :152, :233, :332, :367), `backup.rs:43-61` (the debounce), `backup_queue.rs`; app `settings.rs` `storage_info` :326 and `delete_all_archived_storage` :354 (`StoragePurge` at :391). Core `storage.rs`, `backup.rs`. `src/views/Settings.tsx:518`. 2.3.5.

**Build.**
- Decide O11 (zip). Spike first: a Rust-made `-v1.zip` verifies and restores through the TypeScript code, and a TypeScript one through Rust. If `fflate` fails either way, put (b) to the user.
- `jobs/backup.ts` (create and verify) and `jobs/purge.ts`; `jobs/storage.ts` exists from S2.6.
- Automatic triggers: the daemon owns the 2 s debounce and starts backup jobs itself. `backup_queue.rs` and `backup.rs:43-61` go.
- `pick_backup_destination_dialog` stays in the shell; the picked path goes to a settings write (S4.1).
- Storage scan and purge need ADMIN.
- Restore stays `Shutdown(RESTORE_BACKUP)` then a one-shot restore (2.3.5); the shell still runs it locally, and the host bootstrap runs it remotely (O15).
- Telemetry: `BackupCreate`, `BackupRestore`, `StoragePurge`.

**Tests.** The zip compatibility test both ways. A purge job's progress reaches a subscriber; cancel leaves no half-deleted task (each task is removed atomically or not at all).

**Exit.** The 7 storage and backup variants, `backup_queue.rs`, `storage_info`, `delete_all_archived_storage` and the `Settings.tsx:518` poll are gone.

### S4.10 Imports, community import, agent dir

Status: not started. Needs: S4.3, S4.6.

**Goal.** Issue imports and community playbook imports write through the daemon; the agent dir gets one owner (O12).

**Read first.** App `imports.rs` (`import_linear`, `import_linear_for_repo`, `import_github`, `import_github_for_repo`; `import_github_at` :618; `RepoOp::GitOriginUrl` :625; `ImportFetch` at :187 and :608). `community_playbooks.rs`: repo-scoped at :435, :455, :933, :951, :1343; catalog, preview and mine at :424, :621, :1002. `omp_update.rs` (`omp_agent_sessions_dir`, `read_omp_model_roles`, `write_omp_model_roles`); `vinculum_customizations.rs` (`read_vinculum_customizations`, `open_vinculum_agent_dir`, `vinculum_customization_prompt`, `pick_vinculum_skill_dialog`, `install_vinculum_skill`, `delete_vinculum_skill`).

**Build.**
- Linear and GitHub (2.3.4, "needs this Mac's secrets"): the shell fetches the issues with its tokens and passes them to `TaskService.Import`, which creates the tasks. `GitOriginUrl` becomes a unary RPC the shell calls first.
- Community: the five repo-scoped commands become daemon writes (the shell downloads the package and uploads it through `BlobService`). The catalog, preview and mine commands stay in the shell.
- Put O12 to the user: (a) the agent dir lives per host, the daemon owns it and the shell mirrors the Mac's copy; (b) it lives on the Mac only, the shell owns it and pushes it. Then move the model-role and skill commands to the chosen side. The dialogs (`pick_vinculum_skill_dialog`, `open_vinculum_agent_dir`) stay in the shell either way.
- Telemetry: `ImportFetch` (stays in the shell, which does the fetch).

**Tests.** Conformance for import: a fixed issue list in, task trees out. A community import into a remote repo writes on the host.

**Exit.** The import and community commands are split as above; O12 is Decided.

### S4.11 Ownership, takeover, keep-awake, hosted handoff

Status: not started. Needs: S4.2, S4.8, S2.2.

**Goal.** Repo ownership and keep-awake run without `libalinery_core`; the hosted token reaches the daemon as a settings write.

**Read first.** Core `repo_ownership.rs`, `ownership_ffi.rs` (:27, :53), `idle_inhibit.rs` (:25, :40, :45). Daemon `main.ts:224-233` (keep-awake) and `:254-259` (`alinery_pi_acquire`). App `session.rs:458` (`spawn_pi_hosted_refresh`) and `:505` (`open_session`); `daemon.rs` takeover commands.

**Build.**
- Decide O9 with a test on both platforms: (a) keep the IOKit FFI; (b) `caffeinate -w <pid>` on macOS, `systemd-inhibit` on Linux, as a child the daemon holds.
- `domain/ownership.ts`: `repo_ownership.rs` ported onto `platform/lock.ts`, under `withTaskMutation`. It is the last Rust writer of execution state (S4.2 caveat).
- `main.ts:224-233` and `:254-259` stop calling FFI; `ownership_ffi.rs` and (if O9 b) `idle_inhibit.rs` go.
- The hosted refresh (`session.rs:458`) stays in the shell, which holds the account; it sends the token as a settings write instead of a file the daemon reads. `open_session`'s preflight is the daemon's (2.3.4).
- Takeover keeps its app-only prepare, confirm and cancel; confirm sends `Shutdown(CONFIRMED_TAKEOVER)`.

**Tests.** Ownership conformance from the `repo_ownership.rs` tests. Two daemons on one repo: the second gets `repo_busy`. Keep-awake: the inhibitor child exits when the daemon exits.

**Exit.** No `libalinery_core` dlopen is left in the daemon (`tasks.ts:15-47` and the FFI in `main.ts` are gone).

### S4.12 Providers and models

Status: not started. Needs: S1.1.

**Goal.** Provider login, the catalog and model lists are a typed service instead of raw JSON-lines ops.

**Read first.** Daemon `main.ts:965-1002` (the `provider_*` and `custom_provider_*` ops); app `session.rs` provider commands (:1215, :1221, :1233, :1239, :1251, all through `active_daemon`); app `settings.rs` `grok_key_ready` :58, `list_harness_models` :74, `list_harness_models_for_repo` :85; `credentials.ts`.

**Build.**
- `ProviderService`: `Catalog`, `LoginStart`, `LoginPoll`, `Logout`, `SaveCustom`, `DeleteCustom`, and `ListModels`, which replaces `list_harness_models(_for_repo)`.
- Login and logout need ADMIN: they touch credentials.
- The browser sign-in stays in the shell (it opens the Mac's browser); the daemon holds the device-code poll.
- Credentials sharing with a remote host is unchanged (`RemoteSharing`); this session moves the wire only.

**Tests.** `bun test` with a fake provider: login start, poll, logout. vitest: the model picker reads `ListModels`.

**Exit.** The provider ops leave the JSON-lines wire; the five session commands and the two model-list commands are gone.

## P5: Shell slimming

MCP and the host bootstrap go first, because both still reach the daemon or the repo through code that S5.3 deletes.

### S5.1 MCP as a daemon client (O10)

Status: not started. Needs: S4.3, S4.6, S4.8, S4.9 (the domains MCP writes), S1.1.

**Goal.** Every `alinery-mcp` tool goes through the daemon's RPC, and MCP writes no `.alinery/` file itself. This ends the standing exception to rule 2 (P4 intro).

**Read first.** MCP `main.rs` (2,552 lines): the 25 tools at :416-441; `create_pre_archive_backup` :397; `call_playbook_library` :528; `task_client` :588 (its `start_daemon` flag); `connect_compatible` :688; `write_toml_file` :1154; `create_task` :1196. App `mcp.rs` (the managed MCP child). 2.1.10 (the AGENT capability). AGENTS.md: MCP never exposes attach, write, resize, detach, kill, resume, takeover or bulk operations, and a mismatch never triggers teardown.

**Build.**
- Put O10 to the user: (a) Rust `alinery-mcp` stays, and each tool becomes an RPC call (prost messages generated from `proto/`, over HTTP/1.1 on the socket, extending the S1.4 helper); (b) the Bun binary gains an `--mcp` stdio mode that calls the daemon socket with the generated TypeScript client, and the Rust crate keeps only what S5.2 decides. Record the answer in 4.1.
- Put O18 to the user. Today four tools reach the daemon (AGENT), and the other 21 work on files directly as the user. Once they go through the daemon they need a capability, and S4.9 made storage scan and purge ADMIN, which `alinery_storage_info` and `alinery_delete_archived_storage` call today.
- Map each of the 25 tools to the daemon RPC that replaced its code in P3 and P4. Write the table into this session before coding. `alinery_list_repos` keeps reading `app.toml`, which is app config, not repo state.
- `alinery_save_playbook` behaviour change, tell the user: today a repo save fails `repo_busy` while a desktop window owns the repo. Through the daemon it goes through `PlaybookService.Save` with `expected_revision` and succeeds.
- MCP starts a daemon only where it does today (`task_client` with `start_daemon`), and never calls `Shutdown`; `check-no-auto-session-kill.sh` scans the MCP code (Rust, or the `--mcp` module).
- Delete `write_toml_file`, `create_pre_archive_backup`, the MCP halves of `create_task` and `call_playbook_library`, and the core functions P4 kept alive for them (the settings TOML writer, `task_creation.rs`, `playbook_library.rs`, the core backup create).
- Update the P4 exception paragraph and 1.8 rule 2: the exception is closed.

**Tests.** Before the change, record each tool's reply on a temp repo as a fixture; after it, the same calls against a real daemon give the same replies, except where this session names a change (the playbook save above). A tool call with a daemon of another protocol fails with the same message as today and starts no teardown.

**Exit.** MCP writes nothing under `.alinery/`; O10 and O18 are in 4.1; the core functions kept for MCP are gone.

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
- With the domain commands gone, `check-remote-routing.sh` and `check-remote-offload.sh` only see PROVISION commands. Keep them on those, or delete them with their two `.txt` lists if nothing is listed. Decide from the count.

**Tests.** The live remote test (`cargo test -p alinery-app --lib -- tests::remote::live` with `remote-sshd/run.sh`): connect, ListDir, Classify, Init, ClaimRepo, SpawnDaemon, WaitDaemonGone, and a second claimant gets `repo_busy`. A remote restore while the daemon is down.

**Exit.** `RepoOp` is gone or holds only host variants; O15 is in 4.1; under (b), `build-remote-runtimes.sh` no longer needs zig.

### S5.3 Retire the JSON-lines wire

Status: not started. Needs: S5.1, S5.2, S1.4, and S4.1 to S4.12.

**Goal.** Each daemon has one listener, speaking `alinery.v1`. The shell reaches it only through the bridge and the `Shutdown` helper.

**Read first.** `main.ts:738-1050` (the op dispatch) and `:1075` (`createServer`); `alinery-core/src/daemon_client.rs` (2,182; `daemon_command` :1470 stays); `alinery-core/src/rpc_chunk.rs` (290; its base64 helpers are used by `task_creation.rs:47`, app `imports.rs:36` and `telemetry.rs:558`); app `daemon.rs` (`ensure_daemon`, the poller :1432); `pi_durable.rs` (99; the supervisor :77); `main.ts:80-97` and `ui_control` (the ui secret); gates `check-wire-parsing-boundary.sh`, `protocol_gate_test.sh`, `check-protocol-version-bump.sh`, `check-no-auto-session-kill.sh`.

**Build.**
1. **Inventory.** Every op in `main.ts:738-1050` with its last caller. An op with a caller left goes back to the session that owns its domain; this session ports nothing.
2. **Lifecycle on `Hello`.** `ensure_daemon`, the poller and the remote supervisor read protocol, build id and app-config identity from `Hello`. The reuse rule is unchanged: both must match. `spawn_pi_supervisor` folds into the poller (it duplicates the spawn path, 1.4).
3. **Delete.** The dispatch and `createServer`; `daemon_client.rs` except `daemon_command`, which moves next to its remaining callers; `RpcChunkAssembler` (the base64 helpers stay); the old `shutdown` op; `--ui-secret-file`, `ui_control` and `ui-secrets.json` (the RPC token replaced them, 2.1.10).
4. **Gates.** `check-no-auto-session-kill.sh` keeps only the `ShutdownOrigin` check from S1.4. `check-wire-parsing-boundary.sh` checks that the shell decodes daemon replies only through generated types, or goes if the shell decodes none. `protocol_gate_test.sh` reads the protocol from `Hello`.
5. **Measure** the shell (commands left per class) and update 1.4 and 2.4.

**Tests.** `cargo test --workspace`, `bun test`, the protocol gates, the live remote test end to end. A relaunched app reattaches to a daemon that outlived it, using the stored token.

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

**Exit.** AGENTS.md matches the code; 4.4 has the README suggestions.

## P6: Remote, web, iOS

P6 has the least evidence behind it. Each session starts with a spike, and the user decides before product code changes.

### S6.1 The door: TLS, pairing, capabilities (O13)

Status: not started. Needs: S5.3.

**Goal.** A client that is not this Mac's webview reaches a daemon over TLS, with a credential that carries capabilities.

**Read first.** 2.1.8 (T4, T5, T6), 2.1.10; app `account.rs` (account pairing, 9 SHELL commands); `remote.rs` (how a host is reached today).

**Research (UNCONFIRMED).** connect-node over `node:https` under Bun. Whether Citadel supports ssh `direct-tcpip` channels (it has no streamlocal, O13). Whether common hosts can accept an inbound TLS port at all, or need a relay.

**Build.**
- Put O13 to the user, with two parts. Who issues the credential: (a) the desktop shell asks the daemon to mint a pairing token (ADMIN) and shows a QR with host, port, certificate fingerprint and token; (b) the account pairing (`account.rs`), so a device signed in to the same account finds hosts through the accounts service. How bytes get there: (i) the daemon listens on TLS with a self-signed certificate pinned by fingerprint; (ii) the client opens an ssh `direct-tcpip` channel to a loopback listener (T5); (iii) a relay.
- Whatever is picked: the host stores pairing tokens hashed, never in plain text, so host agents can't read one (2.1.10). Each pairing is a `pairing/*` entity with its capabilities, listed and revocable in Settings. APPROVE is granted only when chosen explicitly at pairing time.
- The TLS listener is off until a pairing exists.

**Tests.** `bun test`: a paired token gets exactly its capabilities; revoking it ends its open streams; the test client refuses a wrong certificate fingerprint.

**Exit.** O13 is in 4.1; `Hello` answers over the door with a paired token.

### S6.2 Web build of the UI

Status: not started. Needs: S6.1.

**Goal.** The same React app, built for a browser, works against a daemon through the door.

**Read first.** `alinery-app/vite.config.ts`; `ipc.ts` (the shell wrappers left after P5); `src/daemon/transport.ts` (S1.2); 2.5.

**Build.**
- A web build where `daemonTransport` uses the browser's `fetch` against the door. The bridge is a `fetch` (2.1.9), so nothing else in the client changes.
- `ipc.ts` gets a web twin, `ipc.web.ts`, swapped in by a Vite alias. Each shell wrapper either has a browser form (`<input type=file>` for a picker, the Notification API, `window.open`) or its view is hidden. `check-ipc-boundary.sh` covers both files.
- The repo list on the web comes from the pairings, not from `app.toml`. Shell-only views (updates, account, remote host setup, browser sign-in) are hidden.
- Put the hosting to the user: (a) the daemon serves the built UI on the door (same origin, no CORS); (b) a hosted site calls daemons cross-origin (CORS on the daemon, and the browser's mixed-content and private-network rules apply).

**Tests.** vitest for `ipc.web.ts`; `tsc` on the web build. By hand: from a second machine, the board loads, a terminal echoes, and a comment made there appears on the desktop.

**Exit.** The P6 exit check passes.

### S6.3 iOS spike

Status: not started. Needs: S6.1; S6.2 for variant (b).

**Goal.** Decide between a native client and the web build in a shell, with a read-only board working in the iOS Simulator.

**Research (UNCONFIRMED).** connect-swift server streaming (for `Subscribe`) over URLSession; protoc-gen-swift output from the same `proto/`; whether a WKWebView can reach a self-signed door with fingerprint pinning (a trust-challenge delegate).

**Build.** A throwaway project under `spike/ios/`, deleted at the end: (a) SwiftUI with generated Swift types, `Subscribe` on the repo scope, a task list; (b) a WKWebView around the S6.2 build. Measure time to first board and reconnect after the app returns from the background. Put the choice to the user.

**Exit.** The choice and numbers are in 4.1; nothing merges into the product.

### S6.4 Daemon per repo or per host (O4, todo B2)

Status: not started. Needs: S5.3.

**Goal.** Decide O4 with numbers, and give provider sign-in a place on a host before any repo exists (`docs/remote-repos-todo.md` B2).

**Read first.** Todo B2; invariant 2; 2.1.8 (lane naming); `credentials.ts` (credentials already live per host, in the host config dir).

**Build.**
- Measure an idle daemon's RSS and start time with no sessions and with five.
- Put O4 to the user: (a) per repo as today, plus a small per-host daemon that only holds sign-in and provider state (B2); (b) one daemon per host serving many repos: one door and one pairing per host, but it holds `.alinery/.repo-owner.lock` for every repo it serves, and one crash ends the sessions of every repo on the host (O5 matters more).
- If (b), write the migration as new sessions in this doc before any code.

**Exit.** O4 is in 4.1.

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

**Exit.** O5 is in 4.1; under (b) the split ships, and clients see only a new epoch.

### S7.2 Memory

Status: not started. Needs: S5.3.

**Goal.** The daemon's memory stays flat over days.

**Read first.** 2.2.3 (the ring), 2.2.5 (subscriber queues), 2.2.7 (the dedupe map), `terminal.ts` (replay buffers), the transcript watchers (S3.3).

**Build.**
- A soak script in `vinculum-daemon/soak/`, not in `check.sh`: 24 hours of synthetic commits, subscribe and unsubscribe churn, and a chatty terminal. It samples `process.memoryUsage()` and the JSC heap stats (`bun:jsc`, UNCONFIRMED) every minute.
- Every in-memory map keyed by client or session gets a bound. WA: the dedupe entries of a client idle for an hour are dropped.
- Fix what grows.

**Exit.** WA threshold: RSS after 24 hours is within 20% of RSS after one hour. The numbers are in 4.1.

### S7.3 Stats

Status: not started. Needs: S7.2.

**Goal.** `AdminService.Stats` (2.1.3) reports the daemon's health, and Settings shows it per repo.

**Build.** Counters: uptime, epoch, seq, ring size, subscribers per scope, queue drops (`MustRefetch` sent), watcher events, reconcile duration, jobs by state, RSS and heap, live sessions. `Stats` needs VIEW. It is shown, never sent anywhere: telemetry stays opt-in (invariant 6).

**Tests.** `bun test`: a forced queue overflow increments the drop counter.

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

Slots the sessions fill (empty until then):

| Session | Records |
|---|---|
| S0.1 | buf and protoc-gen-es results (`import_extension`, offline buf) |
| S0.2 | O1, with the RPC spike numbers |
| S0.3 | O2 |
| S0.4 | The watcher choice |
| S0.5 | O6, the durability results |
| S0.6 | The O14 trace (a note, not a decision) |
| S0.7 | O3, O7; O1, O2 confirmed or left WA |
| S2.1 | The Subscribe measurements |
| S3.4 | The O8 measurement |
| S3.5 | O19 |
| S4.1 | O17; the TOML writer |
| S4.2 | O14; the multi-writer exception and which session removes each Rust writer |
| S4.9 | O11 |
| S4.10 | O12 |
| S4.11 | O9 |
| S5.1 | O10, O18 |
| S5.2 | O15 |
| S6.1 | O13 |
| S6.2 | Web hosting |
| S6.3 | Native or web shell on iOS |
| S6.4 | O4 |
| S7.1 | What a restart loses; O5 |
| S7.2 | Soak numbers |
| S7.4 | The upgrade trigger |

## 4.2 UNCONFIRMED

| Claim | Resolved in |
|---|---|
| protoc-gen-es 2.16.0's default `import_extension` suits both Bun and Vite | S0.1 |
| `npx @bufbuild/buf` works offline after the first fetch | S0.1 |
| Connect-ES `connectNodeAdapter` serves on `node:http` over a unix socket, under `bun run` and in the compiled binary | S0.2 |
| `node:http2` works under Bun (needed only for gRPC proper) | S0.2 |
| A server interceptor rejects with UNAUTHENTICATED before the handler runs, and can reach the socket (or a wrapper must) | S0.2 |
| connect-node's `createConnectTransport` accepts `nodeOptions.socketPath` | S0.2 |
| One Tauri invoke can carry a raw `ipc::Request` body and a `Channel` | S0.3 |
| `createConnectTransport` works with a custom `fetch` returning a `ReadableStream` body | S0.3 |
| `@parcel/watcher`'s `.node` addon loads inside `bun build --compile` | S0.4 |
| Bun issues #44780 and #34160 affect our watch paths | S0.4 |
| `flock(2)` through `bun:ffi` interoperates with Rust's flock on the same file | S0.5 |
| The errno read after a failed FFI call | S0.5 |
| `F_FULLFSYNC` from Bun matches Rust's durability on macOS | S0.5 |
| `bun:ffi` dlopen works under the hardened runtime | S0.5 (may stay with the user) |
| Bun `Worker` is still experimental (O7) | S0.7 |
| pi-durable notifies on a conversation change | S3.3 |
| The pinned Bun's `Bun.TOML` only parses | S4.1 |
| Which git the daemon finds on a remote host and on a Mac without Command Line Tools | S4.7 |
| connect-node over `node:https` under Bun | S6.1 |
| swift-nio-ssh and Citadel have no streamlocal; Citadel supports `direct-tcpip` | S6.1 |
| connect-swift server streaming over URLSession | S6.3 |
| A WKWebView can pin a self-signed certificate by fingerprint | S6.3 |
| What a pi-durable session loses on restart; Bun can pass an fd (SCM_RIGHTS) | S7.1 |
| `bun:jsc` exposes heap stats | S7.2 |

## 4.3 References

In this repo:
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
- connect-swift: https://github.com/connectrpc/connect-swift
- swift-nio-ssh: https://github.com/apple/swift-nio-ssh; Citadel: https://github.com/orlandos-nl/Citadel
- fflate: https://github.com/101arrowz/fflate; smol-toml: https://github.com/squirrelchat/smol-toml

## 4.4 Handoff

For the user:
- **O16**: merge PR #154 as is, or land this plan on top of it.
- **O17, O18, O19**: user decisions, in S4.1, S5.1 and S3.5.
- **R5**: telemetry ingest credentials are hardcoded at `telemetry.rs:21-22`. Out of this plan's scope.
- **`check.sh` runs no daemon `bun test`.** S0.1 adds the step.

AGENTS.md lines that are stale today (S5.4 rewrites them):
- Engineering rules: "the three origins above"; the Daemon section lists five.
- Gates list: "`shutdown` senders stay on the four-name allowlist"; the gate allows five.
- "The daemon's in-memory `vt100` emulator is reattach truth": `terminal.ts:2` says reattach sends the scrollback tail and there is no vt100 frame.

S5.4 also rewrites lines that become stale during the plan, such as the `libalinery_core` ownership library (gone in S4.11) and the module table (`daemon_rpc.rs`, from S0.3 and S1.2).

README suggestions (README is human-edited; nothing here edits it):
- `README.md:77` names the daemon `alineryd`; it is Vinculum (`alinery-vinculum-daemon`) on this branch.
- `README.md:87` says the board, task and session browsing work while the daemon is offline, incompatible, or owned by another app instance, without starting one. O19 decides whether that stays true; update the paragraph to match.
- After P5, the architecture description could say that the per-repo daemon is the application and the desktop app is one of its clients.
- After S6.2, a section on the web client and pairing.

## 4.5 Changelog

- v0.1, 2026-10-26: first draft (Parts 1 to 4).
