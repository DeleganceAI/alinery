#!/usr/bin/env bash
# Official-OMP pin/fetch helpers.
#
# Sourced by scripts/release.sh, scripts/release/build-linux.sh,
# scripts/install.sh, scripts/install-local.sh, and scripts/dev-fetch-omp.sh.
# The committed pin in scripts/omp-pin.txt is the only version this tree will
# download at zip time — never releases/latest or main.
#
# fetch_official_omp is the only function that pulls official OMP bytes into
# build output. It verifies the GitHub SHA256SUMS.txt entry before writing
# <out_dir>/omp/omp.
#
# Plain bash + base macOS/Linux tools, no jq.

OMP_LIB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Standalone `return 1` so unit tests can capture the status. Callers that
# already defined `die` (release.sh / install.sh: `exit 1`) keep theirs.
if ! type die >/dev/null 2>&1; then
  die() {
    echo "ERROR: $*" >&2
    return 1
  }
fi

# Trimmed contents of scripts/omp-pin.txt, or $OMP_PIN_FILE when set (test override).
omp_pin_version() {
  local file="${OMP_PIN_FILE:-$OMP_LIB_ROOT/scripts/omp-pin.txt}"
  [ -f "$file" ] || { die "missing OMP pin file: $file" || return 1; }
  local pin
  pin="$(tr -d '[:space:]' <"$file")"
  [ -n "$pin" ] || { die "empty OMP pin file: $file" || return 1; }
  printf '%s\n' "$pin"
}

# Alinery Rust triple → official can1357/oh-my-pi GitHub asset name.
# Unsupported triples die — matches release.sh's own host_triple gate.
omp_release_asset_name() {
  case "${1:-}" in
    aarch64-apple-darwin) printf '%s\n' "omp-darwin-arm64" ;;
    x86_64-unknown-linux-gnu) printf '%s\n' "omp-linux-x64" ;;
    *) die "unsupported OMP release triple: ${1:-}" || return 1 ;;
  esac
}

omp_file_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

# Download the pinned official binary for $1 (triple) into $2/omp/omp after
# checksum verify. Unverified bytes never land at the dest.
fetch_official_omp() {
  local triple="${1:-}"
  local out_dir="${2:-}"
  [ -n "$triple" ] || { die "fetch_official_omp: missing triple" || return 1; }
  [ -n "$out_dir" ] || { die "fetch_official_omp: missing out_dir" || return 1; }

  local pin asset url sums_url scratch dest got want
  pin="$(omp_pin_version)" || return 1
  asset="$(omp_release_asset_name "$triple")" || return 1
  url="https://github.com/can1357/oh-my-pi/releases/download/${pin}/${asset}"
  sums_url="https://github.com/can1357/oh-my-pi/releases/download/${pin}/SHA256SUMS.txt"
  dest="$out_dir/omp/omp"

  scratch="$(mktemp -d "${TMPDIR:-/tmp}/alinery-omp-fetch.XXXXXX")"
  if ! curl -fsSL -o "$scratch/$asset" "$url"; then
    rm -rf "$scratch"
    die "failed to download $url" || return 1
  fi
  if ! curl -fsSL -o "$scratch/SHA256SUMS.txt" "$sums_url"; then
    rm -rf "$scratch"
    die "failed to download $sums_url" || return 1
  fi

  got="$(omp_file_sha256 "$scratch/$asset")"
  want="$(awk -v name="$asset" '$NF == name { print $1; exit }' "$scratch/SHA256SUMS.txt")"
  if [ -z "$want" ] || [ "$got" != "$want" ]; then
    rm -rf "$scratch"
    die "OMP checksum mismatch for $asset (got ${got:-empty} want ${want:-missing})" || return 1
  fi

  mkdir -p "$out_dir/omp"
  cp "$scratch/$asset" "$dest"
  chmod +x "$dest"
  rm -rf "$scratch"
}


# Host uname → Alinery Rust triple. x86_64-apple-darwin is a real uname result
# and then dies in omp_release_asset_name (fail-closed, not a Linux branch).
omp_host_triple() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin)
      case "$arch" in
        arm64) printf '%s\n' "aarch64-apple-darwin" ;;
        x86_64) printf '%s\n' "x86_64-apple-darwin" ;;
        *) die "unsupported macOS arch: $arch" || return 1 ;;
      esac
      ;;
    Linux)
      case "$arch" in
        x86_64) printf '%s\n' "x86_64-unknown-linux-gnu" ;;
        *) die "unsupported Linux arch: $arch" || return 1 ;;
      esac
      ;;
    *) die "unsupported OS for OMP: $os" || return 1 ;;
  esac
}

# Alongside dest dir for a given OS + Alinery dest path.
# Darwin: sibling Alinery.omp next to Alinery.app
# Linux: sibling omp next to the Alinery prefix.
omp_dest_dir() {
  local os="${1:-}" dest="${2:-}"
  [ -n "$os" ] && [ -n "$dest" ] || { die "omp_dest_dir: os and dest required" || return 1; }
  case "$os" in
    Darwin) printf '%s\n' "$(dirname "$dest")/Alinery.omp" ;;
    Linux) printf '%s\n' "$(dirname "$dest")/omp" ;;
    *) die "unsupported OS for omp dest: $os" || return 1 ;;
  esac
}

# Replace $2 (alongside dir) with a copy of $1 (archive sibling omp/omp).
# Smoke-tests --version. Unverified/missing src never lands at dest.
omp_place_alongside() {
  local src="${1:-}" dest_dir="${2:-}"
  local dest="$dest_dir/omp"
  [ -f "$src" ] || { die "archive did not contain omp/omp" || return 1; }
  rm -rf "$dest_dir"
  mkdir -p "$dest_dir"
  case "$(uname -s)" in
    Darwin) ditto "$src" "$dest" ;;
    *) cp "$src" "$dest" ;;
  esac
  chmod +x "$dest"
  "$dest" --version >/dev/null 2>&1 || {
    die "installed OMP at $dest failed --version smoke test" || return 1
  }
}
