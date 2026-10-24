#!/usr/bin/env bash
# A throwaway Debian sshd for the live remote tests (the `live_*` tests in
# alinery-app/src-tauri/src/tests/remote.rs). Needs Docker. The key pair is made fresh and kept
# under $TMPDIR; nothing here touches ~/.ssh.
#
#   scripts/tests/remote-sshd/run.sh start   build, run on 127.0.0.1:2222, print the export line
#   scripts/tests/remote-sshd/run.sh stop
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="${TMPDIR:-/tmp}/alinery-test-sshd"
NAME=alinery-test-sshd

case "${1:-}" in
  start)
    mkdir -p "$STATE"
    [ -f "$STATE/id_test" ] || ssh-keygen -q -t ed25519 -N '' -f "$STATE/id_test"
    cp "$HERE/Dockerfile" "$STATE/Dockerfile"
    docker build -q -t "$NAME" "$STATE" >/dev/null
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --rm --name "$NAME" -p 127.0.0.1:2222:22 "$NAME" >/dev/null
    # A new container has new host keys, so an old entry would be refused as a changed key.
    rm -f "$STATE/known_hosts"
    echo "export ALINERY_TEST_SSH_ARGS=\"-p 2222 -i $STATE/id_test -o IdentitiesOnly=yes -o UserKnownHostsFile=$STATE/known_hosts dev@127.0.0.1\""
    ;;
  stop)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 2
    ;;
esac
