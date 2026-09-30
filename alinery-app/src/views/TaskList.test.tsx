import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_STATE_ART } from "../emptyStateArt";
import { mockIpc } from "../test/mockIpc";
import { navReady, requireNav } from "../test/nav";
import type { BoardNav, BoardTask, PullRequestSnapshot, TaskActivityMap, TaskActivityRef, TaskActivitySummary } from "../types";
import { flattenTaskRows, TaskList } from "./TaskList";

const scenario = vi.hoisted(() => ({
  tasks: [] as BoardTask[],
  error: "",
}));
const pullRequests = vi.hoisted(() => ({
  listTaskPullRequests: vi.fn(
    async (tasks: TaskActivityRef[]): Promise<Record<string, PullRequestSnapshot>> =>
      Object.fromEntries(tasks.map((task) => [`${task.repoPath}:${task.taskSlug}`, { pr: null, error: null }])),
  ),
  openUrl: vi.fn(async (_url: string | URL) => {}),
}));
let activity: TaskActivityMap = {};

vi.mock("../ipc", () =>
  mockIpc({
    listBoardTasks: async () => {
      if (scenario.error) throw new Error(scenario.error);
      return scenario.tasks;
    },
    listTaskActivity: async () => activity,
    listTaskPullRequests: pullRequests.listTaskPullRequests,
    openUrl: pullRequests.openUrl,
  }),
);

function task(slugOrOverrides: string | Partial<BoardTask> = "a-task", taskOverrides: Partial<BoardTask> = {}): BoardTask {
  const slug = typeof slugOrOverrides === "string" ? slugOrOverrides : "a-task";
  const overrides = typeof slugOrOverrides === "string" ? taskOverrides : slugOrOverrides;
  return {
    name: slug === "a-task" ? "A task" : slug.toUpperCase(),
    slug,
    requested_slug: slug,
    parent_task: "",
    active_subtask: "",
    branch: slug,
    worktree: `/worktrees/${slug}`,
    has_worktree: true,
    created: 1,
    archived: false,
    pr_url: "",
    linear_id: "",
    github_issue: "",
    playbook: "superdevelop",
    auto_advance: [],
    draft: false,
    repo_path: "/r",
    session_count: 2,
    playbook_title: "SuperDevelop",
    playbook_steps: [],
    updated: 1,
    current_phase: "tdd",
    current_step_title: "TDD",
    latest_session_title: "TDD",
    latest_session_column_key: "implementation",
    current_column_key: "implementation",
    current_column_title: "Implementation",
    ...overrides,
  };
}

const summary = (overrides: Partial<TaskActivitySummary> = {}): TaskActivitySummary => ({
  status: "waiting_for_input",
  active_session: {
    id: "older-design",
    worktree: "/w/a-task",
    phase: "design",
    harness: "omp",
    model: "",
    playbook: "superdevelop",
    generic: false,
    step_title: "Design",
  },
  ...overrides,
});

beforeEach(() => {
  scenario.tasks = [];
  scenario.error = "";
  activity = {};
  pullRequests.listTaskPullRequests.mockReset();
  pullRequests.listTaskPullRequests.mockImplementation(async (tasks: TaskActivityRef[]) =>
    Object.fromEntries(tasks.map((task) => [`${task.repoPath}:${task.taskSlug}`, { pr: null, error: null }])),
  );
  pullRequests.openUrl.mockReset();
  pullRequests.openUrl.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  scenario.tasks = [];
  activity = {};
  vi.clearAllMocks();
});

