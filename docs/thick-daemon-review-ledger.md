# Thick daemon: review ledger

The plan (`docs/thick-daemon-plan.md`) says "no silent decisions". The overnight build runs unattended, so that rule becomes **no unrecorded decisions**: when a session needs a choice the plan does not make, or finds a fact that contradicts a working assumption (WA), an Open item or a Decided row, it does not stop. It takes the plan's WA or recommended option, or else the most conservative and most reversible choice, builds it, and records it here. The user reads this file at the end and overrules what they want.

This file holds: provisional decisions, deviations from the plan, unverified claims, known flaky tests, follow-ups, and suggested README text. Checks that need the app, a signing identity, x64 hardware or a person are in `docs/thick-daemon-live-checks.md`, not here.

**Rules for agents.** Append; never delete or rewrite an earlier entry (to change one, add a dated `Update:` line under it). README.md is human-edited only: put suggested README text in the README section at the bottom. Never claim a fix or a pass you did not observe.

**Entry format.**

- **Id and title.** `R-<session or topic>-<n>`.
- **Kind.** `decision` (provisional or user-decided), `deviation`, `unverified`, `flaky`, `follow-up`, `plan-text`, or `readme`.
- **What.** The decision or fact.
- **Options.** What else was on the table (decisions).
- **Why.** Why this one.
- **Reverse.** How to undo it.
- **Files.** Where it lives.

Sections: A. Decided by the user. B. Provisional decisions and deviations made by sessions (P0 to P3). D. Dustin's PR #154 comment dispositions. E. Flaky tests. F. Unverified claims. G. Plan text that is stale. H. Suggested README text. (There is no section C; ids keep the letters stable.) Later sessions append to the section that fits, with the next free id.

---

## A. Decided by the user (2026-11-05)

These are already in the plan (1.7, 4.1). Listed so the morning review has one place.

### R-USER-1: O25, ship the telemetry ingest credentials as they are
- **Kind:** decision (user).
- **What:** option (b). `alinery-core/src/telemetry.rs:21-22` stays hardcoded; the daemon (O17 c) and every remote runtime hold the shared ingest credential. R5 risk accepted.
- **Reverse:** option (a), per-install or revocable ingest tokens, would change both the shell and the daemon copy.
- **Files:** plan 1.7 O25, 4.4 handoff (R5).

### R-USER-2: O12, the agent dir is per host and daemon-owned
- **Kind:** decision (user), implementation path provisional.
- **What:** option (a). The daemon owns the agent directory on each host; the shell mirrors the local copy. The user suggested "the host's home, `~/.alinery/agent` or something". The plan lets the implementer choose the path inside the host layout AGENTS.md already defines (`~/.local/share/alinery-remote/config/<app-config identity>/` on a remote host, the app config dir locally) unless that is wrong for the daemon. **S4.10 records the real choice here.**
- **Why the host layout rather than `~/.alinery/agent`:** the layout is already owner-only, keyed by app-config identity (so two builds do not share a dir), and covered by the remote-sharing rules; `~/.alinery/` would be a second root on the host.
- **Reverse:** move the dir and change one path constant plus the `WriteConfigFiles`/sync step; the choice is not in any wire message.
- **Files:** plan 1.7 O12, S4.10.

### R-USER-3: O10, MCP becomes a `--mcp` stdio mode of the Bun binary
- **Kind:** decision (user). The Rust `alinery-mcp` goes (S5.1). Reverse: keep the Rust crate (not trivial once deleted).

### R-USER-4: O22, only the shell's managed MCP offers `alinery_send_review_handoff`
- **Kind:** decision (user). An MCP inside a harness answers that the tool needs the app's MCP. Files: plan O22, S5.1.

### R-USER-5: O15, `--host-service` stdio mode of the Bun binary; no Rust on the host
- **Kind:** decision (user). The host runtime carries no Rust, so `zig`, `cargo-zigbuild` and the two rustup targets stop being needed once S5.2 lands. Until then the build still needs them (live-checks L-S1.3-a). Files: plan O15, S5.2.

### R-USER-6: O11 amended, no compatibility with today's `-v1.zip`
- **Kind:** decision (user). "For S4.9 don't worry about compatibility for zip backups; we move forward with breaking changes now." The archive format may change; old archives need not restore; S4.9 has no Rust-compatibility test and no "stop and ask" fallback. The Info-ZIP choice (O11 b) stands unless a session finds a reason against it, and then records it here.
- **Reverse:** restore the compatibility test from the plan history (v0.9, before 2026-11-05).
- **Files:** plan 1.7 O11, S4.9.

### R-USER-7: O27, history and per-step file states
- **Kind:** decision (user) on the open parts of WA (b/c). Exact bytes, no size cap; a file is copied or cloned copy-on-write (`clonefile` on APFS, `FICLONE` on a reflink-capable Linux filesystem), never hard-linked (an agent that rewrites a file in place would change the snapshot with it); archiving a task prunes `objects/` and keeps only artifacts and manifests; unarchiving does not bring snapshots back. Format inside this contract is the implementer's.
- **Not yet built.** S4.2 and S4.5 build and test it.
- **Files:** plan 1.7 O27, S4.2 (History bullet), S4.3 (archive prunes), S4.5.

### R-USER-8: base-branch fixes made in S0.1 are kept
- **Kind:** decision (user, via 4.4). S0.1 fixed base-branch failures so `check.sh` could run: biome formatting, `tsc` on tests, four vitest tests, one clippy warning, the takeover test, and the protocol 24 shutdown dialect. See R-S0.1-1 and R-S0.1-2.

---

## B. Provisional decisions made by sessions

