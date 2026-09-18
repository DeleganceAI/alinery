import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import { navReady, requireNav } from "../test/nav";
import type {
  BoardNav,
  BoardTask,
  PlaybookStepSummary,
  PlaybookSummary,
  SessionMeta,
  SessionObservation,
  SubtaskManagerState,
  Task,
  TaskActivityRef,
  TaskActivitySummary,
} from "../types";
import { TaskDetail } from "./TaskDetail";

const scenario = vi.hoisted(() => ({
  task: {} as Task,
  relatedTasks: [] as Task[],
  state: {} as SubtaskManagerState,
  sessions: [] as SessionMeta[],
  childActivity: {
    status: null,
    active_session: null,
  } as TaskActivitySummary,
  childBoardTask: {} as BoardTask,
  managerObservation: null as SessionObservation | null,
}));

const ipcSpies = vi.hoisted(() => ({
  startSubtaskManager: vi.fn(),
  recoverSubtaskManager: vi.fn(),
  discardSubtask: vi.fn(),
  createSessionForRepo: vi.fn(),
  restoreTaskForRepo: vi.fn(),
  archiveSessionForRepo: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  listTasks: vi.fn(),
  subtaskState: vi.fn(),
  listTaskActivity: vi.fn(),
  listBoardTasks: vi.fn(),
  listPlaybooks: vi.fn(),
  listPlaybookSteps: vi.fn(),
  listSessions: vi.fn(),
  listArtifactsWithMetadata: vi.fn(),
  listTaskArtifactTree: vi.fn(),
  listArtifactCommentDrafts: vi.fn(),
  sessionStatuses: vi.fn(),
  sessionStatus: vi.fn(),
  worktreeExists: vi.fn(),
  markSessionNotificationRead: vi.fn(),
}));

const confirmSpies = vi.hoisted(() => ({
  confirmDanger: vi.fn(),
}));
vi.mock("../confirm", () => confirmSpies);

const toastSpies = vi.hoisted(() => ({
  toast: vi.fn(),
}));
vi.mock("../toast", () => toastSpies);

vi.mock("../ipc", () =>
  mockIpc({
    getTask: mocks.getTask,
    listTasks: mocks.listTasks,
    subtaskState: mocks.subtaskState,
    listTaskActivity: mocks.listTaskActivity,
    listBoardTasks: mocks.listBoardTasks,
    listPlaybooks: mocks.listPlaybooks,
    listPlaybookSteps: mocks.listPlaybookSteps,
    listSessions: mocks.listSessions,
    listArtifactsWithMetadata: mocks.listArtifactsWithMetadata,
    listTaskArtifactTree: mocks.listTaskArtifactTree,
    listArtifactCommentDrafts: mocks.listArtifactCommentDrafts,
    sessionStatuses: mocks.sessionStatuses,
    sessionStatus: mocks.sessionStatus,
    worktreeExists: mocks.worktreeExists,
    createSessionForRepo: ipcSpies.createSessionForRepo,
    restoreTaskForRepo: ipcSpies.restoreTaskForRepo,
    archiveSessionForRepo: ipcSpies.archiveSessionForRepo,
    markSessionNotificationRead: mocks.markSessionNotificationRead,
    startSubtaskManager: ipcSpies.startSubtaskManager,
    recoverSubtaskManager: ipcSpies.recoverSubtaskManager,
    discardSubtask: ipcSpies.discardSubtask,
  }),
);

const parentTask: Task = {
  name: "Parent",
  slug: "parent",
  requested_slug: "parent",
  parent_task: "",
  active_subtask: "",
  branch: "parent",
  worktree: "/worktrees/parent",
  has_worktree: true,
  created: 1,
  archived: false,
  pr_url: "",
  linear_id: "",
  github_issue: "",
  playbook: "superdevelop",
  auto_advance: [],
  draft: false,
};

const childSummary = {
  name: "Child",
  slug: "child",
  branch: "child",
  worktree: "/worktrees/child",
  has_worktree: true,
  playbook: "superdevelop",
  archived: false,
  draft: false,
};

const childBoardTask: BoardTask = {
  ...parentTask,
  name: childSummary.name,
  slug: childSummary.slug,
  requested_slug: childSummary.slug,
  parent_task: parentTask.slug,
  branch: childSummary.branch,
  worktree: childSummary.worktree,
  playbook: childSummary.playbook,
  repo_path: "/repo",
  session_count: 1,
  playbook_title: "Review",
  updated: 10,
  current_phase: "review-context",
  current_step_title: "Review Context",
  latest_session_title: "Review Context",
  latest_session_column_key: "review",
  current_column_key: "review",
  current_column_title: "Review",
};

const manager: SessionMeta = {
  id: "manager-1",
  worktree: "/worktrees/parent",
  created: 10,
  archived: false,
  phase: "",
  harness: "claude",
  model: "sonnet",
  playbook: "",
  generic: true,
  subtask_manager: true,
  subtask_slug: "",
  harness_resume_token: "",
};

function state(overrides: Partial<SubtaskManagerState> = {}): SubtaskManagerState {
  return {
    task: parentTask,
    parent_task: null,
    active_subtask: null,
    parent_manager_session: null,
    parent_manager_owner_task_slug: "",
    manager_session: null,
    manager_owner_task_slug: "parent",
    can_start: true,
    can_recover: false,
    disabled_reason: "",
    ...overrides,
  };
}

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

const session = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({
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
    ...over,
  }) as SessionMeta;

const observation = (agent: "busy" | "idle"): SessionObservation => ({
  lifecycle: { state: "live" },
  state: {
    process: { state: "alive" },
    agent: { state: agent },
    playbook: { state: "in_progress" },
    adapter: "omp",
    message_adapter: "unsupported",
  },
  checkpoint: {},
});

const playbookSummary = (over: Partial<PlaybookSummary> = {}): PlaybookSummary =>
  ({
    key: "superdevelop",
    title: "SuperDevelop",
    description: "",
    kind: "linear",
    default_harness: "claude",
    steps: [],
    auto_advance: [],
    ...over,
  }) as PlaybookSummary;

