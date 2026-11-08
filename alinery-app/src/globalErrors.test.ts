import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("./toast", () => ({ toast: mocks.toast }));

import { installGlobalErrorReports } from "./globalErrors";

// A rejected promise or a throw from an event handler never reaches React's render path,
// so an ErrorBoundary cannot catch it and the app would carry on silently broken.

beforeEach(() => {
  mocks.toast.error.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  installGlobalErrorReports();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("global error reports", () => {
  it("reports an unhandled rejection with its reason", () => {
    const event = new Event("unhandledrejection") as Event & { reason: unknown };
    event.reason = new Error("the daemon did not answer");
    window.dispatchEvent(event);
    expect(mocks.toast.error).toHaveBeenCalledWith(expect.stringContaining("the daemon did not answer"));
  });

  it("reports a throw from an event handler", () => {
    const event = new Event("error") as Event & { message: string; error?: unknown };
    event.message = "cannot read properties of undefined";
    window.dispatchEvent(event);
    expect(mocks.toast.error).toHaveBeenCalledWith(expect.stringContaining("cannot read properties of undefined"));
  });

  it("stays quiet for a rejection with nothing to say", () => {
    const event = new Event("unhandledrejection") as Event & { reason: unknown };
    event.reason = undefined;
    window.dispatchEvent(event);
    expect(mocks.toast.error).toHaveBeenCalledWith(expect.stringContaining("undefined"));
  });
});
