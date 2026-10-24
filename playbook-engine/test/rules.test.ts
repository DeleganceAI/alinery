/**
 * The engine's individual rules, each on the smallest playbook that shows it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Launch } from '../src/harness.ts';
import { parsePlaybookMd } from '../src/playbook-md.ts';
import { validatePlaybook } from '../src/playbook.ts';
import { complete, FakeHarness, type FakeSession } from './fake-harness.ts';
import { byStep, openEngine, playbook, settle, step, taskDir, writeText } from './helpers.ts';

/** An agent that writes "x" to every exact output and completes. */
const writeAll = async (launch: Launch, session: FakeSession) => {
  for (const [role, path] of Object.entries(launch.outputs)) if (!role.includes('*')) writeText(path, 'x');
  await complete(launch, session);
};

const seedTicket = (dir: ReturnType<typeof taskDir>) => {
  const path = join(dir.root, 'ticket.md');
  writeText(path, 'the task');
  return [{ role: 'ticket.md', path }];
};

test('validation: wildcard ownership is unique, exact roles may be shared', () => {
  const codes = (steps: ReturnType<typeof step>[]) => validatePlaybook(playbook(steps)).map((d) => d.code);
  assert.deepEqual(codes([step('a', { outputs: [{ path: 'result-*.md' }] }), step('b', { outputs: [{ path: 'result-*.md' }] })]), ['overlapping_outputs']);
  assert.deepEqual(codes([step('a', { outputs: [{ path: 'result-*.md' }] }), step('b', { outputs: [{ path: 'result-summary.md' }] })]), ['overlapping_outputs']);
  assert.deepEqual(codes([step('a', { outputs: [{ path: 'report.md' }] }), step('b', { outputs: [{ path: 'report.md' }] })]), []);
  assert.deepEqual(codes([step('a', { isCodingStep: true, inputs: [{ path: 'req-*.md', mode: 'each' }] })]), ['coding_input']);
  assert.deepEqual(codes([step('a', { inputs: [{ path: 'a-*.md', mode: 'each' }, { path: 'b-*.md', mode: 'complete' }] })]), ['multiple_collections']);
  assert.deepEqual(codes([step('a', { outputs: [{ path: 'attachments/x.md' }] })]), ['invalid_path']);
  assert.deepEqual(codes([step('a', { prompt: 'see {{NOPE}}' })]), ['unknown_prompt_token']);
  assert.deepEqual(codes([step('a', { outputs: [{ path: 'slice-*.md', required: true }] })]), ['required_wildcard']);
});

test('spec playbook parses, including required outputs', () => {
  const text = readFileSync(new URL('../../alinery-app/src-tauri/playbooks/spec/playbook.md', import.meta.url), 'utf8');
  const result = parsePlaybookMd(text);
  assert.equal(result.diagnostics.length, 0, result.diagnostics.map((d) => d.message).join('; '));
  const plan = result.playbook?.steps.find((s) => s.key === 'plan-slices');
  assert.equal(plan?.outputs.find((o) => o.path === 'tasks.md')?.required, true);
  assert.equal(plan?.outputs.find((o) => o.path === 'slice-*.md')?.required, undefined);
});

test('ambiguity: two unrelated briefs for one request is reported, not guessed', async () => {
  const pb = playbook([
    step('brief-a', { inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'brief.md' }] }),
    step('brief-b', { inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'brief.md' }] }),
    step('request', { inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'request.md' }] }),
    step('design', { inputs: [{ path: 'request.md', mode: 'single' }, { path: 'brief.md', mode: 'single' }], outputs: [{ path: 'design.md' }] }),
  ]);
  const dir = taskDir();
  const engine = openEngine(pb, new FakeHarness(writeAll), dir);
  engine.seed(seedTicket(dir));
  await settle(engine);
  assert.equal(byStep(engine, 'design').length, 0);
  const [a] = engine.diagnose().ambiguities;
  assert.equal(a.step, 'design');
  assert.equal(a.slot, 'brief.md');
  assert.equal(a.candidates.length, 2);
});

