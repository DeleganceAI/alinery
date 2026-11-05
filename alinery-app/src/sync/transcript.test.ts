import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  type SessionService,
  type TranscriptItem,
  TranscriptItemSchema,
  type WatchTranscriptRequest,
  type WatchTranscriptResponse,
  WatchTranscriptResponseSchema,
} from "alinery-proto/alinery/v1/sessions_pb";
import { describe, expect, it, vi } from "vitest";
import type { VinculumTranscript } from "../chatTranscript";
import { daemonTransport } from "../daemon/transport";
import { daemonHarness, untilAborted } from "../test/daemonHarness";
import { applyFrame, messageOf, watchSessionTranscript } from "./transcript";

vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));

const item = (id: string, text: string, extra: MessageInitShape<typeof TranscriptItemSchema> = {}) =>
  create(TranscriptItemSchema, { id, role: "assistant", content: [{ kind: { case: "text", value: text } }], ...extra });
const frame = (items: TranscriptItem[], nextItem: number, replace = false, controls?: { model: string; thinking: string; thinkingLevels: string[] }) =>
  create(WatchTranscriptResponseSchema, { items, nextItem: BigInt(nextItem), replace, controls });

/** Each WatchTranscript call runs `script(request, call)`; the calls are kept for the test to read. */
function serve(script: (req: WatchTranscriptRequest, call: number, signal: AbortSignal) => AsyncGenerator<WatchTranscriptResponse>) {
  const requests: WatchTranscriptRequest[] = [];
  const sessions: ServiceImpl<typeof SessionService> = {
    async *watchTranscript(req, ctx) {
      requests.push(req);
      yield* script(req, requests.length - 1, ctx.signal);
    },
  };
  vi.mocked(daemonTransport).mockReturnValue(daemonHarness({ sessions }).transport);
  return requests;
}

const replies = () => {
  const got: VinculumTranscript[] = [];
  return { got, apply: (r: VinculumTranscript) => got.push(structuredClone(r)) };
};
const until = (fn: () => boolean) => vi.waitFor(() => expect(fn()).toBe(true));

describe("watchSessionTranscript", () => {
  it("asks for item 0, appends a new item, and replaces from the index a frame names", async () => {
    const requests = serve(async function* (_req, _call, signal) {
      yield frame([item("u1", "hi"), item("live", "He")], 2, false, { model: "p/m", thinking: "low", thinkingLevels: ["off", "low"] });
      yield frame([item("live", "Hello")], 2, true);
      yield frame([item("a2", "more")], 3);
      await untilAborted(signal);
    });
    const { got, apply } = replies();
    const stop = watchSessionTranscript("/repo", { taskSlug: "t", id: "s1" }, apply);
    await until(() => got.length === 3);
    stop();
    expect(requests[0]).toMatchObject({ session: { taskSlug: "t", id: "s1" }, fromItem: 0n });
    expect(got[0]).toMatchObject({ model: "p/m", thinking: "low", thinking_levels: ["off", "low"] });
    expect(got[1]?.messages.map((m) => [m.id, (m.content as { text: string }[])[0]?.text])).toEqual([
      ["u1", "hi"],
      ["live", "Hello"],
    ]);
    expect(got[2]?.messages.map((m) => m.id)).toEqual(["u1", "live", "a2"]);
    expect(got[2]?.model).toBe("p/m"); // controls are kept until a frame changes them
  });

  it("after a drop it reconnects from the end of its list and keeps what it had", async () => {
    const requests = serve(async function* (_req, call, signal) {
      if (call === 0) {
        yield frame([item("u1", "hi"), item("a1", "yo")], 2);
        throw new Error("link dropped");
      }
      yield frame([item("a2", "later")], 3);
      await untilAborted(signal);
    });
    const { got, apply } = replies();
    const stop = watchSessionTranscript("/repo", { taskSlug: "", id: "c1" }, apply, 5);
    await until(() => got.length === 2);
    stop();
    expect(requests.map((r) => r.fromItem)).toEqual([0n, 2n]);
    expect(got[1]?.messages.map((m) => m.id)).toEqual(["u1", "a1", "a2"]);
  });

  it("starts over from item 0 when a frame begins past the end of its list", async () => {
    const requests = serve(async function* (_req, call, signal) {
      if (call === 0)
        yield frame([item("x", "?")], 6); // covers [5, 6) with nothing before it
      else yield frame([item("u1", "hi")], 1);
      await untilAborted(signal);
    });
    const { got, apply } = replies();
    const stop = watchSessionTranscript("/repo", { taskSlug: "t", id: "s1" }, apply, 5);
    await until(() => got.length === 1);
    stop();
    expect(requests.map((r) => r.fromItem)).toEqual([0n, 0n]);
    expect(got[0]?.messages.map((m) => m.id)).toEqual(["u1"]);
  });

  it("stop ends the stream and no frame after it is applied", async () => {
    let aborted = false;
    serve(async function* (_req, _call, signal) {
      yield frame([item("u1", "hi")], 1);
      await untilAborted(signal);
      aborted = true;
      yield frame([item("u2", "late")], 2);
    });
    const { got, apply } = replies();
    const stop = watchSessionTranscript("/repo", { taskSlug: "t", id: "s1" }, apply);
    await until(() => got.length === 1);
    stop();
    await until(() => aborted);
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toHaveLength(1);
  });
});

describe("transcript frames", () => {
  it("maps every part kind, the tool call arguments and the flags the pane reads", () => {
    const m = messageOf(
      create(TranscriptItemSchema, {
        id: "a1",
        role: "assistant",
        streaming: true,
        runningToolIds: ["c1"],
        content: [
          { kind: { case: "thinking", value: "plan" } },
          { kind: { case: "redactedThinking", value: {} } },
          {
            kind: {
              case: "toolCall",
              value: { id: "c1", name: "read", arguments: { kind: { case: "structValue", value: { fields: { path: { kind: { case: "stringValue", value: "a.ts" } } } } } } },
            },
          },
        ],
      }),
    );
    expect(m).toEqual({
      id: "a1",
      role: "assistant",
      streaming: true,
      runningToolIds: ["c1"],
      content: [{ type: "thinking", thinking: "plan" }, { type: "redactedThinking" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }],
    });
    expect(messageOf(item("r1", "x", { role: "toolResult", toolName: "read", toolCallId: "c1", isError: true }))).toMatchObject({
      toolName: "read",
      toolCallId: "c1",
      isError: true,
    });
    expect("streaming" in messageOf(item("u", "x"))).toBe(false);
  });

  it("applyFrame appends at the end, replaces from the start index, and refuses a gap", () => {
    const base = [messageOf(item("a", "1")), messageOf(item("b", "2"))];
    expect(applyFrame(base, frame([item("c", "3")], 3))?.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(applyFrame(base, frame([item("b", "2!")], 2, true))?.map((m) => m.id)).toEqual(["a", "b"]);
    expect(applyFrame(base, frame([], 1, true))?.map((m) => m.id)).toEqual(["a"]);
    expect(applyFrame(base, frame([item("z", "9")], 5))).toBeUndefined();
  });
});
