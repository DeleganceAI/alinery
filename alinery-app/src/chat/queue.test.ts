import { describe, expect, it } from "vitest";
import { dropConsumedFollowUp, latestQueuedFollowUp, queuedTextsNotInEntries, reconcileQueuedFollowUps } from "./queue";
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

describe("queued follow-up helpers", () => {
  it("drops the first matching consumed text", () => {
    expect(dropConsumedFollowUp(["a", "b", "a"], "a")).toEqual(["b", "a"]);
  });

  it("returns the latest queued text", () => {
    expect(latestQueuedFollowUp(["a", "b"])).toBe("b");
    expect(latestQueuedFollowUp([])).toBeUndefined();
  });

  it("skips stored texts already present as prompt or follow_up entries", () => {
    const entries: ChatEntry[] = [
      { id: "p", actor: ACTOR.you, type: "prompt", text: "done" },
      { id: "f", actor: ACTOR.you, type: "follow_up", text: "queued" },
    ];
    expect(queuedTextsNotInEntries(["done", "queued", "missing"], entries)).toEqual(["missing"]);
  });
});
