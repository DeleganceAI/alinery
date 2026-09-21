// The canvas renderer. Everything here is a function of the scene it is handed — no state,
// no DOM reads, no `getComputedStyle` (the palette arrives pre-read as `CanvasTokens`,
// because per-card style resolution is what turns a 200-card board into a stutter).
//
// Drawing happens in **world** coordinates: the caller installs a transform that folds in
// both the device pixel ratio and the camera, so a card is 200×72 world units whatever the
// zoom. Hairlines and text therefore divide by `scale` where they must stay a fixed size on
// screen.
//
// Three of the ticket's five performance requirements live here: viewport culling
// (`inView`), the truncated-label cache (via `truncateCached`), and the concept hull layer
// cache (`createHullCache`). There is deliberately **no** "lite card while panning" path:
// full cards are drawn during a pan, per the ticket.

import { formatAge } from "../format";
import type { BoardSessionState, CanvasConcept, TaskActivityStatus, TaskId } from "../types";
import type { Camera, Rect } from "./camera";
import type { PaintedCard } from "./ids";
import { CARD_H, CARD_W, PACK_HEADER } from "./pack";
import type { Pipe, PipePoint } from "./pipes";
import type { CanvasTokens } from "./tokens";
import { truncateCached } from "./tokens";

/** AABB overlap. Touching counts as visible: a card on the edge is half on screen. */
export function inView(aabb: Rect, viewport: Rect): boolean {
  return aabb.x + aabb.w >= viewport.x && aabb.x <= viewport.x + viewport.w && aabb.y + aabb.h >= viewport.y && aabb.y <= viewport.y + viewport.h;
}

export type PaintScene = {
  tokens: CanvasTokens;
  cam: Camera;
  lod: 0 | 1 | 2;
  /** Visible world rect, in world units. */
  viewport: Rect;
  concepts: readonly CanvasConcept[];
  cards: readonly PaintedCard[];
  pipes: readonly Pipe[];
  activity: Readonly<Record<string, TaskActivityStatus | null>>;
  selected: TaskId | null;
  connectSource: TaskId | null;
  /** Hull being edited/selected in edit mode. */
  selectedConcept: string | null;
  editing: boolean;
  /** Rubber-band preview while drawing a concept, in world units. */
  draft: Rect | null;
  /** Relation being drawn: source card face to the cursor, in world units. */
  lasso: { from: PipePoint; to: PipePoint } | null;
};

const HULL_RADIUS = 10;
const CARD_RADIUS = 8;
const PIPE_KIND_DASH: Record<Pipe["kind"], number[]> = {
  blocks: [],
  surface: [8, 6],
  informs: [2, 5],
};

/**
 * Installs the device-pixel + camera transform and returns the visible world rect.
 *
 * Backing store is CSS size × dpr so text is crisp on a Retina panel; the camera is folded
 * into the same transform so the renderer never converts coordinates by hand.
 */
export function setSceneTransform(ctx: CanvasRenderingContext2D, css: { w: number; h: number }, cam: Camera, dpr: number): Rect {
  const k = dpr * cam.scale;
  ctx.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
  return { x: cam.x, y: cam.y, w: css.w / cam.scale, h: css.h / cam.scale };
}

/**
 * Offscreen cache for the concept layer.
 *
 * Hulls only change when the camera or the hull geometry does, which is far less often than
 * cards move or a selection changes. `layer` repaints only on a key miss, so a drag that
 * moves one card re-runs the card loop and blits the hulls.
 */
export type HullCache = {
  layer(key: string, w: number, h: number, dpr: number, draw: (c: CanvasRenderingContext2D) => void): HTMLCanvasElement | null;
  dispose(): void;
};

export function createHullCache(): HullCache {
  let el: HTMLCanvasElement | null = null;
  let cachedKey = "";
  return {
    layer(key, w, h, dpr, draw) {
      const pw = Math.max(1, Math.round(w * dpr));
      const ph = Math.max(1, Math.round(h * dpr));
      if (!el) el = document.createElement("canvas");
      const resized = el.width !== pw || el.height !== ph;
      if (resized) {
        el.width = pw;
        el.height = ph;
      }
      if (!resized && cachedKey === key) return el;
      const c = el.getContext("2d");
      if (!c) return null;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, pw, ph);
      draw(c);
      cachedKey = key;
      return el;
    },
    dispose() {
      el = null;
      cachedKey = "";
    },
  };
}

/**
 * Identity of everything the hull layer draws. Anything absent from this key is something a
 * change to which will not repaint the layer — so a new hull-visual input must be added here
 * too, or it silently shows the previous frame.
 */
