# Remote daemon: two architectures for a thick daemon and a thin client

Status: brainstorm. Nothing here is decided and no code follows from it yet. Line counts and command counts were measured on the `remote-daemon` branch while writing.

Both designs share one client contract, so I'll describe that first. Everything after it is where they differ.

## The shared spine (identical in A and B)

- **One protocol, many transports.** Framed messages (JSON plus binary frames) travel over a unix socket (local), the ssh-forwarded socket (desktop to remote host), or WebSocket over TLS (web and iOS). iOS can't hold an OpenSSH ControlMaster, so a TLS door, direct or relayed, is part of the design. Each client pairs once, with a token or QR code issued by the desktop shell, and gets a capability level (view, act, approve, admin). Agents on the host run as the same user and can reach local sockets, so every transport authenticates.
- **Entities with revisions.** Repo, task, session, artifact, comment, execution, chat thread, job, setting, attention item. Each has an id and a revision, and the daemon stamps every change with a per-repo sequence number.
- **Subscribe, don't poll.** A client sends a scope (repo, task or session) and a cursor. It gets a snapshot, then changes, and a stale cursor gets a fresh snapshot. This replaces every poller in the perf plan.
- **Commands carry intent.** "Archive task X" arrives with an idempotency key and is answered with the resulting revision. That is enough for optimistic UI.
- **Slow work is a job entity.** Backup, storage scan, purge and import report progress and a result into the feed. A client that was closed sees the outcome later, which closes the disconnected-backup gap.
- **Blobs and terminals use separate channels.** Attachments, images and exports move in ranges, and terminal output is a binary stream with offset replay.
- **Clients keep a replica.** A dropped link shows the last synced state with a banner, not an empty board.
- **The desktop shell keeps only setup and OS jobs.** It installs the runtime over ssh, starts the daemon, issues pairing tokens, and handles notifications, pickers, updates, browser sign-ins and telemetry consent.

Both designs must also settle two things:
1. **Source of truth.** Either files stay the truth, as today. That keeps them git-friendly and lets agents write artifacts directly, but needs a watcher or reindex step feeding the sync index. Or a database becomes the truth and files are an export.
2. **Daemon process model.** One process, or a tiny keeper that holds the PTYs plus a restartable brain. The keeper settles the upgrade-while-running problem in either design.

## Architecture A: Rust core behind an async door

```
+------------------+  +------------------+  +------------------+
| Desktop (Tauri)  |  | iOS app          |  | Web app          |
| replica + sync   |  | replica + sync   |  | replica + sync   |
+---------+--------+  +---------+--------+  +---------+--------+
          |                     |                     |
          +---------------------+---------------------+
                                | one protocol: socket, ssh forward, WebSocket + TLS
                                v   HOST (local or remote): everything below runs there
+--------------------------------------------------------------+
| DAEMON (Bun)                                                 |
|  +--------------------------------------------------------+  |
|  | Transport adapters: socket, ssh forward, WebSocket+TLS |  |
|  +--------------------------------------------------------+  |
|  +--------------------------+  +--------------------------+  |
|  | Sync engine              |  | Session runner           |  |
|  | log, cursors, fan-out    |  | PTYs, harness            |  |
|  +--------------------------+  +--------------------------+  |
|  +--------------------------------------------------------+  |
|  | Async core client                                      |  |
|  +--------------------------------------------------------+  |
+------------------------------+-------------------------------+
                               | commands, queries, changes
+------------------------------v-------------------------------+
| CORE (Rust): all business logic                              |
| Tasks, playbooks, artifacts, comments, git, backups          |
| Every result also says what changed                          |
+------------------------------+-------------------------------+
                               v
+--------------------------------------------------------------+
| .alinery files + sync index                                  |
+--------------------------------------------------------------+

+--------------------+
| Desktop shell      |
| (Rust)             |
| provisions only    |
+--------------------+   - - > ssh: installs the runtime and starts the daemon (setup only)
```

**How it works.** The daemon stays a session runner plus the sync engine. Every business operation is a call into the core:
- `apply(command)` returns a result plus the changes it made.
- `query(scope)` returns a snapshot.
- `reindex(paths)` returns changes for files that agents wrote directly.

The daemon assigns sequence numbers and fans the changes out.

**How the core is hosted without blocking** is the hard sub-decision, and it has three options:
1. **A child process the daemon spawns**, over a socket or stdio. A core crash doesn't end sessions. This is the repo service moved under the daemon. It costs a serialization hop.
2. **A native addon with async functions** on a thread pool. There's no hop, but a core panic or segfault takes the daemon and its PTYs down.
3. **Bun worker threads that load the core over FFI.** It's in-process again, and the blocking stays inside the worker.

**What it replaces.**
- The repo-service process.
- The app's direct core calls for local repos.
- `daemon_client.rs` (2.2k lines) as the client's wire.
- Every poller.

The Tauri command count would fall from 241 toward the roughly 90 client-only ones. The 100-op `RepoOp` list becomes the command and query API almost unchanged.

**Strengths.**
- The business rules stay in tested Rust (34k lines with golden tests), with no rewrite.
- Blocking never touches the event loop.
- Other binaries, such as the MCP server and a CLI, can still use the core.

