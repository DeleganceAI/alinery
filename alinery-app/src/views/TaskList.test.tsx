import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_STATE_ART } from "../emptyStateArt";
import { mockIpc } from "../test/mockIpc";
import { navReady, requireNav } from "../test/nav";
import type { BoardNav, BoardTask, TaskActivityMap, TaskActivitySummary } from "../types";
import { flattenTaskRows, TaskList } from "./TaskList";

const scenario = vi.hoisted(() => ({
  tasks: [] as BoardTask[],
  error: "",
}));
let activity: TaskActivityMap = {};

vi.mock("../ipc", () =>
  mockIpc({
    listBoardTasks: async () => {
      if (scenario.error) throw new Error(scenario.error);
      return structuredClone(scenario.tasks);
    },
    listTaskActivity: async () => activity,
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
  window.localStorage.clear();
  scenario.tasks = [];
  scenario.error = "";
  activity = {};
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
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

describe("Task List column sorting", () => {
  const names = () => [...document.querySelectorAll(".task-name-text")].map((node) => node.textContent);

  it("keeps tied Updated rows and selection stable across reordered polls, but follows real activity", async () => {
    vi.useFakeTimers();
    const epoch = 1_700_000_000;
    vi.setSystemTime(epoch * 1000);
    try {
      window.localStorage.setItem("alinery:task-list:sort", JSON.stringify({ field: "updated", direction: "desc" }));
      const alpha = task("alpha", { created: epoch - 120, updated: epoch - 60 });
      const beta = task("beta", { created: epoch - 120, updated: epoch - 60 });
      scenario.tasks = [beta, alpha];
      let nav: BoardNav | null = null;
      const onOpen = vi.fn();
      render(
        <TaskList
          allRepos={false}
          onOpen={onOpen}
          onDuplicate={() => {}}
          onOpenActiveSession={() => {}}
          onCreate={() => {}}
          registerNav={(next) => {
            nav = next;
          }}
        />,
      );
      await navReady(() => nav);
      expect(names()).toEqual(["ALPHA", "BETA"]);
      fireEvent.click(screen.getByText("BETA"));
      for (const tasks of [
        [alpha, beta],
        [beta, alpha],
      ]) {
        scenario.tasks = tasks;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(names()).toEqual(["ALPHA", "BETA"]);
        expect(document.querySelector("tr.sel .task-name-text")?.textContent).toBe("BETA");
      }
      expect([...document.querySelectorAll(".age-cell:last-child")].map((cell) => cell.textContent)).toEqual(["2m", "2m"]);

      scenario.tasks = [alpha, { ...beta, updated: epoch + 60 }];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(names()).toEqual(["BETA", "ALPHA"]);
      act(() => requireNav(nav).openSelected());
      expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ slug: "beta" }));
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("restores the selected column and direction after leaving and remounting the task list", async () => {
    scenario.tasks = [task("alpha", { created: 1, session_count: 2 }), task("beta", { created: 2, session_count: 10 })];
    const list = <TaskList allRepos={false} onOpen={() => {}} onDuplicate={() => {}} onOpenActiveSession={() => {}} registerNav={() => {}} onCreate={() => {}} />;
    const { rerender } = render(list);
    await screen.findByText("ALPHA");
    fireEvent.click(screen.getByRole("button", { name: "Sort by Sessions" }));
    expect(names()).toEqual(["BETA", "ALPHA"]);

    rerender(<div>Settings</div>);
    rerender(list);
    await screen.findByText("ALPHA");
    expect(names()).toEqual(["BETA", "ALPHA"]);
    expect(screen.getByRole("button", { name: "Sort by Sessions" }).closest("th")?.getAttribute("aria-sort")).toBe("descending");

    fireEvent.click(screen.getByRole("button", { name: "Sort by Sessions" }));
    rerender(<div>Playbooks</div>);
    rerender(list);
    await screen.findByText("ALPHA");
    expect(names()).toEqual(["ALPHA", "BETA"]);
    expect(screen.getByRole("button", { name: "Sort by Sessions" }).closest("th")?.getAttribute("aria-sort")).toBe("ascending");
  });

  it("ignores an obsolete saved column and still allows choosing a valid sort", async () => {
    window.localStorage.setItem("alinery:task-list:sort", JSON.stringify({ field: "removed-column", direction: "desc" }));
    scenario.tasks = [task("alpha", { created: 1 }), task("beta", { created: 2 })];
    render(<TaskList allRepos={false} onOpen={() => {}} onDuplicate={() => {}} onOpenActiveSession={() => {}} registerNav={() => {}} onCreate={() => {}} />);
    await screen.findByText("ALPHA");
    expect(names()).toEqual(["ALPHA", "BETA"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Created" }));
    expect(names()).toEqual(["BETA", "ALPHA"]);
  });

  it("sorts every column in both directions using displayed values, numeric counts, and missing activity last", async () => {
    scenario.tasks = [
      task("zulu", { name: "Zulu", created: 10, updated: 0, session_count: 2, playbook_title: "Charlie" }),
      task("alpha", { name: "Alpha", created: 20, updated: 5, session_count: 10, playbook_title: "", playbook: "Alpha" }),
      task("beta", { name: "Beta", created: 30, updated: 15, session_count: 1, playbook_title: "Bravo" }),
    ];
    activity = {
      "/r:zulu": summary({ status: "running" }),
      "/r:alpha": summary({
        status: "failed",
        active_session: { id: "build", worktree: "/w/alpha", phase: "build", harness: "omp", model: "", playbook: "superdevelop", generic: false, step_title: "Build" },
      }),
    };
    const onOpen = vi.fn();
    render(<TaskList allRepos={false} onOpen={onOpen} onDuplicate={() => {}} onOpenActiveSession={() => {}} registerNav={() => {}} onCreate={() => {}} />);
    await screen.findByRole("button", { name: "Build" });
    expect(names()).toEqual(["Zulu", "Alpha", "Beta"]);

    const cases = [
      { label: "Name", direction: "ascending", first: ["Alpha", "Beta", "Zulu"], second: ["Zulu", "Beta", "Alpha"] },
      { label: "Playbook", direction: "ascending", first: ["Alpha", "Beta", "Zulu"], second: ["Zulu", "Beta", "Alpha"] },
      { label: "Active session", direction: "ascending", first: ["Alpha", "Zulu", "Beta"], second: ["Zulu", "Alpha", "Beta"] },
      { label: "Status", direction: "ascending", first: ["Alpha", "Zulu", "Beta"], second: ["Zulu", "Alpha", "Beta"] },
      { label: "Sessions", direction: "descending", first: ["Alpha", "Zulu", "Beta"], second: ["Beta", "Zulu", "Alpha"] },
      { label: "Created", direction: "descending", first: ["Beta", "Alpha", "Zulu"], second: ["Zulu", "Alpha", "Beta"] },
      { label: "Updated", direction: "descending", first: ["Beta", "Zulu", "Alpha"], second: ["Alpha", "Zulu", "Beta"] },
    ];
    for (const { label, direction, first, second } of cases) {
      const header = screen.getByRole("button", { name: `Sort by ${label}` });
      fireEvent.click(header);
      expect(names()).toEqual(first);
      expect(header.closest("th")?.getAttribute("aria-sort")).toBe(direction);
      expect(document.querySelectorAll("th[aria-sort]")).toHaveLength(1);
      fireEvent.click(header);
      expect(names()).toEqual(second);
      expect(header.closest("th")?.getAttribute("aria-sort")).toBe(direction === "ascending" ? "descending" : "ascending");
    }
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("sorts siblings within their parents and preserves selection and sorted navigation after reload", async () => {
    scenario.tasks = [
      task("zulu", { created: 1 }),
      task("child-10", { parent_task: "zulu", created: 2 }),
      task("child-2", { parent_task: "zulu", created: 3 }),
      task("alpha", { created: 4 }),
      task("archived", { parent_task: "zulu", archived: true, created: 5 }),
    ];
    let nav: BoardNav | null = null;
    const onOpen = vi.fn();
    render(
      <TaskList
        allRepos={false}
        onOpen={onOpen}
        onDuplicate={() => {}}
        onOpenActiveSession={() => {}}
        registerNav={(next) => {
          if (next) nav = next;
        }}
        onCreate={() => {}}
      />,
    );
    await screen.findByText("ZULU");
    await navReady(() => nav);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Name" }));
    expect(names()).toEqual(["ALPHA", "ZULU", "CHILD-2", "CHILD-10"]);
    act(() => requireNav(nav).openSelected());
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ slug: "zulu" }));
    act(() => requireNav(nav).moveRow(1));
    act(() => requireNav(nav).openSelected());
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ slug: "child-2" }));

    fireEvent.click(screen.getByText("Show archived"));
    await screen.findByText("ARCHIVED");
    expect(names()).toEqual(["ALPHA", "ZULU", "ARCHIVED", "CHILD-2", "CHILD-10"]);
    act(() => requireNav(nav).openSelected());
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ slug: "child-2" }));
    fireEvent.click(screen.getByRole("button", { name: "Sort by Name" }));
    expect(names()).toEqual(["ZULU", "CHILD-10", "CHILD-2", "ARCHIVED", "ALPHA"]);
    act(() => requireNav(nav).moveRow(-1));
    act(() => requireNav(nav).openSelected());
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ slug: "child-10" }));
  });
});

describe("Task List age refresh", () => {
  it("ages Created and Updated through unchanged polls without changing their timestamps", async () => {
    const epoch = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(epoch * 1000);
    try {
      scenario.tasks = [task({ created: epoch, updated: epoch })];
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
            nav = next;
          }}
        />,
      );
      await navReady(() => nav);
      const row = screen.getByText("A task").closest("tr");
      const ages = () => [...(row?.querySelectorAll(".age-cell") ?? [])].map((cell) => cell.textContent);
      const absolute = new Date(epoch * 1000).toLocaleString();
      expect(ages()).toEqual(["now", "now"]);
      expect([...(row?.querySelectorAll(".age-cell") ?? [])].map((cell) => cell.getAttribute("title"))).toEqual([absolute, absolute]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(59_000);
      });
      expect(ages()).toEqual(["now", "now"]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect.soft(ages()).toEqual(["1m", "1m"]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect.soft(ages()).toEqual(["2m", "2m"]);
      expect([...(row?.querySelectorAll(".age-cell") ?? [])].map((cell) => cell.getAttribute("title"))).toEqual([absolute, absolute]);
      act(() => requireNav(nav).openSelected());
      expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ repo_path: "/r", slug: "a-task", created: epoch, updated: epoch }));
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
});
