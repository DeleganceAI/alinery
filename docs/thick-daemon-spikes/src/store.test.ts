import { expect, test } from "bun:test";
import { create, equals, toBinary } from "@bufbuild/protobuf";
import { EntitySchema, type Entity } from "../gen/alinery/v1/entities_pb";
import { ScopeSchema, SubscribeResponseSchema } from "../gen/alinery/v1/sync_pb";
import { Replica, Store, inScope } from "./store";

// Seeded RNG so a failure replays.
function rng(seed: number) { return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32); }

const task = (slug: string, title: string, archived = false): Entity =>
  create(EntitySchema, { key: `task/${slug}/${slug}`, value: { case: "task", value: { slug, title, archived } } });
const session = (slug: string, id: string, status: string): Entity =>
  create(EntitySchema, { key: `session/${slug}/${id}`, value: { case: "session", value: { ref: { taskSlug: slug, id }, status } } });

const repoScope = create(ScopeSchema, { kind: { case: "repo", value: {} } });
const taskScope = (slug: string) => create(ScopeSchema, { kind: { case: "task", value: { slug } } });

function expected(store: Store, scope = repoScope) {
  return new Map([...store.rows].filter(([k]) => inScope(scope, k)));
}
function same(a: Map<string, Entity>, b: Map<string, Entity>) {
  expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  for (const [k, v] of a) expect(equals(EntitySchema, v, b.get(k)!)).toBe(true);
}

// Drives one subscription: applies frames to the replica until `until` says stop, then aborts.
async function follow(store: Store, replica: Replica, scope = repoScope) {
  const ac = new AbortController();
  const done = (async () => {
    for await (const f of store.open(scope, replica.cursor, ac.signal)) if (replica.apply(f) === "refetch") return "refetch";
    return "aborted";
  })();
  return { stop: async () => { ac.abort(); return done; }, done };
}

test("equals ignores nothing but what we zero: oneof case and fields both count", () => {
  const a = task("a", "A"), b = task("a", "A");
  expect(equals(EntitySchema, a, b)).toBe(true);
  expect(equals(EntitySchema, a, task("a", "B"))).toBe(false);
  const s = create(EntitySchema, { key: a.key, value: { case: "session", value: {} } });
  expect(equals(EntitySchema, a, s)).toBe(false);
  expect(equals(EntitySchema, { ...a, revision: 0n }, { ...b, revision: 7n })).toBe(false);
  expect(equals(EntitySchema, { ...a, revision: 0n }, { ...b, revision: 0n })).toBe(true);
});

test("an unchanged put takes no seq and sends nothing", () => {
  const store = new Store({ coalesceMs: 0 });
  expect(store.commit([task("a", "A")])).toBe(1n);
  expect(store.commit([task("a", "A")])).toBe(1n);
  expect(store.commit([], ["task/missing/missing"])).toBe(1n);
});

test("property: replicas equal the store after random commits, drops, resumes and overflow", async () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = rng(seed);
    const store = new Store({ ringSize: 40, queueLimit: 60, snapshotChunk: 7, coalesceMs: 0, heartbeatMs: 2 });
    const slugs = ["a", "b", "c", "d", "e"];
    const repo = new Replica(), tA = new Replica();
    let subRepo = await follow(store, repo), subA = await follow(store, tA, taskScope("a"));
    let refetches = 0;
    for (let i = 0; i < 400; i++) {
      const slug = slugs[Math.floor(r() * slugs.length)];
      const n = Math.floor(r() * 4);
      const puts = Array.from({ length: n }, () => (r() < 0.5 ? task(slug, `t${Math.floor(r() * 5)}`, r() < 0.2) : session(slug, `s${Math.floor(r() * 3)}`, r() < 0.5 ? "live" : "exited")));
      const dels = r() < 0.15 ? [`session/${slug}/s${Math.floor(r() * 3)}`] : [];
      if (r() < 0.05) for (let k = 0; k < 80; k++) store.commit([task(slug, `burst${k}`)]); // overflow a queue
      else store.commit(puts, dels);
      if (r() < 0.3) await Bun.sleep(0);
      if (r() < 0.05) { // drop the repo stream and resume from its cursor (or refetch)
        await subRepo.stop();
        subRepo = await follow(store, repo);
      }
      for (const [sub, rep, scope, set] of [[subRepo, repo, repoScope, (s: typeof subRepo) => (subRepo = s)], [subA, tA, taskScope("a"), (s: typeof subA) => (subA = s)]] as const) {
        if ((await Promise.race([sub.done, Promise.resolve("running")])) === "refetch") { refetches++; set(await follow(store, rep, scope)); }
      }
    }
    await Bun.sleep(5);
    for (const [sub, rep, scope] of [[subRepo, repo, repoScope], [subA, tA, taskScope("a")]] as const) {
      if ((await Promise.race([sub.done, Promise.resolve("running")])) === "refetch") { const s = await follow(store, rep, scope); await Bun.sleep(5); await s.stop(); }
      else await sub.stop();
      same(rep.rows, expected(store, scope));
      expect(rep.cursor?.seq).toBe(store.seq);
    }
    expect(refetches).toBeGreaterThan(0); // the ring and queue limits were exercised
  }
});

test("fan-out cost: one put to N repo subscribers", async () => {
  for (const n of [1, 10, 100]) {
    const store = new Store({ coalesceMs: 0, queueLimit: 1e9, ringSize: 1e6 });
    const subs = await Promise.all(Array.from({ length: n }, () => follow(store, new Replica())));
    await Bun.sleep(1);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) store.commit([task(`t${i % 50}`, `title ${i}`)]);
    const commitUs = ((performance.now() - t0) / 1000) * 1000;
    const t1 = performance.now();
    await Bun.sleep(0);
    await Bun.sleep(0);
    const drainMs = performance.now() - t1;
    await Promise.all(subs.map((s) => s.stop()));
    console.log(`subscribers ${n}: commit ${commitUs.toFixed(1)} us, drain ${drainMs.toFixed(1)} ms for 1000 commits`);
  }
  const e = task("some-task-slug", "A task title of ordinary length");
  const f = create(SubscribeResponseSchema, { frame: { case: "delta", value: { changes: [{ op: { case: "put", value: e } }] } } });
  console.log(`one-task delta frame: ${toBinary(SubscribeResponseSchema, f).length} bytes`);
});
