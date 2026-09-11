#!/usr/bin/env bash
# Does check-protocol-version-bump.sh actually catch an app-side wire change?
#
# Review finding 5: the guard watched only `alineryd/src/main.rs` + `protocol.rs`, so a
# rename confined to the app's client changed the wire and passed. Adding a file to
# SURFACE is not evidence the gate works — this suite builds synthetic repos and proves
# the verdict, one case per branch. The fixtures are throwaway git repos in a temp dir;
# nothing here touches the real working tree.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$ROOT/scripts/tests/check-protocol-version-bump.sh"
fails=0

check() { # label expected actual
  if [ "$2" = "$3" ]; then
    echo "ok   - $1"
  else
    echo "FAIL - $1"
    echo "         expected: [$2]"
    echo "         actual:   [$3]"
    fails=$((fails + 1))
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CONST_REL="alinery-app/src-tauri/alinery-core/src/protocol.rs"
CLIENT_REL="alinery-app/src-tauri/alinery-core/src/daemon_client.rs"
DAEMON_REL="alinery-app/src-tauri/alineryd/src/main.rs"

# A minimal repo with the real SURFACE layout and a copy of the gate at the real path,
# so the script's own `cd "$(dirname $0)/../.."` lands on the fixture.
new_fixture() { # name -> echoes repo path, leaves a committed baseline at tag "base"
  local repo="$TMP/$1"
  mkdir -p "$repo/scripts/tests" "$repo/$(dirname "$CONST_REL")" \
    "$repo/$(dirname "$CLIENT_REL")" "$repo/$(dirname "$DAEMON_REL")"
  cp "$GATE" "$repo/scripts/tests/"
  printf 'pub const PROTOCOL_VERSION: u32 = 1;\n' >"$repo/$CONST_REL"
  # Requests AND reply parsing: both halves of the contract live in this file, so the
  # fixture carries one of each and the cases below can vary them independently.
  {
    printf 'pub const WRITE: &str = "write";\n'
    printf 'pub fn parse_status_reply(v: &Value) -> String { v["status"].to_string() }\n'
  } >"$repo/$CLIENT_REL"
  printf 'fn main() {}\n' >"$repo/$DAEMON_REL"
  git -C "$repo" init -q
  git -C "$repo" config user.email t@example.com
  git -C "$repo" config user.name Test
  git -C "$repo" add -A
  git -C "$repo" commit -qm baseline
  git -C "$repo" tag base
  printf '%s' "$repo"
}

run_gate() { # repo -> echoes rc
  local rc=0
  (cd "$1" && ./scripts/tests/check-protocol-version-bump.sh base >/dev/null 2>&1) || rc=$?
  printf '%s' "$rc"
}

# --- 1. THE finding: an app-side wire change with the server untouched -------------------
# Renaming the op the app sends breaks compatibility just as thoroughly as renaming the op
# the daemon accepts. Before daemon_client.rs joined SURFACE this returned 0.
repo="$(new_fixture app-wire-change)"
printf 'pub const WRITE: &str = "write_v2";\n' >"$repo/$CLIENT_REL"
git -C "$repo" commit -qam "rename the app-side write op"
check "an app-side wire change without a bump FAILS the gate" "1" "$(run_gate "$repo")"

# --- 2. same change, with the bump -------------------------------------------------------
printf 'pub const PROTOCOL_VERSION: u32 = 2;\n' >"$repo/$CONST_REL"
git -C "$repo" commit -qam "bump PROTOCOL_VERSION for the rename"
check "…and passes once PROTOCOL_VERSION is bumped" "0" "$(run_gate "$repo")"

# --- 3. the daemon side is still guarded -------------------------------------------------
repo="$(new_fixture daemon-wire-change)"
printf 'fn main() { let _ = "resize_v2"; }\n' >"$repo/$DAEMON_REL"
git -C "$repo" commit -qam "change the daemon wire"
check "a daemon-side change without a bump FAILS the gate" "1" "$(run_gate "$repo")"

# --- 4. untouched surface is silent ------------------------------------------------------
repo="$(new_fixture untouched)"
mkdir -p "$repo/alinery-app/src"
printf 'body { color: red }\n' >"$repo/alinery-app/src/app.css"
git -C "$repo" add -A
git -C "$repo" commit -qm "unrelated UI change"
check "a change outside the surface passes" "0" "$(run_gate "$repo")"

# --- 5. the Protocol-Neutral trailer -----------------------------------------------------
# The escape hatch has to work, or every refactor becomes a reflexive bump — which is how
# a real wire change slips through unnoticed.
repo="$(new_fixture neutral-trailer)"
printf 'pub const WRITE: &str = "write"; // moved here from lib.rs\n' >"$repo/$CLIENT_REL"
git -C "$repo" commit -qam "refactor: move request construction

Protocol-Neutral: pure move, no op name or field changed"
check "a declared protocol-neutral surface change passes" "0" "$(run_gate "$repo")"

# …but only when it actually says something. A bare trailer is not a reason.
repo="$(new_fixture empty-trailer)"
printf 'pub const WRITE: &str = "write_v3";\n' >"$repo/$CLIENT_REL"
git -C "$repo" commit -qam "sneaky

Protocol-Neutral:"
check "an empty Protocol-Neutral trailer does NOT pass" "1" "$(run_gate "$repo")"

# --- 6. one trailer must not launder a later breaking commit -------------------------------
# Re-review finding 4, reproduced. The gate used to grep the whole range for any trailer and
# exit 0 on the first hit, so an honest "this refactor is neutral" note became a standing
# permit: every later edit to these files in the same release rode in on it. The trailer is
# a claim about one diff, so it may only answer for one commit.
repo="$(new_fixture trailer-masking)"
printf 'pub const WRITE: &str = "write"; // moved here from lib.rs\n' >"$repo/$CLIENT_REL"
git -C "$repo" commit -qam "refactor: move request construction

Protocol-Neutral: pure move, no op name or field changed"
check "…the neutral commit alone still passes" "0" "$(run_gate "$repo")"

printf 'pub const WRITE: &str = "write_v2";\n' >"$repo/$CLIENT_REL"
git -C "$repo" commit -qam "rename the write op"   # no trailer, no bump
check "a later breaking commit does NOT inherit an earlier neutral trailer" "1" "$(run_gate "$repo")"

# The bump is what covers a range, and it does so wherever in the range it lands — the
# version shipping at HEAD is cumulative state, not a claim about one commit. Without this
# the honest "change it, then bump it" sequence would be unfixable except by rewriting.
printf 'pub const PROTOCOL_VERSION: u32 = 2;\n' >"$repo/$CONST_REL"
git -C "$repo" commit -qam "bump PROTOCOL_VERSION for the rename"
check "…and a bump in a later commit does cover the whole range" "0" "$(run_gate "$repo")"

# --- 7. reply parsing is guarded, not just request building --------------------------------
# Re-review finding 5. The gate covered the requests the app *sends* while the fields it
# *expects back* were still read in lib.rs — so renaming the status field from "status" to
# "state" broke the app against an unchanged daemon and the guard stayed green. Reproduced
# with the old layout. Both halves of the contract now live in daemon_client.rs.
repo="$(new_fixture reply-parsing)"
printf 'pub const WRITE: &str = "write";\n' >"$repo/$CLIENT_REL"
printf 'pub fn parse_status_reply(v: &Value) -> String { v["state"].to_string() }\n' \
  >>"$repo/$CLIENT_REL"
git -C "$repo" commit -qam "read the status reply from a different field"
check "changing an app-side REPLY field expectation FAILS the gate" "1" "$(run_gate "$repo")"

# --- 8. every surface commit declaring itself neutral is still fine ------------------------
repo="$(new_fixture all-neutral)"
printf 'pub const WRITE: &str = "write"; // comment one\n' >"$repo/$CLIENT_REL"
git -C "$repo" commit -qam "docs: comment the write op

Protocol-Neutral: comment only"
printf 'fn main() { /* comment two */ }\n' >"$repo/$DAEMON_REL"
git -C "$repo" commit -qam "docs: comment the daemon entrypoint

Protocol-Neutral: comment only"
check "several separately-declared neutral commits pass" "0" "$(run_gate "$repo")"

# --- 9. target-branch commits are not re-audited on every feature branch ------------------
# GitHub creates merge commits after the PR gate runs. A feature branch can merge that
# public target history but cannot amend it to add a commit-scoped trailer. Exclude commits
# already reachable from origin/HEAD while continuing to audit feature-exclusive changes.
repo="$(new_fixture target-history)"
git -C "$repo" switch -qc target
printf 'fn main() { let _ = "target-internal-change"; }\n' >"$repo/$DAEMON_REL"
git -C "$repo" commit -qam "GitHub target merge without trailer"
git -C "$repo" update-ref refs/remotes/origin/target HEAD
git -C "$repo" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/target
git -C "$repo" switch -qc feature
mkdir -p "$repo/alinery-app/src"
printf 'body { color: blue }\n' >"$repo/alinery-app/src/app.css"
git -C "$repo" add -A
git -C "$repo" commit -qm "feature UI change"
check "target-branch surface commits are not re-audited on a feature branch" "0" "$(run_gate "$repo")"

printf 'pub const WRITE: &str = "write_feature";\n' >"$repo/$CLIENT_REL"
git -C "$repo" commit -qam "feature wire change without trailer"
check "feature-exclusive wire changes still FAIL with target exclusion" "1" "$(run_gate "$repo")"

# --- 10. crate rename must not look like PROTOCOL_VERSION was introduced ---------
# Base has saga-core/protocol.rs = 1; HEAD has alinery-core/protocol.rs = 1 plus a
# surface edit. Without the fallback the gate treats the const as new and passes.
repo="$TMP/crate-rename"
legacy="saga-app/src-tauri/saga-core/src/protocol.rs"
mkdir -p "$repo/scripts/tests" "$repo/$(dirname "$legacy")" \
  "$repo/$(dirname "$CLIENT_REL")" "$repo/$(dirname "$DAEMON_REL")"
cp "$GATE" "$repo/scripts/tests/"
printf 'pub const PROTOCOL_VERSION: u32 = 1;\n' >"$repo/$legacy"
{
  printf 'pub const WRITE: &str = "write";\n'
  printf 'pub fn parse_status_reply(v: &Value) -> String { v["status"].to_string() }\n'
} >"$repo/$CLIENT_REL"
printf 'fn main() {}\n' >"$repo/$DAEMON_REL"
git -C "$repo" init -q
git -C "$repo" config user.email t@example.com
git -C "$repo" config user.name Test
git -C "$repo" add -A
git -C "$repo" commit -qm baseline
git -C "$repo" tag base
mkdir -p "$repo/$(dirname "$CONST_REL")"
printf 'pub const PROTOCOL_VERSION: u32 = 1;\n' >"$repo/$CONST_REL"
rm -f "$repo/$legacy"
printf 'fn main() { let _ = "renamed"; }\n' >"$repo/$DAEMON_REL"
git -C "$repo" add -A
git -C "$repo" commit -qm "rename saga-core to alinery-core"
check "a crate rename without a bump does not short-circuit as introduced" "1" "$(run_gate "$repo")"


# --- 10. GitHub merge commits inherit only verified constituent neutrality -----------------
# GitHub's generated merge message does not copy trailers from the reviewed commits. A clean
# merge is safe to account through the surface-touching commits it brings in, but an
# unaccounted constituent or a manual conflict resolution must still fail.
repo="$(new_fixture neutral-github-merge)"
base_branch="$(git -C "$repo" branch --show-current)"
git -C "$repo" checkout -qb neutral-side
printf 'fn main() { /* persisted metadata only */ }\n' >"$repo/$DAEMON_REL"
git -C "$repo" commit -qam "persist a status revision

Protocol-Neutral: persisted metadata only; daemon operations and replies are unchanged"
git -C "$repo" checkout -q "$base_branch"
mkdir -p "$repo/alinery-app/src"
printf 'body { color: blue }\n' >"$repo/alinery-app/src/app.css"
git -C "$repo" add -A
git -C "$repo" commit -qm "update unrelated UI"
git -C "$repo" merge --no-ff -qm "Merge pull request #1 from example/neutral-side" neutral-side
check "a clean GitHub merge honors its constituent neutral trailer" "0" "$(run_gate "$repo")"

repo="$(new_fixture unrelated-conflict-merge)"
base_branch="$(git -C "$repo" branch --show-current)"
mkdir -p "$repo/alinery-app/src"
printf 'base\n' >"$repo/alinery-app/src/app.ts"
git -C "$repo" add -A
git -C "$repo" commit -qm "add shared UI fixture"
git -C "$repo" checkout -qb neutral-conflict-side
printf 'fn main() { /* persisted metadata only */ }\n' >"$repo/$DAEMON_REL"
printf 'side\n' >"$repo/alinery-app/src/app.ts"
git -C "$repo" commit -qam "persist metadata and update UI

Protocol-Neutral: persisted metadata only; daemon operations and replies are unchanged"
git -C "$repo" checkout -q "$base_branch"
printf 'main\n' >"$repo/alinery-app/src/app.ts"
git -C "$repo" commit -qam "update the same UI fixture"
git -C "$repo" merge --no-ff -m "Merge pull request #2 from example/neutral-conflict-side" neutral-conflict-side >/dev/null 2>&1 || true
printf 'combined\n' >"$repo/alinery-app/src/app.ts"
git -C "$repo" add alinery-app/src/app.ts
git -C "$repo" commit -qm "Resolve unrelated UI merge"
check "an unrelated conflict does not require a protocol trailer on the merge" "0" "$(run_gate "$repo")"

repo="$(new_fixture unaccounted-github-merge)"
base_branch="$(git -C "$repo" branch --show-current)"
git -C "$repo" checkout -qb unaccounted-side
printf 'fn main() { let _ = "resize_v2"; }\n' >"$repo/$DAEMON_REL"
git -C "$repo" commit -qam "change daemon wire without a declaration"
git -C "$repo" checkout -q "$base_branch"
mkdir -p "$repo/alinery-app/src"
printf 'body { color: blue }\n' >"$repo/alinery-app/src/app.css"
git -C "$repo" add -A
git -C "$repo" commit -qm "update unrelated UI"
git -C "$repo" merge --no-ff -qm "Merge pull request #2 from example/unaccounted-side" unaccounted-side
check "a clean merge does not hide an unaccounted constituent" "1" "$(run_gate "$repo")"

repo="$(new_fixture conflicted-merge)"
base_branch="$(git -C "$repo" branch --show-current)"
git -C "$repo" checkout -qb conflict-side
printf 'fn main() { /* side refactor */ }\n' >"$repo/$DAEMON_REL"
git -C "$repo" commit -qam "refactor daemon side

Protocol-Neutral: comment-only side refactor"
git -C "$repo" checkout -q "$base_branch"
printf 'fn main() { /* main refactor */ }\n' >"$repo/$DAEMON_REL"
git -C "$repo" commit -qam "refactor daemon main

Protocol-Neutral: comment-only main refactor"
git -C "$repo" merge --no-ff -m "Merge pull request #3 from example/conflict-side" conflict-side >/dev/null 2>&1 || true
printf 'fn main() { let _ = "resize_v2"; }\n' >"$repo/$DAEMON_REL"
git -C "$repo" add "$DAEMON_REL"
git -C "$repo" commit -qm "Resolve daemon merge"
check "a conflicted merge resolution needs its own declaration" "1" "$(run_gate "$repo")"
git -C "$repo" commit --amend -qm "Resolve daemon merge

Protocol-Neutral: resolution preserves the existing daemon operations and replies"
check "a conflicted merge passes after declaring its resolution neutral" "0" "$(run_gate "$repo")"
if [ "$fails" -ne 0 ]; then
  echo "FAILED: $fails check(s)"
  exit 1
fi
echo "OK: protocol version gate"
