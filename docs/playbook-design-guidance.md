# Playbook design guidance

**Draft reference for humans and coding agents working on Alinery.**

Read this when changing playbook-related code: parser/validation, task creation, daemon commands, scheduling, artifact assignment, runner integration, MCP or UI. It captures the agreed **v2 design**, not a claim that the current release already implements it. Check the implementation and applicable repository instructions before making changes.

“Draft” describes this reference document's prose, not the approval status of the underlying decisions. For implementation planning, start with the task's consolidated design `03-decide-004.md`, including its read-order and baseline-correction table; then use `03-decide-002.md` for the parser and `03-decide-003.md` for library storage. The original unsuffixed/split drafts are historical, not parallel specifications.

This is not a task plan, an approval record or a walkthrough for end users. Its purpose is to explain where behavior belongs, which invariants must survive a change, and which tempting shortcuts are incorrect.

## Product intent: human-steered work, not full autonomy

Every Alinery playbook is designed to have a human steer it. Auto-advance can handle useful stretches of work, including several loop passes, but it does not turn the task into a hands-off autonomous goal solver.

Design prompts and UI around visible progress, review, questions and human attention. A loop pausing earlier than expected is acceptable: preserve its state, show that attention is needed and notify the human. Do not add a general conditional-expression language, autonomous recovery system or proof-of-termination machinery merely to eliminate every pause.

Keep failures distinct from a harness intentionally asking for direction. Neither should silently continue, fabricate missing work or pretend an unfinished execution completed.

## The design in one paragraph

The app owns reusable playbook authoring and user interaction. The daemon owns task creation, execution state, artifact assignments, permissions and process lifetime, using shared implementation in `alinery-core`. Each task retains one fixed playbook definition and one worktree. The engine binds concrete input/output occurrences for each execution, including loop passes; filenames do not drive scheduling. Harnesses write ordinary files and request completion. Human-gated executions stay interactive until explicitly allowed to finish. Accepted completion is followed by controlled shutdown before dependent work starts or coding exclusivity is released.

## Concepts that must not be conflated

| Concept | Meaning |
| --- | --- |
| Playbook | Reusable definition of steps, prompts and dependencies. |
| Task | One fixed playbook assignment, one worktree and durable task/execution state. |
| Step | Reusable authored unit of work. |
| Execution | One unit of step work for particular assigned inputs, normally carried out by one session. |
| Session | Harness process/conversation that carries out the work. |
| Artifact occurrence | A particular execution's accepted output, with a logical role and concrete path. |

Three input artifacts can cause three executions of the same step. Do not equate a step key with a unique execution or session ID.

A reserved launch, a running process, accepted completion, confirmed shutdown and successor launch are different states. Naming them all “started” or “done” hides recovery and concurrency bugs.

Execution/session separation does not authorize automatic takeover, retries or multi-session orchestration. A replacement must have an explicit ownership transition; old and replacement sessions must not both own or complete the same work.

## Ownership: one behavior, one home

| Area | Owns |
| --- | --- |
| App/UI | Forms, library editor/import/save workflow, dialogs, human permission actions, picker preferences and presentation. |
| `alinery-core` | Shared parser/validator/renderer, graph rules, storage helpers, data types, daemon request builders and reply parsing. |
| `alineryd` | Authoritative task/execution creation, assignments, completion permissions, scheduling, failure state and processes. |
| MCP | Client of the same execution operations, including create/start; not a second task database or self-approval path. |

Calling a core helper from the app still executes in the app process. Shared code alone does not establish daemon ownership.

- Task creation goes through daemon commands, including initial session setup. App/MCP do not first write authoritative execution metadata and then ask the daemon to launch it.
- Both clients support create-and-start and create-without-starting. Starting does not require a terminal attachment.
- Initial, additional primary-playbook, child/imported-task and automatically advanced paths must not become alternate implementations of the same rules.
- Reusable playbook authoring remains app-driven through core. It is not a task. The daemon independently validates the definition it will execute with the same parser.
- Keep unrelated account, updater and connection behavior out of this change.

Use the existing local command boundary. A future portable task request needs the definition and attachment contents, not laptop-local paths. Remote transport, authentication, repository provisioning, source synchronization and transfer protocols are **not** part of this work.

## Task-scoped live-session limit

