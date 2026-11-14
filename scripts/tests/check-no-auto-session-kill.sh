#!/usr/bin/env bash
# Invariant guard (ticket: daemon protocol gate + GH #132):
#
#   No Saga code path automatically kills a live session. Every kill originates in a
#   deliberate, explicitly-clicked user action carrying a loss-of-work warning.
#
# Fails if any function in the Tauri app names a `ShutdownOrigin` (`AdminService.Shutdown`, which
# SIGTERM/SIGKILLs every harness process group; plan invariant 1) unless that function is one of the
# deliberate teardown origins below, and each of them must name one. A daemon of protocol 38 or older
# is stopped over its JSON-lines socket (plan O23); that goes through `legacy_shutdown`, whose callers
# must be among the same origins. The wire is otherwise retired (S5.3), so nothing else builds a
# `shutdown` request.
#
# A behavioural test alone would pass against a re-introduced *conditional* kill, which
# is exactly how the original bug shipped — hence a source-level check.
#
# The same holds on the daemon side: see the S2.2 block below.
#
# Run: ./scripts/tests/check-no-auto-session-kill.sh   (wired into scripts/release.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/alinery-app/src-tauri/src"

# Every app-crate module, not just lib.rs — the teardown origins live in daemon.rs,
# backup.rs and app_config.rs since lib.rs was split into domain modules. Scanning one
# file would leave the rest unpoliced *and* trip the drift self-check below. Test code is in
# src/tests/, a subdirectory, so it is not scanned.
LIBS=("$SRC"/*.rs)
[ "${#LIBS[@]}" -gt 0 ] || { echo "ERROR: no app-crate sources found under $SRC" >&2; exit 1; }

# The ONLY deliberate session-kill origins. Add a name here only together with a
# user-facing confirmation that names the repo and states known or unknown session impact:
#   stop_daemon           Settings → Harness → "Quit & stop all sessions" (B1)
#   close_repo_daemon     close-repo confirmation (B4)
#   restore_backup        destructive restore, confirmed in the UI (the daemon holds the
#                         data being replaced, so it is not restarted afterwards)
#   confirm_repo_takeover_blocking  consumed one-shot selected-owner confirmation
#   stop_remote_daemon    the remote form of stop_daemon: the same Settings stop, and the
#                         conflict banner's "Restart daemon" for a daemon started by another
#                         Alinery version. Both confirm first and name the live sessions.
ALLOWED="stop_daemon close_repo_daemon restore_backup confirm_repo_takeover_blocking stop_remote_daemon"

# `close_repo_daemon` is a plain fn, so a NEW CALLER of it would end every live session in
# a repo without naming a `ShutdownOrigin` for the scan above to notice. Its callers are
# therefore allowlisted separately:
#   remove_repo      close-repo confirmation (B4)
#   close_all_repos  the quit dialog's express "close all repos" choice
#   close_all_repos_blocking  its body (split out so a live test can drive it); only
#                            close_all_repos calls it
CLOSE_CALLERS_ALLOWED="remove_repo close_all_repos close_all_repos_blocking"

status=0

# Where a `ShutdownOrigin` is named. Comment lines do not count.
origin_users="$(
  awk '
    FNR == 1 { current = "" }
    match($0, /^[[:space:]]*(pub(\([^)]*\))? )?(async )?fn [a-z_0-9]+/) {
      f = $0
      sub(/.*fn /, "", f)
      sub(/[^a-z_0-9].*/, "", f)
      current = f
    }
    /^[[:space:]]*\/\// { next }
    /ShutdownOrigin::/ { print current }
  ' "${LIBS[@]}" | sort -u | tr '\n' ' '
)"
origin_users="$(echo $origin_users)"

if [ -z "$origin_users" ]; then
  echo "ERROR: found no ShutdownOrigin users at all — the match pattern has drifted from the code." >&2
  exit 1
fi

for fn in $origin_users; do
  case " $ALLOWED " in
    *" $fn "*) ;;
    *)
      echo "ERROR: $fn names a ShutdownOrigin — that stops the daemon and ends every live session." >&2
      status=1
      ;;
  esac