**Costs and risks.**
- Two languages stay on every host forever, so each feature crosses a process or FFI boundary plus a schema.
- The Linux cross-builds for host runtimes stay (zig, one per architecture).
- Every Rust mutation must report what it changed. If one doesn't, the sync engine shows stale state.
- A TypeScript playbook engine already runs executions in the daemon, and the Rust playbook code is a second one. A winner has to be picked. I haven't traced which one is authoritative for which behavior.

## Architecture B: the TypeScript daemon is the application

```
+------------------+  +------------------+  +------------------+
| Desktop (Tauri)  |  | iOS app          |  | Web app          |
| replica + sync   |  | replica + sync   |  | replica + sync   |
+---------+--------+  +---------+--------+  +---------+--------+
          |                     |                     |
          +---------------------+---------------------+
                                | one protocol: socket, ssh forward, WebSocket + TLS
                                v   HOST (local or remote): everything below runs there
+--------------------------------------------------------------+
| DAEMON (Bun): the application                                |
|  +--------------------------------------------------------+  |
|  | Transport adapters: socket, ssh forward, WebSocket+TLS |  |
|  +--------------------------------------------------------+  |
|  +--------------------------+  +--------------------------+  |
|  | Sync engine              |  | Session runner           |  |
|  | log, cursors, fan-out    |  | PTYs, harness            |  |
|  +--------------------------+  +--------------------------+  |
|  +--------------------------------------------------------+  |
|  | Domain logic (TypeScript)                              |  |
|  | Tasks, playbooks, artifacts, comments                  |  |
|  | git, backups, storage, settings                        |  |
|  +--------------------------------------------------------+  |
|  +--------------------------------------------------------+  |
|  | Workers                                                |  |
|  | Bun workers or children: zip, scans, git               |  |
|  +--------------------------------------------------------+  |
+------------------------------+-------------------------------+
                               v
+--------------------------------------------------------------+
| .alinery files + sync index                                  |
+--------------------------------------------------------------+

+--------------------+
| Desktop shell      |
| (Rust)             |
| provisions only    |
+--------------------+   - - > ssh: installs the runtime and starts the daemon (setup only)
```

**How it works.** One daemon holds the domain modules, storage layer, sync engine and session runner. CPU-heavy and IO-heavy work runs in Bun workers or child processes. The Tauri app's Rust is only the shell. The Tauri UI and the web app share the same TypeScript schemas and one sync-client library, and iOS gets a port of that client.

**What already exists.** A TypeScript playbook engine (about 1.4k lines) drives executions in the daemon today. The Rust side has roughly 6k lines of playbook code beside it.

**Rewrite scope.** By file name, about 20 to 25k of the core's 34k lines are business logic. That covers playbooks, task creation, subtasks, artifacts, comments, backup, git actions, storage, settings and chat. The wire code disappears (`daemon_client` and `repo_service`, about 4k lines). The OS and client-side pieces, such as telemetry and idle inhibit, stay in the shell. This is an estimate from file names, not a traced count.

**Packaging.** The host runtime shrinks to one compiled Bun binary plus git and the harness bundle. There's no zig, no per-architecture Rust build and no FFI library on the host.

**Strengths.**
- One language and shared types run from daemon to UI to web.
- The code that makes a change also reports it, so a missed change event is hard to write.
- Agents' MCP tools become another client of the daemon.
- The host dev loop gets much faster.

**Costs and risks.**
- The rewrite itself, and the drift risk with it. TOML frontmatter parsing, ownership locking, backup archive contents and playbook scheduling edge cases all have to match. The Rust golden tests would need porting as conformance fixtures, with both implementations running side by side for a while.
- Things Rust gave for free need replacing. Bun has no native `flock`, so single-owner locking needs libc FFI or a new mechanism.
- Bun is single-threaded, so every heavy operation has to be moved off the loop deliberately.
- A hard crash (out of memory, a native bug) still ends sessions. So the keeper-and-brain split matters just as much here.
- Memory growth in a long-lived server matters more when the daemon is the whole app.

## Side by side

| | A: Rust core behind async | B: TypeScript daemon is the app |
|---|---|---|
| Business logic lives in | Rust core | TypeScript daemon |
| Daemon reaches it via | Child process, native addon or worker + FFI | Direct function calls |
| Two languages on the host | Yes, permanently | No |
| Who reports a change | Every Rust mutation returns it | The same module that makes the change |
| Crash that ends sessions | Only if the core is in-process | Any hard crash of the daemon (keeper helps) |
| Host runtime | Bun binary + Rust build per architecture | One Bun binary |
| Client code sharing | Types generated from a schema | TypeScript shared with UI and web |
| Rewrite | Small: wrap and add change events | Large: about 20 to 25k lines, with drift risk |
| Main risk | Missed change events, FFI or IPC boundary | Behavior drift, replacing Rust's guarantees |

The sync engine, the subscribe-not-poll client, the replica and the job entities are identical in both. That work doesn't depend on which design you pick, and it covers most of what the perf plan's P2 through P6 were for.

## What would tilt it

These are questions for you, not a recommendation:
- Do you want one language from daemon to web and iOS clients, or do you want Rust to stay the trusted layer for business rules?
- How much does the rewrite's drift risk worry you, compared with living with a language boundary on every host?
- Will other Rust binaries (a CLI, the MCP server) keep using the core? If so, A keeps that for free and B has to replace it.
- Is a bigger single daemon process acceptable if a keeper holds the PTYs?
