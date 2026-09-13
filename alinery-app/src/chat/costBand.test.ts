import { describe, expect, it } from "vitest";
import { costBand } from "./costBand";

describe("costBand", () => {
  it("keeps integers 0–5", () => {
    expect(costBand(0)).toBe(0);
    expect(costBand(2)).toBe(2);
    expect(costBand(5)).toBe(5);
  });

  it("hides missing and out-of-range values", () => {
    expect(costBand(undefined)).toBe(null);
    expect(costBand(null)).toBe(null);
    expect(costBand(6)).toBe(null);
    expect(costBand(-1)).toBe(null);
    expect(costBand(1.5)).toBe(null);
    expect(costBand("2")).toBe(null);
  });
});
