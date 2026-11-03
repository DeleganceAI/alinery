// OMP extension isolated callback tests.
// Run: node --test runner/assets/omp-extension.test.mjs (from alinery-app/src-tauri)
//
// Loads omp-extension.ts via the typescript dev dependency (compile in memory to a
// data URL) so the test executes the real module without a loader/framework. No test
// framework or third-party dependency is added; node:test is used throughout.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------- compile omp-extension.ts in memory ----------

// Locate the typescript package by walking up from the test file's directory.
// Works in both the main checkout (alinery-app/node_modules) and a git worktree
// that shares node_modules from the main repo.
function findNodeModulesDir(start) {
  let dir = start;
  while (true) {
    const candidate = path.join(dir, "node_modules", "typescript", "lib", "typescript.js");
    if (existsSync(candidate)) return path.join(dir, "node_modules");
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Could not find node_modules/typescript from ${start}`);
    dir = parent;
  }
}

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const nodeModulesDir = findNodeModulesDir(thisDir);
const requireFromNodeModules = createRequire(path.join(nodeModulesDir, "dummy.js"));
const ts = requireFromNodeModules("typescript");

const src = readFileSync(new URL("./omp-extension.ts", import.meta.url), "utf8");

const result = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
  },
  fileName: "omp-extension.ts",
});

if (result.diagnostics && result.diagnostics.length > 0) {
  for (const d of result.diagnostics) {
    process.stderr.write(`TypeScript error: ${d.messageText}\n`);
  }
  process.exit(1);
}

const dataUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(result.outputText)}`;

// Dynamic import is used here because the module specifier is runtime-computed
// (a data URL containing the in-memory compiled source). This is a test-only path.
const ext = await import(dataUrl);
const { registerCallbacks } = ext;

// ---------- fake OMP API factory ----------

function makeFakeApi() {
  const handlers = {};
  const tools = {};

  return {
    zod: {
      z: {
        object(shape) {
          return { shape };
        },
        string() {
          return { type: "string" };
        },
      },
    },
    on(event, handler) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    registerTool(tool) {
      tools[tool.name] = tool;
    },
    async trigger(event, payload, context = makeContext("omp-sess-event")) {
      const hs = handlers[event] ?? [];
      let result;
      for (const h of hs) result = await h(payload, context);
      return result;
    },
    async callTool(name, input, context, signal, onUpdate) {
      const tool = tools[name];
      if (!tool) throw new Error(`tool not registered: ${name}`);
      return tool.execute("tool-call-1", input, signal, onUpdate, context);
    },
    getRegisteredEvents() {
      return Object.keys(handlers);
    },
    getRegisteredTools() {
      return Object.keys(tools);
    },
    getToolSchema(name) {
      return tools[name];
    },
  };
}

function makeContext(sessionId, cwd = process.cwd()) {
  return {
    cwd,
    shutdown() {},
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

// Collect passive lifecycle events.
function makeRecordingEmitter() {
  const emitted = [];
  /** @param {unknown} event */
  const emit = async (event) => {
    emitted.push(event);
  };
  emit.emitted = emitted;
  return emit;
}

function makeCompletionEmitter(emit, outcome = { status: "accepted", receipt_id: "receipt-1" }) {
  return async (event) => {
    emit.emitted.push(event);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
}

test("manual_ready_and_waiting_do_not_confirm_or_shutdown", async () => {
  for (const outcome of [
    { status: "ready", ready_revision: 7 },
    { status: "requested", ready_revision: 7 },
    { status: "waiting", reason: "native invocation remains active" },
    { status: "stale", reason: "review superseded readiness" },
    { status: "invalid_outputs", diagnostics: ["report is empty"] },
    { status: "unavailable", reason: "primary receiver not bound" },
    { status: "accepted", receipt_id: "immutable-receipt" },
  ]) {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    let shutdowns = 0;
    let confirmations = 0;
    const context = {
      ...makeContext("same-owner"),
      shutdown() {
        shutdowns++;
      },
      ui: {
        async confirm() {
          confirmations++;
          return true;
        },
      },
    };
    registerCallbacks(api, emit, makeCompletionEmitter(emit, outcome), undefined);
    const first = await api.callTool("alinery_phase_complete", {}, context);
    assert.deepEqual(first.details, outcome);
    assert.equal(confirmations, 0);
    assert.equal(shutdowns, outcome.status === "accepted" ? 1 : 0);
    const replay = await api.callTool("alinery_phase_complete", {}, context);
    assert.deepEqual(replay.details, outcome);
    assert.equal(shutdowns, outcome.status === "accepted" ? 1 : 0);
  }
});

function nativeFixture(toolExecute = async () => ({ content: [], details: {} }), complete, authorize) {
  const api = makeFakeApi();
  const context = makeContext("native-owner");
  const events = [];
  const listeners = [];
  const hooks = [];
  const follow = [];
  const steer = [];
  const jobs = new Map();
  let releaseRun;
  let run = Promise.resolve();
  const native = {
    name: "write",
    label: "write",
    description: "native",
    parameters: { native: true },
    concurrency: "exclusive",
    approval: () => "native-approval",
    execute: toolExecute,
  };
  const nativeContext = {
    toolCall: { toolCallId: "native-batch", isLastInBatch: true },
    settings: { nativeSetting: "preserved" },
    providerSafetyApproved: true,
  };
  class Session {
    sessionManager = context.sessionManager;
    asyncJobManager = {
      register(_type, _label, run) {
        const id = `job-${jobs.size + 1}`;
        const controller = new AbortController();
        const job = { ownerId: "native-owner", status: "running", controller };
        job.promise = Promise.resolve()
          .then(() => run({ signal: controller.signal }))
          .then((result) => {
            if (job.status !== "cancelled") job.status = "completed";
            return result;
          });
        jobs.set(id, job);
        return id;
      },
      getJob(id) {
        return jobs.get(id);
      },
      cancel(id) {
        const job = jobs.get(id);
        if (job) {
          job.status = "cancelled";
          job.controller.abort();
        }
      },
      async drainDeliveries() {
        return true;
      },
      isDeliverySuppressed() {
        return false;
      },
    };
    yieldQueue = {
      drainLazy() {
        return [];
      },
    };
    agent = {
      async prompt(message) {
        for (const listener of listeners) listener({ type: "message_start", message });
        await run;
      },
      async continue() {
        for (const hook of hooks) await hook();
        const message = steer.shift() ?? follow.shift();
        if (message) for (const listener of listeners) listener({ type: "message_start", message });
        await run;
      },
      steer(message) {
        steer.push(message);
      },
      followUp(message) {
        follow.push(message);
      },
      subscribe(fn) {
        listeners.push(fn);
        return () => {};
      },
      addBeforeQueuedMessageDequeueHook(fn) {
        hooks.push(fn);
        return () => {};
      },
      peekSteeringQueue() {
        return steer;
      },
      peekFollowUpQueue() {
        return follow;
      },
      waitForIdle() {
        return run;
      },
      replaceQueues(nextSteer, nextFollow) {
        steer.splice(0, steer.length, ...nextSteer);
        follow.splice(0, follow.length, ...nextFollow);
      },
    };
    get extensionRunner() {
      return {};
    }
    getToolByName(name) {
      return name === "write" ? native : undefined;
    }
    hasBuiltInTool(name) {
      return name === "write";
    }
  }
  for (const name of ext.SELECTED_SESSION_METHODS) Session.prototype[name] = async () => {};
  Session.prototype.prompt = async function (text) {
    await this.agent.prompt({ role: "user", content: [{ type: "text", text }] });
  };
  Session.prototype.followUp = async function (text) {
    this.agent.followUp({ role: "user", content: [{ type: "text", text }] });
  };
  const session = new Session();
  api.pi = { AgentSession: Session };
  api.getAllTools = () => [{ name: "write" }];
  let revision = 0;
  let intent = null;
  let capabilityRevision = 0;
  let available = false;
  let reason = "not bound";
  const activeNative = new Set();
  const pollWaiters = [];
  const control = async (event) => {
    const authoritative = await authorize?.(event);
    events.push(event);
    if (authoritative) {
      if ("process_incarnation" in authoritative) {
        capabilityRevision = authoritative.capability_revision;
        revision = authoritative.work_revision;
        intent = authoritative.continuation_requested_revision;
        available = authoritative.available;
        reason = authoritative.reason;
      }
      return authoritative;
    }
    if (event.type === "continuation_bind" || event.type === "continuation_revoke") {
      if (event.expected_capability_revision !== capabilityRevision) throw new ext.NativeControlRejected("stale capability revision");
      capabilityRevision++;
      if (event.type === "continuation_bind") {
        available = true;
        reason = null;
      } else {
        revision++;
        available = false;
        reason = event.reason;
      }
    }
    if (event.type === "native_work_entered") {
      if (event.parent_operation_id && !activeNative.has(event.parent_operation_id)) throw new ext.NativeControlRejected("stale native parent");
      if (!available && !event.parent_operation_id && !event.dispatch_proof) throw new ext.NativeControlRejected("native root unavailable");
      activeNative.add(event.operation_id);
      revision++;
    }
    if (event.type === "native_work_settled") activeNative.delete(event.operation_id);
    if (event.type === "continuation_poll") for (const resolve of pollWaiters.splice(0)) resolve();
    return {
      process_incarnation: "native-incarnation",
      capability_revision: capabilityRevision,
      work_revision: revision,
      continuation_requested_revision: intent,
      available,
      reason,
    };
  };
  const adapter = new ext.NativeContinuation(
    api,
    control,
    complete ??
      (async (event) => {
        events.push(event);
        return event.type === "continuation_finalize" ? { status: "accepted", receipt_id: "receipt" } : { status: "ready", ready_revision: revision };
      }),
  );
  void session.extensionRunner;
  return {
    api,
    context,
    nativeContext,
    events,
    session,
    native,
    adapter,
    capability() {
      return { available, capabilityRevision, revision, intent, pending: [...activeNative] };
    },
    async consume() {
      run = new Promise((resolve) => {
        releaseRun = resolve;
      });
      for (const hook of hooks) await hook();
      const message = follow.shift();
      for (const listener of listeners) listener({ type: "message_start", message });
      return () => releaseRun();
    },
    request() {
      intent = revision;
    },
    nextPoll() {
      return new Promise((resolve) => pollWaiters.push(resolve));
    },
  };
}

test("does_not_poll_continuation_during_initial_work_before_ready", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  let started;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const fixture = nativeFixture();
  fixture.session.prompt = async () => {
    started();
    await held;
  };
  await fixture.adapter.bind(fixture.context);
  const startupPolls = fixture.events.filter((event) => event.type === "continuation_poll").length;
  const work = fixture.session.prompt("ordinary initial work, no readiness report");
  try {
    await entered;
    context.mock.timers.runAll();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      fixture.events.filter((event) => event.type === "continuation_poll").length,
      startupPolls,
      "startup bootstrap is allowed; initial work must not start a periodic control loop",
    );
  } finally {
    release();
    await work;
    await fixture.adapter.invalidate("fixture disposed");
  }
});

test("cached_canonical_native_tool_reference_is_admitted_before_effects", async () => {
  let fixture;
  fixture = nativeFixture(async () => {
    assert.equal((await fixture.adapter.ready(fixture.context)).status, "waiting", "cached native calls must retain their selected lifetime");
    return { content: [], details: {} };
  });
  const cachedNative = fixture.session.getToolByName("write");
  await fixture.adapter.bind(fixture.context);
  await cachedNative.execute("cached-call", {}, undefined, undefined, fixture.nativeContext);
});

test("changed_canonical_native_handle_revokes_continuation_before_new_effects", async () => {
  let acknowledge;
  const ack = new Promise((resolve) => {
    acknowledge = resolve;
  });
  const fixture = nativeFixture(undefined, undefined, async (event) => {
    if (event.type === "continuation_revoke") await ack;
  });
  let effects = 0;
  fixture.session.prompt = async () => {
    effects++;
  };
  await fixture.adapter.bind(fixture.context);
  const replaced = {
    ...fixture.native,
    execute: async () => {
      effects++;
      return { content: [], details: {} };
    },
  };
  fixture.session.getToolByName = () => replaced;
  const outcome = await fixture.adapter.ready(fixture.context);
  assert.equal(outcome.status, "unavailable");
  assert.match(outcome.reason, /Native execution boundary changed for write/);
  await assert.rejects(() => fixture.session.prompt("do not run under the obsolete binding"), /Native execution boundary changed/);
  assert.equal(effects, 0);
  acknowledge();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.capability().available, false, "changed required identity revokes the authoritative capability");
});

test("settled_public_model_change_rebinds_new_handles_without_losing_cached_lifetimes", async () => {
  let releaseOld;
  let enteredOld;
  const heldOld = new Promise((resolve) => {
    releaseOld = resolve;
  });
  const oldEntered = new Promise((resolve) => {
    enteredOld = resolve;
  });
  let fixture;
  fixture = nativeFixture(async () => {
    enteredOld();
    assert.equal((await fixture.adapter.ready(fixture.context)).status, "waiting");
    await heldOld;
    return { content: [], details: {} };
  });
  const cachedOld = fixture.native;
  const replacement = {
    ...cachedOld,
    execute: async () => {
      assert.equal((await fixture.adapter.ready(fixture.context)).status, "waiting", "new native handle must enter the same owner ledger");
      return { content: [], details: {} };
    },
  };
  let current = cachedOld;
  fixture.session.getToolByName = () => current;
  fixture.session.setModel = async () => {
    current = replacement;
    return { switched: true };
  };
  await fixture.adapter.bind(fixture.context);
  const oldCall = cachedOld.execute("old", {}, undefined, undefined, fixture.nativeContext);
  await oldEntered;
  assert.deepEqual(await fixture.session.setModel({ id: "next-model" }), { switched: true });
  assert.equal((await fixture.adapter.ready(fixture.context)).status, "waiting", "model settlement must not erase the still-live old native call");
  releaseOld();
  await oldCall;
  await replacement.execute("new", {}, undefined, undefined, fixture.nativeContext);
  await cachedOld.execute("cached-after-switch", {}, undefined, undefined, fixture.nativeContext);
  assert.equal((await fixture.adapter.ready(fixture.context)).status, "ready");
});

test("model_rebind_failure_preserves_the_native_result_or_error", async () => {
  for (const fails of [false, true]) {
    const fixture = nativeFixture();
    const nativeError = new Error("native model selection rejected");
    const nativeResult = { switched: true };
    fixture.session.setModel = async () => {
      fixture.session.getToolByName = () => undefined;
      if (fails) throw nativeError;
      return nativeResult;
    };
    await fixture.adapter.bind(fixture.context);
    if (fails)
      await assert.rejects(
        () => fixture.session.setModel({ id: "unsupported" }),
        (error) => error === nativeError,
      );
    else assert.equal(await fixture.session.setModel({ id: "changed" }), nativeResult);
    assert.equal((await fixture.adapter.ready(fixture.context)).status, "unavailable");
    assert.equal(fixture.capability().available, false);
  }
});

test("external_abort_cannot_reuse_pre_abort_deferred_readiness_after_unwind", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  let entered;
  const unwind = new Promise((resolve) => {
    release = resolve;
  });
  const running = new Promise((resolve) => {
    entered = resolve;
  });
  let fixture;
  fixture = nativeFixture(async () => {
    assert.equal((await fixture.adapter.ready(fixture.context)).status, "waiting");
    entered();
    await unwind;
    return { content: [], details: {} };
  });
  fixture.session.abort = async () => {
    await unwind;
  };
  await fixture.adapter.bind(fixture.context);
  const work = fixture.session.getToolByName("write").execute("held", {}, undefined, undefined, fixture.nativeContext);
  await running;
  const aborted = fixture.session.abort();
  release();
  await Promise.all([work, aborted]);
  try {
    context.mock.timers.runAll();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      fixture.events.some((event) => event.type === "readiness_reported"),
      false,
      "cancellation invalidates the earlier deferred completion report",
    );
    assert.equal((await fixture.adapter.ready(fixture.context)).status, "ready", "a new explicit report after unwind remains available");
  } finally {
    await fixture.adapter.invalidate("fixture disposed");
  }
});

