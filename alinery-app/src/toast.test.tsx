import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadingToast, Toast, toast } from "./toast";

// The tone contract is behavioural, not visual: confirmations may vanish on a
// timer, errors must not — they hold detail the user may need to read or copy.
// Toasts portal to document.body, so queries go there — not the RTL container.

const entry = () => document.querySelector(".toast") as HTMLElement;
const entries = () => [...document.querySelectorAll(".toast")] as HTMLElement[];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Toast tones", () => {
  it("auto-dismisses success confirmations", () => {
    render(<Toast />);
    act(() => toast("Task created", "success"));
    expect(entry().className).toContain("on");
    act(() => vi.advanceTimersByTime(4100));
    expect(entry().className).not.toContain("on");
  });

  it("keeps errors visible until dismissed", () => {
    render(<Toast />);
    act(() => toast("Session not started: spawn failed", "error"));
    act(() => vi.advanceTimersByTime(60000));
    expect(entry().className).toContain("on");
    expect(entry().textContent).toContain("Session not started: spawn failed");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(entry().className).not.toContain("on");
  });

  it("clears a short confirmation well before the standard deadline", () => {
    render(<Toast />);
    act(() => toast("Appearance saved", "success", "short"));
    act(() => vi.advanceTimersByTime(1900));
    expect(entry().className).not.toContain("on");
  });

  it("defaults to the info tone for bare calls", () => {
    render(<Toast />);
    act(() => toast("Syncing…"));
    expect(entry().className).toContain("info");
    act(() => vi.advanceTimersByTime(4100));
    expect(entry().className).not.toContain("on");
  });
});

describe("Toast loading tone", () => {
  it("holds a loading toast until its caller resolves it", () => {
    render(<Toast />);
    act(() => toast.loading("Creating New Task…"));
    expect(entry().className).toContain("loading");
    expect(entry().textContent).toContain("Creating New Task…");
    expect(entry().style.opacity).toBe("1");
    act(() => vi.advanceTimersByTime(60000));
    expect(entry().className).toContain("on");
  });

  it("resolves the loading entry in place instead of stacking the result beside it", () => {
    render(<Toast />);
    let loading: LoadingToast;
    act(() => {
      loading = toast.loading("Creating New Task…");
    });
    act(() => loading.success("Task created"));
    expect(entries()).toHaveLength(1);
    expect(entries()[0].className).toContain("success");
    expect(entries()[0].textContent).toContain("Task created");
    act(() => vi.advanceTimersByTime(4100));
    expect(entries()[0].className).not.toContain("on");
  });

  it("keeps a failed mutation's message up until it is dismissed", () => {
    render(<Toast />);
    let loading: LoadingToast;
    act(() => {
      loading = toast.loading("Creating New Task…");
    });
    act(() => loading.error("Couldn't create the task: worktree add failed"));
    expect(entry().className).toContain("error");
    expect(entry().textContent).toContain("Couldn't create the task: worktree add failed");
    act(() => vi.advanceTimersByTime(60000));
    expect(entry().className).toContain("on");
  });

  it("still reports the result when the user dismissed the loader", () => {
    render(<Toast />);
    let loading: LoadingToast;
    act(() => {
      loading = toast.loading("Duplicating Task…");
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    act(() => vi.advanceTimersByTime(300));
    expect(entries()).toHaveLength(0);
    act(() => loading.success("TASK DUPLICATED"));
    expect(entries()).toHaveLength(1);
    expect(entries()[0].textContent).toContain("TASK DUPLICATED");
  });
});

describe("Toast stacking", () => {
  it("refreshes a repeated message in place instead of stacking copies", () => {
    render(<Toast />);
    act(() => toast("Appearance saved", "success"));
    act(() => vi.advanceTimersByTime(3000));
    act(() => toast("Appearance saved", "success"));
    act(() => toast("Appearance saved", "success"));
    expect(entries()).toHaveLength(1);
    // The repeat restarted the countdown, so the original 4s deadline passes silently.
    act(() => vi.advanceTimersByTime(1500));
    expect(entries()[0].className).toContain("on");
    act(() => vi.advanceTimersByTime(2600));
    expect(entries()[0].className).not.toContain("on");
  });

  it("still stacks distinct messages", () => {
    render(<Toast />);
    act(() => toast("Appearance saved", "success"));
    act(() => toast("Settings saved", "success"));
    expect(entries()).toHaveLength(2);
  });

  it("brings a repeated overflowed toast back into view as the newest", () => {
    render(<Toast />);
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
    render(<Toast />);
    act(() => toast("first"));
    act(() => toast("second"));
    act(() => toast("third"));
    const stacked = entries();
    expect(stacked).toHaveLength(3);
    const z = stacked.map((el) => Number(el.style.zIndex));
    // DOM order is oldest-first; the newest (last) must have the highest z-index.
    expect(z[2]).toBeGreaterThan(z[1]);
    expect(z[1]).toBeGreaterThan(z[0]);
  });
});

describe("Toast live region", () => {
  it("announces through a live region that exists before any toast fires", () => {
    render(<Toast />);
    const viewport = screen.getByRole("status");
    expect(viewport.className).toContain("toast-viewport");
    expect(viewport.getAttribute("aria-live")).toBe("polite");
    expect(entries()).toHaveLength(0);
    act(() => toast("Task created", "success"));
    // The entry lands inside the pre-existing region and carries no competing role.
    expect(viewport.querySelector(".toast")).not.toBeNull();
    expect(viewport.querySelector(".toast")?.getAttribute("role")).toBeNull();
  });
});

describe("Toast busy slot", () => {
  it("renders the create loader from the shared slot without toast.loading()", () => {
    render(<Toast busy="create" />);
    expect(entry().className).toContain("loading");
    expect(entry().textContent).toContain("Creating New Task…");
  });

  it("renders the duplicate loader from the shared slot", () => {
    render(<Toast busy="duplicate" />);
    expect(entry().textContent).toContain("Duplicating Task…");
  });

  it("renders the opening-create loader from the shared slot", () => {
    render(<Toast busy="open-create" />);
    expect(entry().textContent).toContain("Opening New Task…");
  });
});
