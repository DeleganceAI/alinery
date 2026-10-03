---
schema: alinery.playbook/sketch-0

playbook:
  id: parallel-research-appraisal
  title: Parallel Research Appraisal
  revision: 1
  description: >-
    Frame research questions, discover a finite set of plausible
    question-source pairs, appraise each pair independently, synthesize each
    question after complete coverage, and merge the question syntheses into a
    design.

collections:
  - id: appraisal-requests
    member_key: [question_id, source_id]
    emitted_by: discover-sources
  - id: appraisal-results
    member_key_from: appraisal-requests
    emitted_by: appraise-pair
  - id: question-synthesis-requests
    member_key: [question_id]
    emitted_by: discover-sources
  - id: question-syntheses
    member_key_from: question-synthesis-requests
    emitted_by: synthesize-question
  - id: design-requests
    member_key: [design_id]
    emitted_by: discover-sources

steps:
  - id: frame-questions
    title: Frame / Refine Questions
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'Exists(["research-agenda.md"])'
    inputs: [research-agenda.md]
    outputs:
      required: [research-questions.md]
    instructions: "#frame-questions"

  - id: discover-sources
    title: Discover Sources and Map Plausible Pairs
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'Exists(["research-questions.md"])'
    inputs: [research-questions.md]
    outputs:
      required: [source-map.md]
      collections:
        required:
          - appraisal-requests
          - question-synthesis-requests
          - design-requests
    instructions: "#discover-sources"

  - id: appraise-pair
    title: Appraise One Question-Source Pair
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    instances:
      one_per_new_member:
        collection: appraisal-requests
        bind_as: request
    when: 'Exists([request.artifact])'
    inputs:
      primary: request.artifact
    outputs:
      required:
        collection: appraisal-results
        key_from: request.key
        artifact_from: request.result_artifact
    instructions: "#appraise-pair"

  - id: synthesize-question
    title: Synthesize One Question
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    instances:
      one_per_new_member:
        collection: question-synthesis-requests
        bind_as: request
    when: 'Exists(resolved_binding)'
    readiness:
      complete_coverage:
        request_members_from: request.discover_expansion.appraisal_requests
        successful_results: appraisal-results
        scope: producing_discover_execution
    resolved_binding:
      primary: request.artifact
      exact_results_fulfilling: request.requires_appraisals
    inputs:
      primary: request.artifact
      merge_results_fulfilling: request.requires_appraisals
    merge:
      selected_parent_states: agent_declared_at_step_complete
      selected_results_cover: request.requires_appraisals
    outputs:
      required:
        collection: question-syntheses
        key_from: request.key
        artifact_from: request.result_artifact
    instructions: "#synthesize-question"

  - id: develop-design
    title: Develop / Revise Design
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    instances:
      one_per_new_member:
        collection: design-requests
        bind_as: request
    when: 'Exists(resolved_binding)'
    readiness:
      complete_coverage:
        request_members_from: request.requires_question_syntheses
        successful_results: question-syntheses
        scope: producing_discover_execution
    resolved_binding:
      primary: request.artifact
      exact_results_fulfilling: request.requires_question_syntheses
    inputs:
      primary: request.artifact
      merge_results_fulfilling: request.requires_question_syntheses
    merge:
      selected_parent_states: agent_declared_at_step_complete
      selected_results_cover: request.requires_question_syntheses
    outputs:
      required: [design.md]
      possible:
        - research-agenda.md
        - research-complete.md
    instructions: "#develop-design"
---

# Parallel Research Appraisal

Begin with `research-agenda.md` in the task state. This Playbook frames the
agenda, discovers a finite set of plausible question-source pairs, appraises
those pairs independently, merges the complete results for each question, and
then merges the question syntheses into a design.

The `collections`, `instances`, `readiness`, `resolved_binding`, and `merge`
spellings in this specimen are provisional schema. They make late grounding,
complete coverage, and merge provenance explicit without selecting the final
portable syntax.

The authored `when` expressions state only whether the required exact inputs
exist. Before an automatic launch, Alinery derives the resolved input binding
and durably claims that exact Step-definition-revision and binding pair. An
existing claim or successful execution suppresses a duplicate automatic
launch. This engine rule is not authored as `NewFor(...)`; an explicit manual
rerun creates a different execution and successor state.

