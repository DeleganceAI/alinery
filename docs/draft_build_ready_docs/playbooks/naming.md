---
schema: alinery.playbook/v1
playbook:
  id: systematic-naming
  description: Frame a naming brief, generate and analyze complete candidate batches, compare
    survivors, research a human-chosen shortlist, and record an explicit naming decision with
    evidence.
  budget_defaults:
    max_step_executions: 50
    max_wall_clock_seconds: 15000
steps:
- id: frame-naming-brief
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - ticket.md
  outputs:
  - naming-brief.md
  - generation-plan-request-*.md
- id: plan-generation-wave
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - generation-plan-request-*.md
  outputs:
  - generation-plan.md
  - generation-request-*.md
  - finalist-review-request-*.md
- id: generate-name-batch
  harness: omp
  model: gpt-5.6-luna
  settings:
    reasoning_effort: medium
  inputs:
  - generation-request-*.md
  outputs:
  - raw-name-batch-*.md
- id: analyze-name-batch
  harness: omp
  model: gpt-5.6-luna
  settings:
    reasoning_effort: high
  inputs:
  - raw-name-batch-*.md
  outputs:
  - analyzed-name-batch-*.md
- id: assemble-candidate-universe
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - complete: analyzed-name-batch-*.md
  outputs:
  - candidate-universe.md
  - ranking-request-*.md
  - finalist-review-request-*.md
- id: rank-name-group
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - ranking-request-*.md
  outputs:
  - group-ranking-result-*.md
- id: resolve-ranking-wave
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - complete: group-ranking-result-*.md
  outputs:
  - ranking-wave-summary.md
  - ranking-request-*.md
  - finalist-review-request-*.md
- id: review-finalists-with-human
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - finalist-review-request-*.md
  outputs:
  - finalist-review-decision.md
  - approved-shortlist.md
  - naming-brief.md
  - generation-plan-request-*.md
  - diligence-request-*.md
  - naming-closed.md
  completion:
    human_approval: true
- id: research-one-finalist
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - diligence-request-*.md
  outputs:
  - diligence-report-*.md
- id: decide-name-with-human
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - complete: diligence-report-*.md
  outputs:
  - naming-decision.md
  - selected-name.md
  - naming-closed.md
  - generation-plan-request-*.md
  completion:
    human_approval: true
---

# Systematic Naming

This is a draft v1 Playbook for naming a company, product, feature, project,
protocol, campaign, or other durable thing. It turns naming from one large
brainstorm into an inspectable funnel:

1. turn the task's naming intent into an execution-ready brief;
2. generate 200 candidates by default through deliberately different creative
   lanes;
3. analyze every generated candidate and preserve every rejection reason;
4. reduce the pool through bounded comparison rounds;
5. let the human choose the names worth researching;
6. perform dated, source-backed diligence on each finalist; and
7. record the human's decision, its evidence, its limitations, and fallback
   choices.

The Playbook does not assume that a model can identify one objectively best
name. Naming combines strategy, language, taste, market context, operational
constraints, and legal judgment. Agents expand the search space, keep the
evidence organized, and make tradeoffs visible. The human remains the decision
maker.

This is not a trademark-clearance service. Preliminary searches can identify
conflicts and uncertainty, but silence in a search does not prove that a name
is available, registrable, culturally safe, or legally safe to use.

## Process and defaults

```text
ticket.md → Frame → generation-plan-request-*.md → Plan
  → generation-request-*.md → Generate each batch → raw-name-batch-*.md
  → Analyze each batch → analyzed-name-batch-*.md
  → complete: analyzed-name-batch-*.md → Assemble the candidate universe
      → ranking-request-*.md → Rank each group → group-ranking-result-*.md
      → complete: group-ranking-result-*.md → Resolve the ranking batch
          → another finite ranking batch, OR a finalist-review request
      OR
      → finalist-review-request-*.md → Review with the human
          → a new generation-plan request, OR naming-closed.md,
          OR diligence-request-*.md → Research each finalist
             → complete: diligence-report-*.md → Decide with the human
                 → selected-name.md, naming-closed.md, OR a new plan request
```

A producer writes a finite set of meaningful requests before asking for
completion. Each worker has one ordinary wildcard input. Complete-result joins
express the required accepted coverage; they do not pair files by suffix or
interpret request-body fields as runtime expressions. A zero target or an empty
survivor set produces a positive human-review request rather than an empty join.

Task admission suggestions are declared in the frontmatter. The default workload
is **200 raw candidates**, starting with **four generation lanes of 50 names**.
Use 20–40 names per ranking group, a human review set of no more than 30, and
five to ten diligence finalists when enough candidates survive. Four lanes is an
adjustable authoring suggestion, not a fixed engine rule or four new Steps.
The planning Step chooses distinct creative briefs and records the exact batch
counts; their targets must sum to the requested total. A user may request a
different scale. Preserve that target and request an explicit Task budget
override when necessary; do not silently shrink it, claim the full pool was
analyzed when a limit stopped work, or discard unfinished coverage to fit a
suggestion.

