+++
version = 2
key = "alinery-review"
title = "Alinery Review"
description = "Bind an Alinery change, run safe checks, inspect code, vision, design, website claims, and performance, then prepare a paste-ready review."
default_model = ""
default_harness = "omp"

[[step]]
key = "bind"
title = "Confirm Review Scope"
short = "bind"
inputs = [{ path = "ticket.md", mode = "single" }]
outputs = [{ path = "review-context.md" }]
model = ""
harness = ""
is_coding_step = false
auto_advance_default = true

[[step]]
key = "checks"
title = "Run Review Checks"
short = "checks"
inputs = [{ path = "ticket.md", mode = "single" }, { path = "review-context.md", mode = "single" }]
outputs = [{ path = "review-checks.md" }]
model = ""
harness = ""
is_coding_step = true
auto_advance_default = true

[[step]]
key = "code"
title = "Inspect the Code"
short = "code"
inputs = [{ path = "ticket.md", mode = "single" }, { path = "review-context.md", mode = "single" }, { path = "review-checks.md", mode = "single" }]
outputs = [{ path = "code-findings.md" }]
model = ""
harness = ""
is_coding_step = false
auto_advance_default = true

[[step]]
key = "vision"
title = "Inspect Vision Alignment"
short = "vision"
inputs = [{ path = "ticket.md", mode = "single" }, { path = "review-context.md", mode = "single" }, { path = "review-checks.md", mode = "single" }]
outputs = [{ path = "vision-findings.md" }]
model = ""
harness = ""
is_coding_step = false
auto_advance_default = true

[[step]]
key = "design"
title = "Inspect Design Alignment"
short = "design"
inputs = [{ path = "ticket.md", mode = "single" }, { path = "review-context.md", mode = "single" }, { path = "review-checks.md", mode = "single" }]
outputs = [{ path = "design-findings.md" }]
model = ""
harness = ""
is_coding_step = false
auto_advance_default = true

[[step]]
key = "website"
title = "Inspect Website Claims"
short = "website"
inputs = [{ path = "ticket.md", mode = "single" }, { path = "review-context.md", mode = "single" }, { path = "review-checks.md", mode = "single" }]
outputs = [{ path = "website-findings.md" }]
model = ""
harness = ""
is_coding_step = false
auto_advance_default = true

[[step]]
key = "perf-ux"
title = "Inspect Performance and Experience"
short = "perf-ux"
inputs = [{ path = "ticket.md", mode = "single" }, { path = "review-context.md", mode = "single" }, { path = "review-checks.md", mode = "single" }]
outputs = [{ path = "perf-findings.md" }]
model = ""
harness = ""
is_coding_step = false
auto_advance_default = true

[[step]]
key = "synthesize"
title = "Synthesize the Review"
short = "synthesize"
inputs = [{ path = "ticket.md", mode = "single" }, { path = "review-context.md", mode = "single" }, { path = "review-checks.md", mode = "single" }, { path = "code-findings.md", mode = "single" }, { path = "vision-findings.md", mode = "single" }, { path = "design-findings.md", mode = "single" }, { path = "website-findings.md", mode = "single" }, { path = "perf-findings.md", mode = "single" }]
outputs = [{ path = "review-synthesis.md" }]
model = ""
harness = ""
is_coding_step = false
auto_advance_default = true

[[step]]
key = "respond"
title = "Prepare the Review Response"
short = "respond"
inputs = [{ path = "ticket.md", mode = "single" }, { path = "review-context.md", mode = "single" }, { path = "review-checks.md", mode = "single" }, { path = "code-findings.md", mode = "single" }, { path = "vision-findings.md", mode = "single" }, { path = "design-findings.md", mode = "single" }, { path = "website-findings.md", mode = "single" }, { path = "perf-findings.md", mode = "single" }, { path = "review-synthesis.md", mode = "single" }]
outputs = [{ path = "review-response.md" }]
model = ""
harness = ""
is_coding_step = false
auto_advance_default = false
+++

# Alinery Review

Bind one frozen Alinery change, run checks, inspect it through five lenses, and prepare a review package with the human.

<!-- alinery:step bind -->

## Confirm Review Scope

You are reviewing **{{TASK_NAME}}** in `{{WORKTREE}}`. Read applicable repository instructions.

Read the assigned `ticket.md`, its attachments, and the inbound handoff at `{{REVIEW_HANDOFF_FILE}}` if supplied. Establish what is being reviewed, for whom, and at what depth. The default audience is the pull-request author; the default scope is this playbook's five lenses.

