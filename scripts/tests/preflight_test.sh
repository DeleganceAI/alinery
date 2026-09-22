#!/usr/bin/env bash
# Unit tests for the installer preflight helpers — the pure ones.
#
# The installer's irreversible step is `rm -rf "$DEST"`. Everything deciding whether we
# reach that line has to be provable without downloading a release, so it lives in
# sourceable functions in scripts/lib/preflight.sh. This file covers the pure string
# work; scripts/tests/install_prompt_test.sh drives the gate and its prompt end to end,
# and scripts/tests/preflight_live_test.sh runs the same helpers against a real daemon.
#
# Plain bash, no dependencies (matching scripts/homebrew/check-version-sync.sh).
# Run: ./scripts/tests/preflight_test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$ROOT/scripts/lib/preflight.sh"

if [ ! -f "$LIB" ]; then
  echo "ERROR: cannot find $LIB" >&2
  exit 1
fi
# shellcheck source=../lib/preflight.sh
. "$LIB"

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

# --- live_sessions_from_list_reply: live == running + idle --------------------
# This count is the loss-of-work number in the prompt. Too high and we frighten people
# out of installing; too low and they say yes to losing more than they were told.
check "counts running and idle, ignores exited" \
  "2" "$(live_sessions_from_list_reply '{"sessions":[{"id":"a","status":"running"},{"id":"b","status":"idle"},{"id":"c","status":"exited"}]}')"
check "exited-only registry counts zero" \
  "0" "$(live_sessions_from_list_reply '{"sessions":[{"id":"a","status":"exited"},{"id":"b","status":"exited"}]}')"
check "empty registry counts zero" \
  "0" "$(live_sessions_from_list_reply '{"sessions":[]}')"
check "unreachable daemon counts zero" \
  "0" "$(live_sessions_from_list_reply '')"
check "tolerates whitespace in the reply" \
  "1" "$(live_sessions_from_list_reply '{"sessions":[{"status" : "running"}]}')"
check "a session id that merely says running is not a status" \
  "0" "$(live_sessions_from_list_reply '{"sessions":[{"id":"running","status":"exited"}]}')"

# --- repo_daemon_socket: one socket per repo, no lane suffix ------------------
check "socket path is the repo's .alinery/alineryd.sock" \
  "/x/y/.alinery/alineryd.sock" "$(repo_daemon_socket /x/y)"
check "a trailing slash does not double up" \
  "/x/y/.alinery/alineryd.sock" "$(repo_daemon_socket /x/y/)"
check "candidate sockets are the product alineryd path" \
  "/x/y/.alinery/alineryd.sock" "$(repo_daemon_sockets /x/y)"

# first_live_daemon_socket: public preflight only probes alineryd.sock.
probe_version() {
  case "$1" in
    */.alinery/alineryd.sock) printf '{"ok":true}' ;;
    *) printf '' ;;
  esac
}
check "first live socket is alineryd when that is what answers" \
  "/tmp/r/.alinery/alineryd.sock" "$(first_live_daemon_socket /tmp/r)"
. "$LIB"
check "first live socket is empty when nothing answers" \
  "" "$(
    probe_version() { printf ''; }
    first_live_daemon_socket /tmp/r
  )"

# --- known_repos_from_app_config ----------------------------------------------
tmp="$(mktemp -d "${TMPDIR:-/tmp}/saga-preflight-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

printf 'active_repo = "/a"\nknown_repos = ["/a", "/b/c"]\n' >"$tmp/app.toml"
check "reads a single-line known_repos array" \
  "/a
/b/c" "$(known_repos_from_app_config "$tmp/app.toml")"

printf 'known_repos = [\n  "/a",\n  "/b",\n]\n' >"$tmp/wrapped.toml"
check "reads a wrapped known_repos array" \
  "/a
/b" "$(known_repos_from_app_config "$tmp/wrapped.toml")"

