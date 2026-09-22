---
schema: alinery.playbook/v1
playbook:
  id: natural-planning-brainstorm
  description: Frame a challenge, generate and cross-pollinate independent perspectives, preserve
    the complete idea wall, evaluate options, and define concrete next actions.
  budget_defaults:
    max_step_executions: 25
    max_wall_clock_seconds: 7500
steps:
- id: frame-the-challenge
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - ticket.md
  outputs:
  - brainstorm-brief.md
  - perspective-request-*.md
- id: generate-possibilities
  harness: omp
  model: gpt-5.6-luna
  settings:
    reasoning_effort: medium
  inputs:
  - perspective-request-*.md
  outputs:
  - idea-contribution-*.md
- id: harvest-the-idea-wall
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - complete: idea-contribution-*.md
  outputs:
  - idea-wall.md
  - perspective-request-*.md
  - shape-request-*.md
- id: shape-the-options
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - shape-request-*.md
  outputs:
  - organized-options.md
  - perspective-request-*.md
  - next-action-request-*.md
- id: define-next-actions
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - next-action-request-*.md
  outputs:
  - brainstorm-handoff.md
  completion:
    human_approval: true
---

# Natural Planning Brainstorm

This draft v1 Playbook turns an open-ended challenge into a broad,
inspectable possibility space and then into decisions and concrete next
actions. It adapts David Allen's natural planning sequence to parallel agent
work:

1. establish the purpose and non-negotiable principles;
2. describe observable success;
3. generate possibilities without simultaneously judging them;
4. organize and evaluate only after the complete idea inventory is visible;
   and
5. identify the next action for every independently movable component.

This full version is intended for consequential, genuinely open-ended
challenges. A routine question that needs only a few ideas should use a lighter
Playbook rather than paying for ten parallel perspectives.

The Playbook replaces meeting participants with parallel agent perspectives.
It does not simulate a live meeting or require a persona runtime. A perspective
is an ordinary Markdown request that changes what one application of
`generate-possibilities` searches for. The display name makes the perspective
memorable; its instructions provide the actual behavior.

The supplied roster is deliberately opinionated enough to run immediately and
simple enough to adapt. A Playbook author may add, remove, split, duplicate, or
rewrite perspectives for a particular project without changing the execution
graph, provided every requested generation batch remains finite and nonempty.

## Process and defaults

```text
ticket.md → Frame
  → seven perspective-request-*.md files → Generate independently
  → complete: idea-contribution-*.md → Harvest an unranked idea wall
  → three new perspective-request-*.md files → Generate with the shared wall
  → complete: idea-contribution-*.md → Harvest a cumulative wall
  → shape-request-*.md → Shape and evaluate
      → targeted perspective requests, then Generate / Harvest / Shape once
      OR
      → next-action-request-*.md → Define next actions → brainstorm-handoff.md
```

The first seven applications receive the same framing context in isolated
workspaces; their instructions prohibit looking for sibling ideas. The next
three receive the completed wall as explicit request content. Blindness is an
agent instruction plus ordinary workspace isolation, not a new access-control
or persona mechanism. The engine does not interpret perspective names or modes.

Each producer creates a finite request set together before completion. One
ordinary wildcard binds each worker request; `complete:` binds the corresponding
accepted contribution coverage. Do not replace this association with matching
filename stems or an agent-maintained counter. Precise cohort/source semantics
remain G1 work, as noted below.

Task admission suggestions are declared in the frontmatter. Preserve the
seven-perspective initial batch, three-perspective shared-wall batch, and one
targeted return from the original process. The targeted return may contain one
or more meaningful requests. Larger workloads may require an explicit Task
budget override; do not silently reduce the requested work to fit a suggestion.

## The default perspectives

The first wave contains seven named perspectives.

### The Explorer

Generate freely across the entire focal question. Follow promising
associations, include obvious possibilities so the inventory is complete, and
continue beyond the first conventional cluster into strange or incomplete
ideas.

### The Advocate

Explore how the challenge appears from the most affected stakeholder or use
context named in the brief. Generate possibilities that improve that
stakeholder's experience or agency. Do not impersonate the stakeholder, claim
to know what they believe, or manufacture user evidence.

The starter Playbook emits one Advocate request. A customized Playbook may emit
one Advocate request per important stakeholder, increasing the fan-out without
creating another Step definition.

### The Inverter

