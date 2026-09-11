#!/usr/bin/env bash
# Unit + source-contract tests for alongside-OMP install placement.
#
# Network-free. Does not run the real installer (no CDN, no preflight prompt).
# Formula lives in scripts/lib/omp.sh; install.sh / install-local.sh must call it.
#
# Run: ./scripts/tests/install_omp_place_test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$ROOT/scripts/lib/omp.sh"
INSTALL="$ROOT/scripts/install.sh"
INSTALL_LOCAL=""

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
contains() {
  local what="$1" needle="$2" hay="$3"
  case "$hay" in
    *"$needle"*) echo "ok   - $what" ;;
    *)
      echo "FAIL - $what"
      echo "         expected to contain: [$needle]"
      echo "         got: [$hay]"
      fails=$((fails + 1))
      ;;
  esac
}
not_contains() {
  local what="$1" needle="$2" hay="$3"
  case "$hay" in
    *"$needle"*)
      echo "FAIL - $what"
      echo "         expected NOT to contain: [$needle]"
      echo "         got: [$hay]"
      fails=$((fails + 1))
      ;;
    *) echo "ok   - $what" ;;
  esac
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

if [ ! -f "$LIB" ]; then
  echo "ERROR: cannot find $LIB" >&2
  exit 1
fi
# shellcheck source=../lib/omp.sh
. "$LIB"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/alinery-omp-place-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# ── P2.1–P2.3 omp_dest_dir ────────────────────────────────────────────────────
if type omp_dest_dir >/dev/null 2>&1; then
  check "omp_dest_dir Darwin default" "/Applications/Alinery.omp" \
    "$(omp_dest_dir Darwin /Applications/Alinery.app)"
  check "omp_dest_dir Darwin custom --dir" "/tmp/apps/Alinery.omp" \
    "$(omp_dest_dir Darwin /tmp/apps/Alinery.app)"
  check "omp_dest_dir Linux" "/home/u/.local/share/alinery/omp" \
    "$(omp_dest_dir Linux /home/u/.local/share/alinery/Alinery)"
else
  echo "FAIL - omp_dest_dir is defined"
  fails=$((fails + 1))
fi

# ── P2.4 / P2.9 source contract: install.sh ───────────────────────────────────
if [ ! -f "$INSTALL" ]; then
  echo "ok   - scripts/install.sh not in this repo (skipped)"
else
  INS="$(cat "$INSTALL")"
  contains "install.sh sources scripts/lib/omp.sh" "scripts/lib/omp.sh" "$INS" ||
    contains "install.sh sources lib/omp.sh" "lib/omp.sh" "$INS"
  contains "install.sh calls omp_dest_dir" "omp_dest_dir" "$INS"
  contains "install.sh header mentions archive omp/omp" "omp/omp" "$INS"
  contains "install.sh sets OMP_SRC from archive sibling" 'OMP_SRC="$(dirname "$APP_SRC")/omp/omp"' "$INS"
  contains "install.sh dies when archive lacks omp/omp" 'archive did not contain omp/omp' "$INS"
  contains "install.sh removes alongside dest dir" 'rm -rf "$OMP_DEST_DIR"' "$INS"
  contains "install.sh smoke-tests --version" '--version' "$INS"
  contains "install.sh summary prints Alongside OMP" "Alongside OMP:" "$INS"

  BEFORE="$(awk '/preflight_gate/{exit} {print}' "$INSTALL")"
  AFTER="$(awk '/# ── end preflight/{p=1} p' "$INSTALL")"
  not_contains "rm OMP dest is not before preflight_gate" 'rm -rf "$OMP_DEST_DIR"' "$BEFORE"
  contains "rm OMP dest is after preflight_gate" 'rm -rf "$OMP_DEST_DIR"' "$AFTER"
  # Ordering inside the post-gate block: OMP dest before Alinery dest.
  OMP_RM_POS="$(printf '%s' "$AFTER" | grep -n 'rm -rf "$OMP_DEST_DIR"' | head -1 | cut -d: -f1)"
  DEST_RM_POS="$(printf '%s' "$AFTER" | grep -n 'rm -rf "$DEST"' | head -1 | cut -d: -f1)"
  if [ -n "$OMP_RM_POS" ] && [ -n "$DEST_RM_POS" ] && [ "$OMP_RM_POS" -lt "$DEST_RM_POS" ]; then
    echo "ok   - rm OMP dest is before rm DEST"
  else
    echo "FAIL - rm OMP dest is before rm DEST"
    echo "         OMP_RM_POS=$OMP_RM_POS DEST_RM_POS=$DEST_RM_POS"
    fails=$((fails + 1))
  fi

  MISSING_LINE="$(grep -n 'archive did not contain omp/omp' "$INSTALL" | head -1 | cut -d: -f1)"
  GATE_LINE="$(grep -n 'preflight_gate' "$INSTALL" | head -1 | cut -d: -f1)"
  if [ -n "$MISSING_LINE" ] && [ -n "$GATE_LINE" ] && [ "$MISSING_LINE" -lt "$GATE_LINE" ]; then
    echo "ok   - missing-OMP die is before preflight_gate"
  else
    echo "FAIL - missing-OMP die is before preflight_gate"
    echo "         MISSING_LINE=$MISSING_LINE GATE_LINE=$GATE_LINE"
    fails=$((fails + 1))
  fi
fi

# ── P2.5–P2.8 placement fragment (no network, no preflight) ───────────────────
if type omp_place_alongside >/dev/null 2>&1; then
  FIXTURE="$TMP/extract/omp/omp"
  mkdir -p "$(dirname "$FIXTURE")" "$TMP/extract/Alinery.app"
  cat >"$FIXTURE" <<'EOF'
