import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("./toast", () => ({ toast: mocks.toast }));

import { claim, currentKind, refuseIfBusy, release, subscribe } from "./taskMutationGuard";

// Creating or duplicating a task runs a whole worktree checkout on the backend, so the
// app allows exactly one at a time from any entry point — form, ⌘N, or a board's
// Duplicate — and a refused attempt has to say why rather than silently do nothing.

beforeEach(() => {
  release();
  mocks.toast.mockReset();
});

describe("task mutation guard", () => {
  it("hands the slot to the first caller and refuses everyone else", () => {
    expect(claim("create")).toBe(true);
    expect(currentKind()).toBe("create");
    expect(claim("create")).toBe(false);
    expect(claim("duplicate")).toBe(false);
    // A refused claim must not steal the slot from the mutation already running.
    expect(currentKind()).toBe("create");
  });

  it("names the operation already running when it refuses", () => {
    claim("duplicate");
    refuseIfBusy();
    expect(mocks.toast).toHaveBeenLastCalledWith("A task is already being duplicated — wait for it to finish.", "error");
    release();
    claim("create");
    refuseIfBusy();
    expect(mocks.toast).toHaveBeenLastCalledWith("A task is already being created — wait for it to finish.", "error");
  });

  it("stays quiet when nothing is running", () => {
    expect(refuseIfBusy()).toBe(false);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("reopens the slot on release and reports every change to subscribers", () => {
    const seen: (string | null)[] = [];
    const unsubscribe = subscribe(() => seen.push(currentKind()));
    claim("create");
    release();
    unsubscribe();
    claim("duplicate");
    expect(seen).toEqual(["create", null]);
    expect(currentKind()).toBe("duplicate");
  });
});
