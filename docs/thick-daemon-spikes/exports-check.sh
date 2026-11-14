#!/usr/bin/env bash
# S0.1 left-over (plan 4.2): does a `file:` package with `"exports": { "./*": "./gen/*.ts" }` resolve
# the extensionless subpath `alinery-proto/alinery/v1/admin_pb` under bun run, bun build --compile,
# tsc --noEmit (moduleResolution "bundler") and Vite?
#
# Everything is built in a scratch dir outside the repo. Two layouts, as the plan wires them:
#   daemon/  installs `file:../proto` with bun (vinculum-daemon's package manager)
#   app/     installs `file:../proto` with npm (alinery-app's package manager: a symlink)
# Each runs twice: once with proto/ having no node_modules of its own, once after
# `npm install --omit=dev` inside proto/, because a symlinked package resolves its own imports
# (`@bufbuild/protobuf/codegenv2`) from its real path, not from the consumer's node_modules.
#
# Result (2026-11-05, Bun 1.4.3, npm 11.20, tsc 5.8.3, Vite 7.3.6): the `exports` mapping itself
# resolves everywhere (a missing subpath is rejected, so the check is real). What breaks is the
# package's own import of `@bufbuild/protobuf/codegenv2`: npm symlinks the package and bun links
# each file to proto/, so every tool resolves it from proto/'s real path. Without proto/node_modules
# every row fails (tsc only degrades the types to `Message`). `npm install --omit=dev` in proto/
# fixes all rows. preserveSymlinks fixes the npm layout (Vite, tsc, bun) but not bun's per-file links.
#
# Usage, from docs/thick-daemon-spikes, with Bun 1.4.3 and node/npm on PATH and
# `npm ci` already run in alinery-app (for Vite):
#   ./exports-check.sh [scratch-dir]
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
APP="$HERE/../../alinery-app"
S=${1:-$(mktemp -d "${TMPDIR:-/tmp}/s01-exports.XXXXXX")}
VITE="$APP/node_modules/.bin/vite"
TSC="$HERE/node_modules/.bin/tsc"
rm -rf "$S/proto" "$S/daemon" "$S/app"
mkdir -p "$S"
echo "scratch: $S  bun $(bun --version)  node $(node --version)  vite $("$VITE" --version 2>/dev/null | cut -d' ' -f1)"

# --- the package, as in the plan's S0.1 proto/package.json ---
mkdir -p "$S/proto"
cp -r "$HERE/gen" "$S/proto/gen"
cat >"$S/proto/package.json" <<'EOF'
{
  "name": "alinery-proto",
  "private": true,
  "type": "module",
  "exports": { "./*": "./gen/*.ts" },
  "dependencies": { "@bufbuild/protobuf": "2.16.0" },
  "devDependencies": { "@bufbuild/buf": "1.75.0", "@bufbuild/protoc-gen-es": "2.16.0" },
  "scripts": { "gen": "buf generate && buf lint" }
}
EOF

# One consumer source for both layouts. tasks_pb imports ./common_pb extensionless inside the package.
MAIN='import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Capability, HelloResponseSchema } from "alinery-proto/alinery/v1/admin_pb";
import { file_alinery_v1_tasks } from "alinery-proto/alinery/v1/tasks_pb";
const m = create(HelloResponseSchema, { protocol: 25, buildId: "b", capabilities: [Capability.VIEW, Capability.ACT] });
const back = fromBinary(HelloResponseSchema, toBinary(HelloResponseSchema, m));
const n: number = back.protocol;
console.log(`resolved ok protocol=${n} caps=${back.capabilities.join(",")} deps=${file_alinery_v1_tasks.dependencies.length}`);'
NEG='import { Nope } from "alinery-proto/alinery/v1/nope_pb";
console.log(Nope);'
DEPS='"dependencies": { "alinery-proto": "file:../proto", "@bufbuild/protobuf": "2.16.0" }'

for consumer in daemon app; do
  mkdir -p "$S/$consumer/src"
  printf '%s\n' "$MAIN" >"$S/$consumer/src/main.ts"
  printf '%s\n' "$NEG" >"$S/$consumer/src/neg.ts"
  printf '{ "name": "%s", "private": true, "type": "module", %s }\n' "s01-$consumer" "$DEPS" >"$S/$consumer/package.json"
