import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "./test/mockIpc";
import type { UpdateStatus } from "./types";
import { NO_UPDATE, useUpdateStatus } from "./useUpdateStatus";

const mocks = vi.hoisted(() => ({ checkUpdate: vi.fn() }));

vi.mock("./ipc", () => mockIpc({ checkUpdate: mocks.checkUpdate }));

const available = (version: string): UpdateStatus => ({
  current: "0.10.0",
  available: { version, url: "", sha256: "", size: 0, protocol_version: 2, published_at: "" },
  checked_at: 1,
});

beforeEach(() => {
  vi.useFakeTimers();
  mocks.checkUpdate.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("enabled: false (dev builds)", () => {
  it("never calls check_update, even after the poll delay elapses", async () => {
    const { result } = renderHook(() => useUpdateStatus({ enabled: false }));
    expect(result.current.status).toEqual(NO_UPDATE);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000);
    });

    expect(mocks.checkUpdate).not.toHaveBeenCalled();
    expect(result.current.status).toEqual(NO_UPDATE);
  });
});

describe("enabled (default)", () => {
  it("checks once after the first-check delay, not before", async () => {
    mocks.checkUpdate.mockResolvedValue(available("0.11.0"));
    renderHook(() => useUpdateStatus());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(mocks.checkUpdate).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.checkUpdate).toHaveBeenCalledTimes(1);
  });

  it("rechecks on an hourly cadence and picks up the newer status", async () => {
    mocks.checkUpdate.mockResolvedValue(available("0.11.0"));
    const { result } = renderHook(() => useUpdateStatus());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current.status.available?.version).toBe("0.11.0");

    mocks.checkUpdate.mockResolvedValue(available("0.12.0"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    });
    expect(mocks.checkUpdate).toHaveBeenCalledTimes(2);
    expect(result.current.status.available?.version).toBe("0.12.0");
  });

  it("falls back to NO_UPDATE silently when the backend call rejects", async () => {
    mocks.checkUpdate.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useUpdateStatus());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(result.current.status).toEqual(NO_UPDATE);
  });
});

describe("checkNow", () => {
  it("checks immediately, independent of the poll timers, and exposes checking", async () => {
    mocks.checkUpdate.mockResolvedValue(available("0.11.0"));
    const { result } = renderHook(() => useUpdateStatus({ enabled: false }));

    let pending!: Promise<UpdateStatus>;
    act(() => {
      pending = result.current.checkNow();
    });
    expect(result.current.checking).toBe(true);

    const resolved = await act(async () => pending);

    expect(resolved.available?.version).toBe("0.11.0");
    expect(result.current.status.available?.version).toBe("0.11.0");
    expect(result.current.checking).toBe(false);
  });
});

describe("clearOffer", () => {
  it("drops a pending available release without calling the backend", async () => {
    mocks.checkUpdate.mockResolvedValue(available("0.11.0"));
    const { result } = renderHook(() => useUpdateStatus({ enabled: false }));

    await act(async () => {
      await result.current.checkNow();
    });
    expect(result.current.status.available?.version).toBe("0.11.0");

    act(() => {
      result.current.clearOffer();
    });
    expect(result.current.status.available).toBeNull();
    expect(mocks.checkUpdate).toHaveBeenCalledTimes(1);
  });
});
