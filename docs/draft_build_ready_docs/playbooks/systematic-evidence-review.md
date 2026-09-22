---
schema: alinery.playbook/v1
playbook:
  id: systematic-evidence-review
  description: Build an auditable corpus of studies through a pre-approved protocol, reproducible
    searches, independent screening, full-text eligibility review, iterative citation searching,
    human corpus approval, structured extraction, protocol-selected appraisal, synthesis,
    and reporting.
  budget_defaults:
    max_step_executions: 115
    max_wall_clock_seconds: 34500
steps:
- id: select-review-method
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - ticket.md
  outputs:
  - review-brief.md
- id: develop-protocol
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - review-brief.md
  outputs:
  - review-protocol.md
  - draft-search-plan.md
  - ai-use-plan.md
- id: validate-and-approve-search
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - review-protocol.md
  - draft-search-plan.md
  - ai-use-plan.md
  outputs:
  - approved-review-protocol.md
  - approved-search-plan.md
  - search-wave.md
  - search-requests/*.md
  completion:
    human_approval: true
- id: run-one-search
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - search-requests/*.md
  outputs:
  - search-results/*.md
- id: merge-search-wave
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - search-wave.md
  - complete: search-results/*.md
  outputs:
  - candidate-wave.md
- id: prepare-screening-wave
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - candidate-wave.md
  - approved-review-protocol.md
  outputs:
  - candidate-ledger.md
  - screening-wave.md
  - candidate-requests/*.md
  - corpus-audit-request.md
- id: screen-title-abstract-a
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - candidate-requests/*.md
  - approved-review-protocol.md
  outputs:
  - title-screen-a/*.md
- id: screen-title-abstract-b
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - candidate-requests/*.md
  - approved-review-protocol.md
  outputs:
  - title-screen-b/*.md
- id: resolve-title-abstract-wave
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - screening-wave.md
  - complete: title-screen-a/*.md
  - complete: title-screen-b/*.md
  outputs:
  - title-abstract-screening-summary.md
  - full-text-wave.md
  - full-text-requests/*.md
  - corpus-audit-request.md
- id: retrieve-full-text
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - full-text-wave.md
  - approved-review-protocol.md
  outputs:
  - packet-wave.md
  - full-text-packets/*.md
- id: screen-full-text-a
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - full-text-packets/*.md
  - approved-review-protocol.md
  outputs:
  - full-text-a/*.md
- id: screen-full-text-b
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - full-text-packets/*.md
  - approved-review-protocol.md
  outputs:
  - full-text-b/*.md
- id: resolve-full-text-wave
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - packet-wave.md
  - complete: full-text-a/*.md
  - complete: full-text-b/*.md
  outputs:
  - eligibility-decisions.md
  - corpus-ledger.md
  - corpus-audit-request.md
  - search-wave.md
  - search-requests/*.md
- id: audit-and-freeze-corpus
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - corpus-audit-request.md
  outputs:
  - corpus-audit.md
  - corpus-ledger.md
  - frozen-corpus.md
  - empty-corpus.md
  - empty-corpus-report-request.md
  - search-wave.md
  - search-requests/*.md
  completion:
    human_approval: true
- id: draft-empty-review
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - empty-corpus-report-request.md
  - empty-corpus.md
  - approved-review-protocol.md
  outputs:
  - review-manuscript.md
  - study-selection-flow.md
  - search-strategy-appendix.md
  - included-studies.md
  - excluded-full-text-studies.md
  - evidence-tables.md
  - protocol-deviations.md
  - ai-use-disclosure.md
  - review-audit-trail.md
- id: prepare-and-pilot-extraction
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - frozen-corpus.md
  - approved-review-protocol.md
  outputs:
  - extraction-plan.md
  - extraction-wave.md
  - extraction-requests/*.md
  completion:
    human_approval: true
- id: extract-and-code-a
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - extraction-requests/*.md
  - extraction-plan.md
  - approved-review-protocol.md
  outputs:
  - extraction-a/*.md
- id: extract-and-code-b
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - extraction-requests/*.md
  - extraction-plan.md
  - approved-review-protocol.md
  outputs:
  - extraction-b/*.md
- id: reconcile-study-evidence
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - extraction-wave.md
  - complete: extraction-a/*.md
  - complete: extraction-b/*.md
  outputs:
  - reconciled-evidence.md
  - study-evidence/*.md
- id: plan-synthesis
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - reconciled-evidence.md
  - frozen-corpus.md
  - approved-review-protocol.md
  outputs:
  - evidence-matrix.md
  - synthesis-plan.md
  - synthesis-wave.md
  - synthesis-requests/*.md
- id: synthesize-unit
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - synthesis-requests/*.md
  - synthesis-plan.md
  - evidence-matrix.md
  - reconciled-evidence.md
  outputs:
  - synthesis-results/*.md
- id: draft-review
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - synthesis-wave.md
  - complete: synthesis-results/*.md
  outputs:
  - review-manuscript.md
  - study-selection-flow.md
  - search-strategy-appendix.md
  - included-studies.md
  - excluded-full-text-studies.md
  - evidence-tables.md
  - protocol-deviations.md
  - ai-use-disclosure.md
  - review-audit-trail.md
- id: publication-audit
  harness: omp
  model: gpt-5.6-sol
  settings:
    reasoning_effort: high
  inputs:
  - review-manuscript.md
  - review-audit-trail.md
  outputs:
  - publication-audit.md
  - publication-ready.md
  - search-wave.md
  - search-requests/*.md
  completion:
    human_approval: true
---

# Systematic Evidence Review

This is a candidate Playbook for producing a rigorous academic review of a
body of literature. Its core is a systematic, reproducible selection process,
not merely writing a narrative survey from papers the author happens to know.

The first Step selects the method because the correct method depends on the
purpose:

- A **systematic review** answers a focused question by critically appraising
  and synthesizing relevant evidence.
- A **scoping review** or **systematic mapping study** maps a broad or emerging
  field, clarifies concepts, classifies the literature, and identifies gaps.
- A conventional **survey paper** does not, by that label alone, promise a
  reproducible search or selection method.

The approved protocol controls the downstream differences. The engine and
graph remain the same; the extraction, appraisal, and synthesis contracts vary
with the selected method.

## Process

```text
ticket.md
      |
      v
Select Method -> Develop Protocol -> Validate Search + Human Approval
                                            |
                   +------------------------+------------------------+
                   |                        |                        |
             Search Source A          Search Source B          Search Source C
                   +------------------------+------------------------+
                                            |
                                Merge + Deduplicate Results
                                            |
                    two mutually concealed title/abstract lanes
                                            |
                               resolve the complete wave
                                            |
                              retrieve candidate full texts
                                            |
                       two mutually concealed full-text lanes
                                            |
                              resolve + update corpus ledger
                                            |
                    +-----------------------+-----------------------+
                    |                                               |
          newly included studies                         no new included studies
                    |                                               |
         protocol-defined citation searches                         |
                    |                                               |
         new candidate wave -> screening loop              Human Corpus Audit
                                                                    |
                                    +-------------------------------+-------------+
                                    |                                             |
                           expected omission                              corpus approved
                         -> new search wave                              -> freeze corpus
                                                                                  |
                                                    +-----------------------------+------------------+
                                                    |                                                |
                                           zero included studies                            nonempty corpus
                                                    |                                                |
                                           draft empty review                    two concealed coding lanes
                                                    |                                                |
                                                    |                                  reconcile study evidence
                                                    |                                                |
                                                    |                          synthesize by question/theme/category
                                                    +-----------------------------+------------------+
                                                                                  |
                                                                       publication audit
                                                                          |             |
                                                                   updated search     ready
                                                                          |
                                                                   screening loop
```

There is no authored loop node, iteration counter, active branch, or cursor.
Each expansion prepares a finite set of material request artifacts. Declared
inputs and complete-result joins express the dependencies; file contents are
scientific handoffs rather than a second orchestration language. Meaningfully
changed inputs can request another pass only under the Task's changed-input
rerun policy, which defaults off. This Playbook does not enable it itself.

## How this refines the initial six-step idea

| Initial idea | Formal treatment in this Playbook |
|---|---|
| Define inclusion/exclusion criteria and search terms | Select the review method, then approve an a priori protocol. Eligibility criteria and search terms are related but are not the same thing. |
| Perform the search | Execute each exact database or source query independently and preserve the query, platform, date, filters, counts, and raw export. |
| Check references from found documents | Apply the protocol's citation-search policy, which may use backward and forward searching, defined seed studies, indexes, iterations, and stopping rules. Every discovered record returns through deduplication and screening; citation does not imply inclusion. |
| Read abstract or conclusion to decide relevance | Treat this as high-recall preliminary screening only. Potential matches proceed to full-text eligibility review. |
| Human checks expected omissions and surprising inclusions | Make this an explicit corpus-audit Step. Expected missing work re-enters the same search and eligibility process rather than being inserted by exception. |
| Start the next phase | Freeze the corpus, pilot the extraction scheme, extract and code each included study, perform any protocol-selected appraisal, synthesize the evidence, and audit the final reporting package. |

## Model recommendations

The unevaluated draft default uses `gpt-5.6-sol` with high reasoning for
every Step. This is an implementation starting point, not evidence that this
model meets any review-method performance threshold. No model is
methodologically preferred until review-specific evaluation demonstrates
acceptable performance for its assigned role.

After a review-specific pilot demonstrates acceptable performance, a Playbook
author may evaluate `gpt-5.6-luna` at medium or high reasoning for a
high-recall title/abstract lane or mechanically bounded reference-enumeration
work. Do not substitute it for full-text eligibility, disagreement resolution,
corpus approval, protocol-selected appraisal, or synthesis without validation.

Two Sessions using the same model are isolated judgments, but they are not two
independent human reviewers and may have correlated errors. A publication-grade
protocol should name accountable human reviewers and specify where each must
independently decide or verify. Provider-diverse models may reduce shared model
failure modes, but they do not replace the human roles required by the selected
method or venue.

These model identifiers are preserved author suggestions, not fresh capability
recommendations or part of the scientific method.
Future revisions should update them without changing the scientific protocol.

## Human and AI responsibility

This is an AI-assisted review Playbook. It must not claim that autonomous
agent decisions are methodologically equivalent to two human reviewers.
Current evidence-synthesis guidance requires human oversight, transparent
reporting of judgment-related AI use, and evidence that automation will not
compromise methodological rigor. Review-specific calibration or validation may
be necessary depending on the tool, task, context, and existing evidence;
human verification alone is not automatically sufficient.

At minimum, the human must approve:

1. the review type, questions, eligibility criteria, and protocol;
2. the search plan and accepted coverage limitations;
3. ambiguous or conflicting eligibility decisions;
4. the frozen corpus and protocol deviations;
5. the extraction/coding scheme;
6. the final synthesis, AI-use disclosure, and publication decision.

Human approval is requested through ordinary conversation before the agent
asks to complete the relevant Step. The metadata is advisory: the engine does
not enforce approval, record an authenticated approver or freeze candidates.
The artifact record may preserve what the human said, without claiming a
trusted approval signature. This list
is an Alinery governance baseline, not proof of compliance with a review method
or venue. The selected protocol may additionally require independent
study-level human screening, extraction, appraisal, or adjudication.

<a id="select-review-method"></a>
## Select Review Method and Frame Questions

Read `ticket.md` as the primary handoff. Determine what kind of evidence
review can answer the intended question. Do not search for papers yet.

Choose and justify one method profile:

- `systematic-review` for a focused evidence question whose included studies
  will be critically appraised and synthesized;
- `scoping-review` for identifying the extent, characteristics, concepts, or
  gaps in a broad or emerging literature;
- `systematic-mapping` for classifying and counting a research area, especially
  in software engineering and computing.

Write `review-brief.md` with:

1. The review's purpose and intended audience.
2. The selected method profile and why it fits better than the alternatives.
3. Precise review questions with stable identifiers.
4. The unit of interest: records, reports, studies, methods, systems, or another
   explicitly defined object.
5. Known domain terminology, adjacent concepts, and likely sources.
6. The kinds of conclusions the review may and may not support.
7. Initial feasibility, access, time, language, and expertise constraints.
8. Assumptions and unresolved choices that the later protocol-validation gate
   must confirm.

Write `review-brief.md`, then request completion through the engine-provided
`complete` operation. Human approval occurs later, once the protocol and search
plan make the consequences of this preliminary method selection concrete.

<a id="develop-protocol"></a>
## Develop Review Protocol

Read `review-brief.md` as the primary handoff. Draft the complete a priori
method before executing the search. Treat the protocol as the scientific
contract for downstream Steps, not as a retrospective description.

Write `review-protocol.md` with:

1. Review type, rationale, objectives, and question identifiers.
2. Operational definitions and the unit of inclusion.
3. Ordered inclusion and exclusion criteria with stable criterion identifiers.
4. Eligible source types, publication types, dates, languages, venues, and
   populations or technical domains.
5. Information sources to search and why each is appropriate.
6. Search-development, peer-review, pilot, and update procedures.
7. Record deduplication and report-to-study reconciliation rules.
8. Title/abstract and full-text decision roles, mutual concealment between
   lanes, disagreement handling, and the treatment of unavailable or ambiguous
   reports.
9. Citation-search policy, including any backward or forward directions,
   indexes, seed rules, iterations, and stopping condition.
10. Corpus audit and protocol-amendment procedures.
11. Structured extraction fields, coding scheme, pilot procedure, duplicate
    extraction policy, and disagreement handling.
12. The exact construct and instrument used for any study-level appraisal---for
    example, risk of bias, methodological quality, or another construct---matched
    to the eligible study designs, or a protocol justification for omitting it.
13. Planned qualitative, quantitative, mapping, or mixed synthesis methods.
14. Protocol registration, publication, or public timestamping plan when
    applicable to the field and review type.
15. Search-refresh and reporting requirements.

Write `draft-search-plan.md` with one database- or source-specific query draft
per planned source, including platform syntax, fields, controlled vocabulary,
free-text synonyms, limits, filters, expected export format, and a known-paper
test set when available.

Write `ai-use-plan.md` with:

1. Every Step in which an AI model may be used.
2. Model, harness, tool, version, date, prompt, and settings to retain.
3. Which outputs require independent review, human verification, or
   review-specific validation.
4. Prospective performance or stopping thresholds if automation is evaluated.
5. Known limitations, privacy or licensing constraints, and fallback behavior.

Do not silently trade methodological rigor for speed. Record any deliberate
shortcut as a protocol limitation.

<a id="validate-and-approve-search"></a>
## Validate and Approve Protocol and Search

Read the three draft artifacts. Self-check the primary search strategy against
the PRESS domains: translation of the question, Boolean and proximity
operators, subject headings, free-text terms, syntax, and limits or filters.
Call this a PRESS peer review only when a suitably qualified librarian,
information specialist, or other independent search peer reviewer completes
and is identified in the recorded PRESS assessment. Translate the candidate
protocol logic into each source's actual syntax rather than assuming identical
queries are correct across platforms.

Where a known-paper set exists, test whether each indexed paper is retrieved.
Investigate misses and revise the strategy when a miss exposes a real query or
scope defect. Also pilot enough results to identify obvious precision,
terminology, access, or export problems. A successful known-paper test improves
confidence; it does not prove that the search is complete.

Prepare a complete candidate protocol, search plan, known limitations, and AI
oversight plan for human review. Write:

- `approved-review-protocol.md`, preserving the full candidate protocol;
- `approved-search-plan.md`, preserving every exact source-specific query and
  validation result;
- one self-contained search request per exact source/query execution; and
- `search-wave.md`, documenting the finite request set and expected candidate
  handoff `candidate-wave.md` for the reviewer. This is useful review data, not
  an engine collection declaration.

Write requests under `search-requests/`, using a canonical filename that
contains the scientific wave and request keys. Each Markdown request contains
the wave identifier, request identifier, source, platform, access route, query
verbatim, date policy, limits, filters, pagination/export procedure, retained
export path, expected result path under `search-results/`, and search type:
initial, backward citation, forward citation, known item, or update. These are
agent-readable domain data; the engine does not evaluate request fields.

Ask the human to approve the protocol, search plan, coverage limitations and
AI oversight plan through ordinary conversation. Address requested revisions
before requesting completion. Prepare the whole nonempty request set in the
writable artifact area before using the engine-provided `complete` operation;
do not submit a publication-path list. The Boolean approval declaration is
advisory, and accepted completion does not authenticate human approval.

<a id="run-one-search"></a>
## Run One Search

Read only the bound search request as the primary handoff. Execute the exact
query against the named source. Do not change the eligibility criteria, repair
the query silently, deduplicate, screen for relevance, or discard results.

Write the exact result artifact supplied by the request with:

1. Request key and producing search-wave identity.
2. Source, database, and platform.
3. Query exactly as executed.
4. Execution date and time zone.
5. Limits, filters, result ordering, pagination, and export settings.
6. Total result count and number successfully preserved.
7. Raw export or snapshot paths and content hashes when practical.
8. Retrieval failures, access restrictions, truncation, and other deviations.
9. For citation searching: seed record, direction, citation index, and every
   discovered record.

If the platform fails, remain incomplete or fail explicitly; do not publish an
apparently complete empty result. A valid zero-result search is publishable
only when the query demonstrably completed and the result record says zero.

<a id="merge-search-wave"></a>
## Merge One Complete Search Wave

This Step requires `search-wave.md` and the complete accepted search-result
set. Read the engine-assigned results and sources; do not select parents after
the fact. Check that the supplied scientific wave identifiers agree with the
assigned request history. Report an inconsistent assignment rather than
combining unrelated waves.

Normalize bibliographic fields without erasing raw values or source provenance.
Separate these concepts:

- duplicate database records for the same report;
- different reports or versions of the same underlying study;
- genuinely different studies with similar titles or authors.

Collapse only confident record duplicates. Group plausible report or version
families for later inspection, and preserve uncertain matches rather than
silently merging them. Write `candidate-wave.md` with every
normalized candidate, all discovery routes, identifiers, version relationships,
and the exact source result from which it came.

Do not make relevance or eligibility decisions in this Step.

<a id="prepare-screening-wave"></a>
## Deduplicate and Prepare One Screening Wave

Read the bound candidate wave and any inherited candidate or corpus ledgers.
Initialize a missing `candidate-ledger.md`; an initial wave need not inherit
one. Use DOI and other stable identifiers first, then bibliographic comparison,
to assign stable semantic record identifiers. Record uncertain duplicate or
report-family judgments for human review. Semantic deduplication is this Step's
responsibility; the engine tracks exact artifact occurrences only.

For every novel candidate that requires screening, write one request under `candidate-requests/`
containing:

1. Stable record identifier and all source locators.
2. Title, abstract, and other preliminary metadata exactly as retrieved.
3. Discovery provenance and possible report-family relationships.
4. Approved protocol revision and criterion identifiers.
5. Separate expected output paths under `title-screen-a/` and
   `title-screen-b/`, using the candidate request filename in each lane.

For a nonempty set, write `screening-wave.md` with the scientific wave identity,
all candidate request paths and expected A/B result paths. Prepare the full
finite candidate set before requesting completion. The two lanes independently
consume those candidate requests; their completeness requirements are declared
on the resolution Step. Their intended concealment is a reviewer obligation
and a source-selection validation case, not an input-based access restriction.

If no novel candidate remains, write `corpus-audit-request.md` with the search
and deduplication findings. Do not create a screening-wave handoff for an empty
set or expect an empty completeness join to execute.

<a id="screen-title-abstract-a"></a>
## Screen One Title and Abstract — Lane A

Read the assigned candidate, approved protocol, and only the title, abstract,
and preliminary metadata supplied for this gate. Do not inspect Lane B's
workspace, output, or any descendant state containing it.

Apply the ordered eligibility criteria conservatively. Return exactly one:

- `include` when the available material plausibly satisfies the criteria;
- `exclude` only when the available material clearly establishes a specific
  exclusion criterion; or
- `uncertain` when full text or human interpretation is needed.

Write the exact result path with the disposition, criterion identifiers,
evidence available at this gate, concise rationale, uncertainties, and lane
or model provenance. Prefer recall over precision: absence of information in an
abstract is not evidence that the full study is ineligible.

<a id="screen-title-abstract-b"></a>
## Screen One Title and Abstract — Lane B

Read the assigned candidate, approved protocol, and only the title, abstract,
and preliminary metadata supplied for this gate. Do not inspect Lane A's
workspace, output, or any descendant state containing it.

Apply the ordered eligibility criteria conservatively. Write exactly one of
`include`, `exclude`, or `uncertain` to the assigned result path. Exclude only
when the available material clearly establishes a specific exclusion criterion;
use `uncertain` when full text or human interpretation is needed. Record the
criterion identifiers, evidence available at this gate, concise rationale,
uncertainties, and lane or model provenance. Prefer recall over precision and
do not attempt to reach agreement inside this Step.

<a id="resolve-title-abstract-wave"></a>
## Resolve One Title and Abstract Screening Wave

Wait for complete results from both lanes for every candidate in the
bound screening wave. Compare the two decisions without erasing either.

Advance a candidate to full-text review when either lane says `include` or
`uncertain`, unless the approved disagreement procedure and accountable human
review establish a clear preliminary exclusion. Record agreed exclusions with
the exact criterion and rationale.

Write `title-abstract-screening-summary.md` with per-candidate decisions and
wave-level counts. For a nonempty advancing set, write one request per
candidate under `full-text-requests/` and one `full-text-wave.md` documenting
the whole set. Each request names the candidate, report family, retrieval
targets, approved protocol, expected packet path under `full-text-packets/`,
A/B paths under `full-text-a/` and `full-text-b/`, and primary exclusion-reason
format. The request contents are scientific handoff data, not engine fields.

If no candidate advances, emit `corpus-audit-request.md` directly rather than
creating an empty full-text join.

<a id="retrieve-full-text"></a>
## Retrieve Full Texts for One Wave

Read the exact `full-text-wave.md` assignment and every request it names.
Retrieve each requested report and prepare the entire finite packet set in
this Execution before completion; write `packet-wave.md` with every request,
packet and expected A/B result path. This batch preparation gives both
full-text screening lanes one common finite source set.

For each request, retrieve the complete available report or reports. Link
multiple reports that may describe the same study, but do not discard secondary
reports; they may contain different methods, outcomes, dates, or corrections.

Write one packet under `full-text-packets/` for each request, including
unavailable reports, with:

1. Record and possible study-family identifiers.
2. Every attempted locator and retrieval result.
3. Retained local paths, canonical URLs, retrieval dates, and content hashes.
4. Version, correction, retraction, supplement, and related-report information.
5. Clear `retrieved`, `partially-retrieved`, or `unavailable` status.
6. Exact expected Lane A/B paths under `full-text-a/` and `full-text-b/`.
7. The source request path and scientific wave/record identifiers for audit.
   These are domain provenance in the packet; they do not replace the
   engine-owned binding or assert an authenticated fulfillment relationship.

An unavailable report is a completed retrieval outcome, not an invented
eligibility decision. Preserve it for `awaiting-classification` or human
follow-up under the protocol.

<a id="screen-full-text-a"></a>
## Screen One Full Text — Lane A

Read the bound packet and all retrieved reports in full. Apply only the approved
eligibility criteria. Do not inspect Lane B's decision.

Write `include`, `exclude`, or `uncertain`. Exclude only when available evidence
establishes a prespecified criterion, and cite its exact document support.
Missing or unavailable reporting alone yields `uncertain` or
`awaiting-classification`, followed by the protocol-defined retrieval or author-
contact procedure. For inclusion, identify the study and all reports that
contribute information. Record unresolved report-family, retraction, access, or
protocol-interpretation issues explicitly.

When the protocol requires an independent human determination for this lane,
the named human must make it without seeing the sibling disposition. When the
protocol instead requires human verification of an AI result, label it as
verification. Post-hoc approval of an AI judgment is not an independent human
eligibility decision.

<a id="screen-full-text-b"></a>
## Screen One Full Text — Lane B

Read the bound packet and every retrieved report in full. Apply only the
approved eligibility criteria, without seeing Lane A's result. Write `include`,
`exclude`, or `uncertain`. Exclude only when available evidence establishes a
prespecified criterion, with exact document support. Treat missing or
unavailable reporting as `uncertain` or `awaiting-classification` and follow the
protocol's retrieval or author-contact procedure. For inclusion, identify the
study and contributing reports. Record report-family, retraction, access, and
interpretation issues explicitly.

When the protocol requires an independent human determination for this lane,
the second named human must make it without seeing Lane A's disposition. When
the protocol requires only verification, label it as verification rather than
an independent eligibility decision.

<a id="resolve-full-text-wave"></a>
## Resolve One Full-Text Eligibility Wave

The declared inputs require `packet-wave.md` and complete Lane A/B accepted
results over its packet set. Read the exact engine-assigned results.
Reconcile every candidate under the protocol's disagreement procedure. Ask the
human when lanes disagree, either lane is uncertain, different report
versions were inspected, or an eligibility criterion needs interpretation.
Do not complete while a required decision remains unresolved.

Write `eligibility-decisions.md` with both original judgments, the resolution,
the accountable decision maker, and the primary reason for every full-text
exclusion. Update `corpus-ledger.md` without deleting earlier dispositions or
provenance.

For each newly included study or other seed covered by the approved
citation-search policy, emit the exact searches that policy requires. The
policy determines seeds, backward and/or forward directions, indexes,
iterations, and stopping rules. Use `search-wave.md` and `search-requests/` under the initial search
request convention. Preserve accumulated corpus/search evidence in the
meaningful handoffs; do not depend on an incidental newer State.

If the policy requires no further citation search, emit
`corpus-audit-request.md` instead. Newly found citations are candidates and
will return through merge, deduplication, and both screening gates.

<a id="audit-and-freeze-corpus"></a>
## Audit and Freeze the Corpus with the Human

Read the audit request and any current corpus ledger, candidate ledger, search
records, eligibility decisions, and protocol deviations. Initialize an empty
corpus ledger when no eligibility wave has yet produced one. Inspect:

1. Expected papers or canonical works that appear to be missing.
2. Surprising inclusions and exclusions.
3. Unresolved, unavailable, retracted, duplicate, or version-linked reports.
4. Coverage across terminology, communities, venues, sources, and years.
5. Whether every seed received the searches required by the approved
   citation-search policy and its stopping rule was satisfied.
6. Whether the observed corpus exposes a defect in the protocol or search.

An expected missing paper may not be inserted directly into the corpus. If the
audit finds missing candidates or requires a targeted updated query, emit a
new `search-wave.md` and a finite set of `search-requests/` under the initial
request convention. Those records traverse the
same deduplication and eligibility process.

A disputed included paper may not be silently deleted. Apply the protocol,
record the correction and any responsible human decision already supplied,
and preserve the prior disposition in `corpus-ledger.md`.

Write `corpus-audit.md` with the checks performed, findings, unresolved issues,
protocol deviations, and a recommendation to freeze the corpus or run another
search wave. When the audit supports freezing, prepare `frozen-corpus.md` with
the exact corpus occurrence, included studies and reports, important
exclusions, unresolved limitations, and protocol amendments. Ask the human
about this disposition in ordinary conversation and record the supplied
decision accurately as review evidence; the engine does not authenticate it.

After the human agrees with freezing a nonempty corpus, write
`frozen-corpus.md` as the extraction handoff. For an agreed zero-study corpus,
write `empty-corpus.md` and `empty-corpus-report-request.md` instead; do not
leave a current `frozen-corpus.md` trigger for that branch. The empty path
produces a report without an empty completeness join.

If further searching is required, prepare the new search handoffs instead of
a frozen-corpus handoff. Address requested revisions before using the
engine-provided `complete` operation. Approval is advisory; there is no engine
approval state or frozen approval candidate.

<a id="draft-empty-review"></a>
## Draft a Review with No Included Studies

Read `empty-corpus-report-request.md`, the approved protocol, `empty-corpus.md`, searches, screening decisions, exclusions, deviations, and AI-use
records. Write the complete reporting package required by this Step. Report
the valid zero-study result without inventing extracted evidence or a
synthesis. Preserve the method, search coverage and limitations, all exclusion
reasons, distinct PRISMA record/report/study counts, protocol deviations, human
approval, and AI-use disclosure. The resulting `review-manuscript.md` and
`review-audit-trail.md` proceed to the ordinary publication audit.

<a id="prepare-and-pilot-extraction"></a>
## Prepare and Pilot the Extraction Scheme

Read the nonempty frozen corpus and approved protocol. Turn the planned
extraction, coding, and any protocol-selected study-level appraisal into an
operational form. Pilot it on a deliberately varied set of included studies,
including difficult edge cases. Resolve what the evidence and protocol support,
and make any remaining ambiguous fields or coding rules explicit for human
review.

Write `extraction-plan.md` with:

1. Every extraction field and its relationship to a review question.
2. Allowed values, definitions, missing-value handling, and coding examples.
3. Report-to-study reconciliation rules.
4. The exact appraisal construct and instrument required by the protocol, or
   an explicit statement that this review profile omits study-level appraisal.
5. Lane independence, human verification, disagreement, and arbitration
   rules.
6. Pilot studies, disagreements observed, and resulting revisions.
7. The synthesis inputs each study record must provide.

For every included study, write one request under `extraction-requests/`
naming all linked reports, expected paths under `extraction-a/`, `extraction-b/`
and `study-evidence/`, and the source corpus identity. Write
`extraction-wave.md` documenting this complete finite study set. These paths
and study identifiers guide reviewers; they are not collection-member fields.

Ask the human to approve the piloted extraction, coding and appraisal scheme.
Address requested revisions in this Execution and prepare all requests before
using the engine-provided `complete` operation. No engine approval barrier is
implied by the advisory Boolean.

<a id="extract-and-code-a"></a>
## Extract and Code One Study — Lane A

Read only the assigned extraction request, linked reports, extraction plan, and
approved protocol. Do not inspect Lane B's output.

Write the exact assigned result with:

1. Study and report identifiers.
2. Every required field, preserving `not reported`, `not applicable`, and
   `unclear` rather than guessing.
3. Exact page, section, table, figure, or appendix support for each material
   extracted value.
4. Directly reported findings separated from reviewer interpretation.
5. When the protocol requires it, judgments for the exact named appraisal
   construct and instrument, with criterion-level support; otherwise, no
   invented appraisal.
6. Conflicts among reports, corrections, missing data, and author-contact needs.
7. Lane, human reviewer when applicable, model, tool, prompt, and
   source-version provenance.

If the protocol requires human extraction or verification, remain incomplete
until the named reviewer has performed it. Post-hoc verification of two AI
outputs does not satisfy a protocol requiring two people to extract critical or
outcome data independently.

<a id="extract-and-code-b"></a>
## Extract and Code One Study — Lane B

Read only the assigned request, linked reports, extraction plan, and approved
protocol, without seeing Lane A's output. Write every required field with
precise source locations; distinguish reported facts from interpretation;
preserve missing, ambiguous, and conflicting information; and apply only the
exact appraisal construct and instrument required by the protocol. Record lane,
human reviewer when applicable, model, tool, prompt, and source-version
provenance. Do not attempt reconciliation inside this Step.

If the protocol requires two people to extract critical or outcome data
independently, this lane must be completed by the second named human without
seeing Lane A's extraction. Post-hoc verification of two AI outputs does not
satisfy that requirement.

<a id="reconcile-study-evidence"></a>
## Reconcile the Complete Study Evidence Set

The declared completeness inputs require both extraction lanes for the same
finite study-request set. Reconcile every study in the assigned
`extraction-wave.md` in this Execution. For each study, merge its two exact
assigned extractions using request provenance and the documented study key;
do not assume that two wildcard expressions pair files. Compare every critical field and
any protocol-required appraisal judgment, preserve both original values, and
apply the approved disagreement process. Ask the human about consequential disagreement,
unresolved ambiguity, or suspected report mismatch.

Write each study-evidence artifact under `study-evidence/` with the reconciled structured data,
any protocol-required appraisal construct and judgments, precise source
locations, unresolved uncertainty, and complete extraction provenance. Do not
manufacture consensus or fill missing data with inference.

Write `reconciled-evidence.md` with the full finite study roster, links and
hashes for every reconciled record, discrepancies resolved and remaining
limitations. This complete handoff is the prerequisite for synthesis planning;
prepare all records before completion. It is not a publication-path list.

<a id="plan-synthesis"></a>
## Plan the Evidence Synthesis

Read the bound `reconciled-evidence.md` and its study records alongside the
nonempty frozen corpus and approved protocol. Check its roster covers every
included study before planning synthesis; report any missing evidence.

Write `evidence-matrix.md` mapping every included study and extracted field to
the review questions. Write `synthesis-plan.md` applying the method already
approved in the protocol:

- For a systematic review, define the eligible evidence for each focused
  synthesis, protocol-selected appraisal treatment, heterogeneity analysis,
  and any quantitative or narrative method. When the review will make effect,
  recommendation, or decision claims, apply the protocol-selected method for
  assessing certainty or confidence across the body of evidence; study-level
  appraisal alone is not a substitute.
- For a scoping review, define how evidence will be charted and mapped without
  implying an appraised causal conclusion the method cannot support.
- For a systematic mapping study, define the classification scheme, counts,
  cross-tabs, visualization, and gap analysis.

Write one request under `synthesis-requests/` for each question, theme or
mapping category with evidence. Each request names the relevant study-evidence
records and its expected path under `synthesis-results/`. These are
agent-readable subsets of the already complete evidence handoff; they do not
ask the engine to evaluate a member-field expression or a subset join.
Record questions with no matching evidence directly in `synthesis-plan.md`.
Ensure at least one synthesis unit addresses the nonempty corpus. Write
`synthesis-wave.md` documenting the complete nonempty request set. Absence of evidence is
not evidence of absence, and counting statistically significant findings is
not a valid meta-analysis.

<a id="synthesize-unit"></a>
## Synthesize One Question, Theme, or Mapping Category

Read the bound synthesis request, synthesis plan, evidence matrix and
reconciled-evidence handoff. Use the specific study records named by the
request; the engine does not interpret those domain references as selectors. Do not add
new sources or silently substitute a different corpus.

Write the assigned synthesis artifact with:

1. The question, theme, or category and included evidence units.
2. Method applied and why it matches the protocol.
3. Agreements, contradictions, heterogeneity, and meaningful absences.
4. How the protocol-selected study-level appraisal construct, when present,
   affects interpretation.
5. The strongest supportable finding, its uncertainty, and any required
   body-of-evidence certainty or confidence judgment.
6. Evidence gaps, limits on generalization, and alternative interpretations.
7. Exact links from every material conclusion to study-evidence records.

Clearly distinguish extracted evidence, synthesis, and author interpretation.

<a id="draft-review"></a>
## Draft the Review and Reporting Package

The declared inputs require `synthesis-wave.md` and its complete accepted
synthesis-result set. Reconcile the engine-assigned results and sources; do
not silently substitute another corpus or choose formal parents afterward.

Write:

- `review-manuscript.md`: complete draft organized for the intended venue;
- `study-selection-flow.md`: distinct counts for records identified,
  deduplicated, and screened; reports sought, not retrieved, and assessed; and
  studies included, without collapsing those units;
- `search-strategy-appendix.md`: every exact search with source, platform, date,
  filters, counts, and citation-search procedure;
- `included-studies.md`: the frozen study/report relationships;
- `excluded-full-text-studies.md`: important exclusions and primary reasons;
- `evidence-tables.md`: extracted and synthesized evidence;
- `protocol-deviations.md`: dated amendments, responsible decision makers, and
  consequences;
- `ai-use-disclosure.md`: model, version, prompt, settings, role, validation,
  human verification, overrides, limitations, and dates for every AI use; and
- `review-audit-trail.md`: exact state, artifact, search, screening, extraction,
  synthesis, and approval provenance needed to reproduce the report.

Use the reporting checklist appropriate to the selected profile: PRISMA 2020
and PRISMA-S for a systematic review, PRISMA-ScR for a scoping review, and the
selected domain guidance for a mapping study. Do not
present reporting-guideline compliance as proof that the review was conducted
correctly.

<a id="publication-audit"></a>
## Publication and Search-Currency Audit

Read the complete draft and audit trail. Check:

1. Compliance with the approved protocol and applicable reporting checklists.
2. Consistency of counts across all flow and corpus artifacts.
3. Traceability of claims to exact synthesis and study-evidence records.
4. Disclosure of AI assistance, human verification, limitations, and protocol
   deviations.
5. Whether the protocol's update-search date or publication timing requires a
   refreshed search.
6. Whether the manuscript is ready for human approval for its stated claims
   and venue.

Write `publication-audit.md` with the checks, findings, remaining limitations,
and proposed publication or refresh disposition. If the search remains current
and the audit supports publication, prepare `publication-ready.md`. If an
update is required, emit a new finite search wave using the approved update
queries in `search-wave.md` and a finite `search-requests/` set under the
initial request convention. Any newly discovered record returns through the same
screening, corpus, extraction, and synthesis path and produces a new manuscript
state.

Ask the human to review the final synthesis, disclosure, search currency and
publication disposition. Address requested revisions before using the
engine-provided `complete` operation. Write `publication-ready.md` only for
the agreed ready disposition; a refresh writes the search handoffs instead.
This Step prepares a reporting package; it does not submit or publish it to an
external venue. The engine does not authenticate the human decision.

## Execution and artifact conventions

Every Task chooses and pins this one Playbook at Start. The frontmatter
budgets are initial admission limits, not a promise that the review fits
within them. Concurrent work may overshoot, and a realistic large corpus can
require higher Task limits. No token default is supplied.

The initial material input is `ticket.md`. The source-snapshot/seed creation
path remains an engine integration concern; this file does not add a second
Task-start API. Every Step uses the exact engine-assigned binding and source
States. It may inspect their complete available context; inputs are not access
controls. Merge agents reconcile all assigned source material into one result.

Write intended results in the supplied writable artifact area and finalize
any intended repository edits through Git before requesting the engine-provided
`complete` operation. Do not invent a transport payload or submit a publication
list. The engine captures actual material, validates completion and records an
accepted Execution; its result may reuse an existing State. Unchanged files
are not fresh work merely because they are mentioned again. Rejected completion
is corrected within the same Execution. An exited Session is not completion;
Continue and Retry follow the Task's existing controls and user direction.

Outputs are advisory expectations. A branch may intentionally omit some
declared outputs; an omission does not create a hard producer validation rule.
The downstream positive inputs must nevertheless exist before that consumer
is eligible. An empty search result is a real result artifact; an empty set of
screening requests instead takes the explicit corpus-audit handoff. A frozen
empty corpus takes the empty-report handoff. Do not create empty completeness
joins or claim that unrelated matching files supply missing accepted results.

Request/result filenames use canonical lowercase paths. Preserve scientific
wave, record, study and corpus identifiers in request/result contents and
filenames, and keep raw exports and supplemental sources in separately named
evidence directories. These are review data, not engine variables. At an
expansion boundary prepare the whole new request set before completion; retain
the cumulative ledger and references to earlier evidence. In the current
writable result, remove superseded Playbook-owned active handoffs or selector
files only when their old contents are preserved in accepted history and their
replacement is explicit. Never delete uncertain or user-owned evidence.
This is authored material maintenance, not automatic engine invalidation.
Never fabricate request changes merely to trigger another Execution.

Document one scientific wave at a time in the phase handoffs; independent
request workers within that wave may run concurrently. Citation searching,
human-requested additions and publication refresh use the same search request
contract. Do not issue an unrelated overlapping wave or rely on a global
wait-for-all-Steps barrier. Whether existing historical candidates are handled
correctly remains part of the unresolved provenance/source-selection model.

Approval metadata is advisory. Ask the human through ordinary conversation
where instructed, accurately retain supplied decisions in review artifacts,
and keep artifact comments available. There is no engine approval lifecycle,
approval provenance, or authenticated proof of independent reviewer roles.

## Draft conversion assumptions and remaining semantic checks

This file aligns its source format with the accepted reconciliations; it is
not a demonstrated executable review. G1 (provenance/source selection),
G2 (capture/storage) and G3 (completion authority) remain unreviewed.
C17 excludes broader manual historical replay from v1.

- The 23 Steps are retained, but `retrieve-full-text` prepares all packets for
  one wave in one Execution. Both full-text lanes therefore consume one finite
  packet set, rather than requiring a transitive collection-member join.
- `reconcile-study-evidence` joins the complete A/B extraction lanes and writes
  the entire reconciled corpus handoff. It no longer requests unsupported
  per-record pairing of wildcard lanes. Synthesis planning requires that
  meaningful complete handoff; each synthesis request names its relevant
  evidence subset for the agent, without a runtime subset expression.
- Search, title-screening, full-text-screening, extraction and synthesis joins
  still need G1 to associate the correct finite request set and accepted
  results across waves and repeated States. The wave Markdown roster supports
  audit; it does not become engine completeness authority. Names alone never
  prove fulfillment, and this file chooses no claim-key or source algorithm.
- Concealed A/B review remains a methodological requirement, not an engine
  visibility guarantee. Source-selection qualification must test delayed
  sibling launches; prompts tell a lane not to inspect its sibling, but full
  State access cannot itself guarantee blinding. If concealment cannot be
  maintained, report the limitation and use the protocol's accountable human
  arrangement rather than describing the review as independently blinded.
- Meaningful changes may lead to additional waves only when Task rerun policy
  permits them. Broader manual historical replay is outside v1; ordinary
  original-assignment Retry remains available. This draft does not
  automatically enable reruns or manufacture freshness through timestamps.
- G2/G3 must demonstrate that whole finite sets and immutable evidence become
  visible only on accepted completion, and that stale calls cannot change
  accepted results. The prose references `complete` without defining its API.

These are explicit conversion assumptions, not new accepted engine decisions.

## Methodological basis and starting references

These references play different roles. Reporting checklists do not replace
conduct guidance, and domain-specific guidance must be selected in the
protocol.

1. **Choosing the review type:** Munn et al., [*Systematic review or scoping
   review? Guidance for authors when choosing between a systematic or scoping
   review approach*](https://doi.org/10.1186/s12874-018-0611-x). Use this to
   distinguish a focused evidence answer from mapping a broad field.

2. **Protocol reporting:** [PRISMA-P 2015](https://www.prisma-statement.org/protocols).
   Use its checklist to specify the review before results can influence method
   choices.

3. **End-to-end conduct:** [Cochrane Handbook for Systematic Reviews of
   Interventions](https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current)
   and the [JBI Manual for Evidence
   Synthesis](https://jbi-global-wiki.refined.site/space/MANUAL/355599504/JBI%2BManual%2Bfor%2BEvidence%2BSynthesis).
   These provide conduct guidance; select the chapters and appraisal tools that
   match the review domain and study designs.

4. **Search and study selection:** Cochrane Handbook,
   [Chapter 4](https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-04).
   This supports comprehensive searching, deduplication, preliminary
   title/abstract screening, full-text eligibility, two independent people for
   final full-text inclusion decisions, exclusion reasons, and report-to-study
   reconciliation. Duplicate title/abstract screening is desirable rather than
   stated as the same mandatory requirement.

5. **Peer review of search strategies:** McGowan et al.,
   [*PRESS Peer Review of Electronic Search Strategies: 2015 Guideline
   Statement*](https://pubmed.ncbi.nlm.nih.gov/27005575/). Use it for a genuine
   independent peer review of the search strategy; an agent checking its own
   work against the domains is a self-check, not PRESS peer review.

6. **Reproducible search reporting:** Rethlefsen et al.,
   [PRISMA-S](https://pmc.ncbi.nlm.nih.gov/articles/PMC8270366/). Preserve the
   source, platform, exact strategy, limits, dates, counts, and deduplication
   procedure.

7. **Citation searching:** Hirt et al., [*TARCiS statement: terminology,
   application, and reporting of citation searching in systematic
   reviews*](https://www.bmj.com/content/385/bmj-2023-078384), plus Wohlin,
   [*Guidelines for Snowballing in Systematic Literature Studies and a
   Replication in Software Engineering*](https://doi.org/10.1145/2601248.2601268).
   These support explicit seeds, directions, indexes, iterations, screening,
   and stopping behavior.

8. **Data extraction:** Cochrane Handbook,
   [Chapter 5](https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-05).
   This supports piloted forms, duplicate extraction of critical data,
   reconciliation, and retention of original extractions.

9. **Critical appraisal:** the [JBI critical-appraisal
   tools](https://jbi.global/critical-appraisal-tools) for multiple study
   designs and Cochrane Handbook,
   [Chapter 8](https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-08)
   for randomized trials. The protocol must select a design-appropriate method.

10. **Transparent reporting:** the [PRISMA 2020 statement, checklist, and flow
    diagrams](https://www.prisma-statement.org/prisma-2020). PRISMA specifies
    what a transparent final report should disclose; it is not the complete
    conduct method. For scoping reviews, use Tricco et al.,
    [*PRISMA Extension for Scoping Reviews
    (PRISMA-ScR)*](https://doi.org/10.7326/M18-0850).

11. **Software-engineering reviews:** Kitchenham and Charters,
    [*Guidelines for Performing Systematic Literature Reviews in Software
    Engineering*](https://www.elsevier.com/__data/promis_misc/525444systematicreviewsguide.pdf),
    Petersen et al., [*Guidelines for Conducting Systematic Mapping Studies in
    Software Engineering: An Update*](https://doi.org/10.1016/j.infsof.2015.03.007),
    and the [ACM SIGSOFT Empirical Standards systematic-review
    standard](https://www2.sigsoft.org/EmpiricalStandards/docs/standards).

12. **Review taxonomy:** Ralph and Baltes, [*Paving the Way for Mature
    Secondary Research: The Seven Types of Literature
    Review*](https://doi.org/10.1145/3540250.3560877). This is particularly
    helpful for avoiding the ambiguous phrase “survey paper” in computing.

13. **AI assistance and human responsibility:** the joint Cochrane, Campbell,
    JBI, and Collaboration for Environmental Evidence [position statement on
    AI use in evidence synthesis](https://doi.org/10.1186/s13750-025-00374-5)
    and Cochrane's 2026 [RAISE-based implementation
    guidance](https://www.cochrane.org/about-us/news/right-tool-right-job-deciding-when-not-use-ai-tool).
    These support human oversight, transparent reporting of judgment-related
    AI use, evidence that AI will not compromise rigor, context-sensitive
    validation or other safeguards, and continued human accountability.

## Status and open choices

This is a method-backed candidate, not an installed Playbook. Before making it
an executable specimen, choose:

- the first concrete method profile and domain;
- the accountable human reviewer arrangement;
- databases, access mechanisms, and export formats;
- whether preliminary screening uses two lanes or one high-recall lane;
- whether the chosen profile uses study-level appraisal and, if so, its exact
  construct and design-specific instrument;
- the synthesis method and reporting extension; and
- review-specific validation thresholds for any lower-cost model substitution.

The first recommended instantiation is a systematic mapping study of an AI or
software-engineering topic. It exercises the entire graph while avoiding a
premature claim that autonomous agents satisfy clinical-review standards.
