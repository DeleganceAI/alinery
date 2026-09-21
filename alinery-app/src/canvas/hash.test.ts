import { describe, expect, it } from "vitest";
import { createSceneHash, createSpatialHash, type HashItem } from "./hash";

describe("createSceneHash cardAt / conceptAt", () => {
  it("3.25 cardAt hits a card rect", () => {
    const scene = createSceneHash();
    const card: HashItem = { id: "card-a", x: 0, y: 0, w: 200, h: 72 };
    scene.rebuild({ cards: [card], concepts: [] });
    expect(scene.cardAt(10, 10)).toBe(card);
  });

  it("3.26 cardAt misses outside the rect", () => {
    const scene = createSceneHash();
    const card: HashItem = { id: "card-a", x: 0, y: 0, w: 200, h: 72 };
    scene.rebuild({ cards: [card], concepts: [] });
    expect(scene.cardAt(-1, -1)).toBeNull();
  });

  it("3.27 cardAt wins over an overlapping hull", () => {
    const scene = createSceneHash();
    const hull: HashItem = { id: "hull-a", x: 0, y: 0, w: 300, h: 300 };
    const card: HashItem = { id: "card-a", x: 50, y: 50, w: 200, h: 72 };
    scene.rebuild({ cards: [card], concepts: [hull] });
    // The literal 3.27 assert: cardAt still resolves to the card id at a point inside both.
    expect(scene.cardAt(60, 60)?.id).toBe("card-a");
    // The policy 3.27 exists to lock: the same point must never resolve to the hull once a
    // card claims it — otherwise a drag started on the card would grab the hull instead.
    expect(scene.conceptAt(60, 60)).toBeNull();
  });

  it("3.28 conceptAt returns the last inserted overlapping hull", () => {
    const scene = createSceneHash();
    const first: HashItem = { id: "hull-1", x: 0, y: 0, w: 200, h: 200 };
    const second: HashItem = { id: "hull-2", x: 50, y: 50, w: 200, h: 200 };
    scene.rebuild({ cards: [], concepts: [first, second] });
    expect(scene.conceptAt(100, 100)?.id).toBe("hull-2");
  });
});

describe("createSpatialHash queryRect", () => {
  it("3.29 queryRect returns only items overlapping the queried rect", () => {
    const hash = createSpatialHash();
    const near: HashItem = { id: "near", x: 0, y: 0, w: 200, h: 72 };
    const far: HashItem = { id: "far", x: 1000, y: 1000, w: 200, h: 72 };
    hash.rebuild([near, far]);
    const found = hash.queryRect(0, 0, 200, 72);
    expect(found).toEqual([near]);
  });

  it("3.29b an item wider than one cell is found from every cell it covers", () => {
    const hash = createSpatialHash();
    const hull: HashItem = { id: "hull", x: 200, y: 200, w: 400, h: 400 };
    hash.rebuild([hull]);
    // Cell size 256 means this 400x400 hull spans cells [0,1,2] on both axes — probing the
    // near corner and the far corner must both hit it, not just the origin cell.
    expect(hash.topAt(210, 210)?.id).toBe("hull");
    expect(hash.topAt(560, 560)?.id).toBe("hull");
    // queryRect scoped to only the far cell (cell (2,2): world [512,768) on each axis) must
    // still return the hull — proof it was indexed there, not only at its origin cell.
    expect(hash.queryRect(512, 512, 256, 256)).toEqual([hull]);
  });
});