export function hullLayerKey(scene: PaintScene, dpr: number, css: { w: number; h: number }): string {
  const hulls = scene.concepts.map((c) => `${c.id}|${c.x}|${c.y}|${c.w}|${c.h}|${c.manual ? 1 : 0}|${c.name}`).join(";");
  const cam = `${scene.cam.x.toFixed(3)}|${scene.cam.y.toFixed(3)}|${scene.cam.scale.toFixed(4)}`;
  return [
    cam,
    scene.lod,
    dpr,
    css.w,
    css.h,
    scene.editing ? 1 : 0,
    scene.selectedConcept ?? "",
    scene.tokens.border,
    scene.tokens.surface,
    scene.tokens.accent,
    scene.tokens.danger,
    hulls,
  ].join("~");
}

export function paintScene(ctx: CanvasRenderingContext2D, css: { w: number; h: number }, dpr: number, scene: PaintScene, hullCache: HullCache): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = scene.tokens.canvas;
  ctx.fillRect(0, 0, Math.round(css.w * dpr), Math.round(css.h * dpr));

  const layer = hullCache.layer(hullLayerKey(scene, dpr, css), css.w, css.h, dpr, (c) => {
    setSceneTransform(c, css, scene.cam, dpr);
    drawHulls(c, scene);
  });
  if (layer) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer, 0, 0);
  } else {
    setSceneTransform(ctx, css, scene.cam, dpr);
    drawHulls(ctx, scene);
  }

  setSceneTransform(ctx, css, scene.cam, dpr);
  drawCards(ctx, scene);
  drawPipes(ctx, scene);
  drawDraft(ctx, scene);
  drawLasso(ctx, scene);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawHulls(ctx: CanvasRenderingContext2D, scene: PaintScene): void {
  const hair = 1 / scene.cam.scale;
  ctx.font = `600 ${HULL_LABEL_PX}px ${scene.tokens.fontUi}`;
  ctx.textBaseline = "middle";
  for (const hull of scene.concepts) {
    if (!inView(hull, scene.viewport)) continue;
    const active = scene.editing && scene.selectedConcept === hull.id;
    ctx.beginPath();
    ctx.roundRect(hull.x, hull.y, hull.w, hull.h, HULL_RADIUS);
    ctx.fillStyle = scene.tokens.surface;
    ctx.fill();
    ctx.lineWidth = active ? hair * 2 : hair;
    ctx.strokeStyle = active ? scene.tokens.accent : scene.tokens.border;
    ctx.stroke();

    const label = hull.name || "Untitled concept";
    ctx.fillStyle = scene.tokens.textMuted;
    const band = hullLabelRect(hull);
    // World units, not /scale: truncateCached keys on exact maxWidth, and a trackpad zoom
    // would otherwise mint a new entry per hull per frame until the 4000 cap cleared.
    const reserve = scene.editing ? DELETE_PX + DELETE_INSET_PX : 0;
    ctx.fillText(
      truncateCached(label, band.w - HULL_LABEL_PAD * 2 - reserve, ctx.font, (s) => ctx.measureText(s).width),
      band.x + HULL_LABEL_PAD,
      band.y + band.h / 2,
    );

    if (scene.editing) drawDeleteHandle(ctx, hull, scene, hair);
    if (active) drawResizeHandle(ctx, hull, scene, hair);
  }
}

export const HULL_LABEL_PX = 13;
/** Inset of the label text inside its band, in world units. */
export const HULL_LABEL_PAD = 12;

/**
 * World-space AABB of a hull's name label — the header band the label is painted into.
 * Shared with the view's rename hit test and with the rename box's placement, so "where the
 * name is" is defined once for painting, clicking and editing.
 */
export function hullLabelRect(hull: Rect): Rect {
  return { x: hull.x, y: hull.y, w: hull.w, h: PACK_HEADER };
}

const HANDLE_PX = 12;

/** On-screen size of the edit-mode delete X. Larger than the resize grip so it stays clickable when zoomed out. */
export const DELETE_PX = 16;
/** On-screen inset of the X from the box's top-right, so it sits inside the card/hull rather than on the SE grip. */
export const DELETE_INSET_PX = 4;

/** World-space AABB of a hull's resize grip. Shared with the view's hit test. */
export function resizeHandleRect(hull: CanvasConcept, scale: number): Rect {
  const size = HANDLE_PX / scale;
  return { x: hull.x + hull.w - size, y: hull.y + hull.h - size, w: size, h: size };
}

