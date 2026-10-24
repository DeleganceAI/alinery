// Diagnostic only: retain the ORIGINAL synchronous scheduling callback, not its rejected leaf.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "normal";
assert.ok(["normal", "abort", "new-session", "semantics"].includes(mode));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const binary = process.env.OMP_BIN || "/Applications/Alinery.omp/omp";
assert.equal(sha(readFileSync(binary)), "9d4b74e20502f06348143fc3fbd630326d16c1a11a7eb0a94b44e5818aa78e47");
const directory = path.dirname(fileURLToPath(import.meta.url));
let source = readFileSync(path.join(directory, "external_controller_ownership_smoke.mjs"), "utf8");
assert.equal(sha(source), "6a98950cfd190e504ac10fa8bcb6ea5cce9351e9f8a9762a47ed34b136a7d1e0");
const replace = (before, after) => {
  assert.equal(source.split(before).length, 2, `Unique fixture anchor required: ${before}`);
  source = source.replace(before, after);
};
const begin = source.indexOf("        const track = (promise, id, ordinal, parent = null) => {");
const end = source.indexOf("        const awaitExhaustion", begin);
assert.ok(begin > 0 && end > begin);
source = source.slice(0, begin) + `        // No then/rejection observer is installed on any native chain leaf.
        const track = (promise, id, ordinal) => {
          const originalCatch = promise.catch;
          Object.defineProperty(promise, "catch", {
            configurable: true, writable: true,
            value: function (...args) {
              const result = Reflect.apply(originalCatch, this, args);
              chainRegistrations++;
              const originalFinally = result.finally;
              Object.defineProperty(result, "finally", {
                configurable: true, writable: true,
                value: function (callback) {
                  if (typeof callback !== "function") return Reflect.apply(originalFinally, this, [callback]);
                  const child = id + "/finally-" + (++sequence);
                  active.add(child);
                  chainRegistrations++;
                  chainEvents.push({ type: "reserve", id: child, parent: id, active: [...active] });
                  const release = () => {
                    active.delete(child);
                    chainEvents.push({ type: "callback-return", id: child, active: [...active], captureAttempts });
                    if (!active.size) {
                      if (captureAttempts !== 2 || refreshes !== 2) gaps.push({ id: child, captureAttempts, refreshes });
                      for (const resolve of exhausted) resolve();
                      exhausted.clear();
                    }
                  };
                  try {
                    return Reflect.apply(originalFinally, this, [function (...callbackArgs) {
                      try { return Reflect.apply(callback, this, callbackArgs); }
                      finally { release(); }
                    }]);
                  } catch (error) { release(); throw error; }
                },
              });
              return result;
            },
          });
          return promise;
        };
` + source.slice(end);
replace('          reserve(id);\n          const task =', `          if (ordinal === 2) check([...active].some(value => value.startsWith("capture-1/finally-")), "Native pending replay lost scheduling ownership");
          reserve(id);
          const task =`);
