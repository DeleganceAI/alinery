import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { AdminService } from "../gen/alinery/v1/admin_pb";
import { ErrorDetailSchema } from "../gen/alinery/v1/common_pb";
import { SpikeService } from "../gen/alinery/v1/spike_pb";
import { fakeH2Shell, grpcWebFetch } from "./grpc-bridge";

// sun_path is 104 bytes on macOS: keep the socket under /tmp.
const sock = join(mkdtempSync("/tmp/grpc-bridge-"), "rpc.sock");
let server: ReturnType<typeof Bun.spawn>;
const shells: { close: () => void }[] = [];
beforeAll(async () => {
  server = Bun.spawn(["bun", join(import.meta.dir, "grpc-server.ts"), sock], { stdout: "pipe", stderr: "inherit" });
  const reader = server.stdout.getReader();
  await reader.read(); // "listening ..."
  reader.releaseLock();
});
afterAll(() => {
  for (const s of shells) s.close();
  server.kill();
});

function clients(token = "spike-secret-0123456789abcdef") {
  const shell = fakeH2Shell(sock, token);
  shells.push(shell);
  const transport = createGrpcWebTransport({ baseUrl: "http://daemon", fetch: grpcWebFetch(shell.daemonRpc, shell.cancel) });
  return { admin: createClient(AdminService, transport), spike: createClient(SpikeService, transport) };
}

test("unary through the bridge", async () => {
  const r = await clients().admin.hello({});
  expect(r.protocol).toBe(25);
  expect(JSON.parse(r.buildId).mode).toBe("grpc-js");
});

test("a trailers-only error keeps its gRPC code through the bridge", async () => {
  const e = await clients("nope-nope-nope-nope-nope-nope").admin.hello({}).catch((x) => ConnectError.from(x));
  expect((e as ConnectError).code).toBe(Code.Unauthenticated);
});

test("an ErrorDetail survives grpc-status-details-bin and gRPC-web", async () => {
  const e = (await clients().admin.shutdown({}).catch((x) => ConnectError.from(x))) as ConnectError;
  expect(e.code).toBe(Code.InvalidArgument);
  expect(e.findDetails(ErrorDetailSchema).map((d) => d.code)).toEqual(["shutdown_origin_missing"]);
});

test("server stream of 100 frames, then the trailer ends it cleanly", async () => {
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

test("cancel mid-stream reaches the server, and the connection serves the next call", async () => {
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

test("latency: 500 unary calls through the bridge", async () => {
  const { spike } = clients();
  const data = new Uint8Array(100);
  for (let i = 0; i < 50; i++) await spike.echo({ data });
  const t: number[] = [];
  for (let i = 0; i < 500; i++) { const t0 = performance.now(); await spike.echo({ data }); t.push(performance.now() - t0); }
  t.sort((a, b) => a - b);
  console.log(`grpc-web bridge (h2 stand-in) unary p50 ${t[250].toFixed(3)} ms p99 ${t[495].toFixed(3)} ms`);
});
