# Machine MCP and the runtime status panel

Status: draft v0.2, 2026-11-10. Nothing here is built. Decisions M1 to M8 are open and go to the user before code (phase P0). P1 depends on none of them and can start now.

v0.2 changes after a review against the code: M2 no longer claims the harness scope is a security boundary; M3 recommends surfacing only; the ingress key is HTTP-only (M5 moves to P5); new M7 (version skew) and M8 (how daemons register); the stdio bridge may start the MCP; P2 drops the MCP actions that P6 would delete; the socket path length item is resolved.

This plan is grounded in the code on `experimental-pi-durable-as-a-harness` at `195f6fb9`. Where a claim rests on something I did not read, it is listed under "Unverified" at the end instead of being stated as fact.

## 1. Goal and non-goals

Goal: one long-lived MCP process per OS user and lane that any MCP client can use to reach every Alinery daemon on that machine, with the Alinery app as the place the user sees versions and decides when to update or restart.

Two deliverables, in this order:

1. A **Runtime panel** in Settings under the update section: every host, every repo's daemon, every MCP instance, their versions, drift, and the actions to start, stop, restart or update them. It is useful before any new daemon exists.
2. A **machine MCP** (`--mcp --machine`) that replaces the three current launch modes, reached over a unix socket by default with an opt-in HTTP listener.

Non-goals:

- TLS in the daemon. TLS is the job of a tunnel or Tailscale in front of the optional HTTP mode.
- Any automatic kill. No code path here ends a session or force-kills a process on its own.
- Cross-host aggregation on the Mac in v1. Each host runs its own machine MCP.
- Changing the harness's MCP path before the machine MCP has soaked (phase P6, optional).

## 2. What exists today

The same binary, `alinery-vinculum-daemon`, runs MCP in three ways. All three call a daemon over its `rpc.sock` with a minted AGENT token, and none of them is a daemon (`main.ts` dispatches `--mcp` to `runMcp` before any daemon code runs).

| Mode | Started by | Scope | Credential | Dies with |
|---|---|---|---|---|
| Harness MCP | the daemon's `McpHub` (`mcp.ts`, `main.ts` `new McpHub`), stdio child via `selfMcpCommand()` | its own daemon only | `ALINERY_RPC_SOCKET` and `ALINERY_RPC_TOKEN` in the child's env; the token is `agentTokens.mint("harness-mcp")` | the hub (`mcpHub.close()` on shutdown) or `signalChild(..., "mcp-restart")` |
| Managed MCP | the app, `ensure_mcp_server` in `src/mcp.rs`, `--mcp --serve --managed`, JSON lines over `.alinery/mcp[-ns].sock` | the active repo as `--repo`, but every repo in `mcp-endpoints.json` | AGENT tokens the app mints for each local daemon (`refresh_mcp_endpoints`, re-minted at most every 30 s) | stdin closing (the app holds the pipe) |
| Host stdio MCP | Claude Desktop and similar, from the "Copy config" button (`stdioHostConfigJson`) | every repo in `mcp-endpoints.json` | the same endpoints file | the host |

Facts the plan depends on:

