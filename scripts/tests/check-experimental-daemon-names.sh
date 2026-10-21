#!/usr/bin/env bash
# The release resolver launches alinery-vinculum-daemon, the only daemon sidecar.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TAURI="$ROOT/alinery-app/src-tauri/tauri.conf.json"
RESOLVER="$ROOT/alinery-app/src-tauri/alinery-core/src/daemon_client.rs"
fails=0

fail() { echo "FAIL - $1" >&2; fails=$((fails + 1)); }

EXT="$(python3 -c 'import json,sys; print(",".join(json.load(open(sys.argv[1]))["bundle"]["externalBin"]))' "$TAURI")"
if [ "$EXT" != "alinery-vinculum-daemon,alinery-mcp" ]; then
  fail "externalBin must be vinculum plus mcp, got: $EXT"
else
  echo "ok   - externalBin is alinery-vinculum-daemon and alinery-mcp"
fi

if grep -q 'alineryd' "$TAURI" || grep -q 'alinery-runner' "$TAURI"; then
  fail "tauri.conf still names alineryd or alinery-runner"
else
  echo "ok   - tauri.conf does not name alineryd or the runner"
fi

if grep -q 'alinery-vinculum-daemon' "$RESOLVER"; then
  echo "ok   - release resolver launches alinery-vinculum-daemon"
else
  fail "release resolver does not mention alinery-vinculum-daemon"
fi

if grep -nE 'name == "alineryd"|starts_with\("alineryd-"\)' "$RESOLVER"; then
  fail "release resolver still matches alineryd"
fi

if [ "$fails" -ne 0 ]; then
  exit 1
fi
echo "OK: Vinculum is the release daemon"
