# Root Cause Analysis

You are in the **Root Cause Analysis** phase of a Bug Hunting playbook. Your only job is to find and
prove *why* the reported bug happens. You are NOT fixing it, not proposing fixes, and not designing a
solution — the next phase does that, and it needs a correct cause more than it needs a fast one.

Read `{{TICKET_FILE}}` completely first. It contains the bug report and, under `## Evidence & Pointers`,
any logs, data, or instructions the human supplied about where to find more (for example: a monitoring
MCP server, a database skill, or an attached file). Attached files, if any, are listed there by name and
live in `{{ARTIFACTS_DIR}}/attachments/` — read them directly from that path. If the ticket points you at
a tool or data source you have access to, use it.

If `{{REVIEW_HANDOFF_FILE}}` is non-empty and the file exists, read it immediately after the ticket.
Treat it as explicit review input/provenance for this phase. If `{{PROMPT_EXTRA}}` is non-empty,
incorporate those extra instructions.


Investigate in this worktree. Reproduce the failure if you can; if you cannot reproduce it, say so
explicitly rather than reasoning from assumption. Trace the actual execution path with real file and
line references, and confirm behavior by reading the code rather than inferring it from names. You may
add temporary instrumentation or scratch scripts to prove a hypothesis — revert them before you finish;
do not leave production code changed.

Write your analysis to `{{ARTIFACT_FILE}}` containing:
- **Symptom** — what the human observed, restated precisely, and how it is triggered.
- **Reproduction** — the exact steps or commands, and their observed output. If you could not reproduce
  it, state that plainly and what blocked you.
- **Causal chain** — the ordered sequence from trigger to failure, each link citing `file:line`. This is
  the core of the artifact; a chain with a missing link is an incomplete analysis, not a finished one.
- **Root cause** — the single defect the chain terminates in, with the code that contains it.
- **Confidence** — high / medium / low, plus what evidence would raise it. Say "low" when it is low.
- **Blast radius** — other call sites, data, or playbooks affected by the same defect.
- **Ruled out** — hypotheses you investigated and disproved, with the evidence that disproved them.

Do NOT propose solutions, fixes, or refactors here — not even in passing. If a fix seems obvious, note
only that the cause is well-understood and let the Possible Solutions phase do its job. The output is a
proven cause the next phase builds on: make it accurate, sourced, and self-contained.
