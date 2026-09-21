import { describe, expect, it } from "vitest";
import type { CanvasConcept } from "../types";
import { ARRANGE_MARGIN, arrangeConcepts } from "./arrange";

const hull = (id: string, x: number, y: number, w = 240, h = 120): CanvasConcept => ({ id, name: id, x, y, w, h, manual: false });

describe("arrangeConcepts", () => {
  // 8.2 — an empty board has nothing to arrange, and must not be "arranged" into anything.
  it("returns an empty list unchanged", () => {
    expect(arrangeConcepts([])).toEqual([]);
  });

  // 8.1 — determinism is the whole contract of a reflow toggle: the same hulls must land in
  // the same places, or the board appears to shuffle itself between unrelated edits.
  it("is deterministic and sorts by y then x", () => {
    const input = [hull("right", 100, 10), hull("origin", 0, 0)];
    const first = arrangeConcepts(input);
    const second = arrangeConcepts(input);
    expect(first).toEqual(second);
    expect(first.map((c) => c.id)).toEqual(["origin", "right"]);
    expect(first[0]).toMatchObject({ x: 0, y: 0 });
    // Both hulls are 240 wide and the row budget is max(900, 240*2+28) = 900, so the second
    // sits beside the first with one margin between them.
    expect(first[1]).toMatchObject({ x: 240 + ARRANGE_MARGIN, y: 0 });
  });

  it("never mutates the input", () => {
    const input = [hull("a", 500, 500)];
    const snapshot = structuredClone(input);
    arrangeConcepts(input);
    expect(input).toEqual(snapshot);
  });

  // Row wrap: three 400-wide hulls have a budget of max(900, 828) = 900, so two fit per row.
  it("wraps a row once the budget is exceeded and clears to the tallest hull", () => {
    const packed = arrangeConcepts([hull("a", 0, 0, 400, 120), hull("b", 10, 0, 400, 300), hull("c", 20, 0, 400, 120)]);
    expect(packed[0]).toMatchObject({ x: 0, y: 0 });
    expect(packed[1]).toMatchObject({ x: 400 + ARRANGE_MARGIN, y: 0 });
    // The second row clears the tallest hull in the first, not the first hull's height.
    expect(packed[2]).toMatchObject({ x: 0, y: 300 + ARRANGE_MARGIN });
  });

  // A hull wider than the minimum budget must still start a row rather than be pushed off it.
  it("keeps an over-wide hull on its own row instead of dropping it", () => {
    const packed = arrangeConcepts([hull("wide", 0, 0, 2000, 200), hull("small", 0, 100, 240, 120)]);
    expect(packed[0]).toMatchObject({ x: 0, y: 0 });
    expect(packed[1]).toMatchObject({ x: 2000 + ARRANGE_MARGIN, y: 0 });
  });

  // Two hulls at the same position would otherwise depend on input order, which is the one
  // input a document rewrite can silently change.
  it("breaks position ties on id so the result never depends on document order", () => {
    const forward = arrangeConcepts([hull("a", 0, 0), hull("b", 0, 0)]);
    const reversed = arrangeConcepts([hull("b", 0, 0), hull("a", 0, 0)]);
    expect(forward).toEqual(reversed);
  });
});
