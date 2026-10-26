// Opt-in external lifecycle diagnostic; no production or native modifications.
// Pinned a1b254047d12e143b7c6011536e918c6c35c5906: backend.execute ->
// executeJs -> executeInVmContext awaits acquireSession -> runOnce sends actual RUN.
// Fresh host AsyncLocalStorage scope is read ONLY at outgoing RUN; incoming IPC uses runId.
// handle-bridge.ts73-87,183-199 binds before await; completion-bridge.ts90-97 release aborts/deletes.
// Dead-worker safeSend suppresses preforward rejection ACK; retain that reservation as unknown.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.argv.includes("--help")) {
  console.log(
    "OMP_BIN=/Applications/Alinery.omp/omp node external_js_lifecycle_smoke.mjs\nLoopback-only native JS cancellation, owner release and concurrent same-model ownership probe.\nExpected exit 3: bounded results, unresolved dead-worker admission ACK and a native-wait/transport-tail counterexample; 2: unsupported; 1: unexpected failure.\nNo reset/reload, process-exit or production certification. Deadline is failure only.",
  );
  process.exit(0);
}
assert.equal(process.argv.length, 2, "Unknown argument");
const binary = process.env.OMP_BIN || "/Applications/Alinery.omp/omp";
const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
assert.match(version, /18\.1\.13\b/);
const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
assert.equal(sha256, "9d4b74e20502f06348143fc3fbd630326d16c1a11a7eb0a94b44e5818aa78e47", "Installed OMP differs from approved binary");
const root = mkdtempSync(path.join(tmpdir(), "alinery-js-lifecycle-"));
const agentDir = path.join(root, "agent");
const events = [];
const listeners = new Set();
const sockets = new Set();
const producers = new Map();
const effects = new Map();
const released = new Set();
let child;
let closed;
let sequence = 0;
let bootstrap = false;
const record = (event) => {
  events.push(event);
  for (const listener of [...listeners]) listener();
};
const waitFor = (predicate) =>
  new Promise((resolve, reject) => {
    const check = () => {
      const found = events.find(predicate);
      if (found) {
        clearTimeout(timer);
        listeners.delete(check);
        resolve(found);
      }
    };
    const timer = setTimeout(() => {
      listeners.delete(check);
      reject(new Error("Diagnostic deadline (not settlement evidence)"));
    }, 90000);
    listeners.add(check);
    check();
  });
const answer = (response, tool) => {
  const id = `bridge_${++sequence}`;
  const delta = tool
    ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: "bridge_probe", arguments: "{}" } }] }
    : { role: "assistant", content: "native-result" };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ id, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
};
const server = createServer(async (request, response) => {
  try {
    let bytes = "";
    for await (const chunk of request) bytes += chunk;
    const body = JSON.parse(bytes || "{}");
    const json = (value) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(value));
    };
    if (request.url === "/trace") {
      record(body);
      json({});
    } else if (request.url === "/cleanup-effects") {
      for (const held of effects.values()) if (!held.writableEnded) held.end("{}");
      json({});
    } else if (request.url === "/state") json({ producerCount: producers.has(body.language) ? 1 : 0, held: producers.has(body.language) && !released.has(body.language) });
    else if (request.url === "/release") {
      released.add(body.language);
      const held = producers.get(body.language);
      if (held && !held.writableEnded) answer(held);
      json({});
    } else if (request.url === "/await-provider") {
      await waitFor((e) => e.type === "producer-provider" && e.language === body.language);
      json({});
    } else if (request.url === "/effect") {
      effects.set(body.key, response);
      record({ type: "effect-held", key: body.key });
    } else if (request.url === "/await-effect") {
      await waitFor((e) => e.type === "effect-held" && e.key === body.key);
      json({});
    } else if (request.url === "/release-effect") {
      const held = effects.get(body.key);
      assert.ok(held);
      held.end("{}");
      json({});
    } else if (["/chat/completions", "/v1/chat/completions"].includes(request.url)) {
      const text = JSON.stringify(body.messages);
      const language = ["pre", "release", "other", "cancel", "reuse"].find((value) => text.includes(`LIFECYCLE_${value}`));
      if (language) {
        assert.equal(producers.has(language), false, "Unexpected duplicate producer request");
        producers.set(language, response);
        record({ type: "producer-provider", language });
        if (released.has(language)) answer(response);
      } else if (!bootstrap && body.tools?.some((tool) => tool.function?.name === "bridge_probe")) {
        bootstrap = true;
        answer(response, true);
      } else answer(response);
    } else throw new Error(`Unexpected fixture route ${request.url}`);
  } catch (error) {
    record({ type: "fixture-error", error: String(error) });
    response.destroy();
  }
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

