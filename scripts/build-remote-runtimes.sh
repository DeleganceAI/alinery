#!/usr/bin/env bash
# Cross-build the runtime that remote (SSH) repos install on a Linux or macOS host, and bundle it as
# app resources: alinery-app/src-tauri/resources/remote/<triple>.tar.gz plus manifest.json.
#
# Each archive holds one executable, `alinery-vinculum-daemon` (bun build --compile for the target), the Python the
# office skills run on (`python/`, staged by scripts/python-runtime/stage.sh), the skills Alinery includes (`skills/`,
# copied from vinculum-daemon/skills), and a MANIFEST in `sha256sum -c` format that the remote verifies after unpacking.
# The daemon, the MCP server and the host service (`--host-service`, plan S5.2) are modes of that one binary. The app unpacks this machine's archive too, for its local daemon's Python and
# skills (`pi_durable::local_runtime_home`).
#
# `npm run tauri dev|build` (scripts/tauri.mjs) runs this first. The Bun cross targets download from the
# network the first time, then come from Bun's cache; a failure only warns there, and release sets
# ALINERY_REQUIRE_REMOTE_RUNTIMES=1 so a missing manifest fails the build.
#
# Prerequisites (--check prints them when missing): bun, https://bun.sh; curl, for the pinned Python builds (cached
# under ~/.cache/alinery after the first run).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI="$ROOT/alinery-app/src-tauri"
PKG="$TAURI/vinculum-daemon"
OUT="$TAURI/resources/remote"
GLIBC_FLOOR=2.28
# Bun 1.4.3 darwin builds set LC_BUILD_VERSION minos 13.0; checked per binary below.
MACOS_FLOOR=13.0

# triple | bun --target. x64 uses the baseline build: the default needs AVX2 and dies with
# "Illegal instruction" on older CPUs and many VMs.
TARGETS=(
  "x86_64-unknown-linux-gnu|bun-linux-x64-baseline"
  "aarch64-unknown-linux-gnu|bun-linux-arm64"
  "x86_64-apple-darwin|bun-darwin-x64"
  "aarch64-apple-darwin|bun-darwin-arm64"
)

if command -v sha256sum >/dev/null 2>&1; then SHA256_CMD=sha256sum; else SHA256_CMD="shasum -a 256"; fi
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Highest GLIBC_x.y symbol version an ELF file asks for, or empty.
max_glibc() {
  strings -a "$1" | grep -E '^GLIBC_[0-9]+(\.[0-9]+)+$' | sed 's/^GLIBC_//' | sort -uV | tail -1
}

# Apple silicon kills an unsigned executable, and Bun 1.4.3 cross-building x64 on an arm64 Mac leaves an invalid
# signature, so every darwin binary is re-signed ad hoc here. Ad hoc is enough: a file unpacked from tar over ssh carries
# no quarantine attribute, so Gatekeeper never asks for notarization. vtool and codesign exist only on macOS; elsewhere
# the darwin targets are skipped, and the app then refuses Mac hosts as having no bundled runtime.
have_darwin_tools() { command -v vtool >/dev/null 2>&1 && command -v codesign >/dev/null 2>&1; }
darwin_checks() {
  local minos
  minos="$(vtool -show-build "$2" | awk '$1 == "minos" { print $2; exit }')"
  if [ -z "$minos" ] || [ "$(printf '%s\n%s\n' "$minos" "$MACOS_FLOOR" | sort -V | tail -1)" != "$MACOS_FLOOR" ]; then
    echo "ERROR: $1/alinery-vinculum-daemon needs macOS ${minos:-unknown}, above the $MACOS_FLOOR floor" >&2
    exit 1
  fi
  codesign --force --sign - "$2"
  codesign -v "$2" || { echo "ERROR: $1/alinery-vinculum-daemon is not validly signed" >&2; exit 1; }
}

missing=0
need() {
  if ! eval "$2" >/dev/null 2>&1; then echo "MISSING: $1  ($3)" >&2; missing=1; fi
}
check_prerequisites() {
  need bun "command -v bun" "https://bun.sh"
  need curl "command -v curl" "for the pinned Python builds"
}

