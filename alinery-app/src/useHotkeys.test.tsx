import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmHost, confirmStopAndSwitch } from "./confirm";
import { TaskRunGraph } from "./TaskRunGraph";
import type * as IpcFixtures from "./test/mockIpc";
import type { SessionDisplayMeta } from "./types";
import { type Handlers, useHotkeys } from "./useHotkeys";

vi.mock("./ipc", async () => {
  const { mockIpc } = await vi.importActual<typeof IpcFixtures>("./test/mockIpc");
  return mockIpc();
});

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
  // One Grid view followed by Tasks, Sessions, and optional Chat.
  gridCount: 1,
  showChat: true,
  toggleSearch: vi.fn(),
  openCreate: vi.fn(),
  goList: vi.fn(),
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
  toggleQuickChat: vi.fn(),
  focusQuickChat: vi.fn(() => false),
  ...overrides,
});

function commandCallbacks(value: Handlers) {
  return [
    value.toggleSearch,
    value.openCreate,
    value.goList,
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
    value.toggleQuickChat,
    value.focusQuickChat,
  ];
}

describe("useHotkeys", () => {
  it("leaves Enter on native controls to the focused control while keeping board shortcuts", () => {
    const active = handlers();
    render(
      <>
        <Probe handlers={active} />
        <button type="button">
          <span>Sort by Name</span>
        </button>
        <a href="#task">Task link</a>
        <select aria-label="Sort order">
          <option>Name</option>
        </select>
        <details>
          <summary>Filters</summary>
        </details>
      </>,
    );
    for (const target of [
      screen.getByRole("button", { name: "Sort by Name" }),
      screen.getByText("Sort by Name"),
      screen.getByRole("link"),
      screen.getByRole("combobox"),
      screen.getByText("Filters"),
    ]) {
      target.focus();
      const event = createEvent.keyDown(target, { key: "Enter", cancelable: true });
      fireEvent(target, event);
      expect(event.defaultPrevented).toBe(false);
      expect(active.openSelected).not.toHaveBeenCalled();
    }

    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(active.openSelected).toHaveBeenCalledOnce();
    const sort = screen.getByRole("button", { name: "Sort by Name" });
    fireEvent.keyDown(sort, { key: "Enter", metaKey: true });
    expect(active.openSelected).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(sort, { key: "Escape" });
    expect(active.back).toHaveBeenCalledOnce();
  });

  it("leaves the run graph open when Escape returns keyboard pan focus", () => {
    const active = handlers({ board: null });
    const worker: SessionDisplayMeta = {
      id: "worker",
      name: "worker",
      worktree: "/work",
      created: 1,
      archived: false,
      phase: "worker",
      harness: "omp",
      model: "",
      playbook: "retained",
      generic: false,
      harness_resume_token: "",
    };
    render(
      <>
        <Probe handlers={active} />
        <TaskRunGraph sessions={[worker]} state={null} onOpenSession={vi.fn()} onOpenArtifact={vi.fn()} />
      </>,
    );
    const pan = screen.getByRole("button", { name: "Pan run graph" });
    const canvas = screen.getByRole("region", { name: "Run graph canvas" });
    fireEvent.click(pan);
    expect(document.activeElement).toBe(canvas);
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(document.activeElement).toBe(pan);
    expect(active.back).not.toHaveBeenCalled();
    fireEvent.keyDown(pan, { key: "Escape" });
    expect(active.back).toHaveBeenCalledOnce();
  });

  it("cancels Switch to Terminal with Escape without navigating back", async () => {
    const active = handlers({ board: null });
    render(
      <>
        <Probe handlers={active} />
        <ConfirmHost />
      </>,
    );
    let answer!: Promise<boolean>;
    act(() => {
      answer = confirmStopAndSwitch("pty");
    });
    const dialog = screen.getByRole("alertdialog", { name: "Switch to Terminal?" });
    const cancel = screen.getByText("Cancel", { selector: "button" });
    expect(document.activeElement).toBe(cancel);

    // jsdom does not perform Escape's native dialog-cancel default action.
    // Dispatch the key first, then the browser's cancel event separately.
    expect(fireEvent.keyDown(cancel, { key: "Escape" })).toBe(true);
    expect(active.back).not.toHaveBeenCalled();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await expect(answer).resolves.toBe(false);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(active.back).toHaveBeenCalledOnce();
  });

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
    ["4", "goChat"],
    ["8", "goNotifications"],
    ["9", "goSettings"],
    [",", "goSettings"],
  ] as const)("maps Command-%s to only %s", (key, handler) => {
    const active = handlers();
    render(<Probe handlers={active} />);

    fireEvent.keyDown(document.body, { key, metaKey: true });

    expect(active[handler]).toHaveBeenCalledOnce();
    for (const other of ["goChat", "goList", "goSessions", "goNotifications", "goSettings", "goGrid"] as const) {
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
    expect(active.goChat).toHaveBeenCalledOnce();
  });

  it("leaves Command-7 unassigned and puts Chat after Sessions", () => {
    const active = handlers();
    render(<Probe handlers={active} />);

    fireEvent.keyDown(document.body, { key: "7", metaKey: true });
    fireEvent.keyDown(document.body, { key: "5", metaKey: true });
    expect(active.goChat).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "4", metaKey: true });
    expect(active.goChat).toHaveBeenCalledOnce();
    expect(active.goSessions).not.toHaveBeenCalled();
  });

  it("leaves Chat's digit unused while Chat is off, with fixed Notifications and Settings shortcuts", () => {
    const active = handlers({ showChat: false, gridCount: 3 });
    render(<Probe handlers={active} />);
    fireEvent.keyDown(document.body, { key: "6", metaKey: true });
    expect(active.goChat).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "8", metaKey: true });
    fireEvent.keyDown(document.body, { key: "9", metaKey: true });
    expect(active.goNotifications).toHaveBeenCalledOnce();
    expect(active.goSettings).toHaveBeenCalledOnce();
  });

  it.each(["input", "textarea", "editable"])("toggles pinned chats from %s", (label) => {
    const active = handlers();
    render(<Probe handlers={active} controls />);
    const target = screen.getByLabelText(label);
    const event = createEvent.keyDown(target, { key: "/", code: "Slash", metaKey: true, cancelable: true });
    fireEvent(target, event);
    expect(event.defaultPrevented).toBe(true);
    expect(active.toggleQuickChat).toHaveBeenCalledOnce();
  });

  it.each(["input", "textarea", "editable"])("toggles pinned chats from Control-slash in %s", (label) => {
    const active = handlers();
    render(<Probe handlers={active} controls />);
    const target = screen.getByLabelText(label);
    const event = createEvent.keyDown(target, { key: "/", code: "Slash", ctrlKey: true, cancelable: true });
    fireEvent(target, event);
    expect(event.defaultPrevented).toBe(true);
    expect(active.toggleQuickChat).toHaveBeenCalledOnce();
  });

  it("does not toggle pinned chats from Shift-slash", () => {
    const active = handlers();
    render(<Probe handlers={active} />);
    const shifted = createEvent.keyDown(document.body, { key: "?", code: "Slash", metaKey: true, shiftKey: true, cancelable: true });
    fireEvent(document.body, shifted);
    const ctrlShifted = createEvent.keyDown(document.body, { key: "?", code: "Slash", ctrlKey: true, shiftKey: true, cancelable: true });
    fireEvent(document.body, ctrlShifted);
    expect(shifted.defaultPrevented).toBe(false);
    expect(ctrlShifted.defaultPrevented).toBe(false);
    expect(active.toggleQuickChat).not.toHaveBeenCalled();
  });

  it.each([
    ["meta", true],
    ["ctrl", false],
  ] as const)("focuses the pinned chat composer from %s+>", (_name, meta) => {
    const active = handlers({ focusQuickChat: vi.fn(() => true) });
    render(<Probe handlers={active} controls />);
    const target = screen.getByLabelText("textarea");
    const event = createEvent.keyDown(target, {
      key: ">",
      code: "Period",
      metaKey: meta,
      ctrlKey: !meta,
      shiftKey: true,
      cancelable: true,
    });
    fireEvent(target, event);
    expect(event.defaultPrevented).toBe(true);
    expect(active.focusQuickChat).toHaveBeenCalledOnce();
    expect(active.toggleQuickChat).not.toHaveBeenCalled();
  });

  it("accepts Shift+Period when the key event reports the unshifted character", () => {
    const active = handlers({ focusQuickChat: vi.fn(() => true) });
    render(<Probe handlers={active} />);
    const event = createEvent.keyDown(document.body, { key: ".", code: "Period", metaKey: true, shiftKey: true, cancelable: true });
    fireEvent(document.body, event);
    expect(event.defaultPrevented).toBe(true);
    expect(active.focusQuickChat).toHaveBeenCalledOnce();
  });

  it("leaves the key alone when the floater cannot take focus, and ignores Command-period", () => {
    const active = handlers();
    render(<Probe handlers={active} controls />);
    const target = screen.getByLabelText("textarea");
    const missed = createEvent.keyDown(target, { key: ">", code: "Period", ctrlKey: true, shiftKey: true, cancelable: true });
    fireEvent(target, missed);
    const plain = createEvent.keyDown(target, { key: ".", code: "Period", metaKey: true, cancelable: true });
    fireEvent(target, plain);
    expect(missed.defaultPrevented).toBe(false);
    expect(plain.defaultPrevented).toBe(false);
    expect(active.focusQuickChat).toHaveBeenCalledOnce();
  });

  it.each(["input", "textarea", "editable"])("does not open chat from %s", (label) => {
    const active = handlers();
    render(<Probe handlers={active} controls />);
    fireEvent.keyDown(screen.getByLabelText(label), { key: "5", metaKey: true });
    expect(active.goChat).not.toHaveBeenCalled();
  });
});
