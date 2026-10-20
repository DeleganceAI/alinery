/**
 * Parser for the v2 `playbook.md` file: TOML `+++` frontmatter with the step
 * records, then one `<!-- alinery:step KEY -->` section per step holding its
 * prompt. This is the only file that knows the serialisation; the engine works
 * on the `Playbook` object.
 *
 * Unknown fields and unknown tokens are errors, so an accepted document never
 * means something the engine does not implement.
 */
import { parse as parseToml } from 'smol-toml';
import { type Diagnostic, type Input, type InputMode, type Output, type Playbook, type Step, validatePlaybook } from './playbook.ts';

type Result = { playbook: Playbook; diagnostics: [] } | { playbook: null; diagnostics: Diagnostic[] };

const MODES: InputMode[] = ['single', 'each', 'complete'];
const SECTION = /^<!-- alinery:step ([a-z0-9-]+) -->$/;

export function parsePlaybookMd(text: string): Result {
  const d: Diagnostic[] = [];
  const fail = (): Result => ({ playbook: null, diagnostics: d });

  const lines = text.split(/\r?\n/);
  if (lines[0] !== '+++') {
    d.push({ code: 'missing_frontmatter', message: 'expected v2 TOML +++ frontmatter at the beginning of the file' });
    return fail();
  }
  const end = lines.indexOf('+++', 1);
  if (end < 0) {
    d.push({ code: 'missing_frontmatter_end', message: 'missing closing +++ delimiter' });
    return fail();
  }

  let front: Record<string, unknown>;
  try {
    front = parseToml(lines.slice(1, end).join('\n'));
  } catch (err) {
    d.push({ code: 'invalid_toml', message: (err as Error).message });
    return fail();
  }

  const shape = new Shape(d);
  const top = shape.table(front, '', ['version', 'key', 'title', 'description', 'default_model', 'default_harness', 'step']);
  if (top.version !== undefined && top.version !== 2) d.push({ code: 'unsupported_version', message: 'only playbook version 2 is supported' });

  const steps: Step[] = [];
  for (const [n, raw] of (shape.array(front, 'step') ?? []).entries()) {
    const at = `step[${n}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      d.push({ code: 'invalid_field_type', message: `${at} must be table` });
      continue;
    }
    const s = shape.table(raw as Record<string, unknown>, at, ['key', 'title', 'short', 'model', 'harness', 'is_coding_step', 'auto_advance_default', 'inputs', 'outputs']);
    const inputs: Input[] = [];
    for (const [i, rawIn] of (shape.array(raw as Record<string, unknown>, 'inputs', at) ?? []).entries()) {
      const inAt = `${at}.inputs[${i}]`;
      const t = shape.table(rawIn as Record<string, unknown>, inAt, ['path', 'mode']);
      if (typeof t.mode === 'string' && !MODES.includes(t.mode as InputMode)) d.push({ code: 'invalid_input_mode', message: `${inAt}.mode must be single, each or complete` });
      inputs.push({ path: String(t.path ?? ''), mode: t.mode as InputMode });
    }
    const outputs: Output[] = [];
    for (const [i, rawOut] of (shape.array(raw as Record<string, unknown>, 'outputs', at) ?? []).entries()) {
      const t = shape.table(rawOut as Record<string, unknown>, `${at}.outputs[${i}]`, ['path'], ['required']);
      outputs.push({ path: String(t.path ?? ''), ...(t.required === true ? { required: true } : {}) });
    }
    steps.push({
      key: String(s.key ?? ''),
      title: String(s.title ?? ''),
      short: String(s.short ?? ''),
      model: String(s.model ?? ''),
      harness: String(s.harness ?? ''),
      isCodingStep: Boolean(s.is_coding_step),
      autoAdvanceDefault: Boolean(s.auto_advance_default),
      inputs,
      outputs,
      prompt: '',
    });
  }

  // Prompt sections. Text before the first marker is a human preamble and is ignored.
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines.slice(end + 1)) {
    const m = SECTION.exec(line);
    if (!m) {
      current?.push(line);
      continue;
    }
    if (sections.has(m[1])) d.push({ code: 'duplicate_step_section', message: `duplicate section for step ${m[1]}`, step: m[1] });
    if (!steps.some((s) => s.key === m[1])) d.push({ code: 'unknown_step_section', message: `section for undeclared step ${m[1]}`, step: m[1] });
    current = [];
    sections.set(m[1], current);
  }
  for (const s of steps) {
    const body = sections.get(s.key);
    if (!body) d.push({ code: 'missing_prompt', message: `step ${s.key} has no <!-- alinery:step ${s.key} --> section`, step: s.key });
    s.prompt = (body ?? []).join('\n').trim();
  }

  if (d.length) return fail();
  const playbook: Playbook = {
    key: String(top.key),
    title: String(top.title),
    description: String(top.description),
    defaultModel: String(top.default_model),
    defaultHarness: String(top.default_harness),
    steps,
  };
  d.push(...validatePlaybook(playbook));
  return d.length ? fail() : { playbook, diagnostics: [] };
}

/** Tiny structural checker: required fields, exact types, no unknown fields. */
class Shape {
  #d: Diagnostic[];
  constructor(d: Diagnostic[]) {
    this.#d = d;
  }

  /** Check a table's field set and types; returns the raw values (already-reported problems become undefined). */
  table(obj: Record<string, unknown>, at: string, fields: string[], optional: string[] = []): Record<string, unknown> {
    const prefix = at ? `${at}.` : '';
    const allowed = new Set([...fields, ...optional]);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) if (!allowed.has(k)) this.#d.push({ code: 'unknown_field', message: `unknown field ${prefix}${k}` });
    for (const f of fields) this.#take(obj, out, prefix, f, true);
    for (const f of optional) this.#take(obj, out, prefix, f, false);
    return out;
  }

  #take(obj: Record<string, unknown>, out: Record<string, unknown>, prefix: string, field: string, must: boolean) {
    const v = obj[field];
    const kind = KIND[field];
    if (v === undefined) {
      if (must) this.#d.push({ code: 'missing_field', message: `required field ${prefix}${field} is missing` });
      return;
    }
    if (!IS[kind](v)) {
      this.#d.push({ code: 'invalid_field_type', message: `${prefix}${field} must be ${kind}` });
      return;
    }
    out[field] = v;
  }

  array(obj: Record<string, unknown>, field: string, at = ''): unknown[] | undefined {
    const v = obj[field];
    return Array.isArray(v) ? v : undefined;
  }
}

type Kind = 'integer' | 'string' | 'boolean' | 'array';
const KIND: Record<string, Kind> = {
  version: 'integer',
  key: 'string',
  title: 'string',
  description: 'string',
  default_model: 'string',
  default_harness: 'string',
  step: 'array',
  short: 'string',
  model: 'string',
  harness: 'string',
  is_coding_step: 'boolean',
  auto_advance_default: 'boolean',
  inputs: 'array',
  outputs: 'array',
  path: 'string',
  mode: 'string',
  required: 'boolean',
};
const IS: Record<Kind, (v: unknown) => boolean> = {
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
};
