import { describe, expect, it } from "vitest";
import type { BoardTask, CanvasConcept, CanvasDoc, CanvasPlacement } from "../types";
import {
  addTag,
  deleteConcept,
  deleteRelation,
  emptyCanvasDoc,
  joinPainted,
  mintConceptId,
  pickerPool,
  placeTask,
  removeTag,
  renameConcept,
  setPrimary,
  unplaceTask,
  upsertRelation,
} from "./ids";

// Data, not boilerplate: every case below fills in only the fields it cares about.
function task(overrides: Partial<BoardTask> & { slug: string }): BoardTask {
  return {
    name: overrides.slug,
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
    ...overrides,
  };
}

function placement(overrides: Partial<CanvasPlacement> = {}): CanvasPlacement {
  return { concepts: [], x: 0, y: 0, placed: false, ...overrides };
}

function docWith(placements: Record<string, CanvasPlacement>): CanvasDoc {
  return { ...emptyCanvasDoc(), placements };
}

describe("emptyCanvasDoc", () => {
  it("has the documented default shape", () => {
    // 3.1
    const doc = emptyCanvasDoc();
    expect(doc.version).toBe(1);
    expect(doc.concepts).toEqual([]);
    expect(doc.placements).toEqual({});
    expect(doc.relations).toEqual([]);
    expect(doc.view).toEqual({ camX: 0, camY: 0, scale: 1, autoArrange: false, canvasEditMode: "requestApproval" });
  });
});

describe("mintConceptId", () => {
  it("is c_ plus a uuid", () => {
    // 3.2
    const a = mintConceptId();
    const b = mintConceptId();
    expect(a).toMatch(/^c_[0-9a-f-]{36}$/i);
    expect(b).toMatch(/^c_[0-9a-f-]{36}$/i);
    expect(a).not.toBe(b);
  });
});

describe("joinPainted", () => {
  it("drops unknown and unplaced", () => {
    // 3.3
    const doc = docWith({
      a: placement({ placed: true, x: 1, y: 2 }),
      b: placement({ placed: false }),
    });
    const catalog = [task({ slug: "a" }), task({ slug: "b" })];
    const painted = joinPainted(doc, catalog);
    expect(painted.map((p) => p.slug)).toEqual(["a"]);
    expect(painted).toHaveLength(1);
  });

  it("keeps an archived placed task", () => {
    // 3.3b — lock c1786988656230: the obvious "helpful" filter here silently deletes
    // work from the board.
    const doc = docWith({ old: placement({ placed: true }) });
    const catalog = [task({ slug: "old", archived: true })];
    const painted = joinPainted(doc, catalog);
    expect(painted.map((p) => p.slug)).toEqual(["old"]);
  });

  it("geometry comes from the doc, not the catalog", () => {
    // 3.3c — the 3s poll must never move a card.
    const doc = docWith({ a: placement({ placed: true, x: 42, y: 99 }) });
    const catalog1 = [task({ slug: "a", updated: 1, current_phase: "build", session_count: 1 })];
    const catalog2 = [task({ slug: "a", updated: 2, current_phase: "review", session_count: 5 })];
    const painted1 = joinPainted(doc, catalog1);
    const painted2 = joinPainted(doc, catalog2);
    expect(painted1[0]).toMatchObject({ x: 42, y: 99 });
    expect(painted2[0]).toMatchObject({ x: 42, y: 99 });
  });
});

describe("pickerPool", () => {
  it("hides archived unless flagged and always hides placed", () => {
    // 3.4
    const catalog = [task({ slug: "d", draft: true }), task({ slug: "ar", archived: true }), task({ slug: "p" }), task({ slug: "l" })];
    const placed = new Set(["p"]);
    expect(pickerPool(catalog, placed, false).map((t) => t.slug)).toEqual(["d", "l"]);
    expect(pickerPool(catalog, placed, true).map((t) => t.slug)).toEqual(["d", "ar", "l"]);
  });
});

