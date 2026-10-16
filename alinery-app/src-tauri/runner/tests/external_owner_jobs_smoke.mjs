// Opt-in diagnostic; unchanged packaged OMP, disposable SDK sessions, loopback only.
// This is NOT an Alinery receipt, production SDK launcher, or universal subtree barrier.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(`Usage: node external_owner_jobs_smoke.mjs [--probe-cancellation]
OMP_BIN defaults to /Applications/Alinery.omp/omp (must be v18.1.13).
Runs real native task children in disposable SDK owner sessions A and B.
Oracles: watched live A cannot pass the safety join; native delivery stays
owned while A's parent is streaming; resumed parent stays owned; fresh A
finalization succeeds while unrelated B is still held before its native write.
Authority/epochs are manually simulated, not an Alinery acceptance receipt.
Exit 0: supported ordinary-job subset passed (unsafe-filter counterexample
is reported separately). Exit 1: failed oracle/runtime error. Exit 2: missing
public prerequisite. --probe-cancellation additionally holds a real child's
tool_result after native write, cancels its actual job, and requires job.promise
settlement before releasing that hook. This is cleanup-tail, not late-write proof.
No pre-spill latch, universal late-cleanup drain, revival admission, stock
launch attachment, or production integration is proven.`);
  process.exit(0);
}
assert.ok(
  args.every((arg) => arg === "--probe-cancellation"),
  "Unknown argument; use --help",
);
const binary = process.env.OMP_BIN || "/Applications/Alinery.omp/omp";
const events = [];
const listeners = new Set();
const held = new Map();
const sockets = new Set();
const providerStages = new Map();
let child;
let closed;
let root;
let sequence = 0;
const record = (event) => {
  events.push(event);
  for (const listener of [...listeners]) listener();
};
const waitFor = (predicate) => {
  const { promise, resolve, reject } = Promise.withResolvers();
  const check = () => {
    const event = events.find(predicate);
    if (!event) return;
    clearTimeout(timer);
    listeners.delete(check);
    resolve(event);
  };
  const timer = setTimeout(() => {
    listeners.delete(check);
    reject(new Error(`Missing event; recent=${JSON.stringify(events.slice(-30))}`));
  }, 90000);
  listeners.add(check);
  check();
  return promise;
};
function answer(response, tools, content = "Loopback native ownership response.") {
  const number = ++sequence;
  const delta = tools
    ? {
        role: "assistant",
        tool_calls: tools.map((tool, index) => ({ index, id: `owner_${number}_${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.input) } })),
      }
    : { role: "assistant", content };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ id: `owner_${number}`, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: `owner_${number}`, choices: [{ index: 0, delta: {}, finish_reason: tools ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
}
function release(key) {
  const pending = held.get(key);
  assert.ok(pending, `Missing held boundary ${key}`);
  held.delete(key);
  if (pending.provider) answer(pending.response);
  else pending.response.end("{}");
  record({ type: "released", key });
}
const server = createServer(async (request, response) => {
  try {
    let bytes = "";
    for await (const chunk of request) bytes += chunk;
    const body = JSON.parse(bytes || "{}");
    if (request.url === "/trace") {
      if (body.type === "cancellation-tail") {
        const latch = held.get("result-C");
        assert.ok(latch && !latch.response.writableEnded && !latch.response.destroyed, "Native result hook is no longer held");
        assert.ok(!events.some((event) => event.type === "result-hook-returned" && event.owner === "C"), "Native result hook already returned");
      }
      record(body);
      response.end("{}");
    } else if (request.url === "/await") {
      const found = await waitFor((event) => Object.entries(body).every(([key, value]) => event[key] === value));
      response.end(JSON.stringify(found));
    } else if (request.url === "/release") {
      release(body.key);
      response.end("{}");
    } else if (request.url === "/write-latch") {
      assert.ok(["A", "B"].includes(body.owner));
      assert.ok(!held.has(`write-${body.owner}`));
      held.set(`write-${body.owner}`, { response });
      record({ type: "write-held", owner: body.owner, toolCallId: body.toolCallId });
    } else if (request.url === "/result-latch") {
      assert.equal(body.owner, "C");
      assert.equal(readFileSync(path.join(root, "write-C"), "utf8"), "native-write-C\n");
      held.set("result-C", { response });
      record({ type: "result-held", owner: "C", nativeWriteVerified: true, at: Date.now() });
    } else if (request.url === "/v1/chat/completions" || request.url === "/chat/completions") {
      const users = JSON.stringify(body.messages.filter((message) => message.role === "user"));
      const owner = ["A", "B", "C"].find((value) => users.includes(`ROOT_OWNER_${value}`));
      const childOwner = ["A", "B", "C"].find((value) => users.includes(`CHILD_OWNER_${value}`));
      if (owner) {
        const stage = providerStages.get(owner) || 0;
        providerStages.set(owner, stage + 1);
        const hasDelivery = users.includes("Background job") && users.includes("has completed");
        record({ type: "parent-provider", owner, stage, hasDelivery });
        if (stage === 0) {
          const task = { name: `Writer${owner}`, task: `CHILD_OWNER_${owner}: write the assigned disposable file, then yield. No other work.` };
          const schema = body.tools.find((tool) => tool.function.name === "task")?.function.parameters;
          assert.ok(schema, "Native task tool unavailable");
          answer(response, [
            { name: "task", input: schema.properties?.tasks ? { context: "Loopback ownership diagnostic. No services, credentials or repository edits.", tasks: [task] } : task },
          ]);
        } else if (owner === "A" && stage === 1) {
          held.set("parent-before-delivery", { response, provider: true });
          record({ type: "parent-before-delivery-held" });
        } else if (owner === "A" && hasDelivery && !events.some((event) => event.type === "parent-continuation-held")) {
          held.set("parent-continuation", { response, provider: true });
          const expectedJobId = events.find((event) => event.type === "watched-live")?.jobA.id;
          record({ type: "parent-continuation-held", hasExpectedJobId: Boolean(expectedJobId && users.includes(expectedJobId)) });
        } else answer(response);
      } else if (childOwner) {
        const key = `child-${childOwner}`;
        const stage = providerStages.get(key) || 0;
        providerStages.set(key, stage + 1);
        record({ type: "child-provider", owner: childOwner, stage });
        if (stage === 0)
          answer(response, [
            {
              name: "write",
              input: {
                i: "Writing owned probe file",
                path: path.join(root, `write-${childOwner}`),
                content: `native-write-${childOwner}\n`,
              },
            },
          ]);
        else if (stage === 1) {
          assert.ok(
            body.tools.some((tool) => tool.function.name === "yield"),
            "Native child yield unavailable",
          );
          answer(response, [{ name: "yield", input: { data: { owner: childOwner, nativeWrite: true } } }]);
        } else answer(response, undefined, `Child ${childOwner} completed.`);
      } else {
        const hasProbe = body.tools?.some((tool) => tool.function.name === "owner_probe");
        if (hasProbe && !providerStages.has("bootstrap")) {
          providerStages.set("bootstrap", 1);
          answer(response, [{ name: "owner_probe", input: {} }]);
        } else answer(response);
      }
    } else {
      throw new Error(`Unexpected loopback route ${request.url}`);
    }
  } catch (error) {
    record({ type: "fixture-error", error: String(error) });
    response.destroy(error);
  }
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

// Serialized into the packaged extension. Uses only api.pi, public SDK methods,
// inherited extension hooks and the original native delivery sink.
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
    name: "owner_probe",
    label: "Owner probe",
    description: "Run disposable native ownership diagnostic",
    parameters: api.zod.z.object({}),
    loadMode: "essential",
    async execute(_id, _input, _signal, _update, ctx) {
      const sessions = [];
      try {
        const pi = api.pi;
        if (typeof pi?.createAgentSession !== "function" || typeof pi?.SessionManager?.create !== "function") {
          await trace({ type: "outcome", status: "unsupported-prerequisite", missing: "Packaged public api.pi SDK exports" });
          return { content: [{ type: "text", text: "Public SDK unavailable" }] };
        }
        for (const owner of config.cancellation ? ["A", "B", "C"] : ["A", "B"]) {
          const { session } = await pi.createAgentSession({
            cwd: config.root,
            agentDir: config.agentDir,
            agentId: `ProbeOwner${owner}`,
            parentTaskPrefix: `ProbeOwner${owner}`,
            model: ctx.model,
            modelRegistry: ctx.modelRegistry,
            authStorage: ctx.modelRegistry.authStorage,
            settings: await pi.Settings.init(),
            autoApprove: true,
            sessionManager: pi.SessionManager.create(config.root, config.sessionsDir),
            additionalExtensionPaths: [config.childExtension],
          });
          sessions.push(session);
        }
        const [a, b] = sessions;
        const manager = a.asyncJobManager;
        const ownerA = a.getAgentId();
        const ownerB = b.getAgentId();
        check(manager && manager === b.asyncJobManager && ownerA && ownerB && ownerA !== ownerB, "SDK owner/manager isolation prerequisite failed");
        const filterA = { ownerId: ownerA };
        const filterB = { ownerId: ownerB };
        const deliveries = [];
        a.subscribe((event) => {
          if (event.type === "message_end" && event.message?.customType === "async-result") {
            deliveries.push(event.message);
            void trace({ type: "native-delivery", owner: "A", message: event.message });
          }
        });
        // This external authority is intentionally manual. It is not engine admission.
        let revision = 1;
        let owned = true;
        let sealed = false;
        const attempt = (intent) => {
          const accepted = !owned && !sealed && intent === revision;
          if (accepted) sealed = true;
          return { accepted, owned, revision, intent, sealed };
        };
        const staleIntent = revision;
        const promptA = a.prompt("ROOT_OWNER_A: run one native task child.");
        const promptB = b.prompt("ROOT_OWNER_B: run one native task child.");
        // Attach rejection handlers immediately; the promises remain awaited below.
        promptA.catch((error) => void trace({ type: "prompt-error", owner: "A", error: String(error) }));
        promptB.catch((error) => void trace({ type: "prompt-error", owner: "B", error: String(error) }));
        await post("/await", { type: "write-held", owner: "A" });
        await post("/await", { type: "write-held", owner: "B" });
        await post("/await", { type: "parent-before-delivery-held" });
        const jobsA = manager.getRunningJobs(filterA);
        const jobsB = manager.getRunningJobs(filterB);
        check(jobsA.length === 1 && jobsB.length === 1 && jobsA[0].type === "task" && jobsB[0].type === "task", "Expected two real owner-tagged native task jobs");
        const jobA = jobsA[0];
        const jobB = jobsB[0];
        manager.watchJobs([jobA.id]);
        check(manager.isDeliverySuppressed(jobA.id), "Native watch did not suppress delivery");
        const unsafeSettled = await manager.waitForOwnerJobs(ownerA, { excludeSuppressed: true });
        const safeSettled = await manager.waitForOwnerJobs(ownerA, { timeoutMs: 0 });
        check(unsafeSettled === true && safeSettled === false, "Watched-live boundary differs from expected counterexample");
        check(!attempt(revision).accepted, "Manual authority finalized a watched live writer");
        await trace({
          type: "watched-live",
          status: "experimental-counterexample",
          unsafeSettled,
          safeSettled,
          jobA: { id: jobA.id, ownerId: jobA.ownerId, status: jobA.status },
          jobB: { id: jobB.id, ownerId: jobB.ownerId, status: jobB.status },
          authority: attempt(revision),
        });
        manager.unwatchJobs([jobA.id]);
        check(!manager.isDeliverySuppressed(jobA.id), "Unwatch did not restore native delivery eligibility");
        await post("/release", { key: "write-A" });
        check(await manager.waitForOwnerJobs(ownerA), "A owner job failed to settle");
        check(jobA.status === "completed", `A task failed: ${jobA.errorText}`);
        await post("/await", { type: "native-write-result", owner: "A", isError: false });
        check(manager.hasPendingDeliveries(filterA), "Native delivery disappeared while parent provider was held");
        const deliveryBeforeRelease = manager.getDeliveryState(filterA);
        check((await manager.drainDeliveries({ filter: filterA, timeoutMs: 0 })) === false, "Owner drain completed before native receipt could commit");
        check(a.yieldQueue.has("async-result"), "Native sink has not queued the actual async-result receipt");
        check(!attempt(revision).accepted, "Authority released before native delivery");
        await trace({ type: "delivery-held", deliveryBeforeRelease, authority: attempt(revision) });
        const drain = manager.drainDeliveries({ filter: filterA });
        await post("/release", { key: "parent-before-delivery" });
        const continuation = await post("/await", { type: "parent-continuation-held" });
        check(continuation.hasExpectedJobId, "Resumed native provider input omitted the actual A job ID");
        check(await drain, "Native A delivery did not settle");
        check(
          deliveries.some((message) => JSON.stringify(message).includes(jobA.id)),
          "The actual A job result was not committed to its parent",
        );
        check(!attempt(revision).accepted, "Authority released before resumed parent settled");
        await trace({ type: "continuation-held", nativeJobDelivered: jobA.id, authority: attempt(revision), deliveryState: manager.getDeliveryState(filterA) });
        await post("/release", { key: "parent-continuation" });
        await promptA;
        await a.waitForIdle();
        check(await manager.waitForOwnerJobs(ownerA), "Follow-up A jobs unsettled");
        check(await manager.drainDeliveries({ filter: filterA }), "Follow-up A deliveries unsettled");
        await a.waitForIdle();
        await a.sessionManager.flush();
        check(!a.hasPendingAsyncWork(), "A follow-up scheduled more work");
        owned = false;
        revision++;
        check(!attempt(staleIntent).accepted, "Stale intent accepted");
        check(
          jobB.status === "running" && !jobB.abortController.signal.aborted && manager.getRunningJobs(filterB).includes(jobB),
          "Unrelated B was settled or cancelled to fake A quiescence",
        );
        const fresh = attempt(revision);
        check(fresh.accepted, "Fresh A finalization refused while only unrelated B remains");
        await trace({ type: "fresh-finalization", authority: fresh, unrelatedB: { id: jobB.id, status: jobB.status, aborted: jobB.abortController.signal.aborted } });
        // Only after the ownership oracle: let B finish normally, never globally drain.
        await post("/release", { key: "write-B" });
        check(await manager.waitForOwnerJobs(ownerB), "B cleanup did not settle");
        check(jobB.status === "completed", `B task failed: ${jobB.errorText}`);
        check(await manager.drainDeliveries({ filter: filterB }), "B native delivery did not settle");
        await promptB;
        await b.waitForIdle();
        await b.sessionManager.flush();
        let cancellation = { status: "not-exercised" };
        if (config.cancellation) {
          const c = sessions[2];
          const ownerC = c.getAgentId();
          check(ownerC && ownerC !== ownerA && ownerC !== ownerB && c.asyncJobManager === manager, "C owner isolation failed");
          const promptC = c.prompt("ROOT_OWNER_C: run one native task child.");
          promptC.catch((error) => void trace({ type: "prompt-error", owner: "C", error: String(error) }));
          const resultHeld = await post("/await", { type: "result-held", owner: "C" });
          const jobsC = manager.getRunningJobs({ ownerId: ownerC });
          check(jobsC.length === 1 && jobsC[0].type === "task", "Missing C native task job");
          const jobC = jobsC[0];
          check(manager.cancel(jobC.id, { ownerId: ownerC }), "Native owner-filtered cancellation refused");
          // Cancelled status is deliberately NOT the oracle: await the real job body.
          await jobC.promise;
          const elapsedMs = Date.now() - resultHeld.at;
          check(elapsedMs < 29000, "C job settled only at/after hook timeout; no deterministic deferred-cleanup evidence");
          check(await manager.waitForOwnerJobs(ownerC), "C owner join did not settle");
          check(!manager.hasPendingDeliveries({ ownerId: ownerC }), "Cancelled C unexpectedly queued automatic delivery");
          cancellation = {
            status: "experimental-counterexample",
            jobId: jobC.id,
            jobStatus: jobC.status,
            jobPromiseSettled: true,
            resultHookStillHeld: true,
            elapsedMs,
            conclusion: "Registered native task promise can settle while its post-write extension result hook remains outstanding",
            limits: "Native write completed BEFORE cancellation. No late native writer or successful-task cleanup tail demonstrated. No public late-cleanup owner drain exists.",
          };
          await trace({ type: "cancellation-tail", ...cancellation });
          await post("/release", { key: "result-C" });
          await post("/await", { type: "result-hook-returned", owner: "C" });
          await promptC;
          await c.waitForIdle();
        }
        await trace({
          type: "outcome",
          status: "passed-supported-subset",
          native: [
            "owner-tagged task children",
            "real native writes",
            "watched live writer safety join",
            "original native delivery receipt",
            "resumed parent settlement",
            "unrelated-owner isolation",
          ],
          simulated: ["shared authority lease", "revision freshness", "finalization decision"],
          deployment: "Diagnostic SDK-created sessions only; no stock launcher attachment or production migration",
          cancellation,
          missing: [
            "pre-spill latch and spill coverage",
            "late native writer after executor cleanup deadline",
            "universal late-cleanup drain",
            "future IRC/revival admission",
            "Alinery receipt",
          ],
        });
      } catch (error) {
        await trace({ type: "outcome", status: "failed", error: String(error), stack: error?.stack });
        throw error;
      } finally {
        // Public per-session disposal; bootstrap owns its manager and process teardown.
        for (const session of sessions.reverse()) await session.dispose();
        await trace({ type: "owned-sessions-disposed" });
      }
      return { content: [{ type: "text", text: "Native owner-job diagnostic completed" }] };
    },
  });
}

