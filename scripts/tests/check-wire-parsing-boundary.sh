#!/usr/bin/env bash
# The app and MCP alineryd wire contract must live entirely in `alinery-core/src/daemon_client.rs`.
#
# `check-protocol-version-bump.sh` watches a SURFACE of files. That is only worth
# something if the contract cannot quietly move back *out* of them: reply parsing sat in
# `lib.rs` for exactly that reason, so renaming a field the app expects broke it against an
# unchanged daemon while the version gate stayed green. This is the source-level half —
# the gate proves a bump happened, this proves there was something to bump.
#
# Run from scripts/release.sh alongside the other guards.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

CLIENT="alinery-app/src-tauri/alinery-core/src/daemon_client.rs"
# Discover every app and MCP caller source. A hardcoded module list is allow-by-omission:
# a request rebuilt in a new module would otherwise go unscanned while this still printed OK.
OUTSIDE=()
while IFS= read -r f; do OUTSIDE+=("$f"); done < <(
  find alinery-app/src-tauri/src alinery-app/src-tauri/mcp/src -maxdepth 1 -name '*.rs' | sort
)
[ "${#OUTSIDE[@]}" -gt 0 ] || { echo "ERROR: no app/MCP caller sources found to scan" >&2; exit 1; }

fails=0
report() { # label file:line…
  echo "ERROR: $1" >&2
  printf '%s\n' "$2" | sed 's/^/         /' >&2
  fails=$((fails + 1))
}

# 1. Hand-built requests. `json!({"op": …})` is unambiguous — the only thing that shape
#    ever means is an alineryd request, so this has no false positives.
hits="$(grep -nE 'json!\(\{[[:space:]]*"op"' "${OUTSIDE[@]}" 2>/dev/null || true)"
[ -z "$hits" ] || report \
  "an alineryd request is built outside $CLIENT — every request must be built there, or a rename here changes the wire with the version gate still green." \
  "$hits"

# 2. Reply fields only the daemon ever sends. Deliberately NOT `status` or `error`: those
#    names also appear in this repo's GitHub API handling, and a guard that cries wolf gets
#    deleted. Partial coverage that everyone trusts beats total coverage nobody runs — the
#    fixture test in protocol_gate_test.sh covers the rest by proving the verdict.
hits="$(grep -nE '\.get\("(sessions|protocol|build_id|app_config_identity|host_guard_ready|attach_id|resume_token|transport)"\)' \
  "${OUTSIDE[@]}" 2>/dev/null || true)"
[ -z "$hits" ] || report \
  "an alineryd reply is parsed outside $CLIENT — the fields the app expects back are as much the wire as the ops it sends." \
  "$hits"

if [ "$fails" -ne 0 ]; then
  echo >&2
  echo "Move it into $CLIENT and have the caller consume the typed result." >&2
  exit 1
fi
echo "OK: app/MCP wire contract is confined to $CLIENT"
