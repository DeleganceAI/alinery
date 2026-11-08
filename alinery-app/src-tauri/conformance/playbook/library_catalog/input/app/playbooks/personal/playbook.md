+++
version = 2
key = "personal"
title = "Personal"
description = ""
default_model = ""
default_harness = ""
[[step]]
key = "run"
title = "Run"
short = ""
is_coding_step = false
auto_advance_default = false
inputs = [{path = "ticket.md", mode = "single"}]
outputs = [{path = "result.md"}]
model = ""
harness = ""
+++
Preamble
<!-- alinery:step run -->
Read {{TICKET_FILE}}.
