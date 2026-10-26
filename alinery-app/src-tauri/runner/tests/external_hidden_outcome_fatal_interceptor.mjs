// Diagnostic only: a non-consuming public fatal hook, not a cleanup join.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scenario = process.argv[2] ?? "catch-decorated";
assert.ok(["catch-decorated", "finally-decorated"].includes(scenario));
const directory = path.dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
let driver = readFileSync(path.join(directory, "external_ownership_continuation_controller.mjs"), "utf8");
assert.equal(sha(driver), "310b4a46c4306d514f92229c95ec19b7a7e4a211d0584eeb545ca6e7d597e28e");
const changes = [
  ['"native-exit-flush"].includes(event.type)', '"native-exit-flush", "fatal-interceptor", "fatal-before-append"].includes(event.type)'],
  ['        const kind = ', `        const { postmortem } = await import("@oh-my-pi/pi-utils");
        const fatalOwner = session;
        const fatalOwnerId = fatalOwner.sessionManager.getSessionId();
        const fatalReservation = "fatal:" + fatalOwnerId;
        postmortem.interceptUnhandledRejections(reason => {
          active.add(fatalReservation);
          process.stdout.write(JSON.stringify({ type: "fatal-interceptor", owner: fatalOwnerId,
            sameOwner: fatalOwner === session, active: [...active], consuming: false }) + "\\n");
          return false;
        });
        const kind = `],
  ['          const result = Reflect.apply(nativeAppend, this, args);', `          if (args[1]?.kind === "fatal") {
            check(this === fatalOwner.sessionManager, "Fatal writer receiver changed");
            check(active.has(fatalReservation), "Fatal persistence preceded interception");
            process.stdout.write(JSON.stringify({ type: "fatal-before-append", owner: fatalOwnerId,
              active: [...active] }) + "\\n");
          }
          const result = Reflect.apply(nativeAppend, this, args);`],
  ['reservationsReleased: active.size === 0', 'reservationsReleased: ![...active].some(id => !id.startsWith("fatal:")), fatalRetained: active.has(fatalReservation)'],
  ['  assert.deepEqual(append.active, [], "Expected fatal tail after callback release");', `  const admission = events.find(event => event.type === "fatal-interceptor");
  const before = events.find(event => event.type === "fatal-before-append");
  assert.equal(admission?.sameOwner, true);
  assert.equal(admission?.consuming, false);
  assert.equal(before?.owner, admission.owner);
  assert.ok(events.indexOf(admission) < events.indexOf(before));
  assert.ok(events.indexOf(before) < events.indexOf(append));
  assert.deepEqual(append.active, ["fatal:" + admission.owner]);
  assert.equal(semantics.fatalRetained, true, "Unknown fatal cleanup must stay blocked");`],
  ['  assert.deepEqual(flush.active, [], "Expected native flush outside callback scope");', '  assert.deepEqual(flush.active, append.active, "Fatal reservation lost before original flush");'],
];
const anchor = 'const root = mkdtempSync(path.join(tmpdir(), "ownership-continuation-"));';
assert.equal(driver.split(anchor).length, 2);
driver = driver.replace(anchor, changes.map(([before, after]) => `replace(${JSON.stringify(before)}, ${JSON.stringify(after)});`).join("\n") + "\n" + anchor);
const root = mkdtempSync(path.join(tmpdir(), "external-hidden-fatal-"));
try {
  // The original driver hash-checks this retained base before generating its child.
  const base = readFileSync(path.join(directory, "external_controller_ownership_smoke.mjs"));
  assert.equal(sha(base), "6a98950cfd190e504ac10fa8bcb6ea5cce9351e9f8a9762a47ed34b136a7d1e0");
  writeFileSync(path.join(root, "external_controller_ownership_smoke.mjs"), base);
  const target = path.join(root, "external_hidden_outcome_fatal_driver.mjs");
  writeFileSync(target, driver);
  console.log(JSON.stringify({ scenario, derivativeSha256: sha(driver), certificate: "none; fatal reservation remains blocked" }));
  const result = spawnSync(process.execPath, [target, "semantics", scenario], {
    env: process.env, encoding: "utf8", timeout: 110000, maxBuffer: 8 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assert.ifError(result.error);
  assert.equal(result.status, 3, "Expected bounded evidence with unresolved cleanup ownership");
  console.log(JSON.stringify({ status: "coverage-gap", scenario, remaining: ["hidden forwarded outcomes", "fatal cleanup settlement", "durable admission before synchronous fatal work", "all-owner and all-fatal-route coverage"] }));
  process.exitCode = 3;
} finally {
  rmSync(root, { recursive: true, force: true });
}
