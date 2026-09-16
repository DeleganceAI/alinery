<p align="center">
  <a href="https://alinery.ai"><img src="alinery-app/public/brand/alinery-app-icon.png" alt="Alinery" width="96" height="96" style="display: block; margin: 0 auto;"></a>
</p>

<h1 align="center">Alinery</h1>

<p align="center"><strong>A Playbook IDE for high-stakes work.</strong></p>

<p align="center">
  <a href="https://alinery.ai"><img src="https://img.shields.io/badge/Website-alinery.ai-111827?style=flat-square" alt="Website: alinery.ai"></a>
  <a href="https://discord.gg/tgAUKEv5U"><img src="https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord: join the community"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-2563eb?style=flat-square" alt="License: Apache 2.0"></a>
  <a href="#install"><img src="https://img.shields.io/badge/Platforms-macOS%20%7C%20Linux-475569?style=flat-square" alt="Platforms: macOS and Linux"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="VISION.md">Vision</a> ·
  <a href="#develop">Develop</a> ·
  <a href="#mcp-server">MCP</a>
</p>

Playbooks define how agents work together through reusable graphs you can inspect and steer. Each task keeps its sessions, decisions, and artifacts together, so you can go down rabbit holes without losing track of the main task or the progress you've made.

## A different way to work

Alinery encourages slower, deeper work with AI. Human review belongs in the Playbook from the beginning, with intentional pauses to align on the problem, approach, and tradeoffs before agents begin substantial work. The aim is **better outcomes and deeper flow states**.

Work in the wrong direction still takes time to review, and a large amount of generated code can create pressure to salvage an approach that should be reconsidered. Getting aligned early helps prevent that wasted effort.

- **Organize by task.** Keep the investigation, decisions, implementation, and review together as the work moves through different sessions.
- **Review artifacts and code.** Direct agent chat is a low-level tool for debugging and intervention. Most of your attention should go to the work being produced and the decisions it requires.
- **Make the process your own.** Customize Playbooks for your work so you can understand, inspect, and steer the process the agents follow.

[Read the project vision →](VISION.md)

## Install

For **macOS on Apple Silicon** and **Linux on x86_64**:

```bash
curl -fsSL https://cdn.alinery.ai/install.sh | bash
```

