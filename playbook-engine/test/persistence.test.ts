/**
 * The stored State is the only truth (O14 b), and each step keeps the bytes it saw (O27).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Engine } from '../src/engine.ts';
import { findObject } from '../src/history.ts';
import type { Launch } from '../src/harness.ts';
import type { Execution, State } from '../src/state.ts';
import { stateFromJson, stateToJson } from '../src/state.ts';
import { complete, FakeHarness, type FakeSession } from './fake-harness.ts';
import { fileStore, playbook, settle, step, taskDir, writeText } from './helpers.ts';

const input = (path: string) => ({ path, mode: 'single' as const });
const out = (path: string) => ({ path });
// Fork and join: seed, then sum and product side by side, then combine.
const FORK_JOIN = playbook([
  step('seed', { inputs: [input('ticket.md')], outputs: [out('numbers.md')] }),
  step('sum', { inputs: [input('numbers.md')], outputs: [out('sum.md')] }),
  step('product', { inputs: [input('numbers.md')], outputs: [out('product.md')] }),
  step('combine', { inputs: [input('sum.md'), input('product.md')], outputs: [out('final.md')] }),
]);

/**
 * The agent outlives the engine. Its completion call goes to the current engine, and while there is none
 * (the daemon is down) it waits and asks again, as a restored agent session does.
 */
const agent = (engine: () => Engine | undefined) => async (launch: Launch, _session: FakeSession) => {
  for (const [role, path] of Object.entries(launch.outputs)) writeText(path, `${launch.step} wrote ${role}`);
  for (;;) {
    const current = engine();
    if (current) {
      const reply = await current.requestCompletion(launch.executionId);
      if (reply.kind === 'accepted') return;
      if (reply.kind === 'rejected') throw new Error(reply.problems.join('; '));
    }
    await new Promise((r) => setImmediate(r));
  }
};

const receipts = (state: State) => [...state.executions.values()].map((e) => ({ id: e.id, step: e.step, status: e.status, inputs: e.inputs, receipt: e.receipt?.map((o) => o.id) }));

function seedTicket(dir: ReturnType<typeof taskDir>) {
  const path = join(dir.root, 'ticket.md');
  writeText(path, 'the task');
  return [{ role: 'ticket.md', path }];
}

test('killing the engine after each save and reopening from the stored state ends with the same receipts', async () => {
  // The reference run, and how many saves it makes.
  const refDir = taskDir();
  const ref = fileStore(refDir.statePath);
  let refEngine: Engine;
  const refHarness = new FakeHarness(agent(() => refEngine));
  refEngine = Engine.open({ playbook: FORK_JOIN, harness: refHarness, cwd: refDir.root, artifactsDir: refDir.artifactsDir, ...ref });
  refEngine.seed(seedTicket(refDir));
  await settle(refEngine);
  await refEngine.flush();
  const expected = receipts(refEngine.state);
  assert.equal(expected.length, 4);
  assert.ok(expected.every((e) => e.status === 'done'));
  const total = ref.saves.count;
  assert.ok(total >= 8, `expected a save per change, got ${total}`);

  for (let kill = 1; kill <= total; kill++) {
    const dir = taskDir();
    const store = fileStore(dir.statePath);
    let dead = false;
    let writes = 0;
    const killed = {
      load: store.load,
      save: (state: State) => {
        if (dead) return; // the process is gone: nothing more reaches the disk
        store.save(state);
        if (++writes === kill) {
          dead = true;
          current = undefined;
        }
      },
    };
    let current: Engine | undefined;
    const harness = new FakeHarness(agent(() => current));
    const first = Engine.open({ playbook: FORK_JOIN, harness, cwd: dir.root, artifactsDir: dir.artifactsDir, ...killed });
    current = first;
    first.seed(seedTicket(dir));
    for (let i = 0; i < 400 && !dead; i++) {
      await first.tick();
      await new Promise((r) => setImmediate(r));
    }
    assert.ok(dead, `save ${kill} of ${total} never happened`);
    // Restart: a new engine from the stored state alone. The harness (the agents) outlives it.
    const restarted = Engine.open({ playbook: FORK_JOIN, harness, cwd: dir.root, artifactsDir: dir.artifactsDir, ...fileStore(dir.statePath) });
    current = restarted;
    await settle(restarted);
    await restarted.flush();
    assert.deepEqual(receipts(restarted.state), expected, `killed after save ${kill}`);
  }
});

