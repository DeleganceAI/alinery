# Thick daemon: commit SHA map (2026-11-06)

The history of branch `remote-daemon` (the 192 commits above the PR #135 base `b476097`) was rewritten on 2026-11-06 to set one author and drop the Claude trailers. 155 of the 192 SHAs changed (the other 37, the first commits, were already correct and kept theirs); trees, subjects and dates did not change. Use this table to find a commit that an old comment, log line or message names by its old SHA.

| Old | New | Subject |
|---|---|---|
| 0991135 | 0991135 | Add the remote repo reference and a per-client observe timeout. |
| 6b554b4 | 6b554b4 | Skip remote repos on purpose, share the daemon launch recipe, add the repo service wire. |
| 8d0dfc7 | 8d0dfc7 | Bundle Linux runtimes for remote repos. |
| 573f79d | 573f79d | Connect to an SSH host, install the runtime, and run a daemon through a forwarded socket. |
| 0e6a7ed | 0e6a7ed | Add the remote repository dialog and the commands behind it. |
| 9fe6b01 | 9fe6b01 | Show a remote repo's board: move the board projection into alinery-core and serve it over the repo service. |
| 3608006 | 3608006 | Remove a host's forwarded sockets when it disconnects. |
| 2b23105 | 2b23105 | Make the task page and sessions work on a remote repo. |
| 67c5a0a | 67c5a0a | Run session and task actions on a remote repo. |
| 24a1156 | 24a1156 | Run artifact reads, review comments and drafts on a remote repo. |
| 5d20a7e | 5d20a7e | Run git actions and sub-task requests on a remote repo. |
| a890b84 | a890b84 | Run attachments on a remote repo, and copy the host path instead of revealing it. |
| 451377f | 451377f | Run chat threads and task restore on a remote repo. |
| d9d3c75 | d9d3c75 | Merge remote-tracking branch 'origin/experimental-pi-durable-as-a-harness' into remote-daemon |
| bbbe1eb | bbbe1eb | Run task duplication and repo settings on a remote repo. |
| 34cfca1 | 34cfca1 | Run the sessions list, session statuses, artifact readiness, notification clearing and task activity on a remote repo. |
| 1d1813b | 1d1813b | Merge remote-tracking branch 'origin/experimental-pi-durable-as-a-harness' into remote-daemon |
| 4489991 | 4489991 | Run task drafts and issue imports on a remote repo. |
| 2a50ad1 | 2a50ad1 | Run the repo playbook library and community imports on a remote repo. |
| d94cd1e | d94cd1e | Let a remote daemon accept approvals from this app (protocol 24). |
| cc15df2 | cc15df2 | Run the remaining file operations on a remote repo, and guard that none is missed. |
| bf91c61 | bf91c61 | Stop copying this Mac's private settings into a remote host's app.toml. |
| ce455ab | ce455ab | Let the user choose which credentials a remote host receives, and stop copying sign-ins. |
| 9e82717 | 9e82717 | Add a remote button and a hosts modal, with SSH config aliases and a reconnect shortcut. |
| fca55f2 | fca55f2 | Update AGENTS.md for Vinculum and remote repositories, and add the sshd helper it points to. |
| aa95174 | aa95174 | Bring a dropped remote host back on its own, and add the remote repositories todo list. |
| 0f81937 | 0f81937 | Make "Quit & close all repos" work with remote repositories, and count their sessions. |
| d95c35a | d95c35a | Let the user restart a remote daemon this app cannot use, and open the repo while it waits. |
| 07e241f | 07e241f | Show storage for a remote repository and purge its archived data on the host. |
| 423a495 | 423a495 | Back up and restore a remote repository on its host. |
| d11104b | d11104b | Plan the performance work for remote repositories, and record what reading the code found. |
| 3e0eb9b | 3e0eb9b | Stop a slow or dead remote host from freezing the window. |
| 9304c87 | 9304c87 | Plan moving the remote repository's state and work into the host's daemon. |
| 20cdc79 | 20cdc79 | Record the decisions on the stacked PR, telemetry, MCP and daemon-less repos in the thick-daemon plan. |
| 700a486 | 700a486 | Review the thick-daemon plan with benchmarked spikes and an Accept block for every session. |
| 4ca243b | 4ca243b | Record the user's decisions on hosts, slow work, backups, execution state and MCP in the thick-daemon plan. |
| fcb27f1 | fcb27f1 | Record the gRPC, bridge, source-of-truth and flock decisions in the thick-daemon plan. |
| 5b33a55 | 1a9e57c | Review the thick-daemon plan, run the follow-up spikes and record O26 (v0.7, v0.8). |
| 993d2ec | 27acb7c | Merge remote-tracking branch 'origin/experimental-pi-durable-as-a-harness' into remote-daemon |
| 29c397b | 25b59f6 | Add the proto toolchain and run the daemon and engine bun tests in check.sh |
| 466108a | 17305d0 | Record S0.1 as done in the thick-daemon plan (v0.9) |
| 94e3f9a | 90e568c | Treat the protocol 24 daemon as an audited shutdown dialect. |
| 54418d4 | d3f8066 | Carry the plan sketch's comments in admin.proto and assert appConfigIdentity in the round trips. |
| e5e1f07 | 671b81f | Fix base-branch biome, typecheck, vitest and clippy failures so check.sh runs green. |
| 7b690ff | 48d8c0a | Assert protocol 24 in the audited shutdown dialect test. |
| 93bd464 | 67ef6a3 | Serve AdminService.Hello on rpc.sock with bearer-token auth (S1.1), protocol 25. |
| 4a1a7b4 | 4ff36bd | Record S1.1 as done in the thick-daemon plan (v0.9) |
| e8663c9 | 9c1723f | Forward webview calls to the daemon over HTTP/2 (S1.2) |
| e4769b8 | 42f1b21 | Record S1.2 as done in the thick-daemon plan (v0.9) |
| 3e1e054 | f22598e | Forward the daemon's RPC socket over ssh and probe it with Hello (S1.3) |
| bbdf4b7 | cbc8660 | Record S1.3 as done in the thick-daemon plan (v0.9) |
| 09ecc96 | 699cfe2 | Send teardown as AdminService.Shutdown with its origin (S1.4) |
| 28f79e0 | a159cae | Finish S1.4: the RPC Shutdown handler, the shell side and the gate |
| f4f81ac | 071af8e | Record S1.4 as done in the thick-daemon plan (v0.9) |
| 2481d62 | 8b7ec49 | Keep a new RPC token pending until its daemon answers with it |
| 87b2135 | b57694f | S0.6: delete dead OMP-RPC code and playbook_scheduler, route daemon writes through platform/fs.ts |
| c811349 | 4f7276b | Record S0.6 as done in the thick-daemon plan (v0.9) |
| cf7ecd7 | 1e5fc71 | S2.1: in-memory Store and SyncService.Subscribe on the RPC socket |
| 8f0546a | 5581c28 | Record S2.1 as done in the thick-daemon plan (v0.9) |
| 7e07351 | e346971 | Fill in the S2.1 commit sha in the plan |
| ffc6c95 | a5b28d3 | S2.2: platform layer for real (fsync worker, isLockedByOther, process.ts, daemon kill gate) |
| fe0d811 | 39bf4c2 | Record S2.2 as done in the thick-daemon plan (v0.9) |
| c215546 | 8d5e4ec | S2.3: watcher, reconcile and the session-meta parser |
| 9723877 | 39574bc | S2.3: rustfmt the conformance test |
| 9613339 | 9890190 | Record S2.3 as done in the thick-daemon plan (v0.9) |
| e3d09b6 | 01f09aa | S2.4: engine events commit the execution entity |
| 021170a | 34dece3 | Record S2.4 as done in the thick-daemon plan (v0.9) |
| 9a60b01 | 6374fa7 | S2.5: live session status, attention wait and daemon status reach the store |
| e77ae76 | 4f10f5d | S2.5: daemon status reports an exhausted inotify watcher |
| 38885b1 | 4e0a04c | Record S2.5 as done in the thick-daemon plan (v0.9) |
| baa3aa3 | ebac0b6 | S2.6: jobs runner, storage scan and JobService |
| 066ce1a | c059bc9 | S2.6: job tests check order through job timestamps, not a file write |
| ccd8554 | f0f1c1c | Record S2.6 as done in the thick-daemon plan (v0.9) |
| d597112 | e6ac106 | S3.1: replica, hooks, and a poll-free useDaemonStatus |
| 530754d | 4e6f808 | Record S3.1 as done in the thick-daemon plan (v0.9) |
| d574dd1 | 5bbdf60 | S3.2: session status and attention from subscriptions |
| a5c58d8 | 0f0ceff | S3.2: lint fixes in the new status tests |
| 27e998c | 8148d0f | Record S3.2 as done in the thick-daemon plan (v0.9) |
| e29ad26 | 42a1bf6 | S3.3: WatchTranscript replaces the transcript op |
| 7c4b3fa | fd65767 | S3.3: lint fix in ChatView test |
| f2499a2 | e877d22 | Record S3.3 as done in the thick-daemon plan (v0.9) |
| 7a1651e | 6dcc692 | S3.4: terminal bytes over TerminalService |
| ed8f7e4 | 9d8a23d | S3.4: terminal echo benchmark (O8, O5) |
| b44d845 | 246aa1b | Record S3.4 as done in the thick-daemon plan (v0.9) |
| 0876982 | ded1bff | S3.5: task rows and board fields in the daemon's store |
| b57811e | 523a8ad | S3.5: board reads come from the repo streams |
| e92f982 | 85be5bf | S3.5: one afterEach in the SessionView names tests |
| 3e66128 | 34097b0 | Record S3.5 as done in the thick-daemon plan (v0.9) |
| 80c5ddc | b4a9bf8 | Fold dtdannen's PR #154 review into S4.2 and S4.5 of the thick-daemon plan. |
| 33d3754 | 97b3194 | Record the O27 decisions: exact bytes, copy or clone never hard link, archive prunes snapshots. |
| acabeaa | 7e50ee2 | Record the O10, O12, O15, O22, O25 decisions and drop backup zip compatibility (O11). |
| ceee3f2 | c9892ee | Add the live-checks and review ledgers for the thick-daemon build run. |
| cff03b1 | 0ca7dea | S4.1: the daemon owns repo settings, EnsureReady and the telemetry sender |
| d5ac423 | 0523d67 | S4.1: the app reads and writes repo settings through the daemon's settings entity |
| c592046 | b8e4e4b | S4.1: delete the shell's settings commands and the repo-overrides write op |
| 1fd2f53 | 4150812 | S4.1: cargo fmt |
| 98c4865 | cbc73cb | S4.1: the audited shutdown dialects include protocol 26 |
| 3f4ee36 | e743f9e | Record S4.1 in the thick-daemon plan, live checks and review ledger |
| 9a0adfc | 16ed92c | S4.2: the playbook engine saves its State instead of appending events, and keeps each step's file states |
| 0352d01 | 1940a97 | S4.2: the daemon stores the engine State in execution.json, serves it as an entity, and takes the approval over ExecutionService |
| e69fbea | 1606e67 | S4.2: delete SavedExecution, the observe and allow commands, and the execution.rs transitions nothing calls |
| 6f27665 | 5681f92 | S4.2: the views read executions and approve through the store |
| 6df5c76 | 6f2bffd | S4.2: reword a comment |
| 33ba927 | 44574f3 | S4.2: the queued-session test waits for the pushed execution row before clicking Start |
| 0716075 | 230c911 | S4.2: the attention tests wait for the notification effect |
| 9deae66 | 28198b8 | S4.2: cargo fmt |
| 853958e | 6fe3180 | S4.2: plan status, disposition table, multi-writer note, ledger and live checks |
| ad43184 | ae631e3 | S4.2: a coding step records its worktree; inputs are captured before launch; revision and save consistency |
| f6ba9c7 | aede73e | S4.2: record the worktree wiring, corrected claims, and live check L-S4.2-e |
| 8e1b2b9 | adec986 | S4.2: the worktree record ref is qualified by task slug so tasks of one repository cannot overwrite each other's |
| 4420fae | ed38afa | S4.2: finalize and kill of a sub-task prune the archived task's execution objects like archive does |
| dc94dbb | 5765ac7 | S4.2: test that an engine save waits on the task-mutation lock |
| dfe1760 | 87a2f9b | S4.2: completion rechecks the execution after the worktree record; a failed input snapshot is logged |
| 23dd73e | 2a5f817 | S4.2: plan status, ledger R-S4.2-15 and live-check updates for the second review round |
| 9ce5679 | 4fb3b9b | S4.3: tasks, drafts and attachments move to the daemon |
| 32ac7ee | c469300 | S4.3: the legacy create scratch file goes through writeAtomic (the fs-writes gate) |
| 2b5993a | f9e7274 | S4.3: plan status, 4.1 row, changelog, ledger R-S4.3-1 to -14 and live checks L-S4.3-a to -f |
| ed92a4a | 81a24a7 | S4.4: the daemon owns session writes, history and chat threads (daemon half) |
| cce48d1 | 550d203 | S4.4: the frontend moves session writes, naming and chat threads to the daemon (frontend half) |
| 73ead78 | 341e00a | S4.4: the shell drops the session and chat commands, the 20 RepoOps and both pollers (shell half) |
| 515b2bc | 6f8d7ab | S4.4: plan status, 4.1 row, changelog, ledger R-S4.4-1 to -14 and live checks L-S4.4-a to -f |
| e34da59 | 1c329e3 | S4.4: chat archive refreshes the store between stamp and stop, generic clause test, close-all acks recorded (R-S4.4-15, -16) |
| 2b6f151 | 08e413d | S4.5: conformance fixtures and Rust runners for artifact_list, artifact_tree and artifact_comments |
| cd3625c | 56c735d | S4.5: the daemon owns artifacts and review comments (daemon half) |
| f2318a4 | 1840299 | S4.5: views read artifacts, comments and drafts from the task stream (frontend half) |
| 27e1fbc | 465fa3d | S4.5: the shell drops the artifact commands and 20 RepoOps (shell half) |
| d80e4e9 | 7a0754d | S4.5: cargo fmt for the conformance runner |
| 57803e9 | a553b34 | S4.5: plan status, 4.1 row, changelog, ledger R-S4.5-1 to -13 and live checks L-S4.5-a to -g |
| 31fc16a | 63346c9 | S4.5 fixes: refuse a review handoff from an archived source, O_NOFOLLOW on blob frames, engine-written snapshot read test |
| 146d759 | aa19fd7 | S4.5: ledger R-S4.5-14, plan changelog and L-S4.5-b corrected for the archived-source rule |
| 173ab23 | 2d062fb | S4.6: one playbook parser in the engine, the TypeScript library, and the playbook conformance cases |
| 80e6abc | 3c83f96 | S4.6: the daemon owns the playbook library (daemon half) |
| ce6d399 | 16277e0 | S4.6: the app reads and writes the playbook library through PlaybookService |
| c925f46 | 9960161 | S4.6: plan status, 4.1 row, changelog, live checks L-S4.6-a to -e and ledger R-S4.6-1 to -9 |
| e71a4d0 | 339cc30 | S4.7: the daemon owns a task's git work (GitService); the shell keeps the GitHub lookup |
| bdb7388 | eba67b9 | S4.7: plan status, 4.1 row and research result, changelog, live checks L-S4.7-a to -e and ledger R-S4.7-1 to -8 |
| 85446d9 | 4b5aff1 | S4.8: the daemon owns a task's sub-task controls (SubtaskService) |
| 9a2c8a1 | 119af82 | S4.8: protocol 33 in the shutdown dialect list; step-model and partial-child cases |
| a5206f6 | d364a53 | S4.8: plan status, 4.1 row, changelog, live checks L-S4.8-a to -e and ledger R-S4.8-1 to -8 |
| c69ed46 | 4662537 | S4.9: the daemon owns backup, purge and the automatic triggers; the shell keeps the picker and the restore step |
| e0df8c9 | b42c0d2 | S4.9: the page runs storage and backup through the daemon's jobs |
| 532d152 | 6136bb1 | S4.9: cargo fmt |
| c802aa5 | e7d70ee | S4.9: drop an unused import in the repo service tests |
| e4b08c7 | 2f91bcc | S4.9: plan status, 4.1 row, slot row, changelog, live checks L-S4.9-a to -f, ledger R-S4.9-1 to -8 |
| db12a95 | 3827aa2 | S4.10: community imports and the agent directory are the daemon's; issue imports pass the repo's facts from the page |
| 7611394 | d95726e | S4.10: plan status, 4.1 row, slot row, changelog, live checks L-S4.10-a to -d, ledger R-S4.10-1 to -9 |
| 68a5c6a | 7d3c3b2 | S4.11: ownership and keep-awake are the daemon's; no libalinery_core dlopen is left |
| 290145a | b7e62ce | S4.11: plan status, O9, 4.1 rows, changelog, live checks L-S4.11-a to -e, ledger R-S4.11-1 to -9 |
| 9e0fd5f | 070a225 | S4.11: keep-awake drop is tested against the real caffeinate, the two-daemon test runs a session, fixture reads are bounded |
| a8eb27c | 3947fa4 | S4.11: the bounded fixture read does not kill (signal gate) |
| 60686cd | c0d19f2 | S4.11: waive the hosted-token bullet to S4.12, reword Accept 1, fix the AGENTS.md libalinery_core line, ledger R-S4.11-5 and R-S4.11-10 |
| 1a51997 | 6e96c77 | S4.11: SettingsService.WriteHostedInference; the mcp invalid-defaults test no longer leaks a daemon |
| 55f4688 | 23c03ec | S4.11: plan, ledger and live checks for WriteHostedInference (R-S4.11-5 rebuilt, R-S4.11-12, L-S4.11-f) |
| a415ea7 | 16c4386 | S4.11: protocol 36 is an audited shutdown dialect |
| 46ef95e | a2b2d05 | S4.11: ledger R-S4.11-13 (protocol bump checklist, a second load flake) |
| 5847585 | 9a7c1b1 | S4.12: ProviderService; the provider ops leave the JSON-lines wire, the model list is the host daemon's |
| 4fbfa96 | d35a9db | S4.12: a daemon started over ssh lists its own models and signs in |
| 6d1a14b | d3cb7da | S4.12: cargo fmt, AGENTS.md ProviderService line |
| a2a9df4 | 53ef3de | S4.12: plan status, 4.1 rows, changelog, live checks L-S4.12-a to -c, ledger R-S4.12-1 to -5 |
| 231782d | 4db3988 | Shutdown stops job children: stopAll before the sockets go, drain before the exit |
| 68bf365 | 619d7aa | alinery-core: delete the Rust copies the S4 sessions left behind |
| 16fae91 | 087ae9d | ledger: the closing-repo flake tripped one full check.sh run |
| 2ddde98 | a55c699 | S5.1: MCP is a daemon client; the Rust MCP tools and the core functions kept for them are gone |
| c96796b | 10bd362 | S5.1: the bundled-playbook list test reads bundledPlaybooks.ts; protocol 38 is an audited shutdown protocol |
| c8ad6b7 | 3f3a0a1 | S5.1: the quiet-machine gate ignores the daemon binary's MCP children; AGENTS.md, plan, ledger and live checks |
| 383fb14 | 3508d38 | S5.1: the closing-repo test's timing bound is wide enough for a loaded suite |
| 056d036 | 1d48c4a | S5.1: widen the quit-latch twin's bound too, and cargo fmt |
| 9b5a6b9 | 68c1130 | S5.1: plan status names the commits |
| a1059e1 | 5bc6f59 | S5.1: a re-minted MCP token overlaps the old one and each request reads the current token; archived-task list test, tool text, plan and comments |
| 23be437 | 1eccf41 | S5.2: the host service in the Bun binary (--host-service), host.proto, golden bytes |
| bf67be3 | 5bf6f7c | S5.2: the Rust shell talks to the host service; alinery-mcp, repo_service and the zig build are gone |
| 0962ba2 | 8a98d70 | S5.2: wait_daemon_gone treats a reset probe as a daemon still closing, not an error |
| 6e3a37f | 9c1d1e3 | S5.2: the source gates stop scanning the deleted mcp/ crate; the ssh-kill gate scans the host service |
| 07c03a9 | 464ad66 | S5.2: plan status, 4.1 and 4.2 rows, changelog, live checks, ledger; AGENTS.md describes the host service |
| 8e57aac | 9b5739e | S5.3: retire the JSON-lines wire; each daemon serves alinery.v1 alone |
| 7b02900 | f6b6a9f | S5.3: the relaunch case runs against the real daemon |
| 6563f36 | 1e49020 | S5.3: plan status, 1.4 and 2.4 measurements, 4.1 row, changelog, live checks, ledger; AGENTS.md describes the one listener |
| 700cfca | 979873a | S5.3: the installer's quiet-machine gate speaks to the daemon it can reach |
| 46bda92 | df7fcec | S5.3: plan status, ledger R-S5.3-13 to -15, live checks L-S5.3-h and -i, AGENTS.md on the gate |
| 3b6994d | 6f1821a | S5.4: AGENTS.md describes the thick daemon; remote-repos docs marked superseded |
| 7dc0fe0 | 4df4422 | S5.4: plan status, 4.1 rows, changelog, README suggestions, live check L-S5.4-a, ledger R-S5.4-1 to -5 |
| bb6f4fc | c29c371 | P5 review: widen the takeover test's child wait and kill the child on drop (R-FLAKE-2) |
| 9ea4271 | 02448fe | S6.1: per-host onboarded mark in the app config, host list command, localStorage flag migrated once |
| 3f0e821 | a0cc64b | S6.1: plan status, 4.1 row, changelog, live check L-S6.1-a, ledger R-S6.1-1 to -4, AGENTS.md command list |
| 8c16a93 | ab1129f | S6.2: the setup screen (host, repo, daemon, onboarding), typed host refusals, test-connection |
| c9649c3 | be894db | S6.2: live test of the unsaved-host test against a host missing git; test_ssh_args for parsed arguments |
| 960d80f | bc3059e | S6.2: setup screen styles, AGENTS.md notes, live checks and ledger entries |
| 4f4fcd0 | 495bba6 | S6.2: plan status, 4.1 row, changelog |
| feb4e14 | ff3d245 | P6 review: setup screen waits for gave_up, not a bare failed; widen takeover peer wait |
| e7372ca | 8fffcf2 | P6 review: gave_up docs, R-FLAKE-3 and R-S6.2-8 ledger entries, v0.10 changelog, cargo fmt |
| 1f87065 | 82cf588 | P4 to P6 wrap-up: ordered live-check list with a smoke test, ledger morning summary and index, plan Status line |
| 75a4049 | ff1dc39 | Ledger index: list R-WRAP-1 |
