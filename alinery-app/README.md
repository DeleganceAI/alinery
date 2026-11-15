# alinery-app

The Alinery desktop app: tasks run as playbooks, each in its own git worktree, with agent sessions that keep running after you quit. Runs on macOS and Linux. A repository can sit on this computer or on a Linux machine or Mac you reach over SSH.

## Using the app (quick start)

1. **Pick a repo** on the setup screen, on this computer or an SSH host. Alinery keeps everything under `<repo>/.alinery/`.
2. **Create a task** (`⌘N` or New task). It gets a slug, an optional description, a playbook, and its own worktree on a branch named after the slug.
3. **Open the task.** The header shows the current playbook step; artifacts and sessions open as tabs, the Files panel browses the worktree, and the Git tab shows its changes.
4. **Sessions** run on Vinculum, the agent built into Alinery's per-repository daemon. The daemon keeps a session running when you quit the app; reopening reattaches and replays its scrollback. A Terminal session is a plain shell in a real PTY.
5. **Artifacts** are the numbered markdown files each step writes. Read and comment on them in the task, or through the MCP tools.
6. **Settings** holds model providers, GitHub and Linear connections, SSH hosts, the repository's config, notifications, backups and the MCP server.

### Blocking sub-tasks

Each task can own one active direct child. **Start sub-task** creates or opens a parent-owned
manager session; the manager must ask before calling `alinery_create_subtask`. Alinery derives the
parent, base branch, and worktree from that manager ID, creates a proper child task with a
dedicated worktree based on the parent's explicit branch, and starts the first playbook step with
the repository's default model unless that step names its own. The parent shows the active child
in its Sessions panel. The child links back through its header and lists only its own sessions.
The parent remains usable for ordinary sessions, but cannot start another direct child until the
active child finishes.

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

The three lifecycle tools are filesystem and git control calls. Child creation also starts exactly
the new child's initial playbook session. Finish inspection only observes existing session IDs as
advisory warnings; it does not attach to, write to, or stop those sessions.

### Step completion

Completion is explicit. The step's prompt tells the agent to save its assigned artifacts and then
call `alinery_phase_complete`, and to go on only when Alinery reports that it accepted them. A
rejection names the invalid artifact or the stale session ownership, so the agent can fix it and
call again. The playbook engine records the accepted outputs once and starts the next eligible step
once. An artifact's presence, age, or stability never implies completion.
`docs/playbook-design-guidance.md` has the full rules.

## Running the app

```bash
cd alinery-app
npm install
npm run tauri dev          # dev mode
# or
npm run tauri build        # production bundle
```

`npm run tauri dev` launches **Alinery Dev** with identifier `ai.delegance.alinery.dev` and app
config under `~/Library/Application Support/ai.delegance.alinery.dev/`. `build` and every other
non-`dev` Tauri command use **Alinery**, `ai.delegance.alinery`, and the production config path.
Each source checkout or worktree gets its own development config under
`ai.delegance.alinery.dev/instances/<source-root-hash>/`. A repository's `.alinery/` data is the
same whichever app opens it, so use disposable repositories for live testing.

The built app lives in `src-tauri/target/release/bundle/`.

### Connections

GitHub signs in through the browser. Linear uses OAuth PKCE with the Delegance Alinery OAuth app,
whose callback is `http://127.0.0.1:43119/oauth/linear/callback`. Set `ALINERY_LINEAR_CLIENT_ID`
only if you use a different Linear app.

## MCP server

The MCP server is the daemon binary started with `--mcp`. It exposes Alinery's tasks, sessions,
artifacts, and settings to any MCP client (Claude Desktop, Cursor, and the like). Every tool is a call
on the repository's daemon, made with a token the app mints; it writes nothing in `.alinery/` itself.

### Stdio host config (Claude Desktop, Cursor, …)

**Settings → MCP server** shows whether the binary is ready and a **Copy config** button that fills
in the binary path and its arguments. One process serves every repository; `repo` is a per-call tool
argument (a path from `alinery_list_repos`), not a launch flag. If the host already has other
servers, **merge** the `alinery` entry; do not overwrite the whole `mcpServers` object.

```json
{
  "mcpServers": {
    "alinery": {
      "command": "/path/to/alinery-vinculum-daemon",
      "args": ["--mcp", "--app-config", "...", "--endpoints-file", "..."]
    }
  }
}
```

| Host | Config file (macOS) |
|------|-------------|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` and/or project `.cursor/mcp.json` |

`alinery-vinculum-daemon` sits next to the Alinery executable in a bundle; in dev it is under
`src-tauri/target/debug/` (or `release`). Restart the host after editing its MCP configuration.

Tools are whatever the binary reports through `tools/list`; do not rely on a fixed count. Session
tools can create playbook-step or auxiliary rows with additional instructions, start them, observe
their state, and read their history. Sessions an MCP client starts outlive its disconnect, because
the daemon owns them.

Local repositories are read and write; remote ones are discovery only. No MCP mode offers
interactive session control: no attach, input, resize, detach, kill, resume, takeover, or bulk
orchestration.

### Sessions Alinery starts

Every Vinculum session gets the Alinery tools from its own daemon. You do not add Alinery MCP to it
by hand.

### Advanced: the app-managed socket

While a repository is active and the managed toggle is on, the app runs
`alinery-vinculum-daemon --mcp --serve --managed` on `<repo>/.alinery/mcp.sock`. It stops when you
quit Alinery or switch repositories. It is for debugging and same-machine tools, not the install
path for desktop hosts. See **Settings → MCP server → Advanced**.
