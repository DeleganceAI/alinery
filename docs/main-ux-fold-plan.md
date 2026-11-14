# Plan: fold main's UX/UI updates into `experimental-pi-durable-as-a-harness`

Status: plan only, nothing ported yet. Written 2026-11-07 against this branch at `03a5399c` and `origin/main` at `a0210cf0`.

## Why a fold and not a merge

PR #135 is 118 commits behind `main` and GitHub reports it as conflicting. A `git merge origin/main` would drag in work that no longer has a home here: main still runs the Rust `alineryd`, OMP as an external binary, the JSON-lines wire and about 30 shell commands this branch moved into the Vinculum daemon. Most of main's backend commits patch code this branch deleted.

Main's page-side work is different. It is largely product polish (Playbooks library, onboarding, Settings, graph controls, interface scale) that applies to any backend. This plan carries that across and leaves the rest.

**Scale of the overlap** (merge base `248c36ec`, PR #152):

| | Count |
|---|---|
| Non-merge commits on main since the base | 95 |
| Page files (`alinery-app/src/`) main changed | 120 |
| ...also changed on this branch | 78 |
| ...changed only on main | 42 (17 of them new files) |
| Main's new shell commands with no counterpart here | 9 |

The 78 files changed on both sides include the hottest files in the app (`SessionView.tsx` 1603 lines changed on main / 1380 here, `App.tsx` 282 / 393, `Settings.tsx` 263 / 491, `TaskDetail.tsx` 76 / 483, `ProviderSetupDialog.tsx` 43 / 343). A cherry-pick of those commits will conflict, so the method below ports by feature, not by commit.

## Ground rules for the port

- **Page only, unless a UI item needs a shell setting.** Two items add fields to the app's own appearance prefs (`app_config.rs`, which stays a shell concern on this branch). Nothing here adds a daemon RPC or touches `proto/`, so `PROTOCOL_VERSION` does not move.
- **Data goes through this branch's paths.** Main's views call `ipc.*` for repository data. Here the same data comes from the sync replica (`src/sync/*.ts`, `useScope`/`useEntity`) and the daemon's services. A ported view keeps main's markup and behaviour and swaps its data calls; it never re-adds a shell command for daemon data (AGENTS.md "Commands", `check-ipc-commands.sh`).
- **`@tauri-apps/*` only in `src/ipc.ts`**, confirmations only through `confirm.tsx`, as everywhere else.
- **Tests come with the code.** Port main's test for each item and re-point its mocks from `mockIpc` to this branch's fakes (`src/test/executionFeed.ts`, `fakeBoard`, `fakeArtifacts`, the replica helpers). A test that only passes after another test (see the order-dependent "Finish step" test in `SessionView.test.tsx`) is a defect to fix, not to copy.
- **README is off limits.** Collect any README text for the human.

## Method

1. Work on `fold-main-ux`, branched off `experimental-pi-durable-as-a-harness`, with its own PR into that branch, so PR #135 is not blocked while the fold is in review.
2. For each work package below, in order:
   - Read main's commits for it (`git show <sha> -- alinery-app/src alinery-app/src-tauri/src/app_config.rs`).
   - For files **only main changed**, apply directly: `git show <sha> -- <paths> | git apply --3way`.
   - For files **changed on both sides**, hand-port: open main's version of the hunk next to this branch's file and re-express it against the current code. Do not take main's whole file.
   - For **new files** (`PlaybookStarterDeck.tsx`, `startupView.ts`, ...), copy from `origin/main` and fix their imports.
   - Run the gates below, then one commit per package, authored by the user, message naming main's source SHAs (`Port from main: 7a3e1efc, c7b11b5f`).
3. Run `./scripts/check.sh` once at the end of the fold, not per package (project memory: full gate only at check-in).

**Per-package gates:** `npx tsc --noEmit -p .` and `npx vitest run <touched tests>` in `alinery-app/`; `cargo check -p alinery-app` when a package touches Rust.

## Work packages

Ordered so the least-conflicting, most self-contained work lands first. Each lists main's commits, the files it lands in here, and what has to change in the port.

### WP0. Dependency security bumps (decided 2026-11-07: keep)

| Commit | Change |
|---|---|
| `baf2d270` | Vite `^7.3.7`, Vitest and `@vitest/coverage-v8` `^4.1.12` (`alinery-app/package.json`, `package-lock.json`), plus `whitepaper/examples/smithers/package.json` |
| `a0210cf0` | dompurify 3.4.17 and undici 8.12.3 (`alinery-app/package-lock.json`) |

Not UI, but kept because they close npm audit findings and `alinery-app/package.json` is shared. Checked 2026-11-07: both pass `git apply --check --3way` against this branch with no conflicts. Cherry-pick both as the fold branch's first commit (`git cherry-pick baf2d270 a0210cf0`), then `npm ci` in `alinery-app/`, `npx tsc --noEmit -p .` and the full `npx vitest run`. A Vite or Vitest minor bump can change test behaviour, so run this before WP1 and keep any failure apart from the UI ports. The daemon's own `package.json` (`vinculum-daemon/`) is not touched by either commit.

### WP1. Playbook graph polish (low conflict)

| Commit | Change |
|---|---|
| `97503960` | Fix clipped graph labels at small zoom |
| `06343281` | Group and polish graph controls |
| `25cab73f` | Demo playback as a subtle canvas corner control |
| `a4a6fde2` | Opaque status badges |
| `bee40b02` | Shorter Academic Survey badge label |
| `b665c392` | Never-started held owners pinned as queued in the run graph |

Lands in `PlaybookGraph.tsx/.css/.test.tsx` (untouched on this branch, so `git apply --3way` should be clean) and `TaskRunGraph.tsx` (light churn here). `25cab73f` also touches onboarding: take only the graph half here and the rest in WP5.

### WP2. Interface scale and small interaction fixes (low conflict)

| Commit | Change | Lands in |
|---|---|---|
| `8244c8c6` | Add repository stays clickable at raised interface scale | `TopBar`, `theme.css` |
| `7ab3263c`, `c0c7b512`, `ef970270` | Repo switcher floor scales with interface scale (with its test and comment) | `theme.css`, `TopBar.test.tsx` |
| `1967b289` | Escape no longer leaves the run graph during keyboard pan | `TaskRunGraph.tsx`, `useHotkeys.ts` |
| `1ef2fd54` | Enter on focused task-list controls is respected | `TaskList.tsx`, `useHotkeys.ts` |
| `975046f6` | Search opening a draft from New task loads that draft | `CreateTaskPage.tsx` |
| `b523960e` | Hide task-default badges in step model controls | step model control in `CreateTaskPage`/`TaskDetail` |

**Check before porting:** the repo switcher and Add repository on this branch sit next to the S6 setup screen and remote hosts (`views/SetupScreen.tsx`, `TopBar`). Keep the scale floor and leave this branch's host picker in place.

### WP3. Settings and preferences (adds two shell setting fields)

| Commit | Change |
|---|---|
| `96961d72` | Startup view preference; default to the task list (`startupView.ts`, `GlobalSettings.startup_view`) |
| `cbe10593` | Startup view selector uses the shared form styling |
| `19fd25f8` | Default playbook selector matches the other Settings controls |
| `0c527162` | Clearer repo selection in Settings empty states |
| `0d3e2f25` | Chat actor labels, reply bubbles and block copy buttons on by default |

- **Rust:** `startup_view` (default, sanitize, round-trip test) and the three new chat defaults go into this branch's `AppearancePrefs`/global settings in `alinery-app/src-tauri/src/app_config.rs` and `src/tests/settings.rs`. Main's `sanitize_appearance` hunk ports almost as is. This is local-machine state: do **not** add these to `render_remote_app_toml` (no host process reads them).
- **Page:** `appearance.ts` defaults, `types.ts`, `views/Settings.tsx`. Settings has 491 lines of churn here (host-aware sections, storage, providers moved to the daemon), so hand-port each control into this branch's section structure.
- **Interaction with WP6:** the startup view offers Kanban on main only until `71c1917e` removes it. Kanban is being removed (WP6), so port the post-removal option list.
- **0c527162** refers to "the repo" in Settings. Here Settings can target a remote repo; make the empty-state copy fit both.

### WP4. Playbooks library redesign (biggest pure-UI package)

| Commit | Change |
|---|---|
| `7a3e1efc` | Playbook selection with persistent stars and canvas controls |
| `c7b11b5f` | Simpler starter deck selection and actions |
| `75fdf531` | Picker header and compact search |
| `30909f8d` | Playbooks browsing as an Explore library (`views/Playbooks.css`, new) |
| `1b624289` | Featured bundled playbooks, library navigation repaired |
| `c55b41af` | Shared playbook starter centered in an empty Tasks view |
| `4066cd9e` | Review captures (images under `docs/`); optional |

New files from main: `PlaybookStarterDeck.tsx`, `PlaybookLibraryLink.tsx/.test.tsx`, `views/Playbooks.css`.

**Data adaptation (the real work):**
- Main reads the catalog with `ipc.listPlaybookCatalog` and saves stars with `ipc.savePlaybookPickerPreferences`. This branch already has both through the daemon: the `playbook/_/picker`, `playbook/_/library` and `playbook/_/community` entities, and `savePlaybookPickerPreferences` in `src/sync/playbooks.ts` (`PlaybookService.SavePicker`). Re-point to those; add nothing to `ipc.ts`.
- `PlaybookLibraryLink` only calls `ipc.openUrl`, which exists here.
- `views/Playbooks.tsx` changed 598 lines on main and 51 here, and the 51 are the switch to `src/sync/playbooks.ts` and `src/sync/community.ts`. Take main's file and re-apply this branch's data imports onto it. That is easier than the reverse.
- `CURATED_PLAYBOOK_ARCHETYPES` / `StarterTaskPreset` come from main's `onboarding.ts`; land that piece here too (overlaps WP5).

### WP5. Onboarding polish (conflict-heavy)

| Commit | Change |
|---|---|
| `19ea9c6b` | Better onboarding order, automatic playbook previews |
| `32d4365a` | Preview navigation and inspection fixed |
| `37fee0ca` | Onboarding ends at Playbooks; First task step removed |
| `3f86b988` | Founder plan advertised on the model step |
| `54764f27` | Guided demo polish; opens a new task on finish |
| `8efd4918` | Progress animation with pause-aware step timing |
| `54866659` | Actions, mechanics guide and node statuses refined |
| `731d4b16` | Draft settings preserved during refresh; longer onboarding guide |
| `91527f3e` | Founder plan refreshed before opening billing (`account.rs` + test; the account module is shell-side here too, so this ports) |

Lands in `views/OnboardingFlow.tsx` (805 lines changed on main, 243 here), `onboarding.css` (746 / 55), `onboarding.ts`, `OnboardingFlow.test.tsx`.

**Conflicts to resolve on purpose:**
- Onboarding here runs once per **host** (`AppConfig.local_onboarded`, `RemoteHost.onboarded`, `set_host_onboarded`) after a repo opens, not once per app. Keep that trigger and port main's steps inside it.
- The model step here lists the host daemon's models through `ProviderService` (`src/sync/providers.ts`). Main's Founder plan card goes beside that list; its billing refresh stays a shell call (`account_*`).
- This branch reverted a removal of onboarding chrome (`b4760975`, which reverts `8006cf4a`). Read both before porting so the fold doesn't quietly redo the removal.
- `37fee0ca` removes the First task step. Confirm that matches this branch's setup screen flow (S6), which already moved repo creation out of onboarding.

### WP6. Remove the standalone Kanban view

| Commit | Change |
|---|---|
| `71c1917e` | Remove standalone Kanban and the redundant starter action (27 page files) |

**Decided 2026-11-07: remove it.** This deletes `views/Kanban.tsx`, its tests and its route. On this branch the daemon's `board` entity feeds Kanban, Grid and the task list. Port the deletion, keep the `board` entity (Grid and the task list still read it), drop Kanban from the startup view options (WP3) and from hotkeys, and update AGENTS.md's two mentions ("Grid / Kanban" in Core Model, and the Frontend Views list) in the same commit.

### WP7. Artifact images in Markdown previews

| Commit | Change |
|---|---|
| `f820be99` | Relative attachment images resolve in Markdown artifact previews (new `ArtifactMarkdown.images.test.tsx`) |
| `3a66c7c9` | Tree artifact images resolve from their own attachments |

Main adds `useAttachmentImageSrc` to `AttachmentPreview.tsx` and uses it from `ArtifactMarkdown.tsx`. On this branch `AttachmentPreview.tsx` changed (52 lines) to read attachments through the daemon's `BlobService`, which is what makes it work for remote repos. Re-implement the hook on top of that read path, not main's local file read, and test it with a remote-style repo key.

### WP8. Provider sign-in copy and display (partial)

| Commit | Change |
|---|---|
| `e0c1cad2` | Device code shown during Codex headless sign-in |
| `394569b3` | Message fallback pinned on sign-in links |
| `74db4fb8` | Device codes preserved across sign-in entry points |
| `fe8dc69e` | Stale manual OAuth prompt cleared after browser sign-in |
| `6fa91f1e` | Clearer sign-in codes and success status |

Sign-in moved into the daemon here (`ProviderService`, `rpc/providers.ts`; the page opens the `auth_url` event with `open_url`), and `ProviderSetupDialog.tsx` changed 343 lines. Port the copy, layout and status presentation. For the device code: first check whether `ProviderService`'s sign-in events carry it. If they do, port the display. If not, adding it is a daemon change and moves to the deferred list.

### WP9. Composer footer controls (UI only, in the hottest file)

| Commit | Change |
|---|---|
| `b4e08cba` | Session controls moved into a compact composer footer |

No backend involved, but it lands in `SessionView.tsx` and `ChatComposer.tsx`, where this branch put the Vinculum model and thinking pickers (`ThinkingSelect`, Change model) and the Finish step card. Port the layout and keep this branch's controls. Do this one last among the ported packages, so the WP3 and WP5 conflicts in shared CSS are settled first.

### WP10. Exited Chat sessions no longer shown as active

| Commit | Change |
|---|---|
| `16617453` | Exited Chat sessions not shown as active (`sessionMessage.ts` + tests, small `SessionView`/`chatThreadSession` edits) |

Port the `sessionMessage.ts` rule and its tests. Check it against this branch's observation shape (`useSessionObservation`, `transport: "rpc"`). An exited Vinculum session may already read as exited here, in which case only the test is worth taking.

## Deferred: UI that needs backend work first

These are user-facing on main but sit on shell commands, OMP behaviour or Rust state this branch does not have. Each would need a daemon RPC (and a `proto/` change plus a `PROTOCOL_VERSION` bump) or a playbook-engine change before its UI can come across. Out of scope for this fold; listed so nothing is lost.

| Feature | Main's commits | What it needs here |
|---|---|---|
| Practical playbook continuation, persistent session navigation (`SessionLineage`) | `fe0dfa12`, `e571fee1` | `continue_execution` as an `ExecutionService` RPC on the playbook engine. `SessionLineage.tsx` itself reads only types and `runGraphModel` (present here), so the navigator alone could come earlier, fed by the execution entity. |
| End, stop and restart a step; artifact handoff recovery (`ArtifactHandoffPage`) | `0c9234c4`, `3de7265c` | `prepare_end`/`end`/`stop`/`restart_execution`, `preview`/`submit_execution_artifacts` as daemon RPCs. Overlaps this branch's own recovery (Recover session, `20c091ab`) and Finish step card: design them together. |
| Continuation controls, wrap-up nudges, delivery recovery in the transcript | `1d1df767`, `6dde8a17`, `1b6d2a81` | Main's `DispatchOutcome`/`dispatchId` write tracking on PTY and RPC writes. Vinculum prompts go through `SessionService.PromptSession`; delivery tracking would have to be designed there. |
| Step continuation toggle | in `fe0dfa12` (`set_step_continuation_for_repo`) | A task setting write: a `TaskService` RPC. |
| Errored turn with Retry; error notification | `10459b9d`, `4f6368bd`, `7bbc36b9`, `637028f9`, `fce583e2` | Main detects OMP giving up on a turn. Vinculum turns fail inside pi-durable; the transcript would need a typed turn error. The Retry UI pattern can then be reused. |
| Drawer shells restored as tabs after relaunch | `1d45f2ee`, `aa87c2d3` | `list_drawer_terminals`: a `TerminalService` listing of live drawer PTYs (the daemon owns them). |

## Not applicable: backend, infra and tests for code this branch replaced

| Commits | Why not |
|---|---|
| `20ebbcf5`, `eb8c8ce0`, `0d7f9792`, `0858864b`, `647b3174`, `c6b194a7`, `490df545`, `ba4143b5` | Completion bookkeeping, admissions, native jobs and transfers in the Rust daemon and runner, which no longer exist here |
| `e40c7621`, `4c278176`, `1116f81d` | Dead-owner release in Rust step ownership; replaced by the playbook engine and repo-ownership adoption |
| `5f3c91ed`, `fe229986` | Repo open and board loading over shell commands; replaced by `ensure_daemon` plus sync. Spot-check that "removing a repo stays responsive" holds here. |
| `3fb728c0`, `d5635e2a` | Rust PTY tail replay; the daemon replays `.scrollback` from an offset (`rpc/terminal.ts`) |
| `119b880f` | OMP pin; there is no OMP binary |
| `9fb883f8` | Main's protocol 21; this branch has its own sequence (39) |
| `64779053`, `dddfea04` | Rust git credential fill; the daemon's git is `platform/git.ts` |
| `2525dffe`, `d1f7cc20`, `df23b45d`, `75c650d2` | MCP server and RPC fixtures in Rust; MCP here is the daemon's `--mcp` mode |
| `eaef72cd` | Draft promotion naming in Rust; drafts are the daemon's `DraftService`. Check the behaviour (explicit names kept on promote) exists there, as a one-line follow-up if not. |
| `b7cad554`, `b9aa364f` | CodeQL logging fixes in Rust files this branch removed or rewrote. Re-check the equivalents with CodeQL on PR #135. |
| `f23bc2a8` | Research evidence files for external adapters |

## Worth taking outside this fold (not UI)

- **Dependency security bumps:** moved into the fold as WP0.
- **App version** `3baa51e6` moved main to 0.26.0; this branch is 0.25.0. Release tooling reads these versions, so decide the version at merge time using the six-file list in AGENTS.md. Do not cherry-pick the commit.

## Risks

- **Shared CSS.** `theme.css` (1059 lines changed on main, 288 here) is touched by WP2, WP3, WP4, WP5 and WP9. Port its hunks with the package that owns them and look at both themes after each package.
- **Tests that pass for the wrong reason.** Main's view tests mock `ipc.*`. Re-pointed to this branch's fakes, a test can go green without the view reading the replica. For each ported view, keep at least one test that drives data through the real sync hook or the fake replica, the way the execution-row fix's round-trip test did.
- **Nobody has run this branch live yet** (all 118 entries in `docs/thick-daemon-live-checks.md` are open). Folding UI in before the live checks makes a live failure harder to attribute. Doing WP1 to WP4 first and running the Part 0 smoke checks before WP5 and WP9 keeps that manageable.

## Decisions needed before starting

1. ~~Remove Kanban (WP6)~~: decided 2026-11-07, remove it.
2. ~~Separate branch or this one~~: decided 2026-11-07, a separate branch (`fold-main-ux` off `experimental-pi-durable-as-a-harness`) with its own PR into it.
3. ~~Dependency bumps~~: decided 2026-11-07, keep both as WP0.
