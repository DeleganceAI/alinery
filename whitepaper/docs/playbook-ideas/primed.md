---
schema: alinery.playbook/sketch-0

playbook:
  id: primed-feature-development
  title: PRIMED Feature Development
  revision: 1
  status: potential
  description: >-
    Take a feature from an initial ticket through focused questions, grounded
    research, an approved direction, an executable plan, a test contract, and
    a developed and verified change.

steps:
  - id: probe-the-question
    title: Probe the Question
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'Exists(["ticket.md"])'
    inputs: [ticket.md]
    outputs: [question-map.md]
    instructions: "#probe-the-question"

  - id: research-the-problem
    title: Research the Problem
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'Exists(["question-map.md"])'
    inputs: [question-map.md]
    outputs: [research-findings.md]
    instructions: "#research-the-problem"

  - id: identify-the-direction
    title: Identify the Direction
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'Exists(["research-findings.md"])'
    inputs: [research-findings.md]
    outputs: [direction.md]
    completion:
      human_approval:
        focus: direction.md
        guidance: >-
          Confirm the proposed direction and its material tradeoffs before
          planning begins.
    instructions: "#identify-the-direction"

  - id: map-the-plan
    title: Map the Plan
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'Exists(["direction.md"])'
    inputs: [direction.md]
    outputs: [implementation-plan.md]
    instructions: "#map-the-plan"

  - id: establish-the-test-contract
    title: Establish the Test Contract
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'Exists(["implementation-plan.md"])'
    inputs: [implementation-plan.md]
    outputs: [test-contract.md]
    instructions: "#establish-the-test-contract"

  - id: develop-the-change
    title: Develop the Change
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'Exists(["test-contract.md"])'
    inputs: [test-contract.md]
    outputs: [development-report.md]
    completion:
      human_approval:
        focus: development-report.md
        guidance: >-
          Review the completed change, verification evidence, and any required
          manual testing before accepting the result.
    instructions: "#develop-the-change"
---

# PRIMED Feature Development

PRIMED is the default Playbook for feature work:

- **P — Probe the Question**
- **R — Research the Problem**
- **I — Identify the Direction**
- **M — Map the Plan**
- **E — Establish the Test Contract**
- **D — Develop the Change**

Each Step has one primary input handoff and one primary output handoff. The
agent may inspect the complete bound task state, including source, tests,
attachments, and earlier artifacts, but the primary handoff makes ownership of
the next decision clear.

## Process

```text
ticket.md
  -> Probe the Question        -> question-map.md
  -> Research the Problem      -> research-findings.md
  -> Identify the Direction    -> direction.md
       [human approval gate]
  -> Map the Plan              -> implementation-plan.md
  -> Establish the Test Contract -> test-contract.md
  -> Develop the Change        -> development-report.md
       [human approval gate]
```

The Run ends in a developed, verified task state that is ready for review. A
separate review or publication Playbook may begin from that state.

<a id="probe-the-question"></a>
## Probe the Question

Read the exact bound `ticket.md` and inspect its attachments. Establish what
the requested change actually asks the team to accomplish before investigating
solutions.

Inspect the repository only far enough to understand its vocabulary, locate
the likely affected area, and avoid questions the current state answers
immediately. Do not perform the full investigation or select a design in this
Step.

Write `question-map.md` containing:

1. A concise statement of the requested feature and the user-visible outcome.
2. Explicit in-scope and out-of-scope behavior.
3. Facts already established by the ticket or current repository state, with
   exact evidence.
4. Assumptions that must not quietly become requirements.
5. Stable question identifiers such as `Q1`, `Q2`, and `Q3`.
6. For every question:
   - the exact uncertainty;
   - why its answer could change the work;
   - what evidence would resolve it; and
   - whether it requires repository research, external research, or human
     clarification;
   - status: `open`, `answered`, or `working-assumption`; and
   - any exact human answer, who supplied it, and the authority under which it
     controls the work.
7. Initial acceptance signals that the later design and test contract must
   make precise.
8. Any access, environment, or authority limitation already visible.

Ask the human when ambiguity would materially change scope, safety, cost, or
the intended user experience. Otherwise record a conservative working
assumption and its impact for later validation. Keep the Step incomplete while
a material ambiguity can only be resolved by the human and no authorized
answer exists.

Call `step_complete` only when a different agent could investigate every
material uncertainty without reconstructing the ticket's intent.

<a id="research-the-problem"></a>
## Research the Problem

Read the exact bound `question-map.md`. Use `ticket.md` and the complete input
state as supporting context. Investigate every listed question before proposing
a direction.

Start with direct repository evidence: relevant code paths, tests, schemas,
configuration, build behavior, history, and established conventions. Consult
authoritative external material only when the question depends on a library,
standard, service, or domain fact not established locally.

For each material claim, distinguish:

- direct observation;
- inference from the available evidence;
- an unresolved hypothesis; and
- a recommendation reserved for the next Step.

Write `research-findings.md` containing:

1. A map of the current behavior and the components that produce it.
2. A section for every question identifier with status `answered`, `partially
   answered`, or `unanswered`.
