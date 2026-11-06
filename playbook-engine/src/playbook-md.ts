/**
 * The one parser of the v2 `playbook.md` file: TOML `+++` frontmatter with the step records, then one
 * `<!-- alinery:step KEY -->` section per step holding its prompt. The engine runs the `Playbook` it
 * makes (`parsePlaybookMd`); the playbook library shows, edits and saves the document it makes
 * (`parsePlaybookDocument`, `renderPlaybookMd`): the same bytes, the same rules, one implementation.
 *
 * It is a port of the Rust parser it replaces (alinery-core `playbook.rs`, kept as the conformance
 * reference): every field the format does not define is an error (`deny_unknown_fields`), and so is
 * every token the engine does not implement, so an accepted document never means something the engine
 * cannot run. The Markdown body is opaque text; only exact, standalone section markers are structural.
 *
 * Known difference: TOML makes no difference between `2` and `2.0` once parsed (smol-toml), so a float
 * written where an integer is required is accepted as the integer.
 */
import { parse as parseToml } from 'smol-toml';
import { type Diagnostic, type InputMode, type Playbook, validatePlaybook } from './playbook.ts';

export type DocInput = { path: string; mode: InputMode };
export type DocOutput = { path: string; required: boolean };
/** A step as the library edits it: the field names of the file. */
export type DocStep = {
  key: string;
  title: string;
  short: string;
  is_coding_step: boolean;
  auto_advance_default: boolean;
  inputs: DocInput[];
  outputs: DocOutput[];
  model: string;
  harness: string;
  prompt: string;
};
/** `NormalizedPlaybook`: the file's metadata, each step with the prompt of its section, the text before the first section and the sections' order. */
export type PlaybookDocument = {
  version: number;
  key: string;
  title: string;
  description: string;
  default_model: string;
  default_harness: string;
  step: DocStep[];
  preamble: string;
  section_order: string[];
};
/** `PlaybookValidationError`. */
export type DocDiagnostic = { code: string; message: string; line: number | null; field: string | null; severity: 'error' };
export type DocumentResult = { document: PlaybookDocument; diagnostics: [] } | { document: null; diagnostics: DocDiagnostic[] };

export const PROMPT_TOKEN_LIST = [
  'ARTIFACTS_DIR',
  'ARTIFACT_FILE',
  'REVIEW_HANDOFF_FILE',
  'SESSION_HISTORY_DIR',
  'TASK_NAME',
  'TASK_SLUG',
  'WORKTREE',
  'PLAYBOOK_KEY',
  'PHASE_KEY',
  'PHASE_TITLE',
  'TICKET_FILE',
  'PROMPT_EXTRA',
];

const diag = (code: string, message: string, line: number | null = null, field: string | null = null): DocDiagnostic => ({ code, message, line, field, severity: 'error' });

export const validPlaybookKey = (key: string): boolean => /^[a-z0-9][a-z0-9-]*$/.test(key);

/** A literal directory and a filename with zero or one `*` (matching zero or more filename characters). */
type Selector = { directory: string; prefix: string; suffix: string; wildcard: boolean };

function parseSelector(path: string): Selector | string {
  if (path === '' || !path.endsWith('.md') || /[\\:?[\]]/.test(path) || /[\u0000-\u001f\u007f-\u009f]/.test(path)) return 'expected a safe relative .md path with at most one filename wildcard';
  const parts = path.split('/');
  for (const [i, part] of parts.entries()) {
    if (part === '' || part === '.' || part === '..' || (i < parts.length - 1 && part.includes('*'))) return 'empty, dot, parent and wildcard directory components are forbidden';
  }
  const slash = path.lastIndexOf('/');
  const directory = slash < 0 ? '' : path.slice(0, slash);
  const filename = slash < 0 ? path : path.slice(slash + 1);
  const star = filename.indexOf('*');
  if (star < 0) return { directory, prefix: filename, suffix: '', wildcard: false };
  const suffix = filename.slice(star + 1);
  if (suffix.includes('*')) return 'at most one wildcard is permitted';
  return { directory, prefix: filename.slice(0, star), suffix, wildcard: true };
}

