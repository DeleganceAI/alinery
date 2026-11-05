import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { SyncService } from "alinery-proto/alinery/v1/sync_pb";
import { repoScope, task } from "../sync/testkit.ts";
import { Store } from "../sync/store.ts";
import { serveRpc } from "./server.ts";

const SECRET = "cd".repeat(32);
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

async function start(store: Store) {
  const dir = mkdtempSync("/tmp/rpc-s-");
  const socketPath = join(dir, "rpc.sock");
  const info = { protocol: 25, buildId: "b", repoRoot: "/repo", appConfigIdentity: "i" };
  const net = await serveRpc({ socketPath, secret: Buffer.from(SECRET), hostExecutable: process.execPath, info, lifecycle: { stop: () => 0, exit: () => {} }, store });
  cleanup.push(() => {
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const transport = (header?: string) =>
    createGrpcTransport({
      baseUrl: "http://daemon",
      nodeOptions: { createConnection: () => connect(socketPath) } as never,
      interceptors: [(next) => (req) => (header ? (req.header.set("authorization", header), next(req)) : next(req))],
    });
  return (header: string | undefined = `Bearer ${SECRET}`) => createClient(SyncService, transport(header));
}

test("Subscribe on the repo scope: a complete snapshot, then live deltas and a heartbeat", async () => {
  const store = new Store({ heartbeatMs: 50, coalesceMs: 1 });
  store.commit([task("a", "A"), task("b", "B")]);
  const client = (await start(store))();
  const ac = new AbortController();
  const frames = client.subscribe({ scope: repoScope }, { signal: ac.signal })[Symbol.asyncIterator]();
  const first = (await frames.next()).value!;
  expect(first.frame.case === "snapshot" && first.frame.value.complete).toBe(true);
  expect(first.frame.case === "snapshot" && first.frame.value.entities.map((e) => e.key).sort()).toEqual(["task/a/a", "task/b/b"]);
  expect(first.frame.case === "snapshot" && first.frame.value.cursor).toMatchObject({ epoch: store.epoch, seq: 1n });
  store.commit([task("c", "C")]);
  const delta = (await frames.next()).value!;
  expect(delta.frame.case === "delta" && delta.frame.value.changes.map((c) => c.op.case === "put" && c.op.value.key)).toEqual(["task/c/c"]);
  const beat = (await frames.next()).value!;
  expect(beat.frame).toMatchObject({ case: "heartbeat", value: { cursor: { seq: 2n } } });
  ac.abort();
});

test("a client cancel removes the subscriber; no stream is left behind", async () => {
  const store = new Store({ heartbeatMs: 10_000 });
  const client = (await start(store))();
  const ac = new AbortController();
  const frames = client.subscribe({ scope: repoScope }, { signal: ac.signal })[Symbol.asyncIterator]();
  await frames.next();
  expect(store.subscribers).toBe(1);
  ac.abort();
  for (let i = 0; i < 100 && store.subscribers; i++) await Bun.sleep(10);
  expect(store.subscribers).toBe(0);
});

test("a resumed cursor over the wire gets the missed deltas then UpToDate", async () => {
  const store = new Store({ heartbeatMs: 10_000 });
  store.commit([task("a")]);
  store.commit([task("b")]);
  const client = (await start(store))();
  const ac = new AbortController();
  const frames = client.subscribe({ scope: repoScope, cursor: { epoch: store.epoch, seq: 1n } }, { signal: ac.signal })[Symbol.asyncIterator]();
  const delta = (await frames.next()).value!;
  expect(delta.frame.case === "delta" && delta.frame.value.changes.length).toBe(1);
  expect((await frames.next()).value!.frame.case).toBe("upToDate");
  ac.abort();
});

test("no token is PERMISSION_DENIED, a wrong token is UNAUTHENTICATED, and an unset scope is INVALID_ARGUMENT", async () => {
  const connectTo = await start(new Store());
  const code = async (c: ReturnType<typeof connectTo>, req = { scope: repoScope }) =>
    ConnectError.from(await (async () => { for await (const _ of c.subscribe(req)) return null; return null; })().catch((e) => e)).code;
  expect(await code(connectTo("Bearer wrong"))).toBe(Code.Unauthenticated);
  expect(await code(connectTo(""))).toBe(Code.PermissionDenied);
  expect(await code(connectTo(), {} as never)).toBe(Code.InvalidArgument);
});
