#!/usr/bin/env bash
# Invariant guard (DEL-345):
#
#   Every command name in alinery-app/src/ipc.ts must be registered in `generate_handler!`
#   in alinery-app/src-tauri/src/lib.rs.
#
# The command name is the one part of the contract TypeScript cannot check: it is a string
# on this side and an identifier on the other. Rename a Rust command, miss the frontend,
# and nothing fails — not tsc, not biome, not clippy, not cargo test. The app builds, ships,
# and throws "Command <name> not found" at whoever clicks the button.
#
# This repo has no CI and releases are cut by hand, so "someone will notice" means a user.
# The check is a set difference over two greps; it costs nothing to run every time.
#
# One-directional on purpose: Rust may register commands the UI has not adopted yet (17 of
# the 111 today). The reverse — the UI naming a command the backend does not have — is
# always a bug.
#
# Run: ./scripts/tests/check-ipc-commands.sh   (wired into scripts/check.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IPC="$ROOT/alinery-app/src/ipc.ts"
LIB="$ROOT/alinery-app/src-tauri/src/lib.rs"

[ -f "$IPC" ] || { echo "ERROR: cannot find $IPC" >&2; exit 1; }
[ -f "$LIB" ] || { echo "ERROR: cannot find $LIB" >&2; exit 1; }

# Command names the frontend asks for: the string literal in each invoke<...>("name").
frontend="$(grep -oE 'invoke<[^(]*>\("[a-z_]+"|invoke\("[a-z_]+"' "$IPC" | grep -oE '"[a-z_]+"' | tr -d '"' | sort -u)"

# Command names the backend registers: the body of generate_handler![ ... ].
backend="$(
  awk '/generate_handler!\[/{f=1; sub(/.*generate_handler!\[/, "")} f{print} /\]/{if(f)exit}' "$LIB" \
    | tr ',' '\n' \
    | sed -e 's|//.*||' -e 's/[^a-z_]//g' \
    | grep -E '^[a-z][a-z_]+$' \
    | sort -u
)"

[ -n "$frontend" ] || { echo "ERROR: found no invoke(\"...\") names in $IPC — the pattern has drifted." >&2; exit 1; }
[ -n "$backend" ]  || { echo "ERROR: could not read generate_handler! from $LIB — the pattern has drifted." >&2; exit 1; }

missing="$(comm -23 <(echo "$frontend") <(echo "$backend") || true)"

if [ -n "$missing" ]; then
  echo "ERROR: alinery-app/src/ipc.ts calls commands the Rust backend does not register:" >&2
  echo "$missing" | sed 's/^/       /' >&2
  echo "       Either the name is misspelled, or the command was renamed/removed in" >&2
  echo "       alinery-app/src-tauri/src/lib.rs without updating the frontend." >&2
  exit 1
fi

echo "OK: all $(echo "$frontend" | wc -l | tr -d ' ') frontend commands are registered in generate_handler! ($(echo "$backend" | wc -l | tr -d ' ') available)"
