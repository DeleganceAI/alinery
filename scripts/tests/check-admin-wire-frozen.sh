#!/usr/bin/env bash
# O23: Hello, Shutdown and the messages they use (admin.proto, common.proto) are frozen once
# released, so an old app can always ask any daemon what it is. This runs `buf breaking` on those
# two files only, against the last release tag that has a proto/ directory. The scope is on the
# command line because buf.yaml has no "only these files" setting for breaking, only `ignore`.
#
# buf exits 100 on a real break, which fails here. It exits 1 with "no .proto files were targeted"
# when the ref has nothing to compare (no tag has proto/ yet), which skips.
#
# Usage: check-admin-wire-frozen.sh [repo-root]     (default: this repository)
set -uo pipefail
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
BUF="$ROOT/proto/node_modules/.bin/buf"
[ -x "$BUF" ] || {
  echo "FAIL - proto tools are not installed; run: npm --prefix proto ci" >&2
  exit 1
}

tag=""
for t in $(git -C "$ROOT" tag --sort=-v:refname); do
  if git -C "$ROOT" cat-file -e "$t:proto/buf.yaml" 2>/dev/null; then
    tag="$t"
    break
  fi
done
[ -n "$tag" ] || {
  echo "skip - no release tag has proto/ yet, nothing to compare the admin wire against"
  exit 0
}

out="$(cd "$ROOT/proto" && "$BUF" breaking --against "$ROOT/.git#ref=$tag,subdir=proto" \
  --path alinery/v1/admin.proto --path alinery/v1/common.proto 2>&1)"
rc=$?
case "$rc" in
  0) echo "ok   - admin.proto and common.proto are compatible with $tag" ;;
  100)
    echo "FAIL - the frozen admin wire changed since $tag:" >&2
    printf '%s\n' "$out" >&2
    exit 1
    ;;
  *)
    if printf '%s' "$out" | grep -q "no .proto files were targeted"; then
      echo "skip - $tag has no admin.proto or common.proto to compare"
    else
      echo "FAIL - buf breaking exited $rc:" >&2
      printf '%s\n' "$out" >&2
      exit 1
    fi
    ;;
esac
