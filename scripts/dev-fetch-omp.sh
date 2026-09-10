#!/usr/bin/env bash
# One-shot fetch of the committed OMP pin into the default alongside dir
# (`/Applications/Alinery.omp` on macOS, `~/.local/share/alinery/omp` on Linux).
# Used by `npm run tauri dev` when that binary is missing. Never a sidecar;
# never invoked from scripts/check.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/omp.sh
. "$ROOT/scripts/lib/omp.sh"

if ! type die >/dev/null 2>&1; then
  die() { echo "ERROR: $*" >&2; exit 1; }
fi

OS="$(uname -s)"
case "$OS" in
  Darwin) DEST="/Applications/Alinery.app" ;;
  Linux) DEST="${HOME}/.local/share/alinery/Alinery" ;;
  *) die "unsupported OS: $OS" ;;
esac

OMP_DEST_DIR="$(omp_dest_dir "$OS" "$DEST")"
OMP_DEST="$OMP_DEST_DIR/omp"
TRIPLE="$(omp_host_triple)"

# `--check` answers "which OMP is this checkout going to run, and whose config will it use" without
# downloading anything. Run it when a session behaves like it belongs to someone else.
if [ "${1:-}" = "--check" ]; then
  case "$OS" in
    Darwin) CONFIG_ROOT="$HOME/Library/Application Support" ;;
    *) CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}" ;;
  esac
  echo "pin:      $(omp_pin_version) ($TRIPLE)"
  if [ -x "${ALINERY_OMP_PATH:-$OMP_DEST}" ]; then
    echo "binary:   ${ALINERY_OMP_PATH:-$OMP_DEST} ($("${ALINERY_OMP_PATH:-$OMP_DEST}" --version 2>/dev/null))"
  else
    echo "binary:   ${ALINERY_OMP_PATH:-$OMP_DEST} (MISSING — run $0)"
  fi
  echo "prod cfg: $CONFIG_ROOT/ai.delegance.alinery/omp/config/agent"
  echo "dev cfg:  $CONFIG_ROOT/ai.delegance.alinery.dev/instances/<launch-root-hash>/omp/config/agent"
  echo "          one per checkout; Settings → Chat shows the exact directory a running app is using."
  exit 0
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/alinery-dev-omp.XXXXXX")"
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

echo "Fetching OMP $(omp_pin_version) ($TRIPLE) into $OMP_DEST_DIR"
fetch_official_omp "$TRIPLE" "$SCRATCH"
omp_place_alongside "$SCRATCH/omp/omp" "$OMP_DEST_DIR"
echo "Alongside OMP: $OMP_DEST ($("$OMP_DEST" --version 2>/dev/null))"
