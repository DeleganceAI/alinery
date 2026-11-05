import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonTransport } from "./daemon/transport";
import { mockIpc } from "./test/mockIpc";
import { sessionDaemon } from "./test/sessionDaemon";
import type { SessionListItem, SessionObservation } from "./types";
import { useSessionNoticeSnapshot } from "./useSessionNoticeSnapshot";

const mocks = vi.hoisted(() => ({
  listSessionItems: vi.fn(),
  clearSessionNotifications: vi.fn(),
}));

vi.mock("./daemon/transport", () => ({ daemonTransport: vi.fn() }));
let daemon = sessionDaemon();
vi.mock("./ipc", () =>
  mockIpc({
    listSessionItems: mocks.listSessionItems,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.listSessionItems.mockReset().mockResolvedValue([]);
  daemon = sessionDaemon();
  vi.mocked(daemonTransport).mockImplementation((repo) => daemon.transport(repo));
  mocks.clearSessionNotifications.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSessionNoticeSnapshot", () => {
  it("publishes the all-repository item list and follows each session's daemon stream", async () => {
    const row = item("wait", { repo_path: "/repo-b" });
    mocks.listSessionItems.mockResolvedValue([row]);
    const { result } = renderHook(() => useSessionNoticeSnapshot());

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(mocks.listSessionItems).toHaveBeenCalledWith(true, false);
    expect(result.current.loaded).toBe(true);
    expect(result.current.items).toEqual([row]);
    expect(result.current.rows).toEqual([]);

    daemon.show("/repo-b", "task", "wait", waiting());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.rows.map((notice) => notice.item.id)).toEqual(["wait"]);
    expect(mocks.listSessionItems).toHaveBeenCalledTimes(1); // no refetch: the stream delivered it
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

  it("replaces stale state on item failure and keeps current metadata rows with no daemon status", async () => {
    const old = item("old");
    mocks.listSessionItems.mockResolvedValueOnce([old]);
    daemon.show(old.repo_path, "task", "old", waiting());
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
    await act(async () => result.current.requestRefresh());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.observations).toEqual({});
    expect(result.current.rows.map((notice) => notice.item.id)).toEqual(["completion"]);
    expect(result.current.error).toBeNull();
  });

  it("applies persisted exact suppression and reveals a changed occurrence", async () => {
    const row = item("wait", { notification_suppression: { notice: "waiting_for_input", occurrence: "corr-1" } });
    mocks.listSessionItems.mockResolvedValue([row]);
    daemon.show(row.repo_path, row.task_slug, row.id, waiting("corr-1"));
    const { result } = renderHook(() => useSessionNoticeSnapshot());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.rows).toEqual([]);
    daemon.show(row.repo_path, row.task_slug, row.id, waiting("corr-2"));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.rows.map((notice) => notice.item.id)).toEqual(["wait"]);
  });

  it("clears every global row and sends fingerprints only for Clear all", async () => {
    const wait = item("wait", { repo_path: "/repo-a" });
    const completion = item("completion", { repo_path: "/repo-b", semantic: { phase_completed_at: 20 } });
    mocks.listSessionItems.mockResolvedValue([wait, completion]);
    daemon.show(wait.repo_path, wait.task_slug, wait.id, waiting());
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
