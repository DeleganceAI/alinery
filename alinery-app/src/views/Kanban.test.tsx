import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import { navReady, requireNav } from "../test/nav";
import type { BoardNav, BoardTask, KanbanColumn, PullRequestSnapshot, TaskActivityMap, TaskActivitySummary } from "../types";
import { Kanban } from "./Kanban";

// Template for a component test in this codebase. Three things make it work:
//   1. `vi.mock("../ipc", ...)` — the whole Tauri boundary is one module, so one mock
//      covers every backend call the component can make. Before the ipc seam this was not
//      possible: each view imported `invoke` directly.
//   2. mockIpc rejects any command the test did not stub, by name, instead of resolving
//      undefined and failing somewhere unrelated.
//   3. Everything the component reaches for is data, so assertions are about behaviour
//      ("this task is in that column") rather than about markup.

const columns: KanbanColumn[] = [
  { key: "todo-draft", title: "Todo / Draft" },
  { key: "research-design", title: "Research & Design" },
  { key: "in-review", title: "In Review" },
  { key: "implementation", title: "Implementation" },
] as KanbanColumn[];

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
    parent_task: "",
    active_subtask: "",
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

const tasks = [
  task({ name: "Designing", slug: "designing", current_column_key: "research-design" }),
  task({ name: "Parent", slug: "parent", active_subtask: "child", current_column_key: "todo-draft" }),
  task({ name: "Child", slug: "child", parent_task: "parent", current_column_key: "research-design" }),
  task({ name: "Reviewing", slug: "designing", repo_path: "/other", current_column_key: "in-review" }),
  task({ name: "Archived one", slug: "archived-one", archived: true, current_column_key: "in-review" }),
  // A column key the backend returned but list_kanban_columns did not.
  task({ name: "Bespoke", slug: "bespoke", current_column_key: "custom", current_column_title: "Custom Phase" }),
];

// Reassignable so a test can put the board in a different world (no tasks at all,
// only archived ones) without a second vi.mock. Reset in afterEach.
let boardTasks = tasks;
let taskActivity: TaskActivityMap = {};

const ipcMocks = vi.hoisted(() => ({
  archiveTaskForRepo: vi.fn(),
  listBoardTasks: vi.fn(),
  listKanbanColumns: vi.fn(),
  listTaskActivity: vi.fn(),
  listTaskPullRequests: vi.fn(),
  openUrl: vi.fn(),
  removeWorktreeForRepo: vi.fn(),
}));

vi.mock("../ipc", () => mockIpc(ipcMocks));

beforeEach(() => {
  ipcMocks.listKanbanColumns.mockImplementation(async () => columns);
  ipcMocks.listBoardTasks.mockImplementation(async () => boardTasks);
  ipcMocks.listTaskActivity.mockImplementation(async () => taskActivity);
  ipcMocks.listTaskPullRequests.mockResolvedValue({});
  ipcMocks.openUrl.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  taskActivity = {};
  boardTasks = tasks;
  // mockIpc caches one spy per command for the whole module, so call history would
  // otherwise accumulate across tests and `not.toHaveBeenCalled()` would start depending
  // on the order they run in.
  vi.clearAllMocks();
});

/** The tasks rendered under a column heading, in order. */
function cardsUnder(title: string): string[] {
  const column = screen.getByText(title).closest(".col");
  return [...(column?.querySelectorAll(".card .t") ?? [])].map((n) => n.textContent ?? "");
}

