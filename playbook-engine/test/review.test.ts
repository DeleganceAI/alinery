import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CompletionReply } from '../src/harness.ts';
import { FakeHarness } from './fake-harness.ts';
import { byStep, fileStore, openEngine, playbook, step, taskDir, writeText } from './helpers.ts';

const input = (path: string) => ({ path, mode: 'single' as const });
const report = (reply: CompletionReply) => {
  assert.equal(reply.kind, 'ready');
  assert.ok(reply.revision > 0);
  return reply;
};
const branch = playbook([
  step('choose', { autoAdvanceDefault: false, outputs: [{ path: 'next.md' }, { path: 'end.md' }] }),
  step('review', { inputs: [input('next.md')], outputs: [{ path: 'report.md' }] }),
]);
const idle = () => new FakeHarness(async () => {});

test('manual readiness survives reopen without publication; only the current reviewed bytes, owner and revision can continue', async () => {
  const dir = taskDir();
  const harness = idle();
  const open = () => openEngine(branch, harness, dir);
  let engine = open();
  await engine.tick();
  const [source] = byStep(engine, 'choose');
  const owner = source.sessionId!;
  const path = join(source.outDir, 'next.md');
  assert.equal((await engine.requestCompletion(source.id, owner)).kind, 'rejected');
  writeText(path, 'first');
  const first = report(await engine.requestCompletion(source.id, owner));
  assert.deepEqual(first.destinations, ['review']);
  assert.equal(source.receipt, null);
  assert.equal(source.status, 'live');
  await engine.tick();
  assert.equal(byStep(engine, 'review').length, 0);
  engine = open();
  assert.deepEqual(await engine.requestCompletion(source.id, owner), first);
  assert.equal((await engine.continueReviewed(source.id, 'different-session', first.revision)).kind, 'stale');
  await assert.rejects(engine.invalidateReadiness(source.id, 'different-session'));
  // Same path and same size, different bytes. A stale Continue cannot accept the edit.
  writeText(path, 'other');
  assert.equal((await engine.continueReviewed(source.id, owner, first.revision)).kind, 'stale');
  assert.equal(engine.state.executions.get(source.id)!.ready, undefined);
  const second = report(await engine.requestCompletion(source.id, owner));
  assert.ok(second.revision > first.revision);
  await engine.invalidateReadiness(source.id, owner);
  assert.equal((await engine.continueReviewed(source.id, owner, second.revision)).kind, 'stale');
  const fresh = report(await engine.requestCompletion(source.id, owner));
  const receipt = await engine.continueReviewed(source.id, owner, fresh.revision);
  assert.equal(receipt.kind, 'accepted');
  engine = open();
  writeText(path, 'edited after acceptance');
  assert.deepEqual(await engine.continueReviewed(source.id, owner, fresh.revision), receipt);
  assert.equal((await engine.continueReviewed(source.id, owner, second.revision)).kind, 'stale');
  await assert.rejects(engine.invalidateReadiness(source.id, owner));
  assert.equal(byStep(engine, 'review').length, 0);
  await engine.tick();
  await engine.tick();
  assert.equal(byStep(engine, 'review').length, 1);
});

test('a conditional endpoint stays conversational under step and task-wide automation, then routes newly reviewed output', async () => {
  const dir = taskDir();
  let all = true;
  const engine = openEngine(branch, idle(), dir, { enabledSteps: () => ['choose'], autoApproveAll: () => all });
  await engine.tick();
  const [e] = byStep(engine, 'choose');
  writeText(join(e.outDir, 'end.md'), 'for review');
  const review = report(await engine.requestCompletion(e.id, e.sessionId!));
  assert.equal(review.endpoint, true);
  assert.deepEqual(review.destinations, []);
  await engine.tick();
  assert.equal(e.status, 'live');
  await assert.rejects(engine.setStepContinuation('choose', false), /task-wide/);
  await assert.rejects(engine.setStepContinuation('missing', true), /unknown step/);
  all = false;
  await engine.invalidateReadiness(e.id, e.sessionId!);
  writeText(join(e.outDir, 'next.md'), 'continue to reviewer');
  assert.equal((await engine.requestCompletion(e.id, e.sessionId!)).kind, 'accepted');
});

