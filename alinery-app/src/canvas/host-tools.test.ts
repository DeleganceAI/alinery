import { describe, expect, it } from "vitest";
import type { BoardTask, CanvasDoc, CanvasEditMode, HostToolCall } from "../types";
import { arrangeConcepts } from "./arrange";
import { applyBoardToolForMode, applyHostTool, boardSnapshot, resolveHeldForMode, resultForAccept, resultForReject } from "./host-tools";
import { emptyCanvasDoc } from "./ids";
import { HULL_MIN_H, HULL_MIN_W, packConcept } from "./pack";

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

function hull(id: string, overrides: Partial<CanvasDoc["concepts"][number]> = {}) {
  return { id, name: id, x: 10, y: 20, w: HULL_MIN_W, h: HULL_MIN_H, manual: false, ...overrides };
}

function docWith(overrides: Partial<CanvasDoc> = {}): CanvasDoc {
  return { ...emptyCanvasDoc(), ...overrides };
}

function geometryKeysOf(value: object): string[] {
  return Object.keys(value).filter((k) => k === "camX" || k === "camY" || k === "scale" || k === "x" || k === "y" || k === "w" || k === "h");
}

const createAuth: HostToolCall = { toolName: "concept_create", arguments: { name: "Auth" } };

describe("boardSnapshot", () => {
  it("omits camera and x,y,w,h", () => {
    const doc = docWith({
      view: { ...emptyCanvasDoc().view, camX: 9, camY: 9, scale: 2 },
      concepts: [hull("c1", { x: 1, y: 2, w: 3, h: 4 })],
      placements: { a: { concepts: ["c1"], x: 5, y: 6, placed: true } },
    });
    const snapshot = boardSnapshot(doc, [task({ slug: "a" })]);
    expect(geometryKeysOf(snapshot)).toEqual([]);
    for (const concept of snapshot.concepts) expect(geometryKeysOf(concept)).toEqual([]);
    for (const row of snapshot.tasks) expect(geometryKeysOf(row)).toEqual([]);
    expect(snapshot).not.toHaveProperty("camX");
    expect(snapshot).not.toHaveProperty("camY");
    expect(snapshot).not.toHaveProperty("scale");
  });

  it("lists every catalog row", () => {
    const doc = docWith({
      placements: { a: { concepts: ["c1"], x: 0, y: 0, placed: true } },
    });
    const snapshot = boardSnapshot(doc, [task({ slug: "a" }), task({ slug: "b" })]);
    expect(snapshot.tasks.map((t) => t.slug)).toEqual(["a", "b"]);
    expect(snapshot.tasks[1]).toMatchObject({ placed: false, concepts: [] });
  });

  it("unplaced is missing or not placed", () => {
    const doc = docWith({
      placements: {
        a: { concepts: ["c1"], x: 0, y: 0, placed: true },
        c: { concepts: [], x: 0, y: 0, placed: false },
      },
    });
    const snapshot = boardSnapshot(doc, [task({ slug: "a" }), task({ slug: "b" }), task({ slug: "c" })]);
    expect(snapshot.unplaced).toEqual(["b", "c"]);
  });

  it("keeps an archived placed task", () => {
    const doc = docWith({
      placements: { a: { concepts: ["c1"], x: 0, y: 0, placed: true } },
    });
    const snapshot = boardSnapshot(doc, [task({ slug: "a", archived: true })]);
    expect(snapshot.tasks[0]).toMatchObject({ slug: "a", placed: true });
    expect(snapshot.unplaced).toEqual([]);
  });

  it("drops placement keys absent from the catalog", () => {
    const doc = docWith({
      placements: { ghost: { concepts: [], x: 0, y: 0, placed: true } },
    });
    const snapshot = boardSnapshot(doc, [task({ slug: "a" })]);
    expect(snapshot.tasks.map((t) => t.slug)).not.toContain("ghost");
    expect(snapshot.unplaced).not.toContain("ghost");
  });

  it("primarySlugs are placed cards whose concepts[0] matches", () => {
    const doc = docWith({
      concepts: [hull("c1"), hull("c2")],
      placements: {
        a: { concepts: ["c1"], x: 0, y: 0, placed: true },
        b: { concepts: ["c1"], x: 0, y: 0, placed: true },
        chip: { concepts: ["c2", "c1"], x: 0, y: 0, placed: true },
      },
    });
    const snapshot = boardSnapshot(doc, [task({ slug: "a" }), task({ slug: "b" }), task({ slug: "chip" })]);
    expect(snapshot.concepts.find((c) => c.id === "c1")?.primarySlugs).toEqual(["a", "b"]);
  });

  it("copies archived/draft/phase/step/counts from the catalog", () => {
    const snapshot = boardSnapshot(emptyCanvasDoc(), [
      task({
        slug: "a",
        name: "Login",
        archived: true,
        draft: true,
        current_phase: "research",
        current_step_title: "Questions",
        artifact_count: 3,
        session_count: 2,
      }),
    ]);
    expect(snapshot.tasks[0]).toMatchObject({
      name: "Login",
      archived: true,
      draft: true,
      current_phase: "research",
      current_step_title: "Questions",
      artifact_count: 3,
      session_count: 2,
    });
  });
});

