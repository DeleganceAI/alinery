#!/usr/bin/env bash
# Unit tests for the official-OMP pin/fetch helpers (scripts/lib/omp.sh) plus
# source contracts on the release scripts that must consume them.
#
# Network-free: fetch_official_omp is driven against a fake `curl` on PATH, same
# idea as cdn_test.sh's fake aws/doctl. Fast enough for scripts/check.sh --quick.
#
# Plain bash, no jq.
# Run: ./scripts/tests/omp_lib_test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$ROOT/scripts/lib/omp.sh"
PIN_FILE="$ROOT/scripts/omp-pin.txt"
RELEASE="$ROOT/scripts/release.sh"
BUILD_LINUX="$ROOT/scripts/release/build-linux.sh"

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

TMP="$(mktemp -d "${TMPDIR:-/tmp}/alinery-omp-lib-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# ── committed pin file ────────────────────────────────────────────────────────
if [ ! -f "$PIN_FILE" ]; then
  echo "FAIL - scripts/omp-pin.txt exists"
  echo "         want: a committed vX.Y.Z pin"
  echo "         got:  missing $PIN_FILE"
  fails=$((fails + 1))
  COMMITTED_PIN=""
else
  echo "ok   - scripts/omp-pin.txt exists"
  COMMITTED_PIN="$(tr -d '[:space:]' <"$PIN_FILE")"
  case "$COMMITTED_PIN" in
    v[0-9]*.[0-9]*.[0-9]*) echo "ok   - committed pin is vX.Y.Z ($COMMITTED_PIN)" ;;
    *)
      echo "FAIL - committed pin is vX.Y.Z"
      echo "         want: vX.Y.Z"
      echo "         got:  [$COMMITTED_PIN]"
      fails=$((fails + 1))
      ;;
  esac
  not_contains "committed pin is not 'latest'" "latest" "$COMMITTED_PIN"
fi

# ── omp_pin_version: temp pin file via OMP_PIN_FILE ───────────────────────────
if type omp_pin_version >/dev/null 2>&1; then
  printf '  v18.1.10  \n' >"$TMP/pin"
  got="$(OMP_PIN_FILE="$TMP/pin" omp_pin_version)"
  check "omp_pin_version trims whitespace from OMP_PIN_FILE" "v18.1.10" "$got"

  : >"$TMP/empty-pin"
  rc=0
  OMP_PIN_FILE="$TMP/empty-pin" omp_pin_version >/dev/null 2>"$TMP/empty-pin.err" || rc=$?
  check_nonzero "empty pin file dies" "$rc"

  rc=0
  OMP_PIN_FILE="$TMP/missing-pin" omp_pin_version >/dev/null 2>"$TMP/missing-pin.err" || rc=$?
  check_nonzero "missing pin file dies" "$rc"
else
  echo "FAIL - omp_pin_version is defined"
  echo "         want: function omp_pin_version"
  echo "         got:  missing"
  fails=$((fails + 1))
fi

# ── omp_release_asset_name ────────────────────────────────────────────────────
if type omp_release_asset_name >/dev/null 2>&1; then
  check "darwin arm64 asset" "omp-darwin-arm64" "$(omp_release_asset_name aarch64-apple-darwin)"
  check "linux x64 asset" "omp-linux-x64" "$(omp_release_asset_name x86_64-unknown-linux-gnu)"

  for triple in x86_64-apple-darwin aarch64-unknown-linux-gnu foo; do
    rc=0
    out="$(omp_release_asset_name "$triple" 2>"$TMP/asset.err" || true)"
    omp_release_asset_name "$triple" >/dev/null 2>"$TMP/asset.err" || rc=$?
    check_nonzero "unsupported triple dies ($triple)" "$rc"
    not_contains "unsupported triple ($triple) does not print an asset" "omp-" "$out"
  done
else
  echo "FAIL - omp_release_asset_name is defined"
  echo "         want: function omp_release_asset_name"
  echo "         got:  missing"
  fails=$((fails + 1))