3. The best available answer and its exact supporting evidence.
4. Existing interfaces, invariants, data flow, failure behavior, and security
   or privacy boundaries relevant to the feature.
5. Repository conventions and reusable mechanisms the design should respect.
6. Dependencies, compatibility concerns, and migration constraints.
7. Existing verification commands and the tests closest to the affected
   behavior.
8. Contradictions, missing access, uncertainty, and facts that still require
   human confirmation.
9. A decision-ready summary of what the evidence permits and forbids.

Do not choose an architecture merely to make the report feel complete. If a
question cannot be answered, explain why, what was checked, and how that
uncertainty affects the next decision.

Call `step_complete` only after every question is accounted for and another
agent can trace each important conclusion to evidence.

<a id="identify-the-direction"></a>
## Identify the Direction

Read the exact bound `research-findings.md`, then consult `question-map.md` and
`ticket.md`. Turn the evidence into one coherent direction for the feature.

Compare the viable approaches before selecting one. Prefer the smallest design
that satisfies the requested outcome and the repository's existing invariants.
Do not create flexibility for hypothetical future requirements.

Write `direction.md` containing:

1. The objective, non-goals, and observable successful outcome.
2. The selected direction in concrete terms.
3. Every material design decision and the evidence or explicit assumption
   behind it.
4. Components, interfaces, data ownership, control flow, and state changes.
5. Failure behavior, recovery, compatibility, security, privacy, and migration
   consequences where relevant.
6. Alternatives considered and the decisive tradeoff for each rejection.
7. Risks, unknowns, and the consequence of being wrong.
8. A `Material Design Questions` section.
9. Human input or delegated decision authority that materially shaped the
   direction, recorded without inventing either.

This is the default human approval boundary. Work with the human inside the
Step when a consequential choice remains, and do not submit a candidate while
any material design question is open. Once the direction is complete, call
`step_complete` to submit the exact candidate state for engine-owned human
approval. No successor state is published, and Map cannot become eligible,
until the human approves it.

The approval covers the exact candidate state, with `direction.md` as its UI
focus. A requested revision continues this atomic Step, and any candidate
change invalidates a pending approval. A later material change to an approved
direction must return through Identify, Map, and Establish before development
continues.

Do not write the ordered implementation plan or production code in this Step.

<a id="map-the-plan"></a>
## Map the Plan

Read the exact bound `direction.md`. Its sealed producing state is the durable
evidence that the engine-owned approval gate was satisfied; the artifact need
not record its own approval. Confirm that `Material Design Questions` contains
no open item. If that condition fails, call `step_fail` with the exact
unresolved questions and publish no successor state. The human or agent can
then rerun Identify from the applicable research state; its new `direction.md`
occurrence grounds a new Map execution.

Translate the direction into the smallest ordered set of implementation slices
that another agent can execute without making new architectural decisions.

Write `implementation-plan.md` containing:

1. The approved outcome and the design decisions the plan must preserve.
2. Ordered implementation slices with stable identifiers.
3. For every slice:
   - its purpose and observable result;
   - exact components, files, symbols, schemas, or interfaces likely to change;
   - dependencies on earlier slices;
   - data or compatibility migration work;
   - error and rollback considerations; and
   - the evidence that will show the slice is complete.
4. Work that can safely proceed in parallel, if any.
5. Required test layers, build checks, and manual verification.
6. A final trace from every requested behavior to a planned slice and
   verification point.

Keep the plan executable and bounded. Do not add cleanup or refactoring that
does not support the approved direction. Do not change production behavior in
this Step.

Call `step_complete` only when the plan covers the feature end to end and
contains no hidden design decision for the development agent to rediscover.

<a id="establish-the-test-contract"></a>
## Establish the Test Contract

Read the exact bound `implementation-plan.md`. Consult `direction.md`,
`research-findings.md`, and `ticket.md` for the behavior and evidence behind
the plan.

Define the observable contract the developed change must satisfy. Add focused
tests before production changes when the repository and behavior make that
useful. Run those tests to establish the current result; a relevant failure is
valuable evidence, while an unexpected pass may expose an incorrect test or an
already-supported behavior.

Every added or changed pre-development test must be run. Confirm that its
failure is caused by the intended missing behavior—not compilation, setup,
environment, or unrelated failures—before treating it as a valid red result.

Write `test-contract.md` containing:

1. Stable acceptance-case identifiers.
2. For every acceptance case:
   - the behavior or invariant under test;
   - setup and inputs;
   - the action or event;
   - the observable expected result;
   - the appropriate test layer; and
   - the exact command or procedure that verifies it.
3. Regression, boundary, error, recovery, compatibility, and security cases
   relevant to the approved direction.
4. Test files added or changed during this Step.
5. Exact commands run, their results, and which failures are expected before
   development.
6. Manual verification that cannot be automated, with a precise procedure.
7. Known coverage gaps and why they are acceptable or still require human
   direction.
8. A trace from every plan slice and acceptance signal to at least one check.

