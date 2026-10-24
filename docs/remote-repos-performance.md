# Remote repositories: performance plan

A plan, not code. It lists what the remote path costs today, in what order to fix it, and how each fix is proved. Every number marked *estimate* comes from reading the code; nothing here has been measured on a real link yet, and step M1 exists to replace the estimates before any other step changes behavior.

The items that follow from this plan are tracked in `docs/remote-repos-todo.md` (section P).

## What a remote call costs

One OpenSSH ControlMaster carries everything for a host, so there is one TCP connection and no per-call login. Two kinds of call ride on it.

| Path | Used for | Cost per call | Notes |
|---|---|---|---|
| repo-service channel (`RepoOp`) | board reads, files, git, backups, storage | 1 RTT plus host time | One persistent stdio channel per host. Requests carry an id and are answered out of order, so calls overlap. 30 s timeout (`SERVICE_TIMEOUT`). |
| daemon op through the forward | session status, sessions, transcripts, prompts, approvals | about 2 RTT | Each op opens a new connection to the forwarded socket, and ssh opens a new channel to the host's socket before the request can go. 3 s timeout for observations. |
| PTY stream | terminal output | continuous | One long-lived connection per attached session. Not polled. |

`Compression=yes` is set on the master, which helps the JSON a lot and costs CPU only.

At 100 ms RTT a repo-service call is about 0.1 s and a daemon op about 0.2 s. A screen that makes five sequential calls is a second of waiting even though nothing is slow on the host.

## Findings from reading the code

**F1. Remote calls block threads that must not block.** Tauri runs a command that is not `async` on the main thread, and an `async` command that does not hand blocking work to `spawn_blocking` ties up an async runtime worker.

- About 30 synchronous commands make a remote call directly: 19 in `artifacts.rs` (read, comments, drafts, review handoff), 6 in `session.rs` (`rename_session`, `get_session_display`, `mark_session_notification_read`, `ensure_drawer_terminal`, `prepare_review_approval_prompt`, `finalize_session_message_actions`), `set_pr_url*`, `subtask_state`, `discard_subtask`, `rename_task`, `read_chat_image` and `write_chat_attachment_bytes`.
- Eight `async` commands make the call on a runtime worker: `list_board_tasks`, `list_tasks`, `get_task`, `list_sessions`, `list_artifacts_with_metadata`, `open_session`, `session_status`, `session_statuses`. `daemon_status` does the same through `session_statuses_observed()`. (`list_session_items`, `session_list_statuses`, `list_task_activity` and `chat_transcript` already offload.)
- On a local disk this is invisible. On a 150 ms link every one of these is a frozen window for at least one RTT, and with the link down it is up to 30 s (`SERVICE_TIMEOUT`).
- `scripts/tests/check-blocking-commands.sh` checks a fixed list of local commands. No gate covers remote-routed commands, which is how this got in.

**F2. Pollers can pile up.** The board views (`Kanban`, `Grid`, `TaskList`) and `useDaemonStatus` use `setInterval` with no in-flight guard. If a call takes longer than the interval, the next tick starts another one, and each holds a blocked thread (F1) until it times out. Only `useBoardTaskActivity` chains its next call after the last one returns.

**F3. The idle load is high and mostly duplicated.** With a remote board open and nothing running, the app issues, per remote repo (*estimate*, by interval and path):

| Poller | Interval | Remote calls per tick |
|---|---|---|
| Board: `list_board_tasks` (`list_kanban_columns` is static) | 3 s | 1 repo-service (1 RTT) |
| Board activity: `list_task_activity` | 3 s | 1 daemon op (all session statuses) + 1 repo-service that uploads those statuses (3 RTT) |
| `daemon_status` | 1.5 s | 1 daemon op (all session statuses), counted and thrown away (2 RTT) |
| Session notices: `list_session_items` + `session_list_statuses` | 5 s | 2 repo-service + 1 daemon op (all session statuses) (4 RTT) |
| Open session: `session_status` | 1.5 s per session view | 1 repo-service (**all** sessions of the task, filtered here) + 1 daemon op (3 RTT) |
| Terminal drawer tabs: `session_status` | 1.5 s per tab | the same 3 RTT, per tab |
| Chat rail: `session_list_statuses` (`list_chat_repos` is local) | 3 s | 1 repo-service + 1 daemon op (3 RTT) |

