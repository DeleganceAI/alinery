# Compile alinery-vinculum-daemon and alinery-mcp, and place them as Tauri sidecars
# `alinery-vinculum-daemon-<triple>` and `alinery-mcp-<triple>`. Also copies libalinery_core
# beside the daemon so `--repo` can dlopen it when ALINERY_OWNERSHIP_LIB is unset.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # src-tauri
ROOT="$(cd "$DIR/../.." && pwd)"
PROFILE="${1:-release}"
TRIPLE="$(rustc -vV | sed -n 's/host: //p')"
TARGET="$(cargo metadata --format-version 1 --no-deps --manifest-path "$DIR/Cargo.toml" |
  node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).target_directory')"
[ -n "$TARGET" ] || { echo "ERROR: could not resolve cargo target directory" >&2; exit 1; }
if [ "$PROFILE" = "release" ]; then
  cargo build --release -p alinery-core -p alinery-mcp --manifest-path "$DIR/Cargo.toml"
  bash "$ROOT/scripts/dev-fetch-bun.sh" --release --no-download
  BUILT="$TARGET/release"
else
  cargo build -p alinery-core -p alinery-mcp --manifest-path "$DIR/Cargo.toml"
  bash "$ROOT/scripts/dev-fetch-bun.sh" --no-download
  BUILT="$TARGET/debug"
fi
DAEMON="$BUILT/alinery-vinculum-daemon"
[ -f "$DAEMON" ] || { echo "ERROR: $DAEMON was not compiled" >&2; exit 1; }
SIDE="$DIR/alinery-vinculum-daemon-$TRIPLE"
MCP_SIDE="$DIR/alinery-mcp-$TRIPLE"
cp "$DAEMON" "$SIDE"
cp "$BUILT/alinery-mcp" "$MCP_SIDE"
case "$(uname -s)" in
  Darwin) LIB="libalinery_core.dylib" ;;
  Linux) LIB="libalinery_core.so" ;;
  *) LIB="alinery_core.dll" ;;
esac
mkdir -p "$DIR/resources/ownership"
cp "$BUILT/$LIB" "$DIR/resources/ownership/$LIB"
chmod +x "$SIDE" "$MCP_SIDE"
echo "sidecar ready: $SIDE"
echo "mcp sidecar ready: $MCP_SIDE"
echo "ownership library ready: $DIR/resources/ownership/$LIB"