const matchesFilename = (s: Selector, filename: string) => filename.length >= s.prefix.length + s.suffix.length && filename.startsWith(s.prefix) && filename.endsWith(s.suffix);

function overlaps(a: Selector, b: Selector): boolean {
  if (a.directory !== b.directory) return false;
  if (!a.wildcard && !b.wildcard) return a.prefix === b.prefix;
  if (!a.wildcard) return matchesFilename(b, a.prefix);
  if (!b.wildcard) return matchesFilename(a, b.prefix);
  // Arbitrarily long star expansions separate the prefix and suffix constraints: a witness exists exactly when both literal pairs agree.
  return (a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix)) && (a.suffix.endsWith(b.suffix) || b.suffix.endsWith(a.suffix));
}

type Table = Record<string, unknown>;
const isTable = (v: unknown): v is Table => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
const KINDS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  integer: (v) => (typeof v === 'number' && Number.isInteger(v)) || typeof v === 'bigint',
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
};

/** Required and optional (`kind?`) fields with their types, and no others. */
function checkFields(table: Table, fields: [string, string][], at: string, errors: DocDiagnostic[]) {
  for (const [name, kindSpec] of fields) {
    const optional = kindSpec.endsWith('?');
    const kind = kindSpec.replace(/\?$/, '');
    const path = at === '' ? name : `${at}.${name}`;
    const value = table[name];
    if (value === undefined) {
      if (!optional) errors.push(diag('missing_field', `required field ${path} is missing`, null, path));
    } else if (!KINDS[kind](value)) errors.push(diag('invalid_field_type', `${path} must be ${kind}`, null, path));
  }
  for (const name of Object.keys(table)) {
    if (!fields.some(([known]) => known === name)) {
      const path = at === '' ? name : `${at}.${name}`;
      errors.push(diag('unknown_field', `unknown field ${path}`, null, path));
    }
  }
}

function sectionKey(line: string): string | undefined {
  if (!line.startsWith('<!-- alinery:step ') || !line.endsWith(' -->') || line.length < '<!-- alinery:step  -->'.length) return undefined;
  const key = line.slice('<!-- alinery:step '.length, line.length - ' -->'.length);
  return key === '' || /\s/.test(key) ? undefined : key;
}

function validateTokens(prompt: string, firstLine: number, field: string, errors: DocDiagnostic[]) {
  let offset = 0;
  for (;;) {
    const start = prompt.indexOf('{{', offset);
    if (start < 0) return;
    const end = prompt.indexOf('}}', start + 2);
    if (end < 0) return;
    if ((start === 0 || prompt[start - 1] !== '\\') && !PROMPT_TOKEN_LIST.includes(prompt.slice(start + 2, end))) {
      const lines = prompt.slice(0, start).split('\n').length - 1;
      errors.push(diag('unknown_prompt_token', `unknown prompt token ${prompt.slice(start, end + 2)}`, firstLine + lines, field));
    }
    offset = end + 2;
  }
}

const splitInclusive = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+/g) ?? [];
const trimEol = (line: string) => line.replace(/[\r\n]+$/, '');
/** Rust's `{:?}` of a string, for the ASCII a path can hold. */
const debugString = (s: string) => JSON.stringify(s);
const STRUCTURAL = new Set(['missing_field', 'unknown_field', 'invalid_field_type', 'invalid_input_mode']);

