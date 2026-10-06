# Finite Agent Machines editorial review

The current draft has a clear motivation: when checking an agent's result is difficult or expensive, the process producing that result deserves explicit design and inspection. The next revision should connect that motivation to a precise mechanism and decide what the word *finite* constrains. Sentence polish will be more useful once those two decisions are settled.

This first Compound Writing trial applies `cw-scribe`, `cw-dev-edit`, and an independent `cw-reader` pass. It reviews the active V3 manuscript, including its unfinished sections, without changing the paper.

**Working audience assumption:** technically interested readers familiar with agent software but unfamiliar with Alinery. No maintained voice or audience guide was found in the whitepaper folder.

**Source boundary:** the fresh *Finite Agent Machines* draft occupies lines 59–314 of [the V3 source](./playbook-execution-model.tex). “Previous Draft (Preserved)” begins at line 317. The Engine Design Decisions appendix begins at line 1010. Preserved prose is potential source material, not evidence that the fresh draft has already explained or established its claims.

**Readiness:** needs developmental work before a line edit.

## What is worth keeping

The verification burden gives the paper a practical reason to exist. Preserve that subject and the author's interest in human oversight; replacing it with a generic description of agent orchestration would lose the motivation.

The shared brief, independent reviewers, and synthesis example makes parallelism understandable in a few sentences (lines 126–130). It is a useful starting point for a running example.

The Petri-net passage carefully distinguishes a structural resemblance from a proved equivalence (143–150). That restraint should also govern the claims about assurance, alignment, and finiteness.

## The twenty second pitch test

The following pitch expresses the clearest mechanism currently described. It is an editorial interpretation to test, not a replacement thesis adopted on the author's behalf:

> When an agent's result is costly to verify, an authored process can specify which operations may run, what evidence they receive, and how their outputs enable further work. Finite Agent Machines aim to make that process explicit and inspectable while leaving substantive decisions to agents and people.

| Introduction's promise | What the draft presently explains | Revision needed |
| --- | --- | --- |
| A solution for searching without a cheap conclusive verifier (70). | Predefined agent operations and dependencies between their artifacts. | Explain how these controls affect the search or review burden, and under which assumptions. |
| An architecture to “solve alignment and verification problems” (86). | Operational constraints, oversight, and execution records. | Define the particular failure being addressed and the limit of the claim. |
| Checking the process reduces required checking of the result (91). | A process can be inspected; the proposed reduction is not yet established. | Supply a mechanism and evidence, or present the reduction as a hypothesis. |

The useful tension is whether process constraints can make difficult-to-verify work more manageable. Keep that question visible while distinguishing what the architecture specifies from what would still need to be demonstrated.

## Priorities for the next revision

**1. Critical — connect process control to the verification problem.** The opening alternates between impossible verification, expensive verification, incomplete assurance, and human review costs (68–93). The existence of tests, linters, and review methods does not establish the claim that verification is “fundamentally unsolveable for most software.” Choose the obstacle this paper addresses and scope it precisely.

A worked example should identify one failure, the process rule intended to catch or constrain it, the evidence a reviewer receives, and a remaining failure the rule cannot exclude. This would give the proposed architecture a concrete relationship to the motivation. It would illustrate the mechanism; it would not by itself demonstrate lower review costs or improved alignment.

**2. Critical — state what is finite.** The background says a finite set of Step definitions may produce unbounded executions and artifact occurrences, and that a concurrency cap does not make the complete state space finite (143–150). The subsequent FAM definition retains a finite state set `Q` (159–192). The relationship between those statements is missing.

Two possible directions need different definitions: finite control states with a separate, potentially unbounded data configuration; or finitely many authored operation schemas with potentially unbounded runtime configurations. Neither interpretation follows automatically from the current text. Define the choice, relate `Q` to the later configuration `γ`, and explain how concurrent work is represented. This is a decision about the model, not a wording correction.

**3. Critical — distinguish publication acceptance from substantive correctness.** The transition schema includes an acceptance predicate `V` (225–265), but the reader does not know whether it checks structural validity, human authorization, domain correctness, or some combination. The Engine Design Decisions appendix expressly describes structural validation without a judgment that the work is good (1024), and says completion permission does not authorize particular immutable contents (1046).

State what acceptance establishes in the proposed model. If a human or domain-specific checker supplies additional assurance, specify its role separately. Otherwise the verification problem appears to have been hidden inside `V`. The alignment section should name operational failures that the process addresses instead of treating model-level alignment work as categorically mistaken (284–289).

**4. Critical — consolidate the definitions and identify the model being carried forward.** Two consecutive sections have the same FAM heading (152, 195). One defines an agentic transition through harness, instructions, and model (176–184); the other describes eligibility, execution, validation, and publication (225–265). These can be complementary levels, but the relationship must be stated. The final tuple also names `α` while its explanation uses `Σ` (269–278).

A possible hierarchy is an authored operation specification, a runtime execution with a concrete input binding, and an accepted change to configuration. Use one worked execution to introduce these distinctions before the full notation.

