import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmHost, confirmStopAndSwitch } from "./confirm";
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
