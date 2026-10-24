import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Reuse only the retained fixture's launcher, SDK bootstrap, isolation and loopback provider.
// No native implementation is copied. Outer exit 3 means coverage remains incomplete.
async function nativeWorkflow(api, config, ctx) {
  const fs = await import('node:fs');
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const { session } = await api.pi.createAgentSession({
    cwd: config.root, agentDir: config.agentDir, model: ctx.model,
    modelRegistry: ctx.modelRegistry, authStorage: ctx.modelRegistry.authStorage,
    autoApprove: true,
    sessionManager: api.pi.SessionManager.create(config.root, config.sessionsDir),
    settings: api.pi.Settings.isolated({}),
  });
  const results = [];
  try {
    for (const method of ['executeBash', 'executePython']) {
      const marker = `${config.root}/${method}.marker`;
      const original = session[method];
      const entered = Promise.withResolvers();
      const grant = Promise.withResolvers();
      const active = new Set();
      let sealed = false;
      let forwarded = 0;
      const denied = new Error(`ingress sealed: ${method}`);
      // The real session receiver is the owner. Reserve synchronously, before
      // awaiting permission or invoking any part of the original method.
      session[method] = async function (...args) {
        assert(this === session, 'Foreign owner receiver');
        if (sealed) throw denied;
        const reservation = {};
        active.add(reservation);
        entered.resolve();
        await grant.promise;
        try {
          forwarded++;
          return await original.apply(this, args);
        } finally { active.delete(reservation); }
      };
      const source = method === 'executeBash'
        ? `printf native-bash > '${marker}'; printf ingress-native-error >&2; exit 7`
        : `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('native-python')\nraise ValueError('ingress-native-error')`;
      const pending = session[method](source);
      await entered.promise;
      assert(active.size === 1 && forwarded === 0 && !fs.existsSync(marker), 'Effect before admission');
      sealed = true;
      let rejected;
      try { await session[method](source); } catch (error) { rejected = error; }
      assert(rejected === denied && forwarded === 0, 'Fresh ingress not refused exactly');
      assert(active.size === 1, 'Already admitted work dropped');
      grant.resolve();
      const result = await pending;
      assert(forwarded === 1 && active.size === 0 && fs.existsSync(marker), 'Original admitted work did not finish');
      assert(result.output.includes('ingress-native-error'), 'Native error output lost');
      assert(result.exitCode !== 0, 'Native error converted into success');
      if (method === 'executeBash') assert(result.exitCode === 7, 'Native bash exit changed');
      results.push({ method, heldBeforeOriginal: true, retainedAcrossSeal: true, rejectedSameError: true,
        nativeErrorPreserved: true, exitCode: result.exitCode, marker: fs.readFileSync(marker, 'utf8'),
        owner: session.sessionId });
      session[method] = original;
    }
    const dequeueEntered = Promise.withResolvers();
    const dequeueGrant = Promise.withResolvers();
    let modelCalls = 0;
    let rootReserved = true; // Admission precedes the original enqueue, not just dequeue.
    const removeModel = session.agent.addBeforeModelCallHook(() => {
      assert(rootReserved, 'Resumed model escaped root');
      modelCalls++;
    });
    const removeQueue = session.agent.addBeforeQueuedMessageDequeueHook(async () => {
      assert(rootReserved, 'Queued work escaped root');
      dequeueEntered.resolve();
      await dequeueGrant.promise;
    });
    const queuedText = 'INGRESS_COVERAGE_EXACT_QUEUED_STEER';
    await session.steer(queuedText);
    await dequeueEntered.promise;
    assert(modelCalls === 0, 'Model ran before dequeue admission');
    assert(JSON.stringify(session.agent.peekSteeringQueue()).includes(queuedText), 'Held queue lost exact input');
    dequeueGrant.resolve();
    await session.agent.waitForIdle();
    assert(modelCalls > 0 && JSON.stringify(session.messages).includes(queuedText), 'Useful queued steer failed to resume');
    assert(session.agent.peekSteeringQueue().length === 0, 'Admitted queue failed to drain');
    rootReserved = false;
    removeQueue();
    removeModel();
    results.push({ method: 'automatic-idle-steer', heldBeforeDequeue: true,
      exactQueuedTextRetained: true, resumedWithRoot: true, modelCalls,
      limitation: 'Explicit caller root; not inferred lifetime from dequeue hook return' });
    return { status: 'passed-bounded-nonchat-subset', results,
      limitations: ['SDK-instance installation only', 'No durable admission', 'No CLI PTY runtime test',
        'Original method settlement can enqueue deferred transcript work; not universal settlement',
        'No detached producer join', 'Follow-up/retry/command all-entry coverage remains separate'] };
  } finally { await session.dispose(); }
}
const originalPath = 'alinery-app/src-tauri/runner/tests/external_maintenance_ownership_smoke.mjs';
const original = readFileSync(originalPath, 'utf8');
assert.equal(createHash('sha256').update(original).digest('hex'), 'd691f6b15312dc940fde233140c86018f4fa105e2c6892dadb39b0cd918c7a9d');
const start = original.indexOf('async function nativeWorkflow(');
const end = original.indexOf('\ntry {\n  await new Promise((resolve) => server.listen', start);
assert.ok(start > 0 && end > start);
let derivative = original.slice(0, start) + nativeWorkflow.toString() + original.slice(end);
derivative = derivative.replace('passed-bounded-speculation-subset', 'passed-bounded-nonchat-subset')
  .replace('native-speculation-subset', 'native-nonchat-ingress-subset')
  .replace('nativeMaintenanceExecuted: workflow', 'nativeNonchatExecuted: workflow')
  .replace('alinery-maintenance-access-', 'ingress-coverage-native-');
const root = mkdtempSync(path.join(tmpdir(), 'ingress-coverage-driver-'));
const file = path.join(root, 'driver.mjs');
writeFileSync(file, derivative);
console.log(JSON.stringify({ ingressCoverage: 'starting', derivativeSha256: createHash('sha256').update(derivative).digest('hex') }));
try {
  const child = spawn(process.execPath, [file, '--workflow'], { stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
} finally { rmSync(root, { recursive: true, force: true }); }