describe("Task List duplicate selection", () => {
  it("passes the repository-qualified highlighted row and renders no row action", async () => {
    scenario.tasks = [
      task("same", { name: "First", repo_path: "/repo-a", worktree: "/repo-a/same" }),
      task("same", { name: "Second", repo_path: "/repo-b", worktree: "/repo-b/same" }),
    ];
    const onDuplicate = vi.fn();
    let nav: BoardNav | null = null;
    render(
      <TaskList
        allRepos
        onOpen={() => {}}
        onDuplicate={onDuplicate}
        onOpenActiveSession={() => {}}
        registerNav={(next) => {
          if (next) nav = next;
        }}
        onCreate={() => {}}
      />,
    );
    // Wait for BOTH rows, not just the first. The nav handle closes over the rows it was built
    // with, so acting while the second repository's task is still loading duplicates against a
    // one-row list and reports the wrong repo_path. Also wait for a selected row: nav can register
    // on the empty first paint (selectedTask null), and under suite load that handle can still be
    // the one navReady returns if we do not wait for selection to land.
    await waitFor(() => {
      expect(screen.getByText("First")).toBeDefined();
      expect(screen.getByText("Second")).toBeDefined();
      expect(document.querySelector("tr.sel")).toBeTruthy();
    });

    await navReady(() => nav);
    act(() => requireNav(nav).duplicateSelected());
    await waitFor(() => expect(onDuplicate).toHaveBeenLastCalledWith(expect.objectContaining({ slug: "same", repo_path: "/repo-a" })));

    act(() => requireNav(nav).moveRow(1));
    act(() => requireNav(nav).duplicateSelected());
    await waitFor(() => expect(onDuplicate).toHaveBeenLastCalledWith(expect.objectContaining({ slug: "same", repo_path: "/repo-b" })));
    expect(screen.queryByTitle(/Duplicate task/i)).toBeNull();
  });
});

describe("flattenTaskRows", () => {
  it("produces deterministic pre-order rows for arbitrary nesting", () => {
    const rows = flattenTaskRows([
      task("c", { parent_task: "b", created: 3 }),
      task("other", { created: 4 }),
      task("a", { active_subtask: "b", created: 1 }),
      task("b", { parent_task: "a", active_subtask: "c", created: 2 }),
    ]);

    expect(rows.map((row) => [row.task.slug, row.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["other", 0],
    ]);
  });

  it("isolates identical slugs and parent pointers by repository", () => {
    const rows = flattenTaskRows([
      task("parent", { repo_path: "/repo-b", created: 1 }),
      task("child", { repo_path: "/repo-a", parent_task: "parent", created: 2 }),
      task("parent", { repo_path: "/repo-a", created: 1 }),
      task("child", { repo_path: "/repo-b", parent_task: "parent", created: 2 }),
    ]);

    expect(rows.map((row) => `${row.task.repo_path}:${row.task.slug}:${row.depth}`)).toEqual(["/repo-a:parent:0", "/repo-a:child:1", "/repo-b:parent:0", "/repo-b:child:1"]);
  });

  it("keeps a child reachable when its parent is not in the visible set", () => {
    const rows = flattenTaskRows([task("child", { parent_task: "filtered-parent" })]);
    expect(rows).toMatchObject([{ task: { slug: "child" }, depth: 0, parentHidden: true }]);
  });
});

describe("Task List relationship projection", () => {
  it("renders nested rows and moves keyboard selection over the flattened order", async () => {
    scenario.tasks = [task("child", { parent_task: "parent", created: 2 }), task("parent", { active_subtask: "child", created: 1 })];
    const onOpen = vi.fn();
    let nav: BoardNav | null = null;
    render(
      <TaskList
        allRepos={false}
        onOpen={onOpen}
        onDuplicate={() => {}}
        onOpenActiveSession={() => {}}
        onCreate={() => {}}
        registerNav={(next) => {
          if (next) nav = next;
        }}
      />,
    );
    await screen.findByText("PARENT");
    const names = [...document.querySelectorAll(".task-name-text")].map((node) => node.textContent);
    expect(names).toEqual(["PARENT", "CHILD"]);
    expect(document.querySelectorAll(".task-name-cell.nested")).toHaveLength(1);

    await navReady(() => nav);
    await act(async () => requireNav(nav).moveRow(1));
    await act(async () => requireNav(nav).openSelected());
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ slug: "child" }));
  });

  it("retains archived child history beneath its parent when Show archived is on", async () => {
    scenario.tasks = [task("parent", { created: 1 }), task("child", { parent_task: "parent", archived: true, created: 2 })];
    render(<TaskList allRepos={false} onOpen={() => {}} onDuplicate={() => {}} onOpenActiveSession={() => {}} onCreate={() => {}} registerNav={() => {}} />);
    await screen.findByText("PARENT");
    expect(screen.queryByText("CHILD")).toBeNull();

    fireEvent.click(screen.getByText("Show archived"));
    await screen.findByText("CHILD");
    expect([...document.querySelectorAll(".task-name-text")].map((node) => node.textContent)).toEqual(["PARENT", "CHILD"]);
  });

  it("marks a visible child whose parent is filtered out", async () => {
    scenario.tasks = [task("child", { parent_task: "filtered-parent" })];
    render(<TaskList allRepos={false} onOpen={() => {}} onDuplicate={() => {}} onOpenActiveSession={() => {}} onCreate={() => {}} registerNav={() => {}} />);
    await screen.findByText("CHILD");
    expect(screen.getByText("Child of filtered-parent")).toBeDefined();
  });

  it("surfaces backend relationship corruption and refuses stale rows", async () => {
    scenario.error = "relationship corruption: active-child cycle reaches 'a'";
    render(<TaskList allRepos={false} onOpen={() => {}} onDuplicate={() => {}} onOpenActiveSession={() => {}} onCreate={() => {}} registerNav={() => {}} />);
    await waitFor(() => expect(screen.getByText(/relationship corruption/)).toBeDefined());
    expect(document.querySelectorAll(".task-name-text")).toHaveLength(0);
  });
});

