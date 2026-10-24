// Opt-in external-only candidate A diagnostic. Production and old fixture stay unchanged.
// Exit 0: supported two-stop subset; 2: unsupported public capability;
// 3: liveness-blocked (negative diagnostic); 1: failed safety/fixture/runtime check.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: node external_autolearn_descendants_smoke.mjs\nLocal packaged OMP public async_hooks capability, then two real native stops with uniform early subscription scopes. No production certification. Exit 0=bounded pass, 2=unsupported, 3=liveness-blocked, 1=failed.",
  );
  process.exit(0);
}
assert.equal(args.length, 0, "Unknown argument");
const binary = process.env.OMP_BIN || "/Applications/Alinery.omp/omp";
assert.match(execFileSync(binary, ["--version"], { encoding: "utf8" }), /18\.1\.13\b/);
const root = mkdtempSync(path.join(tmpdir(), "alinery-autolearn-"));
const agentDir = path.join(root, "agent");
const events = [];
const listeners = new Set();
const held = new Map();
const sockets = new Set();
let child;
let closed;
let responseId = 0;
let captureRequests = 0;
let primaryRequests = 0;
let bootstrapIssued = false;
const primaryStages = new Map();
const record = (event) => {
  events.push(event);
  for (const listener of [...listeners]) listener();
};
const waitFor = (predicate) => {
  const pending = Promise.withResolvers();
  const check = () => {
    const found = events.find(predicate);
    if (!found) return;
    clearTimeout(timer);
    listeners.delete(check);
    pending.resolve(found);
  };
  const timer = setTimeout(() => {
    listeners.delete(check);
    pending.reject(new Error(`Missing event; recent=${JSON.stringify(events.slice(-30))}`));
  }, 60000);
  listeners.add(check);
  check();
  return pending.promise;
};
const release = (key) => {
  const response = held.get(key);
  assert.ok(response, `Missing latch ${key}`);
  held.delete(key);
  response.end("{}");
  record({ type: "released", key });
};
const skillPath = (ordinal) => path.join(agentDir, "managed-skills", `capture-${ordinal}`, "SKILL.md");
const answer = (response, tools) => {
  const id = ++responseId;
  const delta = tools
    ? {
        role: "assistant",
        tool_calls: tools.map((tool, index) => ({ index, id: `capture_${id}_${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.input) } })),
      }
    : { role: "assistant", content: "Local native capture probe completed." };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ id: `capture_${id}`, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: `capture_${id}`, choices: [{ index: 0, delta: {}, finish_reason: tools ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
};
const server = createServer(async (request, response) => {
  try {
    let bytes = "";
    for await (const chunk of request) bytes += chunk;
    const body = JSON.parse(bytes || "{}");
    if (request.url === "/trace") {
      if (body.type === "outcome" && ["passed-supported-subset", "liveness-blocked"].includes(body.status)) {
        assert.equal(primaryRequests, 4, "Unexpected primary provider work");
        assert.equal(captureRequests, 4, "Native pending capture did not dispatch twice");
        for (const ordinal of [1, 2]) assert.match(readFileSync(skillPath(ordinal), "utf8"), new RegExp(`Capture ${ordinal} evidence`));
        assert.equal(body.nativeComplete, true);
        assert.equal(body.firstFence.status, "waiting");
        assert.equal(body.admissionsAfterSeal, 0);
        assert.equal(body.ownershipGaps, 0);
      }
      record(body);
      response.end("{}");
    } else if (request.url === "/await") {
      const event = await waitFor((event) => Object.entries(body).every(([key, value]) => event[key] === value));
      response.end(JSON.stringify(event));
    } else if (request.url === "/release") {
      release(body.key);
      response.end("{}");
    } else if (request.url === "/admission-latch") {
      assert.equal(body.ordinal, 1);
      assert.equal(captureRequests, 0);
      held.set("admission-1", response);
      record({ type: "capture-admission-held", ...body });
    } else if (request.url === "/refresh-latch") {
      assert.match(readFileSync(skillPath(body.ordinal), "utf8"), new RegExp(`Capture ${body.ordinal} evidence`));
      if (body.ordinal === 1) held.set("refresh-1", response);
      else response.end("{}");
      record({ type: "refresh-held", ...body, nativeFileWritten: true });
    } else if (request.url === "/v1/chat/completions" || request.url === "/chat/completions") {
      const names = body.tools?.map((tool) => tool.function.name) ?? [];
      const users = body.messages.filter((message) => message.role === "user");
      const lastUser = JSON.stringify(users.at(-1));
      const capture = names.includes("manage_skill") && !names.includes("write");
      if (capture) {
        captureRequests++;
        const ordinal = Math.ceil(captureRequests / 2);
        record({ type: "capture-provider", ordinal, request: captureRequests, nativeTools: names });
        if (captureRequests % 2 === 1) {
          answer(response, [
            {
              name: "manage_skill",
              input: { action: "create", name: `capture-${ordinal}`, description: `Local capture ${ordinal} fixture`, body: `Capture ${ordinal} evidence.` },
            },
          ]);
        } else answer(response);
      } else if (lastUser.includes("CAPTURE_PRIMARY_")) {
        primaryRequests++;
        const ordinal = lastUser.includes("CAPTURE_PRIMARY_TWO") ? 2 : 1;
        const stage = primaryStages.get(ordinal) ?? 0;
        primaryStages.set(ordinal, stage + 1);
        record({ type: "primary-provider", ordinal, stage });
        assert.ok(names.includes("write") && names.includes("manage_skill"), "Native primary tools unavailable");
        if (stage === 0) answer(response, [{ name: "write", input: { path: path.join(root, `primary-${ordinal}`), content: `primary ${ordinal}` } }]);
        else answer(response);
      } else if (names.includes("autolearn_probe") && !bootstrapIssued) {
        bootstrapIssued = true;
        answer(response, [{ name: "autolearn_probe", input: {} }]);
      } else answer(response);
    } else throw new Error(`Unexpected route ${request.url}`);
  } catch (error) {
    record({ type: "fixture-error", error: String(error) });
    response.destroy(error);
  }
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

function installProbe(api, config) {
  const post = async (route, body = {}) => {
    const response = await fetch(config.url + route, { method: "POST", body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Loopback ${route}: ${response.status}`);
    return response.json();
  };
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  api.registerTool({
    name: "autolearn_probe",
    label: "Callback descendant probe",
    description: "Run isolated packaged-runtime callback descendant diagnostic",
    parameters: api.zod.z.object({}),
    loadMode: "essential",
    async execute(_id, _input, _signal, _update, ctx) {
      let session, hook, reporter, capabilityHook;
      let trace = (event) => post("/trace", event);
      const cleanups = [];
      try {
        // This import and all probes execute INSIDE the packaged OMP process.
        let hooks;
        try {
          hooks = await import("node:async_hooks");
        } catch (error) {
          await trace({ type: "outcome", status: "unsupported", phase: "async-hooks-import", error: String(error) });
          return { content: [{ type: "text", text: "Unsupported async-hooks import" }] };
        }
        const counts = { init: 0, before: 0, after: 0, destroy: 0, promiseResolve: 0 };
        const types = {};
        const capabilityIds = new Set();
        let resourceId,
          promiseInit = 0,
          promiseReactions = 0,
          callbackRan = false;
        try {
          capabilityHook = hooks
            .createHook({
              init(id, type) {
                counts.init++;
                types[type] = (types[type] || 0) + 1;
                capabilityIds.add(id);
                if (type === "PROMISE") promiseInit++;
              },
              before(id) {
                if (capabilityIds.has(id)) counts.before++;
              },
              after(id) {
                if (capabilityIds.has(id)) counts.after++;
              },
              destroy(id) {
                if (capabilityIds.has(id)) counts.destroy++;
              },
              promiseResolve(id) {
                if (capabilityIds.has(id)) counts.promiseResolve++;
              },
            })
            .enable();
          const resource = new hooks.AsyncResource("ALINERY_CAPABILITY");
          resourceId = resource.asyncId();
          resource.runInAsyncScope(() => {
            callbackRan = true;
          });
          resource.emitDestroy();
          await Promise.resolve()
            .then(() => {
              promiseReactions++;
            })
            .finally(() => {
              promiseReactions++;
            });
          // A turn boundary exercises destroy delivery; it is not a settlement oracle.
          await new Promise((resolve) => setImmediate(resolve));
        } catch (error) {
          await trace({ type: "capability-error", error: String(error) });
        } finally {
          capabilityHook?.disable();
        }
        const capable =
          callbackRan &&
          capabilityIds.has(resourceId) &&
          promiseInit > 0 &&
          counts.before > 0 &&
          counts.after > 0 &&
          counts.destroy > 0 &&
          counts.promiseResolve > 0 &&
          promiseReactions === 2;
        await trace({
          type: "hook-capability",
          capable,
          counts,
          types,
          resourceId,
          promiseInit,
          promiseReactions,
          callbackRan,
          runtime: { execPath: process.execPath, bun: process.versions.bun, node: process.versions.node },
          scope: "public-hook self-test only; not native controller coverage",
        });
        if (!capable) {
          await trace({
            type: "outcome",
            status: "unsupported",
            phase: "async-hooks-events",
            counts,
            types,
            conclusion: "Packaged runtime did not demonstrate the required public async-resource lifecycle events; native workflow not attempted",
          });
          return { content: [{ type: "text", text: "Unsupported async-hook lifecycle" }] };
        }
        let AgentRegistry;
        try {
          ({ AgentRegistry } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry"));
          check(typeof AgentRegistry === "function", "Public registry export missing");
        } catch (error) {
          await trace({ type: "outcome", status: "unsupported", phase: "registry-import", error: String(error) });
          return { content: [{ type: "text", text: "Unsupported public registry import" }] };
        }
        // Reporter lineage is born before tracking. No hook performs I/O. Native
        // awaits of the fixture's latch remain owned; reporter transport does not.
        reporter = new hooks.AsyncResource("ALINERY_REPORTER");
        const ignored = new Set([reporter.asyncId()]);
        const lineage = new Map(); // Tombstones preserve provenance after destroy.
        const live = new Map();
        const scopes = new Map();
        const raw = { init: 0, before: 0, after: 0, destroy: 0, promiseResolve: 0 };
        const byType = {};
        let current,
          suppress = 0,
          revision = 0,
          nextScope = 0,
          callbackDepth = 0;
        let sealed = false,
          admissionsAfterSeal = 0,
          registrationCount = 0,
          attached = false;
        let captureAttempts = 0,
          primaryEnds = 0,
          refreshes = 0,
          firstFence,
          zeroWaiter;
        let nativeWindow = false,
          ownershipGaps = 0;
        const outside = (fn) =>
          reporter.runInAsyncScope(() => {
            const previous = current;
            current = undefined;
            suppress++;
            try {
              return fn();
            } finally {
              suppress--;
              current = previous;
            }
          });
        const control = (route, body) => outside(() => post(route, body));
        const records = [];
        trace = (event) => {
          records.push(event);
        };
        const flush = async () => {
          for (const event of records.splice(0)) await control("/trace", event);
        };
        const activeCount = () => live.size + callbackDepth;
        const notify = () => {
          if (!activeCount() && nativeWindow) ownershipGaps++;
          if (!activeCount() && zeroWaiter) outside(zeroWaiter);
        };
        hook = hooks
          .createHook({
            init(id, type, trigger) {
              raw.init++;
              byType[type] = (byType[type] || 0) + 1;
              const execution = hooks.executionAsyncId();
              // A fresh synchronous callback root outranks inherited reporter
              // ancestry; only an explicitly executing transport is suppressed.
              if (suppress || (!current && ignored.has(execution))) {
                ignored.add(id);
                return;
              }
              const owner = current ?? lineage.get(execution) ?? lineage.get(trigger);
              if (!owner) {
                if (ignored.has(trigger)) ignored.add(id);
                return;
              }
              lineage.set(id, owner);
              live.set(id, { id, type, trigger, scope: owner.id, resolved: false, depth: 0 });
              owner.resources++;
              revision++;
              if (sealed) admissionsAfterSeal++;
            },
            before(id) {
              raw.before++;
              const row = live.get(id);
              if (row) row.depth++;
            },
            after(id) {
              raw.after++;
              const row = live.get(id);
              if (row) row.depth--;
              notify();
            },
            promiseResolve(id) {
              raw.promiseResolve++;
              const row = live.get(id);
              if (row) row.resolved = true;
            },
            destroy(id) {
              raw.destroy++;
              live.delete(id);
              notify();
            },
          })
          .enable();
        // Deliberately conservative: promiseResolve is NOT reaction completion.
        // Every type (including unknown ones) stays live until destroy. GC-driven
        // PROMISE destruction and retained native handles can block this candidate.
        // No resource object is retained, no GC forced, no type whitelist applied.
        const snapshot = () => ({
          revision,
          callbackDepth,
          liveCount: live.size,
          resources: [...live.values()].map((row) => ({ ...row })),
          retainedByType: [...live.values()].reduce((out, row) => {
            out[row.type] = (out[row.type] || 0) + 1;
            return out;
          }, {}),
          unknownSettlementResources: live.size,
          raw: { ...raw },
          byType: { ...byType },
          scopeCount: scopes.size,
          lineageCount: lineage.size,
          ignoredReporterResources: ignored.size,
        });
        const finalize = (intent) => {
          const status = activeCount() ? "waiting" : intent !== revision ? "stale" : sealed ? "already-sealed" : "accepted";
          if (status === "accepted") sealed = true;
          return { status, intent, ...snapshot() };
        };
        const registry = new AgentRegistry();
        const attach = registry.attachSession;
        registry.attachSession = function (id, candidate, ...rest) {
          const result = Reflect.apply(attach, this, [id, candidate, ...rest]);
          if (!result) return result;
          check(!attached, "Unexpected second registry attachment");
          attached = true;
          const subscribe = candidate.subscribe;
          candidate.subscribe = function (listener) {
            registrationCount++;
            return Reflect.apply(subscribe, this, [
              function (...args) {
                // Fresh synchronous scope for EVERY callback, without identification,
                // awaiting, persistent ALS inheritance, or changing its return value.
                const owner = { id: ++nextScope, resources: 0 };
                scopes.set(owner.id, owner);
                revision++;
                callbackDepth++;
                if (sealed) admissionsAfterSeal++;
                const previous = current;
                current = owner;
                try {
                  return Reflect.apply(listener, this, args);
                } finally {
                  current = previous;
                  callbackDepth--;
                  notify();
                }
              },
            ]);
          };
          trace({ type: "subscribe-wrapper-installed", phase: "registry-attach", registrationCount });
          return result;
        };
        const pi = api.pi;
        ({ session } = await pi.createAgentSession({
          cwd: config.root,
          agentDir: config.agentDir,
          agentId: "CaptureProbe",
          parentTaskPrefix: "CaptureProbe",
          agentRegistry: registry,
          model: ctx.model,
          modelRegistry: ctx.modelRegistry,
          authStorage: ctx.modelRegistry.authStorage,
          settings: pi.Settings.isolated({ "autolearn.enabled": true, "autolearn.autoContinue": true, "autolearn.minToolCalls": 1 }),
          autoApprove: true,
          sessionManager: pi.SessionManager.create(config.root, config.sessionsDir),
        }));
        check(attached && registrationCount > 0, "No SDK subscriptions after early attachment");
        trace({
          type: "sdk-created",
          registrationCount,
          orderingEvidence: "exact pinned SDK attaches registry before constructing native AutoLearnController; no listener inspected",
        });
        const nativeCapture = session.runAutolearnCapture;
        const nativeRefresh = session.refreshSkills;
        session.runAutolearnCapture = async function (...args) {
          const ordinal = ++captureAttempts;
          nativeWindow = true;
          // Observational only: there is NO explicit capture-method ownership token
          // and no sealed rejection gate that could discard native pending work.
          trace({ type: "capture-entered", ordinal, ...snapshot() });
          try {
            if (ordinal === 1) await control("/admission-latch", { ordinal });
            return await Reflect.apply(nativeCapture, this, args);
          } finally {
            if (ordinal === 1) {
              firstFence = finalize(revision);
              trace({ type: "first-method-return-fence", decision: firstFence, primaryEnds, captureAttempts });
            }
            trace({ type: "capture-settled", ordinal, ...snapshot() });
            if (ordinal === 2) nativeWindow = false;
          }
        };
        session.refreshSkills = async function (...args) {
          const ordinal = ++refreshes;
          await control("/refresh-latch", { ordinal });
          const result = await Reflect.apply(nativeRefresh, this, args);
          check(
            session.skills.some((skill) => skill.name === `capture-${ordinal}`),
            "Native skill refresh missing",
          );
          trace({ type: "refresh-returned", ordinal, nativeSkillVisible: true });
          return result;
        };
        session.subscribe((event) => {
          if (event.type === "agent_end") primaryEnds++;
        });
        const primary = async (text) => {
          await session.prompt(text);
          await session.waitForIdle();
        };
        await primary("CAPTURE_PRIMARY_ONE: write the first local fixture file.");
        await control("/await", { type: "capture-admission-held" });
        const oldIntent = revision;
        check(finalize(revision).status === "waiting", "No descendant ownership during capture admission");
        await primary("CAPTURE_PRIMARY_TWO: write the second local fixture file.");
        check(primaryEnds === 2 && captureAttempts === 1, "Native pending setup failed");
        await control("/release", { key: "admission-1" });
        await control("/await", { type: "refresh-held", ordinal: 1 });
        trace({ type: "held-refresh-ledger", decision: finalize(revision), oldIntent });
        await flush();
        await control("/release", { key: "refresh-1" });
        // Provider/refresh events are host-side factual barriers, not guessed sleeps.
        await control("/await", { type: "refresh-held", ordinal: 2 });
        await session.waitForIdle();
        await session.sessionManager.flush();
        // Wait for observed lifecycle deletion only. Deadline is a negative result,
        // never evidence of settlement. It is scheduled outside native ownership.
        const cessation = await outside(
          () =>
            new Promise((resolve) => {
              const timer = setTimeout(() => {
                zeroWaiter = undefined;
                resolve("deadline");
              }, 5000);
              zeroWaiter = () => {
                clearTimeout(timer);
                zeroWaiter = undefined;
                resolve("empty");
              };
              notify();
            }),
        );
        const finalLedger = snapshot();
        const oldDecision = finalize(oldIntent);
        const freshDecision = finalize(revision);
        const secondSettled = records.some((event) => event.type === "capture-settled" && event.ordinal === 2);
        const nativeComplete = captureAttempts === 2 && refreshes === 2 && secondSettled && records.some((event) => event.type === "refresh-returned" && event.ordinal === 2);
        let status = "failed";
        if (firstFence?.status === "waiting" && nativeComplete && admissionsAfterSeal === 0 && ownershipGaps === 0) {
          status = cessation === "empty" && oldDecision.status === "stale" && freshDecision.status === "accepted" ? "passed-supported-subset" : "liveness-blocked";
        }
        trace({
          type: "outcome",
          status,
          primaryEnds,
          captureAttempts,
          refreshes,
          nativeComplete,
          firstFence,
          finalLedger,
          oldDecision,
          freshDecision,
          cessation,
          admissionsAfterSeal,
          ownershipGaps,
          scope:
            "Accounting-only: two native stops and pending capture replay; no post-seal admission enforcement, whole-session, error, cancellation, worker, or generation proof",
          limits:
            "Destroy-only accounting is conservative; promiseResolve never releases ownership. Async init ancestry completeness is a runtime assumption, not certified by self-test.",
        });
        await flush();
      } catch (error) {
        await trace({ type: "outcome", status: "failed", error: String(error), stack: error?.stack });
        // The buffered trace path has no network; report failures directly outside it.
        if (reporter) await reporter.runInAsyncScope(() => post("/trace", { type: "outcome", status: "failed", error: String(error), stack: error?.stack }));
      } finally {
        capabilityHook?.disable();
        hook?.disable();
        try {
          await session?.dispose();
        } catch (error) {
          cleanups.push(String(error));
        }
        reporter?.emitDestroy();
        await post("/trace", { type: "owned-session-disposed", cleanupErrors: cleanups, sessionCreated: !!session });
      }
      return { content: [{ type: "text", text: "Callback descendant diagnostic finished" }] };
    },
  });
}
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    path.join(agentDir, "models.yml"),
    JSON.stringify({
      providers: {
        "capture-local": {
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
  const extension = path.join(root, "capture-probe.ts");
  writeFileSync(extension, `export default api => (${installProbe.toString()})(api, ${JSON.stringify({ url, root, agentDir, sessionsDir: path.join(root, "sessions") })});`);
  const configPath = path.join(root, "config.yml");
  writeFileSync(configPath, "{}\n");
  child = spawn(
    binary,
    ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", extension, "--model", "capture-local/probe", "--thinking", "off", "--config", configPath],
    {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_CONFIG_DIR: path.join(root, "config") },
      stdio: ["pipe", "pipe", "pipe"],
    },
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
        if (["ready", "response", "extension_error"].includes(event.type)) record(event);
      } catch {
        record({ type: "stdout", line });
      }
    }
  });
  child.stderr.on("data", (chunk) => record({ type: "stderr", text: String(chunk) }));
  const ready = await waitFor((event) => ["ready", "process-closed", "process-error"].includes(event.type));
  assert.equal(ready.type, "ready", JSON.stringify(ready));
  child.stdin.write(`${JSON.stringify({ id: "capture-probe", type: "prompt", message: "Run autolearn_probe now." })}\n`);
  const outcome = await waitFor((event) => ["outcome", "fixture-error", "process-closed", "process-error"].includes(event.type));
  assert.ok(["passed-supported-subset", "unsupported", "liveness-blocked", "failed"].includes(outcome.status), JSON.stringify(outcome));
  const cleanup = await waitFor((event) => event.type === "owned-session-disposed");
  assert.deepEqual(cleanup.cleanupErrors, [], "Fixture-owned session cleanup failed");
  process.exitCode = { "passed-supported-subset": 0, unsupported: 2, "liveness-blocked": 3, failed: 1 }[outcome.status];
  console.log(JSON.stringify({ ...outcome, captureRequests, primaryRequests, events: events.filter((event) => !["ready", "response"].includes(event.type)) }, null, 2));
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({ status: "failed", error: String(error), recent: events.slice(-35) }, null, 2));
} finally {
  for (const response of held.values()) response.destroy();
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
