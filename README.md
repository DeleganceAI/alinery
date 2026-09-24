<p align="center">
  <a href="https://alinery.ai"><img src="alinery-app/public/brand/alinery-app-icon.png" alt="Alinery" width="96" height="96" style="display: block; margin: 0 auto;"></a>
</p>

<h1 align="center">Alinery</h1>

<p align="center"><strong>A Playbook IDE for consequential work.</strong></p>

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

**Put a team of agents to work with a Playbook.** Give them a process, steer the important decisions, and build on the results. Playbooks define a ready-to-execute team of agents: who does what, how their work fits together, and where you step in to review or decide. Choose a Playbook for your task and adapt it to the way you want to work. Each task keeps its sessions, decisions, and artifacts together, so you can go down rabbit holes without losing track of the main task or the progress you’ve made.

## Install

For **macOS on Apple Silicon** and **Linux on x86_64**:

```bash
curl -fsSL https://cdn.alinery.ai/install.sh | bash
```

Alinery includes [OMP](https://github.com/can1357/oh-my-pi) for agent sessions and a Terminal option for shell work.

## A different way to work

Alinery encourages slower, deeper work with AI. Human review belongs in the Playbook from the beginning, with intentional pauses to align on the problem, approach, and tradeoffs before agents begin substantial work. The aim is **better outcomes and deeper flow states**.

Work in the wrong direction still takes time to review, and a large amount of generated code can create pressure to salvage an approach that should be reconsidered. Getting aligned early helps prevent that wasted effort.

- **Organize by task.** Keep the investigation, decisions, implementation, and review together as the work moves through different sessions.
- **Review artifacts and code.** Direct agent chat is a low-level tool for debugging and intervention. Most of your attention should go to the work being produced and the decisions it requires.
- **Make the process your own.** Customize Playbooks for your work so you can understand, inspect, and steer the process the agents follow.
- **Build resonant software.** We aim to make Alinery a piece of resonant software, guided by the [Resonant Computing Manifesto](https://resonantcomputing.org/).
- **Build confidence through process.** Much of knowledge work, including software design decisions, has outcomes you cannot fully know in advance. For consequential, complex tasks, Playbooks give agents a deliberate process of investigation, decisions, and review, providing a stronger basis for trusting the quality of the result.

[Read the project vision →](VISION.md)

## What it does

| Concept | What it gives you |
| --- | --- |
| **Task** | One place for the work, its agent sessions, decisions, and artifacts |
| **Playbook** | A reusable process with defined Steps and review points |
| **Session** | An agent or terminal session; a task can have many |
| **Artifact** | A numbered Markdown output to inspect, comment on, and use in later Steps |
| **Worktree** | An optional isolated Git checkout and branch for a task |
| **Grid / Kanban** | Views of tasks grouped by their current Playbook Step |

The default **SuperDevelop** Playbook takes a change through:

```text
Clarify → Investigate → Decide → Plan → Define Tests → Build → Prepare Review
```

Review the decision before starting Plan. Other bundled Playbooks cover one-shot implementation, code review, bug hunting, and free-form sessions. **Build Playbook** is the bundled meta-playbook for defining, drafting, and refining a new playbook, then saving it to a global or repository library after human approval. Find it in the bundled Playbooks list or the new-task picker.

**Sessions survive app quit.** A per-repository daemon (`alineryd`) owns the agent and terminal processes. Leave sessions running when you close the app, then reconnect when you return. Stopping sessions is an explicit action; the quit dialog also offers **Quit & close all repos**.

**Editable work names.** Task-attached OMP agents suggest a short, work-specific session name early in an ordinary working turn, once they understand the task. This uses the working agent, not a separate naming model or background upload service; an unavailable model or an older running extension can leave the session unnamed. Names appear beside status in the task's session table, in the global session list, session header, and search, with task and execution-type context retained.

Use **Rename session** to correct any retained task-attached session, including never-started, exited, archived, and Terminal sessions, without starting it. Names are trimmed, single-line text, limited to 40 Unicode characters (generated names should prefer fewer than 30). A human correction always takes precedence over later automatic suggestions. Names persist independently of session lifecycle data and never change session IDs or execution state. Terminal names are manual only; the taskless Terminal drawer is unchanged.

In the task table and session header, hover the name or Tab to its pencil to edit it in place. Enter saves; Escape cancels. The check and cancel buttons provide the same actions without a keyboard. Finishing an edit returns focus to the name field, without leaving the pencil visible on a previously edited item.

Task records, sessions, and artifacts live under your repository's `.alinery/` directory. The app runs locally, and product-usage telemetry is opt-in.

Task, session, and board browsing read saved metadata and the task's retained playbook even when its owning daemon is offline, incompatible, or belongs to another app instance. Artifact listings and saved content do not require a live owner. Task/session detail and Kanban+ use live execution data when available; otherwise they show validated saved progress with a separate availability notice and collapsed technical details. The app does not start, adopt, or take over a daemon just to browse.

The Kanban+ saved-progress notice has a dismiss button. Dismissal survives polling for the same affected tasks and availability states; the notice returns if those conditions change or live access recovers and later becomes unavailable again.

Completion grants, queued starts, and primary execution creation/recovery remain gated on live owner availability, with backend ownership checks unchanged. Unavailable live status is not proof that a session stopped or completed. Missing or corrupt retained data remains a storage error, not an empty execution state or a replacement from the current playbook library.

**GitHub pull requests.** Kanban cards and task detail show a clickable indicator for the
task branch's PR: green for open, purple for merged, gray for closed without merging.
Clicking opens the actual PR in your browser; it does not move or archive the task.
Discovery uses the existing GitHub CLI connection (`gh`) in the background, with at most
four task lookups running concurrently per batch. Results are shared between views
and cached for 60 seconds after completion, with refreshes while the relevant view
is open and visible. Discovered PR links survive branch/worktree removal.
Lookup failures show an unavailable indicator, or mark the last known status stale.
Compare links are not treated as existing PRs; automatic discovery is GitHub-only.
In Grid, enable **pull request** under **Card properties** to show the same icon in
any card mode. This option is off by default and saved per Grid view. Disabled
properties and inactive Grid tabs do not request PR refreshes.

**Grid settings and presets.** Open the gear to adjust layout, filters, card properties,
and tile width (up to 960px). Detailed and compact cards show every enabled property;
scroll a card if its contents exceed the fixed tile height. Icon-only mode hides text.
Draft tasks appear with a Draft label and open their saved creation form.

On a fresh workspace, the default Kanban+ view starts with **Progress lanes**: playbook
steps left-to-right, all step labels, no grouping, repository fill, attention borders,
manual lane order, compact cards, active tasks only, fixed brightness, and archives
hidden. Tile size is 150 × 78px, row/column spacing is 10/8px, and the first column is
190px. Every card property except playbook is enabled. Existing saved Grid layouts
are restored unchanged; additional Grid tabs retain their Step Kanban starting layout.

Enter a **New preset name** and choose **Save as new preset** to reuse the current
settings across repositories and Grid tabs. Select a user-created preset to delete it;
built-in presets cannot be deleted. Saving another name creates a new preset without
changing the original. Each repository and Grid tab remembers its last settings and
preset locally; task-specific manual ordering and hidden lanes stay with that workspace.
Use **Show empty columns** in column layouts to include unoccupied columns, then
collapse individual columns as needed. Classic Kanban also has **Show empty columns**
and uses equal-height cards, with scrolling for overflowing content.

Step columns default to the declared order in each task's retained playbook, including
when its daemon is offline. Legacy tasks without a retained definition use the current
matching library playbook for display; this does not recover their execution state.
Multiple playbooks share matching column titles and preserve compatible step sequences;
conflicting orders use a deterministic playbook/task tie-break.
Drag a column's grip (or focus it and press Left/Right) to change the order.
Custom column order is remembered per grouping in each Grid view and included in saved
presets. **Reset column order** restores the default without changing task execution.

For one row per task, choose **Position model → Stable task lanes**, **Progress by →
Playbook step**, and **Path labels → Every playbook step** (or select **Progress lanes**).
Each row shows its own playbook's steps in declaration order, with the task card under
its latest recorded step. Labels show only step names, without execution-status suffixes,
and remain visible when execution data is unavailable.

### Sub-tasks

Sub-tasks give rabbit holes a place of their own, so you can investigate a side question and return to the main task knowing exactly where you left off.

Use different agent Playbooks for different parts of a task: investigate a question, build a change, or review the result. Run sub-tasks in sequence, carry useful work forward, and discard approaches that don't hold up. For consequential work, you can run successive agent review Playbooks until you're satisfied with the result.

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

The manager proposes a descriptive child name through the existing creation approval. Use **Rename task** in the child heading or its parent row to edit that name later, including retained archived children. The child's current name and the manager session's own work name remain independent. Renaming changes no slug, branch, worktree, relationship, or historical artifact; task names do not inherit the session-name length limit.

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

### Authoring playbooks through MCP

- `alinery_read_playbook({repo, reference: {scope, key}})` reads the exact `bundled`, `global`, or `repo` definition, including complete prompt source. There is no scope fallback.
- `alinery_save_playbook({repo, target: {scope, key}, source, overwrite?})` creates or replaces a `global` or `repo` definition using the existing v2 parser and atomic library persistence. `source` is the complete Markdown document; its declared key must equal `target.key`. `overwrite` defaults to `false`; replacing an existing destination requires explicit `true`. Bundled writes are refused.
- Both return the existing `ScopedPlaybook` as JSON in MCP text content: `source: {reference: {scope, key}, path}`, `definition`, `source_text`, and `modified_at_ms`. On save, the path and canonical `source_text` describe what was actually persisted. Failures set `isError: true` and retain JSON errors (`kind`, plus diagnostics, source/reference, or message). Invalid arguments and repository selection use `invalid_arguments` and `invalid_repo`.

Use a registered repository root from `alinery_list_repos`, not the agent's task worktree. Global storage uses the server's app-config identity, including the stable global root for dev instances; it is not guessed from the agent's HOME. Repo saves acquire the existing exclusive repository ownership lock and fail with an `io` error containing `repo-busy` while an Alinery window owns that repository. Use that window's editor, or release its repository ownership before retrying; MCP does not borrow GUI ownership. Global saves do not require that lock. Reads remain available while a repository is owned.

**Approval is agent-followed, not backend-enforced.** Review the complete source with the user, ask global versus a specific repository (recommend global), then call the existing OMP extension tool `alinery_ask_approval({title, message})` for that source and exact destination. Name creation versus replacement explicitly—for example, “Save ‘Incident Review’ to your global playbook library (`global/incident-review`)?” or “Replace `global/incident-review` with these reviewed changes?” For repo scope, also name the repository. Call save only after `details.approved === true`; Deny, missing/unavailable UI, or an approval error means keep the draft and do not save. Material source or destination changes require renewed approval. A create conflict is not permission to retry with `overwrite: true`: review the existing definition and obtain replacement approval first. Save accepts no `approved` flag or approval receipt.

Reload with `alinery_list_playbooks({repo})` to discover saved entries; the desktop library and new-task picker use the same catalog. External MCP saves do not push a live-refresh event to an already-open library; reopen the Playbooks view to reload. Saves do not change preferences, create trial tasks, or modify existing tasks' retained definitions.

The approval tool requires an OMP session with its UI transport. If an older installed runner reports `this.pendingRequests`, its embedded extension may be detaching `ui.confirm` from its receiver. Deploy the rebuilt runner and start a new session; changing repository source does not hot-reload an existing session's extension.

## Get involved

Join the [Discord community](https://discord.gg/tgAUKEv5U) to discuss Playbooks and share how you use Alinery. Visit [alinery.ai](https://alinery.ai) for the project website, report bugs in [GitHub issues](https://github.com/DeleganceAI/alinery/issues), and read [VISION.md](VISION.md) for the direction behind the project.

For code contributions, read [AGENTS.md](AGENTS.md) for the repository's engineering conventions and run `./scripts/check.sh` before submitting a change.

## License

Alinery's original source code and documentation are licensed under the
[Apache License 2.0](LICENSE). Third-party components and adapted materials retain
their respective licenses; see [third-party notices](THIRD-PARTY-NOTICES.md) and
any accompanying license files. See [NOTICE](NOTICE) for copyright information.
