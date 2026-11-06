#!/usr/bin/env bash
# Invariant guard (product-usage telemetry):
#
#   Telemetry payloads are allow-listed. A future field added to Task / SessionMeta
#   must never leak into alinery_core::telemetry by accident, and no call site outside
#   the wrapper may construct OpenObserve requests or shell out to curl. Hosted
#   inference may use ureq against accounts.alinery.ai; that is not ingest.
#
# The daemon sends its own events for what it does (plan O17 c, S4.1), so the same holds for its
# TypeScript: only vinculum-daemon/src/platform/telemetry.ts builds an ingest request, and the
# banned fields apply to it too.
#
# A unit test that serializes a closed enum cannot catch a later author reaching
# for `ureq::` or stuffing `worktree` into TelemetryEvent. Hence a source-level
# check, same shape as check-no-auto-session-kill.sh.
#
# Run: ./scripts/tests/check-telemetry-privacy.sh   (wired into scripts/check.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TELEMETRY_RS="$ROOT/alinery-app/src-tauri/alinery-core/src/telemetry.rs"
DAEMON_SRC="$ROOT/alinery-app/src-tauri/vinculum-daemon/src"
TELEMETRY_TS="$DAEMON_SRC/platform/telemetry.ts"
CORE_SRC="$ROOT/alinery-app/src-tauri"

for f in "$TELEMETRY_RS" "$TELEMETRY_TS"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: missing $f" >&2
    exit 1
  fi
done

status=0

# Self-check: a gutted wrapper must not go green.
if ! grep -q 'enum TelemetryEvent' "$TELEMETRY_RS"; then
  echo "ERROR: TelemetryEvent missing from telemetry.rs (guard drifted?)" >&2
  status=1
fi
if ! grep -q 'fn record_event' "$TELEMETRY_RS"; then
  echo "ERROR: record_event missing from telemetry.rs (guard drifted?)" >&2
  status=1
fi

if ! grep -q 'export function eventRecord' "$TELEMETRY_TS" || ! grep -q 'export const ingestUrl' "$TELEMETRY_TS"; then
  echo "ERROR: eventRecord or ingestUrl missing from platform/telemetry.ts (guard drifted?)" >&2
  status=1
fi

# Field / struct identifiers that must never appear in the wrapper. Anchored as
# rust field or struct-member patterns so sanitize_phase, has_worktree,
# GitWorktreeRemove, and Authorization do not trip. `resume_token` is also
# banned (harness_resume_token's shorter sibling).
#
# Deliberately ALLOWED, and absent from the list below on purpose:
#   telemetry_id  the minted per-task / per-session UUID (types.rs new_telemetry_id)
#   task_id       that UUID on the wire; never derived from the slug
#   session_id    likewise. Both are opaque randoms, so they correlate events
#                 without carrying a name, path or any user content.
# `correlation_id` stays banned: it predates these and named no owner, so a field
# reappearing under that name is a smell, not this feature.
blocklist_pat='(^|[^A-Za-z0-9_])(worktree|prompt_extra|prompt|slug|scrollback|linear_id|github_issue|pr_url|harness_resume_token|resume_token|event_token|omp_session_id|omp_turn_id|correlation_id|email|api_key|token)([^A-Za-z0-9_]|$)'
if grep -nE "$blocklist_pat" "$TELEMETRY_RS"; then
  echo "ERROR: blocklisted identifier in telemetry.rs" >&2
  status=1
fi
if grep -nE "$blocklist_pat" "$TELEMETRY_TS"; then
  echo "ERROR: blocklisted identifier in platform/telemetry.ts" >&2
  status=1
fi

# OpenObserve ingest stays inside the wrapper. Hosted inference uses the same
# ureq crate against accounts.alinery.ai — that is not telemetry.
while IFS= read -r f; do
  case "$f" in
    */telemetry.rs) continue ;;
  esac
  if grep -nE 'Authorization: Basic|/api/\{|/_json' "$f"; then
    echo "ERROR: OpenObserve ingest leaked outside telemetry.rs: $f" >&2
    status=1
  fi
  case "$f" in
    */hosted_inference.rs|*/http.rs) continue ;;
  esac
  if grep -nE 'ureq::' "$f"; then
    echo "ERROR: ureq transport leaked outside telemetry.rs / hosted_inference.rs / http.rs: $f" >&2
    status=1
  fi
done < <(find "$CORE_SRC" -name '*.rs' -print)

# The same for the daemon: the ingest URL and the Basic credential are built in platform/telemetry.ts only.
while IFS= read -r f; do
  if grep -nE 'Authorization: Basic|Basic \$\{|/_json|/api/\$\{' "$f"; then
    echo "ERROR: OpenObserve ingest leaked outside platform/telemetry.ts: $f" >&2
    status=1
  fi
done < <(find "$DAEMON_SRC" -name '*.ts' ! -name '*.test.ts' ! -path "$TELEMETRY_TS" -print)

# No curl helper in the wrapper (or a sibling telemetry helper).
if grep -nE 'Command::new\("curl"\)' "$TELEMETRY_RS"; then
  echo "ERROR: telemetry.rs must not shell out to curl" >&2
  status=1
fi
if [ -d "$ROOT/alinery-app/src-tauri/src" ]; then
  if grep -nE 'Command::new\("curl"\)' "$ROOT/alinery-app/src-tauri/src/telemetry.rs" 2>/dev/null; then
    echo "ERROR: app-crate telemetry helper must not shell out to curl" >&2
    status=1
  fi
fi

[ "$status" -eq 0 ] && echo "OK: telemetry privacy"
exit "$status"
