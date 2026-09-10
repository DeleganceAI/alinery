import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toast, toast } from "./toast";

// The tone contract is behavioural, not visual: confirmations may vanish on a
// timer, errors must not — they hold detail the user may need to read or copy.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Toast tones", () => {
  it("auto-dismisses success confirmations", () => {
    const { container } = render(<Toast />);
    const entry = () => container.querySelector(".toast") as HTMLElement;
    act(() => toast("Task created", "success"));
    expect(entry().className).toContain("on");
    act(() => vi.advanceTimersByTime(4100));
    expect(entry().className).not.toContain("on");
  });

  it("keeps errors visible until dismissed", () => {
    const { container } = render(<Toast />);
    const entry = () => container.querySelector(".toast") as HTMLElement;
    act(() => toast("Session not started: spawn failed", "error"));
    act(() => vi.advanceTimersByTime(60000));
    expect(entry().className).toContain("on");
    expect(entry().textContent).toContain("Session not started: spawn failed");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(entry().className).not.toContain("on");
  });

  it("clears a short confirmation well before the standard deadline", () => {
    const { container } = render(<Toast />);
    const entry = () => container.querySelector(".toast") as HTMLElement;
    act(() => toast("Appearance saved", "success", "short"));
    act(() => vi.advanceTimersByTime(1900));
    expect(entry().className).not.toContain("on");
  });

  it("defaults to the info tone for bare calls", () => {
    const { container } = render(<Toast />);
    const entry = () => container.querySelector(".toast") as HTMLElement;
    act(() => toast("Syncing…"));
    expect(entry().className).toContain("info");
    act(() => vi.advanceTimersByTime(4100));
    expect(entry().className).not.toContain("on");
  });
});

describe("Toast stacking", () => {
  it("refreshes a repeated message in place instead of stacking copies", () => {
    const { container } = render(<Toast />);
    const entries = () => container.querySelectorAll(".toast");
    act(() => toast("Appearance saved", "success"));
    act(() => vi.advanceTimersByTime(3000));
    act(() => toast("Appearance saved", "success"));
    act(() => toast("Appearance saved", "success"));
    expect(entries()).toHaveLength(1);
    // The repeat restarted the countdown, so the original 4s deadline passes silently.
    act(() => vi.advanceTimersByTime(1500));
    expect((entries()[0] as HTMLElement).className).toContain("on");
    act(() => vi.advanceTimersByTime(2600));
    expect((entries()[0] as HTMLElement).className).not.toContain("on");
  });

  it("still stacks distinct messages", () => {
    const { container } = render(<Toast />);
    act(() => toast("Appearance saved", "success"));
    act(() => toast("Settings saved", "success"));
    expect(container.querySelectorAll(".toast")).toHaveLength(2);
  });

  it("brings a repeated overflowed toast back into view as the newest", () => {
    const { container } = render(<Toast />);
    const entries = () => [...container.querySelectorAll(".toast")] as HTMLElement[];
    act(() => toast("first"));
    act(() => toast("second"));
    act(() => toast("third"));
    act(() => toast("fourth"));
    // Past VISIBLE_COUNT, the oldest (first) starts inert.
    expect(entries()[0].hasAttribute("inert")).toBe(true);
    act(() => toast("first"));
    const after = entries();
    expect(after).toHaveLength(4);
    const newest = after[after.length - 1];
    expect(newest.textContent).toContain("first");
    expect(newest.hasAttribute("inert")).toBe(false);
  });

  it("paints the newest toast above older ones", () => {
    const { container } = render(<Toast />);
    act(() => toast("first"));
    act(() => toast("second"));
    act(() => toast("third"));
    const entries = [...container.querySelectorAll(".toast")] as HTMLElement[];
    expect(entries).toHaveLength(3);
    const z = entries.map((el) => Number(el.style.zIndex));
    // DOM order is oldest-first; the newest (last) must have the highest z-index.
    expect(z[2]).toBeGreaterThan(z[1]);
    expect(z[1]).toBeGreaterThan(z[0]);
  });
});

describe("Toast live region", () => {
  it("announces through a live region that exists before any toast fires", () => {
    const { container } = render(<Toast />);
    const viewport = screen.getByRole("status");
    expect(viewport.className).toContain("toast-viewport");
    expect(viewport.getAttribute("aria-live")).toBe("polite");
    expect(container.querySelectorAll(".toast")).toHaveLength(0);
    act(() => toast("Task created", "success"));
    // The entry lands inside the pre-existing region and carries no competing role.
    expect(viewport.querySelector(".toast")).not.toBeNull();
    expect(viewport.querySelector(".toast")?.getAttribute("role")).toBeNull();
  });
});
