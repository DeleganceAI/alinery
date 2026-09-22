import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlaybookSourceEditor } from "./PlaybookSourceEditor";

beforeEach(() => {
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

it("changes source without rewriting untouched mixed line endings or literal prompt text", () => {
  const onChange = vi.fn();
  const source = '+++\r\nkey = "review"\r\n+++\n\n<!-- alinery:step inspect -->\r\nUse \\{{TASK_NAME}} exactly.\r\n';
  render(<PlaybookSourceEditor value={source} onChange={onChange} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Playbook source" }), { target: { value: source.replace(/\r\n/g, "\n").replace("exactly.", "unchanged.\nNew line.") } });
  expect(onChange).toHaveBeenLastCalledWith(source.replace("exactly.", "unchanged.\r\nNew line."));
});

it("keeps duplicate blank lines and trailing newline when deleting across CRLF lines", () => {
  const onChange = vi.fn();
  render(<PlaybookSourceEditor value={"first\r\n\r\nremove\r\nlast\r\n"} onChange={onChange} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Playbook source" }), { target: { value: "first\n\nlast\n" } });
  expect(onChange).toHaveBeenLastCalledWith("first\r\n\r\nlast\r\n");
});
