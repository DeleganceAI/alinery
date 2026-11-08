// SubtaskService over the real socket (plan S4.8): the state a task page reads, starting a manager, and a discard that
// stops its sessions first and answers with a cursor covering what it changed.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { SubtaskService } from "alinery-proto/alinery/v1/subtasks_pb";
import { BoardProjector } from "../domain/board.ts";
import { ChatPublisher, type ChatSessions } from "../domain/chat.ts";
import { SessionPublisher } from "../domain/sessions.ts";
import { prepareSubtask, parseCreateSubtaskInput } from "../domain/subtasks.ts";
import { provisionTask } from "../domain/tasks.ts";
import { JobRunner } from "../jobs/runner.ts";
import type { TelemetryEvent } from "../platform/telemetry.ts";
import { Feed } from "../sync/feed.ts";
import { sessionKey } from "../sync/parsers/sessionMeta.ts";
import { Store } from "../sync/store.ts";
import { createExecutionSession, startSession } from "../tasks.ts";
import { serveRpc } from "./server.ts";

const SECRET = "ef".repeat(32);
const PLAYBOOK = readFileSync(join(import.meta.dir, "../../../playbooks/one-shot/playbook.md"), "utf8");
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function git(dir: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

async function start() {
  const dir = realpathSync(mkdtempSync("/tmp/rpc-sub-"));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const parent = await provisionTask(
    { repo, lane: "", identity: "i" },
    { name: "A", description: "d", playbook: { reference: { scope: "bundled", key: "one-shot" }, source: PLAYBOOK }, launchDefaults: { harness: "omp", model: "" }, maxLiveSessions: 10, start: false },
  );
  expect(parent.creation).toBe("ready");
  const alinery = join(repo, ".alinery");
  const store = new Store({ coalesceMs: 1 });
  const board = new BoardProjector(store, alinery);
  const f: Feed = new Feed(store, alinery, (e) => board.decorate(publisher.decorate(e)), board.dependents, {});
  const publisher: SessionPublisher = new SessionPublisher(store, f, () => [], { protocol: 33, buildId: "b" });
  const events: TelemetryEvent[] = [];
  const running = new Set<string>();
  const stopped: string[] = [];
  const runner: ChatSessions = {
    create: (request) => createExecutionSession(repo, request, async (id) => void running.add(id)),
    start: (request) => startSession(repo, request, async (id) => void running.add(id)),
    open: async (header) => void running.add(String(header.id)),
    isRunning: (id) => running.has(id),
    stop: (id) => {
      stopped.push(id);
      running.delete(id);
    },
  };
  const sessions = {
    repo,
    refresh: (rel: string) => f.refresh(rel),
    telemetry: { record: (build: () => TelemetryEvent) => void events.push(build()) },
    chat: new ChatPublisher(store, repo),
    runner,
    telemetryIds: () => ({ session: "sess-id", task: "task-id" }),
  };
  const socketPath = join(dir, "rpc.sock");
  const net = await serveRpc({
    socketPath,
    secret: Buffer.from(SECRET),
    hostExecutable: process.execPath,
    info: { protocol: 33, buildId: "b", repoRoot: repo, appConfigIdentity: "i" },
    lifecycle: { stop: () => 0, exit: () => {} },
    store,
    jobs: new JobRunner(store),
    storageScan: { mode: "error" } as never,
    transcripts: async () => undefined,
    sessions,
  });
  cleanup.push(() => {
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const transport = createGrpcTransport({
    baseUrl: "http://daemon",
    nodeOptions: { createConnection: () => connect(socketPath) } as never,
    interceptors: [(next) => (req) => (req.header.set("authorization", `Bearer ${SECRET}`), next(req))],
  });
  await f.scan();
  return { repo, store, stopped, running, subtasks: createClient(SubtaskService, transport) };
}
type Ctx = Awaited<ReturnType<typeof start>>;

let n = 0;
const meta = () => ({ clientId: "c1", mutationId: `m${++n}` });
const code = async (call: Promise<unknown>) => ConnectError.from(await call.then(() => null, (e) => e)).code;

test("the state names whether a sub-task can start, and an unknown task is not found", async () => {
  const c = await start();
  const state = await c.subtasks.subtaskState({ slug: "a" });
  expect(state.canStart).toBe(true);
  expect(state.task?.slug).toBe("a");
  expect(await code(c.subtasks.subtaskState({ slug: "nope" }))).toBe(Code.NotFound);
});

test("starting a manager opens its session once, and the state then offers it and refuses a second", async () => {
  const c = await start();
  const req = { meta: meta(), slug: "a", recover: false };
  const res = await c.subtasks.startManager(req);
  expect(res.started?.start).toBe("started");
  const id = res.started?.session?.id ?? "";
  expect(id).not.toBe("");
  expect(c.running.has(id)).toBe(true);
  expect(c.store.get(sessionKey("a", id))).toBeDefined();
  // The same mutation again answers from the first run instead of starting another manager.
  const again = await c.subtasks.startManager(req);
  expect(again.started?.session?.id).toBe(id);
  const state = await c.subtasks.subtaskState({ slug: "a" });
  expect(state.managerSession?.id).toBe(id);
  expect(state.disabledReason).toBe("A sub-task setup manager already exists");
  expect(await code(c.subtasks.startManager({ meta: meta(), slug: "a", recover: false }))).toBe(Code.FailedPrecondition);
  expect(await code(c.subtasks.startManager({ meta: meta(), slug: "a", recover: true }))).toBe(Code.FailedPrecondition);
});

test("discarding a setup stops its session first and answers with the cursor that covers its removal", async () => {
  const c = await start();
  const id = (await c.subtasks.startManager({ meta: meta(), slug: "a", recover: false })).started?.session?.id ?? "";
  const res = await c.subtasks.discardSubtask({ meta: meta(), slug: "a", managerSessionId: id });
  expect(c.stopped).toEqual([id]);
  expect(res.stoppedSessionIds).toEqual([id]);
  expect(existsSync(join(c.repo, ".alinery", "tasks", "a", "sessions", `${id}.meta.json`))).toBe(false);
  expect(c.store.get(sessionKey("a", id))).toBeUndefined();
  expect(res.applied?.cursor?.seq).toBe(c.store.cursor().seq);
  expect(await code(c.subtasks.discardSubtask({ meta: meta(), slug: "a", managerSessionId: id }))).toBe(Code.FailedPrecondition);
});

test("killing a child stops the lineage and archives it, and the daemon's parent stays startable", async () => {
  const c = await start();
  const id = (await c.subtasks.startManager({ meta: meta(), slug: "a", recover: false })).started?.session?.id ?? "";
  const d = { repo: c.repo, lane: "", identity: "i" };
  const plan = await prepareSubtask(d, parseCreateSubtaskInput({ manager_session_id: id, name: "B", slug: "b", instructions: "x" }));
  expect((await provisionTask(d, plan.params, plan.hooks)).creation).toBe("ready");
  expect((await c.subtasks.subtaskState({ slug: "a" })).activeSubtask?.slug).toBe("b");

  const res = await c.subtasks.discardSubtask({ meta: meta(), slug: "a", managerSessionId: id });
  expect(res.stoppedSessionIds).toContain(id);
  const after = await c.subtasks.subtaskState({ slug: "a" });
  expect(after.activeSubtask).toBeUndefined();
  const b = await c.subtasks.subtaskState({ slug: "b" });
  expect(b.task).toMatchObject({ archived: true, subtaskOutcome: "killed" });
});

async function withChild(c: Ctx) {
  const id = (await c.subtasks.startManager({ meta: meta(), slug: "a", recover: false })).started?.session?.id ?? "";
  const d = { repo: c.repo, lane: "", identity: "i" };
  const plan = await prepareSubtask(d, parseCreateSubtaskInput({ manager_session_id: id, name: "B", slug: "b", instructions: "x" }));
  expect((await provisionTask(d, plan.params, plan.hooks)).creation).toBe("ready");
  return id;
}

test("inspecting a finish names the bound child, the modes it allows and what blocks the rest (S5.1)", async () => {
  const c = await start();
  const id = await withChild(c);
  const { inspection } = await c.subtasks.inspectSubtaskFinish({ managerSessionId: id });
  const found = inspection as { child_task: { slug: string }; allowed_modes: string[]; blockers: Record<string, string[]>; observed_live_parent_sessions: string[] };
  expect(found.child_task.slug).toBe("b");
  expect(Object.keys(found.blockers).sort()).toEqual(["archive_without_code", "artifacts_only", "integrated_code"]);
  expect(found.allowed_modes).toContain("archive_without_code");
  // The manager is the parent's own running session and is never counted as one the finish would disturb.
  expect(found.observed_live_parent_sessions).not.toContain(id);
  expect(await code(c.subtasks.inspectSubtaskFinish({ managerSessionId: "nope" }))).not.toBe(Code.Ok);
});

test("finalizing archives the child as finished, clears the parent's link and refuses a mode it did not allow", async () => {
  const c = await start();
  const id = await withChild(c);
  expect(await code(c.subtasks.finalizeSubtask({ meta: meta(), managerSessionId: id, mode: "sideways" }))).toBe(Code.InvalidArgument);
  const res = await c.subtasks.finalizeSubtask({ meta: meta(), managerSessionId: id, mode: "archive_without_code" });
  expect((res.result as { archived_child: { slug: string } }).archived_child.slug).toBe("b");
  expect((await c.subtasks.subtaskState({ slug: "a" })).activeSubtask).toBeUndefined();
  expect((await c.subtasks.subtaskState({ slug: "b" })).task).toMatchObject({ archived: true, subtaskOutcome: "finished" });
  // The child is gone from the manager's reach, so a second finish has nothing bound to finalize.
  expect(await code(c.subtasks.finalizeSubtask({ meta: meta(), managerSessionId: id, mode: "archive_without_code" }))).not.toBe(Code.Ok);
});
