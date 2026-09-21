import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import type { BoardTask, Task } from "../types";
import { TaskDetail } from "./TaskDetail";

const task = (over: Partial<Task> = {}): Task =>
  ({
    name: "A Task",
    slug: "a-task",
    requested_slug: "a-task",
    branch: "a-task-branch",
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
    related_tasks: [],
    ...over,
  }) as Task;

const board = (over: Partial<BoardTask> = {}): BoardTask =>
  ({
    ...task(),
    repo_path: "/r",
    session_count: 0,
    playbook_title: "SuperDevelop",
    updated: 1,
    current_phase: "research",
    current_step_title: "Research",
    latest_session_title: "",
    latest_session_column_key: "",
    current_column_key: "research",
    current_column_title: "Research",
    artifact_count: 0,
    sessions: [],
    ...over,
  }) as BoardTask;

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  listBoardTasks: vi.fn(),
  listPlaybooks: vi.fn(),
  listPlaybookSteps: vi.fn(),
  listSessions: vi.fn(),
  listArtifactsWithMetadata: vi.fn(),
  sessionStatuses: vi.fn(),
  setRelatedTasksForRepo: vi.fn(),
}));

vi.mock("../ipc", () =>
  mockIpc({
    getTask: mocks.getTask,
    listBoardTasks: mocks.listBoardTasks,
    listPlaybooks: mocks.listPlaybooks,
    listPlaybookSteps: mocks.listPlaybookSteps,
    listSessions: mocks.listSessions,
    listArtifactsWithMetadata: mocks.listArtifactsWithMetadata,
    sessionStatuses: mocks.sessionStatuses,
    setRelatedTasksForRepo: mocks.setRelatedTasksForRepo,
  }),
);

beforeEach(() => {
  mocks.getTask.mockReset().mockResolvedValue(null);
  mocks.listBoardTasks.mockReset().mockResolvedValue([]);
  mocks.listPlaybooks.mockReset().mockResolvedValue([]);
  mocks.listPlaybookSteps.mockReset().mockResolvedValue([]);
  mocks.listSessions.mockReset().mockResolvedValue([]);
  mocks.listArtifactsWithMetadata.mockReset().mockResolvedValue([]);
  mocks.sessionStatuses.mockReset().mockResolvedValue({});
  mocks.setRelatedTasksForRepo.mockReset().mockImplementation(async (_repo: string, _slug: string, related: Task["related_tasks"]) => task({ related_tasks: related }));
});

afterEach(() => {
  cleanup();
});

const noop = () => {};

function renderDetail(props: Partial<Parameters<typeof TaskDetail>[0]> = {}) {
  return render(
    <TaskDetail
      slug={props.slug ?? "a-task"}
      repoPath={props.repoPath ?? "/r"}
      initialTask={props.initialTask}
      knownRepos={props.knownRepos ?? ["/r", "/other"]}
      onBack={noop}
      onOpenSession={noop}
      onNewSession={noop}
      onOpenRelatedTask={props.onOpenRelatedTask ?? noop}
      onDuplicate={props.onDuplicate ?? noop}
      duplicating={props.duplicating ?? false}
      registerNav={noop}
      appearance={DEFAULT_APPEARANCE}
      onAppearanceChange={noop}
    />,
  );
}

describe("related-task tags", () => {
  it("lets the user tag a task from another open repo", async () => {
    const other = board({ name: "Other Task", slug: "other-task", repo_path: "/other" });
    mocks.listBoardTasks.mockResolvedValue([board(), other]);
    mocks.getTask.mockResolvedValue(task());

    renderDetail({ initialTask: task() });

    const select = (await screen.findByLabelText("Tag a related task")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "/other:other-task" } });

    await waitFor(() => expect(mocks.setRelatedTasksForRepo).toHaveBeenCalledWith("/r", "a-task", [{ repo_path: "/other", slug: "other-task", name: "Other Task" }]));
    expect(await screen.findByRole("button", { name: "Open Other Task" })).toBeDefined();
  });

  it("opens an open tagged task and greys out a closed-repo tag", async () => {
    const onOpenRelatedTask = vi.fn();
    const tagged = task({
      related_tasks: [
        { repo_path: "/other", slug: "live-task", name: "Live Task" },
        { repo_path: "/closed", slug: "gone-task", name: "Gone Task" },
      ],
    });
    mocks.getTask.mockResolvedValue(tagged);

    renderDetail({ initialTask: tagged, knownRepos: ["/r", "/other"], onOpenRelatedTask });

    fireEvent.click(screen.getByRole("button", { name: "Open Live Task" }));
    expect(onOpenRelatedTask).toHaveBeenCalledWith("live-task", "/other");

    const closed = screen.getByRole("button", { name: "Gone Task (repository closed)" });
    expect((closed as HTMLButtonElement).disabled).toBe(true);
    expect(closed.closest(".task-related-tag")?.className).toContain("closed");
    fireEvent.click(closed);
    expect(onOpenRelatedTask).toHaveBeenCalledTimes(1);
  });
});
