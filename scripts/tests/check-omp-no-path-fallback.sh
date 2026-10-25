#!/usr/bin/env bash
# Vinculum replaces the OMP binary. Nothing in the daemon or the app may exec `omp`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
status=0

if grep -RInE 'spawn(Sync)?\([[:space:]]*"omp"|Command::new\("omp"\)|CommandBuilder::new\("omp"\)' \
  "$ROOT/alinery-app/src-tauri/vinculum-daemon" \
  "$ROOT/alinery-app/src-tauri/src" \
  "$ROOT/alinery-app/src-tauri/alinery-core/src" \
  "$ROOT/alinery-app/src-tauri/mcp" \
  --include='*.ts' --include='*.rs'; then
  echo "ERROR: omp must not be spawned" >&2
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "OK: nothing spawns the omp binary"
fi
exit "$status"
