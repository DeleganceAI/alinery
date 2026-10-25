#!/usr/bin/env bash
# Every git spawn in the Rust workspace must go through alinery_core::git_cmd.
#
# `git -C <dir>` does NOT override an inherited GIT_DIR — git honours GIT_DIR regardless of
# -C — so a raw `Command::new("git")` operates on whatever repo the caller's environment
# points at. Git exports GIT_DIR whenever it runs a hook, and that is exactly how this was
# found: the suite, run from the pre-push hook, reinitialised the developer's real repository
# (core.bare=true, breaking `git status` in the clone and all its worktrees). The production
# paths are worse — `git worktree add`, `git checkout -b`, `git commit` in the wrong repo.
#
# git_cmd (alinery-core/src/git.rs) strips GIT_DIR and its six siblings. A behavioural test
# cannot catch the *next* call site someone adds, so this grep does.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TAURI="$ROOT/alinery-app/src-tauri"

# The helper itself is the one legitimate raw spawn.
hits=$(grep -rn 'Command::new("git")' \
  --include='*.rs' \
  "$TAURI/src" "$TAURI/alinery-core" "$TAURI/mcp" \
  | grep -v '^.*/alinery-core/src/git.rs:' || true)

if [ -n "$hits" ]; then
  echo "ERROR: raw git spawn — use alinery_core::git_cmd(dir) so GIT_DIR cannot redirect it:" >&2
  echo "$hits" >&2
  exit 1
fi

ts_hits=$(grep -rn -E 'spawn(Sync)?\([[:space:]]*"git"|spawn(Sync)?\([[:space:]]*'\''git'\''' \
  --include='*.ts' \
  "$TAURI/vinculum-daemon" || true)

if [ -n "$ts_hits" ]; then
  echo "ERROR: Vinculum must call alinery-core provisioning, not spawn git itself:" >&2
  echo "$ts_hits" >&2
  exit 1
fi

echo "OK: all git spawns go through alinery_core::git_cmd"
