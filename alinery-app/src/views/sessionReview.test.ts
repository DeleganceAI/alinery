import { describe, expect, it } from "vitest";
import { sessionReviewOffered } from "./sessionReview";

const offered = {
  reviewCurrent: true,
  turnActive: false,
  messageSending: false,
  messageInterrupting: false,
  retryPending: false,
  compacting: false,
  queuedCount: 0,
  pendingUi: false,
};

describe("session review gate", () => {
  it("is not offered with one panel line, and is offered after the queue empties and the turn ends", () => {
    expect(sessionReviewOffered({ ...offered, queuedCount: 1, turnActive: false })).toBe(false);
    expect(sessionReviewOffered({ ...offered, queuedCount: 1, turnActive: true })).toBe(false);
    expect(sessionReviewOffered({ ...offered, queuedCount: 0, turnActive: true })).toBe(false);
    expect(sessionReviewOffered({ ...offered, queuedCount: 0, turnActive: false })).toBe(true);
  });
});
