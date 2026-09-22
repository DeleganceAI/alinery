---
schema: alinery.playbook/v1

playbook:
  id: primed-feature-development
  description: >-
    Take a feature from an initial ticket through focused questions, grounded
    research, an approved direction, an executable plan, a test contract, and
    a developed and verified change.
  budget_defaults:
    max_step_executions: 30
    max_wall_clock_seconds: 9000

steps:
  - id: probe-the-question
    harness: omp
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    inputs: [ticket.md]
    outputs: [question-map.md]

  - id: research-the-problem
    harness: omp
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    inputs: [ticket.md, question-map.md]
    outputs: [research-findings.md]

  - id: identify-the-direction
    harness: omp
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    inputs: [ticket.md, question-map.md, research-findings.md]
    outputs: [direction.md]
    completion:
      human_approval: true

  - id: map-the-plan
    harness: omp
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    inputs: [ticket.md, question-map.md, research-findings.md, direction.md]
    outputs: [implementation-plan.md]

  - id: establish-the-test-contract
    harness: omp
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    inputs: [ticket.md, question-map.md, research-findings.md, direction.md, implementation-plan.md]
    outputs: [test-contract.md]

  - id: develop-the-change
    harness: omp
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    inputs: [ticket.md, question-map.md, research-findings.md, direction.md, implementation-plan.md, test-contract.md]
    outputs: [development-report.md]
    completion:
      human_approval: true
---

# PRIMED Feature Development

PRIMED is a six-Step Playbook for feature work:

- **P — Probe the Question**
- **R — Research the Problem**
- **I — Identify the Direction**
- **M — Map the Plan**
- **E — Establish the Test Contract**
- **D — Develop the Change**

Each Step has one primary input handoff and one primary output handoff. Later
Steps also require the earlier handoffs that govern the work. The agent may
inspect its complete assigned source material, including source, tests and
attachments, but the primary handoff makes the next decision clear.

## Process

```text
ticket.md
  -> Probe the Question        -> question-map.md
  -> Research the Problem      -> research-findings.md
  -> Identify the Direction    -> direction.md
       [human review in conversation]
  -> Map the Plan              -> implementation-plan.md
  -> Establish the Test Contract -> test-contract.md
  -> Develop the Change        -> development-report.md
       [human review in conversation]
```

The intended outcome is a developed, verified change with inspectable evidence.
A separate review or publication Playbook belongs to another Task or subtask.

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

Use the engine-provided completion operation only when a different agent could
investigate every material uncertainty without reconstructing the ticket's intent.

<a id="research-the-problem"></a>
## Research the Problem

Read the exact bound `question-map.md` and `ticket.md`. Check that the questions
describe that ticket; if they conflict, obtain human direction before proceeding.
Use the assigned source material as context. Investigate every listed question
before proposing a direction.

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

Use the engine-provided completion operation only after every question is
accounted for and another agent can trace each important conclusion to evidence.

<a id="identify-the-direction"></a>
## Identify the Direction

Read the exact bound `research-findings.md`, `question-map.md` and `ticket.md`.
Confirm that the findings address those questions and that request. Surface
contradictions to the human rather than silently combining different assignments.
Turn the evidence into one coherent direction for the feature.

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

Present `direction.md` and its material tradeoffs to the human through the
conversation. Resolve every material design question and obtain the requested
approval before asking the engine to complete this Execution. Record the actual
decision and its scope in `direction.md`; do not invent approval or infer it
from the existence of an artifact. If the human requests changes, revise the
direction and confirm the changed proposal before completion.

Keep the work within this Step's assignment. Approval is an instruction for the
agent to follow, not an engine-enforced gate or a separate candidate state.

Do not write the ordered implementation plan or production code in this Step.

<a id="map-the-plan"></a>
## Map the Plan

Read the exact bound `direction.md`, including the recorded human decisions,
and its bound ticket, questions and research evidence.
Confirm that `Material Design Questions` contains no open item. A captured
artifact is not proof of human approval. If the direction lacks a required
decision or contradicts the request, explain the blocker to the human and do
not request completion or silently substitute a different assignment.

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

Use the engine-provided completion operation only when the plan covers the
feature end to end and contains no hidden design decision to rediscover.

<a id="establish-the-test-contract"></a>
## Establish the Test Contract

