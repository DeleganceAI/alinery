import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
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
  // The product default: one Grid view and classic Kanban on, so the bar reads
  // ⌘1 Grid, ⌘2 Tasks, ⌘3 Sessions, ⌘4 Kanban.
  gridCount: 1,
  showKanban: true,
  toggleSearch: vi.fn(),
  openCreate: vi.fn(),
  goList: vi.fn(),
  goKanban: vi.fn(),
  goGrid: vi.fn(),
  goChat: vi.fn(),
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
  ...overrides,
});

function commandCallbacks(value: Handlers) {
  return [
    value.toggleSearch,
    value.openCreate,
    value.goList,
    value.goKanban,
    value.goChat,
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

  it("routes Meta+D but leaves Control+D to the focused surface", () => {
    const active = handlers();
    render(<Probe handlers={active} />);

    fireEvent.keyDown(document.body, { key: "d", code: "KeyD", metaKey: true });
    const event = createEvent.keyDown(document.body, { key: "D", code: "KeyD", ctrlKey: true, cancelable: true });
    fireEvent(document.body, event);

    expect(active.duplicateSelected).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);
    for (const callback of commandCallbacks(active)) expect(callback).not.toHaveBeenCalled();
  });

  it.each([
    ["a", "KeyA"],
    ["e", "KeyE"],
    ["k", "KeyK"],
  ] as const)("leaves Control-%s unhandled by global hotkeys", (key, code) => {
    const active = handlers();
    render(<Probe handlers={active} />);

    const event = createEvent.keyDown(document.body, { key, code, ctrlKey: true, cancelable: true });
    fireEvent(document.body, event);

    expect(event.defaultPrevented).toBe(false);
    for (const callback of [...commandCallbacks(active), active.duplicateSelected]) expect(callback).not.toHaveBeenCalled();
  });

  it.each(["input", "textarea", "editable"])("leaves Control-K from %s controls to native editing", (label) => {
    const active = handlers();
    render(<Probe handlers={active} controls />);
    const target = screen.getByLabelText(label);

    const event = createEvent.keyDown(target, { key: "k", code: "KeyK", ctrlKey: true, cancelable: true });
    fireEvent(target, event);

    expect(event.defaultPrevented).toBe(false);
    for (const callback of [...commandCallbacks(active), active.duplicateSelected]) expect(callback).not.toHaveBeenCalled();
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
    ["2", "goList"],
    ["3", "goSessions"],
    ["4", "goKanban"],
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

  it("shifts every later shortcut right as Grid views are added", () => {
    const active = handlers({ gridCount: 3 });
    render(<Probe handlers={active} />);

    fireEvent.keyDown(document.body, { key: "2", metaKey: true });
    fireEvent.keyDown(document.body, { key: "4", metaKey: true });
    fireEvent.keyDown(document.body, { key: "5", metaKey: true });
    fireEvent.keyDown(document.body, { key: "6", metaKey: true });

    expect(active.goGrid).toHaveBeenCalledTimes(1);
    expect(active.goGrid).toHaveBeenCalledWith(1);
    expect(active.goList).toHaveBeenCalledOnce();
    expect(active.goSessions).toHaveBeenCalledOnce();
    expect(active.goKanban).toHaveBeenCalledOnce();
  });

  it("leaves Command-7 unassigned, and moves Chat into Kanban's digit while Kanban is hidden", () => {
    const active = handlers({ showKanban: false });
    render(<Probe handlers={active} />);

    fireEvent.keyDown(document.body, { key: "7", metaKey: true });
    fireEvent.keyDown(document.body, { key: "5", metaKey: true });
    expect(active.goChat).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "4", metaKey: true });
    expect(active.goChat).toHaveBeenCalledOnce();
    expect(active.goKanban).not.toHaveBeenCalled();
  });

  it("puts Chat after Kanban while Kanban is shown", () => {
    const active = handlers();
    render(<Probe handlers={active} />);

    fireEvent.keyDown(document.body, { key: "5", metaKey: true });
    expect(active.goChat).toHaveBeenCalledOnce();
    expect(active.goKanban).not.toHaveBeenCalled();
  });

  it.each(["input", "textarea", "editable"])("does not open chat from %s", (label) => {
    const active = handlers();
    render(<Probe handlers={active} controls />);
    fireEvent.keyDown(screen.getByLabelText(label), { key: "5", metaKey: true });
    expect(active.goChat).not.toHaveBeenCalled();
  });
});
