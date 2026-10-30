import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ComponentProps, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import type { QueuedFollowUp } from "../chat/queue";
import type * as Confirmation from "../confirm";
import type * as Ipc from "../ipc";
import type { SessionMessageDraft } from "../sessionMessage";
import { mockIpc } from "../test/mockIpc";
import { journalPage } from "../test/ompJournal";
import { stubScrollSize } from "../test/scroll";
import { Toast, toast } from "../toast";
import type { AgentState, ArtifactListItem, ArtifactTreeNode, DispatchOutcome, SessionDisplayMeta, SessionObservation, Task, TaskExecutionReply } from "../types";
import { executionRecord, executionReply, partiallyPublishedExecution } from "./executionTestFixture";
import { type SessionSendRecovery, SessionView } from "./SessionView";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

const scenario = vi.hoisted(() => ({
  itemCalls: 0,
  treeCalls: 0,
  taskCalls: 0,
  tasks: [] as Task[],
  tasksPromise: null as Promise<Task[]> | null,
  tasksError: null as Error | null,
  items: null as ArtifactListItem[] | null,
}));

const sessionStatus = vi.hoisted(() => vi.fn(async (): Promise<SessionObservation> => ({ lifecycle: { state: "exited", code: 0 }, state: null, checkpoint: {} })));
const sessionArtifactReady = vi.hoisted(() => vi.fn(async () => false));
const startSession = vi.hoisted(() => vi.fn(async () => undefined));
const restateSession = vi.hoisted(() => vi.fn(async () => undefined));
const rpcAttachSession = vi.hoisted(() => vi.fn(async (_args: unknown) => undefined));
const onStreamClosed = vi.hoisted(() => vi.fn((_id: string, _attachId: number, _onClosed: () => void, _onGiveUp: () => void) => () => {}));
const readSessionOmp = vi.hoisted(() => vi.fn(async (_args: unknown): Promise<ArrayBuffer> => Promise.reject(new Error("no journal"))));
const rpcWriteSession = vi.hoisted(() => vi.fn(async (_id: string, _payload: unknown): Promise<DispatchOutcome> => ({ status: "written" })));
const detachSession = vi.hoisted(() => vi.fn(async () => undefined));
const readOmpModelRoles = vi.hoisted(() => vi.fn(async () => ({}) as Record<string, string>));
const writeOmpModelRoles = vi.hoisted(() => vi.fn(async (roles: Record<string, string>) => roles));
const openUrl = vi.hoisted(() => vi.fn(async (_url: string | URL, _openWith?: string): Promise<void> => undefined));
const confirmDanger = vi.hoisted(() => vi.fn<typeof Confirmation.confirmDanger>(async () => true));
const askConfirm = vi.hoisted(() => vi.fn<typeof Confirmation.askConfirm>());
const confirmStopAndSwitch = vi.hoisted(() => vi.fn(async (_target: "pty" | "rpc") => true));
const archiveSession = vi.hoisted(() => vi.fn());
const pickAttachmentFilesDialog = vi.hoisted(() => vi.fn(async (): Promise<string[]> => []));
const chatFileStat = vi.hoisted(() => vi.fn(async (path: string) => ({ name: path.split("/").pop() ?? path, bytes: 12 })));
const copyChatAttachments = vi.hoisted(() => vi.fn(async () => ({ copied: [] as string[], failures: [] as string[] })));
const writeChatAttachmentBytes = vi.hoisted(() => vi.fn(async (_slug: string, fileName: string) => fileName));
const readChatImage = vi.hoisted(() => vi.fn(async (_taskSlug: string, _name: string) => ({ mime_type: "image/png", data: "aa" })));
const getTaskExecution = vi.hoisted(() => vi.fn());
const continueExecution = vi.hoisted(() => vi.fn());
const setStepContinuationForRepo = vi.hoisted(() => vi.fn());
const listSessions = vi.hoisted(() => vi.fn(async (): Promise<SessionDisplayMeta[]> => []));
const getSessionDisplay = vi.hoisted(() => vi.fn(async () => null));
const renameSession = vi.hoisted(() => vi.fn());
const prepareEndExecution = vi.hoisted(() => vi.fn());
const endExecution = vi.hoisted(() => vi.fn());
const stopExecution = vi.hoisted(() => vi.fn());
const restartExecution = vi.hoisted(() => vi.fn());
const previewExecutionArtifacts = vi.hoisted(() => vi.fn());
const submitExecutionArtifacts = vi.hoisted(() => vi.fn());

const task: Task = {
  name: "Task",
  slug: "task",
  requested_slug: "",
  parent_task: "",
  active_subtask: "",
  subtask_outcome: "",
  branch: "task",
  worktree: "/worktrees/task",
  has_worktree: true,
  created: 1,
  archived: false,
  pr_url: "",
  linear_id: "",
  github_issue: "",
  playbook: "review",
  auto_advance: [],
  draft: false,
};

const initialItems: ArtifactListItem[] = [
  { name: "01-review-context.md", modified_at_ms: 2, playbook_step: "review-context", session_id: "", handoffs: [] },
  { name: "00-ticket.md", modified_at_ms: 1, playbook_step: "", session_id: "", handoffs: [] },
];
const updatedItems: ArtifactListItem[] = [{ name: "02-review-checks.md", modified_at_ms: 3, playbook_step: "review-checks", session_id: "", handoffs: [] }, ...initialItems];
const initialTree: ArtifactTreeNode[] = [
  ...initialItems.map((item) => ({
    id: `owned-${item.name}`,
    kind: "owned" as const,
    label: item.name,
    owner_task_slug: "task",
    source: "owned" as const,
    children: [],
  })),
  {
    id: "parent-context",
    kind: "subtask_folder",
    label: "Parent context",
    owner_task_slug: "parent",
    source: "parent_context",
    children: [{ id: "parent-ticket", kind: "referenced", label: "00-parent-ticket.md", owner_task_slug: "parent", source: "parent_context", children: [] }],
  },
];