/** World-space AABB of the edit-mode delete X. Shared with the view's hit test. */
export function deleteHandleRect(box: Rect, scale: number): Rect {
  const size = DELETE_PX / scale;
  const inset = DELETE_INSET_PX / scale;
  return { x: box.x + box.w - size - inset, y: box.y + inset, w: size, h: size };
}

function drawResizeHandle(ctx: CanvasRenderingContext2D, hull: CanvasConcept, scene: PaintScene, hair: number): void {
  const grip = resizeHandleRect(hull, scene.cam.scale);
  ctx.fillStyle = scene.tokens.accent;
  ctx.fillRect(grip.x, grip.y, grip.w, grip.h);
  ctx.lineWidth = hair;
  ctx.strokeStyle = scene.tokens.canvas;
  ctx.strokeRect(grip.x, grip.y, grip.w, grip.h);
}

function drawDeleteHandle(ctx: CanvasRenderingContext2D, box: Rect, scene: PaintScene, hair: number): void {
  const handle = deleteHandleRect(box, scene.cam.scale);
  const pad = 4 / scene.cam.scale;
  ctx.strokeStyle = scene.tokens.danger;
  ctx.lineWidth = hair * 1.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(handle.x + pad, handle.y + pad);
  ctx.lineTo(handle.x + handle.w - pad, handle.y + handle.h - pad);
  ctx.moveTo(handle.x + handle.w - pad, handle.y + pad);
  ctx.lineTo(handle.x + pad, handle.y + handle.h - pad);
  ctx.stroke();
  ctx.lineCap = "butt";
}

const ACTIVITY_TONE: Record<TaskActivityStatus, "accent" | "muted"> = {
  running: "accent",
  waiting_for_input: "accent",
  waiting_for_approval: "accent",
  failed: "accent",
  completed: "muted",
};

/**
 * Card rows, in world units from the card's top edge. Written down rather than scattered as
 * `box.y + 42` literals, because the card grew to hold real content and every row below the
 * name has to stay inside `CARD_H` and clear of the chip band.
 */
const ROW_NAME = 20;
const ROW_META = 42;
const ROW_COUNTS = 62;
const ROW_SESSIONS = 86;
const ROW_SESSION_STEP = 18;
const ROW_CHIPS = 138;
/** Rows the card has space for. A longer list ends in "+N more" rather than overflowing. */
const MAX_SESSION_ROWS = 3;

const SESSION_WORD: Record<BoardSessionState, string> = {
  not_started: "Not started",
  running: "Running",
  interrupted: "Interrupted",
  exited: "Exited",
  failed: "Failed",
};

/** Only failure earns colour; everything else is quiet, or a running board is all dots. */
const SESSION_TONE: Record<BoardSessionState, "accent" | "danger" | "muted"> = {
  not_started: "muted",
  running: "accent",
  interrupted: "danger",
  exited: "muted",
  failed: "danger",
};

