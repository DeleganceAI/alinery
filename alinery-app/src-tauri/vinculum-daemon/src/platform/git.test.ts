import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { branchNameValid, type GitLookup, git, gitArgs, gitEnv, gitText, localBranches, registeredWorktrees, selectGit, worktreeAdd } from "./git.ts";

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

test("the macOS stub at /usr/bin/git is skipped and the alongside tree answers, with its exec path set", () => {
  const alongside = "/Applications/Alinery.git/bin/git";
  const l = lookup({
    platform: "darwin",
    env: { PATH: "/usr/bin:/bin" },
    executables: ["/usr/bin/git", alongside],
    developerDirPresent: () => false,
    alongside,
    execPathOf: (p) => (p === alongside ? "/Applications/Alinery.git/libexec/git-core" : undefined),
  });
  const chosen = selectGit(l);
  expect(chosen).toEqual({ program: alongside, bundled: true });
  expect(gitEnv(chosen, l).GIT_EXEC_PATH).toBe("/Applications/Alinery.git/libexec/git-core");
  // With the Command Line Tools installed the system git is a git again, and the bundled tree is not used.
  expect(selectGit({ ...l, developerDirPresent: () => true })).toEqual({ program: "/usr/bin/git", bundled: false });
});

test("only the bundled tree on macOS is pointed at the keychain credential helper", () => {
  const helper = "/g/libexec/git-core/git-credential-osxkeychain";
  const l = lookup({ platform: "darwin", executables: [helper], execPathOf: () => "/g/libexec/git-core" });
  expect(gitArgs({ program: "/g/bin/git", bundled: true }, l, "/r", ["push"])).toEqual(["-C", "/r", "-c", "credential.helper=osxkeychain", "push"]);
  expect(gitArgs({ program: "/usr/bin/git", bundled: false }, l, "/r", ["push"])).toEqual(["-C", "/r", "push"]);
  expect(gitArgs({ program: "/g/bin/git", bundled: true }, { ...l, platform: "linux" }, "/r", ["push"])).toEqual(["-C", "/r", "push"]);
  expect(gitArgs({ program: "/g/bin/git", bundled: true }, { ...l, isExecutable: () => false }, "/r", ["push"])).toEqual(["-C", "/r", "push"]);
});

test("a GIT_DIR in the lookup's environment is absent from the child's, and an option env is added after the scrub", async () => {
  const dir = mkdtempSync("/tmp/git-env-");
  try {
    const fake = join(dir, "git");
    writeFileSync(fake, "#!/bin/sh\nenv\n");
    chmodSync(fake, 0o755);
    const env = { PATH: "/usr/bin:/bin", ALINERY_GIT_PATH: fake, GIT_DIR: "/x", GIT_WORK_TREE: "/x", GIT_INDEX_FILE: "/x", KEEP: "1" };
    const l = lookup({ env, executables: [fake] });
    const seen = (await git(dir, ["status"], { ...l, isExecutable: (p) => p === fake }, { env: { GIT_INDEX_FILE: "/chosen" } })).stdout.split("\n");
    expect(seen).toContain("KEEP=1");
    expect(seen).toContain("GIT_INDEX_FILE=/chosen");
    expect(seen.some((line) => line.startsWith("GIT_DIR=") || line.startsWith("GIT_WORK_TREE="))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git reports its version through the one spawn, and gitText reports git's own words", async () => {
  const dir = mkdtempSync("/tmp/git-text-");
  try {
    Bun.spawnSync(["git", "-C", dir, "init", "-q"]);
    expect((await git(dir, ["--version"])).stdout).toStartWith("git version");
    await expect(gitText(dir, ["rev-parse", "--verify", "nope"])).rejects.toThrow("git rev-parse:");
    await expect(git(dir, ["status"], lookup({ env: { PATH: "/a:/b" }, executables: [] }))).rejects.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
