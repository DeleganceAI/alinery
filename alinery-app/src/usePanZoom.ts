import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePointerDrag } from "./usePointerDrag";

export type PanZoomView = { scale: number; tx: number; ty: number };

type PanZoomOptions = {
  viewportRef: RefObject<HTMLDivElement | null>;
  paint: (view: PanZoomView) => void;
  initialScale?: number;
  minScale?: number;
  maxScale?: number;
  enabled?: boolean;
};

const WHEEL_ZOOM_SENSITIVITY = 0.0018;
const INTERACTIVE_TARGET =
  'button, a, input, select, textarea, summary, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"]), [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="textbox"]';

export function usePanZoom({ viewportRef, paint, initialScale = 1, minScale = 0.05, maxScale = 8, enabled = true }: PanZoomOptions) {
  const min = Number.isFinite(minScale) && minScale > 0 ? minScale : 0.05;
  const max = Number.isFinite(maxScale) && maxScale >= min ? maxScale : Math.max(min, 8);
  const optionsRef = useRef({ paint, min, max, enabled });
  useLayoutEffect(() => {
    optionsRef.current = { paint, min, max, enabled };
  }, [paint, min, max, enabled]);

  const viewRef = useRef<PanZoomView>({
    scale: Math.min(max, Math.max(min, Number.isFinite(initialScale) ? initialScale : 1)),
    tx: 0,
    ty: 0,
  });
  const [panning, setPanning] = useState(false);
  const { start, stop } = usePointerDrag();
  const captureRef = useRef<{ element: HTMLDivElement; pointerId: number } | null>(null);

  const setView = useCallback((view: PanZoomView) => {
    if (Number.isNaN(view.scale) || !Number.isFinite(view.tx) || !Number.isFinite(view.ty)) return;
    const options = optionsRef.current;
    const next = { ...view, scale: Math.min(options.max, Math.max(options.min, view.scale)) };
    viewRef.current = next;
    options.paint(next);
  }, []);

  const zoomAt = useCallback(
    (nextScale: number, px: number, py: number) => {
      const { scale, tx, ty } = viewRef.current;
      const { min: lower, max: upper } = optionsRef.current;
      const next = Math.min(upper, Math.max(lower, nextScale));
      if (next === scale || !Number.isFinite(next) || !Number.isFinite(px) || !Number.isFinite(py)) return;
      setView({ scale: next, tx: px - ((px - tx) / scale) * next, ty: py - ((py - ty) / scale) * next });
    },
    [setView],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const viewport = viewportRef.current;
      if (!viewport || !Number.isFinite(factor) || factor <= 0) return;
      zoomAt(viewRef.current.scale * factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
    },
    [viewportRef, zoomAt],
  );

  const center = useCallback(
    (width: number, height: number, scale: number) => {
      const viewport = viewportRef.current;
      if (!viewport || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !Number.isFinite(scale)) return;
      const { min: lower, max: upper } = optionsRef.current;
      const next = Math.min(upper, Math.max(lower, scale));
      setView({ scale: next, tx: (viewport.clientWidth - width * next) / 2, ty: (viewport.clientHeight - height * next) / 2 });
    },
    [viewportRef, setView],
  );

  const fit = useCallback(
    (width: number, height: number) => {
      const viewport = viewportRef.current;
      if (!viewport || width <= 0 || height <= 0) return;
      center(width, height, Math.min(1, (viewport.clientWidth - 32) / width, (viewport.clientHeight - 32) / height));
    },
    [viewportRef, center],
  );

  const releaseCapture = useCallback(() => {
    const capture = captureRef.current;
    captureRef.current = null;
    if (capture?.element.hasPointerCapture?.(capture.pointerId)) {
      capture.element.releasePointerCapture(capture.pointerId);
    }
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!optionsRef.current.enabled || (event.button !== 0 && event.button !== 1)) return;
      const interactive = event.target instanceof Element ? event.target.closest(INTERACTIVE_TARGET) : null;
      if (event.button === 0 && interactive && interactive !== event.currentTarget) return;
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      releaseCapture();
      let x = event.clientX;
      let y = event.clientY;
      start(event, {
        onMove: (moveEvent) => {
          if (!Number.isFinite(moveEvent.clientX) || !Number.isFinite(moveEvent.clientY)) return;
          const view = viewRef.current;
          setView({ scale: view.scale, tx: view.tx + moveEvent.clientX - x, ty: view.ty + moveEvent.clientY - y });
          x = moveEvent.clientX;
          y = moveEvent.clientY;
        },
        onComplete: () => {
          releaseCapture();
          setPanning(false);
        },
      });
      captureRef.current = { element: event.currentTarget, pointerId: event.pointerId };
      setPanning(true);
    },
    [releaseCapture, setView, start],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!enabled || !viewport) {
      stop();
      releaseCapture();
      setPanning(false);
      return;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      let dy = event.deltaY;
      if (event.deltaMode === 1) dy *= 16;
      if (event.deltaMode === 2) dy *= viewport.clientHeight;
      if (!Number.isFinite(dy) || dy === 0) return;
      // Bound the exponent so extreme but finite deltas still reach the scale limits.
      const factor = Math.exp(Math.min(700, Math.max(-700, -dy * WHEEL_ZOOM_SENSITIVITY)));
      const rect = viewport.getBoundingClientRect();
      zoomAt(viewRef.current.scale * factor, event.clientX - rect.left - viewport.clientLeft, event.clientY - rect.top - viewport.clientTop);
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", onWheel);
      stop();
      releaseCapture();
    };
  }, [enabled, viewportRef, zoomAt, stop, releaseCapture]);

  return { viewRef, panning, setView, zoomBy, center, fit, onPointerDown };
}
