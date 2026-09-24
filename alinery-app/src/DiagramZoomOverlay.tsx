import { X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useLayoutEffect, useRef } from "react";
import { Dialog } from "./shared";
import { type PanZoomView, usePanZoom } from "./usePanZoom";

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
/** Multiplicative step for + / − buttons only. */
const BUTTON_STEP = 1.25;
/** Open larger than layout pixels so node labels are readable without a pre-zoom. */
const DEFAULT_SCALE = 2;
const MIN_VIEWPORT_PX = 48;

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
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const baseSizeRef = useRef({ w: 1, h: 1 });

  /** Paint current view onto the live DOM immediately (no React re-render required). */
  const paintView = useCallback((view: PanZoomView) => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.style.transform = `translate(${view.tx}px, ${view.ty}px)`;
    const svg = stage.querySelector("svg");
    if (svg instanceof SVGSVGElement) {
      const { w, h } = baseSizeRef.current;
      applySvgDisplaySize(svg, w, h, view.scale);
    }
  }, []);

  const { panning, zoomBy, center, onPointerDown } = usePanZoom({
    viewportRef,
    paint: paintView,
    initialScale: DEFAULT_SCALE,
    minScale: MIN_SCALE,
    maxScale: MAX_SCALE,
  });

  const placeDefault = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (viewport.clientWidth < MIN_VIEWPORT_PX || viewport.clientHeight < MIN_VIEWPORT_PX) return;
    const { w, h } = baseSizeRef.current;
    center(w, h, DEFAULT_SCALE);
  }, [center]);

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
          <button type="button" className="btn ghost small" data-autofocus="" onClick={() => zoomBy(BUTTON_STEP)} title="Zoom in" aria-label="Zoom in">
            <ZoomIn size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button type="button" className="btn ghost small" onClick={() => zoomBy(1 / BUTTON_STEP)} title="Zoom out" aria-label="Zoom out">
            <ZoomOut size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button type="button" className="btn ghost small" onClick={placeDefault} title="Reset zoom">
            Reset
          </button>
        </div>
        <div ref={viewportRef} className={`diagram-zoom-viewport${panning ? " is-panning" : ""}`} onPointerDown={onPointerDown}>
          {/* Empty on purpose: SVG injected once in useLayoutEffect (see file header). */}
          <div ref={stageRef} className="diagram-zoom-stage" />
        </div>
      </div>
    </Dialog>
  );
}
