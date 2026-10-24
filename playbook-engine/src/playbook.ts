/**
 * Playbook definition: the finite set of authored operation schemas, the A in
 * the paper's F = (A, S, s0, →). Each Step is one schema α = (I, O, ξ): its
 * inputs are the permitted input filename sets, its outputs the permitted
 * publications, and its prompt the execution specification.
 *
 * This file holds the types, the selector grammar, and validation. It knows
 * nothing about execution.
 */

export type InputMode = 'single' | 'each' | 'complete';

export interface Input {
  /**
   * Logical role. An exact relative path for `single`; a selector with one `*`
   * in its final segment for `each` and `complete`.
   */
  path: string;
  /**
   * single    bind one exact occurrence.
   * each      one execution per matching member.
   * complete  the whole closed, nonempty collection to one execution.
   */
  mode: InputMode;
}

export interface Output {
  /**
   * Logical role the step may publish: an exact path, or a one-wildcard family
   * such as `source-request-*.md`. Every declaration is a possible
   * publication, not an obligation; completion needs at least one valid
   * assigned artifact overall.
   */
  path: string;
  /** Exact outputs only. Completion rejects until this nonempty file exists. A wildcard cannot be required. */
  required?: boolean;
}

export interface Step {
  key: string;
  title: string;
  short: string;
  inputs: Input[];
  outputs: Output[];
  /** Empty string means inherit the playbook default. */
  model: string;
  /** Empty string means inherit the playbook default. Informational in this engine: the host picks the harness. */
  harness: string;
  /** May modify the shared worktree. Serialised against other coding steps; `single` inputs only. */
  isCodingStep: boolean;
  /** Initial value of the task-level human gate for this step. true = the agent may complete on its own. */
  autoAdvanceDefault: boolean;
  /** Agent instructions. May use the tokens in PROMPT_TOKENS. */
  prompt: string;
}

export interface Playbook {
  key: string;
  title: string;
  description: string;
  defaultModel: string;
  defaultHarness: string;
  steps: Step[];
}

/** The only `{{TOKEN}}`s a prompt may use. A backslash-escaped `\{{TOKEN}}` is literal. Anything else is a validation error. */
export const PROMPT_TOKENS = [
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
] as const;