- **Remote repos are left out** of the endpoints file on purpose: `refresh_mcp_endpoints` skips anything that is not `RepoRef::Local` ("MCP is on the daemon's host only (O20 c)").
- **AGENT is exactly the RPCs behind the tools** (`AGENT_RPCS` in `rpc/auth.ts`, held equal to `mcpServer/tools.ts` by `auth.test.ts`). A minted token holds AGENT plus the one capability the called method checks. `AllowCompletion`, `SetAutoApproveAll` and every other APPROVE or ADMIN RPC are not on the list, except `StartPurge`, which is ADMIN and is listed (accepted in O18 b).
- **The control wire is JSON lines.** The app's `reap_mcp_listener` writes the raw bytes `{"op":"exit"}\n` to the MCP socket and waits for the socket to go quiet. `serveSocket` and the stdio path share `serveLines`, so the socket wire and the stdio wire are the same.
- **`serveSocket` unlinks the socket path unconditionally at start.** That is safe only because the app reaps the old listener first.
- **Decisions already recorded** in `docs/thick-daemon-plan.md`: O10 (b) the Bun binary owns MCP, O18 (b) AGENT is exactly MCP's tools, O20 (c) MCP runs only on the daemon's host with minted tokens and "from any machine" is dropped, O22 (a) only the shell's managed MCP offers `alinery_send_review_handoff`. This plan changes O20 (c) and O22 (a) for external callers and says so in M2.
- **The harness token already lives in the harness's reach.** O20's rationale says an agent that can run MCP can read its token and call those RPCs directly, and the user accepted that per repo.
- **A harness agent already has cross-repo reach today.** The harness has the `bash` builtin (`mcp.ts` `BUILTIN_TOOLS`) and runs as the user, so it can read the owner-only `mcp-endpoints.json`, which holds an AGENT token for every local daemon the app has open. Any file this plan adds under the app-config directory is equally readable. The OS account is the boundary; nothing in this plan narrows or widens that.
- **`Hello` is authenticated.** A missing or wrong bearer token on `AdminService/Hello` is `Unauthenticated` (`auth.test.ts`), so a daemon answering `Hello` with a given token proves the token is live on that daemon.
- **Socket path length is not a risk.** `app_config_identity` is 16 hex characters (`paths.rs`), so a host's `~/.local/share/alinery-remote/config/<identity>/machine-mcp-<ns>.sock` stays near 75 bytes, well under 104 (macOS) and 108 (Linux).

## 3. Decisions for the user

**M1. What "machine" means.** Options: (a) one per OS user and per lane (the app-config identity and socket namespace that daemons already use); (b) one per physical machine across users. Recommend (a). Sockets are 0600 and owned by a user, `.repo-owner.lock` is already per repo and lane, and a second OS user cannot be served safely by a first user's process.

**M2. Cross-repo reach (changes O20 c and O22 a).** The machine MCP can reach every daemon, so any process of this OS user that can open its socket can act on every repo. Options: (a) accept that for external callers, and give the harness a connection scoped to its own daemon; (b) no cross-repo reach, one MCP per daemon. Recommend (a), stated honestly: the harness scope keeps an agent's tools on its own repo by default, so a confused agent does not archive repo B's tasks. It does not stop a prompt-injected agent, which can use `bash` to read any owner-only file or connect to the socket, exactly as it can read `mcp-endpoints.json` today. Stopping that needs an OS sandbox around the harness, which is out of scope. `alinery_send_review_handoff` moves from "only the app's managed MCP" to "external callers of the machine MCP", and is not offered on a harness-scoped connection.

**M3. A stuck MCP.** The project has already decided against forced kills: issue #74 deleted pid-file identity and `kill -0` shortcuts, `reap_mcp_listener` documents "never kill by the pid in the status file", confirmed takeover says "No forced kill or lock deletion", and `check-no-auto-session-kill.sh` scans `src/mcpServer` for `.kill(` and `signalChild`. Options for a wedged process: (a) surface "stuck" in the panel and do nothing else; (b) an in-process watchdog (a worker that exits the process if the main loop's heartbeat stops), which needs one new allowlist line in the gate; (c) an identity-bound signal from the app. Recommend (a). "Stuck" is a `status` op that does not answer within a timeout; the panel shows it and the user decides. (b) waits until a wedged MCP is actually seen: in Node, `process.exit` in a worker ends only the worker, Bun likely matches, so the watchdog would need a self-signal that the gate scans for. (c) contradicts the stance above. This corrects an earlier suggestion in this conversation to bind a signal to a pid and start time in the lock file.

**M4. HTTP listener.** Options: (a) not at all; (b) opt-in, off by default, loopback bind, ingress key always required, Origin and Host validated, no TLS; (c) on by default. Recommend (b), as its own phase (P5). iOS and claude.ai connectors still need a public HTTPS endpoint, so a tunnel is the user's job, and I have not verified those connectors' auth requirements.

