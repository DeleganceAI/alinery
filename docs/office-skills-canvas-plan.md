# Office skills and canvas file panels

Agents get office skills (Word, Excel, PowerPoint, PDF) out of the box. A chat's canvas can show the files those skills
produce: a file preview, a browsable file list, and a way to save a copy. Every included skill can be turned off or
removed in Settings.

## Decisions

| Question | Decision |
|---|---|
| Which skills ship | Anthropic's own document skills from `anthropics/skills` (Apache 2.0, with their scripts), plus a curated office set from `claude-office-skills/skills` (MIT). The office repo's `official-skills/` pointer guides are not shipped. |
| How they are removed | Read-only in the runtime. Settings has an on/off switch and a remove action. Removing hides the skill for good, until "Restore included skills". |
| Skill limit | Ours, not pi's: `MAX_SKILLS = 64` and descriptions of at most 1024 characters, both in `skills.ts`. Settings shows "N of 64 on · ~K tokens" and blocks the 65th. |
| Python | A bundled python-build-standalone with the packages, for this Mac and in all four remote runtimes. |
| Node | The daemon's own Bun (`BUN_BE_BUN=1`). Must be confirmed before Phase 1 relies on it. |
| LibreOffice | Detected, never bundled. Settings → Runtime says whether it was found and links to install instructions. |
| Where the canvas tools work | Chat first. Task sessions come later. |

## The included skills

**On by default (15)**
- Anthropic: `docx`, `pdf`, `pptx`, `xlsx`, `internal-comms`.
- Office: `md-to-office`, `office-to-md`, `pdf-converter`, `pdf-to-docx`, `pdf-merge-split`, `md-slides`, `chart-designer`, `data-analysis`, `file-organizer`, `table-extractor`.

**Included but off**
- `pdf-compress`, `pdf-watermark`, `pdf-ocr`, `html-to-ppt`, `ppt-visual`, `batch-convert`, `report-generator`.
- Templates: `invoice-generator`, `nda-generator`, `contract-review`, `meeting-notes`, `proposal-writer`.

**Left out**
- `docx-`, `xlsx-` and `pptx-manipulation` and `pdf-extraction`: they repeat Anthropic's skills, and two skills would compete for the same request.
- The SaaS automations, because they need third-party API keys.
- Anthropic's `doc-coauthoring`: upstream ships it with no license.
- The `mcp-servers/office-mcp` server: it pins `xlsx@0.18.5`, which has known security holes, and it repeats what the skills do.

Our copies fix the six office skills whose description is the YAML mistake `">"`, and set each office skill's `name` to its directory name.

## Phase 1: bundled Python
- **Build:** `scripts/build-python-runtimes.sh` fetches python-build-standalone for darwin arm64 and x64 and linux x64 and arm64. It pins each by sha256 and installs these wheels:
  - `lxml`, `defusedxml`, `pypdf`, `pdfplumber`, `Pillow`
  - `openpyxl`, `python-pptx`, `python-docx`, `reportlab`
- **Shipping:**
  - Each Python goes into the local app resources and into each `resources/remote/<triple>.tar.gz`.
  - It is a directory named by content hash, like the runtime itself.
  - It roughly adds 40 to 50 MB per platform.
- **The agent's shell:** the daemon prepends the Python's `bin/` to the PATH and sets `PYTHONNOUSERSITE=1`. When a skill needs more packages, it installs them into `.alinery/venv`, a separate environment per repository, never into the bundled Python.
- **Node:** the agent's shell gets `bun`, which runs the daemon executable with `BUN_BE_BUN=1`.
- **Settings → Runtime** shows whether Python is ready and whether LibreOffice, `pdftoppm` and `qpdf` were found.

## Phase 2: included skills
- **Source:**
  - `vinculum-daemon/skills/<name>/` holds vendored copies of the skills, together with their LICENSE files.
  - `THIRD-PARTY-NOTICES.md` lists their sources.
  - `scripts/update-included-skills.sh` refreshes them from pinned commits. `skills/included.json` lists the ones that start off.
