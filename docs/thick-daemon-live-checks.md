# Thick daemon: live checks

Running tally of every check that an agent could not make during the build of `docs/thick-daemon-plan.md`, because it needs the desktop app launched, a signing identity, native x64 hardware, a GitHub login, a real network cut, or a person looking at the UI.

**How the user uses this file.** The user runs the live checks once, after P6 (the setup screen), not session by session. Until then every entry stays `open`. Work through the list top to bottom; entries under one session are independent unless they say otherwise.

**Rules for agents.**
- Append your entries; never delete or rewrite an earlier one. To close an entry, the user (or an agent that actually ran it) changes `Status` and adds a dated `Result` line.
- One entry per check. Give it a stable id `L-<session>-<letter>`, the exact steps and commands, the expected result, and `Status: open`.
- Never fake a check you could not run, and never write `pass` for something you did not observe. An agent may set `Status: pass` only for a check it ran itself, with the date and the command's real result under `Result`.
- Decisions, deviations and follow-ups do not go here; they go in `docs/thick-daemon-review-ledger.md`.
- The app is never launched by an agent (AGENTS.md). The Docker sshd may run on linux/arm64 only; never run amd64 images (QEMU has no AVX and Bun crashes).

**Legend.** `<repo>` is a repository the app has open. `<app_config_dir>` is the Tauri app config directory (on macOS `~/Library/Application Support/ai.delegance.alinery`). Commands run from the repository root unless they say otherwise. Toolchain PATH for every shell:

```bash
export PATH="$HOME/.nvm/versions/node/v26.13.0/bin:$HOME/.cargo/bin:/var/folders/7z/66bcytjx0hg3rqq5yz_g81y00000gp/T/alinery-bun-1.4.3/bin:$PATH"
```

## Needs a person to launch the app (open Alinery from this branch)

### L-S1.1-a: AdminService.Hello against an app-started daemon

- **Session:** S1.1 (4.2 row for the app-started Accept). Plan: S1.1 Status, 2.1.7.
- **Steps:**
  1. Launch the app on a repo so it starts the daemon.
  2. Find a token file: `ls <app_config_dir>/rpc-secrets/` (one `<hash>.secret` per repo and lane; use the one for this repo).
  3. ```bash
     proto/node_modules/.bin/buf curl --protocol grpc --http2-prior-knowledge \
       --unix-socket <repo>/.alinery/rpc.sock --schema proto \
       -H "authorization: Bearer $(cat <app_config_dir>/rpc-secrets/<one>.secret)" \
       -d '{}' http://daemon/alinery.v1.AdminService/Hello
     ```
  4. Repeat with `-H 'authorization: Bearer 00'`.
  5. Repeat with no `authorization` header.
  6. `ls -l <repo>/.alinery/rpc.sock` and `ls "$TMPDIR" /tmp | grep alinery-rpc-`.
- **Expected:**
  - Step 3: `"protocol": 25` and capabilities VIEW and ACT only (`buf` is not the shell, so it is not APPROVE or ADMIN).
  - Step 4: `unauthenticated`, exit code 128.
  - Step 5: AGENT capability only.
  - Step 6: `rpc.sock` is `srw-------` (mode 0600; the daemon binds under umask `0o177`) and no `alinery-rpc-*.secret` file is left in the OS temp dir (the daemon deletes the hand-off file after reading it).
- **Status:** open

### L-S1.2-a: Hello through the webview bridge

- **Session:** S1.2 (4.2 row: one Tauri invoke carries a raw `ipc::Request` body and a `Channel`). Plan: S1.2 Accept, 2.1.9.
- **Steps:** launch the app on a repo. Open the webview devtools console and run:
  ```js
  await (await import("/src/daemon/transport.ts")).admin("<repo key>").hello({})
  ```
- **Expected:** a reply with `protocol` 25 and capabilities VIEW, ACT, APPROVE and ADMIN. If it fails, O2 is open again: stop and tell the planner (4.2).
- **Status:** open

### L-S1.2-b: A stream is cancelled when the window closes or the page reloads

