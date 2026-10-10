import { describe, expect, it, vi } from "vitest";
import { restoreViewport, saveViewport } from "./terminalViewport";

const at = (viewportY: number, baseY: number) => ({ buffer: { active: { viewportY, baseY } } });

describe("terminal viewport memory", () => {
  it("restores a scrolled-back position once", () => {
    const term = { scrollToLine: vi.fn() };
    saveViewport("a", at(120, 500));
    restoreViewport("a", term);
    restoreViewport("a", term);
    expect(term.scrollToLine).toHaveBeenCalledTimes(1);
    expect(term.scrollToLine).toHaveBeenCalledWith(120);
  });

  it("does not restore when the pane was at the bottom, and forgets an older saved line", () => {
    const term = { scrollToLine: vi.fn() };
    saveViewport("b", at(10, 500));
    saveViewport("b", at(500, 500));
    restoreViewport("b", term);
    expect(term.scrollToLine).not.toHaveBeenCalled();
  });

  it("keeps sessions apart", () => {
    const term = { scrollToLine: vi.fn() };
    saveViewport("c", at(7, 50));
    restoreViewport("d", term);
    expect(term.scrollToLine).not.toHaveBeenCalled();
  });
});