vi.mock("../SessionTerminal", () => ({ SessionTerminal: () => <div data-testid="terminal" /> }));
vi.mock("../confirm", () => ({ askConfirm, confirmDanger, confirmStopAndSwitch }));
vi.mock("../ipc", () =>
  mockIpc({
    getSessionDisplay,
    renameSession,
    getTaskExecution,
    continueExecution,
    setStepContinuationForRepo,
    listSessions,
    prepareEndExecution,
    stopExecution,
    restartExecution,
    previewExecutionArtifacts,
    submitExecutionArtifacts,
    endExecution,
    listTasks: () => {
      scenario.taskCalls += 1;
      if (scenario.tasksError) return Promise.reject(scenario.tasksError);
      return scenario.tasksPromise ?? Promise.resolve(scenario.tasks);
    },
    listArtifactsWithMetadata: async () => scenario.items ?? (scenario.itemCalls++ === 0 ? initialItems : updatedItems),
    listTaskArtifactTree: () => {
      scenario.treeCalls += 1;
      return scenario.treeCalls === 1 ? Promise.resolve(initialTree) : new Promise<ArtifactTreeNode[]>(() => {});
    },
    listArtifactCommentDrafts: async () => [],
    listArtifactCommentDraftsForRepo: async () => [],
    listArtifactComments: async () => [],
    sessionStatus,
    archiveSession,
    sessionArtifactReady,
    startSession,
    restateSession,
    rpcAttachSession,
    onStreamClosed,
    readSessionOmp,
    rpcWriteSession,
    detachSession,
    readOmpModelRoles,
    writeOmpModelRoles,
    openUrl,
    prepareReviewApprovalPrompt: async () => ({
      text: "Please approve the review.",
      provenance: { type: "review_approval" as const, review_artifact: "03-review-findings.md" },
    }),
    pickAttachmentFilesDialog,
    getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
    ...({
      chatFileStat,
      copyChatAttachments,
      writeChatAttachmentBytes,
      readChatImage,
    } as object),
  } as never),
);

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SessionView artifact pane", () => {
  beforeEach(() => {
    scenario.itemCalls = 0;
    scenario.treeCalls = 0;
    vi.useFakeTimers();
    scenario.tasks = [{ ...task }];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps category tabs and flat artifact polling live when the context tree stalls", async () => {
    render(
      <SessionView
        id="session"
        cwd="/worktrees/task"
        taskSlug="task"
        repoPath="/repo"
        phase="review-checks"
        harness="omp"
        playbook="review"
        model=""
        intent="spawn"
        appearance={DEFAULT_APPEARANCE}
        messageDraft={{ body: "", pendingActions: [], attachments: [] }}
        onMessageDraftChange={vi.fn()}
        onAppearanceChange={vi.fn()}
        onBack={vi.fn()}
        onStartFresh={vi.fn()}
        onStartReviewHandoff={vi.fn()}
        onOpenRelatedTask={vi.fn()}
      />,
    );
    await flushPromises();

    expect(screen.getByRole("button", { name: "Playbook" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Wiki" })).toBeNull();
    expect(screen.getByRole("button", { name: "Attachments" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("2/2")).toBeDefined();
    expect(screen.getByText("Parent context")).toBeDefined();
    expect(screen.queryByText("02-review-checks.md")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("02-review-checks.md")).toBeDefined();
    expect(screen.getByText("3/3")).toBeDefined();
  });

  it.each(["merged", "finished", "killed"] as const)("warns that a live %s child session may be stale", async (outcome) => {
    scenario.tasks = [
      { ...task, name: "Parent", slug: "parent", requested_slug: "parent", playbook: "superdevelop" },
      { ...task, archived: true, parent_task: "parent", subtask_outcome: outcome },
    ];
    render(
      <SessionView
        id="session"
        cwd="/worktrees/task"
        taskSlug="task"
        repoPath="/repo"
        phase="review-checks"
        harness="omp"
        playbook="review"
        model=""
        intent="spawn"
        appearance={DEFAULT_APPEARANCE}
        messageDraft={{ body: "", pendingActions: [], attachments: [] }}
        onMessageDraftChange={vi.fn()}
        onAppearanceChange={vi.fn()}
        onBack={vi.fn()}
        onStartFresh={vi.fn()}
        onStartReviewHandoff={vi.fn()}
        onOpenRelatedTask={vi.fn()}
      />,
    );
    await flushPromises();

    expect(screen.getByTestId("chat-pane")).toBeDefined();
    expect(
      screen.getByText(
        `Finalized into Parent as ${outcome.toUpperCase()}. Any open session may be stale. Changes after finalization are not included in the parent snapshot or integrated result.`,
      ),
    ).toBeDefined();
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

async function openSessionAction(name: string) {
  if (!screen.queryByRole("dialog", { name: "Session actions" })) {
    fireEvent.click(await screen.findByRole("button", { name: "Session actions" }));
  }
  return within(await screen.findByRole("dialog", { name: "Session actions" })).findByRole("button", { name });
}

function sessionView(overrides: Partial<ComponentProps<typeof SessionView>> = {}) {
  return (
    <SessionView
      id="session"
      cwd="/worktrees/task"
      taskSlug="task"
      repoPath="/repo"
      phase="design"
      harness="omp"
      playbook="superdevelop"
      model=""
      intent="spawn"
      appearance={DEFAULT_APPEARANCE}
      messageDraft={{ body: "", pendingActions: [], attachments: [] }}
      onMessageDraftChange={vi.fn()}
      onAppearanceChange={vi.fn()}
      onBack={vi.fn()}
      onStartFresh={vi.fn()}
      onStartReviewHandoff={vi.fn()}
      onOpenRelatedTask={vi.fn()}
      {...overrides}
    />
  );
}

function renderSession(overrides: Partial<ComponentProps<typeof SessionView>> = {}) {
  return render(sessionView(overrides));
}

describe("session work names", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    scenario.tasks = [{ ...task }];
    scenario.tasksPromise = null;
    scenario.tasksError = null;
    startSession.mockClear();
    getSessionDisplay.mockReset();
    renameSession.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    getSessionDisplay.mockReset().mockResolvedValue(null);
  });

  it.each(["omp", "no-harness"])("history_and_terminal_names_refresh_without_starting_sessions (%s)", async (harness) => {
    const context = { session: { id: "session", name: "Historical work", subtask_manager: true, subtask_slug: "child" }, task_name: "Current task", subtask_name: "Current child" };
    scenario.tasks = [
      { ...task, parent_task: "parent" },
      { ...task, slug: "parent", name: "Current parent" },
    ];
    getSessionDisplay.mockResolvedValue(context as never);
    renderSession({ intent: "history", harness });
    await flushPromises();
    expect(within(screen.getByRole("group", { name: "Session name" })).getByText("Historical work")).toBeDefined();
    expect(screen.getByText("Current child")).toBeDefined();
    expect(screen.getByRole("button", { name: "Current parent" })).toBeDefined();
    expect(getSessionDisplay).toHaveBeenCalledWith("/repo", "task", "session");
    getSessionDisplay.mockResolvedValue({ ...context, session: { ...context.session, name: "External name" }, task_name: "Renamed task", subtask_name: "Renamed child" } as never);
    scenario.tasks = [
      { ...task, parent_task: "parent" },
      { ...task, slug: "parent", name: "Renamed parent" },
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(within(screen.getByRole("group", { name: "Session name" })).getByText("External name")).toBeDefined();
    expect(screen.getByText("Renamed task")).toBeDefined();
    expect(screen.getByText("Renamed child")).toBeDefined();
    expect(screen.getByRole("button", { name: "Renamed parent" })).toBeDefined();
    expect(startSession).not.toHaveBeenCalled();
  });

  it("rename_keys_do_not_submit_chat_or_change_session", async () => {
    getSessionDisplay.mockResolvedValue({ session: { id: "session", name: "Old name" }, task_name: "Task", subtask_name: null } as never);
    renameSession.mockResolvedValue({ name: "Saved name", source: "user" });
    const onBack = vi.fn();
    renderSession({ intent: "history", onBack });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
    expect(screen.queryByRole("button", { name: "Rename session" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), { target: { value: "Discard" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Session name" }), { key: "Escape" });
    expect(renameSession).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Session name" }));
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), { target: { value: "Saved name" } });
    getSessionDisplay.mockResolvedValue({ session: { id: "session", name: "Saved name" }, task_name: "Task", subtask_name: null } as never);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Session name" }), { key: "Enter" });
    await flushPromises();
    expect(within(screen.getByRole("group", { name: "Session name" })).getByText("Saved name")).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Session name" }));
    expect(renameSession).toHaveBeenCalledWith({ repoPath: "/repo", taskSlug: "task", sessionId: "session", name: "Saved name" });
    expect(onBack).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  it("keeps a committed header across stale polls and ignores a previous repo save", async () => {
    const original = { session: { id: "session", name: "Original" }, task_name: "Task", subtask_name: null };
    getSessionDisplay.mockResolvedValue(original as never);
    const { rerender } = renderSession({ intent: "history" });
    await flushPromises();
    const oldPoll = deferred<never>();
    getSessionDisplay.mockReturnValueOnce(oldPoll.promise);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    renameSession.mockResolvedValue({ name: "Committed", source: "user" });
    getSessionDisplay.mockResolvedValue({ ...original, session: { ...original.session, name: "Committed" } } as never);
    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), { target: { value: "Committed" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Session name" }), { key: "Enter" });
    await flushPromises();
    await act(async () => {
      oldPoll.resolve(original as never);
    });
    expect(within(screen.getByRole("group", { name: "Session name" })).getByText("Committed")).toBeDefined();
    getSessionDisplay.mockResolvedValue({ ...original, session: { ...original.session, name: "External" } } as never);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(within(screen.getByRole("group", { name: "Session name" })).getByText("External")).toBeDefined();
    const lateSave = deferred<{ name: string; source: string }>();
    renameSession.mockReturnValueOnce(lateSave.promise);
    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), { target: { value: "Late old repo" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Session name" }), { key: "Enter" });
    getSessionDisplay.mockResolvedValue({ ...original, session: { ...original.session, name: "Other repo" } } as never);
    rerender(sessionView({ intent: "history", repoPath: "/other" }));
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), { target: { value: "Keep this draft" } });
    await act(async () => {
      lateSave.resolve({ name: "Late old repo", source: "user" });
    });
    expect(screen.getByTitle("Other repo")).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Session name" })).toHaveProperty("value", "Keep this draft");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Session name" }));
  });

  it("shows a waiting ellipsis for a busy unnamed OMP session and hides it while renaming", async () => {
    getSessionDisplay.mockResolvedValue({ session: { id: "session", harness: "omp" }, task_name: "Task", subtask_name: null } as never);
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    renderSession();
    await flushPromises();
    expect(screen.getByRole("status", { name: "Waiting for session name" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
    expect(screen.queryByRole("status", { name: "Waiting for session name" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Session name" })).toBeDefined();
  });

  it("does not animate a terminal session that will not name itself", async () => {
    getSessionDisplay.mockResolvedValue({ session: { id: "session", harness: "no-harness" }, task_name: "Task", subtask_name: null } as never);
    sessionStatus.mockResolvedValue(liveObservation("pty"));
    renderSession({ harness: "no-harness" });
    await flushPromises();
    expect(screen.getByText("Unnamed session")).toBeDefined();
    expect(screen.queryByRole("status", { name: "Waiting for session name" })).toBeNull();
  });
});

describe("session archive pending feedback", () => {
  beforeEach(() => {
    scenario.tasks = [{ ...task }];
    scenario.tasksPromise = null;
    scenario.tasksError = null;
    sessionStatus.mockResolvedValue({ lifecycle: { state: "exited", code: 0 }, state: null, checkpoint: {} });
    confirmDanger.mockReset().mockResolvedValue(true);
    archiveSession.mockReset();
  });

  afterEach(cleanup);

  it("waits for archive settlement, blocks duplicates, and recovers after an error", async () => {
    const pending = deferred<void>();
    archiveSession.mockReturnValue(pending.promise);
    const onBack = vi.fn();
    render(<Toast />);
    renderSession({ harness: "claude", onBack });
    const button = await screen.findByRole("button", { name: "Archive session" });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    const busy = await screen.findByRole("button", { name: "Archiving session…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busy);
    expect(confirmDanger).toHaveBeenCalledTimes(1);
    expect(archiveSession).toHaveBeenCalledTimes(1);
    expect(archiveSession).toHaveBeenCalledWith("task", "session");
    expect(onBack).not.toHaveBeenCalled();
    await act(async () => pending.reject(new Error("daemon timed out")));
    expect((screen.getByRole("button", { name: "Archive session" }) as HTMLButtonElement).disabled).toBe(false);
    expect(onBack).not.toHaveBeenCalled();

    expect(screen.getByText("Error: daemon timed out")).toBeDefined();
    const retry = deferred<void>();
    archiveSession.mockReturnValue(retry.promise);
    fireEvent.click(screen.getByRole("button", { name: "Archive session" }));
    await screen.findByRole("button", { name: "Archiving session…" });
    expect(archiveSession).toHaveBeenCalledTimes(2);
    await act(async () => retry.resolve());
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("allows confirmation again after cancellation without archiving", async () => {
    confirmDanger.mockResolvedValueOnce(false);
    const pending = deferred<void>();
    archiveSession.mockReturnValue(pending.promise);
    renderSession({ harness: "claude" });
    fireEvent.click(await screen.findByRole("button", { name: "Archive session" }));
    await flushPromises();
    expect(archiveSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Archive session" }));
    await screen.findByRole("button", { name: "Archiving session…" });
    expect(archiveSession).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve());
  });
});

describe("the session toolbar names the parent task", () => {
  beforeEach(() => {
    scenario.taskCalls = 0;
    scenario.tasks = [];
    scenario.tasksPromise = null;
    scenario.tasksError = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("falls back to the task slug before listTasks resolves", () => {
    scenario.tasksPromise = deferred<Task[]>().promise;
    renderSession();
    expect(screen.getByText("task")).toBeDefined();
  });

  it("replaces the slug with the task name once listTasks resolves", async () => {
    scenario.tasks = [{ ...task, name: "Human Readable Task" }];
    renderSession();
    expect(await screen.findByText("Human Readable Task")).toBeDefined();
  });

  it("keeps the slug when the task cannot be loaded", async () => {
    scenario.tasksError = new Error("no tasks");
    renderSession();
    await waitFor(() => {
      expect(scenario.taskCalls).toBeGreaterThan(0);
    });
    expect(screen.getByText("task")).toBeDefined();
  });
});

function liveObservation(transport: "rpc" | "pty", agent: AgentState = { state: "idle" }): SessionObservation {
  return {
    lifecycle: { state: "live" },
    transport,
    state: {
      process: { state: "alive" },
      agent,
      playbook: { state: "in_progress" },
      adapter: "omp",
      message_adapter: "omp_bracketed_paste",
    },
    checkpoint: {},
  };
}

describe("session lifecycle polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    scenario.tasks = [task];
    scenario.tasksPromise = null;
    scenario.tasksError = null;
    sessionStatus.mockResolvedValue(liveObservation("pty"));
    sessionArtifactReady.mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    sessionStatus.mockReset().mockResolvedValue({ lifecycle: { state: "exited", code: 0 }, state: null, checkpoint: {} });
    sessionArtifactReady.mockReset().mockResolvedValue(false);
  });

  it("replaces a live terminal with the polled interruption and preserved-work explanation", async () => {
    renderSession({ intent: undefined });
    await flushPromises();
    expect(screen.getByTestId("terminal")).toBeDefined();

    sessionArtifactReady.mockResolvedValue(true);
    sessionStatus.mockResolvedValue({ lifecycle: { state: "interrupted" }, state: null, checkpoint: {} });
    await act(async () => vi.advanceTimersByTimeAsync(1500));

    expect(screen.queryByTestId("terminal")).toBeNull();
    expect(screen.getByText("Interrupted")).toBeDefined();
    expect(screen.getByText(/daemon was killed mid-run.*expected artifact exists and work is preserved/)).toBeDefined();
  });

  it("explains an orphaned session without claiming an artifact was preserved", async () => {
    renderSession({ intent: undefined });
    await flushPromises();
    expect(screen.getByTestId("terminal")).toBeDefined();

    sessionStatus.mockResolvedValue({ lifecycle: { state: "orphaned" }, state: null, checkpoint: {} });
    await act(async () => vi.advanceTimersByTimeAsync(1500));

    expect(screen.queryByTestId("terminal")).toBeNull();
    expect(screen.getByText("Orphaned")).toBeDefined();
    expect(screen.getByText(/daemon died.*live output is gone/)).toBeDefined();
    expect(screen.queryByText(/work is preserved/)).toBeNull();
  });

  it("keeps daemon-owned exits attachable, then shows the detached exit code", async () => {
    renderSession({ intent: undefined });
    await flushPromises();
    expect(screen.getByTestId("terminal")).toBeDefined();

    sessionStatus.mockResolvedValue({ ...liveObservation("pty"), lifecycle: { state: "live_exited" } });
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(screen.getByTestId("terminal")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Start fresh" })).toBeNull();

    sessionStatus.mockResolvedValue({ lifecycle: { state: "exited", code: 23 }, state: null, checkpoint: {} });
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(screen.queryByTestId("terminal")).toBeNull();
    expect(screen.getByText("Exited (code 23)")).toBeDefined();
    expect(screen.getByText("The harness process finished.")).toBeDefined();
  });
});

function captureRpcOnLine(slot: { current?: (line: string) => void }) {
  rpcAttachSession.mockImplementation(async (args: unknown) => {
    slot.current = (args as { onLine?: (line: string) => void }).onLine;
  });
}

describe("session message composer feature gate", () => {
  beforeEach(() => {
    scenario.taskCalls = 0;
    scenario.tasks = [{ ...task }];
    scenario.tasksPromise = null;
    scenario.tasksError = null;
    scenario.items = null;
    sessionStatus.mockResolvedValue({ lifecycle: { state: "exited", code: 0 }, state: null, checkpoint: {} });
  });

  afterEach(cleanup);

  it("shows Chat and the Chat composer for OMP", () => {
    renderSession();

    expect(screen.getByTestId("chat-pane")).toBeDefined();
    expect(screen.getByLabelText("Message or /command")).toBeDefined();
  });

  it("offers the review draft actions to Chat with no experimental flag", async () => {
    scenario.items = [{ name: "03-review-findings.md", modified_at_ms: 3, playbook_step: "review-findings", session_id: "", handoffs: [] }];
    const onDraftChange = vi.fn();
    renderSession({ appearance: DEFAULT_APPEARANCE, playbook: "review", onMessageDraftChange: onDraftChange });

    expect(await screen.findByText("Send findings to task")).toBeDefined();
    fireEvent.click((await screen.findByText("Add approval prompt")).closest("button") as HTMLButtonElement);
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ body: "Please approve the review." })));
  });
});

describe("session chat hatch", () => {
  afterEach(() => {
    cleanup();
    sessionStatus.mockReset();
    sessionStatus.mockResolvedValue({ lifecycle: { state: "exited" as const, code: 0 }, state: null, checkpoint: {} });
    restateSession.mockClear();
    confirmDanger.mockReset();
    confirmDanger.mockResolvedValue(true);
    confirmStopAndSwitch.mockReset();
    confirmStopAndSwitch.mockResolvedValue(true);
    rpcWriteSession.mockClear();
    rpcAttachSession.mockReset();
    rpcAttachSession.mockImplementation(async () => undefined);
  });

  it("lists Chat before Terminal in the hatch", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    renderSession();
    await flushPromises();
    const hatch = screen.getByRole("group", { name: "Session view" });
    const buttons = within(hatch).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Chat", "Terminal"]);
  });

  it("restates live RPC to PTY from the Terminal hatch, not shutdown", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    renderSession();
    await flushPromises();
    expect(screen.getByTestId("chat-pane")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await waitFor(() => expect(restateSession).toHaveBeenCalledWith("session", "pty"));
    expect(confirmStopAndSwitch).not.toHaveBeenCalled();
  });

  it("restates live PTY to RPC from the Chat hatch", async () => {
    sessionStatus.mockResolvedValue(liveObservation("pty"));
    renderSession();
    await flushPromises();
    expect(screen.getByTestId("terminal")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    await waitFor(() => expect(restateSession).toHaveBeenCalledWith("session", "rpc"));
  });

  it("confirms before restating when a send is pending and the poll still reads idle", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    confirmStopAndSwitch.mockResolvedValue(false);
    renderSession({ messageDraft: { body: "first", pendingActions: [], attachments: [] } });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(rpcWriteSession.mock.calls.some(([, payload]) => (payload as { type?: string } | null)?.type === "prompt")).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await waitFor(() => expect(confirmStopAndSwitch).toHaveBeenCalledWith("pty"));
    expect(restateSession).not.toHaveBeenCalled();
  });

  it("confirms before restating when turn_start leads the idle observation poll", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    confirmStopAndSwitch.mockResolvedValue(false);
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    renderSession();
    await flushPromises();
    await waitFor(() => expect(onLine.current).toBeDefined());
    act(() => {
      onLine.current?.(JSON.stringify({ type: "turn_start" }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await waitFor(() => expect(confirmStopAndSwitch).toHaveBeenCalledWith("pty"));
    expect(restateSession).not.toHaveBeenCalled();
  });

  it("aborts the turn and restates once the user accepts stopping it", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    renderSession();
    await flushPromises();
    await waitFor(() => expect(onLine.current).toBeDefined());
    act(() => {
      onLine.current?.(JSON.stringify({ type: "turn_start" }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await waitFor(() => expect(restateSession).toHaveBeenCalledWith("session", "pty"));
    expect(confirmStopAndSwitch).toHaveBeenCalledWith("pty");
    expect(rpcWriteSession.mock.calls.some(([, payload]) => (payload as { type?: string } | null)?.type === "abort")).toBe(true);
  });

  it("hides the hatch on leftover harnesses", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    renderSession({ harness: "claude", model: "sonnet" });
    await flushPromises();
    expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
  });
});

describe("session chat slash dispatch", () => {
  afterEach(() => {
    cleanup();
    sessionStatus.mockReset();
    sessionStatus.mockResolvedValue({ lifecycle: { state: "exited" as const, code: 0 }, state: null, checkpoint: {} });
    rpcWriteSession.mockClear();
  });

  it("opens the model dialog on /model and never prompts that name", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    renderSession({ messageDraft: { body: "/model", pendingActions: [], attachments: [] } });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("dialog", { name: "Models" })).toBeDefined();
    expect(
      rpcWriteSession.mock.calls.some(
        ([, payload]) => payload && typeof payload === "object" && "type" in payload && payload.type === "prompt" && "message" in payload && payload.message === "/model",
      ),
    ).toBe(false);
  });

  it("opens the Accounts tab on /login and never prompts", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    readOmpModelRoles.mockResolvedValue({});
    renderSession({ messageDraft: { body: "/login", pendingActions: [], attachments: [] } });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("dialog", { name: "Providers" })).toBeDefined();
    expect(rpcWriteSession.mock.calls.some(([, payload]) => payload && typeof payload === "object" && "message" in payload && payload.message === "/login")).toBe(false);
  });
});

describe("leftover harness refuse", () => {
  afterEach(() => {
    cleanup();
    sessionStatus.mockReset();
    sessionStatus.mockResolvedValue({ lifecycle: { state: "exited" as const, code: 0 }, state: null, checkpoint: {} });
  });

  it("classifies leftover spawn intent into the unsupported panel instead of spinning", async () => {
    renderSession({ harness: "claude", model: "sonnet", intent: "spawn" });
    const panel = (await screen.findByText("This session can't be started or resumed. History and archive remain available.")).closest(".session-action-panel");
    expect(panel).not.toBeNull();
    expect(panel?.querySelector(".sap-state")?.textContent).toBe("Unsupported");
    expect(panel?.textContent).toContain("Unsupported · sonnet");
    expect(screen.queryByTestId("terminal")).toBeNull();
    expect(screen.queryByText("Checking session")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start fresh" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Resume/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set resume token" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Kill" })).toBeNull();
  });

  it("renders Kill for a live leftover row and not Start fresh", async () => {
    sessionStatus.mockResolvedValue({ lifecycle: { state: "live" as const }, state: null, checkpoint: {} });
    renderSession({ harness: "claude", model: "sonnet", intent: "spawn" });
    const panel = (await screen.findByText("This session can't be started or resumed. History, archive, and Kill remain available.")).closest(".session-action-panel");
    expect(panel).not.toBeNull();
    expect(panel?.querySelector(".sap-state")?.textContent).toBe("Unsupported");
    expect(screen.getByRole("button", { name: "Kill" })).toBeDefined();
    expect(screen.queryByTestId("terminal")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start fresh" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Resume/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set resume token" })).toBeNull();
  });
});

describe("session chat approval", () => {
  const REQUEST = "ui-open";

  beforeEach(() => {
    scenario.tasks = [{ ...task }];
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    // Cleared so `calls.at(-1)` is this render's attach and not one left by an earlier test.
    rpcAttachSession.mockClear();
    rpcWriteSession.mockClear();
    openUrl.mockClear();
    openUrl.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    sessionStatus.mockReset();
    sessionStatus.mockResolvedValue({ lifecycle: { state: "exited" as const, code: 0 }, state: null, checkpoint: {} });
  });

  /** Every reply OMP received for the request — the count is the assertion, not just the shape. */
  function responses() {
    return rpcWriteSession.mock.calls
      .map(([, payload]) => payload as { type?: string; id?: string; confirmed?: boolean } | null)
      .filter((payload) => payload?.type === "extension_ui_response" && payload.id === REQUEST);
  }

  async function requestOpenUrl(launchUrl: string, instructions?: string) {
    renderSession();
    await waitFor(() => expect(rpcAttachSession).toHaveBeenCalled());
    const calls = rpcAttachSession.mock.calls;
    const attach = calls[calls.length - 1]?.[0] as { onLine: (line: string) => void };
    await act(async () => {
      attach.onLine(JSON.stringify({ type: "extension_ui_request", id: REQUEST, method: "open_url", launchUrl, instructions }));
    });
  }

  it("asks before opening a link instead of launching it, and shows the URL", async () => {
    await requestOpenUrl("https://example.com/setup");

    expect(openUrl).not.toHaveBeenCalled();
    expect(responses()).toHaveLength(0);
    expect(screen.getByText("https://example.com/setup")).toBeDefined();
    expect(screen.getByTestId("chat-activity").textContent).toContain("Waiting for approval");
  });

  it("shows confirmation details only once while preserving approval controls and the waiting composer", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "waiting_for_approval", correlation_id: REQUEST }));
    renderSession();
    await waitFor(() => expect(rpcAttachSession).toHaveBeenCalled());
    const calls = rpcAttachSession.mock.calls;
    const attach = calls[calls.length - 1]?.[0] as { onLine: (line: string) => void };
    const title = "Approve the meeting-notes specification?";
    const detail = "Create action items without inventing owners or deadlines.";
    await act(async () => {
      attach.onLine(JSON.stringify({ type: "extension_ui_request", id: REQUEST, method: "confirm", title, message: detail }));
    });

    expect(screen.getAllByText(title, { exact: false })).toHaveLength(1);
    expect(screen.getAllByText(detail, { exact: false })).toHaveLength(1);
    expect(within(screen.getByTestId("chat-pane")).getByText(detail)).toBeDefined();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("chat-activity").textContent).toContain("Waiting for approval");
    expect(responses()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Allow" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(responses()).toHaveLength(1));
    expect(responses()[0]?.confirmed).toBe(false);
  });

  it("opens the link and confirms once when the user allows it", async () => {
    await requestOpenUrl("https://example.com/setup");
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    await waitFor(() => expect(responses()).toHaveLength(1));
    expect(openUrl).toHaveBeenCalledWith("https://example.com/setup");
    expect(responses()[0]?.confirmed).toBe(true);
  });

  it.each([true, false])("retains a replayed device code after Allow until login settles (%s)", async (success) => {
    await requestOpenUrl("https://auth.openai.com/codex/device", "Enter code: ABCD-EFGH");
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(responses()).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.getByText(/ABCD-EFGH/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
    const calls = rpcAttachSession.mock.calls;
    const attach = calls[calls.length - 1]?.[0] as { onLine: (line: string) => void };
    await act(async () => {
      attach.onLine(JSON.stringify({ type: "response", command: "login", success, error: success ? undefined : "Device authorization expired" }));
    });
    expect(screen.queryByText(/ABCD-EFGH/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
  });

  it("declines once and opens nothing when the user denies", async () => {
    await requestOpenUrl("https://example.com/setup");
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() => expect(responses()).toHaveLength(1));
    expect(responses()[0]?.confirmed).toBe(false);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it.each(["file:///etc/passwd", "javascript:void 0", "not a url"])("declines %s without reaching the opener", async (launchUrl) => {
    await requestOpenUrl(launchUrl);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    await waitFor(() => expect(responses()).toHaveLength(1));
    expect(responses()[0]?.confirmed).toBe(false);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("opens the sign-in link without an approval row, because the click was the consent", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    readOmpModelRoles.mockResolvedValue({});
    renderSession({ messageDraft: { body: "/login", pendingActions: [], attachments: [] } });
    await flushPromises();
    const calls = rpcAttachSession.mock.calls;
    const attach = calls[calls.length - 1]?.[0] as { onLine: (line: string) => void };
    await act(async () => {
      attach.onLine(JSON.stringify({ type: "response", command: "get_login_providers", success: true, data: { providers: [{ id: "anthropic", name: "Anthropic" }] } }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(await screen.findByRole("button", { name: /Anthropic/ }));

    await act(async () => {
      attach.onLine(JSON.stringify({ type: "extension_ui_request", id: REQUEST, method: "open_url", launchUrl: "https://auth.example/callback" }));
    });

    await waitFor(() => expect(responses()).toHaveLength(1));
    expect(openUrl).toHaveBeenCalledWith("https://auth.example/callback");
    expect(responses()[0]?.confirmed).toBe(true);
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it.each([
    { success: true, reopen: false },
    { success: false, reopen: false },
    { success: true, reopen: true },
    { success: false, reopen: true },
  ])("keeps a session device code in the dialog until login settles ($success, reopen=$reopen)", async ({ success, reopen }) => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    readOmpModelRoles.mockResolvedValue({});
    renderSession({ messageDraft: { body: "/login", pendingActions: [], attachments: [] } });
    await flushPromises();
    const calls = rpcAttachSession.mock.calls;
    const attach = calls[calls.length - 1]?.[0] as { onLine: (line: string) => void };
    await act(async () => {
      attach.onLine(
        JSON.stringify({ type: "response", command: "get_login_providers", success: true, data: { providers: [{ id: "openai-codex-device", name: "Codex device" }] } }),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(await screen.findByRole("button", { name: /Codex device/ }));
    await act(async () => {
      attach.onLine(
        JSON.stringify({ type: "extension_ui_request", id: REQUEST, method: "open_url", url: "https://auth.openai.com/codex/device", instructions: "Enter code: ABCD-EFGH" }),
      );
    });
    await waitFor(() => expect(responses()).toHaveLength(1));
    expect(openUrl).toHaveBeenCalledWith("https://auth.openai.com/codex/device");
    let dialog = screen.getByRole("dialog", { name: "Providers" });
    expect(within(dialog).getByText(/ABCD-EFGH/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();

    if (reopen) {
      fireEvent.click(within(dialog).getByTitle("Cancel"));
      fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "/login" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      dialog = await screen.findByRole("dialog", { name: "Providers" });
      expect(within(dialog).getByText(/ABCD-EFGH/)).toBeTruthy();
    }
    await act(async () => {
      attach.onLine(
        JSON.stringify({ type: "response", command: "login", success, data: { providerId: "openai-codex-device" }, error: success ? undefined : "Device authorization expired" }),
      );
    });
    expect(within(dialog).queryByText(/ABCD-EFGH/)).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Copy code" })).toBeNull();
  });

  it("arms the sign-in bypass for one link only", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    readOmpModelRoles.mockResolvedValue({});
    renderSession({ messageDraft: { body: "/login", pendingActions: [], attachments: [] } });
    await flushPromises();
    const calls = rpcAttachSession.mock.calls;
    const attach = calls[calls.length - 1]?.[0] as { onLine: (line: string) => void };
    await act(async () => {
      attach.onLine(JSON.stringify({ type: "response", command: "get_login_providers", success: true, data: { providers: [{ id: "anthropic", name: "Anthropic" }] } }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(await screen.findByRole("button", { name: /Anthropic/ }));
    await act(async () => {
      attach.onLine(JSON.stringify({ type: "extension_ui_request", id: REQUEST, method: "open_url", launchUrl: "https://auth.example/callback" }));
    });
    await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1));

    // A second link on the same login is unsolicited: it has to be approved like any other.
    await act(async () => {
      attach.onLine(JSON.stringify({ type: "extension_ui_request", id: "ui-second", method: "open_url", launchUrl: "https://evil.example/x" }));
    });
    expect(await screen.findByRole("button", { name: "Allow" })).toBeDefined();
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it("answers once when the approval is double-clicked", async () => {
    await requestOpenUrl("https://example.com/setup");
    const allow = screen.getByRole("button", { name: "Allow" });
    fireEvent.click(allow);
    fireEvent.click(allow);

    await waitFor(() => expect(responses()).toHaveLength(1));
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it("shows the resolved origin, not the string the extension picked", async () => {
    await requestOpenUrl("https://accounts.google.com@evil.example/setup?next=x");

    expect(screen.getByText("https://evil.example/setup")).toBeDefined();
    expect(screen.queryByText(/accounts\.google\.com/)).toBeNull();
  });

  it("still answers exactly once when the opener fails", async () => {
    openUrl.mockRejectedValue(new Error("no handler"));
    await requestOpenUrl("https://example.com/setup");
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    await waitFor(() => expect(responses()).toHaveLength(1));
    expect(responses()[0]?.confirmed).toBe(false);
  });
});

describe("session chat send routing", () => {
  /** Every composer send OMP received, in order — the attach seeds are neither prompt nor follow_up. */
  function sends() {
    return rpcWriteSession.mock.calls
      .map(([, payload]) => payload as { type?: string; message?: string; id?: string } | null)
      .filter((payload) => payload?.type === "prompt" || payload?.type === "follow_up");
  }

  beforeEach(() => {
    scenario.tasks = [{ ...task }];
    rpcWriteSession.mockClear();
    rpcWriteSession.mockImplementation(async () => ({ status: "written" as const }));
    rpcAttachSession.mockReset();
    rpcAttachSession.mockImplementation(async () => undefined);
    copyChatAttachments.mockReset();
    copyChatAttachments.mockResolvedValue({ copied: [], failures: [] });
    writeChatAttachmentBytes.mockReset();
    writeChatAttachmentBytes.mockImplementation(async (_slug: string, fileName: string) => fileName);
    readChatImage.mockReset();
    readChatImage.mockResolvedValue({ mime_type: "image/png", data: "aa" });
    chatFileStat.mockReset();
    chatFileStat.mockImplementation(async (path: string) => ({ name: path.split("/").pop() ?? path, bytes: 12 }));
    pickAttachmentFilesDialog.mockReset();
    pickAttachmentFilesDialog.mockResolvedValue([]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).startsWith("blob:")) {
        return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Response;
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    });
  });

  afterEach(() => {
    cleanup();
    sessionStatus.mockReset();
    sessionStatus.mockResolvedValue({ lifecycle: { state: "exited" as const, code: 0 }, state: null, checkpoint: {} });
    rpcWriteSession.mockImplementation(async () => ({ status: "written" as const }));
    vi.mocked(globalThis.fetch).mockRestore?.();
  });

  it("queues a turn that is waiting for input instead of prompting it", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "waiting_for_input", correlation_id: "ask-1" }));
    renderSession({ messageDraft: { body: "use the other file", pendingActions: [], attachments: [] } });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));

    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0]).toMatchObject({ type: "follow_up", message: "use the other file" });
  });

  it("queues the second submit even though the status poll still reads idle", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    const view = renderSession({ messageDraft: { body: "first", pendingActions: [], attachments: [] } });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(1));

    view.rerender(sessionView({ messageDraft: { body: "second", pendingActions: [], attachments: [] } }));
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));

    await waitFor(() => expect(sends()).toHaveLength(2));
    expect(sends().map((payload) => [payload?.type, payload?.message])).toEqual([
      ["prompt", "first"],
      ["follow_up", "second"],
    ]);
  });

  it("keeps the draft and leaves no delivered row when the write is rejected", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    rpcWriteSession.mockImplementation(async (_id: string, payload: unknown) => {
      if ((payload as { type?: string } | null)?.type === "prompt") throw new Error("stdin closed");
      return { status: "written" as const };
    });
    const onDraftChange = vi.fn();
    renderSession({ messageDraft: { body: "keep me", pendingActions: [], attachments: [] }, onMessageDraftChange: onDraftChange });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await within(screen.getByTestId("chat-pane")).findByText(/stdin closed/)).toBeDefined();
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(within(screen.getByTestId("chat-pane")).queryByText("keep me")).toBeNull();
  });

  it("restores the draft when OMP refuses the send after stdin was acked", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    const onDraftChange = vi.fn();
    renderSession({ messageDraft: { body: "keep me", pendingActions: [], attachments: [] }, onMessageDraftChange: onDraftChange });
    await flushPromises();
    await waitFor(() => expect(onLine.current).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    const commandId = (sends()[0] as { id?: string }).id;
    expect(commandId).toBeTruthy();
    expect(onDraftChange).toHaveBeenCalledWith({ body: "", pendingActions: [], attachments: [] });

    await act(async () => {
      onLine.current?.(
        JSON.stringify({
          type: "alinery_dispatch",
          dispatch_id: commandId,
          status: "rejected",
          reason: "Agent is already processing",
        }),
      );
    });

    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith({ body: "keep me", pendingActions: [], attachments: [] }));
    expect(screen.getAllByText("Agent is already processing").length).toBeGreaterThan(0);
    expect(within(screen.getByTestId("chat-pane")).queryByText("keep me")).toBeNull();
  });

  it("keeps a refused send as not sent, with Copy, when the composer already holds another message", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    const onDraftChange = vi.fn();
    const view = renderSession({ messageDraft: { body: "first", pendingActions: [], attachments: [] }, onMessageDraftChange: onDraftChange });
    await flushPromises();
    await waitFor(() => expect(onLine.current).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    const commandId = sends()[0]?.id;
    // The parent's draft is the next message by now.
    view.rerender(sessionView({ messageDraft: { body: "second", pendingActions: [], attachments: [] }, onMessageDraftChange: onDraftChange }));
    onDraftChange.mockClear();

    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "alinery_dispatch", dispatch_id: commandId, status: "rejected", reason: "Agent is already processing" }));
    });

    const pane = within(screen.getByTestId("chat-pane"));
    expect(await pane.findByText("not sent")).toBeDefined();
    const row = pane.getByText("first").closest("article") as HTMLElement;
    expect(within(row).getByText("not sent")).toBeDefined();
    expect(within(row).getByRole("button", { name: "Copy message" })).toBeDefined();
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("preserves both out-of-order refusals after an unrelated turn starts", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    const onDraftChange = vi.fn();
    const view = renderSession({ messageDraft: { body: "first review", pendingActions: [], attachments: [] }, onMessageDraftChange: onDraftChange });
    await flushPromises();
    await waitFor(() => expect(onLine.current).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    await flushPromises();
    view.rerender(sessionView({ messageDraft: { body: "second review", pendingActions: [], attachments: [] }, onMessageDraftChange: onDraftChange }));
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(sends()).toHaveLength(2));
    await flushPromises();
    view.rerender(sessionView({ messageDraft: { body: "new unsent review", pendingActions: [], attachments: [] }, onMessageDraftChange: onDraftChange }));
    onDraftChange.mockClear();
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "response", id: sends()[0]?.id, command: "prompt", success: true }));
      onLine.current?.(JSON.stringify({ type: "turn_start" }));
      for (const sent of [...sends()].reverse()) {
        onLine.current?.(JSON.stringify({ type: "alinery_dispatch", dispatch_id: sent?.id, status: "rejected", reason: "Session is finishing" }));
      }
    });
    const pane = within(screen.getByTestId("chat-pane"));
    for (const caption of ["first review", "second review"]) {
      const row = pane.getByText(caption).closest("article") as HTMLElement;
      expect(within(row).getByText("not sent")).toBeDefined();
      expect(within(row).getByRole("button", { name: "Copy message" })).toBeDefined();
    }
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("new unsent review");
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(sends()).toHaveLength(2);
  });

  it("does not replace a newer equal-caption draft's different image on refusal", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    copyChatAttachments.mockResolvedValue({ copied: ["shot.png"], failures: [] });
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    const onDraftChange = vi.fn();
    const view = renderSession({ messageDraft: { body: "same caption", pendingActions: [], attachments: [diskPng] }, onMessageDraftChange: onDraftChange });
    await flushPromises();
    await waitFor(() => expect(onLine.current).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    await flushPromises();
    view.rerender(sessionView({ messageDraft: { body: "same caption", pendingActions: [], attachments: [blobPng] }, onMessageDraftChange: onDraftChange }));
    onDraftChange.mockClear();
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "alinery_dispatch", dispatch_id: sends()[0]?.id, status: "rejected", reason: "Session is finishing" }));
    });
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove paste.png" })).toBeDefined();
    expect(within(screen.getByTestId("chat-pane")).getByText("not sent")).toBeDefined();
    expect(sends()).toHaveLength(1);
  });

  it.each(["before", "after"])("does not turn a native failure %s consumption into a definitely unsent draft", async (order) => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    function DraftHarness() {
      const [draft, setDraft] = useState<SessionMessageDraft>({ body: "Already delivered", pendingActions: [], attachments: [] });
      return sessionView({ messageDraft: draft, onMessageDraftChange: setDraft });
    }
    render(<DraftHarness />);
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    await flushPromises();
    const commandId = sends()[0]?.id;
    const failure = { type: "response", id: commandId, command: "prompt", success: false, error: "Post-delivery persistence failed" };
    const consumed = { type: "alinery_dispatch", dispatch_id: commandId, status: "consumed" };
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "Already delivered" }] } }));
      for (const event of order === "before" ? [failure, consumed] : [consumed, failure]) onLine.current?.(JSON.stringify(event));
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(within(screen.getByTestId("chat-pane")).getAllByText("Already delivered")).toHaveLength(1);
    expect(screen.queryByText("not sent")).toBeNull();
    expect(sends()).toHaveLength(1);
  });

  it("keeps an uncertain transport send recoverable beside a newer draft without retrying", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    let rejectWrite!: (reason: Error) => void;
    const write = new Promise<void>((_resolve, reject) => {
      rejectWrite = reject;
    });
    rpcWriteSession.mockImplementation(async (_id: string, payload: unknown) => {
      if (typeof payload === "object" && payload !== null && "type" in payload && payload.type === "prompt") await write;
      return { status: "written" as const };
    });
    const onDraftChange = vi.fn();
    const view = renderSession({ messageDraft: { body: "  original review  ", pendingActions: [], attachments: [] }, onMessageDraftChange: onDraftChange });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    view.rerender(sessionView({ messageDraft: { body: "newer review", pendingActions: [], attachments: [] }, onMessageDraftChange: onDraftChange }));
    onDraftChange.mockClear();
    await act(async () => {
      rejectWrite(new Error("Acknowledgement lost"));
    });
    expect(screen.getByText(/Delivery unknown:/)).toBeDefined();
    expect(within(screen.getByTestId("chat-pane")).getByRole("button", { name: "Copy original message" })).toBeDefined();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("newer review");
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(sends()).toHaveLength(1);
  });

  it("keeps unknown original input copyable after the session becomes read-only history", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    rpcWriteSession.mockImplementation(async (_id, payload) => {
      if (typeof payload === "object" && payload !== null && "type" in payload && payload.type === "prompt") {
        return { status: "unknown", reason: "Acknowledgement lost" };
      }
      return { status: "written" };
    });
    const recovery = new Map<string, SessionSendRecovery>();
    const first = renderSession({ messageDraft: { body: "original before exit", pendingActions: [], attachments: [] }, sendRecovery: recovery });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText(/Delivery unknown:/)).toBeDefined());
    first.unmount();
    renderSession({ intent: "history", sendRecovery: recovery });
    await flushPromises();
    expect(within(screen.getByTestId("chat-pane")).getByRole("button", { name: "Copy original message" })).toBeDefined();
    expect(screen.getByText(/original before exit/)).toBeDefined();
    expect(sends()).toHaveLength(1);
  });

  it("recovers the original image and untrimmed text after navigation without resending", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    copyChatAttachments.mockResolvedValue({ copied: ["shot.png"], failures: [] });
    const recovery = new Map<string, SessionSendRecovery>();
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    const first = renderSession({
      messageDraft: { body: "  original review  ", pendingActions: [], attachments: [diskPng] },
      sendRecovery: recovery,
    });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    const sent = sends()[0];
    await flushPromises();
    first.unmount();
    function ReturnedSession() {
      const [draft, setDraft] = useState<SessionMessageDraft>({ body: "newer draft", pendingActions: [], attachments: [] });
      return sessionView({ messageDraft: draft, onMessageDraftChange: setDraft, sendRecovery: recovery });
    }
    render(<ReturnedSession />);
    await flushPromises();
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "alinery_dispatch", dispatch_id: sent?.id, status: "rejected", reason: "Session is finishing" }));
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("newer draft");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    fireEvent.click(within(screen.getByTestId("chat-pane")).getByRole("button", { name: "Restore unsent message (1 attachments)" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("  original review  ");
    expect(screen.getByRole("button", { name: "Remove shot.png" })).toBeDefined();
    expect(sends()).toHaveLength(1);
  });
  it("restores a typed not-sent draft without claiming transport delivery", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    rpcWriteSession.mockImplementation(async (_id, payload) => {
      if (typeof payload === "object" && payload !== null && "type" in payload && payload.type === "prompt") {
        return { status: "not_sent", reason: "Continuation already requested" };
      }
      return { status: "written" as const };
    });
    function DraftHarness() {
      const [draft, setDraft] = useState<SessionMessageDraft>({ body: "  retained original  ", pendingActions: [], attachments: [] });
      return sessionView({ messageDraft: draft, onMessageDraftChange: setDraft });
    }
    render(<DraftHarness />);
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    await flushPromises();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("  retained original  ");
    expect(screen.getByText("Continuation already requested")).toBeDefined();
    expect(within(screen.getByTestId("chat-pane")).queryByText("retained original")).toBeNull();
    expect(sends()).toHaveLength(1);
  });

  it("retains the original non-chat slash until an exact native outcome instead of guessing from activity", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    function SlashHarness() {
      const [draft, setDraft] = useState<SessionMessageDraft>({ body: "/compact keep the plan  ", pendingActions: [], attachments: [] });
      return sessionView({ messageDraft: draft, onMessageDraftChange: setDraft });
    }
    render(<SlashHarness />);
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(rpcWriteSession.mock.calls.some(([, payload]) => typeof payload === "object" && payload !== null && "type" in payload && payload.type === "compact")).toBe(true),
    );
    const command = rpcWriteSession.mock.calls
      .map(([, payload]) => payload)
      .find((payload) => typeof payload === "object" && payload !== null && "type" in payload && payload.type === "compact");
    if (typeof command !== "object" || command === null || !("id" in command)) throw new Error("Missing compact command");
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "response", id: command.id, command: "compact", success: true }));
      onLine.current?.(JSON.stringify({ type: "turn_start" }));
      onLine.current?.(JSON.stringify({ type: "response", command: "get_state", success: true, data: { queuedMessageCount: 0 } }));
    });
    expect(screen.queryByRole("region", { name: "Recoverable session input" })).toBeNull();
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "response", id: command.id, command: "compact", success: false, error: "Native outcome uncertain" }));
    });
    expect(screen.getByRole("button", { name: "Copy original message" })).toBeDefined();
    expect(within(screen.getByRole("region", { name: "Recoverable session input" })).getByText(/\/compact keep the plan/)).toBeDefined();
  });

  it("settles only the exact native dispatch and never a queue count snapshot", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    const recovery = new Map<string, SessionSendRecovery>();
    let queue: QueuedFollowUp[] = [];
    function QueueHarness() {
      const [draft, setDraft] = useState<SessionMessageDraft>({ body: "first", pendingActions: [], attachments: [] });
      const [items, setItems] = useState<QueuedFollowUp[]>([]);
      queue = items;
      return (
        <>
          <button type="button" onClick={() => setDraft({ body: "second", pendingActions: [], attachments: [] })}>
            Next draft
          </button>
          {sessionView({ messageDraft: draft, onMessageDraftChange: setDraft, queuedFollowUps: items, onQueuedFollowUpsChange: setItems, sendRecovery: recovery })}
        </>
      );
    }
    render(<QueueHarness />);
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(queue).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Next draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(queue).toHaveLength(2));
    expect(screen.queryByRole("region", { name: "Recoverable session input" })).toBeNull();
    const [first, second] = sends();
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "response", command: "get_state", success: true, data: { queuedMessageCount: 0 } }));
    });
    expect(queue.map((item) => item.text)).toEqual(["first", "second"]);
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "alinery_dispatch", dispatch_id: second?.id, status: "consumed" }));
    });
    expect(queue.map((item) => item.text)).toEqual(["first"]);
    expect(screen.queryByRole("region", { name: "Recoverable session input" })).toBeNull();
    expect(recovery.has(first?.id ?? "")).toBe(true);
    expect(recovery.has(second?.id ?? "")).toBe(true);
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "alinery_dispatch", dispatch_id: second?.id, status: "settled" }));
    });
    expect(recovery.has(second?.id ?? "")).toBe(false);
    expect(recovery.has(first?.id ?? "")).toBe(true);
  });

  it.each(["before", "after"])("retires only a consumed dispatch row %s its native echo with equal captions and different images", async (order) => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    copyChatAttachments.mockResolvedValue({ copied: ["shot.png"], failures: [] });
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    const view = renderSession({ messageDraft: { body: "same review", pendingActions: [], attachments: [diskPng] } });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    await flushPromises();
    view.rerender(sessionView({ messageDraft: { body: "same review", pendingActions: [], attachments: [blobPng] } }));
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(sends()).toHaveLength(2));
    await act(async () => {
      const echo = JSON.stringify({
        type: "message_start",
        message: {
          role: "user",
          content: [
            { type: "text", text: "same review" },
            { type: "image", mimeType: "image/png", data: "first-image" },
          ],
        },
      });
      const consumed = JSON.stringify({ type: "alinery_dispatch", dispatch_id: sends()[0]?.id, status: "consumed" });
      for (const line of order === "before" ? [consumed, echo] : [echo, consumed]) onLine.current?.(line);
      onLine.current?.(JSON.stringify({ type: "alinery_dispatch", dispatch_id: sends()[0]?.id, status: "settled" }));
    });
    const pane = within(screen.getByTestId("chat-pane"));
    expect(pane.getAllByText("same review")).toHaveLength(2);
    expect(pane.getAllByText("queued · after this turn")).toHaveLength(1);
    const queuedRow = pane.getByText("queued · after this turn").closest("article");
    expect(queuedRow?.querySelector("img")?.getAttribute("src")).toBe(blobPng.previewUrl);
    expect(sends()).toHaveLength(2);
    await act(async () => {
      const echo = JSON.stringify({
        type: "message_start",
        message: {
          role: "user",
          content: [
            { type: "text", text: "same review" },
            { type: "image", mimeType: "image/png", data: "second-image" },
          ],
        },
      });
      const consumed = JSON.stringify({ type: "alinery_dispatch", dispatch_id: sends()[1]?.id, status: "consumed" });
      for (const line of order === "before" ? [consumed, echo] : [echo, consumed]) onLine.current?.(line);
      onLine.current?.(JSON.stringify({ type: "alinery_dispatch", dispatch_id: sends()[1]?.id, status: "settled" }));
    });
    expect(pane.getAllByText("same review")).toHaveLength(2);
    expect(pane.queryByText("queued · after this turn")).toBeNull();
    const images = [...screen.getByTestId("chat-pane").querySelectorAll("img")].map((image) => image.getAttribute("src"));
    expect(images).toEqual(expect.arrayContaining(["data:image/png;base64,first-image", "data:image/png;base64,second-image"]));
  });

  it("drops a refused follow-up from the queued list, so a reattach does not bring its row back", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    function QueueHarness({ mounted = true }: { mounted?: boolean }) {
      const [queued, setQueued] = useState<QueuedFollowUp[]>([]);
      const [draft, setDraft] = useState<SessionMessageDraft>({ body: "later", pendingActions: [], attachments: [] });
      return mounted ? sessionView({ messageDraft: draft, onMessageDraftChange: setDraft, queuedFollowUps: queued, onQueuedFollowUpsChange: setQueued }) : null;
    }
    const view = render(<QueueHarness />);
    await flushPromises();
    await waitFor(() => expect(onLine.current).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await screen.findByText("queued · after this turn");
    const commandId = sends()[0]?.id;
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "alinery_dispatch", dispatch_id: commandId, status: "rejected", reason: "Agent is not processing" }));
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("later");
    expect(screen.queryByText(/queued · after this turn/)).toBeNull();
    view.rerender(<QueueHarness mounted={false} />);
    view.rerender(<QueueHarness />);
    await flushPromises();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("later");
    expect(screen.queryByText(/queued · after this turn/)).toBeNull();
    expect(sends()).toHaveLength(1);
  });

  it("keeps queuing after an unrelated RPC failure between write and turn_start", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    const view = renderSession({ messageDraft: { body: "first", pendingActions: [], attachments: [] } });
    await flushPromises();
    await waitFor(() => expect(onLine.current).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(1));

    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "response", id: "state-1", command: "get_state", success: false, error: "temporary" }));
    });

    view.rerender(sessionView({ messageDraft: { body: "second", pendingActions: [], attachments: [] } }));
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));

    await waitFor(() => expect(sends()).toHaveLength(2));
    expect(sends().map((payload) => [payload?.type, payload?.message])).toEqual([
      ["prompt", "first"],
      ["follow_up", "second"],
    ]);
  });

  it("keeps send enabled and writes follow_up while waiting for approval", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "waiting_for_approval", correlation_id: "appr-1" }));

    renderSession({ messageDraft: { body: "later", pendingActions: [], attachments: [] } });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0]).toMatchObject({ type: "follow_up", message: "later" });
    expect(rpcWriteSession.mock.calls.some(([, payload]) => (payload as { type?: string } | null)?.type === "abort_and_prompt")).toBe(false);
  });

  it("rehydrates queued follow-ups after journal seed", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    renderSession({ queuedFollowUps: [{ text: "keep me", attachments: [] }] });
    await flushPromises();
    expect(await screen.findByText("keep me")).toBeTruthy();
    expect(screen.getByText("queued · after this turn")).toBeTruthy();
  });

  it("does not trim in-flight follow-ups on a non-get_state line", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    function QueueHarness() {
      const [queued, setQueued] = useState<QueuedFollowUp[]>([{ text: "first", attachments: [] }]);
      const [draft, setDraft] = useState<SessionMessageDraft>({ body: "second", pendingActions: [], attachments: [] });
      return sessionView({
        queuedFollowUps: queued,
        onQueuedFollowUpsChange: setQueued,
        messageDraft: draft,
        onMessageDraftChange: setDraft,
      });
    }
    render(<QueueHarness />);
    await flushPromises();
    await waitFor(() => expect(onLine.current).toBeDefined());
    expect(await screen.findByText("first")).toBeTruthy();
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "response", command: "get_state", success: true, data: { queuedMessageCount: 1 } }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(await screen.findByText("second")).toBeTruthy();
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "thinking_delta" }));
    });
    const pane = screen.getByTestId("chat-pane");
    expect(within(pane).getByText("first")).toBeTruthy();
    expect(within(pane).getByText("second")).toBeTruthy();
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "response", command: "get_state", success: true, data: { queuedMessageCount: 2 } }));
    });
    expect(within(pane).getByText("first")).toBeTruthy();
    expect(within(pane).getByText("second")).toBeTruthy();
  });

  it("Send now with empty draft aborts and prompts the latest queued text", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    renderSession({ queuedFollowUps: [{ text: "later", attachments: [], dispatchId: "queued-later" }], messageDraft: { body: "", pendingActions: [], attachments: [] } });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(rpcWriteSession.mock.calls.some(([, payload]) => (payload as { type?: string } | null)?.type === "abort_and_prompt")).toBe(true));
    const sent = rpcWriteSession.mock.calls.map(([, payload]) => payload as { type?: string; message?: string }).find((payload) => payload?.type === "abort_and_prompt");
    expect(sent).toMatchObject({ type: "abort_and_prompt", message: "later" });
  });

  it("Send now with a draft aborts and prompts that draft", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    renderSession({ queuedFollowUps: [{ text: "later", attachments: [] }], messageDraft: { body: "now", pendingActions: [], attachments: [] } });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(rpcWriteSession.mock.calls.some(([, payload]) => (payload as { type?: string } | null)?.type === "abort_and_prompt")).toBe(true));
    const sent = rpcWriteSession.mock.calls.map(([, payload]) => payload as { type?: string; message?: string }).find((payload) => payload?.type === "abort_and_prompt");
    expect(sent).toMatchObject({ type: "abort_and_prompt", message: "now" });
  });

  it("does not enable Send now while waiting for input or approval", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "waiting_for_input", correlation_id: "ask-1" }));
    renderSession({ messageDraft: { body: "later", pendingActions: [], attachments: [] }, queuedFollowUps: [{ text: "queued", attachments: [] }] });
    await flushPromises();
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();

    cleanup();
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "waiting_for_approval", correlation_id: "appr-1" }));

    renderSession({ messageDraft: { body: "later", pendingActions: [], attachments: [] }, queuedFollowUps: [{ text: "queued", attachments: [] }] });
    await flushPromises();
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  });

  it("writes get_state after a successful follow_up", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "waiting_for_input", correlation_id: "ask-1" }));
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    renderSession({ messageDraft: { body: "queue me", pendingActions: [], attachments: [] } });
    await flushPromises();
    await waitFor(() => expect(onLine.current).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    const followUp = sends()[0] as { id?: string };
    const before = rpcWriteSession.mock.calls.filter(([, payload]) => (payload as { type?: string } | null)?.type === "get_state").length;
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "response", id: followUp.id, command: "follow_up", success: true, data: {} }));
    });
    await waitFor(() => expect(rpcWriteSession.mock.calls.filter(([, payload]) => (payload as { type?: string } | null)?.type === "get_state").length).toBeGreaterThan(before));
  });

  const diskPng = {
    id: "img-1",
    kind: "image" as const,
    name: "shot.png",
    mimeType: "image/png",
    bytes: 12,
    sourcePath: "/tmp/shot.png",
  };
  const blobPng = {
    id: "img-blob",
    kind: "image" as const,
    name: "paste.png",
    mimeType: "image/png",
    bytes: 12,
    previewUrl: "blob:http://localhost/paste",
  };
  const diskPdf = {
    id: "file-1",
    kind: "file" as const,
    name: "notes.pdf",
    mimeType: "application/pdf",
    bytes: 100,
    sourcePath: "/tmp/notes.pdf",
  };

  it("copies a disk image then writes prompt images, never the other way around", async () => {
    const order: string[] = [];
    copyChatAttachments.mockImplementation(async () => {
      order.push("copy");
      return { copied: ["shot.png"], failures: [] };
    });
    readChatImage.mockResolvedValue({ mime_type: "image/png", data: "aa" });
    rpcWriteSession.mockImplementation(async (_id: string, payload: unknown) => {
      if (payload && typeof payload === "object" && "type" in payload && payload.type === "prompt") order.push("write");
      return { status: "written" as const };
    });
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    const messageDraft = { body: "see this", pendingActions: [], attachments: [diskPng] } as SessionMessageDraft;
    renderSession({ messageDraft });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(order.slice(0, 2)).toEqual(["copy", "write"]);
    expect(readChatImage).toHaveBeenCalled();
    const payload = sends()[0];
    expect(payload).toMatchObject({ type: "prompt", message: "see this" });
    expect(payload && "images" in payload && payload.images).toEqual([{ type: "image", data: "aa", mimeType: "image/png" }]);
  });

  it("sends a pdf as a path trailer without images or a vision read", async () => {
    copyChatAttachments.mockResolvedValue({ copied: ["notes.pdf"], failures: [] });
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    const messageDraft = { body: "see file", pendingActions: [], attachments: [diskPdf] } as SessionMessageDraft;
    renderSession({ messageDraft });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(readChatImage).not.toHaveBeenCalled();
    const payload = sends()[0];
    expect(payload && "message" in payload && typeof payload.message === "string" && payload.message.includes("Attached file: ")).toBe(true);
    expect(payload && "message" in payload && typeof payload.message === "string" && payload.message.includes("notes.pdf")).toBe(true);
    expect(payload && "images" in payload).toBe(false);
  });

  it("sends an empty caption with images", async () => {
    copyChatAttachments.mockResolvedValue({ copied: ["shot.png"], failures: [] });
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    const messageDraft = { body: "", pendingActions: [], attachments: [diskPng] } as SessionMessageDraft;
    renderSession({ messageDraft });
    await flushPromises();
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(sends()).toHaveLength(1));
    const payload = sends()[0];
    expect(payload).toMatchObject({ type: "prompt", message: "" });
    expect(payload && "images" in payload && payload.images).toEqual([{ type: "image", data: "aa", mimeType: "image/png" }]);
  });

  it("toasts an oversize path and does not copy or write", async () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => undefined);
    chatFileStat.mockResolvedValue({ name: "shot.png", bytes: 5 * 1024 * 1024 + 1 });
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    const oversized = { ...diskPng, bytes: 5 * 1024 * 1024 + 1 };
    const messageDraft = { body: "see this", pendingActions: [], attachments: [oversized] } as SessionMessageDraft;
    renderSession({ messageDraft });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flushPromises();
    expect(error).toHaveBeenCalled();
    expect(copyChatAttachments).not.toHaveBeenCalled();
    expect(sends()).toHaveLength(0);
    error.mockRestore();
  });

  it("toasts a copy failure, does not write, and keeps the draft attachments", async () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => undefined);
    const onDraftChange = vi.fn();
    copyChatAttachments.mockResolvedValue({ copied: [], failures: ["shot.png — disk full"] });
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    const messageDraft = { body: "see this", pendingActions: [], attachments: [diskPng] } as SessionMessageDraft;
    renderSession({ messageDraft, onMessageDraftChange: onDraftChange });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flushPromises();
    expect(error).toHaveBeenCalled();
    expect(sends()).toHaveLength(0);
    expect(onDraftChange).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("retries the copied image after a refusal even when the original disk file is gone", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    copyChatAttachments.mockResolvedValue({ copied: ["stored-shot.png"], failures: [] });
    readChatImage.mockImplementation(async (_slug, name) => {
      if (name !== "stored-shot.png") throw new Error("Original attachment is unavailable");
      return { mime_type: "image/png", data: "original-image-bytes" };
    });
    let promptCount = 0;
    rpcWriteSession.mockImplementation(async (_id, payload) => {
      if (typeof payload === "object" && payload !== null && "type" in payload && payload.type === "prompt" && ++promptCount === 1) {
        return { status: "not_sent", reason: "Not yet available" };
      }
      return { status: "written" };
    });
    function DraftHarness() {
      const [draft, setDraft] = useState<SessionMessageDraft>({ body: "Keep these exact image bytes", pendingActions: [], attachments: [diskPng] });
      return sessionView({ messageDraft: draft, onMessageDraftChange: setDraft });
    }
    render(<DraftHarness />);
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Not yet available");
    expect(sends()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Remove shot.png" })).toBeDefined();
    chatFileStat.mockRejectedValue(new Error("Original disk file was removed"));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(2));
    const retried = sends()[1];
    expect(retried && "images" in retried && retried.images).toEqual([{ type: "image", data: "original-image-bytes", mimeType: "image/png" }]);
  });

  it("preserves a rejected draft and image when the native refusal precedes the transport ACK", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    copyChatAttachments.mockResolvedValue({ copied: ["shot.png"], failures: [] });
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    let acknowledge!: () => void;
    const transportAck = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    rpcWriteSession.mockImplementation(async (_id: string, payload: unknown) => {
      if ((payload as { type?: string } | null)?.type === "prompt") await transportAck;
      return { status: "written" as const };
    });
    function DraftHarness() {
      const [draft, setDraft] = useState<SessionMessageDraft>({ body: "keep this review", pendingActions: [], attachments: [diskPng] });
      return sessionView({ messageDraft: draft, onMessageDraftChange: setDraft });
    }
    render(<DraftHarness />);
    await flushPromises();
    await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
    await waitFor(() => expect(onLine.current).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    const sent = sends()[0];
    expect(sent).toMatchObject({ type: "prompt", message: "keep this review", images: [{ type: "image", data: "aa", mimeType: "image/png" }] });
    expect(sent?.id).toEqual(expect.any(String));
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "alinery_dispatch", dispatch_id: sent?.id, status: "rejected", reason: "Session is finishing" }));
    });
    await act(async () => {
      acknowledge();
      await transportAck;
    });
    await flushPromises();

    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("keep this review");
    expect(screen.getByRole("button", { name: "Remove shot.png" })).toBeDefined();
    expect(screen.getByText("Session is finishing")).toBeDefined();
    expect(within(screen.getByTestId("chat-pane")).queryByText("keep this review")).toBeNull();
    expect(sends()).toHaveLength(1);
  });

  it.each([
    { button: "Send", command: "prompt", busy: false },
    { button: "Queue", command: "follow_up", busy: true },
    { button: "Send now", command: "abort_and_prompt", busy: true },
  ])("preserves the caption and image for retry when $button exceeds the daemon request limit", async ({ button, command, busy }) => {
    sessionStatus.mockResolvedValue(busy ? liveObservation("rpc", { state: "busy" }) : liveObservation("rpc"));
    const onDraftChange = vi.fn();
    const onQueuedFollowUpsChange = vi.fn();
    const rejection = new Error("request-too-large: control request exceeds the 67108864 byte limit");
    const attempts: unknown[] = [];
    rpcWriteSession.mockImplementation(async (_id: string, payload: unknown) => {
      if (typeof payload !== "object" || payload === null || !("type" in payload) || payload.type !== command) return { status: "written" };
      attempts.push(payload);
      if (attempts.length === 1) throw rejection;
      return { status: "written" as const };
    });
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      renderSession({
        messageDraft: { body: "keep this caption", pendingActions: [], attachments: [blobPng] },
        onMessageDraftChange: onDraftChange,
        queuedFollowUps: [],
        onQueuedFollowUpsChange,
      });
      await flushPromises();
      fireEvent.click(screen.getByRole("button", { name: button }));

      expect(await within(screen.getByTestId("chat-pane")).findByText(String(rejection), { exact: false })).toBeDefined();
      expect(attempts).toEqual([
        expect.objectContaining({
          type: command,
          message: "keep this caption",
          images: [{ type: "image", data: "aa", mimeType: "image/png" }],
        }),
      ]);
      expect((screen.getByRole("textbox", { name: busy ? "Send after this turn…" : "Message or /command" }) as HTMLTextAreaElement).value).toBe("keep this caption");
      const preview = screen.getByRole("button", { name: "Remove paste.png" }).parentElement?.querySelector("img");
      expect(preview?.getAttribute("src")).toBe(blobPng.previewUrl);
      expect(revoke).not.toHaveBeenCalled();
      expect(onDraftChange).not.toHaveBeenCalled();
      expect(onQueuedFollowUpsChange).not.toHaveBeenCalled();
      expect(within(screen.getByTestId("chat-pane")).queryByText("keep this caption")).toBeNull();
      expect(screen.queryByText("queued · after this turn")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: button }));
      await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith({ body: "", pendingActions: [], attachments: [] }));
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toMatchObject({
        type: command,
        message: "keep this caption",
        images: [{ type: "image", data: "aa", mimeType: "image/png" }],
      });
      expect(screen.queryByText(String(rejection))).toBeNull();
    } finally {
      revoke.mockRestore();
    }
  });

  it("transfers only the selected queued identity on Send now and preserves the earlier queue", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    let queue: QueuedFollowUp[] = [];
    function TransferHarness() {
      const [items, setItems] = useState<QueuedFollowUp[]>([
        { text: "earlier", attachments: [], dispatchId: "earlier-id" },
        { text: "selected", attachments: [], dispatchId: "selected-id" },
      ]);
      queue = items;
      return sessionView({ queuedFollowUps: items, onQueuedFollowUpsChange: setItems });
    }
    render(<TransferHarness />);
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() =>
      expect(rpcWriteSession.mock.calls.some(([, payload]) => typeof payload === "object" && payload !== null && "type" in payload && payload.type === "abort_and_prompt")).toBe(
        true,
      ),
    );
    const command = rpcWriteSession.mock.calls
      .map(([, payload]) => payload)
      .find((payload) => typeof payload === "object" && payload !== null && "type" in payload && payload.type === "abort_and_prompt");
    expect(command).toMatchObject({ transfer_dispatch_id: "selected-id", message: "selected" });
    expect(queue.map((item) => item.text)).toEqual(["earlier", "selected"]);
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "alinery_dispatch", dispatch_id: "selected-id", status: "settled" }));
    });
    expect(queue.map((item) => item.text)).toEqual(["earlier"]);
  });

  it.each(["not_sent", "rejected", "unknown"] as const)("preserves queued ownership and the composer after a %s Send now transfer", async (outcome) => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    let resolveWrite!: (result: DispatchOutcome) => void;
    const write = new Promise<DispatchOutcome>((resolve) => {
      resolveWrite = resolve;
    });
    const attempts: Array<{ id: string }> = [];
    rpcWriteSession.mockImplementation(async (_id, payload) => {
      if (typeof payload === "object" && payload !== null && "type" in payload && payload.type === "abort_and_prompt" && "id" in payload && typeof payload.id === "string") {
        attempts.push({ id: payload.id });
        return write;
      }
      return { status: "written" };
    });
    const onDraftChange = vi.fn();
    const onQueueChange = vi.fn();
    const recovery = new Map<string, SessionSendRecovery>();
    const props = {
      queuedFollowUps: [{ text: "selected queued message", attachments: [blobPng], dispatchId: "selected-id" }],
      onQueuedFollowUpsChange: onQueueChange,
      onMessageDraftChange: onDraftChange,
      sendRecovery: recovery,
    };
    const view = renderSession(props);
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(attempts).toHaveLength(1));
    const command = attempts[0];
    const body = outcome === "not_sent" ? "" : "newer draft";
    view.rerender(sessionView({ ...props, messageDraft: { body, pendingActions: [], attachments: [] } }));
    onDraftChange.mockClear();
    onQueueChange.mockClear();
    await act(async () => {
      resolveWrite(outcome === "rejected" ? { status: "written" } : { status: outcome, reason: "transfer failed" });
    });
    if (outcome === "rejected") {
      await act(async () => {
        onLine.current?.(JSON.stringify({ type: "alinery_dispatch", dispatch_id: command.id, status: "rejected", reason: "transfer failed" }));
      });
    }
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(body);
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onQueueChange).not.toHaveBeenCalled();
    expect(within(screen.getByTestId("chat-pane")).getAllByText("selected queued message")).toHaveLength(1);
    expect(attempts).toHaveLength(1);
    expect(screen.getByText("queued · after this turn")).toBeDefined();
    if (outcome === "unknown") {
      expect(screen.getByText(/Delivery unknown:/)).toBeDefined();
      expect(screen.queryByText(/The message remains queued/)).toBeNull();
      expect(recovery.get(command.id)?.status).toBe("unknown");
    } else {
      expect(screen.getByText(/The message remains queued/)).toBeDefined();
      expect(screen.queryByRole("button", { name: "Copy original message" })).toBeNull();
      expect(recovery.has(command.id)).toBe(false);
    }
  });

  it("keeps an image follow-up recoverable through rejected Send now and transport-only retry ACK", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    const onDraftChange = vi.fn();
    const onQueuedFollowUpsChange = vi.fn();
    const rejection = new Error("request-too-large: control request exceeds the 67108864 byte limit");
    const attempts: unknown[] = [];
    rpcWriteSession.mockImplementation(async (_id: string, payload: unknown) => {
      if (typeof payload !== "object" || payload === null || !("type" in payload) || payload.type !== "abort_and_prompt") return { status: "written" };
      attempts.push(payload);
      if (attempts.length === 1) throw rejection;
      return { status: "written" as const };
    });
    renderSession({
      messageDraft: { body: "", pendingActions: [], attachments: [] },
      onMessageDraftChange: onDraftChange,
      queuedFollowUps: [{ text: "keep this queued caption", attachments: [blobPng], dispatchId: "queued-image" }],
      onQueuedFollowUpsChange,
    });
    await flushPromises();
    onQueuedFollowUpsChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    expect(await within(screen.getByTestId("chat-pane")).findByText(String(rejection), { exact: false })).toBeDefined();
    expect(within(screen.getByTestId("chat-pane")).getByText("keep this queued caption")).toBeDefined();
    expect(screen.getByText("queued · after this turn")).toBeDefined();
    expect(onQueuedFollowUpsChange).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(attempts).toEqual([
      expect.objectContaining({
        type: "abort_and_prompt",
        message: "keep this queued caption",
        images: [{ type: "image", data: "aa", mimeType: "image/png" }],
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(attempts).toHaveLength(2));
    expect(attempts[1]).toMatchObject({
      type: "abort_and_prompt",
      message: "keep this queued caption",
      images: [{ type: "image", data: "aa", mimeType: "image/png" }],
    });
    expect(screen.getByText("queued · after this turn")).toBeDefined();
    expect(screen.queryByText(String(rejection))).toBeNull();
  });

  it("refuses slash plus attachments without writing", async () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => undefined);
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    const messageDraft = { body: "/model", pendingActions: [], attachments: [diskPng] } as SessionMessageDraft;
    renderSession({ messageDraft });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flushPromises();
    expect(error).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Models" })).toBeNull();
    expect(sends()).toHaveLength(0);
    error.mockRestore();
  });

  it("queues follow_up images without storing base64 on the queue item", async () => {
    copyChatAttachments.mockResolvedValue({ copied: ["paste.png"], failures: [] });
    writeChatAttachmentBytes.mockResolvedValue("paste.png");
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "waiting_for_input", correlation_id: "ask-1" }));
    const onQueuedFollowUpsChange = vi.fn();
    const messageDraft = { body: "later", pendingActions: [], attachments: [blobPng] } as SessionMessageDraft;
    renderSession({ messageDraft, queuedFollowUps: [], onQueuedFollowUpsChange });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    const payload = sends()[0];
    expect(payload).toMatchObject({ type: "follow_up" });
    expect(payload && "images" in payload && payload.images).toEqual([{ type: "image", data: "aa", mimeType: "image/png" }]);
    expect(onQueuedFollowUpsChange).toHaveBeenCalled();
    const queued = onQueuedFollowUpsChange.mock.calls[0]?.[0];
    expect(Array.isArray(queued)).toBe(true);
    const item = Array.isArray(queued) ? queued[0] : undefined;
    expect(item && typeof item === "object" && item !== null && "text" in item && item.text).toBe("later");
    expect(item && typeof item === "object" && item !== null && "attachments" in item).toBe(true);
    const attachments = item && typeof item === "object" && "attachments" in item ? item.attachments : undefined;
    expect(Array.isArray(attachments) && attachments[0] && typeof attachments[0] === "object" && attachments[0] !== null && "previewUrl" in attachments[0]).toBe(true);
    expect(Array.isArray(attachments) && attachments[0] && typeof attachments[0] === "object" && attachments[0] !== null && "data" in attachments[0]).toBe(false);
  });

  it("keeps blob preview ownership when a correlated refusal restores the attachment", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    writeChatAttachmentBytes.mockResolvedValue("paste.png");
    copyChatAttachments.mockResolvedValue({ copied: ["paste.png"], failures: [] });
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    const restore = vi.fn();
    renderSession({ messageDraft: { body: "see this", pendingActions: [], attachments: [blobPng] }, onMessageDraftChange: restore });
    await flushPromises();
    await waitFor(() => expect(onLine.current).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    const commandId = sends()[0]?.id;
    await act(async () => {
      onLine.current?.(
        JSON.stringify({
          type: "alinery_dispatch",
          dispatch_id: commandId,
          status: "rejected",
          reason: "Agent is already processing",
        }),
      );
    });
    expect(revoke).not.toHaveBeenCalled();
    await waitFor(() => expect(restore).toHaveBeenCalled());
    const restored = restore.mock.calls.find((call) => {
      const draft = call[0];
      return draft && typeof draft === "object" && "attachments" in draft;
    })?.[0];
    expect(restored && typeof restored === "object" && "attachments" in restored).toBe(true);
    revoke.mockRestore();
  });

  it("includes images on abort_and_prompt Send now", async () => {
    copyChatAttachments.mockResolvedValue({ copied: ["shot.png"], failures: [] });
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    const messageDraft = { body: "now", pendingActions: [], attachments: [diskPng] } as SessionMessageDraft;
    renderSession({ queuedFollowUps: [{ text: "later", attachments: [] }], messageDraft });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() =>
      expect(rpcWriteSession.mock.calls.some(([, payload]) => payload && typeof payload === "object" && "type" in payload && payload.type === "abort_and_prompt")).toBe(true),
    );
    const sent = rpcWriteSession.mock.calls
      .map(([, payload]) => payload)
      .find((payload) => payload && typeof payload === "object" && "type" in payload && payload.type === "abort_and_prompt");
    expect(sent && typeof sent === "object" && "images" in sent && sent.images).toEqual([{ type: "image", data: "aa", mimeType: "image/png" }]);
  });
});

