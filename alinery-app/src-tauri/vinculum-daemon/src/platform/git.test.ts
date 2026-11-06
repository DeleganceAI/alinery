import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { branchNameValid, type GitLookup, gitEnv, localBranches, registeredWorktrees, selectGit, worktreeAdd } from "./git.ts";

const lookup = (over: Partial<GitLookup> & { executables?: string[] }): GitLookup => ({
  env: { PATH: "/a:/b" },
  platform: "linux",
  isExecutable: (p) => (over.executables ?? []).includes(p),
  developerDirPresent: () => true,
  execPathOf: () => undefined,
  alongside: "/home/u/.local/share/alinery/git/bin/git",
  ...over,
});

test("the override wins, then PATH in order, then the alongside tree, then the bare name", () => {
  const all = ["/o/git", "/a/git", "/b/git", "/home/u/.local/share/alinery/git/bin/git"];
  expect(selectGit(lookup({ env: { PATH: "/a:/b", ALINERY_GIT_PATH: "/o/git" }, executables: all })).program).toBe("/o/git");
  expect(selectGit(lookup({ executables: all })).program).toBe("/a/git");
  expect(selectGit(lookup({ executables: all.slice(2) })).program).toBe("/b/git");
  const alongside = selectGit(lookup({ executables: [all[3]] }));
  expect(alongside).toEqual({ program: all[3], bundled: true });
  expect(selectGit(lookup({ executables: [] }))).toEqual({ program: "git", bundled: false });
  // An override that is not a file is ignored.
  expect(selectGit(lookup({ env: { PATH: "/a", ALINERY_GIT_PATH: "/missing/git" }, executables: ["/a/git"] })).program).toBe("/a/git");
});

test("on macOS /usr/bin/git is skipped until the Command Line Tools exist", () => {
  const base = { platform: "darwin" as const, env: { PATH: "/usr/bin:/opt/git" }, executables: ["/usr/bin/git", "/opt/git/git"] };
  expect(selectGit(lookup({ ...base, developerDirPresent: () => false })).program).toBe("/opt/git/git");
  expect(selectGit(lookup({ ...base, developerDirPresent: () => true })).program).toBe("/usr/bin/git");
});

test("the child's environment drops the seven redirecting variables and a bundled tree gets GIT_EXEC_PATH", () => {
  const env = Object.fromEntries(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE"].map((k) => [k, "/x"]));
  const l = lookup({ env: { ...env, KEEP: "1" }, execPathOf: () => "/g/libexec/git-core" });
  expect(gitEnv({ program: "/g/bin/git", bundled: false }, l)).toEqual({ KEEP: "1" });
  expect(gitEnv({ program: "/g/bin/git", bundled: true }, l)).toEqual({ KEEP: "1", GIT_EXEC_PATH: "/g/libexec/git-core" });
});

test("a GIT_DIR in the daemon's own environment does not redirect a call", async () => {
  const dir = mkdtempSync("/tmp/git-scrub-");
  const saved = process.env.GIT_DIR;
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    Bun.spawnSync(["git", "-C", repo, "init", "-q", "-b", "main"]);
    Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@e.c", "commit", "-q", "--allow-empty", "-m", "i"]);
    process.env.GIT_DIR = join(dir, "elsewhere");
    expect(await localBranches(repo)).toEqual(["main"]);
    expect(await branchNameValid(repo, "a/b")).toBe(true);
    expect(await branchNameValid(repo, "a..b")).toBe(false);
    await worktreeAdd(repo, join(dir, "wt"), "feature");
    expect((await registeredWorktrees(repo)).map((p) => p.split("/").pop()).sort()).toEqual(["repo", "wt"]);
    await expect(worktreeAdd(repo, join(dir, "wt2"), "feature")).rejects.toThrow("git worktree add");
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