test('a ready output waiting on a join is nonterminal; step and task overrides release it only after revalidation', async () => {
  const pb = playbook([
    step('a', { autoAdvanceDefault: false, outputs: [{ path: 'a.md' }] }),
    step('b', { autoAdvanceDefault: false, outputs: [{ path: 'b.md' }] }),
    step('join', { inputs: [input('a.md'), input('b.md')], outputs: [{ path: 'final.md' }] }),
  ]);
  const dir = taskDir();
  const harness = idle();
  let all = false;
  const open = () => openEngine(pb, harness, dir, { autoApproveAll: () => all });
  let engine = open();
  await engine.tick();
  const [a] = byStep(engine, 'a');
  writeText(join(a.outDir, 'a.md'), 'draft');
  const ready = report(await engine.requestCompletion(a.id));
  assert.equal(ready.endpoint, false);
  assert.deepEqual(ready.destinations, []);
  writeText(join(a.outDir, 'a.md'), 'edited!');
  await engine.setStepContinuation('a', true);
  assert.equal(a.receipt, null);
  assert.equal(a.ready, undefined);
  engine = open();
  assert.equal(engine.state.stepModes?.a, true);
  assert.equal((await engine.requestCompletion(a.id)).kind, 'accepted');
  await engine.tick();
  await engine.tick();
  assert.equal(byStep(engine, 'join').length, 0);
  const [b] = byStep(engine, 'b');
  writeText(join(b.outDir, 'b.md'), 'ready');
  assert.deepEqual(report(await engine.requestCompletion(b.id)).destinations, ['join']);
  all = true;
  await engine.tick();
  assert.ok(b.receipt);
  await engine.tick();
  assert.equal(byStep(engine, 'join').length, 1);
});

test('a resumed owner reusing the session id cannot continue its previous attempt or send a report from its previous launch', async () => {
  const harness = idle();
  const engine = openEngine(branch, harness);
  await engine.tick();
  const [e] = byStep(engine, 'choose');
  const owner = e.sessionId!;
  const previousLaunch = harness.sessions.get(owner)!.launch;
  writeText(join(e.outDir, 'next.md'), 'ready');
  const old = report(await previousLaunch.requestCompletion());
  harness.crash(owner);
  await engine.tick();
  await engine.resume(e.id);
  assert.equal(e.sessionId, owner);
  assert.deepEqual(e.previousSessionIds ?? [], []);
  assert.equal((await previousLaunch.requestCompletion()).kind, 'stale');
  assert.equal((await engine.continueReviewed(e.id, owner, old.revision)).kind, 'stale');
  assert.ok(report(await engine.requestCompletion(e.id, owner)).revision > old.revision);
});

test('a resumed execution retains its grant and owner history across reopen; only the replacement can publish', async () => {
  const dir = taskDir();
  const harness = idle();
  harness.resume = (_id, launch) => harness.start(launch);
  const open = () => openEngine(branch, harness, dir);
  const engine = open();
  await engine.tick();
  const [execution] = byStep(engine, 'choose');
  const previous = execution.sessionId!;
  await engine.permit(execution.id);
  harness.crash(previous);
  await engine.tick();
  await engine.resume(execution.id);
  const reopened = open();
  const [current] = byStep(reopened, 'choose');
  assert.notEqual(current.sessionId, previous);
  assert.deepEqual(current.previousSessionIds, [previous]);
  writeText(join(current.outDir, 'next.md'), 'for review');
  assert.equal((await reopened.requestCompletion(current.id, previous)).kind, 'stale');
  assert.equal((await reopened.requestCompletion(current.id, current.sessionId!)).kind, 'accepted');
});

