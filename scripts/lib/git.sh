#!/usr/bin/env bash
# Pinned official Git: build a relocatable tree, and decide whether to install it.
#
# Sourced by the deploy release scripts (build-macos.sh, build-linux.sh),
# install.sh, and the macOS self-update helper. The committed pin in
# scripts/git-pin.txt plus scripts/git-pin.sha256 is the only tarball this
# tree will download — kernel.org, not a third-party "portable git".
#
# build_pinned_git is the only function that turns those bytes into
# <out_dir>/git/{bin,libexec,share}. install.sh copies that tree next to
# Alinery only when git_app_visible is false. The probe looks at the PATH a
# GUI launch actually has, not the shell that ran the installer, and it does
# not execute macOS's /usr/bin/git stub (that stub raises the Command Line
# Tools dialog).
#
# GIT_APP_SEARCH_PATH and GIT_DEVELOPER_DIR_PRESENT override the probe for
# tests. Unset, the probe is the real one.
#
# Plain bash + base macOS/Linux tools. No jq.

GIT_LIB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! type die >/dev/null 2>&1; then
  die() {
    echo "ERROR: $*" >&2
    return 1
  }
fi

git_pin_version() {
  local file="${GIT_PIN_FILE:-$GIT_LIB_ROOT/scripts/git-pin.txt}"
  [ -f "$file" ] || { die "missing Git pin file: $file" || return 1; }
  local pin
  pin="$(tr -d '[:space:]' <"$file")"
  [ -n "$pin" ] || { die "empty Git pin file: $file" || return 1; }
  printf '%s\n' "$pin"
}

git_pin_sha256() {
  local file="${GIT_PIN_SHA_FILE:-$GIT_LIB_ROOT/scripts/git-pin.sha256}"
  [ -f "$file" ] || { die "missing Git pin sha256 file: $file" || return 1; }
  local sum
  sum="$(tr -d '[:space:]' <"$file")"
  [ -n "$sum" ] || { die "empty Git pin sha256 file: $file" || return 1; }
  printf '%s\n' "$sum"
}

git_file_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

# Host uname → the triple the release scripts pass in. Fail closed on anything
# else so a cross-compile attempt does not silently ship the builder's git.
git_host_triple() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os:$arch" in
    Darwin:arm64) printf '%s\n' "aarch64-apple-darwin" ;;
    Linux:x86_64) printf '%s\n' "x86_64-unknown-linux-gnu" ;;
    *) die "unsupported OS/arch for bundled Git: $os $arch" || return 1 ;;
  esac
}

git_tarball_url() {
  printf '%s\n' "https://mirrors.kernel.org/pub/software/scm/git/git-${1}.tar.gz"
}

