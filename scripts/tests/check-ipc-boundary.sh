#!/usr/bin/env bash
# Invariant guard (DEL-345):
#
#   No frontend file except alinery-app/src/ipc.ts may import from `@tauri-apps/*`.
#
# The IPC boundary used to be everywhere: 161 call sites across 20 files invoking 97
# commands as bare strings with untyped argument bags. Two things followed.
#
# A wrong command name or a wrong argument key was invisible until a user clicked the
# thing. `invoke("archive_task", { slgu })` type-checks, lints, builds, and ships — the
# argument is simply dropped on the floor. That is not hypothetical: migrating to typed
# wrappers immediately surfaced App.tsx passing a `prompt` key to `create_session`, which
# does not declare one, so the user's edited launch prompt had been silently discarded.
#
# And no view could be unit-tested, because there was no seam to mock — every component
# reached the backend directly.
#
# The fix is one module that owns the boundary. This gate keeps it that way: the next
# `import { invoke } from "@tauri-apps/api/core"` in a view puts the app back where it
# started, one file at a time, and nothing else would notice.
#
# Run: ./scripts/tests/check-ipc-boundary.sh   (wired into scripts/check.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/alinery-app/src"
IPC="$SRC/ipc.ts"

[ -d "$SRC" ] || { echo "ERROR: cannot find $SRC" >&2; exit 1; }
[ -f "$IPC" ] || { echo "ERROR: cannot find $IPC — the boundary module is gone." >&2; exit 1; }

hits="$(
  grep -rnE '(from|import)[[:space:]]*\(?[[:space:]]*"@tauri-apps/' \
    --include='*.ts' --include='*.tsx' "$SRC" \
    | grep -v '/ipc\.ts:' \
    || true
)"

if [ -n "$hits" ]; then
  echo "ERROR: @tauri-apps may only be imported by alinery-app/src/ipc.ts." >&2
  echo "       Add a typed wrapper there and call it, instead of invoking inline:" >&2
  echo "$hits" >&2
  exit 1
fi

# Self-check. If ipc.ts stops importing @tauri-apps entirely then either the boundary moved
# or the grep above no longer matches anything it should — and a gate that cannot fail is
# worse than no gate, because it reads as "checked".
if ! grep -qE '"@tauri-apps/' "$IPC"; then
  echo "ERROR: $IPC imports nothing from @tauri-apps — this check is no longer testing anything." >&2
  exit 1
fi

# The boundary must also still be *used*, or a green run would only mean the frontend
# stopped talking to the backend.
if ! grep -rqE '\bipc\.[a-zA-Z]' --include='*.ts' --include='*.tsx' "$SRC"; then
  echo "ERROR: nothing in alinery-app/src calls through ipc.* — the seam is orphaned." >&2
  exit 1
fi

echo "OK: @tauri-apps is confined to alinery-app/src/ipc.ts"
