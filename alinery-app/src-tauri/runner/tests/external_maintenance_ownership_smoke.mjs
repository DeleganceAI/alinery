// External-only native maintenance subset; exit 3 preserves incomplete whole-lifecycle coverage.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.argv.includes("--help")) {
  console.log(
    "Usage: node external_maintenance_ownership_smoke.mjs [--workflow] [--cancel-speculation | --queued-continuation]\nDefault probes module access. --workflow exercises native speculation/write and later armed commit. --cancel-speculation cancels actual native speculation at its held file write. --queued-continuation uses native idle compaction and its queued-message scheduler, retaining a broad caller lease. Exit 3 = remaining coverage gap; 1 = fixture/oracle fault. No durable Alinery authority, universal callback cleanup, recovery rollback or multi-owner proof.",
  );
  process.exit(0);
}
assert.ok(
  process.argv.slice(2).every((arg) => ["--workflow", "--cancel-speculation", "--queued-continuation"].includes(arg)),
  "Unknown argument",
);
const cancelSpeculation = process.argv.includes("--cancel-speculation");
const queuedContinuation = process.argv.includes("--queued-continuation");
assert.ok(!(cancelSpeculation && queuedContinuation), "Select cancellation or queued continuation");
const workflow = process.argv.includes("--workflow") || cancelSpeculation || queuedContinuation;
const binary = process.env.OMP_BIN || "/Applications/Alinery.omp/omp";
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const binaryHash = sha256(binary);
assert.equal(binaryHash, "9d4b74e20502f06348143fc3fbd630326d16c1a11a7eb0a94b44e5818aa78e47");
const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
assert.match(version, /18\.1\.13\b/);
const root = mkdtempSync(path.join(tmpdir(), "alinery-maintenance-access-"));
const agentDir = path.join(root, "agent");
const unexpectedRequests = [];
let nativeHandoff = false;
const sockets = new Set();
let primaryRequests = 0;
let handoffRequests = 0;
const server = createServer(async (request, response) => {
  if (workflow && ["/handoff-enter", "/handoff-exit"].includes(request.url)) {
    nativeHandoff = request.url === "/handoff-enter";
    response.end("{}");
    return;
  }
  if (workflow && request.url === "/chat/completions") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const primary = !nativeHandoff;
    const messages = JSON.stringify(body.messages);
    const nearThreshold = primary && messages.includes("MAINTENANCE_SEED_TWO") && !messages.includes("MAINTENANCE_SEED_THREE");
    if (primary) primaryRequests++;
    else handoffRequests++;
    const text = primary
      ? Array.from({ length: 180 }, (_, index) => `${index}: ${createHash("sha256").update(`native-context-${index}`).digest("hex")}`).join("\n")
      : "Native speculative handoff document: preserve the fixture investigation.";
    const usage = { prompt_tokens: nearThreshold ? 48000 : 10000, completion_tokens: 1000, total_tokens: nearThreshold ? 49000 : 11000 };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "maintenance-fixture", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "maintenance-fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  unexpectedRequests.push({ method: request.method, url: request.url });
  response.writeHead(500);
  response.end("Unexpected request");
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
let child;
let closed;
let timer;
const logs = [];
async function nativeWorkflow(api, config, ctx) {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const { SessionMaintenance } = await import("@oh-my-pi/pi-coding-agent/session/session-maintenance");
  const { SessionHandoff } = await import("@oh-my-pi/pi-coding-agent/session/session-handoff");
  const scope = new AsyncLocalStorage();
  const owner = {};
  const events = [];
  const active = new Set();
  const retained = new Set();
  const restores = [];
  const preEntered = Promise.withResolvers();
  const preRelease = Promise.withResolvers();
  const writeEntered = Promise.withResolvers();
  const writeRelease = Promise.withResolvers();
  const speculationDone = Promise.withResolvers();
  const commitEntered = Promise.withResolvers();
  const commitRelease = Promise.withResolvers();
  const continuationEntered = Promise.withResolvers();
  const continuationRelease = Promise.withResolvers();
  let maintenanceInstance;
  let commitExpected = false;
  let committed = 0;
  let session;
  let holdAdmission = false;
  let admissionHeld = false;
  let writeHeld = false;
  let writePath;
  let promptReturned = false;
  let ordinal = 0;
  const check = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const wait = async (promise, label) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Missing native boundary: ${label}`)), 20000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const enter = (name) => {
    const id = `${name}:${++ordinal}`;
    active.add(id);
    events.push({ type: "enter", id });
    return id;
  };
  const leave = (id) => {
    active.delete(id);
    events.push({ type: "settled", id });
  };
  const retainSpeculation = (instance) => {
    maintenanceInstance = instance;
    const promise = instance.speculationCompletion;
    if (!promise || retained.has(promise)) return;
    retained.add(promise);
    const id = enter("speculation-promise");
    void promise.then(
      () => {
        leave(id);
        speculationDone.resolve();
      },
      (error) => {
        leave(id);
        speculationDone.reject(error);
      },
    );
  };
  const decorate = (prototype, name, make) => {
    const original = prototype[name];
    check(typeof original === "function", `Missing public ${name}`);
    prototype[name] = make(original);
    restores.push(() => {
      prototype[name] = original;
    });
  };
  try {
    // Uniform public method delegation: no private instance or listener access.
    for (const name of ["maybeStartSpeculativeCompaction", "deferThresholdCompactionToSpeculation"]) {
      decorate(
        SessionMaintenance.prototype,
        name,
        (original) =>
          function (...args) {
            if (scope.getStore() !== owner) return original.apply(this, args);
            retainSpeculation(this);
            events.push({ type: "native-speculation-eligibility", name, args });
            try {
              return original.apply(this, args);
            } finally {
              retainSpeculation(this);
            }
          },
      );
    }
    decorate(
      SessionMaintenance.prototype,
      "checkCompaction",
      (original) =>
        async function (...args) {
          if (scope.getStore() !== owner) return original.apply(this, args);
          const id = enter("checkCompaction");
          events.push({ type: "native-maintenance-input", stopReason: args[0]?.stopReason, usage: args[0]?.usage, errorMessage: args[0]?.errorMessage });
          try {
            if (holdAdmission && !admissionHeld) {
              admissionHeld = true;
              preEntered.resolve();
              await preRelease.promise;
            }
            return await original.apply(this, args);
          } finally {
            leave(id);
          }
        },
    );
    decorate(
      SessionMaintenance.prototype,
      "runAutoCompaction",
      (original) =>
        async function (...args) {
          if (scope.getStore() !== owner) return original.apply(this, args);
          const id = enter("runAutoCompaction");
          try {
            if (commitExpected) {
              commitEntered.resolve();
              await commitRelease.promise;
            }
            return await original.apply(this, args);
          } finally {
            leave(id);
          }
        },
    );
    decorate(
      SessionHandoff.prototype,
      "generateDocument",
      (original) =>
        async function (...args) {
          if (scope.getStore() !== owner) return original.apply(this, args);
          const id = enter("generateDocument");
          try {
            await fetch(`${config.url}/handoff-enter`, { method: "POST" });
            return await original.apply(this, args);
          } finally {
            await fetch(`${config.url}/handoff-exit`, { method: "POST" });
            leave(id);
          }
        },
    );
    const originalWrite = Bun.write;
    Bun.write = async function (...args) {
      if (scope.getStore() === owner && typeof args[0] === "string" && args[0].startsWith(config.root) && args[0].endsWith(".md") && !writeHeld) {
        writeHeld = true;
        writePath = args[0];
        events.push({ type: "native-write-held", path: writePath, active: [...active] });
        writeEntered.resolve();
        await writeRelease.promise;
      }
      return originalWrite.apply(this, args);
    };
    restores.push(() => {
      Bun.write = originalWrite;
    });
    await scope.run(owner, async () => {
      ({ session } = await api.pi.createAgentSession({
        cwd: config.root,
        agentDir: config.agentDir,
        model: ctx.model,
        modelRegistry: ctx.modelRegistry,
        authStorage: ctx.modelRegistry.authStorage,
        autoApprove: true,
        sessionManager: api.pi.SessionManager.create(config.root, config.sessionsDir),
        settings: api.pi.Settings.isolated({
          "compaction.methodOrder": ["handoff", "soft"],
          "compaction.thresholdTokens": 50000,
          "compaction.keepRecentTokens": 1000,
          "compaction.handoffSaveToDisk": true,
        }),
      }));
      const originalAppend = session.sessionManager.appendCompaction;
      session.sessionManager.appendCompaction = function (...args) {
        check(
          [...active].some((id) => id.startsWith("runAutoCompaction:")),
          "Native commit escaped maintenance scope",
        );
        const result = originalAppend.apply(this, args);
        committed++;
        events.push({ type: "native-compaction-appended", entryId: result, savedSummary: args[0], active: [...active] });
        return result;
      };
      restores.push(() => {
        session.sessionManager.appendCompaction = originalAppend;
      });
      await session.prompt("MAINTENANCE_SEED_ONE: provide fixture context.");
      holdAdmission = true;
      const prompt = session.prompt("MAINTENANCE_SEED_TWO: continue fixture context.").then(() => {
        promptReturned = true;
      });
      await wait(preEntered.promise, "before native checkCompaction");
      check(!writeHeld && retained.size === 0, "Speculation escaped the pre-mutation barrier");
      events.push({ type: "pre-maintenance-admission-held", active: [...active] });
      preRelease.resolve();
      await wait(writeEntered.promise, "actual native handoff write");
      await wait(prompt, "native prompt return while speculation held");
      check(promptReturned && [...active].some((id) => id.startsWith("speculation-promise:")), "Native producer lost ownership at prompt return");
      check(
        [...active].some((id) => id.startsWith("generateDocument:")),
        "Native handoff method ended before its write",
      );
      check(!(await Bun.file(writePath).exists()), "Native write happened before latch release");
      events.push({ type: "prompt-returned-with-native-write-pending", active: [...active] });
      if (config.cancelSpeculation) {
        check(maintenanceInstance, "Missing observed native maintenance receiver");
        maintenanceInstance.cancelSpeculation();
        check(session.compactionSpeculation === "idle", "Native cancellation did not clear visible slot");
        check(
          [...active].some((id) => id.startsWith("speculation-promise:")),
          "Slot removal falsely settled native promise",
        );
        check(!(await Bun.file(writePath).exists()), "File already written before cancellation oracle");
        events.push({ type: "native-slot-cleared-with-write-still-pending", active: [...active] });
      }
      writeRelease.resolve();
      await wait(speculationDone.promise, "retained native speculation promise");
      check((await Bun.file(writePath).text()).includes("Native speculative handoff document"), "Native handoff file content missing");
      check(active.size === 0, "Scoped work remained after real settlement");
      events.push({ type: "native-file-and-promise-settled", active: [...active], speculationState: session.compactionSpeculation });
      if (!config.cancelSpeculation) {
        check(session.compactionSpeculation === "armed", "Native speculation did not arm");
        commitExpected = true;
        let rootLease;
        if (config.queuedContinuation) {
          rootLease = enter("idle-maintenance-and-pending-continuation");
          restores.push(
            session.agent.addBeforeModelCallHook(async () => {
              events.push({ type: "native-queued-continuation-held", active: [...active] });
              continuationEntered.resolve();
              await continuationRelease.promise;
            }),
          );
          restores.push(
            session.subscribe((event) => {
              if (event.type === "auto_compaction_end") events.push({ type: "auto-compaction-end-observed", active: [...active] });
            }),
          );
        }
        const next = config.queuedContinuation
          ? session.runIdleCompaction()
          : session.prompt(`MAINTENANCE_SEED_THREE: apply existing context. ${Array.from({ length: 1400 }, (_, i) => `detail-${i}`).join(" ")}`);
        await wait(commitEntered.promise, "native armed commit admission");
        check(committed === 0 && [...active].some((id) => id.startsWith("runAutoCompaction:")), "Commit ran before admission release");
        events.push({ type: "native-commit-admission-held", active: [...active] });
        if (config.queuedContinuation) {
          // Public native queue API; native maintenance owns scheduling/dequeue.
          session.agent.followUp({ role: "user", content: [{ type: "text", text: "MAINTENANCE_SEED_THREE: process this queued follow-up." }], timestamp: Date.now() });
        }
        commitRelease.resolve();
        await wait(next, "native maintenance invoking method");
        if (config.queuedContinuation) {
          await wait(continuationEntered.promise, "native scheduled continuation");
          check(active.has(rootLease), "Broad maintenance lease ended before pending continuation");
          check(
            events.some((event) => event.type === "auto-compaction-end-observed"),
            "Continuation did not follow native compaction end",
          );
          check(![...active].some((id) => id.startsWith("runAutoCompaction:")), "Expected native auto-compaction invocation to return before held continuation");
          events.push({ type: "native-method-returned-with-continuation-pending", active: [...active] });
          continuationRelease.resolve();
        }
        await session.waitForIdle();
        await session.sessionManager.flush();
        if (config.queuedContinuation) {
          check(
            session.messages.some((message) => JSON.stringify(message).includes("process this queued follow-up")),
            "Native queued message was not consumed into history",
          );
          leave(rootLease);
        }
        check(committed === 1, "Expected one native armed summary commit");
        check(
          events.some((event) => event.type === "native-compaction-appended" && event.savedSummary.includes("Native speculative handoff document")),
          "Native armed summary was not committed",
        );
        check(active.size === 0, "Maintenance scopes remained after native commit");
        events.push({ type: "native-commit-and-following-prompt-settled", active: [...active] });
      }
    });
    return { status: "passed-bounded-speculation-subset", events, nativeMaintenanceExecuted: true };
  } catch (error) {
    return { status: "failed", error: String(error), events, nativeMaintenanceExecuted: true };
  } finally {
    preRelease.resolve();
    writeRelease.resolve();
    commitRelease.resolve();
    continuationRelease.resolve();
    if (session) await session.dispose();
    for (const restore of restores.reverse()) restore();
  }
}
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "maintenance-local": {
          baseUrl: url,
          apiKey: "loopback-only",
          api: "openai-completions",
          models: [
            { id: "probe", name: "probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 12000 },
          ],
        },
      },
    }),
  );
  const extension = path.join(root, "probe.ts");
  writeFileSync(
    extension,
    `export default async function(api) {
    const results = [];
    for (const [name, load] of [
      ["SessionMaintenance", () => import("@oh-my-pi/pi-coding-agent/session/session-maintenance")],
      ["SessionHandoff", () => import("@oh-my-pi/pi-coding-agent/session/session-handoff")],
      ["TurnRecovery", () => import("@oh-my-pi/pi-coding-agent/session/turn-recovery")]
    ]) {
      try {
        const module = await load();
        const value = module[name];
        results.push({ name, imported: true, exportedClass: typeof value === "function", publicMembers: typeof value === "function" ? Object.getOwnPropertyNames(value.prototype) : [] });
      } catch (error) {
        results.push({ name, imported: false, error: String(error) });
      }
    }
    if (${workflow}) {
      api.registerCommand("maintenance-native-probe", {
        description: "Run isolated native maintenance ownership probe",
        handler: async (_args, ctx) => {
          const workflow = await (${nativeWorkflow.toString()})(api, ${JSON.stringify({ root, agentDir, url, cancelSpeculation, queuedContinuation, sessionsDir: path.join(root, "sessions") })}, ctx);
          console.log(JSON.stringify({ maintenanceAccessProbe: true, results, workflow }));
        }
      });
    } else console.log(JSON.stringify({ maintenanceAccessProbe: true, results }));
  }`,
  );
  const config = path.join(root, "config.yml");
  writeFileSync(config, "{}\n");
  const outcome = Promise.withResolvers();
  child = spawn(binary, ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", extension, "--model", "maintenance-local/probe", "--config", config], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_CONFIG_DIR: path.join(root, "config") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  closed = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      outcome.reject(new Error(`Child closed before probe: ${code}/${signal}`));
      resolve();
    }),
  );
  child.once("error", outcome.reject);
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const event = JSON.parse(line);
        if (event.maintenanceAccessProbe) outcome.resolve(event);
        else {
          logs.push(event);
          if (workflow && event.type === "ready") child.stdin.write(`${JSON.stringify({ id: "maintenance", type: "prompt", message: "/maintenance-native-probe" })}\n`);
        }
      } catch {
        logs.push(line);
      }
    }
  });
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  timer = setTimeout(() => outcome.reject(new Error("Diagnostic did not finish")), workflow ? 90000 : 30000);
  const result = await outcome.promise;
  assert.equal(unexpectedRequests.length, 0, "Unexpected provider traffic");
  assert.equal(result.results.length, 3);
  if (workflow) assert.equal(result.workflow?.status, "passed-bounded-speculation-subset", JSON.stringify(result.workflow));
  console.log(
    JSON.stringify(
      {
        status: "coverage-gap",
        scope: workflow ? "native-speculation-subset" : "module-access-only",
        version,
        binaryHash,
        ...result,
        unexpectedRequests,
        primaryRequests,
        handoffRequests,
        nativeMaintenanceExecuted: workflow,
      },
      null,
      2,
    ),
  );
  process.exitCode = 3;
} catch (error) {
  console.error(
    JSON.stringify(
      { status: "failed", error: String(error), unexpectedRequests, primaryRequests, handoffRequests, logs: logs.filter((event) => event?.type !== "available_commands_update") },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(killTimer);
  }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
