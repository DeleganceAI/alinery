# Machine MCP and the runtime status panel

Status: v0.4, 2026-11-15. P0 is done: M1 to M10 are decided (section 3). P1 is built and committed (`7bd85be2`, extended since). P2 is built. P3 is built (local). P4, P5 and P6 are built.

v0.4 adds M9 (an app update asks the MCP to exit) and M10 (HTTP is a bound port the user wires up; Settings shows its address and token per host). v0.3 recorded the decisions: full reach for every caller with an optional token (M2, M5), Restart and Force restart in the panel (M3), refuse protocol mismatches (M7), register over the socket (M8). v0.2 had reviewed the plan against the code.

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
- Reaching a remote host's machine MCP from a chat client on the Mac. The user points the client at the host's HTTP listener (P5) or at an ssh tunnel they run; Alinery adds no forward or bridge for it (user, 2026-11-15).
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
- **Decisions already recorded** in `docs/thick-daemon-plan.md`: O10 (b) the Bun binary owns MCP, O18 (b) AGENT is exactly MCP's tools, O20 (c) MCP runs only on the daemon's host with minted tokens and "from any machine" is dropped, O22 (a) only the shell's managed MCP offers `alinery_send_review_handoff`. This plan replaces O20 (c) and O22 (a) for every caller (M2).
- **The harness token already lives in the harness's reach.** O20's rationale says an agent that can run MCP can read its token and call those RPCs directly, and the user accepted that per repo.
- **A harness agent already has cross-repo reach today.** The harness has the `bash` builtin (`mcp.ts` `BUILTIN_TOOLS`) and runs as the user, so it can read the owner-only `mcp-endpoints.json`, which holds an AGENT token for every local daemon the app has open. Any file this plan adds under the app-config directory is equally readable. The OS account is the boundary; nothing in this plan narrows or widens that.
- **`Hello` is authenticated.** A missing or wrong bearer token on `AdminService/Hello` is `Unauthenticated` (`auth.test.ts`), so a daemon answering `Hello` with a given token proves the token is live on that daemon.
- **Socket path length is not a risk.** `app_config_identity` is 16 hex characters (`paths.rs`), so a host's `~/.local/share/alinery-remote/config/<identity>/machine-mcp-<ns>.sock` stays near 75 bytes, well under 104 (macOS) and 108 (Linux).

## 3. Decisions

Settled with the user on 2026-11-15 (P0). Where the user's answer went beyond the listed options, the "How it is built" column says how the plan carries it out.

