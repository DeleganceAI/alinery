// Which relation edges get painted this frame, and where they run. Pure and React-free: the
// paint loop asks visiblePipes() once per frame and strokes whatever comes back, no math inline.
//
// Policy E: two kinds of edge, never both for the same relation at once.
//   - Ambient "trunks" (lod 0-1): one bundled edge per (hull, hull, kind), docked to the
//     hull boundary. This is the board-level "these two topics relate" signal and stays
//     legible regardless of how many tasks sit inside either hull.
//   - "Stubs" (any lod < 2, only while a task is focused): the real per-task edges for the
//     selected/connect-source task. A cross-hull relation contributes one stub per side, each
//     running from its card out to the hull dock the trunk already lands on, so card, stub,
//     trunk and stub read as one continuous path. Same-hull and free-float relations are drawn
//     whole here - trunks skip those on purpose (there is no hull boundary to dock them to).
// lod 2 (task detail) paints neither: the tier is one task at a time, not a relation map.
//
// Everything is orthogonal and routed through the gutters the packer already leaves empty: the
// PACK_PAD ring inside a hull, the PACK_GAP between rows and columns, and the open space
// between two hulls. A pipe that cuts diagonally across a card is the "spaghetti" the POC's
// router existed to kill, so the invariant the tests hold is geometric: no segment of a pipe
// passes through the interior of a card that is not one of its own endpoints.

import type { CanvasConcept, CanvasRelation, CanvasRelationKind, TaskId } from "../types";
import type { PaintedCard } from "./ids";
import { CARD_H, CARD_W, PACK_GAP, PACK_HEADER, PACK_PAD } from "./pack";

export type PipePoint = { x: number; y: number };

export type Pipe = {
  /** Stable paint key. */
  key: string;
  kind: CanvasRelationKind;
  level: "trunk" | "stub";
  /** Orthogonal polyline, world units, at least two points. */
  pts: PipePoint[];
  /** Relations bundled into this pipe. 1 for stubs. */
  count: number;
};

type VisiblePipesInput = {
  lod: 0 | 1 | 2;
  concepts: readonly CanvasConcept[];
  cards: readonly PaintedCard[];
  relations: readonly CanvasRelation[];
  selected?: TaskId | null;
  connectSource?: TaskId | null;
};

type Box = { x: number; y: number; w: number; h: number };

/**
 * How far from a box's corners a dock may sit. Keeps a pipe off the corner radius, and stops
 * two docks on the same edge collapsing onto the same point.
 */
const DOCK_INSET = 14;
/** Clearance for a lane that has to clear both hulls because they overlap. */
const LANE_CLEARANCE = 24;

const clamp = (v: number, lo: number, hi: number): number => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
const centre = (b: Box): PipePoint => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const cardBox = (card: { x: number; y: number }): Box => ({ x: card.x, y: card.y, w: CARD_W, h: CARD_H });

/**
 * The point on `box`'s border where a ray from its centre toward `(tx, ty)` leaves, snapped to
 * whichever edge that ray actually crosses and inset from the corners. Unlike a radial point,
 * this always sits on one flat edge, which is what lets the next segment leave at a right angle.
 */
function dockOnEdge(box: Box, tx: number, ty: number): PipePoint {
  const c = centre(box);
  const dx = tx - c.x;
  const dy = ty - c.y;
  if (dx === 0 && dy === 0) return c;
  const inset = Math.min(DOCK_INSET, box.w / 2, box.h / 2);
  // Compare the ray's slope against the box's own aspect: |dx|/|dy| > w/h means it leaves
  // through a side, not the top or bottom.
  if (Math.abs(dx) * box.h > Math.abs(dy) * box.w) {
    const y = c.y + (dy * (box.w / 2)) / Math.abs(dx);
    return { x: dx > 0 ? box.x + box.w : box.x, y: clamp(y, box.y + inset, box.y + box.h - inset) };
  }
  const x = c.x + (dx * (box.h / 2)) / Math.abs(dy);
  return { y: dy > 0 ? box.y + box.h : box.y, x: clamp(x, box.x + inset, box.x + box.w - inset) };
}

/** Signed gap between two boxes on one axis. Positive means they are separated. */
const gapOn = (aLo: number, aHi: number, bLo: number, bHi: number): number => Math.max(bLo - aHi, aLo - bHi);

