// The webview half of the daemon bridge (plan 2.1.9). `bridgeFetch` turns the frames the shell
// sends on a Channel into a fetch `Response`, so a stock connect-web client works unchanged;
// `grpcWebFetch` adds the two gRPC-web differences. It imports nothing from Tauri:
// the one native call is `daemonRpc`, which `ipc.ts` provides.

export const HEAD = 1;
export const BODY = 2;
export const END = 3;
// HTTP/2 trailers, as a JSON array of [name, value]; turned into a gRPC-web trailer frame below.
export const TRAILERS = 4;

// Frames in one Channel message: [u32 LE len][u8 kind][payload], then zero padding; len 0 ends it.
export function* splitFrames(msg: Uint8Array): Generator<{ kind: number; payload: Uint8Array }> {
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  for (let at = 0; at + 4 <= msg.length; ) {
    const len = view.getUint32(at, true);
    if (len === 0) return;
    yield { kind: msg[at + 4], payload: msg.subarray(at + 5, at + 4 + len) };
    at += 4 + len;
  }
}

export type DaemonRpc = (callId: string, path: string, headers: [string, string][], body: Uint8Array, onMessage: (msg: Uint8Array) => void) => Promise<void>;
export type DaemonRpcCancel = (callId: string) => void;

const text = new TextDecoder();
const enc = new TextEncoder();

// gRPC-web carries trailers in the body: flag 0x80, u32 BE length, then "name: value\r\n" lines.
export function grpcWebTrailer(pairs: [string, string][]): Uint8Array {
  const block = enc.encode(pairs.map(([k, v]) => `${k}: ${v}\r\n`).join(""));
  const out = new Uint8Array(5 + block.length);
  out[0] = 0x80;
  new DataView(out.buffer).setUint32(1, block.length, false);
  out.set(block, 5);
  return out;
}

export function bridgeFetch(daemonRpc: DaemonRpc, cancelRpc: DaemonRpcCancel): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const callId = crypto.randomUUID();
    const body = init?.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : new Uint8Array();
    const headers = [...new Headers(init?.headers).entries()];
    let gotHead!: (h: ResponseInit) => void;
    let failHead!: (e: Error) => void;
    const head = new Promise<ResponseInit>((ok, fail) => {
      gotHead = ok;
      failHead = fail;
    });
    // A rejection nobody awaits yet (the stream's own error path) must not surface as unhandled.
    head.catch(() => {});
    let done = false;
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    // An abort before the head arrives must fail the fetch itself: the shell sends nothing more
    // for a cancelled call, and connect-web is still awaiting the Response.
    const abort = () => {
      if (done) return;
      done = true;
      cancelRpc(callId);
      const e = new DOMException("The operation was aborted.", "AbortError");
      failHead(e);
      ctrl.error(e);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        const onMessage = (msg: Uint8Array) => {
          if (done) return;
          for (const f of splitFrames(msg)) {
            if (f.kind === HEAD) gotHead(JSON.parse(text.decode(f.payload)));
            else if (f.kind === BODY) ctrl.enqueue(f.payload.slice());
            else if (f.kind === TRAILERS) ctrl.enqueue(grpcWebTrailer(JSON.parse(text.decode(f.payload))));
            else {
              done = true;
              const err = text.decode(f.payload);
              if (err) {
                const e = new Error(err);
                failHead(e);
                ctrl.error(e);
              } else ctrl.close();
              return;
            }
          }
        };
        daemonRpc(callId, url.pathname, headers, body, onMessage).catch((e) => {
          if (done) return;
          done = true;
          failHead(e);
          ctrl.error(e);
        });
      },
      cancel: () => {
        if (!done) {
          done = true;
          cancelRpc(callId);
        }
      },
    });
    init?.signal?.addEventListener("abort", abort);
    if (init?.signal?.aborted) abort();
    return new Response(stream, await head);
  }) as typeof fetch;
}

// connect-web speaks gRPC-web; the daemon speaks gRPC. The shell forwards HTTP/2, so only the
// content type differs (trailers already became a body frame in bridgeFetch).
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
