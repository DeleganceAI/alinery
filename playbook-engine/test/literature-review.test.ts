/**
 * End-to-end: the whitepaper's appendix Playbook driven by its shared fixtures.
 * Exercises single/each/complete inputs, the branching fan-out, the loop with
 * a fresh round-request, companion binding across loop passes, and replay.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Engine } from '../src/engine.ts';
import type { Launch } from '../src/harness.ts';
import { parsePlaybookMd } from '../src/playbook-md.ts';
import { complete, FakeHarness, type FakeSession } from './fake-harness.ts';
import { byStep, openEngine, settle, taskDir, writeJson, writeText } from './helpers.ts';

const EXAMPLES = join(import.meta.dirname, '../../whitepaper/examples');
const parsed = parsePlaybookMd(readFileSync(join(EXAMPLES, 'alinery/playbook.md'), 'utf8'));
assert.equal(parsed.diagnostics.length, 0, JSON.stringify(parsed.diagnostics));
const PLAYBOOK = parsed.playbook!;
const FIXTURES = JSON.parse(readFileSync(join(EXAMPLES, 'shared/fixtures.json'), 'utf8'));

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

/** A fixture-driven agent for the six operations. `discover` can be overridden per round. */
function agent(discover: Record<string, { sources: { id: string; url: string; title: string }[]; notes: string }> = FIXTURES.responses.discover) {
  return async (launch: Launch, session: FakeSession) => {
    const { step, inputs, outputs } = launch;
    const one = (slot: string) => readJson(inputs[slot][0]);
    switch (step) {
      case 'frame':
        writeJson(outputs['round-request.md'], FIXTURES.responses.frame);
        break;
      case 'discover': {
        const state = one('round-request.md');
        const d = discover[String(state.round)];
        if (!d || d.sources.length === 0) {
          writeJson(outputs['empty.md'], { state, notes: d?.notes ?? 'nothing new' });
        } else {
          writeJson(outputs['batch.md'], { state, discovery: d });
          d.sources.forEach((source, i) => writeJson(outputs['source-request-*.md'].replace('*', String(i + 1).padStart(3, '0')), { state, source }));
        }
        break;
      }
      case 'read': {
        const { source } = one('source-request-*.md');
        writeJson(outputs['assessment.md'], FIXTURES.responses.read[source.id]);
        break;
      }
      case 'synthesize': {
        const { state, discovery } = one('batch.md');
        const assessments = inputs['assessment*.md'].map(readJson);
        const s = FIXTURES.responses.synthesize[String(state.round)];
        const updated = { ...state, seen: [...state.seen, ...discovery.sources.map((x: { url: string }) => x.url)], assessments: [...state.assessments, ...assessments], synthesis: s.text };
        writeJson(outputs['synthesis.md'], { state: updated, synthesis: s });
        break;
      }
      case 'decide': {
        const { state } = one('synthesis.md');
        const d = FIXTURES.responses.decide[String(state.round)];
        if (d.continue) writeJson(outputs['round-request.md'], { ...state, round: state.round + 1, queries: d.queries });
        else writeText(outputs['review.md'], d.report);
        break;
      }
      case 'finish-empty':
        writeText(outputs['review.md'], FIXTURES.responses.finish_empty.report);
        break;
      default:
        throw new Error(`unexpected step ${step}`);
    }
    await complete(launch, session);
  };
}

test('the appendix rollout: two rounds, three readers, one review', async () => {
  const dir = taskDir();
  const harness = new FakeHarness(agent());
  const engine = openEngine(PLAYBOOK, harness, dir);
  engine.seed([]);
  await settle(engine);

  const counts = Object.fromEntries(PLAYBOOK.steps.map((s) => [s.key, byStep(engine, s.key).length]));
  assert.deepEqual(counts, { frame: 1, discover: 2, read: 3, synthesize: 2, decide: 2, 'finish-empty': 0 });
  assert.ok([...engine.state.executions.values()].every((e) => e.status === 'done'));
  assert.deepEqual(engine.diagnose(), { ambiguities: [], blocked: [] });

  // Round 2 synthesis bound round 2's batch, not round 1's, and only round 2's assessment.
  const [discover1, discover2] = byStep(engine, 'discover');
  const [, synthesize2] = byStep(engine, 'synthesize');
  assert.deepEqual(synthesize2.inputs['batch.md'], [`${discover2.id}/batch.md`]);
  assert.equal(synthesize2.inputs['assessment*.md'].length, 1);
  assert.equal(byStep(engine, 'synthesize')[0].inputs['batch.md'][0], `${discover1.id}/batch.md`);

  // The second discover was triggered by the fresh round-request from decide, not frame's.
  const [decide1] = byStep(engine, 'decide');
  assert.deepEqual(discover2.inputs['round-request.md'], [`${decide1.id}/round-request.md`]);

  // The final review exists at its assigned path and nothing else was manufactured.
  const [, decide2] = byStep(engine, 'decide');
  assert.deepEqual(decide2.receipt!.map((o) => o.role), ['review.md']);
  assert.ok(existsSync(join(decide2.outDir, 'review.md')));

  // Depth is 1 + max producer depth; readers of one round share a depth.
  // frame 1, discover 2, read 3, synthesize 4, decide 5, discover 6, read 7.
  assert.deepEqual(byStep(engine, 'read').map((e) => e.depth), [3, 3, 7]);

  // Replaying the log reproduces the state exactly.
  const replayed = Engine.open({ playbook: PLAYBOOK, harness, cwd: dir.root, artifactsDir: dir.artifactsDir, logPath: dir.logPath });
  assert.deepEqual([...replayed.state.executions.values()], [...engine.state.executions.values()]);
  assert.deepEqual(replayed.state.seeds, engine.state.seeds);
});

test('empty discovery takes the finish-empty route and starts no readers', async () => {
  const engine = openEngine(PLAYBOOK, new FakeHarness(agent({ '1': { sources: [], notes: 'none' } })));
  engine.seed([]);
  await settle(engine);
  const counts = Object.fromEntries(PLAYBOOK.steps.map((s) => [s.key, byStep(engine, s.key).length]));
  assert.deepEqual(counts, { frame: 1, discover: 1, read: 0, synthesize: 0, decide: 0, 'finish-empty': 1 });
});

test('a failed reader holds up synthesis until a human resumes it', async () => {
  let crashOnce = true;
  const script = agent();
  const harness = new FakeHarness(async (launch, session) => {
    if (launch.step === 'read' && crashOnce) {
      crashOnce = false;
      throw new Error('reader crashed');
    }
    await script(launch, session);
  });
  const engine = openEngine(PLAYBOOK, harness);
  engine.seed([]);
  await settle(engine);

  const failed = byStep(engine, 'read').find((e) => e.status === 'failed')!;
  assert.equal(failed.failure, 'reader crashed');
  assert.equal(byStep(engine, 'synthesize').length, 0);
  assert.match(engine.diagnose().blocked[0].reason, /waiting for read/);

  await engine.resume(failed.id);
  await settle(engine);
  assert.equal(byStep(engine, 'decide').length, 2);
  assert.ok([...engine.state.executions.values()].every((e) => e.status === 'done'));
});