for (const route of ["idle-prompt", "streaming-thunk", "failed-streaming-thunk"]) {
  test(`selected_job_delivery_keeps_${route}_owned_after_body_and_receipt`, async () => {
    let releaseBody;
    let releaseReceipt;
    let releaseRun;
    let rejectRun;
    const body = new Promise((resolve) => {
      releaseBody = resolve;
    });
    const receipt = new Promise((resolve) => {
      releaseReceipt = resolve;
    });
    const run = new Promise((resolve, reject) => {
      releaseRun = resolve;
      rejectRun = reject;
    });
    let jobId;
    let fixture;
    fixture = nativeFixture(async () => {
      jobId = fixture.session.asyncJobManager.register("eval", "selected producer", async () => {
        await body;
      });
      return { content: [], details: { async: { state: "running", jobId } } };
    });
    const message = { role: "custom", customType: "async-result", details: { jobs: [] }, content: "native result" };
    const thunkReceiver = {};
    fixture.session.yieldQueue.drainLazy = () => [
      function () {
        assert.equal(this, thunkReceiver, "native thunk receiver must be preserved");
        return message;
      },
    ];
    fixture.session.agent.waitForIdle = () => run;
    fixture.session.agent.prompt = async () => {
      await run;
    };
    fixture.session.asyncJobManager.drainDeliveries = async ({ filter }) => {
      assert.equal(filter.ownerId, "native-owner");
      await receipt;
      return true;
    };
    try {
      await fixture.adapter.bind(fixture.context);
      await fixture.session.getToolByName("write").execute("producer", {}, undefined, undefined, fixture.nativeContext);
      message.details.jobs.push({ jobId });
      releaseBody();
      await fixture.session.asyncJobManager.getJob(jobId).promise;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await fixture.adapter.ready(fixture.context)).status, "waiting", "body settlement does not erase pending native delivery");
      let injected;
      if (route === "idle-prompt") injected = fixture.session.agent.prompt(message);
      else assert.equal(fixture.session.yieldQueue.drainLazy()[0].call(thunkReceiver), message);
      releaseReceipt();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await fixture.adapter.ready(fixture.context)).status, "waiting", "a native receipt is not settlement of its consuming run");
      if (route === "failed-streaming-thunk") {
        const failure = new Error("native consuming run failed");
        const observed = assert.rejects(run, (error) => error === failure);
        rejectRun(failure);
        await observed;
      } else {
        releaseRun();
        await (injected ?? run);
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await fixture.adapter.ready(fixture.context)).status, "ready");
    } finally {
      releaseBody();
      releaseReceipt();
      releaseRun();
      await new Promise((resolve) => setImmediate(resolve));
      await fixture.adapter.invalidate("fixture disposed");
    }
  });
}

test("nested_completion_waits_for_the_actual_native_return_and_queue_run", async () => {
  let fixture;
  let releaseTool;
  const toolLatch = new Promise((resolve) => {
    releaseTool = resolve;
  });
  fixture = nativeFixture(async () => {
    const outcome = await fixture.adapter.ready(fixture.context);
    assert.equal(outcome.status, "waiting");
    await toolLatch;
    return { content: [{ type: "text", text: "late native write complete" }], details: {} };
  });
  await fixture.adapter.bind(fixture.context);
  const wrapped = fixture.session.getToolByName("write");
  assert.equal(wrapped.parameters, fixture.native.parameters);
  assert.equal(wrapped.approval(), "native-approval");
  const pending = wrapped.execute("tool", {}, undefined, undefined, fixture.nativeContext);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    fixture.events.some((event) => event.type === "readiness_reported"),
    false,
  );
  releaseTool();
  await pending;
  await fixture.session.followUp('\u001eALINERY:{"id":"review","proof":"review-proof"}\u001fexact review');
  assert.equal((await fixture.adapter.ready(fixture.context)).status, "waiting");
  const releaseRun = await fixture.consume();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await fixture.adapter.ready(fixture.context)).status, "waiting");
  releaseRun();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await fixture.adapter.ready(fixture.context)).status, "ready");
  assert.ok(fixture.events.some((event) => event.type === "native_dispatch_consumed" && event.dispatch_id === "review"));
});

test("canonical_native_execution_preserves_signal_and_error_identity", async () => {
  const failure = new Error("native failure");
  const abort = new AbortController();
  const fixture = nativeFixture(async (_id, _input, signal) => {
    assert.equal(signal, abort.signal);
    throw failure;
  });
  await fixture.adapter.bind(fixture.context);
  const wrapped = fixture.session.getToolByName("write");
  await assert.rejects(
    () => wrapped.execute("id", {}, abort.signal, undefined, fixture.nativeContext),
    (error) => error === failure,
  );
});

test("canonical_native_execution_preserves_batch_and_provider_context", async () => {
  const progress = [];
  const abort = new AbortController();
  const fixture = nativeFixture(async (_id, _input, signal, onUpdate, context) => {
    assert.equal(signal, abort.signal);
    assert.equal(context.toolCall?.toolCallId, "native-batch", "native batching must retain the original AgentToolContext");
    assert.equal(context.providerSafetyApproved, true, "native approval must not receive an ExtensionContext substitute");
    onUpdate({ content: [{ type: "text", text: "native progress" }], details: {} });
    return { content: [{ type: "text", text: context.settings.nativeSetting }], details: { batchFlushed: context.toolCall.isLastInBatch } };
  });
  await fixture.adapter.bind(fixture.context);
  const result = await fixture.session.getToolByName("write").execute("outer-call", {}, abort.signal, (update) => progress.push(update), fixture.nativeContext);
  assert.deepEqual(result.details, { batchFlushed: true });
  assert.equal(result.content[0].text, "preserved");
  assert.equal(progress[0].content[0].text, "native progress");
  await fixture.adapter.invalidate("unaccepted session transition");
  const afterDisposal = await fixture.session.getToolByName("write").execute("after-disposal", {}, abort.signal, (update) => progress.push(update), fixture.nativeContext);
  assert.deepEqual(afterDisposal.details, { batchFlushed: true });
  assert.equal(progress.length, 2, "deactivated native execution retains the original caller context");
});

test("ambiguous_finalization_remains_fenced_until_receipt_replay", async () => {
  let entered;
  const finalizing = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const acknowledgement = new Promise((resolve) => {
    release = resolve;
  });
  let finalizations = 0;
  let postShutdownPoll = false;
  const fixture = nativeFixture(
    undefined,
    async (event) => {
      if (event.type === "readiness_reported") return { status: "requested", ready_revision: 0 };
      finalizations++;
      entered();
      await acknowledgement;
      return { status: "accepted", receipt_id: "one-replayed-receipt" };
    },
    (event) => {
      if (event.type === "continuation_poll" && shutdowns === 1) postShutdownPoll = true;
    },
  );
  let shutdowns = 0;
  fixture.context.shutdown = () => {
    shutdowns++;
  };
  await fixture.adapter.bind(fixture.context);
  await fixture.adapter.ready(fixture.context);
  fixture.request();
  const deadline = setTimeout(() => assert.fail("finalization was never entered"), 5000);
  try {
    await finalizing;
    await assert.rejects(() => fixture.session.prompt("losing review"), /finishing/);
    assert.equal(shutdowns, 0);
    assert.equal(finalizations, 1);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdowns, 1);
    assert.equal(finalizations, 1);
    assert.equal(postShutdownPoll, true, "idle RPC shutdown gets a native input-loop wake only after shutdown was requested");
  } finally {
    clearTimeout(deadline);
  }
});

test("accepted_shutdown_keeps_native_tool_and_public_entry_fenced_until_exit", async () => {
  let toolEffects = 0;
  let promptEffects = 0;
  const fixture = nativeFixture(
    async () => {
      toolEffects++;
      return { content: [], details: {} };
    },
    async () => ({ status: "accepted", receipt_id: "immutable-receipt" }),
  );
  fixture.session.prompt = async () => {
    promptEffects++;
    return true;
  };
  await fixture.adapter.bind(fixture.context);
  registerCallbacks(fixture.api, makeRecordingEmitter(), async () => assert.fail("wrong completion transport"), undefined, undefined, undefined, undefined, fixture.adapter);
  let shutdownLifecycle;
  fixture.context.shutdown = () => {
    shutdownLifecycle = fixture.api.trigger("session_shutdown", {}, fixture.context);
  };
  assert.equal((await fixture.adapter.ready(fixture.context)).status, "accepted");
  await shutdownLifecycle;
  await assert.rejects(() => fixture.session.prompt("late native review"));
  await assert.rejects(() => fixture.session.getToolByName("write").execute("late", {}, undefined, undefined, fixture.nativeContext));
  await assert.rejects(async () => fixture.session.agent.prompt({ role: "user", content: [] }));
  assert.throws(() => fixture.session.agent.followUp({ role: "user", content: [] }));
  assert.equal(promptEffects, 0);
  assert.equal(toolEffects, 0);
});