**M5. The ingress key (P5 only).** The unix socket takes no key: it is 0600, and any process that can connect to it can also read a key file beside it, so a key there adds nothing. The key exists only for the HTTP listener. Options: (a) one key in an owner-only file, rotatable with the old key still valid for one overlap window, never in argv or env; (b) per-client keys with a management UI. Recommend (a). The overlap is the lesson of R-S5.1-4 (a tool call that read the token just before a re-mint was still mid-call).

**M6. Ownership and exit.** The daemon that needs an MCP does connect-or-spawn, and so does the stdio bridge (section 4.5), so a crashed MCP comes back on the next client. The machine MCP exits itself after 10 minutes with no daemon present (per M8). The app never owns it. Recommend as stated; the app can ask it to exit and can start one, like any other client.

**M7. Version skew.** The lane identity is a hash of the app-config path, not of the build, so after an app update one machine MCP serves daemons of several builds (old daemons keep running on purpose), and Claude Desktop runs the bridge from the updated binary. Options: (a) the MCP serves only daemons whose `Hello` protocol equals its own and lists the rest as `incompatible` (visible in its tool output and the panel); the bridge reads the MCP's protocol from `status` and refuses a mismatch with a message naming the fix (Retire from the panel); `behind` stays a state, never an automatic stop; (b) a newer daemon's Ensure retires an older MCP that has no clients; (c) one machine MCP per build. Recommend (a): it keeps "no automatic stop", and an MCP restart costs a moment of tool calls, so the user clicking Retire after an update is cheap. (b) is the smallest step to automatic if (a) proves annoying.

**M8. How daemons register.** Options: (a) files: each daemon writes `daemons[-ns]/<repo-hash>.json` with its socket and a minted token, and the MCP polls `Hello` on each record to know who is present; crashed daemons leave records that need pruning. (b) in-band: each daemon connects to the MCP socket, sends `{"op":"register", ...}` with its socket path and a freshly minted token, and keeps the connection open; a closed connection means the daemon is gone; on a drop the daemon does connect-or-spawn again (single-flight, the flock decides the winner, backoff 1, 5, 30 s). Recommend (b): no token files on disk, no pruning, no `Hello` polling loop, and the idle timer is simply "no registered connection for 10 minutes". Its cost is the daemon-side reconnect, and Retire becomes a restart while any daemon is up, which is what Retire is for.

## 4. Design

### 4.1 Files

All under the app-config directory (`alinery_core::app_config_dir_of`), one set per lane, like `mcp-endpoints[-ns].json` today. On a remote host the same set lives in `~/.local/share/alinery-remote/config/<app-config identity>/`.

| File | Purpose | Written by |
|---|---|---|
| `machine-mcp[-ns].sock` | the unix socket, mode 0600 | the machine MCP, only while it holds the lock |
| `machine-mcp[-ns].lock` | flock singleton, a 0-byte marker never unlinked | `platform/lock.ts` `tryLockExclusive` |
| `machine-mcp[-ns].key` | the HTTP ingress key, 0600 (P5 only, M5) | the machine MCP when HTTP is first enabled |
| `daemons[-ns]/<repo-hash>.json` | only if M8 (a): one record per daemon with repo root, socket path, protocol, build id, AGENT token | each daemon, atomically, through `platform/fs.ts` (`writeAtomic`) |

Under M8 (b) there is no registry directory: presence is an open registration connection. Under M8 (a) the directory is 0700, and a record is a hint, never an identity: the MCP treats a daemon as present only while a `Hello` over the recorded socket answers with the recorded token, which is the rule #74 set for MCP status.

### 4.2 Credentials

Two layers, so the daemon never learns the ingress key:

- **Egress (MCP to daemon).** Each daemon mints an AGENT token labelled `machine-mcp` (`TokenRegistry.mint` replaces a label and keeps the previous token valid until the next mint) and hands it over: in its registration message under M8 (b), in its record under M8 (a). Each re-registration mints afresh. The daemon stays the enforcer through `AGENT_RPCS`. This removes the app from the token path: the app no longer has to be running, and the 30-second re-mint and the endpoints file go away at P6.
- **Ingress (client to MCP).** None on the socket (0600, M5). The HTTP listener requires the ingress key.

