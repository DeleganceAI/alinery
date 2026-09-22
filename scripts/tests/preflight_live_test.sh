#!/usr/bin/env bash
# Live integration test for the installer preflight.
#
# WHY THIS EXISTS AS A COMMITTED SCRIPT, not a scratch one-off:
#
#   preflight_test.sh proves the helpers against hand-written reply strings and
#   install_prompt_test.sh proves the gate against stubbed helpers. Neither can catch the
#   failure that actually costs sessions: the installer's bash scrape drifting from what
#   a real `alineryd` puts on the wire. A renamed field, a reordered key, a status value
#   that becomes an enum — every one of those passes both suites and then either
#   under-reports the live session count in the prompt (the user says yes to losing more
#   than they were told) or fails to stop a daemon the installer promised to stop.
#
#   So this script talks to a REAL daemon over a REAL unix socket and pins the three
#   things the installer does to it:
#     1. `version` answers ⇒ this repo has a daemon. (Liveness, not content.)
#     2. `list` scrapes to the live session count the prompt shows.
#     3. `shutdown` actually ends the process — the installer's only destructive act,
#        and the one it makes a promise about after the user says yes.
#
#   Plus the rule the whole probe strategy rests on: dead lane socket FILES on disk are
#   not daemons (connect, never stat), or the installer prompts about work that is not
#   there and trains people to answer yes reflexively.
#
# Nothing here touches anything it did not spawn. Run: ./scripts/tests/preflight_live_test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
. "$ROOT/scripts/lib/preflight.sh"

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

# Liveness of a process we spawned. NOT `kill -0`: an exited-but-unreaped child is a
# zombie, and `kill -0` reports zombies as alive — which silently turns "the daemon is
# gone" into a check that can never fail.
proc_state() {
  local st
  st="$(ps -o stat= -p "${1-0}" 2>/dev/null | tr -d '[:space:]')"
  case "$st" in
    "" | Z*) printf 'gone' ;;
    *) printf 'alive' ;;
  esac
}

command -v nc >/dev/null 2>&1 || { echo "SKIP: nc(1) unavailable"; exit 0; }

ALINERYD="$ROOT/alinery-app/src-tauri/target/debug/alineryd"
if [ ! -x "$ALINERYD" ]; then
  echo "SKIP: $ALINERYD not built (cargo build -p alineryd)"
  exit 0
fi

