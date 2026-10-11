import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Ajv from 'ajv';

const shared = name => JSON.parse(readFileSync(new URL(`../shared/${name}.json`, import.meta.url), 'utf8'));
export const schemas = shared('schemas');
const prompts = shared('prompts');
export const fixtures = shared('fixtures');
const ajv = new Ajv({ allErrors: true });
const validators = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]));

function validate(phase, input, output) {
  if (!validators[phase](output)) throw new Error(`${phase}: ${ajv.errorsText(validators[phase].errors)}`);
  if (phase === 'frame' && output.question !== input.question)
    throw new Error('frame must preserve the research question');
  if (phase === 'frame' && (output.round !== 1 || output.seen.length || output.assessments.length || output.synthesis !== ''))
    throw new Error('frame must initialize an empty first round');
  if (phase === 'read' && (output.id !== input.source.id || output.url !== input.source.url || output.title !== input.source.title))
    throw new Error('read must assess its assigned source');
  if (phase === 'decide' && output.continue && (!output.queries.length || output.queries.some(query => !query.trim())))
    throw new Error('continuation requires nonempty queries');
  if (phase === 'decide' && !output.continue && !output.report.trim())
    throw new Error('stopping requires a final report');
  if (phase === 'finish_empty' && !output.report.trim())
    throw new Error('empty discovery requires a final report');
  return output;
}

export function fixtureAgent(scenario, events, override = {}) {
  const changes = { ...fixtures.scenarios[scenario], ...override };
  if (!(scenario in fixtures.scenarios)) throw new Error(`Unknown fixture: ${scenario}`);
  return async (phase, input, signal) => {
    const key = phase === 'read' ? input.source.id : String(input.state?.round ?? '');
    events.push({ event: 'start', phase, key, input: structuredClone(input) });
    // A real asynchronous boundary makes overlapping readers observable.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, phase === 'read' ? 20 : 0);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true });
    });
    const output = phase === 'frame' ? changes.frame ?? fixtures.responses.frame
      : changes[phase]?.[key] ?? fixtures.responses[phase]?.[key];
    if (!output) throw new Error(`Missing fixture ${phase}/${key}`);
    if (output.__error__) {
      events.push({ event: 'failed', phase, key });
      throw new Error(output.__error__);
    }
    const result = validate(phase, input, structuredClone(output));
    events.push({ event: 'done', phase, key });
    return result;
  };
}

const execute = promisify(execFile);
export async function claudeAgent(phase, input, signal) {
  const tools = ['discover', 'read'].includes(phase)
    ? ['--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch'] : ['--tools', ''];
  const { stdout } = await execute('claude', ['-p', JSON.stringify(input), '--system-prompt', prompts[phase],
    '--output-format', 'json', '--json-schema', JSON.stringify(schemas[phase]), '--no-session-persistence', ...tools],
    { signal, maxBuffer: 16 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  if (result.is_error) throw new Error(`Claude ${phase} failed: ${result.result}`);
  if (!result.structured_output) throw new Error(`Claude ${phase} returned no structured_output`);
  return validate(phase, input, result.structured_output);
}
