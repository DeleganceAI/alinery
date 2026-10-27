import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { AdminService } from "../gen/alinery/v1/admin_pb";
import { SpikeService } from "../gen/alinery/v1/spike_pb";
import { bridgeFetch, encodeFrames, fakeShell, splitFrames, BODY, PAD_TO } from "./bridge-fetch";

const dir = mkdtempSync(join(tmpdir(), "bridge-"));
const sock = join(dir, "rpc.sock");
let server: ReturnType<typeof Bun.spawn>;
beforeAll(async () => {
  server = Bun.spawn(["bun", join(import.meta.dir, "rpc-server.ts"), sock, "http1"], { stdout: "pipe", stderr: "inherit", onExit: (_p, code, sig) => console.log("SERVER EXIT", code, sig) });
  const reader = server.stdout.getReader();
  await reader.read(); // "listening ..."
  reader.releaseLock();
});
afterAll(() => server.kill());

function clients(token = "spike-secret-0123456789abcdef") {
  const shell = fakeShell(sock, token);
  const transport = createConnectTransport({ baseUrl: "http://daemon", useBinaryFormat: true, fetch: bridgeFetch(shell.daemonRpc, shell.cancel) });
  return { admin: createClient(AdminService, transport), spike: createClient(SpikeService, transport) };
}

test("frames pad to 1 KiB and round-trip", () => {
  const msg = encodeFrames([{ kind: BODY, payload: new Uint8Array([1, 2, 3]) }]);
  expect(msg.length).toBe(PAD_TO);
  expect([...splitFrames(msg)].map((f) => [...f.payload])).toEqual([[1, 2, 3]]);
});

test("unary through the bridge", async () => {
  const r = await clients().admin.hello({});
  expect(r.protocol).toBe(25);
});

test("errors keep their Connect code through the bridge", async () => {
  const e = await clients("nope-nope-nope-nope-nope-nope").admin.hello({}).catch((x) => ConnectError.from(x));
  expect((e as ConnectError).code).toBe(Code.Unauthenticated);
});

test("server stream of 100 frames", async () => {
  let n = 0;
  const ac = new AbortController();
  const e = await (async () => {
    for await (const m of clients().spike.ticks({ size: 3000 }, { signal: ac.signal })) {
      expect(m.seq).toBe(BigInt(n));
      if (++n === 100) ac.abort();
    }
  })().catch((x) => ConnectError.from(x));
  expect(n).toBe(100);
  expect((e as ConnectError).code).toBe(Code.Canceled);
}, 10_000);

test("cancel mid-stream reaches the server", async () => {
  const { admin, spike } = clients();
  const before = JSON.parse((await admin.hello({})).buildId).abortEvents;
  const ac = new AbortController();
  const run = (async () => { try { for await (const _ of spike.ticks({ size: 16, intervalMs: 15000 }, { signal: ac.signal })); } catch {} })();
  await Bun.sleep(200);
  ac.abort();
  await run;
  await Bun.sleep(200);
  expect(JSON.parse((await admin.hello({})).buildId).abortEvents).toBe(before + 1);
});

test("latency: bridge vs direct, 500 unary calls", async () => {
  const { spike } = clients();
  const data = new Uint8Array(100);
  for (let i = 0; i < 50; i++) await spike.echo({ data });
  const t: number[] = [];
  for (let i = 0; i < 500; i++) { const t0 = performance.now(); await spike.echo({ data }); t.push(performance.now() - t0); }
  t.sort((a, b) => a - b);
  console.log(`bridge (fetch stand-in) unary p50 ${t[250].toFixed(3)} ms p99 ${t[495].toFixed(3)} ms`);
});
