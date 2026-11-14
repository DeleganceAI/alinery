// O1 (b) spike: @grpc/grpc-js served on a unix socket under Bun, with protobuf-es messages and
// Connect-shaped handlers (grpc-adapter.ts).
// Usage: bun src/grpc-server.ts <socket> [shell executable, default: this runtime]
// Hello's build_id carries the same stats JSON as rpc-server.ts, so rpc-bench.ts (http2 mode)
// and idle-streams.ts read them unchanged.
import { timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { Code, ConnectError, createContextKey, createContextValues, type ServiceImpl } from "@connectrpc/connect";
import * as grpc from "@grpc/grpc-js";
import { AdminService } from "../gen/alinery/v1/admin_pb";
import { ErrorDetailSchema } from "../gen/alinery/v1/common_pb";
import { SpikeService } from "../gen/alinery/v1/spike_pb";
import { addService } from "./grpc-adapter";
import { peerExecutable } from "./peer";

const SECRET = Buffer.from("spike-secret-0123456789abcdef");
const TIER = createContextKey<"shell" | "other">("other", { description: "peer tier" });
let aborted = 0;
let open = 0;
let abortEvents = 0;

export const spike: ServiceImpl<typeof SpikeService> = {
  echo: (req) => ({ data: req.data }),
  async *ticks(req, ctx) {
    if (req.size > 1 << 20) throw new ConnectError("frame too large", Code.ResourceExhausted);
    open++;
    ctx.signal.addEventListener("abort", () => abortEvents++);
    const data = new Uint8Array(req.size);
    try {
      for (let i = 0; !ctx.signal.aborted; i++) {
        yield { seq: BigInt(i), data };
        // Race the sleep against the signal, or an idle stream holds its handler until it wakes.
        if (req.intervalMs) await Promise.race([Bun.sleep(req.intervalMs), new Promise((r) => ctx.signal.addEventListener("abort", r))]);
      }
    } finally {
      open--;
      if (ctx.signal.aborted) aborted++;
    }
  },
};

export const admin: Partial<ServiceImpl<typeof AdminService>> = {
  hello: (_req, ctx) => ({
    protocol: 25,
    buildId: JSON.stringify({ rss: process.memoryUsage().rss, aborted, abortEvents, open, peer: ctx.values.get(TIER), mode: "grpc-js", bun: Bun.version }),
  }),
  // Always refuses, with an ErrorDetail, so the bridge test can check details survive gRPC-web.
  shutdown: () => {
    throw new ConnectError("origin is required", Code.InvalidArgument, undefined, [
      { desc: ErrorDetailSchema, value: { code: "shutdown_origin_missing", message: "origin is required" } },
    ]);
  },
};

// A handler can't see its connection's fd, so the peer check runs at accept and picks the server:
// connections from the shell executable go to `shell`, every other peer to `other`.
function makeServer(tier: "shell" | "other") {
  const server = new grpc.Server();
  const values = (header: Headers) => {
    const got = Buffer.from((header.get("authorization") ?? "").replace(/^Bearer /, ""));
    if (got.length !== SECRET.length || !timingSafeEqual(got, SECRET)) throw new ConnectError("missing or wrong token", Code.Unauthenticated);
    return createContextValues().set(TIER, tier);
  };
  addService(server, SpikeService, spike, values);
  addService(server, AdminService, admin, values);
  return server.createConnectionInjector(grpc.ServerCredentials.createInsecure());
}

if (import.meta.main) {
  const [socketPath, shellExe = process.execPath] = process.argv.slice(2);
  const shell = makeServer("shell");
  const other = makeServer("other");
  rmSync(socketPath, { force: true });
  createNetServer((sock) => (peerExecutable(sock) === shellExe ? shell : other).injectConnection(sock)).listen(socketPath, () =>
    console.log(`listening grpc-js ${socketPath} pid ${process.pid} shell ${shellExe}`),
  );
}