check "an absent config yields no repos" \
  "" "$(known_repos_from_app_config "$tmp/nope.toml")"

union_home="$tmp/home-union"
mkdir -p "$union_home/Library/Application Support/ai.delegance.alinery" \
         "$union_home/Library/Application Support/ai.delegance.saga"
printf 'known_repos = ["/from-alinery"]\n' \
  >"$union_home/Library/Application Support/ai.delegance.alinery/app.toml"
printf 'known_repos = ["/from-saga", "/from-alinery"]\n' \
  >"$union_home/Library/Application Support/ai.delegance.saga/app.toml"
check "reads alinery app.toml and ignores leftover saga config" \
  "/from-alinery" "$(HOME="$union_home" known_repos_from_app_config)"
check "saga app-support dir is still in place after the read" "1" \
  "$([ -f "$union_home/Library/Application Support/ai.delegance.saga/app.toml" ] && echo 1 || echo 0)"

saga_only="$tmp/home-saga-only"
mkdir -p "$saga_only/Library/Application Support/ai.delegance.saga"
printf 'known_repos = ["/live-saga-repo"]\n' \
  >"$saga_only/Library/Application Support/ai.delegance.saga/app.toml"
check "saga-only app.toml is not treated as current config" \
  "" "$(HOME="$saga_only" known_repos_from_app_config)"
check "saga-only home was not renamed to alinery" "1" \
  "$([ -d "$saga_only/Library/Application Support/ai.delegance.saga" ] && echo 1 || echo 0)"
check "saga-only home did not grow an alinery app-support dir" "0" \
  "$([ -d "$saga_only/Library/Application Support/ai.delegance.alinery" ] && echo 1 || echo 0)"

# --- parse_alineryd_repo_from_ps_line / discovery parser -------------------------
check "parses --repo /path form" \
  "/tmp/orphan-repo" "$(parse_alineryd_repo_from_ps_line '4242 /Applications/Alinery.app/Contents/MacOS/alineryd --repo /tmp/orphan-repo')"
check "parses leftover sagad --repo /path form" \
  "/tmp/orphan-repo" "$(parse_alineryd_repo_from_ps_line '4242 /Applications/Saga.app/Contents/MacOS/sagad --repo /tmp/orphan-repo')"
check "parses --repo=/path form" \
  "/Users/me/code" "$(parse_alineryd_repo_from_ps_line '99 alineryd --repo=/Users/me/code --other')"
check "ignores a line with no --repo" \
  "" "$(parse_alineryd_repo_from_ps_line '4242 /usr/bin/something-else --foo bar')"
# Ubuntu `pgrep -l` (no --list-full) looks like this. Treating it as a hit is how
# preflight_live_test went green on a Mac and red on the Actions Ubuntu job.
check "procps pgrep -l name-only line has no repo path" \
  "" "$(parse_alineryd_repo_from_ps_line '12345 alineryd')"
check "daemon listing uses pgrep -fa when procps supports --list-full" "1" \
  "$(grep -c 'pgrep -fa' "$ROOT/scripts/lib/preflight.sh" | tr -d '[:space:]')"
# A repo under "~/My Projects" is ordinary on macOS. Cutting the value at the first space
# truncated the path, the socket probe missed, and a live daemon read as "machine quiet".
check "keeps spaces in the repo path (value ends at the next --option)" \
  "/Users/me/My Projects/saga" \
  "$(parse_alineryd_repo_from_ps_line '77 alineryd --repo /Users/me/My Projects/saga --app-config /Users/me/Library/app.toml --build-id abc')"
check "keeps spaces in the --repo= form too" \
  "/Users/me/My Projects/saga" \
  "$(parse_alineryd_repo_from_ps_line '77 alineryd --repo=/Users/me/My Projects/saga --app-config /x')"
check "handles --repo as the final argument" \
  "/tmp/last-arg" "$(parse_alineryd_repo_from_ps_line '5 alineryd --repo /tmp/last-arg')"
