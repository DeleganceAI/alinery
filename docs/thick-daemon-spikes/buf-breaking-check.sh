#!/usr/bin/env bash
# O23 (WA a): can `buf breaking` be limited to alinery/v1/admin.proto and common.proto, so the
# frozen Hello/Shutdown surface is guarded while every other proto may change freely?
#
# Method: `--path` (repeatable) on `buf breaking`, against (1) an image of the current tree and
# (2) a git ref of this repo. Each case copies the module to a scratch dir and changes one thing.
#
# Result (2026-11-05, buf 1.75.0): yes. `buf breaking --against '<repo>/.git#ref=<tag>,subdir=<dir>'
# --path proto/alinery/v1/admin.proto --path proto/alinery/v1/common.proto` fails on a field or enum
# number change in either file and passes when only tasks.proto changes (which fails unscoped).
# Against a saved image the input must be an image too, with module-relative --path values.
# buf.yaml has no "only these files" setting for breaking (only `ignore`), so the scope lives in
# the command line of the gate, not in buf.yaml.
#
# Usage, from docs/thick-daemon-spikes after `bun install`:
#   ./buf-breaking-check.sh [scratch-dir]
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# node_modules/.bin/buf is a node shim; call the platform binary it would exec, so node isn't needed.
BUF=${BUF:-$(ls "$HERE"/node_modules/@bufbuild/buf-*/bin/buf | head -1)}
S=${1:-$(mktemp -d "${TMPDIR:-/tmp}/o23-buf.XXXXXX")}
mkdir -p "$S"
SCOPE=(--path proto/alinery/v1/admin.proto --path proto/alinery/v1/common.proto)
echo "buf $("$BUF" --version)  scratch: $S"

# Baseline image of the module as it is now (no network: buf.yaml has no deps).
(cd "$HERE" && "$BUF" build -o "$S/base.binpb") || exit 1
ROOT=$(git -C "$HERE" rev-parse --show-toplevel)
SUB=${HERE#"$ROOT"/}
GITREF="$ROOT/.git#ref=HEAD,subdir=$SUB"

expect() { # want(pass|fail), label, dir, against, extra args...
  local want=$1 label=$2 dir=$3 against=$4 got out
  shift 4
  if [ "$against" = "$S/base.binpb" ]; then
    # An image stores module-relative paths (alinery/v1/admin.proto) and --path filters both sides,
    # so a directory input with proto/... paths against an image gives "image contains no files".
    # Image against image, with module-relative --path, works.
    out=$(cd "$dir" && "$BUF" build -o "$S/input.binpb" && "$BUF" breaking "$S/input.binpb" --against "$against" "${@//proto\/alinery/alinery}" 2>&1) && got=pass || got=fail
  else
    out=$(cd "$dir" && "$BUF" breaking --against "$against" "$@" 2>&1) && got=pass || got=fail
  fi
  local mark=ok; [ "$got" = "$want" ] || mark=UNEXPECTED
  printf '  %-60s %-4s (want %s) %s\n' "$label" "$got" "$want" "$mark"
  [ -n "$out" ] && printf '%s\n' "$out" | head -3 | sed 's/^/      /'
}

# case <name> <sed-expr> <file>: a fresh copy of the module with one edit applied.
case_dir() {
  local d="$S/$1"
  rm -rf "$d" && mkdir -p "$d"
  cp -r "$HERE/proto" "$HERE/buf.yaml" "$d/"
  sed -i.bak "$2" "$d/proto/alinery/v1/$3" && rm "$d/proto/alinery/v1/$3.bak"
  if cmp -s "$HERE/proto/alinery/v1/$3" "$d/proto/alinery/v1/$3"; then echo "edit $1 did not apply" >&2; exit 1; fi
  echo "$d"
}

ADMIN=$(case_dir admin-field 's/string build_id = 2;/string build_id = 7;/' admin.proto)
COMMON=$(case_dir common-field 's/uint64 seq = 2;/uint64 seq = 3;/' common.proto)
TASKS=$(case_dir tasks-field 's/= 1;/= 99;/' tasks.proto)
ADMIN_ENUM=$(case_dir admin-enum 's/SHUTDOWN_ORIGIN_STOP_REMOTE = 5;/SHUTDOWN_ORIGIN_STOP_REMOTE = 6;/' admin.proto)
ADMIN_ADD=$(case_dir admin-add 's/uint32 sessions_stopped = 1;/uint32 sessions_stopped = 1; string note = 2;/' admin.proto)

for against in "$S/base.binpb" "$GITREF"; do
  echo "== against ${against/#$S\//scratch/}"
  expect fail "admin.proto: HelloResponse.build_id 2 -> 7, scoped" "$ADMIN" "$against" "${SCOPE[@]}"
  expect fail "admin.proto: enum value 5 -> 6, scoped" "$ADMIN_ENUM" "$against" "${SCOPE[@]}"
  expect pass "admin.proto: field added (compatible), scoped" "$ADMIN_ADD" "$against" "${SCOPE[@]}"
  expect fail "common.proto: Cursor.seq 2 -> 3, scoped" "$COMMON" "$against" "${SCOPE[@]}"
  expect pass "tasks.proto: field numbers changed, scoped" "$TASKS" "$against" "${SCOPE[@]}"
  expect fail "tasks.proto: field numbers changed, unscoped (control)" "$TASKS" "$against"
  expect pass "no change, scoped" "$HERE" "$against" "${SCOPE[@]}"
done
