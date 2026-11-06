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

### R-S4.2-1: the engine block is opaque JSON to Rust
- **Kind:** decision (provisional).
- **What:** `TaskExecutionState` gains `engine: Option<serde_json::Value>`, so every remaining Rust writer (S4.3, S4.8 and S4.11 own them) reads the file whole and writes the block back unchanged. Rust never interprets it.
- **Options:** a typed Rust mirror of the engine `State` (a second schema to keep in step, against rule 2); a separate file for the engine state (O14 b says `execution.json` is the one truth).
- **Why:** smallest diff that keeps one file and loses nothing across a Rust write. Covered by the interop test in `executionStore.test.ts` (100 rounds of TypeScript saves, manual records, Rust reads and Rust provisioning of other tasks; see R-S4.2-12 for what it does not reach) and by the Rust test `a_state_the_daemon_wrote_reads_in_rust_and_a_rust_write_keeps_the_engine_block`.
- **Reverse:** drop the field and the block is lost on the next Rust write; do not.
- **Files:** `alinery-core/src/execution.rs`, `alinery-core/tests/fixtures/ts-engine-state.json`.

### R-S4.2-2: how the engine's records and the Rust-shaped records share `execution.json`
- **Kind:** decision (provisional).
- **What:** `saveEngineState` rewrites the file's `executions` and `occurrences` maps from the engine State (so Rust readers such as artifact projection still see the engine's executions) and keeps records it did not write. It tells them apart by id shape: engine ids are `e<N>`, `seed/<role>` and `e<N>/<role>`; Rust's are UUIDs. Paths inside the `engine` block are stored relative to the task directory and made absolute on load, so a repository moved on disk still resolves (the O14 trace's absolute-path problem). The `EMPTY_ENGINE` block marks a task this daemon has handled, so `loadEngineState` does not mistake it for O21.
- **Why:** Rust readers did not have to change. **Risk:** a Rust record whose id matches the engine shape would be overwritten; Rust ids are UUIDs, so it cannot happen today.
- **Files:** `vinculum-daemon/src/domain/executionStore.ts`, `executionProjection.ts`.

### R-S4.2-3: O21 tasks are `history_only` and the views disable approve and start
- **Kind:** decision (provisional; O21 itself is user-decided).
- **What:** records the old Rust runner wrote, with no `engine` block and no `engine.jsonl`, load as `history_only`: never opened, seeded or launched. The entity carries `history_only`, and `SessionView` computes `executionAvailable` false for it, so the Approve and "Start this queued session" buttons are disabled. The entity equals the records on disk (tested). **Needs a person:** L-S4.2-b.
- **Files:** `executionStore.ts`, `rpc/executions.ts`, `SessionView.tsx`, `TaskDetail.tsx`.

### R-S4.2-4: `engine.jsonl` conversion
- **Kind:** decision (provisional).
- **What:** a task with `engine.jsonl` and no `engine` block is folded once and saved (`converted`); the log is never written again and its bytes are unchanged afterwards. Nothing deletes it.
- **Files:** `executionStore.ts`. `rg -n 'appendLog|readLog'` over the daemon and engine sources finds only the conversion read.

### R-S4.2-5: O27 history objects and archive
- **Kind:** decision (O27 is user-decided; this is how it was built).
- **What:** each execution keeps `executions/<execId>/objects/<sha256>` as a clone where the filesystem has one, else a plain copy, never a hard link, with no size cap (a 200 MB file is tested). The object is named by the hash of the copy, so it is always the bytes its name says. A coding step records its working files as a tree under `refs/alinery/executions/<execId>` (`manifest.worktree`); the first build only had the engine hook, and R-S4.2-10 wires it. Archive prunes `objects/` Rust-side (`prune_execution_objects`, called from `archive_task_guarded` in `subtask.rs`, under the task lock) and keeps the manifests, so a pruned object reads as `pruned`, not `missing`.
- **Not done:** the archive prune is tested in Rust only, not through a running daemon (L-S4.2-c).
- **Files:** `playbook-engine/src/history.ts`, `alinery-core/src/execution.rs`, `alinery-core/src/subtask.rs`.

### R-S4.2-6: serving stored file states to the UI is not built
- **Kind:** deviation.
- **What:** the History Accept line is met at the manifest level: the first step's manifest lists the original sha256 and size after the live file changed and the daemon restarted. No RPC returns the stored bytes yet. The plan's `BlobService.ReadBlob` (blobs.proto, in the Part 2 sketch) is the natural carrier; `findObject` in `history.ts` is ready for it. Left for the session that builds blobs.
- **Reverse / close:** add the `BlobRef` kind for an execution object over `findObject`.

