import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_STATE_ART } from "../emptyStateArt";
import { mockIpc } from "../test/mockIpc";
import { navReady, requireNav } from "../test/nav";
import type { BoardNav, BoardTask, SessionListItem, SessionObservation } from "../types";
import { SessionsList } from "./SessionsList";

let boardTasks: BoardTask[] = [];
let sessionItems: SessionListItem[] = [];
let currentNav: BoardNav | null = null;
let observations: Record<string, SessionObservation> = {};
const mocks = vi.hoisted(() => ({
  listSessionItems: vi.fn(),
  sessionListStatuses: vi.fn(),
  renameSession: vi.fn(),
}));

vi.mock("../ipc", () =>
  mockIpc({
    listSessionItems: mocks.listSessionItems,
    renameSession: mocks.renameSession,
    sessionListStatuses: mocks.sessionListStatuses,
    listBoardTasks: async () => boardTasks,
  }),
);

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn() });
  Element.prototype.scrollIntoView = vi.fn();
  sessionItems = [];
  observations = {};
  currentNav = null;
  mocks.listSessionItems
    .mockReset()
    .mockImplementation(async (allRepos, _archived, repoPath) => (allRepos ? sessionItems : sessionItems.filter((item) => item.repo_path === repoPath)));
  mocks.sessionListStatuses.mockReset().mockImplementation(async () => observations);
  mocks.renameSession.mockReset().mockResolvedValue({ name: "Committed name", source: "user" });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  boardTasks = [];
  sessionItems = [];
  observations = {};
  vi.clearAllMocks();
  currentNav = null;
  vi.unstubAllGlobals();
});

const task = (over: Partial<BoardTask>): BoardTask =>
  ({
    name: "A task",
    slug: "a-task",
    requested_slug: "a-task",
    branch: "a-task",
    worktree: "/w/a-task",
    has_worktree: true,
    created: 1,
    archived: false,
    pr_url: "",
    linear_id: "",
    github_issue: "",
    playbook: "superdevelop",
    draft: false,
    auto_advance: [],
    repo_path: "/r",
    session_count: 0,
    playbook_title: "SuperDevelop",
    updated: 1,
    current_phase: "design",
    current_step_title: "Design",
    current_column_key: "research-design",
    current_column_title: "Research & Design",
    ...over,
  }) as BoardTask;

const session = (over: Partial<SessionListItem> = {}): SessionListItem =>
  ({
    id: "s1",
    worktree: "/w/a-task",
    created: 1,
    archived: false,
    phase: "design",
    harness: "omp",
    model: "",
    playbook: "superdevelop",
    generic: false,
    harness_resume_token: "",
    semantic: {},
    task_slug: "a-task",
    task_name: "A task",
    task_worktree: "/w/a-task",
    repo_path: "/r",
    playbook_title: "SuperDevelop",
    step_title: "Design",
    is_playbook_step: true,
    ...over,
  }) as SessionListItem;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const busyObservation: SessionObservation = {
  lifecycle: { state: "live" },
  state: {
    process: { state: "alive" },
    agent: { state: "busy" },
    playbook: { state: "in_progress" },
    adapter: "omp",
    message_adapter: "unsupported",
  },
  checkpoint: {},
};

