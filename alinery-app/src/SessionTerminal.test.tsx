import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, type Mock, vi } from "vitest";
import { SessionTerminal, type SessionTerminalIo } from "./SessionTerminal";

const terminals = vi.hoisted(() => [] as { input: (data: string) => void; write: Mock; writeln: Mock }[]);
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    input = (_data: string) => {};
    write = vi.fn();
    writeln = vi.fn();
    constructor() {
      terminals.push(this);
    }
    loadAddon() {}
    open() {}
    resize() {}
    refresh() {}
    dispose() {}
    onData(callback: (data: string) => void) {
      this.input = callback;
      return { dispose() {} };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
    fit() {}
  },
}));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("./terminalRenderer", () => ({ attachGpuRenderer() {} }));
vi.mock("./ipc", () => ({ nextAttachId: () => 1, listen: async () => () => {}, Channel: class {}, readSessionHistory: async () => new ArrayBuffer(0) }));

beforeEach(() => {
  terminals.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("unknown_chunks_remain_ordered_and_recoverable", async () => {
  let rejectFirst!: (reason: Error) => void;
  let rejectSecond!: (reason: Error) => void;
  const first = new Promise<void>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const second = new Promise<void>((_resolve, reject) => {
    rejectSecond = reject;
  });
  const write = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second).mockResolvedValue({ status: "written" });
  const io: SessionTerminalIo = {
    open: vi.fn().mockResolvedValue(undefined),
    write,
    resize: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
    status: vi.fn(),
  };
  const props = {
    sessionId: "raw-recovery",
    cwd: "/repo",
    taskSlug: "task",
    phase: "build",
    harness: "no-harness",
    model: "",
    intent: "attach" as const,
    terminalFontSize: 14,
    io,
  };
  const copy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
  const view = render(<SessionTerminal {...props} />);
  const original = ["é\u001b[31m\r", "中\u0003\n"];
  act(() => {
    terminals[0].input(original[0]);
    terminals[0].input(original[1]);
  });
  view.unmount();
  await act(async () => {
    rejectSecond(new Error("partial write"));
  });
  render(<SessionTerminal {...props} />);
  await act(async () => {
    rejectFirst(new Error("connection lost"));
  });
  expect(screen.getByText(/unknown.*connection lost/i)).toBeTruthy();
  expect(screen.getByText(/unknown.*partial write/i)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy original input" }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(original.join("")));
  expect(write).toHaveBeenCalledTimes(2);
  for (const terminal of terminals) {
    expect(terminal.write).not.toHaveBeenCalled();
    expect(terminal.writeln).not.toHaveBeenCalled();
  }
  act(() => terminals[1].input("delivered"));
  await waitFor(() => expect(write).toHaveBeenCalledTimes(3));
  fireEvent.click(screen.getByRole("button", { name: /Copy original input|Copied original input/ }));
  expect(copy).toHaveBeenLastCalledWith(original.join(""));
});

it("retains typed refusals and unknown writes in original order across teardown", async () => {
  let finishFirst!: (value: { status: "not_sent"; reason: string }) => void;
  const write = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    )
    .mockResolvedValueOnce({ status: "unknown", reason: "partial write" })
    .mockResolvedValue({ status: "written" });
  const io: SessionTerminalIo = {
    open: vi.fn().mockResolvedValue(undefined),
    write,
    resize: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
    status: vi.fn(),
  };
  const props = {
    sessionId: "typed-raw-recovery",
    cwd: "/repo",
    taskSlug: "task",
    phase: "build",
    harness: "no-harness",
    model: "",
    intent: "attach" as const,
    terminalFontSize: 14,
    io,
  };
  const copy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
  const view = render(<SessionTerminal {...props} />);
  const originals = ["é\u001b[31m\r", "中\u0003\n"];
  await act(async () => {
    terminals[0].input(originals[0]);
    terminals[0].input(originals[1]);
  });
  view.unmount();
  await act(async () => finishFirst({ status: "not_sent", reason: "Continuation requested" }));
  const reattached = render(<SessionTerminal {...props} />);
  expect(screen.getByText(/not sent.*Continuation requested/i)).toBeTruthy();
  expect(screen.getByText(/unknown.*partial write/i)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy original input" }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(originals.join("")));
  expect(write).toHaveBeenCalledTimes(2);
  expect(write.mock.calls[0][1]).toEqual(expect.any(String));
  expect(write.mock.calls[1][1]).not.toBe(write.mock.calls[0][1]);
  await act(async () => terminals[1].input("written"));
  expect(screen.queryByText('"written"')).toBeNull();
  for (const terminal of terminals) {
    expect(terminal.write).not.toHaveBeenCalled();
    expect(terminal.writeln).not.toHaveBeenCalled();
  }
  reattached.unmount();
  render(<SessionTerminal {...props} readOnly />);
  expect(screen.getByText(/unknown.*partial write/i)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy original input" }));
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith(originals.join("")));
  expect(write).toHaveBeenCalledTimes(3);
});