### R-S4.2-7: `execution_tests.rs` cases dropped, and why
- **Kind:** deviation.
- **What:** 12 of the 53 cases are dropped (the table in 4.1): non-UTF-8 directory entries and wildcard-member disappearance (they guard Rust's listing; the engine lists a family once per acceptance), case-folded role directories and reserved-namespace overwrite (there is no reservation step), manual-reservation input smuggling (manual reservation went with the transitions), the `999`-collision limit (engine ids are an unbounded `e<N>` counter), and six explicit-launch-choice cases (the production resolver, `executionModel` in `graph.ts`, has no explicit choice or harness check; its four precedence cases are in `graph.test.ts`). If you want any as engine rules, each is a new rule, not a port.
- **Files:** `alinery-core/src/execution_tests.rs`.

### R-S4.2-8: protocol 27, and `uiAuthorized`
- **Kind:** decision.
- **What:** `ExecutionService.AllowCompletion` and the new entity fields are a wire change: `PROTOCOL_VERSION` 27, with `audited_shutdown_protocol` accepting 27 (R-S4.1-4). The `uiAuthorized` helper in `main.ts`, used only by the removed allow path, is gone; the `ui_control` op and its secret check stay.
- **Reverse:** none.
- **Files:** `alinery-core/src/protocol.rs`, `vinculum-daemon/src/main.ts`, `proto/alinery/v1/executions.proto`.

### R-S4.2-9: test races found in the full run
- **Kind:** flaky (fixed).
- **What:** the first full `check.sh` of S4.2 failed vitest on a different test in each run, none of them passing alone: `SessionView.test.tsx` "opens queued work without starting it" (the Start button exists but is disabled until the daemon's execution row is pushed, and the test clicked it at once; now it waits for it to be enabled) and two tests in `sync/sessionObservation.test.tsx` (the attention notification fires in a passive effect after the badge text appears; now `waitFor`). The sessionObservation tests were not touched by the engine work; their race is older and shows under load. Five full vitest runs in a row passed after the fix. `check.sh` then stopped at `cargo fmt` (three files), fixed in `9deae66`; the next full run passed (exit 0). `a_repo_being_closed_is_not_respawned_by_attach` (R-FLAKE-1) did not fail in it.
- **Files:** `alinery-app/src/views/SessionView.test.tsx`, `alinery-app/src/sync/sessionObservation.test.tsx`.

### R-S4.2-10: the worktree record is wired through an alinery-core FFI function (review fix)
- **Kind:** decision (provisional) and correction.
- **What:** the first S4.2 build had the engine's `recordWorktree` hook but no caller, so no real coding step recorded anything; R-S4.2-5 overstated it. Now `graph.ts` passes `recordWorktree`, which calls `alinery_record_worktree` in `libalinery_core` (`provision_ffi.rs`) over `alinery_core::git::record_worktree_tree`. It uses `git_cmd` and a temporary index (`GIT_INDEX_FILE` under the git dir), so uncommitted and untracked files are captured and the user's index, HEAD and branch are untouched; the commit is parented on HEAD when there is one; the ref is `refs/alinery/executions/<slug>/<execId>` (it was `<execId>` alone at first, which two tasks of one repository collided on; R-S4.2-15), which `git gc` respects. A directory outside git records nothing; a failure is logged and does not fail the acceptance. `graph.test.ts` accepts a coding step in a real repository and reads the uncommitted edit back from the recorded tree; a mutation that drops the hook fails it.
- **Why FFI and not `Bun.spawn(["git"])`:** `check-git-env-scrub.sh` forbids a git spawn in the daemon until S4.7 adds `platform/git.ts`. **S4.7 should move this onto `platform/git.ts`** and drop the FFI function (plan: S4.7 Build).
- **Open:** (a) the call is synchronous (`git add -A` on a very large tree blocks the daemon loop); (b) the refs are not removed when a task is archived, so the trees stay alive in the repository's object store until someone deletes `refs/alinery/executions/<slug>/*` (the objects under `executions/<id>/objects/` are pruned, the git trees are not) — a follow-up for S4.8 or S4.7; (c) the live check L-S4.2-e.
- **Reverse:** remove the `recordWorktree` option in `graph.ts`; the engine then records nothing, as before.
- **Files:** `alinery-core/src/git.rs`, `alinery-core/src/provision_ffi.rs`, `vinculum-daemon/src/tasks.ts`, `vinculum-daemon/src/graph.ts`.

### R-S4.2-11: a task archived while its engine runs can recreate `objects/`
- **Kind:** known gap (follow-up).
- **What:** the archive prune is Rust-side and tested in Rust only. A daemon engine still running for a task archived mid-run can make `objects/` again through `mkdirSync` in `history.ts` at its next snapshot. Nothing guards it. Left open; the cheap guard is for the daemon to skip snapshots once the task is archived, which needs the archive state in the engine's options. Keep L-S4.2-c.

### R-S4.2-12: the interop test does not interleave a Rust writer on the same task
- **Kind:** unverified claim (corrected).
- **What:** in the 100-round test the Rust provisioning calls create other tasks and `suggestSessionName` only reads, so no Rust write hits the same task's `execution.json` between TypeScript saves. That a Rust write keeps the `engine` block is covered by the Rust test with a TypeScript-written fixture, not by interleaving. The plan note was reworded to say so. A real interleave needs an FFI entry that rewrites an existing task's file (for example the `auto_approve_all` toggle); S4.3 adds that toggle to the daemon and can add the test then.

### R-S4.2-13: what `revision` means across writers (review fix)
- **Kind:** correction.
- **What:** the plan said the daemon's `revision` is bumped by every writer. `saveEngineState` and Rust's `mutate_execution_state` did; `addExecution` did not, and now does (`executionStore.test.ts`). `AllowCompletion`'s `expected_revision` is compared with the sync store entity's revision, not the file's, so it sees a write only after the store has noticed the change, and `expected_revision` 0 skips the check. The note says so.

### R-S4.2-14: input snapshots (review fix)
- **Kind:** decision and known limit.
- **What:** the consumed inputs are now copied and hashed before `harness.start` (and before `resume`), not after, so the agent cannot touch an input first (`persistence.test.ts`: a launch that edits the ticket leaves the recorded hash unchanged). The copy and hash are still synchronous (`copyFileSync`, `readSync`), so a very large input (the 200 MB case) holds the daemon loop for its duration; async streams are the follow-up. A launch that then fails leaves an unused object behind, which archive prunes.
- **Also:** `saveEngineState` now writes the `engine` block and the Rust-shaped maps from one deep copy of the state taken before it waits for the lock (`executionStore.test.ts`).
- **Files:** `playbook-engine/src/engine.ts`, `playbook-engine/src/history.ts`, `vinculum-daemon/src/domain/executionStore.ts`.
- **Also:** `playbook-engine/test/persistence.test.ts` used `require` in an ES module, which fails under Node 26's `node --test` but works under Bun (the gate); now an import.

### R-S4.2-15: the second S4.2 review round: ref uniqueness, pruning paths, Struct, lineage wording
- **Kind:** correction and deviations.
- **Ref collision (major, fixed).** Engine execution ids are per task (`e1`, `e2`), refs are shared by every worktree of a repository, so a second task's coding step moved the first task's `refs/alinery/executions/e1` and the first task's recorded tree could be collected. The ref is now `refs/alinery/executions/<slug>/<execId>`, the slug is passed through `alinery_record_worktree`, and the temporary index file name carries the slug too. Tests: `git.rs` (two tasks, same exec id, both trees survive `gc --prune=now`) and `graph.test.ts` (two coding tasks in one repository through the daemon). The existing graph test used one task, so it could not see this. S4.7's cleanup deletes `refs/alinery/executions/<slug>/*`.
- **Archive pruning paths (minor, fixed).** `prune_execution_objects` ran only in `archive_task_guarded`. Sub-task finalize and kill-descendants also set `archived = true`; both now prune too (`subtask.rs`, `prune_archived_objects`). There the archive is already written, so a prune failure is logged and does not undo it (`archive_task_guarded` still returns it). Tested in Rust for both paths. Not exercised through a running daemon; L-S4.2-c stays open and now also covers a finished sub-task.
- **Save lock test (minor, fixed).** `executionStore.test.ts` holds the task-mutation lock from a Rust process, calls `saveEngineState`, asserts the file is untouched for 400 ms and lands within 100 ms of the release. Replacing the lock with a plain promise fails it. The `writeDurable` fsync is still not tested (a crash test would need a machine-level fault); unverified.
- **Struct deviation (recorded).** S2.4 and the old ledger line said S4.2 would replace the entity's `google.protobuf.Struct` `state` and `definition` with typed fields. S4.2 kept the Structs and put `history_only` inside them (R-S4.2-3), because the engine block is opaque JSON to Rust (R-S4.2-1) and typed fields would have had to track it. Reverse: add typed fields in `proto` and the fold, a wire change that needs a PROTOCOL_VERSION bump.
- **Lineage wording (corrected).** The Lineage Accept line now says what the test does: a killed and restarted run equals an uninterrupted run on the new code. It was never compared with the removed log-based projection.
- **Interop wording.** The plan line now says Rust provisions other tasks only (R-S4.2-12).
- **Snapshot failures (minor, fixed).** `snapshotOccurrence` now logs a failed copy or hash to stderr; the record still has no `sha256`, which is how a reader tells the input was not captured. A step still accepts when a snapshot fails (the record documents the step, it does not gate it). Test: `persistence.test.ts`.
- **Completion race (minor, fixed).** `requestCompletion` awaits `recordWorktree` for coding steps; after it the engine re-checks `receipt` and `status`. A duplicate request now returns the existing receipt without a second `accepted` event, and an execution that failed or was marked exited meanwhile is rejected instead of being accepted over its failure. The fold already ignored a second `accepted`, so the duplicate was harmless to state; the status case was a real hole. Test in `persistence.test.ts` fails without the re-check.
- **Files:** `alinery-core/src/git.rs`, `provision_ffi.rs`, `subtask.rs`, `vinculum-daemon/src/{tasks,graph}.ts`, `executionStore.test.ts`, `playbook-engine/src/{engine,history}.ts`, `playbook-engine/test/persistence.test.ts`.

### R-S4.3-1: what the daemon owns, and the shape of the task API
- **Kind:** decision (the plan named the commands; the shape is mine).
- **Decision:** `TaskService`, `DraftService` and `BlobService` (`PROTOCOL_VERSION` 28). Every write carries `MutationMeta`; renames, archives, restores, approve-all and related-task writes take `expected_revision` (0 skips the check). The reply to a create carries the stored task and the cursor it applied at, and the frontend's `pendingTasks.ts` shows the card through the same `Overlay` until the replica passes that cursor.
- **Options:** (a) the one above; (b) the frontend waits for the delta (the card appears late); (c) invent a second "created" entity.
- **Why (a):** it is the pattern S4.1 and S4.2 set and the vitest line asks for it.
- **Reverse:** drop `pendingTasks.ts` and wait for the stream; no wire change.
- **Files:** `proto/alinery/v1/{tasks,blobs,entities}.proto`, `vinculum-daemon/src/{domain,rpc}/*`, `alinery-app/src/sync/{tasks,pendingTasks,board}.ts`.

### R-S4.3-2: the pre-archive backup is blocking (the WA)
- **Kind:** decision (provisional, until S4.9) and a behaviour change.
- **Decision:** the frontend calls the shell command `pre_archive_backup`, then `TaskService.ArchiveTask` only when it returned `Ok`. The old best-effort queued backup became a blocking one: a backup that is switched on for archive and fails now stops the archive and shows the error (the plan's Test and Accept asked for that). Nothing configured or the trigger off: `Ok`. For a remote repo the host runs it and applies its own gate. The command first calls `ensure_task_can_archive`, so an archive the daemon would refuse leaves no backup behind.
- **Options:** (a) the above; (b) keep the queued best-effort backup and archive regardless (breaks the Accept line); (c) build the backup job now (S4.9 owns it).
- **Reverse:** S4.9 moves the backup into `ArchiveTask` and deletes `pre_archive_backup` and the `ipc.preArchiveBackup` call.
- **Files:** `src/backup.rs`, `src/ipc.ts` (`preArchiveBackup`), `src/sync/tasks.ts` (`archiveTaskForRepo`), `src/archiveTask.ts`, `src/sync/tasks.test.tsx`.

### R-S4.3-3: the `ReadAttachmentImage` variant stays until S4.5
- **Kind:** deviation from the Exit ("the 14 variants are gone").
- **What:** an attachment read by name goes through `BlobService.ReadBlob`. The same wire variant also resolves an artifact-tree `node_id`, which S4.5 moves. Removing it now would break the tree's image preview.
- **Reverse / close:** S4.5 deletes the variant and `ipc.readAttachmentImage`.
- **Files:** `alinery-core/src/repo_service.rs`, `src/sync/tasks.ts` (`readAttachmentBytes`), `AttachmentPreview.tsx`.

### R-S4.3-4: staged-upload lifetime and the 128 MiB message limit
- **Kind:** decision.
- **Decision:** an upload to the staging area lives in `.alinery/tmp/uploads/<id>`; the daemon clears that directory at start (a restart drops unfinished uploads), a rejected commit deletes its file, and a create releases the ids it claimed (also on failure). A draft's pasted images travel as bytes inside `WriteDraft` and are read back through `BlobService.ReadBlob`, so the daemon's grpc receive size is raised to 128 MiB; a draft over that is refused by the transport.
- **Options:** (a) the above; (b) upload draft images as blobs too (more calls, a second staged kind); (c) keep the grpc default (4 MiB) and break large pastes.
- **Reverse:** raise or lower the limit in `rpc/server.ts`; (b) is additive.
- **Files:** `vinculum-daemon/src/{domain/blobs.ts,rpc/server.ts}`.

### R-S4.3-5: stale `draft-attachments.json` after promotion, and the other file-level choices
- **Kind:** decision.
- **Decision:** when a draft is promoted to a task the daemon deletes the draft's `draft-attachments.json` (the old code could leave it behind, so the task kept a `draft/` row). Names are checked with `safeComponent` (no `..`, no separator, not absolute) and a colliding attachment name gets `-2`..`-99` before the extension, as `unique_attachment_name` did. A related task must be on this machine (absolute repo path), as before.
- **Reverse:** remove the delete in `domain/tasks.ts`.
- **Files:** `vinculum-daemon/src/domain/{tasks,taskFiles,blobs}.ts`.

### R-S4.3-6: `open_session` preflight and the hosted refresh
- **Kind:** decision.
- **Decision:** the shell no longer reads the session meta. The frontend passes a `harness` hint to `open_session` (for the hosted-model refresh that has to happen before the daemon opens a session), and the real gate is the daemon's `openPreflight` in the attach/spawn/resume path: a task session needs a v2 task that is neither a draft nor archived and a product harness; a session outside a task opens only as the no-harness drawer. This closes the gap S3.5 recorded (the remote `open_session` lost its Rust `GetTask` gate).
- **Options:** (a) the above; (b) keep a shell meta read (breaks "the shell reads no meta file").
- **Reverse:** read the meta in `session.rs` again.
- **Files:** `vinculum-daemon/src/{domain/openPreflight.ts,main.ts}`, `src/session.rs`, `alinery-app/src/SessionTerminal.tsx`.

### R-S4.3-7: `attachment_path` is local-only; the remote reveal action is hidden
- **Kind:** decision (the plan says exactly this).
- **What:** `attachment_path` stays a shell command for a local repo. For a remote repo (`filesAreRemote()`), the attachment click and the preview's reveal button do nothing and the button is hidden; the daemon never hands out a path. `AttachmentPreview` takes an optional `repoPath` and reads the image through `BlobService`.
- **Files:** `src/artifacts.rs`, `AttachmentPreview.tsx`, `views/{TaskDetail,SessionView}.tsx`. The `remote-local-only.txt` entry for `attachment_path` stays.

### R-S4.3-8: `TaskCreate` telemetry is never sent from Rust
- **Kind:** decision.
- **What:** the daemon sends `task.archive`, `task.draft_create` and `task.draft_delete` (source `alineryd`) from `rpc/tasks.ts`. Rust defined a `TaskCreate` event but never emitted it, and the daemon does not either. The Rust emissions for the three and `src/tests/telemetry.rs` are gone; the shell keeps `BackupCreate` for the pre-archive backup. Conformance fixtures `telemetry/{task_draft_create,task_draft_delete,task_archive_no_id}` check the daemon's events against what Rust emitted.
- **Files:** `vinculum-daemon/src/rpc/tasks.ts`, `conformance/telemetry/*`.

### R-S4.3-9: `WorktreeExists` is a TaskService RPC
- **Kind:** deviation (an RPC the plan did not list).
- **What:** whether a task's recorded worktree is still on disk can change outside the app and no stream sees it, so `TaskDetail` asks. `WorktreeExists` (VIEW) answers from `task.md`'s `worktree` and the filesystem; an unknown task is NOT_FOUND. The Tauri `worktree_exists` command is gone.
- **Reverse:** put the bit in the Task entity's board block (the daemon would have to watch the directory).
- **Files:** `proto/alinery/v1/tasks.proto`, `rpc/tasks.ts`, `src/sync/tasks.ts`.

### R-S4.3-10: Rust app tests removed, and where the coverage went; the live remote tests
- **Kind:** deviation (reduced Rust coverage).
- **What:** about 34 Rust app tests of draft, attachment, rename, archive, restore and duplicate wrappers were deleted with their wrappers (`src/tests/{task,session,git_ops,remote}.rs`, `telemetry.rs`). The core functions they ended in still exist for the MCP and `provision_task`, and keep their core tests. The new path is covered by `rpc/tasks.test.ts`, `domain/taskCreate.test.ts`, `platform/git.test.ts`, `domain/openPreflight.test.ts`, the `task_create` and `telemetry` conformance fixtures (read by both the Rust runner and bun) and `sync/tasks.test.tsx`. The `live_*` remote tests were edited so they compile (their attachment seed is a UTF-8 file written through `WriteFile`); they were not run (no sshd): L-S4.3-f.
- **Files:** see above.

### R-S4.3-11: draft conformance fixtures were not added
- **Kind:** deviation from the Tests line ("conformance from the `task_drafts.rs` tests").
- **What:** `task_create` has three cases (`plain`, `attachments_and_evidence`, `duplicate_names`) with `after/` trees; the draft cases are covered by the daemon test `a draft is written, shows its images through the entity and ReadBlob, and is deleted whole` and by the two draft telemetry fixtures. A draft's `after/` tree holds a base64 image whose bytes the Rust runner compares as UTF-8 text, so I left it out rather than loosen the runner.
- **Reverse:** add `conformance/task_draft/*` and let the runner compare `draft-attachments.json` as JSON.

### R-S4.3-12: `alinery-mcp` still creates tasks over the legacy `create_task` op
- **Kind:** decision (the plan: "stays on core under the flock until S5.1").
- **What:** the first cut dropped the daemon's `create_task` op and the Rust artifact test and MCP tests found it (`unknown-op`). The op is back in `main.ts`; it parses the Rust `CreateTaskRequest` JSON, writes inline base64 attachments to a scratch directory under `.alinery/tmp/wire-<id>`, runs the same `provisionTask` plus session reservation as `CreateTask`, removes the scratch, and answers the JSON `CreateTaskReply`. A non-empty `parent_task` is refused (`create_subtask` owns that). `alinery_provision_task` the FFI is gone regardless. S5.1 deletes the op with the MCP's core calls.
- **Files:** `vinculum-daemon/src/{main.ts,rpc/tasks.ts}`, `alinery-core/src/daemon_client.rs` (comment), `rpc/tasks.test.ts`.

### R-S4.3-13: `PROTOCOL_VERSION` 28 and the shutdown dialect
- **Kind:** note. The wire gained three services on the RPC socket; `audited_shutdown_protocol` accepts 28 (the `shutdown` op is unchanged). Hosts on protocol 27 show the daemon-conflict banner until restarted from it.
- **Files:** `alinery-core/src/{protocol,daemon_client}.rs`, `vinculum-daemon/src/main.ts`.

### R-S4.3-14: environment and gate notes
- **Kind:** note. `check.sh` run from a shell without node on PATH fails at the first step (`npm: command not found`); use the PATH line at the top of the live-checks file. The daemon fs-writes gate rejected a plain `writeFileSync` for the MCP scratch file; it uses `writeAtomic`.
- **Suggested README text (not edited):** after S4.3 the README's task-creation paragraph could say that tasks, drafts and attachments are created by the repo's daemon, so a repository on another machine creates them on that machine; and that archiving waits for a configured pre-archive backup and is refused when the backup fails.

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

### R-S4.4-1: the agent's tool name `alinery_set_session_name` stays
- **Kind:** deviation from Accept line 1 (`rg -n 'alinery_set_session_name|suggestSessionName' alinery-app/src-tauri` finds nothing).
- **What:** `suggestSessionName` and the Rust naming FFI are gone; naming is `setSessionName` in `domain/sessionOps.ts`, reached by `RenameSession` and by the daemon's own tool. The string `alinery_set_session_name` is the name of the tool the Vinculum agent calls (`naming.ts`, `main.ts`, `mcp.ts` `BUILTIN_TOOLS`, the customizations text in `vinculum_customizations.rs`). It is a tool name inside a prompt, not a Rust or FFI function, and agents already running (and their sessions' stored prompts) use it.
- **Options:** (a) keep the name; (b) rename the tool and the prompt text, breaking a running agent's call.
- **Why (a):** the plan's intent (naming moves to the daemon) is met; renaming a tool the model has seen buys nothing.
- **Reverse:** rename in the five files and bump the daemon prompt; no wire change.
- **Files:** `vinculum-daemon/src/{naming,main,mcp}.ts`, `src/vinculum_customizations.rs`.

### R-S4.4-2: `FinalizeSessionMessageActions` and `PrepareReviewApprovalPrompt` are deferred to S4.5
- **Kind:** deviation (provisional).
- **What:** the plan's S4.4 row lists them, but both read and write artifact comment and review state (`artifact_review_pending`, the review markdown), which S4.5 moves. They remain `RepoOp` variants and the commands `finalize_session_message_actions` and `prepare_review_approval_prompt`. The other 8 session and all 12 chat variants are gone.
- **Why:** moving them now would split the review state between two owners for one session.
- **Reverse:** none needed; S4.5 deletes them.
- **Files:** `alinery-core/src/repo_service.rs`, `src/session.rs`.

### R-S4.4-3: `ReadHistory` without a window returns the replay bytes, not a rendered screen
- **Kind:** behaviour change (provisional, accepted at S3.4).
- **What:** Rust drew the tail's final screen with a `vt100` emulator and sent that frame. The daemon returns the scrollback tail with terminal queries removed (the bytes an attach replay sends); xterm draws them to the same screen and keeps its own scrollback. A windowed read (`offset` and `limit`) is byte-exact and is the conformance case; the tail is not compared with Rust.
- **Files:** `vinculum-daemon/src/domain/history.ts`, `alinery-core/tests/conformance.rs` (`history`).

### R-S4.4-4: `ArchiveSession` stamps, refreshes the store, then stops the process
- **Kind:** decision (the plan's 2.3.4 rule 2).
- **What:** the meta is stamped `archived`, the store is refreshed so the stamp is a put in the stream, and only then does the runner stop the process, so a subscriber sees `archived` before the exit. The reply says whether a live process was stopped (`killed_live`), and `session.archive` telemetry carries it. A session that is not running is archived all the same. Tested at the file level (`domain/chat.test.ts`, the metadata read at the moment of the stop) and through the service (`rpc/sessionWrites.test.ts`). The live half, with a real Terminal, is L-S4.4-a.
- **Files:** `vinculum-daemon/src/rpc/sessions.ts`, `domain/sessionOps.ts`.

### R-S4.4-5: a chat thread is a root session plus a `ChatThread` entity; the chat scope is `chat/*` and `session/_/*`
- **Kind:** decision (the plan said "entities in the chat scope"; the shape is mine).
- **What:** the thread is the root Vinculum session (`generic: true`, harness `vinculum`; an older `omp` row is still a thread). Beside it `ChatPublisher` keeps `chat/_/<id>` with the branch label, whether the thread uses the checkout, and whether another thread continues it (`superseded`). A refresh recomputes the thread and the one it continues, and there is a 30 s pass for branch changes made outside. The frontend rail (`chatThreadsOf`) joins the two rows, leaves out a superseded thread and an archived one (unless asked), and sorts pinned first, then newest. Worktrees are `.alinery/chat-worktrees/<id>` on `chat/<id>`.
- **Files:** `proto/alinery/v1/entities.proto`, `vinculum-daemon/src/domain/chat.ts`, `alinery-app/src/sync/chat.ts`.

### R-S4.4-6: `Session.attention_label` carries the notification text
- **Kind:** decision.
- **What:** the plan says the Session entity gets the attention body. The entity carries the label (the task's name, else the slug, else empty) and the frontend composes `<label> — <reason>` (`attentionBody` in `shared.tsx`), so the text is not stored per reason. `notify_session_attention` receives the finished body and only shows the OS notification. The Rust `session_attention_body` and its `RepoOp` are deleted; its coverage is the daemon's label test and `shared.test.ts`.
- **Files:** `proto/alinery/v1/entities.proto`, `vinculum-daemon/src/sync/parsers/*`, `alinery-app/src/{shared.tsx,sync/sessionObservation.ts}`.

### R-S4.4-7: the `chat: true` header on the turn controls
- **Kind:** decision.
- **What:** `chat_prompt`, `chat_abort`, `chat_set_model` and `chat_set_thinking_level` keep using the legacy JSON-lines ops (the plan gives them to no S4 session). `DaemonClient::chat_*` (`alinery-core`) marks them `chat: true`, and the daemon refuses an id that is not a chat thread, as the Rust `load_root_omp` check did before the op reached the daemon.
- **Files:** `alinery-core/src/daemon_client.rs`, `vinculum-daemon/src/main.ts`.

### R-S4.4-8: `PROTOCOL_VERSION` 29
- **Kind:** note. The wire gained `SessionService` writes, `ChatService`, two `BlobService` targets and two entity changes. `audited_shutdown_protocol` accepts 29 (the `shutdown` op is unchanged). Hosts on 28 show the daemon-conflict banner until restarted from it. The remote runtimes need a rebuild before the live remote tests mean anything.
- **Files:** `alinery-core/src/{protocol,daemon_client}.rs`, `vinculum-daemon/src/main.ts`.

### R-S4.4-9: hosted-model refresh stays in the shell
- **Kind:** decision (the plan table: "hosted refresh stays in the shell (S4.11)").
- **What:** the refresh writes the credentials the daemon reads at spawn, so it must run in the app before a chat is created or started. The new command `prepare_hosted_inference(model)` runs it (`refresh_hosted_inference_before_open`), and `createChatThread` and `startChatThread` in `sync/chat.ts` call it before the RPC. A model that is not hosted makes it a no-op. S4.11 replaces the command with a settings write the shell sends.
- **Files:** `src/session.rs`, `alinery-app/src/{ipc.ts,sync/chat.ts}`.

### R-S4.4-10: the legacy JSON-lines ops and the core functions stay
- **Kind:** decision (migration rule 5).
- **What:** `create_execution_session`, `start_session`, `resume` and the other legacy ops stay on the daemon's socket for `alinery-mcp` (its four tools). The `alinery-core` functions `set_session_name`, `read_session_history`, `read_omp_window`, `list_chat_threads_in` and their neighbours stay as the Rust reference the conformance runner calls; they have no app caller left. Delete them with the MCP move (S4.9).
- **Files:** `alinery-core/src/{chat,session_name,history,session_actions}.rs`.

### R-S4.4-11: `open_session` is unchanged; `ResumeSession` is served and unused
- **Kind:** note.
- **What:** the shell's `open_session` still attaches and, for a session with a resume token, resumes through the legacy op (its preflight is S4.3's). `SessionService.ResumeSession` is implemented and tested (`rpc/sessionWrites.test.ts`) but no frontend code calls it; the open path would switch to it when `open_session` leaves the shell.
- **Files:** `src/session.rs`, `vinculum-daemon/src/rpc/sessions.ts`.

### R-S4.4-12: telemetry source for the daemon's session events is `alineryd`
- **Kind:** note. `session.archive` and `session.kill` are sent by the daemon (`platform/telemetry.ts`) with source `alineryd`; the Rust `TelemetrySource::App` sender is no longer reached for them. Conformance cases `session_archive_live`, `session_archive_idle_no_task` and `session_kill` pin the record.
- **Files:** `vinculum-daemon/src/{rpc/sessions.ts,platform/telemetry.ts}`, `conformance/telemetry/*`.

### R-S4.4-13: the open-repos poll is replaced by re-reads, not by a stream
- **Kind:** behaviour change.
- **What:** `list_chat_repos` (which repos Chat may use: open here, daemon attached) was read every 3 s. `useOpenChatRepos` now reads it when the view shows, on window focus, when a remote host connects and when the app's repo list changes. What happens inside those repos arrives by stream. A daemon stopped without a change to the repo list is noticed at the next focus or when the view is shown again, not within 3 s. A stream per repo cannot tell Chat that a repo closed, because a closed repo has no daemon to stream from.
- **Reverse:** call the read from a timer again (Accept 2 forbids it).
- **Files:** `alinery-app/src/sync/chat.ts`, `views/{ChatView,QuickChat}.tsx`.

### R-S4.4-14: tests removed, and where the coverage went; gate and environment notes
- **Kind:** note.
- **Removed Rust app tests** (they called deleted commands): `manual_rename_uses_owned_explicit_repo_without_daemon`, the five `clear_session_notifications_*`, `chat_thread_attachments_land_beside_the_session_and_reject_escape`, the `list_chat_threads`, `set_chat_pinned`, `archive_chat_*`, `remove_chat_worktree_*`, `chat_worktree_follows_*`, `overlapping_resumes_*` and `resume_chat_*` tests in `tests/session.rs`, the two attention-body tests in `tests/notify.rs`, and the session, chat and attention parts of the first live remote test. Their coverage is `domain/{chat,sessionOps,history}.test.ts`, `rpc/sessionWrites.test.ts` and the conformance cases. The live stall test (`live_a_stalled_host_does_not_hold_up_the_command_that_asked`) now asks `list_artifacts` (made generic over the runtime so a mock handle can call it) instead of `read_chat_image`.
- **Removed frontend tests:** the "closed repo's group still reloading" test and the three name-poll timer tests in `ChatView.test.tsx` (replaced by "shows the name the daemon publishes ... never asks on a timer" and the rename tests).
- **Gates:** `check-blocking-commands.sh` lost `archive_session` and `archive_session_for_repo`. The no-kill gate (`.kill(` only in `platform/process.ts`) made the runner's `kill` a `stop`. `check.sh` needs node and bun on PATH (the line at the top of the live-checks file).
- **Flaky test:** R-FLAKE-1 (`a_repo_being_closed_is_not_respawned_by_attach`) did not trip in this session's full `check.sh`.
- **Suggested README text (not edited):** after S4.4 the README's chat paragraph could say that chat threads, their attachments and their worktrees are kept by the repo's daemon, so a thread made in one window shows in every other window on that repo without a refresh, and a repository on another machine keeps its threads on that machine.

### R-S4.4-15: `close_all_repos` keeps writing the exited-session acks in the shell
- **Kind:** deviation from the S4.4 Build bullet ("the exited-session acks become `ArchiveSession` calls"); found by the S4.4 verifier. Provisional.
- **What:** `execute_close_repo_acknowledgment_plan` still calls `acknowledge_exited_session_refs`, which calls `alinery_core::session_actions::mark_exit_notification_read` on each session that was unended when the plan was frozen. It runs after `close_repo_daemon` has shut the daemon down.
- **Why the bullet cannot be met as written:** the ack stamps `exit_notification_read_at` with the `ended_at` the shutdown just produced, so it needs the exit to have happened, and the daemon is gone by then. `ArchiveSession` would be wrong too (it archives the session, which the old ack never did) and `ClearNotifications` needs a daemon to call. The shell also has no Rust gRPC client (the only gRPC path is the webview bridge, `daemon_rpc.rs`). With the daemon stopped there is no second writer, so the direct write has no race.
- **Options:** (a) keep the shell write and record it; (b) make the daemon's `Shutdown` op stamp the checkpoint for the sessions it ends (a wire change, and it would change `stop_daemon`'s behaviour, which acks nothing today); (c) have the webview call `ClearNotifications` after the shutdown against a restarted daemon (absurd).
- **Why (a):** smallest and reversible; no wire change. `close_all_repos` is quit-time only.
- **Reverse / follow-up:** S4.11 (which shrinks `daemon.rs`) decides whether (b) is worth a protocol bump. The test is `tests/session.rs` (the acknowledgment of unended refs).
- **Files:** `src/session.rs`, `src/daemon.rs`.

### R-S4.4-16: follow-ups from the S4.4 verifier
- **Kind:** fix and note.
- **Fixed:** `archiveChatThread` now takes a `stamped` hook that the RPC uses to refresh the thread's rows between the stamp and the stop, so a subscriber sees the archived put before the exit put, as `ArchiveSession` does. `rpc/sessionWrites.test.ts` records the store row at the moment of `stop` for both paths (it fails with the hook removed). `loadChat`'s `generic !== true` clause has its own test (a Vinculum root session with `generic: false` is refused; it fails with the clause removed).
- **Not done:** a real-Terminal `ArchiveSession` against a bun-started daemon without the app. I did not build one (the daemon's real runner needs the host setup `main.ts` does, and no existing test starts it), so the real run stays L-S4.4-a.
- **Accept 1 and the two `RepoOp`s:** unchanged, R-S4.4-1 and R-S4.4-2.
- **Files:** `vinculum-daemon/src/domain/chat.ts`, `rpc/chat.ts`, `domain/chat.test.ts`, `rpc/sessionWrites.test.ts`.

### R-S4.5-1: artifacts, attachments, comments, drafts and pending marks are per-task entity rows
- **Kind:** decision (the plan: "artifact metadata and comments are entities in the task scope").
- **What:** in the task scope the daemon publishes `artifact/<slug>/<name>` (with `position`, the playbook order, and the `handoffs` records), `attachment/<slug>/<name>`, `comment/<slug>/<artifact>/<id>`, `comment_draft/<slug>/<artifact>/<anchor>`, `review_pending/<slug>/<artifact>` and `artifact_tree/<slug>/<slug>`. The `ArtifactProjector` (`vinculum-daemon/src/domain/artifactProjector.ts`) recomputes a task's rows whenever the watcher reports a change under its `artifacts/` or the comment files, and the daemon's own writes call `Feed.onChanged` so a write is visible before the watcher fires. The scan never sees `artifacts/attachments/` for the artifact rows (attachments are their own rows). The frontend reads them with `useTaskArtifacts(repo, slug)` and keeps the old row shapes (`ArtifactItem`, `ArtifactComment`...), so views changed little.
- **Options:** (a) one `artifacts` entity per task holding a list; (b) per-artifact rows (chosen); (c) leave the scan as a RepoOp. (b) lets a single comment or artifact change be one put and keeps `expected_revision` per row.
- **Reverse:** merge the rows into one entity in the projector and the mappers in `sync/artifacts.ts`; the conformance cases (`artifact_list`, `artifact_tree`, `artifact_comments`) pin the content.
- **Files:** `vinculum-daemon/src/domain/artifact*.ts`, `artifactProjector.ts`, `alinery-app/src/sync/artifacts.ts`, `proto/alinery/v1/{entities,artifacts}.proto`.

### R-S4.5-2: `ArtifactService` writes are ACT calls that settle before they reply
- **Kind:** decision (migration rule on writes; 2.2.7).
- **What:** `AddComment`, `SaveCommentDraft`, `DeleteCommentDraft`, `SendReview`, `ClearReviewPending`, `PrepareCommentsPrompt`, `PrepareReviewApproval`, `FinalizeMessageActions`, `InstallReviewHandoff`, `RecordOutboundHandoff` all take a `MutationMeta`, write, refresh the task's rows, and reply with `Applied{cursor}`; the frontend then waits with `whenReaches(replica, cursor)` (exported from `sync/execution.ts`) so a view that shows the result of a write sees it. A draft save may carry `expected_revision`; a stale one is ABORTED, which `sync/artifacts.ts` turns into `ArtifactConflict`. The two prompt calls are ACT, not reads, because they stamp the pending review state they hand back.
- **Files:** `vinculum-daemon/src/rpc/artifacts.ts`, `rpc/artifacts.test.ts`, `alinery-app/src/sync/artifacts.ts`.

### R-S4.5-3: `ReadBlob` for artifacts, tree nodes and step objects
- **Kind:** decision and note.
- **What:** `BlobService.ReadBlob` takes three more targets: `artifact` (task, name), `artifactNode` (task, node id; the tree's id maps to a file under the task) and `stepObject` (task, execution id, sha256). Frames are at most 64 KiB (`ARTIFACT_FRAME_BYTES`, WA; other blob targets keep `CHUNK_BYTES`, 256 KiB), so a 20 MB file is about 320 frames. A symlink on the way, or a node that stopped being a regular file, is PERMISSION_DENIED (`DomainError("permission_denied")`, mapped in `rpc/errors.ts`) in `artifactFiles.ts`, `artifactTree.ts` and the step-object resolver. A step object whose bytes were pruned (archive, O27) answers NOT_FOUND with the message "pruned". The frontend assembles frames in `readArtifactText`, `readNodeText`, `readNodeBytes` and `readStepObject`.
- **Files:** `vinculum-daemon/src/rpc/blobs.ts`, `domain/blobs.ts`, `rpc/artifacts.test.ts`, `alinery-app/src/sync/artifacts.ts`.

### R-S4.5-4: three differences from the Rust scans, each deliberate
- **Kind:** deviation (small, listed so the conformance cases are read with them in mind).
- **1. The execution-driven artifact list.** `listArtifactsWithExecution` (`domain/artifactList.ts`) is a line-for-line port of `list_artifacts_with_execution_metadata`, but the Rust function was handed a `TaskExecutionState` that the Rust loader had validated, including the playbook definition identity recorded in `execution.json`. The TypeScript projector passes the records as the engine holds them (`getTaskExecution`, S4.2) and performs no identity re-check of its own. If the two ever disagree the list is built from the engine's state. Provisional: say so if you want the check ported.
- **2. `pendingStatus` deletes a stale pending file on read.** The Rust `artifact_review_pending_status_for` already removed a pending marker whose artifact hash no longer matched; the TypeScript projector does the same inside the scan, so a read has a side effect on disk. Kept so the conformance case (`artifact_comments/lifecycle`) stays identical on both sides.
- **3. The projector keeps the previous rows when a part cannot be read.** A comment file that is mid-write or unreadable (a half-written JSON) leaves the task's old comment rows in place and logs, rather than publishing an empty set that every window would show as "all comments deleted". The next change event tries again.
- **Files:** `vinculum-daemon/src/domain/artifacts.ts`, `artifactProjector.ts`, `conformance/artifact_*`.

### R-S4.5-5: the review handoff is orchestrated by the frontend across two daemons
- **Kind:** decision (the plan: "review handoff and send become one daemon command each"; not met literally, a handoff needs two).
- **What:** a handoff moves a review between two repos, each with its own daemon. The page (`sendReviewHandoff` in `sync/artifacts.ts`) reads the source artifact's text from the source's `ReadBlob`, calls `InstallReviewHandoff` on the target's daemon (which writes `review-handoff-NNN.md`, the inbound record, and starts the target session), then calls `RecordOutboundHandoff` on the source's. The same-machine rule is checked in the frontend before either call (`sameMachine`, replacing the shell's `same_machine`). The source-archived rule is NOT in the frontend (corrected by R-S4.5-14): the target's daemon reads the source's `task.md` (both repos are on its machine) and refuses before writing anything, and the source's daemon refuses `RecordOutboundHandoff` for an archived source. A cross-machine handoff is refused with "both repositories must be on the same machine".
- **Options:** (a) the target daemon dials the source daemon (a daemon-to-daemon wire we do not have); (b) frontend orchestration (chosen); (c) keep a shell command (not allowed by Exit).
- **Reverse:** (a) needs a peer socket path in the target daemon; the install request already carries `source_text`, so the wire would shrink.
- **Files:** `alinery-app/src/sync/artifacts.ts`, `vinculum-daemon/src/domain/handoff.ts`, `rpc/artifacts.ts`.

### R-S4.5-6: handoff errors are listed, not thrown, after the target has its session
- **Kind:** behaviour note.
- **What:** `InstallReviewHandoff` replies with `started.errors` (the session start) and a separate `errors` list for the inbound record; `RecordOutboundHandoff` failing after the install is not rolled back (the target already has its artifact and session). The page result lists it as an `outbound_handoff_record` error beside the others, which `ReviewHandoffPage` shows, as it showed the shell's partial results. The tests pin this (`artifacts.test.tsx`: "a failed outbound record is listed beside the other errors, and the target keeps its session").
- **Files:** `alinery-app/src/sync/artifacts.ts`, `views/ReviewHandoffPage.tsx`.

### R-S4.5-7: the three telemetry events are sent by the daemon with source `alineryd`
- **Kind:** note.
- **What:** `artifact.comment_add`, `artifact.review_send` and `artifact.review_handoff` (with `target_phase` and `harness`) are recorded in `rpc/artifacts.ts` through `platform/telemetry.ts`. The handoff event is recorded by the **target** daemon, since that is the one that starts the session. The Rust `TelemetrySource::App` senders in the deleted `artifacts.rs` are gone. Conformance cases pin the records.
- **Files:** `vinculum-daemon/src/rpc/artifacts.ts`, `platform/telemetry.ts`, `conformance/telemetry/*`.

### R-S4.5-8: `PROTOCOL_VERSION` 30
- **Kind:** note. The wire gained `ArtifactService`, three `BlobService` targets and the artifact entities. `audited_shutdown_protocol` accepts 30 (the `shutdown` op is unchanged). A host on 29 shows the daemon-conflict banner until restarted from it. The remote runtimes need a rebuild before the live remote tests mean anything. `check-protocol-version-bump.sh` reports 25 to 30.
- **Files:** `alinery-core/src/{protocol,daemon_client}.rs`, `vinculum-daemon/src/main.ts`.

### R-S4.5-9: Show in folder is done in the frontend from `reveal_path`, not by a shell command on a `BlobRef`
- **Kind:** deviation from the Build bullet ("`artifact_node_path` and `artifact_comment_markdown_path_for` become a shell reveal of a `BlobRef`, hidden for remote repos"). Provisional.
- **What:** the daemon already serves `reveal_path` (relative to `.alinery/`). The page asks for the host path of an artifact, a comment file or an attachment from `alineryFilePath` / `attachmentFilePath` (built on the repo path and the slug) and passes it to `revealPath`, which for a remote repo **copies the host path** to the clipboard and otherwise calls `ipc.revealItemInDir`. So no new Tauri command was needed and the three reveal commands (`attachment_path`, `artifact_node_path`, `artifact_comment_markdown_path_for`) are gone. A remote repo is not hidden: the button copies the path, which is what `revealPath` already did for the other views.
- **Why:** a new command would only restate `revealItemInDir`, and the shell would have to keep a repo resolver for it.
- **Reverse:** hide the button where `repoRef(...).kind === "remote"` (one condition in TaskDetail and the tree).
- **Files:** `alinery-app/src/sync/artifacts.ts`, `revealPath.ts`, `views/TaskDetail.tsx`, `ArtifactTree.tsx`.

### R-S4.5-10: the "after an artifact change" auto-backup no longer fires. A known gap until S4.9
- **Kind:** regression, accepted for now; **needs your decision if you want it kept in the meantime.** Provisional.
- **What:** the deleted `artifacts.rs` published `BackupTrigger::PostArtifactChange` (to `publish_auto_backup` locally and `publish_remote_backup` for a remote repo) after comment add, review send, archive of comments and pending clears. The daemon's artifact writes do not publish it; the backup queue is still in the shell until S4.9 ("the backup queue leaves the shell"). The remaining callers of the trigger are `backup_queue.rs` tests. The other two automatic triggers are unchanged. A user who relies on "back up after an artifact change" gets fewer backups until S4.9.
- **Options:** (a) accept the gap until S4.9, which gives the daemon the queue (chosen); (b) a small shell command `publish_post_artifact_backup(repo)` that the frontend calls after the five write calls (about 30 lines, thrown away in S4.9); (c) have `ArtifactService` call back into the app (a wire from daemon to app we do not have).
- **Why (a):** no wire change, nothing to unpick in S4.9, and the trigger is off by default. **Reverse:** do (b).
- **Files:** `src/backup.rs`, `src/backup_queue.rs`, `vinculum-daemon/src/rpc/artifacts.ts`. Check: L-S4.5-e.

### R-S4.5-11: what was deleted, what stayed, and one test seam
- **Kind:** note (the Exit says "the 17 artifact and comment variants, the 25 commands and three pollers are gone").
- **Counts differ from the plan's.** The shell lost **29 Tauri commands** (the 25 artifact ones, plus `prepare_review_approval_prompt` and `finalize_session_message_actions` which S4.4 left for this session, and `read_attachment_image` which S4.3 left) and **20 `RepoOp` variants** (not 17: the plan's list stopped at `SendReviewHandoff` and missed the attachment, tree-node and path variants). The enum, `run()` arms and round-trip test lost the same 20.
- **Kept:** the `alinery-core` functions (`artifact_tree.rs`, `artifact_comments.rs`, the artifact half of `shared.rs`) stay as the Rust reference the conformance runners call and for `alinery-mcp` until S5.1 (same rule as R-S4.4-10). `owned_target` moved into `paths.rs` from the deleted module (other commands use it). `AGENTS.md` lost the `artifacts.rs` module row and `list_artifacts` from the commands list.
- **Test seam:** the stalled-host live test used `list_artifacts` as "a command that must offload"; with it gone it uses `subtask_state`, now generic over the Tauri runtime so the test can call it with a mock handle (`<R: tauri::Runtime>(app: AppHandle<R>, ...)`). No behaviour change.
- **Pollers:** the three pollers (`SessionView.tsx:719`, `:736` and `TaskDetail.tsx:580`) and the finalized-actions refresh are gone. `TaskDetail` keeps one 3 s poll, for `subtaskState`, which is S4.8's.
- **Files:** `src/{lib,paths,session,task,remote,subtask}.rs`, `alinery-core/src/repo_service.rs`, `src/tests/*`.

### R-S4.5-12: draft saves from the UI do not send `expected_revision`
- **Kind:** note. The RPC supports it (Aborted -> `ArtifactConflict`, tested), the hook `useArtifactCommentDrafts` merges the live rows with a local overlay and saves without it, so two windows editing the same draft are last-writer-wins, as before. Turning it on needs a conflict UI the plan does not specify.
- **Files:** `alinery-app/src/useArtifactCommentDrafts.ts`, `sync/artifacts.ts`.

### R-S4.5-13: tests removed, gates, environment and flaky notes
- **Removed Rust app tests** (they called deleted commands): all of `src/tests/artifacts.rs`, the artifact and handoff blocks in `tests/remote.rs` (including the retained-duplicate scratch block), the attachment-image and approval-prompt tests in `tests/session.rs` and `tests/task.rs`, and `retained_duplicate_fixture`. Coverage moved to the daemon (`rpc/artifacts.test.ts` (which also holds the `ReadBlob` and step-snapshot tests)), the conformance cases and `sync/artifacts.test.tsx`.
- **Gates:** no allowlist entry named a removed command; `check-ipc-commands.sh` now counts 132 used of 136 registered.
- **Environment:** a stale debug sidecar (`target/debug/alinery-vinculum-daemon` built before the protocol bump) fails `tests::daemon::two_legacy_owners_require_two_confirmations` with "binary not found beside the app" / a refused attach; `scripts/copy-sidecar.sh debug` fixes it. `check.sh` does that itself. The daemon's `node_modules/alinery-proto` is a copied directory, so after a proto regen run `rsync -a proto/gen/ alinery-app/src-tauri/vinculum-daemon/node_modules/alinery-proto/gen/` before `bun test`.
- **Flaky tests:** none observed in this session (R-FLAKE-1 did not trip).
- **Suggested README text (not edited):** after S4.5 the README's task paragraph could say that a task's artifacts, comments and review state are kept and watched by the repo's daemon, so a comment or an agent-written file shows in every window within a second, and a repository on another machine keeps them on that machine; a review can be sent only to a repository on the same machine.

### R-S4.5-14: verifier fixes after S4.5 (archived source, O_NOFOLLOW, snapshot test)
- **Kind:** fix and deviation.
- **Archived source (major finding, correct).** Before S4.5 core refused when the source or the target was archived; the port checked only the target. Fixed in the daemon, not the page: `InstallReviewHandoff` reads the source's `task.md` with `readTask(req.sourceRepoPath, sourceSlug)` and refuses `FAILED_PRECONDITION` when it is archived, before the evidence file or the session exists; `RecordOutboundHandoff` refuses an archived source on its own daemon. A source whose `task.md` the target's daemon cannot read (missing, or a path it cannot see) is not refused at install, because the existing handoff tests use a nonexistent source path and the source's daemon still refuses its own half. Test: `rpc/artifacts.test.ts` "a review handoff from an archived source is refused...", which fails when the install check is removed (verified by mutation).
- **Options:** (a) a page-side check from the source's task row (needs a replica read before the call and a timeout policy); (b) the target daemon reads the source file (chosen: fail-closed before any write, no new wire); (c) a source-side pre-flight RPC (a wire change).
- **Reverse:** delete the two `archived` lines in `rpc/artifacts.ts`. The plan changelog line "archived-source checks in the page" is superseded by this entry.
- **O_NOFOLLOW (minor, correct).** `regularFileBlob` reopens the file per 64 KiB frame; each open now uses `O_NOFOLLOW` and an `fstat` that must still be the regular file with the lstat's `dev` and `ino`, else `PERMISSION_DENIED`. Tests in `domain/blobs.test.ts` (a link swapped in, a different file renamed over it). A swap to a different regular file used to be served; it is now refused.
- **Snapshot test (minor, correct).** The engine-written case is `domain/executionStore.test.ts` "a step's manifest keeps the bytes it consumed...": it now also reads the snapshot with `stepObjectBlob` after the live file changed and the graphs were reset (a restart). The planted-file test in `rpc/artifacts.test.ts` stays for the link, pruned and invalid-hash cases.
- **Minor (deviations a-e):** recorded already in R-S4.5-5, -9, -10, -12; nothing changed. (c), the `PostArtifactChange` auto-backup trigger that stops firing until S4.9, still needs the user's decision.
- **Wire:** neutral (commit carries `Protocol-Neutral:`).

### R-S4.6-1: the Rust playbook parser, `ReadPlaybookTree` and `ApplyPlaybookTree` are not gone (Exit not met)
- **Kind:** deviation from the plan's Exit line.
- **What:** the plan says the Rust parser, `ReadPlaybookTree` and `ApplyPlaybookTree` go. They stay: the core `playbook.rs` and `playbook_library.rs` are still used by the MCP tools (`alinery_read_playbook`, `alinery_save_playbook`, which the plan keeps on the core path until S5.1) and by the community import registry in the shell (`community_playbooks.rs`), which for a remote repo stages the repo's playbook files through `ReadPlaybookTree` and `ApplyPlaybookTree` (`playbook.rs` `with_library_at`). The two parsers are held equal by the 13 conformance cases (Rust writes `expected.json`, the daemon and the engine compare), so R3's "one implementation per rule" is met for the app and the daemon and is a tested copy for MCP.
- **Options:** (a) delete them now and break the community import for remote repos and MCP; (b) keep them until S5.1 (MCP on the daemon) and S4.10 (the registry in the daemon) delete them (chosen).
- **Reverse / close:** S5.1 deletes the MCP use; S4.10 deletes `with_library_at`'s remote branch, `playbook_tree.rs` and the two `RepoOp`s, then the Rust `playbook.rs` parser and `playbook_library.rs` can go. The live remote test block in `src/tests/remote.rs` that exercises the scratch copy goes with them.
- **Wire:** neutral.

### R-S4.6-2: how the 11 `deny_unknown_fields` structs are covered
- **Kind:** deviation (mapping) and note.
- **What:** `rg -c deny_unknown_fields` counts 11: `PlaybookRef`, `InputSelector`, `OutputSelector`, `NormalizedStep`, `NormalizedPlaybook`, `Metadata`, `StepMetadata` (`playbook.rs`) and `PlaybookRoots`, `SavePlaybookRequest`, `PickerPreferences`, `PickerPreference` (`playbook_library.rs`). The case `conformance/playbook/unknown_fields` has four `parse` steps (a frontmatter, a step, an input selector and an output selector field), three `load_picker` steps (the picker file's top level, one entry and one reference), and six `strict_json` steps (`NormalizedPlaybook`, `NormalizedStep`, `SavePlaybookRequest` twice, `PlaybookRoots`, `NormalizedPlaybook`). In Rust each is rejected by serde; in TypeScript the parse steps are rejected by the engine's parser with a diagnostic naming the field (`typo`), the picker steps by the library's picker decoder, and the `strict_json` steps by the wire message's `fromJson` (which refuses an unknown field and names it). `PlaybookRoots` exists only in Rust (the daemon builds its roots from its own flags and never reads them from a request), so that step is skipped on the TypeScript side and the harness says so in a comment.
- **Known difference:** TOML parsers differ in the words of a syntax error (the `toml` crate and `smol-toml`), so the conformance test compares the code and line of an `invalid_toml` diagnostic and not its message. TOML also makes no difference between `2` and `2.0` once parsed (`smol-toml`), so a float written where the schema wants an integer is accepted in TypeScript and refused in Rust; it is noted in `playbook-md.ts` and no case relies on it.

### R-S4.6-3: the global half of the picker is served by a local repository's daemon, not the shell
- **Kind:** deviation from the plan ("the global half stays with `app.toml` (shell)").
- **What:** the picker's preferences are not in `app.toml`; they are `<app config dir>/playbooks/picker.toml` (global) and `<repo>/.alinery/playbooks/picker.toml` (the repository's), the files `picker_preferences` always used. The shell has no reason to own the first file once the daemon reads and writes the library from the same directory, so `PlaybookService.SavePicker` takes `global` and the rows `playbook/_/picker-global` and `playbook/_/picker` carry the two. A window with a repository selected reads and writes that repository's picker; a window with none uses the global one through the active (else first known) local repository's daemon.
- **Options:** (a) keep the global file in the shell with two commands (the plan); (b) the daemon serves both (chosen: one writer for the directory, and no new shell commands).
- **Reverse:** re-add `read_playbook_picker_preferences` and `save_playbook_picker_preferences` for the global file only and make `savePlaybookPickerPreferences` call them when `repoPath` is empty.

### R-S4.6-4: the machine's playbooks need a local repository to read them
- **Kind:** behaviour change.
- **What:** the bundled and the global (this Mac's `<app config dir>/playbooks`) playbooks are read through a daemon, and the daemon is per repository. With a repository named, that repository's daemon answers; with none (onboarding, Settings with no repo, `Playbooks` with no repo), `libraryHost` takes the active repository, else the first known one that is not an ssh repository. With no local repository, `NoLibraryHost` is thrown ("Open a repository to read the playbook library."); onboarding shows that sentence in the preview's error slot and Retry works once a repository exists. Before S4.6 a fresh install could preview the curated playbooks with no repository. The per-lane daemons of a local repo each read the same global directory (the watcher covers it), so two repos show the same global playbooks.
- **Options:** (a) accept it (chosen: the smallest change, and the setup screen of P6 puts a repository first); (b) compile the five curated definitions into the page for the preview; (c) a machine-level daemon (D-decision, out of scope).
- **Close:** P6's setup screen makes a repository (or a host) the first thing a user adds; L-S4.6-b checks the message.

### R-S4.6-5: a remote repo shows the host's own global playbooks
- **Kind:** behaviour change (follows O12 a for the agent dir).
- **What:** a remote repo's catalog comes from the host's daemon, whose "global" directory is the host's `~/.local/share/alinery-remote/config/<identity>/playbooks`. Before S4.6 the shell staged only the repo's files and read the global and bundled ones on this Mac, so a remote repo showed this Mac's global playbooks. Now it shows the host's. The bundled set is the same on both (compiled into each). Nothing syncs global playbooks to a host (the credentials list is the only thing the app places there).
- **Close:** L-S4.6-a. If users want their Mac's global playbooks on a host, that is a sharing item like the credentials (a later session), not something to copy implicitly.

### R-S4.6-6: the community import registry stays in the shell; deleting a repo playbook forgets its import first
- **Kind:** deviation and a new command.
- **What:** before S4.6 `delete_playbook_source` (shell) removed the file and the registry record in one step on one machine. The daemon now deletes the file and knows nothing of `community-imports.toml` (S4.10 moves the registry). `deletePlaybookSource` (page) for a `repo` reference first calls the new shell command `forget_community_import(repoPath, key)` (`forget_import_before_delete`: a registry that cannot be read stops the delete with its error; no record is a no-op), then the daemon delete. The two are not atomic: if the daemon delete fails after the registry write, the playbook stays and the Community list offers Import instead of Update for it. That is the safe direction (an import can be redone; an orphaned record claims a file that is not there).
- **Reverse / close:** S4.10 moves the registry into the daemon and deletes `forget_community_import`; the page's call goes with it. The command is under `check-remote-routing.sh` and `check-remote-offload.sh` (async, `off_main_thread`, `owned_library`) and both pass.
- **Close check:** L-S4.6-c.

### R-S4.6-7: concurrency and the revision the page sends
- **Kind:** note and deviation (the plan said `save_playbook_if_unchanged` becomes `expected_revision`).
- **What:** the old compare-and-swap compared file bytes the caller held. Now a row's `revision` (the store's commit seq of its last change) is compared. `ReadPlaybook` refreshes the projector from disk first (an edit made outside the app is seen before the compare, test "an edit made on disk is seen before the revision is compared") and returns the row's revision in `ReadPlaybookResponse.revision` (added to the proto for this; field 6). The page (`sync/playbooks.ts`) records the revision of each definition it reads or saves in a module map and sends it as `expected_revision` on a save that sets `overwrite` and on a delete; a save of a new file sends 0 (no check; the daemon's "already exists" conflict covers it); a playbook the window never read sends 0. A catalog read does not record a revision (opening is what counts). The map is per window and is not cleared when a repo is removed (small, keyed by host and row).
- **Not done:** the picker is saved whole and last-writer-wins (revision 0), as before; two windows saving different preferences at once keep the later one. `SavePicker.expected_revision` exists for the day that matters.
- **Tests:** daemon `rpc/playbooks.test.ts` (stale ABORTED with the file untouched, the current revision and 0 go through, two saves of one revision leave one winner, retried mutation answered once); vitest `sync/playbooks.test.tsx` (the revision read is the one sent; a stale refusal reaches the page with "Reopen the playbook"; a tagged invalid error keeps its diagnostics).

### R-S4.6-8: `PROTOCOL_VERSION` 31, the Linux runtime, and the sidecar
- **Kind:** note.
- **What:** `PlaybookService` is a new service on the daemon's grpc socket and the daemon commit bumped `PROTOCOL_VERSION` to 31 (`protocol.rs`, `daemon_client.rs`, `daemon_takeover.rs`); the frontend commit carries a `Protocol-Neutral:` trailer for the `revision` field because it adds a message field and no op. The bundled Linux runtimes must be rebuilt before the live remote tests (L-S4.6-e): `alinery-core`, `mcp/` and `vinculum-daemon/` changed.
- **Environment:** `cargo test -p alinery-mcp` failed 6 `session_tools` tests ("expected value at line 1 column 1") with the sidecar from before this session, because the MCP spawns the daemon sidecar and that one spoke protocol 30; after `src-tauri/scripts/copy-sidecar.sh debug` they pass (7 of 7). `check.sh` runs the script first, so the gate was not affected. Anyone running the MCP tests alone after a protocol bump has to refresh the sidecar.

### R-S4.6-9: smaller things
- **Kanban columns.** `list_kanban_columns` returned a fixed list of four (`research-design`, `planning`, `implementation`, `review`); it is now `src/kanbanColumns.ts` and `Kanban`/`Grid` read it synchronously, so the board no longer waits for a call before drawing its columns. The Kanban and Grid tests used their own column lists (`todo-draft`, `in-review`); they now use the real four, and one navigation test moves across the empty Implementation column.
- **Pre-existing, not fixed:** `playbook-engine` `tsc` reports an error at `engine.ts(187)` (from S4.2). Not part of this session's files; `bun test` passes.
- **Biome:** `npx biome check --write src` reordered imports in files this session touched and nothing else.
- **Unused after the move:** `readPlaybookPickerPreferences` (it only called the catalog) and `RemoteLibrary.stage_repo`/`host_path` and `Library::rehome` (the Rust shell no longer returns paths to the page) were removed; the live remote test block that used `rehome` now compares the files the scratch copy sends back.
- **Flaky:** `tests::daemon::a_repo_being_closed_is_not_respawned_by_attach` passed in this session's full `check.sh` (R-FLAKE-1).
- **Verifier-style check done by hand:** `rg -n 'smol-toml|parseToml' playbook-engine/src` shows the import and one call, both in `playbook-md.ts`.

### R-S4.7-1: the pull-request lookup is mediated by the page
- **Kind:** provisional decision (the plan says the daemon returns branch and remote URL and the GitHub call stays in the shell; it does not say who carries the values).
- **What:** `src/sync/git.ts` `listTaskPullRequests` asks the daemon (`TaskPullRequestInputs`: stored link, branch, `origin`), passes them to the shell command `lookup_task_pull_request(prUrl, branch, originUrl)` (GitHub API with the local token), and writes a link found back with `RecordDiscoveredPullRequest`, which fails with "task branch or PR link changed during lookup" if the stored link or branch moved. The old Rust `list_task_pull_requests` did all three in one command, for local and remote repos alike.
- **Options:** (a) the page carries the values (chosen: local and remote repos take the same path, and the shell needs no client for the daemon's grpc socket); (b) the shell calls the daemon through `daemon_rpc` and the page makes one call (fewer round trips; needs the bridge client in the shell for a repo that may be remote).
- **Reverse:** make `lookup_task_pull_request` take `(repoPath, slug)`, call `GitService` through the bridge, and have `listTaskPullRequests` call it alone. The page code is 30 lines.
- **Files:** `alinery-app/src/sync/git.ts`, `alinery-app/src-tauri/src/git_ops.rs`, `vinculum-daemon/src/rpc/git.ts`, `vinculum-daemon/src/domain/gitActions.ts`.
- **Wire:** `PROTOCOL_VERSION` 32 (R-S4.7-5).

### R-S4.7-2: the backup trigger after a push is a shell command the page calls
- **Kind:** provisional decision, temporary.
- **What:** the Rust push queued an automatic backup (`BackupTrigger::PostPushCommit`) in the same call. The daemon cannot reach the in-process queue (`backup_queue.rs`, S4.9), so `pushAndCompareUrlForRepo` calls `publish_git_backup(repoPath)` after a successful push and ignores its failure (the push already happened). A failed push queues nothing (tested). A remote repo's key goes into the same queue and the host applies its own trigger flags, as before.
- **Options:** (a) the page calls the shell after the push (chosen); (b) leave the backup out until S4.9 (loses the post-push backup for now); (c) the daemon calls back into the shell (no such channel).
- **Close:** S4.9 moves the queue into the daemon; `publish_git_backup`, its `ipc.ts` wrapper and the call in `sync/git.ts` go with it. `commit_worktree` had the same trigger, but nothing in the page called a commit command, so there is no second call site.

### R-S4.7-3: `SetPrUrl` and `CommitWorktree` have no caller
- **Kind:** note and deviation (scope).
- **What:** the plan lists both RPCs and the commands `set_pr_url(_for_repo)` and `commit_worktree(_for_repo)`. `git grep` at the commit before this session finds no use of their `ipc.ts` wrappers in `alinery-app/src`, and nothing in MCP. The RPCs exist (tested, with telemetry for the commit) so the surface the plan names is complete, and `sync/git.ts` has no wrapper for either; the first caller adds one.
- **Options:** (a) keep the two RPCs (chosen: the plan's list, and the daemon is where the next UI or MCP tool would call them); (b) drop them and their tests (smaller; the plan's 8-op list is then 6).
- **Reverse:** delete `SetPrUrl` and `CommitWorktree` from `git.proto`, regenerate, delete the two handlers and `setPrUrl` and `commitWorktree` in `gitActions.ts` with their tests, and bump `PROTOCOL_VERSION`.

### R-S4.7-4: `GitOriginUrl` stays a `RepoOp` (Exit not met in full)
- **Kind:** deviation from the plan's Exit line ("the 8 git variants are gone").
- **What:** 7 of the 8 git `RepoOp` variants are deleted. `RepoOp::GitOriginUrl` stays: the GitHub issue import in the shell (`imports.rs`) reads a repository's `origin` through it for a remote repo, and S4.10 moves imports to the daemon. `GitService.GitOriginUrl` exists on the daemon and is tested (`domain/gitActions.test.ts`, "the origin URL is part of the lookup inputs"), so S4.10 only has to switch the caller and delete the variant. The commit message of the S4.7 commit says "8"; this entry is the correction.
- **Close:** S4.10 deletes `RepoOp::GitOriginUrl`, `git_origin_url` in `repo_service.rs` and its round-trip case.

### R-S4.7-5: `PROTOCOL_VERSION` 32 and the Linux runtime
- **Kind:** note.
- **What:** a new service (`GitService`) on the daemon's grpc socket bumps the protocol to 32 (`protocol.rs`, `main.ts` `PROTOCOL`, `daemon_client.rs`'s dialect list, `tests/daemon_takeover.rs`). The bundled Linux runtimes must be rebuilt before the live remote tests (L-S4.7-e). After a proto regeneration, `bun install` in `vinculum-daemon` is needed to refresh its `node_modules/alinery-proto` copy (daemon tests failed with "Cannot find module alinery-proto/alinery/v1/git_pb" until then).
- **Wire:** the bump is in the same commit as the new service; the protocol gate passes.

### R-S4.7-6: tests moved to TypeScript, not shared with Rust
- **Kind:** deviation from the plan's Tests ("conformance from the `git_actions.rs` tests against a temp repo").
- **What:** the Rust git code is deleted, so a cross-language conformance case would compare the TypeScript with nothing. The `git_actions.rs` and `git_ops.rs` cases that stayed meaningful were rewritten in `domain/gitActions.test.ts` (19, against real temp repositories and a bare remote) and `rpc/git.test.ts` (6); the ones about the Rust-only mechanics (the `git_cmd` env, the Rust `record_worktree_tree`, the `curl` timeout helper) went with the code. The survival of a recorded ref through `git gc --prune=now`, which the Rust test asserted, is asserted in the TypeScript test. The `live_git_actions_run_on_the_host` remote test was cut down to what still exists on the Rust side and renamed rather than deleted. Three telemetry conformance fixtures (`conformance/telemetry/git_commit`, `git_push`, `git_worktree_remove`) are shared with Rust's `conformance.rs` as for the other events.
- **Scrub test:** `platform/git.test.ts` "a GIT_DIR in the daemon's own environment does not redirect a call" (a real child) and "a GIT_DIR in the lookup's environment is absent from the child's".

### R-S4.7-7: the execution refs and `task_activity.rs`
- **Kind:** note.
- **What:** `recordWorktreeTree` (temporary `GIT_INDEX_FILE`, `add -A`, `write-tree`, `commit-tree`, `update-ref refs/alinery/executions/<slug>/<execId>`) replaces `alinery_record_worktree`; the graph calls it in-process and the FFI function and `c_string` are deleted. The archive handler deletes `refs/alinery/executions/<slug>/*` after the archive is applied and logs a failure instead of failing the archive (the task is already archived; a stuck ref is garbage, not state). A slug that is a prefix of another (`task-a`, `task-a-b`) deletes only its own refs (tested). `alinery-core/src/task_activity.rs` (the `repo:slug` key function) lost its only user and is deleted; the same key is `pullRequestKey` in `sync/git.ts`.
- **Reverse:** none planned. Garbage refs from a failed cleanup can be removed with `git for-each-ref refs/alinery/executions/<slug> --format='%(refname)' | xargs -n1 git update-ref -d`.

### R-S4.7-8: smaller things
- **Remote-sshd Accept, as run.** The runtime manifest is empty on this machine (no zig), so the live remote tests could not install the app's runtime. Instead: `run.sh start` (Debian 12, linux/arm64), `docker cp` of the Bun 1.4.3 linux-aarch64 binary and a copy of `platform/git.ts` plus a three-line probe into the container, and over ssh `setsid -f sh -c 'cd ctr && bun probe.ts'`. It printed `git version 2.39.5` through `git()` with the daemon-style PATH `/usr/local/bin:/usr/bin:/bin:/usr/games`. The container was stopped afterwards. `systemd-run --user` was not run (L-S4.7-b).
- **Gates.** `check-daemon-git-spawn.sh` allows only `platform/git.ts` and has its own test (`daemon_git_spawn_test.sh`: exit 0 clean, exit 1 with `Bun.spawn(["git"` added to another daemon file); both are in `check.sh`. The TypeScript block was removed from `check-git-env-scrub.sh` (it is now Rust-only). `check-blocking-commands.sh`'s `git_ops.rs` entry is `lookup_task_pull_request`.
- **Hardening in the port.** The lookup order is the Rust one; `git()` takes `{env, input, strict}`: the execution ref sets `GIT_INDEX_FILE` and the author through `env`, the ref deletion feeds `update-ref --stdin` through `input`, and the source-branch reads use `strict` so a non-UTF-8 ref name is an error and not a lossy string, as in the Rust.
- **Flaky:** `tests::daemon::a_repo_being_closed_is_not_respawned_by_attach` passed in this session's full `check.sh` (R-FLAKE-1).
- **Full check:** `./scripts/check.sh` passed on `e71a4d0` (vitest 135 files, 1695 tests; daemon `bun test` 415 pass).
- **AGENTS.md** gets one gate line and a clause that the daemon's git goes through `platform/git.ts`; S5.4 rewrites the rest.

---

### R-S4.8-1: the manager session's prompt and start were missing from the TypeScript create
- **Kind:** deviation from the plan (it says to port `subtask.rs`; it does not say the daemon's manager branch was a stub) and a fix.
- **What:** since S4.4 the daemon's `subtask_manager` target of the session create wrote a bare session meta: no prompt, no `subtask_slug` binding for a recovery, no start. The Rust shell used to ask the Rust request builder and the core launcher built the prompt, so the page worked through Rust and the TypeScript path was never exercised. `createManagerSession` now writes `{id, worktree, created, harness, model, generic, subtask_manager, subtask_slug?, prompt}` with the two prompt templates (`prompts/subtask-manager*.md`, embedded with Bun text imports), the parent context and the related-tasks pointer, refuses a second live or unstarted manager, validates a recovery's binding (the child exists, its `parent_task` and the parent's `active_subtask` agree), and opens the session when asked. A failed open is reported as `start: "failed"` with a `spawn_failed` error, as the Rust reply did. The `{{NAME}}` fill is single-pass (the Rust used chained `replace`, so a task named `{{PARENT_SLUG}}` was expanded twice).
- **Options:** (a) restore it in `domain/subtasks.ts` (chosen); (b) leave the stub and keep the Rust launcher for managers until S5.1 (two implementations of one prompt).
- **Reverse:** none planned; the Rust `manager_prompt`/`recovery_manager_prompt` in core `shared.rs` still exist and have no caller (see R-S4.8-8).
- **Files:** `vinculum-daemon/src/domain/subtasks.ts`, `domain/taskFiles.ts` (`RELATED_MARKDOWN` exported), `src/tasks.ts`.

### R-S4.8-2: starting a manager is its own RPC
- **Kind:** provisional decision (the plan names state, request and discard, not who builds the session).
- **What:** `SubtaskService.StartManager` creates and starts the manager. A recovery resolves the task's active child on the daemon (`loadRelationships`), so the page and a remote host need no round trip to read it first. The alternative, the page calling `SessionService.CreateSession` with a `subtaskManager` target, would have put the recovery lookup in the frontend.
- **Options:** (a) one daemon RPC (chosen); (b) extend `CreateSession`'s target with a manager arm and keep the lookup in the page.
- **Reverse:** add the arm to `sessions.proto`, have `sync/subtasks.ts` call it, and delete `StartManager`. About 40 lines.
- **Files:** `proto/alinery/v1/subtasks.proto`, `rpc/subtasks.ts`, `alinery-app/src/sync/subtasks.ts`.

### R-S4.8-3: what stays in core `subtask.rs` (Exit met in part)
- **Kind:** deviation from Build (the file is trimmed, not removed) with a close date.
- **What:** `alinery-mcp` calls `inspect_subtask_finish`, `finalize_subtask`, `subtask_manager_owner_slug`, `ensure_task_can_archive` and `archive_task_guarded` directly, and `shared.rs`/`artifact_tree.rs` call `read_task_relationships`. They stay, with the relationship validation, the git state, the snapshot copy and their tests, until S5.1 gives MCP its own path. Removed: `subtask_manager_state`, `subtask_manager_request`, `create_subtask`, `subtask_discard_sessions`, `discard_subtask` (and their helpers and 7 tests), `task_worktree_is_clean`, `Rust SubtaskManagerState`. The four `RepoOp` variants, the four shell commands and `provision_ffi.rs` (the Exit's list) are gone. The legacy `{"op":"create_subtask"}` wire op, which `alinery-mcp` and `DaemonClient::create_subtask` use, is still served, now through `createSubtaskFromWire` and `prepareSubtask` + `provisionTask` instead of the FFI. `alinery_create_subtask` therefore behaves as before for an agent.
- **Close:** S5.1 moves the MCP tools to the RPCs; then `inspect_subtask_finish`, `finalize_subtask`, the guard and the snapshot code go (a `FinalizeSubtask` RPC will need them in TypeScript first, which the plan does not list under any session; S5.1 should add it).
- **Files:** `alinery-core/src/subtask.rs`, `mcp/src/main.rs`, `vinculum-daemon/src/main.ts`.

### R-S4.8-4: the discard's backup is a shell command until S4.9
- **Kind:** provisional decision, temporary (the plan: "its pre-archive backup S4.9").
- **What:** the Rust `discard_subtask` queued a `PreArchive` backup before it started. The daemon cannot reach the in-process queue, so `discardSubtask` in `sync/subtasks.ts` first calls the new shell command `publish_pre_archive_backup(repoPath)` and ignores its failure. It queues (does not wait for) the backup, as the old discard did, and a local repo is gated by this machine's trigger settings while a remote repo's key goes into the queue for the host to gate. `pre_archive_backup` (S4.3, which waits and can refuse) is not reused: it calls `ensure_task_can_archive`, which refuses a parent with an active child, the very state a kill starts from.
- **Close:** S4.9 moves the queue into the daemon; the command, its `ipc.ts` wrapper and the call go with it.
- **Files:** `src/backup.rs`, `alinery-app/src/ipc.ts`, `alinery-app/src/sync/subtasks.ts`.

### R-S4.8-5: tests moved to TypeScript, no cross-language case
- **Kind:** deviation from Tests ("conformance from the core `subtask.rs` tests").
- **What:** Rust no longer creates or discards a child, so no case could be written by Rust and read by the daemon. Each Rust test that created or discarded is a bun test on real temp repositories: dirty parent, bound manager and slug collisions, partial git creation, unbound discard, kill of a nested lineage, inherited and own step models. The kill case asserts the Accept line: the parent's `execution.json` is byte-identical afterwards and `loadEngineState` accepts it, the killed tasks keep their worktrees, branches, sessions and artifacts, and `loadRelationships` still passes. The readers Rust uses on these files are covered by the existing `task` and `session_meta` conformance domains. The Rust inspect/finalize tests stay, with a `link_child` helper that makes the state creation used to leave.
- **Files:** `vinculum-daemon/src/domain/subtasks.test.ts`, `src/rpc/subtasks.test.ts`, `alinery-core/src/subtask.rs` (tests).

### R-S4.8-6: smaller things
- **Hardening in the port.** A discarded setup's files include `.pi.sqlite[-wal/-shm]` (Rust moved only meta, scrollback and name, so a pi-durable setup left its database behind). Manager choice orders by `created` then id, as Rust does, so two managers made in one second can swap; the test backdates one.
- **Dead code removed with the commands:** `task_daemon_for` (its only product caller was the sub-task commands; its assertion in the takeover test went), `publish_remote_backup`, `paths::worktrees_dir`, the test helper `create_task_for_test`.
- **Stalled-host live test.** It polled `subtask_state` to prove an async command waits on the host off the main thread. It now polls `storage_info`, made generic over the runtime for the same reason; the comparison is `repo_path` and `tasks_dir`, since sizes can move.
- **Session routes.** The Rust discard cleared the shell's per-session route cache for the stopped sessions. The daemon does the stopping now, and a route to a session that no longer exists has no reader I found in the page after a kill; nothing replaces the call.
- **`bun install`.** After the proto regeneration, `bun install` in `vinculum-daemon` was needed to refresh its `node_modules/alinery-proto` copy (R-S4.7-5 again).

### R-S4.8-7: `PROTOCOL_VERSION` 33
- **Kind:** note.
- **What:** a new service on the grpc socket bumps the protocol: `protocol.rs`, `main.ts` `PROTOCOL`, `daemon_client.rs`'s shutdown dialect list (the first `check.sh` failed `takeover_rejects_invalid_and_compatible_targets_before_shutdown` until 33 was added there; fixed in 9a2c8a1) and `tests/daemon_takeover.rs`. The bundled Linux runtimes must be rebuilt before the live remote tests (L-S4.8-e).

### R-S4.8-8: noticed, not changed
- **Kind:** note.
- **What:** core `shared.rs::resolve_launch_prompt` and the `manager_prompt`, `recovery_manager_prompt` and `append_launch_context` it reaches have no caller left in the workspace (only the daemon FFI used them). They are public, so the compiler does not flag them. They are the Rust reference for the prompts in `domain/subtasks.ts`; delete them with the rest of the launch-prompt code when S5.1 settles what MCP needs.
- **Flaky:** `tests::daemon::a_repo_being_closed_is_not_respawned_by_attach` passed in this session's full `check.sh` (R-FLAKE-1).


### R-S4.9-1: verify, list and the destination check are unary RPCs, not jobs
- **Kind:** provisional decision (the plan says "backup, verify, storage scan and purge are jobs").
- **What:** `StartBackup` and `StartPurge` (and the earlier `StartStorageScan`) are jobs with a result. `VerifyBackup`, `ListBackups` and `CheckBackupDestination` are unary `BackupService` calls: each reads one small file or directory and answers in milliseconds, the page needs the answer before it asks for a restore, and a job row for each would only add a poll. `VerifyBackup` refuses a path outside the configured destination folder, so a caller cannot make the daemon open an arbitrary file.
- **Options:** (a) unary (chosen); (b) a `VERIFY` job kind with its own row.
- **Reverse:** add a job kind and a result arm, and have `sync/storage.ts` use `runJob`. About 60 lines.
- **Files:** `proto/alinery/v1/backups.proto`, `vinculum-daemon/src/rpc/backups.ts`, `alinery-app/src/sync/storage.ts`.

### R-S4.9-2: the remote restore stays two repo-service ops until S5.2 (Exit met in part)
- **Kind:** deviation from Exit (5 of the 7 `RepoOp` variants are gone) with a close date.
- **What:** gone: `StorageInfo`, `PurgeArchived`, `BackupCreate`, `BackupList`, `BackupCheckDestination`. Kept: `BackupVerify` and `BackupRestore`. A restore has to run while the daemon is down, and a remote host has no one-shot program to run until the host bootstrap (O15, S5.2); `stop_remote_daemon` takes a `while_down` closure that runs the host's restore. I first removed `BackupVerify` too and put it back: a refused remote archive would otherwise have stopped the host's daemon, and its sessions, before saying no. Local restore does not use them (see R-S4.9-4).
- **Close:** S5.2 gives the host a one-shot restore, then both variants and their core functions go.
- **Files:** `alinery-core/src/repo_service.rs`, `src/backup.rs`, `src/remote.rs`.

### R-S4.9-3: core `backup.rs` and `storage.rs` stay for `alinery-mcp` until S5.1
- **Kind:** deviation from Exit (the plan lists `storage_info` and `delete_all_archived_storage`, which are gone from the app; the core code beneath stays).
- **What:** `alinery-mcp`, the restore reader (`read_backup_meta`, `extract_backup_into`), the remote restore and the interop test still use core `backup.rs` (including its `zip`-crate writer) and `storage.rs` (`storage_info_in`, `purge_archived_storage`). Two writers of one archive format exist until then: the daemon's (the host's `zip`) and core's. The interop test (`backup_zip_interop.rs`) keeps them agreeing on the layout (`backup-meta.json` at the root, curated files relative to `.alinery/`).
- **Close:** S5.1 moves MCP's tools to RPCs; then the core writer, `storage.rs` and the Cargo `zip` dependency go, except the reader the S5.2 restore needs.
- **Files:** `alinery-core/src/backup.rs`, `alinery-core/src/storage.rs`, `alinery-core/tests/backup_zip_interop.rs`.

### R-S4.9-4: how a local restore runs without a Rust gRPC client
- **Kind:** provisional decision (the plan: "Restore stays `Shutdown(RESTORE_BACKUP)` then a one-shot restore; the shell still runs it locally").
- **What:** the shell has no gRPC client (`daemon_rpc` is a byte bridge for the page). So the page calls `VerifyBackup` first (it names the archive's repository and refuses a foreign one before anything stops), shows the confirm dialog with the live sessions, then calls the shell command `restore_backup`. The command takes the repository lifecycle lock, sends `Shutdown` with origin `RESTORE_BACKUP`, and runs the daemon program once as `alinery-vinculum-daemon --restore-backup <repo> <archive>`, which prints one JSON line (`restore_outcome` parses it; a program that dies without printing is an error carrying the end of its stderr). The program is the same restore code the daemon would run (`domain/backup.ts` `restoreBackup`), so there is one implementation. The daemon starts again through the normal attach.
- **Options:** (a) the page verifies, the shell restores through the sidecar (chosen); (b) a Rust gRPC client in the shell (large, and S5.x removes the need); (c) keep the Rust restore (two restore implementations, and it reads the new archives only through the `zip` crate).
- **Reverse:** (c) is the old `backup::restore_backup` in core, still present for the remote path.
- **Files:** `src/backup.rs`, `vinculum-daemon/src/main.ts` (`--restore-backup`), `jobs/child.ts` (`runRestoreBackup`), `alinery-app/src/sync/storage.ts`, `views/Settings.tsx`.

### R-S4.9-5: where the daemon publishes the triggers; the artifact trigger fires again
- **Kind:** provisional decision.
- **What:** `BackupHost.publish(trigger)` is called by the daemon after a commit and a push (`rpc/git.ts`), after an artifact change (`addComment`, `sendReview`, `clearReviewPending`, `prepareCommentsPrompt`, the sites that published `PostArtifactChange` in the deleted `artifacts.rs`), and after a sub-task discard (`pre_archive`, as the Rust discard queued it; a task archive runs its own waiting job instead). The 2 s debounce and the per-trigger settings gates live in `jobs/autoBackup.ts` and `backupHost.ts`; the host reads its own `config.toml` and `app.toml`, so a remote repo's backups follow the host's settings. This closes R-S4.5-10 and should make L-S4.5-e pass (L-S4.9-d). The pre-archive backup in `ArchiveTask` is not debounced: it waits for the job and refuses to archive if the job fails, as the S4.3 WA did, now on the daemon side (R-S4.3-2 ends).
- **Files:** `vinculum-daemon/src/jobs/backupHost.ts`, `jobs/autoBackup.ts`, `rpc/git.ts`, `rpc/artifacts.ts`, `rpc/subtasks.ts`, `rpc/tasks.ts` (the pre-archive job).

### R-S4.9-6: the purge is atomic per task, and a backup may outlive its restore
- **Kind:** provisional decision and a known gap.
- **What:** the purge renames a task's directory out to `.alinery/tmp/purge-<id>/` (one rename, so a cancel leaves the task whole or gone), then deletes it, and the next purge run sweeps a tombstone left by a crash. A session still running under an archived task is ended first through the daemon's runner. Gap: a backup job child is a separate process; if a restore starts while one still runs (an automatic backup the page did not see), that child can read a half-restored tree and write a mixed archive. Nothing in the restore checks for a backup child that is still running. Also unexercised by a test: the rollback path of `restoreBackup` when the final placement fails after the old tree was moved aside.
- **Reverse:** have `restore_backup` refuse while `.alinery/tmp` holds a live backup child's pid file (about 30 lines); a test that makes the rename fail.
- **Files:** `vinculum-daemon/src/jobs/purge.ts`, `domain/backup.ts`.

### R-S4.9-7: host tools, the daemon's status field, and the test image
- **Kind:** deviation from Build (D6 and D9: a host tool status).
- **What:** `zip` and `unzip` joined the setup probe list, so a remote host without them is refused at setup with the install hint. A machine whose daemon starts without them (a local Linux box, or a host set up before this build) gets the tool's own spawn error in the job's message; the daemon's host-tool status field and a banner for `zip`, `unzip` and `git` that D6/D9 describe is not built (the plan's WA: leave the message). The `remote-sshd` Dockerfile installs `zip` and `unzip` so the live tests can restore; the stock Debian image has neither.
- **Files:** `src/remote.rs` (probe list), `scripts/tests/remote-sshd/Dockerfile`, `vinculum-daemon/src/platform/zip.ts`.

### R-S4.9-8: `PROTOCOL_VERSION` 34, tests, and environment notes
- **Kind:** note.
- **What:** a new service and new job RPCs bumped the protocol to 34 (`protocol.rs`, `main.ts` `PROTOCOL`, the dialect list in `daemon_client.rs`). The bundled Linux runtimes must be rebuilt before the live remote tests (L-S4.9-c); that was not done here (no runtime bundle on this machine, Docker is arm64 only), so the remote live restore test was written and compiled but not run. The 70,000-file daemon test takes about 15 s of the daemon suite; `ALINERY_KEEP_BACKUP=<file>` keeps its archive for the Rust read. `vinculum-daemon/node_modules/alinery-proto` links per file, so after the proto regeneration `bun install` was needed (or the two new `backups` links by hand), as in R-S4.7-5. Tests removed with the code: `backup_queue.rs`' own, the `backup_now`, `list_backups` and storage cases in `tests/backup.rs`, the remote live storage test, and the daemon slot test. Core Rust zip cases stay with R-S4.9-3. The first `check.sh` failed only `cargo fmt` (532d152) and the second only clippy's unused import (c802aa5).
- **Flaky:** see R-FLAKE-1 for this session's run.

### R-S4.10-1: the issue import stays a prefill; there is no bulk `TaskService.Import`
- **Kind:** deviation from the plan's Build bullet 1 (decided overnight, conservatively).
- **What:** the plan has the shell fetch issues and pass them to a `TaskService.Import` that creates the tasks. The app's import is a prefill: the page fetches one ticket into the New task form and the person creates it through `CreateTask`, which already takes `github_issue`, `linear_id`, attachments and `attachment_errors`. A bulk RPC would be a second way to create a task with no caller. What changed is where the repository's two facts come from. `GitOriginUrl` (S4.7's `GitService.GitOriginUrl`) is a unary call the page makes, and the repository's own GitHub token override is read from its `settings/_/repo` row, so a remote repo no longer needs `ReadRepoOverrides` or a repo-service `GitOriginUrl`. The shell's `import_github_for_repo(repo, reference, origin_url, token_override)` then fetches with this machine's credentials. `None` for the override means the global token applies; `Some("")` is a blank override, as in `resolve_effective_config`. `import_linear` (the unused active-repo twin) is gone. The conformance the plan asks for runs through `CreateTask` (`rpc/tasks.test.ts`, two tests).
- **Options:** (a) prefill, page passes the facts (chosen); (b) build `TaskService.Import` and have the page call it with fetched tickets.
- **Reverse:** add the RPC and have the page call it after a fetch; about 150 lines and a proto change. The telemetry event `import.fetch` is unchanged (the shell still does the fetch).
- **Files:** `alinery-app/src/sync/imports.ts`, `src/imports.rs`, `vinculum-daemon/src/rpc/tasks.test.ts`.

### R-S4.10-2: the package is a `staged` upload, not a `PlaybookPackageBlob`
- **Kind:** provisional decision.
- **What:** the plan (2.1.5) names a `PlaybookPackageBlob` target. `BlobService` already has `staged` uploads that a task create and a skill install name by `upload_id`, and the daemon releases one when the call ends. A new target would repeat that with one more case in `blobs.proto`. The page uploads the document as `<id>.md` (staged) and sends `CommunityPackage{upload_id, version, label, playbook_key}`; the daemon decodes the bytes as strict UTF-8 and releases the upload in a `finally`. The plan's line 521 sketch is therefore not built.
- **Options:** (a) reuse `staged` (chosen); (b) add the blob target.
- **Reverse:** add the target and have `rpc/playbooks.ts`'s `community()` read it. Small.
- **Files:** `proto/alinery/v1/playbooks.proto`, `vinculum-daemon/src/rpc/playbooks.ts`, `alinery-app/src/sync/community.ts`.

### R-S4.10-3: the registry is an entity, and writes check the bytes they replace
- **Kind:** provisional decision.
- **What:** the downloaded list is shown in the library and the editor and was a shell command each time. It is now the `playbook/_/community` row (the registry file's rows plus `local_missing` and `locally_edited` computed from the files), refreshed by the projector, so every window sees a change. The file, `.alinery/playbooks/community-imports.toml`, keeps its format (eight fields, anything else is an error naming the file). Its read-modify-write and the playbook write run under the library's `.mutation.lock` (`withRepoLibraryLock`). Rust checked "edited while the package was fetched" with a compare around the network call; the daemon has no such window, so `savePlaybook` gets the bytes it expects to replace and refuses a mismatch inside the lock (a `conflict` for an import, `edited` for an update). A failed registry write restores or deletes the playbook it had just saved. Breaking: none (same file).
- **Options:** (a) entity plus lock-checked writes (chosen); (b) keep a unary `ListCommunityImports`.
- **Reverse:** drop the projector row and add a unary read. Small.
- **Files:** `vinculum-daemon/src/domain/communityImports.ts`, `playbookLibrary.ts`, `playbookProjector.ts`.

### R-S4.10-4: the library's side of a download row stays in the shell
- **Kind:** deviation from the rule-6 table row (`community_download_status` to the daemon).
- **What:** `community_download_status` joined the registry with a GET of each publication. The daemon now answers the registry half (`playbook/_/community`), and the shell answers `community_remote_status(ids)`, which is the same GET (no bearer) through the shell's one HTTP stack and `accounts_url()`. The page joins them (`sync/community.ts`, `communityDownloadStatus`, same row shape as before). Moving the GET to the daemon needs an HTTP client and the accounts base URL on every host (a host's `app.toml` allowlist, `render_remote_app_toml`) for no secret saved: the request carries no credential. A remote repo's list therefore needs this Mac online to show update badges, the same as the catalog.
- **Options:** (a) shell GET, page join (chosen); (b) a daemon GET with the base URL in the host's `app.toml`.
- **Reverse:** add the field to `render_remote_app_toml`, an `UpdateStatus` RPC and a TypeScript fetch; delete `community_remote_status`.
- **Files:** `src/community_playbooks.rs`, `alinery-app/src/sync/community.ts`.

### R-S4.10-5: O12 (a): where the agent dir is, and what the shell still writes
- **Kind:** the user's decision O12 (a), with the implementer's path choice recorded as provisional.
- **What:** the agent dir is `vinculumAgentDir(appConfig)`, i.e. `<dir of app.toml>/vinculum/config/agent`, owned by the daemon on every host. For this Mac that is the directory the app and the local daemon already share (`vinculum_home_dirs`), so there is nothing to mirror; for a remote host it is `~/.local/share/alinery-remote/config/<identity>/vinculum/config/agent`, inside the layout `render_remote_app_toml` already owns. The user suggested a host-home path such as `~/.alinery/agent`; I did not add a second root on the host because the Pi runtime already reads this directory through `PI_CODING_AGENT_DIR`/`PI_CONFIG_DIR`, and a different path would need a second place those are set. Model roles, the inventory, skill install and delete, and the prompt are daemon RPCs. `ensure_default_model_role` (called by `hosted.rs` after a sync) is still Rust and still writes this Mac's `config.yml`, so there are two copies of the model-role line format (Rust, and `agentDir.ts`). A remote host gets no hosted default role from a sync until S4.11 moves that write. The Finder window and the file picker stay shell commands; the page shows them only when the host is this machine (R-S4.10-6).
- **Options:** (a) as built; (b) `~/.alinery/agent` per host (the user's suggestion).
- **Reverse:** change `vinculumAgentDir` in one place on each side (daemon and `alinery_core::vinculum_home_dirs`) and move the directory; the PI env vars follow it.
- **Files:** `vinculum-daemon/src/domain/agentDir.ts`, `src/omp_update.rs`, `src/vinculum_customizations.rs`.

### R-S4.10-6: which host's directory the Settings page shows
- **Kind:** provisional decision.
- **What:** Settings > Customizations and Providers have no repository of their own, so they ask the active repository's daemon, else the first local repository's (`agentHost`). With a remote repo active they show and edit that host's agent directory and hide Open configuration folder and Show in file manager. A skill picked there is read here (25 MB cap, `read_local_file`) and uploaded to the host. The session view's model dialog names its own repository. If the person expects the Settings page to always mean this Mac, they have to activate a local repo first. `vinculum_customizations` (the live tool and MCP status) is still the shell command for the active repo.
- **Options:** (a) the active repo's host (chosen); (b) always this Mac's directory, with a host selector later.
- **Reverse:** pass a local repo to `agentHost`.
- **Files:** `alinery-app/src/sync/agent.ts`, `views/VinculumCustomizations.tsx`.

### R-S4.10-7: publish reads from the daemon, and the page refuses an invalid playbook
- **Kind:** provisional decision.
- **What:** `publish_community_playbook` takes `{source, key, label}`. The page reads the playbook with `PlaybookService.ReadPlaybook` (for a remote repo, the host's copy) and sends its stored text, so the shell no longer reads a repo. Rust returned `Invalid{diagnostics}` when the stored file did not parse; the page does the same when `ReadPlaybook` refuses with an `invalid` error, before any request. The server still validates. Bytes sent are the stored text (CRLF kept), as before; `publish_sends_stored_text` still checks it. The shell's `publish_desktop_invalid_does_not_call` test has no counterpart in Rust now; the page-side case is `sync/community.test.ts` ("a playbook the daemon calls invalid never leaves this machine").
- **Reverse:** have the shell parse the source (the Rust parser is still in core for MCP).
- **Files:** `src/sync/community.ts`, `src/community_playbooks.rs`.

### R-S4.10-8: removed code, gates, and noticed
- **Kind:** noticed.
- **What:** removed with the code: the Rust import, update, registry and delete tests (their cases are in `rpc/community.test.ts`), `tests/vinculum_customizations.rs` (cases in `domain/agentDir.test.ts` and `rpc/agent.test.ts`), the remote live tests for the scratch-copy library, the origin URL and the GitHub token, `targeted_helpers_do_not_depend_on_active_repo`, and `ActiveRepo` (`require_active_target` now returns `()`; nothing read its fields). `check-remote-routing.sh` lost the dead `owned_active_target(` token. `git_ops.rs` no longer re-exports `git_cmd` (tests import it from core). Noticed and left: `alinery_core::load_repo_overrides_strict` and the Rust playbook parser stay for MCP (S5.1); `alinery-core` model-role code is not duplicated beyond `ensure_default_model_role`.
- **Files:** as listed.

### R-S4.10-9: not run: the remote-sshd Accept line, and `PROTOCOL_VERSION` 35
- **Kind:** unverified claim.
- **What:** the Accept line "a community import into a remote repo writes the playbook on the host" needs the Linux runtime bundle (`resources/remote/manifest.json` has no targets on this machine; no zig) and so a daemon at protocol 35 in the Debian container. I did not build it. What was run: the import against a repo directory by the daemon (`rpc/community.test.ts`, 12 tests), which is the same code that runs on the host, and the page's call (`sync/community.test.ts`). The daemon only writes its own repo, so a remote write cannot reach the local copy; that is the claim L-S4.10-c checks. The bump to 35 is in `protocol.rs`, `main.ts` and the audited-shutdown list in `daemon_client.rs`; the runtimes must be rebuilt (`alinery-core`, `mcp/` and `vinculum-daemon/` changed) before the live remote tests. After the proto regeneration `bun install` was needed in `vinculum-daemon` (as in R-S4.7-5).
- **Files:** `alinery-core/src/protocol.rs`, `vinculum-daemon/src/main.ts`, `alinery-core/src/daemon_client.rs`.

### R-S4.11-1: O9 built as (b), tested on macOS only
- **Kind:** decision (the WA; the plan asked for "a test on both platforms").
- **What:** `platform/keepawake.ts` holds a child that ends with the daemon: macOS `/usr/bin/caffeinate -i -w <daemon pid>`; Linux `systemd-inhibit --what=idle --who=Alinery --mode=block cat` with a stdin pipe the daemon holds. macOS was measured: `pmset -g assertions` lists one `PreventUserIdleSystemSleep` for the child and no `PreventSystemSleep`; `kill -9` of the parent removes it (`keepawake.test.ts` runs this on darwin). The Linux mechanism (a pipe the daemon holds, closed by its death) was tested with `cat` on macOS, with a second child spawned after the hold, so a session's shell does not keep the pipe open. Not run: the real `systemd-inhibit` (the `debian:12` arm64 image has neither it nor logind) and a Linux run of the test file. Two behaviours differ from the Rust: the macOS hold is a second process instead of an in-process IOKit assertion (the Rust comment named that as the risk; `-w` removes it), and a tool that fails is retried after 30 s (the Rust retried every second and deduplicated only the log line).
- **Options:** (a) keep the IOKit FFI (needs a Rust library beside the daemon, the thing S4.11 removes); (b) chosen.
- **Reverse:** `git show 68a5c6a^:alinery-app/src-tauri/alinery-core/src/idle_inhibit.rs` restores the Rust; re-add the `dlopen` in `main.ts`, the `cdylib` crate type and the `ownership/` resource.
- **Files:** `vinculum-daemon/src/platform/keepawake.ts`, `keepawake.test.ts`, `keepawake.fixture.ts`, `platform/process.ts`, `scripts/tests/check-no-auto-session-kill.sh`. Live: L-S4.11-a, L-S4.11-b.

### R-S4.11-2: the first Accept line is read as "no libalinery_core"
- **Kind:** deviation from the Accept text.
- **What:** `rg -n 'dlopen|libalinery_core' vinculum-daemon/src` is not empty and cannot be: `platform/lock.ts` (flock, O6), `platform/fsync-worker.ts` (`F_FULLFSYNC`, O26) and `rpc/peer.ts` (peer credentials) dlopen libc by design. What is true: nothing loads `libalinery_core`, and `rg -n 'libalinery_core|ALINERY_OWNERSHIP_LIB|bun:ffi' src/main.ts src/tasks.ts` and `rg -n libalinery_core` over the daemon source, the app, the scripts and the gates return nothing.
- **Verifier follow-up:** the plan's Accept line was reworded to `rg -n 'libalinery_core|ALINERY_OWNERSHIP_LIB'`, which returns nothing, and notes the libc dlopens.
- **Reverse:** none needed.

### R-S4.11-3: the TypeScript fence reads the fields the daemon uses, not the whole serde shape
- **Kind:** decision (conservative on what it blocks, lenient on what it accepts).
- **What:** `domain/ownership.ts` checks `execution.json` for `version` 1, a positive `max_live_sessions`, a numeric `revision`, string `owning_lane`, `owning_app_config_identity` and `definition_identity`, and records with a known `lifecycle` and a string `owner_session_id`; the retained playbook must match its identity and parse; `task.md` must parse as `parseTask` (the board's reader) does. Rust's `read_execution_state` fails on any field of `TaskExecutionState` that is missing or mistyped. A file that is wrong elsewhere passes the daemon and still fails the shell's `check_available` (which is still the strict Rust reader), so the banner and the takeover preflight are as strict as before. Adoption writes the file back whole, so unknown fields are kept.
- **Options:** (a) as built; (b) port the whole struct as a TypeScript validator (about 150 lines, and a second copy of `TaskExecutionState` to keep in step); (c) have the shell run `check_available` before it starts a daemon.
- **Reverse:** write the validator in `readExecutionState`.
- **Files:** `vinculum-daemon/src/domain/ownership.ts`, `alinery-core/src/repo_ownership.rs`.

### R-S4.11-4: a refused fence is `code: message` on stderr and exit 1
- **Kind:** choice.
- **What:** before, an ownership failure was an uncaught `Error` from the FFI. `main.ts` now prints `repo_busy: ...` or `failed_precondition: ...` and exits 1. `repo_busy` means a lease is held or a lane's socket still answers; anything that cannot be proven stopped (a lock that is a directory or a symlink, a socket file that is not a socket, a corrupt task record) is `failed_precondition`. Not checked in the app: how the shell words a daemon that exits at start (it reads the daemon log). The shell's banner (`inspect_owners`) is where the user sees an incompatible owner, as before.
- **Files:** `vinculum-daemon/src/main.ts`, `domain/ownership.ts`.

### R-S4.11-5: the hosted token reaches a host's daemon as a settings write (built after the verifier's major finding)
- **Kind:** Build bullet 4, first waived, then built. Supersedes the earlier waiver (the plan text moved the bullet to S4.12 and back).
- **What:** `SettingsService.WriteHostedInference` (ADMIN, protocol 36). The daemon validates the body and writes `inference.json` owner-only beside its own app config. The shell sends the file after each hosted refresh and after each attach on connect, for a host whose reviewed sharing includes `hosted-models`. The refresh itself stays in the shell (it holds the account).
- **Choices the plan did not make.** (1) The request carries the whole `inference.json` as `inference_json` (a string), not typed `token`/`expires_at`/`catalog` fields: the catalog carries a free-form `thinking` object per model, and the file must round-trip byte for byte for the shell's readers. The daemon checks the fields its own provider reads. To reverse: type the fields. (2) The local daemon is not called: it shares the file with the shell on the same disk, so a write would only rewrite the same bytes. (3) `inference.json` stays the source for `hosted.rs`, `SHARE_HOSTED` (still pushed at connect, because the daemon may not be up yet) and sign-out; the RPC adds freshness between connects (the staleness named in the old option (b)). It does not remove the file. (4) One successful call per host: all daemons on a host share one app-config directory. (5) Before a session opens only the active repo's host is waited on; other hosts are reached by the 30-minute refresh and each connect, so a session on a local repo never waits on an unreachable host. (6) A failure is logged (`app.remote-hosted-inference-failed`), not returned: the connect-time file is still there and a session open is not blocked by it.
- **Not verified here.** The push to a real remote host (ssh forward, the host's rpc token, sharing record) is live check L-S4.11-f; the unit tests cover the daemon handler (mode 0600, validation, ADMIN refusal of VIEW/ACT and no token) and the shell's prost messages and call against a stand-in daemon.
- **To reverse:** drop the three call sites (`attach_host_repos`, `refresh_hosted_inference_before_open`, `spawn_pi_hosted_refresh`) and the RPC; the file push at connect is unchanged.
- **Files:** `proto/alinery/v1/settings.proto`, `proto/golden.ts`, `vinculum-daemon/src/rpc/settings.ts` (+ test), `src/daemon_rpc.rs`, `src/remote.rs`, `src/session.rs`, `alinery-core/src/protocol.rs`, `alinery-core/src/daemon_client.rs` (`audited_shutdown_protocol` lists 36), `vinculum-daemon/src/main.ts`.

### R-S4.11-6: takeover needed no change
- **Kind:** unverified claim, narrowed.
- **What:** the plan says "confirm sends `Shutdown(CONFIRMED_TAKEOVER)`". It already does (`daemon.rs` `confirm_repo_takeover_blocking` calls `shutdown_daemon` with `ShutdownOrigin::ConfirmedTakeover`, since S1.4), and `rpc.test.ts` covers the origin. The prepare, confirm and cancel commands are unchanged, and so is the Rust `check_available` they use. The takeover itself in the app is live check L-S4.11-c.

### R-S4.11-7: adoption marks the Rust-shaped records; what the engine does with them is S4.2's
- **Kind:** unverified claim.
- **What:** `acquireRepoOwnership` interrupts the `executions` records of `execution.json` exactly as the Rust did. For an execution the playbook engine runs, that map is a projection of the engine block (`mergedRecords` rewrites it on the next save), and the engine block is not touched by adoption. So after an adoption, a task whose session was running shows `interrupted` until the engine's own start-up pass (`resumeInterrupted`, `startGraphs`) saves again. The daemon tests cover the file; what the Tasks page shows for a playbook task that was mid-step across an upgrade is L-S4.11-c.
- **Files:** `vinculum-daemon/src/domain/ownership.ts`, `domain/executionStore.ts`.

### R-S4.11-8: the Rust ownership tests moved
- **Kind:** disposition.
- **What:** the nine "kept in Rust, S4.11" cases of the 53-case table (4.1) are ported to `domain/ownership.test.ts` and deleted from `execution_tests.rs`. One Rust case replaces what the shell still uses (`check_available_blocks_on_a_held_owner_unknown_socket_and_malformed_evidence_and_writes_nothing`), and `repo_ownership.rs` keeps its two inspection tests. The write-failure seam that the Rust test used (`with_adoption_write_failure`) is an `options.write` argument in TypeScript.

### R-S4.11-9: the Linux runtime and the bundle changed, neither was rebuilt
- **Kind:** unverified claim.
- **What:** `scripts/build-remote-runtimes.sh` no longer builds or ships `libalinery_core.so` (the archive is the daemon, `alinery-mcp` and `MANIFEST`), `copy-sidecar.sh` no longer copies the library, `tauri.conf.json` no longer bundles `resources/ownership/`, and `RepoOp::SpawnDaemon` lost `ownership_lib` (the repo service is versioned by the runtime hash, not `PROTOCOL_VERSION`). None of it was run: there is no zig on this machine and the app is not built. `cargo check -p alinery-app`, the workspace tests and the shell gates pass. `alinery-core` is `rlib` only. The `AGENTS.md` line that said the daemon uses "the ownership library (`libalinery_core`)" was corrected in the verifier follow-up (the daemon now owns ownership in TypeScript).
- **Files:** `scripts/build-remote-runtimes.sh`, `alinery-app/src-tauri/scripts/copy-sidecar.sh`, `tauri.conf.json`, `alinery-core/Cargo.toml`, `alinery-core/src/repo_service.rs`, `src/remote.rs`, `src/pi_durable.rs`. Live: L-S4.11-d, L-S4.11-e.

### R-S4.11-10: verifier follow-up on S4.11's tests
- **Kind:** decision.
- **What:** (1) `domain/ownership.daemon.test.ts` now starts a drawer Terminal (`spawn` with an empty `task_slug`) in the first daemon and asserts it is still `alive` after the second daemon is refused. (2) `platform/keepawake.test.ts` has a macOS test that holds the real `caffeinate` and ends it by turning the pref off, then by the last session ending; deleting `signalChild(... "keepawake-release")` from `drop()` now fails it (checked by that mutation). (3) The fixture reads in `keepawake.test.ts` and `ownership.test.ts` go through `firstLine.testutil.ts`, which fails after 10 s instead of waiting on a pipe, and the process-spawning tests have explicit timeouts. A mutation that makes ownership.ts loop at 100% CPU in-process cannot be interrupted by any test timeout (a synchronous loop never yields); that case stays caught only by the outer run limit.
- **Files:** `vinculum-daemon/src/domain/ownership.daemon.test.ts`, `domain/ownership.test.ts`, `platform/keepawake.test.ts`, `firstLine.testutil.ts`.

## E. Known flaky tests

### R-FLAKE-1: `tests::daemon::a_repo_being_closed_is_not_respawned_by_attach`
- **Kind:** flaky.
- **What:** asserts attach returns in under 500 ms. Under full-workspace load it failed once with "returned before any spawn attempt" during S3.5; it passed in 3 of 3 isolated reruns and in the later `check.sh --quick`. S3.5 did not touch the test or the code it exercises. Rerun it alone before treating a failure as a regression:
  `cd alinery-app/src-tauri && cargo test -p alinery-app --lib -- tests::daemon::a_repo_being_closed_is_not_respawned_by_attach`
- **Update 2026-11-05 (S4.1):** failed again in the first full `check.sh` of S4.1 (the same run also failed the real S4.1 regression above); passed alone on the rerun. It then failed in three full `cargo test -p alinery-app --lib` runs in a row. **Cause found:** the 500 ms is spent in `current_alineryd_socket_path` -> `alineryd_socket_namespace` -> `resolve_alineryd_path` -> `daemon_in`, which calls `read_dir` on `target/debug/deps`; after many builds in one worktree that directory held 145,273 files (142,436 of them stray `*.o`), and under the parallel load of the whole lib suite the listing took 550 to 690 ms (measured with a temporary `eprintln!` on `started.elapsed()`: `attach_repo_daemon` itself took 1.3 us, `repo_daemon` 5 us). After `find alinery-app/src-tauri/target/debug/deps -name '*.o' -delete` (2,837 files left) the full lib run passed. So the flake is a function of the size of `target/debug/deps`, not of S4.1 code. **If it recurs on a long-lived worktree, delete the stray `.o` files first.** The product-side hazard is real but small: `daemon_in` lists the whole executable directory (in a release app that directory is small).
- **Update 2026-11-06 (S4.6):** passed in the S4.6 full `check.sh`.
- **Update 2026-11-06 (S4.7):** passed in the S4.7 full `check.sh`.
- **Update 2026-11-06 (S4.9):** passed in the S4.9 full `check.sh`.
- **Follow-up:** widen or drop the 500 ms wall-clock bound.
- **Files:** `alinery-app/src-tauri/src/tests/daemon.rs:518`.

### R-FLAKE-2: `tests::daemon_rpc::a_takeover_is_bound_to_the_process_it_was_confirmed_for`
- **Kind:** flaky (fixed).
- **What:** the test re-executes the test binary as a listener child and waited at most 100 x 50 ms for it to bind. In one full `check.sh` of the P5 review it failed with "the child listens" (exit 101); the second full run passed and the test passed alone 3 of 3. On failure `child.kill()` was never reached, so the child slept 60 s as an orphan.
- **Fix:** the wait is now 600 x 50 ms (30 s) and the child is held in a kill-on-drop guard, so a panic cannot leak it. Reversal: restore the 100-iteration loop and the explicit `kill`/`wait`.
- **Files:** `alinery-app/src-tauri/src/tests/daemon_rpc.rs` (`a_takeover_is_bound_to_the_process_it_was_confirmed_for`).

### R-FLAKE-3: `tests::daemon::takeover_*` (`TakeoverPeer::start`)
- **Kind:** flaky (fixed).
- **What:** same pattern as R-FLAKE-2. `TakeoverPeer::start` re-executes the test binary as a legacy daemon peer and waited 5 s for it to answer `version`. In the P6 review `takeover_reconfirms_changed_names_and_presented_version` failed with "legacy peer did not become queryable" in every full `cargo test -p alinery-app --lib` run and in `check.sh` (twice), and passed alone (3 of 3) and under `-- tests::daemon::`. The sibling `TakeoverPeer` Drop only closed stdin, so a peer that never reached its listen loop was waited on forever or leaked.
- **Fix:** the wait is 30 s, and `Drop` waits at most 10 s after closing stdin, then kills the child. Reversal: restore `Duration::from_secs(5)` and the plain `wait()`.
- **Files:** `alinery-app/src-tauri/src/tests/daemon.rs` (`TakeoverPeer`).

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
- The playbook library through a real ssh forward to a Linux host's daemon, and a remote repo showing the host's global playbooks: L-S4.6-a, -e. The deletion of a community-imported repo playbook in the real app: L-S4.6-c. An edit in a second window refused as stale: L-S4.6-d.
- Git on a Mac without Command Line Tools, and the daemon's PATH under `systemd-run --user` on a Linux host (only `setsid` on a Debian container was run): L-S4.7-a, -b. A push, a worktree removal and a pull-request lookup on a remote repo in the real app: L-S4.7-c, -d.

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
- After S4.6, playbooks are read and written through the repository's daemon: a remote repository lists the host's own global playbooks, not this Mac's, and the bundled and global playbooks need at least one local repository to be known before they can be listed. `README.md:242` (`alinery_read_playbook`) is unchanged: MCP still reads the core library.
- After S4.7, git work on a task (worktree removal, commit, push and the compare URL, the stored pull-request link) runs in the repository's daemon, so for a remote repository it runs on the host with the host's git and credentials; only the GitHub pull-request lookup (with this Mac's token) runs here. If the README says the app runs git, say that the daemon does.
- After S4.8, starting, recovering, killing and discarding a sub-task run in the repository's daemon (on the host, for a remote repository). `alinery-mcp`'s `alinery_create_subtask` creates the child through the daemon as before; `alinery_inspect_subtask_finish` and `alinery_finalize_subtask` still run in the MCP process until S5.1.
- After S4.9, backup, restore-verification, the storage scan and the purge run in the repository's daemon (on the host, for a remote repository), so a remote repository's backup destination is a folder on the host. Backups are written with the host's `zip` and read with its `unzip`: a Linux host needs both installed (the remote setup refuses a host without them). The automatic backup triggers (after an artifact change, after a push or commit, before archive) are decided by the daemon, and a failing before-archive backup now stops the archive. Backups made by earlier builds are not guaranteed to restore.
- After S4.11, the "keep this computer awake" setting holds its inhibit through a small helper process of the daemon (`caffeinate` on macOS, `systemd-inhibit` on Linux), which exits with the daemon. If the README describes how it works, say so; the Linux hold needs logind.
- After S5.1, the MCP host config is the `alinery-vinculum-daemon` binary with `--mcp --app-config <app.toml> --endpoints-file <app config dir>/mcp-endpoints.json` (Settings > MCP > Copy config writes it), not `alinery-mcp`; it needs the app's managed MCP on and a running daemon for the repository (R-S5.1-4, R-S5.1-10).

### R-S4.11-12: the mcp "invalid defaults" test launched a daemon per run
- **Kind:** unverified claim, test fix, follow-up.
- **What:** `invalid_creation_defaults_and_caps_have_no_provisioning_side_effects` (`mcp/src/main.rs`) used `[global.defaults] playbook = 'superdevelop'` as an invalid default. The strict reader accepts a bare-string playbook, so the call went on to `ensure_compatible_daemon`, spawned `alinery-vinculum-daemon` on the scratch repo, and passed on `error: daemon launch failed: daemon did not start`. The daemon was never stopped, so each run left one running (85 were on this machine at the verifier's pass, repos `alinery-mcp-invalid-create-*`). The first case now uses `playbook = 5`, which the reader refuses before any daemon is contacted (the run takes 0.16 s instead of 3.3 s and the process count does not move). I did not kill the leftover daemons: the permission classifier refused it. `ps -axo pid,command | grep 'alinery-mcp-invalid-create-'` lists them; they are safe to kill.
- **Follow-up for the human:** is a bare-string playbook default meant to be accepted? The test comment and the error text ("playbook defaults require a scope-qualified v2 reference") say it should not be; the strict reader and the daemon's TypeScript parser may disagree about it. Not changed here (S4.1's parsers).

### R-S4.11-13: protocol bump checklist, and a second timing flake
- **Kind:** follow-up, known flaky test.
- **What:** a protocol bump also needs `alinery-core/src/daemon_client.rs` `audited_shutdown_protocol` (and its doc comment) to list the new number; without it `tests::daemon::takeover_rejects_invalid_and_compatible_targets_before_shutdown` fails deterministically ("Shutdown compatibility is not established"). Fixed for 36. In the one run that exposed it, `tests::daemon::quitting_stops_every_daemon_bring_up` also failed alongside `a_repo_being_closed_is_not_respawned_by_attach` when the whole `tests::daemon::` group ran in parallel; both pass alone and in the full `check.sh` run (second run, passed). Treat `quitting_stops_every_daemon_bring_up` as load-sensitive like the other.
- **Commit hygiene:** commit 1a51997 (the code commit) was written without the `Co-Authored-By` trailer; later commits carry it. Not amended (no amends allowed).

## S4.12 Providers and models

### R-S4.12-1: ProviderService shape, capabilities and what stayed out
- **Kind:** decision, deviation.
- **What:** `proto/alinery/v1/providers.proto`: `ProviderService` with `Catalog` and `ListModels` (VIEW) and `LoginStart`, `LoginPoll`, `LoginReply`, `Logout`, `SaveCustom`, `DeleteCustom` (ADMIN). The plan said "login and logout need ADMIN"; I made the poll and the reply ADMIN too, because a poll carries the sign-in URL and device code and a reply carries the key the user typed, and the Accept line needs `LoginStart` refused to a VIEW and ACT peer. The mutations (`LoginStart`, `LoginReply`, `Logout`, `SaveCustom`, `DeleteCustom`) carry `MutationMeta` and go through the dedupe, so a retried `LoginStart` does not start a second sign-in. They return no `Applied` cursor: the credential files are not entities in the store, so there is nothing for a cursor to cover. Each response is its own message (buf lint refuses a shared `ProviderCatalog`/`LoginStatus` response). A user-fixable refusal (unknown provider, bad base URL, method not api_key or oauth) is INVALID_ARGUMENT, not Internal.
- **Options:** (a) the plan's literal ADMIN-only login and logout, with Poll and Reply VIEW or ACT (a non-shell local peer could then read device codes and answer prompts); (b) all credential calls ADMIN (chosen); (c) Catalog ADMIN too (rejected: it names no secret, `has_key` is a boolean).
- **Reverse:** change the `requireCapability` argument in `rpc/providers.ts` and the comment in `providers.proto`; no wire change.
- **Files:** `proto/alinery/v1/providers.proto`, `alinery-app/src-tauri/vinculum-daemon/src/rpc/providers.ts`, `rpc/providers.test.ts`.

### R-S4.12-2: the browser stays in the page; a sign-in is pinned to the daemon that started it
- **Kind:** decision.
- **What:** the plan says the browser sign-in stays in the shell and the daemon holds the poll. The page polls `LoginPoll`, and on an `auth_url` event calls the shell's `open_url` (unchanged). `providerLoginStart` returns the host it asked, and `useProviderAccess` polls, answers and cancels that host, so switching the active repo mid-sign-in does not send the poll to another daemon. The catalog, logout and custom calls follow the active repo (else the first local one) like the agent directory (`sync/hostCall.ts` is the shared `agentHost` and `call`, moved out of `sync/agent.ts`, which re-exports `agentHost`).
- **Reverse:** drop `loginHost` in `chat/providerAccess.ts`.
- **Files:** `alinery-app/src/sync/providers.ts`, `sync/hostCall.ts`, `chat/providerAccess.ts`.

### R-S4.12-3: ListModels is the daemon's catalog, not the harness `models_cmd`
- **Kind:** decision, behaviour change the user should know about.
- **What:** `list_harness_models(_for_repo)` ran the harness row's `models_cmd` (`omp models --json` through `$SHELL -ilc`) on the Mac, for a remote repo too. The daemon has no OMP binary (a Vinculum session runs pi-durable in the daemon; `omp` is only a harness name for it, recorded as `vinculum`), and a remote host has none either, so `ListModels` returns the harness row's own `models` (the effective settings: bundled and the repo's `harnesses.toml` overlay) followed by `provider/id` for every model of a signed-in provider (`models.getAvailable()`, the list a session can actually run). Only `omp` and `vinculum` have a list; `no-harness` and any other key return nothing, as before. The list is therefore what the daemon will accept in `resolveModel`, but may differ from `omp models` (OMP's own catalog).
- **Left behind:** `models_cmd` is still a serde field with its repo-overlay guard (`adopt_global_models_cmd`) and TypeScript parity, but nothing executes it now. Follow-up for S5 or later: delete the field with the conformance fixtures, or keep it as a harness-row key for a future non-Vinculum harness. `settings::shell_quote` stays (remote install script uses it).
- **Reverse:** reinstate `list_harness_models_in` from commit 46ef95e and the two commands; the page switch is one line in `shared.tsx`.
- **Files:** `vinculum-daemon/src/rpc/providers.ts` (`listModels`), `src/settings.rs`, `src/tests/settings.rs`, `alinery-core/src/shared.rs` (comment).

### R-S4.12-4: the remote-sshd Accept line is not run; protocol 37
- **Kind:** unverified claim.
- **What:** Accept 3 ("ListModels through the forward returns the host's list") needs the Linux runtime bundle, and `scripts/build-remote-runtimes.sh --check` reports `MISSING: zig`. What ran instead: `rpc/providers.test.ts` serves the real `ProviderService` on a real unix socket for each peer class (shell, other, and a daemon with no host executable, which is the ssh class) with the real provider runtime in a temp config directory; `ListModels` there reads that directory's credentials and `.alinery/harnesses.toml`. The forward itself is the code S3.4 and S4.10 already exercised. Live check L-S4.12-c covers the container. Removing seven ops from the JSON-lines wire is an op-set change, so `PROTOCOL_VERSION` is 37 (also `audited_shutdown_protocol`, per R-S4.11-13).
- **Files:** `alinery-core/src/protocol.rs`, `alinery-core/src/daemon_client.rs`, `vinculum-daemon/src/main.ts`.

### R-S4.12-5: leftovers noticed and not touched
- **Kind:** follow-up.
- **What:** the JSON-lines op `vinculum_customizations`, its shell command in `session.rs` and `ipc.vinculumCustomizations` still exist after S4.10 moved the inventory to `AgentService`; `vinculum_customizations` is the live MCP-hub state (`mcpHub.refresh()`), so I did not remove it, but S5.3 (which deletes the JSON-lines wire) must either move it to a service or drop it. The page-side test doubles for `../sync/agent` that list only `writeModelRoles` break any new import from that module, which is why the shared helpers live in `sync/hostCall.ts`.
- **Suggested README text:** none needed; the model picker now shows what the host's daemon can run, which may differ from `omp models`.

### R-P4X-1: Shutdown now stops job children (P4 review, major)
- **Kind:** deviation (fix of a cross-session finding).
- **What:** a job child (backup, purge, storage scan) is spawned detached in its own process group, and `stopEverything` never signalled it, so a confirmed Shutdown left it running: a purge could keep deleting archived data, an auto-backup could keep reading `.alinery` while `restore_backup` rewrote it. `JobRunner.stopAll()` (called first in `stopEverything`, so both the JSON `shutdown` op and `AdminService.Shutdown` get it) cancels queued jobs, SIGTERMs running children, marks them CANCELLED and refuses to start another job. `JobRunner.drain(graceMs)` waits for the children; both exit paths (the 100 ms timer of the RPC, the callback of the JSON op) now go through `exitWhenJobsEnded` in `main.ts`, which waits up to 1 s, SIGKILLs what is left, waits 0.5 s more, then exits. Purge honours SIGTERM between items, so it normally ends inside the grace; a backup child dies on SIGTERM as it already did on a user cancel.
- **Options:** (a) the child watches its parent and exits (stdin is already closed after the params, so this needs a second pipe or a poll); (b) kill the process group at once with SIGKILL; (c) what was built. (a) also covers a daemon that crashes; (b) risks a half-deleted task in purge.
- **Why:** (c) is the smallest change that makes Shutdown mean "nothing of this daemon is left". The signal stays inside `signalChild` with the existing `job-cancel` reason, so `check-no-auto-session-kill.sh` needed only a comment change; no new teardown origin, and no session is touched.
- **Consequence in Rust:** the shell treats the process lock's release as "the daemon is gone" (`wait_for_daemon_gone`), which allowed 2 s. A daemon with a stubborn job child now exits up to about 1.6 s after the reply, so the wait is 5 s (100 x 50 ms). Wire-neutral (`Protocol-Neutral` trailer on the commit).
- **Not covered:** a daemon that is killed or crashes still leaves its job child running (option (a) would fix it). Not reproduced at runtime before the fix, as the reviewer said; the new tests start a real child and check the pid is gone after Shutdown.
- **Reverse:** drop `stopAll`/`drain`, restore `exit: () => process.exit(0)` and the callback's `process.exit(0)`, and return the wait to 40 iterations.
- **Files:** `vinculum-daemon/src/jobs/runner.ts`, `jobs/fake-child.ts` (mode `ignore-term`), `jobs/runner.test.ts`, `rpc/rpc.test.ts` (Shutdown mid-job), `main.ts`, `alinery-core/src/daemon_client.rs`, `scripts/tests/check-no-auto-session-kill.sh` (comment).

### R-P4X-2: dead alinery-core code from the S4 sessions deleted (P4 review, major)
- **Kind:** deviation (fix of a cross-session finding).
- **What:** deleted every function the reviewer named (30 with no caller; the 10 only tests called, with those tests) and then, because `pub` hides them from rustc, the functions that became caller-less in turn, found by a scan of every `pub fn` in `alinery-core/src` against all Rust under `src-tauri` (non-test region versus test region). Whole modules gone: `alinery-core/src/chat.rs`, `artifact_comments.rs`, `prompts.rs` (the two `prompts/subtask-manager*.md` files stay; the daemon imports them). Trimmed: `attachments.rs` (chat image reads only), `task_drafts.rs` (slug helpers only), plus single functions in `board.rs`, `execution.rs`, `git.rs`, `paths.rs`, `playbook_library.rs`, `session_actions.rs`, `shared.rs`, `storage.rs`, `backup.rs`, `task.rs`, `task_creation.rs`, `daemon_client.rs`. About 1,900 lines.
- **Conformance runners:** `alinery-core/tests/conformance.rs` lost the Rust runners for the domains `chat`, `artifact_comments` and `artifact_list`, whose Rust code is gone; like `board` they are skipped by `rust_readers_match_expected_json`. The `expected.json` files stay and the daemon's `bun test` (`domain/conformance.test.ts`) still checks the TypeScript implementation against them, but those three domains no longer have a second implementation holding them equal. The case floor (21) still holds (70 Rust-run cases remain).
- **One test rewritten, not deleted:** `app_lifecycle_targets_the_namespaced_lane_not_production` in `src/tests/daemon.rs` counted live sessions through the deleted `DaemonClient::live_session_count`; it now counts the rows of `session_statuses_observed`, so the lane-isolation assertion is unchanged.
- **Kept on purpose:** what `alinery-mcp` still calls (S5.1), `write_repo_overrides` and its reference role (R-S4.1-7), and everything in `settings.rs`/`shared.rs` the TypeScript conformance still reads. The scan also lists functions only tests call that I did not touch because they are not in the finding and some are reference implementations (`rename_task`, `restore_task`, `provision_task`, `set_related_tasks_in`, the `playbook_library` writers, `read_omp_window`, `rpc_chunk`, `message`, `lockfile::with_task_mutation_lock`, `daemon_client` test-only builders, the `shared.rs` reducers). S5.1 should decide them one by one.
- **Reverse:** `git revert` the commit; nothing else depends on it.
- **Files:** see `git show --stat` for the commit; AGENTS.md (the `chat.rs` row no longer points at `alinery_core::chat`).
- **Suggested README text:** none.

### R-P4X-3: flaky test seen again
- **Kind:** flaky.
- **What:** `tests::daemon::a_repo_being_closed_is_not_respawned_by_attach` failed ("returned before any spawn attempt") in a full `cargo test --workspace` run while the machine was loaded, and passed alone. Same 500 ms bound as in section E. It also failed the first full `./scripts/check.sh` of this session and passed alone and on the second full run ("OK: check passed"). It returns before any spawn attempt when `attach_repo_daemon` is slow to notice the closing mark, so the 500 ms bound measures machine load, not the change (a closing repo returns before ownership, which `wait_for_daemon_gone` is not part of).

## S5.1 MCP as a daemon client

### R-S5.1-1: the tool map, and the AGENT set is its 21 RPCs
- **Kind:** decision.
- **What:** the 26 tools and the RPCs each calls are in `mcpServer/tools.ts` (`rpcs` per tool; the map is also written into the plan under S5.1). `AGENT_RPCS` in `rpc/auth.ts` is the union, 21 methods: `SyncService/Subscribe`, `BlobService/{ReadBlob,BeginUpload,UploadChunk,CommitUpload}`, `PlaybookService/{ReadPlaybook,SavePlaybook}`, `TaskService/{CreateTask,ArchiveTask}`, `SessionService/{CreateSession,StartSession,ReadHistory}`, `SettingsService/WriteOverrides`, `ArtifactService/{InstallReviewHandoff,RecordOutboundHandoff}`, `SubtaskService/{CreateSubtask,InspectSubtaskFinish,FinalizeSubtask}`, `JobService/{StartStorageScan,StartPurge,StartBackup}`. `bun test src/rpc/auth` checks that the set equals the union in `tools.ts`, that `Shutdown` and every APPROVE method are PERMISSION_DENIED for AGENT, and that a request with no token is UNAUTHENTICATED. AGENT gets `[AGENT, need]` only for those methods, so a method not listed is refused whatever its VIEW or ACT need. `AdminService.MintToken` needs ADMIN and mints AGENT only.
- **Options:** (a) as built; (b) AGENT also allowed to read job status through `JobService` unary calls (rejected: reads are `Subscribe` snapshots, the WA, and the job's own entity arrives that way).
- **Reverse:** edit `AGENT_RPCS` and `tools.ts` together; the test fails until they agree.
- **Files:** `vinculum-daemon/src/rpc/auth.ts`, `rpc/auth.test.ts`, `rpc/admin.ts`, `mcpServer/tools.ts`, `proto/alinery/v1/admin.proto`.

### R-S5.1-2: three sub-task RPCs were missing, so they were added (wire surface, protocol 38)
- **Kind:** decision, deviation.
- **What:** `alinery_create_subtask`, `alinery_inspect_subtask_finish` and `alinery_finalize_subtask` had no RPC to call: S4.8 ported the shell's sub-task commands, not these three MCP-only entry points. The plan says "no tool changes", so `SubtaskService` gained `CreateSubtask` and `FinalizeSubtask` (ACT) and `InspectSubtaskFinish` (VIEW), over the daemon code the other sub-task calls already use (`domain/subtaskFinish.ts` is the finish logic moved out of the JSON-lines handler). With `AdminService.MintToken` that is four new RPCs, so `PROTOCOL_VERSION` is 38 in `protocol.rs` and `main.ts`, and `audited_shutdown_protocol` lists 38 (R-S4.11-13).
- **Options:** (a) as built; (b) leave the three tools on the JSON-lines wire (rejected: the Rust that served them is deleted and S5.3 deletes the wire); (c) drop the three tools (rejected: a tool removed from the agent surface).
- **Not done here:** the JSON-lines ops that only the Rust MCP called (`create_task` and the like) are still in `main.ts` and `daemon_client.rs`. S5.3 step 1 inventories the ops by last caller, and it is S5.3's to delete them; S5.1 deleted the Rust callers.
- **Reverse:** revert the commit; nothing else depends on the new RPCs.
- **Files:** `proto/alinery/v1/subtasks.proto`, `vinculum-daemon/src/rpc/subtasks.ts`, `domain/subtaskFinish.ts`, `rpc/subtasks.test.ts`, `alinery-core/src/protocol.rs`, `main.ts`, `alinery-core/src/daemon_client.rs`.

### R-S5.1-3: the MCP server is the daemon binary, and the shell's managed child is `--mcp --serve --managed`
- **Kind:** decision (O10 b as the user decided; details mine).
- **What:** `alinery-vinculum-daemon --mcp` is the whole MCP server (`src/mcpServer/`): stdio, or `--serve` on `mcp[-ns].sock` with `mcp[-ns].status.json` (`{pid, clients}`), the `exit` op the app's reap uses, and `--managed` (exit when stdin closes). The Rust `alinery-mcp` keeps only `--repo-service` until S5.2; `externalBin` still names it for that reason. `mcp.ts` (`McpHub`) launches a harness's MCP as `selfMcpCommand()` with `ALINERY_RPC_SOCKET` and `ALINERY_RPC_TOKEN` in its environment, and the daemon mints one AGENT token at its own start (label `harness-mcp`) for every such child to inherit. The shell's `src/mcp.rs` finds the binary with `pi_durable::resolve_alongside("alinery-vinculum-daemon")` and `resolve_mcp_path` is gone.
- **Tool replies are the Rust ones.** `mcpServer/fixtures/rust-replies.json` holds 49 calls recorded from Rust `alinery-mcp` at 16fae91 on a fixture repository; `replay.test.ts` makes the same calls against a real daemon and compares after normalising ids, times and the temp root. The named exceptions: `alinery_get_task` and `alinery_read_config` answer `Bun.TOML.stringify` of the entity, not the file's text (the plan said so; a hand-edited file comes back normalised, comments dropped); `alinery_write_config` with invalid TOML gives the same `error: not valid TOML (` prefix with Bun's own parser message; `alinery_list_sessions`, `alinery_create_task` and `alinery_create_session` answer the daemon's entity JSON, which omits a field at its default where the Rust struct wrote it, so those are compared on the fields both name or with defaults dropped.
- **Behaviour changes to tell the user (plan):** `alinery_save_playbook` on a repository playbook no longer fails `repo_busy` while a desktop window owns the repo; it goes through `PlaybookService.SavePlaybook` with `expected_revision`. The two TOML-returning tools normalise as above. MCP's own telemetry calls are gone; the daemon commands emit the events (O17).
- **Reverse:** `git revert` the commit; the Rust MCP returns from history.
- **Files:** `vinculum-daemon/src/mcpServer/*`, `main.ts`, `mcp.ts`, `alinery-app/src-tauri/mcp/src/main.rs`, `src/mcp.rs`.

### R-S5.1-4: the endpoints file, the 30-second refresh, and what a host's stdio MCP gets
- **Kind:** decision (not in the plan), behaviour change.
- **What:** the minted AGENT tokens live in the daemon's memory (`TokenRegistry`) and die with it. The managed MCP serves every repository the app has open, so the shell mints one token per local repository whose daemon answers (`mint_agent_token` in `daemon_rpc.rs`, label `alinery-managed-mcp`, so a refresh replaces) and writes `{version:1, repos:{<repo>:{socket,token}}}` to `<app_config_dir>/mcp-endpoints[-ns].json`, owner-only and atomic. `mcpServer/endpoints.ts` re-reads it on every call, so a repository opened or a daemon restarted later is found without restarting the MCP. The shell mints again at most every 30 s (a restart can force it: `ensure_mcp_server(.., restart = true)`), on a thread of its own because a daemon that does not answer costs 10 s. A refresh that reached no daemon is retried on the next call. Remote repositories are left out (MCP is on the daemon's host only, O20 c).
- **Token overlap (verifier finding, fixed after the first build).** `TokenRegistry.mint` used to replace the label's token outright, so a tool call that straddled a 30 s refresh failed part-way with `wrong token` (e.g. `StartPurge` accepted, then the job `Subscribe` refused). Now a label keeps its previous token valid until the mint after next, and `DaemonConnection.tokenSource` makes each request read the current token from the endpoints file (the connection is keyed by socket and protocol, not by token). A call longer than two refreshes still works because the token is read per request. Reverse: restore `byLabel: Map<string, Buffer>` and the token in the connection key. Files: `rpc/auth.ts`, `mcpServer/client.ts`, `mcpServer/handlers.ts`, tests in `rpc/auth.test.ts` and `mcpServer/server.test.ts`.
- **Window:** after a daemon restart the file holds a dead token for up to 30 s unless the restart came through `ensure_mcp_server(.., true)`; a call in that window answers an authentication error. A harness-launched MCP is not affected: its token is the daemon's own, minted when that daemon started, so it lives exactly as long as the daemon.
- **Host stdio MCP.** Settings > MCP > Copy config now writes `command: <alinery-vinculum-daemon>`, `args: ["--mcp", "--app-config", <app.toml>, "--endpoints-file", <the file>]` (`McpStatus.binary_path` is the daemon binary and the new `host_args` the arguments). Before, a host ran `alinery-mcp` with no app and no token; now it needs the endpoints file, which exists only while the app has the managed server on and a daemon answers, and its tokens die with the daemon. The Settings text was changed to say so. A host's MCP does not offer `alinery_send_review_handoff` (O22 a: `--managed` is what turns it on, `Endpoints.offersHandoff`), though it reads the same file.
- **MCP starts no daemon.** The plan says "MCP starts a daemon only where it does today (`task_client` with `start_daemon`)". A token comes only from a running daemon, so the Bun MCP cannot start one and be authorised; a call for a repository with no endpoint answers `this MCP holds no token for the daemon of <repo>; ...`. The old standalone start-on-demand is gone with the Rust MCP. Option (b) (the shell starts the daemon for a host's MCP) was not built.
- **Options:** (a) as built; (b) the host's config reads a token from an environment variable (rejected: it would sit in the host's config file); (c) one token for all repositories (rejected: a token is per daemon).
- **Reverse:** drop `refresh_mcp_endpoints*` and `mcp_host_args` from `src/mcp.rs`; the child then holds no endpoint.
- **Files:** `src/mcp.rs`, `src/daemon_rpc.rs`, `mcpServer/endpoints.ts`, `mcpServer/server.ts`, `src/views/Settings.tsx`, `src/types.ts`, `src/useMcpStatus.ts`, `proto/golden.ts`.

### R-S5.1-5: the Accept grep for writes finds the listener's two runtime files
- **Kind:** decision (reading of an Accept line).
- **What:** `rg 'writeFileSync|fs::write|write_bytes_durable|create_dir_all|mkdirSync|writeAtomic|writeDurable|appendFileSync|Bun\.write|renameSync|rmSync' src/mcpServer` (non-test) finds one write: `writeAtomic` of `mcp[-ns].status.json` in `server.ts`, plus `unlinkSync` of the socket and that file. They are the `--serve` listener's own process markers, written the way the Rust listener wrote them (the app reads the client count from the file), not repository state. The `mkdirSync` of `.alinery/` that the Rust listener had is dropped (the daemon has made the directory by then). Tests build their fixtures in `fixtureRepo.testutil.ts`.
- **Options:** (a) as built; (b) move the status file out of `.alinery/` (changes `alinery_core::mcp_status_path`, the shell's reader and its test, for a marker).
- **Reverse:** (b) is a small change in `paths.rs`, `mcp.rs` and `server.ts`.
- **Files:** `mcpServer/server.ts`.

### R-S5.1-6: gates
- **Kind:** decision.
- **What:** `check-no-auto-session-kill.sh` already scanned every non-test `.ts` under `vinculum-daemon/src` for `.kill(` and `signalChild`, which includes `src/mcpServer`; it now also fails on `.shutdown(`, `AdminService/Shutdown`, `ShutdownRequest|ShutdownOrigin`, `process.kill` or `child_process` there, and names the directory missing. `*.testutil.ts` joined `*.test.ts` as test code in that gate and in `check-daemon-fs-writes.sh` and `check-daemon-git-spawn.sh` (the fixture repository runs `git init` and writes files; renamed from `fixtureRepo.ts`). `check-ssh-spawn.sh` still scans `src/remote.rs` only; `rg '"ssh"|spawn' src/mcpServer` finds nothing.
- **Reverse:** edit the three scripts.
- **Files:** `scripts/tests/check-no-auto-session-kill.sh`, `check-daemon-fs-writes.sh`, `check-daemon-git-spawn.sh`.

### R-S5.1-7: what the Rust deletion removed, and the tests that went with it
- **Kind:** deviation (the plan's Exit list), follow-up.
- **What:** `alinery-core` lost `artifact_tree.rs`, `history.rs`, `storage.rs`, `subtask.rs`, `playbook_library.rs` (the whole modules), and the MCP-only functions of `task.rs`, `task_creation.rs` (the wire types stay for the shell's requests), `backup.rs` (the create path), `settings.rs` (the TOML writer), `shared.rs` and `daemon_client.rs` (`ensure_compatible_daemon`, `connect_compatible_once`, `spawn_daemon_detached`). `mcp/src/main.rs` went from 2,576 lines to the `--repo-service` entry; `mcp/tests/{serve_exit,session_tools,stdio_protocol}.rs` are deleted (the daemon's `server.test.ts` covers the socket, exit and stdio cases), and `alinery-core/tests/superdevelop_prompts.rs` with them. `conformance.rs` now runs the Rust side of only the `task`, `telemetry` and `session_name` domains, like R-P4X-2 did for chat and artifact listing; the other domains' `expected.json` files stay and `domain/conformance.test.ts` checks the TypeScript. The tests of the deleted functions in `execution_tests.rs` and `repo_service.rs`, and a handful in `src/tests/{backup,session,settings,task}.rs`, tested only the deleted functions and went with them. The bundled-playbook list test in `settings.test.ts` now compares `bundledPlaybooks.ts` with the key list in `alinery-core/src/types.rs` (it read the deleted `playbook_library.rs`).
- **How it was done:** compiler-guided (`pub` narrowed, the dead-code warnings followed). That technique deleted too much three times (a helper in `session_name`, `task`, and parts of `account.rs` and `community_playbooks.rs`); those files were restored from HEAD and redone by hand. A reviewer should diff `alinery-core/src` against 16fae91 for any function removed that something still calls; `cargo check --workspace --all-targets` and `cargo test --workspace` pass.
- **Not deleted:** the JSON-lines ops (R-S5.1-2). `alinery-core/src/daemon_client.rs` keeps `connect_compatible` (the shell's tests use it).
- **Reverse:** `git revert` the commit.
- **Files:** see `git show --stat` of the S5.1 code commit.

### R-S5.1-11: the quiet-machine gate must not count an MCP child as a daemon
- **Kind:** deviation (a regression found by `preflight_live_test.sh`).
- **What:** the MCP server is the daemon binary, so a daemon's built-in MCP child and the app's managed child show up in `ps` as `alinery-vinculum-daemon --mcp ... --repo <repo>`, which `is_product_daemon_ps_line` took for a second daemon of the same repository ("real process discovery finds the running daemon" read 2). `scripts/lib/preflight.sh` (embedded in the in-app updater by `include_str!`) now ignores a line with `--mcp`; `preflight_test.sh` has two cases for it. An MCP child has no sessions of its own, so excluding it loses nothing.
- **Reverse:** drop the `--mcp` clause in `is_product_daemon_ps_line`.
- **Files:** `scripts/lib/preflight.sh`, `scripts/tests/preflight_test.sh`.

### R-S5.1-12: the closing-repo flake widened
- **Kind:** flaky, deviation.
- **What:** `tests::daemon::a_repo_being_closed_is_not_respawned_by_attach` failed ("returned before any spawn attempt") in two of the four full `./scripts/check.sh` runs of this session and passes alone (R-P4X-3, R-S4.11-13). `attach_repo_daemon` returns at its first `is_closing` check, before any work, so the 500 ms bound only fails when the test thread is starved by the rest of the suite (this machine also holds the daemons that R-S4.11-12 left running). The bound is now 5 s; the two asserts above it (no daemon attached, no socket) are what prove nothing was spawned, and a spawn attempt waits for seconds.
- **Reverse:** put 500 ms back.
- **Files:** `alinery-app/src-tauri/src/tests/daemon.rs` (this test and the quit-latch twin next to it, which had the same bound).

### R-S5.1-8: AGENTS.md
- **Kind:** follow-up.
- **What:** the MCP lines in AGENTS.md describe the server as the daemon binary's `--mcp` mode. The Core Model and layout tables did not change.

### R-S5.1-9: unverified claims
- **Kind:** unverified claim.
- **What:** (1) the managed child, the endpoints file and the host config have run only in unit tests and the daemon-side tests against a real daemon; nothing here launched the app (L-S5.1-a to -c). (2) The Linux runtime bundle was not rebuilt (no zig), so a harness-launched MCP on a remote host is untested (L-S5.1-e). (3) The harness-launched MCP in a real OMP session was not run (L-S5.1-d). (4) `refresh_mcp_endpoints` (mint through the bridge against a live daemon) has no Rust test; the pieces are tested (the MintToken golden bytes, the file's mode and shape) and the daemon's `MintToken` and the whole replay run against the real daemon in `bun test`.

### R-S5.1-10: suggested README text
- **Kind:** suggested README text.
- **What:** the README's MCP section (host config paths and the `alinery-mcp` binary name): the host config is now the `alinery-vinculum-daemon` binary with `--mcp --app-config <app.toml> --endpoints-file <app config dir>/mcp-endpoints.json`, which Settings > MCP > Copy config writes. It needs the app to have the managed server on and a daemon running for the repository, because the tokens are minted by the daemon. `alinery_send_review_handoff` is offered only by the app's own managed MCP. `alinery_save_playbook` succeeds while the desktop owns the repository.

### R-S5.1-11: review fixes after the S5.1 verifier, and a known flaky vitest case
- **Kind:** follow-up record, known flaky test.
- **What:** (1) token overlap, see R-S5.1-4. (2) `alinery_list_tasks` hiding archived tasks was uncovered: the recorded list after the archive runs after the purge, so `.filter((t) => !t.archived)` could go unnoticed; `replay.test.ts` now creates, archives and lists a third task. (3) The `alinery_save_playbook` description no longer says a repo save fails `repo-busy` while a desktop window owns the repo (it succeeds through `PlaybookService.SavePlaybook`); `fixtures/rust-tools.json` keeps the Rust text as the recording. (4) Plan 2.1.10 table: the no-token row is gone and the minted-token row names the MCP child's environment. (5) Comments in `rpc/tasks.ts` and `main.ts` no longer say alinery-mcp still sends the legacy ops; `DaemonClient::create_task` and `create_subtask` in alinery-core stay for S5.3 with the ops (R-S5.1-2).
- **Flaky:** vitest `ChatEntryRow.test.tsx` "copies prompt and assistant message bodies" failed once in 1736 under `check.sh --quick`, passes alone and on the rerun; S5.1 did not touch ChatEntryRow. Not investigated.
- **Files:** as above.

## S5.2 Host bootstrap (O15)

O15 (b) was decided by the user (R-USER-5); nothing below reopens it.

### R-S5.2-1: the wire, and 13 requests where 2.3.3 lists 11
- **Kind:** decision, deviation.
- **What:** `host.proto` is `HostRequest` and `HostReply` (a `oneof` each), framed `[u32 big-endian length][message]` on the stdin and stdout of `alinery-vinculum-daemon --host-service`. The service first prints the line `alinery-host-service/1`, so the client can skip what a login shell printed ahead of it, then sends `HostReply{id: 0, hello}`; requests use ids from 1 and replies may come in any order (each request is handled on its own). A frame over 64 MiB is a broken stream. The plan lists 11 host variants (2.3.3) and says the restore runs on this channel (S5.2). The service has 13: those 11 plus `BackupVerify` and `BackupRestore` (verify refuses an archive of another repo before anything is stopped, so a refusal does not cost the host's live sessions; restore runs while the daemon is down). `SyncCredentials` carries its `set` as a map of provider id to the credential JSON as text, and the service does not interpret it.
- **Options:** (a) as built; (b) one request message with a string `op` and a JSON body (rejected: nothing would pin the bytes, and the golden-bytes gate is how the Rust and TypeScript sides stay equal); (c) gRPC over the pipe (rejected: no HTTP/2 on stdio, plan S5.2).
- **Why:** smallest wire that both sides can pin with golden bytes (`proto/golden.ts` writes `golden/host.json`; `tests::host_wire` and `ops.test.ts` check it).
- **Reverse:** none planned; the two backup requests are the restore the plan asks this channel to carry.
- **Files:** `proto/alinery/v1/host.proto`, `proto/gen/alinery/v1/host_pb.ts`, `proto/golden.ts`, `proto/golden/host.json`, `vinculum-daemon/src/hostService/`, `src/host_wire.rs`.

### R-S5.2-2: the Rust side keeps `HostOp` and the JSON reply shapes
- **Kind:** decision.
- **What:** `RepoOp` is renamed `HostOp` and encodes to `host.proto`; the reply is turned back into the JSON shapes the callers already read (`{"claimed"}`, `{"kind":"checkout","root"}`, the listing object, and so on), so the frontend commands (`remote_list_dir`, `remote_classify`, `remote_init`), `backup.rs` and the tests changed names and not logic. `rg -o 'RepoOp::[A-Za-z]+'` over the shell and core returns nothing.
- **Why:** the smallest diff that solves the session (AGENTS.md). The prost messages are hand-written beside `daemon_rpc.rs`'s admin messages, as the plan did for them.
- **Reverse:** make `HostChannel::call` return typed replies and change the callers.
- **Files:** `src/host_wire.rs` (`reply_value`), `src/remote.rs`.

### R-S5.2-3: what the Rust deletion removed
- **Kind:** follow-up record, deviation (scope).
- **What:** gone: the `alinery-mcp` crate (`mcp/`, its `--repo-service` loop and its test), `alinery-core/src/repo_service.rs`, and from `credential_sync.rs` the merge, its lock and `is_oauth` (the daemon's `credentials.ts` does this now; `kinds`, `api_keys` and `read_store` stay because the shell still reads the store). Beyond the plan: `restore_backup_into`, `extract_backup_into`, `safe_entry_path`, `clear_curated_alinery_data` and `CURATED_ALINERY_PATHS` in `alinery-core/src/backup.rs` had no caller left once `repo_service.rs` went (the daemon's `domain/backup.ts` restores; the local restore runs the daemon program), so they went with their tests (four `clear_curated_*` tests in `src/tests/backup.rs`, and the extract halves of `alinery-core/tests/backup_zip_interop.rs`, which now checks that the Rust reader reads the 70,000-file archive written by the host's `zip`). `read_backup_meta`, `require_backup_matches_repo` and `validate_backup_destination` stay (the shell still uses them). The gates that scanned `mcp/src` (`check-no-auto-session-kill.sh`, `check-ssh-spawn.sh`, `check-wire-parsing-boundary.sh`, `check-omp-no-path-fallback.sh`, `no_auto_session_kill_test.sh`) stop scanning it, and `check-ssh-spawn.sh` now scans the host service's two files for process kills by name or signal. `externalBin` is `alinery-vinculum-daemon` alone; `copy-sidecar.sh`, `check-experimental-daemon-names.sh` and `dev_fetch_omp_test.sh` follow. Left: `alinery-core/src/log.rs` still maps a file named `alinery-mcp` to a log label, and `src/mcp.rs` messages still say "alinery-mcp" for the managed MCP child (user-visible text; not touched).
- **Reverse:** git history has all of it.
- **Files:** as above; `.gitignore` and `.taurignore` still list `alinery-mcp-*` (harmless).

### R-S5.2-4: the runtime build, and what was and was not run
- **Kind:** unverified (x64), follow-up.
- **What:** `scripts/build-remote-runtimes.sh --check` asks for Bun and nothing else; each archive holds `alinery-vinculum-daemon` and a `MANIFEST` (`tar tzvf`: one executable of 99.3 MB for arm64 and 99.8 MB for x64, archives of 43.3 and 43.5 MB). The glibc floor (2.28) is still checked against the Bun binary. Both archives were built here (the x64 one is the Bun baseline build); only the arm64 one was run, on the Debian arm64 container (Colima, linux/arm64). The x64 archive has not run anywhere (no native x64 machine; QEMU is forbidden). `resources/remote/` is gitignored, so these archives are not in the commit.
- **Reverse:** none needed.
- **Files:** `scripts/build-remote-runtimes.sh`. Live check: L-S5.2-b.

### R-S5.2-5: `check-remote-routing.sh` and `check-remote-offload.sh` stay
- **Kind:** decision.
- **What:** the plan asked to decide from the count of listed commands. The routing list has 3 entries (`pick_backup_destination_dialog`, `start_mcp_server`, `stop_mcp_server`) and the offload list is empty; but the scripts still guard commands that route a remote repo through `repo_client`, `with_library` or `remote_call`, and `remote_call` is still how `backup.rs` reaches the host, so both stay. Neither script nor list changed in this session. Both pass under `check.sh`.
- **Options:** delete both with their lists (rejected: a new command that resolves its repo with a local-only helper would then fail closed with no record, which is what the gate prevents).
- **Reverse:** delete the two scripts, their `.txt` files and their lines in `check.sh`.
- **Files:** `scripts/tests/check-remote-routing.sh`, `scripts/tests/check-remote-offload.sh`, `scripts/tests/remote-local-only.txt`, `scripts/tests/remote-offload-ok.txt`.

### R-S5.2-6: `wait_daemon_gone` retries on a reset, and a stale claim after a silent network cut
- **Kind:** deviation, unverified claim.
- **What:** the TypeScript port of `wait_for_daemon_gone` probes the daemon's socket as `domain/ownership.ts` `socketReachable` does, which fails closed on any error other than "refused" or "missing". A daemon closing its listener while the probe connects answers `ECONNRESET`; the port failed on that (a flaky `bun test` in the first full `check.sh`, then reproduced by the test's own timing). The wait now counts a reset as "still going" and looks again. `ownership.ts` is unchanged. Separately, a host service whose ssh connection dies without a reset (the network cut with no packet) keeps its claim until sshd notices; a reconnect in that window would answer `repo-busy`. That is as it was with `alinery-mcp --repo-service`; nothing here changes it, and nothing here observed it (L-S5.2-c).
- **Reverse:** remove the `ECONNRESET` line in `waitDaemonGone`.
- **Files:** `vinculum-daemon/src/hostService/ops.ts`, `ops.test.ts`.

### R-S5.2-7: three live tests were stale
- **Kind:** follow-up record.
- **What:** the live remote tests had not run since before S4.1 (no zig, so no runtime bundle; R-S4.12-4). First run, three failed for reasons older than S5.2 or only about names: (1) `live_commands_connect_activate_disconnect_reconnect_and_remove` asserted the host `app.toml` carried no install id, but S4.1 sends the telemetry preferences whole on purpose (`render_remote_app_toml`); the assertion now says it does. (2) `live_an_unusable_daemon_is_reported_and_replaced_by_a_confirmed_stop` started its "old" daemon with no RPC token, so the confirmed stop (an RPC shutdown since S1.4) was refused with `grpc-status 16`; the test now gives the old daemon the token the app already kept for the repo, which is the case the banner covers (a daemon this app started earlier), and waits for the old daemon's socket before opening the repo. (3) `live_a_stalled_host_does_not_hold_up_the_command_that_asked` stopped a process by the old name (`alinery-mcp --repo-service`); it now stops `alinery-vinculum-daemon --host-service`. A fourth change adds the plan's second claimant: a rival `HostChannel` on the same host gets `claimed: false` while the first channel lives. After the changes all eight pass together (25.9 s).
- **A daemon with an unknown token still cannot be restarted from the banner** (it answers `grpc-status 16`); that is the fail-closed behaviour of S1.4 and not changed here.
- **Files:** `src/tests/remote.rs`.

### R-S5.2-8: AGENTS.md
- **Kind:** follow-up.
- **What:** the Remote repositories and Daemon sections no longer describe a repo service or the `mcp` crate; the version-bump table drops `mcp/Cargo.toml` (six files, two workspace packages in `Cargo.lock`); the runtime build needs Bun only. The new text is the "Host service" bullet.
- **Files:** `AGENTS.md`.

### R-S5.2-9: suggested README text
- **Kind:** suggested README text (README.md and `alinery-app/README.md` are not edited by agents).
- **What:** (1) `alinery-app/README.md` lines 88 to 144 and `README.md` line 228 onward still name an `alinery-mcp` binary, sibling sidecars `alineryd` and `alinery-runner`, and `alinery-mcp --serve`. Replace them as R-S5.1-10 says: the MCP server is `alinery-vinculum-daemon --mcp`. (2) If any README says a remote host needs a Rust toolchain, zig or cargo-zigbuild to build the runtimes: `scripts/build-remote-runtimes.sh` now needs Bun only, and a remote host needs `git`, `tar` and `zip` installed (the setup says so by name when one is missing).

### R-S5.2-10: the first full check.sh stopped at the daemon `bun test`
- **Kind:** flaky (fixed), record.
- **What:** the first `./scripts/check.sh` after bf67be3 failed once in `ops.test.ts` ("an answering socket keeps it waiting; a daemon that exits mid-wait lets it return", `ECONNRESET`), 595 of 596 passing, before reaching the Rust steps. It is R-S5.2-6; six reruns of `bun test src/hostService` passed 37 of 37 after the fix, and the third full `check.sh` is the one in the Status line (the second stopped at the `mcp/src` gates, R-S5.2-3).

## S5.3 Retire the JSON-lines wire

### R-S5.3-1: the op inventory and the last caller of each
- **Kind:** record.
- **What:** `handle` in `main.ts` had 18 named ops, plus the `write`, `resize` and `detach` frames on an attach stream. After this session none is served. `version` is `Hello` (`ensure_daemon`, the poller, the remote supervisor). `list` and `status` are `LiveSessions` and the `daemon/_/status` entity. `shutdown` is `AdminService.Shutdown` (the old op is sent only to a daemon of protocol 38 or older, R-S5.3-3). `spawn`, `attach` and `resume` are `ResumeSession` with `TerminalService.Attach`. `kill` is `KillSession`. `create_task` and `create_subtask` are `CreateTask` and `CreateSubtask` (S4.3, S4.8). `vinculum_customizations` is `ReadCustomizations` (S4.10). `ui_control` is the RPC token (2.1.10). `send_message` answered `unsupported` and `event` answered `event-rejected` at 07c03a9 and had no caller. The ops with a caller and no RPC were `prompt`, `abort`, `set_model`, `set_thinking_level` (each for a session and, with `chat: true`, for a chat thread), the MCP status read and the live-session list: R-S5.3-2.
- **Files:** `vinculum-daemon/src/main.ts` (at 07c03a9, lines 734 to 1073).

### R-S5.3-2: ten RPCs for ops that still had a caller
- **Kind:** deviation.
- **What:** the plan says "an op with a caller left goes back to the session that owns its domain; this session ports nothing". The remaining callers were the turn controls the pages call on every session and chat thread, the MCP status (`mcp_status` in the shell) and the live-session list that Settings and the teardown dialogs show. No later session owns them (S5.4 is a docs session, P6 is the setup screen), so leaving them would have kept the JSON listener. Ten RPCs were added: `PromptSession`, `AbortSession`, `SetSessionModel`, `SetSessionThinkingLevel` (`sessions.proto`; `SetSessionModel` and `SetSessionThinkingLevel` answer with the new `SessionControls`), `PromptChatThread`, `AbortChatThread`, `SetChatModel`, `SetChatThinkingLevel` (`chat.proto`), `ReadMcpStatus` (`agent.proto`) and `LiveSessions` (`admin.proto`). Mutations carry `MutationMeta`; the handlers are the old branches moved into `rpc/sessions.ts`, `rpc/chat.ts`, `rpc/agent.ts` and `rpc/admin.ts` with their refusals unchanged. `PROTOCOL_VERSION` is 39 (it was 38).
- **Options:** keep the JSON listener for these until P6; fold them into one `Control` RPC.
- **Why:** the Exit line is one listener per daemon. Separate RPCs keep each one's capability (VIEW or ACT) and its `MutationMeta`.
- **Reverse:** none cheap; the pages call them.
- **Files:** `proto/alinery/v1/{sessions,chat,agent,admin}.proto`, `vinculum-daemon/src/rpc/`, `alinery-app/src/sync/{sessions,chat,agent}.ts`, `alinery-app/src-tauri/src/daemon_rpc.rs` (`LiveSessions`).

### R-S5.3-3: a legacy stop for protocol 38 and older stays in core
- **Kind:** deviation (the Exit line says "no JSON-lines client in Rust").
- **What:** O23 (a) freezes `Hello` and `Shutdown` so a new app can always stop an old daemon. A daemon of protocol 24 or older has no `rpc.sock`, and one of 25 to 38 was started before this app kept an `rpc-secrets` token for its lane, so `AdminService.Shutdown` cannot be relied on; all of them speak `{"op":"shutdown"}` (the audited dialects in `audited_shutdown_protocol`) and hold the repository's owner lock, so a new app that cannot stop one cannot open the repository. `alinery-core/src/legacy_daemon.rs` (877 lines, 11 tests) keeps only that: the bound connection (`BoundDaemonConnection`: peer identity, `version`, `sessions`, `shutdown`), `wait_for_daemon_gone`, the version classifier and the reply parsers. Every other JSON op and the request builders are deleted. The app reaches it only through `legacy_shutdown` (the closure `shutdown_daemon` runs when `rpc.sock` does not answer) and `observe_takeover_owner`. The gate `check-no-auto-session-kill.sh` requires every caller of `legacy_shutdown` to be one of the five origins.
- **Options:** delete it and require users to stop an old daemon by hand (rejected: O23 a); keep the whole client (rejected).
- **Why:** it is the smallest code that keeps the promise of O23 (a). Remove it when no supported release speaks protocol 38.
- **Reverse:** delete `legacy_daemon.rs`, the `legacy` argument of `shutdown_daemon` and its four call sites.
- **Files:** `alinery-core/src/legacy_daemon.rs`, `src/daemon.rs` (`legacy_shutdown`, `observe_takeover_owner`), `src/daemon_rpc.rs` (`shutdown_daemon`), `src/backup.rs`.

### R-S5.3-4: the secret directory is `rpc-secrets`
- **Kind:** deviation (a rename the Accept line forced).
- **What:** the host's kept secret file lived in `ui-secrets/` and the Accept line `rg 'ui_control|ui-secret|ui_secret|RpcChunkAssembler' alinery-app` must find nothing, so the directory is `rpc-secrets/<hash>.rpc` under the host's config dir and `host.proto` reserves field 9 (`ui_secret_file`). The golden bytes were regenerated (`proto/golden/host.json`). A host that an older app set up keeps an unused `ui-secrets/` directory; it is leftover bytes and nothing reads it. The AGENTS.md "Host layout" line is updated.
- **Reverse:** rename back and un-reserve field 9 (a wire change).
- **Files:** `src/remote.rs`, `src/host_wire.rs`, `proto/alinery/v1/host.proto`, `proto/golden.ts`, `proto/golden/host.json`.

### R-S5.3-5: taking over a new-protocol daemon needs its kept token
- **Kind:** unverified, limitation.
- **What:** a daemon on a legacy socket is observed and stopped over the JSON-lines wire. A daemon that answers on `rpc.sock` is observed with `Hello` and `LiveSessions` and stopped with `AdminService.Shutdown`, both with the token this app kept for that repository and lane (`rpc-secrets/<hash>.secret`). A protocol 39 daemon started by another build with another app config directory has no token here, so "Take over" cannot observe it or stop it from the UI. Whether the banner still names the owner from the lane locks alone is not tested; it is part of L-S5.3-c. Tests cover the lanes where the token exists; the cross-config case is L-S5.3-c.
- **Reverse:** to take over such a daemon, stop it from the build that started it.
- **Files:** `src/daemon.rs` (`observe_rpc_owner`).

### R-S5.3-6: the drawer shell is created by `CreateSession` and ended by the page
- **Kind:** deviation.
- **What:** the shell had `ensure_drawer_terminal` (it opened the drawer shell over the JSON wire) and `set_active_repo(path, drawerSessionIds)` (it ended the old repository's drawer shells on a switch). Now the page calls `CreateSession` (an auxiliary `no-harness` session, `start: false`, `createDrawerTerminal(repo)` in `sync/sessions.ts`) and `KillSession` after a successful switch. `ensure_drawer_terminal` is deleted and `set_active_repo` takes only the path; the `App.*` tests expect `setActiveRepo(path)`. A kill that fails is not retried by the page (R-S5.3-6 is unverified in the app: L-S5.3-e).
- **Files:** `alinery-app/src/sync/sessions.ts`, `App.tsx`, `SessionTerminal.tsx`, `src/app_config.rs`.

### R-S5.3-7: the daemon publishes the host-guard warning
- **Kind:** decision.
- **What:** the shell used to read `host_guard_ready` from the JSON `version` reply (the daemon answered `true` unconditionally, so the warning in `App.tsx` could never show). `daemon/_/status` already had a `host_guard_warning` string that nothing set. `main.ts` now passes `"no canonical executable for dynamic host screening"` when `ALINERY_HOST_EXECUTABLE` is unset, `SessionPublisher.commitStatus` publishes it, and `useDaemonStatus` sets `host_guard_warning` from it. The shell's own half of `DaemonStatus` is `ShellDaemonStatus` (`mode`, `extra_lanes`, `stale_lanes`, `repo`, `build_drift`, `conflict`, `repo_busy`). Effect: a daemon started by hand without the executable now shows the warning; a normal start does not (L-S5.3-d).
- **Files:** `vinculum-daemon/src/main.ts`, `domain/sessions.ts` (+ test), `alinery-app/src/useDaemonStatus.ts` (+ test), `types.ts`, `ipc.ts`.

### R-S5.3-8: the gates
- **Kind:** decision.
- **What:** `check-no-auto-session-kill.sh` lost the scan for the `shutdown` op and `shutdown_request(`; it keeps the `ShutdownOrigin` check (all five origins must name one), the close-repo caller list, the daemon-side signal checks and the MCP check, and adds that `legacy_shutdown` has only allowlisted callers. `check-wire-parsing-boundary.sh` is kept (the shell still has the legacy client) and confines request building and reply fields to `legacy_daemon.rs`; it fails if they leak. `check-protocol-version-bump.sh` watches `proto/alinery/v1` and `legacy_daemon.rs` instead of `daemon_client.rs`. `protocol_gate_test.sh` has a proto case and a check that the number `Hello` returns (`PROTOCOL` in `main.ts`) equals `PROTOCOL_VERSION` in `protocol.rs`; the plan's "reads the protocol from `Hello`" is met by that source comparison, not by launching a daemon. `check-remote-routing.sh` lost `require_owned_active_repo(`, `require_active_target(`, `repo_client(`, `task_client(`, `with_library` and `remote_call(`, which no longer exist; `check-experimental-daemon-names.sh` reads the resolver from `daemon_launch.rs`.
- **Files:** `scripts/tests/`.

### R-S5.3-9: what the live remote tests no longer assert
- **Kind:** deviation.
- **What:** the live tests asserted terminal bytes through the old JSON attach path. Those assertions went with the code (the replacement stream is `TerminalService.Attach`, which the bridge tests and the daemon tests cover, and which no live test drives over the forward). The eight `live_*` tests still cover install, browse, daemon start, survive-a-disconnect, credentials, close-all, backups, the stalled host and the dropped host. A terminal on a remote repository is L-S5.3-g.
- **Files:** `src/tests/remote.rs`.

### R-S5.3-10: the relaunch test starts the daemon from the file the build id hashes
- **Kind:** decision.
- **What:** `start_daemon` resolved the binary with `resolve_alongside` (the app's own directory), which `cargo test` cannot find (it runs from `target/debug/deps`). It now uses `alinery_core::resolve_alineryd_path()`, the resolver `daemon_binary_build_id()` already used, so the file started is the file the app compares against. In an installed app the two paths are the same. The relaunch test skips with a message when no sidecar is built.
- **Files:** `src/pi_durable.rs`, `src/tests/daemon.rs`.

### R-S5.3-11: what was run
- **Kind:** record.
- **What:** `./scripts/check.sh` passes (the code at 7b02900); `bun test` 600 pass; vitest 1,744 pass and 1 skipped; `cargo test --workspace` exits 0. The remote runtimes were rebuilt locally (`scripts/build-remote-runtimes.sh`, gitignored) and the eight `live_*` tests pass against the Debian arm64 sshd. The x64 archive was built and not run. A scratch daemon on a new repository listed `rpc.sock` alone in `.alinery/*.sock`. `daemon_client.rs` does not exist. The `rg` Accept returned one hit, a comment on the reserved field in `proto/alinery/v1/host.proto`; the comment was reworded afterwards (R-S5.3-13) and the `rg` over `alinery-app` and `proto` now returns nothing.
- **Observation (unverified):** after the scratch daemon received SIGTERM from `pkill`, `rpc.sock` was still on disk (a stale socket). A daemon stopped by `Shutdown` is what the app does; the next start replaces a stale socket, but that replacement was not exercised here. Since R-S5.3-13 the daemon handles SIGTERM as a `Shutdown` teardown and removes `rpc.sock`; a SIGKILLed daemon still leaves it.

### R-S5.3-12: AGENTS.md
- **Kind:** follow-up (done).
- **What:** AGENTS.md now describes the one listener, the `rpc-secrets` directory, the legacy stop, `Hello`-based lifecycle and the moved-command recipe without `remote_call`/`repo_client`. README.md was not edited. Suggested README text: none beyond R-S5.1-10 and R-S5.2-9, which still apply.
- **Files:** `AGENTS.md`.

### R-S5.3-13: the installer's quiet-machine gate (verifier blocker and major)
- **Kind:** provisional decision, deviation from the plan (the plan does not mention the installer), and a correction.
- **What:** `scripts/lib/preflight.sh` (embedded in `update.rs`, also the CDN installer's gate) found a daemon by sending JSON ops to `alineryd.sock`, which S5.3 removed, so it saw no daemon: no session warning and no daemon stop before the bundle swap. Verified by starting the real daemon: `.alinery/` held `rpc.sock` alone. Fixed in 700cfca. The gate now (1) probes liveness by connecting to `rpc.sock` (`nc -U`, exit status; a dead socket file refuses), (2) counts live sessions from the session metas (`started_at` set, `ended_at` unset, not archived: the daemon's own resume rule), (3) ends the daemon with SIGTERM to the pid whose `--repo` is that repository, and waits for the socket to stop answering as before. A daemon from before the single listener is still probed and stopped over `alineryd.sock` with the JSON ops, so an update from a released build keeps its check. The daemon gained `process.once("SIGTERM", ...)` which runs `stopEverything()` (the `Shutdown` teardown: sessions recorded ended, `rpc.sock` removed) and exits after the job grace.
- **Options:** (a) SIGTERM handler in the daemon, as built; (b) a daemon CLI client mode that calls `Shutdown`: refused, it needs an ADMIN token from a shell peer, which neither the installer nor a user's terminal is, and giving the installer one would widen R8; (c) a process-only gate that signals without a handler: the default SIGTERM kills the daemon without recording its sessions ended and leaves `rpc.sock`; (d) refuse to update while any daemon runs: safe but removes the "stop everything and install" yes the gate offers.
- **Why (a):** it adds no RPC surface, no token path and no new `ShutdownOrigin`; the only way to reach it is a signal from the same user, after the gate's explicit yes (or the user's own `kill`, or the OS at logout, where the process would die anyway and now records its sessions as ended). The "exactly five `Shutdown` senders" rule is about senders of `Shutdown`; this is a receiver. `check-no-auto-session-kill.sh` passes unchanged.
- **Known limits (unverified):** the session count is a read of meta files, so a meta the daemon has not yet written can undercount by a moment, and a daemon killed hard leaves metas that look live until its next start (it is not running then, so the gate does not count them). `nc -U -w 1` exit status as the liveness test was observed on macOS only; Linux netcat-openbsd was not run (live check L-S5.3-h). A daemon in a dev namespace (`rpc-<ns>.sock`) is not probed, as before for `alineryd-<ns>.sock`.
- **Reverse:** drop the SIGTERM handler and restore the JSON probes in `preflight.sh`; the gate then sees no current daemon again, so also set the updater to refuse, which is the only safe fallback.
- **Files:** `scripts/lib/preflight.sh`, `scripts/lib/preflight.test.sh`, `scripts/tests/preflight_test.sh`, `scripts/tests/preflight_live_test.sh`, `alinery-app/src-tauri/vinculum-daemon/src/main.ts`, `AGENTS.md`.

### R-S5.3-14: tests that skipped quietly (verifier major and minor)
- **Kind:** correction.
- **What:** `preflight_live_test.sh` printed `SKIP: daemon never came up` and exited 0 when the daemon never created the socket it probed, which is how the blocker above stayed green. It now fails when a daemon that started never answers, and it fails when `nc` or the daemon binary is missing if `ALINERY_REQUIRE_SIDECAR` is set. `scripts/check.sh` sets that variable after `copy-sidecar.sh`, and the relaunch test (`tests/daemon.rs`) asserts on it instead of returning early. The live test's final `wait` no longer hangs when the gate failed to stop the daemon (found by mutating the gate: with the SIGTERM line removed the live test fails 4 checks, as it should). The stub tests (`preflight_test.sh`, `preflight.test.sh`) were updated with the probes: they now assert the socket list, the meta count, the SIGTERM-by-repo pid choice and the legacy JSON stop.
- **Files:** `scripts/tests/preflight_live_test.sh`, `scripts/tests/preflight_test.sh`, `scripts/lib/preflight.test.sh`, `scripts/check.sh`, `alinery-app/src-tauri/src/tests/daemon.rs`.

### R-S5.3-15: drawer-shell cleanup after a switch (verifier minor)
- **Kind:** accepted limitation, follow-up.
- **What:** the page ends the old repository's drawer shells after a successful switch (R-S5.3-6). If the window closes between the switch and the kill, or the daemon refuses the kill, those idle shells keep running in the old repository's daemon until the user ends them or the next switch back. Not changed: an idle drawer shell holds no work, the daemon is the repository's own, and the alternative (the daemon ending idle drawer sessions) needs a rule for what idle means. L-S5.3-e covers the happy path only.
- **Reverse / close:** if it matters, have `CreateSession` for a drawer shell carry a marker the daemon ends on `Hello` from a different active repository, or end drawer shells at `close_all_repos`.
- **Files:** none.

## S5.4 AGENTS.md

### R-S5.4-1: the `src/daemon/` services gate is not built
- **Kind:** deviation (plan 2.5 and the S5.4 Build list a gate "that checks that `src/daemon/` calls only services that exist in `proto/`").
- **What:** no such gate exists, and AGENTS.md does not name one. The failure it would catch cannot reach a build: every service client is imported from the generated `alinery-proto/alinery/v1/*_pb` modules, so a call to a service that is not in `proto/` fails `tsc` (the "typecheck (sources + tests)" step of `check.sh`) and `check-proto-gen.sh` fails when `proto/gen` and the `.proto` files disagree.
- **Options:** (a) record and skip, as done; (b) a grep gate over `src/sync` and `src/daemon` for `createClient(` with a service name that is not exported by `proto/gen`: it repeats what `tsc` already proves.
- **Reverse:** write (b) if a call ever goes through an untyped path (a string service name); today none does.
- **Files:** none.

### R-S5.4-2: how AGENTS.md was checked, and what was not
- **Kind:** unverified claims (listed so nobody trusts them more than they were tested).
- **Checked by script or by reading the code, this session:** every `check-*.sh` named exists and every one is named; every module in the table exists and every top-level `.rs` is in it; the command list equals `generate_handler!` (76); `externalBin` is the Vinculum daemon alone; `ShutdownOrigin` has five values; the capability names and the `PeerClass` values; `Cursor` is `epoch` plus `seq`; `daemon_rpc` is generic over the service path; `proto/golden` comes from `bun golden.ts`; `jobs/autoBackup.ts` runs the automatic triggers; the version-bump table (six files, two workspace packages) matches `Cargo.lock`, `Cargo.toml`, `package.json`, `package-lock.json` and `tauri.conf.json` at 0.25.0.
- **Not checked by running anything:** the sentences about quit (`onCloseRequested`), the conflict banner, the supervisor's back-off and the host-key handling are carried over from earlier text and were only grepped for the symbols they name. The `check-remote-offload.sh` line still names `off_main_thread`, which no longer exists in the shell; the gate's regex accepts either word. Whether the gate has anything left to police after S5.2 was not examined.
- **Reverse / close:** none needed; this is a statement of coverage.
- **Files:** `AGENTS.md`.

### R-S5.4-3: Harness Registry and Core Model not audited against the pi-durable runtime
- **Kind:** unverified, follow-up (the todo file has carried "AGENTS.md: the Harness Registry and launch-list lines were not audited against Vinculum" since before this plan).
- **What:** AGENTS.md still says a session is "one PTY running OMP", that the daemon resolves `binary = "omp"` to a packaged binary, and that an OMP child gets `env_clear()` plus `OMP_ENV_ALLOWLIST`. Reading the daemon: `terminal.ts` spawns only a shell, `mcp.ts` only MCP children, nothing spawns `omp`, `tasks.ts` and `main.ts` rewrite harness `omp` to `vinculum` (the in-process pi-durable runtime), and `sessionState` reports `adapter: "omp"` as a constant. The spawn-time sentences may therefore describe a path that no longer runs (the Rust half, `OMP_ENV_ALLOWLIST` and the "bundled OMP not found" error in `alinery-core/src/paths.rs`, is still there). I did not rewrite them: that section belongs to the harness decision of the base branch (`experimental-pi-durable-as-a-harness`), not to the thick-daemon plan, and a wrong rewrite is worse than a stale line.
- **Reverse / close:** run L-S5.4-a. If no `omp` child appears, rewrite Core Model (Session), Harness Registry and the OMP lines in the Build section; delete `OMP_ENV_ALLOWLIST`, `resolve omp` and the `omp:*` scripts if nothing else uses them.
- **Files:** `AGENTS.md` (unchanged on this point), `docs/remote-repos-todo.md`.

### R-S5.4-4: the remote-repos docs are annotated, not rewritten
- **Kind:** decision.
- **What:** `docs/remote-repos-performance.md` gets a status banner and a note on each of M1 and P1 to P7; `docs/remote-repos-todo.md` gets a banner and notes on A4, A5, M1, P2 to P7, B4 and two backlog lines. The reasoning text is kept as the record. P6 is marked built (the sync engine) although the plan made it conditional on M1; M1 stays open because nobody measured. B2, B3 and B5 stay open and overlap S6.1 and S6.2.
- **Options:** delete the superseded sections (loses the reasoning the thick-daemon plan cites); annotate (chosen).
- **Reverse:** `git revert` the docs commit; no code depends on it.
- **Files:** `docs/remote-repos-performance.md`, `docs/remote-repos-todo.md`.

### R-S5.4-5: README suggestions
- **Kind:** readme (README.md is not edited).
- **Suggested README text:** the four bullets added to plan 4.4 this session, plus the earlier ones there: the MCP Server section (`alinery-mcp` is gone; the host config and its prerequisites), the development prerequisites (Bun and `scripts/install-proto.sh --with-dev`; the Rust workspace is the app and `alinery-core`), and line 128 next to line 87 (a repo with no daemon shows its banner).
- **Files:** `docs/thick-daemon-plan.md` (4.4).

## S6.1 Hosts and the onboarded mark

### R-S6.1-1: the migration keys on the absence of the key
- **Kind:** decision (the plan says "at the first read of an older app config" and gives no way to tell an older file from a newer one whose mark is false).
- **What:** `local_onboarded` and `RemoteHost.onboarded` are always written. `read_existing_app_config` parses the raw TOML a second time and derives a mark from `known_repos` only when its key is missing. After the first write the key exists and the repos no longer decide it. Fresh installs (no file) start unmarked. The derivation sits in the read path, so every `load_app_config` caller sees it, but the file changes only on the next write.
- **Options:** `Option<bool>` fields (the plan says `bool`); a `settings_version` bump (it is forced to 1 by `sanitize_app_config`); keep the derivation permanent (a user who skipped nothing but never onboarded with a repo would be marked forever).
- **Reverse:** make the fields `Option<bool>`, or add a separate `onboarding_migrated` flag, and drop the second TOML parse.
- **Files:** `alinery-app/src-tauri/src/app_config.rs` (`migrate_onboarded_marks`), `src/tests/app_config.rs`.

### R-S6.1-2: the legacy `localStorage` flag is moved by the page, before the wizard decision
- **Kind:** decision.
- **What:** `readAppConfig` is chained into `migrateLegacyOnboarding`, which calls `set_host_onboarded("local", true)` and removes the key, so the wizard decision already sees the mark. A refused call leaves the key (retried next launch) and still treats this computer as onboarded for this launch. The flag was once per install and not per host, so it can only mean this computer. A remote host whose only evidence is the old flag has no mark until it holds a repo (the `known_repos` rule) or the user finishes onboarding there.
- **Reverse:** put the flag read in Rust (the shell cannot read the webview's `localStorage`), so this is not reversible without a new IPC.
- **Files:** `alinery-app/src/onboarding.ts`, `alinery-app/src/App.tsx`, `alinery-app/src/onboarding.test.ts`.

### R-S6.1-3: which host a finished wizard marks, and when the wizard is decided
- **Kind:** decision.
- **What:** `completeOnboarding` (finish, skip or close; the dialog's close handler is the same function, as before) marks the host of `appConfig.active_repo`, or this computer when there is none. The wizard is still decided once, at startup, from the active repo's host, as before; choosing a repo on another host later does not reopen it. Choosing the host first and running onboarding on a host's first daemon is S6.2. If the shell refuses the mark, `repoErr` shows "Could not record that onboarding finished" and the wizard is closed anyway.
- **Reverse:** change `hostOf` in `onboarding.ts`.
- **Files:** `alinery-app/src/App.tsx`, `alinery-app/src/onboarding.ts`.

### R-S6.1-4: what the tests do not prove
- **Kind:** unverified.
- **What:** (a) "Removing a host clears its mark" holds because the mark is a field of the `RemoteHost` entry; the Rust test only shows the serialized config has no trace of a removed host, since `discard_unconnected_host` needs an `AppHandle`. (b) `list_hosts` and `listHosts` have no caller in the UI until S6.2, so nothing exercises the command through Tauri; the Rust test covers `host_entries`, and `check-ipc-commands.sh` the registration. (c) The real launch is L-S6.1-a. (d) The mark is Mac-private: `render_remote_app_toml` is an allowlist and does not copy it to a host.
- **Files:** `alinery-app/src-tauri/src/tests/app_config.rs`.

## S6.2 The setup screen

### R-S6.2-1: the typed host refusal lives in the shell, not in `host.proto`
- **Kind:** decision (the plan says the refusal is typed "in host.proto"; the probe, the runtime selection and the launcher choice that refuse are Rust in `remote.rs`, and there is no host proto in the tree for them to travel in).
- **What:** `Refusal { kind, message, missing_tools, fix }` with `RefusalKind` (`not_linux`, `unsupported_cpu`, `no_glibc`, `old_glibc`, `large_pages`, `missing_tools`, `no_runtime`, `stops_processes`) is returned by `select_target` and `choose_launcher`. It reaches the page as the error string `host-refused: <json>`, the same shape as the existing `host-key-unknown:` prefix, and `parseRefusal` in `setup.ts` reads it. The words shown to the user come from `refusalAdvice` (per kind) and not from `message`, which stays the plain English the logs and older callers print. The probe also reports `user=`, so the `stops_processes` fix can name the account (`loginctl enable-linger <user>`).
- **Options:** carry the kind in a new `ErrorKind` of the app's command errors (every command would then need to carry it); parse `message` text (brittle).
- **Reverse:** replace the prefix with a structured command error; `parseRefusal` is the one reader.
- **Files:** `alinery-app/src-tauri/src/remote.rs`, `alinery-app/src/setup.ts`, `alinery-app/src-tauri/src/tests/remote.rs`.

### R-S6.2-2: when the setup screen takes the whole window
- **Kind:** decision.
- **What:** `shouldShowSetup(cfg, hosts)` is true when there is no active repo or no known repo, false when any local repo is known, and otherwise (only remote repos known) true only when the active remote repo's host has `gave_up` (see R-S6.2-8: a bare `failed` state was not enough). A host that is `connecting`, `reconnecting` or `needs access` keeps the board and its banners, so a flaky link does not throw the user to a setup screen; a refused login or changed host key (the supervisor gives up) does. Add repository and Add remote repository from the top bar, the command palette and the busy banner open the same screen as a dialog (`setupTab` state; the remote button opens the SSH tab).
- **Reverse:** `shouldShowSetup` is the one place.
- **Files:** `alinery-app/src/setup.ts`, `alinery-app/src/App.tsx`.

### R-S6.2-3: Test connection probes an unsaved host and Add never installs
- **Kind:** decision.
- **What:** `remote_test_host(destination, trust)` parses the destination, probes with `sh -s` over a throwaway ControlMaster and answers `{platform, glibc}`. If a master for the same socket was already alive it is left alone; only a master this call started is closed (`exit_master`). It installs nothing and writes nothing to the app config. A changed or unknown host key is the same `host-key-unknown:` prompt, and the dialog's trust button is "Trust and test". Add SSH connection stays enabled after a failed test (a test can fail for reasons the user will fix on the host). A host added on the screen and then refused on its first connect is discarded again (`remoteDiscardHost`), so a typo does not leave a row; a host that existed before is never discarded.
- **Files:** `alinery-app/src-tauri/src/remote.rs` (`test_destination`, `test_ssh_args`), `alinery-app/src/AddSshHostDialog.tsx`, `alinery-app/src/views/SetupScreen.tsx`.

### R-S6.2-4: onboarding runs after the repo opens, for the host's first daemon
- **Kind:** decision (completes R-S6.1-3, which left it to this session).
- **What:** the wizard lost its workspace step (three steps: Playbooks, Models, First task) and its repo props. After a repo is opened from the setup screen, `openFromSetup` reads `list_hosts` and opens the wizard at Playbooks when that repo's host has no onboarded mark; a second repo on the same host goes straight to the board. The wizard's launch step has a Change action that completes onboarding and reopens the setup screen. Whether to open onboarding is decided by the host list read after the open, so a host connected in this very flow is judged by its mark and not by a startup snapshot. Telemetry consent is deferred while there is no active repo (it was asked on top of the empty window).
- **Reverse:** `openFromSetup` in `App.tsx`.
- **Files:** `alinery-app/src/App.tsx`, `alinery-app/src/views/OnboardingFlow.tsx`, `alinery-app/src/onboarding.ts`.

### R-S6.2-5: the daemon steps are one call
- **Kind:** decision.
- **What:** the plan lists "Starting the daemon" and "Preparing the repository" as separate steps. `set_active_repo` already does Hello and EnsureReady in one command (`attach_repo_daemon_locked`), so the progress list shows the folder check, then both daemon lines together while that command runs, and none of the three lines is a measured stage. A failure keeps the screen on the form with the message above the list. No new command or event was added to split them.
- **Reverse:** split `set_active_repo` into attach and ensure-ready commands and drive the two lines from them.

### R-S6.2-6: one helper for the folder and the Git question
- **Kind:** decision (Accept: `classifyPickedFolder` and `remoteClassify` are called only through one helper).
- **What:** `openFolderAsRepo(hostId | null, path)` in `folderSetup.ts` is the only caller of `classifyPickedFolder`, `remoteClassify` and the init command. It asks "Initialize Git?" through `askConfirm` for a folder that is not a repository and answers `root`, `refused` or `cancelled`. The setup screen is its only caller; the old copies in `App.tsx` and `RemoteModal.tsx` are gone. `RemoteModal` is now reconnect-only (connecting, needs access, failed with Try again).
- **Files:** `alinery-app/src/folderSetup.ts`, `alinery-app/src/RemoteModal.tsx`.

### R-S6.2-7: what the tests do not prove
- **Kind:** unverified.
- **What:** (a) The setup screen, the dialog and the connecting flow are exercised with `mockIpc` in jsdom; no real window, trust prompt or ssh ran (L-S6.2-a, -b, -d). (b) The CSS added to `onboarding.css` (`.setup-tabs`, `.setup-folder-row`, `.setup-connect`, `.setup-fix-command`) was never rendered. (c) Only the missing-tool kind has a live test (a host without git, L-S6.2-c); the other kinds are covered by the unit test that every kind serializes with its fields and by vitest wording. (d) The 500 ms phase polling in `hostConnect.ts` reads `remoteHosts`; there is no host event for phases, so a very fast connect may show no intermediate phase. (e) The live test moves `/usr/bin/git` inside the throwaway container and puts it back in a drop guard; a killed test run leaves the container without git until `run.sh stop` and `start`. (f) `live_test_destination...` calls `test_ssh_args` with parsed arguments because `parse_destination` refuses `UserKnownHostsFile`; the destination parser itself is covered by the existing unit tests.
- **README suggestion (human only):** the getting-started text can describe the first-run screen: choose This computer or SSH, add an SSH connection with Test connection, pick a folder, then the three-step walkthrough.

### R-S6.2-8: P6 review, "failed" is not "given up"
- **Kind:** fix of R-S6.2-2 (the rule held in its text but not in the code).
- **What:** `RemoteManager::status()` reports `failed` (error `DISCONNECTED`) for a connected host whose channel died, until the 1 s supervisor tick marks it `reconnecting`, and `connect_host` sets `failed` at the end of every failed attempt before `reconnect_finished` sets `reconnecting`. The page polls every 3 s, so `shouldShowSetup` on `state === "failed"` could flash the full-window setup screen over the board on a link drop. `RemoteHostView.gave_up` is now computed by `RemoteManager::gave_up`: state `failed` and (the host is not wanted, or the error is one `worth_retrying` refuses: unknown or changed host key, refused login). A host whose first connect failed (never wanted) is given up on, as before. `shouldShowSetup` reads `gave_up`. Tests: `a_failed_host_is_given_up_on_only_when_nothing_will_retry_it` (Rust, the DISCONNECTED window included) and the rewritten `setup.test.ts` cases.
- **Reverse:** drop `gave_up` from `RemoteHostView`/`types.ts` and test `state === "failed"` in `shouldShowSetup`.
- **Files:** `alinery-app/src-tauri/src/remote.rs`, `alinery-app/src/setup.ts`, `alinery-app/src/types.ts`, tests.
- **Unverified:** the window itself is a few seconds at most and was not observed in a real app; L-S6.2-d now watches the board for 90 s with the container stopped.