function drawCards(ctx: CanvasRenderingContext2D, scene: PaintScene): void {
  const hair = 1 / scene.cam.scale;
  const measure = (s: string) => ctx.measureText(s).width;
  for (const card of scene.cards) {
    const box: Rect = { x: card.x, y: card.y, w: CARD_W, h: CARD_H };
    if (!inView(box, scene.viewport)) continue;

    const focused = scene.selected === card.slug || scene.connectSource === card.slug;
    const archived = card.task.archived;

    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.w, box.h, CARD_RADIUS);
    ctx.fillStyle = scene.tokens.surface;
    ctx.fill();
    ctx.lineWidth = focused ? hair * 2 : hair;
    ctx.strokeStyle = focused ? scene.tokens.accent : scene.tokens.border;
    ctx.stroke();

    // Archived cards stay on the board, greyed: the placement is the user's, and hiding it
    // would silently lose the position they chose.
    const title = archived ? scene.tokens.textMuted : scene.tokens.textStrong;
    ctx.textBaseline = "middle";
    ctx.font = `500 ${13}px ${scene.tokens.fontUi}`;
    ctx.fillStyle = title;
    const nameX = archived ? box.x + 26 : box.x + 12;
    const reserve = scene.editing ? DELETE_PX + DELETE_INSET_PX : 0;
    const nameMax = box.w - (nameX - box.x) - 12 - reserve;
    ctx.fillText(truncateCached(card.task.name, nameMax, ctx.font, measure), nameX, box.y + ROW_NAME);
    if (archived) drawArchivedGlyph(ctx, box, scene, hair);
    if (scene.editing) drawDeleteHandle(ctx, box, scene, hair);

    if (scene.lod === 0) continue;

    ctx.font = `${11}px ${scene.tokens.fontUi}`;
    ctx.fillStyle = scene.tokens.textMuted;
    const status = scene.activity[card.slug];
    const tone = status ? ACTIVITY_TONE[status] : null;
    let x = box.x + 12;
    if (tone) {
      ctx.beginPath();
      ctx.arc(x + 3, box.y + ROW_META, 3, 0, Math.PI * 2);
      ctx.fillStyle = tone === "accent" ? scene.tokens.accent : scene.tokens.textMuted;
      ctx.fill();
      ctx.fillStyle = scene.tokens.textMuted;
      x += 12;
    }
    // Where the work stands: the step it is on, and how long since anything happened. Age is
    // the same wording the Kanban card and the task list use.
    const step = card.task.draft ? "Draft" : card.task.current_step_title || card.task.latest_session_title;
    const meta = [step, formatAge(card.task.updated || card.task.created)].filter(Boolean).join(" · ");
    ctx.fillText(truncateCached(meta, box.w - (x - box.x) - 12, ctx.font, measure), x, box.y + ROW_META);

    // Counts, not contents: enough to tell a task with output from an empty one.
    const counts = [plural(card.task.session_count, "session"), plural(card.task.artifact_count, "artifact"), card.task.playbook_title].filter(Boolean).join(" · ");
    ctx.fillStyle = scene.tokens.textMuted;
    ctx.fillText(truncateCached(counts, box.w - 24, ctx.font, measure), box.x + 12, box.y + ROW_COUNTS);

    if (scene.lod === 2) drawSessionRows(ctx, box, card, scene, measure);

    // Secondary tags are chips, never duplicate cards. Two is what fits.
    const chips = card.concepts.slice(1, 3);
    if (card.task.draft) chips.unshift("Draft");
    if (chips.length) drawChips(ctx, box, chips, scene, hair, measure);
  }
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The task's sessions, one per row: a state dot, the step it is on, and the state in words at
 * the right. Detail tier only — this is the content the tier exists for, and it is why the tier
 * boundary sits where a 11px row is still readable.
 *
 * The rows are the *durable* lifecycle (see `BoardSessionState`), which is what the card can
 * know without a per-card daemon round trip. The activity dot on the meta row above is the live
 * signal, and it is deliberately the only one.
 */
