#!/usr/bin/env bash
# A command that resolves its repo with a local-only helper (target_repo_for_app, active_repo,
# require_owned_active_repo, validate_known_target_repo) cannot serve a remote repository: those
# helpers fail closed on a remote key. That is safe, but it must be a decision, not an accident.
#
# Every #[tauri::command] that uses one of them must either route remote repos (RepoRef, owned_target,
# remote_call, with_library, ...) or be listed in scripts/tests/remote-local-only.txt with the reason.
# A listed command that now routes, or no longer exists, must be removed from the list.
#
# The routing check is textual and looks at the command's own body, like the other source guards.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node --input-type=module - "$ROOT" <<'JS'
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
const sources = path.join(root, "alinery-app/src-tauri/src");
const LOCAL_ONLY = ["target_repo_for_app(", "active_repo()", "require_owned_active_repo(", "validate_known_target_repo("];
const ROUTES = [
  "RepoRef",
  "owned_target(",
  "owned_active_target(",
  "target_or_active_ref(",
  "target_repo_ref_for_app(",
  "active_repo_ref(",
  "require_active_target(",
  "repo_client(",
  "task_client(",
  "with_library",
  "remote_call(",
  "is_remote_repo_key(",
];

const listed = new Map(
  fs
    .readFileSync(path.join(root, "scripts/tests/remote-local-only.txt"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [name, ...reason] = line.split(/\s+/);
      return [name, reason.join(" ")];
    }),
);

const found = new Set();
let failures = 0;
for (const file of fs.readdirSync(sources).filter((name) => name.endsWith(".rs"))) {
  const source = fs.readFileSync(path.join(sources, file), "utf8");
  for (const match of source.matchAll(/#\[tauri::command\][^\n]*\n(?:#\[[^\n]*\]\n)*(?:pub\(crate\) )?(?:async )?fn (\w+)/g)) {
    const end = source.indexOf("\n}\n", match.index);
    const body = source.slice(match.index, end < 0 ? source.length : end);
    if (!LOCAL_ONLY.some((pattern) => body.includes(pattern))) continue;
    const name = match[1];
    if (ROUTES.some((pattern) => body.includes(pattern))) {
      if (listed.has(name)) {
        console.error(`ERROR: ${file}:${name} routes remote repositories now; remove it from scripts/tests/remote-local-only.txt`);
        failures++;
      }
      continue;
    }
    found.add(name);
    if (!listed.has(name)) {
      console.error(`ERROR: ${file}:${name} resolves its repo locally and does not route a remote one; route it, or list it in scripts/tests/remote-local-only.txt with the reason`);
      failures++;
    }
  }
}
for (const name of listed.keys()) {
  if (!found.has(name) && !failures) {
    console.error(`ERROR: remote-local-only.txt lists ${name}, which is not a local-only command; remove it`);
    failures++;
  }
}
if (failures) process.exit(1);
console.log(`OK: every repo-resolving command routes remote repositories or is listed as local-only (${listed.size} listed)`);
JS
