import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import { settleOpenUrl } from "./openUrl";

const mocks = vi.hoisted(() => ({ openUrl: vi.fn(), rpcWriteSession: vi.fn() }));

vi.mock("../ipc", () => mockIpc({ openUrl: mocks.openUrl, rpcWriteSession: mocks.rpcWriteSession }));

const reply = (confirmed: boolean) => ({ type: "extension_ui_response", id: "req-1", confirmed });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.openUrl.mockResolvedValue(undefined);
  mocks.rpcWriteSession.mockResolvedValue(undefined);
});

describe("settleOpenUrl", () => {
  it("opens an https link and confirms it through the writer it was given", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const report = vi.fn();
    await settleOpenUrl("s1", "req-1", "https://example.com/a", report, write);
    expect(mocks.openUrl).toHaveBeenCalledWith("https://example.com/a");
    expect(write).toHaveBeenCalledWith(reply(true));
    expect(report).not.toHaveBeenCalled();
    expect(mocks.rpcWriteSession).not.toHaveBeenCalled();
  });

  it("refuses a javascript: link, reports it, and answers not confirmed", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const report = vi.fn();
    await settleOpenUrl("s1", "req-1", "javascript:void(0)", report, write);
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.stringContaining("only http and https"));
    expect(write).toHaveBeenCalledWith(reply(false));
  });

  it("answers not confirmed and reports the error when the opener rejects", async () => {
    mocks.openUrl.mockRejectedValueOnce(new Error("no browser"));
    const write = vi.fn().mockResolvedValue(undefined);
    const report = vi.fn();
    await settleOpenUrl("s1", "req-1", "https://example.com", report, write);
    expect(report).toHaveBeenCalledWith("Error: no browser");
    expect(write).toHaveBeenCalledWith(reply(false));
  });

  it("answers over the session RPC when no writer is given", async () => {
    await settleOpenUrl("s1", "req-1", "https://example.com", vi.fn());
    expect(mocks.rpcWriteSession).toHaveBeenCalledWith("s1", reply(true));
  });
});
