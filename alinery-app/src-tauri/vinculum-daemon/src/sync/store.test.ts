import { expect, test } from "bun:test";
import { create, equals } from "@bufbuild/protobuf";
import { type Entity, EntitySchema } from "alinery-proto/alinery/v1/entities_pb";
import { ScopeSchema, type SubscribeResponse } from "alinery-proto/alinery/v1/sync_pb";
import { expected, FakeTimers, flush, Replica, repoScope, same, session, task, taskScope } from "./testkit.ts";
import { matcher, Store } from "./store.ts";

// Seeded RNG so a failure replays.
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
}

/** Drives one subscription: applies frames to the replica until the stream ends or asks for a refetch. */
function follow(store: Store, replica: Replica, scope = repoScope) {
  const ac = new AbortController();
  const done = (async () => {
    for await (const f of store.open(scope, replica.cursor, ac.signal)) if (replica.apply(f) === "refetch") return "refetch";
    return "aborted";
  })();
  return {
    done,
    stop: () => {
      ac.abort();
      return done;
    },
  };
}
const running = (s: { done: Promise<string> }) => Promise.race([s.done, Promise.resolve("running")]);
async function settled(replica: Replica, store: Store) {
  for (let i = 0; i < 500 && replica.cursor?.seq !== store.seq; i++) await Bun.sleep(1);
}

/** A reader that pulls frames one at a time, so a test controls when the stream is read. */
function reader(store: Store, scope = repoScope, cursor?: { epoch: string; seq: bigint }, signal = new AbortController().signal) {
  const it = store.open(scope, cursor && { $typeName: "alinery.v1.Cursor", ...cursor }, signal);
  return { next: async () => (await it.next()).value as SubscribeResponse | undefined, it };
}

test("equals compares oneof case and fields; revision is the only thing the store zeroes", () => {
  const a = task("a", "A");
  expect(equals(EntitySchema, a, task("a", "A"))).toBe(true);
  expect(equals(EntitySchema, a, task("a", "B"))).toBe(false);
  expect(equals(EntitySchema, a, create(EntitySchema, { key: a.key, value: { case: "session", value: {} } }))).toBe(false);
});

test("a put equal to the stored row takes no seq and sends nothing", async () => {
  const timers = new FakeTimers();
  const store = new Store({ timers });
  expect(store.commit([task("a", "A")])).toBe(1n);
  const r = reader(store);
  expect((await r.next())?.frame.case).toBe("snapshot");
  const pending = r.next();
  expect(store.commit([task("a", "A")])).toBe(1n);
  expect(store.commit([], ["task/missing/missing"])).toBe(1n);
  timers.tick(16);
  await flush();
  let delivered = false;
  void pending.then(() => (delivered = true));
  await flush();
  expect(delivered).toBe(false);
  expect(store.get("task/a/a")?.revision).toBe(1n);
  expect(store.commit([task("a", "B")])).toBe(2n);
  expect(store.get("task/a/a")?.revision).toBe(2n);
});

test("the store keeps its own copy: the caller's object is neither changed nor shared", () => {
  const store = new Store();
  const e = task("a", "A");
  store.commit([e]);
  expect(e.revision).toBe(0n);
  if (e.value.case === "task") e.value.value.name = "changed by the caller";
  expect(store.get("task/a/a")?.value).toMatchObject({ case: "task", value: { name: "A" } });
});

test("scopes filter keys as 2.2.6 says", () => {
  const keys = ["task/a/a", "draft/_/d1", "execution/a/e1", "daemon/_/status", "job/_/j", "settings/_/s", "playbook/_/p", "session/a/s1", "session/_/c1", "chat/_/t1", "artifact/a/01-x", "comment/a/c"];
  const pick = (scope: Parameters<typeof matcher>[0]) => keys.filter(matcher(scope));
  expect(pick(repoScope)).toEqual(["task/a/a", "draft/_/d1", "execution/a/e1", "daemon/_/status", "job/_/j", "settings/_/s", "playbook/_/p"]);
  expect(pick(taskScope("a"))).toEqual(["task/a/a", "execution/a/e1", "session/a/s1", "artifact/a/01-x", "comment/a/c"]);
  expect(pick(create(ScopeSchema, { kind: { case: "session", value: { session: { taskSlug: "a", id: "s1" } } } }))).toEqual(["session/a/s1"]);
  expect(pick(create(ScopeSchema, { kind: { case: "session", value: { session: { taskSlug: "", id: "c1" } } } }))).toEqual(["session/_/c1"]);
  expect(pick(create(ScopeSchema, { kind: { case: "chat", value: {} } }))).toEqual(["session/_/c1", "chat/_/t1"]);
  expect(pick(create(ScopeSchema, {}))).toEqual([]);
});