describe("applyHostTool", () => {
  it("board_get throws", () => {
    expect(() => applyHostTool(emptyCanvasDoc(), [], { toolName: "board_get", arguments: {} })).toThrow();
  });

  it("concept_create mints c_<uuid> at camera center sized to the hull floor", () => {
    const doc = docWith({ view: { ...emptyCanvasDoc().view, camX: 40, camY: 80 } });
    const next = applyHostTool(doc, [], { toolName: "concept_create", arguments: { name: " Auth " } });
    expect(next.concepts).toHaveLength(1);
    const created = next.concepts[0];
    expect(created.id).toMatch(/^c_[0-9a-f-]{36}$/i);
    expect(created.name).toBe("Auth");
    expect(created.x).toBe(40);
    expect(created.y).toBe(80);
    expect(created.w).toBe(HULL_MIN_W);
    expect(created.h).toBe(HULL_MIN_H);
    expect(created.manual).toBe(false);
  });

  it("concept_create empty name throws Name required.", () => {
    expect(() => applyHostTool(emptyCanvasDoc(), [], { toolName: "concept_create", arguments: { name: "" } })).toThrow(/Name required/);
    expect(() => applyHostTool(emptyCanvasDoc(), [], { toolName: "concept_create", arguments: { name: "   " } })).toThrow(/Name required/);
  });

  it("concept_rename unknown id throws Unknown concept.", () => {
    expect(() => applyHostTool(emptyCanvasDoc(), [], { toolName: "concept_rename", arguments: { id: "c_nope", name: "X" } })).toThrow(/Unknown concept/);
  });

  it("concept_rename trims and renames", () => {
    const doc = docWith({ concepts: [hull("c1", { name: "Old" })] });
    const next = applyHostTool(doc, [], { toolName: "concept_rename", arguments: { id: "c1", name: " Billing " } });
    expect(next.concepts[0].name).toBe("Billing");
  });

  it("concept_delete unknown id throws Unknown concept.", () => {
    expect(() => applyHostTool(emptyCanvasDoc(), [], { toolName: "concept_delete", arguments: { id: "c_nope" } })).toThrow(/Unknown concept/);
  });

  it("concept_delete drops the hull and does not delete tasks", () => {
    const doc = docWith({
      concepts: [hull("c1")],
      placements: { s: { concepts: ["c1"], x: 1, y: 2, placed: true } },
    });
    const next = applyHostTool(doc, [task({ slug: "s" })], { toolName: "concept_delete", arguments: { id: "c1" } });
    expect(next.concepts).toEqual([]);
    expect(next.placements.s).toBeDefined();
    expect(next.placements.s.placed).toBe(false);
  });

  it("task_place into a hull packs members", () => {
    const concept = hull("c1", { x: 10, y: 20 });
    const doc = docWith({ concepts: [concept] });
    const catalog = [task({ slug: "s" })];
    const next = applyHostTool(doc, catalog, { toolName: "task_place", arguments: { slug: "s", conceptId: "c1" } });
    expect(next.placements.s.placed).toBe(true);
    expect(next.placements.s.concepts[0]).toBe("c1");
    const packed = packConcept(concept, [{ slug: "s" }]);
    expect(next.placements.s.x).toBe(packed.members[0].x);
    expect(next.placements.s.y).toBe(packed.members[0].y);
    expect(next.placements.s.x).not.toBe(doc.view.camX);
  });

  it("task_place without conceptId uses camera center", () => {
    const doc = docWith({
      view: { ...emptyCanvasDoc().view, camX: 15, camY: 25 },
      placements: { s: { concepts: ["c1"], x: 0, y: 0, placed: false } },
    });
    const next = applyHostTool(doc, [task({ slug: "s" })], { toolName: "task_place", arguments: { slug: "s" } });
    expect(next.placements.s).toMatchObject({ placed: true, x: 15, y: 25, concepts: ["c1"] });
  });

  it("task_unplace keeps tags", () => {
    const doc = docWith({
      placements: { s: { concepts: ["c1", "c2"], x: 5, y: 6, placed: true } },
    });
    const next = applyHostTool(doc, [task({ slug: "s" })], { toolName: "task_unplace", arguments: { slug: "s" } });
    expect(next.placements.s).toEqual({ concepts: ["c1", "c2"], x: 5, y: 6, placed: false });
  });

  it("task_tag default primary", () => {
    const doc = docWith({
      concepts: [hull("c1")],
      placements: { s: { concepts: [], x: 0, y: 0, placed: false } },
    });
    const next = applyHostTool(doc, [task({ slug: "s" })], { toolName: "task_tag", arguments: { slug: "s", conceptId: "c1" } });
    expect(next.placements.s.concepts[0]).toBe("c1");
  });

  it("task_tag chip", () => {
    const doc = docWith({
      concepts: [hull("c1"), hull("c2")],
      placements: { s: { concepts: ["c1"], x: 0, y: 0, placed: true } },
    });
    const next = applyHostTool(doc, [task({ slug: "s" })], { toolName: "task_tag", arguments: { slug: "s", conceptId: "c2" } });
    expect(next.placements.s.concepts).toEqual(["c1", "c2"]);
  });

  it("task_untag of primary unplaces and does not promote", () => {
    const doc = docWith({
      placements: { s: { concepts: ["c1", "c2"], x: 0, y: 0, placed: true } },
    });
    const next = applyHostTool(doc, [task({ slug: "s" })], { toolName: "task_untag", arguments: { slug: "s", conceptId: "c1" } });
    expect(next.placements.s.concepts).toEqual(["c2"]);
    expect(next.placements.s.placed).toBe(false);
  });

  it("relation_upsert a === b throws", () => {
    expect(() => applyHostTool(emptyCanvasDoc(), [], { toolName: "relation_upsert", arguments: { a: "t", b: "t", kind: "blocks" } })).toThrow(/same/);
  });

  it("relation_delete missing pair does not throw", () => {
    expect(() => applyHostTool(emptyCanvasDoc(), [], { toolName: "relation_delete", arguments: { a: "a", b: "b" } })).not.toThrow();
  });

  it("board_arrange does not set autoArrange true", () => {
    const doc = docWith({
      view: { ...emptyCanvasDoc().view, autoArrange: false },
      concepts: [hull("c1", { x: 80, y: 40 }), hull("c2", { x: 10, y: 20 })],
    });
    const next = applyHostTool(doc, [], { toolName: "board_arrange", arguments: {} });
    expect(next.view.autoArrange).toBe(false);
  });

  it("board_arrange runs arrangeConcepts then packAllHulls", () => {
    const concepts = [hull("c1", { x: 80, y: 40 }), hull("c2", { x: 10, y: 20 })];
    const doc = docWith({
      concepts,
      placements: {
        a: { concepts: ["c1"], x: 0, y: 0, placed: true },
        b: { concepts: ["c2"], x: 0, y: 0, placed: true },
      },
    });
    const catalog = [task({ slug: "a" }), task({ slug: "b" })];
    const next = applyHostTool(doc, catalog, { toolName: "board_arrange", arguments: {} });
    const arranged = arrangeConcepts(concepts);
    expect(next.concepts[0].x).toBe(arranged[0].x);
    expect(next.concepts[0].y).toBe(arranged[0].y);
    expect(next.concepts[1].x).toBe(arranged[1].x);
    expect(next.concepts[1].y).toBe(arranged[1].y);
  });
});

