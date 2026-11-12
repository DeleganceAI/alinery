# Task view rework: layout, compact header, Files panel, tabbed viewer

Branch: `feature/alinery-task-view-ux-9ce08e`, cut from `experimental-pi-durable-as-a-harness` at `6a6e1379`.

Almost all frontend work lands in `alinery-app/src/views/TaskDetail.tsx` (about 1,840 lines). Phase 4 is the only phase that touches the wire.

## Decisions already made

- The file browser starts at the **task's worktree** (`.alinery/worktrees/<slug>`), not the main checkout.
- The viewer is **read only**. There is no editor.
- The **MD commenter** (anchored comments, drafts, Send review, review pending) must work on **every** markdown file a user opens, whether it is an artifact or a repo file.
- The "sessions viewer" is the left-hand Sessions card in both its List and Graph modes. It becomes the first tab and is always open.

## Target layout

```
┌──────────────────────── Task header (full width, compact ⇄ expanded) ────────────────────────┐
├───────────── Side panel (left) ─────────────┬──────────── Main pane (tabs) ───────────────────┤
│ [Playbook] [History] [Files*]               │ [Sessions] [specs.md ×] [src/foo.ts ×]          │
│  Files:                                     │                                                 │
│   ▸ Artifacts   (playbook outputs)          │  Sessions: the current card (List / Graph)      │
│   ▸ Attachments                             │  .md tab:  ArtifactMarkdown + Preview/Raw +     │
│   ▸ Repository  (worktree tree)             │            comment gutter                       │
│                                             │  code tab: highlighted <pre> with line numbers  │
└─────────────────────────────────────────────┴─────────────────────────────────────────────────┘
* the default tab
```

## Phase 1: layout (XS–S, one PR)

1. **Full-width header.** Lift the task header card out of the left column and render it above the two-column grid.
2. **Flip the panels.** The side panel moves to the left and the main pane to the right. The resize handle moves to the other edge and the stored width keeps its meaning (side-panel width). Update `TaskDetail.width.test.tsx`.
3. **Files tab.** Rename `Artifacts` to `Files`, make it the rightmost button and the default `sideTab`. The `artifacttab` ids stay internal, so no other file changes.

Done when the screen matches the layout above apart from the tabs, and the TaskDetail tests are green.

## Phase 2: compact header (S–M, one PR)

- **Compact (default):** title, branch with a copy button, worktree (truncated in the middle, full path in the tooltip) with a copy button, **Archive**, and an expand chevron.
- **Expanded:** everything that exists today, which is the full worktree path, the PR URL row with status and Push + copy compare URL, Related tags, Duplicate Task, and Auto Approval All.
- The expanded state is one boolean in localStorage, wrapped in try/catch, and it applies to every task.
- `TaskDetail.prurl.test.tsx` and `TaskDetail.related.test.tsx` expand the header before they assert.

## Phase 3: tabbed main pane, using today's sources (M, one PR)

- Add `openTabs: TabKey[]` and `activeTab`. Tab 0 is `sessions`, which can't be closed and holds the current Sessions card unchanged.
- Picking an artifact or attachment in Files opens a tab, or focuses it if it is already open. Middle-click and × close a tab. Closing the active tab focuses the one to its left.
- **The commenter goes per tab.** Today `selectedArtifact` drives the comments, drafts, `reviewPending` and the Preview/Raw mode. Those become state of the active tab: comments come from `liveArtifacts.comments` filtered by the tab key, and Preview/Raw is stored per tab. This is the main risk in this phase, so test it.
- Attachments keep the `AttachmentPreview` they use today.
- Open tabs persist per task in localStorage. A tab whose file has disappeared stays open and shows "file no longer exists" until it is closed.

Done when you can open three artifacts, comment on two of them, switch tabs, and see the right comments and review state on each.

## Phase 4: repository files over the wire (M–L, one PR, protocol bump)

The daemon owns the filesystem, and a repo may be remote over SSH, so this is a daemon RPC, never a Tauri `fs` read.

