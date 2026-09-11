#!/usr/bin/env bash
# Invariant guard (ticket: daemon protocol gate + GH #132):
#
#   No saga UI code may gate a destructive action on `window.confirm` / `confirm` /
#   `window.alert`. They do NOT work in this app.
#
# `tauri_plugin_dialog::init()` (registered in lib.rs) injects an init script that
# REPLACES the browser builtins:
#
#   window.confirm = async function (message) { return await invoke('plugin:dialog|confirm', …) }
#
# so `if (!window.confirm(msg)) return;` tests a *Promise* — always truthy — and the
# guarded destructive action runs unconditionally, with no dialog the user can answer.
# The native panel behind it never appears either: `dialog:allow-confirm` is not in
# capabilities/default.json, so the invoke is rejected. wry's WKWebView UI delegate
# implements only the file-open panel, so there is no browser fallback on macOS.
#
# That silently un-gated eight loss-of-work confirmations (close repo, take over repo,
# stop all sessions, restore backup, purge archived storage, remove worktree, reset
# harnesses) — the exact failure class this ticket exists to prevent. The replacement is
# the in-app promise-based dialog in alinery-app/src/confirm.tsx: `await confirmDanger(…)`
# or `await askConfirm(…)`.
#
# Run: ./scripts/tests/check-no-window-confirm.sh   (wired into scripts/release.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/alinery-app/src"

[ -d "$SRC" ] || { echo "ERROR: cannot find $SRC" >&2; exit 1; }

# The lowercase-`confirm` alternative is what catches an unqualified `confirm(…)` — a
# local named `confirm` shadowing the builtin is the same trap with a friendlier face.
# camelCase callers (askConfirm, confirmDanger) cannot match: the letter after `confirm`
# is not `(`. Only confirm.tsx is exempt — it quotes the builtins to explain the ban.
hits="$(
  grep -rnE '(^|[^.[:alnum:]_])(window\.)?(confirm|alert|prompt)[[:space:]]*\(' \
    --include='*.ts' --include='*.tsx' "$SRC" \
    | grep -v '/confirm\.tsx:' \
    || true
)"

if [ -n "$hits" ]; then
  echo "ERROR: window.confirm/alert/prompt are non-functional in this app (see alinery-app/src/confirm.tsx)." >&2
  echo "       Use askConfirm/confirmDanger from ./confirm instead:" >&2
  echo "$hits" >&2
  exit 1
fi

# The replacement must exist and the callers must actually use it, or a green run here
# would only mean "nobody confirms anything".
if ! grep -q 'window.confirm' "$SRC/confirm.tsx" 2>/dev/null; then
  echo "ERROR: alinery-app/src/confirm.tsx is missing or no longer documents the hazard." >&2
  exit 1
fi
if ! grep -rq 'confirmDanger\|askConfirm' --include='*.tsx' "$SRC"; then
  echo "ERROR: no UI code calls askConfirm/confirmDanger — the confirmations vanished." >&2
  exit 1
fi

echo "OK: no window.confirm/alert/prompt in the UI"
