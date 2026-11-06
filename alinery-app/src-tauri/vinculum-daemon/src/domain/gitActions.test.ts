// The cases of core's `git_actions` tests (plan S4.7), run against temporary repositories: the source branches, the compare URL,
// commit, push, remove, the PR link writes, and the refs that keep an execution's files. A GIT_DIR in the daemon's own
// environment is set for the whole file, so a call that skipped the scrub in platform/git.ts would act on the wrong repository.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DomainError } from "../platform/lock.ts";
import { commitWorktree, compareUrl, defaultBaseBranch, deleteExecutionRefs, githubPullRequestRef, pullRequestInputs, pushAndCompareUrl, recordDiscoveredPullRequest, recordWorktreeTree, removeWorktree, setPrUrl, taskSourceBranches } from "./gitActions.ts";
import { readTaskChecked, taskDir } from "./taskFiles.ts";
import { provisionTask } from "./tasks.ts";

const PLAYBOOK = readFileSync(resolve(import.meta.dir, "../../../playbooks/one-shot/playbook.md"), "utf8");
const dirs: string[] = [];
let savedGitDir: string | undefined;
beforeAll(() => {
  savedGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = join(tmpdir(), "alinery-wrong-git-dir");
});
afterAll(() => {
  if (savedGitDir === undefined) delete process.env.GIT_DIR;
  else process.env.GIT_DIR = savedGitDir;
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Runs git with the harness's own PATH git and no GIT_DIR, for building fixtures (the code under test is what must scrub). */
function sh(dir: string, ...args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_DIR;
  const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "pipe", stderr: "pipe", env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().replace(/\n$/, "");
}

function makeRepo(name = "repo"): { dir: string; repo: string } {
  const dir = mkdtempSync(join(tmpdir(), "alinery-gitact-"));
  dirs.push(dir);
  const repo = join(dir, name);
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "commit", "-q", "--allow-empty", "-m", "init");
  return { dir, repo };
}

async function makeTask(repo: string, name = "Git Demo") {
  const reply = await provisionTask(
    { repo, lane: "", identity: "fixture" },
    {
      name,
      attachments: [],
      attachmentUrls: [],
      attachmentErrors: [],
      playbook: { reference: { scope: "bundled", key: "one-shot" }, source: PLAYBOOK },
      launchDefaults: { harness: "omp", model: "" },
      start: false,
    } as never,
  );
  return readTaskChecked(repo, reply.task?.slug ?? "");
}

const rejects = async (p: Promise<unknown>) => (await p.then(() => undefined, (e) => e)) as Error | undefined;

// ---- source branches --------------------------------------------------------------------------------------

test("source discovery reports the local heads of the selected checkout and touches nothing", async () => {
  const { repo } = makeRepo();
  sh(repo, "branch", "-m", "current");
  writeFileSync(join(repo, "tracked"), "committed\n");
  sh(repo, "add", "tracked");
  sh(repo, "commit", "-qm", "tracked");
  sh(repo, "branch", "chosen");
  sh(repo, "tag", "chosen");
  sh(repo, "update-ref", "refs/remotes/origin/remote-only", "HEAD");
  const linked = join(repo, "linked");
  sh(repo, "worktree", "add", "-q", linked, "chosen");
  writeFileSync(join(repo, "tracked"), "staged\n");
  sh(repo, "add", "tracked");
  writeFileSync(join(repo, "tracked"), "unstaged\n");
  writeFileSync(join(repo, "untracked"), "untracked\n");
  const head = readFileSync(join(repo, ".git/HEAD"), "utf8");
  const index = readFileSync(join(repo, ".git/index"));

  const sources = await taskSourceBranches(repo, "refs/heads/chosen");
  expect(sources.branches.map((b) => [b.fullRef, b.name])).toEqual([
    ["refs/heads/chosen", "chosen"],
    ["refs/heads/current", "current"],
  ]);
  expect(sources.head).toEqual({ kind: "branch", fullRef: "refs/heads/current", name: "current" });
  expect(sources.selected?.available).toBe(true);
  const fromLinked = await taskSourceBranches(linked);
  expect(fromLinked.head).toEqual({ kind: "branch", fullRef: "refs/heads/chosen", name: "chosen" });
  expect(fromLinked.branches).toEqual(sources.branches);
  expect(fromLinked.selected).toBeUndefined();
  expect(readFileSync(join(repo, ".git/HEAD"), "utf8")).toBe(head);
  expect(readFileSync(join(repo, ".git/index")).equals(index)).toBe(true);
  expect(readFileSync(join(repo, "tracked"), "utf8")).toBe("unstaged\n");
});

test("a detached HEAD is reported as the commit it is at, and a saved commit stays available", async () => {
  const { repo } = makeRepo();
  const first = sh(repo, "rev-parse", "HEAD");
  sh(repo, "checkout", "-q", "--detach");
  expect((await taskSourceBranches(repo)).head).toEqual({ kind: "detached", oid: first });
  sh(repo, "commit", "--allow-empty", "-qm", "later");
  const later = sh(repo, "rev-parse", "HEAD");
  const sources = await taskSourceBranches(repo, first);
  expect(sources.head).toEqual({ kind: "detached", oid: later });
  expect(sources.selected).toEqual({ baseRef: first, available: true });
});

test("an unborn branch is told from a broken HEAD", async () => {
  const { repo } = makeRepo();
  const empty = join(repo, "empty");
  mkdirSync(empty);
  sh(empty, "init", "-q");
  sh(empty, "symbolic-ref", "HEAD", "refs/heads/new");
  const none = await taskSourceBranches(empty);
  expect(none.branches).toEqual([]);
  expect(none.head).toEqual({ kind: "unborn", fullRef: "refs/heads/new", name: "new" });
  sh(repo, "branch", "-m", "committed");
  sh(repo, "checkout", "-q", "--orphan", "new");
  const sources = await taskSourceBranches(repo, "refs/heads/new");
  expect(sources.head).toEqual({ kind: "unborn", fullRef: "refs/heads/new", name: "new" });
  expect(sources.branches.map((b) => b.fullRef)).toEqual(["refs/heads/committed"]);
  expect(sources.selected?.available).toBe(false);
  writeFileSync(join(repo, ".git/refs/heads/new"), `${"1".repeat(40)}\n`);
  expect(await rejects(taskSourceBranches(repo))).toBeDefined();
  writeFileSync(join(repo, ".git/HEAD"), "invalid HEAD\n");
  expect(await rejects(taskSourceBranches(repo))).toBeDefined();
});

test("a saved base ref that is not a local branch or a full commit id is unavailable, never substituted", async () => {
  const { repo } = makeRepo();
  sh(repo, "branch", "chosen");
  sh(repo, "tag", "chosen");
  sh(repo, "branch", "-D", "chosen");
  writeFileSync(join(repo, "blob"), "not a commit");
  const blob = sh(repo, "hash-object", "-w", "blob");
  const tree = sh(repo, "rev-parse", "HEAD^{tree}");
  for (const invalid of ["refs/heads/chosen", "1".repeat(40), "1".repeat(64), blob, tree, "", "chosen", "HEAD", "HEAD~0", "refs/tags/chosen", "refs/remotes/origin/main", "--help", " refs/heads/chosen", "refs/heads/chosen ", "refs/heads/chosen\n", "refs/heads/../chosen", "refs/heads/bad\0ref", blob.slice(0, 12)]) {
    const selected = (await taskSourceBranches(repo, invalid)).selected;
    expect(selected?.baseRef).toBe(invalid);
    expect(selected?.available, `accepted ${JSON.stringify(invalid)}`).toBe(false);
  }
  expect((await taskSourceBranches(repo, sh(repo, "rev-parse", "HEAD"))).selected?.available).toBe(true);
});

test("a read failure is an error, never an empty success", async () => {
  for (const damage of ["packed-ref", "loose-ref", "missing-object", "corrupt-object", "noncommit-ref", "invalid-repo"]) {
    const { repo } = makeRepo();
    const oid = sh(repo, "rev-parse", "HEAD");
    const object = join(repo, ".git/objects", oid.slice(0, 2), oid.slice(2));
    if (damage === "packed-ref") writeFileSync(join(repo, ".git/packed-refs"), "not a packed ref\n");
    if (damage === "loose-ref") writeFileSync(join(repo, ".git/refs/heads/broken"), "not an oid\n");
    if (damage === "missing-object") rmSync(object);
    if (damage === "corrupt-object") {
      rmSync(object);
      writeFileSync(object, "corrupt");
    }
    if (damage === "noncommit-ref") writeFileSync(join(repo, ".git/refs/heads/broken"), `${sh(repo, "rev-parse", "HEAD^{tree}")}\n`);
    if (damage === "invalid-repo") rmSync(join(repo, ".git"), { recursive: true });
    expect(await rejects(taskSourceBranches(repo)), `accepted ${damage}`).toBeDefined();
  }
});

test("a git that warns or prints something unexpected is an error", async () => {
  const { dir, repo } = makeRepo();
  const real = Bun.which("git") ?? "git";
  const saved = process.env.ALINERY_GIT_PATH;
  const wrapper = join(dir, "boundary-git");
  try {
    for (const [command, failure] of [
      ["for-each-ref", "printf 'malformed output\\n'"],
      ["for-each-ref", "printf '\\377\\n'"],
      ["for-each-ref", "printf 'warning: ignoring broken ref\\n' >&2"],
      ["symbolic-ref", "exit 2"],
      ["symbolic-ref", "printf 'HEAD\\n'"],
    ]) {
      writeFileSync(wrapper, `#!/bin/sh\nfor arg do\n  if [ "$arg" = '${command}' ]; then\n    ${failure}\n    exit 0\n  fi\ndone\nexec '${real}' "$@"\n`, { mode: 0o755 });
      process.env.ALINERY_GIT_PATH = wrapper;
      expect(await rejects(taskSourceBranches(repo, "1".repeat(40))), `${command} / ${failure}`).toBeDefined();
    }
  } finally {
    if (saved === undefined) delete process.env.ALINERY_GIT_PATH;
    else process.env.ALINERY_GIT_PATH = saved;
  }
});

// ---- URLs ---------------------------------------------------------------------------------------------------

test("the compare URL for ssh, https, GitHub and a self-hosted forge", () => {
  const gh = "https://github.com/owner/repo/compare/main...feat?expand=1";
  expect(compareUrl("git@github.com:owner/repo.git", "main", "feat")).toBe(gh);
  expect(compareUrl("https://github.com/owner/repo.git", "main", "feat")).toBe(gh);
  expect(compareUrl("https://github.com/owner/repo", "main", "feat")).toBe(gh);
  expect(compareUrl("ssh://git@github.com/owner/repo.git", "main", "feat")).toBe(gh);
  expect(compareUrl("git@git.example.com:team/proj.git", "main", "wip")).toBe("https://git.example.com/team/proj/compare/main...wip");
  expect(compareUrl("https://gitea.example.com/team/proj", "trunk", "wip")).toBe("https://gitea.example.com/team/proj/compare/trunk...wip");
  expect(compareUrl("not a url", "main", "x")).toBeUndefined();
  expect(compareUrl("https://github.com/onlyowner", "main", "x")).toBeUndefined();
  // A credential embedded in the remote never reaches the link.
  expect(compareUrl("https://x-access-token:ghp_secret@github.com/owner/repo.git", "main", "feat")).toBe(gh);
  // An ssh port is the ssh port and goes; an https port is the web port and stays.
  expect(compareUrl("ssh://git@gitea.example.com:2222/team/proj.git", "main", "wip")).toBe("https://gitea.example.com/team/proj/compare/main...wip");
  expect(compareUrl("https://gitea.example.com:3000/team/proj", "main", "wip")).toBe("https://gitea.example.com:3000/team/proj/compare/main...wip");
});

test("a pull request link is github.com/<owner>/<repo>/pull/<n>, and the creation form is not one", () => {
  expect(githubPullRequestRef("https://github.com/team/project/pull/42")).toEqual({ owner: "team", repo: "project", number: 42 });
  expect(githubPullRequestRef(" https://github.com/team/project/pull/42/?x=1#y ")).toEqual({ owner: "team", repo: "project", number: 42 });
  for (const bad of ["https://github.com/team/project/compare/main...feature?expand=1", "https://example.com/team/project/pull/42", "https://github.com/team/project/pull/0", "https://github.com/team/project/pull/4x", "https://github.com/../project/pull/4", "https://github.com/team/project/pull/42/files", "http://github.com/team/project/pull/42"]) {
    expect(githubPullRequestRef(bad), bad).toBeUndefined();
  }
});

test("the base branch is origin's HEAD, else main", async () => {
  const { repo } = makeRepo();
  expect(await defaultBaseBranch(repo)).toBe("main");
  sh(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  expect(await defaultBaseBranch(repo)).toBe("trunk");
});

// ---- task writes --------------------------------------------------------------------------------------------

test("commit stages everything and commits in the worktree; a second commit reports git's own words", async () => {
  const { repo } = makeRepo();
  const task = await makeTask(repo, "Commit Demo");
  writeFileSync(join(String(task.worktree), "new-file.txt"), "hello\n");
  await commitWorktree(repo, task.slug, "  test commit  ");
  expect(sh(String(task.worktree), "status", "--porcelain")).toBe("");
  expect(sh(String(task.worktree), "log", "-1", "--format=%s")).toBe("test commit");
  expect((await rejects(commitWorktree(repo, task.slug, "again")))?.message).toContain("nothing to commit");
  expect((await rejects(commitWorktree(repo, task.slug, "   ")))?.message).toBe("commit message is empty");
});

test("push sends the branch to origin and stores the compare URL, which a real PR link is not replaced by", async () => {
  const { dir, repo } = makeRepo();
  const origin = join(dir, "origin.git");
  mkdirSync(origin);
  sh(origin, "init", "-q", "--bare", "-b", "main");
  sh(repo, "remote", "add", "origin", "https://git.example.com/team/proj.git");
  sh(repo, "config", `url.${origin}.pushInsteadOf`, "https://git.example.com/team/proj.git");
  const task = await makeTask(repo, "Push Demo");
  writeFileSync(join(String(task.worktree), "f.txt"), "x\n");
  await commitWorktree(repo, task.slug, "work");
  const url = await pushAndCompareUrl(repo, task.slug);
  expect(url).toBe(`https://git.example.com/team/proj/compare/main...${task.branch}`);
  expect(sh(origin, "rev-parse", `refs/heads/${task.branch}`)).toBe(sh(String(task.worktree), "rev-parse", "HEAD"));
  expect(readTaskChecked(repo, task.slug).pr_url).toBe(url);
  await setPrUrl(repo, task.slug, "  https://github.com/team/proj/pull/7  ");
  await pushAndCompareUrl(repo, task.slug);
  expect(readTaskChecked(repo, task.slug).pr_url).toBe("https://github.com/team/proj/pull/7");
});

test("push without an origin says so, and a task whose worktree is gone has nothing to push", async () => {
  const { repo } = makeRepo();
  const task = await makeTask(repo);
  // No remote: git's own refusal to push comes first.
  expect(await rejects(pushAndCompareUrl(repo, task.slug))).toBeDefined();
  await removeWorktree(repo, task.slug);
  expect((await rejects(pushAndCompareUrl(repo, task.slug)))?.message).toBe("worktree removed — nothing to push");
});

test("removing a worktree keeps the branch, clears the field, and refuses a second time", async () => {
  const { repo } = makeRepo();
  const task = await makeTask(repo);
  const worktree = String(task.worktree);
  writeFileSync(join(worktree, "dirty.txt"), "uncommitted\n");
  await removeWorktree(repo, task.slug);
  expect(existsSync(worktree)).toBe(false);
  expect(readTaskChecked(repo, task.slug).worktree).toBe("");
  expect(sh(repo, "branch", "--list", String(task.branch))).toContain(String(task.branch));
  expect((await rejects(removeWorktree(repo, task.slug)))?.message).toBe("worktree already removed");
});

test("a write after the task was purged does not bring it back", async () => {
  const { repo } = makeRepo();
  const task = await makeTask(repo);
  rmSync(taskDir(repo, task.slug), { recursive: true, force: true });
  for (const call of [setPrUrl(repo, task.slug, "https://github.com/a/b/pull/1"), removeWorktree(repo, task.slug), recordDiscoveredPullRequest(repo, task.slug, "b", "", "https://github.com/a/b/pull/1")]) {
    const error = await rejects(call);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("not_found");
  }
  expect(existsSync(taskDir(repo, task.slug))).toBe(false);
});

test("a discovered PR link is written once, and a lookup that raced an edit writes nothing", async () => {
  const { repo } = makeRepo();
  const task = await makeTask(repo);
  const inputs = await pullRequestInputs(repo, task.slug);
  expect(inputs).toEqual({ prUrl: "", branch: String(task.branch), originUrl: undefined });
  await recordDiscoveredPullRequest(repo, task.slug, inputs.branch, inputs.prUrl, "https://github.com/team/project/pull/42");
  expect(readTaskChecked(repo, task.slug).pr_url).toBe("https://github.com/team/project/pull/42");
  // The same link again is a no-op read, not a rewrite.
  await recordDiscoveredPullRequest(repo, task.slug, inputs.branch, "https://github.com/team/project/pull/42", "https://github.com/team/project/pull/42");
  // A lookup that started from the old link no longer applies.
  expect((await rejects(recordDiscoveredPullRequest(repo, task.slug, inputs.branch, "", "https://github.com/team/project/pull/43")))?.message).toBe("task branch or PR link changed during lookup");
  expect((await rejects(recordDiscoveredPullRequest(repo, task.slug, "other-branch", "https://github.com/team/project/pull/42", "https://github.com/team/project/pull/43")))?.message).toBe("task branch or PR link changed during lookup");
  expect((await rejects(recordDiscoveredPullRequest(repo, task.slug, inputs.branch, "", "https://github.com/team/project/compare/a...b")))?.message).toBe("invalid GitHub pull request URL");
  expect(readTaskChecked(repo, task.slug).pr_url).toBe("https://github.com/team/project/pull/42");
});

test("the origin URL is part of the lookup inputs once there is an origin", async () => {
  const { repo } = makeRepo();
  const task = await makeTask(repo);
  sh(repo, "remote", "add", "origin", "git@github.com:team/project.git");
  expect((await pullRequestInputs(repo, task.slug)).originUrl).toBe("git@github.com:team/project.git");
  expect((await rejects(pullRequestInputs(repo, "../x")))?.message).toBe("invalid task slug");
});

// ---- the refs that keep an execution's files ----------------------------------------------------------------

test("a recorded worktree keeps uncommitted files under a per-task ref and leaves the index, HEAD and branch alone", async () => {
  const { repo } = makeRepo();
  writeFileSync(join(repo, "committed"), "c\n");
  sh(repo, "add", "committed");
  sh(repo, "commit", "-qm", "c");
  writeFileSync(join(repo, "committed"), "edited\n");
  writeFileSync(join(repo, "untracked"), "new\n");
  const headBefore = sh(repo, "rev-parse", "HEAD");
  const statusBefore = sh(repo, "status", "--porcelain");
  const one = await recordWorktreeTree(repo, "task-a", "e1");
  expect(one?.ref).toBe("refs/alinery/executions/task-a/e1");
  expect(sh(repo, "show", `${one?.ref}:untracked`)).toBe("new");
  expect(sh(repo, "show", `${one?.ref}:committed`)).toBe("edited");
  expect(sh(repo, "rev-parse", `${one?.ref}^{tree}`)).toBe(one?.tree);
  expect(sh(repo, "rev-parse", "HEAD")).toBe(headBefore);
  expect(sh(repo, "status", "--porcelain")).toBe(statusBefore);
  expect(existsSync(join(repo, ".git", "alinery-exec-index-task-a-e1"))).toBe(false);
  // The ref keeps the untracked file's blob alive through a prune, which is the point of recording a ref at all.
  sh(repo, "gc", "--prune=now", "-q");
  expect(sh(repo, "show", `${one?.ref}:untracked`)).toBe("new");
  // The same execution id in another task is another ref.
  const two = await recordWorktreeTree(repo, "task-b", "e1");
  expect(two?.ref).toBe("refs/alinery/executions/task-b/e1");
});

test("outside a git working tree nothing is recorded, and a name that cannot name a ref is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alinery-nongit-"));
  dirs.push(dir);
  expect(await recordWorktreeTree(dir, "task-a", "e1")).toBeUndefined();
  expect((await rejects(recordWorktreeTree(dir, "task-a", "../x")))?.message).toContain("cannot name a ref");
  expect((await rejects(recordWorktreeTree(dir, "../x", "e1")))?.message).toContain("cannot name a ref");
});

test("archiving's ref cleanup deletes one task's refs and no other task's, even one whose slug starts the same", async () => {
  const { repo } = makeRepo();
  for (const [slug, id] of [["task-a", "e1"], ["task-a", "e2"], ["task-a-b", "e1"], ["task-c", "e1"]]) await recordWorktreeTree(repo, slug, id);
  expect(await deleteExecutionRefs(repo, "task-a")).toBe(2);
  expect(sh(repo, "for-each-ref", "--format=%(refname)", "refs/alinery/")).toBe("refs/alinery/executions/task-a-b/e1\nrefs/alinery/executions/task-c/e1");
  expect(await deleteExecutionRefs(repo, "task-a")).toBe(0);
  expect((await rejects(deleteExecutionRefs(repo, "../x")))?.message).toBe("invalid task slug");
});