That is about 3 to 4 requests per second and 5 to 6 round trips per second with one open session, before any agent runs; each extra drawer tab adds 2 RTT per second. The same "all session statuses" daemon query is issued by four different pollers, each paying 2 RTT and receiving the same answer.

**F4. The board is serial across repos.** `list_board_tasks` and `remote_task_activity` loop over repositories one after another. With several remote repos the board costs the sum of their RTTs, not the maximum, and one slow host delays the others. The local path fans out.

**F5. Chat transcripts resend everything.** `watchVinculumTranscript` pulls the whole transcript every 1 s when idle and every 200 ms while the agent streams. Each pull is a daemon op (2 RTT) and a payload that grows with the conversation. The daemon has no "unchanged" answer (no `if_none_match`), so a long conversation costs the same bytes whether anything changed or not. At 200 ms the poll cannot keep up on a slow link; it degrades to back-to-back pulls.

**F6. A dead link is found late.** `ServerAliveInterval=15` and `ServerAliveCountMax=3` mean ssh notices a silent link after about 45 s. The 3 s observation timeout hides this for daemon reads; the 30 s repo-service timeout does not.

## Targets

These are proposals to argue with, stated for a 100 ms RTT, 10 Mbit/s link.

| Target | Budget |
|---|---|
| UI thread blocked by a remote call | 0 ms, whatever the link does |
| Board paint after the repo is open | 1 RTT of waiting for tasks and columns, plus activity in the same round trip |
| Click on an action to visible effect | 1 RTT plus host time |
| Idle, board open, nothing running | at most 1 request per second per host, under 2 KB/s |
| Streaming chat | bytes proportional to new content, not to the conversation |
| Link down | reads fail in 3 s, the window never freezes, pollers back off |

## The plan, in order

Each step names what changes, why, the expected gain, the risk, and how it is proved. Steps are ordered so that the safe, mechanical ones come first and each later step can be judged on measured numbers.

**M1. Measure.** Nothing else starts until this exists.
- Count every remote call by name: calls, duration (p50, p95), bytes up and down. Record in `RepoChannel::call` and in the `DaemonClient` observation path that remote repos use. Keep it in memory and expose it through one debug command and the existing log, so it ships without a new UI.
- Add latency to the test sshd. `scripts/tests/remote-sshd/run.sh start --latency-ms 50` runs the container with `NET_ADMIN` and `tc qdisc add dev eth0 root netem delay 50ms` (iproute2 added to the Dockerfile). Delay on the container's egress adds 50 ms to every reply, which is enough to expose serial chains.
- Script a scenario against that host: open the repo, load the board, open a session, idle for 60 s, stream a chat for 30 s. Record the table from F3 as numbers. Commit the baseline in this file.
- Proves: the estimates in F3 and F5, and gives each later step a number to beat.

**P1. Never block a UI or runtime thread on a remote call (F1).**
- Make every remote-routed command `async` and run its remote arm in `spawn_blocking`. This is mechanical: the same `off_main_thread` shape the backup, storage and archive commands already use. The local arm keeps its current behavior.
- Add a gate that fails when a `#[tauri::command]` reaches `remote_call`, `repo_client`, `task_client` or a channel call without `async` and `spawn_blocking`. The scan used to write this plan is a few lines of awk and becomes the gate.
- Expected gain: the freeze disappears. No change in bandwidth or call count.
- Risk: low. Tauri async commands cannot hold `State<'_>` across an await without care, which is why the existing pattern clones the `AppHandle` into the closure.
- Proof: the gate, plus a live test that holds the host's channel and checks a command returns control within the budget (the call itself may still time out).

