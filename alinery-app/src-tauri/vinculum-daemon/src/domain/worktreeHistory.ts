// The Git panel of a task: its branch's own commits, and one commit's patch or the staged or unstaged changes. Read only.
// Everything runs in the task's root (worktreeRoot), and `.alinery/` is left out the way the file list leaves it out.
import { realpathSync } from "node:fs";
import { git } from "../platform/git.ts";
import { DomainError } from "../platform/lock.ts";
import { defaultBaseBranch } from "./gitActions.ts";
import { worktreeRoot } from "./worktreeFiles.ts";

export const LOG_CAP = 200;
/** ponytail: one patch per call, cut at this many characters; a per-file diff call if real changes hit it. */
export const PATCH_CAP = 2_000_000;
const NOT_ALINERY = ":(exclude).alinery";

async function run(root: string, args: string[], ok: number[] = [0]): Promise<string> {
  const r = await git(root, args);
  if (!ok.includes(r.code)) throw new DomainError("failed_precondition", `git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

const resolves = async (root: string, ref: string) => (await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0;

/**
 * Where the branch's own commits start: the repository's checked-out branch (a task branches from it unless told
 * otherwise), else origin's default branch, else the local default. None for a task without a worktree, whose root is the
 * repository itself: its log is the latest commits.
 */
async function logBase(repo: string, root: string): Promise<string> {
  if (root === realpathSync(repo)) return "";
  const own = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  const checkedOut = (await git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  const fallback = await defaultBaseBranch(repo);
  for (const ref of [checkedOut, `origin/${fallback}`, fallback]) {
    if (ref !== "" && ref !== own && (await resolves(root, ref))) return ref;
  }
  return "";
}

export type WorktreeLog = {
  commits: { oid: string; subject: string; author: string; timeMs: bigint }[];
  base: string;
  truncated: boolean;
  staged: number;
  uncommitted: number;
};

export async function worktreeLog(repo: string, slug: string, cap = LOG_CAP): Promise<WorktreeLog> {
  const root = worktreeRoot(repo, slug);
  const base = await logBase(repo, root);
  const unborn = !(await resolves(root, "HEAD"));
  const raw = unborn ? "" : await run(root, ["log", "-z", `--max-count=${cap + 1}`, "--format=%H%x1f%an%x1f%at%x1f%s", base ? `${base}..HEAD` : "HEAD"]);
  const rows = raw.split("\0").filter((r) => r.trim() !== "");
  const commits = rows.slice(0, cap).map((row) => {
    const [oid = "", author = "", at = "0", subject = ""] = row.replace(/^\n/, "").split("\x1f");
    return { oid, author, subject, timeMs: BigInt(Number(at) * 1000) };
  });
  // XY of `status --porcelain`: X is the index, Y the worktree; `??` is untracked.
  const status = await run(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", NOT_ALINERY]);
  let staged = 0;
  let uncommitted = 0;
  const entries = status.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 3) continue;
    const [x, y] = [e[0], e[1]];
    if (x === "R" || x === "C") i++; // a rename's original path follows as its own entry
    if (x === "?") uncommitted++;
    else {
      if (x !== " ") staged++;
      if (y !== " ") uncommitted++;
    }
  }
  return { commits, base, truncated: rows.length > cap, staged, uncommitted };
}

export type DiffTarget = { case: "commit"; value: string } | { case: "staged"; value: boolean } | { case: "uncommitted"; value: boolean } | { case: undefined };

export async function worktreeDiff(repo: string, slug: string, target: DiffTarget, cap = PATCH_CAP): Promise<{ patch: string; truncated: boolean }> {
  const root = worktreeRoot(repo, slug);
  const common = ["--no-color", "--no-ext-diff", "--find-renames"];
  let patch: string;
  if (target.case === "commit") {
    if (!/^[0-9a-f]{7,64}$/.test(target.value)) throw new DomainError("invalid_argument", `not a commit id: ${target.value}`);
    patch = await run(root, ["show", ...common, "--format=fuller", target.value, "--", ".", NOT_ALINERY]);
  } else if (target.case === "staged") {
    patch = await run(root, ["diff", "--cached", ...common, "--", ".", NOT_ALINERY]);
  } else if (target.case === "uncommitted") {
    patch = await run(root, ["diff", ...common, "--", ".", NOT_ALINERY]);
    // `git diff` leaves out a new file nobody added; each is shown against nothing (exit 1 means it differs).
    const untracked = (await run(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ".", NOT_ALINERY])).split("\0").filter(Boolean);
    for (const path of untracked) {
      if (patch.length > cap) break;
      patch += await run(root, ["diff", ...common, "--no-index", "--", "/dev/null", path], [0, 1]);
    }
  } else {
    throw new DomainError("invalid_argument", "no diff target");
  }
  return patch.length > cap ? { patch: patch.slice(0, cap), truncated: true } : { patch, truncated: false };
}
