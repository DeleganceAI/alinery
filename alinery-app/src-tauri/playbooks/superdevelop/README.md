# SuperDevelop playbook prompts

The SuperDevelop playbook prompts are licensed adaptations of Superpowers materials.

- Upstream repository: <https://github.com/obra/superpowers>
- Pinned upstream commit: `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`
- Upstream copyright: Copyright (c) 2025 Jesse Vincent.
- Upstream license: MIT; see `LICENSE.superpowers` in this directory.
- Adaptation source files:
  - `skills/brainstorming/SKILL.md`
  - `skills/writing-plans/SKILL.md`
  - `skills/test-driven-development/SKILL.md`
  - `skills/executing-plans/SKILL.md`
  - `skills/verification-before-completion/SKILL.md`
  - `skills/requesting-code-review/SKILL.md`
  - `skills/finishing-a-development-branch/SKILL.md`

`common-session.md` is the single authored source for instructions shared by every step.
Each numbered file contains only one step's stage instructions. `alinery-core` composes the
common instructions and selected stage into the per-repository prompt file written under
`.alinery/playbooks/superdevelop/` during playbook initialization.

These are modified, licensed adaptations with Alinery-specific task, artifact, session, and
completion-boundary instructions. They are not a clean-room rewrite and do not include or
require Superpowers runtime tools.

## Current format

The seven stages are Clarify, Investigate, Decide, Plan, Define Tests, Build, and Prepare Review.
Fresh repositories receive the current configuration and composed prompts. Existing configuration
and prompt files are not migrated or rewritten. Custom templates use `PLAYBOOK_KEY`,
`CHILD_PLAYBOOK`, and `ARTIFACT_FILE`; old template aliases are not supported.
