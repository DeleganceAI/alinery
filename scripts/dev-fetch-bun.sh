#!/usr/bin/env bash
# Fetch Bun at or above scripts/bun-pin.txt, install the pinned pi-durable 1.3.0
# packages, and compile alinery-vinculum-daemon beside the app executable for one cargo
# profile. `npm run tauri dev` and `npm run tauri build` run this with
# --no-download; run it bare to allow the Bun download.
# Never a sidecar. Never invoked from scripts/check.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIN_FILE="$ROOT/scripts/bun-pin.txt"
PIN="$(tr -d '[:space:]' < "$PIN_FILE")"
PKG="$ROOT/alinery-app/src-tauri/vinculum-daemon"
TARGET="$(cargo metadata --format-version 1 --no-deps --manifest-path "$ROOT/alinery-app/src-tauri/Cargo.toml" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).target_directory')"
INSTALL="${TMPDIR:-/tmp}/alinery-bun-$PIN"

PROFILE=debug
CHECK=0
FORCE=0
DOWNLOAD=1
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --release) PROFILE=release ;;
    --force) FORCE=1 ;;
    --no-download) DOWNLOAD=0 ;;
    *) echo "unknown option: $arg (want --check, --release, --force, --no-download)" >&2; exit 2 ;;
  esac
done
DEST="$TARGET/$PROFILE/alinery-vinculum-daemon"

version_ok() {
  local got="$1" need="$2"
  node -e 'const [a,b]=process.argv.slice(1).map(v=>v.split(".").map(Number)); const n=Math.max(a.length,b.length); for (let i=0;i<n;i++){const d=(a[i]??0)-(b[i]??0); if (d) process.exit(d>=0?0:1)}' "$got" "$need"
}

if [ "$CHECK" = 1 ]; then
  echo "pin: $PIN"
  if command -v bun >/dev/null 2>&1; then
    echo "bun: $(bun --version)"
  else
    echo "bun: MISSING"
  fi
  exit 0
fi

# bun install is a registry round trip and the compile rewrites a 70 MB binary, so
# an up-to-date output short-circuits both.
if [ "$FORCE" = 0 ] && [ -f "$DEST" ]; then
  stale=0
  for input in "$PIN_FILE" "$PKG/package.json" "$PKG"/src/*.ts; do
    if [ "$input" -nt "$DEST" ]; then
      stale=1
    fi
  done
  if [ "$stale" = 0 ]; then
    echo "alinery-vinculum-daemon: $DEST (up to date)"
    exit 0
  fi
fi

BUN="${BUN:-}"
if [ -z "$BUN" ] && [ -x "$INSTALL/bin/bun" ] && version_ok "$("$INSTALL/bin/bun" --version)" "$PIN"; then
  BUN="$INSTALL/bin/bun"
fi
if [ -z "$BUN" ] && command -v bun >/dev/null 2>&1 && version_ok "$(bun --version)" "$PIN"; then
  BUN="$(command -v bun)"
fi
if [ -z "$BUN" ]; then
  if [ "$DOWNLOAD" = 0 ]; then
    echo "alinery-vinculum-daemon: skipped (Bun $PIN is not installed; run scripts/dev-fetch-bun.sh to fetch it)"
    exit 0
  fi
  mkdir -p "$INSTALL"
  curl -fsSL https://bun.sh/install | BUN_INSTALL="$INSTALL" bash -s "bun-v$PIN"
  BUN="$INSTALL/bin/bun"
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
echo "alinery-vinculum-daemon: $DEST"
echo "size_bytes: $BYTES"
echo "cold_start_seconds: $START"
echo "compiler: $GOT"
