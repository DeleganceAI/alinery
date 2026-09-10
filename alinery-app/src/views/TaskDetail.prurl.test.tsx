import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import type { Task } from "../types";
import { TaskDetail } from "./TaskDetail";

// Companion to TaskDetail.test.tsx (read-only for this file — see AGENTS.md's split-file
// convention). PR URL is a display row: "not available" or the git-populated URL, with Copy.

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

describe("PR URL is a read-only display row", () => {
  it("shows not available when git has not populated a URL", () => {
    renderDetail({ initialTask: task({ pr_url: "" }) });
    expect(screen.getByText("PR URL")).toBeDefined();
    expect(screen.getByText("not available")).toBeDefined();
    expect(screen.queryByPlaceholderText(/PR \/ compare URL/i)).toBeNull();
  });

  it("shows the git-populated URL with a copy button", () => {
    renderDetail({ initialTask: task({ pr_url: "https://example.com/pr/12" }) });
    expect(screen.getByText("https://example.com/pr/12")).toBeDefined();
    expect(screen.getByRole("button", { name: /copy pr url/i })).toBeDefined();
  });

  it("a resolved getTask with a different pr_url updates the displayed value", async () => {
    mocks.getTask.mockResolvedValue(task({ pr_url: "https://example.com/pr/updated-elsewhere" }));
    renderDetail({ initialTask: task({ pr_url: "https://example.com/pr/old" }) });
    await waitFor(() => expect(screen.getByText("https://example.com/pr/updated-elsewhere")).toBeDefined());
  });
});