test("send_now_transfers_only_the_exact_queued_dispatch_and_rejects_consumed_replay", async () => {
  const fixture = nativeFixture();
  await fixture.adapter.bind(fixture.context);
  const framed = (id, text, transfer_dispatch_id) => `\u001eALINERY:${JSON.stringify({ id, proof: `${id}-proof`, transfer_dispatch_id })}\u001f${text}`;
  await fixture.session.followUp(framed("earlier", "same caption"));
  await fixture.session.followUp(framed("selected", "same caption"));
  const [earlier, selected] = fixture.session.agent.peekFollowUpQueue();
  await fixture.session.prompt(framed("send-now", "same caption", "selected"));
  assert.deepEqual(fixture.session.agent.peekFollowUpQueue(), [earlier]);
  assert.equal(fixture.session.agent.peekFollowUpQueue().includes(selected), false);
  await assert.rejects(() => fixture.session.prompt(framed("duplicate", "same caption", "selected")), /no longer transferable/);
  assert.deepEqual(fixture.session.agent.peekFollowUpQueue(), [earlier]);
  assert.equal(
    fixture.events.filter((event) => event.type === "native_dispatch_transferred" && event.dispatch_id === "selected" && event.replacement_dispatch_id === "send-now").length,
    1,
  );
  await fixture.session.agent.continue();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await fixture.adapter.ready(fixture.context)).status, "ready", "a rejected replacement must not keep the drained queue's work alive");
});

test("failed_transfer_rejection_notification_still_releases_the_entered_operation", async () => {
  const active = new Set();
  const fixture = nativeFixture(undefined, undefined, (event) => {
    if (event.type === "native_work_entered") active.add(event.operation_id);
    if (event.type === "native_work_settled") active.delete(event.operation_id);
    if (event.type === "native_dispatch_rejected") throw new Error("rejection acknowledgement lost");
  });
  await fixture.adapter.bind(fixture.context);
  const frame = '\u001eALINERY:{"id":"failed-transfer","proof":"proof","transfer_dispatch_id":"missing"}\u001fselected';
  await assert.rejects(() => fixture.session.prompt(frame));
  assert.deepEqual([...active], [], "the daemon must not retain an operation whose native call has unwound");
  const outcome = await fixture.adapter.ready(fixture.context);
  assert.equal(outcome.status, "unavailable");
  assert.match(outcome.reason, /rejection acknowledgement lost/);
});

test("lost_transfer_ack_is_not_a_definite_refusal_and_releases_both_operation_lifetimes", async () => {
  const active = new Set();
  const fixture = nativeFixture(undefined, undefined, (event) => {
    if (event.type === "native_work_entered") active.add(event.operation_id);
    if (event.type === "native_work_settled") active.delete(event.operation_id);
    if (event.type === "native_dispatch_transferred") throw new Error("transfer acknowledgement lost");
  });
  await fixture.adapter.bind(fixture.context);
  const framed = (id, transfer_dispatch_id) => `\u001eALINERY:${JSON.stringify({ id, proof: `${id}-proof`, transfer_dispatch_id })}\u001fselected`;
  await fixture.session.followUp(framed("selected"));
  await assert.rejects(() => fixture.session.prompt(framed("replacement", "selected")), /transfer acknowledgement lost/);
  assert.deepEqual(fixture.session.agent.peekFollowUpQueue(), []);
  assert.deepEqual([...active], [], "both unwound operations must retire even when transfer reporting fails");
  assert.equal(
    fixture.events.some((event) => event.type === "native_dispatch_rejected"),
    false,
    "queue removal makes delivery uncertain, not definitely refused",
  );
  const outcome = await fixture.adapter.ready(fixture.context);
  assert.equal(outcome.status, "unavailable");
  assert.match(outcome.reason, /transfer acknowledgement lost/);
});

test("known_native_job_cancellation_retains_the_actual_unwind_promise", async () => {
  let release;
  const unwind = new Promise((resolve) => {
    release = resolve;
  });
  let jobId;
  let fixture;
  fixture = nativeFixture(async () => {
    jobId = fixture.session.asyncJobManager.register("eval", "selected child", async ({ signal }) => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      await unwind;
    });
    return { content: [], details: { async: { state: "running", jobId } } };
  });
  await fixture.adapter.bind(fixture.context);
  await fixture.session.getToolByName("write").execute("tool", {}, undefined, undefined, fixture.nativeContext);
  fixture.session.asyncJobManager.cancel(jobId);
  assert.equal((await fixture.adapter.ready(fixture.context)).status, "waiting");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await fixture.adapter.ready(fixture.context)).status, "ready");
});

test("settled_native_work_renews_prior_readiness_without_another_completion_call", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = nativeFixture(async () => {
    await held;
    return { content: [], details: {} };
  });
  await fixture.adapter.bind(fixture.context);
  await fixture.adapter.ready(fixture.context);
  const pending = fixture.native.execute("late-tool", {}, undefined, undefined, fixture.nativeContext);
  await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.runAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.events.filter((event) => event.type === "readiness_reported").length, 1, "held work cannot renew readiness");
  release();
  await pending;
  context.mock.timers.runAll();
  await new Promise((resolve) => setImmediate(resolve));
  try {
    const reports = fixture.events.filter((event) => event.type === "readiness_reported");
    assert.equal(reports.length, 2, "actual settlement must renew the existing readiness request");
    assert.equal(reports[1].expected_work_revision, fixture.capability().revision);
    await fixture.session.runIdleCompaction();
    context.mock.timers.runAll();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.events.filter((event) => event.type === "readiness_reported").length, 3, "maintenance must not lose readiness");
  } finally {
    await fixture.adapter.invalidate("fixture disposed");
  }
});

test("new_review_after_ready_requires_its_own_completion_request", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = nativeFixture();
  await fixture.adapter.bind(fixture.context);
  await fixture.adapter.ready(fixture.context);
  await fixture.session.followUp('\u001eALINERY:{"id":"new-review","proof":"new-proof"}\u001frevise this');
  const releaseRun = await fixture.consume();
  releaseRun();
  await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.runAll();
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(fixture.events.filter((event) => event.type === "readiness_reported").length, 1, "new review cannot inherit old readiness");
    assert.equal((await fixture.adapter.ready(fixture.context)).status, "ready");
  } finally {
    await fixture.adapter.invalidate("fixture disposed");
  }
});

test("late_readiness_reply_cannot_restore_completion_after_new_review", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let releaseReady;
  let releaseAdmission;
  let reports = 0;
  const heldReady = new Promise((resolve) => {
    releaseReady = resolve;
  });
  const heldAdmission = new Promise((resolve) => {
    releaseAdmission = resolve;
  });
  const fixture = nativeFixture(
    undefined,
    async () => {
      reports++;
      if (reports === 1) await heldReady;
      return { status: "ready", ready_revision: fixture.capability().revision };
    },
    async (event) => {
      if (event.type === "native_work_entered") await heldAdmission;
    },
  );
  await fixture.adapter.bind(fixture.context);
  const ready = fixture.adapter.ready(fixture.context);
  const review = fixture.session.followUp('\u001eALINERY:{"id":"new-review","proof":"new-proof"}\u001frevise this');
  releaseReady();
  await ready;
  releaseAdmission();
  await review;
  const releaseRun = await fixture.consume();
  releaseRun();
  await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.runAll();
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(reports, 1, "a stale completion reply cannot renew readiness for later review");
  } finally {
    await fixture.adapter.invalidate("fixture disposed");
  }
});

test("later_review_cannot_reuse_an_earlier_deferred_readiness_request", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let fixture;
  fixture = nativeFixture(async () => {
    assert.equal((await fixture.adapter.ready(fixture.context)).status, "waiting");
    await held;
    return { content: [], details: {} };
  });
  await fixture.adapter.bind(fixture.context);
  const pending = fixture.session.getToolByName("write").execute("tool", {}, undefined, undefined, fixture.nativeContext);
  await new Promise((resolve) => setImmediate(resolve));
  await fixture.session.followUp('\u001eALINERY:{"id":"later-review","proof":"later-proof"}\u001frevise this');
  release();
  await pending;
  const releaseRun = await fixture.consume();
  releaseRun();
  await new Promise((resolve) => setImmediate(resolve));
  try {
    context.mock.timers.runAll();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      fixture.events.some((event) => event.type === "readiness_reported"),
      false,
    );
    assert.equal((await fixture.adapter.ready(fixture.context)).status, "ready");
  } finally {
    await fixture.adapter.invalidate("fixture disposed");
  }
});

test("missing_boundary_and_session_shutdown_never_leave_protected_readiness", async () => {
  const missing = nativeFixture();
  missing.session.agent.replaceQueues = undefined;
  await missing.adapter.bind(missing.context);
  assert.equal((await missing.adapter.ready(missing.context)).status, "unavailable");
  assert.equal(
    missing.events.some((event) => event.type === "continuation_bind"),
    false,
  );
  const fixture = nativeFixture();
  await fixture.adapter.bind(fixture.context);
  registerCallbacks(fixture.api, makeRecordingEmitter(), async () => assert.fail("detached completion transport"), undefined, undefined, undefined, undefined, fixture.adapter);
  await fixture.api.trigger("session_shutdown", {}, fixture.context);
  assert.equal(fixture.capability().available, false);
  assert.equal((await fixture.adapter.ready(fixture.context)).status, "unavailable");
  const entered = fixture.events.filter((event) => event.type === "native_work_entered").length;
  await fixture.session.prompt("ordinary native behavior after binding disposal");
  assert.equal(fixture.events.filter((event) => event.type === "native_work_entered").length, entered);
});

test("revocation_does_not_reopen_review_before_authoritative_ack", async () => {
  let acknowledge;
  let started;
  const ack = new Promise((resolve) => {
    acknowledge = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const fixture = nativeFixture(undefined, undefined, async (event) => {
    if (event.type === "continuation_revoke") {
      started();
      await ack;
    }
  });
  let effects = 0;
  fixture.session.prompt = async () => {
    effects++;
  };
  await fixture.adapter.bind(fixture.context);
  const revoke = fixture.adapter.invalidate("required boundary lost");
  try {
    await entered;
    await assert.rejects(() => fixture.session.prompt("losing review"), /finishing|required boundary lost/);
    assert.equal(effects, 0);
    acknowledge();
    await revoke;
    await fixture.session.prompt("plain review after committed revocation");
    assert.equal(effects, 1);
    assert.equal((await fixture.adapter.ready(fixture.context)).status, "unavailable");
  } finally {
    acknowledge();
    await revoke;
  }
});

test("rejected_revocation_keeps_review_fenced_when_continue_wins", async () => {
  let rejectRevoke;
  let started;
  const rejection = new Promise((resolve) => {
    rejectRevoke = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const fixture = nativeFixture(undefined, undefined, async (event) => {
    if (event.type === "continuation_revoke") {
      started();
      await rejection;
      throw new ext.NativeControlRejected("continuation already requested");
    }
  });
  let effects = 0;
  fixture.session.prompt = async () => {
    effects++;
  };
  await fixture.adapter.bind(fixture.context);
  const revoke = fixture.adapter.invalidate("boundary changed");
  await entered;
  fixture.request();
  rejectRevoke();
  await revoke;
  await assert.rejects(() => fixture.session.prompt("must not cross requested handoff"), /finishing|boundary changed/);
  assert.equal(effects, 0);
});

test("revoked_capability_retains_original_incarnation_until_entered_work_settles", async () => {
  let release;
  let started;
  const unwind = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const pending = new Set();
  const fixture = nativeFixture(
    async () => {
      started();
      await unwind;
      return { content: [], details: { original: true } };
    },
    undefined,
    (event) => {
      if (event.type === "native_work_entered") pending.add(event.operation_id);
      if (event.type === "native_work_settled") {
        assert.equal(event.process_incarnation, "native-incarnation");
        pending.delete(event.operation_id);
      }
    },
  );
  await fixture.adapter.bind(fixture.context);
  const work = fixture.session.getToolByName("write").execute("active", {}, undefined, undefined, fixture.nativeContext);
  await entered;
  await fixture.adapter.invalidate("required boundary lost");
  release();
  assert.deepEqual((await work).details, { original: true });
  assert.deepEqual([...pending], [], "real old work must settle even though new protected admission is unavailable");
});

test("revoked_scope_retains_late_children_without_delaying_native_parent_return", async () => {
  let resumeParent;
  let releaseChild;
  let enteredParent;
  let enteredChild;
  const resume = new Promise((resolve) => {
    resumeParent = resolve;
  });
  const childDone = new Promise((resolve) => {
    releaseChild = resolve;
  });
  const parentStarted = new Promise((resolve) => {
    enteredParent = resolve;
  });
  const childStarted = new Promise((resolve) => {
    enteredChild = resolve;
  });
  let child;
  let fixture;
  fixture = nativeFixture(async (_id, input) => {
    if (input.kind === "parent") {
      enteredParent();
      await resume;
      child = fixture.session.getToolByName("write").execute("child", { kind: "child" }, undefined, undefined, fixture.nativeContext);
      return { content: [], details: { parentReturned: true } };
    }
    enteredChild();
    await childDone;
    return { content: [], details: {} };
  });
  await fixture.adapter.bind(fixture.context);
  const parent = fixture.session.getToolByName("write").execute("parent", { kind: "parent" }, undefined, undefined, fixture.nativeContext);
  await parentStarted;
  await fixture.adapter.invalidate("retire protected admission");
  resumeParent();
  let deadline;
  try {
    const result = await Promise.race([
      parent,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("native parent return waited for child execution")), 5000);
      }),
    ]);
    assert.equal(result.details.parentReturned, true);
    await childStarted;
    assert.equal(fixture.capability().pending.length, 2, "parent and actual late child stay owned while unavailable");
    releaseChild();
    await child;
    assert.deepEqual(fixture.capability().pending, []);
  } finally {
    clearTimeout(deadline);
    resumeParent();
    releaseChild();
    await Promise.allSettled([parent, child]);
  }
});