A harness-scoped connection (P6) presents the harness's own daemon-minted AGENT token. The MCP accepts it only after that daemon answers `Hello` with it (verified to reject a wrong token), and scopes the connection to that one daemon. No new secret is needed. This scope is a default, not a boundary (M2).

### 4.3 Process and lifecycle

- **Singleton.** Take the exclusive flock first. The holder alone may unlink and bind the socket. This replaces `serveSocket`'s unconditional unlink, which would orphan a live instance. A second starter that cannot take the lock connects to the socket, runs `status`, and exits.
- **Connect-or-spawn is single-flight.** One in-flight promise per process, then the flock across processes. Spawn storms are the pitfall in `ensure_mcp_server` ("spawned managed alinery-mcp" log loop), so connect-or-spawn runs only on daemon start, on a dropped registration (M8 b, with backoff), when a harness needs the endpoint, when the stdio bridge finds no socket, and on an explicit panel action. It never runs from a poller.
- **Launch recipe.** Reuse the daemon's recipe, not a new one: login-shell PATH, null stdio, a new session. On a host with systemd, start it in its own transient unit (`systemd-run --user --collect --unit=alinery-mcp-<lane>`), as `spawnDaemon` does for the daemon. A child left in the daemon's unit would die with it, because the unit's cgroup is killed when the unit stops, which defeats "outlives any daemon".
- **Exit.** A monotonic idle timer, 10 minutes from the moment no daemon is present (M8). Exit unlinks the socket while still holding the lock, then releases it.
- **Control ops stay additive and frozen.** `{"op":"exit"}` keeps its exact bytes and its ack, because shipped shells send it raw. Add `{"op":"status"}` returning build id, protocol, uptime, client count and the daemons it sees (each `ok` or `incompatible`, M7), and, under M8 (b), `{"op":"register"}`. Never change the existing op.
- **Skew (M7).** A daemon whose `Hello` protocol differs from the MCP's is listed `incompatible` and none of its tools are called.

### 4.4 Daemon-side control (McpService)

The daemon supervises the MCP, so remote hosts need no new host operation. A new `McpService` in `proto/alinery/v1/mcp.proto`, ADMIN only and not in `AGENT_RPCS`:

- `Status`: build id, protocol, uptime, clients, state (`absent`, `ok`, `behind`, `stuck`).
- `Ensure`: connect-or-spawn.
- `Retire`: send `exit` over the socket, wait for it to go quiet, optionally followed by `Ensure`.

`absent` is not a warning: the MCP starts on demand. The host-guard false positive (`5e1a4a03`) came from treating "env var missing" as a fault where it was the design. `behind` means the running build differs from this daemon's build. It is a state, never an automatic stop, mirroring `BuildDrift`.

This is a proto change: regenerate `proto/gen`, rewrite `proto/golden`, bump `PROTOCOL_VERSION`, and do not touch `admin.proto` or `common.proto` (frozen by `check-admin-wire-frozen.sh`).

### 4.5 Clients

- **stdio bridge.** `--mcp` without `--machine` stays the entry for Claude Desktop and similar, but becomes a thin proxy to the machine socket. It holds no tokens and no key. It does connect-or-spawn, so a crashed MCP comes back on the next client, and it checks the MCP's protocol through `status` first and refuses a mismatch with a message that names Retire (M7). The "Copy config" snippet does not change shape.
- **Remote hosts.** The host's daemons start the host's machine MCP. A Mac client reaches it either by forwarding its socket over the existing ControlMaster, as `rpc_forward` does for daemon sockets, or by running the bridge through `ssh host <binary> --mcp`. Choose in P4 by what `check-ssh-spawn.sh` and the remote gates allow; the first needs a second forward per host.
- **Harness.** Unchanged until P6. `McpHub` already supports stdio and `http` endpoints. A socket endpoint reuses the stdio framing over `net.connect`, because `serveLines` is shared.

