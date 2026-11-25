import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueuedPanelLine } from "./chatTranscript";
import { QueuedPanel } from "./QueuedPanel";

afterEach(cleanup);

const line = (over: Partial<QueuedPanelLine> = {}): QueuedPanelLine => ({
  id: "7",
  mode: "followUp",
  text: "Continue.",
  images: [],
  origin: "server",
  stale: false,
  ...over,
});

describe("QueuedPanel", () => {
  it("rests open and shows each line's text, image names, and a truthful marker, in the order given", () => {
    render(
      <QueuedPanel
        items={[line({ id: "1", text: "First", images: [{ name: "shot.png", mimeType: "image/png" }] }), line({ id: "2", mode: "steer", text: "Stop that", images: [] })]}
        onRemove={vi.fn()}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("First");
    expect(items[0]?.textContent).toContain("shot.png");
    expect(items[0]?.textContent).toContain("after this turn");
    expect(items[1]?.textContent).toContain("Stop that");
    expect(items[1]?.textContent).toContain("interrupts the running turn");
    expect(items[0]?.compareDocumentPosition(items[1] ?? items[0])).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByText("Queued · 2")).toBeDefined();
    expect(screen.getByRole("button", { name: "Hide" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("identifies an image-only line by its name, so the line is not blank", () => {
    render(<QueuedPanel items={[line({ text: "", images: [{ name: "diagram.png", mimeType: "image/png" }] })]} onRemove={vi.fn()} />);
    expect(screen.getByText("diagram.png")).toBeDefined();
    expect(screen.getByRole("button", { name: "Remove diagram.png" })).toBeDefined();
  });

  it("calls back with the line's id and no other", () => {
    const onRemove = vi.fn();
    render(<QueuedPanel items={[line({ id: "sub-9", text: "Later" })]} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Later" }));
    expect(onRemove).toHaveBeenCalledExactlyOnceWith("sub-9");
  });

  it("hides the lines when collapsed and keeps the count", () => {
    render(<QueuedPanel items={[line()]} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.getByText("Queued · 1")).toBeDefined();
    expect(screen.getByRole("button", { name: "Show" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("is absent when nothing is queued", () => {
    const { container } = render(<QueuedPanel items={[]} onRemove={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});
