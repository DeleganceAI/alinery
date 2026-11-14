# Settings redesign plan

Settings becomes one scrolling list, built like the playbook library. A rail on the left holds links to each part of the list, with a search box at the top. The app also ships the alinery.ai fonts, with today's system fonts kept as the fallback everywhere.

Status: all four phases are built: fonts, the one list, search, and the restyle (header scope picker, readouts, Needs you, label-left rows, override edge).

## What is there now

- `views/Settings.tsx` is 2,696 lines. It has nine tabs (`SECTIONS`: General, Harness, Connections, Storage, Sessions view, Chat, Grid views, MCP Server, Backup) with one panel showing at a time (`settings-nav` + `settings-panel`).
- Tab names don't say what is inside them. General holds Appearance, Playbooks, Notifications, Updates, Runtime, Misc (telemetry) and Experimental. Harness holds providers, session defaults, customizations and the background daemons. Finding the dock badge means already knowing it lives under General.
- Headings are nested four ways (`h2` subsection, `h3` nested, `h4` storage and MCP, `<details>` disclosures), and no two sections look alike.
- A full-width scope bar sits on top ("All repositories" plus one chip per repo). In repo scope, global-only parts each repeat their own "…are global-only. Switch to…" banner (`globalOnly()`, five call sites), and an override shows as an inline `pill` with a button stuck inside it.
- Loading is tied to the open tab. Seven effects check `activeSection` before loading anything: the playbook catalog and update check (general), storage paths, connections, backups, the backup-busy hook and live sessions (harness). Rendering every section at once without changing this would load all of it at the same moment.
- Deep links exist: `openSettings(section?: SettingsSectionKey)` in `App.tsx`, threaded through as `initialSection`.
- Tests are written against the tabs: 11 `Settings.*.test.tsx` files with about 30 references to `initialSection` or tab clicks.

## The design language to borrow

This comes from the library (`Playbooks.css`, `docs/playbook-library-cockpit.html`) and from alinery.ai:

- **Two regions, hairline split.** A 200px rail and the content, divided by a 1px `--border`. No cards and no shadows on the page itself.
- **Mono eyebrows.** Group labels in the rail and above each group use 10px `--font-mono`, uppercase, 0.12em tracking, `--text-faint` (`.pb-eyebrow`). Counts use tabular mono (`.pb-n`).
- **Selection is an accent wash.** `--accent-subtle` background and `--text-strong`, with no glow (`.pb-rail button[aria-pressed]`).
- **Signals only when something needs you.** The library's "Signals" rail group appears only when it has rows. Settings gets the same kind of group for anything that needs action (an expired connection, an available update, a failed backup).
- **The planet horizon.** The large arc behind the header (`.pb-bar::after`) is alinery.ai's one decorative mark. Reuse it on the Settings header, once.
- **The site's type.** alinery.ai uses Sora for display text ("A new way to build."), Geist for body text and Geist Mono for code. Its `:root` tokens (`--void #000104`, `--surface #08090b`, `--warm-white #f4f1ea`, `--line #f4f1ea1f`) already match `theme.css`, so the fonts are the only gap.

The "knobs of a spaceship" feel should come from readouts, not decoration. Each group header carries a short live status line in mono, read from state the page already loads:

| Group | Readout |
|---|---|
| Connections | `● 2 of 3 linked` |
| Updates | `Up to date · checked 4m ago` or `v0.9.2 ready` |
| MCP | `● Running` / `○ Stopped` |
| Backup | `Last backup 2h ago` |
| Storage | the repository path |

## Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ Settings                          Editing  [ All repositories ▾ ]  ◜ │  header, horizon arc
├───────────────┬──────────────────────────────────────────────────────┤
│ [/ Search   ] │ 01  APPEARANCE                                       │
│               │ ──────────────────────────────────────────────────── │
│ NEEDS YOU     │ Theme              System · Light · Dark     [seg]   │
│  Linear  ●    │ Accent             ■ ■ ■ ■ custom                    │
│               │ Interface scale    − 100% +                          │
│ SETTINGS      │                                                      │
│ ▸ Appearance  │ 02  VIEWS                                            │
│   Views       │ ──────────────────────────────────────────────────── │
│   Agents      │ Sessions · journal  …                                │
│   Connections │                                                      │
│   …           │ 04  CONNECTIONS               ● 2 of 3 linked        │
│               │ GitHub             signed in as …        [⋮]         │
└───────────────┴──────────────────────────────────────────────────────┘
```

- **Header.** Title in Sora at 16px. The nine chips are replaced by one scope picker (the `RepoSelect` menu pattern, already used for the connection menu): "Editing: All repositories" or a repository name, with its path shown faint underneath.
- **Rail.** A search field, then a "Needs you" group (only when it has rows), then one link per group. The group in view expands to show its subsection links. A scroll-spy keeps the link for the part on screen highlighted.
- **List.** One scroll container. Each group has a mono number and eyebrow, a Sora title, the readout on the right and a hairline under it.
- **Rows.** Two columns: label at 13px with a one-line hint at 12px muted on the left, the control right-aligned on the right. Rows are at least 40px tall with hairline separators, following DESIGN.md's row heights. This replaces the mix of checkboxes with text, `h4` labels and disclosure boxes.
- **Below 900px** the rail collapses into a sticky top strip holding the search field and a group picker, the same way the library handles narrow widths with container queries.

## New order of the list

Grouped by what a person is trying to do, not by where the code was written:

| # | Group (anchor) | Holds (today's home) |
|---|---|---|
| 01 | Appearance `appearance` | theme, accent, interface scale, terminal text size (General → Appearance) |
| 02 | Views `views` | Sessions view: journal, density (Sessions view). Chat view, only when Chat is on (Chat). Grid views (Grid views) |
| 03 | Agents `agents` | session defaults, providers, session preferences and auto-compaction, customizations (Harness); default playbook (General → Playbooks) |
| 04 | Connections `connections` | GitHub, Linear, SSH hosts (Connections, `RemoteHostsSettings`) |
| 05 | Notifications `notifications` | banner, sound, bounce, dock badge and its categories (General → Notifications) |
| 06 | Data `data` | storage paths (Storage), backups and triggers (Backup) |
| 07 | MCP server `mcp` | host config, managed socket (MCP Server) |
| 08 | System `system` | updates, runtime (General → Updates, `RuntimePanel`), background sessions and stopping them (Harness), privacy and telemetry (Misc), experimental options |

Subsections get anchors in the form `group.part` (`agents.providers`, `system.updates`), so the rail, search and deep links all share one set of ids.

## Scope (all repositories vs one repository)

- The scope picker in the header is the only scope control.
- In repository scope, a group that is global-only shows a `Global` tag beside its title. Its controls stay visible but disabled, with one line ("Same for every repository · Edit in All repositories"). This replaces the five repeated banners.
- An overridden row gets an accent tick on its left edge and an `Override` tag with a separate "Use global" text button. The `sourceBadge` pill with a button inside it goes away.
- The rail marks global-only groups with a faint `G` in repository scope, so the person knows before scrolling.

## Search

- The field sits at the top of the rail. `/` or ⌘F focuses it while Settings is open, Esc clears it, and Enter scrolls to the first hit.
- It searches a small static index, `views/settingsIndex.ts`: one entry per subsection with `{ id, group, title, keywords }`, about 35 entries. Keywords cover the words people actually type ("dark mode", "font size", "badge", "token", "ssh", "telemetry", "compaction").
- Matches filter both places. The rail shows only matching links, with a count. The list hides subsections that don't match and leaves headers for groups that still have matches. With no hits it shows one quiet line: "Nothing matches 'xyz'".
- Matching is a case-insensitive substring on title plus keywords. Fuzzy matching is not worth a dependency for 35 entries.
- The index doubles as the source for rail order and anchors, so there is one list and not three.

## Behaviour changes under the hood

1. **Load on first sight, not on tab.** Replace each `activeSection === X` gate with `seen.has(X)`. The `seen` set comes from one `IntersectionObserver` over the group elements, and a group joins it the first time it scrolls within one screen of view. A deep link or a search jump marks its target seen before scrolling. The update check and the playbook catalog stay on mount, since they used to fire when General opened and General was the default tab.
2. **Scroll-spy** reuses the same observer: the topmost visible subsection is the active rail link.
3. **Deep links.** `openSettings(section)` takes an anchor id. The `SettingsSectionKey` values map to their new anchors (`harness`→`agents`, `storage`/`backup`→`data.storage`/`data.backup`, `sessionsView`→`views.sessions`, `gridViews`→`views.grid`), so callers in `App.tsx` keep working. Scrolling to the target is instant, because DESIGN.md says not to animate keyboard-initiated navigation.
4. **Chat hidden.** The current effect that sends an open Chat tab back to General goes away. Chat view just doesn't render, and its index entry is filtered out, while the Chat flag is off.

## Code shape

- Keep `Settings.tsx` as the owner of state and saves. Its existing `renderX()` functions become the bodies of groups. This is a layout change, not a rewrite of 2,700 lines.
- Two small primitives, both in `views/SettingsList.tsx`:
  - `<SettingsGroup id n title readout globalOnly>` for the eyebrow, title, readout and hairline.
  - `<SettingsRow label hint override onUseGlobal>{control}</SettingsRow>` for the two-column row.
- `views/settingsIndex.ts` holds the anchors, titles and keywords, plus a `matches(query)` helper with a vitest test.
- CSS moves out of `theme.css` (the `settings-*` rules near lines 2441–2820 and 10506) into `views/Settings.css`, next to `Playbooks.css`, using theme tokens only.
- Splitting `Settings.tsx` into one file per group is a separate refactor. Do it only if this work makes it necessary.

## Fonts

**Which fonts.** Geist (variable) for UI text, Geist Mono (variable) for mono, and Sora 400 and 600 for display text. All three are SIL Open Font License 1.1, so bundling and redistributing them is allowed.

**How they ship.** Through npm packages that Vite bundles into `dist/`:

- `@fontsource-variable/geist`
- `@fontsource-variable/geist-mono`
- `@fontsource/sora` (weights 400 and 600)

They are imported once in `main.tsx` and ship inside the app. There is no Google Fonts or CDN request, so they work offline and on remote-host repos too. `csp` is `null` today, and local `@font-face` needs no change there. Only the Latin `unicode-range` file loads in practice. The added weight is roughly 200 KB of woff2.

**Tokens in `theme.css`.** The current stacks stay as the fallback:

```css
--font-ui: "Geist Variable", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", sans-serif;
--font-mono: "Geist Mono Variable", SFMono-Regular, Menlo, Monaco, Consolas, monospace;
--font-display: "Sora", var(--font-ui);
--font-reading: var(--font-ui);
```

**Where `--font-display` is used.** Page titles and Settings or library group titles only, at 15–20px. DESIGN.md forbids oversized marketing type inside the product, so Sora never goes above 20px.

**Places that skip the tokens today:**

- `SessionTerminal.tsx:102` hard-codes `"Menlo, monospace"`. Read `--font-mono` the way `ArtifactMarkdown.tsx` reads `--font-reading`. xterm measures cells when it opens, so wait for `document.fonts.load('13px "Geist Mono Variable"')` before `open`/`fit`, or the grid is measured against Menlo and drifts.
- `TaskRunGraph.css:90` uses bare `monospace`. Change it to `var(--font-mono)`.
- `onboarding.css:1123` uses Georgia for the OMP mark glyph. That looks deliberate, so leave it.

**Docs.**

- Update DESIGN.md's Typography section: the fonts, the fallback rule and Sora's 20px ceiling. Keep its line about never bundling Apple's fonts.
- Add the three OFL notices to `THIRD-PARTY-NOTICES.md`.

**Risk.** Geist is slightly wider than SF Pro at 13px, so dense rows (task list, board cards, tabs) can truncate earlier. Check those screens once after the font change. Geist supports `tnum`, so `font-variant-numeric: tabular-nums` keeps working.

## Phases

1. **Fonts.** Packages, tokens, the terminal and graph fixes, DESIGN.md and notices. Independent of the rest.
2. **One list.** Render every group in the new order inside one scroll container, with the rail as anchor links, scroll-spy, the `seen` gating and remapped deep links. The content inside each group is unchanged. Rewrite the Settings tests to scroll or deep-link instead of clicking tabs.
3. **Search.** `settingsIndex.ts`, the rail field, filtering in both places, the keyboard shortcuts and the test.
4. **Restyle.** Header and scope picker, `SettingsGroup` and `SettingsRow`, readouts, the "Needs you" group, global and override treatment, and flattening the `h4`/`details` nesting into rows.

Phases 1 and 2 touch different files and can run at the same time. Phases 3 and 4 build on 2.

## Checks

- `npx vitest run src/views/Settings` and `src/views/settingsIndex.test.ts`, `npx tsc --noEmit` and biome while iterating.
- `./scripts/check.sh` once at the end.
- Seeing the result needs the app open. Per AGENTS.md that only happens when you ask, so the visual pass happens on your go.

## Left out on purpose

- A user setting for choosing the font: none until someone asks for one.
- Fuzzy search: substring matching is enough for 35 entries.
- Remembering scroll position between visits: deep links cover the real need.
- Animated scrolling: DESIGN.md says keyboard-initiated navigation is not animated.
