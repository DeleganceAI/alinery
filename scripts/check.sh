#!/usr/bin/env bash
# The one command. Runs every automated check in this repo — TypeScript and Rust — and
# returns a single verdict.
#
#   ./scripts/check.sh            everything
#   ./scripts/check.sh --quick    skips the slow behavioural suites (what the
#                                 pre-push hook runs)
#
# --quick drops the suites that spawn a real alineryd over a real socket, drive a pty with
# expect(1), or build throwaway git repos. Everything that can catch a bad code change
# (lint, typecheck, both test suites, clippy, and the source gates) runs either way.
#
# Escape hatch: ALINERY_SKIP_CHECK=1 git push
set -euo pipefail

trap 'status=$?; [ "$status" -eq 0 ] || printf "\n\033[1mFAILED: check aborted (exit %s)\033[0m\n" "$status" >&2; exit "$status"' EXIT

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/alinery-app"
TAURI="$APP/src-tauri"

QUICK=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

step() { printf '\n\033[1m== %s\033[0m\n' "$*" >&2; }

[ -d "$APP/node_modules" ] || {
  echo "ERROR: alinery-app/node_modules is missing — run: (cd alinery-app && npm install)" >&2
  exit 1
}

# ---------- frontend ----------
step "frontend: biome (lint + format)"
(cd "$APP" && npm run --silent lint)

step "frontend: typecheck (sources + tests)"
(cd "$APP" && npm run --silent typecheck)

step "frontend: vitest"
(cd "$APP" && npm run --silent test)

step "frontend: omp extension (node --test)"
(cd "$APP" && npm run --silent test:omp-extension)

# ---------- rust ----------
step "rust: sidecars"
bash "$TAURI/scripts/copy-sidecar.sh" debug >/dev/null

step "rust: fmt"
(cd "$TAURI" && cargo fmt --all --check)

step "rust: clippy"
(cd "$TAURI" && cargo clippy --workspace --all-targets -- -D warnings)

step "rust: tests (--workspace)"
(cd "$TAURI" && cargo test --workspace)

# ---------- source-invariant gates ----------
step "source gates"
"$ROOT/scripts/tests/check-git-env-scrub.sh"
"$ROOT/scripts/tests/check-no-auto-session-kill.sh"
"$ROOT/scripts/tests/check-omp-no-path-fallback.sh"
"$ROOT/scripts/tests/check-no-window-confirm.sh"
"$ROOT/scripts/tests/check-protocol-version-bump.sh"
"$ROOT/scripts/tests/check-wire-parsing-boundary.sh"
"$ROOT/scripts/tests/check-ipc-boundary.sh"
"$ROOT/scripts/tests/check-ipc-commands.sh"
"$ROOT/scripts/tests/check-telemetry-privacy.sh"
"$ROOT/scripts/tests/check-connection-status-never-decrypts.sh"
"$ROOT/scripts/tests/omp_lib_test.sh"
"$ROOT/scripts/tests/dev_fetch_omp_test.sh"
"$ROOT/scripts/tests/install_omp_place_test.sh"

# ---------- behavioural shell suites (slow) ----------
if [ "$QUICK" -eq 1 ]; then
  step "skipping behavioural shell suites (--quick)"
else
  step "behavioural shell suites"
  "$ROOT/scripts/tests/protocol_gate_test.sh"
  "$ROOT/scripts/tests/preflight_test.sh"
  "$ROOT/scripts/tests/preflight_live_test.sh"
  "$ROOT/scripts/tests/updater_swap_test.sh"
fi

echo
if [ "$QUICK" -eq 1 ]; then
  echo "OK: check passed (--quick; behavioural shell suites skipped)"
else
  echo "OK: check passed"
fi
