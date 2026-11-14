import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { AdminService } from "../gen/alinery/v1/admin_pb";
import { SpikeService } from "../gen/alinery/v1/spike_pb";
import { admin, spike } from "./grpc-server";

const sock = join(mkdtempSync("/tmp/grpc-adapter-"), "rpc.sock");
let server: ReturnType<typeof Bun.spawn>;
beforeAll(async () => {
  server = Bun.spawn(["bun", join(import.meta.dir, "grpc-server.ts"), sock], { stdout: "pipe", stderr: "inherit" });
  const reader = server.stdout.getReader();
  await reader.read();
  reader.releaseLock();
});
afterAll(() => server.kill());

test("the same handler objects serve in memory (T7), with no socket", async () => {
  const t = createRouterTransport((r) => { r.service(SpikeService, spike); r.service(AdminService, admin); });
  expect((await createClient(SpikeService, t).echo({ data: new Uint8Array([1, 2]) })).data).toEqual(new Uint8Array([1, 2]));
  expect((await createClient(AdminService, t).hello({})).protocol).toBe(25);
});

test("an error thrown by a server stream reaches the client with its code", async () => {
  const t = createGrpcTransport({ baseUrl: "http://daemon", nodeOptions: { createConnection: () => connect(sock) } as never,
    interceptors: [(next) => (req) => { req.header.set("authorization", "Bearer spike-secret-0123456789abcdef"); return next(req); }] });
  const e = await (async () => { for await (const _ of createClient(SpikeService, t).ticks({ size: 2 << 20 })); })().catch((x) => ConnectError.from(x));
  expect((e as ConnectError).code).toBe(Code.ResourceExhausted);
});
