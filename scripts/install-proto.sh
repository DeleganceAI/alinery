#!/usr/bin/env bash
# Install proto/'s own node_modules. The daemon and the app link `alinery-proto` to proto/, so
# every tool resolves the generated code's `@bufbuild/protobuf` import from proto/'s real
# path: without this install, bun and Vite fail and tsc silently downgrades the types to
# `Message`. Run it before any daemon or app install or build.
#
#   scripts/install-proto.sh              runtime dependencies only (building the daemon or app)
#   scripts/install-proto.sh --with-dev   plus buf and protoc-gen-es (regenerating, check-proto-gen.sh)
#
# A no-op when node_modules is newer than package-lock.json, so a launch that must not reach
# the network does not.
set -euo pipefail
PROTO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../proto" && pwd)"
DEV=--omit=dev
[ "${1:-}" = "--with-dev" ] && DEV=
fresh=0
[ "$PROTO/node_modules/.package-lock.json" -nt "$PROTO/package-lock.json" ] && fresh=1
[ -z "$DEV" ] && [ ! -x "$PROTO/node_modules/.bin/buf" ] && fresh=0
[ "$fresh" = 1 ] || npm --prefix "$PROTO" ci $DEV --no-audit --no-fund --prefer-offline
