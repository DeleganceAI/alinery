#!/usr/bin/env bash
# The app must not shell out to curl. HTTP is alinery_core::http (ureq).
# A raw Command::new("curl") is how sign-in, updates, and Linear used to
# depend on a host binary that a minimal Linux install does not have.
#
# Run: ./scripts/tests/check-no-curl.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TAURI="$ROOT/alinery-app/src-tauri"

hits=$(grep -rn 'Command::new("curl")' --include='*.rs' "$TAURI" || true)
if [ -n "$hits" ]; then
  echo "ERROR: HTTP must go through alinery_core::http, not curl:" >&2
  echo "$hits" >&2
  exit 1
fi

echo "OK: no curl subprocess"
