import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { daemonTransport } from "../daemon/transport";
import { fakeArtifacts } from "../test/artifactHooks";
import { fakeBoard } from "../test/boardHooks";
import { mockIpc } from "../test/mockIpc";
import { sessionDaemon } from "../test/sessionDaemon";
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
vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));
let daemon = sessionDaemon();
const mocks = vi.hoisted(() => ({
  pushAndCompareUrlForRepo: vi.fn(),
  killSessionForRepo: vi.fn(),
  renameSession: vi.fn(),
}));

vi.mock("../sync/artifacts", async (actual) => (await import("../test/artifactHooks")).artifactHooks(await actual()));
vi.mock("../sync/board", async (actual) => (await import("../test/boardHooks")).boardHooks(await actual()));
vi.mock("../sync/sessions", async (actual) => ({
  ...(await actual<typeof import("../sync/sessions")>()),
  killSession: mocks.killSessionForRepo,
  renameSession: mocks.renameSession,
}));
vi.mock("../sync/git", () => ({ pushAndCompareUrlForRepo: mocks.pushAndCompareUrlForRepo, listTaskPullRequests: async () => ({}) }));
vi.mock("../ipc", () => mockIpc());

beforeEach(() => {
  localStorage.setItem("alinery.taskHeaderOpen", "1");
  localStorage.removeItem("alinery.taskSessionView");
  fakeBoard.reset();

  fakeArtifacts.reset();
  daemon = sessionDaemon();
  vi.mocked(daemonTransport).mockImplementation((repo) => daemon.transport(repo));
  mocks.pushAndCompareUrlForRepo.mockReset().mockResolvedValue("https://example.test/compare");
  mocks.killSessionForRepo.mockReset().mockResolvedValue(undefined);
  mocks.renameSession.mockReset();
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

    fakeBoard.set({ anyRepoTasks: [taskA] as never });
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
    fakeBoard.set({ anyRepoTasks: [taskB] as never });
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
    fakeBoard.set({ anyRepoTasks: [fixture] as never });
    fakeBoard.set({
      taskSessions: [
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
      ] as never,
    });
    daemon.show(repoB, "task-x", "s1", { lifecycle: { state: "live" }, state: null, checkpoint: {} } as SessionObservation);

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
    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));

    const kill = await waitFor(() => screen.getByText("Kill"));
    fireEvent.click(kill);

    await waitFor(() => expect(mocks.killSessionForRepo).toHaveBeenCalledWith(repoB, "s1", "task-x"));
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

it.each(["commit", "reject"] as const)("late_name_commit_cannot_patch_another_repo: %s", async (outcome) => {
  const pending = deferred<{ name: string; source: "user" }>();
  mocks.renameSession.mockReturnValueOnce(pending.promise);
  const onNameCommitted = vi.fn();
  const session = {
    id: "same-session",
    worktree: "/w",
    created: 1,
    archived: false,
    phase: "research",
    harness: "omp",
    model: "",
    playbook: "",
    generic: true,
    harness_resume_token: "",
    name: "Repo A purpose",
  };
  fakeBoard.set({ anyRepoTasks: [task({ name: "Repo A task" })] as never });
  fakeBoard.set({ taskSessions: [session] as never });
  const view = (repoPath: string) => (
    <TaskDetail
      slug="task-x"
      repoPath={repoPath}
      onBack={noop}
      onOpenSession={noop}
      onNewSession={noop}
      onOpenRelatedTask={noop}
      onDuplicate={noop}
      duplicating={false}
      registerNav={noop}
      appearance={DEFAULT_APPEARANCE}
      onAppearanceChange={noop}
      onNameCommitted={onNameCommitted}
    />
  );
  const { rerender } = render(view("/repo-a"));
  fireEvent.click(await screen.findByRole("button", { name: "Show list view" }));
  fireEvent.click(await screen.findByRole("button", { name: "Rename session" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), { target: { value: "Committed in A" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fakeBoard.set({ anyRepoTasks: [task({ name: "Repo B task" })] as never });
  fakeBoard.set({ taskSessions: [{ ...session, name: "Repo B purpose" }] as never });
  rerender(view("/repo-b"));
  await screen.findByText("Repo B purpose");
  fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "B draft" } });
  await act(async () => {
    if (outcome === "commit") pending.resolve({ name: "Committed in A", source: "user" });
    else pending.reject(new Error("Repo A storage failure"));
  });
  expect(screen.getByText("Repo B purpose")).toBeDefined();
  expect(screen.queryByText("Committed in A")).toBeNull();
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("B draft");
  expect(screen.queryByText("Repo A storage failure")).toBeNull();
  if (outcome === "commit")
    expect(onNameCommitted).toHaveBeenCalledWith({
      kind: "session",
      repo_path: "/repo-a",
      task_slug: "task-x",
      session_id: "same-session",
      value: { name: "Committed in A", source: "user" },
    });
  else expect(onNameCommitted).not.toHaveBeenCalled();
});

it("each repository shows its own task and sessions for the same slug", async () => {
  const row = (repo: string, name: string) => ({
    id: "same-session",
    worktree: "/w",
    created: 1,
    archived: false,
    phase: "research",
    harness: "omp",
    model: "",
    playbook: "",
    generic: true,
    harness_resume_token: "",
    name,
    task_slug: "task-x",
    repo_path: repo,
  });
  fakeBoard.set({
    tasks: [
      { ...task({ name: "Task in A" }), repo_path: "/repo-a" },
      { ...task({ name: "Task in B" }), repo_path: "/repo-b" },
    ] as never,
    sessions: [row("/repo-a", "Session in A"), row("/repo-b", "Session in B")] as never,
    taskSessions: null,
  });
  const props = {
    slug: "task-x",
    onBack: noop,
    onOpenSession: noop,
    onNewSession: noop,
    onOpenRelatedTask: noop,
    onDuplicate: noop,
    duplicating: false,
    registerNav: noop,
    appearance: DEFAULT_APPEARANCE,
    onAppearanceChange: noop,
  };
  const { rerender } = render(<TaskDetail {...props} repoPath="/repo-a" />);
  await screen.findByRole("heading", { name: "Task in A" });
  rerender(<TaskDetail {...props} repoPath="/repo-b" />);
  await screen.findByRole("heading", { name: "Task in B" });
  expect(screen.queryByText("Session in A")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Show list view" }));
  expect(await screen.findByText("Session in B")).toBeDefined();
});
