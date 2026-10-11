import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import type { DaemonStatus } from "./types";
import { useDaemonStatus } from "./useDaemonStatus";

vi.mock("./ipc", () => ({ daemonStatus: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

it("does not overwrite a newer daemon observation with a delayed older poll", async () => {
  vi.useFakeTimers();
  let resolveOld!: (status: DaemonStatus) => void;
  let resolveNew!: (status: DaemonStatus) => void;
  vi.mocked(ipc.daemonStatus)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNew = resolve;
        }),
    );
  const status: DaemonStatus = {
    reachable: true,
    mode: "local",
    alive: 2,
    busy: 0,
    waiting_for_input: 0,
    waiting_for_approval: 0,
    idle: 2,
    unknown: 0,
    exited: 0,
    total: 2,
    extra_lanes: 0,
    stale_lanes: 0,
    repo: "/fixture",
    build_drift: false,
    conflict: null,
    repo_busy: false,
    host_guard_warning: false,
  };
  const { result } = renderHook(() => useDaemonStatus("/fixture"));
  await act(async () => {
    vi.advanceTimersByTime(1500);
  });
  await act(async () => {
    resolveNew(status);
  });
  expect(result.current.alive).toBe(2);
  await act(async () => {
    resolveOld({ ...status, alive: 1, idle: 1, total: 1 });
  });
  expect(result.current.alive).toBe(2);
});

it.each(["resolve", "reject"])("refresh discards an obsolete poll that will %s", async (settlement) => {
  const old = deferred<DaemonStatus>();
  const fresh = deferred<DaemonStatus>();
  vi.mocked(ipc.daemonStatus).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const { result } = renderHook(() => useDaemonStatus("/fixture"));
  const refresh = result.current.refresh;
  act(() => refresh());
  const status: DaemonStatus = {
    reachable: true,
    mode: "local",
    alive: 2,
    busy: 0,
    waiting_for_input: 0,
    waiting_for_approval: 0,
    idle: 2,
    unknown: 0,
    exited: 0,
    total: 2,
    extra_lanes: 0,
    stale_lanes: 0,
    repo: "/fixture",
    build_drift: false,
    conflict: null,
    repo_busy: false,
    host_guard_warning: false,
  };
  await act(async () => fresh.resolve(status));
  expect(result.current.alive).toBe(2);
  await act(async () => {
    if (settlement === "resolve") old.resolve({ ...status, alive: 1 });
    else old.reject(new Error("Old request failed"));
  });
  expect(result.current.alive).toBe(2);
  expect(result.current.refresh).toBe(refresh);
});

it.each(["resolve", "reject"])("repo switch discards obsolete %s and mismatched payloads", async (settlement) => {
  const old = deferred<DaemonStatus>();
  const fresh = deferred<DaemonStatus>();
  const mismatch = deferred<DaemonStatus>();
  vi.mocked(ipc.daemonStatus).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise).mockReturnValueOnce(mismatch.promise);
  const { result, rerender } = renderHook(({ repo }) => useDaemonStatus(repo), { initialProps: { repo: "/old" } });
  rerender({ repo: "/new" });
  const status: DaemonStatus = {
    reachable: true,
    mode: "local",
    alive: 2,
    busy: 0,
    waiting_for_input: 0,
    waiting_for_approval: 0,
    idle: 2,
    unknown: 0,
    exited: 0,
    total: 2,
    extra_lanes: 0,
    stale_lanes: 0,
    repo: "/new",
    build_drift: false,
    conflict: null,
    repo_busy: false,
    host_guard_warning: false,
  };
  await act(async () => fresh.resolve(status));
  expect(result.current.repo).toBe("/new");
  await act(async () => {
    if (settlement === "resolve") old.resolve({ ...status, repo: "/old", alive: 1 });
    else old.reject(new Error("Old repository failed"));
  });
  expect(result.current.repo).toBe("/new");
  expect(result.current.alive).toBe(2);
  act(() => result.current.refresh());
  await act(async () => mismatch.resolve({ ...status, repo: "/old", alive: 1 }));
  expect(result.current.repo).toBe("/new");
  expect(result.current.alive).toBe(2);
});