Later human-requested generation and substantive ranking requests use new
meaningful input artifacts, subject to Task policy and admission. They do not
invoke a historical replay operation or overwrite a prior accepted State.

## What “analyze every name” means

Every name generated by `generate-name-batch` must appear in the corresponding
`analyze-name-batch` result. That result records a structured analysis and an
explicit disposition for every row. A weak candidate may be rejected, but it
may not silently disappear.

The Playbook does not start one Session per raw name. A generation request
contains 50 names at the default scale, and one analysis Execution evaluates
that bounded batch. This provides local comparison, keeps context bounded,
and avoids creating a separate Session for every name. Later ranking Steps
operate on bounded groups of survivors. The complete candidate universe remains
available for audit and human restoration.

## Model recommendations

The model settings in the source are initial operational defaults, not claims
that these models have been benchmarked for naming quality.

- Use `gpt-5.6-sol` with high reasoning for the brief, portfolio design,
  cross-batch deduplication, comparative reduction, external diligence, and
  human-facing decisions. Those Steps require consistent judgment across many
  constraints and careful handling of uncertainty.
- Use `gpt-5.6-luna` with medium reasoning for independent high-volume
  generation. Diversity comes primarily from the explicit lane briefs, not
  from repeatedly asking one Session to “be creative”.
- Use `gpt-5.6-luna` with high reasoning for first-pass batch analysis. It must
  account for every row and follow a strict output schema.
- Before a large campaign, pilot several generation and analysis batches. Have the
  human inspect them and have `gpt-5.6-sol` re-evaluate a sample. Use the
  stronger model for all Steps if the cheaper model misses constraints,
  invents etymologies, collapses candidate diversity, or produces unstable
  dispositions.

Model substitution changes capacity and cost, not the Step contracts. Each
request carries its relevant domain brief and output guidance; the engine
supplies the actual assignment and completion context. Model names here are
author suggestions whose availability must be checked when launching.

## Human, agent, and specialist responsibility

The agent may generate candidates, organize provenance, apply the brief-defined
rubric, run authorized searches, identify possible conflicts, and explain
tradeoffs. It must distinguish direct observations, hypotheses, external
facts, and unknowns.

The human must decide which candidates deserve diligence, decide whether the
evidence is sufficient for the intended risk level, and approve the final
name. For an externally launched or legally consequential name, the human
should obtain qualified trademark advice in the relevant jurisdictions and
native-speaker or cultural review in material markets. The Playbook can
organize those reports, but an agent Session is not a substitute for
accountable professional judgment.

Domain purchase, trademark filing, handle claiming, package registration, and
public announcement are external mutations. They are outside this Playbook.
The final artifacts may recommend them as next actions, but no Step may perform
them without separate, explicit human authorization.

<a id="frame-naming-brief"></a>
## Frame the Naming Brief

Read `ticket.md`. Begin by determining what is actually being named and
how consequential the choice is. Produce an execution-ready brief from the
task input without pausing for human approval. Make conservative defaults where
safe, label assumptions, and preserve unresolved decisions instead of guessing
that they are settled.

Write `naming-brief.md` with:

1. **Naming object:** what is being named, its category, its maturity, and
   whether this is a company, master brand, product, feature, internal project,
   protocol, campaign, or another kind of name.
2. **Audience and job:** who must understand or remember it, what action it
   should help them take, and the context in which they will first encounter
   it.
3. **Positioning:** the promise, differentiators, desired associations, and
   ideas the name may imply without overpromising.
4. **Architecture:** its relationship to parent brands, sibling names, future
   products, editions, APIs, commands, URLs, or other naming systems.
5. **Voice:** desired tone, energy, familiarity, seriousness, emotional range,
   and examples the human likes or dislikes with reasons rather than imitation
   instructions.
6. **Markets and language:** launch markets, material languages and scripts,
   acceptable pronunciation variation, and any native-speaker review that the
   human requires.
7. **Hard constraints:** required or forbidden words, length, syllables,
   initials, spelling, punctuation, script, morphology, technical syntax,
   accessibility, and existing organizational policies.
8. **Operational checks:** desired domains, package registries, application
   stores, social handles, code identifiers, or search-result behavior. Mark
   each as required, preferred, or irrelevant.
9. **Legal search scope:** intended goods and services, planned territories,
   known competitors, and the jurisdictions or classes a qualified reviewer
   may need to examine. Do not guess that an informal class label is legally
   complete.
10. **Evaluation lenses:** the dimensions that matter, any fatal gate, how
    uncertainty is represented, and which tradeoffs require human judgment.
