// Opt-in, loopback-only probe of unchanged OMP's native tool delegation.
// No Alinery receipt or production interception is implemented by this fixture.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const binary = process.env.OMP_BIN || "/Applications/Alinery.omp/omp";
const probeCancellation = process.argv.includes("--probe-cancellation");
assert.match(execFileSync(binary, ["--version"], { encoding: "utf8" }), /18\.1\.13\b/);
const root = mkdtempSync(path.join(tmpdir(), "alinery-composition-"));
const events = [];
const listeners = new Set();
const held = new Map();
const sockets = new Set();
const checks = [];
let child;
let closed;
let replyTools;
let intentRevision = 0;
let ingressRevision = 0;
let hostSealed = false;
const rejectedInput = [];
let providerCalls = 0;
let finalizationCalls = 0;
let id = 0;
const record = (event) => {
  events.push(event);
  for (const listener of [...listeners]) listener();
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
      reject(new Error(`Missing event; recent=${JSON.stringify(events.slice(-35))}`));
    }, 20000);
    listeners.add(check);
    check();
  });
const release = (key) => {
  const response = held.get(key);
  assert.ok(response, `No held latch ${key}`);
  held.delete(key);
  response.end(JSON.stringify(key === "commit" ? { accepted: true } : {}));
};
const server = createServer(async (request, response) => {
  try {
    let bytes = "";
    for await (const chunk of request) bytes += chunk;
    const body = JSON.parse(bytes || "{}");
    if (request.url === "/trace") {
      record(body);
      response.end("{}");
    } else if (request.url === "/admit") {
      if (body.path === path.join(root, "one")) {
        held.set("admission-one", response);
        record({ type: "admission-held", ...body });
      } else response.end("{}");
    } else if (request.url === "/write-latch") {
      const key = path.basename(body.path);
      held.set(key, response);
      record({ type: "write-held", ...body });
    } else if (request.url === "/unwind-latch") {
      held.set("unwind", response);
      record({ type: "unwind-held", ...body });
    } else if (request.url === "/intent") {
      response.end(JSON.stringify({ revision: intentRevision, ingressRevision }));
    } else if (request.url === "/commit") {
      if (hostSealed || body.ingressRevision !== ingressRevision) {
        response.end(JSON.stringify({ accepted: false }));
        return;
      }
      hostSealed = true;
      finalizationCalls++;
      held.set("commit", response);
      record({ type: "commit-held", ...body });
    } else {
      providerCalls++;
      const tools = replyTools;
      replyTools = undefined;
      record({
        type: "provider",
        number: providerCalls,
        userText: JSON.stringify(body.messages.filter((message) => message.role === "user")),
        tools: tools?.map((tool) => tool.name),
      });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const delta = tools
        ? {
            role: "assistant",
            tool_calls: tools.map((tool, index) => ({
              index,
              id: `call_${providerCalls}_${index}`,
              type: "function",
              function: { name: tool.name, arguments: JSON.stringify(tool.input) },
            })),
          }
        : { role: "assistant", content: "Local composition probe response." };
      response.end(
        `data: ${JSON.stringify({ id: "probe", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "probe", choices: [{ index: 0, delta: {}, finish_reason: tools ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
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
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const extension = path.join(root, "composition.ts");
  writeFileSync(
    extension,
    `
import { AsyncLocalStorage } from "node:async_hooks";
export default function(api) {
  const url = ${JSON.stringify(url)};
  const root = ${JSON.stringify(root)};
  const prepared = new Map();
  const executing = new Map();
  const scope = new AsyncLocalStorage();
  let sealed = false;
  let revision = 0;
  const key = (name, id) => name + ":" + id;
  const post = (route, body) => fetch(url + route, {method:"POST", body:JSON.stringify(body)});
  const trace = body => post("/trace", body);
  const snapshot = () => ({revision,sealed,prepared:[...prepared.values()],executing:[...executing.values()]});
  const completionChain = (name, input) => name === "probe_complete" || (name === "write" && input?.path === "xd://probe_complete");
  api.registerProvider("composition-local", {
    baseUrl:url, apiKey:"loopback-only", api:"openai-completions",
    models:[{id:"probe",name:"probe",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:256}]
  });
  api.on("session_start", async () => {
    const native = api.getAllTools();
    for (const name of ["eval", "write"]) {
      const info = native.find(tool => tool.name === name);
      if (!info) throw new Error("Missing native tool " + name);
      api.registerTool({name,label:info.name,description:info.description,parameters:info.parameters,
        approval:name === "write" ? "write" : "exec",loadMode:"essential",
        // The opt-in batch must admit its sibling without scheduling it early.
        ...(${JSON.stringify(probeCancellation)} && name === "eval" ? {concurrency:"exclusive"} : {}),
        async execute(id, input, signal, onUpdate, ctx) {
          const identity = key(name,id);
          const parent = scope.getStore() ?? null;
          const entry = {name,id,path:input.path,parent};
          executing.set(identity,entry);
          await trace({type:"native-enter",...entry,...snapshot()});
          try {
            if (sealed && !completionChain(name,input)) throw new Error("sealed at execute");
            if (!ctx.invokeTool) throw new Error("Native delegation unavailable");
            return await scope.run({name,id,path:input.path}, async () => {
              if (name === "write" && [root+"/one",root+"/two"].includes(input.path)) await post("/write-latch",{path:input.path,id,parent:scope.getStore()});
              if (sealed && !completionChain(name,input)) throw new Error("sealed before native effect");
              const result = await ctx.invokeTool(input,{signal,onUpdate});
              await trace({type:"native-return",name,id,path:input.path,isError:result.isError ?? false});
              return result;
            });
          } finally {
            executing.delete(identity);
            prepared.delete(identity);
            await trace({type:"native-exit",name,id,path:input.path,...snapshot()});
          }
        }
      });
    }
    await trace({type:"delegation-installed"});
  });
  api.on("before_provider_request", async (_event, ctx) => {
    if (sealed) {
      ctx.abort();
      ctx.ui.notify("Composition probe: work rejected by finalization fence", "error");
      await trace({type:"model-rejected",...snapshot()});
      return;
    }
    revision++;
    await trace({type:"model-admitted",...snapshot()});
  });
  api.on("tool_call", async event => {
    const identity = key(event.toolName,event.toolCallId);
    if (sealed && !completionChain(event.toolName,event.input)) {
      await trace({type:"tool-rejected",name:event.toolName,id:event.toolCallId});
      return {block:true,reason:"finalization fence"};
    }
    if (!completionChain(event.toolName,event.input)) revision++;
    prepared.set(identity,{name:event.toolName,id:event.toolCallId,path:event.input?.path,parent:scope.getStore() ?? null});
    await trace({type:"prepared",name:event.toolName,id:event.toolCallId,path:event.input?.path,...snapshot()});
    await post("/admit",{name:event.toolName,id:event.toolCallId,path:event.input?.path});
    if (sealed && !completionChain(event.toolName,event.input)) {
      prepared.delete(identity);
      return {block:true,reason:"finalization won while admitting"};
    }
  });
  api.on("tool_result", async event => {
    prepared.delete(key(event.toolName,event.toolCallId));
    await trace({type:"result-hook",name:event.toolName,id:event.toolCallId,...snapshot()});
  });
  api.on("tool_execution_end", async event => {
    const identity = key(event.toolName,event.toolCallId);
    if (!executing.has(identity)) prepared.delete(identity);
    await trace({type:"execution-ended",name:event.toolName,id:event.toolCallId,isError:event.isError,...snapshot()});
  });
  api.on("agent_end", async (_event,ctx) => {
    await trace({type:"run-ended",pending:ctx.hasPendingMessages(),...snapshot()});
  });
  api.registerTool({name:"probe_approval",label:"Approval probe",description:"Test denied preparation",parameters:api.zod.z.object({}),approval:"write",
    async execute() {await trace({type:"approval-executed"}); throw new Error("Denied tool executed");}
  });
  api.on("tool_approval_resolved", async event => {await trace({type:"approval-resolved",approved:event.approved,name:event.toolName,...snapshot()});});
  const finalization = {name:"probe_complete",label:"Completion probe",description:"Attempt shared-ledger finalization",parameters:api.zod.z.object({}),
    async execute(id,_input,_signal,_update,ctx) {
      const intent = await (await post("/intent",{})).json();
      // invokeTool creates a fresh native call ID. Only the directly delegated
      // canonical write is an exempt ancestor; an enclosing eval remains owned.
      const parent = scope.getStore();
      const canonicalParent = parent?.name === "write" && parent.path === "xd://probe_complete"
        ? parent.id : undefined;
      const pending = ctx.hasPendingMessages();
      const competing = [...prepared.values(),...executing.values()].filter(entry => entry.id !== id && entry.id !== canonicalParent);
      if (sealed) return {content:[{type:"text",text:"already fenced"}],details:{status:"waiting"}};
      if (competing.length || pending) {
        await trace({type:"completion-waiting",id,pending,competing,intentRevision:intent.revision,...snapshot()});
        return {content:[{type:"text",text:"waiting"}],details:{status:"waiting"}};
      }
      if (intent.revision !== revision) {
        await trace({type:"completion-stale",intentRevision:intent.revision,...snapshot()});
        return {content:[{type:"text",text:"stale"}],details:{status:"stale"}};
      }
      sealed = true;
      await trace({type:"fence-won",...snapshot()});
      const decision = await (await post("/commit",{revision,ingressRevision:intent.ingressRevision})).json();
      if (decision.accepted !== true) {
        if (decision.accepted !== false) throw new Error("Unknown commitment outcome; fence retained");
        sealed = false;
        await trace({type:"completion-stale",reason:"ingress raced finalization",...snapshot()});
        return {content:[{type:"text",text:"stale"}],details:{status:"stale"}};
      }
      await trace({type:"committed",...snapshot()});
      return {content:[{type:"text",text:"committed (simulated only)"}],details:{status:"accepted"}};
    }
  };
  api.registerTool(finalization);
  if (${JSON.stringify(probeCancellation)}) api.registerTool({
    name:"probe_unwind",label:"Cancellation unwind probe",description:"Hold a native eval child through cancellation",parameters:api.zod.z.object({}),
    async execute(id,_input,signal,_update,ctx) {
      const identity = key("probe_unwind",id);
      executing.set(identity,{name:"probe_unwind",id});
      try {
        // Reaching this child proves native eval delegated into its tool bridge.
        // No wrapper-before-invoke latch can produce this event.
        await trace({type:"unwind-child-entered",id,...snapshot()});
        const aborted = Promise.withResolvers();
        if (signal.aborted) aborted.resolve();
        else signal.addEventListener("abort",aborted.resolve,{once:true});
        await aborted.promise;
        await trace({type:"unwind-start",id,aborted:signal.aborted,...snapshot()});
        // Exercise the very same finalization predicate, not a ledger-only
        // approximation. This synthetic attempt exempts neither child nor eval.
        const result = await finalization.execute("cancel-probe-completion",{},undefined,undefined,ctx);
        await trace({type:"unwind-finalization",status:result.details?.status,...snapshot()});
        await post("/unwind-latch",{id});
        return {content:[{type:"text",text:"canceled child unwound"}]};
      } finally {
        executing.delete(identity);
        prepared.delete(identity);
        await trace({type:"unwind-child-settled",id,...snapshot()});
      }
    }
  });
}
`,
  );
  writeFileSync(path.join(root, "config.yml"), "tools:\n  approval:\n    probe_approval: prompt\n");
  child = spawn(
    binary,
    [
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "--tools",
      "write,eval",
      "--no-lsp",
      "--no-title",
      "--extension",
      extension,
      "--model",
      "composition-local/probe",
      "--thinking",
      "off",
      "--config",
      path.join(root, "config.yml"),
    ],
    {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_CONFIG_DIR: path.join(root, "config") },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  closed = new Promise((resolve) => child.once("close", resolve));
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const event = JSON.parse(line);
        if (["response", "extension_ui_request", "extension_error"].includes(event.type)) record(event);
        else if (["ready", "agent_end"].includes(event.type)) record({ type: event.type, isTerminal: event.isTerminal });
        if (event.type === "extension_ui_request" && event.method === "select") {
          child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, value: "Deny" })}\n`);
        }
      } catch {
        record({ type: "stdout", line });
      }
    }
  });
  child.stderr.on("data", (chunk) => record({ type: "stderr", text: String(chunk) }));
  const send = (type, extra = {}) => {
    if (["prompt", "steer", "follow_up", "abort_and_prompt"].includes(type)) {
      if (hostSealed) {
        const retained = { type, ...extra };
        rejectedInput.push(retained);
        record({ type: "ingress-rejected", retained, reason: "Session is finishing; input retained without RPC dispatch" });
        return null;
      }
      ingressRevision++;
    }
    const requestId = `composition-${++id}`;
    child.stdin.write(`${JSON.stringify({ id: requestId, type, ...extra })}\n`);
    return requestId;
  };
  const responseTo = (requestId) => waitFor((event) => event.type === "response" && event.id === requestId);
  await waitFor((event) => event.type === "ready");
  await waitFor((event) => event.type === "delegation-installed");

  let cancellation;
  if (probeCancellation) {
    const from = events.length;
    const marker = path.join(root, "canceled-native-marker");
    const skipped = path.join(root, "canceled-batch-sibling");
    replyTools = [
      { name: "eval", input: { language: "js", code: `await tool.probe_unwind({}); await tool.write({path:${JSON.stringify(marker)},content:"late native write"});` } },
      { name: "write", input: { path: skipped, content: "skipped sibling ran" } },
    ];
    send("prompt", { message: "Enter native eval, then cancel its pre-admitted batch during child unwind." });
    const preparedSibling = await waitFor((event) => event.type === "prepared" && event.path === skipped, from);
    const enteredEval = await waitFor((event) => event.type === "native-enter" && event.name === "eval", from);
    const enteredChild = await waitFor((event) => event.type === "unwind-child-entered", from);
    assert.ok(enteredChild.executing.some((entry) => entry.id === enteredEval.id));
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(skipped), false);
    // Arm a fresh intent so stale-intent rejection cannot mask early release.
    const armUnwind = () => {
      const event = events.slice(from).find((event) => event.type === "unwind-start");
      if (event) {
        intentRevision = event.revision;
        listeners.delete(armUnwind);
      }
    };
    listeners.add(armUnwind);
    const abortId = send("abort");
    await waitFor((event) => event.type === "unwind-start" && event.aborted, from);
    const attempt = await waitFor((event) => event.type === "unwind-finalization", from);
    await waitFor((event) => event.type === "unwind-held", from);
    assert.equal(attempt.status, "waiting", "Finalization must actually reject while native child is unwinding");
    const waiting = await waitFor((event) => event.type === "completion-waiting" && event.id === "cancel-probe-completion", from);
    assert.ok(
      waiting.competing.some((entry) => entry.id === enteredChild.id),
      "Finalization must count the live native-dispatched child",
    );
    assert.equal(finalizationCalls, 0);
    // Eval may reject on abort before its native bridge child unwinds. Its
    // return is diagnostic, not proof that the still-entered child settled.
    const evalReturnedDuringUnwind = events.slice(from).some((event) => event.type === "native-exit" && event.id === enteredEval.id);
    assert.ok(
      attempt.executing.some((entry) => entry.id === enteredChild.id),
      "Entered child reservation released before unwind",
    );
    assert.equal(
      events.slice(from).some((event) => event.type === "unwind-child-settled"),
      false,
    );
    checks.push("cancellation-finalization-waits-during-native-unwind");
    release("unwind");
    const childSettled = await waitFor((event) => event.type === "unwind-child-settled" && event.id === enteredChild.id, from);
    const settled = await waitFor((event) => event.type === "native-exit" && event.id === enteredEval.id, from);
    const skippedEnd = await waitFor((event) => event.type === "execution-ended" && event.id === preparedSibling.id, from);
    assert.equal(
      events.slice(from).some((event) => event.type === "native-enter" && event.id === preparedSibling.id),
      false,
    );
    const reconciled = [childSettled, settled, skippedEnd].sort((a, b) => events.indexOf(b) - events.indexOf(a))[0];
    assert.equal(reconciled.prepared.length, 0, "Canceled prepared sibling leaked its reservation");
    assert.equal(reconciled.executing.length, 0);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(skipped), false);
    // ACK and agent_end are only RPC/run barriers, never settlement evidence.
    await responseTo(abortId);
    await waitFor((event) => event.type === "run-ended", from);
    cancellation = {
      enteredEval: enteredEval.id,
      enteredChild: enteredChild.id,
      skippedSibling: preparedSibling.id,
      evalReturnedDuringUnwind,
      settledRevision: settled.revision,
      marker,
      skipped,
      events: events.slice(from),
    };
    intentRevision = 0;
    checks.push("cancellation-settles-native-work-without-skipped-reservation-leak");
    // Preserve cancellation evidence separately; the original eight checks
    // intentionally inspect their own complete event history.
    events.length = 0;
  }
  // Work wins: native eval owns floated child calls; completion must not exempt it.
  replyTools = [
    {
      name: "eval",
      input: {
        language: "js",
        code: `const first = tool.write({path:${JSON.stringify(path.join(root, "one"))},content:"one"}); void tool.write({path:${JSON.stringify(path.join(root, "two"))},content:"two"}); await tool.write({path:"xd://probe_complete",content:"{}"}); await first; await tool.write({path:${JSON.stringify(path.join(root, "body-ended"))},content:"body ended"});`,
      },
    },
  ];
  send("prompt", { message: "Run the local nested composition scenario." });
  await waitFor((event) => event.type === "admission-held");
  await waitFor((event) => event.type === "write-held" && event.path === path.join(root, "two"));
  const nested = await waitFor((event) => event.type === "completion-waiting");
  assert.ok(nested.competing.some((entry) => entry.name === "eval"));
  assert.equal(existsSync(path.join(root, "one")), false);
  assert.equal(existsSync(path.join(root, "two")), false);
  assert.equal(finalizationCalls, 0);
  checks.push("nested-completion-waits-without-ancestor-deadlock");
  const review = "REVIEW_BEFORE_FENCE";
  await responseTo(send("follow_up", { message: review }));
  const state = await responseTo(send("get_state"));
  assert.equal(state.data.queuedMessageCount, 1);
  release("admission-one");
  await waitFor((event) => event.type === "write-held" && event.path === path.join(root, "one"));
  assert.equal(existsSync(path.join(root, "one")), false);
  checks.push("admission-before-native-write");
  release("one");
  await waitFor((event) => event.type === "native-return" && event.path === path.join(root, "body-ended"));
  assert.equal(existsSync(path.join(root, "body-ended")), true);
  assert.equal(existsSync(path.join(root, "two")), false);
  assert.equal(
    events.some((event) => event.type === "native-exit" && event.name === "eval"),
    false,
  );
  checks.push("floated-child-keeps-native-eval-reservation");
  release("two");
  await waitFor((event) => event.type === "native-exit" && event.name === "eval");
  assert.equal(readFileSync(path.join(root, "one"), "utf8"), "one");
  assert.equal(readFileSync(path.join(root, "two"), "utf8"), "two");
  await waitFor((event) => event.type === "provider" && event.userText.includes(review));
  await waitFor((event) => event.type === "run-ended" && !event.pending && event.prepared.length === 0 && event.executing.length === 0);
  checks.push("queued-review-survives-and-runs-before-finalization");

  // Worker callbacks may retain their creation-time async scope. The ledger
  // deliberately does not trust this diagnostic parent for eval exemptions.
  let from = events.length;
  replyTools = [
    {
      name: "eval",
      input: {
        language: "js",
        code: `await tool.write({path:"xd://probe_complete",content:"{}"}); await tool.write({path:${JSON.stringify(path.join(root, "reused"))},content:"reused"});`,
      },
    },
  ];
  send("prompt", { message: "Reuse the native eval kernel and attempt nested completion." });
  const reusedEval = await waitFor((event) => event.type === "native-enter" && event.name === "eval", from);
  const reusedWaiting = await waitFor((event) => event.type === "completion-waiting", from);
  assert.ok(reusedWaiting.competing.some((entry) => entry.name === "eval" && entry.id === reusedEval.id));
  const reusedChild = await waitFor((event) => event.type === "prepared" && event.path === path.join(root, "reused"), from);
  const reusedParent = reusedChild.prepared.find((entry) => entry.id === reusedChild.id)?.parent ?? null;
  await waitFor((event) => event.type === "run-ended" && !event.pending && event.prepared.length === 0 && event.executing.length === 0, from);
  assert.equal(readFileSync(path.join(root, "reused"), "utf8"), "reused");
  assert.equal(finalizationCalls, 0);
  checks.push("reused-kernel-keeps-current-eval-owned");

  // A native approval refusal occurs after preparation but before execute.
  from = events.length;
  replyTools = [{ name: "probe_approval", input: {} }];
  send("prompt", { message: "Exercise native denied approval." });
  await waitFor((event) => event.type === "prepared" && event.name === "probe_approval", from);
  await waitFor((event) => event.type === "approval-resolved" && event.name === "probe_approval" && !event.approved, from);
  await waitFor((event) => event.type === "run-ended" && !event.pending && event.prepared.length === 0 && event.executing.length === 0, from);
  assert.equal(
    events.some((event) => event.type === "approval-executed"),
    false,
  );
  checks.push("prepared-native-approval-denial-does-not-leak-reservation");

  // The old simulated intent cannot authorize newer review work.
  from = events.length;
  replyTools = [{ name: "write", input: { path: "xd://probe_complete", content: "{}" } }];
  send("prompt", { message: "Try the old continuation revision." });
  const stale = await waitFor((event) => event.type === "completion-stale", from);
  assert.ok(stale.revision > stale.intentRevision);
  assert.equal(finalizationCalls, 0);
  await waitFor((event) => event.type === "run-ended" && !event.pending && event.prepared.length === 0 && event.executing.length === 0, from);
  checks.push("old-simulated-intent-cannot-authorize-new-revision");

  // Fence wins: arm exact current revision once the primary request is admitted.
  from = events.length;
  const arm = () => {
    const admitted = events.slice(from).find((event) => event.type === "model-admitted");
    if (admitted) {
      intentRevision = admitted.revision;
      listeners.delete(arm);
    }
  };
  listeners.add(arm);
  replyTools = [{ name: "write", input: { path: "xd://probe_complete", content: "{}" } }];
  send("prompt", { message: "Attempt fresh canonical completion." });
  const commit = await waitFor((event) => event.type === "commit-held", from);
  assert.equal(commit.revision, intentRevision);
  const beforeFenceCalls = providerCalls;
  const lateReview = "REVIEW_AFTER_FENCE";
  assert.equal(send("follow_up", { message: lateReview }), null);
  const fencedState = await responseTo(send("get_state"));
  assert.equal(fencedState.data.queuedMessageCount, 0);
  release("commit");
  await waitFor((event) => event.type === "committed", from);
  await waitFor((event) => event.type === "model-rejected", from);
  await waitFor((event) => event.type === "agent_end", from);
  const messages = await responseTo(send("get_messages"));
  assert.equal(JSON.stringify(messages.data).includes(lateReview), false, "Rejected input was incorrectly dispatched");
  assert.deepEqual(rejectedInput, [{ type: "follow_up", message: lateReview }]);
  assert.ok(events.some((event) => event.type === "ingress-rejected" && event.retained.message === lateReview));
  assert.equal(providerCalls, beforeFenceCalls);
  assert.equal(finalizationCalls, 1);
  assert.ok(events.slice(from).some((event) => event.type === "extension_ui_request" && event.method === "notify" && String(event.message).includes("rejected")));
  checks.push("winning-fence-blocks-next-provider-and-preserves-input");
  if (cancellation) {
    assert.equal(existsSync(cancellation.marker), false, "Canceled native marker appeared after settlement");
    assert.equal(existsSync(cancellation.skipped), false);
    checks.push("cancellation-recovers-permitted-work-and-fresh-finalization-without-late-write");
  }
  const children = events.filter((event) => event.type === "prepared" && [path.join(root, "one"), path.join(root, "two")].includes(event.path));
  console.log(
    JSON.stringify(
      {
        status: "passed",
        scope: "local-runtime-composition-not-production",
        checks,
        cancellation,
        nestedChildScopes: children.map((event) => ({ path: path.basename(event.path), parent: event.prepared.find((entry) => entry.id === event.id)?.parent ?? null })),
        reusedKernelAncestry: { currentEval: reusedEval.id, observedParent: reusedParent, matchesCurrent: reusedParent?.id === reusedEval.id, usedForEvalExemption: false },
        approvalResultHookObserved: events.some((event) => event.type === "result-hook" && event.name === "probe_approval"),
        rejectedInputRetained: "exact-text-at-external-ingress-not-dispatched",
        providerCalls,
        finalizationCalls,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(JSON.stringify({ status: "failed", checks, error: String(error), recent: events.slice(-50) }, null, 2));
  process.exitCode = 1;
} finally {
  for (const response of held.values()) response.destroy();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(deadline);
  }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
