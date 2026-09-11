#!/usr/bin/env bash
# Source contracts for scripts/dev-fetch-omp.sh. No network.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/dev-fetch-omp.sh"
CHECK="$ROOT/scripts/check.sh"
TAURI="$ROOT/alinery-app/src-tauri/tauri.conf.json"
COPY="$ROOT/alinery-app/src-tauri/scripts/copy-sidecar.sh"

fails=0
contains() {
  local what="$1" needle="$2" hay="$3"
  case "$hay" in
    *"$needle"*) echo "ok   - $what" ;;
    *)
      echo "FAIL - $what"
      echo "         expected to contain: [$needle]"
      fails=$((fails + 1))
      ;;
  esac
}
not_contains() {
  local what="$1" needle="$2" hay="$3"
  case "$hay" in
    *"$needle"*)
      echo "FAIL - $what"
      echo "         expected NOT to contain: [$needle]"
      fails=$((fails + 1))
      ;;
    *) echo "ok   - $what" ;;
  esac
}

if [ ! -f "$SCRIPT" ]; then
  echo "ERROR: cannot find $SCRIPT" >&2
  exit 1
fi
if ! bash -n "$SCRIPT"; then
  echo "FAIL - bash -n scripts/dev-fetch-omp.sh"
  fails=$((fails + 1))
else
  echo "ok   - bash -n scripts/dev-fetch-omp.sh"
fi

SRC="$(cat "$SCRIPT")"
contains "dev-fetch sources omp.sh" "scripts/lib/omp.sh" "$SRC"
contains "dev-fetch calls fetch_official_omp" "fetch_official_omp" "$SRC"
contains "dev-fetch uses omp_dest_dir" "omp_dest_dir" "$SRC"
contains "dev-fetch macOS dest is /Applications/Alinery.app" "/Applications/Alinery.app" "$SRC"
contains "dev-fetch Linux dest uses ~/.local/share/alinery" ".local/share/alinery" "$SRC"

CHECK_SRC="$(cat "$CHECK")"
not_contains "check.sh does not invoke dev-fetch-omp.sh" "dev-fetch-omp.sh" "$CHECK_SRC"

EXT="$(python3 -c 'import json,sys; print(",".join(json.load(open(sys.argv[1]))["bundle"]["externalBin"]))' "$TAURI")"
if [ "$EXT" = "alineryd,alinery-mcp,alinery-runner" ]; then
  echo "ok   - externalBin is still the three sidecars"
else
  echo "FAIL - externalBin is still the three sidecars"
  echo "         got: [$EXT]"
  fails=$((fails + 1))
fi

COPY_SRC="$(cat "$COPY")"
contains "copy-sidecar builds alineryd" "-p alineryd" "$COPY_SRC"
contains "copy-sidecar builds alinery-mcp" "-p alinery-mcp" "$COPY_SRC"
contains "copy-sidecar builds alinery-runner" "-p alinery-runner" "$COPY_SRC"
not_contains "copy-sidecar does not mention omp package" "omp-" "$COPY_SRC"

if [ "$fails" -ne 0 ]; then
  echo
  echo "FAILED: $fails dev-fetch-omp check(s)"
  exit 1
fi
echo "OK: dev-fetch-omp source contracts"
