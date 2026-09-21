// Board host tools: pure CanvasDoc transforms. Geometry is host-computed; the agent never
// sees or proposes x/y/w/h. CanvasView.commit is the only writer — this module does not
// talk to IPC.

import type { BoardTask, CanvasDoc, CanvasEditMode, HostToolCall, TaskId } from "../types";
import { arrangeConcepts } from "./arrange";
import { addTag, deleteConcept, deleteRelation, mintConceptId, placeTask, removeTag, renameConcept, unplaceTask, upsertRelation } from "./ids";
import { HULL_MIN_H, HULL_MIN_W, packAllHulls, packHull } from "./pack";

export type BoardSnapshot = {
  concepts: { id: string; name: string; primarySlugs: TaskId[] }[];
  tasks: {
    slug: TaskId;
    name: string;
    placed: boolean;
    concepts: string[];
    archived: boolean;
    draft: boolean;
    current_phase: string;
    current_step_title: string;
    artifact_count: number;
    session_count: number;
  }[];
  relations: CanvasDoc["relations"];
  unplaced: TaskId[];
};

export function boardSnapshot(doc: CanvasDoc, catalog: BoardTask[]): BoardSnapshot {
  const tasks = catalog.map((task) => {
    const placement = doc.placements[task.slug];
    return {
      slug: task.slug,
      name: task.name,
      placed: placement?.placed === true,
      concepts: placement?.concepts ?? [],
      archived: task.archived,
      draft: task.draft,
      current_phase: task.current_phase,
      current_step_title: task.current_step_title,
      artifact_count: task.artifact_count,
      session_count: task.session_count,
    };
  });
  return {
    concepts: doc.concepts.map((concept) => ({
      id: concept.id,
      name: concept.name,
      primarySlugs: catalog
        .filter((task) => {
          const placement = doc.placements[task.slug];
          return placement?.placed === true && placement.concepts[0] === concept.id;
        })
        .map((task) => task.slug),
    })),
    tasks,
    relations: doc.relations.map((r) => ({ a: r.a, b: r.b, kind: r.kind })),
    unplaced: catalog.filter((task) => doc.placements[task.slug]?.placed !== true).map((task) => task.slug),
  };
}

function cameraCenter(doc: CanvasDoc): { x: number; y: number } {
  return { x: doc.view.camX, y: doc.view.camY };
}

function requireConcept(doc: CanvasDoc, id: string): void {
  if (!doc.concepts.some((c) => c.id === id)) throw new Error("Unknown concept.");
}

export function applyHostTool(doc: CanvasDoc, catalog: BoardTask[], call: HostToolCall): CanvasDoc {
  switch (call.toolName) {
    case "board_get":
      throw new Error("board_get is not a mutator");
    case "concept_create": {
      const name = call.arguments.name.trim();
      if (!name) throw new Error("Name required.");
      const id = mintConceptId();
      const { x, y } = cameraCenter(doc);
      const next: CanvasDoc = {
        ...doc,
        concepts: [...doc.concepts, { id, name, x, y, w: HULL_MIN_W, h: HULL_MIN_H, manual: false }],
      };
      return packHull(next, id, catalog);
    }
    case "concept_rename":
      requireConcept(doc, call.arguments.id);
      return renameConcept(doc, call.arguments.id, call.arguments.name);
    case "concept_delete":
      requireConcept(doc, call.arguments.id);
      return deleteConcept(doc, call.arguments.id);
    case "task_place": {
      const { slug, conceptId } = call.arguments;
      const pos = conceptId === undefined ? cameraCenter(doc) : { x: 0, y: 0 };
      const placed = placeTask(doc, slug, { ...pos, conceptId });
      return conceptId === undefined ? placed : packHull(placed, conceptId, catalog);
    }
    case "task_unplace":
      return unplaceTask(doc, call.arguments.slug);
    case "task_tag": {
      const beforePrimary = doc.placements[call.arguments.slug]?.concepts[0];
      const tagged = addTag(doc, call.arguments.slug, call.arguments.conceptId, call.arguments.primary);
      const afterPrimary = tagged.placements[call.arguments.slug]?.concepts[0];
      return afterPrimary && afterPrimary !== beforePrimary ? packHull(tagged, afterPrimary, catalog) : tagged;
    }
    case "task_untag":
      return removeTag(doc, call.arguments.slug, call.arguments.conceptId);
    case "relation_upsert":
      return upsertRelation(doc, call.arguments.a, call.arguments.b, call.arguments.kind);
    case "relation_delete":
      return deleteRelation(doc, call.arguments.a, call.arguments.b);
    case "board_arrange":
      return packAllHulls({ ...doc, concepts: arrangeConcepts(doc.concepts) }, catalog);
  }
}

export type ModeApply = { kind: "snapshot"; payload: BoardSnapshot } | { kind: "apply"; doc: CanvasDoc } | { kind: "hold"; call: HostToolCall } | { kind: "reject"; error: string };

export function applyBoardToolForMode(mode: CanvasEditMode, doc: CanvasDoc, catalog: BoardTask[], call: HostToolCall): ModeApply {
  if (call.toolName === "board_get") return { kind: "snapshot", payload: boardSnapshot(doc, catalog) };
  if (mode === "readOnly") return { kind: "reject", error: "Board is in Read Only." };
  if (mode === "requestApproval") return { kind: "hold", call };
  try {
    return { kind: "apply", doc: applyHostTool(doc, catalog, call) };
  } catch (err) {
    return { kind: "reject", error: err instanceof Error ? err.message : String(err) };
  }
}

/** One-line delegate so Phase 7 cannot grow a second matrix. */
export function resolveHeldForMode(mode: CanvasEditMode, doc: CanvasDoc, catalog: BoardTask[], call: HostToolCall): ModeApply {
  return applyBoardToolForMode(mode, doc, catalog, call);
}

export function resultForAccept(doc: CanvasDoc, catalog: BoardTask[], call: HostToolCall): { doc: CanvasDoc; result: unknown } {
  const next = applyHostTool(doc, catalog, call);
  if (call.toolName !== "concept_create") return { doc: next, result: {} };
  const created = next.concepts.find((c) => !doc.concepts.some((old) => old.id === c.id));
  return { doc: next, result: created ? { id: created.id } : {} };
}

export function resultForReject(): { isError: true; result: "Rejected." } {
  return { isError: true, result: "Rejected." };
}