export function parsePlaybookDocument(input: string): DocumentResult {
  const fail = (errors: DocDiagnostic[]): DocumentResult => ({ document: null, diagnostics: errors });
  const source = input.startsWith('﻿') ? input.slice(1) : input;
  const lines = splitInclusive(source);
  if (trimEol(lines[0] ?? '') !== '+++') return fail([diag('missing_frontmatter', 'expected v2 TOML +++ frontmatter at the beginning of the file', 1)]);
  const metadataStart = lines[0].length;
  let offset = metadataStart;
  let closing: { end: number; bodyStart: number; bodyLine: number } | undefined;
  for (let index = 1; index < lines.length; index++) {
    if (trimEol(lines[index]) === '+++') {
      closing = { end: offset, bodyStart: offset + lines[index].length, bodyLine: index + 2 };
      break;
    }
    offset += lines[index].length;
  }
  if (!closing) return fail([diag('missing_frontmatter_end', 'missing closing +++ delimiter', 1)]);

  let table: Table;
  try {
    table = parseToml(source.slice(metadataStart, closing.end)) as Table;
  } catch (e) {
    const line = (e as { line?: number }).line;
    return fail([diag('invalid_toml', (e as Error).message, typeof line === 'number' ? line + 1 : null)]);
  }

  const errors: DocDiagnostic[] = [];
  checkFields(
    table,
    [
      ['version', 'integer'],
      ['key', 'string'],
      ['title', 'string'],
      ['description', 'string'],
      ['default_model', 'string'],
      ['default_harness', 'string'],
      ['step', 'array'],
    ],
    '',
    errors,
  );
  if (table.version !== 2 && table.version !== 2n) {
    errors.push(diag('unsupported_version', 'only playbook version 2 is supported', null, 'version'));
  }
  const steps = Array.isArray(table.step) ? table.step : undefined;
  if (steps) {
    if (steps.length === 0) errors.push(diag('missing_steps', 'at least one step is required', null, 'step'));
    for (const [index, step] of steps.entries()) {
      const field = `step[${index}]`;
      if (!isTable(step)) {
        errors.push(diag('invalid_field_type', 'step must be a table', null, field));
        continue;
      }
      checkFields(
        step,
        [
          ['key', 'string'],
          ['title', 'string'],
          ['short', 'string'],
          ['is_coding_step', 'boolean'],
          ['auto_advance_default', 'boolean'],
          ['inputs', 'array'],
          ['outputs', 'array'],
          ['model', 'string'],
          ['harness', 'string'],
        ],
        field,
        errors,
      );
      for (const name of ['inputs', 'outputs']) {
        const selectors = step[name];
        if (!Array.isArray(selectors)) continue;
        for (const [i, selector] of selectors.entries()) {
          const at = `${field}.${name}[${i}]`;
          if (!isTable(selector)) {
            errors.push(diag('invalid_field_type', 'selector must be a table', null, at));
            continue;
          }
          checkFields(selector, name === 'inputs' ? [['path', 'string'], ['mode', 'string']] : [['path', 'string'], ['required', 'boolean?']], at, errors);
          if (name === 'inputs' && typeof selector.mode === 'string' && !['single', 'each', 'complete'].includes(selector.mode)) {
            errors.push(diag('invalid_input_mode', 'mode must be single, each or complete', null, `${at}.mode`));
          }
        }
      }
    }
  }

  // Scan even after metadata errors: section diagnostics remain independently useful.
  const bodyLines = splitInclusive(source.slice(closing.bodyStart));
  const body = bodyLines.join('');
  const markers: { key: string; start: number; end: number; line: number }[] = [];
  offset = 0;
  for (const [index, line] of bodyLines.entries()) {
    const key = sectionKey(trimEol(line));
    if (key !== undefined) markers.push({ key, start: offset, end: offset + line.length, line: closing.bodyLine + index });
    offset += line.length;
  }
  const preamble = body.slice(0, markers[0]?.start ?? body.length);
  const known = new Set((steps ?? []).flatMap((s) => (isTable(s) && typeof s.key === 'string' ? [s.key] : [])));
  const sections = new Map<string, string>();
  const sectionOrder: string[] = [];
  for (const [index, m] of markers.entries()) {
    const prompt = body.slice(m.end, markers[index + 1]?.start ?? body.length);
    const field = `step[${m.key}].prompt`;
    if (!known.has(m.key)) errors.push(diag('unknown_step', `section refers to unknown step ${m.key}`, m.line, field));
    if (sections.has(m.key)) errors.push(diag('duplicate_step_section', `duplicate section for ${m.key}`, m.line, field));
    sections.set(m.key, prompt);
    if (prompt.trim() === '') errors.push(diag('empty_prompt', `step ${m.key} has an empty prompt`, m.line, field));
    validateTokens(prompt, m.line + 1, field, errors);
    sectionOrder.push(m.key);
  }
  for (const key of known) if (!sections.has(key)) errors.push(diag('missing_step_section', `missing section for ${key}`, null, `step[${key}].prompt`));

  // The Rust reader returned here when the metadata did not deserialize into its structs.
  if (errors.some((e) => STRUCTURAL.has(e.code))) return fail(errors);
  const meta = table as { version: number; key: string; title: string; description: string; default_model: string; default_harness: string; step: Table[] };
  if (!validPlaybookKey(meta.key)) errors.push(diag('invalid_key', 'playbook key must be a lowercase ASCII slug', null, 'key'));
  if (meta.title.trim() === '') errors.push(diag('empty_title', 'playbook title must not be empty', null, 'title'));
  const keys = new Set<string>();
  const outputs: { stepKey: string; path: string; selector: Selector }[] = [];
  for (const raw of meta.step) {
    const step = raw as unknown as { key: string; title: string; is_coding_step: boolean; inputs: { path: string; mode: string }[]; outputs: { path: string; required?: boolean }[] };
    const field = `step[${step.key}]`;
    if (!validPlaybookKey(step.key)) errors.push(diag('invalid_key', 'step key must be a lowercase ASCII slug', null, `${field}.key`));
    if (keys.has(step.key)) errors.push(diag('duplicate_step', `duplicate step ${step.key}`, null, `${field}.key`));
    keys.add(step.key);
    if (step.title.trim() === '') errors.push(diag('empty_title', 'step title must not be empty', null, `${field}.title`));
    let collections = 0;
    for (const [index, inp] of step.inputs.entries()) {
      const at = `${field}.inputs[${index}]`;
      if (inp.mode !== 'single') collections++;
      const selector = parseSelector(inp.path);
      if (typeof selector === 'string') {
        errors.push(diag('invalid_selector', selector, null, `${at}.path`));
        continue;
      }
      if (selector.wildcard !== (inp.mode !== 'single')) errors.push(diag('input_mode_path', 'single requires an exact path; each/complete require one wildcard', null, at));
      if (step.is_coding_step && (selector.wildcard || inp.mode !== 'single')) errors.push(diag('coding_input', 'coding steps may consume only exact single inputs', null, at));
    }
    if (collections > 1) errors.push(diag('multiple_collections', 'a step may consume only one each or complete collection', null, `${field}.inputs`));
    if (step.outputs.length === 0) errors.push(diag('missing_outputs', 'a step requires at least one output', null, `${field}.outputs`));
    for (const [index, out] of step.outputs.entries()) {
      const at = `${field}.outputs[${index}].path`;
      const selector = parseSelector(out.path);
      if (typeof selector === 'string') {
        errors.push(diag('invalid_selector', selector, null, at));
        continue;
      }
      if (out.required === true && selector.wildcard) errors.push(diag('required_wildcard', 'required applies only to an exact output; a wildcard family stays optional', null, at));
      // Evidence directories must stay unreachable on case-insensitive filesystems.
      if (['attachments', 'subtasks'].includes(out.path.split('/')[0].toLowerCase())) {
        errors.push(diag('reserved_output_namespace', 'attachments and subtasks are reserved output namespaces', null, at));
      }
      for (const other of outputs) {
        const sharedExact = other.stepKey !== step.key && !selector.wildcard && !other.selector.wildcard && other.path === out.path;
        if (overlaps(selector, other.selector) && !sharedExact) {
          errors.push(diag('overlapping_outputs', `step ${step.key} output ${debugString(out.path)} overlaps step ${other.stepKey} output ${debugString(other.path)}`, null, at));
        }
      }
      outputs.push({ stepKey: step.key, path: out.path, selector });
    }
  }
  if (errors.length) return fail(errors);

  const document: PlaybookDocument = {
    version: Number(meta.version),
    key: meta.key,
    title: meta.title,
    description: meta.description,
    default_model: meta.default_model,
    default_harness: meta.default_harness,
    step: meta.step.map((raw) => {
      const s = raw as unknown as Omit<DocStep, 'prompt' | 'outputs'> & { outputs: { path: string; required?: boolean }[] };
      return {
        key: s.key,
        title: s.title,
        short: s.short,
        is_coding_step: s.is_coding_step,
        auto_advance_default: s.auto_advance_default,
        inputs: s.inputs.map((i) => ({ path: i.path, mode: i.mode as InputMode })),
        outputs: s.outputs.map((o) => ({ path: o.path, required: o.required === true })),
        model: s.model,
        harness: s.harness,
        prompt: sections.get(s.key) as string,
      };
    }),
    preamble,
    section_order: sectionOrder,
  };
  // What the engine would refuse to run is refused here too, so a playbook that saves can start.
  const engine = validatePlaybook(toPlaybook(document));
  if (engine.length) return fail(engine.map((d) => diag(d.code, d.message, null, d.step ? `step[${d.step}]` : null)));
  return { document, diagnostics: [] };
}

