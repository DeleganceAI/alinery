import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardTask, CanvasConcept } from "../types";
import { packConcept } from "./pack";
import { createHullCache, deleteHandleRect, hullLabelRect, hullLayerKey, inView, type PaintScene, paintScene, resizeHandleRect } from "./paint";

const viewport = { x: 0, y: 0, w: 100, h: 100 };

describe("inView", () => {
  // 4.1 — viewport culling is the difference between drawing 12 cards and drawing 200.
  it("rejects an AABB fully outside the viewport", () => {
    expect(inView({ x: 200, y: 200, w: 10, h: 10 }, viewport)).toBe(false);
    expect(inView({ x: -50, y: 0, w: 10, h: 10 }, viewport)).toBe(false);
    expect(inView({ x: 0, y: -50, w: 10, h: 10 }, viewport)).toBe(false);
  });

  it("keeps a partially visible AABB", () => {
    expect(inView({ x: -5, y: -5, w: 10, h: 10 }, viewport)).toBe(true);
    expect(inView({ x: 95, y: 95, w: 40, h: 40 }, viewport)).toBe(true);
  });

  it("keeps an AABB fully inside", () => {
    expect(inView({ x: 10, y: 10, w: 10, h: 10 }, viewport)).toBe(true);
  });

  // A card resting exactly on the edge is half on screen; culling it would pop it out of
  // existence one pixel before it leaves.
  it("keeps a touching AABB", () => {
    expect(inView({ x: 100, y: 0, w: 10, h: 10 }, viewport)).toBe(true);
    expect(inView({ x: -10, y: 0, w: 10, h: 10 }, viewport)).toBe(true);
  });
});

const hull = (over: Partial<CanvasConcept> = {}): CanvasConcept => ({ id: "c1", name: "Auth", x: 0, y: 0, w: 240, h: 120, manual: false, ...over });

const scene = (over: Partial<PaintScene> = {}): PaintScene => ({
  tokens: {
    canvas: "#000",
    surface: "#111",
    text: "#fff",
    textStrong: "#fff",
    textMuted: "#999",
    accent: "#0af",
    border: "#333",
    danger: "#f00",
    fontUi: "sans-serif",
    uiScale: 1,
  },
  cam: { x: 0, y: 0, scale: 1 },
  lod: 1,
  viewport,
  concepts: [hull()],
  cards: [],
  pipes: [],
  activity: {},
  selected: null,
  connectSource: null,
  selectedConcept: null,
  editing: false,
  draft: null,
  lasso: null,
  ...over,
});

describe("hullLayerKey", () => {
  // The cache repaints on a key change and only on a key change, so anything the hull layer
  // draws must be in the key. These are the inputs a missing entry would silently freeze.
  it("changes when the camera, a hull, edit state, or a token changes", () => {
    const base = hullLayerKey(scene(), 2, { w: 800, h: 600 });
    expect(hullLayerKey(scene(), 2, { w: 800, h: 600 })).toBe(base);
    expect(hullLayerKey(scene({ cam: { x: 1, y: 0, scale: 1 } }), 2, { w: 800, h: 600 })).not.toBe(base);
    expect(hullLayerKey(scene({ concepts: [hull({ w: 400 })] }), 2, { w: 800, h: 600 })).not.toBe(base);
    expect(hullLayerKey(scene({ concepts: [hull({ name: "Renamed" })] }), 2, { w: 800, h: 600 })).not.toBe(base);
    expect(hullLayerKey(scene({ editing: true, selectedConcept: "c1" }), 2, { w: 800, h: 600 })).not.toBe(base);
    expect(hullLayerKey(scene({ tokens: { ...scene().tokens, border: "#fff" } }), 2, { w: 800, h: 600 })).not.toBe(base);
    expect(hullLayerKey(scene({ tokens: { ...scene().tokens, danger: "#0f0" } }), 2, { w: 800, h: 600 })).not.toBe(base);
    expect(hullLayerKey(scene(), 2, { w: 900, h: 600 })).not.toBe(base);
    expect(hullLayerKey(scene(), 1, { w: 800, h: 600 })).not.toBe(base);
  });
});

