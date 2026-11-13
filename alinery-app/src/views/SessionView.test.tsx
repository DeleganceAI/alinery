// Session chat on this branch talks to Vinculum (transcript, prompt, abort) and does not attach or read an OMP journal.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { daemonTransport } from "../daemon/transport";
import type { SessionMessageDraft } from "../sessionMessage";
import { fakeArtifacts } from "../test/artifactHooks";
import { fakeBoard } from "../test/boardHooks";
import { fakeExecution } from "../test/executionFeed";
import { mockIpc } from "../test/mockIpc";
import { sessionDaemon } from "../test/sessionDaemon";
import { Toast, toast } from "../toast";
import type { AgentState, ArtifactListItem, ArtifactTreeNode, BoardTask, SessionObservation } from "../types";
import { executionRecord, executionReply, partiallyPublishedExecution } from "./executionTestFixture";
import { SessionView } from "./SessionView";

// The sessions the fake daemon holds. `sessionStatus.mockResolvedValue(o)` states what the daemon says
// about the session under test (task/session in /repo); a later call is a live delta.
let daemon = sessionDaemon();
vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));
function resetDaemon() {
  daemon = sessionDaemon();
  vi.mocked(daemonTransport).mockImplementation((repo) => daemon.transport(repo));
  daemon.setTranscript("session", [{ role: "user", text: "playbook prompt" }]);
  sessionStatus.mockReset();
}
const EXITED: SessionObservation = { lifecycle: { state: "exited", code: 0 }, state: null, checkpoint: {} };
const sessionStatus = {
  mockResolvedValue(o: SessionObservation) {
    daemon.show("/repo", "task", "session", o);
    return sessionStatus;
  },
  mockReset() {
    return sessionStatus.mockResolvedValue(EXITED);
  },
};
const sessionArtifactReady = vi.hoisted(() => vi.fn(async () => false));
const startSession = vi.hoisted(() => vi.fn(async () => undefined));
const sessionPrompt = vi.hoisted(() => vi.fn(async () => undefined));
const sessionAbort = vi.hoisted(() => vi.fn(async () => undefined));
const sessionSetModel = vi.hoisted(() => vi.fn(async () => ({ model: "anthropic/claude", thinking: "off", thinking_levels: [] as string[] })));
const sessionSetThinkingLevel = vi.hoisted(() => vi.fn(async () => ({ model: "xai/grok-4.6", thinking: "low", thinking_levels: ["off", "low", "high"] })));
const providerCatalog = vi.hoisted(() =>
  vi.fn(async (): Promise<unknown> => {
    throw new Error("no catalog");
  }),
);
const writeModelRoles = vi.hoisted(() => vi.fn(async (roles: Record<string, string>) => roles));
const openUrl = vi.hoisted(() => vi.fn(async (_url: string | URL, _openWith?: string): Promise<void> => undefined));
const confirmDanger = vi.hoisted(() => vi.fn(async () => true));
const archiveSession = vi.hoisted(() => vi.fn());
const pickAttachmentFilesDialog = vi.hoisted(() => vi.fn(async (): Promise<string[]> => []));
const chatFileStat = vi.hoisted(() => vi.fn(async (path: string) => ({ name: path.split("/").pop() ?? path, bytes: 12 })));
const copyChatAttachments = vi.hoisted(() => vi.fn(async () => ({ copied: [] as string[], failures: [] as string[] })));
const writeChatAttachmentBytes = vi.hoisted(() => vi.fn(async (_slug: string, fileName: string) => fileName));
const readChatImage = vi.hoisted(() => vi.fn(async () => ({ mime_type: "image/png", data: "aa" })));
const getTaskExecution = vi.hoisted(() => vi.fn());
const renameSession = vi.hoisted(() => vi.fn());