# Download, verify, and build the pin into $2/git. $1 is the release triple
# and must be this machine — the build is host-native.
build_pinned_git() {
  local triple="${1:-}"
  local out_dir="${2:-}"
  [ -n "$triple" ] || { die "build_pinned_git: missing triple" || return 1; }
  [ -n "$out_dir" ] || { die "build_pinned_git: missing out_dir" || return 1; }
  local host
  host="$(git_host_triple)" || return 1
  [ "$triple" = "$host" ] || { die "build_pinned_git: triple $triple does not match host $host" || return 1; }

  local pin want url scratch src prefix got jobs
  pin="$(git_pin_version)" || return 1
  want="$(git_pin_sha256)" || return 1
  url="$(git_tarball_url "$pin")"
  prefix="$out_dir/git"
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/alinery-git-build.XXXXXX")"

  if ! curl -fsSL -o "$scratch/git.tar.gz" "$url"; then
    rm -rf "$scratch"
    die "failed to download $url" || return 1
  fi
  got="$(git_file_sha256 "$scratch/git.tar.gz")"
  if [ "$got" != "$want" ]; then
    rm -rf "$scratch"
    die "Git tarball checksum mismatch (got ${got:-empty} want $want)" || return 1
  fi
  if ! tar -xzf "$scratch/git.tar.gz" -C "$scratch"; then
    rm -rf "$scratch"
    die "failed to extract Git tarball" || return 1
  fi
  src="$scratch/git-$pin"
  [ -f "$src/Makefile" ] || {
    rm -rf "$scratch"
    die "Git source missing Makefile at $src" || return 1
  }

  jobs="$(git_build_jobs)"
  # NO_HOMEBREW / NO_FINK / NO_DARWIN_PORTS: a builder with Homebrew must not
  # bake /opt/homebrew into the binary the user runs. NO_PERL / NO_PYTHON /
  # NO_RUST / NO_GITWEB: nothing we spawn needs those, and they pull extra
  # toolchains. RUNTIME_PREFIX keeps libexec and templates next to the binary
  # after install.sh moves the tree. The osxkeychain step repeats the same
  # flags so make does not rebuild the tree with a different config.
  local -a make_flags=(
    prefix="$prefix"
    RUNTIME_PREFIX=YesPlease
    NO_GETTEXT=YesPlease
    NO_TCLTK=YesPlease
    NO_EXPAT=YesPlease
    NO_PERL=YesPlease
    NO_PYTHON=YesPlease
    NO_RUST=YesPlease
    NO_GITWEB=YesPlease
    NO_INSTALL_HARDLINKS=YesPlease
    SKIP_DASHED_BUILT_INS=YesPlease
    NO_HOMEBREW=YesPlease
    NO_FINK=YesPlease
    NO_DARWIN_PORTS=YesPlease
  )
  if ! make -C "$src" -j"$jobs" "${make_flags[@]}" all install; then
    rm -rf "$scratch" "$prefix"
    die "Git build failed" || return 1
  fi

  if [ "$(uname -s)" = Darwin ]; then
    if ! make -C "$src" "${make_flags[@]}" install-git-credential-osxkeychain; then
      rm -rf "$scratch" "$prefix"
      die "git-credential-osxkeychain build failed" || return 1
    fi
    [ -x "$prefix/libexec/git-core/git-credential-osxkeychain" ] || {
      rm -rf "$scratch" "$prefix"
      die "git-credential-osxkeychain was not installed into $prefix" || return 1
    }
  fi

  if [ "$(uname -s)" = Linux ]; then
    if ! git_vendor_linux_libs "$prefix"; then
      rm -rf "$scratch" "$prefix"
      die "failed to vendor Git shared libraries" || return 1
    fi
  fi

  if [ -f "$src/COPYING" ]; then
    cp "$src/COPYING" "$prefix/COPYING"
  fi
  cat >"$prefix/SOURCE" <<EOF
$url
sha256 $want
EOF

  [ -x "$prefix/bin/git" ] || {
    rm -rf "$scratch" "$prefix"
    die "Git build did not produce $prefix/bin/git" || return 1
  }
  [ -x "$prefix/libexec/git-core/git-remote-http" ] || [ -x "$prefix/libexec/git-core/git-remote-https" ] || {
    rm -rf "$scratch" "$prefix"
    die "Git build did not produce git-remote-http(s)" || return 1
  }
  rm -rf "$scratch"

  "$prefix/bin/git" --version >/dev/null 2>&1 || {
    rm -rf "$prefix"
    die "built Git failed --version" || return 1
  }
  local smoke
  smoke="$(mktemp -d "${TMPDIR:-/tmp}/alinery-git-smoke.XXXXXX")"
  if ! "$prefix/bin/git" init "$smoke/repo" >/dev/null 2>&1; then
    rm -rf "$smoke" "$prefix"
    die "built Git failed init smoke test" || return 1
  fi
  rm -rf "$smoke"
}

git_build_jobs() {
  local n=""
  if command -v sysctl >/dev/null 2>&1; then
    n="$(sysctl -n hw.ncpu 2>/dev/null || true)"
  fi
  if [ -z "$n" ] && command -v nproc >/dev/null 2>&1; then
    n="$(nproc 2>/dev/null || true)"
  fi
  case "$n" in
    ''|*[!0-9]*) n=2 ;;
  esac
  [ "$n" -ge 1 ] || n=2
  printf '%s\n' "$n"
}

# Copy non-glibc NEEDED libraries into $1/lib and point every ELF at that
# directory. libc stays on the system; libcurl and its friends travel with git
# so a machine without libcurl can still `git push` over https.
git_vendor_linux_libs() {
  local root="${1:-}"
  [ -n "$root" ] || { die "git_vendor_linux_libs: missing root" || return 1; }
  command -v patchelf >/dev/null 2>&1 || { die "patchelf is required to vendor Git libraries" || return 1; }
  local dest="$root/lib"
  mkdir -p "$dest"
  local bin
  while IFS= read -r bin; do
    [ -n "$bin" ] || continue
    git_copy_needed_libs "$bin" "$dest" || return 1
  done < <(find "$root/bin" "$root/libexec" -type f 2>/dev/null)
  local copied
  if [ -d "$dest" ]; then
    while IFS= read -r copied; do
      [ -n "$copied" ] || continue
      git_copy_needed_libs "$copied" "$dest" || return 1
    done < <(find "$dest" -type f)
  fi
  local elf dir rel
  while IFS= read -r elf; do
    [ -n "$elf" ] || continue
    file "$elf" | grep -q ELF || continue
    dir="$(dirname "$elf")"
    rel="$(realpath --relative-to "$dir" "$dest")"
    patchelf --set-rpath "\$ORIGIN/$rel" "$elf" || {
      die "patchelf failed: $elf" || return 1
    }
  done < <(find "$root" -type f)
}