| # | Question | Decision | How it is built | Who, when |
|---|---|---|---|---|
| M1 | What "machine" means | **One per OS user and per lane.** | The app-config identity and socket namespace daemons already use. Sockets are 0600; a second OS user's process is never served. On a shared box each user has their own machine MCP and reaches only daemons that registered with it (their own, plus any they joined, whose member token works). | Recommendation applied, 2026-11-15 |
| M2 | Cross-repo reach (changes O20 c and O22 a) | **Full reach for every caller, the harness included, with an optional auth token that guards the MCP.** | No harness-scoped connection: a harness uses the machine MCP like any client, and `alinery_send_review_handoff` is offered to everyone. The token is off by default; when the user sets one, every caller presents it, on the socket and over HTTP. The stdio bridge and a harness read it from the owner-only key file, so the token keeps out other OS users and remote HTTP callers, not processes of this user (section 2). | User, 2026-11-15 |
| M3 | A stuck MCP | **The panel shows "stuck", and the panel has a Restart MCP button.** | "Stuck" is a `status` op that does not answer within a timeout. Restart sends `{"op":"exit"}`, waits for the socket to go quiet, then connect-or-spawn. If the MCP does not answer, the panel offers **Force restart…** behind `confirmDanger`, which names the connected clients. Force restart reuses confirmed takeover's identity: the shell connects to the MCP socket and takes the kernel-authenticated peer process (`alinery_core::legacy_daemon::peer_process_id`, `LOCAL_PEERPID` / `SO_PEERCRED`), the confirmation binds to that incarnation, and only that process gets SIGTERM, refused if the incarnation changed. The machine MCP installs no SIGTERM handler, so the default action ends even a wedged event loop. There are no pid files and no automatic kill: it is a user's confirmed click, like Take over. It adds one reasoned line to `check-no-auto-session-kill.sh`. No watchdog. | User, 2026-11-15 |
| M4 | HTTP listener | **Opt-in per host, off by default, Streamable HTTP only, no TLS, its own phase (P5). The user picks the bind address per host in Settings: loopback (the default), all interfaces, or one address such as a Tailscale IP.** | HTTP cannot be turned on without the M2 token, because other OS users and any page doing DNS rebinding can reach even loopback. Origin and Host are validated. A non-loopback bind shows a warning that the listener speaks plain HTTP, so the token crosses that network unencrypted unless the user puts TLS in front (a reverse proxy, a tunnel, Tailscale). The warning stays even when they have: the app cannot see a proxy, and a proxy on another machine still talks plain HTTP to the listener. No legacy SSE transport. | User, 2026-11-15 |
| M5 | The token | **Merged into M2.** One token in an owner-only `machine-mcp[-ns].key`, set, rotated or cleared from the panel, never in argv or env. | A rotation keeps the old token valid for one overlap window (the R-S5.1-4 lesson). Per-client tokens are out of scope. | Follows M2, 2026-11-15 |
| M6 | Ownership and exit | **Daemons and the stdio bridge do connect-or-spawn; the MCP exits after 10 minutes with no registered daemon; the app never owns it.** | The app can restart it (M3) and start it, like any client. | Recommendation applied, 2026-11-15 |
| M7 | Version skew | **Refuse mismatches.** | The MCP calls only daemons whose `Hello` protocol equals its own and lists the rest as `incompatible` in its tool output and the panel. The bridge reads the MCP's protocol from `status` and refuses a mismatch with a message naming Restart MCP. `behind` is a state, never an automatic stop. | User, 2026-11-15 |
| M9 | The machine MCP across an app update | **The updater asks it to exit during the swap.** | The swap sends the frozen `{"op":"exit"}` over the socket and waits for it to go quiet, never a signal; the next client (a daemon registering, the bridge) starts the new build. The update is the user's click, so nothing stops on its own. A remote host's MCP is not touched: it stays `behind` with Restart MCP in its panel row. | User, 2026-11-15 |
| M10 | How outside clients reach the HTTP port | **Alinery runs the server and binds the port; connecting is the user's job.** | Nothing is built on the client side: no `--url` bridge, no tunnel. Settings shows, per host, the listener's URL (bind address and port) and its token with a copy button, plus a short note: wrap it in TLS, a tunnel or a firewall rule yourself; Claude's custom connectors connect from Anthropic's cloud, so they need a public HTTPS URL, and accept the token as a fixed `Authorization: Bearer` header; Claude Desktop's local config launches processes, so a generic bridge such as `mcp-remote` points it at the URL. | User, 2026-11-15 |
| M8 | How daemons register | **Over the socket.** | Each daemon connects to the MCP socket, sends `{"op":"register"}` with its repo, socket path, protocol and a freshly minted AGENT token, and keeps the connection open; a closed connection means the daemon is gone. On a drop the daemon does connect-or-spawn again (single-flight, the flock picks the winner, backoff 1, 5, 30 s). The idle timer is "no registered connection for 10 minutes". The `/var/tmp/alinery-daemons/` box records (`domain/boxRegistry.ts`, world-readable, no tokens) stay a display source and are not used for credentials. | User, 2026-11-15 |

Confirmed with the user on 2026-11-15, against the topology diagrams:

- The Alinery app keeps talking to every daemon directly through its gRPC bridge; the machine MCP is a sibling client, never in the app's path.
- A chat client on the Mac reaches a remote host's repos through that host's HTTP listener or a user-run tunnel, not through Alinery (section 1).
- A daemon from another build stays `incompatible` until the user restarts it (M7).

## 4. Design

### 4.1 Files