describe("createHullCache", () => {
  // jsdom has no 2D context (the `canvas` npm package is deliberately not a dependency of
  // this app), and `layer` needs one to clear the backing store before redrawing. Stub the
  // two calls it makes; `draw` is a spy here, so it never touches the context itself.
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: () => {},
      clearRect: () => {},
    } as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => vi.restoreAllMocks());

  // Ticket performance requirement 5. A cache that repaints every frame is not a cache, and
  // the symptom (a slightly slower board) is invisible in review.
  it("repaints on a key miss and blits on a hit", () => {
    const cache = createHullCache();
    const draw = vi.fn();
    cache.layer("a", 800, 600, 2, draw);
    expect(draw).toHaveBeenCalledTimes(1);
    cache.layer("a", 800, 600, 2, draw);
    expect(draw).toHaveBeenCalledTimes(1);
    cache.layer("b", 800, 600, 2, draw);
    expect(draw).toHaveBeenCalledTimes(2);
  });

  // A resize reallocates the backing store, which clears it — the layer must be redrawn even
  // though the scene key is unchanged.
  it("repaints when the backing store is resized", () => {
    const cache = createHullCache();
    const draw = vi.fn();
    cache.layer("a", 800, 600, 2, draw);
    cache.layer("a", 801, 600, 2, draw);
    expect(draw).toHaveBeenCalledTimes(2);
  });
});

describe("resizeHandleRect", () => {
  // The grip is a fixed on-screen size, so its world size is inversely proportional to zoom;
  // otherwise it would be unclickable when zoomed out and cover the hull when zoomed in.
  it("sits at the hull's bottom-right and scales inversely with zoom", () => {
    const grip = resizeHandleRect(hull({ x: 10, y: 20, w: 240, h: 120 }), 1);
    expect(grip).toEqual({ x: 238, y: 128, w: 12, h: 12 });
    expect(resizeHandleRect(hull(), 2).w).toBe(6);
    expect(resizeHandleRect(hull(), 0.5).w).toBe(24);
  });
});

describe("deleteHandleRect", () => {
  // Same inverse-zoom contract as the resize grip: a fixed on-screen X, not a world-sized one
  // that would vanish when zoomed out or cover the title when zoomed in.
  it("sits at the box's top-right, inset, and scales inversely with zoom", () => {
    const handle = deleteHandleRect({ x: 10, y: 20, w: 240, h: 120 }, 1);
    expect(handle).toEqual({ x: 230, y: 24, w: 16, h: 16 });
    expect(deleteHandleRect({ x: 0, y: 0, w: 240, h: 120 }, 2).w).toBe(8);
    expect(deleteHandleRect({ x: 0, y: 0, w: 240, h: 120 }, 0.5).w).toBe(32);
  });

  // At scale 1 the X lives in the header band; packing already starts members below that band,
  // so a click on the X cannot land on a card.
  it("stays inside the header band at scale 1 so it cannot sit on a packed card", () => {
    const packed = packConcept(hull({ x: 0, y: 0, w: 240, h: 120 }), [{ slug: "s" }]);
    const band = hullLabelRect(packed.concept);
    const handle = deleteHandleRect(packed.concept, 1);
    expect(handle.y + handle.h).toBeLessThanOrEqual(band.y + band.h);
    expect(packed.members[0].y).toBeGreaterThanOrEqual(band.y + band.h);
  });
});

describe("hullLabelRect", () => {
  // The band is world-space, unlike the grip: the label is painted in world units and scales
  // with the board, so clicking it must not depend on the zoom level.
  it("covers the hull's header band across its full width", () => {
    expect(hullLabelRect(hull({ x: 10, y: 20, w: 300, h: 200 }))).toEqual({ x: 10, y: 20, w: 300, h: 36 });
  });

  // Packing reserves PACK_HEADER for the label, so a member card can never sit under the
  // clickable band — otherwise a click meant for a card would open the rename box.
  it("never overlaps a packed member card", () => {
    const packed = packConcept(hull({ x: 0, y: 0, w: 240, h: 120 }), [{ slug: "s" }]);
    const band = hullLabelRect(packed.concept);
    expect(packed.members[0].y).toBeGreaterThanOrEqual(band.y + band.h);
  });
});

