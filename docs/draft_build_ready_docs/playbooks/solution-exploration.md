+++
version = 2
key = "solution-exploration"
title = "Solution Exploration"
description = "Explore solutions sequentially, independently trace implementation difficulty, and compare the evidence without implementing code or estimating duration."
default_model = ""
default_harness = "omp"

[[step]]
key = "clarify"
title = "Clarify the Question"
short = "clarify"
inputs = [{ path = "ticket.md", mode = "single" }]
outputs = [{ path = "problem-brief.md" }, { path = "design-request.md" }]
model = ""
harness = ""
is_coding_step = false
auto_advance_default = true

[[step]]
key = "design"
title = "Design One Solution"
short = "design"
inputs = [{ path = "problem-brief.md", mode = "single" }, { path = "design-request.md", mode = "single" }]
outputs = [{ path = "solution-design.md" }]
model = ""
harness = ""
is_coding_step = false
auto_advance_default = true

[[step]]
key = "plan"
title = "Trace Implementation"
short = "plan"
inputs = [{ path = "problem-brief.md", mode = "single" }, { path = "solution-design.md", mode = "single" }]
outputs = [{ path = "implementation-plan.md" }]
model = ""
harness = ""
is_coding_step = false
auto_advance_default = true

[[step]]
key = "check"
title = "Check the Exploration"
short = "check"
inputs = [{ path = "problem-brief.md", mode = "single" }, { path = "solution-design.md", mode = "single" }, { path = "implementation-plan.md", mode = "single" }]
outputs = [{ path = "exploration-record.md" }, { path = "loop-decision.md" }, { path = "design-request.md" }, { path = "synthesis-request.md" }]
model = ""
harness = ""
is_coding_step = false
auto_advance_default = true

[[step]]
key = "synthesize"
title = "Compare the Solutions"
short = "synthesize"
inputs = [{ path = "problem-brief.md", mode = "single" }, { path = "exploration-record.md", mode = "single" }, { path = "loop-decision.md", mode = "single" }, { path = "synthesis-request.md", mode = "single" }]
outputs = [{ path = "solution-comparison.md" }, { path = "design-request.md" }]
model = ""
harness = ""
is_coding_step = false
auto_advance_default = false
+++

# Solution Exploration

Explore one solution at a time, investigate its implementation, and compare what you learn.

<!-- alinery:step clarify -->

Understand the problem, record constraints and useful assumptions, and get exploration started without an unnecessary interview. Write `problem-brief.md` and an initial `design-request.md`.

Additional user instructions: {{PROMPT_EXTRA}}

<!-- alinery:step design -->

Propose one concrete solution grounded in the codebase. Use previous discoveries to avoid repeating an earlier approach. Write `solution-design.md`, carrying forward prior findings, human feedback and references.

<!-- alinery:step plan -->

Independently investigate what implementing this solution would require and what makes it difficult. Write `implementation-plan.md`, retaining references to the design and prior findings. Do not implement the solution or estimate duration.

<!-- alinery:step check -->

Assess what we learned and decide whether another solution is worth exploring, without routine human approval or a hard iteration limit. Write the cumulative `exploration-record.md` and your reasoning in `loop-decision.md`.

Write either `design-request.md` to continue or `synthesis-request.md` to compare the findings, never both. Carry the accumulated findings, human feedback and references in that request.

<!-- alinery:step synthesize -->

Explain the alternatives and tradeoffs to the human in `solution-comparison.md`. They do not need to choose a winner.

If they ask to continue during this session, write `design-request.md` with their feedback and the accumulated findings and references. Otherwise, omit it; the comparison stands on its own.