describe("session chat attach handshake", () => {
  beforeEach(() => {
    scenario.tasks = [{ ...task }];
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    rpcWriteSession.mockReset().mockResolvedValue({ status: "written" });
    rpcAttachSession.mockReset();
    rpcAttachSession.mockImplementation(async () => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    sessionStatus.mockReset();
    sessionStatus.mockResolvedValue({ lifecycle: { state: "exited" as const, code: 0 }, state: null, checkpoint: {} });
    rpcWriteSession.mockReset().mockResolvedValue({ status: "written" });
  });

  const commands = (type: string) =>
    rpcWriteSession.mock.calls
      .map(([, payload]) => payload)
      .filter(
        (payload): payload is { type: string; id: string } =>
          !!payload && typeof payload === "object" && "type" in payload && payload.type === type && "id" in payload && typeof payload.id === "string",
      );

  it("does not mutate matching native compaction preferences when attaching or reattaching", async () => {
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    renderSession();
    for (let pass = 0; pass < 2; pass++) {
      await waitFor(() => expect(commands("get_available_models")).not.toEqual([]));
      const states = commands("get_state");
      expect(states.length).toBeGreaterThan(0);
      await act(async () => {
        for (const state of states)
          onLine.current?.(JSON.stringify({ type: "response", id: state.id, command: "get_state", success: true, data: { autoCompactionEnabled: true } }));
        onLine.current?.(JSON.stringify({ type: "response", id: null, command: "get_state", success: true, data: { autoCompactionEnabled: false } }));
      });
      expect(commands("set_auto_compaction")).toEqual([]);
      if (pass === 0) {
        rpcWriteSession.mockClear();
        await act(async () => onStreamClosed.mock.calls[onStreamClosed.mock.calls.length - 1]?.[2]?.());
      }
    }
  });

  it("synchronizes changed compaction preferences only from the fresh correlated state reply", async () => {
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    const view = renderSession();
    await waitFor(() => expect(commands("get_available_models")).not.toEqual([]));
    rpcWriteSession.mockClear();
    view.rerender(sessionView({ appearance: { ...DEFAULT_APPEARANCE, chat_auto_compaction: false } }));
    await waitFor(() => expect(commands("get_state")).toHaveLength(1));
    const request = commands("get_state")[0];
    await act(async () => onLine.current?.(JSON.stringify({ type: "response", id: "unrelated", command: "get_state", success: true, data: { autoCompactionEnabled: true } })));
    expect(commands("set_auto_compaction")).toEqual([]);
    await act(async () => onLine.current?.(JSON.stringify({ type: "response", id: request.id, command: "get_state", success: true, data: { autoCompactionEnabled: true } })));
    expect(commands("set_auto_compaction")).toEqual([expect.objectContaining({ type: "set_auto_compaction", enabled: false })]);
  });

  it("re-reads the journal when a dropped stream reattaches", async () => {
    renderSession();
    await waitFor(() => expect(rpcAttachSession).toHaveBeenCalledTimes(1));
    const reads = readSessionOmp.mock.calls.length;
    const onClosed = onStreamClosed.mock.calls[onStreamClosed.mock.calls.length - 1]?.[2];
    await act(async () => onClosed?.());
    await waitFor(() => expect(rpcAttachSession).toHaveBeenCalledTimes(2));
    expect(readSessionOmp.mock.calls.length).toBe(reads + 1);
  });

  // The rebuild reads back to the oldest row the transcript had loaded and keeps the rows in place, so
  // a reader who turned auto-scroll off is not thrown back to the tail.
  describe("reattach keeps the loaded history", () => {
    let stub: ReturnType<typeof stubScrollSize>;
    beforeEach(() => {
      stub = stubScrollSize();
    });
    afterEach(() => {
      stub.restore();
      readSessionOmp.mockReset().mockRejectedValue(new Error("no journal"));
    });

    const rows = () => [...document.querySelectorAll<HTMLElement>('[data-entry-id^="f:"]')].map((node) => node.dataset.entryId);
    const readerAt = (top: number) => {
      const list = document.querySelector(".chat-list") as HTMLElement;
      list.scrollTop = top;
      fireEvent.scroll(list);
    };
    const reattach = async () => {
      const attaches = rpcAttachSession.mock.calls.length;
      const onClosed = onStreamClosed.mock.calls[onStreamClosed.mock.calls.length - 1]?.[2];
      await act(async () => onClosed?.());
      await waitFor(() => expect(rpcAttachSession).toHaveBeenCalledTimes(attaches + 1));
    };
    const reads = () => readSessionOmp.mock.calls.map(([args]) => args);

    it("keeps the older rows the reader paged in, in place, with auto-scroll off", async () => {
      readSessionOmp.mockImplementation(async (args) => ((args as { end: number | null }).end === 500 ? journalPage(0, [["m1", "first"]]) : journalPage(500, [["m2", "second"]])));
      renderSession({ appearance: { ...DEFAULT_APPEARANCE, chat_auto_scroll: false } });
      await screen.findByText("second");
      readerAt(100);
      await screen.findByText("first");
      const first = document.querySelector('[data-entry-id="f:m1"]');
      readerAt(900);
      stub.writes.length = 0;
      readSessionOmp.mockClear();

      await reattach();
      await waitFor(() => expect(reads()).toHaveLength(2));
      expect(reads()).toEqual([expect.objectContaining({ end: null }), expect.objectContaining({ end: 500, want: 501 })]);
      expect(rows()).toEqual(["f:m1", "f:m2"]);
      expect(document.querySelector('[data-entry-id="f:m1"]')).toBe(first);
      expect(stub.writes).toEqual([]);
    });

    it("reads the whole gap when the journal grew by several windows, with auto-scroll off", async () => {
      let grown = false;
      readSessionOmp.mockImplementation(async (args) => {
        if (!grown) return journalPage(500, [["m2", "second"]]);
        return (args as { end: number | null }).end === null
          ? journalPage(2000, [["m4", "fourth"]])
          : journalPage(500, [
              ["m2", "second"],
              ["m3", "third"],
            ]);
      });
      renderSession({ appearance: { ...DEFAULT_APPEARANCE, chat_auto_scroll: false } });
      await screen.findByText("second");
      const second = document.querySelector('[data-entry-id="f:m2"]');
      readerAt(900);
      stub.writes.length = 0;
      grown = true;
      readSessionOmp.mockClear();

      await reattach();
      await screen.findByText("fourth");
      expect(reads()).toEqual([expect.objectContaining({ end: null }), expect.objectContaining({ end: 2000, want: 1501 })]);
      expect(rows()).toEqual(["f:m2", "f:m3", "f:m4"]);
      expect(document.querySelector('[data-entry-id="f:m2"]')).toBe(second);
      expect(stub.writes).toEqual([]);
    });
  });

  it("detaches again when an attach lands after the view let go of it", async () => {
    const landing = deferred<undefined>();
    rpcAttachSession.mockImplementation(() => landing.promise);
    detachSession.mockClear();
    const { unmount } = renderSession();
    await waitFor(() => expect(rpcAttachSession).toHaveBeenCalledTimes(1));
    const attach = rpcAttachSession.mock.calls[0]?.[0] as { attachId: number };
    unmount();
    expect(detachSession.mock.calls).toEqual([["session", attach.attachId]]);
    await act(async () => landing.resolve(undefined));
    await waitFor(() => expect(detachSession).toHaveBeenCalledTimes(2));
    expect(detachSession.mock.calls[1]).toEqual(["session", attach.attachId]);
    expect(rpcWriteSession.mock.calls.map(([, payload]) => (payload as { type?: string }).type)).not.toContain("negotiate_protocol");
  });

  it("writes get_subagents after set_subagent_subscription", async () => {
    renderSession();
    await waitFor(() => expect(rpcWriteSession.mock.calls.some(([, payload]) => (payload as { type?: string } | null)?.type === "set_subagent_subscription")).toBe(true));
    const types = rpcWriteSession.mock.calls.map(([, payload]) => (payload as { type?: string } | null)?.type);
    expect(types).toContain("get_subagents");
    expect(types.indexOf("get_subagents")).toBeGreaterThan(types.indexOf("set_subagent_subscription"));
  });

  const exitedRpc = {
    ...liveObservation("rpc"),
    lifecycle: { state: "live_exited" },
    state: {
      process: { state: "exited", code: 0 },
      agent: { state: "idle" },
      playbook: { state: "ready_to_advance" },
      adapter: "omp",
      message_adapter: "omp_bracketed_paste",
    },
  } satisfies SessionObservation;

  it("replays a completed RPC session without issuing live commands or error toasts", async () => {
    sessionStatus.mockResolvedValue(exitedRpc);
    rpcWriteSession.mockRejectedValue("session-exited");
    rpcAttachSession.mockImplementation(async (args) => {
      const attach = args as Parameters<typeof Ipc.rpcAttachSession>[0];
      attach.onLine(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Completed implementation." }] } }));
    });
    render(<Toast />);
    renderSession({ intent: "attach" });
    expect(await screen.findByText("Completed implementation.")).toBeTruthy();
    await flushPromises();
    expect(rpcWriteSession).not.toHaveBeenCalled();
    expect(within(screen.getByRole("status", { name: "Notifications" })).queryByText("session-exited")).toBeNull();
  });

  it.each(["busy agent", "unclosed replay"])("settles completed RPC chat with a retained %s", async (retained) => {
    sessionStatus.mockResolvedValue({
      ...exitedRpc,
      state: {
        ...exitedRpc.state,
        agent: { state: retained === "busy agent" ? "busy" : "idle" },
        playbook: { state: "completed" },
      },
      checkpoint: { phase_completed_at: 100 },
    });
    rpcAttachSession.mockImplementation(async (args) => {
      const attach = args as Parameters<typeof Ipc.rpcAttachSession>[0];
      if (retained === "unclosed replay") attach.onLine(JSON.stringify({ type: "turn_start" }));
      attach.onLine(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Completed implementation." }] } }));
    });
    const onDraftChange = vi.fn();
    const onQueuedFollowUpsChange = vi.fn();
    renderSession({
      intent: "attach",
      messageDraft: { body: "Keep this follow-up", pendingActions: [], attachments: [] },
      onMessageDraftChange: onDraftChange,
      onQueuedFollowUpsChange,
    });
    await screen.findByText("Completed implementation.");
    await flushPromises();

    expect(screen.getByText("Completed", { selector: ".statusdot" })).toBeDefined();
    expect(screen.queryByText("Working…")).toBeNull();
    expect(screen.queryByPlaceholderText("Send after this turn…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
    expect(rpcWriteSession).not.toHaveBeenCalled();

    // An ended process still refuses sends; the UI must not queue behind a nonexistent turn or lose the draft.
    rpcWriteSession.mockResolvedValue({ status: "not_sent", reason: "session exited" });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(commands("prompt")).toHaveLength(1));
    expect(commands("follow_up")).toEqual([]);
    expect(onQueuedFollowUpsChange).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalledWith({ body: "", pendingActions: [], attachments: [] });
  });

  it.each<AgentState>([{ state: "busy" }, { state: "waiting_for_approval", correlation_id: "approval" }])("keeps live $state turn activity", async (agent) => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", agent));
    renderSession({ intent: "attach" });
    expect(await screen.findByRole("button", { name: "Queue" })).toBeDefined();
    expect(screen.getByPlaceholderText("Send after this turn…")).toBeDefined();
  });

  it("settles Chat activity when a live process exits without a closing turn event", async () => {
    vi.useFakeTimers();
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    renderSession({ intent: "attach" });
    await flushPromises();
    await act(async () => onLine.current?.(JSON.stringify({ type: "turn_start" })));
    expect(screen.getByRole("button", { name: "Queue" })).toBeDefined();

    sessionStatus.mockResolvedValue({ ...exitedRpc, state: { ...exitedRpc.state, agent: { state: "busy" }, playbook: { state: "completed" } } });
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(screen.getByText("Completed", { selector: ".statusdot" })).toBeDefined();
    expect(screen.queryByText("Working…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeDefined();
  });

  it("reconciles a session that exits during the RPC handshake without showing an error", async () => {
    rpcWriteSession.mockImplementation(async (_id, payload) => {
      if (payload && typeof payload === "object" && "type" in payload && payload.type === "negotiate_protocol") {
        sessionStatus.mockResolvedValue(exitedRpc);
        throw "session-exited";
      }
      return { status: "written" as const };
    });
    render(<Toast />);
    renderSession({ messageDraft: { body: "keep draft", pendingActions: [], attachments: [] } });
    await flushPromises();
    expect(screen.queryByRole("group", { name: "Session view" })).toBeNull();
    expect(within(screen.getByRole("status", { name: "Notifications" })).queryByText("session-exited")).toBeNull();
    const draft = screen.getByLabelText("Message or /command") as HTMLTextAreaElement;
    expect(draft.value).toBe("keep draft");
  });

  it.each(["live", "unavailable"])("reports a real handshake error when refreshed status is %s", async (status) => {
    rpcWriteSession.mockImplementation(async (_id, payload) => {
      if (payload && typeof payload === "object" && "type" in payload && payload.type === "negotiate_protocol") {
        if (status === "unavailable") sessionStatus.mockRejectedValue(new Error("Status unavailable"));
        throw new Error("RPC connection failed");
      }
      return { status: "written" as const };
    });
    render(<Toast />);
    renderSession();
    expect(await within(screen.getByRole("status", { name: "Notifications" })).findByText("Error: RPC connection failed")).toBeTruthy();
  });

  it("does not re-attach after a transient sessionStatus rejection", async () => {
    vi.useFakeTimers();
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    renderSession();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushPromises();
    expect(rpcAttachSession).toHaveBeenCalledTimes(1);
    sessionStatus.mockRejectedValueOnce(new Error("poll failed"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    await flushPromises();
    expect(rpcAttachSession).toHaveBeenCalledTimes(1);
  });

  it("re-attaches after a poll failure once sessionStatus succeeds again", async () => {
    vi.useFakeTimers();
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    renderSession();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushPromises();
    expect(rpcAttachSession).toHaveBeenCalledTimes(1);
    sessionStatus.mockRejectedValueOnce(new Error("poll failed"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    await flushPromises();
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    await flushPromises();
    expect(rpcAttachSession).toHaveBeenCalledTimes(2);
  });
});

describe("session chat thinking level", () => {
  const reasoningState = {
    type: "response",
    command: "get_state",
    success: true,
    data: { model: { provider: "anthropic", id: "opus", reasoning: true, thinking: { efforts: ["low", "high"] } }, thinkingLevel: "high" },
  };
  const picker = () => screen.getByRole("combobox", { name: "Thinking level" }) as HTMLSelectElement;
  /** Attaches the chat and returns what feeds it OMP lines. */
  async function attached(status: SessionObservation, overrides: Partial<ComponentProps<typeof SessionView>> = {}) {
    sessionStatus.mockResolvedValue(status);
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    renderSession(overrides);
    await waitFor(() => expect(onLine.current).toBeDefined());
    return (...lines: object[]) =>
      act(async () => {
        for (const line of lines) onLine.current?.(JSON.stringify(line));
      });
  }

  beforeEach(() => {
    scenario.tasks = [{ ...task }];
    rpcWriteSession.mockReset().mockResolvedValue({ status: "written" });
    rpcAttachSession.mockReset();
    rpcAttachSession.mockImplementation(async () => undefined);
  });

  afterEach(() => {
    cleanup();
    sessionStatus.mockReset();
    sessionStatus.mockResolvedValue({ lifecycle: { state: "exited" as const, code: 0 }, state: null, checkpoint: {} });
    rpcWriteSession.mockReset().mockResolvedValue({ status: "written" });
  });

  it("keeps the status line's text with the level in it", async () => {
    const feed = await attached(liveObservation("rpc"), { model: "xai/grok" });
    await feed({ type: "response", command: "get_state", success: true, data: { thinkingLevel: "high" } });
    expect(document.querySelector(".chat-meta p")?.textContent).toMatch(/^xai\/grok · high · \d+ events?$/);
  });

  it("writes the level a pick names, and keeps showing OMP's until it confirms", async () => {
    const feed = await attached(liveObservation("rpc"));
    await feed(reasoningState);
    expect(picker().value).toBe("high");
    expect(picker().disabled).toBe(false);
    rpcWriteSession.mockClear();
    fireEvent.change(picker(), { target: { value: "low" } });
    expect(rpcWriteSession).toHaveBeenCalledExactlyOnceWith("session", expect.objectContaining({ type: "set_thinking_level", level: "low" }));
    expect(picker().value).toBe("high");
    await feed({ type: "thinking_level_changed", thinkingLevel: "low" });
    expect(picker().value).toBe("low");
  });

  it("toasts a pick OMP could not be sent", async () => {
    const feed = await attached(liveObservation("rpc"));
    render(<Toast />);
    await feed(reasoningState);
    rpcWriteSession.mockRejectedValueOnce("session-exited");
    fireEvent.change(picker(), { target: { value: "low" } });
    expect(await within(screen.getByRole("status", { name: "Notifications" })).findByText("session-exited")).toBeTruthy();
  });

  it("is disabled, with the reason, while the session's process is not running", async () => {
    const feed = await attached({
      ...liveObservation("rpc"),
      lifecycle: { state: "live_exited" },
      state: { process: { state: "exited", code: 0 }, agent: { state: "idle" }, playbook: { state: "ready_to_advance" }, adapter: "omp", message_adapter: "omp_bracketed_paste" },
    });
    await feed(reasoningState);
    expect(picker().disabled).toBe(true);
    expect(picker().title).toBe("The session is not running, so its thinking level cannot change");
  });
});

describe("review continuation", () => {
  function readyReply(revision: number | null = 7): TaskExecutionReply {
    const record = Object.assign(executionRecord({ owner_session_id: "session" }), {
      continuation_mode: "manual",
      work_revision: revision ?? 8,
      last_ready_revision: 7,
      ready_revision: revision,
      continuation_requested_revision: null,
    });
    return {
      ...executionReply([record]),
      assessment: { status: "active", reasons: [] },
      executions: { [record.id]: { destinations: [{ step_key: "review", title: "Review changes" }], terminality: "nonterminal", reasons: [] } },
      continuation: { [record.id]: { process_incarnation: "incarnation-a", available: true, reason: null } },
    };
  }
  beforeEach(() => {
    scenario.tasks = [task];
    scenario.tasksPromise = null;
    scenario.tasksError = null;
    sessionStatus.mockReset().mockResolvedValue(liveObservation("rpc"));
    rpcAttachSession.mockReset().mockResolvedValue(undefined);
    rpcWriteSession.mockReset().mockResolvedValue({ status: "written" });
    getTaskExecution.mockReset().mockResolvedValue(readyReply());
    continueExecution.mockReset().mockResolvedValue({ status: "requested", ready_revision: 7 });
    setStepContinuationForRepo.mockReset().mockResolvedValue({ ...task, auto_advance: ["worker"] });
    listSessions.mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    getTaskExecution.mockReset();
    listSessions.mockReset().mockResolvedValue([]);
    vi.useRealTimers();
  });

  const nudgeText =
    "Wrap up the current step, including my latest message requests. Preserve completed work; do not repeat completed actions unnecessarily. Verify the assigned artifacts. If the work is ready and no substantive approval or question remains, call `alinery_phase_complete` to report readiness again. Otherwise explain the blocker.";

  function nudgeSends() {
    return rpcWriteSession.mock.calls
      .map(([, payload]) => payload as { type?: string; message?: string; id?: string })
      .filter((payload) => payload.type === "prompt" || payload.type === "follow_up" || payload.type === "abort_and_prompt");
  }

  it("changes the owning step mode and reflects both selections", async () => {
    const reply = readyReply();
    getTaskExecution.mockImplementation(async () => structuredClone(reply));
    setStepContinuationForRepo.mockImplementation(async (_repo, _task, _step, automatic: boolean) => {
      reply.state.executions["execution-a"].continuation_mode = automatic ? "automatic" : "manual";
      return { ...task, auto_advance: automatic ? ["worker"] : [] };
    });
    renderSession();
    const manual = await screen.findByRole("button", { name: "Wait for me" });
    const automatic = screen.getByRole("button", { name: "Continue automatically" });
    expect(manual.getAttribute("aria-pressed")).toBe("true");
    expect(automatic.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(automatic);
    await waitFor(() => expect(automatic.getAttribute("aria-pressed")).toBe("true"));
    expect(manual.getAttribute("aria-pressed")).toBe("false");
    expect(setStepContinuationForRepo).toHaveBeenLastCalledWith("/repo", "task", "worker", true);
    fireEvent.click(manual);
    await waitFor(() => expect(manual.getAttribute("aria-pressed")).toBe("true"));
    expect(automatic.getAttribute("aria-pressed")).toBe("false");
    expect(setStepContinuationForRepo).toHaveBeenLastCalledWith("/repo", "task", "worker", false);
  });

  it("keeps the previous mode and allows retry when changing mode fails", async () => {
    setStepContinuationForRepo.mockRejectedValueOnce(new Error("Mode update unavailable"));
    renderSession();
    const automatic = await screen.findByRole("button", { name: "Continue automatically" });
    fireEvent.click(automatic);
    await waitFor(() => expect(automatic).toHaveProperty("disabled", false));
    expect(screen.getByRole("button", { name: "Wait for me" }).getAttribute("aria-pressed")).toBe("true");
    expect(automatic.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(automatic);
    await waitFor(() => expect(setStepContinuationForRepo).toHaveBeenCalledTimes(2));
  });

  it("nudges visibly without consuming the existing draft or attachment", async () => {
    const onDraftChange = vi.fn();
    const draft: SessionMessageDraft = {
      body: "My unfinished request",
      pendingActions: [],
      attachments: [{ id: "nudge-file", kind: "file", name: "notes.pdf", mimeType: "application/pdf", bytes: 100, sourcePath: "/tmp/notes.pdf" }],
    };
    renderSession({ messageDraft: draft, onMessageDraftChange: onDraftChange });
    const nudge = await screen.findByRole("button", { name: "Nudge to wrap up" });
    await waitFor(() => expect(nudge).toHaveProperty("disabled", false));
    fireEvent.click(nudge);
    await waitFor(() => expect(nudgeSends()).toHaveLength(1));
    expect(nudgeSends()[0]).toMatchObject({ type: "prompt", message: nudgeText });
    expect(await within(screen.getByTestId("chat-pane")).findByText(nudgeText)).toBeDefined();
    expect(screen.getByRole("textbox")).toHaveProperty("value", draft.body);
    expect(screen.getByRole("button", { name: "Remove notes.pdf" })).toBeDefined();
    expect(screen.queryByRole("region", { name: "Recoverable session input" })).toBeNull();
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("keeps automatic selected and prevents manual mode under Auto Approval All", async () => {
    const reply = readyReply();
    reply.state.auto_approve_all = true;
    getTaskExecution.mockResolvedValue(reply);
    renderSession();
    const manual = await screen.findByRole("button", { name: "Wait for me" });
    expect(manual).toHaveProperty("disabled", true);
    expect(manual.getAttribute("aria-pressed")).toBe("false");
    expect(manual.getAttribute("title")).toMatch(/Auto Approval All/i);
    expect(screen.getByRole("button", { name: "Continue automatically" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(manual);
    expect(setStepContinuationForRepo).not.toHaveBeenCalled();
  });

  it("sends a busy nudge now without consuming drafts or other queued work and inhibits duplicate clicks", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    const write = deferred<DispatchOutcome>();
    rpcWriteSession.mockImplementation(async (_id, payload) => {
      if (payload && typeof payload === "object" && "type" in payload && payload.type === "abort_and_prompt") return write.promise;
      return { status: "written" };
    });
    const onDraftChange = vi.fn();
    const onQueueChange = vi.fn();
    renderSession({
      messageDraft: {
        body: "Keep my draft",
        pendingActions: [],
        attachments: [{ id: "nudge-file", kind: "file", name: "notes.pdf", mimeType: "application/pdf", bytes: 100, sourcePath: "/tmp/notes.pdf" }],
      },
      onMessageDraftChange: onDraftChange,
      queuedFollowUps: [{ text: "Other queued work", attachments: [], dispatchId: "other-work" }],
      onQueuedFollowUpsChange: onQueueChange,
    });
    const nudge = await screen.findByRole("button", { name: "Nudge to wrap up" });
    await waitFor(() => expect(nudge).toHaveProperty("disabled", false));
    fireEvent.click(nudge);
    fireEvent.click(nudge);
    await waitFor(() => expect(nudgeSends()).toHaveLength(1));
    expect(nudgeSends()[0]).toMatchObject({ type: "abort_and_prompt", message: nudgeText });
    expect(nudgeSends()[0]).not.toHaveProperty("transfer_dispatch_id");
    expect(nudge).toHaveProperty("disabled", true);
    expect(screen.queryByRole("region", { name: "Recoverable session input" })).toBeNull();
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Keep my draft");
    expect(screen.getByRole("button", { name: "Remove notes.pdf" })).toBeDefined();
    expect(within(screen.getByTestId("chat-pane")).getByText(nudgeText)).toBeDefined();
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onQueueChange).toHaveBeenLastCalledWith([expect.objectContaining({ text: "Other queued work", dispatchId: "other-work" })]);
    await act(async () => write.resolve({ status: "written" }));
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "response", id: nudgeSends()[0].id, command: "abort_and_prompt", success: true }));
    });
    expect(screen.queryByRole("region", { name: "Recoverable session input" })).toBeNull();
    expect(nudge).toHaveProperty("disabled", true);
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "alinery_dispatch", dispatch_id: nudgeSends()[0].id, status: "consumed" }));
    });
    expect(screen.queryByRole("region", { name: "Recoverable session input" })).toBeNull();
    expect(nudge).toHaveProperty("disabled", true);
  });

  it.each(["not_sent", "rejected"] as const)("clears nudge pending state after %s so it can be retried", async (outcome) => {
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    captureRpcOnLine(onLine);
    rpcWriteSession.mockImplementation(async (_id, payload) => {
      if (payload && typeof payload === "object" && "type" in payload && payload.type === "abort_and_prompt") {
        if (outcome === "not_sent") return { status: "not_sent", reason: "Not admitted" };
      }
      return { status: "written" };
    });
    const onDraftChange = vi.fn();
    renderSession({ messageDraft: { body: "Keep my draft", pendingActions: [], attachments: [] }, onMessageDraftChange: onDraftChange });
    const nudge = await screen.findByRole("button", { name: "Nudge to wrap up" });
    await waitFor(() => expect(nudge).toHaveProperty("disabled", false));
    fireEvent.click(nudge);
    await waitFor(() => expect(nudgeSends()).toHaveLength(1));
    if (outcome === "rejected") {
      await act(async () => {
        onLine.current?.(JSON.stringify({ type: "alinery_dispatch", dispatch_id: nudgeSends()[0].id, status: "rejected", reason: "Not admitted" }));
      });
    }
    await waitFor(() => expect(nudge).toHaveProperty("disabled", false));
    expect(within(screen.getByTestId("chat-pane")).queryByText(nudgeText)).toBeNull();
    expect(onDraftChange).not.toHaveBeenCalled();
    fireEvent.click(nudge);
    await waitFor(() => expect(nudgeSends()).toHaveLength(2));
  });

  it("shows uncertain delivery and prevents a duplicate nudge after a lost acknowledgement", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    rpcWriteSession.mockImplementation(async (_id, payload) => {
      if (payload && typeof payload === "object" && "type" in payload && payload.type === "abort_and_prompt") throw new Error("Acknowledgement lost");
      return { status: "written" };
    });
    const onDraftChange = vi.fn();
    renderSession({ messageDraft: { body: "Keep my draft", pendingActions: [], attachments: [] }, onMessageDraftChange: onDraftChange });
    const nudge = await screen.findByRole("button", { name: "Nudge to wrap up" });
    await waitFor(() => expect(nudge).toHaveProperty("disabled", false));
    fireEvent.click(nudge);
    await screen.findByText(/Delivery unknown:/);
    expect(screen.getByRole("region", { name: "Recoverable session input" })).toBeDefined();
    expect(nudge).toHaveProperty("disabled", true);
    fireEvent.click(nudge);
    expect(nudgeSends()).toHaveLength(1);
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it.each(["taskless", "terminal"] as const)("does not offer playbook mode or nudge controls for %s sessions", async (kind) => {
    renderSession(kind === "taskless" ? { taskSlug: "", playbook: "" } : { harness: "no-harness" });
    await flushPromises();
    expect(screen.queryByRole("button", { name: "Wait for me" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue automatically" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Nudge to wrap up" })).toBeNull();
  });

  it.each(["approval", "disconnected", "ended", "handoff"] as const)("blocks nudge while %s", async (condition) => {
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    if (condition === "ended") sessionStatus.mockResolvedValue({ lifecycle: { state: "exited", code: 0 }, state: null, checkpoint: {} });
    if (condition === "handoff") {
      const reply = readyReply();
      reply.state.executions["execution-a"].continuation_requested_revision = 7;
      getTaskExecution.mockResolvedValue(reply);
    }
    renderSession();
    await flushPromises();
    if (condition === "approval") {
      await act(async () => {
        onLine.current?.(JSON.stringify({ type: "extension_ui_request", id: "nudge-approval", method: "confirm", title: "Approve deployment", message: "A substantive decision" }));
      });
      expect(screen.getByRole("button", { name: "Allow" })).toBeDefined();
    }
    if (condition === "disconnected") {
      await act(async () => {
        onStreamClosed.mock.calls[onStreamClosed.mock.calls.length - 1]?.[3]();
      });
    }
    const nudge = screen.queryByRole("button", { name: "Nudge to wrap up" });
    if (nudge) {
      expect(nudge).toHaveProperty("disabled", true);
      fireEvent.click(nudge);
    }
    expect(nudgeSends()).toHaveLength(0);
  });

  it.each(["manual", "automatic", "task override", "enabled while viewing"] as const)(
    "opens only the new successor after accepted shutdown and actual start in %s mode",
    async (mode) => {
      vi.useFakeTimers();
      const onOpenSession = vi.fn();
      const reply = readyReply();
      if (mode === "automatic") reply.state.executions["execution-a"].continuation_mode = "automatic";
      if (mode === "task override") reply.state.auto_approve_all = true;
      getTaskExecution.mockImplementation(async () => structuredClone(reply));
      const view = renderSession({ onOpenSession });
      await flushPromises();
      if (mode === "enabled while viewing") {
        setStepContinuationForRepo.mockImplementationOnce(async () => {
          reply.state.executions["execution-a"].continuation_mode = "automatic";
          return { ...task, auto_advance: ["worker"] };
        });
        fireEvent.click(screen.getByRole("button", { name: "Continue automatically" }));
        await flushPromises();
      }
      if (mode === "manual") fireEvent.click(screen.getByRole("button", { name: "Continue to Review changes" }));
      await flushPromises();
      const source = reply.state.executions["execution-a"];
      if (mode !== "manual") source.work_revision += 1;
      source.receipt_id = "receipt";
      source.lifecycle = "finishing";
      const successor = executionRecord({ id: "next", owner_session_id: "next-session", parent_execution_ids: [source.id], lifecycle: "queued" });
      successor.candidate.step_key = "review";
      reply.state.executions.next = successor;
      const session: SessionDisplayMeta = {
        id: "next-session",
        execution_id: "next",
        worktree: "/worktrees/task",
        created: 2,
        archived: false,
        phase: "review",
        harness: "omp",
        model: "",
        playbook: "retained",
        generic: false,
        harness_resume_token: "",
        started_at: 3,
      };
      listSessions.mockResolvedValue([session]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(onOpenSession).not.toHaveBeenCalled();
      source.lifecycle = "completed";
      source.shutdown_confirmed = true;
      reply.executions[source.id] = { destinations: [], reasons: [], terminality: "terminal" };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(onOpenSession).not.toHaveBeenCalled();
      successor.lifecycle = "running";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(session);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(onOpenSession).toHaveBeenCalledTimes(1);
      view.rerender(sessionView({ id: session.id, onOpenSession }));
      await flushPromises();
      if (mode === "automatic") {
        expect(screen.getByRole("button", { name: "Follow next session" }).getAttribute("aria-pressed")).toBe("true");
        successor.lifecycle = "completed";
        successor.receipt_id = "next-receipt";
        successor.shutdown_confirmed = true;
        const third = executionRecord({ id: "third", owner_session_id: "third-session", parent_execution_ids: [successor.id], continuation_mode: "manual" });
        reply.state.executions.third = third;
        const thirdSession = { ...session, id: "third-session", execution_id: "third", started_at: 4 };
        listSessions.mockResolvedValue([session, thirdSession]);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1500);
        });
        expect(onOpenSession).toHaveBeenLastCalledWith(thirdSession);
        expect(onOpenSession).toHaveBeenCalledTimes(2);
      }
      expect(screen.queryByText("Continuation requested; waiting for the handoff.")).toBeNull();
    },
  );

  it.each(["disabled", "historical", "fanout", "left session"] as const)("does not automatically redirect when %s", async (condition) => {
    vi.useFakeTimers();
    const onOpenSession = vi.fn();
    const reply = readyReply();
    const source = reply.state.executions["execution-a"];
    source.continuation_mode = "automatic";
    if (condition === "historical") {
      source.receipt_id = "receipt";
      source.lifecycle = "completed";
      source.shutdown_confirmed = true;
    }
    getTaskExecution.mockImplementation(async () => structuredClone(reply));
    const view = renderSession({ onOpenSession });
    await flushPromises();
    if (condition === "disabled") fireEvent.click(screen.getByRole("button", { name: "Follow next session" }));
    if (condition === "left session") view.rerender(sessionView({ id: "another-session", onOpenSession }));
    source.receipt_id = "receipt";
    source.lifecycle = "completed";
    source.shutdown_confirmed = true;
    const successor = executionRecord({ id: "next", owner_session_id: "next-session", parent_execution_ids: [source.id] });
    successor.candidate.step_key = "review";
    reply.state.executions.next = successor;
    if (condition === "fanout") reply.state.executions.second = { ...successor, id: "second", owner_session_id: "second-session" };
    listSessions.mockResolvedValue([
      {
        id: "next-session",
        execution_id: "next",
        worktree: "/worktrees/task",
        created: 2,
        archived: false,
        phase: "review",
        harness: "omp",
        model: "",
        playbook: "retained",
        generic: false,
        harness_resume_token: "",
        started_at: 3,
      },
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(onOpenSession).not.toHaveBeenCalled();
    if (condition === "disabled" || condition === "historical") {
      const follow = screen.getByRole("button", { name: "Follow next session" });
      expect(follow.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(follow);
      await flushPromises();
      expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "next-session" }));
      expect(setStepContinuationForRepo).not.toHaveBeenCalled();
    }
  });

  it("pauses following when the navigator opens another session", async () => {
    const onOpenSession = vi.fn();
    const reply = readyReply();
    const previous = executionRecord({ id: "previous", owner_session_id: "previous-session", lifecycle: "completed" });
    reply.state.executions.previous = previous;
    reply.state.executions["execution-a"].parent_execution_ids = [previous.id];
    getTaskExecution.mockResolvedValue(reply);
    listSessions.mockResolvedValue([
      {
        id: "previous-session",
        execution_id: "previous",
        name: "Previous step",
        name_source: "user",
        name_error: null,
        worktree: "/worktrees/task",
        created: 1,
        archived: false,
        phase: "worker",
        harness: "omp",
        model: "",
        playbook: "retained",
        generic: false,
        harness_resume_token: "",
        started_at: 1,
      },
    ]);
    renderSession({ onOpenSession });
    const follow = await screen.findByRole("button", { name: "Follow next session" });
    expect(follow.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByText("Session Navigator"));
    fireEvent.click(screen.getByRole("button", { name: /Previous step/ }));
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "previous-session" }));
    expect(follow.getAttribute("aria-pressed")).toBe("false");
  });

  it.each(["unrelated", "fanout", "follow off", "left session"] as const)("does not redirect after continuation when %s", async (condition) => {
    vi.useFakeTimers();
    const onOpenSession = vi.fn();
    const reply = readyReply();
    getTaskExecution.mockImplementation(async () => structuredClone(reply));
    const view = renderSession({ onOpenSession });
    await flushPromises();
    if (condition === "follow off") fireEvent.click(screen.getByRole("button", { name: "Follow next session" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Review changes" }));
    await flushPromises();
    if (condition === "left session") view.rerender(sessionView({ id: "another-session", onOpenSession }));
    const source = reply.state.executions["execution-a"];
    source.receipt_id = "receipt";
    source.lifecycle = "completed";
    source.shutdown_confirmed = true;
    const successor = executionRecord({ id: "next", owner_session_id: "next-session", parent_execution_ids: [condition === "unrelated" ? "other" : source.id] });
    successor.candidate.step_key = "review";
    reply.state.executions.next = successor;
    if (condition === "fanout") reply.state.executions.second = { ...successor, id: "second", owner_session_id: "second-session" };
    listSessions.mockResolvedValue([
      {
        id: "next-session",
        execution_id: "next",
        worktree: "/worktrees/task",
        created: 2,
        archived: false,
        phase: "review",
        harness: "omp",
        model: "",
        playbook: "retained",
        generic: false,
        harness_resume_token: "",
        started_at: 3,
      },
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  describe("human-authorized end and handoff", () => {
    const request = { task_slug: "task", execution_id: "execution-a", session_id: "session", process_incarnation: "prepared-incarnation", work_revision: 12 };
    beforeEach(() => {
      prepareEndExecution.mockReset().mockResolvedValue({ request, artifacts: ["research/2-result-10.md"], diagnostics: [] });
      endExecution.mockReset().mockResolvedValue({ status: "accepted", receipt_id: "receipt-end" });
      confirmDanger.mockReset().mockResolvedValue(true);
      askConfirm
        .mockReset()
        .mockImplementation(async (request) =>
          (await confirmDanger(request.title, typeof request.body === "function" ? null : request.body, request.choices?.find((choice) => choice.key === "confirm")?.label))
            ? "confirm"
            : "cancel",
        );
      getTaskExecution.mockResolvedValue(readyReply(null));
      stopExecution.mockReset().mockResolvedValue({ shutdown_confirmed: true });
      restartExecution.mockReset();
      previewExecutionArtifacts.mockReset();
      submitExecutionArtifacts.mockReset();
    });

    it("restarts the current step with the confirmed identity and opens the fresh attempt", async () => {
      const replacement = { id: "fresh-attempt", phase: "worker" };
      restartExecution.mockResolvedValue({ session: replacement, execution: readyReply().state.executions["execution-a"], start: "started" });
      const onOpenReplacement = vi.fn();
      renderSession({ onOpenReplacement });
      fireEvent.click(await screen.findByRole("button", { name: "Session actions" }));
      fireEvent.click(await screen.findByRole("button", { name: "Restart this step…" }));
      await waitFor(() => expect(restartExecution).toHaveBeenCalledExactlyOnceWith(request, "/repo"));
      expect(onOpenReplacement).toHaveBeenCalledWith(replacement);
      expect(endExecution).not.toHaveBeenCalled();
      expect(continueExecution).not.toHaveBeenCalled();
    });

    it("ends the session without publishing or starting another attempt", async () => {
      renderSession();
      fireEvent.click(await screen.findByRole("button", { name: "Session actions" }));
      fireEvent.click(await screen.findByRole("button", { name: "End session…" }));
      await waitFor(() => expect(stopExecution).toHaveBeenCalledExactlyOnceWith(request, "/repo"));
      expect(endExecution).not.toHaveBeenCalled();
      expect(restartExecution).not.toHaveBeenCalled();
      expect(continueExecution).not.toHaveBeenCalled();
    });

    it("routes unusable saved artifacts to entry without stopping the session", async () => {
      prepareEndExecution.mockResolvedValue({ request, artifacts: [], diagnostics: ["No valid output"] });
      renderSession();
      fireEvent.click(await openSessionAction("End & continue…"));
      await screen.findByRole("main", { name: "Continue with artifact" });
      expect(endExecution).not.toHaveBeenCalled();
      expect(stopExecution).not.toHaveBeenCalled();
      expect(confirmDanger).not.toHaveBeenCalled();
    });

    it("keeps supplied content on cancellation and accepts only the checked handoff", async () => {
      previewExecutionArtifacts.mockResolvedValue({ assessment: readyReply().executions["execution-a"], diagnostics: [] });
      submitExecutionArtifacts.mockResolvedValue({ status: "accepted", receipt_id: "supplied-receipt" });
      renderSession();
      fireEvent.click(await openSessionAction("Continue with an artifact…"));
      const content = await screen.findByLabelText("Content for research/2-result-10.md");
      fireEvent.change(content, { target: { value: "# User supplied result" } });
      const continueButton = screen.getByRole("button", { name: "Continue" });
      expect(continueButton).toHaveProperty("disabled", true);
      fireEvent.click(screen.getByRole("button", { name: "Check artifacts" }));
      await waitFor(() => expect(continueButton).toHaveProperty("disabled", false));
      confirmDanger.mockResolvedValueOnce(false);
      fireEvent.click(continueButton);
      await waitFor(() => expect(confirmDanger).toHaveBeenCalledTimes(1));
      expect(submitExecutionArtifacts).not.toHaveBeenCalled();
      expect(content).toHaveProperty("value", "# User supplied result");
      await waitFor(() => expect(continueButton).toHaveProperty("disabled", false));
      fireEvent.click(continueButton);
      await waitFor(() =>
        expect(submitExecutionArtifacts).toHaveBeenCalledExactlyOnceWith(request, [{ relative_path: "research/2-result-10.md", content: "# User supplied result" }], "/repo"),
      );
      await screen.findByText("Artifacts accepted. Continuing the playbook.");
      expect(stopExecution).not.toHaveBeenCalled();
      expect(endExecution).not.toHaveBeenCalled();
    });

    it("does not stop or restart when the user cancels confirmation", async () => {
      confirmDanger.mockResolvedValue(false);
      renderSession({ onOpenReplacement: vi.fn() });
      fireEvent.click(await openSessionAction("Restart this step…"));
      await waitFor(() => expect(confirmDanger).toHaveBeenCalledTimes(1));
      expect(restartExecution).not.toHaveBeenCalled();
      const end = await openSessionAction("End session…");
      await waitFor(() => expect(end).toHaveProperty("disabled", false));
      fireEvent.click(end);
      await waitFor(() => expect(confirmDanger).toHaveBeenCalledTimes(2));
      expect(stopExecution).not.toHaveBeenCalled();
    });

    it("keeps execution details hidden and offers only normal continuation when ready", async () => {
      getTaskExecution.mockResolvedValue(readyReply());
      listSessions.mockResolvedValue([
        {
          id: "session",
          execution_id: "execution-a",
          worktree: "/worktrees/task",
          created: 1,
          archived: false,
          phase: "worker",
          harness: "omp",
          model: "",
          playbook: "retained",
          generic: false,
          harness_resume_token: "",
          started_at: 1,
        },
      ]);
      renderSession();
      await waitFor(() => expect(screen.getByRole("button", { name: "Continue to Review changes" })).toHaveProperty("disabled", false));
      expect(screen.queryByRole("button", { name: "End & continue…" })).toBeNull();
      expect(screen.queryByLabelText("Session execution")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
      const dialog = await screen.findByRole("dialog", { name: "Session actions" });
      expect(within(dialog).queryByRole("button", { name: "End & continue…" })).toBeNull();
      expect(within(dialog).getByLabelText("Session execution")).toBeDefined();
      expect(within(dialog).getByLabelText("Session execution")).toHaveProperty("open", false);
      expect(within(dialog).getByLabelText("Step context")).toBeDefined();
      const contents = dialog.textContent;
      fireEvent.click(within(dialog).getByRole("button", { name: "Close session actions" }));
      expect(screen.queryByRole("dialog", { name: "Session actions" })).toBeNull();
      fireEvent.click(screen.getByText("Session Navigator"));
      fireEvent.click(await screen.findByRole("button", { name: "Current step actions" }));
      const navigatorDialog = await screen.findByRole("dialog", { name: "Session actions" });
      expect(within(navigatorDialog).getByLabelText("Step context")).toBeDefined();
      expect(navigatorDialog.textContent).toBe(contents);
      expect(within(navigatorDialog).getByLabelText("Session execution")).toHaveProperty("open", false);
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("shows assigned artifacts in a safe-default keyboard confirmation", async () => {
      const confirmation = await vi.importActual<typeof Confirmation>("../confirm");
      askConfirm.mockImplementation(confirmation.askConfirm);
      render(<confirmation.ConfirmHost />);
      renderSession();
      fireEvent.click(await openSessionAction("End & continue…"));
      const dialog = await screen.findByRole("alertdialog", { name: "End session and continue?" });
      expect(within(dialog).getByText("research/2-result-10.md")).toBeDefined();
      const cancelButtons = within(dialog).getAllByRole("button", { name: "Cancel" });
      const cancel = cancelButtons[cancelButtons.length - 1];
      expect(cancel.hasAttribute("data-autofocus")).toBe(true);
      fireEvent.click(cancel);
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(endExecution).not.toHaveBeenCalled();
    });

    it("cancels without ending and submits only the confirmed prepared identity", async () => {
      confirmDanger.mockResolvedValueOnce(false);
      renderSession();
      const action = await openSessionAction("End & continue…");
      fireEvent.click(action);
      await waitFor(() => expect(confirmDanger).toHaveBeenCalledTimes(1));
      expect(endExecution).not.toHaveBeenCalled();
      await waitFor(() => expect(action).toHaveProperty("disabled", false));
      fireEvent.click(action);
      await waitFor(() => expect(endExecution).toHaveBeenCalledExactlyOnceWith(request, "/repo"));
      await screen.findByRole("dialog", { name: "Session actions" });
      expect(screen.queryByRole("button", { name: "End & continue…" })).toBeNull();
      expect(screen.queryByText("Playbook complete")).toBeNull();
      expect(continueExecution).not.toHaveBeenCalled();
    });

    it("offers explicit ending in live Terminal while ordinary Continue remains blocked", async () => {
      sessionStatus.mockResolvedValue(liveObservation("pty"));
      const blocked = readyReply();
      blocked.continuation["execution-a"] = { available: false, process_incarnation: "raw", reason: "Raw terminal input cannot be tracked" };
      getTaskExecution.mockResolvedValue(blocked);
      renderSession({ intent: "attach" });
      const action = await openSessionAction("End & continue…");
      expect(screen.getByTestId("terminal")).toBeDefined();
      fireEvent.click(action);
      await waitFor(() => expect(endExecution).toHaveBeenCalledExactlyOnceWith(request, "/repo"));
      expect(continueExecution).not.toHaveBeenCalled();
    });

    it("retains stopped invalid-output diagnostics without automatically restarting", async () => {
      endExecution.mockResolvedValue({ status: "invalid_outputs", diagnostics: ["Missing required result"] });
      renderSession();
      fireEvent.click(await openSessionAction("End & continue…"));
      await screen.findByText(/Missing required result/);
      expect(restartExecution).not.toHaveBeenCalled();
    });

    it("replaces proven-stopped unaccepted work in the same execution and opens its session", async () => {
      const stopped = readyReply();
      stopped.state.executions["execution-a"].shutdown_confirmed = true;
      stopped.state.executions["execution-a"].lifecycle = "failed";
      getTaskExecution.mockResolvedValue(stopped);
      const replacement = { id: "replacement", worktree: "/worktrees/task", phase: "worker", harness: "omp", model: "", playbook: "retained" };
      restartExecution.mockResolvedValue({ session: replacement, execution: stopped.state.executions["execution-a"], start: "started" });
      const onOpenReplacement = vi.fn();
      renderSession({ onOpenReplacement });
      fireEvent.click(await screen.findByRole("button", { name: "Session actions" }));
      fireEvent.click(await screen.findByRole("button", { name: "Restart this step…" }));
      await waitFor(() => expect(restartExecution).toHaveBeenCalledExactlyOnceWith(request, "/repo"));
      expect(onOpenReplacement).toHaveBeenCalledExactlyOnceWith(replacement);
      expect(screen.queryByRole("button", { name: "Start fresh" })).toBeNull();
    });

    it("ignores a replacement response after leaving its session", async () => {
      const stopped = readyReply();
      stopped.state.executions["execution-a"].shutdown_confirmed = true;
      stopped.state.executions["execution-a"].lifecycle = "failed";
      getTaskExecution.mockResolvedValue(stopped);
      const result = deferred<{ session: { id: string } }>();
      restartExecution.mockReturnValue(result.promise);
      const onOpenReplacement = vi.fn();
      const view = renderSession({ onOpenReplacement });
      fireEvent.click(await screen.findByRole("button", { name: "Session actions" }));
      fireEvent.click(await screen.findByRole("button", { name: "Restart this step…" }));
      await waitFor(() => expect(restartExecution).toHaveBeenCalledTimes(1));
      view.unmount();
      await act(async () => result.resolve({ session: { id: "replacement" } }));
      expect(onOpenReplacement).not.toHaveBeenCalled();
    });

    it("ignores end preparation after leaving its session", async () => {
      const result = deferred<{ request: typeof request; artifacts: string[]; diagnostics: string[] }>();
      prepareEndExecution.mockReturnValue(result.promise);
      const view = renderSession();
      fireEvent.click(await openSessionAction("End & continue…"));
      await waitFor(() => expect(prepareEndExecution).toHaveBeenCalledTimes(1));
      view.unmount();
      await act(async () => result.resolve({ request, artifacts: ["result.md"], diagnostics: [] }));
      expect(confirmDanger).not.toHaveBeenCalled();
      expect(endExecution).not.toHaveBeenCalled();
    });

    it("does not apply an old end result to a newly viewed owner", async () => {
      const result = deferred<{ status: string; receipt_id: string }>();
      endExecution.mockReturnValue(result.promise);
      const view = renderSession();
      fireEvent.click(await openSessionAction("End & continue…"));
      await waitFor(() => expect(endExecution).toHaveBeenCalledTimes(1));
      const next = readyReply(null);
      next.state.executions["execution-a"].owner_session_id = "other-session";
      getTaskExecution.mockResolvedValue(next);
      view.rerender(sessionView({ id: "other-session" }));
      await act(async () => result.resolve({ status: "accepted", receipt_id: "old-receipt" }));
      expect(await openSessionAction("End & continue…")).toHaveProperty("disabled", false);
      expect(screen.queryByText(/Handoff accepted/)).toBeNull();
    });

    it("does not resend an uncertain end request on observation refresh", async () => {
      endExecution.mockRejectedValue(new Error("Reply lost"));
      renderSession();
      fireEvent.click(await openSessionAction("End & continue…"));
      await screen.findByText(/End-session outcome unavailable/);
      const refresh = screen.getByRole("button", { name: "Refresh handoff status" });
      await waitFor(() => expect(refresh).toHaveProperty("disabled", false));
      fireEvent.click(refresh);
      await flushPromises();
      expect(endExecution).toHaveBeenCalledTimes(1);
    });
  });
  it("keeps validated readiness disabled while native input settlement is outstanding", async () => {
    const pending = readyReply();
    pending.continuation["execution-a"].reason = "Submitted input has not settled";
    getTaskExecution.mockResolvedValue(pending);
    renderSession();
    const control = await screen.findByRole("button", { name: "Continue to Review changes" });
    await flushPromises();
    expect(control).toHaveProperty("disabled", true);
    expect(await openSessionAction("End & continue…")).toBeDefined();
    fireEvent.click(control);
    expect(continueExecution).not.toHaveBeenCalled();
  });

  it("submits the observed ready owner once outside the transcript without claiming completion", async () => {
    const result = deferred<{ status: string; ready_revision: number }>();
    continueExecution.mockReturnValue(result.promise);
    renderSession();
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue to Review changes" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Review changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Continuing…" }));
    expect(continueExecution).toHaveBeenCalledExactlyOnceWith(
      {
        task_slug: "task",
        execution_id: "execution-a",
        session_id: "session",
        process_incarnation: "incarnation-a",
        ready_revision: 7,
      },
      "/repo",
    );
    await act(async () => result.resolve({ status: "requested", ready_revision: 7 }));
    expect(screen.queryByText("Playbook complete")).toBeNull();
    expect(screen.getByRole("button", { name: "Continuing…" })).toHaveProperty("disabled", true);
  });

  it("keeps accepted handoff evidence when the subsequent observation fails", async () => {
    continueExecution.mockResolvedValueOnce({ status: "accepted", receipt_id: "accepted-receipt" });
    renderSession();
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue to Review changes" })).toHaveProperty("disabled", false));
    getTaskExecution.mockRejectedValue(new Error("Snapshot unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Review changes" }));
    await screen.findByText("Handoff accepted; waiting for the session to exit.");
    await screen.findByText(/Snapshot unavailable/);
    expect(screen.queryByText(/Continuation outcome unavailable/)).toBeNull();
    expect(screen.queryByText("Playbook complete")).toBeNull();
    expect(screen.getByRole("button", { name: "Continuing…" })).toHaveProperty("disabled", true);
    expect(continueExecution).toHaveBeenCalledTimes(1);
  });

  it("allows explicit same-owner retry after a lost Continue reply and live refresh", async () => {
    continueExecution.mockRejectedValueOnce(new Error("Reply lost"));
    renderSession();
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue to Review changes" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Review changes" }));
    await screen.findByText(/Continuation outcome unavailable/);
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue to Review changes" })).toHaveProperty("disabled", false));
    expect(continueExecution).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Continue to Review changes" }));
    await waitFor(() => expect(continueExecution).toHaveBeenCalledTimes(2));
    expect(continueExecution).toHaveBeenNthCalledWith(
      2,
      { task_slug: "task", execution_id: "execution-a", session_id: "session", process_incarnation: "incarnation-a", ready_revision: 7 },
      "/repo",
    );
  });

  it("allows an explicit retry at the same ready revision after a definite non-requested outcome", async () => {
    continueExecution.mockResolvedValueOnce({ status: "waiting", reason: "A native operation is still settling" });
    renderSession();
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue to Review changes" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Review changes" }));
    await waitFor(() => expect(screen.getByText("A native operation is still settling")).toBeDefined());
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue to Review changes" })).toHaveProperty("disabled", false));
    expect(continueExecution).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Continue to Review changes" }));
    await waitFor(() => expect(continueExecution).toHaveBeenCalledTimes(2));
    expect(continueExecution.mock.calls[1]?.[0]).toMatchObject({ ready_revision: 7, process_incarnation: "incarnation-a" });
  });

  it("retains a disabled continuation during revision and enables only fresh authoritative readiness", async () => {
    vi.useFakeTimers();
    renderSession({ messageDraft: { body: "Please revise this", pendingActions: [], attachments: [] } });
    await flushPromises();
    expect(screen.getByRole("button", { name: "Continue to Review changes" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flushPromises();
    expect(screen.getByRole("button", { name: "Continue to Review changes" })).toHaveProperty("disabled", true);
    getTaskExecution.mockResolvedValue(readyReply(null));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByRole("button", { name: "Continue to Review changes" })).toHaveProperty("disabled", true);
    getTaskExecution.mockResolvedValue(readyReply(8));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByRole("button", { name: "Continue to Review changes" })).toHaveProperty("disabled", false);
  });

  it("never offers ending an already accepted handoff", async () => {
    const accepted = readyReply();
    accepted.state.executions["execution-a"].receipt_id = "accepted";
    accepted.state.executions["execution-a"].lifecycle = "finishing";
    getTaskExecution.mockResolvedValue(accepted);
    renderSession();
    expect(await screen.findByRole("button", { name: "Continuing…" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "End & continue…" })).toBeNull();
  });

  it("exposes unavailable reasons on focus and dismisses them with Escape", async () => {
    getTaskExecution.mockResolvedValue(readyReply(null));
    renderSession();
    const info = await screen.findByRole("group", { name: "Unavailable continuation" });
    expect(screen.queryByRole("button", { name: "Continuation details" })).toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(info);
    expect(screen.getByRole("tooltip").textContent).toContain("readiness");
    fireEvent.keyDown(info, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps saved readiness visible without granting live authority", async () => {
    const saved = readyReply();
    getTaskExecution.mockResolvedValue({ ...saved, live: { status: "offline", detail: "Owner is offline" }, continuation: {} });
    renderSession();
    const control = await screen.findByRole("button", { name: "Continue to Review changes" });
    expect(control).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "End & continue…" })).toBeNull();
    fireEvent.click(control);
    expect(continueExecution).not.toHaveBeenCalled();
    expect(screen.queryByText("Playbook complete")).toBeNull();
  });

  it("keeps routing controls disabled until ready and leaves ready endpoints open for conversation", async () => {
    const unready = readyReply(null);
    unready.state.executions["execution-a"].last_ready_revision = null;
    getTaskExecution.mockResolvedValue(unready);
    const first = renderSession();
    await flushPromises();
    expect(screen.getByRole("button", { name: /Continue (to|playbook)/ })).toHaveProperty("disabled", true);
    expect(await openSessionAction("End & continue…")).toBeDefined();
    first.unmount();
    const automatic = readyReply();
    automatic.state.executions["execution-a"].continuation_mode = "automatic";
    getTaskExecution.mockResolvedValue(automatic);
    const second = renderSession();
    await flushPromises();
    const automaticContinue = screen.getByRole("button", { name: /Continue (to|playbook)/ });
    expect(automaticContinue).toHaveProperty("disabled", true);
    fireEvent.click(automaticContinue);
    expect(continueExecution).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Wait for me" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Continue automatically" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Nudge to wrap up" })).toBeDefined();
    second.unmount();
    const terminal = readyReply();
    terminal.executions["execution-a"] = { destinations: [], terminality: "terminal", reasons: [] };
    getTaskExecution.mockResolvedValue(terminal);
    renderSession({ messageDraft: { body: "Tell me how it went", pendingActions: [], attachments: [] } });
    await flushPromises();
    expect(screen.queryByRole("button", { name: /Continue (to|playbook)/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Nudge to wrap up" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Wait for me" })).toBeNull();
    expect(screen.getByTestId("chat-activity").textContent).toBe("Ready for review");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flushPromises();
    expect(rpcWriteSession).toHaveBeenCalledWith("session", expect.objectContaining({ message: "Tell me how it went" }));
    expect(screen.queryByText("Ready for review")).toBeNull();
    expect(continueExecution).not.toHaveBeenCalled();
    expect(screen.queryByText("Playbook complete")).toBeNull();
  });

  it("uses a generic continuation label for several destinations and only aggregate settlement completes the playbook", async () => {
    vi.useFakeTimers();
    const reply = readyReply();
    reply.executions["execution-a"].destinations.push({ step_key: "audit", title: "Audit changes" });
    getTaskExecution.mockResolvedValue(reply);
    renderSession();
    await flushPromises();
    expect(screen.getByRole("button", { name: "Continue playbook" })).toBeDefined();
    expect(screen.queryByText("Audit changes")).toBeNull();
    expect(screen.queryByText("Playbook complete")).toBeNull();
    getTaskExecution.mockResolvedValue({ ...reply, assessment: { status: "complete", reasons: [] } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByLabelText("Playbook status").textContent).toBe("Playbook complete");
    expect(screen.getByRole("button", { name: "Continue playbook" })).toHaveProperty("disabled", true);
    getTaskExecution.mockRejectedValue(new Error("Execution query failed"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.queryByText("Playbook complete")).toBeNull();
  });
});

describe("session execution history and substantive approvals", () => {
  beforeEach(() => {
    scenario.tasks = [task];
    scenario.tasksPromise = null;
    scenario.tasksError = null;
    scenario.items = [];
    sessionStatus.mockReset().mockResolvedValue(liveObservation("rpc"));
    rpcAttachSession.mockReset().mockResolvedValue(undefined);
    rpcWriteSession.mockReset().mockResolvedValue({ status: "written" });
    getTaskExecution.mockReset().mockResolvedValue(executionReply([executionRecord({ owner_session_id: "session" })]));
    continueExecution.mockReset();
  });
  afterEach(() => {
    cleanup();
    getTaskExecution.mockReset();
    vi.useRealTimers();
  });

  it("distinguishes accepted outputs from omissions and counts only this execution's wildcard publications", async () => {
    getTaskExecution.mockResolvedValue(partiallyPublishedExecution("session"));
    renderSession();
    await flushPromises();
    fireEvent.click(await screen.findByRole("button", { name: "Session actions" }));
    const execution = screen.getByLabelText("Session execution");
    fireEvent.click(within(execution).getByText("Technical details"));
    const outputs = within(within(execution).getByRole("list", { name: "Execution outputs" }));
    expect(outputs.getByText("resolution-options.md").closest("li")?.textContent).toContain("· accepted");
    expect(outputs.getByText("selected-fix.md").closest("li")?.textContent).toContain("· not published");
    expect(outputs.getByText("papers/*.md").closest("li")?.textContent).toContain("· 2 accepted");
    expect(outputs.getByText("notes/*.md").closest("li")?.textContent).toContain("· 0 accepted");
    expect(outputs.getByText("papers/2-a-12.md")).toBeDefined();
    expect(outputs.getByText("papers/2-b-12.md")).toBeDefined();
    expect(outputs.queryByText("notes/2-other-21.md")).toBeNull();
  });

  it("does not turn an ordinary approval into continuation authority", async () => {
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    renderSession();
    await flushPromises();
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "extension_ui_request", id: "approval", method: "confirm", title: "Approve a different action", message: "A substantive decision" }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(rpcWriteSession).toHaveBeenCalledWith("session", { type: "extension_ui_response", id: "approval", confirmed: true }));
    expect(continueExecution).not.toHaveBeenCalled();
  });
});

