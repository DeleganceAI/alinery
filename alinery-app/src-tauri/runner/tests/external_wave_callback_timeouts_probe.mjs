// Isolated derivative: real registered extension tail, not a built-in late writer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const base = new URL('./external_owner_jobs_smoke.mjs', import.meta.url);
let text = readFileSync(base, 'utf8');
assert.equal(hash(text), '500e7f4a14db1447f80d09a0d1b32374ba6566a566b26b6be96f2107ed78b1d1');
assert.equal(hash(readFileSync('/Applications/Alinery.omp/omp')), '9d4b74e20502f06348143fc3fbd630326d16c1a11a7eb0a94b44e5818aa78e47');
const abortMode = process.argv.includes('--abort');
assert.ok(process.argv.slice(2).every(arg => arg === '--abort'), 'Unknown argument');
function installProbe(api, config) {
  const post = async (route, body = {}) => {
    const response = await fetch(config.url + route, { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) throw new Error('Loopback request failed');
    return response.json();
  };
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  api.registerTool({
    name: 'owner_probe', label: 'Callback timeout probe', description: 'Exercise a real registered callback timeout',
    parameters: api.zod.z.object({}), loadMode: 'essential',
    async execute(_id, _input, _signal, _update, ctx) {
      let session;
      const active = new Set();
      const latch = Promise.withResolvers();
      const entered = Promise.withResolvers();
      const settled = Promise.withResolvers();
      const timedOut = Promise.withResolvers();
      let originalPromise;
      let returnedPromise;
      let owner;
      const syncError = new Error('callback-timeouts synchronous handler error');
      let syncReturns = 0;
      let syncThrows = 0;
      let nativeSyncError = false;
      const factory = extension => {
        const originalOn = extension.on;
        // A synchronous registration decorator on this actual public API object.
        extension.on = function(event, handler) {
          return Reflect.apply(originalOn, this, [event, function(...args) {
            check(owner && args[1].sessionManager.getSessionId() === session.sessionManager.getSessionId(), 'Wrong actual session binding');
            const lease = { owner, event };
            active.add(lease);
            let result;
            try { result = Reflect.apply(handler, this, args); }
            catch (error) {
              active.delete(lease);
              if (error === syncError) syncThrows++;
              throw error;
            }
            if (result instanceof Promise) {
              returnedPromise = result;
              // Native already awaits this Promise. Do not replace it or delay dispatch.
              result.then(() => { active.delete(lease); settled.resolve(); }, error => { active.delete(lease); settled.reject(error); });
            } else {
              // This fixture's other original handler returns undefined, not a thenable.
              active.delete(lease);
              syncReturns++;
            }
            return result;
          }]);
        };
        try {
          extension.on('session_stop', function() {
            originalPromise = (async () => {
              check(active.size === 1, 'Callback effects preceded admission');
              entered.resolve();
              await latch.promise;
              check(active.size === 1, 'Timeout released actual handler');
              const fs = await import('node:fs/promises');
              await fs.writeFile(config.root + '/callback-tail', 'registered extension tail\n');
            })();
            return originalPromise;
          });
          extension.on('session_stop', () => undefined);
          extension.on('session_stop', () => { throw syncError; });
        } finally { extension.on = originalOn; }
      };
      try {
        ({ session } = await api.pi.createAgentSession({
          cwd: config.root, agentDir: config.agentDir, agentId: 'CallbackTimeoutOwner',
          model: ctx.model, modelRegistry: ctx.modelRegistry, authStorage: ctx.modelRegistry.authStorage,
          settings: api.pi.Settings.isolated({}), autoApprove: true,
          sessionManager: api.pi.SessionManager.create(config.root, config.sessionsDir), extensions: [factory],
        }));
        owner = session.getAgentId();
        const unsubscribe = session.extensionRunner.onError(error => {
          if (error.event === 'session_stop' && error.error === 'handler timed out after 30000ms') timedOut.resolve(error);
          if (error.event === 'session_stop' && error.error === syncError.message) nativeSyncError = true;
        });
        const prompt = session.prompt('Answer briefly for the callback timeout diagnostic.');
        await entered.promise;
        check(originalPromise === returnedPromise, 'Original handler Promise identity changed');
        let timeout;
        if (config.abort) {
          await session.abort();
          timeout = { error: 'original session.abort returned' };
        } else timeout = await timedOut.promise;
        await prompt;
        check(active.size === 1, 'Native timeout/prompt return released handler');
        if (!config.abort) check(syncReturns === 1 && syncThrows === 1 && nativeSyncError, 'Original synchronous return/error handling changed');
        const fs = await import('node:fs/promises');
        let absent = false;
        try { await fs.stat(config.root + '/callback-tail'); } catch (e) { if (e.code === 'ENOENT') absent = true; else throw e; }
        check(absent, 'Writer passed unreleased latch');
        await post('/trace', { type: 'callback-timeout-held', mode: config.abort ? 'abort' : 'timeout', owner, timeout: timeout.error, active: active.size, samePromise: originalPromise === returnedPromise, promptReturned: true, fileAbsent: absent, syncReturns, syncThrows, nativeSyncError });
        latch.resolve();
        await settled.promise;
        check(active.size === 0, 'Callback lease leaked');
        check(await fs.readFile(config.root + '/callback-tail', 'utf8') === 'registered extension tail\n', 'Late extension write missing');
        unsubscribe();
        await post('/trace', { type: 'outcome', status: 'passed-supported-subset', bounded: 'real session_stop interruption retained actual callback until its late extension write settled', limitations: 'No generic all-factory deployment, compact consumer, void descendant, rejection transparency or durable authority proof' });
      } catch (error) {
        await post('/trace', { type: 'fixture-error', error: String(error) });
        throw error;
      } finally {
        latch.resolve();
        if (session) await session.dispose();
        await post('/trace', { type: 'owned-sessions-disposed' });
      }
      return { content: [{ type: 'text', text: 'Bounded callback timeout diagnostic complete' }] };
    },
  });
}
function replaceOnce(a, b) {
  assert.equal(text.split(a).length, 2, 'Derivative anchor missing or ambiguous');
  text = text.replace(a, b);
}
replaceOnce('      url,\n      root,', `      url,\n      abort: ${abortMode},\n      root,`);
const start = text.indexOf('function installProbe(api, config) {');
const end = text.indexOf('\n\ntry {\n  assert.match', start);
assert.ok(start > 0 && end > start);
text = text.slice(0, start) + installProbe.toString() + text.slice(end);
const verifyStart = text.indexOf('    for (const owner of ["A", "B"]) assert.equal');
const verifyEnd = text.indexOf('\n  }\n  console.log(', verifyStart);
assert.ok(verifyStart > 0 && verifyEnd > verifyStart);
text = text.slice(0, verifyStart) + `    assert.equal(readFileSync(path.join(root, 'callback-tail'), 'utf8'), 'registered extension tail\\n');\n    assert.ok(events.some(event => event.type === 'callback-timeout-held'));\n    process.exitCode = 3;` + text.slice(verifyEnd);
replaceOnce('"watched-live",\n', '"callback-timeout-held",\n            "watched-live",\n');
replaceOnce('alinery-owner-jobs-', 'callback-timeouts-native-');
const root = mkdtempSync(path.join(tmpdir(), 'callback-timeouts-derivative-'));
try {
  const file = path.join(root, 'probe.mjs');
  writeFileSync(file, text);
  console.log(JSON.stringify({ derivativeSha256: hash(text), status: 'starting-bounded-callback-timeout' }));
  const child = spawn(process.execPath, [file], { stdio: 'inherit', env: process.env });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
} finally { rmSync(root, { recursive: true, force: true }); }
