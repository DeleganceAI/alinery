// S0.3 sample: the webview half of the bridge (2.1.9), runnable outside Tauri.
// `bridgeFetch` turns frames from the shell into a fetch Response, so a stock Connect client
// works unchanged. Here `daemonRpc` is a stand-in for the Tauri command: it does what the Rust
// side will do (HTTP/1.1 to the unix socket, frame and pad each chunk) with Bun's fetch.

export const HEAD = 1, BODY = 2, END = 3;
// O1 (b): HTTP/2 trailers, as a JSON array of [name, value]. The webview turns them into a
// gRPC-web trailer frame (grpc-bridge.ts), so the shell stays a plain HTTP/2 forwarder.
export const TRAILERS = 4;
export const PAD_TO = 1024; // Tauri 2.11 MAX_RAW_DIRECT_EXECUTE_THRESHOLD (tauri/src/ipc/channel.rs:39)

// One channel message holds one or more frames: [u32 LE len][u8 kind][payload], then zero padding
// up to PAD_TO. A zero length ends the message (padding).
export function encodeFrames(frames: { kind: number; payload: Uint8Array }[]): Uint8Array {
  const size = frames.reduce((n, f) => n + 5 + f.payload.length, 0);
  const out = new Uint8Array(Math.max(size + 4, PAD_TO));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const f of frames) {
    view.setUint32(at, f.payload.length + 1, true);
    out[at + 4] = f.kind;
    out.set(f.payload, at + 5);
    at += 5 + f.payload.length;
  }
  return out; // the rest is zeros: a zero length marks the end
}

export function* splitFrames(msg: Uint8Array): Generator<{ kind: number; payload: Uint8Array }> {
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  for (let at = 0; at + 4 <= msg.length; ) {
    const len = view.getUint32(at, true);
    if (len === 0) return;
    yield { kind: msg[at + 4], payload: msg.subarray(at + 5, at + 4 + len) };
    at += 4 + len;
  }
}

export type DaemonRpc = (
  callId: string,
  path: string,
  headers: [string, string][],
  body: Uint8Array,
  onMessage: (msg: Uint8Array) => void,
) => Promise<void>;
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
    const head = new Promise<ResponseInit>((ok, fail) => ((gotHead = ok), (failHead = fail)));
    let done = false;
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    // An abort before the head arrives must fail the fetch itself: the shell sends nothing more
    // for a cancelled call, and Connect is still awaiting the Response.
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
          for (const f of splitFrames(msg)) {
            if (f.kind === HEAD) gotHead(JSON.parse(text.decode(f.payload)));
            else if (f.kind === BODY) ctrl.enqueue(f.payload.slice());
            else if (f.kind === TRAILERS) ctrl.enqueue(grpcWebTrailer(JSON.parse(text.decode(f.payload))));
            else {
              done = true;
              const err = text.decode(f.payload);
              if (err) { const e = new Error(err); failHead(e); ctrl.error(e); } else ctrl.close();
            }
          }
        };
        daemonRpc(callId, url.pathname, headers, body, onMessage).catch((e) => { failHead(e); ctrl.error(e); });
      },
      cancel: () => { if (!done) { done = true; cancelRpc(callId); } },
    });
    init?.signal?.addEventListener("abort", abort);
    return new Response(stream, await head);
  }) as typeof fetch;
}

// Stand-in for the shell's daemon_rpc command (the Rust version is bridge-rs/src/main.rs).
export function fakeShell(socketPath: string, token: string): { daemonRpc: DaemonRpc; cancel: DaemonRpcCancel } {
  const calls = new Map<string, AbortController>();
  return {
    cancel: (id) => calls.get(id)?.abort(),
    daemonRpc: async (id, path, headers, body, onMessage) => {
      const ac = new AbortController();
      calls.set(id, ac);
      try {
        const res = await fetch(`http://daemon${path}`, {
          // One connection per call, like the Rust shell: after a cancelled stream the server drops
          // that HTTP/1.1 connection, and a pooled reuse fails with ECONNRESET.
          method: "POST", body, signal: ac.signal, unix: socketPath, keepalive: false,
          headers: [...headers, ["authorization", `Bearer ${token}`]],
        } as RequestInit);
        const head = { status: res.status, headers: [...res.headers.entries()] };
        onMessage(encodeFrames([{ kind: HEAD, payload: enc.encode(JSON.stringify(head)) }]));
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) onMessage(encodeFrames([{ kind: BODY, payload: chunk }]));
        onMessage(encodeFrames([{ kind: END, payload: new Uint8Array() }]));
      } catch (e) {
        if (!ac.signal.aborted) onMessage(encodeFrames([{ kind: END, payload: enc.encode(String(e)) }]));
      } finally {
        calls.delete(id);
      }
    },
  };
}
