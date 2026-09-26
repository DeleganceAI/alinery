#!/usr/bin/env bash
# Probe and place for the bundled Git tree. No tarball download, no compile.
#
# Run: ./scripts/tests/git_lib_test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$ROOT/scripts/lib/git.sh"
PIN="$ROOT/scripts/git-pin.txt"
SHA="$ROOT/scripts/git-pin.sha256"

fails=0
check() {
  local what="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    echo "ok   - $what"
  else
    echo "FAIL - $what"
    echo "         want: [$want]"
    echo "         got:  [$got]"
    fails=$((fails + 1))
  fi
}
check_nonzero() {
  local what="$1" rc="$2"
  if [ "$rc" -ne 0 ]; then
    echo "ok   - $what"
  else
    echo "FAIL - $what"
    echo "         want: non-zero exit"
    echo "         got:  0"
    fails=$((fails + 1))
  fi
}

[ -f "$LIB" ] || { echo "ERROR: cannot find $LIB" >&2; exit 1; }
# shellcheck source=../lib/git.sh
. "$LIB"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/alinery-git-lib-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

check "git pin file exists" "1" "$([ -s "$PIN" ] && echo 1 || echo 0)"
check "git pin sha256 file exists" "1" "$([ -s "$SHA" ] && echo 1 || echo 0)"
pin="$(git_pin_version)"
sum="$(git_pin_sha256)"
check "pin is non-empty" "1" "$([ -n "$pin" ] && echo 1 || echo 0)"
check "sha256 is 64 hex chars" "1" "$(printf '%s' "$sum" | grep -cE '^[0-9a-f]{64}$')"

check "darwin dest is the app sibling" "/Applications/Alinery.git" \
  "$(git_dest_dir Darwin /Applications/Alinery.app)"
check "darwin dest follows a custom --dir" "/tmp/apps/Alinery.git" \
  "$(git_dest_dir Darwin /tmp/apps/Alinery.app)"
check "linux dest is the prefix sibling" "/home/u/.local/share/alinery/git" \
  "$(git_dest_dir Linux /home/u/.local/share/alinery/Alinery)"

fixture() {
  local dir="$1" body="$2"
  mkdir -p "$dir/bin"
  printf '%s\n' '#!/bin/sh' "$body" >"$dir/bin/git"
  chmod +x "$dir/bin/git"
}

# Stub: /usr/bin/git is present on a Mac with no developer dir, and it must not count.
if [ "$(uname -s)" = Darwin ]; then
  GIT_DEVELOPER_DIR_PRESENT=0
  if git_app_visible; then
    rc=0
  else
    rc=1
  fi
  check_nonzero "macOS stub is not a visible git" "$rc"
  GIT_DEVELOPER_DIR_PRESENT=1
  if git_app_visible; then
    rc=0
  else
    rc=1
  fi
  check "developer dir makes /usr/bin/git visible" "0" "$rc"
  unset GIT_DEVELOPER_DIR_PRESENT
fi

empty="$TMP/empty-path"
mkdir -p "$empty"
GIT_APP_SEARCH_PATH="$empty"
if git_app_visible; then rc=0; else rc=1; fi
check_nonzero "empty search path is not visible" "$rc"

have="$TMP/have-path"
mkdir -p "$have"
printf '%s\n' '#!/bin/sh' 'exit 0' >"$have/git"
chmod +x "$have/git"
GIT_APP_SEARCH_PATH="$have"
if git_app_visible; then rc=0; else rc=1; fi
check "executable git on the app search path is visible" "0" "$rc"
unset GIT_APP_SEARCH_PATH

src="$TMP/src-git"
fixture "$src" 'echo "git version fixture"; exit 0'
dest="$TMP/Alinery.git"
GIT_APP_SEARCH_PATH="$empty"
git_install_or_remove "$src" "$dest"
rc=$?
check "install places the tree when no git is visible" "0" "$rc"
check "placed git answers --version" "git version fixture" "$("$dest/bin/git" --version)"

marker="$TMP/old-alongside"
mkdir -p "$marker"
echo stale >"$marker/marker"
GIT_APP_SEARCH_PATH="$have"
git_install_or_remove "$src" "$marker"
rc=$?
check "install removes an old alongside tree when git is visible" "0" "$rc"
check "visible git leaves no alongside directory" "0" "$([ -e "$marker" ] && echo 1 || echo 0)"
unset GIT_APP_SEARCH_PATH

missing="$TMP/missing-src"
rc=0
git_install_or_remove "$missing" "$TMP/should-not-exist" >/dev/null 2>"$TMP/missing.err" || rc=$?
check_nonzero "missing archive git/bin/git dies" "$rc"
check "missing archive does not create dest" "0" "$([ -e "$TMP/should-not-exist" ] && echo 1 || echo 0)"

# Release scripts live in the sibling deploy repo when the checkouts are neighbors.
for pair in \
  "build-macos.sh:build_pinned_git" \
  "build-linux.sh:build_pinned_git"; do
  name="${pair%%:*}"
  needle="${pair#*:}"
  found=""
  for candidate in \
    "$ROOT/scripts/release/$name" \
    "$ROOT/../alinery-deploy/scripts/release/$name"; do
    if [ -f "$candidate" ]; then
      found="$candidate"
      break
    fi
  done
  if [ -z "$found" ]; then
    echo "ok   - $name not beside this checkout (skipped)"
    continue
  fi
  if grep -q "$needle" "$found"; then
    echo "ok   - $name calls $needle"
  else
    echo "FAIL - $name calls $needle"
    fails=$((fails + 1))
  fi
done

if [ "$fails" -ne 0 ]; then
  echo "FAILED: $fails git lib check(s)" >&2
  exit 1
fi
echo "OK: git lib"
