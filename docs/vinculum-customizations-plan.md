# Vinculum customizations, skills, and MCP

Status: implemented on this branch. This is a working note, not a product contract. `README.md` is human-edited and is not the place for it.

The Harness page still has the OMP customizations block: open the configuration folder, copy instructions for an outside AI, and a list of installed skills, extensions, MCP servers, and plugin packages. That block has to stay, and it has to describe Vinculum. Vinculum's agent runtime is pi-durable (`@earendil-works/pi-durable` 1.3.0), from the Pi project. It is not OMP, and this build does not ship an OMP binary.

A skill or MCP row in that list does nothing for a session today. The list reads the old OMP agent directory, and the daemon never opens it. This work moves that directory to `vinculum`, makes skills real, connects MCP servers including the built-in `alinery-mcp`, lists the daemon's actual tools, and rewrites the copied instructions. User extension code stays listed and unloaded.

## What the block does now

`OmpCustomizations` in `alinery-app/src/views/OmpCustomizations.tsx` sits under Providers on the Harness page (`Settings.tsx`). It calls three commands:

- `read_omp_customizations` scans the installation agent directory and, when it can, runs the packaged OMP binary.
- `open_omp_config_dir` creates that directory and reveals it.
- `omp_customization_prompt` runs `omp --version` and pastes a prompt that tells another AI how to edit an OMP v18 install.

The agent directory is `omp_home_dirs` in `alinery-core/src/paths.rs`: the directory that contains `app.toml`, then `omp/config/agent`. `PI_CONFIG_DIR` was the `config` parent. That was the isolated Pi/OMP home. It is not `~/.pi/agent` and not a project `.pi/` directory. On disk for this dev install that is `~/Library/Application Support/ai.delegance.alinery.dev/omp/config/agent`.

`omp_customizations.rs` inventories only that directory. It does not execute extension code, and it never puts command lines, env values, headers, or frontmatter bodies into the result. A parser error is a path plus a fixed reason. Tests in `src/tests/omp_customizations.rs` lock that down, including that a secret inside a broken file must not appear in the JSON.

What it records:

| Kind | Where | Rule |
|---|---|---|
| Skill | `skills/<dir>/SKILL.md` | One directory level. Nested `skills/a/b/SKILL.md` is ignored. A symlink to a skill directory counts. The display name is frontmatter `name`, else the directory name. A skill with no frontmatter still counts as installed. |
| Extension | `extensions/*.ts`, `extensions/*.js`, or a package with `index.ts` / `index.js`, an `omp` or `pi` extension list, or `gemini-extension.json` | Metadata only. The file is not imported. |
| MCP server | `mcp.json` and `.mcp.json`, keys of `mcpServers` | Name and file path only. A non-object value is still listed, plus an error. |
| Plugin package | `omp plugin list --json` | npm and user-scoped marketplace packages. Project scope is dropped. |
| Built in | two hard-coded rows | "Alinery runner integration" and an `alinery` MCP server, both "injected at session launch". |

The plugin rows and the copy button need the packaged OMP binary (`resolve_packaged_omp_path`). This version does not ship one. The inventory then always carries "Packaged OMP is unavailable; package discovery is incomplete.", and Copy instructions fails before it can put anything on the clipboard.

The two built-in rows describe the old runner. It materialised an extension and a repo `.mcp.json` into the OMP process. That runner is gone. Vinculum registers three in-process extensions in `vinculum-daemon/src/main.ts`: coding tools (read, write, edit, bash), `alinery_phase_complete`, and `alinery_set_session_name`. None of them is a file in the agent directory, and none of them is the `alinery-mcp` process.

`alinery-mcp` has two launches today, and neither one feeds the Vinculum session. With no `--serve` flag it is a stdio MCP server (`tools/list`, `tools/call`) whose tools are `alinery_list_repos`, `alinery_list_tasks`, `alinery_get_task`, `alinery_create_task`, `alinery_list_sessions`, `alinery_create_session`, `alinery_start_session`, `alinery_send_review_handoff`, `alinery_list_playbook_steps`, `alinery_get_task_execution`, `alinery_session_status`, `alinery_read_session_history`, `alinery_list_artifacts`, `alinery_read_artifact`, `alinery_read_config`, `alinery_write_config`, `alinery_list_playbooks`, `alinery_read_playbook`, `alinery_save_playbook`, `alinery_create_subtask`, `alinery_inspect_subtask_finish`, `alinery_finalize_subtask`, `alinery_archive_task`, `alinery_storage_info`, `alinery_delete_archived_storage`, and `alinery_backup_now`. The app also spawns it as `--serve --managed` on a unix socket for the desktop status child. That socket child is not the session's tool list, and it dies with the app. Settings still tells Cursor and other hosts how to launch the stdio binary. That host-install block stays. The session gets its own stdio child.

