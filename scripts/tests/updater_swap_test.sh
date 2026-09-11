#!/usr/bin/env bash
# Behavioural test for the self-update swap helper (alinery-app/src-tauri/assets/swap.sh).
#
# WHY THIS EXISTS as its own script, in the style of install_prompt_test.sh:
#
#   The Rust unit tests in src-tauri/src/tests/update.rs cover manifest parsing, semver
#   compare and bundle detection — none of them touch the irreversible move-aside/ditto/
#   restore sequence, because that sequence lives in shell (`assets/swap.sh`), not Rust
#   (`check-no-auto-session-kill.sh` cannot see it either — that guard scans `src/*.rs`
#   only). This is the one place that sequence is proven.
#
# The properties that matter, in order:
#
#   1. A DECLINED preflight_gate CHANGES NOTHING: the dest bundle is untouched, and
#      neither ditto nor open nor a removal of dest is ever attempted.
#   2. A FAILED ditto AFTER the move-aside RESTORES the old bundle: the user is never left
#      with no app. The stub creates a partial dest on failure — that is how real ditto
#      fails — so restore must remove it before `mv`, or the old bundle nests inside it.
#   3. SUCCESS leaves the new bundle in place, the aside copy gone, the new bundle opened,
#      and — because a real preflight_gate stops the app before ditto ever runs — the gate
#      is proven to run before the move.
#   4. A missing dest (fresh-install shape) never tries to move anything aside.
#   5. A FAILED open AFTER a successful ditto RESTORES the old bundle and does not
#      `rm -rf` the aside copy first.
#
# swap.sh is sourced with SWAP_LIB=1 (its own documented guard against running main on
# source) and its four external effects — preflight_gate, ditto, open, mv — are redefined
# as recording stubs, exactly like install_prompt_test.sh redefines probe_*. `mv` still
# does the real move so the restore-on-failure property is proven against real files, not
# just recorded intent.
#
# Run: ./scripts/tests/updater_swap_test.sh   (wired into scripts/check.sh)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SWAP="$ROOT/alinery-app/src-tauri/assets/swap.sh"

[ -f "$SWAP" ] || { echo "ERROR: cannot find $SWAP" >&2; exit 1; }

fails=0
check() {
  local what="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    echo "ok   - $what"
  else
    echo "FAIL - $what"
    echo "         want: [$want]"
    echo "         got:  [$got]"
    fails=$((fails + 1))
  fi
}
contains() {
  local what="$1" needle="$2" hay="$3"
  case "$hay" in
    *"$needle"*) echo "ok   - $what" ;;
    *)
      echo "FAIL - $what"
      echo "         expected to contain: [$needle]"
      echo "         got: [$hay]"
      fails=$((fails + 1))
      ;;
  esac
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/alinery-swap-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
CALLS="$TMP/calls"

# ── stubs ────────────────────────────────────────────────────────────────────────
# swap_apply reaches the outside world only through these four names — overriding them
# exercises the real function (ordering, move-aside, restore-on-failure, and all) over a
# fake quiet-machine gate and a fake extraction, with real files underneath so property 2
# (restore) is proven against an actual directory tree, not just a log line.
PREFLIGHT_RC=0
DITTO_RC=0
OPEN_FAILS=0

preflight_gate() {
  echo "preflight_gate $1" >>"$CALLS"
  return "$PREFLIGHT_RC"
}
ditto() {
  echo "ditto $1 $2" >>"$CALLS"
  if [ "$DITTO_RC" -ne 0 ]; then
    # Real /usr/bin/ditto creates DEST before a mid-copy failure. A stub that
    # returns non-zero *without* creating dest makes `mv old dest` accidentally work.
    mkdir -p "$2"
    echo partial-new >"$2/marker"
    return "$DITTO_RC"
  fi
  rm -rf "$2"
  cp -R "$1" "$2"
}
open() {
  echo "open $1" >>"$CALLS"
  if [ "$OPEN_FAILS" -gt 0 ]; then
    OPEN_FAILS=$((OPEN_FAILS - 1))
    return 1
  fi
  return 0
}
mv() {
  echo "mv $1 $2" >>"$CALLS"
  command mv "$1" "$2"
}

SWAP_LIB=1
# shellcheck source=/dev/null
. "$SWAP"
unset SWAP_LIB

reset_calls() { : >"$CALLS"; }
call_count() {
  # `grep -c` prints "0" (not nothing) on zero matches, so a plain command substitution
  # is enough — no `|| echo 0` double-count trap (see install_prompt_test.sh's kills_in).
  grep -cE "$1" "$CALLS" 2>/dev/null
}

new_bundle_pair() {
  rm -rf "$TMP/dest" "$TMP/staged"
  mkdir -p "$TMP/dest"
  echo old-build >"$TMP/dest/marker"
  mkdir -p "$TMP/staged"
  echo new-build >"$TMP/staged/marker"
}