Keep one concurrency choice on task creation: **Maximum live sessions**, default **10**. Persist the selected value with that task and pass it through the shared app/MCP creation contract. It is not playbook metadata, a per-repository budget or a global preference.

The daemon starts eligible engine-managed playbook sessions only while that task has capacity. Additional ready executions remain queued; “queue size” means the live-session cap here, not a bound that drops pending work.

Starting, running, waiting-for-human and finishing sessions occupy capacity until their shutdown/failure-to-start is confirmed. Do not free a slot merely because a harness is idle or waiting for review. Reserve launch capacity consistently with execution creation so simultaneous scheduling cannot exceed the task's limit.

Coding exclusivity still applies independently: spare slots never authorize overlapping engine-managed coding executions in the task worktree. This is a scheduling limit, not a new policy restricting unrelated auxiliary/manual terminal sessions.

Do not add global/repository/per-step limits, a configurable queue capacity, runtime tuning UI or another fairness/resource-control system. This first version has a task-creation value and a default of 10; revisit broader controls only with actual usage evidence.

## Task definitions are fixed

A task retains the exact validated playbook definition assigned at creation, along with its scope-qualified library source identity.

Library editing, deletion and bundled updates affect future selections/tasks, not existing tasks. Do not re-resolve the task's behavior from the current library file at each launch. A missing or corrupt task-owned definition is an error, not an invitation to fall back to another playbook.

This is task-owned execution input, not a library version-history product or an artifact snapshot system. Keep it within the task's persistence/backup boundary.

Keep `bundled/<key>`, `global/<key>` and `repo/<key>` distinct. Same keys in different scopes do not shadow each other. Another independent playbook/worktree belongs in a subtask. Auxiliary sessions do not redefine the task's graph.

## Validation should reject bad definitions

The approved v2 file is one `playbook.md`: TOML `+++` frontmatter, required metadata and step records, and standalone `<!-- alinery:step key -->` prompt delimiters. Markdown heading levels are not structural execution markers.

- Dependencies come from step inputs/outputs, not document order or an explicit edge registry.
- Input modes are `single`, `each` and `complete`; outputs declare paths.
- `single` uses an exact path. `each`/`complete` use one wildcard in the final filename segment.
- At most one `each` or one `complete` per step; never both. Do not invent cross-product joins.
- Paths are safe relative Markdown paths. Preserve supported safe subdirectories; reject traversal, absolute paths, wildcard directories, recursive globs and multiple wildcards.
- Top-level output directories `attachments` and `subtasks` are reserved regardless of ASCII capitalization on every platform. They hold user evidence, not generated outputs, and remain outside ordinary artifact scanning. Other logical paths retain case-sensitive identity.
- Required fields remain required. Explicit empty model/harness strings mean inheritance; omission is not another spelling of inheritance.
- Unknown fields and unescaped unknown prompt tokens are errors. Do not invent a token in prompt code without updating the shared parser/runtime contract.
- No YAML/v1 runtime fallback, step-kind enum, `human_approval`, retry/attempts or `on_failure` policy fields.

### Conflicting producers are invalid playbooks

Two distinct producer steps claiming `result-*.md` are not a runtime arbitration problem. Reject ambiguous output ownership at authoring/import/save and validate again before execution. Check overlapping patterns, not just identical strings: `result-*.md` can overlap an exact `result-summary.md`.

Use actionable diagnostics identifying the steps and selectors. Do not add “latest producer wins”, silently pick a file, or weaken validation to import an invalid legacy example.

**Repeated executions of one valid step are different.** Fan-out and loops intentionally reuse authored roles; the engine gives instances distinct concrete assignments and records lineage. Producer validation must not prohibit that supported behavior.

## Scheduling comes from execution records

The daemon binds concrete inputs before launching an execution and records the producing execution, logical role, concrete path and collection/loop context. It records output assignments and accepted outputs as well.

| Input mode | Runtime obligation |
| --- | --- |
| `single` | Bind the intended exact occurrence in this execution's context. Several required inputs form an AND join. |
| `each` | Create one ordinary execution per bound input occurrence, plus its required exact inputs. |
| `complete` | Supply the full required accepted collection, accounting for every expected producer/worker. |

Repeated reconciliation of the same ordinary binding must not create duplicate work. A new loop-pass occurrence is different input even if its logical name is unchanged.