done
# alinery-app/tsconfig.json resolution settings.
cat >"$S/app/tsconfig.json" <<'EOF'
{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
  "allowImportingTsExtensions": true, "strict": true, "noEmit": true, "skipLibCheck": true,
  "lib": ["ES2022", "DOM"] }, "include": ["src/main.ts"] }
EOF
sed 's/"src\/main.ts"/"src\/neg.ts"/' "$S/app/tsconfig.json" >"$S/app/tsconfig.neg.json"
cat >"$S/app/vite.config.mjs" <<'EOF'
export default { logLevel: "warn", build: { outDir: "dist", emptyOutDir: true, lib: { entry: "src/main.ts", formats: ["es"], fileName: "main" } } };
EOF
sed 's/logLevel: "warn",/logLevel: "warn", resolve: { preserveSymlinks: true },/' "$S/app/vite.config.mjs" >"$S/app/vite.preserve.mjs"

(cd "$S/daemon" && bun install >/dev/null 2>&1) || echo "bun install failed"
(cd "$S/app" && npm install --no-audit --no-fund >/dev/null 2>&1) || echo "npm install failed"
kind() { if [ -L "$1" ]; then echo "symlink -> $(readlink "$1")"; else echo "copy"; fi; }
echo "daemon/node_modules/alinery-proto: $(kind "$S/daemon/node_modules/alinery-proto")"
echo "app/node_modules/alinery-proto:    $(kind "$S/app/node_modules/alinery-proto")"

row() { printf '  %-34s %s\n' "$1" "$2"; }
check() { # name, dir, command...
  local name=$1 dir=$2 out
  shift 2
  if out=$(cd "$dir" && "$@" 2>&1); then row "$name" "PASS  $(printf '%s' "$out" | grep -m1 'resolved ok' || true)"
  else row "$name" "FAIL  $(printf '%s' "$out" | grep -m1 -iE 'error|cannot|could not|failed' | cut -c1-160)"; fi
}
neg() { # the same tool must reject a missing subpath, or the PASS above proves nothing
  local name=$1 dir=$2
  shift 2
  if (cd "$dir" && "$@") >/dev/null 2>&1; then row "$name" "FAIL (accepted a missing subpath)"; else row "$name" "ok (rejected)"; fi
}

run_all() {
  check "daemon: bun run" "$S/daemon" bun run src/main.ts
  check "daemon: bun build --compile" "$S/daemon" sh -c "bun build --compile src/main.ts --outfile '$S/daemon/main-bin' >/dev/null && cd / && '$S/daemon/main-bin'"
  neg "daemon: bun run (missing subpath)" "$S/daemon" bun run src/neg.ts
  check "app: bun run (npm layout)" "$S/app" bun run src/main.ts
  check "app: tsc --noEmit (bundler)" "$S/app" "$TSC" --noEmit -p tsconfig.json
  neg "app: tsc (missing subpath)" "$S/app" "$TSC" --noEmit -p tsconfig.neg.json
  check "app: vite build" "$S/app" sh -c "'$VITE' build --config vite.config.mjs && node dist/main.js"
  check "daemon: tsc --noEmit (bun layout)" "$S/daemon" "$TSC" --noEmit --strict --skipLibCheck --module ESNext --moduleResolution bundler --target ES2022 src/main.ts
}

echo "== proto/ without its own node_modules"
run_all
echo "   preserve-symlinks variants (still no proto/node_modules):"
check "app: vite preserveSymlinks" "$S/app" sh -c "'$VITE' build --config vite.preserve.mjs && node dist/main.js"
check "app: tsc --preserveSymlinks" "$S/app" "$TSC" --noEmit -p tsconfig.json --preserveSymlinks
check "app: bun --preserve-symlinks" "$S/app" bun --preserve-symlinks run src/main.ts
check "daemon: bun --preserve-symlinks" "$S/daemon" bun --preserve-symlinks run src/main.ts
echo "== after npm install --omit=dev in proto/"
(cd "$S/proto" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1) || echo "proto npm install failed"
run_all
