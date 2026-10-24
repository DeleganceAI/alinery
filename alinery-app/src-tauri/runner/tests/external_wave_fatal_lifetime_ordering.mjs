// Diagnostic only: local admission ordering, never durable authority or cleanup settlement.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const mode = process.argv[2];
assert.ok(["preadmitted", "sealed"].includes(mode));
const directory = path.dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
let source = readFileSync(path.join(directory, "external_hidden_outcome_fatal_interceptor.mjs"), "utf8");
assert.equal(sha(source), "a8b9e83791645e5e39acdac2ae0c9c212fd1c7682640ab37c7b5f9e9f94216a6");
const changes = [
  ['        postmortem.interceptUnhandledRejections(reason => {', `        const locallySealed = ${mode === "sealed"};
        // A pre-existing external hold is deliberately NOT presented as a native lifetime.
        if (!locallySealed) active.add(fatalReservation);
        const admissionAtInstall = active.has(fatalReservation);
        const unknownFatal = new Set();
        postmortem.interceptUnhandledRejections(reason => {`],
  ['          active.add(fatalReservation);', `          unknownFatal.add(fatalReservation);
          check(active.has(fatalReservation) === admissionAtInstall, "Hook fabricated prior admission");`],
  ['sameOwner: fatalOwner === session, active: [...active], consuming: false', 'sameOwner: fatalOwner === session, active: [...active], consuming: false, locallySealed, admissionAtInstall, unknownRetained: unknownFatal.has(fatalReservation)'],
  ['            check(active.has(fatalReservation), "Fatal persistence preceded interception");', '            check(unknownFatal.has(fatalReservation), "Fatal effect preceded unknown retention");'],
  ['fatalRetained: active.has(fatalReservation)', 'fatalRetained: unknownFatal.has(fatalReservation)'],
  ['  assert.deepEqual(append.active, ["fatal:" + admission.owner]);', `  assert.equal(admission.locallySealed, ${mode === "sealed"});
  assert.equal(admission.admissionAtInstall, ${mode === "preadmitted"});
  assert.equal(admission.unknownRetained, true);
  assert.deepEqual(append.active, ${mode === "sealed" ? '[]' : '["fatal:" + admission.owner]'});`],
];
const anchor = 'const anchor = ';
assert.equal(source.split(anchor).length, 2);
source = source.replace(anchor, 'changes.push(...' + JSON.stringify(changes) + ');\n' + anchor);
source = source.replace('"external-hidden-fatal-"', '"fatal-lifetime-inner-"');
// Names of all disposable nested roots remain slice-specific.
source = source.replace('const root = mkdtempSync(path.join(tmpdir(), "external-hidden-fatal-"));', 'const root = mkdtempSync(path.join(tmpdir(), "fatal-lifetime-inner-"));');
const root = mkdtempSync(path.join(tmpdir(), "fatal-lifetime-"));
try {
  for (const [name, hash] of [
    ["external_ownership_continuation_controller.mjs", "310b4a46c4306d514f92229c95ec19b7a7e4a211d0584eeb545ca6e7d597e28e"],
    ["external_controller_ownership_smoke.mjs", "6a98950cfd190e504ac10fa8bcb6ea5cce9351e9f8a9762a47ed34b136a7d1e0"],
  ]) {
    const bytes = readFileSync(path.join(directory, name));
    assert.equal(sha(bytes), hash);
    writeFileSync(path.join(root, name), bytes);
  }
  const target = path.join(root, "external_wave_fatal_lifetime_driver.mjs");
  writeFileSync(target, source);
  console.log(JSON.stringify({ mode, derivativeSha256: sha(source), certificate: "none; local external hold or sealed counterexample only" }));
  const result = spawnSync(process.execPath, [target, "catch-decorated"], { env: process.env, encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assert.ifError(result.error);
  assert.equal(result.status, 3);
  console.log(JSON.stringify({ mode, status: "coverage-gap", nativeLifetime: "unavailable in assessed boundaries", unknownReleased: false, daemonAuthority: false }));
  process.exitCode = 3;
} finally { rmSync(root, { recursive: true, force: true }); }