- **Session:** S1.2 (the `Destroyed` window hook has no automated test; 4.1 S1.2 build).
- **Steps:** in the same webview open a long stream call (for example `SyncService.Subscribe` through `daemon_rpc`, via the board or `useDaemonStatus`). (1) Reload the page (Cmd+R). (2) Open a second window or repo view that holds a stream, then close that window. After each, inspect the daemon for open streams: tail `<app_config_dir>/logs/alinery.log` or run `lsof -U | grep rpc.sock` and count connections before and after.
- **Expected:** no stream is left open on the daemon after either. Known caveat from the S1.2 review: a reload only cancels once the daemon next sends data (the 15 s heartbeat), so allow 20 s before judging an idle stream.
- **Status:** open

### L-S1.2-c: connect-web reads a streamed Response from bridgeFetch in WKWebView and WebKitGTK

- **Session:** S1.2 (4.2 row; the spike ran under Bun only).
- **Steps:** with the app on macOS (WKWebView), open a repo and watch a server stream deliver more than one frame over time (a `SyncService.Subscribe` stream; start a terminal session and watch the Settings live count move, which arrives as a delta frame). Repeat on a Linux desktop build (WebKitGTK) when one exists.
- **Expected:** frames arrive as they are produced, not all at once when the stream ends. A buffered response would show no update until the stream closes.
- **Status:** open (macOS), open (Linux)

### L-S1.2-d: A SyncService.Subscribe stream reaches the real webview

- **Session:** S1.2 / S2.1 (left for S3.1). Plan: S2.1 Accept, 2.1.9.
- **Steps:** launch the app on a repo and run in the devtools console (the same pieces `src/sync/hooks.ts` uses; the scope argument is whatever `Scope` shape that file passes for the repo scope):
  ```js
  const { createClient } = await import("@connectrpc/connect");
  const { SyncService } = await import("alinery-proto/alinery/v1/sync_pb");
  const { daemonTransport } = await import("/src/daemon/transport.ts");
  const c = createClient(SyncService, daemonTransport("<repo key>"));
  for await (const f of c.subscribe({ scope: { /* as in src/sync/hooks.ts */ } })) { console.log(f); break; }
  ```
  The simpler check is to open any board view or Settings and confirm rows and the live count appear (they come from this stream).
- **Expected:** the first frame is a snapshot with `complete: true`; later frames are deltas; a heartbeat arrives at 15 s.
- **Status:** open

### L-S1.3-c: A remote repo answers Hello through the bridge

- **Session:** S1.3. Plan: S1.3 Accept, 4.2 row.
- **Steps:** with a remote repo open (the remote-sshd container or a real Linux host), in the devtools console:
  ```js
  await (await import("/src/daemon/transport.ts")).admin("<remote repo key>").hello({})
  ```
- **Expected:** protocol 25 and a capability set that includes VIEW, ACT, APPROVE and ADMIN (the token alone grants them over ssh, since a remote daemon is started without `ALINERY_HOST_EXECUTABLE`).
- **Status:** open

### L-S1.4-a: Stop daemon from Settings names its origin

- **Session:** S1.4. Plan: S1.4 Accept.
- **Steps:** launch the app on a repo. Settings, Harness, Stop daemon, confirm. Then `grep 'shutdown requested' <app_config_dir>/logs/alinery.log | tail -3` and `ls <repo>/.alinery/rpc.sock`.
- **Expected:** the daemon is gone, the log shows `shutdown requested: origin=STOP_DAEMON`, and the socket file is gone or refuses connections.
- **Status:** open

### L-S1.4-b: Take over a daemon of an older protocol (old-op fallback)