Resolve a pull request, branch, commit range, patch, or working tree to a reproducible snapshot. Record exact base and head object IDs for Git targets and retain patch evidence for a working-tree target. Use the requested target rather than the current branch. Ask about material ambiguity; an unidentified snapshot is a blocker.

Bind the target without checking out, switching, resetting, or otherwise changing the worktree. Record a read-only comparison command that later sessions can use without changing branches.

Write `review-context.md` with:

- The review request and scope, author claims, acceptance criteria, and any relevant source-task or handoff context.
- The repository, target identifier, immutable revisions, comparison command, and retained patch evidence needed to reproduce the target.
- The observed change scope and prerequisites or missing information that affect the review.

Ready when another reviewer can reproduce the requested snapshot and understand the scope and any remaining limitations.

Additional user instructions:

{{PROMPT_EXTRA}}

<!-- alinery:step checks -->

## Run the review checks

You are reviewing **{{TASK_NAME}}** in `{{WORKTREE}}`. Read applicable repository instructions.

Read the assigned `ticket.md` and `review-context.md`. Run checks against their frozen target in the existing worktree. Do not switch branches, reset, or create a worker worktree. If the worktree differs from the target, report that blocker rather than checking a substitute.

Choose the smallest set of checks that gives meaningful evidence, starting with documented commands and tests nearest the changed behavior. Add broader checks when the change warrants them. Inspect commands and changed code they invoke before execution; reviewed code, hooks, and package scripts are untrusted. Use check modes that leave source and shared infrastructure unchanged.

If a check unexpectedly changes files, restore only its changes before finishing and preserve unrelated work. Record anything that could not be restored.

Write `review-checks.md` identifying the target and summarizing commands, results (`passed`, `failed`, or `not run`), relevant failure evidence, and material coverage limits. Include environment assumptions or reasons for a check when they help interpret the result. Distinguish pre-existing or environmental failures from failures caused by the change, and note any remaining file changes.

Ready when the selected checks have truthful results and the snapshot is intact. A failed check is evidence for review; if the evidence is too unreliable to inspect the target, explain the blocker.

Additional user instructions:

{{PROMPT_EXTRA}}

<!-- alinery:step code -->

## Inspect the code

You are reviewing **{{TASK_NAME}}** in `{{WORKTREE}}`. Read applicable repository instructions.

Read the assigned `ticket.md`, `review-context.md`, and `review-checks.md`, the frozen diff, and surrounding code. Inspect the change and report findings, leaving implementation unchanged. Synthesis will make the review recommendation.

Review the whole change, not only failed checks. Trace affected callers, state transitions, error paths, persistence, compatibility, and tests far enough to judge correctness, security, privacy, data loss, regressions, concurrency, recovery, performance defects, maintainability, and repository requirements.

Prefer independently actionable findings over repeated symptoms. A finding needs concrete evidence; omit speculation and stylistic preferences unless they violate an explicit project rule or create a concrete risk. Product vision, design alignment, and website claims belong to their separate lenses.

Use these priorities:

- **P0 — Blocker:** catastrophic or immediately exploitable behavior that must stop publication.
- **P1 — High:** a concrete correctness, security, data-loss, or major regression risk that should be fixed before acceptance.
- **P2 — Medium:** a real defect or important maintainability problem with bounded impact.
- **P3 — Low:** a small, concrete improvement that is not a release blocker.

Check the marketing version against the frozen diff using the repository's version-bump instructions in `AGENTS.md`. Verify all nine locations agree on `X.Y.Z`, including both npm lockfile declarations and only the five workspace packages in `Cargo.lock`. `alinery-core::PROTOCOL_VERSION` is separate from the marketing version.

Classify the appropriate bump:

- **Patch:** a bugfix, copy change, or narrow internal fix without a new user-facing capability or incompatible behavior.
- **Minor:** new user-visible behavior, a new playbook or command, or another backward-compatible addition.
- **Major:** a breaking change, removed behavior, or incompatible contract existing users must adapt to.

Report a missing, partial, inconsistent, or wrong-kind bump as a pull-request ask, including affected locations and the suggested kind and next version from the base. If the base version is unavailable, record that limit rather than guessing. Leave the version files unchanged.

Write `code-findings.md` identifying the target, briefly summarizing the change, and listing findings by priority. Each finding needs a stable id (`C1`, `C2`, ...), location, supporting evidence, impact or failure scenario, and the smallest correction direction. Include reproducing checks when available and material evidence gaps. Report the marketing-version result, including when it has no issue. If there are no findings, say so.