if [ "${1:-}" = "--check" ]; then
  check_prerequisites
  [ "$missing" = 0 ] && echo "remote runtime prerequisites: ok"
  exit "$missing"
fi
[ $# -eq 0 ] || { echo "usage: build-remote-runtimes.sh [--check]" >&2; exit 2; }
check_prerequisites
[ "$missing" = 0 ] || exit 1

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/alinery-remote-runtimes.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$OUT"
rm -f "$OUT"/*.tar.gz "$OUT/manifest.json"

"$ROOT/scripts/install-proto.sh"
(cd "$PKG" && bun install --frozen-lockfile || bun install)

BUILT=()
for entry in "${TARGETS[@]}"; do
  triple="${entry%%|*}"
  bun_target="${entry##*|}"
  if [[ "$triple" == *-apple-darwin ]] && ! have_darwin_tools; then
    echo "warning: no vtool/codesign on this machine; skipping $triple" >&2
    continue
  fi
  dir="$STAGE/$triple"
  mkdir -p "$dir"
  echo "== $triple"

  bun build "$PKG/src/main.ts" "$PKG/src/platform/fsync-worker.ts" --compile --target="$bun_target" --outfile "$dir/alinery-vinculum-daemon"
  chmod +x "$dir/alinery-vinculum-daemon"

  # The floors are a promise to the remote probe: refuse to ship anything that asks for more.
  case "$triple" in
    *-apple-darwin) darwin_checks "$triple" "$dir/alinery-vinculum-daemon" ;;
    *)
      need_glibc="$(max_glibc "$dir/alinery-vinculum-daemon")"
      if [ -n "$need_glibc" ] && [ "$(printf '%s\n%s\n' "$need_glibc" "$GLIBC_FLOOR" | sort -V | tail -1)" != "$GLIBC_FLOOR" ]; then
        echo "ERROR: $triple/alinery-vinculum-daemon needs glibc $need_glibc, above the $GLIBC_FLOOR floor" >&2
        exit 1
      fi
      ;;
  esac

  "$ROOT/scripts/python-runtime/stage.sh" "$triple" "$dir/python"
  cp -R "$PKG/skills" "$dir/skills"

  # Every regular file, so the remote's check covers the Python too (symlinks are checked through their targets).
  (cd "$dir" && find . -type f ! -name MANIFEST -print0 | sort -z | xargs -0 $SHA256_CMD | sed 's|  \./|  |' > MANIFEST)
  # --no-xattrs: keep macOS provenance attributes out of the archive (they trigger warnings on extract).
  tar --no-xattrs -C "$dir" -czf "$OUT/$triple.tar.gz" alinery-vinculum-daemon python skills MANIFEST
  echo "archive ready: $OUT/$triple.tar.gz"
  BUILT+=("$triple")
done

# manifest.json: the app reads it to pick the archive for a probed host, and uses runtime_hash
# as the install directory name on the remote (a hash-named directory is never overwritten).
STAGE="$STAGE" OUT="$OUT" GLIBC_FLOOR="$GLIBC_FLOOR" MACOS_FLOOR="$MACOS_FLOOR" TRIPLES="${BUILT[*]}" node -e '
const fs = require("fs"), crypto = require("crypto"), path = require("path");
const { STAGE, OUT, GLIBC_FLOOR, MACOS_FLOOR, TRIPLES } = process.env;
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const targets = {};
for (const triple of TRIPLES.split(" ")) {
  const manifest = fs.readFileSync(path.join(STAGE, triple, "MANIFEST"), "utf8");
  targets[triple] = {
    archive: `${triple}.tar.gz`,
    sha256: sha(path.join(OUT, `${triple}.tar.gz`)),
    runtime_hash: crypto.createHash("sha256").update(manifest).digest("hex").slice(0, 16),
  };
}
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({ version: 1, glibc_floor: GLIBC_FLOOR, macos_floor: MACOS_FLOOR, targets }, null, 2) + "\n");
'
echo "manifest ready: $OUT/manifest.json"
