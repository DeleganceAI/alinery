// App is imported inside each case so hoisted mocks are initialized first.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "./appearance";
import * as taskMutationGuard from "./taskMutationGuard";
import { mockIpc } from "./test/mockIpc";
import type { AppConfig, SessionMeta } from "./types";

type DrawerTab = { id: string; ordinal: number; cwd: string };
type RecordedDrawer = {
  open?: boolean;
  tabs?: DrawerTab[];
  activeId?: string | null;
  onSelect?: (id: string) => void;
  creating?: boolean;
  onClose?: (id: string) => void;
  onNew?: () => void;
  onKillAll?: () => void;
  onTabExited?: (id: string) => void;
};

const appConfig: AppConfig = {
  active_repo: "/repo",
  known_repos: ["/repo", "/other"],
  mcp_enabled: true,
  appearance: DEFAULT_APPEARANCE,
};

const drawerRecords = vi.hoisted(() => ({ current: [] as RecordedDrawer[] }));

const mocks = vi.hoisted(() => ({
  ensureDrawerTerminal: vi.fn(),
  killSession: vi.fn(async (_id: string, _slug: string) => {}),
  sessionStatus: vi.fn(),
  killSessionForRepo: vi.fn(async (_repo: string, _id: string, _slug: string) => {}),
  setActiveRepo: vi.fn(),
  removeRepo: vi.fn(),
  repoLiveSessions: vi.fn(async () => 0),
  readAppConfig: vi.fn(),
  confirmDanger: vi.fn(async () => true),
  toast: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  onCloseRequested: vi.fn(async () => () => {}),
}));

vi.mock("./ipc", () =>
  mockIpc({
    getVersion: async () => "0.19.1",
    getName: async () => "Alinery Test",
    readAppConfig: mocks.readAppConfig,
    listBoardTasks: async () => [],
    listTasks: async () => [],
    listSessionItems: async () => [],
    sessionListStatuses: async () => ({}),
    ensureDrawerTerminal: mocks.ensureDrawerTerminal,
    killSession: mocks.killSession,
    killSessionForRepo: mocks.killSessionForRepo,
    sessionStatus: mocks.sessionStatus,
    setActiveRepo: mocks.setActiveRepo,
    removeRepo: mocks.removeRepo,
    repoLiveSessions: mocks.repoLiveSessions,
    getCurrentWindow: (() => ({ onCloseRequested: mocks.onCloseRequested, destroy: vi.fn() })) as never,
    getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) as never,
  }),
);
vi.mock("./toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./toast")>();
  return {
    ...actual,
    toast: Object.assign(mocks.toast, {
      success: mocks.toastSuccess,
      error: mocks.toastError,
      info: vi.fn(),
    }),
  };
});
vi.mock("./confirm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confirm")>();
  return { ...actual, confirmDanger: mocks.confirmDanger };
});
vi.mock("./telemetry-consent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./telemetry-consent")>();
  return { ...actual, shouldAskTelemetryConsent: () => false };
});
vi.mock("./TerminalDrawer", () => ({
  DRAWER_DEFAULT_WIDTH: 360,
  clampDrawerWidth: (value: number) => value,
  TerminalDrawer: (props: RecordedDrawer) => {
    drawerRecords.current.push(props);
    return null;
  },
}));
vi.mock("./BackgroundFX", () => ({ BackgroundFX: () => null }));
vi.mock("./Boot", () => ({ Boot: () => null }));
vi.mock("./HotkeyBar", () => ({ HotkeyBar: () => null }));
vi.mock("./DaemonConflictBanner", () => ({ DaemonConflictBanner: () => null, RepoBusyBanner: () => null, HostGuardWarning: () => null }));
vi.mock("./WindowChrome", () => ({ ResizeHandles: () => null, WindowControls: () => null, useWindowFullscreen: () => false }));
vi.mock("./useDaemonStatus", () => ({ useDaemonStatus: () => ({ repo_busy: false, conflict: null }) }));
vi.mock("./useMcpStatus", () => ({ useMcpStatus: () => ({}) }));
vi.mock("./views/Kanban", () => ({ Kanban: () => null }));
vi.mock("./views/Grid", () => ({ Grid: () => null }));

