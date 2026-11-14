import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { askConfirm, ConfirmHost } from "./confirm";
import type * as IpcFixtures from "./test/mockIpc";

vi.mock("./ipc", async () => {
  const { mockIpc } = await vi.importActual<typeof IpcFixtures>("./test/mockIpc");
  return mockIpc();
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
