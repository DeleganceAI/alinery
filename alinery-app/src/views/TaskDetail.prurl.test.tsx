import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { fakeArtifacts } from "../test/artifactHooks";
import { fakeBoard } from "../test/boardHooks";
import { mockIpc } from "../test/mockIpc";
import type { PullRequestSnapshot, Task } from "../types";
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
    ...over,
  }) as Task;

// `vi.mock` factories are hoisted above imports, so the mocks it references must be created
// through `vi.hoisted` rather than plain module-scope `const`.
const mocks = vi.hoisted(() => ({
  listTaskPullRequests: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("../sync/artifacts", async (actual) => (await import("../test/artifactHooks")).artifactHooks(await actual()));
vi.mock("../sync/board", async (actual) => (await import("../test/boardHooks")).boardHooks(await actual()));
vi.mock("../sync/git", () => ({ listTaskPullRequests: mocks.listTaskPullRequests }));
vi.mock("../ipc", () => mockIpc({ openUrl: mocks.openUrl }));

beforeEach(() => {
  localStorage.setItem("alinery.taskHeaderOpen", "1");
  fakeBoard.reset();

  fakeArtifacts.reset();
  mocks.listTaskPullRequests.mockReset().mockResolvedValue({});
  mocks.openUrl.mockReset().mockResolvedValue(undefined);
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
      onBack={noop}
      onOpenSession={noop}
      onNewSession={noop}
      onOpenRelatedTask={noop}
      onDuplicate={noop}
      duplicating={false}
      registerNav={noop}
      appearance={DEFAULT_APPEARANCE}
      onAppearanceChange={noop}
      {...props}
    />,
  );
}

describe("Task pull requests", () => {
  it("does not treat a compare URL as a PR and opens the discovered merged PR", async () => {
    const compareUrl = "https://github.com/example/project/compare/main...a-task";
    const url = "https://github.com/example/project/pull/17";
    fakeBoard.set({ anyRepoTasks: [task({ pr_url: compareUrl })] as never });
    let resolve!: (value: Record<string, PullRequestSnapshot>) => void;
    const pending = new Promise<Record<string, PullRequestSnapshot>>((done) => {
      resolve = done;
    });
    mocks.listTaskPullRequests.mockReturnValue(pending);
    const onBack = vi.fn();
    renderDetail({ repoPath: "/pr-detail", initialTask: task({ pr_url: compareUrl }), onBack });
    expect(screen.queryByRole("link", { name: /PR #/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(onBack).toHaveBeenCalledOnce();
    await act(async () => resolve({ "/pr-detail:a-task": { pr: { number: 17, url, state: "merged" }, error: null } }));
    fireEvent.click(screen.getByRole("link", { name: /PR #17.*Merged/i }));
    await waitFor(() => expect(mocks.openUrl).toHaveBeenCalledWith(url));
    expect(screen.queryByText(compareUrl)).toBeNull();
  });

  it("a resolved getTask with a different pr_url updates the displayed value", async () => {
    fakeBoard.set({ anyRepoTasks: [task({ pr_url: "https://example.com/pr/updated-elsewhere" })] as never });
    renderDetail({ initialTask: task({ pr_url: "https://example.com/pr/old" }) });
    await waitFor(() => expect(screen.getByText("https://example.com/pr/updated-elsewhere")).toBeDefined());
  });
});