describe("deleteConcept", () => {
  it("unplaces primary and does not promote", () => {
    // 3.5 / 5.1 — the placement key stays in `placements`, placed flips false.
    const doc = docWith({ s: placement({ concepts: ["c1", "c2"], placed: true, x: 5, y: 6 }) });
    const before = structuredClone(doc);
    const next = deleteConcept(doc, "c1");
    expect(next.concepts.find((c) => c.id === "c1")).toBeUndefined();
    expect(next.placements.s).toEqual({ concepts: ["c2"], placed: false, x: 5, y: 6 });
    expect("s" in next.placements).toBe(true);
    expect(doc).toEqual(before);
  });

  it("strips a secondary chip and leaves placed", () => {
    // 3.6
    const doc = docWith({ s: placement({ concepts: ["c1", "c2"], placed: true }) });
    const next = deleteConcept(doc, "c2");
    expect(next.placements.s.concepts).toEqual(["c1"]);
    expect(next.placements.s.placed).toBe(true);
  });
});

describe("upsertRelation", () => {
  it("sorts and last-kind-wins", () => {
    // 3.7
    const doc = emptyCanvasDoc();
    const once = upsertRelation(doc, "z", "a", "blocks");
    const twice = upsertRelation(once, "a", "z", "informs");
    expect(twice.relations).toEqual([{ a: "a", b: "z", kind: "informs" }]);
  });

  it("rejects a === b", () => {
    // 3.8 — pick throw (Error containing "same").
    const doc = emptyCanvasDoc();
    expect(() => upsertRelation(doc, "t", "t", "blocks")).toThrow(/same/);
  });

  it("does not mutate the input doc", () => {
    const doc = emptyCanvasDoc();
    const before = structuredClone(doc);
    upsertRelation(doc, "a", "b", "blocks");
    expect(doc).toEqual(before);
  });
});

describe("placeTask", () => {
  it("into a hull sets concepts[0]", () => {
    // 3.9
    const doc = emptyCanvasDoc();
    const next = placeTask(doc, "s", { x: 1, y: 2, conceptId: "c1" });
    expect(next.placements.s).toMatchObject({ placed: true, x: 1, y: 2 });
    expect(next.placements.s.concepts[0]).toBe("c1");
  });

  it("without conceptId leaves concepts untouched", () => {
    // 3.10
    const doc = docWith({ s: placement({ concepts: ["c1"], placed: false }) });
    const next = placeTask(doc, "s", { x: 7, y: 8 });
    expect(next.placements.s).toEqual({ concepts: ["c1"], placed: true, x: 7, y: 8 });

    const fresh = placeTask(emptyCanvasDoc(), "new", { x: 0, y: 0 });
    expect(fresh.placements.new.concepts).toEqual([]);
  });

  it("does not mutate the input doc", () => {
    const doc = docWith({ s: placement({ concepts: ["c1"], placed: false, x: 1, y: 1 }) });
    const before = structuredClone(doc);
    placeTask(doc, "s", { x: 7, y: 8, conceptId: "c9" });
    expect(doc).toEqual(before);
  });
});

describe("setPrimary", () => {
  it("clears primary and keeps placed", () => {
    // 3.11 — shift, do not promote to a different hull silently.
    const doc = docWith({ s: placement({ concepts: ["c1", "c2"], placed: true }) });
    const next = setPrimary(doc, "s", null);
    expect(next.placements.s.concepts).toEqual(["c2"]);
    expect(next.placements.s.placed).toBe(true);
  });

  it("makes c9 concepts[0] without duplicating", () => {
    // 3.11b
    const doc = docWith({ s: placement({ concepts: ["c9", "c1"] }) });
    const next = setPrimary(doc, "s", "c9");
    expect(next.placements.s.concepts).toEqual(["c9", "c1"]);
  });

  it("does not mutate the input doc", () => {
    const doc = docWith({ s: placement({ concepts: ["c1", "c2"], placed: true }) });
    const before = structuredClone(doc);
    setPrimary(doc, "s", null);
    expect(doc).toEqual(before);
  });
});

describe("renameConcept", () => {
  const concept = (id: string): CanvasConcept => ({ id, name: id, x: 0, y: 0, w: 240, h: 120, manual: false });
  const doc = (): CanvasDoc => ({ ...emptyCanvasDoc(), concepts: [concept("c1"), concept("c2")] });

  it("renames only the named concept", () => {
    const next = renameConcept(doc(), "c2", "Billing");
    expect(next.concepts.map((c) => c.name)).toEqual(["c1", "Billing"]);
  });

  it("trims the stored name", () => {
    expect(renameConcept(doc(), "c1", "  Auth  ").concepts[0].name).toBe("Auth");
  });

  it("leaves the document alone for an unknown id", () => {
    const before = doc();
    expect(renameConcept(before, "c9", "Nope")).toEqual(before);
  });

  it("does not mutate the input doc", () => {
    const input = doc();
    const snapshot = structuredClone(input);
    renameConcept(input, "c1", "Changed");
    expect(input).toEqual(snapshot);
  });
});