test("stale_binding_acknowledgement_cannot_activate_native_admission", async () => {
  const fixture = nativeFixture(undefined, undefined, (event) => {
    if (event.type === "continuation_bind")
      return {
        process_incarnation: "native-incarnation",
        capability_revision: event.expected_capability_revision + 3,
        work_revision: 0,
        continuation_requested_revision: null,
        available: true,
        reason: null,
      };
  });
  let effects = 0;
  fixture.session.prompt = async () => {
    effects++;
  };
  await fixture.adapter.bind(fixture.context);
  assert.equal((await fixture.adapter.ready(fixture.context)).status, "unavailable");
  await assert.rejects(() => fixture.session.prompt("must not use another binding's acknowledgement"), /Stale continuation binding/);
  assert.equal(effects, 0);
});

test("accepted_revocation_replay_keeps_the_fence_and_requests_shutdown_once", async () => {
  let committed = false;
  const fixture = nativeFixture(undefined, undefined, (event) => {
    if (event.type === "continuation_revoke") committed = true;
    if (committed && (event.type === "continuation_revoke" || event.type === "continuation_poll")) {
      return { status: "accepted", receipt_id: "immutable-winner" };
    }
  });
  let shutdowns = 0;
  fixture.context.shutdown = () => {
    shutdowns++;
  };
  await fixture.adapter.bind(fixture.context);
  await fixture.adapter.invalidate("acceptance won the race");
  await new Promise((resolve) => setImmediate(resolve));
  await fixture.adapter.invalidate("duplicate lifecycle notification");
  assert.equal(shutdowns, 1);
  await assert.rejects(() => fixture.session.prompt("after immutable acceptance"), /finishing/);
});

test("daemon_waiting_retains_the_deferred_readiness_request_until_authority_settles", async () => {
  let attempts = 0;
  const fixture = nativeFixture(undefined, async () => {
    attempts++;
    return attempts === 1 ? { status: "waiting", reason: "native intake acknowledgement is pending" } : { status: "ready", ready_revision: 0 };
  });
  await fixture.adapter.bind(fixture.context);
  assert.equal((await fixture.adapter.ready(fixture.context)).status, "waiting");
  const deadline = setTimeout(() => assert.fail("continuation poll did not run"), 5000);
  try {
    await fixture.nextPoll();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 2, "known temporary waiting must not discard the requested readiness");
  } finally {
    clearTimeout(deadline);
  }
});

test("opaque_dispatch_proof_is_validated_before_effects_and_replay_cannot_deliver_twice", async () => {
  const claims = new Map();
  const fixture = nativeFixture(undefined, undefined, (event) => {
    if (event.type !== "native_work_entered" || !event.dispatch_id) return;
    if (event.dispatch_proof !== "single-dispatch-proof") throw new ext.NativeControlRejected("invalid dispatch proof");
    const claimed = claims.get(event.dispatch_id);
    if (claimed && claimed !== event.operation_id) throw new ext.NativeControlRejected("dispatch proof already claimed");
    claims.set(event.dispatch_id, event.operation_id);
  });
  const delivered = [];
  fixture.session.prompt = async (text) => {
    delivered.push(text);
    return true;
  };
  await fixture.adapter.bind(fixture.context);
  const frame = '\u001eALINERY:{"id":"review","proof":"single-dispatch-proof"}\u001fexact original review';
  await fixture.session.prompt(frame);
  assert.deepEqual(delivered, ["exact original review"], "opaque envelope is removed before native preprocessing");
  await assert.rejects(() => fixture.session.prompt(frame), /already claimed/);
  assert.deepEqual(delivered, ["exact original review"], "replayed proof cannot deliver a second native prompt");
});

test("forged_dispatch_proof_cannot_reach_the_native_delegate", async () => {
  const fixture = nativeFixture(undefined, undefined, (event) => {
    if (event.type === "native_work_entered" && event.dispatch_id) throw new ext.NativeControlRejected("invalid dispatch proof");
  });
  let effects = 0;
  fixture.session.prompt = async () => {
    effects++;
    return true;
  };
  await fixture.adapter.bind(fixture.context);
  await assert.rejects(() => fixture.session.prompt('\u001eALINERY:{"id":"forged","proof":"not-authorized"}\u001fmalicious input'), /invalid dispatch proof/);
  assert.equal(effects, 0);
  await assert.rejects(() => fixture.session.prompt('\u001eALINERY:{"id":"another-pending-input","proof":"forged-again"}\u001fpayload'), /invalid dispatch proof/);
  assert.equal(
    fixture.events.some((event) => event.type === "native_dispatch_rejected"),
    false,
    "unclaimed text must not reject someone else's pending dispatch",
  );
});

test("generic_session_preserves_literal_header_shaped_input_without_authority", async () => {
  const fixture = nativeFixture(undefined, undefined, (event) => {
    if (event.type === "continuation_poll" && event.process_incarnation === undefined) throw new ext.NativeControlRejected("session has no primary execution");
  });
  const delivered = [];
  fixture.session.prompt = async (text) => {
    delivered.push(text);
    return true;
  };
  await fixture.adapter.bind(fixture.context);
  const literal = '\u001eALINERY:{"id":"literal","proof":"ordinary-user-text"}\u001funchanged';
  await fixture.session.prompt(literal);
  assert.deepEqual(delivered, [literal]);
});

test("naming prompt preserves context and stops after acknowledged name", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "alinery-naming-"));
  const runner = path.join(root, "runner");
  const capture = path.join(root, "request");
  writeFileSync(runner, `#!/bin/sh\n/bin/cat > '${capture}'\nprintf '%s\\n' '{"status":"unchanged","value":{"name":"Human correction","source":"user"}}'\n`, { mode: 0o755 });
  const keys = [
    "ALINERY_RUNNER_PATH",
    "ALINERY_SESSION_ID",
    "ALINERY_DAEMON_SOCKET",
    "ALINERY_DAEMON_NAMESPACE",
    "ALINERY_EVENT_PROTOCOL_VERSION",
    "ALINERY_EVENT_TOKEN",
    "ALINERY_SESSION_NAMING",
  ];
  const previous = keys.map((key) => process.env[key]);
  try {
    Object.assign(process.env, {
      ALINERY_RUNNER_PATH: runner,
      ALINERY_SESSION_ID: "own",
      ALINERY_DAEMON_SOCKET: "/unused",
      ALINERY_DAEMON_NAMESPACE: "",
      ALINERY_EVENT_PROTOCOL_VERSION: "3",
      ALINERY_EVENT_TOKEN: "captured",
      ALINERY_SESSION_NAMING: "1",
    });
    const api = makeFakeApi();
    ext.default(api);
    const systemPrompt = ["Original safety instruction"];
    const result = await api.trigger("before_agent_start", { systemPrompt });
    assert.ok(result?.systemPrompt?.length > systemPrompt.length, "eligible working turn receives naming instruction");
    assert.equal(result.systemPrompt[0], systemPrompt[0]);
    assert.deepEqual(systemPrompt, ["Original safety instruction"]);
    assert.equal(process.env.ALINERY_SESSION_NAMING, undefined);
    const outcome = await api.callTool("alinery_set_session_name", { name: "A useful purpose with thirty characters", session_id: "foreign", source: "user" }, makeContext("own"));
    assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), { type: "session_name_suggested", name: "A useful purpose with thirty characters" });
    assert.deepEqual(outcome.details, { status: "unchanged", value: { name: "Human correction", source: "user" } });
    assert.equal(await api.trigger("before_agent_start", { systemPrompt }), undefined);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(root, { recursive: true, force: true });
  }
});

test("taskless and unavailable transport never require naming", async () => {
  const api = makeFakeApi();
  const emit = makeRecordingEmitter();
  registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);
  assert.equal(await api.trigger("before_agent_start", { systemPrompt: ["ordinary"] }), undefined);
  assert.ok(!api.getRegisteredTools().includes("alinery_set_session_name"));
});

function installNaming(api, runner, eligible = true) {
  const values = {
    ALINERY_RUNNER_PATH: runner,
    ALINERY_SESSION_ID: "own",
    ALINERY_DAEMON_SOCKET: "/unused",
    ALINERY_DAEMON_NAMESPACE: "",
    ALINERY_EVENT_PROTOCOL_VERSION: "3",
    ALINERY_EVENT_TOKEN: "captured",
    ALINERY_SESSION_NAMING: eligible ? "1" : "0",
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    ext.default(api);
    assert.equal(process.env.ALINERY_SESSION_NAMING, undefined, "eligibility is launch-only");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("session name transport requires matching successful acknowledgement", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "alinery-naming-errors-"));
  const runner = path.join(root, "runner");
  try {
    const good = '{"status":"saved","value":{"name":"Repair cache","source":"auto"}}';
    for (const script of [
      `printf '%s\\n' '${good}'; exit 1`,
      `printf '%s' '${good}'`,
      `printf '%s\\n' '{"status":"accepted","receipt_id":"wrong-kind"}'`,
      `printf '%s\\n' '{"status":"saved","value":{"name":"x","source":"foreign"}}'`,
      `printf '%s\\n' '{"status":"rejected","reason":"stale owner"}'; exit 2`,
      `printf '%s\\n' 'not-json'`,
      `printf '%65537s\\n' x`,
      "exec /bin/sleep 8",
    ]) {
      writeFileSync(runner, `#!/bin/sh\n/bin/cat >/dev/null\n${script}\n`, { mode: 0o755 });
      const api = makeFakeApi();
      installNaming(api, runner);
      assert.ok(api.getRegisteredTools().includes("alinery_set_session_name"));
      await assert.rejects(api.callTool("alinery_set_session_name", { name: "Repair cache" }, makeContext("own")));
      assert.ok((await api.trigger("before_agent_start", { systemPrompt: ["ordinary"] }))?.systemPrompt.length > 1);
      await api.trigger("agent_start", { type: "agent_start" });
      await api.trigger("agent_end", { type: "agent_end" });
    }
    const api = makeFakeApi();
    installNaming(api, runner, false);
    assert.ok(!api.getRegisteredTools().includes("alinery_set_session_name"));
    assert.equal(await api.trigger("before_agent_start", { systemPrompt: ["ordinary"] }), undefined);
    const environment = { ALINERY_SESSION_NAMING: "1" };
    assert.equal(ext.captureRunnerConfig(environment), undefined);
    assert.equal(environment.ALINERY_SESSION_NAMING, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner credentials are scrubbed from tool children and retained only for emit", () => {
  const inherited = {
    PATH: process.env.PATH,
    UNRELATED: "keep",
    ALINERY_RUNNER_PATH: "/alinery/alinery-runner",
    ALINERY_SESSION_ID: "alinery-session",
    ALINERY_DAEMON_SOCKET: "/tmp/alineryd.sock",
    ALINERY_DAEMON_NAMESPACE: "namespace",
    ALINERY_EVENT_PROTOCOL_VERSION: "3",
    ALINERY_EVENT_TOKEN: "secret-token",
    ALINERY_HOST_EXECUTABLE: "/canonical/Alinery Dev",
    ALINERY_PTY_INITIAL_PROMPT: "private initial task instructions",
  };

  const protectedHost = ext.captureProtectedHost(inherited);
  assert.equal(ext.captureInitialPtyPrompt(inherited), "private initial task instructions");
  const config = ext.captureRunnerConfig(inherited);
  assert.ok(config);
  assert.equal(protectedHost, "/canonical/Alinery Dev");
  assert.equal(inherited.UNRELATED, "keep");
  for (const name of [
    "ALINERY_HOST_EXECUTABLE",
    "ALINERY_PTY_INITIAL_PROMPT",
    "ALINERY_RUNNER_PATH",
    "ALINERY_SESSION_ID",
    "ALINERY_DAEMON_SOCKET",
    "ALINERY_DAEMON_NAMESPACE",
    "ALINERY_EVENT_PROTOCOL_VERSION",
    "ALINERY_EVENT_TOKEN",
  ]) {
    assert.equal(inherited[name], undefined, `${name} must be scrubbed`);
  }

  const toolChild = spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.ALINERY_EVENT_TOKEN ?? 'missing')"], { env: inherited, encoding: "utf8" });
  assert.equal(toolChild.stdout, "missing");

  const emitterChild = spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.ALINERY_EVENT_TOKEN ?? 'missing')"], { env: config.environment, encoding: "utf8" });
  assert.equal(emitterChild.stdout, "secret-token");
  assert.equal(config.environment.ALINERY_RUNNER_PATH, undefined);
  assert.equal(config.environment.ALINERY_HOST_EXECUTABLE, undefined);
  const hostChild = spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.ALINERY_HOST_EXECUTABLE ?? 'missing')"], { env: config.environment, encoding: "utf8" });
  assert.equal(hostChild.stdout, "missing");
});

