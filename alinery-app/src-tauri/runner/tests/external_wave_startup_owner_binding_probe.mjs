import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function nativeWorkflow(api, config, ctx) {
  const { AgentRegistry } = await import('@oh-my-pi/pi-coding-agent/registry/agent-registry');
  const { SessionMaintenance } = await import('@oh-my-pi/pi-coding-agent/session/session-maintenance');
  const { TurnRecovery } = await import('@oh-my-pi/pi-coding-agent/session/turn-recovery');
  const check = (v, message) => { if (!v) throw new Error(message); };
  const registry = new AgentRegistry();
  const owners = new WeakMap();
  const receivers = new WeakMap();
  const records = [];
  const events = [];
  const sessions = [];
  const restores = [];
  let binding;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let heldOwner;
  const decorate = (object, name, make) => {
    const original = object[name];
    check(typeof original === 'function', `Missing ${name}`);
    object[name] = make(original);
    restores.push(() => { object[name] = original; });
  };
  try {
    for (const [prototype, name] of [[SessionMaintenance.prototype, 'isCompacting'], [TurnRecovery.prototype, 'attempt']]) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      check(typeof descriptor?.get === 'function', `Missing getter ${name}`);
      Object.defineProperty(prototype, name, { ...descriptor, get() {
        if (binding) {
          check(!receivers.has(this) || receivers.get(this) === binding, 'Receiver rebound');
          receivers.set(this, binding);
          binding.bindings.add(this);
        }
        return Reflect.apply(descriptor.get, this, []);
      }});
      restores.push(() => Object.defineProperty(prototype, name, descriptor));
    }
    decorate(SessionMaintenance.prototype, 'checkCompaction', original => async function (...args) {
      const owner = receivers.get(this);
      if (!owner) return Reflect.apply(original, this, args);
      owner.active++;
      events.push({ type: 'maintenance-enter', generation: owner.generation });
      try {
        if (owner === heldOwner && !owner.held) {
          owner.held = true;
          entered.resolve();
          await release.promise;
          check(owner.active === 1, 'Old held operation lost ownership');
        }
        return await Reflect.apply(original, this, args);
      } finally {
        owner.active--;
        events.push({ type: 'maintenance-return', generation: owner.generation });
      }
    });
    decorate(registry, 'attachSession', original => function (id, session, file, expected) {
      const owner = { session, ref: expected, id, generation: records.length + 1, active: 0, bindings: new Set(), ready: false };
      check(expected === registry.get(id), 'Attach did not carry actual current ref');
      check(!owners.has(session), 'Duplicate instance attach');
      owners.set(session, owner);
      records.push(owner);
      binding = owner;
      try { void session.isCompacting; void session.retryAttempt; } finally { binding = undefined; }
      check(owner.bindings.size === 2, 'Handshake did not bind actual receivers');
      decorate(session, 'initializeCodeMode', implementation => function (...args) {
        check(owners.get(this) === owner && owner.bindings.size === 2, 'Startup entry before binding');
        events.push({ type: 'pre-return-initialize', generation: owner.generation });
        return Reflect.apply(implementation, this, args);
      });
      decorate(session, 'runAutolearnCapture', implementation => function (...args) {
        check(owners.get(this) === owner, 'Controller receiver changed owner');
        events.push({ type: 'controller-entry', generation: owner.generation });
        return Reflect.apply(implementation, this, args);
      });
      events.push({ type: 'before-original-attach', generation: owner.generation, bindings: owner.bindings.size });
      const result = Reflect.apply(original, this, [id, session, file, expected]);
      check(result, 'Original registry attachment rejected');
      return result;
    });
    const create = async id => {
      const result = await api.pi.createAgentSession({
        cwd: config.root, agentDir: config.agentDir, agentId: id, agentRegistry: registry,
        model: ctx.model, modelRegistry: ctx.modelRegistry, authStorage: ctx.modelRegistry.authStorage,
        autoApprove: true, sessionManager: api.pi.SessionManager.create(config.root, config.sessionsDir),
        settings: api.pi.Settings.isolated({}),
      });
      sessions.push(result.session);
      check(owners.has(result.session), 'SDK returned without attach binding');
      return result.session;
    };
    const [old, peer] = await Promise.all([create('startup-owner-A'), create('startup-owner-B')]);
    const oldRecord = owners.get(old), peerRecord = owners.get(peer);
    check(oldRecord !== peerRecord && oldRecord.ref !== peerRecord.ref, 'Concurrent instances shared identity');
    heldOwner = oldRecord;
    const oldPrompt = old.prompt('STARTUP_BINDING_OLD: provide fixture context.');
    await entered.promise;
    check(oldRecord.active === 1 && peerRecord.active === 0, 'Peer inherited old reservation');
    const replacement = await create('startup-owner-A');
    const replacementRecord = owners.get(replacement);
    check(registry.get('startup-owner-A') === replacementRecord.ref, 'Replacement not actual registry owner');
    check(replacementRecord.ref !== oldRecord.ref && replacementRecord.session !== old, 'Same-name replacement reused generation');
    check(oldRecord.active === 1 && !replacementRecord.ready && replacementRecord.active === 0, 'Replacement cleared old work or inherited readiness');
    await peer.prompt('STARTUP_BINDING_PEER: provide fixture context.');
    check(oldRecord.active === 1 && peerRecord.active === 0, 'Peer completion released old reservation');
    events.push({ type: 'replacement-while-old-held', old: oldRecord.generation, replacement: replacementRecord.generation, oldActive: oldRecord.active, replacementReady: replacementRecord.ready });
    release.resolve();
    await oldPrompt;
    check(oldRecord.active === 0, 'Original maintenance did not settle');
    check(registry.get('startup-owner-A') === replacementRecord.ref, 'Old return replaced current registry ref');
    await old.dispose();
    check(registry.get('startup-owner-A') === replacementRecord.ref, 'Old disposal removed replacement ref');
    sessions.splice(sessions.indexOf(old), 1);
    return { status: 'passed-bounded-startup-binding', events, instances: records.length, bindings: records.map(r => r.bindings.size), controllerInvocations: events.filter(e => e.type === 'controller-entry').length, limitation: 'Registry attach is after constructor and advisor-cost startup; local readiness sentinel is not durable authority; controller capture not forced.' };
  } catch (error) {
    return { status: 'failed', error: String(error), events };
  } finally {
    release.resolve();
    for (const session of sessions) await session.dispose();
    for (const restore of restores.reverse()) restore();
  }
}
const basePath = path.join(import.meta.dirname, 'external_maintenance_ownership_smoke.mjs');
const base = readFileSync(basePath, 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(base), 'd691f6b15312dc940fde233140c86018f4fa105e2c6892dadb39b0cd918c7a9d');
const start = base.indexOf('async function nativeWorkflow(');
const end = base.indexOf('\ntry {\n  await new Promise', start);
assert.ok(start > 0 && end > start);
let derived = base.slice(0, start) + nativeWorkflow.toString() + '\n' + base.slice(end);
derived = derived.replaceAll('passed-bounded-speculation-subset', 'passed-bounded-startup-binding').replaceAll('native-speculation-subset', 'native-startup-binding-subset').replaceAll('alinery-maintenance-access-', 'startup-owner-binding-runtime-');
const root = mkdtempSync(path.join(tmpdir(), 'startup-owner-binding-driver-'));
try {
  const file = path.join(root, 'probe.mjs');
  writeFileSync(file, derived);
  console.log(JSON.stringify({ derivativeSha256: hash(derived) }));
  const child = spawn(process.execPath, [file, '--workflow'], { stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
} finally { rmSync(root, { recursive: true, force: true }); }
