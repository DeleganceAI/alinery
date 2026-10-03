# Playbook States, Transitions, and Step Executions

Decision ledger from the DEL-629 design discussion, synchronized through Q42 on 2026-09-05.

Status: **this question session ended after Q42; not an implementation-ready specification**. This file records accepted decisions, their implications, superseded proposals, and remaining engineering work. The user requested no further questions in this session. This is the documentation-only publication edition for PR #237. Historical synchronization entries below describe what was published at each earlier point; this handoff does not change those decisions.

Primary references:

- [DEL-624 — Implement the Playbook execution engine](https://linear.app/delegance/issue/DEL-624): shared cross-track decision ledger.
- [DEL-629 — Implement Playbook States, occurrences, collections, and claims](https://linear.app/delegance/issue/DEL-629): owning State-model grill.
- [DEL-625 — Define Playbook parsing, validation, and version identity](https://linear.app/delegance/issue/DEL-625): already-settled source contract and input/output declarations.
- [PR #237 — Playbook execution model design and prototypes](https://github.com/DeleganceAI/saga/pull/237): documentation handoff.
- [Compact design draft](playbook-engine-design-draft.md): consolidated behavior and remaining engineering work.

The supplied research-example screenshots are examples only. The old PDF is not normative for these decisions, and the full PDF was not read for this synchronization. In particular, its acyclic-State-history wording does not override the decisions below.

## 1. The boundary we agreed on

A State describes captured material. An Execution describes an application of a Step. A Transition records a source-to-result relationship within an accepted Execution.

> A Transition records a source-to-result relationship within an accepted Execution. It does not claim that its source State was the sole input responsible for the result.

That distinction is important for both repeated material and multi-source merges. The material graph may contain cycles, self-loops, and several Executions arriving at the same State hash. We do not need a fourth entity called a “history record” to explain those relationships.

### Three core logical record types

| Record | What it represents | Agreed information |
| --- | --- | --- |
| State | One immutable captured material snapshot | Repository Git tree; complete separate artifact path-to-content-hash manifest |
| Step Execution | One application of a Step, carried out by one or more Sessions | Step identity; exact engine-assigned input binding; complete selected source-State set; Session links; chosen Git commit reference for each selected source and finalized result commit; link to the failed Execution when this is an explicit retry |
| Transition | One source-to-result relationship belonging to an accepted Execution | Source State; result State; reference to that Execution |

These are logical responsibilities, not a mandate for three SQL tables, a particular database, or an exhaustive inventory of all engine records. Task-owned claims, lifecycle information, and other runtime concerns still exist outside material State identity. There is no separate Run identity (Q29/D-076). Exact field names, physical normalization, indexing, and the full schema remain open.

“Execution of a Step” means the one or more Sessions that ran to carry out that Step application. A Session is not itself the Execution. Existing continuation rules retain the Execution and its binding rather than silently creating a different assignment.

References: D-004, D-056, D-058, D-059.

### One Playbook per Task

Each Playbook-driven Task has one selected Playbook. When another Playbook needs to run, create a sub-task for it rather than attaching multiple Playbooks to the same Task. This follows the Task creation/selection model described by the user and preserves the pinned Playbook snapshot under D-053. Q28's independent-Run framing was rejected; neither the proposed cross-Run source-isolation rule nor automatic cross-task source sharing was approved. Q29/D-076 subsequently settles Task-owned Playbook progression without a separate Run identity.

Reference: Q28/D-075. This is a recorded product/design boundary, not a claim that the current application implementation was independently audited here.

### Task-owned Playbook progression; no separate Run identity

> “Running a Playbook” would simply mean that Task progressing through its selected Playbook.

The Task owns its Step Executions and execution history, claims, changed-input rerun setting, and overall Playbook progress/control state; do not introduce a separately identified or independently startable Run between Task and Step Execution. Earlier Run-control and Run-wide policy references denote this Task-owned control scope. Existing rerun defaults, claim-before-scheduling rules, completion-correction behavior, policy-exhaustion conditions, and applicable limits remain unchanged. Task/control ownership remains outside material State identity. This does not settle exact claim keys, candidate-State selection, terminal-failure retries, or permanent closure versus resumability, and it does not choose a database schema.

Reference: Q29/D-076. Historical question/audit entries below retain their original Run wording where useful; they do not require a separate runtime entity.

## 2. What contributes to a State hash

The agreed material identity comprises:

1. The captured repository Git tree.
2. The complete separate artifact manifest: normalized logical path to exact content hash.

| Information | In material State hash? | Logical home |
| --- | --- | --- |
| Captured repository tree | Yes | State |
| Complete artifact paths and content hashes | Yes | State |
| Parent/source relationships | No | Execution source set and Transitions |
| Producing Step Execution | No | Execution/Transition provenance |
| Exact assigned input binding | No | Execution |
| Sessions | No | Execution links and Session records |
| Starting/finalized Git commit hashes | No | Execution |
| Branch name or worktree location | No | Execution/workspace context; exact persistence not settled |
| Claims, scheduler bookkeeping, Task policy | No | Task-owned runtime control records |

Same captured repository/artifact material means the same State hash, even if different Executions, histories, or Git commits produced it. We deliberately do not salt material identity with its parents or producing action to force every arrival to be unique.

Consequently, a State hash is not a unique provenance or arrival identifier. Exact provenance addressing remains a separate design question; this ledger does not replace it with an invented occurrence key.

The discussion separated material from history; it did not establish a formal claim that the entire engine is Markovian. Scheduling can still depend on Task policy, claims, and Execution history outside the State hash.

The State hash algorithm and canonical byte encoding are not finalized here. The already-settled SHA-256 of exact Playbook source bytes is a separate identity and must not be confused with the State hash.

Reference: D-060; former D-015 is superseded.

### Complete manifests and shared bytes

Each State has a complete canonical material manifest. It is not only a delta that must be replayed through ancestors to recover its logical contents. File bytes are deduplicated by content hash.

The accepted recommendation was to keep reads, merges, export, verification, and recovery understandable with complete manifests, adding further manifest structural sharing only if manifest size becomes a measured problem. “Complete” does not require physically copying every file's bytes into every State.

Structural sharing means reusing unchanged portions of a representation across snapshots. Byte deduplication is already agreed; a more elaborate shared manifest structure is not required now. Git/filesystem copy-on-write workspace materialization is not prohibited by choosing complete logical manifests.

Reference: D-061.

### Hash verification is not a complete integrity policy

As discussed, recomputing a blob's content hash and comparing it with a trusted expected hash can detect byte changes or corruption. It does not prove that the content is correct for the task, identify why it changed, or protect against someone replacing both data and its expected hash. The verification schedule, trust boundary, retention policy, and repair protocol are not settled by choosing content-addressed bytes.

## 3. Repository capture and separate artifacts

“Captured repository tree” is a Git tree object ID/hash identifying the captured repository contents. It is not the Git commit hash. A commit also carries history and metadata; different commits can refer to the same repository tree.

The accepted repository snapshot must match a finalized Git commit. Work intended to be part of that repository capture must be committed before completion is accepted. The Execution records the starting and finalized commit references, while the State hashes the tree.

Q23/D-071 assigns finalization to the harness agents: they must finalize the intended repository result in Git before requesting accepted completion. The engine verifies and captures that finalized commit instead of silently committing or discarding unfinished repository changes. Uncommitted staged or unstaged changes to tracked repository material prevent acceptance until addressed. Q26/D-074 settles that rejected completion lets the agent continue correcting within the same Execution; exact feedback transport and Session continuation mechanics remain open.

A new commit is not required if repository material did not change. In a linear example, starting and finalized references can both be C0.

Playbook artifact files, such as `research-agenda.md` and `questions.md`, are captured separately from the repository tree. A research Step may change artifacts while retaining the same Git tree and commit. The expectation that repository work occurs on a branch, often in a worktree, does not turn a branch name or workspace path into material State identity.

Q22/D-070 subsequently settled recording the chosen Git commit reference for every selected source State, alongside the finalized result commit. Q23/D-071 settles who finalizes the commit and the uncommitted tracked-change boundary; Q24/D-072 settles warnings, guidance, and blocking acceptance for remaining non-ignored untracked files. Q25/D-073 uses ordinary Git ignore behavior. Not yet decided: submodules, LFS, other capture boundaries and exact validation mechanics; retention of referenced Git objects; exact commit-selection mechanics and field encoding. The linear example's single `starting_commit` field is not a settled merge schema.

References: D-060, D-062, D-070, D-071.

### Uncommitted-file warning and agent guidance

Q24/D-072 settles the diagnostic and instructions: the engine reports uncommitted repository files at completion with affected paths, distinguishing tracked changes from non-ignored untracked files. Agent instructions explain the options for untracked files:

- Commit intended repository content.
- Move durable non-Git outputs to the captured artifact area.
- Move temporary material outside capture into scratch storage; exact scratch paths and lifetime remain open.
- Delete only known-safe disposable files. Preserve uncertain or user-owned files and ask rather than guess.

Editing ignore rules is not a routine way to pass completion; a lasting repository rule must be justified by the task. The engine does not automatically commit, delete, or exclude files. No execution-specific exclusion registry is introduced by this guidance.

The user's subsequent explicit YES settles the acceptance effect: remaining non-ignored untracked files in the writable repository prevent completion from being accepted until the agent addresses them. The engine reports the affected paths and resolution guidance; this is a blocking warning, not merely an informational notice. D-071's already-settled rule that uncommitted tracked changes prevent acceptance remains unchanged. Q25/D-073 settles ignored-file treatment below. Q26/D-074 permits correction and resubmission within the same Execution; exact validation/continuation mechanics remain open. Separately captured artifacts are not treated as untracked repository files in this check.

Reference: D-072, extending D-071.

### Ordinary Git ignore behavior; no fancy check

Q25/D-073 follows the user's explicit simplicity constraint: use Git's ordinary status/ignore behavior for completion, with non-ignored untracked-file reporting enabled. Ignored untracked files do not block completion and are not included in the captured repository commit tree. Tracked changes and non-ignored untracked files still block under D-071/D-072.

Do not add custom ignore matching, audits of ignored contents, comparisons of ignore-rule versions, or a committed-rules-only filter. The earlier question's “committed ignore rules” wording is not a requirement to build a special ignore interpreter. Changes to a tracked `.gitignore` are ordinary tracked changes requiring finalization. Guidance against using ignore edits as a routine bypass remains agent instruction, not an extra enforcement mechanism. Exact status-command encoding and validation/continuation plumbing remain implementation details.

Reference: Q25/D-073.

## 4. Inputs belong to the Execution

The Step definition declares selectors. The engine chooses and records the exact binding before starting Sessions. With `requests/*.md`, the engine chooses which concrete matching request that Execution represents; the agent does not make that choice after it starts.

The user explicitly reaffirmed the DEL-625 distinction during Q19: a Step has at most one ordinary wildcard fan-out axis; two ordinary wildcards must not implicitly generate paired or Cartesian-product applications. Multiple explicit `complete:` requirements are allowed and jointly enable one aggregation over complete result lanes for the same exact finite source set. This is not a general pairing rule for independent lists (D-025/D-026).

The binding is stored once on the Execution. A Transition references the Execution rather than duplicating its binding. This also lets the binding exist before any result State exists.

The engine communicates the assignment by:

> combining the unchanged Step instructions with engine-generated execution context

The authored Step text and pinned Playbook are not rewritten to encode each application.

> The recorded binding is authoritative; the prompt communicates it.

The engine does not infer the binding afterward from what the agent says it read or used. A before/after material diff is also insufficient: an input may have been assigned and read without being modified.

Binding is an assignment, not a visibility restriction. Sessions may inspect other files in the whole materialized workspace without changing which request the Execution represents. The binding is not a complete file-access log or proof of all causal influences on the output.

The Execution records its complete selected source-State set before any Session starts, including when execution later fails or is abandoned. That snapshot context includes material outside the declared binding. A linear source is a singleton set; a merge selects multiple sources.

The exact format of a binding's provenance references is still open. A path/hash pair in an example below is explanatory shorthand, not a final occurrence identity for every recurrence or merge case.

References: D-056, D-059; existing continuation context in DEL-626.

### Q21 clarification: State-based evaluation, separate execution policy

Evaluate a Step against specific source State(s). Those States supply the full captured material context; declared inputs determine eligibility and the exact assigned binding, not the entirety of what Sessions may inspect. Whether an eligible application starts remains a separate Task-policy/claim decision. This reaffirms D-011, D-014, D-056, and D-059 rather than introducing a replacement execution policy.

The initial Q21 proposal to suppress work Run-wide based solely on identical bound files was withdrawn, not adopted. In the example, two different States inherit the same agenda but contain different appraisal artifacts. Their identical agenda binding alone does not settle whether Frame may execute from each source context. Neither “same bound files means never run again” nor “different State means always run again” follows from this framing. Exact claim scope across States, branches, and recurrence remains open; D-016 through D-020 and D-057 are not replaced.

Q31/D-078 subsequently settles the unchanged-inheritance case: if that particular agenda input was already handled, carrying it forward unchanged preserves its handled status despite differences elsewhere in the State. Q32/D-079 distinguishes independent actual input changes even when their resulting bytes match; exact claim/provenance encoding and merge inheritance/association remain open. The Q21 discussion above records the earlier clarification, not an instruction to reopen the now-settled inherited-input behavior.

This clarification changes neither the State/Transition/Execution record boundary nor the agreed workspace layout. It does not turn a Step into a pure function of its declared input files or put execution history into the material State hash.

### Earlier States remain usable after a successor

Producing an accepted successor State does not, by itself, retire its source State from automatic consideration. If two Steps are eligible from S1 and one produces S2, the other may still start from S1, even if its application has not yet acquired a claim or been assigned an Execution. Material eligibility, exact binding, claims, and Task policy still determine whether that work can start. Do not impose latest-State-only or branch-tip-only candidacy merely because a successor exists. This does not require rerunning every Step from every historical State or settle the remaining candidate-selection and claim-identity rules.

This is an automatic-candidacy decision, not merely historical snapshot retention or permission for already-assigned sibling Executions to finish. Workspace ownership and reuse remain governed by D-066; usable historical States do not require permanent worktrees.

Reference: Q30/D-077.

### Handled inputs remain handled through unchanged inheritance

After accepted Frame completion for a particular agenda input, engine-owned Execution/claim records retain its handled status when that input is inherited unchanged into successor States. Changes to other material or to the surrounding State hash do not erase that status or make Frame fresh work. In the research example, Design actually modifies the agenda and thereby supplies a changed input that can trigger Frame again, subject to the Task's changed-input rerun policy; Design is not a special-cased producer. This is unchanged inheritance, not global deduplication of every file with identical bytes. Full source States remain recorded and available to Sessions, but a new whole-State hash alone must not create a fresh automatic application. No mandatory done artifact, authored negative-input condition, or new material-State bookkeeping field is introduced. The original Q31 whole-State application-identity recommendation is withdrawn. Q32/D-079 settles that independent actual input changes remain distinct even when their resulting bytes match; exact claim/provenance encoding and merge inheritance/association remain open.

In the linear example, Frame produces SA containing the unchanged agenda and new questions. Discover adds sources to produce SB while retaining the same agenda. SA and SB differ as material snapshots, but Discover has not provided a fresh agenda for Frame. Later, Design's actual agenda change supplies the intended recurrence trigger. This behavior does not rely on the agent claiming it republished a file or producing a material change solely to record that it ran; accepted Execution/claim information records handled work even for a no-op.

The discussion of planning-style negative preconditions was an analogy for an already-handled guard, not approval to change the positive-only Playbook input grammar. Earlier immutable States remain usable under D-077, so material presence alone is not proof that an application is unhandled. This is not a termination guarantee for intentionally changing inputs or a redesign of terminal-failure retries.

Reference: Q31/D-078, refining D-016 and the Q21 clarification.

### Independent actual input changes remain distinct

When independently legitimate branch Executions each actually change an input from A to B, their introduced input occurrences remain distinct for claim tracking even if the resulting path and bytes match. For example, two branches may each change research-agenda.md to the same new text; with changed-input reruns enabled, each can trigger its own Frame Execution. The user explicitly accepts potentially duplicated downstream work when branches converge. Deduplicating content bytes or reusing a material State hash does not merge these distinct input histories. This differs from unchanged inheritance (D-078) and unchanged same-byte republication (D-063), neither of which introduces fresh work. Existing Task rerun policy remains unchanged. Exact occurrence/claim-key encoding, initial-input addressing, and merge inheritance/association remain open; no new material-State field, agent publication list, or database schema is selected.

The producing branch Executions are independently legitimate work, such as different assigned Step applications, not duplicate launches of the same already-claimed application. Both actually change the prior agenda; matching final bytes do not turn either change into a no-op. This decision does not yet determine which provenance references a single merged file retains when multiple assigned sources carry distinct introductions of those bytes.

Reference: Q32/D-079.

## 5. Accepted completion, no-ops, and deletion

### Accepted results and graph edges

Only accepted completion creates Transitions. Running, failed, abandoned, or otherwise unaccepted Executions can exist without accepted Transitions; do not invent a result State merely to record failure. A rejected completion request is not a failed or rejected Execution (Q26/D-074).

Each accepted Execution has exactly one result State. That is not necessarily a new State hash. It has one Transition per selected source State; all those Transitions share the same accepted Execution and result.

Q34/D-081 requires explicit retry after terminal Execution failure, Q35/D-082 gives that retry a new linked Execution, and Q36/D-083 preserves its original source States and exact input binding. Retry workspace/Session-context and claim mechanics, exact Session continuation mechanics, and the completion transaction remain open beyond these boundaries; correction after rejected completion is settled below.

References: D-058, D-064.

### Rejected completion means keep working

On each completion request, perform the agreed unfinished-repository checks without using Session-running status as a prerequisite. Rejected completion is not Execution failure: return actionable feedback and let the agent keep working in the same Execution, retaining its source assignment, binding, claim, and workspace. Allow as many corrections and resubmissions as needed, with no separate correction-attempt limit. Rejection publishes no accepted result State or Transitions and does not release the unfinished workspace. Independently applicable Task/resource limits are unchanged. Exact ordering, feedback transport, Session continuation mechanics, and writer fencing remain implementation details.

Reference: Q26/D-074. The earlier question's condition that the Session be running was withdrawn; it is not a requirement for the completion check.

### Terminal Execution failure requires explicit retry

After an Execution genuinely reaches terminal failure, retain its failed record for inspection and require an explicit retry before rerunning that work. The engine must not automatically relaunch the same unchanged application merely because it failed. This does not change D-074: a rejected completion request within an ongoing Execution is not terminal failure, and the agent may continue correcting and resubmitting within that Execution without a separate correction-attempt cap. Q35/D-082 settles that an explicit retry creates a new Execution linked to the failed one. Q36/D-083 preserves its original source States and exact input binding. Workspace/Session-startup mechanics, exact claim representation and lifetime, failure classification, and recovery of ongoing work remain to be specified. Q38 clarifies that ordinary eligibility governs sibling progression and Task stopping; terminal failure adds no automatic Task-wide pause. Existing changed-input rerun policy is unchanged; failure does not publish an accepted result State or Transitions.

Reference: Q34/D-081. D-080 belongs to the separately recorded Workflow hard-cutover decision in the shared epic and is not reassigned here.

### Explicit retry creates a new linked Execution

An explicit retry of a terminally failed Step Execution creates a new Step Execution linked to the failed one; it does not reopen the failed Execution. The original remains recorded as the failed attempt, and the retry records its own lifecycle and outcome. Reuse the existing Execution concept rather than adding a separate kind of retry record. This differs from continuation or completion correction within ongoing work, which retains the same Execution under D-074 and the Session continuation contract. Q36/D-083 subsequently settles retention of the original source States and exact input binding. Failed-workspace/Session-context reuse and exact claim handling/link encoding remain open. The explicit-retry requirement in D-081 remains unchanged.

Reference: Q35/D-082.

### Retry preserves the original assignment

An explicit retry retains the failed Execution's original source-State set and exact engine-assigned input binding, even when newer States now exist. The new linked Execution under D-082 repeats that recorded assignment rather than silently selecting newer material. This settles the formal assignment only: failed-workspace reuse, carry-over of unaccepted edits, Session conversation/context reuse, and exact claim/link handling remain separate questions. Source commit references remain governed by D-070; their exact selection/encoding mechanics are not settled merely by retaining State hashes. This introduces no exception to the existing new-Execution initialization rule; retaining a formal assignment does not authorize replacing its captured starting material with the failed checkout. Existing explicit-retry and ongoing-continuation distinctions remain unchanged.

Reference: Q36/D-083. Physical reuse of a workspace remains distinct from reuse of its old contents: D-066 requires safe release/writer fencing and initialization from the assigned material. No failure-file snapshot/retention system is introduced by this decision.

### Session resumption is deferred — Q42/D-086

Do not automatically launch another agent Session to resume interrupted unfinished work after a reboot or equivalent termination. Session resumption is deferred to a later feature, including a manual Resume action; v1 does not require implementing it. This corrects Q42's recommendation to offer explicit resume now. Reconnecting to an already-running daemon-owned Session and ongoing completion correction under D-074 are unchanged. Recovery/reconciliation of persisted records and accepted results remains necessary and is not Session resumption. Explicit retry of a terminally failed Execution remains governed by D-081 through D-083. This decision does not classify every interruption as terminal failure, authorize deleting partial work, or approve a new claim/workspace-retention protocol.

The user's final answer was: “no. later we will add the ability to resume a session”. Therefore the earlier Q42 recommendation to provide explicit resume now was not accepted. Future continuation invariants are not authorization to implement a v1 Session-resumption flow.

### No distinct same-byte republication event

The accepted rule is:

> an execution can return unchanged material, but we don’t treat that as a distinct artifact-republication event.

Capture the actual final material. Do not require an agent-supplied per-Execution `publish:` list or a list of output paths it claims to have republished. An unchanged file does not acquire a new material identity merely because the Step ran, said it produced the file, or declared an output selector matching it.

The Execution and accepted Transition(s) record that work happened. If the complete captured material is unchanged, the result reuses the existing State hash. A single-source no-op is an accepted self-loop.

This does not remove the Step's authored `outputs`. Those remain advisory expectations for guidance, possible pre-run dependency graphs, and non-blocking diagnostics under DEL-625. New or changed material outside the selectors remains valid. Exact diagnostic interpretation for unchanged inherited artifacts and result association still need reconciliation; do not silently restore a publication-list mechanism to solve them.

Reference: D-063.

### Deletion is permitted and is not an empty file

An accepted Transition may make a previously present artifact absent. The result's complete manifest omits the path.

| Result | Manifest representation |
| --- | --- |
| File retains its bytes | Path remains with the same content hash |
| File changes | Path remains with the new content hash |
| File becomes empty | Path remains with the hash of empty bytes |
| File is deleted | No entry for that path |

Deleting a file is not “setting its bytes to zero.” Absence and a present empty file differ. No deletion tombstone is needed in the State's material manifest.

For a linear Transition, comparing source and result manifests can reveal additions, modifications, and removals. Whether to persist a derived change index is not decided. Per-source diffs for a merge do not by themselves describe the entire multi-source operation or establish exclusive causation.

Old States stay immutable. Omitting a path from a new State does not delete the old snapshot or purge its blob. Historical retention and purge remain separate questions.

Artifacts are generally expected to be additive in ordinary work, but that is not a prohibition on deletion. Positive-only inputs and the exclusion of absence preconditions do not imply that artifact mutation must be append-only.

Reference: D-063; positive-input source rules remain in DEL-625.

### No automatic cleanup after upstream changes

If `questions.md` changes while `sources.md`, `synthesis.md`, and `design.md` remain present, those existing files remain in the result snapshot with their hashes. They disappear only if the actual final material removes them.

Presence does not assert that an artifact is fresh for a new input binding. No automatic cleanup or invalidation mechanism was adopted to remove old downstream files merely because an upstream artifact changed. A no-op Frame likewise does not remove the files it left untouched.

Reference: D-063.

## 6. Worked examples

These use the research example supplied in the conversation: Frame/Refine Questions, Discover Sources, Appraise, Synthesize, and Develop/Revise Design. “Appraise” simply means assess a source in relation to a research question; it is an ordinary Step, not a new runtime type.

All S/E/X/T/C/h names are symbolic aliases. YAML field names illustrate logical responsibilities, not a finalized database, wire format, hash codec, or complete persistence schema. The abbreviated Step identity refers to the Step in the pinned Playbook.

### 6.1 Linear: Frame adds questions

```yaml
states:
  S0:
    git_tree: T0
    artifacts:
      research-agenda.md: h-agenda
  S1:
    git_tree: T0
    artifacts:
      research-agenda.md: h-agenda
      questions.md: h-questions

step_executions:
  E1:
    step: frame
    source_states: [S0]
    input_binding:
      research-agenda.md: h-agenda
    sessions: [session-1]
    starting_commit: C0
    finalized_commit: C0

transitions:
  X1:
    from: S0
    to: S1
    execution: E1
```

C0 references T0. Only the separately captured artifact material changed, so no new repository commit is required. S1 contains the full artifact manifest, including the unchanged agenda, not just a “questions added” delta. Neither E1 nor X1 contributes to S1's material hash.

If Frame instead leaves every captured item unchanged, its accepted result is S0 and its Transition links S0 to S0. The Execution still exists.

### 6.2 Serial recurrence: Frame runs again without changing material

The conceptual Step sequence is:

```text
Frame → Discover → Appraise/Synthesize → Design → Frame again
```

Suppose Design updates the agenda from h-agenda-1 to h-agenda-2 and produces S4:

```yaml
S4:
  git_tree: T0
  artifacts:
    research-agenda.md: h-agenda-2
    questions.md: h-questions-1
    sources.md: h-sources-1
    synthesis.md: h-synthesis-1
    design.md: h-design-1
```

A later Frame Execution E5 is assigned the changed agenda, assuming the Task's claim/rerun policy allows the application. It can conclude that the existing questions already suffice and leave all material unchanged:

```yaml
E5:
  step: frame
  source_states: [S4]
  input_binding:
    research-agenda.md: h-agenda-2

X5:
  from: S4
  to: S4
  execution: E5
```

The comparison is immediately before and after **Frame E5**. Design already changed the agenda before S4 was captured. X5 being a self-loop does not mean Design failed to update the agenda or Frame did not run.

If Frame changes the questions or other captured material, it instead returns the corresponding different material State, called S5 if that identity is new to the example. Earlier files still remain unless actually changed or deleted.

If the agenda is Frame's sole bound input and Design does not change it, there is no changed-input reason for an automatic new Frame application. This is distinct from an eligible Execution receiving changed input but producing an unchanged result.

No special loop-State type or material loop counter is required to represent recurrence. It also does not imply acyclicity or guaranteed termination.

### 6.3 Fan-out: four separate Appraise Executions

For the example, discovery produces S2 containing the agenda, questions, and four request artifacts describing the plausible question/source pairs:

```text
requests/q1-a.md
requests/q1-b.md
requests/q2-b.md
requests/q2-c.md
```

An Appraise Step declares `requests/*.md`. The engine selects four concrete bindings before Sessions begin:

| Execution | Source State | Exact assigned request | Example changed/new artifact | Result State |
| --- | --- | --- | --- | --- |
| EA | S2 | requests/q1-a.md | appraisals/q1-a.md | S3a |
| EB | S2 | requests/q1-b.md | appraisals/q1-b.md | S3b |
| EC | S2 | requests/q2-b.md | appraisals/q2-b.md | S3c |
| ED | S2 | requests/q2-c.md | appraisals/q2-c.md | S3d |

Each Execution runs in an isolated workspace initialized from its recorded source. If those listed additions are its only changes, each result consists of the complete S2 material plus that Execution's one appraisal file. S3a does not acquire EB's output merely because EB finishes first or concurrently.

This is four separate Executions and four single-source Transitions. Fan-out does not implicitly union sibling results. The filenames illustrate the research example, not a new authored variable, collection-member schema, or automatic filename-pairing rule.

### 6.4 Merge: one synthesis Execution, two source links

Synthesis for Q1 selects the two relevant branch results:

```yaml
step_executions:
  E-synthesize-q1:
    step: synthesize-q1
    source_states: [S3a, S3b]
    # The exact binding is engine-recorded before Sessions start.
    # Its complete provenance-reference encoding remains open.

transitions:
  XA:
    from: S3a
    to: S4q1
    execution: E-synthesize-q1
  XB:
    from: S3b
    to: S4q1
    execution: E-synthesize-q1
```

EA and EB were different Appraise Executions. E-synthesize-q1 is one new Execution jointly using the selected sources. XA and XB are its two source-to-result relationships, not two synthesis runs or two independent explanations for all of S4q1.

Once accepted, S4q1 has its own complete material manifest. Its exact contents cannot be specified solely from these graph edges: the harness agents perform the merge and synthesis work that produces the candidate (Q17/D-065). Q19/D-067 establishes the general default-source startup and reference-view layout, and Q20/D-068 settles stable deterministic default selection. Exact paths and acceptance checks remain open. This example does not approve silent union, first-source-wins conflict resolution, or any particular merge algorithm.

The same relationship model can represent Design using selected Q1/Q2 syntheses, or selected syntheses from question branches that completed different numbers of research passes. The diagram does not decide which versions should be selected or how completeness is proved. The agents are responsible for handling the selected material appropriately, including overlapping files.

### 6.5 Every multi-source Execution is an agentic merge

Q17's answer is broader than permission to resolve file conflicts:

> Any Step Execution with more than one source State assigns responsibility for the merge to the harness agents running in that Execution's Sessions.

This applies to every merge, whether or not the source States contain conflicting paths. The agents perform the synthesis/integration work as well as any necessary conflict resolution; they are not merely a fallback after an engine-owned merge fails.

The engine still selects and records the exact sources and binding, provides source access and execution context, and retains authoritative accepted-result capture and Transition/provenance recording. Engine-generated context communicates the merge responsibility alongside the unchanged authored Step instructions. Agent ownership of merging does not transfer those engine responsibilities to the model.

The user reaffirmed the assignment/implementation boundary while discussing Q19: the engine chooses what material is formally assigned for merging, and the harness chooses how to merge that material during execution. The exact formal source set and binding are recorded before Sessions start; the harness does not retrospectively choose which inputs the Execution represented. This preserves the earlier rule that binding is an assignment, not a filesystem-visibility restriction: inspecting other available workspace files does not change the formal binding.

The choice of merge technique, starting checkout, or resulting file contents must not be confused with choosing the formal input set. That assignment clarification did not itself settle initialization; the subsequent general layout and prompt-context agreement is captured in D-067 below.

Q27 clarification: within the engine-assigned source States, the harness agents follow the Step instructions to decide which appraisal or other competing artifact content to use, combine, or disregard. Do not add an engine-enforced 'one appraisal per request' content-selection rule. These choices do not rewrite the recorded sources or binding; the engine retains formal source assignment, binding, and accepted-result capture. The original Q27 choose-one proposal is withdrawn. This reaffirms D-065; candidate source eligibility, exact complete-set result association, and claim/repeat scope remain separate open questions.

Two appraisal files captured by one Execution are material within its one result State, not two accepted Executions. Q27 does not establish that two alternative Executions for the same exact request are eligible candidates for a merge; that hypothetical was premature. Nor does it require automatically assigning every possible result State to a merge.

Q17 did not itself select a workspace layout or merge tool. Q19 subsequently established general startup roles, and Q20 settled stable deterministic default selection; exact tool provision remains open. Precise engine acceptance checks likewise remain to be designed; “agentic merge” is not a substitute for the accepted-completion boundary.

Reference: D-065; affected State, workspace, and Session tracks.

### 6.6 Local workspaces belong to Executions, not States

The user scoped this workspace design to local operation. In their common launch flow, selecting a worktree for a task/Playbook already provides a new branch and worktree; this is user-provided workflow context, not a new requirement to allocate a checkout for each State.

Q18 was reframed from merge initialization to workspace ownership. The accepted decision is:

> An unfinished Execution exclusively owns its allocated writable workspace. Sequential Executions may reuse that workspace after release; States do not each require a permanent worktree.

| Situation | Agreed behavior |
| --- | --- |
| Linear succession | The next Execution may reuse the task's selected worktree after the preceding Execution has finished and released it. |
| Concurrent Executions / fan-out | Use separate writable worktrees/workspaces, even if both Executions start from the same State. |
| Paused or continuable Execution | Preserve its unfinished workspace; do not hand it to a different Execution. |
| Historical State | Retain the immutable repository/artifact snapshot without requiring a permanent checked-out worktree. |

Reuse requires exclusive ownership: prior Sessions and other remaining writers must be stopped or fenced off before another Execution can use the workspace. Accepted completion alone is not proof that all writers have stopped. Isolation includes separately captured artifact files as well as repository material.

Reusing a directory does not modify or discard the accepted States it previously produced. The next Execution still starts from its assigned source material; whatever happens to be in a mutable checkout is not historical-State authority. A long linear chain can therefore retain many States while reusing one worktree.

The decision does not prescribe when queued work receives a workspace, a fresh branch for every Execution, automatic deletion of worktrees, or a historical retention/purge policy. Exact ownership/release/fencing enforcement, branch strategy, artifact paths, and cleanup remain open. Q18 did not settle merge initialization; the subsequent general layout is captured under Q19/D-067 below.

Reference: D-066; owning workspace track DEL-631, coordinated with State, Session, and scheduler tracks.

### 6.7 Default-source layout and the generated prompt

The user rejected starting the merge workspace from a shared earlier State, accepted using one assigned source as the default in general, and endorsed the proposed layout with the file layout supplied as part of the prompt.

The agreed general arrangement is one writable repository worktree plus a separate writable artifact area, initialized from an engine-designated assigned source State. The original snapshots of all assigned sources remain separately available as read-only references. The default is the initial copy, not an authoritative winner, and does not remove any other source from the formal binding.

Illustrative layout, with S3a as the default (names and absolute locations are not a finalized contract):

```text
execution-workspace/
├── repo/                         # Writable; initially S3a repository
├── artifacts/                    # Writable; initially S3a artifacts
│   ├── notes.md
│   └── appraisals/q1-a.md
└── sources/                      # Read-only original snapshot views
    ├── S3a/
    │   ├── repo/
    │   └── artifacts/
    └── S3b/
        ├── repo/
        └── artifacts/
            ├── notes.md
            └── appraisals/q1-b.md
```

The engine-generated execution context accompanies unchanged authored Step instructions and describes the actual layout used for that Execution:

- Working directory and writable repository path.
- Writable result-artifact path.
- Original source snapshot identifiers and their read-only reference paths.
- Exact bound input locations, qualified by source where necessary.
- Which assigned source initialized the writable workspace.
- Which writable areas will be captured as the result, and which reference areas will not.

The prompt communicates the engine-owned assignment and access roles. It is not itself the enforcement mechanism for read-only access. Original snapshot views must not be confused with live sibling workspaces that may subsequently change. Binding remains an assignment, not a prohibition on inspecting other available material.

The engine captures the writable repository's finalized Git tree and the writable artifact manifest. It does not recursively capture `sources/` as new result material. An existing selected worktree need not move into this illustrative structure, and reference views do not require a permanent Git worktree per State.

Unchanged starting material will remain in the result, so the default has practical influence even though it has no special semantic authority. The harness remains responsible for merging all assigned material appropriately. Rejecting a shared earlier State as the starting workspace does not prohibit an agent's merge tools from consulting history.

Still open: exact path names and absolute locations, working-directory/access details, reference-view materialization and read-only enforcement, and precise acceptance checks. No database or new physical storage schema is selected here.

Reference: D-067, extending D-056 and coordinated with D-065/D-066.

### 6.8 Deterministic default-source selection

The engine chooses the default initialization source from the already-assigned source set using a stable, deterministic rule, not branch completion order, scheduling timing, or worktree availability. A simple stable ordering of assigned sources is sufficient; the exact ordering implementation is not prescribed here. The chosen default is communicated in execution context (D-067). This neither changes the formal input/source assignment nor gives that source semantic priority, and does not promise deterministic agent output.

In the two-source example, reordering the arrival of S3a and S3b must not change which one initializes the writable areas. Reusing an available worktree cannot silently substitute a different default. This decision does not settle which candidate States or result versions should enter the formal source set in the first place.

Reference: Q20/D-068.

### 6.9 Repository reconciliation and one final snapshot

While discussing Q22's proposed per-source Git commit references, the user refined the meaning of the default checkout and the instructions the harness receives:

For a multi-source Execution, the default repository checkout is an operational starting point, not the sole semantic source. Engine-generated instructions must require the harness agents to consider repository changes from all assigned sources and decide what to incorporate, adapt, or intentionally omit. One finalized Git commit's complete tree defines the result's repository snapshot; changes left only in other source snapshots are not automatically carried into it. “Dropped” means excluded from this result, not deletion of source States or Git history. Formal source assignments remain unchanged, and separately captured artifacts remain outside this Git-only rule.

For example, the writable checkout starts at C_A while the Execution also has an assigned source associated with C_B. The harness reconciles their repository material and the accepted result captures the complete tree of C_result. A change found only in C_B and omitted from that final tree is not carried into the result by an implicit engine union. The default source is not an authoritative winner; its contents may also be revised or removed by the harness.

One finalized result commit does not mean only one commit may be created during execution, nor does it prescribe the final commit's Git parent structure. A new commit remains unnecessary when repository material is unchanged (D-062). This is an explicit instruction/result boundary, not a new per-file rejection ledger or proof that the agent inspected every change. Q23/D-071 subsequently settles agent-owned finalization and rejection of uncommitted tracked changes; Q24/D-072 adds the non-ignored untracked-file gate; Q25/D-073 uses ordinary Git ignore behavior. Other acceptance details remain open.

This repository-result refinement did not itself approve Q22's original per-source commit-recording proposal. The subsequent explicit YES settles that separate question under D-070 below.

Reference: D-069, refining D-062, D-065, and D-067.

### 6.10 Per-source Git commit references

An Execution records the chosen Git commit reference associated with every selected source State, not only the default initialization source, and retains those source-State/commit pairings alongside its finalized result commit. The default source remains identified in execution context. These references describe what was assigned versus what was produced; they remain outside material State identity and do not make a State hash identify a unique Git commit. Logical per-source recording is settled; exact field encoding, commit-selection mechanics, and physical source-view materialization remain open.

For the merge example, retain S3a paired with C_A and S3b paired with C_B on the Execution, while C_result defines the resulting repository snapshot. A source may remain recorded even when some or all of its repository changes are intentionally omitted from the final tree.

The user also asked whether a source with a different commit should bring a repository copy alongside its artifacts. The agreed source views in D-067 provide the logical context for that proposal; Q22 does not yet mandate a separate clone, worktree, or duplicate file copy for each commit. Keep source-reference identity distinct from physical materialization and sharing.

Implementation notes retained at the user's request:

- “Copied over” means made available separately as source views, not automatically copied on top of the default repository. Reconciliation into the writable result remains the harness agents' responsibility (D-067/D-069).
- Different commit hashes can contain identical repository trees. Retain every selected source-State/commit reference (D-070), while optionally sharing identical read-only repository files rather than duplicating them. This is a materialization optimization, not provenance deduplication or a requirement to implement sharing now. Writable result edits must not mutate source snapshots.

The exact copying, checkout, and sharing mechanisms remain open. These implementation notes are also recorded in the owning workspace ticket, DEL-631.

Reference: Q22/D-070.

## 7. When a Playbook stops

The user explicitly corrected the framing: a Playbook is a **policy**, not a goal-based search system.

The accepted normal stopping rule is:

> A Task's Playbook progression normally stops when no eligible, unhandled Step applications remain and no Executions are queued or running. No separate goal-success check is required.

“Unhandled” matters. Matching input files alone do not mean fresh work exists: Task policy, existing claims, and handled bindings also matter. Material eligibility remains distinct from automatic claimability and scheduling capacity.

As clarified in Q21, this terminology does not establish a global “Step already handled these files” rule across different source States. Q31/D-078 settles that an already-handled input remains handled when inherited unchanged, even if surrounding material changes. Q32/D-079 keeps independent actual input changes distinct even when their resulting bytes match. Exact claim/provenance encoding and merge inheritance remain unresolved; evaluate eligibility against the selected State context and keep execution policy separate.

A no-op completion neither establishes policy exhaustion by itself nor makes the same binding fresh. The engine still evaluates whether other unhandled work remains. An occupied scheduler or a reached safety limit is not the same condition as policy exhaustion.

Q38 clarifies the existing policy, rather than selecting a new failure-isolation mode. If one of several Step Executions fails, the others continue under normal Task/resource controls. Accepted results trigger further Steps when their declared requirements, claims, and Task policy permit; otherwise those Steps do not start. Once no eligible unhandled automatic work and no queued/running Executions remain, Playbook progression is done under D-057 even if an Execution failed. Done does not mean every Execution succeeded. Keep the failed Execution visible for human attention; the user prefers a small failure/needs-attention indicator, with exact presentation left to the UI track. Explicit retry remains available under D-081 through D-083. Failure does not introduce a Task-wide pause, keep automatic progression alive without eligible work, or change the normal input requirements.

The following were not decided here:

- Whether exhausted Task Playbook progression is permanently closed or resumable.
- Exact status distinctions among waiting, blocked, failed, capped, and awaiting continuation.
- Explicit-retry workspace/Session context and claim mechanics, claim lifetime, and accounting policy.

Existing DEL-625/D-016 through D-020 context remains relevant: changed-input reruns have a Task-wide policy switch; new Playbook-driven Tasks default that switch off; first eligible applications remain automatic; and disabling reruns does not withdraw already-acquired claims. Q29/D-076 clarifies this Task ownership without changing the policy. The precise binding/claim identity that implements it across repeated States still needs reconciliation.

Reference: D-057; owning scheduler track DEL-628.

## 8. SQLite selected at Q40; implementation details remain open

The earlier recommendation was SQLite for logical authority with filesystem content-addressed blobs: write and sync blob bytes first, then commit references atomically. The user subsequently explicitly tabled the database choice until State contents were understood.

At Q40 on 2026-09-04, after discussing database alternatives, local deployment, Redis, Rust support, multi-repository ownership, WAL, and capacity, the user explicitly selected **SQLite for authoritative logical records**. This supersedes the earlier database deferral. The [SQLite discussion record](https://github.com/DeleganceAI/saga/blob/codex/playbook-execution-model/docs/architecture/playbook-execution-model/sqlite-storage-decision.md) preserves the rationale and guidance. The schema, Rust crate, partitioning, durability settings, and complete crash-publication protocol are not silently approved by that choice.

The intended distinction remains useful: an accepted logical result must not expose unfinished metadata/material. A crash means the process or machine stops between persistence steps, potentially leaving some writes durable and others absent. The exact mechanism for safe acceptance, orphan handling, and recovery remains to be specified using SQLite. Hashing blobs does not itself solve transaction or durability ordering.

Complete manifests and content-addressed bytes are agreed representation choices. The database is now SQLite; transaction protocol, fsync policy, crash repair, and retention remain unspecified.

Reference: D-008's historical deferral, D-061, and Q40/D-084's SQLite selection.

## 9. Question and amendment audit

Question labels below follow the discussion, including later amendments. They are not an implementation-ready specification. The corrected current answer wins over an earlier proposal or “yes.”

| Discussion item | Current position | Reference |
| --- | --- | --- |
| Q1 — manifest representation | Complete canonical material manifest per State; byte deduplication; additional manifest sharing only if measured | D-061 |
| Q2 — storage authority/database | Explicitly deferred after initial SQLite-plus-filesystem acceptance | D-008 |
| Q3 — identical material | Same captured material has the same State hash; no parent/Execution salt | D-060, D-064 |
| Q4 — accepted repository capture | Captured repository must match a finalized Git commit | D-062 |
| Q5 — artifact capture | Separate complete artifact manifest alongside the captured repository tree | D-060 |
| Q6 — exact inputs/provenance | Engine assigns binding before Sessions; Execution owns it once; no separate history-record vocabulary | D-056, D-059 |
| Q7 — accepted Transitions | Only accepted completion creates edges; unaccepted Executions can exist without them | D-058 |
| Q8 — same-byte publication provenance | Earlier proposal superseded by Q9; not an active requirement | D-063 |
| Q9 — unchanged material | No distinct same-byte republication; no agent publication list; accepted result may reuse a State | D-063, D-064 |
| Q10 — deletion | Allowed; omit the path; empty and absent differ; historical snapshots remain unchanged | D-063 |
| Q11 — commit references | Starting/finalized Git commits belong to Execution, not State hash; per-source recording subsequently settled by Q22, exact encoding open | D-062, D-070 |
| Q12 — starting snapshot | Record selected source before Sessions; generalized to complete source set | D-059 |
| Q13 — linear baseline | Approved State/Execution/Transition separation demonstrated by Frame | Sections 1–6.1 |
| Q14 — still-present downstream artifacts | Keep them unless actually changed/deleted; no automatic cleanup; presence is not freshness | D-063 |
| Q15 — merge relationships | One accepted Execution/result, one edge per selected source; an edge does not claim sole causation | D-058 |
| Q16 / stopping detour | Policy exhaustion settled; permanent closure versus resumability still open | D-057 |
| Q17 — merge responsibility | Harness agents own every multi-source merge, not merely file-conflict repair; workspace setup remains open | D-065 |
| Q18 — local workspace ownership, reframed | Unfinished Executions exclusively own allocated workspaces; safe sequential reuse is allowed; no permanent worktree per State | D-066 |
| Q19 — merge initialization and prompt layout | General default-source startup, writable result areas, and read-only original source views endorsed; actual layout communicated in generated context; deterministic selection subsequently settled by Q20; physical details remain open | D-067 |
| Q20 — default-source selection | Stable deterministic selection within the already-assigned source set, independent of completion timing or worktree availability; exact ordering implementation unspecified | D-068 |
| Q21 — State-based evaluation, reset after clarification | Evaluate relative to specific source State(s), retaining full material context and exact binding; execution policy remains separate. Initial Run-wide file-binding deduplication proposal withdrawn; exact claim/repeat scope not decided | D-011, D-014, D-016, D-056, D-059 |
| Q22 — per-source Git references and repository-result refinement | Record the chosen commit for every selected source State plus the finalized result commit. Default checkout is an operational convenience; instructions require reconciling all assigned repository sources, with one finalized commit tree defining the repository result. Exact encoding and physical source materialization remain open | D-069, D-070; D-062 |
| Q23 — repository finalization responsibility | Harness agents finalize the intended commit; the engine verifies and captures it. Uncommitted tracked changes prevent acceptance; no automatic engine commit/discard and no empty commit when unchanged. Q24/Q25 separately settle untracked/ignored files | D-071 |
| Q24 — untracked files and agent options | Remaining non-ignored untracked files block acceptance until addressed. Engine warning lists affected paths and agent options: commit, artifact, or scratch as appropriate; delete only known-safe disposable files and do not use ignore edits as a routine bypass | D-072 |
| Q25 — ignored files and simplicity | Use ordinary Git status/ignore behavior with untracked reporting enabled. Ignored untracked files do not block or enter the repository snapshot; no custom ignore analysis or committed-rules-only filter. Tracked `.gitignore` edits remain ordinary tracked changes | D-073 |
| Q26 — rejected completion and corrections | Check on each completion request regardless of Session-running status. Rejection is not Execution failure: keep the same Execution, sources, binding, claim, and workspace while the agent corrects and resubmits as often as needed, with no separate correction-attempt limit. No accepted result or Transitions until acceptance | D-074 |
| Q27 — agent-owned content selection, revised | Within assigned source States, the agent follows Step instructions to use, combine, or disregard competing content. No additional engine-enforced one-appraisal-per-request rule. Original choose-one proposal withdrawn; engine-owned formal source assignment/binding and still-open candidate/coverage rules remain distinct | Clarifies D-065 |
| Q28 — one Playbook per Task, premise corrected | A Task has one selected Playbook; another Playbook runs in a sub-task. Independent-Run framing rejected, not an approval of the proposed isolation rule or of cross-task source sharing. Task ownership subsequently settled by Q29 | D-075, D-076 |
| Q29 — Task-owned Playbook progression | Running a Playbook means the Task progressing through its selected Playbook. Task owns Step Executions/history, claims, rerun setting, and overall progress/control state; no separate Run identity. Existing policies remain unchanged and outside the material State hash | D-076 |
| Q30 — earlier States remain usable | An accepted successor does not by itself retire its source State from automatic consideration. Other eligible work may still start there even if not yet claimed/assigned, subject to binding, claims, and Task policy; no unconditional historical reruns | D-077 |
| Q31 — unchanged inherited input remains handled, revised | Engine-owned Execution/claim records preserve handled status through unchanged inheritance. Discover adding sources does not reactivate Frame; Design changing the agenda can, under Task rerun policy. No fresh automatic work solely from a new whole-State hash, no global byte-only request deduplication, and no mandatory done artifact or authored negative input. Original whole-State application-identity recommendation withdrawn | D-078; refines D-016/Q21 |
| Q32 — independent actual changes with identical resulting bytes | Independently legitimate branch Executions that each actually change an input introduce distinct claimable input histories, even when final path/bytes match. Potentially duplicated downstream work on convergence is explicitly acceptable, subject to existing Task rerun policy; content deduplication does not merge those histories | D-079 |
| Q33 — merged-file binding, parked | No answer recorded. The original Frame example was withdrawn; the replacement Review example's one-versus-two recommendations were not approved. Parked as an open consistency case for the general binding/claim model, not a new merge-specific execution-count rule. The correction anecdote remains below | D-016, D-059, D-078, D-079; no new decision ID |
| Q34 — terminal Execution failure and automatic retry | Retain the failed Execution for inspection and require explicit retry; no automatic relaunch of the same unchanged application merely because it failed. Ongoing completion corrections under D-074 remain unchanged. New retry identity is subsequently settled by Q35; starting context, claim representation, and failure classification remain open | D-081 |
| Q35 — explicit-retry identity | An explicit retry creates a new Step Execution linked to the terminally failed one. Keep the original failed attempt and record the retry's own outcome; no separate kind of retry record. Continuation/correction within ongoing work retains its Execution. Original source/binding subsequently settled by Q36; workspace/Session context and exact claim handling remain open | D-082 |
| Q36 — retry assignment | Retain the failed Execution's original source-State set and exact input binding, even if newer States exist. No silent reassignment to newer material. This does not settle failed-workspace/Session-context reuse or exact claim/commit-reference mechanics and introduces no exception to ordinary new-Execution initialization | D-083 |
| Q37 — retry conversation freshness, redundant | Withdrawn as an unnecessary confirmation of the fresh-Execution decision. Normal new-Execution startup applies; no new transcript-replay setting or mandatory failure-summary feature was requested. Not a pending user decision | Clarifies D-082; no new decision ID |
| Q38 — failure and ordinary progression, redundant framing | Other Executions continue; downstream Steps trigger when normally eligible; otherwise automatic progression is done once no eligible unhandled work or queued/running Executions remain. Done can include a failed Execution needing human attention, preferably shown with a small indicator. Not a new failure-isolation mode | Clarifies D-057 and D-081 through D-083; UI preference for DEL-632 |
| Q39 — unchanged output association, redundant framing | Withdrawn, not answered as a new decision. Accepted no-op behavior is already settled; precise request/result association remains part of the general provenance model | No new decision ID |
| Q40 — database choice | SQLite selected for local authoritative logical records. Preserve the alternatives and guidance in a Markdown note on PR #237; partitioning, Rust library, schema, tuning, and the full cross-store recovery protocol remain implementation work or open choices | D-084; synchronized after Q42 |
| Q41 — newer-descendant source-selection proposal and authoring detour | No source-selection rule approved. The user instead approved: “A good Playbook expresses its required dependencies. It does not rely on one agent happening to finish before another.” The authoring guide was published to PR #237; the engine's general source-selection/provenance mechanics remain open | D-085 authoring principle only |
| Q42 — restart after interruption and Session resumption | No automatic restart of terminated agent Sessions. Session resumption is deferred, including a manual Resume action; v1 does not implement it. Existing live-Session reattachment, ongoing completion correction, and terminal-failure retry remain distinct | D-086; final question |

Other clarifications retained above: an Execution can contain multiple Sessions; a repository tree hash differs from a commit hash; graph cycles are allowed; exact assigned inputs are not inferred from diffs; binding does not restrict visibility; and the second Frame's no-op compares its immediate source/result, not an earlier Design source.

### Q33 anecdote: a missing eligible Execution is not a design premise

The original merge example left Frame on branch B's changed agenda unclaimed, although Frame's only declared input was present and changed-input reruns were enabled. The user asked why Frame would not run after SB. No reason had been established: B's independent input should make Frame eligible for its own claim/Execution there. Scheduler capacity cannot explain an absent claim because claims precede capacity. An already-assigned Execution retains its recorded source States and binding; it cannot silently switch from SB to a later merged State.

Claimed, queued, running, and completed are different. An independently eligible merge might finish while Frame is still running, whereas a merge requiring Frame's accepted result must wait for that result. The example had not declared the merge's prerequisites. This correction does not introduce a global wait-for-all-Steps barrier or a new evaluator/dispatch ordering guarantee.

The example and its timing premise were withdrawn, not recorded as an answer to Q33. Retaining both accepted histories is already required; which introduction references a downstream binding through a merged file represents remains open. The user requested this anecdote be retained. No new shared decision ID or scheduling policy is adopted.

Lesson for later examples: enumerate eligible applications and existing claims, and state the merge's actual input requirements. Do not manufacture a design choice by omitting eligible work. To isolate post-merge binding behavior, use a Step whose required inputs first become jointly available in the merge result.

The subsequent Review example and the opposing one-versus-two application recommendations were not approved. Q33 is parked as an open consistency case to revisit with the general binding/claim model; no merge-specific execution-count rule has been adopted.

### Superseded or unadopted proposals

| Earlier idea | Current disposition |
| --- | --- |
| Hash parents and producing action into State identity | Superseded: hash captured material only |
| Wrap repeated material in separate “history records” | Not adopted: use States, Transitions, and Executions |
| Guarantee the material State graph is a DAG | Rejected: cycles, revisits, and self-loops are allowed |
| Treat same bytes as a new artifact republication event | Superseded by Q9/D-063 |
| Ask the agent for a per-Execution publication-path list | Not required; capture actual final material |
| Use origin State hash plus path as settled publication identity | Old D-015 superseded; precise provenance addressing remains open |
| Require a 1:1 Execution-to-Transition relationship | Not adopted: merges have one edge per source, sharing one Execution |
| Delegate merging to agents only when file conflicts arise | Broadened by Q17: agents are responsible for every multi-source merge |
| Allocate a permanent worktree for each State | Not adopted: workspaces belong to unfinished Executions and may be reused sequentially after release |
| Start the merge workspace from a shared earlier State | Not chosen: start from one assigned source as the default; agents may still consult history while merging |
| Suppress a Step across the entire Run solely because the same bound files were used elsewhere | Q21 proposal withdrawn; State-based eligibility reaffirmed, exact execution-policy scope still open |
| Add an engine rule choosing one appraisal and excluding another within assigned sources | Q27 proposal withdrawn; content selection belongs to the agent following Step instructions, not an additional engine-enforced rule |
| Assume independently launched Playbook Runs as the premise for Q28 | User corrected the model to one Playbook per Task, with another Playbook in a sub-task; the proposed cross-Run isolation answer was not adopted |
| Introduce a separate Run identity between Task and Step Execution | Rejected by Q29/D-076: Task owns Playbook progression and its control state |
| Retire a source State from automatic consideration merely because it has a successor | Rejected by Q30/D-077; other eligible work can still start there subject to claims and Task policy |
| Treat a different whole-State hash as a fresh application despite unchanged inherited handled inputs | Original Q31 recommendation withdrawn; D-078 preserves handled status in engine-owned Execution/claim records |
| Automatically delete/invalidate old downstream files after input changes | Not adopted; still-present material remains captured |
| Treat deletion as an empty file | Corrected: absence means no manifest entry |
| Choose SQLite before settling State contents | Initially deferred; SQLite subsequently selected at Q40 |
| Define stopping through goal success or search | Replaced with policy exhaustion |
| Decide exhaustion permanently closes or resumes Task Playbook progression | Still open |

## 10. Remaining decision frontier

### Engineering handoff after Q42

The user ended this question session after Q42. Q37 and ordinary sibling progression after failure are not pending user choices; Q42 defers Session resumption rather than adding a Resume action now. Q41's source-selection preference remains unapproved. The detailed items below are an engineering checklist, not a queue of further questions or silently approved defaults. Distinguish three substantive areas:

1. Make the general source-selection, binding/claim representation, and finite request/result association precise enough to implement the agreed behavior. Q33's special identical-byte convergence puzzle remains a deferred consistency case, not a proposed special-purpose mechanism.
2. Specify reliable publication using the SQLite authority selected at Q40: concrete schema/ownership, canonical State representation, and crash-consistent recording of material and Execution/Transition metadata remain to be designed.
3. Specify completion/recovery mechanics and acceptance tests: authenticated completion, writer fencing, stale/duplicate events, persisted-record reconciliation, and interruption classification. Session resumption is deferred under D-086; do not make it a v1 delivery dependency. Existing accepted behavior still requires a concrete, verified implementation.

The final consolidated design, consistency pass, DEL-629 acceptance criteria, and delivery split remain to be completed. Directory names, field spellings, fresh-Execution implications, and incidental edge cases should not each become new grilling rounds. Retention/export/purge and broader archival/manual-wakeup details remain recorded scope boundaries; they are not demonstrated immediate blockers to the core model.

### Detailed engineering checklist

These unresolved details must not be silently answered by the examples or by the choice of terminology:

1. **Merge setup and acceptance:** Exact formal source-State selection, physical path layout, reference-view implementation/access enforcement, available merge tools, and precise acceptance checks. Q30/D-077 settles that a successor alone does not retire its source State from automatic consideration, including for applications not yet claimed/assigned; remaining candidate-selection rules stay open. General default-source startup and prompt communication are settled by Q19/D-067; stable deterministic default selection within that assigned set is settled by Q20/D-068, with its exact ordering implementation unspecified. The harness agents' responsibility for every multi-source merge, including conflict resolution, remains settled by Q17/D-065; do not reopen it as an engine-owned content-resolution policy.
2. **Provenance and binding identity:** How exact inputs/occurrences are addressed when a material State hash may recur through different Executions, including initial inputs and provenance retained by a merged file. Q31/D-078 settles that handled status survives unchanged input inheritance despite a changed surrounding State; do not use a new full-State hash alone as freshness or reopen this settled behavior. Q32/D-079 settles that independent actual input changes remain distinct even with matching resulting bytes, and accepts potentially duplicated downstream work. Exact claim/provenance encoding and merge inheritance/association remain open, not these settled distinctions or the existing changed-input recurrence/reversion policy.
3. **Finite sets and results:** How to reconstruct the exact request set and associate accepted results with requests, including candidate result-State selection, without a hidden mutable completeness authority or an agent publication list. The source contract's complete-set requirements remain settled. Q27 clarifies that choosing which content to use, combine, or disregard within the assigned sources is the agent's job; do not turn this frontier into an engine-enforced one-appraisal-per-request content rule.
4. **Execution and Task lifecycle:** Task ownership of Playbook progression is settled by Q29/D-076; there is no separate Run identity. Q34/D-081 requires explicit rather than automatic retry after terminal Execution failure; Q35/D-082 creates a new linked Execution, and Q36/D-083 preserves the original source States and exact binding for that retry. Q37's freshness question is redundant, and Q38 applies ordinary eligibility/stopping after failure with a visible needs-attention indicator; neither is pending approval. Specify failure classification, abandonment, normal retry Session-startup/workspace and claim mechanics, exact Session continuation mechanics, duplicate completion, broader claim lifetime, and archival/manual-wakeup behavior as needed. Correction after rejected completion retains the same Execution and claim without a separate correction-attempt limit (Q26/D-074); that is no longer open. Also resolve local workspace allocation timing, writer fencing, release/reuse enforcement, and cleanup under D-066. Retain the already-settled accepted-edge, policy-exhaustion, and exclusive-workspace-ownership boundaries.
5. **Exact capture and identity encoding:** Canonical State serialization/hash algorithm, remaining capture exclusions/Git edge cases such as submodules and LFS, exact per-source commit-reference encoding/selection mechanics under D-070, and retained object availability. Logical recording of every selected source's commit reference is settled. Agent-owned finalization, engine verification, and rejection of uncommitted tracked changes are settled by Q23/D-071. Q24/D-072 settles warnings, agent guidance, and blocking acceptance for remaining non-ignored untracked files; Q25/D-073 settles ignored files using ordinary Git behavior without custom ignore analysis. Exact validation mechanics remain open.
6. **Persistence:** SQLite authority is selected under D-084. Concrete schema/ownership, atomic acceptance/crash recovery, indexing, retention, export, accounting, and historical purge remain engineering work. Logical manifest completeness is already settled; the complete physical storage/publication protocol is not.

The next source-selection questions concern which candidate States and result versions the engine considers for an application, not which assigned source initializes the workspace. The three-record boundary, Q15's edge meaning, Q17's agent merge responsibility, Q18's local workspace ownership, Q19's general layout/prompt contract, and Q20's deterministic default-selection rule do not need to be re-asked just because implementation details remain open.

After Q21's clarification, the immediate discussion returns to the still-open multi-source Git-reference capture, keeping the unresolved repeat-execution policy separate.

The Q22 detour settled the repository reconciliation instruction and single-final-snapshot boundary under D-069. A subsequent explicit YES settled per-source commit recording under D-070. Source-reference records and physical source-view materialization remain distinct; the latter is now being discussed.

Q23 settles commit-finalization responsibility. Q24's explicit follow-up settles the blocking acceptance rule for non-ignored untracked files alongside warnings and agent guidance. Q25 settles ignored files through ordinary Git behavior; do not reopen this as a custom ignore-analysis design. Q26 settles correction after rejected completion: the agent keeps working in the same Execution and may correct and resubmit as often as needed. This does not impose a Session-running prerequisite or settle exact completion ordering. Q27 returns to the merge boundary: the agent chooses how to use assigned content, while candidate source-State selection remains an engine question. Q28 corrects the surrounding product model to one Playbook per Task, with another Playbook in a sub-task. Q29 settles the Task as owner of Playbook progression, without a separate Run identity. Q30 settles that a successor alone does not retire its source from automatic consideration. Q31 settles unchanged inherited input status in Execution/claim records; actual input changes can supply recurrence triggers under Task policy. Q32 keeps independent actual changes distinct even when resulting bytes match, accepting potentially duplicated work. Remaining candidate selection, merge inheritance/association, and exact claim/provenance keys stay open.

## 11. Linear synchronization and PR handoff

Final question-session synchronization on 2026-09-05: D-084 records Q40's SQLite selection, D-085 records the approved dependency-first authoring principle, and D-086 records Q42's deferral of Session resumption. DEL-624, DEL-629, DEL-626, DEL-628, DEL-632, and DEL-631 were updated and read back; all six descriptions matched the intended patches and checked unrelated metadata was unchanged. Q39 remains withdrawn and Q41's newer-descendant preference remains unapproved. SQLite and the authoring guide were previously published to PR #237 in commits `b322bc9b7a4202cba86196f28b16c145990e4ec9` and `c9278db604f8880784db35ee3921e9c7538c307e`; no further PR change, commit, push, or runtime implementation was performed in this final synchronization. At that synchronization, the full local ledger and compact draft were not yet published; this documentation handoff is subsequent. Remaining source/provenance, schema/publication, interruption-classification, and verification work is explicitly incomplete; no further grill questions were asked.

The following eight issues were updated and read back on 2026-09-04. Their saved descriptions were verified against the intended patches, allowing only Linear's automatic link formatting. Status, assignment, parent, project, cycle, labels, priority, due date, attachments, and team were checked as unchanged. Only DEL-632's title was intentionally renamed.

| Issue | Synchronized content |
| --- | --- |
| [DEL-624](https://linear.app/delegance/issue/DEL-624) | Shared D-059 through D-064 added; D-008 deferred; D-015 superseded; affected earlier decisions reconciled; D-056 binding ownership corrected; D-057/D-058 retained |
| [DEL-629](https://linear.app/delegance/issue/DEL-629) | Full current State/Execution/Transition contract, examples, superseded proposals, and remaining frontier |
| [DEL-625](https://linear.app/delegance/issue/DEL-625) | Runtime material/provenance/publication references reconciled without reopening source grammar or parser/discovery delivery split |
| [DEL-626](https://linear.app/delegance/issue/DEL-626) | Execution-owned binding/source/Git context, Session prompt rules, accepted no-ops, and completion reconciliation |
| [DEL-627](https://linear.app/delegance/issue/DEL-627) | Artifact-pattern grounding, source selection, cyclic/reused State results, and provenance/claim frontier |
| [DEL-628](https://linear.app/delegance/issue/DEL-628) | Accepted-result handling when no new State hash is created; D-057 policy exhaustion retained |
| [DEL-631](https://linear.app/delegance/issue/DEL-631) | Complete manifests, committed repository capture, one accepted result/multiple edges, deletion, and no-op materialization constraints |
| [DEL-632](https://linear.app/delegance/issue/DEL-632) | “DAG” changed to “State graph” in title and affected UI scope; repeated States, merge edge grouping, and lifecycle caveats |

Q17 follow-up on 2026-09-04: D-065 was added to DEL-624 and synchronized with DEL-629, DEL-631, and DEL-626. Merge responsibility is settled for all multi-source Executions; initial workspace/source-access details remain open. The affected descriptions were read back and checked, with unrelated metadata preserved.

Q18 follow-up on 2026-09-04: D-066 was added to DEL-624 and synchronized with DEL-629, DEL-631, DEL-626, and DEL-628. The local model uses exclusive Execution ownership, separate writable workspaces for concurrent work, and safe sequential reuse rather than a permanent worktree per State. The affected descriptions were read back and checked, with unrelated metadata preserved. No worktree, branch, or implementation changes were made.

Q19 clarification, before the layout agreement: D-065 in DEL-624 and DEL-629 was clarified to distinguish engine-assigned formal merge inputs from harness-controlled merge implementation, preserving D-056's non-restrictive binding semantics. That clarification was read back and verified; it did not itself select a startup policy.

Q19 layout agreement: D-067 was added to DEL-624 and synchronized with DEL-629, DEL-631, and DEL-626. The general default-source startup, writable-result/read-only-source roles, and actual-layout prompt communication are recorded, while exact paths and default-source selection remain open. The affected descriptions were read back and checked, with unrelated metadata preserved. No filesystem workspace, branch, implementation, or PR changes were performed.

Q20 follow-up on 2026-09-04: D-068 was added to DEL-624 and synchronized with DEL-629, DEL-631, and DEL-626. Default initialization is chosen by a stable deterministic rule within the already-assigned source set, independently of completion timing and workspace availability. Exact ordering implementation and formal source-set selection remain unspecified. The affected descriptions were read back and checked, with unrelated metadata preserved. No worktree, branch, implementation, or PR changes were performed.

Q21 clarification on 2026-09-04: DEL-624, DEL-629, DEL-627, and DEL-628 were synchronized to reaffirm State-based evaluation and distinguish it from the still-open scope of repeat/duplicate execution policy. The initial Run-wide suppression proposal was explicitly withdrawn. No replacement claim key, new shared decision ID, or changed Run-policy rule was introduced. Saved descriptions and unrelated metadata were read back and verified. No implementation or PR publication was performed.

Q22 refinement on 2026-09-04: D-069 was added to DEL-624 and synchronized with DEL-629, DEL-631, and DEL-626. Instructions must distinguish the default checkout from the full assigned source set, require agent-led repository reconciliation, and identify one finalized commit tree as the repository result. Omission from that result is not historical deletion; artifacts remain separately captured. The original per-source commit-recording question remains open. Descriptions and unrelated metadata were read back and verified. No implementation, repository/worktree mutation, or PR publication was performed.

Q22 approval follow-up on 2026-09-04: the user's explicit YES settled per-source commit recording as D-070 in DEL-624, DEL-629, DEL-631, and DEL-626. Earlier current-status references to that question being unanswered were reconciled; the chronological D-069 audit above records its status at that earlier point. Saved descriptions and unrelated metadata were read back and verified. Physical copying/sharing of repository source views remains a separate discussion. No repository/worktree, implementation, or PR changes were performed.

Q23 follow-up on 2026-09-04: D-071 was added to DEL-624 and synchronized with DEL-629, DEL-631, and DEL-626. Harness agents finalize the repository result; the engine verifies and captures it without silently committing or discarding unfinished repository changes. Uncommitted tracked changes prevent acceptance, while an unchanged repository needs no empty commit. Untracked/ignored-file policy and exact validation/continuation mechanics remain open. Saved descriptions and unrelated metadata were read back and verified. No implementation, repository/worktree, or PR changes were performed.

Q24 partial decision on 2026-09-04: D-072 was added to DEL-624 and synchronized with DEL-629, DEL-631, and DEL-626. Engine warnings and agent guidance for uncommitted repository files are recorded, with commit/artifact/scratch options, safe handling of disposable versus uncertain files, and no routine ignore-rule bypass. The warning's acceptance effect for non-ignored untracked files remains pending clarification; D-071's tracked-change rule is unchanged. Saved descriptions and unrelated metadata were read back and verified. No implementation, repository/worktree, or PR changes were performed.

Q24 acceptance clarification on 2026-09-04: the user's explicit YES settled that remaining non-ignored untracked files block completion until addressed. D-072 and related current-status wording were updated in DEL-624, DEL-629, DEL-631, and DEL-626, preserving warning guidance and D-071's tracked-change rule. The earlier partial-decision entry above records its historical status. Descriptions and unrelated metadata were read back and verified. Ignored-file policy remains open; no implementation, repository/worktree, or PR changes were performed.

Q25 follow-up on 2026-09-04: D-073 was added to DEL-624 and synchronized with DEL-629, DEL-631, and DEL-626. Ignored untracked files do not block completion; use ordinary Git status/ignore behavior, not custom matching, ignored-content audits, ignore-history comparisons, or committed-only ignore analysis. D-071/D-072 retain their tracked/non-ignored-file gates. Saved descriptions and unrelated metadata were read back and verified. No implementation, repository/worktree, or PR changes were performed.

Q26 follow-up on 2026-09-04: D-074 was added to DEL-624 and synchronized with DEL-629, DEL-631, DEL-626, and DEL-628. Every completion request triggers the agreed check without a Session-running prerequisite. Rejection is not Execution failure: the agent retains its Execution, sources, binding, claim, and workspace and may correct and resubmit without a separate correction-attempt limit. No accepted result or Transitions are published by rejection. Independently applicable Run/resource limits remain unchanged; exact ordering and transport remain implementation details. Saved descriptions and unrelated metadata were read back and verified. No implementation, repository/worktree, or PR changes were performed.

Q27 clarification on 2026-09-04: the user's explicit YES reaffirmed agent-owned content selection under D-065. DEL-624, DEL-629, DEL-631, DEL-626, and DEL-627 were synchronized: within assigned source States, agents follow Step instructions to use, combine, or disregard competing content, without an extra engine-enforced one-appraisal-per-request rule. The original choose-one proposal was withdrawn, not adopted; formal source assignment, binding, and capture remain engine-owned. No new shared decision ID was needed. Saved descriptions and unrelated metadata were read back and verified. No implementation, repository/worktree, or PR changes were performed.

Q28 correction on 2026-09-04: D-075 records the user's one-Playbook-per-Task model and use of a sub-task for another Playbook. DEL-624, DEL-625, DEL-629, DEL-627, and DEL-628 were synchronized. The original independent-Run premise was rejected; its proposed source-isolation rule was not approved, and no opposite cross-task sharing rule was inferred. Existing Run terminology is not silently converted into or removed from the logical model; its ownership remains a separate question. Saved descriptions and unrelated metadata were read back and verified. No implementation, repository/worktree, or PR changes were performed.

Q29 follow-up on 2026-09-04: D-076 records that running a Playbook means the Task progressing through its selected Playbook, with no separate Run identity. DEL-624, DEL-625, DEL-629, DEL-626, DEL-627, DEL-628, DEL-631, and DEL-632 were synchronized. Current Run-control/policy references were reconciled with Task ownership, including pinned evaluation, rerun defaults, stopping, and status read models; historical withdrawn proposals remain identified. Saved descriptions and unrelated metadata were read back and verified. This changes logical ownership/terminology, not the established policies, unresolved lifecycle details, database choice, or parser/discovery delivery scope. No implementation, repository/worktree, or PR changes were performed.

Q30 follow-up on 2026-09-04: D-077 was added to DEL-624 and synchronized with DEL-629, DEL-627, and DEL-628. Producing a successor does not automatically retire the source State from consideration, even for other applications not yet claimed or assigned. Existing binding, claims, and Task policy still govern whether work starts; this is not unconditional historical rerunning or a complete candidate-selection algorithm. Saved descriptions and unrelated metadata were read back and verified. No implementation, repository/worktree, or PR changes were performed.

Q31 follow-up on 2026-09-04: D-078 was added to DEL-624 and synchronized with DEL-625, DEL-629, DEL-627, and DEL-628. The user confirmed that claims handle repeated-work suppression: an unchanged inherited agenda remains handled despite changes elsewhere, and Frame becomes fresh again when its agenda actually changes, subject to Task policy. The original whole-State application-identity recommendation was withdrawn. Q21/current-frontier references were reconciled while preserving open independent-branch identity questions. No authored negative input, mandatory done artifact, new material-State field, or byte-only global request deduplication was adopted. Saved descriptions and unrelated metadata were read back and verified. No implementation, repository/worktree, or PR changes were performed.

Q32 follow-up on 2026-09-04: D-079 was added to DEL-624 and synchronized with DEL-625, DEL-629, DEL-627, and DEL-628. Independently legitimate branch Executions that each actually change an input retain distinct input histories even when final path/bytes match; the user explicitly accepts potentially duplicated downstream work when branches converge. Existing Task rerun policy and the unchanged-inheritance/no-republication rules remain intact. Current open-question references were narrowed to exact claim/provenance encoding and merge inheritance/association. A temporary Linear failure for DEL-627 was checked before retrying; all five saved descriptions and unrelated metadata were ultimately read back and verified. No implementation, repository/worktree, or PR changes were performed.

Q33 anecdote follow-up on 2026-09-04: at the user's request, the withdrawn Frame/merge timing example and the lesson about enumerating eligible applications were recorded in DEL-624, DEL-629, and this Markdown ledger. This is explanatory history, not approval or rejection of the pending merged-file binding rule, and not a new scheduling policy or shared decision ID. Both saved descriptions were read back against the intended insertions. Other checked metadata was unchanged except that DEL-629 acquired a related DEL-641 entry during the operation; that unrelated relation was not part of our description-only edit and was left intact. No implementation, repository/worktree, or PR changes were performed.

Q34 follow-up on 2026-09-04: D-081 was added to DEL-624 and synchronized with DEL-629, DEL-627, DEL-628, DEL-626, and DEL-632. Terminally failed work requires explicit retry rather than automatic relaunch; the failed Execution remains inspectable, and D-074's ongoing completion-correction behavior is unchanged. Explicit-retry identity/mechanics and failure classification remain open. The live epic already assigned D-080 to the separately approved Workflow hard cutover; that decision was preserved. The local ledger and DEL-624/DEL-629 also identify Q33 as parked and unanswered, with neither proposed one-versus-two merge rule adopted. All six saved descriptions were read back against their intended patches and unrelated metadata was unchanged. No implementation, repository/worktree, or PR changes were performed.

Q35 follow-up on 2026-09-04: D-082 was added to DEL-624 and synchronized with DEL-629, DEL-627, DEL-628, DEL-626, and DEL-632. Explicit retry creates a new Step Execution linked to the terminally failed one, preserving the original failed attempt; no separate kind of retry record is introduced. D-081 and current frontiers were reconciled so retry identity is no longer presented as undecided. Original-versus-new source assignment, failed-workspace/Session-context reuse, and exact claim/link encoding remain open. Ongoing continuation and completion correction still retain their existing Execution. All six saved descriptions were read back against their intended patches and unrelated metadata was unchanged. No implementation, repository/worktree, or PR changes were performed.

Q36 follow-up on 2026-09-04: D-083 was added to DEL-624 and synchronized with DEL-629, DEL-627, DEL-628, DEL-626, DEL-632, and DEL-631. The new retry Execution preserves the failed Execution's original source States and exact assigned binding instead of silently selecting newer material. Earlier current-status statements leaving that assignment choice open were reconciled. Failed-workspace/Session-context reuse and exact claim/commit-reference mechanics remain separate; no exception to ordinary assigned-material initialization or new failed-file retention system was adopted. All seven saved descriptions were read back against their intended patches and unrelated metadata was unchanged. No implementation, repository/worktree, or PR changes were performed.

Q37/Q38 clarification follow-up on 2026-09-04: DEL-624, DEL-629, DEL-627, DEL-628, DEL-626, DEL-632, and this ledger were synchronized after the user rejected redundant confirmations. Fresh Execution startup is not a separate pending transcript-policy decision. Normal eligibility governs continuation and stopping after one Execution fails; progression can be done while the failed Execution remains visible as needing human attention. The preferred small indicator is recorded for the UI track. This clarifies D-057/D-081 through D-083 rather than creating a new failure-isolation policy or decision ID. A remaining-work triage separates substantive design work from implementation defaults/checks and deferred corner cases. All six saved descriptions were read back against their intended patches and unrelated metadata was unchanged. No implementation, repository/worktree, or PR changes were performed.

This question session is finished; other runtime-track design work remains. This synchronization is not implementation approval, a final whole-system consistency audit, or a redesign of unrelated human-approval behavior. Parser/discovery child-ticket scope remains unchanged.

This Markdown file and the [compact design draft](playbook-engine-design-draft.md) form the documentation-only handoff of the completed question session to PR #237. Open engineering work remains explicitly unresolved. No PR branch was modified and no Git commit or push was performed in the Q37/Q38 synchronization described above.

Q40 publication follow-up on 2026-09-04: the user selected SQLite and expressly requested a Markdown record of the recent database discussion on PR #237. The dedicated [SQLite storage decision note](https://github.com/DeleganceAI/saga/blob/b322bc9b7a4202cba86196f28b16c145990e4ec9/docs/architecture/playbook-execution-model/sqlite-storage-decision.md) and its docs index link were committed and pushed as `b322bc9b7a4202cba86196f28b16c145990e4ec9` on `codex/playbook-execution-model`. PR head and remote document blob were read back and matched locally. Document structure, table shape, index link, arithmetic, and staged whitespace checks passed. `./scripts/check.sh` could not proceed because this worktree lacks `alinery-app/node_modules`; no dependencies were installed. Unrelated paper edits and generated files were left untouched. The full ledger and compact draft remained local at that point; that publication did not update Linear, allocate a shared decision ID, implement SQLite, or establish performance/recovery capacity. Q39's redundant framing is recorded as withdrawn, and Q40 settles database selection without silently locking the remaining implementation recommendations.