function installProbe(api, config) {
  const post = async (route, body = {}) => {
    const response = await fetch(config.url + route, { method: "POST", body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Fixture route failed: ${route}`);
    return response.json();
  };
  const check = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  api.registerTool({
    name: "bridge_probe",
    label: "Native JS lifecycle",
    description: "Run isolated native lifecycle diagnostic",
    parameters: api.zod.z.object({}),
    loadMode: "essential",
    async execute(_id, _input, _signal, _update, ctx) {
      const result = {
        status: "coverage-gap",
        scenarios: Object.fromEntries(
          ["preAdmissionAbort", "postForwardCancel", "ownerRelease", "concurrentOwners", "reusedWorker"].map((key) => [key, { status: "not-completed" }]),
        ),
        observations: [],
        limitations: [
          "Public runtime decoration plus pinned protocol knowledge, not a documented OMP lifecycle API.",
          "Reset/reload, process-exit finalization, fallback transports, auto-background lifetime and production authority are not proved.",
          "Transport cleanup latch delays delivery of the original fetch rejection, never replaces native error or signal.",
          "Prior actual run disproved native wait as fetch-tail join: cancelled native wait preceded held original fetch rejection; retained as negative experiment below.",
          "Owner release uses actual per-owner native getApiKey prerequisite, not a transport-cleanup guarantee.",
        ],
      };
      const restore = [],
        sessions = [],
        pendingCells = [],
        faults = [];
      const owners = new Map(),
        cases = new Map();
      const note = (type, fields = {}) => result.observations.push({ type, ...fields });
      const fault = (error) => faults.push(String(error));
      const decorate = (object, key, fn) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        object[key] = fn;
        check(object[key] === fn, `Public ${key} is not writable`);
        restore.push(() => {
          if (descriptor) Object.defineProperty(object, key, descriptor);
          else delete object[key];
        });
      };
      const makeCase = (key) => {
        const c = {
          key,
          incoming: deferred(),
          bound: deferred(),
          cleanup: deferred(),
          releaseCleanup: deferred(),
          keyReached: deferred(),
          keyGate: deferred(),
          tailDone: deferred(),
          active: false,
          forwarded: false,
          terminal: false,
        };
        cases.set(key, c);
        return c;
      };
      let callSessionTool, unsupported;
      const terminal = async (c) => {
        const value = await c.wait;
        check(
          value && value.id === c.nativeId && value.kind === "completion" && ["completed", "failed", "cancelled"].includes(value.status),
          `Nonterminal wait: ${JSON.stringify(value)}`,
        );
        return value;
      };
      try {
        let backend, AsyncLocalStorage;
        try {
          ({ jsBackend: backend } = await import("@oh-my-pi/pi-coding-agent/eval"));
          ({ callSessionTool } = await import("@oh-my-pi/pi-coding-agent/eval/js/tool-bridge"));
          ({ AsyncLocalStorage } = await import("node:async_hooks"));
          check(typeof AsyncLocalStorage === "function", "Public AsyncLocalStorage unavailable");
        } catch (error) {
          unsupported = String(error);
          throw error;
        }
        const executionScope = new AsyncLocalStorage();
        restore.push(() => executionScope.disable());
        let invocation = 0;
        const originalExecute = backend.execute;
        decorate(backend, "execute", function (...args) {
          const options = args[1],
            owner = options?.session?.getAgentId?.();
          if (!owners.has(owner)) return Reflect.apply(originalExecute, this, args);
          const released = cases.get("release");
          if (released?.expectedOwner === owner && !released.registryDecorated) {
            const registry = options.session.modelRegistry;
            check(registry && registry !== ctx.modelRegistry, "Expected SDK-owned independent native ModelRegistry");
            const getApiKey = registry.getApiKey;
            decorate(registry, "getApiKey", async function (...keyArgs) {
              const nativeValue = await Reflect.apply(getApiKey, this, keyArgs);
              released.keyReached.resolve();
              await released.keyGate.promise;
              return nativeValue; // Native loopback auth result, never logged or replaced.
            });
            released.registry = registry;
            released.registryDecorated = true;
          } else if (released?.registry && released.expectedOwner !== owner) {
            check(options.session.modelRegistry !== released.registry, "Native registry unexpectedly shared across owners");
          }
          const execution = { toolSession: options.session, owner, invocation: ++invocation, live: true };
          note("native-backend-scope", { owner, invocation: execution.invocation });
          return executionScope.run(execution, () => {
            const native = Reflect.apply(originalExecute, this, args);
            Promise.resolve(native).then(
              () => {
                execution.live = false;
              },
              () => {
                execution.live = false;
              },
            );
            return native;
          });
        });
        // Delay only delivery of an ORIGINAL transport rejection after genuine cancellation.
        // Negative experiment: a native stream abort can settle BEFORE this real fetch tail.
        const originalFetch = globalThis.fetch;
        decorate(globalThis, "fetch", function (...args) {
          let c;
          try {
            const url = typeof args[0] === "string" ? args[0] : (args[0]?.url ?? String(args[0]));
            if (url.startsWith(config.url) && url.includes("chat/completions") && typeof args[1]?.body === "string") {
              const body = JSON.parse(args[1].body);
              const text = JSON.stringify(body.messages);
              c = [...cases.values()].find((item) => text.includes(`LIFECYCLE_${item.key}`));
            }
          } catch (error) {
            fault(error);
          }
          const original = Reflect.apply(originalFetch, this, args);
          if (c?.key !== "cancel") return original;
          c.fetchObserved = true;
          c.fetchTailActive = true;
          const tail = original.catch(async (error) => {
            c.transportError = { name: error?.name, message: error?.message };
            note("original-fetch-rejection-held", { key: c.key, error: c.transportError });
            c.cleanup.resolve();
            await c.releaseCleanup.promise;
            throw error;
          });
          tail.then(
            () => {
              c.fetchTailActive = false;
              c.tailDone.resolve();
            },
            () => {
              c.fetchTailActive = false;
              c.tailDone.resolve();
            },
          );
          return tail;
        });
        const originalSpawn = Bun.spawn;
        decorate(Bun, "spawn", function (...args) {
          const options = args[0];
          if (!Array.isArray(options?.cmd) || !options.cmd.includes("__omp_worker_js_eval_process") || typeof options.ipc !== "function")
            return Reflect.apply(originalSpawn, this, args);
          const originalIpc = options.ipc,
            descriptor = Object.getOwnPropertyDescriptor(options, "ipc");
          const runs = new Map(),
            calls = new Map();
          let proc;
          options.ipc = function (...frames) {
            const frame = frames[0],
              execution = runs.get(frame?.runId);
            if (frame?.type !== "tool-call" || frame.name !== "__completion__") return Reflect.apply(originalIpc, this, frames);
            const c = cases.get(String(frame.args?.prompt).replace(/^LIFECYCLE_/, ""));
            if (!c) return Reflect.apply(originalIpc, this, frames);
            if (!execution || c.expectedOwner !== execution.owner) {
              c.active = true;
              c.identityGap = "No trustworthy current invocation scope; native work preserved, external reservation blocked";
              note("unknown-native-owner-reserved", { key: c.key, runId: frame.runId, id: frame.id, pid: proc.pid });
              return Reflect.apply(originalIpc, this, frames);
            }
            if (c.request) {
              fault("Duplicate native request for scenario");
              return Reflect.apply(originalIpc, this, frames);
            }
            c.request = { id: frame.id, runId: frame.runId, pid: proc.pid, owner: execution.owner, invocation: execution.invocation };
            c.toolSession = execution.toolSession;
            c.active = true;
            calls.set(frame.id, c);
            c.forward = () => {
              check(!c.forwarded, "Admission forwarded twice");
              c.forwarded = true;
              note("native-forward", c.request);
              return Reflect.apply(originalIpc, this, frames);
            };
            note("native-reserved", c.request);
            c.incoming.resolve();
            if (c.key !== "pre") c.forward();
          };
          try {
            proc = Reflect.apply(originalSpawn, this, args);
          } finally {
            if (descriptor) Object.defineProperty(options, "ipc", descriptor);
            else delete options.ipc;
          }
          const originalSend = proc.send;
          decorate(proc, "send", function (...frames) {
            const frame = frames[0];
            try {
              if (frame?.type === "run" && frame.snapshot?.cwd === config.root) {
                // Never read async context at spawn or incoming worker callbacks: their ancestry can be stale.
                const execution = executionScope.getStore();
                if (execution?.live && owners.has(execution.owner)) {
                  runs.set(frame.runId, execution);
                  note("native-run-correlated", {
                    pid: proc.pid,
                    runId: frame.runId,
                    sessionId: frame.snapshot.sessionId,
                    owner: execution.owner,
                    invocation: execution.invocation,
                  });
                } else fault("No fresh live backend scope at native RUN; no owner inferred");
              }
              const c = frame?.type === "tool-reply" ? calls.get(frame.id) : undefined;
              if (c && !c.reply) {
                c.reply = frame.reply;
                if (frame.reply?.ok && typeof frame.reply.value?.id === "string") {
                  c.nativeId = frame.reply.value.id;
                  // Native resolveHandle runs synchronously before its first await.
                  c.wait = callSessionTool("__wait__", { items: [{ kind: "completion", id: c.nativeId }] }, { session: c.toolSession }).then(
                    (value) => {
                      const item = value?.items?.[0];
                      if (value?.items?.length === 1 && item?.id === c.nativeId && item.kind === "completion" && ["completed", "failed", "cancelled"].includes(item.status)) {
                        c.terminal = true;
                        c.active = false;
                        c.snapshot = item;
                        note("native-terminal-wait", { key: c.key, ...item });
                      } else fault("Unknown/nonterminal native wait; reservation retained");
                      return item;
                    },
                    (error) => {
                      fault(error);
                      return { error: String(error) };
                    },
                  );
                  note("native-wait-bound-before-send", { key: c.key, nativeId: c.nativeId, ...c.request });
                } else {
                  note("native-error-reply", { key: c.key, reply: frame.reply });
                }
                c.bound.resolve();
              }
            } catch (error) {
              fault(error);
            }
            return Reflect.apply(originalSend, this, frames);
          });
          return proc;
        });
        const create = async (name) => {
          const pi = api.pi;
          const { session } = await pi.createAgentSession({
            cwd: config.root,
            agentDir: config.agentDir,
            agentId: name,
            parentTaskPrefix: name,
            model: ctx.model,
            authStorage: ctx.modelRegistry.authStorage,
            settings: pi.Settings.isolated({}),
            autoApprove: true,
            sessionManager: pi.SessionManager.create(config.root, config.sessionsDir),
          });
          sessions.push(session);
          owners.set(session.getAgentId(), session);
          return session;
        };
        const launch = (session, c, signal) => {
          c.expectedOwner = session.getAgentId();
          const promise = session
            .getToolByName("eval")
            .execute(
              `lifecycle-${crypto.randomUUID()}`,
              { language: "js", code: `var h = await completion(${JSON.stringify(`LIFECYCLE_${c.key}`)}); display(h.id);`, title: "Native lifecycle", timeout: 30 },
              signal,
            );
          const observed = promise.then(
            (value) => {
              c.cell = value;
              return value;
            },
            (error) => {
              c.cellError = String(error);
              return { rejected: String(error) };
            },
          );
          pendingCells.push(observed);
          return observed;
        };
        const awaitIncoming = async (c, cell) => {
          const observed = await Promise.race([c.incoming.promise.then(() => true), cell.then(() => false)]);
          if (!observed) {
            const error = new Error("Native cell returned without selected IPC capture");
            error.coverageGap = true;
            throw error;
          }
        };
        const normalCell = (value) => {
          check(!value.isError && !value.details?.isError && !value.rejected, `Native cell failed: ${JSON.stringify(value)}`);
          if (value.details?.async?.state === "running") {
            const error = new Error("Native auto-background lifetime unproved");
            error.coverageGap = true;
            throw error;
          }
        };
        const pre = makeCase("pre"),
          preSession = await create("JsLifecyclePre"),
          controller = new AbortController();
        const preCell = launch(preSession, pre, controller.signal);
        await awaitIncoming(pre, preCell);
        check((await post("/state", { language: "pre" })).producerCount === 0, "Pre-admission producer escaped");
        controller.abort();
        await preCell; // Actual native caller return, not signal-only evidence.
        pre.forward(); // Original dispatcher sees the dead/missing run; no synthesized reply.
        check((await post("/state", { language: "pre" })).producerCount === 0, "Unauthorized delayed producer");
        result.scenarios.preAdmissionAbort = {
          status: "coverage-gap",
          callerResult: pre.cell ?? pre.cellError,
          delayedOriginalCallbackInvoked: true,
          observedProducerCount: 0,
          reservationRetained: pre.active,
          reason:
            "Dead native session suppresses reply; no native terminal admission ACK. Zero provider observation plus pinned dispatcher guard is not general admission closure proof.",
        };
        // Distinct ToolSessions launch overlapping producers on the SAME selected model.
        const a = await create("JsLifecycleRelease"),
          b = await create("JsLifecycleOther"),
          d = await create("JsLifecycleCancel");
        const release = makeCase("release"),
          other = makeCase("other"),
          cancel = makeCase("cancel");
        const cells = [launch(a, release), launch(b, other), launch(d, cancel)];
        await Promise.all([release, other, cancel].map((c, i) => awaitIncoming(c, cells[i])));
        for (const value of await Promise.all(cells)) normalCell(value);
        await Promise.all([release, other, cancel].map((c) => c.bound.promise));
        check(
          release.toolSession !== other.toolSession && other.toolSession !== cancel.toolSession && release.toolSession !== cancel.toolSession,
          "Native ToolSessions not distinct",
        );
        await release.keyReached.promise;
        await Promise.all([other, cancel].map((c) => post("/await-provider", { language: c.key })));
        check(
          [release, other, cancel].every((c) => c.active && !c.terminal),
          "Pending producer reservation lost",
        );
        check(new Set([release, other, cancel].map((c) => c.nativeId)).size === 3, "Native handles not distinct");
        if (!cancel.fetchObserved) {
          const error = new Error("Original fetch cleanup boundary not reached; cannot establish pending cleanup latch");
          error.coverageGap = true;
          throw error;
        }
        const cancelReply = await callSessionTool("__cancel__", { item: { kind: "completion", id: cancel.nativeId } }, { session: cancel.toolSession });
        await cancel.cleanup.promise;
        check(other.active && release.active && cancel.fetchTailActive, "Independent producer or held transport tail reservation lost");
        const nativeSettledBeforeTailRelease = cancel.terminal;
        cancel.releaseCleanup.resolve();
        const cancelled = await terminal(cancel);
        check(cancelled.status === "cancelled", `Native cancel not terminal cancelled: ${JSON.stringify(cancelled)}`);
        await cancel.tailDone.promise;
        result.scenarios.postForwardCancel = {
          status: nativeSettledBeforeTailRelease ? "experimental-counterexample" : "coverage-gap",
          nativeCancelReply: cancelReply,
          snapshot: cancelled,
          nativeSettledBeforeTailRelease,
          originalFetchError: cancel.transportError,
          scope:
            "Only fixture-held original transport error delivery; not proof of arbitrary relevant-artifact tails. Native reservation cleared on actual native wait settlement, never on signal.",
          reason: "Native terminal wait is not a general transport-tail cleanup join. Prior actual run settled native cancellation before the original fetch rejection latch.",
        };
        const disposal = Promise.resolve(a.dispose());
        await disposal;
        // Actual executeCompletion is still awaiting this owner's original getApiKey result.
        check(release.active && !release.terminal && other.active && !other.terminal, "Owner release cleared pending producer or unrelated owner");
        let unknown;
        try {
          await callSessionTool("__status__", { item: { kind: "completion", id: release.nativeId } }, { session: release.toolSession });
        } catch (error) {
          unknown = String(error);
        }
        check(unknown?.includes("unknown completion handle"), "Owner release did not remove native handle");
        check(release.active, "Unknown handle incorrectly treated as settlement");
        release.keyGate.resolve();
        const releasedSnapshot = await terminal(release);
        check(releasedSnapshot.status === "cancelled", "Released producer did not natively settle cancelled");
        const otherStatus = await callSessionTool("__status__", { item: { kind: "completion", id: other.nativeId } }, { session: other.toolSession });
        check(otherStatus.status === "running" && other.active, "Unrelated same-model producer lost ownership");
        const reuse = makeCase("reuse");
        const reuseCell = launch(b, reuse);
        await awaitIncoming(reuse, reuseCell);
        normalCell(await reuseCell);
        await reuse.bound.promise;
        await post("/await-provider", { language: "reuse" });
        check(reuse.request.pid === other.request.pid, "Later eval did not reuse the native worker");
        check(reuse.request.runId !== other.request.runId && reuse.request.invocation !== other.request.invocation, "Reused worker inherited stale invocation scope");
        check(reuse.toolSession === other.toolSession && reuse.active && other.active, "Reused run ownership missing");
        await post("/release", { language: "reuse" });
        const reuseSnapshot = await terminal(reuse);
        check(reuseSnapshot.status === "completed" && reuseSnapshot.text === "native-result" && other.active, "Reused worker completion lost independent pending reservation");
        result.scenarios.reusedWorker = {
          status: "passed-bounded-subset",
          samePid: reuse.request.pid,
          previousInvocation: other.request.invocation,
          freshInvocation: reuse.request.invocation,
          snapshot: reuseSnapshot,
        };
        await post("/release", { language: "other" });
        const otherSnapshot = await terminal(other);
        check(otherSnapshot.status === "completed" && otherSnapshot.text === "native-result", "Other owner useful work lost");
        result.scenarios.ownerRelease = {
          status: "passed-bounded-subset",
          boundBeforeRelease: true,
          pendingAfterMapRemoval: true,
          nativeUnknownError: unknown,
          prerequisite: "Original-delegating getApiKey on SDK-created distinct native ModelRegistry",
          snapshot: releasedSnapshot,
        };
        result.scenarios.concurrentOwners = { status: "passed-bounded-subset", distinctNativeToolSessions: 3, sameModel: ctx.model.id, overlappingPending: 3, otherSnapshot };
        check(!faults.length, faults.join("; "));
        result.status = "coverage-gap"; // pre-admission ACK remains deliberately unproved, never green safety.
      } catch (error) {
        result.status = unsupported ? "unsupported" : error.coverageGap ? "coverage-gap" : "failed";
        result.error = String(error);
      } finally {
        for (const c of cases.values()) c.releaseCleanup.resolve();
        for (const c of cases.values()) c.keyGate.resolve();
        for (const c of cases.values()) await post("/release", { language: c.key });
        for (const session of sessions) {
          try {
            await session.dispose();
          } catch (error) {
            fault(error);
          }
        }
        await Promise.allSettled(pendingCells);
        await Promise.allSettled([...cases.values()].map((c) => c.wait).filter(Boolean));
        await Promise.allSettled([...cases.values()].filter((c) => c.fetchObserved).map((c) => c.tailDone.promise));
        for (const undo of restore.reverse()) {
          try {
            undo();
          } catch (error) {
            fault(error);
          }
        }
      }
      result.faults = faults;
      if (faults.length) result.status = "failed";
      result.reservations = [...cases.values()].map((c) => ({
        key: c.key,
        request: c.request,
        nativeId: c.nativeId,
        active: c.active,
        terminal: c.terminal,
        fetchTailActive: c.fetchTailActive ?? false,
        snapshot: c.snapshot,
      }));
      await post("/trace", { type: "outcome", ...result });
      return { content: [{ type: "text", text: result.status }] };
    },
  });
}

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    path.join(agentDir, "models.yml"),
    JSON.stringify({
      providers: {
        "bridge-local": {
          baseUrl: url,
          apiKey: "loopback-only",
          api: "openai-completions",
          models: [
            { id: "probe", name: "probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 512 },
          ],
        },
      },
    }),
  );
  const extension = path.join(root, "bridge-probe.ts");
  writeFileSync(extension, `export default api => (${installProbe.toString()})(api, ${JSON.stringify({ root, agentDir, url, sessionsDir: path.join(root, "sessions") })});`);
  const configPath = path.join(root, "config.yml");
  writeFileSync(configPath, "{}\n");
  child = spawn(
    binary,
    ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", extension, "--model", "bridge-local/probe", "--thinking", "off", "--config", configPath],
    { cwd: root, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_CONFIG_DIR: path.join(root, "config") }, stdio: ["pipe", "pipe", "pipe"] },
  );
  closed = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      record({ type: "process-closed", code, signal });
      resolve();
    }),
  );
  child.on("error", (error) => record({ type: "process-error", error: String(error) }));
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const event = JSON.parse(line);
        if (["ready", "extension_error"].includes(event.type)) record(event);
      } catch {
        record({ type: "stdout", line });
      }
    }
  });
  child.stderr.on("data", (chunk) => record({ type: "stderr", text: String(chunk) }));
  const ready = await waitFor((e) => ["ready", "process-closed", "process-error"].includes(e.type));
  assert.equal(ready.type, "ready");
  child.stdin.write(`${JSON.stringify({ id: "bridge-probe", type: "prompt", message: "Run bridge_probe now." })}\n`);
  const outcome = await waitFor((e) => ["outcome", "fixture-error", "process-closed", "process-error"].includes(e.type));
  process.exitCode = { "passed-bounded-subset": 0, unsupported: 2, "coverage-gap": 3 }[outcome.status] ?? 1;
  console.log(JSON.stringify({ ...outcome, binary: { path: binary, version, sha256 }, events }, null, 2));
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({ status: "failed", error: String(error), events }, null, 2));
} finally {
  for (const response of [...producers.values(), ...effects.values()]) if (!response.writableEnded) response.destroy();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(timer);
  }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
