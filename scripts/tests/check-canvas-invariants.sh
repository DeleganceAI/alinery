#!/usr/bin/env bash
# Invariant guard for Orbitron View (the spatial authoring canvas).
#
# Five of this slice's locks are *absences* — there is nothing to call and nothing to render,
# only source that must not contain something. A behavioural test cannot see any of them, so
# per AGENTS.md they live in one grep gate rather than as readFileSync assertions scattered
# through vitest files (which would be a second convention beside the seven that exist).
#
#   1. `getComputedStyle` never appears in the paint path. It forces a style recalc, and the
#      card loop runs up to ~200 times per frame; `canvas/tokens.ts` reads the palette once
#      and threads it through. The symptom of a regression is a slightly janky board, which
#      no review notices.
#   2. No "lite card while panning" path. The ticket is explicit: full cards while dragging
#      the view. A `drawCardLite` or a `lite` branch keyed on `panning` is the shortcut that
#      makes the perf numbers look fine and the product feel cheap.
#   3. The agent pane is a product chat, not an OMP console. Board writes consult
#      CanvasEditMode via applyBoardToolForMode. Raw invoke/fetch/@tauri-apps and the
#      string "Accept (MCP apply)" stay forbidden; a typed `from "../ipc"` import is
#      allowed. The pane must not grow an OMP/provider/MCP configuration surface or a
#      coding-tool surface. Replacing this rule (not deleting it) is the ticket's
#      deliberate act — the inert-pane lock no longer holds.
#   4. No "Sample" data control anywhere in the view. The POC shipped sample data for demos;
#      the product board starts empty.
#   5. The Orbitron typeface is never loaded. The view's name is not a font choice — the
#      theme is DESIGN.md's role tokens.
#   6. The `.orbitron` host fills its view instead of sizing to content. Every child of it is
#      absolutely positioned, so an in-flow box collapses to height 0 — and a zero-height host
#      means a 1px canvas backing store (nothing paints, no hit area) and `bottom`-anchored
#      chrome rendered *above* the view, behind the top bar. That shipped: the rule was
#      `flex: 1 1 auto` inside a `display: block` parent, where `flex` does nothing. jsdom has
#      no layout engine, so no vitest can catch it; this is the cheapest check that can.
#
# Comment-only lines are excluded, because every rule above is *documented* in the files it
# governs — the first draft of this gate failed on its own explanations. A match sharing a
# line with real code still fails, which is the safe direction.
#
# Both properties below are load-bearing, and both are scars this repo already has:
#   * It is registered in scripts/check.sh. That script hard-codes its gate list; an
#     unregistered gate never runs, which is exactly the check-no-window-confirm.sh bug.
#   * It fails when a guarded file is missing. `grep` over a nonexistent path reports
#     success, so a gate that guards nothing would go green forever.
#
# Run: ./scripts/tests/check-canvas-invariants.sh   (wired into scripts/check.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/alinery-app/src"

PAINT="$SRC/canvas/paint.ts"
PIPES="$SRC/canvas/pipes.ts"
VIEW="$SRC/views/CanvasView.tsx"
AGENT="$SRC/views/OrbitronAgentPane.tsx"
TOKENS="$SRC/canvas/tokens.ts"
THEME="$SRC/theme.css"
TYPES="$SRC/types.ts"
HOST="$SRC/canvas/host-tools.ts"
fail=0
note() { echo "ERROR: $*" >&2; fail=1; }

