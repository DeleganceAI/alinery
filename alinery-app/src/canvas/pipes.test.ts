import { describe, expect, it } from "vitest";
import type { CanvasConcept, CanvasRelation } from "../types";
import type { PaintedCard } from "./ids";
import { CARD_H, CARD_W, HULL_MIN_H, HULL_MIN_W, PACK_GAP, packConcept } from "./pack";
import { lassoOf, type Pipe, visiblePipes } from "./pipes";

// Minimal BoardTask stand-in: PaintedCard.task is never read by visiblePipes, so an
// unknown-shaped stub is enough to satisfy the type without dragging in the full fixture.
const stubTask = (slug: string) => ({ slug }) as PaintedCard["task"];

const hull = (id: string, x: number, y: number, w = HULL_MIN_W, h = HULL_MIN_H): CanvasConcept => ({ id, name: id, x, y, w, h, manual: true });

/**
 * A hull with its cards where the packer actually puts them. Routing is a claim about the
 * gutters the packer leaves, so hand-placed fixtures would test geometry that never occurs.
 */
function packed(concept: CanvasConcept, slugs: string[]): { concept: CanvasConcept; cards: PaintedCard[] } {
  const result = packConcept(
    concept,
    slugs.map((slug) => ({ slug })),
  );
  return {
    concept: result.concept,
    cards: result.members.map((m) => ({ slug: m.slug, task: stubTask(m.slug), x: m.x, y: m.y, concepts: [concept.id] })),
  };
}

const free = (slug: string, x: number, y: number): PaintedCard => ({ slug, task: stubTask(slug), x, y, concepts: [] });

const rel = (a: string, b: string, kind: CanvasRelation["kind"] = "blocks"): CanvasRelation => ({ a, b, kind });

const EPS = 1e-6;
type Box = { x: number; y: number; w: number; h: number };
const box = (card: PaintedCard): Box => ({ x: card.x, y: card.y, w: CARD_W, h: CARD_H });

function onBoundary(p: { x: number; y: number }, b: Box): boolean {
  const withinX = p.x >= b.x - EPS && p.x <= b.x + b.w + EPS;
  const withinY = p.y >= b.y - EPS && p.y <= b.y + b.h + EPS;
  const onVertical = Math.abs(p.x - b.x) < EPS || Math.abs(p.x - (b.x + b.w)) < EPS;
  const onHorizontal = Math.abs(p.y - b.y) < EPS || Math.abs(p.y - (b.y + b.h)) < EPS;
  return withinX && withinY && (onVertical || onHorizontal);
}

/** Does the segment's interior pass through the box's interior? Touching an edge does not count. */
function cuts(p: { x: number; y: number }, q: { x: number; y: number }, b: Box): boolean {
  // A zero-length span (every segment here is axis-aligned) overlaps only if it lies strictly
  // inside the box on that axis, which is exactly the "touching does not count" rule.
  const overlaps = (lo: number, hi: number, bLo: number, bHi: number) => Math.min(hi, bHi) - Math.max(lo, bLo) > EPS;
  return overlaps(Math.min(p.x, q.x), Math.max(p.x, q.x), b.x, b.x + b.w) && overlaps(Math.min(p.y, q.y), Math.max(p.y, q.y), b.y, b.y + b.h);
}

function segments(pipe: Pipe): [{ x: number; y: number }, { x: number; y: number }][] {
  const out: [{ x: number; y: number }, { x: number; y: number }][] = [];
  for (let i = 1; i < pipe.pts.length; i++) out.push([pipe.pts[i - 1], pipe.pts[i]]);
  return out;
}

const axisAligned = (pipe: Pipe): boolean => segments(pipe).every(([p, q]) => Math.abs(p.x - q.x) < EPS || Math.abs(p.y - q.y) < EPS);

