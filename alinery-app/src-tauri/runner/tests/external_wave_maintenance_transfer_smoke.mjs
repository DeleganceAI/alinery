import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const base = new URL('./external_maintenance_ownership_smoke.mjs', import.meta.url);
let source = readFileSync(base, 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), 'd691f6b15312dc940fde233140c86018f4fa105e2c6892dadb39b0cd918c7a9d');
function replace(before, after) {
  assert.equal(source.split(before).length, 2, `Expected unique anchor: ${before}`);
  source = source.replace(before, after);
}
replace('  const owner = {};', `  const owner = {};
  const receivers = new WeakMap();
  const observers = [];
  const observerFaults = [];
  let binding;
  let automaticIdleLease;
  const descriptor = Object.getOwnPropertyDescriptor(SessionMaintenance.prototype, 'isCompacting');
  Object.defineProperty(SessionMaintenance.prototype, 'isCompacting', {
    ...descriptor,
    get() {
      if (binding) {
        if (receivers.has(this) && receivers.get(this) !== binding) throw new Error('Conflicting receiver');
        receivers.set(this, binding);
      }
      return descriptor.get.call(this);
    }
  });`);
replace('    // Uniform public method delegation: no private instance or listener access.', `    restores.push(() => Object.defineProperty(SessionMaintenance.prototype, 'isCompacting', descriptor));
    // Uniform public method delegation: no private instance or listener access.`);
// Existing inner fixture latches now use actual maintenance receiver binding.
source = source.replaceAll('if (scope.getStore() !== owner) return original.apply(this, args);', 'if (!receivers.has(this)) return original.apply(this, args);');
// Handoff routing is inherited only from the automatic maintenance invocation, not a caller-owned workflow.
replace('          if (!receivers.has(this)) return original.apply(this, args);\n          const id = enter("generateDocument");', '          if (scope.getStore() !== owner) return original.apply(this, args);\n          const id = enter("generateDocument");');
replace('    await scope.run(owner, async () => {', `    for (const name of ['runIdleCompaction', 'runPrePromptCompactionIfNeeded', 'maintainContextMidRun', 'checkCompaction', 'runAutoCompaction']) {
      decorate(SessionMaintenance.prototype, name, original => function (...args) {
        const actualSession = receivers.get(this);
        if (!actualSession) return original.apply(this, args);
        const id = enter('automatic-' + name);
        if (name === 'runIdleCompaction') automaticIdleLease = id;
        let result;
        try { result = scope.run(owner, () => Reflect.apply(original, this, args)); }
        catch (error) { observerFaults.push(String(error)); throw error; }
        const observer = result.then(async () => {
          events.push({ type: 'automatic-method-return', name, id, active: [...active] });
          // Side observation only. Never return this join to native awaited children.
          await actualSession.waitForIdle();
          leave(id);
        }, error => { observerFaults.push(String(error)); });
        observers.push(observer.catch(error => { observerFaults.push(String(error)); }));
        return result;
      });
    }
    await (async () => {`);
replace('      const originalAppend = session.sessionManager.appendCompaction;', `      binding = session;
      try { void session.isCompacting; } finally { binding = undefined; }
      events.push({ type: 'receiver-bound', sessionId: session.sessionManager.getSessionId() });
      const originalAppend = session.sessionManager.appendCompaction;`);
replace('      check(active.size === 0, "Scoped work remained after real settlement");', '      await Promise.all(observers);\n      check(active.size === 0, "Scoped work remained after real settlement");');
replace('          rootLease = enter("idle-maintenance-and-pending-continuation");', '          // No explicit caller lease: the native maintenance entry must supply it.');
replace('        await wait(next, "native maintenance invoking method");', `        await wait(next, "native maintenance invoking method");
        rootLease = automaticIdleLease;
        check(rootLease && active.has(rootLease), 'Automatic ownership missing at native method return');
        events.push({ type: 'return-fence-blocked', active: [...active], automaticIdleLease: rootLease });`);
replace('          leave(rootLease);', `          await Promise.all(observers);
          check(!active.has(rootLease), 'Automatic observer failed to settle');
          check(observerFaults.length === 0, 'Automatic observer failure: ' + observerFaults.join(';'));`);
replace('    });\n    return { status: "passed-bounded-speculation-subset"', '    })();\n    return { status: "passed-bounded-speculation-subset"');
const root = mkdtempSync(path.join(os.tmpdir(), 'maintenance-transfer-'));
const file = path.join(root, 'external_wave_maintenance_transfer_derivative.mjs');
writeFileSync(file, source);
console.log(JSON.stringify({ derivativeSha256: createHash('sha256').update(source).digest('hex'), candidate: 'automatic receiver-bound maintenance side-join' }));
try {
  const child = spawn(process.execPath, [file, '--queued-continuation'], { stdio: 'inherit', env: process.env });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  process.exitCode = code ?? 1;
} finally { rmSync(root, { recursive: true, force: true }); }