test("a snapshot comes in chunks and only the last says complete", async () => {
  const store = new Store({ snapshotChunk: 500 });
  store.commit(Array.from({ length: 1200 }, (_, i) => task(`t${i}`)));
  const ac = new AbortController();
  const sizes: [number, boolean][] = [];
  for await (const f of store.open(repoScope, undefined, ac.signal)) {
    if (f.frame.case !== "snapshot") break;
    sizes.push([f.frame.value.entities.length, f.frame.value.complete]);
    expect(f.frame.value.cursor?.seq).toBe(1n);
    if (f.frame.value.complete) break;
  }
  ac.abort();
  expect(sizes).toEqual([[500, false], [500, false], [200, true]]);
});

test("an empty scope still gets one complete snapshot", async () => {
  const f = await reader(new Store()).next();
  expect(f?.frame).toMatchObject({ case: "snapshot", value: { entities: [], complete: true } });
});

test("a cursor from another epoch gets a snapshot, not a replay", async () => {
  const store = new Store();
  store.commit([task("a")]);
  const f = await reader(store, repoScope, { epoch: "another-daemon", seq: 1n }).next();
  expect(f?.frame.case).toBe("snapshot");
  const future = await reader(store, repoScope, { epoch: store.epoch, seq: 99n }).next();
  expect(future?.frame.case).toBe("snapshot");
});

test("a cursor older than the ring gets a snapshot; one inside it gets only what it missed", async () => {
  const store = new Store({ ringSize: 5 });
  for (let i = 1; i <= 10; i++) store.commit([task(`t${i}`)]); // the ring holds commits 6 to 10
  expect((await reader(store, repoScope, { epoch: store.epoch, seq: 4n }).next())?.frame.case).toBe("snapshot");
  const r = reader(store, repoScope, { epoch: store.epoch, seq: 7n });
  const delta = await r.next();
  expect(delta?.frame.case === "delta" && delta.frame.value.changes.map((c) => c.op.value && (c.op.case === "put" ? c.op.value.key : c.op.value))).toEqual(["task/t8/t8", "task/t9/t9", "task/t10/t10"]);
  expect(delta?.frame.case === "delta" && delta.frame.value.cursor?.seq).toBe(10n);
  expect((await r.next())?.frame).toMatchObject({ case: "upToDate", value: { cursor: { seq: 10n } } });
  // The oldest seq the ring can vouch for is the one before its first commit.
  expect((await reader(store, repoScope, { epoch: store.epoch, seq: 5n }).next())?.frame.case).toBe("delta");
});

test("a current cursor gets UpToDate alone; a replay holds only the scope's changes", async () => {
  const store = new Store();
  store.commit([task("a"), task("b")]);
  const current = reader(store, repoScope, { epoch: store.epoch, seq: 1n });
  expect((await current.next())?.frame).toMatchObject({ case: "upToDate", value: { cursor: { seq: 1n } } });
  store.commit([session("a", "s1", "live")]); // seq 2, outside the repo scope
  store.commit([task("c")]); // seq 3
  const r = reader(store, repoScope, { epoch: store.epoch, seq: 1n });
  const delta = await r.next();
  expect(delta?.frame.case === "delta" && delta.frame.value.changes.length).toBe(1);
  expect(delta?.frame.case === "delta" && delta.frame.value.cursor?.seq).toBe(3n);
  // A replay that missed nothing in scope sends no empty delta.
  const quiet = await reader(store, taskScope("zzz"), { epoch: store.epoch, seq: 0n }).next();
  expect(quiet?.frame).toMatchObject({ case: "upToDate", value: { cursor: { seq: 3n } } });
});

