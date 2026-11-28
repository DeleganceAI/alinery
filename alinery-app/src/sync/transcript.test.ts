import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
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
import { applyVinculumTranscript, type ChatTranscriptState, emptyTranscript } from "../chatTranscript";
import { daemonTransport } from "../daemon/transport";
import { daemonHarness, untilAborted } from "../test/daemonHarness";
import { applyFrame, messageOf, queuedOf, watchSessionTranscript } from "./transcript";

vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));

const item = (id: string, text: string, extra: MessageInitShape<typeof TranscriptItemSchema> = {}) =>
  create(TranscriptItemSchema, { id, role: "assistant", content: [{ kind: { case: "text", value: text } }], ...extra });
const frame = (items: TranscriptItem[], nextItem: number, replace = false, controls?: { model: string; thinking: string; thinkingLevels: string[] }) =>
  create(WatchTranscriptResponseSchema, { items, nextItem: BigInt(nextItem), replace, controls });

/** Each WatchTranscript call runs `script(request, call)`; the calls are kept for the test to read. */
function serve(script: (req: WatchTranscriptRequest, call: number, signal: AbortSignal) => AsyncGenerator<WatchTranscriptResponse>) {
  const requests: WatchTranscriptRequest[] = [];
  const sessions: Partial<ServiceImpl<typeof SessionService>> = {
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
  it("retries a dropped history connection and reads the legacy journal only when the daemon reports a missing Pi transcript", async () => {
    const requests = serve(async function* (_req, call) {
      if (call === 0) throw new ConnectError("disconnected", Code.Unavailable);
      yield* [];
      throw new ConnectError("no retained Pi transcript", Code.NotFound);
    });
    const legacy = vi.fn().mockResolvedValue(undefined);
    const stop = watchSessionTranscript("/repo", { taskSlug: "t", id: "s1" }, vi.fn(), 1, { onMissing: legacy, onError: vi.fn() });
    await until(() => legacy.mock.calls.length > 0);
    stop();
    expect(requests).toHaveLength(2);
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("accepts a finished history stream without reopening the database", async () => {
    const requests = serve(async function* () {
      yield frame([item("past", "handoff")], 1);
    });
    const { got, apply } = replies();
    const history = { onMissing: vi.fn(), onError: vi.fn() };
    const stop = watchSessionTranscript("/repo", { taskSlug: "t", id: "s1" }, apply, 1, history);
    await until(() => got.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 12));
    stop();
    expect(requests).toHaveLength(1);
    expect(history.onMissing).not.toHaveBeenCalled();
    expect(history.onError).not.toHaveBeenCalled();
  });

  it("surfaces a permanent history read failure", async () => {
    const requests = serve(async function* () {
      yield* [];
      throw new ConnectError("history cannot be read", Code.DataLoss);
    });
    const history = { onMissing: vi.fn(), onError: vi.fn() };
    const stop = watchSessionTranscript("/repo", { taskSlug: "t", id: "s1" }, vi.fn(), 1, history);
    await until(() => history.onError.mock.calls.length > 0);
    stop();
    expect(requests).toHaveLength(1);
    expect(history.onMissing).not.toHaveBeenCalled();
    expect(history.onError.mock.calls[0]?.[0].message).toContain("history cannot be read");
  });

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

  it("a queue-only change folds as an empty append at the client's own index: no replay, and the queue lands", async () => {
    // What the daemon really emits when only the inbox changed: an empty item list, no replace, the client's own next
    // index. The fake daemon always sends the full list with replace set, so this shape is the one a real busy submit
    // produces and the fold must take it without re-reading anything.
    const requests = serve(async function* (_req, _call, signal) {
      yield frame([item("u1", "hi"), item("live", "He")], 2);
      yield create(WatchTranscriptResponseSchema, {
        items: [],
        nextItem: 2n,
        replace: false,
        queued: { items: [{ id: "7", mode: "followUp", text: "later", images: [] }] },
      });
      await untilAborted(signal);
    });
    const { got, apply } = replies();
    const stop = watchSessionTranscript("/repo", { taskSlug: "t", id: "s1" }, apply);
    await until(() => got.length === 2);
    stop();
    // No replay: the same list as before — same rows, no restart from 0, one request — and the queue is applied.
    expect(got[1]?.messages.map((m) => m.id)).toEqual(["u1", "live"]);
    expect(got[1]?.queued).toEqual([{ id: "7", mode: "followUp", text: "later", images: [] }]);
    expect(requests).toHaveLength(1);
  });

  it("a coalesced delivery that appends the placed message and the reply whole drops the panel line, with no replay", async () => {
    // The one shape the old delivery match could not recognise: the inbox emptied and the turn ended inside one
    // coalesce window, so a single frame carries the placement, the reply it started and the emptied queue — and
    // because the daemon sends the queue only when it changes, no later frame ever comes to drop a stale line.
    let releaseDelivery = () => {};
    const sendAnswered = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const requests = serve(async function* (_req, _call, signal) {
      yield frame([item("u1", "seed", { role: "user" })], 1);
      await sendAnswered;
      yield create(WatchTranscriptResponseSchema, {
        items: [item("u2", "later", { role: "user" }), item("a1", "the reply")],
        nextItem: 3n,
        replace: false,
        queued: { items: [] },
      });
      await untilAborted(signal);
    });
    const got: ChatTranscriptState[] = [];
    let state = emptyTranscript();
    const stop = watchSessionTranscript("/repo", { taskSlug: "t", id: "s1" }, (reply) => {
      state = applyVinculumTranscript(reply, state);
      got.push(state);
    });
    await until(() => got.length === 1);
    // The prompt call answered `queued`, so the chat makes its panel line now — between the two frames, as a real send does.
    state = {
      ...state,
      queued: [{ id: "7", mode: "followUp", text: "later", images: [], origin: "pending", stale: false }],
      sessionMeta: { ...state.sessionMeta, queuedMessageCount: 1 },
    };
    releaseDelivery();
    await until(() => got.length === 2);
    stop();
    expect(got[1]?.queued).toEqual([]);
    expect(got[1]?.sessionMeta.queuedMessageCount).toBe(0);
    expect(requests).toHaveLength(1); // the fold is taken in place: the delivering frame is the last one, so nothing re-reads
  });

  it("a replace-shaped delivering fold — the streaming row settles and the message places in one frame — drops the panel line", async () => {
    // The daemon's frame covers from the streaming row's index (replace), so the assembled list changes the partial
    // in place and appends the placement and the reply behind it: a fold the exact +1 append rule never recognised.
    let releaseDelivery = () => {};
    const sendAnswered = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const requests = serve(async function* (_req, _call, signal) {
      yield frame([item("u1", "seed", { role: "user" }), item("partial", "Work", { streaming: true })], 2);
      await sendAnswered;
      yield create(WatchTranscriptResponseSchema, {
        items: [item("a1", "Working on it"), item("u2", "later", { role: "user" }), item("a2", "the reply")],
        nextItem: 4n,
        replace: true,
        queued: { items: [] },
      });
      await untilAborted(signal);
    });
    const got: ChatTranscriptState[] = [];
    let state = emptyTranscript();
    const stop = watchSessionTranscript("/repo", { taskSlug: "t", id: "s1" }, (reply) => {
      state = applyVinculumTranscript(reply, state);
      got.push(state);
    });
    await until(() => got.length === 1);
    state = {
      ...state,
      queued: [{ id: "7", mode: "followUp", text: "later", images: [], origin: "pending", stale: false }],
      sessionMeta: { ...state.sessionMeta, queuedMessageCount: 1 },
    };
    releaseDelivery();
    await until(() => got.length === 2);
    stop();
    expect(got[1]?.messages.map((m) => [m.role, m.content.find((part) => part.type === "text")])).toEqual([
      ["user", { type: "text", text: "seed" }],
      ["assistant", { type: "text", text: "Working on it" }],
      ["user", { type: "text", text: "later" }],
      ["assistant", { type: "text", text: "the reply" }],
    ]);
    expect(got[1]?.queued).toEqual([]);
    expect(got[1]?.sessionMeta.queuedMessageCount).toBe(0);
    expect(requests).toHaveLength(1);
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

  it("rereads a streaming row replaced by a wrap-up nudge during a disconnect", async () => {
    const prompt = item("u1", "start", { role: "user" });
    const nudge = item("u2", "Please wrap up this step.", { role: "user", nudgeDeliveryId: "delivery-1" });
    const requests = serve(async function* (req, call, signal) {
      if (call === 0) {
        yield frame([prompt, item("partial", "Working", { streaming: true })], 2);
        throw new ConnectError("link dropped", Code.Unavailable);
      }
      const current = [prompt, nudge, item("a1", "Finished")];
      yield frame(current.slice(Number(req.fromItem)), current.length);
      await untilAborted(signal);
    });
    const { got, apply } = replies();
    const stop = watchSessionTranscript("/repo", { taskSlug: "task", id: "session" }, apply, 1);
    await until(() => got.length === 2);
    stop();
    expect(requests.map((r) => r.fromItem)).toEqual([0n, 1n]);
    expect(got[1]?.messages.map((m) => m.id)).toEqual(["u1", "u2", "a1"]);
    expect(got[1]?.messages[1]?.nudgeDeliveryId).toBe("delivery-1");
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
    expect(messageOf(item("u", "x", { at: 1234n })).at).toBe(1234);
    expect("at" in messageOf(item("u", "x"))).toBe(false);
  });

  it("maps a prompt's image part to its name and type, never its bytes", () => {
    const m = messageOf(
      create(TranscriptItemSchema, {
        id: "u1",
        role: "user",
        content: [
          { kind: { case: "text", value: "what is this?" } },
          { kind: { case: "image", value: { mimeType: "image/png", name: "shot.png" } } },
          { kind: { case: "image", value: { mimeType: "image/jpeg", name: "" } } },
        ],
      }),
    );
    expect(m.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", mimeType: "image/png", name: "shot.png" },
      { type: "image", mimeType: "image/jpeg" },
    ]);
  });

  it("maps a carried queue and treats an absent field as unchanged, not as an empty queue", () => {
    const carried = create(WatchTranscriptResponseSchema, {
      queued: { items: [{ id: "7", mode: "followUp", text: "later", images: [{ name: "shot.png", mimeType: "image/png" }] }] },
    });
    expect(queuedOf(carried)).toEqual([{ id: "7", mode: "followUp", text: "later", images: [{ name: "shot.png", mimeType: "image/png" }] }]);
    expect(queuedOf(create(WatchTranscriptResponseSchema, {}))).toBeUndefined();
    expect(queuedOf(create(WatchTranscriptResponseSchema, { queued: { items: [] } }))).toEqual([]);
  });

  it("applyFrame appends at the end, replaces from the start index, and refuses a gap", () => {
    const base = [messageOf(item("a", "1")), messageOf(item("b", "2"))];
    expect(applyFrame(base, frame([item("c", "3")], 3))?.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(applyFrame(base, frame([item("b", "2!")], 2, true))?.map((m) => m.id)).toEqual(["a", "b"]);
    expect(applyFrame(base, frame([], 1, true))?.map((m) => m.id)).toEqual(["a"]);
    expect(applyFrame(base, frame([item("z", "9")], 5))).toBeUndefined();
  });
});