The daemon's real tools, registered in `vinculum-daemon/src/main.ts`, are `read`, `write`, `edit`, `bash`, `alinery_phase_complete`, and `alinery_set_session_name`. The first four come from pi-durable. The write tool also accepts `xd://alinery_phase_complete` as the same completion request. The phase tool and the naming tool are registered for every conversation; naming returns an error on a chat, and the phase tool has nothing to complete there.

Model roles still read and write `modelRoles` in the agent directory's `config.yml` through `read_omp_model_roles` / `write_omp_model_roles`. Vinculum does not read that file. Those commands stay, and they follow the directory rename below so they do not keep writing under `omp/`.

## What Pi actually loads

Pi's coding agent (`@earendil-works/pi-coding-agent`) discovers resources from an agent directory. The layout matches the directory this app already scans. From Pi's configuration and skills docs:

- `skills/` holds directories that contain `SKILL.md`. Discovery is recursive. Pi also looks at `~/.agents/skills/` and project `.agents/skills/`. Vinculum should not. This installation has one agent directory, and project trust is a Pi CLI concern this app does not have.
- A skill's frontmatter follows the Agent Skills spec. `name` and `description` are what the model sees. Pi puts the name, the description, and the path into the system prompt. It does not paste the body. The model reads `SKILL.md` when the task fits. A skill with no description is not offered to the model. `disable-model-invocation: true` hides it from that offer and leaves it for an explicit command.
- Names are lowercase letters, numbers, and hyphens, at most 64 characters, with no leading, trailing, or doubled hyphen. Descriptions are at most 1024 characters.
- `mcp.json` holds `mcpServers`. Pi connects over stdio or streamable HTTP and turns the server's tools into agent tools. Entries can carry commands, env, and headers. Those stay out of any UI and out of any copied prompt.
- `extensions/` holds user code Pi loads into its process.

pi-durable does not do any of that discovery. Its registry is whatever the process calls `registry.install` with. A prompt section is a function (`section(name, input => text)`), evaluated when a turn is prepared, so a section can re-read the skills directory without restarting the daemon and without a new socket op.

Do not add `@earendil-works/pi-coding-agent` to get this. That package is a second agent loop, with its own sessions, auth file, and tool runtime. Vinculum already owns those through pi-durable. Use Pi's file layout and its skill prompt rule. Do not embed its session.

## What to build

### The directory is `vinculum`

Replace `omp_home_dirs` with `vinculum_home_dirs`. The agent directory is the directory that contains `app.toml`, then `vinculum/config/agent`. The config root next to it is `vinculum/config`. For this dev install that is `~/Library/Application Support/ai.delegance.alinery.dev/vinculum/config/agent`. It is still not `~/.pi/agent` and not a project `.pi/`.

Every current caller moves with it: the customization scanner, the open-folder command, the copied prompt, `models.yml` (`hosted_inference.rs`), the hosted writer in `hosted.rs`, model-role read and write, and `omp_agent_sessions_dir`. Nothing in this tree keeps reading `omp/config/agent`.

On first use, if `vinculum/` does not exist and `omp/` does, rename `omp` to `vinculum`. That one rename keeps skills, `mcp.json`, extensions, `models.yml`, and `config.yml`. If `vinculum/` already exists, leave `omp/` where it is and do not read it, merge it, or delete it. Do not rename `omp_alongside_dir` or `/Applications/Alinery.omp`. That path was the OMP binary, which this version does not ship.

The daemon computes the same path from `--app-config`: parent directory, then `vinculum/config/agent`. A comment points at `vinculum_home_dirs`. Do not add an FFI call just to return a path.

### Inventory

