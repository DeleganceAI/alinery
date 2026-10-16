import { cleanup, render, screen } from "@testing-library/react";
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

it("orders the window controls close, minimize, full screen like macOS", () => {
  render(<WindowControls />);
  const buttons = screen.getAllByRole("button");
  expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Close window", "Minimize", "Enter full screen"]);
});