Identify assumptions that are not true principles. Remove, reverse, relax, or
turn those assumptions into advantages. Never violate a principle that the
brief marks non-negotiable merely to appear unconventional.

### The Analogist

Search for patterns in other products, organizations, disciplines, historical
cases, natural systems, games, rituals, or everyday experiences. Transfer the
underlying mechanism rather than copying the surface appearance. Mark any
factual premise that would need verification.

### The Boundary Shifter

Change scale, time horizon, lifecycle stage, frequency, ownership boundary, or
system boundary. Ask what becomes possible when the challenge is ten times
larger, much smaller, immediate, long-lived, centralized, distributed,
individual, collective, upstream, or downstream.

### The Simplifier

Remove steps, dependencies, choices, interfaces, and assumptions. Decompose the
challenge into independently solvable pieces. Generate smaller interventions
that might deliver the important outcome without reproducing the entire
existing system.

### The Remixer

Combine capabilities, resources, partial approaches, and apparently unrelated
ingredients. Generate new configurations rather than ranking the ingredients.
Include combinations that are not yet complete enough to implement.

The shared-wall wave contains three different perspectives.

### The Builder

Find incomplete, underspecified, or fragile ideas on the wall and extend them.
Add the missing mechanism, supporting element, variant, or bridge that would
turn a fragment into a more complete possibility. Do not decide whether the
result should win.

### The Connector

Find ideas from distant clusters that become more interesting when combined.
Explain the relationship and produce a genuinely integrated possibility rather
than merely listing two ideas together.

### The Gap Hunter

Compare the visible wall with the purpose, principles, successful outcome,
stakeholders, constraints, lifecycle, and known context. Search the blank areas
and generate possibilities in spaces the first wave neglected. Do not score the
ideas already present.

## Default scale and model recommendations

The source uses initial operational settings, not benchmarked claims about
model creativity.

- `frame-the-challenge`, `harvest-the-idea-wall`, `shape-the-options`, and
  `define-next-actions` use `gpt-5.6-sol` with high reasoning because they must
  preserve a common frame, reconcile many artifacts, distinguish mental modes,
  and make consequential tradeoffs explicit.
- `generate-possibilities` uses `gpt-5.6-luna` with medium reasoning because the
  work is highly parallel, bounded, and intentionally expansive.
- The default first wave requests up to 20 atomic ideas from each of seven
  perspectives. The shared-wall wave requests up to 15 additions from each of
  three perspectives. That creates capacity for roughly 185 idea records before
  any optional gap-fill pass; it is a search target and ceiling, not a padding
  quota. Each agent reports an honest shortfall rather than paraphrasing ideas
  to hit a count.
- A Playbook author may use a stronger model, different models for different
  perspectives, or larger budgets. The perspective instructions—not invented
  model personalities—remain the primary diversity mechanism.

Before relying on a modified low-cost model, inspect several complete idea
batches for repetition, premature judgment, instruction drift, fabricated
facts, and loss of unusual ideas.

<a id="frame-the-challenge"></a>
## Frame the Challenge

Read `ticket.md`. Work through the following modes in order. Do not
jump directly to solutions merely because the initial artifact already contains
some.

### Purpose

Write why this thinking matters, what larger objective it serves, and what
decision or movement the completed brainstorm should enable. Convert a vague
topic into one focal generative question, normally phrased as “What are all the
ways we might ...?”

### Principles

Identify what must remain true regardless of the chosen approach: ethical
boundaries, product or organizational commitments, operating standards,
resource realities, and required behavior. Distinguish true principles from
assumptions that a later perspective may challenge.

### Observable successful outcome

Imagine that the work has succeeded unusually well. Describe what a person
could observe after completion: what exists, what is happening, what has
changed, and how the relevant people or systems experience it. Temporarily
suspend objections about how to get there, but do not state fantasies as
present facts.

### Current reality and authority

Capture known context, prior attempts, available resources, constraints,
stakeholders, factual uncertainties, deadlines, and existing decisions. State
whether the final Step may make an internal decision or must present a
recommendation for human approval.

Write `brainstorm-brief.md` containing:

- `brainstorm_id`;
- purpose;
- non-negotiable principles;
- assumptions that may be challenged;
- observable successful outcome;
- focal question;
- current reality and supporting artifacts;
- affected stakeholders and use contexts;
- factual claims or unknowns that must not be invented;
- `seed_ideas`, containing every idea already supplied in
  `ticket.md` as an unranked entry with its original wording and
  human/source attribution, or an explicit empty set;