11. **Scale and funnel:** target raw-candidate count, batch size, within-batch
    survivor guidance, human-review ceiling, finalist count, budget, and any
    stopping condition.
12. **Authority:** who is accountable for the final name and which outside
    legal, linguistic, security, accessibility, or audience evidence is
    mandatory before selection.

Keep hard gates separate from preferences. A weighted score must never average
away a prohibited meaning, known conflict, invalid technical form, or other
fatal condition. Conversely, do not turn a subjective preference into a false
objective gate.

Write one uniquely named `generation-plan-request-*.md`, such as
`generation-plan-request-initial.md`. Include the complete brief, requested
raw-name count, batch/ranking/finalist guidance, desired novelty, known failure
modes, and Task-limit expectations. Mark whether prior campaign material was
explicitly supplied at Task creation; include that complete ledger and its
known source references when present, otherwise say there is no prior ledger.
Do not search unrelated Tasks or arbitrarily replay a historical State.

This is a self-contained planning handoff, not a typed collection member.
Use ordinary domain labels and canonical paths; do not manufacture occurrence
or fulfillment identifiers for these new artifacts.

Ask the engine-provided completion operation to accept this Execution only
after the described work is ready and any required conversation has occurred.
Use the operation and context actually supplied by the engine; this Playbook
does not prescribe its argument schema. Correct a rejected completion in the
same Execution. Do not invent a failure tool, a publication-path declaration,
source-State assignments, or a successful acceptance acknowledgment.

<a id="plan-generation-wave"></a>
## Plan One Generation Wave

Read the exact bound plan request and its captured naming brief and prior ledger. Design a portfolio of
independent generation lanes whose combined target meets the requested scale.
For the default 200-name campaign, start with four requests of 50 names each.
Adapt the number and size of requests to the naming brief and model context,
keeping the sum of their targets equal to the requested total.
Preserve the user-selected target and surface when it needs an explicit Task
budget override rather than silently reducing the work.

Use a purposeful mixture of dimensions rather than many copies of the same
generic brainstorm:

- semantic territory or benefit;
- construction method, such as real word, suggestive phrase, compound, blend,
  clipped form, affixed form, metaphor, arbitrary word, or invented word;
- phonetic profile, rhythm, stress, syllable count, and sound family;
- spelling and visual shape;
- degree of immediate meaning versus abstraction;
- tone and audience perspective;
- length or structural band; and
- a bounded wildcard lane that deliberately challenges the brief without
  violating its hard constraints.

These dimensions guide coverage; do not mechanically generate their full
Cartesian product. Each request should have a distinct purpose and enough room
for variation. Avoid asking every lane for “short, modern, memorable” names
with different labels.

Write `generation-plan.md` explaining:

- the portfolio and why its lanes are meaningfully different;
- the exact number of requests and total requested candidates;
- how the plan covers the recorded semantic and structural space;
- how obvious duplication between lanes will be limited without sharing their
  unpublished results;
- what would count as a shortfall; and
- how the results will be analyzed and merged.

For a positive target, write one `generation-request-*.md` per lane using
unique canonical paths, for example `generation-request-initial-metaphor.md`.
Every request contains the complete relevant brief and rubric, domain campaign
and batch labels, exact target count, lane purpose/exclusions, semantic and
construction guidance, record schema, and generation-only restrictions. Carry
the explicitly supplied prior candidate ledger and known references forward so
later assembly can preserve it; do not resolve a bare path against a newer State.
Name a unique `raw-name-batch-*.md` and `analyzed-name-batch-*.md` output path
as ordinary content for the responsible agents.

Create the whole intended nonempty request set before completion. Do not also
create a finalist-review request for this positive-target branch.

If the requested target is zero, write `generation-plan.md` and exactly one
`finalist-review-request-*.md` containing the full brief, plan, prior ledger
when supplied, an explicit empty candidate set, and the reason no generation
was requested. Ask the human to revise the target or close the campaign. Write
no generation request, no empty result placeholder and no empty-set merge.
The unused advisory output selector does not invalidate otherwise accepted work.

Ask the engine-provided completion operation to accept this Execution only
after the described work is ready and any required conversation has occurred.
Use the operation and context actually supplied by the engine; this Playbook
does not prescribe its argument schema. Correct a rejected completion in the
same Execution. Do not invent a failure tool, a publication-path declaration,
source-State assignments, or a successful acceptance acknowledgment.

<a id="generate-name-batch"></a>
## Generate One Name Batch

Work from the exact bound generation request and its captured naming brief. Do not
read unpublished sibling batches. Produce the requested number of genuinely
distinct candidates for this lane.

For every candidate record:

- assign a request-scoped `raw_candidate_id`;
- preserve the proposed spelling exactly;
- give a tentative pronunciation, clearly labeled as a hypothesis;
- record the construction method and generation lane;
- record source words, morphemes, metaphors, or transformations only when
  actually known;