test('companions: two requests from one brief make two designs, and the brief does not trigger', async () => {
  const pb = playbook([
    step('brief', { inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'brief.md' }] }),
    step('split', { inputs: [{ path: 'brief.md', mode: 'single' }], outputs: [{ path: 'request-*.md' }] }),
    step('design', { inputs: [{ path: 'request-*.md', mode: 'each' }, { path: 'brief.md', mode: 'single' }], outputs: [{ path: 'design.md' }] }),
  ]);
  const dir = taskDir();
  const engine = openEngine(
    pb,
    new FakeHarness(async (launch, session) => {
      if (launch.step === 'split') for (const n of ['1', '2']) writeText(launch.outputs['request-*.md'].replace('*', n), n);
      else writeText(launch.outputs[launch.step === 'brief' ? 'brief.md' : 'design.md'], 'x');
      await complete(launch, session);
    }),
    dir,
  );
  engine.seed(seedTicket(dir));
  await settle(engine);
  const designs = byStep(engine, 'design');
  assert.equal(designs.length, 2);
  assert.deepEqual(designs.map((d) => d.inputs['brief.md']), [[`${byStep(engine, 'brief')[0].id}/brief.md`], [`${byStep(engine, 'brief')[0].id}/brief.md`]]);
  assert.deepEqual(engine.diagnose().ambiguities, []);
});

test('capacity: at most maxLiveSessions sessions exist at once', async () => {
  const pb = playbook([step('work', { inputs: [{ path: 'item-*.md', mode: 'each' }], outputs: [{ path: 'out.md' }] })]);
  const dir = taskDir();
  let peak = 0;
  const harness = new FakeHarness(async (launch, session) => {
    peak = Math.max(peak, [...harness.sessions.values()].filter((s) => s.status.kind === 'running' || s.status.kind === 'starting').length);
    await writeAll(launch, session);
  });
  const engine = openEngine(pb, harness, dir, { maxLiveSessions: 2 });
  engine.seed(
    ['1', '2', '3', '4', '5'].map((n) => {
      const path = join(dir.root, `item-${n}.md`);
      writeText(path, n);
      return { role: `item-${n}.md`, path };
    }),
  );
  await engine.tick();
  assert.equal([...engine.state.executions.values()].filter((e) => e.status === 'live').length, 2);
  assert.equal([...engine.state.executions.values()].filter((e) => e.status === 'reserved').length, 3);
  await settle(engine);
  assert.equal(byStep(engine, 'work').filter((e) => e.status === 'done').length, 5);
  assert.ok(peak <= 2, `peak ${peak}`);
});

test('coding exclusivity: two ready coding steps run one at a time', async () => {
  const pb = playbook([
    step('fix-a', { isCodingStep: true, inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'a.md' }] }),
    step('fix-b', { isCodingStep: true, inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'b.md' }] }),
    step('note', { inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'n.md' }] }),
  ]);
  const dir = taskDir();
  const engine = openEngine(pb, new FakeHarness(writeAll), dir);
  engine.seed(seedTicket(dir));
  await engine.tick();
  const live = [...engine.state.executions.values()].filter((e) => e.status === 'live').map((e) => e.step);
  assert.deepEqual(live, ['fix-a', 'note']); // fix-b waits; the non-coding step does not
  await settle(engine);
  assert.ok([...engine.state.executions.values()].every((e) => e.status === 'done'));
});

test('human gate: a locked step stays interactive until permitted', async () => {
  const pb = playbook([step('review', { autoAdvanceDefault: false, inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'r.md' }] })]);
  const dir = taskDir();
  const harness = new FakeHarness(writeAll);
  const engine = openEngine(pb, harness, dir);
  engine.seed(seedTicket(dir));
  for (let i = 0; i < 5; i++) {
    await engine.tick();
    await new Promise((r) => setImmediate(r));
  }
  const [review] = byStep(engine, 'review');
  assert.equal(review.status, 'live');
  assert.equal((await harness.status(review.sessionId!)).kind, 'idle');
  await engine.permit(review.id);
  await settle(engine);
  assert.equal(byStep(engine, 'review')[0].status, 'done');
  assert.match(harness.sessions.get(review.sessionId!)!.inbox[0], /Permission to finish granted/);
});

