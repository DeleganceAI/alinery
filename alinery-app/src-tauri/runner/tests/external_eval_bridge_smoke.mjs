// Opt-in unchanged-OMP stock EvalTool diagnostic. Prototype decoration is
// compatibility-sensitive; the external ledger is an experiment, not Alinery authority.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.argv.includes("--help")) {
  console.log(
    "OMP_BIN=/Applications/Alinery.omp/omp node external_eval_bridge_smoke.mjs\nLoopback-only stock JS/Python attachment and exact completion settlement probe.\nExit 0: both bounded subsets passed; 2: all unsupported; 3: partial/coverage gap; 1: failure.\nNo cancellation, owner-release, reload, whole-session or production certification.",
  );
  process.exit(0);
}
assert.equal(process.argv.length, 2, "Unknown argument");
const binary = process.env.OMP_BIN || "/Applications/Alinery.omp/omp";
const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
assert.match(version, /18\.1\.13\b/);
const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
const root = mkdtempSync(path.join(tmpdir(), "alinery-eval-bridge-"));
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
    const response = await fetch(config.url + route, { method: "POST", body: JSON.stringify(body) });
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
    label: "Stock eval bridge probe",
    description: "Run isolated native bridge reachability diagnostic",
    parameters: api.zod.z.object({}),
    loadMode: "essential",
    async execute(_id, _input, _signal, _update, ctx) {
      const results = [];
      const imports = {};
      const modules = {};
      const runtime = { execPath: process.execPath, bun: process.versions.bun, node: process.versions.node };
      const loaders = {
        js: { specifier: "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime", load: () => import("@oh-my-pi/pi-coding-agent/eval/js/shared/runtime") },
        py: { specifier: "@oh-my-pi/pi-coding-agent/eval/py/kernel", load: () => import("@oh-my-pi/pi-coding-agent/eval/py/kernel") },
        completion: { specifier: "@oh-my-pi/pi-coding-agent/eval/completion-bridge", load: () => import("@oh-my-pi/pi-coding-agent/eval/completion-bridge") },
        backend: { specifier: "@oh-my-pi/pi-coding-agent/eval", load: () => import("@oh-my-pi/pi-coding-agent/eval") },
        toolBridge: { specifier: "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge", load: () => import("@oh-my-pi/pi-coding-agent/eval/js/tool-bridge") },
      };
      for (const [key, { specifier, load }] of Object.entries(loaders)) {
        try {
          modules[key] = await load();
          imports[key] = { specifier, available: true, repeatedImportIdentity: modules[key] === (await load()) };
        } catch (error) {
          imports[key] = { specifier, available: false, error: String(error) };
        }
      }
      await post("/trace", { type: "imports", runtime, imports });
      for (const language of ["js", "py"]) {
        let session;
        let proxy;
        const restore = [];
        const active = new Set();
        const admission = deferred();
        const reached = deferred();
        const bound = deferred();
        let calls = 0;
        let intercepted = 0;
        let kernelWaitCalls = 0;
        let entry;
        let actualToolSession;
        let backendCalls = 0;
        let settlement;
        let nativeId;
        let exactSettled = false;
        let mapIdentity = null;
        let bridgeGap;
        let pendingCell;
        const result = {
          language,
          imports: { observer: imports[language], completion: imports.completion, backend: imports.backend, toolBridge: imports.toolBridge },
          status: "unsupported",
          classification: "unsupported-import",
        };
        const finalize = () => (active.size ? "waiting" : "eligible");
        const observe = async (name, args, original) => {
          if (name === "__wait__") kernelWaitCalls++;
          if (name !== "__completion__") return original();
          intercepted++;
          check(args?.prompt === `BRIDGE_PRODUCER_${language}`, "Unexpected observed producer");
          const lease = {};
          active.add(lease);
          reached.resolve();
          await admission.promise;
          let value;
          try {
            value = await original();
          } catch (error) {
            bound.resolve();
            throw error;
          }
          nativeId = value?.id;
          if (typeof nativeId !== "string") {
            bridgeGap = "Native completion returned no successful handle; original error response preserved";
            bound.resolve();
            return value;
          }
          entry = modules.completion?.getCompletionHandle?.(nativeId);
          if (entry) {
            mapIdentity = modules.completion.getCompletionHandle(nativeId) === entry;
            bound.resolve();
            check(entry.ownerId === session.getAgentId(), "Native completion belongs to another owner");
            result.nativeOwner = entry.ownerId;
            check(entry.promise && typeof entry.promise.then === "function", "Native entry lacks promise");
            result.settlementMechanism = "native-map-promise";
            settlement = entry.promise.then(() => {
              exactSettled = true;
              active.delete(lease);
              return { kind: "completion", id: nativeId, status: entry.error ? "failed" : "completed", text: entry.result?.text, error: entry.error };
            });
          } else if (actualToolSession && typeof modules.toolBridge?.callSessionTool === "function") {
            bound.resolve();
            const ownerId = actualToolSession.getAgentId?.();
            check(ownerId === session.getAgentId(), "Captured native ToolSession belongs to another owner");
            result.nativeOwner = ownerId;
            result.settlementMechanism = "native-owner-scoped-wait";
            const item = { kind: "completion", id: nativeId };
            // Native resolveHandle captures the real entry/promise synchronously,
            // before callSessionTool yields. No timeout/signal or producer cancel.
            // Attach rejection handling immediately; unknown IDs never settle a lease.
            settlement = modules.toolBridge.callSessionTool("__wait__", { items: [item] }, { session: actualToolSession }).then(
              (value) => {
                const snapshot = value?.items?.[0];
                if (value?.items?.length !== 1 || snapshot?.id !== nativeId || snapshot?.kind !== "completion" || snapshot.status === "running") {
                  return { error: "Native wait returned no matching terminal completion snapshot" };
                }
                exactSettled = true;
                active.delete(lease);
                return snapshot;
              },
              (error) => ({ error: String(error) }),
            );
            try {
              const status = await modules.toolBridge.callSessionTool("__status__", { item }, { session: actualToolSession });
              if (status?.id !== nativeId || status?.kind !== "completion" || status?.status !== "running") {
                bridgeGap = "Native owner-scoped status did not identify the held producer as running";
              } else result.nativeRunningStatus = true;
            } catch (error) {
              bridgeGap = `Native owner-scoped handle binding failed: ${String(error)}`;
            }
          } else {
            bridgeGap = imports.completion.available
              ? "Native ID absent from imported map; no reached native backend ToolSession/wait path available"
              : "Completion-map import unavailable; no reached native backend ToolSession/wait path available";
          }
          bound.resolve();
          return value;
        };
        try {
          if (language === "py" && modules.backend?.pythonBackend) {
            const backend = modules.backend.pythonBackend;
            const original = backend.execute;
            check(typeof original === "function", "Missing pythonBackend.execute");
            backend.execute = function (code, options) {
              if (session && options?.session?.getAgentId?.() === session.getAgentId()) {
                backendCalls++;
                actualToolSession = options.session;
              }
              return original.call(this, code, options);
            };
            restore.push(() => {
              backend.execute = original;
            });
          }
          if (language === "js" && modules.js?.JsRuntime) {
            const prototype = modules.js.JsRuntime.prototype;
            for (const [name, hookIndex] of [
              ["run", 2],
              ["runCallback", 1],
            ]) {
              const original = prototype[name];
              check(typeof original === "function", `Missing JsRuntime.${name}`);
              prototype[name] = function (...args) {
                calls++;
                const hooks = args[hookIndex];
                args[hookIndex] = { ...hooks, callTool: (tool, input) => observe(tool, input, () => hooks.callTool(tool, input)) };
                return original.apply(this, args);
              };
              restore.push(() => {
                prototype[name] = original;
              });
            }
          }
          if (language === "py" && modules.py?.PythonKernel) {
            const targets = new Map();
            proxy = Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              async fetch(request) {
                const pathname = new URL(request.url).pathname;
                const target = targets.get(pathname.split("/")[1]);
                if (!target || request.method !== "POST" || !pathname.endsWith("/v1/tool")) return new Response("Not found", { status: 404 });
                const bytes = await request.arrayBuffer();
                const body = JSON.parse(new TextDecoder().decode(bytes));
                let upstream;
                await observe(body.name, body.args, async () => {
                  upstream = await fetch(`${target}/v1/tool`, { method: request.method, headers: request.headers, body: bytes, signal: request.signal });
                  const envelope = await upstream.clone().json();
                  return envelope.ok ? envelope.value : undefined;
                });
                return upstream;
              },
            });
            const prototype = modules.py.PythonKernel.prototype;
            const own = Object.getOwnPropertyDescriptor(prototype, "execute");
            const original = prototype.execute;
            check(typeof original === "function", "Missing PythonKernel.execute");
            prototype.execute = function (code, options) {
              calls++;
              const target = options?.env?.PI_TOOL_BRIDGE_URL;
              if (!target) return original.call(this, code, options);
              check(new URL(target).hostname === "127.0.0.1", "Refusing non-loopback native bridge");
              const key = crypto.randomUUID();
              targets.set(key, target);
              // Preserve native token/session/run/signal/options; never report env or headers.
              return original
                .call(this, code, { ...options, env: { ...options.env, PI_TOOL_BRIDGE_URL: `http://127.0.0.1:${proxy.port}/${key}` } })
                .finally(() => targets.delete(key));
            };
            restore.push(() => {
              if (own) Object.defineProperty(prototype, "execute", own);
              else delete prototype.execute;
            });
          }
          const pi = api.pi;
          ({ session } = await pi.createAgentSession({
            cwd: config.root,
            agentDir: config.agentDir,
            agentId: `BridgeProbe_${language}`,
            parentTaskPrefix: `BridgeProbe_${language}`,
            model: ctx.model,
            modelRegistry: ctx.modelRegistry,
            authStorage: ctx.modelRegistry.authStorage,
            settings: pi.Settings.isolated({}),
            autoApprove: true,
            sessionManager: pi.SessionManager.create(config.root, config.sessionsDir),
          }));
          const evalTool = session.getToolByName("eval");
          check(typeof evalTool?.execute === "function", "Native EvalTool unavailable through public session lookup");
          const cell = async (code) => {
            const value = await evalTool.execute(`bridge-${crypto.randomUUID()}`, { language, code, title: "Stock bridge diagnostic", timeout: 30 });
            check(!value.isError && !value.details?.isError, `Native eval error: ${JSON.stringify(value)}`);
            if (value.details?.async?.state === "running") {
              const error = new Error("Stock eval auto-backgrounded; native cell lifetime not joined by this diagnostic");
              error.coverageGap = true;
              throw error;
            }
            return value;
          };
          const source =
            language === "js"
              ? `var bridgeHandle = await completion("BRIDGE_PRODUCER_js"); display(bridgeHandle.id);`
              : `bridge_handle = completion("BRIDGE_PRODUCER_py")\nprint(bridge_handle.id)`;
          pendingCell = cell(source);
          const first = await Promise.race([reached.promise.then(() => "observed"), pendingCell.then(() => "returned")]);
          if (first === "observed") {
            check(intercepted === 1 && finalize() === "waiting", "Producer admission not reserved");
            check((await post("/state", { language })).producerCount === 0, "Producer dispatched before admission");
            result.predispatch = true;
            admission.resolve();
            await bound.promise;
          }
          const producerCell = await pendingCell;
          result.nativeCell = producerCell;
          result.observerCalls = calls;
          result.intercepted = intercepted;
          result.nativeBackendCalls = backendCalls;
          result.nativeToolSessionCaptured = Boolean(actualToolSession);
          if (!intercepted) {
            result.status = imports[language].available ? "coverage-gap" : "unsupported";
            result.classification = imports[language].available ? "available-but-not-reached" : "unsupported-import";
            result.barrier = "Stock cell returned without host observer; no cross-realm installation or producer accounting established";
            await post("/release", { language });
            await cell(language === "js" ? "display(await bridgeHandle.wait());" : "print(bridge_handle.wait())");
            continue;
          }
          result.classification = "actual-producer-interception";
          result.nativeId = nativeId;
          result.sharedNativeMapIdentity = mapIdentity;
          if (bridgeGap) {
            result.status = "coverage-gap";
            result.barrier = bridgeGap;
            await post("/release", { language });
            await cell(language === "js" ? "display(await bridgeHandle.wait());" : "print(bridge_handle.wait())");
            continue;
          }
          await post("/await-provider", { language });
          check((await post("/state", { language })).held, "Producer response not held");
          check(!entry?.settled && !exactSettled && finalize() === "waiting", "Unused producer lost ownership after cell return");
          result.unusedHandleOwnedAfterCell = true;
          await post("/release", { language });
          const settled = await settlement;
          check(
            settled?.kind === "completion" && settled.id === nativeId && settled.status === "completed" && !settled.error && settled.text === "native-result",
            `Native producer did not successfully settle: ${JSON.stringify(settled)}`,
          );
          check(exactSettled && finalize() === "eligible", "Exact settlement did not clear lease");
          result.exactSettlement = true;
          // Populate the stock helper's result cache, then separately admit one
          // later native eval. No dependency declaration or guessed ID is used.
          await cell(language === "js" ? "display(await bridgeHandle.wait());" : "print(bridge_handle.wait())");
          const primedWaitCalls = kernelWaitCalls;
          check(primedWaitCalls === 1, "Stock handle cache was not populated through its native wait");
          {
            const key = `${language}-cached-consumer`;
            const gate = deferred();
            const lease = {};
            active.add(lease);
            const effectPath = `${config.root}/${key}.txt`;
            const effectRequest = JSON.stringify({ key });
            const code =
              language === "js"
                ? `var cached = await bridgeHandle.wait(); await fetch(${JSON.stringify(`${config.url}/effect`)}, {method:"POST",body:${JSON.stringify(effectRequest)}}); await tool.write({path:${JSON.stringify(effectPath)},content:cached});`
                : `cached = bridge_handle.wait()\nimport urllib.request\nwith urllib.request.urlopen(urllib.request.Request(${JSON.stringify(`${config.url}/effect`)}, data=${JSON.stringify(effectRequest)}.encode(), method="POST")) as response:\n    response.read()\nwith open(${JSON.stringify(effectPath)}, "w") as output:\n    output.write(cached)`;
            const consumer = (async () => {
              await gate.promise;
              try {
                return await cell(code);
              } finally {
                active.delete(lease);
              }
            })();
            check(finalize() === "waiting", "Later eval admission missing");
            gate.resolve();
            await post("/await-effect", { key });
            check(finalize() === "waiting", "Cached consumer lost ownership before effect");
            check(!(await Bun.file(effectPath).exists()), "Effect crossed held barrier");
            await post("/release-effect", { key });
            await consumer;
            check((await Bun.file(effectPath).text()) === "native-result", "Cached consumer effect missing");
            check(finalize() === "eligible", "Consumer lease did not settle");
            check(kernelWaitCalls === primedWaitCalls, "Cached consumer unexpectedly dispatched a new native wait");
            check((await post("/state", { language })).producerCount === 1, "Cached consumer unexpectedly started another producer");
            result.cachedConsumer = {
              heldThroughEffect: true,
              dependencyDeclarationRequired: false,
              additionalKernelWaitCalls: kernelWaitCalls - primedWaitCalls,
              additionalProducerRequests: 0,
            };
          }
          result.status = "passed-bounded-subset";
          result.classification = "conditional-settlement-proved";
        } catch (error) {
          result.status = error.coverageGap ? "coverage-gap" : "failed";
          result.error = String(error);
        } finally {
          admission.resolve();
          await post("/release", { language });
          if (pendingCell) await pendingCell.catch(() => {});
          if (session) {
            try {
              await session.dispose();
            } catch (error) {
              result.status = "failed";
              result.cleanupError = String(error);
            }
          }
          for (const undo of restore.reverse()) undo();
          if (proxy) await proxy.stop(true);
          results.push(result);
          await post("/trace", { type: "language-result", ...result });
        }
      }
      const status = results.some((r) => r.status === "failed")
        ? "failed"
        : results.every((r) => r.status === "passed-bounded-subset")
          ? "passed-bounded-subset"
          : results.every((r) => r.status === "unsupported")
            ? "unsupported"
            : "partial-or-coverage-gap";
      await post("/trace", {
        type: "outcome",
        status,
        runtime,
        imports,
        results,
        scope: "SDK-owned native EvalTool, stock helpers; compatibility-sensitive external observer and simulated authority. No denial/cancel/owner-release/reload coverage.",
      });
      return { content: [{ type: "text", text: status }] };
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
  process.exitCode = { "passed-bounded-subset": 0, unsupported: 2, "partial-or-coverage-gap": 3 }[outcome.status] ?? 1;
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