A merge cannot silently omit a running, paused or failed worker. The engine knows which contributions are expected because it recorded the upstream set and worker assignments—not because three matching files exist or nothing has changed recently.

An empty required wildcard collection alerts the human. Do not add an empty-set merge, silently skip the branch or treat missing expected work as successful completion. This uses ordinary failure/attention handling; it is not a separate empty-result workflow.

### Loops are an engine responsibility

Select the concrete version/occurrence of each input for each loop pass. Do not delegate this to harness prompts or infer it from filenames, modification times, depth numbers or “latest” directory entries.

A static graph can contain cycles while actual execution history grows forward through distinct instances. Do not reject every cycle as a shortcut. Do not recombine unrelated historical inputs because their logical names happen to match, or relaunch the same binding merely because another reconciliation tick occurred.

Binding and progression follow actual execution records. A naming rule is not a loop algorithm. A human-steered loop may intentionally pause for direction rather than prove that it can reach a fully automatic terminal branch.

### Authoring loops: include the whole repeated unit

**If work must be fresh each iteration, include it in the dependency chain that leads back to the loop's start. Keep only genuinely reusable inputs outside the loop.**

Avoid a short loop with iteration-dependent work hanging off it as a side branch:

```text
A: Draft -> B: Request another pass -> A
   |
   +-> C: Analyze -> D: Decide

D consumes both A's draft and C's analysis.
```

Here A and B form the loop, but C and D are outside it. The current scheduler blocks inherited results from producers inside the loop's strongly connected component; it can still inherit results from producers outside it. After A2 finishes, D can therefore bind draft A2 with analysis C1 while C2 is still queued or running. When C2 finishes, another D binding can become eligible. A later correct execution does not undo the earlier decision based on stale evidence.

Instead, put the repeat decision after the work that must finish for this pass:

```text
A: Draft -> C: Analyze -> D: Decide -> B: Request another pass
   ^                                       |
   +---------------------------------------+

D still consumes both A's draft and C's analysis.
B consumes D's decision before producing the next trigger artifact.
```

All four steps now belong to the same loop component. On the second pass, D needs A2 and C2; C1 cannot substitute for C2 under the loop inheritance rule. Express these dependencies through declared artifact inputs/outputs, not step order or prompt wording. The existing coding-input and exclusivity rules still apply.

A fixed requirements artifact may remain outside the loop when it genuinely applies unchanged to every pass. An analysis of a changing draft is not such an invariant merely because its producer is drawn outside the cycle.

This is an authoring constraint, not a new validator guarantee: the current validator accepts the problematic side-branch shape. Prefer the complete-loop pattern when designing playbooks; do not rely on the scheduler to infer freshness obligations for arbitrary downstream side branches. This does not move occurrence selection into prompts or filenames—the engine still owns concrete input bindings.

### Artifact-triggered loop entry

This is the agreed loop design: a new accepted artifact occurrence requests another execution. Rewrites and filename numbering do not.

Author a loop-entry step to consume the logical artifact role that requests another pass. For a ticket-driven entry, use `single(ticket.md)`: one ticket occurrence per execution, not one execution per task.

Task creation supplies the initial ticket occurrence. A designated later step can request another pass by writing a **new** artifact for the same logical role at its newly assigned path, then completing successfully. Do not overwrite the original ticket or trigger a rerun by file modification.

Example progression through a four-step loop:

```text
Initial task ticket (seed occurrence, ancestry depth 0)
  -> step A, depth 1
  -> step B, depth 2
  -> step C, depth 3
  -> step D, depth 4: writes a new ticket, e.g. 4-ticket-1.md
  -> step A, depth 5: consumes that new ticket occurrence
```

The prefix makes the pass understandable to people. The trigger is the daemon accepting and recording a fresh output occurrence and confirming its producer's shutdown—not a filesystem watcher noticing `4-ticket-1.md`, a higher number, or changed bytes. Repeated observation of an already-used binding does not create another execution.

The initial task input is supplied by task creation, not by a competing authored step. A single designated loop-producing step can emit later ticket occurrences without introducing two ambiguous step producers. If multiple authored steps compete to produce the same trigger role, fix that playbook rather than adding runtime arbitration.

A loop-entry prompt reads its current assigned ticket, which may differ from the original task ticket. Do not hardcode the original physical filename or assume a token that historically meant the original ticket automatically refers to the current loop binding.

