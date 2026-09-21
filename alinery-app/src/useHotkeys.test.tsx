import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Handlers, useHotkeys } from "./useHotkeys";

afterEach(cleanup);

function Probe({ handlers, controls = false }: { handlers: Handlers; controls?: boolean }) {
  useHotkeys(handlers);
  return controls ? (
    <>
      <input aria-label="input" />
      <textarea aria-label="textarea" />
      <div role="textbox" aria-label="editable" contentEditable />
    </>
  ) : null;
}

const handlers = (overrides: Partial<Handlers> = {}): Handlers => ({
  overlayOpen: false,
  isFullscreen: false,
  board: "list",
  toggleSearch: vi.fn(),
  openCreate: vi.fn(),
  goList: vi.fn(),
  goKanban: vi.fn(),
  goGrid: vi.fn(),
  goSessions: vi.fn(),
  goNotifications: vi.fn(),
  goSettings: vi.fn(),
  archiveSelected: vi.fn(),
  duplicateSelected: vi.fn(),
  openSelected: vi.fn(),
  toggleGlow: vi.fn(),
  sync: vi.fn(),
  back: vi.fn(),
  moveRow: vi.fn(),
  moveCol: vi.fn(),
  toggleTerminalDrawer: vi.fn(),
  killTerminalDrawer: vi.fn(),
  toggleCanvas: vi.fn(),
  canvasEscape: undefined,
  canvasKey: undefined,
  ...overrides,
});

function commandCallbacks(value: Handlers) {
  return [
    value.toggleSearch,
    value.openCreate,
    value.goList,
    value.goKanban,
    value.goGrid,
    value.goSessions,
    value.goNotifications,
    value.goSettings,
    value.archiveSelected,
    value.openSelected,
    value.toggleGlow,
    value.sync,
    value.back,
    value.moveRow,
    value.moveCol,
    value.toggleTerminalDrawer,
    value.killTerminalDrawer,
  ];
}

describe("useHotkeys", () => {
  it("opens search with Command-K before an overlay takes ownership", () => {
    const active = handlers({ overlayOpen: true });
    render(<Probe handlers={active} />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.keyDown(window, { key: "ArrowDown" });

    expect(active.toggleSearch).toHaveBeenCalledOnce();
    expect(active.moveRow).not.toHaveBeenCalled();
  });

  it("routes both Meta+D and Control+D only to duplicateSelected", () => {
    const active = handlers();
    render(<Probe handlers={active} />);

    fireEvent.keyDown(document.body, { key: "d", code: "KeyD", metaKey: true });
    fireEvent.keyDown(document.body, { key: "D", code: "KeyD", ctrlKey: true });

    expect(active.duplicateSelected).toHaveBeenCalledTimes(2);
    for (const callback of commandCallbacks(active)) expect(callback).not.toHaveBeenCalled();
  });

  it("does not duplicate while an overlay is open", () => {
    const active = handlers({ overlayOpen: true });
    render(<Probe handlers={active} />);

    fireEvent.keyDown(document.body, { key: "d", code: "KeyD", metaKey: true });

    expect(active.duplicateSelected).not.toHaveBeenCalled();
  });

  it.each(["input", "textarea", "editable"])("does not duplicate from %s controls", (label) => {
    const active = handlers();
    render(<Probe handlers={active} controls />);

    fireEvent.keyDown(screen.getByLabelText(label), { key: "d", code: "KeyD", metaKey: true });

    expect(active.duplicateSelected).not.toHaveBeenCalled();
  });

  it.each([
    ["1", "goList"],
    ["3", "goKanban"],
    ["7", "goSessions"],
    ["8", "goNotifications"],
    ["9", "goSettings"],
    [",", "goSettings"],
  ] as const)("maps Command-%s to only %s", (key, handler) => {
    const active = handlers();
    render(<Probe handlers={active} />);

    fireEvent.keyDown(document.body, { key, metaKey: true });

    expect(active[handler]).toHaveBeenCalledOnce();
    for (const other of ["goKanban", "goList", "goSessions", "goNotifications", "goSettings", "goGrid"] as const) {
      if (other !== handler) expect(active[other]).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["2", 0],
    ["4", 1],
    ["5", 2],
  ] as const)("maps Command-%s to Grid slot %s", (key, slot) => {
    const active = handlers();
    render(<Probe handlers={active} />);

    fireEvent.keyDown(document.body, { key, metaKey: true });

    expect(active.goGrid).toHaveBeenCalledWith(slot);
  });

  it("leaves Command-6 unassigned", () => {
    const active = handlers();
    render(<Probe handlers={active} />);

    fireEvent.keyDown(document.body, { key: "6", metaKey: true });

    for (const callback of commandCallbacks(active)) expect(callback).not.toHaveBeenCalled();
  });

  it("toggles Orbitron View with Command-Shift-O and does not go back", () => {
    const active = handlers();
    render(<Probe handlers={active} />);

    fireEvent.keyDown(document.body, { key: "o", metaKey: true, shiftKey: true });

    expect(active.toggleCanvas).toHaveBeenCalledOnce();
    expect(active.back).not.toHaveBeenCalled();
    expect(active.toggleGlow).not.toHaveBeenCalled();
  });

  it("does not bind Command-Shift-C to toggleCanvas", () => {
    const active = handlers();
    render(<Probe handlers={active} />);
    fireEvent.keyDown(document.body, { key: "c", metaKey: true, shiftKey: true });

    expect(active.toggleCanvas).not.toHaveBeenCalled();
  });

  it("routes Escape to canvasEscape instead of back when provided", () => {
    const canvasEscape = vi.fn();
    const active = handlers({ canvasEscape });
    render(<Probe handlers={active} />);

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(canvasEscape).toHaveBeenCalledOnce();
    expect(active.back).not.toHaveBeenCalled();
  });

  it("does not call back when canvasEscape is a no-op", () => {
    const active = handlers({ canvasEscape: () => {} });
    render(<Probe handlers={active} />);

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(active.back).not.toHaveBeenCalled();
  });

  it("still calls back on Escape when canvasEscape is absent", () => {
    const active = handlers();
    render(<Probe handlers={active} />);

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(active.back).toHaveBeenCalledOnce();
  });

  // `canvasKey`'s return value is the whole contract: true = consumed. Both branches are
  // asserted against a live nav key on a board, so neither assertion can pass vacuously.
  it("lets canvasKey consume a bare nav key before the board sees it", () => {
    const canvasKey = vi.fn().mockReturnValue(true);
    const active = handlers({ board: "kanban", canvasKey });
    render(<Probe handlers={active} />);

    const notPrevented = fireEvent.keyDown(document.body, { key: "j" });

    expect(canvasKey).toHaveBeenCalledOnce();
    expect(active.moveRow).not.toHaveBeenCalled();
    expect(notPrevented).toBe(false);
  });

  it("falls through to the board when canvasKey declines the key", () => {
    const canvasKey = vi.fn().mockReturnValue(false);
    const active = handlers({ board: "kanban", canvasKey });
    render(<Probe handlers={active} />);

    fireEvent.keyDown(document.body, { key: "j" });

    expect(canvasKey).toHaveBeenCalledOnce();
    expect(active.moveRow).toHaveBeenCalledWith(1);
  });
});
