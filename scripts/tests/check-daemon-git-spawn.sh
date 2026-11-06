#!/usr/bin/env bash
# The daemon starts git from one file: vinculum-daemon/src/platform/git.ts (invariant 3 of the thick-daemon plan).
#
# `git -C <dir>` does not override an inherited GIT_DIR, so a raw spawn in the daemon acts on whatever repository its
# environment names (the same hazard check-git-env-scrub.sh guards on the Rust side). platform/git.ts resolves git like
# alinery_core::git_cmd (PATH without the macOS stub, then the alongside tree with GIT_EXEC_PATH) and strips the seven
# redirecting variables; a spawn anywhere else skips both. Test files build fixtures with the harness's own git and are
# not the daemon's code.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="${ALINERY_DAEMON_SRC:-$ROOT/alinery-app/src-tauri/vinculum-daemon/src}"

# spawn/exec with "git" as the program, or Bun's shell tag starting with git.
hits=$(grep -rn -E '(spawn|spawnSync|exec|execSync|execFile|execFileSync)(<[^>]*>)?\([[:space:]]*\[?[[:space:]]*["'\''`]git["'\''`]|\$`[[:space:]]*git[[:space:]]' \
  --include='*.ts' --exclude='*.test.ts' --exclude='*.testutil.ts' --exclude='*.bench.ts' \
  "$SRC" \
  | grep -v '/platform/git\.ts:' || true)

if [ -n "$hits" ]; then
  echo "ERROR: the daemon starts git only through platform/git.ts (it scrubs GIT_DIR and finds the right git):" >&2
  echo "$hits" >&2
  exit 1
fi

echo "OK: the daemon's only git spawn site is platform/git.ts"
