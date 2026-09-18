#!/usr/bin/env bash
# These user operations can wait on git, disk locks, or daemon control. A synchronous
# Tauri handler runs on the UI thread; an async handler must delegate to the blocking pool.
# Deliberately scoped to the RCA's command family, not cheap synchronous state readers.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node --input-type=module - "$ROOT" <<'JS'
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
const commands = {
  "task.rs": ["archive_task", "archive_task_for_repo", "restore_task_for_repo"],
  "git_ops.rs": ["remove_worktree", "remove_worktree_for_repo", "push_and_compare_url", "push_and_compare_url_for_repo", "commit_worktree", "commit_worktree_for_repo"],
  "session.rs": ["archive_session", "archive_session_for_repo"],
  "settings.rs": ["delete_all_archived_storage"],
};
let failures = 0;
for (const [file, names] of Object.entries(commands)) {
  const source = fs.readFileSync(path.join(root, "alinery-app/src-tauri/src", file), "utf8");
  // Rustfmt puts each module-level function's closing brace in column zero.
  // Follow local orchestration helpers as well as inline spawn_blocking closures.
  const functions = new Map([...source.matchAll(/^(?:pub(?:\(crate\))?\s+)?(async\s+)?fn\s+(\w+)\s*\([^]*?^\}/gm)]
    .map(match => [match[2], { async: !!match[1], text: match[0], index: match.index }]));
  function offloads(name, visited = new Set()) {
    if (visited.has(name)) return false;
    visited.add(name);
    const fn = functions.get(name);
    if (!fn) return false;
    if (/\bspawn_blocking\s*\(/.test(fn.text)) return true;
    return [...fn.text.matchAll(/\b(\w+)\s*\(/g)].some(match => offloads(match[1], visited));
  }
  for (const name of names) {
    const fn = functions.get(name);
    const command = fn && /#\[tauri::command\]\s*$/.test(source.slice(0, fn.index));
    if (!command || !fn.async || !offloads(name)) {
      console.error(`ERROR: ${file}:${name}: blocking user operation must remain an async Tauri command using spawn_blocking`);
      failures++;
    }
  }
}
if (failures) process.exit(1);
console.log("OK: 12 blocking user commands are async and reach spawn_blocking");
JS