function meta(id: string, worktree = "/repo"): SessionMeta {
  return {
    id,
    worktree,
    created: 0,
    archived: false,
    phase: "",
    harness: "no-harness",
    model: "",
    playbook: "",
    generic: true,
    harness_resume_token: "",
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function pressBackquote(shift = false) {
  fireEvent.keyDown(document.body, { key: "`", code: "Backquote", metaKey: true, shiftKey: shift });
}
function latestDrawer(): RecordedDrawer {
  const records = drawerRecords.current;
  const last = records[records.length - 1];
  expect(last, "TerminalDrawer was not mounted").toBeTruthy();
  return last as RecordedDrawer;
}

async function renderApp(config: AppConfig = appConfig) {
  drawerRecords.current = [];
  mocks.readAppConfig.mockResolvedValue(config);
  const { default: App } = await import("./App");
  render(<App />);
  if (config.active_repo) await screen.findByRole("button", { name: "Repository" });
  else await screen.findByText("token:attention");
}

// A cleared drawer is unmounted, so its last recorded props are stale; the shortcut only
// creates a fresh shell when no handle remains.
async function expectDrawerCleared() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const before = mocks.ensureDrawerTerminal.mock.calls.length;
  mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta("fresh"));
  pressBackquote();
  await waitFor(() => expect(mocks.ensureDrawerTerminal).toHaveBeenCalledTimes(before + 1));
}

async function openFirst(id = "s-1", worktree = "/repo") {
  mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta(id, worktree));
  pressBackquote();
  await waitFor(() => expect(mocks.ensureDrawerTerminal).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(drawerRecords.current.length).toBeGreaterThan(0));
  return latestDrawer();
}

function requireFn(value: unknown, name: string): (...args: string[]) => void {
  expect(value, `App must pass ${name}`).toEqual(expect.any(Function));
  return value as (...args: string[]) => void;
}

beforeEach(() => {
  cleanup();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  drawerRecords.current = [];
  mocks.ensureDrawerTerminal.mockReset();
  mocks.killSession.mockReset().mockResolvedValue(undefined);
  mocks.sessionStatus.mockReset().mockRejectedValue(new Error("no status"));
  mocks.killSessionForRepo.mockReset().mockResolvedValue(undefined);
  mocks.setActiveRepo.mockReset().mockImplementation(async (path: string) => ({ ...appConfig, active_repo: path }));
  mocks.removeRepo.mockReset().mockResolvedValue({ ...appConfig, active_repo: "", known_repos: ["/other"] });
  mocks.repoLiveSessions.mockReset().mockResolvedValue(0);
  mocks.readAppConfig.mockReset().mockResolvedValue(appConfig);
  mocks.confirmDanger.mockReset().mockResolvedValue(true);
  mocks.toast.mockReset();
  mocks.toastError.mockReset();
  mocks.onCloseRequested.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  taskMutationGuard.release();
});

