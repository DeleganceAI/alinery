// One-command manual smoke for the real OMP extension -> alinery-runner result path.
//
// The local socket simulates invalid outputs, acknowledgement timeout, then ready
// across consecutive readiness reports. The OMP extension automatically retries
// transport failures; the runner-only self-test exposes delivery_failed directly.
// This is a transport diagnostic, not alineryd's durable continuation validation.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const runnerPath = path.resolve(thisDir, "../../target/debug/alinery-runner");
const root = mkdtempSync(path.join(tmpdir(), "alinery-omp-completion-smoke-"));
const socketPath = path.join(root, "alineryd.sock");
const sessionId = "manual-completion-smoke";
const eventToken = "manual-completion-smoke-token";
let completionAttempts = 0;
const control = {
  process_incarnation: "manual-smoke-incarnation",
  capability_revision: 0,
  work_revision: 0,
  continuation_requested_revision: null,
  available: false,
  reason: "not bound",
};

const transportEnvironment = {
  ALINERY_SESSION_ID: sessionId,
  ALINERY_DAEMON_SOCKET: socketPath,
  ALINERY_DAEMON_NAMESPACE: "manual-completion-smoke",
  ALINERY_EVENT_PROTOCOL_VERSION: "4",
  ALINERY_EVENT_TOKEN: eventToken,
};

