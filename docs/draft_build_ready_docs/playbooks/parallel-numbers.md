---
schema: alinery.playbook/v1

playbook:
  id: parallel-numbers
  description: >-
    Exercise a four-Step artifact fork and join by calculating a sum and product
    in parallel, then combining both accepted results.
  budget_defaults:
    max_step_executions: 4

steps:
  - id: seed
    harness: omp
    model: openai-codex/gpt-5.5
    settings:
      reasoning_effort: high
    inputs: [ticket.md]
    outputs: [numbers.md]

  - id: sum
    harness: omp
    model: openai-codex/gpt-5.5
    settings:
      reasoning_effort: high
    inputs: [numbers.md]
    outputs: [sum.md]

  - id: product
    harness: omp
    model: openai-codex/gpt-5.5
    settings:
      reasoning_effort: high
    inputs: [numbers.md]
    outputs: [product.md]

  - id: combine
    harness: omp
    model: openai-codex/gpt-5.5
    settings:
      reasoning_effort: high
    inputs: [sum.md, product.md]
    outputs: [final.md]
---

# Parallel Numbers

This Playbook tests the production engine's ordinary artifact dependency graph:

```text
Seed -> Sum and Product in parallel -> Combine
```

After Seed is accepted, `numbers.md` independently makes Sum and Product
eligible. Combine requires both exact branch outputs, `sum.md` and `product.md`,
so it becomes eligible only after both branch Executions are accepted.

Expected verification: four accepted Executions, distinct Sum and Product
branch workspaces, one Combine launch after both results are accepted, and a
final answer of 40.

<a id="seed"></a>
## Seed

Read the exact bound `ticket.md` at the input location supplied by the engine.
This Step only creates the numeric seed artifact. Do not perform Sum, Product,
or Combine work.

Write `numbers.md` in the engine-provided writable result-artifact directory.
Its complete contents must be exactly these three lines, with no heading,
label, list marker, commentary, or other value:

```text
2
3
5
```

Preserve every inherited artifact. Leave all repository files unchanged. An
unchanged repository commit is valid; do not create an empty commit. Do not
fabricate missing inputs or manually create engine records.

No network access, subagents, artificial delays, or human-approval pauses are
needed. After `numbers.md` is complete, use the supplied authenticated
completion tool to accept this Execution. Do not request completion before the
artifact is written.

<a id="sum"></a>
## Sum

Read the exact bound `numbers.md` at the input location supplied by the engine.
Calculate the sum from those bound values; do not rely on an unbound copy or
perform Product or Combine work. The expected calculation is `2 + 3 + 5 = 10`.

Write `sum.md` in the engine-provided writable result-artifact directory. Its
complete contents must be exactly `10` followed by a newline. If the bound
numbers do not produce 10, do not substitute the expected value or fabricate a
replacement input.

Preserve every inherited artifact. Leave all repository files unchanged. An
unchanged repository commit is valid; do not create an empty commit. Do not
fabricate missing inputs or manually create engine records.

No network access, subagents, artificial delays, or human-approval pauses are
needed. After `sum.md` is complete, use the supplied authenticated completion
tool to accept this Execution. Do not request completion before the artifact is
written.

<a id="product"></a>
## Product

Read the exact bound `numbers.md` at the input location supplied by the engine.
Calculate the product from those bound values; do not rely on an unbound copy
or perform Sum or Combine work. The expected calculation is `2 × 3 × 5 = 30`.

Write `product.md` in the engine-provided writable result-artifact directory.
Its complete contents must be exactly `30` followed by a newline. If the bound
numbers do not produce 30, do not substitute the expected value or fabricate a
replacement input.

Preserve every inherited artifact. Leave all repository files unchanged. An
unchanged repository commit is valid; do not create an empty commit. Do not
fabricate missing inputs or manually create engine records.

No network access, subagents, artificial delays, or human-approval pauses are
needed. After `product.md` is complete, use the supplied authenticated
completion tool to accept this Execution. Do not request completion before the
artifact is written.

<a id="combine"></a>
## Combine

Read the exact bound `sum.md` and `product.md` at the two input locations
supplied by the engine. Add those bound intermediate values; do not rely on an
unbound copy or repeat Seed, Sum, or Product work. The expected calculation is
`10 + 30 = 40`.

Write `final.md` in the engine-provided writable result-artifact directory with
exactly this content so it records both intermediate values and the final
calculation:

```text
Sum: 10
Product: 30
Final: 10 + 30 = 40
```

If the bound results are missing or do not equal 10 and 30, do not fabricate
them or substitute the expected values.

Preserve every inherited artifact. Leave all repository files unchanged. An
unchanged repository commit is valid; do not create an empty commit. Do not
manually create engine records.

No network access, subagents, artificial delays, or human-approval pauses are
needed. After `final.md` is complete, use the supplied authenticated completion
tool to accept this Execution. Do not request completion before the artifact is
written.
