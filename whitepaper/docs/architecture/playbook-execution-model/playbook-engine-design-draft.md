# Playbook engine: compact design draft

Started 2026-09-04; synchronized through Q42 on 2026-09-05. **Agreed behavior, not an implementation-ready specification.** Sections 1–6 consolidate behavior; section 7 tracks remaining work and the subsequently selected SQLite database; section 8 proposes verification rather than reporting completed tests.

References: [full decision ledger](playbook-state-transition-execution-decisions.md), [DEL-624 shared decisions](https://linear.app/delegance/issue/DEL-624), [DEL-629 State model](https://linear.app/delegance/issue/DEL-629), and [DEL-625 source contract](https://linear.app/delegance/issue/DEL-625). The ledger retains amendments and detailed examples. Research screenshots illustrate behavior; the outdated PDF is not normative.

## 1. Scope and ownership

A Playbook is an execution policy, not a goal-based search. Each Playbook-driven Task has one selected Playbook, pinned as exact source bytes at first attachment. Another Playbook runs in a sub-task. “Running a Playbook” means the Task progressing through its selected Playbook; there is no separate Run identity.

The Task owns Executions, claims, rerun policy, limits, and progression status. These controls are not part of material State identity. Workspace operation is local.

The approved authoring principle (D-085) is: “A good Playbook expresses its required dependencies. It does not rely on one agent happening to finish before another.” See the [authoring guide](playbook-authoring-guide.md). This does not approve Q41's newer-descendant source-selection preference.

## 2. Three logical record responsibilities

| Record | Meaning and captured information |
| --- | --- |
| **State** | Immutable material: repository Git tree identity plus a complete separate artifact manifest mapping logical paths to content hashes. |
| **Step Execution** | One application of a pinned Step, carried out by one or more sequential Sessions. Records the exact engine-assigned binding, complete selected source-State set, Session links, each source's chosen Git commit reference, and finalized result commit when accepted. An explicit retry links to the failed Execution. |
| **Transition** | One selected source State → accepted result State relationship, referencing the Execution. |

> A Transition records a source-to-result relationship within an accepted Execution. It does not claim that its source State was the sole input responsible for the result.

One accepted Execution has one result State and one Transition per distinct selected source State. A merge therefore has multiple Transitions sharing one Execution and result. Failed or otherwise unaccepted Executions do not publish accepted Transitions.

These are logical responsibilities, not a decision to use exactly three SQL tables. Claims and lifecycle records remain necessary outside State material.

### Material identity is separate from history

The State hash covers the repository **tree**, not the Git **commit**, and the complete artifact manifest. It excludes parents, Executions, bindings, Sessions, commit metadata, workspace paths, and Task controls.

Identical captured material reuses the same State hash. Executions and Transitions still record each accepted operation. Self-loops, revisits, and cycles are allowed; the material graph has no DAG or termination guarantee. A State hash is not a unique arrival or provenance identifier.

Each State has a complete logical manifest, not only an ancestor-relative delta. Deduplicate bytes by content hash; add further manifest structural sharing only if size becomes a measured problem. Canonical serialization and the State-hash algorithm remain unspecified.

## 3. Inputs, claims, and recurrence

The engine selects and records formal inputs and source States **before Sessions start**. Store the binding once on the Execution; Transitions reference it through that Execution.

Session prompts combine unchanged Step instructions with engine-generated execution context. **The recorded binding is authoritative; the prompt communicates it.** Neither agent statements nor before/after diffs determine the assignment afterward. Binding is an assignment, not a visibility restriction: inspecting other available files does not change it.

The settled source contract provides positive, flat AND inputs; multiple exact paths; at most one ordinary wildcard fan-out axis; and explicit `complete:` inputs. Multiple `complete:` requirements jointly require result coverage for every request in the same exact finite set. Empty complete sets create no application. There is no implicit pairing or Cartesian product of ordinary wildcards, authored absence condition, or general join language. Outputs remain advisory, not completion gates.

Material eligibility, automatic claimability, and scheduler capacity are separate. Claims identify the pinned Playbook, Step, and exact assigned binding and are acquired atomically before capacity is applied; their precise provenance/key representation remains open.

Agreed repeat behavior:

- Handled inputs remain handled through unchanged inheritance, even when unrelated material changes the surrounding State hash. A no-op can still handle its assignment.
- Actual input changes, including reversions, can enable recurrence under Task policy. Independent legitimate Executions that each actually change A → B retain distinct introduced input histories even if the resulting bytes match. Potential duplicate branch work is acceptable.
- Changed-input automatic reruns default off, controlled by one mutable Task-wide switch. First eligible applications remain automatic; disabling reruns does not retract acquired claims. Enabling uses ordinary evaluation, not a separate replay mechanism.
- Producing a successor does not retire its source State from consideration. Earlier eligible unhandled work can still start there.

Neither a new whole-State hash nor globally “seen before” file bytes is a sufficient claim identity.

## 4. Workspace and merge contract

An unfinished Execution exclusively owns its writable repository and separate artifact area. Concurrent Executions use isolated writable areas. Sequential Executions may reuse a released workspace, but only after prior writers are stopped or fenced and assigned material is restored. States do not each require a permanent worktree.

For multiple assigned sources, initialize the writable areas from one source selected by a stable deterministic rule. Make the original snapshots of **all** assigned sources separately available read-only. The default is an operational starting copy, not a semantic winner or a shared-ancestor baseline.

Generated context identifies the actual working paths, bound inputs, source snapshots and commit references, default source, writable areas, and capture boundaries. Reference views are not live sibling workspaces and are not recursively captured as result artifacts. Instructions do not substitute for read-only enforcement.

Every multi-source Execution is an agentic merge. The engine chooses **what is assigned**; the harness chooses **how to use, combine, adapt, or omit its content**. No engine rule selects one appraisal document within assigned sources as the authoritative content.

The harness must consider repository changes across all assigned sources and finalize one result commit. Only that commit's tree becomes the repository result; omitted source changes remain in history but are absent from this result. Artifacts are captured separately. Different commits may share identical read-only files as an optional optimization without collapsing their references.

## 5. Completion, failure, and stopping

On every completion request, the engine checks repository readiness regardless of Session-running status. The harness finalizes the intended Git commit; the engine never silently commits or discards work. An unchanged repository needs no empty commit.

Tracked staged/unstaged changes and nonignored untracked files block acceptance. Report affected paths and explain the options: commit intended repository content, move artifacts to the captured artifact area, move temporary files to scratch, or safely delete disposable files. Preserve uncertain/user-owned files. Do not routinely edit ignore rules to bypass the check. Use ordinary Git status/ignore behavior: ignored untracked files neither block nor enter the repository snapshot; no custom ignored-content audit.

Rejected completion is **not Execution failure**. Keep the same Execution, assignment, claim, and workspace while the agent corrects and resubmits, without a separate correction-attempt cap. Existing resource limits still apply.

Accepted completion captures the actual final repository/artifact material. There is no agent publication-path list or same-byte republication event. Deleted artifacts are omitted from the manifest; an empty file remains present with its content hash. Untouched downstream artifacts remain captured; presence does not establish freshness. Historical States are unchanged.

Terminal failure retains an inspectable failed Execution and requires explicit retry, not automatic relaunch of unchanged work. Retry creates a new linked Execution with the original source-State set and exact binding. Ordinary new-Execution startup applies; no new transcript-replay feature is implied.

**Q42/D-086: Session resumption is deferred.** Do not automatically start another Session after reboot/termination to resume unfinished work, and do not add a manual Resume action in v1. This does not alter reconnecting to a still-running daemon-owned Session, ongoing completion correction, or the separate explicit retry of terminally failed Executions. Persisted-record/accepted-result recovery remains necessary; interruption classification and exact claim/workspace handling still need specification. No partial-work deletion or mandatory retention subsystem was authorized by this answer.

Independent work continues after failure. Accepted results enable further Steps only when ordinary requirements and policy permit. Normal progression stops when no eligible unhandled automatic applications and no queued/running Executions remain. Capacity constraints and reached limits are different from exhaustion. **Done does not mean every Execution succeeded**: retain failed work visibly for attention, preferably with a small indicator.

## 6. The research example through this model

“Appraise” means assess a source against a research question. These examples do not specify binding encodings.

| Operation | What happens |
| --- | --- |
| Linear | Frame reads the assigned agenda in S0 and adds questions. S1 contains the full agenda/questions manifest and unchanged Git tree. E1 records the assignment and commit references; its Transition is S0 → S1. |
| No-op / loop | Design changes the agenda and produces S4. With reruns enabled, Frame can run on that changed input. If Frame changes nothing, its accepted result remains S4 and its Transition is S4 → S4. Unrelated additions alone would not refresh the agenda assignment. |
| Fan-out | S2 contains four requests: Q1/A, Q1/B, Q2/B, Q2/C. `requests/*.md` gives four separately bound Appraise Executions. Each result contains S2 plus its own changes; sibling results are not implicitly unioned. |
| Merge | Q1 synthesis is assigned S3a and S3b. One synthesis Execution produces S4q1, with two Transitions into it. The harness determines its actual material. Design can similarly use selected syntheses from independently progressing question branches. |

For further examples, enumerate eligible applications, claims, and merge prerequisites; do not leave eligible work unexplained. Source-version selection and result association remain open below.

## 7. Three remaining design areas

**A. General binding/provenance and source-selection model.** Define concrete addresses for initial inputs, changed introductions, unchanged inheritance, claims, and finite request/result coverage. Specify which source versions form an application. Material State hashes and file path/hash pairs alone cannot distinguish all agreed histories. Derive coverage from captured material and Execution/Transition provenance, not a hidden mutable completeness ledger or agent publication list. Q33's identical-byte merge case stays an unanswered consistency test, not a special execution-count policy.

**B. Storage and reliable publication.** **Q40 selected SQLite for authoritative logical records on 2026-09-04.** The [SQLite discussion record](https://github.com/DeleganceAI/saga/blob/codex/playbook-execution-model/docs/architecture/playbook-execution-model/sqlite-storage-decision.md) preserves alternatives and implementation guidance. Canonical State encoding, retained Git/blob availability, concrete schema, Rust library, database partitioning, and crash-consistent acceptance still need specification. The earlier SQLite/filesystem write ordering remains a proposal, not an adopted complete protocol. Hashes detect mismatches against trusted expected hashes; they do not make publication atomic or prove semantic correctness.

**C. Completion and recovery protocol.** Specify authenticated completion, consistent capture/writer fencing, duplicate and stale events, persisted-record reconciliation, interruption classification, and claim recovery. Session resumption is deferred under Q42/D-086; it is not a v1 Resume feature or delivery dependency. Broader archival, retention/purge, and manual wakeup remain scope boundaries, not reasons to reopen ordinary sibling progression or fresh-Execution semantics. The question session ended after Q42; these engineering gaps remain explicit rather than silently settled.

Recommended order: resolve A against ordinary examples, then storage and recovery. Directory names and field spellings do not need separate grilling rounds.

## 8. Proposed verification and handoff

Turn the agreed behavior into acceptance tests covering:

- Identical material reuses State identity while accepted operations remain recorded.
- Unchanged inheritance suppresses repeat work; actual changes and independent introductions follow the rerun policy.
- Fan-out isolation and multi-source merge grouping; complete-set coverage cannot be satisfied by unrelated or incomplete results.
- No-op, modification, empty-file, and deletion capture; old States remain unchanged.
- Completion rejection/correction; ordinary ignored-file handling; no accepted partial result.
- Safe workspace reuse and immutable source views.
- Failure with continuing siblings, exhaustion with visible failure, and explicit retry of the original assignment.
- Crash, stale/duplicate completion, and interrupted-work cases once the persistence protocol is specified.

These tests have not run. Final acceptance criteria and delivery slicing remain; the parser/discovery split is unchanged. The full ledger is preserved. This draft accompanies the ledger's documentation-only handoff to PR #237; it includes no runtime implementation or claim that the proposed tests passed.