fi

# ── fetch_official_omp: fake curl, no network ─────────────────────────────────
BIN="$TMP/bin"
mkdir -p "$BIN"
CURL_CALLS="$TMP/curl-calls"
CURL_BODY_DIR="$TMP/curl-bodies"
mkdir -p "$CURL_BODY_DIR"
: >"$CURL_CALLS"

FIXTURE_BYTES="omp-fixture-bytes"$'\n'
printf '%s' "$FIXTURE_BYTES" >"$TMP/fixture-bin"
FIXTURE_HASH="$(shasum -a 256 "$TMP/fixture-bin" | awk '{print $1}')"

cat >"$BIN/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$CURL_CALLS"
out=""
url=""
while [ "\$#" -gt 0 ]; do
  case "\$1" in
    -o|--output) out="\$2"; shift 2 ;;
    --output=*) out="\${1#--output=}"; shift ;;
    -o*) out="\${1#-o}"; shift ;;
    -*) shift ;;
    *) url="\$1"; shift ;;
  esac
done
[ -n "\$out" ] || exit 1
[ -n "\$url" ] || exit 1
case "\$url" in
  *SHA256SUMS.txt)
    if [ -f "$CURL_BODY_DIR/SHA256SUMS.txt" ]; then
      cp "$CURL_BODY_DIR/SHA256SUMS.txt" "\$out"
    else
      exit 1
    fi
    ;;
  *)
    if [ -f "$CURL_BODY_DIR/asset" ]; then
      cp "$CURL_BODY_DIR/asset" "\$out"
    else
      exit 1
    fi
    ;;
esac
EOF
chmod +x "$BIN/curl"
PATH="$BIN:$PATH"
export PATH

if type fetch_official_omp >/dev/null 2>&1; then
  printf '%s' "$FIXTURE_BYTES" >"$CURL_BODY_DIR/asset"
  printf '%s  omp-darwin-arm64\n' "$FIXTURE_HASH" >"$CURL_BODY_DIR/SHA256SUMS.txt"
  : >"$CURL_CALLS"
  OUT_OK="$TMP/out-ok"
  mkdir -p "$OUT_OK"
  export OMP_PIN_FILE
  if [ -n "${COMMITTED_PIN:-}" ]; then
    printf '%s\n' "$COMMITTED_PIN" >"$TMP/pin-for-fetch"
  else
    printf 'v18.1.10\n' >"$TMP/pin-for-fetch"
  fi
  OMP_PIN_FILE="$TMP/pin-for-fetch"
  PIN_USED="$(tr -d '[:space:]' <"$OMP_PIN_FILE")"

  rc=0
  fetch_official_omp aarch64-apple-darwin "$OUT_OK" >/dev/null 2>"$TMP/fetch.err" || rc=$?
  check "fetch_official_omp matching checksum returns 0" "0" "$rc"
  if [ -f "$OUT_OK/omp/omp" ]; then
    echo "ok   - fetch writes \$OUT/omp/omp"
    if [ -x "$OUT_OK/omp/omp" ]; then
      echo "ok   - fetched omp is executable"
    else
      echo "FAIL - fetched omp is executable"
      fails=$((fails + 1))
    fi
    if cmp -s "$TMP/fixture-bin" "$OUT_OK/omp/omp"; then
      echo "ok   - fetched bytes match the verified asset"
    else
      echo "FAIL - fetched bytes match the verified asset"
      echo "         dest differs from verified fixture"
      fails=$((fails + 1))
    fi
  else
    echo "FAIL - fetch writes \$OUT/omp/omp"
    echo "         got: missing $OUT_OK/omp/omp"
    fails=$((fails + 1))
  fi
  CURL_LOG="$(cat "$CURL_CALLS")"
  contains "curl downloaded the pinned darwin asset" \
    "github.com/can1357/oh-my-pi/releases/download/${PIN_USED}/omp-darwin-arm64" "$CURL_LOG"
  contains "curl downloaded SHA256SUMS.txt for the pin" \
    "github.com/can1357/oh-my-pi/releases/download/${PIN_USED}/SHA256SUMS.txt" "$CURL_LOG"
  not_contains "fetch does not use releases/latest" "releases/latest" "$CURL_LOG"
  not_contains "fetch does not use /main/" "/main/" "$CURL_LOG"

  # mismatch: dest must not receive unverified bytes
  printf 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef  omp-darwin-arm64\n' \
    >"$CURL_BODY_DIR/SHA256SUMS.txt"
  : >"$CURL_CALLS"
  OUT_BAD="$TMP/out-bad"
  mkdir -p "$OUT_BAD"
  rc=0
  fetch_official_omp aarch64-apple-darwin "$OUT_BAD" >/dev/null 2>"$TMP/fetch-bad.err" || rc=$?
  check_nonzero "fetch_official_omp checksum mismatch dies" "$rc"
  if [ -e "$OUT_BAD/omp/omp" ]; then
    echo "FAIL - mismatch does not land unverified bytes at dest"
    echo "         got: $OUT_BAD/omp/omp exists"
    fails=$((fails + 1))
  else
    echo "ok   - mismatch does not land unverified bytes at dest"
  fi
