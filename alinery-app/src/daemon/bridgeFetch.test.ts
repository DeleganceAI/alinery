import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { setTrailerStatus } from "@connectrpc/connect/protocol-grpc";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { AdminService, HelloResponseSchema } from "alinery-proto/alinery/v1/admin_pb";
import { ErrorDetailSchema } from "alinery-proto/alinery/v1/common_pb";
import { describe, expect, it, vi } from "vitest";
import { BODY, type DaemonRpc, END, grpcWebFetch, HEAD, splitFrames, TRAILERS } from "./bridgeFetch";

// The shell's side of the Channel format (daemon_rpc.rs): frames, then zeros up to 1 KiB.
const enc = new TextEncoder();
function message(frames: [number, Uint8Array][]): Uint8Array {
  const size = frames.reduce((n, [, p]) => n + 5 + p.length, 0);
  const out = new Uint8Array(Math.max(size + 4, 1024));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const [kind, payload] of frames) {
    view.setUint32(at, payload.length + 1, true);
    out[at + 4] = kind;
    out.set(payload, at + 5);
    at += 5 + payload.length;
  }
  return out;
}
const json = (v: unknown) => enc.encode(JSON.stringify(v));
const envelope = (msg: Uint8Array) => {
  const out = new Uint8Array(5 + msg.length);
  new DataView(out.buffer).setUint32(1, msg.length, false);
  out.set(msg, 5);
  return out;
};
const head = (headers: [string, string][] = []) => [HEAD, json({ status: 200, headers: [["content-type", "application/grpc"], ...headers] })] as [number, Uint8Array];
const trailers = (pairs: [string, string][]) => [TRAILERS, json(pairs)] as [number, Uint8Array];
const end = (err = "") => [END, enc.encode(err)] as [number, Uint8Array];
const errorTrailers = (e: ConnectError): [string, string][] => [...setTrailerStatus(new Headers(), e).entries()];

type Handler = (path: string, body: Uint8Array, headers: [string, string][], emit: (frames: [number, Uint8Array][]) => void) => void;
// A fake `ipc.daemonRpc`: answers with whatever frames the handler emits, and records cancels.
function fakeShell(handler: Handler) {
  const seen: { path: string; headers: [string, string][] }[] = [];
  const cancelled: string[] = [];
  const daemonRpc: DaemonRpc = async (_id, path, headers, body, onMessage) => {
    seen.push({ path, headers });
    handler(path, body, headers, (frames) => onMessage(message(frames)));
  };
  const transport = createGrpcWebTransport({ baseUrl: "http://daemon", fetch: grpcWebFetch(daemonRpc, (id) => cancelled.push(id)) });
  return { seen, cancelled, transport, admin: createClient(AdminService, transport), fetch: grpcWebFetch(daemonRpc, (id) => cancelled.push(id)) };
}

const hello = envelope(toBinary(HelloResponseSchema, create(HelloResponseSchema, { protocol: 25, buildId: "b", capabilities: [1, 2, 3, 4] })));

describe("splitFrames", () => {
  it("reads several frames from one message and stops at the padding", () => {
    const got = [
      ...splitFrames(
        message([
          [BODY, enc.encode("ab")],
          [END, new Uint8Array()],
        ]),
      ),
    ];
    expect(got.map((f) => f.kind)).toEqual([BODY, END]);
    expect(new TextDecoder().decode(got[0].payload)).toBe("ab");
  });
});

