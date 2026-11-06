// O1 (b) + O2 (a) sample: the webview's stock connect-web gRPC-web client reaches the grpc-js
// daemon through the bridge. The shell forwards HTTP/2 (headers, body, trailers) and knows no
// gRPC; the two gRPC-web differences live here: the content type, and trailers in the body
// (bridge-fetch.ts turns a TRAILERS frame into the gRPC-web trailer frame).
// `fakeH2Shell` stands in for the Rust daemon_rpc command: one HTTP/2 connection per daemon,
// one stream per call, cancel is RST_STREAM.
import { connect as http2Connect, constants, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import { connect } from "node:net";
import { BODY, END, HEAD, TRAILERS, bridgeFetch, encodeFrames, type DaemonRpc, type DaemonRpcCancel } from "./bridge-fetch";

const enc = new TextEncoder();

export function grpcWebFetch(daemonRpc: DaemonRpc, cancel: DaemonRpcCancel): typeof fetch {
  const inner = bridgeFetch(daemonRpc, cancel);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    h.set("content-type", (h.get("content-type") ?? "").replace("application/grpc-web", "application/grpc"));
    h.delete("x-grpc-web");
    h.delete("x-user-agent");
    const res = await inner(input, { ...init, headers: h });
    const rh = new Headers(res.headers);
    rh.set("content-type", (rh.get("content-type") ?? "application/grpc").replace(/^application\/grpc(\+proto)?/, "application/grpc-web+proto"));
    return new Response(res.body, { status: res.status, headers: rh });
  }) as typeof fetch;
}

export function fakeH2Shell(socketPath: string, token: string): { daemonRpc: DaemonRpc; cancel: DaemonRpcCancel; close: () => void } {
  let session: ClientHttp2Session | undefined;
  const live = () => {
    if (!session || session.closed || session.destroyed) session = http2Connect("http://daemon", { createConnection: () => connect(socketPath) });
    return session;
  };
  const calls = new Map<string, ClientHttp2Stream>();
  const frame = (kind: number, payload: Uint8Array) => encodeFrames([{ kind, payload }]);
  return {
    close: () => session?.close(),
    // Forget the call before the RST_STREAM: the shell sends nothing more for a cancelled call.
    cancel: (id) => {
      const req = calls.get(id);
      calls.delete(id);
      req?.close(constants.NGHTTP2_CANCEL);
    },
    daemonRpc: (id, path, headers, body, onMessage) =>
      new Promise((resolve) => {
        const req = live().request({
          ...Object.fromEntries(headers),
          ":method": "POST",
          ":path": path,
          te: "trailers",
          authorization: `Bearer ${token}`,
        });
        calls.set(id, req);
        const done = (err = "") => {
          if (calls.delete(id)) onMessage(frame(END, enc.encode(err)));
          resolve();
        };
        const pairs = (h: Record<string, unknown>) =>
          Object.entries(h).filter(([k]) => !k.startsWith(":")).map(([k, v]) => [k, String(v)] as [string, string]);
        req.on("response", (h) => onMessage(frame(HEAD, enc.encode(JSON.stringify({ status: Number(h[":status"]), headers: pairs(h) })))));
        req.on("data", (chunk: Buffer) => onMessage(frame(BODY, new Uint8Array(chunk))));
        req.on("trailers", (h) => onMessage(frame(TRAILERS, enc.encode(JSON.stringify(pairs(h))))));
        req.on("end", () => done());
        req.on("close", () => done());
        req.on("error", (e) => done(String(e)));
        req.end(body);
      }),
  };
}