/** The engine's view of a document: camelCase, prompts trimmed, `required` only when set. */
export function toPlaybook(doc: PlaybookDocument): Playbook {
  return {
    key: doc.key,
    title: doc.title,
    description: doc.description,
    defaultModel: doc.default_model,
    defaultHarness: doc.default_harness,
    steps: doc.step.map((s) => ({
      key: s.key,
      title: s.title,
      short: s.short,
      model: s.model,
      harness: s.harness,
      isCodingStep: s.is_coding_step,
      autoAdvanceDefault: s.auto_advance_default,
      inputs: s.inputs.map((i) => ({ path: i.path, mode: i.mode })),
      outputs: s.outputs.map((o) => ({ path: o.path, ...(o.required ? { required: true } : {}) })),
      prompt: s.prompt.trim(),
    })),
  };
}

type Result = { playbook: Playbook; diagnostics: [] } | { playbook: null; diagnostics: Diagnostic[] };

/** What the engine runs: `parsePlaybookDocument` seen through `toPlaybook`. */
export function parsePlaybookMd(text: string): Result {
  const parsed = parsePlaybookDocument(text);
  if (parsed.document) return { playbook: toPlaybook(parsed.document), diagnostics: [] };
  return { playbook: null, diagnostics: parsed.diagnostics.map((d) => ({ code: d.code, message: d.message })) };
}

