import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ExecutionService } from "alinery-proto/alinery/v1/executions_pb";
import { setAutoApproveAll } from "../domain/tasks.ts";
import { commitExecution, executionKey } from "../domain/executions.ts";
import { completeSession, engineExecutions, forgetTask, submitSessionWork, prepareGraphs, resetGraphs, tickGraphs, type SessionHooks } from "../graph.ts";
import { JobRunner } from "../jobs/runner.ts";
import { Store } from "../sync/store.ts";
import { serveRpc } from "./server.ts";

const SECRET = "cd".repeat(32);
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  resetGraphs();
});

// One task whose only step is locked (auto_advance_default false, not in enabled_steps), so its execution stays live
// until a person lets it finish.
function lockedTask(repo: string, slug: string, withSuccessor: boolean) {
  const dir = join(repo, ".alinery", "tasks", slug);
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "artifacts", "ticket.md"), "the task");
  const step = `[[step]]\nkey = "work"\ntitle = "Work"\nshort = ""\ninputs = [{ path = "ticket.md", mode = "single" }]\noutputs = [{ path = "out.md" }]\nmodel = ""\nharness = ""\nis_coding_step = false\nauto_advance_default = false`;
  const next = withSuccessor ? step.replace('key = "work"', 'key = "review"').replace('"out.md"', '"final.md"').replace('"ticket.md"', '"out.md"') : "";
  writeFileSync(join(dir, "playbook.md"), `+++\nversion = 2\nkey = "fixture"\ntitle = "Fixture"\ndescription = ""\ndefault_model = ""\ndefault_harness = "vinculum"\n\n${step}\n${next}\n+++\n<!-- alinery:step work -->\nDo the step.\n${withSuccessor ? "<!-- alinery:step review -->\nReview.\n" : ""}`);
  writeFileSync(join(dir, "task.md"), `name = "Fixture"\nslug = "${slug}"\nbranch = "task"\ncreated = 1\nengine_version = 2\nworktree = ${JSON.stringify(repo)}\nhas_worktree = true\n`);
  writeFileSync(join(dir, "execution.json"), JSON.stringify({ creation: "ready", initial_start_requested: true, max_live_sessions: 10, enabled_steps: [], auto_approve_all: false }));
}