describe("applyBoardToolForMode", () => {
  const modes: CanvasEditMode[] = ["autoEdit", "readOnly", "requestApproval"];
  const get: HostToolCall = { toolName: "board_get", arguments: {} };

  it("board_get is a snapshot in every CanvasEditMode", () => {
    const doc = emptyCanvasDoc();
    const catalog = [task({ slug: "a" })];
    const expected = boardSnapshot(doc, catalog);
    for (const mode of modes) {
      expect(applyBoardToolForMode(mode, doc, catalog, get)).toEqual({ kind: "snapshot", payload: expected });
    }
  });

  it("a write in readOnly rejects", () => {
    const doc = emptyCanvasDoc();
    expect(applyBoardToolForMode("readOnly", doc, [], createAuth)).toEqual({ kind: "reject", error: "Board is in Read Only." });
  });

  it("a write in autoEdit applies", () => {
    const verdict = applyBoardToolForMode("autoEdit", emptyCanvasDoc(), [], createAuth);
    expect(verdict.kind).toBe("apply");
    if (verdict.kind === "apply") expect(verdict.doc.concepts).toHaveLength(1);
  });

  it("a write in requestApproval holds", () => {
    const doc = emptyCanvasDoc();
    expect(applyBoardToolForMode("requestApproval", doc, [], createAuth)).toEqual({ kind: "hold", call: createAuth });
    expect(doc.concepts).toEqual([]);
  });

  it("autoEdit maps applyHostTool throws to reject", () => {
    const verdict = applyBoardToolForMode("autoEdit", emptyCanvasDoc(), [], {
      toolName: "concept_rename",
      arguments: { id: "c_nope", name: "X" },
    });
    expect(verdict.kind).toBe("reject");
    if (verdict.kind === "reject") expect(verdict.error).toMatch(/Unknown concept/);
  });

  it("autoEdit on a held create applies", () => {
    expect(resolveHeldForMode("autoEdit", emptyCanvasDoc(), [], createAuth).kind).toBe("apply");
  });

  it("readOnly on a held create rejects", () => {
    expect(resolveHeldForMode("readOnly", emptyCanvasDoc(), [], createAuth)).toEqual({
      kind: "reject",
      error: "Board is in Read Only.",
    });
  });

  it("requestApproval on a held create still holds", () => {
    expect(resolveHeldForMode("requestApproval", emptyCanvasDoc(), [], createAuth).kind).toBe("hold");
  });
});

describe("accept and reject", () => {
  it("accept reapplies against the current doc not a hold-time copy", () => {
    const holdTime = docWith({ concepts: [hull("c1", { name: "Old" })] });
    const current = docWith({ concepts: [hull("c1", { name: "Renamed" })] });
    const call: HostToolCall = { toolName: "task_place", arguments: { slug: "s", conceptId: "c1" } };
    const accepted = resultForAccept(current, [task({ slug: "s" })], call);
    expect(accepted.doc.concepts[0].name).toBe("Renamed");
    expect(accepted.doc.placements.s.placed).toBe(true);
    expect(holdTime.concepts[0].name).toBe("Old");
  });

  it("reject leaves the input doc deep-equal", () => {
    const doc = docWith({ concepts: [hull("c1")] });
    const before = structuredClone(doc);
    expect(resultForReject()).toEqual({ isError: true, result: "Rejected." });
    expect(doc).toEqual(before);
  });

  it("autoEdit concept_create success result includes { id }", () => {
    const { doc, result } = resultForAccept(emptyCanvasDoc(), [], createAuth);
    expect(result).toEqual({ id: doc.concepts[0].id });
  });
});
