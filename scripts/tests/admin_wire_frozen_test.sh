#!/usr/bin/env bash
# Does check-admin-wire-frozen.sh catch a break of the frozen wire, ignore a change to any other
# proto, and skip while no tag has proto/? One throwaway git repo per case; the real tree is untouched.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$ROOT/scripts/tests/check-admin-wire-frozen.sh"
fails=0
check() { # label expected actual
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected $2, got $3)"; fails=$((fails + 1)); fi
}
TMP="$(mktemp -d "${TMPDIR:-/tmp}/admin-frozen.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fixture() { # name -> a repo with the real proto/ committed, no tag
  local r="$TMP/$1"
  mkdir -p "$r/proto"
  cp -R "$ROOT/proto/alinery" "$ROOT/proto/buf.yaml" "$r/proto/"
  ln -s "$ROOT/proto/node_modules" "$r/proto/node_modules"
  printf 'node_modules\n' >"$r/.gitignore"
  git -C "$r" init -q
  git -C "$r" config user.email t@example.com
  git -C "$r" config user.name Test
  git -C "$r" add -A
  git -C "$r" commit -qm base
  printf '%s' "$r"
}
run() { "$GATE" "$1" >/dev/null 2>&1; printf '%s' "$?"; }

r="$(fixture notag)"
check "no tag with proto/ skips" 0 "$(run "$r")"

r="$(fixture clean)"; git -C "$r" tag v1.0.0
check "unchanged admin wire passes" 0 "$(run "$r")"

r="$(fixture compatible)"; git -C "$r" tag v1.0.0
sed -i.bak 's/uint32 sessions_stopped = 1;/uint32 sessions_stopped = 1; string note = 2;/' "$r/proto/alinery/v1/admin.proto" && rm "$r/proto/alinery/v1/admin.proto.bak"
check "an added field passes" 0 "$(run "$r")"

r="$(fixture admin-break)"; git -C "$r" tag v1.0.0
sed -i.bak 's/string build_id = 2;/string build_id = 7;/' "$r/proto/alinery/v1/admin.proto" && rm "$r/proto/alinery/v1/admin.proto.bak"
check "a renumbered admin field fails" 1 "$(run "$r")"

r="$(fixture common-break)"; git -C "$r" tag v1.0.0
sed -i.bak 's/uint64 seq = 2;/uint64 seq = 3;/' "$r/proto/alinery/v1/common.proto" && rm "$r/proto/alinery/v1/common.proto.bak"
check "a renumbered common field fails" 1 "$(run "$r")"

# A later session adds a proto and may break it freely: only admin and common are frozen.
r="$(fixture other)"
printf 'syntax = "proto3";\npackage alinery.v1;\nmessage Other { string a = 1; }\n' >"$r/proto/alinery/v1/other.proto"
git -C "$r" add -A && git -C "$r" commit -qm other && git -C "$r" tag v1.0.0
sed -i.bak 's/string a = 1;/string a = 9;/' "$r/proto/alinery/v1/other.proto" && rm "$r/proto/alinery/v1/other.proto.bak"
check "a break in another proto passes" 0 "$(run "$r")"

[ "$fails" -eq 0 ] || exit 1
echo "OK: admin wire gate behaves"
