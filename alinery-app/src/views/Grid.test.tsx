import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navReady, requireNav } from "../test/nav";
import type { BoardNav, BoardTask, KanbanColumn, PlaybookStepSummary, PullRequestSnapshot, TaskActivityMap, TaskActivityRef } from "../types";
import { Grid } from "./Grid";

const now = Math.floor(Date.now() / 1000);
const makeTask = (over: Partial<BoardTask>): BoardTask =>
  ({
    name: "A task",
    slug: "a-task",
    requested_slug: "a-task",
    branch: "a-task",
    worktree: "/worktrees/a-task",
    has_worktree: true,
    created: now - 86400,
    archived: false,
    pr_url: "",
    linear_id: "",
    github_issue: "",
    playbook: "superdevelop",
    auto_advance: [],
    draft: false,
    repo_path: "/repo-a",
    session_count: 2,
    playbook_title: "SuperDevelop",
    updated: now - 3600,
    current_phase: "implementation",
    current_step_title: "Implementation",
    latest_session_title: "Implementation",
    latest_session_column_key: "implementation",
    current_column_key: "implementation",
    current_column_title: "Implementation",
    ...over,
  }) as BoardTask;

const tasks = [
  makeTask({ name: "Build API", slug: "build-api" }),
  makeTask({
    name: "Review queue",
    slug: "review-queue",
    repo_path: "/repo-b",
    playbook: "review",
    playbook_title: "Review",
    current_phase: "findings",
    current_step_title: "Findings",
    latest_session_title: "Findings",
    current_column_key: "review",
    current_column_title: "Review",
  }),
  makeTask({
    name: "Release app",
    slug: "release-app",
    playbook: "one-shot",
    playbook_title: "One-shot",
    current_phase: "pr",
    current_step_title: "PR",
    latest_session_title: "PR",
    current_column_key: "review",
    current_column_title: "Review",
  }),
];

const columns: KanbanColumn[] = [
  { key: "research-design", title: "Research & Design" },
  { key: "implementation", title: "Implementation" },
  { key: "review", title: "Review" },
];
const step = (key: string, title: string, column: string): PlaybookStepSummary => ({ key, title, short: title, artifact: "", column, harness: "claude" });
const playbookSteps: Record<string, PlaybookStepSummary[]> = {
  superdevelop: [step("research", "Research", "research-design"), step("design", "Design", "research-design"), step("implementation", "Implementation", "implementation")],
  review: [step("context", "Context", "review"), step("findings", "Findings", "review")],
  "one-shot": [step("queued", "Queued", "research-design"), step("implementation", "Implementation", "implementation"), step("pr", "PR", "review")],
};

const ipcMock = vi.hoisted(() => ({
  listBoardTasks: vi.fn(async (_allRepos: boolean): Promise<BoardTask[]> => []),
  listKanbanColumns: vi.fn(async (_allRepos: boolean): Promise<KanbanColumn[]> => []),
  listPlaybookStepsForRepo: vi.fn(async (_repoPath: string, _playbook: string): Promise<PlaybookStepSummary[]> => []),
  listTaskActivity: vi.fn(async (_refs: TaskActivityRef[]): Promise<TaskActivityMap> => ({})),
  listTaskPullRequests: vi.fn(async (_tasks: TaskActivityRef[]): Promise<Record<string, PullRequestSnapshot>> => ({})),
  openUrl: vi.fn(async (_url: string): Promise<void> => {}),
  archiveTaskForRepo: vi.fn(async (_repoPath: string, _slug: string): Promise<void> => {}),
  removeWorktreeForRepo: vi.fn(async (_repoPath: string, _slug: string): Promise<void> => {}),
}));
vi.mock("../ipc", () => ipcMock);
vi.mock("../WindowChrome", () => ({ WindowControls: () => null }));

const storedGridWorkspaces = new Map<string, string>();
const localStorageMock: Storage = {
  get length() {
    return storedGridWorkspaces.size;
  },
  clear: () => storedGridWorkspaces.clear(),
  getItem: (key) => storedGridWorkspaces.get(key) ?? null,
  key: (index) => [...storedGridWorkspaces.keys()][index] ?? null,
  removeItem: (key) => storedGridWorkspaces.delete(key),
  setItem: (key, value) => storedGridWorkspaces.set(key, value),
};
Object.defineProperty(window, "localStorage", { configurable: true, value: localStorageMock });