## Process

The concrete expansion below is pass 1. A later Discover execution may freeze
a different finite number of questions, pairs, question groups, and handoffs.

```text
research-agenda.md
        |
        v
Frame / Refine Questions -> research-questions.md
        |
        v
Discover Sources and Map Plausible Pairs
        |
        +-- appraisal-request-Q1-A.md -> Appraise(Q1,A) --+
        +-- appraisal-request-Q1-B.md -> Appraise(Q1,B) --+-> Synthesize(Q1) --+
        |                                                                  |
        +-- appraisal-request-Q2-B.md -> Appraise(Q2,B) --+                 |
        +-- appraisal-request-Q2-C.md -> Appraise(Q2,C) --+-> Synthesize(Q2) --+
                                                                               |
                                                                               v
                                                                    Develop / Revise Design
                                                                               |
                                  +-- research-agenda.md --> another pass ------+
                                  +-- research-complete.md; no new agenda --> quiescent
```

The four Appraise executions may run concurrently. They begin from one exact
Discover successor and publish four sibling states. Under the conservative V1
barrier, neither question Synthesis may start until all four pass-1 appraisal
requests have successful results. Once that barrier is satisfied,
`Synthesize(Q1)` is a multi-parent merge over the successful results for
`(Q1,A)` and `(Q1,B)` only. `Synthesize(Q2)` similarly merges only `(Q2,B)` and
`(Q2,C)`. Develop / Revise Design is a merge over the two exact
question-synthesis results.

The labels above are the concrete finite expansion used for pass 1. The Step
definitions do not contain four authored Appraise copies. Each Discover
execution declares that pass's members at accepted completion, and the engine
grounds one execution of the reusable `appraise-pair` definition for each
exact member.

## Exact collection semantics used by this specimen

A collection member is an engine-recorded tuple, not a filename match. Its
runtime identity includes the producing Discover execution, collection
identifier, and member key. Reusing `Q1` in a later research pass therefore
does not reuse an earlier member.

Discover writes ordinary Markdown files, then enumerates their exact paths and
relationships in its structured `step_complete` call. Alinery validates those
files and freezes the enumeration in the immutable successor manifest. The
engine never discovers members with a glob or regular expression and never
parses Markdown to infer a key, group, coverage requirement, or output path.

For pass 1's concrete expansion, the accepted collection declaration is
equivalent to:

```yaml
appraisal-requests:
  - key: {question_id: Q1, source_id: A}
    artifact: appraisal-request-Q1-A.md
    result_artifact: appraisal-result-Q1-A.md
  - key: {question_id: Q1, source_id: B}
    artifact: appraisal-request-Q1-B.md
    result_artifact: appraisal-result-Q1-B.md
  - key: {question_id: Q2, source_id: B}
    artifact: appraisal-request-Q2-B.md
    result_artifact: appraisal-result-Q2-B.md
  - key: {question_id: Q2, source_id: C}
    artifact: appraisal-request-Q2-C.md
    result_artifact: appraisal-result-Q2-C.md

question-synthesis-requests:
  - key: {question_id: Q1}
    artifact: question-synthesis-request-Q1.md
    requires_appraisals:
      - {question_id: Q1, source_id: A}
      - {question_id: Q1, source_id: B}
    result_artifact: question-synthesis-Q1.md
  - key: {question_id: Q2}
    artifact: question-synthesis-request-Q2.md
    requires_appraisals:
      - {question_id: Q2, source_id: B}
      - {question_id: Q2, source_id: C}
    result_artifact: question-synthesis-Q2.md

design-requests:
  - key: {design_id: current}
    artifact: design-request.md
    requires_question_syntheses:
      - {question_id: Q1}
      - {question_id: Q2}
```

The `requires_appraisals` and `requires_question_syntheses` fields are
structured manifest relationships. Their duplicate human-readable contents in
the handoff files help agents understand the work but are not authoritative.

## Engine-owned publication

Every grounded execution follows the same publication boundary:

1. The agent works in the execution's isolated workspace and writes the exact
   handoff paths supplied in its generated Session context.
2. Intermediate edits remain unpublished.
3. The agent calls `step_complete`, including structured collection members or
   selected merge parents when that execution requires them.
4. Alinery validates the output contract, frozen coverage, and any selected
   parent-state identifiers.
5. Alinery checkpoints the resulting filesystem and writes the immutable state
   manifest with exact parents, input binding, collection relationships,
   outputs, Step definition, and Session provenance.
6. Only that sealed state becomes visible and causes trigger evaluation to
   resume.

The agent never creates a state or writes the authoritative manifest.

<a id="frame-questions"></a>
## Frame / Refine Questions

Read `research-agenda.md` as the primary handoff. Inspect the current design,
prior evidence, and the rest of the input state when useful. Turn the agenda
into focused research questions. Do not search for or appraise sources in this
Step.

Write `research-questions.md` with:

1. The design decision currently being informed.
2. Stable question identifiers such as `Q1` and `Q2`.
3. For each question:
   - the exact question;
   - why answering it matters now;
   - what an adequate answer must establish;
   - important scope boundaries;
   - assumptions that require evidence.
4. Questions retired, split, combined, or carried forward, with a reason.
5. A concise research scope for this pass.

Call `step_complete` only when a different agent can discover sources without
reconstructing the design problem. Publish exactly `research-questions.md`.

<a id="discover-sources"></a>
## Discover Sources and Map Plausible Pairs

Read `research-questions.md` as the primary handoff. Find credible candidate
sources and identify only the question-source pairs that merit appraisal. A
source may be paired with several questions, and a question may have several
sources. Do not create a Cartesian product merely to increase parallelism.

Write `source-map.md` with:

1. The current question identifiers and search scope.
2. Every retained source, with a stable source identifier, bibliographic
   details, source type, and stable locator.
3. Every plausible question-source pair and why appraisal is warranted.
4. Questions for which no plausible source was found.
5. Search and retrieval limitations.

For each plausible pair, write one self-contained appraisal request. Each file
must identify the exact question and source, include enough retrieval detail,
state what an adequate appraisal must determine, and name its exact expected
result path. For pass 1's concrete expansion, write:

```text
appraisal-request-Q1-A.md
appraisal-request-Q1-B.md
appraisal-request-Q2-B.md
appraisal-request-Q2-C.md
```

A later pass writes one request for each pair that its own Discover execution
retains; it need not produce four members or reuse these keys.

For each question, also write one synthesis request. It must restate the
question, name the exact appraisal request keys whose successful results are
required, state the synthesis standard, and name its exact result path:

```text
question-synthesis-request-Q1.md
question-synthesis-request-Q2.md
```

Write `design-request.md` with the design objective, the exact question keys
whose syntheses are required, and the standard for integrating them.

Complete with one structured call that publishes every exact handoff and
enumerates the three collections. For pass 1's concrete expansion:

```text
step_complete(
  publish = [
    "source-map.md",
    "appraisal-request-Q1-A.md",
    "appraisal-request-Q1-B.md",
    "appraisal-request-Q2-B.md",
    "appraisal-request-Q2-C.md",
    "question-synthesis-request-Q1.md",
    "question-synthesis-request-Q2.md",
    "design-request.md"
  ],
  collections = declared_members_and_relationships
)
```

Alinery, not this Session, assigns the Discover execution identifier, seals the
collection member occurrences, and creates the successor state. Accepted
completion freezes the finite appraisal and synthesis coverage sets for this
Discover execution.

<a id="appraise-pair"></a>
## Appraise One Question-Source Pair

Alinery grounds one execution of this Step for each exact new member of
`appraisal-requests`. Read the assigned request artifact as the primary
handoff. You may inspect `research-questions.md`, `source-map.md`, and the rest
of the exact input state for context, but appraise only the assigned pair.

Retrieve and examine the assigned source. Write the exact result path supplied
by the request member and generated Session context. Include:

1. The exact question identifier and source identifier.
2. Retrieval status and the material actually examined.
3. Findings relevant to the assigned question, with precise support.
4. Relevance, credibility, methodology, and limitations.
5. Whether the source answers the question fully, partially, not at all, or
   with contradictory evidence.