Resolve every gap that depends on human direction before completion, or record
the exact human decision accepting it, who made that decision, their authority,
and its consequence for the contract. An unresolved material gap blocks
completion.

Do not manufacture a failing test or claim that a command ran when it did not.
If a useful pre-development test is impractical, state the reason and define
the smallest reliable alternative. Avoid production changes except for the
minimum test seam explicitly required by the approved direction.

Call `step_complete` only when the next agent can implement against an
unambiguous, reproducible test contract.

<a id="develop-the-change"></a>
## Develop the Change

Read the exact bound `test-contract.md`. Treat `implementation-plan.md` and
`direction.md` as governing constraints, and use the research and ticket for
supporting context.

Implement the approved slices in order. Reuse existing mechanisms and keep the
diff limited to what the feature and its verification require. Run the test
contract continuously enough to catch drift early, then run the complete
relevant verification before finishing.

The test contract and its tests govern development. Do not delete, skip, or
weaken a valid check merely to obtain a passing result.

If implementation evidence invalidates the test contract or a material design
decision, call `step_fail` and publish no successor state. Record the evidence,
affected cases and decisions, and disposition of partial work in the failure
reason. This stops automatic execution. To continue, a human explicitly reruns
the appropriate earlier Step and includes the durable failure record as
supplemental instruction. For a contract error, rerun Establish from the
applicable plan state; its new `test-contract.md` occurrence grounds a new
Develop execution. For a material design error, rerun Identify from the
applicable research state, then Map, Establish, and Develop from the new chain
of handoffs. Only nonmaterial factual adjustments may be recorded as
deviations, and they must preserve the approved outcome and contracts.

Write `development-report.md` containing:

1. The user-visible and system-visible behavior delivered.
2. The completed status of every plan slice.
3. Files, schemas, interfaces, dependencies, and migrations changed.
4. The status of every acceptance case and the evidence for each satisfied
   case.
5. Every verification command actually run, its result, and any relevant
   environment limitation.
6. Manual verification completed.
7. Nonmaterial execution deviations and why they were necessary.
8. Known limitations, residual risks, and focused follow-up work.

Do not call `step_complete` merely because the editing session ended. Complete
only when every required slice and acceptance case is complete, every required
automated and manual check passes, and no required work remains. Removing a
slice or acceptance case, changing expected behavior, or weakening required
evidence is a material contract change and must return through Identify, Map,
and Establish. If only a verification procedure must change, rerun Establish
to publish an equivalent, approved test contract before starting a new Develop
execution.

When the change is ready, call `step_complete` to submit the exact candidate
state for engine-owned human approval. The human reviews the complete change
and verification evidence, with `development-report.md` as the UI focus. No
successor state is published until approval. A requested revision continues
this atomic Step, and any candidate change invalidates a pending approval.

## Handoff and state conventions

Each successful Step publishes one successor task state. Source changes, test
changes, commits, and artifacts in that state are preserved together; the
Markdown output is the primary handoff, not the whole state.

For a Step with `completion.human_approval`, `step_complete` first submits a
finished candidate. The engine freezes that exact candidate while approval is
pending and publishes it only after approval. Approval provenance belongs to
the engine-owned execution record rather than the artifact. A revision request
continues the same atomic Step; it does not publish an intermediate state.

The Playbook source names logical artifact paths. At runtime the engine binds
each Step to the exact predecessor artifact occurrence and its producing state.
A completed application of a Step consumes that exact binding once for
automatic execution. A human may deliberately rerun a Step from the same state
to create another branch with a different successor state.

The `when` expression establishes eligibility; it is not a cursor. The engine's
global automatic claim is keyed by the Step-definition revision and exact input
binding, so an artifact that continues to exist in descendant states does not
relaunch the same application.

Earlier artifacts mentioned by a prompt are supporting context inherited from
the primary handoff's producing state, not independent triggers. A correction
to an earlier artifact propagates by rerunning the earliest affected Step and
then following the newly published handoff chain. A human may instead request
an explicit rerun when they intentionally want another branch.

An atomic Step may use multiple sequential harness Sessions when context or
human collaboration requires it. Session boundaries do not publish task
states. Prefer one Session per Step; use continuation only when the work cannot
reasonably be completed within one.

## Why this is Playbook-friendly

The six artifact dependencies define the displayed graph and execution order.
There are no dynamic collections or merge bindings because the default feature
process is intentionally linear. The same state and handoff rules used by
branching Playbooks still apply, so a customized version may later add research
fan-out, specialist design review, or parallel implementation without changing
the meaning of any core Step.

## Status and adaptation points

This is a candidate default feature Playbook. Teams may adapt the prompts,
models, approval policy, test depth, or add specialist Steps while retaining
the six-stage contract:

```text
Probe -> Research -> Identify -> Map -> Establish -> Develop
```

The first pilot should use a real medium-sized feature with at least one
meaningful design choice and an existing test surface. Review whether each
handoff lets the next agent begin without redoing the previous Step, whether
the Identify and Develop gates occur at the right human review points, and
whether the test contract predicts what Develop actually needs to verify.