**Proto (`proto/alinery/v1`)**
- `blobs.proto`: add `WorktreeFileBlob { string task_slug = 1; string path = 2; }` as `BlobRef.target` case `worktree_file = 11`.
- Add a `ListWorktreeFiles` VIEW RPC (on `GitService` or `TaskService`, whichever owns worktree reads). Request `{ task_slug }`, response `repeated string paths` plus a `truncated` flag.
- Run `npm --prefix proto run gen`, regenerate the goldens (`cd proto && bun golden.ts`), and bump `alinery-core::PROTOCOL_VERSION`.

**Daemon (`vinculum-daemon/src`)**
- Listing: `platform/git.ts` runs `ls-files -z --cached --others --exclude-standard` in the task worktree. That gives tracked plus untracked files, without ignored ones. Cap it at about 20k paths and set `truncated` when it hits the cap.
- Reading: `domain/blobs.ts` `worktreeFileBlob(repo, slug, path)`. Resolve the path against the worktree, `realpath` it, and **refuse anything outside the worktree**, including symlinks that escape and `.git/`. Reuse `regularFileBlob` for the size cap and regular-file check.
- Tests: path traversal (`../`, an absolute path, a symlink out), a missing worktree, the truncated flag.

**Frontend**
- `src/sync/*.ts`: `listWorktreeFiles(repo, slug)` and `readWorktreeText(repo, slug, path)`.
- The Files panel gets three sections in this order: **Artifacts**, **Attachments**, **Repository**. Repository is a collapsible tree built from the flat path list on the client. It has a filter box but no lazy per-directory fetch, because the full list is one call.
- Opening a repo file uses the Phase 3 tabs with the tab key `repo:<path>`.

## Phase 5: viewer for repo files (M, can share a PR with Phase 4)

- **Markdown (any `.md`)** renders through `ArtifactMarkdown` with the full commenter. See the comments-storage section below.
- **Code** uses `highlight.js/lib/core` (a new dependency, roughly 40 KB with these languages) with ts, tsx, js, json, rust, toml, yaml, bash, python, go, css, html, sql, markdown and diff. The language comes from the file extension, with plain text as the fallback. Line numbers come from CSS counters.
- **Guards:** above 1 MB, or for binary content (a NUL byte in the first 8 KB), show "too large / binary" with the size instead of the content. Images go through the existing attachment image path.

## Comments on repo markdown (part of Phase 4)

Artifact comments are sidecars placed next to the artifact (`<stem>.comments.json`, `.comments.md`, `.review-pending.json`, all built on `artifactFilePath`). Writing those into the worktree would add stray files to the repo and to `git status`, so repo files keep their sidecars under the task instead:

```
.alinery/tasks/<slug>/repo-comments/<path-with-ext>.comments.json | .comments.md | .review-pending.json
```

- On the wire the comment target is the same `artifact` string with a `repo:` prefix. In `artifactComments.ts`, one resolver maps `repo:<path>` to the repo-comments location and the worktree file (with the same confinement as the blob read). Every other name keeps going through `artifactFilePath`. `addComment`, `saveCommentDraft`, `sendReview` and `clearReviewPending` need no new RPCs.
- The review file `sendReview` writes names the worktree-relative path, so the harness opens the right file.
- The artifact hash used for staleness hashes the worktree file the same way.
- Check before building: whether anything parses `artifact` strictly as a filename (`validateArtifactFilename`, the provenance snapshots in `Provenance`). The resolver must sit in front of those checks.

## Verification per PR

Iterate with `vitest` on the touched TaskDetail tests, `tsc`, `bun test` in `vinculum-daemon` (phase 4), and `cargo check -p alinery-app` (the protocol bump). `./scripts/check.sh` runs only at check-in. The app is not launched unless you ask to see it.

## Out of scope

- Editing files, diff views, or a file search beyond the tree's name filter.
- Live-watching repo files. A tab reloads when it is reopened or refreshed. Watching can come later if stale tabs turn out to hurt.

## Open questions

1. Should a tab key be shared between an artifact and a repo file with the same name? Proposed: no. `artifact:`, `attachment:` and `repo:` stay separate namespaces.
2. Should the Repository tree hide `.alinery/` inside the worktree if it shows up there? Proposed: yes.