6. Uncertainty, important absences, and follow-up questions.
7. A concise statement suitable for later synthesis.

For the `(Q1,A)` binding, for example, complete with:

```text
step_complete(publish = ["appraisal-result-Q1-A.md"])
```

The engine derives the result member's exact relationship to the bound request
from the execution record. The agent does not enumerate or claim sibling
requests. A failed or incomplete execution publishes no result member.

<a id="synthesize-question"></a>
## Synthesize One Question

Alinery grounds one execution of this Step for each exact new member of
`question-synthesis-requests`, but it starts none of them until every appraisal
request emitted by that same Discover execution has one successful result. In
pass 1, both `Synthesize(Q1)` and `Synthesize(Q2)` therefore wait for successful
results for `(Q1,A)`, `(Q1,B)`, `(Q2,B)`, and `(Q2,C)`. A running, failed, or
missing Appraise execution keeps both Synthesis executions ineligible. V1 has
no partial, timeout, quorum, or early-synthesis policy.

After the global barrier is satisfied, read the assigned synthesis request as
the primary handoff. The generated Session context supplies only that
question's exact successful appraisal-result occurrences and their exact
states. For `Q1`, those are the results fulfilling `(Q1,A)` and `(Q1,B)` from
this same Discover expansion, never the `Q2` results or any same-named result
from an earlier or sibling expansion. The resolved input binding contains the
primary synthesis request occurrence plus both exact Q1 result occurrences.

Compare the results and write the exact question-synthesis path supplied in the
request. Include:

1. The exact question and appraisal coverage set.
2. Status: `answered`, `partially answered`, or `unanswered`.
3. The best-supported current answer.
4. Agreements, contradictions, and differences in evidentiary strength.
5. Source limitations and remaining uncertainty.
6. Newly exposed research questions.
7. Findings sufficiently supported to inform design.

At completion, select every exact appraisal-result state required for complete
coverage and publish the one synthesis handoff:

```text
step_complete(
  publish = ["question-synthesis-Q1.md"],
  selected_parent_state_ids = authorized_Q1_result_states
)
```

Alinery rejects completion if the selected parents and result handoffs do not
cover the entire frozen Q1 request group. It then creates one multi-parent
successor state and records the fulfilled question-synthesis member.

<a id="develop-design"></a>
## Develop / Revise Design

Alinery grounds this merge from the exact `design-requests` member emitted by
Discover. It becomes eligible only after every question-synthesis request named
by that member has one successful result. Read `design-request.md` as the
primary handoff and the exact question-synthesis occurrences named by
`request.requires_question_syntheses` as merge inputs. The generated Session
context supplies those exact occurrences and their authorized parent states.
You may inspect every authorized parent state and ask the human for
clarification before completing.

Write `design.md` with:

1. The problem and current design objectives.
2. The proposed or revised design.
3. Each material decision and its evidence or explicit assumption.
4. Agreements or tensions between question syntheses and how they were handled.
5. Alternatives considered.
6. Risks, limitations, and consequences of being wrong.
7. Remaining design and research questions.
8. Recommended next actions.

Then make exactly one research-continuation decision:

- If material research questions remain, write a new `research-agenda.md`
  occurrence containing only questions that could materially change or validate
  the design.
- If no material research questions remain for the current scope, write
  `research-complete.md` explaining why another pass is not warranted.

On a continuing pass, select every exact question-synthesis parent state used
to satisfy the request and complete with:

```text
step_complete(
  publish = ["design.md", "research-agenda.md"],
  selected_parent_state_ids = authorized_question_synthesis_states
)
```

On the final pass, complete with:

```text
step_complete(
  publish = ["design.md", "research-complete.md"],
  selected_parent_state_ids = authorized_question_synthesis_states
)
```

Alinery validates complete question coverage and the selected parents before
creating the multi-parent design state. A new `research-agenda.md` occurrence
makes Frame applicable again. `research-complete.md` is documentary; the
Playbook becomes quiescent because Design publishes no new agenda occurrence.