const server = createServer((connection) => {
  let input = "";
  connection.setEncoding("utf8");
  connection.on("data", (chunk) => {
    input += chunk;
    if (input.length > 128 * 1024) connection.destroy();
    if (!input.includes("\n")) return;

    const line = input.slice(0, input.indexOf("\n"));
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      connection.end('{"error":"invalid-event"}\n');
      return;
    }

    if (
      request.op !== "event" ||
      request.version !== Number(transportEnvironment.ALINERY_EVENT_PROTOCOL_VERSION) ||
      request.session_id !== sessionId ||
      request.token !== eventToken
    ) {
      connection.end('{"error":"invalid-event-auth"}\n');
      return;
    }

    const event = request.event;
    if (event?.type === "continuation_bind" || event?.type === "continuation_revoke") {
      assert.equal(event.expected_capability_revision, control.capability_revision);
      control.capability_revision += 1;
      control.available = event.type === "continuation_bind";
      control.reason = control.available ? null : event.reason;
      if (!control.available) control.work_revision += 1;
    }
    if (event?.type === "continuation_poll" || event?.type === "continuation_bind" || event?.type === "continuation_revoke" || event?.type?.startsWith("native_")) {
      if (event.process_incarnation !== undefined) assert.equal(event.process_incarnation, control.process_incarnation);
      if (event.type === "native_work_entered") control.work_revision += 1;
      connection.end(`${JSON.stringify({ ok: true, control })}\n`);
      return;
    }
    if (event?.type !== "readiness_reported") {
      connection.end('{"ok":true}\n');
      return;
    }

    assert.equal(event.process_incarnation, control.process_incarnation);
    assert.equal(event.expected_work_revision, control.work_revision);
    completionAttempts += 1;
    if (completionAttempts === 1) {
      if (!process.argv.includes("--self-test"))
        process.stdout.write("\nReadiness report 1: invalid_outputs. Ask OMP to call alinery_phase_complete once more and end its turn.\n");
      connection.end('{"ok":true,"completion":{"status":"invalid_outputs","diagnostics":["At least one valid assigned artifact must be published"]}}\n');
    } else if (completionAttempts === 2) {
      // Deliberately leave the connection unanswered so the runner times out.
      // Runner-only calls return delivery_failed; OMP retries this same report.
      if (!process.argv.includes("--self-test")) process.stdout.write("\nReadiness report 2: withholding ACK; waiting for OMP's automatic transport retry.\n");
    } else {
      connection.end(`${JSON.stringify({ ok: true, completion: { status: "ready", ready_revision: control.work_revision } })}\n`);
      if (!process.argv.includes("--self-test")) process.stdout.write("\nReadiness report 3: ready. Keep the session open for review; exit manually after inspection.\n");
    }
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(socketPath, resolve);
});

function runResultEmit(event) {
  return new Promise((resolve, reject) => {
    const child = spawn(runnerPath, ["emit", "--result"], {
      env: transportEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(event));
  });
}

async function selfTest() {
  async function expectControl(event, expected) {
    const { code, stdout, stderr } = await runResultEmit(event);
    assert.deepEqual({ code, result: JSON.parse(stdout), stderr }, { code: 0, result: expected, stderr: "" });
  }
  await expectControl({ type: "continuation_poll" }, { ...control });
  await expectControl(
    { type: "continuation_bind", omp_session_id: "omp-manual-smoke", groups: ["primary_control"], operation_id: "bind", expected_capability_revision: 0 },
    { ...control, capability_revision: 1, available: true, reason: null },
  );
  await expectControl({ type: "native_work_entered", process_incarnation: control.process_incarnation, operation_id: "work" }, { ...control, work_revision: 1 });
  await expectControl({ type: "native_work_settled", process_incarnation: control.process_incarnation, operation_id: "work" }, { ...control });
  await expectControl({ type: "continuation_poll", process_incarnation: control.process_incarnation }, { ...control });
  const results = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    results.push(
      await runResultEmit({
        type: "readiness_reported",
        process_incarnation: control.process_incarnation,
        expected_work_revision: control.work_revision,
      }),
    );
  }

  assert.deepEqual(
    results.map(({ code, stdout, stderr }) => ({
      code,
      result: JSON.parse(stdout),
      stderr,
    })),
    [
      {
        code: 0,
        result: {
          status: "invalid_outputs",
          diagnostics: ["At least one valid assigned artifact must be published"],
        },
        stderr: "",
      },
      { code: 3, result: { status: "delivery_failed" }, stderr: "" },
      { code: 0, result: { status: "ready", ready_revision: 1 }, stderr: "" },
    ],
  );
  assert.equal(completionAttempts, 3);
  process.stdout.write("readiness smoke fixture self-test passed: control/native ACKs; invalid_outputs -> delivery_failed -> ready\n");
}

async function runOmpSmoke() {
  const ompBinary = process.env.OMP_BIN;
  if (!ompBinary || !path.isAbsolute(ompBinary)) throw new Error("Set OMP_BIN to the absolute packaged OMP binary path; PATH fallback is not allowed.");
  const prompt = [
    "This is an Alinery readiness feedback smoke test.",
    "Call alinery_phase_complete once, state its exact tool result, then end your turn.",
    "If it reports waiting for selected native work, ending the turn lets that work settle and readiness be reported automatically.",
    "Do not use any other tools or retry in this turn. Keep this session open for review and the operator's next instruction.",
  ].join(" ");

  process.stdout.write(
    [
      "Starting real OMP with a deterministic fake alineryd acknowledgement sequence:",
      "  1. invalid_outputs: At least one valid assigned artifact must be published",
      "  2. acknowledgement timeout: runner delivery_failed; OMP automatically retries",
      "  3. ready: handoff validated, session stays open for review",
      "After report 1 appears, ask OMP to call alinery_phase_complete once more and end its turn.",
      "Calls may return waiting until the native turn settles; inspect the readiness reports below.",
      "After the timeout retry reaches ready, exit OMP manually. Ready does not automatically exit.",
      "This fake-daemon smoke does not prove artifact validation, durable readiness, acceptance, or successor gating.\n",
    ].join("\n"),
  );

  const child = spawn(runnerPath, ["run", "--adapter", "omp", "--", ompBinary, prompt], {
    env: {
      ...process.env,
      ...transportEnvironment,
      ALINERY_RUNNER_PATH: runnerPath,
      ALINERY_REPO: root,
      ALINERY_APP_CONFIG: path.join(root, "app.toml"),
    },
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });

  if (completionAttempts !== 3) {
    throw new Error(`OMP emitted ${completionAttempts} readiness report(s); expected exactly 3 (including one transport retry)`);
  }
  process.stdout.write(`Observed all three authenticated readiness reports in the expected order (OMP exit ${code}).\n`);
}

// No external model or credentials: the real pinned runtime talks only to a
// loopback provider. A held hook acknowledgement is the admission barrier.
async function probeAdmission() {
  const ompBinary = process.env.OMP_BIN;
  if (!ompBinary || !path.isAbsolute(ompBinary)) throw new Error("Set an absolute OMP_BIN.");
  for (const hook of ["agent_start", "before_agent_start", "before_provider_request"]) {
    const events = [];
    let release;
    let observed;
    const providerReached = new Promise((resolve) => (observed = resolve));
    const connections = new Set();
    const provider = createHttpServer((request, response) => {
      if (request.url === "/admit") {
        events.push("hook_entered");
        release = () => {
          events.push("ack_released");
          response.end("allowed");
        };
        return;
      }
      events.push("provider_request");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        'data: {"id":"probe","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"probe"},"finish_reason":null}]}\n\ndata: {"id":"probe","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
      observed();
    });
    provider.on("connection", (connection) => {
      connections.add(connection);
      connection.on("close", () => connections.delete(connection));
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${provider.address().port}`;
    const extension = path.join(root, `probe-${hook}.ts`);
    writeFileSync(
      extension,
      `export default function(api) {
      api.registerProvider("admission-probe", {
        baseUrl: ${JSON.stringify(baseUrl)}, apiKey: "local-probe", api: "openai-completions",
        models: [{id:"probe",name:"Probe",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:128}]
      });
      api.on(${JSON.stringify(hook)}, async (_event, context) => {
        await fetch(${JSON.stringify(`${baseUrl}/admit`)});
      });
    }`,
    );
    const child = spawn(
      ompBinary,
      [
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-rules",
        "--no-tools",
        "--no-lsp",
        "--no-title",
        "--extension",
        extension,
        "--model",
        "admission-probe/probe",
        "--thinking",
        "off",
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          PI_CODING_AGENT_DIR: path.join(root, "agent"),
          PI_CONFIG_DIR: path.join(root, "config"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.stdin.write(`${JSON.stringify({ id: "probe", type: "prompt", message: "Reply probe." })}\n`);
    let timeout;
    try {
      await Promise.race([providerReached, new Promise((_, reject) => (timeout = setTimeout(() => reject(new Error(`No provider observation: ${output}`)), 45000)))]);
      assert.ok(release, `${hook} was not entered`);
      assert.ok(!events.includes("ack_released"));
      console.log(`${hook}: provider request occurred WITHOUT admission ACK; events=${JSON.stringify(events)}`);
      if (output.includes("timed out")) console.log(`${hook}: runtime reported handler timeout`);
      release();
    } finally {
      clearTimeout(timeout);
      child.kill("SIGTERM");
      await closed;
      for (const connection of connections) connection.destroy();
      await new Promise((resolve) => provider.close(resolve));
    }
  }
  throw new Error("Pinned runtime probe observed provider requests without admission ACK; these candidate gates do not satisfy the contract.");
}

// Candidate composition: bound admission below OMP's hook timeout, abort on
// refusal, block tools explicitly, and reject new input while sealed.
async function probeExistingHooks() {
  const ompBinary = process.env.OMP_BIN;
  if (!ompBinary || !path.isAbsolute(ompBinary)) throw new Error("Set an absolute OMP_BIN.");
  const advisorProbe = process.argv.includes("--probe-advisor-hook");
  const backgroundProbe = process.argv.includes("--probe-background-hook");
  const providerWrapper = process.argv.includes("--provider-wrapper");
  const events = [];
  const listeners = new Set();
  const record = (event) => {
    events.push(event);
    for (const listener of listeners) listener();
  };
  const waitFor = (predicate, from = 0) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const found = events.slice(from).find(predicate);
        if (!found) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(found);
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(
          new Error(
            `Probe event missing; events=${JSON.stringify(events.slice(from).filter((event) => ["admit", "rejected", "provider", "extension_error", "stderr", "completion_waiting", "tool_admitted", "advisor_status"].includes(event.type)))}`,
          ),
        );
      }, 10000);
      listeners.add(check);
      check();
    });
  let gate = "allow";
  let held;
  let modelReply = "text";
  let providerCalls = 0;
  let commitHeld;
  let holdProviderResponse = false;
  let releaseProviderResponse;
  let denyTools = false;
  let primaryCalls = 0;
  let backgroundHeld;
  let allowAdvisor = false;
  const connections = new Set();
  const provider = createHttpServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url === "/admit") {
      const event = JSON.parse(body);
      record({ type: "admit", kind: event.kind });
      if (event.kind === "provider" && gate !== "allow") {
        held = response;
        return;
      }
      response.end(JSON.stringify({ allowed: (event.kind !== "advisor" || allowAdvisor) && !(denyTools && event.kind === "tool") }));
      return;
    }
    if (request.url === "/trace") {
      record(JSON.parse(body));
      response.end("{}");
      return;
    }
    if (request.url === "/commit") {
      commitHeld = response;
      record({ type: "commit_wait" });
      return;
    }
    providerCalls += 1;
    const requestModel = JSON.parse(body).model;
    record({ type: "provider", number: providerCalls, model: requestModel });
    if (backgroundProbe && requestModel === "background-probe") {
      backgroundHeld = response;
      record({ type: "background_held" });
      return;
    }
    if (backgroundProbe) {
      primaryCalls++;
      modelReply =
        primaryCalls === 1
          ? { name: "eval", input: { language: "js", code: 'const pending = completion("Reply with probe.", {model:"smol"}); display(pending.id);' } }
          : primaryCalls === 3 && providerWrapper
            ? "text"
            : { name: "write", input: { path: "xd://probe_complete", content: "{}" } };
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta =
      modelReply === "text"
        ? { role: "assistant", content: "probe response" }
        : {
            role: "assistant",
            tool_calls: (Array.isArray(modelReply) ? modelReply : [modelReply]).map((spec, index) => ({
              index,
              id: `call_${providerCalls}_${index}`,
              type: "function",
              function: { name: typeof spec === "string" ? spec : spec.name, arguments: JSON.stringify(typeof spec === "string" ? {} : spec.input) },
            })),
          };
    const finish = modelReply === "text" ? "stop" : "tool_calls";
    modelReply = "text";
    const reply = () =>
      response.end(
        `data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
      );
    if (holdProviderResponse) {
      holdProviderResponse = false;
      releaseProviderResponse = reply;
      record({ type: "provider_response_held" });
    } else reply();
  });
  provider.on("connection", (connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${provider.address().port}`;
  const extension = path.join(root, "existing-hook-probe.ts");
  writeFileSync(
    extension,
    `
    import { writeFileSync } from "node:fs";
    ${providerWrapper ? 'import { AssistantMessageEventStream, streamSimple } from "@oh-my-pi/pi-ai";' : ""}
    export default function(api) {
      const url = ${JSON.stringify(baseUrl)};
      let sealed = false;
      const tools = new Set();
      const requests = new Set();
      let runtimeContext;
      api.on("session_start", (_event, context) => { runtimeContext = context; });
      const post = (route, value, signal) => fetch(url + route, {
        method: "POST", body: JSON.stringify(value), signal
      });
      const trace = value => post("/trace", value);
      async function admit(kind, context) {
        try {
          if (sealed) throw new Error("finalization fence");
          const reply = await post("/admit", {kind}, AbortSignal.timeout(500));
          if (!(await reply.json()).allowed) throw new Error("admission denied");
          if (sealed) throw new Error("finalization fence");
          return true;
        } catch (error) {
          context.abort();
          context.ui.notify("Work rejected: " + error.message, "error");
          await trace({type:"rejected", kind, reason:error.message});
          return false;
        }
      }
      ${
        providerWrapper
          ? `
      function admittedStream(model, context, options) {
        const output = new AssistantMessageEventStream();
        const identity = Symbol();
        requests.add(identity);
        let delegated = false;
        void (async () => {
          try {
            if (sealed) throw new Error("finalization fence");
            const kind = model.id === "advisor-probe" ? "advisor" : "provider";
            const response = await post("/admit", {kind}, AbortSignal.timeout(500));
            if (!(await response.json()).allowed) throw new Error("admission denied");
            if (sealed || options?.signal?.aborted) throw new Error("request no longer admitted");
            await trace({type:"wrapper_admitted", model:model.id});
            const original = runtimeContext.modelRegistry.find("native-probe", model.id);
            delegated = true;
            const native = streamSimple({...original, provider:model.provider, baseUrl:model.baseUrl}, context, options);
            output.forwardLocalWorkFrom(native);
            let terminal;
            for await (const event of native) {
              if (event.type === "done" || event.type === "error") terminal = event;
              else output.push(event);
            }
            const result = await native.result();
            requests.delete(identity);
            await trace({type:"wrapper_settled", model:model.id, active:requests.size});
            if (terminal) output.push(terminal);
            output.end(result);
          } catch (error) {
            requests.delete(identity);
            runtimeContext?.ui.notify("Work rejected: " + error.message, "error");
            await trace({type:"wrapper_rejected", model:model.id, reason:error.message});
            if (delegated) output.fail(error);
            else output.push({type:"error", reason:"aborted", error:{
              role:"assistant", content:[], api:model.api, provider:model.provider, model:model.id,
              stopReason:"aborted", errorMessage:error.message, timestamp:Date.now(),
              usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,
                cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}
            }});
          }
        })();
        return output;
      }
      `
          : ""
      }
      ${
        providerWrapper
          ? `
      api.registerProvider("native-probe", {
        baseUrl:url, apiKey:"local-probe", api:"openai-completions",
        models:["probe", "advisor-probe", "background-probe"].map(id => ({id,name:id,reasoning:false,input:["text"],
          cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:128}))
      });
      `
          : ""
      }
      api.registerProvider("admission-probe", {
        baseUrl:url, apiKey:"local-probe", api:${JSON.stringify(providerWrapper ? "alinery-admission-probe" : "openai-completions")},
        ${providerWrapper ? "streamSimple:admittedStream," : ""}
        models:["probe", "advisor-probe", "background-probe"].map(id => ({id,name:id,reasoning:false,input:["text"],
          cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:128}))
      });
      api.on("input", async (_event, context) => {
        if (!sealed) return;
        context.ui.notify("Work rejected: finalization fence", "error");
        await trace({type:"input_rejected"});
        return {handled:true};
      });
      api.on("before_agent_start", async (_event, context) => { await admit("agent", context); });
      ${providerWrapper ? "/* Stream adapter owns model admission; do not rely on payload hooks. */" : 'api.on("before_provider_request", async (_event, context) => {'}
        ${providerWrapper ? "" : 'await admit(context.model?.id === "advisor-probe" ? "advisor" : "provider", context); });'}
      api.on("tool_call", async (event, context) => {
        if (!(await admit("tool", context))) return {block:true, reason:"admission refused"};
        tools.add(event.toolCallId);
        await trace({type:"tool_admitted", name:event.toolName});
      });
      api.on("tool_result", async (event) => { tools.delete(event.toolCallId); });
      api.registerTool({
        name:"probe_mutate", label:"Probe mutation", description:"Write a probe marker.",
        parameters:api.zod.z.object({}),
        async execute() {
          writeFileSync(${JSON.stringify(path.join(root, "mutation-marker"))}, "mutation");
          await trace({type:"mutation"});
          return {content:[{type:"text",text:"written"}],details:{}};
        }
      });
      api.registerTool({
        name:"probe_complete", label:"Probe completion", description:"Attempt a fenced handoff.",
        parameters:api.zod.z.object({}),
        async execute(_id, _input, _signal, _update, context) {
          const jobs = context.getAsyncJobSnapshot();
          await trace({type:"quiescence", tools:tools.size, pending:context.hasPendingMessages(), runningJobs:jobs?.running.length ?? 0, activeProviders:requests.size});
          if (tools.size !== 1 || context.hasPendingMessages() || jobs?.running.length || requests.size) {
            await trace({type:"completion_waiting", tools:tools.size, pending:context.hasPendingMessages(), activeProviders:requests.size});
            return {content:[{type:"text",text:"waiting"}],details:{}};
          }
          sealed = true;
          await post("/commit", {});
          await trace({type:"committed"});
          return {content:[{type:"text",text:"committed"}],details:{}};
        }
      });
    }
  `,
  );
  const config = path.join(root, "probe-config.yml");
  writeFileSync(
    config,
    advisorProbe
      ? 'advisor:\n  enabled: true\n  syncBacklog: "off"\nmodelRoles:\n  advisor: "admission-probe/advisor-probe"\n'
      : backgroundProbe
        ? 'modelRoles:\n  smol: "admission-probe/background-probe"\n'
        : "{}\n",
  );
  const child = spawn(
    ompBinary,
    [
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "--tools",
      backgroundProbe ? "write,eval" : "write",
      "--no-lsp",
      "--no-title",
      "--extension",
      extension,
      "--model",
      "admission-probe/probe",
      "--thinking",
      "off",
      "--config",
      config,
    ],
    {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_CONFIG_DIR: path.join(root, "config") },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  let pending = "";
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    while (pending.includes("\n")) {
      const index = pending.indexOf("\n");
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      try {
        record(JSON.parse(line));
      } catch {
        record({ type: "stdout", line });
      }
    }
  });
  child.stderr.on("data", (chunk) => record({ type: "stderr", text: String(chunk) }));
  let requestId = 0;
  const send = (type, extra = {}) => {
    const id = `candidate-${++requestId}`;
    child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    return id;
  };
  const prompt = (message) => send("prompt", { message });
  try {
    await waitFor((event) => event.type === "ready");
    if (backgroundProbe) {
      const from = events.length;
      prompt("Start a background completion without waiting, then attempt the completion device.");
      await waitFor((event) => event.type === "background_held", from);
      const quiet = await waitFor((event) => event.type === "quiescence", from);
      if (providerWrapper) {
        const waiting = await waitFor((event) => event.type === "completion_waiting", from);
        assert.equal(quiet.runningJobs, 0);
        assert.equal(waiting.activeProviders, 1);
        await waitFor((event) => event.type === "agent_end" && event.isTerminal !== false, from);
        assert.ok(!events.slice(from).some((event) => event.type === "commit_wait"));
        backgroundHeld.writeHead(200, { "Content-Type": "text/event-stream" });
        backgroundHeld.end(
          'data: {"id":"bg","choices":[{"index":0,"delta":{"role":"assistant","content":"background finished"},"finish_reason":null}]}\n\ndata: {"id":"bg","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
        await waitFor((event) => event.type === "wrapper_settled" && event.model === "background-probe", from);
        const afterSettlement = events.length;
        prompt("Now request completion after the background request settled.");
        await waitFor((event) => event.type === "commit_wait", afterSettlement);
        commitHeld.end("{}");
        await waitFor((event) => event.type === "committed", afterSettlement);
        console.log("provider wrapper: pending eval completion blocks commit; settled completion permits a fresh commit attempt");
        return;
      }
      await waitFor((event) => event.type === "commit_wait", from);
      assert.equal(quiet.runningJobs, 0);
      assert.equal(quiet.pending, false);
      assert.equal(quiet.tools, 1);
      assert.ok(backgroundHeld && !backgroundHeld.writableEnded);
      console.log("existing hooks: COUNTEREXAMPLE background completion still running at commit gate; tools=1, pending=false, runningJobs=0");
      throw new Error("Supported hook and async-job accounting did not expose an active eval completion.");
    }
    if (advisorProbe) {
      const from = events.length;
      prompt("Reply with one short response so the advisor reviews it.");
      if (providerWrapper) {
        await waitFor((event) => event.type === "wrapper_rejected" && event.model === "advisor-probe", from);
        assert.ok(!events.slice(from).some((event) => event.type === "provider" && event.model === "advisor-probe"));
        allowAdvisor = true;
        const retryFrom = events.length;
        prompt("Start a fresh turn with advisor admission now permitted.");
        await waitFor((event) => event.type === "provider" && event.model === "advisor-probe", retryFrom);
        await waitFor((event) => event.type === "wrapper_settled" && event.model === "advisor-probe", retryFrom);
        console.log("provider wrapper: advisor denial prevented provider dispatch; later allowed advisor request completed");
        return;
      }
      const rejected = await waitFor((event) => event.type === "rejected" && event.kind === "advisor", from);
      const requested = await waitFor((event) => event.type === "provider" && event.model === "advisor-probe", from);
      assert.ok(events.indexOf(requested) > events.indexOf(rejected));
      console.log("existing hooks: COUNTEREXAMPLE advisor provider request ran after explicit admission denial and context.abort()");
      throw new Error("Existing-hook abort is not a fail-closed gate for an advisor's independent provider request.");
    }
    let from = events.length;
    gate = "hold";
    prompt("Hold the admission before this request.");
    await waitFor((event) => event.type === "admit" && event.kind === "provider", from);
    assert.equal(providerCalls, 0);
    held.end('{"allowed":true}');
    await waitFor((event) => event.type === "agent_end", from);
    assert.equal(providerCalls, 1);
    console.log("existing hooks: normal prompt waits for provider admission ACK, then runs");

    from = events.length;
    prompt("The unavailable admission must reject this request.");
    await waitFor((event) => (providerWrapper ? event.type === "wrapper_rejected" && event.model === "probe" : event.type === "rejected" && event.kind === "provider"), from);
    await waitFor((event) => event.type === "agent_end", from);
    assert.equal(providerCalls, 1);
    assert.ok(events.slice(from).some((event) => event.type === "extension_ui_request" && event.method === "notify"));
    held.end('{"allowed":true}');
    gate = "allow";
    from = events.length;
    prompt("A fresh prompt after refusal must still work.");
    await waitFor((event) => event.type === "agent_end", from);
    assert.equal(providerCalls, 2);
    console.log("existing hooks: bounded admission timeout prevents provider work; visible refusal; fresh prompt recovers");

    from = events.length;
    modelReply = "probe_mutate";
    prompt("Call the probe mutation tool.");
    await waitFor((event) => event.type === "mutation", from);
    await waitFor((event) => event.type === "agent_end", from);
    console.log("existing hooks: real model tool dispatch passes the awaited tool gate and writes marker");

    from = events.length;
    denyTools = true;
    modelReply = "probe_mutate";
    prompt("This tool call must be denied before its mutation.");
    await waitFor((event) => event.type === "rejected" && event.kind === "tool", from);
    await waitFor((event) => event.type === "agent_end", from);
    assert.ok(!events.slice(from).some((event) => event.type === "mutation"));
    denyTools = false;
    console.log("existing hooks: rejected tool admission prevents observable mutation");

    from = events.length;
    modelReply = ["probe_complete", "probe_mutate"];
    prompt("Completion and mutation are in the same tool batch.");
    const batchWait = await waitFor((event) => event.type === "completion_waiting", from);
    assert.equal(batchWait.tools, 2);
    await waitFor((event) => event.type === "mutation", from);
    await waitFor((event) => event.type === "agent_end", from);
    assert.ok(!events.slice(from).some((event) => event.type === "commit_wait"));
    console.log("existing hooks: preadmitted sibling tools make completion wait, without deadlock or acceptance");

    from = events.length;
    modelReply = "probe_complete";
    holdProviderResponse = true;
    prompt("Try completion after queued review arrives.");
    await waitFor((event) => event.type === "provider_response_held", from);
    const queued = send("follow_up", { message: "Review must happen before commit." });
    await waitFor((event) => event.type === "response" && event.id === queued, from);
    releaseProviderResponse();
    const pendingWait = await waitFor((event) => event.type === "completion_waiting", from);
    assert.equal(pendingWait.pending, true);
    await waitFor((event) => event.type === "agent_end" && event.isTerminal !== false, from);
    assert.ok(!events.slice(from).some((event) => event.type === "commit_wait"));
    console.log("existing hooks: queued review before finalization prevents commit and is processed");

    for (const command of ["steer", "follow_up", "abort_and_prompt"]) {
      from = events.length;
      holdProviderResponse = true;
      const initialCalls = providerCalls;
      prompt(`Start a turn before ${command}.`);
      await waitFor((event) => event.type === "provider_response_held", from);
      const dispatched = send(command, { message: `Exercise ${command} admission.` });
      await waitFor((event) => event.type === "response" && event.id === dispatched, from);
      releaseProviderResponse();
      const resumed = await waitFor((event) => event.type === "provider" && event.number === initialCalls + 2, from);
      await waitFor((event) => event.type === "agent_end" && event.isTerminal !== false, events.indexOf(resumed));
      assert.ok(events.slice(from).filter((event) => event.type === "admit" && event.kind === "provider").length >= 2);
      console.log(`existing hooks: ${command} resumed model work passes provider admission`);
    }

    from = events.length;
    modelReply = { name: "write", input: { path: "xd://probe_complete", content: "{}" } };
    prompt("Call the probe completion through the canonical write device.");
    await waitFor((event) => event.type === "commit_wait", from);
    assert.ok(events.slice(from).some((event) => event.type === "tool_admitted" && event.name === "write"));
    assert.ok(events.slice(from).some((event) => event.type === "tool_admitted" && event.name === "probe_complete"));
    console.log("existing hooks: canonical write device reaches completion without ancestor-count deadlock");
    const atCommit = providerCalls;
    const followup = send("follow_up", { message: "Do not lose this queued review." });
    await waitFor((event) => event.type === "response" && event.id === followup, from);
    commitHeld.end("{}");
    await waitFor((event) => event.type === "committed", from);
    await waitFor((event) => event.type === "rejected" || event.type === "wrapper_rejected", from);
    await waitFor((event) => event.type === "agent_end", from);
    assert.equal(providerCalls, atCommit);
    const queueId = send("get_state");
    const state = await waitFor((event) => event.type === "response" && event.id === queueId, from);
    if (providerWrapper) {
      const historyId = send("get_messages");
      const history = await waitFor((event) => event.type === "response" && event.id === historyId, from);
      assert.ok(
        history.data.messages.some(
          (message) => message.role === "user" && message.content.some((block) => block.type === "text" && block.text.includes("Do not lose this queued review.")),
        ),
      );
      assert.ok(events.slice(from).some((event) => event.type === "extension_ui_request" && event.method === "notify"));
      console.log("provider wrapper: post-fence follow-up made no provider request; rejected work remains visible in session history");
    } else {
      assert.equal(state.data.queuedMessageCount, 1);
      console.log(`existing hooks: queued follow-up after fence caused no new provider request; preserved queue count=${state.data.queuedMessageCount}`);
    }
    console.log("existing hooks: candidate probe completed (runtime boundaries only, not durable Alinery acceptance)");
  } finally {
    child.kill("SIGTERM");
    await closed;
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => provider.close(resolve));
  }
}

try {
  if (process.argv.includes("--probe-existing-hooks") || process.argv.includes("--probe-advisor-hook") || process.argv.includes("--probe-background-hook")) {
    await probeExistingHooks();
  } else if (process.argv.includes("--probe-admission")) {
    await probeAdmission();
  } else if (process.argv.includes("--self-test")) {
    await selfTest();
  } else {
    await runOmpSmoke();
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
