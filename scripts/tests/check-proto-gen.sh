#!/usr/bin/env bash
# proto/gen is checked in so bun build --compile, vitest and tsc work without buf. This gate
# regenerates it from proto/alinery into a scratch copy and fails on any difference, including
# a stale file in gen/ whose .proto is gone. Needs `npm --prefix proto ci` (buf and
# protoc-gen-es are devDependencies); it never touches proto/gen itself. It does the same for
# proto/golden, the bytes the Rust shell's hand-written messages are tested against (golden.ts,
# run with $BUN or the bun on PATH).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROTO="$ROOT/proto"
[ -x "$PROTO/node_modules/.bin/buf" ] || {
  echo "FAIL - proto tools are not installed; run: npm --prefix proto ci" >&2
  exit 1
}
TMP="$(mktemp -d "${TMPDIR:-/tmp}/check-proto-gen.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/proto"
cp -R "$PROTO/alinery" "$PROTO/buf.yaml" "$PROTO/buf.gen.yaml" "$PROTO/package.json" "$PROTO/golden.ts" "$TMP/proto/"
ln -s "$PROTO/node_modules" "$TMP/proto/node_modules"
(cd "$TMP/proto" && npm run --silent gen) || { echo "FAIL - buf generate or lint failed" >&2; exit 1; }
if diff -r "$PROTO/gen" "$TMP/proto/gen" >&2; then
  echo "ok   - proto/gen matches the .proto files"
else
  echo "FAIL - proto/gen is stale; run: npm --prefix proto run gen" >&2
  exit 1
fi
BUN="${BUN:-$(command -v bun || true)}"
[ -n "$BUN" ] || { echo "FAIL - bun is not installed; golden.ts needs it" >&2; exit 1; }
(cd "$TMP/proto" && "$BUN" golden.ts) || { echo "FAIL - golden.ts failed" >&2; exit 1; }
if diff -r "$PROTO/golden" "$TMP/proto/golden" >&2; then
  echo "ok   - proto/golden matches the .proto files"
else
  echo "FAIL - proto/golden is stale; run: (cd proto && bun golden.ts)" >&2
  exit 1
fi
