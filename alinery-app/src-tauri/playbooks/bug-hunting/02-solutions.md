# Possible Solutions

You are in the **Possible Solutions** phase of a Bug Hunting playbook. Your job is to enumerate the
realistic ways to fix the root cause that the previous phase proved — with honest tradeoffs — so a human
can choose one. You are NOT writing the fix, and you are NOT writing the design; both come later.

Before writing:

1. Read the latest/highest-numbered matching `rca` artifact in `{{ARTIFACTS_DIR}}` completely. Its root
   cause and confidence level are your starting point.
2. Read `{{TICKET_FILE}}` for the original report and any evidence the human supplied.
3. Inspect the code the RCA cites — enough to know what each candidate fix would actually touch. Do not
   invent options that the code cannot support.
4. If `{{REVIEW_HANDOFF_FILE}}` is non-empty and the file exists, read it immediately after the ticket and
   the RCA artifact. Treat it as explicit review input/provenance. If `{{PROMPT_EXTRA}}` is non-empty,
   incorporate those extra instructions.

If the RCA artifact reports low confidence or an unreproduced failure, say so at the top of your artifact
and make "confirm the cause first" one of the options rather than papering over it.

Write the candidates to `{{ARTIFACT_FILE}}` containing:
- **Root cause (restated)** — one or two sentences, citing the RCA artifact.
- **Options** — 2–4 candidates. For each: what changes and where (`file:line`), why it fixes *this*
  cause, blast radius, risk, rough effort, what it would take to test, and what it does not fix.
- **Comparison** — a short table or list putting the options side by side on the axes that actually
  differ.
- **Recommendation** — the option you would pick and why, grounded in the codebase, not in taste.
- **Open questions for the human** — anything that changes the recommendation depending on the answer
  (product intent, tolerance for risk, deadlines, compatibility).

Recommending is allowed; deciding is not. Do not begin designing or implementing the recommended option.

After writing the artifact, print this terminal message exactly, replacing the path with the real file
path:

## Next Steps

Possible solutions have been written to `{{ARTIFACT_FILE}}`.

You should review the options before we go further:

- Check that the root cause restated at the top matches what you believe is happening.
- Ask me to explore any option in more depth — I can prototype, measure, or trace further before you
  commit to one.
- Tell me which option to take forward, or add comments to the artifact and I will revise it.

We should agree on one option before proceeding to the Design phase.