describe("Kanban board placement", () => {
  it("files each task under the column its backend column key names", async () => {
    const { Kanban } = await import("./Kanban");
    render(<Kanban allRepos={false} onOpen={() => {}} onDuplicate={() => {}} onOpenActiveSession={() => {}} registerNav={() => {}} onCreate={() => {}} />);

    await waitFor(() => expect(screen.getByText("Designing")).toBeDefined());
    expect(cardsUnder("Research & Design")).toEqual(["Designing"]);
    expect(cardsUnder("In Review")).toEqual(["Reviewing"]);
  });

  it("hides archived tasks until asked", async () => {
    const { Kanban } = await import("./Kanban");
    render(<Kanban allRepos={false} onOpen={() => {}} onDuplicate={() => {}} onOpenActiveSession={() => {}} registerNav={() => {}} onCreate={() => {}} />);

    await waitFor(() => expect(screen.getByText("Reviewing")).toBeDefined());
    expect(cardsUnder("In Review")).not.toContain("Archived one");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Show archived"));
    });

    await waitFor(() => expect(cardsUnder("In Review")).toContain("Archived one"));
  });

  it("gates the board when no task exists", async () => {
    boardTasks = [];
    const { Kanban } = await import("./Kanban");
    render(<Kanban allRepos={false} onOpen={() => {}} onDuplicate={() => {}} onOpenActiveSession={() => {}} registerNav={() => {}} onCreate={() => {}} />);

    await waitFor(() => expect(screen.getByText("The board starts with a task")).toBeDefined());
  });

  // The gate asks whether a task exists, not whether the board is currently showing
  // one. Deriving it from the rendered cards would lock a repo out of its own board
  // the moment its only tasks were archived.
  it("does not gate a board whose only tasks are archived", async () => {
    boardTasks = [task({ name: "Archived only", slug: "archived-only", archived: true, current_column_key: "in-review" })];
    const { Kanban } = await import("./Kanban");
    render(<Kanban allRepos={false} onOpen={() => {}} onDuplicate={() => {}} onOpenActiveSession={() => {}} registerNav={() => {}} onCreate={() => {}} />);

    await waitFor(() => expect(screen.getByText("In Review")).toBeDefined());
    expect(screen.queryByText("The board starts with a task")).toBeNull();
  });

  // A task can carry a column key that list_kanban_columns never returned — a playbook
  // edited after the task was created. Dropping it would make the task vanish from the
  // board with no error anywhere.
  it("invents a column for a task whose column the playbook no longer defines", async () => {
    const { Kanban } = await import("./Kanban");
    render(<Kanban allRepos={false} onOpen={() => {}} onDuplicate={() => {}} onOpenActiveSession={() => {}} registerNav={() => {}} onCreate={() => {}} />);

    await waitFor(() => expect(screen.getByText("Custom Phase")).toBeDefined());
    expect(cardsUnder("Custom Phase")).toEqual(["Bespoke"]);
  });

  it("renders an empty column rather than omitting it", async () => {
    const { Kanban } = await import("./Kanban");
    render(<Kanban allRepos={false} onOpen={() => {}} onDuplicate={() => {}} onOpenActiveSession={() => {}} registerNav={() => {}} onCreate={() => {}} />);

    await waitFor(() => expect(screen.getByText("Implementation")).toBeDefined());
    expect(cardsUnder("Implementation")).toEqual([]);
  });

  it("hides columns emptied by child and archive visibility without breaking column navigation", async () => {
    boardTasks = [
      task({ name: "Parent", slug: "parent", current_column_key: "todo-draft" }),
      task({ name: "Child", slug: "child", parent_task: "parent", current_column_key: "research-design" }),
      task({ name: "Archived", slug: "archived", archived: true, current_column_key: "in-review" }),
      task({ name: "Implementing", slug: "implementing", current_column_key: "implementation" }),
    ];
    const onOpen = vi.fn();
    let nav: BoardNav | null = null;
    render(
      <Kanban
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
    await screen.findByText("Parent");
    fireEvent.click(screen.getByLabelText("Show empty columns"));
    expect(screen.queryByText("Research & Design")).toBeNull();
    expect(screen.queryByText("In Review")).toBeNull();
    expect(cardsUnder("Implementation")).toEqual(["Implementing"]);

    await navReady(() => nav);
    await act(async () => requireNav(nav).moveCol(1));
    await act(async () => requireNav(nav).openSelected());
    expect(onOpen).toHaveBeenLastCalledWith(boardTasks[3]);
    await act(async () => requireNav(nav).moveCol(1));
    await act(async () => requireNav(nav).openSelected());
    expect(onOpen).toHaveBeenLastCalledWith(boardTasks[0]);

    fireEvent.click(screen.getByLabelText("Show children"));
    expect(cardsUnder("Research & Design")).toEqual(["Child"]);
    fireEvent.click(screen.getByLabelText("Show archived"));
    await waitFor(() => expect(cardsUnder("In Review")).toEqual(["Archived"]));

    fireEvent.click(screen.getByLabelText("Show children"));
    fireEvent.click(screen.getByLabelText("Show archived"));
    await waitFor(() => expect(screen.queryByText("In Review")).toBeNull());
    expect(screen.queryByText("Research & Design")).toBeNull();
    fireEvent.click(screen.getByLabelText("Show empty columns"));
    expect(cardsUnder("Research & Design")).toEqual([]);
    expect(cardsUnder("In Review")).toEqual([]);
  });
});

