import { readFileSync } from 'node:fs';
import { runReview } from './process.mjs';
import { claudeAgent } from './agents.mjs';
const question = process.argv.slice(2).join(' ') || readFileSync(new URL('../shared/question.txt', import.meta.url), 'utf8').trim();
console.log(await runReview(claudeAgent, question, `live-${crypto.randomUUID()}`));
