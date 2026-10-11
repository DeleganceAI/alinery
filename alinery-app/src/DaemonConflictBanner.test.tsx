import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmHost } from "./confirm";
import { DaemonConflictBanner, HostGuardWarning, RepoBusyBanner } from "./DaemonConflictBanner";
import * as ipc from "./ipc";
import type * as IpcFixtures from "./test/mockIpc";
import type { DaemonConflict, DaemonOwnerConflict, TakeoverOutcome, TakeoverPreview } from "./types";

vi.mock("./ipc", async () => {
  const { mockIpc } = await vi.importActual<typeof IpcFixtures>("./test/mockIpc");
  return mockIpc({ prepareRepoTakeover: vi.fn(), confirmRepoTakeover: vi.fn(), cancelRepoTakeover: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
beforeEach(() => {
  vi.mocked(ipc.cancelRepoTakeover).mockResolvedValue();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const owner: DaemonOwnerConflict = {
  lane: "old-dev",
  pid: 42,
  protocol: 12,
  build_id: "old-build",
  app_config_identity: "old-config",
  impact: { status: "known", sessions: [] },
  takeover_unavailable: null,
};
const conflict: DaemonConflict = { repo: "/repo", app_protocol: 15, app_config_identity: "current", owners: [owner], issues: [] };
const preview: TakeoverPreview = { confirmation_id: "consent-a", repo: "/repo", owner };
function mount(value = conflict, refresh = vi.fn()) {
  return {
    ...render(
      <>
        <DaemonConflictBanner conflict={value} onRefresh={refresh} />
        <ConfirmHost />
      </>,
    ),
    refresh,
  };
}
async function open() {
  fireEvent.click(screen.getAllByRole("button", { name: "Take over repo" })[0]);
  return screen.findByRole("alertdialog");
}
function accept(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole("button", { name: "Stop daemon and take over" }));
}
function cancel(dialog: HTMLElement) {
  fireEvent.click(dialog.querySelector("[data-autofocus]") as HTMLElement);
}

describe("selected-owner takeover", () => {
  it.each([
    { status: "known", sessions: [] } as const,
    { status: "unknown", detail: "Session inspection timed out" } as const,
    {
      status: "known",
      sessions: [
        { id: "session-1", name: "Working task" },
        { id: "session-2", name: null },
      ],
    } as const,
  ])("requires safe confirmation for $status impact", async (impact) => {
    const selected = { ...owner, impact: impact as DaemonOwnerConflict["impact"] };
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue({ ...preview, owner: selected });
    mount({ ...conflict, owners: [selected] });
    const dialog = await open();
    expect(document.activeElement).toBe(dialog.querySelector("[data-autofocus]"));
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(dialog.textContent).toContain("old-dev");
    expect(dialog.textContent).toMatch(/all sessions/i);
    expect(dialog.textContent).toMatch(/in-flight/i);
    if (impact.status === "unknown") {
      expect(dialog.textContent).toContain(impact.detail);
      expect(dialog.textContent).not.toMatch(/0 listed/);
    } else if (impact.sessions.length) {
      expect(dialog.textContent).toContain("Working task");
      expect(dialog.textContent).toContain("session-2");
    } else expect(dialog.textContent).toMatch(/0 listed/);
    cancel(dialog);
    await waitFor(() => expect(ipc.cancelRepoTakeover).toHaveBeenCalledWith("consent-a"));
    expect(ipc.confirmRepoTakeover).not.toHaveBeenCalled();
  });

  it("dismisses with Escape without confirming", async () => {
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue(preview);
    mount();
    fireEvent(await open(), new Event("cancel", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(ipc.cancelRepoTakeover).toHaveBeenCalledWith("consent-a"));
    expect(ipc.confirmRepoTakeover).not.toHaveBeenCalled();
  });

  it("partial takeover never automatically prepares or confirms the next owner", async () => {
    const second = { ...owner, lane: "other-dev", pid: 43 };
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue(preview);
    vi.mocked(ipc.confirmRepoTakeover).mockResolvedValue({ status: "blocked", conflict: { ...conflict, owners: [second] } });
    const { refresh } = mount({ ...conflict, owners: [owner, second] });
    expect(screen.getByText(/PID 42/)).toBeTruthy();
    expect(screen.getByText(/PID 43/)).toBeTruthy();
    accept(await open());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByText(/PID 42/)).toBeNull();
    expect(screen.getByText(/PID 43/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/stopped/i);
    expect(ipc.prepareRepoTakeover).toHaveBeenCalledTimes(1);
    expect(ipc.prepareRepoTakeover).toHaveBeenCalledWith("/repo", "old-dev");
    expect(ipc.confirmRepoTakeover).toHaveBeenCalledExactlyOnceWith("consent-a");
  });

  it("changed impact requires another explicit consent and allows cancelling it", async () => {
    const changed = { ...preview, confirmation_id: "consent-b", owner: { ...owner, impact: { status: "unknown", detail: "Changed impact" } as const } };
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue(preview);
    vi.mocked(ipc.confirmRepoTakeover).mockResolvedValue({ status: "reconfirm", preview: changed });
    const { refresh } = mount();
    accept(await open());
    await screen.findByText(/Changed impact/);
    expect(ipc.confirmRepoTakeover).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    expect(document.activeElement).toBe(dialog.querySelector("[data-autofocus]"));
    cancel(dialog);
    await waitFor(() => expect(ipc.cancelRepoTakeover).toHaveBeenCalledWith("consent-b"));
    expect(ipc.confirmRepoTakeover).toHaveBeenCalledTimes(1);
  });

  it("accepts a refreshed preview only after the second explicit action", async () => {
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue(preview);
    vi.mocked(ipc.confirmRepoTakeover)
      .mockResolvedValueOnce({ status: "reconfirm", preview: { ...preview, confirmation_id: "consent-b" } })
      .mockResolvedValueOnce({ status: "attached" });
    mount();
    accept(await open());
    await waitFor(() => expect(screen.getByRole("alertdialog").querySelector("[data-autofocus]")).toBe(document.activeElement));
    expect(ipc.confirmRepoTakeover).toHaveBeenCalledTimes(1);
    accept(screen.getByRole("alertdialog"));
    await waitFor(() => expect(ipc.confirmRepoTakeover).toHaveBeenNthCalledWith(2, "consent-b"));
  });

  it.each(["prepare", "confirm"])("retains context and refreshes after %s failure", async (stage) => {
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue(preview);
    if (stage === "prepare") vi.mocked(ipc.prepareRepoTakeover).mockRejectedValue("Owner changed");
    else vi.mocked(ipc.confirmRepoTakeover).mockRejectedValue("Owner changed");
    const { refresh } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Take over repo" }));
    if (stage === "confirm") accept(await screen.findByRole("alertdialog"));
    await screen.findByText("Owner changed");
    expect(screen.getByText(/PID 42/)).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("shows unavailable evidence without an enabled action and keeps GUI exclusion separate", () => {
    mount({ ...conflict, owners: [{ ...owner, takeover_unavailable: "Peer identity unavailable" }], issues: ["Unreachable held lease"] });
    expect(screen.getByText("Peer identity unavailable")).toBeTruthy();
    expect(screen.getByText("Unreachable held lease")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /Take over/ }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    cleanup();
    const pick = vi.fn();
    render(<RepoBusyBanner repo="/repo" onPickRepo={pick} />);
    expect(screen.queryByRole("button", { name: /Take over/ })).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(pick).toHaveBeenCalledOnce();
  });

  it("suppresses duplicate requests across rows during preparation and confirmation", async () => {
    const prepare = deferred<TakeoverPreview>();
    const confirm = deferred<TakeoverOutcome>();
    vi.mocked(ipc.prepareRepoTakeover).mockReturnValue(prepare.promise);
    vi.mocked(ipc.confirmRepoTakeover).mockReturnValue(confirm.promise);
    mount({ ...conflict, owners: [owner, { ...owner, lane: "second", pid: 43 }] });
    const buttons = screen.getAllByRole("button", { name: "Take over repo" });
    act(() => {
      fireEvent.click(buttons[0]);
      fireEvent.click(buttons[1]);
      fireEvent.click(buttons[0]);
    });
    expect(ipc.prepareRepoTakeover).toHaveBeenCalledOnce();
    await act(async () => prepare.resolve(preview));
    const dialog = screen.getByRole("alertdialog");
    act(() => {
      accept(dialog);
      accept(dialog);
    });
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(ipc.confirmRepoTakeover).toHaveBeenCalledOnce());
    expect(ipc.prepareRepoTakeover).toHaveBeenCalledOnce();
    await act(async () => confirm.resolve({ status: "attached" }));
  });

  it.each(["unmount", "switch"])("disposes late preparation on %s", async (change) => {
    const prepare = deferred<TakeoverPreview>();
    vi.mocked(ipc.prepareRepoTakeover).mockReturnValue(prepare.promise);
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Take over repo" }));
    if (change === "unmount") view.unmount();
    else
      view.rerender(
        <>
          <DaemonConflictBanner conflict={{ ...conflict, repo: "/next" }} onRefresh={view.refresh} />
          <ConfirmHost />
        </>,
      );
    await act(async () => prepare.resolve(preview));
    expect(ipc.cancelRepoTakeover).toHaveBeenCalledWith("consent-a");
    expect(ipc.confirmRepoTakeover).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("disposes a pending dialog on repo switch and ignores its later acceptance", async () => {
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue(preview);
    const view = mount();
    const dialog = await open();
    view.rerender(
      <>
        <DaemonConflictBanner conflict={{ ...conflict, repo: "/next" }} onRefresh={view.refresh} />
        <ConfirmHost />
      </>,
    );
    await waitFor(() => expect(ipc.cancelRepoTakeover).toHaveBeenCalledWith("consent-a"));
    accept(dialog);
    await act(async () => {});
    expect(ipc.confirmRepoTakeover).not.toHaveBeenCalled();
    expect(view.refresh).not.toHaveBeenCalled();
  });

  it("disposes reconfirm arriving after unmount instead of showing another dialog", async () => {
    const confirm = deferred<TakeoverOutcome>();
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue(preview);
    vi.mocked(ipc.confirmRepoTakeover).mockReturnValue(confirm.promise);
    const view = mount();
    accept(await open());
    await waitFor(() => expect(ipc.confirmRepoTakeover).toHaveBeenCalledWith("consent-a"));
    view.unmount();
    await act(async () => confirm.resolve({ status: "reconfirm", preview: { ...preview, confirmation_id: "consent-b" } }));
    expect(ipc.cancelRepoTakeover).toHaveBeenCalledWith("consent-b");
    expect(view.refresh).not.toHaveBeenCalled();
  });

  it("clears when ownership becomes available and preserves non-actionable host warning", () => {
    render(
      <>
        <DaemonConflictBanner conflict={null} onRefresh={vi.fn()} />
        <HostGuardWarning visible={false} />
      </>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();
    render(<HostGuardWarning visible />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