const step = (over: Partial<PlaybookStepSummary> = {}): PlaybookStepSummary =>
  ({
    key: "research",
    title: "Research",
    short: "",
    artifact: "",
    column: "",
    harness: "",
    ...over,
  }) as PlaybookStepSummary;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  scenario.task = { ...parentTask };
  scenario.relatedTasks = [];
  scenario.state = state();
  scenario.sessions = [];
  scenario.childActivity = {
    status: null,
    active_session: null,
  };
  scenario.childBoardTask = { ...childBoardTask };
  scenario.managerObservation = null;
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
  });
  ipcSpies.startSubtaskManager.mockResolvedValue({ ...manager });
  ipcSpies.recoverSubtaskManager.mockResolvedValue({ ...manager, subtask_slug: "child" });
  ipcSpies.restoreTaskForRepo.mockReset().mockResolvedValue(undefined);
  ipcSpies.archiveSessionForRepo.mockReset();
  ipcSpies.discardSubtask.mockImplementation(async () => {
    const child = scenario.state.active_subtask;
    scenario.task = { ...scenario.task, active_subtask: "" };
    scenario.state = state();
    if (child) {
      scenario.relatedTasks = [
        {
          ...childBoardTask,
          ...child,
          parent_task: scenario.task.slug,
          archived: true,
          subtask_outcome: "killed",
        },
      ];
      scenario.sessions = scenario.sessions.map((session) => (session.subtask_manager ? { ...session, ended_at: 20, exit_code: -15 } : session));
    } else {
      scenario.sessions = [];
    }
  });
  confirmSpies.confirmDanger.mockResolvedValue(true);
  mocks.getTask.mockReset().mockImplementation(async (slug: string) => (slug === scenario.task.slug ? scenario.task : null));
  mocks.listTasks.mockReset().mockImplementation(async () => [scenario.task, ...scenario.relatedTasks]);
  mocks.subtaskState.mockReset().mockImplementation(async () => scenario.state);
  mocks.listTaskActivity
    .mockReset()
    .mockImplementation(async (refs: TaskActivityRef[]) => Object.fromEntries(refs.map((ref) => [`${ref.repoPath}:${ref.taskSlug}`, scenario.childActivity])));
  mocks.listBoardTasks.mockReset().mockImplementation(async () => [scenario.childBoardTask]);
  mocks.listPlaybooks.mockReset().mockResolvedValue([]);
  mocks.listPlaybookSteps.mockReset().mockResolvedValue([]);
  mocks.listSessions.mockReset().mockImplementation(async () => scenario.sessions);
  mocks.listArtifactsWithMetadata.mockReset().mockResolvedValue([]);
  mocks.listTaskArtifactTree.mockReset().mockResolvedValue([]);
  mocks.listArtifactCommentDrafts.mockReset().mockResolvedValue([]);
  mocks.sessionStatuses.mockReset().mockImplementation(async (ids: string[]) =>
    Object.fromEntries(
      ids.map((id) => [
        id,
        scenario.managerObservation ?? {
          lifecycle: { state: "never_started" as const },
          state: null,
          checkpoint: {},
        },
      ]),
    ),
  );
  mocks.sessionStatus.mockReset().mockResolvedValue({ lifecycle: { state: "never_started" }, state: null, checkpoint: {} });
  mocks.worktreeExists.mockReset().mockResolvedValue(true);
  mocks.markSessionNotificationRead.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderDetail(slug = "parent") {
  const onOpenSession = vi.fn();
  const onOpenRelatedTask = vi.fn();
  const onNewSession = vi.fn();
  render(
    <TaskDetail
      slug={slug}
      repoPath="/repo"
      onBack={() => {}}
      onOpenSession={onOpenSession}
      onOpenRelatedTask={onOpenRelatedTask}
      onNewSession={onNewSession}
      onDuplicate={() => {}}
      duplicating={false}
      registerNav={() => {}}
      appearance={DEFAULT_APPEARANCE}
      onAppearanceChange={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: scenario.task.name });
  return { onOpenSession, onOpenRelatedTask, onNewSession };
}

