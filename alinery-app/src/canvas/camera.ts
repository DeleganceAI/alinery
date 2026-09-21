// The canvas camera: a pan/zoom transform between world space (where concepts and cards
// live) and screen space (where the pointer clicks). Every other module — hit testing,
// hashing, packing display, LOD — reads the camera through this file so the transform
// convention is defined exactly once: screen = (world - cam) * scale.
//
// The two `*Label` functions at the bottom are the words the footer uses for the board's
// current state. They live together, and here rather than in the view, so the status bar and
// the canvas's own accessible name can never disagree about what mode the board is in.

import type { CanvasTool } from "../types";

export type Camera = { x: number; y: number; scale: number };
export type Rect = { x: number; y: number; w: number; h: number };

export const MIN_SCALE = 0.15;
export const MAX_SCALE = 3;

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

export function worldToScreen(cam: Camera, wx: number, wy: number): { x: number; y: number } {
  return { x: (wx - cam.x) * cam.scale, y: (wy - cam.y) * cam.scale };
}

export function screenToWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: sx / cam.scale + cam.x, y: sy / cam.scale + cam.y };
}

// A drag moves the content with the pointer, so the camera (which world point sits at
// screen origin) moves the opposite way, scaled back into world units.
export function panCamera(cam: Camera, dxScreen: number, dyScreen: number): Camera {
  return { x: cam.x - dxScreen / cam.scale, y: cam.y - dyScreen / cam.scale, scale: cam.scale };
}

// Zoom while keeping the world point currently under (sx, sy) under the same screen
// point after the scale change — otherwise every scroll-zoom would drift the view.
export function zoomAt(cam: Camera, sx: number, sy: number, factor: number): Camera {
  const scale = clampScale(cam.scale * factor);
  const world = screenToWorld(cam, sx, sy);
  return { x: world.x - sx / scale, y: world.y - sy / scale, scale };
}

// Fits `bounds` inside `viewport` minus `padPx` on every side, then centres it. An
// empty or degenerate board has nothing to fit, so it resets to the identity camera
// instead of dividing by zero.
export function fitCamera(bounds: Rect | null, viewport: { w: number; h: number }, padPx = 48): Camera {
  if (!bounds || bounds.w <= 0 || bounds.h <= 0) {
    return { x: 0, y: 0, scale: 1 };
  }
  const availW = viewport.w - padPx * 2;
  const availH = viewport.h - padPx * 2;
  const scale = clampScale(Math.min(availW / bounds.w, availH / bounds.h));
  const worldCenterX = bounds.x + bounds.w / 2;
  const worldCenterY = bounds.y + bounds.h / 2;
  return {
    x: worldCenterX - viewport.w / 2 / scale,
    y: worldCenterY - viewport.h / 2 / scale,
    scale,
  };
}

// Tier thresholds. The POC's 0.45 overview boundary is preserved verbatim — below it a card's
// 11px rows are ~5px and the name is all that can be read. The detail boundary moved down from
// the POC's 1.35 to 1.0: the card is now 260x152 and carries its sessions, so its rows are
// legible at 1:1, and holding detail back to 1.35 meant a 205px-tall card and only a handful of
// tasks on screen at the one tier where you want to compare them. Strict "<" boundaries.
export function lodTier(scale: number): 0 | 1 | 2 {
  if (scale < 0.45) return 0;
  if (scale < 1.0) return 1;
  return 2;
}

export function lodLabel(tier: 0 | 1 | 2): "Overview" | "Tasks" | "Task detail" {
  return tier === 0 ? "Overview" : tier === 1 ? "Tasks" : "Task detail";
}

/** "Viewing" is the resting tool (pan): the board is being read, not edited. */
export function toolLabel(tool: CanvasTool): "Viewing" | "Draw concept" | "Edit concepts" {
  return tool === "draw" ? "Draw concept" : tool === "edit" ? "Edit concepts" : "Viewing";
}