test("PTY startup seeds the editor before readiness and never overwrites a later draft", async () => {
  const api = makeFakeApi();
  let draft = "";
  const observations = [];
  const emit = async (event) => observations.push({ event, draft });
  const context = {
    ...makeContext("pty-owner"),
    ui: {
      setEditorText(value) {
        draft = value;
      },
    },
  };
  registerCallbacks(api, emit, async () => ({ status: "accepted", receipt_id: "unused" }), undefined, "first line\nsecond line");
  await api.trigger("session_start", { type: "session_start" }, context);
  assert.equal(draft, "first line\nsecond line");
  assert.equal(observations[0].draft, "first line\nsecond line");
  draft = "human's later draft";
  await api.trigger("session_start", { type: "session_start" }, context);
  assert.equal(draft, "human's later draft");
});

test("empty production namespace keeps runner transport available", () => {
  const environment = {
    ALINERY_RUNNER_PATH: "/alinery/alinery-runner",
    ALINERY_SESSION_ID: "alinery-session",
    ALINERY_DAEMON_SOCKET: "/tmp/alineryd.sock",
    ALINERY_DAEMON_NAMESPACE: "",
    ALINERY_EVENT_PROTOCOL_VERSION: "3",
    ALINERY_EVENT_TOKEN: "secret-token",
  };

  const config = ext.captureRunnerConfig(environment);
  assert.ok(config);
  assert.equal(config.environment.ALINERY_DAEMON_NAMESPACE, "");
});

test("protected host capture is independent of runner transport", () => {
  const incomplete = {
    UNRELATED: "keep",
    ALINERY_HOST_EXECUTABLE: "/canonical/host",
    ALINERY_SESSION_ID: "missing-the-other-runner-fields",
  };
  assert.equal(ext.captureProtectedHost(incomplete), "/canonical/host");
  assert.equal(incomplete.ALINERY_HOST_EXECUTABLE, undefined);
  assert.equal(ext.captureRunnerConfig(incomplete), undefined);
  assert.equal(incomplete.UNRELATED, "keep");

  const absent = { UNRELATED: "keep" };
  assert.equal(ext.captureProtectedHost(absent), undefined);
  assert.deepEqual(absent, { UNRELATED: "keep" });
});

const blockedResult = {
  block: true,
  reason:
    "Alinery blocks browser app.path from targeting the host or an installed Alinery app. Use ordinary browser mode, app.cdp_url, the browser relay, or native computer automation.",
};

function createTarget(root, relativePath) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "");
  return realpathSync(target);
}

