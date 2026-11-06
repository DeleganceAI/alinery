#!/usr/bin/env bash
# check-daemon-git-spawn.sh passes on a tree whose only git spawn is platform/git.ts, and fails when any other
# daemon file (or a second spelling of the spawn) starts git.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$ROOT/scripts/tests/check-daemon-git-spawn.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/platform" "$TMP/domain"
printf 'export const git = () => Bun.spawn(["git", "status"]);\n' > "$TMP/platform/git.ts"
printf 'export const x = 1;\n' > "$TMP/domain/ok.ts"
printf 'Bun.spawnSync(["git", "status"]);\n' > "$TMP/domain/fixture.test.ts"

ALINERY_DAEMON_SRC="$TMP" "$GATE" >/dev/null || { echo "FAIL: the clean tree must pass" >&2; exit 1; }

fails() {
  printf '%s\n' "$2" > "$TMP/domain/bad.ts"
  if ALINERY_DAEMON_SRC="$TMP" "$GATE" >/dev/null 2>&1; then echo "FAIL: $1 must be refused" >&2; exit 1; fi
  rm -f "$TMP/domain/bad.ts"
}
fails "Bun.spawn" 'Bun.spawn(["git", "status"]);'
fails "Bun.spawnSync" 'const r = Bun.spawnSync([ "git", "-C", dir ]);'
fails "child_process execFile" 'execFile("git", ["status"]);'
fails "spawn with a type argument" 'spawn<Foo>("git", ["status"]);'
fails "the Bun shell tag" 'await Bun.$`git status`;'

echo "OK: check-daemon-git-spawn.sh refuses a git spawn outside platform/git.ts"