done
for fn in $ALLOWED; do
  case " $origin_users " in
    *" $fn "*) echo "ok       $fn (names its ShutdownOrigin)" ;;
    *)
      echo "ERROR: $fn is a teardown origin but names no ShutdownOrigin." >&2
      status=1
      ;;
  esac
done

# The older-daemon stop (O23): `legacy_shutdown(` is built only by a teardown origin.
legacy_users="$(
  awk '
    FNR == 1 { current = "" }
    match($0, /^[[:space:]]*(pub(\([^)]*\))? )?(async )?fn [a-z_0-9]+/) {
      f = $0
      sub(/.*fn /, "", f)
      sub(/[^a-z_0-9].*/, "", f)
      current = f
    }
    /^[[:space:]]*\/\// { next }
    /legacy_shutdown\(/ && current != "legacy_shutdown" { print current }
  ' "${LIBS[@]}" | sort -u | tr '\n' ' '
)"
legacy_users="$(echo $legacy_users)"
for fn in $legacy_users; do
  case " $ALLOWED " in
    *" $fn "*) ;;
    *)
      echo "ERROR: $fn builds the older-daemon shutdown — that ends every live session." >&2
      status=1
      ;;
  esac
done

# Same shape, for callers of the close-repo teardown helper.
close_callers="$(
  awk '
    FNR == 1 { current = "" }
    match($0, /^[[:space:]]*(pub(\([^)]*\))? )?(async )?fn [a-z_0-9]+/) {
      f = $0
      sub(/.*fn /, "", f)
      sub(/[^a-z_0-9].*/, "", f)
      current = f
    }
    /close_repo_daemon\(/ && current != "close_repo_daemon" { print current }
  ' "${LIBS[@]}" | sort -u | tr '\n' ' '
)"
close_callers="$(echo $close_callers)"

if [ -z "$close_callers" ]; then
  echo "ERROR: found no close_repo_daemon callers — the match pattern has drifted." >&2
  exit 1
fi

for fn in $close_callers; do
  case " $CLOSE_CALLERS_ALLOWED " in
    *" $fn "*) echo "ok       $fn (deliberate close-repo)" ;;
    *)
      echo "ERROR: $fn calls close_repo_daemon — that ends every live session in the repo." >&2
      status=1
      ;;
  esac
done