else
  echo "FAIL - fetch_official_omp is defined"
  echo "         want: function fetch_official_omp"
  echo "         got:  missing"
  fails=$((fails + 1))
fi

# ── source contracts: release.sh ──────────────────────────────────────────────
if [ ! -f "$RELEASE" ]; then
  echo "ok   - scripts/release.sh not in this repo (skipped)"
else
  REL_SRC="$(cat "$RELEASE")"
  contains "release.sh sources scripts/lib/omp.sh" "scripts/lib/omp.sh" "$REL_SRC"
  PKG="$(sed -n '/^package_for_host()/,/^}/p' "$RELEASE")"
  contains "package_for_host calls fetch_official_omp" "fetch_official_omp" "$PKG"
  not_contains "package_for_host no longer zips the bundle with --keepParent alone" \
    'ditto -c -k --keepParent "$BUNDLE_MACOS"' "$PKG"

  DRY="$(awk '/if \[ "\$DRY_RUN" -eq 1 \]/, /^fi$/' "$RELEASE")"
  not_contains "dry-run block does not call fetch_official_omp" "fetch_official_omp" "$DRY"
  if printf '%s' "$DRY" | grep -q 'omp_pin_version\|omp_release_asset_name\|can1357/oh-my-pi/releases/download'; then
    echo "ok   - dry-run prints pin/asset/URL"
  else
    echo "FAIL - dry-run prints pin/asset/URL"
    echo "         expected dry-run block to mention omp_pin_version, omp_release_asset_name,"
    echo "         or a can1357/oh-my-pi/releases/download URL"
    echo "         got: [$DRY]"
    fails=$((fails + 1))
  fi
fi

# ── source contracts: build-linux.sh ──────────────────────────────────────────
if [ ! -f "$BUILD_LINUX" ]; then
  echo "ok   - scripts/release/build-linux.sh not in this repo (skipped)"
else
  LIN_SRC="$(cat "$BUILD_LINUX")"
  contains "build-linux.sh sources scripts/lib/omp.sh" "scripts/lib/omp.sh" "$LIN_SRC"
  contains "build-linux.sh calls fetch_official_omp" "fetch_official_omp" "$LIN_SRC"
  contains "linux tar includes Alinery and omp members" \
    'tar -C "$STAGE_ROOT" -czf "$TAR_PATH" Alinery omp' "$LIN_SRC"
fi

if [ "$fails" -ne 0 ]; then
  echo
  echo "FAILED: $fails omp lib check(s)"
  exit 1
fi
echo "OK: omp pin/fetch helpers"
