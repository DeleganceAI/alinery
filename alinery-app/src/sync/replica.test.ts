import { createClient } from "@connectrpc/connect";
import { SyncService } from "alinery-proto/alinery/v1/sync_pb";
import { expect, it, vi } from "vitest";
import { cursor, daemonHarness, entity, put, scriptedSync, snapshot } from "../test/daemonHarness";
import { Replica, runReplica } from "./replica";

const task = (slug: string) => entity(`task/${slug}`, { case: "task", value: { slug, name: slug } as never });
const wait = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
};
const instant = async () => {};

function start(replica: Replica, h: ReturnType<typeof scriptedSync>) {
  const client = createClient(SyncService, daemonHarness({ sync: h.sync }).transport);
  return runReplica(replica, (cur, signal) => client.subscribe({ cursor: cur }, { signal }), instant);
}

it("a snapshot then a delta builds the rows and wakes listeners", async () => {
  const h = scriptedSync(async function* () {
    yield snapshot([task("a")], 1);
    yield put(task("b"), 2);
    await new Promise(() => {}); // stay open
  });
  const r = new Replica();
  const seen = vi.fn();
  r.listen(seen);
  const stop = start(r, h);
  await wait(() => r.get("task/b") !== undefined);
  expect(
    r
      .all()
      .map((e) => e.key)
      .sort(),
  ).toEqual(["task/a", "task/b"]);
  expect(r.reachable).toBe(true);
  expect(seen).toHaveBeenCalled();
  stop();
});

it("a dropped stream sets stale, keeps the last rows, and resubscribes with the last cursor", async () => {
  const h = scriptedSync(async function* (_req, call) {
    if (call === 0) {
      yield snapshot([task("a")], 7);
      throw new Error("link dropped");
    }
    await new Promise(() => {});
  });
  const r = new Replica();
  const stop = start(r, h);
  await wait(() => h.requests.length >= 2);
  expect(h.requests[0].cursor).toBeUndefined();
  expect(h.requests[1].cursor?.seq).toBe(7n);
  expect(h.requests[1].cursor?.epoch).toBe("e1");
  expect(r.get("task/a")).toBeDefined();
  stop();

  // While the second attempt has no frame yet, the replica is stale and still readable.
  const down = new Replica();
  down.apply(snapshot([task("x")], 1));
  down.setLink(true);
  down.setLink(false);
  expect([down.stale, down.reachable, down.get("task/x") !== undefined]).toEqual([true, false, true]);
});

it("must_refetch clears the cursor and the next subscribe asks for a snapshot", async () => {
  const h = scriptedSync(async function* (_req, call) {
    if (call === 0) {
      yield snapshot([task("a")], 3);
      yield { frame: { case: "mustRefetch", value: { reason: "ring" } } } as never;
    } else {
      yield snapshot([task("z")], 9);
      await new Promise(() => {});
    }
  });
  const r = new Replica();
  const stop = start(r, h);
  await wait(() => r.get("task/z") !== undefined);
  expect(h.requests[1].cursor).toBeUndefined();
  expect(r.get("task/a")).toBeUndefined(); // the new snapshot replaced the rows
  stop();
});

it("backs off 0.5, 1, 2, 5, 5 s while the stream keeps failing", async () => {
  const delays: number[] = [];
  // biome-ignore lint/correctness/useYield: a stream that fails before any frame
  const h = scriptedSync(async function* () {
    throw new Error("down");
  });
  const client = createClient(SyncService, daemonHarness({ sync: h.sync }).transport);
  const stop = runReplica(
    new Replica(),
    (cur, signal) => client.subscribe({ cursor: cur }, { signal }),
    async (ms) => {
      delays.push(ms);
      await new Promise((r) => setTimeout(r, 1));
    },
  );
  await wait(() => delays.length >= 6);
  stop();
  expect(delays.slice(0, 6)).toEqual([500, 1000, 2000, 5000, 5000, 5000]);
});

it("a snapshot cut off by a dropped stream is discarded, not mixed into the next one", () => {
  const r = new Replica();
  r.apply(snapshot([task("a")], 1));
  r.apply({ frame: { case: "snapshot", value: { entities: [task("half")], complete: false } } } as never);
  r.setLink(false);
  r.apply({ frame: { case: "snapshot", value: { entities: [task("b")], cursor: cursor(5), complete: true } } } as never);
  expect(r.all().map((e) => e.key)).toEqual(["task/b"]);
});
