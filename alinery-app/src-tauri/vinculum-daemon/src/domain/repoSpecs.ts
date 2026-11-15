// The repository's standing requirements: three fixed files in `specs/` at the repository root. Only these names are
// ever read, never the folder, because `specs/` is a common directory name that may hold unrelated files.
//
// Two views of the same files. Settings shows the working tree (what a person is editing, and whether it is committed).
// A playbook step is given only committed text, from the commit its task is pinned to (`specs.lock.json`, written when
// the task is created), so a half-edited file never steers a run, an agent's edit in its own worktree never changes the
// rules it is held to, and a task keeps its rules when the repository changes later.
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeDurable } from "../platform/fs.ts";
import { git, gitText } from "../platform/git.ts";
import { DomainError } from "../platform/lock.ts";

export const SPEC_NAMES = ["requirements.md", "tooling.md", "architecture.md"] as const;

/** ponytail: characters per file, so the three together are a bounded cost on every step. Raise it, or target files per step, if it bites. */
export const SPEC_MAX_CHARS = 16_000;

export type SpecState = {
  name: string;
  present: boolean;
  /** The working-tree text; empty when the file is absent or `tooLarge`. */
  text: string;
  /** Present and identical to HEAD's copy. */
  committed: boolean;
  /** Over the limit: Settings shows no editor, since saving a cut-down copy would lose the rest. */
  tooLarge: boolean;
};

const PREAMBLE =
  "These are the repository's standing requirements, taken from `specs/` as committed. They bind this step: follow them. If the work would break one, say so in your handoff instead of working around it, and do not edit the files under `specs/`.";

const statOf = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

/** `specs` and the file must be what they look like: a symlink would let a read or write leave the repository. */
const plainDir = (repo: string) => statOf(join(repo, "specs"))?.isDirectory() === true;

async function committedText(repo: string, name: string, ref = "HEAD"): Promise<string | undefined> {
  try {
    const r = await git(repo, ["show", `${ref}:specs/${name}`]);
    return r.code === 0 ? r.stdout : undefined;
  } catch {
    return undefined; // git cannot start: nothing is committed as far as we can tell
  }
}

/** Settings' read: each file's working-tree text and whether HEAD holds the same. */
export async function readSpecs(repo: string): Promise<SpecState[]> {
  const out: SpecState[] = [];
  for (const name of SPEC_NAMES) {
    const path = join(repo, "specs", name);
    const st = plainDir(repo) ? statOf(path) : undefined;
    if (!st?.isFile()) {
      out.push({ name, present: false, text: "", committed: false, tooLarge: false });
      continue;
    }
    // A character is at most 4 bytes, so a file past this cannot fit the limit; do not read it at all.
    const big = st.size > SPEC_MAX_CHARS * 4;
    const text = big ? "" : await Bun.file(path).text();
    if (big || text.length > SPEC_MAX_CHARS) out.push({ name, present: true, text: "", committed: false, tooLarge: true });
    else out.push({ name, present: true, text, committed: (await committedText(repo, name)) === text, tooLarge: false });
  }
  return out;
}

/** Creates or replaces one of the three files in the main checkout. Never commits. */
export async function writeSpec(repo: string, name: string, text: string): Promise<void> {
  if (!(SPEC_NAMES as readonly string[]).includes(name)) throw new DomainError("invalid_argument", `${name} is not one of ${SPEC_NAMES.join(", ")}`);
  if (text.length > SPEC_MAX_CHARS) throw new DomainError("invalid_argument", `${name} is ${text.length} characters; the limit is ${SPEC_MAX_CHARS}`);
  const dir = join(repo, "specs");
  const dirStat = statOf(dir);
  if (dirStat && !dirStat.isDirectory()) throw new DomainError("failed_precondition", "specs exists but is not a plain directory");
  const path = join(dir, name);
  const fileStat = statOf(path);
  if (fileStat && !fileStat.isFile()) throw new DomainError("failed_precondition", `specs/${name} exists but is not a regular file`);
  mkdirSync(dir, { recursive: true });
  await writeDurable(path, text);
}

const capped = (text: string) => (text.length > SPEC_MAX_CHARS ? `${text.slice(0, SPEC_MAX_CHARS)}\n[truncated at ${SPEC_MAX_CHARS} characters]` : text);

/** The names of the files that have committed content at `ref`. */
export async function committedSpecNames(repo: string, ref = "HEAD"): Promise<string[]> {
  const names: string[] = [];
  for (const name of SPEC_NAMES) if ((await committedText(repo, name, ref))?.trim()) names.push(name);
  return names;
}

/** The block appended to a playbook step's prompt: the files that have content committed at `ref`, or "" when there are none. */
export async function requirementsBlock(repo: string, ref = "HEAD"): Promise<string> {
  const parts: string[] = [];
  for (const name of SPEC_NAMES) {
    const text = (await committedText(repo, name, ref))?.trim();
    if (text) parts.push(`### specs/${name}\n\n${capped(text)}`);
  }
  return parts.length ? [PREAMBLE, ...parts].join("\n\n") : "";
}

// ---- the pin ---------------------------------------------------------------------------------------------------

const lockFile = (taskDir: string) => join(taskDir, "specs.lock.json");
// A full object id only: the value goes into a git argument, and the file is one a person could edit.
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The commit a task's requirements are pinned to, or undefined when it has none. */
export function readPin(taskDir: string): string | undefined {
  try {
    const commit = (JSON.parse(readFileSync(lockFile(taskDir), "utf8")) as { commit?: unknown }).commit;
    return typeof commit === "string" && OID.test(commit) ? commit : undefined;
  } catch {
    return undefined;
  }
}

/** Pins the task to `dir`'s HEAD: its worktree when the task is created (that is exactly the commit it branched from), the repository when an older task first launches. Returns the commit. */
export async function pinSpecs(taskDir: string, dir: string): Promise<string> {
  const commit = await gitText(dir, ["rev-parse", "HEAD"]);
  await writeDurable(lockFile(taskDir), `${JSON.stringify({ commit })}\n`);
  return commit;
}

/** What Task view shows: the pin, the files it holds, and how many the repository's HEAD has now (so "apply them" can be offered). */
export async function taskSpecs(repo: string, taskDir: string): Promise<{ commit: string; files: string[]; headFiles: number }> {
  const commit = readPin(taskDir) ?? "";
  const files = commit ? await committedSpecNames(repo, commit) : [];
  return { commit, files, headFiles: (await committedSpecNames(repo)).length };
}

/** A step's requirements: the pinned commit's files. A task with no pin (made before pins existed) is pinned now, to the repository's HEAD. A pin whose commit is gone fails the launch: dropping the rules silently is worse. */
export async function requirementsFor(repo: string, taskDir: string): Promise<string> {
  let commit = readPin(taskDir);
  if (!commit) {
    try {
      commit = await pinSpecs(taskDir, repo);
    } catch {
      return ""; // not a git repository, or no commit yet: nothing is committed to pin
    }
  } else if ((await git(repo, ["cat-file", "-e", `${commit}^{commit}`])).code !== 0) {
    throw new Error(`requirements are pinned to ${commit}, which this repository no longer has; re-pin them from the task's page`);
  }
  return requirementsBlock(repo, commit);
}