describe("held task sessions", () => {
  afterEach(() => {
    cleanup();
    startSession.mockReset().mockResolvedValue(undefined);
    getTaskExecution.mockReset();
    sessionStatus.mockReset().mockResolvedValue({ lifecycle: { state: "exited", code: 0 }, state: null, checkpoint: {} });
  });

  it("opens queued work without starting it and starts only on explicit request", async () => {
    startSession.mockClear();
    scenario.tasks = [task];
    scenario.tasksPromise = null;
    scenario.tasksError = null;
    sessionStatus.mockResolvedValue({ lifecycle: { state: "never_started" }, state: null, checkpoint: {} });
    getTaskExecution.mockResolvedValue(executionReply([executionRecord({ owner_session_id: "session", lifecycle: "queued", start_requested: false })]));
    renderSession({ intent: undefined });
    const start = await screen.findByRole("button", { name: "Start this queued session" });
    expect(startSession).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Message or /command")).toBeNull();
    startSession.mockImplementation(async () => {
      sessionStatus.mockResolvedValue({ lifecycle: { state: "live" }, state: null, checkpoint: {}, transport: "rpc" });
      getTaskExecution.mockResolvedValue(executionReply([executionRecord({ owner_session_id: "session" })]));
    });
    fireEvent.click(start);
    await waitFor(() => expect(startSession).toHaveBeenCalledWith("task", "session", "/repo"));
    expect(await screen.findByLabelText("Message or /command")).toBeDefined();
  });

  it.each(["offline", "foreign_owner", undefined] as const)("does not start a queued session from saved state when live status is %s", async (status) => {
    startSession.mockClear();
    scenario.tasks = [task];
    scenario.tasksPromise = null;
    scenario.tasksError = null;
    sessionStatus.mockResolvedValue({ lifecycle: { state: "never_started" }, state: null, checkpoint: {} });
    const saved = executionReply([executionRecord({ owner_session_id: "session", lifecycle: "queued", start_requested: false })]);
    getTaskExecution.mockResolvedValue({ ...saved, live: status ? { status, detail: "Owner cannot be queried" } : undefined });
    renderSession({ intent: undefined });

    const start = await screen.findByRole("button", { name: "Start this queued session" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(start);
    expect(startSession).not.toHaveBeenCalled();
  });
});