test('history: a step keeps the bytes it consumed and published, whatever the live files do later', async () => {
  const dir = taskDir();
  const store = fileStore(dir.statePath);
  let engine: Engine | undefined;
  const harness = new FakeHarness(agent(() => engine));
  const open = () => Engine.open({ playbook: FORK_JOIN, harness, cwd: dir.root, artifactsDir: dir.artifactsDir, ...store, historyDir: dir.historyDir });
  engine = open();
  engine.seed(seedTicket(dir));
  await settle(engine);
  await engine.flush();
  const before = JSON.stringify(stateToJson(engine.state));
  const sum = engine.state.executions.get('e2')!;
  assert.equal(sum.step, 'sum');
  const consumed = sum.manifest!.consumed[0];
  const original = 'seed wrote numbers.md';
  assert.equal(consumed.sha256, createHash('sha256').update(original).digest('hex'));

  // Rewrite the live file in place (same inode), then restart.
  const live = join(engine.state.executions.get('e1')!.outDir, 'numbers.md');
  const inode = statSync(live).ino;
  writeFileSync(live, 'changed afterwards');
  assert.equal(statSync(live).ino, inode);
  engine = open();
  assert.equal(JSON.stringify(stateToJson(engine.state)), before, 'a modified live file changes no manifest');

  const found = findObject(dir.historyDir, 'e2', consumed.sha256!);
  assert.equal(found.kind, 'found');
  if (found.kind !== 'found') return;
  assert.equal(readFileSync(found.path, 'utf8'), original);
  // A copy, not a link: a different file from the live one, which was rewritten in place.
  assert.notEqual(statSync(found.path).ino, inode);
  // What the producing step published is kept too.
  const seed = engine.state.executions.get('e1')!;
  const published = seed.manifest!.published[0];
  assert.equal(readFileSync((findObject(dir.historyDir, 'e1', published.sha256!) as { path: string }).path, 'utf8'), original);
  assert.deepEqual(seed.manifest!.consumed.map((f) => f.role), ['ticket.md']);

  // Archiving removes the objects directories; the manifests stay and the bytes read as pruned.
  rmSync(dir.historyDir, { recursive: true });
  assert.equal(findObject(dir.historyDir, 'e2', consumed.sha256!).kind, 'pruned');
  assert.equal(engine.state.executions.get('e2')!.manifest!.consumed[0].sha256, consumed.sha256);
});

test('history: a 200 MB file is stored byte for byte', { timeout: 120_000 }, async () => {
  const dir = taskDir();
  const big = join(dir.root, 'ticket.md');
  const chunk = Buffer.alloc(1 << 20);
  const whole = createHash('sha256');
  const fd = openSync(big, 'w');
  for (let i = 0; i < 200; i++) {
    chunk.fill(i + 1);
    chunk.writeUInt32LE((i * 2654435761) >>> 0, 0);
    writeSync(fd, chunk);
    whole.update(chunk);
  }
  closeSync(fd);
  let engine: Engine | undefined;
  const harness = new FakeHarness(agent(() => engine));
  engine = Engine.open({ playbook: playbook([step('seed', { inputs: [input('ticket.md')], outputs: [out('numbers.md')] })]), harness, cwd: dir.root, artifactsDir: dir.artifactsDir, ...fileStore(dir.statePath), historyDir: dir.historyDir });
  engine.seed([{ role: 'ticket.md', path: big }]);
  await settle(engine);
  await engine.flush();
  const record = engine.state.executions.get('e1')!.manifest!.consumed[0];
  assert.equal(record.size, 200 * (1 << 20));
  assert.equal(record.sha256, whole.digest('hex'));
  const found = findObject(dir.historyDir, 'e1', record.sha256!) as { path: string };
  const stored = createHash('sha256');
  const rfd = openSync(found.path, 'r');
  const buf = Buffer.alloc(1 << 20);
  for (let n = readSyncAll(rfd, buf); n > 0; n = readSyncAll(rfd, buf)) stored.update(buf.subarray(0, n));
  closeSync(rfd);
  assert.equal(stored.digest('hex'), record.sha256);
});