describe("App terminal drawer tabs", () => {
  it("does not create a terminal when there is no active repo", async () => {
    await renderApp({ ...appConfig, active_repo: "" });
    pressBackquote();
    expect(mocks.ensureDrawerTerminal).not.toHaveBeenCalled();
  });

  it("opens one ordinal tab from the shortcut and hides without killing", async () => {
    await renderApp();
    const opened = await openFirst("s-1", "/repo");
    expect(opened.open).toBe(true);
    expect(opened.tabs).toEqual([{ id: "s-1", ordinal: 1, cwd: "/repo" }]);
    expect(opened.activeId).toBe("s-1");

    pressBackquote();
    expect(mocks.killSession).not.toHaveBeenCalled();
    await waitFor(() => expect(latestDrawer().open).toBe(false));
    expect(latestDrawer().tabs).toEqual([{ id: "s-1", ordinal: 1, cwd: "/repo" }]);

    pressBackquote();
    expect(mocks.ensureDrawerTerminal).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(latestDrawer().open).toBe(true));
  });

  it("uses the active repo path when the created meta has an empty worktree", async () => {
    await renderApp();
    const opened = await openFirst("s-empty", "");
    expect(opened.tabs).toEqual([{ id: "s-empty", ordinal: 1, cwd: "/repo" }]);
  });

  it("opens another tab from onNew and selects it", async () => {
    await renderApp();
    const opened = await openFirst();
    expect(opened.onNew).toEqual(expect.any(Function));
    mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta("s-2"));
    opened.onNew?.();
    await waitFor(() => expect(mocks.ensureDrawerTerminal).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(latestDrawer().activeId).toBe("s-2"));
    expect(latestDrawer().tabs).toEqual([
      { id: "s-1", ordinal: 1, cwd: "/repo" },
      { id: "s-2", ordinal: 2, cwd: "/repo" },
    ]);
    expect(latestDrawer().open).toBe(true);
  });

  it("ignores a second onNew while the first create is in flight", async () => {
    await renderApp();
    const opened = await openFirst();
    const onNew = requireFn(opened.onNew, "onNew");
    const pending = deferred<SessionMeta>();
    mocks.ensureDrawerTerminal.mockReturnValueOnce(pending.promise);
    onNew();
    onNew();
    expect(mocks.ensureDrawerTerminal).toHaveBeenCalledTimes(2);
    pending.resolve(meta("s-2"));
    await waitFor(() => expect(latestDrawer().tabs?.map((tab) => tab.id)).toEqual(["s-1", "s-2"]));
    expect(latestDrawer().tabs?.filter((tab) => tab.id === "s-2")).toHaveLength(1);
  });

  it("toasts a create failure and leaves the tab list unchanged", async () => {
    await renderApp();
    const opened = await openFirst();
    const onNew = requireFn(opened.onNew, "onNew");
    mocks.ensureDrawerTerminal.mockRejectedValueOnce(new Error("create failed"));
    onNew();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("create failed"), "error"));
    expect(latestDrawer().tabs).toEqual([{ id: "s-1", ordinal: 1, cwd: "/repo" }]);
  });

  it("kills only the closed inactive tab and keeps its sibling ordinal", async () => {
    await renderApp();
    const opened = await openFirst();
    const onNew = requireFn(opened.onNew, "onNew");
    mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta("s-2"));
    onNew();
    await waitFor(() => expect(latestDrawer().tabs).toEqual([expect.objectContaining({ id: "s-1" }), expect.objectContaining({ id: "s-2" })]));
    requireFn(latestDrawer().onClose, "onClose")("s-1");
    await waitFor(() => expect(mocks.killSession).toHaveBeenCalledWith("s-1", ""));
    expect(mocks.killSession).not.toHaveBeenCalledWith("s-2", "");
    expect(latestDrawer().activeId).toBe("s-2");
    expect(latestDrawer().tabs).toEqual([{ id: "s-2", ordinal: 2, cwd: "/repo" }]);
    expect(latestDrawer().open).toBe(true);
  });

  it("does not renumber survivors and continues the ordinal counter", async () => {
    await renderApp();
    const opened = await openFirst("s-1");
    const onNew = requireFn(opened.onNew, "onNew");
    mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta("s-2"));
    onNew();
    await waitFor(() => expect(latestDrawer().tabs?.map((tab) => tab.ordinal)).toEqual([1, 2]));
    mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta("s-3"));
    requireFn(latestDrawer().onNew, "onNew")();
    await waitFor(() => expect(latestDrawer().tabs?.map((tab) => tab.ordinal)).toEqual([1, 2, 3]));
    requireFn(latestDrawer().onClose, "onClose")("s-2");
    await waitFor(() => expect(latestDrawer().tabs?.map((tab) => tab.ordinal)).toEqual([1, 3]));
    mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta("s-4"));
    requireFn(latestDrawer().onNew, "onNew")();
    await waitFor(() => expect(latestDrawer().tabs?.map((tab) => tab.ordinal)).toEqual([1, 3, 4]));
  });

  it("selects the right neighbor when the active tab closes, and the previous tab when it was last", async () => {
    await renderApp();
    const opened = await openFirst("s-1");
    const onNew = requireFn(opened.onNew, "onNew");
    mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta("s-2"));
    onNew();
    await waitFor(() => expect(latestDrawer().tabs?.map((tab) => tab.id)).toEqual(["s-1", "s-2"]));
    mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta("s-3"));
    requireFn(latestDrawer().onNew, "onNew")();
    await waitFor(() => expect(latestDrawer().activeId).toBe("s-3"));
    requireFn(latestDrawer().onSelect, "onSelect")("s-2");
    await waitFor(() => expect(latestDrawer().activeId).toBe("s-2"));
    requireFn(latestDrawer().onClose, "onClose")("s-2");
    await waitFor(() => expect(latestDrawer().activeId).toBe("s-3"));
    expect(mocks.killSession).toHaveBeenCalledWith("s-2", "");
    expect(mocks.killSession).not.toHaveBeenCalledWith("s-1", "");
    expect(mocks.killSession).not.toHaveBeenCalledWith("s-3", "");

    requireFn(latestDrawer().onClose, "onClose")("s-3");
    await waitFor(() => expect(latestDrawer().activeId).toBe("s-1"));
  });

  it("drops the handle when the last tab closes, so the next shortcut creates a fresh shell", async () => {
    await renderApp();
    const opened = await openFirst("s-1");
    requireFn(opened.onClose, "onClose")("s-1");
    await waitFor(() => expect(mocks.killSession).toHaveBeenCalledWith("s-1", ""));
    pressBackquote();
    await waitFor(() => expect(mocks.ensureDrawerTerminal).toHaveBeenCalledTimes(2));
  });

  it("treats one tab exit as a removal of that id, without a kill and not a kill-all", async () => {
    await renderApp();
    const opened = await openFirst("s-1");
    const onNew = requireFn(opened.onNew, "onNew");
    mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta("s-2"));
    onNew();
    await waitFor(() => expect(latestDrawer().tabs?.map((tab) => tab.id)).toEqual(["s-1", "s-2"]));
    requireFn(latestDrawer().onTabExited, "onTabExited")("s-1");
    await waitFor(() => expect(latestDrawer().tabs?.map((tab) => tab.id)).toEqual(["s-2"]));
    expect(latestDrawer().open).toBe(true);

    requireFn(latestDrawer().onTabExited, "onTabExited")("s-2");
    await expectDrawerCleared();
    expect(mocks.killSession).not.toHaveBeenCalled();
  });

  it("composes two exits reported in the same batch", async () => {
    await renderApp();
    const opened = await openFirst("s-1");
    for (const id of ["s-2", "s-3"]) {
      mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta(id));
      requireFn(latestDrawer().onNew, "onNew")();
      await waitFor(() => expect(latestDrawer().tabs?.map((tab) => tab.id)).toContain(id));
    }
    const exited = requireFn(opened.onTabExited ?? latestDrawer().onTabExited, "onTabExited");
    act(() => {
      exited("s-1");
      exited("s-2");
    });
    await waitFor(() => expect(latestDrawer().tabs?.map((tab) => tab.id)).toEqual(["s-3"]));
  });

  it("keeps a tab and reports when its kill is rejected and the shell is still live", async () => {
    await renderApp();
    const opened = await openFirst("s-1");
    mocks.killSession.mockRejectedValueOnce(new Error("daemon busy"));
    mocks.sessionStatus.mockResolvedValue({ lifecycle: { state: "live" }, state: null, checkpoint: {} });
    requireFn(opened.onClose, "onClose")("s-1");
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("terminal 1")));
    expect(latestDrawer().tabs?.map((tab) => tab.id)).toEqual(["s-1"]);
    expect(latestDrawer().open).toBe(true);

    requireFn(latestDrawer().onClose, "onClose")("s-1");
    await expectDrawerCleared();
  });

  it("removes a tab whose kill was rejected but whose shell is observed exited", async () => {
    await renderApp();
    const opened = await openFirst("s-1");
    mocks.killSession.mockRejectedValueOnce(new Error("no such session"));
    mocks.sessionStatus.mockResolvedValue({ lifecycle: { state: "live_exited" }, state: null, checkpoint: {} });
    requireFn(opened.onClose, "onClose")("s-1");
    await expectDrawerCleared();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("kill-all removes the tabs that stopped and keeps the ones that did not", async () => {
    await renderApp();
    const opened = await openFirst("s-1");
    mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta("s-2"));
    requireFn(opened.onNew, "onNew")();
    await waitFor(() => expect(latestDrawer().tabs).toHaveLength(2));
    mocks.killSession.mockImplementation(async (id: string) => {
      if (id === "s-1") throw new Error("daemon busy");
    });
    mocks.sessionStatus.mockResolvedValue({ lifecycle: { state: "live" }, state: null, checkpoint: {} });
    requireFn(latestDrawer().onKillAll, "onKillAll")();
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("terminal 1")));
    expect(latestDrawer().tabs?.map((tab) => tab.id)).toEqual(["s-1"]);
    expect(latestDrawer().open).toBe(true);
  });

  it("flags the drawer as creating while an ensure is pending and clears it on failure", async () => {
    await renderApp();
    const opened = await openFirst("s-1");
    const pending = deferred<SessionMeta>();
    mocks.ensureDrawerTerminal.mockReturnValueOnce(pending.promise);
    requireFn(opened.onNew, "onNew")();
    await waitFor(() => expect(latestDrawer().creating).toBe(true));
    pending.reject(new Error("spawn failed"));
    await waitFor(() => expect(latestDrawer().creating).toBe(false));
    expect(latestDrawer().tabs).toHaveLength(1);
  });

  it("kills every tab from the shortcut and the palette without a confirm", async () => {
    await renderApp();
    const opened = await openFirst("s-1");
    const onNew = requireFn(opened.onNew, "onNew");
    mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta("s-2"));
    onNew();
    await waitFor(() => expect(latestDrawer().tabs?.map((tab) => tab.id)).toEqual(["s-1", "s-2"]));
    mocks.confirmDanger.mockClear();
    pressBackquote(true);
    await waitFor(() => expect(mocks.killSession).toHaveBeenCalledWith("s-1", ""));
    expect(mocks.killSession).toHaveBeenCalledWith("s-2", "");
    expect(mocks.confirmDanger).not.toHaveBeenCalled();

    mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta("s-3"));
    pressBackquote();
    await waitFor(() => expect(latestDrawer().tabs?.[0]?.id).toBe("s-3"));
    mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta("s-4"));
    requireFn(latestDrawer().onNew, "onNew")();
    await waitFor(() => expect(latestDrawer().tabs).toHaveLength(2));
    mocks.killSession.mockClear();
    mocks.confirmDanger.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByText("Kill terminal drawer"));
    await waitFor(() => expect(mocks.killSession).toHaveBeenCalledWith("s-3", ""));
    expect(mocks.killSession).toHaveBeenCalledWith("s-4", "");
    expect(mocks.confirmDanger).not.toHaveBeenCalled();
  });

  it("passes every drawer id to setActiveRepo and does not kill from the frontend", async () => {
    await renderApp();
    const opened = await openFirst("s-1");
    const onNew = requireFn(opened.onNew, "onNew");
    mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta("s-2"));
    onNew();
    await waitFor(() => expect(latestDrawer().tabs?.map((tab) => tab.id)).toEqual(["s-1", "s-2"]));
    mocks.setActiveRepo.mockResolvedValueOnce({ ...appConfig, active_repo: "/other" });
    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    fireEvent.click(screen.getByTitle("/other"));
    await waitFor(() => expect(mocks.setActiveRepo).toHaveBeenCalledWith("/other", ["s-1", "s-2"]));
    expect(mocks.killSession).not.toHaveBeenCalled();
    mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta("s-3"));
    pressBackquote();
    await waitFor(() => expect(mocks.ensureDrawerTerminal).toHaveBeenCalledTimes(3));
  });

  it("passes the open drawer id to setActiveRepo as a list", async () => {
    await renderApp();
    await openFirst("s-1");
    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    fireEvent.click(screen.getByTitle("/other"));
    await waitFor(() => expect(mocks.setActiveRepo).toHaveBeenCalledWith("/other", ["s-1"]));
    expect(mocks.killSession).not.toHaveBeenCalled();
  });

  it("keeps tabs when the switch throws or the active repo does not change", async () => {
    await renderApp();
    await openFirst("s-1");
    mocks.setActiveRepo.mockRejectedValueOnce(new Error("open in another Alinery window"));
    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    fireEvent.click(screen.getByTitle("/other"));
    await waitFor(() => expect(mocks.setActiveRepo).toHaveBeenCalled());
    expect(mocks.killSession).not.toHaveBeenCalled();
    expect(latestDrawer().tabs).toEqual([{ id: "s-1", ordinal: 1, cwd: "/repo" }]);

    mocks.setActiveRepo.mockResolvedValueOnce({ ...appConfig, active_repo: "/repo" });
    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    fireEvent.click(screen.getByTitle("/other"));
    await waitFor(() => expect(mocks.setActiveRepo).toHaveBeenCalledTimes(2));
    expect(latestDrawer().tabs).toEqual([{ id: "s-1", ordinal: 1, cwd: "/repo" }]);
    expect(latestDrawer().onNew).toEqual(expect.any(Function));
  });

  it("does not switch or clear tabs when the scope becomes all repos", async () => {
    await renderApp();
    await openFirst("s-1");
    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    fireEvent.click(screen.getByRole("button", { name: "All repos" }));
    expect(mocks.setActiveRepo).not.toHaveBeenCalled();
    expect(latestDrawer().tabs).toEqual([{ id: "s-1", ordinal: 1, cwd: "/repo" }]);
  });

  it("kills an in-flight create that resolves after kill-all", async () => {
    await renderApp();
    const opened = await openFirst("s-1");
    const onNew = requireFn(opened.onNew, "onNew");
    const pending = deferred<SessionMeta>();
    mocks.ensureDrawerTerminal.mockReturnValueOnce(pending.promise);
    onNew();
    requireFn(opened.onKillAll, "onKillAll")();
    pending.resolve(meta("s-2"));
    await waitFor(() => expect(mocks.killSession).toHaveBeenCalledWith("s-1", ""));
    await waitFor(() => {
      const killedSecond =
        mocks.killSession.mock.calls.some((call) => call[0] === "s-2") ||
        mocks.killSessionForRepo.mock.calls.some((call) => call[0] === "/repo" && call[1] === "s-2" && call[2] === "");
      expect(killedSecond).toBe(true);
    });
    expect(drawerRecords.current.some((props) => props.tabs?.some((tab) => tab.id === "s-2"))).toBe(false);
    mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta("s-3"));
    pressBackquote();
    await waitFor(() => expect(latestDrawer().tabs?.[0]?.id).toBe("s-3"));
  });

  it("does not insert a tab that resolves after a successful switch", async () => {
    await renderApp();
    const opened = await openFirst("s-1");
    const onNew = requireFn(opened.onNew, "onNew");
    const pending = deferred<SessionMeta>();
    mocks.ensureDrawerTerminal.mockReturnValueOnce(pending.promise);
    onNew();
    mocks.setActiveRepo.mockResolvedValueOnce({ ...appConfig, active_repo: "/other" });
    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    fireEvent.click(screen.getByTitle("/other"));
    await waitFor(() => expect(mocks.setActiveRepo).toHaveBeenCalled());
    pending.resolve(meta("s-2"));
    await waitFor(() => expect(mocks.killSessionForRepo).toHaveBeenCalledWith("/repo", "s-2", ""));
    expect(drawerRecords.current.some((props) => props.tabs?.some((tab) => tab.id === "s-2"))).toBe(false);
  });

  it("kills a tab that resolves while a repo switch is still in flight", async () => {
    await renderApp();
    const opened = await openFirst("s-1");
    const onNew = requireFn(opened.onNew, "onNew");
    const pending = deferred<SessionMeta>();
    const switchPending = deferred<AppConfig>();
    mocks.ensureDrawerTerminal.mockReturnValueOnce(pending.promise);
    mocks.setActiveRepo.mockReturnValueOnce(switchPending.promise);
    onNew();
    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    fireEvent.click(screen.getByTitle("/other"));
    await waitFor(() => expect(mocks.setActiveRepo).toHaveBeenCalledWith("/other", ["s-1"]));
    pending.resolve(meta("s-2"));
    await Promise.resolve();
    switchPending.resolve({ ...appConfig, active_repo: "/other" });
    await waitFor(() => expect(mocks.killSessionForRepo).toHaveBeenCalledWith("/repo", "s-2", ""));
    expect(drawerRecords.current.some((props) => props.tabs?.some((tab) => tab.id === "s-2"))).toBe(false);
    expect(mocks.killSession).not.toHaveBeenCalled();
  });

  it("inserts a tab that resolves during a switch that then fails", async () => {
    await renderApp();
    const opened = await openFirst("s-1");
    const onNew = requireFn(opened.onNew, "onNew");
    const pending = deferred<SessionMeta>();
    const switchPending = deferred<AppConfig>();
    mocks.ensureDrawerTerminal.mockReturnValueOnce(pending.promise);
    mocks.setActiveRepo.mockReturnValueOnce(switchPending.promise);
    onNew();
    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    fireEvent.click(screen.getByTitle("/other"));
    await waitFor(() => expect(mocks.setActiveRepo).toHaveBeenCalled());
    pending.resolve(meta("s-2"));
    await Promise.resolve();
    switchPending.reject(new Error("open in another Alinery window"));
    await waitFor(() => expect(latestDrawer().tabs?.map((tab) => tab.id)).toEqual(["s-1", "s-2"]));
    expect(mocks.killSession).not.toHaveBeenCalled();
    expect(mocks.killSessionForRepo).not.toHaveBeenCalled();
  });

  it("kills drawer tabs before removing the active repo, and does nothing when confirm is denied", async () => {
    await renderApp();
    const opened = await openFirst("s-1");
    const onNew = requireFn(opened.onNew, "onNew");
    mocks.ensureDrawerTerminal.mockResolvedValueOnce(meta("s-2"));
    onNew();
    await waitFor(() => expect(latestDrawer().tabs?.map((tab) => tab.id)).toEqual(["s-1", "s-2"]));
    mocks.confirmDanger.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    fireEvent.click(screen.getByRole("button", { name: "Close repo" }));
    await waitFor(() => expect(mocks.confirmDanger).toHaveBeenCalled());
    expect(mocks.killSession).not.toHaveBeenCalled();
    expect(mocks.removeRepo).not.toHaveBeenCalled();

    mocks.confirmDanger.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    fireEvent.click(screen.getByRole("button", { name: "Close repo" }));
    await waitFor(() => expect(mocks.killSession).toHaveBeenCalledWith("s-1", ""));
    expect(mocks.killSession).toHaveBeenCalledWith("s-2", "");
    expect(mocks.removeRepo).toHaveBeenCalledWith("/repo");
  });
});