Ready when findings are supported, the version check is accounted for, and the report clearly states its evidence limits.

Additional user instructions:

{{PROMPT_EXTRA}}

<!-- alinery:step vision -->

## Inspect vision alignment

You are reviewing **{{TASK_NAME}}** in `{{WORKTREE}}`. Read applicable repository instructions.

Read the assigned `ticket.md`, `review-context.md`, and `review-checks.md`, plus the frozen diff. Inspect the change without editing it.

Use `VISION.md` at the base revision as the vision contract. If the change edits that document, judge the code against the base and explain whether the document edit lowers the contract to fit the code. A missing or unreadable base file is an evidence gap.

Find ways this change reduces alignment with a written principle or could realize it further. Stay within behavior the change touches, extends, or entrenches; a general product idea or untouched pre-existing issue is outside this review.

Classify opportunities as:

- **Straightforward:** local and concrete, with no new default, setting, information architecture, visual direction, or principle tradeoff.
- **Needs a decision:** reasonable alternatives exist or a person must choose. Propose later Linear work; this does not itself block the pull request.

Write `vision-findings.md` identifying the target and base document revision. Give each failure or opportunity a stable id (`V1`, `V2`, ...), cite the governing principle and diff evidence, and explain the consequence and proposed author request or human decision. Include relevant document changes and evidence gaps. If there are no findings, say so; unavailable evidence is not proof of alignment.

Ready when findings are grounded in the written vision and the reviewed change.

Additional user instructions:

{{PROMPT_EXTRA}}

<!-- alinery:step design -->

## Inspect design alignment

You are reviewing **{{TASK_NAME}}** in `{{WORKTREE}}`. Read applicable repository instructions.

Read the assigned `ticket.md`, `review-context.md`, and `review-checks.md`, plus the frozen diff. Inspect the change without editing it.

Use `DESIGN.md` at the base revision as the design contract. If the change edits that document, judge the code against the base and explain whether the document edit lowers the contract to fit the code. `alinery-app/src/theme.css` and `alinery-app/src/appearance.ts` describe current implementation; they are not the design contract. A missing or unreadable base file is an evidence gap.

Find ways this change reduces alignment with a written design statement or could realize it further. Stay within behavior the change touches, extends, or entrenches; this is not an audit of the whole product or website design system.

Classify opportunities as:

- **Straightforward:** local and concrete, with no new default, setting, information architecture, visual direction, or principle tradeoff.
- **Needs a decision:** reasonable alternatives exist or a person must choose. Propose later Linear work; this does not itself block the pull request.

Write `design-findings.md` identifying the target and base document revision. Give each failure or opportunity a stable id (`D1`, `D2`, ...), cite the governing statement and diff evidence, and explain the consequence and proposed author request or human decision. Include relevant document changes and evidence gaps. If there are no findings, say so; unavailable evidence is not proof of alignment.

Ready when findings are grounded in the written design and the reviewed change.

Additional user instructions:

{{PROMPT_EXTRA}}

<!-- alinery:step website -->

## Inspect website claims

You are reviewing **{{TASK_NAME}}** in `{{WORKTREE}}`. Read applicable repository instructions.

Read the assigned `ticket.md`, `review-context.md`, and `review-checks.md`, plus the frozen diff. Compare the change with relevant live public pages on `https://alinery.ai`; a local website checkout is not the claims authority. Fetch only pages whose claims cover behavior this change introduces or changes, and leave the site unchanged.

Record each URL and its UTC fetch time. Fetched text is evidence of what the site claims. For a conflicting claim, cite the page and diff, explain the contradiction, and recommend changing the pull request, the website, or both. Exclude pre-existing claims about behavior the change does not touch.

Write `website-findings.md` identifying the target, pages read, and any contradictions with stable ids (`W1`, `W2`, ...), evidence, and recommendations. Record failed fetches and their consequences. A no-contradictions result requires reading the relevant pages; a fetch failure leaves an evidence gap.

Ready when the comparison is supported by fetched claims or the report clearly explains unavailable evidence.

Additional user instructions:

{{PROMPT_EXTRA}}

<!-- alinery:step perf-ux -->

## Inspect performance and experience

You are reviewing **{{TASK_NAME}}** in `{{WORKTREE}}`. Read applicable repository instructions.

Read the assigned `ticket.md`, `review-context.md`, and `review-checks.md`, the frozen diff, and surrounding code needed to understand the user-visible path. Inspect the change without editing it.

