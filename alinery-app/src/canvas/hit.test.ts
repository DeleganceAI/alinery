import { describe, expect, it } from "vitest";
import { ANCHOR_GAP, anchorPanel, hasMoved, shouldCreateConcept } from "./hit";

describe("hasMoved", () => {
  it("is false at 3px", () => {
    expect(hasMoved({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(false);
  });

  it("is true at 4px", () => {
    expect(hasMoved({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
  });

  // The lock is Euclidean, not Chebyshev: (3,3) has per-axis travel of only 3px but a
  // diagonal distance of 4.24px, so it must cross the threshold. (2,2) at 2.83px must not.
  it("uses Euclidean distance, not Chebyshev", () => {
    expect(hasMoved({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(true);
    expect(hasMoved({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe(false);
  });
});

describe("shouldCreateConcept", () => {
  // A long thin drag is a deliberate gesture, so it creates a concept and the thin axis snaps
  // up. Rejecting it (the original AND) silently threw away 300px of the author's intent.
  it("accepts a drag that clears the minimum on either axis", () => {
    expect(shouldCreateConcept(300, 20)).toBe(true);
    expect(shouldCreateConcept(20, 300)).toBe(true);
    expect(shouldCreateConcept(24, 0)).toBe(true);
  });

  it("rejects a twitch on both axes", () => {
    expect(shouldCreateConcept(23, 23)).toBe(false);
    expect(shouldCreateConcept(0, 0)).toBe(false);
  });
});

// The picker names two specific cards, so where it lands is part of what it says. jsdom has no
// layout, so the placement rule lives here as arithmetic rather than being eyeballed in a browser.
describe("anchorPanel", () => {
  const host = { w: 1000, h: 800 };
  const panel = { w: 240, h: 200 };

  it("sits to the card's right, aligned with its top", () => {
    const at = anchorPanel({ x: 100, y: 300 }, 260, panel.w, panel.h, host);
    expect(at).toEqual({ x: 100 + 260 + ANCHOR_GAP, y: 300 });
  });

  it("flips to the left when the right would overflow", () => {
    const at = anchorPanel({ x: 700, y: 100 }, 260, panel.w, panel.h, host);
    expect(at.x).toBe(700 - panel.w - ANCHOR_GAP);
  });

  // A card near the right edge with no room on either side: overflowing is worse than sitting on
  // the "wrong" side, so it clamps inside instead of flipping into the void.
  it("clamps into the host rather than overflowing either side", () => {
    const tight = anchorPanel({ x: 980, y: 100 }, 260, panel.w, panel.h, { w: 300, h: 800 });
    expect(tight.x).toBe(300 - panel.w - ANCHOR_GAP);
    const left = anchorPanel({ x: -400, y: 100 }, 260, panel.w, panel.h, host);
    expect(left.x).toBe(ANCHOR_GAP);
  });

  // Vertically it only moves as far as it must: a card low on screen lifts the panel just enough
  // to fit, and a panel taller than the host pins to the top so its first row stays visible.
  it("lifts a low panel into view and pins an oversized one to the top", () => {
    expect(anchorPanel({ x: 100, y: 700 }, 260, panel.w, panel.h, host).y).toBe(800 - panel.h - ANCHOR_GAP);
    expect(anchorPanel({ x: 100, y: 400 }, 260, panel.w, 900, host).y).toBe(ANCHOR_GAP);
  });
});
