// The one place the daemon starts git (invariant 3), ported from alinery-core `git_cmd`. `git -C <dir>` does not
// override an inherited GIT_DIR, so every spawn strips the seven variables that redirect git, and
// `scripts/tests/check-git-env-scrub.sh` fails the build if any other file spawns "git".
//
// Resolution, first hit wins: `ALINERY_GIT_PATH` when that file exists; the first usable `git` on PATH (the macOS
// `/usr/bin/git` stub does not count until the Command Line Tools exist); the alongside tree the installer placed
// (which gets `GIT_EXEC_PATH` so https push finds `git-remote-https`); the bare name. S4.7 adds the commit and push
// helpers; this session needs the branch and worktree calls task creation makes.
import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

const SCRUBBED = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE"];

export type GitProgram = { program: string; bundled: boolean };

export type GitLookup = {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  isExecutable: (path: string) => boolean;
  /** Whether `xcode-select -p` succeeds, which is what makes `/usr/bin/git` a git on macOS. */
  developerDirPresent: () => boolean;
  /** `<root>/libexec/git-core`, when that directory exists beside `<root>/bin/git`. */
  execPathOf: (program: string) => string | undefined;
  alongside: string;
};

const isExecutable = (path: string) => {
  try {
    const s = statSync(path);
    return s.isFile() && (s.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

const execPathOf = (program: string) => {
  const bin = dirname(program);
  if (bin.split("/").pop() !== "bin") return undefined;
  const exec = join(dirname(bin), "libexec", "git-core");
  return existsSync(exec) ? exec : undefined;
};

let developerDir: boolean | undefined;
const developerDirPresent = () => {
  developerDir ??= Bun.spawnSync(["xcode-select", "-p"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).exitCode === 0;
  return developerDir;
};

/** The installer's git tree: `/Applications/Alinery.git/bin/git` on macOS, `~/.local/share/alinery/git/bin/git` on Linux. */
function alongsideGit(platform: NodeJS.Platform, home: string): string {
  return platform === "darwin" ? "/Applications/Alinery.git/bin/git" : join(home, ".local", "share", "alinery", "git", "bin", "git");
}

export const systemLookup = (): GitLookup => ({
  env: process.env,
  platform: process.platform,
  isExecutable,
  developerDirPresent,
  execPathOf,
  alongside: alongsideGit(process.platform, process.env.HOME ?? "/root"),
});

/** `select_git_program`: which git to run. Pure over `lookup`, so a test can stand in for the machine. */
export function selectGit(lookup: GitLookup): GitProgram {
  const override = lookup.env.ALINERY_GIT_PATH;
  if (override && lookup.isExecutable(override)) return { program: override, bundled: lookup.execPathOf(override) !== undefined };
  for (const dir of (lookup.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "git");
    if (lookup.platform === "darwin" && candidate === "/usr/bin/git" && !lookup.developerDirPresent()) continue;
    if (lookup.isExecutable(candidate)) return { program: candidate, bundled: false };
  }
  if (lookup.isExecutable(lookup.alongside)) return { program: lookup.alongside, bundled: true };
  return { program: "git", bundled: false };
}

/** The environment a git child gets: the daemon's, minus the variables that redirect git, plus the bundled tree's exec path. */
export function gitEnv(selected: GitProgram, lookup: GitLookup): Record<string, string | undefined> {
  const env = { ...lookup.env };
  for (const name of SCRUBBED) delete env[name];
  if (selected.bundled) {
    const exec = lookup.execPathOf(selected.program);
    if (exec) env.GIT_EXEC_PATH = exec;
  }
  return env;
}

export type GitResult = { code: number; stdout: string; stderr: string };

/** Runs `git -C <dir> <args>`; resolves with the exit code and both streams. Throws only when git cannot start. */
export async function git(dir: string, args: string[], lookup: GitLookup = systemLookup()): Promise<GitResult> {
  const selected = selectGit(lookup);
  const child = Bun.spawn([selected.program, "-C", dir, ...args], { env: gitEnv(selected, lookup), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

/** `git check-ref-format --branch`: whether `name` is a usable local branch name. */
export async function branchNameValid(repo: string, name: string): Promise<boolean> {
  return (await git(repo, ["check-ref-format", "--branch", name])).code === 0;
}

/** Every local branch name (`refs/heads/*`). */
export async function localBranches(repo: string): Promise<string[]> {
  const r = await git(repo, ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"]);
  if (r.code !== 0) throw new Error(`list local Git branches: ${r.stderr.trim()}`);
  return r.stdout.split("\n").filter((l) => l.length > 0);
}

/**
 * Absolute path of every worktree git has registered, including missing and locked ones. The registry, not the
 * filesystem, is the truth about which paths git reserves, so an unreadable registry is an error and never "empty".
 */
export async function registeredWorktrees(repo: string): Promise<string[]> {
  const r = await git(repo, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) throw new Error(`git worktree list: ${r.stderr.trim()}`);
  return r.stdout.split("\n").flatMap((l) => (l.startsWith("worktree ") ? [l.slice("worktree ".length)] : []));
}

/** `git worktree add <path> -b <branch> [<base>]`. */
export async function worktreeAdd(repo: string, path: string, branch: string, base?: string): Promise<void> {
  const r = await git(repo, ["worktree", "add", path, "-b", branch, ...(base ? [base] : [])]);
  if (r.code !== 0) throw new Error(`git worktree add: ${r.stderr.trim()}`);
}
