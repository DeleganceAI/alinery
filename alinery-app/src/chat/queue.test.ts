import { describe, expect, it } from "vitest";
import { latestQueuedFollowUp } from "./queue";

describe("queued follow-up helpers", () => {
  it("returns the latest queued text", () => {
    expect(latestQueuedFollowUp(["a", "b"])).toBe("b");
    expect(latestQueuedFollowUp([])).toBeUndefined();
  });
});

describe("queued follow-ups as { text, attachments } items", () => {
  const items = [
    { text: "old", attachments: [{ id: "a", kind: "file" as const, name: "a.pdf", mimeType: "application/pdf", bytes: 10 }] },
    { text: "mid", attachments: [] },
    { text: "new", attachments: [{ id: "b", kind: "image" as const, name: "b.png", mimeType: "image/png", bytes: 4 }] },
  ];

  it("returns the latest queued object, not a string", () => {
    expect(latestQueuedFollowUp(items)).toEqual(items[2]);
    expect(latestQueuedFollowUp([])).toBeUndefined();
  });
});
