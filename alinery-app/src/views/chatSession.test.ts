import { describe, expect, it } from "vitest";
import { appendOptimisticUser } from "../chatTranscript";
import { journalPage } from "../test/ompJournal";
import { journalState, olderPageState, sendCommand, sendNowCommand } from "./chatSession";

describe("chatSession", () => {
  it("prompts when idle, queues a follow-up when busy, and aborts-and-prompts on send now", () => {
    expect(sendCommand("hi", false)).toMatchObject({ type: "prompt", message: "hi" });
    expect(sendCommand("again", true)).toMatchObject({ type: "follow_up", message: "again" });
    expect(sendNowCommand("stop")).toMatchObject({ type: "abort_and_prompt", message: "stop" });
    const images = [{ type: "image" as const, data: "aa", mimeType: "image/png" }];
    expect(sendCommand("look", false, images)).toMatchObject({ type: "prompt", message: "look", images });
    expect(sendNowCommand("look", images)).toMatchObject({ type: "abort_and_prompt", message: "look", images });
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
