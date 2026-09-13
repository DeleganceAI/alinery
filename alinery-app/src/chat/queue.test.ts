import { describe, expect, it } from "vitest";
import { latestQueuedFollowUp, queuedCountFromGetState, queuedTextsNotInEntries, reconcileQueuedFollowUps } from "./queue";
import type { ChatEntry } from "./types";
import { ACTOR } from "./types";

describe("reconcileQueuedFollowUps", () => {
  it("does not trim when OMP has not spoken", () => {
    expect(reconcileQueuedFollowUps(["a", "b"], undefined)).toEqual({ texts: ["a", "b"], unmatchedCount: 0 });
  });

  it("clears local texts when the wire count is 0", () => {
    expect(reconcileQueuedFollowUps(["a", "b"], 0)).toEqual({ texts: [], unmatchedCount: 0 });
  });

  it("drops oldest extras when the wire count is below local", () => {
    expect(reconcileQueuedFollowUps(["old", "mid", "new"], 1)).toEqual({ texts: ["new"], unmatchedCount: 0 });
  });

  it("never invents message bodies when the wire count is above local", () => {
    expect(reconcileQueuedFollowUps(["keep"], 3)).toEqual({ texts: ["keep"], unmatchedCount: 2 });
  });

  it("leaves texts alone when counts match", () => {
    expect(reconcileQueuedFollowUps(["a", "b"], 2)).toEqual({ texts: ["a", "b"], unmatchedCount: 0 });
  });
});

describe("queuedCountFromGetState", () => {
  it("reads the count only from a successful get_state", () => {
    expect(queuedCountFromGetState({ type: "response", command: "get_state", success: true, data: { queuedMessageCount: 2 } })).toBe(2);
    expect(queuedCountFromGetState({ type: "response", command: "get_state", success: true, data: { queuedMessageCount: 0 } })).toBe(0);
  });

  it("ignores sticky-looking lines that are not a successful get_state", () => {
    expect(queuedCountFromGetState({ type: "thinking_delta" })).toBeUndefined();
    expect(queuedCountFromGetState({ type: "response", command: "get_state", success: false, data: { queuedMessageCount: 1 } })).toBeUndefined();
    expect(queuedCountFromGetState({ type: "response", command: "follow_up", success: true, data: { queuedMessageCount: 1 } })).toBeUndefined();
  });
});

describe("queued follow-up helpers", () => {
  it("returns the latest queued text", () => {
    expect(latestQueuedFollowUp(["a", "b"])).toBe("b");
    expect(latestQueuedFollowUp([])).toBeUndefined();
  });

  it("skips stored texts already present as follow_up entries, not historical prompts", () => {
    const entries: ChatEntry[] = [
      { id: "p", actor: ACTOR.you, type: "prompt", text: "ok" },
      { id: "f", actor: ACTOR.you, type: "follow_up", text: "queued" },
    ];
    expect(queuedTextsNotInEntries(["ok", "queued", "missing"], entries)).toEqual(["ok", "missing"]);
  });
});

describe("queued follow-ups as { text, attachments } items", () => {
  const items = [
    { text: "old", attachments: [{ id: "a", kind: "file" as const, name: "a.pdf", mimeType: "application/pdf", bytes: 10 }] },
    { text: "mid", attachments: [] },
    { text: "new", attachments: [{ id: "b", kind: "image" as const, name: "b.png", mimeType: "image/png", bytes: 4 }] },
  ];

  it("keeps the same count/slice behavior without dropping attachments", () => {
    const reconcile = reconcileQueuedFollowUps as unknown as (local: typeof items, count: number | undefined) => { texts: typeof items; unmatchedCount: number };
    expect(reconcile(items, undefined)).toEqual({ texts: items, unmatchedCount: 0 });
    expect(reconcile(items, 0)).toEqual({ texts: [], unmatchedCount: 0 });
    expect(reconcile(items, 1)).toEqual({ texts: [items[2]], unmatchedCount: 0 });
    expect(reconcile([items[2]], 3)).toEqual({ texts: [items[2]], unmatchedCount: 2 });
    expect(reconcile(items.slice(1), 2)).toEqual({ texts: items.slice(1), unmatchedCount: 0 });
  });

  it("returns the latest queued object, not a string", () => {
    const latest = latestQueuedFollowUp as unknown as (local: typeof items) => (typeof items)[number] | undefined;
    expect(latest(items)).toEqual(items[2]);
    expect(latest([])).toBeUndefined();
  });
});
