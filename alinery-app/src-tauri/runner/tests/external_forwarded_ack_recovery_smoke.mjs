// External-only derivative of the retained native fixture; never edits its input.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--help")) {
  console.log(
    "External native Python server-handler ACK capture. --abort-race cancels during native producer creation. Exit 3: bounded evidence with remaining reconciliation gaps; 1: assertion/setup failure. No production authority.",
  );
  process.exit(0);
}
assert(process.argv.slice(2).every((arg) => arg === "--abort-race"));
const race = process.argv.includes("--abort-race");
const input = path.join(path.dirname(fileURLToPath(import.meta.url)), "external_py_lifecycle_smoke.mjs");
let source = readFileSync(input, "utf8");
const hash = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(hash(source), "abd5adec33e00d6e2ffda48e2c8d177ad59dad1a808b9a83da4143a641384057");
const replace = (from, to) => {
  assert.equal(source.split(from).length, 2, `Ambiguous/missing fixture anchor: ${from.slice(0, 100)}`);
  source = source.replace(from, to);
};
const replaceRange = (start, end, replacement) => {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert(a >= 0 && b > a);
  replace(source.slice(a, b), replacement);
};
replace("      let proxy;", "      const hostResponses = new Set();");
replace(
  "        forwardError: record.forwardError,",
  "        forwardError: record.forwardError,\n        responseHeld: hostResponses.has(record),\n        responseReturned: Boolean(record.responseReturned),\n        handlerRequestAborted: record.request?.signal.aborted,",
);
replace(
  "              const value = await getApiKey.apply(this, args);",
  `              const pending = getApiKey.apply(this, args);
              owner.abortAtAuth?.();
              const value = await pending;`,
);
replaceRange(
  "        proxy = Bun.serve({",
  "        const prototype = kernel.prototype;",
  `        const originalServe = Bun.serve;
        Bun.serve = function (options, ...rest) {
          const originalFetch = options.fetch;
          if (typeof originalFetch !== "function") return originalServe.call(this, options, ...rest);
          return originalServe.call(this, { ...options, fetch: async function (request, ...args) {
            const url = new URL(request.url);
            const candidates = [...targets.values()].filter(target => target.url === url.origin);
            if (request.method !== "POST" || url.pathname !== "/v1/tool" || !candidates.length) return originalFetch.call(this, request, ...args);
            const body = await request.clone().json();
            const matches = candidates.filter(target => target.session === body.session && target.run === body.run);
            check(matches.length === 1, "Missing/ambiguous actual native run correlation");
            const target = matches[0];
            if (body.name !== "__completion__") return originalFetch.call(this, request, ...args);
            // Scenario marker is an assertion selector, never the owner identity.
            const key = body.args?.prompt?.match(/^PY_LIFECYCLE_([A-Za-z0-9_-]+)$/)?.[1];
            const record = records.get(key);
            check(record && !record.owner, "Unplanned/duplicate producer request");
            record.owner = target.owner.session.getAgentId();
            record.run = body.run;
            record.request = request;
            leases.add(record);
            record.reached.resolve();
            await record.admission.promise;
            record.forwarded = true;
            // Original Request, signal, receiver, server argument and dispatcher remain native.
            const response = await originalFetch.call(this, request, ...args);
            record.envelope = await response.clone().json();
            const id = record.envelope.ok && record.envelope.value?.id;
            if (typeof id === "string") {
              record.id = id;
              record.wait = nativeCall("__wait__", { items: [{ kind: "completion", id }] }, target.owner).then(value => {
                const item = value?.items?.[0];
                check(value?.items?.length === 1 && item?.id === id && item.kind === "completion" && ["completed", "failed", "cancelled"].includes(item.status), "Invalid native terminal snapshot");
                record.terminal = item;
                leases.delete(record);
                return item;
              }, error => { record.waitError = String(error); });
            }
            hostResponses.add(record);
            record.bound.resolve();
            await record.reply.promise;
            hostResponses.delete(record);
            record.responseReturned = true;
            return response;
          } }, ...rest);
        };
        restores.push(() => { Bun.serve = originalServe; });
`,
);
replace(
  `          return original.call(this, code, { ...options, env: { ...options.env, PI_TOOL_BRIDGE_URL: \`http://127.0.0.1:\${proxy.port}/\${key}\` } }).finally(() => targets.delete(key));`,
  "          return original.call(this, code, options).finally(() => targets.delete(key));",
);
replace('for (const name of ["Pre", "Cancel", "Release", "Peer"])', 'for (const name of ["Cancel", "Peer"])');
replace('...(name === "Release" ? { keyGate: latch(), keyReached: latch() } : {})', '...(name === "Cancel" ? { keyGate: latch(), keyReached: latch() } : {})');
replaceRange(
  '        const pre = prepare("pre");',
  '      } catch (error) {\n        report("execution",',
  `        const cancelled = prepare("cancel");
        const peer = prepare("peer");
        const cancelAbort = new AbortController();
        const race = ${race};
        if (race) owner("Cancel").abortAtAuth = () => cancelAbort.abort(new Error("Fixture cancellation inside original native producer creation"));
        const cancelCell = run(owner("Cancel"), "cancel", cancelAbort.signal);
        const peerCell = run(owner("Peer"), "peer");
        await bounded(Promise.all([cancelled.reached.promise, peer.reached.promise]), "native requests before dispatch");
        check(owner("Cancel").toolSession !== owner("Peer").toolSession, "Same owner captured");
        peer.admission.resolve();
        await bounded(peer.bound.promise, "peer native response");
        await post("/await-provider", { key: "peer" });
        cancelled.admission.resolve();
        await bounded(cancelled.bound.promise, "original native response before delivery");
        await bounded(owner("Cancel").keyReached.promise, "native producer auth entered");
        check(hostResponses.has(cancelled) && !cancelled.responseReturned, "Native ACK escaped held handler");
        check(leases.has(cancelled), "Native producer lost before cancellation");
        if (!race) {
          check(typeof cancelled.id === "string" && cancelled.wait, "Native ID not prebound before ACK loss");
          check((await status(cancelled)).status === "running", "Native producer not pending");
          cancelAbort.abort(new Error("Fixture caller cancelled with native Response held before socket delivery"));
        }
        const cellResult = await bounded(cancelCell, "native cancelled caller while response remains held");
        check(/KeyboardInterrupt|interrupt/i.test(JSON.stringify(cellResult)), "Original cancellation not preserved");
        check(hostResponses.has(cancelled) && leases.has(cancelled), "Caller return released held producer/ACK");
        const afterCaller = summary(cancelled);
        peer.reply.resolve();
        await bounded(peerCell, "useful peer handle delivery");
        check(leases.has(peer), "Cancelled owner discharged peer");
        await post("/release", { key: "peer" });
        await bounded(peer.wait, "useful peer settlement");
        check(peer.terminal?.text === "native-result", "Useful peer did not finish naturally");
        if (race) {
          check(!cancelled.id && cancelled.envelope?.ok === false && /aborted/.test(cancelled.envelope.error), "Abort race did not hide native producer ID");
          // No terminal certificate: auth entry proves dispatch, not producer settlement.
          owner("Cancel").keyGate.resolve();
          cancelled.reply.resolve();
          report("abort-won-envelope-hides-started-producer", "coverage-gap", { afterCaller, cellResult, underlyingNativeAuthEntered: true, peer: summary(peer), reservationRetained: leases.has(cancelled) });
        } else {
          // A fresh real invocation on the same native owner must not inherit the old request.
          const fresh = prepare("fresh");
          fresh.reply.resolve();
          const freshCell = run(owner("Cancel"), "fresh");
          await bounded(fresh.reached.promise, "fresh native run with prior ACK still held");
          fresh.admission.resolve();
          await bounded(fresh.bound.promise, "fresh actual ID binding");
          check(fresh.run !== cancelled.run && fresh.id !== cancelled.id && fresh.owner === cancelled.owner, "Fresh native run identity conflated");
          await bounded(freshCell, "fresh native cell return");
          check(hostResponses.has(cancelled) && leases.has(cancelled) && leases.has(fresh), "Fresh generation cleared old reservation");
          owner("Cancel").keyGate.resolve();
          await bounded(cancelled.wait, "old cancelled native producer settlement");
          check(["failed", "cancelled"].includes(cancelled.terminal?.status), "Old native producer not cancelled");
          check(leases.has(fresh), "Old terminal response discharged fresh producer");
          cancelled.reply.resolve();
          await post("/await-provider", { key: "fresh" });
          await post("/release", { key: "fresh" });
          await bounded(fresh.wait, "fresh useful producer settlement");
          check(fresh.terminal?.text === "native-result", "Fresh producer did not complete naturally");
          report("host-response-captured-before-socket-loss", "passed-bounded-subset", { afterCaller, cellResult, old: summary(cancelled), fresh: summary(fresh), peer: summary(peer), originalKernelOptionsUnchanged: true });
        }
`,
);
replace("        if (proxy) await proxy.stop(true);", "        // Native bridge lifetime remains owned by native fixture process cleanup.");
replace(
  '"Owner release holds actual native auth prerequisite, not an abort-insensitive transport cleanup matrix"',
  '"Native auth prerequisite is held; native wait is not a universal cleanup join"',
);
const root = mkdtempSync(path.join(tmpdir(), "alinery-forwarded-ack-"));
try {
  const file = path.join(root, "native-fixture.mjs");
  writeFileSync(file, source);
  const result = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  assert.ifError(result.error);
  assert.equal(result.status, race ? 3 : 0, "Unexpected native derivative outcome");
  const outcome = JSON.parse(result.stdout);
  assert.deepEqual(outcome.faults, []);
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].name, race ? "abort-won-envelope-hides-started-producer" : "host-response-captured-before-socket-loss");
  console.log(
    JSON.stringify({
      status: "coverage-gap",
      mode: race ? "abort-race" : "response-loss",
      derivativeSha256: hash(source),
      inputSha256: hash(readFileSync(input)),
      unresolved: ["JS suppressed dispatch result", "Python abort-won hidden native producer", "durable owner/revision reconciliation"],
    }),
  );
  process.exitCode = 3;
} finally {
  rmSync(root, { recursive: true, force: true });
}
