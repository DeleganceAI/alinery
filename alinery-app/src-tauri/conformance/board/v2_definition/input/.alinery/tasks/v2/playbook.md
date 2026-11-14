+++
version = 2
key = "fj"
title = "Fork Join"
description = ""
default_model = ""
default_harness = "vinculum"

[[step]]
key = "clarify"
title = "Title of clarify"
short = ""
inputs = []
outputs = [{ path = "clarify.md" }]
model = ""
harness = ""
is_coding_step = false
auto_advance_default = false
[[step]]
key = "plan"
title = "Title of plan"
short = ""
inputs = []
outputs = [{ path = "plan.md" }]
model = ""
harness = ""
is_coding_step = false
auto_advance_default = false
+++
<!-- alinery:step clarify -->
Do clarify.

<!-- alinery:step plan -->
Do plan.