describe("TaskList empty", () => {
  it("renders a catalog plate on the major empty surface", async () => {
    const { container } = render(<TaskList allRepos={false} onOpen={() => {}} onDuplicate={() => {}} onOpenActiveSession={() => {}} registerNav={() => {}} onCreate={() => {}} />);
    await screen.findByText("No tasks yet.");
    const img = container.querySelector("img.empty-state-art");
    expect(img).not.toBeNull();
    expect(EMPTY_STATE_ART).toContain(img?.getAttribute("src"));
    expect(container.querySelector(".list-empty")).not.toBeNull();
  });

  it("shows only the highest-priority session status and opens the selected active session", async () => {
    const row = task();
    scenario.tasks = [row];
    activity = { "/r:a-task": summary() };
    const onOpen = vi.fn();
    const onOpenActiveSession = vi.fn();
    render(<TaskList allRepos={false} onOpen={onOpen} onDuplicate={() => {}} onOpenActiveSession={onOpenActiveSession} registerNav={() => {}} onCreate={() => {}} />);

    const activeButton = await screen.findByRole("button", { name: "Design" });
    expect(screen.getByText("Active session")).toBeDefined();
    expect(screen.queryByLabelText("Running")).toBeNull();
    expect(screen.getAllByLabelText("Needs input")).toHaveLength(1);
    expect(screen.queryByText("Needs input")).toBeNull();
    expect(screen.queryByText("Needs approval")).toBeNull();
    expect(screen.queryByText("Failed")).toBeNull();
    expect(screen.queryByText("Completed")).toBeNull();

    fireEvent.click(activeButton);
    await waitFor(() => expect(onOpenActiveSession).toHaveBeenCalledWith(row, summary().active_session));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("renders an em dash when no session is active", async () => {
    scenario.tasks = [task()];
    activity = { "/r:a-task": summary({ status: null, active_session: null }) };
    const { container } = render(<TaskList allRepos={false} onOpen={() => {}} onDuplicate={() => {}} onOpenActiveSession={() => {}} registerNav={() => {}} onCreate={() => {}} />);
    await screen.findByText("A task");
    expect(container.querySelector("tbody tr td:nth-child(3)")?.textContent).toBe("—");
  });
});

function names() {
  return [...document.querySelectorAll(".task-name-text")].map((node) => node.textContent);
}

describe("Task list pull requests", () => {
  const props = {
    allRepos: false,
    onDuplicate: () => {},
    onOpenActiveSession: () => {},
    registerNav: () => {},
    onCreate: () => {},
  };

  it("shows an icon-only PR column and opens the pull request without opening the task", async () => {
    const openUrl = "https://github.com/example/project/pull/42";
    const mergedUrl = "https://github.com/example/project/pull/8";
    const closedUrl = "https://github.com/example/project/pull/7";
    scenario.tasks = [
      task("open-pr", { name: "Open PR", repo_path: "/pr-icons", created: 1 }),
      task("merged-pr", { name: "Merged PR", repo_path: "/pr-icons", created: 2 }),
      task("closed-pr", { name: "Closed PR", repo_path: "/pr-icons", created: 3 }),
      task("none-pr", { name: "No PR", repo_path: "/pr-icons", created: 4 }),
      task("draft-pr", { name: "Draft PR", repo_path: "/pr-icons", created: 5, draft: true }),
    ];
    pullRequests.listTaskPullRequests.mockResolvedValue({
      "/pr-icons:open-pr": { pr: { number: 42, url: openUrl, state: "open" }, error: null },
      "/pr-icons:merged-pr": { pr: { number: 8, url: mergedUrl, state: "merged" }, error: null },
      "/pr-icons:closed-pr": { pr: { number: 7, url: closedUrl, state: "closed" }, error: null },
      "/pr-icons:none-pr": { pr: null, error: null },
    });
    const onOpen = vi.fn();
    render(<TaskList {...props} onOpen={onOpen} />);

    const headers = await screen.findAllByRole("columnheader");
    expect(headers[headers.length - 1]?.textContent?.trim()).toBe("PR");
    const open = await screen.findByRole("link", { name: /PR #42.*Open/i });
    expect(open.className).toContain("open");
    expect(open.className).toContain("compact");
    expect(open.textContent).toBe("");
    const merged = screen.getByRole("link", { name: /PR #8.*Merged/i });
    expect(merged.className).toContain("merged");
    expect(merged.textContent).toBe("");
    const closed = screen.getByRole("link", { name: /PR #7.*Closed/i });
    expect(closed.className).toContain("closed");
    expect(closed.textContent).toBe("");
    const none = screen.getByText("No PR").closest("tr");
    expect(none?.querySelector(".pr-col")?.textContent).toBe("");
    expect(none?.querySelector("a, [role='img']")).toBeNull();
    expect(screen.getByText("Draft PR").closest("tr")?.querySelector(".pr-col")?.textContent).toBe("");
    expect(pullRequests.listTaskPullRequests).toHaveBeenCalledWith([
      { repoPath: "/pr-icons", taskSlug: "open-pr" },
      { repoPath: "/pr-icons", taskSlug: "merged-pr" },
      { repoPath: "/pr-icons", taskSlug: "closed-pr" },
      { repoPath: "/pr-icons", taskSlug: "none-pr" },
    ]);

    fireEvent.click(open);
    await waitFor(() => expect(pullRequests.openUrl).toHaveBeenCalledWith(openUrl));
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Open PR"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ slug: "open-pr" }));
  });

  it("sorts by pull request status and restores the task tree", async () => {
    scenario.tasks = [
      task("parent", { name: "Parent", repo_path: "/pr-sort", created: 1 }),
      task("child", { name: "Child", repo_path: "/pr-sort", parent_task: "parent", created: 2 }),
      task("closed", { name: "Closed", repo_path: "/pr-sort", created: 3 }),
      task("merged", { name: "Merged", repo_path: "/pr-sort", created: 4 }),
    ];
    pullRequests.listTaskPullRequests.mockResolvedValue({
      "/pr-sort:parent": { pr: null, error: null },
      "/pr-sort:child": { pr: { number: 42, url: "https://github.com/example/project/pull/42", state: "open" }, error: null },
      "/pr-sort:closed": { pr: { number: 7, url: "https://github.com/example/project/pull/7", state: "closed" }, error: null },
      "/pr-sort:merged": { pr: { number: 8, url: "https://github.com/example/project/pull/8", state: "merged" }, error: null },
    });
    render(<TaskList {...props} onOpen={() => {}} />);

    await screen.findByRole("link", { name: /PR #42.*Open/i });
    expect(names()).toEqual(["Parent", "Child", "Closed", "Merged"]);
    expect(document.querySelectorAll(".task-name-cell.nested")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Sort by PR status, open first" }));
    expect(names()).toEqual(["Child", "Merged", "Closed", "Parent"]);
    expect(document.querySelectorAll(".task-name-cell.nested")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "PR, open first. Activate to sort with no pull request first" }).closest("th")?.getAttribute("aria-sort")).toBe("descending");

    fireEvent.click(screen.getByRole("button", { name: "PR, open first. Activate to sort with no pull request first" }));
    expect(names()).toEqual(["Parent", "Closed", "Merged", "Child"]);
    expect(screen.getByRole("button", { name: "PR, no pull request first. Activate to restore task order" }).closest("th")?.getAttribute("aria-sort")).toBe("ascending");

    fireEvent.click(screen.getByRole("button", { name: "PR, no pull request first. Activate to restore task order" }));
    expect(names()).toEqual(["Parent", "Child", "Closed", "Merged"]);
    expect(document.querySelectorAll(".task-name-cell.nested")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Sort by PR status, open first" }).closest("th")?.getAttribute("aria-sort")).toBeNull();
  });
});