async function start(hostExecutable: string | undefined = process.execPath, withSuccessor = false) {
  const dir = mkdtempSync("/tmp/rpc-x-");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".alinery"), { recursive: true });
  lockedTask(repo, "t", withSuccessor);
  const store = new Store({ coalesceMs: 1 });
  const sent: string[] = [];
  const hooks: SessionHooks = {
    async open() {},
    async status() {
      return { kind: "idle" };
    },
    async send(_id, text) {
      sent.push(text);
    },
    async stop() {},
    bind() {},
    executionChanged: (slug) => commitExecution(store, repo, slug, "lane", "identity"),
  };
  resetGraphs();
  prepareGraphs(repo, hooks);
  await tickGraphs();
  const socketPath = join(dir, "rpc.sock");
  const net = await serveRpc({
    socketPath,
    secret: Buffer.from(SECRET),
    hostExecutable,
    info: { protocol: 27, buildId: "b", repoRoot: repo, appConfigIdentity: "i" },
    lifecycle: { stop: () => 0, exit: () => {} },
    store,
    jobs: new JobRunner(store),
    storageScan: { mode: "error" } as never,
    transcripts: async () => undefined,
  });
  cleanup.push(() => {
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const client = (header: string | undefined = `Bearer ${SECRET}`) =>
    createClient(
      ExecutionService,
      createGrpcTransport({
        baseUrl: "http://daemon",
        nodeOptions: { createConnection: () => connect(socketPath) } as never,
        interceptors: [(next) => (req) => (header ? (req.header.set("authorization", header), next(req)) : next(req))],
      }),
    );
  return { repo, hooks, store, sent, client, revision: () => store.get(executionKey("t"))!.revision };
}

const meta = (id: string) => ({ clientId: "c1", mutationId: id });
const code = async (call: Promise<unknown>) => ConnectError.from(await call.then(() => null, (e) => e)).code;

test("nudging requires an authenticated actor, the owning session and an observed run", async () => {
  const { client } = await start("/bin/not-the-app");
  const req = { taskSlug: "t", executionId: "e1", sessionId: "s1", runId: "r1", meta: meta("nudge") };
  expect(await code(client("").nudgeExecution(req))).toBe(Code.Unauthenticated);
  expect(await code(client().nudgeExecution({ ...req, runId: "" }))).toBe(Code.InvalidArgument);
  expect(await code(client().nudgeExecution({ ...req, meta: meta("wrong-owner"), sessionId: "other" }))).toBe(Code.FailedPrecondition);
  expect(engineExecutions("t")[0].permitted).toBe(false);
});

test("changing step continuation persists the task policy and updates its current unaccepted owner", async () => {
  const { client, store, revision } = await start();
  const change = { taskSlug: "t", stepKey: "work", automatic: true, expectedRevision: revision(), meta: meta("policy") };
  await client().setStepContinuation(change);
  const row = store.get(executionKey("t"))?.value;
  expect(row?.case === "execution" && row.value.state?.enabled_steps).toEqual(["work"]);
  expect(engineExecutions("t")[0].automatic).toBe(true);
  const after = revision();
  await client().setStepContinuation(change);
  expect(revision()).toBe(after);
  expect(await code(client().setStepContinuation({ ...change, meta: meta("stale"), automatic: false }))).toBe(Code.Aborted);
});

test("Wait for me revokes a legacy one-time grant before an intermediate owner reports readiness", async () => {
  const { client, revision } = await start(undefined, true);
  const rpc = client();
  await rpc.allowCompletion({ taskSlug: "t", executionId: "e1", meta: meta("grant") });
  expect(engineExecutions("t")[0].permitted).toBe(true);
  await rpc.setStepContinuation({ taskSlug: "t", stepKey: "work", automatic: false, expectedRevision: revision(), meta: meta("manual") });
  await readyWork();
  const [execution] = engineExecutions("t");
  expect(execution.permitted).toBe(false);
  expect(execution.ready?.endpoint).toBe(false);
  expect(execution.receipt).toBeNull();
});

test("two conflicting changes based on one displayed revision apply exactly one policy", async () => {
  const { client, revision } = await start();
  const rpc = client();
  const observed = revision();
  const modes = [true, false];
  const changes = await Promise.allSettled(modes.map((automatic, i) => rpc.setStepContinuation({
    taskSlug: "t", stepKey: "work", automatic, expectedRevision: observed, meta: meta(`race-${i}`),
  })));
  expect(changes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const refused = changes.find((result) => result.status === "rejected");
  expect(ConnectError.from(refused?.reason).code).toBe(Code.Aborted);
  expect(engineExecutions("t")[0].automatic).toBe(modes[changes.findIndex((result) => result.status === "fulfilled")]);
});

test("unknown steps and a task-wide override return actionable policy refusals", async () => {
  const { client, repo } = await start();
  const rpc = client();
  expect(await code(rpc.setStepContinuation({ taskSlug: "t", stepKey: "missing", automatic: true, meta: meta("missing") }))).toBe(Code.NotFound);
  await setAutoApproveAll(repo, "t", true);
  expect(await code(rpc.setStepContinuation({ taskSlug: "t", stepKey: "work", automatic: false, meta: meta("manual") }))).toBe(Code.FailedPrecondition);
});

test("AllowCompletion permits one live execution, tells its agent, and the reply cursor covers the new row", async () => {
  const { client, store, sent } = await start();
  expect(engineExecutions("t").map((e) => [e.id, e.status, e.permitted])).toEqual([["e1", "live", false]]);
  const before = store.get(executionKey("t"))!.revision;
  const res = await client().allowCompletion({ meta: meta("m1"), taskSlug: "t", executionId: "e1" });
  expect(engineExecutions("t")[0].permitted).toBe(true);
  expect(sent).toHaveLength(1);
  expect(store.get(executionKey("t"))!.revision).toBeGreaterThan(before);
  expect(res.applied?.cursor?.seq).toBe(store.cursor().seq);
  // The same mutation again changes nothing and does not tell the agent twice.
  await client().allowCompletion({ meta: meta("m1"), taskSlug: "t", executionId: "e1" });
  expect(sent).toHaveLength(1);
});

test("a stale expected_revision is ABORTED and permits nothing", async () => {
  const { client, revision, sent } = await start();
  expect(await code(client().allowCompletion({ meta: meta("m1"), taskSlug: "t", executionId: "e1", expectedRevision: revision() - 1n }))).toBe(Code.Aborted);
  expect(engineExecutions("t")[0].permitted).toBe(false);
  expect(sent).toEqual([]);
  await client().allowCompletion({ meta: meta("m2"), taskSlug: "t", executionId: "e1", expectedRevision: revision() });
  expect(engineExecutions("t")[0].permitted).toBe(true);
});

test("an unknown task or execution is NOT_FOUND, a bad slug INVALID_ARGUMENT, and a missing mutation id is refused", async () => {
  const { client } = await start();
  expect(await code(client().allowCompletion({ meta: meta("a"), taskSlug: "nope", executionId: "e1" }))).toBe(Code.NotFound);
  expect(await code(client().allowCompletion({ meta: meta("b"), taskSlug: "t", executionId: "e9" }))).toBe(Code.NotFound);
  expect(await code(client().allowCompletion({ meta: meta("c"), taskSlug: "../t", executionId: "e1" }))).toBe(Code.InvalidArgument);
  expect(await code(client().allowCompletion({ taskSlug: "t", executionId: "e1" }))).toBe(Code.InvalidArgument);
});

test("a process that is not the app, and a caller with no token, cannot approve", async () => {
  const other = await start("/bin/not-the-app");
  expect(await code(other.client().allowCompletion({ meta: meta("a"), taskSlug: "t", executionId: "e1" }))).toBe(Code.PermissionDenied);
  expect(await code(other.client("").allowCompletion({ meta: meta("b"), taskSlug: "t", executionId: "e1" }))).toBe(Code.Unauthenticated);
  expect(engineExecutions("t")[0].permitted).toBe(false);
});

async function readyWork() {
  const e = engineExecutions("t")[0];
  writeFileSync(join(e.outDir, "out.md"), "handoff");
  const report = await completeSession(e.sessionId!);
  expect(report?.outcome).toBe("ready_for_review");
  return { taskSlug: "t", executionId: e.id, sessionId: e.sessionId!, workRevision: BigInt(Number(report!.work_revision)) };
}

test("Continue accepts the reviewed work once, replays the receipt after restart, and fences later prompts", async () => {
  const { client, hooks, store } = await start(undefined, true);
  const action = await readyWork();
  const entity = store.get(executionKey("t"))!.value;
  expect(entity.case === "execution" && entity.value.state?.executions).toMatchObject({
    e1: { owner_session_id: action.sessionId, lifecycle: "running", receipt_id: null, ready: { endpoint: false, destinations: ["review"], roles: ["out.md"] } },
  });
  expect(await code(client().continueReviewed({ ...action, sessionId: "old-owner", meta: meta("owner") }))).toBe(Code.Aborted);
  expect(await code(client().continueReviewed({ ...action, workRevision: 0n, meta: meta("empty") }))).toBe(Code.InvalidArgument);
  hooks.reviewBlocker = async () => "Waiting for a response.";
  expect(await code(client().continueReviewed({ ...action, meta: meta("busy") }))).toBe(Code.FailedPrecondition);
  expect(engineExecutions("t")[0].receipt).toBeNull();
  hooks.reviewBlocker = async () => undefined;
  const apply = { ...action, meta: meta("continue") };
  const first = await client().continueReviewed(apply);
  expect(first.applied?.cursor?.seq).toBe(store.cursor().seq);
  expect((await client().continueReviewed(apply)).applied).toEqual(first.applied);
  expect(engineExecutions("t")[0].receipt).toHaveLength(1);
  forgetTask("t");
  await tickGraphs();
  hooks.reviewBlocker = async () => "The owning session has exited.";
  await client().continueReviewed({ ...action, meta: meta("reconnect") });
  expect(engineExecutions("t")[0].receipt).toHaveLength(1);
  let submitted = false;
  await expect(submitSessionWork("t", action.sessionId, async () => { submitted = true; })).rejects.toThrow();
  expect(submitted).toBe(false);
});

test("newly admitted and queued inputs fence stale reviews; a replacement report has a new revision", async () => {
  const { client, hooks, repo } = await start(undefined, true);
  const old = await readyWork();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const pending = submitSessionWork("t", old.sessionId, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  expect(engineExecutions("t")[0].ready).toBeUndefined();
  const ahead = completeSession(old.sessionId);
  const reviewed = client().continueReviewed({ ...old, meta: meta("obsolete") });
  hooks.reviewBlocker = async () => "The session has queued user input.";
  release.resolve();
  await pending;
  expect((await ahead)?.outcome).toBe("pending_work");
  expect(await code(reviewed)).toBe(Code.Aborted);
  expect(engineExecutions("t")[0].receipt).toBeNull();
  hooks.reviewBlocker = undefined;
  expect((await completeSession(old.sessionId, () => false))?.error).toContain("owner changed");
  const fresh = await readyWork();
  expect(fresh.workRevision).toBeGreaterThan(old.workRevision);
  appendFileSync(join(repo, ".alinery", "tasks", "t", "task.md"), "archived = true\n");
  expect(await code(client().continueReviewed({ ...fresh, meta: meta("archived") }))).toBe(Code.FailedPrecondition);
  expect(engineExecutions("t")[0].receipt).toBeNull();
});

test("only an APPROVE caller can continue reviewed work", async () => {
  const { client } = await start("/bin/not-the-app", true);
  const action = { ...(await readyWork()), meta: meta("review") };
  expect(await code(client().continueReviewed(action))).toBe(Code.PermissionDenied);
  expect(await code(client("").continueReviewed(action))).toBe(Code.Unauthenticated);
  expect(engineExecutions("t")[0].receipt).toBeNull();
});