check "does not match a longer option that starts with --repo" \
  "" "$(parse_alineryd_repo_from_ps_line '5 alineryd --reposition /tmp/x')"
check "normalizes a trailing slash so it dedupes against known_repos" \
  "/tmp/repo-a" "$(parse_alineryd_repo_from_ps_line '5 alineryd --repo /tmp/repo-a/ --app-config /x')"

# --- normalize_repo_path -------------------------------------------------------
check "collapses repeated trailing slashes" "/tmp/x" "$(normalize_repo_path '/tmp/x///')"
check "leaves an already-normal path alone" "/tmp/x" "$(normalize_repo_path '/tmp/x')"
check "never eats the root slash" "/" "$(normalize_repo_path '/')"

# --- probe_op: connect, never stat ---------------------------------------------
# `.alinery/` accumulates dead lane sockets; a file-exists check would report phantom
# daemons and prompt the user about work that is not there.
: >"$tmp/stale.sock"
out="$(probe_version "$tmp/stale.sock")"; rc=$?
check "stale socket file answers nothing" "" "$out"
check "stale socket probe does not fail the installer" "0" "$rc"
out="$(probe_version "$tmp/missing.sock")"; rc=$?
check "absent socket answers nothing" "" "$out"
check "absent socket probe does not fail the installer" "0" "$rc"
out="$(probe_shutdown "$tmp/missing.sock")"; rc=$?
check "shutting down a socket nobody holds is not an error" "0" "$rc"
check "…and reports nothing" "" "$out"

# --- stop_alinery_app: signalling is not proof ------------------------------------
# Re-review finding 6. This used to SIGKILL, `sleep 0.5` and `return 0` regardless — so a
# process that outlived the kill (uninterruptible I/O, or a pid we may not signal) was
# reported as stopped, and the caller went on to end live sessions in front of a still-
# running poller that would respawn the daemons anyway.
#
# No real process is signalled: `pkill` is shadowed and liveness is answered by a stub.
# ALINERY_STOP_POLLS drops the two ~5s phases to ~0.4s.
ALINERY_STOP_POLLS=1
pkill() { echo "pkill $*" >>"$tmp/signals"; return 0; }

: >"$tmp/signals"
alinery_app_is_running() { return 0; } # 0 = still running, forever
stop_alinery_app; rc=$?
check "a process that survives SIGKILL makes stop_alinery_app FAIL" "1" "$rc"
check "…and it escalated TERM then KILL before giving up" "2" \
  "$(grep -c . "$tmp/signals" | tr -d '[:space:]')"
check "…sending TERM first" "1" \
  "$(grep -c 'pkill -TERM' "$tmp/signals" | tr -d '[:space:]')"
check "…then KILL" "1" \
  "$(grep -c 'pkill -KILL' "$tmp/signals" | tr -d '[:space:]')"

: >"$tmp/signals"
alinery_app_is_running() { return 1; } # 1 = gone
stop_alinery_app; rc=$?
check "an app that quits on TERM succeeds" "0" "$rc"
check "…without ever escalating to KILL" "" \
  "$(grep 'pkill -KILL' "$tmp/signals" 2>/dev/null || true)"

# Gone only after the KILL: the second poll phase is what notices, and it must report
# success rather than the timeout.
: >"$tmp/signals"
STILL_UP=2 # alive for the one TERM-phase poll, gone by the first KILL-phase poll
alinery_app_is_running() {
  STILL_UP=$((STILL_UP - 1))
  [ "$STILL_UP" -gt 0 ]
}
stop_alinery_app; rc=$?
check "an app that only dies on KILL still counts as stopped" "0" "$rc"
check "…having actually needed the KILL" "1" \
  "$(grep -c 'pkill -KILL' "$tmp/signals" | tr -d '[:space:]')"

unset -f pkill alinery_app_is_running

