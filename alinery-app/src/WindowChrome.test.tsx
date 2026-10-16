import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mockIpc } from "./test/mockIpc";
import { WindowControls } from "./WindowChrome";

const win = vi.hoisted(() => ({
  close: vi.fn(),
  minimize: vi.fn(),
  setFullscreen: vi.fn(),
  isFullscreen: vi.fn(async () => false),
  onResized: vi.fn(async () => () => {}),
}));

vi.mock("./ipc", () => mockIpc({ getCurrentWindow: (() => win) as never }));

afterEach(cleanup);

it("orders the window controls close, minimize, full screen like macOS and keeps each action", () => {
  render(<WindowControls />);
  const buttons = screen.getAllByRole("button");
  expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Close window", "Minimize", "Enter full screen"]);

  fireEvent.click(buttons[0]);
  fireEvent.click(buttons[1]);
  fireEvent.click(buttons[2]);
  expect(win.close).toHaveBeenCalledOnce();
  expect(win.minimize).toHaveBeenCalledOnce();
  expect(win.setFullscreen).toHaveBeenCalledWith(true);
});
