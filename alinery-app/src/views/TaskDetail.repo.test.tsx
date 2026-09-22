import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import type { SessionMeta, SessionObservation, Task } from "../types";
import { TaskDetail } from "./TaskDetail";

// Regression for PR #169 review item 1 ("task identity must include the repository"):
// two repositories can legitimately hold a task with the same slug. App.tsx now keys
// <TaskDetail> by `task:${repoPath}:${slug}` (not slug alone) so opening (repo A, task-x)
// then (repo B, task-x) forces React to discard the old component instead of reusing it.
//
// This drives the remount the same way App.tsx's render site does: change the `key` across
// a `rerender` (the exact mechanism `TaskDetail.test.tsx`'s "keying by slug" describe block
// already relies on). That is the real regression signal — a key-string assertion could pass
// while some other code path still let repo A's rows leak into repo B's view; only an actual
// remount proves the stale state is gone. Mutation-target coverage then confirms every
// TaskDetail mutation is repository-explicit rather than resolving against the mutable
// `active_repo()` global, by asserting the `*ForRepo` wrapper is called with repo B's path.

const task = (over: Partial<Task> = {}): Task =>
  ({
    name: "A Task",
    slug: "task-x",
    requested_slug: "task-x",
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
  listSessions: vi.fn(),
  listArtifactsWithMetadata: vi.fn(),
  sessionStatuses: vi.fn(),
  pushAndCompareUrlForRepo: vi.fn(),
  killSessionForRepo: vi.fn(),
}));

vi.mock("../ipc", () =>
  mockIpc({
    getTask: mocks.getTask,
    listSessions: mocks.listSessions,
    listArtifactsWithMetadata: mocks.listArtifactsWithMetadata,
    sessionStatuses: mocks.sessionStatuses,
    pushAndCompareUrlForRepo: mocks.pushAndCompareUrlForRepo,
    killSessionForRepo: mocks.killSessionForRepo,
  }),
);

beforeEach(() => {
  mocks.getTask.mockReset().mockResolvedValue(null);
  mocks.listSessions.mockReset().mockResolvedValue([]);
  mocks.listArtifactsWithMetadata.mockReset().mockResolvedValue([]);
  mocks.sessionStatuses.mockReset().mockResolvedValue({});
  mocks.pushAndCompareUrlForRepo.mockReset().mockResolvedValue("https://example.test/compare");
  mocks.killSessionForRepo.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

const noop = () => {};

describe("task identity includes the repository", () => {
  it("switches both the displayed task and the mutation target when the same slug reopens under a different repo", async () => {
    const repoA = "/repos/a";
    const repoB = "/repos/b";
    const taskA = task({ name: "Task A", branch: "branch-a", worktree: "/w/a", pr_url: "https://a.example/pr/1" });
    const taskB = task({ name: "Task B", branch: "branch-b", worktree: "/w/b", pr_url: "https://b.example/pr/2" });

    mocks.getTask.mockResolvedValue(taskA);
    const { rerender } = render(
      <TaskDetail
        key={`task:${repoA}:task-x`}
        slug="task-x"
        repoPath={repoA}
        initialTask={taskA}
        onBack={noop}
        onOpenSession={noop}
        onNewSession={noop}
        onOpenRelatedTask={noop}
        onDuplicate={noop}
        duplicating={false}
        registerNav={noop}
        appearance={DEFAULT_APPEARANCE}
        onAppearanceChange={noop}
      />,
    );

    expect(screen.getByText("Task A")).toBeDefined();
    expect(screen.getByText("branch-a")).toBeDefined();
    expect(screen.getByText(taskA.pr_url)).toBeDefined();

    // Same slug, different repo: App.tsx builds a different `key` (`task:${repoPath}:${slug}`),
    // forcing React to unmount repo A's TaskDetail and mount a fresh one instead of reusing it.
    mocks.getTask.mockResolvedValue(taskB);
    rerender(
      <TaskDetail
        key={`task:${repoB}:task-x`}
        slug="task-x"
        repoPath={repoB}
        initialTask={taskB}
        onBack={noop}
        onOpenSession={noop}
        onNewSession={noop}
        onOpenRelatedTask={noop}
        onDuplicate={noop}
        duplicating={false}
        registerNav={noop}
        appearance={DEFAULT_APPEARANCE}
        onAppearanceChange={noop}
      />,
    );

    // (a) the displayed task switches to repo B's data — no repo A branch/worktree/PR URL left over.
    expect(screen.getByText("Task B")).toBeDefined();
    expect(screen.getByText("branch-b")).toBeDefined();
    expect(screen.queryByText("Task A")).toBeNull();
    expect(screen.queryByText("branch-a")).toBeNull();
    expect(screen.getByText(taskB.pr_url)).toBeDefined();
    expect(screen.queryByText(taskA.pr_url)).toBeNull();
    expect(screen.queryByText("Push + open compare")).toBeNull();

    fireEvent.click(screen.getByText("Push + copy compare URL"));
    await waitFor(() => expect(mocks.pushAndCompareUrlForRepo).toHaveBeenCalledWith(repoB, "task-x"));
  });
});

// The second review found the same class of bug in the writes TaskDetail delegates to
// shared/hook code rather than issuing itself. Killing a session is the destructive one:
// resolved against `active_repo()` it could terminate a harness in a repository the user is
// no longer looking at.
describe("a session kill issued from task detail", () => {
  it("targets the repository the row was rendered for", async () => {
    const repoB = "/repos/b";
    const fixture = task();
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listSessions.mockResolvedValue([
      {
        id: "s1",
        worktree: "/w/a-task",
        created: 1,
        archived: false,
        phase: "research",
        harness: "claude",
        model: "",
        playbook: "superdevelop",
        generic: false,
        harness_resume_token: "",
      } as SessionMeta,
    ]);
    mocks.sessionStatuses.mockResolvedValue({
      s1: { lifecycle: { state: "live" }, state: null, checkpoint: {} },
    } as Record<string, SessionObservation>);

    render(
      <TaskDetail
        key={`task:${repoB}:task-x`}
        slug="task-x"
        repoPath={repoB}
        initialTask={fixture}
        onBack={noop}
        onOpenSession={noop}
        onNewSession={noop}
        onOpenRelatedTask={noop}
        onDuplicate={noop}
        duplicating={false}
        registerNav={noop}
        appearance={DEFAULT_APPEARANCE}
        onAppearanceChange={noop}
      />,
    );

    const kill = await waitFor(() => screen.getByText("Kill"));
    fireEvent.click(kill);

    await waitFor(() => expect(mocks.killSessionForRepo).toHaveBeenCalledWith(repoB, "s1", "task-x"));
  });
});
