import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function pruningWorkflow(api, config, ctx) {
  const { SessionMaintenance } = await import('@oh-my-pi/pi-coding-agent/session/session-maintenance');
  const fs = await import('node:fs/promises');
  const restores = [], events = [], active = new Map();
  let session, binding, receiver, ordinal = 0, admission, rewrite, artifact;
  const check = (ok, why) => { if (!ok) throw new Error(why); };
  const gates = [];
  const gate = () => { const value = { entered: Promise.withResolvers(), release: Promise.withResolvers() }; gates.push(value); return value; };
  const wait = async (p) => { let t; try { return await Promise.race([p, new Promise((_, reject) => { t = setTimeout(() => reject(new Error('Native boundary timeout')), 20000); })]); } finally { clearTimeout(t); } };
  const decorate = (object, name, wrap) => { const original = object[name]; check(typeof original === 'function', `Missing ${name}`); object[name] = wrap(original); restores.push(() => { object[name] = original; }); };
  const branch = () => session.sessionManager.getBranch();
  const snapshot = () => JSON.stringify(branch());
  const owned = () => { check(active.size > 0, 'Native effect without entry ownership'); return [...active.values()]; };
  const descriptor = Object.getOwnPropertyDescriptor(SessionMaintenance.prototype, 'isCompacting');
  Object.defineProperty(SessionMaintenance.prototype, 'isCompacting', { ...descriptor, get() { if (binding) receiver = this; return descriptor.get.call(this); } });
  restores.push(() => Object.defineProperty(SessionMaintenance.prototype, 'isCompacting', descriptor));
  try {
    for (const name of ['checkCompaction', 'shake', 'dropImages']) decorate(SessionMaintenance.prototype, name, original => async function(...args) {
      if (this !== receiver) return original.apply(this, args);
      const id = ++ordinal, ownerFile = session.sessionManager.getSessionFile();
      active.set(id, { id, name, ownerFile });
      const before = snapshot();
      events.push({ type: 'entry', id, name, ownerFile });
      try {
        if (admission) { const g = admission; admission = undefined; g.before = before; g.entered.resolve(); await g.release.promise; check(snapshot() === before, 'Mutation before admission release'); }
        return await original.apply(this, args);
      } finally { events.push({ type: 'settled', id, name }); active.delete(id); }
    });
    ({ session } = await api.pi.createAgentSession({ cwd: config.root, agentDir: config.agentDir, model: ctx.model, modelRegistry: ctx.modelRegistry, authStorage: ctx.modelRegistry.authStorage, autoApprove: true, sessionManager: api.pi.SessionManager.create(config.root, config.sessionsDir), settings: api.pi.Settings.isolated({}) }));
    binding = session; try { void session.isCompacting; } finally { binding = undefined; }
    check(receiver, 'Missing actual receiver binding');
    let pendingSync = false;
    decorate(session.sessionManager, 'rewriteEntries', original => async function(...args) {
      const owners = owned(); events.push({ type: 'rewrite-before-original', owners, pruned: branch().filter(e => e.message?.prunedAt !== undefined).length });
      if (rewrite) { const g = rewrite; rewrite = undefined; g.entered.resolve(); await g.release.promise; }
      const value = await original.apply(this, args); pendingSync = true; events.push({ type: 'rewrite-returned', owners: owned() }); return value;
    });
    decorate(session.agent, 'replaceMessages', original => function(...args) {
      if (pendingSync) { owned(); pendingSync = false; }
      const value = original.apply(this, args);
      events.push({ type: 'live-sync-returned', owners: [...active.values()] });
      return value;
    });
    decorate(session.sessionManager, 'saveArtifact', original => async function(...args) {
      const owners = owned();
      const value = await original.apply(this, args);
      const artifactPath = await this.getArtifactPath(value);
      check(artifactPath && (await fs.readFile(artifactPath, 'utf8')) === args[0], 'Original native artifact bytes missing');
      events.push({ type: 'native-artifact-saved', artifactId: value, artifactPath, owners: owned() });
      if (artifact) { const g = artifact; artifact = undefined; g.content = args[0]; g.entered.resolve(); await g.release.promise; }
      return value;
    });
    await fs.writeFile(`${config.root}/pruning-input.txt`, Array.from({length: 60}, (_, i) => `${i} native fixture line ${i * 7919}: ${String(i).padStart(4, '0')}`).join('\n'));
    await session.prompt('PRUNING_READ_ONE'); await session.waitForIdle();
    const oldRead = branch().find(e => e.message?.role === 'toolResult' && e.message.toolName === 'read');
    check(oldRead && oldRead.message.prunedAt === undefined, 'First actual native read missing');
    const oldText = JSON.stringify(oldRead.message.content);
    admission = gate(); const admissionGate = admission;
    rewrite = gate(); const pruneRewrite = rewrite;
    const second = session.prompt('PRUNING_READ_TWO');
    await wait(admissionGate.entered.promise);
    check(JSON.stringify(oldRead.message.content) === oldText, 'Stale read mutated before admission');
    admissionGate.release.resolve();
    await wait(pruneRewrite.entered.promise);
    check(oldRead.message.prunedAt !== undefined && JSON.stringify(oldRead.message.content) !== oldText, 'Native stale pruning not reached before rewrite');
    events.push({type:'stale-prune-before-persistence', owners: owned()});
    pruneRewrite.release.resolve(); await second; await session.waitForIdle(); await session.sessionManager.flush();
    check((await fs.readFile(session.sessionManager.getSessionFile(), 'utf8')).includes('prunedAt'), 'Pruning not persisted');

    await session.prompt('PRUNING_HEAVY'); await session.waitForIdle();
    await session.prompt('PRUNING_HEAVY_PADDING'); await session.waitForIdle();
    const thinking = branch().filter(e => e.message?.role === 'assistant').flatMap(e => e.message.content).filter(b => b.type === 'thinking');
    check(thinking.length > 0, 'Native provider thinking missing');
    admission = gate(); const thinkAdmission = admission; rewrite = gate(); const thinkRewrite = rewrite;
    const shaking = session.shake('thinking'); await wait(thinkAdmission.entered.promise); thinkAdmission.release.resolve(); await wait(thinkRewrite.entered.promise);
    check(!branch().some(e => e.message?.role === 'assistant' && e.message.content.some(b => b.type === 'thinking')), 'Thinking not removed before rewrite');
    thinkRewrite.release.resolve(); const thinkingResult = await shaking;
    check(thinkingResult.thinkingBlocksDropped > 0, 'No native thinking removal');

    await session.prompt('PRUNING_IMAGE', {images:[{type:'image', mimeType:'image/png', data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII='}]}); await session.waitForIdle();
    const imageCount = () => branch().reduce((n,e) => n + (Array.isArray(e.message?.content) ? e.message.content.filter(b => b.type === 'image').length : 0), 0);
    check(imageCount() > 0, 'Native user image missing');
    admission = gate(); const imageAdmission = admission; rewrite = gate(); const imageRewrite = rewrite;
    const images = session.shake('images'); await wait(imageAdmission.entered.promise); check(imageCount() > 0, 'Image removed before admission'); imageAdmission.release.resolve(); await wait(imageRewrite.entered.promise); check(imageCount() === 0, 'Image not removed before rewrite'); imageRewrite.release.resolve(); const imageResult = await images; check(imageResult.imagesDropped > 0, 'Image result missing');

    artifact = gate(); const save = artifact; rewrite = gate(); const elideRewrite = rewrite;
    const beforeElide = snapshot(); const eliding = session.shake('elide'); await wait(save.entered.promise);
    check(snapshot() === beforeElide, 'Elide mutated before artifact await');
    check(save.content.includes('native-heavy'), 'Artifact does not contain original native answer');
    events.push({type:'finalization-blocked-at-artifact', owners: owned()});
    save.release.resolve(); await wait(elideRewrite.entered.promise); check(snapshot().includes('artifact://'), 'Native elide did not install recovery link'); elideRewrite.release.resolve(); const elideResult = await eliding;
    check(elideResult.blocksDropped > 0 && elideResult.artifactId, 'No native elide result');
    await session.sessionManager.flush();
    const persisted = await fs.readFile(session.sessionManager.getSessionFile(), 'utf8'); check(persisted.includes('artifact://'), 'Elide absent from journal');

    await session.prompt('PRUNING_HEAVY_AGAIN'); await session.waitForIdle();
    artifact = gate(); const transitionSave = artifact;
    const oldEntries = branch(); const oldFile = session.sessionManager.getSessionFile(); const oldBefore = JSON.stringify(oldEntries);
    const crossing = session.shake('elide'); await wait(transitionSave.entered.promise);
    check(active.size === 1, 'Unexpected overlapping maintenance');
    check(await session.newSession(), 'Native newSession refused');
    const newFile = session.sessionManager.getSessionFile(); check(newFile !== oldFile, 'Native session identity unchanged');
    check([...active.values()].every(o => o.ownerFile === oldFile), 'Outstanding ownership relabelled');
    events.push({type:'native-session-transition-during-elide', oldFile, newFile, owners: owned()});
    transitionSave.release.resolve(); const crossingResult = await crossing;
    check(JSON.stringify(oldEntries) !== oldBefore, 'Expected native post-await old-entry mutation absent');
    check(crossingResult.artifactId && crossingResult.blocksDropped > 0, 'Crossing elide did not execute original effects');
    events.push({type:'old-entries-mutated-after-session-transition', newBranchEntries:branch().length, crossingResult});
    check(active.size === 0 && !pendingSync, 'Lease or live sync incomplete');
    return {status:'passed-bounded-pruning-subset', thinkingResult, imageResult, elideResult, crossingResult, events, limitation:'Native elide continues across session transition; external serialization still required. No durable authority or ordinary output-prune coverage.'};
  } catch(error) { return {status:'failed', error:String(error), events}; }
  finally { for (const g of gates) g.release.resolve(); for(const restore of restores.reverse()) restore(); session?.dispose(); }
}

const base = fileURLToPath(new URL('./external_maintenance_ownership_smoke.mjs', import.meta.url));
let source = readFileSync(base, 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), 'd691f6b15312dc940fde233140c86018f4fa105e2c6892dadb39b0cd918c7a9d');
const replace = (before, after) => { assert.equal(source.split(before).length, 2, `Missing anchor: ${before.slice(0,80)}`); source = source.replace(before, after); };
const start = source.indexOf('async function nativeWorkflow('), end = source.indexOf('\ntry {\n  await new Promise((resolve) => server.listen', start);
assert.ok(start >= 0 && end > start);
source = source.slice(0,start) + pruningWorkflow.toString().replace('pruningWorkflow', 'nativeWorkflow') + source.slice(end);
const providerStart = source.indexOf('    const text = primary\n');
const providerEnd = source.indexOf('    return;\n', providerStart);
assert.ok(providerStart > 0 && providerEnd > providerStart);
source = source.slice(0,providerStart) + `    const lastUser = body.messages.findLastIndex(m => m.role === 'user');
    const current = JSON.stringify(body.messages[lastUser]);
    const needsRead = current.includes('PRUNING_READ_') && !body.messages.slice(lastUser + 1).some(m => m.role === 'tool');
    const heavy = current.includes('PRUNING_HEAVY');
    const text = heavy ? '\\n\\x60\\x60\\x60text\\n' + Array.from({length:220}, (_, i) => 'native-heavy-' + i + ': ' + createHash('sha256').update('heavy-' + i).digest('hex')).join('\\n') + '\\n\\x60\\x60\\x60' : 'Native read or image acknowledged.';
    const delta = needsRead ? {role:'assistant', tool_calls:[{index:0,id:'read-' + primaryRequests,type:'function',function:{name:'read',arguments:JSON.stringify({path:root + '/pruning-input.txt'})}}]} : {role:'assistant',content:text, ...(heavy ? {reasoning_content:'Native fixture reasoning before answer.'} : {})};
    response.writeHead(200, {'Content-Type':'text/event-stream'});
    response.end('data: ' + JSON.stringify({id:'pruning-fixture',choices:[{index:0,delta,finish_reason:null}]}) + '\\n\\ndata: ' + JSON.stringify({id:'pruning-fixture',choices:[{index:0,delta:{},finish_reason:needsRead ? 'tool_calls' : 'stop'}],usage:{prompt_tokens:1000,completion_tokens:100,total_tokens:1100}}) + '\\n\\ndata: [DONE]\\n\\n');
` + source.slice(providerEnd);
replace('reasoning: false, input: ["text"]', 'reasoning: true, input: ["text", "image"]');
replace('"passed-bounded-speculation-subset", JSON.stringify(result.workflow)', '"passed-bounded-pruning-subset", JSON.stringify(result.workflow)');
replace('scope: workflow ? "native-speculation-subset" : "module-access-only"', 'scope: "native-pruning-shake-images"');
replace('"alinery-maintenance-access-"', '"maintenance-pruning-runtime-"');
const temporary = mkdtempSync(path.join(tmpdir(), 'maintenance-pruning-derivative-'));
try {
  const script = path.join(temporary, 'probe.mjs'); writeFileSync(script, source);
  console.log(JSON.stringify({derivativeSha256:createHash('sha256').update(source).digest('hex')}));
  const child = spawn(process.execPath, [script, '--workflow'], {env:process.env, stdio:'inherit'});
  process.exitCode = await new Promise((resolve,reject) => {child.once('error', reject); child.once('close', code => resolve(code ?? 1));});
} finally { rmSync(temporary, {recursive:true,force:true}); }