git_copy_needed_libs() {
  local bin="${1:-}" dest="${2:-}" lib base real
  [ -f "$bin" ] || return 0
  file "$bin" | grep -q ELF || return 0
  local libs
  libs="$(ldd "$bin" 2>/dev/null | awk '/=>/ {print $3}')" || true
  for lib in $libs; do
    case "$lib" in
      ""|not) continue ;;
    esac
    [ -f "$lib" ] || continue
    base="$(basename "$lib")"
    case "$base" in
      libc.so*|libm.so*|libdl.so*|libpthread.so*|librt.so*|libresolv.so*|libnss_*|ld-linux*|ld-musl*) continue ;;
    esac
    if [ -e "$dest/$base" ]; then
      continue
    fi
    real="$lib"
    if [ -L "$lib" ]; then
      real="$(readlink -f "$lib")" || real="$lib"
    fi
    cp -a "$real" "$dest/$base" || { die "failed to copy $real" || return 1; }
    git_copy_needed_libs "$dest/$base" "$dest" || return 1
  done
}

# Alongside dest dir for a given OS + Alinery dest path.
# Darwin: sibling Alinery.git next to Alinery.app
# Linux:  sibling git next to the Alinery prefix.
git_dest_dir() {
  local os="${1:-}" dest="${2:-}"
  [ -n "$os" ] && [ -n "$dest" ] || { die "git_dest_dir: os and dest required" || return 1; }
  case "$os" in
    Darwin) printf '%s\n' "$(dirname "$dest")/Alinery.git" ;;
    Linux) printf '%s\n' "$(dirname "$dest")/git" ;;
    *) die "unsupported OS for git dest: $os" || return 1 ;;
  esac
}

# PATH a Dock / desktop-session launch searches. Not the installer's shell PATH.
git_app_search_path() {
  if [ -n "${GIT_APP_SEARCH_PATH:-}" ]; then
    printf '%s\n' "$GIT_APP_SEARCH_PATH"
    return 0
  fi
  case "$(uname -s)" in
    Darwin) printf '%s\n' "/usr/bin:/bin:/usr/sbin:/sbin" ;;
    Linux) printf '%s\n' "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" ;;
    *) die "unsupported OS for git probe: $(uname -s)" || return 1 ;;
  esac
}

# 0 when the macOS developer dir is installed. GIT_DEVELOPER_DIR_PRESENT=0/1
# skips xcode-select so a test can treat /usr/bin/git as the CLT stub.
git_developer_dir_present() {
  if [ -n "${GIT_DEVELOPER_DIR_PRESENT+x}" ]; then
    [ "$GIT_DEVELOPER_DIR_PRESENT" = 1 ]
    return
  fi
  [ "$(uname -s)" = Darwin ] || return 1
  xcode-select -p >/dev/null 2>&1
}

# True when the app process would find a real git. False for a missing git
# and for macOS's /usr/bin/git stub (developer dir absent). Does not run git.
git_app_visible() {
  local search dir cand
  search="$(git_app_search_path)" || return 1
  local IFS=:
  for dir in $search; do
    [ -n "$dir" ] || continue
    cand="$dir/git"
    [ -x "$cand" ] || continue
    if [ "$(uname -s)" = Darwin ] && [ "$cand" = /usr/bin/git ]; then
      git_developer_dir_present || continue
    fi
    return 0
  done
  return 1
}

# Replace $2 (alongside dir) with a copy of $1 (archive git/ tree).
# Smoke-tests --version. A missing src never deletes an existing dest.
git_place_alongside() {
  local src="${1:-}" dest_dir="${2:-}"
  [ -x "$src/bin/git" ] || { die "archive did not contain git/bin/git" || return 1; }
  rm -rf "$dest_dir"
  mkdir -p "$(dirname "$dest_dir")"
  case "$(uname -s)" in
    Darwin) ditto "$src" "$dest_dir" ;;
    *) cp -a "$src" "$dest_dir" ;;
  esac
  chmod +x "$dest_dir/bin/git"
  "$dest_dir/bin/git" --version >/dev/null 2>&1 || {
    die "installed Git at $dest_dir/bin/git failed --version smoke test" || return 1
  }
}

# install.sh policy: place the archive tree only when the app cannot see git.
# When it can, drop a previously installed alongside tree. Never touches a
# git outside that alongside directory.
git_install_or_remove() {
  local src="${1:-}" dest_dir="${2:-}"
  [ -n "$src" ] && [ -n "$dest_dir" ] || { die "git_install_or_remove: src and dest_dir required" || return 1; }
  [ -x "$src/bin/git" ] || { die "archive did not contain git/bin/git" || return 1; }
  if git_app_visible; then
    if [ -e "$dest_dir" ]; then
      rm -rf "$dest_dir"
    fi
    return 0
  fi
  git_place_alongside "$src" "$dest_dir"
}
