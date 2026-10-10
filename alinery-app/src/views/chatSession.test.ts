import { describe, expect, it, vi } from "vitest";
import { appendOptimisticUser, emptyTranscript } from "../chatTranscript";
import { journalPage } from "../test/ompJournal";
import {
  abortTurnCommand,
  applyChatValue,
  attachHandshake,
  journalState,
  olderPageState,
  parseChatLine,
  queueRefreshCommand,
  readJournalThrough,
  sendCommand,
  sendNowCommand,
} from "./chatSession";

describe("chatSession", () => {
  it("prompts when idle, queues a follow-up when busy, and aborts-and-prompts on send now", () => {
    expect(sendCommand("hi", false)).toMatchObject({ type: "prompt", message: "hi" });
    expect(sendCommand("again", true)).toMatchObject({ type: "follow_up", message: "again" });
    expect(sendNowCommand("stop")).toMatchObject({ type: "abort_and_prompt", message: "stop" });
  });

  it("aborts with the official abort command", () => {
    expect(abortTurnCommand()).toMatchObject({ type: "abort" });
  });

  it("applies a JSON RPC line and ignores junk", () => {
    const ready = applyChatValue(emptyTranscript(), parseChatLine(JSON.stringify({ type: "ready", protocolVersion: 2 })));
    expect(ready.ready).toBe(true);
    expect(applyChatValue(ready, parseChatLine("not-json"))).toBe(ready);
  });

  it("drops follow-up rows OMP has delivered once get_state reports the queue", () => {
    let state = emptyTranscript();
    for (const text of ["a", "b", "c"]) state = appendOptimisticUser(state, text, "follow_up");
    const trimmed = applyChatValue(state, { type: "response", command: "get_state", success: true, data: { queuedMessageCount: 1 } });
    expect(trimmed.entries.filter((entry) => entry.type === "follow_up").map((entry) => (entry.type === "follow_up" ? entry.text : ""))).toEqual(["c"]);
  });

  it("re-reads the queue only after a follow-up lands or a turn ends", () => {
    expect(queueRefreshCommand({ type: "response", command: "follow_up", success: true })).toMatchObject({ type: "get_state" });
    expect(queueRefreshCommand({ type: "turn_end" })).toMatchObject({ type: "get_state" });
    expect(queueRefreshCommand({ type: "response", command: "prompt", success: true })).toBeNull();
    expect(queueRefreshCommand({ type: "message_update" })).toBeNull();
    expect(queueRefreshCommand(undefined)).toBeNull();
  });

  it("handshakes in order, subscribing to subagent events before reading the subagent list", () => {
    expect(attachHandshake(true).map((command) => command.type)).toEqual([
      "negotiate_protocol",
      "get_available_commands",
      "get_state",
      "set_auto_compaction",
      "set_subagent_subscription",
      "get_subagents",
      "get_available_models",
    ]);
    expect(attachHandshake(true).find((command) => command.type === "set_subagent_subscription")).toMatchObject({ level: "events" });
  });

  it("carries the auto-compaction setting in the handshake", () => {
    for (const enabled of [true, false]) {
      expect(attachHandshake(enabled).find((command) => command.type === "set_auto_compaction")).toMatchObject({ enabled });
    }
  });

  it("prepends an older journal page and moves fileStart back to its start", () => {
    const loaded = journalState(journalPage(600, [["b1", "second"]]));
    expect(loaded.fileStart).toBe(600);
    const older = olderPageState(loaded, journalPage(200, [["a1", "first"]]));
    expect(older.fileStart).toBe(200);
    expect(older.messages.map((message) => message.rowId)).toEqual(["a1", "b1"]);
    expect(older.entries.map((entry) => entry.id)).toEqual(["f:a1", "f:b1"]);
  });

  it("keeps live rows after an older page lands", () => {
    const live = appendOptimisticUser(journalState(journalPage(600, [["b1", "second"]])), "typing now");
    const liveRows = live.entries.filter((entry) => !entry.id.startsWith("f:"));
    expect(liveRows.length).toBeGreaterThan(0);
    const older = olderPageState(live, journalPage(200, [["a1", "first"]]));
    expect(older.entries.map((entry) => entry.id).slice(0, 2)).toEqual(["f:a1", "f:b1"]);
    expect(older.entries.slice(2)).toEqual(liveRows);
  });
});

describe("readJournalThrough", () => {
  /** A journal read that answers each call with the next page, and remembers what it was asked. */
  const reads = (...pages: ArrayBuffer[]) => vi.fn(async (_end?: number, _want?: number) => pages.shift() as ArrayBuffer);
  const ids = (state: { messages: { rowId?: string }[] }) => state.messages.map((message) => message.rowId);

  it("reads the tail alone when nothing was loaded before", async () => {
    const read = reads(journalPage(2000, [["m4", "tail"]]));
    const state = await readJournalThrough(read, null);
    expect(read.mock.calls).toEqual([[]]);
    expect(ids(state)).toEqual(["m4"]);
  });

  it("stops at the tail when it already reaches the old boundary", async () => {
    const read = reads(journalPage(300, [["m3", "tail"]]));
    const state = await readJournalThrough(read, 500);
    expect(read).toHaveBeenCalledTimes(1);
    expect(state.fileStart).toBe(300);
  });

  it("reads one window sized to the gap, a byte wider so the row at the boundary is found", async () => {
    const read = reads(
      journalPage(2000, [["m4", "tail"]]),
      journalPage(500, [
        ["m2", "old"],
        ["m3", "newer"],
      ]),
    );
    const state = await readJournalThrough(read, 500);
    expect(read.mock.calls).toEqual([[], [2000, 1501]]);
    expect(ids(state)).toEqual(["m2", "m3", "m4"]);
    expect(state.fileStart).toBe(500);
  });

  it("keeps stepping while the daemon's window stops short of the boundary", async () => {
    const read = reads(journalPage(2000, [["m4", "tail"]]), journalPage(1200, [["m3", "mid"]]), journalPage(500, [["m2", "old"]]));
    const state = await readJournalThrough(read, 500);
    expect(read.mock.calls).toEqual([[], [2000, 1501], [1200, 701]]);
    expect(ids(state)).toEqual(["m2", "m3", "m4"]);
  });

  it("gives up on a page that does not move back, keeping what it has", async () => {
    const read = reads(journalPage(2000, [["m4", "tail"]]), journalPage(2000, []));
    const state = await readJournalThrough(read, 500);
    expect(read).toHaveBeenCalledTimes(2);
    expect(ids(state)).toEqual(["m4"]);
    expect(state.fileStart).toBe(2000);
  });

  it("rejects when a read fails, so the caller can keep the transcript it has", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(journalPage(2000, [["m4", "tail"]]))
      .mockRejectedValueOnce(new Error("gone"));
    await expect(readJournalThrough(read, 500)).rejects.toThrow("gone");
  });
});