- decision authority;
- initial and targeted generation budgets; and
- the required final handoff.

If the input is dangerously ambiguous or the human has reserved framing
authority, make the provisional framing and its unresolved choices explicit.
Record the assumptions under which the autonomous framing will proceed rather
than waiting for approval in this first Step.

Write exactly seven independent `perspective-request-*.md` files for the initial
blind-divergence batch. Use canonical lowercase paths, for example
`perspective-request-initial-explorer.md`; reserve a distinct batch label for
later work. Each request contains:

- the complete relevant brief: purpose, principles, outcome, question, seed
  ideas, context, factual uncertainty and decision authority;
- a brainstorm label, batch label and perspective label for domain provenance;
- the display name and concrete search operation;
- `blind-divergence` as ordinary request content, with an explicit statement
  that there is no prior wall;
- the idea target/ceiling, normally 20, and an honest-shortfall rule;
- the intended unique result path, such as
  `idea-contribution-initial-explorer.md`;
- the idea-record schema, separate parking lot and full no-judgment contract;
  and
- the instruction that only one targeted gap-fill pass is intended after the
  shared-wall batch.

Copy this context into each request rather than treating a mutable
`brainstorm-brief.md` path as a runtime-resolved foreign key. Reference the
already assigned material when helpful, but do not manufacture engine identities
for outputs that have not been accepted.

Encode these search operations directly in the request artifacts:

- **The Explorer:** range freely across the focal question, include the obvious,
  and continue into strange or incomplete possibilities.
- **The Advocate:** generate from the situation of the most affected named
  stakeholder without inventing that person's beliefs or evidence.
- **The Inverter:** remove, reverse, relax, or repurpose assumptions while
  preserving every non-negotiable principle.
- **The Analogist:** transfer mechanisms from other domains without copying
  surface appearances or presenting an unverified analogy as fact.
- **The Boundary Shifter:** vary scale, time horizon, lifecycle, ownership, and
  system boundary.
- **The Simplifier:** remove or decompose elements and search for a smaller way
  to produce the important outcome.
- **The Remixer:** combine resources, capabilities, and partial approaches into
  new configurations without ranking the ingredients.

Ask the engine-provided completion operation to accept this Execution only
after the described work is ready and any required conversation has occurred.
Use the operation and context actually supplied by the engine; this Playbook
does not prescribe its argument schema. Correct a rejected completion in the
same Execution. Do not invent a failure tool, a publication-path declaration,
source-State assignments, or a successful acceptance acknowledgment.

<a id="generate-possibilities"></a>
## Generate Possibilities from One Perspective

Read the exact bound perspective request, including its captured brief. Apply only
the request's search operation. For a blind-divergence request, do not inspect
any sibling contribution or any state published after the common framing
state. For a shared-wall or targeted request, use the prior wall copied into that
request and its recorded source context, not a newer wall found elsewhere.

This is generation, not evaluation. Follow these rules:

1. Generate possibilities; do not select a winner.
2. Pursue quantity, range, and association rather than polished quality.
3. Stay relevant to the focal question and non-negotiable principles.
4. Do not score, rank, reject, debate, criticize, or recommend.
5. Include obvious, weak, strange, incomplete, and impractical possibilities.
6. Continue past the first homogeneous cluster.
7. Do not silently suppress an idea because a concern occurs to you.
8. Put concerns, objections, missing evidence, and evaluation questions into a
   separate parking lot for later use.
9. Mark speculative factual premises as assumptions rather than facts.
10. Do not invent stakeholder testimony, research findings, or external
    validation.

The idea budget is a target and ceiling, not permission to pad the result.
Report an honest shortfall when the perspective yields fewer distinct ideas.

For every idea, record:

- a request-scoped `raw_idea_id`;
- a concise title;
- the atomic possibility in enough detail to understand it later;
- the association, assumption, wall item, or other trigger that produced it;
- the originating perspective and wave; and
- factual premises that need verification.

Write the unique `idea-contribution-*.md` result path given in the request. Include every
idea, the separate parked observations, requested and delivered counts, and any
shortfall. Do not merge, order, or clean the ideas into a false consensus.
Include the request's complete brief, prior wall (when present), mode, and
targeted-pass allowance with the result so Harvest does not need to pair a
separate ordinary wildcard with this result set. Preserve the actual assigned
input/Execution references supplied by the engine; the prose does not itself
establish fulfillment.