test("a commit never falls between the snapshot and the live stream", async () => {
  const store = new Store({ coalesceMs: 0, heartbeatMs: 1000 });
  store.commit([task("a")]);
  const ac = new AbortController();
  const it = store.open(repoScope, undefined, ac.signal);
  const first = await it.next(); // registered and copied; the snapshot is out
  store.commit([task("b")]); // lands while the consumer holds the snapshot
  const replica = new Replica();
  replica.apply(first.value);
  const second = await it.next();
  replica.apply(second.value);
  ac.abort();
  same(replica.rows, expected(store));
  expect(replica.cursor?.seq).toBe(2n);
});

test("coalescing: commits inside one window go out as one delta", async () => {
  const timers = new FakeTimers();
  const store = new Store({ timers });
  const r = reader(store);
  await r.next(); // snapshot
  const pending = r.next();
  await flush();
  store.commit([task("a")]);
  await flush();
  store.commit([task("b")]); // inside the window the first commit opened
  store.commit([task("c")]);
  timers.tick(15);
  await flush();
  let frame: SubscribeResponse | undefined;
  void pending.then((f) => (frame = f));
  await flush();
  expect(frame).toBeUndefined();
  timers.tick(1);
  await flush();
  expect(frame?.frame.case === "delta" && frame.frame.value.changes.length).toBe(3);
  expect(frame?.frame.case === "delta" && frame.frame.value.cursor?.seq).toBe(3n);
});

test("heartbeat: 15 s of nothing queued, carrying the store's seq; a delta restarts the wait", async () => {
  const timers = new FakeTimers();
  const store = new Store({ timers });
  const r = reader(store, taskScope("a"));
  await r.next();
  let got: SubscribeResponse | undefined;
  const take = () => {
    got = undefined;
    void r.next().then((f) => (got = f));
  };
  take();
  await flush();
  store.commit([task("b")]); // outside this scope: nothing queued
  store.commit([task("c")]);
  timers.tick(14_999);
  await flush();
  expect(got).toBeUndefined();
  timers.tick(1);
  await flush();
  expect(got?.frame).toMatchObject({ case: "heartbeat", value: { cursor: { seq: 2n } } });
  // A matching commit becomes a delta, and the next heartbeat is 15 s after that.
  take();
  await flush();
  store.commit([task("a", "x")]);
  await flush();
  timers.tick(16);
  await flush();
  expect(got?.frame.case).toBe("delta");
  take();
  await flush();
  timers.tick(14_999);
  await flush();
  expect(got).toBeUndefined();
  timers.tick(1);
  await flush();
  expect(got?.frame).toMatchObject({ case: "heartbeat", value: { cursor: { seq: 3n } } });
});

test("a subscriber that never reads gets MustRefetch after 1,000 frames and the stream ends", async () => {
  const store = new Store();
  const r = reader(store);
  await r.next(); // snapshot, then the consumer stops reading
  expect(store.subscribers).toBe(1);
  for (let i = 0; i < 1000; i++) store.commit([task(`t${i}`)]);
  for (let i = 1000; i < 1500; i++) store.commit([task(`t${i}`)]); // the 1,001st frame overflowed it
  const f = await r.next();
  expect(f?.frame).toMatchObject({ case: "mustRefetch" });
  expect(await r.next()).toBeUndefined();
  expect(store.subscribers).toBe(0);
});

test("1,000 queued frames are fine; the queue holds at most 4 MB", async () => {
  const store = new Store({ coalesceMs: 0 });
  const r = reader(store);
  await r.next();
  for (let i = 0; i < 1000; i++) store.commit([task(`t${i}`)]);
  const f = await r.next();
  expect(f?.frame.case === "delta" && f.frame.value.changes.length).toBe(1000);

  const big = new Store({ coalesceMs: 0 });
  const slow = reader(big);
  await slow.next();
  const title = "x".repeat(1024 * 1024);
  for (let i = 0; i < 3; i++) big.commit([task(`t${i}`, title)]);
  expect((await slow.next())?.frame.case).toBe("delta"); // 3 MB: held
  for (let i = 0; i < 5; i++) big.commit([task(`u${i}`, title)]); // over 4 MB before it reads
  expect((await slow.next())?.frame.case).toBe("mustRefetch");
});