// Exercise the exact same decorator with explicit Promise errors in the packaged
// runtime. These are semantic fault-injection cases, NOT native logger failures.
if (mode === "semantics") {
  const scenario = process.argv[3];
  assert.ok(["catch-plain", "catch-decorated", "finally-plain", "finally-decorated"].includes(scenario));
  replace('["ready", "response", "extension_error"].includes(event.type)', '["ready", "response", "extension_error", "promise-semantics", "native-exit-append", "native-exit-flush"].includes(event.type)');
  replace('        session.subscribe((event) => {', `
        // Establish a real assistant entry so native fatal recording is eligible.
        await session.prompt("Reply briefly for the isolated fatal persistence probe.");
        await session.waitForIdle();
        await session.sessionManager.flush();
        const { readFileSync: readNativeFile } = await import("node:fs");
        const nativeAppend = session.sessionManager.appendCustomEntry;
        const nativeFlush = session.sessionManager.flushSync;
        let fatalAppended = false;
        session.sessionManager.appendCustomEntry = function (...args) {
          const result = Reflect.apply(nativeAppend, this, args);
          if (args[1]?.kind === "fatal") {
            fatalAppended = true;
            process.stdout.write(JSON.stringify({ type: "native-exit-append", kind: args[1].kind,
              active: [...active], entryId: result }) + "\\n");
          }
          return result;
        };
        session.sessionManager.flushSync = function (...args) {
          const result = Reflect.apply(nativeFlush, this, args);
          if (fatalAppended) process.stdout.write(JSON.stringify({ type: "native-exit-flush",
            active: [...active], persistedFatal: readNativeFile(this.getSessionFile(), "utf8").split("\\n").filter(Boolean).some(line => JSON.parse(line).data?.kind === "fatal") }) + "\\n");
          return result;
        };
        const kind = ${JSON.stringify(scenario.split("-")[0])};
        const decorated = ${scenario.endsWith("-decorated")};
        const marker = new Error("ownership-semantic-" + kind + "-" + decorated);
        const handler = (reason, rejectedLeaf) => {
          if (reason !== marker) return;
          // Synchronous evidence before native fatal shutdown. Do not remove or
          // replace OMP's own handler, intercept exit, or handle the final leaf.
          process.stdout.write(JSON.stringify({ type: "promise-semantics", kind, decorated,
            originalLeafUnhandled: rejectedLeaf === leaf, reservationsReleased: active.size === 0 }) + "\\n");
        };
        process.on("unhandledRejection", handler);
        const root = kind === "catch" ? Promise.reject(new Error("input rejection")) : Promise.resolve();
        const input = decorated ? track(root, "semantic", 0) : root;
        const leaf = input.catch(() => { throw marker; }).finally(() => {
          if (kind === "finally") throw marker;
        });
        return await new Promise(() => {}); // Preserve native fatal termination.
        session.subscribe((event) => {`);
  const outcomeBegin = source.indexOf('  assert.equal(outcome.status, "passed-bounded-subset"');
  const outcomeEnd = source.indexOf("\n} catch (error) {", outcomeBegin);
  assert.ok(outcomeBegin > 0 && outcomeEnd > outcomeBegin);
  source = source.slice(0, outcomeBegin) + `
  assert.equal(outcome.type, "process-closed", JSON.stringify(outcome));
  assert.equal(outcome.code, 1, "Native unhandled rejection must retain fatal exit");
  const semantics = events.find(event => event.type === "promise-semantics");
  assert.equal(semantics?.originalLeafUnhandled, true, "Original rejected leaf was not observed");
  assert.equal(semantics?.reservationsReleased, true, "Synchronous callback reservation leaked");
  const append = events.find(event => event.type === "native-exit-append");
  const flush = events.find(event => event.type === "native-exit-flush");
  assert.equal(append?.kind, "fatal", "Original native fatal append was not observed");
  assert.deepEqual(append.active, [], "Expected fatal tail after callback release");
  assert.equal(flush?.persistedFatal, true, "Native fatal flush did not return with fatal entry");
  assert.deepEqual(flush.active, [], "Expected native flush outside callback scope");
  console.log(JSON.stringify({ status: "observed-native-fatal-semantics", semantics, nativeExitCode: outcome.code, events }, null, 2));
` + source.slice(outcomeEnd);
}
const root = mkdtempSync(path.join(tmpdir(), "ownership-continuation-"));
try {
  const fixture = path.join(root, "external_controller_ownership_smoke.mjs");
  writeFileSync(fixture, source);
  let script = fixture;
  if (["abort", "new-session"].includes(mode)) {
    let lifecycle = readFileSync(path.join(directory, "external_controller_lifecycle_smoke.mjs"), "utf8");
    assert.equal(sha(lifecycle), "d8da8f85722101cce6e180306a12e2c3953b7f5ce32a6b89677cc31eabcc80a7");
    lifecycle = lifecycle.replace("6a98950cfd190e504ac10fa8bcb6ea5cce9351e9f8a9762a47ed34b136a7d1e0", sha(source));
    script = path.join(root, "lifecycle.mjs");
    writeFileSync(script, lifecycle);
  }
  console.log(JSON.stringify({ mode, derivativeSha256: sha(source), scope: "synchronous native scheduling callback; simulated authority" }));
  const result = spawnSync(process.execPath, [script, ...(["abort", "new-session"].includes(mode) ? [mode] : [])], {
    env: { ...process.env, OMP_BIN: binary }, encoding: "utf8", timeout: 100000, maxBuffer: 8 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assert.ifError(result.error);
  assert.equal(result.status, ["normal", "semantics"].includes(mode) ? 0 : 3, "Native callback ownership diagnostic failed");
  console.log(JSON.stringify({ status: "coverage-gap", mode, remaining: ["native ordinary rejection/logger failure", "startup/multiowner/generation", "async callback descendants", "hidden forwarded outcomes", "durable authority"] }));
  process.exitCode = 3;
} finally {
  rmSync(root, { recursive: true, force: true });
}
