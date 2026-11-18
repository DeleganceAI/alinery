import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import { loopbackTarget, useProviderAccess } from "./providerAccess";

// The address comes from the daemon's own prompt, never from a port this app assumes: it is the
// redirect URI of whichever agent runtime the daemon runs.
describe("loopbackTarget", () => {
  it("reads the daemon's redirect address out of its prompt", () => {
    expect(loopbackTarget("http://127.0.0.1:1455/auth/callback")).toEqual({ port: 1455, path: "/auth/callback" });
  });

  it("follows the runtime when the port or path changes", () => {
    expect(loopbackTarget("http://127.0.0.1:8080/oauth/done")).toEqual({ port: 8080, path: "/oauth/done" });
  });

  it("takes a bare origin as the root path", () => {
    expect(loopbackTarget("http://127.0.0.1:1455")).toEqual({ port: 1455, path: "/" });
  });

  it("refuses anything that is not a loopback http address this app can bind", () => {
    for (const value of [
      undefined,
      "",
      "https://127.0.0.1:1455/auth/callback",
      "http://localhost:1455/auth/callback",
      "http://example.com:1455/auth/callback",
      "http://127.0.0.1:0/auth/callback",
      "http://127.0.0.1:99999/auth/callback",
      "http://127.0.0.1:1455/auth/callback?code=ac_2",
      "http://127.0.0.1:1455/auth/callback#frag",
    ]) {
      expect(loopbackTarget(value), String(value)).toBeNull();
    }
  });
});

// The armed listener gives up after ten minutes. The panel must stop promising a pickup that is
// no longer coming, and a later poll must not quietly re-arm the expired target.
const mocks = vi.hoisted(() => ({
  expiryHandlers: [] as Array<() => void>,
  onProviderCallbackExpired: vi.fn((handler: () => void) => {
    mocks.expiryHandlers.push(handler);
    return () => {};
  }),
  arm: vi.fn(async () => {}),
  disarm: vi.fn(async () => {}),
  catalog: vi.fn(async () => ({ providers: [], models: [], custom: [] })),
  loginStart: vi.fn(),
  loginPoll: vi.fn(),
}));

vi.mock("../ipc", () => mockIpc({ onProviderCallbackExpired: mocks.onProviderCallbackExpired, providerCallbackArm: mocks.arm, providerCallbackDisarm: mocks.disarm }));

vi.mock("../sync/providers", () => ({
  providerCatalog: mocks.catalog,
  providerLogout: vi.fn(),
  providerLoginStart: mocks.loginStart,
  providerLoginPoll: mocks.loginPoll,
  providerLoginReply: vi.fn(),
  customProviderSave: vi.fn(),
  customProviderCheck: vi.fn(),
  customProviderDelete: vi.fn(),
  listModels: vi.fn(),
}));

const REPO = "alinery+ssh://box-a1b2c3/home/me/proj";
const prompt = {
  loginId: "l1",
  status: "prompt",
  prompt: { type: "manual_code", message: "Paste the address you ended on", placeholder: "http://127.0.0.1:1455/auth/callback" },
  events: [],
  failure: "",
};

describe("useProviderAccess: callback expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.expiryHandlers.length = 0;
    mocks.arm.mockClear();
    mocks.loginStart.mockResolvedValue({ status: prompt, host: REPO });
    mocks.loginPoll.mockResolvedValue(prompt);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops offering the automatic pickup on expiry, and does not re-arm the same target", async () => {
    const { result } = renderHook(() => useProviderAccess(true, REPO));

    await act(async () => {
      await result.current.start("openai", "oauth");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(result.current.callbackArmed).toBe(true);
    expect(mocks.arm).toHaveBeenCalledWith(1455, "/auth/callback");

    act(() => {
      for (const fire of mocks.expiryHandlers) fire();
    });
    expect(result.current.callbackArmed).toBe(false);

    // The poll is still running and still sees the same prompt: the expired target must stay dead.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(mocks.arm).toHaveBeenCalledTimes(1);
    expect(result.current.callbackArmed).toBe(false);
  });
});
