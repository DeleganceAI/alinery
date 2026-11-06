#!/usr/bin/env bash
# Cross-build the runtime that remote (SSH) repos install on a Linux host, and bundle it as
# app resources: alinery-app/src-tauri/resources/remote/<triple>.tar.gz plus manifest.json.
#
# Each archive holds one executable, `alinery-vinculum-daemon` (bun build --compile for the target), plus a MANIFEST in
# `sha256sum -c` format that the remote verifies after unpacking. The daemon, the MCP server and the host service
# (`--host-service`, plan S5.2) are modes of that one binary, so the build needs Bun and nothing else.
#
# Explicit and skippable: the Bun cross targets download from the network, which
# `dev-fetch-bun.sh --no-download` forbids, so tauri dev/build never run this. Release sets
# ALINERY_REQUIRE_REMOTE_RUNTIMES=1 so a missing manifest fails the build.
#
# Prerequisite (--check prints it when missing): bun, https://bun.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI="$ROOT/alinery-app/src-tauri"
PKG="$TAURI/vinculum-daemon"
OUT="$TAURI/resources/remote"
GLIBC_FLOOR=2.28

# triple | bun --target. x64 uses the baseline build: the default needs AVX2 and dies with
# "Illegal instruction" on older CPUs and many VMs.
TARGETS=(
  "x86_64-unknown-linux-gnu|bun-linux-x64-baseline"
  "aarch64-unknown-linux-gnu|bun-linux-arm64"
)

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Highest GLIBC_x.y symbol version an ELF file asks for, or empty.
max_glibc() {
  strings -a "$1" | grep -E '^GLIBC_[0-9]+(\.[0-9]+)+$' | sed 's/^GLIBC_//' | sort -uV | tail -1
}

missing=0
need() {
  if ! eval "$2" >/dev/null 2>&1; then echo "MISSING: $1  ($3)" >&2; missing=1; fi
}
check_prerequisites() {
  need bun "command -v bun" "https://bun.sh"
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

for entry in "${TARGETS[@]}"; do
  triple="${entry%%|*}"
  bun_target="${entry##*|}"
  dir="$STAGE/$triple"
  mkdir -p "$dir"
  echo "== $triple"

  bun build "$PKG/src/main.ts" "$PKG/src/platform/fsync-worker.ts" --compile --target="$bun_target" --outfile "$dir/alinery-vinculum-daemon"
  chmod +x "$dir/alinery-vinculum-daemon"

  # The floor is a promise to the remote probe: refuse to ship anything that asks for more.
  need_glibc="$(max_glibc "$dir/alinery-vinculum-daemon")"
  if [ -n "$need_glibc" ] && [ "$(printf '%s\n%s\n' "$need_glibc" "$GLIBC_FLOOR" | sort -V | tail -1)" != "$GLIBC_FLOOR" ]; then
    echo "ERROR: $triple/alinery-vinculum-daemon needs glibc $need_glibc, above the $GLIBC_FLOOR floor" >&2
    exit 1
  fi

  (cd "$dir" && echo "$(sha256 alinery-vinculum-daemon)  alinery-vinculum-daemon" > MANIFEST)
  # --no-xattrs: keep macOS provenance attributes out of the archive (they trigger warnings on extract).
  tar --no-xattrs -C "$dir" -czf "$OUT/$triple.tar.gz" alinery-vinculum-daemon MANIFEST
  echo "archive ready: $OUT/$triple.tar.gz"
done

# manifest.json: the app reads it to pick the archive for a probed host, and uses runtime_hash
# as the install directory name on the remote (a hash-named directory is never overwritten).
STAGE="$STAGE" OUT="$OUT" GLIBC_FLOOR="$GLIBC_FLOOR" TRIPLES="$(printf '%s\n' "${TARGETS[@]}" | cut -d'|' -f1 | paste -sd' ' -)" node -e '
const fs = require("fs"), crypto = require("crypto"), path = require("path");
const { STAGE, OUT, GLIBC_FLOOR, TRIPLES } = process.env;
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
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({ version: 1, glibc_floor: GLIBC_FLOOR, targets }, null, 2) + "\n");
'
echo "manifest ready: $OUT/manifest.json"
