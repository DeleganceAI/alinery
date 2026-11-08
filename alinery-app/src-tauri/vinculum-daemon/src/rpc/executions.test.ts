import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ExecutionService } from "alinery-proto/alinery/v1/executions_pb";
import { commitExecution, executionKey } from "../domain/executions.ts";
import { engineExecutions, prepareGraphs, resetGraphs, tickGraphs, type SessionHooks } from "../graph.ts";
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
function lockedTask(repo: string, slug: string) {
  const dir = join(repo, ".alinery", "tasks", slug);
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "artifacts", "ticket.md"), "the task");
  const step = `[[step]]\nkey = "work"\ntitle = "Work"\nshort = ""\ninputs = [{ path = "ticket.md", mode = "single" }]\noutputs = [{ path = "out.md" }]\nmodel = ""\nharness = ""\nis_coding_step = false\nauto_advance_default = false`;
  writeFileSync(join(dir, "playbook.md"), `+++\nversion = 2\nkey = "fixture"\ntitle = "Fixture"\ndescription = ""\ndefault_model = ""\ndefault_harness = "omp"\n\n${step}\n+++\n<!-- alinery:step work -->\nDo the step.\n`);
  writeFileSync(join(dir, "task.md"), `name = "Fixture"\nworktree = ${JSON.stringify(repo)}\nhas_worktree = true\n`);
  writeFileSync(join(dir, "execution.json"), JSON.stringify({ creation: "ready", initial_start_requested: true, max_live_sessions: 10, enabled_steps: [], auto_approve_all: false }));
}

async function start(hostExecutable: string | undefined = process.execPath) {
  const dir = mkdtempSync("/tmp/rpc-x-");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".alinery"), { recursive: true });
  lockedTask(repo, "t");
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
  return { store, sent, client, revision: () => store.get(executionKey("t"))!.revision };
}

const meta = (id: string) => ({ clientId: "c1", mutationId: id });
const code = async (call: Promise<unknown>) => ConnectError.from(await call.then(() => null, (e) => e)).code;

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
