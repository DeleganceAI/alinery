/**
 * Publication acceptance: the only place the engine looks at artifact files.
 *
 * Structural only. A valid artifact is a nonempty regular file at an assigned
 * path. The engine never reads contents or judges claims; that is the agents'
 * and reviewers' job. Acceptance is atomic: one present-but-invalid assigned
 * output rejects the whole attempt, and omitted outputs are simply not
 * published.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { matches, type Output, wildcard } from './playbook.ts';

export type Inspection = { ok: true; published: { role: string; path: string }[] } | { ok: false; problems: string[] };

export function inspectOutputs(outDir: string, outputs: Output[]): Inspection {
  const published: { role: string; path: string }[] = [];
  const problems: string[] = [];

  const consider = (role: string) => {
    const path = join(outDir, role);
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st) return; // omitted: a possible publication that did not happen
    if (!st.isFile()) problems.push(`${role} is not a regular file`);
    else if (st.size === 0) problems.push(`${role} is empty`);
    else published.push({ role, path });
  };

  for (const out of outputs) {
    const w = wildcard(out.path);
    if (!w) {
      const before = problems.length;
      consider(out.path);
      if (out.required && problems.length === before && !published.some((item) => item.role === out.path)) {
        problems.push(`${out.path} is required`);
      }
      continue;
    }
    // Wildcard family: every file in the assigned directory that matches the selector is a member.
    const dir = join(outDir, dirname(out.path));
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // directory never created: zero members
    }
    for (const name of names.sort()) {
      const role = w.dir ? `${w.dir}/${name}` : name;
      if (matches(out.path, role)) consider(role);
    }
  }

  if (problems.length) return { ok: false, problems };
  if (published.length === 0) return { ok: false, problems: ['no valid assigned artifact was published'] };
  return { ok: true, published };
}