describe("browser application host guard", () => {
  test("blocks canonical hosts, production bundles, symlinks, and OMP-normalized spellings", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "alinery-omp-host-"));
    const homeRoot = mkdtempSync(path.join(os.homedir(), ".alinery-omp-host-"));
    try {
      const dynamicProduction = createTarget(root, "Dynamic/Alinery.app/Contents/MacOS/Alinery");
      const dynamicDev = createTarget(root, "Dynamic/Alinery Dev.app/Contents/MacOS/Alinery Dev");
      const productionOne = createTarget(root, "Applications/Alinery.app/Contents/MacOS/Alinery");
      const productionTwo = createTarget(root, "Other Root/Alinery.app/Contents/MacOS/Alinery");
      const lowercaseProduction = createTarget(root, "Lowercase/alinery.app/Contents/MacOS/alinery");
      const spacedProduction = createTarget(root, "Space Root/Alinery.app/Contents/MacOS/Alinery");
      const tildeProduction = createTarget(homeRoot, "Alinery.app/Contents/MacOS/Alinery");
      const dynamicLink = path.join(root, "dynamic-dev-link");
      const productionLink = path.join(root, "production-link");
      symlinkSync(dynamicDev, dynamicLink);
      symlinkSync(productionOne, productionLink);

      const cases = [
        ["dynamic production host", dynamicProduction, root, dynamicProduction],
        ["dynamic development host", dynamicDev, root, dynamicDev],
        ["production root one", productionOne, root, undefined],
        ["production root two", productionTwo, root, undefined],
        ["lowercase production Alinery", lowercaseProduction, root, undefined],
        ["dynamic host symlink", dynamicLink, root, dynamicDev],
        ["production bundle symlink", productionLink, root, undefined],
        ["relative path", path.relative(root, productionOne), root, undefined],
        ["at-prefixed absolute path", `@${productionOne}`, root, undefined],
        ["stray-colon absolute path", `:${productionOne}`, root, undefined],
        ["file URL", pathToFileURL(productionOne).href, root, undefined],
        ["Unicode-space normalization", spacedProduction.replace("Space Root", "Space\u00A0Root"), root, undefined],
        ["tilde expansion", `~/${path.relative(os.homedir(), tildeProduction)}`, root, undefined],
        ["bare root as cwd", "/", productionOne, undefined],
      ];

      for (const [label, requested, cwd, host] of cases) {
        const actual = await ext.classifyBrowserOpen({ action: "open", app: { path: requested } }, cwd, host);
        assert.deepEqual(actual, blockedResult, label);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(homeRoot, { recursive: true, force: true });
    }
  });

  test("allows safe modes, malformed inputs, and targets that cannot be canonicalized", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "alinery-omp-allowed-"));
    try {
      const protectedHost = createTarget(root, "Host/Alinery Dev.app/Contents/MacOS/Alinery Dev");
      const separateDev = createTarget(root, "Other/Alinery Dev.app/Contents/MacOS/Alinery Dev");
      const basenameAlinery = createTarget(root, "bin/Alinery");
      const wrongBundleCase = createTarget(root, "alinery.app/Contents/MacOS/Alinery");
      const wrongContentsCase = createTarget(root, "Alinery.app/contents/MacOS/Alinery");
      const wrongExecutableCase = createTarget(root, "Alinery.app/Contents/MacOS/alinery");
      const renamedProduction = createTarget(root, "Renamed.app/Contents/MacOS/Alinery");
      const nonexistentProduction = path.join(root, "Missing/Alinery.app/Contents/MacOS/Alinery");

      const cases = [
        ["separate development build", { action: "open", app: { path: separateDev } }],
        ["basename only", { action: "open", app: { path: basenameAlinery } }],
        ["wrong bundle case", { action: "open", app: { path: wrongBundleCase } }],
        ["wrong contents case", { action: "open", app: { path: wrongContentsCase } }],
        ["wrong executable case", { action: "open", app: { path: wrongExecutableCase } }],
        ["renamed production bundle", { action: "open", app: { path: renamedProduction } }],
        ["nonexistent production shape", { action: "open", app: { path: nonexistentProduction } }],
        ["ordinary browser", { action: "open" }],
        ["relay", { action: "open", relay: true }],
        ["non-empty CDP precedence", { action: "open", app: { path: protectedHost, cdp_url: "http://127.0.0.1:9222" } }],
        ["other action", { action: "close", app: { path: protectedHost } }],
        ["null input", null],
        ["array input", []],
        ["non-object app", { action: "open", app: "bad" }],
        ["non-string path", { action: "open", app: { path: 42 } }],
        ["internal URL", { action: "open", app: { path: "artifact://result" } }],
      ];

      for (const [label, input] of cases) {
        assert.equal(await ext.classifyBrowserOpen(input, root, protectedHost), undefined, label);
      }

      for (const cdp_url of ["", 42, {}]) {
        assert.deepEqual(
          await ext.classifyBrowserOpen({ action: "open", app: { path: protectedHost, cdp_url } }, root, protectedHost),
          blockedResult,
          `malformed or empty CDP value ${JSON.stringify(cdp_url)}`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns blocking results through the single pre-execution callback without lifecycle events", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "alinery-omp-callback-"));
    try {
      const protectedHost = createTarget(root, "Alinery Dev.app/Contents/MacOS/Alinery Dev");
      const api = makeFakeApi();
      const emit = makeRecordingEmitter();
      registerCallbacks(api, emit, makeCompletionEmitter(emit), protectedHost);

      const blocked = await api.trigger(
        "tool_call",
        { toolName: "browser", toolCallId: "browser-1", input: { action: "open", app: { path: protectedHost } } },
        makeContext("omp-browser", root),
      );
      assert.deepEqual(blocked, blockedResult);
      assert.deepEqual(emit.emitted, []);

      assert.equal(
        await api.trigger("tool_call", { toolName: "bash", toolCallId: "bash-1", input: { action: "open", app: { path: protectedHost } } }, makeContext("omp-browser", root)),
        undefined,
      );
      assert.deepEqual(emit.emitted, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
// ---------- tests ----------

describe("2C — OMP extension callback behavior in isolation", () => {
  test("maps_agent_lifecycle_without_completing_or_exiting", async () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);

    await api.trigger("agent_start", { type: "agent_start" });
    assert.deepEqual(emit.emitted[0], { type: "busy" });

    // OMP's own retry: the failed tail rides along, but willContinue means the turn is still live.
    await api.trigger("agent_end", {
      type: "agent_end",
      willContinue: true,
      messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "socket closed" }],
    });
    assert.deepEqual(emit.emitted[1], { type: "busy" });

    await api.trigger("agent_end", { type: "agent_end" });
    assert.deepEqual(emit.emitted[2], { type: "idle" });

    // Only the active OMP session may settle this launch's agent state.
    await api.trigger("session_stop", {
      type: "session_stop",
      session_id: "other-session",
      turn_id: 9,
    });
    assert.equal(emit.emitted.length, 3);
    await api.trigger("session_stop", {
      type: "session_stop",
      session_id: "omp-sess-event",
      turn_id: 10,
    });
    assert.deepEqual(emit.emitted[3], { type: "idle", omp_turn_id: 10 });

    for (const ev of emit.emitted) {
      assert.notEqual(ev.type, "readiness_reported");
      assert.notEqual(ev.type, "process_exited");
    }
  });

  // Issue #128: OMP ends a turn whose provider stream died with an assistant message
  // `stopReason: "error"` and fires agent_end with that tail. Reporting it as a clean
  // `idle` hides the failure: the UI shows Idle and the playbook step stalls.
  test("error_stopped_terminal_agent_end_is_not_reported_as_idle", async () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);

    await api.trigger("agent_start", { type: "agent_start" });
    await api.trigger("agent_end", {
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "Analyze every candidate." }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "Partial analysis that was already streamed…" }],
          stopReason: "error",
          errorMessage: "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
        },
      ],
    });

    const last = emit.emitted.at(-1);
    assert.notDeepEqual(last, { type: "idle" }, "a transport error stop must surface, not read as a clean idle turn");
    assert.equal(last.type, "turn_error");
    assert.match(last.detail, /socket connection was closed unexpectedly/);
  });

  test("maps_approval_with_matching_correlation", async () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);

    await api.trigger("tool_approval_requested", { toolCallId: "a" });
    assert.deepEqual(emit.emitted[0], {
      type: "waiting_for_approval",
      correlation_id: "a",
    });

    await api.trigger("tool_approval_resolved", { toolCallId: "b" });
    assert.deepEqual(emit.emitted[1], {
      type: "busy",
      correlation_id: "b",
    });

    await api.trigger("tool_approval_resolved", { toolCallId: "a" });
    assert.deepEqual(emit.emitted[2], {
      type: "busy",
      correlation_id: "a",
    });
  });

  test("maps_only_omp_ask_calls_and_results", async () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);

    await api.trigger("tool_call", {
      toolName: "bash",
      toolCallId: "bash-1",
    });
    assert.equal(emit.emitted.length, 0, "bash tool_call must not emit");

    await api.trigger("tool_call", {
      toolName: "ask",
      toolCallId: "ask-1",
    });
    assert.deepEqual(emit.emitted[0], {
      type: "waiting_for_input",
      correlation_id: "ask-1",
    });

    await api.trigger("tool_result", {
      toolName: "bash",
      toolCallId: "bash-1",
    });
    assert.equal(emit.emitted.length, 1, "bash tool_result must not emit");

    await api.trigger("tool_result", {
      toolName: "ask",
      toolCallId: "ask-1",
    });
    assert.deepEqual(emit.emitted[1], {
      type: "busy",
      correlation_id: "ask-1",
    });

    for (const ev of emit.emitted) {
      assert.ok(!("toolName" in ev), "toolName must not be forwarded");
      assert.ok(!("toolCallId" in ev), "raw toolCallId must not be forwarded");
    }
  });

  test("phase_complete_has_no_model_controlled_routing_input", async () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);

    const schema = api.getToolSchema("alinery_phase_complete");
    assert.ok(schema, "tool must be registered");
    assert.deepEqual(schema.parameters.shape, {}, "schema must have no model-controlled fields");

    const output = await api.callTool("alinery_phase_complete", {}, makeContext("omp-sess-abc"));

    assert.equal(emit.emitted.length, 1);
    const ev = emit.emitted[0];
    assert.equal(ev.type, "readiness_reported");
    assert.equal(ev.process_incarnation, "omp-sess-abc");
    assert.ok(!("omp_turn_id" in ev), "OMP tool context exposes no turn id");

    assert.equal(output.content[0].type, "text");
    assert.deepEqual(output.details, { status: "accepted", receipt_id: "receipt-1" });

    // No task, alinery session, playbook, phase, artifact path, or next phase in emitted event.
    assert.ok(!("task" in ev), "must not contain task");
    assert.ok(!("session_id" in ev), "must not contain alinery session_id");
    assert.ok(!("playbook" in ev), "must not contain playbook");
    assert.ok(!("phase" in ev), "must not contain phase");
    assert.ok(!("artifact" in ev), "must not contain artifact");
    assert.ok(!("next_phase" in ev), "must not contain next_phase");
  });

  test("accepted_completion_requests_normal_shutdown_once_and_returns_result", async () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);
    let shutdownRequests = 0;
    const context = {
      ...makeContext("omp-sess-finishing"),
      shutdown() {
        shutdownRequests += 1;
      },
    };

    const first = await api.callTool("alinery_phase_complete", {}, context);
    const replay = await api.callTool("alinery_phase_complete", {}, context);

    assert.deepEqual(first.details, { status: "accepted", receipt_id: "receipt-1" });
    assert.deepEqual(replay.details, first.details);
    assert.equal(shutdownRequests, 1, "accepted completion must request ordinary OMP shutdown once");

    await api.trigger("session_start", { type: "session_start" }, context);
    const afterReset = await api.callTool("alinery_phase_complete", {}, context);
    assert.deepEqual(afterReset.details, first.details);
    assert.equal(shutdownRequests, 2, "session reset must clear the shutdown latch");
  });

  test("completion_tool_keeps_locked_invalid_and_transport_failures_interactive", async () => {
    const cases = [
      { outcome: { status: "ready", ready_revision: 7 } },
      { outcome: { status: "invalid_outputs", diagnostics: ["research/result.md must be a regular file", "report.md must not be empty"] } },
      { outcome: { status: "stale", reason: "execution owner is stale" } },
      { outcome: new Error("daemon unavailable") },
      { outcome: new Error("daemon timeout") },
    ];

    for (const { outcome } of cases) {
      const api = makeFakeApi();
      const emit = makeRecordingEmitter();
      let shutdownRequests = 0;
      const context = {
        ...makeContext("omp-sess-result"),
        shutdown() {
          shutdownRequests += 1;
        },
      };
      registerCallbacks(api, emit, makeCompletionEmitter(emit, outcome), undefined);
      const output = await api.callTool("alinery_phase_complete", {}, context);
      assert.deepEqual(output.details, outcome instanceof Error ? { status: "delivery_failed", reason: outcome.message } : outcome);
      assert.equal(shutdownRequests, 0);
      if (outcome.status === "invalid_outputs") {
        for (const diagnostic of outcome.diagnostics) assert.ok(output.content[0].text.includes(diagnostic));
      }
      await api.trigger("tool_call", { toolName: "ask", toolCallId: "correction" }, context);
      assert.deepEqual(emit.emitted.at(-1), { type: "waiting_for_input", correlation_id: "correction" });
    }

    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);
    const noSession = await api.callTool("alinery_phase_complete", {}, makeContext(""));
    assert.deepEqual(noSession.details, { status: "delivery_failed" });
    assert.equal(emit.emitted.length, 0);
  });

  test("invalid_completion_can_be_repaired_in_the_same_interactive_session", async () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    const invalid = { status: "invalid_outputs", diagnostics: ["report.md must not be empty"] };
    const accepted = { status: "accepted", receipt_id: "repaired-receipt" };
    let attempts = 0;
    let shutdowns = 0;
    registerCallbacks(api, emit, async () => (++attempts === 1 ? invalid : accepted), undefined);
    const context = {
      ...makeContext("repair-session"),
      shutdown() {
        shutdowns += 1;
      },
    };
    assert.deepEqual((await api.callTool("alinery_phase_complete", {}, context)).details, invalid);
    assert.equal(shutdowns, 0);
    await api.trigger("tool_call", { toolName: "ask", toolCallId: "repair" }, context);
    assert.deepEqual(emit.emitted.at(-1), { type: "waiting_for_input", correlation_id: "repair" });
    await api.trigger("tool_result", { toolName: "ask", toolCallId: "repair" }, context);
    assert.deepEqual(emit.emitted.at(-1), { type: "busy", correlation_id: "repair" });
    assert.deepEqual((await api.callTool("alinery_phase_complete", {}, context)).details, accepted);
    assert.equal(shutdowns, 1);
    assert.deepEqual((await api.callTool("alinery_phase_complete", {}, context)).details, accepted);
    assert.equal(shutdowns, 1);
  });

  test("callback_delivery_failure_is_silent_and_fail_open", async () => {
    const api = makeFakeApi();
    const throwingEmit = async () => {
      throw new Error("simulated delivery failure");
    };
    registerCallbacks(api, throwingEmit, throwingEmit, undefined);

    await assert.doesNotReject(() => api.trigger("agent_start", { type: "agent_start" }));
    await assert.doesNotReject(() => api.trigger("agent_end", { type: "agent_end" }));
    await assert.doesNotReject(() => api.trigger("session_stop", { type: "session_stop", session_id: "omp-sess-event", turn_id: 1 }));
    await assert.doesNotReject(() => api.trigger("tool_approval_requested", { toolCallId: "x" }));
    await assert.doesNotReject(() => api.trigger("tool_approval_resolved", { toolCallId: "x" }));
    await assert.doesNotReject(() => api.trigger("tool_call", { toolName: "ask", toolCallId: "y" }));
    await assert.doesNotReject(() => api.trigger("tool_result", { toolName: "ask", toolCallId: "y" }));
    const completion = await api.callTool("alinery_phase_complete", {}, makeContext("omp-sess-1"));
    assert.deepEqual(completion.details, { status: "delivery_failed", reason: "simulated delivery failure" });
  });

  test("duplicate_callbacks_preserve_normalized_identity", async () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);

    await api.trigger("agent_start", { type: "agent_start" });
    await api.trigger("agent_start", { type: "agent_start" });
    assert.equal(emit.emitted.length, 2);
    assert.deepEqual(emit.emitted[0], emit.emitted[1]);

    await api.trigger("tool_call", {
      toolName: "ask",
      toolCallId: "ask-x",
    });
    await api.trigger("tool_call", {
      toolName: "ask",
      toolCallId: "ask-x",
    });
    const asks = emit.emitted.filter((e) => e.type === "waiting_for_input");
    assert.equal(asks.length, 2);
    assert.deepEqual(asks[0], asks[1]);

    const ctx = makeContext("omp-s2");
    await api.callTool("alinery_phase_complete", {}, ctx);
    await api.callTool("alinery_phase_complete", {}, ctx);
    const pcs = emit.emitted.filter((e) => e.type === "readiness_reported");
    assert.equal(pcs.length, 2);
    assert.deepEqual(pcs[0], pcs[1]);
  });

  test("ask_approval_schema_has_title_and_message", () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);

    const schema = api.getToolSchema("alinery_ask_approval");
    assert.ok(schema, "alinery_ask_approval must be registered");
    assert.deepEqual(Object.keys(schema.parameters.shape).sort(), ["message", "title"]);
  });

  test("ask_approval_preserves_rpc_ui_receiver_and_waits_for_allow", async () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);

    // Match OMP's class-backed RpcExtensionUIContext, not its receiver-free TUI closures.
    let present;
    const request = new Promise((resolve) => {
      present = resolve;
    });
    class RpcUi {
      pendingRequests = new Map();

      confirm(title, message) {
        return new Promise((resolve) => {
          this.pendingRequests.set("approval-1", resolve);
          present({ type: "extension_ui_request", id: "approval-1", method: "confirm", title, message });
        });
      }

      respond(response) {
        const resolve = this.pendingRequests.get(response.id);
        this.pendingRequests.delete(response.id);
        resolve(response.cancelled ? false : response.confirmed);
      }
    }
    const ui = new RpcUi();
    const ctx = { ...makeContext("omp-sess-abc"), ui };
    const pending = api.callTool("alinery_ask_approval", { title: "Go?", message: "Biome failed" }, ctx);
    const shown = await Promise.race([request, pending]);
    assert.deepEqual(shown, {
      type: "extension_ui_request",
      id: "approval-1",
      method: "confirm",
      title: "Go?",
      message: "Biome failed",
    });
    assert.deepEqual(emit.emitted, [{ type: "waiting_for_approval", correlation_id: "tool-call-1" }]);
    ui.respond({ type: "extension_ui_response", id: shown.id, confirmed: true });
    const output = await pending;
    assert.deepEqual(output.details, { approved: true });
    assert.deepEqual(emit.emitted, [
      { type: "waiting_for_approval", correlation_id: "tool-call-1" },
      { type: "busy", correlation_id: "tool-call-1" },
    ]);
  });

  test("ask_approval_denies_every_response_except_literal_allow_true", async () => {
    for (const response of [false, undefined, null, "Allow", "true", 1, {}]) {
      const api = makeFakeApi();
      const emit = makeRecordingEmitter();
      registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);
      const ctx = {
        ...makeContext("omp-sess-abc"),
        ui: {
          response,
          async confirm() {
            return this.response;
          },
        },
      };
      const output = await api.callTool("alinery_ask_approval", { title: "Go?", message: "Biome failed" }, ctx);
      assert.deepEqual(output.details, { approved: false });
      assert.deepEqual(emit.emitted, [
        { type: "waiting_for_approval", correlation_id: "tool-call-1" },
        { type: "busy", correlation_id: "tool-call-1" },
      ]);
    }
  });

  test("ask_approval_fails_closed_and_emits_busy_when_confirm_throws", async () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);

    const error = new Error("confirm failed");
    const ctx = {
      ...makeContext("omp-sess-abc"),
      ui: {
        confirm: async () => {
          throw error;
        },
      },
    };
    const output = await api.callTool("alinery_ask_approval", { title: "Go?", message: "Biome failed" }, ctx);
    assert.equal(output.details.approved, false);
    assert.equal(output.details.status, "unavailable");
    assert.deepEqual(
      emit.emitted.filter((e) => e.type === "waiting_for_approval" || e.type === "busy"),
      [
        { type: "waiting_for_approval", correlation_id: "tool-call-1" },
        { type: "busy", correlation_id: "tool-call-1" },
      ],
    );
  });

  test("ask_approval_missing_ui_is_unavailable_without_wa", async () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);

    const output = await api.callTool("alinery_ask_approval", { title: "Go?", message: "Biome failed" }, makeContext("omp-sess-abc"));
    assert.equal(output.details.approved, false);
    assert.equal(output.details.status, "unavailable");
    assert.equal(
      emit.emitted.some((e) => e.type === "waiting_for_approval"),
      false,
      "missing UI must not emit waiting_for_approval",
    );
  });

  test("ask_approval_ui_without_confirm_is_unavailable_without_wa", async () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);

    const ctx = { ...makeContext("omp-sess-abc"), ui: {} };
    const output = await api.callTool("alinery_ask_approval", { title: "Go?", message: "Biome failed" }, ctx);
    assert.equal(output.details.approved, false);
    assert.equal(output.details.status, "unavailable");
    assert.equal(
      emit.emitted.some((e) => e.type === "waiting_for_approval"),
      false,
      "ui without confirm must not emit waiting_for_approval",
    );
  });

  test("ask_approval_omp_no_ui_context_is_unavailable_without_calling_confirm", async () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);
    const ctx = {
      ...makeContext("omp-sess-abc"),
      hasUI: false,
      ui: { confirm: async () => assert.fail("no UI must not request confirmation") },
    };
    const output = await api.callTool("alinery_ask_approval", { title: "Go?", message: "Save playbook" }, ctx);
    assert.equal(output.details.approved, false);
    assert.equal(output.details.status, "unavailable");
    assert.deepEqual(emit.emitted, []);
  });

  test("ask_approval_substitutes_empty_title_and_message", async () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);

    const calls = [];
    const ctx = {
      ...makeContext("omp-sess-abc"),
      ui: {
        confirm: async (title, message) => {
          calls.push([title, message]);
          return true;
        },
      },
    };
    await api.callTool("alinery_ask_approval", { title: "", message: 1 }, ctx);
    assert.deepEqual(calls, [["Approval required", "Approval needed."]]);
  });

  test("ask_approval_tool_call_does_not_emit_wa", async () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);

    await api.trigger("tool_call", {
      toolName: "alinery_ask_approval",
      toolCallId: "appr-1",
    });
    assert.equal(emit.emitted.length, 0, "alinery_ask_approval tool_call must not emit");
  });
});

