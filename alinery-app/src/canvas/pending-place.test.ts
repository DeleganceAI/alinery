import { describe, expect, it } from "vitest";
import { setPendingPlace, takePendingPlace } from "./pending-place";

describe("pending-place", () => {
  // 3.44 — take once: the last set value is returned exactly once, then null.
  it("takePendingPlace returns the last set value once then null", () => {
    setPendingPlace({ x: 1, y: 2, conceptId: "c1" });

    expect(takePendingPlace()).toEqual({ x: 1, y: 2, conceptId: "c1" });
    expect(takePendingPlace()).toBeNull();
  });

  // 3.45 — last write wins: setting B after A discards A.
  it("setPendingPlace overwrites", () => {
    setPendingPlace({ x: 1, y: 2, conceptId: "a" });
    setPendingPlace({ x: 3, y: 4, conceptId: "b" });

    expect(takePendingPlace()).toEqual({ x: 3, y: 4, conceptId: "b" });
  });
});
