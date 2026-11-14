import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeHarness } from './fake-harness.ts';
import { fileStore, openEngine, playbook, step, taskDir } from './helpers.ts';

test('onSaved runs after a save reached the store, and its failure is not the engine\'s', async () => {
  const dir = taskDir();
  const ticket = join(dir.root, 'ticket.md');
  writeFileSync(ticket, 'x');
  const store = fileStore(dir.statePath);
  const seen: number[] = [];
  const engine = openEngine(playbook([step('a')]), new FakeHarness(async () => {}), dir, {
    ...store,
    onSaved: (state) => {
      seen.push(state.seeds.length);
      throw new Error('subscriber broke');
    },
  });
  engine.seed([{ role: 'ticket.md', path: ticket }]);
  await engine.flush();
  assert.deepEqual(seen, [1]);
  assert.equal(store.load()!.seeds.length, 1);
});

test('saves are one at a time, coalesced, and the last one written is the latest', async () => {
  const dir = taskDir();
  const ticket = join(dir.root, 'ticket.md');
  writeFileSync(ticket, 'x');
  const written: number[] = [];
  let running = 0;
  let overlap = false;
  const engine = openEngine(playbook([step('a')]), new FakeHarness(async () => {}), dir, {
    save: async (state) => {
      if (++running > 1) overlap = true;
      const seeds = state.seeds.length;
      await new Promise((r) => setTimeout(r, 5));
      written.push(seeds);
      running--;
    },
  });
  engine.seed([{ role: 'ticket.md', path: ticket }]);
  await engine.tick(); // reserves 'a' while the first save may still be running
  await engine.flush();
  assert.equal(overlap, false);
  assert.equal(written.at(-1), 1);
});

test('a failed save is kept dirty, retried by flush, and then thrown', async () => {
  const dir = taskDir();
  const ticket = join(dir.root, 'ticket.md');
  writeFileSync(ticket, 'x');
  let fail = 2;
  let stored = 0;
  const engine = openEngine(playbook([step('a')]), new FakeHarness(async () => {}), dir, {
    save: (state) => {
      if (fail-- > 0) throw new Error('disk full');
      stored = state.seeds.length;
    },
  });
  engine.seed([{ role: 'ticket.md', path: ticket }]);
  await assert.rejects(engine.flush(), /disk full/);
  assert.equal(stored, 0);
  await engine.flush(); // the disk is back: the same change is written
  assert.equal(stored, 1);
});
