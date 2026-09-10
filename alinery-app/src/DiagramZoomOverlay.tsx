import { X, ZoomIn, ZoomOut } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Dialog } from "./shared";

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
/** Multiplicative step for + / − buttons only. */
const BUTTON_STEP = 1.25;
/**
 * Continuous wheel sensitivity. Trackpads fire many small deltaY events; treating
 * each as a full step caused reverse-direction "bursts". Exponential map is smooth.
 */
const WHEEL_ZOOM_SENSITIVITY = 0.0018;
/** Open larger than layout pixels so node labels are readable without a pre-zoom. */
const DEFAULT_SCALE = 2;
const MIN_VIEWPORT_PX = 48;

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** Zoom so the content point under (px, py) stays fixed (coords in base SVG units). */
function zoomAt(scale: number, tx: number, ty: number, nextScale: number, px: number, py: number): { scale: number; tx: number; ty: number } {
  const s = clampScale(nextScale);
  // Guard: if scale didn't change (hit clamp), keep pan stable.
  if (s === scale) return { scale, tx, ty };
  const contentX = (px - tx) / scale;
  const contentY = (py - ty) / scale;
  return { scale: s, tx: px - contentX * s, ty: py - contentY * s };
}

function readNaturalSvgSize(svg: SVGSVGElement): { w: number; h: number } {
  const vb = svg.viewBox?.baseVal;
  let w = vb && vb.width > 0 ? vb.width : 0;
  let h = vb && vb.height > 0 ? vb.height : 0;

  if (!(w > 0 && h > 0)) {
    const attrW = svg.getAttribute("width") ?? "";
    const attrH = svg.getAttribute("height") ?? "";
    if (!attrW.includes("%") && !attrH.includes("%")) {
      const pw = parseFloat(attrW);
      const ph = parseFloat(attrH);
      if (pw > 0 && ph > 0) {
        w = pw;
        h = ph;
      }
    }
  }

  if (!(w > 0 && h > 0)) {
    try {
      const box = svg.getBBox();
      if (box.width > 0 && box.height > 0) {
        w = box.width;
        h = box.height;
      }
    } catch {
      /* not laid out yet */
    }
  }

  if (!(w > 0 && h > 0)) {
    w = 800;
    h = 600;
  }
  return { w, h };
}

/** Resize SVG to base×scale (vectors re-render sharp — no CSS transform:scale). */
function applySvgDisplaySize(svg: SVGSVGElement, baseW: number, baseH: number, scale: number) {
  const w = baseW * scale;
  const h = baseH * scale;
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.style.width = `${w}px`;
  svg.style.height = `${h}px`;
  svg.style.maxWidth = "none";
  svg.style.maxHeight = "none";
  svg.style.shapeRendering = "geometricPrecision";
  svg.style.textRendering = "geometricPrecision";
}

function computeDefaultPlacement(viewportW: number, viewportH: number, baseW: number, baseH: number, scale: number): { scale: number; tx: number; ty: number } {
  const s = clampScale(scale);
  return {
    scale: s,
    tx: (viewportW - baseW * s) / 2,
    ty: (viewportH - baseH * s) / 2,
  };
}

type View = { scale: number; tx: number; ty: number };

/**
 * Mermaid diagram pan/zoom overlay.
 *
 * Stability rules (the earlier jumpiness came from violating these):
 * 1. Inject SVG HTML **once** via DOM — never `dangerouslySetInnerHTML` on pan/zoom
 *    re-renders (that reset width/height every frame → flicker + coordinate thrash).
 * 2. Keep the live view in a **ref** updated **synchronously** on every wheel tick so
 *    rapid events don't all multiply from a stale React state scale (felt like reverse bursts).
 * 3. Apply pan/zoom **imperatively** to the stage/SVG; React state is only for UI chrome
 *    (panning cursor class).
 */
