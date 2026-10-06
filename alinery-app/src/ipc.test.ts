import { describe, expect, it, vi } from "vitest";

const listeners: ((event: { payload: { id: string; attach_id: number; stream_token?: number } }) => void)[] = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (typeof listeners)[number]) => {
    listeners.push(handler);
    return () => {};
  }),
}));

const { onStreamClosed } = await import("./ipc");

describe("onStreamClosed", () => {
  it("fires for its own attach only and gives up after six closes in 30s", async () => {
    const onClosed = vi.fn();
    const onGiveUp = vi.fn();
    onStreamClosed("s1", 7, onClosed, onGiveUp);
    await Promise.resolve();
    const close = (id: string, attach_id: number) => {
      for (const listener of listeners) listener({ payload: { id, attach_id } });
    };
    close("s1", 8);
    close("s2", 7);
    expect(onClosed).not.toHaveBeenCalled();
    for (let i = 0; i < 6; i++) close("s1", 7);
    expect(onClosed).toHaveBeenCalledTimes(6);
    expect(onGiveUp).not.toHaveBeenCalled();
    close("s1", 7);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it("hands the view no cause, because the event carries none", async () => {
    const onClosed = vi.fn();
    const onGiveUp = vi.fn();
    onStreamClosed("s3", 9, onClosed, onGiveUp);
    await Promise.resolve();
    // The exact payload both Rust readers emit: no reason field to name.
    for (let i = 0; i < 7; i++) for (const listener of listeners) listener({ payload: { id: "s3", attach_id: 9, stream_token: 4 } });
    expect(onClosed).toHaveBeenCalledTimes(6);
    for (const call of onClosed.mock.calls) expect(call).toEqual([]);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp).toHaveBeenCalledWith();
  });
});
