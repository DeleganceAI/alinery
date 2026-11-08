import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonTransport } from "./daemon/transport";
import { fakeBoard } from "./test/boardHooks";
import { mockIpc } from "./test/mockIpc";
import { sessionDaemon } from "./test/sessionDaemon";
import type { SessionListItem, SessionObservation } from "./types";
import { useSessionNoticeSnapshot } from "./useSessionNoticeSnapshot";

const mocks = vi.hoisted(() => ({
  clearSessionNotifications: vi.fn(),
}));

vi.mock("./sync/board", async (actual) => (await import("./test/boardHooks")).boardHooks(await actual()));
vi.mock("./daemon/transport", () => ({ daemonTransport: vi.fn() }));
let daemon = sessionDaemon();
vi.mock("./sync/sessions", async (actual) => ({ ...(await actual<typeof import("./sync/sessions")>()), clearSessionNotifications: mocks.clearSessionNotifications }));
vi.mock("./ipc", () => mockIpc({}));

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

beforeEach(() => {
  vi.useFakeTimers();
  fakeBoard.reset();
  daemon = sessionDaemon();
  vi.mocked(daemonTransport).mockImplementation((repo) => daemon.transport(repo));
  mocks.clearSessionNotifications.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const REPOS = ["/repo-a", "/repo-b"];

describe("useSessionNoticeSnapshot", () => {
  it("publishes the all-repository item list and follows each session's daemon stream", async () => {
    const row = item("wait", { repo_path: "/repo-b" });
    fakeBoard.set({ sessions: [row] });
    const { result } = renderHook(() => useSessionNoticeSnapshot(REPOS));

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.loaded).toBe(true);
    expect(result.current.items).toEqual([row]);
    expect(result.current.rows).toEqual([]);

    daemon.show("/repo-b", "task", "wait", waiting());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.rows.map((notice) => notice.item.id)).toEqual(["wait"]);
  });

  it("follows the streams' rows as they change, with no refresh to ask for", async () => {
    const { result } = renderHook(() => useSessionNoticeSnapshot(REPOS));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.items).toEqual([]);

    const completion = item("completion", { semantic: { phase_completed_at: 20 } });
    act(() => fakeBoard.set({ sessions: [completion] }));
    expect(result.current.observations).toEqual({});
    expect(result.current.rows.map((notice) => notice.item.id)).toEqual(["completion"]);

    act(() => fakeBoard.set({ sessions: [] }));
    expect(result.current.rows).toEqual([]);
  });

  it("shows only the repositories it is given, and none while disabled", async () => {
    fakeBoard.set({ sessions: [item("a", { repo_path: "/repo-a" }), item("b", { repo_path: "/repo-b" })] });
    const { result, rerender } = renderHook(({ repos, enabled }) => useSessionNoticeSnapshot(repos, enabled), { initialProps: { repos: ["/repo-a"], enabled: true } });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.items.map((row) => row.id)).toEqual(["a"]);
    rerender({ repos: REPOS, enabled: false });
    expect(result.current.items).toEqual([]);
    expect(result.current.loaded).toBe(true);
  });

  it("applies persisted exact suppression and reveals a changed occurrence", async () => {
    const row = item("wait", { notification_suppression: { notice: "waiting_for_input", occurrence: "corr-1" } });
    fakeBoard.set({ sessions: [row] });
    daemon.show(row.repo_path, row.task_slug, row.id, waiting("corr-1"));
    const { result } = renderHook(() => useSessionNoticeSnapshot(REPOS));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.rows).toEqual([]);
    daemon.show(row.repo_path, row.task_slug, row.id, waiting("corr-2"));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.rows.map((notice) => notice.item.id)).toEqual(["wait"]);
  });

  it("clears every global row and sends fingerprints only for Clear all; the stream carries the result back", async () => {
    const wait = item("wait", { repo_path: "/repo-a" });
    const completion = item("completion", { repo_path: "/repo-b", semantic: { phase_completed_at: 20 } });
    fakeBoard.set({ sessions: [wait, completion] });
    daemon.show(wait.repo_path, wait.task_slug, wait.id, waiting());
    const { result } = renderHook(() => useSessionNoticeSnapshot(REPOS));
    await act(async () => vi.advanceTimersByTimeAsync(0));

    await act(async () => result.current.clear());
    expect(mocks.clearSessionNotifications).toHaveBeenLastCalledWith([
      { repo_path: "/repo-a", task_slug: "task", id: "wait" },
      { repo_path: "/repo-b", task_slug: "task", id: "completion" },
    ]);
    // The daemon rewrites the sessions; until its stream says so the rows stand.
    expect(result.current.rows.map((notice) => notice.item.id)).toEqual(["wait", "completion"]);
    act(() => fakeBoard.set({ sessions: [wait, { ...completion, notification_read_at: 30 }] }));
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
    act(() =>
      fakeBoard.set({
        sessions: [
          { ...wait, notification_suppression: { notice: "waiting_for_input", occurrence: "corr-1" } },
          { ...completion, notification_read_at: 30 },
        ],
      }),
    );
    expect(result.current.rows).toEqual([]);
  });

  it("retains current rows when persistence fails", async () => {
    const row = item("completion", { semantic: { phase_completed_at: 20 } });
    fakeBoard.set({ sessions: [row] });
    const { result } = renderHook(() => useSessionNoticeSnapshot(REPOS));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    mocks.clearSessionNotifications.mockRejectedValueOnce(new Error("clear failed"));
    await act(async () => result.current.clearAll());
    expect(result.current.rows.map((notice) => notice.item.id)).toEqual(["completion"]);
    expect(result.current.error).toEqual({ source: "clear", detail: "clear failed" });
  });
});