describe("visiblePipes", () => {
  // 3.30
  it("visiblePipes at lod 2 is empty even if selected", () => {
    const left = packed(hull("c1", 0, 0), ["a"]);
    const right = packed(hull("c2", 600, 0), ["b"]);
    const pipes = visiblePipes({
      lod: 2,
      concepts: [left.concept, right.concept],
      cards: [...left.cards, ...right.cards],
      relations: [rel("a", "b")],
      selected: "a",
    });
    expect(pipes).toEqual([]);
  });

  // 3.31
  it("ambient lod 0-1 has one trunk per pair+kind, docked to the hulls and routed between them", () => {
    const left = packed(hull("c1", 0, 0), ["a"]);
    const right = packed(hull("c2", 600, 0), ["b"]);
    const pipes = visiblePipes({
      lod: 0,
      concepts: [left.concept, right.concept],
      cards: [...left.cards, ...right.cards],
      relations: [rel("a", "b", "blocks")],
    });
    expect(pipes.length).toBe(1);
    const [pipe] = pipes;
    expect(pipe.kind).toBe("blocks");
    expect(pipe.level).toBe("trunk");
    expect(axisAligned(pipe)).toBe(true);
    // Endpoints dock to the hull boundary, not the card centres.
    expect(onBoundary(pipe.pts[0], left.concept)).toBe(true);
    expect(onBoundary(pipe.pts[pipe.pts.length - 1], right.concept)).toBe(true);
    // The lane between them is in the gutter: outside both hulls, not through either.
    for (const [p, q] of segments(pipe)) {
      expect(cuts(p, q, left.concept)).toBe(false);
      expect(cuts(p, q, right.concept)).toBe(false);
    }
  });

  // 3.32
  it("same-hull pair has no ambient trunk", () => {
    const one = packed(hull("c1", 0, 0, HULL_MIN_W, 600), ["a", "b"]);
    const pipes = visiblePipes({ lod: 1, concepts: [one.concept], cards: one.cards, relations: [rel("a", "b")] });
    expect(pipes).toEqual([]);
  });

  // 3.33
  it("stubs appear only for the focused slug, and a cross-hull pair gets one per side", () => {
    const left = packed(hull("c1", 0, 0, HULL_MIN_W, 600), ["a", "b"]);
    const right = packed(hull("c2", 600, 0), ["x"]);
    const concepts = [left.concept, right.concept];
    const cards = [...left.cards, ...right.cards];
    const relations = [rel("a", "b", "surface"), rel("a", "x", "blocks"), rel("b", "x", "informs")];
    const pipes = visiblePipes({ lod: 1, concepts, cards, relations, selected: "a" });
    const stubs = pipes.filter((p) => p.level === "stub");
    // Same-hull "a"-"b" is one whole path; cross-hull "a"-"x" is two, one per side.
    expect(stubs.map((p) => p.key).sort()).toEqual(["stub:a:b:surface", "stub:a:x:blocks@a", "stub:a:x:blocks@x"]);
    // "b"-"x" does not touch the focused slug — nothing for it.
    expect(pipes.some((p) => p.key.startsWith("stub:b:x"))).toBe(false);
  });

  // A stub that does not land exactly where its trunk does draws a visible break in what the
  // user reads as one pipe. This is the seam, so it is asserted rather than eyeballed.
  it("each cross-hull stub starts on its own card and ends on the trunk's dock", () => {
    const left = packed(hull("c1", 0, 0), ["a"]);
    const right = packed(hull("c2", 600, 0), ["x"]);
    const pipes = visiblePipes({
      lod: 1,
      concepts: [left.concept, right.concept],
      cards: [...left.cards, ...right.cards],
      relations: [rel("a", "x", "blocks")],
      selected: "a",
    });
    const trunk = pipes.find((p) => p.level === "trunk") as Pipe;
    const stubA = pipes.find((p) => p.key.endsWith("@a")) as Pipe;
    const stubX = pipes.find((p) => p.key.endsWith("@x")) as Pipe;
    expect(onBoundary(stubA.pts[0], box(left.cards[0]))).toBe(true);
    expect(onBoundary(stubX.pts[0], box(right.cards[0]))).toBe(true);
    expect(stubA.pts[stubA.pts.length - 1]).toEqual(trunk.pts[0]);
    expect(stubX.pts[stubX.pts.length - 1]).toEqual(trunk.pts[trunk.pts.length - 1]);
    expect(axisAligned(stubA)).toBe(true);
    expect(axisAligned(stubX)).toBe(true);
  });
  // 3.34
  it("connectSource is equivalent to selected for stubs", () => {
    const left = packed(hull("c1", 0, 0, HULL_MIN_W, 600), ["a", "b"]);
    const right = packed(hull("c2", 600, 0), ["x"]);
    const concepts = [left.concept, right.concept];
    const cards = [...left.cards, ...right.cards];
    const relations = [rel("a", "b", "surface"), rel("a", "x", "blocks")];
    const bySelected = visiblePipes({ lod: 1, concepts, cards, relations, selected: "a" });
    const byConnectSource = visiblePipes({ lod: 1, concepts, cards, relations, connectSource: "a" });
    expect(byConnectSource).toEqual(bySelected);
  });

  // 3.35
  it("two blocks relations between the same hull pair bundle into one trunk", () => {
    const left = packed(hull("c1", 0, 0, HULL_MIN_W, 600), ["a1", "a2"]);
    const right = packed(hull("c2", 600, 0, HULL_MIN_W, 600), ["b1", "b2"]);
    const pipes = visiblePipes({
      lod: 0,
      concepts: [left.concept, right.concept],
      cards: [...left.cards, ...right.cards],
      relations: [rel("a1", "b1", "blocks"), rel("a2", "b2", "blocks")],
    });
    const trunks = pipes.filter((p) => p.level === "trunk");
    expect(trunks).toHaveLength(1);
    expect(trunks[0].count).toBe(2);
  });

  // Both stubs of a bundled pair dock at the same two points — that is what makes a bundle read
  // as one highway with feeders rather than as two parallel edges.
  it("bundled relations share the trunk's docks", () => {
    const left = packed(hull("c1", 0, 0, HULL_MIN_W, 600), ["a1", "a2"]);
    const right = packed(hull("c2", 600, 0, HULL_MIN_W, 600), ["b1", "b2"]);
    const pipes = visiblePipes({
      lod: 1,
      concepts: [left.concept, right.concept],
      cards: [...left.cards, ...right.cards],
      relations: [rel("a1", "b1", "blocks"), rel("a1", "b2", "blocks")],
      selected: "a1",
    });
    const trunk = pipes.find((p) => p.level === "trunk") as Pipe;
    const landings = pipes.filter((p) => p.level === "stub").map((p) => p.pts[p.pts.length - 1]);
    expect(landings).toHaveLength(4);
    for (const at of landings) expect([trunk.pts[0], trunk.pts[trunk.pts.length - 1]]).toContainEqual(at);
  });

  // 3.36
  it("skips a relation whose endpoint is not painted, without throwing, and still emits others", () => {
    const left = packed(hull("c1", 0, 0), ["a"]);
    const right = packed(hull("c2", 600, 0), ["b"]);
    let pipes: Pipe[] = [];
    expect(() => {
      pipes = visiblePipes({
        lod: 0,
        concepts: [left.concept, right.concept],
        cards: [...left.cards, ...right.cards],
        relations: [rel("a", "ghost", "blocks"), rel("a", "b", "informs")],
      });
    }).not.toThrow();
    expect(pipes).toHaveLength(1);
    expect(pipes[0].key).toBe("trunk:c1:c2:informs");
  });

  // A free-floating card has no hull to route inside and no trunk to feed, so it gets the whole
  // edge as one lane. Losing this case would silently drop every relation a user makes before
  // dropping either card into a concept.
  it("draws a free-float relation as one whole lane, docked on both cards", () => {
    const one = packed(hull("c1", 0, 0), ["a"]);
    const loose = free("f", 800, 400);
    const pipes = visiblePipes({
      lod: 1,
      concepts: [one.concept],
      cards: [...one.cards, loose],
      relations: [rel("a", "f", "informs")],
      selected: "f",
    });
    expect(pipes.map((p) => p.level)).toEqual(["stub"]);
    expect(axisAligned(pipes[0])).toBe(true);
    expect(onBoundary(pipes[0].pts[0], box(one.cards[0]))).toBe(true);
    expect(onBoundary(pipes[0].pts[pipes[0].pts.length - 1], box(loose))).toBe(true);
  });

  // Same-hull edges are the case a trunk cannot express, so their lane has to come from the pack
  // geometry. The packer fills rows left to right (`cols = min(3, n)`), so which gutter is the
  // right one depends on how the two cards ended up sitting, and all three cases are reachable
  // by the user in one hull.
  describe("same-hull routing uses the packer's gutters", () => {
    const laneOf = (slugs: string[], a: string, b: string) => {
      const one = packed(hull("c1", 0, 0, 900, 700), slugs);
      const pipes = visiblePipes({ lod: 1, concepts: [one.concept], cards: one.cards, relations: [rel(a, b, "surface")], selected: a });
      expect(pipes.map((p) => p.level)).toEqual(["stub"]);
      expect(axisAligned(pipes[0])).toBe(true);
      const byId = new Map(one.cards.map((c) => [c.slug, c]));
      return { pipe: pipes[0], hull: one.concept, cards: one.cards, a: byId.get(a) as PaintedCard, b: byId.get(b) as PaintedCard };
    };

    it("runs under a pair that shares a row", () => {
      const { pipe, a, b } = laneOf(["a", "b"], "a", "b");
      expect(a.y).toBe(b.y);
      const laneY = pipe.pts[1].y;
      expect(laneY).toBeGreaterThan(a.y + CARD_H);
      expect(laneY).toBeLessThan(a.y + CARD_H + PACK_GAP);
    });

    it("runs beside a pair that shares a column", () => {
      const { pipe, a, b, cards } = laneOf(["a", "b", "c", "d"], "a", "d");
      expect(a.x).toBe(b.x);
      expect(a.y).not.toBe(b.y);
      const laneX = pipe.pts[1].x;
      // In the column gutter: clear of this column's cards and of the next column's.
      expect(laneX).toBeGreaterThan(a.x + CARD_W);
      expect(laneX).toBeLessThan((cards[1] as PaintedCard).x);
    });

    it("runs through the row gap for a pair sharing neither", () => {
      const { pipe, a, b } = laneOf(["a", "b", "c", "d", "e"], "a", "e");
      expect(a.x).not.toBe(b.x);
      expect(a.y).not.toBe(b.y);
      const laneY = pipe.pts[1].y;
      expect(laneY).toBe((a.y + CARD_H + b.y) / 2);
    });
  });
});

