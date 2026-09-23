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
    async callTool(name, input, context) {
      const tool = tools[name];
      if (!tool) throw new Error(`tool not registered: ${name}`);
      return tool.execute("tool-call-1", input, undefined, undefined, context);
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

test("runner credentials are scrubbed from tool children and retained only for emit", () => {
  const inherited = {
    PATH: process.env.PATH,
    UNRELATED: "keep",
    ALINERY_RUNNER_PATH: "/alinery/alinery-runner",
    ALINERY_SESSION_ID: "alinery-session",
    ALINERY_DAEMON_SOCKET: "/tmp/alineryd.sock",
    ALINERY_DAEMON_NAMESPACE: "namespace",
    ALINERY_EVENT_PROTOCOL_VERSION: "1",
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
    ALINERY_EVENT_PROTOCOL_VERSION: "1",
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

    await api.trigger("agent_end", {
      type: "agent_end",
      willContinue: true,
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
      assert.notEqual(ev.type, "phase_completed");
      assert.notEqual(ev.type, "process_exited");
    }
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
    assert.equal(ev.type, "phase_completed");
    assert.equal(ev.omp_session_id, "omp-sess-abc");
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
      { outcome: { status: "human_authorization_required" } },
      { outcome: { status: "invalid_outputs", diagnostics: ["Missing research/result.md", "report.md must not be empty"] } },
      { outcome: { status: "rejected", reason: "execution owner is stale" } },
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
    const pcs = emit.emitted.filter((e) => e.type === "phase_completed");
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

  test("ask_approval_confirm_true_emits_wa_then_busy", async () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);

    const calls = [];
    const ctx = {
      ...makeContext("omp-sess-abc"),
      ui: {
        pendingRequests: calls,
        async confirm(title, message) {
          this.pendingRequests.push([title, message]);
          return true;
        },
      },
    };
    const output = await api.callTool("alinery_ask_approval", { title: "Go?", message: "Biome failed" }, ctx);

    assert.deepEqual(output.details, { approved: true });
    assert.deepEqual(calls, [["Go?", "Biome failed"]]);
    assert.deepEqual(emit.emitted, [
      { type: "waiting_for_approval", correlation_id: "tool-call-1" },
      { type: "busy", correlation_id: "tool-call-1" },
    ]);
  });

  test("ask_approval_confirm_false_refuses_without_aborting", async () => {
    const api = makeFakeApi();
    const emit = makeRecordingEmitter();
    registerCallbacks(api, emit, makeCompletionEmitter(emit), undefined);

    const ctx = {
      ...makeContext("omp-sess-abc"),
      ui: {
        approved: false,
        async confirm() {
          return this.approved;
        },
      },
    };
    const output = await api.callTool("alinery_ask_approval", { title: "Go?", message: "Biome failed" }, ctx);

    assert.deepEqual(output.details, { approved: false });
    assert.deepEqual(emit.emitted, [
      { type: "waiting_for_approval", correlation_id: "tool-call-1" },
      { type: "busy", correlation_id: "tool-call-1" },
    ]);
  });

  test("ask_approval_emits_busy_when_confirm_throws", async () => {
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
    await assert.rejects(
      () => api.callTool("alinery_ask_approval", { title: "Go?", message: "Biome failed" }, ctx),
      (caught) => caught === error,
    );
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

  const event = { type: "phase_completed", omp_session_id: "omp-transport" };

  test("preserves_receipts_diagnostics_and_nonfatal_outcomes_after_pipe_drain", async () => {
    for (const outcome of [
      { status: "accepted", receipt_id: "receipt-".repeat(100) },
      { status: "invalid_outputs", diagnostics: ["Missing nested/output.md", "λ".repeat(5000)] },
      { status: "human_authorization_required" },
      { status: "rejected", reason: "execution owner is stale" },
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

  test("rejects_malformed_truncated_and_oversized_acknowledgements", async () => {
    for (const output of [
      '{"status":"accepted","receipt_id":"receipt"}',
      '{"status":"accepted"}\n',
      '{"status":"accepted","receipt_id":\n',
      '{"status":"invalid_outputs","diagnostics":[42]}\n',
      `${JSON.stringify({ status: "accepted", receipt_id: "λ".repeat(40_000) })}\n`,
    ]) {
      await withRunnerOutput(output, async (emitCompletion) => {
        await assert.rejects(() => emitCompletion(event));
      });
    }
  });

  test("preserves_external_spawn_errors", async () => {
    const emitCompletion = ext.makeProductionCompletionEmitter({ runnerPath: "/nonexistent/alinery-runner", environment: {} });
    await assert.rejects(() => emitCompletion(event), { code: "ENOENT" });
  });
});