## 5. The Runtime panel

Placement: Settings, under the existing update controls (`Settings.tsx` already carries `update`, `onCheckNow`, `checkForUpdatesNow`). Name it "Runtime" or "Services", not "telemetry": the product telemetry is opt-in and gated by `check-telemetry-privacy.sh`, and this panel is local only.

Rows and where each field comes from:

| Row | Fields | Source today |
|---|---|---|
| Host (this computer, each ssh host) | connection state, runtime hash, bundled hash, stale | `state.remotes.status`, `RemoteSession.runtime_hash`, the bundled `manifest.json` |
| Repo daemon | protocol, build id, drift, live sessions, conflict | `AppState` daemon map, `classify_hello`, the poll-free `daemon/_/status` entity (`useDaemonStatus`), `LiveSessions` |
| MCP instance | state, build, clients, daemons seen | `mcp_status` today (active repo only), `McpService.Status` from P3 |

Notes:

- **No ssh per render.** `RemoteSession` has the hash but not the selected triple, so deciding "stale" re-runs the probe (`session.conn.probe()`), an ssh round trip. Store the triple chosen at connect time on `RemoteSession` and compare the current manifest in memory. The type is built in a few places including tests; change them together.
- **No new poller for daemon state.** The frontend rule is replicas and entities. The panel reads the status entity and one new shell command, `runtime_status`, for shell-local state (hosts, bundle hashes). A command that reaches a host is async and offloaded (`check-remote-offload.sh`).
- **Actions reuse what exists.** Daemon restart is `stop_daemon`, whose remote form now refreshes a stale runtime (`195f6fb9`). Host update is `connect_and_attach`. MCP start and stop are the existing commands, but they currently act on the active repo, so they get an explicit target. Each destructive action goes through `confirmDanger` or `askConfirm` (`confirm.tsx`), never `window.confirm`, and states what it will interrupt: the live sessions for a daemon (the same `TakeoverImpact` data the banner uses), the connected clients for an MCP.
- **Impact differs by row.** Restarting a daemon ends its sessions, so it is always a deliberate click. Restarting the MCP interrupts tool calls for a moment. An option to apply MCP updates automatically while idle is out of scope here.

## 6. Pitfall register

Each row is something the code or history already shows, and what this plan does about it.