Ask the engine-provided completion operation to accept this Execution only
after the described work is ready and any required conversation has occurred.
Use the operation and context actually supplied by the engine; this Playbook
does not prescribe its argument schema. Correct a rejected completion in the
same Execution. Do not invent a failure tool, a publication-path declaration,
source-State assignments, or a successful acceptance acknowledgment.

<a id="harvest-the-idea-wall"></a>
## Harvest the Complete Idea Wall

Work from the complete contribution set and source States already assigned by
the engine. Do not choose other parents, infer a complete batch from a file
count, or publish a knowingly partial wall. Check that the supplied domain
context describes one coherent requested batch; report a mismatched assignment
instead of silently combining unrelated walls.

For the initial batch, begin with the full supplied seed-idea set. For a shared
or targeted batch, begin with the exact prior wall copied into its contributions
and reconcile that common context across the assigned sources. Do not fetch the
newest `idea-wall.md` from Task history. Write cumulative `idea-wall.md`.

The wall must:

1. retain every raw idea and parked observation;
2. preserve batch, perspective, request, Execution and State references actually
   supplied with the work;
3. record a domain board label for this completed batch;
4. assign stable brainstorm-scoped idea IDs;
5. link exact duplicates, near duplicates, extensions, contradictions and related
   ideas without deleting or silently collapsing them;
6. reconcile delivered counts against every contribution;
7. distinguish agent-generated ideas, supplied facts and human ideas; and
8. remain unranked and unevaluated.

Repeated ideas are not votes. Frequency is context, not proof of correctness.

After blind divergence, write exactly three new `perspective-request-*.md`
files, for example `perspective-request-shared-builder.md`. Copy the entire
completed wall and brief into each request, retain their known provenance,
give each a unique `idea-contribution-*.md` result path, and request up to 15
distinct additions. Include the same record/no-judgment contract used above.
The three search operations are:

- **The Builder:** extend incomplete ideas with missing mechanisms, variants,
  bridges or supporting elements without selecting a winner.
- **The Connector:** integrate distant idea clusters and explain what makes the
  combination useful.
- **The Gap Hunter:** compare the wall with the frame and generate within
  neglected search areas without scoring existing ideas.

After the shared-wall batch, write one uniquely named `shape-request-*.md`
containing the complete cumulative wall, brief, current board label, and
permission for one targeted gap-fill pass. After a targeted batch, write one
new shape request containing those same materials plus the previous option map,
all preserved non-generative gaps, and an explicit statement that the targeted
pass has been used. Those are instructions and domain content, not engine
fields or an enforced loop limit.

Choose one next branch appropriate to this batch; do not emit both shared
perspective work and a Shape request. Unused output selectors need no placeholder
files or empty collection declarations. Do not delete accepted historical
requests; the engine's recorded bindings and claims distinguish handled work.
Ask the engine-provided completion operation to accept this Execution only
after the described work is ready and any required conversation has occurred.
Use the operation and context actually supplied by the engine; this Playbook
does not prescribe its argument schema. Correct a rejected completion in the
same Execution. Do not invent a failure tool, a publication-path declaration,
source-State assignments, or a successful acceptance acknowledgment.

<a id="shape-the-options"></a>
## Shape and Evaluate the Options

Read the cumulative wall and brief captured in the exact bound shape request. If the request carries a
prior option map and preserved non-generative gaps, read and reconcile them as
well; do not drop a gap unless the new state resolves it explicitly. Announce
the change in mental mode: generation is complete for now, and evaluation may
begin. Use only criteria grounded in the purpose, principles, successful
outcome, current reality, and decision requirements.

Write `organized-options.md` containing:

1. `option_map_id`, derived from the bound request’s domain label;
2. every idea ID accounted for as active, combined, deferred, rejected, or
   retained as project support;
3. meaningful themes, components, and subcomponents;
4. coherent alternatives and compatible combinations;
5. dependencies, necessary sequence, milestones, and deliverables;
6. benefits, costs, constraints, risks, and tradeoffs;
7. parked observations applied to the relevant options;
8. factual assumptions and evidence gaps;
9. priorities and reasons tied to the recorded frame;
10. promising options that remain viable; and
11. material gaps that prevent a responsible decision or next-action plan,
    classified as either generative or non-generative.

