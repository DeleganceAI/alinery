import { describe, expect, it } from "vitest";
import type { BoardTask, CanvasConcept, CanvasDoc, TaskId } from "../types";
import { emptyCanvasDoc } from "./ids";
import { CARD_H, CARD_W, HULL_MIN_H, HULL_MIN_W, PACK_GAP, PACK_HEADER, PACK_PAD, packAllHulls, packConcept, packHull, snapHullSize } from "./pack";

function makeConcept(overrides: Partial<CanvasConcept> = {}): CanvasConcept {
  return { id: "c1", name: "concept", x: 0, y: 0, w: HULL_MIN_W, h: HULL_MIN_H, manual: false, ...overrides };
}

// Grid slots for a hull at (10, 20), derived so these tests pin the packing *behaviour* — array
// order, wrap at PACK_MAX_COLS, no mutation — rather than restating the card's dimensions.
const col = (i: number) => 10 + PACK_PAD + i * (CARD_W + PACK_GAP);
const row = (i: number) => 20 + PACK_HEADER + PACK_PAD + i * (CARD_H + PACK_GAP);

describe("packConcept", () => {
  // The floor is derived from one card, not hand-picked, so it moves with CARD_W/CARD_H. The
  // one place the actual numbers are pinned is the test below, so a geometry change is a
  // deliberate one-line edit and an accidental one is a failure.
  it("3.18 empty non-manual snaps to the one-card floor", () => {
    const concept = makeConcept({ w: 1, h: 1, manual: false });
    const { concept: resized, members } = packConcept(concept, []);
    expect(resized.w).toBe(HULL_MIN_W);
    expect(resized.h).toBe(HULL_MIN_H);
    expect(members).toEqual([]);
  });

  it("derives the floor from one card plus its padding", () => {
    expect([CARD_W, CARD_H]).toEqual([260, 152]);
    expect(HULL_MIN_W).toBe(292);
    expect(HULL_MIN_H).toBe(220);
  });

  it("3.19 empty manual keeps size", () => {
    const concept = makeConcept({ w: 400, h: 300, manual: true });
    const { concept: resized, members } = packConcept(concept, []);
    expect(resized.w).toBe(400);
    expect(resized.h).toBe(300);
    expect(members).toEqual([]);
  });

  it("3.20 never shrinks a manual hull", () => {
    // The hull already exceeds the one-card need on both axes, so packing must leave it alone.
    const concept = makeConcept({ w: 800, h: 600, manual: true });
    const { concept: resized } = packConcept(concept, [{ slug: "a" }]);
    expect(resized.w).toBe(800);
    expect(resized.h).toBe(600);
  });

  it("3.21 grows a too-small manual hull", () => {
    const concept = makeConcept({ w: 100, h: 80, manual: true });
    const needW = PACK_PAD * 2 + CARD_W;
    const needH = PACK_HEADER + PACK_PAD + CARD_H + PACK_PAD;
    const { concept: resized } = packConcept(concept, [{ slug: "a" }]);
    expect(resized.w).toBeGreaterThanOrEqual(needW);
    expect(resized.h).toBeGreaterThanOrEqual(needH);
  });

  it("3.22 auto uses max(min, need)", () => {
    const concept = makeConcept({ manual: false });
    const { concept: resized } = packConcept(concept, [{ slug: "a" }]);
    expect(resized.w).toBe(HULL_MIN_W);
    expect(resized.h).toBe(HULL_MIN_H);
  });

  // The point of deriving the floor: a hull at the minimum already fits one card, so adding
  // that card must not resize the hull the user drew.
  it("holds one card at the minimum without growing", () => {
    const { concept: resized, members } = packConcept(makeConcept({ w: HULL_MIN_W, h: HULL_MIN_H, manual: true }), [{ slug: "a" }]);
    expect(resized.w).toBe(HULL_MIN_W);
    expect(resized.h).toBe(HULL_MIN_H);
    expect(members[0].x + CARD_W).toBeLessThanOrEqual(resized.x + resized.w);
    expect(members[0].y + CARD_H).toBeLessThanOrEqual(resized.y + resized.h);
  });

  it("3.23 grids members in array order not status", () => {
    const concept = makeConcept({ x: 10, y: 20, manual: false });
    const before = { ...concept };
    const members: { slug: TaskId }[] = [{ slug: "a" }, { slug: "b" }, { slug: "c" }, { slug: "d" }];
    const { members: packed } = packConcept(concept, members);

    expect(packed).toEqual([
      { slug: "a", x: col(0), y: row(0) },
      { slug: "b", x: col(1), y: row(0) },
      { slug: "c", x: col(2), y: row(0) },
      { slug: "d", x: col(0), y: row(1) },
    ]);
    // 4th member wraps to row 1, col 0.
    expect(packed[3].x).toBe(packed[0].x);
    expect(packed[3].y).toBe(packed[0].y + CARD_H + PACK_GAP);
    // The input concept is never mutated.
    expect(concept).toEqual(before);
  });

  it("3.24 no status sort: positions follow the input array, not a shuffled phase field", () => {
    const concept = makeConcept({ x: 10, y: 20, manual: false });
    const members: ({ slug: TaskId } & { phase: string })[] = [
      { slug: "a", phase: "review" },
      { slug: "b", phase: "planning" },
      { slug: "c", phase: "done" },
      { slug: "d", phase: "coding" },
    ];
    const { members: packed } = packConcept(concept, members);

    expect(packed).toEqual([
      { slug: "a", x: col(0), y: row(0) },
      { slug: "b", x: col(1), y: row(0) },
      { slug: "c", x: col(2), y: row(0) },
      { slug: "d", x: col(0), y: row(1) },
    ]);
  });
});

