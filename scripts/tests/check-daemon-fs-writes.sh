#!/usr/bin/env bash
# Every file the Vinculum daemon writes goes through platform/fs.ts (writeAtomic, writeDurable,
# writeOwnerOnly), so a crash leaves the old file or the new one, never half of one. A raw
# writeFileSync, appendFileSync or Bun.write elsewhere is a torn-write bug waiting for a power cut.
# Exceptions (an append-only log) are listed with their reason in daemon-fs-writes-ok.txt.
#
# Run: ./scripts/tests/check-daemon-fs-writes.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/alinery-app/src-tauri/vinculum-daemon/src"
OK="$ROOT/scripts/tests/daemon-fs-writes-ok.txt"

hits=$(grep -rnE 'writeFileSync|appendFileSync|Bun\.write\(' "$SRC" --include='*.ts' \
  | grep -v '\.test\.ts:' | grep -v '\.testutil\.ts:' | grep -v "^$SRC/platform/fs\.ts:" | grep -vE ':[0-9]+:import ' \
  | grep -vf <(grep -vE '^(#|$)' "$OK") || true)
if [ -n "$hits" ]; then
  echo "ERROR: write daemon files through platform/fs.ts (or list the line in scripts/tests/daemon-fs-writes-ok.txt with a reason):" >&2
  echo "$hits" >&2
  exit 1
fi

echo "OK: daemon file writes go through platform/fs.ts"
