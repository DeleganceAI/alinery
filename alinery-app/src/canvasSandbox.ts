// What keeps an agent-written canvas panel inside its panel. The app's own CSP is null, so a webpage panel brings its
// own: the meta tag goes first, before any markup the agent wrote, and the iframe has no allow-same-origin (an opaque
// origin: no app IPC, no storage, no parent DOM). A chart's Vega loader refuses every fetch and every link.

export const CANVAS_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** The iframe's sandbox attribute. Scripts only: never add allow-same-origin (scripts plus same origin escape the sandbox). */
export const CANVAS_SANDBOX = "allow-scripts";

/** The agent's page with the CSP ahead of everything it wrote, so no tag of its runs before the policy. */
export function withCanvasCsp(html: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CANVAS_CSP}"><meta charset="utf-8">${html}`;
}

const refuse = () => Promise.reject(new Error("the canvas loads no data: put it inline in data.values"));

/** A Vega loader that loads nothing and links nowhere. `sanitize` resolves an empty href: a rejection crashes the SVG renderer. */
export function lockedLoader<L extends object>(base: L): L {
  return { ...base, load: refuse, http: refuse, file: refuse, sanitize: async () => ({ href: null }) };
}
