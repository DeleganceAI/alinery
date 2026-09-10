# Alinery

Alinery is a Playbook IDE for complex work. Playbooks define how agents work together through reusable graphs you can inspect and steer. Each task keeps its sessions, decisions, and artifacts together, so you can review results, explore sub-tasks, and iterate.

Using Alinery requires a mindset shift from other AI coding approaches. It encourages slower, deeper use by intentional friction in playbooks where human review is designed in from the beginning. We find these features help humans maintain deeper flow states for longer:
- Organize agent sessions by task, instead of constantly switching between tens or hundreds of chats in a sidebar.
- Chatting directly with an agent is a low-level, almost debugging like behavior that is discouraged as much as possible; spend more time reviewing artifacts and code and less time reading long chat messages from agents or watching them while they work.
- Customize your playbooks so they are better adapted to your specific work and maintain accurate mental models of the process that the AI is following.

## Install

```bash
curl -fsSL https://cdn.alinery.ai/install.sh | bash
```

## What it does

| Concept | What it is |
|---------|------------|
| **Task** | Durable container under `<repo>/.alinery/tasks/<slug>/` |
| **Session** | One PTY running a harness (default OMP). Cheap; many per task |
| **Artifact** | Numbered markdown checkpoint written between playbook phases |
| **Worktree** | One git worktree per task on branch `<slug>` |
| **Grid/Kanban** | Read-only view grouping tasks by derived playbook Step |

**Sessions survive app quit.** A per-repo daemon (`alineryd`) owns the PTYs. Quit the UI and agents keep running; relaunch reattaches and replays the reconstructed screen. History is also written to an on-disk `.scrollback` sidecar so it can survive daemon restarts. Explicit teardown only: **Quit & stop all sessions** / `stop_daemon`.

### Sub-tasks

A task can own one active direct child. Click **Start sub-task** on the parent to open one
parent-owned manager session. The manager asks before it calls `alinery_create_subtask`; Alinery
then creates the child on a dedicated worktree and branch based on the parent task's branch and starts
the child's first playbook step with the repository's effective default harness and model. A
step-specific harness still takes precedence. The child is a complete task, can own its own child,
and receives the immediate parent's ticket and artifact paths in every generated session prompt.
The parent shows the active child as its manager row; the child links back through its header
instead of projecting the parent manager as one of its sessions. Parent sessions remain available
while the
child blocks the parent's sub-task slot.

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

## Develop

**Prerequisites:** macOS (Apple Silicon), Xcode CLT, Rust stable, Node 18+, and at least one agent CLI on `PATH`. OMP is the only harness with semantic status and phase completion in this version; other configured harnesses remain fully usable as terminals.

```bash
cd /path/to/repo/alinery-app
npm install
npm run tauri dev
```

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

First launch compiles Rust (~a minute). Native notification banners only appear from a real `.app` bundle — use `./scripts/install-local.sh` for that.

> **Don't run `cargo update`.** `time` is pinned to `0.3.51` in `Cargo.lock` (Tauri v2 build break otherwise).

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

## License

Alinery's original source code and documentation are licensed under the
[Apache License 2.0](LICENSE). Third-party components and adapted materials retain
their respective licenses; see [third-party notices](THIRD-PARTY-NOTICES.md) and
any accompanying license files. See [NOTICE](NOTICE) for copyright information.
