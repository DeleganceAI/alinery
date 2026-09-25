import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ComponentProps, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import type { QueuedFollowUp } from "../chat/queue";
import type * as Ipc from "../ipc";
import type { SessionMessageDraft } from "../sessionMessage";
import { mockIpc } from "../test/mockIpc";
import { Toast, toast } from "../toast";
import type { AgentState, ArtifactListItem, ArtifactTreeNode, SessionObservation, Task } from "../types";
import { executionRecord, executionReply } from "./executionTestFixture";
import { SessionView } from "./SessionView";

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
const rpcWriteSession = vi.hoisted(() => vi.fn(async (_id: string, _payload: unknown) => undefined));
const detachSession = vi.hoisted(() => vi.fn(async () => undefined));
const readOmpModelRoles = vi.hoisted(() => vi.fn(async () => ({}) as Record<string, string>));
const writeOmpModelRoles = vi.hoisted(() => vi.fn(async (roles: Record<string, string>) => roles));
const openUrl = vi.hoisted(() => vi.fn(async (_url: string | URL, _openWith?: string): Promise<void> => undefined));
const confirmDanger = vi.hoisted(() => vi.fn(async () => true));
const archiveSession = vi.hoisted(() => vi.fn());
const pickAttachmentFilesDialog = vi.hoisted(() => vi.fn(async (): Promise<string[]> => []));
const chatFileStat = vi.hoisted(() => vi.fn(async (path: string) => ({ name: path.split("/").pop() ?? path, bytes: 12 })));
const copyChatAttachments = vi.hoisted(() => vi.fn(async () => ({ copied: [] as string[], failures: [] as string[] })));
const writeChatAttachmentBytes = vi.hoisted(() => vi.fn(async (_slug: string, fileName: string) => fileName));
const readChatImage = vi.hoisted(() => vi.fn(async () => ({ mime_type: "image/png", data: "aa" })));
const getTaskExecution = vi.hoisted(() => vi.fn());
const allowExecutionCompletion = vi.hoisted(() => vi.fn());
const getSessionDisplay = vi.hoisted(() => vi.fn(async () => null));
const renameSession = vi.hoisted(() => vi.fn());

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
vi.mock("../confirm", () => ({ confirmDanger }));
vi.mock("../ipc", () =>
  mockIpc({
    getSessionDisplay,
    renameSession,
    getTaskExecution,
    allowExecutionCompletion,
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
    expect(screen.getByText("Historical work")).toBeDefined();
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
    expect(screen.getByText("External name")).toBeDefined();
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
    expect(screen.getByText("Saved name")).toBeDefined();
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
    expect(screen.getByText("Committed")).toBeDefined();
    getSessionDisplay.mockResolvedValue({ ...original, session: { ...original.session, name: "External" } } as never);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByText("External")).toBeDefined();
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
    expect(screen.getByText("Other repo")).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Session name" })).toHaveProperty("value", "Keep this draft");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Session name" }));
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
    expect(confirmDanger).not.toHaveBeenCalled();
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
    confirmDanger.mockResolvedValue(false);
    renderSession({ messageDraft: { body: "first", pendingActions: [], attachments: [] } });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(rpcWriteSession.mock.calls.some(([, payload]) => (payload as { type?: string } | null)?.type === "prompt")).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await waitFor(() => expect(confirmDanger).toHaveBeenCalled());
    expect(restateSession).not.toHaveBeenCalled();
  });

  it("confirms before restating when turn_start leads the idle observation poll", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    confirmDanger.mockResolvedValue(false);
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    renderSession();
    await flushPromises();
    await waitFor(() => expect(onLine.current).toBeDefined());
    act(() => {
      onLine.current?.(JSON.stringify({ type: "turn_start" }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await waitFor(() => expect(confirmDanger).toHaveBeenCalled());
    expect(restateSession).not.toHaveBeenCalled();
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

  async function requestOpenUrl(launchUrl: string) {
    renderSession();
    await waitFor(() => expect(rpcAttachSession).toHaveBeenCalled());
    const calls = rpcAttachSession.mock.calls;
    const attach = calls[calls.length - 1]?.[0] as { onLine: (line: string) => void };
    await act(async () => {
      attach.onLine(JSON.stringify({ type: "extension_ui_request", id: REQUEST, method: "open_url", launchUrl }));
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
    rpcWriteSession.mockImplementation(async () => undefined);
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
    rpcWriteSession.mockImplementation(async () => undefined);
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
    });
    const onDraftChange = vi.fn();
    renderSession({ messageDraft: { body: "keep me", pendingActions: [], attachments: [] }, onMessageDraftChange: onDraftChange });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Error: stdin closed")).toBeDefined();
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
          type: "response",
          id: commandId,
          command: "prompt",
          success: false,
          error: "Agent is already processing",
        }),
      );
    });

    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith({ body: "keep me", pendingActions: [], attachments: [] }));
    expect(screen.getAllByText("Agent is already processing").length).toBeGreaterThan(0);
    expect(within(screen.getByTestId("chat-pane")).queryByText("keep me")).toBeNull();
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

  it("drops local queued follow_up rows when get_state count is 0", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    renderSession({ queuedFollowUps: [{ text: "keep me", attachments: [] }] });
    await flushPromises();
    await waitFor(() => expect(onLine.current).toBeDefined());
    expect(await screen.findByText("keep me")).toBeTruthy();
    await act(async () => {
      onLine.current?.(
        JSON.stringify({
          type: "response",
          command: "get_state",
          success: true,
          data: { queuedMessageCount: 0 },
        }),
      );
    });
    await waitFor(() => expect(within(screen.getByTestId("chat-pane")).queryByText("keep me")).toBeNull());
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
    renderSession({ queuedFollowUps: [{ text: "later", attachments: [] }], messageDraft: { body: "", pendingActions: [], attachments: [] } });
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
      if ((payload as { type?: string } | null)?.type !== command) return;
      attempts.push(payload);
      if (attempts.length === 1) throw rejection;
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

      expect(await screen.findByText(String(rejection))).toBeDefined();
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

  it("keeps an image follow-up queued when Send now is rejected and retries the same attachment", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    const onDraftChange = vi.fn();
    const onQueuedFollowUpsChange = vi.fn();
    const rejection = new Error("request-too-large: control request exceeds the 67108864 byte limit");
    const attempts: unknown[] = [];
    rpcWriteSession.mockImplementation(async (_id: string, payload: unknown) => {
      if ((payload as { type?: string } | null)?.type !== "abort_and_prompt") return;
      attempts.push(payload);
      if (attempts.length === 1) throw rejection;
    });
    renderSession({
      messageDraft: { body: "", pendingActions: [], attachments: [] },
      onMessageDraftChange: onDraftChange,
      queuedFollowUps: [{ text: "keep this queued caption", attachments: [blobPng] }],
      onQueuedFollowUpsChange,
    });
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    expect(await screen.findByText(String(rejection))).toBeDefined();
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
    await waitFor(() => expect(onQueuedFollowUpsChange).toHaveBeenCalledWith([]));
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({
      type: "abort_and_prompt",
      message: "keep this queued caption",
      images: [{ type: "image", data: "aa", mimeType: "image/png" }],
    });
    expect(screen.queryByText("queued · after this turn")).toBeNull();
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

  it("revokes blob URLs on turn_start ACK and restores them without revoke on refusal", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    writeChatAttachmentBytes.mockResolvedValue("paste.png");
    copyChatAttachments.mockResolvedValue({ copied: ["paste.png"], failures: [] });
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    const onLine = { current: undefined as ((line: string) => void) | undefined };
    captureRpcOnLine(onLine);
    const onDraftChange = vi.fn();
    const messageDraft = { body: "see this", pendingActions: [], attachments: [blobPng] } as SessionMessageDraft;
    renderSession({ messageDraft, onMessageDraftChange: onDraftChange });
    await flushPromises();
    await waitFor(() => expect(onLine.current).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    await act(async () => {
      onLine.current?.(JSON.stringify({ type: "turn_start" }));
    });
    expect(revoke).toHaveBeenCalledWith("blob:http://localhost/paste");
    revoke.mockClear();

    const refusedDraft = { body: "see this", pendingActions: [], attachments: [blobPng] } as SessionMessageDraft;
    cleanup();
    captureRpcOnLine(onLine);
    const restore = vi.fn();
    renderSession({ messageDraft: refusedDraft, onMessageDraftChange: restore });
    await flushPromises();
    await waitFor(() => expect(onLine.current).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    const commandId = sends()[0]?.id;
    await act(async () => {
      onLine.current?.(
        JSON.stringify({
          type: "response",
          id: commandId,
          command: "prompt",
          success: false,
          error: "Agent is already processing",
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
    rpcWriteSession.mockReset().mockResolvedValue(undefined);
    rpcAttachSession.mockReset();
    rpcAttachSession.mockImplementation(async () => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    sessionStatus.mockReset();
    sessionStatus.mockResolvedValue({ lifecycle: { state: "exited" as const, code: 0 }, state: null, checkpoint: {} });
    rpcWriteSession.mockReset().mockResolvedValue(undefined);
  });

  it("writes get_subagents after set_subagent_subscription", async () => {
    renderSession();
    await waitFor(() => expect(rpcWriteSession.mock.calls.some(([, payload]) => (payload as { type?: string } | null)?.type === "set_subagent_subscription")).toBe(true));
    const types = rpcWriteSession.mock.calls.map(([, payload]) => (payload as { type?: string } | null)?.type);
    expect(types).toContain("get_subagents");
    expect(types.indexOf("get_subagents")).toBeGreaterThan(types.indexOf("set_subagent_subscription"));
  });

  const exitedRpc: SessionObservation = {
    ...liveObservation("rpc"),
    lifecycle: { state: "live_exited" },
    state: {
      process: { state: "exited", code: 0 },
      agent: { state: "idle" },
      playbook: { state: "ready_to_advance" },
      adapter: "omp",
      message_adapter: "omp_bracketed_paste",
    },
  };

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

  it("reconciles a session that exits during the RPC handshake without showing an error", async () => {
    rpcWriteSession.mockImplementation(async (_id, payload) => {
      if (payload && typeof payload === "object" && "type" in payload && payload.type === "negotiate_protocol") {
        sessionStatus.mockResolvedValue(exitedRpc);
        throw "session-exited";
      }
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

describe("session-scoped completion permission", () => {
  beforeEach(() => {
    scenario.tasks = [task];
    scenario.tasksPromise = null;
    scenario.tasksError = null;
    scenario.items = [];
    sessionStatus.mockReset().mockResolvedValue(liveObservation("rpc"));
    rpcAttachSession.mockReset().mockResolvedValue(undefined);
    rpcWriteSession.mockReset().mockResolvedValue(undefined);
    getTaskExecution.mockReset().mockResolvedValue(executionReply([executionRecord({ owner_session_id: "session" })]));
    allowExecutionCompletion.mockReset().mockImplementation(async (_slug: string, executionId: string, sessionId: string) => {
      getTaskExecution.mockResolvedValue(
        executionReply([executionRecord({ owner_session_id: sessionId, permission: { kind: "human_granted", execution_id: executionId, session_id: sessionId } })]),
      );
    });
  });
  afterEach(() => {
    cleanup();
    getTaskExecution.mockReset();
    allowExecutionCompletion.mockReset();
    vi.useRealTimers();
  });

  async function requestCompletion(title = "Allow this session to complete") {
    await flushPromises();
    const attach = rpcAttachSession.mock.calls[rpcAttachSession.mock.calls.length - 1]?.[0] as { onLine: (line: string) => void };
    await act(async () => {
      attach.onLine(JSON.stringify({ type: "extension_ui_request", id: "completion-ask", method: "confirm", title, message: "Extension-supplied description" }));
    });
  }

  function responses() {
    return rpcWriteSession.mock.calls
      .map(([, payload]) => payload as { type?: string; id?: string; confirmed?: boolean })
      .filter((payload) => payload.type === "extension_ui_response" && payload.id === "completion-ask");
  }

  it("asks in chat only when requested and waits for the authenticated grant before releasing the tool", async () => {
    const grant = deferred<void>();
    allowExecutionCompletion.mockReturnValue(grant.promise);
    renderSession();
    await flushPromises();
    expect(screen.queryByRole("button", { name: /Allow/ })).toBeNull();
    await requestCompletion();
    const pane = within(screen.getByTestId("chat-pane"));
    const allow = pane.getByRole("button", { name: "Allow" });
    expect(pane.getByRole("button", { name: "Deny" })).toBeDefined();
    expect(pane.getByText(/Deny keeps the session open/)).toBeDefined();
    expect(pane.queryByText("Extension-supplied description")).toBeNull();
    fireEvent.click(allow);
    fireEvent.click(allow);
    expect(allowExecutionCompletion).toHaveBeenCalledExactlyOnceWith("task", "execution-a", "session", "/repo");
    expect(responses()).toEqual([]);
    await act(async () => grant.resolve());
    await waitFor(() => expect(responses()).toEqual([{ type: "extension_ui_response", id: "completion-ask", confirmed: true }]));
    expect(pane.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.getByLabelText("Message or /command")).toBeDefined();
  });

  it("denies completion without granting permission or closing the composer", async () => {
    renderSession();
    await requestCompletion();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(responses()).toEqual([{ type: "extension_ui_response", id: "completion-ask", confirmed: false }]));
    expect(allowExecutionCompletion).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.getByLabelText("Message or /command")).toBeDefined();
  });

  it("does not turn an ordinary approval into completion authority", async () => {
    renderSession();
    await requestCompletion("Approve a different action");
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(responses()).toEqual([{ type: "extension_ui_response", id: "completion-ask", confirmed: true }]));
    expect(allowExecutionCompletion).not.toHaveBeenCalled();
  });

  it("never grants a replacement from a retired owner's history", async () => {
    getTaskExecution.mockResolvedValue(executionReply([executionRecord({ owner_session_id: "replacement", previous_session_ids: ["session"] })]));
    renderSession();
    await requestCompletion();
    const allow = screen.getByRole("button", { name: "Allow" });
    expect(allow).toHaveProperty("disabled", true);
    fireEvent.click(allow);
    expect(allowExecutionCompletion).not.toHaveBeenCalled();
    expect(responses()).toEqual([]);
    fireEvent.click(await screen.findByText(/Owner replacement/));
    expect(screen.getByText("This is a previous owner. Current owner: replacement.")).toBeDefined();
  });

  it.each(["offline", "foreign_owner", undefined] as const)("keeps saved execution history readable without completion authority when live status is %s", async (status) => {
    const saved = executionReply([executionRecord({ owner_session_id: "session" })]);
    getTaskExecution.mockResolvedValue({ ...saved, live: status ? { status, detail: "Owner cannot be queried" } : undefined });
    renderSession();
    await requestCompletion();
    const allow = screen.getByRole("button", { name: "Allow" });
    expect(allow).toHaveProperty("disabled", true);
    fireEvent.click(allow);
    fireEvent.click(screen.getByText(/Retained worker · running · Owner session/));
    expect(screen.getByText("research/1-request-2.md")).toBeDefined();
    expect(screen.getByText("research/2-result-10.md")).toBeDefined();
    expect(allowExecutionCompletion).not.toHaveBeenCalled();
    expect(responses()).toEqual([]);
  });

  it("revokes completion authority when a refresh fails after a live reply", async () => {
    vi.useFakeTimers();
    renderSession();
    await requestCompletion();
    const allow = screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement;
    expect(allow.disabled).toBe(false);

    getTaskExecution.mockRejectedValue(new Error("Execution query failed"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(allow.disabled).toBe(true);
    fireEvent.click(allow);
    expect(allowExecutionCompletion).not.toHaveBeenCalled();
    expect(responses()).toEqual([]);
  });

  it("keeps a failed grant pending and permits retry after authority recovers", async () => {
    vi.useFakeTimers();
    allowExecutionCompletion.mockRejectedValueOnce(new Error("grant failed"));
    renderSession();
    await requestCompletion();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await flushPromises();
    expect(responses()).toEqual([]);
    expect(screen.getByRole("button", { name: "Allow" })).toHaveProperty("disabled", true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await flushPromises();
    expect(responses()).toEqual([{ type: "extension_ui_response", id: "completion-ask", confirmed: true }]);
    expect(allowExecutionCompletion).toHaveBeenCalledTimes(2);
  });

  it("does not offer a false denial after permission was granted but the RPC reply failed", async () => {
    vi.useFakeTimers();
    rpcWriteSession.mockImplementation(async (_id, payload) => {
      if (payload && typeof payload === "object" && "type" in payload && payload.type === "extension_ui_response") throw new Error("reply failed");
    });
    renderSession();
    await requestCompletion();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await flushPromises();
    expect(allowExecutionCompletion).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByRole("button", { name: "Deny" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(responses().some((response) => response.confirmed === false)).toBe(false);
    rpcWriteSession.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await flushPromises();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(allowExecutionCompletion).toHaveBeenCalledTimes(1);
    expect(responses().map((response) => response.confirmed)).toEqual([true, true]);
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

    await screen.findByText(/Retained worker · queued · Owner session/);
    const start = screen.getByRole("button", { name: "Start this queued session" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(start);
    expect(startSession).not.toHaveBeenCalled();
    expect(screen.getByText("research/2-result-10.md")).toBeDefined();
  });
});