/**
 * What a card says at each tier. This is the one thing about the card that is worth pinning in
 * a unit test: the tier gate (detail content must not leak into the zoomed-out tiers) and the
 * row cap (a task with many sessions must summarise, not overflow its box). Everything else
 * about the card is appearance, which only a real browser can judge.
 */
describe("card content by tier", () => {
  const boardTask = (over: Partial<BoardTask> = {}): BoardTask =>
    ({
      name: "Login form",
      slug: "login-form",
      branch: "login-form",
      worktree: "/w/login-form",
      has_worktree: true,
      created: 1,
      archived: false,
      pr_url: "",
      linear_id: "",
      github_issue: "",
      playbook: "rpi",
      draft: false,
      auto_advance: [],
      repo_path: "/r",
      session_count: 2,
      playbook_title: "RPI",
      updated: Math.floor(Date.now() / 1000) - 7200,
      current_phase: "design",
      current_step_title: "Design",
      latest_session_title: "Design",
      latest_session_column_key: "research-design",
      current_column_key: "research-design",
      current_column_title: "Research & Design",
      artifact_count: 3,
      sessions: [
        { id: "s2", title: "Design", harness: "claude", state: "running", exit_code: null },
        { id: "s1", title: "Research", harness: "claude", state: "exited", exit_code: 0 },
      ],
      ...over,
    }) as BoardTask;

  // A recording context: every canvas call is a no-op except the text, which is the assertion
  // surface. jsdom has no 2D context at all, so there is nothing to spy on otherwise.
  function recordingCtx(texts: string[]): CanvasRenderingContext2D {
    const target = {
      measureText: (s: string) => ({ width: s.length * 6 }),
      fillText: (s: string) => texts.push(s),
    };
    return new Proxy(target, {
      get: (obj, prop) => (prop in obj ? obj[prop as keyof typeof obj] : () => {}),
      set: () => true,
    }) as unknown as CanvasRenderingContext2D;
  }

  const painted = (lod: 0 | 1 | 2, task = boardTask()): string[] => {
    const texts: string[] = [];
    const ctx = recordingCtx(texts);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
    paintScene(
      ctx,
      { w: 2000, h: 2000 },
      1,
      scene({ lod, concepts: [], cards: [{ slug: "login-form", task, x: 0, y: 0, concepts: [] }], viewport: { x: 0, y: 0, w: 2000, h: 2000 } }),
      createHullCache(),
    );
    vi.restoreAllMocks();
    return texts;
  };

  it("shows the name alone at the overview tier", () => {
    expect(painted(0)).toEqual(["Login form"]);
  });

  it("adds the step, age and counts at the task tier, but no session rows", () => {
    const texts = painted(1);
    expect(texts).toContain("Design · 2h");
    expect(texts).toContain("2 sessions · 3 artifacts · RPI");
    expect(texts).not.toContain("Research");
  });

  it("lists each session with its state at the detail tier", () => {
    const texts = painted(2);
    expect(texts).toContain("Design");
    expect(texts).toContain("Running");
    expect(texts).toContain("Research");
    expect(texts).toContain("Exited");
  });

  it("summarises a list longer than the card instead of overflowing it", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, title: `Step ${i}`, harness: "claude", state: "exited" as const, exit_code: 0 }));
    const texts = painted(2, boardTask({ sessions: many, session_count: 6 }));
    expect(texts).toContain("Step 0");
    expect(texts).toContain("Step 1");
    expect(texts).toContain("+4 more");
    expect(texts).not.toContain("Step 2");
  });

  it("says so when a task has no sessions at all", () => {
    expect(painted(2, boardTask({ sessions: [], session_count: 0 }))).toContain("No sessions yet");
  });
});