describe("snapHullSize", () => {
  // A hull thinner or shorter than one card is a slot nothing can be placed in, so a sliver of
  // a drag is snapped up — per dimension, so the axis the user drew usably is left alone.
  it("snaps a sliver up on both axes", () => {
    expect(snapHullSize({ w: 30, h: 25 })).toEqual({ w: HULL_MIN_W, h: HULL_MIN_H });
  });

  it("snaps only the dimension that is too small", () => {
    expect(snapHullSize({ w: 900, h: 25 })).toEqual({ w: 900, h: HULL_MIN_H });
    expect(snapHullSize({ w: 30, h: 700 })).toEqual({ w: HULL_MIN_W, h: 700 });
  });

  it("leaves a hull that already fits a card exactly as drawn", () => {
    expect(snapHullSize({ w: 900, h: 700 })).toEqual({ w: 900, h: 700 });
    expect(snapHullSize({ w: HULL_MIN_W, h: HULL_MIN_H })).toEqual({ w: HULL_MIN_W, h: HULL_MIN_H });
  });

  // The floor has to be the packing floor, not a second opinion about it.
  it("agrees with what packing needs for one card", () => {
    const snapped = snapHullSize({ w: 1, h: 1 });
    const { concept } = packConcept({ id: "c", name: "n", x: 0, y: 0, ...snapped, manual: true }, [{ slug: "a" }]);
    expect({ w: concept.w, h: concept.h }).toEqual(snapped);
  });
});

function catalogTask(slug: string): BoardTask {
  return {
    slug,
    name: slug,
    branch: "",
    worktree: "",
    has_worktree: false,
    created: 0,
    archived: false,
    pr_url: "",
    linear_id: "",
    github_issue: "",
    playbook: "",
    auto_advance: [],
    draft: false,
    repo_path: "",
    session_count: 0,
    playbook_title: "",
    updated: 0,
    current_phase: "",
    current_step_title: "",
    latest_session_title: "",
    latest_session_column_key: "",
    current_column_key: "",
    current_column_title: "",
    artifact_count: 0,
    sessions: [],
  };
}

describe("packHull", () => {
  it("unknown id returns the same doc", () => {
    const doc = emptyCanvasDoc();
    expect(packHull(doc, "c_nope", [])).toBe(doc);
  });

  it("writes member x/y in array order", () => {
    const hull = makeConcept({ id: "c1", x: 10, y: 20 });
    const doc: CanvasDoc = {
      ...emptyCanvasDoc(),
      concepts: [hull],
      placements: {
        a: { concepts: ["c1"], x: 0, y: 0, placed: true },
        b: { concepts: ["c1"], x: 0, y: 0, placed: true },
      },
    };
    const next = packHull(doc, "c1", [catalogTask("a"), catalogTask("b")]);
    expect(next.placements.a).toMatchObject({ x: col(0), y: row(0) });
    expect(next.placements.b).toMatchObject({ x: col(1), y: row(0) });
    const packed = packConcept(hull, [{ slug: "a" }, { slug: "b" }]);
    expect(next.concepts[0].w).toBe(packed.concept.w);
    expect(next.concepts[0].h).toBe(packed.concept.h);
  });

  it("ignores cards whose primary is a different hull", () => {
    const doc: CanvasDoc = {
      ...emptyCanvasDoc(),
      concepts: [makeConcept({ id: "c1", x: 10, y: 20 })],
      placements: {
        a: { concepts: ["c1"], x: 0, y: 0, placed: true },
        other: { concepts: ["c2"], x: 99, y: 88, placed: true },
      },
    };
    const next = packHull(doc, "c1", [catalogTask("a"), catalogTask("other")]);
    expect(next.placements.other).toMatchObject({ x: 99, y: 88 });
  });
});

describe("packAllHulls", () => {
  it("folds packHull over every concept id", () => {
    const doc: CanvasDoc = {
      ...emptyCanvasDoc(),
      concepts: [makeConcept({ id: "c1", x: 10, y: 20 }), makeConcept({ id: "c2", x: 10, y: 20 })],
      placements: {
        a: { concepts: ["c1"], x: 0, y: 0, placed: true },
        b: { concepts: ["c2"], x: 0, y: 0, placed: true },
        free: { concepts: [], x: 7, y: 8, placed: true },
      },
    };
    const next = packAllHulls(doc, [catalogTask("a"), catalogTask("b"), catalogTask("free")]);
    expect(next.placements.a).toMatchObject({ x: col(0), y: row(0) });
    expect(next.placements.b).toMatchObject({ x: col(0), y: row(0) });
    expect(next.placements.free).toMatchObject({ x: 7, y: 8 });
  });
});