- explain the intended association in one concise paragraph;
- note any immediate ambiguity or concern; and
- preserve enough provenance to reconstruct why this candidate exists.

Do not invent an etymology and present it as fact. Do not silently remove names
because they feel weak; generation breadth is the purpose of this Step. If a
proposal directly violates a hard constraint, retain it as an ordinary
candidate row and flag the exact constraint for the analysis Step. If the lane
cannot reach its target without padding or violating the request, report an
honest shortfall.

Do not search trademarks, domains, handles, packages, or the web unless the
request explicitly says that a particular collision is a hard generation-time
constraint. Never describe a generated name as unused, original, available,
registrable, clear, or safe.

Write the `raw-name-batch-*.md` result path specified in the bound request. Report requested
count, delivered count, exclusions, duplication within the batch, uncertainty,
and any shortfall. The result must retain all candidate rows, the complete brief/rubric and prior
ledger context from the request, the intended analysis path, and the actual
input/Execution references supplied by the engine. That domain record is not
an engine fulfillment declaration.

Ask the engine-provided completion operation to accept this Execution only
after the described work is ready and any required conversation has occurred.
Use the operation and context actually supplied by the engine; this Playbook
does not prescribe its argument schema. Correct a rejected completion in the
same Execution. Do not invent a failure tool, a publication-path declaration,
source-State assignments, or a successful acceptance acknowledgment.

<a id="analyze-name-batch"></a>
## Analyze Every Name in One Batch

Read the exact bound raw batch, including its captured naming brief and rubric. Account for every
`raw_candidate_id`. The output row count, including explicit rejections, must
match the raw batch row count.

For each candidate, record:

1. exact proposed spelling and tentative pronunciation;
2. generation provenance and intended association;
3. hard-constraint result, with exact violated rule when applicable;
4. strategic and category fit;
5. clarity, ambiguity, and likely first interpretation;
6. pronunciation, spelling, dictation, and recall hypotheses;
7. tone and fit with the desired voice;
8. extensibility within the declared name architecture;
9. likely misreadings, unwanted associations, and relevant language questions;
10. distinctiveness and confusion hypotheses, explicitly not a legal result;
11. whether its immediate suggestiveness helps the current promise but may
    constrain future positioning;
12. confidence and facts that still require external verification; and
13. `continue`, `hold`, or `reject`, with a concise primary reason.

Use ratings only when the naming brief defines their anchors. Keep every
dimension visible; do not use an opaque composite score as the sole selection
rule. Sound, shape, suggestiveness, memorability, and consumer interpretation
are hypotheses to test with relevant people, not universal properties that the
model can certify.

Do not perform comprehensive external diligence here. The purpose is to give
every generated name a consistent first analysis at bounded context and cost. Preserve rejected rows so the human can inspect or
restore them and so a later wave does not unknowingly regenerate the same idea.

Write the `analyzed-name-batch-*.md` path specified in the bound batch. Include a batch
summary, a full candidate ledger, proposed survivors, holds, rejections, and
counts that reconcile to the raw batch. Carry forward the raw batch's complete brief, prior-ledger context and known
request/Execution references. The engine must derive accepted coverage through
the actual generation→analysis history; a filename or prose assertion does not
establish that relation.

Ask the engine-provided completion operation to accept this Execution only
after the described work is ready and any required conversation has occurred.
Use the operation and context actually supplied by the engine; this Playbook
does not prescribe its argument schema. Correct a rejected completion in the
same Execution. Do not invent a failure tool, a publication-path declaration,
source-State assignments, or a successful acceptance acknowledgment.

<a id="assemble-candidate-universe"></a>
## Assemble the Complete Candidate Universe

Use the complete analyzed-result set and source States assigned by the engine.
The intended dependency covers every generation request through its accepted
raw-batch and analysis descendants. Do not choose alternative parents, infer
that a batch is complete from a count, or assemble knowingly partial coverage.
Check that the supplied campaign/batch context is coherent; a mismatched binding
is a problem to surface, not permission to join unrelated campaigns.

Create `candidate-universe.md` as the cumulative domain ledger. Reconcile the
exact prior ledger carried with the assigned results, if one was explicitly
supplied; otherwise begin with the present batch. Never search history for the
newest file with that name. Keep old dispositions and provenance while adding
the complete new results:

1. include every generated candidate and its analysis disposition;
2. retain raw spelling and all request, lane, and state provenance;
3. assign a pool-scoped stable `candidate_id`;
4. add Unicode NFC and case-folded matching fields without replacing the raw
   spelling;
5. merge only exact canonical duplicates automatically;
6. cluster similar spellings, pronunciations, meanings, and respellings into
   candidate families without deleting the variants;
