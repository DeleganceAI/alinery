# Repo load isolation

Status: not started. A plan only. Do not treat a bad task or session file as a reason to fail the repository.

This is a working note, not a product contract. `README.md` is human-edited and is not the place for it.

## Goal

Opening a repository that already contains tasks must keep working when one of those tasks, or one session inside a task, cannot be parsed. The bad record stays visible, with the failure text on that task. Every other task still lists. Creating a new task still works.

This does not require old session files to keep parsing. It does require that an old or corrupt file cannot take down the repo.

## What fails the repo today

`list_tasks_for_repo` in `alinery-app/src-tauri/src/task.rs` reads every `task.md` and returns `Err` on the first file that will not parse. `list_board_tasks` then returns that error. `TaskList`, `Grid`, and `Kanban` catch it as "Couldn't load tasks." or "Couldn't load the board." Search does the same with `list_board_tasks` plus `list_session_items`.

`list_sessions_in_dir` in `alinery-app/src-tauri/src/session.rs` does the same for `*.meta.json`. The first file that is not a `SessionMeta` fails the directory. `board_task` uses that result with `?`, and `board_tasks_from_loaded` collects with `?`, so one bad session hides every task in the repo. Inside the bad task, a good session beside the stub is hidden too. `TaskDetail` already isolates the `list_sessions` rejection from the task header, but it still replaces that task's session list with one warning.

`SessionMeta` requires `worktree` and `created`. The stubs on disk are only `id`, `started_at`, `harness`, `harness_resume_token`, and `model`. `openSession` in `vinculum-daemon/src/main.ts` writes exactly that when `readMeta` finds no file: it falls back to `{ id }`, then patches those fields, and never writes `worktree` or `created`. Chat sessions go through `createExecutionSession`, which writes both fields first, so the chat list parses. A shell that exits through `writeMeta` can create the same kind of stub, because spawn does not write a meta and the exit patch is only `ended_at`.

`retained_task_definition` and `validate_task_relationship_fields` have the same blast radius. A missing or corrupt `playbook.md` / `execution.json`, or one bad parent or child link, fails `board_tasks_from_loaded` before any row is returned. `durable_discovery_reports_task_scoped_storage_errors` locks that in on purpose, so a corrupt file is not dropped silently. Keep that visibility. Stop using a repo-level error to get it.

A directory that cannot be read at all (`read_dir` on `.alinery/tasks` fails) is still a repo-level error. One bad file inside it is not.

`alinery-core::list_tasks_for_repo` already skips an unparseable `task.md` by returning `None`. Do not copy that. The app list must show the failure, not drop the directory. MCP `alinery_list_tasks` uses the core skip; leave MCP alone unless a caller starts failing closed.

## Listing rule

One file, one fault. The list command stays `Ok`.

- A `task.md` that will not parse becomes a board row whose only identity is the directory name. `load_error` is the parse error, including the path. The row is not openable, archivable, or duplicable. It is not a task the user can run.
- A task that parses, but whose retained playbook or `execution.json` will not load, stays a real row. `load_error` carries that error. Playbook steps for that row are empty. Sibling tasks are unchanged.
- A relationship error names the tasks it mentions and is stored on those rows. It does not reject the board. Create, archive, and sub-task mutation stay fail-closed; only listing relaxes.
- A `*.meta.json` that will not parse is omitted from the session vector and appended to that task's `session_faults` (`id` from the file name, path, error). Sessions in the same directory that do parse stay in the list and still drive `current_phase`, `session_count`, and the session table.
- `list_sessions` returns the good sessions plus `session_faults` for that task. `list_session_items` skips fault files and still returns every good session, including a good session that shares a directory with a stub. The task row is what surfaces the stub.
- Empty `load_error` and empty `session_faults` serialize as absent, so a healthy board payload does not grow new required JSON.

`list_board_tasks` stays `Vec<BoardTask>`. Add the two fields to `BoardTask` rather than wrapping the command in a new type. `list_sessions` grows a small reply struct because a fault is not a `SessionMeta` and must not be flattened into one.

Do not fill in `worktree` or `created` while reading. An existing stub stays a fault until the file is replaced. Rewriting it on read would hide the failure this plan is supposed to show.

## Writer rule

A new session file must already be a `SessionMeta`.

`writeMeta` is the one writer. When the file does not exist, the object it writes includes `id`, `worktree`, and `created` before any patch. `worktree` is the task worktree when the task has one, otherwise the repo path. `created` is the current unix second. A later patch of a file that already parses merges as it does now. A later patch of a file that does not parse does not invent the missing fields; the stub stays a fault.

`openSession` and the shell spawn path both go through that. Spawn writes the meta when the shell starts, not only `ended_at` when it exits. `createExecutionSession` and `materializeSessions` already write `worktree` and `created`; they stay the normal birth path and do not need a second copy of the fields if `writeMeta` is the backstop.

## UI

The warning lives on the task, not in a toast and not in a banner that replaces the board.

- Task list, Grid, and Kanban: a row or card with `load_error` or any `session_faults` shows a failure marker. The tooltip is the error text. A healthy row has no marker.
- An unreadable task row does not navigate. Archive and duplicate stay disabled. New task stays enabled whenever the list command succeeded.
- A readable task with only session faults still opens. `TaskDetail` lists the good sessions and one non-opening fault row per bad file, with the same error as its tooltip. The existing sessions warning banner is only for a failure to read the sessions directory, not for one bad file.
- Search keeps listing every good task and good session. A fault task is a search hit whose tooltip is the error. A fault session is not a search hit; its task is.

## Tests

Replace `durable_discovery_reports_task_scoped_storage_errors`. A corrupt `task.md`, session meta, playbook, or execution file must leave the sibling task in the board and in `list_session_items`, and must put the bad path in `load_error` or `session_faults`. It must not `Err` the list.

Add a directory-unread case that still `Err`s, so the repo-level failure does not disappear.

Add a Vinculum writer test: the first `writeMeta` for a new id parses as `SessionMeta`. Patching an existing stub does not add `worktree` or `created`.

Frontend: a board payload with one fault row and one good task renders both, and the good task's open path still runs. `TaskDetail` renders a parsed session and a fault row from the same reply.

## Out of scope

No migration that rewrites the stubs under `thribble_v4`. No change to `PROTOCOL_VERSION`; this is an app listing shape, not a daemon op. No repair button. No change to create-task provisioning.
