// Module-level drop target for "place this new task on the canvas".
//
// The gesture that creates this value spans a page navigation: the user drags a picker
// entry (or draws a hull) on CanvasView, which opens CreateTaskPage, which unmounts
// CanvasView entirely before the task exists. There is no component instance alive to
// hold "where the new task goes" in its own state across that unmount, so the target has
// to live outside any component. `takePendingPlace` is destructive — CanvasView consumes
// it once on the task's creation and clears it, so a stale target never silently reapplies
// to the next task created a different way.
export type PendingPlace = { conceptId?: string; x: number; y: number };

let pending: PendingPlace | null = null;

export function setPendingPlace(p: PendingPlace): void {
  pending = p;
}

export function takePendingPlace(): PendingPlace | null {
  const p = pending;
  pending = null;
  return p;
}
