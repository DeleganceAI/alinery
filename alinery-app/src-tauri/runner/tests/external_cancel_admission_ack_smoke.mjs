// External-only derivative experiment. Never edits its retained input fixtures.
// Uses exact-hash guarded disposable copies to reuse their native setup/cleanup,
// not a copied native scheduler/helper/provider. No production readiness claim.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--help")) {
  console.log(
    "Runs hash-guarded JS/Python lifecycle fixtures with local irrevocable preforward withdrawal. Exit 3 = bounded local ACK observed, forwarded-reply gaps remain; 1 = failure. Native postforward scenarios retained. Loopback only.",
  );
  process.exit(0);
}
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), "alinery-cancel-ack-"));
const replace = (source, before, after) => {
  assert.equal(source.split(before).length, 2, `Expected one source anchor: ${before.slice(0, 90)}`);
  return source.replace(before, after);
};
const load = (name, expected) => {
  const source = readFileSync(path.join(dir, name), "utf8");
  assert.equal(createHash("sha256").update(source).digest("hex"), expected, "Retained evidence changed; review before running");
  return source;
};
try {
  let js = load("external_js_lifecycle_smoke.mjs", "74de8ca8614a0dc22a6c97a1ae24e0881fc5bff9d0ef635e7c7f4de5203c388c");
  js = replace(
    js,
    "toolSession: options.session, owner, invocation: ++invocation, live: true",
    "toolSession: options.session, signal: options.signal, owner, invocation: ++invocation, live: true",
  );
  js = replace(
    js,
    "            c.forward = () => {",
    `            c.admissionState = "held";
            const withdraw = () => {
              if (c.admissionState !== "held") return;
              c.admissionState = "withdrawn-before-native";
              c.active = false;
              note("local-never-forwarded-ack", c.request);
            };
            if (execution.signal?.aborted) withdraw();
            else execution.signal?.addEventListener("abort", withdraw, { once: true });
            c.forward = () => {
              if (c.admissionState === "withdrawn-before-native") {
                note("delayed-grant-inert", c.request);
                return;
              }
              c.admissionState = "forwarded-unknown";`,
  );
  js = replace(
    js,
    "        pre.forward(); // Original dispatcher sees the dead/missing run; no synthesized reply.",
    `        check(pre.admissionState === "withdrawn-before-native" && !pre.active && !pre.forwarded, "Local cancellation not acknowledged");
        pre.forward(); // Late grant cannot regain the sole forwarding capability.
        pre.forward(); // Replay stays inert, without a duplicate native callback.
        check(!pre.forwarded && !pre.reply && !pre.nativeId, "Withdrawn request reached native dispatcher");`,
  );
  js = replace(js, '          status: "coverage-gap",\n          callerResult:', '          status: "passed-local-withdrawal-only",\n          callerResult:');
  js = replace(js, "          delayedOriginalCallbackInvoked: true,", "          delayedOriginalCallbackInvoked: false,\n          localAdmissionState: pre.admissionState,");
  js = replace(
    js,
    '"Dead native session suppresses reply; no native terminal admission ACK. Zero provider observation plus pinned dispatcher guard is not general admission closure proof."',
    '"External sole forwarder revoked before delegation. Native cancellation result preserved; not a native producer settlement ACK."',
  );

  let py = load("external_py_lifecycle_smoke.mjs", "abd5adec33e00d6e2ffda48e2c8d177ad59dad1a808b9a83da4143a641384057");
  py = replace(
    py,
    "            record.reached.resolve();\n            await record.admission.promise;",
    `            record.admissionState = "held";
            const withdraw = () => {
              if (record.admissionState !== "held") return;
              record.admissionState = "withdrawn-before-native";
              leases.delete(record);
            };
            if (target.signal?.aborted) withdraw();
            else target.signal?.addEventListener("abort", withdraw, { once: true });
            record.reached.resolve();
            await record.admission.promise;
            if (record.admissionState === "withdrawn-before-native") {
              record.bound.resolve();
              // Caller has already returned its genuine native cancellation result.
              // Empty transport response only; no synthetic native tool envelope.
              return new Response(null, { status: 204 });
            }
            record.admissionState = "forwarded-unknown";`,
  );
  py = replace(
    py,
    "        pre.reply.resolve();\n        pre.admission.resolve();",
    `        const nativeCancelledCell = await bounded(preCell, "native cancellation before delayed grant");
        check(pre.admissionState === "withdrawn-before-native" && !leases.has(pre) && !pre.forwarded, "Local withdrawal not acknowledged");
        pre.reply.resolve();
        pre.admission.resolve();`,
  );
  py = replace(
    py,
    '        report("cancel-before-admission", !noProducer || pre.id ? "counterexample" : pre.envelope?.ok === false ? "passed-bounded-subset" : "coverage-gap", {',
    `        check(!pre.forwarded && !pre.id && !pre.envelope && noProducer, "Withdrawn Python request forwarded");
        report("cancel-before-admission", "passed-local-withdrawal-only", {
          localAdmissionState: pre.admissionState,
          nativeCancelledCell,`,
  );
  py = replace(
    py,
    '"Rejected/no-handle native envelope remains unknown and blocked; never released as producer settlement"',
    '"Local sole forwarder revoked before delegation; delayed admission inert. This is not native producer settlement."',
  );

  for (const [language, source] of [
    ["js", js],
    ["py", py],
  ]) {
    const filename = path.join(root, `${language}.mjs`);
    writeFileSync(filename, source);
    const child = spawn(process.execPath, [filename], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    console.log(JSON.stringify({ language, generatedSha256: createHash("sha256").update(source).digest("hex"), exit: code, stdout, stderr }));
    const outcome = JSON.parse(stdout);
    assert.equal(code, language === "js" ? 3 : 0, "Unexpected retained native fixture result");
    assert.deepEqual(outcome.faults, []);
    const pre = language === "js" ? outcome.scenarios.preAdmissionAbort : outcome.results.find((item) => item.name === "cancel-before-admission");
    assert.equal(pre.status, "passed-local-withdrawal-only");
    assert.equal(pre.localAdmissionState, "withdrawn-before-native");
    assert.match(JSON.stringify(pre), language === "js" ? /Command aborted/ : /KeyboardInterrupt: Execution interrupted/);
    assert.equal(language === "js" ? pre.reservationRetained : pre.retained, false);
    console.log(
      JSON.stringify({ language, status: "coverage-gap", localWithdrawal: pre, limitation: "No general forwarded-but-unacknowledged recovery or durable finalization proof" }),
    );
  }
  process.exitCode = 3;
} finally {
  rmSync(root, { recursive: true, force: true });
}
