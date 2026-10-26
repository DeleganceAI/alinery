// Usage: node provider_service_smoke.mjs --help
// No production config edits, catalog retagging, credential copying, or desktop launch.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    help: { type: "boolean" },
    "self-test": { type: "boolean" },
    inspect: { type: "boolean" },
    "allow-service": { type: "boolean" },
    "agent-dir": { type: "string" },
    "config-dir": { type: "string" },
    model: { type: "string" },
    "tool-path": { type: "string" },
    "tool-setup": { type: "string" },
  },
});
if (values.help || Object.keys(values).length === 0) {
  console.log(`Provider-aware diagnostic on unchanged OMP v18.1.13.

OMP_BIN=/Applications/Alinery.omp/omp node ${path.basename(import.meta.filename)} --self-test
OMP_BIN=/Applications/Alinery.omp/omp node ${path.basename(import.meta.filename)} --allow-service --agent-dir ABSOLUTE --config-dir ABSOLUTE --model PROVIDER/ID [--inspect]

Real runs require user consent; --inspect also starts OMP and may refresh catalogs.
Use Alinery's existing omp/config/agent and omp/config directories. No auth files
are copied. OMP's native resolver owns login credentials, refresh and rotation.
No login is initiated here. Resolve authentication with the user first.

Select actual catalog IDs for each route: an OpenAI-compatible service, alinery,
xai (API key), xai-oauth (SuperGrok), anthropic (key or Claude subscription),
and openai-codex (ChatGPT subscription/OAuth). Provider names are NOT API selectors.
Reports record resolved API, endpoint origin, transport and OAuth presence.
Alinery is hosted openai-completions; native xAI uses openai-responses.

The suite first runs OMP's ordinary session through a harmless echo tool, keeping
its provider settings/features intact. Then five standalone stream calls cover
native streaming, admitted background work, tool roundtrip and cancellation.
The local fixture observes seven HTTP requests overall. Real runs may make more:
native retries, advisors, prewarming, auth and catalogs remain enabled.
No token or reasoning defaults are disabled. Cancellation racing natural
completion is a failure, not a passing proof. Provider usage may be billable.

--tool-path adapter (default) wraps the standalone tool exchange.
--tool-path native sends that identical exchange directly to native streamSimple.
Use separate runs for the comparison; all other smoke steps remain unchanged.
Each process owns fresh session IDs/state, so this is not a shared-socket replay.
--tool-setup fresh runs only the standalone tool exchange with fresh provider
state, without preceding chat/plain/background requests. Default: warmed.
Fresh mode does not test cancellation or admission barriers.

Scope: native-session baseline plus explicit admission/accounting boundary.
Standalone calls use native stream defaults, not AgentSession's assembled
settings, Anthropic account metadata or primary cache-refresh ownership.
It does NOT establish automatic primary/advisor/eval/compaction interception.
Custom-API retagging is not used: it changes pre-dispatch semantics.
Existing per-install harness.env overrides are not loaded; use persisted OMP
credentials, and inspect that limitation before selecting a profile.
Alinery hosted credentials must already be prepared by the normal account flow;
this diagnostic does not mint an inference token. Build remains incomplete.`);
  process.exit(0);
}
const toolPath = values["tool-path"] ?? "adapter";
assert.ok(["adapter", "native"].includes(toolPath), "--tool-path must be adapter or native");
const toolSetup = values["tool-setup"] ?? "warmed";
assert.ok(["warmed", "fresh"].includes(toolSetup), "--tool-setup must be warmed or fresh");
const binary = process.env.OMP_BIN;
assert.ok(binary && path.isAbsolute(binary), "Set absolute OMP_BIN to the unchanged packaged runtime");
assert.match(execFileSync(binary, ["--version"], { encoding: "utf8" }), /18\.1\.13\b/, "Only the pinned runtime is supported by this diagnostic");
const local = values["self-test"] === true;
assert.ok(!(local && (values["allow-service"] || values.model || values["agent-dir"] || values["config-dir"] || values.inspect)), "Self-test cannot use real configuration");
if (!local) {
  assert.ok(values["allow-service"], "Real-service startup requires explicit --allow-service consent");
  assert.ok(values.model?.includes("/"), "Select an exact configured provider/model");
  for (const key of ["agent-dir", "config-dir"]) {
    assert.ok(values[key] && path.isAbsolute(values[key]), `Pass absolute --${key}`);
    assert.ok(statSync(values[key]).isDirectory(), `--${key} must already exist`);
  }
}
const root = mkdtempSync(path.join(tmpdir(), "alinery-provider-service-smoke-"));
const reportPath = path.join(root, "report.json");
let fixture;
let child;
let closed;
let requests = 0;
const sockets = new Set();
try {
  if (local) {
    fixture = createServer(async (request, response) => {
      let bytes = "";
      for await (const chunk of request) bytes += chunk;
      const body = JSON.parse(bytes);
      requests++;
      const finish = (delta, reason) => {
        response.write(`data: ${JSON.stringify({ id: "smoke", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        response.end(`data: ${JSON.stringify({ id: "smoke", choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);
      };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (body.messages.some((message) => JSON.stringify(message.content).includes("500 ordinary words"))) {
        response.write('data: {"id":"smoke","choices":[{"index":0,"delta":{"role":"assistant","content":"1. apple\\n"},"finish_reason":null}]}\n\n');
        // Keep the actual server request open until native cancellation closes it.
        return;
      }
      if (body.tools?.length && !body.messages.some((message) => message.role === "tool")) {
        const nativeSession = body.messages.some((message) => JSON.stringify(message.content).includes("NATIVE_SESSION_SMOKE"));
        finish(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "smoke_tool",
                type: "function",
                function: nativeSession
                  ? { name: "write", arguments: JSON.stringify({ path: "xd://service_smoke_echo", content: '{"value":"SERVICE_SMOKE_TOOL"}' }) }
                  : { name: "service_smoke_echo", arguments: '{"value":"SERVICE_SMOKE_TOOL"}' },
              },
            ],
          },
          "tool_calls",
        );
      } else finish({ role: "assistant", content: body.tools?.length ? "SERVICE_SMOKE_TOOL" : "SERVICE_SMOKE_OK" }, "stop");
    });
    fixture.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const listening = Promise.withResolvers();
    fixture.once("error", listening.reject);
    fixture.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
  }
  const model = local ? "service-smoke-local/probe" : values.model;
  // Match production isolation: no inherited API keys, task/event tokens or secrets.
  // Existing OMP config files remain in place and are read by OMP, not this script.
  const env = {};
  for (const name of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TZ",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SSH_AUTH_SOCK",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, {
    TERM: "xterm-256color",
    OMP_SKIP_SETUP: "1",
    PI_CODING_AGENT_DIR: local ? path.join(root, "agent") : values["agent-dir"],
    PI_CONFIG_DIR: local ? path.join(root, "config") : values["config-dir"],
    ALINERY_PROVIDER_SMOKE_REPORT: reportPath,
    ALINERY_PROVIDER_SMOKE_MODEL: model,
    ALINERY_PROVIDER_SMOKE_INSPECT: values.inspect ? "1" : "0",
    ALINERY_PROVIDER_SMOKE_TOOL_PATH: toolPath,
    ALINERY_PROVIDER_SMOKE_TOOL_SETUP: toolSetup,
  });
  if (local) {
    env.HOME = root;
    env.ALINERY_PROVIDER_SMOKE_LOCAL_URL = `http://127.0.0.1:${fixture.address().port}`;
  }
  child = spawn(
    binary,
    ["--mode", "rpc", "--no-session", "--extension", path.join(path.dirname(fileURLToPath(import.meta.url)), "provider_service_smoke_extension.mjs"), "--model", model],
    { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const termination = Promise.withResolvers();
  closed = termination.promise;
  child.once("close", (code) => termination.resolve(code));
  child.once("error", termination.reject);
  // Never print raw runtime logs/response bodies: provider failures can echo secrets.
  child.stderr.resume();
  let buffer = "";
  let sent = false;
  let commandSent = false;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "ready" && !sent) {
        sent = true;
        commandSent = Boolean(values.inspect || toolSetup === "fresh");
        child.stdin.write(
          `${JSON.stringify({ id: "service-smoke", type: "prompt", message: commandSent ? "/alinery-provider-smoke" : 'NATIVE_SESSION_SMOKE: Use write with path xd://service_smoke_echo and content {"value":"SERVICE_SMOKE_TOOL"} exactly once, then reply with its returned text. Do nothing else.' })}\n`,
        );
      }
      if (sent && !commandSent && event.type === "agent_end" && event.isTerminal !== false) {
        commandSent = true;
        child.stdin.write(`${JSON.stringify({ id: "service-boundary", type: "prompt", message: "/alinery-provider-smoke" })}\n`);
      }
      if (event.type === "extension_ui_request" && event.message === "ALINERY_PROVIDER_SMOKE_FINISHED") child.stdin.end();
    }
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 180_000);
  const forceKill = setTimeout(() => child.kill("SIGKILL"), 185_000);
  const code = await closed;
  clearTimeout(timeout);
  clearTimeout(forceKill);
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    throw new Error(`OMP exited (${code}) without a diagnostic report; check runtime/config access. Raw logs withheld.`);
  }
  console.log(JSON.stringify(report, null, 2));
  assert.equal(code, 0, "OMP did not exit cleanly");
  assert.equal(report.status, values.inspect ? "inspected" : "passed", "Provider smoke incomplete; completed checks above identify the last verified boundary");
  if (local) {
    assert.equal(requests, toolSetup === "fresh" ? 2 : 7, "Unexpected local provider request count");
    console.log(
      toolSetup === "fresh"
        ? "Local fresh-state tool roundtrip passed."
        : "Local native-provider smoke passed: streaming, tool roundtrip, denial, background settlement, cancellation and sealed admission.",
    );
  }
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await closed;
  }
  for (const socket of sockets) socket.destroy();
  fixture?.close();
  rmSync(root, { recursive: true, force: true });
}