try {
  assert.match(execFileSync(binary, ["--version"], { encoding: "utf8" }), /18\.1\.13\b/);
  root = mkdtempSync(path.join(tmpdir(), "alinery-owner-jobs-"));
  const listening = Promise.withResolvers();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${server.address().port}`;
  // SDK session initialization can refresh runtime provider registrations.
  // Keep this dummy loopback route in the normal isolated profile instead.
  mkdirSync(path.join(root, "agent"), { recursive: true });
  writeFileSync(
    path.join(root, "agent", "models.yml"),
    JSON.stringify({
      providers: {
        "owner-local": {
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
  const childExtension = path.join(root, "child-latches.ts");
  writeFileSync(
    childExtension,
    `export default function(api) {
    const root = ${JSON.stringify(root)}, url = ${JSON.stringify(url)};
    const post = (route, body) => fetch(url + route, {method:"POST",body:JSON.stringify(body)});
    const owner = input => ["A","B","C"].find(value => input?.path === root + "/write-" + value);
    api.on("tool_call", async event => {
      const who = owner(event.input);
      if (event.toolName === "write" && who && who !== "C") await post("/write-latch",{owner:who,toolCallId:event.toolCallId});
    });
    api.on("tool_result", async event => {
      const who = owner(event.input);
      if (event.toolName === "write" && who) await post("/trace",{type:"native-write-result",owner:who,isError:event.isError ?? false});
      if (event.toolName === "write" && who === "C") {
        await post("/result-latch",{owner:who});
        await post("/trace",{type:"result-hook-returned",owner:who});
      }
    });
  }`,
  );
  const extension = path.join(root, "owner-probe.ts");
  writeFileSync(
    extension,
    `export default api => (${installProbe.toString()})(api, ${JSON.stringify({
      url,
      root,
      agentDir: path.join(root, "agent"),
      sessionsDir: path.join(root, "sessions"),
      childExtension,
      cancellation: args.includes("--probe-cancellation"),
    })});`,
  );
  const configPath = path.join(root, "config.yml");
  writeFileSync(configPath, "{}\n");
  child = spawn(binary, ["--mode", "rpc", "--no-session", "--extension", extension, "--model", "owner-local/probe", "--thinking", "off", "--config", configPath], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_CONFIG_DIR: path.join(root, "config") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const termination = Promise.withResolvers();
  closed = termination.promise;
  child.once("close", (code, signal) => {
    record({ type: "process-closed", code, signal });
    termination.resolve();
  });
  child.on("error", (error) => record({ type: "process-error", error: String(error) }));
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const event = JSON.parse(line);
        if (["ready", "response", "extension_error", "tool_execution_start", "tool_execution_end", "agent_end"].includes(event.type)) record(event);
      } catch {
        record({ type: "stdout", line });
      }
    }
  });
  child.stderr.on("data", (chunk) => record({ type: "stderr", text: String(chunk) }));
  const ready = await waitFor((event) => ["ready", "process-closed", "process-error"].includes(event.type));
  assert.equal(ready.type, "ready", JSON.stringify(ready));
  child.stdin.write(`${JSON.stringify({ id: "owner-probe", type: "prompt", message: "Run the owner_probe diagnostic tool now." })}\n`);
  const outcome = await waitFor((event) => ["outcome", "fixture-error", "process-closed", "process-error"].includes(event.type));
  if (outcome.status === "unsupported-prerequisite") process.exitCode = 2;
  else {
    assert.equal(outcome.status, "passed-supported-subset", JSON.stringify(outcome));
    await waitFor((event) => event.type === "owned-sessions-disposed");
    for (const owner of ["A", "B"]) assert.equal(readFileSync(path.join(root, `write-${owner}`), "utf8"), `native-write-${owner}\n`);
    const freshIndex = events.findIndex((event) => event.type === "fresh-finalization");
    assert.ok(freshIndex >= 0 && !events.slice(0, freshIndex).some((event) => event.type === "released" && event.key === "write-B"));
    assert.ok(events.some((event) => event.type === "native-delivery"));
  }
  console.log(
    JSON.stringify(
      {
        ...outcome,
        events: events.filter((event) =>
          ["watched-live", "delivery-held", "native-delivery", "continuation-held", "fresh-finalization", "native-write-result", "cancellation-tail"].includes(event.type),
        ),
      },
      null,
      2,
    ),
  );
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({ status: "failed", error: String(error), recent: events.slice(-45) }, null, 2));
} finally {
  for (const pending of held.values()) pending.response.destroy();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(timer);
  }
  for (const socket of sockets) socket.destroy();
  if (server.listening) {
    const stopped = Promise.withResolvers();
    server.close(stopped.resolve);
    await stopped.promise;
  }
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
}
