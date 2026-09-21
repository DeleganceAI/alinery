import { describe, expect, it } from "vitest";
import { type Camera, clampScale, fitCamera, lodLabel, lodTier, panCamera, type Rect, screenToWorld, toolLabel, worldToScreen, zoomAt } from "./camera";

// 3.12 — LOD thresholds, strict "<" boundaries. Overview keeps the POC's 0.45; detail moved
// from the POC's 1.35 to 1.0 when the card grew to carry its sessions (see camera.ts).
describe("lodTier", () => {
  it("switches tier at the boundary scales", () => {
    expect(lodTier(0.44)).toBe(0);
    expect(lodTier(0.45)).toBe(1);
    expect(lodTier(0.99)).toBe(1);
    expect(lodTier(1.0)).toBe(2);
  });
});

// 3.13 — labels for each tier.
describe("lodLabel", () => {
  it("names each tier", () => {
    expect(lodLabel(0)).toBe("Overview");
    expect(lodLabel(1)).toBe("Tasks");
    expect(lodLabel(2)).toBe("Task detail");
  });
});

// The footer and the canvas's accessible name both read these words from here, so a rename
// cannot desync them. The resting tool is "Viewing": nothing is being authored until a tool is on.
describe("toolLabel", () => {
  it("names each tool", () => {
    expect(toolLabel("pan")).toBe("Viewing");
    expect(toolLabel("draw")).toBe("Draw concept");
    expect(toolLabel("edit")).toBe("Edit concepts");
  });
});

// 3.14 — clamp to [MIN_SCALE, MAX_SCALE].
describe("clampScale", () => {
  it("clamps below the floor, above the ceiling, and passes through in range", () => {
    expect(clampScale(0.01)).toBe(0.15);
    expect(clampScale(4)).toBe(3);
    expect(clampScale(1)).toBe(1);
  });
});

// 3.15 — zoom toward cursor keeps the world point under (100, 50) fixed.
describe("zoomAt", () => {
  it("keeps the world point under the cursor before and after the zoom", () => {
    const before: Camera = { x: 0, y: 0, scale: 1 };
    const worldBefore = screenToWorld(before, 100, 50);

    const after = zoomAt(before, 100, 50, 2);
    const worldAfter = screenToWorld(after, 100, 50);

    expect(after.scale).toBe(2);
    expect(Math.abs(worldAfter.x - worldBefore.x)).toBeLessThan(1e-9);
    expect(Math.abs(worldAfter.y - worldBefore.y)).toBeLessThan(1e-9);
  });
});

// panCamera / worldToScreen / screenToWorld are exercised as the invariant's building
// blocks above (per 05-tdd.md: "if zoom-at is wrong, the invariant fails"). This adds
// the direct round-trip and pan-direction checks the invariant alone doesn't pin down.
describe("worldToScreen / screenToWorld", () => {
  it("round-trips a point through an offset, scaled camera", () => {
    const cam: Camera = { x: 20, y: -10, scale: 1.5 };
    const screen = worldToScreen(cam, 120, 80);
    const world = screenToWorld(cam, screen.x, screen.y);
    expect(world.x).toBeCloseTo(120, 9);
    expect(world.y).toBeCloseTo(80, 9);
  });
});

describe("panCamera", () => {
  it("moves the camera opposite the drag, scaled into world units", () => {
    const cam: Camera = { x: 0, y: 0, scale: 2 };
    const panned = panCamera(cam, 20, -10);
    expect(panned.x).toBeCloseTo(-10, 9);
    expect(panned.y).toBeCloseTo(5, 9);
    expect(panned.scale).toBe(2);
  });
});

// 3.16 — fitting an empty or zero-area board resets rather than dividing by zero.
describe("fitCamera empty bounds", () => {
  it("resets to the identity camera for null bounds", () => {
    expect(fitCamera(null, { w: 400, h: 300 })).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("resets to the identity camera for zero-area bounds", () => {
    const zeroArea: Rect = { x: 10, y: 10, w: 0, h: 50 };
    expect(fitCamera(zeroArea, { w: 400, h: 300 })).toEqual({ x: 0, y: 0, scale: 1 });
  });
});

// 3.17 — fitting a real rect uses the 48px pad and clamps the scale. Asserted
// geometrically: the fitted bounds' corners must land inside the padded viewport,
// not against a hard-coded scale.
describe("fitCamera padding", () => {
  it("fits a 200x72 rect inside a 400x300 viewport with 48px pad", () => {
    const bounds: Rect = { x: 500, y: 300, w: 200, h: 72 };
    const viewport = { w: 400, h: 300 };
    const padPx = 48;

    const cam = fitCamera(bounds, viewport, padPx);
    expect(cam.scale).toBeGreaterThanOrEqual(0.15);
    expect(cam.scale).toBeLessThanOrEqual(3);

    const topLeft = worldToScreen(cam, bounds.x, bounds.y);
    const bottomRight = worldToScreen(cam, bounds.x + bounds.w, bounds.y + bounds.h);
    const eps = 1e-6;

    expect(topLeft.x).toBeGreaterThanOrEqual(padPx - eps);
    expect(topLeft.y).toBeGreaterThanOrEqual(padPx - eps);
    expect(bottomRight.x).toBeLessThanOrEqual(viewport.w - padPx + eps);
    expect(bottomRight.y).toBeLessThanOrEqual(viewport.h - padPx + eps);
  });
});