const task: BoardTask = {
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
  repo_path: "/repo",
  session_count: 0,
  playbook_title: "Review",
  playbook_steps: [],
  updated: 1,
  current_phase: "",
  current_step_title: "",
  latest_session_title: "",
  latest_session_column_key: "",
  current_column_key: "",
  current_column_title: "",
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
vi.mock("../sync/agent", () => ({ writeModelRoles }));
// The provider catalog and sign-in are the host daemon's ProviderService (sync/providers), not ipc.
vi.mock("../sync/providers", () => ({ providerCatalog, listModels: async () => [] }));
vi.mock("../sync/artifacts", async (actual) => (await import("../test/artifactHooks")).artifactHooks(await actual()));
vi.mock("../sync/git", async (actual) => ({
  ...(await actual<typeof import("../sync/git")>()),
  listWorktreeFilesForRepo: async () => ({ paths: ["src/app.ts", "README.md"], truncated: false }),
}));
vi.mock("../sync/board", async (actual) => (await import("../test/boardHooks")).boardHooks(await actual()));
vi.mock("../sync/execution", async (actual) => (await import("../test/executionFeed")).executionHooks(await actual()));
// The session writes and reads are the daemon's SessionService, not ipc.
vi.mock("../sync/sessions", async (actual) => ({
  ...(await actual<typeof import("../sync/sessions")>()),
  renameSession,
  archiveSession,
  sessionArtifactReady,
  startSession,
  promptSession: sessionPrompt,
  abortSession: sessionAbort,
  setSessionModel: sessionSetModel,
  setSessionThinkingLevel: sessionSetThinkingLevel,
}));
vi.mock("../ipc", () =>
  mockIpc({
    getTaskExecution,
    openUrl,
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

/** The display row the session's repo stream holds: its name, its task's and its sub-task's. */
function showDisplay(context: { session: object; task_name: string; subtask_name: string | null }, repo = "/repo") {
  fakeBoard.set({
    sessions: [{ ...context.session, id: "session", repo_path: repo, task_slug: "task", task_name: context.task_name, subtask_name: context.subtask_name } as never],
  });
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// The task's stream holds these unless a test says otherwise.
beforeEach(() => {
  fakeArtifacts.reset();
  fakeArtifacts.set("task", { items: initialItems, tree: initialTree });
  fakeArtifacts.prepareApproval.mockResolvedValue({
    text: "Please approve the review.",
    provenance: { type: "review_approval" as const, review_artifact: "03-review-findings.md" },
  });
});

describe("SessionView artifact pane", () => {
  beforeEach(() => {
    resetDaemon();
    vi.useFakeTimers();
    fakeBoard.set({ anyRepoTasks: [{ ...task }] });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps category tabs and shows an artifact as the stream delivers it", async () => {
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

    act(() => fakeArtifacts.set("task", { items: updatedItems }));

    expect(screen.getByText("02-review-checks.md")).toBeDefined();
    expect(screen.getByText("3/3")).toBeDefined();
  });

  it("resolves a parent-context artifact's relative image through the parent's attachment node", async () => {
    const parent = (id: string, kind: ArtifactTreeNode["kind"], label: string, children: ArtifactTreeNode[] = []): ArtifactTreeNode => ({
      id,
      kind,
      label,
      owner_task_slug: "parent",
      source: "parent_context",
      children,
    });
    fakeArtifacts.set("task", {
      tree: [
        parent("parent-context", "subtask_folder", "Parent context", [
          parent("parent-attachments", "subtask_folder", "Attachments", [parent("parent-shot", "attachment", "shot.png")]),
          parent("parent-ticket", "referenced", "00-parent-ticket.md"),
        ]),
      ],
    });
    fakeArtifacts.nodeTexts["parent-ticket"] = "![shot](attachments/shot.png)";
    renderSession({ phase: "review-checks", playbook: "review" });
    await flushPromises();

    fireEvent.click(screen.getByRole("button", { name: /00-parent-ticket\.md/ }));
    await flushPromises();

    expect(fakeArtifacts.readNode).toHaveBeenCalledWith("/repo", "task", "parent-ticket");
    expect(fakeArtifacts.readBytes).toHaveBeenCalledWith("/repo", "task", "parent-shot");
  });

  it("opens an artifact as a tab beside the pinned conversation and keeps the list in the side panel", async () => {
    fakeArtifacts.set("task", {
      tree: [{ id: "ticket", kind: "referenced", label: "07-notes.md", owner_task_slug: "parent", source: "parent_context", children: [] }],
    });
    fakeArtifacts.nodeTexts.ticket = "# Ticket";
    renderSession({ phase: "review-checks", playbook: "review" });
    await flushPromises();

    const tabs = within(screen.getByRole("group", { name: "Open files" }));
    expect(tabs.getByRole("button", { name: "Agent conversation" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /07-notes\.md/ }));
    await flushPromises();

    expect(tabs.getByRole("button", { name: "07-notes.md" }).getAttribute("aria-pressed")).toBe("true");
    expect(tabs.getByRole("button", { name: "Agent conversation" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("heading", { name: "Ticket" })).toBeDefined();
    expect(screen.getByRole("group", { name: "Artifact category" })).toBeDefined();
    // One view at a time: the conversation stays mounted, hidden, under an open file.
    const conversation = document.querySelector<HTMLElement>(".termhost");
    expect(conversation?.hidden).toBe(true);

    fireEvent.click(tabs.getByRole("button", { name: "Close 07-notes.md" }));
    expect(tabs.queryByRole("button", { name: "07-notes.md" })).toBeNull();
    expect(tabs.getByRole("button", { name: "Agent conversation" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".termhost")).toBe(conversation);
    expect(conversation?.hidden).toBe(false);
  });

  it("shows a comment another client added, with no poll", async () => {
    renderSession({ phase: "review-checks", playbook: "review" });
    await flushPromises();
    expect(screen.queryByLabelText("1 active comment")).toBeNull();

    act(() =>
      fakeArtifacts.set("task", {
        comments: [
          {
            id: "c1",
            artifact: "00-ticket.md",
            anchor_id: "a1",
            anchor_kind: "line",
            anchor_label: "Line 1",
            anchor_excerpt: "x",
            line_start: 1,
            line_end: 1,
            body: "from elsewhere",
            created_at_ms: 5,
          },
        ],
      }),
    );

    expect(screen.getByLabelText("1 active comment")).toBeDefined();
  });

  it.each(["merged", "finished", "killed"] as const)("warns that a live %s child session may be stale", async (outcome) => {
    fakeBoard.set({
      anyRepoTasks: [
        { ...task, name: "Parent", slug: "parent", requested_slug: "parent", playbook: "superdevelop" },
        { ...task, archived: true, parent_task: "parent", subtask_outcome: outcome },
      ],
    });
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
    resetDaemon();
    vi.useFakeTimers();
    fakeBoard.set({ anyRepoTasks: [{ ...task }] });
    startSession.mockClear();
    renameSession.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    fakeBoard.reset();
  });

  it.each(["omp", "no-harness"])("history_and_terminal_names_refresh_without_starting_sessions (%s)", async (harness) => {
    const context = { session: { id: "session", name: "Historical work", subtask_manager: true, subtask_slug: "child" }, task_name: "Current task", subtask_name: "Current child" };
    fakeBoard.set({
      anyRepoTasks: [
        { ...task, parent_task: "parent" },
        { ...task, slug: "parent", name: "Current parent" },
      ],
    });
    showDisplay(context);
    renderSession({ intent: "history", harness });
    await flushPromises();
    expect(screen.getByText("Historical work")).toBeDefined();
    expect(screen.getByText("Current child")).toBeDefined();
    expect(screen.getByRole("button", { name: "Current parent" })).toBeDefined();
    showDisplay({ ...context, session: { ...context.session, name: "External name" }, task_name: "Renamed task", subtask_name: "Renamed child" });
    fakeBoard.set({
      anyRepoTasks: [
        { ...task, parent_task: "parent" },
        { ...task, slug: "parent", name: "Renamed parent" },
      ],
    });
    await flushPromises();
    expect(screen.getByText("External name")).toBeDefined();
    expect(screen.getByText("Renamed task")).toBeDefined();
    expect(screen.getByText("Renamed child")).toBeDefined();
    expect(screen.getByRole("button", { name: "Renamed parent" })).toBeDefined();
    expect(startSession).not.toHaveBeenCalled();
  });

  it("rename_keys_do_not_submit_chat_or_change_session", async () => {
    showDisplay({ session: { id: "session", name: "Old name" }, task_name: "Task", subtask_name: null });
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
    showDisplay({ session: { id: "session", name: "Saved name" }, task_name: "Task", subtask_name: null });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Session name" }), { key: "Enter" });
    await flushPromises();
    expect(screen.getByText("Saved name")).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Session name" }));
    expect(renameSession).toHaveBeenCalledWith({ repoPath: "/repo", taskSlug: "task", sessionId: "session", name: "Saved name" });
    expect(onBack).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  it("shows the stream's latest name after a committed rename, and ignores a previous repo save", async () => {
    const original = { session: { id: "session", name: "Original" }, task_name: "Task", subtask_name: null };
    showDisplay(original);
    const { rerender } = renderSession({ intent: "history" });
    await flushPromises();
    renameSession.mockResolvedValue({ name: "Committed", source: "user" });
    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), { target: { value: "Committed" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Session name" }), { key: "Enter" });
    await flushPromises();
    act(() => showDisplay({ ...original, session: { ...original.session, name: "Committed" } }));
    expect(screen.getByText("Committed")).toBeDefined();
    act(() => showDisplay({ ...original, session: { ...original.session, name: "External" } }));
    expect(screen.getByText("External")).toBeDefined();
    const lateSave = deferred<{ name: string; source: string }>();
    renameSession.mockReturnValueOnce(lateSave.promise);
    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), { target: { value: "Late old repo" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Session name" }), { key: "Enter" });
    showDisplay({ ...original, session: { ...original.session, name: "Other repo" } }, "/other");
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

  it("shows a waiting ellipsis for a busy unnamed OMP session and hides it while renaming", async () => {
    showDisplay({ session: { id: "session", harness: "omp" }, task_name: "Task", subtask_name: null });
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    renderSession();
    await flushPromises();
    expect(screen.getByRole("status", { name: "Waiting for session name" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
    expect(screen.queryByRole("status", { name: "Waiting for session name" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Session name" })).toBeDefined();
  });

  it("does not animate a terminal session that will not name itself", async () => {
    showDisplay({ session: { id: "session", harness: "no-harness" }, task_name: "Task", subtask_name: null });
    sessionStatus.mockResolvedValue(liveObservation("pty"));
    renderSession({ harness: "no-harness" });
    await flushPromises();
    expect(screen.getByText("Unnamed session")).toBeDefined();
    expect(screen.queryByRole("status", { name: "Waiting for session name" })).toBeNull();
  });
});

describe("session archive pending feedback", () => {
  beforeEach(() => {
    fakeBoard.set({ anyRepoTasks: [{ ...task }] });
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
    expect(archiveSession).toHaveBeenCalledWith("/repo", "task", "session");
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
    fakeBoard.set({ anyRepoTasks: [] });
  });

  afterEach(() => {
    cleanup();
    fakeBoard.reset();
  });

  it("falls back to the task slug before the repo stream's first snapshot", () => {
    fakeBoard.set({ ready: false });
    renderSession();
    expect(screen.getByText("task")).toBeDefined();
  });

  it("replaces the slug with the task name once the task row arrives", async () => {
    renderSession();
    expect(screen.getByText("task")).toBeDefined();
    act(() => fakeBoard.set({ anyRepoTasks: [{ ...task, name: "Human Readable Task" }] }));
    expect(await screen.findByText("Human Readable Task")).toBeDefined();
  });

  it("keeps the slug when the repo has no such task", async () => {
    renderSession();
    await flushPromises();
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

describe("exited Chat activity", () => {
  beforeEach(() => {
    resetDaemon();
    fakeBoard.set({ anyRepoTasks: [task] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps a live busy turn active", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    renderSession({ intent: "attach" });
    expect(await screen.findByRole("button", { name: "Queue" })).toBeDefined();
    expect(screen.getByPlaceholderText("Send after this turn…")).toBeDefined();
  });

  it("settles a session whose process exited with its last agent state still busy", async () => {
    vi.useFakeTimers();
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy" }));
    renderSession({ intent: "attach" });
    await flushPromises();
    expect(screen.getByRole("button", { name: "Queue" })).toBeDefined();

    const live = liveObservation("rpc", { state: "busy" });
    sessionStatus.mockResolvedValue({ ...live, lifecycle: { state: "live_exited" }, state: live.state && { ...live.state, process: { state: "exited", code: null } } });
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
    expect(screen.queryByPlaceholderText("Send after this turn…")).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeDefined();
  });
});

describe("session lifecycle polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeBoard.set({ anyRepoTasks: [task] });
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

describe("session message composer feature gate", () => {
  beforeEach(() => {
    fakeBoard.set({ anyRepoTasks: [{ ...task }] });
    sessionStatus.mockResolvedValue({ lifecycle: { state: "exited", code: 0 }, state: null, checkpoint: {} });
  });

  afterEach(cleanup);

  it("shows Chat and the Chat composer for OMP", () => {
    renderSession();

    expect(screen.getByTestId("chat-pane")).toBeDefined();
    expect(screen.getByLabelText("Message or /command")).toBeDefined();
  });

  it("offers the review draft actions to Chat with no experimental flag", async () => {
    fakeArtifacts.set("task", { items: [{ name: "03-review-findings.md", modified_at_ms: 3, playbook_step: "review-findings", session_id: "", handoffs: [] }] });
    const onDraftChange = vi.fn();
    renderSession({ appearance: DEFAULT_APPEARANCE, playbook: "review", onMessageDraftChange: onDraftChange });

    expect(await screen.findByText("Send findings to task")).toBeDefined();
    fireEvent.click((await screen.findByText("Add approval prompt")).closest("button") as HTMLButtonElement);
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ body: "Please approve the review." })));
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

describe("session chat send routing", () => {
  beforeEach(() => {
    fakeBoard.set({ anyRepoTasks: [{ ...task }] });
    sessionPrompt.mockClear();
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
    vi.mocked(globalThis.fetch).mockRestore?.();
  });

  it("does not enable Send now while waiting for input or approval", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "waiting_for_input", correlation_id: "ask-1" }));
    renderSession({ messageDraft: { body: "later", pendingActions: [], attachments: [] } });
    await flushPromises();
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();

    cleanup();
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "waiting_for_approval", correlation_id: "appr-1" }));

    renderSession({ messageDraft: { body: "later", pendingActions: [], attachments: [] } });
    await flushPromises();
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  });

  const diskPng = {
    id: "img-1",
    kind: "image" as const,
    name: "shot.png",
    mimeType: "image/png",
    bytes: 12,
    sourcePath: "/tmp/shot.png",
  };
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
    expect(sessionPrompt).not.toHaveBeenCalled();
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
    expect(sessionPrompt).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalled();
    error.mockRestore();
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
    expect(sessionPrompt).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("session-scoped completion permission", () => {
  beforeEach(() => {
    fakeBoard.set({ anyRepoTasks: [task] });
    fakeArtifacts.set("task", { items: [] });
    sessionStatus.mockReset().mockResolvedValue(liveObservation("rpc"));
    getTaskExecution.mockReset().mockResolvedValue(executionReply([executionRecord({ owner_session_id: "session" })]));
    fakeExecution.allow.mockReset().mockImplementation(async (_repo: string, _slug: string, executionId: string) => {
      getTaskExecution.mockResolvedValue(
        executionReply([executionRecord({ owner_session_id: "session", permission: { kind: "human_granted", execution_id: executionId, session_id: "session" } })]),
      );
    });
  });
  afterEach(() => {
    cleanup();
    getTaskExecution.mockReset();
    fakeExecution.reset();
    vi.useRealTimers();
  });

  it("distinguishes accepted outputs from omissions and counts only this execution's wildcard publications", async () => {
    getTaskExecution.mockResolvedValue(partiallyPublishedExecution("session"));
    renderSession();
    await flushPromises();
    // The execution's details are the side panel's Info tab.
    fireEvent.click(screen.getByRole("button", { name: "Info" }));
    const execution = screen.getByLabelText("Session execution");
    expect(execution.textContent).toContain("Retained worker · finishing");
    const outputs = within(within(execution).getByRole("list", { name: "Execution outputs" }));
    expect(outputs.getByText("resolution-options.md").closest("li")?.textContent).toContain("· accepted");
    expect(outputs.getByText("selected-fix.md").closest("li")?.textContent).toContain("· not published");
    expect(outputs.getByText("papers/*.md").closest("li")?.textContent).toContain("· 2 accepted");
    expect(outputs.getByText("notes/*.md").closest("li")?.textContent).toContain("· 0 accepted");
    expect(outputs.getByText("papers/2-a-12.md")).toBeDefined();
    expect(outputs.getByText("papers/2-b-12.md")).toBeDefined();
    expect(outputs.queryByText("notes/2-other-21.md")).toBeNull();
  });
});

describe("held task sessions", () => {
  afterEach(() => {
    cleanup();
    startSession.mockReset().mockResolvedValue(undefined);
    getTaskExecution.mockReset();
    sessionStatus.mockReset().mockResolvedValue({ lifecycle: { state: "exited", code: 0 }, state: null, checkpoint: {} });
  });

  it("recovers a failed Vinculum session from its file and leaves a completed one alone", async () => {
    startSession.mockClear();
    fakeBoard.set({ anyRepoTasks: [task] });
    sessionStatus.mockResolvedValue({ lifecycle: { state: "exited", code: 0 }, state: null, checkpoint: {} });
    getTaskExecution.mockResolvedValue(
      executionReply([executionRecord({ owner_session_id: "session", lifecycle: "failed", receipt_id: null, shutdown_confirmed: true, error: "exited without completing" })]),
    );
    renderSession({ intent: undefined, harness: "vinculum" });
    const recover = await screen.findByRole("button", { name: "Recover session" });
    expect(screen.getByText("The daemon stopped before this step was accepted. The conversation is still in the session file.")).toBeDefined();
    expect(startSession).not.toHaveBeenCalled();
    startSession.mockImplementation(async () => {
      sessionStatus.mockResolvedValue(liveObservation("rpc"));
      getTaskExecution.mockResolvedValue(executionReply([executionRecord({ owner_session_id: "session", lifecycle: "running" })]));
    });
    fireEvent.click(recover);
    await waitFor(() => expect(startSession).toHaveBeenCalledWith("/repo", "task", "session"));
    expect(await screen.findByLabelText("Message or /command")).toBeDefined();

    cleanup();
    startSession.mockClear();
    sessionStatus.mockResolvedValue({ lifecycle: { state: "exited", code: 0 }, state: null, checkpoint: {} });
    getTaskExecution.mockResolvedValue(
      executionReply([executionRecord({ owner_session_id: "session", lifecycle: "completed", receipt_id: "execution-a", shutdown_confirmed: true })]),
    );
    renderSession({ intent: undefined, harness: "vinculum" });
    await screen.findByRole("button", { name: "Start fresh" });
    expect(screen.queryByRole("button", { name: "Recover session" })).toBeNull();
    expect(startSession).not.toHaveBeenCalled();
  });

  it("opens queued work without starting it and starts only on explicit request", async () => {
    startSession.mockClear();
    fakeBoard.set({ anyRepoTasks: [task] });
    sessionStatus.mockResolvedValue({ lifecycle: { state: "never_started" }, state: null, checkpoint: {} });
    getTaskExecution.mockResolvedValue(executionReply([executionRecord({ owner_session_id: "session", lifecycle: "queued", start_requested: false })]));
    renderSession({ intent: undefined });
    const start = await screen.findByRole("button", { name: "Start this queued session" });
    // The button stays disabled until the daemon's execution row has been pushed.
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    expect(startSession).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Message or /command")).toBeNull();
    startSession.mockImplementation(async () => {
      sessionStatus.mockResolvedValue({ lifecycle: { state: "live" }, state: null, checkpoint: {}, transport: "rpc" });
      getTaskExecution.mockResolvedValue(executionReply([executionRecord({ owner_session_id: "session" })]));
    });
    fireEvent.click(start);
    await waitFor(() => expect(startSession).toHaveBeenCalledWith("/repo", "task", "session"));
    expect(await screen.findByLabelText("Message or /command")).toBeDefined();
  });

  it.each(["offline", "foreign_owner", undefined] as const)("does not start a queued session from saved state when live status is %s", async (status) => {
    startSession.mockClear();
    fakeBoard.set({ anyRepoTasks: [task] });
    sessionStatus.mockResolvedValue({ lifecycle: { state: "never_started" }, state: null, checkpoint: {} });
    const saved = executionReply([executionRecord({ owner_session_id: "session", lifecycle: "queued", start_requested: false })]);
    getTaskExecution.mockResolvedValue({ ...saved, live: status ? { status, detail: "Owner cannot be queried" } : undefined });
    renderSession({ intent: undefined });

    fireEvent.click(await screen.findByRole("button", { name: "Info" }));
    expect(screen.getByLabelText("Session execution").textContent).toMatch(/Retained worker · queued.*Owner session/);
    const start = screen.getByRole("button", { name: "Start this queued session" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(start);
    expect(startSession).not.toHaveBeenCalled();
    expect(screen.getByText("research/2-result-10.md")).toBeDefined();
  });
});

describe("Vinculum session chat", () => {
  beforeEach(() => {
    fakeBoard.set({ anyRepoTasks: [task] });
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    sessionPrompt.mockClear();
    sessionAbort.mockClear();
    sessionSetModel.mockReset().mockResolvedValue({ model: "anthropic/claude", thinking: "off", thinking_levels: [] });
    sessionSetThinkingLevel.mockReset().mockResolvedValue({ model: "xai/grok-4.6", thinking: "low", thinking_levels: ["off", "low", "high"] });
    providerCatalog.mockReset().mockRejectedValue(new Error("no catalog"));
  });
  afterEach(() => {
    cleanup();
    getTaskExecution.mockReset();
    fakeExecution.reset();
  });

  it("streams the transcript into the chat pane and does not attach OMP", async () => {
    renderSession({ intent: "attach" });
    expect(await screen.findByText("Vinculum")).toBeDefined();
    expect(await screen.findByText("playbook prompt")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
  });

  it("sends and aborts through the Vinculum ops", async () => {
    const onMessageDraftChange = vi.fn();
    renderSession({ intent: "attach", messageDraft: { body: "hello", pendingActions: [], attachments: [] }, onMessageDraftChange });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));
    await waitFor(() => expect(sessionPrompt).toHaveBeenCalledWith("/repo", "session", "hello"));
  });

  it("stops a session stuck waiting for completion permission", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "waiting_for_approval", correlation_id: "completion-permission:x" }));
    renderSession({ intent: "attach" });
    fireEvent.click(await screen.findByRole("button", { name: "Abort turn" }));
    await waitFor(() => expect(sessionAbort).toHaveBeenCalledWith("/repo", "session"));
  });

  it("shows the transcript model and thinking level, and a set updates the label without an OMP write", async () => {
    const transcript = {
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "playbook prompt" }] }],
      model: "xai/grok-4.6",
      thinking: "high",
      thinking_levels: ["off", "low", "high"],
    };
    daemon.setTranscript("session", transcript);
    sessionSetThinkingLevel.mockImplementation(async () => {
      daemon.setTranscript("session", { ...transcript, thinking: "low" });
      return { model: "xai/grok-4.6", thinking: "low", thinking_levels: ["off", "low", "high"] };
    });
    sessionSetModel.mockImplementation(async () => {
      daemon.setTranscript("session", { ...transcript, model: "anthropic/claude", thinking: "off", thinking_levels: [] });
      return { model: "anthropic/claude", thinking: "off", thinking_levels: [] };
    });
    providerCatalog.mockResolvedValue({
      providers: [],
      models: [
        { provider: "anthropic", id: "claude" },
        { provider: "xai", id: "grok-4.6" },
      ],
      custom: [],
    });
    renderSession({ intent: "attach", model: "stale/model" });
    expect(await screen.findByText("playbook prompt")).toBeDefined();
    // The pickers sit in the composer footer, beside the input, not in a bar above the transcript.
    const footer = screen.getByRole("button", { name: "xai/grok-4.6" }).closest(".chat-composer-footer") as HTMLElement;
    expect(footer).not.toBeNull();
    expect(within(footer).getByText("1 event")).toBeDefined();
    expect(document.querySelector(".chat-meta")).toBeNull();
    fireEvent.click(within(footer).getByRole("button", { name: "Thinking level: high" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "low" }));
    await waitFor(() => expect(sessionSetThinkingLevel).toHaveBeenCalledWith("/repo", "session", "low"));
    expect(await screen.findByRole("button", { name: "Thinking level: low" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "xai/grok-4.6" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Providers…" }));
    expect(await screen.findByText("Current model: xai/grok-4.6")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "anthropic/claude" }));
    await waitFor(() => expect(sessionSetModel).toHaveBeenCalledWith("/repo", "session", "anthropic/claude"));
    expect(await screen.findByRole("button", { name: "anthropic/claude" })).toBeTruthy();
    // The new model names no levels, so the stored one shows but cannot change.
    expect((screen.getByRole("button", { name: "Thinking level: off" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens a worktree file or an artifact the agent names in a reply as a tab", async () => {
    daemon.setTranscript("session", [
      { id: "a1", role: "assistant", content: [{ type: "text", text: "Changed `/worktrees/task/src/app.ts:12`, see `artifacts/00-ticket.md`; `os.path` is not a file." }] },
    ]);
    fakeArtifacts.worktreeTexts["src/app.ts"] = "export const app = 1;";
    fakeArtifacts.texts["00-ticket.md"] = "# The ticket";
    renderSession({ intent: "attach" });
    const tabs = within(screen.getByRole("group", { name: "Open files" }));

    fireEvent.click(await screen.findByRole("button", { name: "/worktrees/task/src/app.ts:12" }));
    await waitFor(() => expect(tabs.getByRole("button", { name: "app.ts" }).getAttribute("aria-pressed")).toBe("true"));
    expect(fakeArtifacts.readWorktree).toHaveBeenCalledWith("/repo", "task", "src/app.ts");
    await waitFor(() => expect(document.querySelector(".artifactviewer")?.textContent).toContain("export const app = 1;"));
    // A code file has no Preview/Raw toggle.
    expect(screen.queryByRole("button", { name: "Raw" })).toBeNull();

    fireEvent.click(tabs.getByRole("button", { name: "Agent conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "artifacts/00-ticket.md" }));
    expect(await screen.findByRole("heading", { name: "The ticket" })).toBeDefined();
    // Each single click opened a temporary tab, so the ticket replaced the code file.
    expect(tabs.queryByRole("button", { name: "app.ts" })).toBeNull();
    expect(screen.queryByRole("button", { name: "os.path" })).toBeNull();
  });

  it("shows Finish step for a locked Vinculum execution and grants it without an OMP reply", async () => {
    getTaskExecution.mockResolvedValue(executionReply([executionRecord({ owner_session_id: "session", permission: { kind: "locked" } })]));
    fakeExecution.allow.mockImplementation(async () => {
      getTaskExecution.mockResolvedValue(
        executionReply([executionRecord({ owner_session_id: "session", permission: { kind: "human_granted", execution_id: "execution-a", session_id: "session" } })]),
      );
    });
    renderSession({ intent: "attach", harness: "vinculum" });
    fireEvent.click(await screen.findByRole("button", { name: "Finish step" }));
    await waitFor(() => expect(fakeExecution.allow).toHaveBeenCalledExactlyOnceWith("/repo", "task", "execution-a", undefined));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Finish step" })).toBeNull());
    expect(screen.getByLabelText("Message or /command")).toBeDefined();
  });
});