/**
 * Two boxes with open space around them: out of one facing edge, along the gutter between them,
 * into the other. This is the trunk between two hulls and, because a free-floating card has no
 * hull to route inside either, also the whole edge between two cards where one is unplaced.
 *
 * The wider of the two gutters wins, so a diagonal pair uses whichever side has more room. Boxes
 * that overlap on both axes have no gutter at all and route over the top of both - the one case
 * where the pipe leaves the space between them, because there is no space between them.
 *
 * Docking on the *facing* edge is what stops a two-segment elbow turning inside the destination:
 * an elbow's corner sits at one box's centre line, which is inside that box whenever the two
 * overlap on an axis. That bug shipped, and it looked exactly like a pipe impaling a card.
 */
function lanePath(a: Box, b: Box): PipePoint[] {
  const ca = centre(a);
  const cb = centre(b);
  const gapX = gapOn(a.x, a.x + a.w, b.x, b.x + b.w);
  const gapY = gapOn(a.y, a.y + a.h, b.y, b.y + b.h);

  if (gapX > 0 && gapX >= gapY) {
    // Side by side: dock on the facing sides at each box's own centre height, so both ends
    // leave horizontally into the vertical gutter between them.
    const p0 = dockOnEdge(a, cb.x, ca.y);
    const p1 = dockOnEdge(b, ca.x, cb.y);
    const midX = (p0.x + p1.x) / 2;
    return [p0, { x: midX, y: p0.y }, { x: midX, y: p1.y }, p1];
  }
  if (gapY > 0) {
    const p0 = dockOnEdge(a, ca.x, cb.y);
    const p1 = dockOnEdge(b, cb.x, ca.y);
    const midY = (p0.y + p1.y) / 2;
    return [p0, { x: p0.x, y: midY }, { x: p1.x, y: midY }, p1];
  }
  // Overlapping or nested: any lane between them would be inside one of them, so go over both.
  const laneY = Math.min(a.y, b.y) - LANE_CLEARANCE;
  const p0 = { x: clamp(ca.x, a.x + DOCK_INSET, a.x + a.w - DOCK_INSET), y: a.y };
  const p1 = { x: clamp(cb.x, b.x + DOCK_INSET, b.x + b.w - DOCK_INSET), y: b.y };
  return [p0, { x: p0.x, y: laneY }, { x: p1.x, y: laneY }, p1];
}

/** The clear ring the packer leaves inside a hull: below the label band, inside the padding. */
function innerRing(hull: Box) {
  return { top: hull.y + PACK_HEADER, left: hull.x, right: hull.x + hull.w, bottom: hull.y + hull.h };
}

/**
 * Picks the lane just outside one of a card's two faces on an axis, preferring `first`. A lane is
 * only rejected for being outside the hull, never for being outside the card - clamping a lane
 * into the hull could put it inside the card it is leaving, which draws a pipe through its own
 * endpoint. A card dragged flush against the hull's edge has no room on that side, and a pipe that
 * skims just outside the hull there is a far smaller lie than one that crosses the card.
 */
function laneBeside(first: number, second: number, lo: number, hi: number): number {
  if (first >= lo && first <= hi) return first;
  if (second >= lo && second <= hi) return second;
  return first;
}

/**
 * A card to a point on its own hull's border, staying in the packer's gutters. The card is left
 * through the face that faces the free gutter, the path runs in that gutter to the hull's margin
 * ring, and only then turns toward the dock - so it passes beside sibling cards, never over them.
 */
function stubPath(card: Box, hull: Box, dock: PipePoint): PipePoint[] {
  const c = centre(card);
  const ring = innerRing(hull);
  const onSide = Math.abs(dock.x - hull.x) < 0.5 || Math.abs(dock.x - (hull.x + hull.w)) < 0.5;

  if (onSide) {
    // Vertical dock: drop into the row gutter, run to the side margin, then along it.
    const below = dock.y >= c.y;
    const laneY = laneBeside(
      below ? card.y + card.h + PACK_GAP / 2 : card.y - PACK_GAP / 2,
      below ? card.y - PACK_GAP / 2 : card.y + card.h + PACK_GAP / 2,
      ring.top + PACK_GAP / 2,
      ring.bottom - PACK_PAD / 2,
    );
    const laneX = dock.x <= hull.x + hull.w / 2 ? hull.x + PACK_PAD / 2 : hull.x + hull.w - PACK_PAD / 2;
    const exit = { x: c.x, y: laneY > c.y ? card.y + card.h : card.y };
    return [exit, { x: c.x, y: laneY }, { x: laneX, y: laneY }, { x: laneX, y: dock.y }, dock];
  }

  // Horizontal dock: leave sideways into the column gutter, run to the top or bottom margin.
  const right = dock.x >= c.x;
  const laneX = laneBeside(
    right ? card.x + card.w + PACK_GAP / 2 : card.x - PACK_GAP / 2,
    right ? card.x - PACK_GAP / 2 : card.x + card.w + PACK_GAP / 2,
    ring.left + PACK_PAD / 2,
    ring.right - PACK_PAD / 2,
  );
  const laneY = dock.y <= hull.y + hull.h / 2 ? ring.top + PACK_PAD / 2 : ring.bottom - PACK_PAD / 2;
  const exit = { x: laneX > c.x ? card.x + card.w : card.x, y: c.y };
  return [exit, { x: laneX, y: c.y }, { x: laneX, y: laneY }, { x: dock.x, y: laneY }, dock];
}

