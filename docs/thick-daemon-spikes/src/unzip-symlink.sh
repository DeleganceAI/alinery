#!/bin/sh
# S4.9 spike (docs/thick-daemon-plan.md): can an Info-ZIP archive with a symlink entry make `unzip` write
# outside the extraction dir, and does `unzip -Z` show symlink entries so a restore can refuse them?
#
#   sh src/unzip-symlink.sh <scratch-dir>
#
# Builds, with `zip -y` (store symlinks as links):
#   abs.zip  link -> <scratch>/outside-abs (absolute), then link/evil.txt
#   rel.zip  link -> ../outside-rel (relative),        then link/evil.txt
#   dot.zip  a regular entry ../dotdot.txt (name traversal, for contrast)
#   pre.zip  a regular entry link/evil.txt, extracted into a target that already holds link -> ../outside-pre
# then extracts each with `unzip -q -o x.zip -d target`, and again with `-:`, into fresh dirs,
# and reports what landed outside target. Nothing is written outside <scratch-dir> except where
# unzip itself escapes (the escapes point into <scratch-dir> too).
set -u
S=${1:?usage: unzip-symlink.sh <scratch-dir>}
S="$S/unzip-symlink"
rm -rf "$S" && mkdir -p "$S" && S=$(cd "$S" && pwd -P)

echo "== $(uname -sm)"
zip -v 2>/dev/null | sed -n 2p
unzip -v 2>/dev/null | sed -n 1p

# Each archive is built in two steps so the symlink entry precedes the entry written through it.
build() { # $1 name, $2 link target
  b="$S/build-$1"
  mkdir -p "$b"
  (cd "$b" && ln -s "$2" link && zip -q -y "$S/$1.zip" link && rm link &&
    mkdir link && echo "evil $1" > link/evil.txt && zip -q -y "$S/$1.zip" link/evil.txt)
}
build abs "$S/outside-abs"
build rel "../outside-rel"
mkdir -p "$S/build-dot/a" && (cd "$S/build-dot/a" && echo dotdot > ../dotdot.txt && zip -q "$S/dot.zip" ../dotdot.txt)
# pre.zip: only a regular link/evil.txt. Extracted into a target that already holds link -> ../outside-pre,
# as a restore onto an existing .alinery would if something had planted a link there; no -Z check sees it.
mkdir -p "$S/build-pre/link" && (cd "$S/build-pre" && echo "evil pre" > link/evil.txt && zip -q "$S/pre.zip" link/evil.txt)

for z in abs rel dot pre; do
  echo
  echo "== $z.zip: unzip -Z"
  unzip -Z "$S/$z.zip"
  echo "== $z.zip: unzip -Z1"
  unzip -Z1 "$S/$z.zip"
  echo "== $z.zip: symlink entries by mode column (unzip -Z | grep '^l')"
  unzip -Z "$S/$z.zip" | grep '^l' || echo "(none)"
  for flags in "" "-:"; do
    run="$S/run-$z${flags:+-colon}"
    mkdir -p "$run/target"
    # Recreate the escape targets so a write through the link has somewhere to land.
    mkdir -p "$S/outside-abs" "$run/outside-rel"
    rm -f "$S/outside-abs/evil.txt" "$S/dotdot.txt" "$run/dotdot.txt"
    [ $z = pre ] && mkdir -p "$run/outside-pre" && ln -s ../outside-pre "$run/target/link"
    echo "-- unzip -q -o $flags $z.zip -d target  (cwd $run)"
    (cd "$run" && unzip -q -o $flags "$S/$z.zip" -d target; echo "   exit $?")
    echo "   inside target:"
    (cd "$run/target" && find . -mindepth 1 -exec ls -ld {} \; | sed 's/^/     /')
    echo "   outside target:"
    found=0
    for f in "$S/outside-abs/evil.txt" "$run/outside-rel/evil.txt" "$run/dotdot.txt" "$S/dotdot.txt" "$run/outside-pre/evil.txt"; do
      if [ -e "$f" ]; then echo "     ESCAPED: $f ($(cat "$f"))"; found=1; fi
    done
    [ $found = 0 ] && echo "     nothing"
  done
done