describe("SessionsList empty", () => {
  it("renders a catalog plate on the major empty surface", async () => {
    const { container } = render(<SessionsList allRepos={false} activeRepo="/r" onOpen={() => {}} registerNav={() => {}} onCreateSession={() => {}} onCreateTask={() => {}} />);
    await screen.findByText("No sessions yet.");
    const img = container.querySelector("img.empty-state-art");
    expect(img).not.toBeNull();
    expect(EMPTY_STATE_ART).toContain(img?.getAttribute("src"));
    expect(container.querySelector(".list-empty")).not.toBeNull();
  });

  it("offers New task when the only tasks are archived", async () => {
    boardTasks = [task({ name: "Old spike", slug: "old-spike", archived: true })];
    render(<SessionsList allRepos={false} activeRepo="/r" onOpen={() => {}} registerNav={() => {}} onCreateSession={() => {}} onCreateTask={() => {}} />);

    expect(await screen.findByRole("button", { name: "New task" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
  });

  it("offers New session when a live task exists", async () => {
    boardTasks = [task({ name: "Live", slug: "live" })];
    render(<SessionsList allRepos={false} activeRepo="/r" onOpen={() => {}} registerNav={() => {}} onCreateSession={() => {}} onCreateTask={() => {}} />);

    expect(await screen.findByRole("button", { name: "New session" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
  });
});

const renderedNames = (container: HTMLElement) => [...container.querySelectorAll(".list > .row .rtt")].map((node) => node.textContent);

describe("SessionsList repository scope", () => {
  it("keeps B visible when a delayed A response arrives after switching repositories", async () => {
    let resolveA!: (rows: SessionListItem[]) => void;
    const pendingA = new Promise<SessionListItem[]>((resolve) => {
      resolveA = resolve;
    });
    mocks.listSessionItems.mockImplementation((_allRepos, _archived, repoPath) =>
      repoPath === "/b" ? Promise.resolve([session({ repo_path: "/b", task_name: "Repository B" })]) : pendingA,
    );
    const props = { allRepos: false, onOpen: vi.fn(), registerNav: vi.fn(), onCreateSession: vi.fn(), onCreateTask: vi.fn() };
    const { rerender } = render(<SessionsList {...props} activeRepo="/a" />);
    rerender(<SessionsList {...props} activeRepo="/b" />);
    await screen.findByText("Repository B");
    await act(async () => resolveA([session({ repo_path: "/a", task_name: "Repository A" })]));
    expect(screen.queryByText("Repository A")).toBeNull();
    expect(screen.getByText("Repository B")).toBeDefined();
  });
});

describe("SessionsList without identifiers", () => {
  it("opens the correct same-label session without exposing IDs or losing resumed state", async () => {
    const original = session({ id: "opaque-original", created: 10 });
    const resumed = session({ id: "opaque-resumed", created: 20, resume_of: original.id });
    sessionItems = [original, resumed];
    const onOpen = vi.fn();
    const { container } = render(<SessionsList allRepos={false} activeRepo="/r" onOpen={onOpen} registerNav={() => {}} onCreateSession={() => {}} onCreateTask={() => {}} />);
    await screen.findByText("Resumed");
    const list = container.querySelector(".list") as HTMLElement;
    for (const item of sessionItems) {
      expect(list.textContent).not.toContain(item.id);
      expect(list.querySelector(`[title*="${item.id}"], [aria-label*="${item.id}"]`)).toBeNull();
    }
    const rows = [...list.querySelectorAll<HTMLElement>(".session-list-row")];
    expect(within(rows[1]).getByText("Resumed")).toBeDefined();
    expect(rows.map((row) => row.querySelector(".rts")?.textContent)).toEqual(["a-task", "a-task"]);
    fireEvent.click(rows[0]);
    expect(onOpen).toHaveBeenLastCalledWith(resumed);
    fireEvent.keyDown(rows[1], { key: "Enter" });
    expect(onOpen).toHaveBeenLastCalledWith(original);
    fireEvent.keyDown(rows[0], { key: " " });
    expect(onOpen).toHaveBeenLastCalledWith(resumed);
  });
});

describe("SessionsList attention order", () => {
  it("renders an older running session above a newer settled row without changing backend order", async () => {
    sessionItems = [
      session({
        id: "newer-tdd",
        task_name: "Newer task",
        created: 20,
        phase: "tdd",
        step_title: "TDD",
        semantic: { phase_completed_at: 20 },
        notification_read_at: 20,
      }),
      session({ id: "older-design", task_name: "Older task", created: 10 }),
    ];
    observations = {
      "/r:a-task:older-design": busyObservation,
      "/r:a-task:newer-tdd": {
        lifecycle: { state: "exited", code: 0 },
        state: null,
        checkpoint: { phase_completed_at: 20 },
      },
    };
    const originalIds = sessionItems.map((row) => row.id);
    const { container } = render(<SessionsList allRepos={false} activeRepo="/r" onOpen={() => {}} registerNav={() => {}} onCreateSession={() => {}} onCreateTask={() => {}} />);

    await waitFor(() => {
      expect(renderedNames(container)).toEqual(["Older task", "Newer task"]);
    });
    expect(sessionItems.map((row) => row.id)).toEqual(originalIds);
    expect(mocks.sessionListStatuses).toHaveBeenCalledTimes(1);
  });

  it("keeps only an unacknowledged exit in the failure attention tier", async () => {
    sessionItems = [
      session({ id: "acknowledged", task_name: "Acknowledged task", created: 10, ended_at: 90, exit_code: 143, exit_notification_read_at: 90 }),
      session({ id: "inactive", task_name: "Inactive task", created: 20 }),
      session({ id: "unacknowledged", task_name: "Unacknowledged task", created: 5, ended_at: 100, exit_code: 143 }),
    ];
    const exited = (code: number): SessionObservation => ({
      lifecycle: { state: "exited", code },
      state: null,
      checkpoint: {},
    });
    observations = {
      "/r:a-task:acknowledged": exited(143),
      "/r:a-task:unacknowledged": exited(143),
    };

    const { container } = render(<SessionsList allRepos={false} activeRepo="/r" onOpen={() => {}} registerNav={() => {}} onCreateSession={() => {}} onCreateTask={() => {}} />);

    await waitFor(() => {
      expect(renderedNames(container)).toEqual(["Unacknowledged task", "Inactive task", "Acknowledged task"]);
    });
    const unacknowledgedRow = screen.getByText("Unacknowledged task").closest(".row") as HTMLElement;
    const acknowledgedRow = screen.getByText("Acknowledged task").closest(".row") as HTMLElement;
    expect(within(unacknowledgedRow).getByRole("img", { name: "Failed: process exited with code 143" })).toBeDefined();
    expect(within(acknowledgedRow).queryByRole("img", { name: /Failed/ })).toBeNull();
    expect(within(acknowledgedRow).getByText("Exited")).toBeDefined();
  });

  it("keeps selection on the same session through a live reorder and navigates rendered order", async () => {
    vi.useFakeTimers();
    sessionItems = [session({ id: "selected-newer", task_name: "Selected task", created: 20 }), session({ id: "active-older", task_name: "Active task", created: 10 })];
    mocks.sessionListStatuses.mockReset().mockResolvedValueOnce({}).mockResolvedValue({ "/r:a-task:active-older": busyObservation });
    const { container } = render(
      <SessionsList
        allRepos={false}
        activeRepo="/r"
        onOpen={() => {}}
        registerNav={(nav) => {
          currentNav = nav;
        }}
        onCreateSession={() => {}}
        onCreateTask={() => {}}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector(".row.sel .rtt")?.textContent).toBe("Selected task");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(renderedNames(container)).toEqual(["Active task", "Selected task"]);
    expect(container.querySelector(".row.sel .rtt")?.textContent).toBe("Selected task");

    await navReady(() => currentNav);
    act(() => requireNav(currentNav).moveRow(-1));
    expect(container.querySelector(".row.sel .rtt")?.textContent).toBe("Active task");
    vi.useRealTimers();
  });
});

describe("SessionsList time sorting and presentation", () => {
  it("sorts both time fields in both directions, includes archived rows, and restores Priority", async () => {
    sessionItems = [
      session({ id: "missing", task_name: "Untimed task", created: 0, started_at: null, status_changed_at: null }),
      session({ id: "newer", task_name: "Newer task", created: 20, started_at: 200, status_changed_at: 400 }),
      session({ id: "older-busy", task_name: "Busy task", created: 10, started_at: 100, status_changed_at: 300 }),
      session({ id: "archived", task_name: "Archived task", created: 40, archived: true, started_at: 300, status_changed_at: 500 }),
    ];
    observations = { "/r:a-task:older-busy": busyObservation };
    const { container } = render(<SessionsList allRepos={false} activeRepo="/r" onOpen={() => {}} registerNav={() => {}} onCreateSession={() => {}} onCreateTask={() => {}} />);
    await waitFor(() => expect(renderedNames(container)).toEqual(["Busy task", "Newer task", "Untimed task", "Archived task"]));
    expect(screen.getByRole("button", { name: "Priority" }).getAttribute("aria-pressed")).toBe("true");

    const started = screen.getByRole("button", { name: /^Started:/ });
    fireEvent.click(started);
    expect(renderedNames(container)).toEqual(["Archived task", "Newer task", "Busy task", "Untimed task"]);
    expect(started.getAttribute("aria-label")).toContain("newest first");
    fireEvent.click(started);
    expect(renderedNames(container)).toEqual(["Busy task", "Newer task", "Archived task", "Untimed task"]);
    expect(started.getAttribute("aria-label")).toContain("oldest first");

    const updated = screen.getByRole("button", { name: /^Updated:/ });
    fireEvent.click(updated);
    expect(renderedNames(container)).toEqual(["Archived task", "Newer task", "Busy task", "Untimed task"]);
    fireEvent.click(updated);
    expect(renderedNames(container)).toEqual(["Busy task", "Newer task", "Archived task", "Untimed task"]);

    fireEvent.click(screen.getByRole("button", { name: "Priority" }));
    expect(renderedNames(container)).toEqual(["Busy task", "Newer task", "Untimed task", "Archived task"]);
  });

  it("accepts StaleSource failure-class transitions without leaving Updated sort", async () => {
    vi.useFakeTimers();
    sessionItems = [
      session({ id: "target", task_name: "Target task", created: 10, status_changed_at: 100 }),
      session({ id: "other", task_name: "Other task", created: 20, status_changed_at: 200 }),
    ];
    const targetKey = "/r:a-task:target";
    const failedObservation = (reason: string): SessionObservation => ({
      lifecycle: { state: "live" },
      state: {
        process: { state: "alive" },
        agent: { state: "idle" },
        playbook: { state: "failed", reason },
        adapter: "omp",
        message_adapter: "unsupported",
      },
      checkpoint: {},
    });
    let targetObservation = failedObservation("StaleSource");
    mocks.sessionListStatuses.mockImplementation(async () => ({ [targetKey]: targetObservation }));

    const { container } = render(<SessionsList allRepos={false} activeRepo="/r" onOpen={() => {}} registerNav={() => {}} onCreateSession={() => {}} onCreateTask={() => {}} />);
    await vi.waitFor(() => expect(renderedNames(container)).toEqual(["Other task", "Target task"]));
    expect(screen.getByText("Stale")).toBeDefined();

    targetObservation = failedObservation("boom");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    await vi.waitFor(() => expect(renderedNames(container)).toEqual(["Target task", "Other task"]));
    expect(screen.getByText("Failed")).toBeDefined();

    const updated = screen.getByRole("button", { name: /^Updated:/ });
    fireEvent.click(updated);
    expect(renderedNames(container)).toEqual(["Other task", "Target task"]);

    targetObservation = failedObservation("StaleSource");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    await vi.waitFor(() => expect(screen.getByText("Stale")).toBeDefined());
    expect(screen.queryByText("Failed")).toBeNull();
    expect(renderedNames(container)).toEqual(["Other task", "Target task"]);
    expect(updated.getAttribute("aria-pressed")).toBe("true");
    expect(updated.getAttribute("aria-label")).toContain("newest first");
  });

  it("keeps repository-qualified selection through an Updated metadata reorder and follows rendered keyboard order", async () => {
    vi.useFakeTimers();
    sessionItems = [
      session({ id: "selected", task_name: "Selected task", created: 20, status_changed_at: 100 }),
      session({ id: "other", task_name: "Other task", created: 10, status_changed_at: 200 }),
    ];
    const { container } = render(
      <SessionsList
        allRepos={false}
        activeRepo="/r"
        onOpen={() => {}}
        registerNav={(nav) => {
          currentNav = nav;
        }}
        onCreateSession={() => {}}
        onCreateTask={() => {}}
      />,
    );
    await vi.waitFor(() => expect(renderedNames(container)).toEqual(["Selected task", "Other task"]));
    fireEvent.click(screen.getByRole("button", { name: /^Updated:/ }));
    expect(renderedNames(container)).toEqual(["Other task", "Selected task"]);
    expect(container.querySelector(".row.sel .rtt")?.textContent).toBe("Selected task");

    sessionItems = [{ ...sessionItems[0], status_changed_at: 300 }, sessionItems[1]];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await vi.waitFor(() => expect(renderedNames(container)).toEqual(["Selected task", "Other task"]));
    expect(container.querySelector(".row.sel .rtt")?.textContent).toBe("Selected task");
    expect(screen.getByRole("button", { name: /^Updated:/ }).getAttribute("aria-label")).toContain("newest first");

    await navReady(() => currentNav);
    act(() => requireNav(currentNav).moveRow(1));
    expect(container.querySelector(".row.sel .rtt")?.textContent).toBe("Other task");
  });

  it("keeps both exact timestamp descriptions in the meta band and advances them from one surface clock", async () => {
    vi.useFakeTimers();
    const now = 1_700_000_120;
    vi.setSystemTime(now * 1000);
    sessionItems = [
      session({ id: "timed", task_name: "Timed task", created: 2, started_at: now - 60, status_changed_at: now - 3600 }),
      session({ id: "also-timed", task_name: "Other task", created: 1, started_at: now - 120, status_changed_at: now - 7200 }),
    ];
    const { container } = render(<SessionsList allRepos={false} activeRepo="/r" onOpen={() => {}} registerNav={() => {}} onCreateSession={() => {}} onCreateTask={() => {}} />);
    await vi.waitFor(() => expect(renderedNames(container)).toEqual(["Timed task", "Other task"]));
    const row = screen.getByText("Timed task").closest(".row") as HTMLElement;
    const meta = row.querySelector(".meta") as HTMLElement;
    const times = [...meta.querySelectorAll("time")];
    expect(times[0].textContent).toContain("1m");
    expect(times[0].getAttribute("title")).toContain(`Started ${new Date((now - 60) * 1000).toLocaleString()}`);
    expect(times[1].getAttribute("title")).toContain(`Status changed ${new Date((now - 3600) * 1000).toLocaleString()}`);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(times[0].textContent).toContain("2m");
  });
});

describe("session work names", () => {
  it("rename_keeps_repo_qualified_selection_and_ignores_stale_item_reads", async () => {
    vi.useFakeTimers();
    const original = session({ name: "Original name", subtask_manager: true, subtask_slug: "child", subtask_name: "Current child" });
    const foreign = session({ repo_path: "/other", name: "Foreign name" });
    sessionItems = [original, foreign];
    const onOpen = vi.fn();
    const { container } = render(<SessionsList allRepos activeRepo="/r" onOpen={onOpen} registerNav={() => {}} onCreateSession={() => {}} onCreateTask={() => {}} />);
    await act(async () => {});
    expect(screen.getByText("Original name")).toBeDefined();
    expect(screen.getByText("Current child")).toBeDefined();
    const oldRead = deferred<SessionListItem[]>();
    mocks.listSessionItems.mockReturnValueOnce(oldRead.promise);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    const row = screen.getByText("Original name").closest(".row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Rename session" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), { target: { value: "Committed name" } });
    sessionItems = [{ ...original, name: "Committed name", name_source: "user" }, foreign];
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Session name" }), { key: "Enter" });
    await act(async () => {});
    expect(mocks.renameSession).toHaveBeenCalledWith({ repoPath: "/r", taskSlug: "a-task", sessionId: "s1", name: "Committed name" });
    expect(onOpen).not.toHaveBeenCalled();
    await act(async () => {
      oldRead.resolve([original, foreign]);
    });
    expect(container.querySelector(".row.sel .rtt")?.textContent).toBe("Committed name");
    expect(screen.getByText("Foreign name")).toBeDefined();
    sessionItems = [{ ...original, name: "External name" }, foreign];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByText("External name")).toBeDefined();
    fireEvent.click(screen.getByText("Foreign name"));
    expect(onOpen).toHaveBeenLastCalledWith(foreign);
  });

  it("keeps an archived session editable and retains its draft after a failed save", async () => {
    const archived = session({ name: "Retained work", archived: true });
    sessionItems = [archived];
    mocks.renameSession.mockRejectedValueOnce(new Error("Naming file is busy"));
    const onOpen = vi.fn();
    render(<SessionsList allRepos={false} activeRepo="/r" onOpen={onOpen} registerNav={() => {}} onCreateSession={() => {}} onCreateTask={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename session" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), { target: { value: "Committed name" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Session name" }), { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Naming file is busy");
    expect(screen.getByText("Retained work")).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Session name" })).toHaveProperty("value", "Committed name");
    sessionItems = [{ ...archived, name: "Committed name" }];
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Committed name");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("ignores previous repo save failures without closing the current editor", async () => {
    const original = session({ name: "Repo A work" });
    const other = session({ repo_path: "/other", name: "Repo B work" });
    sessionItems = [original, other];
    const props = { allRepos: false, onOpen: vi.fn(), registerNav: vi.fn(), onCreateSession: vi.fn(), onCreateTask: vi.fn() };
    const { rerender } = render(<SessionsList {...props} activeRepo="/r" />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename session" }));
    const pendingSave = deferred<never>();
    mocks.renameSession.mockReturnValueOnce(pendingSave.promise);
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), { target: { value: "Late A work" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Session name" }), { key: "Enter" });
    rerender(<SessionsList {...props} activeRepo="/other" />);
    await screen.findByText("Repo B work");
    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), { target: { value: "B draft" } });
    await act(async () => {
      pendingSave.reject(new Error("Old repo error"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Session name" })).toHaveProperty("value", "B draft");
    expect(screen.queryByText("Repo A work")).toBeNull();
  });

  it("does not apply an old repo read error or finalizer to a pending new repo read", async () => {
    const oldRead = deferred<SessionListItem[]>();
    const newRead = deferred<SessionListItem[]>();
    mocks.listSessionItems.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const props = { allRepos: false, onOpen: vi.fn(), registerNav: vi.fn(), onCreateSession: vi.fn(), onCreateTask: vi.fn() };
    const { rerender } = render(<SessionsList {...props} activeRepo="/r" />);
    rerender(<SessionsList {...props} activeRepo="/other" />);
    await act(async () => {
      oldRead.reject(new Error("Old repo offline"));
    });
    expect(screen.queryByText("Could not load sessions.")).toBeNull();
    expect(screen.queryByText("No sessions yet.")).toBeNull();
    await act(async () => {
      newRead.resolve([session({ repo_path: "/other", name: "Current repo work" })]);
    });
    expect(screen.getByText("Current repo work")).toBeDefined();
  });

  it("keeps another row draft and focus when a previous row save commits", async () => {
    const first = session({ id: "first", name: "First work" });
    const second = session({ id: "second", name: "Second work" });
    sessionItems = [first, second];
    const pending = deferred<{ name: string; source: "user" }>();
    mocks.renameSession.mockReturnValueOnce(pending.promise);
    render(<SessionsList allRepos={false} activeRepo="/r" onOpen={vi.fn()} registerNav={vi.fn()} onCreateSession={vi.fn()} onCreateTask={vi.fn()} />);
    const firstRow = (await screen.findByText("First work")).closest(".row") as HTMLElement;
    const secondRow = screen.getByText("Second work").closest(".row") as HTMLElement;
    fireEvent.click(within(firstRow).getByRole("button", { name: "Rename session" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), { target: { value: "Committed first" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(within(secondRow).getByRole("button", { name: "Rename session" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), { target: { value: "Unsubmitted second draft" } });
    sessionItems = [{ ...first, name: "Committed first" }, second];
    await act(async () => {
      pending.resolve({ name: "Committed first", source: "user" });
    });
    expect(screen.getByText("Committed first")).toBeDefined();
    expect(within(secondRow).getByRole("textbox", { name: "Session name" })).toHaveProperty("value", "Unsubmitted second draft");
    expect(document.activeElement).toBe(within(secondRow).getByRole("textbox", { name: "Session name" }));
    expect(mocks.renameSession).toHaveBeenCalledTimes(1);
  });
});
