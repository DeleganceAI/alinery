// S0.2 spike: Connect-ES served by node:http (or node:http2) on a unix socket under Bun.
// Usage: bun src/rpc-server.ts <socket> [http1|http2]
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createH2Server } from "node:http2";
import { rmSync } from "node:fs";
import { createServer as createNetServer, type Socket } from "node:net";
import { Code, ConnectError, createContextKey, createContextValues, type ConnectRouter, type Interceptor } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { AdminService } from "../gen/alinery/v1/admin_pb";
import { SpikeService } from "../gen/alinery/v1/spike_pb";
import { peerExecutable } from "./peer";

const [socketPath, mode = "http1"] = process.argv.slice(2);
const SECRET = Buffer.from("spike-secret-0123456789abcdef");
const PEER = createContextKey<string | null>(null, { description: "peer executable" });
let aborted = 0;
let open = 0;
let abortEvents = 0;

// Capabilities need the token (header) and the peer (socket). The interceptor sees only the
// header; contextValues sees the node request, so the peer is read there and handed over.
const auth: Interceptor = (next) => async (req) => {
  const got = Buffer.from((req.header.get("authorization") ?? "").replace(/^Bearer /, ""));
  if (got.length !== SECRET.length || !timingSafeEqual(got, SECRET)) {
    throw new ConnectError("missing or wrong token", Code.Unauthenticated);
  }
  return next(req);
};

const routes = (router: ConnectRouter) => {
  router.service(SpikeService, {
    echo: (req) => ({ data: req.data }),
    async *ticks(req, ctx) {
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
  });
  router.service(AdminService, {
    hello: (_req, ctx) => ({
      protocol: 25,
      // build_id carries spike stats so the client can read them without another service
      buildId: JSON.stringify({ rss: process.memoryUsage().rss, aborted, abortEvents, open, peer: ctx.values.get(PEER), mode, bun: Bun.version }),
    }),
  });
};

const handler = connectNodeAdapter({
  routes,
  interceptors: [auth],
  contextValues: (req) => createContextValues().set(PEER, peerExecutable(req.socket as Socket)),
});

rmSync(socketPath, { force: true });
const server = mode === "http2" ? createH2Server(handler) : createServer(handler);
// Bun's node:http hides the socket fd (req.socket._handle has none), so the peer check would
// always fail. A node:net listener keeps the fd, and handing each socket to the HTTP server
// keeps it on req.socket.
createNetServer((sock) => server.emit("connection", sock)).listen(socketPath, () =>
  console.log(`listening ${mode} ${socketPath} pid ${process.pid}`),
);
