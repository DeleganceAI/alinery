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

Alinery puts a team of agents to work on a Playbook: a process that says who does what, how their work fits together, and where you step in to review or decide. Pick a Playbook for the task and adapt it to how you work. Each task keeps its sessions, decisions, and artifacts together, so you can follow a side question as far as it goes and still find the main task, and your progress on it, where you left them.

## Install

For **macOS on Apple Silicon** and **Linux on x86_64**:

```bash
curl -fsSL https://cdn.alinery.ai/install.sh | bash
```

Agent sessions run on Vinculum, the agent built into Alinery, so there is no separate agent CLI to install. A Terminal session is a plain shell. A repository can sit on your computer or on a Linux machine or Mac you reach over SSH.

## A different way to work

Alinery is built for slower, deeper work with AI. Human review is part of the Playbook from the start, with deliberate pauses to agree on the problem, the approach, and the tradeoffs before agents do substantial work. The aim is better outcomes and longer stretches of focus.

Work in the wrong direction still has to be reviewed, and a large pile of generated code creates pressure to salvage an approach that should be reconsidered. Agreeing early avoids most of that.

- **Organize by task.** The investigation, decisions, implementation, and review stay together as the work moves through sessions.
- **Review artifacts and code.** Chatting with an agent directly is a low-level tool for debugging and intervention. Most of your attention belongs on the work it produces and the decisions that work needs.
- **Make the process your own.** Customize Playbooks so you can understand, inspect, and steer the process the agents follow.
- **Build resonant software.** We want Alinery to be resonant software, as the [Resonant Computing Manifesto](https://resonantcomputing.org/) describes it.
- **Build confidence through process.** Much knowledge work, software design included, has outcomes you cannot know in advance. For complex, consequential tasks, a Playbook gives agents a deliberate sequence of investigation, decisions, and review, which is a better basis for trusting the result than the result alone.

[Read the project vision →](VISION.md)

## What it does

| Concept | What it gives you |
| --- | --- |
| **Task** | One place for the work, its agent sessions, decisions, and artifacts |
| **Playbook** | A reusable process with defined Steps and review points |
| **Session** | An agent or terminal session; a task can have many |
| **Artifact** | A numbered Markdown output to inspect, comment on, and use in later Steps |
| **Worktree** | An optional isolated Git checkout and branch for a task |
| **Grid** | Views of tasks grouped by their current Playbook Step |

The default **SuperDevelop** Playbook takes a change through:

```text
Clarify → Investigate → Decide → Plan → Define Tests → Build → Prepare Review
```

Review the decision before Plan starts. Other bundled Playbooks cover one-shot implementation, code review, bug hunting, and free-form sessions. **Build a New Playbook** is a Playbook for making Playbooks: it defines, drafts, and refines a new one, then saves it to your global or repository library once you approve. It is in the bundled list and the new-task picker.

**Images and files at creation.** Paste clipboard images into Description, Evidence / pointers, or the Attachments input on New task. Each image shows a preview where supported, its name and size, and a Remove button. Accepted images and files are copied into the task's `artifacts/attachments/` directory, which Task Detail's Attachments view can reveal. The limit is 25 MiB per file and 100 MiB per creation; a rejected file is reported and the valid ones stay. URLs stay pointers and are never fetched. Pasted images are not saved with text drafts: Create attaches them, and Clear draft or leaving the form discards them.

**Sessions survive app quit.** A per-repository daemon owns the agent and terminal sessions. Close the app with sessions running and they reconnect, scrollback included, when you return. Stopping them is always your choice; the quit dialog offers **Quit & close all repos** next to leaving them running.

**Editable work names.** An agent in a task session suggests a short name for its work early in an ordinary turn, once it understands the task. The working agent does this itself, with no separate naming model or upload; if the model is unavailable, the session stays unnamed. Names appear beside status in the task's session table, the global session list, the session header, and search, along with the task and execution type.

Use **Rename session** to correct the name of any retained task session, including never-started, exited, archived, and Terminal sessions, without starting it. Names are trimmed single-line text of at most 40 Unicode characters (suggested names aim for under 30). Your correction always wins over later suggestions. Names are stored apart from session lifecycle data and never change a session ID or execution state. Terminal names are manual only.

In the task table and the session header, hover the name or Tab to its pencil to edit in place. Enter saves and Escape cancels; the check and cancel buttons do the same without a keyboard. Finishing an edit returns focus to the name field and does not leave the pencil showing on the item you edited.

Task records, sessions, and artifacts live under your repository's `.alinery/` directory. The app runs locally, and product-usage telemetry is opt-in.

Browsing tasks, sessions, and the Grid reads saved metadata and each task's retained playbook, even when the repository's daemon is offline, incompatible, or was started by another Alinery version or another person. Artifact lists and saved content do not need a live daemon either. Task and session detail and the Grid use live execution data when they have it; otherwise they show validated saved progress with a notice and collapsed technical details. The app never starts, adopts, or takes over a daemon just so you can browse.

The Grid's saved-progress notice can be dismissed. It stays dismissed for the same tasks and availability states, and comes back if those change, or if live access recovers and is later lost again.

Completion grants, queued starts, and starting or recovering a primary execution still need a live daemon, with the same ownership checks. Missing live status does not prove a session stopped or finished. Missing or corrupt saved data is reported as a storage error, never shown as an empty execution or replaced with the current playbook library's version.

**GitHub pull requests.** Task detail shows a clickable indicator for the task branch's pull request: green when open, purple when merged, gray when closed without merging. Clicking opens the pull request in your browser and does nothing to the task. Lookups use your GitHub CLI connection (`gh`) in the background, at most four tasks at a time per batch. Results are shared between views and cached for 60 seconds, and refresh while a view that shows them is open and visible. A discovered pull request link survives removing the branch or worktree. A failed lookup shows an unavailable indicator, or marks the last known status stale. Compare links do not count as pull requests, and discovery is GitHub only. In the Grid, turn on **pull request** under **Card properties** to show the same icon in any card mode. It is off by default and saved per Grid view, and a disabled property or an inactive Grid tab requests no refreshes.

**Grid settings and presets.** The gear adjusts layout, filters, card properties, and tile width (up to 960px). Detailed and compact cards show every enabled property and scroll when their contents outgrow the fixed tile height. Icon-only mode hides text. Draft tasks carry a Draft label and open their saved creation form.

On a fresh workspace the default Grid view, Canvas, starts with **Progress lanes**: playbook steps left to right, every step label, no grouping, repository fill, attention borders, manual lane order, compact cards, all tasks, fixed brightness, and archives hidden. Tiles are 150 × 78px, row and column spacing is 10 and 8px, and the first column is 190px. Every card property except playbook is on. Saved Grid layouts are restored as they were, and additional Grid tabs start from the Step Kanban layout.

Type a **New preset name** and choose **Save as new preset** to reuse the current settings across repositories and Grid tabs. Select a preset you made to delete it; built-in presets cannot be deleted. Saving under another name makes a new preset and leaves the original alone. Each repository and Grid tab remembers its last settings and preset on this machine, and task-specific manual ordering and hidden lanes stay with that workspace. In column layouts, **Show empty columns** includes unoccupied columns, which you can then collapse one by one. The Existing Kanban preset has **Show empty columns** too, and uses equal-height cards that scroll when their contents overflow.

Step columns follow the declared order of each task's retained playbook, including while its daemon is offline. An older task without a retained definition is displayed with the matching playbook from the current library, which does not recover its execution state. Playbooks that share column titles keep compatible step sequences together, and conflicting orders fall back to a fixed playbook-then-task tie-break. Drag a column's grip, or focus it and press Left or Right, to reorder. A custom column order is remembered per grouping in each Grid view and saved with presets. **Reset column order** restores the default without touching task execution.

For one row per task, choose **Position model → Stable task lanes**, **Progress by → Playbook step**, and **Path labels → Every playbook step**, or select **Progress lanes**. Each row shows its own playbook's steps in declared order, with the task card under its latest recorded step. Labels show step names only, with no execution-status suffix, and stay visible when execution data is unavailable.

### Sub-tasks

A sub-task gives a side question its own place, so you can investigate it and come back to the main task knowing exactly where you left off.

Different parts of a task can use different Playbooks: investigate a question, build a change, review the result. Run sub-tasks in sequence, carry forward what works, and discard approaches that do not hold up. For consequential work, keep running review Playbooks until you are satisfied with the result.

Each task can have one active direct child, with its own worktree, sessions, and artifacts.

<details>
<summary><strong>Sub-task creation, review, and history</strong></summary>

Click **Start sub-task** on the parent to open a manager session the parent owns. The manager asks before it calls `alinery_create_subtask`. Alinery then creates the child on its own worktree and branch, based on the parent task's branch, and starts the child's first playbook step with the repository's default model unless that step names its own. The child is a complete task, can have a child of its own, and gets the immediate parent's ticket and artifact paths in every session prompt. The parent shows the active child as its manager row, and the child links back to the parent from its header. The parent's other sessions stay usable while the child holds its sub-task slot.

The manager proposes a descriptive name for the child when it asks to create it. Rename the task later from the child's heading or its row in the parent, including archived children. The child's name and the manager session's work name are independent. Renaming changes no slug, branch, worktree, relationship, or past artifact, and task names are not held to the session-name length limit.

While the child is active, the parent's artifact tree shows a live `subtasks/<child>/` folder. Call `alinery_inspect_subtask_finish` first; then `alinery_finalize_subtask`, with an explicit `artifacts_only`, `integrated_code`, or `archive_without_code` decision, replaces that folder with a fixed snapshot, archives the child, and frees the parent's slot. The parent keeps the child in its Sessions panel as **FINISHED** for artifact-only or archive-without-code work, or **MERGED** for integrated code. The Task List nests the retained lineage.

If a manager cannot continue before it creates a child, **Discard setup** removes that session. For a child that exists, **Kill sub-task** stops every live session in the active child lineage, archives those tasks as **KILLED**, and frees the parent's slot. Task records, sessions, artifacts, worktrees, branches, and the manager transcript stay as navigable history until normal archived-storage cleanup.

</details>

## Develop

On macOS, install the Xcode Command Line Tools, stable Rust, Node.js 24.15 or later on the Node 24 line, and Bun. From the repository root:

```bash
cd alinery-app
npm install
npm run tauri dev
```

`npm run tauri dev` compiles the daemon (`alinery-vinculum-daemon`) with your Bun before it launches; without Bun it prints a line and agent sessions will not start. To fetch the pinned Bun and compile the daemon by hand, run `./scripts/dev-fetch-bun.sh` from the repository root. It also builds the runtimes Alinery installs on SSH hosts: the first run downloads Bun's cross-compile targets, and a failure there only warns.

Run checks from the **repository root**:

```bash
./scripts/check.sh --quick    # lint, typecheck, tests, source gates
./scripts/check.sh            # plus slow behavioural suites
```

<details>
<summary><strong>Development instances and build notes</strong></summary>

`npm run tauri dev` launches **Alinery Dev**. It takes port `1420` when that port is free, and otherwise the next free local port, with Vite and Tauri on the same URL. Set `ALINERY_DEV_PORT` to a free port when a test needs a fixed value. Each source checkout or worktree keeps its own app state at `~/Library/Application Support/ai.delegance.alinery.dev/instances/<source-root-hash>/app.toml`, and the bottom **ALINERY SOURCE** bar shows the full path of the worktree that launched it. Separate worktrees can run at the same time against different target repositories; two instances cannot own the same target repository at once.

Builds and installs are **Alinery** and use the production `~/Library/Application Support/ai.delegance.alinery/app.toml`. A repository's data lives in its own `.alinery/` whichever app opens it, so use disposable repositories for live development writes.

The first launch compiles Rust. Native notification banners appear only from a real `.app` bundle, not from `tauri dev`.

> **Don't run `cargo update`.** `time` is pinned to `0.3.51` in `Cargo.lock`; anything newer breaks the Tauri v2 build.

</details>

## MCP Server

The MCP server is the daemon binary run with `--mcp`. Any MCP host that takes **command + args** can use it. In the app, **Settings → MCP server** has **Copy config**, which fills in the binary path and its arguments. One process serves every repository; `repo` is an argument to each tool call (a path from `alinery_list_repos`), not a launch flag. Every tool is a call on that repository's daemon.

```json
{
  "mcpServers": {
    "alinery": {
      "command": "/absolute/path/to/alinery-vinculum-daemon",
      "args": ["--mcp", "--app-config", "...", "--endpoints-file", "..."]
    }
  }
}
```

Agent sessions Alinery starts get these tools automatically.

### Authoring playbooks through MCP

- `alinery_read_playbook({repo, reference: {scope, key}})` reads the exact `bundled`, `global`, or `repo` definition, including its complete prompt source. It never falls back to another scope.
- `alinery_save_playbook({repo, target: {scope, key}, source, overwrite?})` creates or replaces a `global` or `repo` definition, parsed and saved atomically. `source` is the complete Markdown document, and its declared key must equal `target.key`. `overwrite` defaults to `false`, so replacing an existing definition needs an explicit `true`. Bundled definitions cannot be written.
- Both return the scoped playbook as JSON in the MCP text content: `source: {reference: {scope, key}, path}`, `definition`, `source_text`, and `modified_at_ms`. After a save, the path and `source_text` describe what was actually written. A failure sets `isError: true` and keeps a JSON error (`kind`, plus diagnostics, the source or reference, or a message). Bad arguments and an unknown repository report `invalid_arguments` and `invalid_repo`.

Pass a registered repository root from `alinery_list_repos`, not the agent's task worktree. Global playbooks are stored under the server's app-config identity (dev instances share one stable global root), never a path derived from the agent's HOME. A repo save goes through the repository's daemon, so it works while an Alinery window has that repository open. Global saves need no repository ownership.

**The agent is trusted to ask for approval; the backend does not check.** Review the complete source with the user and ask whether it goes to the global library (recommended) or a specific repository. Then get the user's explicit approval for that source and that exact destination, naming create or replace and, for repo scope, the repository: for example, "Save 'Incident Review' to your global playbook library (`global/incident-review`)?" or "Replace `global/incident-review` with these reviewed changes?" Save only after a clear yes. A denial or no answer means keep the draft. Any material change to the source or destination needs a new approval. A create conflict is not permission to retry with `overwrite: true`: review the existing definition and get approval to replace it first. Save accepts no approval flag or receipt.

Call `alinery_list_playbooks({repo})` to see saved entries; the app's Playbooks library and the new-task picker read the same catalog. Saves do not change preferences, create trial tasks, or alter the retained definitions of existing tasks.

## Get involved

Join the [Discord community](https://discord.gg/tgAUKEv5U) to talk about Playbooks and how you use Alinery. The project website is [alinery.ai](https://alinery.ai), bugs go in [GitHub issues](https://github.com/DeleganceAI/alinery/issues), and [VISION.md](VISION.md) explains where the project is headed.

Before contributing code, read [AGENTS.md](AGENTS.md) for the repository's engineering conventions, and run `./scripts/check.sh` before submitting a change.

## License

Alinery's original source code and documentation are licensed under the
[Apache License 2.0](LICENSE). Third-party components and adapted materials retain
their respective licenses; see [third-party notices](THIRD-PARTY-NOTICES.md) and
any accompanying license files. See [NOTICE](NOTICE) for copyright information.