All under the app-config directory (`alinery_core::app_config_dir_of`), one set per lane, like `mcp-endpoints[-ns].json` today. On a remote host the same set lives in `~/.local/share/alinery-remote/config/<app-config identity>/`.

| File | Purpose | Written by |
|---|---|---|
| `machine-mcp[-ns].sock` | the unix socket, mode 0600 | the machine MCP, only while it holds the lock |
| `machine-mcp[-ns].lock` | flock singleton, a 0-byte marker never unlinked | `platform/lock.ts` `tryLockExclusive` |
| `machine-mcp[-ns].key` | the optional token (M2, M5), 0600; absent means no token is required | the shell when the user sets or rotates it in the panel, through an atomic write |

There is no registry directory (M8): presence is an open registration connection, never a file, which is the rule #74 set for MCP status.

### 4.2 Credentials

Two layers:

- **Egress (MCP to daemon).** Each daemon mints an AGENT token labelled `machine-mcp` (`TokenRegistry.mint` replaces a label and keeps the previous token valid until the next mint) and hands it over: in its registration message (M8). Each re-registration mints afresh, and no token is written to disk. The daemon stays the enforcer through `AGENT_RPCS`. This removes the app from the token path: the app no longer has to be running, and the 30-second re-mint and the endpoints file go away at P6.
- **Ingress (client to MCP).** The optional token (M2). When the key file exists, every caller presents it: the stdio bridge, a harness, a daemon registering, and HTTP. When it does not, the socket's 0600 mode is the only guard and HTTP cannot be enabled (M4). The MCP rereads the file on change, so a rotation needs no restart, and accepts the previous token for the overlap window.

Every connection reaches every registered daemon (M2); there is no scoped connection.

### 4.3 Process and lifecycle

- **Singleton.** Take the exclusive flock first. The holder alone may unlink and bind the socket. This replaces `serveSocket`'s unconditional unlink, which would orphan a live instance. A second starter that cannot take the lock connects to the socket, runs `status`, and exits.
- **Connect-or-spawn is single-flight.** One in-flight promise per process, then the flock across processes. Spawn storms are the pitfall in `ensure_mcp_server` ("spawned managed alinery-mcp" log loop), so connect-or-spawn runs only on daemon start, on a dropped registration (M8 b, with backoff), when a harness needs the endpoint, when the stdio bridge finds no socket, and on an explicit panel action. It never runs from a poller.
- **Launch recipe.** Reuse the daemon's recipe, not a new one: login-shell PATH, null stdio, a new session. On a host with systemd, start it in its own transient unit (`systemd-run --user --collect --unit=alinery-mcp-<lane>`), as `spawnDaemon` does for the daemon. A child left in the daemon's unit would die with it, because the unit's cgroup is killed when the unit stops, which defeats "outlives any daemon".
- **Exit.** A monotonic idle timer, 10 minutes from the moment no daemon is present (M8). Exit unlinks the socket while still holding the lock, then releases it.
- **Control ops stay additive and frozen.** `{"op":"exit"}` keeps its exact bytes and its ack, because shipped shells send it raw. Add `{"op":"status"}` returning build id, protocol, uptime, client count and the daemons it sees (each `ok` or `incompatible`, M7), and `{"op":"register"}` (M8). Never change the existing op.
- **Skew (M7).** A daemon whose `Hello` protocol differs from the MCP's is listed `incompatible` and none of its tools are called.

### 4.4 Daemon-side control (McpService)

The daemon supervises the MCP, so remote hosts need no new host operation. A new `McpService` in `proto/alinery/v1/mcp.proto`, ADMIN only and not in `AGENT_RPCS`:

- `Status`: build id, protocol, uptime, clients, state (`absent`, `ok`, `behind`, `stuck`).
- `Ensure`: connect-or-spawn.
- `Restart`: send `exit` over the socket, wait for it to go quiet, then `Ensure`. A timeout returns `stuck`, never a signal; Force restart is the shell's, local only until P4 (M3).

`absent` is not a warning: the MCP starts on demand. The host-guard false positive (`5e1a4a03`) came from treating "env var missing" as a fault where it was the design. `behind` means the running build differs from this daemon's build. It is a state, never an automatic stop, mirroring `BuildDrift`.

