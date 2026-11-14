import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { DaemonStatusSchema } from "alinery-proto/alinery/v1/entities_pb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { admin, daemonTransport } from "./daemon/transport";
import * as ipc from "./ipc";
import { daemonHarness, entity, put, scriptedSync, snapshot } from "./test/daemonHarness";
import type { DaemonStatus } from "./types";
import { useDaemonStatus } from "./useDaemonStatus";

vi.mock("./ipc", () => ({ daemonStatus: vi.fn() }));
vi.mock("./daemon/transport", () => ({ admin: vi.fn(), daemonTransport: vi.fn() }));
beforeEach(() => quiet());
afterEach(() => {
  cleanup();
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

const hang = () => new Promise<never>(() => {});
const statusRow = (liveSessions: number, busy = 0) => entity("daemon/_/status", { case: "daemonStatus", value: create(DaemonStatusSchema, { liveSessions, busy }) });
// A daemon whose stream the test pushes frames into. `drop()` ends the current stream with an error.
function liveDaemon() {
  const queue: (() => unknown)[] = [];
  let wake = () => {};
  const h = scriptedSync(async function* () {
    for (;;) {
      while (queue.length) yield (queue.shift() as () => never)();
      await new Promise<void>((r) => (wake = r));
    }
  });
  const push = (f: () => unknown) => {
    queue.push(f);
    wake();
  };
  vi.mocked(daemonTransport).mockReturnValue(daemonHarness({ sync: h.sync }).transport as Transport);
  return { push, requests: h.requests };
}
const quiet = () => {
  vi.mocked(daemonTransport).mockReturnValue(
    daemonHarness({
      // biome-ignore lint/correctness/useYield: a stream that never sends
      sync: scriptedSync(async function* () {
        await hang();
      }).sync,
    }).transport as Transport,
  );
};

it("a status delta re-renders the badge numbers with no timer and no extra command call", async () => {
  const d = liveDaemon();
  vi.mocked(ipc.daemonStatus).mockResolvedValue({ repo: "/fixture", build_drift: true, mode: "local" } as DaemonStatus);
  d.push(() => snapshot([statusRow(1)], 1));
  const { result } = renderHook(() => useDaemonStatus("/fixture"));
  await waitFor(() => expect(result.current.alive).toBe(1));
  expect(result.current.reachable).toBe(true);
  expect(result.current.build_drift).toBe(true); // the shell half still comes from the command
  const reads = vi.mocked(ipc.daemonStatus).mock.calls.length;
  d.push(() => put(statusRow(3, 2), 2));
  await waitFor(() => expect(result.current.alive).toBe(3));
  expect(result.current.busy).toBe(2);
  expect(vi.mocked(ipc.daemonStatus).mock.calls.length).toBe(reads);
});

it("the host guard warning is the daemon's own, from the status entity", async () => {
  const d = liveDaemon();
  vi.mocked(ipc.daemonStatus).mockResolvedValue({ repo: "/fixture" } as DaemonStatus);
  d.push(() => snapshot([entity("daemon/_/status", { case: "daemonStatus", value: create(DaemonStatusSchema, { hostGuardWarning: "no executable" }) })], 1));
  const { result } = renderHook(() => useDaemonStatus("/fixture"));
  await waitFor(() => expect(result.current.host_guard_warning).toBe(true));
  d.push(() => put(statusRow(0), 2));
  await waitFor(() => expect(result.current.host_guard_warning).toBe(false));
});

it("a dropped stream reports unreachable and keeps the last count", async () => {
  const d = liveDaemon();
  vi.mocked(ipc.daemonStatus).mockResolvedValue({ repo: "/fixture" } as DaemonStatus);
  d.push(() => snapshot([statusRow(2)], 1));
  const { result } = renderHook(() => useDaemonStatus("/fixture"));
  await waitFor(() => expect(result.current.alive).toBe(2));
  d.push(() => {
    throw new Error("link dropped");
  });
  await waitFor(() => expect(result.current.reachable).toBe(false));
  expect(result.current.alive).toBe(2);
});

it("reads the shell half again when the link comes up", async () => {
  const d = liveDaemon();
  vi.mocked(ipc.daemonStatus).mockResolvedValue({ repo: "/fixture" } as DaemonStatus);
  renderHook(() => useDaemonStatus("/fixture"));
  await waitFor(() => expect(ipc.daemonStatus).toHaveBeenCalledTimes(1));
  d.push(() => snapshot([statusRow(0)], 1));
  await waitFor(() => expect(ipc.daemonStatus).toHaveBeenCalledTimes(2));
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
    build_drift: true,
    conflict: null,
    repo_busy: false,
    host_guard_warning: false,
  };
  await act(async () => fresh.resolve(status));
  expect(result.current.build_drift).toBe(true);
  await act(async () => {
    if (settlement === "resolve") old.resolve({ ...status, build_drift: false });
    else old.reject(new Error("Old request failed"));
  });
  expect(result.current.build_drift).toBe(true);
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
    build_drift: true,
    conflict: null,
    repo_busy: false,
    host_guard_warning: false,
  };
  await act(async () => fresh.resolve(status));
  expect(result.current.repo).toBe("/new");
  await act(async () => {
    if (settlement === "resolve") old.resolve({ ...status, repo: "/old", build_drift: false });
    else old.reject(new Error("Old repository failed"));
  });
  expect(result.current.repo).toBe("/new");
  expect(result.current.build_drift).toBe(true);
  act(() => result.current.refresh());
  await act(async () => mismatch.resolve({ ...status, repo: "/old", build_drift: false }));
  expect(result.current.repo).toBe("/new");
  expect(result.current.build_drift).toBe(true);
});

it("calls Hello once per repo open and exposes protocol and build id", async () => {
  vi.mocked(ipc.daemonStatus).mockResolvedValue({} as DaemonStatus);
  const hello = vi.fn().mockResolvedValue({ protocol: 25, buildId: "b-1" });
  vi.mocked(admin).mockReturnValue({ hello } as unknown as ReturnType<typeof admin>);
  const { result, rerender } = renderHook(({ repo }) => useDaemonStatus(repo), { initialProps: { repo: "/repo/a" } });
  await act(async () => {});
  expect(result.current.hello).toEqual({ protocol: 25, buildId: "b-1" });
  expect(hello).toHaveBeenCalledTimes(1);
  rerender({ repo: "/repo/b" });
  expect(result.current.hello).toBeNull();
  await act(async () => {});
  expect(admin).toHaveBeenLastCalledWith("/repo/b");
});

it("leaves hello null when the daemon does not answer Hello", async () => {
  vi.mocked(ipc.daemonStatus).mockResolvedValue({} as DaemonStatus);
  vi.mocked(admin).mockReturnValue({ hello: vi.fn().mockRejectedValue(new Error("down")) } as unknown as ReturnType<typeof admin>);
  const { result } = renderHook(() => useDaemonStatus("/repo/a"));
  await act(async () => {});
  expect(result.current.hello).toBeNull();
});
