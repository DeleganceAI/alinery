// Diagnostic only: real provider failure is NOT assumed to reject native capture.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const dir = path.dirname(fileURLToPath(import.meta.url));
let driver = readFileSync(path.join(dir, "external_ownership_continuation_controller.mjs"), "utf8");
assert.equal(sha(driver), "310b4a46c4306d514f92229c95ec19b7a7e4a211d0584eeb545ca6e7d597e28e");
const base = readFileSync(path.join(dir, "external_controller_ownership_smoke.mjs"), "utf8");
assert.equal(sha(base), "6a98950cfd190e504ac10fa8bcb6ea5cce9351e9f8a9762a47ed34b136a7d1e0");
// Apply to the fixture AFTER the retained driver installs its original-callback decorator.
function alter(source) {
  const replace = (before, after) => {
    assert.equal(source.split(before).length, 2, `Unique anchor required: ${before}`);
    source = source.replace(before, after);
  };
  replace('"alinery-autolearn-"', '"controller-errors-native-"');
  replace('assert.equal(captureRequests, 4);', 'assert.equal(captureRequests, 3);');
  replace('for (const ordinal of [1, 2]) assert.match', 'assert.equal(existsSync(skillPath(1)), false);\n        for (const ordinal of [2]) assert.match');
  replace('const ordinal = Math.ceil(captureRequests / 2);', 'const ordinal = events.filter(event => event.type === "capture-admitted").at(-1)?.ordinal;\n        assert.ok(ordinal === 1 || ordinal === 2);');
  replace('if (captureRequests % 2 === 1) {', `if (ordinal === 1) {
          record({ type: "native-provider-error-input", ordinal, status: 400 });
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { message: "controller-errors deliberate invalid request", type: "invalid_request_error", code: "invalid_request" } }));
        } else if (captureRequests === 2) {`);
  replace('let firstFence;', 'let firstFence;\n        const nativeOutcomes = [];\n        const catchOutcomes = [];');
  replace('const result = Reflect.apply(originalCatch, this, args);', `const nativeHandler = args[0];
              const result = Reflect.apply(originalCatch, this, [typeof nativeHandler === "function" ? function (error) {
                catchOutcomes.push({ name: error?.name, message: error?.message });
                return Reflect.apply(nativeHandler, this, [error]);
              } : nativeHandler]);`);
  replace('await nativeCapture(capture);', `let signal;
              try {
                await nativeCapture(function (...args) { signal = args[0]; return Reflect.apply(capture, this, args); });
                nativeOutcomes.push({ ordinal, status: "fulfilled", aborted: signal?.aborted });
              } catch (error) {
                nativeOutcomes.push({ ordinal, status: "rejected", aborted: signal?.aborted, name: error?.name, message: error?.message });
                throw error;
              }`);
  replace('const ordinal = ++refreshes;', '++refreshes;\n          const ordinal = captureAttempts;');
  replace('captureAttempts !== 2 || refreshes !== 2', 'captureAttempts !== 2 || refreshes !== 1');
  const begin = source.indexOf('        await post("/await", { type: "refresh-held", ordinal: 1 });');
  const end = source.indexOf('        await awaitExhaustion();', begin);
  assert.ok(begin > 0 && end > begin);
  source = source.slice(0, begin) + source.slice(end);
  replace('captureAttempts === 2 && refreshes === 2 && active.size === 0', 'captureAttempts === 2 && refreshes === 1 && active.size === 0');
  replace('const result = { status: "passed-bounded-subset", firstFence, chainRegistrations, chainEvents, gaps, faults };', `check(nativeOutcomes.length === 2 && nativeOutcomes.every(value => value.aborted === false), "Native non-aborted outcomes not captured");
        const result = { status: "passed-bounded-subset", nativeOutcomes, catchOutcomes,
          genuineRejectionEstablished: nativeOutcomes[0].status === "rejected", firstFence, chainRegistrations, chainEvents, gaps, faults };`);
  return source;
}
const insertion = 'const root = mkdtempSync(path.join(tmpdir(), "ownership-continuation-"));';
assert.equal(driver.split(insertion).length, 2);
driver = driver.replace(insertion, `source = (${alter.toString()})(source);\nconst root = mkdtempSync(path.join(tmpdir(), "controller-errors-derivative-"));`);
driver = driver.replace('["native ordinary rejection/logger failure",', '["ordinary provider failure may fulfill capture; genuine rejection still required", "native logger failure",');
const root = mkdtempSync(path.join(tmpdir(), "controller-errors-driver-"));
try {
  writeFileSync(path.join(root, "external_controller_ownership_smoke.mjs"), base);
  const script = path.join(root, "driver.mjs");
  writeFileSync(script, driver);
  console.log(JSON.stringify({ driverSha256: sha(driver), candidate: "original capture with HTTP400; pending replay retained" }));
  const result = spawnSync(process.execPath, [script, "normal"], { env: process.env, encoding: "utf8", timeout: 110000, maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assert.ifError(result.error);
  assert.equal(result.status, 3, "Native error diagnostic failed; not a coverage result");
  process.exitCode = 3;
} finally {
  rmSync(root, { recursive: true, force: true });
}
