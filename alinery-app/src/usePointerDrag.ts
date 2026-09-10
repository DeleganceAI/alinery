import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef } from "react";

type PointerDragHandlers = {
  onMove: (event: PointerEvent) => void;
  onComplete: (event: PointerEvent) => void;
};

export function usePointerDrag() {
  const detachRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    detachRef.current?.();
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback((event: ReactPointerEvent<HTMLElement>, handlers: PointerDragHandlers) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    detachRef.current?.();
    const pointerId = event.pointerId;

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId === pointerId) handlers.onMove(moveEvent);
    };
    const complete = (completeEvent: PointerEvent) => {
      if (completeEvent.pointerId !== pointerId) return;
      detach();
      handlers.onComplete(completeEvent);
    };
    const detach = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", complete);
      window.removeEventListener("pointercancel", complete);
      if (detachRef.current === detach) detachRef.current = null;
    };

    detachRef.current = detach;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", complete);
    window.addEventListener("pointercancel", complete);
  }, []);

  return { start, stop };
}
