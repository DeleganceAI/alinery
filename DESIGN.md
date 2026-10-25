# Alinery App Design

## Source of truth

- Status: Active
- Last refreshed: 2026-08-14
- Scope: the Alinery macOS desktop application in `alinery-app/`.
- Authority: this file is the canonical design contract for app UI, UX, frontend implementation, and visual review.
- Brand palette and identity follow `../alinery-website/DESIGN.md` and its implemented artwork. Product UI behavior and component decisions remain governed by this file.
- Existing product behavior, data safety, session lifecycle, and Tauri constraints remain authoritative. A reskin must not silently change them.
- Existing `alinery-app/src/theme.css` and `alinery-app/src/appearance.ts` describe the current implementation, not the target visual direction.

### Reference hierarchy

When references disagree, use this order:

1. This `DESIGN.md`.
2. Existing Alinery product behavior, safety contracts, accessibility requirements, and native desktop constraints.
3. `../alinery-website/DESIGN.md` and implemented website artwork for palette and identity only.
4. [shadcn/ui](https://ui.shadcn.com/docs) for general component anatomy, composition, variants, and interaction states.
5. [AI Elements](https://elements.ai-sdk.dev/) for AI-native patterns such as tasks, plans, tool calls, approvals, sources, artifacts, and prompt input.
6. [Thinking Orbs](https://orbs.jakubantalik.com/) for indeterminate loading and AI activity states.
7. [Lucide](https://lucide.dev/) for interface iconography.
8. [Base UI](https://base-ui.com/react/overview/about) for accessible low-level behavior when an existing Alinery control is insufficient.
9. [Beautiful UI](https://www.beautifului.dev/), [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/), OpenAI Codex, and Anthropic Claude as quality and restraint references only.

Do not copy proprietary assets, branding, product layouts, or trade dress from reference products. Translate their clarity, restraint, density, and craft into an original Alinery interface.

### Open-source reference stack

- **Canonical general system:** shadcn/ui v4 component and registry conventions. MIT licensed.
- **Canonical AI pattern library:** AI Elements. Apache-2.0 licensed.
- **Canonical loading treatment:** [Thinking Orbs](https://github.com/Jakubantalik/thinking-orbs) through the `thinking-orbs` package. MIT licensed.
- **Canonical icon library:** [Lucide React](https://lucide.dev/guide/packages/lucide-react) through the `lucide-react` package. ISC licensed.
- **Preferred behavioral primitive layer:** Base UI when Alinery needs a new accessible behavior primitive. MIT licensed and intentionally unstyled.
- **Implementation model:** source-owned components and Alinery-owned semantic tokens. Avoid a black-box theme that makes basic styling require overrides.
- **Adoption rule:** do not maintain two parallel design systems. Existing controls should be reskinned or progressively replaced behind shared Alinery components. Add a primitive only when it removes custom accessibility or interaction code.
- **Styling rule:** the references define anatomy and behavior; this document defines how Alinery looks. Stock shadcn styling is a starting point, not the finished product.

## Brand

### Personality

Alinery is quiet, precise, capable, trustworthy, and deeply focused. It should feel like a native professional tool made by a team with strong taste: calm enough for all-day use, dense enough for experts, and clear enough that a new user can understand what is happening.

The intended quality bar is the restraint of Apple, the tool clarity of Codex, the warmth and readability of Claude, and the AI-specific craft of Beautiful UI. Alinery must still look original.

### Trust signals

- Local-first behavior is visible and understandable.
- Agent state and side effects are explicit.
- Destructive or externally visible actions require clear confirmation.
- Repository, task, session, model, worktree, and artifact provenance remain easy to inspect.
- The interface distinguishes observed state from inferred state.
- Errors explain what happened and give a concrete recovery action.
- The UI never implies that work was saved, sent, stopped, merged, or completed without evidence.

### Avoid

- The current TRON or cyberpunk aesthetic as the primary interface.
- Neon glows, scanlines, grids, HUD decoration, faux-terminal chrome, or sci-fi ornament.
- Generic AI gradients, purple-blue bloom, glassmorphism, floating blobs, or decorative particles.
- Excessive cards, pills, badges, borders, shadows, and rounded containers.
- Oversized marketing typography inside the product.
- Dense walls of monospaced or uppercase text.
- Cute assistant personas, mascots, gamification, or celebratory motion.

## Product goals

### Goals

- Make the state of every task and agent session legible at a glance.
- Help users decide what needs attention and act without losing context.
- Make multi-session AI work feel controlled rather than chaotic.
- Keep repository, task, session, artifact, and Playbooks relationships understandable.
- Make high-risk actions deliberate while keeping routine actions fast.
- Support long, high-frequency work sessions without visual fatigue.
- Establish a coherent component and token language that coding agents can extend reliably.
- Make commenting on markdown plans and docs the primary product loop, not chat.
- Keep a human gate before child work runs: do not auto-start nested subtasks until the user accepts the high-level plan.
- Get a first-time user to value on day one from one opinionated default, then disclose customization.

### Non-goals

- Redesigning Alinery's information architecture or backend behavior solely to match a reference library.
- Turning Alinery into a chat application.
- Making an experimental view the ship gate or the day-one default.
- Hiding terminal, filesystem, Git, session, or model details that experts need.
- Making every surface visually novel.
- Adding animation, abstraction, or dependencies for their own sake.
- Reproducing the marketing website's design language.

### Success signals

- A user can identify running, waiting, failed, completed, and inactive work without opening each task.
- Primary Playbooks remain usable with keyboard only.
- A first-time user can distinguish tasks, sessions, artifacts, and repositories, and reach value from the default view without configuring the product.
- A user can comment on a markdown plan or doc in place, without dropping into chat.
- Child work does not start until the parent plan is accepted, and a focused child keeps parent context.
- Existing users retain product capability and recoverability after the reskin.
- Light and dark appearances feel intentionally designed rather than mechanically inverted.
- New UI work can cite this file and reuse shared tokens/components instead of inventing local styling.

## Personas and jobs

### Primary personas

- A technical founder coordinating several AI coding tasks across repositories.
- A software engineer running multiple harnesses and reviewing their output.
- A reviewer who needs to understand changes, provenance, and requested decisions quickly.

### User jobs

- See what needs attention now.
- Create and organize durable tasks.
- Start, resume, observe, and stop agent sessions safely.
- Review artifacts, diffs, plans, and handoffs.
- Comment on markdown plans and docs in place.
- Accept or reject a high-level plan before child work starts.
- Answer agent questions and approve consequential actions.
- Move between repositories without losing orientation.
- Diagnose failure and recover work without guessing.

### Key contexts of use

- Long desktop sessions on macOS.
- A 900 x 600 minimum window through large desktop displays.
- Keyboard-heavy navigation with occasional pointer use.
- Multiple live processes where an incorrect action can lose work.
- Mixed content density: compact tables, long-form artifacts, terminals, dialogs, and settings.

## Information architecture

### Primary navigation

- Tasks: list and kanban projections of durable work. Kanban is the day-one default. Experimental grid, canvas, and graph views may ship behind a flag or hotkey as alternate representations of the same cards. They must not change task, session, or Playbooks behavior.
- Sessions: live and historical agent activity.
- Wiki: durable project knowledge.
- Settings: repositories, connections, harnesses, appearance, notifications, storage, sessions, MCP, backup, and related system controls.

### Core screens

- Task list.
- Kanban board (default task projection).
- Experimental task views (grid, canvas, graph), flag-gated.
- Task detail and task session management.
- Plan and document review with inline comments.
- First-run onboarding.
- Session terminal and session action state.
- Artifact viewer, diff review, comments, and review handoff.
- Create task and create session flows.
- Sessions list.
- Wiki.
- Settings.
- Command palette.
- Confirmation, archive, resume-token, repository, and other modal flows.

### Content hierarchy

Use the following order within a screen or component:

1. Current state or required decision.
2. Primary object name and context.
3. Primary action.
4. Supporting metadata and provenance.
5. Secondary actions.
6. Advanced or destructive controls.

## Design principles

### 1. Work before chrome

The task, session, artifact, or decision is the visual focus. Navigation and container styling should recede until needed.

### 2. Dense, not cramped

Alinery is an expert desktop tool. Prefer compact rows, short labels, and progressive disclosure, while preserving clear grouping and comfortable reading surfaces.

### 3. State is a first-class object

Running, idle, waiting for input, waiting for approval, completed, failed, interrupted, and unavailable states must have consistent language and visuals. Never encode state with color or motion alone.

### 4. Consequences before confirmation

Before a consequential action, state what will happen, which repository/task/session it affects, and whether it can be reversed. Safe choices receive default focus.

### 5. Native restraint

Prefer system behavior, familiar controls, crisp typography, subtle structure, and brief interruptible feedback. Do not animate routine work for decoration.

### 6. Own the final layer

Use shadcn/ui and AI Elements as proven patterns, then refine them through Alinery tokens and shared components. A component should feel native to Alinery, not pasted from a registry.

### 7. Preserve orientation

Repository, task, session, phase, and artifact context should remain visible across navigation, overlays, and errors. Avoid transitions that make users reconstruct where they are.

### 8. Plan before descent

Do not start nested or child work until the human has accepted the high-level plan. When focused child Playbooks are created, they keep parent design, scope, and preference context.

### 9. Documents over chat

The primary loop is reading and commenting on markdown plans and artifacts. Chat is a supporting surface, not the product.

## Visual language

### Color

Alinery uses the website's quiet black-space surfaces and warm white typography with a vibrant royal blue accent. `#315BFF` is the default user-selectable accent; the app derives a readable interaction color from it in each appearance. Light appearance is a warm-white inversion, not a mechanically reversed dark palette.

Semantic roles, not raw palette names, are the component API. The values below are the initial target palette and may be tuned only through visual and contrast review.

| Role | Dark | Light | Usage |
| --- | --- | --- | --- |
| Canvas | `#000104` | `#FFFEFA` | Window and primary background |
| Surface | `#08090B` | `#FFFFFF` | Panels, menus, dialogs |
| Surface raised | `#0E1013` | `#FFFFFF` | Elevated overlays and selected regions |
| Surface subtle | `#1B1D21` | `#F4F1EA` | Hover, secondary controls, inset regions |
| Text strong | `#FFFEFA` | `#0A0A0A` | Primary content |
| Text | `#F4F1EA` | `#0A0A0A` | Standard body and labels |
| Text muted | `#9B9B97` | `#60625E` | Secondary metadata |
| Border | `rgb(244 241 234 / 0.12)` | `rgb(10 10 10 / 0.12)` | Structural separation |
| Border strong | `rgb(244 241 234 / 0.24)` | `rgb(10 10 10 / 0.22)` | Selected, focused, or elevated edges |
| Accent base | `#315BFF` | `#315BFF` | User-selectable source color |
| Accent readable | `#587AFF` | `#315BFF` | Contrast-adjusted primary action, focus, active state |
| Accent subtle | `rgb(49 91 255 / 0.24)` | `rgb(49 91 255 / 0.12)` | Selection and hover background |
| On accent | `#0A0A0A` | `#FFFFFF` | Text and icons on solid accent surfaces |
| Success | `#55C58A` | `#147A46` | Confirmed success only |
| Warning | `#FFB347` | `#8A5A00` | Attention and recoverable risk |
| Danger | `#FF3D1F` | `#A62715` | Destructive and failure states |

Rules:

- Use accent sparingly. Most of the interface should remain neutral.
- Appearance exposes one accent picker. The selected base color is preserved while readable tokens are derived automatically for light and dark surfaces.
- Follow the macOS appearance by default; explicit Light and Dark choices override the system setting.
- Do not use gradients for ordinary product surfaces.
- Do not use glow as a default focus, hover, selection, or status treatment.
- Use color to reinforce a label or icon, never to replace it.
- Use borders for structure and state. Use restrained shadows only for true elevation.
- Terminal ANSI colors remain functional but should sit inside the surrounding neutral shell.

### Typography

- UI font: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", sans-serif`.
- Monospace: `SFMono-Regular, Menlo, Monaco, Consolas, monospace`.
- The app must not bundle or redistribute Apple's proprietary fonts. The system stack uses them only when supplied by macOS.
- Use monospace for code, paths, identifiers, terminal content, timestamps when alignment matters, and compact technical metadata.
- Use the UI font for navigation, controls, prose, settings, dialogs, and artifact reading.
- Default sizes:
  - `12px`: metadata and compact labels.
  - `13px`: controls, dense rows, table cells.
  - `14px`: body copy and standard reading UI.
  - `16px`: section titles and prominent dialog titles.
  - `20px`: page titles and major empty-state headings.
- Prefer weights 400, 500, and 600. Reserve 700 for rare emphasis.
- Use sentence case. Avoid interface-wide uppercase and decorative letter spacing.
- Keep long-form artifact content between roughly 60 and 80 characters per line when space allows.
- Use tabular numbers for durations, counts, timestamps, and aligned metrics.

### Spacing and layout rhythm

- Base unit: `4px`.
- Preferred spacing steps: `4`, `8`, `12`, `16`, `24`, `32`.
- Dense control gaps: `6-8px`.
- Related content groups: `12-16px`.
- Major screen regions: `24-32px` when space permits.
- Default control height: `32px`; prominent controls may use `36px`.
- Table and list rows should generally remain between `32px` and `40px`, increasing only for meaningful secondary content.
- Use alignment, whitespace, and separators before adding another container.
- Preserve resizable panes and let primary work surfaces consume available space.
- Avoid card grids when a list, table, split view, or inspector better expresses the relationship.

### Shape, border, and elevation

- Small controls: `6px` radius.
- Inputs, menus, and standard cards: `8px` radius.
- Dialogs and large floating surfaces: `10px` radius.
- Pills are reserved for tags, filters, compact status, and token-like values.
- Nested corners must be concentric: outer radius equals inner radius plus padding.
- Structural borders are one device pixel where possible.
- Hover should not make cards jump or float.
- Use a small layered shadow for menus and dialogs; do not shadow every card.
- Selected state uses a subtle background plus a stronger border or indicator, not a glow.

### Motion

- Routine transitions: `120-180ms`.
- Complex overlay transitions: no more than `220ms`.
- For CSS transitions, animate only `opacity`, `transform`, and, sparingly, `filter`.
- Use interruptible CSS transitions for interactive states.
- No bounce, spring overshoot, shimmer, perpetual pulse, ambient loops, or decorative animation.
- Thinking Orbs is the only repeating animation approved for visible indeterminate loading or AI activity. Do not introduce a second spinner or loader language.
- Do not animate keyboard-initiated navigation.
- Loading motion must be paired with a static label or progress state.
- Respect `prefers-reduced-motion` and preserve the same information without movement.
- Never use `transition: all`.

### Iconography and imagery

- Use `lucide-react` as Alinery's canonical interface icon library. Its restrained outline style and shadcn/ui alignment fit Alinery's quiet desktop direction.
- Use `16px` icons in dense controls and metadata, `18px` for ordinary inline actions, `20px` for primary toolbar actions, and `24px` only for prominent standalone use.
- Default icon stroke is `1.5px` beside regular text and `2px` beside semibold text or where additional definition is required.
- Icons inherit `currentColor`.
- Outline is the default. Communicate selection through the control's color, background, border, or indicator; fill a glyph only when that icon and semantic state clearly call for it.
- Do not mix icon families. If Lucide lacks a product-specific symbol, use a simple custom inline SVG that follows Lucide's `24 x 24` grid, stroke, caps, joins, and optical weight rather than adding another icon package.
- Existing generic SVGs may remain during migration only when they match this grammar. New generic interface icons use Lucide.
- Import named icons directly so unused icons remain tree-shakeable.
- Decorative icons beside visible text are hidden from assistive technology. Icon-only actions require an accessible name and a visible tooltip.
- Preserve the Alinery mark, but remove glow and decorative effects from ordinary product placement.
- Product UI does not use stock photography, generated illustrations, or decorative AI imagery.

## Components

### General component reference

Use shadcn/ui for component anatomy and state completeness:

- Button and button group.
- Input, textarea, field, label, checkbox, radio, switch, select, and combobox.
- Tabs, breadcrumb, sidebar/navigation, pagination, and command menu.
- Dropdown menu, context menu, popover, tooltip, hover card, and collapsible.
- Dialog, alert dialog, drawer/sheet, and toast.
- Table, data table, item, card, badge, skeleton, progress, and empty state. Indeterminate loading uses Thinking Orbs rather than a shadcn spinner.
- Scroll area, separator, resizable panes, and keyboard hint.

Use the smallest variant set that covers real Alinery behavior:

- Buttons: primary, secondary, ghost, and destructive.
- Sizes: compact, default, and icon-only.
- Every interactive component: default, hover, pressed, focus-visible, disabled, and loading where applicable.
- Form controls: empty, populated, invalid, read-only, and disabled.
- Selection controls: unselected, selected, mixed where semantically valid, and unavailable.

### Alinery domain components

Shared Alinery components should own the final class names, tokens, semantics, and variants for:

- App shell and native window chrome.
- Primary navigation and current-location treatment.
- Repository switcher and repository context.
- Task row/card, task metadata, Playbooks phase, and task actions.
- Kanban column and task placement.
- Experimental task representations (grid, canvas, graph) behind a flag.
- Markdown plan/document reader with inline comments.
- Parent-to-child task context and the human gate before descending into subtasks.
- First-run onboarding.
- Session row, session controls, lifecycle, and live status.
- Status indicator and attention state.
- Prompt composer, model selection, and attachments.
- Artifact list, artifact reader, diff, comments, and provenance.
- Terminal shell and terminal/session split view.
- Review handoff and related-task context.
- Settings navigation, sections, fields, and connection status.
- Command palette, toast, tooltip, confirmation, and destructive dialogs.
- Loading, empty, error, unavailable, and recovery states.

### AI-native pattern mapping

Use AI Elements as the pattern reference, adapted to Alinery's terminology and layout:

| Alinery need | AI Elements reference | Alinery rule |
| --- | --- | --- |
| Agent progress | `Task`, `Plan`, `Queue` | Show durable steps and current status without theatrical animation |
| Tool activity | `Tool`, `Agent` | Show action, target, status, duration, and expandable evidence |
| Human decision | `Confirmation` | Name the exact side effect, scope, reversibility, and safe default |
| User-visible thinking | `Reasoning`, `Chain of Thought` | Show concise progress summaries or traces, never hidden model chain-of-thought |
| Sources and provenance | `Sources`, `Inline Citation`, `Context` | Keep source identity close to the claim or artifact it supports |
| Prompting | `Prompt Input`, `Attachments`, `Model Selector` | Keep the primary prompt path simple; progressively disclose configuration |
| Coding output | `Artifact`, `Code Block`, `File Tree`, `Terminal`, `Test Results`, `Stack Trace` | Preserve exact technical content and make copying/opening explicit |
| Playbooks visualization | `Canvas`, `Node`, `Connection`, `Panel` | Use only when relationships cannot be understood more clearly as a list or sequence |

AI components are not chat bubbles by default. Choose the structure that best expresses the work: row, timeline, inspector, artifact, terminal, or decision card.

### Component behavior rules

- One obvious primary action per region.
- Secondary actions recede visually; destructive actions are separated and plainly labeled.
- Do not hide essential actions exclusively behind hover.
- Hover-only actions must also appear on keyboard focus.
- Menus and dialogs support Escape, correct focus trapping, and focus restoration.
- Destructive confirmations default focus to the safe choice.
- Lists and tables preserve selection during refresh when the selected object still exists.
- Streaming content should not steal scroll position or cause avoidable layout shift.
- Long paths and identifiers truncate in the middle or end as appropriate, with the full value available on demand.

## Accessibility

- Target WCAG 2.2 AA and usable macOS VoiceOver behavior.
- All Playbooks must be possible with keyboard only.
- Use native HTML semantics before ARIA.
- Visible focus is required on every interactive element and must remain clear in light and dark modes.
- Default focus treatment is a `2px` accent ring with enough offset to remain distinct from the component border.
- Focus order follows visual reading order.
- Status always includes text; color, icon, and motion are supplemental.
- Icon-only buttons require accessible names and visible tooltips.
- Forms pair labels, descriptions, validation, and recovery text with their controls.
- Error messages explain how to recover; do not rely on a red border alone.
- Contrast must be measured for every rendered foreground/background pair, including muted text and disabled controls.
- Reduced motion removes nonessential movement without removing state or sequence.
- Terminal and code surfaces retain readable selection, caret, and contrast behavior.
- Do not reduce hit targets below `24 x 24px`; aim for `32 x 32px` or larger for routine desktop controls.

## Responsive behavior

- Primary platform: macOS desktop through Tauri.
- Minimum supported window: `900 x 600`.
- Do not invent a mobile layout for the desktop app.
- At constrained widths, collapse secondary metadata before primary state or action.
- Split views may collapse into a single active pane with an explicit way back.
- Dialogs stay within the viewport and preserve access to actions.
- Long tables use truncation, horizontal scrolling, column prioritization, or an inspector rather than shrinking text below the type scale.
- Hover enhancements must not be required for keyboard or accessibility operation.

## Interaction states

### Loading

Alinery uses four of the nine Thinking Orb states and no others. Choose by the kind of wait, not by how the operation happens to be named in code. `ORB_STATE` and `ORB_SPEED` are exported from `alinery-app/src/Indicators.tsx`; import them rather than repeating the literals, so retuning the orb stays a single edit.

| The wait is | State | Speed | Size | Use |
| --- | --- | --- | --- | --- |
| A session doing work | `ORB_STATE` (`solving`) | `ORB_SPEED_RUNNING` (`0.5`) | 20px | `RunningIndicator` |
| A session starting or loading | `ORB_STATE` | `ORB_SPEED` (`0.35`) | 20px | `RunningIndicator running={false}` |
| A region fetching Alinery's own data | `ORB_STATE` | `ORB_SPEED`, applied automatically | 20px | `LoadingState state={ORB_STATE}` |
| The app starting, before any content | `searching` | `ORB_SPEED` | 64px | Boot screen only |
| A route loading lazily | `working` | Package default | 20px | `LoadingState` in a `<Suspense>` fallback |
| A named non-session operation | `connecting`, `composing`, `searching` | Package default | 20px | `LoadingState state="…"` |

Rules:

- One state for all session activity, at two rates. Work that is actually moving runs at `ORB_SPEED_RUNNING`; a session still warming up — starting, loading — runs at the slower `ORB_SPEED`, so a live session reads as livelier than one still connecting. Never vary the orb *state* per session kind, and never let the rate be the only signal: the visible label — “Running”, “Starting”, “Loading” — still carries the state, and callers choose a rate through `running`, not by passing a number.
- Both rates sit well under the package default. A board can show a dozen running sessions at once, and the ceiling on the faster rate is whatever still reads as calm across a full column.
- Slow only what is long-lived. `ORB_SPEED` suits a wait a user watches for minutes. A route fallback lasts a frame or two on a warm bundle, where `0.35` shows only a static first frame; leave those at package speed.
- Match the wait to what replaces it. A region fetching data resolves into rows carrying `ORB_STATE`, so the wait uses it too. One animation handing off to a different one reads as two events rather than one.
- The boot screen is the single place another state is correct: it appears alone, and at 64px `searching` reads as a whole form rather than a scatter of dots. It still shares `ORB_SPEED`.
- `breathing`, `listening`, `weaving`, and `shaping` are unused. Introducing one requires a wait this table does not already cover.
- Preserve the surrounding layout when possible.
- Use `ThinkingOrb` from `thinking-orbs` for visible indeterminate loading, processing, and AI activity. Do not use a generic spinner, shimmer, bouncing dots, or a second loader system.
- Pair every orb with a concise static label such as “Connecting”, “Loading artifacts”, or “Starting session”. When the visible label carries the status, set the canvas to `aria-hidden="true"` to prevent duplicate announcements and announce meaningful status changes politely.
- Keep the orb monochrome and theme-aware. Use the current Alinery appearance explicitly if automatic theme detection does not follow the app's theme state.
- Preserve the package's reduced-motion behavior, which replaces animation with a representative static frame, and verify it in the native app.
- Use determinate progress when the application knows meaningful completion, and use a skeleton only when the eventual content geometry is predictable. Do not combine an orb, progress bar, and skeleton for the same wait.
- Do not use an orb for queued, idle, paused, waiting-for-input, or waiting-for-approval states; those require a stable status icon and text.
- Use one orb for a loading region rather than animating every row when many items load together.
- Do not use playful loading copy or fake progress.

### Empty

- Explain what the surface contains.
- State why it is empty when known.
- Offer one relevant next action when the user can resolve it.
- Do not decorate empty states more heavily than populated states.

### Error

- State what failed in plain language.
- Preserve technical detail for inspection or copying.
- Give the next safe recovery action.
- Distinguish a product error, missing dependency, unavailable repository, permission problem, and agent failure.

### Success

- Confirm the completed action briefly and specifically.
- Do not celebrate routine actions with confetti, large illustrations, or prolonged animation.
- Keep durable evidence visible where the user expects it.

### Disabled and unavailable

- Prefer explaining why an action is unavailable.
- Do not use disabled styling to hide permission, lifecycle, or dependency problems.
- Disabled controls remain legible; reduced contrast must still meet the intended accessibility treatment.

### Agent lifecycle

Use these canonical labels unless product behavior requires a more specific term:

- Queued.
- Running.
- Waiting for input.
- Waiting for approval.
- Idle.
- Completed.
- Failed.
- Interrupted.
- Stopped.
- Unavailable.

#### Session indicators

Each state gets exactly one treatment, and weight tracks how much the state should pull the eye. Only activity animates. `StatusDot` and `TaskRunningDot` in `shared.tsx` own these; a new surface composes them rather than inventing a marker.

Weight is the design: it tracks what the state asks of the user, from an animation down to a muted glyph. Treatments run in four tiers.

| Tier | State | Treatment | Color |
| --- | --- | --- | --- |
| Activity — moving | Running | Activity orb at `ORB_SPEED_RUNNING`, with label | Inherits text |
| Activity — warming up | Starting, Loading | Activity orb at `ORB_SPEED`, with label | Inherits text |
| Blocked on a person | Waiting for input | Chip: glyph, label, tint, border | Accent border and glyph, `text-strong` label |
| Blocked on a person | Waiting for approval | Chip: glyph, label, tint, border | Warning |
| Outcome | Failed | Glyph with label, no chip | Danger |
| Missing information | Unknown | Glyph with label, no chip, regular weight | Text faint |
| Ended | Completed, Ready to advance, Idle | 8px dot with label | Success |
| Ended | Stale, Exited | 8px dot with label | Text faint |
| Needs review | Finished, not yet reviewed | 6px `IdleDot`, no label | Warning |

Glyphs are Lucide at 14px, from `StateIcon` in `Indicators.tsx`: `MessageSquareDot`, `Hand`, `CircleX`, `CircleQuestionMark`. Stroke follows the label weight — 2 beside semibold, 1.5 beside muted `unknown`.

Two components own this table for the whole app: `StatusDot` for a session's own status, and `TaskRunningDot` for a task's rollup on a board or list. Every surface that shows session state — sessions list, task list, board, task detail, session view, settings — composes one of them. A new surface composes them too; it does not re-derive a marker from an observation, because that is how one view drifts out of the vocabulary.

Rules:

- Never animate a state that is not running. A moving indicator on stopped work reads as progress that is not happening, which is the specific failure this rule exists to prevent. Queued, idle, paused, waiting-for-input, and waiting-for-approval take a stable marker and text.
- Only the two states blocked on a person carry a chip. Waiting for input and waiting for approval are the states a user must clear, so they get a tint and a border; a card can show one without the rest of the board shouting. Do not add chip weight to a state the user cannot act on.
- `unknown` is not a failure. An unreadable harness is missing information, so it drops out of danger entirely to text faint at regular weight. Rendering it in danger beside a genuinely failed session makes both harder to trust.
- Finished-but-unreviewed is the one non-running state in warning. It is the only marker that asks for attention without a visible label, so its tooltip and accessible name must both say what it means.
- Ended-well states share the success dot. Completed, ready-to-advance, and idle differ in their label, not their color; states that merely stopped — stale, exited — drop to text faint.
- Every indicator carries a label, a `title`, or an `aria-label`. State never lives in color or motion alone, including in minimal mode where the visible label is suppressed.

## Content voice

- Tone: calm, direct, exact, and respectful of technical users.
- Use sentence case.
- Lead buttons with verbs: “Create task”, “Start session”, “Open artifact”, “Stop session”.
- Name the object and consequence in destructive actions: “Archive task” rather than “Archive”; “Stop 3 sessions” rather than “Continue”.
- Prefer concrete system language over vague reassurance.
- Avoid “magic”, “smart”, “effortless”, “AI-powered”, “something went wrong”, and anthropomorphic filler.
- Do not call a task, session, artifact, push, PR, or approval complete unless the underlying state confirms it.
- Preserve exact commands, paths, identifiers, model names, error messages, and user-authored text.
- Empty states and errors should be actionable, not conversational.

## Implementation constraints

### Framework and platform

- React 19, TypeScript, Vite, and Tauri v2.
- Native window controls, keyboard behavior, filesystem safety, daemon ownership, and session persistence must remain intact.
- `alinery-app/src/ipc.ts` remains the sole frontend boundary for Tauri APIs.
- Do not replace native desktop behavior with web-only assumptions.

### Design tokens and styling

- Create one semantic token layer consumed by every theme and component.
- Components may not read raw palette values directly.
- The new Alinery light and dark appearances are the primary visual targets.
- Appearance exposes only System, Light, and Dark. Legacy palette data is ignored when old settings are loaded.
- Do not add Tailwind solely to reproduce shadcn's default classes. The default migration path is to apply the reference anatomy to Alinery's existing CSS and shared React components.
- If a later implementation plan adopts Tailwind, it must replace rather than duplicate the styling layer, preserve Tauri behavior, and include a staged rollback path.
- Base UI may be introduced selectively for complex accessible primitives such as dialogs, menus, popovers, tooltips, selects, or comboboxes.
- AI Elements source may be adapted selectively. Do not import a complete chat shell when Alinery needs only a task, tool, approval, or artifact pattern.
- `thinking-orbs` and `lucide-react` are the approved loading and icon packages. Add each only with its first real use, not as speculative setup.
- No other new dependency without a concrete component need that existing code, native HTML, or Base UI cannot satisfy cleanly.

### Performance

- Keep navigation, selection, typing, terminal interaction, and session controls immediately responsive.
- Avoid runtime CSS-in-JS, broad rerendering, unnecessary blur, large translucent layers, and persistent decorative animation.
- Virtualize only when measured list size or rendering cost requires it.
- Lazy-load genuinely heavy secondary surfaces; do not split trivial components.

### Compatibility and safety

- Preserve all current repository, task, session, artifact, worktree, and daemon lifecycle behavior.
- Preserve safe-default confirmation behavior.
- Preserve session continuity across app quit and relaunch.
- Never make destructive operations easier to trigger for visual simplicity.
- Themes may change presentation, not information architecture, focus order, labels, feature access, or lifecycle semantics.

### Verification expectations

- Run the repository's required automated checks after implementation.
- Verify the native app through the checkout-built `npm run tauri dev` Playbooks, not only a browser preview.
- Review at the minimum `900 x 600` window and a larger desktop size.
- Verify light mode, dark mode, keyboard-only operation, focus restoration, VoiceOver spot checks, reduced motion, loading, empty, error, disabled, and destructive states.
- Compare screenshots across related screens to catch local styling drift.
- A component is not complete until its default, hover, pressed, focus-visible, disabled, loading, error, and selected states that apply have been observed.

## Prompt contract

Reference this file directly in every app design or frontend prompt. A useful starting prompt is:

> Read `DESIGN.md` completely before making UI decisions. Treat it as the canonical design contract for the Alinery desktop app. Use `../alinery-website/DESIGN.md` and its implemented artwork only for shared brand palette and identity. Use shadcn/ui for general component anatomy and state coverage, AI Elements for AI-native task/tool/approval/artifact patterns, Thinking Orbs for indeterminate loading and AI activity, Lucide React for interface icons, and Base UI only when an accessible behavioral primitive is needed. Do not introduce another spinner or icon family. Apply Alinery's own tokens and visual language rather than stock shadcn styling. Preserve existing product behavior, Tauri boundaries, keyboard access, safe confirmations, session continuity, and repository context. Do not turn the product into a chat app. Keep kanban as the day-one default; experimental views stay flag-gated. Do not auto-start child work before the human accepts the plan. Before editing, name the DESIGN.md sections and existing shared components that govern the change. After editing, run the required checks and verify the result in the native app in light and dark modes.

For a bounded component task, append:

> Keep the diff limited to the smallest shared component or token layer that fixes every affected caller. Do not create a parallel component, theme, or styling system. Show all applicable interaction states and report any DESIGN.md conflict before inventing a local exception.

## Design review checklist

Before approving app UI work, confirm:

- [ ] The work cites the relevant sections of this file.
- [ ] Website guidance was limited to shared palette and identity; app behavior still follows this contract.
- [ ] Existing product behavior and safety contracts are unchanged unless explicitly requested.
- [ ] The component uses shared Alinery tokens and shared component patterns.
- [ ] The result is not stock shadcn and does not revive the TRON/cyberpunk treatment.
- [ ] Chat was not treated as the primary loop; plan/doc comments remain the default collaboration surface.
- [ ] Experimental views, if touched, stayed flag-gated and did not replace the kanban default.
- [ ] Child or nested work still requires an explicit human accept of the parent plan.
- [ ] Interface icons use Lucide or a product-specific SVG that follows Lucide's geometry; no competing icon family was introduced.
- [ ] State is understandable without color or motion.
- [ ] Keyboard, focus, VoiceOver, and reduced-motion behavior are covered.
- [ ] Light and dark appearances were both reviewed.
- [ ] Indeterminate loading uses the correct Thinking Orb size and semantic state with a static label; determinate progress and skeletons are used only where appropriate.
- [ ] Empty, error, disabled, selected, and destructive states were handled where applicable.
- [ ] The native Tauri app was inspected at `900 x 600` and a larger desktop size.
- [ ] Automated checks passed or the exact gap is documented.

## Open questions

- [ ] After the first representative screen is implemented, visually tune the proposed neutral and accent values against native screenshots while preserving their semantic roles.
- [ ] Decide whether Alinery should maintain a lightweight in-app component gallery for visual regression and design review after the shared components stabilize.
