import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionNoticeRow } from "./sessionAttention";
import { mockIpc } from "./test/mockIpc";
import type { NotificationPrefs, SessionListItem } from "./types";
import { dockBadgeCount, useDockBadgeCount } from "./useDockBadgeCount";

const mocks = vi.hoisted(() => ({ setDockBadgeCount: vi.fn() }));
vi.mock("./ipc", () => mockIpc({ setDockBadgeCount: mocks.setDockBadgeCount }));

const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  enabled: true,
  sound: true,
  bounce: true,
  banner: true,
  dock_badge: true,
  dock_badge_input_waits: true,
  dock_badge_approval_waits: true,
  dock_badge_failures: true,
  dock_badge_completions: true,
  ...over,
});

const row = (notice: SessionNoticeRow["notice"], id: string = notice): SessionNoticeRow => ({
  notice,
  item: {
    id,
    worktree: "/wt",
    created: 10,
    archived: false,
    phase: "implementation",
    harness: "omp",
    model: "",
    playbook: "superdevelop",
    generic: false,
    harness_resume_token: "",
    semantic: {},
    task_slug: "task",
    task_name: "Task",
    task_worktree: "/wt",
    repo_path: "/repo",
    playbook_title: "SuperDevelop",
    step_title: "Implementation",
    is_playbook_step: true,
  } satisfies SessionListItem,
});
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function flushPublisher() {
  await act(async () => vi.advanceTimersByTimeAsync(0));
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.setDockBadgeCount.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("dockBadgeCount", () => {
  it("applies only category and master switches", () => {
    const rows = [row("waiting_for_input"), row("waiting_for_approval"), row("failure"), row("unread_completion")];
    expect(dockBadgeCount(rows, prefs())).toBe(4);
    expect(dockBadgeCount(rows, prefs({ dock_badge_input_waits: false }))).toBe(3);
    expect(dockBadgeCount(rows, prefs({ dock_badge_approval_waits: false }))).toBe(3);
    expect(dockBadgeCount(rows, prefs({ dock_badge_failures: false }))).toBe(3);
    expect(dockBadgeCount(rows, prefs({ dock_badge_completions: false }))).toBe(3);
    expect(dockBadgeCount(rows, prefs({ enabled: false }))).toBe(0);
    expect(dockBadgeCount(rows, prefs({ dock_badge: false }))).toBe(0);
    expect(dockBadgeCount(rows, prefs({ sound: false, bounce: false, banner: false }))).toBe(4);
  });

  it("does not cap counts", () => {
    expect(
      dockBadgeCount(
        Array.from({ length: 100 }, (_, index) => row("failure", String(index))),
        prefs(),
      ),
    ).toBe(100);
  });
});

describe("useDockBadgeCount", () => {
  it("removes stale state before load and publishes only changed loaded counts", async () => {
    const rows = [row("failure", "a"), row("failure", "b")];
    const { rerender } = renderHook(({ loaded, currentRows }) => useDockBadgeCount(currentRows, prefs(), loaded), {
      initialProps: { loaded: false, currentRows: rows },
    });
    await flushPublisher();
    expect(mocks.setDockBadgeCount.mock.calls).toEqual([[0]]);

    rerender({ loaded: true, currentRows: rows });
    await flushPublisher();
    expect(mocks.setDockBadgeCount.mock.calls).toEqual([[0], [2]]);
    rerender({ loaded: true, currentRows: [...rows] });
    await flushPublisher();
    expect(mocks.setDockBadgeCount).toHaveBeenCalledTimes(2);
    rerender({ loaded: true, currentRows: [] });
    await flushPublisher();
    expect(mocks.setDockBadgeCount).toHaveBeenLastCalledWith(0);
  });

  it("retries a failed initial stale-badge removal", async () => {
    mocks.setDockBadgeCount.mockRejectedValueOnce(new Error("remove failed")).mockResolvedValue(undefined);
    renderHook(() => useDockBadgeCount([], prefs(), false));
    await flushPublisher();
    expect(mocks.setDockBadgeCount.mock.calls).toEqual([[0]]);
    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    expect(mocks.setDockBadgeCount).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.setDockBadgeCount.mock.calls).toEqual([[0], [0]]);
  });

  it("retries a failed positive count without a count change", async () => {
    mocks.setDockBadgeCount.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("publish failed")).mockResolvedValue(undefined);
    renderHook(() => useDockBadgeCount([row("failure")], prefs(), true));
    await flushPublisher();
    expect(mocks.setDockBadgeCount.mock.calls).toEqual([[0], [1]]);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.setDockBadgeCount.mock.calls).toEqual([[0], [1], [1]]);
  });

  it("advances delivery state only after a successful call", async () => {
    mocks.setDockBadgeCount.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("publish failed")).mockResolvedValue(undefined);
    const { rerender } = renderHook(({ currentRows }) => useDockBadgeCount(currentRows, prefs(), true), {
      initialProps: { currentRows: [row("failure")] },
    });
    await flushPublisher();
    rerender({ currentRows: [row("failure", "same-count")] });
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.setDockBadgeCount.mock.calls).toEqual([[0], [1], [1]]);
    rerender({ currentRows: [row("failure", "still-same")] });
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(mocks.setDockBadgeCount).toHaveBeenCalledTimes(3);
  });

  it("coalesces desired-count changes during one request to the newest count", async () => {
    const removal = deferred<void>();
    mocks.setDockBadgeCount.mockReturnValueOnce(removal.promise).mockResolvedValue(undefined);
    const { rerender } = renderHook(({ currentRows }) => useDockBadgeCount(currentRows, prefs(), true), {
      initialProps: { currentRows: [row("failure", "a")] },
    });
    rerender({ currentRows: [row("failure", "a"), row("failure", "b")] });
    rerender({ currentRows: [row("failure", "a"), row("failure", "b"), row("failure", "c")] });
    expect(mocks.setDockBadgeCount.mock.calls).toEqual([[0]]);
    removal.resolve();
    await flushPublisher();
    expect(mocks.setDockBadgeCount.mock.calls).toEqual([[0], [3]]);
  });

  it("never overlaps native badge sends", async () => {
    const pending: Deferred<void>[] = [];
    let active = 0;
    let maximumActive = 0;
    mocks.setDockBadgeCount.mockImplementation(() => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const request = deferred<void>();
      pending.push(request);
      return request.promise.finally(() => {
        active -= 1;
      });
    });
    const { rerender } = renderHook(({ currentRows }) => useDockBadgeCount(currentRows, prefs(), true), {
      initialProps: { currentRows: [row("failure", "a")] },
    });
    rerender({ currentRows: [row("failure", "a"), row("failure", "b")] });
    rerender({ currentRows: [row("failure", "a"), row("failure", "b"), row("failure", "c")] });
    expect(pending).toHaveLength(1);
    pending[0].resolve();
    await flushPublisher();
    expect(pending).toHaveLength(2);
    pending[1].resolve();
    await flushPublisher();
    expect(maximumActive).toBe(1);
  });

  it("does not duplicate a successfully delivered count", async () => {
    const { rerender } = renderHook(({ currentRows }) => useDockBadgeCount(currentRows, prefs(), true), {
      initialProps: { currentRows: [row("failure")] },
    });
    await flushPublisher();
    expect(mocks.setDockBadgeCount.mock.calls).toEqual([[0], [1]]);
    rerender({ currentRows: [row("failure", "same-count")] });
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(mocks.setDockBadgeCount).toHaveBeenCalledTimes(2);
  });

  it("clears a pending retry timer on unmount", async () => {
    mocks.setDockBadgeCount.mockRejectedValueOnce(new Error("remove failed")).mockResolvedValue(undefined);
    const { unmount } = renderHook(() => useDockBadgeCount([], prefs(), false));
    await flushPublisher();
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.setDockBadgeCount.mock.calls).toEqual([[0]]);
  });

  it("reacts to preferences without a snapshot refresh and sends counts above 99", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => row("failure", String(index)));
    const { rerender } = renderHook(({ currentPrefs }) => useDockBadgeCount(rows, currentPrefs, true), {
      initialProps: { currentPrefs: prefs() },
    });
    await flushPublisher();
    expect(mocks.setDockBadgeCount).toHaveBeenLastCalledWith(100);
    rerender({ currentPrefs: prefs({ dock_badge_failures: false }) });
    await flushPublisher();
    expect(mocks.setDockBadgeCount).toHaveBeenLastCalledWith(0);
    rerender({ currentPrefs: prefs({ dock_badge_failures: false, sound: false }) });
    await flushPublisher();
    expect(mocks.setDockBadgeCount).toHaveBeenCalledTimes(3);
  });
});
