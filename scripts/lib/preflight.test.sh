#!/usr/bin/env bash
# No real processes are signalled: every live-machine operation below is stubbed.
set -euo pipefail
source "$(dirname "$0")/preflight.sh"
[ "$(repo_daemon_sockets '/tmp/repo with spaces' | head -n 1)" = '/tmp/repo with spaces/.alinery/rpc.sock' ]
known_repos_from_app_config() { printf '/tmp/repo with spaces\n'; }
discover_live_daemon_repos() { :; }
probe_version() { printf 'alive'; }
live_sessions_from_metas() { printf 1; }
alinery_app_is_running() { return 1; }
ask_tty() { printf n; }
stop_repo_daemon() { echo 'Unexpected daemon stop' >&2; exit 1; }
stop_alinery_app() { echo 'Unexpected app stop' >&2; exit 1; }
if preflight_gate 0 >/dev/null; then
  echo 'Declined update was accepted' >&2
  exit 1
fi
printf 'Preflight current-path and decline checks passed\n'
