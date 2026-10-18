#!/usr/bin/env bash
# The helper calls the existing engine and stops before harness launch.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER="$ROOT/alinery-app/src-tauri/alineryd/src/playbook_helper.rs"
BIN="$ROOT/alinery-app/src-tauri/alineryd/src/bin/alinery-playbook.rs"
fails=0
scan() {
  local label="$1" pattern="$2"
  if grep -nE "$pattern" "$HELPER" "$BIN"; then
    echo "FAIL - helper $label" >&2
    fails=$((fails + 1))
  else
    echo "ok   - helper does not $label"
  fi
}
scan "call spawn_session" 'spawn_session[[:space:]]*\('
scan "call repo_ownership::acquire" 'repo_ownership::acquire[[:space:]]*\('
scan "run the release boot sweep" 'boot_sweep[[:space:]]*\('
if [ "$fails" -ne 0 ]; then
  exit 1
fi
echo "OK: playbook helper does not launch a harness"
