import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runReview } from './process.mjs';
import { fixtureAgent, fixtures } from './agents.mjs';

const results = [];
const starts = events => events.filter(event => event.event === 'start');
const calls = (events, phase) => starts(events).filter(event => event.phase === phase);
const expectedReaders = { normal: ['A', 'B', 'C'], empty_first: [], empty_second: ['A', 'B'],
  failed_reader: ['A', 'B'], one_reader: ['A'] };

async function check(name, scenario = name, override = {}) {
  const events = [];
  let report, failure;
  try { report = await runReview(fixtureAgent(scenario, events, override), fixtures.question, `fixture-${name}`); }
  catch (error) { failure = String(error); }
  const expected = name === 'deduplicate' ? expectedReaders.normal : expectedReaders[scenario];
  assert.deepEqual(calls(events, 'read').map(event => event.key), expected);
  assert.equal(calls(events, 'frame').length, 1);
  if (scenario === 'failed_reader') {
    assert.match(failure, /SIMULATED reader B failed/);
    assert.equal(calls(events, 'synthesize').length, 0);
    assert.equal(calls(events, 'decide').length, 0);
  } else {
    assert.equal(failure, undefined);
    const finalPhase = scenario.startsWith('empty_') ? 'finish_empty' : 'decide';
    const last = calls(events, finalPhase).at(-1);
    const output = override[finalPhase]?.[last.key] ?? fixtures.scenarios[scenario][finalPhase]?.[last.key]
      ?? fixtures.responses[finalPhase][last.key];
    assert.equal(report, output.report);
  }
  if (scenario === 'empty_first') assert.deepEqual(starts(events).map(event => event.phase), ['frame', 'discover', 'finish_empty']);
  if (scenario === 'empty_second') {
    assert.equal(calls(events, 'synthesize').length, 1);
    assert.equal(calls(events, 'decide').length, 1);
    assert.deepEqual(calls(events, 'finish_empty')[0].input.state.assessments.map(item => item.id), ['A', 'B']);
  }
  // Every synthesis starts only after all of its batch's readers have succeeded.
  for (const synthesis of calls(events, 'synthesize')) {
    const index = events.indexOf(synthesis);
    const sources = synthesis.input.discovery.sources;
    assert.deepEqual(synthesis.input.assessments.map(item => item.url), sources.map(item => item.url));
    for (const source of sources) assert(events.slice(0, index).some(event => event.event === 'done'
      && event.phase === 'read' && event.key === source.id));
  }
  for (const decision of calls(events, 'decide')) {
    const round = decision.input.state.round;
    const assessments = calls(events, 'synthesize').filter(event => event.input.state.round <= round)
      .flatMap(event => event.input.assessments);
    assert.deepEqual(decision.input.state.assessments, assessments);
    assert.deepEqual(decision.input.state.seen, assessments.map(item => item.url));
    assert.equal(decision.input.state.synthesis, decision.input.synthesis.text);
  }
  if (scenario === 'normal') {
    assert.deepEqual(calls(events, 'discover').map(event => event.key), ['1', '2']);
    const second = calls(events, 'discover')[1].input.state;
    assert.deepEqual(second.queries, fixtures.responses.decide['1'].queries);
    assert.deepEqual(second.assessments.map(item => item.id), ['A', 'B']);
    assert.deepEqual(second.seen, ['https://example.invalid/paper-a', 'https://example.invalid/paper-b']);
    const aDone = events.findIndex(event => event.event === 'done' && event.phase === 'read' && event.key === 'A');
    const bStart = events.findIndex(event => event.event === 'start' && event.phase === 'read' && event.key === 'B');
    assert(bStart < aDone, 'Readers must overlap on the real engine');
  }
  results.push({ name, passed: true, report, expectedFailure: failure, events });
}

for (const name of Object.keys(expectedReaders)) await check(name);
const a = fixtures.responses.discover['1'].sources[0];
const b = fixtures.responses.discover['1'].sources[1];
const c = fixtures.responses.discover['2'].sources[0];
await check('deduplicate', 'normal', { discover: {
  '1': { sources: [a, { ...a, url: ` ${a.url} ` }, b], notes: 'SIMULATED duplicated first batch.' },
  '2': { sources: [a, c, { ...c, url: ` ${c.url} ` }], notes: 'SIMULATED repeated known and fresh sources.' }
} });

for (const [name, scenario, override, message, forbidden] of [
  ['invalid_frame_question', 'normal', { frame: { ...fixtures.responses.frame, question: 'different' } },
    /preserve the research question/, 'discover'],
  ['invalid_frame_state', 'normal', { frame: { ...fixtures.responses.frame, round: 2 } },
    /initialize an empty first round/, 'discover'],
  ['invalid_reader_identity', 'normal', { read: { A: { ...fixtures.responses.read.A, url: b.url } } },
    /assess its assigned source/, 'synthesize'],
  ['invalid_reader_title', 'normal', { read: { A: { ...fixtures.responses.read.A, title: 'Changed source title' } } },
    /assess its assigned source/, 'synthesize'],
  ['invalid_continuation', 'normal', { decide: { '1': { ...fixtures.responses.decide['1'], queries: [' '] } } },
    /continuation requires nonempty queries/, 'finish_empty'],
  ['invalid_stop_report', 'one_reader', { decide: { '1': { ...fixtures.scenarios.one_reader.decide['1'], report: '' } } },
    /stopping requires a final report/, 'finish_empty'],
  ['invalid_empty_report', 'empty_first', { finish_empty: { '1': { report: '' } } },
    /empty discovery requires a final report/, 'read']
]) {
  const events = [];
  let failure;
  try { await runReview(fixtureAgent(scenario, events, override), fixtures.question, name); }
  catch (error) { failure = String(error); }
  assert.match(failure, message);
  assert.equal(calls(events, forbidden).length, 0);
  assert.equal(calls(events, 'discover').filter(event => event.key === '2').length, 0);
  results.push({ name, passed: true, expectedFailure: failure, events });
}

const paths = ['process.mjs', 'agents.mjs', 'register.mjs', 'test.mjs', 'package-lock.json',
  '../shared/prompts.json', '../shared/schemas.json', '../shared/fixtures.json'];
const evidence = {
  generatedAt: new Date().toISOString(), engine: 'Smithers native FlowEngine.layerMemory',
  smithersCommit: '8fee1a6d88ef0308159cb1c9bd6a462ebf660724', smithersPackageVersion: '1.0.0-rc.1',
  node: process.version, effect: '4.0.0-rc.115', agentResponses: 'synthetic deterministic fixtures',
  liveInferenceTested: false, durableRestartTested: false, homemadeScheduler: false,
  hashes: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex')])),
  passed: results.length, failed: 0, results
};
writeFileSync(new URL('./test-report.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
console.log(`${results.length} native Smithers scenarios passed; evidence: test-report.json`);
