// A PDF in a canvas panel: pdf.js draws each page to a canvas at the panel's width. Loaded lazily (CanvasFiles.tsx).
// The legacy build: the webview is the machine's WebKit, which on an older macOS lacks what the modern build assumes.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "./chatThreadSession";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** ponytail: pages are drawn up front; past this many the rest wait for Save a copy. Draw on scroll if decks get long. */
const MAX_PAGES = 50;

export default function CanvasPdf({ bytes }: { bytes: Uint8Array }) {
  const host = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    // pdf.js transfers the buffer to its worker: give it a copy, so the bytes stay for Save a copy.
    const task = pdfjs.getDocument({ data: bytes.slice(), enableXfa: false });
    let live = true;
    setNote("");
    el.replaceChildren();
    task.promise
      .then(async (doc) => {
        const pages = Math.min(doc.numPages, MAX_PAGES);
        if (doc.numPages > MAX_PAGES) setNote(`Showing the first ${MAX_PAGES} of ${doc.numPages} pages.`);
        for (let n = 1; n <= pages && live; n++) {
          const page = await doc.getPage(n);
          const width = el.clientWidth || 600;
          const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
          const ratio = window.devicePixelRatio || 1;
          const canvas = document.createElement("canvas");
          canvas.className = "canvas-pdf-page";
          canvas.width = Math.floor(viewport.width * ratio);
          canvas.height = Math.floor(viewport.height * ratio);
          canvas.setAttribute("aria-label", `Page ${n}`);
          el.append(canvas);
          await page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise;
        }
      })
      .catch((e: unknown) => live && setNote(`Couldn't show this PDF: ${errorMessage(e)}`));
    return () => {
      live = false;
      void task.destroy();
    };
  }, [bytes]);
  return (
    <div className="canvas-pdf">
      {note && <p className="dim">{note}</p>}
      <div ref={host} className="canvas-pdf-pages" />
    </div>
  );
}