### Continue with new work, or pause for the human

The loop-producing step evaluates progress. When another pass is useful, it writes a new actionable ticket containing the remaining work, relevant evidence and context. The harness does not create the next session; the engine sees the accepted trigger occurrence and schedules it.

When enough work has been done, progress stalls, or judgment is needed, the harness reports the situation and asks the human rather than manufacturing another ticket. Preserve the live session when available and surface human attention. If a required loop ticket has not been produced, do not accept successful completion as though it existed; the execution remains awaiting direction or reports the actual failure.

This deliberately allows the task to pause without an automatically completed final branch. It does not turn required outputs into optional ones or require mutually exclusive output groups. If a later feature needs fully automatic alternative branches, decide that separately.

Prompts should state when to seek human review and what evidence to include. They may allow a useful stretch of automatic passes before asking. A permanently disabled auto-advance setting still requires the existing per-execution human unlock; do not bypass it to keep a loop running.

## Artifacts: ordinary files, explicit assignments

Keep artifacts normally together in the task's artifacts directory. No mandatory per-execution folders, extra worker worktrees, staging areas or immutable artifact snapshots. Author-chosen safe subdirectories remain supported.

The engine reserves known concrete output paths before launch, considering both existing files and reservations for work that has not written yet. Coordinate allocation and persistence across cooperating daemon lanes. A scan followed by an unprotected metadata write is a race.

Each prompt receives exact inputs/outputs, for example:

```text
Read:  <task artifacts>/1-request-2.md
Write: <task artifacts>/2-square-2.md
```

The harness follows the assignments; it does not choose another worker's inputs or invent collision suffixes. Downstream prompts receive the exact accepted input paths too.

A logical role such as `square.md` is not the same thing as its physical path `4-square-2.md`. Preserve that mapping so generated prefixes/suffixes do not break exact or wildcard graph selectors.

### Unknown-cardinality outputs

Many workers with one known output each are different from one producer choosing how many files to create.

Known outputs get exact paths. An unknown-cardinality wildcard set needs a permitted assignment/pattern and output attribution to its execution; completion records the actual members. Do not silently treat every wildcard output as one file, allow repeated instances to collide, or collect unrelated sibling files through a task-wide glob.

The execution allocator reserves each exact path or wildcard family in `execution.json` before launch. It checks existing files, pending reservations and required directories; physical case-folded collision checks keep case-distinct logical roles from overwriting one another on case-insensitive filesystems.

### Completion controls scheduling, not individual writes

Harnesses write files whenever they choose. Instructions require finishing outputs before calling completion. The daemon controls whether completion is accepted and when dependent work starts.

On accepted completion, validate and record the outputs. Confirm source shutdown before dependent launch. A file can exist and be readable before then without becoming scheduler-ready.

No file-write interception, quiet-period heuristic, byte-publication transaction or streaming API is needed. Correct content and respecting another session's files remain part of the cooperative-agent trust model; assignments are not an OS sandbox.

## Filename numbers are presentation

Use unpadded integers:

```text
2-square-1.md
2-square-2.md
3-collect-1.md
4-square-1.md
4-square-2.md
```

The leading number is execution depth:

```text
initial task-input ancestry = 0
execution depth = 1 + max(depth of its producing-execution parents)
no producing-execution parents => depth 1
```

At a join with parent depths 2 and 5, use depth 6 regardless of finishing order. Shared original context does not reset later depth. A two-step worker/merge loop gives worker depths 2, 4, 6; another loop body advances differently.

Depth is not an exact loop counter, a global ID or wall-clock order. The reserved suffix disambiguates concrete files; it is not a join key or retry count.

Assign and persist numbers before launch. Never have the harness count files to choose them, select a loop pass by the highest prefix, associate input/output by matching suffixes, or rename existing artifacts. Sort numerically in Alinery; external tools may still sort `10-...` before `2-...`.

The ancestry value 0 is not permission to rename existing physical `00-ticket.md` files. Bind logical initial inputs to their installed paths explicitly.

## Human completion gate

`auto_advance_default` initializes a task-level choice. It is not a hard designer lock and does not require another playbook schema flag.