// Canonical metadata uses single-line TOML basic strings. A generic TOML serializer may choose multiline
// literals whose standalone +++ line would end the Markdown frontmatter envelope.
function basicString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code === 8) out += '\\b';
    else if (code === 12) out += '\\f';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** Canonical metadata, verbatim document text. A caller taking an edited document must parse the result before saving it. */
export function renderPlaybookMd(pb: PlaybookDocument): string {
  let out = `+++\nversion = ${pb.version}\n`;
  for (const [key, value] of [['key', pb.key], ['title', pb.title], ['description', pb.description], ['default_model', pb.default_model], ['default_harness', pb.default_harness]]) {
    out += `${key} = ${basicString(value)}\n`;
  }
  if (pb.step.length === 0) out += 'step = []\n';
  for (const step of pb.step) {
    out += '\n[[step]]\n';
    for (const [key, value] of [['key', step.key], ['title', step.title], ['short', step.short], ['model', step.model], ['harness', step.harness]]) {
      out += `${key} = ${basicString(value)}\n`;
    }
    out += `is_coding_step = ${step.is_coding_step}\nauto_advance_default = ${step.auto_advance_default}\n`;
    out += `inputs = [${step.inputs.map((i) => `{ path = ${basicString(i.path)}, mode = ${basicString(i.mode)} }`).join(', ')}]\n`;
    out += `outputs = [${step.outputs.map((o) => `{ path = ${basicString(o.path)}${o.required ? ', required = true' : ''} }`).join(', ')}]\n`;
  }
  out += '+++\n';
  out += pb.preamble;
  const written = new Set<string>();
  for (const key of [...pb.section_order, ...pb.step.map((s) => s.key)]) {
    if (written.has(key)) continue;
    written.add(key);
    const step = pb.step.find((s) => s.key === key);
    if (!step) continue;
    if (!out.endsWith('\n')) out += '\n';
    out += `<!-- alinery:step ${step.key} -->\n${step.prompt}`;
  }
  return out;
}