- **The prompt's skill list:** `skillCatalog` reads the included folder and the user's `skills/` folder together. If names clash, the user's skill wins. It skips skills that are off or removed, and keeps the 64 cap.
- **What gets saved:** `skill-choices.json` in the agent directory holds each skill's on/off choice (the user's own skills too) and the removed list. Each host keeps its own.
- **What changes in the daemon protocol:**
  - `Customization` gains `included` and `enabled`; `ReadCustomizations` returns the counter and the removed list.
  - New calls `SetSkillEnabled` and `RestoreIncludedSkills`; `DeleteSkill` with `included` removes an included skill.
  - Shares protocol 45 with Phase 1; protocol 46 when merged into the experimental branch, whose 45 already carried prompt images.
- **In Settings:**
  - Each included skill shows an "Included" badge, a switch and a remove button.
  - A counter shows "N of 64 on · ~K tokens".
  - At 64, the switch for another skill is disabled and explains why.

## Phase 3: canvas file panels (chat)
- **`alinery_canvas_show_file {path, panel?, title?}`** adds panel kind `file`. Its body is `{path, size, mtime, mime}`. It is drawn by file type:

  | File type | How it is shown |
  |---|---|
  | PDF | pdf.js (new dependency `pdfjs-dist`) |
  | Image | the image; SVG goes in the sandboxed frame |
  | csv or xlsx | a read-only grid with sheet tabs, using SheetJS's own release, not npm's `xlsx@0.18.5` |
  | docx | mammoth converts it to HTML, shown in the sandboxed frame with the canvas CSP |
  | anything else | file details only |

- **`alinery_canvas_show_files {dir, glob?, panel?, title?}`** adds panel kind `files`. It keeps a snapshot of path, size, modification time and type. Clicking a row opens that file in a `file` panel, and a refresh button stats the files again.
- **The security boundary:** a path must resolve, after following links, inside the chat's repository or one of its worktrees.
- **Bytes:** a new `CanvasFileBlob {thread_id, panel, path}` in BlobService carries a file's bytes. It is streamed, capped at 100 MiB and checked against the same boundary, so it works for remote repositories too.
- **Buttons:** each file panel and each row has:
  - Save a copy…, through a new shell command `save_file_dialog` in `ipc.ts` that writes bytes from BlobService.
  - Copy path, the button we already have.
  - Reveal in Finder, on this computer only.
- **What changes in the daemon protocol:** the new kinds in `PANEL_KINDS`, `CanvasFileBlob`, and a protocol bump. The bump can be shared with Phase 2 if both land together.

## Phase 4
- **PowerPoint preview:** a deck (pptx, ppt, odp, key) previews as its slides: BlobService `RenderedPdfBlob` has LibreOffice on the repository's machine convert it to PDF (`platform/office.ts`, a throwaway profile per run, stopped after 120 s), cached in `.alinery/cache/rendered/` by path, size and modification time (newest 32 kept), and drawn by the PDF viewer. Without LibreOffice, a pptx shows its slide text with the reason and a Get LibreOffice link.
- **Task sessions:** a task's or session's file tab previews a PDF, xlsx, docx, deck or image with the canvas's file view (`FileView`, Save a copy) instead of "Binary file, not shown". The agent of a task session has no canvas tools: it names the file and the user opens it.
- **The agent looks at its own pages:** `alinery_render_page {path, page}` (chat threads and task sessions) draws one page of a PDF, or one slide of a deck through the cached LibreOffice PDF, to a PNG with the bundled Python's pypdfium2 (`platform/office.ts` `pdfPagePng`, `domain/rendered.ts` `renderPage`), and answers with the image, the way the read tool answers an image file. Prompts stay text: the agent sees its work through a tool result, so `PromptChatThread` and `PromptSession` need no images and the wire is unchanged. The included pptx and pdf skills (and pdf2image) call `pdftoppm`, which is not bundled, so the agent's shell gets a stand-in (`src/shims/pdftoppm.py`, pypdfium2, poppler's file names) last on PATH, after any real one; the skills stay as upstream wrote them.
