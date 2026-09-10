# Build the alineryd daemon, alinery-mcp binary, and alinery-runner sidecar (workspace members)
# and place them as Tauri sidecars `alineryd-<triple>`, `alinery-mcp-<triple>`, and
# `alinery-runner-<triple>`. Runs from beforeDevCommand (debug) and beforeBuildCommand
# (release). Separate crates mean we pre-build here so the tauri build-script doesn't
# need placeholders.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # src-tauri
PROFILE="${1:-release}"
TRIPLE="$(rustc -vV | sed -n 's/host: //p')"
# Ask cargo where it actually builds rather than assuming $DIR/target. Either
# CARGO_TARGET_DIR or a .cargo/config.toml `build.target-dir` moves it elsewhere,
# and the build below then succeeds while the copy looks for binaries that were
# never written there. Not hypothetical: a machine-local, uncommitted config
# pointing every worktree at one shared build cache is what surfaced this.
# --no-deps keeps it to the workspace and off the network. Parsed with node,
# which is already required to build, rather than a regex: a "[^\"]*" capture
# stops at the first quote and so truncates any target dir whose path contains
# an escaped quote or backslash, which is exactly where a regex over JSON goes
# wrong quietly instead of loudly.
TARGET="$(cargo metadata --format-version 1 --no-deps --manifest-path "$DIR/Cargo.toml" |
  node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).target_directory')"
[ -n "$TARGET" ] || { echo "ERROR: could not resolve cargo target directory" >&2; exit 1; }
SIDE="$DIR/alineryd-$TRIPLE"
MCP_SIDE="$DIR/alinery-mcp-$TRIPLE"
RUNNER_SIDE="$DIR/alinery-runner-$TRIPLE"
if [ "$PROFILE" = "release" ]; then
  cargo build --release -p alineryd -p alinery-mcp -p alinery-runner --manifest-path "$DIR/Cargo.toml"
  cp "$TARGET/release/alineryd" "$SIDE"
  cp "$TARGET/release/alinery-mcp" "$MCP_SIDE"
  cp "$TARGET/release/alinery-runner" "$RUNNER_SIDE"
else
  cargo build -p alineryd -p alinery-mcp -p alinery-runner --manifest-path "$DIR/Cargo.toml"
  cp "$TARGET/debug/alineryd" "$SIDE"
  cp "$TARGET/debug/alinery-mcp" "$MCP_SIDE"
  cp "$TARGET/debug/alinery-runner" "$RUNNER_SIDE"
fi
chmod +x "$SIDE" "$MCP_SIDE" "$RUNNER_SIDE"
echo "sidecar ready: $SIDE"
echo "mcp sidecar ready: $MCP_SIDE"
echo "runner sidecar ready: $RUNNER_SIDE"