Do not erase unusual ideas merely because they are difficult to place. Preserve
their IDs and explain their disposition. Do not turn a polished cluster into a
decision before comparing it with the purpose and outcome.

Classify each material gap before routing it. A **generative** gap is an
unexplored part of the possibility space that another perspective could fill.
A **non-generative** gap requires research, evidence, clarification of purpose
or outcome, approval, ownership, access, or another concrete action. Only a
generative gap may trigger another idea wave; preserve every non-generative gap
for `define-next-actions`.

If a real generative gap remains and this request still permits the one targeted
pass, write one or more new `perspective-request-*.md` files. Use new canonical
paths such as `perspective-request-targeted-accessibility.md`. Each contains
the full brief, current wall, current option map, exact missing area, all
non-generative gaps, a bounded idea allowance, result path and generation-only
contract. State that the targeted allowance is now used. Do not write a
next-action request in this branch.

Otherwise, write exactly one uniquely named `next-action-request-*.md`
containing the complete brief, wall, option map, known provenance, every unresolved
gap, decision authority and required handoff. Do not produce new perspective
requests in that branch. A remaining gap becomes a research, clarification,
test, ownership or decision action, not a claim that the gap was solved.

This bounded return is a prompt-level process rule, not a v1 loop primitive or
termination guarantee. The engine may admit work whenever the actual positive
inputs and Task policy permit it; never rely on a visual branch being exclusive.
Ask the engine-provided completion operation to accept this Execution only
after the described work is ready and any required conversation has occurred.
Use the operation and context actually supplied by the engine; this Playbook
does not prescribe its argument schema. Correct a rejected completion in the
same Execution. Do not invent a failure tool, a publication-path declaration,
source-State assignments, or a successful acceptance acknowledgment.

<a id="define-next-actions"></a>
## Define Decisions and Next Actions

Read the brief, wall and organized options captured in the exact bound next-action request. Determine what
can responsibly be concluded under the recorded decision authority.

If the human reserved decision authority, present the viable directions and
tradeoffs and recommend one without labeling it approved. If an internal
decision is authorized, identify the selected direction and the authority that
permits it.

For every independently movable component, identify one concrete next action.
A next action must describe visible, verifiable behavior and begin with a clear
verb. It may be assigned to an agent, a human, or an external dependency. If no
action can be named, move backward in the reasoning: identify whether the
missing work is organization, idea generation, outcome clarification, purpose
clarification, research, or an ownership decision.

Do not execute arbitrary actions, contact people, purchase resources, create
accounts, publish material, or mutate external systems. Those actions require
separate authorization and may be handed to a more specific Playbook.

Write one primary `brainstorm-handoff.md` containing:

- purpose, principles, and observable successful outcome;
- complete idea-wall and state references;
- authorized internal decision, proposed direction, or clearly labeled
  recommendation;
- viable alternatives, deferred ideas, and rejected options with reasons;
- components, dependencies, sequence, milestones, and deliverables;
- one next action for every independently movable component;
- responsible agent, human, or external dependency for each action;
- research, clarification, test, or approval work still required;
- factual uncertainty and known limitations; and
- exact human input already supplied during the Step, when applicable.

The raw idea wall remains project-support material. Ideas are not mislabeled as
actions, and useful material does not disappear merely because it was not
selected.

Present the proposed handoff for review through ordinary conversation. Ask the
human to confirm a reserved decision or request changes, and revise the draft
in this Execution as needed. Preserve the actual response in the handoff;
until it arrives, label the direction proposed rather than approved. The
`human_approval` Boolean is advisory metadata and supplies no engine gate or
approval proof.

Ask the engine-provided completion operation to accept this Execution only
after the described work is ready and any required conversation has occurred.
Use the operation and context actually supplied by the engine; this Playbook
does not prescribe its argument schema. Correct a rejected completion in the
same Execution. Do not invent a failure tool, a publication-path declaration,
source-State assignments, or a successful acceptance acknowledgment.

## Execution and artifact contract

The engine assigns the exact inputs and source States before the Session
starts. Use that assignment; an agent does not select its parents, manufacture
occurrence identifiers, or redefine coverage through Markdown fields. A request's
domain identifiers and descriptive filenames help the agent organize work;
they are not engine keys or filename-based pairing rules.

