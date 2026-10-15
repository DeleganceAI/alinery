// Opt-in stock OMP lifecycle experiment; no production authority or native patches.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.argv.includes("--help")) {
  console.log(
    "OMP_BIN=/Applications/Alinery.omp/omp node external_py_lifecycle_smoke.mjs\nLoopback native Python cancellation, owner release and concurrent-owner diagnostic.\nExit 0: bounded cases proved; 2: unsupported; 3: coverage gap; 1: failure/counterexample.\nReset/reload/process-exit are not proved. No production integration.",
  );
  process.exit(0);
}
assert.equal(process.argv.length, 2);
const binary = process.env.OMP_BIN || "/Applications/Alinery.omp/omp";
const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
assert.match(version, /18\.1\.13\b/);
const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
assert.equal(sha256, "9d4b74e20502f06348143fc3fbd630326d16c1a11a7eb0a94b44e5818aa78e47");
const root = mkdtempSync(path.join(tmpdir(), "alinery-py-lifecycle-"));
const agentDir = path.join(root, "agent");
const events = [];
const listeners = new Set();
const sockets = new Set();
const providers = new Map();
const releases = new Set();
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
      const value = events.find(predicate);
      if (value) {
        clearTimeout(timer);
        listeners.delete(check);
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      listeners.delete(check);
      reject(new Error("Diagnostic deadline, not settlement evidence"));
    }, 60000);
    listeners.add(check);
    check();
  });
