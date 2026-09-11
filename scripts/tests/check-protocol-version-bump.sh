#!/usr/bin/env bash
# Fails when a diff touches the alineryd wire-protocol surface without bumping
# `PROTOCOL_VERSION` (alinery-app/src-tauri/alinery-core/src/protocol.rs).
#
# The protocol version is the only thing standing between a release and every user's live
# sessions: a hand-bumped constant that nobody bumps is worse than no gate at all, because
# an incompatible daemon then looks compatible and the app talks nonsense to it.
#
# Modelled on scripts/homebrew/check-version-sync.sh; run from scripts/release.sh.
#
# Usage: ./scripts/tests/check-protocol-version-bump.sh [<base-ref>]     (default: origin/HEAD..HEAD)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

BASE="${1:-}"
if [ -z "$BASE" ]; then
  BASE="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || echo "")"
  [ -n "$BASE" ] || BASE="$(git describe --tags --abbrev=0 2>/dev/null || echo "")"
  [ -n "$BASE" ] || { echo "OK: no base ref to compare against (first release?)"; exit 0; }
fi
git rev-parse --verify "$BASE" >/dev/null 2>&1 || { echo "ERROR: unknown ref $BASE" >&2; exit 1; }

CONST_FILE="alinery-app/src-tauri/alinery-core/src/protocol.rs"

# Files whose contents define or consume the wire format. Touching any of them can change
# what the daemon accepts or replies with.
SURFACE=(
  "alinery-app/src-tauri/alineryd/src/main.rs"
  "$CONST_FILE"
  # Shared app/MCP wire client (ops / version classify). Keep this out of app lib.rs so
  # the gate is not drowned in unrelated UI/FS noise.
  "alinery-app/src-tauri/alinery-core/src/daemon_client.rs"
)

# `A...B` for `git diff` is the merge-base diff; the equivalent commit set is
# `$(git merge-base A B)..B`. Compute it rather than reusing `...`, which to `git log`
# means the symmetric difference and would drag in commits only on the base side.
MERGE_BASE="$(git merge-base "$BASE" HEAD 2>/dev/null || echo "$BASE")"

touched="$(git diff --name-only "$MERGE_BASE" HEAD -- "${SURFACE[@]}")"
if [ -z "$touched" ]; then
  echo "OK: wire protocol surface untouched since $BASE"
  exit 0
fi

current="$(sed -n 's/^pub const PROTOCOL_VERSION: u32 = \([0-9]*\);.*/\1/p' "$CONST_FILE")"
[ -n "$current" ] || { echo "ERROR: cannot read PROTOCOL_VERSION from $CONST_FILE" >&2; exit 1; }
# The const file may not exist at $BASE (first release carrying the gate) — `git show`
# exits 128 there, which under `set -euo pipefail` would abort instead of reporting.
previous="$({ git show "$BASE:$CONST_FILE" 2>/dev/null || true; } |
  sed -n 's/^pub const PROTOCOL_VERSION: u32 = \([0-9]*\);.*/\1/p')"
# Directory rename (saga-app -> alinery-app) and crate rename (saga-core ->
# alinery-core) must not look like the const was introduced. Fall back to the
# pre-rebrand paths at $BASE.
if [ -z "$previous" ]; then
  previous="$({ git show "$BASE:saga-app/src-tauri/alinery-core/src/protocol.rs" 2>/dev/null || true; } |
    sed -n 's/^pub const PROTOCOL_VERSION: u32 = \([0-9]*\);.*/\1/p')"
fi
if [ -z "$previous" ]; then
  previous="$({ git show "$BASE:saga-app/src-tauri/saga-core/src/protocol.rs" 2>/dev/null || true; } |
    sed -n 's/^pub const PROTOCOL_VERSION: u32 = \([0-9]*\);.*/\1/p')"
fi

# A bump is RANGE-scoped, and legitimately so: the version is cumulative state, not a claim
# about one commit. If the number shipping at HEAD differs from the one at $BASE, then every
# wire change in between is announced by it, whichever commit did the incrementing.
if [ -z "$previous" ]; then
  echo "OK: PROTOCOL_VERSION introduced in this range ($current)"
  exit 0
fi
if [ "$current" != "$previous" ]; then
  echo "OK: PROTOCOL_VERSION bumped $previous → $current"
  exit 0
fi

