#!/usr/bin/env bash
# Stage the Python the office skills run on into one runtime directory: stage.sh <triple> <dest>.
#
# <dest> becomes a relocatable CPython (python-build-standalone, pinned below by sha256) with the packages in
# requirements.txt installed into its own site-packages. build-remote-runtimes.sh calls this per target, so the Python
# travels inside each runtime archive and lands, read-only and hash-named, beside the daemon that puts it on the agent's
# PATH (vinculum-daemon/src/agentShell.ts).
#
# The wheels are cross-installed: pip runs on the Python built for this machine and asks for the target's platform
# tags, binary wheels only, every one checked against the hashes in requirements.txt. To change a package, edit
# requirements.in and rerun:
#   uv pip compile requirements.in --universal --generate-hashes --python-version 3.12 --exclude-newer <two weeks ago> \
#     --no-header --only-binary :all: -o requirements.txt
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRIPLE="${1:?usage: stage.sh <triple> <dest>}"
DEST="${2:?usage: stage.sh <triple> <dest>}"

PBS_RELEASE=20261026
PBS_PYTHON=3.12.16
pbs_sha256() {
  case "$1" in
    aarch64-apple-darwin) echo 353d5f1b4fd2715e7053f12f068435d5bbad16b91e057006b5d01e0925709a7e ;;
    x86_64-apple-darwin) echo 37c38fda76fec1fbf310adcbafb7f0d96af13b5511bf8ea954c3aa8eec185734 ;;
    aarch64-unknown-linux-gnu) echo bb4b6392670c5d3f93876996fcaa19858a4a413a0c7720144c18b0d6f1f0db2d ;;
    x86_64-unknown-linux-gnu) echo ce4f6d0a6cfdb3bed6e44c2f9affd85943c76a42e25ad3a259002f31d6fb8a20 ;;
    *) echo "no pinned Python for $1" >&2; return 1 ;;
  esac
}

# Platform tags pip may take for each target. The floors match build-remote-runtimes.sh: glibc 2.28, macOS 13.0.
platforms() {
  local arch
  case "$1" in
    *-unknown-linux-gnu)
      arch="${1%%-*}"
      echo "manylinux2014_$arch"
      for minor in $(seq 17 28); do echo "manylinux_2_${minor}_$arch"; done
      ;;
    x86_64-apple-darwin)
      for v in 10_9 10_10 10_11 10_12 10_13 10_14 10_15 11_0 12_0 13_0; do echo "macosx_${v}_x86_64"; echo "macosx_${v}_universal2"; done
      ;;
    aarch64-apple-darwin)
      for v in 10_9 10_10 10_11 10_12 10_13 10_14 10_15; do echo "macosx_${v}_universal2"; done
      for v in 11_0 12_0 13_0; do echo "macosx_${v}_arm64"; echo "macosx_${v}_universal2"; done
      ;;
  esac
}

host_triple() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo aarch64-apple-darwin ;;
    Darwin-x86_64) echo x86_64-apple-darwin ;;
    Linux-aarch64 | Linux-arm64) echo aarch64-unknown-linux-gnu ;;
    Linux-x86_64) echo x86_64-unknown-linux-gnu ;;
    *) echo "unsupported build machine $(uname -sm)" >&2; return 1 ;;
  esac
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/alinery/python-build-standalone"
# Download (once) and verify the pinned archive for a triple; prints its path.
fetch() {
  local name="cpython-${PBS_PYTHON}+${PBS_RELEASE}-$1-install_only_stripped.tar.gz" want file
  want="$(pbs_sha256 "$1")"
  file="$CACHE/$name"
  mkdir -p "$CACHE"
  if [ ! -f "$file" ] || [ "$(sha256 "$file")" != "$want" ]; then
    curl -fsSL --retry 3 -o "$file.part" "https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_RELEASE/${name//+/%2B}"
    [ "$(sha256 "$file.part")" = "$want" ] || { rm -f "$file.part"; echo "ERROR: $name does not match its pinned sha256" >&2; return 1; }
    mv "$file.part" "$file"
  fi
  echo "$file"
}

# The archive unpacks to python/; DEST takes its place.
unpack() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/alinery-python.XXXXXX")"
  tar -xzf "$1" -C "$tmp"
  rm -rf "$2"
  mkdir -p "$(dirname "$2")"
  mv "$tmp/python" "$2"
  rm -rf "$tmp"
}

HOST="$(host_triple)"
BUILDER="$CACHE/builder-$HOST-$PBS_RELEASE"
if [ ! -x "$BUILDER/bin/python3" ]; then unpack "$(fetch "$HOST")" "$BUILDER"; fi
unpack "$(fetch "$TRIPLE")" "$DEST"

plat_args=()
while read -r tag; do plat_args+=(--platform "$tag"); done < <(platforms "$TRIPLE")
"$BUILDER/bin/python3" -m pip install --quiet --disable-pip-version-check --no-warn-script-location \
  --require-hashes --only-binary=:all: --implementation cp --python-version 3.12 --abi cp312 --abi abi3 --abi none \
  "${plat_args[@]}" --target "$DEST/lib/python3.12/site-packages" -r "$HERE/requirements.txt"

# Nothing an agent's script needs: Tk and IDLE (no display), headers, the bundled pip installer, 2to3, offline docs.
# pip itself stays, for extra packages (they go to the repository's own user base, never into this tree).
rm -rf "$DEST"/include "$DEST"/share "$DEST"/lib/tcl* "$DEST"/lib/tk* "$DEST"/lib/itcl* "$DEST"/lib/thread* \
  "$DEST"/lib/libtcl* "$DEST"/lib/libtk* "$DEST"/bin/idle* "$DEST"/bin/2to3* \
  "$DEST"/lib/python3.12/{tkinter,idlelib,turtledemo,ensurepip,lib2to3,pydoc_data,test} \
  "$DEST"/lib/python3.12/lib-dynload/_tkinter*

# pip reads <prefix>/pip.conf only when this Python runs it, not in a venv made from it: an extra package goes to the user
# base, which the agent's shell sets to the repository's own directory (PYTHONUSERBASE), never into this shared tree.
printf '[install]\nuser = true\n' > "$DEST/pip.conf"

# Apple silicon kills a Mach-O without a valid signature. Wheels and python-build-standalone come linker-signed; check
# every one and re-sign ad hoc what is not (codesign exists only on macOS, and darwin targets build only there).
if [[ "$TRIPLE" == *-apple-darwin ]]; then
  while IFS= read -r -d '' file; do
    if file -b "$file" | grep -q '^Mach-O' && ! codesign -v "$file" 2>/dev/null; then codesign --force --sign - "$file"; fi
  done < <(find "$DEST" -type f \( -name '*.so' -o -name '*.dylib' -o -path '*/bin/python3*' \) -print0)
fi

# What the skills import must import. Only a Python built for this machine can run here.
if [ "$TRIPLE" = "$HOST" ]; then
  PYTHONNOUSERSITE=1 "$DEST/bin/python3" -c 'import lxml, defusedxml, pypdf, pdfplumber, PIL, openpyxl, pptx, docx, reportlab'
fi
echo "python ready: $TRIPLE ($(du -sh "$DEST" | cut -f1))"