**P2. Pollers that cannot pile up or run for nothing (F2).**
- One in-flight guard per poller: chain the next call from the previous one's completion, as `useBoardTaskActivity` already does.
- Back off while a call fails or the host is not connected, and stop while the window is hidden or the view is not shown.
- Raise the chat transcript busy floor from 200 ms to 750 ms for a remote repo. This is the no-protocol-change half of F5.
- Expected gain: bounded concurrency on a slow link; idle load drops when nothing is visible.
- Risk: low. Proof: vitest with fake timers on the guard; M1 numbers for the idle scenario.

**P3. One host-side board snapshot (F3, F4).**
- New `RepoOp::BoardSnapshot { repo }`: the host reads its own task files, asks its own daemon over the local socket for session statuses (the repo service already links `alinery-core` and its `daemon_client`), and returns columns, tasks and task activity together. The app stops uploading statuses to the host.
- The three board views call one command and the activity hook goes away for remote repos. Fan the call out across repositories so the board costs the slowest host, not the sum.
- Expected gain: the 4 RTT of a board tick (tasks, then activity) become 1, and the status upload disappears. With P4 this takes the idle estimate in F3 from about 5.5 RTT per second to about 2.
- Risk: medium. It adds a host-side use of the daemon wire, which must stay inside `alinery-core/src/daemon_client.rs` (`check-wire-parsing-boundary.sh`). It needs no protocol bump because it uses ops the daemon already has.
- Proof: a golden test that the snapshot equals the three separate answers on one temp repo, and the M1 board-tick count.

**P4. Read the daemon from the host (F3).**
- New `RepoOp::DaemonRead` for read-only daemon queries (`session_statuses`, `session_status`, `transcript`), run on the host against its local socket. The reply costs 1 RTT, not 2, and several queries can share one call.
- Move `daemon_status`, `session_list_statuses`, `session_status` and the drawer tabs onto it, and cache the "all session statuses" answer on the host for a short window so three pollers share one query. `session_status` stops fetching every session of the task to find one.
- Expected gain: every polled daemon read drops from 2 RTT to 1, and duplicates collapse.
- Risk: medium. The op must stay read-only and be listed in the no-auto-kill gate's reasoning (it sends no `shutdown`). Writes and PTY streams keep using the forward.
- Proof: round-trip test for each query shape; M1 idle scenario.

**P5. Transcript deltas (F5).**
- A daemon op change: `transcript` takes `if_none_match` and answers `{ unchanged, etag }`, then optionally `since` for appends. The app keeps the last transcript per session.
- This is a wire change, so `PROTOCOL_VERSION` moves (24 to 25) and every running remote daemon becomes a conflict until restarted. Do it together with the next unavoidable daemon change, not on its own, and note the restart in the release notes.
- Expected gain: an idle or slow-moving conversation costs one small request per poll, and a streaming one costs the new text.
- Risk: medium (protocol bump). Proof: Bun tests for the etag, `check-protocol-version-bump.sh`, M1 streaming scenario.

**P6. Push instead of poll.**
- A `Subscribe` stream on the repo-service channel: the host watches `.alinery` and its own daemon locally and sends changes, so idle cost falls to keep-alives and update latency to half an RTT.
- Only worth building if M1 still shows idle load or board latency over budget after P1 to P4. It is the largest change and it adds a long-lived protocol.

**P7. Connection tuning, judged on M1 numbers.**
- Compare `Compression` on and off, and check that `IPQoS` is not penalizing interactive traffic on common networks. Check that the master survives sleep and network changes, and how fast a dead link is noticed (`ServerAliveInterval`).
- Change nothing without a measured difference.

## Not planned

- A second transport or a custom protocol over the master. OpenSSH already gives multiplexing, compression and keep-alive.
- Caching file content on this side. The cost is in call count and blocking, not in bytes of ordinary reads.
- Parallel connections per host. One master is enough once calls overlap (P1) and stop piling up (P2).

## Order and dependencies

```
M1  ->  P1  ->  P2  ->  P3  ->  P4  ->  (P5 with the next protocol change)  ->  P6 only if still needed
                          \-> P7 any time after M1
```

P1 and P2 do not depend on measurement to be right, but M1 first means their effect is recorded. P3 and P4 are the ones whose expected gains need the baseline to be believed.
