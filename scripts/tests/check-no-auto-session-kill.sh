#!/usr/bin/env bash
# Invariant guard (ticket: daemon protocol gate + GH #132):
#
#   No Saga code path automatically kills a live session. Every kill originates in a
#   deliberate, explicitly-clicked user action carrying a loss-of-work warning.
#
# Fails if any function in the Tauri app sends the daemon's `shutdown` op (which
# SIGTERM/SIGKILLs every harness process group) unless that function is one of the
# deliberate teardown origins below.
#
# A behavioural test alone would pass against a re-introduced *conditional* kill, which
# is exactly how the original bug shipped — hence a source-level check.
#
# Run: ./scripts/tests/check-no-auto-session-kill.sh   (wired into scripts/release.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/alinery-app/src-tauri/src"

# Every app-crate module, not just lib.rs — the teardown origins live in daemon.rs,
# backup.rs and app_config.rs since lib.rs was split into domain modules. Scanning one
# file would leave the rest unpoliced *and* trip the drift self-check below.
#
# Two exclusions:
#   daemon_client.rs  defines shutdown_request() itself; scanning it flags the definition.
#   tests.rs          test-only callers are not product paths.
LIBS=()
for f in "$SRC"/*.rs; do
  case "$(basename "$f")" in
    daemon_client.rs | tests.rs) continue ;;
    *) LIBS+=("$f") ;;
  esac
done
[ "${#LIBS[@]}" -gt 0 ] || { echo "ERROR: no app-crate sources found under $SRC" >&2; exit 1; }

# The ONLY deliberate session-kill origins. Add a name here only together with a
# user-facing confirmation that names the repo and states known or unknown session impact:
#   stop_daemon           Settings → Harness → "Quit & stop all sessions" (B1)
#   close_repo_daemon     close-repo confirmation (B4)
#   restore_backup        destructive restore, confirmed in the UI (the daemon holds the
#                         data being replaced, so it is not restarted afterwards)
#   confirm_repo_takeover_blocking  consumed one-shot selected-owner confirmation
ALLOWED="stop_daemon close_repo_daemon restore_backup confirm_repo_takeover_blocking switch_pi_durable_blocking"

# `close_repo_daemon` is a plain fn, so a NEW CALLER of it would end every live session in
# a repo without adding a `shutdown` sender for the scan above to notice. Its callers are
# therefore allowlisted separately:
#   remove_repo      close-repo confirmation (B4)
#   close_all_repos  the quit dialog's express "close all repos" choice
CLOSE_CALLERS_ALLOWED="remove_repo close_all_repos"

senders="$(
  awk '
    # Reset attribution at each file boundary so a hit never inherits the previous
    # file'"'"'s last function name.
    FNR == 1 { current = "" }
    match($0, /^[[:space:]]*(pub(\([^)]*\))? )?(async )?fn [a-z_0-9]+/) {
      f = $0
      sub(/.*fn /, "", f)
      sub(/[^a-z_0-9].*/, "", f)
      current = f
    }
    # Two spellings, both matched on purpose: the wire client builds requests through
    # daemon_client::shutdown_request(), but a hand-rolled json!({"op":"shutdown"}) must
    # not slip past this guard just because it bypassed the module.
    /"op"[[:space:]]*:[[:space:]]*"shutdown"/ || /shutdown_request\(/ || /\.shutdown[[:space:]]*\([[:space:]]*\)/ { print current }
  ' "${LIBS[@]}" | sort -u | tr '\n' ' '
)"
senders="$(echo $senders)"

if [ -z "$senders" ]; then
  # The grep pattern must keep matching something, or this check silently passes forever.
  echo "ERROR: found no shutdown senders at all — the match pattern has drifted from the code." >&2
  exit 1
fi

status=0
for fn in $senders; do
  case " $ALLOWED " in
    *" $fn "*) echo "ok       $fn (deliberate teardown)" ;;
    *)
      echo "ERROR: $fn sends the daemon shutdown op — that kills every live session." >&2
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
for (const dir of ["src", "mcp/src", "alinery-core/src"]) {
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
      if (/\.shutdown\s*\(\s*\)/.test(line) && !(dir === "src" && current === "confirm_repo_takeover_blocking")) {
        throw new Error(`${dir}/${name}: ${current} sends bound shutdown outside confirmed takeover`);
      }
      if (dir !== "src" && /\bshutdown_request\s*\(/.test(line) && !declaration && !(dir === "alinery-core/src" && name === "daemon_client.rs" && current === "shutdown")) {
        throw new Error(`${dir}/${name}: ${current} sends shutdown outside checked core transport`);
      }
    }
  }
}
JS

case " $senders " in
  *" ensure_daemon "*)
    echo "ERROR: ensure_daemon must NEVER send shutdown. Reuse on protocol equality; on" >&2
    echo "       mismatch return the typed error and do not spawn." >&2
    status=1
    ;;
esac

[ "$status" -eq 0 ] && echo "OK: no automatic session kill"
exit "$status"