7. preserve the member provenance and analysis of every merged occurrence;
8. reconcile all counts to every input batch; and
9. retain a searchable rejection ledger with reasons.

Unicode confusable skeletons, when computed, are a separate security-analysis
field. They are not display normalization and must not replace the proposed
name. Do not blanket-reject legitimate non-ASCII names; flag script and
confusability questions for the markets and technical systems in the brief.

Select the candidates that remain eligible under the brief's gates and rubric.
Preserve diversity across semantic territories and construction
families rather than taking only the highest averages from the dominant lane.
Explain every cross-batch decision and make it possible for the human to trace
or restore a candidate.

If the eligible set fits the brief's human-review ceiling, write one uniquely
named `finalist-review-request-*.md` containing the complete brief, candidate
ledger, exact surviving records, disposition history, unresolved gaps and allowed
human outcomes. An empty set is still a meaningful review request: it asks
whether to revise, expand or close. Do not create ranking requests in this branch.

If too many remain, write a finite nonempty set of `ranking-request-*.md`
files, normally with 20–40 candidates each. Include each group's full candidate
records, full brief/rubric, parent candidate ledger, comparison purpose, survivor
guidance, group-balancing context and unique `group-ranking-result-*.md` path.
Use new canonical domain labels for subsequent rounds. Do not write a review
request in the same branch. Do not assume the engine enforces this mutually
exclusive authoring rule if both positive handoffs are actually written.

Ask the engine-provided completion operation to accept this Execution only
after the described work is ready and any required conversation has occurred.
Use the operation and context actually supplied by the engine; this Playbook
does not prescribe its argument schema. Correct a rejected completion in the
same Execution. Do not invent a failure tool, a publication-path declaration,
source-State assignments, or a successful acceptance acknowledgment.

<a id="rank-name-group"></a>
## Compare and Rank One Name Group

Read the exact bound ranking request and the candidate records, brief and rubric captured in it.
Compare this bounded set explicitly. Do not assume that a model's first ordinal
list is an objective truth.

For every candidate:

- preserve `candidate_id` and family membership;
- summarize its strongest case and most important weakness;
- compare it with the other names in the group on each defined lens;
- apply hard gates separately from preferences;
- identify tradeoffs and uncertainty;
- mark it `advance`, `hold`, or `do not advance`; and
- give a reason specific enough for a human to challenge later.

Honor the group's survivor guidance while retaining justified exceptions and
diversity. Do not eliminate all candidates from an unusual but promising lane
merely because a more familiar family dominates the group. Do not conduct or
claim legal clearance.

Write the `group-ranking-result-*.md` path specified in the bound request. Include the complete
input set, complete dispositions, advancing set, counts, decision rationale,
and unresolved questions. Carry forward the parent candidate ledger, full brief/rubric, round context
and actual assigned request/Execution references. The engine owns the accepted
association; the result's domain labels do not create it.

Ask the engine-provided completion operation to accept this Execution only
after the described work is ready and any required conversation has occurred.
Use the operation and context actually supplied by the engine; this Playbook
does not prescribe its argument schema. Correct a rejected completion in the
same Execution. Do not invent a failure tool, a publication-path declaration,
source-State assignments, or a successful acceptance acknowledgment.

<a id="resolve-ranking-wave"></a>
## Resolve One Complete Ranking Wave

Use the complete group-ranking results and source States assigned by the
engine for this exact finite ranking request set. Reconcile the shared brief,
parent ledger and round context in those results; never silently join results
from different rounds or choose replacement parents. Write
`ranking-wave-summary.md` with the complete dispositions and sources.

Reconcile survivors across groups, preserve candidate IDs and family
provenance, and check for group-specific ranking artifacts. Keep hard failures,
preferences and uncertainty separate. Record every advancing and eliminated
candidate with its latest reason. Preserve the full candidate ledger, not just
the survivors, including candidates carried from an earlier generation batch.

If too many candidates remain, partition the survivors into another finite
nonempty set of `ranking-request-*.md` files. Include the complete relevant
brief, candidate records, parent ledger and current summary in each request,
with new meaningful domain labels and result paths. Explain the further
comparison required; do not rewrite timestamps or labels solely to manufacture
fresh work. Write no finalist-review request in that branch.

If the set fits the human-review ceiling, write one new
`finalist-review-request-*.md` containing the exact survivor records, complete
ledger, brief, ranking history, gaps and allowed human outcomes. An empty set
asks the human to revise, expand or close and requires no empty join. Create no
new ranking request in this branch. Relevant Task limits may stop new work;
preserve the partial funnel honestly rather than force a narrower result.

Ask the engine-provided completion operation to accept this Execution only
after the described work is ready and any required conversation has occurred.
Use the operation and context actually supplied by the engine; this Playbook
does not prescribe its argument schema. Correct a rejected completion in the
same Execution. Do not invent a failure tool, a publication-path declaration,
source-State assignments, or a successful acceptance acknowledgment.