| # | Pitfall | Where it bit | Plan response |
|---|---|---|---|
| 1 | Duplicate MCP spawns from concurrent callers | `ensure_mcp_server` holds the child lock across check, spawn and store, "the spawned managed alinery-mcp log loop" | single-flight in the daemon and a flock across processes; spawn only on daemon start, harness need or panel action |
| 2 | Orphaned MCP listener after a force quit or an update | E4 in `reap_mcp_listener`; `preflight.sh` notes an app swap orphans its managed MCP | ask the listener to exit over its socket; the updater does the same before the swap; never unlink under a live listener; the lock is taken before the socket is touched |
| 3 | Identity from files and kill by pid | #74, #119 RC-MCP-6; `check-no-auto-session-kill.sh` scans `mcpServer` for signals | liveness is a socket connect plus `status`; no pid files; stuck handling per M3, no signals |
| 4 | A stale caller for repo A stopping repo B's MCP after a switch | comment at the top of `ensure_mcp_server` | panel actions carry an explicit instance or repo key; no `active_repo()` in them; `check-remote-routing.sh` covers routing |
| 5 | A token re-minted while a tool call is mid-flight | R-S5.1-4, `5bc6f593` | keep the overlap: a daemon's mint keeps the previous token; the HTTP ingress key rotates with an overlap (P5); read the credential per request |
| 6 | A restart reusing the runtime chosen at connect | this session, `195f6fb9` | the machine MCP is the daemon's own binary, so it matches that daemon's runtime; a mismatch is the `behind` state with an explicit Retire; the panel's host Update is the same reconnect refresh |
| 7 | A child of a systemd unit dying with the unit | `spawnDaemon` uses `systemd-run --user --collect --unit=...` for this reason; the probe records linger and KillUserProcesses | own transient unit for the MCP, same launcher choice (`choose_launcher`) |
| 8 | A bare PATH on non-interactive ssh | this session, `89cb7c93` | reuse the one launch recipe with `loginShellPath`; add no new PATH logic |
| 9 | Stale bundled remote runtimes | empty manifest earlier in this session; `tauri.mjs` now builds them | rebuild runtimes after any `vinculum-daemon/` or `proto/` change; live tests otherwise run old code |
| 10 | A daemon sidecar not rebuilt after an edit | `03a5399c` | new files stay under `vinculum-daemon/src`, which the recursive up-to-date check covers; verify with the check |
| 11 | A "warning" for a state that is by design | the host-guard banner, `5e1a4a03` | `absent` MCP is not a warning; the daemon, not the UI, decides what is a fault |
| 12 | The frozen wire | `Hello` and `Shutdown` are frozen; shipped shells send raw `{"op":"exit"}` | additive ops only; the `exit` bytes and ack never change; new RPCs only in a new `mcp.proto` |
| 13 | The async `window.confirm` trap | `AGENTS.md`, `check-no-window-confirm.sh` | `confirmDanger` and `askConfirm` only |
| 14 | The quiet-machine gate miscounting MCP children | `3f3a0a15`; `preflight.sh` ignores lines containing `--mcp` | the machine MCP keeps `--mcp` in its argv; add a `preflight_test.sh` line for `--mcp --machine`; the updater asks it to exit |
| 15 | Blocking the window on ssh | `check-remote-offload.sh` | every command that reaches a host is async and offloaded |
| 16 | Lock inversion between the repo lifecycle lock and a reconnect | avoided in `stop_remote_daemon` by dropping the guard and the session before `connect_and_attach` | panel actions that reconnect release both first |
| 17 | Unix socket path length | ssh forwards use `/tmp/alinery-<uid>/` for length | resolved: the 16-hex identity keeps the path near 75 bytes; keep one test with a long home directory |
| 18 | An idle exit racing a new daemon | n/a, new | exit unlinks under the lock; a registering daemon that hits a closed socket retries connect-or-spawn; the timer runs only while no daemon is present, so a sleeping laptop with daemons does not read as idle |
| 19 | Auto-killing a live session | the five teardown origins in `AGENTS.md`, `check-no-auto-session-kill.sh` | none added; the panel's daemon restart is `stop_daemon`; any new `signalChild` needs a listed reason |
| 20 | Daemon writes that skip the atomic helper | `check-daemon-fs-writes.sh` | registry, key and status all go through `platform/fs.ts` |
| 21 | Tools that read the local disk | `handlers.ts` answers "remote" or "not a local checkout" when `.git` is missing at the path | audit which tools read files directly before any remote or machine-wide claim; route those through the daemon |
| 22 | One MCP serving daemons of several builds | new: the lane identity hashes the config path, not the build, and old daemons outlive an update | M7: serve matching protocol only, list the rest `incompatible`, bridge refuses a mismatched MCP, Retire is the user's click |
| 23 | Claiming a boundary the OS account does not give | the harness's `bash` builtin can already read `mcp-endpoints.json` | M2 states the scope is a default; no token files on disk under M8 (b); no key on the socket |
| 24 | A crashed MCP nobody restarts | new: daemons ensure only at start | the bridge and a dropped registration both do connect-or-spawn |

## 7. Phases

Each phase ships on its own and leaves the old paths working. While iterating, run targeted tests only (`cargo check -p alinery-app`, `bun test` in the daemon, `vitest` for a file). Run `./scripts/check.sh` once at check-in. Do not launch the app unless asked.

**P0. Decisions.** Settle M1 to M8. P1 does not wait for this. Exit: recorded in the style of `thick-daemon-plan.md`'s decision table.

