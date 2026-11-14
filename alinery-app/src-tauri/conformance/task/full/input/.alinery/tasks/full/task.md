name = "Full"
slug = "full"
requested_slug = "full-req"
branch = "full"
worktree = "/w/full"
has_worktree = false
created = 20
archived = true
pr_url = "https://example.test/pr/1"
linear_id = "LIN-1"
github_issue = "owner/repo#2"
playbook = "superdevelop"
engine_version = 2
max_live_sessions = 3
auto_advance = ["clarify", "plan"]
auto_approve_all = true
parent_task = "parent"
active_subtask = "child"
subtask_outcome = "finished"
draft = true
draft_base_ref = "refs/heads/main"
telemetry_id = "tel-1"

[playbook_ref]
scope = "repo"
key = "superdevelop"

[launch_defaults]
harness = "vinculum"
model = "m1"

[step_models]
build = "big"
plan = "small"

[[related_tasks]]
repo_path = "/repo/other"
slug = "other"
name = "Other"

[[related_tasks]]
repo_path = "/repo/two"
slug = "two"
