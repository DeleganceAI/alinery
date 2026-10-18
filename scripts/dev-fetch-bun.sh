#!/usr/bin/env bash
# Fetch Bun at or above scripts/bun-pin.txt, install the exact Pi Durable 1.3.0
# packages, and compile alinery-pi-daemon beside the app executable.
# Never a sidecar. Never invoked from scripts/check.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIN="$(tr -d '[:space:]' < "$ROOT/scripts/bun-pin.txt")"
PKG="$ROOT/alinery-app/src-tauri/pi-daemon"
TARGET="$(cargo metadata --format-version 1 --no-deps --manifest-path "$ROOT/alinery-app/src-tauri/Cargo.toml" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).target_directory')"
DEST="$TARGET/debug/alinery-pi-daemon"

version_ok() {
  local got="$1" need="$2"
  node -e 'const [a,b]=process.argv.slice(1).map(v=>v.split(".").map(Number)); const n=Math.max(a.length,b.length); for (let i=0;i<n;i++){const d=(a[i]??0)-(b[i]??0); if (d) process.exit(d>=0?0:1)}' "$got" "$need"
}

if [ "${1:-}" = "--check" ]; then
  echo "pin: $PIN"
  if command -v bun >/dev/null 2>&1; then
    echo "bun: $(bun --version)"
  else
    echo "bun: MISSING"
  fi
  exit 0
fi

BUN="${BUN:-}"
if [ -z "$BUN" ]; then
  if command -v bun >/dev/null 2>&1 && version_ok "$(bun --version)" "$PIN"; then
    BUN="$(command -v bun)"
  else
    INSTALL="${TMPDIR:-/tmp}/alinery-bun-$PIN"
    mkdir -p "$INSTALL"
    curl -fsSL https://bun.sh/install | BUN_INSTALL="$INSTALL" bash -s "bun-v$PIN"
    BUN="$INSTALL/bin/bun"
  fi
fi
GOT="$("$BUN" --version)"
version_ok "$GOT" "$PIN" || { echo "ERROR: Bun $GOT is older than $PIN" >&2; exit 1; }

(cd "$PKG" && "$BUN" install --frozen-lockfile || "$BUN" install)
"$BUN" build "$PKG/src/main.ts" --compile --outfile "$DEST"
chmod +x "$DEST"
BYTES="$(wc -c < "$DEST" | tr -d ' ')"
START="$(python3 - <<PY
import subprocess, time
t=time.perf_counter()
subprocess.run(["$DEST", "--protocol-version"], check=True, stdout=subprocess.DEVNULL)
print(f"{time.perf_counter()-t:.3f}")
PY
)"
echo "alinery-pi-daemon: $DEST"
echo "size_bytes: $BYTES"
echo "cold_start_seconds: $START"
echo "compiler: $GOT"
