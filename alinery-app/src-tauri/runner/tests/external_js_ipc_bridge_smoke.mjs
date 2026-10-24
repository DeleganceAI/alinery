// Opt-in unchanged-OMP v18.1.13 public Bun IPC diagnostic. Not documented OMP middleware.
// Exact source a1b254047d12e143b7c6011536e918c6c35c5906: worker-client.ts236-248,
// context-manager.ts627-660/813-850, worker-protocol.ts39-55; no native source changes.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.argv.includes("--help")) {
  console.log(
    "OMP_BIN=/Applications/Alinery.omp/omp node external_js_ipc_bridge_smoke.mjs\nLoopback-only stock JS public runtime IPC and exact native settlement probe.\nExit 0: bounded subset passed; 2: unsupported; 3: coverage gap; 1: failure.\nNo cancellation, owner-release, reload, whole-session or production certification.",
  );
  process.exit(0);
}
assert.equal(process.argv.length, 2, "Unknown argument");
const binary = process.env.OMP_BIN || "/Applications/Alinery.omp/omp";
const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
assert.match(version, /18\.1\.13\b/);
const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
const root = mkdtempSync(path.join(tmpdir(), "alinery-js-ipc-bridge-"));
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
    }, 60000);
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
      const language = ["js", "py"].find((value) => text.includes(`BRIDGE_PRODUCER_${value}`));
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
    const response = await fetch(config.url + route, { method: "POST", body: JSON.stringify({ language: "js", ...body }) });
    if (!response.ok) throw new Error(`Fixture route failed: ${route}`);
    return response.json();
  };
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
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
    label: "Native JS IPC bridge probe",
    description: "Run isolated public runtime IPC diagnostic",
    parameters: api.zod.z.object({}),
    loadMode: "essential",
    async execute(_id, _input, _signal, _update, ctx) {
      const result = { status: "unsupported", runtime: { execPath: process.execPath, bun: process.versions.bun }, observations: [] };
      const active = new Set();
      const restore = [];
      const admission = deferred();
      const reached = deferred();
      let session, actualToolSession, pendingCell, settlement, nativeId;
      let request,
        producerLease,
        exactSettled = false,
        unsupported;
      let backendCalls = 0,
        waitCalls = 0,
        spawnCalls = 0;
      const faults = [];
      const note = (type, fields = {}) => result.observations.push({ type, ...fields });
      // Diagnostic observer errors never replace a native IPC success/failure frame.
      const fault = (error) => {
        faults.push(String(error));
      };
      const decorate = (object, key, replacement) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        const original = object[key];
        try {
          object[key] = replacement;
          check(object[key] === replacement, `Public ${key} is not writable`);
        } catch (error) {
          unsupported = `Public runtime decoration unavailable: ${key}: ${String(error)}`;
          throw error;
        }
        restore.push(() => {
          if (descriptor) Object.defineProperty(object, key, descriptor);
          else delete object[key];
          check(object[key] === original, `Could not restore ${key}`);
        });
      };
      try {
        let backend, callSessionTool;
        try {
          ({ jsBackend: backend } = await import("@oh-my-pi/pi-coding-agent/eval"));
          ({ callSessionTool } = await import("@oh-my-pi/pi-coding-agent/eval/js/tool-bridge"));
        } catch (error) {
          unsupported = `Literal packaged import unavailable: ${String(error)}`;
          throw error;
        }
        check(typeof backend?.execute === "function" && typeof callSessionTool === "function", "Missing public native exports");
        const originalExecute = backend.execute;
        decorate(backend, "execute", function (...args) {
          const options = args[1];
          if (session && options?.session?.getAgentId?.() === session.getAgentId()) {
            actualToolSession = options.session;
            backendCalls++;
          }
          return Reflect.apply(originalExecute, this, args);
        });
        const originalSpawn = Bun.spawn;
        decorate(Bun, "spawn", function (...args) {
          const options = args[0];
          // Restrict to the observed stock JS process command after owner capture.
          // Other transports are a coverage gap, never forced into this path.
          if (
            !actualToolSession ||
            actualToolSession.getAgentId() !== session.getAgentId() ||
            !Array.isArray(options?.cmd) ||
            !options.cmd.includes("__omp_worker_js_eval_process") ||
            typeof options.ipc !== "function"
          )
            return Reflect.apply(originalSpawn, this, args);
          spawnCalls++;
          const originalIpc = options.ipc;
          const ipcDescriptor = Object.getOwnPropertyDescriptor(options, "ipc");
          let proc,
            sendReady = false;
          const runs = new Set();
          let initialized = false;
          const wrapper = function (...messages) {
            const message = messages[0];
            if (!sendReady || !initialized || !runs.has(message?.runId) || message?.type !== "tool-call") {
              return Reflect.apply(originalIpc, this, messages);
            }
            if (message.name === "__wait__") waitCalls++;
            if (message.name !== "__completion__" || message.args?.prompt !== "BRIDGE_PRODUCER_js") {
              return Reflect.apply(originalIpc, this, messages);
            }
            if (request) {
              fault("Unexpected second producer request");
              return Reflect.apply(originalIpc, this, messages);
            }
            // Reserve synchronously before returning from the genuine incoming IPC callback.
            producerLease = {};
            active.add(producerLease);
            request = { id: message.id, runId: message.runId, pid: proc.pid };
            note("native-incoming-reserved", request);
            reached.resolve();
            admission.promise
              .then(() => {
                note("original-ipc-forwarded", request);
                Reflect.apply(originalIpc, this, messages);
              })
              .catch(fault);
          };
          try {
            options.ipc = wrapper;
            check(options.ipc === wrapper, "Public options.ipc is not writable");
          } catch (error) {
            unsupported = String(error);
            return Reflect.apply(originalSpawn, this, args);
          }
          try {
            // Same options object, command, environment and native process; only IPC callback decorated.
            proc = Reflect.apply(originalSpawn, this, args);
          } finally {
            if (ipcDescriptor) Object.defineProperty(options, "ipc", ipcDescriptor);
            else delete options.ipc;
          }
          const originalSend = proc.send;
          try {
            decorate(proc, "send", function (...messages) {
              const message = messages[0];
              try {
                if (message?.type === "init" && message.snapshot?.cwd === config.root) {
                  initialized = true;
                  note("native-init", { pid: proc.pid, sessionId: message.snapshot.sessionId });
                }
                if (initialized && message?.type === "run" && message.snapshot?.cwd === config.root) {
                  runs.add(message.runId);
                  note("native-run", { pid: proc.pid, runId: message.runId });
                }
                if (request && message?.type === "tool-reply" && message.id === request.id && !settlement) {
                  note("native-response", { ...request, ok: message.reply?.ok });
                  if (!message.reply?.ok) fault("Native completion failed; original failure frame preserved");
                  else {
                    nativeId = message.reply.value?.id;
                    check(typeof nativeId === "string", "Successful native reply lacks ID");
                    const owner = actualToolSession.getAgentId();
                    check(owner === session.getAgentId(), "Native ToolSession owner mismatch");
                    result.nativeOwner = owner;
                    // callSessionTool executes native resolveHandle before its first await.
                    // Bind before original send, not after worker receipt or cell return.
                    settlement = callSessionTool("__wait__", { items: [{ kind: "completion", id: nativeId }] }, { session: actualToolSession }).then(
                      (value) => {
                        const item = value?.items?.[0];
                        if (value?.items?.length !== 1 || item?.id !== nativeId || item?.kind !== "completion" || !["completed", "failed"].includes(item.status)) {
                          fault("Unknown/nonterminal native wait result; lease retained");
                          return value;
                        }
                        exactSettled = true;
                        active.delete(producerLease);
                        return item;
                      },
                      (error) => {
                        fault(error);
                        return { error: String(error) };
                      },
                    );
                    note("native-wait-bound-before-send", { ...request, nativeId, owner });
                  }
                }
              } catch (error) {
                fault(error);
              }
              return Reflect.apply(originalSend, this, messages);
            });
            sendReady = true;
          } catch (error) {
            fault(error);
          }
          return proc;
        });
        const pi = api.pi;
        ({ session } = await pi.createAgentSession({
          cwd: config.root,
          agentDir: config.agentDir,
          agentId: "JsIpcProbe",
          parentTaskPrefix: "JsIpcProbe",
          model: ctx.model,
          modelRegistry: ctx.modelRegistry,
          authStorage: ctx.modelRegistry.authStorage,
          settings: pi.Settings.isolated({}),
          autoApprove: true,
          sessionManager: pi.SessionManager.create(config.root, config.sessionsDir),
        }));
        const evalTool = session.getToolByName("eval");
        check(typeof evalTool?.execute === "function", "Public native EvalTool unavailable");
        const cell = async (code) => {
          const value = await evalTool.execute(`ipc-${crypto.randomUUID()}`, { language: "js", code, title: "Native IPC diagnostic", timeout: 30 });
          check(!value.isError && !value.details?.isError, `Native eval failed: ${JSON.stringify(value)}`);
          if (value.details?.async?.state === "running") {
            const error = new Error("Native eval auto-backgrounded: cell lifetime not joined");
            error.coverageGap = true;
            throw error;
          }
          return value;
        };
        pendingCell = cell('var bridgeHandle = await completion("BRIDGE_PRODUCER_js"); display(bridgeHandle.id);');
        const first = await Promise.race([reached.promise.then(() => "observed"), pendingCell.then(() => "returned")]);
        if (first !== "observed") {
          result.status = unsupported ? "unsupported" : "coverage-gap";
          result.barrier = unsupported || "Native cell returned without observing the selected transport";
        } else {
          check(active.size === 1 && !exactSettled, "Incoming reservation missing");
          check((await post("/state")).producerCount === 0, "Provider dispatched before admission");
          note("provider-zero-before-forward");
          admission.resolve();
          result.nativeCell = await pendingCell;
          check(!faults.length, faults.join("; "));
          check(settlement && nativeId, "Native response/wait binding missing");
          await post("/await-provider");
          check((await post("/state")).held && active.size === 1 && !exactSettled, "Unused handle lease lost after native cell return");
          note("pending-after-native-cell-return", { nativeId });
          await post("/release");
          const snapshot = await settlement;
          check(
            snapshot?.id === nativeId && snapshot.kind === "completion" && snapshot.status === "completed" && snapshot.text === "native-result" && !snapshot.error,
            `Native wait failed: ${JSON.stringify(snapshot)}`,
          );
          check(exactSettled && active.size === 0, "Exact settlement did not clear producer lease");
          result.nativeSnapshot = snapshot;
          await cell("display(await bridgeHandle.wait());");
          check(waitCalls === 1, "Native helper cache not primed by exactly one observed wait");
          const primedWaitCalls = waitCalls;
          const key = "js-cached-consumer";
          const effectPath = `${config.root}/${key}.txt`;
          const lease = {};
          active.add(lease);
          check(active.size === 1, "Separate cached consumer admission missing");
          const consumer = cell(
            `var cached = await bridgeHandle.wait(); await fetch(${JSON.stringify(`${config.url}/effect`)}, {method:"POST",body:${JSON.stringify(JSON.stringify({ key }))}}); await tool.write({path:${JSON.stringify(effectPath)},content:cached});`,
          );
          pendingCell = consumer;
          // Retain the host eval lease until native completion, not handle-cache return.
          consumer.then(
            () => active.delete(lease),
            () => active.delete(lease),
          );
          await post("/await-effect", { key });
          check(active.has(lease) && !(await Bun.file(effectPath).exists()), "Cached consumer crossed held file-effect boundary");
          note("cached-consumer-effect-held");
          await post("/release-effect", { key });
          await consumer;
          check((await Bun.file(effectPath).text()) === "native-result", "Real native file effect missing");
          check(
            active.size === 0 && waitCalls === primedWaitCalls && (await post("/state")).producerCount === 1,
            "Cached consumer leaked a lease or dispatched another wait/producer",
          );
          check(!faults.length, faults.join("; "));
          result.cachedConsumer = { separateEvalLease: true, heldFileEffect: true, additionalNativeWaits: 0, additionalProviderRequests: 0 };
          result.status = "passed-bounded-subset";
        }
      } catch (error) {
        result.status = unsupported ? "unsupported" : error.coverageGap ? "coverage-gap" : "failed";
        result.error = String(error);
      } finally {
        admission.resolve();
        await post("/release");
        // Release only fixture effects, including an early diagnostic failure.
        await post("/cleanup-effects");
        if (pendingCell) await pendingCell.catch(() => {});
        if (session) {
          try {
            await session.dispose();
          } catch (error) {
            result.status = "failed";
            result.cleanupError = String(error);
          }
        }
        for (const undo of restore.reverse()) {
          try {
            undo();
          } catch (error) {
            result.status = "failed";
            result.cleanupError = String(error);
          }
        }
      }
      Object.assign(result, { nativeId, request, backendCalls, spawnCalls, nativeWaitCalls: waitCalls, faults, retainedLeases: active.size });
      await post("/trace", {
        type: "outcome",
        ...result,
        scope:
          "Compatibility-sensitive public Bun IPC decoration, unchanged installed OMP. Bounded native JS transport experiment only; no startup/reload/cancel/isolation or full authority proof.",
      });
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
