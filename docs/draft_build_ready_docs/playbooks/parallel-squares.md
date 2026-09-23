---
schema: alinery.playbook/v1

playbook:
  id: parallel-squares
  description: >-
    Exercise dynamic fan-out through one reusable Square Step and a complete-set
    join over the accepted results of a seeded request collection.
  budget_defaults:
    max_step_executions: 5

steps:
  - id: seed
    harness: omp
    model: openai-codex/gpt-5.5
    settings:
      reasoning_effort: high
    inputs: [ticket.md]
    outputs: [request-*.md]

  - id: square
    harness: omp
    model: openai-codex/gpt-5.5
    settings:
      reasoning_effort: high
    inputs: [request-*.md]
    outputs: [result-*.md]

  - id: collect
    harness: omp
    model: openai-codex/gpt-5.5
    settings:
      reasoning_effort: high
    inputs:
      - complete: result-*.md
    outputs: [final.md]
---

# Parallel Squares

Seed publishes one finite request set. The ordinary wildcard binds one request
occurrence per Square application. Collect's `complete:` input requires one
accepted corresponding result for every request in that set, not a fixed list
of result filenames.

The engine records membership through the accepted Seed Execution and its new
request occurrences. It records correspondence through each result's accepted
Square Execution and that Execution's exact wildcard input assignment. Filename
suffixes below are only readable, collision-free output names, not join keys.
Do not author collection metadata or occurrence IDs.

See the [test guide](../test-tickets/05-parallel-squares.md) for import and live
verification. Five accepted Executions cover Seed, three Square applications,
and Collect; this budget counts accepted Executions, not Step definitions or
Session starts.

<a id="seed"></a>
## Seed

Read the exact bound `ticket.md` from its engine-provided input location. Create
only the request collection; do not compute squares or collect results.

In the engine-provided writable result-artifact directory, create exactly these
three new request artifacts. Each contains only its integer and a newline:

| Artifact | Contents |
| --- | --- |
| `request-a.md` | `2` |
| `request-b.md` | `3` |
| `request-c.md` | `5` |

Write all three before requesting completion. Their atomic accepted capture by
this one Execution defines the finite set matched by Square's `request-*.md`.
Do not publish members separately or create result artifacts.

Preserve every inherited artifact byte-for-byte. Leave all repository files
unchanged. An unchanged Git commit is valid; do not create an empty commit.
Use only engine-provided locations; never edit source views or engine records.
No network access, subagents, artificial sleeps, or human-approval pauses.

If a required input is missing or invalid, report the problem with the supplied
authenticated `alinery_execution_fail` tool rather than inventing an input.
Otherwise, after all requests are written, use the supplied authenticated
`alinery_execution_complete` tool and check that completion is accepted.

<a id="square"></a>
## Square

This is one reusable Worker Step. Process exactly the one request occurrence in
your engine-provided input binding. Read it from one of that binding's supplied
locations; several locations for the same occurrence are not additional inputs.
Do not glob, read other requests, process the whole collection, or perform
Collect work.

Require exactly one integer followed by a newline. Compute its square from the
bound integer. Derive one output path by replacing the bound logical path's
`request-` prefix with `result-`, retaining the suffix and `.md`. This naming
rule avoids collisions; the engine's recorded assignment, not the suffix,
provides request-to-result correspondence.

Write that one new result artifact in the engine-provided writable
result-artifact directory. Its complete contents must be one line of the form
`<input integer> → <computed square>` followed by a newline, using decimal
integers and one space on each side of the arrow. Do not produce another
request's result or substitute an expected value for the calculation.

Preserve every inherited artifact byte-for-byte, including all requests. Leave
all repository files unchanged. An unchanged Git commit is valid; do not create
an empty commit. Use only engine-provided locations; never edit source views,
sibling workspaces, or engine records. No network access, subagents, artificial
sleeps, or human-approval pauses.

If the binding, input, or calculation is invalid, report the problem with the
supplied authenticated `alinery_execution_fail` tool; do not fabricate a result
or request successful completion. Otherwise, after your one result is written,
use the supplied authenticated `alinery_execution_complete` tool and check that
completion is accepted.

<a id="collect"></a>
## Collect

Read exactly the result occurrences assigned to your `complete: result-*.md`
input, using their engine-provided locations. Read each bound occurrence once,
not once per location. Do not glob the writable directory, read unbound
requests or results, or assume the default source contains every sibling's
result. The engine determines required coverage from the seeded collection.

Parse every bound result as one `<input integer> → <computed square>` line.
Reject malformed lines, duplicate input integers, or a square that does not
equal its input integer multiplied by itself. Missing or invalid results must
not be replaced with expected values or recomputed replacement artifacts.

Sort the parsed pairs by input integer. Write `final.md` in the engine-provided
writable result-artifact directory: one `<input integer> → <computed square>`
line per bound result, followed by `Total: <sum of the parsed squares>` and a
newline. Calculate the total from all bound results; do not hardcode the pairs,
collection size, or total.

Preserve every inherited artifact byte-for-byte. The writable area starts from
only the designated default source: copy each bound result missing there from
its exact immutable input location, without changing its bytes or logical path.
If an existing same-path artifact differs, report the conflict instead of
overwriting it. Leave all repository files unchanged. An unchanged Git commit
is valid; do not create an empty commit. Never edit source views, sibling
workspaces, or engine records. No network access, subagents, artificial sleeps,
or human-approval pauses.

If a required binding or result is missing or invalid, report the problem with
the supplied authenticated `alinery_execution_fail` tool and do not request
successful completion. Otherwise, after preserving the bound results and
writing `final.md`, use the supplied authenticated `alinery_execution_complete`
tool and check that completion is accepted.