Read the exact bound `implementation-plan.md` and its bound direction, research,
questions and ticket. Check that the plan preserves those decisions and requested
behavior. If these handoffs disagree materially, obtain human direction before
writing a contract against them.

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

If this Step changes repository tests, finalize those intended changes in Git
and record the resulting commit in `test-contract.md`. Otherwise identify the
unchanged repository revision; do not manufacture a change. Keep the handoff
artifact in the engine-provided result-artifact area. Use the engine-provided
completion operation only when the next agent can implement against an
unambiguous, reproducible test contract.

<a id="develop-the-change"></a>
## Develop the Change

Read the exact bound `test-contract.md`. Treat the bound `implementation-plan.md`
and `direction.md` as governing constraints, and use the bound research, questions
and ticket for context. Confirm that the contract governs this plan and direction;
surface inconsistent handoffs before changing code.

Implement the approved slices in order. Reuse existing mechanisms and keep the
diff limited to what the feature and its verification require. Run the test
contract continuously enough to catch drift early, then run the complete
relevant verification before finishing.

The test contract and its tests govern development. Do not delete, skip, or
weaken a valid check merely to obtain a passing result.

If implementation evidence invalidates the test contract or a material design
decision, stop implementation and explain the blocker to the human. Record the
evidence, affected cases and decisions, and disposition of partial work in
`development-report.md`. Do not request completion while the governing contract
is unresolved, silently replace the recorded assignment, or claim the engine
will rewind earlier Steps. Ask for direction on the necessary follow-up work.
Only nonmaterial factual adjustments may be recorded as deviations, and they
must preserve the approved outcome and contracts.

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

Do not request completion merely because the editing Session ended. Finish
every required slice and acceptance case, run the required automated checks,
and obtain the required manual verification. Removing a slice or acceptance
case, changing expected behavior, or weakening required evidence is a material
contract change; explain it to the human rather than silently relaxing the
approved contract.

Finalize intended repository changes in Git. Present the complete change and
`development-report.md` to the human for the requested review and approval.
Record the actual decision and any explicitly accepted limits in the report.
Address requested revisions within the unfinished Execution and repeat the
affected verification and review before using the engine-provided completion
operation. Do not claim completion while required work remains.

## Handoff and State conventions

Follow the engine-generated context for the exact assigned inputs, source
snapshots, writable repository and result-artifact area. Required inputs define
eligibility. Each later Step binds the primary handoff and earlier governing
artifacts; their contents must describe consistent work. These dependencies do
not select a preferred source State or solve provenance association. Inspect
the assigned repository alongside its handoff; prose alone does not prove that
the described code or tests are present.

The engine-provided completion operation is the acceptance boundary. Write
handoffs in the result-artifact area and finalize intended repository changes
in Git. Accepted completion records one result State and the Execution's
history; unchanged material may reuse a State. Authored `outputs` are advisory
expectations, not an engine-enforced success checklist or capture whitelist.

Human approval instructions apply within the conversation before requesting
completion. The optional Boolean records that intent; the engine does not
enforce approval or certify it from a captured artifact. Artifact comments may
inform that conversation without changing accepted material.

An Execution is an attempt at the Step and its assigned inputs. Ordinary Session
exit without acceptance permits explicit Continue in the same unfinished
Execution. Recovery with no live Session uses explicit Retry from the original
inputs in a new attempt; it does not inherit unaccepted edits. Request user
direction before Retry, including through MCP. Neither action runs
automatically. No arbitrary historical-Step replay is assumed here.

The frontmatter budget defaults are editable limits on starting more Executions,
not duration predictions or hard ceilings for already-running work.

## Why this is Playbook-friendly

The primary handoffs describe the intended progression; the declared inputs
determine eligibility. This default feature process needs no wildcard fan-out
or completeness join. The ordinary source and handoff rules still apply, so a
customized version may later add research fan-out, specialist design review or
parallel implementation with appropriate dependencies.

## Status and adaptation points

This is a draft v1 conversion of the feature Playbook, not a completed engine
pilot. Teams may adapt the prompts, models, approval instructions or test depth,
or add specialist Steps while retaining the six-stage contract:

```text
Probe -> Research -> Identify -> Map -> Establish -> Develop
```

The first pilot should use a real medium-sized feature with at least one
meaningful design choice and an existing test surface. Review whether each
handoff lets the next agent begin without redoing the previous Step, whether
the Identify and Develop approval conversations occur at useful review points,
and whether the test contract predicts what Develop actually needs to verify.