test('acceptance: an empty assigned file rejects the attempt; nothing published rejects; the receipt is fixed', async () => {
  const pb = playbook([step('s', { inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c-*.md' }] })]);
  const dir = taskDir();
  let launch!: Launch;
  const engine = openEngine(
    pb,
    new FakeHarness(async (l) => {
      launch = l;
    }),
    dir,
  );
  engine.seed(seedTicket(dir));
  await engine.tick();
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(await launch.requestCompletion(), { kind: 'rejected', problems: ['no valid assigned artifact was published'] });
  writeText(launch.outputs['a.md'], 'ok');
  writeText(launch.outputs['b.md'], '');
  assert.deepEqual(await launch.requestCompletion(), { kind: 'rejected', problems: ['b.md is empty'] });
  writeText(launch.outputs['b.md'], 'ok');
  writeText(launch.outputs['c-*.md'].replace('*', '1'), 'ok');
  const accepted = await launch.requestCompletion();
  assert.equal(accepted.kind, 'accepted');
  writeText(launch.outputs['c-*.md'].replace('*', '2'), 'late');
  assert.deepEqual(await launch.requestCompletion(), accepted); // files written after acceptance never join the receipt
  assert.deepEqual(byStep(engine, 's')[0].receipt!.map((o) => o.role), ['a.md', 'b.md', 'c-1.md']);
});

test('a required output rejects until that exact file exists', async () => {
  const pb = playbook([step('s', { outputs: [{ path: 'optional.md' }, { path: 'must.md', required: true }] })]);
  const dir = taskDir();
  let launch!: Launch;
  const engine = openEngine(
    pb,
    new FakeHarness(async (l) => {
      launch = l;
    }),
    dir,
  );
  await engine.tick();
  await new Promise((r) => setImmediate(r));
  writeText(launch.outputs['optional.md'], 'ok');
  const rejected = await launch.requestCompletion();
  assert.equal(rejected.kind, 'rejected');
  if (rejected.kind === 'rejected') assert.ok(rejected.problems.some((p) => p.includes('must.md')));
  writeText(launch.outputs['must.md'], 'ok');
  assert.equal((await launch.requestCompletion()).kind, 'accepted');
});

test('a session that exits without completing is failed, not done, and its binding is not re-reserved', async () => {
  const pb = playbook([step('s', { inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'a.md' }] })]);
  const dir = taskDir();
  const harness = new FakeHarness(async () => {});
  const engine = openEngine(pb, harness, dir);
  engine.seed(seedTicket(dir));
  await engine.tick();
  const [s] = byStep(engine, 's');
  await harness.stop(s.sessionId!);
  await settle(engine);
  assert.equal(byStep(engine, 's').length, 1);
  assert.equal(byStep(engine, 's')[0].status, 'failed');
  assert.equal(byStep(engine, 's')[0].failure, 'exited without completing');
});

test('companions: requests derived from different reviews each bind their own review', async () => {
  const pb = playbook([
    step('review-a', { inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'review.md' }] }),
    step('review-b', { inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'review.md' }] }),
    step('ask', { inputs: [{ path: 'review.md', mode: 'single' }], outputs: [{ path: 'request.md' }] }),
    step('discover', { inputs: [{ path: 'request.md', mode: 'single' }, { path: 'review.md', mode: 'single' }], outputs: [{ path: 'found.md' }] }),
  ]);
  const dir = taskDir();
  const engine = openEngine(pb, new FakeHarness(writeAll), dir);
  engine.seed(seedTicket(dir));
  await settle(engine);
  const discovers = byStep(engine, 'discover');
  assert.equal(discovers.length, 2);
  for (const d of discovers) {
    const ask = engine.state.executions.get(d.inputs['request.md'][0].split('/')[0])!;
    assert.deepEqual(d.inputs['review.md'], ask.inputs['review.md']); // the review this request came from, not the newest
  }
  assert.deepEqual(engine.diagnose().ambiguities, []);
});

test('companions: two independent branches join once when each has one occurrence', async () => {
  const pb = playbook([
    step('frame', { inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'question.md' }] }),
    step('config', { inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'config.md' }] }),
    step('discover', { inputs: [{ path: 'question.md', mode: 'single' }, { path: 'config.md', mode: 'single' }], outputs: [{ path: 'found.md' }] }),
  ]);
  const dir = taskDir();
  const engine = openEngine(pb, new FakeHarness(writeAll), dir);
  engine.seed(seedTicket(dir));
  await settle(engine);
  assert.equal(byStep(engine, 'discover').length, 1);
  assert.deepEqual(engine.diagnose().ambiguities, []);
});