Keep the scanner's safety rules: one file at a time, no execution, no secret fields in the result, a bad file is an error plus a best-effort row, a missing directory is an empty install rather than a failed page.

Stop running a binary. Delete the plugin-package path (`append_omp_plugin_inventory`, the `omp plugin list` spawn, and the "package discovery is incomplete" error). Pi packages are a coding-agent CLI feature. Listing them here would claim Vinculum loaded something it cannot see.

The built-in tool rows are the daemon's real tool names, one row each, with no path. The daemon reports them. The UI does not keep a second copy. If the daemon is not running, the group says the session daemon is not running instead of inventing the list.

| Name | Kind | Source |
|---|---|---|
| `read` | Tool | Vinculum daemon |
| `write` | Tool | Vinculum daemon. A write to `xd://alinery_phase_complete` is the phase tool. |
| `edit` | Tool | Vinculum daemon |
| `bash` | Tool | Vinculum daemon |
| `alinery_phase_complete` | Tool | Vinculum daemon. Completes the current playbook execution. A chat has none. |
| `alinery_set_session_name` | Tool | Vinculum daemon. Task sessions only. A chat title is a separate side request. |

Skills, user MCP servers, and extensions stay as file rows. Scan skills one level deep (`skills/<name>/SKILL.md`). Upload writes that shape, so the list and the daemon agree. A hand-nested skill stays invisible. Pi's recursive scan can wait.

Group the on-screen list by kind, in this order: Built-in tools, MCP servers, Skills, Extensions. The MCP group always has the built-in `alinery` row, then the servers from `mcp.json` and `.mcp.json`. An empty user list still shows `alinery`, not "No MCP servers." Extensions stay read-only and unloaded. The scope line says these files live in this installation's `vinculum` agent directory, not project `.pi` and not `~/.pi`.

### MCP servers the session can call

The daemon is the MCP client. Do not add `@earendil-works/pi-coding-agent`, and do not reuse the app's `--serve` socket. That socket is the desktop's managed child. The session daemon outlives the app, so it starts its own processes.

Built-in server, always, not a row in the user's `mcp.json`:

- Name `alinery`. Spawn the `alinery-mcp` binary beside the app (the same resolution `resolve_mcp_path` uses: a sibling `alinery-mcp` or `alinery-mcp-<triple>`, else `target/debug/alinery-mcp`).
- Stdio, no `--serve`. Pass `--app-config` and `--repo` for the daemon's repo. One process for that daemon.
- `registry.install` replaces an extension of the same name. Install `mcp:alinery`. Each tool is `mcp__alinery__<tool name>` (`mcp__alinery__alinery_list_tasks`, and the rest of `tools/list`). pi-durable already treats that prefix as an MCP server. Do not rename the underlying tools.
- A missing binary does not stop the daemon. The row stays, with the error, and the extension is not installed.

User servers, from `mcp.json` then `.mcp.json` in the agent directory. A later file overrides the same name. `alinery` as a user key is ignored, so a file cannot replace the built-in.

- A stdio entry (`command`, optional `args`, `cwd`, `env`) is spawned with the environment cleared, then the allowlist, then that entry's `env`. Do not log the command, the args, or the env. Relative `cwd` is the daemon's repo.
- A `url` entry is streamable HTTP. Headers are sent and never logged. OAuth is not implemented. A server that requires it stays in the list as not connected, with that reason. No browser login in this work.
- `enabled: false` stays in the list as disabled and is not spawned.
- Each connected server is extension `mcp:<name>`, tools `mcp__<name>__<tool>`. `tools/list` runs at connect. `tools/call` forwards the model's arguments and returns the content. A failed start is an error on that row only. One bad server must not kill the others or the socket.
- `registry.install` of the same extension name replaces its tools. The harness reads the registry snapshot, so the next turn sees a server that connected after the conversation opened. A turn already in flight does not.

The file scan stays in the app and works while the daemon is down. Connection state does not. New socket op `vinculum_customizations` returns the built-in tool names and, for each MCP server, the name, whether it is the built-in, `connected` or `disabled` or `error`, and a fixed error string. No command, url, header, or env. The app command proxies it. This bumps `PROTOCOL_VERSION`. The page merges that reply onto the file inventory. Refresh asks again. The daemon also re-reads `mcp.json` when the op runs, stops a server that disappeared, and starts one that appeared. Skill upload does not need this op.

