---
schema: alinery.playbook/sketch-0

playbook:
  id: serial-research-refinement
  title: Serial Research Refinement
  revision: 1
  description: >-
    Repeatedly frame research questions, discover sources, appraise evidence,
    and revise a design until no material research question remains.

steps:
  - id: frame-questions
    title: Frame / Refine Questions
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'NewFor(this, ["research-agenda.md"])'
    inputs: [research-agenda.md]
    outputs:
      required: [research-questions.md]
    instructions: "#frame-questions"

  - id: discover-sources
    title: Discover Sources
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'NewFor(this, ["research-questions.md"])'
    inputs: [research-questions.md]
    outputs:
      required: [source-map.md]
    instructions: "#discover-sources"

  - id: appraise-and-synthesize
    title: Appraise + Synthesize Evidence
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'NewFor(this, ["source-map.md"])'
    inputs: [source-map.md]
    outputs:
      required: [evidence-synthesis.md]
    instructions: "#appraise-and-synthesize"

  - id: develop-design
    title: Develop / Revise Design
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'NewFor(this, ["evidence-synthesis.md"])'
    inputs: [evidence-synthesis.md]
    outputs:
      required: [design.md]
      possible:
        - research-agenda.md
        - research-complete.md
    instructions: "#develop-design"
---

# Serial Research Refinement

Begin with `research-agenda.md` in the task state. It may contain an initial
open-ended problem or the unresolved questions emitted by an earlier design
pass. Each successful Step publishes a new immutable task state.

The `inputs`, `required`, `possible`, and authored `NewFor` spellings in this
specimen are provisional schema. They make the worked execution unambiguous;
they do not freeze the final Playbook file format.

## Process

```text
research-agenda.md
        |
        v
Frame / Refine Questions -> research-questions.md
        |
        v
Discover Sources -> source-map.md
        |
        v
Appraise + Synthesize Evidence -> evidence-synthesis.md
        |
        v
Develop / Revise Design -> design.md
        |
        +-- research-agenda.md --> another pass
        |
        +-- research-complete.md; no new agenda --> quiescent
```

The apparent loop is repeated application of the same Step definitions to new
artifact occurrences in descendant states. Concrete state lineage never points
backward. `research-complete.md` records the agent's decision; the engine
becomes quiescent because that execution publishes no new
`research-agenda.md` occurrence.

<a id="frame-questions"></a>
## Frame / Refine Questions

Read `research-agenda.md` as the primary handoff. Inspect the current design,
prior evidence, and the rest of the input state when useful. Turn the agenda
into a focused set of questions for this pass. Do not search for sources or
answer the questions in this Step.

Write `research-questions.md` with:

1. The design decision currently being informed.
2. Stable question identifiers such as `Q1`, `Q2`, and `Q3`.
3. For each question:
   - the exact question;
   - why answering it matters now;
   - what an adequate answer must establish;
   - important scope boundaries;
   - assumptions that require evidence;
   - its relationship to questions from earlier passes.
4. Questions retired, split, combined, or carried forward, with a reason.
5. A concise research scope for the current pass.

Call `step_complete` only when `research-questions.md` is precise enough for a
different agent to discover sources without reconstructing the design problem.

<a id="discover-sources"></a>
## Discover Sources

Read `research-questions.md` as the primary handoff. Find plausible sources for
the current questions and map each source to the question or questions it may
inform. Use earlier source maps to avoid redundant searching, but write a new
current `source-map.md` occurrence for this pass.

Write `source-map.md` with:

1. The current question identifiers.
2. Search terminology, scope, and exclusions.
3. Sources retained from earlier passes because they remain relevant.
4. Newly discovered candidate sources.
5. For every candidate:
   - title and author or issuing organization;
   - publication venue and date when available;
   - DOI, canonical URL, or other stable locator;
   - source type;
   - questions it may inform;
   - why it appears plausibly relevant;
   - access or retrieval limitations.
6. Questions for which no plausible source was found.

This Step discovers candidates. It does not claim that a source is credible,
sufficient, or that it answers a question.

Call `step_complete` only when `source-map.md` gives the next agent a
retrievable and question-indexed evidence set.

<a id="appraise-and-synthesize"></a>
## Appraise + Synthesize Evidence

Read `source-map.md` as the primary handoff. Retrieve and appraise the mapped
sources, then synthesize the current evidence question by question. Inspect
`research-questions.md`, prior evidence, and the rest of the input state for
context. Distinguish findings from this pass from conclusions carried forward
from earlier passes.

Write `evidence-synthesis.md` with:

1. The appraisal method and important limitations.
2. A section for every current question identifier.
3. For each question:
   - status: `answered`, `partially answered`, or `unanswered`;
   - the best-supported current answer;
   - evidence for each material claim;
   - source relevance, credibility, and limitations;
   - agreements, contradictions, and meaningful absences;
   - uncertainty and unresolved assumptions;
   - remaining or newly exposed research questions.
4. Changes from the previous synthesis.
5. Findings sufficiently supported to inform the next design revision.

Do not force a clean answer when the evidence remains incomplete or
contradictory.

Call `step_complete` only when `evidence-synthesis.md` makes both the supported
conclusions and remaining uncertainty explicit.

<a id="develop-design"></a>
## Develop / Revise Design

Read `evidence-synthesis.md` as the primary handoff. Apply the supported
findings to the current design. If `design.md` already exists, revise it rather
than discarding useful earlier decisions.

Write `design.md` with:

1. The problem and current design objectives.
2. The current proposed design.
3. Material decisions and the evidence or explicit assumption behind each.
4. Changes made during this pass and why.
5. Alternatives considered.
6. Risks, limitations, and consequences of being wrong.
7. Remaining design questions.
8. Recommended next actions.

Then make exactly one research-continuation decision:

- If material research questions remain, publish a new `research-agenda.md`
  occurrence. Include only questions whose answers could materially change or
  validate the design, explain why each remains open, and state what evidence
  would resolve it.
- If no material research questions remain for this design scope, publish
  `research-complete.md`. Summarize the evidentiary basis, retained uncertainty,
  and why another research pass is not presently warranted.

On a continuing pass, complete with:

```text
step_complete(
  publish = ["design.md", "research-agenda.md"]
)
```

On the final pass, complete with:

```text
step_complete(
  publish = ["design.md", "research-complete.md"]
)
```
