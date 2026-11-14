// The optimistic layer (plan 2.2.7). A view that writes shows the value it wrote at once, keeps showing it until
// the replica has passed the write's `Applied.cursor` (so it never flickers back to the old row while the delta is
// in flight), and drops it on an error so the view returns to the daemon's row.
import type { Cursor } from "alinery-proto/alinery/v1/common_pb";
import { useCallback, useReducer, useRef } from "react";

export class Overlay<T> {
  private layer: { value: T; applied?: Cursor } | undefined;

  /** A write started: show `value`. */
  show(value: T) {
    this.layer = { value };
  }

  /** The write was applied at `cursor`: keep the layer until the replica reaches it. Writes apply in order, so the later cursor wins. */
  applied(cursor: Cursor | undefined) {
    const layer = this.layer;
    if (!layer || !cursor) return;
    const had = layer.applied;
    if (!had || had.epoch !== cursor.epoch || cursor.seq > had.seq) layer.applied = cursor;
  }

  /** The write failed (or was refused): show the daemon's row again. */
  drop() {
    this.layer = undefined;
  }

  get pending(): boolean {
    return this.layer !== undefined;
  }

  /** The layer's value while it holds, else `base`. A replica at or past the write's cursor, or in another epoch (a restarted daemon), ends the layer. */
  read(base: T, replica: Cursor | undefined): T {
    const layer = this.layer;
    if (!layer) return base;
    const at = layer.applied;
    if (at && replica && (replica.epoch !== at.epoch || replica.seq >= at.seq)) {
      this.layer = undefined;
      return base;
    }
    return layer.value;
  }
}

/** An `Overlay` that re-renders its component when it changes. */
export function useOverlay<T>() {
  const ref = useRef<Overlay<T>>(new Overlay<T>());
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const show = useCallback((value: T) => (ref.current.show(value), bump()), []);
  const applied = useCallback((cursor: Cursor | undefined) => (ref.current.applied(cursor), bump()), []);
  const drop = useCallback(() => (ref.current.drop(), bump()), []);
  return { overlay: ref.current, show, applied, drop };
}
