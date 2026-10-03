# Playbook scheduler, limits, and recovery decision record

> Planning snapshot captured on 2026-09-05 from the paused [DEL-628](https://linear.app/delegance/issue/DEL-628/implement-the-playbook-scheduler-limits-and-recovery) grill for [PR #237](https://github.com/DeleganceAI/saga/pull/237).
>
> Q1 through Q37 are settled below. The session paused before Q38 was answered. This record describes planned v1 behavior; it does not claim that the scheduler has been implemented or validated.

## Vocabulary and scope

- There is no separate Run entity.
- Every Task executes exactly one Playbook.
- Starting a Task requires choosing its Playbook. There is no later "attach Playbook" operation.
- If another Playbook must execute, create another Task or sub-task.
- The Task owns its Playbook progression, Step Executions, claims, Sessions, budgets, and history.
- A Step Execution may contain multiple sequential Sessions. Sessions are cheap and disposable.
- A Step Execution succeeds only when its current agent successfully calls the engine-provided `complete` tool and the engine durably accepts the completion.
- An accepted Execution has one result State and one Transition per selected source State. Its result may be a new State, an already-existing State, or the same State as a source.

## Scheduler authority and lane topology

- Production scheduler authority is per repository, not global to the app.
- One production Alinery installation may serve multiple repositories, but each repository has one production `alineryd` lane and one evaluator.
- The daemon's held repository lock is its scheduling authority for the process lifetime.
- Takeover fails closed: a replacement daemon must not schedule until the prior daemon has released the repository lock.
- V1 has no durable scheduler generation, generation-matching mutations, or cross-generation fencing.
- A separate recovery process may be added later if it becomes necessary; it is not part of v1.

## Evaluation model

- The Playbook evaluator is a long-lived component inside `alineryd`.
- On startup, it performs one full repository reconciliation.
- After startup, evaluation is event-driven rather than periodically polled.
- Relevant durable mutations, such as Task start, accepted completion, and budget or policy changes, trigger immediate evaluation.
- Wakeups are only hints that something changed. They may be duplicated, coalesced, reordered, or lost.
- The evaluator always rereads durable state and derives work from that state; event payloads are never scheduling authority.
- Between relevant mutations, the evaluator is idle and consumes no polling CPU.
- V1 starts every eligible, unclaimed, budget-allowed Step application.
- V1 has no repository-wide concurrency cap, capacity queue, fairness policy, priority, preemption, or execution-slot reservations.

## Task start and Playbook identity

A successful Task start atomically:

1. chooses and validates the Task's single Playbook;
2. stores the exact pinned Playbook snapshot or equivalent exact identity;
3. resolves the Task's effective budgets;
4. records `task_started_at`; and
5. triggers evaluator re-evaluation.

If the durable start operation fails, the Task did not start.

Later edits to the authored Playbook do not silently change the pinned Playbook or its pinned defaults for an already-started Task.

## Playbook budget defaults

A Playbook may suggest any non-empty subset of these optional defaults:

```yaml
playbook:
  budget_defaults:
    max_step_executions: 12
    max_wall_clock_seconds: 7200
    max_tokens: 500000
```

Each supplied value is a positive integer. These are author suggestions, like suggested harnesses or models, rather than hard ceilings. They travel with the exact Playbook someone shares.

For each budget dimension:

```text
effective Task budget =
  explicit Task override
  else pinned Playbook default
  else unlimited
```

Before starting a Task, the user can inspect the effective values and override any of them. A fully unlimited Task requires no extra warning or confirmation in v1.

All v1 budgets are per Task. All dimensions are independently optional.

## Budget enforcement

Budgets prevent new Step Executions from starting. They do not terminate or constrain work that is already executing.

The evaluator checks budgets before creating a claim or Execution. If a threshold is already reached, it creates neither.

There are no reservations. Concurrent Executions already in progress may complete after a threshold is reached, so final usage may exceed the configured maximum.

A budget-blocked application remains eligible and unhandled. V1 creates no parked claim, execution slot, or special capped queue for it.

Task budgets may be changed at any time. Every change triggers re-evaluation:

- raising or removing a limit may allow work to start immediately;
- lowering a limit affects only future Step Execution starts; and
- already-running work is not canceled.

A Task is reported as `capped` only when a budget is actively blocking an otherwise-startable Step Execution. Reaching a threshold while no eligible unhandled work exists leaves the Task quiescent instead.

### Maximum successful Step Executions

`max_step_executions` counts accepted, successfully finalized Step Executions, not attempts or Session starts.

The count increases by exactly one after a successful `complete` call durably finalizes the result State and all Transitions.

- A multi-source Execution counts once even though it creates multiple Transitions.
- Reusing an existing State or accepting a self-loop still counts once.
- Rejected completion, failure, cancellation, abandonment, interruption, or Session exit without accepted completion counts zero.

After a successful completion increments the count, the evaluator checks `count >= max_step_executions` before starting more Executions.

### Maximum wall-clock duration

Wall-clock usage is:

```text
current time - task_started_at
```

Time runs continuously. V1 has no pause accounting, accumulated active-time clock, or restart adjustment.

### Maximum aggregate tokens

Token usage is the current aggregate across every Session belonging to the Task, including Sessions used for:

- successful work;
- failed or canceled work;
- retries;
- completion corrections;
- continuations; and
- auxiliary work.

Where Session token usage comes from is out of scope. DEL-628 assumes that Alinery can obtain tokens used so far for each Session and therefore for the Task.

The scheduler compares current aggregate usage with `max_tokens`; it does not predict future usage or reserve tokens.

Provider quotas, provider rate limits, monetary-cost conversion, pricing, forecasts, and token reservations are out of scope.

### Continuation and budgets

All three budget dimensions block only new Step Executions.

An operator may explicitly continue an existing Execution even after its Task has crossed its Step-execution, wall-clock, or token threshold. Continued Sessions may increase measured time and token usage, while automatic creation of new Executions remains blocked.

## Claims, failures, retries, and cancellation

Once automatic work has a claim, a failed, canceled, abandoned, interrupted, or continuable outcome retains that claim. The scheduler must not automatically loop on the same unchanged application.

A terminally failed Execution remains immutable and inspectable.

Retry is explicit operator action through the app or MCP. It is never initiated by the scheduler, model, or a timer.

An explicit retry:

- creates a new Execution linked to the prior one;
- retains the same logical claim;
- preserves the original authoritative source-State set and exact input binding; and
- rematerializes a fresh workspace from those original sources.

A retry does not reopen the failed Execution, silently select newer States, or inherit unaccepted partial workspace edits.

### Execution cancellation

Explicitly canceling one Execution:

- terminates its Sessions;
- marks the Execution canceled;
- retains its claim;
- consumes no successful-Execution budget; and
- does not stop independent Task branches.

Retry remains explicit.

### Task cancellation

Explicit Task cancellation is a terminal emergency stop:

- prevent every future Step Execution for that Task;
- cancel every active Execution and Session belonging to it; and
- preserve history and unfinished evidence.

V1 has no Task pause or reopen operation.

## Completion and crash consistency

Accepted completion is one all-or-nothing durable commit point for:

- the result State; and
- every Transition from the Execution's selected source States to that result.

If a crash occurs before that commit finishes, there is no accepted result or accepted Transition, and the Execution is interrupted. It consumes no successful-Execution budget.

If the commit finished, the Execution remains completed and counts once even if the reply was lost.

A later Session process exit, including a nonzero exit, does not undo a durably accepted completion. The process exit remains diagnostic Session history only.

Automatic claim creation and initial Execution creation are also one durable atomic action. The system must not leave a claim with no corresponding Execution. A crash after that action commits but before its first Session launches leaves an interrupted Execution.

On startup or takeover, when the new authority finds an unfinished Execution with no live Session and no accepted completion, it marks that Execution interrupted, retains its claim, and does not retry automatically.

## Session exit and explicit continuation

During normal observation, a Session exit without accepted `complete` leaves its Execution `continuable`, not failed.

A continuable Execution retains its:

- claim;
- selected source States;
- exact input binding; and
- workspace.

It blocks only the same claimed application. Independent eligible branches continue. If no other work can proceed, the Task reports `awaiting-continuation`, not quiescent.

Continuation is explicit operator action; the scheduler never continues automatically.

Each explicit continuation creates a fresh sequential Session in the same Execution and workspace. It receives:

- the unchanged authored Step instructions;
- current engine-generated Execution context; and
- references to prior Session history.

Playbook continuation does not restore the previous harness conversation. Existing provider-specific Session Resume behavior remains a separate feature.

## Quiescence

Quiescence is a resumable observation, not terminal Task completion.

A quiescent Task remains active. A later relevant State, policy, or budget mutation may make new work eligible and trigger evaluation.

## Hard-cutover constraint

The Playbook engine replaces the legacy Workflow scheduler directly.

DEL-628 does not need:

- a dual scheduler;
- Workflow-to-Playbook migration;
- a compatibility reader;
- a feature flag;
- a legacy rollback path; or
- legacy scheduler recovery semantics.

## Explicit v1 non-goals

- automatic retry or automatic Session continuation;
- a separate recovery worker;
- repository-wide execution capacity, queueing, fairness, or priority;
- execution-slot or budget reservations;
- durable scheduler generations;
- provider quota or price accounting;
- predicting future token usage;
- pause/resume accounting for wall-clock budgets;
- carrying unaccepted edits into retries;
- Task pause or reopen; and
- deciding retention policy for old failed or partial workspaces.

## Reconciliation required before implementation

This grill's Session-continuation decisions conflict at a specific boundary with [DEL-629 D-086](https://linear.app/delegance/issue/DEL-629/implement-playbook-states-occurrences-collections-and-claims):

- This record says an ordinarily observed Session exit without accepted completion leaves the Execution continuable, and explicit continuation creates a fresh Session in v1.
- DEL-629 D-086 says v1 does not launch another agent Session after a reboot or equivalent termination and defers even manual Resume to a later feature.

The unresolved boundary is whether Q31/Q37 continuation applies only to an ordinary Session exit observed while the current runtime remains authoritative, while reboot/takeover recovery remains interrupted and non-resumable, or whether every terminated-Session continuation must be deferred from v1. Do not silently choose between these interpretations.

Related Linear text that describes "attaching" a Playbook or uses a separate Run identity must also be reconciled with the Task-owned model above.

## Paused frontier

Q38 was asked but not answered:

> Should `complete` be accepted only from the Execution's current Session, rejecting delayed completion from an earlier continuation Session or an unrelated Session?

No current-Session completion fence or stale-completion behavior is settled by this record. The grill resumes at Q38.
