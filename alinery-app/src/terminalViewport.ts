// Remembers where a user had scrolled back to when a terminal pane unmounts, so a tab
// switch that remounts xterm can put them back. Scroll position only: an xterm selection
// does not survive dispose, and re-selecting by buffer coordinates is not worth it yet.
// A viewport at the bottom is not saved: that is the default for a fresh replay.
const saved = new Map<string, number>();

type Savable = { buffer: { active: { viewportY: number; baseY: number } } };
type Scrollable = { scrollToLine: (line: number) => void };

export function saveViewport(id: string, term: Savable) {
  const { viewportY, baseY } = term.buffer.active;
  if (viewportY < baseY) saved.set(id, viewportY);
  else saved.delete(id);
}

/** One-shot: the saved line is consumed so a later replay settle cannot yank the view again. */
export function restoreViewport(id: string, term: Scrollable) {
  const line = saved.get(id);
  if (line === undefined) return;
  saved.delete(id);
  term.scrollToLine(line);
}
