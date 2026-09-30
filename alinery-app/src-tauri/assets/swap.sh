#!/usr/bin/env bash
# Self-update swap helper — embedded into the app binary via include_str! and written
# out to a scratch dir (alongside a compile-time copy of scripts/lib/preflight.sh) by
# apply_update(), then spawned detached: `/bin/bash <scratch>/swap.sh DEST_BUNDLE STAGED_APP`.
# Must run under real bash, not /bin/sh: on macOS that is bash-3.2 in POSIX/`sh`
# compatibility mode, which rejects the process substitution and arrays preflight.sh
# (sourced below) uses, aborting this whole script under `set -e` before it does
# anything — apply_update() spawns it with an explicit bash interpreter for that reason.
#
# It runs from OUTSIDE the bundle it is about to replace — that is the whole point: a
# running app cannot delete the directory tree its own executable is loaded from. By the
# time this script exists on disk, apply_update() has already returned and Rust is done.
#
#   1. source preflight.sh (PREFLIGHT env var overrides the path, for tests)
#   2. preflight_gate 1 — the same tested quiet-machine gate the installer uses: stop the
#      app FIRST and verify it is gone, then shut down every daemon and wait for its
#      socket to fall silent. Non-zero => abort, change nothing.
#   3. move the old bundle aside (not rm -rf: a failed ditto still has something to restore)
#   4. ditto the staged bundle into place; on failure, remove the partial dest (real ditto
#      creates DEST before failing), move the old one back, and reopen it
#   5. open the new bundle (relaunch); on failure, restore the old bundle the same way
#   6. remove the old bundle, only after open succeeded
#   7. if the extracted archive has a sibling git/ tree and this machine's GUI PATH has
#      no working git, copy it to Alinery.git next to the app. A failure here is logged
#      and does not roll the app swap back. A machine that already has git is left alone
#      — including any previously installed Alinery.git (a background update must not
#      delete the fallback). install.sh is what removes it on an explicit reinstall.
set -u

# git.sh is written next to this script by apply_update (include_str of
# scripts/lib/git.sh). Tests point GIT_LIB at the repo copy. The probe and the
# copy live there so install.sh and this helper cannot drift.
_swap_git_lib=""
if [ -n "${GIT_LIB:-}" ] && [ -f "${GIT_LIB}" ]; then
  _swap_git_lib="$GIT_LIB"
else
  _swap_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
  if [ -n "$_swap_dir" ] && [ -f "$_swap_dir/git.sh" ]; then
    _swap_git_lib="$_swap_dir/git.sh"
  fi
fi
if [ -n "$_swap_git_lib" ]; then
  # shellcheck source=/dev/null
  . "$_swap_git_lib"
fi
unset _swap_git_lib _swap_dir

# After a successful app swap. Missing git.sh (no probe) does nothing rather than
# guessing — apply_update always writes the sibling, and the test harness sets GIT_LIB.
git_swap_fallback() {
  dest_app="$1"
  staged_app="$2"
  src="$(dirname "$staged_app")/git"
  [ -x "$src/bin/git" ] || return 0
  if type git_app_visible >/dev/null 2>&1 && git_app_visible; then
    return 0
  fi
  dest_dir="$(dirname "$dest_app")/Alinery.git"
  if ! type git_place_alongside >/dev/null 2>&1; then
    swap_log "git fallback skipped; git_place_alongside is not defined"
    return 0
  fi
  if ! git_place_alongside "$src" "$dest_dir"; then
    swap_log "git fallback place failed; app swap stands"
    return 0
  fi
  swap_log "installed git fallback at $dest_dir"
  return 0
}

# `SWAP_LOG` is unset until the main dispatch below sets it, so `swap_apply` (which
# `scripts/tests/updater_swap_test.sh` calls directly, after sourcing this file with
# `SWAP_LIB=1`) never writes a stray log file into whatever directory a test happens to
# run from. Real invocations always go through the dispatch and get a real log.
swap_log() {
  [ -n "${SWAP_LOG:-}" ] || return 0
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >>"$SWAP_LOG"
}

# swap_apply DEST STAGED — the whole helper, minus sourcing/dispatch, as a function so
# scripts/tests/updater_swap_test.sh can source this file (SWAP_LIB=1 skips main below)
# and stub preflight_gate/ditto/open/mv around a call to swap_apply directly. Every step
# checks its own exit status explicitly rather than relying on `set -e` — that option is
# scoped to the real dispatch path only (see below), so this function behaves identically
# whether or not the caller's shell has errexit on.
swap_apply() {
  dest="$1"
  staged="$2"

  swap_log "starting: dest=$dest staged=$staged"

  if ! preflight_gate 1; then
    swap_log "preflight_gate declined; nothing changed"
    return 1
  fi

  old=""
  if [ -e "$dest" ]; then
    old="$dest.old-$$"
    swap_log "moving aside: $dest -> $old"
    if ! mv "$dest" "$old"; then
      swap_log "move-aside failed; leaving $dest in place"
      return 1
    fi
  fi

  if ! ditto "$staged" "$dest"; then
    swap_log "ditto failed; restoring $old -> $dest"
    if [ -n "$old" ]; then
      restore_bundle "$old" "$dest" || return 1
      open "$dest" || true
    fi
    return 1
  fi

  swap_log "opening $dest"
  if ! open "$dest"; then
    swap_log "open failed; restoring $old -> $dest"
    if [ -n "$old" ]; then
      restore_bundle "$old" "$dest" || return 1
      open "$dest" || true
    fi
    return 1
  fi

  if [ -n "$old" ]; then
    swap_log "removing old bundle: $old"
    rm -rf "$old"
  fi

  git_swap_fallback "$dest" "$staged" || swap_log "git fallback place failed; app swap stands"

  swap_log "done"
  return 0
}

# restore_bundle OLD DEST — DEST may already exist as a partial/new tree (real
# /usr/bin/ditto creates DEST before a mid-copy failure). `mv OLD DEST` then nests
# OLD inside DEST instead of replacing it. Remove DEST first so the move actually
# restores the previous bundle.
restore_bundle() {
  old="$1"
  dest="$2"
  if [ -e "$dest" ]; then
    swap_log "removing incomplete dest before restore: $dest"
    rm -rf "$dest"
  fi
  if ! mv "$old" "$dest"; then
    swap_log "restore mv failed: $old -> $dest"
    return 1
  fi
  return 0
}

# Sourced by the test harness (or anything else) rather than executed => skip main.
# `SWAP_LIB=1` is the explicit guard.
if [ -n "${SWAP_LIB:-}" ]; then
  return 0 2>/dev/null || exit 0
fi

# ── dispatch: only reached when this file is actually run, never when sourced ────────
# `set -e` lives here, not at file scope, so sourcing this file for tests never changes
# the caller's shell options. A failed command anywhere in this block — `preflight.sh`
# missing, a bad argc — must stop the script; nothing here builds a pipeline whose exit
# status pipefail would otherwise be needed for.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
SWAP_LOG="$DIR/swap.log"

PREFLIGHT="${PREFLIGHT:-$DIR/preflight.sh}"
# shellcheck source=/dev/null
. "$PREFLIGHT"

if [ "$#" -ne 2 ]; then
  swap_log "usage: swap.sh DEST_BUNDLE STAGED_APP (got $# args)"
  exit 1
fi

swap_apply "$1" "$2"