describe("production completion transport", () => {
  async function withRunnerOutput(output, run, delay = 0) {
    const root = mkdtempSync(path.join(os.tmpdir(), "alinery-completion-transport-"));
    const runnerPath = path.join(root, "runner");
    writeFileSync(
      runnerPath,
      `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on("end", () => setTimeout(() => process.stdout.write(${JSON.stringify(output)}), ${delay}));\n`,
      { mode: 0o755 },
    );
    try {
      await run(ext.makeProductionCompletionEmitter({ runnerPath, environment: {} }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const event = { type: "readiness_reported", process_incarnation: "omp-transport", expected_work_revision: 0 };

  async function withCompletionAttempts(firstReply, run) {
    const root = mkdtempSync(path.join(os.tmpdir(), "alinery-completion-retry-"));
    const runnerPath = path.join(root, "runner");
    const statePath = path.join(root, "state.json");
    writeFileSync(
      runnerPath,
      `#!${process.execPath}
const fs = require("node:fs");
const statePath = ${JSON.stringify(statePath)};
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { requests: [] };
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  state.requests.push({ event: JSON.parse(input), token: process.env.ALINERY_EVENT_TOKEN });
  const accept = () => {
    state.receipt ??= "immutable-receipt";
    return { status: "accepted", receipt_id: state.receipt };
  };
  let reply;
  ${firstReply}
  state.lastReply = reply;
  fs.writeFileSync(statePath, JSON.stringify(state));
  if (reply !== undefined) process.stdout.write(JSON.stringify(reply) + "\\n");
});
`,
      { mode: 0o755 },
    );
    try {
      await run(ext.makeProductionCompletionEmitter({ runnerPath, environment: { ALINERY_EVENT_TOKEN: "same-owner-token" } }), () => JSON.parse(readFileSync(statePath, "utf8")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  for (const [name, reply, attempts] of [
    [
      "busy_then_success_beyond_four_attempts",
      'reply = state.requests.length < 5 ? { status: "rejected", reason: "task mutation busy during execution transaction" } : accept();',
      5,
    ],
    ["prior_ambiguous_attempt_still_in_flight_recovers", 'reply = state.requests.length === 1 ? { status: "rejected", reason: "completion-in-progress" } : accept();', 2],
    ["committed_but_lost_ack_replays_receipt", "const accepted = accept(); if (state.requests.length > 1) reply = accepted;", 2],
    [
      "committed_but_parent_sync_failed_replays_receipt",
      'const accepted = accept(); reply = state.requests.length === 1 ? { status: "rejected", reason: "ambiguous persistence after rename of /task/execution.json (parent sync failed): I/O error" } : accepted;',
      2,
    ],
    [
      "temporary_write_failure_recovers",
      'reply = state.requests.length === 1 ? { status: "rejected", reason: "write durable temporary file: No space left on device" } : accept();',
      2,
    ],
  ]) {
    test(name, async () => {
      await withCompletionAttempts(reply, async (emitCompletion, state) => {
        const api = makeFakeApi();
        registerCallbacks(api, makeRecordingEmitter(), emitCompletion);
        let shutdowns = 0;
        const context = makeContext(event.process_incarnation);
        context.shutdown = () => {
          assert.deepEqual(state().lastReply, { status: "accepted", receipt_id: "immutable-receipt" });
          shutdowns++;
        };
        const output = await api.callTool("alinery_phase_complete", {}, context);
        assert.deepEqual(output.details, { status: "accepted", receipt_id: "immutable-receipt" });
        assert.equal(shutdowns, 1);
        assert.deepEqual(
          state().requests,
          Array.from({ length: attempts }, () => ({ event, token: "same-owner-token" })),
        );
      });
    });
  }

  test("retry_observer_failure_does_not_abandon_completion", async () => {
    await withCompletionAttempts('reply = state.requests.length === 1 ? { status: "delivery_failed" } : accept();', async (emitCompletion) => {
      assert.deepEqual(
        await emitCompletion(event, undefined, () => {
          throw new Error("progress renderer failed");
        }),
        { status: "accepted", receipt_id: "immutable-receipt" },
      );
    });
  });

  test("permanent_rejection_and_authorization_gates_are_not_retried", async () => {
    for (const outcome of [
      { status: "rejected", reason: "invalid-event-token" },
      { status: "rejected", reason: "execution owner is stale" },
      { status: "rejected", reason: "retained task definition integrity mismatch" },
      { status: "rejected", reason: "invalid task execution state: malformed JSON" },
      { status: "ready", ready_revision: 7 },
      { status: "invalid_outputs", diagnostics: ["invalid publication"] },
    ]) {
      await withCompletionAttempts(`reply = ${JSON.stringify(outcome)};`, async (emitCompletion, state) => {
        assert.deepEqual(await emitCompletion(event), outcome.status === "rejected" ? { status: "unavailable", reason: outcome.reason } : outcome);
        assert.equal(state().requests.length, 1);
      });
    }
  });

  test("persistent_unavailability_stays_pending_until_cancelled_without_shutdown", async () => {
    for (const outcome of [{ status: "delivery_failed" }, { status: "rejected", reason: "task mutation busy during execution transaction" }]) {
      await withCompletionAttempts(`reply = ${JSON.stringify(outcome)};`, async (emitCompletion, state) => {
        const api = makeFakeApi();
        registerCallbacks(api, makeRecordingEmitter(), emitCompletion);
        const context = makeContext(event.process_incarnation);
        context.shutdown = () => assert.fail("unconfirmed completion must stay open");
        const controller = new AbortController();
        let updates = 0;
        const output = await api.callTool("alinery_phase_complete", {}, context, controller.signal, (update) => {
          assert.equal(update.details.status, "waiting_for_acceptance");
          assert.match(update.content[0].text, /Automatically retrying/);
          if (++updates === 2) controller.abort();
        });
        assert.equal(output.details.status, "delivery_failed");
        assert.equal(updates, 2);
        assert.equal(state().requests.length, 2);
      });
    }
  });

  test("native_readiness_cancellation_stops_transport_and_deferred_retries_without_shutdown", async (context) => {
    await withCompletionAttempts(
      'reply = state.requests.length <= 2 ? { status: "delivery_failed" } : { status: "unavailable", reason: "cancellation was ignored" };',
      async (emitCompletion, state) => {
        let reports = 0;
        const complete = (...args) => {
          if (++reports === 1) return emitCompletion(...args);
          return Promise.resolve({ status: "unavailable", reason: "cancelled readiness must not restart" });
        };
        const fixture = nativeFixture(undefined, complete);
        fixture.context.shutdown = () => assert.fail("cancelled, unconfirmed readiness must keep the session open");
        registerCallbacks(fixture.api, makeRecordingEmitter(), complete, undefined, undefined, undefined, undefined, fixture.adapter);
        await fixture.adapter.bind(fixture.context);
        const controller = new AbortController();
        let updates = 0;
        try {
          const output = await fixture.api.callTool("alinery_phase_complete", {}, fixture.context, controller.signal, () => {
            if (++updates === 2) controller.abort();
          });
          assert.equal(output.details.status, "delivery_failed");
          assert.equal(state().requests.length, 2, "cancelling must stop the real transport retry loop");
          context.mock.timers.enable({ apis: ["setTimeout"] });
          await fixture.native.execute("later-work", {}, undefined, undefined, fixture.nativeContext);
          context.mock.timers.runAll();
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(reports, 1, "later native settlement must not revive the cancelled readiness request");
        } finally {
          await fixture.adapter.invalidate("fixture disposed");
        }
      },
    );
  });

  test("preserves_receipts_diagnostics_and_nonfatal_outcomes_after_pipe_drain", async () => {
    for (const outcome of [
      { status: "accepted", receipt_id: "receipt-".repeat(100) },
      { status: "invalid_outputs", diagnostics: ["Missing nested/output.md", "λ".repeat(5000)] },
      { status: "ready", ready_revision: 7 },
      { status: "requested", ready_revision: 7 },
      { status: "waiting", reason: "native work pending" },
      { status: "stale", reason: "generation changed" },
      { status: "unavailable", reason: "primary binding missing" },
    ]) {
      await withRunnerOutput(
        `${JSON.stringify(outcome)}\n`,
        async (emitCompletion) => {
          assert.deepEqual(await emitCompletion(event), outcome);
        },
        750,
      );
    }
  });

  test("malformed_truncated_and_oversized_acknowledgements_never_confirm_completion", async () => {
    for (const output of [
      '{"status":"accepted","receipt_id":"receipt"}',
      '{"status":"accepted"}\n',
      '{"status":"accepted","receipt_id":\n',
      '{"status":"invalid_outputs","diagnostics":[42]}\n',
      `${JSON.stringify({ status: "accepted", receipt_id: "λ".repeat(40_000) })}\n`,
    ]) {
      await withRunnerOutput(output, async (emitCompletion) => {
        const controller = new AbortController();
        await assert.rejects(() => emitCompletion(event, controller.signal, () => controller.abort()), { name: "AbortError" });
      });
    }
  });

  test("preserves_external_spawn_errors", async () => {
    const emitCompletion = ext.makeProductionCompletionEmitter({ runnerPath: "/nonexistent/alinery-runner", environment: {} });
    await assert.rejects(() => emitCompletion(event), { code: "ENOENT" });
  });
});

describe("chat thread titles", () => {
  const runnerEnvironment = (naming) => ({
    ALINERY_RUNNER_PATH: "/alinery/alinery-runner",
    ALINERY_SESSION_ID: "alinery-session",
    ALINERY_DAEMON_SOCKET: "/tmp/alineryd.sock",
    ALINERY_DAEMON_NAMESPACE: "",
    ALINERY_EVENT_PROTOCOL_VERSION: "3",
    ALINERY_EVENT_TOKEN: "secret-token",
    ...(naming === undefined ? {} : { ALINERY_SESSION_NAMING: naming }),
  });

  // The titler is fire-and-forget; once the event loop turns, every pending microtask has run.
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  // A branch carries more than user messages; only role "user" messages count.
  function branchWith(userMessages) {
    const branch = [{ type: "model_change" }];
    for (let index = 0; index < userMessages; index += 1) {
      branch.push({ type: "message", message: { role: "user" } }, { type: "message", message: { role: "assistant" } }, { type: "message", message: { role: "toolResult" } });
    }
    return branch;
  }

  function makeChatContext(userMessages) {
    const chat = {
      userMessages,
      reply: "Fix login bug",
      turns: [],
      context: {
        ...makeContext("omp-chat"),
        sessionManager: { getSessionId: () => "omp-chat", getBranch: () => branchWith(chat.userMessages) },
        async runEphemeralTurn(options) {
          chat.turns.push(options);
          return { replyText: chat.reply };
        },
      },
    };
    return chat;
  }

  // `deliver` runs before a title counts as written, so a throwing one models a refused write.
  function registerChatTitles(deliver = async () => {}) {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    const titles = [];
    const emitChatTitle = async (event) => {
      await deliver(event);
      titles.push(event);
      return { status: "saved", value: { name: event.name, source: "auto" } };
    };
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined, undefined, undefined, emitChatTitle);
    return { api, emit, titles };
  }

  async function endTurn(api, chat, payload = { type: "agent_end" }) {
    await api.trigger("agent_end", payload, chat.context);
    await flush();
  }

  test("ALINERY_SESSION_NAMING picks task or chat naming and is always scrubbed", () => {
    for (const [mode, expected] of [
      ["chat", { sessionNaming: false, chatNaming: true }],
      ["1", { sessionNaming: true, chatNaming: false }],
      ["0", { sessionNaming: false, chatNaming: false }],
      [undefined, { sessionNaming: false, chatNaming: false }],
    ]) {
      const environment = runnerEnvironment(mode);
      const config = ext.captureRunnerConfig(environment);
      assert.equal(config?.sessionNaming, expected.sessionNaming, `sessionNaming for ${mode}`);
      assert.equal(config?.chatNaming, expected.chatNaming, `chatNaming for ${mode}`);
      assert.equal("ALINERY_SESSION_NAMING" in environment, false, `${mode} must be scrubbed`);
    }
  });

  test("chatTitleBucket titles after the first message, then at every tenth", () => {
    const buckets = [0, 1, 2, 9, 10, 19, 20, 31].map((count) => ext.chatTitleBucket(count));
    assert.deepEqual(buckets, [0, 1, 1, 1, 10, 10, 20, 30]);
  });

  test("cleanChatTitle strips quoting, prefix, markdown, and trailing punctuation", () => {
    for (const [reply, expected] of [
      ['"Fix login bug"', "Fix login bug"],
      ["'Fix login bug'", "Fix login bug"],
      ["Title: Fix login bug", "Fix login bug"],
      ["TITLE:   Fix login bug", "Fix login bug"],
      ["**Fix login bug**", "Fix login bug"],
      ["# Fix login bug", "Fix login bug"],
      ["`Fix login bug`", "Fix login bug"],
      ["Fix login bug.", "Fix login bug"],
      ["  Fix   the\tlogin bug  ", "Fix the login bug"],
    ]) {
      assert.equal(ext.cleanChatTitle(reply), expected, JSON.stringify(reply));
    }
  });

  test("cleanChatTitle keeps only the first non-empty line", () => {
    assert.equal(ext.cleanChatTitle("\n  \nFix login bug\nThis thread is about a login bug."), "Fix login bug");
  });

  test("cleanChatTitle cuts a long title to 40 characters on a word edge", () => {
    const title = ext.cleanChatTitle("Refactoring the authentication middleware for session tokens");
    assert.equal(title, "Refactoring the authentication");
    assert.ok(title.length <= 40);
  });

  test("cleanChatTitle keeps a word that ends exactly at the 40-character limit", () => {
    assert.equal(ext.cleanChatTitle("Investigating the intermittent websocket crash"), "Investigating the intermittent websocket");
  });

  test("cleanChatTitle hard-cuts a long title that has no usable word edge", () => {
    assert.equal(ext.cleanChatTitle("x".repeat(60)), "x".repeat(40));
    assert.equal(ext.cleanChatTitle(`Hi ${"x".repeat(60)}`), `Hi ${"x".repeat(37)}`, "an early space is not a usable edge");
  });

  test("cleanChatTitle returns an empty string when nothing is left", () => {
    for (const reply of ["", "   \n  ", '""', "Title:"]) {
      assert.equal(ext.cleanChatTitle(reply), "", JSON.stringify(reply));
    }
  });

  test("first turn end titles the thread through a tools-off side turn", async () => {
    const { api, emit, titles } = registerChatTitles();
    const chat = makeChatContext(1);
    chat.reply = '"Fix login bug."';
    await endTurn(api, chat);
    assert.equal(chat.turns.length, 1);
    assert.equal(chat.turns[0].tools, false);
    assert.ok(chat.turns[0].promptText.length > 0);
    assert.deepEqual(titles, [{ type: "session_name_suggested", name: "Fix login bug" }]);
    assert.deepEqual(emit.emitted, [{ type: "idle" }], "the title goes to its own emitter, not the lifecycle one");
  });

  test("a turn end that will continue does not title and does not use up the bucket", async () => {
    const { api, titles } = registerChatTitles();
    const chat = makeChatContext(1);
    await endTurn(api, chat, { type: "agent_end", willContinue: true });
    assert.equal(chat.turns.length, 0);
    assert.deepEqual(titles, []);
    await endTurn(api, chat);
    assert.equal(chat.turns.length, 1);
  });

  test("only user messages count toward a title", async () => {
    const { api, titles } = registerChatTitles();
    const chat = makeChatContext(0);
    await endTurn(api, chat);
    assert.equal(chat.turns.length, 0);
    assert.deepEqual(titles, []);
  });

  test("another turn end in the same bucket does not title again", async () => {
    const { api, titles } = registerChatTitles();
    const chat = makeChatContext(1);
    await endTurn(api, chat);
    await endTurn(api, chat);
    chat.userMessages = 2;
    await endTurn(api, chat);
    assert.equal(chat.turns.length, 1);
    assert.equal(titles.length, 1);
  });

  test("the thread is titled again at the 10th user message and not before", async () => {
    const { api, titles } = registerChatTitles();
    const chat = makeChatContext(1);
    await endTurn(api, chat);
    for (let count = 2; count <= 9; count += 1) {
      chat.userMessages = count;
      await endTurn(api, chat);
    }
    assert.equal(chat.turns.length, 1, "messages 2 through 9 stay in the first bucket");
    chat.userMessages = 10;
    await endTurn(api, chat);
    assert.equal(chat.turns.length, 2);
    assert.equal(titles.length, 2);
  });

  test("a resumed thread is seeded from its history and titles at the next tenth", async () => {
    const { api, titles } = registerChatTitles();
    const chat = makeChatContext(15);
    await api.trigger("session_start", { type: "session_start" }, chat.context);
    await endTurn(api, chat);
    chat.userMessages = 16;
    await endTurn(api, chat);
    assert.equal(chat.turns.length, 0, "15 and 16 messages were already covered by the 10 bucket");
    chat.userMessages = 20;
    await endTurn(api, chat);
    assert.equal(chat.turns.length, 1);
    assert.equal(titles.length, 1);
  });

  test("a missing runEphemeralTurn leaves the thread untitled without throwing", async () => {
    const { api, titles } = registerChatTitles();
    const chat = makeChatContext(1);
    delete chat.context.runEphemeralTurn;
    await endTurn(api, chat);
    assert.deepEqual(titles, []);
  });

  test("a missing getBranch leaves the thread untitled without throwing", async () => {
    const { api, titles } = registerChatTitles();
    const chat = makeChatContext(1);
    delete chat.context.sessionManager.getBranch;
    await api.trigger("session_start", { type: "session_start" }, chat.context);
    await endTurn(api, chat);
    assert.equal(chat.turns.length, 0);
    assert.deepEqual(titles, []);
  });

  test("a model that refuses tools:false is asked again without it", async () => {
    const { api, titles } = registerChatTitles();
    const chat = makeChatContext(1);
    const sideTurn = chat.context.runEphemeralTurn;
    const requests = [];
    chat.context.runEphemeralTurn = async (options) => {
      requests.push(options.tools);
      if (options.tools === false) throw new Error("model does not support tools: false");
      return sideTurn(options);
    };
    await endTurn(api, chat);
    assert.deepEqual(requests, [false, undefined]);
    assert.deepEqual(titles, [{ type: "session_name_suggested", name: "Fix login bug" }]);
  });

  test("a failed side turn is swallowed and retried at the next turn end", async () => {
    const { api, titles } = registerChatTitles();
    const chat = makeChatContext(1);
    const sideTurn = chat.context.runEphemeralTurn;
    let failing = true;
    let attempts = 0;
    chat.context.runEphemeralTurn = async (options) => {
      attempts += 1;
      if (failing) throw new Error("model unavailable");
      return sideTurn(options);
    };
    await endTurn(api, chat);
    assert.deepEqual(titles, []);
    assert.equal(attempts, 2, "tools:false, then the plain request");
    failing = false;
    await endTurn(api, chat);
    assert.equal(attempts, 3);
    assert.deepEqual(titles, [{ type: "session_name_suggested", name: "Fix login bug" }]);
  });

  test("a refused title write is swallowed and retried at the next turn end", async () => {
    let writes = 0;
    const { api, titles } = registerChatTitles(async () => {
      writes += 1;
      if (writes === 1) throw new Error("Session name rejected: stale owner");
    });
    const chat = makeChatContext(1);
    await endTurn(api, chat);
    assert.deepEqual(titles, []);
    await endTurn(api, chat);
    assert.equal(chat.turns.length, 2);
    assert.deepEqual(titles, [{ type: "session_name_suggested", name: "Fix login bug" }]);
  });

  test("an empty reply writes nothing and is retried at the next turn end", async () => {
    const { api, titles } = registerChatTitles();
    const chat = makeChatContext(1);
    chat.reply = '""';
    await endTurn(api, chat);
    assert.deepEqual(titles, []);
    chat.reply = "Fix login bug";
    await endTurn(api, chat);
    assert.equal(chat.turns.length, 2);
    assert.equal(titles.length, 1);
  });

  test("turn ends while a title is in flight do not start a second side turn", async () => {
    const { api, titles } = registerChatTitles();
    const chat = makeChatContext(1);
    let release;
    chat.context.runEphemeralTurn = (options) => {
      chat.turns.push(options);
      return new Promise((resolve) => {
        release = () => resolve({ replyText: "Fix login bug" });
      });
    };
    // Not awaited one by one: the first side turn stays pending until released.
    const turnEnds = [];
    for (let count = 0; count < 2; count += 1) {
      turnEnds.push(api.trigger("agent_end", { type: "agent_end" }, chat.context));
      await flush();
    }
    assert.equal(chat.turns.length, 1);
    release();
    await Promise.all(turnEnds);
    await flush();
    assert.equal(titles.length, 1);
    await endTurn(api, chat);
    assert.equal(chat.turns.length, 1, "the finished title recorded its bucket");
  });

  test("agent_end reports idle without waiting for the title", async () => {
    const { api, emit, titles } = registerChatTitles();
    const chat = makeChatContext(1);
    chat.context.runEphemeralTurn = (options) => {
      chat.turns.push(options);
      return new Promise(() => {});
    };
    let timer;
    const outcome = await Promise.race([
      api.trigger("agent_end", { type: "agent_end" }, chat.context).then(() => "settled"),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("blocked"), 1000);
      }),
    ]);
    clearTimeout(timer);
    assert.equal(outcome, "settled");
    assert.deepEqual(emit.emitted, [{ type: "idle" }]);
    assert.equal(chat.turns.length, 1, "the side turn did start");
    assert.deepEqual(titles, []);
  });

  test("registering without emitChatTitle never starts a side turn", async () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);
    const chat = makeChatContext(1);
    await endTurn(api, chat);
    assert.equal(chat.turns.length, 0);
    assert.deepEqual(emit.emitted, [{ type: "idle" }]);
  });

  test("a chat-naming launch wires the title emitter and not the task naming tool", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "alinery-chat-title-"));
    const runner = path.join(root, "runner");
    const log = path.join(root, "requests");
    // agent_end sends idle and then the title through the same runner; one JSON line each.
    writeFileSync(runner, `#!/bin/sh\nprintf '%s\\n' "$(/bin/cat)" >> '${log}'\nprintf '%s\\n' '{"status":"saved","value":{"name":"Fix login bug","source":"auto"}}'\n`, {
      mode: 0o755,
    });
    const values = {
      ...runnerEnvironment("chat"),
      ALINERY_RUNNER_PATH: runner,
      ALINERY_SESSION_ID: "own",
      ALINERY_DAEMON_SOCKET: "/unused",
    };
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    const api = makeFakeApi();
    try {
      Object.assign(process.env, values);
      ext.default(api);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    try {
      assert.ok(!api.getRegisteredTools().includes("alinery_set_session_name"));
      assert.equal(await api.trigger("before_agent_start", { systemPrompt: ["ordinary"] }), undefined);
      await api.trigger("agent_end", { type: "agent_end" }, makeChatContext(1).context);
      const requests = () =>
        existsSync(log)
          ? readFileSync(log, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
          : [];
      for (let waited = 0; !requests().some((event) => event.type === "session_name_suggested") && waited < 5000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.deepEqual(
        requests().filter((event) => event.type === "session_name_suggested"),
        [{ type: "session_name_suggested", name: "Fix login bug" }],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
