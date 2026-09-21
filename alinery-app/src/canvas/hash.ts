// Uniform-grid spatial index for the Orbitron canvas. Cards and concept hulls are painted
// on a plain 2D canvas, not the DOM, so hit-testing and viewport culling cannot lean on
// browser layout at all — every click, drag start, and scroll-driven repaint has to answer
// "what is under this point / inside this rect" against a scene that can hold hundreds of
// items. A uniform grid keeps both queries close to O(1) per cell without the bookkeeping
// of a quadtree, which this scene's roughly-uniform card/hull sizes do not need.

export const HASH_CELL = 256;

export type HashItem = { id: string; x: number; y: number; w: number; h: number };

export type SpatialHash = {
  rebuild(items: readonly HashItem[]): void;
  queryRect(x: number, y: number, w: number, h: number): HashItem[];
  topAt(wx: number, wy: number): HashItem | null;
};

// Half-open AABBs (`x <= p && p < x + w`) everywhere below, so a point sitting exactly on a
// shared edge between two items belongs to exactly one of them, never both or neither.
const EDGE_EPS = 1e-6;

function cellSpan(pos: number, size: number, cell: number): { min: number; max: number } {
  const min = Math.floor(pos / cell);
  if (size <= 0) return { min, max: min };
  // Subtract a hair below the far edge so an item that ends exactly on a cell boundary
  // (e.g. x=0, w=256, cell=256) is not also registered into the next cell it never covers.
  const max = Math.floor((pos + size - EDGE_EPS) / cell);
  return { min, max: Math.max(min, max) };
}

function rectsOverlap(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function containsPoint(item: HashItem, px: number, py: number): boolean {
  return px >= item.x && px < item.x + item.w && py >= item.y && py < item.y + item.h;
}

export function createSpatialHash(cell: number = HASH_CELL): SpatialHash {
  let items: HashItem[] = [];
  let grid = new Map<string, HashItem[]>();

  function rebuild(next: readonly HashItem[]): void {
    items = next.slice();
    grid = new Map();
    for (const item of items) {
      const cols = cellSpan(item.x, item.w, cell);
      const rows = cellSpan(item.y, item.h, cell);
      // Index into every cell the AABB overlaps, not just its origin cell — an item wider
      // or taller than one cell must be findable from each cell it crosses (3.29b).
      for (let cx = cols.min; cx <= cols.max; cx++) {
        for (let cy = rows.min; cy <= rows.max; cy++) {
          const key = `${cx},${cy}`;
          const bucket = grid.get(key);
          if (bucket) bucket.push(item);
          else grid.set(key, [item]);
        }
      }
    }
  }

  function candidates(x: number, y: number, w: number, h: number): Set<HashItem> {
    const cols = cellSpan(x, w, cell);
    const rows = cellSpan(y, h, cell);
    const found = new Set<HashItem>();
    for (let cx = cols.min; cx <= cols.max; cx++) {
      for (let cy = rows.min; cy <= rows.max; cy++) {
        const bucket = grid.get(`${cx},${cy}`);
        if (!bucket) continue;
        for (const item of bucket) found.add(item);
      }
    }
    return found;
  }

  function queryRect(x: number, y: number, w: number, h: number): HashItem[] {
    const found = candidates(x, y, w, h);
    // `found` may hold the same item once per cell it spans; filter the insertion-ordered
    // master list against the set instead of concatenating buckets, so each item comes
    // back exactly once and in rebuild order.
    return items.filter((item) => found.has(item) && rectsOverlap(item.x, item.y, item.w, item.h, x, y, w, h));
  }

  function topAt(wx: number, wy: number): HashItem | null {
    const found = candidates(wx, wy, 0, 0);
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (found.has(item) && containsPoint(item, wx, wy)) return item;
    }
    return null;
  }

  return { rebuild, queryRect, topAt };
}

export type SceneHash = {
  rebuild(scene: { cards: readonly HashItem[]; concepts: readonly HashItem[] }): void;
  cardAt(wx: number, wy: number): HashItem | null;
  conceptAt(wx: number, wy: number): HashItem | null;
  queryCards(x: number, y: number, w: number, h: number): HashItem[];
  queryConcepts(x: number, y: number, w: number, h: number): HashItem[];
};

export function createSceneHash(cell: number = HASH_CELL): SceneHash {
  const cardIndex = createSpatialHash(cell);
  const conceptIndex = createSpatialHash(cell);

  function rebuild(scene: { cards: readonly HashItem[]; concepts: readonly HashItem[] }): void {
    cardIndex.rebuild(scene.cards);
    conceptIndex.rebuild(scene.concepts);
  }

  function conceptAt(wx: number, wy: number): HashItem | null {
    // Cards are painted on top of their hull. A drag that starts on a card must move the
    // card, never the hull underneath it, so a hull hit only counts where no card claims
    // the same point first.
    if (cardIndex.topAt(wx, wy)) return null;
    return conceptIndex.topAt(wx, wy);
  }

  return {
    rebuild,
    cardAt: (wx, wy) => cardIndex.topAt(wx, wy),
    conceptAt,
    queryCards: (x, y, w, h) => cardIndex.queryRect(x, y, w, h),
    queryConcepts: (x, y, w, h) => conceptIndex.queryRect(x, y, w, h),
  };
}