test('nested fan-in: an omitted intermediate leaves the downstream collection incomplete', async () => {
  const pb = playbook([
    step('split', { inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'source-*.md' }] }),
    step('read', { inputs: [{ path: 'source-*.md', mode: 'each' }], outputs: [{ path: 'trigger.md' }, { path: 'note.md' }] }),
    step('extract', { inputs: [{ path: 'trigger.md', mode: 'single' }], outputs: [{ path: 'extraction.md' }] }),
    step('synthesize', { inputs: [{ path: 'extraction*.md', mode: 'complete' }], outputs: [{ path: 'report.md' }] }),
  ]);
  const dir = taskDir();
  const engine = openEngine(
    pb,
    new FakeHarness(async (launch, session) => {
      if (launch.step === 'split') for (const n of ['1', '2']) writeText(launch.outputs['source-*.md'].replace('*', n), n);
      // The reader of source-2 publishes a note instead of a trigger: no extraction will represent that source.
      else if (launch.step === 'read') writeText(launch.outputs[launch.inputs['source-*.md'][0].endsWith('source-2.md') ? 'note.md' : 'trigger.md'], 'x');
      else writeText(Object.values(launch.outputs)[0], 'x');
      await complete(launch, session);
    }),
    dir,
  );
  engine.seed(seedTicket(dir));
  await settle(engine);
  assert.equal(byStep(engine, 'extract').length, 1);
  assert.equal(byStep(engine, 'synthesize').length, 0);
  assert.deepEqual(engine.diagnose().blocked, [{ step: 'synthesize', selector: 'extraction*.md', reason: 'no extract execution represents source-2.md' }]);
});

test('task gate: a step left out of the set stays locked even when the playbook default is automatic', async () => {
  const pb = playbook([
    step('locked', { autoAdvanceDefault: true, inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'locked.md' }] }),
    step('open', { autoAdvanceDefault: false, inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'open.md' }] }),
  ]);
  const dir = taskDir();
  let enabled = ['open'];
  let approveAll = false;
  const engine = openEngine(pb, new FakeHarness(async () => {}), dir, {
    enabledSteps: () => enabled,
    autoApproveAll: () => approveAll,
  });
  engine.seed(seedTicket(dir));
  await engine.tick();
  await new Promise((r) => setImmediate(r));
  const locked = byStep(engine, 'locked')[0];
  const open = byStep(engine, 'open')[0];
  writeText(join(locked.outDir, 'locked.md'), 'x');
  writeText(join(open.outDir, 'open.md'), 'x');
  assert.equal(locked.automatic, false);
  assert.equal(open.automatic, true);
  assert.equal((await engine.requestCompletion(locked.id)).kind, 'permission-required');
  approveAll = true;
  assert.equal((await engine.requestCompletion(locked.id)).kind, 'accepted');
  enabled = [];
  assert.equal((await engine.requestCompletion(open.id)).kind, 'accepted');
});

test('task gate: turning approve-all off rejects the next attempt, and a grant still finishes a locked step', async () => {
  const pb = playbook([step('review', { autoAdvanceDefault: true, inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'r.md' }] })]);
  const dir = taskDir();
  let approveAll = true;
  const engine = openEngine(pb, new FakeHarness(async () => {}), dir, { enabledSteps: () => [], autoApproveAll: () => approveAll });
  engine.seed(seedTicket(dir));
  await engine.tick();
  await new Promise((r) => setImmediate(r));
  const [review] = byStep(engine, 'review');
  writeText(join(review.outDir, 'r.md'), 'x');
  approveAll = false;
  assert.equal((await engine.requestCompletion(review.id)).kind, 'permission-required');
  await engine.permit(review.id);
  assert.equal((await engine.requestCompletion(review.id)).kind, 'accepted');
});

test('task gate: a step in the set completes with no grant', async () => {
  const pb = playbook([step('build', { autoAdvanceDefault: false, inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'b.md' }] })]);
  const dir = taskDir();
  const engine = openEngine(pb, new FakeHarness(async () => {}), dir, { enabledSteps: () => ['build'], autoApproveAll: () => false });
  engine.seed(seedTicket(dir));
  await engine.tick();
  await new Promise((r) => setImmediate(r));
  const [build] = byStep(engine, 'build');
  writeText(join(build.outDir, 'b.md'), 'x');
  assert.equal((await engine.requestCompletion(build.id)).kind, 'accepted');
});

test('capacity: the cap is read at launch, and zero launches nothing', async () => {
  const pb = playbook([
    step('a', { inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'a.md' }] }),
    step('b', { inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'b.md' }] }),
  ]);
  const dir = taskDir();
  let cap = 1;
  const engine = openEngine(pb, new FakeHarness(async () => {}), dir, { maxLiveSessions: () => cap });
  engine.seed(seedTicket(dir));
  await engine.tick();
  assert.equal([...engine.state.executions.values()].filter((e) => e.status === 'live').length, 1);
  assert.equal([...engine.state.executions.values()].filter((e) => e.status === 'reserved').length, 1);
  cap = 2;
  await engine.tick();
  assert.equal([...engine.state.executions.values()].filter((e) => e.status === 'live').length, 2);

  const quiet = taskDir();
  const blocked = openEngine(pb, new FakeHarness(async () => {}), quiet, { maxLiveSessions: () => 0 });
  blocked.seed(seedTicket(quiet));
  await blocked.tick();
  assert.equal([...blocked.state.executions.values()].filter((e) => e.status === 'live').length, 0);
  assert.equal([...blocked.state.executions.values()].filter((e) => e.status === 'reserved').length, 2);
});