**P1. Read-only Runtime panel.** No daemon or proto change. Built (uncommitted): `runtime_status` in `remote.rs`, `RemoteSession.triple`, `runtime_is_stale(manifest, triple, hash)` now used by `stop_remote_daemon` too (one fewer ssh probe per restart; a new bundle that raises the glibc or macOS floor now fails the reconnect instead of falling back to the old runtime), `views/RuntimePanel.tsx` under Settings → Updates. Live sessions show only for attached repos. Not yet seen against aagent in the app.
- Rust: `runtime_status` command in `remote.rs` or a new small module, store the selected triple on `RemoteSession`, compute stale without ssh.
- TS: `ipc.ts` wrapper, the panel under the update section of `Settings.tsx`, rows for hosts, daemons and the existing MCP.
- Tests: a Rust unit test in `src/tests/remote.rs` for the staleness decision (extends the one added in `195f6fb9`), a vitest for the panel rows.
- Gates: `check-ipc-commands.sh`, `check-remote-routing.sh`, `check-remote-offload.sh`.
- Exit: the aagent row shows "stale" before a restart and "current" after.

**P2. Panel actions.** Daemon restart and host update with explicit targets and impact text. MCP actions wait for P3 (they become `McpService` calls), because giving the current managed-MCP commands a target is work P6 deletes. Tests: vitest for confirmations and impact lists; Rust for target resolution that never reads `active_repo()`.

**P3. Machine MCP, local.**
- Proto: `mcp.proto` (`McpService`), regenerate, golden, `PROTOCOL_VERSION` bump.
- Daemon: an MCP manager (single-flight ensure, registration per M8, token mint), `--mcp --machine` mode in `mcpServer/` (flock first, discovery, `status`, `exit` and `register`, protocol check per M7, idle exit), the stdio bridge with connect-or-spawn. Panel MCP rows and Retire move here from P2.
- Tests: `bun test` beside the source, including a real-socket test of the singleton race (two starters), the idle exit, a daemon re-registering after the MCP restarts, a mismatched-protocol daemon listed `incompatible`, the bridge refusing a mismatched MCP, and that `McpService` is absent from `AGENT_RPCS` and an AGENT token gets `PermissionDenied` on it.
- Gates: `check-proto-gen.sh`, `check-protocol-version-bump.sh`, `check-no-auto-session-kill.sh`, `check-daemon-fs-writes.sh`.
- Exit: Claude Desktop through the bridge reaches two repos with the app closed.

**P4. Remote hosts.** Spawn through the launcher recipe (transient unit on systemd hosts), per-host panel rows, forward or bridge per section 4.5. Rebuild runtimes. Run the live tests against the Docker sshd (`scripts/tests/remote-sshd/run.sh`).

**P5. Optional HTTP listener (M4, M5).** Loopback bind, the ingress key file created here, key required, rotation with an overlap, Origin and Host checks, bind address a setting. Tests include a rebinding attempt, a missing key and a call that spans a rotation.

**P6. Harness migration and deletion (optional, after a soak).** Scoped-credential handshake for the harness, then remove `--serve --managed`, `ensure_mcp_server`, `refresh_mcp_endpoints`, `ManagedMcpChild`, the endpoints file and the preflight patterns that referred to them. Update `AGENTS.md`.

## 8. Unverified

- Whether claude.ai and the mobile apps call connectors from Anthropic's servers, and what auth they require. Check Anthropic's current docs before P5.
- Whether a Bun worker can terminate the whole process from a stalled main loop. Only matters if M3 (b) is ever chosen.
- Whether an MCP built against one proto version can safely call a daemon of another; M7 (a) avoids the question by refusing mismatches.
- Which MCP tools touch the local filesystem directly (pitfall 21).
- How the in-app updater would ask a running machine MCP to exit before the swap. The `preflight.sh` and `update.rs` interaction needs reading first.

## 9. Documentation to change

- `AGENTS.md`: the MCP paragraph, the module map row for `mcp.rs`, the command count and list, the remote runtime notes, and the quiet-machine description.
- `README.md` is human-edited only. Suggested change for the human: describe the Runtime panel and the machine MCP's socket and optional HTTP mode.
