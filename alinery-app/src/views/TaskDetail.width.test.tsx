import { readFileSync } from "node:fs";
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
  listPlaybooks: vi.fn(),
  listPlaybookSteps: vi.fn(),
  listSessions: vi.fn(),
  listArtifactsWithMetadata: vi.fn(),
  sessionStatuses: vi.fn(),
}));

vi.mock("../ipc", () =>
  mockIpc({
    getTask: mocks.getTask,
    listPlaybooks: mocks.listPlaybooks,
    listPlaybookSteps: mocks.listPlaybookSteps,
    listSessions: mocks.listSessions,
    listArtifactsWithMetadata: mocks.listArtifactsWithMetadata,
    sessionStatuses: mocks.sessionStatuses,
  }),
);

beforeEach(() => {
  mocks.getTask.mockReset().mockResolvedValue(null);
  mocks.listPlaybooks.mockReset().mockResolvedValue([]);
  mocks.listPlaybookSteps.mockReset().mockResolvedValue([]);
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

describe("TaskDetail session layout CSS", () => {
  const css = readFileSync("src/theme.css", "utf8");
  const app = readFileSync("src/App.tsx", "utf8");

  it("reserves an action rail, wraps whole buttons, and drops secondary time columns first", () => {
    expect(css).toMatch(/\.task-session-table \.session-actions-col\s*{[^}]*width: 220px;/s);
    expect(css).toMatch(/\.session-actions\s*{[^}]*flex-wrap: wrap;/s);
    expect(css).toMatch(/@media \(max-width: 1100px\)\s*{[\s\S]*?\.task-session-table \.session-time-col\s*{[^}]*display: none;/);
  });

  it("gives the session table the remaining Task Detail height and sole vertical scroll", () => {
    expect(css).toMatch(/(?:^|\n)body\s*{[^}]*overflow: hidden;/s);
    expect(css).toMatch(/\.detailmain\s*{[^}]*display: flex;[^}]*flex-direction: column;[^}]*overflow: hidden;/s);
    expect(css).toMatch(/\.task-sessions-panel\s*{[^}]*min-height: 0;[^}]*flex: 1 1 0;[^}]*flex-direction: column;/s);
    expect(css).toMatch(/\.task-session-table-wrap\s*{[^}]*min-height: 0;[^}]*flex: 1 1 0;[^}]*overflow: auto;/s);
    expect(css).not.toMatch(/\.task-session-table-wrap\s*{[^}]*max-height:/s);
    expect(app).toMatch(/view\.kind === "task"[\s\S]*?<div className="view">/);
  });
});
