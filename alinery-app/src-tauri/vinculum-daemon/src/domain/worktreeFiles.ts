// The files of a task's worktree, for the Files panel's Repository section: list them and resolve one to read. The client
// names a file by its path relative to the worktree; this module is where that path is checked, so a read never leaves it.
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { git } from "../platform/git.ts";
import { DomainError } from "../platform/lock.ts";
import { readTaskChecked, worktreesDir } from "./taskFiles.ts";

/** ponytail: one flat list per call; past this the tree shows "truncated". Add per-directory listing if real repos hit it. */
export const WORKTREE_LIST_CAP = 20_000;

const real = (path: string, what: string) => {
  try {
    return realpathSync(path);
  } catch {
    throw new DomainError("not_found", `${what} not found`);
  }
};

/**
 * The root a task's files are read from: its worktree, or the repository for a task without one. The root must be the
 * repository or sit under `.alinery/worktrees/`, so an edited task.md cannot point a read anywhere else on the machine.
 */
export function worktreeRoot(repo: string, slug: string): string {
  const task = readTaskChecked(repo, slug);
  const repoReal = real(repo, "repository");
  if (task.has_worktree !== true) return repoReal;
  const worktree = String(task.worktree ?? "");
  if (worktree === "") throw new DomainError("not_found", "the task's worktree was removed");
  const root = real(worktree, "worktree");
  const allowed = real(worktreesDir(repo), "worktrees directory");
  if (!root.startsWith(allowed + sep)) throw new DomainError("permission_denied", "the task's worktree is outside .alinery/worktrees");
  return root;
}

/** Tracked plus untracked files, without ignored ones and without `.alinery/`, sorted and capped. */
export async function listWorktreeFiles(repo: string, slug: string, cap = WORKTREE_LIST_CAP): Promise<{ paths: string[]; truncated: boolean }> {
  const root = worktreeRoot(repo, slug);
  const out = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (out.code !== 0) throw new DomainError("failed_precondition", `git ls-files failed: ${out.stderr.trim()}`);
  const all = [...new Set(out.stdout.split("\0"))].filter((p) => p !== "" && !p.startsWith(".alinery/")).sort();
  return { paths: all.slice(0, cap), truncated: all.length > cap };
}

/**
 * The absolute path of one file under the task's root. Refused: an empty or absolute path, `.` or `..` segments, anything
 * inside `.git`, and any link on the way (the real path must be exactly the joined one). A missing file is NOT_FOUND.
 */
export function worktreeFilePath(repo: string, slug: string, path: string): string {
  const parts = path.split("/");
  if (path === "" || path.includes("\0") || parts.some((p) => p === "" || p === "." || p === ".." || p === ".git")) {
    throw new DomainError("invalid_argument", `invalid worktree path: ${path}`);
  }
  const root = worktreeRoot(repo, slug);
  const full = join(root, ...parts);
  if (real(full, `file ${path}`) !== full) throw new DomainError("permission_denied", `a link is on the way to ${path}`);
  return full;
}