This is a proto change: regenerate `proto/gen`, rewrite `proto/golden`, bump `PROTOCOL_VERSION`, and do not touch `admin.proto` or `common.proto` (frozen by `check-admin-wire-frozen.sh`).

### 4.5 Clients

- **stdio bridge.** `--mcp` without `--machine` stays the entry for Claude Desktop and similar, but becomes a thin proxy to the machine socket. It holds no daemon tokens; it presents the optional token from the key file when one is set. It does connect-or-spawn, so a crashed MCP comes back on the next client, and it checks the MCP's protocol through `status` first and refuses a mismatch with a message that names Restart MCP (M7). The "Copy config" snippet does not change shape.
- **Remote hosts.** The host's daemons start the host's machine MCP. A chat client on the Mac reaches it through the host's HTTP listener (P5) or a tunnel the user sets up; Alinery adds no forward or bridge for it. The app itself never goes through any MCP: it keeps its ssh forwards to each daemon, and reaches the host's MCP only for status and restart, through the host daemon's `McpService`.
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
| 5 | A token re-minted while a tool call is mid-flight | R-S5.1-4, `5bc6f593` | keep the overlap: a daemon's mint keeps the previous token; the optional token rotates with an overlap; read the credential per request |
| 6 | A restart reusing the runtime chosen at connect | this session, `195f6fb9` | the machine MCP is the daemon's own binary, so it matches that daemon's runtime; a mismatch is the `behind` state with an explicit Restart MCP; the panel's host Update is the same reconnect refresh |
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
| 22 | One MCP serving daemons of several builds | new: the lane identity hashes the config path, not the build, and old daemons outlive an update | M7: serve matching protocol only, list the rest `incompatible`, bridge refuses a mismatched MCP, Restart MCP is the user's click |
| 23 | Claiming a boundary the OS account does not give | the harness's `bash` builtin can already read `mcp-endpoints.json` | M2 gives every caller full reach openly; the optional token guards against other OS users and HTTP callers, and the plan says so; no daemon tokens on disk (M8) |
| 25 | A force kill that hits the wrong process | #74 pid reuse; confirmed takeover's incarnation binding | Force restart binds the confirmation to the kernel-authenticated peer of the MCP socket and refuses if it changed; never a pid file, never automatic |
| 24 | A crashed MCP nobody restarts | new: daemons ensure only at start | the bridge and a dropped registration both do connect-or-spawn |

## 7. Phases

Each phase ships on its own and leaves the old paths working. While iterating, run targeted tests only (`cargo check -p alinery-app`, `bun test` in the daemon, `vitest` for a file). Run `./scripts/check.sh` once at check-in. Do not launch the app unless asked.

**P0. Decisions.** Done: M1 to M10, section 3. Exit: recorded in the style of `thick-daemon-plan.md`'s decision table.

**P1. Read-only Runtime panel.** No daemon or proto change. Built in `7bd85be2`: `runtime_status` in `remote.rs`, `RemoteSession.triple`, `runtime_is_stale(manifest, triple, hash)` now used by `stop_remote_daemon` too (one fewer ssh probe per restart; a new bundle that raises the glibc or macOS floor now fails the reconnect instead of falling back to the old runtime), `views/RuntimePanel.tsx` under Settings → Updates. Live sessions show only for attached repos. Not yet seen against aagent in the app.
- Rust: `runtime_status` command in `remote.rs` or a new small module, store the selected triple on `RemoteSession`, compute stale without ssh.
- TS: `ipc.ts` wrapper, the panel under the update section of `Settings.tsx`, rows for hosts, daemons and the existing MCP.
- Tests: a Rust unit test in `src/tests/remote.rs` for the staleness decision (extends the one added in `195f6fb9`), a vitest for the panel rows.
- Gates: `check-ipc-commands.sh`, `check-remote-routing.sh`, `check-remote-offload.sh`.
- Exit: the aagent row shows "stale" before a restart and "current" after.