describe("grpcWebFetch through a fake shell", () => {
  it("unary: the trailers frame becomes a gRPC-web trailer and connect-web decodes the answer", async () => {
    const shell = fakeShell((_p, _b, _h, emit) => emit([head(), [BODY, hello], trailers([["grpc-status", "0"]]), end()]));
    const r = await shell.admin.hello({});
    expect(r.protocol).toBe(25);
    expect(r.capabilities).toEqual([1, 2, 3, 4]);
    expect(shell.seen[0].path).toBe("/alinery.v1.AdminService/Hello");
    const h = Object.fromEntries(shell.seen[0].headers);
    expect(h["content-type"]).toBe("application/grpc+proto");
    expect(h["x-grpc-web"]).toBeUndefined();
    expect(h["x-user-agent"]).toBeUndefined();
  });

  it("a trailers-only error keeps its gRPC code", async () => {
    const shell = fakeShell((_p, _b, _h, emit) =>
      emit([
        head([
          ["grpc-status", "16"],
          ["grpc-message", "bad token"],
        ]),
        end(),
      ]),
    );
    const e = await shell.admin.hello({}).catch((x) => ConnectError.from(x));
    expect((e as ConnectError).code).toBe(Code.Unauthenticated);
  });

  it("an ErrorDetail survives grpc-status-details-bin and gRPC-web", async () => {
    const err = new ConnectError("need an origin", Code.InvalidArgument, undefined, [{ desc: ErrorDetailSchema, value: { code: "shutdown_origin_missing" } }]);
    const shell = fakeShell((_p, _b, _h, emit) => emit([head(), trailers(errorTrailers(err)), end()]));
    const e = (await shell.admin.shutdown({}).catch((x) => ConnectError.from(x))) as ConnectError;
    expect(e.code).toBe(Code.InvalidArgument);
    expect(e.findDetails(ErrorDetailSchema).map((d) => d.code)).toEqual(["shutdown_origin_missing"]);
  });

  it("a stream of 100 messages arrives in order, in a few channel messages, and ends cleanly", async () => {
    const chunk = (i: number) => [BODY, envelope(new Uint8Array([i]))] as [number, Uint8Array];
    const shell = fakeShell((_p, _b, _h, emit) => {
      emit([head(), ...Array.from({ length: 50 }, (_, i) => chunk(i))]);
      emit([...Array.from({ length: 50 }, (_, i) => chunk(50 + i)), trailers([["grpc-status", "0"]]), end()]);
    });
    const res = await shell.fetch("http://daemon/x", { method: "POST", body: new Uint8Array(), headers: { "content-type": "application/grpc-web+proto" } });
    expect(res.headers.get("content-type")).toBe("application/grpc-web+proto");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // 100 five-byte envelopes of one byte, then the 0x80 trailer frame.
    for (let i = 0; i < 100; i++) expect(bytes[i * 6 + 5]).toBe(i);
    expect(bytes[600]).toBe(0x80);
    expect(new TextDecoder().decode(bytes.subarray(605))).toBe("grpc-status: 0\r\n");
  });

  it("an abort before the head rejects the fetch itself and cancels the call", async () => {
    const shell = fakeShell(() => {}); // the daemon never answers
    const ac = new AbortController();
    const pending = shell.admin.hello({}, { signal: ac.signal }).catch((x) => ConnectError.from(x));
    await vi.waitFor(() => expect(shell.seen).toHaveLength(1));
    ac.abort();
    expect(((await pending) as ConnectError).code).toBe(Code.Canceled);
    expect(shell.cancelled).toHaveLength(1);
  });

  it("an abort mid-stream cancels once, and later frames are ignored", async () => {
    let push!: (frames: [number, Uint8Array][]) => void;
    const shell = fakeShell((_p, _b, _h, emit) => {
      push = emit;
      emit([head(), [BODY, envelope(new Uint8Array([1]))]]);
    });
    const ac = new AbortController();
    const res = await shell.fetch("http://daemon/x", { method: "POST", body: new Uint8Array(), signal: ac.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    expect((await reader.read()).value?.length).toBe(6);
    ac.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    expect(shell.cancelled).toHaveLength(1);
    expect(() => push([[BODY, new Uint8Array([9])]])).not.toThrow();
  });

  it("an END with an error fails the call, and so does a rejected daemonRpc", async () => {
    const ended = fakeShell((_p, _b, _h, emit) => emit([head(), end("connection closed")]));
    const res = await ended.fetch("http://daemon/x", { method: "POST", body: new Uint8Array() });
    await expect(res.arrayBuffer()).rejects.toThrow("connection closed");

    const failing = createGrpcWebTransport({
      baseUrl: "http://daemon",
      fetch: grpcWebFetch(
        () => Promise.reject(new Error("no daemon")),
        () => {},
      ),
    });
    const e = await createClient(AdminService, failing)
      .hello({})
      .catch((x) => ConnectError.from(x));
    expect((e as ConnectError).message).toContain("no daemon");
  });
});