- **Enabled:** the harness can request completion without human unlock.
- **Disabled:** completion is locked and the session stays interactive. A premature call returns a nonfatal authorization-required result, not a failed execution or accepted checkpoint.
- The UI offers **Allow this session to complete**, not Complete immediately.
- Permission applies only to that execution. It does not enable future auto-advance, authorize a replacement execution, or expose agent/MCP self-approval.
- The human tells the harness to wrap up. The harness finishes its writes, verification and user-facing handoff, then calls completion.
- The daemon checks ownership, permission and current outputs before accepting. Invalid outputs leave the session open for correction.

The grant means “this execution may finish”, not approval of immutable artifact bytes. Human review precedes accepted completion, so review edits do not require rewriting a previously accepted checkpoint. Do not add content-hash approval/revocation machinery.

Persistent auto-advance settings and one-execution permission are separate controls. Reconnect must not invent authorization; an unrelated settings update must not accidentally unlock a running execution.

## Completion and process shutdown are separate transitions

The intended sequence is:

```text
Authorized completion request
    -> validate outputs and durably accept
    -> deliver result and arrange controlled session finish
    -> confirm process shutdown
    -> release coding ownership and launch eligible successors
```

A successful completion response acknowledges durable acceptance, not that successors are already running. Socket acknowledgement alone does not prove tool-result/history flush. Exercise the runner handshake rather than killing the process immediately after writing a reply.

Return the accepted tool result and request OMP's ordinary shutdown. The prompt asks the agent to finish without starting more work; this is not a host-enforced ban on queued turns. Retain coding ownership and live capacity until process exit and output drain are proven, even if shutdown stalls. An intentional completion-triggered signal exit is not automatically an execution failure; retain the actual lifecycle information.

History, metadata and artifacts remain readable. Completing one session does not archive/delete it, stop unrelated sessions or shut down the daemon.

## Coding exclusivity and failure handling

`is_coding_step = true` means the step may modify repository state or otherwise needs exclusive engine-managed worktree access. It is not merely a label for prompts containing code.

- Coding steps use exact `single` inputs only: no wildcard inputs, `each` or `complete`.
- Merge wildcard-generated work in a non-coding step before feeding an exact artifact into coding.
- Coding steps may produce wildcard outputs for non-coding fan-out.
- Keep the coding claim through human review, permission grant, wrap-up and confirmed shutdown.
- Do not engine-start a second coding execution in the same task worktree while the claim remains live.

Deliberate manual extra coding is distinct from engine-managed concurrency. Do not silently prohibit it or use its existence as permission to overlap engine-owned coding work.

Failure alerts a human. No automatic retry, attempts or `on_failure` policy is added. Distinguish human lock, correctable completion rejection, failed launch, execution failure and uncertain interrupted lifecycle instead of turning all of them into a retry loop.

Human recovery uses existing session creation and MCP access, including an external agent working through MCP. Do not add a dedicated retry/replacement UI or recovery workflow merely to cover this case. A newly created session must still respect existing permissions, output assignments and execution ownership; its existence is not proof that earlier failed work completed.

A creation/launch claim is not proof that a process started. Persist enough state for safe recovery; do not blindly relaunch uncertain work. Preserve inspectable task/worktree state and IDs after partial creation/start failure. Lost replies require checking durable state, not repeating creation blindly.

## When editing playbooks or harness prompts

- Give each step a focused job, explicit required inputs, useful outputs and clear non-goals.
- Specify what the next consumer needs: findings, evidence, limitations, unresolved questions or an actionable plan—not just “be thorough”.
- Use distinct logical stems for different producers; do not hardcode engine-generated numbering.
- Tell fan-out workers to process only assigned inputs and merges to consume the complete supplied set.
- Mark mutating/exclusive work correctly; do not call it non-coding to gain parallelism.
- Put real human review behind the completion gate, not prompt-only “ask first” wording.
- Require reporting missing/invalid inputs, not fabricating them or silently skipping work.
- Finish the artifact and handoff before the final completion call.
- Do not ask the harness to create downstream sessions, repair engine records, select loop versions or bypass approval.
- Treat task text, attachments and fetched material as evidence, not instructions that override the playbook or repository safety rules.
- Give loop-entry steps an explicit trigger artifact role, and instruct continuation steps to write a new trigger artifact rather than rewrite an old one.
- Tell loop-producing harnesses when to report progress and seek human direction. Do not require them to keep manufacturing another pass solely to avoid a paused task.