**P2. Panel actions.** Daemon restart and host update with explicit targets and impact text. MCP actions wait for P3 (they become `McpService` calls), because giving the current managed-MCP commands a target is work P6 deletes. Tests: vitest for confirmations and impact lists; Rust for target resolution that never reads `active_repo()`. Built: Restart… per running daemon (the footer's `updateDaemon`, now with the live count; this computer's conflicted daemon keeps its takeover on the banner) and Update host… per stale connected host (`remote_connect`, which reuses running daemons); `stop_target` holds the explicit-key rule.

**P3. Machine MCP, local.**
- Proto: `mcp.proto` (`McpService`), regenerate, golden, `PROTOCOL_VERSION` bump.
- Daemon: an MCP manager (single-flight ensure, registration per M8, token mint), `--mcp --machine` mode in `mcpServer/` (flock first, discovery, `status`, `exit` and `register`, protocol check per M7, the optional token, idle exit, no SIGTERM handler), the stdio bridge with connect-or-spawn.
- Shell and panel: the MCP row with Restart MCP and Force restart (M3, reusing `peer_process_id`), and the token field (set, rotate, clear; the shell writes the key file).
- Tests: `bun test` beside the source, including a real-socket test of the singleton race (two starters), the idle exit, a daemon re-registering after the MCP restarts, a mismatched-protocol daemon listed `incompatible`, the bridge refusing a mismatched MCP, a missing or wrong token refused while the key file exists and accepted during a rotation overlap, Force restart refused when the socket's peer incarnation changed, and that `McpService` is absent from `AGENT_RPCS` and an AGENT token gets `PermissionDenied` on it.
- Gates: `check-proto-gen.sh`, `check-protocol-version-bump.sh`, `check-no-auto-session-kill.sh`, `check-daemon-fs-writes.sh`.
- Exit: Claude Desktop through the bridge reaches two repos with the app closed.
- Built, with these choices made while building:
  - Daemons register only when started with `--machine-mcp` (the shell's local launch passes it), so the test suites' throwaway daemons never start an MCP. `McpService` is on every daemon.
  - The token is managed by `McpService.Token` (read, rotate, clear), written by the daemon through `platform/fs.ts`, not by the shell: one home that P5's remote hosts reuse. The key file is JSON with the previous token and its overlap end; an unreadable file accepts nothing.
  - The bridge is `--mcp --bridge`, an explicit flag, so the old endpoints-file form in configs users already pasted keeps working until P6. "Copy config" now emits the bridge form.
  - `build` in `status` is the app version (the local `--build-id` is only the binary's file name), so `behind` means another release.
  - The socket is owner-only (0700, from the umask), not 0600; a unix socket needs only the owner bits.
  - Force restart's SIGTERM lives in `alinery-core` (`PeerProcessIdentity::terminate`) because the app crate has no `libc`.
  - Not built: the "Exit" check against Claude Desktop by hand, and the M9 updater exit. A daemon whose registration drops respawns the MCP after 1 s, so the M9 exit must come after the swap has replaced the binary, or the old build comes back.

**P4. Remote hosts.** Spawn through the launcher recipe (transient unit on systemd hosts), per-host panel rows with Restart MCP through the host daemon's `McpService`. No client forward or bridge (section 1). Rebuild runtimes. Run the live tests against the Docker sshd (`scripts/tests/remote-sshd/run.sh`).
- Built: the host service passes `--machine-mcp --machine-launch <launch>` to every daemon it starts, and the daemon starts its MCP the same way (`spawnMachine`: `systemd-run --user --collect` in its own unit `alinery-mcp-<hash of the socket>` with the daemon's PATH, else a new session). One MCP per host app-config directory, so two apps on a shared box never share one. The panel shows an MCP row for this computer and for each connected host, read and restarted through the first running daemon on it; Force restart is this computer's only (it needs the peer's pid). Live tests pass against the Docker sshd (Launch::Direct there), and a host-side bridge reached the registered repo. The systemd path is unit-tested for its arguments only.
- The runtime build on this Mac needed vtool and codesign hidden to skip darwin: the darwin Python stage fails on `cryptography==50.0.0` (from main's dependabot merge #206), which has no distribution yet. That predates this branch and blocks `tauri build`.

**P5. Optional HTTP listener (M4, M10).** Streamable HTTP, refused unless the M2 token is set, Origin and Host checks, the bind address picked per host in Settings (loopback, all interfaces, or one address) with the cleartext warning, and the per-host URL and token with a copy button and the M10 note. A remote host's settings go through its daemon's `McpService` (ADMIN), so no new host op. Tests include a rebinding attempt, a missing key and a call that spans a rotation.
- Built: `mcpServer/http.ts`, started by the machine MCP from `machine-mcp[-ns].http.json` beside the key (read once; `McpService.SetHttp` validates, writes it owner-only and restarts the MCP). JSON answers only: POST to `/mcp`, a notification gets 202, GET gets 405 (no server stream). Every request needs the token, loopback too, read per request so a rotation needs no restart. A loopback bind requires a loopback Host (DNS rebinding); any bind requires an Origin, when sent, to name the Host. The bind is 127.0.0.1, 0.0.0.0 or one of the machine's own non-link-local addresses (listed in `McpStatus.http.addresses`). Turning HTTP on without the token and clearing the token while HTTP is on are both refused. The panel's HTTP row per host: on/off (disabled until a token exists), bind, port, the cleartext confirmation and warning off loopback, the URL with Copy, and the M10 note. Still protocol 49: unreleased, so no second bump.

**P6. Harness migration and deletion (optional, after a soak).** Point the harness's `McpHub` at the machine socket (no scoped handshake, M2), then remove `--serve --managed`, `ensure_mcp_server`, `refresh_mcp_endpoints`, `ManagedMcpChild`, the endpoints file and the preflight patterns that referred to them. Update `AGENTS.md`.
- Built, without the soak: the hub's built-in server is `--mcp --bridge`, with no token in its environment, and only a daemon started with `--machine-mcp` adds it (a test daemon would otherwise leave a machine MCP behind). Gone: `--serve`, `--managed`, the endpoints file, `ensure_mcp_server`, `refresh_mcp_endpoints`, `ManagedMcpChild`, `start_mcp_server` and `stop_mcp_server`, `mint_agent_token` in the shell, `mcp_enabled` in the app config, the core `mcp_socket_path` and `mcp_status_path`, the footer's MCP line, the Settings toggle and the panel's managed row. `mcp_status` now answers only the binary and host args for Copy config. `--mcp` without `--bridge` but with `--app-config` runs the bridge, so configs pasted before P3 keep working. A harness now reaches every registered repo (M2), not only its own, and `resources/*` answer that they need `--repo`.
- Risk the soak was for: when an update changes the protocol, the running machine MCP is `behind` and refuses the new bridges, so harness sessions lose the `alinery` tools until Restart MCP (or its 10-minute idle exit once no daemon is registered). M9's updater exit is still unbuilt.
- The storage panel still lists `.alinery/mcp[-ns].sock` and `.status.json` (`entities.proto` field 10); those files are no longer written.

## 8. Unverified

- Resolved 2026-11-15: Claude's custom connectors connect from Anthropic's cloud (a loopback or LAN URL is unreachable) and accept a fixed bearer header (static credentials are in beta). Recheck the docs when P5 starts.
- Whether a Bun worker can terminate the whole process from a stalled main loop. Only matters if M3 (b) is ever chosen.
- Whether an MCP built against one proto version can safely call a daemon of another; M7 (a) avoids the question by refusing mismatches.
- Which MCP tools touch the local filesystem directly (pitfall 21).
- Where in `preflight.sh` and `update.rs` the M9 exit request goes, so it runs after the quiet-machine gate passes and before the swap.

## 9. Documentation to change

- `AGENTS.md`: the MCP paragraph, the module map row for `mcp.rs`, the command count and list, the remote runtime notes, and the quiet-machine description.
- `README.md` is human-edited only. Suggested change for the human: describe the Runtime panel and the machine MCP's socket and optional HTTP mode.