### R-O5: keep one process until P7 (O5 (a))
- **Kind:** decision (provisional; the plan asks the user to decide before S4.2).
- **What:** S3.4 measured echo p99 under load (4.1 `S3.4 build (v0.9)`): idle 1.84 ms; task creation with 4 attachments every 200 ms +2 ms; a flood of 4 parallel `writeDurable` every 20 ms +24 ms; reconcile over 1,000 tasks +5.6 ms; git, tar child +0; everything together +9.7 ms. The plan rule says to put O5 to the user when p99 grows by more than 5 ms. The user is away overnight, so the build continues on O5 (a) (the plan's own recommendation, "until P7"), with the Worker-based `F_FULLFSYNC` already in S2.2 (O26).
- **Options:** (a) one process until P7; (b) keeper plus brain now, before S4.2.
- **Why (a):** the over-5 ms rows are synthetic floods harder than the plan's case; the typical case (one task creation) grows 2 ms; (b) is a large change and P7 S7.1 re-opens it with fd-passing numbers.
- **Reverse:** S7.1 builds (b) (`--keeper`, `keeper.proto`). If you decide (b) earlier, S4.2's heavy work (reconcile, backup) should be moved to job children first, which S2.6 already supports.
- **Live check:** L-S3.4-c.
- **Files:** plan 1.7 O5, S7.1; `docs/thick-daemon-spikes/src/echo-load*.ts`; `vinculum-daemon/src/rpc/terminal.bench.ts`.

### R-S2.2-1: writeDurable syncs in Rust's order, not the Build bullet's order
- **Kind:** deviation (decision inside the module).
- **What:** write the temp file, await its sync, rename, then await the directory sync. The Build bullet and spike said rename first, then sync both. Rust's `write_bytes_durable` uses the order chosen here, so a power cut never exposes an unsynced file under the final name. Still two `F_FULLFSYNC` calls per write.
- **Options:** rename-first (spike order); Rust order.
- **Why:** crash safety matches Rust, and the shell and daemon write the same files under the same flock.
- **Reverse:** swap two awaits in `platform/fs.ts` `writeDurable`; update `fs.test.ts`.
- **Files:** `vinculum-daemon/src/platform/fs.ts`, `platform/fsync-worker.ts`, plan 4.1 `S2.2 build (v0.9)`.

### R-S2.2-2: compiled builds address the Worker by `/$bunfs/root/...` and need a second entry point
- **Kind:** deviation.
- **What:** in `bun build --compile` every module's `import.meta.url` is the entry's, so `new URL("./fsync-worker.ts", import.meta.url)` fails. `fs.ts` uses `/$bunfs/root/platform/fsync-worker.js` when `import.meta.url` contains `/$bunfs/`. `scripts/dev-fetch-bun.sh` and `scripts/build-remote-runtimes.sh` pass `src/platform/fsync-worker.ts` as a second entry point.
- **Unverified:** proven on macOS arm64 only. Live check L-S2.2-b for Linux; L-S2.2-a for the hardened runtime.
- **Reverse:** inline the Worker source as a string and use `new Worker(URL.createObjectURL(...))`.

### R-S2.2-3: signalChild gate reads one line at a time; other S2.2 choices
- **Kind:** follow-up.
- **What:** `check-no-auto-session-kill.sh` matches `signalChild(` per line; a call split across lines fails the gate (loud, not a hole). `spawnDetached` gives the MCP children and the shell PTY their own process group. `tryLockExclusive(path, afterOpen?)` has a test hook. The echo-latency Build bullet (p99 within 0.5 ms with a durable write every 200 ms) is not an automated test; the spike numbers are in 4.1 (idle p99 0.11 and 0.13 ms; with the Worker 0.15 and 0.16 ms; with `F_FULLFSYNC` on the main thread 4.45 and 5.10 ms). A loop-gap unit test was tried and dropped (6.7 ms, too close to idle).
- **Files:** `scripts/tests/check-no-auto-session-kill.sh`, `platform/process.ts`, `platform/fs.ts`.

### R-S1.1-1: daemon socket umask is 0o177, not the plan's 0o077
- **Kind:** deviation.
- **What:** under `0o077`, `bind(2)` gives `srwx------`; the Accept line expects `srw-------`. The daemon binds `rpc[-ns].sock` under `0o177`.
- **Why:** matches the Accept line; still owner-only.
- **Reverse:** change the umask constant in `rpc/server.ts` and the Accept text.
- **Live check:** L-S1.1-a (step 6).

### R-S1.1-2: the absence of ALINERY_HOST_EXECUTABLE means "every peer is sshd"
- **Kind:** decision (the plan does not say how the daemon tells an ssh-forwarded shell from a local non-shell peer).
- **What:** the app starts a remote daemon without `ALINERY_HOST_EXECUTABLE`; so every peer is sshd, and the bearer token alone yields VIEW, ACT, APPROVE and ADMIN. A local daemon always has the variable, and then the peer's executable must equal it to be the shell. This is today's `ui_control` secret rule.
- **Risk:** a local daemon whose host executable could not be resolved would be treated as remote, and a bearer-token holder would get ADMIN. The token is owner-only and the socket 0600, so the extra exposure is a same-user process that has read the token.
- **Options:** an explicit `--peer-class=forwarded` flag (rejected: a new wire-adjacent argument for a rule that already existed for `ui_control`).
- **Reverse:** add the explicit flag and fail closed when the variable is absent.
- **Live check:** L-S1.1-b (native x64 peer check), L-S1.3-c.
- **Files:** `vinculum-daemon/src/rpc/auth.ts`, `main.ts:974,1133`, plan 4.1 `S1.1 build (v0.9)`.

### R-S1.1-3: other S1.1 choices
- **Kind:** deviation.
- **What:** (1) `AdminService.Shutdown` was registered with the real ADMIN check and answered UNIMPLEMENTED until S1.4 (now replaced). (2) The app's token copy is one owner-only file per repo and lane at `<app_config_dir>/rpc-secrets/<fnv(repo, lane)>.secret` (remote: under `remote/<host-id>/`), not a shared JSON map, so two repos starting at once cannot overwrite each other. (3) A failed `rpc` bind stops the daemon at start (top-level await in `main.ts`). (4) `protocol::tests::ui_control_secret_bumps_protocol` was weakened from `== 24` to `>= 24` (a compile-time const assert, so it can never fail at run time, and no longer pins the value); a pinned equality blocked the bump to 25. (5) The Accept `buf curl` lines were run against a hand-started daemon, not an app-started one.
- **Follow-up:** pin the value with a runtime test, or compare to the daemon's constant (a check that exists in the protocol gate). Nothing tests `main.ts` startup order (secret read and deleted before `serveRpc`, RPC before sessions resume).
- **Files:** `alinery-core/src/protocol.rs` (tests), `vinculum-daemon/src/main.ts`, `rpc/auth.ts`.

### R-S1.2-1: additions beyond the plan
- **Kind:** deviation.
- **What:** direct dependencies `tokio` (net, time, sync, macros, rt), `http`, `bytes` at the versions `Cargo.lock` already held; `hyper` with `server` as a dev dependency for the stand-in daemon; `@connectrpc/connect` and `@connectrpc/connect-web` 2.2.0 exact pins; `alinery_core::rpc_socket_path` in `alinery-core/src/paths.rs`. The shell drops `authorization`, `te`, `host` and `content-length` from the webview's headers and sets its own, and does not forward empty DATA frames (hardening the plan does not state). Bridge state is a module-level `LazyLock`.
- **Open:** (1) the reconnect-and-resend retry in `Bridge::request` has no test (replacing the condition with `false && e.is_closed()` kept all 12 tests green). (2) `Bridge::sender` holds one async mutex across every socket's connect, so a slow connect to one repo's daemon blocks another's. (3) The window-destroyed cancel hook has no automated test (live L-S1.2-b). (4) A reload cancels an idle stream only when the daemon next sends data (heartbeat, 15 s).
- **Files:** `alinery-app/src-tauri/src/daemon_rpc.rs`, `src/tests/daemon_rpc.rs`.

### R-S1.3-1: Hello is hand-encoded; liveness is not enforced for an already-running daemon
- **Kind:** deviation.
- **What:** `daemon_rpc.rs` hand-encodes and hand-decodes `Hello` (protocol, build_id, epoch) until S1.4's prost structs (now in). A failed Hello is an error only for a daemon `ensure_remote_daemon` just started (15 s of retries); for an already-running daemon the failure is not raised, since its token may belong to another Mac. A daemon from an older runtime with no `rpc.sock` reconnects silently without an RPC forward. When a daemon this call just started fails Hello, `ensure_remote_daemon` returns Err but the daemon keeps running (nothing is killed); a later attach finds it.
- **Follow-up:** log or flag a failed probe so a dead RPC forward is visible before the first call.
- **Files:** `alinery-app/src-tauri/src/remote.rs` (`ensure_remote_daemon`, `rpc_hello`, `rpc_forward`).

### R-S1.4-1: the old JSON `shutdown` op stays as a fallback; a remote restore uses STOP_REMOTE
- **Kind:** deviation.
- **What:** the five teardown functions send `AdminService.Shutdown` with their `ShutdownOrigin` and fall back to the JSON `shutdown` op only when there is no kept token or `rpc.sock` does not answer (O23 (a): the new app must still stop an older daemon). A daemon that answers and refuses (wrong token, no ADMIN, bad origin) or goes silent is an error and is never retried on the old wire. A remote restore stops the daemon inside `stop_remote_daemon`, so it sends `STOP_REMOTE`, not `RESTORE_BACKUP` (the plan table around line 1053 still says `RESTORE_BACKUP`). The daemon requires only a non-empty `confirmation_id` for `CONFIRMED_TAKEOVER`; it cannot validate it. The shell binds a takeover to the peer's process incarnation before sending.
- **Commit hygiene:** 09ecc96 holds only the `main.ts` and `check.sh` hunks; a checkout there alone does not build. 28f79e0 holds the rest. Neither was amended.
- **Follow-up:** the S1.4 Exit line says the old `shutdown` op is unused by the shell; it should say "except the fallback for a daemon with no reachable `rpc.sock`".
- **Live check:** L-S1.4-a, L-S1.4-b.

### R-P1-1: a start no longer overwrites the kept RPC token
- **Kind:** decision (P1 review fix, 2481d62).
- **What:** `store_pending_rpc_secret` writes `<token>.pending`; `daemon_rpc::rpc_token` renames it over the kept file only after Hello succeeds with it, otherwise keeps using the kept token. A second daemon that exits on the ownership lock cannot lock the app out of the live one (UNAUTHENTICATED on Stop daemon).
- **Reverse:** write the token directly (reintroduces the lock-out).

### R-S0.1-1: StatusDot shows the unread-completion marker ahead of a bare Exited label
- **Kind:** decision (user, via e5e1f07).
- **What:** the audit of base-branch failures found `StatusDot`'s unread-completion marker conflicting with a test; the user decided the marker wins. Also fixed: biome formatting, `tsc` on tests, four vitest tests (`TopBar`, `chatTranscript`, `ChatView`, `ProviderSetupDialog`, `SessionView`, `Settings.backup` expectations), one clippy warning, and `takeover_rejects_invalid_and_compatible_targets_before_shutdown`.
- **Files:** `alinery-app/src/shared.tsx`, the test files in e5e1f07.

### R-S0.1-2: protocol 24 is an audited shutdown dialect
- **Kind:** decision (user, via 94e3f9a, 7b690ff).
- **What:** `audited_shutdown_protocol` stopped at 18, so a current daemon was never recognised as takeover-compatible. The protocol 24 daemon's handler still takes `{"op":"shutdown"}` and answers `{"ok":true}`, so 24 joins the audited list. Commit trailer: `Protocol-Neutral` (only the app's audited list changes). S1.1 raised `PROTOCOL_VERSION` to 25, and `audited_shutdown_protocol` now lists 9, 10, 12, 15, 16, 18, 24 and 25 (protocol 25 still answers the old `shutdown` op, which S1.4's fallback relies on).
- **Files:** `alinery-core/src/daemon_client.rs`, `alinery-core/tests/daemon_takeover.rs`.

### R-S0.1-3: install-proto and the first bun test
- **Kind:** deviation / flaky.
- **What:** `scripts/install-proto.sh` takes `--with-dev` (check.sh and `check-proto-gen.sh` use it) and is a no-op while `node_modules/.package-lock.json` is newer than `package-lock.json`, so `tauri dev` never reaches the network. Both consumers list `@bufbuild/protobuf` 2.16.0 directly. A first `bun test` in the daemon right after `bun install` showed 2 failures and 2 errors once and never again in 7 runs: not reproduced.
- **Live check:** L-S0.1-a.

### R-S0.6-1: S0.6 was done on a shared tree
- **Kind:** deviation.
- **What:** S0.6 ran with uncommitted S2.1 work in the tree. `main.ts` was committed without its two S2.1 lines (restored afterwards); `check.sh` ran on the working tree, not the committed tree alone; the plan commit c811349 holds only the S0.6 hunks. Removing `restate_session` and `rpc_write_session` from the DaemonClient changes no wire op (Protocol-Neutral).
- **Open:** `writeTemp`/`writeAtomic` leave an orphan `<path>.tmp.*` if `writeSync`, fsync or rename throws; add an `unlinkSync` in a catch. Crash safety of the target file is intact. S0.6's Status line says "check.sh result in the report"; the claim that the full `check.sh` passed cannot be re-verified from the repo (`--quick` passed).
- **Files:** `vinculum-daemon/src/platform/fs.ts:20-40`.

### R-S2.1-1: Dedupe is built and unit-tested but not called
- **Kind:** follow-up. First write RPC (S3.x or S4.x) must wire it in. The 15 s heartbeat is tested with injected timers only. Entities `Task {slug, title}` and `Session {ref, status}` had stand-in fields as the plan prescribes. The plan commit 8f0546a had an `@CODE@` placeholder; 7e07351 fixed it.

### R-S2.3-1: parser shape, sessions dir watch, ENOSPC
- **Kind:** deviation.
- **What:** parsers are `{ match, key, parse }`, not `{ match, parse }`, so a missing file deletes its row. The watcher also watches `.alinery/sessions` (non-recursive, only if it exists at start) so taskless chat sessions reach the store; reconcile lists it too (beyond the plan's two watches). `Session` keeps `ref=1`, `status=2` stand-in fields with `SessionMeta`'s fields at 3 to 34; the conformance comparison drops `ref` and `status`. The watcher commits `Session` with an empty status, so `commitSession` must merge the meta parse with live state (recorded in 4.1; implemented in S2.5).
- **Open:** a half-written, non-atomic `meta.json` parses as no row, so the row is deleted until the next event or reconcile puts it back (subscribers see delete then put). The conformance normalizer drops `0`, `'0'`, `''` and `false` on both sides. A 20 ms loop-gap test depends on the machine. Start order in `main.ts` is not under test. The Reconciler and Watcher are not stopped at shutdown (process exits).
- **Live check:** L-S2.3-a.

### R-S2.4-1: Execution entity shape
- **Kind:** deviation.
- **What:** `Execution` uses `google.protobuf.Struct` for `state` and `definition`; S4.2 replaces them with typed fields. `commitExecution` runs only on engine events, so a snapshot lacks a task's execution row until its first event (S4.2 must add an `execution.json` parser or an initial commit before the board reads executions from the store). `openTask` calls an optional `SessionHooks.executionChanged(slug)` wired in `main.ts`, not `commitExecution` directly (avoids an import cycle). The fixture `alinery-core/tests/fixtures/parallel-numbers.md` was deleted in S0.6; the test builds the fork and join inline. protobuf-es 2.16 leaves a nested Struct as raw messages in `toJson`; the test converts it.
- **Open:** the "loses its row" test passes whether or not `store.commit([], [key])` runs (mutation survived). The `onEvent` ordering claim ("after apply") is only partly asserted.
- **Files:** `vinculum-daemon/src/domain/executions.ts`, `playbook-engine/test/on-event.test.ts`.

### R-S2.5-1: runtime/ does not exist; DaemonStatus field
- **Kind:** deviation.
- **What:** the plan's `onSessionChange` in `runtime/` is `commitSession` in `main.ts`, which calls `SessionPublisher.changed` in `domain/sessions.ts` and `feed.refresh`. Added `DaemonStatus.watch_exhausted` (the plan listed it only in prose); `host_guard_warning` is always "" until S4.1. `Session.status` changed from a string stand-in to a `SessionStatus` message.
- **Open:** the `main.ts` wiring (startRecordedShell/onExit, Attention watch, `live.delete` in kill, `maybeTitleChat`, `executionChanged`) is not under test; deleting the `commitSession` call at the end of kill kept all six tests green. `main.ts` sets `row.process = "alive"` on attach with no `commitSession` call; the next commit corrects it.

### R-S2.6-1: job queue and child details
- **Kind:** deviation / decision.
- **What:** O24 (b) built: one RPC per job kind (`StartStorageScan`), not a `StartJob` oneof (the 2.1.5 sketch was corrected). `JobKind` lists all four kinds; `Job.result` has only `storage = 11` (backup 10, purge 12, import 13 are reserved for S4.9 and S4.10). One job per kind at a time, kinds in parallel (the daemon serves one repo). Cancel is SIGTERM only, no SIGKILL escalation; a child that ignores SIGTERM keeps its job RUNNING. A job child is `spawnDetached`; if the daemon exits it ends on EPIPE, and a daemon restart drops jobs (the store is in memory; 24 h retention). `StartStorageScan` takes no params; the daemon fills `{repo, appConfig, namespace}`. The TypeScript archived check mirrors only the fields Rust's `Task` requires plus the type of `archived`; S4.9 deletes the Rust.
- **Open (before S4.9):** the child gets the daemon's whole environment (`env: process.env`), where the sketch says an allowlisted `jobEnv()`. Narrow it before backup and purge children handle secrets. No test pins the Rust-produced `StorageInfo` JSON (compared to `alinery-mcp --repo-service storage_info` on one fixture: all 15 fields equal).
- **Files:** `vinculum-daemon/src/jobs/runner.ts`, `jobs/storage.ts`, `rpc/jobs.ts`.

### R-S3.1-1: DaemonStatus gained busy and waiting counts; shell half refreshes on focus
- **Kind:** deviation.
- **What:** `DaemonStatus.busy=6`, `waiting_for_input=7`, `waiting_for_approval=8` (not in the plan) because the repo scope carries no Session rows and HotkeyBar's dot colour had no other source without a poll. The shell half of `useDaemonStatus` (build drift, conflict, repo_busy, host guard) is read on open, on `refresh()`, on a link flip and on window focus, with no timer, so `repo_busy` clearing after another window closes shows up on focus, not within 1.5 s. `idle`, `unknown`, `exited` are 0 and `total` equals `alive`. `live_sessions_in` and the conflict-based live count were deleted with `repo_live_sessions`; a repo with no compatible daemon reads 0 live sessions (the conflict banner and Restart daemon still name the conflict's sessions). `liveSessionsNow` returns 0 only after a 3 s timeout when the daemon is unreachable, so the remove-repo and close dialogs can wait up to 3 s.
- **Open:** no test covers the delta `delete` op in `Replica.apply` (removing the branch kept all 18 tests green).

### R-S3.2-1: session status and attention
- **Kind:** deviation.
- **What:** the file is `src/sync/sessionObservation.ts` (the Accept grep matches `sync/sessionStatus`). `SessionStatus.transport` (field 9) was added. "Repo scope plus session entities" became one task-scope stream per task, or one chat-scope stream per repo for taskless chats, or the session scope for one session. By design, a repo with no compatible daemon shows session dots as loading where they used to show exited, orphaned or interrupted. Attention rule changed from "previous kind was busy" to "previous kind was settled and the kind is a different waiting kind, or busy to idle"; idle to waiting now notifies. Beyond the Build list: the `SessionView.tsx:590` poll, the self-polling branches of `StatusDot` and `KillButton` (`live` is required), the unused `setObserved` handle, and the `entryIsActive` gating went. `useSessionNoticeSnapshot` still refetches the item list every 5 s (S3.5 owns that; done there).
- **Open:** stale comments name the deleted commands (`types.ts:609,651`, `ChatView.tsx:64`, `shared.tsx` near `StatusDot`). The "reconnect snapshot with the same wait raises nothing" test passes without the `previous === current` guard it names.

### R-S3.3-1: transcript stream
- **Kind:** deviation.
- **What:** `WatchTranscriptResponse.controls` (model, thinking, thinking_levels) was added because the old op carried them. The fallback chain is `watchEvents` then a 250 ms poll; the LiveDoc tier is not built. A frame's start index is `next_item - items.length`. `read_chat_omp` was deleted, and with it the chat "load older" path (`loadOlder`, `olderPageState`, `onLoadOlder`), because Vinculum chat `fileStart` is always 0 and the path could not run. `read_session_history` stays. Commit carries `Protocol-Neutral`: a gRPC service is added and a daemon op removed, no `PROTOCOL_VERSION` bump. A same-protocol daemon from before this commit has no `SessionService`, so a pane stays empty until that daemon restarts.
- **Open:** reconnect can leave a streaming item stale. The client resumes with `fromItem = items.length`; if the stream drops while the last item is `streaming:true` and that item completes while the client is away, the client never receives its final content. Fix: resume at the first streaming item's index. No test covers a drop during streaming. `alinery-app/src/test/ompJournal.ts` line 1 names the deleted `read_chat_omp`.
- **Files:** `alinery-app/src/sync/transcript.ts`, `vinculum-daemon/src/runtime/transcript.ts`.

### R-S3.4-1: terminal stream, and a Protocol-Neutral that removes ops
- **Kind:** deviation / judgement call for the user.
- **What:** `open_session` no longer takes `attach_id`, `stream_token` or a Channel and returns once the shell is started; the daemon's spawn, resume and attach ops for a shell only start it. The daemon ops `write`, `resize`, `detach` (and builders, methods, `chat_pty_*`, `channelFrame.ts`, `ipc.onStreamClosed`, `ipc.nextAttachId`, the `session_stream_closed` emit) were deleted. Commit 7a1651e carries a `Protocol-Neutral` trailer although it removes ops and changes op replies; AGENTS.md says `PROTOCOL_VERSION` moves on op-set changes. The same trailer was used for S3.3. A same-protocol daemon from before the commit has no `TerminalService` and its pane stays on its attach error until restarted. The protocol gate accepts it. **You may prefer a bump (26) before release;** nothing is released yet.
- Replay frames keep true offsets (`replayRanges`), so the "next frame starts at offset + data.length" rule has an exception where a terminal query was dropped. Attach without ACT, or `read_only`, is read-only and the credential lacking ACT is tested by a fake context (no credential in code yields VIEW alone). `TerminalDrawer`'s cd-here button writes through `writeTerminal` (its busy state was dropped). `open_session` no longer routes an attach to a session's old lane socket. The O8 "today's path" baseline is a re-creation of the old op path inside `terminal.bench.ts`, not the old code; 74 of 2,000 samples per run were never matched to an echo in either path.
- **Live check:** L-S3.4-a, -b, -c.

### R-S3.5-1: remote open_session lost its GetTask gate (WA)
- **Kind:** decision (working assumption) / regression.
- **What:** the Rust `RepoOp::GetTask` gate (draft, archived and pre-v2 checks) that a remote `open_session` used is gone with the 8 board-read variants. A remote `open_session` now relies on the daemon's `get_task_execution`, which does not enforce those checks. **WA:** the daemon preflight in S4.3 must own the gate; until then a remote draft or archived task may open a session the local path would refuse.
- **Options:** keep `GetTask` as a repo-service op until S4.3 (rejected: it would re-add a board-read variant S3.5 deletes by plan); add the gate in the daemon now (rejected: it belongs with S4.3's task preflight).
- **Reverse / close:** S4.3 adds the preflight; add a test there that a draft, archived and pre-v2 task cannot open a session on a remote repo.
- **Files:** `alinery-app/src-tauri/src/session.rs` (remote branch of `open_session`), plan 4.1 `S3.5 build (v0.9)`.

### R-S3.5-2: board derivation moved to the daemon; Rust tests deleted
- **Kind:** deviation.
- **What:** `current_column_key/title` were never filled by Rust, so Kanban cannot show a card changing columns; the "card moves on a delta" vitest runs on Grid (groups by `current_phase`) with the real fake daemon (`Grid.streams.test.tsx`). The Rust current-step and board derivation and the Rust `board` conformance runner are deleted (R3); the board fixtures are checked by bun only (case-count threshold is 11), so "on both sides" in the Accept line holds for the task domain only. About 36 Rust board and activity tests were deleted with their subject; 4 bun activity tests added. Not ported: the draft-autosave `updated` case, relationship-cycle rejection, the bound-manager variants. `useChanges` deps bug fixed (`[replicas]`); `sessionsError` and `combineLoadWarnings` removed; an inactive Grid no longer pauses (streams are live). View tests use the `src/test/boardHooks.ts` fake seam. The wire-surface commit carries `Protocol-Neutral` because repo-service ops are not daemon ops.
- **Follow-up:** the relationship-cycle rejection and bound-manager variants should be re-added with S4.3 / S4.8; list them there.
- **Live check:** L-S3.5-a.

### R-S4-pre-1: S4.x working assumptions for the unattended run
- **Kind:** decision (rule).
- **What:** where S4.x sessions find an architecture gap, they choose the plan's WA, else the most conservative and reversible choice, and append an entry here. Nothing is stopped for approval. README text goes in section H.

### R-S4.1-1: the shell creates only `.alinery/`; the daemon's `EnsureReady` does the rest
- **Kind:** decision (working assumption) / behaviour change.
- **What:** `ensure_repo_ready` in the shell shrank to `ensure_alinery_dir` (`paths.rs`): it creates `.alinery/` so the daemon has a place for its sockets, and nothing else. After `attach_repo_daemon_locked` has set the daemon it calls `daemon_rpc::ensure_repo_ready`, which sends `RepoService.EnsureReady` (ADMIN, idempotent) for a local repo and, through `ensure_remote_repo_ready`, for a remote one. The daemon then creates `.gitignore`'s task-data entry, `harnesses.toml` and `config.toml`. A remote repo now gets all three at attach; before it got `config.toml` on its first settings read and the ignore entry only when a task was created.
- **Consequence:** if no daemon answers (a `DaemonConflict`, a refused attach), those files are not created at `set_active_repo`. The failure is logged as `app.ensure-ready-failed` and the repo still opens. `harnesses.toml` is newly created by `EnsureReady` (the core `ensure_harnesses_toml` helper in `shared.rs` is deleted with its only caller).
- **Options:** keep the Rust `ensure_repo_ready` as a fallback when no daemon answers (rejected: that is the second copy S4.1 exists to remove, and D7 says a repo without a daemon shows only its banner).
- **Reverse:** restore the old `ensure_repo_ready` body in `paths.rs` and drop the `daemon_rpc::ensure_repo_ready` call in `daemon.rs`.
- **Files:** `src/paths.rs`, `src/daemon.rs`, `src/daemon_rpc.rs`, `src/remote.rs`, `vinculum-daemon/src/rpc/settings.ts`, `vinculum-daemon/src/domain/settings.ts`.
- **Live check:** L-S4.1-b.

### R-S4.1-2: remote repos read their effective settings from the host's rendered `app.toml`; telemetry is copied whole
- **Kind:** decision / privacy-relevant.
- **What:** the global tier of a remote repo's `settings/_/repo` is the host's `app.toml` as `render_remote_app_toml` writes it (an allowlist), so the Mac's own global settings no longer reach a remote Settings view unless that allowlist carries them. `render_remote_app_toml` now copies `[telemetry]` whole (`enabled`, `prompted`, `install_id`, `endpoint`), as the plan says (O17 c), so a remote daemon sends `settings.change` under this Mac's install id and consent. Its doc comment ("the host records no events under this install") changed with it. Per O25 (b) the telemetry ingest credential ships inside the daemon, so a remote host that runs the daemon holds it (see section H).
- **Options:** keep blanking telemetry on the host (rejected by the plan text of S4.1).
- **Reverse:** blank the section again in `render_remote_app_toml`; the host's daemon then finds no consent and sends nothing.
- **Files:** `src/remote.rs` (`render_remote_app_toml`, `src/tests/remote.rs`).
- **Live check:** L-S4.1-d.

### R-S4.1-3: the telemetry sender, its source name and the `--app-version` flag
- **Kind:** decision.
- **What:** `platform/telemetry.ts` sends records with `source: "alineryd"` (the Rust enum already had `Alineryd`) and `app_version` taken from a new `--app-version` argument that `alinery-core::daemon_command` adds to every daemon it builds. A daemon started without the flag (an older app) reports `"unknown"`. The send is one `fetch` with a 2 s `AbortSignal.timeout`, not awaited, errors dropped. Consent is read from `app.toml` on each send, so a change applies without a restart. Only `settings.change` with scope `repo` moved; global `SettingsChange` and the other repo-less events stay in the shell. The Rust and TypeScript records are compared through the `telemetry/` conformance fixtures.
- **Files:** `vinculum-daemon/src/platform/telemetry.ts`, `alinery-core/src/daemon_client.rs`, `alinery-core/tests/conformance.rs`, `scripts/tests/check-telemetry-privacy.sh` (now scans the daemon TypeScript).

### R-S4.1-4: PROTOCOL_VERSION 26
- **Kind:** decision.
- **What:** `SettingsService` and `RepoService` are new services and `settings/_/repo` a new entity on the same unreleased wire, and `daemon_command` gained an argument, so `PROTOCOL_VERSION` moved 25 to 26 (`protocol.rs` and `main.ts` `PROTOCOL`; `check-protocol-version-bump.sh` passes). A daemon of protocol 25 is not reused by the new app (`ensure_daemon` matches protocol and identity); replacing it is the usual confirmed restart. The golden fixture `proto/golden/admin.json` gained `EnsureReadyRequest`. `audited_shutdown_protocol` (`alinery-core/src/daemon_client.rs`) is a list of protocols whose JSON `shutdown` op is audited; it did not include 26, so the first full `check.sh` failed `tests::daemon::takeover_rejects_invalid_and_compatible_targets_before_shutdown` (a protocol-26 peer was refused as unaudited). 26 is added, with its test. **Every later protocol bump must add its number to that list and to `legacy_dialect_and_unknown_impact_are_distinct` in `alinery-core/tests/daemon_takeover.rs`**; `check-protocol-version-bump.sh` does not catch it.
- **Files:** `alinery-core/src/protocol.rs`, `vinculum-daemon/src/main.ts`, `proto/alinery/v1/settings.proto`, `proto/alinery/v1/entities.proto`.

### R-S4.1-5: how the daemon reads the three files
- **Kind:** deviation / follow-up.
- **What:** (1) The daemon parses `app.toml` leniently: it checks only the sections it reads (`notifications`, `github`, `defaults`, `backup`, `harnesses`, `telemetry`); sections it never reads (`updates`, `power`, `experiments`, `grid_views`, `model_favorites`) are not checked, so a file that Rust's serde would refuse because of one of those is accepted by the daemon. (2) `BUNDLED_PLAYBOOK_KEYS` in `domain/settings.ts` is a hard-coded copy of the bundled playbook keys (a legacy `defaults.playbook = "<key>"` is bundled only for these); a test keeps it equal to `alinery-app/src-tauri/playbooks/`, and it is the third list of bundled keys after Rust and the playbook registry. (3) Reads of the three files are synchronous so a write between two reads cannot split a row. (4) `config.toml` bytes come from `Bun.TOML.stringify` with each table in the Rust struct's key order (the plan's WA); golden cases written by Rust pin them.
- **Follow-up:** when `app.toml` moves to the daemon (it stays in the shell by plan), check the unread sections too.
- **Files:** `vinculum-daemon/src/domain/settings.ts`, `vinculum-daemon/src/serde.ts`, `alinery-app/src-tauri/conformance/settings*/`.

### R-S4.1-6: the optimistic overlay (`src/sync/overlay.ts`)
- **Kind:** decision.
- **What:** the overlay holds overrides plus the fields a write set. A cleared override is not predicted: the view shows the global value when the daemon's row arrives, because computing it locally would be a second copy of the precedence. A layer ends when the replica's epoch changes or its cursor reaches `Applied.cursor.seq`; an error drops it at once. A second write while the first is still pending sends no `expected_revision`, because the revision the first one produces is not known yet (a stale one would refuse a write the user made in order). `SettingsConflict` (ABORTED) toasts "these settings were changed elsewhere; showing the newer values" and the row replaces the layer. Settings, CreateTask, ReviewHandoff, Onboarding and App read the entity through `readRepoSettings` / `readEffectiveConfig` (a one-shot read, 3 s timeout) or `useRepoSettings`.
- **Reverse:** none needed; the old commands are gone (R-S4.1-7).
- **Files:** `alinery-app/src/sync/overlay.ts`, `sync/settings.ts`, `sync/mutation.ts`, `views/Settings.tsx`.

### R-S4.1-7: what was deleted, and what stays on purpose
- **Kind:** deviation from the Exit line.
- **What:** deleted: `read_config`, `read_config_for_repo`, `read_scoped_settings_for_repo`, `read_repo_overrides_for_repo`, `write_repo_overrides_for_repo`, `clear_repo_override_for_repo`, `write_config`, their `ipc.ts` wrappers, `RepoOp::WriteRepoOverrides`, the shell's `write_overrides`, `scoped_for`, `ensure_config_toml` and `emit_repo_settings_change`, and the TypeScript precedence copy in `sessionControls.ts` (`smol-toml` no longer imported there). **Kept:** `RepoOp::ReadRepoOverrides`, with a new `remote_github_token` in `settings.rs`, because the remote GitHub import runs in the shell with this Mac's credentials and needs the host's `[github] token` override (S4.10 owns imports; the Exit line says `ReadRepoOverrides` goes). Also kept in `alinery-core`: `write_repo_overrides`, `clear_repo_override`, `read_scoped_settings_strict` and `resolve_effective_config`, which the mcp, the playbook-library tests and the conformance runners still call; `write_repo_overrides` is the byte reference for the TypeScript writer, so it stays while the golden cases run.
- **Reverse / close:** S4.10 deletes `ReadRepoOverrides`, `remote_github_token` and the core reference writer once imports read the entity or the daemon.
- **Tests removed with the code:** the live remote test for `read_overrides`/`write_overrides` became a test of `remote_github_token` (host override over global); the Rust command tests went with their commands; frontend tests moved to `fakeSettings` (`src/test/settingsHooks.ts`). `Settings.general.test` no longer shows a fictional `repoGlobal` with `keep_awake: true`: the repo scope mirrors the global read, as the view now does.
- **Files:** `src/settings.rs`, `src/imports.rs`, `src/lib.rs`, `alinery-core/src/repo_service.rs`, `alinery-app/src/ipc.ts`.

### R-S4.1-8: environment note for the daemon's tests
- **Kind:** follow-up.
- **What:** `vinculum-daemon/node_modules/alinery-proto` holds one symlink per generated file, so a new `proto/gen` file (here `settings_pb`) was not importable in the daemon's tests until I linked it by hand in this worktree. A fresh `bun install` should create the link; I did not run one to confirm (unverified).
- **Files:** `vinculum-daemon/package.json`.

---

## D. Dustin's PR #154 comments (dtdannen, 2026-11-05): dispositions

The comment asked the plan to make the execution mechanism explicit. Dispositions, as folded into the plan in 80c5ddc and 33d3754:

1. **The standalone engine is the execution authority.** Accepted. S4.2 integrates `playbook-engine` (scheduling, input binding, completion permission, output acceptance, recovery decisions) and ports no `execution.rs` transitions: the O14 trace found they have no production caller, so they are retired with their tests. The daemon supplies task configuration, host safeguards (ownership, locking, durability), persistence and client services. Nothing re-implements the engine's rules in `domain/executions.ts`.
2. **Recovery is two things, kept apart.** Accepted. Execution recovery is everything needed to reopen a swarm from disk: `execution.json` holds the engine state and, per execution, the engine-session to agent-session association and `execution_id` on every engine session; a restarted daemon reopens an execution from disk alone, never from a surviving engine process. Agent-session recovery is the harness's (Pi restores agent context); the daemon hands it the stored session id and rebuilds no context.
3. **History and per-step file states.** Accepted as O27 (WA b/c). The sync changelog is an in-memory ring (a sync mechanism, not history), so it is not history. Per step, a manifest of consumed and published files (path, size, sha256, role) goes into `execution.json`, and the bytes go into a content-addressed `objects/` directory under the execution's output directory. Steps that produce a git worktree record a tree or commit under a ref. The user decided the open parts: R-USER-7.
4. **No swarm fork and no full replay.** Accepted as a boundary: the requirement is that exact consumed and published artifacts survive later modifications and a restart, not re-running.
5. **The graph lineage that reads the engine log keeps working.** Accepted. The session-graph lineage (`graph.ts:335`, base commit c5a5109) reads persisted state instead of the log; its tests keep passing. An existing `engine.jsonl` is converted once at first open; the log file is never read or written again.
6. **P0 to P3 need no change.** S2.4's `onEvent` hook, S0.6's locked `addExecution` and the in-memory changelog all stand.
7. **Tests** in S4.2 (four-step fork and join, change an artifact a finished step had consumed, publish a later step, restart: the first step's manifest still lists the original sha256 and the bytes read back) and S4.5 (`BlobRef` resolves under `executions/<eN>/objects/`, read-only). Not built yet.

---

## E. Known flaky tests

### R-FLAKE-1: `tests::daemon::a_repo_being_closed_is_not_respawned_by_attach`
- **Kind:** flaky.
- **What:** asserts attach returns in under 500 ms. Under full-workspace load it failed once with "returned before any spawn attempt" during S3.5; it passed in 3 of 3 isolated reruns and in the later `check.sh --quick`. S3.5 did not touch the test or the code it exercises. Rerun it alone before treating a failure as a regression:
  `cd alinery-app/src-tauri && cargo test -p alinery-app --lib -- tests::daemon::a_repo_being_closed_is_not_respawned_by_attach`
- **Update 2026-11-05 (S4.1):** failed again in the first full `check.sh` of S4.1 (the same run also failed the real S4.1 regression above); passed alone on the rerun. It then failed in three full `cargo test -p alinery-app --lib` runs in a row. **Cause found:** the 500 ms is spent in `current_alineryd_socket_path` -> `alineryd_socket_namespace` -> `resolve_alineryd_path` -> `daemon_in`, which calls `read_dir` on `target/debug/deps`; after many builds in one worktree that directory held 145,273 files (142,436 of them stray `*.o`), and under the parallel load of the whole lib suite the listing took 550 to 690 ms (measured with a temporary `eprintln!` on `started.elapsed()`: `attach_repo_daemon` itself took 1.3 us, `repo_daemon` 5 us). After `find alinery-app/src-tauri/target/debug/deps -name '*.o' -delete` (2,837 files left) the full lib run passed. So the flake is a function of the size of `target/debug/deps`, not of S4.1 code. **If it recurs on a long-lived worktree, delete the stray `.o` files first.** The product-side hazard is real but small: `daemon_in` lists the whole executable directory (in a release app that directory is small).
- **Follow-up:** widen or drop the 500 ms wall-clock bound.
- **Files:** `alinery-app/src-tauri/src/tests/daemon.rs:518`.

---

## F. Unverified claims

Everything below is claimed by the plan or a Status line but has not been observed. The matching live-check id is given.

- The webview bridge works in a real WKWebView and WebKitGTK (raw `ipc::Request` body, `Channel`, streamed `Response`): L-S1.2-a, -c, -d.
- No stream is left open on window close: L-S1.2-b.
- The Accept `buf curl` lines against a daemon the app started (they ran only against a hand-started daemon): L-S1.1-a.
- The x64 Linux accept-time peer check and the x64 Linux watcher: L-S1.1-b, L-S2.3-a.
- The hardened runtime accepts `bun:ffi` (and so the fsync Worker): L-S0.5-a, L-S2.2-a.
- The Linux runtime builds and the live remote tests pass (not run: no zig when written): L-S1.3-a, -b, L-S2.2-b.
- The frozen-admin-wire gate (O23) skips today because no release tag has `proto/`; it is exercised only against synthetic repos (`admin_wire_frozen_test.sh`). The real `buf breaking` path against a real tag is unproven until a tag exists.
- O8 through the Rust bridge and a real ssh forward: L-S3.4-a.
- The cause of the 20 to 26 ms loop gaps while `F_FULLFSYNC` runs on the Worker: not isolated (4.2).
- `Bun.TOML.stringify` stays in Bun's API: guarded by the S4.1 golden test (not built).
- The S0.6 claim that the full `check.sh` passed: only `--quick` was re-verified.

---

## G. Plan text that is stale or wrong today

Edit the plan, or let S5.4 do it.

- S1.4 Exit: "the old `shutdown` op is unused by the shell" is false (R-S1.4-1).
- Plan table near line 1053 lists `RESTORE_BACKUP` for a remote restore; the code sends `STOP_REMOTE` (R-S1.4-1).
- S3.5 Accept and Tests say task and current-step conformance pass "on both sides" and "in cargo and bun"; board cases are bun-only (R-S3.5-2).
- AGENTS.md (S5.4 rewrites): "the three origins above" (the Daemon section lists five); "`shutdown` senders stay on the four-name allowlist" (the gate allows five); "The daemon's in-memory `vt100` emulator is reattach truth" (`terminal.ts` sends the scrollback tail; no vt100 frame); the `libalinery_core` ownership library (gone in S4.11); the module table (`daemon_rpc.rs`, from S1.2); "A daemon this app cannot use ... its board reads through the repo service" (false after S3.5, D7).

---

## H. Suggested README text (README.md is human-edited; nothing here edits it)

- `README.md:77` names the daemon `alineryd`; it is Vinculum (`alinery-vinculum-daemon`) on this branch.
- `README.md:87` says task, session and board browsing, and artifact listings, work while the daemon is offline, incompatible, or owned by another app instance, without starting one. After S3.5 that is no longer true (D7): a repo without a connected, compatible daemon shows only its banner until the daemon is connected or restarted. The paragraph needs rewriting.
- After P5, the architecture description could say that the per-repo daemon is the application and the desktop app is one of its clients.
- After S6.2, the getting-started text could describe the setup screen: a local repository, or an ssh remote and then a repository on it.
- After S5.2, the remote-host requirements no longer need Rust, zig or cross-compilation; the host only needs the Bun binary the app installs (O15 b).
- Telemetry: remote hosts that run the daemon hold the shared telemetry ingest credential (O25 b, R5). If the README describes the telemetry privacy model, say so.
- After S4.1, the daemon creates `.alinery/config.toml`, `.alinery/harnesses.toml` and the task-data ignore entry when a repository is first opened (local or remote), and it sends the repository-settings telemetry event itself. A remote host's daemon sends it under this Mac's install id and consent (R-S4.1-2).