# --- ask_tty: no controlling terminal ⇒ safe default `n` ------------------------------
# ask_tty reads /dev/tty (not stdin) so `curl | bash` still prompts. When the open fails
# (CI, launchd, a session-detached runner) the answer must be `n`, never hang or default
# to yes. Detach via a new session: stdin redirect alone is not isolation.
if command -v python3 >/dev/null 2>&1; then
  got="$(
    python3 -c '
import subprocess, sys
script = r"""
. "'"$LIB"'"
printf %s "$(ask_tty "Continue? [y/N] ")"
"""
r = subprocess.run(
    ["bash", "-c", script],
    stdin=subprocess.DEVNULL,
    capture_output=True,
    text=True,
    start_new_session=True,
    timeout=5,
)
sys.stdout.write(r.stdout)
sys.exit(r.returncode)
'
  )"
  check "ask_tty with no controlling terminal answers n" "n" "$got"
else
  echo "SKIP - ask_tty no-tty isolation (python3 unavailable)"
fi

# --- dual-identity process / app patterns ------------------------------------
yesno() { if "$@"; then printf yes; else printf no; fi; }
check "product daemon line accepts alineryd" "yes" \
  "$(yesno is_product_daemon_ps_line '42 /Applications/Alinery.app/Contents/MacOS/alineryd --repo /x')"
check "product daemon line rejects leftover sagad" "no" \
  "$(yesno is_product_daemon_ps_line '42 /Applications/Saga.app/Contents/MacOS/sagad --repo /x')"
check "product daemon line rejects a lookalike helper" "no" \
  "$(yesno is_product_daemon_ps_line '42 /usr/bin/myalineryd-helper --repo /x')"
check "app pattern matches Alinery.app" "1" \
  "$(printf '%s' '/Applications/Alinery.app/Contents/MacOS/Alinery' | grep -cE "$ALINERY_APP_PATTERN" | tr -d '[:space:]')"
check "app pattern ignores leftover Saga.app" "0" \
  "$(printf '%s' '/Applications/Saga.app/Contents/MacOS/Saga' | grep -cE "$ALINERY_APP_PATTERN" | tr -d '[:space:]')"
check "app pattern ignores lowercase saga binary" "0" \
  "$(printf '%s' '/Users/me/Applications/Saga.app/Contents/MacOS/saga' | grep -cE "$ALINERY_APP_PATTERN" | tr -d '[:space:]')"
check "app pattern ignores unrelated apps" "0" \
  "$(printf '%s' '/Applications/Safari.app/Contents/MacOS/Safari' | grep -cE "$ALINERY_APP_PATTERN" | tr -d '[:space:]')"
check "app pattern matches a Linux install (no bundle, plain Alinery/Alinery)" "1" \
  "$(printf '%s' '/home/me/.local/share/alinery/Alinery/Alinery' | grep -cE "$ALINERY_APP_PATTERN" | tr -d '[:space:]')"
check "app pattern ignores the co-located alineryd sidecar on Linux" "0" \
  "$(printf '%s' '/home/me/.local/share/alinery/Alinery/alineryd-x86_64-unknown-linux-gnu' | grep -cE "$ALINERY_APP_PATTERN" | tr -d '[:space:]')"
check "app pattern ignores the co-located alinery-mcp sidecar on Linux" "0" \
  "$(printf '%s' '/home/me/.local/share/alinery/Alinery/alinery-mcp-x86_64-unknown-linux-gnu' | grep -cE "$ALINERY_APP_PATTERN" | tr -d '[:space:]')"
check "app pattern ignores the co-located alinery-runner sidecar on Linux" "0" \
  "$(printf '%s' '/home/me/.local/share/alinery/Alinery/alinery-runner-x86_64-unknown-linux-gnu' | grep -cE "$ALINERY_APP_PATTERN" | tr -d '[:space:]')"

if [ "$fails" -ne 0 ]; then
  echo "FAILED: $fails check(s)"
  exit 1
fi
echo "OK: preflight helpers"
