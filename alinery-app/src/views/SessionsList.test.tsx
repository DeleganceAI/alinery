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
}));

vi.mock("../ipc", () =>
  mockIpc({
    listSessionItems: mocks.listSessionItems,
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
  mocks.listSessionItems.mockReset().mockImplementation(async () => sessionItems);
  mocks.sessionListStatuses.mockReset().mockImplementation(async () => observations);
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

describe("SessionsList attention order", () => {
  it("renders an older running session above a newer settled row without changing backend order", async () => {
    sessionItems = [
      session({
        id: "newer-tdd",
        created: 20,
        phase: "tdd",
        step_title: "TDD",
        semantic: { phase_completed_at: 20 },
        notification_read_at: 20,
      }),
      session({ id: "older-design", created: 10 }),
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
      const ids = [...container.querySelectorAll(".list > .row .rts")].map((node) => node.textContent?.split(" · ")[0]);
      expect(ids).toEqual(["older-design", "newer-tdd"]);
    });
    expect(sessionItems.map((row) => row.id)).toEqual(originalIds);
    expect(mocks.sessionListStatuses).toHaveBeenCalledTimes(1);
  });

  it("keeps only an unacknowledged exit in the failure attention tier", async () => {
    sessionItems = [
      session({ id: "acknowledged", created: 10, ended_at: 90, exit_code: 143, exit_notification_read_at: 90 }),
      session({ id: "inactive", created: 20 }),
      session({ id: "unacknowledged", created: 5, ended_at: 100, exit_code: 143 }),
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
      const ids = [...container.querySelectorAll(".list > .row .rts")].map((node) => node.textContent?.split(" · ")[0]);
      expect(ids).toEqual(["unacknowledged", "inactive", "acknowledged"]);
    });
    const sessionRows = [...container.querySelectorAll<HTMLElement>(".list > .row")];
    const unacknowledgedRow = sessionRows.find((row) => row.querySelector(".rts")?.textContent?.startsWith("unacknowledged")) as HTMLElement;
    const acknowledgedRow = sessionRows.find((row) => row.querySelector(".rts")?.textContent?.startsWith("acknowledged")) as HTMLElement;
    expect(within(unacknowledgedRow).getByRole("img", { name: "Failed: process exited with code 143" })).toBeDefined();
    expect(within(acknowledgedRow).queryByRole("img", { name: /Failed/ })).toBeNull();
    expect(within(acknowledgedRow).getByText("Exited")).toBeDefined();
  });

  it("keeps selection on the same session through a live reorder and navigates rendered order", async () => {
    vi.useFakeTimers();
    sessionItems = [session({ id: "selected-newer", created: 20 }), session({ id: "active-older", created: 10 })];
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
    expect(container.querySelector(".row.sel .rts")?.textContent).toContain("selected-newer");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect([...container.querySelectorAll(".list > .row .rts")].map((node) => node.textContent?.split(" · ")[0])).toEqual(["active-older", "selected-newer"]);
    expect(container.querySelector(".row.sel .rts")?.textContent).toContain("selected-newer");

    await navReady(() => currentNav);
    act(() => requireNav(currentNav).moveRow(-1));
    expect(container.querySelector(".row.sel .rts")?.textContent).toContain("active-older");
    vi.useRealTimers();
  });
});

describe("SessionsList time sorting and presentation", () => {
  const renderedIds = (container: HTMLElement) => [...container.querySelectorAll(".list > .row .rts")].map((node) => node.textContent?.split(" · ")[0]);

  it("sorts both time fields in both directions, includes archived rows, and restores Priority", async () => {
    sessionItems = [
      session({ id: "missing", created: 0, started_at: null, status_changed_at: null }),
      session({ id: "newer", created: 20, started_at: 200, status_changed_at: 400 }),
      session({ id: "older-busy", created: 10, started_at: 100, status_changed_at: 300 }),
      session({ id: "archived", created: 40, archived: true, started_at: 300, status_changed_at: 500 }),
    ];
    observations = { "/r:a-task:older-busy": busyObservation };
    const { container } = render(<SessionsList allRepos={false} activeRepo="/r" onOpen={() => {}} registerNav={() => {}} onCreateSession={() => {}} onCreateTask={() => {}} />);
    await waitFor(() => expect(renderedIds(container)).toEqual(["older-busy", "newer", "missing", "archived"]));
    expect(screen.getByRole("button", { name: "Priority" }).getAttribute("aria-pressed")).toBe("true");

    const started = screen.getByRole("button", { name: /^Started:/ });
    fireEvent.click(started);
    expect(renderedIds(container)).toEqual(["archived", "newer", "older-busy", "missing"]);
    expect(started.getAttribute("aria-label")).toContain("newest first");
    fireEvent.click(started);
    expect(renderedIds(container)).toEqual(["older-busy", "newer", "archived", "missing"]);
    expect(started.getAttribute("aria-label")).toContain("oldest first");

    const updated = screen.getByRole("button", { name: /^Updated:/ });
    fireEvent.click(updated);
    expect(renderedIds(container)).toEqual(["archived", "newer", "older-busy", "missing"]);
    fireEvent.click(updated);
    expect(renderedIds(container)).toEqual(["older-busy", "newer", "archived", "missing"]);

    fireEvent.click(screen.getByRole("button", { name: "Priority" }));
    expect(renderedIds(container)).toEqual(["older-busy", "newer", "missing", "archived"]);
  });

  it("accepts StaleSource failure-class transitions without leaving Updated sort", async () => {
    vi.useFakeTimers();
    sessionItems = [session({ id: "target", created: 10, status_changed_at: 100 }), session({ id: "other", created: 20, status_changed_at: 200 })];
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
    await vi.waitFor(() => expect(renderedIds(container)).toEqual(["other", "target"]));
    expect(screen.getByText("Stale")).toBeDefined();

    targetObservation = failedObservation("boom");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    await vi.waitFor(() => expect(renderedIds(container)).toEqual(["target", "other"]));
    expect(screen.getByText("Failed")).toBeDefined();

    const updated = screen.getByRole("button", { name: /^Updated:/ });
    fireEvent.click(updated);
    expect(renderedIds(container)).toEqual(["other", "target"]);

    targetObservation = failedObservation("StaleSource");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    await vi.waitFor(() => expect(screen.getByText("Stale")).toBeDefined());
    expect(screen.queryByText("Failed")).toBeNull();
    expect(renderedIds(container)).toEqual(["other", "target"]);
    expect(updated.getAttribute("aria-pressed")).toBe("true");
    expect(updated.getAttribute("aria-label")).toContain("newest first");
  });

  it("keeps repository-qualified selection through an Updated metadata reorder and follows rendered keyboard order", async () => {
    vi.useFakeTimers();
    sessionItems = [session({ id: "selected", created: 20, status_changed_at: 100 }), session({ id: "other", created: 10, status_changed_at: 200 })];
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
    await vi.waitFor(() => expect(renderedIds(container)).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /^Updated:/ }));
    expect(renderedIds(container)).toEqual(["other", "selected"]);
    expect(container.querySelector(".row.sel .rts")?.textContent).toContain("selected");

    sessionItems = [{ ...sessionItems[0], status_changed_at: 300 }, sessionItems[1]];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await vi.waitFor(() => expect(renderedIds(container)).toEqual(["selected", "other"]));
    expect(container.querySelector(".row.sel .rts")?.textContent).toContain("selected");
    expect(screen.getByRole("button", { name: /^Updated:/ }).getAttribute("aria-label")).toContain("newest first");

    await navReady(() => currentNav);
    act(() => requireNav(currentNav).moveRow(1));
    expect(container.querySelector(".row.sel .rts")?.textContent).toContain("other");
  });

  it("keeps both exact timestamp descriptions in the meta band and advances them from one surface clock", async () => {
    vi.useFakeTimers();
    const now = 1_700_000_120;
    vi.setSystemTime(now * 1000);
    sessionItems = [
      session({ id: "timed", created: 2, started_at: now - 60, status_changed_at: now - 3600 }),
      session({ id: "also-timed", created: 1, started_at: now - 120, status_changed_at: now - 7200 }),
    ];
    const { container } = render(<SessionsList allRepos={false} activeRepo="/r" onOpen={() => {}} registerNav={() => {}} onCreateSession={() => {}} onCreateTask={() => {}} />);
    await vi.waitFor(() => expect(renderedIds(container)).toEqual(["timed", "also-timed"]));
    const row = [...container.querySelectorAll<HTMLElement>(".list > .row")].find((candidate) => candidate.querySelector(".rts")?.textContent?.startsWith("timed")) as HTMLElement;
    const meta = row.querySelector(".meta") as HTMLElement;
    expect(row.querySelectorAll(".rt > div")).toHaveLength(3);
    expect(meta.querySelectorAll(".session-time")).toHaveLength(2);
    const times = [...meta.querySelectorAll("time")];
    expect(times[0].textContent).toContain("1m");
    expect(times[0].getAttribute("title")).toContain(`Started ${new Date((now - 60) * 1000).toLocaleString()}`);
    expect(times[1].getAttribute("title")).toContain(`Status changed ${new Date((now - 3600) * 1000).toLocaleString()}`);
    expect(vi.getTimerCount()).toBe(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(times[0].textContent).toContain("2m");
  });
});