test('a failed status frees the slot, and resume launches that same execution once', async () => {
  const pair = playbook([
    step('a', { inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'a.md' }] }),
    step('b', { inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'b.md' }] }),
  ]);
  const dir = taskDir();
  const harness = new FakeHarness(async () => {});
  const engine = openEngine(pair, harness, dir, { maxLiveSessions: 1 });
  engine.seed(seedTicket(dir));
  await engine.tick();
  const live = [...engine.state.executions.values()].find((e) => e.status === 'live')!;
  harness.crash(live.sessionId!);
  await engine.tick();
  assert.equal(engine.state.executions.get(live.id)?.status, 'failed');
  const next = [...engine.state.executions.values()].filter((e) => e.status === 'live');
  assert.equal(next.length, 1);
  assert.notEqual(next[0].id, live.id);

  const one = playbook([step('s', { inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'a.md' }] })]);
  const again = taskDir();
  const resumed = new FakeHarness(async () => {});
  const recovery = openEngine(one, resumed, again);
  recovery.seed(seedTicket(again));
  await recovery.tick();
  const failed = byStep(recovery, 's')[0];
  const sessionId = failed.sessionId;
  resumed.crash(sessionId!);
  await recovery.tick();
  await recovery.resume(failed.id);
  assert.equal(byStep(recovery, 's').length, 1);
  assert.equal(recovery.state.executions.get(failed.id)?.status, 'live');
  assert.equal(recovery.state.executions.get(failed.id)?.sessionId, sessionId);
  assert.equal(resumed.sessions.size, 1);
});

test('confirmExited records a process that is already gone and does not resume it', async () => {
  const pb = playbook([step('s', { inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'a.md' }] })]);
  const dir = taskDir();
  const harness = new FakeHarness(async () => {});
  const engine = openEngine(pb, harness, dir);
  engine.seed(seedTicket(dir));
  await engine.tick();
  const [execution] = byStep(engine, 's');
  const runs = harness.sessions.get(execution.sessionId!)!.runs;
  engine.confirmExited(execution.id);
  assert.equal(execution.status, 'failed');
  assert.equal(harness.sessions.get(execution.sessionId!)!.runs, runs);
});

test('step tokens replace the extra and the handoff for that launch only', async () => {
  const pb = playbook([
    step('review', { prompt: 'extra {{PROMPT_EXTRA}} handoff {{REVIEW_HANDOFF_FILE}} history {{SESSION_HISTORY_DIR}}', inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'r.md' }] }),
    step('build', { prompt: 'extra {{PROMPT_EXTRA}} handoff {{REVIEW_HANDOFF_FILE}} history {{SESSION_HISTORY_DIR}}', inputs: [{ path: 'ticket.md', mode: 'single' }], outputs: [{ path: 'b.md' }] }),
  ]);
  const dir = taskDir();
  const harness = new FakeHarness(async () => {});
  const engine = openEngine(pb, harness, dir, {
    tokens: { SESSION_HISTORY_DIR: '/task/sessions' },
    stepTokens: (step) => (step === 'review' ? { PROMPT_EXTRA: 'keep the tests', REVIEW_HANDOFF_FILE: '/task/artifacts/review-handoff-001.md' } : { PROMPT_EXTRA: '', REVIEW_HANDOFF_FILE: '' }),
  });
  engine.seed(seedTicket(dir));
  await engine.tick();
  await engine.tick();
  const review = harness.launches.find((launch) => launch.step === 'review')!;
  const build = harness.launches.find((launch) => launch.step === 'build')!;
  assert.match(review.prompt, /keep the tests/);
  assert.match(review.prompt, /review-handoff-001\.md/);
  assert.match(review.prompt, /\/task\/sessions/);
  assert.doesNotMatch(build.prompt, /keep the tests/);
  assert.doesNotMatch(build.prompt, /review-handoff-001/);
  assert.match(build.prompt, /\/task\/sessions/);
});