const answer = (response, tool = false) => {
  if (response.destroyed || response.writableEnded) return;
  const id = `lifecycle_${++sequence}`;
  const delta = tool
    ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: "lifecycle_probe", arguments: "{}" } }] }
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
    } else if (request.url === "/state") json({ keys: [...providers.keys()] });
    else if (request.url === "/await-provider") {
      await waitFor((e) => e.type === "provider" && e.key === body.key);
      json({});
    } else if (request.url === "/release") {
      releases.add(body.key);
      if (providers.has(body.key)) answer(providers.get(body.key));
      json({});
    } else if (["/chat/completions", "/v1/chat/completions"].includes(request.url)) {
      const text = JSON.stringify(body.messages);
      const key = text.match(/PY_LIFECYCLE_([A-Za-z0-9_-]+)/)?.[1];
      if (key) {
        assert.equal(providers.has(key), false, "Duplicate native producer request");
        providers.set(key, response);
        record({ type: "provider", key, model: body.model });
        response.on("close", () => record({ type: "provider-transport-closed", key, settlementEvidence: false }));
        if (releases.has(key)) answer(response);
      } else if (!bootstrap && body.tools?.some((t) => t.function?.name === "lifecycle_probe")) {
        bootstrap = true;
        answer(response, true);
      } else answer(response);
    } else throw new Error(`Unexpected route ${request.url}`);
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
    if (!response.ok) throw new Error(`Fixture route failed ${route}`);
    return response.json();
  };
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const latch = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const bounded = async (promise, label) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Diagnostic deadline: ${label}; not settlement`)), 20000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  api.registerTool({
    name: "lifecycle_probe",
    label: "Python lifecycle probe",
    description: "Run isolated native Python lifecycle diagnostics",
    parameters: api.zod.z.object({}),
    loadMode: "essential",
    async execute(_id, _input, _signal, _update, ctx) {
      const results = [];
      const faults = [];
      const owners = new Map();
      const activeBackends = new Map();
      const targets = new Map();
      const records = new Map();
      const leases = new Set();
      const restores = [];
      let proxy;
      let toolBridge;
      const report = (name, status, evidence) => results.push({ name, status, ...evidence });
      const summary = (record) => ({
        key: record.key,
        owner: record.owner,
        run: record.run,
        nativeId: record.id,
        forwarded: record.forwarded,
        terminal: record.terminal,
        retained: leases.has(record),
        nativeEnvelope: record.envelope,
        waitError: record.waitError,
        forwardError: record.forwardError,
      });
      const prepare = (key) => {
        const record = { key, admission: latch(), reached: latch(), bound: latch(), reply: latch(), forwarded: false, terminal: null };
        records.set(key, record);
        return record;
      };
      const nativeCall = (name, args, owner) => toolBridge.callSessionTool(name, args, { session: owner.toolSession });
      const status = (record) => nativeCall("__status__", { item: { kind: "completion", id: record.id } }, owners.get(record.owner));
      const run = (owner, key, signal) => {
        const value = owner.session.getToolByName("eval").execute(
          `py-lifecycle-${crypto.randomUUID()}`,
          {
            language: "py",
            code: `handle = completion("PY_LIFECYCLE_${key}")\nprint(handle.id)`,
            title: "Native lifecycle probe",
            timeout: 30,
          },
          signal,
        );
        const wrapped = Promise.resolve(value).then(
          (value) => {
            if (value.details?.async?.state === "running") faults.push("Native eval auto-backgrounded: outer cell settlement not proved");
            return { value };
          },
          (error) => ({ error: String(error) }),
        );
        owner.cells.push(wrapped);
        return wrapped;
      };
      try {
        let backend, kernel;
        try {
          ({ pythonBackend: backend } = await import("@oh-my-pi/pi-coding-agent/eval"));
          ({ PythonKernel: kernel } = await import("@oh-my-pi/pi-coding-agent/eval/py/kernel"));
          toolBridge = await import("@oh-my-pi/pi-coding-agent/eval/js/tool-bridge");
        } catch (error) {
          report("attachment", "unsupported", { error: String(error) });
          return;
        }
        const originalBackend = backend.execute;
        backend.execute = function (code, options) {
          const owner = owners.get(options?.session?.getAgentId?.());
          if (!owner) return originalBackend.call(this, code, options);
          // Exact native public sessionFile flows from backend opts into managed kernel env.
          // A Set rejects ambiguity instead of choosing last-seen/model/FIFO ownership.
          const file = options.sessionFile;
          check(typeof file === "string" && file.length > 0, "Native backend omitted sessionFile correlation key");
          owner.toolSession = options.session;
          if (owner.keyGate && !owner.registryDecorated) {
            const registry = options.session.modelRegistry;
            check(registry && registry !== ctx.modelRegistry, "Expected SDK-owned independent native model registry");
            const getApiKey = registry.getApiKey;
            registry.getApiKey = async function (...args) {
              const value = await getApiKey.apply(this, args);
              owner.keyReached.resolve();
              await owner.keyGate.promise;
              return value; // Original native loopback auth result, never logged.
            };
            owner.registryDecorated = true;
            restores.push(() => {
              registry.getApiKey = getApiKey;
            });
          }
          const capture = { owner, signal: options.signal };
          let captures = activeBackends.get(file);
          if (!captures) {
            captures = new Set();
            activeBackends.set(file, captures);
          }
          captures.add(capture);
          return Promise.resolve(originalBackend.call(this, code, options)).finally(() => {
            captures.delete(capture);
            if (!captures.size) activeBackends.delete(file);
          });
        };
        restores.push(() => {
          backend.execute = originalBackend;
        });
        proxy = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const target = targets.get(new URL(request.url).pathname.split("/")[1]);
            if (!target || request.method !== "POST" || !new URL(request.url).pathname.endsWith("/v1/tool")) return new Response("Not found", { status: 404 });
            const bytes = await request.arrayBuffer();
            const body = JSON.parse(new TextDecoder().decode(bytes));
            check(body.session === target.session && body.run === target.run, "Native bridge session/run mismatch");
            const forward = () => fetch(`${target.url}/v1/tool`, { method: request.method, headers: request.headers, body: bytes, signal: request.signal });
            if (body.name !== "__completion__") return forward();
            // Prompt selects the scenario oracle only; ownership comes exclusively from
            // native backend sessionFile + actual kernel run/session identity above.
            const key = body.args?.prompt?.match(/^PY_LIFECYCLE_([A-Za-z0-9_-]+)$/)?.[1];
            const record = records.get(key);
            check(record && !record.owner, "Unplanned/duplicate producer observation");
            record.owner = target.owner.session.getAgentId();
            record.run = body.run;
            leases.add(record);
            record.reached.resolve();
            await record.admission.promise;
            record.abortedAtForward = Boolean(target.signal?.aborted);
            record.forwarded = true;
            let upstream;
            try {
              upstream = await forward();
              record.envelope = await upstream.clone().json();
              const id = record.envelope.ok && record.envelope.value?.id;
              if (typeof id === "string") {
                record.id = id;
                // Binding runs before native response delivery, map removal, or disposal.
                record.wait = nativeCall("__wait__", { items: [{ kind: "completion", id }] }, target.owner).then(
                  (value) => {
                    const item = value?.items?.[0];
                    if (value?.items?.length === 1 && item?.id === id && item.kind === "completion" && ["completed", "failed", "cancelled"].includes(item.status)) {
                      record.terminal = item;
                      leases.delete(record);
                    } else record.waitError = "Unknown/nonterminal native wait: reservation retained";
                    return item;
                  },
                  (error) => {
                    record.waitError = String(error);
                  },
                );
              }
            } catch (error) {
              record.forwardError = String(error);
              throw error;
            } finally {
              record.bound.resolve();
            }
            await record.reply.promise;
            return upstream; // Preserve the native success/error response unchanged.
          },
        });
        const prototype = kernel.prototype;
        const own = Object.getOwnPropertyDescriptor(prototype, "execute");
        const original = prototype.execute;
        prototype.execute = function (code, options) {
          if (!options?.env?.PI_TOOL_BRIDGE_URL) return original.call(this, code, options);
          const captures = activeBackends.get(options.env.PI_SESSION_FILE);
          if (!captures) return original.call(this, code, options);
          check(captures.size === 1, "Ambiguous native sessionFile correlation; refusing guessed owner");
          const capture = [...captures][0];
          const key = crypto.randomUUID();
          const url = options.env.PI_TOOL_BRIDGE_URL;
          check(new URL(url).hostname === "127.0.0.1", "Nonloopback native bridge refused");
          targets.set(key, { ...capture, url, session: options.env.PI_TOOL_BRIDGE_SESSION, run: options.id });
          return original.call(this, code, { ...options, env: { ...options.env, PI_TOOL_BRIDGE_URL: `http://127.0.0.1:${proxy.port}/${key}` } }).finally(() => targets.delete(key));
        };
        restores.push(() => {
          if (own) Object.defineProperty(prototype, "execute", own);
          else delete prototype.execute;
        });
        for (const name of ["Pre", "Cancel", "Release", "Peer"]) {
          const agentId = `PyLifecycle${name}`;
          const { session } = await api.pi.createAgentSession({
            cwd: config.root,
            agentDir: config.agentDir,
            agentId,
            parentTaskPrefix: agentId,
            model: ctx.model,
            authStorage: ctx.modelRegistry.authStorage,
            settings: api.pi.Settings.isolated({}),
            autoApprove: true,
            sessionManager: api.pi.SessionManager.create(config.root, config.sessionsDir),
          });
          owners.set(agentId, { session, cells: [], ...(name === "Release" ? { keyGate: latch(), keyReached: latch() } : {}) });
        }
        const owner = (name) => owners.get(`PyLifecycle${name}`);
        const pre = prepare("pre");
        const preAbort = new AbortController();
        const preCell = run(owner("Pre"), "pre", preAbort.signal);
        await bounded(pre.reached.promise, "preforward interception");
        check(!(await post("/state")).keys.includes("pre"), "Producer ran before admission");
        preAbort.abort(new Error("Fixture caller cancelled before admission"));
        pre.reply.resolve();
        pre.admission.resolve();
        await bounded(pre.bound.promise, "delayed native admission response");
        const preResult = await bounded(preCell, "cancelled native cell");
        const noProducer = !(await post("/state")).keys.includes("pre");
        report("cancel-before-admission", !noProducer || pre.id ? "counterexample" : pre.envelope?.ok === false ? "passed-bounded-subset" : "coverage-gap", {
          ...summary(pre),
          noUnauthorizedProducer: noProducer,
          abortedAtForward: pre.abortedAtForward,
          cell: preResult,
          reservationPolicy: "Rejected/no-handle native envelope remains unknown and blocked; never released as producer settlement",
        });

        const cancelled = prepare("cancel");
        const peer = prepare("peer");
        const released = prepare("release");
        const cancelAbort = new AbortController();
        const cancelCell = run(owner("Cancel"), "cancel", cancelAbort.signal);
        const peerCell = run(owner("Peer"), "peer");
        const releaseCell = run(owner("Release"), "release");
        await bounded(Promise.all([cancelled.reached.promise, peer.reached.promise, released.reached.promise]), "concurrent native requests");
        check(new Set([owner("Cancel").toolSession, owner("Peer").toolSession, owner("Release").toolSession]).size === 3, "ToolSessions not distinct");
        // Interleave admission and replies independently, all with the same model.
        peer.admission.resolve();
        await bounded(peer.bound.promise, "peer binding");
        released.admission.resolve();
        await bounded(released.bound.promise, "release binding");
        cancelled.admission.resolve();
        await bounded(cancelled.bound.promise, "cancel binding");
        for (const record of [peer, released, cancelled]) {
          check(record.id && leases.has(record), "Missing live native producer reservation");
          if (record === released) await bounded(owner("Release").keyReached.promise, "native producer auth prerequisite");
          else await post("/await-provider", { key: record.key });
          check((await status(record)).status === "running", "Provider not natively pending at hold");
        }
        released.reply.resolve();
        peer.reply.resolve();
        await bounded(Promise.all([releaseCell, peerCell]), "native handle delivery");
        cancelAbort.abort(new Error("Fixture caller cancelled after forwarding"));
        const retainedAtAbort = leases.has(cancelled);
        cancelled.reply.resolve();
        const cancelledSnapshot = await bounded(cancelled.wait, "native cancellation settlement");
        const cancelledCellResult = await bounded(cancelCell, "native cancelled eval return");
        check(leases.has(peer) && leases.has(released), "Cancellation discharged another owner");
        const nativeCancellation = ["cancelled", "failed"].includes(cancelledSnapshot?.status) && /abort|cancel|interrupt/i.test(cancelledSnapshot?.error || "");
        report("cancel-after-forward", nativeCancellation && retainedAtAbort ? "passed-bounded-subset" : "coverage-gap", {
          ...summary(cancelled),
          retainedAtAbort,
          snapshot: cancelledSnapshot,
          cell: cancelledCellResult,
          nativeCancellation,
          cleanupHold: "Provider response was held; abort-insensitive native cleanup cannot be forced externally and is not claimed",
        });
        // Native disposal is owner release, NOT reset/reload or process exit.
        const pendingBeforeRelease = leases.has(released) && (await status(released)).status === "running";
        const disposal = owner("Release").session.dispose();
        owner("Release").disposal = disposal;
        const retainedAtDisposeCall = leases.has(released);
        await bounded(disposal, "native owner disposal");
        let afterRemoval;
        try {
          afterRemoval = { value: await status(released) };
        } catch (error) {
          afterRemoval = { nativeError: String(error) };
        }
        const pendingAfterRemoval = leases.has(released) && !released.terminal;
        owner("Release").keyGate.resolve();
        const releasedSnapshot = await bounded(released.wait, "prebound native wait after owner release");
        check(leases.has(peer) && (await status(peer)).status === "running", "Owner release discharged peer");
        const removed = afterRemoval.nativeError?.includes(`unknown completion handle ${released.id}; result expired`) === true;
        const releaseCancelled = releasedSnapshot?.status === "cancelled" && typeof releasedSnapshot.error === "string";
        report(
          "owner-release-map-removal",
          removed && releaseCancelled && pendingBeforeRelease && retainedAtDisposeCall && pendingAfterRemoval ? "passed-bounded-subset" : "coverage-gap",
          {
            ...summary(released),
            pendingBeforeRelease,
            retainedAtDisposeCall,
            pendingAfterRemoval,
            removed,
            releaseCancelled,
            afterRemoval,
            snapshot: releasedSnapshot,
            prerequisite: "Original-delegating getApiKey result held on genuine SDK-created per-owner ModelRegistry; executeCompletion actual promise awaits it",
            limitation: pendingAfterRemoval ? null : "Native promise not observed pending after map removal",
          },
        );
        await post("/release", { key: "peer" });
        await bounded(peer.wait, "peer natural settlement");
        check(peer.terminal?.status === "completed" && peer.terminal.text === "native-result", "Peer did not complete naturally");
        report("concurrent-distinct-same-model-owners", "passed-bounded-subset", {
          distinctToolSessions: true,
          identity: "native sessionFile -> unique active backend capture -> native bridge session/run -> exact native handle",
          isolatedAcrossCancelAndRelease: true,
          records: [cancelled, released, peer].map(summary),
        });
      } catch (error) {
        report("execution", "failed", { error: String(error) });
      } finally {
        for (const record of records.values()) {
          record.admission.resolve();
          record.reply.resolve();
          await post("/release", { key: record.key });
        }
        for (const owner of owners.values()) {
          owner.keyGate?.resolve();
          try {
            await bounded(Promise.all(owner.cells), "cleanup cells");
            await bounded(owner.disposal || owner.session.dispose(), "cleanup owner");
          } catch (error) {
            faults.push(String(error));
          }
        }
        for (const restore of restores.reverse()) restore();
        if (proxy) await proxy.stop(true);
        const status =
          faults.length || results.some((r) => ["failed", "counterexample"].includes(r.status))
            ? "failed"
            : results.every((r) => r.status === "unsupported")
              ? "unsupported"
              : leases.size || results.some((r) => r.status === "coverage-gap")
                ? "coverage-gap"
                : "passed-bounded-subset";
        await post("/trace", {
          type: "outcome",
          status,
          results,
          faults,
          retainedUnknown: [...leases].map(summary),
          limitations: [
            "External accounting only; unknown/error records remain blocked",
            "Owner release holds actual native auth prerequisite, not an abort-insensitive transport cleanup matrix",
            "Overlapping cells sharing one sessionFile fail closed, not guessed",
            "Reset/reload, process-exit, primary agent-loop and schema/model-tier matrix unproved",
            "No durable Alinery admission or finalization authority",
          ],
        });
      }
      return { content: [{ type: "text", text: "Python lifecycle diagnostic finished" }] };
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
        "lifecycle-local": {
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
  const extension = path.join(root, "lifecycle-probe.ts");
  writeFileSync(extension, `export default api => (${installProbe.toString()})(api, ${JSON.stringify({ root, agentDir, url, sessionsDir: path.join(root, "sessions") })});`);
  const configPath = path.join(root, "config.yml");
  writeFileSync(configPath, "{}\n");
  child = spawn(
    binary,
    ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", extension, "--model", "lifecycle-local/probe", "--thinking", "off", "--config", configPath],
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
        if (["ready", "extension_error"].includes(event.type)) record(event);
      } catch {
        record({ type: "stdout", line });
      }
    }
  });
  child.stderr.on("data", (chunk) => record({ type: "stderr", text: String(chunk) }));
  const ready = await waitFor((e) => ["ready", "process-closed", "process-error"].includes(e.type));
  assert.equal(ready.type, "ready");
  child.stdin.write(`${JSON.stringify({ id: "lifecycle-probe", type: "prompt", message: "Run lifecycle_probe now." })}\n`);
  const outcome = await waitFor((e) => ["outcome", "fixture-error", "process-closed", "process-error"].includes(e.type));
  process.exitCode = { "passed-bounded-subset": 0, unsupported: 2, "coverage-gap": 3 }[outcome.status] ?? 1;
  console.log(JSON.stringify({ ...outcome, binary: { path: binary, version, sha256 }, events }, null, 2));
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({ status: "failed", error: String(error), events }, null, 2));
} finally {
  for (const response of providers.values()) if (!response.writableEnded) response.destroy();
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