Alinery includes [OMP](https://github.com/can1357/oh-my-pi) for agent sessions and a Terminal option for shell work.

## What it does

| Concept | What it gives you |
| --- | --- |
| **Task** | One place for the work, its sessions, decisions, and artifacts |
| **Playbook** | A reusable process with defined Steps and review points |
| **Session** | An agent or terminal session; a task can have many |
| **Artifact** | A numbered Markdown output to inspect, comment on, and use in later Steps |
| **Worktree** | An optional isolated Git checkout and branch for a task |
| **Grid / Kanban** | Views of tasks grouped by their current Playbook Step |

The default **SuperDevelop** Playbook takes a change through:

```text
Clarify → Investigate → Decide → Plan → Define Tests → Build → Prepare Review
```

Review the decision before starting Plan. Other bundled Playbooks cover one-shot implementation, code review, bug hunting, and free-form sessions. Customize them through your repository's `.alinery/playbooks.toml`.

**Sessions survive app quit.** A per-repository daemon (`alineryd`) owns the agent and terminal processes. Leave sessions running when you close the app, then reconnect when you return. Stopping sessions is an explicit action; the quit dialog also offers **Quit & close all repos**.

Task records, sessions, and artifacts live under your repository's `.alinery/` directory. The app runs locally, and product-usage telemetry is opt-in.

### Sub-tasks

Sub-tasks give rabbit holes a place of their own, so you can investigate a side question and return to the main task knowing exactly where you left off.

Use different agent Playbooks for different parts of a task: investigate a question, build a change, or review the result. Run sub-tasks in sequence, carry useful work forward, and discard approaches that don't hold up. For high-stakes work, you can run successive agent review Playbooks until you're satisfied with the result.

Each task can have one active direct child, with its own worktree, sessions, and artifacts.

<details>
<summary><strong>Sub-task creation, review, and history</strong></summary>

A task can own one active direct child. Click **Start sub-task** on the parent to open one
parent-owned manager session. The manager asks before it calls `alinery_create_subtask`; Alinery
then creates the child on a dedicated worktree and branch based on the parent task's branch and starts
the child's first playbook step with the repository's effective default harness and model. A
step-specific harness still takes precedence. The child is a complete task, can own its own child,
and receives the immediate parent's ticket and artifact paths in every generated session prompt.
The parent shows the active child as its manager row; the child links back through its header
instead of projecting the parent manager as one of its sessions. Parent sessions remain available
while the child blocks the parent's sub-task slot.

While the child is active, the parent's artifact tree shows a live logical `subtasks/<child>/`
folder. `alinery_finalize_subtask` replaces that view with an immutable snapshot, archives the child,
and clears the parent only after an explicit `artifacts_only`, `integrated_code`, or
`archive_without_code` decision. Use `alinery_inspect_subtask_finish` before finalizing. The parent
keeps the child in its Sessions panel as **FINISHED** for artifact-only or archive-without-code
work, or **MERGED** for integrated code. Task List nests the retained lineage; Kanban hides child
cards by default and can reveal them with **Show children**.

If a setup manager cannot continue before it creates a child, use **Discard setup** to remove that
unusable session. For a created child, use **Kill sub-task**. Alinery stops every live session in the
active child lineage, archives those child tasks as **KILLED**, and clears the parent's active
pointer. It preserves the task records, sessions, artifacts, worktrees, branches, and manager
transcript as navigable history until normal archived-storage cleanup.

</details>

## Develop

For development on macOS, install Xcode Command Line Tools, Rust stable, and Node.js 24.15+ on the Node 24 line. Start from the repository root:

```bash
cd alinery-app
npm install
npm run omp:fetch
npm run tauri dev
```

`omp:fetch` installs the pinned OMP binary used by development sessions. Run `npm run omp:check` to inspect its location and version. Alinery uses its packaged OMP rather than an agent CLI from `PATH`.

Run checks from the **repository root**:

```bash
./scripts/check.sh --quick    # lint, typecheck, tests, source gates
./scripts/check.sh            # plus slow behavioural suites
```

Enable the pre-push hook once per clone: `git config core.hooksPath scripts/hooks`. Bypass with `ALINERY_SKIP_CHECK=1 git push`.

<details>
<summary><strong>Development instances and build notes</strong></summary>

`npm run tauri dev` automatically launches **Alinery Dev**. The launcher reserves port
`1420` when available and otherwise selects the next free local port, keeping Vite and
Tauri on the same URL. Set `ALINERY_DEV_PORT` to an available port when a test needs a
deterministic value. Each source checkout or worktree uses its own app state at
`~/Library/Application Support/ai.delegance.alinery.dev/instances/<source-root-hash>/app.toml`,
and the full launcher worktree path appears in the bottom **ALINERY SOURCE** bar. Separate
source worktrees can run concurrently against different target repositories. The existing
repository lock still refuses concurrent use of the same target repository.

Builds and installs remain **Alinery** and keep the production
`~/Library/Application Support/ai.delegance.alinery/app.toml` path. Repository-local data
continues to live under each target repository's `.alinery/`, so use disposable repositories
for live development writes.

First launch compiles Rust. Native notification banners only appear from a real `.app` bundle, not `tauri dev`.

> **Don't run `cargo update`.** `time` is pinned to `0.3.51` in `Cargo.lock` (Tauri v2 build break otherwise).

</details>

## MCP Server

Point any MCP host that runs **command + args** at the `alinery-mcp` binary. Stdio is the install path — you do not need the Alinery window open for FS/task tools. One process serves every repo; `repo` is a per-call tool argument (a path from `alinery_list_repos`), not a launch flag.

```json
{
  "mcpServers": {
    "alinery": {
      "command": "/absolute/path/to/alinery-mcp"
    }
  }
}
```

## Get involved

Join the [Discord community](https://discord.gg/tgAUKEv5U) to discuss Playbooks and share how you use Alinery. Visit [alinery.ai](https://alinery.ai) for the project website, report bugs in [GitHub issues](https://github.com/DeleganceAI/alinery/issues), and read [VISION.md](VISION.md) for the direction behind the project.

For code contributions, read [AGENTS.md](AGENTS.md) for the repository's engineering conventions and run `./scripts/check.sh` before submitting a change.

## License

Alinery's original source code and documentation are licensed under the
[Apache License 2.0](LICENSE). Third-party components and adapted materials retain
their respective licenses; see [third-party notices](THIRD-PARTY-NOTICES.md) and
any accompanying license files. See [NOTICE](NOTICE) for copyright information.
