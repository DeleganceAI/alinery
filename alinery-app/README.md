# alinery-app

Desktop UI for the Alinery task-centric AI coding playbook (kanban, persistent PTY sessions via `alineryd`, worktrees, playbook phases). Runs on macOS.

## Using the app (quick start)

1. **Pick a repo** on first launch (or via the repo switcher). Alinery stores everything under `<repo>/.alinery/`.
2. **Create a task** (`⌘N` or the “+” button) — gives it a slug, optional description, and an automatic git worktree on its own branch.
3. **Open the task** → Kanban shows its current playbok phase. Click any phase to spawn a session.
4. **Session view** runs the chosen harness (claude / codex / …) in a real PTY via xterm.js. The session keeps running in `alineryd` even if you quit the app; reopening re-attaches.
5. **Artifacts** are written after each phase. Use the artifact list or MCP tools to read them.
6. **Settings** (gear) manages browser-based GitHub/Linear connections plus repository config, harnesses, and notifications.

### Blocking sub-tasks

Each task can own one active direct child. **Start sub-task** creates or opens a parent-owned
manager session; the manager must ask before calling `alinery_create_subtask`. Alinery derives the
parent, base branch, and worktree from that manager ID, creates a proper child task with a
dedicated worktree based on the parent's explicit branch, and starts the first playbook step with
the repository's effective default harness and model unless that step specifies its own harness.
The parent shows the active child in its Sessions panel. The child links back through its header and
lists only its own sessions. The parent remains usable for ordinary sessions, but cannot start
another direct child until the active child finishes.

Every child session prompt identifies its immediate parent ticket and artifact directory. The
parent's artifact tree exposes the active child's files through a live logical
`subtasks/<child>/` folder. After `alinery_inspect_subtask_finish`, the manager must choose
`artifacts_only`, `integrated_code`, or `archive_without_code` explicitly when it calls
`alinery_finalize_subtask`. A successful finalization atomically replaces the live view with a
snapshot, archives the child, and clears the parent pointer. The child remains in the parent's
Sessions panel as **FINISHED** for artifact-only or archive-without-code work, or **MERGED** for
integrated code. Nested children remain in the snapshot.

**Kill sub-task** stops the active child lineage and archives it as **KILLED** without deleting its
task records, sessions, artifacts, worktrees, branches, or manager transcript. The historical row
still opens the archived child and its manager when present. **Discard setup** remains the
hard-delete path for a manager that never created a child.

The three lifecycle tools are filesystem/Git control calls. Child creation also starts exactly the
new child's initial playbook session through the manager's existing daemon lane. Finish inspection
only observes existing daemon session IDs as advisory warnings; it does not attach to, write to, or
stop those sessions.

### Harness state and phase completion

`alineryd` remains the PTY/process authority. For an OMP session it launches through the
exec-only `alinery-runner`, which injects Alinery's bundled run-local OMP extension. The extension
reports typed agent events over the existing daemon socket, so the UI can distinguish
in-progress, idle, waiting for input (`WI`), and waiting for approval (`WA`) without parsing
terminal bytes.

OMP is the only semantic adapter in v1. Claude, Codex, opencode, DS4, Grok, and custom
harnesses still launch normally and remain interactive, but display `! Unsupported`; they
do not emit semantic notifications or auto-advance.

Playbook completion is explicit: the OMP prompt must call `alinery_phase_complete` after writing
the assigned artifact and continue only when the tool reports that Alinery accepted it. Rejections
identify invalid artifacts or stale session ownership so OMP can repair and retry; delivery
failure is reported separately. `alineryd` persists one semantic checkpoint and creates an enabled
next phase exactly once. Artifact presence, age, or stability never implies completion.

For full walkthroughs, screenshots, and troubleshooting see the top-level [`README.md`](../README.md) and [`alinery-app/VERIFY.md`](VERIFY.md).


## Running the app

```bash
cd alinery-app
npm install
npm run tauri dev          # dev mode
# or
npm run tauri build        # production bundle
```

`npm run tauri dev` automatically launches **Alinery Dev** with identifier
`ai.delegance.alinery.dev` and app config
`~/Library/Application Support/ai.delegance.alinery.dev/app.toml`. `build` and every other
non-`dev` Tauri command use **Alinery**, use `ai.delegance.alinery`, and keep the existing production
config path. The development config is global to development launches, not per worktree;
repository-local `.alinery/` data is unchanged, so use disposable repositories for live testing.

The built app lives in `src-tauri/target/release/bundle/`.

### Provider connections

GitHub connection uses the installed `gh` CLI and its system credential store. Linear uses OAuth PKCE and the macOS Keychain. The Delegance Alinery OAuth app is already registered with callback `http://127.0.0.1:43119/oauth/linear/callback`. Override with `ALINERY_LINEAR_CLIENT_ID` only if you are using a different Linear app.

## MCP server (alinery-mcp)

`alinery-mcp` exposes Alinery tasks, sessions, artifacts, and settings to any MCP client
(Claude Desktop, Cursor, etc.). **Primary install for Desktop hosts is stdio** — see also the
[root README 2-minute guide](../README.md#connect-mcp-claude-desktop--cursor--2-minutes).

### Stdio / host config (recommended for Claude Desktop, Cursor, …)

Point the host at the absolute `alinery-mcp` binary. One process serves every repo; `repo` is a
per-call tool argument (a path from `alinery_list_repos`), not a launch flag. If the host already
has other servers, **merge** the `alinery` entry — do not overwrite the whole `mcpServers` object.

```json
{
  "mcpServers": {
    "alinery": {
      "command": "/path/to/alinery-app/src-tauri/target/release/alinery-mcp"
    }
  }
}
```

**macOS host files:**

| Host | Config file |
|------|-------------|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` and/or project `.cursor/mcp.json` |

Binary locations: `alineryd`, `alinery-runner`, and `alinery-mcp` are sibling sidecars next to the Alinery
app executable in a bundle; in dev they live under `src-tauri/target/debug/` (or `release`).
Restart the host after editing MCP configuration.

In the running app, **Settings → MCP Server** shows a binary readiness chip, the full envelope,
and **Copy config**. Path ⧉ buttons and the managed socket live under **Advanced**.

Or run directly:

```bash
alinery-mcp
# then speak JSON-RPC over stdio; repo is a per-call tool argument
```

Tools are whatever the current binary reports through `tools/list`; do not rely on a fixed count. Session tools can create playbook-step or auxiliary Generic rows with additive instructions, optionally start them through the detached daemon, start an eligible existing row by task/session ID, observe structured state, and read bounded screen or raw history. Started PTYs outlive stdio-host disconnects because `alineryd` owns them.

Local repos are read/write; remote repos are discovery-only. Stdio works without the Alinery window. Neither stdio nor managed mode exposes interactive PTY control: no attach, input, resize, detach, kill, resume, takeover, or bulk orchestration. The MCP client owns filtering, batching, and any merge policy.

### Alinery-launched OMP sessions

Alinery automatically mounts a repository-scoped `alinery-mcp` stdio server in every OMP session it
launches. `alinery-runner` supplies OMP with a private extension package containing both the Alinery
extension and its `.mcp.json`; you do not need to add Alinery MCP to OMP manually. New sessions pick
up rebuilt sidecars after the repository daemon restarts.

### Advanced — app-managed socket

When a repo is active and the managed toggle is on, the app can spawn an `alinery-mcp --serve` child
at `<repo>/.alinery/mcp.sock`. That child dies when you quit Alinery or switch repos. It is **optional
for Desktop hosts** and is not the default install path (debugging / same-machine tools only).
See Settings → MCP → **Advanced — managed socket**.