export interface Diagnostic {
  code: string;
  message: string;
  step?: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** Top-level directories that hold user evidence, never generated outputs. Case-insensitive on every platform. */
const RESERVED_DIRS = new Set(['attachments', 'subtasks']);

/** Split a selector into its directory and the prefix/suffix around its single `*`. Returns null for an exact path. */
export function wildcard(selector: string): { dir: string; prefix: string; suffix: string } | null {
  if (!selector.includes('*')) return null;
  const slash = selector.lastIndexOf('/');
  const dir = slash < 0 ? '' : selector.slice(0, slash);
  const name = selector.slice(slash + 1);
  const star = name.indexOf('*');
  return { dir, prefix: name.slice(0, star), suffix: name.slice(star + 1) };
}

/** Does a logical role satisfy a selector? `*` matches any run of characters except `/`, including none. */
export function matches(selector: string, role: string): boolean {
  const w = wildcard(selector);
  if (!w) return selector === role;
  const slash = role.lastIndexOf('/');
  const dir = slash < 0 ? '' : role.slice(0, slash);
  const name = role.slice(slash + 1);
  return (
    dir === w.dir &&
    name.length >= w.prefix.length + w.suffix.length &&
    name.startsWith(w.prefix) &&
    name.endsWith(w.suffix)
  );
}

/** Can two selectors ever name the same role? */
export function overlaps(a: string, b: string): boolean {
  const wa = wildcard(a);
  const wb = wildcard(b);
  if (!wa && !wb) return a === b;
  if (!wa) return matches(b, a);
  if (!wb) return matches(a, b);
  // p1*s1 and p2*s2 share a match iff one prefix extends the other and one suffix extends the other.
  const prefixes = wa.prefix.startsWith(wb.prefix) || wb.prefix.startsWith(wa.prefix);
  const suffixes = wa.suffix.endsWith(wb.suffix) || wb.suffix.endsWith(wa.suffix);
  return wa.dir === wb.dir && prefixes && suffixes;
}

/** The step's one collection input, if any. */
export function collectionInput(step: Step): Input | undefined {
  return step.inputs.find((i) => i.mode !== 'single');
}

function pathProblem(p: string): string | null {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return 'must be a relative path';
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return 'must not contain empty, `.` or `..` segments';
  const stars = p.split('*').length - 1;
  if (stars > 1) return 'may contain at most one `*`';
  if (stars === 1 && segments.slice(0, -1).some((s) => s.includes('*'))) return '`*` is allowed only in the final segment';
  if (segments.length > 1 && RESERVED_DIRS.has(segments[0].toLowerCase())) return `top-level directory ${segments[0]} is reserved`;
  return null;
}

/**
 * Reject definitions the engine could not execute faithfully. An empty result
 * means the playbook is well formed; it says nothing about whether its loops
 * carry fresh evidence or its prompts make sense.
 */
export function validatePlaybook(pb: Playbook): Diagnostic[] {
  const out: Diagnostic[] = [];
  const bad = (code: string, message: string, step?: string) => out.push(step ? { code, message, step } : { code, message });

  if (!SLUG.test(pb.key)) bad('invalid_key', 'playbook key must be a lowercase ASCII slug');
  if (pb.title.trim() === '') bad('empty_title', 'playbook title must not be empty');
  if (pb.steps.length === 0) bad('missing_steps', 'at least one step is required');

  const keys = new Set<string>();
  for (const s of pb.steps) {
    if (!SLUG.test(s.key)) bad('invalid_key', `step key ${JSON.stringify(s.key)} must be a lowercase ASCII slug`, s.key);
    if (keys.has(s.key)) bad('duplicate_step', `duplicate step ${s.key}`, s.key);
    keys.add(s.key);
    if (s.title.trim() === '') bad('empty_title', 'step title must not be empty', s.key);

    let collections = 0;
    for (const i of s.inputs) {
      const problem = pathProblem(i.path);
      if (problem) bad('invalid_path', `input ${i.path} ${problem}`, s.key);
      const isWild = wildcard(i.path) !== null;
      if (i.mode === 'single' && isWild) bad('input_mode_path', `single input ${i.path} must be an exact path`, s.key);
      if (i.mode !== 'single') {
        collections++;
        if (!isWild) bad('input_mode_path', `${i.mode} input ${i.path} needs one *`, s.key);
        // Coding work needs one specific account of what to do; consolidate fan-out first.
        if (s.isCodingStep) bad('coding_input', `coding step may only use single inputs, not ${i.mode} ${i.path}`, s.key);
      }
    }
    // Two collections would need a join the engine cannot infer. Add an explicit intermediate step instead.
    if (collections > 1) bad('multiple_collections', 'a step may have at most one each or complete input', s.key);

    s.outputs.forEach((o, n) => {
      const problem = pathProblem(o.path);
      if (problem) bad('invalid_path', `output ${o.path} ${problem}`, s.key);
      if (o.required && wildcard(o.path)) bad('required_wildcard', `required applies only to an exact output, not ${o.path}`, s.key);
      if (s.outputs.slice(0, n).some((prev) => overlaps(prev.path, o.path))) bad('duplicate_output', `output ${o.path} overlaps an earlier output of the same step`, s.key);
    });

    for (const m of s.prompt.matchAll(/(?<!\\)\{\{(\w+)\}\}/g)) {
      if (!(PROMPT_TOKENS as readonly string[]).includes(m[1])) bad('unknown_prompt_token', `unknown prompt token {{${m[1]}}}`, s.key);
    }
  }

  // Exact roles may be shared between steps: each occurrence keeps its producer.
  // Wildcard ownership is unique, so attribution of an expanding family is never in doubt.
  for (let a = 0; a < pb.steps.length; a++) {
    for (let b = a + 1; b < pb.steps.length; b++) {
      for (const oa of pb.steps[a].outputs) {
        for (const ob of pb.steps[b].outputs) {
          if ((wildcard(oa.path) || wildcard(ob.path)) && overlaps(oa.path, ob.path)) {
            bad('overlapping_outputs', `${pb.steps[a].key} output ${oa.path} overlaps ${pb.steps[b].key} output ${ob.path}`, pb.steps[a].key);
          }
        }
      }
    }
  }
  return out;
}
