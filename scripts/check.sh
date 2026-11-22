#!/usr/bin/env bash
# The one command. Runs every automated check in this repo — TypeScript and Rust — and
# returns a single verdict.
#
#   ./scripts/check.sh            everything
#   ./scripts/check.sh --quick    skips the slow behavioural suites
#   ./scripts/check.sh --release  everything, minus the known-flaky tests in scripts/tests/release-flaky.txt
#                                 (what alinery-deploy's release check runs; the dev gate keeps running them)
#
# --quick drops the suites that spawn a real alineryd over a real socket, drive a pty with
# expect(1), or build throwaway git repos. Everything that can catch a bad code change
# (lint, typecheck, both test suites, clippy, and the source gates) runs either way.
set -euo pipefail

trap 'status=$?; [ "$status" -eq 0 ] || printf "\n\033[1mFAILED: check aborted (exit %s)\033[0m\n" "$status" >&2; exit "$status"' EXIT

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/alinery-app"
TAURI="$APP/src-tauri"

QUICK=0
RELEASE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --release) RELEASE=1 ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

step() { printf '\n\033[1m== %s\033[0m\n' "$*" >&2; }

[ -d "$APP/node_modules" ] || {
  echo "ERROR: alinery-app/node_modules is missing — run: (cd alinery-app && npm install)" >&2
  exit 1
}

# Bun runs the daemon's and the playbook engine's tests. Same search order as
# dev-fetch-bun.sh, minus the download: $BUN, the copy it installs, then PATH.
BUN_PIN="$(tr -d '[:space:]' < "$ROOT/scripts/bun-pin.txt")"
bun_ok() { [ -x "$1" ] && [ "$(printf '%s\n%s\n' "$BUN_PIN" "$("$1" --version)" | sort -V | head -n1)" = "$BUN_PIN" ]; }
BUN="${BUN:-}"
for cand in "$BUN" "${TMPDIR:-/tmp}/alinery-bun-$BUN_PIN/bin/bun" "$(command -v bun || true)"; do
  if [ -n "$cand" ] && bun_ok "$cand"; then BUN="$cand"; break; fi
  BUN=""
done
export BUN
[ -n "$BUN" ] || {
  echo "ERROR: Bun $BUN_PIN or newer is missing — run: scripts/dev-fetch-bun.sh" >&2
  exit 1
}

# proto/ needs its own node_modules before the app or the daemon resolve alinery-proto.
"$ROOT/scripts/install-proto.sh" --with-dev

# A release does not wait on a known flake: --release skips the tests listed in release-flaky.txt.
# Vitest and bun have no skip flag; a name pattern that matches every test except the listed ones does the same.
CARGO_SKIP=()
VITEST_ARGS=()
DAEMON_ARGS=()
if [ "$RELEASE" -eq 1 ]; then
  vitest_skip=""
  daemon_skip=""
  while read -r suite rest; do
    name="${rest%%  #*}"
    escaped="$(printf '%s' "$name" | sed 's/[][\\.*^$(){}+?|/]/\\&/g')"
    case "$suite" in
      cargo) CARGO_SKIP+=(--skip "$name") ;;
      vitest) vitest_skip="${vitest_skip:+$vitest_skip|}$escaped" ;;
      daemon) daemon_skip="${daemon_skip:+$daemon_skip|}$escaped" ;;
      *) echo "ERROR: release-flaky.txt: unknown suite '$suite'" >&2; exit 1 ;;
    esac
  done < <(grep -Ev '^[[:space:]]*(#|$)' "$ROOT/scripts/tests/release-flaky.txt")
  [ -z "$vitest_skip" ] || VITEST_ARGS=(-t "^(?!.*(${vitest_skip}))")
  [ -z "$daemon_skip" ] || DAEMON_ARGS=(-t "^(?!.*(${daemon_skip}))")
fi

# ---------- frontend ----------
step "frontend: biome (lint + format)"
(cd "$APP" && npm run --silent lint)