/**
 * Two cards in the same hull. Cards sharing a row or a column route through the gutter beside that
 * row or column - not straight between the pair, because a sibling may sit between them. Cards
 * sharing neither use the midpoint of whichever gap actually separates them.
 *
 * Every lane here is outside both cards by construction. The "same row" tolerance is 0.6 of a card,
 * so two hand-dragged cards can be a *long* way apart vertically and still count as one row; a lane
 * derived from their midpoint would sit inside one of them, which is why the gap is measured from
 * the faces rather than the centres. Cards that overlap on both axes have no lane at all and fall
 * through to `lanePath`, which goes over the top of both.
 */
function intraPath(a: Box, b: Box, hull: Box): PipePoint[] {
  const ca = centre(a);
  const cb = centre(b);
  const ring = innerRing(hull);
  const sameRow = Math.abs(ca.y - cb.y) < CARD_H * 0.6;
  const sameColumn = Math.abs(ca.x - cb.x) < CARD_W * 0.6;
  const acrossRow = (laneY: number): PipePoint[] => [
    { x: ca.x, y: laneY > ca.y ? a.y + a.h : a.y },
    { x: ca.x, y: laneY },
    { x: cb.x, y: laneY },
    { x: cb.x, y: laneY > cb.y ? b.y + b.h : b.y },
  ];

  if (sameRow && !sameColumn) {
    const under = Math.max(a.y + a.h, b.y + b.h) + PACK_GAP / 2;
    return acrossRow(under <= ring.bottom - PACK_PAD / 2 ? under : Math.min(a.y, b.y) - PACK_GAP / 2);
  }
  if (sameColumn && !sameRow) {
    const beside = Math.max(a.x + a.w, b.x + b.w) + PACK_GAP / 2;
    const laneX = beside <= ring.right - PACK_PAD / 2 ? beside : Math.min(a.x, b.x) - PACK_GAP / 2;
    return [
      { x: laneX > ca.x ? a.x + a.w : a.x, y: ca.y },
      { x: laneX, y: ca.y },
      { x: laneX, y: cb.y },
      { x: laneX > cb.x ? b.x + b.w : b.x, y: cb.y },
    ];
  }
  // Neither shared, or nearly on top of each other: use the gap that really exists.
  const gapY = gapOn(a.y, a.y + a.h, b.y, b.y + b.h);
  if (gapY > 0) return acrossRow((Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2);
  return lanePath(a, b);
}

/**
 * The pipe under construction. It leaves the source card's face and ends wherever the relation
 * currently points: the cursor while the user is still choosing a target, and the target card's
 * own face once the pair is picked - so the line the user drew stays visibly attached to both
 * cards while the kind is chosen, instead of vanishing behind the picker.
 */
export function lassoOf(
  source: TaskId | null,
  pair: { a: TaskId; b: TaskId } | null,
  cards: readonly PaintedCard[],
  cursor: PipePoint | null,
): { from: PipePoint; to: PipePoint } | null {
  if (!source) return null;
  const from = cards.find((c) => c.slug === source);
  if (!from) return null;
  const target = pair ? cards.find((c) => c.slug === pair.b) : undefined;
  const at = target ? centre(cardBox(target)) : cursor;
  if (!at) return null;
  const tip = target ? dockOnEdge(cardBox(target), centre(cardBox(from)).x, centre(cardBox(from)).y) : at;
  return { from: dockOnEdge(cardBox(from), at.x, at.y), to: tip };
}

export function visiblePipes(input: VisiblePipesInput): Pipe[] {
  if (input.lod === 2) return [];

  const cardBySlug = new Map<TaskId, PaintedCard>();
  for (const card of input.cards) cardBySlug.set(card.slug, card);
  const hullById = new Map<string, CanvasConcept>();
  for (const concept of input.concepts) hullById.set(concept.id, concept);

  // Bundle relations whose endpoints sit in different, existing hulls. A relation whose
  // endpoint has no painted card is a dangling reference (1.10: unknown slugs are kept on
  // disk by design), not corruption — it silently contributes no pipe.
  type Bundle = { c1: string; c2: string; kind: CanvasRelationKind; count: number };
  const trunkBundles = new Map<string, Bundle>();
  const bundleKeyOf = (c1: string, c2: string, kind: CanvasRelationKind) => `${c1}\u0000${c2}\u0000${kind}`;
  for (const rel of input.relations) {
    const cardA = cardBySlug.get(rel.a);
    const cardB = cardBySlug.get(rel.b);
    if (!cardA || !cardB) continue;
    const primaryA = cardA.concepts[0];
    const primaryB = cardB.concepts[0];
    if (!primaryA || !primaryB || primaryA === primaryB) continue;
    if (!hullById.has(primaryA) || !hullById.has(primaryB)) continue;
    const [c1, c2] = primaryA < primaryB ? [primaryA, primaryB] : [primaryB, primaryA];
    const key = bundleKeyOf(c1, c2, rel.kind);
    const existing = trunkBundles.get(key);
    if (existing) existing.count += 1;
    else trunkBundles.set(key, { c1, c2, kind: rel.kind, count: 1 });
  }

  const pipes: Pipe[] = [];
  // A stub has to land exactly where the trunk it feeds does, so the trunk's own endpoints are
  // the docks — remembered per bundle rather than recomputed and risking a mismatch.
  const docks = new Map<string, { a: PipePoint; b: PipePoint }>();
  for (const bundle of trunkBundles.values()) {
    const hullA = hullById.get(bundle.c1);
    const hullB = hullById.get(bundle.c2);
    if (!hullA || !hullB) continue;
    const pts = lanePath(hullA, hullB);
    docks.set(bundleKeyOf(bundle.c1, bundle.c2, bundle.kind), { a: pts[0], b: pts[pts.length - 1] });
    pipes.push({
      key: `trunk:${bundle.c1}:${bundle.c2}:${bundle.kind}`,
      kind: bundle.kind,
      level: "trunk",
      pts,
      count: bundle.count,
    });
  }

  const focus = input.selected ?? input.connectSource ?? null;
  if (focus) {
    for (const rel of input.relations) {
      if (rel.a !== focus && rel.b !== focus) continue;
      const cardA = cardBySlug.get(rel.a);
      const cardB = cardBySlug.get(rel.b);
      if (!cardA || !cardB) continue;
      const [sa, sb] = rel.a < rel.b ? [rel.a, rel.b] : [rel.b, rel.a];
      const stub = (pts: PipePoint[], suffix = "") => {
        pipes.push({ key: `stub:${sa}:${sb}:${rel.kind}${suffix}`, kind: rel.kind, level: "stub", pts, count: 1 });
      };
      const hullA = hullById.get(cardA.concepts[0] ?? "");
      const hullB = hullById.get(cardB.concepts[0] ?? "");
      // A free-floating endpoint has no hull to route inside and no trunk to feed, so the whole
      // edge is one lane. A card can sit visually inside a hull and still land here: drawing a
      // concept around a card does not capture it, membership is always explicit.
      if (!hullA || !hullB) {
        stub(lanePath(cardBox(cardA), cardBox(cardB)));
        continue;
      }
      if (hullA.id === hullB.id) {
        stub(intraPath(cardBox(cardA), cardBox(cardB), hullA));
        continue;
      }
      // Cross-hull: one stub per side, docking where this pair's trunk already lands.
      const [c1, c2] = hullA.id < hullB.id ? [hullA.id, hullB.id] : [hullB.id, hullA.id];
      const dock = docks.get(bundleKeyOf(c1, c2, rel.kind));
      if (!dock) continue;
      const dockA = hullA.id === c1 ? dock.a : dock.b;
      const dockB = hullB.id === c1 ? dock.a : dock.b;
      stub(stubPath(cardBox(cardA), hullA, dockA), `@${cardA.slug}`);
      stub(stubPath(cardBox(cardB), hullB, dockB), `@${cardB.slug}`);
    }
  }

  return pipes;
}