export function DiagramZoomOverlay({ svgHtml, onClose }: { svgHtml: string; onClose: () => void }) {
  const [panning, setPanning] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const baseSizeRef = useRef({ w: 1, h: 1 });
  const viewRef = useRef<View>({ scale: DEFAULT_SCALE, tx: 0, ty: 0 });

  /** Paint current view onto the live DOM immediately (no React re-render required). */
  const paintView = useCallback((view: View) => {
    viewRef.current = view;
    const stage = stageRef.current;
    if (!stage) return;
    stage.style.transform = `translate(${view.tx}px, ${view.ty}px)`;
    const svg = stage.querySelector("svg");
    if (svg instanceof SVGSVGElement) {
      const { w, h } = baseSizeRef.current;
      applySvgDisplaySize(svg, w, h, view.scale);
    }
  }, []);

  const placeDefault = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (viewport.clientWidth < MIN_VIEWPORT_PX || viewport.clientHeight < MIN_VIEWPORT_PX) return;
    const { w, h } = baseSizeRef.current;
    paintView(computeDefaultPlacement(viewport.clientWidth, viewport.clientHeight, w, h, DEFAULT_SCALE));
  }, [paintView]);

  const zoomAtPoint = useCallback(
    (nextScale: number, px: number, py: number) => {
      const { scale, tx, ty } = viewRef.current;
      paintView(zoomAt(scale, tx, ty, nextScale, px, py));
    },
    [paintView],
  );

  const zoomTowardCenter = useCallback(
    (factor: number) => {
      const el = viewportRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      zoomAtPoint(viewRef.current.scale * factor, rect.width / 2, rect.height / 2);
    },
    [zoomAtPoint],
  );

  // Inject SVG once per svgHtml. Do NOT put svgHtml into JSX as dangerouslySetInnerHTML
  // bound to pan/zoom state — that re-parsed the SVG every frame and fought our sizing.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const viewport = viewportRef.current;
    if (!stage || !viewport) return;

    stage.innerHTML = svgHtml;
    const svg = stage.querySelector("svg");
    if (!(svg instanceof SVGSVGElement)) return;

    baseSizeRef.current = readNaturalSvgSize(svg);

    let placed = false;
    const tryPlace = () => {
      if (placed) return;
      if (viewport.clientWidth < MIN_VIEWPORT_PX || viewport.clientHeight < MIN_VIEWPORT_PX) return;
      placeDefault();
      placed = true;
      ro.disconnect();
    };

    // One-shot: wait until flex modal has a real size, then never re-place from RO
    // (SVG size changes must not re-center/fight the user).
    const ro = new ResizeObserver(() => tryPlace());
    ro.observe(viewport);
    tryPlace();
    const raf = requestAnimationFrame(tryPlace);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [svgHtml, placeDefault]);

  // Native non-passive wheel. Continuous factor from deltaY; read/write viewRef sync.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // ctrlKey often means pinch-zoom on trackpads — still treat as zoom.
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      // Normalize line/page deltas to roughly pixel-ish magnitude.
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      if (e.deltaMode === 2) dy *= rect.height;
      // exp(-dy * k): scroll up (neg dy) → zoom in; magnitude proportional to gesture.
      const factor = Math.exp(-dy * WHEEL_ZOOM_SENSITIVITY);
      if (!Number.isFinite(factor) || factor === 1) return;
      zoomAtPoint(viewRef.current.scale * factor, px, py);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAtPoint]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      tx: viewRef.current.tx,
      ty: viewRef.current.ty,
    };
    setPanning(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    paintView({
      scale: viewRef.current.scale,
      tx: drag.tx + (e.clientX - drag.x),
      ty: drag.ty + (e.clientY - drag.y),
    });
  };

  const endPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setPanning(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  // The shared Dialog owns modality: native showModal(), Esc -> onClose, backdrop
  // click -> onClose, focus restored to the opener.
  return (
    <Dialog onClose={onClose} ariaLabel="Diagram" className="diagram-zoom-modal">
      <div className="mh">
        <span className="mt">Diagram</span>
        <button type="button" className="x" aria-label="Close diagram zoom" title="Close" onClick={onClose}>
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <div className="mb diagram-zoom-body">
        <div className="diagram-zoom-toolbar">
          <button type="button" className="btn ghost small" data-autofocus="" onClick={() => zoomTowardCenter(BUTTON_STEP)} title="Zoom in" aria-label="Zoom in">
            <ZoomIn size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button type="button" className="btn ghost small" onClick={() => zoomTowardCenter(1 / BUTTON_STEP)} title="Zoom out" aria-label="Zoom out">
            <ZoomOut size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button type="button" className="btn ghost small" onClick={placeDefault} title="Reset zoom">
            Reset
          </button>
        </div>
        <div
          ref={viewportRef}
          className={`diagram-zoom-viewport${panning ? " is-panning" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        >
          {/* Empty on purpose: SVG injected once in useLayoutEffect (see file header). */}
          <div ref={stageRef} className="diagram-zoom-stage" />
        </div>
      </div>
    </Dialog>
  );
}