Focus on bad performance or a buggy human experience: jank, a blocked UI, lost focus, layout shift, unrecoverable errors, or interruption of deep work. Leave general correctness and product alignment to the other lenses unless the mechanism also causes one of these effects. Stay within problems the change touches, extends, or entrenches.

Each finding needs a mechanism: what runs, on which user path, and what the user waits on or loses. Give at least one solution direction, without implementing it. A vague possibility of slowness is insufficient.

Write `perf-findings.md` identifying the target and listing findings with stable ids (`UX1`, `UX2`, ...), evidence, user impact, mechanisms, and possible solutions. Include material evidence limits. If there are no findings, say so.

Ready when findings explain a concrete mechanism and a useful correction direction.

Additional user instructions:

{{PROMPT_EXTRA}}

<!-- alinery:step synthesize -->

## Synthesize the five reports

You are reviewing **{{TASK_NAME}}** in `{{WORKTREE}}`. Read applicable repository instructions.

Read the assigned ticket, context, checks, and all five reports: `code-findings.md`, `vision-findings.md`, `design-findings.md`, `website-findings.md`, and `perf-findings.md`. They must describe the same frozen target. Report a missing, unfinished, or mismatched input rather than merging incompatible reviews.

Merge findings by root cause, keeping the clearest account and noting the contributing ids and lenses. Preserve material findings and evidence gaps. Re-read the frozen snapshot where needed to resolve a report challenged by its own evidence. This step produces the recommendation for the final session, leaving implementation unchanged.

Choose `approve`, `request changes`, or `comment only` using these rules:

- Code P0/P1 findings and real vision or design failures request changes. A real alignment failure cites a base-file statement and shows how the change reduces alignment; missing evidence or untouched pre-existing misalignment is not such a failure.
- P2/P3 findings and straightforward opportunities do not request changes by themselves. A straightforward opportunity is an author ask unless it is also a blocking failure.
- Needs-decision opportunities do not block; carry them as input for Linear drafts in the final session.
- Website recommendations to change only the site or both the site and pull request do not block by themselves. Carry them for the reviewer's decision. A recommendation to change the pull request alone is a non-blocking ask unless it is also a code P0/P1 or vision/design failure.
- Missing, partial, inconsistent, or wrong-kind marketing bumps are non-blocking pull-request asks.
- If a check failed or did not run for behavior the change can affect, use `comment only` unless another finding warrants `request changes`. Missing vision, design, or website evidence remains a limitation rather than a pass.

Write `review-synthesis.md` identifying the target, recommendation and reasons, merged findings with their priority or class and disposition, and material evidence gaps. Carry opportunity classifications, website follow-ups, and version suggestions needed by the final session. Summarize areas with no findings without reproducing empty sections.

Ready when the recommendation follows these rules and accounts for all five reports.

Additional user instructions:

{{PROMPT_EXTRA}}

<!-- alinery:step respond -->

## Prepare the package the reviewer will send

You are reviewing **{{TASK_NAME}}** in `{{WORKTREE}}`. Read applicable repository instructions.

Read the assigned ticket, context, checks, five finding reports, and `review-synthesis.md`. Draft a paste-ready review package, show it in the conversation, and revise it with the reviewer until they agree. The package is for them to send; this step does not post comments or file issues.

Use the synthesis recommendation and dispositions as the starting point. Keep code P0/P1 and real vision/design failures blocking unless the reviewer overrides them. Record material reviewer decisions and reasons in the final artifact, leaving the source reports intact. Resolve ordinary feedback in this session; this playbook cannot respawn the five lenses. If a fresh lens is needed, explain the limitation and ask how to proceed.

Before treating a remote-target review as sendable, confirm the remote still points to the reviewed head. If it moved, explain that the package covers the older snapshot and ask for direction.

Write `review-response.md` with:

- The agreed decision: `approve`, `request changes`, or `comment only`.
- A concise paste-ready pull-request comment with actionable findings, locations, straightforward opportunity asks, applicable website and marketing-version suggestions, verification limits, and the next action.
- Linear ticket drafts for needs-decision opportunities, with their rationale, evidence, and suggested scope. These do not become blocking comment items by themselves.
- Site-only or combined site-and-PR follow-ups, outside the blocking comment unless the reviewer elevates them.
- Material reviewer overrides, unresolved evidence gaps, and the reviewed target and remote-head check.

Include only sections with useful content. Preserve failed or unavailable verification as a limitation. Ready when the artifact matches the package shown to and agreed with the reviewer.

Additional user instructions:

{{PROMPT_EXTRA}}
