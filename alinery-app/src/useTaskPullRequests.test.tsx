import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "./test/mockIpc";
import type { PullRequestSnapshot, TaskActivityRef } from "./types";
import { useTaskPullRequests } from "./useTaskPullRequests";

const listTaskPullRequests = vi.hoisted(() => vi.fn());
vi.mock("./ipc", () => mockIpc({ listTaskPullRequests }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

let sequence = 0;
let repoPath: string;
let visibility: DocumentVisibilityState;
const pr = { pr: { number: 42, url: "https://github.com/acme/app/pull/42", state: "open" }, error: null } satisfies PullRequestSnapshot;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-17T00:00:00Z"));
  repoPath = `/repo-${++sequence}`;
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  listTaskPullRequests.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useTaskPullRequests", () => {
  it("returns immediately while a deferred batch discovers PRs and distinguishes no PR from loading", async () => {
    const pending = deferred<Record<string, PullRequestSnapshot>>();
    listTaskPullRequests.mockReturnValue(pending.promise);
    const refs = [
      { repoPath, taskSlug: "one" },
      { repoPath, taskSlug: "two" },
    ];
    const { result } = renderHook(() => useTaskPullRequests(refs));
    expect(result.current).toEqual({});
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(listTaskPullRequests).toHaveBeenCalledExactlyOnceWith(refs);
    expect(result.current).toEqual({});

    const snapshots = { [`${repoPath}:one`]: pr, [`${repoPath}:two`]: { pr: null, error: null } };
    pending.resolve(snapshots);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current).toEqual(snapshots);
  });

  it("shares pending work across consumers and reuses cached results until 60 seconds after completion", async () => {
    const pending = deferred<Record<string, PullRequestSnapshot>>();
    const refs = [{ repoPath, taskSlug: "one" }];
    const key = `${repoPath}:one`;
    listTaskPullRequests.mockReturnValueOnce(pending.promise).mockResolvedValue({ [key]: { ...pr, pr: { ...pr.pr, state: "merged" } } });
    const first = renderHook(() => useTaskPullRequests(refs));
    const second = renderHook(() => useTaskPullRequests(refs));
    await act(async () => vi.advanceTimersByTimeAsync(90_000));
    expect(listTaskPullRequests).toHaveBeenCalledTimes(1);
    pending.resolve({ [key]: pr });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(first.result.current[key]).toEqual(pr);
    expect(second.result.current[key]).toEqual(pr);
    first.unmount();
    second.unmount();

    await act(async () => vi.advanceTimersByTimeAsync(59_999));
    const remount = renderHook(() => useTaskPullRequests(refs));
    expect(remount.result.current[key]).toEqual(pr);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(listTaskPullRequests).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(listTaskPullRequests).toHaveBeenCalledTimes(2);
    expect(remount.result.current[key].pr?.state).toBe("merged");
  });

  it("batches only missing tasks when another view already has overlapping discovery in flight", async () => {
    const pending = deferred<Record<string, PullRequestSnapshot>>();
    const one = { repoPath, taskSlug: "one" };
    const two = { repoPath, taskSlug: "two" };
    listTaskPullRequests.mockReturnValueOnce(pending.promise).mockResolvedValue({ [`${repoPath}:two`]: { pr: null, error: null } });
    renderHook(() => useTaskPullRequests([one]));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const board = renderHook(() => useTaskPullRequests([one, two, two]));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(listTaskPullRequests.mock.calls.map(([refs]) => refs)).toEqual([[one], [two]]);
    expect(board.result.current[`${repoPath}:two`]).toEqual({ pr: null, error: null });
    pending.resolve({ [`${repoPath}:one`]: pr });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(board.result.current[`${repoPath}:one`]).toEqual(pr);
  });

  it("isolates late responses after switching repositories with the same task slug", async () => {
    const old = deferred<Record<string, PullRequestSnapshot>>();
    const next = deferred<Record<string, PullRequestSnapshot>>();
    listTaskPullRequests.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const initial: TaskActivityRef[] = [{ repoPath, taskSlug: "same" }];
    const { result, rerender } = renderHook(({ tasks }) => useTaskPullRequests(tasks), { initialProps: { tasks: initial } });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const nextRepo = `${repoPath}-next`;
    rerender({ tasks: [{ repoPath: nextRepo, taskSlug: "same" }] });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    old.resolve({ [`${repoPath}:same`]: pr });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current).toEqual({});
    next.resolve({ [`${nextRepo}:same`]: { pr: null, error: null } });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current).toEqual({ [`${nextRepo}:same`]: { pr: null, error: null } });
  });

  it("retains a known PR on transport and per-task refresh errors but clears it on a successful no-PR lookup", async () => {
    const refs = [{ repoPath, taskSlug: "one" }];
    const key = `${repoPath}:one`;
    listTaskPullRequests
      .mockResolvedValueOnce({ [key]: pr })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ [key]: { pr: null, error: "GitHub authentication required" } })
      .mockResolvedValue({ [key]: { pr: null, error: null } });
    const { result } = renderHook(() => useTaskPullRequests(refs));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(result.current[key]).toEqual({ pr: pr.pr, error: "offline" });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(result.current[key]).toEqual({ pr: pr.pr, error: "GitHub authentication required" });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(result.current[key]).toEqual({ pr: null, error: null });
  });

  it("pauses hidden polling, refreshes expired data on visibility, and stops polling after unmount", async () => {
    visibility = "hidden";
    const key = `${repoPath}:one`;
    listTaskPullRequests.mockResolvedValue({ [key]: pr });
    const { result, unmount } = renderHook(() => useTaskPullRequests([{ repoPath, taskSlug: "one" }]));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(listTaskPullRequests).not.toHaveBeenCalled();
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current[key]).toEqual(pr);
    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(listTaskPullRequests).toHaveBeenCalledTimes(1);
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(listTaskPullRequests).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(listTaskPullRequests).toHaveBeenCalledTimes(2);
  });
});
