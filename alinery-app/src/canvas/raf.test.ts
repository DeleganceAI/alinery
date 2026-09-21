import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDirtyRaf } from "./raf";

// A hand-flushed fake: requestAnimationFrame queues callbacks instead of scheduling a real
// frame, so tests control exactly when a "frame" happens and never depend on real time.
let queue: { id: number; cb: FrameRequestCallback }[] = [];
let nextId = 1;

function flush(): void {
  const pending = queue;
  queue = [];
  for (const { cb } of pending) cb(0);
}

beforeEach(() => {
  queue = [];
  nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queue = queue.filter((q) => q.id !== id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createDirtyRaf", () => {
  it("coalesces two mark calls before a frame into one paint", () => {
    const paint = vi.fn();
    const raf = createDirtyRaf(paint);
    raf.mark();
    raf.mark();
    flush();
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels the pending frame so paint never runs", () => {
    const paint = vi.fn();
    const raf = createDirtyRaf(paint);
    raf.mark();
    raf.dispose();
    flush();
    expect(paint).not.toHaveBeenCalled();
  });
});
