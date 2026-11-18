import { describe, expect, it, vi } from "vitest";

type Event = { payload: { id: string; attach_id: number; stream_token?: number } | { url: string } | Record<string, never> };
const listeners: ((event: Event) => void)[] = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (typeof listeners)[number]) => {
    listeners.push(handler);
    return () => {};
  }),
}));

const { onProviderCallback, onRemoteHostConnected } = await import("./ipc");

function fire(payload: Event["payload"]) {
  for (const listener of listeners) listener({ payload });
}

describe("onRemoteHostConnected", () => {
  it("fires on the host event until it is unlistened", async () => {
    const handler = vi.fn();
    const stop = onRemoteHostConnected(handler);
    await Promise.resolve();
    const fireHost = () => {
      for (const listener of listeners) listener({ payload: { id: "", attach_id: 0 } });
    };
    fireHost();
    expect(handler).toHaveBeenCalledTimes(1);
    stop();
    fireHost();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("onProviderCallback", () => {
  it("hands over the URL the browser's redirect carried, and stops when unlistened", async () => {
    const handler = vi.fn();
    const stop = onProviderCallback(handler);
    await Promise.resolve();
    fire({ url: "http://127.0.0.1:1455/auth/callback?code=ac_2&state=s" });
    expect(handler).toHaveBeenCalledWith("http://127.0.0.1:1455/auth/callback?code=ac_2&state=s");
    stop();
    fire({ url: "http://127.0.0.1:1455/auth/callback?code=late" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores an event with no URL rather than replying to the daemon with nothing", async () => {
    const handler = vi.fn();
    onProviderCallback(handler);
    await Promise.resolve();
    fire({});
    expect(handler).not.toHaveBeenCalled();
  });
});
