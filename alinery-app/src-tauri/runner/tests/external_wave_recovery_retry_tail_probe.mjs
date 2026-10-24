import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const mode = process.argv[2] || 'local-error-abort';
assert.ok(['local-error-abort', 'normal', 'backoff-abort'].includes(mode));
async function retryWorkflow(api, config, ctx) {
  const { TurnRecovery } = await import('@oh-my-pi/pi-coding-agent/session/turn-recovery');
  const events = [], restores = [], active = new Set();
  const held = Promise.withResolvers(), release = Promise.withResolvers(), ended = Promise.withResolvers();
  let session, binding, recovery, saga, localContinue = false, abortDepth = 0, descendant = false, finalResolved = false;
  const check = (ok, text) => { if (!ok) throw new Error(text); };
  const wait = async (promise) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Missing native boundary')), 25000); })]); }
    finally { clearTimeout(timer); }
  };
  const wrap = (target, name, factory) => {
    const original = target[name]; check(typeof original === 'function', `Missing ${name}`);
    target[name] = factory(original); restores.push(() => { target[name] = original; });
  };
  const desc = Object.getOwnPropertyDescriptor(TurnRecovery.prototype, 'attempt');
  Object.defineProperty(TurnRecovery.prototype, 'attempt', { ...desc, get() {
    if (binding) { check(!recovery || recovery === this, 'Owner mismatch'); recovery = this; }
    return desc.get.call(this);
  }});
  restores.push(() => Object.defineProperty(TurnRecovery.prototype, 'attempt', desc));
  try {
    ({ session } = await api.pi.createAgentSession({ cwd: config.root, agentDir: config.agentDir,
      model: ctx.model, thinkingLevel: 'off', authStorage: ctx.modelRegistry.authStorage,
      modelRegistry: ctx.modelRegistry, sessionManager: api.pi.SessionManager.create(config.root, config.sessionsDir),
      settings: api.pi.Settings.isolated({}) }));
    binding = session; check(session.retryAttempt === 0, 'Initial retry'); binding = undefined;
    check(recovery, 'Missing actual recovery receiver');
    wrap(session.sessionManager, 'appendMessage', original => function(...args) {
      const result = original.apply(this, args);
      events.push({ type: 'original-message-appended', role: args[0]?.role, stopReason: args[0]?.stopReason, descendant, active: [...active] });
      return result;
    });
    wrap(recovery, 'handleRetryableError', original => async function(...args) {
      active.add('retry-invocation');
      try {
        await fetch(config.url + '/native-retry-enter');
        const result = original.apply(this, args);
        saga = this.retryPromise;
        check(saga, 'Original retry did not allocate saga');
        events.push({ type: 'original-retry-enter', stopReason: args[0].stopReason });
        return await result;
      } finally { active.delete('retry-invocation'); events.push({ type: 'retry-invocation-return', active: [...active] }); }
    });
    wrap(recovery, 'abortRetry', original => function(...args) {
      abortDepth++;
      try { return original.apply(this, args); } finally { abortDepth--; }
    });
    wrap(recovery, 'resolveRetry', original => function(...args) {
      const value = original.apply(this, args);
      events.push({ type: 'resolve-retry', abortDepth, descendant, active: [...active] });
      if (descendant && abortDepth === 0) { finalResolved = true; active.delete('void-descendant'); ended.resolve(); }
      return value;
    });
    wrap(recovery, 'persistTerminalEmptyErrorTurn', original => async function(...args) {
      if (!localContinue) return original.apply(this, args);
      check(!descendant, 'Unexpected second terminal descendant');
      descendant = true; active.add('void-descendant');
      events.push({ type: 'native-descendant-before-persist', attempt: this.attempt, active: [...active] });
      held.resolve(); await release.promise;
      await original.apply(this, args);
      events.push({ type: 'original-terminal-persist-return', active: [...active] });
    });
    wrap(session.agent, 'continue', original => function(...args) {
      if (config.retryMode === 'local-error-abort') {
        // Deliberate fixture input: an empty active context at the real scheduled entry.
        // The original Agent.continue creates the error; no callback/error/writer is replaced.
        this.replaceMessages([]); localContinue = true;
        events.push({ type: 'fixture-empty-active-context-before-original-continue' });
      }
      return original.apply(this, args);
    });
    wrap(recovery, 'removeAssistantMessageFromActiveContext', original => function(...args) {
      const result = original.apply(this, args);
      if (config.retryMode === 'backoff-abort' && args[1] === 'auto-retry') {
        queueMicrotask(() => held.resolve());
      }
      return result;
    });
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'auto_retry_start') {
        events.push({ type: event.type, delayMs: event.delayMs, attempt: event.attempt });
      }
      if (event.type === 'auto_retry_end') {
        events.push({ type: event.type, success: event.success, finalError: event.finalError, active: [...active] });
        if (config.retryMode !== 'local-error-abort') ended.resolve();
      }
    }); restores.push(unsubscribe);
    const prompt = session.prompt('RECOVERY_RETRY_TAIL: answer briefly.');
    void prompt.catch(() => {});
    if (config.retryMode === 'local-error-abort') {
      await wait(held.promise);
      check(descendant && !active.has('retry-invocation'), 'Expected detached descendant after retry invocation');
      recovery.abortRetry();
      await wait(saga);
      check(active.has('void-descendant') && !finalResolved, 'Abort incorrectly joined descendant');
      events.push({ type: 'saga-settled-before-original-terminal-persistence', active: [...active] });
      release.resolve(); await wait(ended.promise);
      check(events.some(e => e.type === 'auto_retry_end' && e.finalError?.includes('No messages to continue from')), 'Missing original local continuation failure');
    } else if (config.retryMode === 'backoff-abort') {
      await wait(held.promise);
      // Native synchronous code installs its controller and enters scheduler.wait
      // before the microtask queued at original active-context removal runs.
      recovery.abortRetry(); await wait(saga);
      events.push({ type: 'abort-during-native-backoff', active: [...active] });
      await wait(ended.promise);
      check(events.some(e => e.type === 'auto_retry_end' && e.finalError === 'Retry cancelled'), 'Missing native backoff cancellation');
    }
    await wait(prompt); await session.sessionManager.flush();
    const journal = await Bun.file(session.sessionManager.getSessionFile()).text();
    check(journal.includes('RECOVERY_RETRY_TAIL'), 'Missing real native journal');
    check(events.some(e => e.type === 'auto_retry_start'), 'No native automatic retry');
    if (config.retryMode === 'normal') check(events.some(e => e.type === 'auto_retry_end' && e.success === true), 'No native retry recovery success');
    if (config.retryMode === 'local-error-abort') {
      check(journal.includes('Provider returned error finish_reason'), 'Missing persisted native provider error');
      check(finalResolved && active.size === 0, 'Final local boundary not observed');
    }
    return { status: 'passed-bounded-retry-subset', mode: config.retryMode, events, finalResolved, journalHasProviderError: journal.includes('Provider returned error finish_reason'), limitation: 'Single receiver; terminal resolve hook is not original descendant Promise or general event-handler join' };
  } catch(error) { return { status: 'failed', error: String(error), events, active: [...active] }; }
  finally { release.resolve(); if(session) await session.dispose(); for(const restore of restores.reverse()) restore(); }
}
const base = new URL('./external_maintenance_ownership_smoke.mjs', import.meta.url);
let source = readFileSync(base, 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), 'd691f6b15312dc940fde233140c86018f4fa105e2c6892dadb39b0cd918c7a9d');
const replace = (a,b) => { assert.equal(source.split(a).length, 2, `Missing/ambiguous anchor ${a}`); source = source.replace(a,b); };
const start = source.indexOf('async function nativeWorkflow('), end = source.indexOf('\ntry {\n  await new Promise((resolve) => server.listen', start);
assert.ok(start >= 0 && end > start);
source = source.slice(0,start) + retryWorkflow.toString().replace('retryWorkflow', 'nativeWorkflow') + source.slice(end);
replace('let primaryRequests = 0;', 'let primaryRequests = 0;\nlet nativeRetryEntered = false;');
replace('const server = createServer(async (request, response) => {', "const server = createServer(async (request, response) => {\n  if (request.url === '/native-retry-enter') { nativeRetryEntered = true; response.end('{}'); return; }");
replace('const text = primary\n      ? Array.from({ length: 180 }, (_, index) => `${index}: ${createHash("sha256").update(`native-context-${index}`).digest("hex")}`).join("\\n")\n      : "Native speculative handoff document: preserve the fixture investigation.";', 'const text = nativeRetryEntered ? "Native retry recovered answer." : "";');
replace('finish_reason: "stop"', 'finish_reason: nativeRetryEntered ? "stop" : "error"');
replace('root, agentDir, url, cancelSpeculation, queuedContinuation, sessionsDir:', `root, agentDir, url, retryMode: ${JSON.stringify(mode)}, cancelSpeculation, queuedContinuation, sessionsDir:`);
replace('"passed-bounded-speculation-subset", JSON.stringify(result.workflow)', '"passed-bounded-retry-subset", JSON.stringify(result.workflow)');
replace('scope: workflow ? "native-speculation-subset" : "module-access-only"', 'scope: "native-retry-tail"');
replace('"alinery-maintenance-access-"', '"recovery-retry-tail-host-"');
const temporary = mkdtempSync(path.join(tmpdir(), 'recovery-retry-tail-derivative-'));
try {
  const script = path.join(temporary, 'probe.mjs'); writeFileSync(script, source);
  console.log(JSON.stringify({ mode, derivativeSha256: createHash('sha256').update(source).digest('hex') }));
  const child = spawn(process.execPath, [script, '--workflow'], { env: process.env, stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error',reject); child.once('close',resolve); });
} finally { rmSync(temporary, { recursive:true, force:true }); }
