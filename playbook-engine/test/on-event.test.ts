import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readLog } from '../src/state.ts';
import { FakeHarness } from './fake-harness.ts';
import { openEngine, playbook, step, taskDir } from './helpers.ts';

test('onEvent runs once per logged event, after the state applied it, and its failure is not the engine\'s', () => {
  const dir = taskDir();
  const ticket = join(dir.root, 'ticket.md');
  writeFileSync(ticket, 'x');
  const seen: { t: string; seeds: number }[] = [];
  const engine = openEngine(playbook([step('a')]), new FakeHarness(async () => {}), dir, {
    onEvent: (ev, state) => {
      seen.push({ t: ev.t, seeds: state.seeds.length });
      throw new Error('subscriber broke');
    },
  });
  engine.seed([{ role: 'ticket.md', path: ticket }]);
  assert.deepEqual(seen, [{ t: 'seeded', seeds: 1 }]);
  assert.equal(readLog(dir.logPath).length, 1);
});
