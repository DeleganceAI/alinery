# Vinculum session graph: produce the lineage the layout already draws

Status: implemented. This is a working note, not a product contract. `README.md` is human-edited and is not the place for it.

Production `v0.25.0` and this branch use the same `layoutDefinitionGraph`. A node moves down only when another node points at it. Nodes with no incoming edge stay on rank 0, side by side. The Flow view keeps only session-to-session links. The vertical chain in production is artifact lineage, not a second draw mode.

Vinculum does not give the graph that lineage. Do not change `TaskRunGraph.tsx`, `playbookGraphLayout.ts`, or `runGraphModel.ts`.

## What the graph joins

`buildTaskRunGraph` in `alinery-app/src/runGraphModel.ts` draws an edge only when both sides exist:

- An occurrence in `state.occurrences`, with `producer_execution_id` set to the execution that published it (null for a seed).
- A later execution whose `candidate.inputs` lists that same occurrence id. The edge runs from the producer's `owner_session_id` to the consumer's.

A seed, or a producer whose session is not on the board, becomes the "Inputs & other artifacts" chip. It does not occupy a rank. A publication nobody has consumed yet is a chip on its producer, not a downward edge. A join that bound two parents gets two incoming edges and sits below both. `resume_of` is a separate dashed link. Collections are not expanded; only the occurrence ids actually bound on the execution count.

`parent_execution_ids` is not read by the graph. Leave it empty.

## What the reply sends today

`getTaskExecution` in `vinculum-daemon/src/tasks.ts` reads `execution.json`, then replaces `state.executions` with `projectExecution` while the task is in the daemon's in-memory map. That projection copies the engine binding (`execution.inputs`: `seed/ticket.md`, `<execution>/<role>`) and sets `outputs` and `parent_execution_ids` to empty.

`state.occurrences` is left as the Rust map. Rust seeds are random UUIDs from `install_seed`. Vinculum never writes occurrences into that file. The engine ids are not keys in the map, so the join misses and every session stays on rank 0.

`engineExecutions` only sees a task the process has already opened. After a restart, before the next tick, the reply falls back to the on-disk executions. Those are the empty `materializeSessions` rows, or whatever Rust stored at create. The log already has the bindings.

The engine's own record is the one that matches the old shape. `playbook-engine/src/state.ts` stores an occurrence as `seed/<role>` or `<execution>/<role>`, with `producer` null or the execution id. `Execution.inputs` maps each slot to those ids. Receipts are the accepted publications. The log is `tasks/<slug>/engine.jsonl`, written before the in-memory apply.

## Change

One projection, used by `getTaskExecution` and by the other replies that already call `projectExecution` (`overlayStart`, `createExecutionSession`, `startSession`). Build it in the daemon. Do not write it back into `execution.json`. The board keeps reading the daemon reply; it does not learn to open `engine.jsonl`.

Add a snapshot next to `engineExecutions` in `vinculum-daemon/src/graph.ts`:

- If the task is in the running map, use that engine state.
- Otherwise, if `engine.jsonl` exists, `fold(readLog(...))`. A torn last line stays dropped, which is what the engine already does.
- If there is no log, return nothing. Leave the on-disk executions and occurrences alone.

When the snapshot has any seed or execution, replace both maps on the reply:

`state.executions[id] = projectExecution(...)`, as now, with one addition. `candidate.inputs` stays the engine map. That is already the occurrence ids. Do not translate them to Rust UUIDs.

`outputs` on each projected execution comes from that step's playbook outputs, not from a scan of the worktree. `relative_path` is the execution's `outDir` relative to the task `artifacts/` directory, plus the selector (`1-clarify-1/assessment.md`). A wildcard selector stays a wildcard path. `receipt_id` is already set from the engine receipt, so the history pane can say pending versus accepted without a second rule. This field is not what draws the graph. It is the same reply, and the history list is blank without it.

`state.occurrences` is every engine occurrence (`occurrences(state)`: seeds, then receipts in reservation order), keyed by the engine id:

| Reply field | Source |
|---|---|
| `id` | engine occurrence id |
| `producer_execution_id` | `producer`, or null for a seed |
| `selector`, `logical_path` | `role` |
| `relative_path` | `path` relative to the task `artifacts/` directory, so Open artifact hits the tree `findOwnedArtifactNode` walks |
| `depth` | the producer's `depth`, or 0 for a seed |
| `discriminator` | 0 |
| `context_id` | `"root"` |
| `collection_ids` | `[]` |

Do not project `collections` or `contexts`. The graph ignores them on purpose.

A seed is an external chip on the first session as soon as that session exists. A publication is a chip on its producer as soon as the receipt is in the log. The downward edge appears once the consumer has a session id, because the graph only links session nodes. A reserved consumer with no session yet does not invent a node. That is the production picture: the chain is sessions that handed an artifact to a later session, not the playbook's step list.

## Resume

Out of scope. Vinculum resume reopens the same session id (`graph.ts` `resume` returns the id it was given). There is no second session, no `resume_of`, and no `previous_session_ids` to invent. The dashed resume link appears only when those exist. Do not fake them.

## Placeholder sessions

Out of scope. `materializeSessions` still writes one session file per step when create does not start. Those files are not engine sessions. They have no inputs and no publications, so they stay on rank 0 beside the first real step even after this projection. A task that was started immediately never gets those files. Do not delete session files in this change. Stopping the placeholder write is the deferred note already in `docs/vinculum-engine-parity-plan.md`.

## Tests

A daemon test, not a layout test. Feed a log with a seed, a producer that accepted one file, and a consumer bound to that occurrence id. Call the task-execution reply without the task sitting in the running map.

- The consumer's `candidate.inputs` values are keys in `state.occurrences`.
- That occurrence's `producer_execution_id` is the producer, and the producer's `owner_session_id` is the session the log started.
- The seed's producer is null, and its `relative_path` is the ticket path under `artifacts/`.
- No log: the on-disk executions are unchanged.

That is the join `buildTaskRunGraph` already tests against. Do not re-test rank math.

## Not in this change

- No edit to the graph components or to `layoutDefinitionGraph`.
- No write to `execution.json`. Rust UUIDs and engine ids do not get merged.
- No protocol bump. The reply fills fields the app already decodes. Protocol stays 23, so a running daemon will not pick this up until it is stopped and the app is started again.
- No change to resume, to `materializeSessions`, or to which sessions the board lists.