beforeEach(() => {
  window.localStorage.clear();
  ipcMock.listBoardTasks.mockResolvedValue(tasks);
  ipcMock.listKanbanColumns.mockResolvedValue(columns);
  ipcMock.listPlaybookStepsForRepo.mockImplementation(async (_repoPath: string, playbook: string) => playbookSteps[playbook] ?? []);
  ipcMock.listTaskPullRequests.mockImplementation(async (refs) => Object.fromEntries(refs.map((ref) => [`${ref.repoPath}:${ref.taskSlug}`, { pr: null, error: null }])));
  ipcMock.listTaskActivity.mockResolvedValue({
    "/repo-a:build-api": { status: "running", active_session: null },
    "/repo-b:review-queue": { status: "waiting_for_approval", active_session: null },
    "/repo-a:release-app": { status: null, active_session: null },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("configurable task grid", () => {
  it("renders every preset through the same real task projection", async () => {
    const { container } = render(<Grid allRepos onOpen={() => {}} registerNav={() => {}} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ })).toBeDefined());
    expect(ipcMock.listBoardTasks).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    const preset = screen.getByLabelText("Preset");
    for (const value of ["kanban", "steps", "quadrants", "atlas", "age", "progress"]) {
      fireEvent.change(preset, { target: { value } });
      expect(container.querySelectorAll(".task-grid-group").length).toBeGreaterThan(0);
      expect(container.querySelector(".task-grid-groups")?.getAttribute("data-position")).toBe(value === "progress" ? "lanes" : "packed");
    }
  });
  it("assigns distinct palette slots to the first six repositories", async () => {
    ipcMock.listBoardTasks.mockResolvedValue(
      ["a", "b", "c", "d", "e", "f"].map((suffix) =>
        makeTask({
          name: `Repo ${suffix.toUpperCase()} task`,
          slug: `task-${suffix}`,
          repo_path: `/repo-${suffix}`,
        }),
      ),
    );
    render(<Grid allRepos onOpen={() => {}} registerNav={() => {}} />);

    await screen.findByRole("button", { name: /Repo A task, repo-a/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    const borderLegend = screen.getByText("BORDER · Repository").closest(".task-grid-legend-row");
    const colors = [...(borderLegend?.querySelectorAll<HTMLElement>(".task-grid-legend-swatch") ?? [])].map((swatch) => swatch.style.getPropertyValue("--task-grid-key-color"));

    expect(colors).toEqual([
      "var(--task-grid-border-0)",
      "var(--task-grid-border-1)",
      "var(--task-grid-border-2)",
      "var(--task-grid-border-3)",
      "var(--task-grid-border-4)",
      "var(--task-grid-border-5)",
    ]);
    expect(new Set(colors).size).toBe(6);
  });

  it("sorts by exact task creation time in both directions", async () => {
    ipcMock.listBoardTasks.mockResolvedValue([
      { ...tasks[0], created: now - 300 },
      { ...tasks[1], created: now - 200 },
      { ...tasks[2], created: now - 100 },
    ]);
    const { container } = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} />);

    await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "none" } });
    const sort = screen.getByLabelText("Sort by") as HTMLSelectElement;

    expect([...sort.options].map((option) => option.text)).toEqual(expect.arrayContaining(["Created at (asc)", "Created at (desc)"]));
    fireEvent.change(sort, { target: { value: "createdAtAsc" } });
    expect([...container.querySelectorAll(".task-grid-card")].map((card) => card.getAttribute("data-task-id"))).toEqual([
      "/repo-a:build-api",
      "/repo-b:review-queue",
      "/repo-a:release-app",
    ]);

    fireEvent.change(sort, { target: { value: "createdDays" } });
    expect([...container.querySelectorAll(".task-grid-card")].map((card) => card.getAttribute("data-task-id"))).toEqual([
      "/repo-a:release-app",
      "/repo-b:review-queue",
      "/repo-a:build-api",
    ]);
  });

  it("shows live session activity and sizes columns in card units", async () => {
    const { container } = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} />);

    const apiCard = await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));

    expect(within(apiCard).queryByRole("img", { name: "Running" })).toBeNull();
    fireEvent.click(screen.getByLabelText("session activity"));
    await waitFor(() => expect(within(apiCard).getByRole("img", { name: "Running" })).toBeDefined());

    const cardsPerColumn = screen.getByLabelText("Cards per column") as HTMLSelectElement;
    expect(cardsPerColumn.value).toBe("2");
    fireEvent.change(cardsPerColumn, { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/Tile width/), { target: { value: "96" } });
    const grid = container.querySelector(".task-grid-view") as HTMLElement;
    expect(grid.style.getPropertyValue("--task-grid-column-cards")).toBe("1");
    expect(grid.style.getPropertyValue("--task-grid-tile-w")).toBe("96px");
    expect(grid.style.getPropertyValue("--task-grid-group-width")).toBe("114px");

    fireEvent.change(screen.getByLabelText("Column flow"), { target: { value: "scroll" } });
    expect(container.querySelector(".task-grid-groups")?.getAttribute("data-column-flow")).toBe("scroll");

    fireEvent.click(screen.getByRole("button", { name: "Hide Implementation column" }));
    expect(screen.getByRole("button", { name: "Expand Implementation column" })).toBeDefined();
    expect(container.querySelector('.task-grid-card[data-task-id="/repo-a:build-api"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand Implementation column" }));
    expect(container.querySelector('.task-grid-card[data-task-id="/repo-a:build-api"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close grid settings" }));
    expect(grid.style.getPropertyValue("--task-grid-group-width")).toBe("114px");
  });

  it("persists the optional PR property and opens its link independently in every card mode", async () => {
    const task = makeTask({ name: "PR task", slug: "grid-pr", repo_path: "/grid-pr" });
    const url = "https://github.com/example/project/pull/42";
    ipcMock.listBoardTasks.mockResolvedValue([task]);
    ipcMock.listTaskPullRequests.mockResolvedValue({ "/grid-pr:grid-pr": { pr: { number: 42, url, state: "open" }, error: null } });
    const onOpen = vi.fn();
    const first = render(<Grid allRepos={false} onOpen={onOpen} registerNav={() => {}} storageKey="pr-property" />);
    const card = await screen.findByRole("button", { name: /PR task, grid-pr/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    expect(ipcMock.listTaskPullRequests).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("pull request"));
    await screen.findByRole("link", { name: /PR #42.*Open/ });
    for (const mode of ["detail", "compact", "icon"]) {
      fireEvent.change(screen.getByLabelText("Card mode"), { target: { value: mode } });
      const link = within(card).getByRole("link", { name: /PR #42.*Open/ });
      fireEvent.click(link);
      fireEvent.keyDown(link, { key: "Enter" });
    }
    expect(ipcMock.openUrl).toHaveBeenCalledTimes(6);
    expect(ipcMock.openUrl).toHaveBeenLastCalledWith(url);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: " " });
    expect(onOpen.mock.calls).toEqual([[task], [task]]);
    fireEvent.click(screen.getByRole("button", { name: "Hide Implementation column" }));
    expect(screen.queryByRole("link", { name: /PR #42/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Position model"), { target: { value: "lanes" } });
    expect(screen.getByRole("link", { name: /PR #42.*Open/ })).toBeDefined();
    first.unmount();

    render(<Grid allRepos={false} onOpen={onOpen} registerNav={() => {}} storageKey="pr-property" />);
    expect((screen.getByLabelText("pull request") as HTMLInputElement).checked).toBe(true);
    await screen.findByRole("link", { name: /PR #42.*Open/ });
    expect(ipcMock.listTaskPullRequests).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("pull request"));
    expect(screen.queryByRole("link", { name: /PR #42/ })).toBeNull();
  });

  it("pauses PR refreshes for inactive grids and when the property is disabled", async () => {
    ipcMock.listBoardTasks.mockResolvedValue([makeTask({ slug: "pr-poll", repo_path: "/grid-pr-poll" })]);
    const props = { allRepos: false, onOpen: () => {}, registerNav: () => {} };
    const view = render(<Grid {...props} />);
    await screen.findByRole("button", { name: /A task, grid-pr-poll/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    view.rerender(<Grid {...props} active={false} />);
    fireEvent.click(screen.getByLabelText("pull request"));
    await act(async () => {});
    expect(ipcMock.listTaskPullRequests).not.toHaveBeenCalled();
    view.rerender(<Grid {...props} active />);
    await waitFor(() => expect(ipcMock.listTaskPullRequests).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    view.rerender(<Grid {...props} active={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(ipcMock.listTaskPullRequests).toHaveBeenCalledTimes(1);
    view.rerender(<Grid {...props} active />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(ipcMock.listTaskPullRequests).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByLabelText("pull request"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(ipcMock.listTaskPullRequests).toHaveBeenCalledTimes(2);
  });

  it("persists exact-width scrolling columns and collapsed group rails", async () => {
    const first = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="repo-columns" />);

    await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Cards per column"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/Tile width/), { target: { value: "96" } });
    fireEvent.change(screen.getByLabelText("Column flow"), { target: { value: "scroll" } });
    fireEvent.click(screen.getByRole("button", { name: "Hide Implementation column" }));
    expect(screen.getByRole("button", { name: "Expand Implementation column" })).toBeDefined();
    first.unmount();

    const second = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="repo-columns" />);
    await screen.findByRole("button", { name: "Expand Implementation column" });
    expect((screen.getByLabelText("Cards per column") as HTMLSelectElement).value).toBe("1");
    expect((screen.getByLabelText(/Tile width/) as HTMLInputElement).value).toBe("96");
    expect((screen.getByLabelText("Column flow") as HTMLSelectElement).value).toBe("scroll");
    expect(second.container.querySelector(".task-grid-groups")?.getAttribute("data-column-flow")).toBe("scroll");

    fireEvent.click(screen.getByRole("button", { name: "Expand Implementation column" }));
    expect(await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ })).toBeDefined();
  });

  it("stops every poll while inactive and refreshes immediately on reactivation", async () => {
    vi.useFakeTimers();
    const registerNav = vi.fn();
    const onOpen = vi.fn();
    const grid = render(<Grid active={false} allRepos={false} onOpen={onOpen} registerNav={registerNav} />);

    await act(async () => {});
    expect(ipcMock.listBoardTasks).not.toHaveBeenCalled();
    expect(ipcMock.listKanbanColumns).not.toHaveBeenCalled();
    expect(ipcMock.listPlaybookStepsForRepo).not.toHaveBeenCalled();
    expect(ipcMock.listTaskActivity).not.toHaveBeenCalled();
    expect(registerNav).not.toHaveBeenCalled();

    await act(async () => {
      grid.rerender(<Grid active allRepos={false} onOpen={onOpen} registerNav={registerNav} />);
    });
    expect(ipcMock.listBoardTasks).toHaveBeenCalledTimes(1);
    expect(ipcMock.listKanbanColumns).toHaveBeenCalledTimes(1);
    expect(ipcMock.listPlaybookStepsForRepo).toHaveBeenCalledTimes(3);
    expect(ipcMock.listTaskActivity).toHaveBeenCalledTimes(1);
    expect(registerNav.mock.lastCall?.[0]).not.toBeNull();

    grid.rerender(<Grid active={false} allRepos={false} onOpen={onOpen} registerNav={registerNav} />);
    const calls = {
      tasks: ipcMock.listBoardTasks.mock.calls.length,
      columns: ipcMock.listKanbanColumns.mock.calls.length,
      playbooks: ipcMock.listPlaybookStepsForRepo.mock.calls.length,
      activity: ipcMock.listTaskActivity.mock.calls.length,
    };
    await act(async () => {
      vi.advanceTimersByTime(9000);
    });
    expect(ipcMock.listBoardTasks).toHaveBeenCalledTimes(calls.tasks);
    expect(ipcMock.listKanbanColumns).toHaveBeenCalledTimes(calls.columns);
    expect(ipcMock.listPlaybookStepsForRepo).toHaveBeenCalledTimes(calls.playbooks);
    expect(ipcMock.listTaskActivity).toHaveBeenCalledTimes(calls.activity);
    expect(registerNav.mock.lastCall?.[0]).toBeNull();

    await act(async () => {
      grid.rerender(<Grid active allRepos={false} onOpen={onOpen} registerNav={registerNav} />);
    });
    expect(ipcMock.listBoardTasks).toHaveBeenCalledTimes(calls.tasks + 1);
    expect(ipcMock.listKanbanColumns).toHaveBeenCalledTimes(calls.columns + 1);
    expect(ipcMock.listPlaybookStepsForRepo).toHaveBeenCalledTimes(calls.playbooks + 3);
    expect(ipcMock.listTaskActivity).toHaveBeenCalledTimes(calls.activity + 1);
  });
  it("retries failed playbook definitions without discarding successful paths", async () => {
    vi.useFakeTimers();
    ipcMock.listBoardTasks.mockResolvedValue([tasks[0]]);
    let attempts = 0;
    ipcMock.listPlaybookStepsForRepo.mockImplementation(async (_repoPath: string, playbook: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary playbook read failure");
      return playbookSteps[playbook] ?? [];
    });

    render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "progress" } });

    expect(screen.getByRole("alert").textContent).toContain("temporary playbook read failure");
    expect(screen.getByLabelText("Build API playbook path, 1 steps")).toBeDefined();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Build API playbook path, 3 steps")).toBeDefined();
    expect(ipcMock.listBoardTasks).toHaveBeenCalledTimes(2);
  });

  it("archives the selected repository explicitly with or without worktree removal", async () => {
    const sameSlugTasks = [
      makeTask({ name: "Repo A task", slug: "shared-slug", repo_path: "/repo-a" }),
      makeTask({ name: "Repo B task", slug: "shared-slug", repo_path: "/repo-b" }),
    ];
    ipcMock.listBoardTasks.mockResolvedValue(sameSlugTasks);
    let boardNav: BoardNav | null = null;
    render(<Grid allRepos onOpen={() => {}} registerNav={(nav) => (boardNav = nav)} />);

    const repoBCard = await screen.findByRole("button", { name: /Repo B task, repo-b/ });
    fireEvent.focus(repoBCard);
    await act(async () => {});

    await navReady(() => boardNav);
    act(() => requireNav(boardNav).archiveSelected());
    fireEvent.click(screen.getByRole("button", { name: "Archive task" }));
    await waitFor(() => expect(ipcMock.archiveTaskForRepo).toHaveBeenCalledWith("/repo-b", "shared-slug"));
    expect(ipcMock.archiveTaskForRepo).toHaveBeenCalledTimes(1);
    expect(ipcMock.removeWorktreeForRepo).not.toHaveBeenCalled();

    act(() => requireNav(boardNav).archiveSelected());
    fireEvent.click(screen.getByLabelText("Also permanently remove the worktree (uncommitted changes are lost)"));
    fireEvent.click(screen.getByRole("button", { name: "Archive task" }));
    await waitFor(() => expect(ipcMock.removeWorktreeForRepo).toHaveBeenCalledWith("/repo-b", "shared-slug"));
    expect(ipcMock.archiveTaskForRepo).toHaveBeenCalledTimes(2);
    expect(ipcMock.removeWorktreeForRepo).toHaveBeenCalledTimes(1);
  });

  it("keeps row-local paths, focus state, lane priority, and compact settings state", async () => {
    const onOpen = vi.fn();
    let boardNav: BoardNav | null = null;
    const { container } = render(<Grid allRepos={false} onOpen={onOpen} registerNav={(nav) => (boardNav = nav)} />);

    const packedCard = await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ });
    fireEvent.click(packedCard);
    expect(onOpen).toHaveBeenCalledWith(tasks[0]);
    expect(boardNav).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "progress" } });

    await waitFor(() => {
      expect(screen.getByLabelText("Build API playbook path, 3 steps")).toBeDefined();
      expect(screen.getByLabelText("Review queue playbook path, 2 steps")).toBeDefined();
    });
    const apiPath = screen.getByLabelText("Build API playbook path, 3 steps");
    expect(within(apiPath).getByText("Research ✓")).toBeDefined();
    expect(within(apiPath).getByText("Design ✓")).toBeDefined();
    expect(within(screen.getByLabelText("Review queue playbook path, 2 steps")).getByText("Context ✓")).toBeDefined();
    expect(screen.queryByLabelText(/Previous position:/)).toBeNull();

    const apiCard = () => container.querySelector('.task-grid-card[data-task-id="/repo-a:build-api"]') as HTMLElement;
    await waitFor(() => expect(apiCard().style.gridColumn).toBe("3"));
    fireEvent.change(screen.getByLabelText("Forward direction"), { target: { value: "rtl" } });
    expect(apiCard().style.gridColumn).toBe("1");

    const firstColumn = screen.getByLabelText(/First column width/) as HTMLInputElement;
    fireEvent.change(firstColumn, { target: { value: "300" } });
    const apiRow = container.querySelector('.task-grid-lane-row[data-task-id="/repo-a:build-api"]') as HTMLElement;
    expect(apiRow.style.getPropertyValue("--task-grid-lane-label")).toBe("300px");

    fireEvent.click(screen.getByRole("button", { name: "Hide Review queue" }));
    const reviewRow = container.querySelector('.task-grid-lane-row[data-task-id="/repo-b:review-queue"]') as HTMLElement;
    expect(reviewRow.dataset.hidden).toBe("true");
    expect(reviewRow.querySelector(".task-grid-lane-track")?.children).toHaveLength(0);
    expect(reviewRow.querySelector(".task-grid-lane-label small")).toBeNull();
    expect(container.querySelector('.task-grid-card[data-task-id="/repo-b:review-queue"]')).toBeNull();

    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder Build API; use arrow keys" }), { key: "ArrowDown" });
    expect([...container.querySelectorAll(".task-grid-lane-name")].map((node) => node.textContent)).toEqual(["Release app", "Review queue", "Build API"]);
    expect((container.querySelectorAll(".task-grid-lane-row")[1] as HTMLElement).dataset.hidden).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Hide all" }));
    expect([...container.querySelectorAll(".task-grid-lane-row")].every((row) => (row as HTMLElement).dataset.hidden === "true")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Unhide all" }));
    expect([...container.querySelectorAll(".task-grid-lane-row")].every((row) => (row as HTMLElement).dataset.hidden === "false")).toBe(true);

    fireEvent.change(screen.getByLabelText("Border by"), { target: { value: "accent" } });
    expect(screen.getByText("BORDER · Accent color")).toBeDefined();
    expect(apiCard().style.getPropertyValue("--task-grid-border")).toBe("var(--accent)");
    const accentBorderLegend = screen.getByText("BORDER · Accent color").closest(".task-grid-legend-row");
    expect(accentBorderLegend?.querySelector<HTMLElement>(".task-grid-legend-swatch.border")?.style.getPropertyValue("--task-grid-key-color")).toBe("var(--accent)");

    fireEvent.change(screen.getByLabelText("Fill by"), { target: { value: "none" } });
    fireEvent.change(screen.getByLabelText("Border by"), { target: { value: "none" } });
    expect(screen.getByText("FILL · None")).toBeDefined();
    expect(screen.getByText("BORDER · None")).toBeDefined();
    expect(container.querySelectorAll(".task-grid-legend-swatch")).toHaveLength(0);

    fireEvent.click(screen.getByLabelText("title"));
    expect(within(apiCard()).queryByText("Build API")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close grid settings" }));
    expect(screen.queryByLabelText(/First column width/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    expect((screen.getByLabelText(/First column width/) as HTMLInputElement).value).toBe("300");
    expect((screen.getByLabelText("Forward direction") as HTMLSelectElement).value).toBe("rtl");
    expect((screen.getByLabelText("Fill by") as HTMLSelectElement).value).toBe("none");
  });
  it("shows archived tasks on demand and persists the choice per saved Grid", async () => {
    const archivedTask = makeTask({ name: "Archived task", slug: "archived-task", archived: true });
    ipcMock.listBoardTasks.mockResolvedValue([...tasks, archivedTask]);
    const first = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="archived-visibility" />);

    await screen.findByRole("button", { name: /Build API, repo-a/ });
    expect(screen.queryByRole("button", { name: /Archived task, repo-a/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.click(screen.getByLabelText("Show archived"));
    expect(await screen.findByRole("button", { name: /Archived task, repo-a/ })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Close grid settings" }));
    first.unmount();

    render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="archived-visibility" />);
    expect(await screen.findByRole("button", { name: /Archived task, repo-a/ })).toBeDefined();
  });

  it("keeps separate row and column spacing when settings collapse and after remount", async () => {
    const first = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="grid-spacing" />);

    await screen.findByRole("button", { name: /Build API, repo-a/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText(/Row spacing/), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText(/Column spacing/), { target: { value: "18" } });
    const firstGrid = first.container.querySelector(".task-grid-view") as HTMLElement;
    expect(firstGrid.style.getPropertyValue("--task-grid-row-gap")).toBe("6px");
    expect(firstGrid.style.getPropertyValue("--task-grid-column-gap")).toBe("18px");
    fireEvent.click(screen.getByRole("button", { name: "Close grid settings" }));
    expect(firstGrid.classList.contains("settings-collapsed")).toBe(true);
    expect(firstGrid.style.getPropertyValue("--task-grid-row-gap")).toBe("6px");
    expect(firstGrid.style.getPropertyValue("--task-grid-column-gap")).toBe("18px");
    first.unmount();

    const second = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="grid-spacing" />);
    await screen.findByRole("button", { name: /Build API, repo-a/ });
    const secondGrid = second.container.querySelector(".task-grid-view") as HTMLElement;
    expect(secondGrid.style.getPropertyValue("--task-grid-row-gap")).toBe("6px");
    expect(secondGrid.style.getPropertyValue("--task-grid-column-gap")).toBe("18px");
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    expect((screen.getByLabelText(/Row spacing/) as HTMLInputElement).value).toBe("6");
    expect((screen.getByLabelText(/Column spacing/) as HTMLInputElement).value).toBe("18");
  });

  it("ignores obsolete unified spacing", async () => {
    const storageKey = "obsolete-unified-spacing";
    const seed = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey={storageKey} />);
    await screen.findByRole("button", { name: /Build API, repo-a/ });
    seed.unmount();
    const storageName = `alinery:grid:${storageKey}`;
    const saved = JSON.parse(window.localStorage.getItem(storageName) ?? "{}");
    saved.config.spacing = 13;
    delete saved.config.rowSpacing;
    delete saved.config.columnSpacing;
    window.localStorage.setItem(storageName, JSON.stringify(saved));

    render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey={storageKey} />);
    await screen.findByRole("button", { name: /Build API, repo-a/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    expect((screen.getByLabelText(/Row spacing/) as HTMLInputElement).value).not.toBe("13");
    expect((screen.getByLabelText(/Column spacing/) as HTMLInputElement).value).not.toBe("13");
  });

  it("restores the compact workspace after leaving and returning to Grid", async () => {
    const first = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="repo-a" />);

    await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ });
    expect(first.container.querySelector(".task-grid-toolbar")).toBeNull();
    expect(first.container.querySelector(".task-grid-selected")).toBeNull();
    expect(first.container.querySelector(".task-grid-plan")).toBeNull();
    expect(first.container.querySelector(".task-grid-legend")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "progress" } });
    fireEvent.change(screen.getByLabelText(/First column width/), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "Hide Review queue" }));
    fireEvent.click(screen.getByRole("button", { name: "Close grid settings" }));
    expect(first.container.querySelector(".task-grid-view")?.classList.contains("settings-collapsed")).toBe(true);
    first.unmount();

    const second = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="repo-a" />);
    await screen.findByLabelText("Build API playbook path, 3 steps");
    const reviewRow = second.container.querySelector('.task-grid-lane-row[data-task-id="/repo-b:review-queue"]') as HTMLElement;
    expect(reviewRow.dataset.hidden).toBe("true");
    expect(second.container.querySelector(".task-grid-toolbar")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    expect((screen.getByLabelText("Preset") as HTMLSelectElement).value).toBe("custom");
    expect((screen.getByLabelText(/First column width/) as HTMLInputElement).value).toBe("300");
  });

  it("reorders lanes with the drag handle and restores the persisted order", async () => {
    const first = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="pointer-order" />);

    await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "progress" } });

    const target = first.container.querySelector('.task-grid-lane-row[data-task-id="/repo-b:review-queue"]') as HTMLElement;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 100,
      width: 500,
      height: 60,
      top: 100,
      right: 500,
      bottom: 160,
      left: 0,
      toJSON: () => ({}),
    });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => target) });

    const source = first.container.querySelector('.task-grid-lane-row[data-task-id="/repo-a:build-api"]') as HTMLElement;
    fireEvent.pointerDown(screen.getByRole("button", { name: "Reorder Build API; use arrow keys" }), { button: 0, pointerId: 7, clientX: 20, clientY: 20 });
    const preview = first.container.querySelector(".task-grid-drag-preview") as HTMLElement;
    expect(preview.textContent).toContain("Build API");
    expect(preview.textContent).toContain("Moving row");
    expect(source.classList.contains("dragging")).toBe(true);
    const initialPreviewTop = preview.style.top;

    fireEvent.pointerMove(window, { pointerId: 7, clientX: 20, clientY: 150 });
    expect(target.classList.contains("drop-target")).toBe(true);
    expect(preview.style.top).not.toBe(initialPreviewTop);
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 20, clientY: 150 });
    expect(first.container.querySelector(".task-grid-drag-preview")).toBeNull();
    expect(source.classList.contains("dragging")).toBe(false);

    const laneNames = () => [...document.querySelectorAll(".task-grid-lane-name")].map((node) => node.textContent);
    await waitFor(() => expect(laneNames()).toEqual(["Review queue", "Build API", "Release app"]));
    first.unmount();

    render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="pointer-order" />);
    await screen.findByLabelText("Build API playbook path, 3 steps");
    expect(laneNames()).toEqual(["Review queue", "Build API", "Release app"]);
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  it("randomizes every Grid setting and can generate another combination", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999999);
    render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} />);

    await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Randomize grid settings" }));

    expect((screen.getByLabelText("Preset") as HTMLSelectElement).value).toBe("custom");
    expect((screen.getByLabelText("Position model") as HTMLSelectElement).value).toBe("lanes");
    expect((screen.getByLabelText("Progress by") as HTMLSelectElement).value).toBe("createdWindow");
    expect((screen.getByLabelText("Forward direction") as HTMLSelectElement).value).toBe("rtl");
    expect((screen.getByLabelText("Movement memory") as HTMLSelectElement).value).toBe("previous");
    expect((screen.getByLabelText("Path labels") as HTMLSelectElement).value).toBe("none");
    expect((screen.getByLabelText("Group by") as HTMLSelectElement).value).toBe("attention");
    expect((screen.getByLabelText("Fill by") as HTMLSelectElement).value).toBe("attention");
    expect((screen.getByLabelText("Border by") as HTMLSelectElement).value).toBe("attention");
    expect((screen.getByLabelText("Lane order") as HTMLSelectElement).value).toBe("repo");
    expect((screen.getByLabelText("Card mode") as HTMLSelectElement).value).toBe("icon");
    expect((screen.getByLabelText(/Tile width/) as HTMLInputElement).value).toBe("240");
    expect((screen.getByLabelText(/Tile height/) as HTMLInputElement).value).toBe("170");
    expect((screen.getByLabelText(/First column width/) as HTMLInputElement).value).toBe("420");
    expect((screen.getByLabelText(/Row spacing/) as HTMLInputElement).value).toBe("24");
    expect((screen.getByLabelText(/Column spacing/) as HTMLInputElement).value).toBe("24");
    expect((screen.getByLabelText("Filter") as HTMLSelectElement).value).toBe("attention");
    expect((screen.getByLabelText("Brightness") as HTMLSelectElement).value).toBe("none");
    expect(
      within(document.querySelector(".task-grid-properties") as HTMLElement)
        .getAllByRole("checkbox")
        .every((checkbox) => (checkbox as HTMLInputElement).checked),
    ).toBe(true);

    fireEvent.change(screen.getByLabelText("Position model"), { target: { value: "packed" } });
    expect((screen.getByLabelText("Placement") as HTMLSelectElement).value).toBe("quadrants");
    expect((screen.getByLabelText("Group tracks") as HTMLSelectElement).value).toBe("8");
    expect((document.querySelector(".task-grid-groups") as HTMLElement).dataset.columnFlow).toBe("scroll");
    expect((document.querySelector(".task-grid-view") as HTMLElement).style.getPropertyValue("--task-grid-column-cards")).toBe("6");

    random.mockReturnValue(0.000001);
    fireEvent.click(screen.getByRole("button", { name: "Randomize grid settings" }));

    expect((screen.getByLabelText("Position model") as HTMLSelectElement).value).toBe("packed");
    expect((screen.getByLabelText(/Tile width/) as HTMLInputElement).value).toBe("42");
    expect((screen.getByLabelText(/Tile height/) as HTMLInputElement).value).toBe("42");
    expect((screen.getByLabelText(/Row spacing/) as HTMLInputElement).value).toBe("0");
    expect((screen.getByLabelText(/Column spacing/) as HTMLInputElement).value).toBe("0");
    expect((screen.getByLabelText("Group tracks") as HTMLSelectElement).value).toBe("1");
    expect((screen.getByLabelText("Cards per column") as HTMLSelectElement).value).toBe("1");
    expect((screen.getByLabelText("Column flow") as HTMLSelectElement).value).toBe("wrap");
    expect(
      within(document.querySelector(".task-grid-properties") as HTMLElement)
        .getAllByRole("checkbox")
        .filter((checkbox) => (checkbox as HTMLInputElement).checked),
    ).toHaveLength(1);
    expect((screen.getByLabelText("session activity") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Close grid settings" })).toBeDefined();
  });

  it("keeps stable view IDs isolated and gives additional views a useful neutral preset", async () => {
    const first = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="repo-a:view:first" initialPreset="kanban" />);
    await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "quadrants" } });
    first.unmount();

    render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="repo-a:view:second" initialPreset="steps" />);
    await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));

    expect((screen.getByLabelText("Preset") as HTMLSelectElement).value).toBe("steps");
    expect(window.localStorage.getItem("alinery:grid:repo-a:view:first")).not.toBeNull();
    expect(window.localStorage.getItem("alinery:grid:repo-a:view:second")).not.toBeNull();
  });
});
