import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askConfirm, ConfirmHost } from "./confirm";
import { DaemonConflictBanner, HostGuardWarning, RepoBusyBanner, resetTakeoverPrompts } from "./DaemonConflictBanner";
import * as ipc from "./ipc";
import type * as IpcFixtures from "./test/mockIpc";
import { Toast } from "./toast";
import type { DaemonConflict, DaemonOwnerConflict, TakeoverOutcome, TakeoverPreview } from "./types";

vi.mock("./ipc", async () => {
  const { mockIpc } = await vi.importActual<typeof IpcFixtures>("./test/mockIpc");
  return mockIpc({ prepareRepoTakeover: vi.fn(), confirmRepoTakeover: vi.fn(), cancelRepoTakeover: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  resetTakeoverPrompts();
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
const REPO_LOCK = "/repo/.alinery/.repo-owner.lock";
const LANE_LOCK = "/repo/.alinery/.alineryd-old-dev.lock";
const held = (path: string) => `project owner is still running (${path}); stop it before opening this project here`;
// The three near-identical sentences Rust reports for two held leases.
const issues = [held(REPO_LOCK), held(LANE_LOCK), `${held(LANE_LOCK)}; cannot establish owner socket stopped (/repo/.alinery/alineryd-old-dev.sock): timed out`];
const conflict: DaemonConflict = { repo: "/repo", app_protocol: 15, app_config_identity: "current", owners: [owner], issues };
const preview: TakeoverPreview = { confirmation_id: "consent-a", repo: "/repo", owner };
const strip = () => screen.getByRole("button", { name: /repo is open elsewhere · showing saved progress/ });
function tree(value: DaemonConflict | null, refresh: () => void) {
  return (
    <>
      <DaemonConflictBanner conflict={value} onRefresh={refresh} />
      <ConfirmHost />
      <Toast />
    </>
  );
}
function mount(value: DaemonConflict | null = conflict, refresh = vi.fn()) {
  return { ...render(tree(value, refresh)), refresh };
}
const dialog = () => screen.findByRole("alertdialog", { name: "Take over repo?" });
function accept(element: HTMLElement, label = "Take over") {
  fireEvent.click(within(element).getByRole("button", { name: label }));
}
function cancel(element: HTMLElement) {
  fireEvent.click(element.querySelector("[data-autofocus]") as HTMLElement);
}

describe("repository takeover dialog", () => {
  it.each([
    { impact: { status: "known", sessions: [] }, label: "Take over" },
    { impact: { status: "unknown", detail: "Session inspection timed out" }, label: "Stop all sessions and take over" },
    {
      impact: {
        status: "known",
        sessions: [
          { id: "session-1", name: "Working task" },
          { id: "session-2", name: null },
        ],
      },
      label: "Stop 2 sessions and take over",
    },
  ] as const)("opens on its own and names what $impact.status impact stops", async ({ impact, label }) => {
    const selected = { ...owner, impact: impact as DaemonOwnerConflict["impact"] };
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue({ ...preview, owner: selected });
    mount({ ...conflict, owners: [selected] });
    const element = await dialog();
    expect(ipc.prepareRepoTakeover).toHaveBeenCalledExactlyOnceWith("/repo", "old-dev");
    expect(document.activeElement).toBe(element.querySelector("[data-autofocus]"));
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(within(element).getByRole("button", { name: label })).toBeTruthy();
    const evidence = element.querySelector("pre")?.textContent ?? "";
    if (impact.status === "unknown") expect(evidence).toContain(impact.detail);
    else if (impact.sessions.length) expect(evidence).toContain("Working task (session-1), session-2");
    cancel(element);
    await waitFor(() => expect(ipc.cancelRepoTakeover).toHaveBeenCalledWith("consent-a"));
    expect(ipc.confirmRepoTakeover).not.toHaveBeenCalled();
  });

  it("keeps Details collapsed by default and lists each lock path once", async () => {
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue(preview);
    mount();
    const element = await dialog();
    const details = element.querySelector("details.takeover-details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText("Details").tagName).toBe("SUMMARY");
    const evidence = details.querySelector("pre")?.textContent ?? "";
    expect(evidence.split(REPO_LOCK)).toHaveLength(2);
    expect(evidence.split(LANE_LOCK)).toHaveLength(2);
    expect(evidence).not.toContain("stop it before opening");
    expect(evidence).toContain("cannot establish owner socket stopped");
    expect(evidence).toContain("lane old-dev · PID 42 · protocol 12");
    expect(evidence).toContain("old-build");
  });

  it.each(["cancel", "escape", "close", "backdrop"])("collapses to a strip on %s, and the strip reopens the dialog", async (dismissal) => {
    vi.mocked(ipc.prepareRepoTakeover)
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({ ...preview, confirmation_id: "consent-b" });
    mount();
    expect(screen.queryByRole("button", { name: /open elsewhere/ })).toBeNull();
    const opened = await dialog();
    if (dismissal === "escape") fireEvent(opened, new Event("cancel", { bubbles: true, cancelable: true }));
    else if (dismissal === "close") fireEvent.click(within(opened.querySelector(".mh") as HTMLElement).getByRole("button", { name: "Cancel" }));
    else if (dismissal === "backdrop") {
      vi.spyOn(opened, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 400, 200));
      fireEvent.click(opened, { clientX: 50, clientY: 50 });
    } else cancel(opened);
    await waitFor(() => expect(strip()).toBeTruthy());
    await waitFor(() => expect(document.activeElement).toBe(strip()));
    expect(strip().textContent).not.toMatch(/PID|old-build|\.lock/);
    expect(screen.queryByRole("button", { name: /Dismiss/ })).toBeNull();
    fireEvent.click(strip());
    const reopened = await dialog();
    expect(screen.queryByRole("button", { name: /open elsewhere/ })).toBeNull();
    expect(ipc.prepareRepoTakeover).toHaveBeenCalledTimes(2);
    fireEvent(reopened, new Event("cancel", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(ipc.cancelRepoTakeover).toHaveBeenCalledWith("consent-b"));
    await waitFor(() => expect(document.activeElement).toBe(strip()));
  });

  it("prompts once per conflict, even across remounts", async () => {
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue(preview);
    const view = mount();
    cancel(await dialog());
    await waitFor(() => expect(strip()).toBeTruthy());
    view.rerender(tree(null, view.refresh));
    view.rerender(tree(conflict, view.refresh));
    expect(strip()).toBeTruthy();
    await act(async () => {});
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(ipc.prepareRepoTakeover).toHaveBeenCalledOnce();
  });

  it("partial takeover never automatically prepares or confirms the next owner", async () => {
    const second = { ...owner, lane: "other-dev", pid: 43 };
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue(preview);
    vi.mocked(ipc.confirmRepoTakeover).mockResolvedValue({ status: "blocked", conflict: { ...conflict, owners: [second] } });
    const { refresh } = mount({ ...conflict, owners: [owner, second] });
    accept(await dialog());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await screen.findByText(/Stopped one owner/);
    expect(strip()).toBeTruthy();
    await act(async () => {});
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(ipc.prepareRepoTakeover).toHaveBeenCalledExactlyOnceWith("/repo", "old-dev");
    expect(ipc.confirmRepoTakeover).toHaveBeenCalledExactlyOnceWith("consent-a");
  });

  it("remembers a manually dismissed next owner after returning to the repository", async () => {
    const second = { ...owner, lane: "other-dev", pid: 43 };
    const nextConflict = { ...conflict, owners: [second] };
    vi.mocked(ipc.prepareRepoTakeover)
      .mockResolvedValueOnce(preview)
      .mockResolvedValue({ ...preview, confirmation_id: "consent-b", owner: second });
    vi.mocked(ipc.confirmRepoTakeover).mockResolvedValue({ status: "blocked", conflict: nextConflict });
    const view = mount({ ...conflict, owners: [owner, second] });
    accept(await dialog());
    await waitFor(() => expect(strip()).toBeTruthy());
    fireEvent.click(strip());
    cancel(await dialog());
    await waitFor(() => expect(ipc.cancelRepoTakeover).toHaveBeenCalledWith("consent-b"));
    view.rerender(tree(null, view.refresh));
    view.rerender(tree(nextConflict, view.refresh));
    await act(async () => {});
    expect(strip()).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(ipc.prepareRepoTakeover).toHaveBeenCalledTimes(2);
  });

  it("remembers the actual preview owner when it replaced the polled process", async () => {
    const replacement = { ...owner, pid: 43 };
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue({ ...preview, owner: replacement });
    const view = mount();
    cancel(await dialog());
    await waitFor(() => expect(strip()).toBeTruthy());
    view.rerender(tree(null, view.refresh));
    view.rerender(tree({ ...conflict, owners: [replacement] }, view.refresh));
    await act(async () => {});
    expect(strip()).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(ipc.prepareRepoTakeover).toHaveBeenCalledOnce();
  });

  it("changed impact requires another explicit consent and allows cancelling it", async () => {
    const changed = { ...preview, confirmation_id: "consent-b", owner: { ...owner, impact: { status: "unknown", detail: "Changed impact" } as const } };
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue(preview);
    vi.mocked(ipc.confirmRepoTakeover).mockResolvedValue({ status: "reconfirm", preview: changed });
    const { refresh } = mount();
    accept(await dialog());
    await screen.findByText(/Changed impact/);
    expect(ipc.confirmRepoTakeover).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalled();
    const element = await screen.findByRole("alertdialog");
    expect(document.activeElement).toBe(element.querySelector("[data-autofocus]"));
    cancel(element);
    await waitFor(() => expect(ipc.cancelRepoTakeover).toHaveBeenCalledWith("consent-b"));
    expect(ipc.confirmRepoTakeover).toHaveBeenCalledTimes(1);
  });

  it("accepts a refreshed preview only after the second explicit action", async () => {
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue(preview);
    vi.mocked(ipc.confirmRepoTakeover)
      .mockResolvedValueOnce({ status: "reconfirm", preview: { ...preview, confirmation_id: "consent-b" } })
      .mockResolvedValueOnce({ status: "attached" });
    mount();
    accept(await dialog());
    await waitFor(() => expect(screen.getByRole("alertdialog").querySelector("[data-autofocus]")).toBe(document.activeElement));
    expect(ipc.confirmRepoTakeover).toHaveBeenCalledTimes(1);
    accept(screen.getByRole("alertdialog"));
    await waitFor(() => expect(ipc.confirmRepoTakeover).toHaveBeenNthCalledWith(2, "consent-b"));
    await screen.findByText("Took over repo");
    expect(screen.queryByRole("button", { name: /open elsewhere/ })).toBeNull();
  });

  it.each(["prepare", "confirm"])("reports %s failure, refreshes, and keeps the strip", async (stage) => {
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue(preview);
    if (stage === "prepare") vi.mocked(ipc.prepareRepoTakeover).mockRejectedValue("Owner changed");
    else vi.mocked(ipc.confirmRepoTakeover).mockRejectedValue("Owner changed");
    const { refresh } = mount();
    if (stage === "confirm") accept(await dialog());
    await screen.findByText("Couldn't take over repo: Owner changed");
    expect(refresh).toHaveBeenCalled();
    expect(strip()).toBeTruthy();
  });

  it("suppresses duplicate requests from repeated strip clicks", async () => {
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValueOnce(preview);
    mount();
    cancel(await dialog());
    await waitFor(() => expect(strip()).toBeTruthy());
    const prepare = deferred<TakeoverPreview>();
    vi.mocked(ipc.prepareRepoTakeover).mockReturnValue(prepare.promise);
    const button = strip();
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(ipc.prepareRepoTakeover).toHaveBeenCalledTimes(2);
    await act(async () => prepare.resolve({ ...preview, confirmation_id: "consent-b" }));
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
  });

  it.each(["unmount", "switch"])("disposes late preparation on %s", async (change) => {
    const prepare = deferred<TakeoverPreview>();
    vi.mocked(ipc.prepareRepoTakeover).mockReturnValue(prepare.promise);
    const view = mount();
    await waitFor(() => expect(ipc.prepareRepoTakeover).toHaveBeenCalledOnce());
    if (change === "unmount") view.unmount();
    else view.rerender(tree({ ...conflict, repo: "/next", owners: [{ ...owner, takeover_unavailable: "Peer identity unavailable" }] }, view.refresh));
    await act(async () => prepare.resolve(preview));
    expect(ipc.cancelRepoTakeover).toHaveBeenCalledWith("consent-a");
    expect(ipc.confirmRepoTakeover).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it.each(["switch", "clear"])("withdraws a pending dialog on %s and ignores its later acceptance", async (change) => {
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue(preview);
    const view = mount();
    const element = await dialog();
    view.rerender(tree(change === "switch" ? { ...conflict, repo: "/next", owners: [{ ...owner, takeover_unavailable: "Peer identity unavailable" }] } : null, view.refresh));
    await waitFor(() => expect(ipc.cancelRepoTakeover).toHaveBeenCalledWith("consent-a"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    accept(element);
    await act(async () => {});
    expect(ipc.confirmRepoTakeover).not.toHaveBeenCalled();
    expect(view.refresh).not.toHaveBeenCalled();
  });

  it("does not withdraw a newer unrelated confirmation when the strip unmounts", async () => {
    const cancellation = deferred<void>();
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue(preview);
    vi.mocked(ipc.cancelRepoTakeover).mockReturnValue(cancellation.promise);
    const view = mount();
    await dialog();
    const answered = vi.fn();
    act(() => {
      void askConfirm({ title: "Unrelated confirmation", body: "Keep this request open." }).then(answered);
    });
    await screen.findByRole("alertdialog", { name: "Unrelated confirmation" });
    view.rerender(tree(null, view.refresh));
    await act(async () => cancellation.resolve());
    const element = screen.getByRole("alertdialog", { name: "Unrelated confirmation" });
    expect(answered).not.toHaveBeenCalled();
    fireEvent.click(within(element).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(answered).toHaveBeenCalledExactlyOnceWith("confirm"));
    expect(ipc.confirmRepoTakeover).not.toHaveBeenCalled();
  });

  it("disposes reconfirm arriving after unmount instead of showing another dialog", async () => {
    const confirm = deferred<TakeoverOutcome>();
    vi.mocked(ipc.prepareRepoTakeover).mockResolvedValue(preview);
    vi.mocked(ipc.confirmRepoTakeover).mockReturnValue(confirm.promise);
    const view = mount();
    accept(await dialog());
    await waitFor(() => expect(ipc.confirmRepoTakeover).toHaveBeenCalledWith("consent-a"));
    view.unmount();
    await act(async () => confirm.resolve({ status: "reconfirm", preview: { ...preview, confirmation_id: "consent-b" } }));
    expect(ipc.cancelRepoTakeover).toHaveBeenCalledWith("consent-b");
    expect(view.refresh).not.toHaveBeenCalled();
  });
});

describe("repository status without a takeover", () => {
  it("shows unavailable evidence behind a collapsed Details and never offers takeover", async () => {
    mount({ ...conflict, owners: [{ ...owner, takeover_unavailable: "Peer identity unavailable" }] });
    await act(async () => {});
    expect(ipc.prepareRepoTakeover).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /Take over/ })).toBeNull();
    const status = document.querySelector(".repo-strip") as HTMLElement;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toContain("repo is open elsewhere · showing saved progress · quit the other window to work here");
    const toggle = within(status).getByRole("button", { name: "Details" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(status.querySelector("pre")).toBeNull();
    fireEvent.click(toggle);
    const evidence = status.querySelector("pre")?.textContent ?? "";
    expect(evidence).toContain("Peer identity unavailable");
    expect(evidence.split(REPO_LOCK)).toHaveLength(2);
    expect(evidence.split(LANE_LOCK)).toHaveLength(2);
  });

  it("reports ownership problems without owners as an error line", () => {
    mount({ ...conflict, owners: [], issues: ["invalid /repo/.alinery/tasks/a/task.md: bad toml"] });
    const status = document.querySelector(".repo-strip") as HTMLElement;
    expect(status.textContent).toContain("repo can't be opened here · showing saved progress");
    expect(status.classList.contains("error")).toBe(true);
  });

  it("keeps a second window separate: no takeover, one recovery action", () => {
    const pick = vi.fn();
    render(<RepoBusyBanner repo="/repo" onPickRepo={pick} />);
    expect(screen.getByRole("status").textContent).toContain("repo is open in another Alinery window");
    expect(screen.queryByRole("button", { name: /Take over/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open another repo…" }));
    expect(pick).toHaveBeenCalledOnce();
  });

  it("clears when ownership becomes available and preserves non-actionable host warning", () => {
    render(
      <>
        <DaemonConflictBanner conflict={null} onRefresh={vi.fn()} />
        <HostGuardWarning visible={false} />
      </>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    cleanup();
    render(<HostGuardWarning visible />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
