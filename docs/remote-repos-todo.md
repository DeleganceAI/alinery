# Remote repositories: master todo

Branch `remote-daemon`, PR #154 (base: PR #135's branch). One item at a time: implement, test (unit, then the Docker sshd for anything on the wire), commit, push. Tick the box and add the commit when an item lands.

Test procedure: `scripts/tests/remote-sshd/run.sh start`, export the line it prints, `cargo test -p alinery-app --lib -- tests::remote::live`, `run.sh stop`. Rebuild the Linux runtimes (`bash scripts/build-remote-runtimes.sh`) after a change to `alinery-core`, `mcp/` or `vinculum-daemon/`.

## A. Gaps left from the original plan (in this order)

- [x] **A1. Reconnect.** A per-host supervisor that notices a dead master or channel, retries with 5, 10, 30, 60 s backoff, and re-attaches the open session when the host is back. It never stops anything on the host (`check-ssh-spawn.sh` keeps that honest). The host list and repo badge show "reconnecting".
  - Done: the live test kills the ssh master and the host comes back with the same daemon pid. A terminal that paused rejoins on the `remote_host_connected` event; that part has no automated test (no terminal harness in vitest) and has not been seen running.
  - Not covered: a daemon that crashes while its host stays connected is only respawned on the next reconnect. A watchdog would have to avoid replacing the approval secret of a daemon that is merely slow (`ensure_remote_daemon` writes a new one before it spawns).
- [x] **A2. Quit.** `close_all_repos` and the quit dialog with remote repos: "close all repos" detaches remote hosts (ends ssh only), never reports a failure for them, and says in the dialog that remote sessions keep running.
  - Done: the live test shows close-all succeeding with a remote repo open, the host idle afterwards, and the same daemon pid after reconnecting. The dialog lists each remote repo as "stays running on its host" and counts only local sessions as work that would be lost; `repo_live_sessions` now counts a connected remote repo (it read 0 before). The dialog itself has no automated test beyond the row helper.
  - Not covered: Cmd+Q is unchanged (it never closes anything).
- [x] **A3. Stop or replace a remote daemon, deliberately.** After an app update bumps the protocol or the identity, a remote daemon shows as conflicted and nothing in the UI can replace it. Add a confirmed "Stop daemon on {host}" (lists live sessions first) and a "Restart with this app's version" that stops, waits for the socket to go, then spawns the new runtime. This is a fifth deliberate teardown origin, so it joins `check-no-auto-session-kill.sh`'s allowlist and AGENTS.md.
  - Done: an unusable remote daemon is now recorded as a conflict (it used to fail the attach, so the repo could not even be opened), the repo opens with its board readable, and the banner's *Restart daemon…* (and Settings → Stop all sessions, which now accepts a remote repo) runs `stop_remote_daemon`: shutdown over the forward, new `RepoOp::WaitDaemonGone` on the host, then the normal attach starts the daemon from the installed runtime. The live test starts a daemon under another settings file, sees the conflict, checks that attaching replaces nothing, then replaces it on the confirmed stop.
  - Changed from the plan: stop and restart are one action, as locally (a stop that left the repo daemonless would only be undone by the next reconnect). The old daemon is made with another settings file, not an older binary; a protocol mismatch takes the same path but has no test of its own.
  - Not covered: sessions of an older daemon are listed by id only (no names).
- [x] **A4. Remote storage.** `storage_info` and `delete_all_archived_storage` for a remote repo. The numbers and the purge run on the host and are reported back to the app. Design to settle when we get here: daemon ops through `libalinery_core` (the daemon reports, and survives disconnects) versus repo-service ops (work with the daemon down). Paths shown in the UI are host paths.
  - Done as repo-service ops (`StorageInfo`, `PurgeArchived`), not daemon ops: storage is a stateless walk of `.alinery`, it must work while the daemon is down or conflicted, and a daemon op would need a protocol bump that conflicts every running daemon. `StorageInfo` and `storage_info_in` moved into `alinery-core` so the host builds the same struct the app showed before. The purge kills sessions still running under an archived task through the host's own daemon, as the local purge does. Settings hides "Reveal in Finder" for a host path (copy stays). A live test measures and purges on the sshd.
  - Not covered: the purge kills nothing when the host's daemon is a conflict (an older daemon cannot be asked), so a live session under an archived task there would lose its files while running.
- [ ] **A5. Remote backups.** Backup now, list, restore and the automatic triggers for a remote repo. Archives live on the host. The daemon is the natural owner of the automatic triggers and of reporting status (last backup, busy, failures) to the app, since it outlives the app. Restore must work with the daemon down, because it stops the daemon first. Depends on the A4 design call.
- [ ] **A6. Performance plan.** A written plan, not code: measure first (round trips per board load, bytes per transcript poll, time to first paint of a remote board over a slow link), then list changes with expected gains. Starting points: a poll-rate floor while busy, the transcript ETag (`if_none_match`), batching the board's per-task reads into one repo-service op, and compression. Lands as `docs/remote-repos-performance.md`. Implementation is separate items added to this file.

## B. UX slices

- [x] **B1. Remote button, hosts modal, setup view with SSH config aliases, reconnect shortcut** (`9e827179`).
- [ ] **B2. Sign in on the host.** A per-host idle daemon so sign-in works before any repo exists, an explicit sign-in target (`host_id`) on the provider commands, a Sign in step in the wizard (device code or pasted code through the existing broker), and API keys entered directly on the host.
- [ ] **B3. Settings, Hosts tab.** Host cards (repos, hosted-model expiry and renew, key sharing, host sign-ins), remove host (delists repos, never stops sessions, offers to erase what the app copied), rename, expiry badges. Moves the small host list out of Connections.
- [ ] **B4. Keep the hosted token fresh.** Re-push `inference.json` to connected hosts from the 30-minute refresher.
- [ ] **B5. Polish.** Command palette entry, onboarding, accessibility.

## C. Backlog (not scheduled)

- Mirror the global playbook library, skills and `mcp.json` to hosts.
- Host-key fingerprint display, richer logind and sshd-forwarding messages, a remote log tail.
- `DaemonStatus.remote` (connected, reconnecting, offline, phase).
- Test matrix: ubuntu:20.04, rockylinux:8 (the glibc floor), arm64 through buildx, Alpine refused. The arm64 binary has never run.
- Runtime directory cleanup on hosts (documented non-goal for now).
- A manual `VERIFY.md` with a logind matrix (linger, `KillUserProcesses`) on a real VM.
- A real agent session on a real Linux host with real credentials. Never done.
- Real OAuth providers over ssh (device code and pasted code). Untested.
- A prompt when a session needs a provider the host lacks.
- Outside this repo: accounts-service host-scoped, revocable hosted tokens (prompt already given).
- AGENTS.md: the Harness Registry and launch-list lines were not audited against Vinculum.
- README suggestions for the human: the remote button and SSH-alias setup; the credentials-are-chosen model.

## Done

Groundwork, runtimes and transport, board reads, sessions and tasks, approvals over ssh, artifacts, chat, git, subtasks, playbooks, settings, drafts and imports, file operations, the host `app.toml` allowlist, credential consent (nothing copied until chosen, sign-ins never copied), AGENTS.md update and the sshd helper (`fca55f29`).
