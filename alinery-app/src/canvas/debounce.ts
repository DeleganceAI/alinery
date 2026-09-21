// One primitive backs both the ~300ms sidecar write after pointerup and the 320ms
// auto-arrange reflow. Both failure directions are expensive: firing while a gesture is
// still in flight persists half-dragged geometry; never firing at all loses the board. So
// the quiet window does not just wait once — it re-arms itself for as long as the caller
// reports busy, and only fires the first time it observes quiet.
//
// Cancellation is by generation counter rather than a stored timer handle: every arm() call
// captures the current generation, and a fired callback that finds itself stale (superseded
// by a later schedule(), or disposed) is a silent no-op.

export function createGestureDebounce(o: { delayMs: number; isBusy: () => boolean; run: () => void }): { schedule(): void; dispose(): void } {
  let generation = 0;
  let disposed = false;

  const arm = () => {
    const mine = ++generation;
    setTimeout(() => {
      if (disposed || mine !== generation) return;
      if (o.isBusy()) {
        arm();
        return;
      }
      o.run();
    }, o.delayMs);
  };

  return {
    schedule() {
      if (!disposed) arm();
    },
    dispose() {
      disposed = true;
    },
  };
}
