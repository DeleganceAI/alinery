import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { fakeArtifacts } from "../test/artifactHooks";
import { fakeBoard } from "../test/boardHooks";
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
    playbook_steps: [],
    updated: 1,
    current_phase: "research",
    current_step_title: "Research",
    latest_session_title: "",
    latest_session_column_key: "",
    current_column_key: "research",
    current_column_title: "Research",
    ...over,
  }) as BoardTask;

const mocks = vi.hoisted(() => ({
  setRelatedTasksForRepo: vi.fn(),
}));

vi.mock("../sync/artifacts", async (actual) => (await import("../test/artifactHooks")).artifactHooks(await actual()));
vi.mock("../sync/board", async (actual) => (await import("../test/boardHooks")).boardHooks(await actual()));
vi.mock("../sync/tasks", async (actual) => ({ ...(await actual<typeof import("../sync/tasks")>()), setRelatedTasksForRepo: mocks.setRelatedTasksForRepo }));
vi.mock("../ipc", () => mockIpc({}));

beforeEach(() => {
  fakeBoard.reset();
  fakeArtifacts.reset();
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
    fakeBoard.set({ tasks: [board(), other] as never });
    fakeBoard.set({ anyRepoTasks: [task()] as never });

    renderDetail({ initialTask: task(), knownRepos: ["/r", "/other"] });

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
    fakeBoard.set({ anyRepoTasks: [tagged] as never });

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

it("resolves retained current related names without rewriting snapshots", async () => {
  const related = { repo_path: "/other", slug: "retained", name: "Historical snapshot" };
  const fixture = task({ related_tasks: [related, { repo_path: "/other", slug: "missing", name: "Missing fallback" }] });
  fakeBoard.set({ anyRepoTasks: [fixture] as never });
  fakeBoard.set({ tasks: [board({ repo_path: "/other", slug: "retained", name: "Current retained name", archived: true })] as never });
  const onOpenRelatedTask = vi.fn();
  renderDetail({ initialTask: fixture, knownRepos: ["/r", "/other"], onOpenRelatedTask });
  fireEvent.click(await screen.findByRole("button", { name: "Open Current retained name" }));
  expect(onOpenRelatedTask).toHaveBeenCalledWith("retained", "/other");
  expect(screen.getByRole("button", { name: "Open Missing fallback" })).toBeDefined();
  expect(related.name).toBe("Historical snapshot");
  expect(mocks.setRelatedTasksForRepo).not.toHaveBeenCalled();
});

describe("related tasks on a remote host", () => {
  const own = "alinery+ssh://box-a1b2c3/srv/a";
  const sameHost = "alinery+ssh://box-a1b2c3/srv/b";
  const otherHost = "alinery+ssh://other-00aa11/srv/c";

  it("offers only tasks on the same host and stores their host path", async () => {
    fakeBoard.set({
      tasks: [
        board({ repo_path: own }),
        board({ name: "Same host", slug: "same", repo_path: sameHost }),
        board({ name: "Other host", slug: "other", repo_path: otherHost }),
        board({ name: "On this Mac", slug: "mac", repo_path: "/r" }),
      ] as never,
    });
    fakeBoard.set({ anyRepoTasks: [task()] as never });

    renderDetail({ initialTask: task(), repoPath: own, knownRepos: [own, sameHost, otherHost, "/r"] });

    const select = (await screen.findByLabelText("Tag a related task")) as HTMLSelectElement;
    const labels = Array.from(select.options).map((option) => option.textContent);
    expect(labels.some((label) => label?.includes("Same host"))).toBe(true);
    expect(labels.some((label) => label?.includes("Other host") || label?.includes("On this Mac"))).toBe(false);

    fireEvent.change(select, { target: { value: `${sameHost}:same` } });
    await waitFor(() => expect(mocks.setRelatedTasksForRepo).toHaveBeenCalledWith(own, "a-task", [{ repo_path: "/srv/b", slug: "same", name: "Same host" }]));
  });

  it("shows a stored host path as the repo it names and opens it by key", async () => {
    const onOpenRelatedTask = vi.fn();
    const tagged = task({ related_tasks: [{ repo_path: "/srv/b", slug: "same", name: "Same host" }] });
    fakeBoard.set({ anyRepoTasks: [tagged] as never });
    fakeBoard.set({ tasks: [board({ name: "Same host", slug: "same", repo_path: sameHost })] as never });

    renderDetail({ initialTask: tagged, repoPath: own, knownRepos: [own, sameHost], onOpenRelatedTask });

    fireEvent.click(await screen.findByRole("button", { name: "Open Same host" }));
    expect(onOpenRelatedTask).toHaveBeenCalledWith("same", sameHost);
  });
});
