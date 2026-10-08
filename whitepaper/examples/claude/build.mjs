import {readFile, writeFile} from 'node:fs/promises';

const readJson = async name => JSON.parse(await readFile(
  new URL(`../shared/${name}.json`, import.meta.url), 'utf8',
));
const prompts = await readJson('prompts');
const schemas = await readJson('schemas');
const operations = ['frame', 'discover', 'read', 'synthesize', 'decide', 'finish_empty'];
for (const operation of operations) {
  if (typeof prompts[operation] !== 'string' || !schemas[operation]) {
    throw new Error(`Missing canonical prompt/schema: ${operation}`);
  }
}
const meta = {
  name: 'matched-literature-review',
  description: 'Iterative primary-source literature review with dynamic reader fan-out',
};
const body = await readFile(new URL('./workflow.body.js', import.meta.url), 'utf8');
const source = `export const meta = ${JSON.stringify(meta, null, 2)};\n\n`
  + `const PROMPTS = ${JSON.stringify(prompts, null, 2)};\n\n`
  + `const SCHEMAS = ${JSON.stringify(schemas, null, 2)};\n\n${body}`;
await writeFile(new URL('./matched-literature-review.js', import.meta.url), source);
console.log('Built matched-literature-review.js from canonical shared files.');