### Skills the session can use

Add one prompt section in the daemon, installed beside the coding, phase, and naming extensions. On each turn it reads `<agent>/skills/*/SKILL.md` and returns a short catalog:

- Skip a file that is not valid skill frontmatter, has no `name`, or has no `description`. The Settings list still shows it. The model does not.
- Skip `disable-model-invocation: true`. The Settings list still shows it, marked as not offered to the model.
- For the rest, one block per skill: name, description, and the absolute path of `SKILL.md`. Tell the model to read that file with the read tool when the skill applies, and to treat paths inside it as relative to the skill directory.
- Do not include the body, the frontmatter source, or any other file in the skill directory.
- Cap the catalog (64 skills, descriptions already capped at 1024 by the spec). Past that, say the rest were omitted. A huge directory must not become the system prompt.
- A name collision keeps the first path in directory order and skips the later one. The Settings list can still show both.

The skill section reads disk. It does not need its own socket op. Upload and delete are app commands. A session that is already open sees a new skill on its next message. A turn already in flight does not. The protocol bump below is only for the MCP status op.

There is no `/skill:name` command in this slice. Pi's TUI has one. Chat can already ask the model to read a path. Adding a slash command is a later change.

### Upload and delete

Add a Skills block on the same page, above the grouped inventory. Two actions: upload, and delete on each skill row.

Upload uses the existing file dialog (`tauri_plugin_dialog`, the same shape as `pick_attachment_files_dialog`), one file, extensions `md` and `zip`. The app crate does the write. `zip` 8.6 is already pinned in `alinery-core` with `deflate-flate2-zlib-rs` and the extra compressors off. Declare that same dependency on the app crate rather than pulling another unzip library. Do not shell out to `unzip`.

A `.md` file must start with YAML frontmatter that has `name` and `description`. Install it as `skills/<name>/SKILL.md` and nothing else. Reject a missing name, a name that is not the Agent Skills shape, or a missing description, and say which rule failed. Do not invent a description. A file that is not frontmatter is not a skill; the hand-placed inventory can still show those, but upload will not create another one.

A `.zip` must be one skill:

- Either `SKILL.md` at the archive root, or a single top-level directory that contains `SKILL.md`. `scripts/`, `references/`, and `assets/` next to it are kept. Any other shape is rejected.
- Reject `..`, absolute paths, drive prefixes, and empty or oversized names before writing anything.
- Reject symlinks and hard links. Do not follow them and do not recreate them.
- Caps: 25 MiB compressed, 25 MiB total uncompressed, 8 MiB on any one file, 200 files. Stop at the first cap. These match the spirit of the attachment caps and are there to refuse a zip bomb, not to support large assets.
- The installed name comes from the frontmatter, not from the zip's folder name. The same name and description rules as a bare `.md` apply. A zip whose frontmatter is bad installs nothing.

If `skills/<name>` already exists, ask with `askConfirm` before replacing. Cancel writes nothing. Replace removes that skill directory only, then extracts. Two uploads never merge.

Delete is `confirmDanger`, defaulting to the safe choice. It removes `skills/<name>` only when that directory's real path is still inside `skills/`. If the row is a symlink, unlink the symlink and do not delete the target. There is no delete for MCP servers, extensions, or the built-in rows.

After a successful upload or delete, refresh the inventory. Do not restart the daemon.

### Copy instructions

`omp_customization_prompt` must not run a binary. Build the text from the installation id, the app-config path, and the agent directory. Copy keeps working on a machine with no OMP binary.

The text should say:

- This is the Vinculum harness in this Alinery installation. Its agent runtime is pi-durable, from Pi (`@earendil-works/pi-durable`). It is not OMP. There is no OMP binary to run, and `~/.pi` and `~/.omp` are the wrong directories.
- The agent directory path, shell-quoted, is the only place to edit. Skills that sessions load live at `skills/<name>/SKILL.md`. The model is told the name, description, and path. It is not given the body. It reads the file.
- `mcp.json` and `.mcp.json` in that directory are user MCP servers. The daemon connects stdio and streamable HTTP. It does not do OAuth. The `alinery` key is reserved. Do not add a server and claim it replaced the built-in.
- Extensions under `extensions/` are listed and not loaded. Do not add one and claim the session picked it up.
- The daemon's own tools are `read`, `write`, `edit`, `bash`, `alinery_phase_complete`, and `alinery_set_session_name`. They are not files. Do not look for them in the agent directory.
- Inspect locally first. Do not print, copy, or upload secrets. Back up a file before editing it. `mcp.json` may contain commands, env, and headers; do not echo those values. Do not read credential stores into the reply.
- Point at Pi's own docs for the file format: the skills and MCP pages in `earendil-works/pi` `packages/coding-agent/docs/`. Name pi-durable 1.3.0 as the runtime this installation embeds. Do not link `can1357/oh-my-pi` or pin the instructions to OMP v18.1.13.
- The example commands are `find` of names (`SKILL.md`, `mcp.json`, `package.json`) from the agent directory. They do not dump file contents and they do not call `plugin list`.
- Alinery still clears the session environment. A key exported in the shell is not a Vinculum credential. Do not put a secret in the prompt. Provider sign-in is the Accounts list, not `models.yml`.
- Drop the lines about preserving `providers.alinery` in `models.yml`, `modelRoles` in `config.yml`, and the injected runner extension. Those are the old harness.

The button label stays "Copy instructions for an AI". The hint under the heading stops saying "this OMP installation" and says Vinculum, whose agent runtime is Pi.

### Names

Rename the UI component and the Rust module off `omp_customizations`. New commands: `read_vinculum_customizations`, `open_vinculum_agent_dir`, `vinculum_customization_prompt`, `install_vinculum_skill`, `delete_vinculum_skill`, and `vinculum_customizations` for the daemon status reply. Register them in `lib.rs` and add typed wrappers in `ipc.ts` only. `check-ipc-boundary.sh` and `check-ipc-commands.sh` already require that. Remove the three old command names in the same change so the handler list does not keep an OMP alias.

Leave `read_omp_model_roles`, `write_omp_model_roles`, and `omp_agent_sessions_dir` registered. They are the model-role leftover, not this list.

`vinculum_customizations` is a new socket op, so bump `PROTOCOL_VERSION`. The bump script and `vinculum_request_shapes` move with it. No other reply changes.

### Tests

- Rust: move the inventory tests onto the new scanner. Keep the secret-redaction cases, the partial-error cases, and the "do not execute the extension" case. Delete the plugin-list and CLI-timeout tests with the spawn they covered. Add upload tests: a valid `.md`, a `.md` without a description, a zip with one skill directory, a zip with `../`, a zip with a symlink entry, a zip over the file cap, replace-versus-cancel, and delete that unlinks a symlink without removing the target.
- Daemon: a skills-section test with one valid skill, one without a description, one with `disable-model-invocation`, and a second skill that collides on the name. The prompt text contains the valid skill's path and description and none of the body. An MCP test that answers `initialize` and `tools/list` on stdio and checks the registered name is `mcp__<server>__<tool>`. A second server that exits immediately leaves the first installed. The built-in name `alinery` is not taken from a fixture `mcp.json`.
- UI: the grouped list shows `read` and the `alinery` MCP row even when `mcp.json` is empty, upload and delete call the new wrappers, and the copied hint no longer says OMP.

`cargo check -p alinery-app` after the Rust edits. `bun test` for the new daemon tests and `bun build src/main.ts --target bun`. The vitest file for the component. Not `./scripts/check.sh` unless asked.

User extensions stay unloaded. A `SKILL.md` is text the model reads. An extension would run in the daemon, beside the coding tools. Loading one means a runtime import of a path outside the compiled binary. Do not start that here.

## Out of scope

- `omp_alongside_dir` and the old OMP binary location.
- Reading `modelRoles` from `config.yml` into a Vinculum session. The file moves with the directory; the session still ignores it.
- Project `.pi/`, `~/.pi/agent`, and `~/.agents/skills`.
- Pi packages, npm plugins, and marketplace installs.
- A `/skill:name` slash command.
- MCP OAuth and browser login.
- The Settings block that tells Cursor and other hosts how to launch `alinery-mcp`. The session's built-in server is a separate stdio child.
- Changing the harness key stored on session meta. It stays `omp` until asked.
