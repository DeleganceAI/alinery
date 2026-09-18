// One-command manual smoke for the real OMP extension -> alinery-runner result path.
//
// The local socket deliberately simulates three daemon outcomes for consecutive
// alinery_phase_complete calls: invalid outputs, acknowledgement timeout,
// then acceptance. It does not replace alineryd's semantic integration tests; it makes
// the model-visible OMP tool-result boundary deterministic and easy to inspect.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

const transportEnvironment = {
  ALINERY_SESSION_ID: sessionId,
  ALINERY_DAEMON_SOCKET: socketPath,
  ALINERY_DAEMON_NAMESPACE: "manual-completion-smoke",
  ALINERY_EVENT_PROTOCOL_VERSION: "2",
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

    if (request.op !== "event" || request.version !== Number(transportEnvironment.ALINERY_EVENT_PROTOCOL_VERSION) || request.session_id !== sessionId || request.token !== eventToken) {
      connection.end('{"error":"invalid-event-auth"}\n');
      return;
    }

    if (request.event?.type !== "phase_completed") {
      connection.end('{"ok":true}\n');
      return;
    }

    completionAttempts += 1;
    if (completionAttempts === 1) {
      connection.end('{"ok":true,"completion":{"status":"invalid_outputs","diagnostics":["Missing required output"]}}\n');
    } else if (completionAttempts === 2) {
      // Deliberately leave the connection unanswered. alinery-runner must time out,
      // and the OMP tool must render delivery_failed rather than false success.
    } else {
      connection.end('{"ok":true,"completion":{"status":"accepted","receipt_id":"manual-smoke-receipt"}}\n');
    }
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(socketPath, resolve);
});

function runResultEmit() {
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
    child.stdin.end(
      JSON.stringify({
        type: "phase_completed",
        omp_session_id: "omp-manual-smoke",
      }),
    );
  });
}

async function selfTest() {
  const results = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    results.push(await runResultEmit());
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
          diagnostics: ["Missing required output"],
        },
        stderr: "",
      },
      { code: 3, result: { status: "delivery_failed" }, stderr: "" },
      { code: 0, result: { status: "accepted", receipt_id: "manual-smoke-receipt" }, stderr: "" },
    ],
  );
  process.stdout.write("completion smoke fixture self-test passed: invalid_outputs -> delivery_failed -> accepted\n");
}

async function runOmpSmoke() {
  const ompBinary = process.env.OMP_BIN;
  if (!ompBinary || !path.isAbsolute(ompBinary)) throw new Error("Set OMP_BIN to the absolute packaged OMP binary path; PATH fallback is not allowed.");
  const prompt = [
    "This is an Alinery completion feedback smoke test.",
    "Call alinery_phase_complete exactly three times, even when an earlier call rejects or fails.",
    "After each call, state the exact tool result before making the next call.",
    "Do not use any other tools. After accepted completion do no further work; let ordinary OMP shutdown finish.",
  ].join(" ");

  process.stdout.write(
    [
      "Starting real OMP with a deterministic fake alineryd acknowledgement sequence:",
      "  1. invalid_outputs: Missing required output",
      "  2. delivery_failed: acknowledgement timeout",
      "  3. accepted",
      "Inspect the tool results and ordinary automatic exit. This fake-daemon smoke does not prove durable acceptance or successor gating.\n",
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
    throw new Error(`OMP emitted ${completionAttempts} completion attempt(s); expected exactly 3`);
  }
  process.stdout.write(`Observed all three authenticated phase-completion requests in the expected order (OMP exit ${code}).\n`);
}

try {
  if (process.argv.includes("--self-test")) {
    await selfTest();
  } else {
    await runOmpSmoke();
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