describe("sub-task cards", () => {
  it("hides children by default, keeps the parent indicator, and reveals children in their backend column", async () => {
    const { Kanban } = await import("./Kanban");
    render(<Kanban allRepos={false} onOpen={() => {}} onDuplicate={() => {}} onOpenActiveSession={() => {}} registerNav={() => {}} onCreate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Parent")).toBeDefined());

    expect(screen.queryByText("Child")).toBeNull();
    expect(screen.getByText("Active child · child")).toBeDefined();
    expect(cardsUnder("Research & Design")).toEqual(["Designing"]);
    expect(screen.getByText("Research & Design").closest(".col")?.querySelector(".cnt")?.textContent).toBe("1");

    fireEvent.click(screen.getByText("Show children"));
    await waitFor(() => expect(screen.getByText("Child")).toBeDefined());
    expect(cardsUnder("Research & Design")).toEqual(["Designing", "Child"]);
    expect(screen.getByText("↳ Child")).toBeDefined();
    expect(screen.getByText("Research & Design").closest(".col")?.querySelector(".cnt")?.textContent).toBe("2");
  });

  it("shows the parent activity while its child card is hidden", async () => {
    taskActivity = {
      "/r:parent": {
        status: "running",
        active_session: null,
      },
    };
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    });
    const { Kanban } = await import("./Kanban");
    render(<Kanban allRepos={false} onOpen={() => {}} onDuplicate={() => {}} onOpenActiveSession={() => {}} registerNav={() => {}} onCreate={() => {}} />);

    const parentCard = (await screen.findByText("Parent")).closest(".card");
    await waitFor(() => expect(parentCard?.querySelector('[title="Highest-priority session is running"]')).not.toBeNull());
    expect(screen.queryByText("Child")).toBeNull();
  });

  it("moves selection off a child when the toggle hides it", async () => {
    const { Kanban } = await import("./Kanban");
    const onOpen = vi.fn();
    let nav: BoardNav | null = null;
    render(
      <Kanban
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
    await waitFor(() => expect(screen.getByText("Parent")).toBeDefined());
    fireEvent.click(screen.getByText("Show children"));
    fireEvent.click(await screen.findByText("Child"));
    onOpen.mockClear();

    fireEvent.click(screen.getByText("Show children"));
    await waitFor(() => expect(screen.queryByText("Child")).toBeNull());
    await navReady(() => nav);
    await act(async () => requireNav(nav).openSelected());

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen.mock.calls[0][0].slug).not.toBe("child");
  });
});

