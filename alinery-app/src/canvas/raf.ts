// One repaint per animation frame, no matter how many things went dirty in between. Every
// pointermove on the canvas would otherwise schedule its own paint, and a fast drag fires
// dozens of those between frames — this coalesces them to the one the browser can show.

/** Coalesces repeated `mark()` calls into a single `paint()` per animation frame. */
export function createDirtyRaf(paint: () => void): { mark(): void; dispose(): void } {
  let handle: number | null = null;

  const run = () => {
    handle = null;
    paint();
  };

  return {
    mark() {
      if (handle !== null) return;
      handle = requestAnimationFrame(run);
    },
    dispose() {
      if (handle !== null) {
        cancelAnimationFrame(handle);
        handle = null;
      }
    },
  };
}