describe("task session archive pending feedback", () => {
  it("keeps the session pending until IPC settles and exposes errors before retry", async () => {
    scenario.sessions = [session({ id: "archive-me" })];
    const pending = deferred<void>();
    ipcSpies.archiveSessionForRepo.mockReturnValue(pending.promise);
    await renderDetail();
    const button = await screen.findByRole("button", { name: "Archive" });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect((screen.getByRole("button", { name: "Archiving session…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(ipcSpies.archiveSessionForRepo).toHaveBeenCalledTimes(1);
    expect(ipcSpies.archiveSessionForRepo).toHaveBeenCalledWith("/repo", "parent", "archive-me");
    await act(async () => pending.reject(new Error("daemon timed out")));
    expect(screen.getByText("Couldn't archive the session.")).toBeDefined();
    expect(screen.getByText("Error: daemon timed out")).toBeDefined();
    expect((screen.getByRole("button", { name: "Archive" }) as HTMLButtonElement).disabled).toBe(false);

    const retry = deferred<void>();
    ipcSpies.archiveSessionForRepo.mockReturnValue(retry.promise);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(ipcSpies.archiveSessionForRepo).toHaveBeenCalledTimes(2);
    scenario.sessions = [session({ id: "archive-me", archived: true })];
    await act(async () => retry.resolve());
    expect(screen.queryByText("archive-me")).toBeNull();
    expect(screen.queryByRole("button", { name: "Archiving session…" })).toBeNull();
  });
});

describe("removed distill surfaces", () => {
  it("keeps a historical session visible without offering Distill or a Wiki tab", async () => {
    scenario.sessions = [session({ id: "historical", playbook: "superdevelop", phase: "distill-to-wiki" })];
    await renderDetail();
    const artifacts = screen.getByRole("button", { name: "Artifacts" });
    expect(artifacts.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(artifacts);
    expect(artifacts.getAttribute("aria-pressed")).toBe("true");

    expect(screen.getByText(/distill-to-wiki/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Distill" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Wiki" })).toBeNull();
    expect(ipcSpies.createSessionForRepo).not.toHaveBeenCalled();
  });
});

describe("Task Detail sub-task manager projection", () => {
  it("keeps Start visible with the backend reason and leaves New session usable", async () => {
    scenario.state = state({
      active_subtask: childSummary,
      manager_session: { ...manager, subtask_slug: "child" },
      can_start: false,
      disabled_reason: "Finish the active sub-task before starting another",
    });
    scenario.sessions = [{ ...manager, subtask_slug: "child" }];

    const { onNewSession } = await renderDetail();
    const start = screen.getByRole("button", { name: "Start sub-task" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    expect(start.getAttribute("title")).toBe("Finish the active sub-task before starting another");
    expect(screen.getByText("Finish the active sub-task before starting another")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(onNewSession).toHaveBeenCalledOnce();
  });

  it("starts exactly one parent-owned manager and opens it with spawn intent", async () => {
    const { onOpenSession } = await renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "Start sub-task" }));

    await waitFor(() => expect(ipcSpies.startSubtaskManager).toHaveBeenCalledOnce());
    expect(ipcSpies.startSubtaskManager).toHaveBeenCalledWith("parent");
    expect(onOpenSession).toHaveBeenCalledWith("parent", "manager-1", "/worktrees/parent", "", "claude", "sonnet", "", true, "spawn");
  });

  it("projects an unbound manager once as Sub-task setup instead of a Generic session", async () => {
    scenario.state = state({ manager_session: manager, can_start: false, disabled_reason: "A sub-task setup manager already exists" });
    scenario.sessions = [manager];
    const { onOpenSession } = await renderDetail();

    const setup = await screen.findByText("Sub-task setup");
    expect(screen.queryByText("Generic")).toBeNull();
    fireEvent.click(setup.closest("button") as HTMLButtonElement);
    expect(onOpenSession).toHaveBeenCalledWith("parent", "manager-1", "/worktrees/parent", "", "claude", "sonnet", "", true, "attach");
  });

  it("quiets an acknowledged failed sub-task manager row", async () => {
    let failedManager = { ...manager, started_at: 10, ended_at: 20, exit_code: 143 };
    scenario.state = state({ manager_session: failedManager, can_start: false, disabled_reason: "A sub-task setup manager already exists" });
    scenario.sessions = [failedManager];
    scenario.managerObservation = {
      lifecycle: { state: "exited", code: 143 },
      state: {
        process: { state: "exited", code: 143 },
        agent: { state: "idle" },
        playbook: { state: "failed", reason: "Process exited" },
        adapter: "omp",
        message_adapter: "unsupported",
      },
      checkpoint: {},
    };
    mocks.markSessionNotificationRead.mockImplementation(async (_repoPath: string, _taskSlug: string, id: string) => {
      if (id !== failedManager.id) return;
      failedManager = { ...failedManager, exit_notification_read_at: 20 };
      scenario.sessions = [failedManager];
      scenario.state = { ...scenario.state, manager_session: failedManager };
    });

    await renderDetail();

    const row = screen.getByText("Sub-task setup").closest("tr") as HTMLTableRowElement;
    expect(row.querySelector(".statusdot-failed")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge exited sessions" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Acknowledge exited sessions" })).toBeNull());
    expect(row.querySelector(".statusdot-failed")).toBeNull();
  });

  it.each([
    ["finished" as const, "FINISHED"],
    ["merged" as const, "MERGED"],
  ])("keeps a %s child as a task row backed by its manager session", async (outcome, outcomeLabel) => {
    scenario.relatedTasks = [
      {
        ...parentTask,
        name: "Child",
        slug: "child",
        requested_slug: "child",
        parent_task: "parent",
        branch: "child",
        worktree: "/worktrees/child",
        created: 2,
        archived: true,
        subtask_outcome: outcome,
      },
    ];
    scenario.sessions = [{ ...manager, subtask_slug: "child" }];
    const { onOpenSession, onOpenRelatedTask } = await renderDetail();

    const childLabel = await screen.findByText("Child", { selector: "span" });
    const childRow = childLabel.closest("tr") as HTMLTableRowElement;
    expect(screen.getByText(outcomeLabel)).toBeDefined();
    expect(screen.queryByText("manager-1")).toBeNull();
    expect(within(childRow).queryByRole("button", { name: "Kill sub-task" })).toBeNull();

    fireEvent.click(childLabel.closest("button") as HTMLButtonElement);
    expect(onOpenRelatedTask).toHaveBeenCalledWith("child");
    fireEvent.click(within(childRow).getByRole("button", { name: "Open manager session" }));
    expect(onOpenSession).toHaveBeenCalledWith("parent", "manager-1", "/worktrees/parent", "", "claude", "sonnet", "", true, "attach");
  });

  it.each(["merged", "finished", "killed"] as const)("warns that a %s child's still-open session may be stale", async (outcome) => {
    scenario.task = {
      ...parentTask,
      name: "Child",
      slug: "child",
      requested_slug: "child",
      parent_task: "parent",
      branch: "child",
      worktree: "/worktrees/child",
      archived: true,
      subtask_outcome: outcome,
    };
    scenario.relatedTasks = [{ ...parentTask }];
    scenario.state = state({
      task: { ...childSummary, archived: true, subtask_outcome: outcome },
      parent_task: parentTask,
      can_start: false,
      disabled_reason: "Archived tasks cannot start sub-tasks",
    });
    scenario.sessions = [session({ id: "still-live", worktree: "/worktrees/child" })];
    const { onOpenSession } = await renderDetail("child");

    expect(
      screen.getByText(
        `Finalized into Parent as ${outcome.toUpperCase()}. Any open session may be stale. Changes after finalization are not included in the parent snapshot or integrated result.`,
      ),
    ).toBeDefined();
    const sessionRow = screen.getByRole("row", { name: "Open session superdevelop · research" });
    expect(within(sessionRow).queryByRole("button", { name: "Open" })).toBeNull();
    fireEvent.click(sessionRow);
    expect(onOpenSession).toHaveBeenCalledWith("child", "still-live", "/worktrees/child", "research", "claude", "", "superdevelop", false);
    fireEvent.keyDown(sessionRow, { key: "Enter" });
    expect(onOpenSession).toHaveBeenCalledTimes(2);
  });

  it("keeps a finalized child in its manager session's existing list position", async () => {
    scenario.relatedTasks = [
      {
        ...parentTask,
        name: "Child",
        slug: "child",
        requested_slug: "child",
        parent_task: "parent",
        branch: "child",
        worktree: "/worktrees/child",
        created: 20,
        archived: true,
        subtask_outcome: "finished",
      },
    ];
    const ordinarySession = (id: string, created: number): SessionMeta => ({
      ...manager,
      id,
      created,
      generic: false,
      phase: created === 30 ? "build" : "research",
      subtask_manager: false,
      subtask_slug: "",
    });
    scenario.sessions = [ordinarySession("older-session", 10), { ...manager, id: "child-manager", created: 20, subtask_slug: "child" }, ordinarySession("newer-session", 30)];

    await renderDetail();
    const newerRow = screen.getByRole("row", { name: "Open session superdevelop · build" });
    const childRow = screen.getByText("Child", { selector: "span" }).closest("tr") as HTMLTableRowElement;
    const olderRow = screen.getByRole("row", { name: "Open session superdevelop · research" });
    expect([...(newerRow.parentElement?.children ?? [])]).toEqual([newerRow, childRow, olderRow]);
  });

  it("hard-deletes an unusable setup manager after explicit confirmation", async () => {
    scenario.state = state({ manager_session: manager, can_start: false, disabled_reason: "A sub-task setup manager already exists" });
    scenario.sessions = [manager];
    await renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "Discard setup" }));

    await waitFor(() =>
      expect(confirmSpies.confirmDanger).toHaveBeenCalledWith(
        "Discard sub-task setup?",
        "This will kill and permanently delete the Sub-task setup manager session.",
        "Discard setup",
      ),
    );
    await waitFor(() => expect(ipcSpies.discardSubtask).toHaveBeenCalledWith("parent", "manager-1"));
    await waitFor(() => expect(screen.queryByText("Sub-task setup")).toBeNull());
    expect((screen.getByRole("button", { name: "Start sub-task" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps setup state when destructive confirmation is declined", async () => {
    confirmSpies.confirmDanger.mockResolvedValue(false);
    scenario.state = state({ manager_session: manager, can_start: false, disabled_reason: "A sub-task setup manager already exists" });
    scenario.sessions = [manager];
    await renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "Discard setup" }));

    await waitFor(() => expect(confirmSpies.confirmDanger).toHaveBeenCalledOnce());
    expect(ipcSpies.discardSubtask).not.toHaveBeenCalled();
    expect(screen.getByText("Sub-task setup")).toBeDefined();
  });

  it("kills a bound child and keeps its task and manager as historical records", async () => {
    scenario.task = { ...parentTask, active_subtask: "child" };
    scenario.state = state({
      active_subtask: childSummary,
      manager_session: { ...manager, subtask_slug: "child" },
      can_start: false,
      disabled_reason: "Finish child",
    });
    scenario.sessions = [{ ...manager, subtask_slug: "child" }];
    const { onOpenRelatedTask } = await renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "Kill sub-task" }));

    await waitFor(() =>
      expect(confirmSpies.confirmDanger).toHaveBeenCalledWith(
        "Kill Child?",
        "This will stop every live session in Child and its active nested sub-tasks. Their task records, sessions, artifacts, worktrees, and branches will remain available as killed history.",
        "Kill sub-task",
      ),
    );
    await waitFor(() => expect(ipcSpies.discardSubtask).toHaveBeenCalledWith("parent", "manager-1"));
    const childLabel = await screen.findByText("Child", { selector: "span" });
    const childRow = childLabel.closest("tr") as HTMLTableRowElement;
    expect(within(childRow).getByText("KILLED")).toBeDefined();
    expect(within(childRow).queryByRole("button", { name: "Kill sub-task" })).toBeNull();
    expect(within(childRow).getByRole("button", { name: "Open manager session" })).toBeDefined();
    fireEvent.click(childLabel.closest("button") as HTMLButtonElement);
    expect(onOpenRelatedTask).toHaveBeenCalledWith("child");
  });
  it("routes a child row to the child and its nested action to the parent-owned manager", async () => {
    scenario.state = state({ active_subtask: childSummary, manager_session: { ...manager, subtask_slug: "child" }, can_start: false, disabled_reason: "Finish child" });
    scenario.sessions = [{ ...manager, subtask_slug: "child" }];
    const { onOpenSession, onOpenRelatedTask } = await renderDetail();

    const childLabel = await screen.findByText("Child", { selector: "span" });
    fireEvent.click(childLabel.closest("button") as HTMLButtonElement);
    expect(onOpenRelatedTask).toHaveBeenCalledWith("child");
    expect(onOpenSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open manager session" }));
    expect(onOpenSession).toHaveBeenCalledWith("parent", "manager-1", "/worktrees/parent", "", "claude", "sonnet", "", true, "attach");
    expect(onOpenRelatedTask).toHaveBeenCalledOnce();
  });

  it("shows the manager status and the child's nested playbook status", async () => {
    scenario.state = state({
      active_subtask: childSummary,
      manager_session: { ...manager, subtask_slug: "child" },
      can_start: false,
      disabled_reason: "Finish child",
    });
    scenario.sessions = [{ ...manager, subtask_slug: "child" }];
    scenario.managerObservation = {
      lifecycle: { state: "live" },
      state: {
        process: { state: "alive" },
        agent: { state: "idle" },
        playbook: { state: "in_progress" },
        adapter: "omp",
        message_adapter: "omp_bracketed_paste",
      },
      checkpoint: {},
    };
    scenario.childActivity = { ...scenario.childActivity, status: "running" };

    await renderDetail();

    expect(await screen.findByTitle("Agent turn complete — idle")).toBeDefined();
    expect(screen.getByTitle("Child playbook: Review · Review Context. Status: Running")).toBeDefined();
    expect(screen.getByTitle("Highest-priority session is running")).toBeDefined();
  });

  it("shows the immediate parent only as a breadcrumb, not a child session row", async () => {
    scenario.task = { ...parentTask, name: "Child", slug: "child", parent_task: "parent", branch: "child", worktree: "/worktrees/child" };
    scenario.state = state({
      task: childSummary,
      parent_task: parentTask,
      parent_manager_session: { ...manager, subtask_slug: "child" },
      parent_manager_owner_task_slug: "parent",
      manager_owner_task_slug: "child",
    });
    const { onOpenSession, onOpenRelatedTask } = await renderDetail("child");

    expect(screen.getByText("No sessions yet.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Open manager session" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "← Parent task · Parent" }));
    expect(onOpenRelatedTask).toHaveBeenCalledWith("parent");
    expect(onOpenSession).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Start sub-task" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers recovery on the active child row without starting a replacement on render", async () => {
    const unavailableManager = { ...manager, subtask_slug: "child", started_at: 10, ended_at: 20, exit_code: 0 };
    scenario.state = state({
      active_subtask: childSummary,
      manager_session: unavailableManager,
      can_start: false,
      can_recover: true,
      disabled_reason: "Finish child",
    });
    scenario.sessions = [unavailableManager, session({ id: "unrelated", created: 1 })];
    const { onOpenSession } = await renderDetail();
    expect(ipcSpies.recoverSubtaskManager).not.toHaveBeenCalled();

    const childRow = screen.getByText("Child", { selector: "span" }).closest("tr") as HTMLTableRowElement;
    expect(within(childRow).getByText("Manager unavailable")).toBeDefined();
    const replace = within(childRow).getByRole("button", { name: "Replace manager session" });
    expect(screen.getAllByRole("button", { name: "Replace manager session" })).toHaveLength(1);
    fireEvent.click(replace);
    await waitFor(() => expect(ipcSpies.recoverSubtaskManager).toHaveBeenCalledWith("parent"));
    expect(onOpenSession).toHaveBeenCalledWith("parent", "manager-1", "/worktrees/parent", "", "claude", "sonnet", "", true, "spawn");
  });

  it("kills an active child without a manager and keeps a task-backed history row", async () => {
    scenario.task = { ...parentTask, active_subtask: "child" };
    scenario.state = state({ active_subtask: childSummary, can_start: false, can_recover: true, disabled_reason: "Finish child" });
    const { onOpenRelatedTask } = await renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "Kill sub-task" }));

    await waitFor(() => expect(ipcSpies.discardSubtask).toHaveBeenCalledWith("parent", ""));
    expect(ipcSpies.recoverSubtaskManager).not.toHaveBeenCalled();
    const childLabel = await screen.findByText("Child", { selector: "span" });
    const childRow = childLabel.closest("tr") as HTMLTableRowElement;
    expect(within(childRow).getByText("KILLED")).toBeDefined();
    expect(within(childRow).getByText("Sub-task history")).toBeDefined();
    expect(within(childRow).queryByRole("button", { name: "Open manager session" })).toBeNull();
    fireEvent.click(childLabel.closest("button") as HTMLButtonElement);
    expect(onOpenRelatedTask).toHaveBeenCalledWith("child");
  });

  it("refreshes relationship pointers and manager rows during polling", async () => {
    vi.useFakeTimers();
    const renderPromise = renderDetail();
    await vi.waitFor(() => expect(screen.getByRole("heading", { name: "Parent" })).toBeDefined());
    await renderPromise;
    expect(screen.queryByText("Child", { selector: "span" })).toBeNull();

    scenario.task = { ...parentTask, active_subtask: "child" };
    scenario.state = state({ active_subtask: childSummary, manager_session: { ...manager, subtask_slug: "child" }, can_start: false, disabled_reason: "Finish child" });
    scenario.sessions = [{ ...manager, subtask_slug: "child" }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await vi.waitFor(() => expect(screen.getByText("Child", { selector: "span" })).toBeDefined());

    expect(screen.getByText("Child", { selector: "span" })).toBeDefined();
    expect((screen.getByRole("button", { name: "Start sub-task" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

const noop = () => {};

function renderSeededDetail(props: Partial<Parameters<typeof TaskDetail>[0]> = {}) {
  return render(
    <TaskDetail
      slug={props.slug ?? "a-task"}
      repoPath="/r"
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

describe("TaskDetail seeds from initialTask before any ipc call resolves", () => {
  it("shows the header, branch and worktree synchronously", () => {
    const fixture = task();
    renderSeededDetail({ initialTask: fixture });
    // Load-bearing: no `await`/`waitFor`/`act` between render and this assertion.
    expect(screen.getByText(fixture.name)).toBeDefined();
    expect(screen.getByText(fixture.branch)).toBeDefined();
    expect(screen.getByText(fixture.worktree)).toBeDefined();
  });

  it("seeds PR URL from initialTask.pr_url", () => {
    const fixture = task({ pr_url: "https://github.com/x/y/pull/1" });
    renderSeededDetail({ initialTask: fixture });
    expect(screen.getByText(fixture.pr_url)).toBeDefined();
  });

  it("renders the existing slug-only shell when initialTask is omitted", () => {
    renderSeededDetail({ slug: "no-seed-task" });
    expect(screen.getByText("no-seed-task")).toBeDefined();
  });
});

describe("archived task recovery action", () => {
  it("shows Restore task instead of Archive task for an archived top-level task", () => {
    renderSeededDetail({
      initialTask: task({ archived: true, parent_task: "" }),
    });

    expect(screen.getByRole("button", { name: "Restore task" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Archive task" })).toBeNull();
  });

  it.each(["merged", ""] as const)("explains why an archived child with outcome %j cannot be restored", (subtaskOutcome) => {
    renderSeededDetail({
      initialTask: task({
        archived: true,
        parent_task: "parent",
        subtask_outcome: subtaskOutcome,
      }),
    });

    const restore = screen.getByRole("button", { name: "Restore task" }) as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    expect(restore.title).toBe("Sub-tasks cannot be restored.");
    expect(screen.getByText("Sub-tasks cannot be restored.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Archive task" })).toBeNull();
  });

  it("sends the displayed repository and slug immediately", async () => {
    const pending = deferred<void>();
    const fixture = task({ archived: true, parent_task: "" });
    scenario.task = fixture;
    scenario.state = state({ task: fixture });
    ipcSpies.restoreTaskForRepo.mockReturnValue(pending.promise);
    renderSeededDetail({ repoPath: "/repo-b", slug: fixture.slug, initialTask: fixture });

    fireEvent.click(screen.getByRole("button", { name: "Restore task" }));

    expect(ipcSpies.restoreTaskForRepo).toHaveBeenCalledOnce();
    expect(ipcSpies.restoreTaskForRepo).toHaveBeenCalledWith("/repo-b", fixture.slug);
    expect(confirmSpies.confirmDanger).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "Restoring…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
  });

  it("keeps Task Detail mounted and resumes active controls after restore", async () => {
    const fixture = task({ archived: true, parent_task: "" });
    const onBack = vi.fn();
    const onNewSession = vi.fn();
    scenario.task = fixture;
    scenario.state = state({ task: fixture });
    ipcSpies.restoreTaskForRepo.mockImplementation(async () => {
      scenario.task = { ...scenario.task, archived: false };
    });
    renderSeededDetail({ repoPath: "/repo-b", slug: fixture.slug, initialTask: fixture, onBack, onNewSession });

    fireEvent.click(screen.getByRole("button", { name: "Restore task" }));

    await screen.findByRole("button", { name: "Archive task" });
    expect(screen.getByRole("button", { name: "New session" })).toBeDefined();
    expect(screen.getByText(fixture.branch)).toBeDefined();
    expect(toastSpies.toast).toHaveBeenCalledOnce();
    expect(toastSpies.toast).toHaveBeenCalledWith("Task restored", "success");
    expect(onBack).not.toHaveBeenCalled();
  });

  it("keeps post-restore sub-task controls when an older archived response completes", async () => {
    const fixture = task({ archived: true, parent_task: "" });
    const staleState = deferred<SubtaskManagerState>();
    const activeReason = "A sub-task manager is already active";
    const restoredState = state({
      task: { ...fixture, archived: false },
      can_start: false,
      disabled_reason: activeReason,
    });
    scenario.task = fixture;
    scenario.state = state({
      task: fixture,
      can_start: false,
      disabled_reason: "Archived tasks cannot start sub-tasks",
    });
    mocks.subtaskState
      .mockReset()
      .mockImplementationOnce(() => staleState.promise)
      .mockResolvedValueOnce(restoredState);
    ipcSpies.restoreTaskForRepo.mockImplementation(async () => {
      scenario.task = { ...scenario.task, archived: false };
    });
    renderSeededDetail({ slug: fixture.slug, initialTask: fixture });

    fireEvent.click(screen.getByRole("button", { name: "Restore task" }));

    await waitFor(() => expect(mocks.subtaskState).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(activeReason)).toBeDefined();
    const startButton = screen.getByRole("button", { name: "Start sub-task" }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(true);
    expect(startButton.title).toBe(activeReason);

    await act(async () => {
      staleState.resolve(scenario.state);
      await staleState.promise;
    });

    expect(screen.getByText(activeReason)).toBeDefined();
    expect(screen.queryByText("Archived tasks cannot start sub-tasks")).toBeNull();
  });

  it("keeps archived state and persistent backend detail after failure", async () => {
    const fixture = task({ archived: true, parent_task: "" });
    scenario.task = fixture;
    scenario.state = state({ task: fixture });
    ipcSpies.restoreTaskForRepo.mockRejectedValue(new Error("disk full"));
    renderSeededDetail({ initialTask: fixture });

    fireEvent.click(screen.getByRole("button", { name: "Restore task" }));

    expect(await screen.findByText("Couldn't restore the task.")).toBeDefined();
    expect(screen.getByText(/disk full/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Restore task" })).toBeDefined();
    expect(toastSpies.toast).not.toHaveBeenCalled();
  });

  it("guides continuation through a related task when the worktree was removed", async () => {
    const fixture = task({ archived: true, parent_task: "", has_worktree: true, worktree: "" });
    scenario.task = fixture;
    scenario.state = state({ task: fixture });
    ipcSpies.restoreTaskForRepo.mockImplementation(async () => {
      scenario.task = { ...scenario.task, archived: false };
    });
    renderSeededDetail({ initialTask: fixture });

    expect(screen.getByText("Task archived; worktree removed. Restoring keeps it available for history and related-task links, but new sessions remain disabled.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Restore task" }));

    await screen.findByRole("button", { name: "Archive task" });
    expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
    expect(screen.getByText("Worktree removed — new sessions are disabled. Create a new task, tag this one as related, and continue the work there.")).toBeDefined();
  });
});

describe("keying by slug", () => {
  it("remounts on slug change instead of keeping the previous task's rows", () => {
    const taskA = task({ slug: "a", name: "Task A", branch: "branch-a" });
    const taskB = task({ slug: "b", name: "Task B", branch: "branch-b" });
    const { rerender } = render(
      <TaskDetail
        key="task:a"
        slug="a"
        repoPath="/r"
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

    // Simulates what App.tsx does at the render site: a fresh `key` forces a fresh mount.
    rerender(
      <TaskDetail
        key="task:b"
        slug="b"
        repoPath="/r"
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
    expect(screen.queryByText("Task A")).toBeNull();
    expect(screen.getByText("Task B")).toBeDefined();
  });
});

describe("load() wave + dependent tail", () => {
  it("fires exactly one listPlaybookSteps call for the common case", async () => {
    const fixture = task({ playbook: "superdevelop" });
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listPlaybooks.mockResolvedValue([playbookSummary({ key: "superdevelop", title: "SuperDevelop" })]);
    mocks.listSessions.mockResolvedValue([session({ id: "s1", playbook: "superdevelop", phase: "research" })]);

    renderSeededDetail({ initialTask: fixture });

    await waitFor(() => expect(mocks.listPlaybookSteps).toHaveBeenCalled());
    expect(mocks.listPlaybookSteps).toHaveBeenCalledTimes(1);
    expect(mocks.listPlaybookSteps).toHaveBeenCalledWith("superdevelop");
  });

  it("fetches steps a second time only for a genuinely foreign session playbook", async () => {
    const fixture = task({ playbook: "superdevelop" });
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listPlaybooks.mockResolvedValue([playbookSummary({ key: "superdevelop", title: "SuperDevelop" })]);
    mocks.listSessions.mockResolvedValue([
      session({ id: "s1", playbook: "superdevelop", phase: "research" }),
      session({ id: "s2", playbook: "custom-flow", phase: "custom-step" }),
    ]);
    mocks.listPlaybookSteps.mockImplementation(async (key: string) => {
      if (key === "custom-flow") return [step({ key: "custom-step", title: "Custom Step" })];
      return [step({ key: "research", title: "Research" })];
    });

    renderSeededDetail({ initialTask: fixture });

    await waitFor(() => expect(mocks.listPlaybookSteps).toHaveBeenCalledTimes(2));
    const calledKeys = mocks.listPlaybookSteps.mock.calls.map((c: unknown[]) => c[0]);
    expect(calledKeys.sort()).toEqual(["custom-flow", "superdevelop"]);
    // The merge into playbookDetails actually landed before render, not just that the call fired.
    await waitFor(() => expect(screen.getByText(/Custom Step/)).toBeDefined());
  });

  it("de-duplicates two sessions sharing the same foreign playbook into one tail fetch", async () => {
    const fixture = task({ playbook: "superdevelop" });
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listPlaybooks.mockResolvedValue([playbookSummary({ key: "superdevelop", title: "SuperDevelop" })]);
    mocks.listSessions.mockResolvedValue([
      session({ id: "s1", playbook: "custom-flow", phase: "custom-step" }),
      session({ id: "s2", playbook: "custom-flow", phase: "custom-step" }),
    ]);

    renderSeededDetail({ initialTask: fixture });

    await waitFor(() => expect(mocks.listPlaybookSteps).toHaveBeenCalledTimes(2));
    const customCalls = mocks.listPlaybookSteps.mock.calls.filter((c: unknown[]) => c[0] === "custom-flow");
    expect(customCalls.length).toBe(1);
  });

  it("falls back to the fetched task's real playbook when the seed is stale", async () => {
    // initialTask (the seed) guesses "one-shot"; the fetched task's real playbook is "superdevelop".
    const seed = task({ playbook: "one-shot" });
    const fetched = task({ playbook: "superdevelop" });
    mocks.getTask.mockResolvedValue(fetched);
    mocks.listPlaybooks.mockResolvedValue([playbookSummary({ key: "superdevelop", title: "SuperDevelop" }), playbookSummary({ key: "one-shot", title: "One Shot" })]);
    mocks.listPlaybookSteps.mockImplementation(async (key: string) =>
      key === "superdevelop" ? [step({ key: "impl", title: "Implement" })] : [step({ key: "guess", title: "Guessed Step" })],
    );

    renderSeededDetail({ initialTask: seed });

    await waitFor(() => expect(mocks.listPlaybookSteps).toHaveBeenCalledWith("superdevelop"));
    // The rendered pipeline comes from the fetched playbook's steps, not the stale seed's guess.
    await waitFor(() => expect(screen.getAllByText("Implement").length).toBeGreaterThan(0));
    expect(screen.queryByText("Guessed Step")).toBeNull();
  });
});

describe("Task Detail duplicate action", () => {
  it("routes both button and nav duplication through the loaded task", async () => {
    const source = task({
      name: "Archived source",
      slug: "source",
      requested_slug: "source",
      branch: "source",
      worktree: "",
      archived: true,
    });
    mocks.getTask.mockResolvedValue(source);
    const onDuplicate = vi.fn();
    let nav: BoardNav | null = null;
    const rendered = renderSeededDetail({
      slug: source.slug,
      onDuplicate,
      duplicating: false,
      registerNav: (next: BoardNav | null) => {
        if (next) nav = next;
      },
    });
    const button = await screen.findByTitle("Duplicate task (⌘D)");

    expect(button.textContent).toContain("Duplicate Task · ⌘D");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(onDuplicate).toHaveBeenLastCalledWith(source);

    await navReady(() => nav);
    act(() => requireNav(nav).duplicateSelected());
    expect(onDuplicate).toHaveBeenCalledTimes(2);
    expect(onDuplicate).toHaveBeenLastCalledWith(source);

    rendered.rerender(
      <TaskDetail
        slug={source.slug}
        repoPath="/r"
        onBack={noop}
        onOpenSession={noop}
        onNewSession={noop}
        onOpenRelatedTask={noop}
        onDuplicate={onDuplicate}
        duplicating
        registerNav={(next: BoardNav | null) => {
          if (next) nav = next;
        }}
        appearance={DEFAULT_APPEARANCE}
        onAppearanceChange={noop}
      />,
    );
    await waitFor(() => expect((screen.getByTitle("Duplicate task (⌘D)") as HTMLButtonElement).disabled).toBe(true));
  });
});

const renderedSessionSteps = (container: HTMLElement) =>
  [...container.querySelectorAll(".task-session-table tbody .session-step-cell > .pill:first-child")].map((node) => node.textContent);

describe("session list without identifiers", () => {
  it("keeps same-step sessions independently openable and preserves archived history and resumed state", async () => {
    const fixture = task();
    const archived = session({ id: "opaque-archived", archived: true, created: 10 });
    const resumed = session({ id: "opaque-resumed", resume_of: archived.id, created: 20 });
    const newest = session({ id: "opaque-newest", created: 30 });
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listSessions.mockResolvedValue([archived, resumed, newest]);
    mocks.sessionStatuses.mockResolvedValue({});
    const onOpenSession = vi.fn();
    const { container } = renderSeededDetail({ initialTask: fixture, onOpenSession });

    fireEvent.click(screen.getByRole("checkbox", { name: "Show archived" }));
    const history = await screen.findByRole("button", { name: "View history" });
    const table = container.querySelector(".task-session-table") as HTMLTableElement;
    expect(within(table).queryByRole("columnheader", { name: "Session" })).toBeNull();
    for (const row of [archived, resumed, newest]) {
      expect(table.textContent).not.toContain(row.id);
      expect(table.querySelector(`[title*="${row.id}"], [aria-label*="${row.id}"]`)).toBeNull();
    }
    const archivedRow = history.closest("tr") as HTMLTableRowElement;
    expect(within(archivedRow).getByText("Archived")).toBeDefined();
    expect(within(archivedRow).getByText("Resumed")).toBeDefined();
    expect(archivedRow.hasAttribute("tabindex")).toBe(false);

    const openable = within(table).getAllByRole("row", { name: "Open session superdevelop · research" });
    fireEvent.click(openable[0]);
    expect(onOpenSession.mock.lastCall?.[1]).toBe(newest.id);
    fireEvent.keyDown(openable[1], { key: "Enter" });
    expect(onOpenSession.mock.lastCall?.[1]).toBe(resumed.id);
    fireEvent.keyDown(openable[0], { key: " " });
    expect(onOpenSession.mock.lastCall?.[1]).toBe(newest.id);
    fireEvent.click(history);
    expect(onOpenSession).toHaveBeenLastCalledWith(
      "a-task",
      archived.id,
      archived.worktree,
      archived.phase,
      archived.harness,
      archived.model,
      archived.playbook,
      archived.generic,
      "history",
    );
  });
});

describe("attention-first session order", () => {
  it("renders an older running session above a newer settled session from one status batch", async () => {
    const fixture = task();
    const backendRows = Object.freeze([
      session({
        id: "newer-tdd",
        created: 20,
        phase: "tdd",
        semantic: { phase_completed_at: 20 },
        notification_read_at: 20,
      }),
      session({ id: "older-design", created: 10, phase: "design" }),
    ]);
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listPlaybooks.mockResolvedValue([playbookSummary()]);
    mocks.listPlaybookSteps.mockResolvedValue([step({ key: "design", title: "Design" }), step({ key: "tdd", title: "TDD" })]);
    mocks.listSessions.mockResolvedValue(backendRows);
    mocks.sessionStatuses.mockResolvedValue({
      "older-design": observation("busy"),
      "newer-tdd": { ...observation("idle"), lifecycle: { state: "exited", code: 0 }, state: null },
    });

    const { container } = renderSeededDetail({ initialTask: fixture });

    await waitFor(() => {
      expect(renderedSessionSteps(container)).toEqual(["SuperDevelop · Design", "SuperDevelop · TDD"]);
    });
    expect(mocks.sessionStatuses).toHaveBeenCalledTimes(1);
    expect(mocks.sessionStatuses).toHaveBeenCalledWith(["newer-tdd", "older-design"], "a-task");
    expect(backendRows.map((row) => row.id)).toEqual(["newer-tdd", "older-design"]);
  });

  it("marks the exact session whose accepted completion is unread", async () => {
    const fixture = task();
    const unread = session({ id: "unread-design", created: 20, phase: "design", semantic: { phase_completed_at: 100 } });
    const acknowledged = session({
      id: "read-tdd",
      created: 10,
      phase: "tdd",
      semantic: { phase_completed_at: 90 },
      notification_read_at: 90,
    });
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listPlaybooks.mockResolvedValue([playbookSummary()]);
    mocks.listPlaybookSteps.mockResolvedValue([step({ key: "design", title: "Design" }), step({ key: "tdd", title: "TDD" })]);
    mocks.listSessions.mockResolvedValue([unread, acknowledged]);
    mocks.sessionStatuses.mockResolvedValue({
      "unread-design": {
        lifecycle: { state: "exited", code: 0 },
        state: null,
        checkpoint: { phase_completed_at: 100 },
      },
      "read-tdd": {
        lifecycle: { state: "exited", code: 0 },
        state: null,
        checkpoint: { phase_completed_at: 90 },
      },
    });

    renderSeededDetail({ initialTask: fixture });

    const unreadRow = await screen.findByRole("row", { name: "Open session SuperDevelop · Design" });
    const acknowledgedRow = screen.getByRole("row", { name: "Open session SuperDevelop · TDD" });
    expect(within(unreadRow).getByRole("img", { name: "Unread completion" })).toBeDefined();
    expect(within(acknowledgedRow).queryByRole("img", { name: "Unread completion" })).toBeNull();
  });

  it("offers acknowledgment only for unacknowledged exits and mutes them after acknowledgment", async () => {
    const fixture = task();
    let stopped = session({ id: "stopped-generic", created: 20, generic: true, phase: "", ended_at: 100, exit_code: 143 });
    const idle = session({ id: "current-structure", created: 30, phase: "structure" });
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listPlaybooks.mockResolvedValue([playbookSummary()]);
    mocks.listPlaybookSteps.mockResolvedValue([step({ key: "structure", title: "Structure" })]);
    mocks.listSessions.mockImplementation(async () => [idle, stopped]);
    mocks.markSessionNotificationRead.mockImplementation(async (_repoPath: string, _taskSlug: string, id: string) => {
      if (id === stopped.id) stopped = { ...stopped, exit_notification_read_at: 100 };
    });
    mocks.sessionStatuses.mockResolvedValue({
      "stopped-generic": {
        lifecycle: { state: "exited", code: 143 },
        state: null,
        checkpoint: {},
      },
      "current-structure": observation("idle"),
    });

    const { container } = renderSeededDetail({ initialTask: fixture });

    await waitFor(() => {
      expect(renderedSessionSteps(container)).toEqual(["Generic", "SuperDevelop · Structure"]);
    });
    const acknowledge = screen.getByRole("button", { name: "Acknowledge exited sessions" });
    const stoppedRow = screen.getByRole("row", { name: "Open session Generic" });
    expect(within(stoppedRow).getByRole("img", { name: "Failed: process exited with code 143" })).toBeDefined();

    fireEvent.click(acknowledge);

    await waitFor(() => expect(mocks.markSessionNotificationRead).toHaveBeenCalledWith("/r", "a-task", "stopped-generic"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Acknowledge exited sessions" })).toBeNull());
    expect(within(stoppedRow).queryByRole("img", { name: /Failed/ })).toBeNull();
    expect(stoppedRow.querySelector(".status-col")?.textContent).toBe("");
  });
});

describe("session time columns and sorting", () => {
  it("sorts Started newest-first then oldest-first, keeps missing last, and restores Priority", async () => {
    const fixture = task();
    const backendRows = Object.freeze([
      session({ id: "missing", phase: "clarify", created: 30, started_at: null }),
      session({ id: "older", phase: "design", created: 20, started_at: 100 }),
      session({ id: "newer", phase: "build", created: 10, started_at: 200 }),
    ]);
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listSessions.mockResolvedValue(backendRows);
    mocks.sessionStatuses.mockResolvedValue({});
    const { container } = renderSeededDetail({ initialTask: fixture });
    await waitFor(() => expect(renderedSessionSteps(container)).toEqual(["superdevelop · clarify", "superdevelop · design", "superdevelop · build"]));

    const started = screen.getByText("Started", { selector: ".session-sort-header" });
    fireEvent.click(started);
    await waitFor(() => expect(renderedSessionSteps(container)).toEqual(["superdevelop · build", "superdevelop · design", "superdevelop · clarify"]));
    expect(started.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    expect(started.textContent?.trim()).toBe("Started ↓");
    expect(container.querySelectorAll(".task-session-table tbody tr")[0].querySelector('[title^="Started "]')).not.toBeNull();

    fireEvent.click(started);
    await waitFor(() => expect(renderedSessionSteps(container)).toEqual(["superdevelop · design", "superdevelop · build", "superdevelop · clarify"]));
    expect(started.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    expect(started.textContent?.trim()).toBe("Started ↑");

    const priority = screen.getByRole("button", { name: "Priority" });
    fireEvent.click(priority);
    await waitFor(() => expect(renderedSessionSteps(container)).toEqual(["superdevelop · clarify", "superdevelop · design", "superdevelop · build"]));
    expect(priority.getAttribute("aria-pressed")).toBe("true");
    expect(started.closest("th")?.getAttribute("aria-sort")).toBeNull();
    expect(started.textContent?.trim()).toBe("Started");
  });

  it("keeps Updated active while a metadata poll moves a row", async () => {
    vi.useFakeTimers();
    const fixture = task();
    let rows = [session({ id: "a", phase: "design", created: 20, status_changed_at: 100 }), session({ id: "b", phase: "build", created: 10, status_changed_at: 200 })];
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listSessions.mockImplementation(async () => rows);
    mocks.sessionStatuses.mockResolvedValue({});
    const { container } = renderSeededDetail({ initialTask: fixture });
    await vi.waitFor(() => expect(renderedSessionSteps(container)).toEqual(["superdevelop · design", "superdevelop · build"]));
    const updated = screen.getByText("Updated", { selector: ".session-sort-header" });
    fireEvent.click(updated);
    expect(renderedSessionSteps(container)).toEqual(["superdevelop · build", "superdevelop · design"]);

    rows = [{ ...rows[0], status_changed_at: 300 }, rows[1]];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await vi.waitFor(() => expect(renderedSessionSteps(container)).toEqual(["superdevelop · design", "superdevelop · build"]));
    expect(updated.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    expect(updated.textContent?.trim()).toBe("Updated ↓");
    expect(screen.getByRole("button", { name: "Priority" }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(updated);
    expect(renderedSessionSteps(container)).toEqual(["superdevelop · build", "superdevelop · design"]);
    expect(updated.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    expect(updated.textContent?.trim()).toBe("Updated ↑");
  });

  it("accepts StaleSource failure-class transitions without leaving Updated sort", async () => {
    vi.useFakeTimers();
    const fixture = task();
    const rows = [session({ id: "target", phase: "design", created: 10, status_changed_at: 100 }), session({ id: "other", phase: "build", created: 20, status_changed_at: 200 })];
    const failedObservation = (reason: string): SessionObservation => ({
      lifecycle: { state: "live" },
      state: {
        process: { state: "alive" },
        agent: { state: "idle" },
        playbook: { state: "failed", reason },
        adapter: "omp",
        message_adapter: "unsupported",
      },
      checkpoint: {},
    });
    let targetObservation = failedObservation("StaleSource");
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listSessions.mockResolvedValue(rows);
    mocks.sessionStatuses.mockImplementation(async () => ({
      target: targetObservation,
    }));

    const { container } = renderSeededDetail({ initialTask: fixture });
    await vi.waitFor(() => expect(renderedSessionSteps(container)).toEqual(["superdevelop · build", "superdevelop · design"]));
    expect(screen.getByLabelText("Stale")).toBeDefined();

    targetObservation = failedObservation("boom");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await vi.waitFor(() => expect(renderedSessionSteps(container)).toEqual(["superdevelop · design", "superdevelop · build"]));
    expect(screen.getByText("Failed")).toBeDefined();

    const updated = screen.getByText("Updated", { selector: ".session-sort-header" });
    fireEvent.click(updated);
    expect(renderedSessionSteps(container)).toEqual(["superdevelop · build", "superdevelop · design"]);

    targetObservation = failedObservation("StaleSource");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await vi.waitFor(() => expect(screen.getByLabelText("Stale")).toBeDefined());
    expect(screen.queryByText("Failed")).toBeNull();
    expect(renderedSessionSteps(container)).toEqual(["superdevelop · build", "superdevelop · design"]);
    expect(updated.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    expect(screen.getByRole("button", { name: "Priority" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("sorts session-backed managers and aligns managerless rows with the remaining columns", async () => {
    scenario.relatedTasks = [
      {
        ...parentTask,
        name: "History child",
        slug: "history-child",
        parent_task: "parent",
        archived: true,
        subtask_outcome: "finished",
      },
    ];
    const currentManager = { ...manager, started_at: 200, status_changed_at: 200 };
    scenario.state = state({ manager_session: currentManager });
    scenario.sessions = [session({ id: "ordinary", started_at: 100, status_changed_at: 100 }), currentManager];
    await renderDetail();
    fireEvent.click(screen.getByText("Started", { selector: ".session-sort-header" }));

    await waitFor(() => expect(document.querySelectorAll(".task-session-table tbody tr")).toHaveLength(3));
    const rows = [...document.querySelectorAll(".task-session-table tbody tr")];
    expect(rows[0].textContent).toContain("Sub-task setup");
    expect(rows[1].textContent).toContain("superdevelop · research");
    expect(rows[2].textContent).toContain("History child");
    expect(rows[2].children).toHaveLength(screen.getAllByRole("columnheader").length);
    expect(rows[2].children[3].textContent).toBe("—");
    expect(rows[2].children[4].textContent).toBe("—");
  });
});

describe("the empty-sessions row", () => {
  it("never renders before load() settles, and appears once it does", async () => {
    const fixture = task();
    const getTaskDeferred = deferred<Task | null>();
    const listSessionsDeferred = deferred<SessionMeta[]>();
    mocks.getTask.mockReturnValue(getTaskDeferred.promise);
    mocks.listSessions.mockReturnValue(listSessionsDeferred.promise);
    mocks.listPlaybooks.mockResolvedValue([]);
    mocks.listPlaybookSteps.mockResolvedValue([]);
    mocks.listArtifactsWithMetadata.mockResolvedValue([]);
    mocks.sessionStatuses.mockResolvedValue({});

    renderSeededDetail({ initialTask: fixture });

    // Even though `sessions` hasn't been fetched yet (state still `[]`), the `loaded` gate
    // must keep the empty row from flashing before load() settles.
    expect(screen.queryByText("No sessions yet.")).toBeNull();

    getTaskDeferred.resolve(fixture);
    listSessionsDeferred.resolve([]);

    await waitFor(() => expect(screen.getByText("No sessions yet.")).toBeDefined());
  });
});

describe("a get_task error", () => {
  it("surfaces in the error bar without hiding the seeded header", async () => {
    const fixture = task();
    mocks.getTask.mockRejectedValue(new Error("parse task.md: bad toml"));

    renderSeededDetail({ initialTask: fixture });

    await waitFor(() => expect(screen.getByText(/parse task\.md: bad toml/)).toBeDefined());
    // The seeded header must survive the error — a regression here (e.g. an unguarded
    // `.catch` that also clears `task`) would blank it.
    expect(screen.getByText(fixture.name)).toBeDefined();
  });
});
