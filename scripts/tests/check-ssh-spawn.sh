#!/usr/bin/env bash
# Remote (SSH) repos have two source rules.
#
# 1. `ssh` is spawned in exactly one module, src/remote.rs. It owns the ControlMaster, the
#    BatchMode and StreamLocalBindUnlink flags and the destination allowlist; a second spawn
#    site would bypass all of them.
# 2. Nothing on the remote path may kill a process by name or signal. Connecting and
#    disconnecting never end a remote session (see check-no-auto-session-kill.sh for the
#    five deliberate teardowns); killing the ssh child of a channel with `Child::kill` is
#    fine because it ends only that channel.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TAURI="$ROOT/alinery-app/src-tauri"

hits=$(grep -rn -E 'Command::new\("(ssh|scp|sftp|ssh-keyscan)"\)' \
  --include='*.rs' \
  "$TAURI/src" "$TAURI/alinery-core/src" "$TAURI/mcp/src" \
  | grep -v "^$TAURI/src/remote.rs:" \
  | grep -v "^$TAURI/src/tests/" || true)

if [ -n "$hits" ]; then
  echo "ERROR: ssh may only be spawned from alinery-app/src-tauri/src/remote.rs:" >&2
  echo "$hits" >&2
  exit 1
fi

kills=$(grep -n -E 'pkill|killall|kill -[0-9A-Za-z]|systemctl --user (stop|kill)|systemctl stop' \
  "$TAURI/src/remote.rs" \
  "$TAURI/mcp/src/repo_service.rs" \
  "$TAURI/alinery-core/src/repo_service.rs" \
  "$TAURI/alinery-core/src/credential_sync.rs" || true)

if [ -n "$kills" ]; then
  echo "ERROR: the remote path must not kill processes by name or signal:" >&2
  echo "$kills" >&2
  exit 1
fi

echo "OK: ssh is spawned only from remote.rs and the remote path kills nothing"
