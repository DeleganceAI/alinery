import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ChatService } from "alinery-proto/alinery/v1/chat_pb";
import { SessionService } from "alinery-proto/alinery/v1/sessions_pb";
import { BoardProjector } from "../domain/board.ts";
import { ChatPublisher, chatKey, type ChatSessions } from "../domain/chat.ts";
import { SessionPublisher } from "../domain/sessions.ts";
import { metaPathOf } from "../domain/sessionOps.ts";
import { JobRunner } from "../jobs/runner.ts";
import type { TelemetryEvent } from "../platform/telemetry.ts";
import { Feed } from "../sync/feed.ts";
import { sessionKey } from "../sync/parsers/sessionMeta.ts";
import { Store } from "../sync/store.ts";
import { createExecutionSession, startSession } from "../tasks.ts";
import { serveRpc } from "./server.ts";

const SECRET = "cd".repeat(32);
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function git(dir: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

async function start() {
  const dir = realpathSync(mkdtempSync("/tmp/rpc-sw-"));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const alinery = join(repo, ".alinery");
  const task = join(alinery, "tasks", "t");
  mkdirSync(join(task, "sessions"), { recursive: true });
  mkdirSync(join(alinery, "sessions"), { recursive: true });
  writeFileSync(join(task, "task.md"), 'name = "Ship it"\nslug = "t"\nbranch = "t"\nworktree = "/x"\ncreated = 1\n');
  const store = new Store({ coalesceMs: 1 });
  const board = new BoardProjector(store, alinery);
  const f: Feed = new Feed(store, alinery, (e) => board.decorate(publisher.decorate(e)), board.dependents, {});
  const publisher: SessionPublisher = new SessionPublisher(store, f, () => [], { protocol: 29, buildId: "b" });
  const events: TelemetryEvent[] = [];
  const running = new Set<string>();
  const metaAtKill: Record<string, Record<string, unknown>> = {};
  const runner: ChatSessions = {
    create: (request) => createExecutionSession(repo, request, async () => {}),
    start: (request) => startSession(repo, request, async (id) => void running.add(id)),
    open: async (header) => void running.add(String(header.id)),
    isRunning: (id) => running.has(id),
    kill: (id) => {
      metaAtKill[id] = JSON.parse(readFileSync(metaPathOf(repo, id.startsWith("t-") ? "t" : "", id), "utf8"));
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
    info: { protocol: 29, buildId: "b", repoRoot: repo, appConfigIdentity: "i" },
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
  return { repo, alinery, task, store, feed: f, events, running, metaAtKill, session: createClient(SessionService, transport), chat: createClient(ChatService, transport) };
}
type Ctx = Awaited<ReturnType<typeof start>>;

let n = 0;
const meta = () => ({ clientId: "c1", mutationId: `m${++n}` });
const code = async (call: Promise<unknown>) => ConnectError.from(await call.then(() => null, (e) => e)).code;
const ref = (taskSlug: string, id: string) => ({ taskSlug, id });
const sessionMeta = (c: Ctx, slug: string, id: string, extra: Record<string, unknown> = {}) => {
  const dir = slug ? join(c.task, "sessions") : join(c.alinery, "sessions");
  writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify({ id, worktree: c.repo, created: 1, ...extra }));
};

test("a rename lands in the file, the session row and the reply, and a retried mutation is written once", async () => {
  const c = await start();
  sessionMeta(c, "t", "s1");
  await c.feed.scan();
  const row = () => c.store.get(sessionKey("t", "s1"))?.value;
  expect(row()).toMatchObject({ case: "session", value: { attentionLabel: "Ship it" } });
  const m = meta();
  const out = await c.session.renameSession({ meta: m, session: ref("t", "s1"), name: "  Mine  " });
  expect([out.name, out.source]).toEqual(["Mine", "user"]);
  expect(row()).toMatchObject({ value: { name: "Mine", nameSource: "user" } });
  // The same mutation again is the same answer and no second write.
  writeFileSync(join(c.task, "sessions", "s1.name.json"), JSON.stringify({ name: "Edited elsewhere", source: "user" }));
  const again = await c.session.renameSession({ meta: m, session: ref("t", "s1"), name: "  Mine  " });
  expect(again.name).toBe("Mine");
  expect(JSON.parse(readFileSync(join(c.task, "sessions", "s1.name.json"), "utf8")).name).toBe("Edited elsewhere");
});

test("a rename names the revision it saw, and a session that moved since is ABORTED", async () => {
  const c = await start();
  sessionMeta(c, "t", "s1");
  await c.feed.scan();
  const seen = c.store.get(sessionKey("t", "s1"))?.revision ?? 0n;
  await c.session.renameSession({ meta: meta(), session: ref("t", "s1"), name: "One", expectedRevision: seen });
  expect(await code(c.session.renameSession({ meta: meta(), session: ref("t", "s1"), name: "Two", expectedRevision: seen }))).toBe(Code.Aborted);
  expect(JSON.parse(readFileSync(join(c.task, "sessions", "s1.name.json"), "utf8")).name).toBe("One");
  expect(await code(c.session.renameSession({ meta: meta(), session: ref("t", "s1"), name: "" }))).toBe(Code.InvalidArgument);
});

test("a task's rename reaches its sessions' attention label, and a chat thread's name reaches its row", async () => {
  const c = await start();
  sessionMeta(c, "t", "s1");
  sessionMeta(c, "", "c1", { harness: "vinculum", generic: true });
  await c.feed.scan();
  writeFileSync(join(c.task, "task.md"), 'name = "Renamed"\nslug = "t"\nbranch = "t"\nworktree = "/x"\ncreated = 1\n');
  await c.feed.refresh("tasks/t/task.md");
  expect(c.store.get(sessionKey("t", "s1"))?.value).toMatchObject({ value: { attentionLabel: "Renamed" } });
  await c.session.renameSession({ meta: meta(), session: ref("", "c1"), name: "Chat title" });
  expect(c.store.get(sessionKey("", "c1"))?.value).toMatchObject({ value: { name: "Chat title", attentionLabel: "session" } });
});

test("archiving a session puts the stamp in the file and the store before the process is stopped", async () => {
  const c = await start();
  sessionMeta(c, "t", "t-s1", { phase: "build" });
  await c.feed.scan();
  c.running.add("t-s1");
  const out = await c.session.archiveSession({ meta: meta(), session: ref("t", "t-s1") });
  expect(out.killedLive).toBe(true);
  expect(c.metaAtKill["t-s1"]).toMatchObject({ archived: true, phase: "build" });
  expect(c.running.has("t-s1")).toBe(false);
  expect(c.store.get(sessionKey("t", "t-s1"))?.value).toMatchObject({ value: { archived: true } });
  expect(c.events).toEqual([{ event: "session.archive", source: "alineryd", killedLive: true, sessionId: "sess-id", taskId: "task-id" }]);
  // Not running: archived all the same, nothing killed.
  sessionMeta(c, "t", "t-s2");
  await c.feed.refresh("tasks/t/sessions/t-s2.meta.json");
  expect((await c.session.archiveSession({ meta: meta(), session: ref("t", "t-s2") })).killedLive).toBe(false);
  expect(await code(c.session.archiveSession({ meta: meta(), session: ref("", "c1") }))).toBe(Code.InvalidArgument);
});

test("killing a session reports session.kill, and clearing notifications marks the checkpoints read", async () => {
  const c = await start();
  sessionMeta(c, "t", "t-s1", { semantic: { phase_completed_at: 20 }, exit_code: 1, ended_at: 30 });
  await c.feed.scan();
  c.running.add("t-s1");
  await c.session.killSession({ meta: meta(), session: ref("t", "t-s1") });
  expect(c.running.has("t-s1")).toBe(false);
  expect(c.events.at(-1)).toMatchObject({ event: "session.kill", sessionId: "sess-id" });
  await c.session.clearNotifications({ meta: meta(), sessions: [{ session: ref("t", "t-s1"), suppression: { notice: "n", occurrence: "o" } }] });
  expect(JSON.parse(readFileSync(join(c.task, "sessions", "t-s1.meta.json"), "utf8"))).toMatchObject({ notification_read_at: 20, exit_notification_read_at: 30, notification_suppression: { notice: "n", occurrence: "o" } });
});

test("the scrollback and the journal read back over the wire, and an escaping path is refused", async () => {
  const c = await start();
  sessionMeta(c, "t", "s1");
  writeFileSync(join(c.task, "sessions", "s1.scrollback"), "0123456789");
  const win = await c.session.readHistory({ session: ref("t", "s1"), offset: 2n, limit: 5n });
  expect([Buffer.from(win.data).toString(), win.length, win.nextOffset, win.eof]).toEqual(["23456", 10n, 7n, false]);
  const omp = join(c.task, "sessions", "s1.omp");
  mkdirSync(omp);
  writeFileSync(join(omp, "2026-01-01_a.jsonl"), "a\nb\n");
  const rows = await c.session.readOmpWindow({ session: ref("t", "s1") });
  expect([Buffer.from(rows.data).toString(), rows.end]).toEqual(["a\nb\n", 4n]);
  expect(await code(c.session.readHistory({ session: ref("t", "../x"), offset: 0n, limit: 1n }))).toBe(Code.InvalidArgument);
  expect((await c.session.artifactReady({ session: ref("t", "s1") })).ready).toBe(false);
});

test("a chat thread is created, pinned, continued and archived through ChatService, and its rail row follows", async () => {
  const c = await start();
  const created = await c.chat.createChatThread({ meta: meta(), model: "m", createWorktree: false });
  const id = (created.started?.session as { id: string }).id;
  expect(created.started?.start).toBe("started");
  expect(c.store.get(chatKey(id))?.value).toMatchObject({ case: "chatThread", value: { id, branchLabel: "main", checkout: true, superseded: false } });
  expect(c.store.get(sessionKey("", id))?.value).toMatchObject({ case: "session" });
  await c.chat.setChatPinned({ meta: meta(), threadId: id, pinned: true });
  expect(c.store.get(sessionKey("", id))?.value).toMatchObject({ value: { pinned: true } });
  expect(await code(c.chat.resumeChatThread({ meta: meta(), threadId: id }))).toBe(Code.FailedPrecondition);
  writeFileSync(metaPathOf(c.repo, "", id), JSON.stringify({ ...JSON.parse(readFileSync(metaPathOf(c.repo, "", id), "utf8")), harness_resume_token: "tok" }));
  const resumed = await c.chat.resumeChatThread({ meta: meta(), threadId: id });
  expect(resumed.successorId).not.toBe(id);
  expect(c.store.get(chatKey(id))?.value).toMatchObject({ value: { superseded: true } });
  await c.chat.archiveChatThread({ meta: meta(), threadId: resumed.successorId, removeWorktree: false });
  expect(c.store.get(sessionKey("", resumed.successorId))?.value).toMatchObject({ value: { archived: true } });
  expect(await code(c.chat.setChatPinned({ meta: meta(), threadId: "nope", pinned: true }))).toBe(Code.NotFound);
});
