import { create } from "@bufbuild/protobuf";
import { ScopeSchema } from "alinery-proto/alinery/v1/sync_pb";
import type { Entity } from "alinery-proto/alinery/v1/entities_pb";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Feed } from "../sync/feed.ts";
import { Store } from "../sync/store.ts";
import { hasPty, killPty, startShell, writePty } from "../terminal.ts";
import { daemonStatusKey, type LiveRow, SessionPublisher } from "./sessions.ts";

const ids: string[] = [];
afterEach(() => {
  for (const id of ids.splice(0)) if (hasPty(id)) killPty(id);
});

function rig() {
  const repo = mkdtempSync(join(tmpdir(), "vinculum-sessions-"));
  const alinery = join(repo, ".alinery");
  const rows = new Map<string, LiveRow>();
  const store = new Store();
  const feed = new Feed(store, alinery, (e) => publisher.decorate(e));
  const publisher: SessionPublisher = new SessionPublisher(store, feed, () => rows.values(), { protocol: 25, buildId: "test" });
  const meta = (slug: string, id: string) => {
    const dir = join(alinery, "tasks", slug, "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify({ id, worktree: repo, created: 1 }));
  };
  const row = (slug: string, id: string): LiveRow => ({
    id,
    taskSlug: slug,
    process: { state: "alive" },
    agent: { state: "idle" },
    playbook: { state: "in_progress" },
    adapter: "omp",
    message_adapter: "unsupported",
  });
  return { repo, rows, store, feed, publisher, meta, row };
}

/** Every put the store sends for a scope, as it arrives. */
function collect(store: Store, kind: { case: "repo"; value: object } | { case: "session"; value: { session: { taskSlug: string; id: string } } }) {
  const puts: Entity[] = [];
  const ac = new AbortController();
  void (async () => {
    for await (const f of store.open(create(ScopeSchema, { kind: kind as never }), undefined, ac.signal)) {
      if (f.frame.case === "delta") for (const c of f.frame.value.changes) if (c.op.case === "put") puts.push(c.op.value);
    }
  })();
  return { puts, stop: () => ac.abort() };
}
const sessionScope = (taskSlug: string, id: string) => ({ case: "session" as const, value: { session: { taskSlug, id } } });
const settle = () => Bun.sleep(60); // past the store's 16 ms coalescing window

test("a Terminal session shows a put while it runs and a put after it exits", async () => {
  const t = rig();
  t.meta("fix", "s1");
  await t.feed.scan();
  const seen = collect(t.store, sessionScope("fix", "s1"));
  const row = { ...t.row("fix", "s1"), transport: "pty" };
  t.rows.set("s1", row);
  ids.push("s1");
  startShell("s1", t.repo, join(t.repo, "s1.scrollback"), 80, 24, () => {
    row.process = { state: "exited" };
    t.publisher.changed("fix", "s1");
  }, "/bin/sh");
  t.publisher.changed("fix", "s1");
  await settle();
  const running = seen.puts.at(-1)?.value;
  expect(running?.case === "session" && running.value.status?.process).toBe("alive");
  expect(running?.case === "session" && running.value.status?.transport).toBe("pty"); // the app picks terminal or agent view from it
  expect(running?.case === "session" && running.value.worktree).toBe(t.repo); // stored fields survive the merge

  writePty("s1", "exit\n");
  for (let i = 0; i < 100 && seen.puts.at(-1)?.value.case === "session" && (seen.puts.at(-1)!.value.value as { status?: { process: string } }).status?.process !== "exited"; i++) await Bun.sleep(20);
  const ended = seen.puts.at(-1)?.value;
  expect(ended?.case === "session" && ended.value.status?.process).toBe("exited");
  seen.stop();
});

test("setting and clearing the Attention wait gives two deltas", async () => {
  const t = rig();
  t.meta("fix", "s1");
  const row = t.row("fix", "s1");
  t.rows.set("s1", row);
  await t.feed.scan();
  const seen = collect(t.store, sessionScope("fix", "s1"));
  await settle();
  const before = seen.puts.length;

  row.wait = { kind: "approval", correlationId: "c1", prompt: "ok?" };
  row.agent = { state: "waiting_for_approval", correlation_id: "c1" };
  t.publisher.changed("fix", "s1");
  await settle();
  row.wait = null;
  row.agent = { state: "idle" };
  t.publisher.changed("fix", "s1");
  await settle();

  const fresh = seen.puts.slice(before).map((e) => (e.value.case === "session" ? e.value.value : undefined));
  expect(fresh.length).toBe(2);
  expect(fresh[0]?.wait).toMatchObject({ kind: "approval", correlationId: "c1", prompt: "ok?" });
  expect(fresh[0]?.status?.agent).toBe("waiting_for_approval");
  expect(fresh[1]?.wait).toBeUndefined();
  seen.stop();
});

test("the live count in daemon/_/status follows sessions starting and ending", async () => {
  const t = rig();
  t.meta("a", "s1");
  t.meta("a", "s2");
  await t.feed.scan();
  t.publisher.commitStatus();
  const count = () => {
    const e = t.store.get(daemonStatusKey);
    return e?.value.case === "daemonStatus" ? [e.value.value.liveSessions, e.value.value.protocol, e.value.value.buildId] : undefined;
  };
  expect(count()).toEqual([0, 25, "test"]);
  for (const id of ["s1", "s2"]) {
    t.rows.set(id, t.row("a", id));
    t.publisher.changed("a", id);
  }
  expect(count()?.[0]).toBe(2);
  t.rows.get("s1")!.process = { state: "exited" };
  t.publisher.changed("a", "s1");
  expect(count()?.[0]).toBe(1);
  t.rows.delete("s2");
  t.publisher.changed("a", "s2");
  expect(count()?.[0]).toBe(0);
});

test("a watcher re-read of the meta file keeps the live status", async () => {
  const t = rig();
  t.meta("fix", "s1");
  t.rows.set("s1", t.row("fix", "s1"));
  await t.feed.scan();
  await t.feed.refresh("tasks/fix/sessions/s1.meta.json"); // what the watcher does on any file event
  const e = t.store.get("session/fix/s1")?.value;
  expect(e?.case === "session" && e.value.status?.process).toBe("alive");
});

test("a session with no live row has no status", async () => {
  const t = rig();
  t.meta("fix", "s1");
  await t.feed.scan();
  const e = t.store.get("session/fix/s1")?.value;
  expect(e?.case === "session" && e.value.status).toBeUndefined();
});

test("daemon status reports an exhausted watcher", () => {
  const t = rig();
  let exhausted = false;
  const p = new SessionPublisher(t.store, t.feed, () => t.rows.values(), { protocol: 25, buildId: "test", watchExhausted: () => exhausted });
  p.commitStatus();
  const flag = () => {
    const e = t.store.get(daemonStatusKey)?.value;
    return e?.case === "daemonStatus" && e.value.watchExhausted;
  };
  expect(flag()).toBe(false);
  exhausted = true;
  p.commitStatus();
  expect(flag()).toBe(true);
});

test("daemon/_/status counts busy and waiting sessions, and leaves exited ones out", async () => {
  const t = rig();
  for (const [id, agent] of [["a", "busy"], ["b", "waiting_for_input"], ["c", "waiting_for_approval"], ["d", "busy"]] as const) {
    const row = t.row("x", id);
    row.agent = { state: agent };
    t.rows.set(id, row);
  }
  t.rows.get("d")!.process = { state: "exited" };
  t.publisher.commitStatus();
  const e = t.store.get(daemonStatusKey);
  const v = e?.value.case === "daemonStatus" ? e.value.value : undefined;
  expect([v?.liveSessions, v?.busy, v?.waitingForInput, v?.waitingForApproval]).toEqual([3, 1, 1, 1]);
});