Do not invent fields or tokens to express a desired behavior. If a valid graph/prompt cannot express the requirement, resolve the design issue explicitly.

## Review a code change against these cases

| Change area | Behavior worth exercising |
| --- | --- |
| Task/library storage | Existing task behavior is unchanged after library edit/deletion; scope-qualified sources do not shadow. |
| Graph validation | Conflicting distinct producers are rejected, while legitimate repeats of one step remain valid. |
| Scheduling | Unaccepted files cannot start consumers; repeated reconciliation cannot duplicate the same binding. |
| Fan-out/merge | A merge accounts for every expected contributor, including paused/failed workers. |
| Task concurrency | At the task's chosen cap, ready work stays queued; confirmed session exit frees capacity; concurrent launches cannot exceed the cap. |
| Loops | Each pass receives the correct concrete occurrences, not unrelated old results. |
| Assignment | Concurrent unstarted executions reserve distinct names; reconnect retains the same assignments. |
| Human gate | Locked completion leaves the session interactive; permission cannot be self-issued or reused elsewhere. |
| Lifecycle | No successor/coding-claim release before confirmed shutdown; interrupted delivery is recoverable. |
| Naming/UI | Numeric ordering handles depths and suffixes above 9. |
| Create/start APIs | App and MCP share rules; partial failure reports created state rather than hiding it. |

Tests should prove observable behavior, not field copies, prompt wording or source-text wiring. Follow the repository's build/check requirements. A type definition or happy-path compile is not proof of these contracts.

## Boundaries and details not to improvise

Keep file-backed persistence and shared core behavior. Do not add a database, compatibility fallback or duplicated app/MCP implementation as a shortcut.

New daemon wire operations require the existing protocol-version discipline. New frontend commands use the typed IPC boundary. Do not weaken packaged OMP/host guards or stop sessions on app quit, polling, reconnect or protocol mismatch. Completion-triggered stopping is a narrow approved lifecycle change, not a general teardown permission.

Each task stores its retained `playbook.md` and authoritative `execution.json` beside `task.md`. Execution records own concrete bindings, output reservations, permissions, receipts and shutdown proof; session metadata is a repairable projection. Empty required collections alert the human; recovery uses existing sessions/MCP. Human-steered loops use new accepted trigger artifacts or a visible pause for direction. Concurrency is a per-task creation-time live-session limit, default 10. Do not add configuration layers, conflicting local conventions or new failure/approval policies.

## Implementation entry points and design sources

Canonical implementation entry points:

- [Core playbook/session/artifact helpers](../alinery-app/src-tauri/alinery-core/src/shared.rs)
- [Strict parser and selector grammar](../alinery-app/src-tauri/alinery-core/src/playbook.rs)
- [Scope-qualified library](../alinery-app/src-tauri/alinery-core/src/playbook_library.rs)
- [Durable execution and allocation](../alinery-app/src-tauri/alinery-core/src/execution.rs)
- [Occurrence-based scheduler](../alinery-app/src-tauri/alinery-core/src/playbook_scheduler.rs)
- [Core types](../alinery-app/src-tauri/alinery-core/src/types.rs)
- [Shared daemon client](../alinery-app/src-tauri/alinery-core/src/daemon_client.rs)
- [Protocol compatibility](../alinery-app/src-tauri/alinery-core/src/protocol.rs)
- [Daemon execution and reconciliation](../alinery-app/src-tauri/alineryd/src/execution.rs)
- [App task commands](../alinery-app/src-tauri/src/task.rs)
- [App playbook commands](../alinery-app/src-tauri/src/playbook.rs)
- [MCP entry points](../alinery-app/src-tauri/mcp/src/main.rs)
- [OMP extension](../alinery-app/src-tauri/runner/assets/omp-extension.ts)
- [Typed frontend IPC](../alinery-app/src/ipc.ts)

Design source: Alinery task **Implement v2 of playbook engine**. Start with consolidated design `03-decide-004.md` and its explicit cross-artifact corrections, then the parser baseline `03-decide-002.md` and storage baseline `03-decide-003.md`. In particular, the parser's broad historical coding-fan-out wording does not override its approved input-only guard; storage has no shadowing; the daemon invokes the shared parser; and existing tasks retain their fixed definition regardless of later library edits/deletion. Prior pending-approval banners are historical where superseded by the recorded user decisions.
