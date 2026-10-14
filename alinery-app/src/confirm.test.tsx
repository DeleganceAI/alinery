import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { askConfirm, ConfirmHost, confirmStopAndSwitch } from "./confirm";
import type * as IpcFixtures from "./test/mockIpc";

vi.mock("./ipc", async () => {
  const { mockIpc } = await vi.importActual<typeof IpcFixtures>("./test/mockIpc");
  return mockIpc();
});

describe("confirmStopAndSwitch", () => {
  afterEach(cleanup);

  it.each([
    ["pty", "Switch to Terminal?"],
    ["rpc", "Switch to Chat?"],
  ] as const)("asks about the %s target by name and resolves true on accept", async (target, title) => {
    render(<ConfirmHost />);
    let answer: Promise<boolean> = Promise.resolve(false);
    act(() => {
      answer = confirmStopAndSwitch(target);
    });

    expect(await screen.findByRole("alertdialog", { name: title })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Stop and switch" }));
    await expect(answer).resolves.toBe(true);
  });

  it("resolves false when the user cancels", async () => {
    render(<ConfirmHost />);
    let answer: Promise<boolean> = Promise.resolve(true);
    act(() => {
      answer = confirmStopAndSwitch("pty");
    });

    fireEvent.click((await screen.findAllByRole("button", { name: "Cancel" }))[0] as HTMLElement);
    await expect(answer).resolves.toBe(false);
  });
});

describe("confirmation withdrawal", () => {
  afterEach(cleanup);

  it("cancels an aborted request before it mounts without replacing the current dialog", async () => {
    render(<ConfirmHost />);
    let current!: Promise<string>;
    act(() => {
      current = askConfirm({ title: "Current request", body: "Still valid." });
    });
    const controller = new AbortController();
    controller.abort();
    await expect(askConfirm({ title: "Withdrawn request", body: "No longer valid.", cancelKey: "leave", signal: controller.signal })).resolves.toBe("leave");
    expect(screen.getByRole("alertdialog", { name: "Current request" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await expect(current).resolves.toBe("confirm");
  });

  it("keeps a queued replacement when the previous request is aborted in the same update", async () => {
    render(<ConfirmHost />);
    const controller = new AbortController();
    let previous!: Promise<string>;
    let replacement!: Promise<string>;
    act(() => {
      previous = askConfirm({ title: "Previous request", body: "Previous.", cancelKey: "leave", signal: controller.signal });
    });
    act(() => {
      replacement = askConfirm({ title: "Replacement request", body: "Replacement." });
      controller.abort();
    });
    await expect(previous).resolves.toBe("leave");
    expect(screen.getByRole("alertdialog", { name: "Replacement request" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await expect(replacement).resolves.toBe("confirm");
  });
});
