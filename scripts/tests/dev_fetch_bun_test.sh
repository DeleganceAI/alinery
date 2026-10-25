#!/usr/bin/env bash
# Source contracts for scripts/bun-pin.txt and scripts/dev-fetch-bun.sh. No network.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PIN="$ROOT/scripts/bun-pin.txt"
SCRIPT="$ROOT/scripts/dev-fetch-bun.sh"
PKG="$ROOT/alinery-app/src-tauri/vinculum-daemon/package.json"
CHECK="$ROOT/scripts/check.sh"
fails=0

if [ ! -f "$SCRIPT" ]; then
  echo "FAIL - fetch script exists"
  exit 1
fi
bash -n "$SCRIPT" || fails=$((fails + 1))

PIN_VALUE="$(tr -d '[:space:]' < "$PIN")"
node -e 'const [major,minor,patch]=process.argv[1].split(".").map(Number); if (!(major>1 || (major===1 && (minor>4 || (minor===4 && patch>=3))))) process.exit(1)' "$PIN_VALUE" \
  && echo "ok   - pin is Bun 1.4.3 or newer" \
  || { echo "FAIL - pin is Bun 1.4.3 or newer ($PIN_VALUE)"; fails=$((fails + 1)); }

SRC="$(cat "$SCRIPT")"
case "$SRC" in
  *"--compile"*) echo "ok   - fetch compiles with bun build --compile" ;;
  *) echo "FAIL - fetch compiles with bun build --compile"; fails=$((fails + 1)) ;;
esac
case "$SRC" in
  *"version_ok"*) echo "ok   - fetch fails an older compiler" ;;
  *) echo "FAIL - fetch fails an older compiler"; fails=$((fails + 1)) ;;
esac
case "$(cat "$CHECK")" in
  *"dev-fetch-bun.sh"*) echo "FAIL - check.sh must not invoke the fetch"; fails=$((fails + 1)) ;;
  *) echo "ok   - check.sh does not invoke the fetch" ;;
esac

case "$SRC" in
  *"--release"*) echo "ok   - fetch selects the cargo profile" ;;
  *) echo "FAIL - fetch selects the cargo profile"; fails=$((fails + 1)) ;;
esac
case "$SRC" in
  *"--no-download"*) echo "ok   - fetch can refuse the Bun download" ;;
  *) echo "FAIL - fetch can refuse the Bun download"; fails=$((fails + 1)) ;;
esac
case "$SRC" in
  *"up to date"*) echo "ok   - fetch short-circuits an up-to-date output" ;;
  *) echo "FAIL - fetch short-circuits an up-to-date output"; fails=$((fails + 1)) ;;
esac

# A launch may compile the optional daemon, but it must never reach the network
# for a toolchain or fail the launch when Bun is absent.
LAUNCHER="$ROOT/alinery-app/scripts/tauri.mjs"
case "$(cat "$LAUNCHER")" in
  *"dev-fetch-bun.sh"*) echo "ok   - the tauri launcher compiles the daemon" ;;
  *) echo "FAIL - the tauri launcher compiles the daemon"; fails=$((fails + 1)) ;;
esac
case "$(cat "$LAUNCHER")" in
  *"--no-download"*) echo "ok   - the launcher never downloads Bun" ;;
  *) echo "FAIL - the launcher never downloads Bun"; fails=$((fails + 1)) ;;
esac

python3 - "$PKG" <<'PY'
import json, sys
pkg = json.load(open(sys.argv[1]))
deps = pkg.get("dependencies", {})
expected = {
    "@earendil-works/pi-durable": "1.3.0",
    "@earendil-works/pi-ai": "1.3.0",
    "@earendil-works/chord": "1.3.0",
}
bad = [f"{name}={deps.get(name)!r}" for name, pin in expected.items() if deps.get(name) != pin]
if bad:
    raise SystemExit("FAIL - packages are not exactly 1.3.0: " + ", ".join(bad))
print("ok   - three packages are exactly 1.3.0")
PY
status=$?
if [ "$status" -ne 0 ]; then fails=$((fails + 1)); fi

if [ "$fails" -ne 0 ]; then
  echo "FAILED: $fails bun fetch check(s)"
  exit 1
fi
echo "OK: dev-fetch-bun source contracts"
