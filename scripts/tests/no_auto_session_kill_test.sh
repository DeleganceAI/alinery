#!/usr/bin/env bash
# check-no-auto-session-kill.sh must pass on the real tree and fail, naming the function, when a
# sixth function names a ShutdownOrigin or sends the old shutdown op. Each case runs the gate on a
# scratch copy of the three Rust source dirs (and the daemon's TypeScript) it scans, with one planted function.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/no-auto-kill-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail=0

fresh_tree() {
  rm -rf "$TMP/tree"
  mkdir -p "$TMP/tree/scripts/tests" "$TMP/tree/alinery-app/src-tauri/mcp" "$TMP/tree/alinery-app/src-tauri/alinery-core"
  cp "$ROOT/scripts/tests/check-no-auto-session-kill.sh" "$TMP/tree/scripts/tests/"
  cp -R "$ROOT/alinery-app/src-tauri/src" "$TMP/tree/alinery-app/src-tauri/src"
  cp -R "$ROOT/alinery-app/src-tauri/mcp/src" "$TMP/tree/alinery-app/src-tauri/mcp/src"
  cp -R "$ROOT/alinery-app/src-tauri/alinery-core/src" "$TMP/tree/alinery-app/src-tauri/alinery-core/src"
  mkdir -p "$TMP/tree/alinery-app/src-tauri/vinculum-daemon"
  cp -R "$ROOT/alinery-app/src-tauri/vinculum-daemon/src" "$TMP/tree/alinery-app/src-tauri/vinculum-daemon/src"
}
gate() { (cd "$TMP/tree" && ./scripts/tests/check-no-auto-session-kill.sh 2>&1); }

fresh_tree
if gate >"$TMP/out" 2>&1; then echo "ok   - the real tree passes"; else cat "$TMP/out" >&2; echo "FAIL - the real tree does not pass" >&2; fail=1; fi

expect_fail() { # <what> <planted line> <name that must be reported>
  fresh_tree
  printf '\npub(crate) fn sneaky_teardown() {\n    %s\n}\n' "$2" >>"$TMP/tree/alinery-app/src-tauri/src/session.rs"
  if gate >"$TMP/out" 2>&1; then
    echo "FAIL - $1: the gate passed" >&2
    fail=1
  elif grep -q "sneaky_teardown" "$TMP/out"; then
    echo "ok   - $1: the gate fails naming sneaky_teardown"
  else
    cat "$TMP/out" >&2
    echo "FAIL - $1: the gate failed without naming sneaky_teardown" >&2
    fail=1
  fi
}
expect_fail "a sixth function names a ShutdownOrigin" 'let _ = ShutdownOrigin::StopDaemon;'
expect_fail "a sixth function sends the old op" 'let _ = daemon_client::shutdown_request();'

fresh_tree
sed -i.bak 's/ShutdownOrigin::StopRemote/ShutdownOrigin::StopDaemon_REMOVED/;s/ShutdownOrigin::ConfirmedTakeover/ShutdownOrigin_REMOVED/' "$TMP/tree/alinery-app/src-tauri/src/remote.rs" "$TMP/tree/alinery-app/src-tauri/src/daemon.rs"
if gate >"$TMP/out" 2>&1; then echo "FAIL - an origin function without a ShutdownOrigin passed" >&2; fail=1; else echo "ok   - an origin function that names no ShutdownOrigin fails"; fi

# The daemon side: a signal to a child leaves platform/process.ts only through an allowlisted signalChild.
DAEMON="alinery-app/src-tauri/vinculum-daemon/src"
expect_daemon_fail() { # <what> <file under src, created> <content> <text the gate must report>
  fresh_tree
  mkdir -p "$(dirname "$TMP/tree/$DAEMON/$2")"
  printf '%s\n' "$3" >"$TMP/tree/$DAEMON/$2"
  if gate >"$TMP/out" 2>&1; then
    echo "FAIL - $1: the gate passed" >&2
    fail=1
  elif grep -q "$4" "$TMP/out"; then
    echo "ok   - $1: the gate fails"
  else
    cat "$TMP/out" >&2
    echo "FAIL - $1: the gate failed without reporting '$4'" >&2
    fail=1
  fi
}
expect_daemon_fail "a planted proc.kill() in runtime/" runtime/planted.ts 'export const stop = (proc: { kill(): void }) => proc.kill();' 'runtime/planted.ts'
expect_daemon_fail "a planted process.kill(pid)" jobs.ts 'export const stop = (pid: number) => process.kill(pid, "SIGKILL");' 'jobs.ts'
expect_daemon_fail "a signalChild caller outside the allowlist" runtime/planted.ts 'signalChild(child, "SIGKILL", "session-kill");' 'runtime/planted.ts'
expect_daemon_fail "a signalChild call with no reason" terminal.ts 'signalChild(child, "SIGKILL");' 'terminal.ts'

exit "$fail"
