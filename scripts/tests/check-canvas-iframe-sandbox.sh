#!/usr/bin/env bash
# Invariant guard: an agent-written canvas page (views/ChatCanvas.tsx) runs in an iframe whose sandbox is exactly
# CANVAS_SANDBOX ("allow-scripts", canvasSandbox.ts) and whose srcDoc goes through withCanvasCsp. The app's own CSP is
# null and the webview holds the Tauri IPC, so allow-same-origin on such a frame, or a page without the injected CSP,
# would hand an agent's script the app. Every iframe in the UI is held to this.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/alinery-app/src"
fail=0

same_origin="$(grep -rn 'allow-same-origin' --include='*.ts' --include='*.tsx' "$SRC" | grep -v '\.test\.tsx\?:' | grep -v '^[^:]*:[0-9]*:\s*\(//\|/\*\|\*\)' || true)"
if [ -n "$same_origin" ]; then
  echo "ERROR: allow-same-origin in the UI (scripts plus same origin escape an iframe sandbox):" >&2
  echo "$same_origin" >&2
  fail=1
fi
if ! grep -q 'CANVAS_SANDBOX = "allow-scripts";' "$SRC/canvasSandbox.ts"; then
  echo "ERROR: CANVAS_SANDBOX in canvasSandbox.ts is no longer exactly \"allow-scripts\"." >&2
  fail=1
fi
# Counted per file, not per line: the formatter is free to break a JSX tag across lines.
frames="$(grep -rl '<iframe' --include='*.tsx' "$SRC" | grep -v '\.test\.tsx$' || true)"
[ -n "$frames" ] || { echo "ERROR: no canvas iframe found; did ChatCanvas move?" >&2; fail=1; }
for f in $frames; do
  n="$(grep -o '<iframe' "$f" | wc -l)"
  if [ "$(grep -o 'sandbox={CANVAS_SANDBOX}' "$f" | wc -l)" != "$n" ] || [ "$(grep -o 'srcDoc={withCanvasCsp(' "$f" | wc -l)" != "$n" ]; then
    echo "ERROR: $f has an iframe without sandbox={CANVAS_SANDBOX} and srcDoc={withCanvasCsp(...)}." >&2
    fail=1
  fi
done
[ "$fail" = 0 ] && echo "OK: canvas iframes are sandboxed with scripts only and the injected CSP"
exit "$fail"
