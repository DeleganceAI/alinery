// Theme role reads and label truncation for the canvas paint path.
//
// readCanvasTokens is the ONLY place in the canvas code allowed to call getComputedStyle.
// getComputedStyle forces a style recalc, and the card paint path draws up to ~100 cards
// a frame — resolving custom properties per card is exactly the kind of per-item DOM read
// that turns a smooth board into a stutter. Callers read the palette once per paint pass
// (or once per token-affecting change) and thread the result through; paint.ts and
// pipes.ts are forbidden from importing getComputedStyle themselves, and a Phase 8 source
// gate enforces that.
export type CanvasTokens = {
  canvas: string;
  surface: string;
  text: string;
  textStrong: string;
  textMuted: string;
  accent: string;
  border: string;
  danger: string;
  fontUi: string;
  uiScale: number;
};

export function readCanvasTokens(el: Element): CanvasTokens {
  const style = getComputedStyle(el);
  const read = (name: string) => style.getPropertyValue(name).trim();
  const uiScale = Number.parseFloat(read("--ui-scale"));
  return {
    canvas: read("--canvas"),
    surface: read("--surface"),
    text: read("--text"),
    textStrong: read("--text-strong"),
    textMuted: read("--text-muted"),
    accent: read("--accent"),
    border: read("--border"),
    danger: read("--danger"),
    fontUi: read("--font-ui"),
    uiScale: Number.isFinite(uiScale) ? uiScale : 1,
  };
}

// Truncation is cached by (fontKey, maxWidth, text) because `measure` is a canvas text
// metrics call, and the same label gets asked about on every repaint while nothing on
// screen changed. The cache is cleared once it passes MAX_CACHE_ENTRIES rather than left
// to grow — a long-running session repaints indefinitely, and an unbounded cache keyed on
// live task titles is a slow leak, not a one-time cost.
const MAX_CACHE_ENTRIES = 4000;

const truncateCache = new Map<string, string>();

export function truncateCached(text: string, maxWidth: number, fontKey: string, measure: (s: string) => number): string {
  const key = `${fontKey}\u0000${maxWidth}\u0000${text}`;
  const cached = truncateCache.get(key);
  if (cached !== undefined) return cached;

  let result: string;
  if (measure(text) <= maxWidth) {
    result = text;
  } else {
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (measure(`${text.slice(0, mid)}…`) <= maxWidth) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    result = `${text.slice(0, lo)}…`;
  }

  if (truncateCache.size >= MAX_CACHE_ENTRIES) truncateCache.clear();
  truncateCache.set(key, result);
  return result;
}