When reusing old prose, keep its assumptions visible. The preserved abstract describes isolated executions and immutable successor states (333–340), while the new appendix describes mutable artifact files and one shared task worktree (1027, 1048). Those are different designs. The issue is deciding which assumptions belong in the new model; it is not an allegation that the explicitly preserved paper already contradicts itself.

**5. Consider — introduce the mechanism before the dense background.** The reader reaches occurrence matching, shutdown, collection obligations, and binding deduplication before seeing a complete FAM example (119–141). A small example immediately after the motivation would explain why the later formal machinery is necessary. Keep a short Petri-net introduction where it helps; place detailed comparison after readers understand the proposed execution model.

## The section summary test

These summaries describe each active section or paragraph cluster's apparent job. Where text does not yet serve that job, the suggested move is provisional.

| Section or cluster | One sentence argument | What needs attention |
| --- | --- | --- |
| Introduction, verification and search (68–76) | Difficult or costly checking changes the value of generating more candidates. | Separate the economic claim from the claim of impossibility; replace citation placeholders with support when developing the argument. |
| Introduction, agent scope (78–80) | Narrow operations may make agent work easier to manage. | Connect this to the proposed process or move it into design motivation; the prevalence and performance claims need support. |
| Introduction, oversight (83–93) | Explicit processes may help people assess work whose outcomes are difficult to check. | Explain the causal link; candidate count, review burden, correctness, and alignment are different outcomes. |
| Petri nets (99–150) | Artifact dependencies have a useful concurrent-net interpretation without an established equivalence. | Retain the example and qualification; defer lifecycle detail until the mechanism is introduced. |
| First FAM section (152–192) | A transition system can label transitions with agent operation specifications. | Define the state space and connect the operation specification to execution semantics. |
| Second FAM section (195–279) | Eligibility, execution, acceptance, and publication determine an accepted transition. | Merge the duplicated introduction and definitions; explain bindings and configurations before the equations. |
| Alignment notes (284–289) | Fixed coordination may help constrain and inspect fallible agents. | Develop a specific failure mechanism and its limits. |
| Execution, trace, related work, limitations, conclusion, schematic appendix (292–314) | These sections are intended to deliver and qualify the mechanism. | They are placeholders; preserved material cannot fill them without checking its assumptions. |

## The first time reader experience

The independent `cw-reader` pass reviewed only the fresh manuscript. Its main reactions, in reading order, were:

1. **“I don't believe this yet.”** The opening's claim about most software asks for more agreement than it supports, before distinguishing impossible checking from expensive checking.
2. **“I'm missing something.”** The introduction moves from agent scope to candidate counts to trust in process without showing how one leads to the next.
3. **“What does accepted mean?”** The brief-and-reviewers example lands, but acceptance is central to the verification problem and remains unexplained.
4. **“What is the state?”** Unbounded occurrences followed by finite `Q` stops the reader; the interpretation of the title depends on this distinction.
5. **“Am I reading alternatives?”** The second FAM section restarts the definitions and makes the reader compare drafts instead of follow an argument.
6. **“Show me one run.”** Bindings and configurations appear before a concrete trace, and the promised execution and example sections are still empty.

## Proposed revision order

First, settle the relationship between the verification motivation and the paper's actual contribution. Then choose the meaning of finiteness and the runtime assumptions that the new model adopts. These choices should precede an abstract rewrite.

Next, develop one example that contains a substantive mistake, a process rule, an acceptance decision, and the limits of what the resulting record establishes. Use that example to consolidate the definitions and build the execution section. The paper can then return to related work and state its contribution at the strength supported by the model and evidence.

For that next pass, the most useful author input is whether the intended claim is primarily **a precise model for constrained, inspectable agent execution**, or also **a demonstrated reduction in verification effort**. The latter needs an additional argument and supporting evidence. The review does not choose between them.

## Review provenance

Reviewed on October 5, 2026 against branch `whitepaper`, HEAD `8d24faa`, including existing uncommitted source changes. TeX SHA-256: `08da8dee8de43f73c6607319c40aee2e86a84a4bf3159514b4a31c9d1cc12ee2`. All line references above refer to that source snapshot.

Compound Writing was loaded directly from a local checkout of [EveryInc/compound-writing](https://github.com/EveryInc/compound-writing/tree/8fd0ec88c00976cf0274cb76552dc7ad9405ca92), plugin version 2.4.1. Applied instructions: [cw-scribe](https://github.com/EveryInc/compound-writing/blob/8fd0ec88c00976cf0274cb76552dc7ad9405ca92/skills/cw-scribe/SKILL.md), [cw-dev-edit](https://github.com/EveryInc/compound-writing/blob/8fd0ec88c00976cf0274cb76552dc7ad9405ca92/skills/cw-dev-edit/SKILL.md), [cw-reader](https://github.com/EveryInc/compound-writing/blob/8fd0ec88c00976cf0274cb76552dc7ad9405ca92/skills/cw-reader/SKILL.md), and their shared context contract. This was a local trial, not a global plugin installation.

This is an editorial and internal-consistency review, not a literature survey or an implementation conformance audit. No scientific references were added or validated. The manuscript, its generated PDFs, and all README files were left unchanged.
