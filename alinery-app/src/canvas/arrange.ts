// Deterministic row packing for concept hulls.
//
// Auto-arrange is a toggle, not a one-shot: while it is on, the board reflows after the
// gestures that change what has to fit. That makes determinism the whole contract — the same
// set of hulls must land in the same places every time, or the board appears to shuffle
// itself between unrelated edits.
//
// Reading order (top-to-bottom, then left-to-right) is preserved by sorting on the hulls'
// current position before packing, so a reflow rearranges spacing without scrambling the
// arrangement the user already has in their head.

import type { CanvasConcept } from "../types";

export const ARRANGE_MARGIN = 28;
/** Minimum row width. A single wide hull must not force a one-per-row column. */
export const ARRANGE_MIN_BUDGET = 900;

export function arrangeConcepts(concepts: readonly CanvasConcept[]): CanvasConcept[] {
  if (concepts.length === 0) return [];

  const ordered = [...concepts].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1));
  const widest = Math.max(...ordered.map((c) => c.w));
  const budget = Math.max(ARRANGE_MIN_BUDGET, widest * 2 + ARRANGE_MARGIN);

  const packed: CanvasConcept[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const hull of ordered) {
    if (x > 0 && x + hull.w > budget) {
      x = 0;
      y += rowHeight + ARRANGE_MARGIN;
      rowHeight = 0;
    }
    packed.push({ ...hull, x, y });
    x += hull.w + ARRANGE_MARGIN;
    rowHeight = Math.max(rowHeight, hull.h);
  }
  return packed;
}
