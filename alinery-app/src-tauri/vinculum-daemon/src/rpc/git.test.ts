// GitService over the real socket (plan S4.7): the calls the views make, the usage events, the retry that must not push twice,
// and the ref cleanup an archive does.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { GitService } from "alinery-proto/alinery/v1/git_pb";
import { TaskService } from "alinery-proto/alinery/v1/tasks_pb";
import { BlobStore } from "../domain/blobs.ts";
import { recordWorktreeTree } from "../domain/gitActions.ts";
import { JobRunner } from "../jobs/runner.ts";
import type { TelemetryEvent } from "../platform/telemetry.ts";
import { Feed } from "../sync/feed.ts";
import { taskKey } from "../sync/parsers/task.ts";
import { Store } from "../sync/store.ts";
import { serveRpc } from "./server.ts";

const SECRET = "ab".repeat(32);
const PLAYBOOK = readFileSync(join(import.meta.dir, "../../../playbooks/one-shot/playbook.md"), "utf8");
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function sh(dir: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

async function start() {
  const dir = mkdtempSync("/tmp/rpc-git-");
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const origin = join(dir, "origin.git");
  mkdirSync(origin);
  sh(origin, "init", "-q", "--bare", "-b", "main");
  sh(repo, "remote", "add", "origin", "https://git.example.com/team/proj.git");
  sh(repo, "config", `url.${origin}.pushInsteadOf`, "https://git.example.com/team/proj.git");
  const alinery = join(repo, ".alinery");
  mkdirSync(alinery, { recursive: true });
  const store = new Store({ coalesceMs: 1 });
  const feed = new Feed(store, alinery, (e) => e, () => [], {});
  const events: TelemetryEvent[] = [];
  const socketPath = join(dir, "rpc.sock");
  const tasks = { repo, lane: "test", identity: "id", refresh: (rel: string) => feed.refresh(rel), telemetry: { record: (build: () => TelemetryEvent) => void events.push(build()) }, blobs: new BlobStore(repo) };
  const info = { protocol: 32, buildId: "b", repoRoot: repo, appConfigIdentity: "i" };
  const net = await serveRpc({ socketPath, secret: Buffer.from(SECRET), hostExecutable: process.execPath, info, lifecycle: { stop: () => 0, exit: () => {} }, store, jobs: new JobRunner(store), storageScan: { mode: "error" } as never, transcripts: async () => undefined, tasks });
  cleanup.push(() => {
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const transport = createGrpcTransport({
    baseUrl: "http://daemon",
    nodeOptions: { createConnection: () => connect(socketPath) } as never,
    interceptors: [(next) => (req) => (req.header.set("authorization", `Bearer ${SECRET}`), next(req))],
  });
  await feed.scan();
  const c = { repo, origin, store, events, git: createClient(GitService, transport), tasks: createClient(TaskService, transport) };
  return c;
}
type Ctx = Awaited<ReturnType<typeof start>>;

let n = 0;
const meta = () => ({ clientId: "c1", mutationId: `m${++n}` });
const code = async (call: Promise<unknown>) => ConnectError.from(await call.then(() => null, (e) => e)).code;

async function newTask(c: Ctx, name = "Demo") {
  const res = await c.tasks.createTask({ meta: meta(), name, description: "d", playbookRef: { scope: "bundled", key: "one-shot" }, playbookSource: PLAYBOOK, launchDefaults: { harness: "omp", model: "" }, start: false });
  const slug = res.created?.task?.slug ?? "";
  return { slug, worktree: res.created?.task?.worktree ?? "", branch: res.created?.task?.branch ?? "" };
}

test("source branches answer from the connection's repository, with the head and the selection", async () => {
  const c = await start();
  sh(c.repo, "branch", "other");
  const r = await c.git.taskSourceBranches({ selectedBaseRef: "refs/heads/other" });
  expect(r.branches.map((b) => b.name)).toEqual(["main", "other"]);
  expect(r.head?.head).toEqual({ case: "branch", value: expect.objectContaining({ name: "main", fullRef: "refs/heads/main" }) });
  expect(r.selected).toMatchObject({ baseRef: "refs/heads/other", available: true });
  expect((await c.git.taskSourceBranches({})).selected).toBeUndefined();
  sh(c.repo, "checkout", "-q", "--detach");
  expect((await c.git.taskSourceBranches({})).head?.head.case).toBe("detachedOid");
});

test("commit, push and remove run in the worktree, record their events, and answer with the cursor that covers task.md", async () => {
  const c = await start();
  const t = await newTask(c);
  writeFileSync(join(t.worktree, "f.txt"), "x\n");
  const committed = await c.git.commitWorktree({ meta: meta(), slug: t.slug, message: "work" });
  expect(committed.applied?.cursor?.seq).toBe(c.store.cursor().seq);
  expect(sh(t.worktree, "log", "-1", "--format=%s")).toBe("work");
  const pushed = await c.git.pushAndCompareUrl({ meta: meta(), slug: t.slug });
  expect(pushed.compareUrl).toBe(`https://git.example.com/team/proj/compare/main...${t.branch}`);
  expect(sh(c.origin, "rev-parse", `refs/heads/${t.branch}`)).toBe(sh(t.worktree, "rev-parse", "HEAD"));
  const row = c.store.get(taskKey(t.slug))?.value;
  expect(row?.case === "task" && row.value.prUrl).toBe(pushed.compareUrl);
  await c.git.removeWorktree({ meta: meta(), slug: t.slug });
  const after = c.store.get(taskKey(t.slug))?.value;
  expect(after?.case === "task" && after.value.worktree).toBe("");
  expect(c.events.map((e) => e.event)).toEqual(["git.commit", "git.push", "git.worktree_remove"]);
  expect(c.events.every((e) => e.source === "alineryd")).toBe(true);
});

test("a retried mutation id is answered from the first attempt and commits once", async () => {
  const c = await start();
  const t = await newTask(c);
  writeFileSync(join(t.worktree, "f.txt"), "x\n");
  const same = meta();
  await c.git.commitWorktree({ meta: same, slug: t.slug, message: "once" });
  await c.git.commitWorktree({ meta: same, slug: t.slug, message: "once" });
  expect(sh(t.worktree, "rev-list", "--count", "HEAD")).toBe("2");
  expect(c.events.filter((e) => e.event === "git.commit")).toHaveLength(1);
  expect(await code(c.git.commitWorktree({ slug: t.slug, message: "no meta" }))).toBe(Code.InvalidArgument);
});

test("the pull request inputs and a recorded discovery round-trip, and a stale lookup is refused", async () => {
  const c = await start();
  const t = await newTask(c);
  const inputs = await c.git.taskPullRequestInputs({ slug: t.slug });
  expect(inputs).toMatchObject({ prUrl: "", branch: t.branch, originUrl: "https://git.example.com/team/proj.git" });
  await c.git.recordDiscoveredPullRequest({ meta: meta(), slug: t.slug, branch: t.branch, previousUrl: "", url: "https://github.com/team/proj/pull/9" });
  expect((await c.git.taskPullRequestInputs({ slug: t.slug })).prUrl).toBe("https://github.com/team/proj/pull/9");
  expect(await code(c.git.recordDiscoveredPullRequest({ meta: meta(), slug: t.slug, branch: t.branch, previousUrl: "", url: "https://github.com/team/proj/pull/10" }))).toBe(Code.FailedPrecondition);
  expect(await code(c.git.recordDiscoveredPullRequest({ meta: meta(), slug: t.slug, branch: t.branch, previousUrl: "https://github.com/team/proj/pull/9", url: "https://example.com/x" }))).toBe(Code.InvalidArgument);
  expect(await code(c.git.taskPullRequestInputs({ slug: "nope" }))).toBe(Code.NotFound);
  expect((await c.git.gitOriginUrl({})).originUrl).toBe("https://git.example.com/team/proj.git");
  await c.git.setPrUrl({ meta: meta(), slug: t.slug, url: " https://github.com/team/proj/pull/11 " });
  expect((await c.git.taskPullRequestInputs({ slug: t.slug })).prUrl).toBe("https://github.com/team/proj/pull/11");
});

test("a failed push is a refusal with git's words, and nothing is recorded or counted", async () => {
  const c = await start();
  const t = await newTask(c);
  sh(c.repo, "config", "--unset", `url.${c.origin}.pushInsteadOf`);
  const error = ConnectError.from(await c.git.pushAndCompareUrl({ meta: meta(), slug: t.slug }).then(() => null, (e) => e));
  expect(error.code).toBe(Code.FailedPrecondition);
  expect(error.rawMessage).toContain("git push failed");
  expect(c.events.filter((e) => e.event === "git.push")).toEqual([]);
});

test("archiving a task deletes its execution refs and no other task's", async () => {
  const c = await start();
  const t = await newTask(c);
  const other = await newTask(c, "Other");
  await recordWorktreeTree(c.repo, t.slug, "e1");
  await recordWorktreeTree(c.repo, other.slug, "e1");
  await c.tasks.archiveTask({ meta: meta(), slug: t.slug });
  expect(sh(c.repo, "for-each-ref", "--format=%(refname)", "refs/alinery/")).toBe(`refs/alinery/executions/${other.slug}/e1`);
});