- **Session:** S1.4. Plan: S1.4 Accept; 4.1 S1.4 build (choice 2).
- **Steps:** start a daemon from another build whose protocol is older than 25 (for example from `main` or the base branch's last release), so it has no `rpc.sock`, or a token this app lacks. Open the same repo in this app and choose **Take over {repo}** and confirm.
- **Expected:** the old daemon stops through the legacy JSON `shutdown` op (its log or `alinery.log` shows the takeover origin), this app's daemon then starts and owns the repo. A daemon that answers on `rpc.sock` and refuses (wrong token) is an error, never retried on the old wire.
- **Status:** open

### L-S3.1-a: Live session count moves without polling

- **Session:** S3.1. Plan: S3.1 Accept; 4.2 row.
- **Steps:** launch the app with a local repo and a remote repo open. Start a Terminal session in each. Open Settings, then Chat, then Harness. Open the webview network panel (devtools, Network) and watch for 30 s.
- **Expected:** the live-session count in Settings moves within a second of the session starting or exiting; the network panel shows no repeating `daemon_status` or `repo_live_sessions` calls (`repo_live_sessions` no longer exists; `daemon_status` is called on open, on focus and on a link flip only).
- **Status:** open

### L-S3.1-b: Status dot, HotkeyBar and close dialog counts come from the stream

- **Session:** S3.1 (carries the over-the-bridge Subscribe check from S2.1).
- **Steps:** with two or more sessions running (one busy, one waiting for input if you can arrange it), look at the status dot, the HotkeyBar counts, then close the window.
- **Expected:** the dot colour and the HotkeyBar counts agree with the sessions; the close dialog names the right number of live sessions (local) without a visible delay of more than 3 s.
- **Status:** open

### L-S3.4-a: Terminal feel through the bridge and an ssh forward (O8)

- **Session:** S3.4. Plan: O8, 4.1 `S3.4 build (v0.9)`, 4.2.
- **Steps:**
  1. Local baseline: `bun alinery-app/src-tauri/vinculum-daemon/src/rpc/terminal.bench.ts 2000 paths` (records p50 and p99 for the re-created old op path and for `TerminalService`; on the build machine: old 0.25 / 0.84 ms, TerminalService 0.54 / 1.90 ms).
  2. In the app, type into a local Terminal session, then into a remote one. Compare the feel and any lag with an older build (the base branch's app) on the same repo.
- **Expected:** no lag you can feel. The plan rule is that the split path is no more than 5 ms slower at p50. If you can feel it, O8 (b) (a WebSocket tunnel) goes back to the user. There is no timing harness through `daemon_rpc`, so this is by feel unless you add one.
- **Status:** open

### L-S3.4-b: No byte lost or repeated across an ssh drop

- **Session:** S3.4. Plan: S3.4 Accept.
- **Steps:** in the app, open a remote Terminal session. Run `seq 1 100000`. While it prints, on the Mac run `ssh -O exit <host>` (use the ControlPath from `/tmp/alinery-<uid>/`; `ssh -O exit -S /tmp/alinery-$(id -u)/<socket> <host>`). Wait for the reconnect, let `seq` finish, then select the output or save it (`seq 1 100000 | tee /tmp/seq.out` is not enough; copy the terminal text or read `sessions/<id>.scrollback`).
- **Expected:** every number from 1 to 100000 appears exactly once, in order. Check with `grep -E '^[0-9]+$' <scrollback> | sort -n | uniq -c | awk '$1!=1'` printing nothing and `wc -l` equal to 100000.
- **Status:** open

### L-S3.4-c: O5 decision from the echo-under-load numbers

- **Session:** S3.4; plan 1.7 O5 (the user decides before S4.2), 4.1 `S3.4 build (v0.9)`, 4.2 row.
- **Steps:** read the figures and decide, then confirm the build is still acceptable in the app:
  - idle p99 1.84 ms;
  - one task creation with 4 attachments every 200 ms: 4.0 ms (+2);
  - 4 parallel `writeDurable` every 20 ms: 26.2 ms (+24);
  - reconcile pass over 1,000 tasks back to back: 7.4 ms (+5.6);
  - `git status` loop: 1.0 ms; `tar -czf` child: 1.0 ms;
  - everything together: 11.6 ms (+9.7).
  Rerun with `bun alinery-app/src-tauri/vinculum-daemon/src/rpc/terminal.bench.ts 2000` and its load flags, or `docs/thick-daemon-spikes/src/echo-load.ts`, on your own disk, then type in a Terminal session while a task is created with attachments and a backup runs.
- **Expected:** a decision. The unattended run took the plan's working assumption, O5 (a) one process until P7 (see the ledger, R-O5), because the two rows over 5 ms (reconcile and a write flood) are synthetic floods; reversing is the (b) keeper split in S7.1. The cause of the 20 to 26 ms loop gaps while `F_FULLFSYNC` is in flight on the Worker is not isolated (4.2). If typing stutters during a task creation, say so.
- **Status:** open

### L-S3.5-a: Board with a lost host and an incompatible daemon

- **Session:** S3.5. Plan: S3.5 Accept; 4.2 row.
- **Steps:** launch the app with a local repo and a remote repo open. (1) Cut the remote host's network (turn off Wi-Fi to the host, or `sudo pfctl`/unplug; do not run `ssh -O exit`, which is a different test). Watch both boards. (2) Restore the network. (3) Open a remote repo whose daemon is incompatible (start its daemon from a different protocol or app-config identity). (4) In the network panel look for board polling.
- **Expected:** (1) the remote repo shows "daemon not connected, showing the last known tasks" while the local board keeps updating; (2) it recovers without restarting the app; (3) the incompatible repo shows only its banner (Restart daemon) and no tasks; (4) no repeating board calls.
- **Status:** open

### L-S6.2-a: P6 exit check (setup screen and onboarding)

- **Session:** S6.2 (not built yet; listed so the tally is complete). Plan: S6.2 User-run bullet.
- **Steps:** with an empty app config dir, launch the app. It must open on the setup screen with "This computer" selected. A local repo goes through onboarding to its board; a second local repo goes straight to its board. Against the remote-sshd container (arm64), the first repo on the new host goes through onboarding and a second repo on it does not.
- **Expected:** as described. This is the P6 exit check and the moment the user runs every other open entry.
- **Status:** open (session not built)

### L-S4.1-a: Repository settings through the daemon (write, disk edit, conflict)

- **Session:** S4.1. Plan: S4.1 Accept; ledger R-S4.1-6.
- **Steps:** launch the app on a scratch git repo `<repo>`. (1) Settings, pick the repo in the scope list, change Thinking to another value. Watch the field: it shows the new value at once and keeps the "Repository override" label. `shasum -a 256 <repo>/.alinery/config.toml` before and after. (2) Edit `<repo>/.alinery/config.toml` by hand (change `thinking`) and save; do not touch the app. (3) Open a second Alinery window on the same repo (or edit the file between the field showing a value and you pressing a second change), then change the same field in both. (4) Clear the override with the field's reset control.
- **Expected:** (1) the value stays after the daemon's row arrives and `config.toml` holds the new value in the `[defaults]` table; (2) the open Settings page shows the hand edit within a second without a reload; (3) the second writer sees the toast "these settings were changed elsewhere; showing the newer values" and the newer value, and `config.toml` holds the first writer's value; (4) the field returns to the global value labelled "Global". A Create task page opened afterwards starts with the repo's effective harness and model.
- **Status:** open

### L-S4.1-b: A repository opened for the first time gets its files from the daemon

- **Session:** S4.1. Plan: S4.1 Accept (`EnsureReady`, run twice); ledger R-S4.1-1.
- **Steps:** `git init /tmp/s41-scratch && cd /tmp/s41-scratch && git commit --allow-empty -m init`. Add it as a repository in the app. Then:
  ```bash
  ls -la /tmp/s41-scratch/.alinery
  git -C /tmp/s41-scratch check-ignore -q .alinery/tasks; echo "ignored: $?"
  find /tmp/s41-scratch/.alinery -type f -newermt '1970-01-01' -exec stat -f '%m %N' {} + | sort > /tmp/s41-before.txt
  ```
  Close and reopen the repo in the app (the shell calls `EnsureReady` again), then repeat the `find` into `/tmp/s41-after.txt` and `diff /tmp/s41-before.txt /tmp/s41-after.txt`. Also `grep ensure-ready-failed "<app_config_dir>/logs/alinery.log"`.
- **Expected:** `config.toml` and `harnesses.toml` exist, `ignored: 0`, the diff shows no changed mtime other than socket and lock files the daemon rewrites, and the log has no `app.ensure-ready-failed` line. (The unit test `rpc/settings.test.ts` covers the same calls against a real gRPC server; this run adds the shell's call after attach.)
- **Status:** open

### L-S4.1-c: Repo settings telemetry reaches a local listener, and consent off sends nothing

- **Session:** S4.1. Plan: S4.1 Accept (telemetry); ledger R-S4.1-3.
- **Steps:** in `<app_config_dir>/app.toml` set `[telemetry]` `enabled = true`, `prompted = true`, a non-empty `install_id`, and `endpoint = "http://127.0.0.1:8099"`. In a terminal run `nc -l 8099` (or `python3 -m http.server 8099` and read its log). In the app change one repository setting (L-S4.1-a step 1). Then set `enabled = false`, restart nothing, and change another setting.
- **Expected:** with consent on, one `POST` arrives within 3 s whose JSON body has `"event":"settings.change"`, `"source":"alineryd"` and `"scope":"repo"` and no repository path, slug or token; with consent off the listener receives nothing within 3 s, and the setting still saves.
- **Status:** open

### L-S4.2-a: Approve a gated step and watch the execution views follow the daemon

- **Session:** S4.2. Plan: S4.2 Accept; ledger R-S4.2-1, R-S4.2-2, R-S4.2-8.
- **Steps:** launch the app on a scratch git repo with a playbook that has a locked (human-gated) step. Create a task and start its first session. (1) Open the task detail and the session: they show the execution, with no 1.5 s or 3 s poll in the network panel. (2) When the locked step is ready, press Approve in the session. (3) With the task page also open, watch it move without a reload. (4) Press Approve a second time quickly, or from two windows.
- **Expected:** (1) the page updates on the daemon's push; (2) the step completes and the receipt shows; (3) the task detail shows the same state; (4) the second approval is refused with a revision mismatch message and the first stands. `<repo>/.alinery/tasks/<slug>/execution.json` has an `engine` block and its `revision` rose.
- **Status:** open

### L-S4.2-b: A task from the old runner shows as history and cannot be approved or started

- **Session:** S4.2. Plan: S4.2 Accept (O21); ledger R-S4.2-3.
- **Steps:** put a task from an earlier build in a scratch repo (an `execution.json` with records, no `engine` block and no `engine.jsonl`). Open the repo in the app, then the task and its queued session. Restart the daemon (Settings, Stop daemon, reopen).
- **Expected:** the task shows its execution records; Approve and "Start this queued session" are disabled; no session starts after the restart; `execution.json` is unchanged byte for byte.
- **Status:** open

### L-S4.2-c: A step's file states survive a live edit and an archive prunes them

- **Session:** S4.2. Plan: S4.2 Accept (O27); ledger R-S4.2-5, R-S4.2-6.
- **Steps:** run a fork and join to completion. In `<repo>/.alinery/tasks/<slug>/executions/<execId>/` note the manifest hashes and `ls objects/`. Edit an artifact an earlier step had consumed, restart the daemon, and `shasum -a 256` the object named in the manifest. Then archive the task in the app. Repeat with a sub-task finished from its manager (and one killed): its `objects/` goes the same way.
- **Expected:** the object's hash equals its file name and the original bytes, whatever the live file now holds; after the archive, finalize or kill `objects/` is gone and the manifests remain.
- **Status:** open

### L-S4.2-e: A real coding step records its working files under a ref
- **Session:** S4.2 (review fix). Plan: S4.2 Accept (O27, "a git-worktree step still resolves its recorded tree"); ledger R-S4.2-10.
- **Steps:** with the app running, run a playbook with a coding step (the bundled `superdevelop` build step) in a git repository to acceptance, leaving a file uncommitted in the task worktree. Then `git -C <worktree> for-each-ref refs/alinery/executions` (the refs read `refs/alinery/executions/<slug>/<execId>`; run a second task with a coding step in the same repository and check the first task's ref is unchanged) and `git -C <worktree> ls-tree -r <ref>`. Run `git -C <worktree> gc --prune=now` and repeat the `ls-tree`.
- **Expected:** one ref per accepted coding execution; the tree lists the uncommitted file with its content at acceptance; `git status` of the worktree is unchanged by the recording; the tree survives the gc. The daemon log has no `worktree not recorded` line.
- **Status:** open

### L-S4.3-a: Create a task with a pasted image and an attachment; the card shows at once and once

- **Session:** S4.3. Plan: S4.3 Accept (vitest "created task shows its card before the delta, and exactly once after"); ledger R-S4.3-1, R-S4.3-8.
- **Steps:** launch the app on a scratch git repo. New task: a name, a description, paste an image into the description, add one file with the file picker and drop another from Finder. Create. Watch the board (Grid and Kanban) while it creates.
- **Expected:** the card appears the moment the create returns, before any reload, and stays a single card; the task opens with the ticket listing `attachments/<file>` for each file; `<repo>/.alinery/tasks/<slug>/artifacts/attachments/` holds the files and `shasum -a 256` of each equals the original; `<repo>/.alinery/worktrees/<slug>` is a worktree on branch `<slug>`; no file is left in `<repo>/.alinery/tmp/uploads`. Creating a second task of the same name gets `<slug>-1`.
- **Status:** open

### L-S4.3-b: Duplicate, rename, archive and restore

- **Session:** S4.3. Plan: S4.3 Build; ledger R-S4.3-1, R-S4.3-5.
- **Steps:** on a task from L-S4.3-a: Duplicate it; rename the copy; archive it (with and without "remove worktree"); restore it from the archived list; toggle Auto approval all; add and remove a related task.
- **Expected:** the duplicate keeps the ticket, the attachments and the playbook; each change shows on the board without a reload; archive removes the card and restore brings it back; restore does not bring `executions/*/objects` back; the related-task symlinks under `<task>/related/` match the list.
- **Status:** open

### L-S4.3-c: The pre-archive backup failing keeps the task

- **Session:** S4.3 (the WA until S4.9). Plan: S4.3 Accept; ledger R-S4.3-2.
- **Steps:** in Settings, Backups: set a destination that is a plain file (`touch /tmp/not-a-dir`), enable the archive trigger. Archive a task. Then set a good destination and archive again.
- **Expected:** with the bad destination the archive does not happen, the task stays on the board, and a message names the backup failure; with the good one a backup zip appears and the task archives. With the trigger off or no destination, archive proceeds with no backup. Say whether the wait feels long on a large repo.
- **Status:** open

### L-S4.3-d: A draft with large pasted images through the bridge

- **Session:** S4.3. Plan: 2.1.5 (128 MiB receive limit); ledger R-S4.3-4.
- **Steps:** start a task, paste three 8 MB images into the description, wait for the autosave, close the form, reopen the draft. Then paste images totalling over 100 MB.
- **Expected:** the draft reopens with its images (read through BlobService); the over-limit paste is refused with a readable message, not a hang or a blank form.
- **Status:** open

### L-S4.3-e: Opening a session on a draft or archived task is refused by the daemon

- **Session:** S4.3. Plan: S4.3 Build (open_session preflight); ledger R-S4.3-6.
- **Steps:** with a saved draft, try to open a session on it (via a stale tab or the Sessions list). Archive a task that has a session and try to attach to that session. Open a plain Terminal session. Sign out of a hosted account and open a hosted-model session.
- **Expected:** the draft and archived cases show the daemon's refusal text and start nothing; Terminal opens; the hosted refresh still runs before the session opens.
- **Status:** open

## Needs a signing identity

### L-S0.5-a: bun:ffi under the hardened runtime

- **Session:** S0.5 (4.2 row; 4.4 handoff). Also gates S2.2's `fsync-worker.ts`, which calls `fcntl` through `bun:ffi`.
- **Steps:** from `docs/thick-daemon-spikes`:
  ```bash
  T=$(mktemp -d)
  bun build --compile src/hardened-probe.ts --outfile $T/hardened-probe
  codesign --force --timestamp --options runtime --entitlements <release daemon entitlements.plist> \
    --sign "Developer ID Application: <team>" $T/hardened-probe
  codesign -dv --entitlements - $T/hardened-probe   # expect flags=0x10000(runtime)
  $T/hardened-probe                                  # expect exit 0 and "ok":true
  ```
  The release plist for the daemon is the one the release pipeline signs the sidecar with (`scripts/omp.entitlements` is the OMP one; ask for the daemon's in `alinery-deploy`).
- **Expected:** `flags=0x10000(runtime)`, exit 0, `"ok":true` after dlopen, two flocks, errno and `F_FULLFSYNC`. If dlopen is refused under the hardened runtime, the O6 answer changes (flock/fsync need another route) and the plan must be reopened.
- **Status:** open

### L-S2.2-a: fsync Worker under the hardened runtime

- **Session:** S2.2 (same signature problem as L-S0.5-a).
- **Steps:** run L-S0.5-a. Then build the real daemon with `scripts/dev-fetch-bun.sh`, sign `alinery-vinculum-daemon` with the same identity and entitlements, start it on a scratch repo, and create a task (a `writeDurable`). `grep -i fullfsync <repo>/.alinery/*.log` or watch that the task appears.
- **Expected:** the Worker runs `F_FULLFSYNC` and the write completes. L-S0.5-a passing is the main evidence; this entry adds that the compiled Worker entry point (`/$bunfs/root/platform/fsync-worker.js`) is reachable once signed.
- **Status:** open

## Needs native x64 Linux hardware (no QEMU, no Rosetta)

### L-S1.1-b: Accept-time peer check sees the shell's executable on x64

- **Session:** S1.1 (4.2 row). The spike's x64 run was under Rosetta, which reads `/proc/<pid>/exe` as `/run/rosetta/rosetta`.
- **Steps:** on a native x64 Linux machine, install a runtime, start a daemon with the app's arguments and `ALINERY_HOST_EXECUTABLE=<path to a stand-in shell executable>` in its environment (`alinery-vinculum-daemon --repo <path> --app-config <dir> --rpc-secret-file <file>`), connect to `rpc.sock` once from the process at that path (copy `grpcurl`/`buf` to it, or a small Bun script) and once as `buf curl` or `curl --unix-socket`, with the right token, and ask `Hello`.
- **Expected:** the shell's connection gets VIEW, ACT, APPROVE and ADMIN; the other process gets VIEW and ACT only. If the executable path cannot be read natively, the peer check is wrong on x64 and the plan's 2.1.10 changes.
- **Status:** open

### L-S2.3-a: Bun fs.watch recursive misses no event on x64

- **Session:** S2.3 (4.2 row; Status line).
- **Steps:** on a native x64 Linux machine or VM (not Docker on Apple silicon):
  ```bash
  cd docs/thick-daemon-spikes && bun install --frozen-lockfile && bun run src/watch.ts matrix --reps 2 --idle-seconds 30
  ```
- **Expected:** Bun's rows show 0 ops with no event and 0 burst misses. If Bun misses an event, stop and ask the planner: `@parcel/watcher` is not a fallback (S0.4, v0.8).
- **Status:** open

## Needs the Linux runtime bundle (zig) and the Docker sshd (linux/arm64 only)

### L-S1.3-a: Build the Linux runtimes

- **Session:** S1.3 (also needed by S1.4, S2.2, S3.4 live tests). The plan decision O15 (b) will later remove the Rust and zig requirement for the host runtime (S5.2), so this entry is for today's tree.
- **Steps:**
  ```bash
  brew install zig
  rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu   # already installed on this Mac
  cargo install cargo-zigbuild                                           # if missing
  scripts/build-remote-runtimes.sh --check
  ALINERY_REQUIRE_REMOTE_RUNTIMES=1 scripts/build-remote-runtimes.sh
  ```
- **Expected:** `alinery-app/src-tauri/resources/remote/<triple>.tar.gz` for both triples and `manifest.json` filled in; the build includes `src/platform/fsync-worker.ts` as a second entry point.
- **Status:** open

### L-S1.3-b: Live remote tests (covers S1.3, S1.4, S3.1, S3.4 and S3.5 changes)

- **Session:** S1.3, S1.4 (`stop_remote_daemon` and the remote restore changed), S3.1 (the conflict live count), S3.4 (the live test starts the shell with `resume_session` and no longer reads bytes).
- **Steps:** after L-S1.3-a:
  ```bash
  scripts/tests/remote-sshd/run.sh start        # prints an ALINERY_TEST_SSH_ARGS line; export it
  export ALINERY_TEST_SSH_ARGS='<printed line>'
  cd alinery-app/src-tauri && cargo test -p alinery-app --lib -- tests::remote::live
  cd ../.. && scripts/tests/remote-sshd/run.sh stop
  ```
  Docker runs the sshd image on linux/arm64 only. Stop what you start.
- **Expected:** all `live_*` tests pass, including the Hello checks in `live_host_installs_browses_runs_a_daemon_and_survives_a_disconnect`; the epoch survives `ssh -O exit` and a reconnect (4.2 row).
- **Status:** open

### L-S2.2-b: Linux runtime completes a writeDurable

- **Session:** S2.2 (optional in its Status; the Worker entry-point change is only proven on macOS arm64).
- **Steps:** after L-S1.3-a, start the Linux runtime's daemon inside the arm64 sshd container (or any Linux host), create a task in a scratch repo (`CreateTask` or the app), then check `task.md` exists with the right bytes and the daemon log has no worker error.
- **Expected:** `writeDurable` completes (two `fsyncSync` calls on Linux); no `ModuleNotFound` for the Worker.
- **Status:** open

### L-S4.1-d: A remote repository's settings and `EnsureReady`

- **Session:** S4.1. Plan: S4.1 (remote hosts); ledger R-S4.1-1, R-S4.1-2, R-S4.1-7.
- **Steps:** after L-S1.3-a and with the runtime rebuilt (`scripts/build-remote-runtimes.sh`, since `alinery-core`, `mcp/` and `vinculum-daemon/` changed), run the live remote tests as in L-S1.3-b. They now include the `remote_github_token` case (a host `config.toml` override over the Mac's global token). Then in the app, with the container host connected and a repository on it open: change a setting in Settings (repository scope); `ssh` to the host and `cat <repo>/.alinery/config.toml`; `cat ~/.local/share/alinery-remote/config/*/app.toml`.
- **Expected:** the live tests pass; the host's `config.toml` holds the new value; the host's `app.toml` has a `[telemetry]` section with this Mac's `enabled`, `prompted`, `install_id` and `endpoint`; a freshly added remote repo has `config.toml`, `harnesses.toml` and the ignore entry before any task is created.
- **Status:** open

### L-S4.2-d: The Linux runtime with protocol 27 and the engine's save on a remote host

- **Session:** S4.2. Plan: S4.2 (remote hosts); ledger R-S4.2-8.
- **Steps:** after L-S1.3-a, rebuild the runtimes (`scripts/build-remote-runtimes.sh`: `alinery-core`, `mcp/` and `vinculum-daemon/` all changed) and run the live remote tests as in L-S1.3-b. Then in the app, with the container host connected and a repository on it open, run L-S4.2-a there; on the host `cat <repo>/.alinery/tasks/<slug>/execution.json | head -c 400`.
- **Expected:** the live tests pass against protocol 27 (a host still on 26 shows the daemon-conflict banner and Restart daemon, not a failure); the approval goes through the forwarded RPC socket; the host file has the `engine` block.
- **Status:** open

### L-S4.3-f: The Linux runtime with protocol 28, and a remote repo's create, attachments and drafts

- **Session:** S4.3. Plan: S4.3 (remote hosts); ledger R-S4.3-7, R-S4.3-10.
- **Steps:** after L-S1.3-a, rebuild the runtimes (`scripts/build-remote-runtimes.sh`: `alinery-core`, `mcp/` and `vinculum-daemon/` changed), start the Docker sshd and run the live remote tests as in L-S1.3-b (`tests::remote::live` was edited to compile: its attachment seed is now a UTF-8 file written through `WriteFile`). Then in the app, on a remote repo: create a task with an attachment, duplicate it, archive it, and try to reveal an attachment.
- **Expected:** the live tests pass against protocol 28 (a host still on 27 shows the daemon-conflict banner and Restart daemon); create, duplicate and archive work through the forwarded RPC socket; the attachment's reveal action is absent for the remote repo; the pre-archive backup runs on the host and obeys the host's own trigger flags.
- **Status:** open

## Needs a Linux machine (any arch)

### L-S0.1-a: proto install and the three alinery-proto tests on Linux

- **Session:** S0.1 (4.2 row; Status "Optional").
- **Steps:**
  ```bash
  scripts/install-proto.sh --with-dev
  scripts/tests/check-proto-gen.sh
  cd proto && bun test && cd ../alinery-app && npx vitest run src/proto.test.ts
  cd ../alinery-app/src-tauri/vinculum-daemon && bun test src/proto.test.ts
  ```
- **Expected:** all pass; `check-proto-gen.sh` reports the checked-in `proto/gen` is current. (Passes under vitest and Bun on macOS today.)
- **Status:** open

## Pointers to checks that belong to sessions not built yet

These have no steps yet; the session that builds them adds the entries.

- **L-S4.7-a (S4.7):** which git the daemon finds on a Mac without Command Line Tools; whether its PATH on a remote host (under `systemd-run --user` or `setsid`) finds the git the setup probe found. The remote-sshd container has no user systemd. (4.2 row.)
- **L-S7.1-a (S7.1):** what a pi-durable session loses on restart; fd passing on Linux (macOS passed in v0.8). (4.2 row.)
- **L-S5.x / L-S6.x:** every session after S3.5 appends its own `userRunItems` here.