describe("Kanban task attention", () => {
  it("shows only the highest-priority session status and opens the selected active session", async () => {
    const row = task({ name: "Mixed activity", slug: "mixed", current_step_title: "TDD", latest_session_title: "TDD" });
    const activeSession = {
      id: "older-design",
      worktree: row.worktree,
      phase: "design",
      harness: "omp",
      model: "",
      playbook: "superdevelop",
      generic: false,
      step_title: "Design",
    };
    const summary: TaskActivitySummary = {
      status: "waiting_for_input",
      active_session: activeSession,
    };
    boardTasks = [row];
    taskActivity = { "/r:mixed": summary };
    const onOpen = vi.fn();
    const onOpenActiveSession = vi.fn();
    render(<Kanban allRepos={false} onOpen={onOpen} onDuplicate={() => {}} onOpenActiveSession={onOpenActiveSession} registerNav={() => {}} onCreate={() => {}} />);

    const activeButton = await screen.findByRole("button", { name: "Design" });
    expect(screen.queryByLabelText("Running")).toBeNull();
    expect(screen.getAllByLabelText("Needs input")).toHaveLength(1);
    expect(screen.queryByText("Needs input")).toBeNull();
    expect(screen.queryByText("Needs approval")).toBeNull();
    expect(screen.queryByText("Failed")).toBeNull();
    expect(screen.queryByText("Completed")).toBeNull();
    expect(screen.queryByText("TDD")).toBeNull();

    fireEvent.keyDown(activeButton, { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(activeButton);
    expect(onOpenActiveSession).toHaveBeenCalledWith(row, activeSession);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("Kanban pull requests", () => {
  it("keeps cards usable while fetching and opens the discovered PR without opening its card", async () => {
    const row = task({ name: "Awaiting review", slug: "pr-review", repo_path: "/pr-board" });
    boardTasks = [row];
    let resolve!: (value: Record<string, PullRequestSnapshot>) => void;
    ipcMocks.listTaskPullRequests.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const onOpen = vi.fn();
    render(<Kanban allRepos={false} onOpen={onOpen} onDuplicate={() => {}} onOpenActiveSession={() => {}} registerNav={() => {}} onCreate={() => {}} />);

    fireEvent.click(await screen.findByText("Awaiting review"));
    expect(onOpen).toHaveBeenCalledWith(row);
    onOpen.mockClear();
    const url = "https://github.com/example/project/pull/42";
    await act(async () => resolve({ "/pr-board:pr-review": { pr: { number: 42, url, state: "open" }, error: null } }));
    const link = screen.getByRole("link", { name: /PR #42.*Open/i });
    fireEvent.keyDown(link, { key: "Enter" });
    fireEvent.click(link);
    await waitFor(() => expect(ipcMocks.openUrl).toHaveBeenCalledWith(url));
    expect(onOpen).not.toHaveBeenCalled();
    expect(cardsUnder("Research & Design")).toEqual(["Awaiting review"]);
  });
});

// The behavioural half of scripts/tests/check-no-window-confirm.sh. That gate reads the
// source and can only prove a confirmation was *written*; this proves one is actually
// reached before anything destructive happens. The repo has shipped a confirmation that
// existed in source and never asked anyone — that is the scar the gate exists for.
describe("archiving is gated by a confirmation", () => {
  const renderBoard = async () => {
    const onOpenActiveSession = () => {};
    let nav: BoardNav | null = null;
    render(
      <Kanban
        allRepos={false}
        onOpen={() => {}}
        onDuplicate={() => {}}
        onOpenActiveSession={onOpenActiveSession}
        onCreate={() => {}}
        registerNav={(n) => {
          if (n) nav = n;
        }}
      />,
    );
    await waitFor(() => expect(screen.getByText("Designing")).toBeDefined());
    return () => nav as BoardNav | null;
  };

  it("asks before archiving, and archives nothing until the user says so", async () => {
    const getNav = await renderBoard();

    await act(async () => {
      getNav()?.archiveSelected();
    });

    // The dialog is up …
    expect(screen.getByText("Archive task", { selector: ".mt" })).toBeDefined();
    // … and NOTHING has been archived yet. Asserted as a call count, not as absent text:
    // a dialog that renders but does not gate would still pass a text assertion.
    expect(ipcMocks.archiveTaskForRepo).not.toHaveBeenCalled();
    expect(ipcMocks.removeWorktreeForRepo).not.toHaveBeenCalled();
  });

  it("explains the permanent limitation before removing a worktree", async () => {
    const getNav = await renderBoard();

    await act(async () => {
      getNav()?.archiveSelected();
    });
    const removeWorktree = screen.getByLabelText("Also permanently remove the worktree (uncommitted changes are lost)");
    expect(screen.queryByText(/Restoring later keeps this task available/)).toBeNull();

    fireEvent.click(removeWorktree);

    expect(
      screen.getByText(
        "Restoring later keeps this task available for history and related-task links, but it does not recreate the worktree. New sessions, commits, and pushes remain unavailable; create a new task and tag this one as related to continue the work.",
      ),
    ).toBeDefined();
  });

  it("cancelling archives nothing at all", async () => {
    const getNav = await renderBoard();

    await act(async () => {
      getNav()?.archiveSelected();
    });
    fireEvent.click(screen.getByText("Cancel"));

    expect(ipcMocks.archiveTaskForRepo).not.toHaveBeenCalled();
    expect(ipcMocks.removeWorktreeForRepo).not.toHaveBeenCalled();
  });

  it("accepting archives the selected task, and leaves the worktree alone by default", async () => {
    ipcMocks.archiveTaskForRepo.mockResolvedValue(undefined);
    const getNav = await renderBoard();

    await act(async () => {
      getNav()?.archiveSelected();
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Archive task", { selector: "button" }));
    });

    expect(ipcMocks.archiveTaskForRepo).toHaveBeenCalledWith("/r", "designing");
    // Removing the worktree is destructive on top of destructive — uncommitted work is
    // lost — so it must stay opt-in even once the user has accepted the archive.
    expect(ipcMocks.removeWorktreeForRepo).not.toHaveBeenCalled();
  });
});

describe("duplicate selection", () => {
  it("passes the repository-qualified selected card and renders no card action", async () => {
    const onDuplicate = vi.fn();
    let nav: BoardNav | null = null;
    const { Kanban } = await import("./Kanban");
    render(
      <Kanban
        allRepos
        onOpen={() => {}}
        onDuplicate={onDuplicate}
        onOpenActiveSession={() => {}}
        onCreate={() => {}}
        registerNav={(next) => {
          if (next) nav = next;
        }}
      />,
    );
    await waitFor(() => expect(screen.getByText("Designing")).toBeDefined());

    await navReady(() => nav);
    act(() => requireNav(nav).duplicateSelected());
    expect(onDuplicate).toHaveBeenLastCalledWith(expect.objectContaining({ slug: "designing", repo_path: "/r" }));

    act(() => requireNav(nav).moveCol(1));
    act(() => requireNav(nav).duplicateSelected());
    expect(onDuplicate).toHaveBeenLastCalledWith(expect.objectContaining({ slug: "designing", repo_path: "/other" }));
    expect(screen.queryByTitle(/Duplicate task/i)).toBeNull();
  });
});
