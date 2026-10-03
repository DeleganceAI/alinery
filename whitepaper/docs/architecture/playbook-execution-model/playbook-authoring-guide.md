# Writing good Playbooks: principles and pitfalls

Started 2026-09-05 from the DEL-629 design discussion.

**Central principle approved on 2026-09-05; supporting guide open to refinement.** This is authoring guidance, not a new engine contract. References to settled behavior come from [DEL-624](https://linear.app/delegance/issue/DEL-624), [DEL-625](https://linear.app/delegance/issue/DEL-625), and [DEL-629](https://linear.app/delegance/issue/DEL-629). This guide does not approve Q41's newer-descendant preference or settle source-selection/provenance mechanics.

## The central principle

> A good Playbook expresses its required dependencies. It does not rely on one agent happening to finish before another.

A Playbook is a policy, not a goal-search system or a list of instructions that the engine follows top to bottom. Its declared inputs, engine-owned bindings and claims, and Task policy determine what work can proceed. Step instructions explain what agents should do with their assignments.

Different completion orders need not produce identical bytes. They should, however, remain consistent with the author's intended dependencies. Required work must not become optional merely because a branch ran slowly.

## 1. Explain why each Step is eligible

For every Step, be able to say: **“Once these particular inputs are available, this work is meaningful and sufficiently informed to start.”**

Good: name the material prerequisites that the Step actually needs before starting. These are positive inputs under the current source contract.

Avoid: treating visual placement, a Step's name, prompt wording such as “after the other agent finishes,” or expected runtime as an engine-enforced dependency. If the inputs permit a Step to run early, the author should expect it can run early, subject to claims and Task controls.

This does not require declaring every file the agent might inspect. Binding is an assignment, not a visibility restriction. Distinguish required material from optional context.

## 2. Separate independent work from required upstream work

Parallel branches are appropriate when each can usefully progress without the other's result. One branch running several Steps while another is still working is not, by itself, poor design.

If a consumer must consider another branch's work, express that dependency through a meaningful result it can bind. If the work is independent, allow independent progress and do not promise that one branch will automatically receive the other's newest repository changes.

Avoid imposing a global wait-for-everything barrier merely because Sessions have different runtimes. Conversely, do not omit a real dependency just to obtain more concurrency.

## 3. Use meaningful handoffs, not accidental side effects

Prefer artifacts that communicate useful results: findings, implementation notes, a review, a patch, or a synthesis. When repository changes are a required handoff, accompanying material should identify and explain those changes and their limits; an inherited prose assertion alone is not proof that the corresponding code is present.

Avoid expecting a later Step to notice required work solely because it happens to receive a newer repository snapshot. Also avoid creating meaningless placeholder files merely to disguise an ordering dependency when a useful handoff can express it.

**Important boundary:** `outputs` declarations are advisory. Naming an artifact there does not force the producing Step to create it or make missing output reject completion. Requiring the artifact as a consumer input constrains the consumer's eligibility when it cannot bind; it is not a new producer-completion gate.

An artifact can also be inherited into several States. Adding a handoff artifact does not, by itself, solve source selection, prove freshness, or establish every request/result association.

## 4. Make aggregations explicit

For a synthesis, explain which results are required together and why. Use the supported exact inputs or explicit `complete:` requirements where the exact finite request set must be covered.

Avoid treating “some appraisal files exist” as “every required request has been handled.” Do not assume two ordinary wildcards create pairs or a Cartesian product; the current grammar permits at most one ordinary wildcard fan-out axis. Multiple explicit completeness requirements can jointly enable one aggregation over their common finite source set.

Do not use the author's picture of a fan-in as a substitute for the actual input contract. The engine's precise source/result association model is still being specified.

## 5. Make recurrence intentional

A useful loop changes the material that should cause another pass: for example, Design revises the agenda, making a new Frame application meaningful under the Task's changed-input rerun policy.

Avoid rewriting timestamps, formatting, or unrelated files solely to manufacture fresh work. A different surrounding State does not make an unchanged, already-handled input fresh. An accepted no-op is valid; agents need not fabricate a material change to prove they worked.

Changed-input automatic reruns default off under the agreed Task policy. Do not present a loop diagram as a guarantee that another pass will occur regardless of that setting. Existing downstream files are not automatically invalidated or deleted when an upstream input changes; presence does not establish freshness.

## 6. Give merge agents a clear job

Explain what the agent should reconcile, which substantive constraints matter, and what a useful combined result looks like. The engine assigns the formal inputs and full source-State set; the agent decides how to use, combine, adapt, or omit content within that assignment.

Avoid treating the default writable repository as the authoritative winner, assuming source directories are automatically unioned, or expecting a source assignment to update itself during execution. One finalized repository commit and the actual final artifact manifest define the result; omitted source content is not implicitly included.

The engine remains responsible for a precise source-selection policy. Authoring guidance cannot justify an undefined or accidentally timing-dependent implementation, even when a particular Playbook could express its dependencies better.

## 7. Review what happens when progress stops

Normal progression stops when no eligible unhandled automatic work and no queued/running Executions remain. That is policy exhaustion, not an engine proof that a goal was achieved or every Execution succeeded.

Check what useful material remains if a Step produces no new material, omits an expected output, or fails. Independent work continues when normally eligible. Failure requires explicit retry under the agreed policy; do not assume a failed branch automatically reruns or that its failure pauses every sibling.

Avoid unnecessary prerequisites that prevent useful partial progress. Keep genuine completeness requirements when partial results would make the consumer's work misleading or inappropriate.

## Case study: findings, code changes, and slow constraints

The Q41 illustration proposed:

- E1 produces findings in S1.
- E2 produces S2 by changing repository code while inheriting those findings unchanged.
- E3 independently produces constraints in S3.
- Design requires findings and constraints.

The illustration did not specify E2's declared inputs. **It therefore did not establish why E2 was eligible.** That omission must be fixed before treating this as a fully specified Playbook example.

Two possible orders expose the authoring question:

```text
Order A: E1 finishes → E2 finishes → E3 finishes → Design is assigned
         Both S1 and S2 can supply the same findings.

Order B: E1 finishes → E3 finishes → Design is assigned → E2 finishes
         Design's assignment cannot silently change to include E2's later result.
```

The smell is not “E3 is slow.” It is **“we have not said whether Design actually needs E2's work.”** A newer-source preference in Order A does not guarantee that dependency in Order B.

| Intended relationship | Better authoring direction |
| --- | --- |
| Design needs E2's work. | Give E2 a meaningful handoff, such as implementation notes, and require the appropriate handoff in Design's inputs alongside findings and constraints. Do not rely on incidental repository selection. |
| E2 is independent of Design. | Allow parallel progress. Do not require Design to absorb E2's changes; use an explicit later integration if their combined result is needed. |
| E2 should act on Design's result. | Require the relevant Design result in E2's inputs so it does not become eligible merely from the findings. |

These are authoring alternatives, not a selection of one for the original research example. The handoff option improves the expressed dependency; it does not settle the remaining carrier-State and provenance rules or make advisory outputs mandatory.

## A short review exercise

Before calling a Playbook well designed:

1. Walk one normal execution and explain each Step's eligibility from its inputs.
2. Reverse the completion order of independent branches. Check that required dependencies still hold; do not require byte-identical agent outputs.
3. Let a fast branch advance while another is delayed. Check which work may legitimately start and which must wait.
4. Try a no-op, an omitted expected artifact, and a failed Execution. Check what remains eligible and what needs attention.
5. Try the intended loop with changed-input reruns enabled and disabled. Check that progress depends on meaningful input changes rather than cosmetic churn.

Treat ambiguity as a prompt to inspect the dependency contract first. Do not automatically classify every valid parallel schedule as a bad Playbook, and do not add increasingly elaborate engine preferences to compensate for missing author intent.
