import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { CaptureSidebar, QuickCapture } from "./CaptureSidebar";
import { appendCaptureText, type Capture, captureDropTargetAt, dropCapture, useCaptureDrop } from "./captures";

vi.mock("./ipc", async () => (await import("./test/mockIpc")).mockIpc());

afterEach(cleanup);

function Target({ onDrop }: { onDrop: (capture: Capture) => void }) {
  return <div data-testid="target" ref={useCaptureDrop(onDrop)} />;
}

test("Enter files what was typed, and dragging the row onto a target copies it there", async () => {
  const onDrop = vi.fn();
  render(
    <>
      <Target onDrop={onDrop} />
      <CaptureSidebar open onClose={() => {}} />
    </>,
  );
  const box = screen.getByLabelText("Capture");
  expect(document.activeElement).toBe(box);
  fireEvent.change(box, { target: { value: "call the plumber" } });
  await act(async () => {
    fireEvent.keyDown(box, { key: "Enter" });
  });
  expect((box as HTMLTextAreaElement).value).toBe("");
  const row = (await screen.findByText("call the plumber")).closest("li") as HTMLElement;

  // jsdom has no layout: every point is over the target.
  const target = screen.getByTestId("target");
  document.elementFromPoint = () => target;
  fireEvent.pointerDown(row, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 40, clientY: 40 });
  expect(target.hasAttribute("data-capture-over")).toBe(true);
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 40, clientY: 40 });

  expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ text: "call the plumber" }));
  expect(target.hasAttribute("data-capture-over")).toBe(false);
  // A drop is a copy: the capture is still in the inbox.
  expect(screen.getByText("call the plumber")).toBeTruthy();
});

test("a click on a capture copies it and drops nothing", async () => {
  const onDrop = vi.fn();
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(
    <>
      <Target onDrop={onDrop} />
      <CaptureSidebar open onClose={() => {}} />
    </>,
  );
  const row = screen.getByText("call the plumber").closest("li") as HTMLElement;
  fireEvent.pointerDown(row, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 0, clientY: 0 });
  expect(onDrop).not.toHaveBeenCalled();
  expect(writeText).toHaveBeenCalledWith("call the plumber");
  // The copy mark turns into the check.
  expect(await screen.findByLabelText("Copied")).toBeTruthy();
});

test("quick capture shows one field and no inbox, and closes once the capture is saved", async () => {
  const onClose = vi.fn();
  render(<QuickCapture onClose={onClose} />);
  expect(screen.queryByText("call the plumber")).toBeNull();
  const box = screen.getByLabelText("Capture");
  fireEvent.change(box, { target: { value: "renew passport" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  cleanup();
  render(<CaptureSidebar open onClose={() => {}} />);
  expect(screen.getByText("renew passport")).toBeTruthy();
});

test("captured text lands on its own line of a draft", () => {
  expect(appendCaptureText("", "a")).toBe("a");
  expect(appendCaptureText("draft\n", "a")).toBe("draft\na");
  expect(appendCaptureText("draft", "")).toBe("draft");
});

test("with the inbox open, a paste outside any text field is saved at once", async () => {
  render(<CaptureSidebar open onClose={() => {}} />);
  fireEvent.paste(document.body, { clipboardData: { items: [], files: [], getData: () => "copied line" } });
  expect(await screen.findByText("copied line")).toBeTruthy();
});

test("a screenshot pasted into the box saves itself as its own capture and leaves the typed text alone", async () => {
  render(<CaptureSidebar open onClose={() => {}} />);
  const box = screen.getByLabelText("Capture") as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "half a thought" } });
  const shot = new File(["x"], "shot.png", { type: "image/png" });
  fireEvent.paste(box, { clipboardData: { items: [], files: [shot], getData: () => "" } });
  expect(await screen.findByAltText("shot.png")).toBeTruthy();
  expect(box.value).toBe("half a thought");
});

test("a plain controlled textarea takes a dropped capture's text on its own line", () => {
  function Comment() {
    const [value, setValue] = useState("first");
    return <textarea aria-label="Comment" value={value} onChange={(event) => setValue(event.target.value)} />;
  }
  render(<Comment />);
  const field = screen.getByLabelText("Comment") as HTMLTextAreaElement;
  document.elementFromPoint = () => field;
  expect(captureDropTargetAt(0, 0)).toBe(field);
  act(() => dropCapture(field, { id: "1", at: 0, text: "second", images: [] }));
  expect(field.value).toBe("first\nsecond");
});
