import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import type { Task } from "../types";
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

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  listSessions: vi.fn(),
  listArtifactsWithMetadata: vi.fn(),
  sessionStatuses: vi.fn(),
}));

vi.mock("../ipc", () =>
  mockIpc({
    getTask: mocks.getTask,
    listSessions: mocks.listSessions,
    listArtifactsWithMetadata: mocks.listArtifactsWithMetadata,
    sessionStatuses: mocks.sessionStatuses,
  }),
);

beforeEach(() => {
  mocks.getTask.mockReset().mockResolvedValue(null);
  mocks.listSessions.mockReset().mockResolvedValue([]);
  mocks.listArtifactsWithMetadata.mockReset().mockResolvedValue([]);
  mocks.sessionStatuses.mockReset().mockResolvedValue({});
});

afterEach(cleanup);

const noop = () => {};

describe("TaskDetail artifact pane width", () => {
  it("applies the stored viewer width as a CSS variable", () => {
    render(
      <TaskDetail
        slug="a-task"
        repoPath="/r"
        initialTask={task()}
        onBack={noop}
        onOpenSession={noop}
        onNewSession={noop}
        onOpenRelatedTask={noop}
        onDuplicate={noop}
        duplicating={false}
        registerNav={noop}
        appearance={{ ...DEFAULT_APPEARANCE, artifact_viewer_width: 480 }}
        onAppearanceChange={vi.fn()}
      />,
    );

    expect((document.querySelector(".detail.taskdetail") as HTMLElement).style.getPropertyValue("--artifact-width")).toBe("480px");
  });
});
