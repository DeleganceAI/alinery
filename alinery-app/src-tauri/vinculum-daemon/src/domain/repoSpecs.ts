// The repository's standing requirements: three fixed files in `specs/` at the repository root. Only these names are
// ever read, never the folder, because `specs/` is a common directory name that may hold unrelated files.
//
// Two views of the same files. Settings shows the working tree (what a person is editing, and whether it is committed).
// A playbook step is given only the committed text at HEAD, so a half-edited file never steers a run and an agent's
// edit in its own worktree never changes the rules it is held to.
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeDurable } from "../platform/fs.ts";
import { git } from "../platform/git.ts";
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

async function committedText(repo: string, name: string): Promise<string | undefined> {
  try {
    const r = await git(repo, ["show", `HEAD:specs/${name}`]);
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

/** The block appended to a playbook step's prompt: the committed files that have content, or "" when there are none. */
export async function requirementsBlock(repo: string): Promise<string> {
  const parts: string[] = [];
  for (const name of SPEC_NAMES) {
    const text = (await committedText(repo, name))?.trim();
    if (text) parts.push(`### specs/${name}\n\n${capped(text)}`);
  }
  return parts.length ? [PREAMBLE, ...parts].join("\n\n") : "";
}