step "frontend: typecheck (sources + tests)"
(cd "$APP" && npm run --silent typecheck)

step "frontend: vitest${VITEST_ARGS[0]+, skipping known-flaky}"
(cd "$APP" && npm run --silent test -- ${VITEST_ARGS[@]+"${VITEST_ARGS[@]}"})

# ---------- bun ----------
step "proto: bun test"
(cd "$ROOT/proto" && "$BUN" test)

step "daemon: bun test${DAEMON_ARGS[0]+, skipping known-flaky}"
# Apply the pinned runtime patch even when this checkout already has the unpatched dependency.
(cd "$TAURI/vinculum-daemon" && "$BUN" install --frozen-lockfile)
# Many daemon tests start real processes; a slow runner overruns bun's 5 s default, and a timed-out test has its processes
# killed, a shared fixture daemon among them, which fails every test after it. bunfig.toml's `timeout` is ignored (bun 1.4.3).
(cd "$TAURI/vinculum-daemon" && "$BUN" test --timeout 30000 ${DAEMON_ARGS[@]+"${DAEMON_ARGS[@]}"})

step "playbook engine: bun test"
[ -d "$ROOT/playbook-engine/node_modules" ] || (cd "$ROOT/playbook-engine" && "$BUN" install --frozen-lockfile)
(cd "$ROOT/playbook-engine" && "$BUN" test)

# ---------- rust ----------
step "rust: sidecars"
bash "$TAURI/scripts/copy-sidecar.sh" debug >/dev/null
# The sidecar exists from here on: a test that would skip for want of it fails instead.
export ALINERY_REQUIRE_SIDECAR=1

step "rust: fmt"
(cd "$TAURI" && cargo fmt --all --check)

step "rust: clippy"
(cd "$TAURI" && cargo clippy --workspace --all-targets -- -D warnings)

step "rust: tests (--workspace)${CARGO_SKIP[0]+, skipping $(( ${#CARGO_SKIP[@]} / 2 )) known-flaky}"
(cd "$TAURI" && cargo test --workspace -- ${CARGO_SKIP[@]+"${CARGO_SKIP[@]}"})

# ---------- source-invariant gates ----------
step "source gates"
"$ROOT/scripts/tests/check-git-env-scrub.sh"
"$ROOT/scripts/tests/check-daemon-git-spawn.sh"
"$ROOT/scripts/tests/daemon_git_spawn_test.sh"
"$ROOT/scripts/tests/check-proto-gen.sh"
"$ROOT/scripts/tests/check-admin-wire-frozen.sh"
"$ROOT/scripts/tests/admin_wire_frozen_test.sh"
"$ROOT/scripts/tests/check-no-curl.sh"
"$ROOT/scripts/tests/check-daemon-fs-writes.sh"
"$ROOT/scripts/tests/check-no-auto-session-kill.sh"
"$ROOT/scripts/tests/no_auto_session_kill_test.sh"
"$ROOT/scripts/tests/check-ssh-spawn.sh"
"$ROOT/scripts/tests/check-remote-routing.sh"
"$ROOT/scripts/tests/check-remote-offload.sh"
"$ROOT/scripts/tests/check-no-window-confirm.sh"
"$ROOT/scripts/tests/check-canvas-iframe-sandbox.sh"
"$ROOT/scripts/tests/check-blocking-commands.sh"
"$ROOT/scripts/tests/check-protocol-version-bump.sh"
"$ROOT/scripts/tests/check-wire-parsing-boundary.sh"
"$ROOT/scripts/tests/check-ipc-boundary.sh"
"$ROOT/scripts/tests/check-ipc-commands.sh"
"$ROOT/scripts/tests/check-telemetry-privacy.sh"
"$ROOT/scripts/tests/check-connection-status-never-decrypts.sh"
"$ROOT/scripts/tests/git_lib_test.sh"
"$ROOT/scripts/tests/dev_fetch_bun_test.sh"
"$ROOT/scripts/tests/check-experimental-daemon-names.sh"

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