# `grep -n` output minus comment-only lines (`//`, `/*`, ` *`), so a documented rule does not
# trip the rule it documents.
code_hits() {
  grep -nE "$2" "$1" 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*(//|/\*|\*)' || true
}

# Assert existence FIRST: a grep over a missing path is a silent pass.
for f in "$PAINT" "$PIPES" "$VIEW" "$AGENT" "$TOKENS" "$THEME" "$TYPES" "$HOST"; do
  [ -f "$f" ] || note "missing guarded file: ${f#"$ROOT"/}"
done
[ "$fail" -eq 0 ] || exit 1

# 1. getComputedStyle belongs to tokens.ts and nowhere else on the canvas path.
for f in "$PAINT" "$PIPES" "$VIEW"; do
  hits="$(code_hits "$f" 'getComputedStyle')"
  if [ -n "$hits" ]; then
    note "${f#"$ROOT"/} calls getComputedStyle — read the palette once via canvas/tokens.ts instead:"
    echo "$hits" >&2
  fi
done
# The reader it delegates to must still exist, or the rule above is vacuous.
[ -n "$(code_hits "$TOKENS" 'getComputedStyle')" ] || note "canvas/tokens.ts no longer reads the theme — readCanvasTokens is the only allowed reader"

# 2. No lite-card path.
for f in "$PAINT" "$VIEW"; do
  hits="$(code_hits "$f" '[Dd]raw[A-Za-z]*[Ll]ite|[Ll]ite[A-Za-z]*[Cc]ard|liteMode|panLite|panningLite')"
  if [ -n "$hits" ]; then
    note "${f#"$ROOT"/} has a lite-card path — the ticket requires full cards while panning:"
    echo "$hits" >&2
  fi
done

# 3. Agent pane is a product chat, not an OMP console; board writes consult canvas edit mode.
# Ban raw invoke/fetch/@tauri-apps and Accept (MCP apply). Allow from "../ipc".
# Require the mode union + the apply helper that consults it (missing file/symbol fails).
hits="$(code_hits "$AGENT" '\b(invoke|fetch)[[:space:]]*\(')"
if [ -n "$hits" ]; then
  note "OrbitronAgentPane must not call invoke/fetch — go through typed ipc.ts wrappers:"
  echo "$hits" >&2
fi
[ -z "$(code_hits "$AGENT" '@tauri-apps/')" ] || note "OrbitronAgentPane must not import @tauri-apps — ipc.ts is the only allowed backend seam"
[ -z "$(code_hits "$AGENT" 'Accept \(MCP apply\)')" ] || note "OrbitronAgentPane must not offer 'Accept (MCP apply)' — labels are Accept / Reject"
[ -n "$(code_hits "$TYPES" 'CanvasEditMode')" ] || note "types.ts must declare CanvasEditMode — board writes consult the three-way canvas edit mode"
[ -n "$(code_hits "$HOST" 'applyBoardToolForMode')" ] || note "canvas/host-tools.ts must export applyBoardToolForMode — the helper the mode gate consults"

# 4. No sample-data control. `Sample` as a word, not a substring of something innocent.
for f in "$VIEW" "$AGENT"; do
  hits="$(code_hits "$f" '\bSample\b')"
  if [ -n "$hits" ]; then
    note "${f#"$ROOT"/} offers a Sample control — the product board starts empty:"
    echo "$hits" >&2
  fi
done

# 5. The Orbitron typeface is never loaded. The name is the view's, not a font's.
hits="$(grep -rniE 'orbitron\.woff|font-family[^;]*Orbitron' --include='*.ts' --include='*.tsx' --include='*.css' "$SRC" | grep -vE ':[[:space:]]*(//|/\*|\*)' || true)"
if [ -n "$hits" ]; then
  note "the Orbitron typeface must never be loaded — the view's name is not a font choice:"
  echo "$hits" >&2
fi

# 6. The `.orbitron` host fills its view. Read just that rule's block out of theme.css and
# require the two declarations that make it fill; reject content-sizing, which collapses it.
block="$(awk '/^\.orbitron \{/{f=1} f{print} f&&/^\}/{exit}' "$THEME")"
if [ -z "$block" ]; then
  note "theme.css has no '.orbitron {' rule — the canvas host must declare its own size"
else
  echo "$block" | grep -qE '^[[:space:]]*position:[[:space:]]*absolute[[:space:]]*;' \
    || note ".orbitron must be 'position: absolute' — every child of it is absolutely positioned, so an in-flow host collapses to height 0"
  echo "$block" | grep -qE '^[[:space:]]*inset:[[:space:]]*0[[:space:]]*;' \
    || note ".orbitron must be 'inset: 0' — without it the host has no height, the canvas backing store is 1px, and bottom-anchored chrome lands behind the top bar"
  if echo "$block" | grep -qE '^[[:space:]]*flex:'; then
    note ".orbitron must not size itself with 'flex' — its parent (.view) is display:block, so flex is inert there; that is the bug this rule exists to stop"
  fi
fi

[ "$fail" -eq 0 ] || exit 1
echo "OK: Orbitron canvas invariants hold (no getComputedStyle in paint, no lite cards, agent pane uses ipc + mode-gated apply, no Accept (MCP apply), no sample data, no Orbitron font, stage fills the view)"
