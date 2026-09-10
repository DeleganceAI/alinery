import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "./test/mockIpc";
import type { SessionListItem, SessionObservation } from "./types";
import { useSessionNoticeSnapshot } from "./useSessionNoticeSnapshot";

const mocks = vi.hoisted(() => ({
  listSessionItems: vi.fn(),
  sessionListStatuses: vi.fn(),
  clearSessionNotifications: vi.fn(),
}));

vi.mock("./ipc", () =>
  mockIpc({
    listSessionItems: mocks.listSessionItems,
    sessionListStatuses: mocks.sessionListStatuses,
    clearSessionNotifications: mocks.clearSessionNotifications,
  }),
);

const item = (id: string, over: Partial<SessionListItem> = {}): SessionListItem => ({
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
  repo_path: "/repo-a",
  playbook_title: "SuperDevelop",
  step_title: "Implementation",
  is_playbook_step: true,
  ...over,
});

const waiting = (correlation = "corr-1"): SessionObservation => ({
  lifecycle: { state: "live" },
  state: {
    process: { state: "alive" },
    agent: { state: "waiting_for_input", correlation_id: correlation },
    playbook: { state: "in_progress" },
    adapter: "omp",
    message_adapter: "unsupported",
  },
  checkpoint: {},
});

const key = (row: SessionListItem) => `${row.repo_path}:${row.task_slug}:${row.id}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.listSessionItems.mockReset().mockResolvedValue([]);
  mocks.sessionListStatuses.mockReset().mockResolvedValue({});
  mocks.clearSessionNotifications.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSessionNoticeSnapshot", () => {
  it("publishes one all-repository item and status batch atomically", async () => {
    const row = item("wait", { repo_path: "/repo-b" });
    const statuses = deferred<Record<string, SessionObservation>>();
    mocks.listSessionItems.mockResolvedValue([row]);
    mocks.sessionListStatuses.mockReturnValue(statuses.promise);
    const { result } = renderHook(() => useSessionNoticeSnapshot());

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(mocks.listSessionItems).toHaveBeenCalledWith(true, false);
    expect(mocks.sessionListStatuses).toHaveBeenCalledWith([{ repo_path: "/repo-b", task_slug: "task", id: "wait" }]);
    expect(result.current.loaded).toBe(false);
    expect(result.current.items).toEqual([]);

    statuses.resolve({ [key(row)]: waiting() });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.loaded).toBe(true);
    expect(result.current.items).toEqual([row]);
    expect(result.current.rows.map((notice) => notice.item.id)).toEqual(["wait"]);
  });

  it("schedules five seconds after completion and coalesces in-flight refreshes", async () => {
    const first = deferred<SessionListItem[]>();
    mocks.listSessionItems.mockReturnValueOnce(first.promise).mockResolvedValue([]);
    const { result } = renderHook(() => useSessionNoticeSnapshot());
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(mocks.listSessionItems).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.requestRefresh();
      result.current.requestRefresh();
    });
    first.resolve([]);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(mocks.listSessionItems).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    expect(mocks.listSessionItems).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.listSessionItems).toHaveBeenCalledTimes(3);
  });

  it("replaces stale state on item failure and uses current metadata when statuses fail", async () => {
    const old = item("old");
    mocks.listSessionItems.mockResolvedValueOnce([old]);
    mocks.sessionListStatuses.mockResolvedValueOnce({ [key(old)]: waiting() });
    const { result } = renderHook(() => useSessionNoticeSnapshot());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.rows).toHaveLength(1);

    mocks.listSessionItems.mockRejectedValueOnce(new Error("items failed"));
    await act(async () => result.current.requestRefresh());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.items).toEqual([]);
    expect(result.current.observations).toEqual({});
    expect(result.current.error).toEqual({ source: "load", detail: "items failed" });

    const completion = item("completion", { semantic: { phase_completed_at: 20 } });
    mocks.listSessionItems.mockResolvedValueOnce([completion]);
    mocks.sessionListStatuses.mockRejectedValueOnce(new Error("statuses failed"));
    await act(async () => result.current.requestRefresh());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.observations).toEqual({});
    expect(result.current.rows.map((notice) => notice.item.id)).toEqual(["completion"]);
    expect(result.current.error).toEqual({ source: "load", detail: "statuses failed" });
  });

  it("applies persisted exact suppression and reveals a changed occurrence", async () => {
    const row = item("wait", { notification_suppression: { notice: "waiting_for_input", occurrence: "corr-1" } });
    mocks.listSessionItems.mockResolvedValue([row]);
    mocks.sessionListStatuses.mockResolvedValueOnce({ [key(row)]: waiting("corr-1") }).mockResolvedValueOnce({ [key(row)]: waiting("corr-2") });
    const { result } = renderHook(() => useSessionNoticeSnapshot());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.rows).toEqual([]);
    await act(async () => result.current.requestRefresh());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.rows.map((notice) => notice.item.id)).toEqual(["wait"]);
  });

  it("clears every global row and sends fingerprints only for Clear all", async () => {
    const wait = item("wait", { repo_path: "/repo-a" });
    const completion = item("completion", { repo_path: "/repo-b", semantic: { phase_completed_at: 20 } });
    mocks.listSessionItems.mockResolvedValue([wait, completion]);
    mocks.sessionListStatuses.mockResolvedValue({ [key(wait)]: waiting() });
    const { result } = renderHook(() => useSessionNoticeSnapshot());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const pendingRefresh = deferred<SessionListItem[]>();
    mocks.listSessionItems.mockReturnValue(pendingRefresh.promise);

    await act(async () => result.current.clear());
    expect(mocks.clearSessionNotifications).toHaveBeenLastCalledWith([
      { repo_path: "/repo-a", task_slug: "task", id: "wait" },
      { repo_path: "/repo-b", task_slug: "task", id: "completion" },
    ]);
    expect(result.current.rows.map((notice) => notice.item.id)).toEqual(["wait"]);

    await act(async () => result.current.clearAll());
    expect(mocks.clearSessionNotifications).toHaveBeenLastCalledWith([
      {
        repo_path: "/repo-a",
        task_slug: "task",
        id: "wait",
        notification_suppression: { notice: "waiting_for_input", occurrence: "corr-1" },
      },
    ]);
    expect(result.current.rows).toEqual([]);
  });

  it("retains current rows when persistence fails", async () => {
    const row = item("completion", { semantic: { phase_completed_at: 20 } });
    mocks.listSessionItems.mockResolvedValue([row]);
    const { result } = renderHook(() => useSessionNoticeSnapshot());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    mocks.clearSessionNotifications.mockRejectedValueOnce(new Error("clear failed"));
    await act(async () => result.current.clearAll());
    expect(result.current.rows.map((notice) => notice.item.id)).toEqual(["completion"]);
    expect(result.current.error).toEqual({ source: "clear", detail: "clear failed" });
  });
});
