// Grid-packs a concept hull's member cards. Pure and React-free: packing math is a layout
// concern, not a rendering one, and callers (Phase 5-8) decide *when* to run it.
//
// This function must never be invoked automatically on a phase/status change. A reflow the
// user did not ask for looks like the board silently rearranging itself underneath them —
// packing only happens on an explicit user action (adding a card, resizing a hull, an
// explicit "arrange" command), never as a side effect of task state changing.

import type { BoardTask, CanvasConcept, CanvasDoc, TaskId } from "../types";
import { joinPainted } from "./ids";

export const PACK_PAD = 16;
export const PACK_GAP = 12;
export const PACK_HEADER = 36;
// A card carries the task's actual state at the detail tier — updated, step, artifact count,
// and a list of its sessions — so it is sized for that content rather than for a name and one
// line. The canvas is infinite; legibility is the scarce resource, not space.
export const CARD_W = 260;
export const CARD_H = 152;
// The floor for any hull: the smallest box that actually holds one task card. Derived rather
// than written as literals so "minimum size" and "fits a task" cannot drift apart — the old
// hand-picked 120 was shorter than the header plus one card, so the minimum was a hull nothing
// could sit in.
export const HULL_MIN_W = PACK_PAD + CARD_W + PACK_PAD;
export const HULL_MIN_H = PACK_HEADER + PACK_PAD + CARD_H + PACK_PAD;
export const PACK_MAX_COLS = 3;

export type PackMember = { slug: TaskId; x: number; y: number };

/**
 * Snaps a drawn hull up to that floor, per dimension. A sliver of a drag becomes a hull a task
 * can live in; the dimension the user already drew big enough is left exactly as drawn, because
 * the drawn size is a deliberate choice everywhere it is usable.
 */
export function snapHullSize(size: { w: number; h: number }): { w: number; h: number } {
  return { w: Math.max(size.w, HULL_MIN_W), h: Math.max(size.h, HULL_MIN_H) };
}

export function packConcept(concept: CanvasConcept, members: readonly { slug: TaskId }[]): { concept: CanvasConcept; members: PackMember[] } {
  if (members.length === 0) {
    const resized: CanvasConcept = concept.manual ? { ...concept } : { ...concept, w: HULL_MIN_W, h: HULL_MIN_H };
    return { concept: resized, members: [] };
  }

  const cols = Math.min(PACK_MAX_COLS, Math.max(1, members.length));
  const rows = Math.ceil(members.length / cols);
  const needW = PACK_PAD * 2 + cols * CARD_W + (cols - 1) * PACK_GAP;
  const needH = PACK_HEADER + PACK_PAD + rows * CARD_H + (rows - 1) * PACK_GAP + PACK_PAD;

  const w = concept.manual ? Math.max(concept.w, needW) : Math.max(HULL_MIN_W, needW);
  const h = concept.manual ? Math.max(concept.h, needH) : Math.max(HULL_MIN_H, needH);
  const resized: CanvasConcept = { ...concept, w, h };

  // Membership-array order is the contract, not any status/phase field on the member —
  // re-sorting here would silently move cards the user placed deliberately.
  const packedMembers: PackMember[] = members.map((member, i) => ({
    slug: member.slug,
    x: concept.x + PACK_PAD + (i % cols) * (CARD_W + PACK_GAP),
    y: concept.y + PACK_HEADER + PACK_PAD + Math.floor(i / cols) * (CARD_H + PACK_GAP),
  }));

  return { concept: resized, members: packedMembers };
}

/**
 * Re-grids one hull's members and grows the hull to fit them. Never runs on a phase or status
 * change — only on the explicit actions that alter what has to fit (draw, resize, place,
 * arrange), because a reflow the user did not ask for looks like the board moving on its own.
 */
export function packHull(doc: CanvasDoc, id: string, catalog: BoardTask[]): CanvasDoc {
  const hull = doc.concepts.find((c) => c.id === id);
  if (!hull) return doc;
  const members = joinPainted(doc, catalog).filter((card) => card.concepts[0] === id);
  const packed = packConcept(hull, members);
  const placements = { ...doc.placements };
  for (const member of packed.members) {
    const placement = placements[member.slug];
    if (placement) placements[member.slug] = { ...placement, x: member.x, y: member.y };
  }
  return { ...doc, concepts: doc.concepts.map((c) => (c.id === id ? packed.concept : c)), placements };
}

export function packAllHulls(doc: CanvasDoc, catalog: BoardTask[]): CanvasDoc {
  return doc.concepts.reduce((next, hull) => packHull(next, hull.id, catalog), doc);
}
