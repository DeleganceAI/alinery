import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGestureDebounce } from "./debounce";

const DELAY_MS = 300;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createGestureDebounce", () => {
  it("coalesces three schedules inside one window into a single run", () => {
    const run = vi.fn();
    const d = createGestureDebounce({ delayMs: DELAY_MS, isBusy: () => false, run });
    d.schedule();
    d.schedule();
    d.schedule();
    vi.advanceTimersByTime(DELAY_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("restarts the quiet window on every schedule", () => {
    const run = vi.fn();
    const d = createGestureDebounce({ delayMs: DELAY_MS, isBusy: () => false, run });
    d.schedule();
    vi.advanceTimersByTime(DELAY_MS - 1);
    d.schedule();
    vi.advanceTimersByTime(DELAY_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not run while a gesture is in flight, however long it holds the window", () => {
    const run = vi.fn();
    const d = createGestureDebounce({ delayMs: DELAY_MS, isBusy: () => true, run });
    d.schedule();
    vi.advanceTimersByTime(DELAY_MS * 3);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs exactly once on the first quiet check after the gesture ends", () => {
    let busy = true;
    const run = vi.fn();
    const d = createGestureDebounce({ delayMs: DELAY_MS, isBusy: () => busy, run });
    d.schedule();
    vi.advanceTimersByTime(DELAY_MS * 3);
    expect(run).not.toHaveBeenCalled();
    busy = false;
    vi.advanceTimersByTime(DELAY_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels a pending run", () => {
    const run = vi.fn();
    const d = createGestureDebounce({ delayMs: DELAY_MS, isBusy: () => false, run });
    d.schedule();
    d.dispose();
    vi.advanceTimersByTime(DELAY_MS);
    expect(run).not.toHaveBeenCalled();
  });
});
