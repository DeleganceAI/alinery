// Opt-in native cancellation challenge; retained fixture remains byte-identical.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "abort";
assert.ok(["abort", "new-session"].includes(mode), "Expected abort or new-session");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const binary = process.env.OMP_BIN || "/Applications/Alinery.omp/omp";
assert.equal(sha(readFileSync(binary)), "9d4b74e20502f06348143fc3fbd630326d16c1a11a7eb0a94b44e5818aa78e47");
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "external_controller_ownership_smoke.mjs");
let source = readFileSync(fixture, "utf8");
assert.equal(sha(source), "6a98950cfd190e504ac10fa8bcb6ea5cce9351e9f8a9762a47ed34b136a7d1e0");
const replace = (before, after) => {
  assert.equal(source.split(before).length, 2, `Unique fixture anchor required: ${before}`);
  source = source.replace(before, after);
};
// Cancellation omits capture 1's final model request. Route fixture responses by
// the already-recorded actual invocation, not the baseline's request-pair count.
replace("const primaryStages = new Map();", "const primaryStages = new Map();\nconst captureStages = new Map();");
replace(
  "const ordinal = Math.ceil(captureRequests / 2);",
  `const ordinal = events.findLast(event => event.type === "capture-admitted").ordinal;
        const stage = captureStages.get(ordinal) ?? 0;
        captureStages.set(ordinal, stage + 1);`,
);
replace("if (captureRequests % 2 === 1) {", "if (stage === 0) {");
replace("assert.equal(captureRequests, 4);", "assert.equal(captureRequests, 3);");
if (mode === "new-session") {
  replace('else response.end("{}");\n      record({ type: "refresh-held"', 'else held.set("refresh-2", response);\n      record({ type: "refresh-held"');
}
replace(
  "await nativeCapture(capture);",
  `await nativeCapture(function (...args) {
                const signal = args[0];
                signal.addEventListener("abort", () => {
                  void trace({ type: "native-capture-aborted", ordinal, active: [...active] });
                }, { once: true });
                return Reflect.apply(capture, this, args);
              });`,
);
replace(
  'await post("/release", { key: "refresh-1" });',
  `const priorSessionId = session.sessionManager.getSessionId();
        let transitionSettled = false;
        const transition = ${mode === "abort" ? "session.abort()" : "session.newSession()"};
        const observedTransition = transition.then(value => {
          transitionSettled = true;
          return value;
        });
        await post("/await", { type: "native-capture-aborted", ordinal: 1 });
        check(active.has("capture-1"), "Abort released held relevant refresh");
        check(finalize(revision).status === "waiting", "Abort falsely authorized finalization");
        await trace({ type: "lifecycle-held", mode: ${JSON.stringify(mode)}, transitionSettled, priorSessionId, active: [...active] });
        await post("/release", { key: "refresh-1" });
        const transitionResult = await observedTransition;
        ${mode === "new-session" ? 'check(transitionResult === true && session.sessionManager.getSessionId() !== priorSessionId, "Native newSession did not change transcript");' : ""}
        await trace({ type: "lifecycle-returned", mode: ${JSON.stringify(mode)}, transitionResult, priorSessionId, currentSessionId: session.sessionManager.getSessionId(), active: [...active] });
        ${
          mode === "new-session"
            ? `await post("/await", { type: "refresh-held", ordinal: 2 });
        check(active.has("capture-2") && finalize(revision).status === "waiting", "Transition cleared old pending continuation");
        await trace({ type: "late-refresh-owned-after-transition", active: [...active] });
        await post("/release", { key: "refresh-2" });`
            : ""
        }`,
);
const root = mkdtempSync(path.join(tmpdir(), "controller-lifecycle-"));
try {
  const script = path.join(root, "probe.mjs");
  writeFileSync(script, source);
  console.log(JSON.stringify({ mode, derivativeSha256: sha(source) }));
  const result = spawnSync(process.execPath, [script], { env: { ...process.env, OMP_BIN: binary }, encoding: "utf8", timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assert.ifError(result.error);
  assert.equal(result.status, 0, "Native lifecycle oracle failed");
  console.log(
    JSON.stringify({
      status: "coverage-gap",
      boundedLifecycle: mode,
      remaining: ["rejection transparency", "switch/branch/replacement", "startup/multiple owners", "durable authority"],
    }),
  );
  process.exitCode = 3;
} finally {
  rmSync(root, { recursive: true, force: true });
}