<a id="review-finalists-with-human"></a>
## Review Finalists with the Human

Prepare a complete proposed finalist disposition for human review. Evaluate the
candidate set captured in the exact bound review request without hiding the complete ledger or reasons. Compare names
in realistic use: spoken introduction, written headline, product UI, command or
URL where relevant, relationship to sibling names, and future extensions.
Identify any previously rejected candidate worth restoring if its recorded
tradeoff appears to have been judged incorrectly.

Do not reduce this to a favorite-name poll. Discuss:

- unaided interpretation;
- pronunciation and spelling after hearing the name;
- delayed recall where the human can run a genuine test;
- source or competitor confusion;
- contextual brand fit rather than isolated aesthetics;
- differences among target audiences and languages; and
- which uncertainties must be researched before commitment.

If the bound request contains an empty candidate set, do not propose shortlist
approval and do not emit a diligence wave. The only valid proposed outcomes are
a new generation-plan request or closure recorded in `naming-closed.md`. This covers both an
explicit zero target and a generation or ranking funnel with no survivors.

If audience or native-speaker testing is required, prepare a neutral protocol
with randomized presentation and separately recorded tasks. Do not invent
participants or results. If required evidence is missing, expose the gap in the
proposed disposition instead of treating it as completed evidence.

Prepare the proposed disposition in `finalist-review-decision.md`, then ask
the human through ordinary conversation which outcome they choose. Revise the
proposal as needed; do not treat a missing response as consent or manufacture
an engine approval record. Record only the response actually received. This
Step's advisory Boolean is not an engine-enforced pause or publication gate.

After an actual decision, write exactly the corresponding next handoff:

1. **Shortlist for diligence.** Write `approved-shortlist.md` describing the
   actual human choice, together with a finite nonempty set of
   `diligence-request-*.md` files. Each request includes the full shortlist and
   review decision, complete relevant brief, candidate spelling/identity and
   history, markets, goods/services, jurisdictions, desired domains/registries,
   authorized sources/tools, required checks, known gaps, and a unique
   `diligence-report-*.md` path. Do not claim that the engine authenticated the
   human decision.
2. **Revise or expand.** Update `naming-brief.md` only when the human changes
   its content. Write one new `generation-plan-request-*.md` carrying the
   chosen full brief, complete previous ledger, requested novelty, candidate
   target, known failure modes, decision context and Task-limit expectations.
   Create no diligence request in this branch.
3. **Close without selection.** Write `naming-closed.md` with the actual
   rationale and remaining evidence. Create no further request artifacts.

Always complete `finalist-review-decision.md` with the proposal, actual human
input, rationale and unresolved evidence. Never emit all alternative handoffs
as placeholders. Existing inherited handoffs are historical material, not
proof that this decision created new work; do not globally delete history or
relabel unchanged artifacts as newly produced.

Ask the engine-provided completion operation to accept this Execution only
after the described work is ready and any required conversation has occurred.
Use the operation and context actually supplied by the engine; this Playbook
does not prescribe its argument schema. Correct a rejected completion in the
same Execution. Do not invent a failure tool, a publication-path declaration,
source-State assignments, or a successful acceptance acknowledgment.

<a id="research-one-finalist"></a>
## Research One Finalist

Perform only the checks authorized by the exact bound diligence request. This
is preliminary conflict and operational research, not legal clearance.

As applicable, examine:

1. exact and similar uses on the open web and in the relevant product category;
2. marks that may be similar in appearance, sound, meaning, or overall
   commercial impression for related actual or planned goods and services;
3. the official national, regional, state, or international trademark sources
   named in the request;
4. business registries and common-law sources required by the jurisdiction;
5. domain registration data through RDAP or the applicable registry and
   registrar;
6. application stores, package registries, social platforms, or code ecosystems
   named in the brief;
7. pronunciation, translation, connotation, and offensive or confusing senses
   in every material language identified by the human;
8. Unicode canonical form, script composition, confusable forms, and, for an
   internationalized domain, both its U-label and A-label plus applicable TLD
   policy; and
9. evidence that still requires qualified counsel, native speakers, security
   review, audience testing, acquisition, or direct platform confirmation.

For every search, record source, jurisdiction, query or search mode, goods and
services or classes, filters, execution date, coverage, direct result links or
identifiers, and limitations. Preserve screenshots or exports only when the
source permits it. Obey site terms, rate limits, authentication boundaries, and
tool policies. In particular, do not automate bulk querying of a database whose
terms prohibit it; mark the check `not checked` and explain what a human must
do.

Use one of these evidence labels:

- `conflict found`;
- `possible conflict — specialist review required`;
- `no conflict found in the specified search as of DATE`;
- `not checked`;
- `source unavailable`; or
- `inconclusive`.