# Moving the destructive transport into core must not let another app/MCP entry
# point borrow the confirmation worker or call bound shutdown directly.
node --input-type=module - "$ROOT" <<'JS'
import fs from "node:fs";
import path from "node:path";
const root = process.argv[2];
for (const dir of ["src", "alinery-core/src"]) {
  const base = path.join(root, "alinery-app/src-tauri", dir);
  for (const name of fs.readdirSync(base).filter(name => name.endsWith(".rs"))) {
    const source = fs.readFileSync(path.join(base, name), "utf8").split("#[cfg(test)]\nmod tests")[0];
    let current = "";
    for (const line of source.split("\n")) {
      const declaration = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/);
      if (declaration) current = declaration[1];
      if (/\bconfirm_repo_takeover_blocking\s*\(/.test(line) && !declaration && current !== "confirm_repo_takeover") {
        throw new Error(`${dir}/${name}: ${current} bypasses confirmed takeover entry`);
      }
      if (/\.shutdown\s*\(\s*\)/.test(line) && !(dir === "src" && current === "legacy_shutdown")) {
        throw new Error(`${dir}/${name}: ${current} sends the older-daemon shutdown outside legacy_shutdown`);
      }
      if (/\bshutdown_request\s*\(/.test(line) && !declaration && !(dir === "alinery-core/src" && name === "legacy_daemon.rs" && current === "shutdown")) {
        throw new Error(`${dir}/${name}: ${current} builds a JSON shutdown request outside the legacy transport`);
      }
    }
  }
}
JS

# The daemon side (plan S2.2). A child process is signalled from one file, platform/process.ts, so
# `.kill(` and `process.kill(` may appear nowhere else under vinculum-daemon/src (tests excepted), and
# every `signalChild(child, signal, "reason")` call names its reason and sits in a file the pair
# below allows. Add a pair only together with the user action that justifies it:
#   terminal.ts:session-kill   the user's kill of a Terminal session
#   mcp.ts:mcp-restart         closing an MCP child (restart, or the owning session ending)
#   jobs/runner.ts:job-cancel  a user's cancel of a running job, or Shutdown ending it (SIGTERM, then SIGKILL after a
#                      grace, to its child, never a session)
#   platform/keepawake.ts:keepawake-release  ending the idle-sleep hold (caffeinate or systemd-inhibit), never a session
#   platform/office.ts:convert-timeout  a LibreOffice conversion past its time limit (the preview asked for), never a session
DAEMON_SRC="$ROOT/alinery-app/src-tauri/vinculum-daemon/src"
SIGNAL_ALLOWED="terminal.ts:session-kill mcp.ts:mcp-restart jobs/runner.ts:job-cancel platform/keepawake.ts:keepawake-release platform/office.ts:convert-timeout"
if [ ! -f "$DAEMON_SRC/platform/process.ts" ]; then
  echo "ERROR: $DAEMON_SRC/platform/process.ts is missing — the daemon scan has drifted from the code." >&2
  exit 1
fi
daemon_files="$(find "$DAEMON_SRC" -name '*.ts' ! -name '*.test.ts' ! -name '*.testutil.ts' ! -path "$DAEMON_SRC/platform/process.ts")"
raw_kills="$(echo "$daemon_files" | xargs grep -nE '\.kill\(' | grep -vE ':[0-9]+:[[:space:]]*(//|\*)' || true)"
if [ -n "$raw_kills" ]; then
  echo "ERROR: send signals to children through signalChild in platform/process.ts, never .kill( directly:" >&2
  echo "$raw_kills" >&2
  status=1
fi
signal_calls="$(echo "$daemon_files" | xargs grep -nE 'signalChild\(' | grep -vE ':[0-9]+:[[:space:]]*(//|\*|import )' || true)"
if [ -z "$signal_calls" ]; then
  echo "ERROR: found no signalChild callers at all — the match pattern has drifted from the code." >&2
  exit 1
fi
while IFS= read -r call; do
  file="${call%%:*}"
  rel="${file#"$DAEMON_SRC"/}"
  reason="$(echo "$call" | sed -nE 's/.*signalChild\([^)]*"([a-z-]+)"\).*/\1/p')"
  case " $SIGNAL_ALLOWED " in
    *" $rel:$reason "*) echo "ok       $rel signalChild ($reason)" ;;
    *)
      echo "ERROR: $rel calls signalChild without an allowlisted reason (got '${reason:-none}'):" >&2
      echo "       $call" >&2
      status=1
      ;;
  esac
done <<<"$signal_calls"

# The MCP server (plan S5.1, O10 b) is a daemon client: it calls the daemon over its RPC socket with an AGENT token and never stops it, so it
# names no Shutdown call and signals no process. The scan above already covers src/mcpServer for `.kill(` and `signalChild`; this one
# keeps the Shutdown RPC out and fails if the directory goes missing.
MCP_SRC="$DAEMON_SRC/mcpServer"
if [ ! -f "$MCP_SRC/handlers.ts" ]; then
  echo "ERROR: $MCP_SRC/handlers.ts is missing — the MCP scan has drifted from the code." >&2
  exit 1
fi
mcp_shutdown="$(find "$MCP_SRC" -name '*.ts' ! -name '*.test.ts' ! -name '*.testutil.ts' | xargs grep -nE '\.shutdown\(|AdminService/Shutdown|Shutdown(Request|Origin)|process\.kill|child_process' | grep -vE ':[0-9]+:[[:space:]]*(//|\*)' || true)"
if [ -n "$mcp_shutdown" ]; then
  echo "ERROR: the MCP server must never stop a daemon or a process:" >&2
  echo "$mcp_shutdown" >&2
  status=1
else
  echo "ok       mcpServer (calls no Shutdown, signals nothing)"
fi

case " $origin_users $legacy_users " in
  *" ensure_daemon "*)
    echo "ERROR: ensure_daemon must NEVER send shutdown. Reuse on protocol equality; on" >&2
    echo "       mismatch return the typed error and do not spawn." >&2
    status=1
    ;;
esac

[ "$status" -eq 0 ] && echo "OK: no automatic session kill"
exit "$status"