test('a policy change waits for a genuine outstanding question; admitted work invalidates the old report while the check is pending', async () => {
  const dir = taskDir();
  let resolve!: (value: boolean) => void;
  let checked!: () => void;
  const checking = new Promise<void>((r) => { checked = r; });
  const engine = openEngine(branch, idle(), dir, { canAdvanceReviewed: () => new Promise((r) => { resolve = r; checked(); }) });
  await engine.tick();
  const [e] = byStep(engine, 'choose');
  writeText(join(e.outDir, 'next.md'), 'ready');
  report(await engine.requestCompletion(e.id));
  const promoting = engine.setStepContinuation(e.step, true);
  await checking;
  await engine.invalidateReadiness(e.id, e.sessionId!);
  resolve(true);
  await promoting;
  assert.equal(e.status, 'live');
  assert.equal(e.receipt, null);
  assert.equal(e.ready, undefined);
});

test('an answer verified during admission of a newer review message cannot restore Continue', async () => {
  const harness = idle();
  let beginCheck!: () => void;
  let finishCheck!: (answered: boolean) => void;
  const checking = new Promise<void>((resolve) => { beginCheck = resolve; });
  const firstAnswer = new Promise<boolean>((resolve) => { finishCheck = resolve; });
  const engine = openEngine(branch, harness, taskDir(), {
    reviewFollowUpFinished: async (_owner, id) => {
      if (id !== 'first') return id === 'second';
      beginCheck();
      return firstAnswer;
    },
  });
  await engine.tick();
  const [e] = byStep(engine, 'choose');
  const owner = e.sessionId!;
  writeText(join(e.outDir, 'next.md'), 'ready');
  report(await engine.requestCompletion(e.id, owner));
  harness.sessions.get(owner)!.status = { kind: 'idle' };
  await engine.invalidateReadiness(e.id, owner, 'first');
  const observing = engine.tick();
  await checking;
  await engine.invalidateReadiness(e.id, owner, 'second');
  finishCheck(true);
  await observing;
  assert.equal(e.ready, undefined);
  assert.equal(e.pendingReviewInput, 'second');
  await engine.tick();
  assert.ok(e.ready);
  assert.equal(e.receipt, null);
});

test('a receipt that cannot be saved never releases its owner, and the same reviewed Continue retries that receipt', async () => {
  const dir = taskDir();
  const store = fileStore(dir.statePath);
  let rejectSaves = false;
  const harness = idle();
  const engine = openEngine(branch, harness, dir, {
    save: (state) => {
      if (rejectSaves) throw new Error('fixture disk full');
      store.save(state);
    },
  });
  await engine.tick();
  const [e] = byStep(engine, 'choose');
  writeText(join(e.outDir, 'next.md'), 'approved bytes');
  const ready = report(await engine.requestCompletion(e.id));
  rejectSaves = true;
  await assert.rejects(engine.continueReviewed(e.id, e.sessionId!, ready.revision), /disk full/);
  await assert.rejects(engine.tick(), /disk full/);
  assert.equal(byStep(engine, 'review').length, 0);
  assert.notEqual((await harness.status(e.sessionId!)).kind, 'exited');
  assert.equal(store.load()!.executions.get(e.id)!.receipt, null);
  rejectSaves = false;
  assert.equal((await engine.continueReviewed(e.id, e.sessionId!, ready.revision)).kind, 'accepted');
  assert.equal(store.load()!.executions.get(e.id)!.receipt?.length, 1);
});

test('an unknown noncoding owner holds its place even with spare capacity and cannot be resumed on a stale review', async () => {
  const harness = idle();
  const engine = openEngine(branch, harness);
  await engine.tick();
  const [e] = byStep(engine, 'choose');
  writeText(join(e.outDir, 'next.md'), 'ready');
  const ready = report(await engine.requestCompletion(e.id));
  const owner = e.sessionId!;
  harness.sessions.delete(owner);
  await engine.tick();
  assert.equal(e.unconfirmed, true);
  await assert.rejects(engine.resume(e.id), /confirmed stopped/);
  assert.equal((await engine.continueReviewed(e.id, owner, ready.revision)).kind, 'stale');
  assert.equal(e.sessionId, owner);
});
