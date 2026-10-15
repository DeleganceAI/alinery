import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const mode = process.argv[2] || 'handoff';
assert.ok(['handoff', 'compact', 'cancel-handoff', 'cancel-compact', 'cancel-saved-handoff'].includes(mode));
async function manualWorkflow(api, config, ctx) {
  const { SessionMaintenance } = await import('@oh-my-pi/pi-coding-agent/session/session-maintenance');
  const { SessionHandoff } = await import('@oh-my-pi/pi-coding-agent/session/session-handoff');
  const check = (value, message) => { if (!value) throw new Error(message); };
  const events = [], restores = [], active = new Set(), promises = [];
  const owners = new WeakMap();
  let binding, session, held = false, hold = false, committed = 0, replaced = 0;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const saved = config.manualMode === 'cancel-saved-handoff';
  let savedPath;
  const wait = async (promise) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native boundary missing')), 20000); })]); }
    finally { clearTimeout(timer); }
  };
  const decorate = (object, name, make) => {
    const original = object[name]; check(typeof original === 'function', `Missing ${name}`);
    object[name] = make(original); restores.push(() => { object[name] = original; });
  };
  let operation;
  try {
    for (const [prototype, getter] of [[SessionMaintenance.prototype, 'isCompacting'], [SessionHandoff.prototype, 'isGeneratingHandoff']]) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, getter);
      check(typeof descriptor?.get === 'function', `Missing ${getter}`);
      Object.defineProperty(prototype, getter, { ...descriptor, get() {
        if (binding) owners.set(this, binding);
        return descriptor.get.call(this);
      }});
      restores.push(() => Object.defineProperty(prototype, getter, descriptor));
    }
    for (const [prototype, name] of [[SessionMaintenance.prototype, 'compact'], [SessionMaintenance.prototype, 'handoff'], [SessionHandoff.prototype, 'generateDocument']]) {
      decorate(prototype, name, original => function (...args) {
        if (!session || owners.get(this) !== session) return original.apply(this, args);
        const token = `${name}:${promises.length}`;
        active.add(token); events.push({ type: 'admitted-before-original', token });
        const promise = original.apply(this, args);
        promises.push(promise);
        // Separate observation; return the exact native Promise, never await in native control flow.
        void promise.then(() => { active.delete(token); events.push({ type: 'native-fulfilled', token }); }, error => {
          active.delete(token); events.push({ type: 'native-rejected', token, error: String(error) });
        });
        return promise;
      });
    }
    ({ session } = await api.pi.createAgentSession({
      cwd: config.root, agentDir: config.agentDir, model: ctx.model, modelRegistry: ctx.modelRegistry,
      authStorage: ctx.modelRegistry.authStorage, autoApprove: true,
      sessionManager: api.pi.SessionManager.create(config.root, config.sessionsDir),
      settings: api.pi.Settings.isolated({ 'compaction.methodOrder': ['handoff', 'soft'], 'compaction.thresholdTokens': 50000, 'compaction.keepRecentTokens': 1000, 'compaction.handoffSaveToDisk': true }),
    }));
    binding = session;
    try { void session.isCompacting; void session.isGeneratingHandoff; } finally { binding = undefined; }
    await session.prompt('MANUAL_SEED: provide fixture context.');
    await session.sessionManager.flush();
    decorate(session.sessionManager, 'appendCompaction', original => function (...args) {
      check(active.size > 0, 'Commit unowned');
      const result = original.apply(this, args); committed++;
      events.push({ type: 'native-history-commit', active: [...active] }); return result;
    });
    decorate(session.agent, 'replaceMessages', original => function (...args) {
      if (committed) { check(active.size > 0, 'Context replacement unowned'); replaced++; }
      return original.apply(this, args);
    });
    decorate(ctx.modelRegistry, 'getApiKey', original => async function (...args) {
      const result = await original.apply(this, args);
      if (hold && !held && !saved) {
        held = true; events.push({ type: 'original-auth-result-held', active: [...active] }); entered.resolve();
        await release.promise;
      }
      return result;
    });
    if (saved) decorate(Bun, 'write', original => async function (...args) {
      if (typeof args[0] === 'string' && /handoff-.*\.md$/.test(args[0])) {
        check(active.size === 2, 'Original saved document write unowned');
        savedPath = args[0]; held = true;
        events.push({ type: 'original-native-write-held', active: [...active] }); entered.resolve();
        await release.promise;
      }
      return original.apply(this, args);
    });
    hold = true;
    const compact = config.manualMode.includes('compact');
    const cancelling = config.manualMode.startsWith('cancel-');
    const controller = new AbortController();
    operation = compact ? session.compact() : session.handoff(undefined, { signal: controller.signal, ...(saved ? { autoTriggered: true } : {}) });
    const outcome = operation.then(value => ({ value }), error => ({ error }));
    await wait(entered.promise);
    check(active.size > 0 && committed === 0, 'Lost manual scope before held prerequisite completed');
    if (saved) check(!(await Bun.file(savedPath).exists()), 'File written before original write released');
    check(promises.includes(operation), 'Public manual delegate did not return original promise');
    if (cancelling) {
      if (compact) session.abortCompaction(); else controller.abort(new Error('fixture-manual-cancel'));
      check(active.size > 0 && committed === 0, 'Cancellation falsely settled pending manual body');
      events.push({ type: 'cancelled-with-original-body-pending', active: [...active] });
    }
    release.resolve();
    const result = await wait(outcome);
    await Promise.allSettled(promises);
    await session.sessionManager.flush();
    if (cancelling && !saved) {
      check(result.error && committed === 0, 'Cancelled manual operation committed or succeeded');
    } else {
      check(!result.error && committed === 1 && replaced > 0, `Manual commit missing: ${String(result.error)}`);
      if (!compact && !saved) check(result.value.savedPath === undefined, 'Manual handoff unexpectedly saved automatic document');
      if (saved) {
        check(result.value.savedPath === savedPath, 'Native saved path lost');
        check((await Bun.file(savedPath).text()).trim() === result.value.document.trim(), 'Original saved document differs');
        events.push({ type: 'native-file-and-commit-after-cancel', active: [...active] });
      }
      const journal = await Bun.file(session.sessionManager.getSessionFile()).text();
      check(journal.includes('"type":"compaction"'), 'Native commit missing from flushed journal');
      check(session.sessionManager.getBranch().some(entry => entry.type === 'compaction'), 'Compaction absent from native branch');
    }
    check(active.size === 0, 'Original bodies did not settle');
    return { status: 'passed-bounded-manual-subset', mode: config.manualMode, committed, replaced, originalPromises: promises.length, error: result.error ? String(result.error) : undefined, events };
  } catch (error) { return { status: 'failed', error: String(error), committed, replaced, events }; }
  finally {
    release.resolve();
    if (operation) await operation.catch(() => {});
    if (session) await session.dispose();
    for (const restore of restores.reverse()) restore();
  }
}
let source = readFileSync(new URL('./external_maintenance_ownership_smoke.mjs', import.meta.url), 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), 'd691f6b15312dc940fde233140c86018f4fa105e2c6892dadb39b0cd918c7a9d');
const replace = (before, after) => { assert.equal(source.split(before).length, 2, before); source = source.replace(before, after); };
const start = source.indexOf('async function nativeWorkflow(');
const end = source.indexOf('\ntry {\n  await new Promise((resolve) => server.listen', start);
assert.ok(start >= 0 && end > start);
source = source.slice(0, start) + manualWorkflow.toString().replace('manualWorkflow', 'nativeWorkflow') + source.slice(end);
replace('root, agentDir, url, cancelSpeculation, queuedContinuation, sessionsDir:', `root, agentDir, url, manualMode: ${JSON.stringify(mode)}, cancelSpeculation, queuedContinuation, sessionsDir:`);
replace('"passed-bounded-speculation-subset", JSON.stringify(result.workflow)', '"passed-bounded-manual-subset", JSON.stringify(result.workflow)');
replace('scope: workflow ? "native-speculation-subset" : "module-access-only"', 'scope: "manual-original-bodies-only"');
replace('alinery-maintenance-access-', 'maintenance-manual-runtime-');
const temp = mkdtempSync(path.join(tmpdir(), 'maintenance-manual-derivative-'));
try {
  const script = path.join(temp, 'probe.mjs'); writeFileSync(script, source);
  console.log(JSON.stringify({ mode, derivativeSha256: createHash('sha256').update(source).digest('hex') }));
  const child = spawn(process.execPath, [script, '--workflow'], { env: process.env, stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
} finally { rmSync(temp, { recursive: true, force: true }); }
