import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_STATE_ART, resetEmptyStateArtPick } from "./emptyStateArt";
import { EmptyState } from "./shared";

vi.mock("./ipc");
vi.mock("./WindowChrome", () => ({ WindowControls: () => null, useWindowFullscreen: () => false, ResizeHandles: () => null }));

afterEach(() => {
  cleanup();
  resetEmptyStateArtPick();
  vi.restoreAllMocks();
});

describe("EmptyState art", () => {
  it("uses an explicit URL when art is a string", () => {
    const { container } = render(<EmptyState title="No tasks yet." art="/explicit.webp" />);
    const img = container.querySelector("img.empty-state-art");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("/explicit.webp");
    expect(img?.getAttribute("alt")).toBe("");
  });

  it("picks a catalog URL on mount when art is true", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { container } = render(<EmptyState title="No tasks yet." art />);
    const img = container.querySelector("img.empty-state-art");
    expect(img?.getAttribute("src")).toBe(EMPTY_STATE_ART[0]);
  });

  it("picks again on remount and avoids the previous plate", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const first = render(<EmptyState title="No tasks yet." art />);
    const firstSrc = first.container.querySelector("img.empty-state-art")?.getAttribute("src");
    expect(firstSrc).toBe(EMPTY_STATE_ART[0]);
    first.unmount();

    const second = render(<EmptyState title="No tasks yet." art />);
    const secondSrc = second.container.querySelector("img.empty-state-art")?.getAttribute("src");
    expect(secondSrc).toBeTruthy();
    expect(secondSrc).not.toBe(firstSrc);
    expect(EMPTY_STATE_ART).toContain(secondSrc);
  });

  it("renders no plate when art is omitted", () => {
    const { container } = render(<EmptyState title="No sessions yet." />);
    expect(container.querySelector("img.empty-state-art")).toBeNull();
  });

  it("fades the plate in once the image loads", () => {
    const { container } = render(<EmptyState title="No tasks yet." art="/explicit.webp" />);
    const img = container.querySelector("img.empty-state-art");
    expect(img?.classList.contains("on")).toBe(false);
    fireEvent.load(img as HTMLImageElement);
    expect(img?.classList.contains("on")).toBe(true);
  });

  it("drops the frame when the image fails, rather than holding an empty mat", () => {
    const { container } = render(<EmptyState title="No tasks yet." art="/missing.webp" />);
    fireEvent.error(container.querySelector("img.empty-state-art") as HTMLImageElement);
    expect(container.querySelector(".empty-state-art-frame")).toBeNull();
    expect(container.querySelector(".empty-state-title")?.textContent).toBe("No tasks yet.");
  });
});
