---
schema: alinery.playbook/sketch-0

playbook:
  id: linear-research-to-design
  title: Linear Research to Design
  revision: 1
  description: >-
    Turn one research brief into framed questions, a source map, an evidence
    synthesis, and an evidence-grounded design in a single pass.

steps:
  - id: frame-questions
    title: Frame / Refine Questions
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'Exists("research-brief.md")'
    outputs: [research-questions.md]
    instructions: "#frame-questions"

  - id: discover-sources
    title: Discover Sources
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'Exists("research-questions.md")'
    outputs: [source-map.md]
    instructions: "#discover-sources"

  - id: appraise-and-synthesize
    title: Appraise + Synthesize Evidence
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'Exists("source-map.md")'
    outputs: [evidence-synthesis.md]
    instructions: "#appraise-and-synthesize"

  - id: develop-design
    title: Develop / Revise Design
    revision: 1
    harness: codex
    model: gpt-5.6-sol
    settings:
      reasoning_effort: high
    when: 'Exists("evidence-synthesis.md")'
    outputs: [design.md]
    instructions: "#develop-design"
---

# Linear Research to Design

Turn one research brief into focused research questions, a map of relevant
sources, an evidence synthesis, and an evidence-grounded design. Begin with
`research-brief.md` in the task state.

## Process

```text
research-brief.md
  -> Frame / Refine Questions -> research-questions.md
  -> Discover Sources         -> source-map.md
  -> Appraise + Synthesize    -> evidence-synthesis.md
  -> Develop / Revise Design  -> design.md
```

<a id="frame-questions"></a>
## Frame / Refine Questions

Read `research-brief.md` as the primary handoff. Turn the initial idea into a
set of precise, answerable research questions. Do not perform the
literature search or attempt to answer the questions in this Step.

Write `research-questions.md` with:

1. A concise restatement of the problem and intended design decision.
2. Stable question identifiers such as `Q1`, `Q2`, and `Q3`.
3. For each question:
   - the exact question;
   - why answering it matters;
   - what an adequate answer would need to establish;
   - important scope boundaries and exclusions;
   - assumptions that should be tested rather than silently accepted.
Keep the set focused. Split a question when its parts require different kinds
of evidence. Combine questions that would be answered by the same evidence.

The Step is complete only when `research-questions.md` is coherent enough for a
different agent to discover sources without reconstructing the original intent.

<a id="discover-sources"></a>
## Discover Sources

Read `research-questions.md` as the primary handoff. Find plausible sources for
each question and map every source to the question or questions it might inform.
This Step discovers candidates; it does not claim that a source is credible,
relevant enough, or sufficient to answer a question.

Prefer primary literature, standards, official technical documentation, and
other sources appropriate to the domain. Preserve enough bibliographic detail
and a stable locator for another agent to retrieve every source.

Write `source-map.md` with:

1. The search scope, terminology, and important exclusions.
2. A section for each stable question identifier.
3. For every candidate source:
   - title and authors or issuing organization;
   - publication venue and date when available;
   - DOI, canonical URL, or other stable locator;
   - source type;
   - the question it may inform;
   - a brief reason it appears plausibly relevant;
   - any access or retrieval limitation.
4. Questions for which no plausible source was found.

Avoid unsupported relevance claims and do not synthesize conclusions yet.

<a id="appraise-and-synthesize"></a>
## Appraise + Synthesize Evidence

Read `source-map.md` as the primary handoff. Retrieve and examine the mapped
sources, judge their relevance and credibility, and synthesize the available
evidence question by question. You may inspect `research-questions.md` and the
rest of the input state for context.

Write `evidence-synthesis.md` with:

1. A short account of the appraisal method and important limitations.
2. A section for every stable question identifier.
3. For each question:
   - status: `answered`, `partially answered`, or `unanswered`;
   - the best-supported answer presently available;
   - the evidence supporting each material claim;
   - source relevance, credibility, and limitations;
   - agreements, contradictions, and meaningful absences in the evidence;
   - uncertainty and unresolved assumptions;
   - remaining or newly exposed research questions.
4. A final list of findings that are sufficiently supported to inform design.

Distinguish source findings from your own inference. Do not conceal conflicting
evidence merely to produce a cleaner conclusion.

<a id="develop-design"></a>
## Develop / Revise Design

Read `evidence-synthesis.md` as the primary handoff. Apply the supported findings
to the object being designed. You may inspect the complete input state, but do
not rewrite the upstream research handoffs.

Write `design.md` with:

1. The problem and design objectives.
2. The proposed design, described concretely enough for review or planning.
3. Each material design decision and the evidence or explicit assumption behind
   it.
4. Alternatives considered and why they were not selected.
5. Risks, limitations, and consequences of being wrong.
6. Open design questions and open research questions.
7. Recommended next actions.

Do not present a partially answered research question as settled. Record all
remaining research and design questions clearly in `design.md` for future work.