test("commit cost does not grow with subscribers that stopped reading", () => {
  const store = new Store();
  const stalled = Array.from({ length: 50 }, () => reader(store));
  return (async () => {
    for (const r of stalled) await r.next();
    for (let i = 0; i < 1100; i++) store.commit([task(`t${i}`)]); // every one of them overflows
    const t0 = performance.now();
    for (let i = 0; i < 20_000; i++) store.commit([task(`u${i % 100}`, `v${i}`)]);
    // Overflowed subscribers drop their queue and ignore offers: 20,000 commits stay far under the
    // time 50 live queues of growing arrays would take.
    expect(performance.now() - t0).toBeLessThan(1500);
    for (const r of stalled) expect((await r.next())?.frame.case).toBe("mustRefetch");
  })();
});

test("aborting the signal removes the subscriber and leaves no timer", async () => {
  const timers = new FakeTimers();
  const store = new Store({ timers });
  const ac = new AbortController();
  const r = reader(store, repoScope, undefined, ac.signal);
  await r.next();
  const pending = r.next();
  await flush();
  expect(store.subscribers).toBe(1);
  expect(timers.count).toBe(1);
  ac.abort();
  expect((await pending)).toBeUndefined();
  expect(store.subscribers).toBe(0);
  expect(timers.count).toBe(0);
  // Aborted before it is read at all.
  const early = new AbortController();
  early.abort();
  const e = reader(store, repoScope, undefined, early.signal);
  await e.next();
  expect(await e.next()).toBeUndefined();
  expect(store.subscribers).toBe(0);
});

test("property: replicas equal the store after random commits, drops, resumes and overflow", async () => {
  let resumed = 0;
  let refetches = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const r = rng(seed);
    const store = new Store({ ringSize: 40, queueFrames: 60, snapshotChunk: 7, coalesceMs: 0, heartbeatMs: 2 });
    const slugs = ["a", "b", "c", "d", "e"];
    const repo = new Replica();
    const tA = new Replica();
    let subRepo = follow(store, repo);
    let subA = follow(store, tA, taskScope("a"));
    for (let i = 0; i < 400; i++) {
      const slug = slugs[Math.floor(r() * slugs.length)];
      const n = Math.floor(r() * 4);
      const puts: Entity[] = Array.from({ length: n }, () =>
        r() < 0.5 ? task(slug, `t${Math.floor(r() * 5)}`) : session(slug, `s${Math.floor(r() * 3)}`, r() < 0.5 ? "live" : "exited"),
      );
      const dels = r() < 0.15 ? [`session/${slug}/s${Math.floor(r() * 3)}`] : [];
      if (r() < 0.05) for (let k = 0; k < 80; k++) store.commit([task(slug, `burst${k}`, `b${k}`)]); // overflows a queue
      else store.commit(puts, dels);
      if (r() < 0.3) await Bun.sleep(0);
      if (r() < 0.05) {
        // Drop the repo stream and resume from its cursor.
        await subRepo.stop();
        if (repo.cursor?.epoch === store.epoch) resumed++;
        subRepo = follow(store, repo);
      }
      if ((await running(subRepo)) === "refetch") {
        refetches++;
        subRepo = follow(store, repo);
      }
      if ((await running(subA)) === "refetch") {
        refetches++;
        subA = follow(store, tA, taskScope("a"));
      }
    }
    for (const [sub, rep, scope, again] of [
      [subRepo, repo, repoScope, (s: ReturnType<typeof follow>) => (subRepo = s)],
      [subA, tA, taskScope("a"), (s: ReturnType<typeof follow>) => (subA = s)],
    ] as const) {
      let s = sub;
      if ((await running(s)) === "refetch") again((s = follow(store, rep, scope)));
      await settled(rep, store);
      await s.stop();
      same(rep.rows, expected(store, scope));
      expect(rep.cursor?.seq).toBe(store.seq);
    }
  }
  expect(refetches).toBeGreaterThan(0); // the queue limit was exercised
  expect(resumed).toBeGreaterThan(0); // and so was resuming from a cursor
});