function drawSessionRows(ctx: CanvasRenderingContext2D, box: Rect, card: PaintedCard, scene: PaintScene, measure: (s: string) => number): void {
  const rows = card.task.sessions;
  if (!rows.length) {
    ctx.fillStyle = scene.tokens.textMuted;
    ctx.fillText("No sessions yet", box.x + 12, box.y + ROW_SESSIONS);
    return;
  }
  // One row is given up to "+N more" when the list is longer than the card.
  const overflow = rows.length > MAX_SESSION_ROWS ? rows.length - (MAX_SESSION_ROWS - 1) : 0;
  const shown = overflow ? rows.slice(0, MAX_SESSION_ROWS - 1) : rows.slice(0, MAX_SESSION_ROWS);

  shown.forEach((session, i) => {
    const y = box.y + ROW_SESSIONS + i * ROW_SESSION_STEP;
    const tone = SESSION_TONE[session.state];
    ctx.beginPath();
    ctx.arc(box.x + 15, y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = tone === "accent" ? scene.tokens.accent : tone === "danger" ? scene.tokens.danger : scene.tokens.textMuted;
    ctx.fill();

    // The state word is right-aligned and measured first, so the step title truncates into
    // whatever is left rather than colliding with it.
    const word = SESSION_WORD[session.state];
    const wordW = measure(word);
    ctx.fillStyle = tone === "danger" ? scene.tokens.danger : scene.tokens.textMuted;
    ctx.fillText(word, box.x + box.w - 12 - wordW, y);

    const titleX = box.x + 24;
    ctx.fillStyle = scene.tokens.text;
    ctx.fillText(truncateCached(session.title, box.x + box.w - 18 - wordW - titleX, ctx.font, measure), titleX, y);
  });

  if (overflow) {
    ctx.fillStyle = scene.tokens.textMuted;
    ctx.fillText(`+${overflow} more`, box.x + 24, box.y + ROW_SESSIONS + (MAX_SESSION_ROWS - 1) * ROW_SESSION_STEP);
  }
}

function drawArchivedGlyph(ctx: CanvasRenderingContext2D, box: Rect, scene: PaintScene, hair: number): void {
  const x = box.x + 12;
  const y = box.y + 14;
  ctx.lineWidth = hair;
  ctx.strokeStyle = scene.tokens.textMuted;
  ctx.strokeRect(x, y, 10, 3);
  ctx.strokeRect(x + 1, y + 3, 8, 6);
}

function drawChips(ctx: CanvasRenderingContext2D, box: Rect, chips: string[], scene: PaintScene, hair: number, measure: (s: string) => number): void {
  ctx.font = `${10}px ${scene.tokens.fontUi}`;
  let x = box.x + 12;
  const y = box.y + ROW_CHIPS;
  for (const chip of chips) {
    const label = truncateCached(chip, 70, ctx.font, measure);
    const w = measure(label) + 10;
    if (x + w > box.x + box.w - 12) return;
    ctx.beginPath();
    ctx.roundRect(x, y - 6, w, 13, 6);
    ctx.lineWidth = hair;
    ctx.strokeStyle = scene.tokens.border;
    ctx.stroke();
    ctx.fillStyle = scene.tokens.textMuted;
    ctx.fillText(label, x + 5, y);
    x += w + 5;
  }
}

/**
 * Corner radius for a pipe's turns, in world units at scale 1. Rounded corners are not
 * decoration: an orthogonal route has a corner every time it enters a gutter, and square ones
 * read as separate lines meeting rather than as one pipe turning.
 */
const PIPE_RADIUS = 10;

function tracePipe(ctx: CanvasRenderingContext2D, pts: readonly { x: number; y: number }[], radius: number): void {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  // arcTo fillets the corner *at* pts[i] between the two segments meeting there, so the last
  // point is reached with a plain lineTo.
  for (let i = 1; i < pts.length - 1; i++) ctx.arcTo(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, radius);
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
}

function drawPipes(ctx: CanvasRenderingContext2D, scene: PaintScene): void {
  const hair = 1 / scene.cam.scale;
  for (const pipe of scene.pipes) {
    if (pipe.pts.length < 2) continue;
    const width = hair * (pipe.level === "trunk" ? Math.min(4, 1.5 + pipe.count * 0.5) : 1);
    // A tight corner on a short segment would overshoot it; half the shortest run is the most
    // any fillet can use.
    let shortest = Number.POSITIVE_INFINITY;
    for (let i = 1; i < pipe.pts.length; i++) {
      shortest = Math.min(shortest, Math.abs(pipe.pts[i].x - pipe.pts[i - 1].x) + Math.abs(pipe.pts[i].y - pipe.pts[i - 1].y));
    }
    tracePipe(ctx, pipe.pts, Math.max(hair, Math.min(PIPE_RADIUS, shortest / 2)));
    // A casing under the core keeps a pipe readable where it crosses another one, which routing
    // in shared gutters makes more likely, not less.
    ctx.setLineDash([]);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = width + hair * 2.5;
    ctx.strokeStyle = scene.tokens.canvas;
    ctx.stroke();
    ctx.setLineDash(PIPE_KIND_DASH[pipe.kind].map((d) => d * hair));
    // A trunk carries `count` relations; widening it is the bundle's only visible cue.
    ctx.lineWidth = width;
    ctx.strokeStyle = pipe.level === "trunk" ? scene.tokens.border : scene.tokens.accent;
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

/**
 * The pipe being drawn: source card to wherever the cursor is, until the second right-click
 * picks a target. Dashed and unrouted on purpose - it is a pointer, not a route, and it becomes
 * a real routed pipe only once the pair is committed.
 */
function drawLasso(ctx: CanvasRenderingContext2D, scene: PaintScene): void {
  if (!scene.lasso) return;
  const hair = 1 / scene.cam.scale;
  const { from, to } = scene.lasso;
  ctx.setLineDash([6 * hair, 5 * hair]);
  ctx.lineWidth = hair * 1.5;
  ctx.strokeStyle = scene.tokens.accent;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = scene.tokens.accent;
  ctx.beginPath();
  ctx.arc(to.x, to.y, hair * 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawDraft(ctx: CanvasRenderingContext2D, scene: PaintScene): void {
  if (!scene.draft) return;
  const hair = 1 / scene.cam.scale;
  ctx.setLineDash([6 * hair, 4 * hair]);
  ctx.lineWidth = hair;
  ctx.strokeStyle = scene.tokens.accent;
  ctx.strokeRect(scene.draft.x, scene.draft.y, scene.draft.w, scene.draft.h);
  ctx.setLineDash([]);
}
