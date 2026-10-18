#!/usr/bin/env bash
# Packaged OMP must never be found via PATH. alineryd may compare the harness
# sentinel `harness.binary == "omp"` and pass the resolve_packaged_omp_path
# result into the runner argv — it must not Command::new("omp") or pass the
# literal name as an exec target.
#
# Run: ./scripts/tests/check-omp-no-path-fallback.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Spawn lives in the daemon library after the release binary became a thin
# wrapper. The rule is about every daemon source, not the wrapper file.
SRC="$ROOT/alinery-app/src-tauri/alineryd/src"
FILES=()
while IFS= read -r file; do
  FILES+=("$file")
done < <(find "$SRC" -name '*.rs' -type f | sort)
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "ERROR: no daemon sources under $SRC" >&2
  exit 1
fi
status=0

if grep -nE 'Command::new\("omp"\)|CommandBuilder::new\("omp"\)' "${FILES[@]}"; then
  echo "ERROR: alineryd must not exec the PATH name omp" >&2
  status=1
fi

if grep -nE '\.arg\("omp"\)' "${FILES[@]}"; then
  echo "ERROR: .arg(\"omp\") would make omp an execvp target" >&2
  status=1
fi

if ! grep -q 'resolve_packaged_omp_path' "${FILES[@]}"; then
  echo "ERROR: spawn must call resolve_packaged_omp_path for the omp sentinel" >&2
  status=1
fi

if ! grep -q 'harness.binary == "omp"' "${FILES[@]}"; then
  echo "ERROR: missing sentinel comparison harness.binary == \"omp\"" >&2
  status=1
fi

# Runner argv after `--` must be the resolved path, not harness.binary.clone().
if awk '
  FNR == 1 { in_args=0; saw_dash=0 }
  /cmd\.args\(vec!\[/ { in_args=1 }
  in_args && /"--"\.to_string\(\)/ { saw_dash=1 }
  in_args && saw_dash && /harness\.binary\.clone\(\)/ { hit=1 }
  in_args && /\]\);/ { in_args=0; saw_dash=0 }
  END { exit hit ? 0 : 1 }
' "${FILES[@]}"; then
  echo "ERROR: runner argv still passes harness.binary.clone() after --" >&2
  status=1
fi

# Chat's RPC spawn is a second Command, not CommandBuilder. Same rule: never exec
# the harness sentinel; pass the packaged path from resolve_packaged_omp_path.
if grep -nE 'cmd\.arg\(&harness\.binary\)' "${FILES[@]}"; then
  echo "ERROR: RPC runner argv still passes harness.binary after --" >&2
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "OK: alineryd does not PATH-exec omp"
fi
exit "$status"