#!/bin/sh
echo omp/fixture
EOF
  chmod +x "$FIXTURE"

  DEST="$TMP/apps/Alinery.app"
  mkdir -p "$DEST"
  OMP_DEST_DIR="$(omp_dest_dir Darwin "$DEST")"
  OMP_DEST="$OMP_DEST_DIR/omp"

  rc=0
  omp_place_alongside "$FIXTURE" "$OMP_DEST_DIR" >/dev/null 2>"$TMP/place.err" || rc=$?
  check "fresh place returns 0" "0" "$rc"
  if [ -x "$OMP_DEST" ]; then
    echo "ok   - placed omp is executable"
  else
    echo "FAIL - placed omp is executable"
    fails=$((fails + 1))
  fi
  got_ver="$("$OMP_DEST" --version 2>/dev/null || true)"
  check "placed omp --version smoke" "omp/fixture" "$got_ver"

  # P2.6 reinstall replaces, does not merge
  mkdir -p "$OMP_DEST_DIR"
  echo stale >"$OMP_DEST_DIR/stale-extra"
  echo old >"$OMP_DEST"
  chmod +x "$OMP_DEST"
  omp_place_alongside "$FIXTURE" "$OMP_DEST_DIR" >/dev/null 2>"$TMP/place2.err" || true
  if [ -e "$OMP_DEST_DIR/stale-extra" ]; then
    echo "FAIL - reinstall removes stale-extra"
    fails=$((fails + 1))
  else
    echo "ok   - reinstall removes stale-extra"
  fi
  got_ver="$("$OMP_DEST" --version 2>/dev/null || true)"
  check "reinstall omp is the new fixture" "omp/fixture" "$got_ver"

  # P2.7 missing src dies; existing dest untouched
  KEEP_DIR="$TMP/keep-dest"
  KEEP_APP="$KEEP_DIR/Alinery.app"
  mkdir -p "$KEEP_APP"
  echo keep-app >"$KEEP_APP/marker"
  KEEP_OMP="$(omp_dest_dir Darwin "$KEEP_APP")"
  mkdir -p "$KEEP_OMP"
  echo keep-omp >"$KEEP_OMP/omp"
  rc=0
  omp_place_alongside "$TMP/extract/missing-omp" "$KEEP_OMP" >/dev/null 2>"$TMP/missing.err" || rc=$?
  check_nonzero "missing archive omp/omp dies" "$rc"
  check "malformed archive leaves Alinery dest" "keep-app" "$(cat "$KEEP_APP/marker")"
  check "malformed archive leaves alongside dest" "keep-omp" "$(cat "$KEEP_OMP/omp")"

  # P2.8 HOME and app-config omp tree are kept
  FAKE_HOME="$TMP/fake-home"
  mkdir -p "$FAKE_HOME/.omp" "$TMP/app-config/omp/config/agent"
  echo user-omp >"$FAKE_HOME/.omp/marker"
  echo isolated >"$TMP/app-config/omp/config/agent/marker"
  HOME="$FAKE_HOME" omp_place_alongside "$FIXTURE" "$OMP_DEST_DIR" >/dev/null 2>"$TMP/home.err" || true
  check "install does not delete ~/.omp" "user-omp" "$(cat "$FAKE_HOME/.omp/marker")"
  check "install does not delete app-config omp tree" "isolated" \
    "$(cat "$TMP/app-config/omp/config/agent/marker")"
else
  echo "FAIL - omp_place_alongside is defined"
  fails=$((fails + 1))
fi


# ── P3 install-local.sh source contract ───────────────────────────────────────
# install-local.sh is not part of alinery-deploy; skip rather than fail.
if [ -z "$INSTALL_LOCAL" ] || [ ! -f "$INSTALL_LOCAL" ]; then
  echo "ok   - scripts/install-local.sh not in this repo (skipped)"
else
  LOC="$(cat "$INSTALL_LOCAL")"
  contains "install-local deprecation warning" "WARN: install-local.sh is deprecated" "$LOC"
  contains "install-local prefers scripts/install.sh" "prefer scripts/install.sh" "$LOC"
  contains "deprecation goes to stderr" ">&2" "$LOC"
  contains "install-local sources scripts/lib/omp.sh" "scripts/lib/omp.sh" "$LOC"
  contains "install-local calls omp_dest_dir" "omp_dest_dir" "$LOC"
  contains "install-local fetches the committed pin" "fetch_official_omp" "$LOC"
  contains "install-local smoke-tests --version" "--version" "$LOC"
  contains "install-local summary prints Alongside OMP" "Alongside OMP:" "$LOC"
  contains "install-local dest formula uses Darwin DEST" 'omp_dest_dir Darwin "$DEST"' "$LOC"
  if printf '%s' "$LOC" | grep -q 'omp_host_triple\|aarch64-apple-darwin'; then
    echo "ok   - install-local maps host triple"
  else
    echo "FAIL - install-local maps host triple"
    echo "         expected omp_host_triple or aarch64-apple-darwin"
    fails=$((fails + 1))
  fi
fi

check "dest formula identity for /tmp/x/Alinery.app" "/tmp/x/Alinery.omp" \
  "$(omp_dest_dir Darwin /tmp/x/Alinery.app)"

if [ "$fails" -ne 0 ]; then
  echo
  echo "FAILED: $fails omp place check(s)"
  exit 1
fi
echo "OK: omp install placement"
