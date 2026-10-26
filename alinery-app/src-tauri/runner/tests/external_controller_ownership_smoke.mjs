// Opt-in controller continuation ownership experiment on unchanged packaged OMP.
// Derived from the retained automatic-capture fixture; original is unchanged.
// Public-method decoration is compatibility-sensitive; authority is simulated.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: node external_controller_ownership_smoke.mjs\nTwo native eligible stops; instance-local Promise catch/finally continuation ownership. Exit 0 = bounded subset only; 1 = failed oracle. No private state or scheduler replacement.",
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
  }, 30000);
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
      if (body.type === "admission-verified") {
        assert.equal(captureRequests, 0, "Capture dispatched before external admission release");
        assert.equal(existsSync(skillPath(1)), false);
      }
      if (body.type === "refresh-accounted") {
        assert.ok(held.has("refresh-1"));
        assert.match(readFileSync(skillPath(1), "utf8"), /Capture 1 evidence/);
        assert.equal(body.decision.status, "waiting");
      }
      if (body.type === "outcome" && body.status !== "failed") {
        assert.equal(primaryRequests, 4);
        assert.equal(captureRequests, 4);
        for (const ordinal of [1, 2]) assert.match(readFileSync(skillPath(ordinal), "utf8"), new RegExp(`Capture ${ordinal} evidence`));
        assert.equal(body.firstFence.status, "waiting");
        assert.ok(body.firstFence.active.some((id) => id.includes("finally")));
        assert.equal(body.gaps.length, 0);
        assert.equal(body.chainRegistrations, 4);
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
  const trace = (event) => post("/trace", event);
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  api.registerTool({
    name: "autolearn_probe",
    label: "Automatic capture probe",
    description: "Run isolated native automatic-capture diagnostic",
    parameters: api.zod.z.object({}),
    loadMode: "essential",
    async execute(_id, _input, _signal, _update, ctx) {
      let session;
      try {
        const pi = api.pi;
        check(typeof pi.Settings?.isolated === "function", "Missing public isolated settings API");
        ({ session } = await pi.createAgentSession({
          cwd: config.root,
          agentDir: config.agentDir,
          agentId: "CaptureProbe",
          parentTaskPrefix: "CaptureProbe",
          model: ctx.model,
          modelRegistry: ctx.modelRegistry,
          authStorage: ctx.modelRegistry.authStorage,
          settings: pi.Settings.isolated({ "autolearn.enabled": true, "autolearn.autoContinue": true, "autolearn.minToolCalls": 1 }),
          autoApprove: true,
          sessionManager: pi.SessionManager.create(config.root, config.sessionsDir),
        }));
        check(typeof session.runAutolearnCapture === "function" && typeof session.refreshSkills === "function", "Missing public capture/refresh methods");
        const nativeCapture = session.runAutolearnCapture.bind(session);
        const nativeRefresh = session.refreshSkills.bind(session);
        const active = new Set();
        let revision = 0;
        let sealed = false;
        let captureAttempts = 0;
        let refreshes = 0;
        let primaryEnds = 0;
        const reserve = (id) => {
          check(!sealed, "Admission closed");
          active.add(id);
          revision++;
        };
        const finalize = (intent) => {
          const status = active.size ? "waiting" : intent !== revision ? "stale" : sealed ? "already-sealed" : "accepted";
          if (status === "accepted") sealed = true;
          return { status, revision, intent, active: [...active] };
        };
        // Decorate only promises returned by this fixture-owned native method and
        // the promises returned by their public catch/finally methods. No global
        // Promise patch, listener identification, or controller-policy copy.
        const nativeThen = Promise.prototype.then;
        let sequence = 0;
        let chainRegistrations = 0;
        let firstFence;
        const gaps = [];
        const chainEvents = [];
        const exhausted = new Set();
        const faults = [];
        const track = (promise, id, ordinal, parent = null) => {
          check(promise instanceof Promise, "Expected a real native Promise");
          if (parent) {
            check(!active.has(id), "Duplicate promise ownership");
            active.add(id);
          } else check(active.has(id), "Root admission was not reserved");
          chainEvents.push({ type: "reserve", id, parent, active: [...active] });
          for (const method of ["catch", "finally"]) {
            const original = promise[method];
            Object.defineProperty(promise, method, {
              configurable: true,
              writable: true,
              value: function (...args) {
                check(this === promise, "Unexpected borrowed promise method receiver");
                check(active.has(id), "Late continuation registration outside retained scope");
                const child = `${id}/${method}-${++sequence}`;
                // Original native Promise method schedules, but cannot execute a
                // reaction before this synchronous reservation/decoration returns.
                const result = Reflect.apply(original, this, args);
                chainRegistrations++;
                return track(result, child, ordinal, id);
              },
            });
          }
          const settled = () => {
            active.delete(id);
            chainEvents.push({ type: "settle", id, active: [...active], captureAttempts });
            if (!active.size) {
              if (captureAttempts !== 2 || refreshes !== 2) gaps.push({ id, captureAttempts, refreshes });
              for (const resolve of exhausted) resolve();
              exhausted.clear();
            }
          };
          // Bypass our per-instance decorations for the accounting observer.
          Reflect.apply(nativeThen, promise, [settled, settled]);
          return promise;
        };
        const awaitExhaustion = () => (active.size ? new Promise((resolve) => exhausted.add(resolve)) : Promise.resolve());
        session.subscribe((event) => {
          if (event.type === "agent_end") {
            primaryEnds++;
            void trace({ type: "primary-ended", ordinal: primaryEnds });
          }
        });
        // Compatibility-sensitive public instance decoration, before any prompt.
        // Invoke the exact native callback and method, preserving their context.
        session.runAutolearnCapture = (capture) => {
          const ordinal = ++captureAttempts;
          const id = `capture-${ordinal}`;
          reserve(id);
          const task = (async () => {
            await trace({ type: "capture-admitted", ordinal, revision, active: [...active] });
            if (ordinal === 1) await post("/admission-latch", { ordinal });
            try {
              await nativeCapture(capture);
            } finally {
              // Challenge finalization at the ORIGINAL native method return,
              // before resolving our promise back into the native controller.
              active.delete(id);
              chainEvents.push({ type: "native-return", id, active: [...active] });
              if (ordinal === 1) {
                firstFence = finalize(revision);
                if (firstFence.status !== "waiting") faults.push("First method return accepted before pending replay");
                if (!firstFence.active.some((value) => value.includes("finally"))) faults.push("Native finally continuation unowned");
              }
            }
          })();
          return track(task, id, ordinal);
        };
        session.refreshSkills = async () => {
          const ordinal = ++refreshes;
          await post("/refresh-latch", { ordinal, active: [...active] });
          await nativeRefresh();
          check(
            session.skills.some((skill) => skill.name === `capture-${ordinal}`),
            "Native refresh did not expose the new managed skill",
          );
          await trace({ type: "refresh-returned", ordinal, active: [...active], nativeSkillVisible: true });
        };
        const primary = async (text, ordinal) => {
          const id = `primary-${ordinal}`;
          reserve(id);
          try {
            await session.prompt(text);
            await post("/await", { type: "primary-ended", ordinal });
            await session.waitForIdle();
          } finally {
            active.delete(id);
          }
        };
        await primary("CAPTURE_PRIMARY_ONE: write the first local fixture file.", 1);
        await post("/await", { type: "capture-admission-held" });
        const oldIntent = revision;
        check(finalize(revision).status === "waiting", "Finalized before capture admission release");
        await trace({ type: "admission-verified", revision, active: [...active] });
        // This is a second real eligible primary stop, not a direct capture call.
        await primary("CAPTURE_PRIMARY_TWO: write the second local fixture file.", 2);
        check(captureAttempts === 1 && primaryEnds === 2, "Unexpected native automatic capture overlap");
        await trace({ type: "second-primary-ended-while-capture-owned", revision, captureAttempts, primaryEnds });
        await post("/release", { key: "admission-1" });
        await post("/await", { type: "refresh-held", ordinal: 1 });
        const decision = finalize(revision);
        check(decision.status === "waiting" && decision.active.includes("capture-1"), "Capture ownership ended before native refresh");
        await trace({ type: "refresh-accounted", decision });
        await post("/release", { key: "refresh-1" });
        await awaitExhaustion();
        check(firstFence?.status === "waiting", "Early finalization did not wait");
        check(captureAttempts === 2 && refreshes === 2 && active.size === 0, "Pending native capture did not finish");
        check(chainRegistrations === 4, "Did not reach both native catch/finally chains");
        check(gaps.length === 0 && faults.length === 0, "Controller ownership had a gap");
        check(finalize(oldIntent).status === "stale", "Old intent authorized newer work");
        check(finalize(revision).status === "accepted", "Fresh finalization failed after genuine chain exhaustion");
        const result = { status: "passed-bounded-subset", firstFence, chainRegistrations, chainEvents, gaps, faults };
        await session.waitForIdle();
        await session.sessionManager.flush();
        await trace({
          type: "outcome",
          ...result,
          primaryEnds,
          captureAttempts,
          refreshes,
          revision,
          scope: "SDK diagnostic; public-method decoration; simulated authority; not whole-session integration",
        });
      } catch (error) {
        await trace({ type: "outcome", status: "failed", error: String(error), stack: error?.stack });
        throw error;
      } finally {
        await session?.dispose();
        await trace({ type: "owned-session-disposed" });
      }
      return { content: [{ type: "text", text: "Automatic capture diagnostic finished" }] };
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
  assert.equal(outcome.status, "passed-bounded-subset", JSON.stringify(outcome));
  await waitFor((event) => event.type === "owned-session-disposed");
  console.log(JSON.stringify({ ...outcome, captureRequests, primaryRequests, events: events.filter((event) => !["ready", "response", "stderr"].includes(event.type)) }, null, 2));
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
