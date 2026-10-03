# Workflow removal and Playbook hard-cutover decision record

> Planning snapshot captured on 2026-09-04 for [PR #237](https://github.com/DeleganceAI/saga/pull/237) from the completed [DEL-633](https://linear.app/delegance/issue/DEL-633/remove-the-workflow-implementation) grill and its reconciliation into [DEL-624](https://linear.app/delegance/issue/DEL-624/implement-the-playbook-execution-engine).
>
> The decisions below are settled planning constraints. This record does not claim that the production Playbook engine, the final v1 Playbooks, or the hard cutover has been implemented or validated. PR #237 was at `6f126fbf8d1ec8f23975df578cd591351349945f` when this record was prepared.

## Executive summary

Alinery will implement and prove Playbooks first, then remove the legacy Workflow implementation in a separate deletion-only change.

The Workflow implementation is frozen while Playbooks are built. No new code may fix, extend, adapt, migrate, display, or otherwise support legacy Workflows. Once the five replacement Playbooks work end to end inside Alinery through the production Rust path, DEL-633 removes the Workflow implementation and the same suite is rerun against the result. The three current internal users then perform a coordinated hard cutover to that Playbook-only build with no Sessions running. They may retain a copy of the entire old `.alinery` directory for reference outside the upgraded app.

The upgraded app will provide no legacy reader, migration, conversion, read-only history, compatibility shim, Workflow-shaped stub, feature flag, or rollback. Neutral Task, Session, artifact, daemon, worktree, repository, storage, and backup machinery survives only where the working Playbook implementation actively uses it.

The delivery order is therefore:

1. Freeze the legacy Workflow implementation.
2. Finish the production Playbook implementation and revise the PR #237 candidates to v1.
3. Prove the five replacement Playbooks end to end inside Alinery.
4. Remove every Workflow-specific surface in one coherent deletion change.
5. Rerun the five-Playbook proof against the Workflow-free build.
6. Coordinate the manual upgrade and data cutover with no live Sessions.

## Scope and vocabulary

In this record:

- **Workflow** means Alinery's legacy phase-based execution model: Workflow definitions, phases, phase projections, completion events, Review handoffs, and daemon auto-advance.
- **Playbook** means the new file-defined, State-based execution model owned by DEL-624.
- A **real end-to-end execution inside Alinery** uses the shipping Rust engine path, persisted Playbook State, Step Execution, binding, claim, and Session records, and the normal app or MCP entry points. A development build is acceptable. A parser test, prototype, simulation, or direct test-only engine invocation is not sufficient.
- “Run” may appear as ordinary English for executing a Playbook. It does not introduce a separately persisted Run object between a Task and its Step Executions.
- **Hard cutover** means the team manually leaves the old data boundary and starts on the Playbook-only product. It does not mean writing an automated converter.
- **Frozen** means the legacy implementation remains unchanged only as long as it is needed before cutover. It receives no new behavior or support code.

Implementing Playbooks before deletion necessarily creates a temporary source-control interval in which both implementations exist. That interval is delivery sequencing, not a supported compatibility mode: a Task has exactly one execution authority, no adapter connects the models, and permanent coexistence is forbidden.

## Complete decision matrix

| Decision | Settled answer | Consequence |
| --- | --- | --- |
| Replacement coverage | The five legacy modes already have candidate Playbooks on PR #237. | Do not reconvert them in DEL-633. DEL-635 owns their v1 revisions. |
| Legacy behavior parity | Zero old behavior is required. | Validate intended Playbook outcomes, not phase, prompt, file, transition, or UI parity. |
| Existing Workflow Tasks | No conversion. | Old Tasks do not become Playbook Tasks, and no synthetic State, Execution, Transition, or provenance history is created. |
| In-flight Sessions | None may exist at cutover. | The team coordinates a hard upgrade; no resume, drain, transfer, or mixed-session mechanism is built. |
| Legacy history in Alinery | Unsupported. | No read-only legacy browser, frozen Task view, badge, parser, detector, or rejection-specific compatibility path. |
| Manual data handling | Users may back up the entire `.alinery` directory for reference. | The backup stays outside the upgraded app's supported data path. |
| Readiness bar | Observable Alinery capability, not closure of every sibling ticket. | DEL-641 is allowed to pass once its product-level criteria pass, even if a related broad planning track remains open. |
| Proof suite | All five replacements must complete real end-to-end executions. | PRIMED, Code Review, One-shot, Bug Hunting, and Generic Session each produce evidence. |
| Rollback | No supported rollback. | No fallback switch, old-build path, reverse migration, or dual-format storage is added. |
| Fundamental seams | Preserve only actively used Playbook-neutral infrastructure. | Replace a Workflow-facing seam with a concrete Playbook seam only when the landed Playbook implementation requires it; never leave placeholders. |
| Removal shape | One coherent deletion change after validation. | Reviewable commits are fine, but no partially removed mixed state is merged as the DEL-633 result. |
| Ticket boundary | DEL-633 owns deletion only. | Playbook implementation remains in its engine tracks, definitions in DEL-635, and end-to-end proof in DEL-641. |

## Replacement Playbook suite

All five required replacements already exist as candidate documents on PR #237:

| Legacy mode | Replacement Playbook | Candidate file |
| --- | --- | --- |
| RPI | PRIMED Feature Development | [`docs/playbook-ideas/primed.md`](../../playbook-ideas/primed.md) |
| Review | Evidence-Backed Code Review | [`docs/playbook-ideas/code-review.md`](../../playbook-ideas/code-review.md) |
| One-shot | One-shot Implementation | [`docs/playbook-ideas/one-shot.md`](../../playbook-ideas/one-shot.md) |
| Bug Hunting | Bug Hunting | [`docs/playbook-ideas/bug-hunting.md`](../../playbook-ideas/bug-hunting.md) |
| Free-form | Generic Session | [`docs/playbook-ideas/generic-session.md`](../../playbook-ideas/generic-session.md) |

These files establish replacement coverage, not production readiness. At the snapshot recorded here they still declare `alinery.playbook/sketch-0` and require the final v1 revisions owned by [DEL-635](https://linear.app/delegance/issue/DEL-635/simplify-pr-237-playbooks-to-artifact-based-fan-out), followed by production-engine execution. DEL-635 covers all eight candidate Playbooks on PR #237; only the five above gate Workflow removal.

The replacement suite is not required to preserve legacy internals. In particular, it does not need the old phase cursor, phase names, auto-advance edges, Workflow-specific Review handoff, embedded PR stages, `generic` discriminator, or exact old prompts and artifacts. A converted Playbook passes by satisfying its own v1 contract and intended outcome through the new engine.

## Delivery sequence

### 1. Freeze Workflows

From the moment of this decision until deletion:

- Do not add features, bug fixes, abstractions, adapters, fields, commands, views, migrations, tests, or documentation whose purpose is to preserve or improve the Workflow implementation.
- Do not create a Workflow-to-Playbook bridge.
- Do not reshape new Playbook contracts around compatibility with legacy Task or Session data.
- Keep the old implementation unchanged only long enough for the current internal users to reach the coordinated cutover.

### 2. Implement Playbooks first

The production Rust Playbook path must exist before legacy removal. The required capabilities include:

- v1 parsing, fail-closed validation, exact-byte identity, repository discovery, and pinned source snapshots;
- material States, Step Executions, Transitions, exact occurrence bindings, claims, and Task-owned control state;
- grounding and applicability evaluation;
- isolated execution workspaces and atomic State sealing;
- the `alineryd` Session and completion bridge;
- authoritative scheduling and recovery; and
- app and MCP observation and operator surfaces sufficient for the readiness gate.

This list states the capabilities needed for cutover. It does not require every unrelated acceptance criterion in every broad sibling track to close first.

### 3. Revise the candidate Playbooks

DEL-635 owns updating the eight PR #237 candidate Playbooks to the settled v1 definition contract. DEL-633 does not edit or convert Playbooks. The five replacement files must be valid, discoverable v1 Playbooks before they enter the cutover proof.

### 4. Pass the DEL-641 capability gate

[DEL-641](https://linear.app/delegance/issue/DEL-641/validate-the-five-replacement-playbooks-end-to-end-in-alinery) owns the proof that Playbooks are ready to replace Workflows. It blocks DEL-633.

### 5. Execute DEL-633

[DEL-633](https://linear.app/delegance/issue/DEL-633/remove-the-workflow-implementation) removes the legacy implementation. It must not acquire Playbook implementation, conversion, migration, or validation work.

The five DEL-641 scenarios are rerun against the Workflow-free result. A failure means removal is not complete.

### 6. Perform the manual hard cutover

After the Workflow-free result passes the replacement suite, the team coordinates a single upgrade window, confirms that no Sessions are live, optionally preserves the old `.alinery` directory outside the active data path, and starts Alinery from a clean Playbook-only state.

## DEL-641 readiness gate

The gate is product evidence, not a claim that code compiled and not a blanket requirement that every related ticket be marked complete.

### Environment and discovery

- Start from a clean installation and repository state.
- Let the supported clean-install initialization path materialize the revised v1 replacements in the one supported Playbook discovery directory; an operator manually copying candidate files does not satisfy this gate.
- Confirm Alinery discovers and validates all five files without a cached fallback, manual setup, or second runtime source.
- Record the tested Git commit or build and each exact Playbook identity.

### Product paths

Across the five-Playbook suite, prove that normal Alinery app and MCP paths can:

- select and pin a concrete Playbook source to a Task;
- create the Task-owned Playbook progression;
- evaluate applicable Steps and acquire durable claims;
- start and observe real daemon-owned Sessions;
- accept completion and seal the resulting State;
- expose Step Execution, State, Transition, binding, claim, and Session status; and
- recover from an interrupted app or daemon without losing accepted state or duplicating already claimed work.

Both the app and MCP must be exercised across the suite. Every Playbook does not need to be launched once through each surface when the same underlying path has already been proven.

### Five-Playbook execution proof

Each of the following must complete at least one real end-to-end execution inside Alinery through the production Rust engine:

1. PRIMED Feature Development
2. Evidence-Backed Code Review
3. One-shot Implementation
4. Bug Hunting
5. Generic Session

At least one execution must include a restart or interruption and demonstrate recovery from persisted Playbook data without duplicate execution.

### Evidence packet

DEL-641 should record enough evidence to reproduce and audit the gate:

- tested commit or build identity;
- exact Playbook file identities;
- Task, Step Execution, and Session identifiers;
- starting and accepted result State identities;
- the app and MCP paths exercised;
- interruption and recovery observations;
- exact commands used for automated checks; and
- the outcome of each of the five executions.

No passing result may depend on a legacy Workflow parser, Workflow scheduler, phase projection, Workflow completion path, Review handoff, or auto-advance behavior.

## Manual hard-cutover contract

The current user population is three people on the internal team. That bounded context justifies a manual break rather than permanent product code.

### Before the upgrade

- Tell all three users that this is a hard cutover.
- Confirm there are no live Sessions. The cutover does not attempt to preserve, drain, resume, or transfer one.
- Each user may copy or move the entire old `.alinery` directory if they want its files for later reference.
- Remove or relocate the legacy directory from the active repository path before starting the Playbook-only build.

### After the upgrade

- Initialize and use only the Playbook-native data layout.
- Do not offer to import, convert, open, browse, freeze, or explain the legacy data through Alinery.
- Do not recreate legacy files or fields while reading a repository.
- Treat the optional backup as external reference material, not supported application data.

### No rollback

There is no supported runtime rollback to the Workflow implementation, old data, or an older build. The backup is not a rollback package. Ordinary source-control recovery during development remains a development practice, not a shipped compatibility feature.

## DEL-633 removal boundary

The inventory below reflects the codebase inspected during planning. Implementation must repeat the repository scan because the Playbook tracks may move or replace these surfaces before DEL-633 begins.

### Persisted types and storage

Remove the legacy fields and types from `alinery-core/src/types.rs` and every Rust and TypeScript mirror, including:

- `Task.workflow` and `Task.auto_advance`;
- `SessionMeta.workflow`, `SessionMeta.phase`, `SessionMeta.generic`, and `SessionMeta.handoff_artifact`;
- `SemanticCheckpoint.phase_completed_at`;
- `SessionState.workflow`;
- `RunnerEvent::PhaseCompleted`;
- the `Workflow*`, `WorkflowFile`, `WorkflowStep`, `WorkflowColumn`, `Phase`, `AutoAdvanceEdge`, and `ReviewHandoff*` families; and
- Workflow-bearing task, subtask, Session, prompt, settings, and status payloads.

Stop reading and writing:

- `.alinery/workflows.toml`;
- `.alinery/workflows/**`;
- Workflow, phase, auto-advance, generic, and Review-handoff fields in old Task frontmatter and Session JSON;
- legacy Review `*.handoff.json` records; and
- old phase-completion semantic checkpoints.

Remove the corresponding paths and handling from `alinery-core/src/paths.rs`, `backup.rs`, `settings.rs`, and `bin/alinery-migrate.rs`. Add no serde alias, default fallback, legacy detector, conversion, compatibility projection, or targeted “unsupported legacy data” layer. Preserve generic storage, backup, and migration machinery only when the new Playbook store actively uses it for non-legacy purposes.

### Core Workflow implementation

Delete the Workflow-only registry, default seeding, caching, migrations, prompt resolution, artifact assignment, completion, auto-advance, and Review-handoff paths concentrated in `alinery-core/src/shared.rs`, including the behavior represented by:

- `ensure_workflows`, `load_workflows`, `get_workflow`, and `default_workflow`;
- bundled Workflow migrations and prompt lookup;
- `resolve_workflow_step_prompt` and Workflow artifact helpers;
- Workflow branches of Session preparation, launch, and preview;
- `send_review_handoff*`;
- `completion_decision`, `find_enabled_auto_edge`, and `next_step_session_exists`; and
- Workflow-driven subtask selection and first-step creation in `alinery-core/src/subtask.rs`.

Do not retain wrappers around deleted behavior. If an equivalent Playbook behavior is required, its existing Playbook implementation is the one canonical home.

### Tauri commands and app backend

Delete `alinery-app/src-tauri/src/workflow.rs` and remove its registration from the Tauri command handler. Remove the legacy command surface, including:

- `list_phases`;
- `list_workflows` and `list_workflows_for_repo`;
- `get_workflow`;
- `list_workflow_steps` and `list_workflow_steps_for_repo`; and
- the Workflow-derived form of `list_kanban_columns`.

Remove Workflow and phase parameters and projections from task and Session commands. Delete `send_review_handoff` and every Review-specific approval or handoff special case. Converted Review behavior must execute generically as a Playbook.

### Daemon, runner, and wire protocol

Remove from `alineryd`, `alinery-core/src/daemon_client.rs`, the runner, and the OMP extension:

- `CompletionEventAction` and legacy phase-completion acceptance;
- `PhaseCompleted`, `phase_completed`, and `alinery_phase_complete` events or tools;
- `OpenRequest.phase` and the corresponding wire field;
- Workflow completion checkpointing;
- `start_auto_advance*`, `reconcile_auto_advance*`, and `create_and_spawn_auto_advance*`; and
- all Workflow and phase projections sent over the wire.

This is a real protocol-surface change. Bump the daemon protocol version and the runner event protocol when applicable. Retain the existing fail-closed protocol-mismatch classification that protects current clients and daemons; do not add a compatibility shim for legacy Workflow fields or events. The cutover has no live Sessions, so no old daemon must be carried across it.

### MCP

Delete the legacy MCP tools:

- `alinery_list_phases`;
- `alinery_list_workflows`;
- `alinery_list_workflow_steps`; and
- `alinery_send_review_handoff`.

Remove Workflow and phase fields from task creation, Session creation, subtask creation, list, and status contracts. Playbook Tasks pin one concrete Playbook; the engine and scheduler create Step Execution Sessions; status exposes Playbook-native Task, Step Execution, State, Transition, binding, claim, and Session data.

Keep only Playbook-neutral artifact, repository, task, subtask relation, Session transport/history, storage, and backup tools. If auxiliary Sessions remain, model them directly rather than retaining `generic` as a Workflow-versus-generic compatibility discriminator.

### Frontend

Delete the Workflow-only frontend modules and their tests, including:

- `WorkflowGraph.tsx`;
- `ReviewHandoffPage.tsx`;
- `phases.ts`; and
- Workflow, phase, auto-advance, and Review-handoff IPC declarations and mirrored types.

Remove or replace legacy surfaces in task creation, Session creation, Task Detail, Kanban, Grid, task and Session lists, notifications, Session View, settings, attention logic, and artifact classification. The replacement must use the already-working Playbook Task, Step Execution, State, Transition, and Session projections; DEL-633 must not invent those projections or leave empty components waiting for them.

Preserve generic terminal, task, artifact, navigation, notification, and repository UX where it already serves Playbooks. Remove Review-only approval buttons, handoff controls, provenance badges, and special routing.

### Bundled prompts and configuration

Delete:

- `alinery-app/src-tauri/workflows.default.toml`;
- `alinery-app/src-tauri/workflows/{rpi,one-shot,review,bug-hunting}/**`; and
- compatibility copies under `alinery-app/prompts/rpi/**`.

Remove the default `workflow = "rpi"` configuration. Rewrite `prompts/subtask-manager.md` and `prompts/subtask-manager-recovery.md` around Playbook attachment and Task-owned progression if those prompts remain in the new design.

Built-ins have one runtime source: the final validated v1 files materialized in `<repo>/.alinery/playbooks/*.md` by the supported product initialization path. Do not preserve a second embedded Workflow source.

### Telemetry

Remove Workflow and phase sanitizers, dimensions, and events, including:

- `session.phase_complete`;
- `session.auto_advance`;
- `artifact.review_handoff`;
- Task `workflow`; and
- Session `phase` and `generic` properties.

Update `scripts/telemetry/APP.md` and its fixtures. Add Playbook-native telemetry only when another settled Playbook ticket already owns and uses it; DEL-633 does not invent a new taxonomy to replace every deleted event.

### Tests, checks, and documentation

Delete or rewrite tests whose contract is legacy Workflow behavior across core, daemon reconciliation and semantic events, runner completion, MCP schemas and tools, Tauri task/Session/artifact behavior, telemetry, and frontend Workflow, phase, auto-advance, and Review views.

Update current documentation, including `AGENTS.md`, the root and app READMEs, `alinery-app/VERIFY.md`, MCP and daemon architecture documents, session/task wiki pages, and telemetry documentation. Historical planning documents and mockups may remain only when clearly marked as historical rather than current behavior.

Add one exact static gate to `scripts/check.sh` that rejects the removed paths, symbols, command names, MCP tools, and runner event names. Do not ban the generic English word “workflow,” which remains valid when discussing GitHub workflows or ordinary process.

## Preservation boundary

Keep the following only where the production Playbook implementation actively uses them:

- Task and Session filesystem primitives and atomic I/O;
- artifacts, attachments, numbering, safety, viewing, comments, and drafts;
- prompt-extra and engine-generated context composition;
- harness and model resolution;
- daemon PTY ownership, transport, lifecycle, history, reattachment, and host protection;
- worktrees and repository operations;
- task relations and subtasks;
- storage accounting and backup machinery;
- notifications and attention aggregation; and
- current protocol compatibility classification.

The preservation test is not “did Workflows use this?” It is “does landed Playbook code use this now?” A shared primitive with a real Playbook caller survives. A Workflow-shaped facade, empty adapter, placeholder type, or wrapper with no active Playbook caller is deleted.

## Acceptance after removal

DEL-633 is complete only when all of the following are true:

- DEL-641 passed before deletion began.
- No shipping Workflow runtime, type, persistence field, command, MCP API, UI surface, prompt/configuration source, telemetry field, or compatibility test remains.
- No code exists solely to recognize, migrate, display, freeze, reject, or support old Workflow data.
- No legacy file or field is recreated from a clean Playbook-only repository.
- No Task can be advanced by both authorities.
- Retained infrastructure exposes Playbook-native or genuinely neutral contracts, never Workflow-shaped seams.
- The daemon and runner protocols are bumped where their removed surface requires it, with no Workflow shim.
- The static no-legacy gate passes.
- `cargo check -p alinery-app` passes after Rust changes.
- The full repository `./scripts/check.sh` passes.
- All five replacement Playbooks still pass their real Alinery execution proof against the Workflow-free result.

No acceptance test may preserve a pre-cutover Workflow Task, Workflow Session, Workflow-session resume path, migration, conversion, or read-only compatibility view.

## Explicitly rejected approaches

| Rejected approach | Why it is rejected |
| --- | --- |
| Exact feature or behavior parity | The team selected zero old behavior as a requirement; Playbooks define the future contract. |
| Converting existing Workflow Tasks | Legacy storage cannot truthfully reconstruct Playbook provenance, and the team chose manual cutover. |
| Read-only legacy history in Alinery | It still requires parsers, types, views, and maintenance solely for obsolete data. |
| Keeping Workflow-shaped stubs or extension points | They are immediate codebase bloat and misrepresent the new architecture. |
| A compatibility adapter or dual scheduler | It creates two authorities and extends the life of the obsolete model. |
| A feature flag or staged partial deletion | It leaves a supported mixed state and code that must be deleted later. |
| Handling live Sessions during upgrade | The three users will coordinate a window with no Sessions running. |
| Product rollback to old code or data | Supporting rollback retains the legacy boundary the cutover is intended to remove. |
| Requiring every sibling issue to close | The selected gate is observable capability through DEL-641, not project-board status. |
| Treating candidate documents as runtime proof | PR #237 establishes replacement definitions; only real Alinery executions establish readiness. |

## Linear ownership and traceability

| Record | Ownership after the grill |
| --- | --- |
| [DEL-624](https://linear.app/delegance/issue/DEL-624/implement-the-playbook-execution-engine) | Parent epic and canonical cross-track decision ledger. Decision D-080 records this hard-cutover contract. |
| [DEL-635](https://linear.app/delegance/issue/DEL-635/simplify-pr-237-playbooks-to-artifact-based-fan-out) | Revises all eight PR #237 candidate Playbooks to the final v1 source contract. |
| [DEL-641](https://linear.app/delegance/issue/DEL-641/validate-the-five-replacement-playbooks-end-to-end-in-alinery) | Owns the capability gate and blocks DEL-633. |
| [DEL-633](https://linear.app/delegance/issue/DEL-633/remove-the-workflow-implementation) | Owns one deletion-only hard-cutover change after DEL-641 passes. |
| [DEL-626](https://linear.app/delegance/issue/DEL-626/bridge-playbook-executions-to-alineryd-sessions-and-completion) | Retains current protocol-mismatch safety while adding no legacy Workflow wire compatibility. |
| [DEL-628](https://linear.app/delegance/issue/DEL-628/implement-the-playbook-scheduler-limits-and-recovery) | Owns exclusive evaluator authority for Playbook Tasks; DEL-633 owns later global Workflow deletion. |

The live Linear updates were read back after mutation: DEL-641 is a direct child of DEL-624, DEL-641 blocks DEL-633, DEL-633 remains `Todo` and deletion-only, DEL-624 remains `In Progress`, and unrelated ticket fields and statuses were preserved.

## Boundaries of this record

This record settles Workflow-removal sequencing, support policy, proof, and deletion scope. It does not:

- implement or validate the Playbook engine;
- revise the candidate Playbook definitions;
- select physical State storage or settle open engine semantics;
- reopen approval semantics owned elsewhere;
- require production deployment rather than the production Rust code path;
- authorize deleting user data automatically; or
- claim that the hard cutover has happened.

Future Playbook-schema migration between supported Playbook versions is separate from legacy Workflow migration. Nothing here forbids a future migration mechanism for Playbook-native data; it forbids adding one for obsolete Workflow data.

## Final cutover invariant

After DEL-633, an Alinery repository is Playbook-native. Every surviving execution, persistence, API, UI, prompt, telemetry, and test surface is either used by Playbooks or genuinely neutral infrastructure. There is no code path whose purpose is to understand the old Workflow model.