TMPR="$(mktemp -d "${TMPDIR:-/tmp}/saga-preflight-live.XXXXXX")"
DAEMON_PID=""
cleanup() {
  # Only ever the daemon this script spawned, and only if it outlived the test.
  [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null && kill -9 "$DAEMON_PID" 2>/dev/null
  rm -rf "$TMPR"
  return 0
}
trap cleanup EXIT

git -C "$TMPR" init -q .
mkdir -p "$TMPR/.alinery"

# --- bring up a real daemon -----------------------------------------------------------
"$ALINERYD" --repo "$TMPR" --build-id live-test --app-config /nonexistent/app.toml \
  >"$TMPR/alineryd.log" 2>&1 &
DAEMON_PID=$!
SOCK="$(repo_daemon_socket "$TMPR")"
for _ in $(seq 1 40); do
  [ -S "$SOCK" ] && break
  sleep 0.1
done

REPLY="$(probe_version "$SOCK")"
[ -n "$REPLY" ] || { echo "SKIP: daemon never came up ($(cat "$TMPR/alineryd.log"))"; exit 0; }

# --- 1. liveness: a daemon that answers is a daemon -------------------------------------
check "a running daemon answers the liveness probe" "1" \
  "$(printf '%s' "$REPLY" | grep -c . | tr -d '[:space:]')"

# --- 2. the live session count the prompt shows -----------------------------------------
LIST="$(probe_list "$SOCK")"
check "the list reply is scrapeable" "0" "$(live_sessions_from_list_reply "$LIST")"
check "a fresh daemon reports no live sessions" "0" "$(live_sessions_from_list_reply "$LIST")"

# --- 3. connect, never stat -------------------------------------------------------------
: >"$TMPR/.alinery/alineryd-deadlane.sock"
check "a dead lane socket file is not a daemon" \
  "" "$(probe_version "$TMPR/.alinery/alineryd-deadlane.sock")"
check "an absent repo's socket is not a daemon" \
  "" "$(probe_version "$(repo_daemon_socket /does/not/exist)")"

# --- known_repos discovery, the installer's repo enumeration ----------------------------
printf 'active_repo = "%s"\nknown_repos = ["%s", "/does/not/exist"]\n' "$TMPR" "$TMPR" \
  >"$TMPR/app.toml"
check "known_repos is read out of app.toml" \
  "$TMPR
/does/not/exist" "$(known_repos_from_app_config "$TMPR/app.toml")"

# --- 4. the WHOLE GATE against real disk state ------------------------------------------
# install_prompt_test.sh drives the gate over stubbed probes, so it cannot tell a gate
# that connects from one that just `stat`s the socket path. Here the state is real: one
# repo with a live daemon, one whose `.alinery/alineryd.sock` is stale debris left by a crash.
#
# Decline path: ask_tty deliberately opens /dev/tty (not stdin) so `curl | bash` still
# prompts. Redirecting stdin with </dev/null therefore does NOT isolate a developer who
# runs check/release from a real Terminal — the prompt appears, they can type `y`, and
# this suite's daemon is torn down mid-test (the failure mode that shipped as "release
# fails on preflight_live"). Force the no-tty answer here; the real prompt is driven by
# install_prompt_test.sh under expect(1), and ask_tty's open-fails path is unit-tested
# in preflight_test.sh.
CFGDIR="$TMPR/home/Library/Application Support/ai.delegance.alinery"
mkdir -p "$CFGDIR" "$TMPR/stale-repo/.alinery"
: >"$TMPR/stale-repo/.alinery/alineryd.sock" # debris, not a socket anything listens on
printf 'known_repos = ["%s", "%s"]\n' "$TMPR" "$TMPR/stale-repo" >"$CFGDIR/app.toml"

# Stub process discovery: a developer's machine may have other product alineryd processes.
# This suite only owns $TMPR; never shut down a foreign daemon. Discovery itself is
# covered below with a canned line + the orphan-outside-known_repos case.
GATE_OUT="$(HOME="$TMPR/home" bash -c '
  . "'"$ROOT"'/scripts/lib/preflight.sh"
  alinery_app_is_running() { return 1; }   # deterministic: ignore any real Saga on this box
  discover_live_daemon_repos() { return 0; }
  ask_tty() { printf n; }               # isolate: never open the developer terminal
  preflight_gate 0 2>&1
  echo "RC=$?"
')"
check "the gate reports the live repo" "1" \
  "$(printf '%s' "$GATE_OUT" | grep -c "^  $TMPR — 0 live session(s)$" | tr -d '[:space:]')"
check "the gate counts one repo, not two (stale socket is debris)" "1" \
  "$(printf '%s' "$GATE_OUT" | grep -c '1 repo(s), 0 live session(s)' | tr -d '[:space:]')"
check "no terminal ⇒ the gate cancels" "1" \
  "$(printf '%s' "$GATE_OUT" | sed -n 's/^RC=//p')"
check "a cancelled gate left the real daemon running" \
  "alive" "$(proc_state "$DAEMON_PID")"
check "…and it still answers" "1" \
  "$(printf '%s' "$(probe_version "$SOCK")" | grep -c . | tr -d '[:space:]')"

# --- 4b. the REAL pgrep discovery finds this suite's running daemon ----------------------
# The stub above proves the gate consumes discovery; it cannot prove process listing
# actually matches a product `alineryd --repo …`. That is the whole of finding 6, so run
# the real function against the real daemon this suite started. Listing must be full
# argv: Linux `pgrep -l` is comm-only and would miss `--repo`.
check "real process discovery finds the running daemon by its command line" "1" \
  "$(discover_live_daemon_repos | grep -cx "$TMPR" | tr -d '[:space:]')"

# --- 4c. a discovered daemon absent from known_repos is still reported -------------------
# Real discovery, filtered to the daemon this suite owns: a developer box may have other
# product alineryds running and this test must never report — let alone stop — a foreign one.
# The filter is the machine-hygiene guard, not a fake: the path still comes from pgrep.
ORPHAN_OUT="$(HOME="$TMPR/home" bash -c '
  . "'"$ROOT"'/scripts/lib/preflight.sh"
  alinery_app_is_running() { return 1; }
  known_repos_from_app_config() { return 0; }   # empty app.toml list
  MINE="$(discover_live_daemon_repos | grep -Fx "'"$TMPR"'" || true)"
  discover_live_daemon_repos() { [ -n "$MINE" ] && printf "%s\n" "$MINE"; return 0; }
  ask_tty() { printf n; }               # isolate: never open the developer terminal
  preflight_gate 0 2>&1
  echo "RC=$?"
')"
check "orphan outside known_repos is still reported" "1" \
  "$(printf '%s' "$ORPHAN_OUT" | grep -c "^  $TMPR — 0 live session(s)$" | tr -d '[:space:]')"
check "orphan report still cancels with no tty" "1" \
  "$(printf '%s' "$ORPHAN_OUT" | sed -n 's/^RC=//p')"
check "orphan cancel left the daemon running" \
  "alive" "$(proc_state "$DAEMON_PID")"

# --- 5. read-only until told otherwise --------------------------------------------------
# Everything above is what the installer does BEFORE the user answers. None of it may
# have disturbed the daemon.
check "probing did not take the daemon down" \
  "alive" "$(proc_state "$DAEMON_PID")"

# --- 6. a yes really ends it, BEFORE the gate returns -----------------------------------
# The installer's next statement after preflight_gate is `rm -rf "$DEST"`, and alineryd lives
# inside $DEST. `shutdown` is acked when the daemon ACCEPTS it, not when it has finished
# killing its harness process groups and unwinding — so a gate that fires and returns
# races the delete against a process still running out of the bundle. This asserts the
# machine is quiet the instant the gate hands back, with no polling of its own.
GATE_RC=0
HOME="$TMPR/home" bash -c '
  . "'"$ROOT"'/scripts/lib/preflight.sh"
  alinery_app_is_running() { return 1; }
  discover_live_daemon_repos() { return 0; }  # never tear down foreign machine daemons
  preflight_gate 1 >/dev/null 2>&1
' </dev/null || GATE_RC=$?
check "the gate accepted the teardown" "0" "$GATE_RC"
# NOT `kill -0`: alineryd is a child of this script, and an exited-but-unreaped child is a
# zombie that `kill -0` reports as alive. Ask ps for the state instead — empty (reaped)
# or Z (zombie) both mean the process is over.
check "the daemon is ALREADY gone when the gate returns" \
  "gone" "$(proc_state "$DAEMON_PID")"
check "and its socket stops answering" "" "$(probe_version "$SOCK")"
wait "$DAEMON_PID" 2>/dev/null
DAEMON_PID=""

if [ "$fails" -ne 0 ]; then
  echo "FAILED: $fails check(s)"
  exit 1
fi
echo "OK: preflight against a live daemon"
