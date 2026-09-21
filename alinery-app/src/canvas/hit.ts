// Pointer-gesture thresholds and pointer-adjacent screen geometry, shared by every canvas
// surface (cards, hulls, the draw tool, the panels that name what was just clicked).
// The two thresholds exist to tell a resting hand from an intentional one: a pointerdown/pointerup
// pair with almost no travel is a click, not a drag, and a freshly-drawn hull smaller than a
// thumbnail is an accidental nudge, not a request to create a concept.

/** Screen-px travel below which a pointerup is a click, not the start of a drag. */
export const CLICK_DRAG_PX = 4;

/** Minimum width/height (world px) a drawn rect must reach to become a concept. */
export const MIN_CONCEPT_PX = 24;

/**
 * Euclidean distance from `start`, not per-axis (Chebyshev): a diagonal flick of 3px on
 * each axis is a 4.24px drag and must count, even though neither axis alone crossed 4px.
 */
export function hasMoved(start: { x: number; y: number }, now: { x: number; y: number }): boolean {
  const dx = now.x - start.x;
  const dy = now.y - start.y;
  return Math.sqrt(dx * dx + dy * dy) >= CLICK_DRAG_PX;
}

/**
 * Either axis clearing MIN_CONCEPT_PX is intent: 300px of deliberate horizontal travel is a
 * concept the author asked for even if the drag was hairline-thin, and the thin axis is snapped
 * up to the one-card floor (`snapHullSize`) rather than the drag being thrown away. Only a
 * twitch on *both* axes — a click that slipped — creates nothing.
 */
export function shouldCreateConcept(w: number, h: number): boolean {
  return w >= MIN_CONCEPT_PX || h >= MIN_CONCEPT_PX;
}

/** Screen-px breathing room between an anchored panel and the card it belongs to. */
export const ANCHOR_GAP = 10;

/**
 * Where a panel goes so that it reads as belonging to one card: beside it, preferring the right,
 * flipping left when the right would overflow, and clamped into the host either way. A panel that
 * runs off the edge is worse than one on the "wrong" side, and a panel taller than the host is
 * pinned to the top rather than centred, because its first row is the one that has to be visible.
 */
export function anchorPanel(card: { x: number; y: number }, cardW: number, panelW: number, panelH: number, host: { w: number; h: number }): { x: number; y: number } {
  const right = card.x + cardW + ANCHOR_GAP;
  const left = card.x - panelW - ANCHOR_GAP;
  const x = right + panelW <= host.w || left < ANCHOR_GAP ? right : left;
  // Vertically: aligned with the card's top, nudged up only as far as needed to fit.
  const y = Math.min(card.y, host.h - panelH - ANCHOR_GAP);
  return {
    x: Math.min(Math.max(x, ANCHOR_GAP), Math.max(ANCHOR_GAP, host.w - panelW - ANCHOR_GAP)),
    y: Math.max(ANCHOR_GAP, y),
  };
}