Never write `available`, `registrable`, `trademark-safe`, `globally clear`,
`unused`, or `has no bad meaning`. A free domain or exact-name search miss does
not resolve phonetic, semantic, related-goods, common-law, cultural, or other
rights questions. Registration status can change after the check.

Write the `diligence-report-*.md` path specified in the exact bound request. Separate facts,
interpretations, hypotheses, and unknowns. Include a dated recommendation for
the next human or professional review, but do not choose the name. A report may truthfully contain unknown or unavailable findings after the
authorized checks were attempted; do not fabricate certainty to fill a slot.
Preserve the complete shortlist, brief/review decision and candidate-history
context supplied in the request, and the actual assigned input/Execution
references. A failed Execution supplies no accepted result coverage; a partial
file alone is not completion.

Ask the engine-provided completion operation to accept this Execution only
after the described work is ready and any required conversation has occurred.
Use the operation and context actually supplied by the engine; this Playbook
does not prescribe its argument schema. Correct a rejected completion in the
same Execution. Do not invent a failure tool, a publication-path declaration,
source-State assignments, or a successful acceptance acknowledgment.

<a id="decide-name-with-human"></a>
## Decide the Name with the Human

Use the complete diligence-report set and source States assigned by the engine
for the selected finite shortlist request set. Reconcile their shared shortlist,
brief, review decision and candidate history. Do not choose other reports,
invent coverage, or turn missing data into favorable evidence.

For each finalist, present:

- exact spelling and pronunciation;
- strategic case and important tradeoffs;
- generation and evaluation provenance;
- candidate-family and likely-confusion relationships;
- dated external findings and direct sources;
- domain, registry, language, Unicode, cultural, and operational status;
- mandatory checks that have and have not been completed;
- counsel, native-speaker, audience, or specialist conclusions actually
  supplied by the human; and
- residual uncertainty and time-sensitive rechecks.

Prepare a complete proposed selection, another generation request, or closure
in `naming-decision.md`, following the brief's risk and authority requirements.
If mandatory counsel, language, audience or other evidence is missing, expose
the gap and do not propose selection unless the human explicitly changes that
requirement. Never represent an agent synthesis as legal approval.

Ask the human for the decision in ordinary conversation, discuss the tradeoffs,
and revise the proposal as needed. Preserve only the actual response received;
silence is not approval. Finalize `naming-decision.md` with the exact assigned
evidence references, proposal and actual decision, rejected alternatives and
reasons, open risks, outside reports actually supplied, acquisition status,
limitations and next actions. Advisory approval metadata is not engine proof.

- For an actual selection, write `selected-name.md` with the exact chosen
  spelling, pronunciation, intended use, rationale, agreed alternates and
  recheck requirements. Do not also request another generation batch.
- For another generation batch, write one new `generation-plan-request-*.md`
  containing the full intended brief, prior candidate universe, rejected
  families, requested novelty, new constraints and actual decision context.
  Do not write a new `selected-name.md` for this outcome.
- For closure without a choice, write `naming-closed.md` and no further request.

The Step does not register, buy, file, announce or publish a name. A prior
accepted artifact remains historical evidence; do not claim unchanged material
was refreshed by this discussion. Do not invoke arbitrary historical replay.

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

This v1 draft retains all ten authored Steps, independent creative lanes,
row-complete analysis, lossless candidate provenance, bounded comparison groups,
human shortlist/final decisions, and dated evidence with explicit uncertainty.
The former typed member fields are ordinary domain content in self-contained
request/result artifacts. This avoids pretending that a body field establishes
an engine-resolved dependency or that two wildcard filenames form a join.