function readSyncAll(fd: number, buf: Buffer): number {
  return readSync(fd, buf, 0, buf.length, null);
}

test('history: a coding step records its worktree tree under a ref, and it survives a restart', async () => {
  const dir = taskDir();
  // A throwaway repository for the fixture only; the product spawns git through alinery_core::git_cmd.
  const repo = join(dir.root, 'repo');
  mkdirSync(repo);
  const env = { PATH: process.env.PATH ?? '', HOME: dir.root, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'first');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  let engine: Engine | undefined;
  const harness = new FakeHarness(agent(() => engine));
  const pb = playbook([step('build', { isCodingStep: true, inputs: [input('ticket.md')], outputs: [out('built.md')] })]);
  const options = {
    playbook: pb,
    harness,
    cwd: repo,
    artifactsDir: dir.artifactsDir,
    historyDir: dir.historyDir,
    recordWorktree: (e: Execution) => {
      const tree = git('rev-parse', 'HEAD^{tree}');
      const commit = git('commit-tree', tree, '-m', `execution ${e.id}`);
      const ref = `refs/alinery/executions/${e.id}`;
      git('update-ref', ref, commit);
      return { ref, tree };
    },
    ...fileStore(dir.statePath),
  };
  engine = Engine.open(options);
  engine.seed(seedTicket(dir));
  await settle(engine);
  await engine.flush();
  const recorded = engine.state.executions.get('e1')!.manifest!.worktree!;
  // The live branch moves on and the tree object is still there, kept alive by the ref.
  writeFileSync(join(repo, 'a.txt'), 'second');
  git('add', '-A');
  git('commit', '-q', '-m', 'two');
  git('gc', '-q', '--prune=now');
  engine = Engine.open(options);
  assert.deepEqual(engine.state.executions.get('e1')!.manifest!.worktree, recorded);
  assert.equal(git('cat-file', '-t', recorded.tree), 'tree');
  assert.equal(git('rev-parse', `${recorded.ref}^{tree}`), recorded.tree);
});

test('history: the inputs are captured before the agent is started, so a launch that edits one cannot change what was recorded', async () => {
  const dir = taskDir();
  const ticket = join(dir.root, 'ticket.md');
  const harness = new FakeHarness(async (launch) => {
    for (const path of Object.values(launch.outputs)) writeText(path, 'done');
  });
  const start = harness.start.bind(harness);
  harness.start = async (launch: Launch) => {
    writeText(ticket, 'edited while the agent was launching');
    return start(launch);
  };
  const engine = Engine.open({ playbook: playbook([step('only', { inputs: [input('ticket.md')], outputs: [out('o.md')] })]), harness, cwd: dir.root, artifactsDir: dir.artifactsDir, historyDir: dir.historyDir, ...fileStore(dir.statePath) });
  writeText(ticket, 'the task');
  engine.seed([{ role: 'ticket.md', path: ticket }]);
  await engine.tick();
  await engine.flush();
  const consumed = engine.state.executions.get('e1')!.manifest!.consumed[0]!;
  assert.equal(consumed.sha256, createHash('sha256').update('the task').digest('hex'));
});

test('a state converted to JSON and back is the same state', () => {
  const state: State = { seeds: [{ id: 'seed/a.md', role: 'a.md', path: '/x/a.md', producer: null }], executions: new Map(), ambiguities: [] };
  assert.deepEqual(stateFromJson(JSON.parse(JSON.stringify(stateToJson(state)))), state);
});
