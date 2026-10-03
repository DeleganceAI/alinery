import { describe, expect, it } from "vitest";
import { appendOptimisticUser, emptyTranscript } from "../chatTranscript";
import { abortTurnCommand, applyChatValue, attachHandshake, journalState, olderPageState, parseChatLine, queueRefreshCommand, sendCommand, sendNowCommand } from "./chatSession";

/** A journal page as `read_chat_omp` returns it: a JSON header line, then one JSON row per line. */
function journalPage(start: number, rows: [id: string, text: string][]): ArrayBuffer {
  const body = rows.map(([id, text]) => JSON.stringify({ type: "message", id, message: { role: "user", content: [{ type: "text", text }] } })).join("\n");
  const bytes = new TextEncoder().encode(`${JSON.stringify({ start, end: start + 100, length: 1000 })}\n${body}\n`);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

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