Each worker writes to its isolated Execution workspace and captured artifact
area. Include the exact bound request/producer references already supplied by
the engine in its result, together with enough copied domain context to make the
result understandable. Do not invent future result identifiers or assume a path
reference in prose creates another formal input binding. If required source
context cannot be identified from the assigned material, report that limitation
and request clarification rather than selecting the newest similar file.

Write all intended result artifacts before requesting completion. The engine
captures actual final material, not an agent's list of alleged publications.
Declared outputs are advisory expectations, not required-output gates or a
capture whitelist. A missing meaningful handoff can leave its consumer with no
work ready even when the producer's completion was accepted. Preserve incomplete
work and report the concrete problem; never pad results or assert coverage just
to advance the process.

Merge agents consider every assigned source, preserve the useful material and
provenance their instructions require, and write one coherent result. Sibling
workspaces are not implicitly unioned. The engine remains responsible for
bindings, finite-set association and acceptance; the agent remains responsible
for content reconciliation and truthful domain records.

An accepted Execution records one result State, which may reuse an existing
material State. Session exit is not accepted completion. Ordinary explicit
Continue, interrupted-work Retry and retained claims follow the accepted
[draft specification](../spec.md); neither is an automatic recovery loop.
Retry requires user direction and restarts from the original captured sources,
not unaccepted edits or a newer assignment. This file adds no arbitrary replay
or rerun-from-history feature. Later meaningful inputs are evaluated under the
Task's current policy; changed-input automatic reruns default off.

The Task owns this one Playbook and all its Executions. The supplied limits are
portable suggestions for admitting new Executions. They do not impose an individual
Session timeout, cancel work already executing, reserve capacity, or guarantee
a final usage ceiling. The engine has no repository-wide concurrency
cap. Change Task limits explicitly when the intended workload needs more time
or accepted Executions.

Any human approval requested below is an instruction for ordinary conversation.
The optional Boolean is advisory: no candidate freeze, approval-specific state,
engine approval record or publication barrier is implied. Record only actual
human input, and never claim that sealing a State proves approval.

## Conversion assumptions and remaining design work

This draft replaces the historical collection/member-field language with v1
artifact selectors. It preserves all ten default perspectives, lossless raw
capture, one prompt-bounded targeted return, separation of generation from
evaluation, and concrete next actions. Requests/results deliberately carry
coherent context in their own Markdown; this is an authoring choice, not a new
engine serialization or foreign-key mechanism.

G1 must still define which accepted contribution histories cover one finite
request cohort, including repeated batches and identical material. In
particular, Harvest must not mix initial, shared and targeted batches or treat
inherited results as fresh coverage. The `complete:` selector states the
intended dependency; domain labels cannot implement that guarantee. G2/G3 must
still provide consistent capture and the actual completion interface. This
document does not choose those unresolved mechanisms or assume historical
Replay has been approved.

The engine does not enforce idea counts, no-judgment behavior, domain routing
or the original prompt-level one-targeted-return rule. Preserve meaningful
workload requirements and use explicit Task budget overrides when needed.

Verify one ordinary seven-plus-three execution, reversed sibling completion
order, one targeted return, an honest empty contribution, an omitted output,
a failed worker, and repeated batches without cross-batch joins once the engine
exists. These are proposed checks, not completed validation or a claim that the
Playbook is installed.

## Methodological basis

The design is inspired by David Allen's natural planning model in *Getting
Things Done*. In the supplied source notes, the relevant discussion is
concentrated in Chapter 3: purpose and principles, outcome vision,
brainstorming, organization, and next actions (printed pages 54--80). The
explicit brainstorming guidance appears on printed pages 70--74, organization
on pages 74--75, and next actions on pages 75--77.

Additional supplied notes motivate keeping the full idea wall as project
support material and separating it from actions (printed pages 159--163), using
visible capture as shared working memory (printed pages 215--218), and closing
discussion with clear action or responsibility (printed pages 236 and
244--246).

This is an adaptation, not a claim that Allen specified multi-agent execution
or validated these model assignments. His method supplies the separation and
ordering of cognitive modes. The Playbook's blind fan-out, named perspectives,
shared-wall wave, captured provenance, and targeted return are authoring choices for this draft.

These references and page descriptions are preserved from the supplied sketch;
this conversion did not independently recheck the book or source notes.
