#!/usr/bin/env bash
# A remote call waits on ssh: about one round trip for the repo service, two for a forwarded daemon op,
# up to SERVICE_TIMEOUT (30 s) when the host is slow. A synchronous Tauri command runs on the main
# thread, so that wait freezes the window. An async command that makes the call itself holds a runtime
# worker for the same time.
#
# Every #[tauri::command] that reaches a remote call (its own body, or a function it calls) must be
# async and reach off_main_thread / spawn_blocking, or be listed in scripts/tests/remote-offload-ok.txt
# with the reason. A listed command that no longer needs the exception, or no longer exists, must go.
#
# Textual, like the other source guards: it proves the command offloads somewhere, not that the remote
# call is inside the closure. Callees are matched by name across src/*.rs, so a name shared with an
# unrelated function can only add a finding, never hide one.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node --input-type=module - "$ROOT" <<'JS'
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
const sources = path.join(root, "alinery-app/src-tauri/src");
const REMOTE = [
  /\bremote_call(?:_within)?\s*\(/,
  /\brepo_client\s*\(/,
  /\btask_client\s*\(/,
  /\bcached_or_own_client\s*\(/,
  /\bclient_for_session\s*\(/,
  /\bwith_session_client\s*\(/,
  /\btask_daemon_for\s*\(/,
  /\.daemon\(\)/,
];
const OFFLOAD = /\b(?:off_main_thread|spawn_blocking)\s*[(:]/;

const listed = new Map(
  fs
    .readFileSync(path.join(root, "scripts/tests/remote-offload-ok.txt"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [name, ...reason] = line.split(/\s+/);
      return [name, reason.join(" ")];
    }),
);

// Rustfmt puts a module-level function's closing brace in column zero.
const functions = new Map();
const commands = [];
for (const file of fs.readdirSync(sources).filter((name) => name.endsWith(".rs"))) {
  const source = fs.readFileSync(path.join(sources, file), "utf8");
  for (const match of source.matchAll(/^(?:pub(?:\([^)]*\))?\s+)?(async\s+)?fn\s+(\w+)[^]*?^\}/gm)) {
    const fn = { file, name: match[2], async: !!match[1], text: match[0] };
    functions.set(fn.name, [...(functions.get(fn.name) ?? []), fn]);
    if (/#\[tauri::command\][^\n]*\n(?:#\[[^\n]*\]\n)*$/.test(source.slice(0, match.index))) commands.push(fn);
  }
}

function reaches(fn, test, visited = new Set()) {
  if (test(fn.text)) return true;
  for (const callee of fn.text.matchAll(/\b(\w+)\s*\(/g)) {
    if (visited.has(callee[1]) || callee[1] === fn.name) continue;
    visited.add(callee[1]);
    if ((functions.get(callee[1]) ?? []).some((next) => reaches(next, test, visited))) return true;
  }
  return false;
}

const found = new Set();
let failures = 0;
for (const fn of commands) {
  if (!reaches(fn, (text) => REMOTE.some((pattern) => pattern.test(text)))) continue;
  const offloads = fn.async && reaches(fn, (text) => OFFLOAD.test(text));
  if (offloads) {
    if (listed.has(fn.name)) {
      console.error(`ERROR: ${fn.file}:${fn.name} offloads now; remove it from scripts/tests/remote-offload-ok.txt`);
      failures++;
    }
    continue;
  }
  found.add(fn.name);
  if (!listed.has(fn.name)) {
    console.error(`ERROR: ${fn.file}:${fn.name} reaches a remote call but is not an async command that offloads; use off_main_thread, or list it in scripts/tests/remote-offload-ok.txt with the reason`);
    failures++;
  }
}
for (const name of listed.keys()) {
  if (!found.has(name) && !failures) {
    console.error(`ERROR: remote-offload-ok.txt lists ${name}, which does not need an exception; remove it`);
    failures++;
  }
}
if (failures) process.exit(1);
console.log(`OK: every command that reaches a remote call is async and offloads it (${listed.size} listed)`);
JS
