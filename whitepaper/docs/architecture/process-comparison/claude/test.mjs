import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import vm from 'node:vm';

const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const fixtures = await json('../shared/fixtures.json');
const prompts = await json('../shared/prompts.json');
const schemas = await json('../shared/schemas.json');
const source = await readFile(new URL('./matched-literature-review.js', import.meta.url), 'utf8');
assert.match(source, /^export const meta = \{/);
// Native workflow files permit both an exported meta object and top-level return.
// This syntax adaptation preserves every process-body byte; it is not a native run.
const compiled = new vm.Script(`(async () => {\n${source.replace(/^export /, '')}\n})()`, {
  filename: 'matched-literature-review.js (Node compatibility wrapper)',
});
const clone = value => JSON.parse(JSON.stringify(value));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function scenario(name, overrides, expectedError) {
  const calls = [];
  const completed = new Set();
  const batches = [];
  let activeReaders = 0;
  let maxReaders = 0;
  const context = vm.createContext({
    args: {question: fixtures.question},
    async agent(text, {schema, label}) {
      const operation = label.split(':')[0];
      const prefix = `${prompts[operation]}\n\nINPUT_JSON\n`;
      assert.ok(text.startsWith(prefix), `Canonical prompt: ${operation}`);
      assert.deepEqual(clone(schema), schemas[operation], `Canonical schema: ${operation}`);
      const input = JSON.parse(text.slice(prefix.length));
      const key = operation === 'read' ? input.source.id : String(input.state?.round);
      calls.push({operation, key, input});
      if (operation === 'synthesize') {
        assert.equal(activeReaders, 0, 'Synthesis waits for all readers');
        assert.deepEqual(input.assessments.map(value => value.id),
          input.discovery.sources.map(value => value.id));
        for (const item of input.discovery.sources) {
          assert.ok(completed.has(`${input.state.round}:${item.id}`));
        }
      }
      if (operation === 'decide') {
        assert.equal(input.state.synthesis, input.synthesis.text);
        assert.equal(input.state.assessments.length, input.state.seen.length);
      }
      if (operation === 'read') {
        activeReaders += 1;
        maxReaders = Math.max(maxReaders, activeReaders);
        await wait(input.source.id === 'B' ? 10 : 2);
        activeReaders -= 1;
      }
      const result = operation === 'frame'
        ? overrides.frame ?? fixtures.responses.frame
        : overrides[operation]?.[key] ?? fixtures.responses[operation]?.[key];
      assert.notEqual(result, undefined, `Missing fixture ${operation}/${key}`);
      if (result.__error__) return null; // Documented native agent failure sentinel.
      if (operation === 'read') completed.add(`${input.state.round}:${input.source.id}`);
      return clone(result);
    },
    async pipeline(items, task) {
      batches.push(items.length);
      return Promise.all(items.map(task));
    },
  });
  let report;
  let error;
  try {
    report = await compiled.runInContext(context, {timeout: 1000});
  } catch (caught) {
    error = String(caught.message);
  }
  const phases = calls.map(call => call.operation);
  if (name === 'failed_reader' || expectedError) {
    assert.match(error, expectedError ?? /read:1:B failed or was stopped/);
    if (name === 'failed_reader' || name.startsWith('mismatched_reader_')) {
      assert.ok(!phases.includes('synthesize') && !phases.includes('decide'));
    }
  } else {
    assert.equal(error, undefined);
    assert.equal(typeof report, 'string');
    assert.match(report, /SIMULATED/);
  }
  if (name === 'normal') {
    assert.deepEqual(batches, [2, 1]);
    assert.equal(maxReaders, 2);
    assert.equal(phases.filter(value => value === 'frame').length, 1);
    assert.equal(calls.length, 10);
    const round2 = calls.find(call => call.operation === 'discover' && call.key === '2').input.state;
    assert.deepEqual(round2.assessments.map(value => value.id), ['A', 'B']);
    assert.deepEqual(round2.queries, fixtures.responses.decide['1'].queries);
    assert.equal(report, fixtures.responses.decide['2'].report);
  }
  if (name === 'empty_first') {
    assert.deepEqual(phases, ['frame', 'discover', 'finish_empty']);
    assert.deepEqual(batches, []);
  }
  if (name === 'empty_second') {
    assert.deepEqual(batches, [2]);
    assert.equal(phases.at(-1), 'finish_empty');
    assert.equal(calls.at(-1).input.state.assessments.length, 2);
  }
  if (name === 'one_reader') assert.deepEqual(batches, [1]);
  if (name === 'duplicate_and_seen_urls') {
    assert.deepEqual(batches, [2, 1]);
    assert.deepEqual(calls.filter(call => call.operation === 'read').map(call => call.key), ['A', 'B', 'C']);
  }
  return {name, passed: true, phases, reader_batches: batches, maximum_simulated_concurrent_readers: maxReaders,
    report: report ?? null, expected_failure: error ?? null};
}

const tests = [];
for (const [name, overrides] of Object.entries(fixtures.scenarios)) {
  tests.push(await scenario(name, overrides));
}
const first = fixtures.responses.discover['1'];
const second = fixtures.responses.discover['2'];
tests.push(await scenario('duplicate_and_seen_urls', {
  discover: {
    '1': {...first, sources: [...first.sources, {...first.sources[0], url: ` ${first.sources[0].url} `}]},
    '2': {...second, sources: [first.sources[0], ...second.sources]},
  },
}));
for (const key of ['id', 'url', 'title']) {
  tests.push(await scenario(`mismatched_reader_${key}`, {
    read: {B: {...fixtures.responses.read.B, [key]: 'SIMULATED incorrect identity'}},
  }, /changed its assigned source identity/));
}
tests.push(await scenario('empty_stop_report', {
  decide: {'2': {...fixtures.responses.decide['2'], report: '   '}},
}, /returned an empty final report/));
tests.push(await scenario('empty_finish_empty_report', {
  ...fixtures.scenarios.empty_first,
  finish_empty: {'1': {report: '\n'}},
}, /returned an empty final report/));

const results = {
  checked_at: new Date().toISOString(),
  execution_environment: `Node ${process.version} vm compatibility harness`,
  native_runtime_verified: false,
  live_inference_verified: false,
  syntax_verified: 'Node parse after removing initial export keyword and adding async function wrapper',
  body_modified_for_test: false,
  shims: ['agent: canonical deterministic fixture outputs', 'pipeline: Promise.all over inputs'],
  generated_script_sha256: createHash('sha256').update(source).digest('hex'),
  canonical_prompt_and_schema_arguments_verified: true,
  scenarios: tests,
  passed: tests.every(test => test.passed),
};
await writeFile(new URL('./checks.json', import.meta.url), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify({passed: true, scenarios: tests.length, native_runtime_verified: false}));