# The trailer is COMMIT-scoped, and that asymmetry is the point.
#
# Escape hatch, and deliberately a narrow one. Most edits to these files are refactors,
# comments and pty plumbing that leave the op-set alone — demanding a bump for those would
# train everyone to bump reflexively, which is exactly how a real wire change slips
# through. So a surface-touching commit may declare *itself* protocol-neutral:
#
#   Protocol-Neutral: moved request construction into daemon_client.rs, no op changed
#
# It is a claim by a human, recorded in history and visible in review, rather than a verdict
# this script can compute — which is precisely why it may not be spent twice. Searching the
# whole range for any one trailer (what this did before) let a single old note, written in
# good faith about a refactor, silently pre-authorise every later edit to these files,
# including a breaking one. Each non-merge commit answers for its own diff. A merge answers
# through those contributing commits when its protected surface matches Git's automatic
# merge, even if unrelated files needed conflict resolution; GitHub does not copy commit
# trailers into its generated merge message. A merge that manually changes the protected
# surface must answer for its own resolution. Empty reasons never count.
#
# Commits already on the target branch are the target branch's responsibility. A feature
# branch can merge those public commits but cannot amend them. Audit only commits that are
# not already reachable from origin/HEAD.
neutral_reason() {
  git log -1 --format='%B' "$1" |
    sed -n 's/^Protocol-Neutral:[[:space:]]*\(.\{1,\}\)$/\1/p' |
    sed -n '1p'
}
merge_preserves_automatic_surface() {
  local sha="$1"
  local -a parents
  local output automatic_tree
  read -r -a parents <<<"$(git rev-list --parents -n 1 "$sha")"
  [ "${#parents[@]}" -eq 3 ] || return 1
  output="$(git merge-tree --write-tree "${parents[1]}" "${parents[2]}" 2>/dev/null || true)"
  automatic_tree="$(printf '%s\n' "$output" | sed -n '1p')"
  [ -n "$automatic_tree" ] || return 1
  git cat-file -e "$automatic_tree^{tree}" 2>/dev/null || return 1
  git diff --quiet "$automatic_tree" "$sha^{tree}" -- "${SURFACE[@]}"
}

target_base="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo "")"
if [ -n "$target_base" ] && git rev-parse --verify "$target_base" >/dev/null 2>&1; then
  surface_commits="$(git log --full-history --no-merges --format='%H' "$MERGE_BASE"..HEAD --not "$target_base" -- "${SURFACE[@]}")"
  surface_merges="$(git log --full-history --merges --format='%H' "$MERGE_BASE"..HEAD --not "$target_base" -- "${SURFACE[@]}")"
else
  surface_commits="$(git log --full-history --no-merges --format='%H' "$MERGE_BASE"..HEAD -- "${SURFACE[@]}")"
  surface_merges="$(git log --full-history --merges --format='%H' "$MERGE_BASE"..HEAD -- "${SURFACE[@]}")"
fi
if [ -z "$surface_commits" ] && [ -z "$surface_merges" ]; then
  echo "OK: wire protocol surface changes are already on $target_base"
  exit 0
fi

unaccounted=()
accounted=()
while read -r sha; do
  [ -n "$sha" ] || continue
  reason="$(neutral_reason "$sha")"
  if [ -n "$reason" ]; then
    accounted+=("$(git log -1 --format='%h %s' "$sha") — $reason")
  else
    unaccounted+=("$(git log -1 --format='%h %s' "$sha")")
  fi
done <<EOF
$surface_commits
EOF

while read -r sha; do
  [ -n "$sha" ] || continue
  reason="$(neutral_reason "$sha")"
  if [ -n "$reason" ]; then
    accounted+=("$(git log -1 --format='%h %s' "$sha") — $reason")
  elif merge_preserves_automatic_surface "$sha"; then
    accounted+=("$(git log -1 --format='%h %s' "$sha") — protected surface matches automatic merge; contributing commits checked individually")
  else
    unaccounted+=("$(git log -1 --format='%h %s' "$sha")")
  fi
done <<EOF
$surface_merges
EOF

if [ ${#unaccounted[@]} -eq 0 ]; then
  echo "OK: surface touched, every commit declared protocol-neutral"
  printf '    %s\n' "${accounted[@]}"
  exit 0
fi

cat >&2 <<EOF
ERROR: the daemon wire-protocol surface changed since $BASE, PROTOCOL_VERSION is still
$previous, and these commits do not declare themselves neutral:

$(printf '  %s\n' "${unaccounted[@]}")

Touched across the range:
$(echo "$touched" | sed 's/^/  /')

If the op-set or wire format changed, bump PROTOCOL_VERSION in $CONST_FILE — every user
with live sessions will have to stop them deliberately before installing. One bump covers
the whole release.

If the change is protocol-neutral (comments, internal refactor, pty plumbing), add a
trailer to each commit listed above — \`git commit --amend\` or \`git rebase\` — and re-run:

  Protocol-Neutral: <why the wire is unchanged>

A trailer on some *other* commit does not count. That was the hole: one note authorising
every later edit in the range, including the one that actually broke the wire.
EOF
exit 1