/**
 * The invariant the whole router exists to hold: no segment of a pipe may pass through the
 * interior of *any* card, including the two it connects. Touching a face is how a pipe docks;
 * entering the box is the bug.
 *
 * The endpoint cards were originally exempt from this, on the reasoning that a pipe obviously
 * touches its own endpoints - and that exemption hid a real defect for a release: a two-segment
 * elbow between two cards at the same height turned *inside* the target and left through its
 * bottom edge, drawn straight across the card's face. Hence "any card".
 */
function expectClearOfCards(pipes: readonly Pipe[], cards: readonly PaintedCard[]): void {
  expect(pipes.length).toBeGreaterThan(0);
  for (const pipe of pipes) {
    expect(axisAligned(pipe), `${pipe.key} is not orthogonal`).toBe(true);
    for (const card of cards) {
      for (const [p, q] of segments(pipe)) {
        const where = `(${p.x},${p.y}) → (${q.x},${q.y})`;
        expect(cuts(p, q, box(card)), `${pipe.key} passes through ${card.slug} at ${where}`).toBe(false);
      }
    }
  }
}

describe("clearance", () => {
  // A straight centre-to-centre edge fails this the moment a hull holds more than two cards,
  // which is what "spaghetti" looked like.
  it("routes around cards in a packed board", () => {
    const left = packed(hull("c1", 0, 0, 900, 700), ["a", "b", "c", "d"]);
    const right = packed(hull("c2", 1100, 200, 900, 700), ["w", "x", "y", "z"]);
    const cards = [...left.cards, ...right.cards];
    const relations = [rel("a", "z", "blocks"), rel("a", "d", "surface"), rel("b", "y", "informs")];
    expectClearOfCards(visiblePipes({ lod: 1, concepts: [left.concept, right.concept], cards, relations, selected: "a" }), cards);
  });

  // The reported case, to scale: two cards at the same height, one of them free-floating inside a
  // concept it is not a member of (drawing a hull around a card does not capture it). The pipe
  // used to enter the target's face and turn inside it; it must dock on the leading edge instead.
  it("docks on the leading edge of a free card level with its partner", () => {
    const left = packed(hull("c1", 0, 0, 536, 544), ["a"]);
    const loose = free("f", 620, 52);
    const cards = [...left.cards, loose];
    const pipes = visiblePipes({
      lod: 1,
      concepts: [left.concept, hull("c2", 580, 12, 539, 531)],
      cards,
      relations: [rel("a", "f", "blocks")],
      selected: "f",
    });
    expectClearOfCards(pipes, cards);
    // Leading edges: out of the source's right face, into the free card's left face.
    const [pipe] = pipes;
    expect(pipe.pts[0].x).toBe(left.cards[0].x + CARD_W);
    expect(pipe.pts[pipe.pts.length - 1].x).toBe(loose.x);
  });

  // Hand-dragged cards break every assumption the packer's grid provides: flush against a hull
  // edge (so the preferred lane has no room), overlapping the label band, and far enough apart
  // vertically to count as "the same row" while still overlapping. Each of these produced a lane
  // inside a card under the arithmetic that shipped.
  it("routes around hand-dragged cards with no grid to rely on", () => {
    const concept = hull("c1", 0, 0, 900, 500);
    const far = hull("c2", 1200, 0, 400, 500);
    const cards: PaintedCard[] = [
      { slug: "flush", task: stubTask("flush"), x: 16, y: 500 - CARD_H, concepts: ["c1"] },
      { slug: "under-label", task: stubTask("under-label"), x: 320, y: 10, concepts: ["c1"] },
      { slug: "offset-row", task: stubTask("offset-row"), x: 620, y: 100, concepts: ["c1"] },
      { slug: "far", task: stubTask("far"), x: 1216, y: 200, concepts: ["c2"] },
    ];
    const relations = [rel("flush", "far", "blocks"), rel("flush", "under-label", "surface"), rel("flush", "offset-row", "informs")];
    expectClearOfCards(visiblePipes({ lod: 1, concepts: [concept, far], cards, relations, selected: "flush" }), cards);
  });

  // Two cards dropped on top of each other have no lane between them at all; the pipe has to
  // leave both and go around rather than run from centre to centre through both faces.
  it("goes around a pair that overlaps on both axes", () => {
    const concept = hull("c1", 0, 0, 900, 500);
    const cards: PaintedCard[] = [
      { slug: "under", task: stubTask("under"), x: 100, y: 100, concepts: ["c1"] },
      { slug: "over", task: stubTask("over"), x: 140, y: 130, concepts: ["c1"] },
    ];
    expectClearOfCards(visiblePipes({ lod: 1, concepts: [concept], cards, relations: [rel("under", "over")], selected: "over" }), cards);
  });
});

