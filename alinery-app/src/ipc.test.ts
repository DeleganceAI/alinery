import { describe, expect, it, vi } from "vitest";

const listeners: ((event: { payload: { id: string; attach_id: number; stream_token?: number } }) => void)[] = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (typeof listeners)[number]) => {
    listeners.push(handler);
    return () => {};
  }),
}));

const { onRemoteHostConnected } = await import("./ipc");

describe("onRemoteHostConnected", () => {
  it("fires on the host event until it is unlistened", async () => {
    const handler = vi.fn();
    const stop = onRemoteHostConnected(handler);
    await Promise.resolve();
    const fire = () => {
      for (const listener of listeners) listener({ payload: { id: "", attach_id: 0 } });
    };
    fire();
    expect(handler).toHaveBeenCalledTimes(1);
    stop();
    fire();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