# ── 1. preflight_gate declines: dest untouched, nothing else attempted ───────────
new_bundle_pair
reset_calls
PREFLIGHT_RC=1
swap_apply "$TMP/dest" "$TMP/staged"
rc=$?
check "a declined gate fails swap_apply" 1 "$rc"
check "dest content is unchanged" old-build "$(cat "$TMP/dest/marker")"
check "no ditto was attempted" 0 "$(call_count '^ditto ')"
check "no open was attempted" 0 "$(call_count '^open ')"
check "no move-aside was attempted" 0 "$(call_count '^mv ')"
check "the gate is asked to force (no interactive prompt from a detached helper)" 1 \
  "$(call_count '^preflight_gate 1$')"
PREFLIGHT_RC=0

# ── 2. ditto fails after the move-aside: the old bundle is restored ──────────────
new_bundle_pair
reset_calls
DITTO_RC=1
swap_apply "$TMP/dest" "$TMP/staged"
rc=$?
check "a failed ditto fails swap_apply" 1 "$rc"
check "dest exists again after restore" 1 "$([ -d "$TMP/dest" ] && echo 1 || echo 0)"
check "dest content is the OLD bundle, restored" old-build "$(cat "$TMP/dest/marker")"
check "restore did not nest the old bundle inside dest" 0 \
  "$(find "$TMP/dest" -name 'dest.old-*' | wc -l | tr -d ' ')"
check "no .old-<pid> directory is left behind" 0 "$(find "$TMP" -maxdepth 1 -name 'dest.old-*' | wc -l | tr -d ' ')"
check "open was still called, to relaunch the restored bundle" 1 "$(call_count '^open ')"
DITTO_RC=0

# ── 3. success: staged content lands, aside copy is gone, new bundle is opened ───
new_bundle_pair
reset_calls
swap_apply "$TMP/dest" "$TMP/staged"
rc=$?
check "success returns 0" 0 "$rc"
check "dest now holds the staged content" new-build "$(cat "$TMP/dest/marker")"
check "no .old-<pid> directory survives a success" 0 "$(find "$TMP" -maxdepth 1 -name 'dest.old-*' | wc -l | tr -d ' ')"
check "the new bundle was opened" 1 "$(call_count '^open ')"
check "exactly one ditto call" 1 "$(call_count '^ditto ')"

# Ordering: preflight_gate must run before the move-aside, which must run before ditto.
# grep -n gives "line:match"; the line numbers must be strictly increasing.
gate_line="$(grep -n '^preflight_gate 1$' "$CALLS" | head -n1 | cut -d: -f1)"
mv_line="$(grep -n '^mv ' "$CALLS" | head -n1 | cut -d: -f1)"
ditto_line="$(grep -n '^ditto ' "$CALLS" | head -n1 | cut -d: -f1)"
check "preflight_gate ran before the move-aside" 1 "$([ "${gate_line:-0}" -lt "${mv_line:-0}" ] && echo 1 || echo 0)"
check "the move-aside ran before ditto" 1 "$([ "${mv_line:-0}" -lt "${ditto_line:-0}" ] && echo 1 || echo 0)"

# ── 4. a missing dest (fresh install shape) never tries to move anything aside ───
rm -rf "$TMP/dest" "$TMP/staged"
mkdir -p "$TMP/staged"
echo new-build >"$TMP/staged/marker"
reset_calls
swap_apply "$TMP/dest" "$TMP/staged"
rc=$?
check "a fresh install (no prior dest) still succeeds" 0 "$rc"
check "dest holds the staged content" new-build "$(cat "$TMP/dest/marker")"
check "no move-aside for a dest that never existed" 0 "$(call_count '^mv ')"


# ── 5. open fails after a successful ditto: restore the old bundle ──────────────
new_bundle_pair
reset_calls
OPEN_FAILS=1
swap_apply "$TMP/dest" "$TMP/staged"
rc=$?
check "a failed open fails swap_apply" 1 "$rc"
check "dest exists after open-fail restore" 1 "$([ -d "$TMP/dest" ] && echo 1 || echo 0)"
check "dest content is the OLD bundle after open failed" old-build "$(cat "$TMP/dest/marker")"
check "open-fail restore did not nest the old bundle" 0 \
  "$(find "$TMP/dest" -name 'dest.old-*' | wc -l | tr -d ' ')"
check "no .old-<pid> directory survives an open failure" 0 "$(find "$TMP" -maxdepth 1 -name 'dest.old-*' | wc -l | tr -d ' ')"
check "open was attempted for the new bundle and again for the restore" 2 "$(call_count '^open ')"
OPEN_FAILS=0
if [ "$fails" -ne 0 ]; then
  echo "FAILED: $fails check(s)" >&2
  exit 1
fi
echo "OK: updater swap helper"