// The line being drawn is the only feedback that connect mode is live at all: without it the
// first right-click looks like nothing happened, which is the complaint this answers.
describe("lassoOf", () => {
  const cards = [free("a", 0, 0), free("b", 600, 400)];

  it("is nothing when no connect is in flight", () => {
    expect(lassoOf(null, null, cards, { x: 10, y: 10 })).toBe(null);
  });

  it("reaches from the source card's face to the cursor", () => {
    const lasso = lassoOf("a", null, cards, { x: 500, y: 40 });
    expect(lasso?.to).toEqual({ x: 500, y: 40 });
    // Leaves the card's own boundary, so the line is never drawn from under the card.
    expect(onBoundary(lasso?.from as { x: number; y: number }, box(cards[0]))).toBe(true);
  });

  // Once the pair is picked the cursor is on its way to the picker, so the line has to hold the
  // two cards it is about instead of trailing the pointer off to the panel.
  it("holds both cards once a target is picked, ignoring where the cursor went", () => {
    const lasso = lassoOf("a", { a: "a", b: "b" }, cards, { x: 5, y: 5 });
    expect(onBoundary(lasso?.from as { x: number; y: number }, box(cards[0]))).toBe(true);
    expect(onBoundary(lasso?.to as { x: number; y: number }, box(cards[1]))).toBe(true);
  });

  // A cursor that never moved and a source that is not on the board are both reachable states
  // (right-click, then the catalog poll drops the task); neither may throw or draw a line to 0,0.
  it("is nothing when the source is unpainted or the cursor is unknown", () => {
    expect(lassoOf("ghost", null, cards, { x: 10, y: 10 })).toBe(null);
    expect(lassoOf("a", null, cards, null)).toBe(null);
  });
});
