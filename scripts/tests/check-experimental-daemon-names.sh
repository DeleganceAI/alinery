#!/usr/bin/env bash
# The release resolver launches any sibling named alineryd or alineryd-*.
# The prototype and helper must not use those names, and must not be sidecars.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TAURI="$ROOT/alinery-app/src-tauri/tauri.conf.json"
RESOLVER="$ROOT/alinery-app/src-tauri/alinery-core/src/daemon_client.rs"
CARGO="$ROOT/alinery-app/src-tauri/alineryd/Cargo.toml"
fails=0

fail() { echo "FAIL - $1" >&2; fails=$((fails + 1)); }

EXT="$(python3 -c 'import json,sys; print(",".join(json.load(open(sys.argv[1]))["bundle"]["externalBin"]))' "$TAURI")"
if [ "$EXT" != "alineryd,alinery-mcp,alinery-runner" ]; then
  fail "externalBin lists an experimental binary: $EXT"
else
  echo "ok   - externalBin does not list the experimental binaries"
fi

if grep -n 'name = "alineryd"' "$CARGO" | grep -v 'name = "alineryd"' >/dev/null; then
  :
fi
if grep -nE 'name = "alineryd-"' "$CARGO"; then
  fail "helper or prototype package name is alineryd-*"
fi
if ! grep -q 'name = "alinery-playbook"' "$CARGO"; then
  fail "helper bin is not named alinery-playbook"
else
  echo "ok   - helper bin is alinery-playbook"
fi

# The release resolver may still match alineryd / alineryd-*. It must not be
# taught to return the experimental names.
if grep -nE 'alinery-pi-daemon|alinery-vinculum-daemon|alinery-playbook' "$RESOLVER"; then
  fail "release resolver mentions an experimental binary"
else
  echo "ok   - release resolver does not return the experimental names"
fi

if [ "$fails" -ne 0 ]; then
  exit 1
fi
echo "OK: experimental daemon names stay off the release resolver"
