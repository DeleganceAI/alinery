import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "./test/mockIpc";
import type { OmpUpdateStatus } from "./types";
import { NO_OMP_UPDATE, useOmpUpdateStatus } from "./useOmpUpdateStatus";

const mocks = vi.hoisted(() => ({ checkOmpUpdate: vi.fn() }));

vi.mock("./ipc", () => mockIpc({ checkOmpUpdate: mocks.checkOmpUpdate }));

const available = (version: string): OmpUpdateStatus => ({
  installed: "18.1.10",
  available: { version, asset_url: "https://example.test/omp" },
  checked_at: 1,
  binary_path: "/Applications/Alinery.omp/omp",
  config_dir: "/tmp/cfg/omp/config/agent",
});

beforeEach(() => {
  vi.useFakeTimers();
  mocks.checkOmpUpdate.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dev configuration (no production gate)", () => {
  it("does call checkOmpUpdate after the first-check delay", async () => {
    mocks.checkOmpUpdate.mockResolvedValue(available("v18.2.0"));
    renderHook(() => useOmpUpdateStatus());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(mocks.checkOmpUpdate).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.checkOmpUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("cadence", () => {
  it("rechecks on an hourly cadence and picks up the newer status", async () => {
    mocks.checkOmpUpdate.mockResolvedValue(available("v18.2.0"));
    const { result } = renderHook(() => useOmpUpdateStatus());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current.status.available?.version).toBe("v18.2.0");

    mocks.checkOmpUpdate.mockResolvedValue(available("v18.3.0"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    });
    expect(mocks.checkOmpUpdate).toHaveBeenCalledTimes(2);
    expect(result.current.status.available?.version).toBe("v18.3.0");
  });

  it("falls back to NO_OMP_UPDATE silently when the backend call rejects", async () => {
    mocks.checkOmpUpdate.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useOmpUpdateStatus());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current.status).toEqual(NO_OMP_UPDATE);
  });
});

describe("shared offer", () => {
  it("lets one hook's checkNow and clearOffer drop the offer every subscriber shows", async () => {
    mocks.checkOmpUpdate.mockResolvedValue(available("v18.2.0"));
    const toolbar = renderHook(() => useOmpUpdateStatus());
    const settings = renderHook(() => useOmpUpdateStatus());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(toolbar.result.current.status.available?.version).toBe("v18.2.0");
    expect(settings.result.current.status.available?.version).toBe("v18.2.0");

    act(() => {
      settings.result.current.clearOffer();
    });
    expect(toolbar.result.current.status.available).toBeNull();

    mocks.checkOmpUpdate.mockResolvedValue(NO_OMP_UPDATE);
    await act(async () => {
      await settings.result.current.checkNow();
    });
    expect(toolbar.result.current.status).toEqual(NO_OMP_UPDATE);
  });
});
