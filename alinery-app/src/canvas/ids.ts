// The join layer between the task catalog (from ipc.ts) and the canvas doc (persisted
// separately, see types.ts). Nothing here talks to IPC or React: it is pure data-shaping,
// unit-tested without a DOM or a Tauri backend.

import type { BoardTask, CanvasDoc, CanvasPlacement, CanvasRelationKind, TaskId } from "../types";

export type { CanvasDoc, TaskId };

export type PaintedCard = {
  slug: TaskId;
  task: BoardTask;
  x: number;
  y: number;
  /** Full membership, doc order. `concepts[0]` is the primary hull; may be empty (free-float). */
  concepts: string[];
};

/**
 * Mirrors Rust `empty_canvas_doc()` in `src-tauri/src/canvas.rs`. Nothing compares the two
 * automatically, so keep this literal in sync with the Rust default by review.
 */
export function emptyCanvasDoc(): CanvasDoc {
  return {
    version: 1,
    concepts: [],
    placements: {},
    relations: [],
    view: { camX: 0, camY: 0, scale: 1, autoArrange: false, canvasEditMode: "requestApproval" },
  };
}

export function mintConceptId(): string {
  return `c_${crypto.randomUUID()}`;
}

/**
 * Paints one card per catalog slug that is both placed in the doc and present in the
 * catalog, in catalog order. Geometry comes from the doc only — the 3s catalog poll must
 * never move a card, so `x`/`y`/`concepts` never read from the (churning) catalog row.
 */
export function joinPainted(doc: CanvasDoc, catalog: BoardTask[]): PaintedCard[] {
  const seen = new Set<TaskId>();
  const painted: PaintedCard[] = [];
  for (const task of catalog) {
    if (seen.has(task.slug)) continue;
    seen.add(task.slug);
    const placement = doc.placements[task.slug];
    if (!placement?.placed) continue;
    painted.push({ slug: task.slug, task, x: placement.x, y: placement.y, concepts: placement.concepts });
  }
  return painted;
}

export function pickerPool(catalog: BoardTask[], placed: Set<TaskId>, showArchived: boolean): BoardTask[] {
  return catalog.filter((task) => {
    if (placed.has(task.slug)) return false;
    if (task.archived && !showArchived) return false;
    return true;
  });
}

/**
 * Renames one concept. The name is trimmed, an unknown id is a no-op, and nothing but that
 * one concept's name changes — membership and geometry are other functions' business.
 */
export function renameConcept(doc: CanvasDoc, id: string, name: string): CanvasDoc {
  return { ...doc, concepts: doc.concepts.map((c) => (c.id === id ? { ...c, name: name.trim() } : c)) };
}

/**
 * Removes a concept and strips it from every placement's membership. A placement that
 * loses its primary (`concepts[0]`) becomes unplaced rather than promoting the next chip —
 * a hull disappearing should never silently relocate a card into a different one.
 */
export function deleteConcept(doc: CanvasDoc, id: string): CanvasDoc {
  const placements: CanvasDoc["placements"] = {};
  for (const [slug, placement] of Object.entries(doc.placements)) {
    placements[slug] = stripConcept(placement, id);
  }
  return {
    ...doc,
    concepts: doc.concepts.filter((c) => c.id !== id),
    placements,
  };
}

function stripConcept(placement: CanvasPlacement, id: string): CanvasPlacement {
  if (!placement.concepts.includes(id)) return placement;
  const wasPrimary = placement.concepts[0] === id;
  const concepts = placement.concepts.filter((c) => c !== id);
  return { ...placement, concepts, placed: wasPrimary ? false : placement.placed };
}

/**
 * Reassigns which hull is primary for a placement. `null` drops the current primary
 * (shift, no promotion — the row simply has one fewer tag); a string id is moved to the
 * front of `concepts`, deduped so it never appears twice.
 */
export function setPrimary(doc: CanvasDoc, slug: TaskId, conceptId: string | null): CanvasDoc {
  const placement = doc.placements[slug];
  if (!placement) return doc;
  const concepts = conceptId === null ? placement.concepts.slice(1) : [conceptId, ...placement.concepts.filter((c) => c !== conceptId)];
  return { ...doc, placements: { ...doc.placements, [slug]: { ...placement, concepts } } };
}

/**
 * Places a task at a position. Membership is only edited when `conceptId` is supplied
 * (delegated to setPrimary) — without it, an existing row's `concepts` are left untouched
 * and a brand-new row starts empty. Drag-to-empty ("free-float") is the caller's explicit
 * `setPrimary(doc, slug, null)`, never an implicit side effect of placing.
 */
export function placeTask(doc: CanvasDoc, slug: TaskId, spec: { x: number; y: number; conceptId?: string }): CanvasDoc {
  const existing = doc.placements[slug];
  const placement = { concepts: existing?.concepts ?? [], x: spec.x, y: spec.y, placed: true };
  const next: CanvasDoc = { ...doc, placements: { ...doc.placements, [slug]: placement } };
  return spec.conceptId === undefined ? next : setPrimary(next, slug, spec.conceptId);
}

/** Undirected: endpoints are stored sorted, one kind per pair, last write wins. */
export function upsertRelation(doc: CanvasDoc, a: TaskId, b: TaskId, kind: CanvasRelationKind): CanvasDoc {
  if (a === b) throw new Error(`upsertRelation: same task on both ends (${a})`);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const relations = doc.relations.filter((r) => !(r.a === lo && r.b === hi));
  relations.push({ a: lo, b: hi, kind });
  return { ...doc, relations };
}

/** Marks a placement unplaced. Tags and coordinates stay; an unknown slug is a no-op. */
export function unplaceTask(doc: CanvasDoc, slug: TaskId): CanvasDoc {
  const placement = doc.placements[slug];
  if (!placement) return doc;
  return { ...doc, placements: { ...doc.placements, [slug]: { ...placement, placed: false } } };
}

/**
 * Tags a slug with a concept. Missing rows are created unplaced at the origin.
 * `primary === true`, or `primary` omitted on an empty tag list, becomes the primary hull;
 * otherwise the id is appended as a chip. Unknown concept ids are still recorded.
 */
export function addTag(doc: CanvasDoc, slug: TaskId, conceptId: string, primary?: boolean): CanvasDoc {
  const existing = doc.placements[slug];
  const withRow = existing ? doc : { ...doc, placements: { ...doc.placements, [slug]: { concepts: [], x: 0, y: 0, placed: false } } };
  const placement = withRow.placements[slug];
  if (primary === true || (primary === undefined && placement.concepts.length === 0)) {
    return setPrimary(withRow, slug, conceptId);
  }
  if (placement.concepts.includes(conceptId)) return withRow;
  return {
    ...withRow,
    placements: { ...withRow.placements, [slug]: { ...placement, concepts: [...placement.concepts, conceptId] } },
  };
}

/** Drops one tag. Primary loss unplaces and does not promote. Unknown slug/tag is a no-op. */
export function removeTag(doc: CanvasDoc, slug: TaskId, conceptId: string): CanvasDoc {
  const placement = doc.placements[slug];
  if (!placement?.concepts.includes(conceptId)) return doc;
  return { ...doc, placements: { ...doc.placements, [slug]: stripConcept(placement, conceptId) } };
}

/** Drops the sorted pair. Missing pair and `a === b` are no-ops, not throws. */
export function deleteRelation(doc: CanvasDoc, a: TaskId, b: TaskId): CanvasDoc {
  if (a === b) return doc;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const relations = doc.relations.filter((r) => !(r.a === lo && r.b === hi));
  if (relations.length === doc.relations.length) return doc;
  return { ...doc, relations };
}