G1 must still define generation-request→raw-batch→analysis coverage, grouping
of repeated ranking rounds, and the exact diligence cohort, including how
multiple valid accepted results or identical material are handled. The
`complete:` selectors express intended result lanes; this document does not
invent the engine association protocol. A human-facing summary must not start
with unrelated or partial results merely because filenames match. G2/G3 still
owe consistent capture and the actual completion interface. Broader manual replay
is excluded from v1 under [C17](../spec.md#c17-no-broader-manual-replay-in-v1).

Keeping every raw name in a ledger is a prompt/content requirement, not a new
semantic engine validator. The default 200-name workload replaces the original
large pilot; larger user-selected campaigns may need an explicit Task budget
override. Batch and round labels are domain data, not immutable occurrence
identifiers or a new runtime counter.

After the unresolved engine contracts exist, verify reversed worker completion
order; complete two-stage generation/analysis coverage; repeated ranking rounds;
an empty target and empty survivor pool; unavailable diligence evidence; a
failed worker; actual human revision/closure; and Task-limit exhaustion without
lost candidate records. These checks have not been performed by this conversion.

## Methodological basis and starting references

There is no single authoritative standard for naming equivalent to a reporting
standard such as PRISMA. This Playbook combines an observed professional naming
funnel, experimental findings that provide testable linguistic hypotheses, and
official sources that define important trademark, domain, and Unicode research
boundaries.

1. **Observed naming process:** Kohli and LaBahn,
   [*Creating Effective Brand Names: A Study of the Naming Process*](https://doi.org/10.1080/00218499.1997.12466653).
   The study describes an objectives, generation, evaluation, selection, and
   registration funnel and reports criteria including relevance, connotation,
   recognition or recall, distinctiveness, pronunciation, image fit, and
   negative meanings. It is an older, self-reported industry study, not proof
   that one process is universally optimal.

2. **Trademark strength spectrum:** the USPTO,
   [*Strong trademarks*](https://www.uspto.gov/trademarks/basics/strong-trademarks).
   Fanciful, arbitrary, and suggestive marks are generally stronger than
   descriptive or generic terms. Treat the spectrum as a legal-strategy flag,
   not a registrability verdict or universal measure of marketing quality.

3. **Similarity and related goods:** the USPTO,
   [*Likelihood of confusion*](https://www.uspto.gov/trademarks/search/likelihood-confusion).
   Marks need not be identical: appearance, sound, meaning, commercial
   impression, and the relationship between goods or services all matter.
   This is why the Playbook clusters variants and never treats a respelling as
   a clean new legal option.

4. **Search scope:** the USPTO,
   [*Why search for similar trademarks?*](https://www.uspto.gov/trademarks/basics/why-search-similar-trademarks)
   and [*Comprehensive clearance search for similar trademarks*](https://www.uspto.gov/trademarks/search/comprehensive-clearance-search-similar-trademarks).
   A comprehensive US search goes beyond exact federal registrations to state,
   business, domain, international, and Internet or common-law sources, and
   experienced counsel may be needed to interpret the results.

5. **International search limitations:** WIPO's
   [*Global Brand Database*](https://www.wipo.int/en/web/global-brand-database),
   [user guide](https://www.wipo.int/documents/d/global-brand-database/docs-en-user-guide.pdf?download=true),
   and [terms](https://www.wipo.int/en/web/global-brand-database/terms_and_conditions).
   The database supports multiple query modes and useful jurisdiction and
   goods or service filters, but it is not a complete, real-time statement of
   every right worldwide. Its terms and source limitations must govern tool
   use.

6. **European availability search:** EUIPO,
   [*Availability*](https://www.euipo.europa.eu/en/trade-marks/before-applying/availability).
   Searching can reduce conflict risk but does not eliminate it; territory,
   sign, and goods or services remain relevant.

7. **Domain registration snapshots:** ICANN's
   [*Registration Data Lookup FAQ*](https://lookup.icann.org/en/faq),
   [RDAP information](https://www.icann.org/rdap/), and
   [domain-registration guidance](https://www.icann.org/resources/pages/register-domain-name-2017-06-20-en).
   RDAP exposes current registration data. It does not guarantee acquisition,
   technical eligibility under a particular registry, or trademark safety.

8. **Unicode security and internationalized domains:** Unicode
   [UTS #39](https://www.unicode.org/reports/tr39/) and
   [UTS #46](https://www.unicode.org/reports/tr46/).
   These define mechanisms for restricted and confusable identifiers and IDNA
   processing. Confusable detection is a review aid, not a user-facing
   normalization rule or a reason to reject legitimate local-script names.

9. **Sound symbolism:** Klink,
   [*Creating Brand Names With Meaning: The Use of Sound Symbolism*](https://doi.org/10.1023/A:1008184423824),
   and Shrum et al.,
   [*Sound symbolism effects across languages*](https://doi.org/10.1016/j.ijresmar.2012.03.002).
   Their experiments motivate phonetic generation and testing lenses. Their
   findings do not establish what every language community or buyer will infer.

10. **Suggestiveness and recall:** Keller, Heckler, and Houston,
    [*The Effects of Brand Name Suggestiveness on Advertising Recall*](https://doi.org/10.1177/002224299806200105).
    Suggestive names can help recall congruent benefits while hurting recall of
    unrelated claims. The Playbook therefore records suggestiveness as a
    tradeoff rather than an always-better score.

11. **Multiple evaluation dimensions:** Bao, Shao, and Rivers,
    [*Creating New Brand Names: Effects of Relevance, Connotation, and
    Pronunciation*](https://doi.org/10.2501/S002184990808015X).
    These dimensions can affect preference, but preference remains distinct
    from memorability, legal distinctiveness, confusion risk, and clearance.

These references and source summaries are preserved from the supplied sketch,
not independently reverified by this format conversion. Every real diligence
Execution must check the current sources, search terms and applicable scope.