describe("unplaceTask", () => {
  it("sets placed false and keeps tags", () => {
    const doc = docWith({ s: placement({ concepts: ["c1", "c2"], placed: true, x: 5, y: 6 }) });
    const next = unplaceTask(doc, "s");
    expect(next.placements.s).toEqual({ concepts: ["c1", "c2"], placed: false, x: 5, y: 6 });
  });

  it("unknown slug is a no-op", () => {
    const doc = emptyCanvasDoc();
    expect(unplaceTask(doc, "ghost")).toEqual(doc);
  });

  it("does not mutate the input doc", () => {
    const doc = docWith({ s: placement({ concepts: ["c1"], placed: true }) });
    const before = structuredClone(doc);
    unplaceTask(doc, "s");
    expect(doc).toEqual(before);
  });
});

describe("addTag", () => {
  it("creates an unplaced row when the slug is missing", () => {
    const next = addTag(emptyCanvasDoc(), "s", "c1");
    expect(next.placements.s).toEqual({ concepts: ["c1"], x: 0, y: 0, placed: false });
  });

  it("with omitted primary tags an untagged slug as primary", () => {
    const doc = docWith({ s: placement({ concepts: [], placed: false }) });
    expect(addTag(doc, "s", "c1").placements.s.concepts[0]).toBe("c1");
  });

  it("without primary true appends a chip", () => {
    const doc = docWith({ s: placement({ concepts: ["c1"], placed: true }) });
    const next = addTag(doc, "s", "c2");
    expect(next.placements.s.concepts).toEqual(["c1", "c2"]);
    expect(next.placements.s.placed).toBe(true);
  });

  it("primary true moves that id to concepts[0]", () => {
    const doc = docWith({ s: placement({ concepts: ["c1", "c2"] }) });
    expect(addTag(doc, "s", "c2", true).placements.s.concepts).toEqual(["c2", "c1"]);
  });

  it("records a catalog-absent conceptId", () => {
    const next = addTag(emptyCanvasDoc(), "s", "c_ghost");
    expect(next.placements.s.concepts).toContain("c_ghost");
  });
});

describe("removeTag", () => {
  it("of primary unplaces and does not promote", () => {
    const doc = docWith({ s: placement({ concepts: ["c1", "c2"], placed: true }) });
    const next = removeTag(doc, "s", "c1");
    expect(next.placements.s.concepts).toEqual(["c2"]);
    expect(next.placements.s.placed).toBe(false);
  });

  it("of a chip leaves placed", () => {
    const doc = docWith({ s: placement({ concepts: ["c1", "c2"], placed: true }) });
    const next = removeTag(doc, "s", "c2");
    expect(next.placements.s.concepts).toEqual(["c1"]);
    expect(next.placements.s.placed).toBe(true);
  });

  it("unknown slug or tag is a no-op", () => {
    const doc = docWith({ s: placement({ concepts: ["c1"], placed: true }) });
    expect(removeTag(emptyCanvasDoc(), "ghost", "c1")).toEqual(emptyCanvasDoc());
    expect(removeTag(doc, "s", "c9")).toEqual(doc);
  });
});

describe("deleteRelation", () => {
  it("sorts endpoints and drops the pair", () => {
    const doc = { ...emptyCanvasDoc(), relations: [{ a: "a", b: "z", kind: "blocks" as const }] };
    expect(deleteRelation(doc, "a", "z").relations).toEqual([]);
    expect(deleteRelation(doc, "z", "a").relations).toEqual([]);
  });

  it("missing pair is a no-op not a throw", () => {
    const doc = emptyCanvasDoc();
    expect(() => deleteRelation(doc, "a", "b")).not.toThrow();
    expect(deleteRelation(doc, "a", "b")).toEqual(doc);
  });

  it("a === b does not throw", () => {
    expect(() => deleteRelation(emptyCanvasDoc(), "t", "t")).not.toThrow();
  });
});
